#!/usr/bin/env bash
set -euo pipefail

BACKEND_BASE="${BACKEND_BASE:-http://localhost:8000}"
FRONTEND_BASE="${FRONTEND_BASE:-http://localhost:5173}"
CURL_TIMEOUT="${CURL_TIMEOUT:-6}"

pass_count=0
fail_count=0

check_endpoint() {
  local name="$1"
  local url="$2"

  if curl -fsS --max-time "$CURL_TIMEOUT" "$url" >/dev/null; then
    echo "PASS  $name -> $url"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL  $name -> $url"
    fail_count=$((fail_count + 1))
  fi
}

echo "Running API smoke checks..."

# Backend direct
check_endpoint "backend dashboard" "$BACKEND_BASE/api/dashboard"
check_endpoint "backend import jobs" "$BACKEND_BASE/api/import/jobs"
check_endpoint "backend backfill status" "$BACKEND_BASE/api/import/bulk/process-remaining/status"

# Frontend proxy through Vite
check_endpoint "proxy dashboard" "$FRONTEND_BASE/api/dashboard"
check_endpoint "proxy import jobs" "$FRONTEND_BASE/api/import/jobs"
check_endpoint "proxy backfill status" "$FRONTEND_BASE/api/import/bulk/process-remaining/status"

echo ""
echo "Summary: $pass_count passed, $fail_count failed"

if [[ $fail_count -gt 0 ]]; then
  echo "Result: API smoke test FAILED"
  exit 1
fi

echo "Result: API smoke test PASSED"
