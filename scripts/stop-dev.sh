#!/bin/bash

set -euo pipefail

BACKEND_PORT="${PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"
ALT_FRONTEND_PORT="${ALT_FRONTEND_PORT:-5173}"
BACKEND_PID_FILE="/tmp/onemonetry-backend.pid"
FRONTEND_PID_FILE="/tmp/onemonetry-frontend.pid"

stopped_any=0

stop_pid() {
  local pid="$1"
  local label="$2"

  if ! kill -0 "$pid" 2>/dev/null; then
    return
  fi

  echo "Stopping ${label} (PID ${pid})"
  kill "$pid" 2>/dev/null || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return
    fi
    sleep 0.2
  done

  echo "Force stopping ${label} (PID ${pid})"
  kill -9 "$pid" 2>/dev/null || true
}

stop_pid_file() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    stop_pid "$pid" "$label"
    stopped_any=1
  fi
}

stop_port() {
  local port="$1"
  local label="$2"

  local pids
  pids="$(lsof -ti :"$port" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return
  fi

  for pid in $pids; do
    stop_pid "$pid" "$label on port $port"
    stopped_any=1
  done
}

stop_pid_file "$BACKEND_PID_FILE" "backend"
stop_pid_file "$FRONTEND_PID_FILE" "frontend"

stop_port "$BACKEND_PORT" "backend"
stop_port "$FRONTEND_PORT" "frontend"
stop_port "$ALT_FRONTEND_PORT" "frontend"

rm -f "$BACKEND_PID_FILE" "$FRONTEND_PID_FILE"

if [ "$stopped_any" -eq 0 ]; then
  echo "No Onemonetry dev processes found on ports $BACKEND_PORT/$FRONTEND_PORT/$ALT_FRONTEND_PORT."
else
  echo "Onemonetry dev services stopped."
fi
