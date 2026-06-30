#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.log([
    "Usage: node scripts/gemini-weekly-export-bundle.mjs [options]",
    "",
    "Runs weekly Gemini handoff and exports a full artifact bundle.",
    "",
    "Options:",
    "  --base-url <url>       API base URL (default: http://127.0.0.1:8000)",
    "  --limit <n>            Weekly handoff limit 1-100 (default: 100)",
    "  --focus <value>        Weekly focus: all|new|carryover (default: all)",
    "  --request-id <id>      Optional deterministic request id",
    "  --out-dir <path>       Output directory (default: exports)",
    "  --timeout-ms <n>       Request timeout ms (default: 180000)",
    "  --retry-429            Attempt targeted retry of scoped HTTP 429 failures",
    "  --retry-429-force      Bypass retry cooldown guardrail for retry-429",
    "  --retry-429-max-scopes <n>  Max scoped retries to include (default: server runtime)",
    "  --help                 Show this help",
    "",
    "Outputs:",
    "  gemini-<request_id>-all.csv",
    "  gemini-<request_id>-all.json",
    "  gemini-<request_id>-summary.json",
    "  gemini-<request_id>-company-name-review.csv",
    "  gemini-<request_id>-approved-sendable.csv",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    baseUrl: "http://127.0.0.1:8000",
    limit: 100,
    focus: "all",
    requestId: null,
    outDir: "exports",
    timeoutMs: 180000,
    retry429: false,
    retry429Force: false,
    retry429MaxScopes: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--base-url" && argv[i + 1]) {
      options.baseUrl = String(argv[i + 1] || "").trim() || options.baseUrl;
      i += 1;
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      if (Number.isFinite(parsed)) {
        options.limit = Math.max(1, Math.min(parsed, 100));
      }
      i += 1;
      continue;
    }
    if (arg === "--focus" && argv[i + 1]) {
      const token = String(argv[i + 1] || "").trim().toLowerCase();
      if (["all", "new", "carryover"].includes(token)) {
        options.focus = token;
      }
      i += 1;
      continue;
    }
    if (arg === "--request-id" && argv[i + 1]) {
      options.requestId = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--out-dir" && argv[i + 1]) {
      options.outDir = String(argv[i + 1] || "").trim() || options.outDir;
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      if (Number.isFinite(parsed)) {
        options.timeoutMs = Math.max(5000, Math.min(parsed, 600000));
      }
      i += 1;
      continue;
    }
    if (arg === "--retry-429") {
      options.retry429 = true;
      continue;
    }
    if (arg === "--retry-429-force") {
      options.retry429 = true;
      options.retry429Force = true;
      continue;
    }
    if (arg === "--retry-429-max-scopes" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.retry429 = true;
        options.retry429MaxScopes = Math.max(1, Math.min(parsed, 200));
      }
      i += 1;
      continue;
    }
  }

  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildFlaggedCompanyCsv(rows = []) {
  const columns = [
    "CompanyNumber",
    "Company",
    "CompanyNameReviewReason",
    "To",
    "Subject",
    "ApprovalStatus",
    "SequenceId",
  ];

  const flagged = rows.filter((row) => {
    if (row?.CompanyNameNeedsReview === true) return true;
    const token = String(row?.CompanyNameNeedsReview ?? "").trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(token);
  });

  const lines = [columns.join(",")];
  for (const row of flagged) {
    lines.push(columns.map((column) => toCsvCell(row?.[column])).join(","));
  }

  return {
    csv: `${lines.join("\n")}\n`,
    flaggedCount: flagged.length,
  };
}

async function fetchJson(url, init, timeoutMs) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url} :: ${JSON.stringify(body)}`);
  }
  return body;
}

async function fetchText(url, init, timeoutMs) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url} :: ${text}`);
  }
  return text;
}

async function fetchJsonAllowError(url, init, timeoutMs) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const outDir = path.isAbsolute(options.outDir)
    ? options.outDir
    : path.resolve(repoRoot, options.outDir);
  ensureDir(outDir);

  const weeklyParams = new URLSearchParams();
  weeklyParams.set("limit", String(options.limit));
  weeklyParams.set("focus", options.focus);
  if (options.requestId) weeklyParams.set("request_id", options.requestId);

  const weeklyUrl = `${baseUrl}/api/gemini/weekly/handoff?${weeklyParams.toString()}`;
  const weekly = await fetchJson(weeklyUrl, { method: "POST" }, options.timeoutMs);
  const requestId = String(weekly?.request_id || "").trim();
  if (!requestId) {
    throw new Error("Weekly handoff completed without request_id");
  }

  let retry429Result = null;
  if (options.retry429) {
    const retryBody = {};
    if (options.retry429Force) {
      retryBody.force = true;
    }
    if (Number.isInteger(options.retry429MaxScopes) && options.retry429MaxScopes > 0) {
      retryBody.max_scopes = options.retry429MaxScopes;
    }

    const retry429Url = `${baseUrl}/api/gemini/handoff/${encodeURIComponent(requestId)}/retry-429`;
    retry429Result = await fetchJsonAllowError(
      retry429Url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retryBody),
      },
      options.timeoutMs
    );
  }

  const rowsJsonUrl = `${baseUrl}/api/gemini/handoff/${encodeURIComponent(requestId)}/yamm-rows`;
  const rowsCsvUrl = `${rowsJsonUrl}?format=csv`;
  const summaryUrl = `${baseUrl}/api/gemini/handoff/${encodeURIComponent(requestId)}/yamm-rows/summary`;
  const sendableCsvUrl = `${rowsJsonUrl}?format=csv&approval_status=approved&send_eligible=true`;

  const [rowsJson, rowsCsv, summaryJson, sendableCsv] = await Promise.all([
    fetchJson(rowsJsonUrl, {}, options.timeoutMs),
    fetchText(rowsCsvUrl, {}, options.timeoutMs),
    fetchJson(summaryUrl, {}, options.timeoutMs),
    fetchText(sendableCsvUrl, {}, options.timeoutMs),
  ]);

  const rows = Array.isArray(rowsJson?.rows) ? rowsJson.rows : [];
  const { csv: flaggedCsv, flaggedCount } = buildFlaggedCompanyCsv(rows);

  const files = {
    allCsv: path.join(outDir, `gemini-${requestId}-all.csv`),
    allJson: path.join(outDir, `gemini-${requestId}-all.json`),
    summaryJson: path.join(outDir, `gemini-${requestId}-summary.json`),
    flaggedCsv: path.join(outDir, `gemini-${requestId}-company-name-review.csv`),
    approvedSendableCsv: path.join(outDir, `gemini-${requestId}-approved-sendable.csv`),
    ...(retry429Result
      ? { retry429Json: path.join(outDir, `gemini-${requestId}-retry-429.json`) }
      : {}),
  };

  fs.writeFileSync(files.allCsv, rowsCsv, "utf8");
  fs.writeFileSync(files.allJson, `${JSON.stringify(rowsJson, null, 2)}\n`, "utf8");
  fs.writeFileSync(files.summaryJson, `${JSON.stringify(summaryJson, null, 2)}\n`, "utf8");
  fs.writeFileSync(files.flaggedCsv, flaggedCsv, "utf8");
  fs.writeFileSync(files.approvedSendableCsv, sendableCsv, "utf8");
  if (retry429Result && files.retry429Json) {
    fs.writeFileSync(files.retry429Json, `${JSON.stringify(retry429Result, null, 2)}\n`, "utf8");
  }

  const sendableRows = Math.max(
    0,
    sendableCsv
      .trim()
      .split(/\r?\n/)
      .filter(Boolean).length - 1
  );

  console.log(`request_id=${requestId}`);
  console.log(`status=${String(weekly?.status || "")}`);
  console.log(`selected_count=${Number(weekly?.selected_count || 0)}`);
  console.log(`ranked_count=${Number(weekly?.ranked_count || 0)}`);
  console.log(`imported=${Number(weekly?.sequence_import?.imported || 0)}`);
  console.log(`rows=${rows.length}`);
  console.log(`flagged_company_names=${flaggedCount}`);
  console.log(`summary_send_eligible=${Number(summaryJson?.totals?.send_eligible || 0)}`);
  console.log(`approved_sendable_rows=${sendableRows}`);
  console.log(`retry_429_enabled=${options.retry429}`);
  if (retry429Result) {
    console.log(`retry_429_status_code=${retry429Result.status}`);
    console.log(`retry_429_error=${String(retry429Result.body?.error || "")}`);
    console.log(`retry_429_targeted_scope_count=${Number(retry429Result.body?.targeted_scope_count || retry429Result.body?.retry_429?.targeted_scope_count || 0)}`);
    console.log(`retry_429_remaining_retryable_429_count=${Number(retry429Result.body?.retry_429?.remaining_retryable_429_count || 0)}`);
  }
  console.log(`all_csv=${files.allCsv}`);
  console.log(`all_json=${files.allJson}`);
  console.log(`summary_json=${files.summaryJson}`);
  console.log(`flagged_csv=${files.flaggedCsv}`);
  console.log(`approved_sendable_csv=${files.approvedSendableCsv}`);
  if (retry429Result && files.retry429Json) {
    console.log(`retry_429_json=${files.retry429Json}`);
  }
}

main().catch((error) => {
  console.error(`gemini-weekly-export-bundle failed: ${error?.message || error}`);
  process.exitCode = 1;
});
