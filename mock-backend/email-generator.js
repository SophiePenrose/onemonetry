/**
 * LLM-powered email generation with full Revolut Business briefing context.
 * Generates QC-compliant, archetype-driven, persona-specific email sequences.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateEmail, APPROVED_CLAIMS, isCompanyExcluded, MANDATORY_OUTREACH_FOOTER } from "./email-qc.js";
import { detectTriggers, selectArchetype, getPersonaGuidance, getSectorAngle, COMPETITOR_DISPLACEMENT } from "./email-archetypes.js";
import { SYSTEM_PROMPT, selectInferencePattern, detectAccountHealth } from "./email-system-prompt.js";
import { getSetting } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const V7_WORKING_PROMPT_FILE = path.resolve(__dirname, "..", "prompts", "email-generation-v7.working.txt");
const V7_PRIMARY_PROMPT_FILE = path.resolve(__dirname, "..", "prompts", "email-generation-v7.txt");
const V7_ORIGINAL_PROMPT_FILE = path.resolve(__dirname, "..", "prompts", "email-generation-v7.original.txt");

function loadOperationalV7Prompt() {
  const candidates = [
    V7_WORKING_PROMPT_FILE,
    V7_PRIMARY_PROMPT_FILE,
    V7_ORIGINAL_PROMPT_FILE,
  ];

  for (const promptFile of candidates) {
    try {
      const fileText = fs.readFileSync(promptFile, "utf8");
      const normalized = String(fileText || "").trim();
      if (normalized) return normalized;
    } catch {
      // Continue to next fallback path.
    }
  }

  return null;
}

const OPERATIONAL_V7_PROMPT = loadOperationalV7Prompt();
const STRICT_JSON_CONTRACT_PROMPT = `Output contract: return a single raw JSON object only (no markdown fences, no prose outside JSON). Required keys: subject, body, footer, word_count, personalisation_audit, claims_used, disclaimers_needed, qc_self_check.`;

function buildSystemMessages() {
  if (OPERATIONAL_V7_PROMPT) {
    return [
      {
        role: "system",
        content: OPERATIONAL_V7_PROMPT,
      },
      {
        role: "system",
        content: STRICT_JSON_CONTRACT_PROMPT,
      },
    ];
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: STRICT_JSON_CONTRACT_PROMPT },
  ];
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
    || lower.includes("your_openai")
    || lower.includes("your_api_key")
    || lower.includes("your-key-here")
    || lower.includes("placeholder")
    || lower.startsWith("sk-your-")
    || lower.includes("example")
    || lower === "changeme"
    || lower === "change_me";
  return looksPlaceholder ? null : key;
}

const OPENAI_API_KEY = resolveConfiguredSecret(process.env.OPENAI_API_KEY);
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_MODEL_FALLBACK = process.env.OPENAI_MODEL_FALLBACK || "gpt-4o-mini";
const EMAIL_LLM_MIN_QC_SCORE = Math.max(40, Math.min(95,
  Number.parseInt(process.env.EMAIL_LLM_MIN_QC_SCORE || "65", 10) || 65
));
const EMAIL_LLM_MAX_ATTEMPTS = Math.max(2, Math.min(3,
  Number.parseInt(process.env.EMAIL_LLM_MAX_ATTEMPTS || "2", 10) || 2
));
const EMAIL_LLM_MAX_PROMPT_CHARS = Math.max(7000, Math.min(20000,
  Number.parseInt(process.env.EMAIL_LLM_MAX_PROMPT_CHARS || "10000", 10) || 10000
));
const EMAIL_LLM_MAX_TOKENS = Math.max(450, Math.min(1000,
  Number.parseInt(process.env.EMAIL_LLM_MAX_TOKENS || "700", 10) || 700
));
const EMAIL_LLM_FAIL_CLOSED = ["1", "true", "yes", "on"].includes(
  String(process.env.EMAIL_LLM_FAIL_CLOSED ?? "true").trim().toLowerCase()
);
let openAiAuthDisabled = false;
let openAiAuthLogged = false;

function canUseEmailLlm() {
  return !!OPENAI_API_KEY && !openAiAuthDisabled;
}

function disableEmailLlmDueToAuth(status) {
  openAiAuthDisabled = true;
  if (!openAiAuthLogged) {
    console.warn(`Email LLM disabled for this process after auth failure (${status}). Falling back to deterministic emails.`);
    openAiAuthLogged = true;
  }
}

function createRetryNeededError(reason, message) {
  const error = new Error(message || "Live email generation needs a retry.");
  error.name = "EmailRetryNeededError";
  error.code = "EMAIL_RETRY_NEEDED";
  error.reason = reason || "unknown";
  error.preventTemplateFallback = true;
  return error;
}

function throwRetryNeeded(reason, message) {
  throw createRetryNeededError(reason, message);
}

function buildFailOpenFallbackResult(params, senderName, senderTitle, reason, detail) {
  const fallback = generateFallbackEmail({
    ...params,
    senderName,
    senderTitle,
  });

  return {
    ...fallback,
    source: "fallback_preview_retry_needed",
    retry_needed: true,
    preview_low_qc: true,
    reason: reason || null,
    detail: detail || null,
  };
}

const DEFAULT_SENDER_TITLE = "Account Executive";
const DEFAULT_SENDER_NAME = "Revolut Business Team";
const RESEARCH_HEADER_PREFIX = "Revolut X";
const INTERNAL_LEAD_WITH_MOTIONS = ["Cards", "FX", "FX Forwards", "Merchant Acquiring", "Revolut Pay", "API Integrations"];
const INTERNAL_DO_NOT_LEAD_WITH = ["Spend Management", "Monthly Plans"];
const INTERNAL_MOTION_PRIORITY = {
  "Cards": 0.95,
  "FX": 0.9,
  "FX Forwards": 0.85,
  "Merchant Acquiring": 0.8,
  "Revolut Pay": 0.75,
  "API Integrations": 0.6,
  "Spend Management": 0.5,
  "Monthly Plans": 0.4,
};

const V7_TIER_A_BLUEPRINT = [
  { stepType: "proof", day: 0, sendCondition: "always" },
  { stepType: "nudge_1", day: 3, sendCondition: "opened_no_reply_after_step_1" },
  { stepType: "depth", day: 6, sendCondition: "no_reply_yet" },
  { stepType: "nudge_2", day: 9, sendCondition: "opened_no_reply_after_step_3" },
  { stepType: "provocation", day: 11, sendCondition: "no_reply_yet" },
  { stepType: "close", day: 14, sendCondition: "no_reply_yet" },
];

const V7_TIER_B_BLUEPRINT = [
  { stepType: "proof", day: 0, sendCondition: "always" },
  { stepType: "nudge_1", day: 3, sendCondition: "opened_no_reply_after_step_1" },
  { stepType: "depth", day: 6, sendCondition: "no_reply_yet" },
  { stepType: "nudge_2", day: 9, sendCondition: "opened_no_reply_after_step_3" },
  { stepType: "peer_benchmark", day: 11, sendCondition: "no_reply_yet" },
  { stepType: "close", day: 14, sendCondition: "no_reply_yet" },
];

const V7_TIER_C_BLUEPRINT = [
  { stepType: "proof", day: 0, sendCondition: "always" },
  { stepType: "peer_benchmark", day: 11, sendCondition: "no_reply_yet" },
  { stepType: "close", day: 14, sendCondition: "no_reply_yet" },
];

function confidenceToUnit(value, fallback = 0.6) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return 0;
    if (value <= 1) return value;
    if (value <= 10) return value / 10;
    if (value <= 100) return value / 100;
  }

  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["high", "strong", "confident"].includes(normalized)) return 0.85;
  if (["medium", "moderate"].includes(normalized)) return 0.65;
  if (["low", "weak", "uncertain"].includes(normalized)) return 0.35;
  return fallback;
}

function maxOpportunityConfidence(analysis = {}) {
  const direct = Array.isArray(analysis?.opportunities)
    ? analysis.opportunities
    : [];
  const useCases = Array.isArray(analysis?.level5_extraction?.revolut_opportunity?.recommended_use_cases)
    ? analysis.level5_extraction.revolut_opportunity.recommended_use_cases
    : [];

  const directMax = direct.reduce((acc, item) => Math.max(acc, confidenceToUnit(item?.confidence, 0)), 0);
  const useCaseMax = useCases.reduce((acc, item) => Math.max(acc, confidenceToUnit(item?.priority, 0)), 0);
  return Math.max(directMax, useCaseMax);
}

function classifyDossierTier(analysis = {}, score = {}, contact = {}) {
  const sequenceInputs = analysis?.level5_extraction?.sequence_inputs || {};
  const hasDirectorsLanguage = Array.isArray(sequenceInputs.directors_language) && sequenceInputs.directors_language.length > 0;
  const hasRichThemes = Array.isArray(analysis?.themes) && analysis.themes.length >= 2;
  const hasStrategicContext = hasDirectorsLanguage || hasRichThemes;

  const hasQuantSignal = !!sequenceInputs.quantified_hook
    || !!analysis?.international_exposure?.present
    || /£|%|million|billion|m\b|k\b/i.test(String(analysis?.summary || ""));

  const stakeholderConfidence = confidenceToUnit(
    contact?.confidence ?? analysis?.stakeholder_confidence ?? analysis?.level5_extraction?.stakeholder_confidence,
    0.65
  );

  const motionConfidence = Math.max(
    maxOpportunityConfidence(analysis),
    confidenceToUnit(score?.layers?.product_fit?.score, 0.55)
  );

  const industryConfidence = confidenceToUnit(
    analysis?.industry_confidence ?? analysis?.level5_extraction?.industry_confidence,
    analysis?.industry ? 0.7 : 0.45
  );

  const hasAnyFacts = hasStrategicContext
    || hasQuantSignal
    || (Array.isArray(analysis?.pain_indicators) && analysis.pain_indicators.length > 0)
    || (Array.isArray(analysis?.opportunities) && analysis.opportunities.length > 0)
    || (Array.isArray(analysis?.evidence_snippets?.pains) && analysis.evidence_snippets.pains.length > 0);

  if (!hasAnyFacts) {
    return {
      tier: "D",
      reason: "insufficient_data",
      metrics: {
        hasStrategicContext,
        hasQuantSignal,
        stakeholderConfidence,
        motionConfidence,
        industryConfidence,
      },
    };
  }

  if (hasStrategicContext && hasQuantSignal && stakeholderConfidence >= 0.7 && motionConfidence >= 0.75 && industryConfidence >= 0.8) {
    return {
      tier: "A",
      reason: "rich_dossier",
      metrics: {
        hasStrategicContext,
        hasQuantSignal,
        stakeholderConfidence,
        motionConfidence,
        industryConfidence,
      },
    };
  }

  if ((hasQuantSignal || hasStrategicContext) && stakeholderConfidence >= 0.5 && motionConfidence >= 0.5 && industryConfidence >= 0.5) {
    return {
      tier: "B",
      reason: "moderate_dossier",
      metrics: {
        hasStrategicContext,
        hasQuantSignal,
        stakeholderConfidence,
        motionConfidence,
        industryConfidence,
      },
    };
  }

  return {
    tier: "C",
    reason: "thin_dossier",
    metrics: {
      hasStrategicContext,
      hasQuantSignal,
      stakeholderConfidence,
      motionConfidence,
      industryConfidence,
    },
  };
}

function buildResearchHeaderSubject(companyName) {
  const safeCompanyName = compactWhitespace(companyName || "Company");
  return `${RESEARCH_HEADER_PREFIX} ${safeCompanyName} - I've done my research`;
}

function ensureSentence(value, fallback) {
  const normalized = compactWhitespace(value);
  const chosen = normalized || compactWhitespace(fallback);
  if (!chosen) return "";
  return /[.!?]$/.test(chosen) ? chosen : `${chosen}.`;
}

function extractLastQuestion(text) {
  const candidates = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.endsWith("?"));
  if (candidates.length === 0) return "";
  return candidates[candidates.length - 1];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeParseModelJson(content) {
  const cleaned = String(content || "")
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function countEvidenceSignals(body, analysis = {}) {
  const text = compactWhitespace(body);
  if (!text) return 0;

  const basePatterns = [
    /\b£\s?\d/i,
    /\b\d+(?:\.\d+)?%\b/i,
    /\b(?:USD|EUR|GBP|AED|SGD|JPY|CHF|CAD|AUD|NZD)\b/i,
    /\b(?:board|directors?|strategic report|filing|accounts?)\b/i,
    /\b(?:interbank|forwards?|hedg(?:e|ing)|treasury|reconciliation|settlement|cross-border|corridor)\b/i,
  ];

  let score = 0;
  for (const pattern of basePatterns) {
    if (pattern.test(text)) score += 1;
  }

  const currencies = Array.isArray(analysis?.international_exposure?.currencies)
    ? analysis.international_exposure.currencies
    : [];
  if (currencies.some((ccy) => new RegExp(`\\b${escapeRegExp(ccy)}\\b`, "i").test(text))) {
    score += 1;
  }

  const themeHints = (analysis?.themes || [])
    .map((t) => String(t?.theme || "").trim().toLowerCase())
    .filter((t) => t.length >= 5);
  if (themeHints.some((hint) => text.toLowerCase().includes(hint))) {
    score += 1;
  }

  return score;
}

function hasAnalysisAnchor(body, analysis = {}) {
  const text = compactWhitespace(body).toLowerCase();
  if (!text) return false;

  const candidatePhrases = [];
  for (const theme of (analysis?.themes || []).slice(0, 4)) {
    if (theme?.theme) candidatePhrases.push(theme.theme);
    if (theme?.evidence) candidatePhrases.push(theme.evidence);
  }
  for (const pain of (analysis?.pain_indicators || []).slice(0, 4)) {
    if (pain?.pain) candidatePhrases.push(pain.pain);
    if (pain?.evidence) candidatePhrases.push(pain.evidence);
  }
  if (analysis?.international_exposure?.details) {
    candidatePhrases.push(analysis.international_exposure.details);
  }

  const candidateTokens = new Set();
  for (const phrase of candidatePhrases) {
    for (const token of String(phrase || "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 6 && !/^(company|business|finance|operations|current|latest|filing|account|report)$/.test(token)) {
        candidateTokens.add(token);
      }
    }
  }

  if (candidateTokens.size === 0) return true;
  return Array.from(candidateTokens).some((token) => text.includes(token));
}

function maxSimilarityToPriorSteps(body, priorSteps = []) {
  const text = compactWhitespace(body);
  if (!text || !Array.isArray(priorSteps) || priorSteps.length === 0) return 0;

  let max = 0;
  for (const prior of priorSteps) {
    const priorType = String(prior?.step_type || "").toLowerCase();
    if (priorType === "nudge_1" || priorType === "nudge_2" || priorType === "close") continue;
    const priorBody = compactWhitespace(prior?.body || "");
    if (!priorBody) continue;
    max = Math.max(max, jaccardSimilarity(text, priorBody));
  }
  return max;
}

function needsSophisticationRetry(body, context = {}) {
  const stepType = String(context.stepType || "").toLowerCase();
  if (stepType === "nudge_1" || stepType === "nudge_2" || stepType === "close") {
    return false;
  }

  const text = compactWhitespace(body);
  if (!text) return true;

  const genericPatterns = [
    /\bit'?s clear that\b/i,
    /\binherent challenges?\b/i,
    /\bstreamline these processes\b/i,
    /\bfor teams at this scale\b/i,
    /\bnot (?:yet )?fully optimi[sz]ed\b/i,
  ];
  const genericHits = genericPatterns.filter((pattern) => pattern.test(text)).length;
  const evidenceSignals = countEvidenceSignals(text, context.analysis);
  const hasAnchor = hasAnalysisAnchor(text, context.analysis);
  const maxPriorSimilarity = maxSimilarityToPriorSteps(text, context.priorSteps);
  const hasQuestion = /\?/.test(text);
  const minSignals = (stepType === "proof" || stepType === "depth") ? 4 : 2;

  if (stepType === "proof" || stepType === "depth" || stepType === "provocation" || stepType === "peer_benchmark") {
    if (!hasAnchor) return true;
  }

  if ((stepType === "depth" || stepType === "provocation" || stepType === "peer_benchmark") && maxPriorSimilarity >= 0.68) {
    return true;
  }

  return evidenceSignals < minSignals || !hasQuestion || genericHits >= 1;
}

function buildRetryPrompt(basePrompt, attempt, reasons = []) {
  const reasonText = reasons.length > 0 ? reasons.join(", ") : "low-specificity draft";
  return `${basePrompt}

REVISION REQUIRED (attempt ${attempt}):
The prior draft was rejected for: ${reasonText}.
Rewrite from scratch with materially higher specificity and stronger Sophie-calibrated voice.
Hard constraints for this rewrite:
- Opening sentence must include at least two concrete filing anchors.
- Use precise operational language over abstract phrasing.
- Avoid generic filler phrases (for example: "it's clear that", "inherent challenges", "streamline these processes").
- Keep one conviction thread and end with one calibrated question.
- Return only the required raw JSON object.`;
}

function fallbackQuestionForStep(stepNumber, totalSteps) {
  const closers = getDistinctStepClosers();
  const idx = Math.min(Math.max(0, (stepNumber || 1) - 1), closers.length - 1);
  if (stepNumber === totalSteps) {
    return "If useful, I can leave this with you and reconnect when timing is better?";
  }
  return closers[idx];
}

function normalizeObservationLine(value) {
  const line = compactWhitespace(String(value || "").replace(/^Observation(?:\s*&|\s+and)\s*Origin:\s*/i, ""));
  if (!line) return "";
  if (/^(hi|hello|dear)\b/i.test(line)) return "";
  return line;
}

function comparableSentence(value) {
  return compactWhitespace(value).toLowerCase().replace(/[^a-z0-9\s]/g, "");
}

function isTurnoverLedObservation(value) {
  const line = compactWhitespace(value).toLowerCase();
  if (!line) return false;
  return line.startsWith("turnover")
    || line.startsWith("revenue")
    || /(?:turnover|revenue|sales)\s+growth/.test(line)
    || /^\d+(?:\.\d+)?%\s+(?:revenue|turnover|sales)/.test(line);
}

function motionPriorityScore(product) {
  const label = String(product || "").trim();
  if (!label) return 0;
  if (Object.prototype.hasOwnProperty.call(INTERNAL_MOTION_PRIORITY, label)) {
    return INTERNAL_MOTION_PRIORITY[label];
  }

  const normalized = label.toLowerCase();
  let score = 0;
  for (const [motion, weight] of Object.entries(INTERNAL_MOTION_PRIORITY)) {
    if (normalized.includes(motion.toLowerCase())) {
      score = Math.max(score, weight);
    }
  }
  return score;
}

function pickPrimaryUseCase(analysis = {}) {
  const level5UseCases = analysis?.level5_extraction?.revolut_opportunity?.recommended_use_cases || [];
  const opportunityUseCases = (analysis?.opportunities || []).map((item) => ({
    product: item.product,
    why_fit: item.rationale,
    priority: item.confidence,
  }));

  const candidates = [...level5UseCases, ...opportunityUseCases]
    .map((item) => ({
      ...item,
      _priorityScore: motionPriorityScore(item.product),
      _isDemoted: INTERNAL_DO_NOT_LEAD_WITH.some((blocked) => String(item.product || "").toLowerCase().includes(blocked.toLowerCase())),
    }))
    .sort((a, b) => {
      if (a._isDemoted !== b._isDemoted) return a._isDemoted ? 1 : -1;
      if (b._priorityScore !== a._priorityScore) return b._priorityScore - a._priorityScore;
      return String(a.product || "").localeCompare(String(b.product || ""));
    });

  return candidates[0] || null;
}

function enforceFindingsToEmailStructure(body, context = {}) {
  const source = String(body || "").replace(/\r/g, "").trim();
  if (!source) return "";

  const hasFrameworkLabels = /Observation\s*(?:&|and)\s*Origin:|Main\s+Pain\s+Link:|Value\s+Path(?:\s*\(Suggestions\))?:/i.test(source);
  if (!hasFrameworkLabels) {
    return source;
  }

  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  let observation = "";
  let origin = "";
  let painLink = "";
  let valuePath = "";
  let questionLine = "";

  for (const paragraph of paragraphs) {
    if (/^Observation\s*(?:&|and)\s*Origin:/i.test(paragraph)) {
      const raw = paragraph.replace(/^Observation\s*(?:&|and)\s*Origin:\s*/i, "").trim();
      const parts = raw.split(/Origin evidence:\s*/i);
      observation = observation || parts[0] || "";
      if (parts.length > 1) {
        origin = origin || parts.slice(1).join(" ").trim();
      }
      continue;
    }

    if (/^Main\s+Pain\s+Link:/i.test(paragraph)) {
      painLink = painLink || paragraph.replace(/^Main\s+Pain\s+Link:\s*/i, "").trim();
      continue;
    }

    if (/^Value\s+Path(?:\s*\(Suggestions\))?:/i.test(paragraph)) {
      valuePath = valuePath || paragraph.replace(/^Value\s+Path(?:\s*\(Suggestions\))?:\s*/i, "").trim();
      continue;
    }

    if (paragraph.endsWith("?")) {
      questionLine = paragraph;
    }
  }

  const companyName = context.companyName || "the company";
  const observationSentence = ensureSentence(observation, `From ${companyName}'s latest filing, one operational signal stands out`);
  const originSentence = ensureSentence(origin, "");
  const intro = [observationSentence]
    .concat(
      originSentence
      && comparableSentence(originSentence) !== comparableSentence(observationSentence)
        ? [originSentence]
        : []
    )
    .filter(Boolean)
    .join(" ");

  const pain = ensureSentence(
    painLink,
    "That likely creates avoidable cost, delay, or reconciliation friction for the finance team"
  );

  const value = ensureSentence(
    valuePath,
    "A scoped first step can usually run in parallel with your existing setup before any broader change"
  );

  const question = ensureSentence(
    questionLine || extractLastQuestion(source) || fallbackQuestionForStep(context.stepNumber, context.totalSteps),
    "Would it be useful if I shared the assumptions behind that view"
  ).replace(/\.$/, "?");

  let normalized = [intro, pain, value, question].filter(Boolean).join("\n\n").trim();
  const firstName = compactWhitespace(context.stakeholderName || "").split(" ")[0] || "";
  const stepType = String(context.stepType || "").toLowerCase();
  if (firstName && stepType !== "nudge_1" && stepType !== "nudge_2" && !/^(hi|hello|dear)\b/i.test(normalized)) {
    normalized = `Hi ${firstName},\n\n${normalized}`;
  }
  return normalized;
}

function enforceResearchHeaderSubject(steps, companyName) {
  const subject = buildResearchHeaderSubject(companyName);
  return (steps || []).map((step) => ({
    ...step,
    subject,
  }));
}

function enforceFindingsAcrossSteps(steps, context = {}) {
  const companyName = context.companyName || "Company";
  const analysis = context.analysis || {};
  const totalSteps = Number(context.totalSteps || (steps || []).length || 1);

  return (steps || []).map((step, idx) => {
    const stepNumber = Number.parseInt(String(step.step_number || (idx + 1)), 10) || (idx + 1);
    const stepType = String(step.step_type || "").toLowerCase();
    if (stepType === "nudge_1" || stepType === "nudge_2" || stepType === "close") {
      return step;
    }

    return {
      ...step,
      body: enforceFindingsToEmailStructure(step.body, {
        analysis,
        companyName,
        stepNumber,
        totalSteps,
      }),
    };
  });
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeStyleList(value, maxItems = 10, maxLength = 180) {
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/\r?\n|;/) : []);

  const seen = new Set();
  const output = [];
  for (const rawItem of rawItems) {
    const item = compactWhitespace(rawItem);
    if (!item) continue;
    const truncated = item.slice(0, maxLength);
    const key = truncated.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(truncated);
    if (output.length >= maxItems) break;
  }

  return output;
}

function normalizeStyleExamples(value) {
  const raw = Array.isArray(value) ? value : [];
  const output = [];

  for (let idx = 0; idx < raw.length; idx += 1) {
    const item = raw[idx];
    const label = compactWhitespace(item?.label || `Example ${idx + 1}`).slice(0, 80);
    const bodyRaw = typeof item === "string"
      ? item
      : (item?.text || item?.body || item?.content || "");
    const text = compactWhitespace(bodyRaw).slice(0, 800);
    if (!text) continue;
    output.push({ label, text });
    if (output.length >= 3) break;
  }

  return output;
}

function normalizeEmailStyleProfile(styleProfile) {
  if (!styleProfile || typeof styleProfile !== "object") return null;

  const enabled = styleProfile.enabled !== false;
  const name = compactWhitespace(styleProfile.name || styleProfile.title || "").slice(0, 120);
  const description = compactWhitespace(styleProfile.description || "").slice(0, 600);
  const stylePrompt = compactWhitespace(styleProfile.style_prompt || styleProfile.stylePrompt || "").slice(0, 2600);
  const voiceTraits = normalizeStyleList(styleProfile.voice_traits || styleProfile.voiceTraits, 10, 120);
  const prioritise = normalizeStyleList(
    styleProfile.preferred_patterns || styleProfile.preferredPatterns || styleProfile.do,
    12,
    220
  );
  const avoid = normalizeStyleList(
    styleProfile.avoid_patterns || styleProfile.avoidPatterns || styleProfile.dont,
    12,
    220
  );
  const examples = normalizeStyleExamples(styleProfile.examples);

  if (!enabled) {
    return {
      enabled: false,
      name,
      description,
      style_prompt: stylePrompt,
      voice_traits: voiceTraits,
      preferred_patterns: prioritise,
      avoid_patterns: avoid,
      examples,
    };
  }

  const hasContent = !!stylePrompt
    || voiceTraits.length > 0
    || prioritise.length > 0
    || avoid.length > 0
    || examples.length > 0;

  if (!hasContent) return null;

  return {
    enabled: true,
    name,
    description,
    style_prompt: stylePrompt,
    voice_traits: voiceTraits,
    preferred_patterns: prioritise,
    avoid_patterns: avoid,
    examples,
  };
}

function buildStyleProfilePromptSection(styleProfile) {
  const normalized = normalizeEmailStyleProfile(styleProfile);
  if (!normalized || normalized.enabled !== true) return null;

  const lines = [
    "",
    "MESSAGE STYLE PROFILE (VOICE/TONE LAYER):",
    "- Content precedence: use all available dossier evidence first, then apply this profile only to expression (tone/rhythm/wording).",
    "- Treat this as a style adapter only; do not alter factual grounding requirements.",
    "- Never copy claims or facts from examples unless independently present in this prospect context.",
  ];

  if (normalized.name) {
    lines.push(`- Style profile name: ${normalized.name}`);
  }
  if (normalized.description) {
    lines.push(`- Style intent: ${normalized.description}`);
  }
  if (normalized.style_prompt) {
    lines.push(`- Style brief: ${normalized.style_prompt}`);
  }
  if (normalized.voice_traits.length > 0) {
    lines.push(`- Voice traits to retain: ${normalized.voice_traits.join(" | ")}`);
  }
  if (normalized.preferred_patterns.length > 0) {
    lines.push(`- Patterns to prioritise: ${normalized.preferred_patterns.join(" | ")}`);
  }
  if (normalized.avoid_patterns.length > 0) {
    lines.push(`- Patterns to avoid: ${normalized.avoid_patterns.join(" | ")}`);
  }

  if (normalized.examples.length > 0) {
    lines.push("- Style examples for rhythm/voice (do NOT reuse facts):");
    for (const example of normalized.examples) {
      lines.push(`  - ${example.label}: ${example.text.slice(0, 320)}`);
    }
  }

  lines.push("- If style conflicts with compliance or QC rules, compliance/QC rules always win.");
  return lines.join("\n");
}

function stripSignatureAndFooterForYamm(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\[(?:Your\s+Name|AE_NAME|Your\s+Title|AE_TITLE)\]/gi, "").trimEnd());

  const isLegalLine = (line) => /^(To manage your sales outreach preferences|Any information provided does not constitute)/i.test(line.trim());
  const isSignatureLine = (line) => /^(Best|Thanks|Kind regards|Regards|Sincerely|Cheers|Many thanks)[,!.\s-]*$/i.test(line.trim())
    || /^(Revolut Business Team|Account Executive\s*\|\s*Revolut Business|revolut\.com\/business)$/i.test(line.trim());

  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || isLegalLine(lines[lines.length - 1]))) {
    lines.pop();
  }

  let removedSignatureMarkers = false;
  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || isSignatureLine(lines[lines.length - 1]))) {
    if (isSignatureLine(lines[lines.length - 1])) removedSignatureMarkers = true;
    lines.pop();
  }

  if (removedSignatureMarkers && lines.length > 0) {
    const candidate = lines[lines.length - 1].trim();
    if (/^[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}$/.test(candidate)) {
      lines.pop();
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeTokenSet(text) {
  return new Set(
    compactWhitespace(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  const setA = normalizeTokenSet(a);
  const setB = normalizeTokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }
  const union = setA.size + setB.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function getDistinctStepOpeners(analysis = {}) {
  const inputs = analysis?.level5_extraction?.sequence_inputs || {};
  return [
    `From your latest filing, one operational point stands out: ${inputs.now_trigger || "timing and execution pressure appears live right now"}.`,
    `A quantified lens worth pressure-testing is this: ${inputs.quantified_hook || "small execution differences can compound materially at your current volume"}.`,
    `A governance angle that often gets missed is this: ${inputs.governance_hook || "strategy intent and day-to-day execution drift over time"}.`,
    "A practical follow-up point is that most gains come from sequencing one controllable change before broad rollout.",
    "One final data point: controllable execution quality is often where the fastest margin improvement appears.",
  ];
}

function getDistinctStepClosers() {
  return [
    "Would it be useful if I shared the exact assumptions behind that view?",
    "Would a one-page assumptions sheet be useful?",
    "Would it help if I sent the short validation checklist we use with finance teams?",
    "Would you like the 3-point rollout sequence that keeps this low risk?",
    "Should I send the benchmark format so your team can pressure-test this internally?",
  ];
}

function getDeterministicStepScaffold(stepType, analysis = {}) {
  const resolvedType = String(stepType || "").toLowerCase();
  const sequenceInputs = analysis?.level5_extraction?.sequence_inputs || {};

  if (resolvedType === "depth") {
    const hook = compactWhitespace(
      sequenceInputs.operations_hook
      || "execution consistency across entities and payment corridors can drift as volume grows"
    );
    return {
      opener: ensureSentence(
        `A second layer worth pressure-testing is this: ${hook}`,
        "A second layer worth pressure-testing is this: execution consistency across entities and payment corridors can drift as volume grows."
      ),
      closer: "Does that match internal reality, or is the bottleneck elsewhere?",
    };
  }

  if (resolvedType === "provocation") {
    const hook = compactWhitespace(
      sequenceInputs.governance_hook
      || "strategy intent and day-to-day execution can diverge in ways that hide avoidable leakage"
    );
    return {
      opener: ensureSentence(
        `One hypothesis I may be wrong about: ${hook}`,
        "One hypothesis I may be wrong about: strategy intent and day-to-day execution can diverge in ways that hide avoidable leakage."
      ),
      correctionLine: "If that read is materially off, I value the correction.",
      closer: "Is that read directionally fair, or am I missing something material?",
    };
  }

  return null;
}

function enforceStepDistinctiveness(steps, analysis = {}) {
  const closerFallbacks = getDistinctStepClosers();
  const seenOpeners = [];
  const seenClosers = [];

  return (steps || []).map((step, idx) => {
    const stepType = String(step.step_type || "").toLowerCase();
    if (stepType === "nudge_1" || stepType === "nudge_2" || stepType === "close") {
      return step;
    }

    const body = String(step.body || "").trim();
    if (!body) return step;

    const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return step;

    const scaffold = getDeterministicStepScaffold(stepType, analysis);
    const hasGreetingLead = /^(hi|hello|dear)\b/i.test(paragraphs[0] || "");
    const contentStartIndex = hasGreetingLead ? 1 : 0;
    let openingIndex = contentStartIndex;
    while (openingIndex < paragraphs.length && /[?]$/.test((paragraphs[openingIndex] || "").trim())) {
      openingIndex += 1;
    }
    if (openingIndex >= paragraphs.length) {
      openingIndex = Math.min(contentStartIndex, paragraphs.length);
    }
    const opening = paragraphs[openingIndex] || "";

    if (scaffold?.opener) {
      const openingLower = compactWhitespace(opening).toLowerCase();
      const scaffoldLower = compactWhitespace(scaffold.opener).toLowerCase();
      if (!opening) {
        paragraphs.splice(openingIndex, 0, scaffold.opener);
      } else if (!openingLower.startsWith(scaffoldLower)) {
        paragraphs[openingIndex] = `${scaffold.opener} ${opening}`
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    if (scaffold?.correctionLine) {
      const hasCorrectionLine = paragraphs.some((paragraph) => /materially\s+off|value\s+the\s+correction/i.test(paragraph));
      if (!hasCorrectionLine) {
        const lastIndex = paragraphs.length - 1;
        const closerLooksQuestion = lastIndex >= 0 && /[?]$/.test((paragraphs[lastIndex] || "").trim());
        const beforeCloserIndex = closerLooksQuestion ? lastIndex : paragraphs.length;
        const insertIndex = Math.max(openingIndex + 1, beforeCloserIndex);
        paragraphs.splice(insertIndex, 0, scaffold.correctionLine);
      }
    }

    const closing = paragraphs[paragraphs.length - 1];

    const closingIsRepetitive = seenClosers.some((prev) => jaccardSimilarity(prev, closing) >= 0.75)
      || /curious how (?:your|the) team currently manages/i.test(closing);
    const mustUseDeterministicCloser = stepType === "depth" || stepType === "provocation";
    if (mustUseDeterministicCloser || closingIsRepetitive || !/[?]$/.test(closing)) {
      paragraphs[paragraphs.length - 1] = scaffold?.closer || closerFallbacks[Math.min(idx, closerFallbacks.length - 1)];
    }

    seenOpeners.push(paragraphs[0]);
    seenClosers.push(paragraphs[paragraphs.length - 1]);

    return {
      ...step,
      body: paragraphs.join("\n\n").trim(),
    };
  });
}

function sanitizeSenderName(value) {
  const cleaned = compactWhitespace(value);
  if (!cleaned) return DEFAULT_SENDER_NAME;
  if (/^\[?(your\s+name|ae_name)\]?$/i.test(cleaned)) return DEFAULT_SENDER_NAME;
  return cleaned;
}

function sanitizeSenderTitle(value) {
  const cleaned = compactWhitespace(value);
  if (!cleaned) return DEFAULT_SENDER_TITLE;
  if (/^\[?(your\s+title|ae_title)\]?$/i.test(cleaned)) return DEFAULT_SENDER_TITLE;
  return cleaned;
}

function parseMoneyFromText(text) {
  const value = String(text || "");
  const match = value.match(/£\s*([\d,]+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const suffix = String(match[2] || "").toLowerCase();
  const multiplier = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return Math.round(base * multiplier);
}

function formatPounds(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "£250,000";
  return `£${Math.round(amount).toLocaleString("en-GB")}`;
}

function estimateRoundedFigure(context = {}) {
  const companyTurnover = Number(context.companyTurnover || 0);
  const sequenceHook = String(context?.analysis?.level5_extraction?.sequence_inputs?.quantified_hook || "");
  const hookMoney = parseMoneyFromText(sequenceHook);
  if (hookMoney && hookMoney > 0) return formatPounds(hookMoney);

  const currencies = context?.analysis?.international_exposure?.currencies || [];
  const hasInternational = !!context?.analysis?.international_exposure?.present;

  if (companyTurnover > 0 && hasInternational) {
    const fxVolume = companyTurnover * (currencies.length > 2 ? 0.35 : 0.22);
    const estimate = fxVolume * 0.008;
    const rounded = Math.round(estimate / 10000) * 10000;
    return formatPounds(Math.max(100000, rounded));
  }

  if (companyTurnover > 0) {
    const conservative = Math.round((companyTurnover * 0.0004) / 10000) * 10000;
    return formatPounds(Math.max(50000, conservative));
  }

  return "£250,000";
}

function replacePlaceholders(text, replacements = {}) {
  let out = String(text || "");
  for (const [needle, replacement] of Object.entries(replacements)) {
    out = out.split(needle).join(replacement);
  }
  return out;
}

function countWords(value) {
  const text = compactWhitespace(value);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function defaultNudgeBody(stepType, firstName) {
  if (stepType === "nudge_2") {
    return `Hi ${firstName}, quick follow-up on the note below. Best,`;
  }
  return `Hi ${firstName}, any thoughts on the below? Best,`;
}

function normalizeNudgeBody(body, stepType, stakeholderName) {
  const firstName = compactWhitespace(stakeholderName || "").split(" ")[0] || "there";
  const fallback = defaultNudgeBody(stepType, firstName);

  const cleaned = compactWhitespace(
    stripSignatureAndFooterForYamm(String(body || ""))
      .replace(/^hi\s+[^,]+,\s*/i, "")
      .replace(/\s*best,?\s*$/i, "")
      .replace(/\s*kind regards,?\s*$/i, "")
      .replace(/\s*thanks,?\s*$/i, "")
  );

  if (!cleaned) return fallback;

  let normalized = `Hi ${firstName}, ${cleaned.replace(/[.!?]+$/g, "")}. Best,`;
  normalized = normalized
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();

  const words = countWords(normalized);
  if (words < 8 || words > 20 || /\n/.test(normalized)) {
    return fallback;
  }

  return normalized;
}

function ensureSubstantiveGreeting(body, stakeholderName) {
  const text = String(body || "").trim();
  if (!text) return text;

  const firstName = compactWhitespace(stakeholderName || "").split(" ")[0] || "there";
  if (/^(hi|hello|dear)\b/i.test(text)) return text;

  const bareNamePrefix = new RegExp(`^${escapeRegExp(firstName)}\\s*,\\s*`, "i");
  if (bareNamePrefix.test(text)) {
    const stripped = text.replace(bareNamePrefix, "").trim();
    return `Hi ${firstName},\n\n${stripped}`.trim();
  }

  return `Hi ${firstName},\n\n${text}`;
}

function normalizeCloseBody(body, stakeholderName) {
  const firstName = compactWhitespace(stakeholderName || "").split(" ")[0] || "there";
  const cleaned = stripSignatureAndFooterForYamm(String(body || "")).trim();
  const words = countWords(cleaned);

  if (words >= 40 && words <= 70 && /\b(i'?ll leave it there|line is open|priority)\b/i.test(cleaned)) {
    return ensureSubstantiveGreeting(cleaned, stakeholderName);
  }

  return `Hi ${firstName},\n\nI'll leave it there for now. If the cross-border execution and treasury workflow question becomes a priority this quarter, I can share a short benchmark note from similar teams and the assumptions behind it.\n\nBest,\nSophie Louise Penrose`;
}

function postProcessGeneratedEmail(parsed, context = {}) {
  const {
    companyName,
    senderName,
    senderTitle,
    analysis,
    companyTurnover,
    stepNumber,
    totalSteps,
    stepType,
  } = context;

  const replacements = {
    "[Your Name]": senderName,
    "[AE_NAME]": senderName,
    "[Your Title]": senderTitle,
    "[AE_TITLE]": senderTitle,
    "[Company Name]": companyName,
    "[Company]": companyName,
    "[company]": companyName,
  };

  const roundedFigure = estimateRoundedFigure({ analysis, companyTurnover });
  const subject = buildResearchHeaderSubject(companyName);
  let body = replacePlaceholders(parsed?.body || "", replacements).trim();
  body = body
    .replace(/£\s*\[rounded figure\]/gi, roundedFigure)
    .replace(/\[rounded figure\]/gi, roundedFigure.replace(/^£/, ""));
  body = stripSignatureAndFooterForYamm(body);

  const isNudgeStep = stepType === "nudge_1" || stepType === "nudge_2";
  const isCloseStep = stepType === "close";
  if (isNudgeStep) {
    body = normalizeNudgeBody(body, stepType, context.stakeholderName);
  } else if (isCloseStep) {
    body = normalizeCloseBody(body, context.stakeholderName);
  } else {
    body = enforceFindingsToEmailStructure(body, {
      analysis,
      companyName,
      stepNumber,
      totalSteps,
      stepType,
      stakeholderName: context.stakeholderName,
    });
    body = ensureSubstantiveGreeting(body, context.stakeholderName);
  }

  return {
    subject,
    body,
    footer: "",
    claims_used: Array.isArray(parsed?.claims_used) ? parsed.claims_used : [],
    disclaimers_needed: Array.isArray(parsed?.disclaimers_needed) ? parsed.disclaimers_needed : [],
  };
}

function removeForbiddenThreeItemRhythm(text) {
  let output = String(text || "");
  for (let i = 0; i < 3; i += 1) {
    const next = output.replace(
      /\b([^,\n]{3,60}),\s+([^,\n]{3,60}),\s+and\s+([^,\n]{3,60})\b/g,
      "$1 and $2, with $3"
    );
    if (next === output) break;
    output = next;
  }
  return output;
}

function normalizeSentenceOpeners(text) {
  return String(text || "")
    .replace(/(^|[.!?]\s+)(?:and|but)\s+/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildGate1ResearchAnchor(context = {}) {
  const company = context.company || {};
  const analysis = context.analysis || {};
  const evidenceSegments = [];

  if (Number.isFinite(company.turnover) && company.turnover > 0) {
    evidenceSegments.push(`your latest filed turnover sat around £${(company.turnover / 1e6).toFixed(1)}M`);
  }

  if (analysis?.international_exposure?.present) {
    const currencies = Array.isArray(analysis?.international_exposure?.currencies)
      ? analysis.international_exposure.currencies.slice(0, 3)
      : [];
    if (currencies.length > 0) {
      evidenceSegments.push(`the filing points to cross-border exposure across ${currencies.join("/")}`);
    } else {
      evidenceSegments.push("the filing points to active cross-border operations");
    }
  }

  const firstTheme = analysis?.themes?.[0];
  if (firstTheme?.evidence) {
    evidenceSegments.push(truncateFallbackLine(firstTheme.evidence, 140));
  } else if (analysis?.summary) {
    evidenceSegments.push(truncateFallbackLine(analysis.summary, 140));
  }

  if (evidenceSegments.length === 0) return "";
  if (evidenceSegments.length === 1) {
    return `From your filing, ${evidenceSegments[0]}.`;
  }

  const head = evidenceSegments.slice(0, -1).join(", ");
  const tail = evidenceSegments[evidenceSegments.length - 1];
  return `From your filing, ${head}, and ${tail}.`;
}

function augmentGate1ResearchDensity(body, context = {}) {
  const anchorSentence = buildGate1ResearchAnchor(context);
  if (!anchorSentence) return String(body || "");

  const source = String(body || "").trim();
  if (!source) return anchorSentence;
  if (/from\s+your\s+(?:latest\s+)?fil(?:ing|ed\s+accounts)/i.test(source)) return source;

  const greetingMatch = source.match(/^(Hi\s+[^\n]+,\n\n)/i);
  if (greetingMatch) {
    return source.replace(greetingMatch[0], `${greetingMatch[0]}${anchorSentence}\n\n`);
  }

  return `${anchorSentence}\n\n${source}`;
}

function sanitizeGate2VoicePhrases(text) {
  let output = String(text || "");

  const phraseReplacements = [
    [/\bi\s+hope\s+this\s+finds\s+you\s+well[,.!\s]*/gi, ""],
    [/\bi\s+wanted\s+to\s+reach\s+out\b/gi, "I am writing with one filing-backed observation"],
    [/\bquick\s+question[:,]?\s*/gi, ""],
    [/\bjust\s+wanted\s+to\b/gi, "wanted to"],
    [/\bi\s+came\s+across\b/gi, "from your latest filing"],
    [/\bi\s+noticed\b/gi, "from your latest filing"],
    [/\bdelve\b/gi, "review"],
    [/\bnavigate\b/gi, "manage"],
    [/\brobust\b/gi, "practical"],
    [/\bseamless\b/gi, "direct"],
    [/\bin\s+today'?s\b/gi, "currently"],
    [/\bin\s+the\s+realm\s+of\b/gi, "in"],
    [/\bstands\s+as\s+a\s+testament\b/gi, "signals"],
    [/\bspeaks\s+volumes\b/gi, "is notable"],
    [/\bit'?s\s+worth\s+noting\b/gi, "notably"],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    output = output.replace(pattern, replacement);
  }

  output = output
    .replace(/[—–]/g, ", ")
    .replace(/--/g, ", ")
    .replace(/!/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();

  output = removeForbiddenThreeItemRhythm(output);
  output = normalizeSentenceOpeners(output);
  return output;
}

function sanitizeGate3CompliancePhrases(text) {
  let output = String(text || "");
  const phraseReplacements = [
    [/\balways\s+free\b/gi, "cost-effective for this workflow"],
    [/\bfree\s+forever\b/gi, "cost-effective over time"],
    [/\bunlimited\b/gi, "scaled"],
    [/\bbest\b/gi, "strong"],
    [/\bcheapest\b/gi, "more cost-efficient"],
    [/\bfastest\b/gi, "faster"],
    [/\b(last\s+chance|act\s+now|limited\s+time)\b/gi, "if timing is right"],
    [/(?<!not\s)\bguaranteed\b/gi, "likely"],
    [/\b100%\b/g, "high-confidence"],
    [/\baccount\s+manager\b/gi, "contact"],
    [/\bfinancial\s+advis[oe]r\b/gi, "finance partner"],
    [/\bwe'?re\s+the\s+best\b/gi, "we focus on measurable execution improvements"],
    [/\bthe\s+best\b/gi, "a strong"],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    output = output.replace(pattern, replacement);
  }

  return output.replace(/\s{2,}/g, " ").trim();
}

function ensureComplianceCaveats(body, qcResult) {
  let output = String(body || "").trim();
  const checks = qcResult?.gates?.gate3?.checks || [];
  const failedIds = new Set(checks.filter((check) => check?.passed === false).map((check) => check.id));

  if (failedIds.has("claims_traceability") && !/based\s+on\s+your\s+filed\s+accounts|we\s+estimate|depends\s+on\s+your\s+current\s+provider/i.test(output)) {
    output = `${output}\n\nBased on your filed accounts, we estimate this directionally, and the realised impact depends on your current provider rates.`.trim();
  }

  if (failedIds.has("required_disclaimers") && !/illustrative\s+of\s+savings\s+that\s+could\s+be\s+achieved|during\s+market\s+hours\s+within\s+plan\s+allowance/i.test(output)) {
    output = `${output}\n\nThis estimate is illustrative of savings that could be achieved, but is not guaranteed.`.trim();
  }

  return output;
}

function applyDeterministicQcRemediation(normalizedEmail, qcResult, context = {}) {
  const stepType = String(context.stepType || "").toLowerCase();
  if (stepType === "nudge_1" || stepType === "nudge_2" || stepType === "close") {
    return { changed: false, body: String(normalizedEmail?.body || "") };
  }

  const hasGate1Failure = qcResult?.gates?.gate1?.pass === false;
  const hasGate2Failure = qcResult?.gates?.gate2?.pass === false;
  const hasGate3Failure = qcResult?.gates?.gate3?.pass === false;
  if (!hasGate1Failure && !hasGate2Failure && !hasGate3Failure) {
    return { changed: false, body: String(normalizedEmail?.body || "") };
  }

  let candidate = String(normalizedEmail?.body || "");
  if (hasGate1Failure) {
    candidate = augmentGate1ResearchDensity(candidate, context);
  }
  if (hasGate2Failure) {
    candidate = sanitizeGate2VoicePhrases(candidate);
  }
  if (hasGate3Failure) {
    candidate = sanitizeGate3CompliancePhrases(candidate);
    candidate = ensureComplianceCaveats(candidate, qcResult);
  }

  candidate = ensureSubstantiveGreeting(candidate, context.stakeholderName);
  const changed = compactWhitespace(candidate) !== compactWhitespace(normalizedEmail?.body || "");
  return { changed, body: candidate };
}

function makeStepSubjectsUnique(steps, companyName) {
  const seen = new Map();
  const suffixFor = {
    1: "filing insight",
    2: "quantified angle",
    3: "governance view",
    4: "insight gift",
    5: "close",
  };

  return (steps || []).map((step) => {
    const base = compactWhitespace(step.subject || `${companyName} update`);
    const key = base.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);

    if (count === 0) return step;

    const stepNumber = Number.parseInt(String(step.step_number || 0), 10) || count + 1;
    const suffix = suffixFor[stepNumber] || `step ${stepNumber}`;
    return {
      ...step,
      subject: `${base} - ${suffix}`,
    };
  });
}

export async function generateLLMEmail(params) {
  const {
    company,
    contact,
    analysis,
    score,
    archetype,
    trigger,
    senderName,
    senderTitle,
    stepNumber,
    totalSteps,
    stepType,
    priorSteps,
    styleProfile,
  } = params;
  const resolvedStepType = String(
    stepType || (stepNumber === 1 ? "proof" : stepNumber === totalSteps ? "close" : "depth")
  ).toLowerCase();
  const resolvedSenderName = sanitizeSenderName(senderName || getSetting("sender_name", DEFAULT_SENDER_NAME));
  const resolvedSenderTitle = sanitizeSenderTitle(senderTitle || getSetting("sender_title", DEFAULT_SENDER_TITLE));

  if (!canUseEmailLlm()) {
    return generateFallbackEmail({
      ...params,
      senderName: resolvedSenderName,
      senderTitle: resolvedSenderTitle,
    });
  }

  const persona = getPersonaGuidance(contact.role);
  const sector = getSectorAngle(company.industry);
  const displacement = analysis?.competitors_detected?.length > 0
    ? COMPETITOR_DISPLACEMENT[analysis.competitors_detected[0].name]
    : null;
  const inferenceData = selectInferencePattern(company, analysis);
  const accountHealth = detectAccountHealth(analysis, score);

  const enrichedParams = { ...params, inferenceData, accountHealth };
  const userPrompt = clampPromptForTokenSafety(buildUserPrompt({
    ...enrichedParams,
    senderName: resolvedSenderName,
    senderTitle: resolvedSenderTitle,
  }, persona, sector, displacement));
  const modelCandidates = Array.from(new Set([OPENAI_MODEL, OPENAI_MODEL_FALLBACK].filter(Boolean)));
  let bestLowQcResult = null;

  try {
    const maxAttempts = EMAIL_LLM_MAX_ATTEMPTS;
    const retryReasons = [];

    const buildResult = ({ selectedNormalized, selectedQcResult, normalized, attempt, modelName }) => ({
      subject: selectedNormalized.subject,
      body: selectedNormalized.body,
      footer: selectedNormalized.footer,
      archetype: archetype?.id || "diagnostic_filing",
      trigger_type: trigger?.type || null,
      qc_score: selectedQcResult.score,
      qc_pass: selectedQcResult.pass,
      qc_issues: selectedQcResult.issues,
      metrics: selectedQcResult.metrics,
      quality_gates: selectedQcResult.gates,
      voice_percent: selectedQcResult.metrics?.voice_percent ?? null,
      claims_used: selectedNormalized.claims_used,
      disclaimers_needed: selectedNormalized.disclaimers_needed,
      source: compactWhitespace(selectedNormalized.body) === compactWhitespace(normalized.body)
        ? (attempt > 1 ? "llm_rewrite" : "llm")
        : (attempt > 1 ? "llm_rewrite_remediated" : "llm_remediated"),
      model: modelName,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptPrompt = attempt === 1
        ? userPrompt
        : buildRetryPrompt(userPrompt, attempt, retryReasons);

      let shouldRetryAttempt = false;
      for (const modelName of modelCandidates) {
        const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: modelName,
            response_format: { type: "json_object" },
            messages: [
              ...buildSystemMessages(),
              { role: "user", content: attemptPrompt },
            ],
            temperature: 0.55,
            max_tokens: EMAIL_LLM_MAX_TOKENS,
          }),
        });

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            disableEmailLlmDueToAuth(response.status);
          }

          const hasFallbackModel = modelCandidates.length > 1 && modelName !== modelCandidates[modelCandidates.length - 1];
          if (response.status === 404 && hasFallbackModel) {
            retryReasons.push(`model_unavailable_${modelName}`);
            continue;
          }

          if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) {
            retryReasons.push(`upstream_http_${response.status}`);
            shouldRetryAttempt = true;
            break;
          }

          if (canUseEmailLlm()) {
            if (!EMAIL_LLM_FAIL_CLOSED) {
              return buildFailOpenFallbackResult(
                params,
                resolvedSenderName,
                resolvedSenderTitle,
                `upstream_http_${response.status}`,
                `Live email generation upstream failure (${response.status}); served deterministic fallback draft.`
              );
            }

            throwRetryNeeded(
              `upstream_http_${response.status}`,
              `Live email generation upstream failure (${response.status}). Retry required.`
            );
          }

          return generateFallbackEmail({
            ...params,
            senderName: resolvedSenderName,
            senderTitle: resolvedSenderTitle,
          });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          retryReasons.push("empty_model_response");
          shouldRetryAttempt = true;
          continue;
        }

        const parsed = safeParseModelJson(content);
        if (!parsed) {
          retryReasons.push("invalid_json_response");
          shouldRetryAttempt = true;
          continue;
        }

        const normalized = postProcessGeneratedEmail(parsed, {
          companyName: company.name || "Company",
          senderName: resolvedSenderName,
          senderTitle: resolvedSenderTitle,
          analysis,
          companyTurnover: company.turnover,
          stepNumber,
          totalSteps,
          stepType: resolvedStepType,
          stakeholderName: contact?.name || "",
        });

        if (attempt < maxAttempts && needsSophisticationRetry(normalized.body, {
          stepType: resolvedStepType,
          analysis,
          priorSteps,
        })) {
          retryReasons.push("low_specificity_or_generic_language");
          shouldRetryAttempt = true;
          break;
        }

        const qcMeta = {
          isInitialOutreach: stepNumber === 1,
          stepType: resolvedStepType,
          assumeManagedFooter: true,
          footerTemplate: MANDATORY_OUTREACH_FOOTER,
        };

        let selectedNormalized = normalized;
        let selectedQcResult = validateEmail(
          { subject: selectedNormalized.subject, body: selectedNormalized.body },
          qcMeta
        );

        const remediated = applyDeterministicQcRemediation(selectedNormalized, selectedQcResult, {
          stepType: resolvedStepType,
          stakeholderName: contact?.name || "",
          company,
          analysis,
        });

        if (remediated.changed) {
          const remediatedCandidate = {
            ...selectedNormalized,
            body: remediated.body,
          };
          const remediatedQcResult = validateEmail(
            { subject: remediatedCandidate.subject, body: remediatedCandidate.body },
            qcMeta
          );

          const baselineScore = Number(selectedQcResult?.score || 0);
          const remediatedScore = Number(remediatedQcResult?.score || 0);
          if (remediatedQcResult.pass === true || remediatedScore >= baselineScore) {
            selectedNormalized = remediatedCandidate;
            selectedQcResult = remediatedQcResult;
          }
        }

        const qcScore = Number(selectedQcResult?.score || 0);
        const meetsQualityFloor = selectedQcResult.pass === true && qcScore >= EMAIL_LLM_MIN_QC_SCORE;
        const failedGateNames = Object.entries(selectedQcResult.gates || {})
          .filter(([, gate]) => gate && gate.pass === false)
          .map(([name]) => name)
          .join("+");
        const qualityReason = selectedQcResult.pass === true ? "quality_floor_failed" : "quality_gates_failed";
        const qualityDetail = selectedQcResult.pass === true
          ? `Live email generation quality score ${qcScore} below floor ${EMAIL_LLM_MIN_QC_SCORE}. Retry required.`
          : `Live email generation failed QC gates (${failedGateNames || "unknown"}) at score ${qcScore}. Retry required.`;

        const candidateResult = buildResult({
          selectedNormalized,
          selectedQcResult,
          normalized,
          attempt,
          modelName,
        });
        if (!bestLowQcResult || Number(candidateResult.qc_score || 0) > Number(bestLowQcResult.qc_score || 0)) {
          bestLowQcResult = candidateResult;
        }

        if (!meetsQualityFloor && attempt < maxAttempts) {
          const reasonSuffix = failedGateNames || `score_${qcScore}`;
          retryReasons.push(`${qualityReason}_${reasonSuffix}`);
          shouldRetryAttempt = true;
          break;
        }

        if (!meetsQualityFloor) {
          if (canUseEmailLlm() && !EMAIL_LLM_FAIL_CLOSED) {
            if (bestLowQcResult) {
              return {
                ...bestLowQcResult,
                source: `${bestLowQcResult.source}_preview_low_qc`,
                retry_needed: true,
                preview_low_qc: true,
              };
            }

            return buildFailOpenFallbackResult(
              params,
              resolvedSenderName,
              resolvedSenderTitle,
              qualityReason,
              qualityDetail
            );
          }

          if (canUseEmailLlm()) {
            throwRetryNeeded(qualityReason, qualityDetail);
          }

          return generateFallbackEmail({
            ...params,
            senderName: resolvedSenderName,
            senderTitle: resolvedSenderTitle,
          });
        }

        return candidateResult;
      }

      if (shouldRetryAttempt && attempt < maxAttempts) {
        continue;
      }
    }

    if (canUseEmailLlm()) {
      if (!EMAIL_LLM_FAIL_CLOSED) {
        if (bestLowQcResult) {
          return {
            ...bestLowQcResult,
            source: `${bestLowQcResult.source}_preview_low_qc`,
            retry_needed: true,
            preview_low_qc: true,
          };
        }

        return buildFailOpenFallbackResult(
          params,
          resolvedSenderName,
          resolvedSenderTitle,
          "quality_gate_exhausted",
          "Live email generation did not meet quality gates after retries; served deterministic fallback draft."
        );
      }

      throwRetryNeeded(
        "quality_gate_exhausted",
        "Live email generation did not meet quality gates after retries. Retry required."
      );
    }

    return generateFallbackEmail({
      ...params,
      senderName: resolvedSenderName,
      senderTitle: resolvedSenderTitle,
    });
  } catch (err) {
    console.error("Email generation LLM error:", err.message);

    if (err?.preventTemplateFallback) {
      if (!EMAIL_LLM_FAIL_CLOSED) {
        if (bestLowQcResult) {
          return {
            ...bestLowQcResult,
            source: `${bestLowQcResult.source}_preview_low_qc`,
            retry_needed: true,
            preview_low_qc: true,
          };
        }

        return buildFailOpenFallbackResult(
          params,
          resolvedSenderName,
          resolvedSenderTitle,
          err?.reason || "llm_retry_needed",
          err?.message || "Live email generation retry requested; served deterministic fallback draft."
        );
      }

      throw err;
    }

    if (canUseEmailLlm()) {
      if (!EMAIL_LLM_FAIL_CLOSED) {
        if (bestLowQcResult) {
          return {
            ...bestLowQcResult,
            source: `${bestLowQcResult.source}_preview_low_qc`,
            retry_needed: true,
            preview_low_qc: true,
          };
        }

        return buildFailOpenFallbackResult(
          params,
          resolvedSenderName,
          resolvedSenderTitle,
          "llm_runtime_error",
          "Live email generation failed due to an upstream/runtime error; served deterministic fallback draft."
        );
      }

      throwRetryNeeded("llm_runtime_error", "Live email generation failed due to an upstream/runtime error. Retry required.");
    }

    return generateFallbackEmail({
      ...params,
      senderName: resolvedSenderName,
      senderTitle: resolvedSenderTitle,
    });
  }
}

function buildUserPrompt(params, persona, sector, displacement) {
  const {
    company,
    contact,
    analysis,
    score,
    archetype,
    trigger,
    stepNumber,
    totalSteps,
    merchantSpend,
    stepType,
    dossierTier,
    sendCondition,
    priorSteps,
    styleProfile,
  } = params;
  const level5 = analysis?.level5_extraction || null;
  const resolvedStepType = stepType
    || (stepNumber === 1 ? "proof" : stepNumber === totalSteps ? "close" : "depth");
  const resolvedTier = String(dossierTier || "B").toUpperCase();

  const parts = [`Generate email step ${stepNumber} of ${totalSteps} for this prospect.

CRITICAL INSTRUCTION: This email MUST reference specific facts from the company data below. Every paragraph should contain a verifiable observation. Do NOT write generic copy. Show proof-of-research by citing:
- Specific countries they operate in
- Specific currencies they trade in
- Specific financial figures or trends from their filing
- Specific pain points unique to THIS company
- Named competitors detected in their setup

The "proof of research" principle: the prospect should think "how do they know that?" within the first 2 sentences.`];

  if (resolvedStepType === "nudge_1" || resolvedStepType === "nudge_2") {
    parts.push(`\nFORMAT REQUIREMENT:
- One short line only (8-20 words)
- Do not use section headings
- No signature block, no footer, no extra commentary`);
  } else if (resolvedStepType === "close") {
    parts.push(`\nFORMAT REQUIREMENT:
- One concise paragraph plus optional sign-off sentence
- No section headings
- No signature block, sender title line, website link, or footer`);
  } else {
    parts.push(`\nFORMAT REQUIREMENT:
- 2-3 short natural paragraphs plus one calibrated closing question
- Integrate observation source, pain implication, and value path naturally in prose (do NOT use labels)
- Avoid list formatting unless absolutely necessary
- Do NOT lead with turnover-only framing; lead with operational filing context first.
- Do NOT include a signature block, sender name, sender title, website link, or compliance footer in the body.
- End cleanly on the closing question. Signature is added at send time via YAMM.`);
  }

  parts.push(`\nINTERNAL REVOLUT SEQUENCE POLICY:
- Lead with high-priority motions when evidence supports them: ${INTERNAL_LEAD_WITH_MOTIONS.join(", ")}.
- Do NOT lead with these unless evidence is explicit and urgent: ${INTERNAL_DO_NOT_LEAD_WITH.join(", ")}.
- If multiple opportunities exist, choose one primary motion for this step and keep the email single-threaded.`);

  const styleProfileBlock = buildStyleProfilePromptSection(styleProfile);
  if (styleProfileBlock) {
    parts.push(styleProfileBlock);
  }

  parts.push(`\nCOMPANY FACTS (USE THESE SPECIFICALLY — do not generalise):
- Company name: ${company.name}
- Annual turnover: £${company.turnover ? (company.turnover / 1e6).toFixed(1) + "M" : "Unknown"}
- Employees: ${company.employee_count || "Unknown"}
- Industry: ${company.industry || "Unknown"}
- Segment: ${company.segment || "Mid-Market"}`);

  if (analysis?.summary) {
    parts.push(`- LLM summary: "${truncateFallbackLine(analysis.summary, 340)}"`);
  }

  if (analysis?.international_exposure?.present) {
    const intlDetails = truncateFallbackLine(analysis.international_exposure.details, 320)
      || "International operations signal present";
    parts.push(`- International operations: ${intlDetails}`);
    if (analysis.international_exposure.currencies?.length) {
      parts.push(`- Currencies traded: ${analysis.international_exposure.currencies.join(", ")}`);
      const vol = company.turnover * (analysis.international_exposure.currencies.length > 2 ? 0.5 : 0.3);
      parts.push(`- Estimated annual FX volume: ~£${(vol / 1e6).toFixed(0)}M`);
      parts.push(`- Estimated FX cost at bank rates (1.5%): ~£${(vol * 0.015 / 1000).toFixed(0)}K/year`);
      parts.push(`- Estimated saving on interbank: ~£${(vol * 0.012 / 1000).toFixed(0)}K/year`);
    }
  }

  if (analysis?.turnover_trend) {
    parts.push(`- Revenue trend: ${truncateFallbackLine(analysis.turnover_trend, 180)}${score?.growth?.rate ? ` (${(score.growth.rate * 100).toFixed(0)}% YoY)` : ""}`);
  }

  if (analysis?.themes?.length > 0) {
    parts.push(`\nKEY THEMES FROM FILING (reference at least one):`);
    for (const t of analysis.themes.slice(0, 6)) {
      const theme = truncateFallbackLine(t?.theme || "Theme", 120);
      const evidence = truncateFallbackLine(t?.evidence || "", 220);
      parts.push(`- ${theme}: "${evidence}"`);
    }
  }

  if (analysis?.pain_indicators?.length > 0) {
    parts.push(`\nSPECIFIC PAIN POINTS (weave one into the email):`);
    for (const p of analysis.pain_indicators.slice(0, 6)) {
      const pain = truncateFallbackLine(p?.pain || "Pain", 160);
      const evidence = truncateFallbackLine(p?.evidence || "", 220);
      parts.push(`- [${p?.severity || "medium"}] ${pain}: "${evidence}"`);
    }
  }

  if (analysis?.opportunities?.length > 0) {
    parts.push(`\nPRODUCT OPPORTUNITIES IDENTIFIED:`);
    for (const o of analysis.opportunities.slice(0, 6)) {
      const rationale = truncateFallbackLine(o?.rationale || "", 220);
      parts.push(`- ${o?.product || "Product"} [${o?.confidence || "medium"} confidence]: "${rationale}"`);
    }
  }

  if (analysis?.competitors_detected?.length > 0) {
    parts.push(`\nCOMPETITORS DETECTED IN THEIR SETUP:`);
    for (const c of analysis.competitors_detected.slice(0, 5)) {
      const disp = COMPETITOR_DISPLACEMENT[c.name];
      parts.push(`- ${c?.name || "Competitor"} (${c?.product || "Unknown"}): weakness = "${truncateFallbackLine(disp?.weakness || c?.displacement_angle || "", 180)}"`);
      if (disp) parts.push(`  Approved angle: "${truncateFallbackLine(disp.angle, 180)}"`);
    }
  }

  if (analysis?.key_people?.length > 0) {
    const keyPeople = analysis.key_people
      .slice(0, 8)
      .map((p) => `${truncateFallbackLine(p?.name || "Unknown", 80)} (${truncateFallbackLine(p?.role || "Role", 80)})`)
      .join(", ");
    parts.push(`\nKEY PEOPLE FROM FILING: ${keyPeople}`);
  }

  if (level5) {
    const snapshot = level5.company_snapshot || {};
    const topPains = (level5.pain_register || []).slice(0, 3);
    const useCases = (level5.revolut_opportunity?.recommended_use_cases || []).slice(0, 3);
    const sequenceInputs = level5.sequence_inputs || {};

    parts.push(`\nLEVEL 5 EXTRACTION (PRIORITISE THESE SIGNALS):
- Segment fit: ${snapshot.segment_fit || company.segment || "Mid-Market"}
  - Operating model: ${truncateFallbackLine(snapshot.operating_model || analysis?.summary || "Unknown", 220)}
  - International profile: ${truncateFallbackLine(snapshot.international_profile || analysis?.international_exposure?.details || "Unknown", 220)}
  - Now trigger: ${truncateFallbackLine(sequenceInputs.now_trigger || "Latest filing context", 220)}
  - Quantified hook: ${truncateFallbackLine(sequenceInputs.quantified_hook || "Validate with provider-rate review", 220)}
  - Operations hook: ${truncateFallbackLine(sequenceInputs.operations_hook || "Operational scale signal available", 220)}
  - Governance hook: ${truncateFallbackLine(sequenceInputs.governance_hook || "Current setup constraints to validate", 220)}
  - Objection to pre-empt: ${truncateFallbackLine(sequenceInputs.objection_to_preempt || "Can run in parallel with existing credit/facility setup", 220)}`);

    if (topPains.length > 0) {
      parts.push("\nLEVEL 5 PAIN REGISTER (use evidence + inference):");
      for (const item of topPains) {
        parts.push(`- ${truncateFallbackLine(item?.area || "Pain area", 120)} [${item?.severity || "medium"}]: evidence="${truncateFallbackLine(item?.evidence || "", 180)}" | inferred="${truncateFallbackLine(item?.inferred_problem || "", 180)}"`);
      }
    }

    if (useCases.length > 0) {
      parts.push("\nLEVEL 5 PRIORITISED USE CASES:");
      for (const item of useCases) {
        parts.push(`- ${truncateFallbackLine(item?.product || "Use case", 100)} (${item?.priority || "medium"}): ${truncateFallbackLine(item?.why_fit || "", 180)} Example: ${truncateFallbackLine(item?.example_use_case || "", 180)}`);
      }
    }

    if (Array.isArray(sequenceInputs.directors_language) && sequenceInputs.directors_language.length > 0) {
      const directorsLanguage = sequenceInputs.directors_language
        .slice(0, 2)
        .map((item) => truncateFallbackLine(item, 120))
        .join(" | ");
      parts.push(`\nDIRECTORS LANGUAGE TO MIRROR: ${directorsLanguage}`);
    }
  }

  if (level5) {
    const snapshot = level5.company_snapshot || {};
    const topPains = (level5.pain_register || []).slice(0, 3);
    const useCases = (level5.revolut_opportunity?.recommended_use_cases || []).slice(0, 3);
    const sequenceInputs = level5.sequence_inputs || {};

    parts.push(`\nLEVEL 5 EXTRACTION (PRIORITISE THESE SIGNALS):
- Segment fit: ${snapshot.segment_fit || company.segment || "Mid-Market"}
- Operating model: ${snapshot.operating_model || analysis?.summary || "Unknown"}
- International profile: ${snapshot.international_profile || analysis?.international_exposure?.details || "Unknown"}
- Now trigger: ${sequenceInputs.now_trigger || "Latest filing context"}
- Quantified hook: ${sequenceInputs.quantified_hook || "Validate with provider-rate review"}
- Operations hook: ${sequenceInputs.operations_hook || "Operational scale signal available"}
- Governance hook: ${sequenceInputs.governance_hook || "Current setup constraints to validate"}
- Objection to pre-empt: ${sequenceInputs.objection_to_preempt || "Can run in parallel with existing credit/facility setup"}`);

    if (topPains.length > 0) {
      parts.push("\nLEVEL 5 PAIN REGISTER (use evidence + inference):");
      for (const item of topPains) {
        parts.push(`- ${item.area} [${item.severity}]: evidence="${item.evidence}" | inferred="${item.inferred_problem}"`);
      }
    }

    if (useCases.length > 0) {
      parts.push("\nLEVEL 5 PRIORITISED USE CASES:");
      for (const item of useCases) {
        parts.push(`- ${item.product} (${item.priority}): ${item.why_fit} Example: ${item.example_use_case}`);
      }
    }

    if (Array.isArray(sequenceInputs.directors_language) && sequenceInputs.directors_language.length > 0) {
      parts.push(`\nDIRECTORS LANGUAGE TO MIRROR: ${sequenceInputs.directors_language.slice(0, 2).join(" | ")}`);
    }
  }

  if (merchantSpend) {
    parts.push(`\nREVOLUT USER SPEND DATA (B2C insight — use carefully):
- Revolut users spent £${(merchantSpend.monthly_volume / 1000).toFixed(0)}K/month at this company
- ${merchantSpend.transaction_count} transactions/month from Revolut users
- Avg transaction: £${merchantSpend.avg_transaction?.toFixed(2)}
- This proves consumer demand already exists on our network
- Angle: "Your customers are already Revolut users — Revolut Pay gives you direct access to them with 9-second checkout"`);
  }

  parts.push(`\nCONTACT:
- Name: ${contact.name} (use first name "${contact.name.split(" ")[0]}" in greeting)
- Role: ${contact.role || "Director"}
- What they care about: ${persona.cares_about}
- Email tone for this persona: ${persona.tone}
- Angle: ${persona.angle}`);

  if (archetype) {
    parts.push(`\nARCHETYPE: "${archetype.name}"
- Core idea: ${archetype.description}
- Subject line formula: ${archetype.subject_formula}
- Why it converts: ${archetype.conversion_strength}`);
  }

  if (trigger) {
    parts.push(`\nPRIMARY TRIGGER: ${trigger.type} (${trigger.strength} strength)`);
    if (trigger.data?.estimated_savings) {
      parts.push(`- Use this number in the email: "~£${(trigger.data.estimated_savings / 1000).toFixed(0)}K/year in FX cost"`);
      parts.push(`- FX volume basis: £${(trigger.data.estimated_fx_volume / 1e6).toFixed(1)}M across ${trigger.data.currencies?.join("/") || "multiple currencies"}`);
    }
  }

  if (sector) {
    parts.push(`\nSECTOR INTELLIGENCE:
- Industry hook: "${sector.hook}"
- Core pain: "${sector.pain}"`);
  }

  parts.push(`\nDOSSIER TIER: ${resolvedTier}
- Tier A: full conviction sequence with provocation enabled.
- Tier B: no provocation claim, use peer benchmark instead.
- Tier C: reduced specificity, manual-review-first language.
- Tier D: do not auto-generate.`);

  if (sendCondition) {
    parts.push(`\nSEND CONDITION FOR THIS STEP: ${sendCondition}`);
  }

  if (Array.isArray(priorSteps) && priorSteps.length > 0) {
    parts.push(`\nPREVIOUS STEPS ALREADY SENT (avoid repeating these angles verbatim):`);
    for (const prior of priorSteps.slice(-3)) {
      const snippet = compactWhitespace(prior?.body || "").slice(0, 220);
      parts.push(`- Step ${prior?.step_number || "?"} (${prior?.step_type || "unknown"}): ${snippet}`);
    }
    parts.push("- This step must introduce a materially NEW dimension, not a paraphrase of prior steps.");
  }

  if (resolvedStepType === "proof") {
    parts.push(`\nEMAIL TYPE: Proof email
- Target 120-200 words for Tier A/B, 100-150 words for Tier C
- Open with a specific filing-backed observation and strategic interpretation
- Lead with business outcome language (cash, control, speed) before product mechanics
- Include one quantified lens with explicit caveat language
- Include one concise Revolut credibility anchor before the CTA
- Mirror one directors-language phrase if available
- End with a soft open question in Sophie's style`);
  } else if (resolvedStepType === "nudge_1" || resolvedStepType === "nudge_2") {
    parts.push(`\nEMAIL TYPE: Brief nudge
- 8-20 words only
- Must start "Hi [FirstName]," and end with "Best,"
- No re-pitch, no apology, no extra pleasantries
- Use different wording from the other nudge`);
  } else if (resolvedStepType === "depth") {
    parts.push(`\nEMAIL TYPE: Depth email
- 130-200 words
- Add a second insight dimension not used in Email 1
- Keep to one conviction angle, no multi-pitching
- Keep outcome-first phrasing and connect one operational metric to impact
- Open with this exact scaffold: "A second layer worth pressure-testing is this: ..."
- CTA should ask whether your read matches internal reality`);
  } else if (resolvedStepType === "provocation") {
    parts.push(`\nEMAIL TYPE: Provocation email
- 80-130 words
- Make one informed, specific claim grounded in filing evidence
- Open with this exact scaffold: "One hypothesis I may be wrong about: ..."
- Tone must be peer-level and non-aggressive
- Explicitly invite correction if your read is materially off
- Invite correction if the claim is materially off`);
  } else if (resolvedStepType === "peer_benchmark") {
    parts.push(`\nEMAIL TYPE: Peer benchmark email
- 80-130 words
- Use sector benchmark framing instead of company-specific provocation
- No high-risk assertions that require missing evidence
- Keep language observational and confidence-calibrated`);
  } else {
    parts.push(`\nEMAIL TYPE: Gracious close
- 40-70 words
- Acknowledge silence without guilt language
- Leave door open for later timing
- End warm, concise, and professional`);
  }

  if (params.inferenceData?.best_pattern) {
    parts.push(`\nINFERENCE PATTERN TO USE (adapt to this company's specifics — do NOT copy verbatim):
"${params.inferenceData.best_pattern.inference}"
This is how an insider would describe their situation. Adapt the language to match their specific data.`);
  }

  if (params.accountHealth) {
    parts.push(`\nACCOUNT HEALTH: ${params.accountHealth}
Adjust your tone accordingly. ${params.accountHealth === "loss_making" ? "Be sensitive — do NOT lead with loss. Focus on controllable costs." : params.accountHealth === "post_acquisition" ? "Frame around integration and consolidation opportunity." : params.accountHealth === "healthy_growing" ? "Be confident and forward-looking." : ""}`);
  }

  parts.push(`\nIMPORTANT REMINDERS:
- Savings estimates MUST include caveat: "(based on estimated FX volume from filed accounts; actual savings depend on your current provider's rates and would require a brief review to confirm)"
- Do NOT merely cite data. SYNTHESISE it into an insight about their business.
- The first sentence must make the prospect think "how do they know that?"
- Use industry-specific terminology (not generic business language)
- For proof/depth/provocation/benchmark steps, end with a genuine question rather than a hard meeting request
- Do NOT add sign-offs like "Best," or include sender/title lines
- Subject/header is fixed system-wide: "Revolut X [Company Name] - I've done my research"`);
  parts.push(`\nSOPHISTICATION GATE:
- For proof/depth steps include at least three concrete anchors (for example: filing detail, quantified figure, currency/jurisdiction, directors language, or named operational pattern).
- Avoid generic filler language and abstract cliches.
- Keep wording specific enough that it could not be reused for another company without rewriting.`);
  parts.push(`\nReturn raw JSON: { "subject": "...", "body": "...", "footer": "", "word_count": N, "personalisation_audit": {...}, "claims_used": [...], "disclaimers_needed": [...], "qc_self_check": "..." }`);

  return parts.join("\n");
}

function clampPromptForTokenSafety(prompt) {
  const text = String(prompt || "");
  if (!text) return text;
  if (text.length <= EMAIL_LLM_MAX_PROMPT_CHARS) return text;

  const headBudget = Math.floor(EMAIL_LLM_MAX_PROMPT_CHARS * 0.76);
  const tailBudget = Math.max(900, EMAIL_LLM_MAX_PROMPT_CHARS - headBudget - 160);
  const head = text.slice(0, headBudget).trimEnd();
  const tail = text.slice(-tailBudget).trimStart();

  return `${head}\n\n[Context truncated for prompt size safety]\n\n${tail}`;
}

function truncateFallbackLine(value, maxLength = 220) {
  const normalized = compactWhitespace(value);
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;

  const sliced = normalized.slice(0, maxLength);
  const boundary = sliced.lastIndexOf(" ");
  const trimmed = (boundary > 60 ? sliced.slice(0, boundary) : sliced).trim();
  return `${trimmed}...`;
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const token = compactWhitespace(value);
    if (token) return token;
  }
  return "";
}

function productOutcomeHint(product) {
  const label = compactWhitespace(product).toLowerCase();
  if (!label) return "reduce controllable cost and workflow friction in treasury execution";
  if (label.includes("fx forwards") || label.includes("fx forward")) {
    return "lock procurement rates in advance and reduce P&L volatility";
  }
  if (label === "fx" || label.includes(" fx") || label.startsWith("fx")) {
    return "reduce spread leakage on cross-currency flows and improve rate transparency";
  }
  if (label.includes("merchant") || label.includes("revolut pay")) {
    return "lower acceptance cost and accelerate settlement on customer receipts";
  }
  if (label.includes("cards") || label.includes("spend")) {
    return "tighten spend controls while reducing reconciliation lag across sites";
  }
  if (label.includes("api")) {
    return "automate treasury and reconciliation workflows across entities";
  }
  return "reduce controllable cost and workflow friction in treasury execution";
}

function deriveFallbackSignals(analysis = {}, company = {}, trigger = null) {
  const sequenceInputs = analysis?.level5_extraction?.sequence_inputs || {};
  const firstTheme = (analysis?.themes || [])[0] || {};
  const firstPainIndicator = (analysis?.pain_indicators || [])[0] || {};
  const firstPainRegister = (analysis?.level5_extraction?.pain_register || [])[0] || {};
  const primaryUseCase = pickPrimaryUseCase(analysis);
  const useCaseProduct = compactWhitespace(primaryUseCase?.product || trigger?.type || "");

  const observationRaw = firstNonEmptyText(
    sequenceInputs.now_trigger,
    firstTheme.evidence,
    firstTheme.theme,
    analysis?.international_exposure?.details,
    analysis?.summary
  );

  const observation = ensureSentence(
    truncateFallbackLine(observationRaw, 240),
    `${company.name || "This business"} appears to be balancing growth with tighter execution requirements in the latest filing`
  );

  const painRaw = firstNonEmptyText(
    firstPainRegister.inferred_problem,
    firstPainIndicator.pain,
    firstPainIndicator.evidence,
    sequenceInputs.operations_hook
  );

  const pain = ensureSentence(
    truncateFallbackLine(painRaw, 240),
    "That usually creates avoidable cost, delay, or reconciliation drag for the finance team"
  );

  const turnover = Number(company?.turnover || 0);
  const fallbackQuantified = turnover > 0
    ? `With turnover around ${formatPounds(turnover)}, even modest basis-point leakage on payments or FX execution can compound quickly`
    : "";
  const quantifiedHookRaw = firstNonEmptyText(sequenceInputs.quantified_hook, fallbackQuantified);
  const quantifiedHook = quantifiedHookRaw
    ? `${ensureSentence(truncateFallbackLine(quantifiedHookRaw, 230))} (inference from filed data; exact impact depends on current provider economics).`
    : "";

  const valueReason = firstNonEmptyText(primaryUseCase?.why_fit, primaryUseCase?.example_use_case);
  const valuePath = ensureSentence(
    truncateFallbackLine(
      useCaseProduct
        ? `${useCaseProduct} looks highest-leverage here because ${valueReason || productOutcomeHint(useCaseProduct)}`
        : `A scoped first step here could ${productOutcomeHint(useCaseProduct)}`,
      250
    ),
    "A scoped first step can usually run in parallel with your current setup before broader change"
  );

  const operationsHook = ensureSentence(
    truncateFallbackLine(
      firstNonEmptyText(sequenceInputs.operations_hook, firstPainRegister.evidence, firstPainIndicator.evidence),
      220
    ),
    "Execution consistency across entities and banking lanes is often where hidden cost appears"
  );

  const governanceHook = ensureSentence(
    truncateFallbackLine(firstNonEmptyText(sequenceInputs.governance_hook, firstTheme.evidence), 220),
    "Strategy intent and day-to-day treasury execution can drift as organisations scale"
  );

  const directorsLanguage = Array.isArray(sequenceInputs.directors_language)
    ? truncateFallbackLine(sequenceInputs.directors_language[0], 150)
    : "";

  return {
    observation,
    pain,
    quantifiedHook,
    valuePath,
    operationsHook,
    governanceHook,
    directorsLanguage,
    useCaseProduct,
  };
}

function fallbackQuestionForContext(stepType, signals = {}) {
  const product = compactWhitespace(signals.useCaseProduct || "this lane").toLowerCase();

  if (stepType === "proof") {
    return `Would it be useful to benchmark ${product} economics against your current setup?`;
  }
  if (stepType === "depth") {
    return "Does this match what your team is seeing internally, or is the bottleneck elsewhere?";
  }
  if (stepType === "provocation") {
    return "Is that read directionally fair, or am I missing something material?";
  }
  if (stepType === "peer_benchmark") {
    return "Would a one-page benchmark be useful to pressure-test this against peers?";
  }
  return "Would it help if I shared the assumptions behind that view?";
}

function generateFallbackEmail(params) {
  const {
    company,
    contact,
    archetype,
    analysis,
    trigger,
    stepNumber,
    totalSteps,
    stepType,
    dossierTier,
  } = params;
  const firstName = contact.name?.split(" ")[0] || "there";

  const subject = buildResearchHeaderSubject(company.name || "Company");
  let body;

  const resolvedStepType = stepType
    || (stepNumber === 1 ? "proof" : stepNumber === totalSteps ? "close" : "depth");

  const signals = deriveFallbackSignals(analysis, company, trigger);
  const industryLabel = compactWhitespace(company?.industry || "mid-market").toLowerCase();
  const mirrorsDirectorsLanguage = signals.directorsLanguage
    ? `Using directors' own language, "${signals.directorsLanguage}", the execution risk usually sits in consistency rather than intent.`
    : "Execution risk usually sits in consistency rather than intent once operations scale.";

  if (resolvedStepType === "nudge_1") {
    body = `Hi ${firstName}, should I send the one-page benchmark? Best,`;
  } else if (resolvedStepType === "nudge_2") {
    body = `Hi ${firstName}, close this out, or send assumptions? Best,`;
  } else if (resolvedStepType === "proof") {
    body = `Hi ${firstName},\n\nReading your latest filing, ${signals.observation.charAt(0).toLowerCase()}${signals.observation.slice(1)}\n\n${signals.pain} ${signals.quantifiedHook}\n\n${signals.valuePath}\n\n${fallbackQuestionForContext("proof", signals)}`;
  } else if (resolvedStepType === "depth") {
    body = `Hi ${firstName},\n\nA second layer worth pressure-testing is this: ${signals.operationsHook.charAt(0).toLowerCase()}${signals.operationsHook.slice(1)}\n\n${mirrorsDirectorsLanguage}\n\n${signals.valuePath}\n\n${fallbackQuestionForContext("depth", signals)}`;
  } else if (resolvedStepType === "provocation") {
    body = `Hi ${firstName},\n\nOne hypothesis I may be wrong about: ${signals.governanceHook.charAt(0).toLowerCase()}${signals.governanceHook.slice(1)}\n\nIf that read is materially off, I value the correction.\n\n${fallbackQuestionForContext("provocation", signals)}`;
  } else if (resolvedStepType === "peer_benchmark") {
    body = `Hi ${firstName},\n\nAcross comparable ${industryLabel} teams, the pattern is to hold core banking relationships in place while isolating high-friction payment and FX lanes for cost and control improvements.\n\n${signals.valuePath}\n\n${fallbackQuestionForContext("peer_benchmark", signals)}`;
  } else {
    body = `Hi ${firstName},\n\nI'll leave it there for now. If this becomes a priority this quarter, I can share a short benchmark note focused on ${signals.useCaseProduct || "the highest-friction treasury lane"} and the assumptions behind it.\n\nBest,\nSophie Louise Penrose`;
  }

  const isNudgeStep = resolvedStepType === "nudge_1" || resolvedStepType === "nudge_2";
  if (!isNudgeStep) {
    body = enforceFindingsToEmailStructure(body, {
      analysis,
      companyName: company.name || "Company",
      stepNumber,
      totalSteps,
      stepType: resolvedStepType,
      stakeholderName: contact.name,
    });
  }

  const qcResult = validateEmail(
    { subject, body },
    {
      isInitialOutreach: stepNumber === 1,
      stepType: resolvedStepType,
      assumeManagedFooter: true,
      footerTemplate: MANDATORY_OUTREACH_FOOTER,
    }
  );

  return {
    subject,
    body,
    footer: "",
    archetype: archetype?.id || "diagnostic_filing",
    trigger_type: null,
    qc_score: qcResult.score,
    qc_pass: qcResult.pass,
    qc_issues: qcResult.issues,
    metrics: qcResult.metrics,
    quality_gates: qcResult.gates,
    voice_percent: qcResult.metrics?.voice_percent ?? null,
    claims_used: [],
    disclaimers_needed: [2],
    source: "fallback",
    step_type: resolvedStepType,
    dossier_tier: dossierTier || "B",
  };
}

export async function generateFullSequence(params) {
  const {
    company,
    contact,
    analysis,
    score,
    motion,
    merchantSpend,
    preferredCadence,
    styleProfile,
  } = params;
  const normalizedStyleProfile = normalizeEmailStyleProfile(styleProfile);

  const exclusion = isCompanyExcluded(company, analysis);
  if (exclusion.excluded) {
    return { error: `Company excluded: ${exclusion.reason}`, excluded: true };
  }

  const triggers = detectTriggers(company, analysis, score);
  const archetype = selectArchetype(triggers, analysis, company);
  const senderName = sanitizeSenderName(getSetting("sender_name", DEFAULT_SENDER_NAME));
  const senderTitle = sanitizeSenderTitle(getSetting("sender_title", DEFAULT_SENDER_TITLE));

  const cadence = determineCadence(triggers, contact, merchantSpend, preferredCadence, analysis, score);
  if (cadence.error) {
    return {
      error: cadence.error,
      excluded: false,
      dossier_tier: cadence.dossier_tier,
      needs_enrichment: true,
      detail: cadence.detail,
    };
  }

  const steps = [];
  const blueprint = Array.isArray(cadence.blueprint) ? cadence.blueprint : [];

  for (let i = 0; i < cadence.steps; i++) {
    const plan = blueprint[i] || {
      stepType: i === 0 ? "proof" : i === cadence.steps - 1 ? "close" : "depth",
      day: cadence.delays[i] || 0,
      sendCondition: "always",
    };

    const stepParams = {
      company,
      contact,
      analysis,
      score,
      archetype,
      trigger: triggers[0] || null,
      senderName,
      senderTitle,
      stepNumber: i + 1,
      totalSteps: cadence.steps,
      merchantSpend: null,
      stepType: plan.stepType,
      sendCondition: plan.sendCondition,
      dossierTier: cadence.dossier_tier,
      styleProfile: normalizedStyleProfile,
      priorSteps: steps.map((s) => ({
        step_number: s.step_number,
        step_type: s.step_type,
        body: s.body,
      })),
    };

    const email = await generateLLMEmail(stepParams);
    steps.push({
      step_number: i + 1,
      send_delay_days: plan.day,
      step_type: plan.stepType,
      send_condition: plan.sendCondition,
      requires_manual_review: 1,
      review_status: "pending",
      ...email,
    });
  }

  const distinctSteps = enforceStepDistinctiveness(steps, analysis);
  const structuredSteps = enforceFindingsAcrossSteps(distinctSteps, {
    analysis,
    companyName: company?.name || "Company",
    totalSteps: cadence.steps,
  });
  const stepsWithHeader = enforceResearchHeaderSubject(structuredSteps, company?.name || "Company");

  return {
    archetype: archetype.id,
    archetype_name: archetype.name,
    triggers,
    cadence,
    dossier_tier: cadence.dossier_tier,
    style_profile_applied: !!(normalizedStyleProfile && normalizedStyleProfile.enabled),
    style_profile_name: normalizedStyleProfile?.name || null,
    steps: stepsWithHeader,
    exclusion_check: { excluded: false },
    merchant_spend_included: false,
  };
}

function determineCadence(triggers, contact, merchantSpend, preferredCadence, analysis, score) {
  if (preferredCadence?.steps) {
    const stepCount = Math.max(3, Math.min(6, Number.parseInt(String(preferredCadence.steps), 10) || 3));
    const fallbackDelays = [0, 3, 6, 9, 11, 14];
    const provided = Array.isArray(preferredCadence.delays) ? preferredCadence.delays : [];
    const delays = [];
    for (let i = 0; i < stepCount; i++) {
      const raw = Number.parseInt(String(provided[i] ?? fallbackDelays[i] ?? 0), 10);
      delays.push(Number.isFinite(raw) && raw >= 0 ? raw : 0);
    }

    const fallbackStepTypes = ["proof", "nudge_1", "depth", "nudge_2", "provocation", "close"];
    const providedStepTypes = Array.isArray(preferredCadence.step_types) ? preferredCadence.step_types : [];
    const providedConditions = Array.isArray(preferredCadence.send_conditions) ? preferredCadence.send_conditions : [];
    const blueprint = delays.map((day, idx) => ({
      stepType: String(providedStepTypes[idx] || fallbackStepTypes[idx] || "depth"),
      day,
      sendCondition: String(providedConditions[idx] || "always"),
    }));

    return {
      steps: stepCount,
      delays,
      blueprint,
      dossier_tier: String(preferredCadence.dossier_tier || "B").toUpperCase(),
      strategy: preferredCadence.strategy || "custom",
    };
  }

  const tierDecision = classifyDossierTier(analysis, score, contact);
  if (tierDecision.tier === "D") {
    return {
      error: "Insufficient dossier quality for auto-generation. Add enrichment before sequence creation.",
      dossier_tier: "D",
      detail: tierDecision.metrics,
    };
  }

  let blueprint;
  if (tierDecision.tier === "A") {
    blueprint = V7_TIER_A_BLUEPRINT;
  } else if (tierDecision.tier === "B") {
    blueprint = V7_TIER_B_BLUEPRINT;
  } else {
    blueprint = V7_TIER_C_BLUEPRINT;
  }

  const delays = blueprint.map((step) => step.day);

  return {
    steps: blueprint.length,
    delays,
    blueprint,
    strategy: `v7_tier_${tierDecision.tier.toLowerCase()}`,
    dossier_tier: tierDecision.tier,
    tier_metrics: tierDecision.metrics,
  };
}
