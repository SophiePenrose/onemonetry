import express from "express";

const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
export const emptyOutreachDraft = () => ({ selected_company_numbers: [], contacts: [], selected_contact_keys: [], campaign_name: "" });

export function outreachWeek(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

const contactFields = new Set([
  "person_id", "source_id", "source", "full_name", "first_name", "last_name", "role",
  "company_name", "company_number", "company_domain", "company_turnover_gbp", "priority_score",
  "email", "email_status", "linkedin_url", "phone", "confidence", "suppressed", "do_not_contact",
  "do_not_email", "do_not_linkedin", "do_not_call", "phone_dnc", "allow_fourth_contact", "strategic_company",
]);
function stringList(value, max) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || item.length > 1024)) throw fail("invalid_outreach_draft");
  return [...new Set(value)];
}
export function sanitizeOutreachDraft(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.contacts) || input.contacts.length > 500
      || typeof input.campaign_name !== "string" || input.campaign_name.length > 200) throw fail("invalid_outreach_draft");
  const contacts = input.contacts.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("invalid_outreach_draft");
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!contactFields.has(key)) continue; // Provider payloads, plans and approval flags are never drafts.
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw fail("invalid_outreach_draft");
      if (typeof value === "string" && value.length > 1024) throw fail("invalid_outreach_draft");
      result[key] = value;
    }
    return result;
  });
  return {
    selected_company_numbers: stringList(input.selected_company_numbers, 300),
    selected_contact_keys: stringList(input.selected_contact_keys, 500), contacts,
    campaign_name: input.campaign_name,
  };
}

// One owner workspace, like the existing shortlist. Its normal app authentication applies.
export function createOutreachDraftStore({ db, now = () => new Date() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_outreach_drafts (
    week_start TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, draft_json TEXT NOT NULL
  )`);
  const read = db.prepare("SELECT * FROM weekly_outreach_drafts WHERE week_start = ?");
  const write = db.prepare(`INSERT INTO weekly_outreach_drafts (week_start, revision, updated_at, draft_json)
    VALUES (?, ?, ?, ?) ON CONFLICT(week_start) DO UPDATE SET
    revision=excluded.revision, updated_at=excluded.updated_at, draft_json=excluded.draft_json`);
  function get() {
    const week = outreachWeek(now());
    const row = read.get(week);
    return { week_start: week, revision: row?.revision || 0, updated_at: row?.updated_at || null,
      draft: row ? sanitizeOutreachDraft(JSON.parse(row.draft_json)) : emptyOutreachDraft() };
  }
  const save = db.transaction(input => {
    const current = get();
    if (input?.week_start !== current.week_start) throw fail("outreach_week_changed", 409);
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 0) throw fail("invalid_draft_revision");
    if (input.expected_revision !== current.revision) throw fail("outreach_draft_conflict", 409);
    const draft = sanitizeOutreachDraft(input.draft);
    const result = { week_start: current.week_start, revision: current.revision + 1, updated_at: now().toISOString(), draft };
    write.run(result.week_start, result.revision, result.updated_at, JSON.stringify(draft));
    return result;
  });
  return { get, save: input => save.immediate(input) };
}

export function createOutreachDraftRouter({ store }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", (_req, res) => {
    try { res.json(store.get()); } catch { res.status(500).json({ error: "outreach_draft_load_failed" }); }
  });
  router.put("/", (req, res) => {
    if (!req.is("application/json")) return res.status(415).json({ error: "json_required" });
    if (req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ error: "cross_site_write_denied" });
    try { res.json(store.save(req.body)); } catch (error) {
      res.status(error.status || 500).json({ error: error.code || "outreach_draft_save_failed" });
    }
  });
  return router;
}
