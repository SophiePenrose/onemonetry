#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.log([
    "Usage: node scripts/import-endole-live.mjs --url <endole-page-url> [options]",
    "",
    "Open an interactive browser session, let you sign in manually, scrape visible rows,",
    "and write a seed-list CSV compatible with scripts/import-monitor-seed-list.mjs.",
    "",
    "Options:",
    "  --url <value>                 Endole page URL to scrape (required)",
    "  --out <path>                  Output CSV path (default: exports/endole-live-<timestamp>.csv)",
    "  --headless                    Run browser headless (default: false)",
    "  --storage-state-in <path>     Optional Playwright storage state JSON to reuse login session",
    "  --storage-state-out <path>    Optional path to save updated storage state JSON",
    "  --wait-selector <css>         Optional selector to wait for before scraping",
    "  --next-selector <css>         Optional pagination next-button selector for multi-page scrape",
    "  --max-pages <n>               Max pages to scrape when next-selector is used (default: 1)",
    "  --scroll-steps <n>            Auto-scroll steps before extracting each page (default: 0)",
    "  --scroll-delay-ms <n>         Delay between auto-scroll steps (default: 350)",
    "  --max-rows <n>                Keep only first n extracted rows",
    "  --apply                       Run scripts/import-monitor-seed-list.mjs with generated CSV",
    "  --apply-args <value>          Extra args passed to import-monitor-seed-list script (repeatable)",
    "  --help                        Show this help",
    "",
    "Examples:",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\"",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\" --apply --apply-args --dry-run",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\" --next-selector \"button[aria-label='Next']\" --max-pages 10",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    url: null,
    out: null,
    headless: false,
    storageStateIn: null,
    storageStateOut: null,
    waitSelector: null,
    nextSelector: null,
    maxPages: 1,
    scrollSteps: 0,
    scrollDelayMs: 350,
    maxRows: null,
    apply: false,
    applyArgs: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--url" && argv[i + 1]) {
      options.url = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--out" && argv[i + 1]) {
      options.out = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--headless") {
      options.headless = true;
      continue;
    }
    if (arg === "--storage-state-in" && argv[i + 1]) {
      options.storageStateIn = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--storage-state-out" && argv[i + 1]) {
      options.storageStateOut = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--wait-selector" && argv[i + 1]) {
      options.waitSelector = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--next-selector" && argv[i + 1]) {
      options.nextSelector = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--max-pages" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      options.maxPages = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      i += 1;
      continue;
    }
    if (arg === "--scroll-steps" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      options.scrollSteps = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      i += 1;
      continue;
    }
    if (arg === "--scroll-delay-ms" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      options.scrollDelayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 350;
      i += 1;
      continue;
    }
    if (arg === "--max-rows" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      options.maxRows = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      i += 1;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--apply-args" && argv[i + 1]) {
      options.applyArgs.push(String(argv[i + 1] || ""));
      i += 1;
      continue;
    }

    options.applyArgs.push(String(arg));
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

function toIsoTimestampCompact(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function normalizeCompanyNumber(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^CH-/, "")
    .replace(/\s+/g, "");
  if (!raw) return "";
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, "0");
  if (/^[A-Z]{2}\d{6}$/.test(raw)) return raw;
  return "";
}

function normalizeWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return "https://" + raw.replace(/^\/+/, "");
}

function extractDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return String(url.hostname || "").toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toSeedCsv(rows) {
  const header = [
    "company_number",
    "company_name",
    "company_website",
    "company_domain",
    "source_url",
    "scraped_at",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      csvEscape(row.company_number),
      csvEscape(row.company_name),
      csvEscape(row.company_website),
      csvEscape(row.company_domain),
      csvEscape(row.source_url),
      csvEscape(row.scraped_at),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error("Playwright is not installed. Run: npm install -D playwright");
    process.exit(1);
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  const deduped = [];

  for (const row of rows) {
    const key = row.company_number
      ? `num:${row.company_number}`
      : `name:${String(row.company_name || "").trim().toLowerCase()}|dom:${String(row.company_domain || "").trim().toLowerCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

async function autoScrollPage(page, steps, delayMs) {
  const safeSteps = Math.max(0, Number.parseInt(String(steps || 0), 10) || 0);
  if (safeSteps < 1) return;

  for (let i = 0; i < safeSteps; i += 1) {
    await page.evaluate(() => {
      const target = document.scrollingElement || document.body || document.documentElement;
      const delta = Math.max(500, Math.floor(window.innerHeight * 0.8));
      target.scrollBy({ top: delta, left: 0, behavior: "instant" });
    });
    await sleep(Math.max(0, Number.parseInt(String(delayMs || 0), 10) || 0));
  }
}

async function scrapeRows(page) {
  return page.evaluate(() => {
    function toText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function extractRowsFromTable() {
      const bodyRows = Array.from(document.querySelectorAll("table tbody tr"));
      if (!bodyRows.length) return [];
      return bodyRows.map((row) => {
        const cells = Array.from(row.querySelectorAll("th, td")).map((cell) => toText(cell.textContent));
        const links = Array.from(row.querySelectorAll("a[href]")).map((a) => String(a.href || "").trim()).filter(Boolean);
        return { cells, links, raw: toText(row.textContent) };
      });
    }

    function extractRowsFromRoleGrid() {
      const rows = Array.from(document.querySelectorAll("[role='row']"));
      if (!rows.length) return [];
      return rows
        .map((row) => {
          const cells = Array.from(row.querySelectorAll("[role='gridcell'], [role='cell']")).map((cell) => toText(cell.textContent));
          const links = Array.from(row.querySelectorAll("a[href]")).map((a) => String(a.href || "").trim()).filter(Boolean);
          return { cells, links, raw: toText(row.textContent) };
        })
        .filter((entry) => entry.cells.length > 0 || entry.raw);
    }

    const extracted = extractRowsFromTable();
    if (extracted.length > 0) return extracted;
    return extractRowsFromRoleGrid();
  });
}

function mapScrapedRows(rows, sourceUrl) {
  const scrapedAt = new Date().toISOString();
  const companyNumberRegex = /\b(?:\d{8}|[A-Z]{2}\d{6})\b/g;

  const mapped = [];

  for (const row of rows) {
    const rawText = String(row?.raw || "").toUpperCase();
    const numberMatch = rawText.match(companyNumberRegex);
    const companyNumber = normalizeCompanyNumber(numberMatch?.[0] || "");

    let companyName = "";
    for (const cell of (row?.cells || [])) {
      const text = String(cell || "").trim();
      if (!text) continue;
      if (normalizeCompanyNumber(text)) continue;
      if (/^https?:\/\//i.test(text)) continue;
      companyName = text;
      break;
    }

    const candidateLinks = (row?.links || []).filter((href) => {
      const lower = String(href || "").toLowerCase();
      if (!lower.startsWith("http")) return false;
      if (lower.includes("endole.co.uk")) return false;
      if (lower.includes("linkedin.com")) return false;
      return true;
    });

    const companyWebsite = normalizeWebsite(candidateLinks[0] || "");
    const companyDomain = extractDomain(companyWebsite);

    if (!companyNumber && !companyName) continue;

    mapped.push({
      company_number: companyNumber,
      company_name: companyName,
      company_website: companyWebsite,
      company_domain: companyDomain,
      source_url: sourceUrl,
      scraped_at: scrapedAt,
    });
  }

  return dedupeRows(mapped);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (!options.url) {
    console.error("Missing required --url argument.");
    printUsage();
    process.exit(1);
  }

  const defaultOut = path.join("exports", `endole-live-${toIsoTimestampCompact()}.csv`);
  const outPath = resolvePath(options.out || defaultOut);
  const storageStateInPath = options.storageStateIn ? resolvePath(options.storageStateIn) : null;
  const storageStateOutPath = options.storageStateOut ? resolvePath(options.storageStateOut) : null;

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !!options.headless });

  try {
    const contextOptions = { viewport: { width: 1440, height: 1000 } };
    if (storageStateInPath && fs.existsSync(storageStateInPath)) {
      contextOptions.storageState = storageStateInPath;
      console.log(`Loaded storage state from ${storageStateInPath}`);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    console.log(`Opening ${options.url}`);
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 90000 });

    if (options.waitSelector) {
      console.log(`Waiting for selector: ${options.waitSelector}`);
      await page.waitForSelector(options.waitSelector, { timeout: 90000 });
    }

    if (!options.headless) {
      console.log("Log in and open the table you want to scrape in the launched browser.");
      await waitForEnter("Press Enter here when the table is visible and fully loaded... ");
    }

    const aggregatedRows = [];
    const pageLimit = options.nextSelector ? Math.max(1, options.maxPages) : 1;

    for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
      if (options.scrollSteps > 0) {
        await autoScrollPage(page, options.scrollSteps, options.scrollDelayMs);
      }

      const rawRows = await scrapeRows(page);
      const mappedRows = mapScrapedRows(rawRows, page.url());
      aggregatedRows.push(...mappedRows);
      console.log(`Scraped page ${pageIndex}: ${mappedRows.length} rows`);

      if (!options.nextSelector || pageIndex >= pageLimit) {
        break;
      }

      const nextButton = page.locator(options.nextSelector).first();
      const nextCount = await nextButton.count();
      if (nextCount < 1) {
        console.log(`No next button found for selector: ${options.nextSelector}`);
        break;
      }

      if (!(await nextButton.isVisible()) || !(await nextButton.isEnabled())) {
        console.log("Next button is not visible/enabled; stopping pagination.");
        break;
      }

      await nextButton.click();
      await sleep(700);
      if (options.waitSelector) {
        await page.waitForSelector(options.waitSelector, { timeout: 90000 });
      }
    }

    const mappedRows = dedupeRows(aggregatedRows);
    const rows = options.maxRows ? mappedRows.slice(0, options.maxRows) : mappedRows;

    if (!rows.length) {
      console.error("No rows were extracted. Try --wait-selector or ensure table rows are visible before pressing Enter.");
      process.exit(1);
    }

    ensureParentDir(outPath);
    fs.writeFileSync(outPath, toSeedCsv(rows), "utf8");
    console.log(`Wrote ${rows.length} rows to ${outPath}`);

    if (storageStateOutPath) {
      ensureParentDir(storageStateOutPath);
      await context.storageState({ path: storageStateOutPath });
      console.log(`Saved storage state to ${storageStateOutPath}`);
    }

    if (!options.apply) {
      const relativeOut = path.relative(repoRoot, outPath) || outPath;
      console.log("Next step:");
      console.log(`node scripts/import-monitor-seed-list.mjs ${relativeOut}`);
      return;
    }

    const { spawnSync } = await import("node:child_process");
    const importScript = path.resolve(__dirname, "import-monitor-seed-list.mjs");
    const relativeOut = path.relative(repoRoot, outPath) || outPath;
    const applyArgs = [importScript, ...options.applyArgs, relativeOut];

    console.log("Running seed import script with generated CSV...");
    const result = spawnSync(process.execPath, applyArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });

    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error("import-endole-live failed:", error?.message || error);
  process.exit(1);
});
