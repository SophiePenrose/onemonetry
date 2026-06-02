import {
  getMonitoredCompanies,
  updateMonitorCheck,
  upsertFiling,
  upsertMonitoredCompanies,
  getMonitorStats,
  getMonitoredCompanyCount,
} from "./db.js";
import { lookupCompany, isCompaniesHouseConfigured } from "./companies-house.js";
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

let monitorRunning = false;
let monitorProgress = null;
let staleMonitorRunning = false;
let staleMonitorProgress = null;

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

function anyMonitorRunning() {
  return monitorRunning || staleMonitorRunning;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildStaleDueAtIso(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setDate(next.getDate() + STALE_LOOKUP_INTERVAL_DAYS);
  return next.toISOString();
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
