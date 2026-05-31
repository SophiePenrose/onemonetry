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
import { runCompanyTechEnrichment } from "./tech-enrichment.js";
import { isCompaniesHouseConfigured, lookupCompanyOwnership } from "./companies-house.js";
import { syncExternalSignals } from "./signal-connectors.js";

function parseBoundedPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseOptionalBoundedPositiveInt(value, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  const token = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(token)) return true;
  if (["false", "0", "no", "n", "off"].includes(token)) return false;
  return null;
}

function parseOptionalDeepScanMode(value) {
  if (value === undefined || value === null) return null;
  const token = String(value).trim().toLowerCase();
  if (["off", "false", "0"].includes(token)) return "off";
  if (["always", "on", "true", "1"].includes(token)) return "always";
  if (token === "auto") return "auto";
  return null;
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
const DEFAULT_ENRICHMENT_DEEP_SCAN = parseOptionalBoolean(process.env.ANALYSIS_QUEUE_ENRICHMENT_DEEP_SCAN);
const DEFAULT_ENRICHMENT_DEEP_SCAN_MODE = parseOptionalDeepScanMode(process.env.ANALYSIS_QUEUE_ENRICHMENT_DEEP_SCAN_MODE);
const DEFAULT_ENRICHMENT_MAX_PAGES = parseOptionalBoundedPositiveInt(process.env.ANALYSIS_QUEUE_ENRICHMENT_MAX_PAGES, 1, 12);
const DEFAULT_ENRICHMENT_REFRESH_WINDOW_DAYS = parseOptionalBoundedPositiveInt(process.env.ANALYSIS_QUEUE_ENRICHMENT_REFRESH_DAYS, 1, 365);
const DEFAULT_ENRICHMENT_TIMEOUT_MS = parseOptionalBoundedPositiveInt(process.env.ANALYSIS_QUEUE_ENRICHMENT_TIMEOUT_MS, 1000, 20000);
const DEFAULT_EXTERNAL_SIGNAL_SYNC = parseOptionalBoolean(process.env.ANALYSIS_QUEUE_EXTERNAL_SIGNAL_SYNC) ?? false;

let queueTimer = null;
let processing = false;
let lastRunAt = null;
let lastError = null;

function getEnrichmentWorkerConfig() {
  return {
    deep_scan_override: DEFAULT_ENRICHMENT_DEEP_SCAN,
    deep_scan_mode: DEFAULT_ENRICHMENT_DEEP_SCAN_MODE,
    max_pages: DEFAULT_ENRICHMENT_MAX_PAGES,
    refresh_window_days: DEFAULT_ENRICHMENT_REFRESH_WINDOW_DAYS,
    timeout_ms: DEFAULT_ENRICHMENT_TIMEOUT_MS,
    external_signal_sync: DEFAULT_EXTERNAL_SIGNAL_SYNC,
  };
}

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
    let enrichmentResult = null;
    let ownershipResult = null;
    let externalSignalSyncResult = null;

    try {
      const enrichmentInput = {
        companyNumber,
        companyName,
        turnover,
      };

      if (DEFAULT_ENRICHMENT_DEEP_SCAN !== null) {
        enrichmentInput.deepScan = DEFAULT_ENRICHMENT_DEEP_SCAN;
      }
      if (DEFAULT_ENRICHMENT_DEEP_SCAN_MODE) {
        enrichmentInput.deepScanMode = DEFAULT_ENRICHMENT_DEEP_SCAN_MODE;
      }
      if (DEFAULT_ENRICHMENT_MAX_PAGES !== null) {
        enrichmentInput.maxPages = DEFAULT_ENRICHMENT_MAX_PAGES;
      }
      if (DEFAULT_ENRICHMENT_REFRESH_WINDOW_DAYS !== null) {
        enrichmentInput.refreshWindowDays = DEFAULT_ENRICHMENT_REFRESH_WINDOW_DAYS;
      }
      if (DEFAULT_ENRICHMENT_TIMEOUT_MS !== null) {
        enrichmentInput.timeoutMs = DEFAULT_ENRICHMENT_TIMEOUT_MS;
      }

      enrichmentResult = await runCompanyTechEnrichment(enrichmentInput);
    } catch (err) {
      enrichmentResult = {
        status: "error",
        updated: false,
        error: err?.message || "enrichment_failed",
      };
    }

    if (isCompaniesHouseConfigured()) {
      try {
        const ownershipLookup = await lookupCompanyOwnership(companyNumber);
        if (!ownershipLookup?.error && ownershipLookup?.summary) {
          setSetting(`ownership_${companyNumber}`, {
            ...ownershipLookup.summary,
            source: "companies_house_api",
          });
          ownershipResult = {
            status: "updated",
            non_uk_significant_corporate_controllers_count:
              Number(ownershipLookup.summary.non_uk_significant_corporate_controllers_count || 0),
            significant_corporate_controllers_count:
              Number(ownershipLookup.summary.significant_corporate_controllers_count || 0),
          };
        } else {
          ownershipResult = {
            status: "error",
            error: ownershipLookup?.message || "ownership_lookup_failed",
          };
        }
      } catch (err) {
        ownershipResult = {
          status: "error",
          error: err?.message || "ownership_lookup_failed",
        };
      }
    }

    if (DEFAULT_EXTERNAL_SIGNAL_SYNC) {
      try {
        externalSignalSyncResult = await syncExternalSignals({
          companyNumber,
          companyName,
          companyDomain: knownAnalysis?.company_domain || monitored?.company_domain || null,
        });
      } catch (err) {
        externalSignalSyncResult = {
          status: "error",
          updated: false,
          error: err?.message || "external_signal_sync_failed",
        };
      }
    }

    const analysis = await analyseCompany(companyNumber, companyName, turnover);

    setSetting(`analysis_${companyNumber}`, analysis);

    const baseScore = scoreCompany(companyNumber);
    if (baseScore) {
      integrateAnalysis(baseScore, analysis);
    }

    markAnalysisQueueItemReady(companyNumber, companyName);
    return {
      company_number: companyNumber,
      status: "ready",
      enrichment_status: enrichmentResult?.status || null,
      enrichment_updated: enrichmentResult?.updated === true,
      enrichment_scan_mode: enrichmentResult?.scan_mode || null,
      enrichment_deep_scan_mode: enrichmentResult?.deep_scan_mode || null,
      ownership_status: ownershipResult?.status || "skipped",
      ownership_non_uk_significant_corporate_count:
        ownershipResult?.non_uk_significant_corporate_controllers_count ?? null,
      external_signal_sync_status: externalSignalSyncResult?.status || "skipped",
      external_signal_sync_updated: externalSignalSyncResult?.updated === true,
    };
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
    enrichment: getEnrichmentWorkerConfig(),
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
    enrichment: getEnrichmentWorkerConfig(),
  };
}
