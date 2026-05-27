import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { upsertFiling, upsertMonitoredCompany, getMonitoredCompany } from "./db.js";
import { markZipProcessed } from "./processed-zips.js";

const TURNOVER_THRESHOLD = 15_000_000;
const DATA_DIR = path.join(process.cwd(), "mock-backend", "data");
const ADMZIP_MAX_BYTES = (2 * 1024 * 1024 * 1024) - 1;
const execFileAsync = promisify(execFile);

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

function canUseSystemUnzip() {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listFilesRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const out = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        out.push(fullPath);
      }
    }
  }

  return out;
}

function processFilingContent(name, content, source, state) {
  const companyNumber = extractCompanyNumberFromFilename(name);
  if (!companyNumber) return;

  state.processed++;

  try {
    const turnover = extractTurnoverFromContent(content);

    if (turnover === null) {
      state.noTurnoverData++;
      return;
    }

    const bsDate = extractBalanceSheetDate(name);

    if (turnover < TURNOVER_THRESHOLD) {
      state.belowThreshold++;
      return;
    }

    state.qualifying++;

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
    upsertMonitoredCompany({
      company_number: companyNumber,
      company_name: companyName || existing?.company_name || `Company ${companyNumber}`,
      latest_turnover: turnover,
      status: "active",
      source,
    });

    state.qualifyingCompanies.push({ company_number: companyNumber, turnover, balance_sheet_date: bsDate });
  } catch {
    state.parseErrors++;
  }
}

async function processAccountsZipWithSystemUnzip(zipPath, source, onProgress) {
  let AdmZip;
  try {
    AdmZip = (await import("adm-zip")).default;
  } catch {
    throw new Error("adm-zip not installed. Run: npm install adm-zip");
  }

  const { stdout: entryListRaw } = await execFileAsync("unzip", ["-Z1", zipPath], {
    encoding: "utf-8",
    maxBuffer: 128 * 1024 * 1024,
  });

  const entryNames = entryListRaw.split(/\r?\n/).filter(Boolean);
  const state = {
    processed: 0,
    qualifying: 0,
    belowThreshold: 0,
    noTurnoverData: 0,
    parseErrors: 0,
    qualifyingCompanies: [],
  };

  const tempDir = path.join(DATA_DIR, `nested-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    try {
      await execFileAsync("unzip", ["-qq", "-o", zipPath, "*.zip", "-d", tempDir], {
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      // No nested zips matched, or unzip reported a non-fatal warning. Continue.
    }

    const nestedZipPaths = listFilesRecursive(tempDir).filter((f) => /\.zip$/i.test(f));

    for (let i = 0; i < nestedZipPaths.length; i++) {
      const nestedPath = nestedZipPaths[i];
      try {
        const nested = new AdmZip(nestedPath);
        const nestedEntries = nested.getEntries();

        for (const nestedEntry of nestedEntries) {
          if (nestedEntry.isDirectory) continue;
          const nestedName = nestedEntry.entryName;
          const nestedContent = nestedEntry.getData().toString("utf-8");
          processFilingContent(nestedName, nestedContent, source, state);
        }
      } catch {
        state.parseErrors++;
      }

      if (i % 5 === 0 && onProgress) {
        onProgress({
          stage: "processing_nested",
          processed: state.processed,
          totalFiles: entryNames.length,
          qualifying: state.qualifying,
          belowThreshold: state.belowThreshold,
          noTurnoverData: state.noTurnoverData,
          parseErrors: state.parseErrors,
        });
      }
    }

    // For huge CH monthly files, the useful data is usually inside nested ZIP members.
    // Skipping outer non-zip entries avoids loading very large top-level files into memory.
    if (nestedZipPaths.length === 0) {
      for (let i = 0; i < entryNames.length; i++) {
        const name = entryNames[i];
        if (name.endsWith("/")) continue;

        try {
          if (!/\.zip$/i.test(name)) {
            const { stdout: content } = await execFileAsync("unzip", ["-p", zipPath, name], {
              encoding: "utf-8",
              maxBuffer: 128 * 1024 * 1024,
            });
            processFilingContent(name, content, source, state);
          }
        } catch {
          state.parseErrors++;
        }

        if (i % 200 === 0 && onProgress) {
          onProgress({
            processed: state.processed,
            totalFiles: entryNames.length,
            qualifying: state.qualifying,
            belowThreshold: state.belowThreshold,
            noTurnoverData: state.noTurnoverData,
            parseErrors: state.parseErrors,
            percent: Math.round((i / Math.max(entryNames.length, 1)) * 100),
          });
        }
      }
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }

  return {
    total_files: entryNames.length,
    processed: state.processed,
    qualifying: state.qualifying,
    below_threshold: state.belowThreshold,
    no_turnover_data: state.noTurnoverData,
    parse_errors: state.parseErrors,
    companies: state.qualifyingCompanies,
  };
}

// --- Process a ZIP file in streaming chunks ---

export async function processAccountsZip(zipPath, source, onProgress) {
  const stats = fs.statSync(zipPath);
  if (stats.size > ADMZIP_MAX_BYTES) {
    if (!canUseSystemUnzip()) {
      const err = new Error(`File size (${stats.size}) is greater than 2 GiB and system unzip is unavailable`);
      err.code = "ZIP_TOO_LARGE";
      err.zipSize = stats.size;
      err.maxSize = ADMZIP_MAX_BYTES;
      throw err;
    }
    return processAccountsZipWithSystemUnzip(zipPath, source, onProgress);
  }

  let AdmZip;
  try {
    AdmZip = (await import("adm-zip")).default;
  } catch {
    throw new Error("adm-zip not installed. Run: npm install adm-zip");
  }

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const totalFiles = entries.length;

  const state = {
    processed: 0,
    qualifying: 0,
    belowThreshold: 0,
    noTurnoverData: 0,
    parseErrors: 0,
    qualifyingCompanies: [],
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isDirectory) continue;

    const name = entry.entryName;
    try {
      if (/\.zip$/i.test(name)) {
        const nested = new AdmZip(entry.getData());
        const nestedEntries = nested.getEntries();
        for (const nestedEntry of nestedEntries) {
          if (nestedEntry.isDirectory) continue;
          const nestedName = nestedEntry.entryName;
          const nestedContent = nestedEntry.getData().toString("utf-8");
          processFilingContent(nestedName, nestedContent, source, state);
        }
      } else {
        const content = entry.getData().toString("utf-8");
        processFilingContent(name, content, source, state);
      }
    } catch {
      state.parseErrors++;
    }

    if (i % 500 === 0 && onProgress) {
      onProgress({
        processed: state.processed,
        totalFiles,
        qualifying: state.qualifying,
        belowThreshold: state.belowThreshold,
        noTurnoverData: state.noTurnoverData,
        parseErrors: state.parseErrors,
        percent: Math.round((i / Math.max(totalFiles, 1)) * 100),
      });
    }
  }

  return {
    total_files: totalFiles,
    processed: state.processed,
    qualifying: state.qualifying,
    below_threshold: state.belowThreshold,
    no_turnover_data: state.noTurnoverData,
    parse_errors: state.parseErrors,
    companies: state.qualifyingCompanies,
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

    if (err.code === "ZIP_TOO_LARGE") {
      markZipProcessed(filename, {
        skipped: true,
        reason: "zip_too_large_for_adm_zip",
        size_bytes: err.zipSize,
        max_supported_bytes: err.maxSize,
        source,
      });

      const result = {
        total_files: 0,
        processed: 0,
        qualifying: 0,
        below_threshold: 0,
        no_turnover_data: 0,
        parse_errors: 0,
        companies: [],
        skipped_file: true,
        skipped_reason: err.message,
      };

      if (onComplete) onComplete(result);
      return result;
    }

    if (onError) onError(err);
    throw err;
  }
}
