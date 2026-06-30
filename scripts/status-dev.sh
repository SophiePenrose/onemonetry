#!/bin/bash

set -euo pipefail

BACKEND_PORT="${PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"
ALT_FRONTEND_PORT="${ALT_FRONTEND_PORT:-5173}"
BACKEND_PID_FILE="/tmp/onemonetry-backend.pid"
FRONTEND_PID_FILE="/tmp/onemonetry-frontend.pid"

print_pid_file_status() {
  local pid_file="$1"
  local label="$2"

  if [ ! -f "$pid_file" ]; then
    echo "${label} pid file: missing"
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "${label} pid file: invalid"
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "${label} pid file: running (PID ${pid})"
  else
    echo "${label} pid file: stale (PID ${pid})"
  fi
}

print_port_status() {
  local port="$1"
  local label="$2"

  local pids
  pids="$(lsof -ti :"$port" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "${label} port ${port}: down"
    return
  fi

  local pid_list
  pid_list="$(echo "$pids" | tr '\n' ' ' | xargs)"
  echo "${label} port ${port}: up (PID ${pid_list})"
  ps -o pid=,comm= -p $pid_list 2>/dev/null | sed 's/^/  /' || true
}

check_http() {
  local url="$1"
  local label="$2"

  if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
    echo "${label}: reachable (${url})"
  else
    echo "${label}: unreachable (${url})"
  fi
}

echo "=== Onemonetry Dev Status ==="
print_pid_file_status "$BACKEND_PID_FILE" "backend"
print_pid_file_status "$FRONTEND_PID_FILE" "frontend"

echo
print_port_status "$BACKEND_PORT" "backend"
print_port_status "$FRONTEND_PORT" "frontend"
print_port_status "$ALT_FRONTEND_PORT" "frontend"

echo
check_http "http://127.0.0.1:${BACKEND_PORT}/api/auth/status" "backend api"
check_http "http://127.0.0.1:${FRONTEND_PORT}" "frontend"
if [ "$FRONTEND_PORT" != "$ALT_FRONTEND_PORT" ]; then
  check_http "http://127.0.0.1:${ALT_FRONTEND_PORT}" "frontend alt"
fi

echo
if curl -fsS --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/api/auth/status" >/dev/null 2>&1; then
  echo "Next actions: run npm run logs (or npm run logs:backend / npm run logs:frontend)"
else
  echo "Next actions: run npm run start:dev"
fi
