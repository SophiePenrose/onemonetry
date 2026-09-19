import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMonitoringWorkspace, monitoringCompanyNumber, monitoringReadiness } from "../monitoring-workspace.js";
import { createMonitoringResearch } from "../monitoring-research.js";

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "secret-test" };
const alert = { alert_id: "00000000-0000-0000-0000-000000000001", status: "qualified", note: "Evidence reviewed; research fit next.", expected_updated_at: "2026-09-19T09:00:00Z" };
describe("Monitoring source contract", () => {
  it("preserves leading zeros and Scottish company identities", () => {
    assert.equal(monitoringCompanyNumber("123456"), "00123456");
    assert.equal(monitoringCompanyNumber("ch-sc123456"), "SC123456");
    assert.throws(() => monitoringCompanyNumber("00123456,other"));
  });
  it("uses the existing evidence-rich dashboard RPC, preserving provenance and review history", async () => {
    const calls = [];
    const expected = { total: 1, rows: [{ company_number: "00123456", officer_name: "Example Director", source_url: "https://example.com/source", reviews: [{ note: "Check role" }] }] };
    const model = createMonitoringWorkspace({ env, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return Response.json(expected); } });
    assert.deepEqual(await model.read({ view: "alerts", search: "00123456", status: "new" }), expected);
    assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/rpc/dashboard_read");
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_view: "alerts", p_search: "00123456", p_status: "new", p_offset: 0 });
    await assert.rejects(model.read({ view: "secrets" }), { code: "invalid_monitoring_filters" });
    assert.equal(calls.length, 1);
  });
  it("supports the scoped bridge without a Supabase service key", async () => {
    const model = createMonitoringWorkspace({ env: { DASHBOARD_BRIDGE_URL: "https://example.com/bridge", DASHBOARD_BRIDGE_KEY: "bridge-test" }, fetchImpl: async (url, options) => {
      assert.equal(options.headers["x-dashboard-key"], "bridge-test");
      assert.equal(options.headers.apikey, undefined);
      assert.deepEqual(JSON.parse(options.body), { action: "read", view: "closed_won", search: "", status: "review", offset: 0 });
      return Response.json({ rows: [], total: 0 });
    } });
    await model.read({ view: "closed_won", status: "review" });
  });
  it("filters and paginates research enquiries without treating names as confirmed identities", async () => {
    const model = createMonitoringWorkspace({ env, fetchImpl: async () => Response.json({ rows: Array.from({ length: 61 }, (_, i) => ({ enquiry_id: String(i), headline: "Acquisition hypothesis", company_number: null, uncertainty: "Confirm identity" })) }) });
    const data = await model.read({ view: "research", search: "hypothesis", offset: 50 });
    assert.equal(data.total, 61); assert.equal(data.rows.length, 11); assert.equal(data.rows[0].company_number, null);
  });
  it("never substitutes the first fuzzy search match for the requested company", async () => {
    const model = createMonitoringWorkspace({ env, fetchImpl: async () => Response.json({ total: 1, rows: [{ company_number: "99123456" }] }) });
    await assert.rejects(model.getCompany("00123456"), { code: "company_not_in_watchlist" });
  });
  it("carries exact past-customer matches into research without copying applicant contact data", async () => {
    const model = createMonitoringWorkspace({ env, fetchImpl: async (url) => Response.json(String(url).endsWith("dashboard_closed_won")
      ? { total: 2, rows: [{ selected_company_number: "00123456", closed_won_id: "customer-1", account_name: "Example", applicants: [{ email: "private@example.test" }] }, { selected_company_number: "99999999", closed_won_id: "other" }] }
      : { total: 1, rows: [{ company_number: "00123456", company_name: "Example" }] }) });
    const company = await model.getCompany("123456");
    assert.equal(company.customer_matches.length, 1);
    assert.equal(company.customer_matches[0].closed_won_id, "customer-1");
    assert.equal(company.customer_matches[0].applicants, undefined);
  });
  it("requires a note and trusted reviewer, and reports a stale review without retrying", async () => {
    let calls = 0;
    const model = createMonitoringWorkspace({ env, fetchImpl: async (_url, options) => {
      calls++; const payload = JSON.parse(options.body);
      assert.equal(payload.p_reviewer_email, "owner@example.test");
      return Response.json({ error: "conflict" });
    } });
    const actor = { id: "owner", email: "owner@example.test" };
    await assert.rejects(model.review(alert, null), { code: "monitoring_reviewer_not_configured" });
    await assert.rejects(model.review({ ...alert, note: " " }, actor), { code: "invalid_monitoring_review" });
    await assert.rejects(model.review({ ...alert, reviewer_email: "forged@example.test" }, actor), { code: "review_conflict" });
    assert.equal(calls, 1);
  });
  it("fails explicitly when disconnected, malformed or unconfigured rather than showing an empty inbox", async () => {
    await assert.rejects(createMonitoringWorkspace({ env: {} }).read(), { code: "monitoring_not_configured" });
    await assert.rejects(createMonitoringWorkspace({ env, fetchImpl: async () => { throw Error("secret connection detail"); } }).read(), { code: "monitoring_unreachable" });
    await assert.rejects(createMonitoringWorkspace({ env, fetchImpl: async () => Response.json({ wrong: [] }) }).read(), { code: "monitoring_invalid_response" });
  });
  it("keeps unknown turnover distinct from zero and never derives outreach approval from an alert", () => {
    assert.equal(monitoringReadiness({ turnover_gbp: null }).turnover_scope, "turnover_unknown");
    assert.equal(monitoringReadiness({ turnover_gbp: 29999999 }).turnover_scope, "below_floor");
    assert.equal(monitoringReadiness({ turnover_gbp: 30000000, status: "qualified" }).outreach_approved, false);
  });
});

function fixture() {
  const monitor = new Map(), settings = new Map(), companies = [], scores = new Map(), restricted = new Set();
  const service = createMonitoringResearch({ normalizeCompanyNumber: monitoringCompanyNumber, loadCompanies: () => companies,
    getMonitoredCompany: number => monitor.get(number), getCompanyState: () => ({ state: "held_for_review" }),
    isSuppressed: (_id, number) => ({ suppressed: restricted.has(number) }), getStoredScore: number => scores.get(number),
    upsertMonitoredCompany: company => monitor.set(company.company_number, company), setSetting: (k, v) => settings.set(k, v), getSetting: (k, fallback) => settings.get(k) ?? fallback,
    getTurnoverThreshold: () => 30000000, getTurnoverMaxThreshold: () => 200000000,
  });
  return { service, monitor, settings, companies, scores, restricted };
}
describe("Company research handoff", () => {
  const company = { company_number: "00123456", company_name: "Example Limited", turnover_gbp: 50000000 };
  it("is idempotent and keeps a new research candidate outside weekly outreach", () => {
    const f = fixture();
    assert.equal(f.service.addToResearch(company).created, true);
    assert.equal(f.service.addToResearch(company).created, false);
    assert.equal(f.monitor.size, 1);
    assert.equal(f.monitor.get(company.company_number).status, "research");
    assert.equal(f.settings.get("monitoring_context_00123456").source, "supabase");
    assert.equal(f.scores.size, 0);
  });
  it("reuses a legacy company ID and preserves local facts, scores and held state", () => {
    const f = fixture(); f.companies.push({ id: "c123", company_number: "00123456", turnover: 90000000 });
    f.scores.set(company.company_number, { composite_score: .7 }); f.restricted.add(company.company_number);
    assert.equal(f.service.addToResearch(company).company_id, "c123");
    assert.equal(f.monitor.size, 0); assert.equal(f.companies[0].turnover, 90000000);
    assert.deepEqual(f.scores.get(company.company_number), { composite_score: .7 });
    assert.equal(f.service.localContext(company.company_number).workflow_state, "held_for_review");
    assert.equal(f.service.localContext(company.company_number).suppressed, true);
  });
  it("blocks shortlist promotion until existing fit, turnover and suppression checks pass", () => {
    const f = fixture(); const n = company.company_number; f.service.addToResearch(company);
    assert.throws(() => f.service.addToShortlist(n), { code: "product_fit_research_required" });
    f.scores.set(n, { confidence: { product_fit_gate: .8 } });
    assert.throws(() => f.service.addToShortlist(n), { code: "product_fit_research_required" });
    f.scores.set(n, { confidence: { product_fit_gate: 1 } }); f.restricted.add(n);
    assert.throws(() => f.service.addToShortlist(n), { code: "company_suppressed" });
    f.restricted.clear(); f.monitor.get(n).latest_turnover = null;
    assert.throws(() => f.service.addToShortlist(n), { code: "company_outside_turnover_scope" });
    f.monitor.get(n).latest_turnover = 29999999;
    assert.throws(() => f.service.addToShortlist(n), { code: "company_outside_turnover_scope" });
    f.monitor.get(n).latest_turnover = 30000000;
    const result = f.service.addToShortlist(n);
    assert.equal(f.monitor.get(n).status, "active"); assert.equal(result.outreach_approved, false); assert.equal(result.crm_approved, false);
  });
  it("holds a source customer match even when the local exclusion registry has not caught up", () => {
    const f = fixture(); f.service.addToResearch({ ...company, customer_matches: [{ closed_won_id: "past-customer" }] });
    f.scores.set(company.company_number, { confidence: { product_fit_gate: 1 } });
    assert.equal(f.service.localContext(company.company_number).suppressed, true);
    assert.throws(() => f.service.addToShortlist(company.company_number), { code: "company_suppressed" });
  });
});
