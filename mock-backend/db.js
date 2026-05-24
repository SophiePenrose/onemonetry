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
    last_checked_at TEXT,
    last_filing_date TEXT,
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

export function getFilingsForCompany(companyNumber, limit = 20) {
  return db.prepare("SELECT * FROM company_filings WHERE company_number = ? ORDER BY filing_date DESC LIMIT ?").all(companyNumber, limit);
}

export function getLatestFiling(companyNumber) {
  return db.prepare("SELECT * FROM company_filings WHERE company_number = ? ORDER BY filing_date DESC LIMIT 1").get(companyNumber);
}

export function getFilingCount() {
  return db.prepare("SELECT COUNT(*) as count FROM company_filings").get().count;
}

// --- Company Monitor ---

export function upsertMonitoredCompany(company) {
  db.prepare(`
    INSERT INTO company_monitor (company_number, company_name, latest_turnover, status, source, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_number) DO UPDATE SET
      company_name = COALESCE(excluded.company_name, company_monitor.company_name),
      latest_turnover = COALESCE(excluded.latest_turnover, company_monitor.latest_turnover),
      status = COALESCE(excluded.status, company_monitor.status),
      updated_at = datetime('now')
  `).run(company.company_number, company.company_name, company.latest_turnover, company.status || "active", company.source || "csv");
}

export function getMonitoredCompany(companyNumber) {
  return db.prepare("SELECT * FROM company_monitor WHERE company_number = ?").get(companyNumber);
}

export function getMonitoredCompanies(filters = {}) {
  let sql = "SELECT * FROM company_monitor WHERE 1=1";
  const params = [];
  if (filters.status) { sql += " AND status = ?"; params.push(filters.status); }
  if (filters.below_threshold !== undefined) { sql += " AND below_threshold = ?"; params.push(filters.below_threshold ? 1 : 0); }
  if (filters.no_filings !== undefined) { sql += " AND no_filings = ?"; params.push(filters.no_filings ? 1 : 0); }
  if (filters.needs_check) {
    sql += " AND (last_checked_at IS NULL OR last_checked_at < datetime('now', '-7 days'))";
  }
  sql += " ORDER BY latest_turnover DESC";
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
      (SELECT cf.turnover FROM company_filings cf WHERE cf.company_number = cm.company_number ORDER BY cf.filing_date DESC LIMIT 1) as latest_filing_turnover,
      EXISTS(SELECT 1 FROM company_filings cf WHERE cf.company_number = cm.company_number AND cf.raw_data IS NOT NULL) as has_filing_text,
      EXISTS(SELECT 1 FROM settings s WHERE s.key = 'analysis_' || cm.company_number) as analysis_ready
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

export function closeDb() {
  db.close();
}

export default db;
