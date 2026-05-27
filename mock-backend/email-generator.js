/**
 * LLM-powered email generation with full Revolut Business briefing context.
 * Generates QC-compliant, archetype-driven, persona-specific email sequences.
 */

import { validateEmail, APPROVED_CLAIMS, isCompanyExcluded } from "./email-qc.js";
import { detectTriggers, selectArchetype, getPersonaGuidance, getSectorAngle, COMPETITOR_DISPLACEMENT } from "./email-archetypes.js";
import { SYSTEM_PROMPT, selectInferencePattern, detectAccountHealth } from "./email-system-prompt.js";
import { getSetting } from "./db.js";

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
    || lower.includes("example")
    || lower === "changeme"
    || lower === "change_me";
  return looksPlaceholder ? null : key;
}

const OPENAI_API_KEY = resolveConfiguredSecret(process.env.OPENAI_API_KEY);
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
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
  const source = String(body || "").trim();
  if (/Observation\s*(?:&|and)\s*Origin:/i.test(source)
    && /Main\s+Pain\s+Link:/i.test(source)
    && /Value\s+Path(?:\s*\(Suggestions\))?:/i.test(source)) {
    return source;
  }

  const analysis = context.analysis || {};
  const level5 = analysis.level5_extraction || {};
  const sequenceInputs = level5.sequence_inputs || {};
  const topPain = (level5.pain_register || [])[0] || (analysis.pain_indicators || [])[0] || null;
  const topUseCase = pickPrimaryUseCase(analysis);
  const secondUseCase = (level5.revolut_opportunity?.recommended_use_cases || [])[1] || (analysis.opportunities || [])[1] || null;
  const painSnippet = (analysis?.evidence_snippets?.pains || [])[0] || null;
  const fitSnippet = (analysis?.evidence_snippets?.suitability || [])[0] || null;
  const stepNumber = Number.parseInt(String(context.stepNumber || 1), 10) || 1;

  const originalLines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const openingLine = normalizeObservationLine(originalLines[0] || "");
  const originSignal = sequenceInputs.now_trigger || topPain?.evidence || painSnippet?.quote || analysis.summary;
  let observationSeed = openingLine || originSignal;
  if (isTurnoverLedObservation(observationSeed) && originSignal && !isTurnoverLedObservation(originSignal)) {
    observationSeed = originSignal;
  }
  const existingQuestion = extractLastQuestion(source);

  const observation = ensureSentence(
    observationSeed,
    `${context.companyName || "This account"} has a live finance execution signal in the latest filing`
  );

  const origin = ensureSentence(
    painSnippet?.quote || topPain?.evidence || fitSnippet?.quote || analysis.summary,
    "This view comes directly from language in your latest filing and operating disclosures"
  );

  const painLink = ensureSentence(
    topPain?.inferred_problem || topPain?.pain || sequenceInputs.operations_hook || analysis.recommended_approach,
    "That likely maps to avoidable cost, delay, or reconciliation drag if left unvalidated"
  );

  let valuePathSeed = sequenceInputs.objection_to_preempt
    || "A scoped test can run in parallel with your current setup and credit arrangements";

  if (topUseCase) {
    valuePathSeed = `Start with ${topUseCase.product || "one high-confidence workflow fix"} because ${topUseCase.why_fit || topUseCase.rationale || "it can be validated quickly without forcing a broad migration"}.`;
  }
  if (secondUseCase && stepNumber >= 2) {
    valuePathSeed += ` Then layer ${secondUseCase.product || "the next adjacent motion"} once the first step is proven.`;
  }
  if (stepNumber >= 3) {
    valuePathSeed += " Keep scope tight initially: one lane, one owner, one measurement loop.";
  }

  const valuePath = ensureSentence(
    valuePathSeed,
    "A scoped Revolut Business comparison can run in parallel with your current setup"
  );

  const question = ensureSentence(
    existingQuestion || fallbackQuestionForStep(context.stepNumber, context.totalSteps),
    "Would it be useful if I shared the assumptions behind that view"
  ).replace(/\.$/, "?");

  return [
    `Observation & Origin: ${observation} Origin evidence: ${origin}`,
    `Main Pain Link: ${painLink}`,
    `Value Path (Suggestions): ${valuePath}`,
    question,
  ].join("\n\n").trim();
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

function stripSignatureAndFooterForYamm(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\[(?:Your\s+Name|AE_NAME|Your\s+Title|AE_TITLE)\]/gi, "").trimEnd());

  const isLegalLine = (line) => /^(To manage your sales outreach preferences|Any information provided does not constitute)/i.test(line.trim());
  const isSignatureLine = (line) => /^(Best|Thanks|Kind regards|Regards|Sincerely|Cheers|Many thanks)[,!\.\s-]*$/i.test(line.trim())
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
    if (/^[A-Za-z][A-Za-z'\.-]*(?:\s+[A-Za-z][A-Za-z'\.-]*){0,3}$/.test(candidate)) {
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

function enforceStepDistinctiveness(steps, analysis = {}) {
  const openerFallbacks = getDistinctStepOpeners(analysis);
  const closerFallbacks = getDistinctStepClosers();
  const seenOpeners = [];
  const seenClosers = [];

  return (steps || []).map((step, idx) => {
    const body = String(step.body || "").trim();
    if (!body) return step;

    const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return step;

    const opening = paragraphs[0];
    const closing = paragraphs[paragraphs.length - 1];

    const openingIsRepetitive = seenOpeners.some((prev) => jaccardSimilarity(prev, opening) >= 0.72);
    if (openingIsRepetitive) {
      paragraphs[0] = openerFallbacks[Math.min(idx, openerFallbacks.length - 1)];
    }

    const closingIsRepetitive = seenClosers.some((prev) => jaccardSimilarity(prev, closing) >= 0.75)
      || /curious how (?:your|the) team currently manages/i.test(closing);
    if (closingIsRepetitive || !/[?]$/.test(closing)) {
      paragraphs[paragraphs.length - 1] = closerFallbacks[Math.min(idx, closerFallbacks.length - 1)];
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

function postProcessGeneratedEmail(parsed, context = {}) {
  const {
    companyName,
    senderName,
    senderTitle,
    analysis,
    companyTurnover,
    stepNumber,
    totalSteps,
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
  body = enforceFindingsToEmailStructure(body, {
    analysis,
    companyName,
    stepNumber,
    totalSteps,
  });

  return {
    subject,
    body,
    footer: "",
    claims_used: Array.isArray(parsed?.claims_used) ? parsed.claims_used : [],
    disclaimers_needed: Array.isArray(parsed?.disclaimers_needed) ? parsed.disclaimers_needed : [],
  };
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
  const { company, contact, analysis, score, archetype, trigger, senderName, senderTitle, stepNumber, totalSteps } = params;
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
  const userPrompt = buildUserPrompt({
    ...enrichedParams,
    senderName: resolvedSenderName,
    senderTitle: resolvedSenderTitle,
  }, persona, sector, displacement);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        disableEmailLlmDueToAuth(response.status);
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
      return generateFallbackEmail({
        ...params,
        senderName: resolvedSenderName,
        senderTitle: resolvedSenderTitle,
      });
    }

    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    const normalized = postProcessGeneratedEmail(parsed, {
      companyName: company.name || "Company",
      senderName: resolvedSenderName,
      senderTitle: resolvedSenderTitle,
      analysis,
      companyTurnover: company.turnover,
      stepNumber,
      totalSteps,
    });

    const qcResult = validateEmail(
      { subject: normalized.subject, body: normalized.body },
      { isInitialOutreach: stepNumber === 1 }
    );

    return {
      subject: normalized.subject,
      body: normalized.body,
      footer: normalized.footer,
      archetype: archetype?.id || "diagnostic_filing",
      trigger_type: trigger?.type || null,
      qc_score: qcResult.score,
      qc_pass: qcResult.pass,
      qc_issues: qcResult.issues,
      metrics: qcResult.metrics,
      claims_used: normalized.claims_used,
      disclaimers_needed: normalized.disclaimers_needed,
      source: "llm",
      model: OPENAI_MODEL,
    };
  } catch (err) {
    console.error("Email generation LLM error:", err.message);
    return generateFallbackEmail({
      ...params,
      senderName: resolvedSenderName,
      senderTitle: resolvedSenderTitle,
    });
  }
}

function buildUserPrompt(params, persona, sector, displacement) {
  const { company, contact, analysis, score, archetype, trigger, stepNumber, totalSteps, merchantSpend } = params;
  const level5 = analysis?.level5_extraction || null;

  const parts = [`Generate email step ${stepNumber} of ${totalSteps} for this prospect.

CRITICAL INSTRUCTION: This email MUST reference specific facts from the company data below. Every paragraph should contain a verifiable observation. Do NOT write generic copy. Show proof-of-research by citing:
- Specific countries they operate in
- Specific currencies they trade in
- Specific financial figures or trends from their filing
- Specific pain points unique to THIS company
- Named competitors detected in their setup

The "proof of research" principle: the prospect should think "how do they know that?" within the first 2 sentences.`];

  parts.push(`\nFORMAT REQUIREMENT:
- The body MUST follow this structure with blank lines between each section:
  1) Observation & Origin: <specific observation + where this came from>
  2) Main Pain Link: <explicit link to principal finance/ops pain>
  3) Value Path (Suggestions): <1-2 practical ways to address, sequenced>
  4) <one calibrated question ending with ?>
- Do NOT lead with turnover-only framing; lead with operational filing context first.
- Do NOT include a signature block, sender name, sender title, website link, or compliance footer in the body.
- End cleanly on the closing question. Signature is added at send time via YAMM.`);

  parts.push(`\nINTERNAL REVOLUT SEQUENCE POLICY:
- Lead with high-priority motions when evidence supports them: ${INTERNAL_LEAD_WITH_MOTIONS.join(", ")}.
- Do NOT lead with these unless evidence is explicit and urgent: ${INTERNAL_DO_NOT_LEAD_WITH.join(", ")}.
- If multiple opportunities exist, choose one primary motion for this step and keep the email single-threaded.`);

  parts.push(`\nCOMPANY FACTS (USE THESE SPECIFICALLY — do not generalise):
- Company name: ${company.name}
- Annual turnover: £${company.turnover ? (company.turnover / 1e6).toFixed(1) + "M" : "Unknown"}
- Employees: ${company.employee_count || "Unknown"}
- Industry: ${company.industry || "Unknown"}
- Segment: ${company.segment || "Mid-Market"}`);

  if (analysis?.summary) {
    parts.push(`- LLM summary: "${analysis.summary}"`);
  }

  if (analysis?.international_exposure?.present) {
    parts.push(`- International operations: ${analysis.international_exposure.details}`);
    if (analysis.international_exposure.currencies?.length) {
      parts.push(`- Currencies traded: ${analysis.international_exposure.currencies.join(", ")}`);
      const vol = company.turnover * (analysis.international_exposure.currencies.length > 2 ? 0.5 : 0.3);
      parts.push(`- Estimated annual FX volume: ~£${(vol / 1e6).toFixed(0)}M`);
      parts.push(`- Estimated FX cost at bank rates (1.5%): ~£${(vol * 0.015 / 1000).toFixed(0)}K/year`);
      parts.push(`- Estimated saving on interbank: ~£${(vol * 0.012 / 1000).toFixed(0)}K/year`);
    }
  }

  if (analysis?.turnover_trend) {
    parts.push(`- Revenue trend: ${analysis.turnover_trend}${score?.growth?.rate ? ` (${(score.growth.rate * 100).toFixed(0)}% YoY)` : ""}`);
  }

  if (analysis?.themes?.length > 0) {
    parts.push(`\nKEY THEMES FROM FILING (reference at least one):`);
    for (const t of analysis.themes) {
      parts.push(`- ${t.theme}: "${t.evidence}"`);
    }
  }

  if (analysis?.pain_indicators?.length > 0) {
    parts.push(`\nSPECIFIC PAIN POINTS (weave one into the email):`);
    for (const p of analysis.pain_indicators) {
      parts.push(`- [${p.severity}] ${p.pain}: "${p.evidence}"`);
    }
  }

  if (analysis?.opportunities?.length > 0) {
    parts.push(`\nPRODUCT OPPORTUNITIES IDENTIFIED:`);
    for (const o of analysis.opportunities) {
      parts.push(`- ${o.product} [${o.confidence} confidence]: "${o.rationale}"`);
    }
  }

  if (analysis?.competitors_detected?.length > 0) {
    parts.push(`\nCOMPETITORS DETECTED IN THEIR SETUP:`);
    for (const c of analysis.competitors_detected) {
      const disp = COMPETITOR_DISPLACEMENT[c.name];
      parts.push(`- ${c.name} (${c.product}): weakness = "${disp?.weakness || c.displacement_angle}"`);
      if (disp) parts.push(`  Approved angle: "${disp.angle}"`);
    }
  }

  if (analysis?.key_people?.length > 0) {
    parts.push(`\nKEY PEOPLE FROM FILING: ${analysis.key_people.map(p => `${p.name} (${p.role})`).join(", ")}`);
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

  if (totalSteps === 3) {
    if (stepNumber === 1) {
      parts.push(`\nEMAIL TYPE: Compact 3-step sequence - filing insight
- 75–110 words max
- Focus on one evidence-backed insight from filing
- Do NOT include savings estimate
- No competitor naming in this first message
- End with a continuation invitation, not a meeting ask`);
    } else if (stepNumber === 2) {
      parts.push(`\nEMAIL TYPE: Compact 3-step sequence - quantified operational angle
- 80–120 words
- Introduce one quantified gap with caveat language
- Add one approved claim only
- Keep single product motion focus
- Offer methodology instead of meeting request`);
    } else {
      parts.push(`\nEMAIL TYPE: Compact 3-step sequence - governance/close
- 60–95 words
- Link structural setup to practical risk or execution drag
- Include calibrated confidence and objection pre-emption
- Close gracefully with open door language`);
    }
  } else if (stepNumber === 1) {
    parts.push(`\nEMAIL TYPE: Cold initial outreach
- 75–110 words max
- Must mention "Revolut Business" once (not just "Revolut")
- Open with a SPECIFIC observation from their filing that shows you've done the work
- The first sentence must contain a fact unique to this company (country, currency, figure)
- Subject is fixed by the system to a research-header format, so focus all variation in the body.`);
  } else if (stepNumber === totalSteps) {
    parts.push(`\nEMAIL TYPE: Breakup email
- 40–80 words
- Gracious, acknowledge silence without guilt
- Reference a specific data point you shared earlier (FX savings figure, currency corridors)
- Leave the specific benchmark/insight in their inbox as standalone value
- End with well-wishes, no pressure`);
  } else if (merchantSpend && stepNumber === 2) {
    parts.push(`\nEMAIL TYPE: Revolut user spend insight (unique value-add)
- 80–120 words
- Lead with the merchant spend data: their customers are already Revolut users
- Frame as insight they can't get elsewhere
- Tie to Revolut Pay (9-second checkout, 70M+ retail users)
- This is a "proof of demand" email — show them revenue they're leaving on the table`);
  } else {
    const angles = [
      "Share a peer benchmark or case study from their industry",
      "Use the competitor displacement angle — name the incumbent and its specific weakness",
      "Quantify the ROI: calculate their specific £ saving based on their FX volume",
      "Reference a different pain point from the filing than Step 1 used",
    ];
    const angleIdx = Math.min(stepNumber - 2, angles.length - 1);
    parts.push(`\nEMAIL TYPE: Follow-up ${stepNumber - 1} (value-add, not bump)
- 60–120 words
- ANGLE FOR THIS STEP: ${angles[angleIdx]}
- Must add NEW information not in previous steps
- NEVER say "just checking in", "following up", "bumping this"
- Lead with value, ask permission second`);
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
- End with a genuine question, not a meeting request
- Do NOT add sign-offs like "Best," or include sender/title lines
- Subject/header is fixed system-wide: "Revolut X [Company Name] - I've done my research"`);
  parts.push(`\nReturn raw JSON: { "subject": "...", "body": "...", "footer": "", "word_count": N, "personalisation_audit": {...}, "claims_used": [...], "disclaimers_needed": [...], "qc_self_check": "..." }`);

  return parts.join("\n");
}

function generateFallbackEmail(params) {
  const { company, contact, archetype, analysis, stepNumber, totalSteps } = params;
  const firstName = contact.name?.split(" ")[0] || "there";

  const subject = buildResearchHeaderSubject(company.name || "Company");
  let body;

  if (stepNumber === 1) {
    body = `Hi ${firstName},\n\nI came across ${company.name}'s latest filing and noticed your international operations. At your turnover, there's often meaningful FX cost sitting in the payment flow that compresses significantly at interbank rates (during market hours within plan allowance).\n\nWould it make sense to compare your current rates against what we're seeing for similar businesses?`;
  } else if (stepNumber === totalSteps) {
    body = `Hi ${firstName},\n\nHaven't heard back, so I'll assume the timing isn't right.\n\nIf international payments or FX becomes a priority in the next few months, I can share a benchmark whenever helpful.`;
  } else {
    body = `Hi ${firstName},\n\nAdding a quick data point — businesses at ${company.name}'s size that move to interbank FX pricing (during market hours within plan allowance) typically see their payment costs compress by a meaningful amount.\n\nHappy to share a specific comparison if useful?`;
  }

  body = enforceFindingsToEmailStructure(body, {
    analysis,
    companyName: company.name || "Company",
    stepNumber,
    totalSteps,
  });

  const qcResult = validateEmail({ subject, body }, { isInitialOutreach: stepNumber === 1 });

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
    claims_used: [],
    disclaimers_needed: [2],
    source: "fallback",
  };
}

export async function generateFullSequence(params) {
  const { company, contact, analysis, score, motion, merchantSpend, preferredCadence } = params;

  const exclusion = isCompanyExcluded(company, analysis);
  if (exclusion.excluded) {
    return { error: `Company excluded: ${exclusion.reason}`, excluded: true };
  }

  const triggers = detectTriggers(company, analysis, score);
  const archetype = selectArchetype(triggers, analysis, company);
  const senderName = sanitizeSenderName(getSetting("sender_name", DEFAULT_SENDER_NAME));
  const senderTitle = sanitizeSenderTitle(getSetting("sender_title", DEFAULT_SENDER_TITLE));

  const cadence = determineCadence(triggers, contact, merchantSpend, preferredCadence);
  const steps = [];

  for (let i = 0; i < cadence.steps; i++) {
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
      merchantSpend: cadence.merchantSpendStep === (i + 1) ? merchantSpend : null,
    };

    const email = await generateLLMEmail(stepParams);
    steps.push({
      step_number: i + 1,
      send_delay_days: cadence.delays[i] || 0,
      step_type: cadence.merchantSpendStep === (i + 1) ? "merchant_spend_insight" : (i === 0 ? "initial" : i === cadence.steps - 1 ? "breakup" : "follow_up"),
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
    steps: stepsWithHeader,
    exclusion_check: { excluded: false },
    merchant_spend_included: !!merchantSpend,
  };
}

function determineCadence(triggers, contact, merchantSpend, preferredCadence) {
  if (preferredCadence?.steps) {
    const stepCount = Math.max(3, Math.min(5, Number.parseInt(String(preferredCadence.steps), 10) || 3));
    const fallbackDelays = [0, 3, 7, 12, 15];
    const provided = Array.isArray(preferredCadence.delays) ? preferredCadence.delays : [];
    const delays = [];
    for (let i = 0; i < stepCount; i++) {
      const raw = Number.parseInt(String(provided[i] ?? fallbackDelays[i] ?? 0), 10);
      delays.push(Number.isFinite(raw) && raw >= 0 ? raw : 0);
    }
    return {
      steps: stepCount,
      delays,
      strategy: preferredCadence.strategy || "custom",
    };
  }

  const hasHighTrigger = triggers.some((t) => t.strength === "high");

  let cadence;
  if (hasHighTrigger) {
    cadence = { steps: 4, delays: [0, 3, 7, 12], strategy: "aggressive" };
  } else if (triggers.some((t) => t.strength === "medium")) {
    cadence = { steps: 3, delays: [0, 4, 10], strategy: "standard" };
  } else {
    cadence = { steps: 3, delays: [0, 5, 12], strategy: "nurture" };
  }

  if (merchantSpend && merchantSpend.monthly_volume > 0) {
    cadence.steps += 1;
    cadence.delays.splice(1, 0, 2);
    cadence.merchantSpendStep = 2;
    cadence.strategy += "+merchant_insight";
  }

  return cadence;
}
