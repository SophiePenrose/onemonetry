import { getSetting, setSetting } from "./db.js";

const DEFAULT_TIMEOUT_MS = Math.max(
  1500,
  Number.parseInt(process.env.EXTERNAL_SIGNAL_TIMEOUT_MS || "7000", 10) || 7000
);

const CONNECTOR_DEFINITIONS = [
  {
    id: "endole",
    keyEnvs: ["ENDOLE_API_KEY"],
    urlTemplateEnv: "ENDOLE_URL_TEMPLATE",
    authHeaderEnv: "ENDOLE_AUTH_HEADER",
    authSchemeEnv: "ENDOLE_AUTH_SCHEME",
    purpose: "ownership_and_corporate_intelligence",
  },
  {
    id: "opencorporates",
    keyEnvs: ["OPENCORPORATES_API_TOKEN"],
    keysOptional: true,
    urlTemplateEnv: "OPENCORPORATES_URL_TEMPLATE",
    authHeaderEnv: "OPENCORPORATES_AUTH_HEADER",
    authSchemeEnv: "OPENCORPORATES_AUTH_SCHEME",
    purpose: "cross_jurisdiction_registry",
  },
  {
    id: "prospeo",
    keyEnvs: ["PROSPEO_API_KEY"],
    keysOptional: true,
    urlTemplateEnv: "PROSPEO_URL_TEMPLATE",
    authHeaderEnv: "PROSPEO_AUTH_HEADER",
    authSchemeEnv: "PROSPEO_AUTH_SCHEME",
    purpose: "contact_and_company_intelligence",
  },
  {
    id: "phantombuster",
    keyEnvs: ["PHANTOMBUSTER_API_KEY"],
    keysOptional: true,
    urlTemplateEnv: "PHANTOMBUSTER_URL_TEMPLATE",
    authHeaderEnv: "PHANTOMBUSTER_AUTH_HEADER",
    authSchemeEnv: "PHANTOMBUSTER_AUTH_SCHEME",
    purpose: "workflow_automation_enrichment_exports",
  },
  {
    id: "similarweb",
    keyEnvs: ["SIMILARWEB_API_KEY"],
    urlTemplateEnv: "SIMILARWEB_URL_TEMPLATE",
    authHeaderEnv: "SIMILARWEB_AUTH_HEADER",
    authSchemeEnv: "SIMILARWEB_AUTH_SCHEME",
    purpose: "traffic_growth",
  },
  {
    id: "builtwith",
    keyEnvs: ["BUILTWITH_API_KEY"],
    urlTemplateEnv: "BUILTWITH_URL_TEMPLATE",
    authHeaderEnv: "BUILTWITH_AUTH_HEADER",
    authSchemeEnv: "BUILTWITH_AUTH_SCHEME",
    purpose: "external_tech_stack",
  },
  {
    id: "adzuna",
    keyEnvs: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
    urlTemplateEnv: "ADZUNA_URL_TEMPLATE",
    authHeaderEnv: "ADZUNA_AUTH_HEADER",
    authSchemeEnv: "ADZUNA_AUTH_SCHEME",
    purpose: "hiring_velocity",
  },
  {
    id: "crunchbase",
    keyEnvs: ["CRUNCHBASE_API_KEY"],
    urlTemplateEnv: "CRUNCHBASE_URL_TEMPLATE",
    authHeaderEnv: "CRUNCHBASE_AUTH_HEADER",
    authSchemeEnv: "CRUNCHBASE_AUTH_SCHEME",
    purpose: "funding_and_investor_events",
  },
  {
    id: "clearbit",
    keyEnvs: ["CLEARBIT_API_KEY"],
    urlTemplateEnv: "CLEARBIT_URL_TEMPLATE",
    authHeaderEnv: "CLEARBIT_AUTH_HEADER",
    authSchemeEnv: "CLEARBIT_AUTH_SCHEME",
    purpose: "firmographic_domain_enrichment",
  },
  {
    id: "statuspage",
    keyEnvs: [],
    urlTemplateEnv: "STATUSPAGE_URL_TEMPLATE",
    discoveryType: "statuspage",
    purpose: "free_public_incident_and_uptime_signals",
  },
  {
    id: "status_feed",
    keyEnvs: [],
    urlTemplateEnv: "STATUS_FEED_URL_TEMPLATE",
    discoveryType: "status_feed",
    acceptHeader: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8",
    purpose: "free_public_status_rss_atom_signals",
  },
  {
    id: "status_api",
    keyEnvs: [],
    urlTemplateEnv: "STATUS_API_URL_TEMPLATE",
    discoveryType: "status_api",
    purpose: "free_public_status_json_signals",
  },
  {
    id: "status_instatus",
    keyEnvs: [],
    urlTemplateEnv: "STATUS_INSTATUS_URL_TEMPLATE",
    discoveryType: "status_instatus",
    purpose: "free_public_instatus_summary_signals",
  },
  {
    id: "status_cachet",
    keyEnvs: [],
    urlTemplateEnv: "STATUS_CACHET_URL_TEMPLATE",
    discoveryType: "status_cachet",
    purpose: "free_public_cachet_incident_signals",
  },
];

function hasConfiguredSecret(value) {
  const key = String(value || "").trim();
  if (!key) return false;
  const lower = key.toLowerCase();
  const looksPlaceholder = lower.startsWith("replace")
    || lower.includes("replace_with")
    || lower.includes("your_api_key")
    || lower.includes("optional")
    || lower.includes("example")
    || lower === "changeme"
    || lower === "change_me";
  return !looksPlaceholder;
}

function parseBooleanFlag(value, fallback = false) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!token) return fallback;
  if (["1", "true", "yes", "on"].includes(token)) return true;
  if (["0", "false", "no", "off"].includes(token)) return false;
  return fallback;
}

function normalizeCompanyNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
  if (/^\d{1,8}$/.test(stripped)) return stripped.padStart(8, "0");
  if (/^[A-Z0-9]{2,12}$/.test(stripped)) return stripped;
  return null;
}

function normalizeConnectorId(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function parseConnectorFilterInput(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\s,;]+/) : [value]);

  const parsed = [];
  for (const rawItem of rawItems) {
    const normalized = normalizeConnectorId(rawItem);
    if (!normalized) continue;
    if (!parsed.includes(normalized)) {
      parsed.push(normalized);
    }
  }

  return parsed;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed <= 0) return 0;
  if (parsed >= 1) return 1;
  return parsed;
}

const STATUS_RESOLVED_PATTERN = /\b(resolved|restored|fixed|completed|closed|monitoring|postmortem)\b/i;
const STATUS_OPEN_PATTERN = /\b(open|investigating|identified|degraded|outage|incident|issue|disruption|latency|partial|critical|major|unavailable|ongoing|active|down|disrupt|impacted)\b/i;
const STATUS_MAJOR_PATTERN = /\b(critical|major|sev[-\s]?1|outage|severe|down)\b/i;
const STATUS_NUMERIC_TOKEN_MAP = {
  "0": "scheduled",
  "1": "investigating",
  "2": "identified",
  "3": "monitoring",
  "4": "resolved",
};

function normalizeIncidentStatusToken(value) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!token) return "";
  return STATUS_NUMERIC_TOKEN_MAP[token] || token;
}

function parseIsoTimestamp(value) {
  const token = String(value || "").trim();
  if (!token) return null;
  const millis = Date.parse(token);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

function latestIsoTimestamp(values = []) {
  let latestMs = null;
  let latestIso = null;

  for (const value of values || []) {
    const iso = parseIsoTimestamp(value);
    if (!iso) continue;
    const millis = Date.parse(iso);
    if (!Number.isFinite(millis)) continue;
    if (latestMs === null || millis > latestMs) {
      latestMs = millis;
      latestIso = iso;
    }
  }

  return latestIso;
}

function incidentAgeDaysFromIso(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis)) return null;
  const days = (nowMs - millis) / 86400000;
  if (!Number.isFinite(days)) return null;
  return Math.max(0, Math.round(days * 10) / 10);
}

function statusIncidentRecencyMultiplier(daysOld) {
  const age = Number(daysOld);
  if (!Number.isFinite(age)) return 1;
  if (age <= 3) return 1;
  if (age <= 14) return 0.95;
  if (age <= 30) return 0.8;
  if (age <= 60) return 0.65;
  if (age <= 120) return 0.5;
  return 0.35;
}

function statusHealthBandFromScore(value) {
  const score = clamp01(value);
  if (score >= 0.7) return "critical";
  if (score >= 0.35) return "degraded";
  return "stable";
}

function normalizeStatusHealthMetrics(input = {}) {
  const recentOpenIncidentAt = latestIsoTimestamp([
    input.status_recent_open_incident_at,
    input.recent_open_incident_at,
  ]);
  const recentIncidentAt = latestIsoTimestamp([
    input.status_recent_incident_at,
    input.recent_incident_at,
    recentOpenIncidentAt,
  ]);

  const explicitRecentAgeDays = Number(input.status_recent_incident_age_days);
  const computedRecentAgeDays = incidentAgeDaysFromIso(recentOpenIncidentAt || recentIncidentAt);
  const recentIncidentAgeDays = Number.isFinite(explicitRecentAgeDays)
    ? Math.max(0, explicitRecentAgeDays)
    : computedRecentAgeDays;

  const providedRecencyMultiplier = Number(input.status_incident_recency_multiplier);
  const recencyMultiplier = Number.isFinite(providedRecencyMultiplier)
    ? clamp01(providedRecencyMultiplier)
    : statusIncidentRecencyMultiplier(recentIncidentAgeDays);

  const totalIncidents = Math.max(0, toFiniteNumber(input.status_incidents_total, 0));
  const openIncidents = Math.max(0, toFiniteNumber(input.status_incidents_open, 0));
  const majorOpenIncidents = Math.max(0, Math.min(openIncidents, toFiniteNumber(input.status_major_incidents_open, 0)));
  const degradedComponents = Math.max(0, toFiniteNumber(input.status_degraded_components, 0));

  const computedWeightedOpen = openIncidents + (majorOpenIncidents * 1.5) + (degradedComponents * 0.75);
  const weightedOpen = Math.max(0, toFiniteNumber(input.status_incident_weighted_open, computedWeightedOpen));

  const hasCountInputs = [
    input.status_incidents_total,
    input.status_incidents_open,
    input.status_major_incidents_open,
    input.status_degraded_components,
    input.status_incident_weighted_open,
  ].some((value) => Number.isFinite(Number(value)));

  const providedSeverity = Number(input.status_incident_severity_score);
  const denominator = Math.max(4, totalIncidents + degradedComponents + 2);
  const computedSeverity = weightedOpen > 0 ? clamp01(weightedOpen / denominator) : 0;
  const baseSeverity = hasCountInputs
    ? computedSeverity
    : (Number.isFinite(providedSeverity) ? clamp01(providedSeverity) : 0);
  const severity = clamp01(baseSeverity * recencyMultiplier);
  const roundedSeverity = Math.round(severity * 100) / 100;

  return {
    status_incident_weighted_open: Math.round(weightedOpen * 100) / 100,
    status_incident_severity_score: roundedSeverity,
    status_health_band: statusHealthBandFromScore(roundedSeverity),
    status_recent_open_incident_at: recentOpenIncidentAt || null,
    status_recent_incident_at: recentIncidentAt || null,
    status_recent_incident_age_days: Number.isFinite(recentIncidentAgeDays)
      ? Math.round(recentIncidentAgeDays * 10) / 10
      : null,
    status_incident_recency_multiplier: Math.round(recencyMultiplier * 100) / 100,
  };
}

function evaluateStatusIncident({ statusToken = "", impactToken = "", text = "", resolvedAt = null } = {}) {
  const normalizedStatus = normalizeIncidentStatusToken(statusToken);
  const combined = `${normalizedStatus} ${impactToken} ${text}`.trim().toLowerCase();
  const resolved = Boolean(resolvedAt) || STATUS_RESOLVED_PATTERN.test(combined);
  const isOpen = !resolved && STATUS_OPEN_PATTERN.test(combined);
  const isMajor = !resolved && STATUS_MAJOR_PATTERN.test(combined);
  return {
    resolved,
    is_open: isOpen,
    is_major: isMajor,
  };
}

function applyStatusHealthNormalization(envelope = {}) {
  const normalized = normalizeStatusHealthMetrics(envelope);
  return {
    ...envelope,
    ...normalized,
  };
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function interpolateTemplate(template, context) {
  return String(template || "").replace(/\{([a-z_]+)\}/gi, (_match, token) => {
    const key = String(token || "").toLowerCase();
    return String(context[key] || "");
  });
}

function connectorSecretValues(definition) {
  const values = [];
  for (const keyEnv of definition.keyEnvs || []) {
    const value = String(process.env[keyEnv] || "").trim();
    if (!value) continue;
    values.push(value);
  }
  return values;
}

function connectorUrlTemplate(definition) {
  return String(process.env[definition.urlTemplateEnv] || "").trim();
}

function normalizeCompanyDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";

  const withoutScheme = raw.replace(/^https?:\/\//, "");
  const withoutWww = withoutScheme.replace(/^www\./, "");
  return withoutWww.split("/")[0].trim();
}

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildStatusDiscoveryCandidates(discoveryType, context) {
  const domain = normalizeCompanyDomain(context?.company_domain);
  if (!domain) return [];

  const hostCandidates = uniqueStrings([
    `status.${domain}`,
    `${domain}.statuspage.io`,
    `statuspage.${domain}`,
  ]);

  const urls = [];
  if (discoveryType === "statuspage") {
    for (const host of hostCandidates) {
      urls.push(`https://${host}/api/v2/summary.json`);
    }
  }

  if (discoveryType === "status_feed") {
    const feedPaths = [
      "history.rss",
      "history.atom",
      "rss",
      "atom",
      "feed",
      "status.rss",
      "status.atom",
    ];

    for (const host of hostCandidates) {
      for (const path of feedPaths) {
        urls.push(`https://${host}/${path}`);
      }
    }
  }

  if (discoveryType === "status_api") {
    const apiPaths = [
      "api/v1/incidents",
      "api/incidents",
      "incidents.json",
      "api/v1/status",
      "api/status",
      "api/v1/summary",
      "api/summary",
    ];

    for (const host of hostCandidates) {
      for (const path of apiPaths) {
        urls.push(`https://${host}/${path}`);
      }
    }
  }

  if (discoveryType === "status_instatus") {
    const summaryPaths = [
      "summary.json",
      "api/v1/summary",
      "api/summary",
      "summary",
    ];

    for (const host of hostCandidates) {
      for (const path of summaryPaths) {
        urls.push(`https://${host}/${path}`);
      }
    }
  }

  if (discoveryType === "status_cachet") {
    const cachetPaths = [
      "api/v1/incidents",
      "api/v1/incidents?sort=id&order=desc",
      "api/v1/status",
    ];

    for (const host of hostCandidates) {
      for (const path of cachetPaths) {
        urls.push(`https://${host}/${path}`);
      }
    }
  }

  return uniqueStrings(urls).filter((url) => isValidHttpUrl(url));
}

function buildConnectorRequestUrls(definition, context, options = {}) {
  const urls = [];
  const template = connectorUrlTemplate(definition);

  if (template) {
    const interpolated = interpolateTemplate(template, context);
    if (isValidHttpUrl(interpolated)) {
      urls.push(interpolated);
    }
  }

  const discoveryEnabled = options.enableStatusDiscovery === true;
  if (discoveryEnabled && definition.discoveryType) {
    urls.push(...buildStatusDiscoveryCandidates(definition.discoveryType, context));
  }

  return uniqueStrings(urls);
}

function buildConnectorHeaders(definition) {
  const secrets = connectorSecretValues(definition);
  if (secrets.length === 0) return {};

  const header = String(process.env[definition.authHeaderEnv] || "Authorization").trim() || "Authorization";
  const scheme = String(process.env[definition.authSchemeEnv] || "Bearer").trim();
  const token = secrets.length === 1 ? secrets[0] : secrets.join(":");

  if (!scheme || scheme.toLowerCase() === "none") {
    return { [header]: token };
  }

  return { [header]: `${scheme} ${token}` };
}

function isProspeoBulkCompanyEndpoint(url) {
  return /https?:\/\/api\.prospeo\.io\/bulk-enrich-company(?:$|[/?#])/i.test(String(url || ""));
}

function buildProspeoBulkCompanyPayload(context = {}) {
  const companyDomain = normalizeCompanyDomain(context?.company_domain);
  const companyWebsite = companyDomain || "";
  const companyLinkedinUrl = String(
    context?.company_linkedin_url
      || context?.linkedin_url
      || ""
  ).trim();
  const identifier = String(
    context?.company_number
      || context?.company_name
      || companyDomain
      || "unknown"
  ).trim() || "unknown";

  const row = { identifier };
  if (companyWebsite) row.company_website = companyWebsite;
  if (companyLinkedinUrl) row.company_linkedin_url = companyLinkedinUrl;

  return { data: [row] };
}

function buildConnectorRequestOptions(definition, context, url) {
  const headers = {
    Accept: String(definition.acceptHeader || "application/json"),
    ...buildConnectorHeaders(definition),
  };

  let method = "GET";
  let body;

  if (definition.id === "prospeo" && isProspeoBulkCompanyEndpoint(url)) {
    method = "POST";
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(buildProspeoBulkCompanyPayload(context));
  }

  return {
    method,
    headers,
    body,
  };
}

function buildConnectorStatus(definition) {
  const keysOptional = definition.keysOptional === true;
  const keyStatus = keysOptional || (definition.keyEnvs || []).every((keyEnv) => hasConfiguredSecret(process.env[keyEnv]));
  const urlTemplate = connectorUrlTemplate(definition);

  return {
    id: definition.id,
    configured: keyStatus && !!urlTemplate,
    has_keys: keyStatus,
    keys_optional: keysOptional,
    has_url_template: !!urlTemplate,
    key_envs: definition.keyEnvs,
    url_template_env: definition.urlTemplateEnv,
    supports_discovery: !!definition.discoveryType,
    purpose: definition.purpose,
  };
}

export function getExternalSignalConnectorStatus() {
  return CONNECTOR_DEFINITIONS.map((definition) => buildConnectorStatus(definition));
}

function buildConnectorRuntimeStatus(definition, context, options = {}) {
  const base = buildConnectorStatus(definition);
  const requestUrls = buildConnectorRequestUrls(definition, context, options);
  const templateConfigured = !!connectorUrlTemplate(definition);
  const autoDiscoveryActive = options.enableStatusDiscovery === true
    && !!definition.discoveryType
    && !templateConfigured
    && requestUrls.length > 0;

  return {
    ...base,
    configured: base.has_keys && requestUrls.length > 0,
    request_candidate_count: requestUrls.length,
    auto_discovery_active: autoDiscoveryActive,
    request_urls: requestUrls,
  };
}

function classifyConnectorFailure(status, error) {
  const normalizedError = String(error || "").trim().toLowerCase();
  const statusCode = Number(status);

  if (normalizedError === "missing_url_template") return "config_error";
  if (normalizedError === "request_timeout") return "timeout";
  if (normalizedError.startsWith("http_")) return "http_error";
  if (Number.isFinite(statusCode) && statusCode >= 400) return "http_error";
  if (normalizedError) return "request_error";
  return "unknown";
}

async function fetchConnectorPayload(definition, requestUrls, timeoutMs, context = {}) {
  const urls = Array.isArray(requestUrls) ? requestUrls.filter(Boolean) : [];
  const startedAt = Date.now();
  const attempts = [];

  if (urls.length === 0) {
    return {
      ok: false,
      status: null,
      error: "missing_url_template",
      attempted_urls: [],
      attempts,
      attempt_count: 0,
      retry_count: 0,
      failed_attempt_count: 0,
      request_duration_ms: 0,
    };
  }

  const attemptedUrls = [];
  let lastError = {
    ok: false,
    status: null,
    error: "request_failed",
    request_url: urls[0],
  };

  for (const url of urls) {
    attemptedUrls.push(url);
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestOptions = buildConnectorRequestOptions(definition, context, url);

    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal,
      });

      const rawText = await response.text();
      let payload = null;

      if (rawText) {
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = { raw_text: rawText };
        }
      }

      if (!response.ok) {
        const error = payload?.error || payload?.message || `http_${response.status}`;
        const durationMs = Math.max(0, Date.now() - attemptStartedAt);

        attempts.push({
          url,
          method: requestOptions.method,
          ok: false,
          status: response.status,
          error,
          timed_out: false,
          duration_ms: durationMs,
        });

        lastError = {
          ok: false,
          status: response.status,
          error,
          request_url: url,
          request_method: requestOptions.method,
          payload,
          attempted_urls: attemptedUrls,
          attempts,
          attempt_count: attempts.length,
          retry_count: Math.max(0, attempts.length - 1),
          failed_attempt_count: attempts.length,
          request_duration_ms: Math.max(0, Date.now() - startedAt),
        };
        continue;
      }

      const durationMs = Math.max(0, Date.now() - attemptStartedAt);
      attempts.push({
        url,
        method: requestOptions.method,
        ok: true,
        status: response.status,
        error: null,
        timed_out: false,
        duration_ms: durationMs,
      });

      const failedAttemptCount = attempts.filter((entry) => entry.ok === false).length;

      return {
        ok: true,
        status: response.status,
        request_url: url,
        request_method: requestOptions.method,
        attempted_urls: attemptedUrls,
        payload,
        attempts,
        attempt_count: attempts.length,
        retry_count: Math.max(0, attempts.length - 1),
        failed_attempt_count: failedAttemptCount,
        request_duration_ms: Math.max(0, Date.now() - startedAt),
      };
    } catch (err) {
      const error = err?.name === "AbortError" ? "request_timeout" : (err?.message || "request_failed");
      const durationMs = Math.max(0, Date.now() - attemptStartedAt);

      attempts.push({
        url,
        method: requestOptions.method,
        ok: false,
        status: null,
        error,
        timed_out: error === "request_timeout",
        duration_ms: durationMs,
      });

      lastError = {
        ok: false,
        status: null,
        error,
        request_url: url,
        request_method: requestOptions.method,
        attempted_urls: attemptedUrls,
        attempts,
        attempt_count: attempts.length,
        retry_count: Math.max(0, attempts.length - 1),
        failed_attempt_count: attempts.length,
        request_duration_ms: Math.max(0, Date.now() - startedAt),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ...lastError,
    attempts,
    attempt_count: Number(lastError?.attempt_count || attempts.length || 0),
    retry_count: Number(lastError?.retry_count || Math.max(0, attempts.length - 1)),
    failed_attempt_count: Number(lastError?.failed_attempt_count || attempts.length || 0),
    request_duration_ms: Number(lastError?.request_duration_ms || Math.max(0, Date.now() - startedAt)),
  };
}

function asObjectArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === "object");
}

function isSignificantControlNature(nature) {
  const token = String(nature || "").toLowerCase();
  if (!token) return false;
  return token.includes("25-to-50-percent")
    || token.includes("50-to-75-percent")
    || token.includes("75-to-100-percent")
    || token.includes("more-than-25-percent")
    || token.includes("more than 25");
}

function isUkJurisdiction(...values) {
  const text = values
    .map((value) => String(value || "").toLowerCase())
    .join(" ")
    .replace(/[^a-z\s]/g, " ");

  if (!text.trim()) return false;

  const ukPatterns = [
    /\bunited\s+kingdom\b/,
    /\buk\b/,
    /\bgb\b/,
    /\bgreat\s+britain\b/,
    /\bengland\b/,
    /\bwales\b/,
    /\bscotland\b/,
    /\bnorthern\s+ireland\b/,
  ];

  return ukPatterns.some((pattern) => pattern.test(text));
}

function collectArraysByKeys(root, keyNames, maxDepth = 5) {
  const arrays = [];
  const queue = [{ value: root, depth: 0 }];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;

    if (next.depth > maxDepth) continue;

    const value = next.value;
    if (!value || typeof value !== "object") continue;

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          queue.push({ value: entry, depth: next.depth + 1 });
        }
      }
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && keyNames.has(String(key || "").toLowerCase())) {
        arrays.push(child);
      }
      if (child && typeof child === "object") {
        queue.push({ value: child, depth: next.depth + 1 });
      }
    }
  }

  return arrays;
}

function readStringField(record, keys) {
  for (const key of keys) {
    const value = String(record?.[key] || "").trim();
    if (value) return value;
  }
  return null;
}

function readNumericField(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;

    const token = String(value ?? "").replace(/[^\d.-]/g, "");
    if (!token || token === "." || token === "-" || token === "-.") continue;
    const parsedToken = Number(token);
    if (Number.isFinite(parsedToken)) return parsedToken;
  }
  return null;
}

function normalizeTrafficShare(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed >= 0 && parsed <= 1) {
    return Math.round(parsed * 10000) / 100;
  }
  return Math.round(parsed * 100) / 100;
}

function normalizeTrafficGeography(value) {
  if (!value) return {};

  if (Array.isArray(value)) {
    const map = {};
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;

      const key = readStringField(entry, ["country", "country_code", "code", "name", "key"]);
      const shareRaw = readNumericField(entry, ["share", "percentage", "pct", "value", "visits_share"]);
      const share = normalizeTrafficShare(shareRaw);
      if (!key || !Number.isFinite(share)) continue;

      map[key] = share;
    }
    return map;
  }

  if (typeof value === "object") {
    return value;
  }

  return {};
}

function getByPath(root, path) {
  const tokens = String(path || "").split(".").filter(Boolean);
  let cursor = root;

  for (const token of tokens) {
    if (cursor === undefined || cursor === null) return undefined;

    if (Array.isArray(cursor) && /^\d+$/.test(token)) {
      const index = Number.parseInt(token, 10);
      cursor = cursor[index];
      continue;
    }

    if (typeof cursor !== "object") return undefined;
    cursor = cursor[token];
  }

  return cursor;
}

function getFirstByPaths(root, paths) {
  for (const path of paths || []) {
    const value = getByPath(root, path);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function getFirstNumericByPaths(root, paths) {
  for (const path of paths || []) {
    const candidate = getByPath(root, path);
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;

    const token = String(candidate ?? "").replace(/[^\d.-]/g, "");
    if (!token || token === "." || token === "-" || token === "-.") continue;
    const parsedToken = Number(token);
    if (Number.isFinite(parsedToken)) return parsedToken;
  }
  return null;
}

function getFirstNumericFromRecords(records, keys) {
  for (const record of asObjectArray(records)) {
    const value = readNumericField(record, keys);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function getFirstArrayByPaths(root, paths) {
  for (const path of paths || []) {
    const candidate = getByPath(root, path);
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function collectArraysFromPaths(root, paths) {
  const combined = [];
  for (const path of paths || []) {
    const candidate = getByPath(root, path);
    if (!Array.isArray(candidate)) continue;
    combined.push(...candidate);
  }
  return combined;
}

function normalizeConnectorPayloadRoot(payload) {
  if (Array.isArray(payload)) {
    return {
      results: payload,
      rows: payload,
      items: payload,
      data: payload,
    };
  }

  const objectPayload = payload && typeof payload === "object" ? payload : {};

  const dataCandidate = objectPayload.data;
  if (dataCandidate && typeof dataCandidate === "object" && !Array.isArray(dataCandidate)) {
    return { ...objectPayload, ...dataCandidate };
  }
  if (Array.isArray(dataCandidate)) {
    return {
      ...objectPayload,
      results: dataCandidate,
      rows: dataCandidate,
      items: dataCandidate,
    };
  }

  const resultCandidate = objectPayload.result;
  if (resultCandidate && typeof resultCandidate === "object" && !Array.isArray(resultCandidate)) {
    return { ...objectPayload, ...resultCandidate };
  }
  if (Array.isArray(resultCandidate)) {
    return {
      ...objectPayload,
      results: resultCandidate,
      rows: resultCandidate,
      items: resultCandidate,
    };
  }

  if (Array.isArray(objectPayload.results)) {
    return {
      ...objectPayload,
      rows: objectPayload.results,
      items: objectPayload.results,
    };
  }

  return objectPayload;
}

function parseOwnershipEnvelope(payload, sourceId) {
  const keyNames = new Set([
    "shareholders",
    "owners",
    "beneficial_owners",
    "significant_shareholders",
    "controllers",
    "persons_with_significant_control",
    "corporate_entities",
  ]);

  const arrays = collectArraysByKeys(payload, keyNames, 6);
  const records = [];

  for (const list of arrays) {
    for (const item of asObjectArray(list)) {
      const name = readStringField(item, ["name", "company_name", "legal_name", "entity_name"]);
      if (!name) continue;

      const kind = readStringField(item, ["kind", "type", "entity_type", "entity_kind"]);
      const country = readStringField(item, ["country", "country_registered", "country_of_incorporation", "jurisdiction"]);
      const governingLaw = readStringField(item, ["governing_law", "law", "law_governed"]);
      const pct = readNumericField(item, ["share_percent", "ownership_percent", "percentage", "percent", "voting_percent"]);
      const natures = Array.isArray(item?.natures_of_control) ? item.natures_of_control : [];

      const significantControl = (pct !== null && pct >= 25)
        || natures.some((nature) => isSignificantControlNature(nature));

      const kindToken = String(kind || "").toLowerCase();
      const isCorporate = kindToken.includes("company")
        || kindToken.includes("corporate")
        || kindToken.includes("legal")
        || kindToken.includes("entity")
        || kindToken.includes("organisation")
        || kindToken.includes("organization")
        || !!item?.registration_number
        || !!item?.company_number;

      const nonUk = significantControl && !isUkJurisdiction(country, governingLaw);

      records.push({
        name,
        kind: kind || null,
        is_corporate: isCorporate,
        country_registered: country || null,
        governing_law: governingLaw || null,
        is_significant_control: significantControl,
        control_percent: pct,
        non_uk_jurisdiction: nonUk,
      });
    }
  }

  const significantCorporate = records.filter((record) => record.is_significant_control && record.is_corporate);
  const nonUkSignificantCorporate = significantCorporate.filter((record) => record.non_uk_jurisdiction);
  if (significantCorporate.length === 0) return null;

  const primary = nonUkSignificantCorporate[0] || significantCorporate[0];
  const nowIso = new Date().toISOString();

  return {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    structure: nonUkSignificantCorporate.length > 0 ? "foreign_subsidiary" : "unknown",
    parent_company: primary?.name || null,
    parent_country: primary?.country_registered || null,
    significant_corporate_controllers_count: significantCorporate.length,
    non_uk_significant_corporate_controllers_count: nonUkSignificantCorporate.length,
    significant_corporate_controllers: significantCorporate.slice(0, 20),
    non_uk_significant_corporate_controllers: nonUkSignificantCorporate.slice(0, 20),
    confidence: nonUkSignificantCorporate.length > 0 ? "medium" : "low",
  };
}

function roleBucketForText(role) {
  const token = String(role || "").toLowerCase();
  if (!token) return null;
  if (token.includes("treasury")) return "treasury";
  if (token.includes("finance") || token.includes("account") || token.includes("cfo")) return "finance";
  if (token.includes("international") || token.includes("emea") || token.includes("procurement")) return "international";
  if (token.includes("ecommerce") || token.includes("digital")) return "ecommerce";
  return null;
}

function parseHiringEnvelope(payload, sourceId) {
  const keyNames = new Set(["jobs", "open_roles", "roles", "vacancies", "positions", "results"]);
  const arrays = collectArraysByKeys(payload, keyNames, 5);
  const roleNames = [];

  for (const list of arrays) {
    for (const item of asObjectArray(list)) {
      const role = readStringField(item, ["role", "title", "job_title", "position"]);
      if (!role) continue;
      roleNames.push(role);
    }
  }

  const uniqueRoleNames = uniqueStrings(roleNames).slice(0, 40);
  const explicitOpenRoles = readNumericField(payload || {}, ["open_roles", "jobs_open", "vacancies", "active_jobs", "total_results"]);
  const totalOpenRoles = Math.max(uniqueRoleNames.length, Number(explicitOpenRoles || 0));

  if (totalOpenRoles <= 0) return null;

  const nowIso = new Date().toISOString();
  const openRoles = uniqueRoleNames.map((role) => ({ role }));
  const financeRoles = openRoles.filter((entry) => roleBucketForText(entry.role) === "finance");
  const treasuryRoles = openRoles.filter((entry) => roleBucketForText(entry.role) === "treasury");
  const internationalRoles = openRoles.filter((entry) => roleBucketForText(entry.role) === "international");
  const ecommerceRoles = openRoles.filter((entry) => roleBucketForText(entry.role) === "ecommerce");
  const score = Math.max(0, Math.min(totalOpenRoles / 20, 1));

  return {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    total_open_roles: totalOpenRoles,
    open_roles: openRoles,
    finance_roles_open: financeRoles,
    treasury_roles_open: treasuryRoles,
    international_roles_open: internationalRoles,
    ecommerce_roles_open: ecommerceRoles,
    hiring_signal_score: Math.round(score * 100) / 100,
    hiring_intensity: score >= 0.7 ? "high" : score >= 0.35 ? "medium" : "low",
    evidence: [`${sourceId} reports ${totalOpenRoles} active roles`],
    confidence: score >= 0.5 ? "high" : "medium",
    confidence_score: Math.round(score * 100) / 100,
  };
}

function parseReputationEnvelope(payload, sourceId) {
  const reviewCount = readNumericField(payload || {}, ["review_count", "reviews", "trustpilot_review_count"]);
  const paymentComplaints = readNumericField(payload || {}, ["payment_related_complaints", "payment_complaints"]);
  const checkoutComplaints = readNumericField(payload || {}, ["checkout_related_complaints", "checkout_complaints"]);
  const statusIncidentsTotal = readNumericField(payload || {}, ["status_incidents_total", "incidents_total", "incident_count"]);
  const statusIncidentsOpen = readNumericField(payload || {}, ["status_incidents_open", "open_incidents", "incidents_open"]);
  const statusMajorIncidentsOpen = readNumericField(payload || {}, ["status_major_incidents_open", "major_open_incidents", "major_incidents_open"]);
  const statusDegradedComponents = readNumericField(payload || {}, ["status_degraded_components", "degraded_components"]);
  const statusIncidentWeightedOpen = readNumericField(payload || {}, ["status_incident_weighted_open", "incident_weighted_open"]);
  const statusIncidentSeverity = readNumericField(payload || {}, ["status_incident_severity_score", "incident_severity_score"]);
  const statusRecentIncidentAt = readStringField(payload || {}, ["status_recent_incident_at", "recent_incident_at", "latest_incident_at"]);
  const statusRecentOpenIncidentAt = readStringField(payload || {}, ["status_recent_open_incident_at", "recent_open_incident_at", "latest_open_incident_at"]);
  const statusRecentIncidentAgeDays = readNumericField(payload || {}, ["status_recent_incident_age_days", "recent_incident_age_days"]);
  const statusIncidentRecencyMultiplier = readNumericField(payload || {}, ["status_incident_recency_multiplier", "incident_recency_multiplier"]);

  const hasStatusMetrics = [
    statusIncidentsTotal,
    statusIncidentsOpen,
    statusMajorIncidentsOpen,
    statusDegradedComponents,
    statusIncidentWeightedOpen,
    statusIncidentSeverity,
  ].some((value) => value !== null);
  const hasStatusCountMetrics = [
    statusIncidentsTotal,
    statusIncidentsOpen,
    statusMajorIncidentsOpen,
    statusDegradedComponents,
    statusIncidentWeightedOpen,
  ].some((value) => value !== null);

  if (
    reviewCount === null
    && paymentComplaints === null
    && checkoutComplaints === null
    && !hasStatusMetrics
  ) {
    return null;
  }

  const nowIso = new Date().toISOString();

  const envelope = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    trustpilot_review_count: Number(reviewCount || 0),
    payment_related_complaints: Number(paymentComplaints || 0),
    checkout_related_complaints: Number(checkoutComplaints || 0),
    evidence: [`${sourceId} reputation metrics imported`],
    confidence: "medium",
    confidence_score: 0.55,
  };

  if (hasStatusMetrics) {
    if (hasStatusCountMetrics) {
      envelope.status_incidents_total = Math.max(0, toFiniteNumber(statusIncidentsTotal, 0));
      envelope.status_incidents_open = Math.max(0, toFiniteNumber(statusIncidentsOpen, 0));
      envelope.status_major_incidents_open = Math.max(0, toFiniteNumber(statusMajorIncidentsOpen, 0));
      envelope.status_degraded_components = Math.max(0, toFiniteNumber(statusDegradedComponents, 0));
    }
    if (statusIncidentWeightedOpen !== null && hasStatusCountMetrics) {
      envelope.status_incident_weighted_open = Math.max(0, toFiniteNumber(statusIncidentWeightedOpen, 0));
    }
    if (statusIncidentSeverity !== null) {
      envelope.status_incident_severity_score = clamp01(statusIncidentSeverity);
    }
    if (statusRecentIncidentAt) {
      envelope.status_recent_incident_at = statusRecentIncidentAt;
    }
    if (statusRecentOpenIncidentAt) {
      envelope.status_recent_open_incident_at = statusRecentOpenIncidentAt;
    }
    if (statusRecentIncidentAgeDays !== null) {
      envelope.status_recent_incident_age_days = Math.max(0, toFiniteNumber(statusRecentIncidentAgeDays, 0));
    }
    if (statusIncidentRecencyMultiplier !== null) {
      envelope.status_incident_recency_multiplier = clamp01(statusIncidentRecencyMultiplier);
    }
    return applyStatusHealthNormalization(envelope);
  }

  return envelope;
}

function parseMarketingEnvelope(payload, sourceId) {
  const root = payload || {};
  const monthlyTraffic = readNumericField(root, ["monthly_web_traffic", "monthly_visits", "visits", "web_traffic"]);
  const adSpend = readNumericField(root, ["estimated_monthly_ad_spend", "estimated_ad_spend", "paid_search_spend"]);
  const trafficGeography = normalizeTrafficGeography(
    getFirstByPaths(root, ["traffic_geography", "geography", "geo_distribution", "countries", "distribution"])
  );

  if (!Number.isFinite(monthlyTraffic) && !Number.isFinite(adSpend) && Object.keys(trafficGeography).length === 0) {
    return null;
  }

  const nowIso = new Date().toISOString();

  return {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    monthly_web_traffic: Number(monthlyTraffic || 0),
    web_traffic: Number(monthlyTraffic || 0),
    estimated_monthly_ad_spend: Number(adSpend || 0),
    traffic_geography: trafficGeography,
    evidence: [`${sourceId} traffic metric imported`],
    confidence: "medium",
    confidence_score: 0.55,
  };
}

function parseTechEnvelope(payload, sourceId) {
  const keyNames = new Set(["technologies", "tech_stack", "stack", "wappalyzer", "detected_technologies"]);
  const arrays = collectArraysByKeys(payload, keyNames, 5);
  const technologies = [];

  for (const list of arrays) {
    for (const entry of list || []) {
      if (typeof entry === "string") {
        technologies.push(entry);
        continue;
      }
      if (entry && typeof entry === "object") {
        const name = readStringField(entry, ["name", "technology", "title"]);
        if (name) technologies.push(name);
      }
    }
  }

  const uniqueTechnologies = uniqueStrings(technologies).slice(0, 80);
  if (uniqueTechnologies.length === 0) return null;

  const nowIso = new Date().toISOString();
  const score = Math.max(0.35, Math.min(uniqueTechnologies.length / 20, 0.95));

  return {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    technologies: uniqueTechnologies,
    detected_technologies: uniqueTechnologies,
    stack: uniqueTechnologies,
    confidence: score >= 0.7 ? "high" : "medium",
    confidence_score: Math.round(score * 100) / 100,
    signal_count: uniqueTechnologies.length,
    evidence: uniqueTechnologies.slice(0, 20).map((name) => ({ technology: name, source: `${sourceId}_api` })),
  };
}

function parseEndoleSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);

  const ownershipRows = collectArraysFromPaths(root, [
    "shareholders",
    "beneficial_owners",
    "significant_shareholders",
    "company.shareholders",
    "ownership.shareholders",
    "people_with_significant_control",
  ]).map((row) => ({
    name: readStringField(row, ["name", "company_name", "legal_name", "entity_name"]),
    type: readStringField(row, ["type", "kind", "entity_type"]) || "corporate entity",
    country_registered: readStringField(row, ["country_registered", "country", "jurisdiction", "country_of_incorporation"]),
    governing_law: readStringField(row, ["governing_law", "law", "law_governed"]),
    share_percent: readNumericField(row, ["share_percent", "ownership_percent", "percentage", "percent", "voting_percent"]),
    natures_of_control: row?.natures_of_control,
    registration_number: readStringField(row, ["registration_number", "company_number"]),
  })).filter((row) => row.name);

  const jobRows = collectArraysFromPaths(root, [
    "jobs",
    "open_roles",
    "hiring.roles",
    "hiring.open_roles",
    "vacancies",
    "company.jobs",
  ]).map((row) => ({
    title: readStringField(row, ["title", "role", "job_title", "position"]),
  })).filter((row) => row.title);

  const technologies = uniqueStrings([
    ...getFirstArrayByPaths(root, ["technologies", "tech_stack", "website.technologies"]),
    ...collectArraysFromPaths(root, ["website.stack", "website.detected_technologies"]),
  ].map((entry) => (typeof entry === "string" ? entry : readStringField(entry, ["name", "technology", "title"]))));

  const normalizedPayload = {
    shareholders: ownershipRows,
    jobs: jobRows,
    open_roles: getFirstNumericByPaths(root, ["open_roles", "jobs_open", "vacancies", "active_jobs"]),
    monthly_web_traffic: getFirstNumericByPaths(root, ["traffic.monthly_visits", "monthly_visits", "monthly_web_traffic", "website.monthly_visits"]),
    estimated_monthly_ad_spend: getFirstNumericByPaths(root, ["traffic.estimated_ad_spend", "estimated_monthly_ad_spend", "estimated_ad_spend"]),
    traffic_geography: getFirstByPaths(root, ["traffic.geography", "geography", "geo_distribution"]) || {},
    review_count: getFirstNumericByPaths(root, ["reviews.count", "review_count", "trustpilot.review_count"]),
    payment_related_complaints: getFirstNumericByPaths(root, ["reviews.payment_related_complaints", "payment_related_complaints"]),
    checkout_related_complaints: getFirstNumericByPaths(root, ["reviews.checkout_related_complaints", "checkout_related_complaints"]),
    technologies,
  };

  return {
    ownership: parseOwnershipEnvelope(normalizedPayload, sourceId),
    hiring: parseHiringEnvelope(normalizedPayload, sourceId),
    reputation: parseReputationEnvelope(normalizedPayload, sourceId),
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: parseTechEnvelope(normalizedPayload, sourceId),
  };
}

function parseOpenCorporatesSpecificEnvelopes(payload, sourceId) {
  const root = payload || {};
  const candidateRows = collectArraysFromPaths(root, [
    "results.company.shareholders",
    "results.company.beneficial_owners",
    "results.company.controlling_entities",
    "results.company.company.shareholders",
    "results.company.company.beneficial_owners",
    "results.company.company.controlling_entities",
    "results.company.controllers",
    "results.companies.0.company.shareholders",
    "results.companies.0.company.beneficial_owners",
    "results.beneficial_owners",
    "beneficial_owners",
  ]);

  const ownershipRows = candidateRows.map((row) => ({
    name: getFirstByPaths(row, ["name", "company_name", "entity_name", "owner.name", "entity.name", "company.name"]),
    type: getFirstByPaths(row, ["entity_type", "type", "kind", "owner.type", "entity.type"]) || "corporate entity",
    country_registered: getFirstByPaths(row, ["country", "country_of_incorporation", "jurisdiction", "owner.country", "entity.country"]),
    governing_law: getFirstByPaths(row, ["governing_law", "law_governed", "owner.governing_law", "entity.governing_law"]),
    share_percent: getFirstNumericByPaths(row, [
      "ownership_percent",
      "share_percent",
      "percentage",
      "percent",
      "percentage_of_shares",
      "owner.percentage",
      "owner.share_percent",
    ]),
    natures_of_control: getFirstByPaths(row, ["natures_of_control", "owner.natures_of_control", "entity.natures_of_control"]),
  })).filter((row) => row.name);

  const companyJurisdiction = getFirstByPaths(root, [
    "results.company.jurisdiction_code",
    "results.company.company.jurisdiction_code",
    "results.companies.0.company.jurisdiction_code",
    "results.company.company.registered_address.country",
  ]);
  const normalizedPayload = {
    shareholders: ownershipRows,
    geography: companyJurisdiction ? { jurisdiction: companyJurisdiction } : {},
  };

  return {
    ownership: parseOwnershipEnvelope(normalizedPayload, sourceId),
    hiring: null,
    reputation: null,
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: null,
  };
}

function parseSimilarwebSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const visitsSeries = getFirstArrayByPaths(root, ["visits", "traffic.visits", "engagement.visits"]);
  let derivedMonthlyVisits = null;
  if (visitsSeries.length > 0) {
    for (let i = visitsSeries.length - 1; i >= 0; i -= 1) {
      const visits = readNumericField(visitsSeries[i], ["visits", "value", "monthly_visits"]);
      if (Number.isFinite(visits)) {
        derivedMonthlyVisits = visits;
        break;
      }
    }
  }

  const trafficGeography = normalizeTrafficGeography(
    getFirstByPaths(root, ["traffic_geography", "geography", "geo_distribution", "countries", "distribution"])
  );

  const normalizedPayload = {
    monthly_web_traffic: getFirstNumericByPaths(root, [
      "monthly_web_traffic",
      "monthly_visits",
      "visits",
      "overview.monthly_visits",
      "traffic.monthly_visits",
      "engagement.total_visits",
    ]) || derivedMonthlyVisits,
    estimated_monthly_ad_spend: getFirstNumericByPaths(root, [
      "estimated_monthly_ad_spend",
      "paid_search_spend",
      "ad_spend",
      "ads.estimated_monthly_spend",
      "ads.search_spend",
    ]),
    traffic_geography: trafficGeography,
  };

  return {
    ownership: null,
    hiring: null,
    reputation: null,
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: null,
  };
}

function parseBuiltWithSpecificEnvelopes(payload, sourceId) {
  const root = payload || {};
  const technologies = [];

  const results = getFirstArrayByPaths(root, ["Results", "results", "data.results"]);
  for (const row of results) {
    const paths = getFirstArrayByPaths(row, ["Result.Paths", "result.paths", "Paths", "paths"]);
    for (const pathEntry of paths) {
      const techRows = getFirstArrayByPaths(pathEntry, ["Technologies", "technologies"]);
      for (const tech of techRows) {
        const name = readStringField(tech, ["Name", "name", "Technology", "technology"]);
        if (name) technologies.push(name);
      }
    }
  }

  const normalizedPayload = {
    technologies,
  };

  return {
    ownership: null,
    hiring: null,
    reputation: null,
    marketing: null,
    tech: parseTechEnvelope(normalizedPayload, sourceId),
  };
}

function parseAdzunaSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const jobs = getFirstArrayByPaths(root, ["results", "jobs", "vacancies"]).map((row) => ({
    title: readStringField(row, ["title", "display_name", "job_title", "role"]),
  })).filter((row) => row.title);

  const normalizedPayload = {
    jobs,
    open_roles: getFirstNumericByPaths(root, ["count", "total_results", "open_roles", "results_count"]),
  };

  return {
    ownership: null,
    hiring: parseHiringEnvelope(normalizedPayload, sourceId),
    reputation: null,
    marketing: null,
    tech: null,
  };
}

function parseCrunchbaseSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const normalizedPayload = {
    open_roles: getFirstNumericByPaths(root, [
      "properties.num_current_positions",
      "num_current_positions",
      "jobs_open",
    ]),
    monthly_web_traffic: getFirstNumericByPaths(root, [
      "properties.monthly_web_traffic",
      "properties.monthly_visits",
      "properties.traffic.monthly_visits",
      "monthly_web_traffic",
      "web_traffic",
    ]),
    estimated_monthly_ad_spend: getFirstNumericByPaths(root, [
      "properties.estimated_monthly_ad_spend",
      "estimated_monthly_ad_spend",
    ]),
  };

  return {
    ownership: null,
    hiring: parseHiringEnvelope(normalizedPayload, sourceId),
    reputation: null,
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: null,
  };
}

function parseClearbitSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const technologies = uniqueStrings([
    ...getFirstArrayByPaths(root, ["site.tech", "site.technologies", "technologies", "tech"]),
  ].map((entry) => (typeof entry === "string" ? entry : readStringField(entry, ["name", "technology", "title"]))));

  const normalizedPayload = {
    technologies,
    monthly_web_traffic: getFirstNumericByPaths(root, [
      "metrics.monthlyVisitors",
      "metrics.monthly_visitors",
      "site.monthlyVisitors",
      "site.monthly_visitors",
      "monthly_web_traffic",
    ]),
    open_roles: getFirstNumericByPaths(root, ["metrics.openRoles", "metrics.open_roles", "metrics.open_positions", "open_roles"]),
  };

  return {
    ownership: null,
    hiring: parseHiringEnvelope(normalizedPayload, sourceId),
    reputation: null,
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: parseTechEnvelope(normalizedPayload, sourceId),
  };
}

function splitDelimitedTextValues(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => splitDelimitedTextValues(entry))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[;,|]/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  if (value && typeof value === "object") {
    const picked = readStringField(value, ["name", "title", "technology", "value", "label"]);
    return picked ? [picked] : [];
  }

  return [];
}

function extractRoleTitleFromRecord(record) {
  const direct = readStringField(record, [
    "title",
    "job_title",
    "jobTitle",
    "position",
    "role",
    "positionTitle",
    "occupation",
  ]);
  if (direct) return direct;

  const headline = readStringField(record, ["headline", "summary", "description"]);
  if (!headline) return null;

  const prefix = String(headline).split(/\s+at\s+/i)[0]?.trim();
  return prefix || headline;
}

function parseProspeoSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const matchedCompanies = asObjectArray(
    collectArraysFromPaths(root, [
      "matched",
      "data.matched",
      "result.matched",
    ]).map((row) => (row && typeof row === "object" ? row.company : null))
  );

  const companyNode = getFirstByPaths(root, [
    "company",
    "organization",
    "data.company",
    "data.organization",
    "result.company",
    "matched.0.company",
    "data.matched.0.company",
    "result.matched.0.company",
  ]) || matchedCompanies[0] || {};

  const contactRows = asObjectArray(collectArraysFromPaths(root, [
    "people",
    "contacts",
    "employees",
    "prospects",
    "matches",
    "leads",
    "results",
    "rows",
    "items",
    "data.results",
    "data.rows",
    "data.items",
    "data.people",
    "data.contacts",
    "response.results",
    "response.data",
    "organization.people",
  ]));
  const explicitJobRows = asObjectArray(collectArraysFromPaths(root, [
    "jobs",
    "open_roles",
    "roles",
    "positions",
    "vacancies",
    "company.jobs",
    "company.roles",
    "organization.roles",
    "data.jobs",
  ]));
  const matchedJobRows = matchedCompanies.flatMap((company) => {
    const titles = getByPath(company, "job_postings.active_titles");
    if (!Array.isArray(titles)) return [];

    return titles
      .map((title) => ({ title: String(title || "").trim() }))
      .filter((row) => row.title);
  });

  const jobs = [...contactRows, ...explicitJobRows, ...matchedJobRows]
    .map((row) => ({ title: extractRoleTitleFromRecord(row) }))
    .filter((row) => row.title);

  const roleCountFromCompany = getFirstNumericByPaths(companyNode, [
    "open_roles",
    "jobs_open",
    "vacancies",
    "job_postings.active_count",
  ]);
  const roleCountFromMatchedCompanies = matchedCompanies
    .map((company) => Number(getByPath(company, "job_postings.active_count")))
    .find((value) => Number.isFinite(value));

  const technologies = uniqueStrings([
    ...splitDelimitedTextValues(getFirstArrayByPaths(root, [
      "technologies",
      "tech_stack",
      "data.technologies",
      "data.tech_stack",
      "company.technologies",
      "company.tech_stack",
      "organization.technologies",
    ])),
    ...splitDelimitedTextValues([
      getFirstByPaths(root, [
        "technology",
        "tech",
        "primary_technology",
        "company.technology",
        "organization.technology",
      ]),
      getFirstByPaths(companyNode, ["technology", "tech", "primary_technology"]),
      getByPath(companyNode, "technology.technology_names"),
      getByPath(companyNode, "technology.technology_list"),
    ]),
    ...splitDelimitedTextValues(getFirstArrayByPaths(companyNode, ["technologies", "tech_stack", "stack"])),
    ...matchedCompanies.flatMap((company) => splitDelimitedTextValues([
      getByPath(company, "technology.technology_names"),
      getByPath(company, "technology.technology_list"),
      getByPath(company, "technology_list"),
      getByPath(company, "technologies"),
      getByPath(company, "tech_stack"),
    ])),
    ...contactRows.flatMap((row) => splitDelimitedTextValues([
      row?.technologies,
      row?.technology,
      row?.tech_stack,
      row?.stack,
      row?.tools,
    ])),
  ]);

  const normalizedPayload = {
    jobs,
    open_roles: getFirstNumericByPaths(root, [
      "open_roles",
      "jobs_open",
      "vacancies",
      "active_jobs",
      "results_count",
      "meta.total_results",
    ])
      ?? roleCountFromCompany
      ?? roleCountFromMatchedCompanies
      ?? (jobs.length > 0 ? jobs.length : null),
    technologies,
    monthly_web_traffic: getFirstNumericByPaths(root, [
      "monthly_web_traffic",
      "monthly_visits",
      "web_traffic",
      "traffic.monthly_visits",
      "data.monthly_web_traffic",
      "company.monthly_web_traffic",
      "company.monthly_visits",
      "organization.monthly_visits",
    ])
      ?? getFirstNumericByPaths(companyNode, ["monthly_web_traffic", "monthly_visits", "traffic.monthly_visits"])
      ?? getFirstNumericFromRecords(contactRows, ["monthly_web_traffic", "monthly_visits", "web_traffic", "traffic"]),
    estimated_monthly_ad_spend: getFirstNumericByPaths(root, [
      "estimated_monthly_ad_spend",
      "estimated_ad_spend",
      "ad_spend",
      "ads.monthly_spend",
      "company.estimated_monthly_ad_spend",
    ]),
    traffic_geography: getFirstByPaths(root, [
      "traffic_geography",
      "geography",
      "geo_distribution",
      "traffic.geography",
      "company.traffic_geography",
      "organization.traffic_geography",
    ]) || getFirstByPaths(companyNode, ["traffic_geography", "geography", "traffic.geography"]) || {},
    review_count: getFirstNumericByPaths(root, [
      "review_count",
      "reviews.count",
      "company.review_count",
      "company.reviews.count",
    ]),
    payment_related_complaints: getFirstNumericByPaths(root, [
      "payment_related_complaints",
      "reviews.payment_related_complaints",
      "company.payment_related_complaints",
    ]),
    checkout_related_complaints: getFirstNumericByPaths(root, [
      "checkout_related_complaints",
      "reviews.checkout_related_complaints",
      "company.checkout_related_complaints",
    ]),
  };

  return {
    ownership: null,
    hiring: parseHiringEnvelope(normalizedPayload, sourceId),
    reputation: parseReputationEnvelope(normalizedPayload, sourceId),
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: parseTechEnvelope(normalizedPayload, sourceId),
  };
}

function parsePhantomBusterSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const exportRows = asObjectArray(collectArraysFromPaths(root, [
    "data",
    "results",
    "records",
    "rows",
    "items",
    "output",
    "output.rows",
    "output.items",
    "result.rows",
    "result.items",
    "data.results",
    "data.rows",
    "data.items",
    "response.results",
    "response.rows",
    "response.items",
  ]));

  const jobs = exportRows
    .map((row) => ({ title: extractRoleTitleFromRecord(row) }))
    .filter((row) => row.title);

  const technologies = uniqueStrings([
    ...splitDelimitedTextValues(getFirstArrayByPaths(root, [
      "technologies",
      "tech_stack",
      "stack",
      "tools",
      "data.technologies",
      "data.tech_stack",
      "result.technologies",
    ])),
    ...splitDelimitedTextValues([
      getFirstByPaths(root, ["technology", "tech", "tooling", "result.technology", "data.technology"]),
    ]),
    ...exportRows.flatMap((row) => splitDelimitedTextValues([
      row?.technologies,
      row?.technology,
      row?.tech,
      row?.tech_stack,
      row?.stack,
      row?.tools,
    ])),
  ]);

  const normalizedPayload = {
    jobs,
    open_roles: getFirstNumericByPaths(root, [
      "open_roles",
      "jobs_open",
      "vacancies",
      "active_jobs",
      "metadata.open_roles",
      "summary.open_roles",
    ]) ?? (jobs.length > 0 ? jobs.length : null),
    technologies,
    monthly_web_traffic: getFirstNumericByPaths(root, [
      "monthly_web_traffic",
      "monthly_visits",
      "traffic.monthly_visits",
      "website.monthly_visits",
      "website_traffic.monthly_visits",
      "metrics.monthly_web_traffic",
      "data.monthly_web_traffic",
      "data.website.monthly_visits",
    ]) ?? getFirstNumericFromRecords(exportRows, [
      "monthly_web_traffic",
      "monthly_visits",
      "web_traffic",
      "traffic",
      "website_traffic",
    ]),
    estimated_monthly_ad_spend: getFirstNumericByPaths(root, [
      "estimated_monthly_ad_spend",
      "estimated_ad_spend",
      "ad_spend",
      "ads.monthly_spend",
      "marketing.estimated_monthly_ad_spend",
      "data.estimated_monthly_ad_spend",
    ]),
    traffic_geography: getFirstByPaths(root, [
      "traffic_geography",
      "geography",
      "geo_distribution",
      "traffic.geography",
      "website_traffic.geography",
      "data.traffic_geography",
    ]) || {},
    review_count: getFirstNumericByPaths(root, ["review_count", "reviews.count", "data.review_count"]),
    payment_related_complaints: getFirstNumericByPaths(root, ["payment_related_complaints", "reviews.payment_related_complaints"]),
    checkout_related_complaints: getFirstNumericByPaths(root, ["checkout_related_complaints", "reviews.checkout_related_complaints"]),
  };

  return {
    ownership: null,
    hiring: parseHiringEnvelope(normalizedPayload, sourceId),
    reputation: parseReputationEnvelope(normalizedPayload, sourceId),
    marketing: parseMarketingEnvelope(normalizedPayload, sourceId),
    tech: parseTechEnvelope(normalizedPayload, sourceId),
  };
}

function decodeXmlEntities(value) {
  const text = String(value || "");
  const replacedNamed = text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");

  return replacedNamed
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function normalizeXmlNamespaces(value) {
  return String(value || "").replace(/<(\/?)(([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+))/g, "<$1$4");
}

function stripXmlMarkup(value) {
  const text = String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeXmlEntities(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function collectXmlBlocks(xml, tagName) {
  const blocks = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  let match = pattern.exec(xml);
  while (match) {
    blocks.push(match[0]);
    match = pattern.exec(xml);
  }
  return blocks;
}

function readXmlTagValue(xml, tagNames) {
  for (const tagName of tagNames || []) {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = pattern.exec(xml);
    if (match?.[1]) {
      const normalized = stripXmlMarkup(match[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function readXmlLinkValue(xml) {
  const hrefMatch = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i.exec(xml);
  if (hrefMatch?.[1]) {
    const normalized = String(hrefMatch[1] || "").trim();
    if (normalized) return normalized;
  }
  return readXmlTagValue(xml, ["link"]);
}

function parseStatusFeedEntriesFromRawText(rawText) {
  const xml = normalizeXmlNamespaces(rawText);
  const channelBlock = collectXmlBlocks(xml, "channel")[0] || xml;
  const itemBlocks = collectXmlBlocks(xml, "item");
  const entryBlocks = collectXmlBlocks(xml, "entry");
  const rows = itemBlocks.length > 0 ? itemBlocks : entryBlocks;

  const entries = rows.map((row) => ({
    title: readXmlTagValue(row, ["title"]),
    summary: readXmlTagValue(row, ["description", "summary", "content", "encoded"]),
    published_at: readXmlTagValue(row, ["pubDate", "published", "updated", "created"]),
    link: readXmlLinkValue(row),
  })).filter((entry) => entry.title || entry.summary);

  return {
    feed_title: readXmlTagValue(channelBlock, ["title", "generator"]),
    feed_url: readXmlLinkValue(channelBlock),
    entries,
  };
}

function classifyStatusFeedEntry(text, statusToken = "", resolvedAt = null) {
  return evaluateStatusIncident({
    statusToken,
    text,
    resolvedAt,
  });
}

function parseStatusFeedSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const objectEntries = asObjectArray(getFirstArrayByPaths(root, ["entries", "items", "feed.entries", "feed.items"])).map((entry) => ({
    title: readStringField(entry, ["title", "name"]),
    summary: readStringField(entry, ["summary", "description", "content", "body"]),
    status: readStringField(entry, ["status", "state", "severity", "impact"]),
    resolved_at: readStringField(entry, ["resolved_at", "resolvedAt", "resolved"]),
    published_at: readStringField(entry, ["published_at", "published", "updated", "created_at", "pubDate"]),
    link: readStringField(entry, ["url", "link"]),
  })).filter((entry) => entry.title || entry.summary);

  const rawText = readStringField(payload || {}, ["raw_text"]) || readStringField(root || {}, ["raw_text"]);
  const parsedXml = rawText ? parseStatusFeedEntriesFromRawText(rawText) : { feed_title: null, feed_url: null, entries: [] };

  const entries = objectEntries.length > 0 ? objectEntries : parsedXml.entries;
  if (entries.length === 0) {
    return {
      ownership: null,
      hiring: null,
      reputation: null,
      marketing: null,
      tech: null,
    };
  }

  const feedTitle = readStringField(root || {}, ["title", "feed_title", "name"]) || parsedXml.feed_title;
  const feedUrl = readStringField(root || {}, ["url", "feed_url", "link"]) || parsedXml.feed_url;

  const paymentPattern = /\b(payment|payments|merchant|acquir|gateway|processor|psp|card|transaction|settlement|payout)\b/i;
  const checkoutPattern = /\b(checkout|cart|basket|3ds|3-d\s*secure|authoris|hosted\s*payment\s*page)\b/i;

  let openEntries = 0;
  let majorOpenEntries = 0;
  let paymentEntryCount = 0;
  let checkoutEntryCount = 0;
  let recentIncidentAt = null;
  let recentOpenIncidentAt = null;

  for (const entry of entries) {
    const text = `${entry?.title || ""} ${entry?.summary || ""}`.trim();
    if (!text) continue;

    const incidentAt = latestIsoTimestamp([
      entry?.published_at,
      entry?.updated_at,
      entry?.created_at,
    ]);
    recentIncidentAt = latestIsoTimestamp([recentIncidentAt, incidentAt]);

    const classification = classifyStatusFeedEntry(text, entry?.status || "", entry?.resolved_at || null);
    if (classification.is_open) {
      openEntries += 1;
      recentOpenIncidentAt = latestIsoTimestamp([recentOpenIncidentAt, incidentAt]);
    }
    if (classification.is_major) majorOpenEntries += 1;
    if (paymentPattern.test(text)) paymentEntryCount += 1;
    if (checkoutPattern.test(text)) checkoutEntryCount += 1;
  }

  const nowIso = new Date().toISOString();
  const evidence = [];
  evidence.push(`Status feed entries parsed: ${entries.length}`);
  if (openEntries > 0) {
    evidence.push(`${openEntries} potentially open incident update${openEntries === 1 ? "" : "s"}`);
  }
  if (majorOpenEntries > 0) {
    evidence.push(`${majorOpenEntries} major/critical status update${majorOpenEntries === 1 ? "" : "s"}`);
  }

  const sampleTitles = entries
    .map((entry) => String(entry?.title || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (sampleTitles.length > 0) {
    evidence.push(`Feed sample: ${sampleTitles.join("; ")}`);
  }

  let reputationEnvelope = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    status_feed_name: feedTitle || null,
    status_feed_url: feedUrl || null,
    status_feed_entries_total: entries.length,
    status_feed_entries_open: openEntries,
    status_feed_entries_major: majorOpenEntries,
    status_incidents_total: entries.length,
    status_incidents_open: openEntries,
    status_major_incidents_open: majorOpenEntries,
    status_degraded_components: 0,
    status_recent_incident_at: recentIncidentAt,
    status_recent_open_incident_at: recentOpenIncidentAt,
    evidence,
    confidence: openEntries > 0 ? "high" : "medium",
    confidence_score: Math.round(Math.min(0.3 + (entries.length * 0.03) + (openEntries * 0.08), 0.85) * 100) / 100,
  };
  reputationEnvelope = applyStatusHealthNormalization(reputationEnvelope);

  if (paymentEntryCount > 0) {
    reputationEnvelope.payment_related_complaints = paymentEntryCount;
  }
  if (checkoutEntryCount > 0) {
    reputationEnvelope.checkout_related_complaints = checkoutEntryCount;
  }

  return {
    ownership: null,
    hiring: null,
    reputation: reputationEnvelope,
    marketing: null,
    tech: null,
  };
}

function parseStatusApiSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const incidentRows = asObjectArray(collectArraysFromPaths(root, [
    "incidents",
    "active_incidents",
    "activeIncidents",
    "events",
    "issues",
    "outages",
    "data.incidents",
    "data.active_incidents",
    "data.activeIncidents",
    "data.events",
    "summary.incidents",
    "summary.active_incidents",
    "summary.activeIncidents",
    "status.incidents",
    "status.active_incidents",
    "status.activeIncidents",
  ]));
  const componentRows = asObjectArray(collectArraysFromPaths(root, [
    "components",
    "page.components",
    "services",
    "systems",
    "data.components",
    "summary.components",
    "status.components",
  ]));

  if (incidentRows.length === 0 && componentRows.length === 0) {
    return {
      ownership: null,
      hiring: null,
      reputation: null,
      marketing: null,
      tech: null,
    };
  }

  const paymentPattern = /\b(payment|payments|merchant|acquir|gateway|processor|psp|card|transaction|settlement|payout)\b/i;
  const checkoutPattern = /\b(checkout|cart|basket|3ds|3-d\s*secure|authoris|hosted\s*payment\s*page)\b/i;

  let openIncidents = 0;
  let majorOpenIncidents = 0;
  let paymentIncidentCount = 0;
  let checkoutIncidentCount = 0;
  let recentIncidentAt = null;
  let recentOpenIncidentAt = null;

  for (const incident of incidentRows) {
    const title = readStringField(incident, ["name", "title", "summary", "message", "incident_name"]) || "";
    const body = readStringField(incident, ["description", "body", "content", "detail", "message"]) || "";
    const statusToken = readStringField(incident, ["status", "state", "phase", "current_status", "incident_status", "human_status", "status_name"]) || "";
    const impactToken = readStringField(incident, ["severity", "impact", "priority", "level", "impact_level", "status_name", "human_status"]) || "";
    const incidentAt = latestIsoTimestamp([
      readStringField(incident, ["updated_at", "updatedAt", "occurred_at", "occurredAt", "created_at", "createdAt", "started_at", "startedAt", "published_at", "published", "pubDate"]),
    ]);
    recentIncidentAt = latestIsoTimestamp([recentIncidentAt, incidentAt]);
    const text = `${title} ${body} ${statusToken}`.trim();
    if (!text) continue;

    const classification = evaluateStatusIncident({
      statusToken,
      impactToken,
      text,
      resolvedAt: readStringField(incident, ["resolved_at", "resolvedAt", "resolved", "ended_at", "fixed_at"]),
    });

    if (classification.is_open) {
      openIncidents += 1;
      recentOpenIncidentAt = latestIsoTimestamp([recentOpenIncidentAt, incidentAt]);
    }
    if (classification.is_major) majorOpenIncidents += 1;
    if (paymentPattern.test(text)) paymentIncidentCount += 1;
    if (checkoutPattern.test(text)) checkoutIncidentCount += 1;
  }

  const degradedComponents = componentRows.filter((component) => {
    const statusToken = String(
      readStringField(component, ["status", "state", "health", "level", "indicator"]) || ""
    ).toLowerCase();
    if (!statusToken) return false;

    const degraded = /\b(degraded|partial|major|outage|down|critical|incident|disrupt|unhealthy|red)\b/i.test(statusToken);
    const healthy = /\b(operational|up|healthy|ok|available|normal|green)\b/i.test(statusToken);
    return degraded || !healthy;
  });

  const nowIso = new Date().toISOString();
  const pageMetadata = getByPath(root, "page") || {};
  const evidence = [];
  evidence.push(`Status API incidents parsed: ${incidentRows.length}`);
  if (openIncidents > 0) {
    evidence.push(`${openIncidents} potentially open incident${openIncidents === 1 ? "" : "s"}`);
  }
  if (majorOpenIncidents > 0) {
    evidence.push(`${majorOpenIncidents} major/critical incident${majorOpenIncidents === 1 ? "" : "s"}`);
  }
  if (degradedComponents.length > 0) {
    evidence.push(`${degradedComponents.length} degraded component${degradedComponents.length === 1 ? "" : "s"}`);
  }

  const sampleTitles = incidentRows
    .map((incident) => readStringField(incident, ["name", "title", "summary"]))
    .filter(Boolean)
    .slice(0, 3);
  if (sampleTitles.length > 0) {
    evidence.push(`Incident sample: ${sampleTitles.join("; ")}`);
  }

  let reputationEnvelope = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    status_api_name: readStringField(root || {}, ["name", "title", "service_name", "status_page_name"]) || readStringField(pageMetadata, ["name", "title"]) || null,
    status_api_url: readStringField(root || {}, ["url", "status_url", "status_page_url", "link"]) || readStringField(pageMetadata, ["url", "link"]) || null,
    status_incidents_total: incidentRows.length,
    status_incidents_open: openIncidents,
    status_major_incidents_open: majorOpenIncidents,
    status_degraded_components: degradedComponents.length,
    status_recent_incident_at: recentIncidentAt,
    status_recent_open_incident_at: recentOpenIncidentAt,
    evidence,
    confidence: openIncidents > 0 ? "high" : "medium",
    confidence_score: Math.round(Math.min(0.32 + (incidentRows.length * 0.03) + (openIncidents * 0.08), 0.85) * 100) / 100,
  };
  reputationEnvelope = applyStatusHealthNormalization(reputationEnvelope);

  if (paymentIncidentCount > 0) {
    reputationEnvelope.payment_related_complaints = paymentIncidentCount;
  }
  if (checkoutIncidentCount > 0) {
    reputationEnvelope.checkout_related_complaints = checkoutIncidentCount;
  }

  return {
    ownership: null,
    hiring: null,
    reputation: reputationEnvelope,
    marketing: null,
    tech: null,
  };
}

function parseStatusInstatusSpecificEnvelopes(payload, sourceId) {
  return parseStatusApiSpecificEnvelopes(payload, sourceId);
}

function parseStatusCachetSpecificEnvelopes(payload, sourceId) {
  const sourcePayload = payload && typeof payload === "object" ? payload : {};
  const root = normalizeConnectorPayloadRoot(sourcePayload);

  const topLevelDataRows = Array.isArray(sourcePayload?.data) ? sourcePayload.data : [];
  const nestedRows = asObjectArray(getFirstArrayByPaths(root, ["incidents", "results", "rows"]));
  const cachetRows = topLevelDataRows.length > 0 ? asObjectArray(topLevelDataRows) : nestedRows;

  const normalizedIncidents = cachetRows.map((row) => ({
    title: readStringField(row, ["name", "title", "message"]),
    description: readStringField(row, ["message", "description", "human_status", "status_name"]),
    status: readStringField(row, ["human_status", "status_name", "status", "state"]),
    severity: readStringField(row, ["severity", "impact", "priority", "status_name", "human_status"]),
    resolved_at: readStringField(row, ["resolved_at", "resolvedAt", "fixed_at", "ended_at"]),
    created_at: readStringField(row, ["created_at", "createdAt", "created"]),
    updated_at: readStringField(row, ["updated_at", "updatedAt", "updated"]),
  })).filter((row) => row.title || row.description);

  if (normalizedIncidents.length === 0) {
    return parseStatusApiSpecificEnvelopes(payload, sourceId);
  }

  const normalizedPayload = {
    name: readStringField(sourcePayload, ["name", "title", "service_name"]) || readStringField(sourcePayload?.page || {}, ["name", "title"]) || null,
    url: readStringField(sourcePayload, ["url", "link", "status_url"]) || readStringField(sourcePayload?.page || {}, ["url", "link"]) || null,
    incidents: normalizedIncidents,
    components: asObjectArray(getFirstArrayByPaths(sourcePayload, ["components", "page.components"])),
  };

  return parseStatusApiSpecificEnvelopes(normalizedPayload, sourceId);
}

function extractStatuspageIncidentText(incident) {
  const parts = [];
  const name = readStringField(incident, ["name", "title"]);
  if (name) parts.push(name);

  const updateRows = getFirstArrayByPaths(incident, ["incident_updates", "updates"]);
  for (const row of updateRows) {
    const body = readStringField(row, ["body", "text", "message"]);
    if (body) parts.push(body);
  }

  const componentRows = getFirstArrayByPaths(incident, ["components"]);
  for (const row of componentRows) {
    const componentName = readStringField(row, ["name"]);
    if (componentName) parts.push(componentName);
  }

  return parts.join(" ").trim();
}

function parseStatuspageSpecificEnvelopes(payload, sourceId) {
  const root = normalizeConnectorPayloadRoot(payload);
  const incidents = asObjectArray(getFirstArrayByPaths(root, ["incidents", "data.incidents", "summary.incidents"]));
  const components = asObjectArray(getFirstArrayByPaths(root, ["components", "data.components", "summary.components"]));

  if (incidents.length === 0 && components.length === 0) {
    return {
      ownership: null,
      hiring: null,
      reputation: null,
      marketing: null,
      tech: null,
    };
  }

  const classifiedIncidents = incidents.map((incident) => {
    const text = extractStatuspageIncidentText(incident);
    const incidentAt = latestIsoTimestamp([
      readStringField(incident, ["updated_at", "updatedAt", "created_at", "createdAt", "started_at", "startedAt"]),
    ]);
    const classification = evaluateStatusIncident({
      statusToken: readStringField(incident, ["status", "state", "phase"]),
      impactToken: readStringField(incident, ["impact", "severity", "priority", "level"]),
      text,
      resolvedAt: incident?.resolved_at,
    });
    return { incident, text, classification, incident_at: incidentAt };
  });

  const recentIncidentAt = latestIsoTimestamp(classifiedIncidents.map((row) => row.incident_at));
  const recentOpenIncidentAt = latestIsoTimestamp(
    classifiedIncidents
      .filter((row) => row.classification.is_open)
      .map((row) => row.incident_at)
  );

  const openIncidents = classifiedIncidents
    .filter((row) => row.classification.is_open)
    .map((row) => row.incident);

  const majorOpenIncidents = classifiedIncidents
    .filter((row) => row.classification.is_major)
    .map((row) => row.incident);

  const degradedComponents = components.filter((component) => {
    const status = String(component?.status || "").toLowerCase();
    return !!status && status !== "operational";
  });

  const paymentPattern = /\b(payment|payments|merchant|acquir|gateway|processor|psp|card|transaction|settlement|payout)\b/i;
  const checkoutPattern = /\b(checkout|cart|basket|3ds|3-d\s*secure|authoris|hosted\s*payment\s*page)\b/i;

  let paymentIncidentCount = 0;
  let checkoutIncidentCount = 0;

  for (const row of classifiedIncidents) {
    const text = row.text;
    if (!text) continue;
    if (paymentPattern.test(text)) paymentIncidentCount += 1;
    if (checkoutPattern.test(text)) checkoutIncidentCount += 1;
  }

  const nowIso = new Date().toISOString();
  const evidence = [];
  if (openIncidents.length > 0) {
    evidence.push(`${openIncidents.length} open incident${openIncidents.length === 1 ? "" : "s"} on status page`);
  }
  if (majorOpenIncidents.length > 0) {
    evidence.push(`${majorOpenIncidents.length} major/critical incident${majorOpenIncidents.length === 1 ? "" : "s"} currently open`);
  }
  if (degradedComponents.length > 0) {
    evidence.push(`${degradedComponents.length} degraded component${degradedComponents.length === 1 ? "" : "s"}`);
  }
  if (incidents.length > 0) {
    const names = incidents
      .map((incident) => readStringField(incident, ["name", "title"]))
      .filter(Boolean)
      .slice(0, 3);
    if (names.length > 0) {
      evidence.push(`Incident sample: ${names.join("; ")}`);
    }
  }
  if (evidence.length === 0) {
    evidence.push("Status page ingested successfully");
  }

  let reputationEnvelope = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: `${sourceId}_api`,
    status_page_name: readStringField(getByPath(root, "page") || {}, ["name"]) || null,
    status_page_url: readStringField(getByPath(root, "page") || {}, ["url"]) || null,
    status_incidents_total: incidents.length,
    status_incidents_open: openIncidents.length,
    status_major_incidents_open: majorOpenIncidents.length,
    status_degraded_components: degradedComponents.length,
    status_recent_incident_at: recentIncidentAt,
    status_recent_open_incident_at: recentOpenIncidentAt,
    evidence,
    confidence: openIncidents.length > 0 ? "high" : "medium",
    confidence_score: Math.round(Math.min(0.35 + (incidents.length * 0.04) + (openIncidents.length * 0.08), 0.85) * 100) / 100,
  };
  reputationEnvelope = applyStatusHealthNormalization(reputationEnvelope);

  if (paymentIncidentCount > 0) {
    reputationEnvelope.payment_related_complaints = paymentIncidentCount;
  }
  if (checkoutIncidentCount > 0) {
    reputationEnvelope.checkout_related_complaints = checkoutIncidentCount;
  }

  return {
    ownership: null,
    hiring: null,
    reputation: reputationEnvelope,
    marketing: null,
    tech: null,
  };
}

function parseSpecificConnectorEnvelopes(sourceId, payload) {
  switch (String(sourceId || "").toLowerCase()) {
    case "endole":
      return parseEndoleSpecificEnvelopes(payload, sourceId);
    case "opencorporates":
      return parseOpenCorporatesSpecificEnvelopes(payload, sourceId);
    case "prospeo":
      return parseProspeoSpecificEnvelopes(payload, sourceId);
    case "phantombuster":
      return parsePhantomBusterSpecificEnvelopes(payload, sourceId);
    case "similarweb":
      return parseSimilarwebSpecificEnvelopes(payload, sourceId);
    case "builtwith":
      return parseBuiltWithSpecificEnvelopes(payload, sourceId);
    case "adzuna":
      return parseAdzunaSpecificEnvelopes(payload, sourceId);
    case "crunchbase":
      return parseCrunchbaseSpecificEnvelopes(payload, sourceId);
    case "clearbit":
      return parseClearbitSpecificEnvelopes(payload, sourceId);
    case "statuspage":
      return parseStatuspageSpecificEnvelopes(payload, sourceId);
    case "status_feed":
      return parseStatusFeedSpecificEnvelopes(payload, sourceId);
    case "status_api":
      return parseStatusApiSpecificEnvelopes(payload, sourceId);
    case "status_instatus":
      return parseStatusInstatusSpecificEnvelopes(payload, sourceId);
    case "status_cachet":
      return parseStatusCachetSpecificEnvelopes(payload, sourceId);
    default:
      return {
        ownership: null,
        hiring: null,
        reputation: null,
        marketing: null,
        tech: null,
      };
  }
}

function coalesceEnvelope(primary, fallback, mergeType) {
  if (primary && fallback) {
    if (mergeType === "ownership") return mergeOwnershipEnvelope(fallback, primary);
    if (mergeType === "hiring") return mergeHiringEnvelope(fallback, primary);
    if (mergeType === "tech") return mergeTechEnvelope(fallback, primary);
    return mergeEnvelopeWithEvidence(fallback, primary, { scoreField: "confidence_score" });
  }
  return primary || fallback || null;
}

function parseConnectorEnvelopes(sourceId, payload) {
  const specific = parseSpecificConnectorEnvelopes(sourceId, payload);
  const generic = {
    ownership: parseOwnershipEnvelope(payload, sourceId),
    hiring: parseHiringEnvelope(payload, sourceId),
    reputation: parseReputationEnvelope(payload, sourceId),
    marketing: parseMarketingEnvelope(payload, sourceId),
    tech: parseTechEnvelope(payload, sourceId),
  };

  return {
    ownership: coalesceEnvelope(specific.ownership, generic.ownership, "ownership"),
    hiring: coalesceEnvelope(specific.hiring, generic.hiring, "hiring"),
    reputation: coalesceEnvelope(specific.reputation, generic.reputation, "reputation"),
    marketing: coalesceEnvelope(specific.marketing, generic.marketing, "marketing"),
    tech: coalesceEnvelope(specific.tech, generic.tech, "tech"),
  };
}

function mergeUniqueObjectsByName(primary = [], secondary = []) {
  const map = new Map();
  for (const item of [...primary, ...secondary]) {
    const name = String(item?.name || item?.role || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

function mergeOwnershipEnvelope(existing, incoming) {
  if (!existing || typeof existing !== "object") {
    return {
      ...incoming,
      external_sources: uniqueStrings([incoming.source]),
    };
  }

  const existingSource = String(existing.source || "").toLowerCase();
  const existingNonUk = toFiniteNumber(existing.non_uk_significant_corporate_controllers_count, 0);
  const incomingNonUk = toFiniteNumber(incoming.non_uk_significant_corporate_controllers_count, 0);

  if (existingSource.includes("companies_house") && existingNonUk >= incomingNonUk) {
    return {
      ...existing,
      external_sources: uniqueStrings([...(existing.external_sources || []), incoming.source]),
    };
  }

  return {
    ...existing,
    ...incoming,
    significant_corporate_controllers_count: Math.max(
      toFiniteNumber(existing.significant_corporate_controllers_count, 0),
      toFiniteNumber(incoming.significant_corporate_controllers_count, 0)
    ),
    non_uk_significant_corporate_controllers_count: Math.max(existingNonUk, incomingNonUk),
    significant_corporate_controllers: mergeUniqueObjectsByName(
      existing.significant_corporate_controllers,
      incoming.significant_corporate_controllers
    ).slice(0, 20),
    non_uk_significant_corporate_controllers: mergeUniqueObjectsByName(
      existing.non_uk_significant_corporate_controllers,
      incoming.non_uk_significant_corporate_controllers
    ).slice(0, 20),
    external_sources: uniqueStrings([existing.source, incoming.source, ...(existing.external_sources || [])]),
  };
}

function mergeRoleArray(existingRoles = [], incomingRoles = []) {
  return mergeUniqueObjectsByName(existingRoles, incomingRoles).slice(0, 40);
}

function mergeEnvelopeWithEvidence(existing, incoming, options = {}) {
  if (!existing || typeof existing !== "object") {
    return {
      ...incoming,
      external_sources: uniqueStrings([incoming.source]),
    };
  }

  const scoreField = options.scoreField || null;
  const result = {
    ...existing,
    ...incoming,
    external_sources: uniqueStrings([existing.source, incoming.source, ...(existing.external_sources || [])]),
  };

  if (scoreField) {
    result[scoreField] = Math.max(
      toFiniteNumber(existing[scoreField], 0),
      toFiniteNumber(incoming[scoreField], 0)
    );
  }

  if (Array.isArray(existing.evidence) || Array.isArray(incoming.evidence)) {
    result.evidence = uniqueStrings([...(existing.evidence || []), ...(incoming.evidence || [])]).slice(0, 30);
  }

  const hasStatusMetrics = [
    existing?.status_incidents_total,
    existing?.status_incidents_open,
    existing?.status_major_incidents_open,
    existing?.status_degraded_components,
    existing?.status_incident_weighted_open,
    existing?.status_incident_severity_score,
    existing?.status_recent_incident_at,
    existing?.status_recent_open_incident_at,
    existing?.status_recent_incident_age_days,
    existing?.status_incident_recency_multiplier,
    incoming?.status_incidents_total,
    incoming?.status_incidents_open,
    incoming?.status_major_incidents_open,
    incoming?.status_degraded_components,
    incoming?.status_incident_weighted_open,
    incoming?.status_incident_severity_score,
    incoming?.status_recent_incident_at,
    incoming?.status_recent_open_incident_at,
    incoming?.status_recent_incident_age_days,
    incoming?.status_incident_recency_multiplier,
  ].some((value) => value !== undefined && value !== null);

  if (hasStatusMetrics) {
    const severityMax = Math.max(
      toFiniteNumber(existing?.status_incident_severity_score, 0),
      toFiniteNumber(incoming?.status_incident_severity_score, 0)
    );

    const recentIncidentAt = latestIsoTimestamp([
      existing?.status_recent_incident_at,
      incoming?.status_recent_incident_at,
    ]);
    const recentOpenIncidentAt = latestIsoTimestamp([
      existing?.status_recent_open_incident_at,
      incoming?.status_recent_open_incident_at,
    ]);

    const existingAgeDays = Number(existing?.status_recent_incident_age_days);
    const incomingAgeDays = Number(incoming?.status_recent_incident_age_days);
    const recentIncidentAgeDays = Number.isFinite(existingAgeDays) && Number.isFinite(incomingAgeDays)
      ? Math.min(existingAgeDays, incomingAgeDays)
      : Number.isFinite(existingAgeDays)
        ? existingAgeDays
        : Number.isFinite(incomingAgeDays)
          ? incomingAgeDays
          : null;

    const normalized = normalizeStatusHealthMetrics({
      status_incidents_total: Math.max(
        toFiniteNumber(existing?.status_incidents_total, 0),
        toFiniteNumber(incoming?.status_incidents_total, 0)
      ),
      status_incidents_open: Math.max(
        toFiniteNumber(existing?.status_incidents_open, 0),
        toFiniteNumber(incoming?.status_incidents_open, 0)
      ),
      status_major_incidents_open: Math.max(
        toFiniteNumber(existing?.status_major_incidents_open, 0),
        toFiniteNumber(incoming?.status_major_incidents_open, 0)
      ),
      status_degraded_components: Math.max(
        toFiniteNumber(existing?.status_degraded_components, 0),
        toFiniteNumber(incoming?.status_degraded_components, 0)
      ),
      status_incident_weighted_open: Math.max(
        toFiniteNumber(existing?.status_incident_weighted_open, 0),
        toFiniteNumber(incoming?.status_incident_weighted_open, 0)
      ),
      status_incident_severity_score: severityMax,
      status_recent_incident_at: recentIncidentAt,
      status_recent_open_incident_at: recentOpenIncidentAt,
      status_recent_incident_age_days: recentIncidentAgeDays,
    });

    result.status_incidents_total = Math.max(
      toFiniteNumber(existing?.status_incidents_total, 0),
      toFiniteNumber(incoming?.status_incidents_total, 0)
    );
    result.status_incidents_open = Math.max(
      toFiniteNumber(existing?.status_incidents_open, 0),
      toFiniteNumber(incoming?.status_incidents_open, 0)
    );
    result.status_major_incidents_open = Math.max(
      toFiniteNumber(existing?.status_major_incidents_open, 0),
      toFiniteNumber(incoming?.status_major_incidents_open, 0)
    );
    result.status_degraded_components = Math.max(
      toFiniteNumber(existing?.status_degraded_components, 0),
      toFiniteNumber(incoming?.status_degraded_components, 0)
    );
    result.status_incident_weighted_open = normalized.status_incident_weighted_open;
    result.status_incident_severity_score = normalized.status_incident_severity_score;
    result.status_health_band = normalized.status_health_band;
    result.status_recent_incident_at = normalized.status_recent_incident_at;
    result.status_recent_open_incident_at = normalized.status_recent_open_incident_at;
    result.status_recent_incident_age_days = normalized.status_recent_incident_age_days;
    result.status_incident_recency_multiplier = normalized.status_incident_recency_multiplier;
  }

  return result;
}

function mergeHiringEnvelope(existing, incoming) {
  const merged = mergeEnvelopeWithEvidence(existing, incoming, { scoreField: "hiring_signal_score" });
  merged.total_open_roles = Math.max(
    toFiniteNumber(existing?.total_open_roles, 0),
    toFiniteNumber(incoming?.total_open_roles, 0)
  );
  merged.open_roles = mergeRoleArray(existing?.open_roles, incoming?.open_roles);
  merged.finance_roles_open = mergeRoleArray(existing?.finance_roles_open, incoming?.finance_roles_open);
  merged.treasury_roles_open = mergeRoleArray(existing?.treasury_roles_open, incoming?.treasury_roles_open);
  merged.international_roles_open = mergeRoleArray(existing?.international_roles_open, incoming?.international_roles_open);
  merged.ecommerce_roles_open = mergeRoleArray(existing?.ecommerce_roles_open, incoming?.ecommerce_roles_open);
  return merged;
}

function mergeTechEnvelope(existing, incoming) {
  const merged = mergeEnvelopeWithEvidence(existing, incoming, { scoreField: "confidence_score" });
  const technologies = uniqueStrings([
    ...(existing?.technologies || []),
    ...(existing?.detected_technologies || []),
    ...(incoming?.technologies || []),
    ...(incoming?.detected_technologies || []),
  ]).slice(0, 100);

  merged.technologies = technologies;
  merged.detected_technologies = technologies;
  merged.stack = technologies;
  merged.signal_count = technologies.length;
  return merged;
}

function persistMergedSetting(key, incoming, mergeFn) {
  if (!incoming) return false;
  const existing = getSetting(key, null);
  const merged = mergeFn(existing, incoming);
  setSetting(key, merged);
  return true;
}

export async function syncExternalSignals(input = {}) {
  const companyNumber = normalizeCompanyNumber(input.companyNumber || input.company_number);
  if (!companyNumber) {
    return {
      status: "invalid_input",
      updated: false,
      error: "company_number is required",
    };
  }

  const companyName = String(input.companyName || input.company_name || "").trim();
  const companyDomain = String(input.companyDomain || input.company_domain || "").trim().toLowerCase();
  const timeoutMs = Math.max(1000, Number.parseInt(String(input.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS);
  const enableStatusDiscovery = parseBooleanFlag(
    input.enableStatusDiscovery ?? input.enable_status_discovery,
    parseBooleanFlag(process.env.ENABLE_STATUS_URL_DISCOVERY, false)
  );
  const requestedConnectors = parseConnectorFilterInput(
    input.connectors ?? input.connectorIds ?? input.connector_ids ?? input.connector
  );
  const availableConnectorIds = CONNECTOR_DEFINITIONS.map((definition) => definition.id);
  const availableConnectorIdSet = new Set(availableConnectorIds);
  const unknownRequestedConnectors = requestedConnectors === null
    ? []
    : requestedConnectors.filter((id) => !availableConnectorIdSet.has(id));
  const connectorDefinitions = requestedConnectors === null
    ? CONNECTOR_DEFINITIONS
    : CONNECTOR_DEFINITIONS.filter((definition) => requestedConnectors.includes(definition.id));

  if (requestedConnectors !== null && connectorDefinitions.length === 0) {
    return {
      status: "invalid_input",
      updated: false,
      error: "valid connector id is required",
      requested_connectors: requestedConnectors,
      available_connectors: availableConnectorIds,
    };
  }

  const context = {
    company_number: companyNumber,
    company_name: companyName,
    company_name_encoded: encodeURIComponent(companyName),
    company_domain: companyDomain,
    company_domain_encoded: encodeURIComponent(companyDomain),
  };

  const runtimeStatuses = [];
  const enabled = [];

  for (const definition of connectorDefinitions) {
    const status = buildConnectorRuntimeStatus(definition, context, {
      enableStatusDiscovery,
    });
    runtimeStatuses.push(status);
    if (status.configured) {
      enabled.push(status);
    }
  }

  if (enabled.length === 0) {
    return {
      status: "no_connectors_configured",
      updated: false,
      company_number: companyNumber,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      status_url_discovery_enabled: enableStatusDiscovery,
      requested_connectors: requestedConnectors,
      ignored_connectors: unknownRequestedConnectors,
      connectors: runtimeStatuses,
      telemetry: {
        request_timeout_ms: timeoutMs,
        request_attempts_total: 0,
        retry_attempts_total: 0,
        connectors_with_retries: 0,
        timeout_failures: 0,
        http_failures: 0,
        request_failures: 0,
      },
    };
  }

  const connectorResults = [];
  let succeeded = 0;
  let failed = 0;
  let requestAttemptsTotal = 0;
  let retryAttemptsTotal = 0;
  let connectorsWithRetries = 0;
  let timeoutFailures = 0;
  let httpFailures = 0;
  let requestFailures = 0;
  const keysUpdated = new Set();
  const connectorDefinitionById = new Map(connectorDefinitions.map((definition) => [definition.id, definition]));

  for (const status of enabled) {
    const definition = connectorDefinitionById.get(status.id);
    if (!definition) continue;

    const fetched = await fetchConnectorPayload(definition, status.request_urls, timeoutMs, context);
    const requestAttempts = Math.max(0, Number(fetched?.attempt_count || 0));
    const retryAttempts = Math.max(0, Number(fetched?.retry_count || 0));

    requestAttemptsTotal += requestAttempts;
    retryAttemptsTotal += retryAttempts;
    if (retryAttempts > 0) connectorsWithRetries += 1;

    if (!fetched.ok) {
      failed += 1;
      const failureCategory = classifyConnectorFailure(fetched.status, fetched.error);

      if (failureCategory === "timeout") timeoutFailures += 1;
      if (failureCategory === "http_error") httpFailures += 1;
      if (failureCategory === "request_error") requestFailures += 1;

      connectorResults.push({
        id: status.id,
        ok: false,
        auto_discovery_active: status.auto_discovery_active === true,
        status: fetched.status,
        error: fetched.error,
        failure_category: failureCategory,
        request_url: fetched.request_url || null,
        request_method: fetched.request_method || null,
        attempted_urls: fetched.attempted_urls || [],
        request_attempts: requestAttempts,
        retry_attempts: retryAttempts,
        request_duration_ms: Number(fetched?.request_duration_ms || 0),
        attempts: Array.isArray(fetched?.attempts) ? fetched.attempts : [],
      });
      continue;
    }

    succeeded += 1;
    const payload = fetched.payload || {};

    setSetting(`external_signal_${status.id}_${companyNumber}`, {
      updated_at: new Date().toISOString(),
      source: `${status.id}_api_raw`,
      request_url: fetched.request_url || null,
      request_method: fetched.request_method || null,
      attempted_urls: fetched.attempted_urls || [],
      payload,
    });
    keysUpdated.add(`external_signal_${status.id}_${companyNumber}`);

    const parsed = parseConnectorEnvelopes(status.id, payload);
    const ownershipEnvelope = parsed.ownership;
    const hiringEnvelope = parsed.hiring;
    const reputationEnvelope = parsed.reputation;
    const marketingEnvelope = parsed.marketing;
    const techEnvelope = parsed.tech;

    if (persistMergedSetting(`ownership_${companyNumber}`, ownershipEnvelope, mergeOwnershipEnvelope)) {
      keysUpdated.add(`ownership_${companyNumber}`);
    }
    if (persistMergedSetting(`hiring_signals_${companyNumber}`, hiringEnvelope, mergeHiringEnvelope)) {
      keysUpdated.add(`hiring_signals_${companyNumber}`);
    }
    if (persistMergedSetting(`reputation_${companyNumber}`, reputationEnvelope, (existing, incoming) => mergeEnvelopeWithEvidence(existing, incoming, { scoreField: "confidence_score" }))) {
      keysUpdated.add(`reputation_${companyNumber}`);
    }
    if (persistMergedSetting(`marketing_intelligence_${companyNumber}`, marketingEnvelope, (existing, incoming) => mergeEnvelopeWithEvidence(existing, incoming, { scoreField: "confidence_score" }))) {
      keysUpdated.add(`marketing_intelligence_${companyNumber}`);
    }
    if (persistMergedSetting(`tech_stack_${companyNumber}`, techEnvelope, mergeTechEnvelope)) {
      keysUpdated.add(`tech_stack_${companyNumber}`);
    }

    connectorResults.push({
      id: status.id,
      ok: true,
      auto_discovery_active: status.auto_discovery_active === true,
      status: fetched.status,
      request_url: fetched.request_url || null,
      request_method: fetched.request_method || null,
      attempted_urls: fetched.attempted_urls || [],
      request_attempts: requestAttempts,
      retry_attempts: retryAttempts,
      failed_attempts_before_success: Number(fetched?.failed_attempt_count || 0),
      request_duration_ms: Number(fetched?.request_duration_ms || 0),
      attempts: Array.isArray(fetched?.attempts) ? fetched.attempts : [],
      ownership_updated: !!ownershipEnvelope,
      hiring_updated: !!hiringEnvelope,
      reputation_updated: !!reputationEnvelope,
      marketing_updated: !!marketingEnvelope,
      tech_updated: !!techEnvelope,
    });
  }

  const syncSummary = {
    updated_at: new Date().toISOString(),
    company_number: companyNumber,
    company_name: companyName || null,
    company_domain: companyDomain || null,
    status_url_discovery_enabled: enableStatusDiscovery,
    requested_connectors: requestedConnectors,
    ignored_connectors: unknownRequestedConnectors,
    attempted: enabled.length,
    succeeded,
    failed,
    telemetry: {
      request_timeout_ms: timeoutMs,
      request_attempts_total: requestAttemptsTotal,
      retry_attempts_total: retryAttemptsTotal,
      connectors_with_retries: connectorsWithRetries,
      timeout_failures: timeoutFailures,
      http_failures: httpFailures,
      request_failures: requestFailures,
    },
    connectors: connectorResults,
    keys_updated: [...keysUpdated],
  };

  setSetting(`external_signal_sync_${companyNumber}`, syncSummary);

  return {
    status: succeeded > 0 ? "updated" : "failed",
    updated: succeeded > 0,
    ...syncSummary,
  };
}
