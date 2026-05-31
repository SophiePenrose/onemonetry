#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API="${API:-http://localhost:8000}"
COOKIE="${COOKIE:-/tmp/onemonetry.cookies}"
PASSWORD="${PASSWORD:-TempPass123!}"
COMPANY_ID="${1:-}"
CURL_TIMEOUT="${CURL_TIMEOUT:-180}"
SKIP_LOGIN="${SKIP_LOGIN:-0}"
LOGIN_OK=0
AUTH_ARGS=()

printf "[level5-smoke] API=%s\n" "$API"
printf "[level5-smoke] timeout=%ss\n" "$CURL_TIMEOUT"
printf "[level5-smoke] skip_login=%s\n" "$SKIP_LOGIN"

STATUS_JSON="$(curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" "$API/api/auth/status")"
printf "[level5-smoke] auth status: %s\n" "$STATUS_JSON"

if echo "$STATUS_JSON" | grep -q '"needs_setup":true'; then
  printf "[level5-smoke] auth setup required, configuring...\n"
  curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" -X POST "$API/api/auth/setup" \
    -H "Content-Type: application/json" \
    --data "$(printf '{"password":"%s"}' "$PASSWORD")" >/tmp/level5-auth-setup.json
  cat /tmp/level5-auth-setup.json
  echo
fi

if [[ "$SKIP_LOGIN" == "1" ]]; then
  printf "[level5-smoke] login skipped by SKIP_LOGIN=1\n"
else
  if curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" -X POST "$API/api/auth/login" \
    -c "$COOKIE" \
    -b "$COOKIE" \
    -H "Content-Type: application/json" \
    --data "$(printf '{"password":"%s"}' "$PASSWORD")" >/tmp/level5-auth-login.json; then
    if node - <<'NODE'
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('/tmp/level5-auth-login.json', 'utf8'));
if (!raw.success) {
  process.exit(1);
}
NODE
    then
      printf "[level5-smoke] login ok\n"
      LOGIN_OK=1
      AUTH_ARGS=(-b "$COOKIE")
    else
      printf "[level5-smoke] WARN: login failed; continuing without cookie (dev-open mode may allow this).\n"
      cat /tmp/level5-auth-login.json
      echo
    fi
  else
    printf "[level5-smoke] WARN: login request failed; continuing without cookie.\n"
  fi
fi

if [[ -z "$COMPANY_ID" ]]; then
  COMPANY_ID="$(curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" "$API/api/unified-shortlist?page=1&limit=1" "${AUTH_ARGS[@]}" | grep -o '"id":"ch-[^"]*"' | head -n1 | cut -d'"' -f4)"
fi

if [[ -z "$COMPANY_ID" ]]; then
  printf "[level5-smoke] ERROR: could not derive company id from shortlist\n" >&2
  exit 1
fi

printf "[level5-smoke] company_id=%s\n" "$COMPANY_ID"
printf "[level5-smoke] running extract...\n"

curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" -X POST "$API/api/llm/extract" \
  "${AUTH_ARGS[@]}" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"company_id":"%s"}' "$COMPANY_ID")" >/tmp/level5-extract.json

node - <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('/tmp/level5-extract.json', 'utf8');
let raw;
try {
  raw = JSON.parse(text);
} catch (err) {
  console.error('[level5-smoke] ERROR: extract response is not valid JSON');
  console.error(text.slice(0, 500));
  process.exit(1);
}
const evidence = raw.evidence || {};
const l5 = evidence.level5_extraction || {};
const summary = {
  company_id: raw.company_id || null,
  error: raw.error || null,
  source: evidence.source || null,
  has_level5: !!evidence.level5_extraction,
  pain_register_count: (l5.pain_register || []).length,
  use_case_count: (l5.revolut_opportunity?.recommended_use_cases || []).length,
  sequence_input_keys: Object.keys(l5.sequence_inputs || {}),
};
console.log('[level5-smoke] extract summary:');
console.log(JSON.stringify(summary, null, 2));
if (raw.error && /auth|login|required/i.test(String(raw.error))) {
  console.error('[level5-smoke] ERROR: API requires auth and login was not successful.');
  process.exit(1);
}
NODE

printf "[level5-smoke] running generate...\n"

rm -f /tmp/level5-sequence-id.txt

curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" -X POST "$API/api/email/generate" \
  "${AUTH_ARGS[@]}" \
  -H "Content-Type: application/json" \
  --data "$(printf '{"company_id":"%s","stakeholder_name":"Jane Doe","stakeholder_role":"CFO"}' "$COMPANY_ID")" >/tmp/level5-generate.json

node - <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('/tmp/level5-generate.json', 'utf8');
let raw;
try {
  raw = JSON.parse(text);
} catch (err) {
  console.error('[level5-smoke] ERROR: generate response is not valid JSON');
  console.error(text.slice(0, 500));
  process.exit(1);
}
const summary = {
  sequence_id: raw.sequence_id || null,
  error: raw.error || null,
  source: raw.source || null,
  motion: raw.motion || null,
  step_count: (raw.steps || []).length,
  subjects: (raw.steps || []).map((s) => s.subject),
};
console.log('[level5-smoke] generate summary:');
console.log(JSON.stringify(summary, null, 2));
if (raw.error && /auth|login|required/i.test(String(raw.error))) {
  console.error('[level5-smoke] ERROR: API requires auth and login was not successful.');
  process.exit(1);
}

const unresolvedToken = /\[(?:rounded\s*figure|your\s*name|your\s*title|ae_name|ae_title)\]/i;
const steps = Array.isArray(raw.steps) ? raw.steps : [];
const unresolved = steps.find((step) => unresolvedToken.test(`${step.subject || ''}\n${step.body || ''}`));
if (unresolved) {
  console.error(`[level5-smoke] ERROR: unresolved placeholder detected in step ${unresolved.step_number || '?'}`);
  process.exit(1);
}

const signaturePattern = /(?:\n|^)(?:Best|Thanks|Kind regards|Regards|Sincerely|Cheers)[,!\.\s-]*\n|Account Executive\s*\|\s*Revolut Business|revolut\.com\/business/i;
const withSignature = steps.find((step) => signaturePattern.test(String(step.body || '')));
if (withSignature) {
  console.error(`[level5-smoke] ERROR: signature block detected in step ${withSignature.step_number || '?'}`);
  process.exit(1);
}

if (raw.sequence_id) {
  fs.writeFileSync('/tmp/level5-sequence-id.txt', String(raw.sequence_id));
}
NODE

printf "[level5-smoke] fetching saved sequences...\n"

SEQUENCE_ID="$(cat /tmp/level5-sequence-id.txt 2>/dev/null || true)"

curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" "$API/api/email/sequences/$COMPANY_ID" "${AUTH_ARGS[@]}" >/tmp/level5-sequences.json
if [[ -n "$SEQUENCE_ID" ]]; then
  curl -sS --connect-timeout 10 --max-time "$CURL_TIMEOUT" "$API/api/email/sequence/$SEQUENCE_ID" "${AUTH_ARGS[@]}" >/tmp/level5-sequence-latest.json
fi
printf "[level5-smoke] saved outputs:\n"
printf "  /tmp/level5-auth-login.json\n"
printf "  /tmp/level5-extract.json\n"
printf "  /tmp/level5-generate.json\n"
printf "  /tmp/level5-sequences.json\n"
if [[ -n "$SEQUENCE_ID" ]]; then
  printf "  /tmp/level5-sequence-latest.json\n"
fi
