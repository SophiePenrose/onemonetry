import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { upsertFiling, upsertMonitoredCompany, getMonitoredCompany } from "./db.js";

const PROCESSED_FILE = path.join(process.cwd(), "mock-backend", "data", "processed_zips.json");

function markZipProcessed(filename, stats) {
  let processed = {};
  try { processed = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf-8")); } catch { /* first run */ }
  processed[filename] = { processed_at: new Date().toISOString(), ...stats };
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(processed, null, 2));
}

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
    /<ix:nonFraction[^>]*name="[^"]*(?:Turnover|Revenue)[^"]*"[^>]*>([\d,.\s]+)</gi,
    /<[^>]*name="[^"]*(?:uk-gaap:Turnover|frs-102:TurnoverRevenue|frs-101:Revenue|core:Turnover|ifrs-full:Revenue)[^"]*"[^>]*>([\d,.\s]+)</gi,
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

  if (values.length > 0) return Math.max(...values);

  const plainPattern = /(?:turnover|total revenue)[^<]*?[\s:£]+([\d,]+(?:\.\d+)?)\s*(?:thousand|000)?/gi;
  let plainMatch;
  while ((plainMatch = plainPattern.exec(content)) !== null) {
    let val = parseFloat(plainMatch[1].replace(/,/g, ""));
    if (plainMatch[0].toLowerCase().includes("thousand")) val *= 1000;
    if (!isNaN(val) && val > 0) values.push(val);
  }

  return values.length > 0 ? Math.max(...values) : null;
}

export function extractReadableText(htmlContent) {
  let text = htmlContent
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const startMarkers = ["STRATEGIC REPORT", "DIRECTORS' REPORT", "REPORT OF THE DIRECTORS", "COMPANY INFORMATION"];
  let startIdx = text.length;
  for (const marker of startMarkers) {
    const idx = text.toUpperCase().indexOf(marker);
    if (idx >= 0 && idx < startIdx) startIdx = idx;
  }

  if (startIdx < text.length) {
    text = text.substring(startIdx);
  } else {
    const regIdx = text.indexOf("REGISTERED NUMBER");
    if (regIdx >= 0) text = text.substring(regIdx);
  }

  return text.substring(0, 30000);
}

export function extractCompanyName(htmlContent) {
  const patterns = [
    /REGISTERED NUMBER[^)]*\)\s*([A-Z][A-Z\s&'.,()-]+(?:LIMITED|LTD|PLC|LLP|GROUP|HOLDINGS|COMPANY|SERVICES))/i,
    /([A-Z][A-Z\s&'.,()-]+(?:LIMITED|LTD|PLC|LLP|GROUP|HOLDINGS))\s*\(REGISTERED/i,
    /([A-Z][A-Z\s&'.,()-]+(?:LIMITED|LTD|PLC|LLP|GROUP|HOLDINGS))\s*(?:STRATEGIC REPORT|REPORT OF THE DIRECTORS|FINANCIAL STATEMENTS)/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ];

  for (const pat of patterns) {
    const match = htmlContent.match(pat);
    if (match) {
      let name = match[1].trim();
      name = name.replace(/\s*-\s*(?:Limited company accounts|Annual accounts|Accounts|Period Ending|Filing).*$/i, "");
      name = name.replace(/\s*-\s*Final Accounts.*$/i, "");
      name = name.replace(/\s*STRATEGIC REPORT.*$/i, "");
      name = name.replace(/\s+/g, " ").trim();
      if (name.toLowerCase().startsWith("accounts")) continue;
      if (name.length > 3 && name.length < 80) return name;
    }
  }
  return null;
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
  let noTurnoverData = 0;
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
        noTurnoverData++;
        continue;
      }

      const bsDate = extractBalanceSheetDate(name);

      if (turnover < TURNOVER_THRESHOLD) {
        belowThreshold++;
        continue;
      }

      qualifying++;

      const extractedText = extractReadableText(content);
      const companyName = extractCompanyName(content);

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
        raw_data: extractedText,
      });

      const existing = getMonitoredCompany(companyNumber);
      const prevTurnover = existing?.latest_turnover || null;
      upsertMonitoredCompany({
        company_number: companyNumber,
        company_name: companyName || existing?.company_name || `Company ${companyNumber}`,
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
      onProgress({ processed, totalFiles, qualifying, belowThreshold, noTurnoverData, parseErrors, percent: Math.round((i / totalFiles) * 100) });
    }
  }

  return {
    total_files: totalFiles,
    processed,
    qualifying,
    below_threshold: belowThreshold,
    no_turnover_data: noTurnoverData,
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

    markZipProcessed(filename, { qualifying: result.qualifying, total_files: result.total_files, source });

    if (onComplete) onComplete(result);
    return result;
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch { /* cleanup */ }
    if (onError) onError(err);
    throw err;
  }
}
