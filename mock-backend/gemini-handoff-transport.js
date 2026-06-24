function parseBoolEnv(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntEnv(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function resolveConfiguredSecret(value) {
  const key = String(value || "").trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  const looksPlaceholder = lower.startsWith("replace_")
    || lower.startsWith("replace-")
    || lower.startsWith("replace")
    || lower.includes("replace_with")
    || lower.includes("replacewith")
    || lower.includes("your_api_key")
    || lower.includes("optional_")
    || lower.includes("example")
    || lower === "changeme"
    || lower === "change_me";
  return looksPlaceholder ? null : key;
}

function toTransportUrl(rawValue) {
  const url = String(rawValue || "").trim();
  return url || null;
}

const GEMINI_HANDOFF_TRANSPORT_ENABLED = parseBoolEnv(process.env.ENABLE_GEMINI_HANDOFF_TRANSPORT, false);
const GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN = parseBoolEnv(process.env.GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN, true);
const GEMINI_HANDOFF_TRANSPORT_URL = toTransportUrl(process.env.GEMINI_HANDOFF_TRANSPORT_URL);
const GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS = parseIntEnv(
  process.env.GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS,
  15000,
  1000,
  90000
);
const GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN = resolveConfiguredSecret(process.env.GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN);
const GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER = String(
  process.env.GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER || "Authorization"
).trim() || "Authorization";

export function getGeminiHandoffTransportRuntimeInfo() {
  return {
    enabled: GEMINI_HANDOFF_TRANSPORT_ENABLED,
    configured: GEMINI_HANDOFF_TRANSPORT_ENABLED && !!GEMINI_HANDOFF_TRANSPORT_URL,
    fail_open: GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN,
    url_configured: !!GEMINI_HANDOFF_TRANSPORT_URL,
    auth_configured: !!GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN,
    auth_header: GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN ? GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER : null,
    timeout_ms: GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS,
  };
}

export async function dispatchGeminiHandoffRequest(payload = {}) {
  if (!GEMINI_HANDOFF_TRANSPORT_ENABLED) {
    return {
      attempted: false,
      success: false,
      skipped: true,
      reason: "transport_disabled",
    };
  }

  if (!GEMINI_HANDOFF_TRANSPORT_URL) {
    return {
      attempted: false,
      success: false,
      skipped: true,
      reason: "transport_url_missing",
      error_code: "transport_url_missing",
      error_message: "GEMINI_HANDOFF_TRANSPORT_URL is required when transport is enabled",
    };
  }

  const headers = {
    "Content-Type": "application/json",
  };

  if (GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN) {
    const authValue = GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER.toLowerCase() === "authorization"
      ? `Bearer ${GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN}`
      : GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN;
    headers[GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER] = authValue;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_HANDOFF_TRANSPORT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let parsed = null;
    if (bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      return {
        attempted: true,
        success: false,
        skipped: false,
        status_code: response.status,
        error_code: "transport_http_error",
        error_message: `Transport endpoint returned HTTP ${response.status}`,
        response_payload: parsed,
      };
    }

    return {
      attempted: true,
      success: true,
      skipped: false,
      status_code: response.status,
      response_payload: parsed,
    };
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    return {
      attempted: true,
      success: false,
      skipped: false,
      status_code: null,
      error_code: isAbort ? "transport_timeout" : "transport_network_error",
      error_message: isAbort
        ? `Transport request timed out after ${GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS}ms`
        : String(error?.message || "Gemini transport request failed"),
    };
  } finally {
    clearTimeout(timer);
  }
}
