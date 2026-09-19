import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { normalizeContactCandidate } from "../contact-orchestration.js";
import { createOutreachReliability, createOutreachRouter, outreachWeekBounds } from "../outreach-reliability.js";
import { createOutreachDraftStore } from "../outreach-drafts.js";
const dir = mkdtempSync(path.join(tmpdir(), "outreach-reliability-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const data = await import("../db.js");
const db = data.default;
let clock = new Date("2026-09-19T12:00:00Z"), eligible = true;
const drafts = createOutreachDraftStore({ db, now: () => clock });
const service = createOutreachReliability({ db, draftStore: drafts, now: () => clock,
  resolveCompany: number => ({ eligible, reason: "company_suppressed_or_in_research", company_number: number, name: "Synthetic Ltd", turnover: 50000000, domain: "example.test", priority: 90 }),
  suppressed: data.isContactSuppressed, createBatch: data.createWeConnectExportBatch, getBatch: data.getWeConnectExportBatch, completeBatch: data.completeWeConnectApiImport,
});
function seed(count = 3, prefix = "first") {
  const contacts = Array.from({ length: count }, (_, i) => ({ person_id: `${prefix}-${i}`, full_name: `Synthetic ${i}`, company_number: String(10000000 + Math.floor(i / 3)),
    linkedin_url: `https://linkedin.com/in/${prefix}-${i}`, email: `${prefix}-${i}@example.test`, role: "Finance Director" }));
  const current = drafts.get();
  drafts.save({ week_start: current.week_start, expected_revision: current.revision, draft: { campaign_name: "Synthetic cadence",
    contacts, selected_company_numbers: [...new Set(contacts.map(c => c.company_number))], selected_contact_keys: contacts.map(c => c.person_id) } });
  return contacts;
}
function plan() { const d = drafts.get(); return service.makePlan({ week_start: d.week_start, draft_revision: d.revision, crm_confirmed: true }, "test-owner"); }
function reserve(p, mode = "manual") { return service.reserve({ plan_id: p.plan_id, campaign_name: "Synthetic cadence" }, mode); }
beforeEach(() => {
  for (const table of ["outreach_handoff_reviews", "outreach_handoffs", "outreach_crm_clearances", "outreach_reviewed_plans", "weekly_outreach_drafts", "we_connect_export_items", "we_connect_export_batches", "we_connect_webhook_events", "outreach_contact_stops", "outreach_contact_identities", "suppression_list"]) db.prepare(`DELETE FROM ${table}`).run();
  clock = new Date("2026-09-19T12:00:00Z"); eligible = true;
});
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("Authoritative outreach review and capacity", () => {
  it("preserves provider opt-outs through normalization before a draft is saved", () => {
    const candidate = normalizeContactCandidate({ name: "Synthetic", phone: "+442000000000", phone_dnc: true, do_not_email: "true", do_not_contact: true }, "apollo");
    assert.equal(candidate.phone_dnc, true); assert.equal(candidate.do_not_email, true); assert.equal(candidate.do_not_contact, true);
  });
  it("requires explicit CRM confirmation and saved revision; ignores forged lists and caps", () => {
    seed(); assert.throws(() => service.makePlan({ contacts: [], crm_confirmed: false }, "owner"), { code: "crm_confirmation_required" });
    const d = drafts.get();
    const p = service.makePlan({ crm_confirmed: true, week_start: d.week_start, draft_revision: d.revision, contacts: [{ approved: true }], linkedin_automated_target: 9999 }, "test-owner");
    assert.equal(p.assignments.length, 3); assert.equal(p.policy.linkedin_automated_target, 90);
    assert.equal(db.prepare("SELECT actor FROM outreach_crm_clearances LIMIT 1").get().actor, "test-owner");
    assert.throws(() => service.reserve({ contacts: p.assignments }, "manual"), { code: "reviewed_plan_required" });
  });
  it("rechecks suppression, product eligibility and draft edits before handoff", () => {
    const contacts = seed(); const p = plan();
    data.addSuppression({ type: "email", value: contacts[0].email, reason: "opt_out" });
    assert.throws(() => reserve(p), { code: "outreach_eligibility_changed" }); assert.equal(service.capacity().used, 0);
    db.prepare("DELETE FROM suppression_list").run(); eligible = false;
    assert.throws(() => reserve(p), { code: "outreach_eligibility_changed" });
    eligible = true; const d = drafts.get();
    drafts.save({ week_start: d.week_start, expected_revision: d.revision, draft: { ...d.draft, selected_contact_keys: [] } });
    assert.throws(() => reserve(p), { code: "outreach_draft_changed" });
  });
  it("shares 90 slots across manual/API plans and a service restart", () => {
    seed(60); reserve(plan()); assert.equal(service.capacity().remaining, 30);
    seed(60, "second"); const p = plan(); assert.equal(p.summary.linkedin_automated_selected, 30);
    reserve(p, "api"); assert.equal(service.capacity().remaining, 0);
    const restarted = createOutreachReliability({ db, draftStore: drafts, now: () => clock }); assert.equal(restarted.capacity().used, 90);
    seed(3, "third"); assert.equal(plan().summary.linkedin_automated_selected, 0);
  });
  it("prevents competing tab reservations and supports only idempotent replay", () => {
    seed(); const p = plan(); const other = plan();
    const first = reserve(p); const duplicate = reserve(p);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.result.batch.id, first.result.batch.id); assert.equal(service.capacity().used, 3);
    assert.throws(() => reserve(other), { code: "outreach_contacts_already_reserved" });
    assert.throws(() => reserve(p, "api"), { code: "plan_already_reserved" });
  });
  it("counts legacy preparations and rejects capacity consumed after review", () => {
    seed(60); const p = plan();
    data.createWeConnectExportBatch({ id: "legacy", included: Array.from({ length: 40 }, (_, i) => ({ linkedin_url: `https://linkedin.com/in/legacy-${i}` })) });
    db.prepare("UPDATE we_connect_export_items SET created_at = ?").run(clock.toISOString());
    assert.throws(() => reserve(p), { code: "weekly_capacity_changed" }); assert.equal(service.capacity().used, 40);
  });
  it("rolls over on UK Monday, handles DST and does not re-enrol old contacts", () => {
    seed(); const p = plan(); reserve(p); clock = new Date("2026-09-20T23:00:00Z");
    assert.equal(service.capacity().used, 0); assert.throws(() => reserve(p), { code: "outreach_week_changed" });
    seed(); assert.equal(plan().summary.linkedin_automated_selected, 0);
    assert.deepEqual(outreachWeekBounds(new Date("2026-10-24T12:00:00Z")), { week: "2026-10-19", start: "2026-10-18T23:00:00.000Z", end: "2026-10-26T00:00:00.000Z" });
  });
  it("allows campaign-name edits without invalidating reviewed people", () => {
    seed(); const p = plan(); const d = drafts.get();
    drafts.save({ week_start: d.week_start, expected_revision: d.revision, draft: { ...d.draft, campaign_name: "Changed" } });
    assert.equal(reserve(p).result.batch.items.length, 3);
  });
  it("blocks all channels on webhook stops, using exact email links and deduplicating callbacks", () => {
    const contacts = seed(); const p = plan();
    const event = { event_key: "stop-1", event_type: "reply", event_category: "reply_received", linkedin_url: contacts[0].linkedin_url, stop_other_channels: true };
    data.recordWeConnectWebhookEvent(event); data.recordWeConnectWebhookEvent(event);
    assert.equal(data.isContactSuppressed({ email: contacts[0].email }).source, "we_connect_webhook");
    assert.equal(data.isContactSuppressed({ email: "unrelated@example.test" }), null);
    assert.throws(() => reserve(p), { code: "outreach_eligibility_changed" }); assert.equal(plan().assignments.length, 2);
  });
  it("holds uncertain results for recorded review and cannot release active requests", () => {
    seed(); const id = reserve(plan(), "api").result.batch.id;
    assert.throws(() => service.reconcile(id, { outcome: "absent", note: "Checked We-Connect campaign" }, "owner"), { code: "handoff_not_awaiting_review" });
    service.complete(id, "reconciliation_required"); assert.equal(service.capacity().used, 3); assert.equal(service.pending().length, 1);
    service.reconcile(id, { outcome: "absent", note: "Checked campaign: no contacts were imported" }, "owner");
    assert.equal(service.capacity().used, 0); assert.equal(service.pending().length, 0);
    assert.equal(db.prepare("SELECT actor FROM outreach_handoff_reviews").get().actor, "owner");
  });
});

describe("Outreach HTTP boundary", () => {
  it("reuses successes, holds timeouts and releases definite rejections without sending twice", async () => {
    let calls = 0, outcome = "success";
    const app = express(); app.use(express.json());
    app.use("/api", createOutreachRouter({ service, getBatch: data.getWeConnectExportBatch, confirmBatch: data.confirmWeConnectExportBatch,
      apiClient: { configured: true, importContacts: async () => { calls++; if (outcome !== "success") throw Object.assign(new Error("Synthetic failure"), { status: outcome === "rejected" ? 401 : undefined }); } } }));
    const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/linkedin/we-connect/import`;
    const send = p => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true, plan_id: p.plan_id, campaign_name: "Synthetic cadence" }) });
    try {
      seed(); const p = plan(); assert.equal((await send(p)).status, 201); assert.equal((await send(p)).status, 200); assert.equal(calls, 1);
      seed(3, "timeout"); outcome = "timeout"; const uncertain = plan();
      assert.equal((await send(uncertain)).status, 502); assert.equal((await send(uncertain)).status, 409); assert.equal(calls, 2); assert.equal(service.capacity().used, 6);
      seed(3, "rejected"); outcome = "rejected"; assert.equal((await send(plan())).status, 502); assert.equal(service.capacity().used, 6);
      assert.equal((await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: "{}" })).status, 403);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
