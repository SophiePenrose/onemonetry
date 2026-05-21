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

  return {
    score: Math.max(score, 0),
    pass: score >= 80,
    issues,
    metrics: {
      word_count: wc,
      subject_length: subjectLen,
      subject_words: (email.subject || "").split(/\s+/).filter(Boolean).length,
      within_word_limit: wc >= 50 && wc <= 150,
      within_subject_limit: subjectLen > 0 && subjectLen <= 45,
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
