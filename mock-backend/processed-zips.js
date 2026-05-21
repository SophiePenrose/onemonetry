import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getDataDir() {
  return process.env.PROCESSED_ZIPS_DATA_DIR || path.join(__dirname, "data");
}

function getProcessedFilePath() {
  return path.join(getDataDir(), "processed_zips.json");
}

export function ensureDataDir() {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

export function hasProcessedZipStore() {
  return fs.existsSync(getProcessedFilePath());
}

export function loadProcessedZips() {
  try {
    return JSON.parse(fs.readFileSync(getProcessedFilePath(), "utf-8"));
  } catch {
    return {};
  }
}

export function saveProcessedZips(data) {
  ensureDataDir();
  fs.writeFileSync(getProcessedFilePath(), JSON.stringify(data, null, 2));
}

export function markZipProcessed(filename, stats = {}) {
  const processed = loadProcessedZips();
  processed[filename] = { processed_at: new Date().toISOString(), ...stats };
  saveProcessedZips(processed);
}

export function markZipsProcessed(filenames, stats = {}) {
  const processed = loadProcessedZips();
  const processedAt = new Date().toISOString();
  for (const filename of filenames) {
    processed[filename] = { processed_at: processedAt, ...stats };
  }
  saveProcessedZips(processed);
}

export function isZipProcessed(filename) {
  return !!loadProcessedZips()[filename];
}
