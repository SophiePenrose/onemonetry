import express from "express";
import { savedProspectCandidate, savedProspectRows } from "./saved-prospects.js";
import { sqliteUtcTimestamp } from "./utc-timestamp.js";

const stages = ["active_opportunity", "closed_lost", "closed_won"];

export function createRecoveredWorkspace({ db, loadCompanies, normalizeCompanyNumber, getMonitoredCompany,
  getStoredScore, getCompanyState, resolveCompany, suppressed }) {
  function opportunities() {
    const companies = loadCompanies();
    const byId = new Map(companies.map(company => [company.id, company]));
    const byNumber = new Map(companies.map(company => [normalizeCompanyNumber(company.company_number), company]));
    // Discover stored aliases, then use the same authoritative state as the
    // company profile/transition API rather than resurrecting an older alias.
    const states = db.prepare("SELECT * FROM workflow_state ORDER BY julianday(updated_at) DESC, company_id").all();
    const statesById = new Map(states.map(row => [row.company_id, row]));
    const seen = new Set(), rows = [];
    for (const row of states) {
      const legacy = byId.get(row.company_id);
      const number = normalizeCompanyNumber(legacy?.company_number || String(row.company_id).replace(/^ch-/i, ""));
      const identity = number || row.company_id;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const company = legacy || byNumber.get(number);
      const monitored = number ? getMonitoredCompany(number) : null;
      if (!company && !monitored) continue;
      const id = company?.id || `ch-${number}`;
      const workflow = getCompanyState(id);
      if (!stages.includes(workflow.state)) continue;
      const score = number ? getStoredScore(number) : null;
      const aliases = [...new Set([row.company_id, company?.id, number, number && `ch-${number}`].filter(Boolean))];
      const placeholders = aliases.map(() => "?").join(",");
      const sequences = db.prepare(`SELECT count(*) AS sequence_count, max(julianday(updated_at)) AS latest_jd
        FROM email_sequences WHERE company_id IN (${placeholders})`).get(...aliases);
      const activity = db.prepare(`SELECT max(event_at) AS latest_jd FROM (
        SELECT julianday(es.sent_at) AS event_at FROM email_steps es JOIN email_sequences s ON s.id = es.sequence_id WHERE s.company_id IN (${placeholders})
        UNION ALL SELECT julianday(es.replied_at) FROM email_steps es JOIN email_sequences s ON s.id = es.sequence_id WHERE s.company_id IN (${placeholders})
        UNION ALL SELECT julianday(a.exported_at) FROM email_audit_log a WHERE a.company_id IN (${placeholders})
      )`).get(...aliases, ...aliases, ...aliases);
      const latestJd = Math.max(sequences.latest_jd || 0, activity.latest_jd || 0);
      rows.push({ id, company_number: number || "",
        name: monitored?.company_name || company?.name || number || row.company_id,
        workflow_state: workflow.state, workflow_updated_at: sqliteUtcTimestamp(statesById.get(id)?.updated_at || row.updated_at),
        turnover: monitored?.latest_turnover ?? company?.turnover ?? null,
        industry: company?.industry || score?.industries?.[0] || "Unknown industry",
        combined_score: score?.composite_score ?? company?.combined_score ?? null,
        best_motion: score?.layers?.product_fit?.best_motion || company?.best_motion || null,
        latest_filing_date: monitored?.latest_filing_date || company?.latest_filing_date || null,
        sequence_activity: { sequence_count: sequences.sequence_count,
          latest_sequence_activity_at: latestJd ? new Date((latestJd - 2440587.5) * 86400000).toISOString() : null },
      });
    }
    rows.sort((a, b) => stages.indexOf(a.workflow_state) - stages.indexOf(b.workflow_state)
      || String(b.workflow_updated_at).localeCompare(String(a.workflow_updated_at)));
    return { opportunities: rows, meta: { total: rows.length,
      counts: Object.fromEntries(stages.map(stage => [stage, rows.filter(row => row.workflow_state === stage).length])) } };
  }

  function savedContacts(input) {
    if (typeof input !== "string") throw Object.assign(new Error("company_numbers_required"), { status: 400 });
    const requested = input.split(",").filter(Boolean);
    if (!requested.length || requested.length > 40) throw Object.assign(new Error("select_1_to_40_companies"), { status: 400 });
    const numbers = requested.map(normalizeCompanyNumber);
    if (numbers.some(number => !number)) throw Object.assign(new Error("invalid_company_number"), { status: 400 });
    const candidates = [], omitted = [];
    const companies = loadCompanies();
    for (const number of new Set(numbers)) {
      const company = resolveCompany(number);
      if (!company.eligible) { omitted.push({ company_number: number, reason: company.reason }); continue; }
      const id = companies.find(item => normalizeCompanyNumber(item.company_number) === number)?.id;
      for (const row of savedProspectRows(db, number, id)) {
        const candidate = savedProspectCandidate(row, company);
        if (!candidate || suppressed(candidate)) continue;
        candidates.push(candidate);
        if (candidates.length > 500) throw Object.assign(new Error("too_many_saved_contacts_select_fewer_companies"), { status: 400 });
      }
    }
    return { candidates, omitted, requires_current_crm_clearance: true, send_performed: false };
  }
  return { opportunities, savedContacts };
}

export function createRecoveredWorkspaceRouter(service) {
  const router = express.Router();
  const read = fn => (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(fn(req)); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : "saved_workspace_unavailable" }); }
  };
  router.get("/opportunities", read(() => service.opportunities()));
  router.get("/contacts/saved", read(req => service.savedContacts(req.query.company_numbers)));
  return router;
}
