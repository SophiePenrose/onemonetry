import {
  enqueueAnalysisQueueItem,
  enqueueAnalysisQueueItems,
  claimAnalysisQueueItem,
  claimNextAnalysisQueueItem,
  markAnalysisQueueItemReady,
  markAnalysisQueueItemFailed,
  resetProcessingAnalysisQueueItems,
  getAnalysisQueueCounts,
  getMonitoredCompany,
  getSetting,
  setSetting,
} from "./db.js";
import { analyseCompany } from "./llm.js";
import { scoreCompany, integrateAnalysis } from "./scoring-engine.js";

function parseBoundedPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const DEFAULT_INTERVAL_MS = parseBoundedPositiveInt(
  process.env.ANALYSIS_QUEUE_INTERVAL_MS,
  15000,
  1000,
  600000
);
const DEFAULT_BATCH_SIZE = parseBoundedPositiveInt(
  process.env.ANALYSIS_QUEUE_BATCH_SIZE,
  2,
  1,
  25
);

let queueTimer = null;
let processing = false;
let lastRunAt = null;
let lastError = null;

function normalizeCompanyNumber(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (str.startsWith("ch-")) {
    return str.slice(3);
  }
  if (/^\d{1,8}$/.test(str)) {
    return str.padStart(8, "0");
  }
  return str;
}

function normalizeCompanyRow(item) {
  if (!item) return null;
  if (typeof item === "string") {
    const company_number = normalizeCompanyNumber(item);
    if (!company_number) return null;
    return { company_number, company_name: null };
  }

  const company_number = normalizeCompanyNumber(item.company_number || item.companyNumber || item.id || null);
  if (!company_number) return null;

  return {
    company_number,
    company_name: item.company_name || item.companyName || item.name || null,
  };
}

export function enqueueCompanyForAnalysis(item, source = "import") {
  const normalized = normalizeCompanyRow(item);
  if (!normalized) return { queued: false, company_number: null };

  enqueueAnalysisQueueItem(normalized.company_number, normalized.company_name, source);
  return { queued: true, company_number: normalized.company_number };
}

export function enqueueCompaniesForAnalysis(items, source = "import") {
  if (!Array.isArray(items) || items.length === 0) {
    return { queued: 0 };
  }

  const normalized = items
    .map((item) => normalizeCompanyRow(item))
    .filter(Boolean);

  const queued = enqueueAnalysisQueueItems(normalized, source);
  return { queued };
}

async function processClaimedQueueItem(next) {
  const companyNumber = next.company_number;

  try {
    const monitored = getMonitoredCompany(companyNumber);
    const knownAnalysis = getSetting(`analysis_${companyNumber}`, null);

    const companyName = monitored?.company_name
      || next.company_name
      || knownAnalysis?.company_name
      || `Company ${companyNumber}`;

    const turnover = monitored?.latest_turnover || null;
    const analysis = await analyseCompany(companyNumber, companyName, turnover);

    setSetting(`analysis_${companyNumber}`, analysis);

    const baseScore = scoreCompany(companyNumber);
    if (baseScore) {
      integrateAnalysis(baseScore, analysis);
    }

    markAnalysisQueueItemReady(companyNumber, companyName);
    return { company_number: companyNumber, status: "ready" };
  } catch (err) {
    markAnalysisQueueItemFailed(companyNumber, err.message);
    return { company_number: companyNumber, status: "failed", error: err.message };
  }
}

export async function processAnalysisQueueBatch(options = {}) {
  if (processing) {
    return { skipped: true, reason: "already_running" };
  }

  const batchSize = parseBoundedPositiveInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 25);
  const processed = [];
  let failed = 0;

  processing = true;
  lastError = null;

  try {
    for (let i = 0; i < batchSize; i++) {
      const next = claimNextAnalysisQueueItem();
      if (!next) break;

      const itemResult = await processClaimedQueueItem(next);
      if (itemResult.status === "failed") {
        failed++;
      }
      processed.push(itemResult);
    }
  } finally {
    processing = false;
    lastRunAt = new Date().toISOString();
  }

  return {
    processed: processed.length,
    failed,
    items: processed,
    counts: getAnalysisQueueCounts(),
  };
}

export async function processAnalysisQueueItem(companyNumber) {
  if (processing) {
    return { skipped: true, reason: "already_running", processed: 0, failed: 0, items: [], counts: getAnalysisQueueCounts() };
  }

  const normalized = normalizeCompanyNumber(companyNumber);
  if (!normalized) {
    return { skipped: true, reason: "invalid_company_number", processed: 0, failed: 0, items: [], counts: getAnalysisQueueCounts() };
  }

  const processed = [];
  let failed = 0;

  processing = true;
  lastError = null;

  try {
    const next = claimAnalysisQueueItem(normalized);
    if (!next) {
      return {
        skipped: true,
        reason: "not_queued",
        company_number: normalized,
        processed: 0,
        failed: 0,
        items: [],
        counts: getAnalysisQueueCounts(),
      };
    }

    const itemResult = await processClaimedQueueItem(next);
    if (itemResult.status === "failed") {
      failed++;
    }
    processed.push(itemResult);
  } finally {
    processing = false;
    lastRunAt = new Date().toISOString();
  }

  return {
    company_number: normalized,
    processed: processed.length,
    failed,
    items: processed,
    counts: getAnalysisQueueCounts(),
  };
}

export function startAnalysisQueueWorker(options = {}) {
  const intervalMs = parseBoundedPositiveInt(options.intervalMs, DEFAULT_INTERVAL_MS, 1000, 600000);
  const batchSize = parseBoundedPositiveInt(options.batchSize, DEFAULT_BATCH_SIZE, 1, 25);

  if (queueTimer) clearInterval(queueTimer);

  const recovered = resetProcessingAnalysisQueueItems();

  queueTimer = setInterval(() => {
    processAnalysisQueueBatch({ batchSize }).catch((err) => {
      lastError = err.message;
    });
  }, intervalMs);

  setTimeout(() => {
    processAnalysisQueueBatch({ batchSize }).catch((err) => {
      lastError = err.message;
    });
  }, 1000);

  return {
    enabled: true,
    interval_ms: intervalMs,
    batch_size: batchSize,
    recovered_processing_items: recovered,
    counts: getAnalysisQueueCounts(),
  };
}

export function stopAnalysisQueueWorker() {
  if (queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }

  return {
    enabled: false,
    counts: getAnalysisQueueCounts(),
  };
}

export function getAnalysisQueueWorkerStatus() {
  return {
    enabled: !!queueTimer,
    processing,
    last_run_at: lastRunAt,
    last_error: lastError,
    counts: getAnalysisQueueCounts(),
  };
}
