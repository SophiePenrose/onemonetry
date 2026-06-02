#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getMonitoredCompanies, getFilingsForCompany, closeDb } from "../mock-backend/db.js";
import { scoreCompany } from "../mock-backend/scoring-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const AMBIGUOUS_COMPETITOR_NAMES = new Set(["Wise", "Square", "Ramp", "Tide"]);
const FINANCE_CONTEXT_PATTERN = /\b(?:fx|foreign\s+exchange|currency|currencies|payment|payments|pos|terminal|checkout|merchant|card|cards|spend|expense|treasury|bank|banking|account|accounts|gateway|transfer|transfers|cross[- ]?border|international)\b/i;

function printUsage() {
  console.log([
    "Usage: node scripts/scoring-calibration-benchmark.mjs [options]",
    "",
    "Options:",
    "  --cases <path>          Optional JSON file with company_numbers and expected_order",
    "  --out <path>            Output JSON path (default: exports/scoring-calibration-benchmark-<timestamp>.json)",
    "  --latest <path>         Also write/overwrite latest snapshot (default: exports/scoring-calibration-benchmark-latest.json)",
    "  --limit <n>             Number of companies to score when --cases is omitted (default: 40)",
    "  --pool-limit <n>        Max active monitored companies to scan for candidates (default: 500)",
    "  --min-text-length <n>   Minimum latest filing text length for candidate inclusion (default: 500)",
    "  --help                  Show this help",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    cases: null,
    out: null,
    latest: "exports/scoring-calibration-benchmark-latest.json",
    limit: 40,
    poolLimit: 500,
    minTextLength: 500,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--cases" && argv[i + 1]) {
      options.cases = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out" && argv[i + 1]) {
      options.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--latest" && argv[i + 1]) {
      options.latest = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      options.limit = Number.parseInt(argv[i + 1], 10) || options.limit;
      i += 1;
      continue;
    }
    if (arg === "--pool-limit" && argv[i + 1]) {
      options.poolLimit = Number.parseInt(argv[i + 1], 10) || options.poolLimit;
      i += 1;
      continue;
    }
    if (arg === "--min-text-length" && argv[i + 1]) {
      options.minTextLength = Number.parseInt(argv[i + 1], 10) || options.minTextLength;
      i += 1;
      continue;
    }
  }

  options.limit = Math.max(1, options.limit);
  options.poolLimit = Math.max(options.limit, options.poolLimit);
  options.minTextLength = Math.max(0, options.minTextLength);
  return options;
}

function uniqueCompanyNumbers(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const next = String(value || "").trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    output.push(next);
  }
  return output;
}

function loadCasesFile(inputPath) {
  if (!inputPath) return null;
  const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw);
  return {
    path: resolved,
    label: String(parsed.label || path.basename(resolved)),
    notes: parsed.notes || null,
    company_numbers: uniqueCompanyNumbers(parsed.company_numbers || []),
    expected_order: uniqueCompanyNumbers(parsed.expected_order || []),
    metadata: parsed.metadata || null,
  };
}

function findEligibleCandidates(limit, poolLimit, minTextLength) {
  const monitored = getMonitoredCompanies({ status: "active", limit: poolLimit });
  const selected = [];
  const rejected = [];

  for (const company of monitored) {
    if (selected.length >= limit) break;

    const filing = getFilingsForCompany(company.company_number, 1)[0] || null;
    const textLength = String(filing?.raw_data || "").trim().length;
    if (textLength < minTextLength) {
      rejected.push({
        company_number: company.company_number,
        reason: "insufficient_text",
        text_length: textLength,
      });
      continue;
    }

    selected.push({
      company_number: company.company_number,
      company_name: company.company_name,
      latest_turnover: Number(company.latest_turnover || 0),
      latest_filing_date: filing?.filing_date || null,
      text_length: textLength,
    });
  }

  return {
    selected,
    examined_count: monitored.length,
    rejected_count: rejected.length,
    rejected_preview: rejected.slice(0, 20),
  };
}

function pairwiseAgreement(rows, expectedOrder) {
  const expected = uniqueCompanyNumbers(expectedOrder);
  if (expected.length < 2) {
    return {
      comparable_pairs: 0,
      concordant_pairs: 0,
      agreement_ratio: null,
    };
  }

  const actualPositions = new Map();
  rows.forEach((row, idx) => actualPositions.set(String(row.company_number), idx));

  let comparablePairs = 0;
  let concordantPairs = 0;

  for (let i = 0; i < expected.length; i += 1) {
    for (let j = i + 1; j < expected.length; j += 1) {
      const left = expected[i];
      const right = expected[j];
      if (!actualPositions.has(left) || !actualPositions.has(right)) continue;
      comparablePairs += 1;
      if (actualPositions.get(left) < actualPositions.get(right)) concordantPairs += 1;
    }
  }

  return {
    comparable_pairs: comparablePairs,
    concordant_pairs: concordantPairs,
    agreement_ratio: comparablePairs > 0
      ? Math.round((concordantPairs / comparablePairs) * 1000) / 1000
      : null,
  };
}

function isSuspiciousCompetitorMatch(name, snippet) {
  if (!AMBIGUOUS_COMPETITOR_NAMES.has(String(name || ""))) return false;
  const text = String(snippet || "");
  if (!text.trim()) return true;
  return !FINANCE_CONTEXT_PATTERN.test(text);
}

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function toScoreRow(score, fallbackMeta) {
  const context = score?.layers?.competitor_context || {};
  const switching = score?.layers?.switching_feasibility || {};
  const detected = Array.isArray(context.detected) ? context.detected : [];

  return {
    company_number: String(score.company_number || fallbackMeta?.company_number || ""),
    company_name: score.company_name || fallbackMeta?.company_name || null,
    turnover: Number(score.turnover || fallbackMeta?.latest_turnover || 0),
    latest_filing_date: fallbackMeta?.latest_filing_date || null,
    text_length: Number(fallbackMeta?.text_length || 0),
    composite_score: Number(score.composite_score || 0),
    fit_score: Number(score.fit_score || 0),
    propensity_score: Number(score.propensity_score || 0),
    best_motion: score?.layers?.product_fit?.best_motion || null,
    competitor_context_score: Number(context.score || 0),
    competitor_context: {
      strategic_signal: context.strategic_signal || null,
      isolation_score: Number(context.isolation_score || 0),
      holistic_score: Number(context.holistic_score || 0),
      anchor_drag: Number(context.anchor_drag || 0),
      platform_consolidation_bonus: Number(context.platform_consolidation_bonus || 0),
      fragmented_stack_bonus: Number(context.fragmented_stack_bonus || 0),
      product_coverage_count: Number(context.product_coverage_count || 0),
      strong_incumbent_count: Number(context.strong_incumbent_count || 0),
      detected_competitors: detected.map((entry) => ({
        name: entry.name,
        source: entry.source || null,
        isolation_score: Number(entry.isolation_score || 0),
        holistic_score: Number(entry.holistic_score || 0),
        platform_type: entry.platform_type || null,
        snippet: entry.snippet || null,
      })),
    },
    switching_feasibility: {
      score: Number(switching.score || 0),
      has_strong_bank_incumbent: Boolean(switching.has_strong_bank_incumbent),
      has_multi_bank_signals: Boolean(switching.has_multi_bank_signals),
      has_long_tenure_incumbent: Boolean(switching.has_long_tenure_incumbent),
    },
  };
}

function summarize(rows) {
  const strategicSignals = {};
  let competitorTagged = 0;

  for (const row of rows) {
    const signal = row?.competitor_context?.strategic_signal || "none";
    strategicSignals[signal] = (strategicSignals[signal] || 0) + 1;

    if ((row?.competitor_context?.detected_competitors || []).length > 0) {
      competitorTagged += 1;
    }
  }

  return {
    rows_scored: rows.length,
    avg_composite_score: rows.length
      ? Math.round((rows.reduce((sum, row) => sum + Number(row.composite_score || 0), 0) / rows.length) * 1000) / 1000
      : 0,
    competitor_signal_coverage_ratio: rows.length
      ? Math.round((competitorTagged / rows.length) * 1000) / 1000
      : 0,
    strategic_signal_distribution: strategicSignals,
  };
}

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, "exports", `scoring-calibration-benchmark-${stamp}.json`);
}

function resolveOutputPath(targetPath, fallback) {
  if (!targetPath) return fallback;
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  let cases = null;
  if (options.cases) {
    cases = loadCasesFile(options.cases);
  }

  const outPath = resolveOutputPath(options.out, defaultOutPath());
  const latestPath = options.latest
    ? resolveOutputPath(options.latest, path.join(repoRoot, "exports", "scoring-calibration-benchmark-latest.json"))
    : null;

  const selection = {
    mode: cases?.company_numbers?.length ? "case_file" : "active_pool",
    requested_limit: options.limit,
    pool_limit: options.poolLimit,
    min_text_length: options.minTextLength,
    cases_file: cases?.path || null,
    cases_label: cases?.label || null,
    cases_notes: cases?.notes || null,
  };

  const candidates = [];
  if (cases?.company_numbers?.length) {
    for (const companyNumber of cases.company_numbers) {
      const filing = getFilingsForCompany(companyNumber, 1)[0] || null;
      const textLength = String(filing?.raw_data || "").trim().length;
      candidates.push({
        company_number: companyNumber,
        company_name: null,
        latest_turnover: null,
        latest_filing_date: filing?.filing_date || null,
        text_length: textLength,
      });
    }
  } else {
    const discovered = findEligibleCandidates(options.limit, options.poolLimit, options.minTextLength);
    selection.examined_count = discovered.examined_count;
    selection.rejected_count = discovered.rejected_count;
    selection.rejected_preview = discovered.rejected_preview;
    candidates.push(...discovered.selected);
  }

  const rows = [];
  const missing = [];
  for (const candidate of candidates) {
    const score = scoreCompany(candidate.company_number);
    if (!score) {
      missing.push({ company_number: candidate.company_number, reason: "no_score" });
      continue;
    }

    rows.push(toScoreRow(score, candidate));
  }

  rows.sort((a, b) => {
    const scoreDelta = Number(b.composite_score || 0) - Number(a.composite_score || 0);
    if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
    const fitDelta = Number(b.fit_score || 0) - Number(a.fit_score || 0);
    if (Math.abs(fitDelta) > 0.0001) return fitDelta;
    return String(a.company_number).localeCompare(String(b.company_number));
  });

  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });

  const suspiciousCompetitorMatches = [];
  for (const row of rows) {
    for (const competitor of row?.competitor_context?.detected_competitors || []) {
      if (!isSuspiciousCompetitorMatch(competitor.name, competitor.snippet)) continue;
      suspiciousCompetitorMatches.push({
        company_number: row.company_number,
        company_name: row.company_name,
        competitor: competitor.name,
        source: competitor.source,
        snippet: competitor.snippet,
      });
    }
  }

  const expectedOrderMetrics = pairwiseAgreement(rows, cases?.expected_order || []);

  const output = {
    generated_at: new Date().toISOString(),
    label: cases?.label || "scoring-calibration-benchmark",
    options,
    selection,
    summary: summarize(rows),
    expected_order_metrics: expectedOrderMetrics,
    missing_company_scores: missing,
    suspicious_competitor_matches: suspiciousCompetitorMatches,
    rows,
  };

  ensureParentDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  if (latestPath) {
    ensureParentDir(latestPath);
    fs.writeFileSync(latestPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  console.log(`Scored rows: ${rows.length}`);
  console.log(`Suspicious competitor matches: ${suspiciousCompetitorMatches.length}`);
  console.log(`Output: ${outPath}`);
  if (latestPath) console.log(`Latest: ${latestPath}`);
  if (expectedOrderMetrics.comparable_pairs > 0) {
    console.log(`Expected-order agreement: ${expectedOrderMetrics.agreement_ratio}`);
  }
}

try {
  main();
} finally {
  closeDb();
}
