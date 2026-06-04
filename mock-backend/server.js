import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  getCompanyWorkflowState,
  setCompanyWorkflowState,
  saveReport as dbSaveReport,
  getReport as dbGetReport,
  getReportByWeek,
  listReports,
  getExclusions as dbGetExclusions,
  setExclusions as dbSetExclusions,
  getSetting,
  setSetting,
  createImportJob,
  updateImportJob,
  getImportJob,
  listImportJobs,
  addImportLogEntry,
  getImportLogs,
  recordEmailAudit,
  getEmailAuditLog,
  addSuppression,
  removeSuppression,
  listSuppressions,
  getSuppressionCount,
  isContactSuppressed,
} from "./db.js";
import {
  isCompaniesHouseConfigured,
  lookupCompany,
  lookupCompanyCharges,
  lookupCompanyOwnership,
  parseCompanyNumbersCSV,
  getBulkDownloadInfo,
  fetchLatestAccountsDocument,
} from "./companies-house.js";
import { getMonthlyZipURLs, getDailyZipURLs } from "./bulk-processor.js";
import { getDailyAutoPullPlan } from "./daily-autopull-planner.js";
import { getMonthlyAutoPullPlan } from "./monthly-autopull-planner.js";
import {
  getAutoPullStatus,
  startAutoPull,
  stopAutoPull,
} from "./daily-autopull.js";
import {
  enqueueCompanyForAnalysis,
  enqueueCompaniesForAnalysis,
  processAnalysisQueueBatch,
  processAnalysisQueueItem,
  startAnalysisQueueWorker,
  getAnalysisQueueWorkerStatus,
} from "./analysis-queue.js";
import { processZipInChunks, getTurnoverThreshold } from "./stream-processor.js";
import { scoreCompany, getStoredScore, batchScoreCompanies, scoreCompanyWithLLM, batchScoreWithLLM, integrateAnalysis } from "./scoring-engine.js";
import { generateSequence, getSequencesForCompany, getSequence, updateStepStatus, updateStepContent, markStepReviewed, deleteSequence, SEQUENCE_TEMPLATES, getSequenceTemplates, saveGeneratedSequence, purgePlaceholderSequencesForCompany, purgeBrokenSequencesForCompany, purgeBrokenSequences } from "./email-sequences.js";
import { generateFullSequence, getEmailLlmRuntimeInfo } from "./email-generator.js";
import { validateEmail, isCompanyExcluded } from "./email-qc.js";
import { detectTriggers, selectArchetype, ARCHETYPES } from "./email-archetypes.js";
import { exportSequenceForYAMM, exportMultipleSequencesForYAMM, generateCSV, generateGoogleSheetsJSON, pauseSequenceOnReply, resumeSequence } from "./yamm-export.js";
import { authMiddleware, isAuthConfigured, setupAuth, verifyPassword, createSession, destroySession } from "./auth.js";
import { scoreAllStakeholders, getOutreachReadiness, checkDuplicateContact, registerActiveContact, getActiveContactsForCompany } from "./stakeholder-scoring.js";
import { runMigrations } from "./migrations.js";
import {
  runWeeklyMonitorBatch,
  importMonitorListFromCSV,
  getWeeklyMonitorStatus,
  startWeeklyMonitor,
  stopWeeklyMonitor,
  isMonitorRunning,
  getMonitorProgress,
  runStaleFilingFortnightlyBatch,
  getStaleFilingMonitorStatus,
  startStaleFilingMonitor,
  stopStaleFilingMonitor,
  isStaleMonitorRunning,
  getStaleMonitorProgress,
  runOwnershipStaleBatch,
  getOwnershipStaleMonitorStatus,
  listOwnershipChangedCompanies,
  startOwnershipStaleMonitor,
  stopOwnershipStaleMonitor,
  isOwnershipStaleMonitorRunning,
  getOwnershipStaleMonitorProgress,
} from "./company-monitor.js";
import { UK_TIMEZONE, getNextWeeklyZonedRun } from "./timezone-schedule.js";
import {
  getMonitorStats,
  getMonitoredCompanies as dbGetMonitoredCompanies,
  getFilingsForCompany,
  getFilingCount,
  upsertFiling,
  getMonitoredCompanyCount,
  getShortlistCompanies,
  getShortlistCount,
  getMonitoredCompany,
  upsertMonitoredCompany,
  clearMonitoredCompanyWebsiteHints,
  getCompanyChargeSummary,
  upsertCompanyChargeSummary,
  updateMonitorCheck,
  getCadenceLog,
  addCadenceEntry,
  pruneHistoricMonthlyFilingsBefore,
  getAnalysisQueueItemsByCompanyNumbers,
  getAnalysisQueueCounts,
  reconcileAnalysisQueueWithStoredAnalyses,
  listFailedAnalysisQueueItems,
  upsertClosedWonCompanies,
  isClosedWonCompanyNumber,
  getClosedWonCompany,
  getClosedWonRegistryCount,
  listClosedWonCompanies,
  getWebsiteResolution,
} from "./db.js";
import { getSupplementaryContext } from "./supplementary-context.js";
import {
  runCompanyTechEnrichment,
  getCompanyEnrichmentSnapshot,
  getTechEnrichmentRuntimeConfig,
} from "./tech-enrichment.js";
import { syncExternalSignals } from "./signal-connectors.js";
import {
  resolveCompanyWebsite,
  getWebsiteResolverRuntimeConfig,
  setManualWebsiteResolution,
} from "./website-resolver.js";
import { LAYER_NAMES, DEFAULT_SEGMENT_WEIGHTS, DEFAULT_PROPENSITY_WEIGHT } from "./scoring-weights.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const configuredCompaniesPath = (process.env.COMPANIES_PATH || "").trim();
const COMPANIES_FILE = configuredCompaniesPath
  ? (path.isAbsolute(configuredCompaniesPath) ? configuredCompaniesPath : path.resolve(process.cwd(), configuredCompaniesPath))
  : path.join(__dirname, "companies.json");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(authMiddleware);
const parsedPort = Number.parseInt(process.env.PORT || "8000", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8000;
const IGNORE_RUNTIME_SIGTERM = ["1", "true", "yes", "on"].includes(
  String(process.env.IGNORE_RUNTIME_SIGTERM || "").trim().toLowerCase()
);
const LIGHTWEIGHT_RUNTIME = ["1", "true", "yes", "on"].includes(
  String(process.env.LIGHTWEIGHT_RUNTIME || "").trim().toLowerCase()
);
const DEFAULT_RUN_EXTERNAL_SIGNAL_SYNC = ["1", "true", "yes", "on"].includes(
  String(process.env.DEFAULT_RUN_EXTERNAL_SIGNAL_SYNC || "false").trim().toLowerCase()
);

if (IGNORE_RUNTIME_SIGTERM) {
  process.on("SIGTERM", () => {
    console.warn("[runtime] SIGTERM received but ignored (IGNORE_RUNTIME_SIGTERM=true)");
  });
}

const bulkRemainingState = {
  running: false,
  run_id: null,
  mode: "all",
  started_at: null,
  completed_at: null,
  total_files: 0,
  processed_files: 0,
  successful_files: 0,
  failed_files: 0,
  skipped_files: 0,
  current_file: null,
  last_error: null,
  total_records_processed: 0,
  total_qualifying_companies: 0,
  total_parse_errors: 0,
  total_no_turnover_data: 0,
  total_below_threshold: 0,
  retry_attempts: 0,
  recent_results: [],
};

// --- Authentication ---

app.get("/api/auth/status", (_req, res) => {
  res.json({ configured: isAuthConfigured(), needs_setup: !isAuthConfigured() });
});

app.post("/api/auth/setup", (req, res) => {
  if (isAuthConfigured()) {
    return res.status(400).json({ error: "Auth already configured. Use login instead." });
  }
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  setupAuth(password);
  const token = createSession(req.headers["user-agent"]);
  res.json({ success: true, token });
});

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });

  if (!verifyPassword(password)) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = createSession(req.headers["user-agent"]);
  res.json({ success: true, token });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.headers["x-auth-token"];
  if (token) destroySession(token);
  res.json({ success: true });
});

const VALID_MOTIONS = [
  "FX",
  "FX Forwards",
  "Cards",
  "Spend Management",
  "API Integrations",
  "Merchant Acquiring",
  "Revolut Pay",
  "Monthly Plans",
];

const WORKFLOW_STATES = [
  { id: "new_candidate", label: "New Candidate", color: "#6c757d" },
  { id: "shortlisted", label: "Shortlisted", color: "#0075EB" },
  { id: "selected_for_outreach", label: "Selected for Outreach", color: "#6f42c1" },
  { id: "in_cadence", label: "In Cadence", color: "#e67e22" },
  { id: "active_opportunity", label: "Active Opportunity", color: "#20c997" },
  { id: "closed_won", label: "Closed Won", color: "#0a8754" },
  { id: "closed_lost", label: "Closed Lost", color: "#c0392b" },
  { id: "revisit_later", label: "Revisit Later", color: "#95a5a6" },
  { id: "held_for_review", label: "Held for Review", color: "#f39c12" },
];

const VALID_STATE_IDS = WORKFLOW_STATES.map((s) => s.id);

const ALLOWED_TRANSITIONS = {
  new_candidate: ["shortlisted", "held_for_review", "revisit_later"],
  shortlisted: ["selected_for_outreach", "revisit_later", "held_for_review", "new_candidate"],
  selected_for_outreach: ["in_cadence", "shortlisted", "revisit_later"],
  in_cadence: ["active_opportunity", "closed_lost", "revisit_later"],
  active_opportunity: ["closed_won", "closed_lost", "in_cadence"],
  closed_won: [],
  closed_lost: ["revisit_later", "new_candidate"],
  revisit_later: ["new_candidate", "shortlisted"],
  held_for_review: ["new_candidate", "shortlisted"],
};

// --- Exclusions and suppression ---

const SUPPRESSED_STATES = ["closed_won", "closed_lost", "held_for_review", "revisit_later"];
let exclusionsCache = null;

function normalizeCompanyNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
  if (!stripped) return null;

  if (/^\d{1,8}$/.test(stripped)) {
    return stripped.padStart(8, "0");
  }

  if (/^[A-Z0-9]{2,12}$/.test(stripped)) {
    return stripped;
  }

  return null;
}

function normalizeSicCode(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 5 ? digits : null;
}

function normalizeSicCodeList(values) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const sicCode = normalizeSicCode(value);
    if (!sicCode || seen.has(sicCode)) continue;
    seen.add(sicCode);
    normalized.push(sicCode);
  }
  return normalized;
}

function normalizeExclusionConfig(exclusions = {}) {
  const normalizeStringList = (values) => {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const normalized = [];
    for (const value of values) {
      const token = String(value || "").trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      normalized.push(token);
    }
    return normalized;
  };

  return {
    prohibited_industries: normalizeStringList(exclusions.prohibited_industries),
    excluded_company_ids: normalizeStringList(exclusions.excluded_company_ids),
    prohibited_sic_codes: normalizeSicCodeList(exclusions.prohibited_sic_codes),
  };
}

function getCurrentExclusions() {
  if (!exclusionsCache) {
    exclusionsCache = normalizeExclusionConfig(dbGetExclusions());
  }
  return exclusionsCache;
}

function setCurrentExclusions(exclusions) {
  exclusionsCache = normalizeExclusionConfig(exclusions);
  return exclusionsCache;
}

function getStoredSicCodes(companyNumber) {
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  if (!normalizedCompanyNumber) return [];
  return normalizeSicCodeList(getSetting(`sic_codes_${normalizedCompanyNumber}`, []));
}

function setStoredSicCodes(companyNumber, sicCodes) {
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  if (!normalizedCompanyNumber) return [];
  const normalizedCodes = normalizeSicCodeList(sicCodes);
  setSetting(`sic_codes_${normalizedCompanyNumber}`, normalizedCodes);
  return normalizedCodes;
}

function getSicExclusionMatch(companyNumber, sicCodesHint = null) {
  const prohibitedSicCodes = getCurrentExclusions().prohibited_sic_codes || [];
  if (prohibitedSicCodes.length === 0) return [];

  const prohibitedSicCodeSet = new Set(prohibitedSicCodes);
  const hintCodes = normalizeSicCodeList(Array.isArray(sicCodesHint) ? sicCodesHint : []);
  const sourceCodes = hintCodes.length > 0 ? hintCodes : getStoredSicCodes(companyNumber);

  return sourceCodes.filter((code) => prohibitedSicCodeSet.has(code));
}

function isExcluded(company) {
  const exclusions = getCurrentExclusions();
  if (exclusions.excluded_company_ids.includes(company.id)) return { excluded: true, reason: "Manually excluded" };
  const industry = String(company?.industry || "");
  if (industry && exclusions.prohibited_industries.some((ind) => industry.toLowerCase().includes(String(ind || "").toLowerCase()))) {
    return { excluded: true, reason: `Prohibited industry: ${company.industry}` };
  }
  const matchedSicCodes = getSicExclusionMatch(company?.company_number, company?.sic_codes);
  if (matchedSicCodes.length > 0) {
    return { excluded: true, reason: `Excluded SIC: ${matchedSicCodes.join(", ")}` };
  }
  return { excluded: false };
}

function isSuppressed(companyId, companyNumberHint = null) {
  const ws = getCompanyState(companyId);
  if (SUPPRESSED_STATES.includes(ws.state)) {
    const label = WORKFLOW_STATES.find((s) => s.id === ws.state)?.label || ws.state;
    return { suppressed: true, reason: `Status: ${label}` };
  }

  const resolvedCompanyNumber = normalizeCompanyNumber(
    companyNumberHint || companyNumberFromId(canonicalCompanyId(companyId))
  );
  if (resolvedCompanyNumber) {
    const closedWon = getClosedWonCompany(resolvedCompanyNumber);
    if (closedWon) {
      return { suppressed: true, reason: "Status: Closed Won (registry)", source: "closed_won_registry" };
    }

    const matchedSicCodes = getSicExclusionMatch(resolvedCompanyNumber);
    if (matchedSicCodes.length > 0) {
      return {
        suppressed: true,
        reason: `SIC excluded: ${matchedSicCodes.join(", ")}`,
        source: "sic_exclusion",
      };
    }
  }

  return { suppressed: false };
}

// --- Scoring weights (segment-aware) ---

const VALID_SEGMENTS = ["SMB", "Mid-Market", "Enterprise"];

function getSegmentWeights() {
  return getSetting("segment_weights", DEFAULT_SEGMENT_WEIGHTS);
}

function getPropensityWeight() {
  return getSetting("propensity_weight", DEFAULT_PROPENSITY_WEIGHT);
}

const DEFAULT_WEIGHTS = DEFAULT_SEGMENT_WEIGHTS["Mid-Market"];
const SHORTLIST_AUTO_ANALYSIS_BATCH = Number.parseInt(process.env.SHORTLIST_AUTO_ANALYSIS_BATCH || "3", 10);
const SHORTLIST_AUTO_ANALYSIS_MIN_INTERVAL_MS = Number.parseInt(process.env.SHORTLIST_AUTO_ANALYSIS_MIN_INTERVAL_MS || "10000", 10);
const SHORTLIST_BACKGROUND_SEED_INTERVAL_MS = Number.parseInt(process.env.SHORTLIST_BACKGROUND_SEED_INTERVAL_MS || "120000", 10);
const SHORTLIST_BACKGROUND_SEED_LIMIT = Number.parseInt(process.env.SHORTLIST_BACKGROUND_SEED_LIMIT || "1200", 10);
const SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE = Number.parseInt(process.env.SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE || "80", 10);
const SHORTLIST_BACKGROUND_SEED_QUEUE_SOFT_CAP = Number.parseInt(process.env.SHORTLIST_BACKGROUND_SEED_QUEUE_SOFT_CAP || "180", 10);
const SHORTLIST_BACKGROUND_SEED_QUEUE_HARD_CAP = Number.parseInt(process.env.SHORTLIST_BACKGROUND_SEED_QUEUE_HARD_CAP || "320", 10);
const TECH_ENRICHMENT_RUNTIME = getTechEnrichmentRuntimeConfig();
const TECH_ENRICHMENT_SEED_ENABLED = String(process.env.TECH_ENRICHMENT_SEED_ENABLED || "true").toLowerCase() !== "false";
const TECH_ENRICHMENT_SEED_INTERVAL_MS = Number.parseInt(process.env.TECH_ENRICHMENT_SEED_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
const TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS = Number.parseInt(process.env.TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS || "45000", 10);
const TECH_ENRICHMENT_SEED_LIMIT = Number.parseInt(process.env.TECH_ENRICHMENT_SEED_LIMIT || "1200", 10);
const TECH_ENRICHMENT_SEED_MAX_REFRESH = Number.parseInt(process.env.TECH_ENRICHMENT_SEED_MAX_REFRESH || "60", 10);
const TECH_ENRICHMENT_SEED_DEEP_SCAN_MODE = String(process.env.TECH_ENRICHMENT_SEED_DEEP_SCAN_MODE || "off").trim().toLowerCase();
const EMAIL_STYLE_PROFILE_SETTING_KEY = "email_style_profile_v1";
const EMAIL_STYLE_PROFILE_VERSION = "1.0";
const BACKFILL_AUTORUN_ENABLED = String(process.env.BACKFILL_AUTORUN || "true").toLowerCase() !== "false";
const BACKFILL_AUTORUN_INTERVAL_MS = Number.parseInt(process.env.BACKFILL_AUTORUN_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
const BACKFILL_AUTORUN_MAX_FILES = Number.parseInt(process.env.BACKFILL_AUTORUN_MAX_FILES || "1", 10);
const BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS = Number.parseInt(process.env.BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS || String(45 * 60 * 1000), 10);
const BACKFILL_AUTORUN_BACKLOG_THRESHOLD = Number.parseInt(process.env.BACKFILL_AUTORUN_BACKLOG_THRESHOLD || "6", 10);
const BACKFILL_AUTORUN_CATCHUP_MAX_FILES = Number.parseInt(process.env.BACKFILL_AUTORUN_CATCHUP_MAX_FILES || "3", 10);
let lastShortlistAutoQueueRunAt = 0;
let shortlistBackgroundSeedTimer = null;
let techEnrichmentSeedTimer = null;
const techEnrichmentSeedStatus = {
  enabled: false,
  timer_active: false,
  running: false,
  interval_ms: Math.max(60000, Number.isFinite(TECH_ENRICHMENT_SEED_INTERVAL_MS) ? TECH_ENRICHMENT_SEED_INTERVAL_MS : 6 * 60 * 60 * 1000),
  initial_delay_ms: Math.max(5000, Number.isFinite(TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS) ? TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS : 45000),
  limit: Math.max(50, Number.isFinite(TECH_ENRICHMENT_SEED_LIMIT) ? TECH_ENRICHMENT_SEED_LIMIT : 1200),
  max_refresh: Math.max(1, Number.isFinite(TECH_ENRICHMENT_SEED_MAX_REFRESH) ? TECH_ENRICHMENT_SEED_MAX_REFRESH : 60),
  deep_scan_mode: "off",
  last_started_at: null,
  last_completed_at: null,
  last_result: null,
  last_error: null,
};
let backfillAutoTimer = null;

const backfillAutoStatus = {
  enabled: false,
  interval_ms: BACKFILL_AUTORUN_INTERVAL_MS,
  catchup_interval_ms: BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS,
  backlog_threshold: BACKFILL_AUTORUN_BACKLOG_THRESHOLD,
  max_files: Math.max(1, BACKFILL_AUTORUN_MAX_FILES),
  catchup_max_files: Math.max(1, Math.max(BACKFILL_AUTORUN_MAX_FILES, BACKFILL_AUTORUN_CATCHUP_MAX_FILES)),
  mode: "normal",
  last_run: null,
  next_run: null,
  next_interval_ms: BACKFILL_AUTORUN_INTERVAL_MS,
  last_result: null,
  last_error: null,
};

function getWeightsForSegment(segment) {
  const weights = getSegmentWeights();
  return weights[segment] || DEFAULT_WEIGHTS;
}

function computeCompositeScore(layers, weights = DEFAULT_WEIGHTS) {
  let total = 0;
  let weightSum = 0;
  for (const layer of LAYER_NAMES) {
    if (layers[layer]) {
      total += (layers[layer].score || 0) * (weights[layer] || 0);
      weightSum += weights[layer] || 0;
    }
  }
  return weightSum > 0 ? Math.round((total / weightSum) * 100) / 100 : 0;
}

function buildScoreBreakdown(layers) {
  const breakdown = {};
  for (const layer of LAYER_NAMES) {
    if (layers[layer]) {
      breakdown[layer] = {
        score: layers[layer].score,
        evidence: layers[layer].evidence,
      };
    }
  }
  return breakdown;
}

function getOrBuildMonitorScore(companyNumber) {
  const stored = getStoredScore(companyNumber);
  if (stored) return stored;
  try {
    return scoreCompany(companyNumber);
  } catch {
    return null;
  }
}

function parseDateToUtc(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const ts = Date.parse(dateOnly);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function daysSinceDate(value) {
  const parsed = parseDateToUtc(value);
  if (!parsed) return null;
  const diff = Date.now() - parsed.getTime();
  if (!Number.isFinite(diff) || diff < 0) return 0;
  return Math.floor(diff / 86400000);
}

function isDateWithinLastMonths(value, months) {
  const parsed = parseDateToUtc(value);
  if (!parsed) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - Math.max(1, Number.parseInt(String(months || 1), 10)));
  return parsed >= cutoff;
}

function clamp01(value) {
  return Math.max(0, Math.min(Number(value || 0), 1));
}

function filingFreshnessSignal(latestFilingDate) {
  const daysOld = daysSinceDate(latestFilingDate);
  if (daysOld === null) return 0.35;
  if (daysOld <= 365) return 0.9;
  if (daysOld <= 730) return 0.7;
  if (daysOld <= 1095) return 0.45;
  return 0.2;
}

export function computePriorityBreakdown(companyRow, score, analysisStatus, segment = "Mid-Market") {
  const turnover = Number(companyRow?.latest_turnover || 0);
  const productFit = clamp01(Number(score?.layers?.product_fit?.score || 0));
  const commercialValue = clamp01(Number(score?.layers?.commercial_value?.score || 0));
  const bestMotionWeighted = clamp01(Number(score?.layers?.product_fit?.best_score || 0));
  const turnoverSignal = clamp01(turnover / 500_000_000);
  const velocitySignal = clamp01(Number(score?.velocity?.score || 0.5));
  const confidencePlusMinus = clamp01(Number(score?.confidence_interval?.plus_minus || 0) * 1.5);
  const confidenceLevel = String(score?.confidence_interval?.confidence_level || "medium");
  const confidencePenalty = confidencePlusMinus * 0.14;
  const volatilityBand = String(score?.volatility?.band || "stable");
  const volatilityDrag = volatilityBand === "high" ? -0.1 : volatilityBand === "moderate" ? -0.045 : 0;
  const instabilityDrag = score?.volatility?.instability_flag ? -0.06 : 0;

  const gpPotential = clamp01(Number(
    score?.gp_potential_score
      ?? Math.max(0, Math.min((bestMotionWeighted * 0.65) + (commercialValue * 0.35) + (productFit * 0.1), 1))
  ));

  let fitScore = clamp01((
    (clamp01(Number(score?.fit_score ?? score?.composite_score ?? 0)) * 0.7)
    + (gpPotential * 0.2)
    + (turnoverSignal * 0.1)
  ));

  const fitGate = productFit < 0.15 ? 0.35 : productFit < 0.25 ? 0.55 : productFit < 0.35 ? 0.8 : 1;
  const fitReliability = confidenceLevel === "low" ? 0.88 : confidenceLevel === "high" ? 1.0 : 0.95;
  fitScore = clamp01(fitScore * fitGate * fitReliability);
  const segmentWeights = getWeightsForSegment(segment);
  let segmentFitWeightedTotal = 0;
  let segmentFitWeightSum = 0;
  for (const layerName of LAYER_NAMES) {
    const layerScore = Number(score?.layers?.[layerName]?.score);
    const layerWeight = Number(segmentWeights?.[layerName]);
    if (Number.isFinite(layerScore) && Number.isFinite(layerWeight) && layerWeight > 0) {
      segmentFitWeightedTotal += clamp01(layerScore) * layerWeight;
      segmentFitWeightSum += layerWeight;
    }
  }
  const segmentWeightedFit = clamp01(
    segmentFitWeightSum > 0
      ? segmentFitWeightedTotal / segmentFitWeightSum
      : fitScore
  );
  fitScore = clamp01((fitScore * 0.5) + (segmentWeightedFit * 0.5));

  const propensityBase = clamp01(Number(score?.propensity_score ?? score?.layers?.urgency?.score ?? 0.5));
  const readinessSignal = analysisStatus === "ready"
    ? 0.12
    : analysisStatus === "queued"
      ? -0.05
      : analysisStatus === "failed"
        ? -0.12
        : 0;
  const qualitySignal = clamp01(Math.max(
    Number(score?.integration_quality?.coverage_ratio || 0),
    Number(score?.enrichment?.sources_available || 0) / 6
  ));
  const freshnessSignal = filingFreshnessSignal(companyRow?.latest_filing_date);
  const stakeholderSignal = clamp01(Number(score?.stakeholder_priority?.boost || 0) * 8);
  const belowThresholdDrag = companyRow?.below_threshold === 1 ? -0.18 : 0;

  const propensityScore = clamp01(
    (propensityBase * 0.4)
    + (freshnessSignal * 0.14)
    + (qualitySignal * 0.09)
    + (stakeholderSignal * 0.12)
    + (velocitySignal * 0.22)
    + readinessSignal
    + belowThresholdDrag
    + volatilityDrag
    + instabilityDrag
    - confidencePenalty
  );

  const propShare = clamp01(0.25 + getPropensityWeight());
  const fitShare = 1 - propShare;
  const priorityScore = Math.round(clamp01((fitScore * fitShare) + (propensityScore * propShare)) * 1000) / 1000;
  const reason = [
    fitScore >= 0.7 ? "strong fit" : fitScore >= 0.5 ? "moderate fit" : "low fit",
    propensityScore >= 0.7 ? "high timing/response propensity" : propensityScore >= 0.5 ? "moderate timing signal" : "weak timing signal",
    velocitySignal >= 0.68 ? "high conversion velocity" : velocitySignal >= 0.5 ? "moderate conversion velocity" : "slow conversion velocity",
    confidenceLevel === "high" ? "high confidence" : confidenceLevel === "low" ? "low confidence" : "medium confidence",
    analysisStatus === "ready" ? "analysis ready" : analysisStatus === "queued" ? "analysis queued" : analysisStatus === "failed" ? "analysis failed" : "analysis pending",
  ].join("; ");

  return {
    priority_score: priorityScore,
    fit_score: Math.round(fitScore * 1000) / 1000,
    segment_weighted_fit: Math.round(segmentWeightedFit * 1000) / 1000,
    propensity_score: Math.round(propensityScore * 1000) / 1000,
    propensity_share: Math.round(propShare * 1000) / 1000,
    velocity_score: Math.round(velocitySignal * 1000) / 1000,
    confidence_level: confidenceLevel,
    confidence_plus_minus: Math.round(Number(score?.confidence_interval?.plus_minus || 0) * 100) / 100,
    score_interval_low: Number(score?.confidence_interval?.lower ?? null),
    score_interval_high: Number(score?.confidence_interval?.upper ?? null),
    volatility_band: volatilityBand,
    reason,
  };
}

function maybeKickShortlistAutoAnalysis(batchSize = SHORTLIST_AUTO_ANALYSIS_BATCH) {
  const now = Date.now();
  if ((now - lastShortlistAutoQueueRunAt) < Math.max(1000, SHORTLIST_AUTO_ANALYSIS_MIN_INTERVAL_MS)) {
    return;
  }
  lastShortlistAutoQueueRunAt = now;
  processAnalysisQueueBatch({ batchSize: Math.max(1, Math.min(batchSize || 3, 10)) }).catch((err) => {
    console.warn("Shortlist auto-analysis trigger failed:", err.message);
  });
}

function deriveAnalysisStatus(queueItem, storedAnalysis) {
  if (queueItem?.status === "ready" || (!queueItem && storedAnalysis)) return "ready";
  if (queueItem?.status === "queued" || queueItem?.status === "processing") return "queued";
  if (queueItem?.status === "failed") return "failed";
  return "none";
}

function seedMissingShortlistAnalyses(options = {}) {
  const limit = Math.max(100, Math.min(Number.parseInt(String(options.limit || SHORTLIST_BACKGROUND_SEED_LIMIT), 10) || SHORTLIST_BACKGROUND_SEED_LIMIT, 5000));
  const maxEnqueue = Math.max(1, Math.min(Number.parseInt(String(options.maxEnqueue || SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE), 10) || SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE, 500));
  const source = options.source || "background_shortlist_seed";
  const queueCounts = getAnalysisQueueCounts();
  const queuedCount = Number(queueCounts?.queued || 0);
  const processingCount = Number(queueCounts?.processing || 0);
  const queueSoftCap = Math.max(20, SHORTLIST_BACKGROUND_SEED_QUEUE_SOFT_CAP);
  const queueHardCap = Math.max(queueSoftCap, SHORTLIST_BACKGROUND_SEED_QUEUE_HARD_CAP);

  if (queuedCount >= queueHardCap) {
    return {
      scanned: 0,
      candidates: 0,
      queued: 0,
      throttled_reason: "queue_hard_cap_reached",
      queue_counts: queueCounts,
      queue_soft_cap: queueSoftCap,
      queue_hard_cap: queueHardCap,
      effective_max_enqueue: 0,
    };
  }

  const queueHeadroom = Math.max(0, queueSoftCap - queuedCount);
  const effectiveMaxEnqueue = Math.max(0, Math.min(maxEnqueue, queueHeadroom));

  if (effectiveMaxEnqueue <= 0) {
    return {
      scanned: 0,
      candidates: 0,
      queued: 0,
      throttled_reason: "queue_soft_cap_reached",
      queue_counts: queueCounts,
      queue_soft_cap: queueSoftCap,
      queue_hard_cap: queueHardCap,
      effective_max_enqueue: 0,
    };
  }

  const companies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit });
  if (companies.length === 0) {
    return {
      scanned: 0,
      candidates: 0,
      queued: 0,
      queue_counts: queueCounts,
      queue_soft_cap: queueSoftCap,
      queue_hard_cap: queueHardCap,
      effective_max_enqueue: effectiveMaxEnqueue,
    };
  }

  const companyNumbers = companies.map((c) => c.company_number);
  const queueRows = getAnalysisQueueItemsByCompanyNumbers(companyNumbers);

  const toQueue = [];
  for (const company of companies) {
    if (isClosedWonCompanyNumber(company.company_number)) continue;
    const queue = queueRows[company.company_number];
    if (queue?.status === "queued" || queue?.status === "processing") continue;
    const storedAnalysis = getSetting(`analysis_${company.company_number}`, null);
    if (storedAnalysis) continue;
    toQueue.push({ company_number: company.company_number, company_name: company.company_name });
    if (toQueue.length >= effectiveMaxEnqueue) break;
  }

  if (toQueue.length === 0) {
    return {
      scanned: companies.length,
      candidates: 0,
      queued: 0,
      queue_counts: queueCounts,
      queue_soft_cap: queueSoftCap,
      queue_hard_cap: queueHardCap,
      effective_max_enqueue: effectiveMaxEnqueue,
    };
  }

  const queued = enqueueCompaniesForAnalysis(toQueue, source).queued;
  const queueCountsAfter = getAnalysisQueueCounts();
  if (queued > 0) {
    const queueLoad = Number(queueCountsAfter?.queued || 0) + Number(queueCountsAfter?.processing || 0);
    const adaptiveBatch = Math.max(
      SHORTLIST_AUTO_ANALYSIS_BATCH,
      Math.min(10, Math.ceil(queueLoad / 30))
    );
    maybeKickShortlistAutoAnalysis(adaptiveBatch);
  }

  return {
    scanned: companies.length,
    candidates: toQueue.length,
    queued,
    queue_counts: queueCountsAfter,
    queue_soft_cap: queueSoftCap,
    queue_hard_cap: queueHardCap,
    effective_max_enqueue: effectiveMaxEnqueue,
    pre_queue_processing: processingCount,
  };
}

function startShortlistBackgroundSeeder() {
  if (shortlistBackgroundSeedTimer) {
    clearInterval(shortlistBackgroundSeedTimer);
    shortlistBackgroundSeedTimer = null;
  }

  const intervalMs = Math.max(30000, SHORTLIST_BACKGROUND_SEED_INTERVAL_MS);
  shortlistBackgroundSeedTimer = setInterval(() => {
    try {
      seedMissingShortlistAnalyses({
        limit: SHORTLIST_BACKGROUND_SEED_LIMIT,
        maxEnqueue: SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE,
        source: "background_shortlist_seed",
      });
    } catch (err) {
      console.warn("Background shortlist seeding failed:", err.message);
    }
  }, intervalMs);

  setTimeout(() => {
    try {
      seedMissingShortlistAnalyses({
        limit: SHORTLIST_BACKGROUND_SEED_LIMIT,
        maxEnqueue: SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE,
        source: "background_shortlist_seed_initial",
      });
    } catch (err) {
      console.warn("Initial shortlist seeding failed:", err.message);
    }
  }, 5000);

  return {
    enabled: true,
    interval_ms: intervalMs,
    limit: SHORTLIST_BACKGROUND_SEED_LIMIT,
    max_enqueue: SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE,
    queue_soft_cap: Math.max(20, SHORTLIST_BACKGROUND_SEED_QUEUE_SOFT_CAP),
    queue_hard_cap: Math.max(Math.max(20, SHORTLIST_BACKGROUND_SEED_QUEUE_SOFT_CAP), SHORTLIST_BACKGROUND_SEED_QUEUE_HARD_CAP),
  };
}

function getTechEnrichmentSeedStatus() {
  return {
    ...techEnrichmentSeedStatus,
    timer_active: !!techEnrichmentSeedTimer,
  };
}

async function seedMissingTechEnrichment(options = {}) {
  const configuredLimit = Number.parseInt(String(options.limit || TECH_ENRICHMENT_SEED_LIMIT), 10) || TECH_ENRICHMENT_SEED_LIMIT;
  const configuredMaxRefresh = Number.parseInt(String(options.maxRefresh || TECH_ENRICHMENT_SEED_MAX_REFRESH), 10) || TECH_ENRICHMENT_SEED_MAX_REFRESH;
  const configuredRefreshWindow = Number.parseInt(
    String(options.refreshWindowDays || TECH_ENRICHMENT_RUNTIME.refresh_window_days),
    10
  ) || TECH_ENRICHMENT_RUNTIME.refresh_window_days;

  const limit = Math.max(100, Math.min(configuredLimit, 5000));
  const maxRefresh = Math.max(1, Math.min(configuredMaxRefresh, 300));
  const refreshWindowDays = Math.max(1, Math.min(configuredRefreshWindow, 365));
  const source = toOptionalString(options.source) || "background_tech_enrichment_seed";
  const deepScanMode =
    parseDeepScanModeInput(options.deepScanMode)
    || parseDeepScanModeInput(TECH_ENRICHMENT_SEED_DEEP_SCAN_MODE)
    || "off";

  const shortlist = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit });
  if (shortlist.length === 0) {
    return {
      source,
      scanned: 0,
      candidates: 0,
      processed: 0,
      refreshed: 0,
      skipped: 0,
      failed: 0,
      deep_scan_mode: deepScanMode,
      refresh_window_days: refreshWindowDays,
    };
  }

  const candidates = [];
  for (const company of shortlist) {
    if (isClosedWonCompanyNumber(company.company_number)) continue;

    const snapshot = getCompanyEnrichmentSnapshot(company.company_number, { includeData: false });
    const techNeedsRefresh = !snapshot.tech_stack.available || snapshot.tech_stack.stale;
    const websiteNeedsRefresh = !snapshot.website_intelligence.available || snapshot.website_intelligence.stale;
    const marketingNeedsRefresh = !snapshot.marketing_intelligence.available || snapshot.marketing_intelligence.stale;

    if (!techNeedsRefresh && !websiteNeedsRefresh && !marketingNeedsRefresh) continue;

    candidates.push(company);
    if (candidates.length >= maxRefresh) break;
  }

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  const runs = [];

  for (const company of candidates) {
    const context = resolveCompanyContextForEnrichment(company.company_number, company);
    if (!context) {
      skipped += 1;
      runs.push({
        company_number: company.company_number,
        company_name: company.company_name,
        status: "unresolved_company",
        updated: false,
      });
      continue;
    }

    try {
      const run = await runCompanyTechEnrichment({
        companyNumber: context.company_number,
        companyName: context.company_name || company.company_name,
        companyWebsite: context.company_website,
        companyDomain: context.company_domain,
        turnover: context.turnover,
        force: false,
        deepScanMode,
        refreshWindowDays,
      });

      if (run.updated) {
        refreshed += 1;
      } else {
        skipped += 1;
      }

      runs.push({
        company_number: context.company_number,
        company_name: context.company_name,
        status: run.status,
        updated: run.updated === true,
        scan_mode: run.scan_mode || null,
      });
    } catch (err) {
      failed += 1;
      runs.push({
        company_number: context.company_number,
        company_name: context.company_name,
        status: "error",
        updated: false,
        error: err.message,
      });
    }
  }

  return {
    source,
    scanned: shortlist.length,
    candidates: candidates.length,
    processed: runs.length,
    refreshed,
    skipped,
    failed,
    deep_scan_mode: deepScanMode,
    refresh_window_days: refreshWindowDays,
    sample: runs.slice(0, 25),
  };
}

async function runTechEnrichmentSeedCycle(source = "background_tech_enrichment_seed") {
  if (techEnrichmentSeedStatus.running) {
    return {
      skipped: true,
      reason: "already_running",
    };
  }

  techEnrichmentSeedStatus.running = true;
  techEnrichmentSeedStatus.last_started_at = new Date().toISOString();

  try {
    const result = await seedMissingTechEnrichment({
      limit: techEnrichmentSeedStatus.limit,
      maxRefresh: techEnrichmentSeedStatus.max_refresh,
      deepScanMode: techEnrichmentSeedStatus.deep_scan_mode,
      source,
    });
    techEnrichmentSeedStatus.last_result = result;
    techEnrichmentSeedStatus.last_error = null;
    return result;
  } catch (err) {
    techEnrichmentSeedStatus.last_error = err.message;
    return {
      status: "error",
      error: err.message,
    };
  } finally {
    techEnrichmentSeedStatus.running = false;
    techEnrichmentSeedStatus.last_completed_at = new Date().toISOString();
  }
}

function startTechEnrichmentSeeder() {
  if (techEnrichmentSeedTimer) {
    clearInterval(techEnrichmentSeedTimer);
    techEnrichmentSeedTimer = null;
  }

  techEnrichmentSeedStatus.enabled = TECH_ENRICHMENT_SEED_ENABLED;
  techEnrichmentSeedStatus.interval_ms = Math.max(
    60000,
    Number.isFinite(TECH_ENRICHMENT_SEED_INTERVAL_MS) ? TECH_ENRICHMENT_SEED_INTERVAL_MS : 6 * 60 * 60 * 1000
  );
  techEnrichmentSeedStatus.initial_delay_ms = Math.max(
    5000,
    Number.isFinite(TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS) ? TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS : 45000
  );
  techEnrichmentSeedStatus.limit = Math.max(
    100,
    Math.min(Number.isFinite(TECH_ENRICHMENT_SEED_LIMIT) ? TECH_ENRICHMENT_SEED_LIMIT : 1200, 5000)
  );
  techEnrichmentSeedStatus.max_refresh = Math.max(
    1,
    Math.min(Number.isFinite(TECH_ENRICHMENT_SEED_MAX_REFRESH) ? TECH_ENRICHMENT_SEED_MAX_REFRESH : 60, 300)
  );
  techEnrichmentSeedStatus.deep_scan_mode =
    parseDeepScanModeInput(TECH_ENRICHMENT_SEED_DEEP_SCAN_MODE)
    || parseDeepScanModeInput(TECH_ENRICHMENT_RUNTIME.deep_scan_mode)
    || "off";
  techEnrichmentSeedStatus.last_error = null;

  if (!TECH_ENRICHMENT_SEED_ENABLED) {
    techEnrichmentSeedStatus.timer_active = false;
    return getTechEnrichmentSeedStatus();
  }

  techEnrichmentSeedTimer = setInterval(() => {
    runTechEnrichmentSeedCycle("background_tech_enrichment_seed").catch((err) => {
      techEnrichmentSeedStatus.last_error = err.message;
    });
  }, techEnrichmentSeedStatus.interval_ms);

  setTimeout(() => {
    runTechEnrichmentSeedCycle("background_tech_enrichment_seed_initial").catch((err) => {
      techEnrichmentSeedStatus.last_error = err.message;
    });
  }, techEnrichmentSeedStatus.initial_delay_ms);

  techEnrichmentSeedStatus.timer_active = true;
  return getTechEnrichmentSeedStatus();
}

// --- State persistence (SQLite) ---

function getCompanyState(companyId) {
  const canonicalId = canonicalCompanyId(companyId);
  const canonical = getCompanyWorkflowState(canonicalId);
  if (canonicalId !== companyId && canonical.state === "new_candidate" && canonical.history.length === 0) {
    const legacy = getCompanyWorkflowState(companyId);
    if (legacy.state !== "new_candidate" || legacy.history.length > 0) return legacy;
  }
  return canonical;
}

// --- Unified multi-motion scoring ---

function normalizeNarrativeItems(items, limit = 3) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    if (out.length >= limit) break;
    const text = String(item || "").trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function extractEvidenceHighlights(evidence, limit = 2) {
  if (!Array.isArray(evidence)) return [];
  const highlights = [];
  for (const item of evidence) {
    if (highlights.length >= limit) break;
    let text = "";
    if (typeof item === "string") {
      text = item;
    } else if (item && typeof item === "object") {
      text = item.text || item.signal || item.reason || "";
    }
    text = String(text || "").trim();
    if (text) highlights.push(text);
  }
  return highlights;
}

function humanizeGate(rawGate) {
  const text = String(rawGate || "").trim();
  if (!text) return "";
  return text.replace(/_/g, " ");
}

function buildMotionScoreNarrative(score, motionData, fallbackExplanation = "") {
  const motion = String(motionData?.motion || "Opportunity");
  const baseExplanation = String(fallbackExplanation || `${motion} fit inferred from available signals.`).trim();
  const evidenceHighlights = extractEvidenceHighlights(motionData?.evidence, 2);

  const drivers = [
    ...normalizeNarrativeItems(score?.score_explanation?.drivers, 2),
    ...evidenceHighlights,
  ];
  if (drivers.length === 0) drivers.push(baseExplanation);

  const risks = normalizeNarrativeItems(score?.score_explanation?.risks, 2);
  if (motionData?.qualification_gate) {
    risks.unshift(`Qualification gate applied: ${humanizeGate(motionData.qualification_gate)}.`);
  }
  if (String(score?.confidence_interval?.confidence_level || "").toLowerCase() === "low") {
    risks.push("Evidence confidence is low; validate with fresher filings or connector sync.");
  }

  const confidenceLevel = String(score?.confidence_interval?.confidence_level || "").trim();
  const velocityBand = String(score?.velocity?.band || "").trim();
  const confidenceSnippet = confidenceLevel ? `${confidenceLevel} confidence` : "";
  const velocitySnippet = velocityBand ? `${velocityBand} velocity` : "";

  return {
    headline: [baseExplanation, confidenceSnippet, velocitySnippet].filter(Boolean).join(" | "),
    drivers: [...new Set(drivers)].slice(0, 3),
    risks: [...new Set(risks)].slice(0, 3),
    evidence: evidenceHighlights,
  };
}

function buildLegacyMotionNarrative(motion, fit) {
  const fitLevel = String(fit?.fit_level || "medium").trim();
  const baseExplanation = String(
    fit?.explanation || `${motion} relevance is based on manually captured profile signals.`
  ).trim();
  const layers = fit?.layers || {};
  const layerEvidence = Object.values(layers)
    .map((layer) => {
      if (!layer) return "";
      if (typeof layer.evidence === "string") return layer.evidence;
      if (Array.isArray(layer.evidence)) {
        const first = layer.evidence.find((item) => typeof item === "string" || item?.text);
        if (typeof first === "string") return first;
        return first?.text || "";
      }
      return "";
    })
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .slice(0, 2);

  return {
    headline: `${motion} fit is ${fitLevel}.`,
    drivers: [baseExplanation, ...layerEvidence].filter(Boolean).slice(0, 3),
    risks: [],
    evidence: layerEvidence,
  };
}

function computeCompanyProfile(company) {
  const segment = company.segment || "Mid-Market";
  const weights = getWeightsForSegment(segment);
  const propensity = company.response_propensity || { score: 0.5, warmth: "cold", signals: [] };
  const normalizedPropensity = {
    ...propensity,
    score: clamp01(Number(propensity.score ?? 0.5)),
  };

  const merchantSpend = company.merchant_spend || null;
  const motionScores = [];
  for (const motion of company.motions) {
    const fit = company.product_fit[motion];
    if (!fit?.eligible) continue;
    const layers = fit.layers || {};
    const baseScore = computeCompositeScore(layers, weights);
    const score = Math.round(clamp01(baseScore) * 100) / 100;
    motionScores.push({
      motion,
      score,
      base_motion_score: baseScore,
      merchant_boost: 0,
      fit_level: fit.fit_level,
      explanation: fit.explanation,
      score_breakdown: buildScoreBreakdown(layers),
      score_narrative: buildLegacyMotionNarrative(motion, fit),
    });
  }
  motionScores.sort((a, b) => b.score - a.score);

  const bestScore = motionScores[0]?.score || 0;
  const avgScore = motionScores.length > 0
    ? Math.round((motionScores.reduce((s, m) => s + m.score, 0) / motionScores.length) * 100) / 100
    : 0;

  const fitGate = bestScore < 0.15 ? 0.35 : bestScore < 0.25 ? 0.55 : bestScore < 0.35 ? 0.8 : 1;
  const fitScore = clamp01(((bestScore * 0.65) + (avgScore * 0.35)) * fitGate);
  const combinedScore = Math.round(clamp01((fitScore * 0.6) + (normalizedPropensity.score * 0.4)) * 100) / 100;

  return {
    segment,
    scoring_model: "unified_v2_presets",
    legacy_profile_deprecated: true,
    weights_used: weights,
    motion_scores: motionScores,
    best_motion: motionScores[0] || null,
    combined_score: combinedScore,
    base_score: Math.round(fitScore * 100) / 100,
    fit_score: Math.round(fitScore * 100) / 100,
    propensity: normalizedPropensity,
    propensity_score: normalizedPropensity.score,
    merchant_spend: merchantSpend,
    eligible_motion_count: motionScores.length,
  };
}

// --- Report persistence (SQLite) ---

// --- Data loading ---

function loadCompanies() {
  return JSON.parse(fs.readFileSync(COMPANIES_FILE, "utf-8"));
}

function saveCompanies(companies) {
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));
}

function canonicalCompanyId(id) {
  if (id === undefined || id === null) return id;
  const normalized = String(id).trim();
  if (!normalized) return normalized;
  if (normalized.startsWith("ch-")) return normalized;
  if (/^\d{6,8}$/.test(normalized)) return `ch-${normalized.padStart(8, "0")}`;
  return normalized;
}

function companyNumberFromId(id) {
  if (id === undefined || id === null) return id;
  const normalized = String(id).trim();
  return normalized.startsWith("ch-") ? normalized.replace("ch-", "") : normalized;
}

function resolveCompanyNumberFromInput(companyId) {
  const normalized = normalizeCompanyNumber(companyNumberFromId(canonicalCompanyId(companyId)));
  if (normalized) return normalized;

  const fallback = String(companyNumberFromId(canonicalCompanyId(companyId)) || "").trim();
  return fallback || null;
}

function findCompanyByIdOrNumber(companies, companyId, normalizedCompanyNumber = null) {
  if (!Array.isArray(companies)) return null;

  const rawId = String(companyId || "").trim();
  if (!rawId) return null;

  const direct = companies.find((company) => company.id === rawId);
  if (direct) return direct;

  if (!normalizedCompanyNumber) return null;
  return companies.find((company) => normalizeCompanyNumber(company.company_number) === normalizedCompanyNumber) || null;
}

function parseBooleanInput(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const token = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(token)) return true;
  if (["false", "0", "no", "n", "off"].includes(token)) return false;
  return fallback;
}

function parseDeepScanModeInput(value) {
  if (value === undefined || value === null) return null;
  const token = String(value).trim().toLowerCase();
  if (!token) return null;
  if (["off", "false", "0"].includes(token)) return "off";
  if (["always", "true", "1", "on"].includes(token)) return "always";
  if (token === "auto") return "auto";
  return null;
}

function resolveEnrichmentDeepScanOptions(payload = {}, fallbackMode = null) {
  const explicitMode = parseDeepScanModeInput(payload.deep_scan_mode);
  if (explicitMode) {
    return { deepScanMode: explicitMode };
  }

  const modeFromLegacyFlag = parseDeepScanModeInput(payload.deep_scan);
  if (modeFromLegacyFlag) {
    return { deepScanMode: modeFromLegacyFlag };
  }

  if (payload.deep_scan !== undefined && payload.deep_scan !== null) {
    return { deepScan: parseBooleanInput(payload.deep_scan, true) };
  }

  const normalizedFallback = parseDeepScanModeInput(fallbackMode);
  if (normalizedFallback) {
    return { deepScanMode: normalizedFallback };
  }

  return {};
}

function toOptionalString(value) {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next || null;
}

function toOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTextList(value, options = {}) {
  const maxItems = Math.max(1, Math.min(Number.parseInt(String(options.maxItems || 10), 10) || 10, 20));
  const maxLength = Math.max(20, Math.min(Number.parseInt(String(options.maxLength || 180), 10) || 180, 500));
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/\r?\n|;/) : []);

  const seen = new Set();
  const output = [];
  for (const rawItem of rawItems) {
    const token = toOptionalString(rawItem);
    if (!token) continue;
    const normalized = token.slice(0, maxLength);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }

  return output;
}

function normalizeStyleExamples(value) {
  const raw = Array.isArray(value) ? value : [];
  const output = [];
  for (let idx = 0; idx < raw.length; idx += 1) {
    const item = raw[idx];
    const label = toOptionalString(item?.label || `Example ${idx + 1}`) || `Example ${idx + 1}`;
    const bodyRaw = typeof item === "string"
      ? item
      : (item?.text || item?.body || item?.content || "");
    const text = toOptionalString(bodyRaw);
    if (!text) continue;
    output.push({
      label: label.slice(0, 80),
      text: text.slice(0, 1000),
    });
    if (output.length >= 4) break;
  }
  return output;
}

function normalizeEmailStyleProfilePayload(rawProfile, options = {}) {
  if (!rawProfile || typeof rawProfile !== "object") return null;

  const enabled = rawProfile.enabled !== false;
  const name = toOptionalString(rawProfile.name || rawProfile.title);
  const description = toOptionalString(rawProfile.description);
  const stylePrompt = toOptionalString(rawProfile.style_prompt || rawProfile.stylePrompt);
  const voiceTraits = normalizeTextList(rawProfile.voice_traits || rawProfile.voiceTraits, { maxItems: 10, maxLength: 120 });
  const preferredPatterns = normalizeTextList(
    rawProfile.preferred_patterns || rawProfile.preferredPatterns || rawProfile.do,
    { maxItems: 12, maxLength: 220 }
  );
  const avoidPatterns = normalizeTextList(
    rawProfile.avoid_patterns || rawProfile.avoidPatterns || rawProfile.dont,
    { maxItems: 12, maxLength: 220 }
  );
  const examples = normalizeStyleExamples(rawProfile.examples);

  if (!enabled) {
    return {
      enabled: false,
      name: name ? name.slice(0, 120) : null,
      description: description ? description.slice(0, 600) : null,
      style_prompt: stylePrompt ? stylePrompt.slice(0, 2600) : null,
      voice_traits: voiceTraits,
      preferred_patterns: preferredPatterns,
      avoid_patterns: avoidPatterns,
      examples,
      version: EMAIL_STYLE_PROFILE_VERSION,
      updated_at: new Date().toISOString(),
    };
  }

  const hasContent = !!stylePrompt
    || voiceTraits.length > 0
    || preferredPatterns.length > 0
    || avoidPatterns.length > 0
    || examples.length > 0;

  if (!hasContent && options.allowEmpty !== true) {
    return null;
  }

  return {
    enabled: true,
    name: name ? name.slice(0, 120) : null,
    description: description ? description.slice(0, 600) : null,
    style_prompt: stylePrompt ? stylePrompt.slice(0, 2600) : null,
    voice_traits: voiceTraits,
    preferred_patterns: preferredPatterns,
    avoid_patterns: avoidPatterns,
    examples,
    version: EMAIL_STYLE_PROFILE_VERSION,
    updated_at: new Date().toISOString(),
  };
}

function getStoredEmailStyleProfile() {
  const raw = getSetting(EMAIL_STYLE_PROFILE_SETTING_KEY, null);
  return normalizeEmailStyleProfilePayload(raw, { allowEmpty: false });
}

function resolveEmailStyleProfileForRequest(payload = {}, options = {}) {
  const inlineProfile = normalizeEmailStyleProfilePayload(payload.style_profile || payload.styleProfile, { allowEmpty: false });
  if (inlineProfile && inlineProfile.enabled) return inlineProfile;

  const forceStored = options.forceStored === true;
  const useStored = forceStored || parseBooleanInput(payload.use_style_profile, false);
  if (!useStored) return null;

  const stored = getStoredEmailStyleProfile();
  if (!stored || stored.enabled !== true) return null;
  return stored;
}

function buildShadowPreviewCadence(rawPreviewSteps, rawTier) {
  const requested = Number.parseInt(String(rawPreviewSteps || "3"), 10);
  const steps = Math.max(3, Math.min(Number.isFinite(requested) ? requested : 3, 6));
  const tier = String(rawTier || "B").trim().toUpperCase();
  const safeTier = ["A", "B", "C"].includes(tier) ? tier : "B";
  const delays = [0, 3, 6, 9, 11, 14].slice(0, steps);
  const stepTypes = ["proof", "depth", "close", "peer_benchmark", "nudge_2", "close"].slice(0, steps);
  const sendConditions = Array.from({ length: steps }, () => "always");

  return {
    steps,
    delays,
    step_types: stepTypes,
    send_conditions: sendConditions,
    dossier_tier: safeTier,
    strategy: "shadow_preview",
  };
}

function compactPreviewText(value, maxLength = 150) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function summarizeGeneratedSequence(sequence) {
  const steps = Array.isArray(sequence?.steps) ? sequence.steps : [];
  const qcScores = steps
    .map((step) => Number(step?.qc_score))
    .filter((value) => Number.isFinite(value));
  const voiceScores = steps
    .map((step) => Number(step?.voice_percent))
    .filter((value) => Number.isFinite(value));
  const passCount = steps.filter((step) => step?.qc_pass === true).length;
  const llmCount = steps.filter((step) => String(step?.source || "").startsWith("llm")).length;
  const fallbackCount = steps.filter((step) => String(step?.source || "") === "fallback").length;

  return {
    steps: steps.length,
    avg_qc_score: qcScores.length > 0
      ? Math.round((qcScores.reduce((sum, value) => sum + value, 0) / qcScores.length) * 100) / 100
      : null,
    avg_voice_percent: voiceScores.length > 0
      ? Math.round((voiceScores.reduce((sum, value) => sum + value, 0) / voiceScores.length) * 100) / 100
      : null,
    pass_count: passCount,
    fail_count: Math.max(0, steps.length - passCount),
    llm_steps: llmCount,
    fallback_steps: fallbackCount,
  };
}

function buildShadowSequenceComparison(baseline, styled) {
  const baselineSummary = summarizeGeneratedSequence(baseline);
  const styledSummary = summarizeGeneratedSequence(styled);
  const baselineSteps = Array.isArray(baseline?.steps) ? baseline.steps : [];
  const styledSteps = Array.isArray(styled?.steps) ? styled.steps : [];
  const stepCount = Math.max(baselineSteps.length, styledSteps.length);

  const stepDeltas = [];
  for (let idx = 0; idx < stepCount; idx += 1) {
    const baseStep = baselineSteps[idx] || null;
    const styledStep = styledSteps[idx] || null;
    const baseQc = Number(baseStep?.qc_score);
    const styledQc = Number(styledStep?.qc_score);
    const qcDelta = Number.isFinite(baseQc) && Number.isFinite(styledQc)
      ? Math.round((styledQc - baseQc) * 100) / 100
      : null;

    stepDeltas.push({
      step_number: idx + 1,
      step_type: styledStep?.step_type || baseStep?.step_type || null,
      baseline_qc_score: Number.isFinite(baseQc) ? baseQc : null,
      styled_qc_score: Number.isFinite(styledQc) ? styledQc : null,
      qc_delta: qcDelta,
      baseline_preview: compactPreviewText(baseStep?.body),
      styled_preview: compactPreviewText(styledStep?.body),
    });
  }

  const avgQcDelta = baselineSummary.avg_qc_score !== null && styledSummary.avg_qc_score !== null
    ? Math.round((styledSummary.avg_qc_score - baselineSummary.avg_qc_score) * 100) / 100
    : null;
  const avgVoiceDelta = baselineSummary.avg_voice_percent !== null && styledSummary.avg_voice_percent !== null
    ? Math.round((styledSummary.avg_voice_percent - baselineSummary.avg_voice_percent) * 100) / 100
    : null;

  return {
    baseline: baselineSummary,
    styled: styledSummary,
    deltas: {
      avg_qc_score: avgQcDelta,
      avg_voice_percent: avgVoiceDelta,
      pass_count: styledSummary.pass_count - baselineSummary.pass_count,
      fail_count: styledSummary.fail_count - baselineSummary.fail_count,
    },
    step_deltas: stepDeltas,
  };
}

function resolveCompanyContextForEnrichment(companyId, overrides = {}) {
  const canonicalId = canonicalCompanyId(companyId);
  const companyNumber = companyNumberFromId(canonicalId);
  const companies = loadCompanies();
  const company = companies.find((c) => c.id === companyId || c.id === canonicalId || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);

  if (!company && !monitored) return null;

  const companyName =
    toOptionalString(overrides.company_name)
    || toOptionalString(overrides.companyName)
    || toOptionalString(company?.name)
    || toOptionalString(monitored?.company_name)
    || pendingCompanyName();

  const companyWebsite =
    toOptionalString(overrides.company_website)
    || toOptionalString(overrides.website)
    || toOptionalString(overrides.website_url)
    || toOptionalString(company?.website)
    || toOptionalString(company?.website_url)
    || null;

  const companyDomain =
    toOptionalString(overrides.company_domain)
    || toOptionalString(overrides.domain)
    || toOptionalString(overrides.domain_hint)
    || toOptionalString(company?.domain)
    || toOptionalString(company?.company_domain)
    || null;

  const turnover =
    toOptionalNumber(overrides.turnover)
    ?? toOptionalNumber(company?.turnover)
    ?? toOptionalNumber(monitored?.latest_turnover)
    ?? null;

  return {
    canonical_id: canonicalId,
    company_number: companyNumber,
    company_name: companyName,
    company_website: companyWebsite,
    company_domain: companyDomain,
    turnover,
    company,
    monitored,
  };
}

function isFallbackCompanyName(name, companyNumber) {
  return !name || name === `Company ${companyNumber}` || name === companyNumber;
}

function pendingCompanyName() {
  return "Name lookup needed";
}

function displayNameForCompanyNumber(companyNumber, storedName) {
  return isFallbackCompanyName(storedName, companyNumber) ? pendingCompanyName() : storedName;
}

function getManualList(kind, companyId) {
  return getSetting(`${kind}_${canonicalCompanyId(companyId)}`, []);
}

function setManualList(kind, companyId, items) {
  setSetting(`${kind}_${canonicalCompanyId(companyId)}`, items);
}

async function refreshOwnershipEnvelope(companyNumber) {
  if (!isCompaniesHouseConfigured()) {
    return {
      status: "skipped",
      reason: "companies_house_not_configured",
    };
  }

  try {
    const ownership = await lookupCompanyOwnership(companyNumber);
    if (ownership?.error || !ownership?.summary) {
      return {
        status: "error",
        error: ownership?.message || "ownership_lookup_failed",
      };
    }

    setSetting(`ownership_${companyNumber}`, {
      ...ownership.summary,
      source: "companies_house_api",
    });

    return {
      status: "updated",
      significant_corporate_controllers_count: Number(ownership.summary.significant_corporate_controllers_count || 0),
      non_uk_significant_corporate_controllers_count: Number(ownership.summary.non_uk_significant_corporate_controllers_count || 0),
    };
  } catch (err) {
    return {
      status: "error",
      error: err?.message || "ownership_lookup_failed",
    };
  }
}

async function resolveMonitorName(companyNumber, storedName) {
  if (!isFallbackCompanyName(storedName, companyNumber)) return storedName;
  if (!isCompaniesHouseConfigured()) return pendingCompanyName();

  const lookup = await lookupCompany(companyNumber);
  const name = lookup?.name || lookup?.company_name;
  if (!lookup?.error && name) {
    updateMonitorCheck(companyNumber, { company_name: name, status: lookup.status || "active" });
    return name;
  }
  return pendingCompanyName();
}

function formatMonitorName(storedName, companyNumber) {
  return displayNameForCompanyNumber(companyNumber, storedName);
}

function titleCase(value) {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseCsvRow(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  cells.push(current.trim());
  return cells;
}

function parseClosedWonRowsFromCsv(csvContent) {
  const text = String(csvContent || "").replace(/\r/g, "").trim();
  if (!text) return [];

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const header = parseCsvRow(lines[0]).map((h) => String(h || "").toLowerCase());
  const hasHeader = header.some((h) =>
    h.includes("company")
    || h.includes("reg")
    || h.includes("number")
    || h.includes("entity")
  );

  const numberIdx = hasHeader
    ? header.findIndex((h) =>
      h.includes("company_number")
      || h.includes("company number")
      || h.includes("registration")
      || h.includes("reg number")
      || h.includes("reg_number")
      || h.includes("company no")
      || h.includes("entity number")
    )
    : -1;

  const nameIdx = hasHeader
    ? header.findIndex((h) =>
      h.includes("company_name")
      || h.includes("company name")
      || h === "name"
      || h.includes("entity name")
      || h.includes("legal name")
    )
    : -1;

  const startIdx = hasHeader ? 1 : 0;
  const rows = [];

  for (let i = startIdx; i < lines.length; i += 1) {
    const cells = parseCsvRow(lines[i]);
    if (cells.length === 0) continue;

    let candidateNumber = numberIdx >= 0 ? cells[numberIdx] : null;
    if (!candidateNumber) {
      candidateNumber = cells.find((cell) => !!normalizeCompanyNumber(cell)) || null;
    }

    const normalizedNumber = normalizeCompanyNumber(candidateNumber);
    if (!normalizedNumber) continue;

    const candidateName = nameIdx >= 0
      ? cells[nameIdx]
      : cells.find((cell, idx) => idx !== numberIdx && idx !== -1 && cell && !normalizeCompanyNumber(cell));

    rows.push({
      company_number: normalizedNumber,
      company_name: String(candidateName || "").trim() || null,
    });
  }

  return rows;
}

function parseSuppressionRowsFromCsv(csvContent) {
  const text = String(csvContent || "").replace(/\r/g, "").trim();
  if (!text) return [];
  const isEmailToken = (token) => {
    const value = String(token || "").trim();
    const atIndex = value.indexOf("@");
    if (atIndex <= 0 || atIndex !== value.lastIndexOf("@")) return false;
    const domainPart = value.slice(atIndex + 1);
    const dotIndex = domainPart.lastIndexOf(".");
    return dotIndex > 0 && dotIndex < domainPart.length - 1;
  };

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const rows = [];
  const seen = new Set();

  for (const line of lines) {
    const cells = parseCsvRow(line)
      .map((cell) => String(cell || "").trim())
      .filter(Boolean);
    if (cells.length === 0) continue;

    const tokenCandidates = [...cells];
    for (const cell of cells) {
      if (!cell.includes(",")) continue;
      tokenCandidates.push(...cell.split(",").map((part) => part.trim()).filter(Boolean));
    }

    const tokens = [];
    const tokenSeen = new Set();
    for (const token of tokenCandidates) {
      const normalizedToken = String(token || "").trim();
      if (!normalizedToken || tokenSeen.has(normalizedToken)) continue;
      tokenSeen.add(normalizedToken);
      tokens.push(normalizedToken);
    }

    const emailTokens = tokens.filter((token) => isEmailToken(token));
    const companyNumberTokens = tokens.filter((token) => !!normalizeCompanyNumber(token));
    if (emailTokens.length === 0 && companyNumberTokens.length === 0) continue;

    const textTokens = tokens.filter((token) => {
      if (token.includes(",")) return false;
      if (isEmailToken(token)) return false;
      if (normalizeCompanyNumber(token)) return false;
      return true;
    });
    const companyName = textTokens.join(" ").trim() || null;

    for (const emailToken of emailTokens) {
      const normalizedEmail = emailToken.toLowerCase();
      const key = `email:${normalizedEmail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        type: "email",
        value: emailToken,
        value_normalized: normalizedEmail,
        company_name: textTokens[0] || null,
      });
    }

    for (const companyNumberToken of companyNumberTokens) {
      const normalizedCompanyNumber = normalizeCompanyNumber(companyNumberToken);
      if (!normalizedCompanyNumber) continue;
      const key = `company_number:${normalizedCompanyNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        type: "company_number",
        value: companyNumberToken,
        value_normalized: normalizedCompanyNumber,
        company_name: companyName,
      });
    }
  }

  return rows;
}

function markCompanyClosedWon(companyNumber, note = null) {
  const normalized = normalizeCompanyNumber(companyNumber);
  if (!normalized) return false;

  const companyId = canonicalCompanyId(`ch-${normalized}`);
  const current = getCompanyState(companyId);
  if (current.state === "closed_won") return false;

  setCompanyWorkflowState(
    companyId,
    current.state,
    "closed_won",
    note || "Suppressed via closed-won registry"
  );

  return true;
}

const COMPETITOR_NAME_HINTS = [
  "HSBC",
  "Barclays",
  "NatWest",
  "Lloyds",
  "Worldpay",
  "Stripe",
  "Adyen",
  "Wise",
  "Ebury",
  "Pleo",
  "Concur",
  "Amex",
  "PayPal",
  "Square",
  "Sage",
  "SAP",
];

function inferCompetitorNamesFromText(text) {
  const source = String(text || "");
  if (!source) return [];

  const names = [];
  for (const hint of COMPETITOR_NAME_HINTS) {
    const pattern = new RegExp(`\\b${hint.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(source)) {
      names.push(hint === "Concur" ? "SAP Concur" : hint);
    }
  }
  return Array.from(new Set(names));
}

function enrichAnalysisWithCompetitorSignals(analysis, score) {
  const base = analysis && typeof analysis === "object" ? { ...analysis } : {};
  const merged = [];
  const seen = new Set();

  const pushSignal = (signal) => {
    const name = String(signal?.name || "").trim();
    if (!name) return;

    const product = String(signal?.product || "").trim();
    const key = `${name.toLowerCase()}::${product.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    merged.push({
      name,
      product,
      displacement_angle: signal?.displacement_angle || signal?.notes || "Detected in filing",
      evidence: signal?.evidence || signal?.notes || null,
      snippet: signal?.snippet || null,
      inferred_advantage: signal?.inferred_advantage || null,
      source: signal?.source || "analysis",
    });
  };

  for (const item of (base?.competitors_detected || [])) {
    pushSignal({
      name: item?.name,
      product: item?.product,
      displacement_angle: item?.displacement_angle,
      evidence: item?.evidence,
      snippet: item?.snippet || item?.quote,
      inferred_advantage: item?.inferred_advantage,
      source: item?.source || "analysis",
    });
  }

  for (const item of (score?.competitors || [])) {
    const weakness = String(item?.weakness || "").replace(/_/g, " ");
    pushSignal({
      name: item?.name,
      product: Array.isArray(item?.products) ? item.products.join(", ") : (item?.product || ""),
      displacement_angle: weakness ? `Detected in filing: ${weakness}` : "Detected in filing",
      snippet: item?.snippet || null,
      inferred_advantage: item?.inferred_advantage || null,
      source: "scoring",
    });
  }

  const competitorSnippets = Array.isArray(base?.evidence_snippets?.competitors)
    ? base.evidence_snippets.competitors
    : [];
  for (const snippet of competitorSnippets) {
    const quote = String(snippet?.quote || "");
    const insight = String(snippet?.insight || "");
    const names = inferCompetitorNamesFromText(`${quote} ${insight}`);
    for (const name of names) {
      pushSignal({
        name,
        product: "",
        displacement_angle: insight || "Competitor stack evidence detected",
        evidence: insight || null,
        snippet: quote || null,
        source: "evidence_snippet",
      });
    }
  }

  if (merged.length === 0) {
    const names = inferCompetitorNamesFromText(`${base?.summary || ""} ${(base?.themes || []).map((t) => t?.evidence || "").join(" ")}`);
    for (const name of names) {
      pushSignal({
        name,
        product: "",
        displacement_angle: "Competitor signal inferred from filing narrative",
        source: "analysis_inference",
      });
    }
  }

  if (merged.length > 0) {
    base.competitors_detected = merged;
  }

  return base;
}

function buildMonitorMotionScores(score) {
  if (!score) return [];
  const candidates = score.eligible_motions?.length
    ? score.eligible_motions
    : Object.entries(score.all_motion_scores || {})
      .map(([motion, data]) => ({ motion, ...data }))
      .filter((m) => m.score > 0)
      .sort((a, b) => (b.weighted || b.score) - (a.weighted || a.score));

  return candidates.map((m) => {
    const explanation = m.evidence?.[0]?.text || `${m.motion} fit inferred from accounts filing signals.`;
    return {
      motion: m.motion,
      score: Math.round((m.score || 0) * 100) / 100,
      fit_level: m.fit_level || (m.score >= 0.5 ? "strong" : m.score >= 0.25 ? "medium" : "weak"),
      explanation,
      score_narrative: buildMotionScoreNarrative(score, m, explanation),
      score_breakdown: {
        product_fit: { score: m.score || 0, evidence: m.evidence },
        commercial_value: score.layers?.commercial_value,
        pain_strength: score.layers?.pain_strength,
        urgency: score.layers?.urgency,
        competitor_context: score.layers?.competitor_context,
      },
    };
  });
}

function buildStakeholderAssessment(companyId, company, analysis, score) {
  const activeContacts = getActiveContactsForCompany(companyId);
  if (!analysis?.key_people?.length) {
    return {
      readiness: getOutreachReadiness([]),
      stakeholders: [],
      active_contacts: activeContacts,
      primary_motion: score?.layers?.product_fit?.best_motion || null,
    };
  }

  const scored = scoreAllStakeholders(analysis.key_people, {
    company,
    analysis,
    motion: score?.layers?.product_fit?.best_motion || "FX",
    filingDate: analysis.analysed_at || analysis.scored_at || null,
  });

  return {
    readiness: getOutreachReadiness(scored),
    stakeholders: scored,
    active_contacts: activeContacts,
    primary_motion: score?.layers?.product_fit?.best_motion || "FX",
  };
}

async function runStakeholderReview(companyId) {
  const canonicalId = canonicalCompanyId(companyId);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  let company = COMPANIES.find((c) => c.id === companyId || c.id === canonicalId || c.company_number === companyNumber);
  const monitored = getMonitoredCompany(companyNumber);

  if (!company && monitored) {
    const name = await resolveMonitorName(companyNumber, monitored.company_name);
    company = {
      id: canonicalId,
      name,
      company_number: companyNumber,
      turnover: monitored.latest_turnover,
      employee_count: 0,
      industry: "—",
      segment: guessTurnoverSegment(monitored.latest_turnover),
    };
  }
  if (!company) return null;

  const analysis = await analyseCompany(companyNumber, company.name, company.turnover);
  setSetting(`analysis_${companyNumber}`, analysis);
  const baseScore = monitored ? scoreCompany(companyNumber) : getStoredScore(companyNumber);
  const score = baseScore ? integrateAnalysis(baseScore, analysis) : baseScore;
  const assessment = buildStakeholderAssessment(canonicalId, company, analysis, score);

  return {
    company_id: canonicalId,
    company_number: companyNumber,
    company_name: company.name,
    analysis,
    score,
    ...assessment,
  };
}

function getProfileStakeholders(companyId, analysis, score, company) {
  const manual = getManualList("stakeholders", companyId).map((s, idx) => ({
    ...s,
    source: "manual",
    _manual_index: idx,
  }));
  const assessment = buildStakeholderAssessment(canonicalCompanyId(companyId), company, analysis, score);
  const assessed = assessment.stakeholders.map((s) => ({
    name: s.name,
    role: s.role,
    notes: s.flags?.join("; ") || "",
    linkedin: s.linkedin_search_url,
    email: s.email_guess?.patterns?.[0] || "",
    source: "analysis",
    confidence_level: s.confidence_level,
    final_score: s.final_score,
    buying_role: s.buying_role,
    needs_verification: s.needs_verification,
  }));
  return { stakeholders: [...manual, ...assessed], assessment };
}

function getProfileCompetitors(companyId, analysis, score) {
  const manual = getManualList("competitors", companyId).map((c, idx) => ({
    ...c,
    source: "manual",
    _manual_index: idx,
  }));
  const scored = (score?.competitors || []).map((c) => ({
    name: c.name,
    product: c.products?.join(", ") || "",
    strength: c.stickiness >= 4 ? "strong" : c.stickiness <= 2.5 ? "weak" : "medium",
    notes: c.weakness ? `Detected in filing: ${c.weakness.replace(/_/g, " ")}` : "Detected in filing",
    snippet: c.snippet || null,
    inferred_advantage: c.inferred_advantage || null,
    source: "filing",
  }));
  const analysed = (analysis?.competitors_detected || []).map((c) => ({
    name: c.name,
    product: c.product || "",
    strength: "medium",
    notes: c.displacement_angle || c.evidence || "Detected by analysis",
    snippet: c.snippet || c.quote || null,
    inferred_advantage: c.inferred_advantage || null,
    source: "analysis",
  }));

  const merged = [];
  const seen = new Set();
  for (const item of [...manual, ...scored, ...analysed]) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const product = String(item?.product || "").trim();
    const key = `${name.toLowerCase()}::${product.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

// --- Routes ---

app.get("/api/motions", (_req, res) => {
  res.json({ motions: VALID_MOTIONS });
});

app.get("/api/workflow-states", (_req, res) => {
  res.json({ states: WORKFLOW_STATES, transitions: ALLOWED_TRANSITIONS });
});

app.get("/api/scoring-weights", (_req, res) => {
  res.json({
    segment_weights: getSegmentWeights(),
    propensity_weight: getPropensityWeight(),
    defaults: { segment_weights: DEFAULT_SEGMENT_WEIGHTS, propensity_weight: DEFAULT_PROPENSITY_WEIGHT },
    layers: LAYER_NAMES,
    segments: VALID_SEGMENTS,
  });
});

app.put("/api/scoring-weights", (req, res) => {
  const { segment_weights, propensity_weight } = req.body;

  if (segment_weights) {
    for (const [seg, weights] of Object.entries(segment_weights)) {
      if (!VALID_SEGMENTS.includes(seg)) continue;
      const total = Object.values(weights).reduce((s, v) => s + v, 0);
      if (Math.abs(total - 1) > 0.01) {
        return res.status(400).json({ error: `${seg} weights must sum to 1.0 (got ${total.toFixed(2)})` });
      }
    }
    setSetting("segment_weights", { ...getSegmentWeights(), ...segment_weights });
  }

  if (propensity_weight !== undefined) {
    if (propensity_weight < 0 || propensity_weight > 0.5) {
      return res.status(400).json({ error: "propensity_weight must be between 0 and 0.5" });
    }
    setSetting("propensity_weight", propensity_weight);
  }

  res.json({
    segment_weights: getSegmentWeights(),
    propensity_weight: getPropensityWeight(),
    message: "Scoring weights updated. Rankings will reflect new weights.",
  });
});

app.post("/api/scoring-weights/reset", (_req, res) => {
  setSetting("segment_weights", DEFAULT_SEGMENT_WEIGHTS);
  setSetting("propensity_weight", DEFAULT_PROPENSITY_WEIGHT);
  res.json({
    segment_weights: DEFAULT_SEGMENT_WEIGHTS,
    propensity_weight: DEFAULT_PROPENSITY_WEIGHT,
    message: "Scoring weights reset to defaults.",
  });
});

app.get("/api/exclusions", (_req, res) => {
  const exclusions = getCurrentExclusions();
  res.json({ exclusions, suppressed_states: SUPPRESSED_STATES });
});

app.put("/api/exclusions", (req, res) => {
  const { prohibited_industries, excluded_company_ids, prohibited_sic_codes } = req.body || {};
  const current = getCurrentExclusions();
  const updated = setCurrentExclusions({
    prohibited_industries: prohibited_industries ?? current.prohibited_industries,
    excluded_company_ids: excluded_company_ids ?? current.excluded_company_ids,
    prohibited_sic_codes: prohibited_sic_codes ?? current.prohibited_sic_codes,
  });
  dbSetExclusions(updated);
  res.json({ exclusions: updated });
});

app.get("/api/closed-won/registry", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit || "200"), 10);
  const offset = Number.parseInt(String(req.query.offset || "0"), 10);
  const rows = listClosedWonCompanies(limit, offset);
  const total = getClosedWonRegistryCount();

  res.json({
    total,
    limit: Math.max(1, Math.min(limit || 200, 5000)),
    offset: Math.max(0, offset || 0),
    rows,
  });
});

app.post("/api/closed-won/import", (req, res) => {
  const source = String(req.body?.source || "closed_won_bulk_ingest").trim() || "closed_won_bulk_ingest";
  const dryRun = req.body?.dry_run === true;
  const markExisting = req.body?.mark_existing_closed_won !== false;
  const rowsInput = Array.isArray(req.body?.rows) ? req.body.rows : null;
  const csvContent = typeof req.body?.csv_content === "string" ? req.body.csv_content : "";

  const parsedRows = rowsInput && rowsInput.length > 0
    ? rowsInput
    : parseClosedWonRowsFromCsv(csvContent);

  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    return res.status(400).json({
      error: "Provide either rows[] or csv_content with company registration numbers.",
    });
  }

  const upsertResult = dryRun
    ? {
      received: parsedRows.length,
      stored: parsedRows.filter((row) => !!normalizeCompanyNumber(row?.company_number || row?.companyNumber || row?.number || row)).length,
      skipped_invalid: parsedRows.filter((row) => !normalizeCompanyNumber(row?.company_number || row?.companyNumber || row?.number || row)).length,
      source,
      company_numbers: parsedRows
        .map((row) => normalizeCompanyNumber(row?.company_number || row?.companyNumber || row?.number || row))
        .filter(Boolean),
    }
    : upsertClosedWonCompanies(parsedRows, source);

  let markedClosedWon = 0;
  if (markExisting) {
    for (const companyNumber of upsertResult.company_numbers || []) {
      if (markCompanyClosedWon(companyNumber, "Closed-won registry import")) {
        markedClosedWon += 1;
      }
    }
  }

  res.json({
    dry_run: dryRun,
    source,
    received: upsertResult.received,
    stored: upsertResult.stored,
    skipped_invalid: upsertResult.skipped_invalid,
    marked_closed_won_states: dryRun ? 0 : markedClosedWon,
    total_registry_count: dryRun
      ? getClosedWonRegistryCount()
      : getClosedWonRegistryCount(),
  });
});

app.get("/api/dashboard", (_req, res) => {
  const stats = getMonitorStats();
  const totalCompanies = getShortlistCount(getTurnoverThreshold());

  const pipeline = {};
  for (const s of WORKFLOW_STATES) {
    pipeline[s.id] = { count: 0, label: s.label, color: s.color };
  }
  pipeline.new_candidate.count = totalCompanies;

  const turnoverBuckets = {
    "£500M+": { min: 500_000_000, count: 0 },
    "£100M-£500M": { min: 100_000_000, max: 500_000_000, count: 0 },
    "£50M-£100M": { min: 50_000_000, max: 100_000_000, count: 0 },
    "£25M-£50M": { min: 25_000_000, max: 50_000_000, count: 0 },
    "£15M-£25M": { min: 15_000_000, max: 25_000_000, count: 0 },
  };

  const topCompanies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit: 500 })
    .filter((c) => !isSuppressed(`ch-${c.company_number}`, c.company_number).suppressed);
  const motionSummary = Object.fromEntries(VALID_MOTIONS.map((motion) => [motion, { count: 0, top_score: 0 }]));

  for (const c of topCompanies) {
    const t = c.latest_turnover || 0;
    for (const [, bucket] of Object.entries(turnoverBuckets)) {
      if (t >= bucket.min && (!bucket.max || t < bucket.max)) { bucket.count++; break; }
    }
    const score = getStoredScore(c.company_number);
    const bestMotion = score?.layers?.product_fit?.best_motion;
    if (bestMotion && motionSummary[bestMotion]) {
      motionSummary[bestMotion].count++;
      motionSummary[bestMotion].top_score = Math.max(motionSummary[bestMotion].top_score, score.composite_score || 0);
    }
  }

  const top10 = topCompanies.slice(0, 10).map((c) => ({
    id: `ch-${c.company_number}`,
    company_number: c.company_number,
    name: formatMonitorName(c.company_name, c.company_number),
    turnover: c.latest_turnover,
    segment: guessTurnoverSegment(c.latest_turnover),
    filing_count: c.filing_count || 0,
  }));

  res.json({
    total_companies: totalCompanies,
    total_filings: getFilingCount(),
    total_monitored: getMonitoredCompanyCount(),
    pipeline,
    motion_summary: motionSummary,
    active_prospects: top10,
    turnover_distribution: turnoverBuckets,
    top_companies: top10,
    monitor_stats: stats,
    threshold: getTurnoverThreshold(),
  });
});

const SHORTLIST_TURNOVER_BANDS = {
  all: null,
  "15-25": { min: 15_000_000, max: 25_000_000 },
  "25-50": { min: 25_000_000, max: 50_000_000 },
  "50-100": { min: 50_000_000, max: 100_000_000 },
  "100-500": { min: 100_000_000, max: 500_000_000 },
  "500+": { min: 500_000_000, max: null },
};

const SHORTLIST_SORT_FIELDS = new Set([
  "priority_score",
  "combined_score",
  "turnover",
  "name",
  "industry",
  "segment",
  "company_number",
  "best_motion",
  "growth_trend",
  "workflow_state",
  "filing_count",
  "latest_filing_date",
  "analysis_status",
]);

const SHORTLIST_SORT_ALIASES = {
  score: "combined_score",
  composite_score: "combined_score",
  status: "workflow_state",
  workflow_status: "workflow_state",
  motion: "best_motion",
};

const SHORTLIST_STRING_SORT_FIELDS = new Set([
  "name",
  "industry",
  "segment",
  "company_number",
  "best_motion",
]);

const ANALYSIS_STATUS_SORT_WEIGHT = {
  failed: 0,
  queued: 1,
  none: 2,
  ready: 3,
};

const GROWTH_TREND_SORT_WEIGHT = {
  sharp_decline: 0,
  declining: 1,
  stable: 2,
  growing: 3,
  strong_growth: 4,
  unknown: 5,
};

const WORKFLOW_STATE_SORT_WEIGHT = {
  new_candidate: 0,
  shortlisted: 1,
  selected_for_outreach: 2,
  in_cadence: 3,
  active_opportunity: 4,
  held_for_review: 5,
  revisit_later: 6,
  closed_won: 7,
  closed_lost: 8,
};

function parseShortlistTurnoverBand(rawBand) {
  const normalized = String(rawBand || "all").trim().toLowerCase();
  if (normalized === "all") return "all";
  return Object.prototype.hasOwnProperty.call(SHORTLIST_TURNOVER_BANDS, normalized) ? normalized : "all";
}

function turnoverMatchesBand(turnover, bandKey) {
  const band = SHORTLIST_TURNOVER_BANDS[bandKey] || null;
  if (!band) return true;
  const value = Number(turnover || 0);
  if (value < band.min) return false;
  if (band.max !== null && value >= band.max) return false;
  return true;
}

function parseShortlistSortBy(rawSortBy) {
  const normalized = String(rawSortBy || "combined_score").trim().toLowerCase();
  const aliased = SHORTLIST_SORT_ALIASES[normalized] || normalized;
  return SHORTLIST_SORT_FIELDS.has(aliased) ? aliased : "combined_score";
}

function parseShortlistSortDir(rawSortDir) {
  return String(rawSortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
}

function parseShortlistDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysSinceShortlistDate(value) {
  const parsed = parseShortlistDate(value);
  if (!parsed) return null;
  const delta = Date.now() - parsed.getTime();
  return Math.max(0, Math.floor(delta / 86400000));
}

function deriveShortlistSourceType(source, latestFilingDate) {
  const raw = String(source || "").trim().toLowerCase();
  const filingAgeDays = daysSinceShortlistDate(latestFilingDate);

  if (raw.includes("csv")) return "3";
  if (raw.startsWith("daily:")) return "2";

  if (raw.startsWith("monthly:")) {
    if (filingAgeDays !== null && filingAgeDays > 120) return "1a";
    return "1b";
  }

  if (raw.includes("backfill") || raw.includes("bulk")) return "1a";
  if (raw.includes("scheduled")) return "1b";

  return "unknown";
}

function deriveShortlistSourceFamily(sourceType) {
  if (sourceType === "1a") return "monthly_bulk_backfill";
  if (sourceType === "1b") return "monthly_scheduled";
  if (sourceType === "2") return "twice_weekly_daily";
  if (sourceType === "3") return "mid_market_csv";
  return "unknown";
}

function getStatusSignalSnapshot(companyNumber) {
  const raw = getSetting(`reputation_${companyNumber}`, null);
  if (!raw || typeof raw !== "object") {
    return {
      status_health_band: null,
      status_incident_severity_score: null,
      status_incident_recency_multiplier: null,
      status_recent_incident_age_days: null,
      status_recent_incident_at: null,
      status_recent_open_incident_at: null,
      status_incidents_open: 0,
      status_major_incidents_open: 0,
      status_degraded_components: 0,
    };
  }

  const severityRaw = Number(raw.status_incident_severity_score);
  const recencyRaw = Number(raw.status_incident_recency_multiplier);
  const ageRaw = Number(raw.status_recent_incident_age_days);
  const incidentsOpenRaw = Number(raw.status_incidents_open);
  const majorOpenRaw = Number(raw.status_major_incidents_open);
  const degradedRaw = Number(raw.status_degraded_components);
  const bandRaw = String(raw.status_health_band || "").trim().toLowerCase();
  const statusBand = bandRaw === "critical" || bandRaw === "high"
    ? "high"
    : bandRaw === "degraded" || bandRaw === "medium"
      ? "medium"
      : bandRaw === "stable" || bandRaw === "low"
        ? "low"
        : null;

  return {
    status_health_band: statusBand,
    status_incident_severity_score: Number.isFinite(severityRaw) ? Math.max(0, Math.min(severityRaw, 1)) : null,
    status_incident_recency_multiplier: Number.isFinite(recencyRaw) ? Math.max(0, Math.min(recencyRaw, 1)) : null,
    status_recent_incident_age_days: Number.isFinite(ageRaw) ? Math.max(0, Math.round(ageRaw * 10) / 10) : null,
    status_recent_incident_at: raw.status_recent_incident_at || null,
    status_recent_open_incident_at: raw.status_recent_open_incident_at || null,
    status_incidents_open: Number.isFinite(incidentsOpenRaw) ? Math.max(0, incidentsOpenRaw) : 0,
    status_major_incidents_open: Number.isFinite(majorOpenRaw) ? Math.max(0, majorOpenRaw) : 0,
    status_degraded_components: Number.isFinite(degradedRaw) ? Math.max(0, degradedRaw) : 0,
  };
}

function deriveShortlistFilterReason(companyRow, suppression, analysisStatus, sourceType) {
  if (suppression?.suppressed) return "suppressed_state";
  if (companyRow?.below_threshold === 1) return "below_turnover_threshold";
  if (analysisStatus === "failed") return "analysis_failed";
  if (analysisStatus === "queued") return "analysis_queued";

  if (sourceType === "3") return "source_3_csv";
  if (sourceType === "2") return "source_2_twice_weekly";
  if (sourceType === "1b") return "source_1b_monthly_scheduled";
  if (sourceType === "1a") return "source_1a_bulk_backfill";

  return "eligible";
}

function compareShortlistEntries(a, b, sortBy, sortDir) {
  const direction = sortDir === "asc" ? 1 : -1;

  let primary;
  if (SHORTLIST_STRING_SORT_FIELDS.has(sortBy)) {
    primary = String(a[sortBy] || "").localeCompare(String(b[sortBy] || ""));
  } else if (sortBy === "latest_filing_date") {
    primary = String(a.latest_filing_date || "").localeCompare(String(b.latest_filing_date || ""));
  } else if (sortBy === "analysis_status") {
    primary = (ANALYSIS_STATUS_SORT_WEIGHT[a.analysis_status] ?? 0) - (ANALYSIS_STATUS_SORT_WEIGHT[b.analysis_status] ?? 0);
  } else if (sortBy === "growth_trend") {
    primary = (GROWTH_TREND_SORT_WEIGHT[a.growth_trend] ?? -1) - (GROWTH_TREND_SORT_WEIGHT[b.growth_trend] ?? -1);
  } else if (sortBy === "workflow_state") {
    primary = (WORKFLOW_STATE_SORT_WEIGHT[a.workflow_state] ?? -1) - (WORKFLOW_STATE_SORT_WEIGHT[b.workflow_state] ?? -1);
  } else {
    primary = Number(a[sortBy] || 0) - Number(b[sortBy] || 0);
  }

  if (primary !== 0) {
    return primary * direction;
  }
  if (a.priority_score !== b.priority_score) {
    return Number(b.priority_score || 0) - Number(a.priority_score || 0);
  }
  if (a.combined_score !== b.combined_score) {
    return Number(b.combined_score || 0) - Number(a.combined_score || 0);
  }
  if (a.turnover !== b.turnover) {
    return Number(b.turnover || 0) - Number(a.turnover || 0);
  }
  return String(a.company_number || "").localeCompare(String(b.company_number || ""));
}

function normalizeDistributionKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return key || "unknown";
}

function velocityBandFromScore(value) {
  const score = Number(value || 0);
  if (score >= 0.68) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

function countByBucket(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function percentShare(part, total) {
  if (!total) return 0;
  return Math.round((Number(part || 0) / Number(total)) * 1000) / 10;
}

function averageOf(items, key) {
  if (!items.length) return 0;
  const total = items.reduce((sum, item) => sum + Number(item?.[key] || 0), 0);
  return Math.round((total / items.length) * 1000) / 1000;
}

function summarizeTopWindow(rows, label) {
  return {
    label,
    count: rows.length,
    confidence_distribution: countByBucket(rows, (row) => normalizeDistributionKey(row.confidence_level)),
    volatility_distribution: countByBucket(rows, (row) => normalizeDistributionKey(row.volatility_band)),
    velocity_distribution: countByBucket(rows, (row) => velocityBandFromScore(row.velocity_score)),
    high_volatility_share_pct: percentShare(rows.filter((row) => normalizeDistributionKey(row.volatility_band) === "high").length, rows.length),
  };
}

app.get("/api/unified-shortlist/distribution", (req, res) => {
  const sortBy = parseShortlistSortBy(req.query.sort_by || "priority_score");
  const sortDir = parseShortlistSortDir(req.query.sort_dir);
  const turnoverBand = parseShortlistTurnoverBand(req.query.turnover_band);
  const showSuppressed = String(req.query.show_suppressed || "false") === "true";

  const requestedLimit = Number.parseInt(String(req.query.limit || "5000"), 10);
  const sampleLimit = Number.isFinite(requestedLimit) ? Math.max(100, Math.min(requestedLimit, 10000)) : 5000;

  const requestedTopN = Number.parseInt(String(req.query.top_n || "50"), 10);
  const topN = Number.isFinite(requestedTopN) ? Math.max(10, Math.min(requestedTopN, 500)) : 50;

  const threshold = getTurnoverThreshold();
  const allCompanies = getShortlistCompanies({ min_turnover: threshold, limit: sampleLimit });
  const companies = allCompanies.filter((c) => turnoverMatchesBand(c.latest_turnover, turnoverBand));
  const companyNumbers = companies.map((c) => c.company_number);
  const queueRows = getAnalysisQueueItemsByCompanyNumbers(companyNumbers);

  let suppressedCount = 0;
  const entries = companies
    .map((c) => {
      const ws = getCompanyState(`ch-${c.company_number}`);
      const stored = getOrBuildMonitorScore(c.company_number);
      const supp = isSuppressed(`ch-${c.company_number}`, c.company_number);
      const queue = queueRows[c.company_number] || null;
      const storedAnalysis = getSetting(`analysis_${c.company_number}`, null);
      const analysis_status = deriveAnalysisStatus(queue, storedAnalysis);
      const segment = guessTurnoverSegment(c.latest_turnover);
      const priority = computePriorityBreakdown(c, stored, analysis_status, segment);
      const sourceType = deriveShortlistSourceType(c.source, c.latest_filing_date);
      const sourceFamily = deriveShortlistSourceFamily(sourceType);
      const filterReason = deriveShortlistFilterReason(c, supp, analysis_status, sourceType);

      return {
        company_number: c.company_number,
        combined_score: stored?.composite_score ?? 0,
        priority_score: priority.priority_score,
        confidence_level: priority.confidence_level,
        volatility_band: priority.volatility_band,
        velocity_score: priority.velocity_score,
        turnover: c.latest_turnover,
        best_motion: stored?.layers?.product_fit?.best_motion || null,
        growth_trend: stored?.growth?.trend || null,
        workflow_state: ws.state,
        filing_count: c.filing_count || 0,
        latest_filing_date: c.latest_filing_date,
        analysis_status,
        source_type: sourceType,
        source_family: sourceFamily,
        filter_reason: filterReason,
        suppressed: supp.suppressed,
      };
    })
    .filter((entry) => {
      if (!entry.suppressed) return true;
      suppressedCount++;
      return showSuppressed;
    });

  entries.sort((a, b) => compareShortlistEntries(a, b, sortBy, sortDir));

  const confidenceDistribution = countByBucket(entries, (entry) => normalizeDistributionKey(entry.confidence_level));
  const volatilityDistribution = countByBucket(entries, (entry) => normalizeDistributionKey(entry.volatility_band));
  const velocityDistribution = countByBucket(entries, (entry) => velocityBandFromScore(entry.velocity_score));
  const sourceDistribution = countByBucket(entries, (entry) => normalizeDistributionKey(entry.source_type));
  const filterReasonDistribution = countByBucket(entries, (entry) => normalizeDistributionKey(entry.filter_reason));

  const topWindow = entries.slice(0, topN);
  const topDoubleWindow = entries.slice(0, topN * 2);
  const highVolatilityEntries = entries.filter((entry) => normalizeDistributionKey(entry.volatility_band) === "high");
  const stableEntries = entries.filter((entry) => normalizeDistributionKey(entry.volatility_band) === "stable");

  res.json({
    summary: {
      total: entries.length,
      confidence_distribution: confidenceDistribution,
      volatility_distribution: volatilityDistribution,
      velocity_distribution: velocityDistribution,
      source_distribution: sourceDistribution,
      filter_reason_distribution: filterReasonDistribution,
      top: summarizeTopWindow(topWindow, `top_${topN}`),
      top_double: summarizeTopWindow(topDoubleWindow, `top_${topN * 2}`),
      averages: {
        overall_priority: averageOf(entries, "priority_score"),
        high_volatility_priority: averageOf(highVolatilityEntries, "priority_score"),
        stable_priority: averageOf(stableEntries, "priority_score"),
      },
    },
    meta: {
      threshold,
      sample_limit: sampleLimit,
      turnover_band: turnoverBand,
      sort_by: sortBy,
      sort_dir: sortDir,
      suppressed: suppressedCount,
      included: entries.length,
      show_suppressed: showSuppressed,
      top_n: topN,
      generated_at: new Date().toISOString(),
    },
  });
});

app.get("/api/unified-shortlist", (req, res) => {
  const { limit, offset, show_suppressed } = req.query;
  const pageLimit = parseInt(limit) || 100;
  const pageOffset = parseInt(offset) || 0;
  const sortBy = parseShortlistSortBy(req.query.sort_by);
  const sortDir = parseShortlistSortDir(req.query.sort_dir);
  const turnoverBand = parseShortlistTurnoverBand(req.query.turnover_band);

  const threshold = getTurnoverThreshold();
  const allCompanies = getShortlistCompanies({ min_turnover: threshold });
  const companies = allCompanies.filter((c) => turnoverMatchesBand(c.latest_turnover, turnoverBand));

  const companyNumbers = companies.map((c) => c.company_number);
  const queueRows = getAnalysisQueueItemsByCompanyNumbers(companyNumbers);

  const toQueue = [];
  for (const c of companies.slice(0, 250)) {
    if (isClosedWonCompanyNumber(c.company_number)) continue;
    const queue = queueRows[c.company_number];
    if (queue?.status === "queued" || queue?.status === "processing") continue;
    const storedAnalysis = getSetting(`analysis_${c.company_number}`, null);
    if (storedAnalysis) continue;
    toQueue.push({ company_number: c.company_number, company_name: c.company_name });
  }

  let seededCount = 0;
  if (toQueue.length > 0) {
    seededCount = enqueueCompaniesForAnalysis(toQueue, "shortlist_auto_seed").queued;
    if (seededCount > 0) {
      maybeKickShortlistAutoAnalysis();
    }
  }

  let suppressedCount = 0;

  const entries = companies
    .map((c) => {
      const ws = getCompanyState(`ch-${c.company_number}`);
      const segment = guessTurnoverSegment(c.latest_turnover);
      const stored = getOrBuildMonitorScore(c.company_number);
      const supp = isSuppressed(`ch-${c.company_number}`, c.company_number);
      const queue = queueRows[c.company_number] || null;
      const storedAnalysis = getSetting(`analysis_${c.company_number}`, null);

      const analysis_status = deriveAnalysisStatus(queue, storedAnalysis);
      const priority = computePriorityBreakdown(c, stored, analysis_status, segment);
      const sourceType = deriveShortlistSourceType(c.source, c.latest_filing_date);
      const sourceFamily = deriveShortlistSourceFamily(sourceType);
      const filterReason = deriveShortlistFilterReason(c, supp, analysis_status, sourceType);
      const statusSignals = getStatusSignalSnapshot(c.company_number);

      return {
        id: `ch-${c.company_number}`,
        company_number: c.company_number,
        name: formatMonitorName(c.company_name, c.company_number),
        industry: titleCase(stored?.industries?.[0]),
        turnover: c.latest_turnover,
        employee_count: stored?.employees || 0,
        segment,
        composite_score: stored?.composite_score ?? 0,
        combined_score: stored?.composite_score ?? 0,
        best_motion: stored?.layers?.product_fit?.best_motion || null,
        product_fit_score: stored?.layers?.product_fit?.score || null,
        growth_trend: stored?.growth?.trend || null,
        filing_count: c.filing_count || 0,
        latest_filing_date: c.latest_filing_date,
        workflow_state: ws.state,
        below_threshold: c.below_threshold === 1,
        scored: !!stored,
        source: c.source,
        source_type: sourceType,
        source_family: sourceFamily,
        filter_reason: filterReason,
        suppressed: supp.suppressed,
        suppression_reason: supp.reason || null,
        analysis_status,
        priority_score: priority.priority_score,
        fit_score: priority.fit_score,
        propensity_score: priority.propensity_score,
        velocity_score: priority.velocity_score,
        confidence_level: priority.confidence_level,
        confidence_plus_minus: priority.confidence_plus_minus,
        score_interval_low: priority.score_interval_low,
        score_interval_high: priority.score_interval_high,
        volatility_band: priority.volatility_band,
        priority_reason: priority.reason,
        status_health_band: statusSignals.status_health_band,
        status_incident_severity_score: statusSignals.status_incident_severity_score,
        status_incident_recency_multiplier: statusSignals.status_incident_recency_multiplier,
        status_recent_incident_age_days: statusSignals.status_recent_incident_age_days,
        status_incidents_open: statusSignals.status_incidents_open,
        status_major_incidents_open: statusSignals.status_major_incidents_open,
        status_degraded_components: statusSignals.status_degraded_components,
      };
    })
    .filter((entry) => {
      if (!entry.suppressed) return true;
      suppressedCount++;
      return show_suppressed === "true";
    });

  entries.sort((a, b) => compareShortlistEntries(a, b, sortBy, sortDir));

  const pagedEntries = entries
    .slice(pageOffset, pageOffset + pageLimit)
    .map((entry, idx) => ({
      ...entry,
      rank: pageOffset + idx + 1,
    }));

  const analysisMeta = {
    queued: pagedEntries.filter((e) => e.analysis_status === "queued").length,
    ready: pagedEntries.filter((e) => e.analysis_status === "ready").length,
    failed: pagedEntries.filter((e) => e.analysis_status === "failed").length,
  };

  res.json({
    companies: pagedEntries,
    meta: {
      total: entries.length,
      showing: pagedEntries.length,
      limit: pageLimit,
      offset: pageOffset,
      threshold,
      turnover_band: turnoverBand,
      sort_by: sortBy,
      sort_dir: sortDir,
      scored_count: pagedEntries.filter((e) => e.scored).length,
      excluded: 0,
      suppressed: suppressedCount,
      analysis: analysisMeta,
      queue_totals: getAnalysisQueueCounts(),
      analysis_seeded: seededCount,
    },
  });
});

app.get("/api/shortlist", (req, res) => {
  const { product_motion, state_filter, show_suppressed } = req.query;
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  const motionEligible = COMPANIES.filter(
    (c) => c.motions.includes(product_motion) && c.product_fit[product_motion]?.eligible
  );

  let excludedCount = 0;
  let suppressedCount = 0;
  const active = [];

  for (const c of motionEligible) {
    const excl = isExcluded(c);
    if (excl.excluded) { excludedCount++; continue; }
    const supp = isSuppressed(c.id, c.company_number);
    if (supp.suppressed) { suppressedCount++; if (show_suppressed !== "true") continue; }
    active.push(c);
  }

  let filtered = active;
  if (state_filter && VALID_STATE_IDS.includes(state_filter)) {
    filtered = active.filter((c) => getCompanyState(c.id).state === state_filter);
  }

  const companies = filtered
    .map((c) => {
      const fit = c.product_fit[product_motion];
      const layers = fit.layers || {};
      const compositeScore = computeCompositeScore(layers);
      const ws = getCompanyState(c.id);
      const supp = isSuppressed(c.id, c.company_number);
      return {
        id: c.id,
        name: c.name,
        industry: c.industry,
        turnover: c.turnover,
        score: compositeScore,
        rank: 0,
        product_motion,
        fit_level: fit.fit_level,
        product_fit: fit,
        explanation: fit.explanation,
        workflow_state: ws.state,
        score_breakdown: buildScoreBreakdown(layers),
        suppressed: supp.suppressed,
        suppression_reason: supp.reason || null,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((c, idx) => ({ ...c, rank: idx + 1 }));

  res.json({
    companies,
    meta: {
      total_eligible: motionEligible.length,
      excluded: excludedCount,
      suppressed: suppressedCount,
      showing: companies.length,
    },
  });
});

app.get("/api/company/:id", async (req, res) => {
  const { id } = req.params;
  const { product_motion } = req.query;

  const profileId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(profileId);
  const COMPANIES = loadCompanies();
  let company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);

  if (!company) {
    const monitored = getMonitoredCompany(companyNumber);
    if (monitored) {
      const allFilings = getFilingsForCompany(companyNumber, 500);
      const filingsLast24Months = allFilings.filter((f) => isDateWithinLastMonths(f.filing_date, 24));
      const filingsForResponse = filingsLast24Months.length > 0 ? filingsLast24Months : allFilings;
      const ws = getCompanyState(profileId);
      const segment = guessTurnoverSegment(monitored.latest_turnover);
      const chLink = `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`;
      const score = getStoredScore(companyNumber) || (allFilings.some((f) => f.raw_data) ? scoreCompany(companyNumber) : null);
      const rawAnalysis = getSetting(`analysis_${companyNumber}`, null);
      const analysis = enrichAnalysisWithCompetitorSignals(rawAnalysis, score);
      const detailQueueRows = getAnalysisQueueItemsByCompanyNumbers([companyNumber]);
      const detailQueue = detailQueueRows[companyNumber] || null;
      const analysisStatus = deriveAnalysisStatus(detailQueue, rawAnalysis);
      let chargeSummary = getCompanyChargeSummary(companyNumber, null);
      if (!chargeSummary && isCompaniesHouseConfigured()) {
        const charges = await lookupCompanyCharges(companyNumber);
        if (!charges?.error && charges?.summary) {
          chargeSummary = charges.summary;
          upsertCompanyChargeSummary(companyNumber, chargeSummary, "companies_house_api");
        }
      }
      if (!rawAnalysis && !isClosedWonCompanyNumber(companyNumber)) {
        enqueueCompanyForAnalysis({ company_number: companyNumber, company_name: monitored.company_name }, "detail_view_auto_seed");
        maybeKickShortlistAutoAnalysis(2);
      }
      const displayName = await resolveMonitorName(companyNumber, monitored.company_name);
      const monitorCompany = {
        id: profileId,
        name: displayName,
        company_number: companyNumber,
        turnover: monitored.latest_turnover,
        industry: titleCase(score?.industries?.[0]),
      };
      const reputationSignals = getStatusSignalSnapshot(companyNumber);
      const { stakeholders, assessment } = getProfileStakeholders(profileId, analysis, score, monitorCompany);
      const competitors = getProfileCompetitors(profileId, analysis, score);
      const cadenceHistory = getCadenceLog(profileId);
      const ownershipStructure = getSetting(`ownership_${companyNumber}`, null);
      const sicCodes = getStoredSicCodes(companyNumber);
      const baseScore = score?.composite_score ?? (monitored.latest_turnover ? Math.round((Math.min(monitored.latest_turnover / 500_000_000, 1) * 0.7 + 0.3) * 100) / 100 : 0);

      return res.json({
        company: {
          id: profileId,
          company_number: companyNumber,
          name: displayName,
          industry: monitorCompany.industry,
          sic_codes: sicCodes,
          turnover: monitored.latest_turnover,
          employee_count: score?.employees || 0,
          segment,
          latest_annual_report_url: `${chLink}/filing-history`,
          companies_house_url: chLink,
          combined_score: baseScore,
          base_score: score?.base_score || score?.composite_score || baseScore,
          best_motion: score?.layers?.product_fit?.best_motion || null,
          stakeholder_priority: score?.stakeholder_priority || null,
          stakeholder_assessment: assessment,
          workflow_state: ws.state,
          workflow_history: ws.history || [],
          below_threshold: monitored.below_threshold === 1,
          source: monitored.source,
          latest_filing_date: filingsForResponse[0]?.filing_date || null,
          filings: filingsForResponse.slice(0, 120).map((f) => ({
            date: f.filing_date,
            turnover: f.turnover,
            balance_sheet_date: f.balance_sheet_date,
            description: f.description,
            source: f.source,
            has_content: !!f.raw_data,
          })),
          latest_filing_text: filingsForResponse.find((f) => f.raw_data)?.raw_data || allFilings.find((f) => f.raw_data)?.raw_data || null,
          filing_count: filingsForResponse.length,
          filing_count_24m: filingsLast24Months.length,
          filing_count_total: allFilings.length,
          charge_summary: chargeSummary,
          notes: getSetting(`notes_${profileId}`, getSetting(`notes_${id}`, "")),
          analysis,
          analysis_status: analysisStatus,
          analysis_queue_status: detailQueue?.status || null,
          reputation_signals: reputationSignals,
          ownership_structure: ownershipStructure,
          competitors,
          stakeholders,
          cadence_history: cadenceHistory,
          all_motion_scores: buildMonitorMotionScores(score),
          propensity: {
            score: assessment.readiness?.ready ? 0.55 : 0.35,
            warmth: assessment.readiness?.ready ? "warm" : "cold",
            signals: [
              `${filingsLast24Months.length} filing${filingsLast24Months.length === 1 ? "" : "s"} in last 24 months (${allFilings.length} total stored)`,
              ...(score?.stakeholder_priority ? [`Stakeholder readiness boost: +${Math.round(score.stakeholder_priority.boost * 100)} pts`] : []),
              assessment.readiness?.reason || "Stakeholder research pending",
            ],
          },
        },
      });
    }
    return res.status(404).json({ error: "Company not found" });
  }

  const ws = getCompanyState(id);
  const profile = computeCompanyProfile(company);
  const rawAnalysis = getSetting(`analysis_${company.company_number}`, null);
  const storedScore = getStoredScore(company.company_number) || scoreCompany(company.company_number);
  const reputationSignals = getStatusSignalSnapshot(company.company_number);
  const analysis = enrichAnalysisWithCompetitorSignals(rawAnalysis, storedScore);
  const competitors = getProfileCompetitors(company.id, analysis, storedScore);
  const ownershipStructure = getSetting(`ownership_${company.company_number}`, null);
  const sicCodes = getStoredSicCodes(company.company_number);
  const analysisStatus = analysis ? "ready" : "none";

  if (product_motion && VALID_MOTIONS.includes(product_motion)) {
    const fit = company.product_fit[product_motion];
    if (!fit || !fit.eligible) {
      return res.status(403).json({ error: "Company does not meet current shortlist criteria" });
    }
    const layers = fit.layers || {};
    const compositeScore = computeCompositeScore(layers);
    res.json({
      company: {
        id: company.id,
        name: company.name,
        company_number: company.company_number,
        industry: company.industry,
        sic_codes: sicCodes,
        turnover: company.turnover,
        employee_count: company.employee_count,
        latest_annual_report_url: company.latest_annual_report_url,
        product_fit: fit,
        score_breakdown: buildScoreBreakdown(layers),
        final_score: compositeScore,
        explanation: fit.explanation,
        workflow_state: ws.state,
        workflow_history: ws.history || [],
        competitors,
        stakeholders: company.stakeholders || [],
        cadence_history: company.cadence_history || [],
        notes: getSetting(`notes_${company.id}`, ""),
        analysis,
        analysis_status: analysisStatus,
        reputation_signals: reputationSignals,
        ownership_structure: ownershipStructure,
        all_motion_scores: profile.motion_scores,
        combined_score: profile.combined_score,
        base_score: profile.base_score,
        segment: profile.segment,
        segment_weights: profile.weights_used,
        propensity: profile.propensity,
        merchant_spend: profile.merchant_spend,
      },
    });
  } else {
    res.json({
      company: {
        id: company.id,
        name: company.name,
        company_number: company.company_number,
        industry: company.industry,
        sic_codes: sicCodes,
        turnover: company.turnover,
        employee_count: company.employee_count,
        latest_annual_report_url: company.latest_annual_report_url,
        combined_score: profile.combined_score,
        base_score: profile.base_score,
        segment: profile.segment,
        segment_weights: profile.weights_used,
        propensity: profile.propensity,
        merchant_spend: profile.merchant_spend,
        best_motion: profile.best_motion,
        all_motion_scores: profile.motion_scores,
        workflow_state: ws.state,
        workflow_history: ws.history || [],
        competitors,
        stakeholders: company.stakeholders || [],
        cadence_history: company.cadence_history || [],
        notes: getSetting(`notes_${company.id}`, ""),
        analysis,
        analysis_status: analysisStatus,
        reputation_signals: reputationSignals,
        ownership_structure: ownershipStructure,
      },
    });
  }
});

app.patch("/api/company/:id/state", (req, res) => {
  const { id } = req.params;
  const { new_state, note } = req.body;

  if (!new_state || !VALID_STATE_IDS.includes(new_state)) {
    return res.status(400).json({ error: "Missing or invalid new_state", valid_states: VALID_STATE_IDS });
  }

  const canonicalId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);
  if (!company && !monitored) {
    return res.status(404).json({ error: "Company not found" });
  }

  const stateId = company ? company.id : canonicalId;
  const current = getCompanyState(stateId);
  const allowed = ALLOWED_TRANSITIONS[current.state] || [];
  if (!allowed.includes(new_state)) {
    return res.status(422).json({
      error: `Cannot transition from "${current.state}" to "${new_state}"`,
      allowed_transitions: allowed,
    });
  }

  setCompanyWorkflowState(stateId, current.state, new_state, note || null);
  const updated = getCompanyState(stateId);

  res.json({
    company_id: stateId,
    previous_state: current.state,
    new_state,
    allowed_transitions: ALLOWED_TRANSITIONS[new_state],
    history: updated.history,
  });
});

// --- Weekly Reports ---

function getWeekLabel(date) {
  const d = new Date(date);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay() + 1);
  return start.toISOString().slice(0, 10);
}

function getHistoricBackfillCutoffPeriod(now = new Date()) {
  const cutoff = new Date(now.getFullYear(), now.getMonth() - 23, 1);
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;
}

async function buildMonitorReportEntries(topN = 20) {
  const monitoredCompanies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit: topN * 3 });
  const entries = [];

  for (const company of monitoredCompanies) {
    const companyId = `ch-${company.company_number}`;
    const ws = getCompanyState(companyId);
    if (isClosedWonCompanyNumber(company.company_number)) continue;
    if (["closed_won", "closed_lost"].includes(ws.state)) continue;

    const analysis = getSetting(`analysis_${company.company_number}`, null) || await analyseCompany(company.company_number, formatMonitorName(company.company_name, company.company_number), company.latest_turnover);
    setSetting(`analysis_${company.company_number}`, analysis);

    const baseScore = scoreCompany(company.company_number);
    const score = baseScore ? integrateAnalysis(baseScore, analysis) : getStoredScore(company.company_number);
    const motionScores = buildMonitorMotionScores(score);
    const bestMotion = motionScores[0];
    if (!bestMotion) continue;

    entries.push({
      company_id: companyId,
      company_number: company.company_number,
      name: formatMonitorName(company.company_name, company.company_number),
      industry: titleCase(score?.industries?.[0]),
      turnover: company.latest_turnover,
      best_motion: bestMotion.motion,
      score: score?.composite_score || bestMotion.score || 0,
      fit_level: bestMotion.fit_level,
      explanation: bestMotion.explanation,
      workflow_state_at_generation: ws.state,
      eligible_motions: motionScores.map((m) => m.motion),
      stakeholder_priority: score?.stakeholder_priority || null,
      profile_ready: true,
    });
  }

  return entries;
}

function generateLegacyReportSnapshot(COMPANIES) {
  const entries = [];
  for (const company of COMPANIES) {
    if (isClosedWonCompanyNumber(company.company_number)) continue;
    const ws = getCompanyState(company.id);
    if (["closed_won", "closed_lost"].includes(ws.state)) continue;

    const bestMotion = company.motions.reduce((best, motion) => {
      const fit = company.product_fit[motion];
      if (!fit?.eligible) return best;
      const score = computeCompositeScore(fit.layers || {});
      return !best || score > best.score
        ? { motion, score, fit_level: fit.fit_level, explanation: fit.explanation }
        : best;
    }, null);

    if (bestMotion) {
      entries.push({
        company_id: company.id,
        name: company.name,
        industry: company.industry,
        turnover: company.turnover,
        best_motion: bestMotion.motion,
        score: bestMotion.score,
        fit_level: bestMotion.fit_level,
        explanation: bestMotion.explanation,
        workflow_state_at_generation: ws.state,
        eligible_motions: company.motions.filter((m) => company.product_fit[m]?.eligible),
      });
    }
  }

  return entries;
}

async function generateReportSnapshot(COMPANIES, topN = 20) {
  const entries = [
    ...await buildMonitorReportEntries(topN),
    ...generateLegacyReportSnapshot(COMPANIES),
  ];

  const seen = new Set();
  const deduped = entries.filter((entry) => {
    if (seen.has(entry.company_id)) return false;
    seen.add(entry.company_id);
    return true;
  });

  deduped.sort((a, b) => b.score - a.score);
  return deduped.slice(0, topN);
}

app.get("/api/reports/schedule", (_req, res) => {
  const nextRun = getNextSaturdayEvening();
  res.json({
    schedule: "Saturday evenings at 18:00",
    timezone: UK_TIMEZONE,
    next_generation: nextRun.toISOString(),
    note: "Report will be ready for Sunday review before Monday outreach.",
  });
});

app.get("/api/reports", (_req, res) => {
  const rows = listReports();
  const summary = rows.map((r) => {
    const report = dbGetReport(r.id);
    return {
      id: r.id,
      week_label: r.week_label,
      generated_at: r.generated_at,
      company_count: report?.companies?.length || 0,
      top_company: report?.companies?.[0]?.name || null,
      top_score: report?.companies?.[0]?.score || null,
    };
  });
  res.json({ reports: summary });
});

app.get("/api/reports/:id", (req, res) => {
  const { id } = req.params;
  const report = dbGetReport(id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }

  const companiesWithCurrentState = report.companies.map((entry) => {
    const ws = getCompanyState(entry.company_id);
    return {
      ...entry,
      current_workflow_state: ws.state,
      state_changed: entry.workflow_state_at_generation !== ws.state,
    };
  });

  res.json({
    report: {
      ...report,
      companies: companiesWithCurrentState,
    },
  });
});

app.post("/api/reports/generate", async (_req, res) => {
  const COMPANIES = loadCompanies();
  const now = new Date();
  const weekLabel = getWeekLabel(now);

  const existing = getReportByWeek(weekLabel);
  if (existing) {
    return res.status(409).json({
      error: "Report already exists for this week",
      report_id: existing.id,
      week_label: weekLabel,
    });
  }

  pruneHistoricMonthlyFilingsBefore(getHistoricBackfillCutoffPeriod(now));
  const snapshot = await generateReportSnapshot(COMPANIES);
  const report = {
    id: `report-${weekLabel}`,
    week_label: weekLabel,
    generated_at: now.toISOString(),
    companies: snapshot,
  };

  dbSaveReport(report);

  res.status(201).json({ report_id: report.id, week_label: weekLabel, company_count: snapshot.length });
});

// --- Search and Add Companies ---

app.get("/api/search", (req, res) => {
  const { q, industry, segment, min_turnover, max_turnover } = req.query;
  const COMPANIES = loadCompanies();
  let results = COMPANIES;

  if (q) {
    const lower = q.toLowerCase();
    results = results.filter(
      (c) => c.name.toLowerCase().includes(lower) || c.industry.toLowerCase().includes(lower) || c.id.toLowerCase().includes(lower)
    );
  }
  if (industry) {
    results = results.filter((c) => c.industry.toLowerCase().includes(industry.toLowerCase()));
  }
  if (segment) {
    results = results.filter((c) => c.segment === segment);
  }
  if (min_turnover) {
    results = results.filter((c) => c.turnover >= Number(min_turnover));
  }
  if (max_turnover) {
    results = results.filter((c) => c.turnover <= Number(max_turnover));
  }

  const mapped = results.map((c) => {
    const profile = computeCompanyProfile(c);
    const ws = getCompanyState(c.id);
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      segment: c.segment,
      turnover: c.turnover,
      employee_count: c.employee_count,
      combined_score: profile.combined_score,
      motion_count: profile.eligible_motion_count,
      workflow_state: ws.state,
    };
  });

  res.json({ results: mapped, total: mapped.length });
});

app.post("/api/companies", (req, res) => {
  const { name, company_number, industry, segment, turnover, employee_count, motions, product_fit } = req.body;

  if (!name || !industry) {
    return res.status(400).json({ error: "name and industry are required" });
  }

  const COMPANIES = loadCompanies();
  const id = `c${Date.now()}`;
  const newCompany = {
    id,
    name,
    company_number: company_number || "",
    industry,
    segment: segment || "Mid-Market",
    turnover: turnover || 0,
    employee_count: employee_count || 0,
    latest_annual_report_url: "",
    motions: motions || [],
    product_fit: product_fit || {},
    competitors: [],
    stakeholders: [],
    cadence_history: [],
    response_propensity: { score: 0.5, warmth: "cool", signals: ["Newly added — no engagement data yet"] },
  };

  COMPANIES.push(newCompany);
  saveCompanies(COMPANIES);

  res.status(201).json({ company: newCompany });
});

app.get("/api/industries", (_req, res) => {
  const COMPANIES = loadCompanies();
  const industries = [...new Set(COMPANIES.map((c) => c.industry))].sort();
  res.json({ industries });
});

// --- Companies House Integration ---

app.get("/api/companies-house/status", (_req, res) => {
  res.json({
    configured: isCompaniesHouseConfigured(),
    bulk_data: getBulkDownloadInfo(),
  });
});

app.get("/api/companies-house/lookup/:number", async (req, res) => {
  const { number } = req.params;
  try {
    const includeCharges = String(req.query.include_charges || "true").toLowerCase() !== "false";
    const includeOwnership = String(req.query.include_ownership || "true").toLowerCase() !== "false";
    const data = await lookupCompany(number, {
      include_charges: includeCharges,
      include_ownership: includeOwnership,
    });
    if (data.error) return res.status(data.status || 500).json(data);
    if (data?.charge_summary) {
      upsertCompanyChargeSummary(data.company_number, data.charge_summary, "companies_house_api");
    }
    if (Array.isArray(data?.sic_codes) && data?.company_number) {
      setStoredSicCodes(data.company_number, data.sic_codes);
    }
    if (data?.ownership_summary) {
      setSetting(`ownership_${data.company_number}`, {
        ...data.ownership_summary,
        source: "companies_house_api",
      });
    }
    res.json({ company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/import/csv", (req, res) => {
  const { csv_content, filename } = req.body;
  if (!csv_content) return res.status(400).json({ error: "csv_content is required" });

  const companyNumbers = parseCompanyNumbersCSV(csv_content);
  if (companyNumbers.length === 0) {
    return res.status(400).json({ error: "No valid company numbers found in CSV" });
  }

  const jobId = `csv-${Date.now()}`;
  createImportJob(jobId, "csv", companyNumbers.length, { filename: filename || "upload.csv" });

  processCSVImport(jobId, companyNumbers);

  res.status(202).json({
    job_id: jobId,
    company_numbers_found: companyNumbers.length,
    status: "processing",
    message: `Found ${companyNumbers.length} company numbers. Processing in background.`,
  });
});

const SOURCE3_HARD_NON_TRADING_STATUS_PATTERNS = [
  /dissolved/i,
  /liquidation/i,
  /administration/i,
  /receivership/i,
  /struck\s*off/i,
  /insolven/i,
];

const SOURCE3_SOFT_NON_TRADING_STATUS_PATTERNS = [
  /dormant/i,
  /non[-\s]?trading/i,
  /inactive/i,
];

const SOURCE3_HOLDING_NAME_PATTERNS = [
  /\bholdings?\b/i,
  /\binvestments?\b/i,
  /\bnominees?\b/i,
  /\btrustees?\b/i,
  /\bspv\b/i,
  /special\s+purpose/i,
  /\btreasury\b/i,
];

const SOURCE3_HOLDING_SIC_CODES = new Set([
  "64201",
  "64202",
  "64203",
  "64204",
  "64205",
  "64209",
  "64301",
  "64303",
  "64304",
  "64305",
  "64306",
]);

const SOURCE3_STALE_MONTHS_THRESHOLD = 24;

function parseDateSafe(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthsSinceDate(dateValue) {
  const parsed = parseDateSafe(dateValue);
  if (!parsed) return null;
  const now = new Date();
  const monthDelta = (now.getFullYear() - parsed.getFullYear()) * 12 + (now.getMonth() - parsed.getMonth());
  return Math.max(0, monthDelta);
}

function parseSource3NumericHint(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSource3LatestAccountsDate(chData) {
  const fromAccounts = parseDateSafe(chData?.accounts?.last_accounts_made_up_to);
  if (fromAccounts) return fromAccounts;

  const recentFilings = Array.isArray(chData?.recent_filings) ? chData.recent_filings : [];
  for (const filing of recentFilings) {
    const parsed = parseDateSafe(filing?.date);
    if (parsed) return parsed;
  }

  return null;
}

function normalizeSource3Assessment(assessment, overrides = {}) {
  const merged = {
    category: "operating",
    confidence_tier: "low",
    confidence_score: 0.2,
    decision: "include",
    reasons: [],
    ...assessment,
    ...overrides,
  };

  return {
    ...merged,
    confidence_score: Math.max(0, Math.min(Number(merged.confidence_score || 0), 0.99)),
    reasons: Array.isArray(merged.reasons) ? merged.reasons.filter(Boolean) : [],
  };
}

function classifySource3Entity(chData = {}) {
  const status = String(chData?.status || "").toLowerCase();
  const companyType = String(chData?.type || "").toLowerCase();
  const name = String(chData?.name || "");
  const lowerName = name.toLowerCase();
  const sicCodes = Array.isArray(chData?.sic_codes)
    ? chData.sic_codes.map((code) => String(code || "").trim())
    : [];
  const recentFilings = Array.isArray(chData?.recent_filings) ? chData.recent_filings : [];
  const recentFilingText = recentFilings
    .map((filing) => String(filing?.description || ""))
    .join(" ")
    .toLowerCase();
  const turnoverHint = parseSource3NumericHint(chData?.turnover_hint);
  const employeeHint = parseSource3NumericHint(chData?.employee_hint);
  const hasZeroTurnover = turnoverHint !== null && turnoverHint <= 0;
  const hasZeroEmployees = employeeHint !== null && employeeHint <= 0;
  const hasDormantFilingSignal = /dormant|non[-\s]?trading/.test(recentFilingText);
  const hasStrategicReportSignal = /strategic\s+report|accounts-with-accounts-type-full|group-accounts/.test(recentFilingText);

  if (SOURCE3_HARD_NON_TRADING_STATUS_PATTERNS.some((pattern) => pattern.test(status))) {
    return normalizeSource3Assessment({
      category: "non_trading",
      confidence_tier: "high",
      confidence_score: 0.95,
      decision: "auto_filter",
      reasons: [`Status indicates non-trading state (${status || "unknown"})`],
    });
  }

  if (SOURCE3_SOFT_NON_TRADING_STATUS_PATTERNS.some((pattern) => pattern.test(status))) {
    return normalizeSource3Assessment({
      category: "non_trading",
      confidence_tier: "high",
      confidence_score: 0.9,
      decision: "auto_filter",
      reasons: [`Status indicates likely non-trading state (${status || "unknown"})`],
    });
  }

  if (hasDormantFilingSignal) {
    return normalizeSource3Assessment({
      category: "non_trading",
      confidence_tier: "high",
      confidence_score: 0.92,
      decision: "auto_filter",
      reasons: ["Recent filing descriptions indicate dormant/non-trading accounts"],
    });
  }

  const configuredSicMatches = getSicExclusionMatch(null, sicCodes);
  if (configuredSicMatches.length > 0) {
    return normalizeSource3Assessment({
      category: "excluded_sic",
      confidence_tier: "high",
      confidence_score: 0.98,
      decision: "auto_filter",
      reasons: [`SIC excluded by policy (${configuredSicMatches.join(", ")})`],
    });
  }

  const holdingNameMatches = SOURCE3_HOLDING_NAME_PATTERNS.filter((pattern) => pattern.test(lowerName));
  const hasHoldingSic = sicCodes.some((code) => SOURCE3_HOLDING_SIC_CODES.has(code));

  let holdingSignal = 0;
  const holdingReasons = [];

  if (hasHoldingSic) {
    holdingSignal += 0.72;
    holdingReasons.push("SIC profile maps to holding/investment activity");
  }

  if (holdingNameMatches.length > 0) {
    holdingSignal += Math.min(0.5, holdingNameMatches.length * 0.22);
    holdingReasons.push("Company name contains holding/SPV markers");
  }

  if (/\bholding\b|\bspv\b/.test(companyType)) {
    holdingSignal += 0.2;
    holdingReasons.push("Company type suggests a holding/SPV structure");
  }

  if (hasZeroTurnover && hasZeroEmployees) {
    holdingSignal += 0.22;
    holdingReasons.push("Source record shows zero turnover and zero employees");
  }

  if (hasStrategicReportSignal) {
    holdingSignal -= 0.12;
    holdingReasons.push("Recent filing profile includes strategic/full accounts signals");
  }

  const latestAccountsDate = getSource3LatestAccountsDate(chData);
  const monthsSinceAccounts = latestAccountsDate ? monthsSinceDate(latestAccountsDate) : null;
  const highConfidenceHoldingBundle = hasHoldingSic
    && holdingNameMatches.length > 0
    && hasZeroTurnover
    && hasZeroEmployees
    && !hasStrategicReportSignal;

  if (highConfidenceHoldingBundle) {
    return normalizeSource3Assessment({
      category: "holding_spv",
      confidence_tier: "high",
      confidence_score: Math.max(holdingSignal, 0.9),
      decision: "auto_filter",
      reasons: holdingReasons,
    });
  }

  if (holdingSignal >= 0.45) {
    return normalizeSource3Assessment({
      category: "holding_spv",
      confidence_tier: "medium",
      confidence_score: holdingSignal,
      decision: "include_warn",
      reasons: holdingReasons,
    });
  }

  if (monthsSinceAccounts !== null && monthsSinceAccounts >= SOURCE3_STALE_MONTHS_THRESHOLD) {
    return normalizeSource3Assessment({
      category: "stale",
      confidence_tier: "medium",
      confidence_score: 0.55,
      decision: "include_warn",
      reasons: [`No recent filing signal (${monthsSinceAccounts} months since last accounts date)`],
    });
  }

  return normalizeSource3Assessment({
    category: "operating",
    confidence_tier: "low",
    confidence_score: 0.2,
    decision: "include",
    reasons: ["No high-confidence exclusion signal detected"],
  });
}

function source3CategoryLabel(category) {
  if (category === "non_trading") return "non-trading";
  if (category === "holding_spv") return "holding/SPV";
  if (category === "excluded_sic") return "policy SIC exclusion";
  if (category === "stale") return "stale/no recent filing";
  return "operating";
}

function formatSource3AutoFilterDetail(assessment) {
  const label = source3CategoryLabel(assessment.category);
  const reason = assessment.reasons?.[0] || "high-confidence exclusion signal";
  return `Source 3 auto-filtered (${label}, high confidence): ${reason}`;
}

function formatSource3IncludeDetail(segment, assessment) {
  const label = source3CategoryLabel(assessment.category);
  if (assessment.decision === "include_warn") {
    return `Added as ${segment} (included with warning: ${label}, medium confidence)`;
  }
  return `Added as ${segment} (fail-open include: low confidence exclusion signals)`;
}

function buildSource3ImportedCompany(companyNumber, chData, assessment, options = {}) {
  const importedAt = new Date().toISOString();
  const normalizedAssessment = normalizeSource3Assessment(assessment, {
    evaluated_at: importedAt,
    override: !!options.override,
    override_reason: options.overrideReason || null,
  });

  return {
    id: `ch-${companyNumber}`,
    name: displayNameForCompanyNumber(companyNumber, chData.name),
    company_number: companyNumber,
    industry: chData.industry_hint || mapSICToIndustry(chData.sic_codes),
    segment: guessTurnoverSegment(chData.turnover_hint),
    turnover: chData.turnover_hint || 0,
    employee_count: chData.employee_hint || 0,
    latest_annual_report_url: `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}/filing-history`,
    motions: [],
    product_fit: {},
    competitors: [],
    stakeholders: [],
    cadence_history: [],
    response_propensity: { score: 0.3, warmth: "cold", signals: ["Imported from CSV - no engagement data"] },
    source: options.source || chData.source,
    imported_at: importedAt,
    source3_assessment: normalizedAssessment,
    source3_warning: normalizedAssessment.decision === "include_warn",
  };
}

app.post("/api/import/source3/override", async (req, res) => {
  const requestedNumber = normalizeCompanyNumber(req.body?.company_number);
  if (!requestedNumber) {
    return res.status(400).json({ error: "company_number is required" });
  }

  if (isClosedWonCompanyNumber(requestedNumber)) {
    return res.status(409).json({
      error: "Company is in closed-won registry and cannot be imported.",
      suppressed: true,
      reason: "closed_won_registry",
    });
  }

  const COMPANIES = loadCompanies();
  const existing = COMPANIES.find((company) => normalizeCompanyNumber(company.company_number) === requestedNumber);
  if (existing) {
    return res.status(200).json({
      success: true,
      already_exists: true,
      company: existing,
    });
  }

  try {
    const chData = await lookupCompany(requestedNumber, {
      include_charges: true,
      include_ownership: true,
    });
    if (chData?.error) {
      return res.status(chData.status || 502).json({ error: chData.message || "Lookup failed" });
    }

    const baseAssessment = classifySource3Entity(chData);
    const overrideReason = String(req.body?.reason || "manual_source3_override").trim();
    const overrideAssessment = normalizeSource3Assessment(baseAssessment, {
      decision: "manual_override_include",
      reasons: [
        ...(Array.isArray(baseAssessment?.reasons) ? baseAssessment.reasons : []),
        `Manual override applied (${overrideReason})`,
      ],
    });

    const importedCompany = buildSource3ImportedCompany(requestedNumber, chData, overrideAssessment, {
      source: "source_3_csv_override",
      override: true,
      overrideReason,
    });

    setStoredSicCodes(requestedNumber, chData?.sic_codes || []);

    COMPANIES.push(importedCompany);
    saveCompanies(COMPANIES);

    if (chData.charge_summary) {
      upsertCompanyChargeSummary(requestedNumber, chData.charge_summary, "companies_house_api");
    }
    if (chData.ownership_summary) {
      setSetting(`ownership_${requestedNumber}`, {
        ...chData.ownership_summary,
        source: "companies_house_api",
      });
    }

    enqueueCompanyForAnalysis(
      { company_number: requestedNumber, company_name: importedCompany.name },
      "csv_import_override"
    );

    const jobId = String(req.body?.job_id || "").trim();
    if (jobId && getImportJob(jobId)) {
      addImportLogEntry(
        jobId,
        requestedNumber,
        importedCompany.name,
        "imported",
        `Manual override include (previously ${source3CategoryLabel(baseAssessment.category)} high-confidence filter)`
      );
    }

    return res.json({
      success: true,
      already_exists: false,
      company: importedCompany,
      source3_assessment: overrideAssessment,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function processCSVImport(jobId, companyNumbers) {
  let imported = 0, skipped = 0, errors = 0;
  const source3Stats = {
    auto_filtered_high_confidence: 0,
    auto_filtered_non_trading: 0,
    auto_filtered_holding_spv: 0,
    included_with_warning: 0,
    included_without_warning: 0,
  };

  const importJob = getImportJob(jobId);
  const jobMetadata = {
    ...(importJob?.metadata || {}),
  };
  const COMPANIES = loadCompanies();
  const existingNumbers = new Set(
    COMPANIES
      .map((c) => normalizeCompanyNumber(c.company_number))
      .filter(Boolean)
  );

  for (let i = 0; i < companyNumbers.length; i++) {
    const num = normalizeCompanyNumber(companyNumbers[i]);
    if (!num) {
      addImportLogEntry(jobId, String(companyNumbers[i] || ""), null, "error", "Invalid company number format");
      errors++;
      updateImportJob(jobId, {
        processed_items: i + 1,
        imported_items: imported,
        skipped_items: skipped,
        error_count: errors,
      });
      continue;
    }

    if (isClosedWonCompanyNumber(num)) {
      markCompanyClosedWon(num, "Closed-won registry matched during CSV import");
      addImportLogEntry(jobId, num, null, "skipped", "Closed-won registry match - suppressed from active pipeline");
      skipped++;
      updateImportJob(jobId, { processed_items: i + 1, imported_items: imported, skipped_items: skipped, error_count: errors });
      continue;
    }

    if (existingNumbers.has(num)) {
      addImportLogEntry(jobId, num, null, "skipped", "Already exists in universe");
      skipped++;
      updateImportJob(jobId, { processed_items: i + 1, imported_items: imported, skipped_items: skipped, error_count: errors });
      continue;
    }

    try {
      const chData = await lookupCompany(num, {
        include_charges: true,
        include_ownership: true,
      });
      if (chData.error) {
        addImportLogEntry(jobId, num, null, "error", chData.message);
        errors++;
      } else {
        const source3Assessment = classifySource3Entity(chData);

        if (source3Assessment.decision === "auto_filter") {
          skipped++;
          source3Stats.auto_filtered_high_confidence++;
          if (source3Assessment.category === "non_trading") {
            source3Stats.auto_filtered_non_trading++;
          }
          if (source3Assessment.category === "holding_spv") {
            source3Stats.auto_filtered_holding_spv++;
          }

          addImportLogEntry(
            jobId,
            num,
            chData.name,
            "skipped",
            formatSource3AutoFilterDetail(source3Assessment)
          );
        } else {
          const newCompany = buildSource3ImportedCompany(num, chData, source3Assessment, {
            source: chData.source,
          });

          setStoredSicCodes(num, chData?.sic_codes || []);

          COMPANIES.push(newCompany);
          upsertMonitoredCompany({
            company_number: num,
            company_name: newCompany.name,
            latest_turnover: newCompany.turnover,
            status: "active",
            source: "csv_import",
          });
          try {
            const doc = await fetchLatestAccountsDocument(num);
            if (doc?.raw_data) {
              upsertFiling({
                company_number: num,
                filing_date: doc.filing_date,
                description: doc.description,
                filing_type: "accounts",
                barcode: doc.barcode,
                turnover: doc.turnover,
                source: "csv_import",
                raw_data: doc.raw_data,
              });
              if (doc.turnover && !newCompany.turnover) {
                upsertMonitoredCompany({
                  company_number: num,
                  company_name: newCompany.name,
                  latest_turnover: doc.turnover,
                  status: "active",
                  source: "csv_import",
                });
              }
            }
          } catch { /* best-effort: company already imported + monitored */ }
          existingNumbers.add(num);
          if (chData.charge_summary) {
            upsertCompanyChargeSummary(num, chData.charge_summary, "companies_house_api");
          }
          if (chData.ownership_summary) {
            setSetting(`ownership_${num}`, {
              ...chData.ownership_summary,
              source: "companies_house_api",
            });
          }

          if (source3Assessment.decision === "include_warn") {
            source3Stats.included_with_warning++;
          } else {
            source3Stats.included_without_warning++;
          }

          addImportLogEntry(
            jobId,
            num,
            newCompany.name,
            "imported",
            formatSource3IncludeDetail(newCompany.segment, source3Assessment),
            newCompany.turnover
          );
          enqueueCompanyForAnalysis({ company_number: num, company_name: newCompany.name }, "csv_import");
          imported++;
        }
      }
    } catch (err) {
      addImportLogEntry(jobId, num, null, "error", err.message);
      errors++;
    }

    updateImportJob(jobId, { processed_items: i + 1, imported_items: imported, skipped_items: skipped, error_count: errors });

    if (isCompaniesHouseConfigured()) await new Promise((r) => setTimeout(r, 500));
  }

  await processAnalysisQueueBatch({ batchSize: 3 });

  saveCompanies(COMPANIES);

  updateImportJob(jobId, {
    status: "completed",
    completed_at: new Date().toISOString(),
    processed_items: companyNumbers.length,
    imported_items: imported,
    skipped_items: skipped,
    error_count: errors,
    metadata: JSON.stringify({
      ...jobMetadata,
      source3_policy: "fail_open_confidence_tiers",
      source3: source3Stats,
    }),
  });
}

function mapSICToIndustry(sicCodes) {
  if (!sicCodes || sicCodes.length === 0) return "Unknown";
  const code = sicCodes[0];
  const prefix = parseInt(code.substring(0, 2));
  if (prefix <= 3) return "Agriculture";
  if (prefix <= 9) return "Mining";
  if (prefix <= 33) return "Manufacturing";
  if (prefix <= 35) return "Energy";
  if (prefix <= 39) return "Utilities";
  if (prefix <= 43) return "Construction";
  if (prefix <= 47) return "Retail";
  if (prefix <= 53) return "Logistics";
  if (prefix <= 56) return "Hospitality";
  if (prefix <= 63) return "Technology";
  if (prefix <= 66) return "Financial Services";
  if (prefix <= 68) return "Real Estate";
  if (prefix <= 75) return "Professional Services";
  if (prefix <= 82) return "Business Services";
  if (prefix <= 84) return "Public Administration";
  if (prefix <= 85) return "Education";
  if (prefix <= 88) return "Healthcare";
  if (prefix <= 93) return "Entertainment";
  return "Other Services";
}

function guessTurnoverSegment(turnover) {
  if (!turnover) return "Mid-Market";
  if (turnover >= 250_000_000) return "Enterprise";
  if (turnover >= 10_000_000) return "Mid-Market";
  return "SMB";
}

async function listPendingBackfillFiles(mode = "all") {
  const includeMonthly = mode === "all" || mode === "monthly";
  const includeDaily = mode === "all" || mode === "daily";

  const monthlyFiles = includeMonthly ? await getMonthlyZipURLs() : [];
  const dailyFiles = includeDaily ? await getDailyZipURLs() : [];

  const monthlyPlan = includeMonthly ? getMonthlyAutoPullPlan(monthlyFiles) : { filesToCheck: [], filesToProcess: [] };
  const dailyPlan = includeDaily
    ? getDailyAutoPullPlan(dailyFiles, { processedStoreExists: true })
    : { filesToProcess: [], filesToBaseline: [], initializedBaseline: false };

  const files = [
    ...monthlyPlan.filesToProcess.map((file) => ({
      type: "monthly",
      filename: file.filename,
      url: file.url,
      sourceTag: `monthly:${file.period || "unknown"}`,
      period: file.period,
    })),
    ...dailyPlan.filesToProcess.map((file) => ({
      type: "daily",
      filename: file.filename,
      url: file.url,
      sourceTag: `daily:${file.date || "unknown"}`,
      date: file.date,
    })),
  ];

  return {
    mode,
    total_pending: files.length,
    monthly_checked: monthlyPlan.filesToCheck.length,
    monthly_pending: monthlyPlan.filesToProcess.length,
    daily_pending: dailyPlan.filesToProcess.length,
    files,
  };
}

function appendBulkRemainingResult(item) {
  bulkRemainingState.recent_results.unshift(item);
  bulkRemainingState.recent_results = bulkRemainingState.recent_results.slice(0, 25);
}

async function runProcessRemainingBackfill(mode = "all", maxFiles = 0) {
  const plan = await listPendingBackfillFiles(mode);
  const files = maxFiles > 0 ? plan.files.slice(0, maxFiles) : plan.files;

  bulkRemainingState.running = true;
  bulkRemainingState.mode = mode;
  bulkRemainingState.run_id = `backfill-${Date.now()}`;
  bulkRemainingState.started_at = new Date().toISOString();
  bulkRemainingState.completed_at = null;
  bulkRemainingState.total_files = files.length;
  bulkRemainingState.processed_files = 0;
  bulkRemainingState.successful_files = 0;
  bulkRemainingState.failed_files = 0;
  bulkRemainingState.skipped_files = 0;
  bulkRemainingState.current_file = null;
  bulkRemainingState.last_error = null;
  bulkRemainingState.total_records_processed = 0;
  bulkRemainingState.total_qualifying_companies = 0;
  bulkRemainingState.total_parse_errors = 0;
  bulkRemainingState.total_no_turnover_data = 0;
  bulkRemainingState.total_below_threshold = 0;
  bulkRemainingState.retry_attempts = 0;
  bulkRemainingState.recent_results = [];

  try {
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      bulkRemainingState.current_file = file.filename;

      const jobId = `bulk-remaining-${Date.now()}-${idx}`;
      createImportJob(jobId, "bulk_remaining", 0, {
        mode,
        file_type: file.type,
        filename: file.filename,
        url: file.url,
      });

      try {
        const maxAttempts = 2;
        let attempt = 0;
        let result = null;
        let lastAttemptError = null;

        while (attempt < maxAttempts) {
          attempt += 1;
          if (attempt > 1) {
            bulkRemainingState.retry_attempts += 1;
          }

          try {
            result = await processZipInChunks(file.url, file.filename, file.sourceTag, {
              onDownloadProgress: (progress) => {
                updateImportJob(jobId, {
                  status: "running",
                  metadata: JSON.stringify({ stage: "downloading", attempt, ...progress }),
                });
              },
              onProcessProgress: (progress) => {
                updateImportJob(jobId, {
                  status: "running",
                  metadata: JSON.stringify({ stage: "processing", attempt, ...progress }),
                });
              },
            });
            break;
          } catch (err) {
            lastAttemptError = err;

            if (attempt < maxAttempts) {
              appendBulkRemainingResult({
                filename: file.filename,
                type: file.type,
                status: "retrying",
                attempt,
                error: err.message,
              });
              updateImportJob(jobId, {
                status: "running",
                metadata: JSON.stringify({
                  mode,
                  file_type: file.type,
                  filename: file.filename,
                  stage: "retrying",
                  attempt,
                  error: err.message,
                }),
              });
              continue;
            }
          }
        }

        if (!result) {
          throw (lastAttemptError || new Error("Backfill processing failed"));
        }

        for (const co of result.companies || []) {
          addImportLogEntry(
            jobId,
            co.company_number,
            co.company_name || null,
            "imported",
            `£${((co.turnover || 0) / 1e6).toFixed(1)}M turnover (backfill ${file.type})`,
            co.turnover
          );
        }

        const rawCompanies = Array.isArray(result.companies) ? result.companies : [];
        const eligibleCompanies = [];
        for (const row of rawCompanies) {
          const normalized = normalizeCompanyNumber(row?.company_number);
          if (normalized && isClosedWonCompanyNumber(normalized)) {
            markCompanyClosedWon(normalized, "Closed-won registry matched during bulk backfill");
            continue;
          }
          eligibleCompanies.push(row);
        }

        const queued = enqueueCompaniesForAnalysis(eligibleCompanies, `bulk_remaining:${file.type}`);
        if (queued.queued > 0) {
          await processAnalysisQueueBatch({ batchSize: Math.min(6, Math.max(2, queued.queued)) });
        }

        bulkRemainingState.total_records_processed += result.processed || 0;
        bulkRemainingState.total_qualifying_companies += result.qualifying || 0;
        bulkRemainingState.total_parse_errors += result.parse_errors || 0;
        bulkRemainingState.total_no_turnover_data += result.no_turnover_data || 0;
        bulkRemainingState.total_below_threshold += result.below_threshold || 0;

        if (result.skipped_file) {
          bulkRemainingState.skipped_files += 1;
        }

        updateImportJob(jobId, {
          status: "completed",
          completed_at: new Date().toISOString(),
          total_items: result.total_files || 0,
          processed_items: result.processed || 0,
          imported_items: result.qualifying || 0,
          skipped_items: result.below_threshold || 0,
          error_count: result.parse_errors || 0,
          metadata: JSON.stringify({
            mode,
            file_type: file.type,
            filename: file.filename,
            analysis_queued: queued.queued,
            skipped_file: !!result.skipped_file,
            skipped_reason: result.skipped_reason || null,
          }),
        });

        bulkRemainingState.successful_files += 1;
        appendBulkRemainingResult({
          filename: file.filename,
          type: file.type,
          status: "completed",
          attempts: attempt,
          skipped_file: !!result.skipped_file,
          skipped_reason: result.skipped_reason || null,
          qualifying: result.qualifying || 0,
          processed: result.processed || 0,
          below_threshold: result.below_threshold || 0,
          no_turnover_data: result.no_turnover_data || 0,
          parse_errors: result.parse_errors || 0,
        });
      } catch (err) {
        bulkRemainingState.failed_files += 1;
        bulkRemainingState.last_error = err.message;

        updateImportJob(jobId, {
          status: "failed",
          completed_at: new Date().toISOString(),
          metadata: JSON.stringify({
            mode,
            file_type: file.type,
            filename: file.filename,
            error: err.message,
          }),
        });

        addImportLogEntry(jobId, null, null, "error", err.message);
        appendBulkRemainingResult({
          filename: file.filename,
          type: file.type,
          status: "failed",
          error: err.message,
        });
      }

      bulkRemainingState.processed_files += 1;
    }
  } finally {
    bulkRemainingState.running = false;
    bulkRemainingState.current_file = null;
    bulkRemainingState.completed_at = new Date().toISOString();
    maybeKickShortlistAutoAnalysis(Math.max(4, SHORTLIST_AUTO_ANALYSIS_BATCH));
  }

  return {
    run_id: bulkRemainingState.run_id,
    processed_files: bulkRemainingState.processed_files,
    successful_files: bulkRemainingState.successful_files,
    failed_files: bulkRemainingState.failed_files,
    skipped_files: bulkRemainingState.skipped_files,
    total_records_processed: bulkRemainingState.total_records_processed,
    total_qualifying_companies: bulkRemainingState.total_qualifying_companies,
    total_parse_errors: bulkRemainingState.total_parse_errors,
    total_no_turnover_data: bulkRemainingState.total_no_turnover_data,
    total_below_threshold: bulkRemainingState.total_below_threshold,
    retry_attempts: bulkRemainingState.retry_attempts,
  };
}

function setNextBackfillAutoRun(intervalOverrideMs = null) {
  const requestedInterval = Number.isFinite(Number(intervalOverrideMs))
    ? Number(intervalOverrideMs)
    : BACKFILL_AUTORUN_INTERVAL_MS;
  const resolvedInterval = Math.max(60000, requestedInterval);
  backfillAutoStatus.next_interval_ms = resolvedInterval;
  backfillAutoStatus.next_run = new Date(Date.now() + resolvedInterval).toISOString();
  return resolvedInterval;
}

function scheduleBackfillAutorun(delayMs) {
  const nextDelayMs = setNextBackfillAutoRun(delayMs);

  if (backfillAutoTimer) {
    clearTimeout(backfillAutoTimer);
    backfillAutoTimer = null;
  }

  backfillAutoTimer = setTimeout(() => {
    runBackfillAutorunCycle().catch(() => {});
  }, nextDelayMs);

  return nextDelayMs;
}

async function runBackfillAutorunCycle() {
  backfillAutoStatus.last_run = new Date().toISOString();
  backfillAutoStatus.last_error = null;
  let nextDelayMs;

  try {
    if (bulkRemainingState.running) {
      backfillAutoStatus.mode = "busy_wait";
      backfillAutoStatus.last_result = { skipped: "backfill_already_running" };
      nextDelayMs = Math.min(
        Math.max(60000, BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS),
        Math.max(60000, BACKFILL_AUTORUN_INTERVAL_MS)
      );
      return;
    }

    const pending = await listPendingBackfillFiles("monthly");
    if (!pending.total_pending) {
      backfillAutoStatus.mode = "normal";
      backfillAutoStatus.last_result = { skipped: "no_monthly_pending", total_pending: 0 };
      nextDelayMs = Math.max(60000, BACKFILL_AUTORUN_INTERVAL_MS);
      return;
    }

    const normalMaxFiles = Math.max(1, BACKFILL_AUTORUN_MAX_FILES);
    const catchupMaxFiles = Math.max(normalMaxFiles, BACKFILL_AUTORUN_CATCHUP_MAX_FILES);
    const backlogThreshold = Math.max(1, BACKFILL_AUTORUN_BACKLOG_THRESHOLD);
    const isCatchup = pending.total_pending >= backlogThreshold;
    const cycleMaxFiles = isCatchup ? catchupMaxFiles : normalMaxFiles;
    nextDelayMs = isCatchup
      ? Math.max(60000, BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS)
      : Math.max(60000, BACKFILL_AUTORUN_INTERVAL_MS);
    backfillAutoStatus.mode = isCatchup ? "catchup" : "normal";

    const result = await runProcessRemainingBackfill("monthly", cycleMaxFiles);
    backfillAutoStatus.last_result = {
      mode: "monthly",
      run_mode: backfillAutoStatus.mode,
      cycle_max_files: cycleMaxFiles,
      pending_before_run: pending.total_pending,
      processed_files: result.processed_files,
      successful_files: result.successful_files,
      failed_files: result.failed_files,
      skipped_files: result.skipped_files,
      total_records_processed: result.total_records_processed,
      total_qualifying_companies: result.total_qualifying_companies,
      retry_attempts: result.retry_attempts,
      next_interval_ms: nextDelayMs,
    };
  } catch (err) {
    backfillAutoStatus.last_error = err.message;
    backfillAutoStatus.last_result = { error: err.message };
    nextDelayMs = Math.min(
      Math.max(60000, BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS),
      Math.max(60000, BACKFILL_AUTORUN_INTERVAL_MS)
    );
  } finally {
    scheduleBackfillAutorun(nextDelayMs ?? Math.max(60000, BACKFILL_AUTORUN_INTERVAL_MS));
  }
}

function startBackfillAutorun() {
  if (backfillAutoTimer) {
    clearTimeout(backfillAutoTimer);
    backfillAutoTimer = null;
  }

  if (!BACKFILL_AUTORUN_ENABLED) {
    backfillAutoStatus.enabled = false;
    backfillAutoStatus.mode = "disabled";
    backfillAutoStatus.next_run = null;
    backfillAutoStatus.next_interval_ms = null;
    return { ...backfillAutoStatus };
  }

  const intervalMs = Math.max(60000, BACKFILL_AUTORUN_INTERVAL_MS);
  const catchupIntervalMs = Math.max(60000, BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS);
  const backlogThreshold = Math.max(1, BACKFILL_AUTORUN_BACKLOG_THRESHOLD);
  const maxFiles = Math.max(1, BACKFILL_AUTORUN_MAX_FILES);
  const catchupMaxFiles = Math.max(maxFiles, BACKFILL_AUTORUN_CATCHUP_MAX_FILES);

  backfillAutoStatus.enabled = true;
  backfillAutoStatus.interval_ms = intervalMs;
  backfillAutoStatus.catchup_interval_ms = catchupIntervalMs;
  backfillAutoStatus.backlog_threshold = backlogThreshold;
  backfillAutoStatus.max_files = maxFiles;
  backfillAutoStatus.catchup_max_files = catchupMaxFiles;
  backfillAutoStatus.mode = "normal";
  scheduleBackfillAutorun(15000);

  return { ...backfillAutoStatus };
}

app.get("/api/import/jobs", (_req, res) => {
  res.json({ jobs: listImportJobs() });
});

app.get("/api/import/jobs/:id", (req, res) => {
  const job = getImportJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const logs = getImportLogs(req.params.id, 200);
  res.json({ job, logs });
});

app.get("/api/import/bulk/process-remaining/status", async (req, res) => {
  let pending = null;
  if (!bulkRemainingState.running || req.query.include_pending === "true") {
    try {
      pending = await listPendingBackfillFiles("all");
      pending.files = pending.files.slice(0, 30);
    } catch (err) {
      pending = { error: err.message };
    }
  }

  const pendingSummary = pending && !pending.error
    ? {
        total_pending: pending.total_pending,
        monthly_pending: pending.monthly_pending,
        daily_pending: pending.daily_pending,
        monthly_checked: pending.monthly_checked,
      }
    : null;

  res.json({
    ...bulkRemainingState,
    autorun: { ...backfillAutoStatus },
    pending,
    pending_summary: pendingSummary,
  });
});

app.post("/api/import/bulk/process-remaining", async (req, res) => {
  const modeRaw = String(req.body?.mode || "all").toLowerCase();
  const mode = ["all", "monthly", "daily"].includes(modeRaw) ? modeRaw : "all";
  const maxFilesRaw = Number.parseInt(String(req.body?.max_files || "0"), 10);
  const maxFiles = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? maxFilesRaw : 0;
  const dryRun = req.body?.dry_run === true;

  const plan = await listPendingBackfillFiles(mode);
  const files = maxFiles > 0 ? plan.files.slice(0, maxFiles) : plan.files;

  if (dryRun) {
    return res.json({
      mode,
      dry_run: true,
      total_pending: plan.total_pending,
      selected_files: files.length,
      files: files.slice(0, 100),
    });
  }

  if (bulkRemainingState.running) {
    return res.status(409).json({ error: "Backfill job already running", status: bulkRemainingState });
  }

  runProcessRemainingBackfill(mode, maxFiles).catch((err) => {
    bulkRemainingState.running = false;
    bulkRemainingState.current_file = null;
    bulkRemainingState.completed_at = new Date().toISOString();
    bulkRemainingState.last_error = err.message;
  });

  return res.status(202).json({
    accepted: true,
    mode,
    total_pending: plan.total_pending,
    scheduled_files: files.length,
    status_endpoint: "/api/import/bulk/process-remaining/status",
  });
});

// --- Bulk ZIP Processing ---

app.get("/api/import/bulk/monthly", async (_req, res) => {
  try {
    const files = await getMonthlyZipURLs();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message, files: [] });
  }
});

app.get("/api/import/bulk/daily", async (_req, res) => {
  try {
    const files = await getDailyZipURLs();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message, files: [] });
  }
});

app.post("/api/import/bulk/process", async (req, res) => {
  const { url, filename } = req.body;
  if (!url || !filename) return res.status(400).json({ error: "url and filename required" });

  const jobId = `bulk-${Date.now()}`;
  createImportJob(jobId, "bulk_zip", 0, { filename, url });

  res.status(202).json({ job_id: jobId, status: "processing", filename });

  try {
    const result = await processZipInChunks(url, filename, `bulk:${filename}`, {
      onDownloadProgress: (progress) => {
        updateImportJob(jobId, {
          status: "running",
          metadata: JSON.stringify({ stage: "downloading", ...progress }),
        });
      },
      onProcessProgress: (progress) => {
        updateImportJob(jobId, {
          status: "running",
          metadata: JSON.stringify({ stage: "processing", ...progress }),
        });
      },
    });

    const eligibleCompanies = [];
    for (const co of result.companies) {
      const normalizedNumber = normalizeCompanyNumber(co.company_number);
      if (normalizedNumber && isClosedWonCompanyNumber(normalizedNumber)) {
        markCompanyClosedWon(normalizedNumber, "Closed-won registry matched during bulk import");
        addImportLogEntry(jobId, normalizedNumber, co.company_name || null, "skipped", "Closed-won registry match — suppressed from active pipeline", co.turnover);
        continue;
      }

      addImportLogEntry(jobId, co.company_number, co.company_name || null, "imported",
        `£${(co.turnover / 1e6).toFixed(1)}M turnover (BS date: ${co.balance_sheet_date || "?"})`, co.turnover);
      eligibleCompanies.push(co);
    }

    const suppressedByRegistry = Math.max(0, (result.companies?.length || 0) - eligibleCompanies.length);
    const queued = enqueueCompaniesForAnalysis(eligibleCompanies, `bulk_import:${filename}`);
    if (queued.queued > 0) {
      await processAnalysisQueueBatch({ batchSize: 3 });
    }

    updateImportJob(jobId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      total_items: result.total_files,
      processed_items: result.processed,
      imported_items: eligibleCompanies.length,
      skipped_items: (result.below_threshold || 0) + suppressedByRegistry,
      error_count: result.parse_errors,
      metadata: JSON.stringify({ filename, url, analysis_queued: queued.queued, suppressed_closed_won: suppressedByRegistry }),
    });
  } catch (err) {
    updateImportJob(jobId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      metadata: JSON.stringify({ error: err.message }),
    });
    addImportLogEntry(jobId, null, null, "error", err.message);
  }
});

// --- Scoring Engine ---

app.post("/api/score/company", (req, res) => {
  const { company_number } = req.body;
  if (!company_number) return res.status(400).json({ error: "company_number required" });

  const result = scoreCompany(company_number);
  if (!result) return res.status(404).json({ error: "Company not found in monitor" });

  res.json(result);
});

app.post("/api/score/batch", (req, res) => {
  const { limit } = req.body;
  const companies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit: limit || 100 });
  const results = batchScoreCompanies(companies);
  res.json({
    scored: results.length,
    top_10: results.slice(0, 10).map((r) => ({
      company_number: r.company_number,
      name: r.company_name,
      turnover: r.turnover,
      composite_score: r.composite_score,
      best_motion: r.layers.product_fit.best_motion,
      product_fit: r.layers.product_fit.score,
      growth: r.growth.trend,
    })),
  });
});

app.get("/api/score/:number", (req, res) => {
  const stored = getStoredScore(req.params.number);
  if (!stored) {
    const fresh = scoreCompany(req.params.number);
    if (!fresh) return res.status(404).json({ error: "Company not found" });
    return res.json(fresh);
  }
  res.json(stored);
});

// --- Twice-Weekly Auto-Pull (Method 1) ---

app.get("/api/import/autopull/status", (_req, res) => {
  res.json(getAutoPullStatus());
});

app.post("/api/import/autopull/start", (_req, res) => {
  const status = startAutoPull();
  res.json({ message: "Auto-pull started — checking every 12 hours for new daily CH files", ...status });
});

app.post("/api/import/autopull/stop", (_req, res) => {
  const status = stopAutoPull();
  res.json({ message: "Auto-pull stopped", ...status });
});

app.get("/api/analysis-queue/status", (_req, res) => {
  const queueCounts = getAnalysisQueueCounts();
  const queuedCount = Number(queueCounts?.queued || 0);
  const queueSoftCap = Math.max(20, SHORTLIST_BACKGROUND_SEED_QUEUE_SOFT_CAP);
  const queueHardCap = Math.max(queueSoftCap, SHORTLIST_BACKGROUND_SEED_QUEUE_HARD_CAP);

  res.json({
    ...getAnalysisQueueWorkerStatus(),
    shortlist_auto_seed: {
      enabled: true,
      timer_active: !!shortlistBackgroundSeedTimer,
      interval_ms: Math.max(30000, SHORTLIST_BACKGROUND_SEED_INTERVAL_MS),
      limit: SHORTLIST_BACKGROUND_SEED_LIMIT,
      max_enqueue: SHORTLIST_BACKGROUND_SEED_MAX_ENQUEUE,
      queue_soft_cap: queueSoftCap,
      queue_hard_cap: queueHardCap,
      queue_headroom: Math.max(0, queueSoftCap - queuedCount),
    },
    tech_enrichment_seed: getTechEnrichmentSeedStatus(),
  });
});

app.post("/api/analysis-queue/process", async (req, res) => {
  const batchSize = parseInt(req.body?.batch_size) || undefined;
  const result = await processAnalysisQueueBatch({ batchSize });
  res.json(result);
});

app.post("/api/analysis-queue/retry", async (req, res) => {
  const rawCompanyNumber = String(req.body?.company_number || "").trim();

  if (rawCompanyNumber) {
    const normalized = companyNumberFromId(canonicalCompanyId(rawCompanyNumber));
    const companyNumber = /^\d{1,8}$/.test(normalized)
      ? normalized.padStart(8, "0")
      : normalized;

    if (isClosedWonCompanyNumber(companyNumber)) {
      markCompanyClosedWon(companyNumber, "Retry blocked by closed-won registry");
      return res.status(409).json({
        retried: 0,
        queued: 0,
        company_number: companyNumber,
        suppressed: true,
        reason: "closed_won_registry",
      });
    }

    enqueueCompanyForAnalysis({ company_number: companyNumber }, "manual_retry");
    const processed = await processAnalysisQueueItem(companyNumber);

    return res.json({
      retried: processed.processed,
      queued: 1,
      company_number: companyNumber,
      processed,
      queue: getAnalysisQueueWorkerStatus(),
    });
  }

  const failedItems = listFailedAnalysisQueueItems(500);
  if (failedItems.length === 0) {
    return res.json({
      retried: 0,
      processed: 0,
      queue: getAnalysisQueueWorkerStatus(),
      message: "No failed analysis items to retry.",
    });
  }

  const queued = enqueueCompaniesForAnalysis(
    failedItems
      .filter((item) => !isClosedWonCompanyNumber(item.company_number))
      .map((item) => ({
      company_number: item.company_number,
      company_name: item.company_name,
      })),
    "manual_retry_bulk"
  );

  const batchSize = Math.max(1, Math.min(10, queued.queued));
  const processed = await processAnalysisQueueBatch({ batchSize });

  return res.json({
    retried: queued.queued,
    processed,
    queue: getAnalysisQueueWorkerStatus(),
  });
});

// --- Company Monitor (Method 2) ---

app.get("/api/monitor/status", (_req, res) => {
  const staleStatus = getStaleFilingMonitorStatus();
  const ownershipStatus = getOwnershipStaleMonitorStatus();
  res.json({
    ...getWeeklyMonitorStatus(),
    running: isMonitorRunning(),
    progress: getMonitorProgress(),
    stale_monitor: {
      ...staleStatus,
      running: isStaleMonitorRunning(),
      progress: getStaleMonitorProgress(),
    },
    ownership_monitor: {
      ...ownershipStatus,
      running: isOwnershipStaleMonitorRunning(),
      progress: getOwnershipStaleMonitorProgress(),
    },
    threshold: getTurnoverThreshold(),
    filing_count: getFilingCount(),
  });
});

app.get("/api/monitor/companies", (req, res) => {
  const { status, below_threshold, no_filings, limit, offset } = req.query;
  const companies = dbGetMonitoredCompanies({
    status: status || undefined,
    below_threshold: below_threshold === "true" ? true : undefined,
    no_filings: no_filings === "true" ? true : undefined,
    limit: parseInt(limit) || 100,
    offset: parseInt(offset) || 0,
  });
  res.json({ companies, stats: getMonitorStats() });
});

app.get("/api/monitor/companies/:number/filings", (req, res) => {
  const filings = getFilingsForCompany(req.params.number);
  res.json({ filings });
});

app.post("/api/monitor/import-list", async (req, res) => {
  const { csv_content, source } = req.body;
  if (!csv_content) return res.status(400).json({ error: "csv_content required" });

  try {
    const result = await importMonitorListFromCSV(csv_content, source || "csv_list");
    const totalMonitored = getMonitoredCompanyCount();
    res.json({
      message: `Imported ${result.imported} companies to monitor list`,
      total_parsed: result.total_parsed,
      imported: result.imported,
      skipped: result.skipped,
      total_monitored: totalMonitored,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/monitor/run", async (req, res) => {
  const batchSize = parseInt(req.body?.batch_size) || 50;

  if (isMonitorRunning()) {
    return res.status(409).json({ error: "Monitor already running", progress: getMonitorProgress() });
  }

  res.status(202).json({ message: `Starting monitor check for up to ${batchSize} companies`, batch_size: batchSize });

  runWeeklyMonitorBatch(batchSize).catch((err) => {
    console.error("Monitor batch error:", err.message);
  });
});

app.post("/api/monitor/scheduler/start", (_req, res) => {
  const status = startWeeklyMonitor();
  res.json({ message: "Weekly monitor started (Saturday evenings)", ...status });
});

app.post("/api/monitor/scheduler/stop", (_req, res) => {
  const status = stopWeeklyMonitor();
  res.json({ message: "Weekly monitor stopped", ...status });
});

app.get("/api/monitor/stale/status", (_req, res) => {
  res.json(getStaleFilingMonitorStatus());
});

app.post("/api/monitor/stale/run", async (req, res) => {
  const batchSize = parseInt(req.body?.batch_size) || 100;

  if (isMonitorRunning() || isStaleMonitorRunning() || isOwnershipStaleMonitorRunning()) {
    return res.status(409).json({
      error: "A monitor job is already running",
      weekly_progress: getMonitorProgress(),
      stale_progress: getStaleMonitorProgress(),
      ownership_progress: getOwnershipStaleMonitorProgress(),
    });
  }

  res.status(202).json({
    message: `Starting stale filing lookup for up to ${batchSize} companies`,
    batch_size: batchSize,
    cadence: "14 days",
  });

  runStaleFilingFortnightlyBatch(batchSize).catch((err) => {
    console.error("Stale filing monitor batch error:", err.message);
  });
});

app.post("/api/monitor/stale/scheduler/start", (_req, res) => {
  const status = startStaleFilingMonitor();
  res.json({ message: "Stale filing monitor scheduler started", ...status });
});

app.post("/api/monitor/stale/scheduler/stop", (_req, res) => {
  const status = stopStaleFilingMonitor();
  res.json({ message: "Stale filing monitor scheduler stopped", ...status });
});

app.get("/api/monitor/ownership/status", (_req, res) => {
  res.json(getOwnershipStaleMonitorStatus());
});

app.get("/api/monitor/ownership/changes", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit || "100"), 10);
  const offset = Number.parseInt(String(req.query.offset || "0"), 10);
  const sinceDays = Number.parseInt(String(req.query.since_days || "30"), 10);
  const changedField = req.query.changed_field ?? req.query.changed_fields;
  const result = listOwnershipChangedCompanies({
    limit,
    offset,
    since_days: sinceDays,
    changed_field: changedField,
  });

  res.json(result);
});

app.post("/api/monitor/ownership/run", async (req, res) => {
  const batchSize = parseInt(req.body?.batch_size) || 100;

  if (isMonitorRunning() || isStaleMonitorRunning() || isOwnershipStaleMonitorRunning()) {
    return res.status(409).json({
      error: "A monitor job is already running",
      weekly_progress: getMonitorProgress(),
      stale_progress: getStaleMonitorProgress(),
      ownership_progress: getOwnershipStaleMonitorProgress(),
    });
  }

  res.status(202).json({
    message: `Starting ownership stale refresh for up to ${batchSize} companies`,
    batch_size: batchSize,
  });

  runOwnershipStaleBatch(batchSize).catch((err) => {
    console.error("Ownership stale monitor batch error:", err.message);
  });
});

app.post("/api/monitor/ownership/scheduler/start", (_req, res) => {
  const status = startOwnershipStaleMonitor();
  res.json({ message: "Ownership stale monitor scheduler started", ...status });
});

app.post("/api/monitor/ownership/scheduler/stop", (_req, res) => {
  const status = stopOwnershipStaleMonitor();
  res.json({ message: "Ownership stale monitor scheduler stopped", ...status });
});

// --- LLM Company Analysis ---

import { analyseCompany, getLLMRuntimeInfo, isLLMConfigured } from "./llm.js";

app.get("/api/llm/status", (_req, res) => {
  const runtime = getLLMRuntimeInfo();
  res.json(runtime);
});

app.get("/api/integrations/status", (_req, res) => {
  const hasConfiguredSecret = (value) => {
    const key = String(value || "").trim();
    if (!key) return false;
    const lower = key.toLowerCase();
    const looksPlaceholder = lower.startsWith("replace_")
      || lower.startsWith("replace-")
      || lower.startsWith("replace")
      || lower.includes("replace_with")
      || lower.includes("replacewith")
      || lower.includes("your_api_key")
      || lower.includes("optional_")
      || lower.includes("example")
      || lower === "changeme"
      || lower === "change_me";
    return !looksPlaceholder;
  };
  const hasTemplate = (value) => String(value || "").trim().length > 0;

  const newsLookupEnabled = (process.env.ENABLE_NEWS_LOOKUP || "true").toLowerCase() !== "false";
  const statusUrlDiscoveryEnabled = (process.env.ENABLE_STATUS_URL_DISCOVERY || "false").toLowerCase() === "true";
  const llmRuntimeInfo = getLLMRuntimeInfo();
  const emailLlmRuntime = getEmailLlmRuntimeInfo();
  const websiteResolverRuntime = getWebsiteResolverRuntimeConfig();

  const integrations = {
    companies_house: {
      configured: isCompaniesHouseConfigured(),
      required: true,
      env_var: "COMPANIES_HOUSE_API_KEY or CH_API_KEY",
      purpose: "Company lookups and filing-monitor refresh",
    },
    openai: {
      configured: hasConfiguredSecret(process.env.OPENAI_API_KEY),
      required: false,
      env_var: "OPENAI_API_KEY",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      purpose: "Analysis enrichment and advanced email generation",
    },
    anthropic: {
      configured: hasConfiguredSecret(process.env.ANTHROPIC_API_KEY),
      required: false,
      env_var: "ANTHROPIC_API_KEY",
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      purpose: "Claude LLM for analysis + advanced email generation",
    },
    llm: {
      configured: llmRuntimeInfo.configured,
      required: true,
      env_var: "OPENAI_API_KEY or ANTHROPIC_API_KEY",
      provider: llmRuntimeInfo.provider,
      model: llmRuntimeInfo.model,
      request_timeout_ms: llmRuntimeInfo.request_timeout_ms,
      purpose: "Active LLM layer for analysis + advanced email generation",
    },
    email_generation_llm: {
      configured: emailLlmRuntime.configured,
      required: false,
      env_var: "OPENAI_API_KEY, OPENAI_MODEL, OPENAI_MODEL_FALLBACK, EMAIL_LLM_MIN_QC_SCORE, EMAIL_LLM_MAX_ATTEMPTS, EMAIL_LLM_MAX_PROMPT_CHARS, EMAIL_LLM_MAX_TOKENS, EMAIL_LLM_REQUEST_TIMEOUT_MS, EMAIL_LLM_FAIL_CLOSED",
      purpose: "Live email generation runtime controls and fallback guardrails",
      runtime: emailLlmRuntime,
    },
    news_lookup: {
      configured: newsLookupEnabled,
      required: false,
      env_var: "ENABLE_NEWS_LOOKUP",
      purpose: "Supplementary momentum/news context",
      default: "true",
    },
    news_api: {
      configured: hasConfiguredSecret(process.env.NEWS_API_KEY),
      required: false,
      env_var: "NEWS_API_KEY",
      purpose: "Optional premium news enrichment",
    },
    statuspage: {
      configured: hasTemplate(process.env.STATUSPAGE_URL_TEMPLATE),
      required: false,
      env_var: "STATUSPAGE_URL_TEMPLATE",
      purpose: "Free Statuspage-compatible incident and uptime enrichment",
      can_auto_discover: true,
    },
    status_feed: {
      configured: hasTemplate(process.env.STATUS_FEED_URL_TEMPLATE),
      required: false,
      env_var: "STATUS_FEED_URL_TEMPLATE",
      purpose: "Free RSS/Atom status feed incident enrichment",
      can_auto_discover: true,
    },
    status_api: {
      configured: hasTemplate(process.env.STATUS_API_URL_TEMPLATE),
      required: false,
      env_var: "STATUS_API_URL_TEMPLATE",
      purpose: "Free JSON status API incident enrichment",
      can_auto_discover: true,
    },
    status_instatus: {
      configured: hasTemplate(process.env.STATUS_INSTATUS_URL_TEMPLATE),
      required: false,
      env_var: "STATUS_INSTATUS_URL_TEMPLATE",
      purpose: "Free Instatus-style summary JSON enrichment",
      can_auto_discover: true,
    },
    status_cachet: {
      configured: hasTemplate(process.env.STATUS_CACHET_URL_TEMPLATE),
      required: false,
      env_var: "STATUS_CACHET_URL_TEMPLATE",
      purpose: "Free Cachet-style incidents API enrichment",
      can_auto_discover: true,
    },
    status_url_discovery: {
      configured: statusUrlDiscoveryEnabled,
      required: false,
      env_var: "ENABLE_STATUS_URL_DISCOVERY",
      purpose: "Try common status URL patterns before connector sync",
      default: "false",
    },
    endole: {
      configured: hasConfiguredSecret(process.env.ENDOLE_API_KEY) && hasTemplate(process.env.ENDOLE_URL_TEMPLATE),
      required: false,
      env_var: "ENDOLE_API_KEY, ENDOLE_URL_TEMPLATE",
      purpose: "Ownership and corporate relationship enrichment",
    },
    opencorporates: {
      configured: hasTemplate(process.env.OPENCORPORATES_URL_TEMPLATE),
      required: false,
      env_var: "OPENCORPORATES_URL_TEMPLATE (+ optional OPENCORPORATES_API_TOKEN)",
      purpose: "Cross-jurisdiction corporate registry enrichment",
    },
    similarweb: {
      configured: hasConfiguredSecret(process.env.SIMILARWEB_API_KEY) && hasTemplate(process.env.SIMILARWEB_URL_TEMPLATE),
      required: false,
      env_var: "SIMILARWEB_API_KEY, SIMILARWEB_URL_TEMPLATE",
      purpose: "Traffic and digital growth enrichment",
    },
    builtwith: {
      configured: hasConfiguredSecret(process.env.BUILTWITH_API_KEY) && hasTemplate(process.env.BUILTWITH_URL_TEMPLATE),
      required: false,
      env_var: "BUILTWITH_API_KEY, BUILTWITH_URL_TEMPLATE",
      purpose: "Third-party website technology signals",
    },
    adzuna: {
      configured: hasConfiguredSecret(process.env.ADZUNA_APP_ID)
        && hasConfiguredSecret(process.env.ADZUNA_APP_KEY)
        && hasTemplate(process.env.ADZUNA_URL_TEMPLATE),
      required: false,
      env_var: "ADZUNA_APP_ID, ADZUNA_APP_KEY, ADZUNA_URL_TEMPLATE",
      purpose: "Hiring and vacancy velocity enrichment",
    },
    crunchbase: {
      configured: hasConfiguredSecret(process.env.CRUNCHBASE_API_KEY) && hasTemplate(process.env.CRUNCHBASE_URL_TEMPLATE),
      required: false,
      env_var: "CRUNCHBASE_API_KEY, CRUNCHBASE_URL_TEMPLATE",
      purpose: "Funding and investor event enrichment",
    },
    clearbit: {
      configured: hasConfiguredSecret(process.env.CLEARBIT_API_KEY) && hasTemplate(process.env.CLEARBIT_URL_TEMPLATE),
      required: false,
      env_var: "CLEARBIT_API_KEY, CLEARBIT_URL_TEMPLATE",
      purpose: "Firmographic and domain-level enrichment",
    },
    lusha: {
      configured: hasConfiguredSecret(process.env.LUSHA_API_KEY),
      required: false,
      env_var: "LUSHA_API_KEY",
      purpose: "Optional contact enrichment",
    },
    linkedin_research: {
      configured: true,
      required: false,
      env_var: null,
      purpose: "Search-link generation (no API key required)",
    },
    tech_enrichment: {
      configured: true,
      required: false,
      env_var: "TECH_ENRICHMENT_TIMEOUT_MS, TECH_ENRICHMENT_MAX_PAGES, TECH_ENRICHMENT_REFRESH_DAYS, TECH_ENRICHMENT_DEEP_SCAN_MODE, TECH_ENRICHMENT_HIGH_VALUE_TURNOVER",
      purpose: "Deterministic incumbent stack + website intelligence enrichment",
      defaults: TECH_ENRICHMENT_RUNTIME,
    },
    tech_enrichment_scheduler: {
      configured: TECH_ENRICHMENT_SEED_ENABLED,
      required: false,
      env_var: "TECH_ENRICHMENT_SEED_ENABLED, TECH_ENRICHMENT_SEED_INTERVAL_MS, TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS, TECH_ENRICHMENT_SEED_LIMIT, TECH_ENRICHMENT_SEED_MAX_REFRESH, TECH_ENRICHMENT_SEED_DEEP_SCAN_MODE",
      purpose: "Background refresh loop for stale/missing enrichment payloads on shortlist companies",
    },
    website_resolution: {
      configured: true,
      required: false,
      env_var: "WEBSITE_RESOLUTION_TIMEOUT_MS, WEBSITE_RESOLUTION_MAX_CANDIDATES, WEBSITE_RESOLUTION_ENABLE_NAME_GUESSES, ANALYSIS_QUEUE_WEBSITE_GUESS",
      purpose: "Website/domain resolution cache used before deterministic enrichment",
      defaults: websiteResolverRuntime,
    },
  };

  const missingRequired = Object.entries(integrations)
    .filter(([, cfg]) => cfg.required && !cfg.configured)
    .map(([name]) => name);

  res.json({
    integrations,
    llm: {
      configured: llmRuntimeInfo.configured,
      provider: llmRuntimeInfo.provider,
      model: llmRuntimeInfo.model,
      request_timeout_ms: llmRuntimeInfo.request_timeout_ms,
    },
    missing_required: missingRequired,
    ready_for_production: missingRequired.length === 0,
    env_template: [
      "COMPANIES_HOUSE_API_KEY=your_companies_house_api_key",
      "# Optional alias supported: CH_API_KEY=your_companies_house_api_key",
      "OPENAI_API_KEY=your_openai_api_key",
      "OPENAI_MODEL=gpt-4.1-mini",
      "OPENAI_MODEL_FALLBACK=gpt-4o-mini",
      "ANTHROPIC_API_KEY=replace_with_anthropic_api_key",
      "ANTHROPIC_MODEL=claude-sonnet-4-20250514",
      "LLM_REQUEST_TIMEOUT_MS=30000",
      "EMAIL_LLM_REQUEST_TIMEOUT_MS=25000",
      "EMAIL_LLM_FAIL_CLOSED=true",
      "EMAIL_LLM_MAX_ATTEMPTS=2",
      "EMAIL_LLM_MIN_QC_SCORE=65",
      "LUSHA_API_KEY=optional_lusha_key",
      "ENABLE_NEWS_LOOKUP=true",
      "NEWS_API_KEY=optional_newsapi_key",
      "ENABLE_STATUS_URL_DISCOVERY=false",
      "STATUSPAGE_URL_TEMPLATE=https://status.{company_domain}/api/v2/summary.json",
      "STATUS_FEED_URL_TEMPLATE=https://status.{company_domain}/history.rss",
      "STATUS_API_URL_TEMPLATE=https://status.{company_domain}/api/v1/incidents",
      "STATUS_INSTATUS_URL_TEMPLATE=https://status.{company_domain}/summary.json",
      "STATUS_CACHET_URL_TEMPLATE=https://status.{company_domain}/api/v1/incidents",
      "ENDOLE_API_KEY=optional_endole_key",
      "ENDOLE_URL_TEMPLATE=https://example.com/endole?company={company_number}",
      "OPENCORPORATES_API_TOKEN=optional_opencorporates_token",
      "OPENCORPORATES_URL_TEMPLATE=https://example.com/opencorporates?company={company_number}",
      "SIMILARWEB_API_KEY=optional_similarweb_key",
      "SIMILARWEB_URL_TEMPLATE=https://example.com/similarweb?domain={company_domain}",
      "BUILTWITH_API_KEY=optional_builtwith_key",
      "BUILTWITH_URL_TEMPLATE=https://example.com/builtwith?domain={company_domain}",
      "ADZUNA_APP_ID=optional_adzuna_app_id",
      "ADZUNA_APP_KEY=optional_adzuna_app_key",
      "ADZUNA_URL_TEMPLATE=https://example.com/adzuna?company={company_name_encoded}",
      "CRUNCHBASE_API_KEY=optional_crunchbase_key",
      "CRUNCHBASE_URL_TEMPLATE=https://example.com/crunchbase?company={company_name_encoded}",
      "CLEARBIT_API_KEY=optional_clearbit_key",
      "CLEARBIT_URL_TEMPLATE=https://example.com/clearbit?domain={company_domain}",
      "DEFAULT_RUN_EXTERNAL_SIGNAL_SYNC=false",
      "ANALYSIS_QUEUE_EXTERNAL_SIGNAL_SYNC=false",
      "TECH_ENRICHMENT_DEEP_SCAN_MODE=auto",
      "TECH_ENRICHMENT_HIGH_VALUE_TURNOVER=25000000",
      "TECH_ENRICHMENT_SEED_ENABLED=true",
      "TECH_ENRICHMENT_SEED_INTERVAL_MS=21600000",
      "TECH_ENRICHMENT_SEED_INITIAL_DELAY_MS=45000",
      "TECH_ENRICHMENT_SEED_LIMIT=1200",
      "TECH_ENRICHMENT_SEED_MAX_REFRESH=60",
      "TECH_ENRICHMENT_SEED_DEEP_SCAN_MODE=off",
      "ANALYSIS_QUEUE_ENRICHMENT_DEEP_SCAN_MODE=off",
      "WEBSITE_RESOLUTION_TIMEOUT_MS=1800",
      "WEBSITE_RESOLUTION_MAX_CANDIDATES=4",
      "WEBSITE_RESOLUTION_ENABLE_NAME_GUESSES=true",
      "ANALYSIS_QUEUE_WEBSITE_GUESS=false",
    ],
  });
});

app.post("/api/signals/sync/:number", async (req, res) => {
  const companyNumber = normalizeCompanyNumber(req.params?.number);
  if (!companyNumber) {
    return res.status(400).json({ error: "valid company number is required" });
  }

  const monitored = getMonitoredCompany(companyNumber);
  const companyName = String(req.body?.company_name || monitored?.company_name || "").trim();
  const companyDomain = String(req.body?.company_domain || req.body?.domain || "").trim();

  try {
    const sync = await syncExternalSignals({
      companyNumber,
      companyName,
      companyDomain,
      timeoutMs: req.body?.timeout_ms,
      enableStatusDiscovery: parseBooleanInput(
        req.body?.discover_status_urls,
        (process.env.ENABLE_STATUS_URL_DISCOVERY || "false").toLowerCase() === "true"
      ),
    });

    if (!sync.updated && sync.status !== "no_connectors_configured") {
      return res.status(502).json(sync);
    }

    return res.json(sync);
  } catch (err) {
    return res.status(500).json({ error: "External signal sync failed", detail: err?.message || "unknown_error" });
  }
});

app.post("/api/llm/analyse", async (req, res) => {
  const companyNumber = companyNumberFromId(canonicalCompanyId(req.body.company_number || ""));
  if (!companyNumber) {
    return res.status(400).json({ error: "company_number required" });
  }

  if (isClosedWonCompanyNumber(companyNumber)) {
    return res.status(409).json({
      error: "Company is in closed-won registry and excluded from active analysis.",
      suppressed: true,
      company_number: companyNumber,
      reason: "closed_won_registry",
    });
  }

  const monitored = getMonitoredCompany(companyNumber);
  const requestedCompanyName = toOptionalString(req.body?.company_name);
  const name = requestedCompanyName || await resolveMonitorName(companyNumber, monitored?.company_name);
  const turnover = monitored?.latest_turnover || null;
  const runEnrichment = parseBooleanInput(req.body?.run_enrichment, true);
  const runExternalSignalSync = parseBooleanInput(req.body?.run_external_sync, DEFAULT_RUN_EXTERNAL_SIGNAL_SYNC);
  const enableWebsiteDiscovery = parseBooleanInput(req.body?.discover_website, true);
  const forceWebsiteResolution = parseBooleanInput(req.body?.force_website_resolution, false);
  const deepScanOptions = resolveEnrichmentDeepScanOptions(req.body || {}, TECH_ENRICHMENT_RUNTIME.deep_scan_mode);
  let enrichment = null;
  let externalSignalSync = null;
  let websiteResolution;

  try {
    websiteResolution = await resolveCompanyWebsite({
      companyNumber,
      companyName: name,
      companyWebsite: toOptionalString(req.body?.company_website)
        || toOptionalString(req.body?.website)
        || toOptionalString(monitored?.company_website),
      companyDomain: toOptionalString(req.body?.company_domain)
        || toOptionalString(req.body?.domain)
        || toOptionalString(monitored?.company_domain),
      enableNameGuesses: enableWebsiteDiscovery,
      force: forceWebsiteResolution,
    });

    if (websiteResolution?.website_url || websiteResolution?.domain) {
      upsertMonitoredCompany({
        company_number: companyNumber,
        company_name: monitored?.company_name || name,
        latest_turnover: monitored?.latest_turnover ?? turnover,
        status: monitored?.status || "active",
        source: monitored?.source || "llm_analyse",
        company_website: websiteResolution.website_url || monitored?.company_website || null,
        company_domain: websiteResolution.domain || monitored?.company_domain || null,
      });
    }
  } catch (websiteErr) {
    websiteResolution = {
      status: "error",
      updated: false,
      error: websiteErr?.message || "website_resolution_failed",
    };
  }

  try {
    if (runEnrichment) {
      try {
        enrichment = await runCompanyTechEnrichment({
          companyNumber,
          companyName: name,
          companyWebsite: websiteResolution?.website_url
            || toOptionalString(req.body?.company_website)
            || toOptionalString(req.body?.website)
            || toOptionalString(monitored?.company_website),
          companyDomain: websiteResolution?.domain
            || toOptionalString(req.body?.company_domain)
            || toOptionalString(req.body?.domain)
            || toOptionalString(monitored?.company_domain),
          turnover,
          force: parseBooleanInput(req.body?.force_enrichment, false),
          ...deepScanOptions,
          maxPages: req.body?.max_pages,
          refreshWindowDays: req.body?.refresh_window_days,
        });
      } catch (enrichmentErr) {
        enrichment = {
          status: "error",
          updated: false,
          error: enrichmentErr?.message || "enrichment_failed",
        };
      }
    }

    const ownership = await refreshOwnershipEnvelope(companyNumber);

    if (runExternalSignalSync) {
      externalSignalSync = await syncExternalSignals({
        companyNumber,
        companyName: name,
        companyDomain: websiteResolution?.domain
          || toOptionalString(req.body?.company_domain)
          || toOptionalString(req.body?.domain)
          || toOptionalString(monitored?.company_domain),
        timeoutMs: req.body?.external_signal_timeout_ms,
        enableStatusDiscovery: parseBooleanInput(
          req.body?.discover_status_urls,
          (process.env.ENABLE_STATUS_URL_DISCOVERY || "false").toLowerCase() === "true"
        ),
      });
    }

    const analysis = await analyseCompany(companyNumber, name, turnover);
    setSetting(`analysis_${companyNumber}`, analysis);
    const baseScore = scoreCompany(companyNumber);
    const score = baseScore ? integrateAnalysis(baseScore, analysis) : null;
    const enrichedAnalysis = enrichAnalysisWithCompetitorSignals(analysis, score);
    res.json({
      company_number: companyNumber,
      company_name: name,
      analysis: enrichedAnalysis,
      score,
        website_resolution: websiteResolution,
      enrichment,
      ownership,
      external_signal_sync: externalSignalSync,
    });
  } catch (err) {
    res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
});

// Backward compat
app.post("/api/llm/extract", async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: "Missing company_id" });

  const companyNumber = normalizeCompanyNumber(companyNumberFromId(canonicalCompanyId(company_id)))
    || company_id.replace("ch-", "");
  const monitored = getMonitoredCompany(companyNumber);

  try {
    const name = await resolveMonitorName(companyNumber, monitored?.company_name);
    await refreshOwnershipEnvelope(companyNumber);
    const analysis = await analyseCompany(companyNumber, name, monitored?.latest_turnover);
    setSetting(`analysis_${companyNumber}`, analysis);
    const baseScore = scoreCompany(companyNumber);
    const score = baseScore ? integrateAnalysis(baseScore, analysis) : null;
    const enrichedAnalysis = enrichAnalysisWithCompetitorSignals(analysis, score);
    res.json({ company_id, evidence: enrichedAnalysis });
  } catch (err) {
    res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
});

// --- Export ---

app.get("/api/export/shortlist", (req, res) => {
  const { format } = req.query;
  const COMPANIES = loadCompanies();

  const entries = COMPANIES
    .filter((c) => {
      const excl = isExcluded(c);
      if (excl.excluded) return false;
      const supp = isSuppressed(c.id, c.company_number);
      if (supp.suppressed) return false;
      return true;
    })
    .map((c) => {
      const profile = computeCompanyProfile(c);
      if (profile.eligible_motion_count === 0) return null;
      const ws = getCompanyState(c.id);
      return {
        rank: 0,
        name: c.name,
        company_number: c.company_number,
        industry: c.industry,
        segment: profile.segment,
        turnover: c.turnover,
        employee_count: c.employee_count,
        combined_score: profile.combined_score,
        best_motion: profile.best_motion?.motion || "",
        best_score: profile.best_motion?.score || 0,
        eligible_motions: profile.motion_scores.map((m) => m.motion).join("; "),
        motion_count: profile.eligible_motion_count,
        workflow_state: ws.state,
        propensity_warmth: profile.propensity.warmth,
        propensity_score: profile.propensity.score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.combined_score - a.combined_score)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  if (format === "csv") {
    const headers = Object.keys(entries[0] || {});
    const csvLines = [headers.join(",")];
    for (const row of entries) {
      csvLines.push(headers.map((h) => {
        const val = String(row[h] ?? "");
        return val.includes(",") || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="shortlist-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvLines.join("\n"));
  } else {
    res.json({ companies: entries, exported_at: new Date().toISOString() });
  }
});

app.get("/api/export/report/:id", (req, res) => {
  const { id } = req.params;
  const { format } = req.query;
  const report = dbGetReport(id);
  if (!report) return res.status(404).json({ error: "Report not found" });

  const companies = report.companies.map((c) => {
    const ws = getCompanyState(c.company_id);
    return {
      ...c,
      current_workflow_state: ws.state,
      state_changed: c.workflow_state_at_generation !== ws.state,
    };
  });

  if (format === "csv") {
    const headers = ["rank", "name", "company_number", "industry", "turnover", "best_motion", "score", "fit_level", "status_then", "status_now", "state_changed"];
    const csvLines = [headers.join(",")];
    companies.forEach((c, i) => {
      csvLines.push([
        i + 1, `"${c.name}"`, c.company_id, `"${c.industry}"`, c.turnover,
        `"${c.best_motion}"`, c.score, c.fit_level,
        c.workflow_state_at_generation, c.current_workflow_state,
        c.state_changed,
      ].join(","));
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="report-${report.week_label}.csv"`);
    res.send(csvLines.join("\n"));
  } else {
    res.json({ report: { ...report, companies }, exported_at: new Date().toISOString() });
  }
});

// --- Company Notes ---

app.get("/api/company/:id/notes", (req, res) => {
  const { id } = req.params;
  const notes = getSetting(`notes_${id}`, "");
  res.json({ company_id: id, notes });
});

app.put("/api/company/:id/notes", (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;
  if (notes === undefined) return res.status(400).json({ error: "notes field required" });
  setSetting(`notes_${id}`, notes);
  res.json({ company_id: id, notes, saved_at: new Date().toISOString() });
});

// --- Cadence, Stakeholder, Competitor CRUD ---

app.post("/api/company/:id/cadence", (req, res) => {
  const { id } = req.params;
  const { date, type, summary, outcome } = req.body;
  if (!date || !type || !summary) {
    return res.status(400).json({ error: "date, type, and summary are required" });
  }
  const canonicalId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);

  if (monitored) {
    addCadenceEntry(canonicalId, date, type, summary, outcome || null);
    return res.status(201).json({ entry: { date, type, summary, outcome: outcome || null }, total: getCadenceLog(canonicalId).length });
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  const entry = { date, type, summary, outcome: outcome || null };
  if (!company.cadence_history) company.cadence_history = [];
  company.cadence_history.push(entry);

  saveCompanies(COMPANIES);

  res.status(201).json({ entry, total: company.cadence_history.length });
});

app.post("/api/company/:id/stakeholders", (req, res) => {
  const { id } = req.params;
  const { name, role, email, linkedin, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const canonicalId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);

  const stakeholder = { name, role: role || "", email: email || "", linkedin: linkedin || "", notes: notes || "" };
  if (monitored) {
    const stakeholders = getManualList("stakeholders", canonicalId);
    stakeholders.push(stakeholder);
    setManualList("stakeholders", canonicalId, stakeholders);
    return res.status(201).json({ stakeholder, total: stakeholders.length });
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  if (!company.stakeholders) company.stakeholders = [];
  company.stakeholders.push(stakeholder);

  saveCompanies(COMPANIES);

  res.status(201).json({ stakeholder, total: company.stakeholders.length });
});

app.delete("/api/company/:id/stakeholders/:idx", (req, res) => {
  const { id, idx } = req.params;
  const index = parseInt(idx);

  const canonicalId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);
  if (monitored) {
    const stakeholders = getManualList("stakeholders", canonicalId);
    if (index < 0 || index >= stakeholders.length) return res.status(404).json({ error: "Stakeholder not found" });
    stakeholders.splice(index, 1);
    setManualList("stakeholders", canonicalId, stakeholders);
    return res.json({ deleted: true, remaining: stakeholders.length });
  }
  if (!company) return res.status(404).json({ error: "Company not found" });
  if (!company.stakeholders || index < 0 || index >= company.stakeholders.length) {
    return res.status(404).json({ error: "Stakeholder not found" });
  }

  company.stakeholders.splice(index, 1);
  saveCompanies(COMPANIES);

  res.json({ deleted: true, remaining: company.stakeholders.length });
});

app.post("/api/company/:id/competitors", (req, res) => {
  const { id } = req.params;
  const { name, product, strength, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const canonicalId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);

  const competitor = { name, product: product || "", strength: strength || "medium", notes: notes || "" };
  if (monitored) {
    const competitors = getManualList("competitors", canonicalId);
    competitors.push(competitor);
    setManualList("competitors", canonicalId, competitors);
    return res.status(201).json({ competitor, total: competitors.length });
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  if (!company.competitors) company.competitors = [];
  company.competitors.push(competitor);

  saveCompanies(COMPANIES);

  res.status(201).json({ competitor, total: company.competitors.length });
});

app.delete("/api/company/:id/competitors/:idx", (req, res) => {
  const { id, idx } = req.params;
  const index = parseInt(idx);

  const canonicalId = canonicalCompanyId(id);
  const companyNumber = companyNumberFromId(canonicalId);
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id || c.company_number === companyNumber);
  const monitored = company ? null : getMonitoredCompany(companyNumber);
  if (monitored) {
    const competitors = getManualList("competitors", canonicalId);
    if (index < 0 || index >= competitors.length) return res.status(404).json({ error: "Competitor not found" });
    competitors.splice(index, 1);
    setManualList("competitors", canonicalId, competitors);
    return res.json({ deleted: true, remaining: competitors.length });
  }
  if (!company) return res.status(404).json({ error: "Company not found" });
  if (!company.competitors || index < 0 || index >= company.competitors.length) {
    return res.status(404).json({ error: "Competitor not found" });
  }

  company.competitors.splice(index, 1);
  saveCompanies(COMPANIES);

  res.json({ deleted: true, remaining: company.competitors.length });
});

// --- Email Sequence Endpoints ---

app.get("/api/email/templates", (_req, res) => {
  const templates = {};
  for (const motion of getSequenceTemplates()) {
    const tmpl = SEQUENCE_TEMPLATES[motion];
    templates[motion] = tmpl
      ? {
          steps: tmpl.steps.length,
          persona_hooks: Object.keys(tmpl.persona_hooks),
        }
      : {
          steps: 3,
          persona_hooks: ["Auto"],
        };
  }
  const guidance = {
    header_template: "Revolut X [Company Name] - I've done my research",
    lead_with: [
      "Filing-backed operational observation",
      "Main pain linked to that observation",
      "High-priority motions first: Cards, FX, FX Forwards, Merchant Acquiring, Revolut Pay, API Integrations",
    ],
    avoid_leading_with: [
      "Turnover-only framing",
      "Generic capability statements without filing evidence",
      "Lower-priority motions unless evidence is explicit: Spend Management, Monthly Plans",
    ],
    reliable_format: [
      "Observation & Origin",
      "Main Pain Link",
      "Value Path (Suggestions)",
      "Calibrated close question",
    ],
  };

  res.json({ templates, guidance });
});

app.get("/api/email/style-profile", (_req, res) => {
  const stored = getStoredEmailStyleProfile();
  res.json({
    configured: !!(stored && stored.enabled),
    profile: stored || {
      enabled: false,
      name: null,
      description: null,
      style_prompt: null,
      voice_traits: [],
      preferred_patterns: [],
      avoid_patterns: [],
      examples: [],
      version: EMAIL_STYLE_PROFILE_VERSION,
      updated_at: null,
    },
  });
});

app.put("/api/email/style-profile", (req, res) => {
  const normalized = normalizeEmailStyleProfilePayload(req.body || {}, { allowEmpty: false });
  if (!normalized) {
    return res.status(400).json({
      error: "Invalid style profile payload",
      detail: "Provide at least one of: style_prompt, voice_traits, preferred_patterns, avoid_patterns, or examples. Set enabled=false to disable.",
    });
  }

  setSetting(EMAIL_STYLE_PROFILE_SETTING_KEY, normalized);
  res.json({
    saved: true,
    configured: normalized.enabled === true,
    profile: normalized,
  });
});

app.post("/api/email/generate", async (req, res) => {
  const { company_id, stakeholder_name, stakeholder_role, stakeholder_email, motion } = req.body;
  if (!company_id || !stakeholder_name) {
    return res.status(400).json({ error: "company_id and stakeholder_name are required" });
  }

  const companyNumber = resolveCompanyNumberFromInput(company_id);
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  if (isClosedWonCompanyNumber(companyNumber)) {
    return res.status(409).json({
      error: "Company is in closed-won registry and excluded from outreach sequencing.",
      suppressed: true,
      reason: "closed_won_registry",
    });
  }
  const COMPANIES = loadCompanies();
  let company = findCompanyByIdOrNumber(COMPANIES, company_id, normalizedCompanyNumber);

  if (!company && normalizedCompanyNumber) {
    const monitored = getMonitoredCompany(normalizedCompanyNumber);
    if (monitored) {
      company = {
        id: company_id,
        name: formatMonitorName(monitored.company_name, normalizedCompanyNumber),
        company_number: normalizedCompanyNumber,
        turnover: monitored.latest_turnover,
        employee_count: 0,
        industry: "—",
      };
    }
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  let analysis = getSetting(`analysis_${companyNumber}`, null);
  const autoMode = !motion || String(motion).toLowerCase() === "holistic narrative";
  const styleProfile = resolveEmailStyleProfileForRequest(req.body || {});

  if (!analysis || !analysis.level5_extraction) {
    try {
      analysis = await analyseCompany(companyNumber, company.name, company.turnover);
      setSetting(`analysis_${companyNumber}`, analysis);
    } catch (err) {
      console.warn("email/generate: analysis refresh failed:", err.message);
    }
  }

  if (autoMode) {
    try {
      const score = getSetting(`score_${companyNumber}`, null);
      const advanced = await generateFullSequence({
        company: {
          ...company,
          segment: company.segment || "Mid-Market",
        },
        contact: { name: stakeholder_name, role: stakeholder_role || "Director" },
        analysis,
        score,
        motion: null,
        merchantSpend: null,
        styleProfile,
      });

      if (advanced?.needs_enrichment) {
        return res.status(422).json({
          error: advanced.error,
          dossier_tier: advanced.dossier_tier || "D",
          needs_enrichment: true,
          detail: advanced.detail || null,
        });
      }

      if (!advanced.error && Array.isArray(advanced.steps) && advanced.steps.length > 0) {
        const persisted = saveGeneratedSequence({
          companyId: company_id,
          companyName: company.name,
          stakeholderName: stakeholder_name,
          stakeholderRole: stakeholder_role,
          stakeholderEmail: stakeholder_email,
          motion: "Holistic Narrative",
          steps: advanced.steps,
          sequenceStatus: "draft",
        });

        if (persisted) {
          return res.status(201).json({
            sequence_id: persisted.id,
            steps: persisted.steps,
            motion: persisted.motion,
            source: "advanced",
            style_profile_applied: advanced.style_profile_applied === true,
            style_profile_name: advanced.style_profile_name || null,
          });
        }
      }
    } catch (err) {
      if (err?.preventTemplateFallback || err?.code === "EMAIL_RETRY_NEEDED") {
        return res.status(503).json({
          error: "Live email generation is temporarily unavailable. Please retry.",
          retry_needed: true,
          source: "advanced",
          reason: err?.reason || null,
          detail: err?.message || null,
        });
      }
      console.warn("email/generate: advanced path failed, falling back to templates:", err.message);
    }
  }

  const sequence = generateSequence({
    companyId: company_id,
    companyName: company.name,
    stakeholderName: stakeholder_name,
    stakeholderRole: stakeholder_role,
    stakeholderEmail: stakeholder_email,
    motion,
    analysis,
    turnover: company.turnover,
    employeeCount: company.employee_count,
    industry: company.industry,
  });

  if (!sequence) return res.status(400).json({ error: motion ? `No template available for motion: ${motion}` : "Unable to generate sequence" });

  res.status(201).json({ sequence_id: sequence.id, steps: sequence.steps, motion: sequence.motion, source: "template" });
});

app.get("/api/email/sequences/:companyId", (req, res) => {
  const sequences = getSequencesForCompany(req.params.companyId);
  res.json({ sequences });
});

app.post("/api/email/sequences/:companyId/purge-placeholders", (req, res) => {
  const dryRun = req.body?.dry_run === true;
  const result = purgePlaceholderSequencesForCompany(req.params.companyId, { dryRun });
  res.json(result);
});

app.post("/api/email/sequences/:companyId/purge-broken", (req, res) => {
  const dryRun = req.body?.dry_run === true;
  const result = purgeBrokenSequencesForCompany(req.params.companyId, { dryRun });
  res.json(result);
});

app.post("/api/email/sequences/purge-broken", (req, res) => {
  const dryRun = req.body?.dry_run === true;
  const result = purgeBrokenSequences({ dryRun });
  res.json(result);
});

app.get("/api/email/sequence/:id", (req, res) => {
  const sequence = getSequence(req.params.id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  res.json({ sequence });
});

app.patch("/api/email/sequence/:id/step/:stepNumber", (req, res) => {
  const { id, stepNumber } = req.params;
  const { status, subject, body, reviewed } = req.body;
  const numericStep = parseInt(stepNumber, 10);

  if (status) {
    updateStepStatus(id, numericStep, status);
  }
  if (subject !== undefined || body !== undefined) {
    const seq = getSequence(id);
    if (!seq) return res.status(404).json({ error: "Sequence not found" });
    const step = seq.steps.find((s) => s.step_number === numericStep);
    if (!step) return res.status(404).json({ error: "Step not found" });
    updateStepContent(id, numericStep, subject || step.subject, body || step.body);
  }

  if (reviewed === true) {
    markStepReviewed(id, numericStep);
  }

  res.json({ success: true });
});

app.post("/api/email/sequence/:id/step/:stepNumber/review", (req, res) => {
  const { id, stepNumber } = req.params;
  const seq = getSequence(id);
  if (!seq) return res.status(404).json({ error: "Sequence not found" });

  const numericStep = parseInt(stepNumber, 10);
  const step = seq.steps.find((s) => s.step_number === numericStep);
  if (!step) return res.status(404).json({ error: "Step not found" });

  markStepReviewed(id, numericStep);
  res.json({ success: true, sequence_id: id, step_number: numericStep, review_status: "reviewed" });
});

app.delete("/api/email/sequence/:id", (req, res) => {
  deleteSequence(req.params.id);
  res.json({ success: true });
});

// --- Advanced Email Generation (LLM + Archetypes + QC) ---

app.get("/api/email/archetypes", (_req, res) => {
  res.json({ archetypes: ARCHETYPES });
});

app.post("/api/email/generate-advanced", async (req, res) => {
  const { company_id, stakeholder_name, stakeholder_role, stakeholder_email, motion, merchant_spend, force } = req.body;
  if (!company_id || !stakeholder_name) {
    return res.status(400).json({ error: "company_id and stakeholder_name required" });
  }

  const companyNumber = resolveCompanyNumberFromInput(company_id);
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  if (isClosedWonCompanyNumber(companyNumber)) {
    return res.status(409).json({
      error: "Company is in closed-won registry and excluded from outreach sequencing.",
      suppressed: true,
      reason: "closed_won_registry",
    });
  }

  if (!force) {
    const dupCheck = checkDuplicateContact(stakeholder_name, stakeholder_email, company_id);
    if (dupCheck.duplicate) {
      return res.status(409).json({
        error: "Duplicate contact",
        detail: dupCheck.reason,
        existing_sequence: dupCheck.existing?.sequence_id,
        hint: "Set force=true to override, or check /api/email/active-contacts/" + company_id,
      });
    }
  }

  const COMPANIES = loadCompanies();
  let company = findCompanyByIdOrNumber(COMPANIES, company_id, normalizedCompanyNumber);

  if (!company && normalizedCompanyNumber) {
    const monitored = getMonitoredCompany(normalizedCompanyNumber);
    if (monitored) {
      company = {
        id: company_id,
        name: formatMonitorName(monitored.company_name, normalizedCompanyNumber),
        company_number: normalizedCompanyNumber,
        turnover: monitored.latest_turnover,
        employee_count: 0,
        industry: "—",
        segment: "Mid-Market",
      };
    }
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const score = getSetting(`score_${companyNumber}`, null);
  const styleProfile = resolveEmailStyleProfileForRequest(req.body || {});

  try {
    const result = await generateFullSequence({
      company,
      contact: { name: stakeholder_name, role: stakeholder_role || "Director" },
      analysis,
      score,
      motion: motion || null,
      merchantSpend: merchant_spend || null,
      styleProfile,
    });

    if (result.error) {
      const statusCode = result.needs_enrichment ? 422 : 400;
      return res.status(statusCode).json(result);
    }
    registerActiveContact(stakeholder_name, stakeholder_email || null, company_id, result.archetype + "-" + Date.now());
    res.json(result);
  } catch (err) {
    if (err?.preventTemplateFallback || err?.code === "EMAIL_RETRY_NEEDED") {
      return res.status(503).json({
        error: "Live email generation is temporarily unavailable. Please retry.",
        retry_needed: true,
        source: "advanced",
        reason: err?.reason || null,
        detail: err?.message || null,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/email/generate-advanced/shadow", async (req, res) => {
  const { company_id, stakeholder_name, stakeholder_role, motion, merchant_spend, preview_steps } = req.body;
  if (!company_id || !stakeholder_name) {
    return res.status(400).json({ error: "company_id and stakeholder_name required" });
  }

  const companyNumber = resolveCompanyNumberFromInput(company_id);
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  if (isClosedWonCompanyNumber(companyNumber)) {
    return res.status(409).json({
      error: "Company is in closed-won registry and excluded from outreach sequencing.",
      suppressed: true,
      reason: "closed_won_registry",
    });
  }

  const styleProfile = resolveEmailStyleProfileForRequest(req.body || {}, { forceStored: true });
  if (!styleProfile) {
    return res.status(400).json({
      error: "No enabled style profile configured",
      hint: "PUT /api/email/style-profile or provide style_profile in the request payload.",
    });
  }

  const COMPANIES = loadCompanies();
  let company = findCompanyByIdOrNumber(COMPANIES, company_id, normalizedCompanyNumber);

  if (!company && normalizedCompanyNumber) {
    const monitored = getMonitoredCompany(normalizedCompanyNumber);
    if (monitored) {
      company = {
        id: company_id,
        name: formatMonitorName(monitored.company_name, normalizedCompanyNumber),
        company_number: normalizedCompanyNumber,
        turnover: monitored.latest_turnover,
        employee_count: 0,
        industry: "—",
        segment: "Mid-Market",
      };
    }
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const score = getSetting(`score_${companyNumber}`, null);
  const preferredCadence = buildShadowPreviewCadence(preview_steps, req.body?.dossier_tier);

  try {
    const baseline = await generateFullSequence({
      company,
      contact: { name: stakeholder_name, role: stakeholder_role || "Director" },
      analysis,
      score,
      motion: motion || null,
      merchantSpend: merchant_spend || null,
      preferredCadence,
      styleProfile: null,
    });

    const styled = await generateFullSequence({
      company,
      contact: { name: stakeholder_name, role: stakeholder_role || "Director" },
      analysis,
      score,
      motion: motion || null,
      merchantSpend: merchant_spend || null,
      preferredCadence,
      styleProfile,
    });

    if (baseline?.error || styled?.error) {
      return res.status(422).json({
        error: "Unable to generate one or more shadow variants",
        baseline_error: baseline?.error || null,
        styled_error: styled?.error || null,
        baseline,
        styled,
      });
    }

    const comparison = buildShadowSequenceComparison(baseline, styled);
    res.json({
      preview: {
        steps: preferredCadence.steps,
        dossier_tier: preferredCadence.dossier_tier,
      },
      style_profile: {
        name: styleProfile.name || null,
        enabled: true,
      },
      baseline,
      styled,
      comparison,
    });
  } catch (err) {
    if (err?.preventTemplateFallback || err?.code === "EMAIL_RETRY_NEEDED") {
      return res.status(503).json({
        error: "Live shadow generation is temporarily unavailable. Please retry.",
        retry_needed: true,
        source: "advanced_shadow",
        reason: err?.reason || null,
        detail: err?.message || null,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/email/validate", (req, res) => {
  const {
    subject,
    body,
    is_initial,
    step_type,
    followups_last_24h,
    followups_last_7d,
    assume_managed_footer,
  } = req.body;
  if (!body) return res.status(400).json({ error: "body is required" });

  const result = validateEmail(
    { subject: subject || "", body },
    {
      isInitialOutreach: is_initial !== false,
      stepType: step_type || null,
      followupsLast24h: Number(followups_last_24h || 0),
      followupsLast7d: Number(followups_last_7d || 0),
      assumeManagedFooter: assume_managed_footer !== false,
    }
  );
  res.json(result);
});

app.post("/api/email/check-exclusion", (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: "company_id required" });

  const companyNumber = resolveCompanyNumberFromInput(company_id);
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  const COMPANIES = loadCompanies();
  let company = findCompanyByIdOrNumber(COMPANIES, company_id, normalizedCompanyNumber);

  if (!company && normalizedCompanyNumber) {
    const monitored = getMonitoredCompany(normalizedCompanyNumber);
    if (monitored) {
      company = { turnover: monitored.latest_turnover, status: monitored.status, industry: "—" };
    }
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const result = isCompanyExcluded(company, analysis);
  res.json(result);
});

app.get("/api/email/triggers/:companyId", (req, res) => {
  const companyNumber = req.params.companyId.replace("ch-", "");
  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const score = getSetting(`score_${companyNumber}`, null);

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === req.params.companyId) || { turnover: 0, industry: "—" };

  const triggers = detectTriggers(company, analysis, score);
  const archetype = selectArchetype(triggers, analysis, company);
  res.json({ triggers, recommended_archetype: archetype });
});

// --- Active Contacts (Duplicate Detection) ---

app.get("/api/email/active-contacts/:companyId", (req, res) => {
  const contacts = getActiveContactsForCompany(req.params.companyId);
  res.json({ contacts, count: contacts.length });
});

// --- Stakeholder Assessment ---

app.get("/api/stakeholders/:companyId", (req, res) => {
  const companyId = canonicalCompanyId(req.params.companyId);
  const companyNumber = companyNumberFromId(companyId);
  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const score = getSetting(`score_${companyNumber}`, null);

  const COMPANIES = loadCompanies();
  let company = COMPANIES.find((c) => c.id === req.params.companyId || c.company_number === companyNumber);
  if (!company) {
    const monitored = getMonitoredCompany(companyNumber);
    if (monitored) company = { id: companyId, name: formatMonitorName(monitored.company_name, companyNumber), turnover: monitored.latest_turnover };
  }
  if (!company) company = { name: pendingCompanyName() };
  const assessment = buildStakeholderAssessment(companyId, company, analysis, score);

  res.json({
    readiness: assessment.readiness,
    stakeholders: assessment.stakeholders,
    active_contacts: assessment.active_contacts,
    company_name: company.name,
    source: "companies_house_filing",
    filing_date: analysis?.analysed_at,
    primary_motion: assessment.primary_motion,
    note: "Stakeholders scored on 5 dimensions: decision_authority (0-30), relevance (0-25), reachability (0-20), timing (0-15), influence_network (0-10). Final score = composite × data_confidence.",
  });
});

app.post("/api/stakeholders/:companyId/review", async (req, res) => {
  try {
    const review = await runStakeholderReview(req.params.companyId);
    if (!review) return res.status(404).json({ error: "Company not found" });
    res.json(review);
  } catch (err) {
    res.status(500).json({ error: "Stakeholder review failed", detail: err.message });
  }
});

app.get("/api/company/:id/supplementary-context", async (req, res) => {
  const canonicalId = canonicalCompanyId(req.params.id);
  const companyNumber = companyNumberFromId(canonicalId);

  const monitored = getMonitoredCompany(companyNumber);
  const companies = loadCompanies();
  const company = companies.find((c) => c.id === req.params.id || c.company_number === companyNumber);
  const companyName = company?.name || monitored?.company_name || pendingCompanyName();
  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const filingText = getFilingsForCompany(companyNumber, 3).find((f) => f.raw_data)?.raw_data || "";

  try {
    const context = await getSupplementaryContext({
      companyName,
      companyWebsite: company?.website || company?.website_url || null,
      companyDomain: company?.domain || company?.company_domain || null,
      analysis,
      filingText,
    });

    res.json({
      company_id: canonicalId,
      company_number: companyNumber,
      context,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to build supplementary context", detail: err.message });
  }
});

app.get("/api/company/:id/enrichment", (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.query || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  const includeData = parseBooleanInput(req.query.include_data, false);
  const snapshot = getCompanyEnrichmentSnapshot(context.company_number, { includeData });

  res.json({
    company_id: context.canonical_id,
    company_number: context.company_number,
    company_name: context.company_name,
    enrichment: snapshot,
  });
});

app.post("/api/company/:id/enrichment/refresh", async (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.body || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  const deepScanOptions = resolveEnrichmentDeepScanOptions(req.body || {}, TECH_ENRICHMENT_RUNTIME.deep_scan_mode);

  try {
    const result = await runCompanyTechEnrichment({
      companyNumber: context.company_number,
      companyName: context.company_name,
      companyWebsite: context.company_website,
      companyDomain: context.company_domain,
      turnover: context.turnover,
      force: parseBooleanInput(req.body?.force, false),
      ...deepScanOptions,
      maxPages: req.body?.max_pages,
      refreshWindowDays: req.body?.refresh_window_days,
      timeoutMs: req.body?.timeout_ms,
    });

    const baseScore = scoreCompany(context.company_number);
    const storedAnalysis = getSetting(`analysis_${context.company_number}`, null);
    const score = baseScore
      ? (storedAnalysis ? integrateAnalysis(baseScore, storedAnalysis) : baseScore)
      : null;

    const snapshot = getCompanyEnrichmentSnapshot(context.company_number, { includeData: false });

    res.json({
      company_id: context.canonical_id,
      company_number: context.company_number,
      company_name: context.company_name,
      enrichment_run: result,
      enrichment: snapshot,
      score,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to refresh enrichment", detail: err.message });
  }
});

app.get("/api/company/:id/ownership", (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.query || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  const ownershipStructure = getSetting(`ownership_${context.company_number}`, null);
  res.json({
    company_id: context.canonical_id,
    company_number: context.company_number,
    company_name: context.company_name,
    ownership_structure: ownershipStructure,
  });
});

app.post("/api/company/:id/ownership/refresh", async (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.body || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  const refreshResult = await refreshOwnershipEnvelope(context.company_number);
  const ownershipStructure = getSetting(`ownership_${context.company_number}`, null);

  res.json({
    company_id: context.canonical_id,
    company_number: context.company_number,
    company_name: context.company_name,
    ownership_refresh: refreshResult,
    ownership_structure: ownershipStructure,
  });
});

app.get("/api/company/:id/website-resolution", (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.query || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  const resolution = getWebsiteResolution(context.company_number, null);
  const monitored = getMonitoredCompany(context.company_number);

  res.json({
    company_id: context.canonical_id,
    company_number: context.company_number,
    company_name: context.company_name,
    website_resolution: resolution,
    monitored_company: {
      company_website: monitored?.company_website || context.company_website || null,
      company_domain: monitored?.company_domain || context.company_domain || null,
    },
  });
});

app.post("/api/company/:id/website-resolution", async (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.body || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  try {
    const resolution = await resolveCompanyWebsite({
      companyNumber: context.company_number,
      companyName: context.company_name,
      companyWebsite: context.company_website,
      companyDomain: context.company_domain,
      enableNameGuesses: parseBooleanInput(req.body?.discover_website, true),
      force: parseBooleanInput(req.body?.force, false),
      timeoutMs: req.body?.timeout_ms,
      maxCandidates: req.body?.max_candidates,
    });

    const shouldClearHints = parseBooleanInput(req.body?.force_clear_hints, false)
      && (resolution?.status === "no_site_confirmed" || resolution?.status === "unresolved")
      && !resolution?.website_url
      && !resolution?.domain;

    if (resolution?.website_url || resolution?.domain) {
      upsertMonitoredCompany({
        company_number: context.company_number,
        company_name: context.company_name,
        latest_turnover: context.monitored?.latest_turnover ?? context.turnover,
        status: context.monitored?.status || "active",
        source: context.monitored?.source || "website_resolution_api",
        company_website: resolution.website_url || context.monitored?.company_website || null,
        company_domain: resolution.domain || context.monitored?.company_domain || null,
      });
    } else if (shouldClearHints) {
      clearMonitoredCompanyWebsiteHints(context.company_number);
    }

    const monitored = getMonitoredCompany(context.company_number);

    res.json({
      company_id: context.canonical_id,
      company_number: context.company_number,
      company_name: context.company_name,
      website_resolution: resolution,
      monitored_company: {
        company_website: monitored?.company_website || context.company_website || null,
        company_domain: monitored?.company_domain || context.company_domain || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Website resolution failed", detail: err?.message || "unknown_error" });
  }
});

app.post("/api/company/:id/website-resolution/manual", (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.body || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  try {
    const resolution = setManualWebsiteResolution({
      companyNumber: context.company_number,
      companyName: context.company_name,
      status: req.body?.status,
      companyWebsite: req.body?.company_website || req.body?.website || req.body?.website_url || null,
      companyDomain: req.body?.company_domain || req.body?.domain || null,
      confidenceScore: req.body?.confidence_score,
      nextRetryAt: req.body?.next_retry_at,
      note: req.body?.note,
    });

    if (resolution?.status === "invalid_input") {
      return res.status(400).json(resolution);
    }

    const shouldClearHints = resolution?.status === "no_site_confirmed"
      || resolution?.status === "unresolved";

    if (resolution?.website_url || resolution?.domain) {
      upsertMonitoredCompany({
        company_number: context.company_number,
        company_name: context.company_name,
        latest_turnover: context.monitored?.latest_turnover ?? context.turnover,
        status: context.monitored?.status || "active",
        source: context.monitored?.source || "website_resolution_manual",
        company_website: resolution.website_url || context.monitored?.company_website || null,
        company_domain: resolution.domain || context.monitored?.company_domain || null,
      });
    } else if (shouldClearHints) {
      clearMonitoredCompanyWebsiteHints(context.company_number);
    }

    const monitored = getMonitoredCompany(context.company_number);

    res.json({
      company_id: context.canonical_id,
      company_number: context.company_number,
      company_name: context.company_name,
      website_resolution: resolution,
      monitored_company: {
        company_website: monitored?.company_website || context.company_website || null,
        company_domain: monitored?.company_domain || context.company_domain || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Manual website resolution failed", detail: err?.message || "unknown_error" });
  }
});

app.post("/api/enrichment/tech-stack/batch", async (req, res) => {
  const force = parseBooleanInput(req.body?.force, false);
  const deepScanOptions = resolveEnrichmentDeepScanOptions(req.body || {}, TECH_ENRICHMENT_RUNTIME.deep_scan_mode);
  const limit = Math.max(1, Math.min(Number.parseInt(String(req.body?.limit || "25"), 10) || 25, 200));

  const requested = Array.isArray(req.body?.companies) ? req.body.companies : null;
  const targets = [];

  if (requested && requested.length > 0) {
    for (const item of requested.slice(0, limit)) {
      const candidate = typeof item === "string"
        ? { company_number: item }
        : (item || {});
      const candidateId = candidate.company_id || candidate.id || candidate.company_number;
      if (!candidateId) continue;

      const context = resolveCompanyContextForEnrichment(candidateId, candidate);
      if (!context) {
        targets.push({
          company_number: String(candidate.company_number || candidateId),
          company_name: toOptionalString(candidate.company_name) || null,
          company_website: toOptionalString(candidate.company_website || candidate.website),
          company_domain: toOptionalString(candidate.company_domain || candidate.domain),
          turnover: toOptionalNumber(candidate.turnover),
          unresolved: true,
        });
        continue;
      }
      targets.push(context);
    }
  } else {
    const shortlist = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit });
    for (const company of shortlist) {
      targets.push({
        canonical_id: `ch-${company.company_number}`,
        company_number: company.company_number,
        company_name: formatMonitorName(company.company_name, company.company_number),
        company_website: null,
        company_domain: null,
        turnover: company.latest_turnover || null,
        monitored: company,
      });
    }
  }

  const results = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of targets.slice(0, limit)) {
    if (target.unresolved) {
      skipped += 1;
      results.push({
        company_number: target.company_number,
        company_name: target.company_name,
        status: "unresolved_company",
        updated: false,
      });
      continue;
    }

    try {
      const run = await runCompanyTechEnrichment({
        companyNumber: target.company_number,
        companyName: target.company_name,
        companyWebsite: target.company_website,
        companyDomain: target.company_domain,
        turnover: target.turnover,
        force,
        ...deepScanOptions,
        maxPages: req.body?.max_pages,
        refreshWindowDays: req.body?.refresh_window_days,
        timeoutMs: req.body?.timeout_ms,
      });

      if (run.updated) {
        updated += 1;
        const baseScore = scoreCompany(target.company_number);
        const storedAnalysis = getSetting(`analysis_${target.company_number}`, null);
        if (baseScore && storedAnalysis) {
          integrateAnalysis(baseScore, storedAnalysis);
        }
      } else {
        skipped += 1;
      }

      results.push({
        company_number: target.company_number,
        company_name: target.company_name,
        status: run.status,
        updated: run.updated === true,
        technologies: Array.isArray(run.technologies) ? run.technologies.slice(0, 10) : [],
        site_currencies: Array.isArray(run.site_currencies) ? run.site_currencies.slice(0, 8) : [],
      });
    } catch (err) {
      failed += 1;
      results.push({
        company_number: target.company_number,
        company_name: target.company_name,
        status: "error",
        updated: false,
        error: err.message,
      });
    }
  }

  res.json({
    requested: requested ? requested.length : targets.length,
    processed: results.length,
    updated,
    skipped,
    failed,
    results,
  });
});

// --- YAMM Export & Sequence Management ---

function extractClaimsFromBody(body) {
  const text = String(body || "");
  if (!text) return [];
  const claims = [];
  const pattern = /(?:£\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|b|million|billion))?|\b\d+(?:\.\d+)?%)/gi;
  for (const match of text.matchAll(pattern)) {
    const value = String(match[0] || "").trim();
    if (value && !claims.includes(value)) claims.push(value);
  }
  return claims;
}

function buildConsentStatus(body) {
  const text = String(body || "").toLowerCase();
  const opt_out_present = [
    "opt out",
    "unsubscribe",
    "stop receiving",
    "remove me",
    "do not wish to receive",
  ].some((needle) => text.includes(needle));
  const privacy_notice_present = [
    "privacy notice",
    "privacy policy",
    "data protection",
    "gdpr",
  ].some((needle) => text.includes(needle));
  return {
    opt_out_present,
    privacy_notice_present,
    consent_basis: "legitimate_interest_b2b",
  };
}

function deriveValidationResults(step, subject, body) {
  const gates = step?.quality_gates && typeof step.quality_gates === "object" ? step.quality_gates : null;
  const metrics = step?.metrics && typeof step.metrics === "object" ? step.metrics : {};

  if (gates?.gate1 && gates?.gate2 && gates?.gate3) {
    return {
      gate1_pass: gates.gate1.pass === true,
      gate2_pass: gates.gate2.pass === true,
      gate3_pass: gates.gate3.pass === true,
      voice_percent: Number.isFinite(Number(step?.voice_percent))
        ? Number(step.voice_percent)
        : Number.isFinite(Number(metrics.voice_percent))
          ? Number(metrics.voice_percent)
          : Number.isFinite(Number(gates.gate2?.metrics?.voice_percent))
            ? Number(gates.gate2.metrics.voice_percent)
            : null,
      citation_density: Number.isFinite(Number(metrics.citation_density))
        ? Number(metrics.citation_density)
        : Number.isFinite(Number(gates.gate1?.metrics?.citation_density))
          ? Number(gates.gate1.metrics.citation_density)
          : null,
      research_density: Number.isFinite(Number(metrics.research_density))
        ? Number(metrics.research_density)
        : Number.isFinite(Number(gates.gate1?.metrics?.research_density))
          ? Number(gates.gate1.metrics.research_density)
          : null,
    };
  }

  const qc = validateEmail(
    { subject: subject || "", body: body || "" },
    {
      isInitialOutreach: Number(step?.step_number) === 1,
      assumeManagedFooter: true,
    }
  );
  return {
    gate1_pass: qc.gates?.gate1?.pass === true,
    gate2_pass: qc.gates?.gate2?.pass === true,
    gate3_pass: qc.gates?.gate3?.pass === true,
    voice_percent: Number.isFinite(Number(qc.metrics?.voice_percent)) ? Number(qc.metrics.voice_percent) : null,
    citation_density: Number.isFinite(Number(qc.metrics?.citation_density)) ? Number(qc.metrics.citation_density) : null,
    research_density: Number.isFinite(Number(qc.metrics?.research_density)) ? Number(qc.metrics.research_density) : null,
  };
}

function resolveSequenceSuppression(sequence) {
  const companyNumber = normalizeCompanyNumber(companyNumberFromId(canonicalCompanyId(sequence?.company_id)));
  const email = String(sequence?.stakeholder_email || "").trim() || null;
  return isContactSuppressed({
    company_number: companyNumber,
    email,
  });
}

function recordAuditForExportRows(rows, sequencesById, exportFormat, suppressionBySequenceId = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const exportedAt = new Date().toISOString();
  const aeOwner = String(getSetting("sender_name", "") || "");

  for (const row of rows) {
    const sequence = sequencesById.get(row.sequence_id);
    const stepNumber = Number(row.step_number);
    if (!sequence || !Number.isFinite(stepNumber)) continue;
    const step = (sequence.steps || []).find((item) => Number(item.step_number) === stepNumber);
    if (!step) continue;

    const subject = step.subject || row.subject || "";
    const body = step.body || row.body || "";
    const validationResults = deriveValidationResults(step, subject, body);
    const consentStatus = buildConsentStatus(row.body || body);
    const suppression = suppressionBySequenceId?.[sequence.id] || suppressionBySequenceId?.[row.sequence_id] || null;
    if (suppression) {
      consentStatus.suppressed = true;
      consentStatus.suppression_reason = suppression.reason || null;
      consentStatus.suppression_source = suppression.source || null;
    }
    const claims = extractClaimsFromBody(row.body || body);

    recordEmailAudit({
      exported_at: exportedAt,
      sequence_id: sequence.id,
      company_id: sequence.company_id || null,
      company_name: sequence.company_name || row.company_name || null,
      stakeholder_name: sequence.stakeholder_name || row.stakeholder_name || null,
      stakeholder_email: sequence.stakeholder_email || row.stakeholder_email || null,
      ae_owner: aeOwner,
      step_number: stepNumber,
      step_type: step.step_type || null,
      subject,
      body,
      scheduled_date: row.scheduled_date || null,
      scheduled_time: row.scheduled_time || null,
      qc_score: Number.isFinite(Number(step.qc_score)) ? Number(step.qc_score) : null,
      voice_percent: Number.isFinite(Number(step.voice_percent)) ? Number(step.voice_percent) : null,
      validation_results_json: JSON.stringify(validationResults),
      claims_json: JSON.stringify(claims),
      consent_status_json: JSON.stringify(consentStatus),
      export_format: exportFormat,
    });
  }
}

function parseAuditJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function resolveSuppressionTypeAndValue(payload = {}) {
  const directType = String(payload.type || "").trim().toLowerCase();
  const directValue = String(payload.value || "").trim();
  if (directType && directValue) {
    return { type: directType, value: directValue };
  }
  if (String(payload.email || "").trim()) {
    return { type: "email", value: String(payload.email).trim() };
  }
  if (String(payload.company_number || "").trim()) {
    return { type: "company_number", value: String(payload.company_number).trim() };
  }
  if (String(payload.domain || "").trim()) {
    return { type: "domain", value: String(payload.domain).trim() };
  }
  return null;
}

app.get("/api/suppression", (req, res) => {
  const type = req.query.type ? String(req.query.type).trim() : undefined;
  return res.json({
    total: getSuppressionCount(),
    suppressions: listSuppressions({ type }),
  });
});

app.post("/api/suppression", (req, res) => {
  const resolved = resolveSuppressionTypeAndValue(req.body || {});
  if (!resolved) return res.status(400).json({ error: "No valid suppression type/value provided" });

  const row = addSuppression({
    type: resolved.type,
    value: resolved.value,
    reason: req.body?.reason || "manual",
    source: req.body?.source || "manual_flag",
    company_name: req.body?.company_name,
    notes: req.body?.notes,
  });
  if (!row) return res.status(400).json({ error: "No valid suppression type/value provided" });

  return res.json({ added: row });
});

app.post("/api/suppression/upload", (req, res) => {
  const csvContent = String(req.body?.csv_content || "");
  if (!csvContent.trim()) {
    return res.status(400).json({ error: "csv_content is required" });
  }

  const parsedRows = parseSuppressionRowsFromCsv(csvContent);
  if (parsedRows.length === 0) {
    return res.status(400).json({ error: "No valid suppression rows found" });
  }

  let stored = 0;
  const types = { email: 0, company_number: 0 };

  for (const row of parsedRows) {
    const saved = addSuppression({
      type: row.type,
      value: row.value,
      reason: req.body?.reason || "opt_out",
      source: req.body?.source || "csv_upload",
      company_name: row.company_name,
    });
    if (!saved) continue;
    stored += 1;
    if (saved.type === "email") types.email += 1;
    if (saved.type === "company_number") types.company_number += 1;
  }

  if (stored === 0) {
    return res.status(400).json({ error: "No valid suppression rows found" });
  }

  return res.json({
    received: parsedRows.length,
    stored,
    skipped_invalid: parsedRows.length - stored,
    types,
  });
});

app.delete("/api/suppression/:id", (req, res) => {
  return res.json({ removed: removeSuppression(req.params.id) });
});

app.get("/api/email/export/csv/:sequenceId", (req, res) => {
  const exported = exportSequenceForYAMM(req.params.sequenceId, {
    startDate: req.query.start_date,
    senderName: req.query.sender_name || getSetting("sender_name", "[Your Name]"),
    title: req.query.title || "Account Executive",
    sendTime: req.query.send_time || "08:37",
  });
  if (!exported) return res.status(404).json({ error: "Sequence not found" });
  if (exported.blocked) {
    return res.status(409).json({
      error: "Manual review required before CSV export",
      detail: exported.metadata,
    });
  }

  try {
    const sequence = getSequence(req.params.sequenceId);
    const sequencesById = new Map();
    const suppressionBySequenceId = {};
    if (sequence?.id) {
      sequencesById.set(sequence.id, sequence);
      const suppression = resolveSequenceSuppression(sequence);
      if (suppression) {
        suppressionBySequenceId[sequence.id] = suppression;
      }
    }
    recordAuditForExportRows(exported.rows, sequencesById, "csv", suppressionBySequenceId);
    if (sequence?.id && suppressionBySequenceId[sequence.id]) {
      const csv = generateCSV([]);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="sequence-${req.params.sequenceId}.csv"`);
      res.setHeader("X-Suppressed", "true");
      return res.send(csv);
    }
  } catch (err) {
    console.warn("[email-audit] Unable to record CSV export audit", err?.message || err);
  }

  const csv = generateCSV(exported.rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sequence-${req.params.sequenceId}.csv"`);
  res.send(csv);
});

app.get("/api/email/export/json/:sequenceId", (req, res) => {
  const exported = exportSequenceForYAMM(req.params.sequenceId, {
    startDate: req.query.start_date,
    senderName: req.query.sender_name || getSetting("sender_name", "[Your Name]"),
    title: req.query.title || "Account Executive",
    sendTime: req.query.send_time || "08:37",
  });
  if (!exported) return res.status(404).json({ error: "Sequence not found" });
  if (exported.blocked) {
    return res.status(409).json({
      error: "Manual review required before export",
      metadata: exported.metadata,
    });
  }

  let suppressionForSequence = null;
  let suppressedRecipient = null;
  try {
    const sequence = getSequence(req.params.sequenceId);
    const sequencesById = new Map();
    const suppressionBySequenceId = {};
    if (sequence?.id) {
      sequencesById.set(sequence.id, sequence);
      suppressionForSequence = resolveSequenceSuppression(sequence);
      if (suppressionForSequence) {
        suppressionBySequenceId[sequence.id] = suppressionForSequence;
      }
      suppressedRecipient = {
        company_number: normalizeCompanyNumber(companyNumberFromId(canonicalCompanyId(sequence.company_id))),
        email: String(sequence.stakeholder_email || "").trim() || null,
      };
    }
    recordAuditForExportRows(exported.rows, sequencesById, "json", suppressionBySequenceId);
  } catch (err) {
    console.warn("[email-audit] Unable to record JSON export audit", err?.message || err);
  }

  if (suppressionForSequence) {
    return res.json({
      metadata: {
        ...exported.metadata,
        suppressed: true,
        suppression_reason: suppressionForSequence.reason || null,
        suppression_source: suppressionForSequence.source || null,
        suppressed_recipient: suppressedRecipient || { company_number: null, email: null },
      },
      sheets_data: [],
      raw_rows: [],
    });
  }

  res.json({
    metadata: exported.metadata,
    sheets_data: generateGoogleSheetsJSON(exported.rows),
    raw_rows: exported.rows,
  });
});

app.get("/api/email/export/company/:companyId", (req, res) => {
  const exported = exportMultipleSequencesForYAMM(req.params.companyId, {
    startDate: req.query.start_date,
    senderName: req.query.sender_name || getSetting("sender_name", "[Your Name]"),
    title: req.query.title || "Account Executive",
    sendTime: req.query.send_time || "08:37",
  });
  if (!exported) return res.status(404).json({ error: "No sequences found" });
  const rows = exported.rows || [];

  try {
    const sequences = getSequencesForCompany(req.params.companyId) || [];
    const sequencesById = new Map(sequences.map((seq) => [seq.id, seq]));
    const suppressionBySequenceId = {};
    for (const sequence of sequences) {
      const suppression = resolveSequenceSuppression(sequence);
      if (suppression) suppressionBySequenceId[sequence.id] = suppression;
    }
    recordAuditForExportRows(rows, sequencesById, req.query.format === "csv" ? "csv" : "json", suppressionBySequenceId);

    const keptRows = rows.filter((row) => !suppressionBySequenceId[row.sequence_id]);
    const suppressedRecipients = Object.entries(suppressionBySequenceId).map(([sequenceId, suppression]) => {
      const sequence = sequencesById.get(sequenceId) || {};
      return {
        sequence_id: sequenceId,
        company_number: normalizeCompanyNumber(companyNumberFromId(canonicalCompanyId(sequence.company_id))),
        email: String(sequence.stakeholder_email || "").trim() || null,
        reason: suppression.reason || null,
      };
    });

    if (req.query.format === "csv") {
      const csv = generateCSV(keptRows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="company-${req.params.companyId}-sequences.csv"`);
      return res.send(csv);
    }

    return res.json({
      total_emails: keptRows.length,
      needs_email: keptRows.filter((r) => r.needs_email).length,
      blocked_sequences: exported.blocked_sequences || [],
      sheets_data: generateGoogleSheetsJSON(keptRows),
      suppressed_recipients: suppressedRecipients,
    });
  } catch (err) {
    console.warn("[email-audit] Unable to record company export audit", err?.message || err);
  }

  if (req.query.format === "csv") {
    const csv = generateCSV(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="company-${req.params.companyId}-sequences.csv"`);
    return res.send(csv);
  }

  res.json({
    total_emails: rows.length,
    needs_email: rows.filter((r) => r.needs_email).length,
    blocked_sequences: exported.blocked_sequences || [],
    sheets_data: generateGoogleSheetsJSON(rows),
  });
});

app.get("/api/email/audit/:sequenceId", (req, res) => {
  const sequence_id = String(req.params.sequenceId || "");
  const records = getEmailAuditLog({ sequence_id }).map((record) => {
    const {
      validation_results_json,
      claims_json,
      consent_status_json,
      ...rest
    } = record;
    return {
      ...rest,
      validation_results: parseAuditJson(validation_results_json, {}),
      claims: parseAuditJson(claims_json, []),
      consent_status: parseAuditJson(consent_status_json, {}),
    };
  });

  res.json({
    sequence_id,
    records,
  });
});

app.post("/api/email/sequence/:id/reply", (req, res) => {
  const { reply_type } = req.body;
  if (!["positive", "negative", "ooo", "wrong_person", "send_info"].includes(reply_type)) {
    return res.status(400).json({ error: "reply_type must be: positive, negative, ooo, wrong_person, send_info" });
  }

  const result = pauseSequenceOnReply(req.params.id, reply_type);
  res.json(result);
});

app.post("/api/email/sequence/:id/resume", (req, res) => {
  const result = resumeSequence(req.params.id);
  res.json(result);
});

app.patch("/api/email/sequence/:id/stakeholder", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const seq = getSequence(req.params.id);
  if (!seq) return res.status(404).json({ error: "Sequence not found" });

  import("./db.js").then(({ default: database }) => {
    database.prepare("UPDATE email_sequences SET stakeholder_email = ?, updated_at = datetime('now') WHERE id = ?").run(email, req.params.id);
    res.json({ success: true, email });
  });
});

// --- Enhanced Scoring with LLM ---

app.post("/api/score/company-llm", async (req, res) => {
  const { company_number } = req.body;
  if (!company_number) return res.status(400).json({ error: "company_number required" });

  try {
    const result = await scoreCompanyWithLLM(company_number);
    if (!result) return res.status(404).json({ error: "Company not found in monitor" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/score/batch-llm", async (req, res) => {
  const { limit, concurrency } = req.body;
  const companies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit: limit || 20 });

  try {
    const results = await batchScoreWithLLM(companies, concurrency || 2);
    res.json({
      scored: results.length,
      top_10: results.slice(0, 10).map((r) => ({
        company_number: r.company_number,
        name: r.company_name,
        turnover: r.turnover,
        composite_score: r.composite_score,
        best_motion: r.layers.product_fit.best_motion,
        product_fit: r.layers.product_fit.score,
        growth: r.growth.trend,
        llm_integrated: r.llm_integrated || false,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Serve frontend in production ---

const frontendDist = path.join(REPO_ROOT, "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  console.log("Serving frontend from", frontendDist);
}

// --- Weekly Report Auto-Generation (Saturday evenings) ---

function getNextSaturdayEvening() {
  return getNextWeeklyZonedRun({
    timeZone: UK_TIMEZONE,
    targetWeekday: 6,
    hour: 18,
    minute: 0,
    second: 0,
  });
}

function scheduleWeeklyReport() {
  const nextRun = getNextSaturdayEvening();
  const delay = nextRun.getTime() - Date.now();

  console.log(`Weekly report scheduled for: ${nextRun.toISOString()} (${UK_TIMEZONE} Saturday 18:00, in ${Math.round(delay / 3600000)}h)`);

  setTimeout(async () => {
    await generateAndSaveWeeklyReport();
    scheduleWeeklyReport();
  }, delay);
}

async function generateAndSaveWeeklyReport() {
  try {
    const COMPANIES = loadCompanies();
    const now = new Date();
    const weekLabel = getWeekLabel(now);

    const existing = getReportByWeek(weekLabel);
    if (existing) {
      console.log(`Weekly report for ${weekLabel} already exists, skipping.`);
      return;
    }

    pruneHistoricMonthlyFilingsBefore(getHistoricBackfillCutoffPeriod(now));
    const snapshot = await generateReportSnapshot(COMPANIES);
    const report = {
      id: `report-${weekLabel}`,
      week_label: weekLabel,
      generated_at: now.toISOString(),
      companies: snapshot,
    };

    dbSaveReport(report);
    console.log(`Weekly report generated: ${report.id} (${snapshot.length} companies)`);
  } catch (err) {
    console.error("Failed to auto-generate weekly report:", err.message);
  }
}


export function authStartupRefusalReason(env = process.env, authConfigured = isAuthConfigured()) {
  if (String(env?.NODE_ENV || "").toLowerCase() === "production" && !authConfigured) {
    return "NODE_ENV=production but no auth password is configured. Set one via POST /api/auth/setup (or your bootstrap process) before starting; the server refuses to start unauthenticated in production.";
  }
  return null;
}

function startServer() {
  const refusal = authStartupRefusalReason();
  if (refusal) {
    console.error(`[startup] Refusing to start: ${refusal}`);
    process.exit(1);
  }

  app.listen(PORT, () => {
    runMigrations();
    console.log(`Prospector running on http://localhost:${PORT}`);
    console.log(`LLM: ${isLLMConfigured() ? "configured" : "mock mode (set OPENAI_API_KEY to enable)"}`);
    console.log(`Auth: ${isAuthConfigured() ? "password set" : "OPEN (set password via /api/auth/setup)"}`);
    console.log(`Filings: ${getFilingCount()} stored, ${getMonitoredCompanyCount()} companies monitored`);

    if (LIGHTWEIGHT_RUNTIME) {
      console.log("Runtime profile: lightweight (background workers/schedulers disabled)");
      console.log("Analysis queue: disabled in lightweight runtime");
      console.log("Analysis auto-seed: disabled in lightweight runtime");
      console.log("Tech enrichment auto-refresh: disabled in lightweight runtime");
      console.log("Daily auto-pull: disabled in lightweight runtime");
      console.log("Stale filing monitor: disabled in lightweight runtime");
      console.log("Ownership stale monitor: disabled in lightweight runtime");
      console.log("Backfill autorun: disabled in lightweight runtime");
      return;
    }

    const queueStatus = startAnalysisQueueWorker();
    console.log(`Analysis queue: enabled (${queueStatus.batch_size} per batch every ${queueStatus.interval_ms}ms), recovered ${queueStatus.recovered_processing_items} in-flight items`);

    const reconciledQueueRows = reconcileAnalysisQueueWithStoredAnalyses();
    if (reconciledQueueRows > 0) {
      console.log(`Analysis queue: reconciled ${reconciledQueueRows} queued/failed item(s) to ready using existing stored analyses`);
    }

    const seederStatus = startShortlistBackgroundSeeder();
    console.log(`Analysis auto-seed: enabled (${seederStatus.max_enqueue} max queued every ${seederStatus.interval_ms}ms, queue soft/hard cap ${seederStatus.queue_soft_cap}/${seederStatus.queue_hard_cap})`);

    const techEnrichmentSeederStatus = startTechEnrichmentSeeder();
    if (techEnrichmentSeederStatus.enabled) {
      console.log(
        `Tech enrichment auto-refresh: enabled (${techEnrichmentSeederStatus.max_refresh} max refresh every ${techEnrichmentSeederStatus.interval_ms}ms, deep scan mode ${techEnrichmentSeederStatus.deep_scan_mode})`
      );
    } else {
      console.log("Tech enrichment auto-refresh: disabled (set TECH_ENRICHMENT_SEED_ENABLED=true to enable)");
    }

    scheduleWeeklyReport();
    startAutoPull();
    startStaleFilingMonitor();
    const ownershipStaleStatus = startOwnershipStaleMonitor();
    const backfillAutorun = startBackfillAutorun();
    console.log("Daily auto-pull: enabled (checking every 12 hours for new CH files)");
    console.log("Stale filing monitor: enabled (companies with >12 months since last filing checked every 14 days)");
    console.log(`Ownership stale monitor: enabled (${ownershipStaleStatus.schedule})`);
    if (backfillAutorun.enabled) {
      console.log(
        `Backfill autorun: enabled (normal ${backfillAutorun.max_files} file(s) every ${Math.round(backfillAutorun.interval_ms / 60000)}m, catch-up ${backfillAutorun.catchup_max_files} file(s) every ${Math.round(backfillAutorun.catchup_interval_ms / 60000)}m when pending >= ${backfillAutorun.backlog_threshold})`
      );
    } else {
      console.log("Backfill autorun: disabled (set BACKFILL_AUTORUN=true to enable)");
    }
  });
}

const isMainModule = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  startServer();
}
