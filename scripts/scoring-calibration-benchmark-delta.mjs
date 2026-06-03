#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.log([
    "Usage: node scripts/scoring-calibration-benchmark-delta.mjs --base <path> --head <path> [options]",
    "",
    "Options:",
    "  --base <path>          Base benchmark JSON (required)",
    "  --head <path>          Head benchmark JSON (required)",
    "  --out <path>           Output JSON path (default: exports/scoring-calibration-benchmark-delta.json)",
    "  --markdown <path>      Output markdown path (default: exports/scoring-calibration-benchmark-delta.md)",
    "  --top-movers <n>       Number of rank movers to include (default: 10)",
    "  --help                 Show this help",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    base: null,
    head: null,
    out: "exports/scoring-calibration-benchmark-delta.json",
    markdown: "exports/scoring-calibration-benchmark-delta.md",
    topMovers: 10,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--base" && argv[i + 1]) {
      options.base = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--head" && argv[i + 1]) {
      options.head = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out" && argv[i + 1]) {
      options.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--markdown" && argv[i + 1]) {
      options.markdown = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--top-movers" && argv[i + 1]) {
      options.topMovers = Number.parseInt(argv[i + 1], 10) || options.topMovers;
      i += 1;
      continue;
    }
  }

  options.topMovers = Math.max(1, options.topMovers);
  return options;
}

function resolvePath(inputPath) {
  if (!inputPath) return null;
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sortByCompanyNumber(left, right) {
  return String(left.company_number || "").localeCompare(String(right.company_number || ""));
}

function loadBenchmark(filePath, label) {
  const resolved = resolvePath(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`${label} benchmark file not found: ${filePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return {
    path: resolved,
    data: parsed,
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
  };
}

function getStrategicSignal(row) {
  return String(row?.competitor_context?.strategic_signal || "none");
}

function buildDistributionDelta(baseDist = {}, headDist = {}) {
  const keys = [...new Set([...Object.keys(baseDist), ...Object.keys(headDist)])].sort();
  const output = {};
  for (const key of keys) {
    const baseValue = Number(baseDist[key] || 0);
    const headValue = Number(headDist[key] || 0);
    output[key] = {
      base: baseValue,
      head: headValue,
      delta: headValue - baseValue,
    };
  }
  return output;
}

function buildDelta(baseBenchmark, headBenchmark, topMovers) {
  const baseRows = baseBenchmark.rows;
  const headRows = headBenchmark.rows;

  const baseMap = new Map(baseRows.map((row) => [String(row.company_number || ""), row]));
  const headMap = new Map(headRows.map((row) => [String(row.company_number || ""), row]));

  const ids = [...new Set([...baseMap.keys(), ...headMap.keys()])]
    .filter(Boolean)
    .sort();

  const added = [];
  const removed = [];
  const rankChanged = [];
  const motionChanged = [];
  const strategicSignalChanged = [];
  const scoreChanged = [];

  for (const companyNumber of ids) {
    const base = baseMap.get(companyNumber);
    const head = headMap.get(companyNumber);

    if (!base && head) {
      added.push({
        company_number: companyNumber,
        company_name: head.company_name || null,
        head_rank: toNumber(head.rank),
      });
      continue;
    }

    if (base && !head) {
      removed.push({
        company_number: companyNumber,
        company_name: base.company_name || null,
        base_rank: toNumber(base.rank),
      });
      continue;
    }

    const baseRank = toNumber(base.rank);
    const headRank = toNumber(head.rank);
    const rankDelta = baseRank !== null && headRank !== null ? headRank - baseRank : null;

    const baseScore = toNumber(base.composite_score);
    const headScore = toNumber(head.composite_score);
    const scoreDelta = baseScore !== null && headScore !== null ? headScore - baseScore : null;

    if (rankDelta !== null && rankDelta !== 0) {
      rankChanged.push({
        company_number: companyNumber,
        company_name: head.company_name || base.company_name || null,
        base_rank: baseRank,
        head_rank: headRank,
        rank_delta: rankDelta,
        base_composite_score: baseScore,
        head_composite_score: headScore,
        score_delta: scoreDelta,
      });
    }

    if (String(base.best_motion || "") !== String(head.best_motion || "")) {
      motionChanged.push({
        company_number: companyNumber,
        company_name: head.company_name || base.company_name || null,
        base_best_motion: base.best_motion || null,
        head_best_motion: head.best_motion || null,
      });
    }

    const baseSignal = getStrategicSignal(base);
    const headSignal = getStrategicSignal(head);
    if (baseSignal !== headSignal) {
      strategicSignalChanged.push({
        company_number: companyNumber,
        company_name: head.company_name || base.company_name || null,
        base_signal: baseSignal,
        head_signal: headSignal,
      });
    }

    if (scoreDelta !== null && Math.abs(scoreDelta) >= 0.0001) {
      scoreChanged.push({
        company_number: companyNumber,
        company_name: head.company_name || base.company_name || null,
        base_composite_score: baseScore,
        head_composite_score: headScore,
        score_delta: scoreDelta,
      });
    }
  }

  rankChanged.sort((left, right) => {
    const absDelta = Math.abs(right.rank_delta) - Math.abs(left.rank_delta);
    if (absDelta !== 0) return absDelta;
    return sortByCompanyNumber(left, right);
  });

  added.sort(sortByCompanyNumber);
  removed.sort(sortByCompanyNumber);
  motionChanged.sort(sortByCompanyNumber);
  strategicSignalChanged.sort(sortByCompanyNumber);
  scoreChanged.sort(sortByCompanyNumber);

  const baseSummary = baseBenchmark.data.summary || {};
  const headSummary = headBenchmark.data.summary || {};

  return {
    generated_at: new Date().toISOString(),
    base_file: baseBenchmark.path,
    head_file: headBenchmark.path,
    metrics: {
      base_rows_scored: baseRows.length,
      head_rows_scored: headRows.length,
      rows_delta: headRows.length - baseRows.length,
      base_avg_composite_score: toNumber(baseSummary.avg_composite_score),
      head_avg_composite_score: toNumber(headSummary.avg_composite_score),
      avg_composite_score_delta: (() => {
        const baseValue = toNumber(baseSummary.avg_composite_score);
        const headValue = toNumber(headSummary.avg_composite_score);
        if (baseValue === null || headValue === null) return null;
        return headValue - baseValue;
      })(),
      base_expected_order_agreement: toNumber(baseBenchmark.data?.expected_order_metrics?.agreement_ratio),
      head_expected_order_agreement: toNumber(headBenchmark.data?.expected_order_metrics?.agreement_ratio),
      expected_order_agreement_delta: (() => {
        const baseValue = toNumber(baseBenchmark.data?.expected_order_metrics?.agreement_ratio);
        const headValue = toNumber(headBenchmark.data?.expected_order_metrics?.agreement_ratio);
        if (baseValue === null || headValue === null) return null;
        return headValue - baseValue;
      })(),
      base_suspicious_competitor_matches: Array.isArray(baseBenchmark.data?.suspicious_competitor_matches)
        ? baseBenchmark.data.suspicious_competitor_matches.length
        : 0,
      head_suspicious_competitor_matches: Array.isArray(headBenchmark.data?.suspicious_competitor_matches)
        ? headBenchmark.data.suspicious_competitor_matches.length
        : 0,
    },
    changed_counts: {
      added: added.length,
      removed: removed.length,
      rank_changed: rankChanged.length,
      best_motion_changed: motionChanged.length,
      strategic_signal_changed: strategicSignalChanged.length,
      score_changed: scoreChanged.length,
    },
    strategic_signal_distribution_delta: buildDistributionDelta(
      baseSummary.strategic_signal_distribution || {},
      headSummary.strategic_signal_distribution || {},
    ),
    top_rank_movers: rankChanged.slice(0, topMovers),
    added_rows: added,
    removed_rows: removed,
    best_motion_changes: motionChanged,
    strategic_signal_changes: strategicSignalChanged,
    score_changes: scoreChanged,
  };
}

function formatMetric(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  if (Number.isInteger(value)) return String(value);
  return Number(value).toFixed(digits);
}

function formatSigned(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  const numeric = Number(value);
  const sign = numeric > 0 ? "+" : "";
  if (Number.isInteger(numeric)) return `${sign}${numeric}`;
  return `${sign}${numeric.toFixed(digits)}`;
}

function toMarkdown(delta) {
  const lines = [];
  lines.push("## Scoring Benchmark Delta");
  lines.push("");
  lines.push(`Generated: ${delta.generated_at}`);
  lines.push("");
  lines.push("| Metric | Base | Head | Delta |");
  lines.push("|---|---:|---:|---:|");
  lines.push(`| Rows scored | ${formatMetric(delta.metrics.base_rows_scored, 0)} | ${formatMetric(delta.metrics.head_rows_scored, 0)} | ${formatSigned(delta.metrics.rows_delta, 0)} |`);
  lines.push(`| Avg composite score | ${formatMetric(delta.metrics.base_avg_composite_score)} | ${formatMetric(delta.metrics.head_avg_composite_score)} | ${formatSigned(delta.metrics.avg_composite_score_delta)} |`);
  lines.push(`| Expected-order agreement | ${formatMetric(delta.metrics.base_expected_order_agreement)} | ${formatMetric(delta.metrics.head_expected_order_agreement)} | ${formatSigned(delta.metrics.expected_order_agreement_delta)} |`);
  lines.push(`| Suspicious competitor matches | ${formatMetric(delta.metrics.base_suspicious_competitor_matches, 0)} | ${formatMetric(delta.metrics.head_suspicious_competitor_matches, 0)} | ${formatSigned(delta.metrics.head_suspicious_competitor_matches - delta.metrics.base_suspicious_competitor_matches, 0)} |`);
  lines.push(`| Rank-changed rows | n/a | ${formatMetric(delta.changed_counts.rank_changed, 0)} | n/a |`);
  lines.push(`| Best-motion changed rows | n/a | ${formatMetric(delta.changed_counts.best_motion_changed, 0)} | n/a |`);
  lines.push(`| Strategic-signal changed rows | n/a | ${formatMetric(delta.changed_counts.strategic_signal_changed, 0)} | n/a |`);
  lines.push("");

  lines.push("### Top Rank Movers");
  lines.push("");
  if (!delta.top_rank_movers.length) {
    lines.push("No rank movement detected.");
    lines.push("");
  } else {
    lines.push("| Company | Number | Base Rank | Head Rank | Rank Delta | Score Delta |");
    lines.push("|---|---|---:|---:|---:|---:|");
    for (const row of delta.top_rank_movers) {
      lines.push(`| ${row.company_name || "(unknown)"} | ${row.company_number} | ${formatMetric(row.base_rank, 0)} | ${formatMetric(row.head_rank, 0)} | ${formatSigned(row.rank_delta, 0)} | ${formatSigned(row.score_delta)} |`);
    }
    lines.push("");
  }

  lines.push("### Strategic Signal Distribution Delta");
  lines.push("");
  const dist = Object.entries(delta.strategic_signal_distribution_delta || {});
  if (!dist.length) {
    lines.push("No strategic signal distribution data available.");
    lines.push("");
  } else {
    lines.push("| Signal | Base | Head | Delta |");
    lines.push("|---|---:|---:|---:|");
    for (const [signal, values] of dist) {
      lines.push(`| ${signal} | ${formatMetric(values.base, 0)} | ${formatMetric(values.head, 0)} | ${formatSigned(values.delta, 0)} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.base || !options.head) {
    throw new Error("Both --base and --head are required.");
  }

  const base = loadBenchmark(options.base, "base");
  const head = loadBenchmark(options.head, "head");
  const delta = buildDelta(base, head, options.topMovers);
  const markdown = toMarkdown(delta);

  const outPath = resolvePath(options.out);
  const markdownPath = resolvePath(options.markdown);

  ensureParentDir(outPath);
  ensureParentDir(markdownPath);

  fs.writeFileSync(outPath, `${JSON.stringify(delta, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");

  console.log(`Benchmark delta JSON: ${outPath}`);
  console.log(`Benchmark delta markdown: ${markdownPath}`);
  console.log(`Rank movers: ${delta.changed_counts.rank_changed}`);
  console.log(`Best-motion changes: ${delta.changed_counts.best_motion_changed}`);
  console.log(`Strategic-signal changes: ${delta.changed_counts.strategic_signal_changed}`);
}

main();
