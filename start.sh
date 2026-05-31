#!/bin/bash
# Onemonetry startup script — run this when opening the Codespace

set -euo pipefail

echo "=== Onemonetry startup ==="

is_configured_secret() {
  local value="${1:-}"
  local lower
  lower="$(printf "%s" "$value" | tr '[:upper:]' '[:lower:]')"

  if [ -z "$lower" ]; then
    return 1
  fi

  if [[ "$lower" == replace_* \
    || "$lower" == *replace_with* \
    || "$lower" == *your_openai* \
    || "$lower" == *your_api_key* \
    || "$lower" == *your-key-here* \
    || "$lower" == *placeholder* \
    || "$lower" == sk-your-* \
    || "$lower" == *example* \
    || "$lower" == changeme \
    || "$lower" == change_me ]]; then
    return 1
  fi

  return 0
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Load local environment variables for this shell session (if present)
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

# Load local secrets for development if present. Do not commit .env.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

REQUIRE_OPENAI="${REQUIRE_OPENAI:-false}"
if [ "${REQUIRE_OPENAI,,}" = "true" ] && ! is_configured_secret "${OPENAI_API_KEY:-}"; then
  echo "❌ REQUIRE_OPENAI=true but OPENAI_API_KEY is not configured."
  echo "   Add a real OPENAI_API_KEY to .env, then rerun: REQUIRE_OPENAI=true ./start.sh"
  exit 1
fi

# Install dependencies if needed
echo "Checking dependencies..."
if [ ! -d "$REPO_ROOT/mock-backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  (cd "$REPO_ROOT/mock-backend" && npm install --no-audit --no-fund) || {
    echo "❌ Failed to install backend dependencies"
    exit 1
  }
else
  echo "Backend dependencies already present"
fi

if [ ! -d "$REPO_ROOT/frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd "$REPO_ROOT/frontend" && npm install --no-audit --no-fund) || {
    echo "❌ Failed to install frontend dependencies"
    exit 1
  }
else
  echo "Frontend dependencies already present"
fi

# Kill any existing processes on our ports
for port in 8000 5173 5174; do
  pid=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "Stopping existing process on port $port (PID $pid)"
    kill -9 $pid 2>/dev/null || true
    sleep 1
  fi
done

# Start backend
echo "Starting backend on port 8000..."
cd "$REPO_ROOT"
IGNORE_RUNTIME_SIGTERM="${IGNORE_RUNTIME_SIGTERM:-true}"
LIGHTWEIGHT_RUNTIME="${LIGHTWEIGHT_RUNTIME:-true}"
NODE_MAX_OLD_SPACE_MB="${NODE_MAX_OLD_SPACE_MB:-1024}"
EMAIL_LLM_FAIL_CLOSED="${EMAIL_LLM_FAIL_CLOSED:-false}"
nohup env LIGHTWEIGHT_RUNTIME="${LIGHTWEIGHT_RUNTIME}" IGNORE_RUNTIME_SIGTERM="${IGNORE_RUNTIME_SIGTERM}" EMAIL_LLM_FAIL_CLOSED="${EMAIL_LLM_FAIL_CLOSED}" NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}" node mock-backend/server.js > /tmp/onemonetry-backend.log 2>&1 &
BACKEND_PID=$!

# Wait for backend
sleep 3
if kill -0 $BACKEND_PID 2>/dev/null; then
  echo "✅ Backend running (PID $BACKEND_PID)"
else
  echo "❌ Backend failed to start"
  tail -n 60 /tmp/onemonetry-backend.log || true
  exit 1
fi

# Start frontend
echo "Starting frontend on port 5173..."
cd "$REPO_ROOT/frontend"
nohup npm run dev > /tmp/onemonetry-frontend.log 2>&1 &
FRONTEND_PID=$!

sleep 3
echo "✅ Frontend running (PID $FRONTEND_PID)"
echo ""
echo "=== Ready ==="
echo "Frontend: http://localhost:5173"
echo "Backend:  http://localhost:8000"
echo "Backend logs: /tmp/onemonetry-backend.log"
echo "Frontend logs: /tmp/onemonetry-frontend.log"
echo ""
echo "Environment:"
if is_configured_secret "${COMPANIES_HOUSE_API_KEY:-}"; then
  echo "  ✅ Companies House API: configured"
else
  echo "  ⚠️  Companies House API: not set"
fi

if is_configured_secret "${OPENAI_API_KEY:-}"; then
  echo "  ✅ OpenAI API: configured"
else
  echo "  ⚠️  OpenAI API: not set"
fi

echo ""
echo "Startup complete. Services are running in the background."
