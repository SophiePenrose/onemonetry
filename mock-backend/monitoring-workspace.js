import { getSupabaseReadConfig } from "./supabase-read-model.js";

const VIEWS = new Set(["alerts", "companies", "research", "closed_won"]);
const STATUSES = new Set(["all", "new", "reviewing", "qualified", "dismissed", "contacted"]);
const CUSTOMER_STATUSES = new Set(["all", "watchlist", "outside", "review"]);

function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function monitoringCompanyNumber(value) {
  const number = String(value || "").trim().toUpperCase().replace(/^CH-/, "");
  if (/^\d{1,8}$/.test(number)) return number.padStart(8, "0");
  if (/^[A-Z]{2}\d{6}$/.test(number)) return number;
  throw failure("invalid_company_number");
}

export function createMonitoringWorkspace({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const supabase = getSupabaseReadConfig(env);
  const bridgeUrl = String(env.DASHBOARD_BRIDGE_URL || "").trim();
  const bridgeKey = String(env.DASHBOARD_BRIDGE_KEY || "").trim();
  const bridgeConfigured = Boolean(bridgeUrl && bridgeKey);
  const configured = bridgeConfigured || Boolean(supabase.url && supabase.secretKey);

  async function call(action, rpc, args) {
    if (!configured) throw failure("monitoring_not_configured", 503);
    const url = bridgeConfigured ? bridgeUrl : new URL(`/rest/v1/rpc/${rpc}`, supabase.url);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bridgeConfigured ? { "x-dashboard-key": bridgeKey } : {
            apikey: supabase.secretKey, Authorization: `Bearer ${supabase.secretKey}`,
          }),
        },
        body: JSON.stringify(bridgeConfigured ? action : args),
        signal: AbortSignal.timeout(supabase.timeoutMs),
      });
    } catch {
      throw failure("monitoring_unreachable", 502);
    }
    if (!response.ok) {
      if (response.status === 409) throw failure("review_conflict", 409);
      if (response.status === 404) throw failure("record_not_found", 404);
      throw failure("monitoring_request_failed", 502);
    }
    let data;
    try { data = await response.json(); } catch { throw failure("monitoring_invalid_response", 502); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw failure("monitoring_invalid_response", 502);
    if (data.error === "conflict") throw failure("review_conflict", 409);
    if (data.error === "not_found") throw failure("record_not_found", 404);
    if (data.error) throw failure("monitoring_request_failed", 502);
    return data;
  }

  async function read(query = {}) {
    const view = query.view || "alerts";
    const search = String(query.search || "").trim();
    const status = query.status || "all";
    const offset = Number(query.offset || 0);
    if (!VIEWS.has(view) || search.length > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      throw failure("invalid_monitoring_filters");
    }
    if (!(view === "closed_won" ? CUSTOMER_STATUSES : STATUSES).has(status)) throw failure("invalid_monitoring_filters");
    if (view === "research") {
      const data = await call({ action: "research" }, "dashboard_research", {});
      if (!Array.isArray(data.rows)) throw failure("monitoring_invalid_response", 502);
      const rows = data.rows.filter(row => !search || [row.company_name, row.company_number, row.headline, row.customer_name].some(value => String(value || "").toLowerCase().includes(search.toLowerCase())));
      return { ...data, rows: rows.slice(offset, offset + 50), total: rows.length, page_size: 50, offset };
    }
    const data = await call({ action: "read", view, search, status, offset },
      view === "closed_won" ? "dashboard_closed_won" : "dashboard_read",
      { ...(view === "closed_won" ? {} : { p_view: view }), p_search: search, p_status: status, p_offset: offset });
    if (!Array.isArray(data.rows) || !Number.isFinite(data.total)) throw failure("monitoring_invalid_response", 502);
    return data;
  }

  async function getCompany(number) {
    const normalized = monitoringCompanyNumber(number);
    const result = await read({ view: "companies", search: normalized });
    const company = result.rows.find(row => row.company_number === normalized);
    if (!company) throw failure("company_not_in_watchlist", 404);
    const customers = await read({ view: "closed_won", search: normalized });
    const customerMatches = customers.rows.filter(row => row.selected_company_number === normalized).map(row => ({
      closed_won_id: row.closed_won_id, account_name: row.account_name,
      match_method: row.match_method, crm_identity_independently_verified: row.crm_identity_independently_verified,
    }));
    return { ...company, customer_matches: customerMatches };
  }

  async function review(input, actor) {
    if (!actor?.id || !actor?.email) throw failure("monitoring_reviewer_not_configured", 403);
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.alert_id || "") ||
      !["reviewing", "qualified", "dismissed"].includes(input.status) || !note || note.length > 3000 ||
      typeof input.expected_updated_at !== "string" || !Number.isFinite(Date.parse(input.expected_updated_at))) {
      throw failure("invalid_monitoring_review");
    }
    return call({ action: "review", alert_id: input.alert_id, status: input.status, note,
      expected_updated_at: input.expected_updated_at, reviewer_id: actor.id, reviewer_email: actor.email },
    "dashboard_review_alert", { p_alert_id: input.alert_id, p_status: input.status, p_note: note,
      p_expected_updated_at: input.expected_updated_at, p_reviewer_id: actor.id, p_reviewer_email: actor.email });
  }

  return { configured, read, getCompany, review };
}

// This describes research readiness, never an outreach approval or a product-fit score.
export function monitoringReadiness(company, local = {}) {
  const raw = company.turnover_gbp;
  const turnover = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  const scope = !Number.isFinite(turnover) ? "turnover_unknown" : turnover < 30000000 ? "below_floor" : "in_scope";
  return { ...local, turnover_scope: scope, outreach_approved: false };
}
