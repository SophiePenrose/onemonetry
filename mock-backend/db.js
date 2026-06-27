import Database from "better-sqlite3";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configuredDbPath = (process.env.DATABASE_PATH || "").trim();
const DB_PATH = configuredDbPath
  ? (path.isAbsolute(configuredDbPath) ? configuredDbPath : path.resolve(process.cwd(), configuredDbPath))
  : path.join(__dirname, "onemonetry.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_state (
    company_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'new_candidate',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workflow_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    note TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES workflow_state(company_id)
  );

  CREATE TABLE IF NOT EXISTS weekly_reports (
    id TEXT PRIMARY KEY,
    week_label TEXT NOT NULL UNIQUE,
    generated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exclusions (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    prohibited_industries TEXT NOT NULL DEFAULT '[]',
    excluded_company_ids TEXT NOT NULL DEFAULT '[]',
    prohibited_sic_codes TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS closed_won_registry (
    company_number TEXT PRIMARY KEY,
    company_name TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_closed_won_source ON closed_won_registry(source);

  CREATE TABLE IF NOT EXISTS cadence_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS company_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_number TEXT NOT NULL,
    filing_date TEXT,
    description TEXT,
    filing_type TEXT,
    barcode TEXT,
    turnover REAL,
    turnover_currency TEXT DEFAULT 'GBP',
    balance_sheet_date TEXT,
    source TEXT,
    source_file TEXT,
    raw_data TEXT,
    extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(company_number, barcode)
  );

  CREATE INDEX IF NOT EXISTS idx_filings_company ON company_filings(company_number);
  CREATE INDEX IF NOT EXISTS idx_filings_date ON company_filings(filing_date);

  CREATE TABLE IF NOT EXISTS company_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    parent_company_number TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS company_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    company_number TEXT NOT NULL,
    entity_type TEXT DEFAULT 'operating',
    relationship TEXT,
    FOREIGN KEY (group_id) REFERENCES company_groups(id),
    UNIQUE(group_id, company_number)
  );

  CREATE TABLE IF NOT EXISTS company_monitor (
    company_number TEXT PRIMARY KEY,
    company_name TEXT,
    company_domain TEXT,
    company_website TEXT,
    last_checked_at TEXT,
    last_filing_date TEXT,
    stale_filing_checked_at TEXT,
    stale_filing_due_at TEXT,
    latest_turnover REAL,
    previous_turnover REAL,
    status TEXT DEFAULT 'active',
    below_threshold INTEGER DEFAULT 0,
    no_filings INTEGER DEFAULT 0,
    source TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_monitor_status ON company_monitor(status);
  CREATE INDEX IF NOT EXISTS idx_monitor_threshold ON company_monitor(below_threshold);

  CREATE TABLE IF NOT EXISTS website_resolution_cache (
    company_number TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    website_url TEXT,
    domain TEXT,
    confidence_score REAL DEFAULT 0,
    source TEXT,
    details_json TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_website_resolution_status ON website_resolution_cache(status);
  CREATE INDEX IF NOT EXISTS idx_website_resolution_retry ON website_resolution_cache(next_retry_at);

  CREATE TABLE IF NOT EXISTS company_charge_summary (
    company_number TEXT PRIMARY KEY,
    summary_json TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_charge_summary_updated ON company_charge_summary(updated_at);

  CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_items INTEGER DEFAULT 0,
    processed_items INTEGER DEFAULT 0,
    imported_items INTEGER DEFAULT 0,
    skipped_items INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    company_number TEXT,
    company_name TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    turnover REAL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES import_jobs(id)
  );

  CREATE TABLE IF NOT EXISTS analysis_queue (
    company_number TEXT PRIMARY KEY,
    company_name TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_analysis_queue_status ON analysis_queue(status);
  CREATE INDEX IF NOT EXISTS idx_analysis_queue_queued_at ON analysis_queue(queued_at);

  CREATE TABLE IF NOT EXISTS email_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audited_at TEXT DEFAULT (datetime('now')),
    exported_at TEXT,
    sequence_id TEXT,
    company_id TEXT,
    company_name TEXT,
    stakeholder_name TEXT,
    stakeholder_email TEXT,
    ae_owner TEXT,
    step_number INTEGER,
    step_type TEXT,
    subject TEXT,
    body TEXT,
    scheduled_date TEXT,
    scheduled_time TEXT,
    qc_score REAL,
    voice_percent REAL,
    validation_results_json TEXT,
    claims_json TEXT,
    consent_status_json TEXT,
    export_format TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_email_audit_sequence_id ON email_audit_log(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_email_audit_company_id ON email_audit_log(company_id);

  CREATE TABLE IF NOT EXISTS suppression_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    value_normalized TEXT NOT NULL,
    reason TEXT,
    source TEXT,
    company_name TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_type_value ON suppression_list(type, value_normalized);
  CREATE INDEX IF NOT EXISTS idx_suppression_type ON suppression_list(type);

  CREATE TABLE IF NOT EXISTS gemini_handoff_requests (
    request_id TEXT PRIMARY KEY,
    contract_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted',
    accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
    approvals_revision INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_retry_requested_at TEXT,
    request_payload TEXT NOT NULL,
    request_payload_sha256 TEXT,
    response_payload TEXT,
    response_payload_sha256 TEXT,
    response_id TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_gemini_handoff_status ON gemini_handoff_requests(status);
  CREATE INDEX IF NOT EXISTS idx_gemini_handoff_accepted ON gemini_handoff_requests(accepted_at);

  CREATE TABLE IF NOT EXISTS gemini_handoff_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    sequence_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    approval_status TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    review_notes TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (request_id) REFERENCES gemini_handoff_requests(request_id) ON DELETE CASCADE,
    UNIQUE(request_id, sequence_id, step_number)
  );

  CREATE INDEX IF NOT EXISTS idx_gemini_handoff_approvals_request ON gemini_handoff_approvals(request_id);
  CREATE INDEX IF NOT EXISTS idx_gemini_handoff_approvals_status ON gemini_handoff_approvals(approval_status);

  CREATE TABLE IF NOT EXISTS gemini_handoff_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_stage TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (request_id) REFERENCES gemini_handoff_requests(request_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_gemini_handoff_events_request ON gemini_handoff_events(request_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gemini_handoff_events_type ON gemini_handoff_events(event_type);
`);

try {
  db.exec("ALTER TABLE exclusions ADD COLUMN prohibited_sic_codes TEXT NOT NULL DEFAULT '[]'");
} catch {
  // Column already exists on upgraded databases.
}

function ensureAnalysisQueueSchema() {
  const columns = db.prepare("PRAGMA table_info(analysis_queue)").all();
  const names = new Set(columns.map((col) => col.name));

  if (!names.has("company_number")) {
    throw new Error("analysis_queue table is missing required company_number column");
  }

  if (!names.has("company_name")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN company_name TEXT");
  }
  if (!names.has("source")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN source TEXT");
  }
  if (!names.has("status")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'");
  }

  if (!names.has("attempts")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("last_error")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN last_error TEXT");
  }
  if (!names.has("queued_at")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN queued_at TEXT");
  }
  if (!names.has("started_at")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN started_at TEXT");
  }
  if (!names.has("completed_at")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN completed_at TEXT");
  }
  if (!names.has("updated_at")) {
    db.exec("ALTER TABLE analysis_queue ADD COLUMN updated_at TEXT");
  }

  // Backfill safe defaults for legacy rows created before these columns existed.
  db.exec(`
    UPDATE analysis_queue SET status = COALESCE(status, 'queued');
    UPDATE analysis_queue SET attempts = COALESCE(attempts, 0);
    UPDATE analysis_queue SET queued_at = COALESCE(queued_at, datetime('now'));
    UPDATE analysis_queue SET updated_at = COALESCE(updated_at, datetime('now'));
  `);
}

ensureAnalysisQueueSchema();

function ensureGeminiHandoffSchema() {
  const columns = db.prepare("PRAGMA table_info(gemini_handoff_requests)").all();
  const names = new Set(columns.map((col) => col.name));

  if (!names.has("request_payload_sha256")) {
    db.exec("ALTER TABLE gemini_handoff_requests ADD COLUMN request_payload_sha256 TEXT");
  }
  if (!names.has("response_payload_sha256")) {
    db.exec("ALTER TABLE gemini_handoff_requests ADD COLUMN response_payload_sha256 TEXT");
  }
  if (!names.has("approvals_revision")) {
    db.exec("ALTER TABLE gemini_handoff_requests ADD COLUMN approvals_revision INTEGER NOT NULL DEFAULT 0");
  }

  db.exec(`
    UPDATE gemini_handoff_requests
    SET request_payload_sha256 = NULL
    WHERE request_payload_sha256 = '';

    UPDATE gemini_handoff_requests
    SET response_payload_sha256 = NULL
    WHERE response_payload_sha256 = '';

    UPDATE gemini_handoff_requests
    SET approvals_revision = COALESCE(approvals_revision, 0);
  `);
}

ensureGeminiHandoffSchema();

function ensureCompanyMonitorSchema() {
  const columns = db.prepare("PRAGMA table_info(company_monitor)").all();
  const names = new Set(columns.map((col) => col.name));

  if (!names.has("company_domain")) {
    db.exec("ALTER TABLE company_monitor ADD COLUMN company_domain TEXT");
  }
  if (!names.has("company_website")) {
    db.exec("ALTER TABLE company_monitor ADD COLUMN company_website TEXT");
  }

  if (!names.has("stale_filing_checked_at")) {
    db.exec("ALTER TABLE company_monitor ADD COLUMN stale_filing_checked_at TEXT");
  }
  if (!names.has("stale_filing_due_at")) {
    db.exec("ALTER TABLE company_monitor ADD COLUMN stale_filing_due_at TEXT");
  }

  // Backfill due timestamps for stale filings in legacy rows.
  db.exec(`
    UPDATE company_monitor
    SET stale_filing_due_at = datetime('now')
    WHERE last_filing_date IS NOT NULL
      AND date(last_filing_date) <= date('now', '-12 months')
      AND stale_filing_due_at IS NULL;

    UPDATE company_monitor
    SET stale_filing_due_at = NULL
    WHERE last_filing_date IS NOT NULL
      AND date(last_filing_date) > date('now', '-12 months');
  `);
}

ensureCompanyMonitorSchema();

// --- Workflow State ---

const stmtGetState = db.prepare("SELECT state FROM workflow_state WHERE company_id = ?");
const stmtUpsertState = db.prepare(`
  INSERT INTO workflow_state (company_id, state, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(company_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
`);
const stmtGetHistory = db.prepare("SELECT * FROM workflow_history WHERE company_id = ? ORDER BY timestamp ASC");
const stmtInsertHistory = db.prepare(
  "INSERT INTO workflow_history (company_id, from_state, to_state, note, timestamp) VALUES (?, ?, ?, ?, datetime('now'))"
);

export function getCompanyWorkflowState(companyId) {
  const row = stmtGetState.get(companyId);
  if (!row) return { state: "new_candidate", history: [] };
  const history = stmtGetHistory.all(companyId).map((h) => ({
    from: h.from_state,
    to: h.to_state,
    note: h.note,
    timestamp: h.timestamp,
  }));
  return { state: row.state, history };
}

export function setCompanyWorkflowState(companyId, fromState, newState, note) {
  stmtUpsertState.run(companyId, newState);
  stmtInsertHistory.run(companyId, fromState, newState, note || null);
}

export function getAllWorkflowStates() {
  const rows = db.prepare("SELECT company_id, state FROM workflow_state").all();
  const result = {};
  for (const row of rows) result[row.company_id] = row.state;
  return result;
}

// --- Weekly Reports ---

const stmtInsertReport = db.prepare(
  "INSERT INTO weekly_reports (id, week_label, generated_at, data) VALUES (?, ?, ?, ?)"
);
const stmtGetReport = db.prepare("SELECT * FROM weekly_reports WHERE id = ?");
const stmtGetReportByWeek = db.prepare("SELECT * FROM weekly_reports WHERE week_label = ?");
const stmtListReports = db.prepare("SELECT id, week_label, generated_at FROM weekly_reports ORDER BY generated_at DESC");

export function saveReport(report) {
  stmtInsertReport.run(report.id, report.week_label, report.generated_at, JSON.stringify(report.companies));
}

export function getReport(reportId) {
  const row = stmtGetReport.get(reportId);
  if (!row) return null;
  return {
    id: row.id,
    week_label: row.week_label,
    generated_at: row.generated_at,
    companies: JSON.parse(row.data),
  };
}

export function getReportByWeek(weekLabel) {
  const row = stmtGetReportByWeek.get(weekLabel);
  if (!row) return null;
  return { id: row.id, week_label: row.week_label };
}

export function listReports() {
  return stmtListReports.all();
}

// --- Exclusions ---

export function getExclusions() {
  const row = db.prepare("SELECT * FROM exclusions WHERE id = 1").get();
  const parseArray = (value, fallback = []) => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  if (!row) {
    return {
      prohibited_industries: ["Gambling", "Tobacco", "Weapons", "Adult Entertainment"],
      excluded_company_ids: [],
      prohibited_sic_codes: [],
    };
  }

  return {
    prohibited_industries: parseArray(row.prohibited_industries),
    excluded_company_ids: parseArray(row.excluded_company_ids),
    prohibited_sic_codes: parseArray(row.prohibited_sic_codes),
  };
}

export function setExclusions(exclusions) {
  db.prepare(`
    INSERT INTO exclusions (id, prohibited_industries, excluded_company_ids, prohibited_sic_codes) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      prohibited_industries = excluded.prohibited_industries,
      excluded_company_ids = excluded.excluded_company_ids,
      prohibited_sic_codes = excluded.prohibited_sic_codes
  `).run(
    JSON.stringify(exclusions.prohibited_industries),
    JSON.stringify(exclusions.excluded_company_ids),
    JSON.stringify(exclusions.prohibited_sic_codes || []),
  );
}

function normalizeCompanyNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
  if (!stripped) return null;

  if (/^\d{1,8}$/.test(stripped)) {
    return stripped.padStart(8, "0");
  }

  if (/^[A-Z0-9]{2,12}$/.test(stripped)) {
    return stripped;
  }

  return null;
}

export function upsertClosedWonCompanies(rows, source = "manual_ingest") {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      received: 0,
      stored: 0,
      skipped_invalid: 0,
      source,
      company_numbers: [],
    };
  }

  const upsert = db.prepare(`
    INSERT INTO closed_won_registry (company_number, company_name, source, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(company_number) DO UPDATE SET
      company_name = COALESCE(excluded.company_name, closed_won_registry.company_name),
      source = excluded.source,
      updated_at = datetime('now')
  `);

  const tx = db.transaction((items) => {
    let stored = 0;
    let skippedInvalid = 0;
    const numbers = [];

    for (const item of items) {
      const companyNumber = normalizeCompanyNumber(item?.company_number || item?.companyNumber || item?.number || item);
      if (!companyNumber) {
        skippedInvalid += 1;
        continue;
      }

      const companyName = String(item?.company_name || item?.companyName || item?.name || "").trim() || null;
      upsert.run(companyNumber, companyName, source || "manual_ingest");
      stored += 1;
      numbers.push(companyNumber);
    }

    return { stored, skippedInvalid, numbers };
  });

  const result = tx(rows);
  return {
    received: rows.length,
    stored: result.stored,
    skipped_invalid: result.skippedInvalid,
    source,
    company_numbers: result.numbers,
  };
}

export function isClosedWonCompanyNumber(companyNumber) {
  const normalized = normalizeCompanyNumber(companyNumber);
  if (!normalized) return false;
  const row = db.prepare("SELECT 1 FROM closed_won_registry WHERE company_number = ?").get(normalized);
  return !!row;
}

export function getClosedWonCompany(companyNumber) {
  const normalized = normalizeCompanyNumber(companyNumber);
  if (!normalized) return null;
  return db.prepare("SELECT * FROM closed_won_registry WHERE company_number = ?").get(normalized) || null;
}

export function getClosedWonRegistryCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM closed_won_registry").get().count;
}

export function listClosedWonCompanies(limit = 200, offset = 0) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 200, 5000));
  const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  return db.prepare(`
    SELECT *
    FROM closed_won_registry
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(safeLimit, safeOffset);
}

export function listClosedWonCompanyNumbers() {
  return db.prepare("SELECT company_number FROM closed_won_registry").all().map((row) => row.company_number);
}

// --- Cadence Log ---

export function getCadenceLog(companyId) {
  return db.prepare("SELECT * FROM cadence_log WHERE company_id = ? ORDER BY date DESC").all(companyId);
}

export function addCadenceEntry(companyId, date, type, summary, outcome) {
  db.prepare(
    "INSERT INTO cadence_log (company_id, date, type, summary, outcome) VALUES (?, ?, ?, ?, ?)"
  ).run(companyId, date, type, summary, outcome || null);
}

// --- Email Audit Log ---

const stmtRecordEmailAudit = db.prepare(`
  INSERT INTO email_audit_log (
    exported_at,
    sequence_id,
    company_id,
    company_name,
    stakeholder_name,
    stakeholder_email,
    ae_owner,
    step_number,
    step_type,
    subject,
    body,
    scheduled_date,
    scheduled_time,
    qc_score,
    voice_percent,
    validation_results_json,
    claims_json,
    consent_status_json,
    export_format
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function recordEmailAudit(record) {
  stmtRecordEmailAudit.run(
    record?.exported_at ?? null,
    record?.sequence_id ?? null,
    record?.company_id ?? null,
    record?.company_name ?? null,
    record?.stakeholder_name ?? null,
    record?.stakeholder_email ?? null,
    record?.ae_owner ?? null,
    record?.step_number ?? null,
    record?.step_type ?? null,
    record?.subject ?? null,
    record?.body ?? null,
    record?.scheduled_date ?? null,
    record?.scheduled_time ?? null,
    record?.qc_score ?? null,
    record?.voice_percent ?? null,
    record?.validation_results_json ?? null,
    record?.claims_json ?? null,
    record?.consent_status_json ?? null,
    record?.export_format ?? null
  );
}

export function getEmailAuditLog(filters = {}) {
  const where = [];
  const params = [];

  if (filters.sequence_id) {
    where.push("sequence_id = ?");
    params.push(filters.sequence_id);
  }

  if (filters.company_id) {
    where.push("company_id = ?");
    params.push(filters.company_id);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    SELECT *
    FROM email_audit_log
    ${whereSql}
    ORDER BY datetime(audited_at) DESC, id DESC
  `).all(...params);
}

function sanitizeSuppressionType(type) {
  const normalizedType = String(type || "").trim().toLowerCase();
  if (normalizedType === "email" || normalizedType === "company_number" || normalizedType === "domain") {
    return normalizedType;
  }
  return null;
}

function normalizeSuppressionValue(type, value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (type === "email") return raw.toLowerCase();
  if (type === "company_number") return normalizeCompanyNumber(raw);
  if (type === "domain") return raw.toLowerCase().replace(/^www\./, "");
  return null;
}

function sanitizeNullableText(value) {
  const text = String(value || "").trim();
  return text || null;
}

const stmtUpsertSuppression = db.prepare(`
  INSERT INTO suppression_list (type, value, value_normalized, reason, source, company_name, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(type, value_normalized) DO UPDATE SET
    reason = excluded.reason,
    source = excluded.source,
    company_name = excluded.company_name,
    notes = excluded.notes
`);

const stmtGetSuppressionByTypeValue = db.prepare(`
  SELECT *
  FROM suppression_list
  WHERE type = ? AND value_normalized = ?
  LIMIT 1
`);

export function addSuppression({ type, value, reason, source, company_name, notes } = {}) {
  const normalizedType = sanitizeSuppressionType(type);
  const rawValue = String(value || "").trim();
  if (!normalizedType || !rawValue) return null;

  const normalizedValue = normalizeSuppressionValue(normalizedType, rawValue);
  if (!normalizedValue) return null;

  stmtUpsertSuppression.run(
    normalizedType,
    rawValue,
    normalizedValue,
    sanitizeNullableText(reason),
    sanitizeNullableText(source),
    sanitizeNullableText(company_name),
    sanitizeNullableText(notes)
  );

  return stmtGetSuppressionByTypeValue.get(normalizedType, normalizedValue) || null;
}

export function removeSuppression(id) {
  const parsedId = Number.parseInt(String(id), 10);
  if (!Number.isFinite(parsedId)) return 0;
  return db.prepare("DELETE FROM suppression_list WHERE id = ?").run(parsedId).changes;
}

export function listSuppressions({ type, limit = 500, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 500, 5000));
  const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const normalizedType = sanitizeSuppressionType(type);
  if (type && !normalizedType) return [];

  if (normalizedType) {
    return db.prepare(`
      SELECT *
      FROM suppression_list
      WHERE type = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedType, safeLimit, safeOffset);
  }

  return db.prepare(`
    SELECT *
    FROM suppression_list
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(safeLimit, safeOffset);
}

export function getSuppressionCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM suppression_list").get().count;
}

export function isContactSuppressed({ company_number, email, domain } = {}) {
  const normalizedEmail = normalizeSuppressionValue("email", email);
  if (normalizedEmail) {
    const match = stmtGetSuppressionByTypeValue.get("email", normalizedEmail);
    if (match) return match;
  }

  const normalizedCompanyNumber = normalizeSuppressionValue("company_number", company_number);
  if (normalizedCompanyNumber) {
    const match = stmtGetSuppressionByTypeValue.get("company_number", normalizedCompanyNumber);
    if (match) return match;
  }

  const normalizedDomain = normalizeSuppressionValue("domain", domain);
  if (normalizedDomain) {
    const match = stmtGetSuppressionByTypeValue.get("domain", normalizedDomain);
    if (match) return match;
  }

  return null;
}

// --- Settings ---

export function getSetting(key, defaultValue = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return defaultValue;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, JSON.stringify(value));
}

// --- Website Resolution Cache ---

const stmtGetWebsiteResolution = db.prepare("SELECT * FROM website_resolution_cache WHERE company_number = ?");
const stmtUpsertWebsiteResolution = db.prepare(`
  INSERT INTO website_resolution_cache (
    company_number,
    status,
    website_url,
    domain,
    confidence_score,
    source,
    details_json,
    checked_at,
    next_retry_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, datetime('now'))
  ON CONFLICT(company_number) DO UPDATE SET
    status = excluded.status,
    website_url = excluded.website_url,
    domain = excluded.domain,
    confidence_score = excluded.confidence_score,
    source = excluded.source,
    details_json = excluded.details_json,
    checked_at = excluded.checked_at,
    next_retry_at = excluded.next_retry_at,
    updated_at = datetime('now')
`);

function parseWebsiteResolutionRow(row) {
  if (!row) return null;
  let details = null;
  if (row.details_json) {
    try {
      details = JSON.parse(row.details_json);
    } catch {
      details = null;
    }
  }

  return {
    company_number: row.company_number,
    status: row.status || "unresolved",
    website_url: row.website_url || null,
    domain: row.domain || null,
    confidence_score: Number(row.confidence_score || 0),
    source: row.source || null,
    details,
    checked_at: row.checked_at || null,
    next_retry_at: row.next_retry_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export function getWebsiteResolution(companyNumber, defaultValue = null) {
  const normalized = normalizeCompanyNumber(companyNumber);
  if (!normalized) return defaultValue;
  const row = stmtGetWebsiteResolution.get(normalized);
  return row ? parseWebsiteResolutionRow(row) : defaultValue;
}

export function upsertWebsiteResolution(entry = {}) {
  const normalized = normalizeCompanyNumber(entry.company_number || entry.companyNumber || entry.number);
  if (!normalized) return null;

  const status = String(entry.status || "unresolved").trim() || "unresolved";
  const websiteUrl = String(entry.website_url || entry.websiteUrl || "").trim() || null;
  const domain = String(entry.domain || "").trim().toLowerCase().replace(/^www\./, "") || null;
  const confidenceScore = Math.max(0, Math.min(Number(entry.confidence_score ?? entry.confidenceScore ?? 0) || 0, 1));
  const source = String(entry.source || "website_resolver").trim() || "website_resolver";
  const checkedAt = String(entry.checked_at || entry.checkedAt || "").trim() || null;
  const nextRetryAt = String(entry.next_retry_at || entry.nextRetryAt || "").trim() || null;
  const details = entry.details && typeof entry.details === "object" ? entry.details : null;

  stmtUpsertWebsiteResolution.run(
    normalized,
    status,
    websiteUrl,
    domain,
    confidenceScore,
    source,
    details ? JSON.stringify(details) : null,
    checkedAt,
    nextRetryAt
  );

  return getWebsiteResolution(normalized, null);
}

// --- Company Filings ---

export function upsertFiling(filing) {
  db.prepare(`
    INSERT INTO company_filings (company_number, filing_date, description, filing_type, barcode, turnover, balance_sheet_date, source, source_file, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_number, barcode) DO UPDATE SET
      turnover = COALESCE(excluded.turnover, company_filings.turnover),
      raw_data = COALESCE(excluded.raw_data, company_filings.raw_data),
      extracted_at = datetime('now')
  `).run(
    filing.company_number, filing.filing_date, filing.description, filing.filing_type,
    filing.barcode || `gen-${filing.company_number}-${filing.filing_date}`,
    filing.turnover, filing.balance_sheet_date, filing.source, filing.source_file, filing.raw_data || null
  );
}

export function getFilingsForCompany(companyNumber, limit = 240) {
  const parsedLimit = Number.parseInt(String(limit), 10);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, 2000))
    : 240;
  return db.prepare("SELECT * FROM company_filings WHERE company_number = ? ORDER BY filing_date DESC LIMIT ?").all(companyNumber, safeLimit);
}

export function getLatestFiling(companyNumber) {
  return db.prepare("SELECT * FROM company_filings WHERE company_number = ? ORDER BY filing_date DESC LIMIT 1").get(companyNumber);
}

export function getFilingCount() {
  return db.prepare("SELECT COUNT(*) as count FROM company_filings").get().count;
}

// --- Company Monitor ---

const stmtUpsertMonitoredCompany = db.prepare(`
  INSERT INTO company_monitor (
    company_number,
    company_name,
    company_domain,
    company_website,
    latest_turnover,
    status,
    source,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(company_number) DO UPDATE SET
    company_name = COALESCE(excluded.company_name, company_monitor.company_name),
    company_domain = COALESCE(excluded.company_domain, company_monitor.company_domain),
    company_website = COALESCE(excluded.company_website, company_monitor.company_website),
    latest_turnover = COALESCE(excluded.latest_turnover, company_monitor.latest_turnover),
    status = COALESCE(excluded.status, company_monitor.status),
    updated_at = datetime('now')
`);

const stmtClearMonitoredCompanyWebsiteHints = db.prepare(`
  UPDATE company_monitor
  SET
    company_domain = NULL,
    company_website = NULL,
    updated_at = datetime('now')
  WHERE company_number = ?
`);

const txUpsertMonitoredCompanies = db.transaction((rows, defaultSource) => {
  let upserted = 0;
  let skippedInvalid = 0;

  for (const row of rows) {
    const companyNumber = normalizeCompanyNumber(
      row?.company_number
      || row?.companyNumber
      || row?.number
      || row
    );

    if (!companyNumber) {
      skippedInvalid += 1;
      continue;
    }

    const companyName = String(
      row?.company_name
      || row?.companyName
      || row?.name
      || ""
    ).trim() || null;

    const companyDomain = String(
      row?.company_domain
      || row?.companyDomain
      || row?.domain
      || ""
    ).trim().toLowerCase().replace(/^www\./, "") || null;

    const companyWebsite = String(
      row?.company_website
      || row?.companyWebsite
      || row?.website
      || row?.website_url
      || row?.websiteUrl
      || ""
    ).trim() || null;

    const latestTurnover = row?.latest_turnover ?? row?.latestTurnover ?? row?.turnover ?? null;
    const status = String(row?.status || "active").trim() || "active";
    const source = String(row?.source || defaultSource || "csv").trim() || "csv";

    stmtUpsertMonitoredCompany.run(
      companyNumber,
      companyName,
      companyDomain,
      companyWebsite,
      latestTurnover,
      status,
      source
    );
    upserted += 1;
  }

  return { upserted, skippedInvalid };
});

export function upsertMonitoredCompany(company) {
  const companyDomain = String(
    company?.company_domain
    || company?.companyDomain
    || company?.domain
    || ""
  ).trim().toLowerCase().replace(/^www\./, "") || null;

  const companyWebsite = String(
    company?.company_website
    || company?.companyWebsite
    || company?.website
    || company?.website_url
    || company?.websiteUrl
    || ""
  ).trim() || null;

  stmtUpsertMonitoredCompany.run(
    company.company_number,
    company.company_name,
    companyDomain,
    companyWebsite,
    company.latest_turnover,
    company.status || "active",
    company.source || "csv"
  );
}

export function clearMonitoredCompanyWebsiteHints(companyNumber) {
  const normalized = normalizeCompanyNumber(companyNumber);
  if (!normalized) return 0;
  return stmtClearMonitoredCompanyWebsiteHints.run(normalized).changes;
}

export function upsertMonitoredCompanies(rows, source = "csv") {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      received: 0,
      upserted: 0,
      skipped_invalid: 0,
      source,
    };
  }

  const result = txUpsertMonitoredCompanies(rows, source);
  return {
    received: rows.length,
    upserted: result.upserted,
    skipped_invalid: result.skippedInvalid,
    source,
  };
}

export function getMonitoredCompany(companyNumber) {
  return db.prepare("SELECT * FROM company_monitor WHERE company_number = ?").get(companyNumber);
}

export function listMonitoredCompanyNumbers() {
  return db.prepare("SELECT company_number FROM company_monitor").all().map((row) => row.company_number);
}

export function upsertCompanyChargeSummary(companyNumber, summary, source = "companies_house_api") {
  if (!companyNumber || !summary) return;
  db.prepare(`
    INSERT INTO company_charge_summary (company_number, summary_json, source, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(company_number) DO UPDATE SET
      summary_json = excluded.summary_json,
      source = excluded.source,
      updated_at = datetime('now')
  `).run(String(companyNumber), JSON.stringify(summary), source || "companies_house_api");
}

export function getCompanyChargeSummary(companyNumber, defaultValue = null) {
  if (!companyNumber) return defaultValue;
  const row = db.prepare("SELECT summary_json FROM company_charge_summary WHERE company_number = ?").get(String(companyNumber));
  if (!row?.summary_json) return defaultValue;
  try {
    return JSON.parse(row.summary_json);
  } catch {
    return defaultValue;
  }
}

export function getMonitoredCompanies(filters = {}) {
  let sql = "SELECT * FROM company_monitor WHERE 1=1";
  const params = [];
  if (filters.status) { sql += " AND status = ?"; params.push(filters.status); }
  if (filters.below_threshold !== undefined) { sql += " AND below_threshold = ?"; params.push(filters.below_threshold ? 1 : 0); }
  if (filters.no_filings !== undefined) { sql += " AND no_filings = ?"; params.push(filters.no_filings ? 1 : 0); }
  if (filters.needs_check) {
    sql += " AND (last_checked_at IS NULL OR last_checked_at < datetime('now', '-7 days'))";
    sql += " AND (last_filing_date IS NULL OR date(last_filing_date) > date('now', '-12 months'))";
  }
  if (filters.stale_needs_check) {
    sql += " AND last_filing_date IS NOT NULL";
    sql += " AND date(last_filing_date) <= date('now', '-12 months')";
    sql += " AND (stale_filing_due_at IS NULL OR stale_filing_due_at <= datetime('now'))";
  }

  if (filters.stale_needs_check) {
    sql += " ORDER BY date(last_filing_date) ASC";
  } else {
    sql += " ORDER BY latest_turnover DESC";
  }
  if (filters.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
  if (filters.offset) { sql += " OFFSET ?"; params.push(filters.offset); }
  return db.prepare(sql).all(...params);
}

export function getMonitorStats() {
  return {
    total: db.prepare("SELECT COUNT(*) as c FROM company_monitor").get().c,
    active: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE status = 'active'").get().c,
    below_threshold: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE below_threshold = 1").get().c,
    no_filings: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE no_filings = 1").get().c,
    inactive: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE status IN ('dormant','dissolved','liquidation','inactive')").get().c,
    needs_check: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE last_checked_at IS NULL OR last_checked_at < datetime('now', '-7 days')").get().c,
    stale_due: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE last_filing_date IS NOT NULL AND date(last_filing_date) <= date('now', '-12 months') AND (stale_filing_due_at IS NULL OR stale_filing_due_at <= datetime('now'))").get().c,
    stale_total: db.prepare("SELECT COUNT(*) as c FROM company_monitor WHERE last_filing_date IS NOT NULL AND date(last_filing_date) <= date('now', '-12 months')").get().c,
  };
}

export function updateMonitorCheck(companyNumber, updates) {
  const sets = ["updated_at = datetime('now')", "last_checked_at = datetime('now')"];
  const vals = [];
  for (const [k, v] of Object.entries(updates)) {
    if (k === "company_number") continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(companyNumber);
  db.prepare(`UPDATE company_monitor SET ${sets.join(", ")} WHERE company_number = ?`).run(...vals);
}

export function getMonitoredCompanyCount() {
  return db.prepare("SELECT COUNT(*) as count FROM company_monitor").get().count;
}

// --- Shortlist from Monitor Data ---

export function getShortlistCompanies(filters = {}) {
  let sql = `
    SELECT cm.*, 
      (SELECT COUNT(*) FROM company_filings cf WHERE cf.company_number = cm.company_number) as filing_count,
      (SELECT cf.filing_date FROM company_filings cf WHERE cf.company_number = cm.company_number ORDER BY cf.filing_date DESC LIMIT 1) as latest_filing_date,
      (SELECT cf.turnover FROM company_filings cf WHERE cf.company_number = cm.company_number ORDER BY cf.filing_date DESC LIMIT 1) as latest_filing_turnover
    FROM company_monitor cm
    WHERE cm.status = 'active'
    AND cm.latest_turnover >= ?
  `;
  const params = [filters.min_turnover || 15000000];

  if (filters.below_threshold) {
    sql = sql.replace("AND cm.latest_turnover >= ?", "");
    params.shift();
    sql += " AND cm.below_threshold = 1";
  }

  sql += " ORDER BY cm.latest_turnover DESC";
  if (filters.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
  if (filters.offset) { sql += " OFFSET ?"; params.push(filters.offset); }

  return db.prepare(sql).all(...params);
}

export function getShortlistCount(minTurnover = 15000000) {
  return db.prepare("SELECT COUNT(*) as count FROM company_monitor WHERE status = 'active' AND latest_turnover >= ?").get(minTurnover).count;
}

export function pruneHistoricMonthlyFilingsBefore(cutoffPeriod) {
  const result = db.prepare(`
    DELETE FROM company_filings
    WHERE source LIKE 'monthly:%'
      AND substr(source, 9, 7) < ?
  `).run(cutoffPeriod);

  db.prepare(`
    DELETE FROM company_monitor
    WHERE source LIKE 'monthly:%'
      AND company_number NOT IN (SELECT DISTINCT company_number FROM company_filings)
  `).run();

  return { deleted_filings: result.changes, cutoff_period: cutoffPeriod };
}

// --- Company Groups ---

export function createGroup(name, parentCompanyNumber) {
  const result = db.prepare("INSERT INTO company_groups (group_name, parent_company_number) VALUES (?, ?)").run(name, parentCompanyNumber || null);
  return result.lastInsertRowid;
}

export function addGroupMember(groupId, companyNumber, entityType, relationship) {
  db.prepare(
    "INSERT OR IGNORE INTO company_group_members (group_id, company_number, entity_type, relationship) VALUES (?, ?, ?, ?)"
  ).run(groupId, companyNumber, entityType || "operating", relationship || null);
}

export function getCompanyGroups(companyNumber) {
  return db.prepare(`
    SELECT cg.*, cgm.entity_type, cgm.relationship
    FROM company_groups cg
    JOIN company_group_members cgm ON cg.id = cgm.group_id
    WHERE cgm.company_number = ?
  `).all(companyNumber);
}

export function getGroupMembers(groupId) {
  return db.prepare(`
    SELECT cgm.*, cm.company_name, cm.latest_turnover, cm.status
    FROM company_group_members cgm
    LEFT JOIN company_monitor cm ON cgm.company_number = cm.company_number
    WHERE cgm.group_id = ?
  `).all(groupId);
}

// --- Import Jobs ---

export function createImportJob(id, type, totalItems, metadata) {
  db.prepare(
    "INSERT INTO import_jobs (id, type, status, total_items, started_at, metadata) VALUES (?, ?, 'running', ?, datetime('now'), ?)"
  ).run(id, type, totalItems, JSON.stringify(metadata || {}));
}

export function updateImportJob(id, updates) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(updates)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getImportJob(id) {
  const row = db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, metadata: JSON.parse(row.metadata || "{}") };
}

export function listImportJobs() {
  return db.prepare("SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 50").all().map((r) => ({
    ...r, metadata: JSON.parse(r.metadata || "{}"),
  }));
}

export function addImportLogEntry(jobId, companyNumber, companyName, action, detail, turnover) {
  db.prepare(
    "INSERT INTO import_log (job_id, company_number, company_name, action, detail, turnover) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(jobId, companyNumber, companyName || null, action, detail || null, turnover || null);
}

export function getImportLogs(jobId, limit = 100) {
  return db.prepare("SELECT * FROM import_log WHERE job_id = ? ORDER BY timestamp DESC LIMIT ?").all(jobId, limit);
}

// --- Analysis Queue ---

const stmtUpsertAnalysisQueueItem = db.prepare(`
  INSERT INTO analysis_queue (company_number, company_name, source, status, queued_at, started_at, completed_at, updated_at, last_error)
  VALUES (?, ?, ?, 'queued', datetime('now'), NULL, NULL, datetime('now'), NULL)
  ON CONFLICT(company_number) DO UPDATE SET
    company_name = COALESCE(excluded.company_name, analysis_queue.company_name),
    source = excluded.source,
    status = 'queued',
    queued_at = datetime('now'),
    started_at = NULL,
    completed_at = NULL,
    updated_at = datetime('now'),
    last_error = NULL
`);

const claimNextAnalysisQueueItemTx = db.transaction(() => {
  const next = db.prepare(`
    SELECT * FROM analysis_queue
    WHERE status = 'queued'
    ORDER BY queued_at ASC
    LIMIT 1
  `).get();

  if (!next) return null;

  db.prepare(`
    UPDATE analysis_queue
    SET status = 'processing', started_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
    WHERE company_number = ?
  `).run(next.company_number);

  return db.prepare("SELECT * FROM analysis_queue WHERE company_number = ?").get(next.company_number);
});

const claimAnalysisQueueItemTx = db.transaction((companyNumber) => {
  const next = db.prepare(`
    SELECT * FROM analysis_queue
    WHERE company_number = ? AND status = 'queued'
    LIMIT 1
  `).get(companyNumber);

  if (!next) return null;

  db.prepare(`
    UPDATE analysis_queue
    SET status = 'processing', started_at = datetime('now'), attempts = attempts + 1, updated_at = datetime('now')
    WHERE company_number = ?
  `).run(companyNumber);

  return db.prepare("SELECT * FROM analysis_queue WHERE company_number = ?").get(companyNumber);
});

export function enqueueAnalysisQueueItem(companyNumber, companyName = null, source = "import") {
  if (!companyNumber) return false;
  stmtUpsertAnalysisQueueItem.run(companyNumber, companyName || null, source || "import");
  return true;
}

export function enqueueAnalysisQueueItems(companies, source = "import") {
  if (!Array.isArray(companies) || companies.length === 0) return 0;

  const tx = db.transaction((rows) => {
    let queued = 0;
    for (const row of rows) {
      const companyNumber = typeof row === "string"
        ? row
        : (row.company_number || row.companyNumber || null);
      if (!companyNumber) continue;
      const companyName = typeof row === "string"
        ? null
        : (row.company_name || row.companyName || null);
      stmtUpsertAnalysisQueueItem.run(companyNumber, companyName, source || "import");
      queued++;
    }
    return queued;
  });

  return tx(companies);
}

export function claimNextAnalysisQueueItem() {
  return claimNextAnalysisQueueItemTx();
}

export function claimAnalysisQueueItem(companyNumber) {
  if (!companyNumber) return null;
  return claimAnalysisQueueItemTx(companyNumber);
}

export function markAnalysisQueueItemReady(companyNumber, companyName = null) {
  db.prepare(`
    UPDATE analysis_queue
    SET company_name = COALESCE(?, company_name),
        status = 'ready',
        completed_at = datetime('now'),
        updated_at = datetime('now'),
        last_error = NULL
    WHERE company_number = ?
  `).run(companyName || null, companyNumber);
}

export function markAnalysisQueueItemFailed(companyNumber, errorMessage) {
  db.prepare(`
    UPDATE analysis_queue
    SET status = 'failed',
        completed_at = datetime('now'),
        updated_at = datetime('now'),
        last_error = ?
    WHERE company_number = ?
  `).run((errorMessage || "Unknown analysis error").slice(0, 1000), companyNumber);
}

export function reconcileAnalysisQueueWithStoredAnalyses() {
  const result = db.prepare(`
    UPDATE analysis_queue
    SET status = 'ready',
        completed_at = COALESCE(completed_at, datetime('now')),
        updated_at = datetime('now'),
        last_error = NULL
    WHERE status IN ('queued', 'failed')
      AND EXISTS (
        SELECT 1
        FROM settings s
        WHERE s.key = ('analysis_' || analysis_queue.company_number)
          AND s.value IS NOT NULL
          AND length(trim(s.value)) > 0
      )
  `).run();

  return result.changes;
}

export function resetProcessingAnalysisQueueItems(reason = "Recovered processing jobs after restart") {
  const result = db.prepare(`
    UPDATE analysis_queue
    SET status = 'queued',
        queued_at = datetime('now'),
        started_at = NULL,
        completed_at = NULL,
        updated_at = datetime('now'),
        last_error = COALESCE(last_error, ?)
    WHERE status = 'processing'
  `).run(reason);
  return result.changes;
}

export function getAnalysisQueueItem(companyNumber) {
  return db.prepare("SELECT * FROM analysis_queue WHERE company_number = ?").get(companyNumber);
}

export function getAnalysisQueueItemsByCompanyNumbers(companyNumbers) {
  if (!Array.isArray(companyNumbers) || companyNumbers.length === 0) return {};
  const placeholders = companyNumbers.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM analysis_queue
    WHERE company_number IN (${placeholders})
  `).all(...companyNumbers);
  const map = {};
  for (const row of rows) map[row.company_number] = row;
  return map;
}

export function getAnalysisQueueCounts() {
  const grouped = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM analysis_queue
    GROUP BY status
  `).all();
  const counts = { queued: 0, processing: 0, ready: 0, failed: 0, total: 0 };
  for (const row of grouped) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }
  return counts;
}

export function listAnalysisQueueItems(filters = {}) {
  let sql = "SELECT * FROM analysis_queue WHERE 1=1";
  const params = [];

  if (filters.status) {
    sql += " AND status = ?";
    params.push(filters.status);
  }

  sql += " ORDER BY queued_at ASC, updated_at ASC";

  if (filters.limit) {
    sql += " LIMIT ?";
    params.push(filters.limit);
  }

  return db.prepare(sql).all(...params);
}

export function listFailedAnalysisQueueItems(limit = 500) {
  return listAnalysisQueueItems({ status: "failed", limit });
}

// --- Gemini Handoff Persistence ---

function parseJsonText(value, fallback = null) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

const stmtInsertGeminiHandoffRequest = db.prepare(`
  INSERT INTO gemini_handoff_requests (
    request_id,
    contract_version,
    status,
    accepted_at,
    request_payload,
    request_payload_sha256,
    updated_at
  ) VALUES (?, ?, 'accepted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);

const stmtGetGeminiHandoffRequest = db.prepare(`
  SELECT *
  FROM gemini_handoff_requests
  WHERE request_id = ?
`);

const stmtCompleteGeminiHandoffRequest = db.prepare(`
  UPDATE gemini_handoff_requests
  SET
    status = ?,
    response_payload = ?,
    response_payload_sha256 = ?,
    response_id = ?,
    completed_at = ?,
    updated_at = datetime('now')
  WHERE request_id = ?
`);

const stmtIncrementGeminiHandoffRetry = db.prepare(`
  UPDATE gemini_handoff_requests
  SET
    retry_count = retry_count + 1,
    status = 'retry_requested',
    last_retry_requested_at = datetime('now'),
    updated_at = datetime('now')
  WHERE request_id = ?
`);

const stmtDeleteGeminiApprovalsByRequest = db.prepare(`
  DELETE FROM gemini_handoff_approvals
  WHERE request_id = ?
`);

const stmtIncrementGeminiApprovalRevision = db.prepare(`
  UPDATE gemini_handoff_requests
  SET approvals_revision = approvals_revision + 1,
      updated_at = datetime('now')
  WHERE request_id = ?
    AND approvals_revision = ?
`);

const stmtUpsertGeminiApproval = db.prepare(`
  INSERT INTO gemini_handoff_approvals (
    request_id,
    sequence_id,
    step_number,
    approval_status,
    approved_by,
    approved_at,
    review_notes,
    synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(request_id, sequence_id, step_number) DO UPDATE SET
    approval_status = excluded.approval_status,
    approved_by = excluded.approved_by,
    approved_at = excluded.approved_at,
    review_notes = excluded.review_notes,
    synced_at = datetime('now')
`);

const stmtGetGeminiApprovalCounts = db.prepare(`
  SELECT approval_status, COUNT(*) AS count
  FROM gemini_handoff_approvals
  WHERE request_id = ?
  GROUP BY approval_status
`);

const stmtInsertGeminiHandoffEvent = db.prepare(`
  INSERT INTO gemini_handoff_events (
    request_id,
    event_type,
    event_stage,
    detail,
    created_at
  ) VALUES (?, ?, ?, ?, datetime('now'))
`);

function hydrateGeminiHandoffRequest(row) {
  if (!row) return null;
  return {
    request_id: row.request_id,
    contract_version: row.contract_version,
    status: row.status,
    accepted_at: row.accepted_at,
    approvals_revision: Number(row.approvals_revision || 0),
    retry_count: Number(row.retry_count || 0),
    last_retry_requested_at: row.last_retry_requested_at,
    request: parseJsonText(row.request_payload, {}),
    request_payload_sha256: row.request_payload_sha256 || null,
    response: parseJsonText(row.response_payload, null),
    response_payload_sha256: row.response_payload_sha256 || null,
    response_id: row.response_id,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

const txCreateOrGetGeminiHandoffRequest = db.transaction((payload) => {
  const requestId = String(payload?.request_id || "").trim();
  if (!requestId) return { created: false, record: null };

  const existing = stmtGetGeminiHandoffRequest.get(requestId);
  if (existing) {
    return { created: false, record: hydrateGeminiHandoffRequest(existing) };
  }

  const requestJson = JSON.stringify(payload || {});
  stmtInsertGeminiHandoffRequest.run(
    requestId,
    String(payload.contract_version || ""),
    requestJson,
    sha256Hex(requestJson)
  );

  const inserted = stmtGetGeminiHandoffRequest.get(requestId);
  return { created: true, record: hydrateGeminiHandoffRequest(inserted) };
});

export function createOrGetGeminiHandoffRequest(payload = {}) {
  return txCreateOrGetGeminiHandoffRequest(payload);
}

export function getGeminiHandoffRequest(requestId) {
  const normalized = String(requestId || "").trim();
  if (!normalized) return null;
  return hydrateGeminiHandoffRequest(stmtGetGeminiHandoffRequest.get(normalized));
}

export function listGeminiHandoffRequests(filters = {}) {
  const normalizedStatus = String(filters?.status || "").trim().toLowerCase() || null;
  const normalizedHasResponse = String(filters?.hasResponse ?? "").trim().toLowerCase();
  const hasResponse = normalizedHasResponse === "true"
    ? true
    : normalizedHasResponse === "false"
      ? false
      : null;
  const normalizedHasRetries = String(filters?.hasRetries ?? "").trim().toLowerCase();
  const hasRetries = normalizedHasRetries === "true"
    ? true
    : normalizedHasRetries === "false"
      ? false
      : null;
  const normalizedHasApprovals = String(filters?.hasApprovals ?? "").trim().toLowerCase();
  const hasApprovals = normalizedHasApprovals === "true"
    ? true
    : normalizedHasApprovals === "false"
      ? false
      : null;
  const normalizedHasEvents = String(filters?.hasEvents ?? "").trim().toLowerCase();
  const hasEvents = normalizedHasEvents === "true"
    ? true
    : normalizedHasEvents === "false"
      ? false
      : null;
  const normalizedHasCompleted = String(filters?.hasCompleted ?? "").trim().toLowerCase();
  const hasCompleted = normalizedHasCompleted === "true"
    ? true
    : normalizedHasCompleted === "false"
      ? false
      : null;
  const beforeAcceptedAt = String(filters?.beforeAcceptedAt || "").trim() || null;
  const afterAcceptedAt = String(filters?.afterAcceptedAt || "").trim() || null;
  const beforeUpdatedAt = String(filters?.beforeUpdatedAt || "").trim() || null;
  const afterUpdatedAt = String(filters?.afterUpdatedAt || "").trim() || null;
  const rawMinRetryCount = Number.parseInt(String(filters?.minRetryCount ?? ""), 10);
  const minRetryCount = Number.isInteger(rawMinRetryCount) && rawMinRetryCount >= 0
    ? rawMinRetryCount
    : null;
  const rawMaxRetryCount = Number.parseInt(String(filters?.maxRetryCount ?? ""), 10);
  const maxRetryCount = Number.isInteger(rawMaxRetryCount) && rawMaxRetryCount >= 0
    ? rawMaxRetryCount
    : null;
  const normalizedSort = String(filters?.sort || "accepted_desc").trim().toLowerCase() || "accepted_desc";
  const sort = ["accepted_desc", "accepted_asc", "queue_health"].includes(normalizedSort)
    ? normalizedSort
    : "accepted_desc";
  const limit = Math.max(1, Math.min(200, Number.parseInt(String(filters?.limit || 50), 10) || 50));
  const offset = Math.max(0, Math.min(10000, Number.parseInt(String(filters?.offset || 0), 10) || 0));

  let sql = `
    SELECT
      r.request_id,
      r.contract_version,
      r.status,
      r.accepted_at,
      r.retry_count,
      r.last_retry_requested_at,
      r.request_payload_sha256,
      r.response_payload_sha256,
      r.response_id,
      r.completed_at,
      r.updated_at,
      (
        SELECT COUNT(*)
        FROM gemini_handoff_events e
        WHERE e.request_id = r.request_id
      ) AS event_count,
      (
        SELECT COUNT(*)
        FROM gemini_handoff_approvals a
        WHERE a.request_id = r.request_id
      ) AS approval_count
    FROM gemini_handoff_requests r
  `;
  const params = [];
  const whereClauses = [];

  if (normalizedStatus) {
    whereClauses.push("r.status = ?");
    params.push(normalizedStatus);
  }

  if (hasResponse === true) {
    whereClauses.push("r.response_id IS NOT NULL AND r.response_id <> ''");
  } else if (hasResponse === false) {
    whereClauses.push("(r.response_id IS NULL OR r.response_id = '')");
  }

  if (hasRetries === true) {
    whereClauses.push("r.retry_count > 0");
  } else if (hasRetries === false) {
    whereClauses.push("r.retry_count <= 0");
  }

  if (hasApprovals === true) {
    whereClauses.push("EXISTS (SELECT 1 FROM gemini_handoff_approvals a WHERE a.request_id = r.request_id)");
  } else if (hasApprovals === false) {
    whereClauses.push("NOT EXISTS (SELECT 1 FROM gemini_handoff_approvals a WHERE a.request_id = r.request_id)");
  }

  if (hasEvents === true) {
    whereClauses.push("EXISTS (SELECT 1 FROM gemini_handoff_events e WHERE e.request_id = r.request_id)");
  } else if (hasEvents === false) {
    whereClauses.push("NOT EXISTS (SELECT 1 FROM gemini_handoff_events e WHERE e.request_id = r.request_id)");
  }

  if (hasCompleted === true) {
    whereClauses.push("r.completed_at IS NOT NULL AND r.completed_at <> ''");
  } else if (hasCompleted === false) {
    whereClauses.push("(r.completed_at IS NULL OR r.completed_at = '')");
  }

  if (beforeAcceptedAt) {
    whereClauses.push("julianday(r.accepted_at) < julianday(?)");
    params.push(beforeAcceptedAt);
  }

  if (afterAcceptedAt) {
    whereClauses.push("julianday(r.accepted_at) > julianday(?)");
    params.push(afterAcceptedAt);
  }

  if (beforeUpdatedAt) {
    whereClauses.push("julianday(r.updated_at) < julianday(?)");
    params.push(beforeUpdatedAt);
  }

  if (afterUpdatedAt) {
    whereClauses.push("julianday(r.updated_at) > julianday(?)");
    params.push(afterUpdatedAt);
  }

  if (minRetryCount !== null) {
    whereClauses.push("r.retry_count >= ?");
    params.push(minRetryCount);
  }

  if (maxRetryCount !== null) {
    whereClauses.push("r.retry_count <= ?");
    params.push(maxRetryCount);
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  if (sort === "accepted_asc") {
    sql += " ORDER BY r.accepted_at ASC, r.request_id ASC";
  } else if (sort === "queue_health") {
    sql += `
      ORDER BY
        CASE
          WHEN r.status = 'completed' THEN 0
          WHEN r.status = 'accepted' THEN 1
          WHEN r.status = 'retry_requested' THEN 2
          ELSE 3
        END ASC,
        r.retry_count DESC,
        r.accepted_at DESC,
        r.request_id DESC
    `;
  } else {
    sql += " ORDER BY r.accepted_at DESC, r.request_id DESC";
  }
  sql += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map((row) => ({
    request_id: row.request_id,
    contract_version: row.contract_version,
    status: row.status,
    accepted_at: row.accepted_at,
    approvals_revision: Number(row.approvals_revision || 0),
    retry_count: Number(row.retry_count || 0),
    last_retry_requested_at: row.last_retry_requested_at || null,
    request_payload_sha256: row.request_payload_sha256 || null,
    response_payload_sha256: row.response_payload_sha256 || null,
    response_id: row.response_id || null,
    completed_at: row.completed_at || null,
    updated_at: row.updated_at,
    event_count: Number(row.event_count || 0),
    approval_count: Number(row.approval_count || 0),
  }));
}

export function countGeminiHandoffRequests(filters = {}) {
  const normalizedStatus = String(filters?.status || "").trim().toLowerCase() || null;
  const normalizedHasResponse = String(filters?.hasResponse ?? "").trim().toLowerCase();
  const hasResponse = normalizedHasResponse === "true"
    ? true
    : normalizedHasResponse === "false"
      ? false
      : null;
  const normalizedHasRetries = String(filters?.hasRetries ?? "").trim().toLowerCase();
  const hasRetries = normalizedHasRetries === "true"
    ? true
    : normalizedHasRetries === "false"
      ? false
      : null;
  const normalizedHasApprovals = String(filters?.hasApprovals ?? "").trim().toLowerCase();
  const hasApprovals = normalizedHasApprovals === "true"
    ? true
    : normalizedHasApprovals === "false"
      ? false
      : null;
  const normalizedHasEvents = String(filters?.hasEvents ?? "").trim().toLowerCase();
  const hasEvents = normalizedHasEvents === "true"
    ? true
    : normalizedHasEvents === "false"
      ? false
      : null;
  const normalizedHasCompleted = String(filters?.hasCompleted ?? "").trim().toLowerCase();
  const hasCompleted = normalizedHasCompleted === "true"
    ? true
    : normalizedHasCompleted === "false"
      ? false
      : null;
  const beforeAcceptedAt = String(filters?.beforeAcceptedAt || "").trim() || null;
  const afterAcceptedAt = String(filters?.afterAcceptedAt || "").trim() || null;
  const beforeUpdatedAt = String(filters?.beforeUpdatedAt || "").trim() || null;
  const afterUpdatedAt = String(filters?.afterUpdatedAt || "").trim() || null;
  const rawMinRetryCount = Number.parseInt(String(filters?.minRetryCount ?? ""), 10);
  const minRetryCount = Number.isInteger(rawMinRetryCount) && rawMinRetryCount >= 0
    ? rawMinRetryCount
    : null;
  const rawMaxRetryCount = Number.parseInt(String(filters?.maxRetryCount ?? ""), 10);
  const maxRetryCount = Number.isInteger(rawMaxRetryCount) && rawMaxRetryCount >= 0
    ? rawMaxRetryCount
    : null;

  const whereClauses = [];
  const params = [];

  if (normalizedStatus) {
    whereClauses.push("status = ?");
    params.push(normalizedStatus);
  }

  if (hasResponse === true) {
    whereClauses.push("response_id IS NOT NULL AND response_id <> ''");
  } else if (hasResponse === false) {
    whereClauses.push("(response_id IS NULL OR response_id = '')");
  }

  if (hasRetries === true) {
    whereClauses.push("retry_count > 0");
  } else if (hasRetries === false) {
    whereClauses.push("retry_count <= 0");
  }

  if (hasApprovals === true) {
    whereClauses.push("EXISTS (SELECT 1 FROM gemini_handoff_approvals a WHERE a.request_id = gemini_handoff_requests.request_id)");
  } else if (hasApprovals === false) {
    whereClauses.push("NOT EXISTS (SELECT 1 FROM gemini_handoff_approvals a WHERE a.request_id = gemini_handoff_requests.request_id)");
  }

  if (hasEvents === true) {
    whereClauses.push("EXISTS (SELECT 1 FROM gemini_handoff_events e WHERE e.request_id = gemini_handoff_requests.request_id)");
  } else if (hasEvents === false) {
    whereClauses.push("NOT EXISTS (SELECT 1 FROM gemini_handoff_events e WHERE e.request_id = gemini_handoff_requests.request_id)");
  }

  if (hasCompleted === true) {
    whereClauses.push("completed_at IS NOT NULL AND completed_at <> ''");
  } else if (hasCompleted === false) {
    whereClauses.push("(completed_at IS NULL OR completed_at = '')");
  }

  if (beforeAcceptedAt) {
    whereClauses.push("julianday(accepted_at) < julianday(?)");
    params.push(beforeAcceptedAt);
  }

  if (afterAcceptedAt) {
    whereClauses.push("julianday(accepted_at) > julianday(?)");
    params.push(afterAcceptedAt);
  }

  if (beforeUpdatedAt) {
    whereClauses.push("julianday(updated_at) < julianday(?)");
    params.push(beforeUpdatedAt);
  }

  if (afterUpdatedAt) {
    whereClauses.push("julianday(updated_at) > julianday(?)");
    params.push(afterUpdatedAt);
  }

  if (minRetryCount !== null) {
    whereClauses.push("retry_count >= ?");
    params.push(minRetryCount);
  }

  if (maxRetryCount !== null) {
    whereClauses.push("retry_count <= ?");
    params.push(maxRetryCount);
  }

  let sql = "SELECT COUNT(*) AS count FROM gemini_handoff_requests";
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  const row = db.prepare(sql).get(...params);
  return Number(row?.count || 0);
}

export function getGeminiHandoffStatusCounts() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM gemini_handoff_requests
    GROUP BY status
  `).all();

  const counts = {
    accepted: 0,
    completed: 0,
    retry_requested: 0,
    failed: 0,
    unknown: 0,
  };

  for (const row of rows) {
    const status = String(row?.status || "").trim().toLowerCase();
    const count = Number(row?.count || 0);
    if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] = count;
    } else {
      counts.unknown += count;
    }
  }

  return counts;
}

export function getGeminiHandoffRetryCounts(options = {}) {
  const retryLimitRaw = Number.parseInt(String(options?.retryLimit || 5), 10);
  const retryLimit = Number.isInteger(retryLimitRaw)
    ? Math.max(1, Math.min(retryLimitRaw, 100))
    : 5;

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS requests_with_retries,
      COALESCE(SUM(retry_count), 0) AS total_retry_attempts,
      SUM(CASE WHEN retry_count >= ? THEN 1 ELSE 0 END) AS at_or_above_retry_limit
    FROM gemini_handoff_requests
  `).get(retryLimit);

  return {
    retry_limit: retryLimit,
    requests_with_retries: Number(row?.requests_with_retries || 0),
    total_retry_attempts: Number(row?.total_retry_attempts || 0),
    at_or_above_retry_limit: Number(row?.at_or_above_retry_limit || 0),
  };
}

export function getGeminiHandoffOperationalSummary(options = {}) {
  const recentHoursRaw = Number.parseInt(String(options?.recentHours || 24), 10);
  const recentHours = Number.isInteger(recentHoursRaw)
    ? Math.max(1, Math.min(recentHoursRaw, 168))
    : 24;
  const retryLimitRaw = Number.parseInt(String(options?.retryLimit || 5), 10);
  const retryLimit = Number.isInteger(retryLimitRaw)
    ? Math.max(1, Math.min(retryLimitRaw, 100))
    : 5;

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM gemini_handoff_requests
  `).get();

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM gemini_handoff_requests
    GROUP BY status
  `).all();

  const retryCounts = getGeminiHandoffRetryCounts({ retryLimit });

  const recentEventRows = db.prepare(`
    SELECT event_type, COUNT(*) AS count
    FROM gemini_handoff_events
    WHERE created_at >= datetime('now', ?)
    GROUP BY event_type
  `).all(`-${recentHours} hours`);

  const statusCounts = {};
  for (const row of statusRows) {
    const key = String(row.status || "").trim().toLowerCase() || "unknown";
    statusCounts[key] = Number(row.count || 0);
  }

  const recentEventCounts = {};
  for (const row of recentEventRows) {
    const key = String(row.event_type || "").trim();
    if (!key) continue;
    recentEventCounts[key] = Number(row.count || 0);
  }

  return {
    generated_at: new Date().toISOString(),
    totals: {
      total_requests: Number(totalRow?.count || 0),
      status_counts: statusCounts,
    },
    retry: {
      max_retry_count: retryCounts.retry_limit,
      requests_with_retries: retryCounts.requests_with_retries,
      total_retry_attempts: retryCounts.total_retry_attempts,
      at_or_above_retry_limit: retryCounts.at_or_above_retry_limit,
    },
    recent_window_hours: recentHours,
    recent_event_counts: recentEventCounts,
  };
}

export function completeGeminiHandoffRequest(requestId, responsePayload = {}) {
  const normalized = String(requestId || "").trim();
  if (!normalized) return null;

  const mappedStatus = String(responsePayload?.status || "").trim().toLowerCase() === "ok"
    ? "completed"
    : String(responsePayload?.status || "partial").trim().toLowerCase();

  const responseJson = JSON.stringify(responsePayload || {});

  stmtCompleteGeminiHandoffRequest.run(
    mappedStatus || "partial",
    responseJson,
    sha256Hex(responseJson),
    String(responsePayload?.response_id || "") || null,
    String(responsePayload?.completed_at || "") || null,
    normalized
  );

  return getGeminiHandoffRequest(normalized);
}

export function incrementGeminiHandoffRetry(requestId) {
  const normalized = String(requestId || "").trim();
  if (!normalized) return null;
  stmtIncrementGeminiHandoffRetry.run(normalized);
  return getGeminiHandoffRequest(normalized);
}

export function replaceGeminiHandoffApprovals(requestId, approvals = [], options = {}) {
  const normalized = String(requestId || "").trim();
  if (!normalized) {
    return {
      updated: false,
      conflict: false,
      upserted: 0,
      approvals_revision: 0,
      current_revision: 0,
    };
  }

  const expectedRevisionRaw = options?.expectedRevision;
  const hasExpectedRevision = Number.isInteger(expectedRevisionRaw) && expectedRevisionRaw >= 0;

  const tx = db.transaction((rows) => {
    const current = stmtGetGeminiHandoffRequest.get(normalized);
    const currentRevision = Number(current?.approvals_revision || 0);

    if (hasExpectedRevision && expectedRevisionRaw !== currentRevision) {
      return {
        updated: false,
        conflict: true,
        upserted: 0,
        approvals_revision: currentRevision,
        current_revision: currentRevision,
      };
    }

    stmtDeleteGeminiApprovalsByRequest.run(normalized);
    let upserted = 0;
    for (const row of rows) {
      const sequenceId = String(row?.sequence_id || "").trim();
      const stepNumber = Number.parseInt(String(row?.step_number || ""), 10);
      const approvalStatus = String(row?.approval_status || "").trim().toLowerCase();
      if (!sequenceId || !Number.isInteger(stepNumber) || stepNumber <= 0 || !approvalStatus) continue;

      stmtUpsertGeminiApproval.run(
        normalized,
        sequenceId,
        stepNumber,
        approvalStatus,
        row?.approved_by ? String(row.approved_by) : null,
        row?.approved_at ? String(row.approved_at) : null,
        row?.review_notes ? String(row.review_notes) : null
      );
      upserted += 1;
    }

    const revisionResult = stmtIncrementGeminiApprovalRevision.run(normalized, currentRevision);
    if (Number(revisionResult.changes || 0) < 1) {
      const refreshed = stmtGetGeminiHandoffRequest.get(normalized);
      const refreshedRevision = Number(refreshed?.approvals_revision || currentRevision);
      return {
        updated: false,
        conflict: true,
        upserted: 0,
        approvals_revision: refreshedRevision,
        current_revision: refreshedRevision,
      };
    }

    return {
      updated: true,
      conflict: false,
      upserted,
      approvals_revision: currentRevision + 1,
      current_revision: currentRevision + 1,
    };
  });

  return tx(Array.isArray(approvals) ? approvals : []);
}

export function getGeminiHandoffApprovalCounts(requestId) {
  const normalized = String(requestId || "").trim();
  if (!normalized) {
    return { total: 0, approved: 0, rejected: 0, pending: 0, sent: 0, paused: 0 };
  }

  const grouped = stmtGetGeminiApprovalCounts.all(normalized);
  const counts = { total: 0, approved: 0, rejected: 0, pending: 0, sent: 0, paused: 0 };
  for (const row of grouped) {
    const status = String(row.approval_status || "").toLowerCase();
    const value = Number(row.count || 0);
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] = value;
      counts.total += value;
    }
  }
  return counts;
}

export function addGeminiHandoffEvent(requestId, eventType, eventStage = null, detail = null) {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedType = String(eventType || "").trim();
  if (!normalizedRequestId || !normalizedType) return null;

  const stage = String(eventStage || "").trim() || null;
  const safeDetail = detail && typeof detail === "object"
    ? JSON.stringify(detail)
    : (detail === null || detail === undefined ? null : String(detail));

  const result = stmtInsertGeminiHandoffEvent.run(
    normalizedRequestId,
    normalizedType,
    stage,
    safeDetail
  );

  return Number(result.lastInsertRowid || 0) || null;
}

export function listGeminiHandoffEvents(requestId, options = 100) {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) return [];
  const optionsObject = (options && typeof options === "object") ? options : { limit: options };
  const safeLimit = Math.max(1, Math.min(500, Number.parseInt(String(optionsObject.limit || 100), 10) || 100));
  const beforeId = Number.parseInt(String(optionsObject.beforeId || ""), 10);
  const hasBeforeId = Number.isInteger(beforeId) && beforeId > 0;
  const eventType = String(optionsObject.eventType || "").trim() || null;
  const eventStage = String(optionsObject.eventStage || "").trim() || null;

  let sql = `
    SELECT id, request_id, event_type, event_stage, detail, created_at
    FROM gemini_handoff_events
    WHERE request_id = ?
  `;
  const params = [normalizedRequestId];

  if (hasBeforeId) {
    sql += " AND id < ?";
    params.push(beforeId);
  }

  if (eventType) {
    sql += " AND event_type = ?";
    params.push(eventType);
  }

  if (eventStage) {
    sql += " AND event_stage = ?";
    params.push(eventStage);
  }

  sql += " ORDER BY id DESC LIMIT ?";
  params.push(safeLimit);

  return db.prepare(sql).all(...params).map((row) => {
    let parsedDetail = null;
    if (typeof row.detail === "string" && row.detail.trim()) {
      try {
        parsedDetail = JSON.parse(row.detail);
      } catch {
        parsedDetail = row.detail;
      }
    }

    return {
      id: Number(row.id || 0),
      request_id: row.request_id,
      event_type: row.event_type,
      event_stage: row.event_stage || null,
      detail: parsedDetail,
      created_at: row.created_at,
    };
  });
}

export function closeDb() {
  db.close();
}

export default db;
