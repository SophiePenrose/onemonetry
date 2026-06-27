#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const SELECTOR_PROFILES = {
  auto: {
    waitSelectors: ["table tbody tr", "[role='row']"],
    rowSelectors: ["table tbody tr", "[role='row']"],
    nextSelectors: [
      "button[aria-label='Next']",
      "button[aria-label='Next page']",
      "[data-testid='pagination-next']",
      "a[rel='next']",
    ],
    cellSelectors: ["th", "td", "[role='gridcell']", "[role='cell']"],
    linkSelectors: ["a[href]"],
  },
  endole_table: {
    waitSelectors: ["table tbody tr"],
    rowSelectors: ["table tbody tr"],
    nextSelectors: ["button[aria-label='Next']", "[data-testid='pagination-next']", "a[rel='next']"],
    cellSelectors: ["th", "td"],
    linkSelectors: ["a[href]"],
  },
  endole_grid: {
    waitSelectors: ["[role='row']"],
    rowSelectors: ["[role='row']"],
    nextSelectors: ["button[aria-label='Next']", "button[aria-label='Next page']", "a[rel='next']"],
    cellSelectors: ["[role='gridcell']", "[role='cell']"],
    linkSelectors: ["a[href]"],
  },
  generic_table: {
    waitSelectors: ["table tbody tr"],
    rowSelectors: ["table tbody tr"],
    nextSelectors: ["a[rel='next']", "button[aria-label='Next']"],
    cellSelectors: ["th", "td"],
    linkSelectors: ["a[href]"],
  },
};

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
    "  --selector-profile <name>     Selector profile: auto|endole_table|endole_grid|generic_table",
    "  --row-selector <css>          Optional explicit row selector override",
    "  --storage-state-in <path>     Optional Playwright storage state JSON to reuse login session",
    "  --storage-state-out <path>    Optional path to save updated storage state JSON",
    "  --wait-selector <css>         Optional selector to wait for before scraping",
    "  --next-selector <css>         Optional pagination next-button selector for multi-page scrape",
    "  --max-pages <n>               Max pages to scrape when next-selector is used (default: 1)",
    "  --max-empty-pages <n>         Stop after n consecutive empty scraped pages (default: 2)",
    "  --scroll-steps <n>            Auto-scroll steps before extracting each page (default: 0)",
    "  --scroll-delay-ms <n>         Delay between auto-scroll steps (default: 350)",
    "  --max-rows <n>                Keep only first n extracted rows",
    "  --diagnostics-out <path>      Optional JSON diagnostics output path",
    "  --run-summary-out <path>      Optional JSON run summary output path (default: alongside CSV)",
    "  --apply                       Run scripts/import-monitor-seed-list.mjs with generated CSV",
    "  --apply-args <value>          Extra args passed to import-monitor-seed-list script (repeatable)",
    "  --help                        Show this help",
    "",
    "Examples:",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\"",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\" --apply --apply-args --dry-run",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\" --next-selector \"button[aria-label='Next']\" --max-pages 10",
    "  node scripts/import-endole-live.mjs --url \"https://app.endole.co.uk/company-lists/...\" --selector-profile endole_grid --diagnostics-out exports/endole-live-diagnostics.json",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    url: null,
    out: null,
    headless: false,
    selectorProfile: "auto",
    rowSelector: null,
    storageStateIn: null,
    storageStateOut: null,
    waitSelector: null,
    nextSelector: null,
    maxPages: 1,
    maxEmptyPages: 2,
    scrollSteps: 0,
    scrollDelayMs: 350,
    maxRows: null,
    diagnosticsOut: null,
    runSummaryOut: null,
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
    if (arg === "--selector-profile" && argv[i + 1]) {
      options.selectorProfile = String(argv[i + 1] || "").trim().toLowerCase() || "auto";
      i += 1;
      continue;
    }
    if (arg === "--row-selector" && argv[i + 1]) {
      options.rowSelector = String(argv[i + 1] || "").trim() || null;
      i += 1;
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
    if (arg === "--max-empty-pages" && argv[i + 1]) {
      const parsed = Number.parseInt(String(argv[i + 1] || ""), 10);
      options.maxEmptyPages = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
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
    if (arg === "--diagnostics-out" && argv[i + 1]) {
      options.diagnosticsOut = String(argv[i + 1] || "").trim() || null;
      i += 1;
      continue;
    }
    if (arg === "--run-summary-out" && argv[i + 1]) {
      options.runSummaryOut = String(argv[i + 1] || "").trim() || null;
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

function writeJsonFile(targetPath, payload) {
  ensureParentDir(targetPath);
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), "utf8");
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

function resolveSelectorProfile(profileName) {
  const normalized = String(profileName || "auto").trim().toLowerCase() || "auto";
  return SELECTOR_PROFILES[normalized] || SELECTOR_PROFILES.auto;
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

async function scrapeRows(page, selectorOptions = {}) {
  return page.evaluate((runtimeOptions) => {
    function toText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    const rowSelectors = Array.isArray(runtimeOptions.rowSelectors) ? runtimeOptions.rowSelectors : [];
    const cellSelectors = Array.isArray(runtimeOptions.cellSelectors) ? runtimeOptions.cellSelectors : [];
    const linkSelectors = Array.isArray(runtimeOptions.linkSelectors) ? runtimeOptions.linkSelectors : [];

    function extractRowsFromSelector(rowSelector) {
      const rowNodes = Array.from(document.querySelectorAll(String(rowSelector || "").trim())).filter(Boolean);
      if (!rowNodes.length) {
        return [];
      }

      return rowNodes
        .map((row) => {
          const cellValues = [];
          for (const cellSelector of cellSelectors) {
            const matches = Array.from(row.querySelectorAll(String(cellSelector || "").trim())).map((cell) => toText(cell.textContent));
            cellValues.push(...matches);
          }

          if (cellValues.length === 0) {
            const fallbackCells = Array.from(row.querySelectorAll("th, td, [role='gridcell'], [role='cell']"))
              .map((cell) => toText(cell.textContent));
            cellValues.push(...fallbackCells);
          }

          const links = [];
          for (const linkSelector of linkSelectors) {
            const matches = Array.from(row.querySelectorAll(String(linkSelector || "").trim()))
              .map((anchor) => String(anchor.href || "").trim())
              .filter(Boolean);
            links.push(...matches);
          }

          if (links.length === 0) {
            const fallbackLinks = Array.from(row.querySelectorAll("a[href]"))
              .map((anchor) => String(anchor.href || "").trim())
              .filter(Boolean);
            links.push(...fallbackLinks);
          }

          const uniqueCells = Array.from(new Set(cellValues.filter(Boolean)));
          const uniqueLinks = Array.from(new Set(links.filter(Boolean)));
          return {
            cells: uniqueCells,
            links: uniqueLinks,
            raw: toText(row.textContent),
          };
        })
        .filter((entry) => entry.cells.length > 0 || entry.raw || entry.links.length > 0);
    }

    for (const rowSelector of rowSelectors) {
      const extracted = extractRowsFromSelector(rowSelector);
      if (extracted.length > 0) {
        return {
          extractor: `row_selector:${rowSelector}`,
          rows: extracted,
        };
      }
    }

    return {
      extractor: "none",
      rows: [],
    };
  }, selectorOptions);
}

function findWebsiteCandidateFromCells(cells = []) {
  for (const cell of cells) {
    const text = String(cell || "").trim();
    if (!text) continue;
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(text)) return `https://${text}`;
  }
  return "";
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

    const websiteFromCells = findWebsiteCandidateFromCells(row?.cells || []);
    const companyWebsite = normalizeWebsite(candidateLinks[0] || websiteFromCells || "");
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
  const diagnosticsOutPath = options.diagnosticsOut ? resolvePath(options.diagnosticsOut) : null;
  const outPathExtension = path.extname(outPath);
  const outPathWithoutExtension = outPathExtension ? outPath.slice(0, -outPathExtension.length) : outPath;
  const runSummaryOutPath = options.runSummaryOut
    ? resolvePath(options.runSummaryOut)
    : `${outPathWithoutExtension}-run-summary.json`;
  const selectorProfile = resolveSelectorProfile(options.selectorProfile);

  const rowSelectors = [
    ...(options.rowSelector ? [options.rowSelector] : []),
    ...(Array.isArray(selectorProfile.rowSelectors) ? selectorProfile.rowSelectors : []),
  ].filter(Boolean);
  const waitSelectors = [
    ...(options.waitSelector ? [options.waitSelector] : []),
    ...(Array.isArray(selectorProfile.waitSelectors) ? selectorProfile.waitSelectors : []),
  ].filter(Boolean);
  const nextSelectors = [
    ...(options.nextSelector ? [options.nextSelector] : []),
    ...(Array.isArray(selectorProfile.nextSelectors) ? selectorProfile.nextSelectors : []),
  ].filter(Boolean);

  const diagnostics = {
    generated_at: new Date().toISOString(),
    url: options.url,
    selector_profile: options.selectorProfile,
    selectors: {
      wait: waitSelectors,
      row: rowSelectors,
      next: nextSelectors,
    },
    pages: [],
    summary: {
      pages_visited: 0,
      raw_rows: 0,
      deduped_rows: 0,
      output_rows: 0,
      stop_reason: null,
    },
  };

  const runSummary = {
    generated_at: new Date().toISOString(),
    status: "running",
    source_url: options.url,
    output: {
      csv_path: outPath,
      diagnostics_path: diagnosticsOutPath,
      run_summary_path: runSummaryOutPath,
    },
    options: {
      headless: !!options.headless,
      selector_profile: options.selectorProfile,
      row_selector: options.rowSelector,
      wait_selector: options.waitSelector,
      next_selector: options.nextSelector,
      max_pages: options.maxPages,
      max_empty_pages: options.maxEmptyPages,
      scroll_steps: options.scrollSteps,
      scroll_delay_ms: options.scrollDelayMs,
      max_rows: options.maxRows,
      apply: !!options.apply,
      apply_args: options.applyArgs,
    },
    extraction: {
      pages_visited: 0,
      raw_rows: 0,
      deduped_rows: 0,
      output_rows: 0,
      stop_reason: null,
      pages: [],
    },
    apply: {
      requested: !!options.apply,
      executed: false,
      exit_code: null,
    },
    error: null,
  };

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

    if (waitSelectors.length > 0) {
      let matchedWaitSelector = null;
      for (const selector of waitSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 3500 });
          matchedWaitSelector = selector;
          break;
        } catch {
          // Try next selector fallback.
        }
      }
      if (matchedWaitSelector) {
        console.log(`Detected rows using selector: ${matchedWaitSelector}`);
      } else {
        console.log("No wait selector matched quickly; continuing with fallback extraction.");
      }
    }

    if (!options.headless) {
      console.log("Log in and open the table you want to scrape in the launched browser.");
      await waitForEnter("Press Enter here when the table is visible and fully loaded... ");
    }

    const aggregatedRows = [];
    const pageLimit = nextSelectors.length > 0 ? Math.max(1, options.maxPages) : 1;
    let consecutiveEmptyPages = 0;

    for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
      if (options.scrollSteps > 0) {
        await autoScrollPage(page, options.scrollSteps, options.scrollDelayMs);
      }

      const extracted = await scrapeRows(page, {
        rowSelectors,
        cellSelectors: selectorProfile.cellSelectors,
        linkSelectors: selectorProfile.linkSelectors,
      });
      const rawRows = Array.isArray(extracted?.rows) ? extracted.rows : [];
      const mappedRows = mapScrapedRows(rawRows, page.url());
      aggregatedRows.push(...mappedRows);

      diagnostics.pages.push({
        page_index: pageIndex,
        url: page.url(),
        extractor: extracted?.extractor || "none",
        raw_rows: rawRows.length,
        mapped_rows: mappedRows.length,
      });
      diagnostics.summary.pages_visited = pageIndex;
      diagnostics.summary.raw_rows += rawRows.length;

      console.log(`Scraped page ${pageIndex}: ${mappedRows.length} mapped rows (${rawRows.length} raw, ${extracted?.extractor || "none"})`);

      if (mappedRows.length === 0) {
        consecutiveEmptyPages += 1;
      } else {
        consecutiveEmptyPages = 0;
      }

      if (consecutiveEmptyPages > options.maxEmptyPages) {
        diagnostics.summary.stop_reason = "max_empty_pages_reached";
        console.log(`Stopping after ${consecutiveEmptyPages} consecutive empty pages.`);
        break;
      }

      if (nextSelectors.length === 0 || pageIndex >= pageLimit) {
        diagnostics.summary.stop_reason = diagnostics.summary.stop_reason || "no_next_selector_or_page_limit_reached";
        break;
      }

      let clickedNext = false;
      for (const selector of nextSelectors) {
        const nextButton = page.locator(selector).first();
        const nextCount = await nextButton.count();
        if (nextCount < 1) continue;
        if (!(await nextButton.isVisible()) || !(await nextButton.isEnabled())) continue;

        await nextButton.click();
        diagnostics.pages[diagnostics.pages.length - 1].next_selector = selector;
        clickedNext = true;
        break;
      }

      if (!clickedNext) {
        diagnostics.summary.stop_reason = "next_button_unavailable";
        console.log("No usable next-button selector found; stopping pagination.");
        break;
      }

      await sleep(700);
      if (waitSelectors.length > 0) {
        let waitMatched = false;
        for (const selector of waitSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 3000 });
            waitMatched = true;
            break;
          } catch {
            // try next selector
          }
        }
        if (!waitMatched) {
          await sleep(500);
        }
      }
    }

    const mappedRows = dedupeRows(aggregatedRows);
    const rows = options.maxRows ? mappedRows.slice(0, options.maxRows) : mappedRows;
    diagnostics.summary.deduped_rows = mappedRows.length;
    diagnostics.summary.output_rows = rows.length;

    if (!rows.length) {
      if (diagnosticsOutPath) {
        writeJsonFile(diagnosticsOutPath, diagnostics);
      }
      throw new Error("No rows were extracted. Try --wait-selector or ensure table rows are visible before pressing Enter.");
    }

    ensureParentDir(outPath);
    fs.writeFileSync(outPath, toSeedCsv(rows), "utf8");
    console.log(`Wrote ${rows.length} rows to ${outPath}`);

    if (storageStateOutPath) {
      ensureParentDir(storageStateOutPath);
      await context.storageState({ path: storageStateOutPath });
      console.log(`Saved storage state to ${storageStateOutPath}`);
    }

    if (diagnosticsOutPath) {
      writeJsonFile(diagnosticsOutPath, diagnostics);
      console.log(`Saved diagnostics to ${diagnosticsOutPath}`);
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
    runSummary.apply.executed = true;

    console.log("Running seed import script with generated CSV...");
    const result = spawnSync(process.execPath, applyArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    runSummary.apply.exit_code = Number.isInteger(result.status) ? result.status : 1;

    if (result.status !== 0) {
      throw new Error(`Seed import script failed with exit code ${runSummary.apply.exit_code}.`);
    }
  } catch (error) {
    runSummary.status = "failed";
    runSummary.error = String(error?.message || error);
    throw error;
  } finally {
    runSummary.extraction = {
      ...diagnostics.summary,
      pages: diagnostics.pages,
    };
    if (runSummary.status === "running") {
      runSummary.status = "success";
    }
    writeJsonFile(runSummaryOutPath, runSummary);
    console.log(`Saved run summary to ${runSummaryOutPath}`);
    await browser.close();
  }
}

run().catch((error) => {
  console.error("import-endole-live failed:", error?.message || error);
  process.exit(1);
});
