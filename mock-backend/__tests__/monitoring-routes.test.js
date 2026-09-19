import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createMonitoringRouter } from "../monitoring-routes.js";

describe("Monitoring HTTP boundary", () => {
  let server, base, saved, reviewed;
  const company = { company_number: "00123456", company_name: "Source Company", turnover_gbp: 45000000 };
  before(async () => {
    const app = express(); app.use(express.json());
    app.use("/api/monitoring", createMonitoringRouter({
      workspace: { configured: true, read: async () => ({ rows: [company], total: 1 }), getCompany: async () => company,
        review: async (body, actor) => { reviewed = actor; return { status: body.status }; } },
      localContext: () => ({ company_id: "legacy-123", suppressed: true }),
      addToResearch: row => { saved = row; return { company_id: "legacy-123" }; },
      addToShortlist: () => { throw Object.assign(new Error("private-detail"), { code: "product_fit_research_required", status: 409 }); },
      authenticateReviewer: req => req.headers["x-auth-token"] === "valid-session" ? { id: "owner", email: "owner@example.test" } : null,
    }));
    server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}/api/monitoring`;
  });
  after(async () => { await new Promise(resolve => server.close(resolve)); });
  it("returns source facts alongside local suppression without approving outreach", async () => {
    const result = await fetch(base); assert.equal(result.headers.get("cache-control"), "no-store");
    const data = await result.json();
    assert.equal(data.rows[0].workspace.suppressed, true); assert.equal(data.rows[0].workspace.company_id, "legacy-123");
    assert.equal(data.rows[0].workspace.outreach_approved, false); assert.equal(data.review_enabled, false);
  });
  it("discards forged company facts and approval on research handoff", async () => {
    const result = await fetch(`${base}/companies/00123456/research`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnover_gbp: 999999999, approved: true }) });
    assert.equal(result.status, 200); assert.deepEqual(saved, company);
    assert.equal((await result.json()).outreach_approved, false);
  });
  it("rejects unauthenticated review writes and uses the server actor for an authenticated request", async () => {
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "reviewing", reviewer_email: "forged@example.test" }) };
    assert.equal((await fetch(`${base}/reviews`, options)).status, 403);
    const response = await fetch(`${base}/reviews`, { ...options, headers: { ...options.headers, "x-auth-token": "valid-session" } });
    assert.equal(response.status, 200); assert.equal(reviewed.email, "owner@example.test");
  });
  it("rejects cross-site form writes and preserves shortlist gate errors", async () => {
    assert.equal((await fetch(`${base}/companies/00123456/research`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(`${base}/companies/00123456/research`, { method: "POST", headers: { "Content-Type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" })).status, 403);
    const result = await fetch(`${base}/companies/00123456/shortlist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(result.status, 409); assert.deepEqual(await result.json(), { error: "product_fit_research_required" });
  });
});
