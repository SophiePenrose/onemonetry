import { normalizeLinkedInProfileUrl } from "./we-connect-manual.js";

const stoppedStatuses = new Set(["do_not_contact", "suppressed", "hidden"]);
const text = value => String(value || "").trim();

// Read the older workspace in place. No schema rewrite, import, approval or
// provider request is necessary to recover people already saved by the owner.
export function savedProspectRows(db, companyNumber, companyId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prospect_workspace'").get()) return [];
  return db.prepare(`SELECT * FROM prospect_workspace
    WHERE upper(trim(company_number)) = ? OR lower(trim(company_id)) IN (?, ?, ?)
    ORDER BY id`).all(companyNumber, companyNumber.toLowerCase(), `ch-${companyNumber}`.toLowerCase(), text(companyId).toLowerCase());
}

export function findSavedContactStop(db, { email, linkedin_url } = {}) {
  const normalizedEmail = text(email).toLowerCase();
  const url = normalizeLinkedInProfileUrl(linkedin_url);
  if (!normalizedEmail && !url) return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prospect_workspace'").get()) return null;
  // Do not swallow schema/read failures: the existing export and handoff routes
  // fail closed when suppression cannot be checked.
  const rows = db.prepare(`SELECT id, email, linkedin_url, availability_status FROM prospect_workspace
    WHERE lower(trim(availability_status)) IN ('do_not_contact', 'suppressed', 'hidden')`).all();
  const row = rows.find(item => (normalizedEmail && text(item.email).toLowerCase() === normalizedEmail)
    || (url && normalizeLinkedInProfileUrl(item.linkedin_url) === url));
  return row ? { source: "saved_prospect_workspace", type: "contact_stop", reason: row.availability_status, id: row.id } : null;
}

export function savedProspectCandidate(row, company) {
  if (stoppedStatuses.has(text(row.availability_status).toLowerCase())) return null;
  const email = text(row.email).toLowerCase();
  const linkedin = normalizeLinkedInProfileUrl(row.linkedin_url);
  if (!text(row.full_name) || (!email && !linkedin)) return null;
  return {
    person_id: `saved-prospect-${row.id}`, source: "saved_workspace",
    full_name: text(row.full_name), role: text(row.role), email: email || null,
    email_status: text(row.email_status) || "unknown", linkedin_url: linkedin,
    company_number: company.company_number, company_name: company.name,
    company_turnover_gbp: company.turnover, company_domain: company.domain || "",
    priority_score: company.priority || 0,
    // Legacy phone records have no reliable channel-level permission field.
    // Keep numbers in their original table until they have a reviewed route.
    phone: null, do_not_call: true,
  };
}
