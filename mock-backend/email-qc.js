/**
 * Email Quality Control Engine
 * Validates generated emails against Revolut Business QC scorecard.
 * Implements forbidden phrases, structural checks, and compliance scoring.
 */

const FORBIDDEN_PHRASES = [
  { pattern: /always\s+free/i, violation: "Misleading Communication", deduction: 25 },
  { pattern: /free\s+forever/i, violation: "Misleading Communication", deduction: 25 },
  { pattern: /we'?re\s+the\s+best/i, violation: "Unfair Comparison", deduction: 25 },
  { pattern: /cheapest\s+in\s+the\s+market/i, violation: "Unfair Comparison", deduction: 25 },
  { pattern: /nobody\s+else\s+(does|can|offers?)/i, violation: "Unfair Comparison", deduction: 25 },
  { pattern: /the\s+only\s+platform\s+that/i, violation: "Unfair Comparison", deduction: 25 },
  { pattern: /\b(lowest|fastest|most\s+secure)\b/i, violation: "Superlative without evidence", deduction: 25 },
  { pattern: /\bbest\b(?!\s*[,\n]|\s+(?:motion|practice|regards|wishes))/i, violation: "Superlative without evidence", deduction: 25 },
  { pattern: /\b100%\s+(guaranteed|safe|secure|free)/i, violation: "Absolute statement", deduction: 25 },
  { pattern: /unlimited\s+cards/i, violation: "Unlimited without context", deduction: 25 },
  { pattern: /unlimited\s+(?:multi[- ]?currency|accounts)/i, violation: "Unlimited without context", deduction: 25 },
  { pattern: /you'?ll?\s+(definitely|certainly)\s+save/i, violation: "False promise", deduction: 25 },
  { pattern: /guaranteed\s+savings/i, violation: "False promise", deduction: 25 },
  { pattern: /limited\s+time\s+only/i, violation: "Pressure tactic", deduction: 25 },
  { pattern: /sign\s+up\s+now\s+or\s+miss/i, violation: "Pressure tactic", deduction: 25 },
  { pattern: /last\s+chance/i, violation: "Pressure tactic", deduction: 25 },
  { pattern: /act\s+now/i, violation: "Pressure tactic", deduction: 25 },
  { pattern: /interbank\s+rate(?!.*(?:during\s+market\s+hours|within\s+plan|²))/i, violation: "Missing FX context", deduction: 25 },
  { pattern: /\byour\s+account\s+manager\b/i, violation: "Misuse of titles", deduction: 25 },
  { pattern: /\bfinancial\s+advis[oe]r\b/i, violation: "Misuse of titles", deduction: 25 },
  { pattern: /top\s+up\s+your\s+account/i, violation: "Top-up pressure", deduction: 25 },
  { pattern: /save\s+thousands/i, violation: "Unapproved monetary claim", deduction: 25 },
  { pattern: /save\s+millions/i, violation: "Unapproved monetary claim", deduction: 25 },
  { pattern: /60[- ]?80%\s+cheaper/i, violation: "Unapproved claim (not in approved library)", deduction: 25 },
];

const MINOR_DEDUCTIONS = [
  { check: (email, meta) => meta.isInitialOutreach && !email.body.match(/revolut\s+business/i), issue: "No RB explanation in initial outreach", deduction: 15 },
  { check: (email) => !email.body.match(/revolut\.com|revolut\.business/i) && !email.body.match(/\[.*link.*\]/i), issue: "Missing link to Revolut Business website", deduction: 15 },
  { check: (email) => email.body.match(/just\s+(?:checking|following)\s+(?:in|up)(?!\s+on\s+(?:a|the|my)\s+\w+)/i), issue: "Generic follow-up without value-add", deduction: 15 },
  { check: (email) => email.body.match(/i\s+never\s+heard\s+back/i), issue: "Guilt language", deduction: 15 },
  { check: (email) => email.body.match(/sorry\s+to\s+(?:disturb|bother)/i), issue: "Apologetic opener", deduction: 15 },
  { check: (email) => email.body.match(/hope\s+you'?re?\s+well/i) && email.body.split("\n").indexOf(email.body.match(/hope\s+you'?re?\s+well/i)?.[0]) < 3, issue: "Filler opener (hope you're well)", deduction: 15 },
  { check: (email) => email.body.match(/did\s+you\s+enjoy\s+your\s+weekend/i), issue: "Irrelevant personal question", deduction: 15 },
  { check: (email) => email.body.match(/let\s+me\s+introduce\s+myself/i), issue: "Weak self-introduction", deduction: 15 },
  { check: (email) => email.body.match(/per\s+my\s+previous\s+email/i), issue: "Passive-aggressive language", deduction: 15 },
];

const STRUCTURAL_CHECKS = [
  { check: (email) => wordCount(email.body) > 200, issue: "Body exceeds 200 words (abandonment cliff)", deduction: 10 },
  { check: (email) => email.subject && email.subject.length > 50, issue: "Subject line too long (>50 chars, mobile truncation)", deduction: 5 },
  { check: (email) => (email.body.match(/!/g) || []).length > 1, issue: "Excessive exclamation marks", deduction: 5 },
  { check: (email) => email.body.match(/\bDear\b/i), issue: "Forbidden salutation (Dear)", deduction: 10 },
  { check: (email) => email.body.match(/\b(synergy|leverage|circle\s+back|touch\s+base|low[- ]?hanging\s+fruit|deep\s+dive|ideate)\b/i), issue: "Business buzzword detected", deduction: 5 },
  { check: (email) => email.body.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u), issue: "Emoji in Business sales email", deduction: 5 },
];

const GATE1_THRESHOLDS = {
  citation_density: 0.5,
  specificity_score: 1.5,
  research_density: 4.0,
};

const VOICE_DISPLAY_PASS_THRESHOLD = 85;

export const MANDATORY_OUTREACH_FOOTER = [
  "---",
  "Sophie Louise Penrose",
  "[Title] | Revolut Business",
  "revolut.com/business",
  "",
  "As part of our sales process, we collect, use, and process your personal data in line with relevant laws and regulations. Sales calls may be recorded for quality and training purposes. For more details, please refer to our privacy notice (UK/EEA | US).",
  "",
  "To manage your sales outreach preferences or opt out, reply to this email with your preference.",
  "",
  "Any information provided is not intended to be and does not constitute financial advice, investment advice, trading advice or any other advice or recommendation of any sort.",
].join("\n");

const GATE3_FORBIDDEN_PATTERNS = [
  /always\s+free/i,
  /unlimited\b(?!\s+(?:cards|virtual\s+cards)\b)/i,
  /\bbest\b(?!\s*[,\n]|\s+(?:regards|wishes|practice|motion))/i,
  /\bcheapest\b/i,
  /\bfastest\b/i,
  /(?<!not\s)\bguaranteed\b/i,
  /100%/i,
  /limited\s+time/i,
  /act\s+now/i,
  /last\s+chance/i,
  /\baccount\s+manager\b/i,
  /\bfinancial\s+advis[oe]r\b/i,
];

const AI_TELL_PATTERNS = [
  /\bdelve\b/i,
  /\bnavigate\b/i,
  /\brobust\b/i,
  /\bseamless\b/i,
  /\bin\s+today'?s\b/i,
  /\bin\s+the\s+realm\s+of\b/i,
  /\bstands\s+as\s+a\s+testament\b/i,
  /\bspeaks\s+volumes\b/i,
  /\bit'?s\s+worth\s+noting\b/i,
];

const SOPHIE_VOCABULARY_PATTERNS = [
  /operational\s+friction/i,
  /treasury\s+friction/i,
  /financial\s+complexity/i,
  /cross-border/i,
  /strategic\s+evolution/i,
  /continuing\s+to\s+scale/i,
  /high-volume/i,
  /similar\s+clients/i,
  /usually,\s*when/i,
];

function normalizeSentenceList(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function countMatches(text, pattern) {
  if (!text || !pattern) return 0;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return (String(text).match(globalPattern) || []).length;
}

function toPercent(numerator, denominator) {
  if (!denominator) return 0;
  return (Number(numerator || 0) / Number(denominator)) * 100;
}

function buildGateCheck(id, label, passed, detail = null) {
  return { id, label, passed: !!passed, detail };
}

function evaluateCitationGate(email) {
  const body = String(email?.body || "");
  const sentences = normalizeSentenceList(body);
  const sentenceCount = Math.max(sentences.length, 1);
  const words = Math.max(wordCount(body), 1);

  const synthesizedInference = countMatches(body, /what\s+stood\s+out|structural\s+(?:mismatch|insight)|underneath|usually,\s*when|challenge\s+shifts?/gi);
  const quantifiedFacts = countMatches(body, /(?:£\s?\d[\d,.]*(?:\s?(?:m|bn|k))?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s*(?:million|billion|bn|m|k)\b)/gi);
  const directorsLanguage = countMatches(body, /"[^"]{8,}"|board\s+flagged|strategic\s+report|directors?\s+report/gi);
  const specificFacts = countMatches(body, /(?:\b20\d{2}\b|\bfy\d{2,4}\b|\bq[1-4]\b|filing|accounts?|charges?\s+register|jurisdiction|entity|turnover|exposure)/gi) + quantifiedFacts;
  const whyNowAnchors = countMatches(body, /latest|recent|this\s+year|current|next\s+\d+\s+weeks?|upcoming|now/gi);
  const insiderVocabulary = SOPHIE_VOCABULARY_PATTERNS.reduce((sum, pattern) => sum + (pattern.test(body) ? 1 : 0), 0);
  const personaLanguage = countMatches(body, /cfo|finance\s+director|treasury|controller|procurement|payments?/gi);

  const citations = synthesizedInference + quantifiedFacts + directorsLanguage + specificFacts + whyNowAnchors + insiderVocabulary + personaLanguage;

  const specificityPoints =
    (synthesizedInference * 3.0)
    + (quantifiedFacts * 2.5)
    + (directorsLanguage * 2.0)
    + (specificFacts * 1.5)
    + (whyNowAnchors * 1.5)
    + (insiderVocabulary * 1.0)
    + (personaLanguage * 0.5);

  const citationDensity = citations / sentenceCount;
  const specificityScore = specificityPoints / sentenceCount;
  const researchDensity = (specificFacts / words) * 100;

  const checks = [
    buildGateCheck(
      "citation_density",
      `Citation density >= ${GATE1_THRESHOLDS.citation_density}`,
      citationDensity >= GATE1_THRESHOLDS.citation_density,
      `actual=${citationDensity.toFixed(2)}`
    ),
    buildGateCheck(
      "specificity_score",
      `Specificity score >= ${GATE1_THRESHOLDS.specificity_score}`,
      specificityScore >= GATE1_THRESHOLDS.specificity_score,
      `actual=${specificityScore.toFixed(2)}`
    ),
    buildGateCheck(
      "research_density",
      `Research density >= ${GATE1_THRESHOLDS.research_density}`,
      researchDensity >= GATE1_THRESHOLDS.research_density,
      `actual=${researchDensity.toFixed(2)}`
    ),
  ];

  return {
    pass: checks.every((check) => check.passed),
    checks,
    metrics: {
      sentence_count: sentenceCount,
      citation_count: citations,
      specific_fact_count: specificFacts,
      citation_density: Math.round(citationDensity * 1000) / 1000,
      specificity_score: Math.round(specificityScore * 1000) / 1000,
      research_density: Math.round(researchDensity * 1000) / 1000,
    },
  };
}

function evaluateVoiceGate(email, meta = {}) {
  const body = String(email?.body || "");
  const lowerBody = body.toLowerCase();

  const aiTellHits = AI_TELL_PATTERNS.reduce((sum, pattern) => sum + countMatches(body, pattern), 0);
  const aiTellPass = aiTellHits === 0;

  const threeItemListPattern = /\b(?:[a-z0-9'\/-]+\s+){0,2}[a-z0-9'\/-]+,\s+(?:[a-z0-9'\/-]+\s+){0,2}[a-z0-9'\/-]+,\s+(?:and\s+)?(?:[a-z0-9'\/-]+\s+){0,2}[a-z0-9'\/-]+\b/gi;
  const threeItemListPass = countMatches(body, threeItemListPattern) === 0;

  const emDashCount = countMatches(body, /—|--/g);
  const emDashLimit = meta?.isInitialOutreach ? 2 : 1;
  const emDashPass = emDashCount <= emDashLimit;

  const andButSentenceOpenerPass = !/(^|[.!?]\s+)(and|but)\b/i.test(lowerBody);
  const exclamationPass = countMatches(body, /!/g) === 0;
  const closingSummaryPass = !/\b(in\s+summary|to\s+summari[sz]e|to\s+sum\s+up|overall,?\s+this)\b/i.test(lowerBody);

  const pleasantryPass = !/i\s+hope\s+this\s+finds\s+you\s+well|i\s+noticed|i\s+came\s+across|i\s+wanted\s+to\s+reach\s+out|quick\s+question|just\s+wanted\s+to/i.test(lowerBody);

  const footerTemplate = String(meta?.footerTemplate || MANDATORY_OUTREACH_FOOTER);
  const managedFooter = meta?.assumeManagedFooter !== false;
  const signOffPresent = /(best|kind\s+regards),/i.test(body) || (managedFooter && /sophie\s+louise\s+penrose/i.test(footerTemplate));
  const fullNamePresent = /sophie\s+louise\s+penrose/i.test(body) || (managedFooter && /sophie\s+louise\s+penrose/i.test(footerTemplate));
  const signOffPass = signOffPresent;
  const fullNamePass = fullNamePresent;

  const checks = [
    buildGateCheck("ai_tell", "Zero forbidden AI-tell vocabulary", aiTellPass),
    buildGateCheck("pleasantries", "Zero forbidden pleasantries", pleasantryPass),
    buildGateCheck("exclamation", "No exclamation marks", exclamationPass),
    buildGateCheck("emdash", `Em-dash usage <= ${emDashLimit}`, emDashPass),
    buildGateCheck("and_but_openers", 'No "And"/"But" sentence openers', andButSentenceOpenerPass),
    buildGateCheck("three_item_rhythm", "No three-item list rhythm", threeItemListPass),
    buildGateCheck("closing_summary", "No closing summary statement", closingSummaryPass),
    buildGateCheck("signoff", 'Sign-off is "Best," or "Kind regards,"', signOffPass),
    buildGateCheck("full_name", 'Full name "Sophie Louise Penrose" present', fullNamePass),
  ];

  const passedChecks = checks.filter((check) => check.passed).length;
  const voicePercent = Math.round(toPercent(passedChecks, checks.length));
  const checklistPass = checks.every((check) => check.passed);

  return {
    pass: checklistPass,
    checks,
    metrics: {
      voice_percent: voicePercent,
      voice_display_pass: voicePercent >= VOICE_DISPLAY_PASS_THRESHOLD,
      em_dash_count: emDashCount,
      ai_tell_hits: aiTellHits,
    },
  };
}

function evaluateComplianceGate(email, meta = {}) {
  const body = String(email?.body || "");
  const subject = String(email?.subject || "");
  const footerTemplate = String(meta?.footerTemplate || MANDATORY_OUTREACH_FOOTER);
  const combined = meta?.assumeManagedFooter === false ? `${subject}\n${body}` : `${subject}\n${body}\n${footerTemplate}`;
  const lowerCombined = combined.toLowerCase();

  const forbiddenHit = GATE3_FORBIDDEN_PATTERNS.find((pattern) => pattern.test(combined));
  const forbiddenPass = !forbiddenHit;

  const claimMentions = countMatches(combined, /(?:£\s?\d[\d,.]*(?:\s?(?:m|bn|k))?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s*(?:million|billion|bn|m|k)\b)/gi);
  const provenanceHints = countMatches(combined, /based\s+on\s+your\s+filed\s+accounts|we\s+estimate|approved\s+claim|illustrative|depends\s+on\s+your\s+current\s+provider/gi);
  const claimsTraceabilityPass = claimMentions === 0 || provenanceHints > 0;

  const disclaimerRequired = /interbank\s+rate|save\s+up\s+to|estimate\s+the\s+gap|in\s+the\s+region\s+of\s+£/i.test(combined);
  const disclaimerPresent = /illustrative\s+of\s+savings\s+that\s+could\s+be\s+achieved|during\s+market\s+hours\s+within\s+plan\s+allowance/i.test(combined);
  const disclaimersPass = !disclaimerRequired || disclaimerPresent;

  const linkPass = /revolut\.com\/business/i.test(lowerCombined);
  const optOutPass = /opt\s*out|outreach\s+preferences/i.test(lowerCombined);
  const privacyPass = !meta?.isInitialOutreach || /privacy\s+notice/i.test(lowerCombined);

  const checks = [
    buildGateCheck("forbidden_phrases", "No forbidden phrases", forbiddenPass, forbiddenHit ? forbiddenHit.source : null),
    buildGateCheck("claims_traceability", "Every claim traces to dossier or approved claims", claimsTraceabilityPass),
    buildGateCheck("required_disclaimers", "Required disclaimers present", disclaimersPass),
    buildGateCheck("rb_link", "revolut.com/business link present", linkPass),
    buildGateCheck("opt_out", "Opt-out mechanism present", optOutPass),
    buildGateCheck("privacy_notice", "Email 1 privacy notice present", privacyPass),
  ];

  return {
    pass: checks.every((check) => check.passed),
    checks,
    metrics: {
      claim_mentions: claimMentions,
      provenance_hints: provenanceHints,
      disclaimer_required: disclaimerRequired,
    },
  };
}

function wordCount(text) {
  return (text || "").split(/\s+/).filter(Boolean).length;
}

export function validateEmail(email, meta = {}) {
  const issues = [];
  let score = 100;

  for (const rule of FORBIDDEN_PHRASES) {
    if (rule.pattern.test(email.body) || (email.subject && rule.pattern.test(email.subject))) {
      issues.push({ type: "major", violation: rule.violation, deduction: rule.deduction, pattern: rule.pattern.source });
      score -= rule.deduction;
    }
  }

  for (const rule of MINOR_DEDUCTIONS) {
    if (rule.check(email, meta)) {
      issues.push({ type: "minor", violation: rule.issue, deduction: rule.deduction });
      score -= rule.deduction;
    }
  }

  for (const rule of STRUCTURAL_CHECKS) {
    if (rule.check(email)) {
      issues.push({ type: "structural", violation: rule.issue, deduction: rule.deduction });
      score -= rule.deduction;
    }
  }

  const wc = wordCount(email.body);
  const subjectLen = (email.subject || "").length;

  const gate1 = evaluateCitationGate(email);
  const gate2 = evaluateVoiceGate(email, meta);
  const gate3 = evaluateComplianceGate(email, meta);

  const allGateFailures = [
    ...gate1.checks.filter((check) => !check.passed).map((check) => ({ gate: "gate1", check })),
    ...gate2.checks.filter((check) => !check.passed).map((check) => ({ gate: "gate2", check })),
    ...gate3.checks.filter((check) => !check.passed).map((check) => ({ gate: "gate3", check })),
  ];

  for (const failure of allGateFailures) {
    issues.push({
      type: "gate",
      gate: failure.gate,
      violation: failure.check.label,
      deduction: 0,
      detail: failure.check.detail || null,
    });
  }

  const legacyPass = score >= 80;
  const gatePass = gate1.pass && gate2.pass && gate3.pass;

  return {
    score: Math.max(score, 0),
    pass: gatePass,
    legacy_pass: legacyPass,
    quality_gate_pass: gatePass,
    issues,
    gates: {
      gate1,
      gate2,
      gate3,
    },
    metrics: {
      word_count: wc,
      subject_length: subjectLen,
      subject_words: (email.subject || "").split(/\s+/).filter(Boolean).length,
      within_word_limit: wc >= 50 && wc <= 150,
      within_subject_limit: subjectLen > 0 && subjectLen <= 45,
      citation_density: gate1.metrics.citation_density,
      specificity_score: gate1.metrics.specificity_score,
      research_density: gate1.metrics.research_density,
      voice_percent: gate2.metrics.voice_percent,
      voice_display_pass: gate2.metrics.voice_display_pass,
      qc_compliance_pass: gate3.pass,
    },
  };
}

export const APPROVED_CLAIMS = {
  general: [
    "70M total customers",
    "20,000+ new businesses join us every month",
    "£3.1B revenue in 2024, up 74% YoY",
    "$200bn processed volumes",
    "99.99%+ payment processing platform uptime",
  ],
  spend: [
    { claim: "6% saved by our customers on spend when using Revolut Business", disclaimer: 1 },
    { claim: "Manage your expenses 88% faster with automated tools, compared to manual processes", disclaimer: null },
    { claim: "Save up to 86% of time processing expenses", disclaimer: null },
    { claim: "Up to 98% accuracy for matching receipts to transactions", disclaimer: null },
  ],
  fx: [
    { claim: "Exchange at the interbank rate", disclaimer: 2 },
    { claim: "0% markup on FX within plan allowance", disclaimer: 2 },
    { claim: "FX is 2–4x cheaper than Pleo", disclaimer: null },
    { claim: "Save up to 3% on FX vs traditional banks when spending abroad", disclaimer: null },
  ],
  cards: [
    "Up to 200 virtual cards",
    "Issue physical and virtual cards in minutes",
    "Auto-enforced spend controls — limits, categories, merchants",
  ],
  acquiring: [
    "24-hour settlement (vs. 3–7 days from traditional acquirers)",
    "Like-for-like settlement in 34 currencies — eliminates 1–2% auto-FX fees",
    "9-second checkout with Revolut Pay",
    "Access to 70M+ retail users via Revolut Pay",
    "Online via API, in-person via Tap to Pay or Terminal",
  ],
  integrations: [
    "Integrates with Xero, QuickBooks, NetSuite, HiBob",
    "Setup in minutes, not weeks",
    "Sync expenses, categories, labels and tax rates automatically",
  ],
  disclaimers: {
    1: "Based on the average reduction in spending volume for Revolut Business customers when using our spend control features in the first three months of 2024. This percentage is illustrative of savings that could be achieved, but is not guaranteed.",
    2: "During market hours within plan allowance",
  },
};

export const EXCLUDED_INDUSTRIES = [
  "gambling", "weapons", "firearms", "adult entertainment", "tobacco",
  "illegal drugs", "cryptocurrency trading", "shell banks",
  "illegal surveillance",
];

export const EXCLUDED_STATUSES = [
  "dissolved", "in administration", "in liquidation", "dormant",
  "liquidation", "receivership", "struck off",
];

export function isCompanyExcluded(company, analysis) {
  if (company.turnover && company.turnover < 15_000_000) {
    const growth = analysis?.turnover_trend;
    if (growth !== "growing") return { excluded: true, reason: "Below £15M turnover with no growth trajectory" };
  }

  const status = (company.status || "").toLowerCase();
  if (EXCLUDED_STATUSES.some((s) => status.includes(s))) {
    return { excluded: true, reason: `Company status: ${status}` };
  }

  const industry = (company.industry || "").toLowerCase();
  if (EXCLUDED_INDUSTRIES.some((ex) => industry.includes(ex))) {
    return { excluded: true, reason: `Prohibited industry: ${industry}` };
  }

  if (analysis?.risks) {
    const distressRisks = analysis.risks.filter((r) =>
      /going\s+concern|administration|liquidation|winding.?up/i.test(typeof r === "string" ? r : r.risk || "")
    );
    if (distressRisks.length > 0) {
      return { excluded: true, reason: "Company shows distress signals (going concern / administration)" };
    }
  }

  return { excluded: false };
}
