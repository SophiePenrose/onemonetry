import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
// bulk-processor.js

const CH_DOWNLOAD_BASE = "https://download.companieshouse.gov.uk";
const TURNOVER_THRESHOLD = 20_000_000;
const DATA_DIR = path.join(process.cwd(), "mock-backend", "data");
const PROCESSED_FILE = path.join(DATA_DIR, "processed_zips.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadProcessedZips() {
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveProcessedZips(data) {
  ensureDataDir();
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
}

function markZipProcessed(filename, stats) {
  const processed = loadProcessedZips();
  processed[filename] = { processed_at: new Date().toISOString(), ...stats };
  saveProcessedZips(processed);
}

function isZipProcessed(filename) {
  const processed = loadProcessedZips();
  return !!processed[filename];
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

// --- Monthly ZIP URLs ---

export function getMonthlyZipURLs(monthsBack = 24) {
  const urls = [];
  const now = new Date();
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const filename = `Accounts_Monthly_Data-${year}-${month}.zip`;
    urls.push({
      filename,
      url: `${CH_DOWNLOAD_BASE}/${filename}`,
      period: `${year}-${month}`,
      processed: isZipProcessed(filename),
    });
  }
  return urls;
}

// --- Daily ZIP URLs ---

export function getDailyZipURLs(daysBack = 14) {
  const urls = [];
  const now = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const day = d.getDay();
    if (day === 0) continue; // no Sunday files
    const dateStr = d.toISOString().slice(0, 10);
    const filename = `Accounts_Bulk_Data-${dateStr}.zip`;
    urls.push({
      filename,
      url: `${CH_DOWNLOAD_BASE}/${filename}`,
      date: dateStr,
      day_name: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day],
      processed: isZipProcessed(filename),
    });
  }
  return urls;
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

        if (turnover < TURNOVER_THRESHOLD) {
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
