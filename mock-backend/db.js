import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "mock-backend", "onemonetry.db");

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
    excluded_company_ids TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS cadence_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
`);

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
  if (!row) {
    return {
      prohibited_industries: ["Gambling", "Tobacco", "Weapons", "Adult Entertainment"],
      excluded_company_ids: [],
    };
  }
  return {
    prohibited_industries: JSON.parse(row.prohibited_industries),
    excluded_company_ids: JSON.parse(row.excluded_company_ids),
  };
}

export function setExclusions(exclusions) {
  db.prepare(`
    INSERT INTO exclusions (id, prohibited_industries, excluded_company_ids) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET prohibited_industries = excluded.prohibited_industries, excluded_company_ids = excluded.excluded_company_ids
  `).run(JSON.stringify(exclusions.prohibited_industries), JSON.stringify(exclusions.excluded_company_ids));
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

export function closeDb() {
  db.close();
}

export default db;
