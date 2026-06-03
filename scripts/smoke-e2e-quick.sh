#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_BASE="${BACKEND_BASE:-http://localhost:8000}"
FRONTEND_BASE="${FRONTEND_BASE:-http://localhost:5173}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-$BACKEND_BASE/api/dashboard}"
FRONTEND_HEALTH_URL="${FRONTEND_HEALTH_URL:-$FRONTEND_BASE/}"
BACKEND_LOG="${BACKEND_LOG:-/tmp/onemonetry-backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-/tmp/onemonetry-frontend.log}"

BACKEND_PID=""
FRONTEND_PID=""
STARTED_BACKEND=0
STARTED_FRONTEND=0

if ! command -v setsid >/dev/null 2>&1; then
  echo "[smoke-e2e] ERROR: setsid is required but not available on PATH"
  exit 1
fi

wait_for_url() {
  local name="$1"
  local url="$2"

  if curl -fsS --retry 30 --retry-delay 1 --retry-connrefused --max-time 4 "$url" >/dev/null; then
    echo "[smoke-e2e] $name ready: $url"
    return 0
  fi

  echo "[smoke-e2e] ERROR: $name did not become ready at $url"
  return 1
}

cleanup() {
  local exit_code=$?

  if [[ "$STARTED_FRONTEND" -eq 1 && -n "$FRONTEND_PID" ]]; then
    kill -- "-$FRONTEND_PID" >/dev/null 2>&1 || true
    wait "$FRONTEND_PID" >/dev/null 2>&1 || true
    echo "[smoke-e2e] stopped frontend process group (pgid=$FRONTEND_PID)"
  fi

  if [[ "$STARTED_BACKEND" -eq 1 && -n "$BACKEND_PID" ]]; then
    kill -- "-$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
    echo "[smoke-e2e] stopped backend process group (pgid=$BACKEND_PID)"
  fi

  if [[ "$exit_code" -ne 0 ]]; then
    echo "[smoke-e2e] failed with exit code $exit_code"
    echo "[smoke-e2e] backend log:  $BACKEND_LOG"
    echo "[smoke-e2e] frontend log: $FRONTEND_LOG"
  fi

  exit "$exit_code"
}

trap cleanup EXIT

echo "[smoke-e2e] root=$ROOT_DIR"
echo "[smoke-e2e] backend=$BACKEND_BASE"
echo "[smoke-e2e] frontend=$FRONTEND_BASE"

if curl -fsS --max-time 4 "$BACKEND_HEALTH_URL" >/dev/null; then
  echo "[smoke-e2e] backend already running"
else
  echo "[smoke-e2e] starting backend in lightweight mode"
  setsid env LIGHTWEIGHT_RUNTIME="${LIGHTWEIGHT_RUNTIME:-true}" npm --prefix "$ROOT_DIR/mock-backend" start >"$BACKEND_LOG" 2>&1 &
  BACKEND_PID="$!"
  STARTED_BACKEND=1
  wait_for_url "backend" "$BACKEND_HEALTH_URL"
fi

if curl -fsS --max-time 4 "$FRONTEND_HEALTH_URL" >/dev/null; then
  echo "[smoke-e2e] frontend already running"
else
  echo "[smoke-e2e] starting frontend dev server"
  setsid npm --prefix "$ROOT_DIR/frontend" run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" >"$FRONTEND_LOG" 2>&1 &
  FRONTEND_PID="$!"
  STARTED_FRONTEND=1
  wait_for_url "frontend" "$FRONTEND_HEALTH_URL"
fi

echo "[smoke-e2e] running API smoke checks"
BACKEND_BASE="$BACKEND_BASE" FRONTEND_BASE="$FRONTEND_BASE" bash "$ROOT_DIR/scripts/smoke-api.sh"
echo "[smoke-e2e] completed successfully"
