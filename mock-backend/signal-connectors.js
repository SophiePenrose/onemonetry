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
    urlTemplateEnv: "OPENCORPORATES_URL_TEMPLATE",
    authHeaderEnv: "OPENCORPORATES_AUTH_HEADER",
    authSchemeEnv: "OPENCORPORATES_AUTH_SCHEME",
    purpose: "cross_jurisdiction_registry",
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

function normalizeCompanyNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
  if (/^\d{1,8}$/.test(stripped)) return stripped.padStart(8, "0");
  if (/^[A-Z0-9]{2,12}$/.test(stripped)) return stripped;
  return null;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function buildConnectorStatus(definition) {
  const keyStatus = (definition.keyEnvs || []).every((keyEnv) => hasConfiguredSecret(process.env[keyEnv]));
  const urlTemplate = connectorUrlTemplate(definition);

  return {
    id: definition.id,
    configured: keyStatus && !!urlTemplate,
    has_keys: keyStatus,
    has_url_template: !!urlTemplate,
    key_envs: definition.keyEnvs,
    url_template_env: definition.urlTemplateEnv,
    purpose: definition.purpose,
  };
}

export function getExternalSignalConnectorStatus() {
  return CONNECTOR_DEFINITIONS.map((definition) => buildConnectorStatus(definition));
}

async function fetchConnectorPayload(definition, context, timeoutMs) {
  const template = connectorUrlTemplate(definition);
  if (!template) {
    return {
      ok: false,
      status: null,
      error: "missing_url_template",
    };
  }

  const url = interpolateTemplate(template, context);
  if (!url) {
    return {
      ok: false,
      status: null,
      error: "empty_request_url",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...buildConnectorHeaders(definition),
      },
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
      return {
        ok: false,
        status: response.status,
        error: payload?.error || payload?.message || `http_${response.status}`,
        request_url: url,
        payload,
      };
    }

    return {
      ok: true,
      status: response.status,
      request_url: url,
      payload,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err?.name === "AbortError" ? "request_timeout" : (err?.message || "request_failed"),
      request_url: url,
    };
  } finally {
    clearTimeout(timer);
  }
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
  const objectPayload = payload && typeof payload === "object" ? payload : {};
  if (objectPayload.data && typeof objectPayload.data === "object") return objectPayload.data;
  if (objectPayload.result && typeof objectPayload.result === "object") return objectPayload.result;
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

  if (
    reviewCount === null
    && paymentComplaints === null
    && checkoutComplaints === null
  ) {
    return null;
  }

  const nowIso = new Date().toISOString();

  return {
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

function parseSpecificConnectorEnvelopes(sourceId, payload) {
  switch (String(sourceId || "").toLowerCase()) {
    case "endole":
      return parseEndoleSpecificEnvelopes(payload, sourceId);
    case "opencorporates":
      return parseOpenCorporatesSpecificEnvelopes(payload, sourceId);
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

  const context = {
    company_number: companyNumber,
    company_name: companyName,
    company_name_encoded: encodeURIComponent(companyName),
    company_domain: companyDomain,
    company_domain_encoded: encodeURIComponent(companyDomain),
  };

  const statuses = getExternalSignalConnectorStatus();
  const enabled = statuses.filter((status) => status.configured);

  if (enabled.length === 0) {
    return {
      status: "no_connectors_configured",
      updated: false,
      company_number: companyNumber,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      connectors: statuses,
    };
  }

  const connectorResults = [];
  let succeeded = 0;
  let failed = 0;
  const keysUpdated = new Set();

  for (const status of enabled) {
    const definition = CONNECTOR_DEFINITIONS.find((entry) => entry.id === status.id);
    if (!definition) continue;

    const fetched = await fetchConnectorPayload(definition, context, timeoutMs);

    if (!fetched.ok) {
      failed += 1;
      connectorResults.push({
        id: status.id,
        ok: false,
        status: fetched.status,
        error: fetched.error,
        request_url: fetched.request_url || null,
      });
      continue;
    }

    succeeded += 1;
    const payload = fetched.payload || {};

    setSetting(`external_signal_${status.id}_${companyNumber}`, {
      updated_at: new Date().toISOString(),
      source: `${status.id}_api_raw`,
      request_url: fetched.request_url || null,
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
      status: fetched.status,
      request_url: fetched.request_url || null,
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
    attempted: enabled.length,
    succeeded,
    failed,
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
