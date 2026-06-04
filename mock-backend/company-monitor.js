import {
  getMonitoredCompanies,
  updateMonitorCheck,
  upsertFiling,
  upsertMonitoredCompanies,
  getMonitorStats,
  getMonitoredCompanyCount,
  getSetting,
  setSetting,
} from "./db.js";
import { lookupCompany, lookupCompanyOwnership, isCompaniesHouseConfigured } from "./companies-house.js";
import { parseCsvRow, parseNonEmptyCsvLines } from "./csv-utils.js";
import { UK_TIMEZONE, getNextWeeklyZonedRun } from "./timezone-schedule.js";

const TURNOVER_THRESHOLD = 15_000_000;
const INACTIVE_STATUSES = ["dissolved", "liquidation", "converted-closed", "voluntary-arrangement", "insolvency-proceedings"];
const API_DELAY_MS = parseInt(process.env.CH_API_DELAY_MS || "600");
const BATCH_SIZE = parseInt(process.env.CH_MONITOR_BATCH_SIZE || "50");
const STALE_FILING_MONTHS = parseInt(process.env.STALE_FILING_MONTHS || "12");
const STALE_LOOKUP_INTERVAL_DAYS = parseInt(process.env.STALE_LOOKUP_INTERVAL_DAYS || "14");
const STALE_MONITOR_CHECK_INTERVAL_MS = parseInt(
  process.env.STALE_MONITOR_CHECK_INTERVAL_MS || String(24 * 60 * 60 * 1000)
);
const OWNERSHIP_STALE_DAYS = Math.max(1, Number.parseInt(process.env.OWNERSHIP_STALE_DAYS || "14", 10) || 14);
const OWNERSHIP_STALE_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.OWNERSHIP_STALE_BATCH_SIZE || "100", 10) || 100);
const OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS = Math.max(
  60000,
  Number.parseInt(process.env.OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10)
  || (24 * 60 * 60 * 1000)
);

let monitorRunning = false;
let monitorProgress = null;
let staleMonitorRunning = false;
let staleMonitorProgress = null;
let ownershipStaleMonitorRunning = false;
let ownershipStaleMonitorProgress = null;

export function getMonitorProgress() {
  return monitorProgress;
}

export function isMonitorRunning() {
  return monitorRunning;
}

export function getStaleMonitorProgress() {
  return staleMonitorProgress;
}

export function isStaleMonitorRunning() {
  return staleMonitorRunning;
}

export function getOwnershipStaleMonitorProgress() {
  return ownershipStaleMonitorProgress;
}

export function isOwnershipStaleMonitorRunning() {
  return ownershipStaleMonitorRunning;
}

function anyMonitorRunning() {
  return monitorRunning || staleMonitorRunning || ownershipStaleMonitorRunning;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildStaleDueAtIso(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setDate(next.getDate() + STALE_LOOKUP_INTERVAL_DAYS);
  return next.toISOString();
}

function getOwnershipSnapshot(companyNumber) {
  if (!companyNumber) return null;
  return getSetting(`ownership_${companyNumber}`, null);
}

function parseOwnershipSnapshotTimestamp(snapshot) {
  const raw = snapshot?.updated_at || snapshot?.fetched_at;
  if (!raw) return null;
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? ts : null;
}

function isOwnershipSnapshotStale(snapshot, nowMs = Date.now()) {
  const timestamp = parseOwnershipSnapshotTimestamp(snapshot);
  if (timestamp === null) return true;
  return nowMs - timestamp >= OWNERSHIP_STALE_DAYS * 24 * 60 * 60 * 1000;
}

const OWNERSHIP_CHANGE_FIELDS = [
  "structure",
  "parent_company",
  "parent_country",
  "psc_total_count",
  "corporate_controller_count",
  "significant_corporate_controllers_count",
  "non_uk_significant_corporate_controllers_count",
  "governing_law_non_uk_present",
  "confidence",
  "controllers_fingerprint",
];

const OWNERSHIP_HIGH_IMPACT_FIELDS = [
  "structure",
  "parent_company",
  "parent_country",
  "governing_law_non_uk_present",
  "corporate_controller_count",
  "non_uk_significant_corporate_controllers_count",
];

function normalizeOwnershipText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function normalizeOwnershipCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildControllersFingerprint(snapshot) {
  const controllers = Array.isArray(snapshot?.significant_corporate_controllers)
    ? snapshot.significant_corporate_controllers
    : [];

  return controllers
    .slice(0, 20)
    .map((controller) => [
      normalizeOwnershipText(controller?.name),
      normalizeOwnershipText(controller?.country_registered),
      normalizeOwnershipText(controller?.kind),
      controller?.non_uk_jurisdiction ? "1" : "0",
    ].join("|"))
    .join("||");
}

function buildOwnershipComparable(snapshot) {
  return {
    structure: normalizeOwnershipText(snapshot?.structure),
    parent_company: normalizeOwnershipText(snapshot?.parent_company),
    parent_country: normalizeOwnershipText(snapshot?.parent_country),
    psc_total_count: normalizeOwnershipCount(snapshot?.psc_total_count),
    corporate_controller_count: normalizeOwnershipCount(snapshot?.corporate_controller_count),
    significant_corporate_controllers_count: normalizeOwnershipCount(snapshot?.significant_corporate_controllers_count),
    non_uk_significant_corporate_controllers_count: normalizeOwnershipCount(snapshot?.non_uk_significant_corporate_controllers_count),
    governing_law_non_uk_present: Boolean(snapshot?.governing_law_non_uk_present),
    confidence: normalizeOwnershipText(snapshot?.confidence),
    controllers_fingerprint: buildControllersFingerprint(snapshot),
  };
}

function detectOwnershipChanges(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot) {
    return {
      changeDetected: false,
      changedFields: [],
      baselined: true,
    };
  }

  const previousComparable = buildOwnershipComparable(previousSnapshot);
  const nextComparable = buildOwnershipComparable(nextSnapshot);
  const changedFields = OWNERSHIP_CHANGE_FIELDS.filter(
    (field) => previousComparable[field] !== nextComparable[field]
  );

  return {
    changeDetected: changedFields.length > 0,
    changedFields,
    baselined: false,
  };
}

function getOwnershipStaleCompanies(limit = OWNERSHIP_STALE_BATCH_SIZE) {
  const maxRows = Math.max(1, Number.parseInt(String(limit || OWNERSHIP_STALE_BATCH_SIZE), 10) || OWNERSHIP_STALE_BATCH_SIZE);
  const staleRows = [];
  const nowMs = Date.now();
  let offset = 0;
  const pageSize = Math.max(100, maxRows);

  while (staleRows.length < maxRows) {
    const rows = getMonitoredCompanies({
      status: "active",
      limit: pageSize,
      offset,
    });
    if (!rows.length) break;
    offset += rows.length;

    for (const row of rows) {
      const snapshot = getOwnershipSnapshot(row.company_number);
      if (!isOwnershipSnapshotStale(snapshot, nowMs)) continue;
      staleRows.push(row);
      if (staleRows.length >= maxRows) break;
    }

    if (rows.length < pageSize) break;
  }

  return staleRows;
}

function parseOwnershipChangeTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeOwnershipChangeFieldToken(value) {
  const token = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!token) return null;
  return OWNERSHIP_CHANGE_FIELDS.includes(token) ? token : null;
}

function parseOwnershipChangeFieldFilter(rawValue) {
  const sourceValues = Array.isArray(rawValue) ? rawValue : [rawValue];
  const parsedTokens = [];

  for (const source of sourceValues) {
    const parts = String(source || "").split(",");
    for (const part of parts) {
      const token = normalizeOwnershipChangeFieldToken(part);
      if (token) parsedTokens.push(token);
    }
  }

  return [...new Set(parsedTokens)];
}

function parseOwnershipImpactFilter(rawValue) {
  const token = String(rawValue || "").trim().toLowerCase();
  if (token === "high" || token === "standard") return token;
  return "all";
}

function parseOwnershipChangeSort(rawValue) {
  const token = String(rawValue || "").trim().toLowerCase();
  if (token === "impact") return "impact";
  return "recent";
}

function getOwnershipImpactLevel(changedFields) {
  if (Array.isArray(changedFields) && changedFields.some((field) => OWNERSHIP_HIGH_IMPACT_FIELDS.includes(field))) {
    return "high";
  }
  return "standard";
}

export function listOwnershipChangedCompanies(options = {}) {
  const requestedLimit = Number.parseInt(String(options.limit || "100"), 10);
  const requestedOffset = Number.parseInt(String(options.offset || "0"), 10);
  const requestedSinceDays = Number.parseInt(
    String(options.since_days ?? options.sinceDays ?? "30"),
    10
  );
  const changedFieldsFilter = parseOwnershipChangeFieldFilter(
    options.changed_field ?? options.changed_fields ?? options.changedFields
  );
  const impactFilter = parseOwnershipImpactFilter(options.impact);
  const sortMode = parseOwnershipChangeSort(options.sort);

  const limit = Math.max(1, Math.min(500, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  const sinceDays = Math.max(1, Number.isFinite(requestedSinceDays) ? requestedSinceDays : 30);
  const sinceMs = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);

  const companies = getMonitoredCompanies({ status: "active" });
  const changedRows = [];
  const changedFieldCounts = {};
  const impactCounts = {
    high: 0,
    standard: 0,
  };

  for (const company of companies) {
    const snapshot = getOwnershipSnapshot(company.company_number);
    if (!snapshot?.change_detected) continue;

    const changedFields = Array.isArray(snapshot?.changed_fields)
      ? snapshot.changed_fields.map((field) => normalizeOwnershipChangeFieldToken(field)).filter(Boolean)
      : [];

    const lastChangedAt = snapshot?.last_changed_at || null;
    const lastChangedMs = parseOwnershipChangeTimestamp(lastChangedAt);
    if (lastChangedMs !== null && lastChangedMs < sinceMs) continue;

    for (const field of changedFields) {
      changedFieldCounts[field] = Number(changedFieldCounts[field] || 0) + 1;
    }

    const impactLevel = getOwnershipImpactLevel(changedFields);
    impactCounts[impactLevel] = Number(impactCounts[impactLevel] || 0) + 1;

    if (changedFieldsFilter.length > 0 && !changedFields.some((field) => changedFieldsFilter.includes(field))) {
      continue;
    }
    if (impactFilter !== "all" && impactLevel !== impactFilter) {
      continue;
    }

    changedRows.push({
      company_number: company.company_number,
      company_name: company.company_name || null,
      change_detected: true,
      changed_fields: changedFields,
      impact_level: impactLevel,
      last_changed_at: lastChangedAt,
      last_checked_at: snapshot?.last_checked_at || snapshot?.updated_at || snapshot?.fetched_at || null,
      structure: snapshot?.structure || null,
      parent_company: snapshot?.parent_company || null,
      parent_country: snapshot?.parent_country || null,
      confidence: snapshot?.confidence || null,
      significant_corporate_controllers_count: Number(snapshot?.significant_corporate_controllers_count || 0),
      non_uk_significant_corporate_controllers_count: Number(snapshot?.non_uk_significant_corporate_controllers_count || 0),
      source: snapshot?.source || null,
    });
  }

  changedRows.sort((a, b) => {
    if (sortMode === "impact") {
      const aImpactRank = a.impact_level === "high" ? 0 : 1;
      const bImpactRank = b.impact_level === "high" ? 0 : 1;
      if (aImpactRank !== bImpactRank) return aImpactRank - bImpactRank;
    }

    const aTs = parseOwnershipChangeTimestamp(a.last_changed_at) || 0;
    const bTs = parseOwnershipChangeTimestamp(b.last_changed_at) || 0;
    if (bTs !== aTs) return bTs - aTs;
    return String(a.company_number || "").localeCompare(String(b.company_number || ""));
  });

  return {
    total: changedRows.length,
    limit,
    offset,
    since_days: sinceDays,
    sort: sortMode,
    changed_fields_filter: changedFieldsFilter,
    changed_fields_counts: changedFieldCounts,
    impact_filter: impactFilter,
    impact_counts: impactCounts,
    rows: changedRows.slice(offset, offset + limit),
  };
}

function getNewFilingsSince(chData, lastFilingDate) {
  return (chData.recent_filings || []).filter((f) => {
    if (!lastFilingDate) return true;
    return f.date > lastFilingDate;
  });
}

function persistNewFilings(companyNumber, filings, source) {
  for (const filing of filings) {
    upsertFiling({
      company_number: companyNumber,
      filing_date: filing.date,
      description: filing.description,
      filing_type: filing.type,
      barcode: filing.barcode || `ch-${companyNumber}-${filing.date}`,
      source,
    });
  }
}

export async function runWeeklyMonitorBatch(batchSize = BATCH_SIZE) {
  if (!isCompaniesHouseConfigured()) {
    return { error: "Companies House API key not set (COMPANIES_HOUSE_API_KEY or CH_API_KEY)" };
  }

  if (anyMonitorRunning()) {
    return { error: "Monitor already running", progress: monitorProgress, stale_progress: staleMonitorProgress };
  }

  monitorRunning = true;
  const companies = getMonitoredCompanies({ needs_check: true, limit: batchSize });

  monitorProgress = {
    started_at: new Date().toISOString(),
    total: companies.length,
    checked: 0,
    new_filings: 0,
    below_threshold: 0,
    inactive: 0,
    errors: 0,
    no_filings: 0,
  };

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    try {
      const chData = await lookupCompany(company.company_number);
      if (chData.error) {
        monitorProgress.errors++;
        updateMonitorCheck(company.company_number, { notes: `API error: ${chData.message}` });
        continue;
      }

      if (INACTIVE_STATUSES.includes(chData.status)) {
        monitorProgress.inactive++;
        updateMonitorCheck(company.company_number, {
          status: chData.status,
          notes: `Marked inactive: ${chData.status}`,
        });
        continue;
      }

      if (chData.name && chData.name !== company.company_name) {
        updateMonitorCheck(company.company_number, { company_name: chData.name });
      }

      const newFilings = getNewFilingsSince(chData, company.last_filing_date);

      if (newFilings.length > 0) {
        monitorProgress.new_filings += newFilings.length;
        persistNewFilings(company.company_number, newFilings, "weekly_monitor");
        updateMonitorCheck(company.company_number, {
          last_filing_date: newFilings[0].date,
          no_filings: 0,
          stale_filing_checked_at: null,
          stale_filing_due_at: null,
        });
      } else {
        if (!company.last_filing_date) {
          monitorProgress.no_filings++;
          updateMonitorCheck(company.company_number, { no_filings: 1, notes: "No accounts filings found" });
        }
      }

      if (chData.turnover_hint && chData.turnover_hint < TURNOVER_THRESHOLD) {
        monitorProgress.below_threshold++;
        updateMonitorCheck(company.company_number, {
          previous_turnover: company.latest_turnover,
          latest_turnover: chData.turnover_hint,
          below_threshold: 1,
          notes: `Turnover dropped below £15M threshold (£${(chData.turnover_hint / 1e6).toFixed(1)}M)`,
        });
      }
    } catch (err) {
      monitorProgress.errors++;
      updateMonitorCheck(company.company_number, { notes: `Monitor error: ${err.message}` });
    }

    monitorProgress.checked = i + 1;
    await sleep(API_DELAY_MS);
  }

  monitorProgress.completed_at = new Date().toISOString();
  monitorRunning = false;

  return { ...monitorProgress };
}

export async function runStaleFilingFortnightlyBatch(batchSize = BATCH_SIZE) {
  if (!isCompaniesHouseConfigured()) {
    return { error: "Companies House API key not set (COMPANIES_HOUSE_API_KEY or CH_API_KEY)" };
  }

  if (anyMonitorRunning()) {
    return { error: "Monitor already running", progress: monitorProgress, stale_progress: staleMonitorProgress };
  }

  staleMonitorRunning = true;
  const companies = getMonitoredCompanies({ stale_needs_check: true, limit: batchSize });

  staleMonitorProgress = {
    started_at: new Date().toISOString(),
    total: companies.length,
    checked: 0,
    new_filings: 0,
    still_stale: 0,
    inactive: 0,
    errors: 0,
  };

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    try {
      const chData = await lookupCompany(company.company_number);
      if (chData.error) {
        staleMonitorProgress.errors++;
        updateMonitorCheck(company.company_number, {
          notes: `Stale filing lookup API error: ${chData.message}`,
          stale_filing_checked_at: new Date().toISOString(),
          stale_filing_due_at: buildStaleDueAtIso(),
        });
        continue;
      }

      if (INACTIVE_STATUSES.includes(chData.status)) {
        staleMonitorProgress.inactive++;
        updateMonitorCheck(company.company_number, {
          status: chData.status,
          notes: `Marked inactive during stale filing check: ${chData.status}`,
          stale_filing_checked_at: new Date().toISOString(),
          stale_filing_due_at: null,
        });
        continue;
      }

      if (chData.name && chData.name !== company.company_name) {
        updateMonitorCheck(company.company_number, { company_name: chData.name });
      }

      const newFilings = getNewFilingsSince(chData, company.last_filing_date);
      if (newFilings.length > 0) {
        staleMonitorProgress.new_filings += newFilings.length;
        persistNewFilings(company.company_number, newFilings, "stale_filing_monitor");
        updateMonitorCheck(company.company_number, {
          last_filing_date: newFilings[0].date,
          no_filings: 0,
          notes: "New filing found during stale filing lookup",
          stale_filing_checked_at: new Date().toISOString(),
          stale_filing_due_at: null,
        });
      } else {
        staleMonitorProgress.still_stale++;
        updateMonitorCheck(company.company_number, {
          notes: `No new filing found (> ${STALE_FILING_MONTHS} months stale). Rechecking in ${STALE_LOOKUP_INTERVAL_DAYS} days.`,
          stale_filing_checked_at: new Date().toISOString(),
          stale_filing_due_at: buildStaleDueAtIso(),
        });
      }
    } catch (err) {
      staleMonitorProgress.errors++;
      updateMonitorCheck(company.company_number, {
        notes: `Stale filing monitor error: ${err.message}`,
        stale_filing_checked_at: new Date().toISOString(),
        stale_filing_due_at: buildStaleDueAtIso(),
      });
    }

    staleMonitorProgress.checked = i + 1;
    await sleep(API_DELAY_MS);
  }

  staleMonitorProgress.completed_at = new Date().toISOString();
  staleMonitorRunning = false;

  return { ...staleMonitorProgress };
}

export async function runOwnershipStaleBatch(batchSize = OWNERSHIP_STALE_BATCH_SIZE) {
  if (!isCompaniesHouseConfigured()) {
    return { error: "Companies House API key not set (COMPANIES_HOUSE_API_KEY or CH_API_KEY)" };
  }

  if (anyMonitorRunning()) {
    return {
      error: "Monitor already running",
      progress: monitorProgress,
      stale_progress: staleMonitorProgress,
      ownership_progress: ownershipStaleMonitorProgress,
    };
  }

  ownershipStaleMonitorRunning = true;
  const companies = getOwnershipStaleCompanies(batchSize);

  ownershipStaleMonitorProgress = {
    started_at: new Date().toISOString(),
    total: companies.length,
    checked: 0,
    refreshed: 0,
    changed: 0,
    unchanged: 0,
    baselined: 0,
    missing_snapshot: 0,
    errors: 0,
  };

  try {
    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      try {
        const existingSnapshot = getOwnershipSnapshot(company.company_number);
        const ownershipLookup = await lookupCompanyOwnership(company.company_number);
        if (ownershipLookup?.error || !ownershipLookup?.summary) {
          ownershipStaleMonitorProgress.errors++;
        } else {
          const nowIso = new Date().toISOString();
          const change = detectOwnershipChanges(existingSnapshot, ownershipLookup.summary);
          const nextSnapshot = {
            ...ownershipLookup.summary,
            source: "companies_house_api",
            last_checked_at: nowIso,
            change_detected: change.changeDetected,
            changed_fields: change.changedFields,
            last_changed_at: change.changeDetected
              ? nowIso
              : (existingSnapshot?.last_changed_at || null),
          };

          if (!existingSnapshot) {
            ownershipStaleMonitorProgress.missing_snapshot++;
            ownershipStaleMonitorProgress.baselined++;
          } else if (change.changeDetected) {
            ownershipStaleMonitorProgress.changed++;
          } else {
            ownershipStaleMonitorProgress.unchanged++;
          }

          setSetting(`ownership_${company.company_number}`, nextSnapshot);
          ownershipStaleMonitorProgress.refreshed++;
        }
      } catch {
        ownershipStaleMonitorProgress.errors++;
      }

      ownershipStaleMonitorProgress.checked = i + 1;
      await sleep(API_DELAY_MS);
    }

    ownershipStaleMonitorProgress.completed_at = new Date().toISOString();
    return { ...ownershipStaleMonitorProgress };
  } finally {
    ownershipStaleMonitorRunning = false;
  }
}

export function parseCompanyListCSV(csvContent) {
  const lines = parseNonEmptyCsvLines(csvContent);
  if (lines.length === 0) return [];

  const normalizeCompanyNumber = (value) => {
    const cleaned = String(value || "")
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/\s+/g, "")
      .toUpperCase();

    if (!cleaned) return null;
    if (/^\d{1,8}$/.test(cleaned)) return cleaned.padStart(8, "0");
    if (/^[A-Z]{2}\d+$/.test(cleaned)) return cleaned;
    return null;
  };

  const parseCombinedNameNumberCell = (value) => {
    const text = String(value || "").trim().replace(/^"|"$/g, "");
    if (!text.includes(",")) return null;

    const parts = text.split(",");
    if (parts.length < 2) return null;

    const maybeNumber = parts[parts.length - 1].trim();
    const normalized = normalizeCompanyNumber(maybeNumber);
    if (!normalized) return null;

    return {
      company_number: normalized,
      company_name: parts.slice(0, -1).join(",").trim() || null,
    };
  };

  const headerCells = parseCsvRow(lines[0]).map((cell) => String(cell || "").toLowerCase().replace(/"/g, ""));
  const hasHeader = headerCells.some((cell) =>
    cell.includes("company")
    || cell.includes("number")
    || cell.includes("registration")
    || cell.includes("name")
  );

  const numIdx = hasHeader
    ? headerCells.findIndex((cell) =>
      cell.includes("company")
      && (cell.includes("number") || cell.includes("num") || cell.includes("no") || cell.includes("registration"))
    )
    : -1;
  const nameIdx = hasHeader
    ? headerCells.findIndex((cell) => cell.includes("company") && cell.includes("name"))
    : -1;
  const startIdx = hasHeader ? 1 : 0;

  const companies = [];
  const seen = new Set();

  for (let i = startIdx; i < lines.length; i += 1) {
    const cells = parseCsvRow(lines[i]).map((cell) => String(cell || "").trim());
    if (cells.length === 0) continue;

    let candidateNumber = numIdx >= 0 ? cells[numIdx] : null;
    let combinedRow = null;

    if (!candidateNumber || !normalizeCompanyNumber(candidateNumber)) {
      combinedRow = cells.length === 1 ? parseCombinedNameNumberCell(cells[0]) : null;
      if (combinedRow) {
        candidateNumber = combinedRow.company_number;
      }
    }

    if (!candidateNumber || !normalizeCompanyNumber(candidateNumber)) {
      candidateNumber = cells.find((cell) => !!normalizeCompanyNumber(cell)) || null;
    }

    const normalizedNumber = normalizeCompanyNumber(candidateNumber);
    if (!normalizedNumber || seen.has(normalizedNumber)) continue;

    let candidateName = nameIdx >= 0
      ? cells[nameIdx]
      : cells.find((cell, idx) => idx !== numIdx && cell && !normalizeCompanyNumber(cell));

    if (combinedRow?.company_name) {
      candidateName = combinedRow.company_name;
    }

    seen.add(normalizedNumber);
    companies.push({
      company_number: normalizedNumber,
      company_name: String(candidateName || "").trim() || null,
    });
  }

  return companies;
}

export async function importMonitorListFromCSV(csvContent, source) {
  const companies = parseCompanyListCSV(csvContent);
  const upsertResult = upsertMonitoredCompanies(
    companies.map((company) => ({
      ...company,
      source: source || "csv_list",
      status: "active",
    })),
    source || "csv_list"
  );

  return {
    total_parsed: companies.length,
    imported: upsertResult.upserted,
    skipped: upsertResult.skipped_invalid,
  };
}

// --- Weekly monitor scheduler ---

let weeklyMonitorTimer = null;
let weeklyMonitorStatus = {
  enabled: false,
  last_run: null,
  next_run: null,
  last_result: null,
  schedule: "Saturday evenings at 18:00",
  timezone: UK_TIMEZONE,
};
let staleMonitorTimer = null;
let staleMonitorStatus = {
  enabled: false,
  last_run: null,
  next_run: null,
  last_result: null,
  schedule: `Checks due stale filings every ${Math.max(1, Math.round(STALE_MONITOR_CHECK_INTERVAL_MS / 3600000))}h (${STALE_LOOKUP_INTERVAL_DAYS}-day cadence per stale company)`,
};
let ownershipStaleMonitorTimer = null;
let ownershipStaleMonitorStatus = {
  enabled: false,
  last_run: null,
  next_run: null,
  last_result: null,
  schedule: `Checks ownership every ${Math.max(1, Math.round(OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS / 3600000))}h (refreshes ownership older than ${OWNERSHIP_STALE_DAYS} days)`,
};

function getNextSaturdayEvening() {
  return getNextWeeklyZonedRun({
    timeZone: UK_TIMEZONE,
    targetWeekday: 6,
    hour: 18,
    minute: 0,
    second: 0,
  });
}

export function getWeeklyMonitorStatus() {
  return {
    ...weeklyMonitorStatus,
    stats: getMonitorStats(),
    total_monitored: getMonitoredCompanyCount(),
  };
}

export function getStaleFilingMonitorStatus() {
  return {
    ...staleMonitorStatus,
    running: staleMonitorRunning,
    progress: staleMonitorProgress,
    stats: getMonitorStats(),
    total_monitored: getMonitoredCompanyCount(),
    stale_months_threshold: STALE_FILING_MONTHS,
    stale_recheck_days: STALE_LOOKUP_INTERVAL_DAYS,
  };
}

export function getOwnershipStaleMonitorStatus() {
  return {
    ...ownershipStaleMonitorStatus,
    running: ownershipStaleMonitorRunning,
    progress: ownershipStaleMonitorProgress,
    total_monitored: getMonitoredCompanyCount(),
    stale_days: OWNERSHIP_STALE_DAYS,
    batch_size: OWNERSHIP_STALE_BATCH_SIZE,
    check_interval_ms: OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS,
    change_tracking_enabled: true,
    change_fields: OWNERSHIP_CHANGE_FIELDS,
  };
}

export function startWeeklyMonitor() {
  if (weeklyMonitorTimer) clearTimeout(weeklyMonitorTimer);

  weeklyMonitorStatus.enabled = true;
  const nextRun = getNextSaturdayEvening();
  weeklyMonitorStatus.next_run = nextRun.toISOString();

  const delay = nextRun.getTime() - Date.now();
  weeklyMonitorTimer = setTimeout(async function runAndReschedule() {
    weeklyMonitorStatus.last_run = new Date().toISOString();
    try {
      const result = await runWeeklyMonitorBatch(500);
      weeklyMonitorStatus.last_result = result;
    } catch (err) {
      weeklyMonitorStatus.last_result = { error: err.message };
    }
    const next = getNextSaturdayEvening();
    weeklyMonitorStatus.next_run = next.toISOString();
    weeklyMonitorTimer = setTimeout(runAndReschedule, next.getTime() - Date.now());
  }, delay);

  return weeklyMonitorStatus;
}

export function stopWeeklyMonitor() {
  if (weeklyMonitorTimer) { clearTimeout(weeklyMonitorTimer); weeklyMonitorTimer = null; }
  weeklyMonitorStatus.enabled = false;
  weeklyMonitorStatus.next_run = null;
  return weeklyMonitorStatus;
}

async function runStaleSchedulerCycle() {
  staleMonitorStatus.last_run = new Date().toISOString();
  try {
    const result = await runStaleFilingFortnightlyBatch(500);
    staleMonitorStatus.last_result = result;
  } catch (err) {
    staleMonitorStatus.last_result = { error: err.message };
  }
  staleMonitorStatus.next_run = new Date(Date.now() + STALE_MONITOR_CHECK_INTERVAL_MS).toISOString();
}

export function startStaleFilingMonitor() {
  if (staleMonitorTimer) clearInterval(staleMonitorTimer);

  staleMonitorStatus.enabled = true;
  staleMonitorStatus.next_run = new Date(Date.now() + STALE_MONITOR_CHECK_INTERVAL_MS).toISOString();

  staleMonitorTimer = setInterval(() => {
    runStaleSchedulerCycle().catch(() => {});
  }, STALE_MONITOR_CHECK_INTERVAL_MS);

  setTimeout(() => {
    runStaleSchedulerCycle().catch(() => {});
  }, 10000);

  return staleMonitorStatus;
}

export function stopStaleFilingMonitor() {
  if (staleMonitorTimer) {
    clearInterval(staleMonitorTimer);
    staleMonitorTimer = null;
  }
  staleMonitorStatus.enabled = false;
  staleMonitorStatus.next_run = null;
  return staleMonitorStatus;
}

async function runOwnershipStaleSchedulerCycle() {
  ownershipStaleMonitorStatus.last_run = new Date().toISOString();
  try {
    const result = await runOwnershipStaleBatch(OWNERSHIP_STALE_BATCH_SIZE);
    ownershipStaleMonitorStatus.last_result = result;
  } catch (err) {
    ownershipStaleMonitorStatus.last_result = { error: err.message };
  }
  ownershipStaleMonitorStatus.next_run = new Date(Date.now() + OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS).toISOString();
}

export function startOwnershipStaleMonitor() {
  if (ownershipStaleMonitorTimer) clearInterval(ownershipStaleMonitorTimer);

  ownershipStaleMonitorStatus.enabled = true;
  ownershipStaleMonitorStatus.next_run = new Date(Date.now() + OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS).toISOString();

  ownershipStaleMonitorTimer = setInterval(() => {
    runOwnershipStaleSchedulerCycle().catch(() => {});
  }, OWNERSHIP_STALE_MONITOR_CHECK_INTERVAL_MS);

  setTimeout(() => {
    runOwnershipStaleSchedulerCycle().catch(() => {});
  }, 15000);

  return ownershipStaleMonitorStatus;
}

export function stopOwnershipStaleMonitor() {
  if (ownershipStaleMonitorTimer) {
    clearInterval(ownershipStaleMonitorTimer);
    ownershipStaleMonitorTimer = null;
  }
  ownershipStaleMonitorStatus.enabled = false;
  ownershipStaleMonitorStatus.next_run = null;
  return ownershipStaleMonitorStatus;
}
