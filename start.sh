#!/bin/bash
# Onemonetry startup script — run this when opening the Codespace

echo "=== Onemonetry startup ==="

cd /workspace

# Load local secrets for development if present. Do not commit .env.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Install dependencies if needed
echo "Checking dependencies..."
cd mock-backend && npm install --silent 2>/dev/null
cd ../frontend && npm install --silent 2>/dev/null
cd ..

# Kill any existing processes on our ports
for port in 8000 5173; do
  pid=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "Stopping existing process on port $port (PID $pid)"
    kill $pid 2>/dev/null
    sleep 1
  fi
done

# Start backend
echo "Starting backend on port 8000..."
cd /workspace
node mock-backend/server.js &
BACKEND_PID=$!

# Wait for backend
sleep 2
if kill -0 $BACKEND_PID 2>/dev/null; then
  echo "✅ Backend running (PID $BACKEND_PID)"
else
  echo "❌ Backend failed to start"
  exit 1
fi

# Start frontend
echo "Starting frontend on port 5173..."
cd /workspace/frontend
npm run dev &
FRONTEND_PID=$!

sleep 3
echo "✅ Frontend running (PID $FRONTEND_PID)"
echo ""
echo "=== Ready ==="
echo "Frontend: http://localhost:5173"
echo "Backend:  http://localhost:8000"
echo ""
echo "Environment:"
[ -n "$COMPANIES_HOUSE_API_KEY" ] && echo "  ✅ Companies House API: configured" || echo "  ⚠️  Companies House API: not set"
[ -n "$OPENAI_API_KEY" ] && echo "  ✅ OpenAI API: configured" || echo "  ⚠️  OpenAI API: not set"

wait
