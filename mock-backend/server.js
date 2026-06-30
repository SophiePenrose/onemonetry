import "dotenv/config";
import { createHash } from "crypto";
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
  searchCompaniesByName,
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
import { processZipInChunks, getTurnoverThreshold, getTurnoverMaxThreshold } from "./stream-processor.js";
import { scoreCompany, getStoredScore, batchScoreCompanies, scoreCompanyWithLLM, batchScoreWithLLM, integrateAnalysis } from "./scoring-engine.js";
import { generateSequence, getSequencesForCompany, getSequence, updateStepStatus, updateStepContent, markStepReviewed, deleteSequence, SEQUENCE_TEMPLATES, getSequenceTemplates, saveGeneratedSequence, purgePlaceholderSequencesForCompany, purgeBrokenSequencesForCompany, purgeBrokenSequences, normalizeCompanyDisplayName, normalizeCompanyNameInText } from "./email-sequences.js";
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
  upsertMonitoredCompanies,
  clearMonitoredCompanyWebsiteHints,
  getCompanyChargeSummary,
  upsertCompanyChargeSummary,
  updateMonitorCheck,
  getCadenceLog,
  addCadenceEntry,
  pruneHistoricMonthlyFilingsBefore,
  purgeOutOfScopeMonitoredCompanies,
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
  createOrGetGeminiHandoffRequest,
  getGeminiHandoffRequest,
  listGeminiHandoffRequests,
  countGeminiHandoffRequests,
  getGeminiHandoffStatusCounts,
  getGeminiHandoffRetryCounts,
  getGeminiHandoffOperationalSummary,
  completeGeminiHandoffRequest,
  incrementGeminiHandoffRetry,
  replaceGeminiHandoffApprovals,
  getGeminiHandoffApprovalCounts,
  listGeminiHandoffApprovals,
  addGeminiHandoffEvent,
  listGeminiHandoffEvents,
  addStakeholderAlertEvent,
  listStakeholderAlertEvents,
  countStakeholderAlertEvents,
  getStakeholderAlertTypeCounts,
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
import { validateJsonSchema } from "./json-schema-lite.js";
import {
  dispatchGeminiHandoffRequest,
  getGeminiHandoffTransportRuntimeInfo,
} from "./gemini-handoff-transport.js";

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
const GEMINI_HANDOFF_CONTRACT_VERSION = "gemini-handoff-v1";
const GEMINI_HANDOFF_RETRYABLE_STATUSES = new Set([
  "accepted",
  "retry_requested",
  "completed",
  "partial",
  "error",
]);
const GEMINI_APPROVAL_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "sent",
  "paused",
]);
const parsedGeminiHandoffMaxRetryCount = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_MAX_RETRY_COUNT || "5"),
  10
);
const GEMINI_HANDOFF_MAX_RETRY_COUNT = Number.isFinite(parsedGeminiHandoffMaxRetryCount)
  ? Math.max(1, Math.min(parsedGeminiHandoffMaxRetryCount, 50))
  : 5;
const GEMINI_WEEKLY_CARRYOVER_ACTIVE_STATES = new Set([
  "new_candidate",
  "shortlisted",
  "selected_for_outreach",
]);

function loadLocalJsonSchema(fileName) {
  const filePath = path.join(__dirname, "schemas", fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function resolveConfiguredSecret(value) {
  const key = String(value || "").trim();
  if (!key) return null;
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
  return looksPlaceholder ? null : key;
}

const GEMINI_HANDOFF_REQUEST_SCHEMA = loadLocalJsonSchema("gemini-handoff-request.schema.json");
const GEMINI_HANDOFF_RESPONSE_SCHEMA = loadLocalJsonSchema("gemini-handoff-response.schema.json");
const GEMINI_APPROVALS_SYNC_SCHEMA = loadLocalJsonSchema("gemini-approvals-sync.schema.json");
const GEMINI_HANDOFF_DEV_SIMULATOR_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.ENABLE_GEMINI_HANDOFF_DEV_SIMULATOR || (process.env.NODE_ENV === "test" ? "true" : "false"))
    .trim()
    .toLowerCase()
);
const GEMINI_HANDOFF_GOOGLE_API_BRIDGE_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.ENABLE_GEMINI_HANDOFF_GOOGLE_API_BRIDGE || "false")
    .trim()
    .toLowerCase()
);
const GEMINI_API_KEY = resolveConfiguredSecret(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const GEMINI_API_MODEL = String(process.env.GEMINI_API_MODEL || "gemini-2.5-flash").trim() || "gemini-2.5-flash";
const parsedGeminiHandoffGoogleApiTimeoutMs = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS || "30000"),
  10
);
const GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS = Number.isFinite(parsedGeminiHandoffGoogleApiTimeoutMs)
  ? Math.max(3000, Math.min(parsedGeminiHandoffGoogleApiTimeoutMs, 120000))
  : 30000;
const parsedGeminiHandoffGoogleApiMaxRetries = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_GOOGLE_API_MAX_RETRIES || "2"),
  10
);
const GEMINI_HANDOFF_GOOGLE_API_MAX_RETRIES = Number.isFinite(parsedGeminiHandoffGoogleApiMaxRetries)
  ? Math.max(0, Math.min(parsedGeminiHandoffGoogleApiMaxRetries, 5))
  : 2;
const parsedGeminiHandoffGoogleApiRetryBaseMs = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS || "750"),
  10
);
const GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS = Number.isFinite(parsedGeminiHandoffGoogleApiRetryBaseMs)
  ? Math.max(100, Math.min(parsedGeminiHandoffGoogleApiRetryBaseMs, 5000))
  : 750;
const parsedGeminiHandoffGoogleApiRetryMaxMs = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS || "6000"),
  10
);
const GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS = Number.isFinite(parsedGeminiHandoffGoogleApiRetryMaxMs)
  ? Math.max(GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS, Math.min(parsedGeminiHandoffGoogleApiRetryMaxMs, 60000))
  : 6000;
const parsedGeminiHandoffRetry429CooldownMs = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS || "45000"),
  10
);
const GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS = Number.isFinite(parsedGeminiHandoffRetry429CooldownMs)
  ? Math.max(0, Math.min(parsedGeminiHandoffRetry429CooldownMs, 600000))
  : 45000;
const parsedGeminiHandoffRetry429MaxScopes = Number.parseInt(
  String(process.env.GEMINI_HANDOFF_RETRY_429_MAX_SCOPES || "25"),
  10
);
const GEMINI_HANDOFF_RETRY_429_MAX_SCOPES = Number.isFinite(parsedGeminiHandoffRetry429MaxScopes)
  ? Math.max(1, Math.min(parsedGeminiHandoffRetry429MaxScopes, 200))
  : 25;
const GEMINI_WEEKLY_AUTORUN_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.ENABLE_GEMINI_WEEKLY_AUTORUN || "true").trim().toLowerCase()
);
const GEMINI_WEEKLY_DEFAULT_FOCUS = ["all", "new", "carryover"].includes(
  String(process.env.GEMINI_WEEKLY_FOCUS || "all").trim().toLowerCase()
)
  ? String(process.env.GEMINI_WEEKLY_FOCUS || "all").trim().toLowerCase()
  : "all";
const parsedGeminiWeeklyDefaultLimit = Number.parseInt(
  String(process.env.GEMINI_WEEKLY_LIMIT || "20"),
  10
);
const GEMINI_WEEKLY_DEFAULT_LIMIT = Number.isFinite(parsedGeminiWeeklyDefaultLimit)
  ? Math.max(1, Math.min(parsedGeminiWeeklyDefaultLimit, 100))
  : 20;
const GEMINI_HANDOFF_WORKSPACE_ORG = String(process.env.GEMINI_HANDOFF_WORKSPACE_ORG || "Revolut Business").trim() || "Revolut Business";
const GEMINI_HANDOFF_WORKSPACE_SHEET_ID = String(process.env.GEMINI_HANDOFF_WORKSPACE_SHEET_ID || "weekly_workspace").trim() || "weekly_workspace";
const GEMINI_HANDOFF_WORKSPACE_SHEET_TAB_PREFIX = String(process.env.GEMINI_HANDOFF_WORKSPACE_SHEET_TAB_PREFIX || "queue_week").trim() || "queue_week";
const GEMINI_HANDOFF_WORKSPACE_TIMEZONE = String(process.env.GEMINI_HANDOFF_WORKSPACE_TIMEZONE || UK_TIMEZONE).trim() || UK_TIMEZONE;
const GEMINI_HANDOFF_CAMPAIGN_ID_PREFIX = String(process.env.GEMINI_HANDOFF_CAMPAIGN_ID_PREFIX || "cmp_weekly").trim() || "cmp_weekly";
const GEMINI_HANDOFF_CAMPAIGN_NAME_PREFIX = String(process.env.GEMINI_HANDOFF_CAMPAIGN_NAME_PREFIX || "Weekly Mid-Market Outreach").trim() || "Weekly Mid-Market Outreach";
const GEMINI_HANDOFF_SEQUENCE_TEMPLATE = String(process.env.GEMINI_HANDOFF_SEQUENCE_TEMPLATE || "v7").trim() || "v7";
const GEMINI_HANDOFF_VOICE_PROFILE = String(process.env.GEMINI_HANDOFF_VOICE_PROFILE || "sophie_v7").trim() || "sophie_v7";
const parsedGeminiHandoffDefaultMaxTouches = Number.parseInt(String(process.env.GEMINI_HANDOFF_MAX_TOUCHES || "6"), 10);
const GEMINI_HANDOFF_DEFAULT_MAX_TOUCHES = Number.isFinite(parsedGeminiHandoffDefaultMaxTouches)
  ? Math.max(1, Math.min(parsedGeminiHandoffDefaultMaxTouches, 12))
  : 6;
const parsedGeminiHandoffMaxStakeholders = Number.parseInt(String(process.env.GEMINI_HANDOFF_MAX_STAKEHOLDERS || "3"), 10);
const GEMINI_HANDOFF_MAX_STAKEHOLDERS = Number.isFinite(parsedGeminiHandoffMaxStakeholders)
  ? Math.max(1, Math.min(parsedGeminiHandoffMaxStakeholders, 6))
  : 3;
const DEFAULT_GEMINI_GEM_INSTRUCTIONS_PATH = path.join(REPO_ROOT, "prompts", "gemini-gem-instructions.txt");
const configuredGemInstructionsPath = String(
  process.env.GEMINI_GEM_INSTRUCTIONS_PATH || DEFAULT_GEMINI_GEM_INSTRUCTIONS_PATH
).trim();
const GEMINI_GEM_INSTRUCTIONS_PATH = configuredGemInstructionsPath
  ? (path.isAbsolute(configuredGemInstructionsPath)
    ? configuredGemInstructionsPath
    : path.resolve(REPO_ROOT, configuredGemInstructionsPath))
  : DEFAULT_GEMINI_GEM_INSTRUCTIONS_PATH;
const GEMINI_GEM_INSTRUCTIONS_INLINE = String(process.env.GEMINI_GEM_INSTRUCTIONS || "").trim();
const parsedGeminiGemInstructionsMaxChars = Number.parseInt(
  String(process.env.GEMINI_GEM_INSTRUCTIONS_MAX_CHARS || "12000"),
  10
);
const GEMINI_GEM_INSTRUCTIONS_MAX_CHARS = Number.isFinite(parsedGeminiGemInstructionsMaxChars)
  ? Math.max(500, Math.min(parsedGeminiGemInstructionsMaxChars, 50000))
  : 12000;
const GEMINI_COMPANY_NAME_REVIEW_RULES = [
  {
    reason: "name_lookup_needed",
    pattern: /\bname\s+lookup\s+needed\b/i,
  },
  {
    reason: "name_lookup_pending",
    pattern: /\bname\s+lookup\s+(?:pending|required)\b/i,
  },
  {
    reason: "unknown_company",
    pattern: /^(?:unknown|unknown\s+company)$/i,
  },
  {
    reason: "not_available",
    pattern: /^(?:n\/?a|na|none)$/i,
  },
  {
    reason: "to_be_confirmed",
    pattern: /^(?:tbd|tbc|to\s+be\s+confirmed)$/i,
  },
];
const GEMINI_STAKEHOLDER_PLACEHOLDER_PATTERNS = [
  /^company(?:\s|$)/i,
  /^introduction(?:\s|$)/i,
  /^strategic(?:\s|$)/i,
  /\bcompany\s+information\b/i,
  /\breport\s+and\s+accounts\b/i,
  /\bannual\s+report\b/i,
  /\bfiling\b/i,
  /^unknown(?:\s+stakeholder)?$/i,
];
const GEMINI_STAKEHOLDER_CORPORATE_TOKENS = new Set([
  "company",
  "information",
  "introduction",
  "strategic",
  "report",
  "accounts",
  "limited",
  "ltd",
  "plc",
  "group",
  "holdings",
  "international",
  "the",
]);
const STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE = 55;
const STAKEHOLDER_ALERT_PRIORITY_JUMP = 12;
const STAKEHOLDER_ALERT_RECENT_HOURS = 24 * 7;
const STAKEHOLDER_ALERT_SNAPSHOT_SETTINGS_PREFIX = "stakeholder_alert_snapshot_";
const STAKEHOLDER_ALERT_EVENT_LABELS = {
  new_relevant_stakeholder: "New Relevant Stakeholder",
  stakeholder_priority_increase: "Stakeholder Priority Increased",
  stakeholder_verification_cleared: "Stakeholder Verification Cleared",
  stakeholder_no_longer_detected: "Stakeholder No Longer Detected",
};
const STAKEHOLDER_ALERT_WATCH_ROLE_PATTERNS = [
  /\bcfo\b/i,
  /chief\s+financial\s+officer/i,
  /finance\s+director/i,
  /group\s+finance\s+director/i,
  /financial\s+controller/i,
  /head\s+of\s+finance/i,
  /head\s+of\s+treasury/i,
  /group\s+treasurer/i,
  /\btreasurer\b/i,
  /treasury\s+manager/i,
  /vp\s+finance/i,
  /svp\s+finance/i,
  /finance\s+manager/i,
];

function formatSchemaErrors(errors) {
  return (errors || []).map((entry) => `${entry.path}: ${entry.message}`);
}

function sanitizeGemInstructions(value) {
  const normalized = String(value || "").replace(/\r/g, "").trim();
  if (!normalized) return "";
  if (/^PASTE_GEM_INSTRUCTIONS_HERE$/i.test(normalized)) return "";

  const cleanedPlaceholder = normalized.replace(/\bPASTE_GEM_INSTRUCTIONS_HERE\b/gi, "").trim();
  if (!cleanedPlaceholder) return "";

  return cleanedPlaceholder.slice(0, GEMINI_GEM_INSTRUCTIONS_MAX_CHARS).trim();
}

function loadGemInstructionsConfig() {
  const inlineInstructions = sanitizeGemInstructions(GEMINI_GEM_INSTRUCTIONS_INLINE);
  if (inlineInstructions) {
    return {
      text: inlineInstructions,
      source: "env_inline",
      path: null,
    };
  }

  if (!GEMINI_GEM_INSTRUCTIONS_PATH || !fs.existsSync(GEMINI_GEM_INSTRUCTIONS_PATH)) {
    return {
      text: "",
      source: null,
      path: GEMINI_GEM_INSTRUCTIONS_PATH || null,
    };
  }

  try {
    const raw = fs.readFileSync(GEMINI_GEM_INSTRUCTIONS_PATH, "utf8");
    const fileInstructions = sanitizeGemInstructions(raw);
    const relativePath = path.relative(REPO_ROOT, GEMINI_GEM_INSTRUCTIONS_PATH) || path.basename(GEMINI_GEM_INSTRUCTIONS_PATH);

    return {
      text: fileInstructions,
      source: fileInstructions ? `file:${relativePath}` : null,
      path: GEMINI_GEM_INSTRUCTIONS_PATH,
    };
  } catch {
    return {
      text: "",
      source: null,
      path: GEMINI_GEM_INSTRUCTIONS_PATH,
    };
  }
}

let GEMINI_GEM_INSTRUCTIONS_CONFIG = loadGemInstructionsConfig();

function getGemInstructionsRuntimeInfo() {
  return {
    gem_instructions_active: !!GEMINI_GEM_INSTRUCTIONS_CONFIG.text,
    gem_instructions_source: GEMINI_GEM_INSTRUCTIONS_CONFIG.source,
    gem_instructions_path: GEMINI_GEM_INSTRUCTIONS_CONFIG.path,
    gem_instructions_chars: GEMINI_GEM_INSTRUCTIONS_CONFIG.text.length,
  };
}

function reloadGemInstructionsConfig() {
  GEMINI_GEM_INSTRUCTIONS_CONFIG = loadGemInstructionsConfig();
  return getGemInstructionsRuntimeInfo();
}

function evaluateGeminiCompanyNameReview(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return {
      needs_review: true,
      reason: "missing_company_name",
    };
  }

  for (const rule of GEMINI_COMPANY_NAME_REVIEW_RULES) {
    if (rule.pattern.test(text)) {
      return {
        needs_review: true,
        reason: rule.reason,
      };
    }
  }

  return {
    needs_review: false,
    reason: null,
  };
}

function getStoredGeminiResponseId(record) {
  if (!record || typeof record !== "object") return "";
  return String(record.response_id || record.response?.response_id || "").trim();
}

function isDuplicateGeminiResponse(record, payload) {
  const storedResponseId = getStoredGeminiResponseId(record);
  if (!storedResponseId) return false;
  const incomingResponseId = String(payload?.response_id || "").trim();
  if (!incomingResponseId) return false;
  return storedResponseId === incomingResponseId;
}

function hasGeminiResponseConflict(record, payload) {
  const storedResponseId = getStoredGeminiResponseId(record);
  if (!storedResponseId) return false;
  const incomingResponseId = String(payload?.response_id || "").trim();
  if (!incomingResponseId) return false;
  return storedResponseId !== incomingResponseId;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeGeminiResponsePayloadForReplayComparison(payload) {
  if (!payload || typeof payload !== "object") return payload;
  try {
    const cloned = JSON.parse(JSON.stringify(payload));
    if (cloned && typeof cloned === "object") {
      delete cloned.completed_at;
    }
    return cloned;
  } catch {
    return payload;
  }
}

function getGeminiReplayComparisonHash(payload) {
  return sha256Hex(JSON.stringify(normalizeGeminiResponsePayloadForReplayComparison(payload) || {}));
}

function hasGeminiDuplicatePayloadMismatch(record, payload) {
  if (!isDuplicateGeminiResponse(record, payload)) return false;
  const storedHash = getGeminiReplayComparisonHash(record?.response || {});
  if (!storedHash) return false;
  const incomingHash = getGeminiReplayComparisonHash(payload || {});
  return storedHash !== incomingHash;
}

function getGeminiRetryScopeKey(companyNumber, personId) {
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  const normalizedPersonId = String(personId || "").trim();
  if (!normalizedCompanyNumber || !normalizedPersonId) return "";
  return `${normalizedCompanyNumber}::${normalizedPersonId}`;
}

function normalizeGeminiRetryScope(scope = {}) {
  const normalizedCompanyNumber = normalizeCompanyNumber(scope?.company_number || scope?.companyNumber);
  const normalizedPersonId = String(scope?.person_id || scope?.personId || "").trim();
  if (!normalizedCompanyNumber || !normalizedPersonId) return null;
  return {
    company_number: normalizedCompanyNumber,
    person_id: normalizedPersonId,
  };
}

function normalizeGeminiRetryScopeFromOutput(output = {}) {
  return normalizeGeminiRetryScope({
    company_number: output?.company_number,
    person_id: output?.person_id,
  });
}

function isGemini429HttpError(errorEntry = {}) {
  const code = String(errorEntry?.code || "").trim().toLowerCase();
  const message = String(errorEntry?.message || "").trim();
  return code === "gemini_api_http_error" && /\bHTTP\s+429\b/i.test(message);
}

function extractGeminiRetry429ScopesFromResponse(responsePayload = {}, maxScopes = GEMINI_HANDOFF_RETRY_429_MAX_SCOPES) {
  const errors = Array.isArray(responsePayload?.errors) ? responsePayload.errors : [];
  const scopes = [];
  const seen = new Set();
  const safeMaxScopes = Math.max(1, Math.min(Number.parseInt(String(maxScopes || ""), 10) || GEMINI_HANDOFF_RETRY_429_MAX_SCOPES, 200));

  for (const entry of errors) {
    if (!isGemini429HttpError(entry)) continue;
    const scope = normalizeGeminiRetryScope(entry?.scope || {});
    if (!scope) continue;
    const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
    if (!scopeKey || seen.has(scopeKey)) continue;
    seen.add(scopeKey);
    scopes.push(scope);
    if (scopes.length >= safeMaxScopes) break;
  }

  return scopes;
}

function countGeminiRetryable429Errors(responsePayload = {}, scopeKeys = null) {
  const errors = Array.isArray(responsePayload?.errors) ? responsePayload.errors : [];
  let count = 0;
  for (const entry of errors) {
    if (!isGemini429HttpError(entry)) continue;
    if (scopeKeys && scopeKeys.size > 0) {
      const scope = normalizeGeminiRetryScope(entry?.scope || {});
      if (!scope) continue;
      const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
      if (!scopeKeys.has(scopeKey)) continue;
    }
    count += 1;
  }
  return count;
}

function getGeminiRetryable429ScopeKeySet(responsePayload = {}, allowedScopeKeys = null) {
  const errors = Array.isArray(responsePayload?.errors) ? responsePayload.errors : [];
  const keys = new Set();
  for (const entry of errors) {
    if (!isGemini429HttpError(entry)) continue;
    const scope = normalizeGeminiRetryScope(entry?.scope || {});
    if (!scope) continue;
    const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
    if (!scopeKey) continue;
    if (allowedScopeKeys && !allowedScopeKeys.has(scopeKey)) continue;
    keys.add(scopeKey);
  }
  return keys;
}

function buildGeminiRetry429RequestPayload(requestPayload = {}, retryScopes = []) {
  const rankedCompanies = Array.isArray(requestPayload?.ranked_companies) ? requestPayload.ranked_companies : [];
  if (rankedCompanies.length < 1 || !Array.isArray(retryScopes) || retryScopes.length < 1) {
    return null;
  }

  const scopeMap = new Map();
  for (const scope of retryScopes) {
    const normalizedScope = normalizeGeminiRetryScope(scope);
    if (!normalizedScope) continue;
    const existing = scopeMap.get(normalizedScope.company_number) || new Set();
    existing.add(normalizedScope.person_id);
    scopeMap.set(normalizedScope.company_number, existing);
  }

  if (scopeMap.size < 1) return null;

  const retryRankedCompanies = [];
  for (const company of rankedCompanies) {
    const companyNumber = normalizeCompanyNumber(company?.company_number);
    if (!companyNumber || !scopeMap.has(companyNumber)) continue;

    const allowedPersonIds = scopeMap.get(companyNumber);
    const stakeholders = Array.isArray(company?.stakeholders) ? company.stakeholders : [];
    const filteredStakeholders = stakeholders.filter((stakeholder) => {
      const personId = String(stakeholder?.person_id || "").trim();
      if (!personId) return false;
      return allowedPersonIds.has(personId);
    });

    if (filteredStakeholders.length < 1) continue;

    retryRankedCompanies.push({
      ...company,
      company_number: companyNumber,
      stakeholders: filteredStakeholders,
    });
  }

  if (retryRankedCompanies.length < 1) return null;

  return {
    ...requestPayload,
    ranked_companies: retryRankedCompanies,
  };
}

function mergeGeminiRetry429ResponsePayload({
  requestId,
  baseResponsePayload = {},
  retryResponsePayload = {},
  retryScopes = [],
}) {
  const basePayload = baseResponsePayload && typeof baseResponsePayload === "object"
    ? JSON.parse(JSON.stringify(baseResponsePayload))
    : {};
  const retryPayload = retryResponsePayload && typeof retryResponsePayload === "object"
    ? JSON.parse(JSON.stringify(retryResponsePayload))
    : {};

  const scopeKeys = new Set(
    (Array.isArray(retryScopes) ? retryScopes : [])
      .map((scope) => normalizeGeminiRetryScope(scope))
      .filter(Boolean)
      .map((scope) => getGeminiRetryScopeKey(scope.company_number, scope.person_id))
      .filter(Boolean)
  );

  const baseOutputs = Array.isArray(basePayload.sequence_outputs) ? basePayload.sequence_outputs : [];
  const retryOutputs = Array.isArray(retryPayload.sequence_outputs) ? retryPayload.sequence_outputs : [];
  const retryOutputByKey = new Map();

  for (const output of retryOutputs) {
    const scope = normalizeGeminiRetryScopeFromOutput(output);
    if (!scope) continue;
    const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
    if (!scopeKey) continue;
    retryOutputByKey.set(scopeKey, output);
  }

  const mergedOutputs = [];
  for (const output of baseOutputs) {
    const scope = normalizeGeminiRetryScopeFromOutput(output);
    const scopeKey = scope ? getGeminiRetryScopeKey(scope.company_number, scope.person_id) : "";
    if (scopeKey && retryOutputByKey.has(scopeKey)) {
      mergedOutputs.push(retryOutputByKey.get(scopeKey));
      retryOutputByKey.delete(scopeKey);
      continue;
    }
    mergedOutputs.push(output);
  }

  for (const output of retryOutputByKey.values()) {
    mergedOutputs.push(output);
  }

  const baseErrors = Array.isArray(basePayload.errors) ? basePayload.errors : [];
  const retryErrors = Array.isArray(retryPayload.errors) ? retryPayload.errors : [];
  const retainedBaseErrors = baseErrors.filter((entry) => {
    const scope = normalizeGeminiRetryScope(entry?.scope || {});
    if (!scope) return true;
    const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
    if (!scopeKeys.has(scopeKey)) return true;
    return !isGemini429HttpError(entry);
  });

  const retryCoveredScopeKeys = new Set();
  for (const output of retryOutputs) {
    const scope = normalizeGeminiRetryScopeFromOutput(output);
    if (!scope) continue;
    const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
    if (scopeKey) retryCoveredScopeKeys.add(scopeKey);
  }
  for (const entry of retryErrors) {
    const scope = normalizeGeminiRetryScope(entry?.scope || {});
    if (!scope) continue;
    const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
    if (scopeKey) retryCoveredScopeKeys.add(scopeKey);
  }

  const missingScopeErrors = [];
  for (const scopeKey of scopeKeys) {
    if (retryCoveredScopeKeys.has(scopeKey)) continue;
    const [companyNumber, personId] = String(scopeKey).split("::");
    missingScopeErrors.push({
      code: "gemini_retry_scope_missing",
      message: "Targeted retry scope missing from retry response",
      retryable: true,
      scope: {
        company_number: companyNumber,
        person_id: personId,
      },
    });
  }

  const mergedErrors = [...retainedBaseErrors, ...retryErrors, ...missingScopeErrors];

  const preferredSheetWrite = basePayload.sheet_write && typeof basePayload.sheet_write === "object"
    ? basePayload.sheet_write
    : (retryPayload.sheet_write && typeof retryPayload.sheet_write === "object" ? retryPayload.sheet_write : {});
  const sheetTab = String(preferredSheetWrite.sheet_tab || "queue").trim() || "queue";
  const mergedSheetWrite = {
    sheet_id: String(preferredSheetWrite.sheet_id || "gemini_api_sheet").trim() || "gemini_api_sheet",
    sheet_tab: sheetTab,
    rows_written: mergedOutputs.length,
    range: String(preferredSheetWrite.range || `${sheetTab}!A2:AZ${Math.max(1, mergedOutputs.length + 1)}`).trim() || `${sheetTab}!A2:AZ${Math.max(1, mergedOutputs.length + 1)}`,
  };

  const mergedStatus = mergedErrors.length > 0
    ? (mergedOutputs.length > 0 ? "partial" : "error")
    : "ok";

  const normalizedRequestId = String(
    requestId
    || basePayload.request_id
    || retryPayload.request_id
    || ""
  ).trim();
  const responseId = String(basePayload.response_id || retryPayload.response_id || "").trim()
    || `resp_retry_429_${Date.now()}`;

  return {
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: normalizedRequestId,
    response_id: responseId,
    completed_at: new Date().toISOString(),
    status: mergedStatus,
    sheet_write: mergedSheetWrite,
    sequence_outputs: mergedOutputs,
    errors: mergedErrors,
  };
}

function slugToTitle(value) {
  const normalized = String(value || "").trim().replace(/[_-]+/g, " ");
  if (!normalized) return "Unknown";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function sanitizeSingleLine(value, maxLength = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeBodyText(value, maxLength = 4000) {
  return String(value || "").trim().slice(0, maxLength);
}

function waitForGeminiApiRetry(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterHeaderMs(value) {
  const token = String(value || "").trim();
  if (!token) return null;

  if (/^\d+$/.test(token)) {
    const seconds = Number.parseInt(token, 10);
    if (!Number.isFinite(seconds)) return null;
    return seconds * 1000;
  }

  const parsedDate = Date.parse(token);
  if (!Number.isFinite(parsedDate)) return null;
  return Math.max(0, parsedDate - Date.now());
}

function getGeminiApiRetryDelayMs({ attempt = 1, retryAfterHeader = "" } = {}) {
  const retryAfterMs = parseRetryAfterHeaderMs(retryAfterHeader);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.max(
      GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS,
      Math.min(retryAfterMs, GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS)
    );
  }

  const exponential = GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exponential + jitter, GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS);
}

function shouldRetryGeminiApiHttpStatus(statusCode) {
  return statusCode === 429 || statusCode >= 500;
}

function extractGeminiApiGeneratedText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const firstCandidate = candidates[0] || {};
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  return parts
    .map((part) => String(part?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseJsonCandidate(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return null;

  const withoutFences = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/g, "")
    .trim();

  const parseAttempts = [
    withoutFences,
    withoutFences.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'"),
    withoutFences.replace(/,\s*([}\]])/g, "$1"),
    withoutFences
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1"),
  ];

  for (const attempt of parseAttempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Continue trying relaxed parsing variants.
    }
  }

  return null;
}

function parseJsonObjectFromText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const direct = parseJsonCandidate(text);
  if (direct && typeof direct === "object") return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  const sliced = parseJsonCandidate(text.slice(start, end + 1));
  return sliced && typeof sliced === "object" ? sliced : null;
}

function parseLooseDraftFromText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/g, "")
    .trim();

  const subjectMatch = cleaned.match(/(?:^|\n)\s*(?:subject|title)\s*:\s*(.+)\s*(?:\n|$)/i);
  const bodyMatch = cleaned.match(/(?:^|\n)\s*body\s*:\s*([\s\S]*?)(?:\n\s*(?:citations?|sources?)\s*:|\s*$)/i);
  const citationsMatch = cleaned.match(/(?:^|\n)\s*(?:citations?|sources?)\s*:\s*([\s\S]+)$/i);

  const subject = subjectMatch ? subjectMatch[1].trim() : "";
  const body = bodyMatch ? bodyMatch[1].trim() : "";
  if (!subject || !body) return null;

  const citations = citationsMatch
    ? citationsMatch[1]
      .split(/[\n,;]+/)
      .map((entry) => entry.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 6)
    : [];

  return {
    subject,
    body,
    citations,
  };
}

function normalizeGeneratedDraftPayload(generatedObject) {
  if (!generatedObject || typeof generatedObject !== "object") {
    return {
      subject: "",
      body: "",
      citations: [],
    };
  }

  const subject = sanitizeSingleLine(
    generatedObject.subject
      || generatedObject.Subject
      || generatedObject.subject_line
      || generatedObject.email_subject
      || generatedObject.title
      || "",
    180
  );

  const body = sanitizeBodyText(
    generatedObject.body
      || generatedObject.Body
      || generatedObject.email_body
      || generatedObject.content
      || generatedObject.message
      || "",
    4000
  );

  const citationSource = generatedObject.citations
    ?? generatedObject.Citations
    ?? generatedObject.sources
    ?? generatedObject.evidence
    ?? [];

  const citations = Array.isArray(citationSource)
    ? citationSource
      .map((entry) => sanitizeSingleLine(entry, 120))
      .filter(Boolean)
      .slice(0, 6)
    : String(citationSource || "")
      .split(/[\n,;]+/)
      .map((entry) => sanitizeSingleLine(entry, 120))
      .filter(Boolean)
      .slice(0, 6);

  return {
    subject,
    body,
    citations,
  };
}

const GEMINI_SEQUENCE_STEP_BLUEPRINT = [
  {
    step_type: "proof",
    day_offset: 0,
    objective: "Lead with one specific observation and the operational implication.",
  },
  {
    step_type: "nudge_1",
    day_offset: 2,
    objective: "Keep this short; reinforce relevance with one precise angle and a low-friction CTA.",
  },
  {
    step_type: "depth",
    day_offset: 5,
    objective: "Add depth with a second concrete signal and a connected-stack recommendation.",
  },
  {
    step_type: "nudge_2",
    day_offset: 8,
    objective: "Send a concise follow-up with one sharpened commercial implication.",
  },
  {
    step_type: "provocation",
    day_offset: 11,
    objective: "Use a thoughtful challenge question grounded in known constraints.",
  },
  {
    step_type: "close",
    day_offset: 14,
    objective: "Close politely with optional next step and clear respect for timing.",
  },
];

function clampGeminiSequenceStepCount(value, fallback = GEMINI_SEQUENCE_STEP_BLUEPRINT.length) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(3, Math.min(fallback, GEMINI_SEQUENCE_STEP_BLUEPRINT.length));
  }
  return Math.max(3, Math.min(parsed, GEMINI_SEQUENCE_STEP_BLUEPRINT.length));
}

function resolveGeminiSequenceStepPlan(campaign = {}, generationPolicy = {}) {
  const requested = Number.parseInt(
    String(generationPolicy?.max_steps_per_sequence || campaign?.max_touches || GEMINI_SEQUENCE_STEP_BLUEPRINT.length),
    10
  );
  const stepCount = clampGeminiSequenceStepCount(requested, GEMINI_SEQUENCE_STEP_BLUEPRINT.length);
  return GEMINI_SEQUENCE_STEP_BLUEPRINT
    .slice(0, stepCount)
    .map((step, idx) => ({
      ...step,
      step_number: idx + 1,
    }));
}

function formatGeminiPreviousStepHints(previousDrafts = []) {
  if (!Array.isArray(previousDrafts) || previousDrafts.length < 1) return [];
  return previousDrafts
    .slice(-3)
    .map((entry) => {
      const stepNumber = Number.parseInt(String(entry?.step_number || ""), 10);
      const stepType = sanitizeSingleLine(entry?.step_type || "", 40);
      const subject = sanitizeSingleLine(entry?.subject || "", 120);
      const bodyPreview = sanitizeSingleLine(String(entry?.body || "").split("\n")[0] || "", 120);
      if (!subject && !bodyPreview) return null;
      return `- prior_step_${Number.isInteger(stepNumber) ? stepNumber : "x"} (${stepType || "n/a"}) subject: ${subject || "n/a"}; opener: ${bodyPreview || "n/a"}`;
    })
    .filter(Boolean);
}

function buildGeminiApiFallbackDraft({ companyName, stakeholderName, roleName, stepContext = {} }) {
  const safeCompanyName = sanitizeSingleLine(companyName || "Unknown Company", 120) || "Unknown Company";
  const safeStakeholderName = extractStakeholderFirstName(stakeholderName);
  const safeRoleName = sanitizeSingleLine(roleName || "stakeholder", 60) || "stakeholder";
  const stepType = String(stepContext?.step_type || "proof").trim().toLowerCase() || "proof";
  const stepNumber = Number.parseInt(String(stepContext?.step_number || 1), 10) || 1;

  let subject = `Question about ${safeRoleName} priorities at ${safeCompanyName}`;
  let body = `Hi ${safeStakeholderName},\n\nGiven how quickly priorities can shift for ${safeRoleName} teams at ${safeCompanyName}, one useful starting point is usually where payment collection, FX and day-to-day spend controls sit in separate systems. That split often creates avoidable reconciliation and cash-visibility friction, especially where international suppliers or online revenue are growing.\n\nIf helpful, I can share a short practical view of how teams in a similar position simplify this without forcing a full banking switch.\n\nSophie`;

  if (stepType === "nudge_1" || stepType === "nudge_2") {
    subject = `Quick follow-up for ${safeCompanyName}`;
    body = `Hi ${safeStakeholderName},\n\nA brief follow-up in case useful. When finance and payment tooling remain split, teams often lose time to avoidable reconciliation work and weaker day-to-day cash visibility.\n\nIf it helps, I can send a short, concrete outline focused on ${safeCompanyName} and where a connected setup could remove the most friction first.\n\nSophie`;
  } else if (stepType === "depth") {
    subject = `${safeCompanyName}: practical operating angle`;
    body = `Hi ${safeStakeholderName},\n\nOne deeper angle we often see for ${safeRoleName} teams is the handoff between collection, FX and spend controls. As volume grows, that split can create hidden process cost and slower month-end confidence.\n\nIf useful, I can map a staged path that keeps existing banking relationships in place while tightening control in the areas most likely to move the needle for ${safeCompanyName}.\n\nSophie`;
  } else if (stepType === "provocation" || stepType === "close") {
    subject = `Worth pressure-testing this at ${safeCompanyName}`;
    body = `Hi ${safeStakeholderName},\n\nOne question that may be worth pressure-testing: if collections, currency conversion and spend policy still sit across separate systems, how much finance time is being absorbed by preventable operational drag each month?\n\nHappy to share a practical comparison so you can decide quickly whether this is worth action now or later.\n\nSophie`;
  }

  return {
    subject,
    body,
    citations: ["gemini.google.api.fallback", `sequence.step_${stepNumber}`],
  };
}

function buildGeminiApiDraftPrompt({ company, stakeholder, campaign, generationPolicy, stepContext = {}, previousDrafts = [] }) {
  const forbiddenLine = generationPolicy?.forbidden_phrases_enforced
    ? "Do not use these phrases: I noticed, quick question. Avoid filler punctuation such as em dash parentheticals."
    : "";
  const customGemInstructions = sanitizeBodyText(GEMINI_GEM_INSTRUCTIONS_CONFIG.text, GEMINI_GEM_INSTRUCTIONS_MAX_CHARS);
  const insightsText = company?.insights && typeof company.insights === "object"
    ? JSON.stringify(company.insights).slice(0, 1800)
    : "{}";
  const scoreBreakdown = company?.score_breakdown && typeof company.score_breakdown === "object"
    ? JSON.stringify(company.score_breakdown)
    : "{}";
  const stepNumber = Number.parseInt(String(stepContext?.step_number || 1), 10) || 1;
  const totalSteps = Number.parseInt(String(stepContext?.total_steps || campaign?.max_touches || 6), 10) || 6;
  const stepType = sanitizeSingleLine(stepContext?.step_type || "proof", 40) || "proof";
  const dayOffset = Number.parseInt(String(stepContext?.day_offset || 0), 10) || 0;
  const stepObjective = sanitizeSingleLine(stepContext?.objective || "", 200);
  const priorStepHints = formatGeminiPreviousStepHints(previousDrafts);
  const isNudgeStep = stepType === "nudge_1" || stepType === "nudge_2";
  const minWords = isNudgeStep ? 45 : 70;
  const maxWords = isNudgeStep ? 130 : 190;

  return [
    "You are Sophie writing concise UK B2B prospecting outreach.",
    "Write exactly one outreach email step for the stakeholder below.",
    `This is step ${stepNumber} of ${totalSteps} in a multi-touch sequence.`,
    "Return strict JSON only with keys: subject (string), body (string), citations (string array).",
    "Do not include markdown fences or commentary.",
    forbiddenLine,
    customGemInstructions ? "\nCustom Gem-style instruction overlay:" : "",
    customGemInstructions || "",
    "\nCampaign context:",
    `campaign_name: ${sanitizeSingleLine(campaign?.campaign_name || "Prospecting", 120)}`,
    `sequence_template: ${sanitizeSingleLine(campaign?.sequence_template || "standard", 120)}`,
    `max_touches: ${Number.parseInt(String(campaign?.max_touches || 4), 10) || 4}`,
    `voice_profile: ${sanitizeSingleLine(generationPolicy?.voice_profile || "sophie_outreach", 120)}`,
    `require_citations: ${generationPolicy?.require_citations === true ? "true" : "false"}`,
    `step_number: ${stepNumber}`,
    `step_type: ${stepType}`,
    `day_offset: ${dayOffset}`,
    stepObjective ? `step_objective: ${stepObjective}` : "",
    "\nCompany context:",
    `company_name: ${sanitizeSingleLine(company?.company_name || "Unknown Company", 160)}`,
    `company_number: ${sanitizeSingleLine(company?.company_number || "", 40)}`,
    `priority_band: ${sanitizeSingleLine(company?.priority_band || "", 40)}`,
    `rank: ${Number.parseInt(String(company?.rank || 0), 10) || 0}`,
    `score_breakdown: ${scoreBreakdown}`,
    `insights: ${insightsText}`,
    "\nStakeholder context:",
    `full_name: ${sanitizeSingleLine(normalizeGeminiStakeholderName(stakeholder?.full_name), 120)}`,
    `role: ${sanitizeSingleLine(stakeholder?.role || stakeholder?.persona_bucket || "stakeholder", 80)}`,
    `persona_bucket: ${sanitizeSingleLine(stakeholder?.persona_bucket || "", 80)}`,
    `confidence: ${sanitizeSingleLine(stakeholder?.confidence || "", 40)}`,
    priorStepHints.length > 0 ? "\nAvoid repeating these prior sequence lines:" : "",
    ...priorStepHints,
    "\nOutput requirements:",
    "- subject under 120 characters",
    `- body between ${minWords} and ${maxWords} words`,
    "- greeting must use first name only in this form: Hi [FirstName],",
    "- body should end with a light CTA",
    "- this step must feel distinct from prior steps and avoid repeating the same opening sentence",
    "- citations should reference evidence source labels when possible",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateGeminiApiDraft({ company, stakeholder, campaign, generationPolicy, stepContext = {}, previousDrafts = [] }) {
  const roleName = slugToTitle(stakeholder?.role || stakeholder?.persona_bucket || "stakeholder");
  const stakeholderName = normalizeGeminiStakeholderName(stakeholder?.full_name);
  const fallbackDraft = buildGeminiApiFallbackDraft({
    companyName: company?.company_name,
    stakeholderName,
    roleName,
    stepContext,
  });

  if (!GEMINI_API_KEY) {
    return {
      ...fallbackDraft,
      used_fallback: true,
      error: {
        code: "gemini_api_key_missing",
        message: "GEMINI_API_KEY or GOOGLE_API_KEY is not configured",
        retryable: false,
      },
    };
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_API_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const prompt = buildGeminiApiDraftPrompt({
    company,
    stakeholder,
    campaign,
    generationPolicy,
    stepContext,
    previousDrafts,
  });
  const requestPayload = JSON.stringify({
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  });
  const maxAttempts = Math.max(1, GEMINI_HANDOFF_GOOGLE_API_MAX_RETRIES + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: requestPayload,
        signal: controller.signal,
      });

      const responseJson = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (shouldRetryGeminiApiHttpStatus(response.status) && attempt < maxAttempts) {
          const retryDelayMs = getGeminiApiRetryDelayMs({
            attempt,
            retryAfterHeader: response.headers?.get("retry-after") || "",
          });
          await waitForGeminiApiRetry(retryDelayMs);
          continue;
        }

        return {
          ...fallbackDraft,
          used_fallback: true,
          error: {
            code: "gemini_api_http_error",
            message: `Google Gemini API returned HTTP ${response.status}`,
            retryable: shouldRetryGeminiApiHttpStatus(response.status),
          },
        };
      }

      const generatedText = extractGeminiApiGeneratedText(responseJson);
      const generatedObject = parseJsonObjectFromText(generatedText) || parseLooseDraftFromText(generatedText);
      const normalizedDraft = normalizeGeneratedDraftPayload(generatedObject);
      const subject = normalizedDraft.subject;
      const body = normalizedDraft.body;
      const citations = normalizedDraft.citations;

      if (!subject || !body) {
        if (attempt < maxAttempts) {
          const retryDelayMs = getGeminiApiRetryDelayMs({ attempt });
          await waitForGeminiApiRetry(retryDelayMs);
          continue;
        }

        return {
          ...fallbackDraft,
          used_fallback: true,
          error: {
            code: "gemini_api_invalid_output",
            message: "Gemini API did not return parseable subject/body JSON",
            retryable: true,
          },
        };
      }

      return {
        subject,
        body,
        citations: citations.length ? citations : ["gemini.google.api"],
        used_fallback: false,
        error: null,
      };
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      if (attempt < maxAttempts) {
        const retryDelayMs = getGeminiApiRetryDelayMs({ attempt });
        await waitForGeminiApiRetry(retryDelayMs);
        continue;
      }

      return {
        ...fallbackDraft,
        used_fallback: true,
        error: {
          code: isAbort ? "gemini_api_timeout" : "gemini_api_network_error",
          message: isAbort
            ? `Gemini API timed out after ${GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS}ms`
            : String(err?.message || "Gemini API request failed"),
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return {
    ...fallbackDraft,
    used_fallback: true,
    error: {
      code: "gemini_api_retry_exhausted",
      message: "Gemini API retry attempts were exhausted",
      retryable: true,
    },
  };
}

async function buildGoogleApiGeminiHandoffResponse(payload) {
  const requestId = String(payload?.request_id || "").trim();
  const workspace = payload?.workspace || {};
  const campaign = payload?.campaign || {};
  const generationPolicy = payload?.generation_policy || {};
  const rankedCompanies = Array.isArray(payload?.ranked_companies) ? payload.ranked_companies : [];
  const stepPlan = resolveGeminiSequenceStepPlan(campaign, generationPolicy);

  const sequenceOutputs = [];
  const errors = [];

  for (let index = 0; index < rankedCompanies.length; index += 1) {
    const company = rankedCompanies[index];
    const stakeholders = normalizeGeminiRequestStakeholders(company?.stakeholders, company?.company_number);
    const stakeholder = selectPrimaryGeminiStakeholder(stakeholders);
    if (!stakeholder) {
      errors.push({
        code: "missing_stakeholder",
        message: "No stakeholder was provided for company in ranked payload",
        retryable: false,
        scope: {
          company_number: String(company?.company_number || "").trim() || null,
        },
      });
      continue;
    }

    const companyNumber = String(company?.company_number || "").trim();
    const companyName = String(company?.company_name || "").trim() || "Unknown Company";
    const personId = String(stakeholder?.person_id || "").trim();
    if (!companyNumber || !personId) {
      errors.push({
        code: "invalid_company_or_person",
        message: "Company number and person id are required to build sequence output",
        retryable: false,
        scope: {
          company_number: companyNumber || null,
          person_id: personId || null,
        },
      });
      continue;
    }

    const sequenceId = `seq_${companyNumber}_${personId}`;
    const rank = Number.parseInt(String(company?.rank || index + 1), 10) || index + 1;
    const priorityBand = String(company?.priority_band || "").trim() || null;
    const firstName = extractStakeholderFirstName(stakeholder?.full_name);
    const relevantIndividualsList = buildGeminiRelevantIndividualsList(stakeholders);
    const relevantIndividualsSummary = buildGeminiRelevantIndividualsSummary(stakeholders);
    const relevantIndividualsJson = relevantIndividualsList.length > 0
      ? JSON.stringify(relevantIndividualsList)
      : null;

    const steps = [];
    const yammRows = [];
    let fallbackStepCount = 0;
    let stepErrorCount = 0;

    for (const planStep of stepPlan) {
      const stepContext = {
        ...planStep,
        total_steps: stepPlan.length,
      };

      const draft = await generateGeminiApiDraft({
        company,
        stakeholder,
        campaign,
        generationPolicy,
        stepContext,
        previousDrafts: steps,
      });

      if (draft.error) {
        stepErrorCount += 1;
        errors.push({
          code: draft.error.code,
          message: draft.error.message,
          retryable: draft.error.retryable !== false,
          scope: {
            company_number: companyNumber,
            person_id: personId,
            step_number: planStep.step_number,
            step_type: planStep.step_type,
          },
        });
      }

      if (draft.used_fallback) fallbackStepCount += 1;

      const citations = Array.isArray(draft.citations)
        ? draft.citations.filter((item) => String(item || "").trim())
        : [];
      const stepRecord = {
        step_number: planStep.step_number,
        step_type: planStep.step_type,
        day_offset: planStep.day_offset,
        subject: draft.subject,
        body: draft.body,
        citations,
      };

      steps.push(stepRecord);
      yammRows.push({
        To: String(stakeholder?.email || ""),
        FirstName: firstName !== "there" ? firstName : "",
        Subject: stepRecord.subject,
        Body: stepRecord.body,
        Company: companyName,
        CompanyNumber: companyNumber,
        Stakeholder: String(stakeholder?.full_name || ""),
        StakeholderFullName: String(stakeholder?.full_name || ""),
        StakeholderRole: String(stakeholder?.role || ""),
        StakeholderEmailStatus: String(stakeholder?.email_status || ""),
        StakeholderConfidence: String(stakeholder?.confidence || ""),
        StakeholderPersonaBucket: String(stakeholder?.persona_bucket || ""),
        RelevantIndividuals: relevantIndividualsSummary || null,
        RelevantIndividualsJSON: relevantIndividualsJson,
        PriorityRank: rank,
        PriorityBand: priorityBand,
        SequenceId: sequenceId,
        PersonId: personId,
        StepNumber: stepRecord.step_number,
        StepType: stepRecord.step_type,
        DayOffset: stepRecord.day_offset,
        ApprovalStatus: "pending",
        QCPassed: draft.used_fallback ? "false" : "true",
        QCScore: draft.used_fallback ? 0.62 : 0.9,
        EvidenceRefs: citations.join("|") || null,
      });
    }

    const passRate = steps.length > 0
      ? (steps.length - fallbackStepCount) / steps.length
      : 0;
    const qcScore = Math.round((0.62 + (passRate * 0.30)) * 100) / 100;
    const qcNotes = [];
    if (fallbackStepCount > 0) {
      qcNotes.push(`fallback_steps_${fallbackStepCount}`);
    }
    if (stepErrorCount > 0) {
      qcNotes.push(`step_errors_${stepErrorCount}`);
    }

    sequenceOutputs.push({
      company_number: companyNumber,
      person_id: personId,
      sequence_id: sequenceId,
      qc: {
        passed: fallbackStepCount === 0 && stepErrorCount === 0,
        score: qcScore,
        notes: qcNotes,
      },
      steps,
      yamm_rows: yammRows,
    });
  }

  const sheetTab = String(workspace?.sheet_tab || "queue").trim() || "queue";
  const rowCount = sequenceOutputs.reduce((sum, output) => {
    const rows = Array.isArray(output?.yamm_rows) ? output.yamm_rows.length : 0;
    return sum + rows;
  }, 0);
  const status = rowCount === 0 ? "error" : (errors.length > 0 ? "partial" : "ok");
  const responseIdSeed = requestId ? requestId.replace(/[^a-zA-Z0-9_-]/g, "_") : Date.now().toString();

  return {
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: requestId,
    response_id: `resp_google_api_${responseIdSeed}`,
    completed_at: new Date().toISOString(),
    status,
    sheet_write: {
      sheet_id: String(workspace?.sheet_id || "gemini_api_sheet").trim() || "gemini_api_sheet",
      sheet_tab: sheetTab,
      rows_written: rowCount,
      range: `${sheetTab}!A2:AZ${Math.max(1, rowCount + 1)}`,
    },
    sequence_outputs: sequenceOutputs,
    errors,
  };
}

function buildDevGeminiHandoffResponse(payload) {
  const requestId = String(payload?.request_id || "").trim();
  const workspace = payload?.workspace || {};
  const campaign = payload?.campaign || {};
  const generationPolicy = payload?.generation_policy || {};
  const rankedCompanies = Array.isArray(payload?.ranked_companies) ? payload.ranked_companies : [];
  const stepPlan = resolveGeminiSequenceStepPlan(campaign, generationPolicy);

  const sequenceOutputs = rankedCompanies
    .map((company, index) => {
      const stakeholders = normalizeGeminiRequestStakeholders(company?.stakeholders, company?.company_number);
      const stakeholder = selectPrimaryGeminiStakeholder(stakeholders);
      if (!stakeholder) return null;

      const companyNumber = String(company?.company_number || "").trim();
      const companyName = String(company?.company_name || "").trim() || "Unknown Company";
      const personId = String(stakeholder?.person_id || "").trim();
      if (!companyNumber || !personId) return null;

      const firstName = extractStakeholderFirstName(stakeholder?.full_name);
      const sequenceId = `seq_${companyNumber}_${personId}`;
      const priorityRank = Number.parseInt(String(company?.rank || index + 1), 10) || index + 1;
      const priorityBand = String(company?.priority_band || "").trim() || null;
      const relevantIndividualsList = buildGeminiRelevantIndividualsList(stakeholders);
      const relevantIndividualsSummary = buildGeminiRelevantIndividualsSummary(stakeholders);
      const relevantIndividualsJson = relevantIndividualsList.length > 0
        ? JSON.stringify(relevantIndividualsList)
        : null;

      const steps = stepPlan.map((step) => {
        const stepLabel = slugToTitle(step.step_type);
        let subject = `${companyName}: ${stepLabel} note`;
        let body = `Hi ${firstName},\n\nSimulator output for ${stepLabel.toLowerCase()} step ${step.step_number} of ${stepPlan.length}. This mirrors the Gemini handoff contract so approval and YAMM wiring can be validated end-to-end before live credentials are enabled.\n\nSophie`;

        if (step.step_type === "proof") {
          subject = `${companyName}: initial observation`;
          body = `Hi ${firstName},\n\nSimulator proof step for ${companyName}. This line stands in for a concrete opening insight and confirms that step-level sequencing data is flowing correctly into draft and YAMM rows.\n\nSophie`;
        } else if (step.step_type === "nudge_1" || step.step_type === "nudge_2") {
          subject = `${companyName}: concise follow-up`;
          body = `Hi ${firstName},\n\nSimulator nudge step to validate short-form follow-up copy and day offsets in the handoff response. The production path should replace this with evidence-backed language tied to current signals.\n\nSophie`;
        } else if (step.step_type === "depth") {
          subject = `${companyName}: deeper operating angle`;
          body = `Hi ${firstName},\n\nSimulator depth step to validate multi-touch sequencing. In production this is where the richer operational angle and connected product arc should appear with company-specific evidence.\n\nSophie`;
        } else if (step.step_type === "provocation") {
          subject = `${companyName}: pressure-test question`;
          body = `Hi ${firstName},\n\nSimulator provocation step to confirm question-led copy can be carried as a distinct touchpoint. This verifies later-sequence diversity and approval flow handling for non-initial steps.\n\nSophie`;
        } else if (step.step_type === "close") {
          subject = `${companyName}: final close-out note`;
          body = `Hi ${firstName},\n\nSimulator close step to confirm end-of-sequence handling and send-eligible filtering. In production this should remain low-pressure and respectful while offering a practical next step.\n\nSophie`;
        }

        return {
          step_number: step.step_number,
          step_type: step.step_type,
          day_offset: step.day_offset,
          subject,
          body,
          citations: ["simulator.local", `sequence.step_${step.step_number}`],
        };
      });

      const yammRows = steps.map((step) => ({
        To: String(stakeholder?.email || ""),
        FirstName: firstName !== "there" ? firstName : "",
        Subject: step.subject,
        Body: step.body,
        Company: companyName,
        CompanyNumber: companyNumber,
        Stakeholder: String(stakeholder?.full_name || ""),
        StakeholderFullName: String(stakeholder?.full_name || ""),
        StakeholderRole: String(stakeholder?.role || ""),
        StakeholderEmailStatus: String(stakeholder?.email_status || ""),
        StakeholderConfidence: String(stakeholder?.confidence || ""),
        StakeholderPersonaBucket: String(stakeholder?.persona_bucket || ""),
        RelevantIndividuals: relevantIndividualsSummary || null,
        RelevantIndividualsJSON: relevantIndividualsJson,
        PriorityRank: priorityRank,
        PriorityBand: priorityBand,
        SequenceId: sequenceId,
        PersonId: personId,
        StepNumber: step.step_number,
        StepType: step.step_type,
        DayOffset: step.day_offset,
        ApprovalStatus: "pending",
        QCPassed: "true",
        QCScore: 0.9,
        EvidenceRefs: step.citations.join("|"),
      }));

      return {
        company_number: companyNumber,
        person_id: personId,
        sequence_id: sequenceId,
        qc: {
          passed: true,
          score: 0.9,
          notes: [],
        },
        steps,
        yamm_rows: yammRows,
      };
    })
    .filter(Boolean);

  const sheetTab = String(workspace?.sheet_tab || "queue").trim() || "queue";
  const rowCount = sequenceOutputs.reduce((sum, output) => {
    const rows = Array.isArray(output?.yamm_rows) ? output.yamm_rows.length : 0;
    return sum + rows;
  }, 0);

  return {
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: requestId,
    response_id: `resp_dev_${requestId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    completed_at: new Date().toISOString(),
    status: "ok",
    sheet_write: {
      sheet_id: String(workspace?.sheet_id || "dev_sheet").trim() || "dev_sheet",
      sheet_tab: sheetTab,
      rows_written: rowCount,
      range: `${sheetTab}!A2:AZ${Math.max(1, rowCount + 1)}`,
    },
    sequence_outputs: sequenceOutputs,
    errors: [],
  };
}

function parseGeminiRowStepNumber(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

const GEMINI_YAMM_ROW_NORMALIZATION_META = Symbol("geminiYammRowNormalizationMeta");

function isGeminiBlankRowValue(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length < 1);
}

function pickGeminiRowValue(...values) {
  for (const value of values) {
    if (isGeminiBlankRowValue(value)) continue;
    return value;
  }
  return null;
}

function normalizeGeminiRelevantIndividualsJsonCell(value, fallback = null) {
  const resolved = pickGeminiRowValue(value, fallback);
  if (isGeminiBlankRowValue(resolved)) return null;
  if (typeof resolved === "string") return resolved.trim();

  try {
    return JSON.stringify(resolved);
  } catch {
    return typeof fallback === "string" ? fallback.trim() || null : null;
  }
}

function didGeminiFallback(primaryValue, resolvedValue) {
  return isGeminiBlankRowValue(primaryValue) && !isGeminiBlankRowValue(resolvedValue);
}

function buildGeminiApprovalRowKey(sequenceId, stepNumber) {
  const sequenceToken = String(sequenceId || "").trim();
  const parsedStepNumber = parseGeminiRowStepNumber(stepNumber);
  if (!sequenceToken || !parsedStepNumber) return null;
  return `${sequenceToken}::${parsedStepNumber}`;
}

function overlayGeminiYammRowApprovals(rows = [], approvalRows = []) {
  if (!Array.isArray(rows) || rows.length < 1) return [];

  const approvalLookup = new Map();
  for (const approvalRow of Array.isArray(approvalRows) ? approvalRows : []) {
    const key = buildGeminiApprovalRowKey(approvalRow?.sequence_id, approvalRow?.step_number);
    if (!key) continue;
    const status = String(approvalRow?.approval_status || "").trim().toLowerCase();
    approvalLookup.set(key, {
      ApprovalStatus: GEMINI_APPROVAL_STATUSES.has(status) ? status : "pending",
      ApprovedBy: approvalRow?.approved_by ? String(approvalRow.approved_by) : null,
      ApprovedAt: approvalRow?.approved_at ? String(approvalRow.approved_at) : null,
      ReviewNotes: approvalRow?.review_notes ? String(approvalRow.review_notes) : null,
    });
  }

  return rows.map((row) => {
    const key = buildGeminiApprovalRowKey(row?.SequenceId, row?.StepNumber);
    if (!key || !approvalLookup.has(key)) {
      const fallbackStatus = String(row?.ApprovalStatus || "").trim().toLowerCase();
      return {
        ...row,
        ApprovalStatus: GEMINI_APPROVAL_STATUSES.has(fallbackStatus) ? fallbackStatus : "pending",
      };
    }

    const approval = approvalLookup.get(key);
    return {
      ...row,
      ApprovalStatus: approval.ApprovalStatus,
      ApprovedBy: approval.ApprovedBy,
      ApprovedAt: approval.ApprovedAt,
      ReviewNotes: approval.ReviewNotes,
    };
  });
}

function extractGeminiYammRows(responsePayload = {}, approvalRows = [], requestPayload = {}) {
  const requestId = String(responsePayload?.request_id || "").trim() || null;
  const responseId = String(responsePayload?.response_id || "").trim() || null;
  const contractVersion = String(responsePayload?.contract_version || GEMINI_HANDOFF_CONTRACT_VERSION).trim();
  const outputs = Array.isArray(responsePayload?.sequence_outputs) ? responsePayload.sequence_outputs : [];
  const stakeholderLookup = buildGeminiRequestStakeholderLookup(requestPayload);

  const flattened = [];
  for (const output of outputs) {
    const outputSteps = Array.isArray(output?.steps) ? output.steps : [];
    const stepsByNumber = new Map();
    for (const step of outputSteps) {
      const stepNumber = parseGeminiRowStepNumber(step?.step_number);
      if (!stepNumber) continue;
      stepsByNumber.set(stepNumber, step);
    }

    const yammRows = Array.isArray(output?.yamm_rows) ? output.yamm_rows : [];
    for (const row of yammRows) {
      if (!row || typeof row !== "object") continue;
      const approvalStatus = String(row.ApprovalStatus ?? row.approval_status ?? "").trim().toLowerCase() || null;
      const stepNumber = parseGeminiRowStepNumber(pickGeminiRowValue(row.StepNumber, row.step_number));
      const stepDetails = stepNumber ? stepsByNumber.get(stepNumber) : null;
      const stepTypePrimary = pickGeminiRowValue(row.StepType, row.step_type);
      const dayOffsetPrimary = pickGeminiRowValue(row.DayOffset, row.day_offset);
      const resolvedCompanyNumber = normalizeCompanyNumber(pickGeminiRowValue(row.CompanyNumber, output?.company_number));
      const resolvedPersonId = String(pickGeminiRowValue(row.PersonId, output?.person_id) || "").trim() || null;
      const stakeholderContext = resolveGeminiStakeholderContext(stakeholderLookup, resolvedCompanyNumber, resolvedPersonId);
      const primaryStakeholder = stakeholderContext.primary;
      const relevantIndividualsList = buildGeminiRelevantIndividualsList(stakeholderContext.all);
      const relevantIndividualsSummary = buildGeminiRelevantIndividualsSummary(stakeholderContext.all);
      const relevantIndividualsJson = relevantIndividualsList.length > 0
        ? JSON.stringify(relevantIndividualsList)
        : null;
      const selectedRelevantIndividuals = pickGeminiRowValue(row.RelevantIndividuals, relevantIndividualsSummary);
      const normalizedRelevantIndividuals = typeof selectedRelevantIndividuals === "string"
        ? selectedRelevantIndividuals.trim() || null
        : (relevantIndividualsSummary || null);
      const normalizedRelevantIndividualsJson = normalizeGeminiRelevantIndividualsJsonCell(
        row.RelevantIndividualsJSON,
        relevantIndividualsJson
      );
      const resolvedRequestId = pickGeminiRowValue(row.RequestId, requestId);
      const resolvedResponseId = pickGeminiRowValue(row.ResponseId, responseId);
      const resolvedContractVersion = pickGeminiRowValue(row.ContractVersion, contractVersion);
      const resolvedSequenceId = pickGeminiRowValue(row.SequenceId, output?.sequence_id);
      const resolvedRowCompanyNumber = pickGeminiRowValue(row.CompanyNumber, output?.company_number, stakeholderContext.company_number);
      const resolvedRowPersonId = pickGeminiRowValue(row.PersonId, output?.person_id, primaryStakeholder?.person_id);
      const resolvedStepType = pickGeminiRowValue(stepTypePrimary, stepDetails?.step_type);
      const resolvedDayOffset = pickGeminiRowValue(dayOffsetPrimary, stepDetails?.day_offset, 0);
      const resolvedApprovalStatus = pickGeminiRowValue(row.ApprovalStatus, approvalStatus, "pending");
      const resolvedApprovedBy = pickGeminiRowValue(row.ApprovedBy, row.approved_by);
      const resolvedApprovedAt = pickGeminiRowValue(row.ApprovedAt, row.approved_at);
      const resolvedReviewNotes = pickGeminiRowValue(row.ReviewNotes, row.review_notes);
      const fallbackFields = [];

      if (didGeminiFallback(row.RequestId, resolvedRequestId)) fallbackFields.push("request_id");
      if (didGeminiFallback(row.ResponseId, resolvedResponseId)) fallbackFields.push("response_id");
      if (didGeminiFallback(row.ContractVersion, resolvedContractVersion)) fallbackFields.push("contract_version");
      if (didGeminiFallback(row.SequenceId, resolvedSequenceId)) fallbackFields.push("sequence_id");
      if (didGeminiFallback(row.CompanyNumber, resolvedRowCompanyNumber)) fallbackFields.push("company_number");
      if (didGeminiFallback(row.PersonId, resolvedRowPersonId)) fallbackFields.push("person_id");
      if (didGeminiFallback(stepTypePrimary, resolvedStepType)) fallbackFields.push("step_type");
      if (didGeminiFallback(dayOffsetPrimary, resolvedDayOffset)) fallbackFields.push("day_offset");
      if (didGeminiFallback(row.RelevantIndividuals, normalizedRelevantIndividuals)) fallbackFields.push("relevant_individuals");
      if (didGeminiFallback(row.RelevantIndividualsJSON, normalizedRelevantIndividualsJson)) fallbackFields.push("relevant_individuals_json");
      const derivedFirstName = primaryStakeholder
        ? extractStakeholderFirstName(primaryStakeholder.full_name)
        : "there";
      const normalizedFirstName = derivedFirstName !== "there" ? derivedFirstName : "";
      const toAddress = String(row.To || "").trim();
      const stakeholderName = String(row.Stakeholder || "").trim() || String(primaryStakeholder?.full_name || "").trim() || null;
      const stakeholderRole = String(row.StakeholderRole || "").trim() || String(primaryStakeholder?.role || "").trim() || null;
      const stakeholderEmailStatus = String(row.StakeholderEmailStatus || "").trim() || String(primaryStakeholder?.email_status || "").trim() || null;
      const stakeholderConfidence = String(row.StakeholderConfidence || "").trim() || String(primaryStakeholder?.confidence || "").trim() || null;
      const stakeholderPersonaBucket = String(row.StakeholderPersonaBucket || "").trim() || String(primaryStakeholder?.persona_bucket || "").trim() || null;
      const rawCompanyName = String(pickGeminiRowValue(row.Company, output?.company_name) || "").trim();
      const normalizedCompanyName = normalizeCompanyDisplayName(rawCompanyName) || rawCompanyName || null;
      const companyNameReview = evaluateGeminiCompanyNameReview(rawCompanyName);
      const rowSubject = String(pickGeminiRowValue(row.Subject, stepDetails?.subject) || "");
      const rowBody = String(pickGeminiRowValue(row.Body, stepDetails?.body) || "");
      const normalizedSubject = normalizeCompanyNameInText(rowSubject, {
        rawCompanyName,
        normalizedCompanyName: normalizedCompanyName || rawCompanyName,
      });
      const normalizedBody = normalizeCompanyNameInText(rowBody, {
        rawCompanyName,
        normalizedCompanyName: normalizedCompanyName || rawCompanyName,
      });
      const normalizedRow = {
        ...row,
        To: toAddress,
        FirstName: String(row.FirstName || "").trim() || normalizedFirstName,
        Stakeholder: stakeholderName,
        StakeholderFullName: String(row.StakeholderFullName || "").trim() || stakeholderName,
        StakeholderRole: stakeholderRole,
        StakeholderEmailStatus: stakeholderEmailStatus,
        StakeholderConfidence: stakeholderConfidence,
        StakeholderPersonaBucket: stakeholderPersonaBucket,
        RelevantIndividuals: normalizedRelevantIndividuals,
        RelevantIndividualsJSON: normalizedRelevantIndividualsJson,
        Subject: normalizedSubject || rowSubject,
        Body: normalizedBody || rowBody,
        Company: normalizedCompanyName,
        CompanyNameNeedsReview: companyNameReview.needs_review,
        CompanyNameReviewReason: companyNameReview.reason,
        RequestId: resolvedRequestId,
        ResponseId: resolvedResponseId,
        ContractVersion: resolvedContractVersion,
        SequenceId: resolvedSequenceId,
        CompanyNumber: resolvedRowCompanyNumber,
        PersonId: resolvedRowPersonId,
        StepNumber: stepNumber ?? parseGeminiRowStepNumber(row.StepNumber),
        StepType: resolvedStepType,
        DayOffset: resolvedDayOffset,
        ApprovalStatus: resolvedApprovalStatus,
        ApprovedBy: resolvedApprovedBy,
        ApprovedAt: resolvedApprovedAt,
        ReviewNotes: resolvedReviewNotes,
      };

      if (fallbackFields.length > 0) {
        normalizedRow[GEMINI_YAMM_ROW_NORMALIZATION_META] = {
          fallback_fields: fallbackFields,
          fallback_count: fallbackFields.length,
        };
      }

      flattened.push(normalizedRow);
    }
  }

  return overlayGeminiYammRowApprovals(flattened, approvalRows);
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildGeminiYammRowsCsv(rows = []) {
  const requiredColumns = [
    "To",
    "Subject",
    "Body",
    "Company",
    "CompanyNumber",
    "PriorityRank",
    "PriorityBand",
    "SequenceId",
    "StepNumber",
    "StepType",
    "DayOffset",
    "SendDate",
    "SendTime",
    "ApprovalStatus",
    "ApprovedBy",
    "ApprovedAt",
    "ReviewNotes",
  ];
  const recommendedColumns = [
    "RequestId",
    "ResponseId",
    "ContractVersion",
    "FirstName",
    "Stakeholder",
    "StakeholderFullName",
    "StakeholderRole",
    "StakeholderEmailStatus",
    "StakeholderConfidence",
    "StakeholderPersonaBucket",
    "RelevantIndividuals",
    "RelevantIndividualsJSON",
    "CompanyNameNeedsReview",
    "CompanyNameReviewReason",
    "QCScore",
    "QCPassed",
    "EvidenceRefs",
    "DoNotSend",
    "PersonId",
  ];

  const allPresentColumns = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      allPresentColumns.add(key);
    }
  }

  const trailingColumns = [...allPresentColumns]
    .filter((key) => !requiredColumns.includes(key) && !recommendedColumns.includes(key))
    .sort((a, b) => String(a).localeCompare(String(b)));

  const header = [
    ...requiredColumns,
    ...recommendedColumns.filter((key) => allPresentColumns.has(key)),
    ...trailingColumns,
  ];

  const lines = [header.map(escapeCsvValue).join(",")];
  for (const row of rows) {
    const values = header.map((key) => escapeCsvValue(row?.[key]));
    lines.push(values.join(","));
  }

  return `${lines.join("\n")}\n`;
}

function isTruthyGeminiYammFlag(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isGeminiYammRowSendEligible(row = {}) {
  const approvalStatus = String(row?.ApprovalStatus || "").trim().toLowerCase();
  const hasRecipient = String(row?.To || "").trim().length > 0;
  const doNotSend = isTruthyGeminiYammFlag(row?.DoNotSend);
  const companyNameNeedsReview = isTruthyGeminiYammFlag(row?.CompanyNameNeedsReview);
  return approvalStatus === "approved" && hasRecipient && !doNotSend && !companyNameNeedsReview;
}

function summarizeGeminiYammRows(rows = []) {
  const byApprovalStatus = {
    pending: 0,
    approved: 0,
    rejected: 0,
    sent: 0,
    paused: 0,
    unknown: 0,
  };
  let missingRecipient = 0;
  let doNotSendCount = 0;
  let sendEligibleCount = 0;
  let companyNameNeedsReviewCount = 0;
  const companyNameReviewReasons = {};
  let fallbackNormalizationRows = 0;
  let fallbackNormalizationFields = 0;
  const fallbackNormalizationByField = {};

  for (const row of rows) {
    const approvalStatus = String(row?.ApprovalStatus || "").trim().toLowerCase();
    if (GEMINI_APPROVAL_STATUSES.has(approvalStatus)) {
      byApprovalStatus[approvalStatus] += 1;
    } else {
      byApprovalStatus.unknown += 1;
    }

    if (String(row?.To || "").trim().length < 1) {
      missingRecipient += 1;
    }
    if (isTruthyGeminiYammFlag(row?.DoNotSend)) {
      doNotSendCount += 1;
    }
    if (isGeminiYammRowSendEligible(row)) {
      sendEligibleCount += 1;
    }

    if (isTruthyGeminiYammFlag(row?.CompanyNameNeedsReview)) {
      companyNameNeedsReviewCount += 1;
      const reason = String(row?.CompanyNameReviewReason || "").trim().toLowerCase();
      if (reason) {
        companyNameReviewReasons[reason] = Number(companyNameReviewReasons[reason] || 0) + 1;
      }
    }

    const normalizationMeta = row?.[GEMINI_YAMM_ROW_NORMALIZATION_META];
    const fallbackFields = Array.isArray(normalizationMeta?.fallback_fields)
      ? normalizationMeta.fallback_fields
      : [];
    if (fallbackFields.length > 0) {
      fallbackNormalizationRows += 1;
      fallbackNormalizationFields += fallbackFields.length;
      for (const rawField of fallbackFields) {
        const field = String(rawField || "").trim().toLowerCase();
        if (!field) continue;
        fallbackNormalizationByField[field] = Number(fallbackNormalizationByField[field] || 0) + 1;
      }
    }
  }

  return {
    totals: {
      rows: rows.length,
      send_eligible: sendEligibleCount,
      missing_recipient: missingRecipient,
      do_not_send: doNotSendCount,
      company_name_needs_review: companyNameNeedsReviewCount,
      rows_with_fallback_normalization: fallbackNormalizationRows,
    },
    by_approval_status: byApprovalStatus,
    company_name_review_reasons: companyNameReviewReasons,
    fallback_normalization: {
      rows_with_fallbacks: fallbackNormalizationRows,
      fields_with_fallbacks: fallbackNormalizationFields,
      by_field: fallbackNormalizationByField,
    },
  };
}

function clampGeminiWeeklyLimit(value, fallback = GEMINI_WEEKLY_DEFAULT_LIMIT) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 100));
}

function parseGeminiBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const token = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(token)) return true;
  if (["0", "false", "no", "off"].includes(token)) return false;
  return fallback;
}

function normalizeGeminiWeeklyFocus(value, fallback = GEMINI_WEEKLY_DEFAULT_FOCUS) {
  const token = String(value || fallback || "all").trim().toLowerCase();
  if (token === "new" || token === "carryover" || token === "all") return token;
  return fallback;
}

function toGeminiIsoDate(value) {
  const parsed = Date.parse(String(value || "").trim());
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toGeminiWeekLabel(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  return getWeekLabel(date);
}

function normalizeGeminiWeekLabel(value, fallbackDate = new Date()) {
  const token = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  return toGeminiWeekLabel(fallbackDate);
}

function extractGeminiRequestInsights(entry = {}) {
  const reasons = [];
  if (entry.priority_reason) reasons.push(String(entry.priority_reason));
  if (entry.filter_reason && entry.filter_reason !== "eligible") {
    reasons.push(`Pipeline reason: ${String(entry.filter_reason).replaceAll("_", " ")}`);
  }
  if (entry.growth_trend && entry.growth_trend !== "unknown") {
    reasons.push(`Growth trend: ${entry.growth_trend}`);
  }
  if (entry.source_type) {
    reasons.push(`Source type: ${entry.source_type}`);
  }

  return {
    top_reasons: reasons.slice(0, 4),
    connector_evidence: {
      source_type: entry.source_type || null,
      source_family: entry.source_family || null,
      filter_reason: entry.filter_reason || null,
      filing_count: Number(entry.filing_count || 0),
      latest_filing_date: entry.latest_filing_date || null,
      analysis_status: entry.analysis_status || null,
    },
  };
}

function normalizeGeminiPersonaBucket(value) {
  const role = String(value || "").trim().toLowerCase();
  const canonicalBucket = role.replace(/[-\s]+/g, "_");
  if (["finance_director", "treasury_lead", "executive_sponsor", "operations_lead", "finance_operator"].includes(canonicalBucket)) {
    return canonicalBucket;
  }
  if (!role) return "finance_operator";
  if (role.includes("cfo") || role.includes("chief financial") || role.includes("finance director")) {
    return "finance_director";
  }
  if (role.includes("treasury") || role.includes("treasurer")) {
    return "treasury_lead";
  }
  if (role.includes("founder") || role.includes("ceo") || role.includes("chief executive")) {
    return "executive_sponsor";
  }
  if (role.includes("payments") || role.includes("ecommerce") || role.includes("procurement")) {
    return "operations_lead";
  }
  return "finance_operator";
}

function scoreTier(entry = {}) {
  const score = Number(entry?.combined_score ?? entry?.composite_score ?? 0);
  if (score >= 0.78) return "A";
  if (score >= 0.62) return "B";
  return "C";
}

function normalizeGeminiStakeholderName(value) {
  const raw = sanitizeSingleLine(value || "", 120);
  if (!raw) return "there";

  if (GEMINI_STAKEHOLDER_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(raw))) {
    return "there";
  }

  const alphaTokens = raw
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z'-]/g, ""))
    .filter(Boolean);
  if (alphaTokens.length === 0) return "there";

  const personalNameTokens = alphaTokens.filter((token) => {
    if (GEMINI_STAKEHOLDER_CORPORATE_TOKENS.has(token.toLowerCase())) return false;
    return /^[A-Z][A-Za-z'-]{1,}$/.test(token);
  });
  const corporateTokens = alphaTokens.filter((token) => GEMINI_STAKEHOLDER_CORPORATE_TOKENS.has(token.toLowerCase()));

  if (personalNameTokens.length === 0 && corporateTokens.length >= Math.max(2, Math.ceil(alphaTokens.length * 0.6))) {
    return "there";
  }

  return raw;
}

function extractStakeholderFirstName(value) {
  const normalized = normalizeGeminiStakeholderName(value);
  if (!normalized || normalized === "there") return "there";

  const firstToken = String(normalized)
    .trim()
    .split(/\s+/)
    .find((token) => /^[A-Za-z][A-Za-z'-]{0,62}$/.test(token));

  return firstToken || "there";
}

function buildGeminiStakeholderFromScored(entry, scoredStakeholder, rank) {
  const fallbackCompanyNumber = normalizeCompanyNumber(entry?.company_number);
  const personName = String(scoredStakeholder?.name || "").trim();
  const normalizedName = normalizeGeminiStakeholderName(personName);
  const role = String(scoredStakeholder?.role || "").trim();
  const personSeed = normalizedName !== "there" ? normalizedName : (role || `stakeholder_${rank}`);
  const companySeed = fallbackCompanyNumber || "company";
  const personId = `st_${companySeed}_${personSeed}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || `st_${companySeed}_${rank}`;
  const emailGuess = String(scoredStakeholder?.email_guess?.patterns?.[0] || "").trim();
  const confidence = String(scoredStakeholder?.confidence_level || "medium").trim().toLowerCase() || "medium";

  return {
    person_id: personId,
    full_name: normalizedName,
    role: role || "Finance stakeholder",
    email: emailGuess,
    email_status: emailGuess ? "guessed" : "missing",
    persona_bucket: normalizeGeminiPersonaBucket(role || scoredStakeholder?.buying_role),
    confidence,
  };
}

function dedupeGeminiStakeholders(stakeholders = []) {
  const seen = new Set();
  const deduped = [];

  for (const stakeholder of stakeholders || []) {
    if (!stakeholder || typeof stakeholder !== "object") continue;
    const personId = String(stakeholder.person_id || "").trim();
    const fullName = String(stakeholder.full_name || "").trim().toLowerCase();
    const role = String(stakeholder.role || "").trim().toLowerCase();
    const dedupeKey = personId || `${fullName}::${role}`;
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(stakeholder);
  }

  return deduped;
}

function normalizeGeminiRequestStakeholders(stakeholders = [], fallbackCompanyNumber = "") {
  const fallbackCompanySeed = normalizeCompanyNumber(fallbackCompanyNumber) || "company";
  const normalized = [];

  for (const [index, rawStakeholder] of (Array.isArray(stakeholders) ? stakeholders : []).entries()) {
    if (!rawStakeholder || typeof rawStakeholder !== "object") continue;

    const rawName = String(rawStakeholder.full_name || rawStakeholder.name || "").trim();
    const normalizedName = normalizeGeminiStakeholderName(rawName);
    const role = String(rawStakeholder.role || "Finance stakeholder").trim() || "Finance stakeholder";
    const rawPersonId = String(rawStakeholder.person_id || "").trim();
    const seed = normalizedName !== "there" ? normalizedName : (role || `stakeholder_${index + 1}`);
    const personId = rawPersonId || `st_${fallbackCompanySeed}_${seed}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64)
      || `st_${fallbackCompanySeed}_${index + 1}`;
    const email = String(rawStakeholder.email || "").trim();
    const emailStatus = String(rawStakeholder.email_status || (email ? "provided" : "missing"))
      .trim()
      .toLowerCase() || (email ? "provided" : "missing");
    const confidence = String(rawStakeholder.confidence || "medium").trim().toLowerCase() || "medium";
    const personaBucket = normalizeGeminiPersonaBucket(rawStakeholder.persona_bucket || role);

    normalized.push({
      person_id: personId,
      full_name: normalizedName,
      role,
      email,
      email_status: emailStatus,
      persona_bucket: personaBucket,
      confidence,
    });
  }

  return dedupeGeminiStakeholders(normalized);
}

function selectPrimaryGeminiStakeholder(stakeholders = []) {
  const rows = Array.isArray(stakeholders) ? stakeholders : [];
  const withEmail = rows.find((stakeholder) => String(stakeholder?.email || "").trim().length > 0);
  return withEmail || rows[0] || null;
}

function buildGeminiRelevantIndividualsList(stakeholders = []) {
  return (Array.isArray(stakeholders) ? stakeholders : [])
    .map((stakeholder) => ({
      person_id: String(stakeholder?.person_id || "").trim() || null,
      full_name: String(stakeholder?.full_name || "").trim() || null,
      role: String(stakeholder?.role || "").trim() || null,
      email: String(stakeholder?.email || "").trim() || null,
      email_status: String(stakeholder?.email_status || "").trim() || null,
      confidence: String(stakeholder?.confidence || "").trim() || null,
      persona_bucket: String(stakeholder?.persona_bucket || "").trim() || null,
    }))
    .filter((entry) => entry.full_name || entry.role || entry.email || entry.person_id)
    .slice(0, 10);
}

function buildGeminiRelevantIndividualsSummary(stakeholders = []) {
  const rows = buildGeminiRelevantIndividualsList(stakeholders);
  return rows
    .map((entry) => {
      const name = entry.full_name || "Unknown";
      const roleSuffix = entry.role ? ` (${entry.role})` : "";
      const emailStatusSuffix = entry.email_status ? ` [${entry.email_status}]` : "";
      return `${name}${roleSuffix}${emailStatusSuffix}`;
    })
    .join(" | ");
}

function buildGeminiRequestStakeholderLookup(requestPayload = {}) {
  const byScope = new Map();
  const byCompany = new Map();
  const companies = Array.isArray(requestPayload?.ranked_companies) ? requestPayload.ranked_companies : [];

  for (const company of companies) {
    const companyNumber = normalizeCompanyNumber(company?.company_number);
    if (!companyNumber) continue;

    const normalizedStakeholders = normalizeGeminiRequestStakeholders(company?.stakeholders, companyNumber);
    if (normalizedStakeholders.length < 1) continue;

    byCompany.set(companyNumber, normalizedStakeholders);
    for (const stakeholder of normalizedStakeholders) {
      const personId = String(stakeholder?.person_id || "").trim();
      if (!personId) continue;
      byScope.set(`${companyNumber}::${personId}`, stakeholder);
    }
  }

  return { byScope, byCompany };
}

function resolveGeminiStakeholderContext(lookup, companyNumber, personId) {
  const normalizedCompanyNumber = normalizeCompanyNumber(companyNumber);
  const normalizedPersonId = String(personId || "").trim();
  const byCompany = lookup?.byCompany instanceof Map ? lookup.byCompany : new Map();
  const byScope = lookup?.byScope instanceof Map ? lookup.byScope : new Map();
  const all = normalizedCompanyNumber ? (byCompany.get(normalizedCompanyNumber) || []) : [];

  let primary = null;
  if (normalizedCompanyNumber && normalizedPersonId) {
    primary = byScope.get(`${normalizedCompanyNumber}::${normalizedPersonId}`) || null;
  }
  if (!primary) {
    primary = selectPrimaryGeminiStakeholder(all);
  }

  return {
    company_number: normalizedCompanyNumber || null,
    person_id: normalizedPersonId || null,
    primary,
    all,
  };
}

function buildGeminiRequestFromWeeklyEntries({
  weekLabel,
  weekStart,
  weekEnd,
  focus,
  selectedEntries,
  maxTouches,
  requestPrefix,
  requestIdOverride,
}) {
  const safeWeekLabel = String(weekLabel || "").trim();
  const weekToken = safeWeekLabel.replace(/[^0-9]/g, "") || "current";
  const focusToken = String(focus || "all").trim().toLowerCase() || "all";
  const prefixToken = String(requestPrefix || "weekly")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "weekly";
  const fallbackRequestId = `${prefixToken}_req_${weekToken}_${focusToken}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  const requestIdToken = String(requestIdOverride || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  const requestId = requestIdToken || fallbackRequestId;

  const rankedCompanies = [];
  let skippedMissingStakeholders = 0;

  for (let idx = 0; idx < selectedEntries.length; idx += 1) {
    const item = selectedEntries[idx];
    const stakeholders = Array.isArray(item?.stakeholders) ? item.stakeholders : [];
    if (stakeholders.length < 1) {
      skippedMissingStakeholders += 1;
      continue;
    }
    const companyNumber = normalizeCompanyNumber(item.company_number);
    if (!companyNumber) continue;

    const mappedStakeholders = dedupeGeminiStakeholders(
      stakeholders
        .slice(0, GEMINI_HANDOFF_MAX_STAKEHOLDERS)
        .map((stakeholder, stakeholderIndex) => buildGeminiStakeholderFromScored(item, stakeholder, stakeholderIndex + 1))
        .filter(Boolean)
    );
    if (mappedStakeholders.length < 1) {
      skippedMissingStakeholders += 1;
      continue;
    }

    const fitLayers = item?.score?.layers || {};
    const ranked = {
      rank: rankedCompanies.length + 1,
      company_number: companyNumber,
      company_name: String(item.name || item.company_name || `Company ${companyNumber}`).trim(),
      segment: item.segment || guessTurnoverSegment(item.turnover || item.latest_turnover || 0),
      composite_score: Number(item.combined_score || item.composite_score || 0),
      priority_band: item.score_tier || scoreTier(item),
      score_breakdown: {
        product_fit: Number(fitLayers.product_fit?.score || 0),
        commercial_value: Number(fitLayers.commercial_value?.score || 0),
        pain_strength: Number(fitLayers.pain_strength?.score || 0),
        urgency: Number(fitLayers.urgency?.score || 0),
        competitor_context: Number(fitLayers.competitor_context?.score || 0),
      },
      insights: extractGeminiRequestInsights(item),
      stakeholders: mappedStakeholders,
    };

    rankedCompanies.push(ranked);
  }

  const sheetTabWeek = safeWeekLabel.replace(/-/g, "_");
  const payload = {
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: requestId,
    generated_at: new Date().toISOString(),
    workspace: {
      org: GEMINI_HANDOFF_WORKSPACE_ORG,
      sheet_id: GEMINI_HANDOFF_WORKSPACE_SHEET_ID,
      sheet_tab: `${GEMINI_HANDOFF_WORKSPACE_SHEET_TAB_PREFIX}_${sheetTabWeek}`,
      timezone: GEMINI_HANDOFF_WORKSPACE_TIMEZONE,
    },
    campaign: {
      campaign_id: `${GEMINI_HANDOFF_CAMPAIGN_ID_PREFIX}_${sheetTabWeek}`,
      campaign_name: `${GEMINI_HANDOFF_CAMPAIGN_NAME_PREFIX} (${safeWeekLabel})`,
      sequence_template: GEMINI_HANDOFF_SEQUENCE_TEMPLATE,
      max_touches: maxTouches,
      approval_required: true,
    },
    ranked_companies: rankedCompanies,
    generation_policy: {
      provider: "gemini",
      voice_profile: GEMINI_HANDOFF_VOICE_PROFILE,
      forbidden_phrases_enforced: true,
      max_steps_per_sequence: maxTouches,
      require_citations: true,
      fail_closed_on_qc: true,
    },
  };

  return {
    payload,
    request_id: requestId,
    selected_count: selectedEntries.length,
    ranked_count: rankedCompanies.length,
    skipped_missing_stakeholders: skippedMissingStakeholders,
    week_start: weekStart,
    week_end: weekEnd,
    week_label: safeWeekLabel,
    focus,
  };
}

function deriveGeminiLocalSequenceId(output = {}, requestId = "") {
  const fromPayload = String(output.sequence_id || "").trim();
  if (fromPayload) {
    return `gemini_${fromPayload}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  }
  const companyNumber = normalizeCompanyNumber(output.company_number) || "company";
  const personId = String(output.person_id || "person").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "person";
  const requestSeed = String(requestId || "handoff").replace(/[^a-zA-Z0-9_-]/g, "_").slice(-40) || "handoff";
  return `gemini_${requestSeed}_${companyNumber}_${personId}`.slice(0, 120);
}

function buildLocalSequenceStepsFromGeminiOutput(output = {}) {
  const sourceSteps = Array.isArray(output.steps) ? output.steps : [];
  const mapped = sourceSteps
    .map((step, idx) => {
      const stepNumber = Number.parseInt(String(step?.step_number || idx + 1), 10);
      const dayOffset = Number.parseInt(String(step?.day_offset || 0), 10);
      const subject = String(step?.subject || "").trim();
      const body = String(step?.body || "").trim();
      const stepType = String(step?.step_type || "depth").trim() || "depth";
      if (!Number.isFinite(stepNumber) || stepNumber <= 0 || !subject || !body) return null;
      return {
        step_number: stepNumber,
        step_type: stepType,
        subject,
        body,
        send_delay_days: Number.isFinite(dayOffset) && dayOffset >= 0 ? dayOffset : 0,
        status: "pending",
        send_condition: "always",
        requires_manual_review: true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.step_number - b.step_number);

  return mapped;
}

function selectGeminiPrimaryRow(output = {}) {
  const rows = Array.isArray(output.yamm_rows) ? output.yamm_rows : [];
  if (rows.length < 1) return null;
  return rows[0] || null;
}

function persistGeminiResponseSequences(record, options = {}) {
  if (!record || typeof record !== "object") {
    return {
      imported: 0,
      skipped: 0,
      details: [],
    };
  }

  const responsePayload = record.response;
  const requestPayload = record.request;
  if (!responsePayload || typeof responsePayload !== "object") {
    return {
      imported: 0,
      skipped: 0,
      details: [],
    };
  }

  const rankedCompanies = Array.isArray(requestPayload?.ranked_companies) ? requestPayload.ranked_companies : [];
  const rankedByCompanyNumber = new Map();
  for (const company of rankedCompanies) {
    const normalized = normalizeCompanyNumber(company?.company_number);
    if (!normalized) continue;
    rankedByCompanyNumber.set(normalized, company);
  }

  const outputs = Array.isArray(responsePayload.sequence_outputs) ? responsePayload.sequence_outputs : [];
  const dryRun = options?.dryRun === true;

  const summary = {
    imported: 0,
    skipped: 0,
    details: [],
  };

  for (const output of outputs) {
    const companyNumber = normalizeCompanyNumber(output?.company_number);
    if (!companyNumber) {
      summary.skipped += 1;
      summary.details.push({
        company_number: null,
        sequence_id: String(output?.sequence_id || ""),
        imported: false,
        reason: "missing_company_number",
      });
      continue;
    }

    const companyId = canonicalCompanyId(companyNumber);
    const mappedSteps = buildLocalSequenceStepsFromGeminiOutput(output);
    if (mappedSteps.length < 1) {
      summary.skipped += 1;
      summary.details.push({
        company_number: companyNumber,
        company_id: companyId,
        sequence_id: String(output?.sequence_id || ""),
        imported: false,
        reason: "no_valid_steps",
      });
      continue;
    }

    const requestCompany = rankedByCompanyNumber.get(companyNumber);
    const primaryStakeholder = Array.isArray(requestCompany?.stakeholders) ? requestCompany.stakeholders[0] : null;
    const primaryRow = selectGeminiPrimaryRow(output);
    const stakeholderName = String(
      primaryStakeholder?.full_name
        || primaryRow?.FirstName
        || primaryRow?.Stakeholder
        || `Stakeholder ${companyNumber}`
    ).trim() || `Stakeholder ${companyNumber}`;
    const stakeholderRole = String(primaryStakeholder?.role || "").trim() || null;
    const stakeholderEmail = String(primaryStakeholder?.email || primaryRow?.To || "").trim() || null;
    const motion = GEMINI_HANDOFF_SEQUENCE_TEMPLATE || "Holistic Narrative";
    const localSequenceId = deriveGeminiLocalSequenceId(output, record.request_id);

    if (dryRun) {
      summary.imported += 1;
      summary.details.push({
        company_number: companyNumber,
        company_id: companyId,
        sequence_id: localSequenceId,
        imported: true,
        dry_run: true,
        step_count: mappedSteps.length,
      });
      continue;
    }

    deleteSequence(localSequenceId);
    const saved = saveGeneratedSequence({
      id: localSequenceId,
      companyId,
      companyName: String(requestCompany?.company_name || primaryRow?.Company || `Company ${companyNumber}`).trim(),
      stakeholderName,
      stakeholderRole,
      stakeholderEmail,
      motion,
      steps: mappedSteps,
      sequenceStatus: "draft",
      preserveSubject: true,
    });

    if (!saved) {
      summary.skipped += 1;
      summary.details.push({
        company_number: companyNumber,
        company_id: companyId,
        sequence_id: localSequenceId,
        imported: false,
        reason: "save_failed",
      });
      continue;
    }

    summary.imported += 1;
    summary.details.push({
      company_number: companyNumber,
      company_id: companyId,
      sequence_id: localSequenceId,
      imported: true,
      step_count: mappedSteps.length,
    });
  }

  return summary;
}

async function processGeminiHandoffRequestPayload(payload) {
  const validation = validateJsonSchema(GEMINI_HANDOFF_REQUEST_SCHEMA, payload);

  if (!validation.valid) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "invalid_payload",
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        details: formatSchemaErrors(validation.errors),
      },
      requestRecord: null,
      sequenceImportSummary: null,
    };
  }

  const { created, record } = createOrGetGeminiHandoffRequest(payload);
  if (!created && record) {
    addGeminiHandoffEvent(payload.request_id, "handoff_duplicate", "ingress", {
      status: record.status,
    });

    let sequenceImportSummary = null;
    if (record.response && typeof record.response === "object") {
      sequenceImportSummary = persistGeminiResponseSequences(record);
    }

    return {
      ok: true,
      statusCode: 200,
      body: {
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: payload.request_id,
        status: record.status,
        accepted_at: record.accepted_at,
        duplicate: true,
        sequence_import: sequenceImportSummary,
      },
      requestRecord: record,
      sequenceImportSummary,
    };
  }

  const acceptedAt = record?.accepted_at || new Date().toISOString();
  addGeminiHandoffEvent(payload.request_id, "handoff_accepted", "ingress", {
    accepted_at: acceptedAt,
  });

  const transportRuntime = getGeminiHandoffTransportRuntimeInfo();
  const dispatchResult = await dispatchGeminiHandoffRequest(payload);

  if (dispatchResult?.success && dispatchResult.response_payload && typeof dispatchResult.response_payload === "object") {
    const responseValidation = validateJsonSchema(
      GEMINI_HANDOFF_RESPONSE_SCHEMA,
      dispatchResult.response_payload
    );
    const responseRequestId = String(dispatchResult.response_payload.request_id || "").trim();

    if (responseValidation.valid && responseRequestId === String(payload.request_id)) {
      const updated = completeGeminiHandoffRequest(payload.request_id, dispatchResult.response_payload);
      addGeminiHandoffEvent(payload.request_id, "handoff_completed", "transport", {
        response_id: dispatchResult.response_payload.response_id || null,
        status: updated?.status || "partial",
      });

      const sequenceImportSummary = persistGeminiResponseSequences(updated);

      return {
        ok: true,
        statusCode: 202,
        body: {
          contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
          request_id: payload.request_id,
          status: updated?.status || "partial",
          accepted_at: acceptedAt,
          response_id: dispatchResult.response_payload.response_id || null,
          completed_at: dispatchResult.response_payload.completed_at || null,
          transport: {
            attempted: true,
            success: true,
            status_code: dispatchResult.status_code,
          },
          next_action: "request_completed",
          sequence_import: sequenceImportSummary,
        },
        requestRecord: updated,
        sequenceImportSummary,
      };
    }
  }

  if (dispatchResult?.attempted && !dispatchResult.success) {
    const updated = incrementGeminiHandoffRetry(payload.request_id);
    addGeminiHandoffEvent(payload.request_id, "handoff_retry_requested", "transport", {
      reason: dispatchResult.error_code || "transport_error",
      retry_count: updated?.retry_count || 1,
      fail_open: transportRuntime.fail_open === true,
    });

    if (!transportRuntime.fail_open) {
      return {
        ok: false,
        statusCode: 502,
        body: {
          error: "transport_dispatch_failed",
          contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
          request_id: payload.request_id,
          status: updated?.status || "retry_requested",
          retry_count: updated?.retry_count || 1,
          transport: {
            attempted: true,
            success: false,
            status_code: dispatchResult.status_code || null,
            code: dispatchResult.error_code || "transport_error",
            message: dispatchResult.error_message || "Gemini transport request failed",
          },
        },
        requestRecord: updated,
        sequenceImportSummary: null,
      };
    }

    return {
      ok: true,
      statusCode: 202,
      body: {
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: payload.request_id,
        status: updated?.status || "retry_requested",
        accepted_at: acceptedAt,
        retry_count: updated?.retry_count || 1,
        transport: {
          attempted: true,
          success: false,
          status_code: dispatchResult.status_code || null,
          code: dispatchResult.error_code || "transport_error",
        },
        next_action: "retry_requested",
      },
      requestRecord: updated,
      sequenceImportSummary: null,
    };
  }

  return {
    ok: true,
    statusCode: 202,
    body: {
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: payload.request_id,
      status: "accepted",
      accepted_at: acceptedAt,
      transport: {
        attempted: !!dispatchResult?.attempted,
        success: !!dispatchResult?.success,
        skipped: !!dispatchResult?.skipped,
        reason: dispatchResult?.reason || null,
      },
      next_action: "awaiting_gemini_response",
    },
    requestRecord: record,
    sequenceImportSummary: null,
  };
}

function getGeminiWeeklySelectionCandidates({
  focus = GEMINI_WEEKLY_DEFAULT_FOCUS,
  limit = GEMINI_WEEKLY_DEFAULT_LIMIT,
  weekStart,
  weekEnd,
}) {
  const safeLimit = clampGeminiWeeklyLimit(limit, GEMINI_WEEKLY_DEFAULT_LIMIT);
  const threshold = getTurnoverThreshold();
  const thresholdMax = getTurnoverMaxThreshold();
  const turnoverBand = parseShortlistTurnoverBand("all");
  const sortBy = "priority_score";
  const sortDir = "desc";

  const allCompanies = getShortlistCompanies({ min_turnover: threshold, max_turnover: thresholdMax });
  const companies = allCompanies.filter((c) => turnoverMatchesBand(c.latest_turnover, turnoverBand));
  const companyNumbers = companies.map((c) => c.company_number);
  const queueRows = getAnalysisQueueItemsByCompanyNumbers(companyNumbers);

  const entries = companies
    .map((c) => {
      const ws = getCompanyState(`ch-${c.company_number}`);
      const segment = guessTurnoverSegment(c.latest_turnover);
      const stored = getOrBuildMonitorScore(c.company_number);
      const supp = isSuppressed(`ch-${c.company_number}`, c.company_number);
      const queue = queueRows[c.company_number] || null;
      const storedAnalysis = getSetting(`analysis_${c.company_number}`, null);

      const analysisStatus = deriveAnalysisStatus(queue, storedAnalysis);
      const priority = computePriorityBreakdown(c, stored, analysisStatus, segment);
      const sourceType = deriveShortlistSourceType(c.source, c.latest_filing_date);
      const sourceFamily = deriveShortlistSourceFamily(sourceType);
      const filterReason = deriveShortlistFilterReason(c, supp, analysisStatus, sourceType);

      return {
        id: `ch-${c.company_number}`,
        company_number: c.company_number,
        name: formatMonitorName(c.company_name, c.company_number),
        turnover: c.latest_turnover,
        latest_filing_date: c.latest_filing_date,
        segment,
        combined_score: stored?.composite_score ?? 0,
        composite_score: stored?.composite_score ?? 0,
        score: stored,
        score_tier: scoreTier({ composite_score: stored?.composite_score ?? 0 }),
        workflow_state: ws.state,
        source: c.source,
        source_type: sourceType,
        source_family: sourceFamily,
        filter_reason: filterReason,
        analysis_status: analysisStatus,
        priority_score: priority.priority_score,
        priority_reason: priority.reason,
        suppressed: supp.suppressed,
      };
    })
    .filter((entry) => !entry.suppressed)
    .sort((a, b) => compareShortlistEntries(a, b, sortBy, sortDir));

  const byWeek = entries.map((entry) => {
    const filingDate = parseDateToUtc(entry.latest_filing_date);
    const normalizedFilingDate = filingDate ? new Date(filingDate) : null;
    if (normalizedFilingDate) {
      normalizedFilingDate.setHours(0, 0, 0, 0);
    }

    const isNewThisWeek = normalizedFilingDate
      ? normalizedFilingDate.getTime() >= weekStart.getTime() && normalizedFilingDate.getTime() <= weekEnd.getTime()
      : false;
    const isCarryover = !isNewThisWeek && GEMINI_WEEKLY_CARRYOVER_ACTIVE_STATES.has(entry.workflow_state);

    return {
      ...entry,
      is_new_this_week: isNewThisWeek,
      is_carryover: isCarryover,
    };
  });

  const focused = focus === "new"
    ? byWeek.filter((entry) => entry.is_new_this_week)
    : focus === "carryover"
      ? byWeek.filter((entry) => entry.is_carryover)
      : byWeek;

  const readyOnly = focused.filter((entry) => entry.analysis_status === "ready");

  const enriched = [];
  for (const entry of readyOnly.slice(0, safeLimit)) {
    const analysis = getSetting(`analysis_${entry.company_number}`, null);
    if (!analysis?.key_people || !Array.isArray(analysis.key_people) || analysis.key_people.length < 1) {
      continue;
    }
    const companyContext = {
      id: entry.id,
      name: entry.name,
      company_number: entry.company_number,
      turnover: entry.turnover,
      segment: entry.segment,
    };
    const scoredStakeholders = scoreAllStakeholders(analysis.key_people, {
      company: companyContext,
      analysis,
      motion: entry.score?.layers?.product_fit?.best_motion || "FX",
      filingDate: analysis.analysed_at || analysis.scored_at || null,
    });

    if (!Array.isArray(scoredStakeholders) || scoredStakeholders.length < 1) {
      continue;
    }

    enriched.push({
      ...entry,
      analysis,
      stakeholders: scoredStakeholders,
    });
  }

  return {
    focus,
    limit: safeLimit,
    candidates_total: entries.length,
    focused_total: focused.length,
    ready_total: readyOnly.length,
    selected_total: enriched.length,
    entries: enriched,
  };
}

async function runGeminiWeeklyHandoff(options = {}) {
  const weekLabel = normalizeGeminiWeekLabel(options.week_label, new Date());
  if (!weekLabel) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "invalid_week_label",
        message: "week_label must be in YYYY-MM-DD format",
      },
    };
  }

  const defaultWeekStartDate = new Date(`${weekLabel}T00:00:00.000Z`);
  const fallbackWeekStartDate = Number.isNaN(defaultWeekStartDate.getTime()) ? new Date() : defaultWeekStartDate;
  fallbackWeekStartDate.setUTCHours(0, 0, 0, 0);

  const fallbackWeekEndDate = new Date(fallbackWeekStartDate);
  fallbackWeekEndDate.setUTCDate(fallbackWeekEndDate.getUTCDate() + 6);
  fallbackWeekEndDate.setUTCHours(23, 59, 59, 999);

  const weekStart = toGeminiIsoDate(options.week_start) || fallbackWeekStartDate.toISOString();
  const weekEnd = toGeminiIsoDate(options.week_end) || fallbackWeekEndDate.toISOString();
  const focus = normalizeGeminiWeeklyFocus(options.focus, GEMINI_WEEKLY_DEFAULT_FOCUS);
  const limit = clampGeminiWeeklyLimit(options.limit, GEMINI_WEEKLY_DEFAULT_LIMIT);
  const maxTouches = clampGeminiWeeklyLimit(options.max_touches, GEMINI_HANDOFF_DEFAULT_MAX_TOUCHES);
  const dryRun = parseGeminiBooleanFlag(options.dry_run, false);
  const requestPrefix = String(options.request_prefix || "weekly").trim() || "weekly";
  const requestIdOverride = String(options.request_id || "").trim() || null;

  const weekStartDate = new Date(weekStart);
  const weekEndDate = new Date(weekEnd);
  if (Number.isNaN(weekStartDate.getTime()) || Number.isNaN(weekEndDate.getTime())) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "invalid_week_window",
        message: "week_start and week_end must be valid ISO datetimes",
      },
    };
  }

  const selection = getGeminiWeeklySelectionCandidates({
    focus,
    limit,
    weekStart: weekStartDate,
    weekEnd: weekEndDate,
  });

  if (selection.entries.length < 1) {
    return {
      ok: true,
      statusCode: 200,
      body: {
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        week_label: weekLabel,
        week_start: weekStartDate.toISOString(),
        week_end: weekEndDate.toISOString(),
        focus,
        limit,
        selected_count: 0,
        skipped: true,
        reason: "no_ready_companies_with_stakeholders",
        selection,
      },
    };
  }

  const requestEnvelope = buildGeminiRequestFromWeeklyEntries({
    weekLabel,
    weekStart: weekStartDate.toISOString(),
    weekEnd: weekEndDate.toISOString(),
    focus,
    selectedEntries: selection.entries,
    maxTouches,
    requestPrefix,
    requestIdOverride,
  });

  if (requestEnvelope.ranked_count < 1) {
    return {
      ok: true,
      statusCode: 200,
      body: {
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        week_label: weekLabel,
        week_start: weekStartDate.toISOString(),
        week_end: weekEndDate.toISOString(),
        focus,
        limit,
        selected_count: requestEnvelope.selected_count,
        ranked_count: 0,
        skipped: true,
        reason: "ranked_payload_empty",
        selection,
      },
    };
  }

  if (dryRun) {
    return {
      ok: true,
      statusCode: 200,
      body: {
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        dry_run: true,
        week_label: weekLabel,
        week_start: weekStartDate.toISOString(),
        week_end: weekEndDate.toISOString(),
        focus,
        limit,
        request_id: requestEnvelope.request_id,
        selected_count: requestEnvelope.selected_count,
        ranked_count: requestEnvelope.ranked_count,
        skipped_missing_stakeholders: requestEnvelope.skipped_missing_stakeholders,
        payload: requestEnvelope.payload,
        selection,
      },
    };
  }

  const handoffResult = await processGeminiHandoffRequestPayload(requestEnvelope.payload);
  return {
    ...handoffResult,
    body: {
      ...(handoffResult.body || {}),
      week_label: weekLabel,
      week_start: weekStartDate.toISOString(),
      week_end: weekEndDate.toISOString(),
      focus,
      limit,
      selected_count: requestEnvelope.selected_count,
      ranked_count: requestEnvelope.ranked_count,
      skipped_missing_stakeholders: requestEnvelope.skipped_missing_stakeholders,
      selection,
    },
  };
}

function summarizeGeminiWeeklyHandoffResult(result = {}) {
  const body = result?.body && typeof result.body === "object" ? result.body : {};
  return {
    ok: result?.ok !== false,
    status_code: Number(result?.statusCode || 200),
    request_id: body.request_id || null,
    status: body.status || null,
    week_label: body.week_label || null,
    focus: body.focus || null,
    limit: Number(body.limit || 0),
    selected_count: Number(body.selected_count || 0),
    ranked_count: Number(body.ranked_count || 0),
    skipped: body.skipped === true,
    reason: body.reason || null,
    duplicate: body.duplicate === true,
    transport: body.transport || null,
    sequence_import: body.sequence_import || null,
  };
}

async function maybeRunGeminiWeeklyHandoffForWeek(weekLabel, options = {}) {
  if (!GEMINI_WEEKLY_AUTORUN_ENABLED) {
    return {
      enabled: false,
      triggered: false,
      summary: {
        skipped: true,
        reason: "gemini_weekly_autorun_disabled",
      },
      result: null,
    };
  }

  const result = await runGeminiWeeklyHandoff({
    week_label: weekLabel,
    focus: options.focus ?? GEMINI_WEEKLY_DEFAULT_FOCUS,
    limit: options.limit ?? GEMINI_WEEKLY_DEFAULT_LIMIT,
    max_touches: options.max_touches ?? GEMINI_HANDOFF_DEFAULT_MAX_TOUCHES,
    request_prefix: options.request_prefix || "weekly",
    dry_run: options.dry_run === true,
  });

  return {
    enabled: true,
    triggered: true,
    summary: summarizeGeminiWeeklyHandoffResult(result),
    result,
  };
}

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
  const turnoverSignal = clamp01(turnover / getTurnoverMaxThreshold());
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
    || pendingCompanyName(companyNumber);

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

function normalizeStoredCompanyName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function inferFallbackCompanyNameReason(name, companyNumber) {
  const normalized = normalizeStoredCompanyName(name);
  if (!normalized) return "missing_company_name";

  const normalizedNumber = normalizeCompanyNumber(companyNumber) || String(companyNumber || "").trim();
  if (normalizedNumber && (normalized === `Company ${normalizedNumber}` || normalized === normalizedNumber)) {
    return "placeholder_company_number";
  }

  const reviewRule = GEMINI_COMPANY_NAME_REVIEW_RULES.find((rule) => rule.pattern.test(normalized));
  if (reviewRule) return reviewRule.reason;

  if (/^(?:notes?\s+to\b|to\s+set\s+out\b|report\s+and\s+accounts\b|strategic\s+report\b|company\s+information\b)/i.test(normalized)) {
    return "non_company_heading";
  }

  return null;
}

function isFallbackCompanyName(name, companyNumber) {
  return !!inferFallbackCompanyNameReason(name, companyNumber);
}

function pendingCompanyName(companyNumber = "") {
  const normalizedNumber = normalizeCompanyNumber(companyNumber);
  if (normalizedNumber) return `Name lookup needed (${normalizedNumber})`;
  return "Name lookup needed";
}

function resolveCompanyNameDisplay(storedName, companyNumber) {
  const normalized = normalizeStoredCompanyName(storedName);
  const unresolvedReason = inferFallbackCompanyNameReason(normalized, companyNumber);
  return {
    display_name: unresolvedReason ? pendingCompanyName(companyNumber) : normalized,
    unresolved_company_name: !!unresolvedReason,
    unresolved_company_name_reason: unresolvedReason,
  };
}

function displayNameForCompanyNumber(companyNumber, storedName) {
  return resolveCompanyNameDisplay(storedName, companyNumber).display_name;
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
  if (!isCompaniesHouseConfigured()) return pendingCompanyName(companyNumber);

  const lookup = await lookupCompany(companyNumber);
  const name = lookup?.name || lookup?.company_name;
  if (!lookup?.error && name) {
    updateMonitorCheck(companyNumber, { company_name: name, status: lookup.status || "active" });
    return name;
  }
  return pendingCompanyName(companyNumber);
}

function formatMonitorName(storedName, companyNumber) {
  return displayNameForCompanyNumber(companyNumber, storedName);
}

function buildSignalGeographyTop(geography, maxItems = 3) {
  if (!geography || typeof geography !== "object" || Array.isArray(geography)) return [];

  return Object.entries(geography)
    .map(([country, share]) => ({ country, share: toOptionalNumber(share) ?? null }))
    .filter((entry) => !!entry.country)
    .sort((a, b) => (toOptionalNumber(b.share) ?? -1) - (toOptionalNumber(a.share) ?? -1))
    .slice(0, maxItems);
}

function buildSignalEnvelopeSnapshot(kind, envelope, includeRaw = false) {
  if (!envelope || typeof envelope !== "object") {
    return {
      available: false,
      source: null,
      updated_at: null,
    };
  }

  const base = {
    available: true,
    source: String(envelope.source || "").trim() || null,
    updated_at: String(envelope.updated_at || envelope.fetched_at || "").trim() || null,
    confidence: String(envelope.confidence || "").trim() || null,
    confidence_score: toOptionalNumber(envelope.confidence_score),
    external_sources: Array.isArray(envelope.external_sources) ? envelope.external_sources : [],
  };

  if (kind === "tech_stack") {
    const technologies = Array.isArray(envelope.technologies)
      ? envelope.technologies
      : (Array.isArray(envelope.detected_technologies) ? envelope.detected_technologies : []);
    base.metrics = {
      signal_count: toOptionalNumber(envelope.signal_count) ?? technologies.length,
      technologies_sample: technologies.slice(0, 10),
    };
  } else if (kind === "website_intelligence") {
    const currencies = Array.isArray(envelope.pricing_currencies)
      ? envelope.pricing_currencies
      : (Array.isArray(envelope.currencies_on_pricing_page) ? envelope.currencies_on_pricing_page : []);
    const officeLocations = Array.isArray(envelope.office_locations) ? envelope.office_locations : [];
    base.metrics = {
      domain: String(envelope.domain || envelope.company_domain || "").trim() || null,
      website_url: String(envelope.website_url || envelope.url || "").trim() || null,
      customer_type: String(envelope.customer_type || "").trim() || null,
      pricing_currencies_count: currencies.length,
      office_locations_count: officeLocations.length,
      international_shipping: envelope.international_shipping === true,
      shipping_countries: toOptionalNumber(envelope.shipping_countries),
    };
  } else if (kind === "marketing_intelligence") {
    base.metrics = {
      monthly_web_traffic: toOptionalNumber(envelope.monthly_web_traffic) ?? toOptionalNumber(envelope.web_traffic),
      estimated_monthly_ad_spend: toOptionalNumber(envelope.estimated_monthly_ad_spend) ?? toOptionalNumber(envelope.estimated_ad_spend),
      traffic_geography_top: buildSignalGeographyTop(envelope.traffic_geography),
    };
  } else if (kind === "reputation") {
    base.metrics = {
      trustpilot_review_count: toOptionalNumber(envelope.trustpilot_review_count),
      payment_related_complaints: toOptionalNumber(envelope.payment_related_complaints),
      checkout_related_complaints: toOptionalNumber(envelope.checkout_related_complaints),
      status_health_band: String(envelope.status_health_band || "").trim() || null,
      status_incident_severity_score: toOptionalNumber(envelope.status_incident_severity_score),
      status_incidents_open: toOptionalNumber(envelope.status_incidents_open),
      status_major_incidents_open: toOptionalNumber(envelope.status_major_incidents_open),
      status_degraded_components: toOptionalNumber(envelope.status_degraded_components),
      status_recent_incident_at: String(envelope.status_recent_incident_at || "").trim() || null,
      status_recent_incident_age_days: toOptionalNumber(envelope.status_recent_incident_age_days),
    };
  } else if (kind === "hiring_signals") {
    const roleNames = (Array.isArray(envelope.open_roles) ? envelope.open_roles : [])
      .map((entry) => String(entry?.role || entry?.title || "").trim())
      .filter(Boolean);
    base.metrics = {
      total_open_roles: toOptionalNumber(envelope.total_open_roles),
      hiring_signal_score: toOptionalNumber(envelope.hiring_signal_score),
      hiring_intensity: String(envelope.hiring_intensity || "").trim() || null,
      role_sample: roleNames.slice(0, 10),
    };
  } else if (kind === "ownership") {
    base.metrics = {
      structure: String(envelope.structure || "").trim() || null,
      parent_company: String(envelope.parent_company || "").trim() || null,
      parent_country: String(envelope.parent_country || "").trim() || null,
      significant_corporate_controllers_count: toOptionalNumber(envelope.significant_corporate_controllers_count),
      non_uk_significant_corporate_controllers_count: toOptionalNumber(envelope.non_uk_significant_corporate_controllers_count),
    };
  }

  if (includeRaw) {
    base.raw = envelope;
  }

  return base;
}

function buildScoreSignalSnapshots(companyNumber, includeRaw = false) {
  return {
    tech_stack: buildSignalEnvelopeSnapshot("tech_stack", getSetting(`tech_stack_${companyNumber}`, null), includeRaw),
    website_intelligence: buildSignalEnvelopeSnapshot("website_intelligence", getSetting(`website_intelligence_${companyNumber}`, null), includeRaw),
    marketing_intelligence: buildSignalEnvelopeSnapshot("marketing_intelligence", getSetting(`marketing_intelligence_${companyNumber}`, null), includeRaw),
    reputation: buildSignalEnvelopeSnapshot("reputation", getSetting(`reputation_${companyNumber}`, null), includeRaw),
    hiring_signals: buildSignalEnvelopeSnapshot("hiring_signals", getSetting(`hiring_signals_${companyNumber}`, null), includeRaw),
    ownership: buildSignalEnvelopeSnapshot("ownership", getSetting(`ownership_${companyNumber}`, null), includeRaw),
  };
}

function buildScoreLayerBreakdown(score) {
  const layers = score?.layers || {};
  const competitorDetectedCount = Array.isArray(layers?.competitor_context?.detected)
    ? layers.competitor_context.detected.length
    : 0;

  return [
    {
      layer: "product_fit",
      score: toOptionalNumber(layers?.product_fit?.score),
      best_motion: String(layers?.product_fit?.best_motion || "").trim() || null,
    },
    {
      layer: "commercial_value",
      score: toOptionalNumber(layers?.commercial_value?.score),
    },
    {
      layer: "pain_strength",
      score: toOptionalNumber(layers?.pain_strength?.score),
    },
    {
      layer: "urgency",
      score: toOptionalNumber(layers?.urgency?.score),
      trend: String(layers?.urgency?.trend || "").trim() || null,
    },
    {
      layer: "competitor_context",
      score: toOptionalNumber(layers?.competitor_context?.score),
      detected_competitors: competitorDetectedCount,
    },
    {
      layer: "switching_feasibility",
      score: toOptionalNumber(layers?.switching_feasibility?.score),
      band: String(layers?.switching_feasibility?.band || "").trim() || null,
    },
  ];
}

function buildScoreDeltaBreakdown(score) {
  const integrationQuality = score?.integration_quality || {};
  const deterministicBase = toOptionalNumber(integrationQuality.deterministic_base);
  const llmBoost = toOptionalNumber(integrationQuality.bounded_boost) ?? 0;
  const stakeholderBoost = toOptionalNumber(score?.stakeholder_priority?.boost) ?? 0;
  const finalComposite = toOptionalNumber(score?.composite_score);

  const clampUnit = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (numeric <= 0) return 0;
    if (numeric >= 1) return 1;
    return Math.round(numeric * 100) / 100;
  };

  const postLlm = deterministicBase === null ? null : clampUnit(deterministicBase + llmBoost);
  const postStakeholder = postLlm === null ? null : clampUnit(postLlm + stakeholderBoost);
  const residualDelta = (finalComposite === null || postStakeholder === null)
    ? null
    : Math.round((finalComposite - postStakeholder) * 100) / 100;

  return {
    deterministic_base: deterministicBase,
    llm_bounded_boost: Math.round(llmBoost * 100) / 100,
    stakeholder_boost: Math.round(stakeholderBoost * 100) / 100,
    inferred_post_llm: postLlm,
    inferred_post_stakeholder: postStakeholder,
    final_composite: finalComposite,
    residual_delta: residualDelta,
  };
}

function buildScoreMotionImpactBreakdown(score) {
  const motionScores = score?.all_motion_scores && typeof score.all_motion_scores === "object"
    ? score.all_motion_scores
    : {};
  const llmMotionBoosts = [];
  const competitorMotionBoosts = [];
  const enrichmentMotionBoosts = [];

  for (const [motion, details] of Object.entries(motionScores)) {
    const llmBoost = toOptionalNumber(details?.llm_boost);
    const llmRawBoost = toOptionalNumber(details?.llm_boost_raw);
    if (llmBoost !== null || llmRawBoost !== null) {
      llmMotionBoosts.push({
        motion,
        applied_boost: llmBoost,
        raw_boost: llmRawBoost,
      });
    }

    const competitorBoost = toOptionalNumber(details?.competitor_boost);
    if (competitorBoost !== null) {
      competitorMotionBoosts.push({ motion, boost: competitorBoost });
    }

    for (const [key, value] of Object.entries(details || {})) {
      if (!key.endsWith("_boost")) continue;
      if (["llm_boost", "llm_boost_raw", "competitor_boost"].includes(key)) continue;
      const boost = toOptionalNumber(value);
      if (boost === null || boost === 0) continue;
      enrichmentMotionBoosts.push({
        motion,
        source: key.replace(/_boost$/, ""),
        boost,
      });
    }
  }

  return {
    llm_motion_boosts: llmMotionBoosts,
    competitor_motion_boosts: competitorMotionBoosts,
    enrichment_motion_boosts: enrichmentMotionBoosts,
    enrichment_motion_adjustments: score?.enrichment?.motion_adjustments || null,
  };
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

function normalizeSeedImportCompanyNumber(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^CH-/, "")
    .replace(/\s+/g, "");

  if (!raw) return null;
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, "0");
  if (/^[A-Z]{2}\d+$/.test(raw)) return raw;
  if (/^[A-Z0-9]{2,12}$/.test(raw)) return raw;
  return null;
}

function normalizeSeedImportText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeSeedImportWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  const cleaned = raw.replace(/^\/+/, "").trim();
  if (!cleaned || !/[.]/.test(cleaned)) return null;
  return `https://${cleaned}`;
}

function extractSeedImportDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return String(url.hostname || "").trim().toLowerCase().replace(/^www\./, "") || null;
  } catch {
    const host = raw
      .toLowerCase()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./, "")
      .split(/[/?#]/)[0]
      .trim();
    return host || null;
  }
}

function isLikelySeedImportWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw);
}

function normalizeSeedImportHeaderCell(cell) {
  return String(cell || "")
    .trim()
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, "_");
}

function findSeedImportHeaderIndex(headerCells, predicates) {
  for (const predicate of predicates) {
    const idx = headerCells.findIndex(predicate);
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseMonitorSeedRowsFromCsv(csvContent) {
  const text = String(csvContent || "").replace(/\r/g, "").trim();
  if (!text) return [];

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const headerCells = parseCsvRow(lines[0]).map((cell) => normalizeSeedImportHeaderCell(cell));
  const hasHeader = headerCells.some((cell) => {
    return cell.includes("company")
      || cell.includes("name")
      || cell.includes("website")
      || cell.includes("domain")
      || cell.includes("number");
  });

  const numberIdx = hasHeader
    ? findSeedImportHeaderIndex(headerCells, [
      (cell) => cell.includes("company") && (cell.includes("number") || cell.includes("registration") || cell.endsWith("_no")),
      (cell) => cell === "number" || cell === "companynumber",
    ])
    : -1;

  const nameIdx = hasHeader
    ? findSeedImportHeaderIndex(headerCells, [
      (cell) => cell.includes("company") && cell.includes("name"),
      (cell) => cell === "name",
    ])
    : -1;

  const websiteIdx = hasHeader
    ? findSeedImportHeaderIndex(headerCells, [
      (cell) => cell.includes("website"),
      (cell) => cell.includes("url"),
      (cell) => cell === "site",
    ])
    : -1;

  const domainIdx = hasHeader
    ? findSeedImportHeaderIndex(headerCells, [
      (cell) => cell.includes("domain"),
    ])
    : -1;

  const startIdx = hasHeader ? 1 : 0;
  const rows = [];

  for (let i = startIdx; i < lines.length; i += 1) {
    const cells = parseCsvRow(lines[i]).map((cell) => String(cell || "").trim());
    if (cells.length === 0) continue;

    const explicitNumber = numberIdx >= 0 ? cells[numberIdx] : null;
    const explicitName = nameIdx >= 0 ? cells[nameIdx] : null;
    const explicitWebsite = websiteIdx >= 0 ? cells[websiteIdx] : null;
    const explicitDomain = domainIdx >= 0 ? cells[domainIdx] : null;

    let companyNumber = normalizeSeedImportCompanyNumber(explicitNumber);
    let companyName = normalizeSeedImportText(explicitName);
    let companyWebsite = normalizeSeedImportWebsite(explicitWebsite);
    let companyDomain = extractSeedImportDomain(explicitDomain || explicitWebsite || "");

    if (!companyNumber) {
      const maybeNumber = cells.find((cell) => !!normalizeSeedImportCompanyNumber(cell));
      companyNumber = normalizeSeedImportCompanyNumber(maybeNumber);
    }

    if (!companyWebsite) {
      const maybeWebsite = cells.find((cell) => isLikelySeedImportWebsite(cell));
      companyWebsite = normalizeSeedImportWebsite(maybeWebsite);
      if (!companyDomain) {
        companyDomain = extractSeedImportDomain(maybeWebsite || "");
      }
    }

    if (!companyName) {
      const maybeName = cells.find((cell) => {
        if (!cell) return false;
        if (normalizeSeedImportCompanyNumber(cell)) return false;
        if (isLikelySeedImportWebsite(cell)) return false;
        return true;
      });
      companyName = normalizeSeedImportText(maybeName);
    }

    if (!companyWebsite && companyDomain) {
      companyWebsite = normalizeSeedImportWebsite(companyDomain);
    }

    if (!companyNumber && !companyName) continue;

    rows.push({
      row_number: i + 1,
      company_number: companyNumber,
      company_name: companyName,
      company_website: companyWebsite,
      company_domain: companyDomain,
    });
  }

  return rows;
}

function shouldAcceptSeedImportConfidence(confidence, allowLowConfidence) {
  const token = String(confidence || "none").trim().toLowerCase();
  if (token === "high" || token === "medium") return true;
  if (allowLowConfidence && token === "low") return true;
  return false;
}

async function resolveMonitorSeedRows(rows, options = {}) {
  const resolved = [];
  const unresolved = [];
  const deduped = new Map();

  const searchLimit = Number.parseInt(String(options.search_limit || "20"), 10);
  const allowLowConfidence = options.allow_low_confidence === true;

  for (const row of rows) {
    if (row.company_number) {
      const existing = deduped.get(row.company_number);
      if (existing) {
        if (!existing.company_name && row.company_name) existing.company_name = row.company_name;
        if (!existing.company_website && row.company_website) existing.company_website = row.company_website;
        if (!existing.company_domain && row.company_domain) existing.company_domain = row.company_domain;
      } else {
        deduped.set(row.company_number, {
          ...row,
          resolution: "provided",
          match_confidence: "provided",
        });
      }
      continue;
    }

    if (!row.company_name) {
      unresolved.push({ ...row, reason: "missing_company_name" });
      continue;
    }

    if (!isCompaniesHouseConfigured()) {
      unresolved.push({ ...row, reason: "companies_house_not_configured" });
      continue;
    }

    const lookup = await searchCompaniesByName(row.company_name, {
      items_per_page: Number.isFinite(searchLimit) ? Math.max(1, Math.min(searchLimit, 100)) : 20,
    });

    if (lookup?.error) {
      unresolved.push({
        ...row,
        reason: "lookup_error",
        detail: lookup.message || "companies_house_search_failed",
      });
      continue;
    }

    const confidence = String(lookup?.match_confidence || "none").trim().toLowerCase();
    const matchedNumber = normalizeSeedImportCompanyNumber(lookup?.best_match?.company_number);
    if (!matchedNumber) {
      unresolved.push({ ...row, reason: "no_match" });
      continue;
    }

    if (!shouldAcceptSeedImportConfidence(confidence, allowLowConfidence)) {
      unresolved.push({
        ...row,
        reason: "low_confidence_match",
        matched_company_number: matchedNumber,
        matched_company_name: lookup?.best_match?.company_name || null,
      });
      continue;
    }

    const resolvedRow = {
      ...row,
      company_number: matchedNumber,
      company_name: normalizeSeedImportText(lookup?.best_match?.company_name) || row.company_name,
      resolution: "search",
      match_confidence: confidence,
      matched_company_name: normalizeSeedImportText(lookup?.best_match?.company_name),
    };

    const existing = deduped.get(matchedNumber);
    if (existing) {
      if (!existing.company_name && resolvedRow.company_name) existing.company_name = resolvedRow.company_name;
      if (!existing.company_website && resolvedRow.company_website) existing.company_website = resolvedRow.company_website;
      if (!existing.company_domain && resolvedRow.company_domain) existing.company_domain = resolvedRow.company_domain;
    } else {
      deduped.set(matchedNumber, resolvedRow);
    }
  }

  for (const value of deduped.values()) {
    resolved.push(value);
  }

  return { resolved, unresolved };
}

function sortRecentFilingsByDateDesc(filings) {
  return [...filings].sort((a, b) => {
    const aTs = Date.parse(String(a?.date || ""));
    const bTs = Date.parse(String(b?.date || ""));
    const safeA = Number.isFinite(aTs) ? aTs : 0;
    const safeB = Number.isFinite(bTs) ? bTs : 0;
    return safeB - safeA;
  });
}

function parseClosedWonRowsFromCsv(csvContent) {
  const text = String(csvContent || "").replace(/\r/g, "").trim();
  if (!text) return [];

  const normalizeClosedWonCompanyNumber = (value) => {
    const raw = String(value || "").trim().toUpperCase();
    if (!raw) return null;

    const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
    if (!stripped) return null;

    // Accept plain UK numeric registration numbers (1-8 digits) with left-zero normalization.
    if (/^\d{1,8}$/.test(stripped)) {
      return normalizeCompanyNumber(stripped);
    }

    // Accept alphanumeric registration numbers only when they contain enough digits
    // to avoid false positives from prose tokens like "SELECTITEM1".
    if (/^[A-Z0-9]{2,12}$/.test(stripped)) {
      const digitCount = (stripped.match(/\d/g) || []).length;
      if (digitCount >= 4) return normalizeCompanyNumber(stripped);
    }

    return null;
  };

  const parseFromRawText = () => {
    const rows = [];
    const seen = new Set();
    const pattern = /COMPANIES\s+REGISTRY\s+OFFICE\s+Number\s*\(GB\):\s*([A-Z0-9]{1,12})/gi;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const normalizedNumber = normalizeClosedWonCompanyNumber(match[1]);
      if (!normalizedNumber || seen.has(normalizedNumber)) continue;
      seen.add(normalizedNumber);
      rows.push({ company_number: normalizedNumber, company_name: null });
    }

    return rows;
  };

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
      candidateNumber = cells.find((cell) => !!normalizeClosedWonCompanyNumber(cell)) || null;
    }

    const normalizedNumber = normalizeClosedWonCompanyNumber(candidateNumber);
    if (!normalizedNumber) continue;

    const candidateName = nameIdx >= 0
      ? cells[nameIdx]
      : cells.find((cell, idx) => idx !== numberIdx && idx !== -1 && cell && !normalizeClosedWonCompanyNumber(cell));

    rows.push({
      company_number: normalizedNumber,
      company_name: String(candidateName || "").trim() || null,
    });
  }

  if (rows.length > 0) return rows;
  return parseFromRawText();
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

function normalizeStakeholderToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildStakeholderKey(stakeholder, rank = 0) {
  const normalizedName = normalizeStakeholderToken(stakeholder?.name);
  if (normalizedName) {
    return `name:${normalizedName}`;
  }

  const normalizedRole = normalizeStakeholderToken(stakeholder?.role);
  if (normalizedRole) {
    return `role:${normalizedRole}`;
  }

  return `unknown:${rank + 1}`;
}

function isStakeholderWatchRole(role) {
  const normalizedRole = normalizeStakeholderToken(role);
  if (!normalizedRole) return false;
  return STAKEHOLDER_ALERT_WATCH_ROLE_PATTERNS.some((pattern) => pattern.test(normalizedRole));
}

function normalizeStakeholderSnapshot(stakeholders = []) {
  const rows = Array.isArray(stakeholders) ? stakeholders : [];

  const normalized = rows
    .map((stakeholder, idx) => {
      const name = String(stakeholder?.name || "").replace(/\s+/g, " ").trim() || null;
      const role = String(stakeholder?.role || "").replace(/\s+/g, " ").trim() || null;
      const finalScoreRaw = Number(stakeholder?.final_score);
      const finalScore = Number.isFinite(finalScoreRaw) ? Math.round(finalScoreRaw * 10) / 10 : 0;
      const confidenceLevel = String(stakeholder?.confidence_level || "").trim().toLowerCase() || null;
      const buyingRole = String(stakeholder?.buying_role || "").trim().toLowerCase() || null;
      const needsVerification = stakeholder?.needs_verification === true;

      return {
        stakeholder_key: buildStakeholderKey({ name, role }, idx),
        stakeholder_name: name,
        stakeholder_role: role,
        final_score: finalScore,
        confidence_level: confidenceLevel,
        buying_role: buyingRole,
        needs_verification: needsVerification,
        watch_role: isStakeholderWatchRole(role),
      };
    })
    .sort((a, b) => Number(b.final_score || 0) - Number(a.final_score || 0));

  const hashInput = normalized.map((entry) => ({
    stakeholder_key: entry.stakeholder_key,
    stakeholder_name: entry.stakeholder_name,
    stakeholder_role: entry.stakeholder_role,
    final_score: entry.final_score,
    confidence_level: entry.confidence_level,
    buying_role: entry.buying_role,
    needs_verification: entry.needs_verification,
    watch_role: entry.watch_role,
  }));

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    hash: sha256Hex(JSON.stringify(hashInput)),
    items: normalized,
  };
}

function loadStakeholderAlertSnapshot(companyId) {
  const canonicalId = canonicalCompanyId(companyId);
  const key = `${STAKEHOLDER_ALERT_SNAPSHOT_SETTINGS_PREFIX}${canonicalId}`;
  const snapshot = getSetting(key, null);
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  return {
    version: Number(snapshot.version || 1),
    generated_at: snapshot.generated_at || null,
    hash: String(snapshot.hash || "").trim(),
    items,
  };
}

function saveStakeholderAlertSnapshot(companyId, snapshot, metadata = {}) {
  const canonicalId = canonicalCompanyId(companyId);
  const key = `${STAKEHOLDER_ALERT_SNAPSHOT_SETTINGS_PREFIX}${canonicalId}`;
  setSetting(key, {
    version: Number(snapshot?.version || 1),
    generated_at: snapshot?.generated_at || new Date().toISOString(),
    hash: String(snapshot?.hash || ""),
    items: Array.isArray(snapshot?.items) ? snapshot.items : [],
    company_name: metadata.company_name || null,
    company_number: metadata.company_number || null,
    primary_motion: metadata.primary_motion || null,
  });
}

function buildStakeholderAlertCandidates(previousSnapshot, currentSnapshot, context = {}) {
  const previousItems = Array.isArray(previousSnapshot?.items) ? previousSnapshot.items : [];
  const currentItems = Array.isArray(currentSnapshot?.items) ? currentSnapshot.items : [];
  const previousByKey = new Map(previousItems.map((item) => [String(item?.stakeholder_key || "").trim(), item]));
  const currentByKey = new Map(currentItems.map((item) => [String(item?.stakeholder_key || "").trim(), item]));
  const events = [];

  for (const current of currentItems) {
    const stakeholderKey = String(current?.stakeholder_key || "").trim();
    if (!stakeholderKey) continue;

    const previous = previousByKey.get(stakeholderKey) || null;
    const previousScore = Number(previous?.final_score || 0);
    const currentScore = Number(current?.final_score || 0);
    const deltaScore = Math.round((currentScore - previousScore) * 10) / 10;
    const crossedHighPriority = previousScore < STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE
      && currentScore >= STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE;
    const jumped = deltaScore >= STAKEHOLDER_ALERT_PRIORITY_JUMP;
    const confidenceUpgraded = String(previous?.confidence_level || "") !== "high"
      && String(current?.confidence_level || "") === "high";
    const verificationCleared = previous?.needs_verification === true && current?.needs_verification === false;

    if (!previous) {
      if (currentScore >= STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE || current?.watch_role) {
        events.push({
          event_type: "new_relevant_stakeholder",
          severity: currentScore >= STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE ? "high" : "medium",
          stakeholder_key: stakeholderKey,
          stakeholder_name: current.stakeholder_name,
          stakeholder_role: current.stakeholder_role,
          previous_score: null,
          current_score: currentScore,
          delta_score: null,
          confidence_level: current.confidence_level,
          buying_role: current.buying_role,
          detail: {
            reason: current?.watch_role ? "watch_role_detected" : "high_priority_score",
            company_name: context.company_name || null,
            company_number: context.company_number || null,
            primary_motion: context.primary_motion || null,
            threshold_score: STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE,
          },
        });
      }
      continue;
    }

    if (crossedHighPriority || jumped || confidenceUpgraded) {
      const reason = crossedHighPriority
        ? "crossed_high_priority_threshold"
        : jumped
          ? "score_jump"
          : "confidence_upgraded";
      events.push({
        event_type: "stakeholder_priority_increase",
        severity: crossedHighPriority || currentScore >= STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE ? "high" : "medium",
        stakeholder_key: stakeholderKey,
        stakeholder_name: current.stakeholder_name,
        stakeholder_role: current.stakeholder_role,
        previous_score: previousScore,
        current_score: currentScore,
        delta_score: deltaScore,
        confidence_level: current.confidence_level,
        buying_role: current.buying_role,
        detail: {
          reason,
          company_name: context.company_name || null,
          company_number: context.company_number || null,
          primary_motion: context.primary_motion || null,
          threshold_score: STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE,
          minimum_jump: STAKEHOLDER_ALERT_PRIORITY_JUMP,
        },
      });
    }

    if (verificationCleared) {
      events.push({
        event_type: "stakeholder_verification_cleared",
        severity: "medium",
        stakeholder_key: stakeholderKey,
        stakeholder_name: current.stakeholder_name,
        stakeholder_role: current.stakeholder_role,
        previous_score: previousScore,
        current_score: currentScore,
        delta_score: deltaScore,
        confidence_level: current.confidence_level,
        buying_role: current.buying_role,
        detail: {
          reason: "needs_verification_cleared",
          company_name: context.company_name || null,
          company_number: context.company_number || null,
          primary_motion: context.primary_motion || null,
        },
      });
    }
  }

  for (const previous of previousItems) {
    const stakeholderKey = String(previous?.stakeholder_key || "").trim();
    if (!stakeholderKey) continue;
    if (currentByKey.has(stakeholderKey)) continue;
    const previousScore = Number(previous?.final_score || 0);
    if (previousScore < STAKEHOLDER_ALERT_HIGH_PRIORITY_SCORE) continue;

    events.push({
      event_type: "stakeholder_no_longer_detected",
      severity: "info",
      stakeholder_key: stakeholderKey,
      stakeholder_name: previous.stakeholder_name || null,
      stakeholder_role: previous.stakeholder_role || null,
      previous_score: previousScore,
      current_score: null,
      delta_score: null,
      confidence_level: String(previous?.confidence_level || "").trim().toLowerCase() || null,
      buying_role: String(previous?.buying_role || "").trim().toLowerCase() || null,
      detail: {
        reason: "missing_from_latest_snapshot",
        company_name: context.company_name || null,
        company_number: context.company_number || null,
        primary_motion: context.primary_motion || null,
      },
    });
  }

  const severityWeight = {
    high: 3,
    medium: 2,
    info: 1,
  };

  return events
    .sort((a, b) => {
      const severityDelta = (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
      if (severityDelta !== 0) return severityDelta;
      return Number(b.current_score || 0) - Number(a.current_score || 0);
    })
    .slice(0, 15);
}

function syncStakeholderAlertFeed({ companyId, companyNumber, companyName, stakeholders, primaryMotion }) {
  const canonicalId = canonicalCompanyId(companyId);
  const previousSnapshot = loadStakeholderAlertSnapshot(canonicalId);
  const currentSnapshot = normalizeStakeholderSnapshot(stakeholders || []);
  const previousHash = String(previousSnapshot?.hash || "").trim();
  const currentHash = String(currentSnapshot?.hash || "").trim();

  if (previousHash && currentHash && previousHash === currentHash) {
    return {
      changed: false,
      inserted: 0,
      snapshot_hash: currentHash,
      generated_at: currentSnapshot.generated_at,
      candidate_count: 0,
    };
  }

  const candidates = buildStakeholderAlertCandidates(previousSnapshot, currentSnapshot, {
    company_name: companyName,
    company_number: companyNumber,
    primary_motion: primaryMotion,
  });

  let inserted = 0;
  for (const candidate of candidates) {
    const insertedId = addStakeholderAlertEvent({
      company_id: canonicalId,
      company_number: companyNumber,
      snapshot_hash: currentHash,
      event_type: candidate.event_type,
      severity: candidate.severity,
      stakeholder_key: candidate.stakeholder_key,
      stakeholder_name: candidate.stakeholder_name,
      stakeholder_role: candidate.stakeholder_role,
      previous_score: candidate.previous_score,
      current_score: candidate.current_score,
      delta_score: candidate.delta_score,
      confidence_level: candidate.confidence_level,
      buying_role: candidate.buying_role,
      detail: {
        ...(candidate.detail || {}),
        event_label: STAKEHOLDER_ALERT_EVENT_LABELS[candidate.event_type] || candidate.event_type,
      },
    });
    if (insertedId) inserted += 1;
  }

  saveStakeholderAlertSnapshot(canonicalId, currentSnapshot, {
    company_name: companyName,
    company_number: companyNumber,
    primary_motion: primaryMotion,
  });

  return {
    changed: true,
    inserted,
    snapshot_hash: currentHash,
    generated_at: currentSnapshot.generated_at,
    candidate_count: candidates.length,
  };
}

function buildStakeholderAlertSummary(companyId, options = {}) {
  const canonicalId = canonicalCompanyId(companyId);
  const rawLimit = Number.parseInt(String(options?.limit || 12), 10);
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 12;
  const rawOffset = Number.parseInt(String(options?.offset || 0), 10);
  const offset = Number.isInteger(rawOffset) ? Math.max(0, Math.min(rawOffset, 5000)) : 0;
  const sinceHours = Number.parseInt(String(options?.sinceHours || ""), 10);
  const safeSinceHours = Number.isInteger(sinceHours) && sinceHours > 0
    ? Math.min(sinceHours, 24 * 365)
    : null;
  const eventType = String(options?.eventType || "").trim() || null;

  const queryOptions = {
    limit,
    offset,
    eventType,
    ...(safeSinceHours ? { sinceHours: safeSinceHours } : {}),
  };

  const items = listStakeholderAlertEvents(canonicalId, queryOptions).map((item) => ({
    ...item,
    event_label: STAKEHOLDER_ALERT_EVENT_LABELS[item.event_type] || item.event_type,
  }));

  const total = countStakeholderAlertEvents(canonicalId, {
    eventType,
    ...(safeSinceHours ? { sinceHours: safeSinceHours } : {}),
  });

  return {
    total,
    limit,
    offset,
    event_type: eventType,
    since_hours: safeSinceHours,
    latest_event_at: items[0]?.created_at || null,
    event_labels: STAKEHOLDER_ALERT_EVENT_LABELS,
    by_type: getStakeholderAlertTypeCounts(canonicalId, {
      eventType,
      ...(safeSinceHours ? { sinceHours: safeSinceHours } : {}),
    }),
    recent_7d_by_type: getStakeholderAlertTypeCounts(canonicalId, {
      eventType,
      sinceHours: STAKEHOLDER_ALERT_RECENT_HOURS,
    }),
    items,
  };
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
  const stakeholderAlertSync = syncStakeholderAlertFeed({
    companyId: canonicalId,
    companyNumber,
    companyName: company.name,
    stakeholders: assessment.stakeholders,
    primaryMotion: assessment.primary_motion,
  });
  const stakeholderAlerts = buildStakeholderAlertSummary(canonicalId, { limit: 12 });

  return {
    company_id: canonicalId,
    company_number: companyNumber,
    company_name: company.name,
    analysis,
    score,
    stakeholder_alert_sync: stakeholderAlertSync,
    stakeholder_alerts: stakeholderAlerts,
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
  const totalCompanies = getShortlistCount(getTurnoverThreshold(), getTurnoverMaxThreshold());

  const pipeline = {};
  for (const s of WORKFLOW_STATES) {
    pipeline[s.id] = { count: 0, label: s.label, color: s.color };
  }
  pipeline.new_candidate.count = totalCompanies;

  const turnoverBuckets = {
    "£100M-£200M": { min: 100_000_000, max: 200_000_000, count: 0 },
    "£50M-£100M": { min: 50_000_000, max: 100_000_000, count: 0 },
    "£30M-£50M": { min: 30_000_000, max: 50_000_000, count: 0 },
  };

  const topCompanies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), max_turnover: getTurnoverMaxThreshold(), limit: 500 })
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
    threshold_min: getTurnoverThreshold(),
    threshold_max: getTurnoverMaxThreshold(),
    threshold: getTurnoverThreshold(),
  });
});

const SHORTLIST_TURNOVER_BANDS = {
  all: null,
  "30-50": { min: 30_000_000, max: 50_000_000 },
  "50-100": { min: 50_000_000, max: 100_000_000 },
  "100-200": { min: 100_000_000, max: 200_000_000 },
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
  const thresholdMax = getTurnoverMaxThreshold();
  const allCompanies = getShortlistCompanies({ min_turnover: threshold, max_turnover: thresholdMax, limit: sampleLimit });
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
      threshold_max: thresholdMax,
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
  const thresholdMax = getTurnoverMaxThreshold();
  const allCompanies = getShortlistCompanies({ min_turnover: threshold, max_turnover: thresholdMax });
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
      const nameResolution = resolveCompanyNameDisplay(c.company_name, c.company_number);

      const analysis_status = deriveAnalysisStatus(queue, storedAnalysis);
      const priority = computePriorityBreakdown(c, stored, analysis_status, segment);
      const sourceType = deriveShortlistSourceType(c.source, c.latest_filing_date);
      const sourceFamily = deriveShortlistSourceFamily(sourceType);
      const filterReason = deriveShortlistFilterReason(c, supp, analysis_status, sourceType);
      const statusSignals = getStatusSignalSnapshot(c.company_number);

      return {
        id: `ch-${c.company_number}`,
        company_number: c.company_number,
        name: nameResolution.display_name,
        unresolved_company_name: nameResolution.unresolved_company_name,
        unresolved_company_name_reason: nameResolution.unresolved_company_name_reason,
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
      threshold_max: thresholdMax,
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
      const displayNameResolution = resolveCompanyNameDisplay(displayName, companyNumber);
      const monitorCompany = {
        id: profileId,
        name: displayNameResolution.display_name,
        company_number: companyNumber,
        turnover: monitored.latest_turnover,
        industry: titleCase(score?.industries?.[0]),
      };
      const reputationSignals = getStatusSignalSnapshot(companyNumber);
      const { stakeholders, assessment } = getProfileStakeholders(profileId, analysis, score, monitorCompany);
      syncStakeholderAlertFeed({
        companyId: profileId,
        companyNumber,
        companyName: displayNameResolution.display_name,
        stakeholders: assessment.stakeholders,
        primaryMotion: assessment.primary_motion,
      });
      const stakeholderAlerts = buildStakeholderAlertSummary(profileId, { limit: 12 });
      const competitors = getProfileCompetitors(profileId, analysis, score);
      const cadenceHistory = getCadenceLog(profileId);
      const ownershipStructure = getSetting(`ownership_${companyNumber}`, null);
      const sicCodes = getStoredSicCodes(companyNumber);
      const baseScore = score?.composite_score ?? (monitored.latest_turnover ? Math.round((Math.min(monitored.latest_turnover / getTurnoverMaxThreshold(), 1) * 0.7 + 0.3) * 100) / 100 : 0);

      return res.json({
        company: {
          id: profileId,
          company_number: companyNumber,
          name: displayNameResolution.display_name,
          unresolved_company_name: displayNameResolution.unresolved_company_name,
          unresolved_company_name_reason: displayNameResolution.unresolved_company_name_reason,
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
          stakeholder_alerts: stakeholderAlerts,
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
  const companyNameResolution = resolveCompanyNameDisplay(company.name, company.company_number);
  const stakeholderAssessment = buildStakeholderAssessment(company.id, company, analysis, storedScore);
  syncStakeholderAlertFeed({
    companyId: company.id,
    companyNumber: company.company_number,
    companyName: companyNameResolution.display_name,
    stakeholders: stakeholderAssessment.stakeholders,
    primaryMotion: stakeholderAssessment.primary_motion,
  });
  const stakeholderAlerts = buildStakeholderAlertSummary(company.id, { limit: 12 });

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
        name: companyNameResolution.display_name,
        unresolved_company_name: companyNameResolution.unresolved_company_name,
        unresolved_company_name_reason: companyNameResolution.unresolved_company_name_reason,
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
        stakeholder_assessment: stakeholderAssessment,
        stakeholder_alerts: stakeholderAlerts,
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
        name: companyNameResolution.display_name,
        unresolved_company_name: companyNameResolution.unresolved_company_name,
        unresolved_company_name_reason: companyNameResolution.unresolved_company_name_reason,
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
        stakeholder_assessment: stakeholderAssessment,
        stakeholder_alerts: stakeholderAlerts,
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

app.get("/api/company/:id/stakeholder-alerts", (req, res) => {
  const companyId = canonicalCompanyId(req.params.id);
  const companyNumber = companyNumberFromId(companyId);

  const rawLimit = Number.parseInt(String(req.query?.limit || "25"), 10);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
    return res.status(400).json({
      error: "invalid_limit",
      message: "limit must be an integer between 1 and 200",
    });
  }

  const rawOffset = Number.parseInt(String(req.query?.offset || "0"), 10);
  if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 10000) {
    return res.status(400).json({
      error: "invalid_offset",
      message: "offset must be an integer between 0 and 10000",
    });
  }

  const rawSinceHours = String(req.query?.since_hours || "").trim();
  let sinceHours = null;
  if (rawSinceHours) {
    const parsedSinceHours = Number.parseInt(rawSinceHours, 10);
    if (!Number.isInteger(parsedSinceHours) || parsedSinceHours < 1 || parsedSinceHours > 24 * 365) {
      return res.status(400).json({
        error: "invalid_since_hours",
        message: `since_hours must be an integer between 1 and ${24 * 365}`,
      });
    }
    sinceHours = parsedSinceHours;
  }

  const eventType = String(req.query?.event_type || "").trim() || null;
  const summary = buildStakeholderAlertSummary(companyId, {
    limit: rawLimit,
    offset: rawOffset,
    sinceHours,
    eventType,
  });

  return res.json({
    company_id: companyId,
    company_number: companyNumber,
    ...summary,
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
  const monitoredCompanies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), max_turnover: getTurnoverMaxThreshold(), limit: topN * 3 });
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

  let geminiWeeklyHandoff;
  try {
    const autorun = await maybeRunGeminiWeeklyHandoffForWeek(weekLabel, {
      request_prefix: "weekly",
    });
    geminiWeeklyHandoff = autorun.summary;
  } catch (err) {
    geminiWeeklyHandoff = {
      ok: false,
      status_code: 500,
      skipped: true,
      reason: "gemini_weekly_autorun_failed",
      message: String(err?.message || "unknown_error"),
    };
  }

  res.status(201).json({
    report_id: report.id,
    week_label: weekLabel,
    company_count: snapshot.length,
    gemini_weekly_handoff: geminiWeeklyHandoff,
  });
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
  if (turnover >= 200_000_000) return "Enterprise";
  if (turnover >= 30_000_000) return "Mid-Market";
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
  const companies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), max_turnover: getTurnoverMaxThreshold(), limit: limit || 100 });
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
    threshold_min: getTurnoverThreshold(),
    threshold_max: getTurnoverMaxThreshold(),
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

app.post("/api/monitor/cleanup-turnover-scope", (req, res) => {
  try {
    const {
      min_turnover,
      max_turnover,
      dry_run,
      include_closed_won,
      sample_limit,
    } = req.body || {};

    const result = purgeOutOfScopeMonitoredCompanies({
      min_turnover,
      max_turnover,
      dry_run,
      include_closed_won,
      sample_limit,
    });

    res.json({
      message: result.dry_run
        ? "Dry run complete. No records were removed."
        : "Cleanup complete. Out-of-scope company data removed.",
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "cleanup_failed" });
  }
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

app.post("/api/monitor/import-seed-list", async (req, res) => {
  const {
    csv_content,
    rows,
    source,
    dry_run,
    search_limit,
    allow_low_confidence,
    sync_now,
    sync_delay_ms,
    queue_analysis,
  } = req.body || {};

  const inputRows = Array.isArray(rows) ? rows : null;
  const csvContent = typeof csv_content === "string" ? csv_content : "";
  const parsedRows = inputRows && inputRows.length > 0
    ? inputRows.map((row, idx) => ({
      row_number: idx + 1,
      company_number: normalizeSeedImportCompanyNumber(row?.company_number || row?.companyNumber || row?.number || ""),
      company_name: normalizeSeedImportText(row?.company_name || row?.companyName || row?.name || ""),
      company_website: normalizeSeedImportWebsite(row?.company_website || row?.companyWebsite || row?.website || row?.website_url || row?.websiteUrl || ""),
      company_domain: extractSeedImportDomain(row?.company_domain || row?.companyDomain || row?.domain || row?.company_website || row?.companyWebsite || row?.website || row?.website_url || ""),
    }))
    : parseMonitorSeedRowsFromCsv(csvContent);

  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    return res.status(400).json({
      error: "Provide either rows[] or csv_content with company_name and/or company_number values.",
    });
  }

  try {
    const sourceTag = String(source || "seed_name_website").trim() || "seed_name_website";
    const isDryRun = dry_run === true;
    const shouldSyncNow = sync_now !== false;
    const shouldQueueAnalysis = queue_analysis !== false;
    const searchLimit = Number.parseInt(String(search_limit || "20"), 10);
    const allowLowConfidence = allow_low_confidence === true;
    const syncDelayMs = Number.parseInt(String(sync_delay_ms || "500"), 10);

    const resolution = await resolveMonitorSeedRows(parsedRows, {
      search_limit: Number.isFinite(searchLimit) ? searchLimit : 20,
      allow_low_confidence: allowLowConfidence,
    });

    const resolvedRows = resolution.resolved;
    const unresolvedRows = resolution.unresolved;

    const upsertRows = resolvedRows.map((row) => ({
      company_number: row.company_number,
      company_name: row.company_name || null,
      company_website: row.company_website || null,
      company_domain: row.company_domain || null,
      status: "active",
      source: sourceTag,
    }));

    const upsertResult = isDryRun
      ? {
        received: upsertRows.length,
        upserted: 0,
        skipped_invalid: 0,
        source: sourceTag,
        dry_run: true,
      }
      : upsertMonitoredCompanies(upsertRows, sourceTag);

    let syncResult = {
      skipped: true,
      reason: shouldSyncNow ? "not_run" : "disabled",
      checked: 0,
      errors: 0,
      rows_with_filings: 0,
      filing_records_written: 0,
      rows_without_filings: 0,
    };

    if (!isDryRun && shouldSyncNow) {
      if (!isCompaniesHouseConfigured()) {
        syncResult = {
          ...syncResult,
          reason: "companies_house_not_configured",
        };
      } else {
        const inactiveStatuses = new Set([
          "dissolved",
          "liquidation",
          "converted-closed",
          "voluntary-arrangement",
          "insolvency-proceedings",
        ]);

        syncResult = {
          skipped: false,
          checked: 0,
          errors: 0,
          inactive: 0,
          rows_with_filings: 0,
          filing_records_written: 0,
          rows_without_filings: 0,
        };

        const safeDelay = Number.isFinite(syncDelayMs) ? Math.max(0, syncDelayMs) : 500;
        for (let i = 0; i < resolvedRows.length; i += 1) {
          const row = resolvedRows[i];
          try {
            const lookup = await lookupCompany(row.company_number);
            if (lookup?.error) {
              syncResult.errors += 1;
              updateMonitorCheck(row.company_number, {
                notes: `Seed sync lookup error: ${lookup.message || "lookup_failed"}`,
              });
            } else {
              const filings = sortRecentFilingsByDateDesc(Array.isArray(lookup?.recent_filings) ? lookup.recent_filings : []);

              for (const filing of filings) {
                upsertFiling({
                  company_number: row.company_number,
                  filing_date: filing.date || null,
                  description: filing.description || null,
                  filing_type: filing.type || null,
                  barcode: filing.barcode || `seed-${row.company_number}-${filing.date || "unknown"}`,
                  source: `${sourceTag}:seed_sync`,
                });
                syncResult.filing_records_written += 1;
              }

              const latestFilingDate = filings[0]?.date || null;
              if (latestFilingDate) syncResult.rows_with_filings += 1;
              else syncResult.rows_without_filings += 1;

              const status = String(lookup?.status || "active").trim().toLowerCase() || "active";
              if (inactiveStatuses.has(status)) syncResult.inactive += 1;

              updateMonitorCheck(row.company_number, {
                company_name: normalizeSeedImportText(lookup?.name) || row.company_name || null,
                status,
                last_filing_date: latestFilingDate,
                no_filings: latestFilingDate ? 0 : 1,
                stale_filing_checked_at: null,
                stale_filing_due_at: null,
                notes: null,
              });
            }
          } catch (err) {
            syncResult.errors += 1;
            updateMonitorCheck(row.company_number, {
              notes: `Seed sync error: ${err?.message || "unknown_error"}`,
            });
          }

          syncResult.checked = i + 1;
          if (safeDelay > 0 && i < resolvedRows.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, safeDelay));
          }
        }
      }
    }

    let queueResult = {
      skipped: true,
      reason: shouldQueueAnalysis ? "not_run" : "disabled",
      queued: 0,
    };

    if (!isDryRun && shouldQueueAnalysis) {
      const queued = enqueueCompaniesForAnalysis(
        resolvedRows.map((row) => ({
          company_number: row.company_number,
          company_name: row.company_name || null,
        })),
        `seed_import:${sourceTag}`
      );

      queueResult = {
        skipped: false,
        queued: Number(queued?.queued || 0),
      };
    }

    res.json({
      source: sourceTag,
      dry_run: isDryRun,
      parsed_rows: parsedRows.length,
      resolved_rows: resolvedRows.length,
      unresolved_rows: unresolvedRows.length,
      unresolved_sample: unresolvedRows.slice(0, 100),
      upsert: upsertResult,
      sync: syncResult,
      analysis_queue: queueResult,
      total_monitored: isDryRun ? getMonitoredCompanyCount() : getMonitoredCompanyCount(),
      companies_house_configured: isCompaniesHouseConfigured(),
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
  const sort = req.query.sort;
  const minChangedFields = req.query.min_changed_fields;
  const parentCountryScope = req.query.parent_country_scope;
  const changedField = req.query.changed_field ?? req.query.changed_fields;
  const impact = req.query.impact;
  const result = listOwnershipChangedCompanies({
    limit,
    offset,
    since_days: sinceDays,
    sort,
    min_changed_fields: minChangedFields,
    parent_country_scope: parentCountryScope,
    changed_field: changedField,
    impact,
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

app.post("/api/dev/gemini/handoff-simulator", (req, res) => {
  if (!GEMINI_HANDOFF_DEV_SIMULATOR_ENABLED) {
    return res.status(403).json({
      error: "simulator_disabled",
      message: "Enable simulator via ENABLE_GEMINI_HANDOFF_DEV_SIMULATOR=true",
    });
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const validation = validateJsonSchema(GEMINI_HANDOFF_REQUEST_SCHEMA, payload);
  if (!validation.valid) {
    return res.status(400).json({
      error: "invalid_payload",
      details: formatSchemaErrors(validation.errors),
    });
  }

  const responsePayload = buildDevGeminiHandoffResponse(payload);
  return res.status(200).json(responsePayload);
});

app.post("/api/dev/gemini/handoff-google-api", async (req, res) => {
  if (!GEMINI_HANDOFF_GOOGLE_API_BRIDGE_ENABLED) {
    return res.status(403).json({
      error: "google_api_bridge_disabled",
      message: "Enable bridge via ENABLE_GEMINI_HANDOFF_GOOGLE_API_BRIDGE=true",
    });
  }

  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error: "gemini_api_key_missing",
      message: "Set GEMINI_API_KEY (or GOOGLE_API_KEY) before using this bridge",
    });
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const validation = validateJsonSchema(GEMINI_HANDOFF_REQUEST_SCHEMA, payload);
  if (!validation.valid) {
    return res.status(400).json({
      error: "invalid_payload",
      details: formatSchemaErrors(validation.errors),
    });
  }

  try {
    const responsePayload = await buildGoogleApiGeminiHandoffResponse(payload);
    const responseValidation = validateJsonSchema(GEMINI_HANDOFF_RESPONSE_SCHEMA, responsePayload);
    if (!responseValidation.valid) {
      return res.status(502).json({
        error: "invalid_google_api_bridge_response",
        details: formatSchemaErrors(responseValidation.errors),
      });
    }

    return res.status(200).json(responsePayload);
  } catch (err) {
    return res.status(502).json({
      error: "google_api_bridge_failed",
      message: String(err?.message || "unknown_error"),
    });
  }
});

app.post("/api/gemini/handoff", async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const result = await processGeminiHandoffRequestPayload(payload);
    return res.status(result.statusCode || 200).json(result.body || {});
  } catch (err) {
    return res.status(500).json({
      error: "handoff_processing_failed",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      message: String(err?.message || "unknown_error"),
    });
  }
});

app.post("/api/gemini/weekly/handoff", async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query || {};

  try {
    const result = await runGeminiWeeklyHandoff({
      week_label: payload.week_label ?? query.week_label,
      week_start: payload.week_start ?? query.week_start,
      week_end: payload.week_end ?? query.week_end,
      focus: payload.focus ?? query.focus,
      limit: payload.limit ?? query.limit,
      max_touches: payload.max_touches ?? query.max_touches,
      request_prefix: payload.request_prefix ?? query.request_prefix,
      request_id: payload.request_id ?? query.request_id,
      dry_run: payload.dry_run ?? query.dry_run,
    });

    return res.status(result.statusCode || 200).json(result.body || {});
  } catch (err) {
    return res.status(500).json({
      error: "weekly_handoff_failed",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      message: String(err?.message || "unknown_error"),
    });
  }
});

app.get("/api/gemini/handoff", (req, res) => {
  const statusFilter = String(req.query?.status || "").trim().toLowerCase() || null;
  const rawHasResponse = String(req.query?.has_response || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasResponse)) {
    return res.status(400).json({
      error: "invalid_has_response",
      message: "has_response must be a boolean flag (true/false)",
    });
  }
  const hasResponse = rawHasResponse
    ? ["1", "true", "yes", "on"].includes(rawHasResponse)
    : null;
  const rawHasRetries = String(req.query?.has_retries || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasRetries)) {
    return res.status(400).json({
      error: "invalid_has_retries",
      message: "has_retries must be a boolean flag (true/false)",
    });
  }
  const hasRetries = rawHasRetries
    ? ["1", "true", "yes", "on"].includes(rawHasRetries)
    : null;
  const rawHasApprovals = String(req.query?.has_approvals || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasApprovals)) {
    return res.status(400).json({
      error: "invalid_has_approvals",
      message: "has_approvals must be a boolean flag (true/false)",
    });
  }
  const hasApprovals = rawHasApprovals
    ? ["1", "true", "yes", "on"].includes(rawHasApprovals)
    : null;
  const rawHasEvents = String(req.query?.has_events || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasEvents)) {
    return res.status(400).json({
      error: "invalid_has_events",
      message: "has_events must be a boolean flag (true/false)",
    });
  }
  const hasEvents = rawHasEvents
    ? ["1", "true", "yes", "on"].includes(rawHasEvents)
    : null;
  const rawHasCompleted = String(req.query?.has_completed || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasCompleted)) {
    return res.status(400).json({
      error: "invalid_has_completed",
      message: "has_completed must be a boolean flag (true/false)",
    });
  }
  const hasCompleted = rawHasCompleted
    ? ["1", "true", "yes", "on"].includes(rawHasCompleted)
    : null;
  const rawHasCompletedAt = String(req.query?.has_completed_at || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasCompletedAt)) {
    return res.status(400).json({
      error: "invalid_has_completed_at",
      message: "has_completed_at must be a boolean flag (true/false)",
    });
  }
  const hasCompletedAt = rawHasCompletedAt
    ? ["1", "true", "yes", "on"].includes(rawHasCompletedAt)
    : null;
  const rawHasLastRetryRequested = String(req.query?.has_last_retry_requested || "").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawHasLastRetryRequested)) {
    return res.status(400).json({
      error: "invalid_has_last_retry_requested",
      message: "has_last_retry_requested must be a boolean flag (true/false)",
    });
  }
  const hasLastRetryRequested = rawHasLastRetryRequested
    ? ["1", "true", "yes", "on"].includes(rawHasLastRetryRequested)
    : null;
  const rawBeforeAcceptedAt = String(req.query?.before_accepted_at || "").trim();
  let beforeAcceptedAt = null;
  if (rawBeforeAcceptedAt) {
    const parsedBeforeAcceptedAt = Date.parse(rawBeforeAcceptedAt);
    if (!Number.isFinite(parsedBeforeAcceptedAt)) {
      return res.status(400).json({
        error: "invalid_before_accepted_at",
        message: "before_accepted_at must be a valid datetime",
      });
    }
    beforeAcceptedAt = new Date(parsedBeforeAcceptedAt).toISOString();
  }
  const rawAfterAcceptedAt = String(req.query?.after_accepted_at || "").trim();
  let afterAcceptedAt = null;
  if (rawAfterAcceptedAt) {
    const parsedAfterAcceptedAt = Date.parse(rawAfterAcceptedAt);
    if (!Number.isFinite(parsedAfterAcceptedAt)) {
      return res.status(400).json({
        error: "invalid_after_accepted_at",
        message: "after_accepted_at must be a valid datetime",
      });
    }
    afterAcceptedAt = new Date(parsedAfterAcceptedAt).toISOString();
  }
  const rawBeforeUpdatedAt = String(req.query?.before_updated_at || "").trim();
  let beforeUpdatedAt = null;
  if (rawBeforeUpdatedAt) {
    const parsedBeforeUpdatedAt = Date.parse(rawBeforeUpdatedAt);
    if (!Number.isFinite(parsedBeforeUpdatedAt)) {
      return res.status(400).json({
        error: "invalid_before_updated_at",
        message: "before_updated_at must be a valid datetime",
      });
    }
    beforeUpdatedAt = new Date(parsedBeforeUpdatedAt).toISOString();
  }
  const rawAfterUpdatedAt = String(req.query?.after_updated_at || "").trim();
  let afterUpdatedAt = null;
  if (rawAfterUpdatedAt) {
    const parsedAfterUpdatedAt = Date.parse(rawAfterUpdatedAt);
    if (!Number.isFinite(parsedAfterUpdatedAt)) {
      return res.status(400).json({
        error: "invalid_after_updated_at",
        message: "after_updated_at must be a valid datetime",
      });
    }
    afterUpdatedAt = new Date(parsedAfterUpdatedAt).toISOString();
  }
  const rawBeforeCompletedAt = String(req.query?.before_completed_at || "").trim();
  let beforeCompletedAt = null;
  if (rawBeforeCompletedAt) {
    const parsedBeforeCompletedAt = Date.parse(rawBeforeCompletedAt);
    if (!Number.isFinite(parsedBeforeCompletedAt)) {
      return res.status(400).json({
        error: "invalid_before_completed_at",
        message: "before_completed_at must be a valid datetime",
      });
    }
    beforeCompletedAt = new Date(parsedBeforeCompletedAt).toISOString();
  }
  const rawAfterCompletedAt = String(req.query?.after_completed_at || "").trim();
  let afterCompletedAt = null;
  if (rawAfterCompletedAt) {
    const parsedAfterCompletedAt = Date.parse(rawAfterCompletedAt);
    if (!Number.isFinite(parsedAfterCompletedAt)) {
      return res.status(400).json({
        error: "invalid_after_completed_at",
        message: "after_completed_at must be a valid datetime",
      });
    }
    afterCompletedAt = new Date(parsedAfterCompletedAt).toISOString();
  }
  const rawAfterLastRetryRequestedAt = String(req.query?.after_last_retry_requested_at || "").trim();
  let afterLastRetryRequestedAt = null;
  if (rawAfterLastRetryRequestedAt) {
    const parsedAfterLastRetryRequestedAt = Date.parse(rawAfterLastRetryRequestedAt);
    if (!Number.isFinite(parsedAfterLastRetryRequestedAt)) {
      return res.status(400).json({
        error: "invalid_after_last_retry_requested_at",
        message: "after_last_retry_requested_at must be a valid datetime",
      });
    }
    afterLastRetryRequestedAt = new Date(parsedAfterLastRetryRequestedAt).toISOString();
  }
  const rawBeforeLastRetryRequestedAt = String(req.query?.before_last_retry_requested_at || "").trim();
  let beforeLastRetryRequestedAt = null;
  if (rawBeforeLastRetryRequestedAt) {
    const parsedBeforeLastRetryRequestedAt = Date.parse(rawBeforeLastRetryRequestedAt);
    if (!Number.isFinite(parsedBeforeLastRetryRequestedAt)) {
      return res.status(400).json({
        error: "invalid_before_last_retry_requested_at",
        message: "before_last_retry_requested_at must be a valid datetime",
      });
    }
    beforeLastRetryRequestedAt = new Date(parsedBeforeLastRetryRequestedAt).toISOString();
  }
  const rawMinRetryCount = String(req.query?.min_retry_count || "").trim();
  let minRetryCount = null;
  if (rawMinRetryCount) {
    const parsedMinRetryCount = Number.parseInt(rawMinRetryCount, 10);
    if (!Number.isInteger(parsedMinRetryCount) || parsedMinRetryCount < 0 || parsedMinRetryCount > 100) {
      return res.status(400).json({
        error: "invalid_min_retry_count",
        message: "min_retry_count must be an integer between 0 and 100",
      });
    }
    minRetryCount = parsedMinRetryCount;
  }
  const rawMaxRetryCount = String(req.query?.max_retry_count || "").trim();
  let maxRetryCount = null;
  if (rawMaxRetryCount) {
    const parsedMaxRetryCount = Number.parseInt(rawMaxRetryCount, 10);
    if (!Number.isInteger(parsedMaxRetryCount) || parsedMaxRetryCount < 0 || parsedMaxRetryCount > 100) {
      return res.status(400).json({
        error: "invalid_max_retry_count",
        message: "max_retry_count must be an integer between 0 and 100",
      });
    }
    maxRetryCount = parsedMaxRetryCount;
  }
  const rawRetryCount = String(req.query?.retry_count || "").trim();
  let retryCount = null;
  if (rawRetryCount) {
    const parsedRetryCount = Number.parseInt(rawRetryCount, 10);
    if (!Number.isInteger(parsedRetryCount) || parsedRetryCount < 0 || parsedRetryCount > 100) {
      return res.status(400).json({
        error: "invalid_retry_count",
        message: "retry_count must be an integer between 0 and 100",
      });
    }
    retryCount = parsedRetryCount;
  }
  const rawMinEventCount = String(req.query?.min_event_count || "").trim();
  let minEventCount = null;
  if (rawMinEventCount) {
    const parsedMinEventCount = Number.parseInt(rawMinEventCount, 10);
    if (!Number.isInteger(parsedMinEventCount) || parsedMinEventCount < 0 || parsedMinEventCount > 10000) {
      return res.status(400).json({
        error: "invalid_min_event_count",
        message: "min_event_count must be an integer between 0 and 10000",
      });
    }
    minEventCount = parsedMinEventCount;
  }
  const rawMaxEventCount = String(req.query?.max_event_count || "").trim();
  let maxEventCount = null;
  if (rawMaxEventCount) {
    const parsedMaxEventCount = Number.parseInt(rawMaxEventCount, 10);
    if (!Number.isInteger(parsedMaxEventCount) || parsedMaxEventCount < 0 || parsedMaxEventCount > 10000) {
      return res.status(400).json({
        error: "invalid_max_event_count",
        message: "max_event_count must be an integer between 0 and 10000",
      });
    }
    maxEventCount = parsedMaxEventCount;
  }
  const rawEventCount = String(req.query?.event_count || "").trim();
  let eventCount = null;
  if (rawEventCount) {
    const parsedEventCount = Number.parseInt(rawEventCount, 10);
    if (!Number.isInteger(parsedEventCount) || parsedEventCount < 0 || parsedEventCount > 10000) {
      return res.status(400).json({
        error: "invalid_event_count",
        message: "event_count must be an integer between 0 and 10000",
      });
    }
    eventCount = parsedEventCount;
  }
  const rawMinApprovalCount = String(req.query?.min_approval_count || "").trim();
  let minApprovalCount = null;
  if (rawMinApprovalCount) {
    const parsedMinApprovalCount = Number.parseInt(rawMinApprovalCount, 10);
    if (!Number.isInteger(parsedMinApprovalCount) || parsedMinApprovalCount < 0 || parsedMinApprovalCount > 10000) {
      return res.status(400).json({
        error: "invalid_min_approval_count",
        message: "min_approval_count must be an integer between 0 and 10000",
      });
    }
    minApprovalCount = parsedMinApprovalCount;
  }
  const rawApprovalCount = String(req.query?.approval_count || "").trim();
  let approvalCount = null;
  if (rawApprovalCount) {
    const parsedApprovalCount = Number.parseInt(rawApprovalCount, 10);
    if (!Number.isInteger(parsedApprovalCount) || parsedApprovalCount < 0 || parsedApprovalCount > 10000) {
      return res.status(400).json({
        error: "invalid_approval_count",
        message: "approval_count must be an integer between 0 and 10000",
      });
    }
    approvalCount = parsedApprovalCount;
  }
  const rawMaxApprovalCount = String(req.query?.max_approval_count || "").trim();
  let maxApprovalCount = null;
  if (rawMaxApprovalCount) {
    const parsedMaxApprovalCount = Number.parseInt(rawMaxApprovalCount, 10);
    if (!Number.isInteger(parsedMaxApprovalCount) || parsedMaxApprovalCount < 0 || parsedMaxApprovalCount > 10000) {
      return res.status(400).json({
        error: "invalid_max_approval_count",
        message: "max_approval_count must be an integer between 0 and 10000",
      });
    }
    maxApprovalCount = parsedMaxApprovalCount;
  }
  const sort = String(req.query?.sort || "accepted_desc").trim().toLowerCase() || "accepted_desc";
  if (!["accepted_desc", "accepted_asc", "queue_health"].includes(sort)) {
    return res.status(400).json({
      error: "invalid_sort",
      message: "sort must be one of accepted_desc, accepted_asc, queue_health",
    });
  }
  const rawIncludeYammSummary = String(req.query?.include_yamm_summary || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeYammSummary)) {
    return res.status(400).json({
      error: "invalid_include_yamm_summary",
      message: "include_yamm_summary must be a boolean flag (true/false)",
    });
  }
  const includeYammSummary = ["1", "true", "yes", "on"].includes(rawIncludeYammSummary);
  const rawIncludeStatusCounts = String(req.query?.include_status_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeStatusCounts)) {
    return res.status(400).json({
      error: "invalid_include_status_counts",
      message: "include_status_counts must be a boolean flag (true/false)",
    });
  }
  const includeStatusCounts = ["1", "true", "yes", "on"].includes(rawIncludeStatusCounts);
  const rawIncludeRetryCounts = String(req.query?.include_retry_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRetryCounts)) {
    return res.status(400).json({
      error: "invalid_include_retry_counts",
      message: "include_retry_counts must be a boolean flag (true/false)",
    });
  }
  const includeRetryCounts = ["1", "true", "yes", "on"].includes(rawIncludeRetryCounts);
  const rawIncludeQueueMetrics = String(req.query?.include_queue_metrics || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeQueueMetrics)) {
    return res.status(400).json({
      error: "invalid_include_queue_metrics",
      message: "include_queue_metrics must be a boolean flag (true/false)",
    });
  }
  const includeQueueMetrics = ["1", "true", "yes", "on"].includes(rawIncludeQueueMetrics);
  const rawLimit = Number.parseInt(String(req.query?.limit || "50"), 10);
  const rawOffset = Number.parseInt(String(req.query?.offset || "0"), 10);
  const limit = Number.isFinite(rawLimit) ? rawLimit : NaN;
  const offset = Number.isFinite(rawOffset) ? rawOffset : NaN;

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({
      error: "invalid_limit",
      message: "limit must be an integer between 1 and 200",
    });
  }

  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
    return res.status(400).json({
      error: "invalid_offset",
      message: "offset must be an integer between 0 and 10000",
    });
  }

  const items = listGeminiHandoffRequests({
    status: statusFilter,
    hasResponse,
    hasRetries,
    hasApprovals,
    hasEvents,
    hasCompleted,
    hasCompletedAt,
    hasLastRetryRequested,
    beforeAcceptedAt,
    afterAcceptedAt,
    beforeUpdatedAt,
    afterUpdatedAt,
    beforeCompletedAt,
    afterCompletedAt,
    afterLastRetryRequestedAt,
    beforeLastRetryRequestedAt,
    minRetryCount,
    maxRetryCount,
    retryCount,
    minEventCount,
    maxEventCount,
    eventCount,
    minApprovalCount,
    approvalCount,
    maxApprovalCount,
    sort,
    limit,
    offset,
  });
  const responseItems = includeYammSummary
    ? items.map((item) => {
      const record = getGeminiHandoffRequest(item.request_id);
      if (!record?.response || typeof record.response !== "object") {
        return {
          ...item,
          yamm_summary: null,
        };
      }
      const approvals = listGeminiHandoffApprovals(item.request_id);
      const rows = extractGeminiYammRows(record.response, approvals, record.request);
      return {
        ...item,
        yamm_summary: summarizeGeminiYammRows(rows),
      };
    })
    : items;
  const total = countGeminiHandoffRequests({
    status: statusFilter,
    hasResponse,
    hasRetries,
    hasApprovals,
    hasEvents,
    hasCompleted,
    hasCompletedAt,
    hasLastRetryRequested,
    beforeAcceptedAt,
    afterAcceptedAt,
    beforeUpdatedAt,
    afterUpdatedAt,
    beforeCompletedAt,
    afterCompletedAt,
    afterLastRetryRequestedAt,
    beforeLastRetryRequestedAt,
    minRetryCount,
    maxRetryCount,
    retryCount,
    minEventCount,
    maxEventCount,
    eventCount,
    minApprovalCount,
    approvalCount,
    maxApprovalCount,
  });
  const shouldIncludeStatusCounts = includeStatusCounts || includeQueueMetrics;
  const shouldIncludeRetryCounts = includeRetryCounts || includeQueueMetrics;
  const statusCounts = shouldIncludeStatusCounts ? getGeminiHandoffStatusCounts() : undefined;
  const retryCounts = shouldIncludeRetryCounts
    ? getGeminiHandoffRetryCounts({ retryLimit: GEMINI_HANDOFF_MAX_RETRY_COUNT })
    : undefined;

  return res.json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    filters: {
      status: statusFilter,
      has_response: hasResponse,
      has_retries: hasRetries,
      has_approvals: hasApprovals,
      has_events: hasEvents,
      has_completed: hasCompleted,
      has_completed_at: hasCompletedAt,
      has_last_retry_requested: hasLastRetryRequested,
      before_accepted_at: beforeAcceptedAt,
      after_accepted_at: afterAcceptedAt,
      before_updated_at: beforeUpdatedAt,
      after_updated_at: afterUpdatedAt,
      before_completed_at: beforeCompletedAt,
      after_completed_at: afterCompletedAt,
      after_last_retry_requested_at: afterLastRetryRequestedAt,
      before_last_retry_requested_at: beforeLastRetryRequestedAt,
      min_retry_count: minRetryCount,
      max_retry_count: maxRetryCount,
      retry_count: retryCount,
      min_event_count: minEventCount,
      max_event_count: maxEventCount,
      event_count: eventCount,
      min_approval_count: minApprovalCount,
      approval_count: approvalCount,
      max_approval_count: maxApprovalCount,
      sort,
      limit,
      offset,
      include_yamm_summary: includeYammSummary,
      include_status_counts: includeStatusCounts,
      include_retry_counts: includeRetryCounts,
      include_queue_metrics: includeQueueMetrics,
    },
    total,
    count: responseItems.length,
    items: responseItems,
    ...(shouldIncludeStatusCounts ? { status_counts: statusCounts } : {}),
    ...(shouldIncludeRetryCounts ? { retry_counts: retryCounts } : {}),
  });
});

app.get("/api/gemini/handoff/summary", (req, res) => {
  const recentHoursRaw = String(req.query?.recent_hours || "24").trim();
  const recentHours = Number.parseInt(recentHoursRaw, 10);
  if (!Number.isInteger(recentHours) || recentHours < 1 || recentHours > 168) {
    return res.status(400).json({
      error: "invalid_recent_hours",
      message: "recent_hours must be an integer between 1 and 168",
    });
  }
  const rawIncludeRecentStatusCounts = String(req.query?.include_recent_status_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentStatusCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_status_counts",
      message: "include_recent_status_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentStatusCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentStatusCounts);
  const rawIncludeRecentRetryCounts = String(req.query?.include_recent_retry_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentRetryCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_retry_counts",
      message: "include_recent_retry_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentRetryCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentRetryCounts);
  const rawIncludeRecentApprovalCounts = String(req.query?.include_recent_approval_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentApprovalCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_approval_counts",
      message: "include_recent_approval_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentApprovalCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentApprovalCounts);
  const rawIncludeRecentEventStageCounts = String(req.query?.include_recent_event_stage_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentEventStageCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_event_stage_counts",
      message: "include_recent_event_stage_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentEventStageCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentEventStageCounts);
  const rawIncludeRecentEventVolumeCounts = String(req.query?.include_recent_event_volume_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentEventVolumeCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_event_volume_counts",
      message: "include_recent_event_volume_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentEventVolumeCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentEventVolumeCounts);
  const rawIncludeRecentEventTypeShare = String(req.query?.include_recent_event_type_share || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentEventTypeShare)) {
    return res.status(400).json({
      error: "invalid_include_recent_event_type_share",
      message: "include_recent_event_type_share must be a boolean flag (true/false)",
    });
  }
  const includeRecentEventTypeShare = ["1", "true", "yes", "on"].includes(rawIncludeRecentEventTypeShare);
  const rawIncludeRecentEventRequestOutliers = String(req.query?.include_recent_event_request_outliers || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentEventRequestOutliers)) {
    return res.status(400).json({
      error: "invalid_include_recent_event_request_outliers",
      message: "include_recent_event_request_outliers must be a boolean flag (true/false)",
    });
  }
  const includeRecentEventRequestOutliers = ["1", "true", "yes", "on"].includes(rawIncludeRecentEventRequestOutliers);
  const rawIncludeRecentCallbackLatencyPercentilesByStatus = String(req.query?.include_recent_callback_latency_percentiles_by_status || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentCallbackLatencyPercentilesByStatus)) {
    return res.status(400).json({
      error: "invalid_include_recent_callback_latency_percentiles_by_status",
      message: "include_recent_callback_latency_percentiles_by_status must be a boolean flag (true/false)",
    });
  }
  const includeRecentCallbackLatencyPercentilesByStatus = ["1", "true", "yes", "on"].includes(rawIncludeRecentCallbackLatencyPercentilesByStatus);
  const rawIncludeRecentCallbackAgingBands = String(req.query?.include_recent_callback_aging_bands || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentCallbackAgingBands)) {
    return res.status(400).json({
      error: "invalid_include_recent_callback_aging_bands",
      message: "include_recent_callback_aging_bands must be a boolean flag (true/false)",
    });
  }
  const includeRecentCallbackAgingBands = ["1", "true", "yes", "on"].includes(rawIncludeRecentCallbackAgingBands);
  const rawIncludeRecentCallbackPayloadQualityCounts = String(req.query?.include_recent_callback_payload_quality_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentCallbackPayloadQualityCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_callback_payload_quality_counts",
      message: "include_recent_callback_payload_quality_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentCallbackPayloadQualityCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentCallbackPayloadQualityCounts);
  const rawIncludeRecentCallbackSchemaPresenceCounts = String(req.query?.include_recent_callback_schema_presence_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentCallbackSchemaPresenceCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_callback_schema_presence_counts",
      message: "include_recent_callback_schema_presence_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentCallbackSchemaPresenceCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentCallbackSchemaPresenceCounts);
  const rawIncludeRecentCallbackPayloadConsistencyCounts = String(req.query?.include_recent_callback_payload_consistency_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentCallbackPayloadConsistencyCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_callback_payload_consistency_counts",
      message: "include_recent_callback_payload_consistency_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentCallbackPayloadConsistencyCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentCallbackPayloadConsistencyCounts);
  const rawIncludeRecentYammRowReadinessCounts = String(req.query?.include_recent_yamm_row_readiness_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentYammRowReadinessCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_yamm_row_readiness_counts",
      message: "include_recent_yamm_row_readiness_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentYammRowReadinessCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentYammRowReadinessCounts);
  const rawIncludeRecentYammRowGapCounts = String(req.query?.include_recent_yamm_row_gap_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentYammRowGapCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_yamm_row_gap_counts",
      message: "include_recent_yamm_row_gap_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentYammRowGapCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentYammRowGapCounts);
  const rawIncludeRecentYammRowStuckCounts = String(req.query?.include_recent_yamm_row_stuck_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentYammRowStuckCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_yamm_row_stuck_counts",
      message: "include_recent_yamm_row_stuck_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentYammRowStuckCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentYammRowStuckCounts);
  const rawIncludeRecentTransportDispatchCounts = String(req.query?.include_recent_transport_dispatch_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentTransportDispatchCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_transport_dispatch_counts",
      message: "include_recent_transport_dispatch_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentTransportDispatchCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentTransportDispatchCounts);
  const rawIncludeRecentTransportErrorCodeCounts = String(req.query?.include_recent_transport_error_code_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentTransportErrorCodeCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_transport_error_code_counts",
      message: "include_recent_transport_error_code_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentTransportErrorCodeCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentTransportErrorCodeCounts);
  const rawIncludeRecentTransportOutcomeCounts = String(req.query?.include_recent_transport_outcome_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeRecentTransportOutcomeCounts)) {
    return res.status(400).json({
      error: "invalid_include_recent_transport_outcome_counts",
      message: "include_recent_transport_outcome_counts must be a boolean flag (true/false)",
    });
  }
  const includeRecentTransportOutcomeCounts = ["1", "true", "yes", "on"].includes(rawIncludeRecentTransportOutcomeCounts);
  const rawIncludeQueueBacklogCounts = String(req.query?.include_queue_backlog_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeQueueBacklogCounts)) {
    return res.status(400).json({
      error: "invalid_include_queue_backlog_counts",
      message: "include_queue_backlog_counts must be a boolean flag (true/false)",
    });
  }
  const includeQueueBacklogCounts = ["1", "true", "yes", "on"].includes(rawIncludeQueueBacklogCounts);
  const rawIncludeQueueThroughputCounts = String(req.query?.include_queue_throughput_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeQueueThroughputCounts)) {
    return res.status(400).json({
      error: "invalid_include_queue_throughput_counts",
      message: "include_queue_throughput_counts must be a boolean flag (true/false)",
    });
  }
  const includeQueueThroughputCounts = ["1", "true", "yes", "on"].includes(rawIncludeQueueThroughputCounts);
  const rawIncludeQueueLatencyCounts = String(req.query?.include_queue_latency_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeQueueLatencyCounts)) {
    return res.status(400).json({
      error: "invalid_include_queue_latency_counts",
      message: "include_queue_latency_counts must be a boolean flag (true/false)",
    });
  }
  const includeQueueLatencyCounts = ["1", "true", "yes", "on"].includes(rawIncludeQueueLatencyCounts);
  const rawIncludeApprovalSyncHealthCounts = String(req.query?.include_approval_sync_health_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeApprovalSyncHealthCounts)) {
    return res.status(400).json({
      error: "invalid_include_approval_sync_health_counts",
      message: "include_approval_sync_health_counts must be a boolean flag (true/false)",
    });
  }
  const includeApprovalSyncHealthCounts = ["1", "true", "yes", "on"].includes(rawIncludeApprovalSyncHealthCounts);
  const rawIncludeApprovalSyncConflictCounts = String(req.query?.include_approval_sync_conflict_counts || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeApprovalSyncConflictCounts)) {
    return res.status(400).json({
      error: "invalid_include_approval_sync_conflict_counts",
      message: "include_approval_sync_conflict_counts must be a boolean flag (true/false)",
    });
  }
  const includeApprovalSyncConflictCounts = ["1", "true", "yes", "on"].includes(rawIncludeApprovalSyncConflictCounts);
  const rawIncludeApprovalRevisionDistribution = String(req.query?.include_approval_revision_distribution || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawIncludeApprovalRevisionDistribution)) {
    return res.status(400).json({
      error: "invalid_include_approval_revision_distribution",
      message: "include_approval_revision_distribution must be a boolean flag (true/false)",
    });
  }
  const includeApprovalRevisionDistribution = ["1", "true", "yes", "on"].includes(rawIncludeApprovalRevisionDistribution);

  const summary = getGeminiHandoffOperationalSummary({
    recentHours,
    retryLimit: GEMINI_HANDOFF_MAX_RETRY_COUNT,
    includeRecentStatusCounts,
    includeRecentRetryCounts,
    includeRecentApprovalCounts,
    includeRecentEventStageCounts,
    includeRecentEventVolumeCounts,
    includeRecentEventTypeShare,
    includeRecentEventRequestOutliers,
    includeRecentCallbackLatencyPercentilesByStatus,
    includeRecentCallbackAgingBands,
    includeRecentCallbackPayloadQualityCounts,
    includeRecentCallbackSchemaPresenceCounts,
    includeRecentCallbackPayloadConsistencyCounts,
    includeRecentYammRowReadinessCounts,
    includeRecentYammRowGapCounts,
    includeRecentYammRowStuckCounts,
    includeRecentTransportDispatchCounts,
    includeRecentTransportErrorCodeCounts,
    includeRecentTransportOutcomeCounts,
    includeQueueBacklogCounts,
    includeQueueThroughputCounts,
    includeQueueLatencyCounts,
    includeApprovalSyncHealthCounts,
    includeApprovalSyncConflictCounts,
    includeApprovalRevisionDistribution,
  });

  return res.json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    ...summary,
  });
});

app.get("/api/gemini/handoff/:requestId", (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  const approvalCounts = getGeminiHandoffApprovalCounts(requestId);

  return res.json({
    contract_version: record.contract_version,
    request_id: record.request_id,
    status: record.status,
    accepted_at: record.accepted_at,
    approvals_revision: Number(record.approvals_revision || 0),
    retry_count: record.retry_count,
    request_payload_sha256: record.request_payload_sha256 || null,
    response_id: record.response_id || record.response?.response_id || null,
    response_payload_sha256: record.response_payload_sha256 || null,
    completed_at: record.completed_at || record.response?.completed_at || null,
    approval_counts: approvalCounts,
  });
});

app.get("/api/gemini/handoff/:requestId/yamm-rows", (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  const rawFormat = String(req.query?.format || "json").trim().toLowerCase();
  if (!["json", "csv"].includes(rawFormat)) {
    return res.status(400).json({
      error: "invalid_format",
      message: "format must be one of json or csv",
    });
  }

  const rawApprovalStatus = String(req.query?.approval_status || "").trim().toLowerCase();
  if (rawApprovalStatus && !GEMINI_APPROVAL_STATUSES.has(rawApprovalStatus)) {
    return res.status(400).json({
      error: "invalid_approval_status",
      message: "approval_status must be one of pending, approved, rejected, sent, paused",
    });
  }

  const rawSendEligible = String(req.query?.send_eligible || "false").trim().toLowerCase();
  if (!["", "0", "1", "false", "true", "no", "yes", "off", "on"].includes(rawSendEligible)) {
    return res.status(400).json({
      error: "invalid_send_eligible",
      message: "send_eligible must be a boolean flag (true/false)",
    });
  }
  const sendEligible = ["1", "true", "yes", "on"].includes(rawSendEligible);

  if (!record.response || typeof record.response !== "object") {
    return res.status(409).json({
      error: "handoff_not_completed",
      request_id: requestId,
      status: record.status,
    });
  }

  const approvals = listGeminiHandoffApprovals(requestId);
  const allRows = extractGeminiYammRows(record.response, approvals, record.request);
  const approvalFilteredRows = rawApprovalStatus
    ? allRows.filter((row) => String(row?.ApprovalStatus || "").trim().toLowerCase() === rawApprovalStatus)
    : allRows;
  const rows = sendEligible
    ? approvalFilteredRows.filter((row) => isGeminiYammRowSendEligible(row))
    : approvalFilteredRows;

  if (rawFormat === "csv") {
    const csv = buildGeminiYammRowsCsv(rows);
    const approvalLabel = rawApprovalStatus || "all";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="gemini-handoff-${requestId}-${approvalLabel}.csv"`);
    return res.send(csv);
  }

  return res.json({
    contract_version: record.contract_version,
    request_id: requestId,
    response_id: record.response_id || record.response?.response_id || null,
    count: rows.length,
    filters: {
      approval_status: rawApprovalStatus || null,
      send_eligible: sendEligible,
    },
    rows,
  });
});

app.get("/api/gemini/handoff/:requestId/yamm-rows/summary", (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  if (!record.response || typeof record.response !== "object") {
    return res.status(409).json({
      error: "handoff_not_completed",
      request_id: requestId,
      status: record.status,
    });
  }

  const approvals = listGeminiHandoffApprovals(requestId);
  const rows = extractGeminiYammRows(record.response, approvals, record.request);
  const summary = summarizeGeminiYammRows(rows);

  return res.json({
    contract_version: record.contract_version,
    request_id: requestId,
    response_id: record.response_id || record.response?.response_id || null,
    ...summary,
  });
});

app.get("/api/gemini/handoff/:requestId/events", (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  const rawLimit = Number.parseInt(String(req.query?.limit || "100"), 10);
  const rawBeforeId = String(req.query?.before_id || "").trim();
  const rawEventType = String(req.query?.event_type || "").trim();
  const rawEventStage = String(req.query?.event_stage || "").trim();

  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
    return res.status(400).json({
      error: "invalid_limit",
      message: "limit must be an integer between 1 and 500",
    });
  }

  let beforeId = null;
  if (rawBeforeId) {
    const parsedBeforeId = Number.parseInt(rawBeforeId, 10);
    if (!Number.isInteger(parsedBeforeId) || parsedBeforeId <= 0) {
      return res.status(400).json({
        error: "invalid_before_id",
        message: "before_id must be a positive integer",
      });
    }
    beforeId = parsedBeforeId;
  }

  const events = listGeminiHandoffEvents(requestId, {
    limit: rawLimit,
    beforeId,
    eventType: rawEventType || null,
    eventStage: rawEventStage || null,
  });
  const nextBeforeId = events.length > 0 ? events[events.length - 1].id : null;

  return res.json({
    contract_version: record.contract_version,
    request_id: requestId,
    filters: {
      limit: rawLimit,
      before_id: beforeId,
      event_type: rawEventType || null,
      event_stage: rawEventStage || null,
    },
    count: events.length,
    next_before_id: nextBeforeId,
    events,
  });
});

app.post("/api/gemini/handoff/:requestId/complete", (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const validation = validateJsonSchema(GEMINI_HANDOFF_RESPONSE_SCHEMA, payload);
  if (!validation.valid) {
    return res.status(400).json({
      error: "invalid_payload",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      details: formatSchemaErrors(validation.errors),
    });
  }

  if (payload.request_id !== requestId) {
    return res.status(400).json({
      error: "request_id_mismatch",
      expected_request_id: requestId,
      actual_request_id: payload.request_id,
    });
  }

  if (isDuplicateGeminiResponse(record, payload)) {
    if (hasGeminiDuplicatePayloadMismatch(record, payload)) {
      const existingHash = getGeminiReplayComparisonHash(record?.response || {});
      const incomingHash = getGeminiReplayComparisonHash(payload || {});
      addGeminiHandoffEvent(requestId, "completion_payload_mismatch", "callback", {
        response_id: getStoredGeminiResponseId(record),
        existing_response_payload_sha256: existingHash,
        incoming_response_payload_sha256: incomingHash,
      });
      return res.status(409).json({
        error: "response_payload_mismatch",
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: requestId,
        response_id: getStoredGeminiResponseId(record),
        existing_response_payload_sha256: existingHash,
        incoming_response_payload_sha256: incomingHash,
      });
    }

    addGeminiHandoffEvent(requestId, "completion_duplicate", "callback", {
      response_id: getStoredGeminiResponseId(record),
    });
    const sequenceImportSummary = record.response && typeof record.response === "object"
      ? persistGeminiResponseSequences(record)
      : null;
    if (sequenceImportSummary) {
      addGeminiHandoffEvent(requestId, "local_sequences_synced", "callback", {
        imported_sequences: Number(sequenceImportSummary.imported || 0),
        skipped_sequences: Number(sequenceImportSummary.skipped || 0),
        duplicate_response: true,
      });
    }
    return res.status(200).json({
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      status: record.status,
      response_id: getStoredGeminiResponseId(record),
      response_payload_sha256: record.response_payload_sha256 || null,
      completed_at: record.completed_at || record.response?.completed_at || null,
      sequence_import: sequenceImportSummary,
      duplicate: true,
    });
  }

  if (hasGeminiResponseConflict(record, payload)) {
    addGeminiHandoffEvent(requestId, "completion_conflict", "callback", {
      existing_response_id: getStoredGeminiResponseId(record),
      incoming_response_id: String(payload.response_id || "").trim() || null,
    });
    return res.status(409).json({
      error: "response_id_conflict",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      existing_response_id: getStoredGeminiResponseId(record),
      incoming_response_id: String(payload.response_id || "").trim() || null,
    });
  }

  const updated = completeGeminiHandoffRequest(requestId, payload);
  addGeminiHandoffEvent(requestId, "completion_applied", "callback", {
    response_id: payload.response_id || null,
    status: updated?.status || "partial",
  });
  const sequenceImportSummary = persistGeminiResponseSequences(updated);
  addGeminiHandoffEvent(requestId, "local_sequences_synced", "callback", {
    imported_sequences: Number(sequenceImportSummary.imported || 0),
    skipped_sequences: Number(sequenceImportSummary.skipped || 0),
    duplicate_response: false,
  });

  return res.json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: requestId,
    status: updated?.status || "partial",
    response_id: payload.response_id,
    response_payload_sha256: updated?.response_payload_sha256 || null,
    completed_at: payload.completed_at,
    sequence_import: sequenceImportSummary,
    duplicate: false,
  });
});

app.post("/api/gemini/handoff/:requestId/retry", async (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  const currentStatus = String(record?.status || "").trim().toLowerCase();
  if (!GEMINI_HANDOFF_RETRYABLE_STATUSES.has(currentStatus)) {
    addGeminiHandoffEvent(requestId, "retry_invalid_transition", "manual", {
      from_status: currentStatus || null,
      to_status: "retry_requested",
    });
    return res.status(409).json({
      error: "invalid_state_transition",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      from_status: currentStatus || null,
      to_status: "retry_requested",
      allowed_from_statuses: Array.from(GEMINI_HANDOFF_RETRYABLE_STATUSES),
    });
  }

  if (Number(record?.retry_count || 0) >= GEMINI_HANDOFF_MAX_RETRY_COUNT) {
    addGeminiHandoffEvent(requestId, "retry_limit_reached", "manual", {
      retry_count: Number(record?.retry_count || 0),
      max_retry_count: GEMINI_HANDOFF_MAX_RETRY_COUNT,
    });
    return res.status(409).json({
      error: "retry_limit_reached",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      status: record?.status || null,
      current_retry_count: Number(record?.retry_count || 0),
      max_retry_count: GEMINI_HANDOFF_MAX_RETRY_COUNT,
    });
  }

  const updated = incrementGeminiHandoffRetry(requestId);
  addGeminiHandoffEvent(requestId, "retry_requested", "manual", {
    retry_count: updated?.retry_count || 1,
  });
  const transportRuntime = getGeminiHandoffTransportRuntimeInfo();
  const requestPayload = record?.request && typeof record.request === "object" ? record.request : null;

  if (requestPayload && String(requestPayload.request_id || "").trim() === requestId) {
    const dispatchResult = await dispatchGeminiHandoffRequest(requestPayload);

    if (dispatchResult?.success && dispatchResult.response_payload && typeof dispatchResult.response_payload === "object") {
      const responseValidation = validateJsonSchema(
        GEMINI_HANDOFF_RESPONSE_SCHEMA,
        dispatchResult.response_payload
      );
      const responseRequestId = String(dispatchResult.response_payload.request_id || "").trim();

      if (responseValidation.valid && responseRequestId === requestId) {
        if (hasGeminiDuplicatePayloadMismatch(updated, dispatchResult.response_payload)) {
          const existingHash = getGeminiReplayComparisonHash(updated?.response || {});
          const incomingHash = getGeminiReplayComparisonHash(dispatchResult.response_payload || {});
          addGeminiHandoffEvent(requestId, "retry_duplicate_payload_mismatch", "transport", {
            response_id: getStoredGeminiResponseId(updated),
            existing_response_payload_sha256: existingHash,
            incoming_response_payload_sha256: incomingHash,
          });
          return res.status(409).json({
            error: "response_payload_mismatch",
            contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
            request_id: requestId,
            status: updated?.status || "retry_requested",
            retry_count: updated?.retry_count || 1,
            response_id: getStoredGeminiResponseId(updated),
            existing_response_payload_sha256: existingHash,
            incoming_response_payload_sha256: incomingHash,
            transport: {
              attempted: true,
              success: true,
              status_code: dispatchResult.status_code,
            },
          });
        }

        if (isDuplicateGeminiResponse(updated, dispatchResult.response_payload)) {
          const restored = completeGeminiHandoffRequest(
            requestId,
            (record?.response && typeof record.response === "object")
              ? record.response
              : dispatchResult.response_payload
          );
          const sequenceImportSummary = persistGeminiResponseSequences(restored);

          addGeminiHandoffEvent(requestId, "retry_duplicate_response", "transport", {
            response_id: getStoredGeminiResponseId(restored),
            retry_count: restored?.retry_count || updated?.retry_count || 1,
            imported_sequences: Number(sequenceImportSummary.imported || 0),
            skipped_sequences: Number(sequenceImportSummary.skipped || 0),
          });
          return res.status(202).json({
            contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
            request_id: requestId,
            status: restored?.status || "completed",
            retry_count: restored?.retry_count || updated?.retry_count || 1,
            response_id: getStoredGeminiResponseId(restored),
            completed_at: restored?.completed_at || restored?.response?.completed_at || null,
            transport: {
              attempted: true,
              success: true,
              status_code: dispatchResult.status_code,
            },
            sequence_import: sequenceImportSummary,
            next_action: "request_completed",
            duplicate: true,
          });
        }

        if (hasGeminiResponseConflict(updated, dispatchResult.response_payload)) {
          addGeminiHandoffEvent(requestId, "retry_response_conflict", "transport", {
            existing_response_id: getStoredGeminiResponseId(updated),
            incoming_response_id: String(dispatchResult.response_payload.response_id || "").trim() || null,
          });
          return res.status(409).json({
            error: "response_id_conflict",
            contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
            request_id: requestId,
            status: updated?.status || "retry_requested",
            retry_count: updated?.retry_count || 1,
            existing_response_id: getStoredGeminiResponseId(updated),
            incoming_response_id: String(dispatchResult.response_payload.response_id || "").trim() || null,
            transport: {
              attempted: true,
              success: true,
              status_code: dispatchResult.status_code,
            },
          });
        }

        const completed = completeGeminiHandoffRequest(requestId, dispatchResult.response_payload);
        const sequenceImportSummary = persistGeminiResponseSequences(completed);
        addGeminiHandoffEvent(requestId, "retry_completed", "transport", {
          response_id: dispatchResult.response_payload.response_id || null,
          retry_count: completed?.retry_count || updated?.retry_count || 1,
          imported_sequences: Number(sequenceImportSummary.imported || 0),
          skipped_sequences: Number(sequenceImportSummary.skipped || 0),
        });
        return res.status(202).json({
          contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
          request_id: requestId,
          status: completed?.status || "partial",
          retry_count: completed?.retry_count || updated?.retry_count || 1,
          response_id: dispatchResult.response_payload.response_id || null,
          completed_at: dispatchResult.response_payload.completed_at || null,
          transport: {
            attempted: true,
            success: true,
            status_code: dispatchResult.status_code,
          },
          sequence_import: sequenceImportSummary,
          next_action: "request_completed",
          duplicate: false,
        });
      }
    }

    if (dispatchResult?.attempted && !dispatchResult.success) {
      addGeminiHandoffEvent(requestId, "retry_dispatch_failed", "transport", {
        reason: dispatchResult.error_code || "transport_error",
        retry_count: updated?.retry_count || 1,
      });
      if (!transportRuntime.fail_open) {
        return res.status(502).json({
          error: "transport_dispatch_failed",
          contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
          request_id: requestId,
          status: updated?.status || "retry_requested",
          retry_count: updated?.retry_count || 1,
          transport: {
            attempted: true,
            success: false,
            status_code: dispatchResult.status_code || null,
            code: dispatchResult.error_code || "transport_error",
            message: dispatchResult.error_message || "Gemini transport request failed",
          },
        });
      }

      return res.status(202).json({
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: requestId,
        status: updated?.status || "retry_requested",
        retry_count: updated?.retry_count || 1,
        requested_at: updated?.last_retry_requested_at || new Date().toISOString(),
        transport: {
          attempted: true,
          success: false,
          status_code: dispatchResult.status_code || null,
          code: dispatchResult.error_code || "transport_error",
        },
        next_action: "retry_requested",
      });
    }
  }

  return res.status(202).json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: requestId,
    status: updated?.status || "retry_requested",
    retry_count: updated?.retry_count || 1,
    requested_at: updated?.last_retry_requested_at || new Date().toISOString(),
    transport: {
      attempted: false,
      success: false,
      skipped: true,
      reason: "request_payload_unavailable_or_transport_disabled",
    },
  });
});

app.post("/api/gemini/handoff/:requestId/retry-429", async (req, res) => {
  const requestId = String(req.params?.requestId || "").trim();
  const record = getGeminiHandoffRequest(requestId);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: requestId });
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const currentStatus = String(record?.status || "").trim().toLowerCase();
  if (!GEMINI_HANDOFF_RETRYABLE_STATUSES.has(currentStatus)) {
    addGeminiHandoffEvent(requestId, "retry_429_invalid_transition", "manual", {
      from_status: currentStatus || null,
      to_status: "retry_429_requested",
    });
    return res.status(409).json({
      error: "invalid_state_transition",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      from_status: currentStatus || null,
      to_status: "retry_429_requested",
      allowed_from_statuses: Array.from(GEMINI_HANDOFF_RETRYABLE_STATUSES),
    });
  }

  if (Number(record?.retry_count || 0) >= GEMINI_HANDOFF_MAX_RETRY_COUNT) {
    addGeminiHandoffEvent(requestId, "retry_429_limit_reached", "manual", {
      retry_count: Number(record?.retry_count || 0),
      max_retry_count: GEMINI_HANDOFF_MAX_RETRY_COUNT,
    });
    return res.status(409).json({
      error: "retry_limit_reached",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      status: record?.status || null,
      current_retry_count: Number(record?.retry_count || 0),
      max_retry_count: GEMINI_HANDOFF_MAX_RETRY_COUNT,
    });
  }

  const responsePayload = record?.response && typeof record.response === "object"
    ? record.response
    : null;
  if (!responsePayload) {
    addGeminiHandoffEvent(requestId, "retry_429_response_missing", "manual", {
      status: record?.status || null,
    });
    return res.status(409).json({
      error: "response_payload_unavailable",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      status: record?.status || null,
    });
  }

  const force = parseBooleanInput(payload.force, false);
  const rawMaxScopes = payload.max_scopes;
  const hasMaxScopesOverride = !(rawMaxScopes === undefined || rawMaxScopes === null || String(rawMaxScopes).trim() === "");
  let requestedMaxScopes = GEMINI_HANDOFF_RETRY_429_MAX_SCOPES;
  if (hasMaxScopesOverride) {
    const parsedMaxScopes = Number.parseInt(String(rawMaxScopes), 10);
    if (!Number.isInteger(parsedMaxScopes) || parsedMaxScopes < 1) {
      return res.status(400).json({
        error: "invalid_max_scopes",
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        message: "max_scopes must be a positive integer",
      });
    }
    requestedMaxScopes = parsedMaxScopes;
  }
  const maxScopes = Math.max(1, Math.min(requestedMaxScopes, GEMINI_HANDOFF_RETRY_429_MAX_SCOPES));

  if (!force && GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS > 0) {
    const lastRetryRequestedAt = Date.parse(String(record?.last_retry_requested_at || "").trim());
    if (Number.isFinite(lastRetryRequestedAt) && lastRetryRequestedAt > 0) {
      const elapsedMs = Math.max(0, Date.now() - lastRetryRequestedAt);
      const retryAfterMs = GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS - elapsedMs;
      if (retryAfterMs > 0) {
        addGeminiHandoffEvent(requestId, "retry_429_cooldown_active", "manual", {
          retry_after_ms: retryAfterMs,
          cooldown_ms: GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS,
        });
        return res.status(409).json({
          error: "retry_cooldown_active",
          contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
          request_id: requestId,
          status: record?.status || null,
          retry_after_ms: retryAfterMs,
          cooldown_ms: GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS,
        });
      }
    }
  }

  const retryScopes = extractGeminiRetry429ScopesFromResponse(responsePayload, maxScopes);
  if (retryScopes.length < 1) {
    addGeminiHandoffEvent(requestId, "retry_429_no_retryable_scopes", "manual", {
      max_scopes: maxScopes,
    });
    return res.status(409).json({
      error: "no_retryable_429_errors",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      max_scopes: maxScopes,
      retryable_429_count: countGeminiRetryable429Errors(responsePayload),
    });
  }

  const requestPayload = record?.request && typeof record.request === "object" ? record.request : null;
  if (!requestPayload || String(requestPayload.request_id || "").trim() !== requestId) {
    addGeminiHandoffEvent(requestId, "retry_429_request_payload_missing", "manual", {
      has_request_payload: !!requestPayload,
    });
    return res.status(409).json({
      error: "request_payload_unavailable",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      targeted_scope_count: retryScopes.length,
    });
  }

  const retryRequestPayload = buildGeminiRetry429RequestPayload(requestPayload, retryScopes);
  if (!retryRequestPayload) {
    addGeminiHandoffEvent(requestId, "retry_429_scope_resolution_failed", "manual", {
      targeted_scope_count: retryScopes.length,
      max_scopes: maxScopes,
    });
    return res.status(409).json({
      error: "retry_scope_resolution_failed",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      targeted_scope_count: retryScopes.length,
      max_scopes: maxScopes,
    });
  }

  const updated = incrementGeminiHandoffRetry(requestId);
  addGeminiHandoffEvent(requestId, "retry_429_requested", "manual", {
    retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
    targeted_scope_count: retryScopes.length,
    max_scopes: maxScopes,
    forced: force,
  });

  const transportRuntime = getGeminiHandoffTransportRuntimeInfo();
  const dispatchResult = await dispatchGeminiHandoffRequest(retryRequestPayload);

  if (dispatchResult?.success && dispatchResult.response_payload && typeof dispatchResult.response_payload === "object") {
    const responseValidation = validateJsonSchema(
      GEMINI_HANDOFF_RESPONSE_SCHEMA,
      dispatchResult.response_payload
    );
    const responseRequestId = String(dispatchResult.response_payload.request_id || "").trim();

    if (responseValidation.valid && responseRequestId === requestId) {
      const mergedPayload = mergeGeminiRetry429ResponsePayload({
        requestId,
        baseResponsePayload: responsePayload,
        retryResponsePayload: dispatchResult.response_payload,
        retryScopes,
      });
      const mergedValidation = validateJsonSchema(
        GEMINI_HANDOFF_RESPONSE_SCHEMA,
        mergedPayload
      );

      if (!mergedValidation.valid) {
        addGeminiHandoffEvent(requestId, "retry_429_merge_invalid", "transport", {
          retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
          status_code: dispatchResult.status_code || null,
          details: formatSchemaErrors(mergedValidation.errors),
        });

        if (!transportRuntime.fail_open) {
          return res.status(502).json({
            error: "retry_429_merge_invalid",
            contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
            request_id: requestId,
            status: updated?.status || "retry_requested",
            retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
            transport: {
              attempted: true,
              success: true,
              status_code: dispatchResult.status_code,
            },
            details: formatSchemaErrors(mergedValidation.errors),
          });
        }

        return res.status(202).json({
          contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
          request_id: requestId,
          status: updated?.status || "retry_requested",
          retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
          requested_at: updated?.last_retry_requested_at || new Date().toISOString(),
          targeted_scope_count: retryScopes.length,
          transport: {
            attempted: true,
            success: true,
            status_code: dispatchResult.status_code,
            invalid_response: true,
          },
          next_action: "retry_requested",
        });
      }

      const completed = completeGeminiHandoffRequest(requestId, mergedPayload);
      const sequenceImportSummary = persistGeminiResponseSequences(completed);

      const targetedScopeKeys = new Set(
        retryScopes
          .map((scope) => getGeminiRetryScopeKey(scope.company_number, scope.person_id))
          .filter(Boolean)
      );
      const remainingRetryableScopeKeys = getGeminiRetryable429ScopeKeySet(
        completed?.response || mergedPayload,
        targetedScopeKeys
      );
      const unresolvedScopes = retryScopes.filter((scope) => {
        const scopeKey = getGeminiRetryScopeKey(scope.company_number, scope.person_id);
        return remainingRetryableScopeKeys.has(scopeKey);
      });
      const unresolvedScopeCount = unresolvedScopes.length;
      const resolvedScopeCount = Math.max(0, retryScopes.length - unresolvedScopeCount);
      const remainingRetryable429Count = countGeminiRetryable429Errors(completed?.response || mergedPayload);

      addGeminiHandoffEvent(requestId, "retry_429_completed", "transport", {
        retry_count: completed?.retry_count || updated?.retry_count || Number(record?.retry_count || 0) + 1,
        targeted_scope_count: retryScopes.length,
        resolved_scope_count: resolvedScopeCount,
        unresolved_scope_count: unresolvedScopeCount,
        remaining_retryable_429_count: remainingRetryable429Count,
        imported_sequences: Number(sequenceImportSummary.imported || 0),
        skipped_sequences: Number(sequenceImportSummary.skipped || 0),
      });

      return res.status(202).json({
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: requestId,
        status: completed?.status || "partial",
        retry_count: completed?.retry_count || updated?.retry_count || Number(record?.retry_count || 0) + 1,
        response_id: getStoredGeminiResponseId(completed),
        completed_at: completed?.completed_at || completed?.response?.completed_at || null,
        transport: {
          attempted: true,
          success: true,
          status_code: dispatchResult.status_code,
        },
        sequence_import: sequenceImportSummary,
        retry_429: {
          max_scopes: maxScopes,
          targeted_scope_count: retryScopes.length,
          resolved_scope_count: resolvedScopeCount,
          unresolved_scope_count: unresolvedScopeCount,
          unresolved_scopes: unresolvedScopes,
          remaining_retryable_429_count: remainingRetryable429Count,
          cooldown_ms: GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS,
        },
        next_action: unresolvedScopeCount > 0 ? "retry_429_partial" : "request_completed",
      });
    }

    addGeminiHandoffEvent(requestId, "retry_429_invalid_response", "transport", {
      retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
      status_code: dispatchResult.status_code || null,
      request_id_match: responseRequestId === requestId,
      validation_errors: responseValidation.valid ? [] : formatSchemaErrors(responseValidation.errors),
    });

    if (!transportRuntime.fail_open) {
      return res.status(502).json({
        error: "transport_invalid_response",
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: requestId,
        status: updated?.status || "retry_requested",
        retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
        transport: {
          attempted: true,
          success: true,
          status_code: dispatchResult.status_code,
        },
        details: responseValidation.valid
          ? ["request_id mismatch in transport response"]
          : formatSchemaErrors(responseValidation.errors),
      });
    }

    return res.status(202).json({
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      status: updated?.status || "retry_requested",
      retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
      requested_at: updated?.last_retry_requested_at || new Date().toISOString(),
      targeted_scope_count: retryScopes.length,
      transport: {
        attempted: true,
        success: true,
        status_code: dispatchResult.status_code,
        invalid_response: true,
      },
      next_action: "retry_requested",
    });
  }

  if (dispatchResult?.attempted && !dispatchResult.success) {
    addGeminiHandoffEvent(requestId, "retry_429_dispatch_failed", "transport", {
      reason: dispatchResult.error_code || "transport_error",
      retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
      targeted_scope_count: retryScopes.length,
    });
    if (!transportRuntime.fail_open) {
      return res.status(502).json({
        error: "transport_dispatch_failed",
        contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
        request_id: requestId,
        status: updated?.status || "retry_requested",
        retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
        targeted_scope_count: retryScopes.length,
        transport: {
          attempted: true,
          success: false,
          status_code: dispatchResult.status_code || null,
          code: dispatchResult.error_code || "transport_error",
          message: dispatchResult.error_message || "Gemini transport request failed",
        },
      });
    }

    return res.status(202).json({
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: requestId,
      status: updated?.status || "retry_requested",
      retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
      requested_at: updated?.last_retry_requested_at || new Date().toISOString(),
      targeted_scope_count: retryScopes.length,
      transport: {
        attempted: true,
        success: false,
        status_code: dispatchResult.status_code || null,
        code: dispatchResult.error_code || "transport_error",
      },
      next_action: "retry_requested",
    });
  }

  return res.status(202).json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: requestId,
    status: updated?.status || "retry_requested",
    retry_count: updated?.retry_count || Number(record?.retry_count || 0) + 1,
    requested_at: updated?.last_retry_requested_at || new Date().toISOString(),
    targeted_scope_count: retryScopes.length,
    transport: {
      attempted: false,
      success: false,
      skipped: true,
      reason: "transport_disabled_or_unavailable",
    },
    next_action: "retry_requested",
  });
});

app.post("/api/gemini/sheets/sync-approvals", (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const validation = validateJsonSchema(GEMINI_APPROVALS_SYNC_SCHEMA, payload);
  if (!validation.valid) {
    return res.status(400).json({
      error: "invalid_payload",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      details: formatSchemaErrors(validation.errors),
    });
  }

  const record = getGeminiHandoffRequest(payload.request_id);
  if (!record) {
    return res.status(404).json({ error: "not_found", request_id: payload.request_id });
  }

  const expectedRevisionRaw = String(req.query?.expected_revision || "").trim();
  let expectedRevision = null;
  if (expectedRevisionRaw) {
    const parsedExpectedRevision = Number.parseInt(expectedRevisionRaw, 10);
    if (!Number.isInteger(parsedExpectedRevision) || parsedExpectedRevision < 0) {
      return res.status(400).json({
        error: "invalid_expected_revision",
        message: "expected_revision must be a non-negative integer",
      });
    }
    expectedRevision = parsedExpectedRevision;
  }

  const replaced = replaceGeminiHandoffApprovals(
    payload.request_id,
    payload.approvals,
    { expectedRevision }
  );

  if (replaced?.conflict) {
    addGeminiHandoffEvent(payload.request_id, "approvals_sync_conflict", "callback", {
      expected_revision: expectedRevision,
      current_revision: Number(replaced.current_revision || 0),
    });
    return res.status(409).json({
      error: "approval_sync_conflict",
      contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
      request_id: payload.request_id,
      expected_revision: expectedRevision,
      current_revision: Number(replaced.current_revision || 0),
    });
  }

  addGeminiHandoffEvent(payload.request_id, "approvals_synced", "callback", {
    approval_count: Number(replaced?.upserted || 0),
    approvals_revision: Number(replaced?.approvals_revision || Number(record?.approvals_revision || 0)),
  });

  const counts = getGeminiHandoffApprovalCounts(payload.request_id);
  return res.json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    request_id: payload.request_id,
    synced_at: new Date().toISOString(),
    approvals_revision: Number(replaced?.approvals_revision || Number(record?.approvals_revision || 0)),
    counts,
  });
});

app.post("/api/gemini/gem-instructions/reload", (_req, res) => {
  const runtime = reloadGemInstructionsConfig();
  return res.json({
    contract_version: GEMINI_HANDOFF_CONTRACT_VERSION,
    reloaded_at: new Date().toISOString(),
    runtime,
  });
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
  const geminiHandoffTransportRuntime = getGeminiHandoffTransportRuntimeInfo();

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
    prospeo: {
      configured: hasTemplate(process.env.PROSPEO_URL_TEMPLATE),
      required: false,
      env_var: "PROSPEO_URL_TEMPLATE (+ optional PROSPEO_API_KEY)",
      purpose: "Contact and company intelligence enrichment",
    },
    phantombuster: {
      configured: hasTemplate(process.env.PHANTOMBUSTER_URL_TEMPLATE),
      required: false,
      env_var: "PHANTOMBUSTER_URL_TEMPLATE (+ optional PHANTOMBUSTER_API_KEY)",
      purpose: "Workflow automation exports used for hiring/tech/traffic signal ingestion",
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
    gemini_handoff_transport: {
      configured: geminiHandoffTransportRuntime.configured,
      required: false,
      env_var: "ENABLE_GEMINI_HANDOFF_TRANSPORT, GEMINI_HANDOFF_TRANSPORT_URL, GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS, GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN, GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER, GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN",
      purpose: "Feature-flagged outbound handoff dispatch to Gemini Workspace bridge",
      runtime: geminiHandoffTransportRuntime,
    },
    gemini_handoff_dev_simulator: {
      configured: GEMINI_HANDOFF_DEV_SIMULATOR_ENABLED,
      required: false,
      env_var: "ENABLE_GEMINI_HANDOFF_DEV_SIMULATOR",
      purpose: "Local simulator endpoint for contract-compliant Gemini handoff transport testing",
    },
    gemini_google_api_bridge: {
      configured: GEMINI_HANDOFF_GOOGLE_API_BRIDGE_ENABLED && !!GEMINI_API_KEY,
      required: false,
      env_var: "ENABLE_GEMINI_HANDOFF_GOOGLE_API_BRIDGE, GEMINI_API_KEY (or GOOGLE_API_KEY), GEMINI_API_MODEL, GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS, GEMINI_HANDOFF_GOOGLE_API_MAX_RETRIES, GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS, GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS, GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS, GEMINI_HANDOFF_RETRY_429_MAX_SCOPES, GEMINI_GEM_INSTRUCTIONS_PATH, GEMINI_GEM_INSTRUCTIONS, GEMINI_GEM_INSTRUCTIONS_MAX_CHARS",
      purpose: "Local contract bridge that calls Gemini API when used as the transport URL",
      runtime: {
        enabled: GEMINI_HANDOFF_GOOGLE_API_BRIDGE_ENABLED,
        api_key_configured: !!GEMINI_API_KEY,
        model: GEMINI_API_MODEL,
        timeout_ms: GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS,
        max_retries: GEMINI_HANDOFF_GOOGLE_API_MAX_RETRIES,
        retry_base_ms: GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS,
        retry_max_ms: GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS,
        retry_429_cooldown_ms: GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS,
        retry_429_max_scopes: GEMINI_HANDOFF_RETRY_429_MAX_SCOPES,
        ...getGemInstructionsRuntimeInfo(),
      },
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
      "PROSPEO_API_KEY=optional_prospeo_key",
      "PROSPEO_URL_TEMPLATE=https://example.com/prospeo?company={company_domain}",
      "PHANTOMBUSTER_API_KEY=optional_phantombuster_key",
      "PHANTOMBUSTER_URL_TEMPLATE=https://example.com/phantombuster?company={company_number}",
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
      "ENABLE_GEMINI_HANDOFF_TRANSPORT=false",
      "GEMINI_HANDOFF_TRANSPORT_URL=https://example.com/gemini/handoff",
      "GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS=15000",
      "GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN=optional_transport_token",
      "GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER=Authorization",
      "GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN=true",
      "GEMINI_HANDOFF_MAX_RETRY_COUNT=5",
      "ENABLE_GEMINI_HANDOFF_DEV_SIMULATOR=false",
      "ENABLE_GEMINI_HANDOFF_GOOGLE_API_BRIDGE=false",
      "GEMINI_API_KEY=replace_with_google_gemini_api_key",
      "# Optional alias supported: GOOGLE_API_KEY=your_google_gemini_api_key",
      "GEMINI_API_MODEL=gemini-2.5-flash",
      "GEMINI_HANDOFF_GOOGLE_API_TIMEOUT_MS=30000",
      "GEMINI_HANDOFF_GOOGLE_API_MAX_RETRIES=2",
      "GEMINI_HANDOFF_GOOGLE_API_RETRY_BASE_MS=750",
      "GEMINI_HANDOFF_GOOGLE_API_RETRY_MAX_MS=6000",
      "GEMINI_HANDOFF_RETRY_429_COOLDOWN_MS=45000",
      "GEMINI_HANDOFF_RETRY_429_MAX_SCOPES=25",
      "GEMINI_GEM_INSTRUCTIONS_PATH=prompts/gemini-gem-instructions.txt",
      "GEMINI_GEM_INSTRUCTIONS=optional_inline_override",
      "GEMINI_GEM_INSTRUCTIONS_MAX_CHARS=12000",
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
      connectors: req.body?.connectors ?? req.body?.connector_ids ?? req.body?.connector,
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
  if (!company) company = { name: pendingCompanyName(companyNumber) };
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
  const companyName = company?.name || monitored?.company_name || pendingCompanyName(companyNumber);
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

app.get("/api/company/:id/score-diagnostics", (req, res) => {
  const context = resolveCompanyContextForEnrichment(req.params.id, req.query || {});
  if (!context) return res.status(404).json({ error: "Company not found" });

  const includeRaw = parseBooleanInput(req.query.include_raw, false);
  const refresh = parseBooleanInput(req.query.refresh, false);
  const analysis = getSetting(`analysis_${context.company_number}`, null);

  let score = getStoredScore(context.company_number);
  let scoreSource = score ? "stored_score" : "none";
  let refreshApplied = false;

  if (!score || refresh) {
    const rescored = scoreCompany(context.company_number);
    if (rescored) {
      score = analysis ? integrateAnalysis(rescored, analysis) : rescored;
      scoreSource = analysis ? "rescored_with_analysis" : "rescored";
      refreshApplied = true;
    }
  }

  if (!score) {
    return res.status(404).json({
      error: "score_not_available",
      company_id: context.canonical_id,
      company_number: context.company_number,
      message: "No monitor-backed score is available for this company.",
    });
  }

  const nameResolution = resolveCompanyNameDisplay(context.company_name, context.company_number);
  const history = getSetting(`score_history_${context.company_number}`, []);
  const scoreHistory = Array.isArray(history) ? history.slice(-10) : [];

  const diagnostics = {
    company_id: context.canonical_id,
    company_number: context.company_number,
    company_name: nameResolution.display_name,
    unresolved_company_name: nameResolution.unresolved_company_name,
    unresolved_company_name_reason: nameResolution.unresolved_company_name_reason,
    generated_at: new Date().toISOString(),
    refresh_applied: refreshApplied,
    score_source: scoreSource,
    score_snapshot: {
      composite_score: toOptionalNumber(score.composite_score),
      fit_score: toOptionalNumber(score.fit_score),
      propensity_score: toOptionalNumber(score.propensity_score),
      best_motion: String(score?.layers?.product_fit?.best_motion || "").trim() || null,
      confidence_interval: score.confidence_interval || null,
      volatility: score.volatility || null,
      llm_integrated: score.llm_integrated === true,
      scored_at: String(score.scored_at || "").trim() || null,
    },
    score_deltas: buildScoreDeltaBreakdown(score),
    layer_breakdown: buildScoreLayerBreakdown(score),
    motion_impacts: buildScoreMotionImpactBreakdown(score),
    signal_snapshots: buildScoreSignalSnapshots(context.company_number, includeRaw),
    analysis_snapshot: {
      available: !!analysis,
      source: String(analysis?.source || "").trim() || null,
      analysed_at: String(analysis?.analysed_at || analysis?.updated_at || "").trim() || null,
      summary: String(analysis?.summary || "").trim() || null,
      opportunities_count: Array.isArray(analysis?.opportunities) ? analysis.opportunities.length : 0,
      pain_indicators_count: Array.isArray(analysis?.pain_indicators) ? analysis.pain_indicators.length : 0,
      competitors_detected_count: Array.isArray(analysis?.competitors_detected) ? analysis.competitors_detected.length : 0,
    },
    score_history: scoreHistory,
  };

  if (includeRaw) {
    diagnostics.raw = {
      score,
      analysis,
    };
  }

  res.json(diagnostics);
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
    const shortlist = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), max_turnover: getTurnoverMaxThreshold(), limit });
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
  const companies = getShortlistCompanies({ min_turnover: getTurnoverThreshold(), max_turnover: getTurnoverMaxThreshold(), limit: limit || 20 });

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

    const runGeminiWeeklyAutorun = async (originLabel) => {
      try {
        const autorun = await maybeRunGeminiWeeklyHandoffForWeek(weekLabel, {
          request_prefix: "weekly",
        });
        const summary = autorun.summary || {};
        if (summary.skipped) {
          console.log(`[gemini-weekly] ${originLabel}: skipped (${summary.reason || "no_reason"})`);
          return;
        }
        console.log(
          `[gemini-weekly] ${originLabel}: request=${summary.request_id || "n/a"}, status=${summary.status || "unknown"}, selected=${summary.selected_count || 0}, ranked=${summary.ranked_count || 0}, imported=${Number(summary.sequence_import?.imported || 0)}, skipped=${Number(summary.sequence_import?.skipped || 0)}`
        );
      } catch (err) {
        console.error(`[gemini-weekly] ${originLabel} failed:`, String(err?.message || "unknown_error"));
      }
    };

    const existing = getReportByWeek(weekLabel);
    if (existing) {
      console.log(`Weekly report for ${weekLabel} already exists, skipping.`);
      await runGeminiWeeklyAutorun("existing_report");
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
    await runGeminiWeeklyAutorun("new_report");
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
