import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import {
  ensureDataDir,
  isZipProcessed,
  markZipProcessed,
} from "./processed-zips.js";
// bulk-processor.js

const CH_DOWNLOAD_BASE = "https://download.companieshouse.gov.uk";
const TURNOVER_MIN_THRESHOLD = 30_000_000;
const TURNOVER_MAX_THRESHOLD = 200_000_000;
const DATA_DIR = path.join(process.cwd(), "mock-backend", "data");
export const MONTHLY_BACKFILL_MONTHS = 24;

function isTurnoverInEligibleRange(turnover) {
  return Number.isFinite(turnover)
    && turnover >= TURNOVER_MIN_THRESHOLD
    && turnover <= TURNOVER_MAX_THRESHOLD;
}

// --- Turnover extraction from iXBRL/XBRL ---

function extractTurnoverFromContent(content) {
  const patterns = [
    /<ix:nonFraction[^>]*name="[^"]*(?:Turnover|Revenue|TotalRevenue|NetRevenue|GrossRevenue)[^"]*"[^>]*>([\d,.\s]+)</gi,
    /name="[^"]*(?:uk-gaap:Turnover|frs-102:TurnoverRevenue|frs-101:Revenue|core:Turnover)[^"]*"[^>]*>([\d,.\s]+)</gi,
    /name="[^"]*Turnover[^"]*"[^>]*>([\d,.\s]+)</gi,
    /name="[^"]*Revenue[^"]*"[^>]*>([\d,.\s]+)</gi,
  ];

  const values = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const cleaned = match[1].replace(/[,\s]/g, "");
      const num = parseFloat(cleaned);
      if (!isNaN(num) && num > 0) values.push(num);
    }
  }

  if (values.length === 0) return null;
  return Math.max(...values);
}

function extractCompanyNumberFromFilename(filename) {
  const match = filename.match(/Prod\d+_\d+_(\d{8})_/);
  return match ? match[1] : null;
}

// --- Scrape actual available files from CH download pages ---

async function scrapeAvailableZips(pageUrl, linkPattern) {
  try {
    const res = await fetch(pageUrl);
    if (!res.ok) return [];
    const html = await res.text();
    const matches = [...html.matchAll(new RegExp(`href="(${linkPattern})"`, "gi"))];
    return matches.map((m) => m[1]);
  } catch {
    return [];
  }
}

// --- Monthly ZIP URLs ---

let monthlyCache = { files: [], fetched: 0 };

function refreshProcessedFlags(files) {
  return files.map((file) => ({
    ...file,
    processed: isZipProcessed(file.filename),
  }));
}

function monthlyFilenameFromHref(href) {
  return href.replace(/^archive\//, "");
}

export function selectRecentMonthlyFiles(files, limit = MONTHLY_BACKFILL_MONTHS) {
  return [...files]
    .filter((file) => /^\d{4}-\d{2}$/.test(file.period))
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, limit);
}

export function buildMonthlyZipFileList(currentFiles, archiveFiles, options = {}) {
  const isProcessed = options.isProcessed ?? isZipProcessed;
  const limit = options.limit ?? MONTHLY_BACKFILL_MONTHS;
  const seenFilenames = new Set();

  const current = currentFiles.map((href) => {
    const filename = monthlyFilenameFromHref(href);
    seenFilenames.add(filename);
    return {
      filename,
      url: `${CH_DOWNLOAD_BASE}/${href}`,
      period: extractPeriodFromFilename(filename),
      source: "current",
      processed: isProcessed(filename),
    };
  });

  const archive = archiveFiles
    .filter((href) => !seenFilenames.has(monthlyFilenameFromHref(href)))
    .map((href) => {
      const filename = monthlyFilenameFromHref(href);
      return {
        filename,
        url: `${CH_DOWNLOAD_BASE}/${href}`,
        period: extractPeriodFromFilename(filename),
        source: "archive",
        processed: isProcessed(filename),
      };
    });

  return selectRecentMonthlyFiles([...current, ...archive], limit);
}

export async function getMonthlyZipURLs() {
  if (Date.now() - monthlyCache.fetched < 3600000 && monthlyCache.files.length > 0) {
    return refreshProcessedFlags(monthlyCache.files);
  }

  const currentFiles = await scrapeAvailableZips(
    `${CH_DOWNLOAD_BASE}/en_monthlyaccountsdata.html`,
    "Accounts_Monthly_Data-[^\"]+\\.zip"
  );

  const archiveFiles = await scrapeAvailableZips(
    `${CH_DOWNLOAD_BASE}/historicmonthlyaccountsdata.html`,
    "(?:archive/)?Accounts_Monthly_Data-[^\"]+\\.zip"
  );

  const recentFiles = buildMonthlyZipFileList(currentFiles, archiveFiles);

  monthlyCache = { files: recentFiles, fetched: Date.now() };
  return recentFiles;
}

function extractPeriodFromFilename(filename) {
  const monthNames = {
    January: "01", February: "02", March: "03", April: "04",
    May: "05", June: "06", July: "07", August: "08",
    September: "09", October: "10", November: "11", December: "12",
  };
  for (const [name, num] of Object.entries(monthNames)) {
    const match = filename.match(new RegExp(`${name}(\\d{4})`));
    if (match) return `${match[1]}-${num}`;
  }
  const rangeMatch = filename.match(/(\d{4})\.zip/);
  if (rangeMatch) return `${rangeMatch[1]}-12`;
  return "unknown";
}

// --- Daily ZIP URLs ---

let dailyCache = { files: [], fetched: 0 };

export async function getDailyZipURLs() {
  if (Date.now() - dailyCache.fetched < 3600000 && dailyCache.files.length > 0) {
    return refreshProcessedFlags(dailyCache.files);
  }

  const files = await scrapeAvailableZips(
    `${CH_DOWNLOAD_BASE}/en_accountsdata.html`,
    "Accounts_Bulk_Data-[^\"]+\\.zip"
  );

  const result = files.map((f) => {
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
    const dateStr = dateMatch ? dateMatch[1] : "unknown";
    const d = new Date(dateStr + "T00:00:00");
    const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] || "";
    return {
      filename: f,
      url: `${CH_DOWNLOAD_BASE}/${f}`,
      date: dateStr,
      day_name: dayName,
      processed: isZipProcessed(f),
    };
  });

  result.sort((a, b) => b.date.localeCompare(a.date));
  dailyCache = { files: result, fetched: Date.now() };
  return result;
}

// --- Download a ZIP file ---

async function downloadZip(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const fileStream = createWriteStream(destPath);
  await pipeline(res.body, fileStream);
  return destPath;
}

// --- Process a ZIP file ---

export async function processAccountsZip(zipUrl, filename, onProgress) {
  ensureDataDir();

  if (isZipProcessed(filename)) {
    return { skipped: true, reason: "Already processed" };
  }

  const zipPath = path.join(DATA_DIR, filename);
  let qualifyingCompanies = 0;
  let belowThreshold = 0;
  let parseErrors = 0;
  const companies = [];

  try {
    if (onProgress) onProgress({ stage: "downloading", filename });

    try {
      await downloadZip(zipUrl, zipPath);
    } catch (dlErr) {
      return {
        error: true,
        stage: "download",
        message: dlErr.message,
        note: "Monthly/daily ZIP files may not be available for all periods. Check https://download.companieshouse.gov.uk",
      };
    }

    if (onProgress) onProgress({ stage: "extracting", filename });

    let AdmZip;
    try {
      AdmZip = (await import("adm-zip")).default;
    } catch {
      markZipProcessed(filename, { error: "adm-zip not installed" });
      return {
        error: true,
        stage: "dependency",
        message: "adm-zip package not installed. Run: npm install adm-zip",
      };
    }

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const totalFiles = entries.length;

    if (onProgress) onProgress({ stage: "processing", filename, totalFiles });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isDirectory) continue;

      const name = entry.entryName;
      const companyNumber = extractCompanyNumberFromFilename(name);
      if (!companyNumber) continue;

      try {
        const content = entry.getData().toString("utf-8");
        const turnover = extractTurnoverFromContent(content);

        if (turnover === null) {
          parseErrors++;
          continue;
        }

        if (!isTurnoverInEligibleRange(turnover)) {
          belowThreshold++;
          continue;
        }

        qualifyingCompanies++;
        companies.push({
          company_number: companyNumber,
          turnover,
          source_file: name,
        });
      } catch {
        parseErrors++;
      }

      if (i % 500 === 0 && onProgress) {
        onProgress({ stage: "processing", filename, processed: i, totalFiles, qualifying: qualifyingCompanies });
      }
    }

    // Clean up the ZIP after processing
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

    const stats = {
      total_files: totalFiles,
      qualifying: qualifyingCompanies,
      below_threshold: belowThreshold,
      parse_errors: parseErrors,
    };

    markZipProcessed(filename, stats);

    return { success: true, filename, stats, companies };
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    return { error: true, stage: "processing", message: err.message };
  }
}

// --- Auto-pull schedule state ---

let autoPullInterval = null;
let autoPullStatus = { enabled: false, last_run: null, next_run: null, last_result: null };

export function getAutoPullStatus() {
  return { ...autoPullStatus };
}

export function startAutoPull(intervalMs, processCallback) {
  if (autoPullInterval) clearInterval(autoPullInterval);

  autoPullStatus.enabled = true;
  autoPullStatus.next_run = new Date(Date.now() + intervalMs).toISOString();

  autoPullInterval = setInterval(async () => {
    autoPullStatus.last_run = new Date().toISOString();
    try {
      const dailyZips = getDailyZipURLs(7);
      const unprocessed = dailyZips.filter((z) => !z.processed);

      if (unprocessed.length === 0) {
        autoPullStatus.last_result = { message: "No new files to process", checked_at: new Date().toISOString() };
      } else {
        const results = [];
        for (const zip of unprocessed) {
          const result = await processAccountsZip(zip.url, zip.filename);
          results.push({ filename: zip.filename, ...result });
          if (processCallback && result.success) {
            await processCallback(result.companies);
          }
        }
        autoPullStatus.last_result = {
          files_checked: unprocessed.length,
          results,
          checked_at: new Date().toISOString(),
        };
      }
    } catch (err) {
      autoPullStatus.last_result = { error: err.message, checked_at: new Date().toISOString() };
    }

    autoPullStatus.next_run = new Date(Date.now() + intervalMs).toISOString();
  }, intervalMs);

  return autoPullStatus;
}

export function stopAutoPull() {
  if (autoPullInterval) {
    clearInterval(autoPullInterval);
    autoPullInterval = null;
  }
  autoPullStatus.enabled = false;
  autoPullStatus.next_run = null;
  return autoPullStatus;
}
