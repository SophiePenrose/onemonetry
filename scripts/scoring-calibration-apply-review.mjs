#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.log([
    "Usage: node scripts/scoring-calibration-apply-review.mjs [options]",
    "",
    "Options:",
    "  --cases <path>        Calibration case JSON to update (required)",
    "  --review-csv <path>   Filled review CSV with expected_rank values (required)",
    "  --out <path>          Output path (default: <cases>.updated.json)",
    "  --in-place            Overwrite the case file in place",
    "  --help                Show this help",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    cases: null,
    reviewCsv: null,
    out: null,
    inPlace: false,
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
    if (arg === "--review-csv" && argv[i + 1]) {
      options.reviewCsv = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out" && argv[i + 1]) {
      options.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--in-place") {
      options.inPlace = true;
      continue;
    }
  }

  return options;
}

function resolvePath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(repoRoot, inputPath);
}

function defaultOutputPath(casesPath) {
  const parsed = path.parse(casesPath);
  return path.join(parsed.dir, `${parsed.name}.updated${parsed.ext || ".json"}`);
}

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function parseCsvMatrix(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    throw new Error("Invalid CSV: unterminated quoted field");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length > 0 && rows[0].length > 0) {
    rows[0][0] = String(rows[0][0] || "").replace(/^\uFEFF/, "");
  }

  return rows;
}

function toPositiveInteger(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeCompanyNumber(value) {
  return String(value || "").trim();
}

function uniqueCompanyNumbers(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const next = normalizeCompanyNumber(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    output.push(next);
  }
  return output;
}

function parseReviewCsv(reviewCsvPath) {
  const csvText = fs.readFileSync(reviewCsvPath, "utf8");
  const rows = parseCsvMatrix(csvText);
  if (rows.length === 0) {
    throw new Error("Review CSV is empty");
  }

  const headers = rows[0].map((value) => String(value || "").trim().toLowerCase());
  const companyIdx = headers.indexOf("company_number");
  const expectedRankIdx = headers.indexOf("expected_rank");
  const modelRankIdx = headers.indexOf("model_rank");

  if (companyIdx < 0) throw new Error("Review CSV missing required column: company_number");
  if (expectedRankIdx < 0) throw new Error("Review CSV missing required column: expected_rank");

  const records = [];
  for (let i = 1; i < rows.length; i += 1) {
    const line = rows[i];
    const hasAnyValue = line.some((cell) => String(cell || "").trim().length > 0);
    if (!hasAnyValue) continue;

    records.push({
      line_number: i + 1,
      company_number: normalizeCompanyNumber(line[companyIdx]),
      expected_rank_raw: String(line[expectedRankIdx] || "").trim(),
      model_rank: toPositiveInteger(modelRankIdx >= 0 ? line[modelRankIdx] : null),
    });
  }

  return records;
}

function deriveExpectedOrder(caseData, reviewRecords) {
  const caseCompanies = uniqueCompanyNumbers(caseData?.company_numbers || []);
  const caseSet = new Set(caseCompanies);

  const invalidRows = [];
  const unknownCompanies = new Set();
  const duplicateCompanyRows = new Set();
  const rankedByCompany = new Map();
  const rankCounts = new Map();

  for (const record of reviewRecords) {
    if (!record.company_number && !record.expected_rank_raw) {
      continue;
    }

    if (!record.company_number && record.expected_rank_raw) {
      invalidRows.push({
        line_number: record.line_number,
        reason: "expected_rank provided without company_number",
      });
      continue;
    }

    if (!record.expected_rank_raw) {
      continue;
    }

    const parsedRank = toPositiveInteger(record.expected_rank_raw);
    if (!parsedRank) {
      invalidRows.push({
        line_number: record.line_number,
        reason: `invalid expected_rank: ${record.expected_rank_raw}`,
      });
      continue;
    }

    if (!caseSet.has(record.company_number)) {
      unknownCompanies.add(record.company_number);
      continue;
    }

    if (rankedByCompany.has(record.company_number)) {
      duplicateCompanyRows.add(record.company_number);
      continue;
    }

    rankCounts.set(parsedRank, (rankCounts.get(parsedRank) || 0) + 1);
    rankedByCompany.set(record.company_number, {
      company_number: record.company_number,
      expected_rank: parsedRank,
      model_rank: record.model_rank,
    });
  }

  if (invalidRows.length > 0) {
    throw new Error(`Invalid expected_rank rows: ${JSON.stringify(invalidRows)}`);
  }
  if (unknownCompanies.size > 0) {
    throw new Error(`Review CSV includes companies not in case file: ${JSON.stringify(Array.from(unknownCompanies))}`);
  }
  if (duplicateCompanyRows.size > 0) {
    throw new Error(`Review CSV contains duplicate ranked company rows: ${JSON.stringify(Array.from(duplicateCompanyRows))}`);
  }
  if (rankedByCompany.size === 0) {
    throw new Error("No expected_rank values found in review CSV");
  }

  const ranked = Array.from(rankedByCompany.values()).sort((left, right) => {
    if (left.expected_rank !== right.expected_rank) {
      return left.expected_rank - right.expected_rank;
    }
    const leftModel = left.model_rank || Number.MAX_SAFE_INTEGER;
    const rightModel = right.model_rank || Number.MAX_SAFE_INTEGER;
    if (leftModel !== rightModel) {
      return leftModel - rightModel;
    }
    return left.company_number.localeCompare(right.company_number);
  });

  const ordered = ranked.map((entry) => entry.company_number);
  const orderedSet = new Set(ordered);
  const unranked = caseCompanies.filter((companyNumber) => !orderedSet.has(companyNumber));

  const duplicateExpectedRanks = Array.from(rankCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([rank]) => rank)
    .sort((a, b) => a - b);

  return {
    expectedOrder: [...ordered, ...unranked],
    rankedCount: ranked.length,
    totalCount: caseCompanies.length,
    unrankedCount: unranked.length,
    duplicateExpectedRanks,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.cases || !options.reviewCsv) {
    printUsage();
    throw new Error("Both --cases and --review-csv are required");
  }

  const casesPath = resolvePath(options.cases);
  const reviewCsvPath = resolvePath(options.reviewCsv);
  const outputPath = options.inPlace
    ? casesPath
    : resolvePath(options.out || defaultOutputPath(casesPath));

  const caseData = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const reviewRecords = parseReviewCsv(reviewCsvPath);
  const derived = deriveExpectedOrder(caseData, reviewRecords);

  const metadata = {
    ...(caseData?.metadata || {}),
    review_csv: path.relative(repoRoot, reviewCsvPath),
    review_applied_at: new Date().toISOString(),
    ranked_count: derived.rankedCount,
    total_company_count: derived.totalCount,
  };

  const updatedCaseData = {
    ...caseData,
    expected_order: derived.expectedOrder,
    metadata,
  };

  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(updatedCaseData, null, 2)}\n`, "utf8");

  console.log(`Case file: ${casesPath}`);
  console.log(`Review CSV: ${reviewCsvPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Ranked companies applied: ${derived.rankedCount}/${derived.totalCount}`);
  console.log(`Unranked companies appended: ${derived.unrankedCount}`);
  if (derived.duplicateExpectedRanks.length > 0) {
    console.log(`Duplicate expected_rank values detected: ${derived.duplicateExpectedRanks.join(", ")}`);
  }
}

main();