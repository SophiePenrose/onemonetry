import { buildManualWeConnectExport } from "./we-connect-manual.js";

const DEFAULT_BASE_URL = "https://api-us-1.we-connect.io";

function splitName(contact = {}) {
  const explicitFirst = String(contact.first_name || "").trim();
  const explicitMiddle = String(contact.middle_name || "").trim();
  const explicitLast = String(contact.last_name || "").trim();
  if (explicitFirst || explicitMiddle || explicitLast) {
    return { first_name: explicitFirst, middle_name: explicitMiddle, last_name: explicitLast };
  }
  const parts = String(contact.full_name || contact.name || "").trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts.shift() || "",
    middle_name: parts.length > 1 ? parts.slice(0, -1).join(" ") : "",
    last_name: parts.pop() || "",
  };
}

export function buildWeConnectApiImport(input = {}) {
  const prepared = buildManualWeConnectExport(input);
  return {
    ...prepared,
    format: "we_connect_api_import",
    contacts: prepared.included.map((contact) => ({
      ...splitName(contact),
      linkedin: contact.linkedin_url,
      email: String(contact.email || "").trim(),
      custom_fields: contact.custom_fields && typeof contact.custom_fields === "object" ? contact.custom_fields : {},
    })),
    summary: {
      ...prepared.summary,
      ready_to_import: prepared.included.length,
    },
  };
}

export function createWeConnectApiClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = String(env.WE_CONNECT_API_KEY || "").trim();
  const baseUrl = String(env.WE_CONNECT_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  const parsedTimeout = Number.parseInt(env.WE_CONNECT_API_TIMEOUT_MS || "15000", 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 15000;

  return {
    configured: Boolean(apiKey),
    async importContacts({ campaignName, contacts }) {
      if (!apiKey) {
        const error = new Error("Add WE_CONNECT_API_KEY to the backend environment before importing contacts.");
        error.code = "we_connect_not_configured";
        throw error;
      }
      const name = String(campaignName || "").trim();
      if (!name) {
        const error = new Error("A We-Connect campaign name is required.");
        error.code = "we_connect_campaign_required";
        throw error;
      }
      if (!Array.isArray(contacts) || contacts.length === 0) {
        const error = new Error("There are no new approved LinkedIn contacts to import.");
        error.code = "we_connect_contacts_required";
        throw error;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/campaign/contacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ api_key: apiKey, name, contacts }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.error) {
          const error = new Error(String(payload?.error || `We-Connect returned HTTP ${response.status}`));
          error.code = response.status === 429 ? "we_connect_rate_limited" : "we_connect_import_failed";
          error.status = response.status;
          throw error;
        }
        return { success: true, status_code: response.status, response: payload };
      } catch (error) {
        if (error?.name === "AbortError") {
          const timeoutError = new Error("We-Connect did not respond before the request timed out.");
          timeoutError.code = "we_connect_timeout";
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export const weConnectApiClient = createWeConnectApiClient();
