const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

function configuredValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  if (lower.includes("replace_with") || lower.includes("your_") || lower === "changeme") return "";
  return normalized;
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeCompanyNumber(value) {
  return String(value || "").trim().toUpperCase();
}

export function getSupabaseReadConfig(env = process.env) {
  return {
    url: configuredValue(env.SUPABASE_URL),
    secretKey: configuredValue(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
    timeoutMs: parseInteger(env.SUPABASE_READ_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000, max: 60000 }),
  };
}

export function isSupabaseReadConfigured(env = process.env) {
  const config = getSupabaseReadConfig(env);
  return Boolean(config.url && config.secretKey);
}

export function createSupabaseReadModel({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getSupabaseReadConfig(env);

  function assertConfigured() {
    if (!config.url || !config.secretKey) {
      const error = new Error("Supabase read access is not configured");
      error.code = "supabase_not_configured";
      throw error;
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required");
    }
  }

  async function request(table, params, { offset = 0, limit = DEFAULT_PAGE_SIZE, count = false } = {}) {
    assertConfigured();
    const url = new URL(`/rest/v1/${table}`, config.url);
    for (const [key, value] of params.entries()) url.searchParams.append(key, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          apikey: config.secretKey,
          Authorization: `Bearer ${config.secretKey}`,
          Accept: "application/json",
          ...(count ? { Prefer: "count=exact" } : {}),
          Range: `${offset}-${offset + limit - 1}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`Supabase request failed (${response.status})`);
        error.code = "supabase_request_failed";
        error.status = response.status;
        error.detail = detail.slice(0, 500);
        throw error;
      }
      const rows = await response.json();
      const contentRange = response.headers.get("content-range") || "";
      const totalPart = contentRange.split("/")[1];
      return {
        rows: Array.isArray(rows) ? rows : [],
        total: totalPart && totalPart !== "*" ? Number.parseInt(totalPart, 10) : null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function listCompanies(query = {}) {
    const limit = parseInteger(query.limit, DEFAULT_PAGE_SIZE, { min: 1, max: MAX_PAGE_SIZE });
    const offset = parseInteger(query.offset, 0, { min: 0 });
    const params = new URLSearchParams({
      select: "company_number,current_name,company_status,company_type,jurisdiction,incorporation_date,sic_codes,registered_country,website_url,company_domain,turnover_gbp,group_name,watchlist_source,overseas_controlled,ultimate_parent_name,ultimate_parent_country,ownership_confidence,last_enriched_at,updated_at",
      order: "updated_at.desc,company_number.asc",
    });
    if (query.status) params.set("company_status", `eq.${String(query.status).trim()}`);
    if (query.enriched === "true") params.set("last_enriched_at", "not.is.null");
    if (query.enriched === "false") params.set("last_enriched_at", "is.null");
    if (query.search) params.set("current_name", `ilike.*${String(query.search).trim().replace(/[*,()]/g, "")}*`);

    const companiesResult = await request("companies", params, { offset, limit, count: true });
    const numbers = companiesResult.rows.map((row) => normalizeCompanyNumber(row.company_number)).filter(Boolean);
    let jobsByCompany = new Map();
    if (numbers.length > 0) {
      const jobsParams = new URLSearchParams({
        select: "company_number,status,attempts,last_error,completed_at,updated_at,research_priority",
        company_number: `in.(${numbers.join(",")})`,
      });
      const jobsResult = await request("enrichment_jobs", jobsParams, { limit: numbers.length });
      jobsByCompany = new Map(jobsResult.rows.map((job) => [normalizeCompanyNumber(job.company_number), job]));
    }

    return {
      companies: companiesResult.rows.map((company) => ({
        ...company,
        enrichment: jobsByCompany.get(normalizeCompanyNumber(company.company_number)) || null,
      })),
      meta: { total: companiesResult.total, showing: companiesResult.rows.length, limit, offset },
    };
  }

  async function listAlerts(query = {}) {
    const limit = parseInteger(query.limit, DEFAULT_PAGE_SIZE, { min: 1, max: MAX_PAGE_SIZE });
    const offset = parseInteger(query.offset, 0, { min: 0 });
    const params = new URLSearchParams({
      select: "alert_id,company_number,person_id,transaction_id,alert_type,score,reasons,status,created_at,updated_at",
      order: "created_at.desc",
    });
    if (query.status) params.set("status", `eq.${String(query.status).trim()}`);
    if (query.alert_type) params.set("alert_type", `eq.${String(query.alert_type).trim()}`);

    const alertsResult = await request("prospect_alerts", params, { offset, limit, count: true });
    const numbers = [...new Set(alertsResult.rows.map((row) => normalizeCompanyNumber(row.company_number)).filter(Boolean))];
    let companiesByNumber = new Map();
    if (numbers.length > 0) {
      const companyParams = new URLSearchParams({
        select: "company_number,current_name,company_status,turnover_gbp,company_domain,website_url",
        company_number: `in.(${numbers.join(",")})`,
      });
      const companiesResult = await request("companies", companyParams, { limit: numbers.length });
      companiesByNumber = new Map(companiesResult.rows.map((company) => [normalizeCompanyNumber(company.company_number), company]));
    }

    return {
      alerts: alertsResult.rows.map((alert) => ({
        ...alert,
        company: companiesByNumber.get(normalizeCompanyNumber(alert.company_number)) || null,
      })),
      meta: { total: alertsResult.total, showing: alertsResult.rows.length, limit, offset },
    };
  }

  async function getStatus() {
    if (!config.url || !config.secretKey) {
      return { configured: false, connected: false };
    }
    try {
      await request("companies", new URLSearchParams({ select: "company_number" }), { limit: 1 });
      return { configured: true, connected: true, project_url: config.url };
    } catch (error) {
      return { configured: true, connected: false, error: error.code || "supabase_connection_failed" };
    }
  }

  return { getStatus, listCompanies, listAlerts };
}

export const supabaseReadModel = createSupabaseReadModel();
