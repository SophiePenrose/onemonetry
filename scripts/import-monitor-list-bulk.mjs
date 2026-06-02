#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parseCompanyListCSV } from "../mock-backend/company-monitor.js";
import { upsertMonitoredCompanies, getMonitoredCompanyCount, closeDb } from "../mock-backend/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.log([
    "Usage: node scripts/import-monitor-list-bulk.mjs [options] <csv-file...>",
    "",
    "Options:",
    "  --source <value>   Source tag stored on company_monitor rows (default: csv_bulk_ingest)",
    "  --report <path>    Optional JSON summary output path",
    "  --help             Show this help",
    "",
    "Examples:",
    "  node scripts/import-monitor-list-bulk.mjs data/source3-part1.csv data/source3-part2.csv",
    "  node scripts/import-monitor-list-bulk.mjs --source source_3_csv --report exports/monitor-import-report.json data/*.csv",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    source: "csv_bulk_ingest",
    report: null,
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
    options.files.push(arg);
  }

  return options;
}

function resolvePath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(repoRoot, inputPath);
}

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!Array.isArray(options.files) || options.files.length === 0) {
    printUsage();
    throw new Error("At least one CSV file path is required");
  }

  const startedAt = new Date().toISOString();
  const aggregate = new Map();
  const perFile = [];

  for (const fileArg of options.files) {
    const resolvedPath = resolvePath(fileArg);
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const parsed = parseCompanyListCSV(raw);

    let uniqueAdded = 0;
    let duplicatesAcrossFiles = 0;

    for (const row of parsed) {
      const key = String(row.company_number || "").trim();
      if (!key) continue;

      if (aggregate.has(key)) {
        duplicatesAcrossFiles += 1;
        const existing = aggregate.get(key);
        if (!existing.company_name && row.company_name) {
          aggregate.set(key, {
            ...existing,
            company_name: row.company_name,
          });
        }
        continue;
      }

      aggregate.set(key, {
        company_number: key,
        company_name: row.company_name || null,
        source: options.source,
        status: "active",
      });
      uniqueAdded += 1;
    }

    perFile.push({
      file: path.relative(repoRoot, resolvedPath),
      parsed_rows: parsed.length,
      unique_added: uniqueAdded,
      duplicates_across_files: duplicatesAcrossFiles,
    });

    console.log(
      `[monitor-import] ${path.basename(resolvedPath)} parsed=${parsed.length} unique_added=${uniqueAdded} duplicates_across_files=${duplicatesAcrossFiles}`
    );
  }

  const rows = Array.from(aggregate.values());
  const upsertResult = upsertMonitoredCompanies(rows, options.source);
  const totalMonitored = getMonitoredCompanyCount();

  const summary = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source: options.source,
    files_processed: perFile.length,
    total_unique_companies: rows.length,
    upsert_result: upsertResult,
    total_monitored_after_import: totalMonitored,
    per_file: perFile,
  };

  if (options.report) {
    const reportPath = resolvePath(options.report);
    ensureParentDir(reportPath);
    fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    summary.report_path = reportPath;
  }

  console.log(`[monitor-import] files=${summary.files_processed} unique=${summary.total_unique_companies} upserted=${upsertResult.upserted}`);
  console.log(`[monitor-import] monitored_total=${summary.total_monitored_after_import}`);
  if (summary.report_path) {
    console.log(`[monitor-import] report=${summary.report_path}`);
  }
}

try {
  main();
} finally {
  closeDb();
}