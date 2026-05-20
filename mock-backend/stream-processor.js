import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { upsertFiling, upsertMonitoredCompany, getMonitoredCompany } from "./db.js";

const TURNOVER_THRESHOLD = 15_000_000;
const DATA_DIR = path.join(process.cwd(), "mock-backend", "data");
const CHUNK_SIZE = 50;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function getTurnoverThreshold() {
  return TURNOVER_THRESHOLD;
}

// --- Turnover extraction from iXBRL/XBRL content ---

export function extractTurnoverFromContent(content) {
  const patterns = [
    /<ix:nonFraction[^>]*name="[^"]*(?:Turnover|Revenue|TotalRevenue|NetRevenue|GrossRevenue)[^"]*"[^>]*?>([\d,.\s]+)<\/ix:nonFraction>/gi,
    /<[^>]*name="[^"]*(?:uk-gaap:Turnover|frs-102:TurnoverRevenue|frs-101:Revenue|core:Turnover|ifrs-full:Revenue)[^"]*"[^>]*>([\d,.\s]+)</gi,
    /<[^>]*name="[^"]*Turnover[^"]*"[^>]*>([\d,.\s]+)</gi,
    /<[^>]*name="[^"]*Revenue[^"]*"[^>]*>([\d,.\s]+)</gi,
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

export function extractCompanyNumberFromFilename(filename) {
  const match = filename.match(/Prod\d+_\d+_(\d{8})_/);
  return match ? match[1] : null;
}

export function extractBalanceSheetDate(filename) {
  const match = filename.match(/_(\d{8})(?:\.|$)/);
  if (!match) return null;
  const d = match[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// --- Download with progress and timeout ---

export async function downloadFile(url, destPath, onProgress) {
  ensureDataDir();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const totalSize = parseInt(res.headers.get("content-length") || "0");
  let downloaded = 0;

  const fileStream = createWriteStream(destPath);
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      downloaded += value.length;
      if (onProgress && totalSize > 0) {
        onProgress({ downloaded, totalSize, percent: Math.round((downloaded / totalSize) * 100) });
      }
    }
  } finally {
    fileStream.end();
    await new Promise((resolve) => fileStream.on("finish", resolve));
  }

  return { path: destPath, size: downloaded };
}

// --- Process a ZIP file in streaming chunks ---

export async function processAccountsZip(zipPath, source, onProgress) {
  let AdmZip;
  try {
    AdmZip = (await import("adm-zip")).default;
  } catch {
    throw new Error("adm-zip not installed. Run: npm install adm-zip");
  }

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const totalFiles = entries.length;

  let processed = 0;
  let qualifying = 0;
  let belowThreshold = 0;
  let parseErrors = 0;
  const qualifyingCompanies = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isDirectory) continue;

    const name = entry.entryName;
    const companyNumber = extractCompanyNumberFromFilename(name);
    if (!companyNumber) continue;

    processed++;

    try {
      const content = entry.getData().toString("utf-8");
      const turnover = extractTurnoverFromContent(content);

      if (turnover === null) {
        parseErrors++;
        continue;
      }

      const bsDate = extractBalanceSheetDate(name);

      if (turnover < TURNOVER_THRESHOLD) {
        belowThreshold++;
        continue;
      }

      qualifying++;

      upsertFiling({
        company_number: companyNumber,
        filing_date: bsDate,
        description: `Accounts filed (turnover £${(turnover / 1e6).toFixed(1)}M)`,
        filing_type: "accounts",
        barcode: name.replace(/\.[^.]+$/, ""),
        turnover,
        balance_sheet_date: bsDate,
        source,
        source_file: name,
        raw_data: content.length > 50000 ? null : content,
      });

      const existing = getMonitoredCompany(companyNumber);
      const prevTurnover = existing?.latest_turnover || null;
      upsertMonitoredCompany({
        company_number: companyNumber,
        company_name: existing?.company_name || `Company ${companyNumber}`,
        latest_turnover: turnover,
        status: "active",
        source,
      });

      if (prevTurnover && prevTurnover >= TURNOVER_THRESHOLD && turnover < TURNOVER_THRESHOLD) {
        // Will be handled by the flag below
      }

      qualifyingCompanies.push({ company_number: companyNumber, turnover, balance_sheet_date: bsDate });
    } catch {
      parseErrors++;
    }

    if (i % 500 === 0 && onProgress) {
      onProgress({ processed, totalFiles, qualifying, belowThreshold, parseErrors, percent: Math.round((i / totalFiles) * 100) });
    }
  }

  return {
    total_files: totalFiles,
    processed,
    qualifying,
    below_threshold: belowThreshold,
    parse_errors: parseErrors,
    companies: qualifyingCompanies,
  };
}

// --- Process in batches to manage memory ---

export async function processZipInChunks(url, filename, source, callbacks) {
  const { onDownloadProgress, onProcessProgress, onComplete, onError } = callbacks;

  ensureDataDir();
  const zipPath = path.join(DATA_DIR, filename);

  try {
    if (onDownloadProgress) onDownloadProgress({ stage: "downloading", filename });
    await downloadFile(url, zipPath, onDownloadProgress);

    if (onProcessProgress) onProcessProgress({ stage: "processing", filename });
    const result = await processAccountsZip(zipPath, source, onProcessProgress);

    try { fs.unlinkSync(zipPath); } catch { /* cleanup */ }

    if (onComplete) onComplete(result);
    return result;
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch { /* cleanup */ }
    if (onError) onError(err);
    throw err;
  }
}
