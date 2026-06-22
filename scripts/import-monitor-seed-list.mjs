#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parseCsvRow, parseNonEmptyCsvLines } from "../mock-backend/csv-utils.js";
import {
  isCompaniesHouseConfigured,
  lookupCompany,
  searchCompaniesByName,
} from "../mock-backend/companies-house.js";
import {
  closeDb,
  getMonitoredCompanyCount,
  updateMonitorCheck,
  upsertFiling,
  upsertMonitoredCompanies,
} from "../mock-backend/db.js";
import { enqueueCompaniesForAnalysis } from "../mock-backend/analysis-queue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const INACTIVE_STATUSES = new Set([
  "dissolved",
  "liquidation",
  "converted-closed",
  "voluntary-arrangement",
  "insolvency-proceedings",
]);

function printUsage() {
  console.log([
    "Usage: node scripts/import-monitor-seed-list.mjs [options] <csv-file...>",
    "",
    "Import a seed list using company_name + website/domain and optional company_number.",
    "Rows without company_number are resolved via Companies House company search.",
    "",
    "Options:",
    "  --source <value>              Source tag stored on company_monitor rows (default: seed_name_website)",
    "  --report <path>               Optional JSON summary output path",
    "  --dry-run                     Parse and resolve only, without DB writes",
    "  --max-rows <n>                Process only the first n parsed rows",
    "  --search-limit <n>            CH search result page size for name resolution (default: 20)",
    "  --allow-low-confidence        Accept low-confidence CH name matches (default: false)",
    "  --no-sync                     Do not run immediate CH filings sync after import",
    "  --sync-delay-ms <n>           Delay between CH lookups during sync (default: 500)",
    "  --no-queue-analysis           Do not enqueue imported companies for analysis",
    "  --help                        Show this help",
    "",
    "Expected CSV columns (header names are flexible):",
    "  - company_name / name",
    "  - company_website / website / website_url / url",
    "  - company_domain / domain (optional)",
    "  - company_number (optional)",
    "",
    "Examples:",
    "  node scripts/import-monitor-seed-list.mjs data/existing-list.csv",
    "  node scripts/import-monitor-seed-list.mjs --dry-run --report exports/seed-import-dry-run.json data/existing-list.csv",
    "  node scripts/import-monitor-seed-list.mjs --no-sync --no-queue-analysis data/existing-list.csv",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    source: "seed_name_website",
    report: null,
    dryRun: false,
    maxRows: null,
    searchLimit: 20,
    allowLowConfidence: false,
    syncNow: true,
    syncDelayMs: 500,
    queueAnalysis: true,
    help: false,
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--source" && argv[i + 1]) {
      options.source = String(argv[i + 1] || "").trim() || options.source;
      i += 1;
      continue;
    }
    if (arg === "--report" && argv[i + 1]) {
      options.report = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--max-rows" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1]), 10);
      options.maxRows = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      i += 1;
      continue;
    }
    if (arg === "--search-limit" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1]), 10);
      options.searchLimit = Number.isFinite(parsed)
        ? Math.max(1, Math.min(parsed, 100))
        : options.searchLimit;
      i += 1;
      continue;
    }
    if (arg === "--allow-low-confidence") {
      options.allowLowConfidence = true;
      continue;
    }
    if (arg === "--no-sync") {
      options.syncNow = false;
      continue;
    }
    if (arg === "--sync-delay-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1]), 10);
      options.syncDelayMs = Number.isFinite(parsed)
        ? Math.max(0, parsed)
        : options.syncDelayMs;
      i += 1;
      continue;
    }
    if (arg === "--no-queue-analysis") {
      options.queueAnalysis = false;
      continue;
    }

    options.files.push(arg);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(repoRoot, inputPath);
}

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function normalizeCompanyNumber(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^CH-/, "")
    .replace(/\s+/g, "");
  if (!raw) return null;
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, "0");
  if (/^[A-Z]{2}\d+$/.test(raw)) return raw;
  if (/^[A-Z0-9]{2,12}$/.test(raw)) return raw;
  return null;
}

function normalizeCompanyName(value) {
  const name = String(value || "").trim();
  return name || null;
}

function normalizeWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) return raw;

  const cleaned = raw.replace(/^\/+/, "").trim();
  if (!cleaned || !/[.]/.test(cleaned)) return null;
  return `https://${cleaned}`;
}

function extractDomainFromValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const hostname = String(url.hostname || "").trim().toLowerCase().replace(/^www\./, "");
    return hostname || null;
  } catch {
    const candidate = raw
      .toLowerCase()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./, "")
      .split(/[/?#]/)[0]
      .trim();
    return candidate || null;
  }
}

function isLikelyWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw);
}

function normalizeHeader(cell) {
  return String(cell || "")
    .trim()
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, "_");
}

function findHeaderIndex(headerCells, predicates) {
  for (const predicate of predicates) {
    const idx = headerCells.findIndex(predicate);
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseSeedListCSV(csvContent) {
  const lines = parseNonEmptyCsvLines(csvContent);
  if (lines.length === 0) return [];

  const headerCells = parseCsvRow(lines[0]).map((cell) => normalizeHeader(cell));
  const hasHeader = headerCells.some((cell) => {
    return cell.includes("company")
      || cell.includes("name")
      || cell.includes("website")
      || cell.includes("domain")
      || cell.includes("number");
  });

  const numberIdx = hasHeader
    ? findHeaderIndex(headerCells, [
      (cell) => cell.includes("company") && (cell.includes("number") || cell.includes("registration") || cell.endsWith("_no")),
      (cell) => cell === "number" || cell === "companynumber",
    ])
    : -1;

  const nameIdx = hasHeader
    ? findHeaderIndex(headerCells, [
      (cell) => cell.includes("company") && cell.includes("name"),
      (cell) => cell === "name",
    ])
    : -1;

  const websiteIdx = hasHeader
    ? findHeaderIndex(headerCells, [
      (cell) => cell.includes("website"),
      (cell) => cell.includes("url"),
      (cell) => cell === "site",
    ])
    : -1;

  const domainIdx = hasHeader
    ? findHeaderIndex(headerCells, [
      (cell) => cell.includes("domain"),
    ])
    : -1;

  const startIdx = hasHeader ? 1 : 0;
  const rows = [];

  for (let i = startIdx; i < lines.length; i += 1) {
    const cells = parseCsvRow(lines[i]).map((cell) => String(cell || "").trim());
    if (cells.length === 0) continue;

    const explicitNumber = numberIdx >= 0 ? cells[numberIdx] : null;
    const explicitName = nameIdx >= 0 ? cells[nameIdx] : null;
    const explicitWebsite = websiteIdx >= 0 ? cells[websiteIdx] : null;
    const explicitDomain = domainIdx >= 0 ? cells[domainIdx] : null;

    let companyNumber = normalizeCompanyNumber(explicitNumber);
    let companyName = normalizeCompanyName(explicitName);
    let companyWebsite = normalizeWebsite(explicitWebsite);
    let companyDomain = extractDomainFromValue(explicitDomain || explicitWebsite || "");

    if (!companyNumber) {
      const maybeNumber = cells.find((cell) => !!normalizeCompanyNumber(cell));
      companyNumber = normalizeCompanyNumber(maybeNumber);
    }

    if (!companyWebsite) {
      const maybeWebsite = cells.find((cell) => isLikelyWebsite(cell));
      companyWebsite = normalizeWebsite(maybeWebsite);
      if (!companyDomain) {
        companyDomain = extractDomainFromValue(maybeWebsite || "");
      }
    }

    if (!companyName) {
      const maybeName = cells.find((cell) => {
        if (!cell) return false;
        if (normalizeCompanyNumber(cell)) return false;
        if (isLikelyWebsite(cell)) return false;
        return true;
      });
      companyName = normalizeCompanyName(maybeName);
    }

    if (!companyWebsite && companyDomain) {
      companyWebsite = normalizeWebsite(companyDomain);
    }

    if (!companyNumber && !companyName) continue;

    rows.push({
      row_number: i + 1,
      company_number: companyNumber,
      company_name: companyName,
      company_website: companyWebsite,
      company_domain: companyDomain,
    });
  }

  return rows;
}

async function resolveCompanyNumbers(rows, options) {
  const resolved = [];
  const unresolved = [];
  const deduped = new Map();
  let lowConfidenceRejected = 0;

  for (const row of rows) {
    if (row.company_number) {
      const existing = deduped.get(row.company_number);
      if (existing) {
        if (!existing.company_name && row.company_name) existing.company_name = row.company_name;
        if (!existing.company_website && row.company_website) existing.company_website = row.company_website;
        if (!existing.company_domain && row.company_domain) existing.company_domain = row.company_domain;
      } else {
        deduped.set(row.company_number, { ...row, resolution: "provided", match_confidence: "provided" });
      }
      continue;
    }

    if (!row.company_name) {
      unresolved.push({ ...row, reason: "missing_company_name" });
      continue;
    }

    const lookup = await searchCompaniesByName(row.company_name, {
      items_per_page: options.searchLimit,
    });

    if (lookup?.error) {
      unresolved.push({
        ...row,
        reason: "lookup_error",
        detail: lookup.message || "companies_house_search_failed",
      });
      continue;
    }

    const confidence = String(lookup?.match_confidence || "none").toLowerCase();
    const match = lookup?.best_match;
    const companyNumber = normalizeCompanyNumber(match?.company_number);

    if (!companyNumber) {
      unresolved.push({ ...row, reason: "no_match" });
      continue;
    }

    if (!options.allowLowConfidence && confidence === "low") {
      lowConfidenceRejected += 1;
      unresolved.push({
        ...row,
        reason: "low_confidence_match",
        matched_company_number: companyNumber,
        matched_company_name: match?.company_name || null,
      });
      continue;
    }

    const resolvedRow = {
      ...row,
      company_number: companyNumber,
      company_name: normalizeCompanyName(match?.company_name) || row.company_name,
      resolution: "search",
      match_confidence: confidence || "low",
      matched_company_name: normalizeCompanyName(match?.company_name),
    };

    const existing = deduped.get(companyNumber);
    if (existing) {
      if (!existing.company_name && resolvedRow.company_name) existing.company_name = resolvedRow.company_name;
      if (!existing.company_website && resolvedRow.company_website) existing.company_website = resolvedRow.company_website;
      if (!existing.company_domain && resolvedRow.company_domain) existing.company_domain = resolvedRow.company_domain;
    } else {
      deduped.set(companyNumber, resolvedRow);
    }
  }

  for (const value of deduped.values()) resolved.push(value);

  return {
    resolved,
    unresolved,
    low_confidence_rejected: lowConfidenceRejected,
  };
}

function sortFilingsByDateDesc(filings) {
  return [...filings].sort((a, b) => {
    const aTs = Date.parse(String(a?.date || ""));
    const bTs = Date.parse(String(b?.date || ""));
    const safeA = Number.isFinite(aTs) ? aTs : 0;
    const safeB = Number.isFinite(bTs) ? bTs : 0;
    return safeB - safeA;
  });
}

async function syncCompaniesHouseData(rows, source, delayMs) {
  const summary = {
    attempted: rows.length,
    checked: 0,
    errors: 0,
    inactive: 0,
    rows_with_filings: 0,
    filing_records_written: 0,
    rows_without_filings: 0,
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const companyNumber = row.company_number;

    try {
      const lookup = await lookupCompany(companyNumber);
      if (lookup?.error) {
        summary.errors += 1;
        updateMonitorCheck(companyNumber, {
          notes: `Seed sync lookup error: ${lookup.message || "lookup_failed"}`,
        });
      } else {
        const filings = sortFilingsByDateDesc(Array.isArray(lookup?.recent_filings) ? lookup.recent_filings : []);
        for (const filing of filings) {
          upsertFiling({
            company_number: companyNumber,
            filing_date: filing.date || null,
            description: filing.description || null,
            filing_type: filing.type || null,
            barcode: filing.barcode || `seed-${companyNumber}-${filing.date || "unknown"}`,
            source: `${source}:seed_sync`,
          });
          summary.filing_records_written += 1;
        }

        const latestFilingDate = filings[0]?.date || null;
        if (latestFilingDate) summary.rows_with_filings += 1;
        else summary.rows_without_filings += 1;

        const status = String(lookup?.status || "active").trim().toLowerCase() || "active";
        if (INACTIVE_STATUSES.has(status)) summary.inactive += 1;

        updateMonitorCheck(companyNumber, {
          company_name: normalizeCompanyName(lookup?.name) || row.company_name || null,
          status,
          last_filing_date: latestFilingDate,
          no_filings: latestFilingDate ? 0 : 1,
          stale_filing_checked_at: null,
          stale_filing_due_at: null,
          notes: null,
        });
      }
    } catch (err) {
      summary.errors += 1;
      updateMonitorCheck(companyNumber, {
        notes: `Seed sync error: ${err?.message || "unknown_error"}`,
      });
    }

    summary.checked = i + 1;
    if (delayMs > 0 && i < rows.length - 1) {
      await sleep(delayMs);
    }
  }

  return summary;
}

function buildUpsertRows(rows, source) {
  return rows.map((row) => ({
    company_number: row.company_number,
    company_name: row.company_name || null,
    company_website: row.company_website || null,
    company_domain: row.company_domain || null,
    source,
    status: "active",
  }));
}

function mainSummaryTemplate(options) {
  return {
    started_at: new Date().toISOString(),
    completed_at: null,
    mode: options.dryRun ? "dry_run" : "apply",
    options: {
      source: options.source,
      dry_run: options.dryRun,
      sync_now: options.syncNow,
      sync_delay_ms: options.syncDelayMs,
      queue_analysis: options.queueAnalysis,
      allow_low_confidence: options.allowLowConfidence,
      search_limit: options.searchLimit,
      max_rows: options.maxRows,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!Array.isArray(options.files) || options.files.length === 0) {
    printUsage();
    throw new Error("At least one CSV file path is required");
  }

  const summary = mainSummaryTemplate(options);
  const monitoredBefore = getMonitoredCompanyCount();
  summary.monitored_before = monitoredBefore;

  const parsedRows = [];
  const perFile = [];

  for (const fileArg of options.files) {
    const resolvedPath = resolvePath(fileArg);
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = parseSeedListCSV(raw);

    perFile.push({
      file: path.relative(repoRoot, resolvedPath),
      parsed_rows: parsed.length,
    });

    parsedRows.push(...parsed);
    console.log(`[seed-import] ${path.basename(resolvedPath)} parsed=${parsed.length}`);
  }

  const limitedRows = Number.isFinite(options.maxRows)
    ? parsedRows.slice(0, options.maxRows)
    : parsedRows;

  const canResolveMissingNumbers = isCompaniesHouseConfigured();
  const resolution = await resolveCompanyNumbers(limitedRows, {
    searchLimit: options.searchLimit,
    allowLowConfidence: options.allowLowConfidence,
  });

  const resolvedRows = resolution.resolved;
  const unresolvedRows = resolution.unresolved;

  const upsertRows = buildUpsertRows(resolvedRows, options.source);
  const upsertResult = options.dryRun
    ? {
      received: upsertRows.length,
      upserted: 0,
      skipped_invalid: 0,
      source: options.source,
      dry_run: true,
    }
    : upsertMonitoredCompanies(upsertRows, options.source);

  let syncSummary = {
    skipped: true,
    reason: options.syncNow ? "not_run" : "disabled",
  };

  if (!options.dryRun && options.syncNow) {
    if (!canResolveMissingNumbers) {
      syncSummary = {
        skipped: true,
        reason: "companies_house_not_configured",
      };
    } else {
      syncSummary = await syncCompaniesHouseData(resolvedRows, options.source, options.syncDelayMs);
      syncSummary.skipped = false;
    }
  }

  let queueSummary = {
    skipped: true,
    reason: options.queueAnalysis ? "not_run" : "disabled",
    queued: 0,
  };

  if (!options.dryRun && options.queueAnalysis) {
    const queueResult = enqueueCompaniesForAnalysis(
      resolvedRows.map((row) => ({ company_number: row.company_number, company_name: row.company_name || null })),
      `seed_import:${options.source}`
    );

    queueSummary = {
      skipped: false,
      queued: Number(queueResult?.queued || 0),
    };
  }

  const monitoredAfter = options.dryRun ? monitoredBefore : getMonitoredCompanyCount();

  summary.completed_at = new Date().toISOString();
  summary.files_processed = perFile.length;
  summary.per_file = perFile;
  summary.parsed_rows = parsedRows.length;
  summary.rows_considered = limitedRows.length;
  summary.resolution = {
    resolved: resolvedRows.length,
    unresolved: unresolvedRows.length,
    low_confidence_rejected: resolution.low_confidence_rejected,
    used_companies_house_search: canResolveMissingNumbers,
    unresolved_sample: unresolvedRows.slice(0, 100),
  };
  summary.upsert = upsertResult;
  summary.sync = syncSummary;
  summary.analysis_queue = queueSummary;
  summary.monitored_after = monitoredAfter;

  if (options.report) {
    const reportPath = resolvePath(options.report);
    ensureParentDir(reportPath);
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    summary.report_path = reportPath;
  }

  console.log(`[seed-import] parsed=${summary.parsed_rows} considered=${summary.rows_considered}`);
  console.log(`[seed-import] resolved=${summary.resolution.resolved} unresolved=${summary.resolution.unresolved}`);
  console.log(`[seed-import] upserted=${upsertResult.upserted} monitored_total=${summary.monitored_after}`);

  if (syncSummary.skipped) {
    console.log(`[seed-import] sync=skipped reason=${syncSummary.reason}`);
  } else {
    console.log(
      `[seed-import] sync_checked=${syncSummary.checked} rows_with_filings=${syncSummary.rows_with_filings} filing_records_written=${syncSummary.filing_records_written} errors=${syncSummary.errors}`
    );
  }

  if (queueSummary.skipped) {
    console.log(`[seed-import] analysis_queue=skipped reason=${queueSummary.reason}`);
  } else {
    console.log(`[seed-import] analysis_queue_queued=${queueSummary.queued}`);
  }

  if (summary.report_path) {
    console.log(`[seed-import] report=${summary.report_path}`);
  }
}

try {
  await main();
} finally {
  closeDb();
}
