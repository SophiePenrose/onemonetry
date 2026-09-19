import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { outreachWeek } from "./outreach-drafts.js";
import { planWeeklyOutreach } from "./contact-orchestration.js";
import { normalizeLinkedInProfileUrl } from "./we-connect-manual.js";
import { buildWeConnectApiImport } from "./we-connect-api.js";

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const contactKey = (contact, index) => String(contact.person_id || contact.source_id || contact.linkedin_url || contact.email || `${contact.full_name || "contact"}-${index}`);
const yes = value => value === true || value === 1 || ["true", "1", "yes"].includes(String(value).toLowerCase());
const fingerprint = draft => createHash("sha256").update(JSON.stringify({ ...draft, campaign_name: "" })).digest("hex");

// UK midnight boundaries, including weeks spanning daylight-saving changes.
export function outreachWeekBounds(now) {
  const week = outreachWeek(now);
  const monday = new Date(`${week}T12:00:00Z`);
  const next = new Date(monday); next.setUTCDate(next.getUTCDate() + 7);
  const midnight = date => {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(date));
    return new Date(date.getTime() - hour * 3600000).toISOString();
  };
  return { week, start: midnight(monday), end: midnight(next) };
}

export function createOutreachReliability({ db, draftStore, resolveCompany, suppressed, createBatch, getBatch, completeBatch, now = () => new Date() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_reviewed_plans (
      id TEXT PRIMARY KEY, week_start TEXT NOT NULL, draft_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL, actor TEXT NOT NULL, plan_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outreach_crm_clearances (
      plan_id TEXT NOT NULL, company_number TEXT NOT NULL, confirmed_at TEXT NOT NULL, actor TEXT NOT NULL,
      PRIMARY KEY (plan_id, company_number), FOREIGN KEY (plan_id) REFERENCES outreach_reviewed_plans(id)
    );
    CREATE TABLE IF NOT EXISTS outreach_handoffs (
      plan_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, campaign_name TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES outreach_reviewed_plans(id)
    );
    CREATE TABLE IF NOT EXISTS outreach_handoff_reviews (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL, reviewed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_we_connect_items_created ON we_connect_export_items(created_at);
  `);
  function capacity() {
    const { week, start, end } = outreachWeekBounds(now());
    // Include legacy batches and unconfirmed manual exports. Do not release ambiguous failures.
    const used = db.prepare(`SELECT COUNT(DISTINCT linkedin_url) AS count FROM we_connect_export_items
      WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)
      AND status != 'import_rejected'`).get(start, end).count;
    return { week_start: week, automated_limit: 90, manual_reserve: 10, used, remaining: Math.max(0, 90 - used) };
  }
  function previousUrls() {
    return new Set(db.prepare("SELECT DISTINCT linkedin_url FROM we_connect_export_items WHERE status != 'import_rejected'").all()
      .map(row => normalizeLinkedInProfileUrl(row.linkedin_url)).filter(Boolean));
  }
  function rememberIdentity(contact) {
    const url = normalizeLinkedInProfileUrl(contact.linkedin_url);
    const email = String(contact.email || "").trim().toLowerCase();
    if (url && email) db.prepare("INSERT OR IGNORE INTO outreach_contact_identities (linkedin_url, email) VALUES (?, ?)").run(url, email);
  }
  function checkedContact(contact) {
    const company = resolveCompany(contact.company_number);
    if (!company?.eligible) return { reason: company?.reason || "company_not_eligible" };
    if (yes(contact.suppressed) || yes(contact.do_not_contact) || suppressed({ company_number: company.company_number,
      email: contact.email, domain: company.domain, linkedin_url: contact.linkedin_url })) return { reason: "contact_stopped_or_suppressed" };
    return { contact: { ...contact, company_name: company.name, company_number: company.company_number,
      company_domain: company.domain, company_turnover_gbp: company.turnover, priority_score: company.priority || 0,
      crm_approved: true, turnover_override_approved: false } };
  }
  const makePlanTransaction = db.transaction((input, actor) => {
    if (input?.crm_confirmed !== true) throw fail("crm_confirmation_required", 400);
    const current = draftStore.get();
    if (input.week_start !== current.week_start || input.draft_revision !== current.revision) throw fail("outreach_draft_changed");
    const selectedCompanies = new Set(current.draft.selected_company_numbers);
    const selectedContacts = new Set(current.draft.selected_contact_keys);
    const contacts = [], rejected = [], prior = previousUrls();
    current.draft.contacts.forEach((raw, index) => {
      if (!selectedCompanies.has(raw.company_number) || !selectedContacts.has(contactKey(raw, index))) return;
      rememberIdentity(raw); // Exact LinkedIn/email links only, so earlier webhook stops can be matched.
      const checked = checkedContact(raw);
      if (!checked.contact) { rejected.push({ full_name: raw.full_name, company_number: raw.company_number, reason: checked.reason }); return; }
      const contact = checked.contact;
      if (prior.has(normalizeLinkedInProfileUrl(contact.linkedin_url))) contact.do_not_linkedin = true;
      contacts.push(contact);
    });
    const available = capacity();
    const plan = planWeeklyOutreach({ contacts, linkedin_weekly_cap: 100, linkedin_manual_reserve: 10,
      linkedin_automated_target: available.remaining, minimum_turnover_gbp: 30000000 });
    plan.policy.linkedin_manual_reserve = 10;
    plan.policy.linkedin_automated_target = 90;
    plan.capacity = available;
    plan.rejected = [...(plan.rejected || []), ...rejected];
    plan.plan_id = randomUUID(); plan.week_start = current.week_start;
    db.prepare("INSERT INTO outreach_reviewed_plans VALUES (?, ?, ?, ?, ?, ?)").run(plan.plan_id, current.week_start,
      fingerprint(current.draft), now().toISOString(), actor, JSON.stringify(plan));
    const clearance = db.prepare("INSERT OR IGNORE INTO outreach_crm_clearances VALUES (?, ?, ?, ?)");
    for (const contact of contacts) clearance.run(plan.plan_id, contact.company_number, now().toISOString(), actor);
    return plan;
  });
  function loadPlan(id) {
    const row = db.prepare("SELECT * FROM outreach_reviewed_plans WHERE id = ?").get(String(id || ""));
    if (!row) throw fail("reviewed_plan_required", 400);
    if (row.week_start !== outreachWeek(now())) throw fail("outreach_week_changed");
    if (row.draft_fingerprint !== fingerprint(draftStore.get().draft)) throw fail("outreach_draft_changed");
    return JSON.parse(row.plan_json);
  }
  function handoffResult(handoff) {
    const batch = getBatch(handoff.batch_id);
    const manual = handoff.mode === "manual";
    return { batch, campaign_name: handoff.campaign_name, capacity: capacity(), send_performed: handoff.status === "imported_api",
      success: handoff.status === "imported_api", ...(manual ? { url_text: batch.items.map(item => item.linkedin_url).join("\n") } : {}),
      summary: { [manual ? "ready_to_paste" : "ready_to_import"]: batch.items.length, previously_exported: 0, skipped: 0 } };
  }
  const reserveTransaction = db.transaction((input, mode) => {
    const plan = loadPlan(input.plan_id);
    const campaign = String(input.campaign_name || "").trim();
    if (campaign.length > 200 || (mode === "api" && !campaign)) throw fail("we_connect_campaign_required", 400);
    const contacts = plan.assignments.filter(row => row.routes?.linkedin === "awaiting_human_approval");
    if (!contacts.length) throw fail("we_connect_contacts_required", 400);
    for (const contact of contacts) {
      const checked = checkedContact(contact);
      const cleared = db.prepare("SELECT 1 FROM outreach_crm_clearances WHERE plan_id = ? AND company_number = ?").get(plan.plan_id, contact.company_number);
      if (!cleared || !checked.contact || yes(contact.do_not_linkedin)) throw fail("outreach_eligibility_changed");
    }
    const previous = db.prepare("SELECT * FROM outreach_handoffs WHERE plan_id = ?").get(plan.plan_id);
    if (previous) {
      if (previous.mode !== mode || previous.campaign_name !== campaign) throw fail("plan_already_reserved");
      if (!["prepared", "imported_api", "confirmed_pasted"].includes(previous.status)) throw fail(previous.status === "reserved" ? "handoff_in_progress" : "handoff_requires_review");
      return { duplicate: true, result: handoffResult(previous) };
    }
    const prior = previousUrls();
    if (contacts.some(row => prior.has(normalizeLinkedInProfileUrl(row.linkedin_url)))) throw fail("outreach_contacts_already_reserved");
    if (contacts.length > capacity().remaining) throw fail("weekly_capacity_changed");
    const prepared = buildWeConnectApiImport({ contacts });
    if (prepared.contacts.length !== contacts.length) throw fail("outreach_contacts_changed");
    const id = randomUUID();
    const batch = createBatch({ id, campaignName: campaign, included: prepared.included });
    // Make the reservation clock explicit (and testable); never key capacity to completion time.
    db.prepare("UPDATE we_connect_export_items SET created_at = ? WHERE batch_id = ?").run(now().toISOString(), id);
    const handoff = { plan_id: plan.plan_id, batch_id: batch.id, mode, campaign_name: campaign, status: mode === "manual" ? "prepared" : "reserved" };
    db.prepare("INSERT INTO outreach_handoffs VALUES (?, ?, ?, ?, ?, ?)").run(plan.plan_id, batch.id, mode, campaign, handoff.status, now().toISOString());
    return { duplicate: false, contacts: prepared.contacts, result: handoffResult(handoff) };
  });
  const completeTransaction = db.transaction((batchId, status) => {
    completeBatch(batchId, { success: status === "imported_api", detail: { status } });
    db.prepare("UPDATE outreach_handoffs SET status = ? WHERE batch_id = ? AND status = 'reserved'").run(status, batchId);
    db.prepare("UPDATE we_connect_export_batches SET status = ? WHERE id = ?").run(status, batchId);
    db.prepare("UPDATE we_connect_export_items SET status = ? WHERE batch_id = ?").run(status, batchId);
  });
  const reconcileTransaction = db.transaction((id, input, actor) => {
    if (!["present", "absent"].includes(input?.outcome) || typeof input.note !== "string" || input.note.trim().length < 10 || input.note.length > 2000)
      throw fail("handoff_review_note_required", 400);
    const handoff = db.prepare("SELECT * FROM outreach_handoffs WHERE batch_id = ?").get(id);
    const abandoned = handoff?.status === "reserved" && Date.parse(handoff.created_at) < now().getTime() - 15 * 60000;
    if (!handoff || (handoff.status !== "reconciliation_required" && !abandoned)) throw fail("handoff_not_awaiting_review");
    const status = input.outcome === "present" ? "imported_api" : "import_rejected";
    completeTransaction(id, status);
    db.prepare("UPDATE outreach_handoffs SET status = ? WHERE batch_id = ?").run(status, id);
    db.prepare("INSERT INTO outreach_handoff_reviews VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), id, input.outcome, input.note.trim(), actor, now().toISOString());
    return { batch: getBatch(id), capacity: capacity() };
  });
  return { capacity,
    pending: () => db.prepare("SELECT batch_id, campaign_name, status, created_at FROM outreach_handoffs WHERE status = 'reconciliation_required' OR (status = 'reserved' AND julianday(created_at) < julianday(?))")
      .all(new Date(now().getTime() - 15 * 60000).toISOString()),
    reconcile: (id, input, actor) => reconcileTransaction.immediate(id, input, actor),
    makePlan: (input, actor) => makePlanTransaction.immediate(input, actor),
    reserve: (input, mode) => reserveTransaction.immediate(input, mode),
    complete: (id, status) => completeTransaction.immediate(id, status),
    readManual(id) {
      const handoff = db.prepare("SELECT * FROM outreach_handoffs WHERE batch_id = ? AND mode = 'manual'").get(id);
      if (!handoff) throw fail("reviewed_plan_required", 400);
      return reserveTransaction.immediate({ plan_id: handoff.plan_id, campaign_name: handoff.campaign_name }, "manual").result;
    },
  };
}

export function createOutreachRouter({ service, apiClient, getBatch, confirmBatch, actor = () => "workspace-owner" }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!/^\/(outreach\/(?:capacity|handoffs\/pending|handoffs\/[^/]+\/reconcile)|contacts\/weekly-plan|linkedin\/we-connect\/(import|manual-export(?:\/[^/]+(?:\/confirm)?)?))\/?$/.test(req.path)) return next("router");
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET") {
      if (!req.is("application/json")) return res.status(415).json({ error: "json_required" });
      if (req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ error: "cross_site_write_denied" });
    }
    next();
  });
  const handle = fn => async (req, res) => {
    try { await fn(req, res); } catch (error) { res.status(error.status || 500).json({ error: error.code || "outreach_request_failed" }); }
  };
  router.get("/outreach/capacity", handle((_req, res) => res.json(service.capacity())));
  router.get("/outreach/handoffs/pending", handle((_req, res) => res.json({ handoffs: service.pending() })));
  router.post("/outreach/handoffs/:batchId/reconcile", handle((req, res) => res.json(service.reconcile(req.params.batchId, req.body, actor(req)))));
  router.post("/contacts/weekly-plan", handle((req, res) => res.json(service.makePlan(req.body, actor(req)))));
  router.post("/linkedin/we-connect/manual-export", handle((req, res) => res.status(201).json(service.reserve(req.body, "manual").result)));
  router.get("/linkedin/we-connect/manual-export/:batchId", handle((req, res) => res.json(service.readManual(req.params.batchId).batch)));
  router.post("/linkedin/we-connect/manual-export/:batchId/confirm", handle((req, res) => {
    service.readManual(req.params.batchId); // Recheck stops and week before confirming an old handoff.
    res.json(confirmBatch(req.params.batchId));
  }));
  router.post("/linkedin/we-connect/import", handle(async (req, res) => {
    if (req.body?.approved !== true) throw fail("we_connect_explicit_approval_required", 400);
    if (!req.body?.plan_id) throw fail("reviewed_plan_required", 400);
    if (!apiClient.configured) throw fail("we_connect_not_configured", 503);
    const reservation = service.reserve(req.body, "api");
    if (reservation.duplicate) return res.json(reservation.result);
    const id = reservation.result.batch.id;
    try {
      await apiClient.importContacts({ campaignName: reservation.result.campaign_name, contacts: reservation.contacts });
      service.complete(id, "imported_api");
      res.status(201).json({ ...reservation.result, success: true, send_performed: true, batch: getBatch(id) });
    } catch (error) {
      // A timeout/5xx may have happened AFTER acceptance. Never resend or release its slots blindly.
      const rejected = error.status >= 400 && error.status < 500 && error.status !== 408;
      service.complete(id, rejected ? "import_rejected" : "reconciliation_required");
      res.status(502).json({ error: rejected ? "we_connect_import_rejected" : "we_connect_import_needs_reconciliation", batch_id: id,
        capacity: service.capacity() });
    }
  }));
  return router;
}
