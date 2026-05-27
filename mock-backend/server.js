import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
} from "./db.js";
import {
  isCompaniesHouseConfigured,
  lookupCompany,
  lookupCompanyCharges,
  parseCompanyNumbersCSV,
  getBulkDownloadInfo,
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
import { generateSequence, getSequencesForCompany, getSequence, updateStepStatus, updateStepContent, deleteSequence, SEQUENCE_TEMPLATES, getSequenceTemplates, saveGeneratedSequence, purgePlaceholderSequencesForCompany } from "./email-sequences.js";
import { generateFullSequence } from "./email-generator.js";
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
} from "./company-monitor.js";
import {
  getMonitorStats,
  getMonitoredCompanies as dbGetMonitoredCompanies,
  getFilingsForCompany,
  getFilingCount,
  getMonitoredCompanyCount,
  getShortlistCompanies,
  getShortlistCount,
  getMonitoredCompany,
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
} from "./db.js";
import { getSupplementaryContext } from "./supplementary-context.js";

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

function isExcluded(company) {
  const exclusions = dbGetExclusions();
  if (exclusions.excluded_company_ids.includes(company.id)) return { excluded: true, reason: "Manually excluded" };
  if (exclusions.prohibited_industries.some((ind) => company.industry.toLowerCase().includes(ind.toLowerCase()))) {
    return { excluded: true, reason: `Prohibited industry: ${company.industry}` };
  }
  return { excluded: false };
}

function isSuppressed(companyId) {
  const ws = getCompanyState(companyId);
  if (SUPPRESSED_STATES.includes(ws.state)) {
    const label = WORKFLOW_STATES.find((s) => s.id === ws.state)?.label || ws.state;
    return { suppressed: true, reason: `Status: ${label}` };
  }
  return { suppressed: false };
}

// --- Scoring weights (segment-aware) ---

const VALID_SEGMENTS = ["SMB", "Mid-Market", "Enterprise"];

const LAYER_NAMES = ["product_fit", "commercial_value", "pain_strength", "urgency", "competitor_context"];

const DEFAULT_SEGMENT_WEIGHTS = {
  SMB: {
    product_fit: 0.35,
    commercial_value: 0.15,
    pain_strength: 0.25,
    urgency: 0.15,
    competitor_context: 0.10,
  },
  "Mid-Market": {
    product_fit: 0.30,
    commercial_value: 0.22,
    pain_strength: 0.20,
    urgency: 0.15,
    competitor_context: 0.13,
  },
  Enterprise: {
    product_fit: 0.28,
    commercial_value: 0.25,
    pain_strength: 0.18,
    urgency: 0.14,
    competitor_context: 0.15,
  },
};

const DEFAULT_PROPENSITY_WEIGHT = 0.15;

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
const BACKFILL_AUTORUN_ENABLED = String(process.env.BACKFILL_AUTORUN || "true").toLowerCase() !== "false";
const BACKFILL_AUTORUN_INTERVAL_MS = Number.parseInt(process.env.BACKFILL_AUTORUN_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
const BACKFILL_AUTORUN_MAX_FILES = Number.parseInt(process.env.BACKFILL_AUTORUN_MAX_FILES || "1", 10);
const BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS = Number.parseInt(process.env.BACKFILL_AUTORUN_CATCHUP_INTERVAL_MS || String(45 * 60 * 1000), 10);
const BACKFILL_AUTORUN_BACKLOG_THRESHOLD = Number.parseInt(process.env.BACKFILL_AUTORUN_BACKLOG_THRESHOLD || "6", 10);
const BACKFILL_AUTORUN_CATCHUP_MAX_FILES = Number.parseInt(process.env.BACKFILL_AUTORUN_CATCHUP_MAX_FILES || "3", 10);
let lastShortlistAutoQueueRunAt = 0;
let shortlistBackgroundSeedTimer = null;
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

const MERCHANT_MOTIONS = ["Merchant Acquiring", "Revolut Pay"];
const MERCHANT_BOOST_MAX = 0.08;

function computeMerchantBoost(merchantSpend, motion) {
  if (!merchantSpend || !MERCHANT_MOTIONS.includes(motion)) return 0;
  const volume = merchantSpend.annual_card_volume || 0;
  const growth = merchantSpend.growth_rate || 0;
  const volumeScore = Math.min(volume / 20_000_000, 1);
  const growthScore = Math.min(growth / 0.25, 1);
  return Math.round((volumeScore * 0.6 + growthScore * 0.4) * MERCHANT_BOOST_MAX * 100) / 100;
}

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

function computePriorityBreakdown(companyRow, score, analysisStatus) {
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

  const propensityBase = clamp01(Number(score?.propensity_score ?? score?.layers?.urgency?.score ?? 0.5));
  const readinessSignal = analysisStatus === "ready"
    ? 0.12
    : analysisStatus === "queued"
      ? -0.05
      : analysisStatus === "failed"
        ? -0.12
        : 0;
  const qualitySignal = clamp01(Number(score?.integration_quality?.coverage_ratio || 0));
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

  const priorityScore = Math.round(clamp01((fitScore * 0.6) + (propensityScore * 0.4)) * 1000) / 1000;
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
    propensity_score: Math.round(propensityScore * 1000) / 1000,
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
  if (!id) return id;
  if (id.startsWith("ch-")) return id;
  if (/^\d{6,8}$/.test(id)) return `ch-${id.padStart(8, "0")}`;
  return id;
}

function companyNumberFromId(id) {
  return id?.startsWith("ch-") ? id.replace("ch-", "") : id;
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

function buildMonitorMotionScores(score) {
  if (!score) return [];
  const candidates = score.eligible_motions?.length
    ? score.eligible_motions
    : Object.entries(score.all_motion_scores || {})
      .map(([motion, data]) => ({ motion, ...data }))
      .filter((m) => m.score > 0)
      .sort((a, b) => (b.weighted || b.score) - (a.weighted || a.score));

  return candidates.map((m) => ({
    motion: m.motion,
    score: Math.round((m.score || 0) * 100) / 100,
    fit_level: m.fit_level || (m.score >= 0.5 ? "strong" : m.score >= 0.25 ? "medium" : "weak"),
    explanation: m.evidence?.[0]?.text || `${m.motion} fit inferred from accounts filing signals.`,
    score_breakdown: {
      product_fit: { score: m.score || 0, evidence: m.evidence },
      commercial_value: score.layers?.commercial_value,
      pain_strength: score.layers?.pain_strength,
      urgency: score.layers?.urgency,
      competitor_context: score.layers?.competitor_context,
    },
  }));
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
  return [...manual, ...scored, ...analysed];
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
  const exclusions = dbGetExclusions();
  res.json({ exclusions, suppressed_states: SUPPRESSED_STATES });
});

app.put("/api/exclusions", (req, res) => {
  const { prohibited_industries, excluded_company_ids } = req.body;
  const current = dbGetExclusions();
  const updated = {
    prohibited_industries: prohibited_industries ?? current.prohibited_industries,
    excluded_company_ids: excluded_company_ids ?? current.excluded_company_ids,
  };
  dbSetExclusions(updated);
  res.json({ exclusions: updated });
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

  const topCompanies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), limit: 500 });
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
      const supp = isSuppressed(`ch-${c.company_number}`);
      const queue = queueRows[c.company_number] || null;
      const storedAnalysis = getSetting(`analysis_${c.company_number}`, null);
      const analysis_status = deriveAnalysisStatus(queue, storedAnalysis);
      const priority = computePriorityBreakdown(c, stored, analysis_status);

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
      const supp = isSuppressed(`ch-${c.company_number}`);
      const queue = queueRows[c.company_number] || null;
      const storedAnalysis = getSetting(`analysis_${c.company_number}`, null);

      const analysis_status = deriveAnalysisStatus(queue, storedAnalysis);
      const priority = computePriorityBreakdown(c, stored, analysis_status);

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
    const supp = isSuppressed(c.id);
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
      const supp = isSuppressed(c.id);
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
      const analysis = getSetting(`analysis_${companyNumber}`, null);
      const detailQueueRows = getAnalysisQueueItemsByCompanyNumbers([companyNumber]);
      const detailQueue = detailQueueRows[companyNumber] || null;
      const analysisStatus = deriveAnalysisStatus(detailQueue, analysis);
      let chargeSummary = getCompanyChargeSummary(companyNumber, null);
      if (!chargeSummary && isCompaniesHouseConfigured()) {
        const charges = await lookupCompanyCharges(companyNumber);
        if (!charges?.error && charges?.summary) {
          chargeSummary = charges.summary;
          upsertCompanyChargeSummary(companyNumber, chargeSummary, "companies_house_api");
        }
      }
      if (!analysis) {
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
      const { stakeholders, assessment } = getProfileStakeholders(profileId, analysis, score, monitorCompany);
      const competitors = getProfileCompetitors(profileId, analysis, score);
      const cadenceHistory = getCadenceLog(profileId);
      const baseScore = score?.composite_score ?? (monitored.latest_turnover ? Math.round((Math.min(monitored.latest_turnover / 500_000_000, 1) * 0.7 + 0.3) * 100) / 100 : 0);

      return res.json({
        company: {
          id: profileId,
          company_number: companyNumber,
          name: displayName,
          industry: monitorCompany.industry,
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
        turnover: company.turnover,
        employee_count: company.employee_count,
        latest_annual_report_url: company.latest_annual_report_url,
        product_fit: fit,
        score_breakdown: buildScoreBreakdown(layers),
        final_score: compositeScore,
        explanation: fit.explanation,
        workflow_state: ws.state,
        workflow_history: ws.history || [],
        competitors: company.competitors || [],
        stakeholders: company.stakeholders || [],
        cadence_history: company.cadence_history || [],
        notes: getSetting(`notes_${company.id}`, ""),
        analysis_status: "ready",
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
        competitors: company.competitors || [],
        stakeholders: company.stakeholders || [],
        cadence_history: company.cadence_history || [],
        notes: getSetting(`notes_${company.id}`, ""),
        analysis_status: "ready",
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
    const data = await lookupCompany(number, { include_charges: includeCharges });
    if (data.error) return res.status(data.status || 500).json(data);
    if (data?.charge_summary) {
      upsertCompanyChargeSummary(data.company_number, data.charge_summary, "companies_house_api");
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

async function processCSVImport(jobId, companyNumbers) {
  let imported = 0, skipped = 0, errors = 0;
  const COMPANIES = loadCompanies();
  const existingNumbers = new Set(COMPANIES.map((c) => c.company_number));

  for (let i = 0; i < companyNumbers.length; i++) {
    const num = companyNumbers[i];

    if (existingNumbers.has(num)) {
      addImportLogEntry(jobId, num, null, "skipped", "Already exists in universe");
      skipped++;
      updateImportJob(jobId, { processed_items: i + 1, imported_items: imported, skipped_items: skipped, error_count: errors });
      continue;
    }

    try {
      const chData = await lookupCompany(num, { include_charges: true });
      if (chData.error) {
        addImportLogEntry(jobId, num, null, "error", chData.message);
        errors++;
      } else if (chData.status === "dissolved" || chData.status === "liquidation") {
        addImportLogEntry(jobId, num, chData.name, "skipped", `Status: ${chData.status} (non-trading)`);
        skipped++;
      } else {
        const newCompany = {
          id: `ch-${num}`,
          name: displayNameForCompanyNumber(num, chData.name),
          company_number: num,
          industry: chData.industry_hint || mapSICToIndustry(chData.sic_codes),
          segment: guessTurnoverSegment(chData.turnover_hint),
          turnover: chData.turnover_hint || 0,
          employee_count: chData.employee_hint || 0,
          latest_annual_report_url: `https://find-and-update.company-information.service.gov.uk/company/${num}/filing-history`,
          motions: [],
          product_fit: {},
          competitors: [],
          stakeholders: [],
          cadence_history: [],
          response_propensity: { score: 0.3, warmth: "cold", signals: ["Imported from CSV — no engagement data"] },
          source: chData.source,
          imported_at: new Date().toISOString(),
        };

        COMPANIES.push(newCompany);
        existingNumbers.add(num);
        if (chData.charge_summary) {
          upsertCompanyChargeSummary(num, chData.charge_summary, "companies_house_api");
        }
        addImportLogEntry(jobId, num, newCompany.name, "imported", `Added as ${newCompany.segment}`, newCompany.turnover);
        enqueueCompanyForAnalysis({ company_number: num, company_name: newCompany.name }, "csv_import");
        imported++;
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

        const queued = enqueueCompaniesForAnalysis(result.companies || [], `bulk_remaining:${file.type}`);
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

    for (const co of result.companies) {
      addImportLogEntry(jobId, co.company_number, co.company_name || null, "imported",
        `£${(co.turnover / 1e6).toFixed(1)}M turnover (BS date: ${co.balance_sheet_date || "?"})`, co.turnover);
    }

    const queued = enqueueCompaniesForAnalysis(result.companies, `bulk_import:${filename}`);
    if (queued.queued > 0) {
      await processAnalysisQueueBatch({ batchSize: 3 });
    }

    updateImportJob(jobId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      total_items: result.total_files,
      processed_items: result.processed,
      imported_items: result.qualifying,
      skipped_items: result.below_threshold,
      error_count: result.parse_errors,
      metadata: JSON.stringify({ filename, url, analysis_queued: queued.queued }),
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
    failedItems.map((item) => ({
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
  res.json({
    ...getWeeklyMonitorStatus(),
    running: isMonitorRunning(),
    progress: getMonitorProgress(),
    stale_monitor: {
      ...staleStatus,
      running: isStaleMonitorRunning(),
      progress: getStaleMonitorProgress(),
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

  if (isMonitorRunning() || isStaleMonitorRunning()) {
    return res.status(409).json({
      error: "A monitor job is already running",
      weekly_progress: getMonitorProgress(),
      stale_progress: getStaleMonitorProgress(),
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

// --- LLM Company Analysis ---

import { analyseCompany, isLLMConfigured } from "./llm.js";

app.get("/api/llm/status", (_req, res) => {
  res.json({ configured: isLLMConfigured(), model: process.env.OPENAI_MODEL || "gpt-4o-mini" });
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

  const newsLookupEnabled = (process.env.ENABLE_NEWS_LOOKUP || "true").toLowerCase() !== "false";

  const integrations = {
    companies_house: {
      configured: isCompaniesHouseConfigured(),
      required: true,
      env_var: "COMPANIES_HOUSE_API_KEY or CH_API_KEY",
      purpose: "Company lookups and filing-monitor refresh",
    },
    openai: {
      configured: isLLMConfigured(),
      required: true,
      env_var: "OPENAI_API_KEY",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      purpose: "Analysis enrichment and advanced email generation",
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
  };

  const missingRequired = Object.entries(integrations)
    .filter(([, cfg]) => cfg.required && !cfg.configured)
    .map(([name]) => name);

  res.json({
    integrations,
    missing_required: missingRequired,
    ready_for_production: missingRequired.length === 0,
    env_template: [
      "COMPANIES_HOUSE_API_KEY=your_companies_house_api_key",
      "# Optional alias supported: CH_API_KEY=your_companies_house_api_key",
      "OPENAI_API_KEY=your_openai_api_key",
      "OPENAI_MODEL=gpt-4o-mini",
      "LUSHA_API_KEY=optional_lusha_key",
      "ENABLE_NEWS_LOOKUP=true",
      "NEWS_API_KEY=optional_newsapi_key",
    ],
  });
});

app.post("/api/llm/analyse", async (req, res) => {
  const companyNumber = companyNumberFromId(canonicalCompanyId(req.body.company_number || ""));
  if (!companyNumber) {
    return res.status(400).json({ error: "company_number required" });
  }

  const monitored = getMonitoredCompany(companyNumber);
  const name = await resolveMonitorName(companyNumber, monitored?.company_name);
  const turnover = monitored?.latest_turnover || null;

  try {
    const analysis = await analyseCompany(companyNumber, name, turnover);
    setSetting(`analysis_${companyNumber}`, analysis);
    const baseScore = scoreCompany(companyNumber);
    const score = baseScore ? integrateAnalysis(baseScore, analysis) : null;
    res.json({ company_number: companyNumber, company_name: name, analysis, score });
  } catch (err) {
    res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
});

// Backward compat
app.post("/api/llm/extract", async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: "Missing company_id" });

  const companyNumber = companyNumberFromId(canonicalCompanyId(company_id));
  const monitored = getMonitoredCompany(companyNumber);

  try {
    const name = await resolveMonitorName(companyNumber, monitored?.company_name);
    const analysis = await analyseCompany(companyNumber, name, monitored?.latest_turnover);
    setSetting(`analysis_${companyNumber}`, analysis);
    const baseScore = scoreCompany(companyNumber);
    if (baseScore) integrateAnalysis(baseScore, analysis);
    res.json({ company_id, evidence: analysis });
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
      const supp = isSuppressed(c.id);
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

app.post("/api/email/generate", async (req, res) => {
  const { company_id, stakeholder_name, stakeholder_role, stakeholder_email, motion } = req.body;
  if (!company_id || !stakeholder_name) {
    return res.status(400).json({ error: "company_id and stakeholder_name are required" });
  }

  const companyNumber = company_id.replace("ch-", "");
  const COMPANIES = loadCompanies();
  let company = COMPANIES.find((c) => c.id === company_id);

  if (!company) {
    const monitored = getMonitoredCompany(companyNumber);
    if (monitored) {
      company = { id: company_id, name: formatMonitorName(monitored.company_name, companyNumber), company_number: companyNumber, turnover: monitored.latest_turnover, employee_count: 0, industry: "—" };
    }
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  let analysis = getSetting(`analysis_${companyNumber}`, null);
  const autoMode = !motion || String(motion).toLowerCase() === "holistic narrative";

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
        preferredCadence: { steps: 3, delays: [0, 3, 7], strategy: "level5_compact3" },
      });

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
          });
        }
      }
    } catch (err) {
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

app.get("/api/email/sequence/:id", (req, res) => {
  const sequence = getSequence(req.params.id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  res.json({ sequence });
});

app.patch("/api/email/sequence/:id/step/:stepNumber", (req, res) => {
  const { id, stepNumber } = req.params;
  const { status, subject, body } = req.body;

  if (status) {
    updateStepStatus(id, parseInt(stepNumber), status);
  }
  if (subject !== undefined || body !== undefined) {
    const seq = getSequence(id);
    if (!seq) return res.status(404).json({ error: "Sequence not found" });
    const step = seq.steps.find((s) => s.step_number === parseInt(stepNumber));
    if (!step) return res.status(404).json({ error: "Step not found" });
    updateStepContent(id, parseInt(stepNumber), subject || step.subject, body || step.body);
  }

  res.json({ success: true });
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

  const companyNumber = company_id.replace("ch-", "");
  const COMPANIES = loadCompanies();
  let company = COMPANIES.find((c) => c.id === company_id);

  if (!company) {
    const monitored = getMonitoredCompany(companyNumber);
    if (monitored) {
      company = { id: company_id, name: formatMonitorName(monitored.company_name, companyNumber), company_number: companyNumber, turnover: monitored.latest_turnover, employee_count: 0, industry: "—", segment: "Mid-Market" };
    }
  }
  if (!company) return res.status(404).json({ error: "Company not found" });

  const analysis = getSetting(`analysis_${companyNumber}`, null);
  const score = getSetting(`score_${companyNumber}`, null);

  try {
    const result = await generateFullSequence({
      company,
      contact: { name: stakeholder_name, role: stakeholder_role || "Director" },
      analysis,
      score,
      motion: motion || null,
      merchantSpend: merchant_spend || null,
    });

    if (result.error) return res.status(400).json(result);
    registerActiveContact(stakeholder_name, stakeholder_email || null, company_id, result.archetype + "-" + Date.now());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/email/validate", (req, res) => {
  const { subject, body, is_initial } = req.body;
  if (!body) return res.status(400).json({ error: "body is required" });

  const result = validateEmail({ subject: subject || "", body }, { isInitialOutreach: is_initial !== false });
  res.json(result);
});

app.post("/api/email/check-exclusion", (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: "company_id required" });

  const companyNumber = company_id.replace("ch-", "");
  const COMPANIES = loadCompanies();
  let company = COMPANIES.find((c) => c.id === company_id);

  if (!company) {
    const monitored = getMonitoredCompany(companyNumber);
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

// --- YAMM Export & Sequence Management ---

app.get("/api/email/export/csv/:sequenceId", (req, res) => {
  const exported = exportSequenceForYAMM(req.params.sequenceId, {
    startDate: req.query.start_date,
    senderName: req.query.sender_name || getSetting("sender_name", "[Your Name]"),
    title: req.query.title || "Account Executive",
    sendTime: req.query.send_time || "08:30",
  });
  if (!exported) return res.status(404).json({ error: "Sequence not found" });

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
    sendTime: req.query.send_time || "08:30",
  });
  if (!exported) return res.status(404).json({ error: "Sequence not found" });

  res.json({
    metadata: exported.metadata,
    sheets_data: generateGoogleSheetsJSON(exported.rows),
    raw_rows: exported.rows,
  });
});

app.get("/api/email/export/company/:companyId", (req, res) => {
  const rows = exportMultipleSequencesForYAMM(req.params.companyId, {
    startDate: req.query.start_date,
    senderName: req.query.sender_name || getSetting("sender_name", "[Your Name]"),
    title: req.query.title || "Account Executive",
    sendTime: req.query.send_time || "08:30",
  });

  if (req.query.format === "csv") {
    const csv = generateCSV(rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="company-${req.params.companyId}-sequences.csv"`);
    return res.send(csv);
  }

  res.json({
    total_emails: rows.length,
    needs_email: rows.filter((r) => r.needs_email).length,
    sheets_data: generateGoogleSheetsJSON(rows),
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
  const now = new Date();
  const day = now.getDay();
  const daysUntilSaturday = day === 6 ? 0 : 6 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilSaturday);
  next.setHours(18, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

function scheduleWeeklyReport() {
  const nextRun = getNextSaturdayEvening();
  const delay = nextRun.getTime() - Date.now();

  console.log(`Weekly report scheduled for: ${nextRun.toISOString()} (in ${Math.round(delay / 3600000)}h)`);

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


app.listen(PORT, () => {
  runMigrations();
  console.log(`Prospector running on http://localhost:${PORT}`);
  console.log(`LLM: ${isLLMConfigured() ? "configured" : "mock mode (set OPENAI_API_KEY to enable)"}`);
  console.log(`Auth: ${isAuthConfigured() ? "password set" : "OPEN (set password via /api/auth/setup)"}`);
  console.log(`Filings: ${getFilingCount()} stored, ${getMonitoredCompanyCount()} companies monitored`);
  const queueStatus = startAnalysisQueueWorker();
  console.log(`Analysis queue: enabled (${queueStatus.batch_size} per batch every ${queueStatus.interval_ms}ms), recovered ${queueStatus.recovered_processing_items} in-flight items`);

  const reconciledQueueRows = reconcileAnalysisQueueWithStoredAnalyses();
  if (reconciledQueueRows > 0) {
    console.log(`Analysis queue: reconciled ${reconciledQueueRows} queued/failed item(s) to ready using existing stored analyses`);
  }

  const seederStatus = startShortlistBackgroundSeeder();
  console.log(`Analysis auto-seed: enabled (${seederStatus.max_enqueue} max queued every ${seederStatus.interval_ms}ms, queue soft/hard cap ${seederStatus.queue_soft_cap}/${seederStatus.queue_hard_cap})`);

  scheduleWeeklyReport();
  startAutoPull();
  startStaleFilingMonitor();
  const backfillAutorun = startBackfillAutorun();
  console.log(`Daily auto-pull: enabled (checking every 12 hours for new CH files)`);
  console.log(`Stale filing monitor: enabled (companies with >12 months since last filing checked every 14 days)`);
  if (backfillAutorun.enabled) {
    console.log(
      `Backfill autorun: enabled (normal ${backfillAutorun.max_files} file(s) every ${Math.round(backfillAutorun.interval_ms / 60000)}m, catch-up ${backfillAutorun.catchup_max_files} file(s) every ${Math.round(backfillAutorun.catchup_interval_ms / 60000)}m when pending >= ${backfillAutorun.backlog_threshold})`
    );
  } else {
    console.log("Backfill autorun: disabled (set BACKFILL_AUTORUN=true to enable)");
  }
});
