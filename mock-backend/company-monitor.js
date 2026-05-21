import {
  getMonitoredCompanies,
  updateMonitorCheck,
  upsertFiling,
  upsertMonitoredCompany,
  getMonitorStats,
  getMonitoredCompanyCount,
} from "./db.js";
import { lookupCompany, isCompaniesHouseConfigured } from "./companies-house.js";

const TURNOVER_THRESHOLD = 15_000_000;
const INACTIVE_STATUSES = ["dissolved", "liquidation", "converted-closed", "voluntary-arrangement", "insolvency-proceedings"];
const API_DELAY_MS = parseInt(process.env.CH_API_DELAY_MS || "600");
const BATCH_SIZE = parseInt(process.env.CH_MONITOR_BATCH_SIZE || "50");

let monitorRunning = false;
let monitorProgress = null;

export function getMonitorProgress() {
  return monitorProgress;
}

export function isMonitorRunning() {
  return monitorRunning;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runWeeklyMonitorBatch(batchSize = BATCH_SIZE) {
  if (!isCompaniesHouseConfigured()) {
    return { error: "COMPANIES_HOUSE_API_KEY not set" };
  }

  if (monitorRunning) {
    return { error: "Monitor already running", progress: monitorProgress };
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

      const newFilings = (chData.recent_filings || []).filter((f) => {
        if (!company.last_filing_date) return true;
        return f.date > company.last_filing_date;
      });

      if (newFilings.length > 0) {
        monitorProgress.new_filings += newFilings.length;
        for (const filing of newFilings) {
          upsertFiling({
            company_number: company.company_number,
            filing_date: filing.date,
            description: filing.description,
            filing_type: filing.type,
            barcode: filing.barcode || `ch-${company.company_number}-${filing.date}`,
            source: "weekly_monitor",
          });
        }
        updateMonitorCheck(company.company_number, {
          last_filing_date: newFilings[0].date,
          no_filings: 0,
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

export function parseCompanyListCSV(csvContent) {
  const lines = csvContent.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase().replace(/"/g, "");
  const cols = header.split(",").map((c) => c.trim());

  const numIdx = cols.findIndex((c) => c.includes("company") && (c.includes("number") || c.includes("num") || c.includes("no") || c.includes("registration")));
  const nameIdx = cols.findIndex((c) => c.includes("company") && c.includes("name"));

  const companies = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const num = cells[numIdx >= 0 ? numIdx : 0];
    const name = nameIdx >= 0 ? cells[nameIdx] : null;

    if (!num) continue;
    const cleaned = num.replace(/\s/g, "");
    if (/^\d{1,8}$/.test(cleaned) || /^[A-Z]{2}\d+$/.test(cleaned)) {
      companies.push({
        company_number: cleaned.padStart(8, "0"),
        company_name: name || null,
      });
    }
  }

  return companies;
}

export async function importMonitorListFromCSV(csvContent, source) {
  const companies = parseCompanyListCSV(csvContent);
  let imported = 0;
  let skipped = 0;

  for (const company of companies) {
    try {
      upsertMonitoredCompany({
        company_number: company.company_number,
        company_name: company.company_name,
        source: source || "csv_list",
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  return { total_parsed: companies.length, imported, skipped };
}

// --- Weekly monitor scheduler ---

let weeklyMonitorTimer = null;
let weeklyMonitorStatus = { enabled: false, last_run: null, next_run: null, last_result: null };

function getNextSaturdayEvening() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilSat = day === 6 ? 7 : (6 - day);
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilSat);
  next.setHours(18, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

export function getWeeklyMonitorStatus() {
  return {
    ...weeklyMonitorStatus,
    stats: getMonitorStats(),
    total_monitored: getMonitoredCompanyCount(),
  };
}

export function startWeeklyMonitor() {
  if (weeklyMonitorTimer) clearInterval(weeklyMonitorTimer);

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
