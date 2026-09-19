import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createOutreachDraftStore, createOutreachDraftRouter, outreachWeek, emptyOutreachDraft } from "../outreach-drafts.js";

const draft = () => ({ ...emptyOutreachDraft(), selected_company_numbers: ["00123456"], selected_contact_keys: ["person-1"],
  contacts: [{ person_id: "person-1", full_name: "Example Person", company_number: "00123456", phone_dnc: true, do_not_email: true,
    do_not_contact: true, crm_approved: true, approved: true, approval_status: "approved", turnover_override_approved: true,
    provider_payload: { confidential_unused_field: "not retained" } }],
  campaign_name: "Finance directors", approved: true, plan: { assignments: ["never restore"] } });

describe("Weekly draft persistence", () => {
  let dir, db, store, clock;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "outreach-drafts-"));
    clock = new Date("2026-09-19T12:00:00Z");
    db = new Database(path.join(dir, "drafts.db"));
    store = createOutreachDraftStore({ db, now: () => clock });
  });
  after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  it("survives a database restart, preserving opt-outs but never send/CRM approvals or provider payloads", () => {
    const current = store.get();
    const saved = store.save({ week_start: current.week_start, expected_revision: 0, draft: draft() });
    db.close(); db = new Database(path.join(dir, "drafts.db"));
    store = createOutreachDraftStore({ db, now: () => clock });
    assert.deepEqual(store.get(), saved);
    assert.deepEqual(saved.draft.contacts[0], { person_id: "person-1", full_name: "Example Person", company_number: "00123456", phone_dnc: true, do_not_email: true, do_not_contact: true });
    assert.equal(saved.draft.plan, undefined); assert.equal(saved.draft.approved, undefined);
    assert.equal(saved.draft.selected_company_numbers[0], "00123456");
  });
  it("rejects stale tab writes without losing the stored selection", () => {
    const before = store.get();
    assert.throws(() => store.save({ week_start: before.week_start, expected_revision: 0, draft: emptyOutreachDraft() }), { code: "outreach_draft_conflict", status: 409 });
    assert.deepEqual(store.get(), before);
  });
  it("rejects malformed and oversized drafts without advancing the revision", () => {
    const before = store.get();
    for (const invalid of [{ ...draft(), contacts: Array(501).fill({}) }, { ...draft(), campaign_name: "x".repeat(201) }, { ...draft(), contacts: [{ phone_dnc: {} }] }]) {
      assert.throws(() => store.save({ week_start: before.week_start, expected_revision: before.revision, draft: invalid }), { code: "invalid_outreach_draft" });
    }
    assert.deepEqual(store.get(), before);
  });
  it("starts each UK week empty and blocks late saves to the previous week", () => {
    const old = store.get(); clock = new Date("2026-09-20T23:00:00Z");
    assert.deepEqual(store.get().draft, emptyOutreachDraft());
    assert.equal(store.get().week_start, "2026-09-21");
    assert.throws(() => store.save({ week_start: old.week_start, expected_revision: old.revision, draft: draft() }), { code: "outreach_week_changed" });
  });
  it("uses UK Mondays through summer, winter and year boundaries", () => {
    assert.equal(outreachWeek(new Date("2026-09-20T22:59:59Z")), "2026-09-14");
    assert.equal(outreachWeek(new Date("2026-09-20T23:00:00Z")), "2026-09-21");
    assert.equal(outreachWeek(new Date("2026-12-27T23:30:00Z")), "2026-12-21");
    assert.equal(outreachWeek(new Date("2027-01-01T00:00:00Z")), "2026-12-28");
  });
});

describe("Draft HTTP boundary", () => {
  let db, server, base;
  before(async () => {
    db = new Database(":memory:");
    const app = express(); app.use(express.json());
    app.use("/api/outreach/draft", createOutreachDraftRouter({ store: createOutreachDraftStore({ db }) }));
    server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}/api/outreach/draft`;
  });
  after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  it("does not cache contact data and rejects cross-site/non-JSON writes", async () => {
    const read = await fetch(base); assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: "{}" })).status, 403);
  });
  it("round-trips a draft and returns a conflict for a repeated stale write", async () => {
    const current = await (await fetch(base)).json();
    const options = { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ week_start: current.week_start, expected_revision: current.revision, draft: draft() }) };
    const response = await fetch(base, options); assert.equal(response.status, 200);
    const saved = await response.json(); assert.equal(saved.revision, 1);
    assert.equal((await fetch(base, options)).status, 409);
    assert.deepEqual((await (await fetch(base)).json()).draft, saved.draft);
  });
});
