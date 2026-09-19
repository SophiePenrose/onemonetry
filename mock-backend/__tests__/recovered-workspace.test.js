import { after, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createRecoveredWorkspace, createRecoveredWorkspaceRouter } from "../recovered-workspace.js";

const directory = mkdtempSync(path.join(tmpdir(), "recovered-workspace-"));
process.env.DATABASE_PATH = path.join(directory, "fixture.db");
const data = await import("../db.js");
await import("../email-sequences.js");
const db = data.default;
const number = "00123456";
let eligible = true;
const service = createRecoveredWorkspace({ db,
  loadCompanies: () => [{ id: `ch-${number}`, company_number: number, name: "Synthetic Ltd", turnover: 50000000 }],
  normalizeCompanyNumber: value => /^\d{8}$/.test(String(value)) ? value : null,
  getMonitoredCompany: () => null, getStoredScore: () => null,
  getCompanyState: data.getCompanyWorkflowState,
  resolveCompany: value => ({ eligible, reason: "product_fit_research_required", company_number: value, name: "Synthetic Ltd", turnover: 50000000 }),
  suppressed: data.isContactSuppressed,
});
function savedTable() {
  db.exec(`CREATE TABLE prospect_workspace (id INTEGER PRIMARY KEY, company_id TEXT, company_number TEXT,
    full_name TEXT, role TEXT, email TEXT, email_status TEXT, linkedin_url TEXT, mobile_phone TEXT,
    crm_checked INTEGER, selected_for_sequence INTEGER, availability_status TEXT)`);
  db.prepare(`INSERT INTO prospect_workspace VALUES (1, ?, ?, 'Synthetic Person', 'Finance Director',
    'person@example.test', 'verified', 'https://www.linkedin.com/in/synthetic-person/', '+442000000000', 1, 1, 'available')`).run(`ch-${number}`, number);
}
beforeEach(() => {
  eligible = true;
  db.exec("DROP TABLE IF EXISTS prospect_workspace; DELETE FROM workflow_history; DELETE FROM workflow_state; DELETE FROM email_audit_log; DELETE FROM email_steps; DELETE FROM email_sequences; DELETE FROM suppression_list;");
});
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

it("works on a fresh database without creating a second prospect store", () => {
  assert.deepEqual(service.savedContacts(number).candidates, []);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='prospect_workspace'").get(), undefined);
});

it("recovers saved people without inheriting approval, phone permission, or mutating legacy rows", () => {
  savedTable();
  const before = db.prepare("SELECT * FROM prospect_workspace").all();
  const result = service.savedContacts(number);
  assert.equal(result.candidates.length, 1);
  const person = result.candidates[0];
  assert.equal(person.person_id, "saved-prospect-1");
  assert.equal(person.email, "person@example.test");
  assert.equal(person.linkedin_url, "https://linkedin.com/in/synthetic-person");
  assert.equal(person.crm_approved, undefined);
  assert.equal(person.selected_for_sequence, undefined);
  assert.equal(person.phone, null);
  assert.equal(person.do_not_call, true);
  assert.equal(result.requires_current_crm_clearance, true);
  assert.deepEqual(db.prepare("SELECT * FROM prospect_workspace").all(), before);
});

it("rechecks current company eligibility and contact suppression on every load", () => {
  savedTable(); eligible = false;
  assert.equal(service.savedContacts(number).candidates.length, 0);
  assert.equal(service.savedContacts(number).omitted[0].reason, "product_fit_research_required");
  eligible = true;
  db.prepare("UPDATE prospect_workspace SET availability_status='do_not_contact'").run();
  assert.equal(service.savedContacts(number).candidates.length, 0);
  assert.equal(data.isContactSuppressed({ email: " PERSON@example.test " }).source, "saved_prospect_workspace");
  assert.equal(data.isContactSuppressed({ linkedin_url: "https://linkedin.com/in/synthetic-person?tracking=1" }).source, "saved_prospect_workspace");
  assert.equal(data.isContactSuppressed({ email: "unrelated@example.test" }), null);
});

it("supports legacy company IDs when the saved company number is absent", () => {
  savedTable(); db.prepare("UPDATE prospect_workspace SET company_number=NULL").run();
  assert.equal(service.savedContacts(number).candidates.length, 1);
  assert.throws(() => service.savedContacts("not-a-number"), /invalid_company_number/);
  assert.throws(() => service.savedContacts(Array(41).fill(number).join(",")), /select_1_to_40/);
});

it("shows active and closed opportunities, including unscored companies, without recalculating scores", () => {
  db.prepare("INSERT INTO workflow_state VALUES (?, 'active_opportunity', '2026-09-19 12:00:00')").run(`ch-${number}`);
  const result = service.opportunities();
  assert.equal(result.meta.counts.active_opportunity, 1);
  assert.equal(result.opportunities[0].combined_score, null);
  assert.equal(result.opportunities[0].workflow_updated_at, "2026-09-19T12:00:00Z");
  assert.equal(result.opportunities[0].sequence_activity.sequence_count, 0);
  db.prepare("INSERT INTO workflow_state VALUES (?, 'new_candidate', '2026-09-19 13:00:00')").run(number);
  assert.equal(service.opportunities().meta.total, 1);
  db.prepare("UPDATE workflow_state SET state='new_candidate' WHERE company_id=?").run(`ch-${number}`);
  assert.equal(service.opportunities().meta.total, 0);
});

it("reports unreadable saved schemas as unavailable instead of silently allowing contacts", async () => {
  db.exec("CREATE TABLE prospect_workspace (id INTEGER PRIMARY KEY)");
  assert.throws(() => data.isContactSuppressed({ email: "person@example.test" }));
  const app = express(); app.use("/api", createRecoveredWorkspaceRouter(service));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/saved?company_numbers=${number}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "saved_workspace_unavailable" });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
