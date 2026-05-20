import { getFilingsForCompany, getMonitoredCompany, getSetting, setSetting } from "./db.js";

const TURNOVER_THRESHOLD = 15_000_000;

// --- Product GP priority (relative, based on internal strategy docs) ---
const PRODUCT_GP_WEIGHTS = {
  "FX": 0.9,
  "FX Forwards": 0.85,
  "Cards": 0.95,
  "Spend Management": 0.5,
  "API Integrations": 0.6,
  "Merchant Acquiring": 0.8,
  "Revolut Pay": 0.75,
};

const PRODUCT_MOTIONS = Object.keys(PRODUCT_GP_WEIGHTS);

// --- Industry → Product mapping (from Mid-Market Playbook) ---
const INDUSTRY_PRODUCT_FIT = {
  travel: ["Cards", "FX", "FX Forwards", "Merchant Acquiring", "API Integrations"],
  retail: ["FX", "FX Forwards", "Merchant Acquiring", "Spend Management", "Cards"],
  wholesale: ["FX", "FX Forwards", "Spend Management"],
  manufacturing: ["FX", "FX Forwards", "Spend Management", "Cards"],
  commodity: ["FX", "FX Forwards"],
  ecommerce: ["Merchant Acquiring", "Revolut Pay", "API Integrations"],
  consulting: ["FX", "Cards", "Spend Management"],
  it: ["FX", "Cards", "Spend Management", "API Integrations"],
  saas: ["API Integrations", "FX", "Cards"],
  restaurant: ["Merchant Acquiring", "Cards"],
  hospitality: ["Merchant Acquiring", "Cards", "FX", "FX Forwards"],
  food: ["Merchant Acquiring", "Spend Management"],
  logistics: ["FX", "API Integrations", "Cards"],
  freight: ["FX", "FX Forwards", "API Integrations"],
  construction: ["Cards", "Spend Management"],
  healthcare: ["Cards", "Spend Management", "Merchant Acquiring"],
  energy: ["FX", "FX Forwards", "Cards", "Spend Management"],
  property: ["Cards", "Spend Management"],
};

// --- Scoring weights ---
const SCORING_WEIGHTS = {
  product_fit: 0.30,
  commercial_value: 0.25,
  pain_strength: 0.20,
  urgency: 0.15,
  competitor_context: 0.10,
};

// --- Evidence patterns for product fit scoring ---

const FX_HIGH = [
  /(?:international|overseas|foreign)\s+(?:revenue|sales|income|operations|trade|business)/i,
  /(?:export|import)(?:s|ing|ed)/i,
  /multi[- ]?currency/i,
  /(?:foreign\s+)?exchange\s+(?:risk|exposure|losses|gains|costs)/i,
  /(?:USD|EUR|JPY|CHF|AED|CNY|INR|BDT|THB)\s/i,
  /(?:\d+%|majority|significant)\s+(?:of\s+)?(?:revenue|sales|turnover).*(?:overseas|international)/i,
  /(?:international\s+)?supplier(?:s)?\s+(?:in|across|from)/i,
  /(?:pay|paid|paying)\s+(?:in|using)\s+(?:foreign|multiple)\s+currenc/i,
];

const FX_MEDIUM = [
  /(?:international|overseas|global|foreign|export|import)/i,
  /(?:currency|currencies)/i,
  /(?:subsidiary|subsidiaries|branch)\s+(?:in|outside|overseas)/i,
];

const FX_FORWARDS_HIGH = [
  /(?:hedg|forward\s+contract|forward\s+rate|forward\s+cover)/i,
  /(?:currency|FX|foreign\s+exchange)\s+(?:risk\s+management|hedging|policy)/i,
  /(?:long[- ]?term|12[- ]?month|multi[- ]?year)\s+(?:contract|agreement|supply|obligation)/i,
  /(?:fixed\s+price|locked\s+rate|guaranteed\s+rate)/i,
  /(?:seasonal|cyclical)\s+(?:demand|exposure|purchasing)/i,
];

const FX_FORWARDS_MEDIUM = [
  /(?:seasonal|quarterly|recurring)\s+(?:payment|cost|expense)/i,
  /(?:supply\s+chain|procurement)\s+(?:in|from)\s+(?:overseas|abroad)/i,
  /(?:commodity|raw\s+material)\s+(?:price|cost)/i,
];

const CARDS_HIGH = [
  /(\d{3,})\s*(?:employees|staff|team\s+members|people|FTEs)/i,
  /(?:multiple|several|numerous)\s+(?:sites?|locations?|offices?|branches|depots?|countries)/i,
  /(?:travel|expense|procurement|purchasing)\s+(?:policy|management|control|spending)/i,
  /(?:reimburse|petty\s+cash|personal\s+cards?|out[- ]?of[- ]?pocket)/i,
  /(?:business\s+)?travel\s+(?:costs?|expenses?|spend)/i,
  /(?:subscription|SaaS|software)\s+(?:costs?|spend|management)/i,
];

const CARDS_MEDIUM = [
  /(?:employee|staff|workforce|headcount|team)/i,
  /(?:travel|expenses?|purchasing|card)/i,
];

const SPEND_HIGH = [
  /(?:budget|spend|expenditure)\s+(?:control|visibility|management|approval|oversight)/i,
  /(?:decentrali[sz]ed|distributed|fragmented)\s+(?:spending|purchasing|procurement)/i,
  /(?:multi[- ]?site|multi[- ]?entity|multi[- ]?department|multi[- ]?location)/i,
  /(?:audit|compliance|governance)\s+(?:issue|concern|finding|requirement|review)/i,
  /(?:purchase\s+order|PO\s+system|approval\s+workflow)/i,
  /(?:cost\s+control|cost\s+reduction|cost\s+management)\s+(?:initiative|programme|project)/i,
];

const SPEND_MEDIUM = [
  /(?:procurement|purchasing|spend|vendor|supplier\s+management)/i,
  /(?:approval|authoris|authoriz|budget)/i,
];

const API_HIGH = [
  /(?:API|integration|automated?\s+payment|programmatic)/i,
  /(?:ERP|SAP|Oracle|NetSuite|Xero|QuickBooks|Sage)\s/i,
  /(?:platform|SaaS|marketplace|software)\s+(?:business|company|provider)/i,
  /(?:developer|engineering|technical|technology)\s+team/i,
  /(?:embedded\s+(?:payment|finance)|banking\s+as\s+a\s+service|BaaS)/i,
  /(?:payment\s+)?automation/i,
];

const API_MEDIUM = [
  /(?:technology|digital|software|system|platform)/i,
  /(?:automat|integrat|digital\s+transformation)/i,
];

const MERCHANT_HIGH = [
  /(?:retail\s+(?:store|outlet|shop|chain)|e[- ]?commerce|online\s+(?:sales|shop|store|retail))/i,
  /(?:payment\s+(?:accept|process|terminal|gateway)|card\s+(?:payment|transaction|processing))/i,
  /(?:checkout|point\s+of\s+sale|POS|PSP|payment\s+service\s+provider)/i,
  /(?:consumer[- ]?facing|B2C|direct\s+to\s+consumer|DTC)/i,
  /(?:transaction\s+volume|processing\s+volume|card\s+revenue)/i,
  /(?:Stripe|Worldpay|Adyen|Square|SumUp|iZettle|PayPal)\s/i,
];

const MERCHANT_MEDIUM = [
  /(?:customer|consumer|retail|online|store|shop)/i,
  /(?:revenue|sales).*(?:online|digital|website)/i,
];

const MOTION_SIGNALS = {
  "FX": { high: FX_HIGH, medium: FX_MEDIUM },
  "FX Forwards": { high: FX_FORWARDS_HIGH, medium: FX_FORWARDS_MEDIUM },
  "Cards": { high: CARDS_HIGH, medium: CARDS_MEDIUM },
  "Spend Management": { high: SPEND_HIGH, medium: SPEND_MEDIUM },
  "API Integrations": { high: API_HIGH, medium: API_MEDIUM },
  "Merchant Acquiring": { high: MERCHANT_HIGH, medium: MERCHANT_MEDIUM },
  "Revolut Pay": { high: MERCHANT_HIGH, medium: MERCHANT_MEDIUM },
};

// --- Competitor detection ---
const COMPETITOR_PATTERNS = {
  "HSBC": { regex: /\bHSBC\b/i, products: ["FX", "FX Forwards"], weakness: "digital_friction", stickiness: 4 },
  "Barclays": { regex: /\bBarclays?\b/i, products: ["FX", "Cards", "Merchant Acquiring"], weakness: "legacy_costs", stickiness: 4 },
  "NatWest": { regex: /\bNatWest\b/i, products: ["FX"], weakness: "digital_friction", stickiness: 4 },
  "Lloyds": { regex: /\bLloyds\b/i, products: ["FX"], weakness: "digital_friction", stickiness: 4 },
  "Worldpay": { regex: /\bWorldpay\b/i, products: ["Merchant Acquiring"], weakness: "legacy_pricing", stickiness: 4 },
  "Stripe": { regex: /\bStripe\b/i, products: ["Merchant Acquiring", "API Integrations"], weakness: "slow_settlement", stickiness: 3.5 },
  "Adyen": { regex: /\bAdyen\b/i, products: ["Merchant Acquiring"], weakness: "enterprise_gated", stickiness: 4 },
  "Wise": { regex: /\bWise\b|TransferWise/i, products: ["FX"], weakness: "no_forwards_no_cards", stickiness: 2 },
  "Ebury": { regex: /\bEbury\b/i, products: ["FX", "FX Forwards"], weakness: "no_banking_ecosystem", stickiness: 3 },
  "Pleo": { regex: /\bPleo\b/i, products: ["Cards", "Spend Management"], weakness: "expensive_fx", stickiness: 2 },
  "SAP Concur": { regex: /\b(?:SAP\s+)?Concur\b/i, products: ["Spend Management"], weakness: "expensive_complex", stickiness: 3 },
  "Amex": { regex: /\bAm(?:erican\s+)?Ex(?:press)?\b/i, products: ["Cards"], weakness: "high_fees_limited_acceptance", stickiness: 3 },
};

// --- Positive qualification signals ---
const POSITIVE_SIGNALS = [
  { pattern: /(?:new|recently\s+appointed|joined)\s+(?:CFO|Finance\s+Director|Chief\s+Financial|FD)/i, signal: "New CFO/FD", weight: 0.15 },
  { pattern: /(?:acqui(?:red|sition)|merger|bought|purchased)\s+/i, signal: "Recent acquisition", weight: 0.12 },
  { pattern: /(?:headcount|employee|staff|team)\s+(?:grew|growth|increased|expanded|risen)/i, signal: "Headcount growth", weight: 0.10 },
  { pattern: /(?:cost\s+(?:reduction|saving|optimis|cutting)|reduce\s+costs?|margin\s+pressure)/i, signal: "Cost reduction focus", weight: 0.12 },
  { pattern: /(?:international\s+expansion|expand(?:ing|ed)?\s+(?:internationally|overseas|globally))/i, signal: "International expansion", weight: 0.13 },
  { pattern: /(?:digital\s+transformation|moderni[sz]|technology\s+investment)/i, signal: "Digital transformation", weight: 0.08 },
  { pattern: /(?:rapid|strong|significant|substantial)\s+(?:growth|expansion|increase)/i, signal: "Strong growth", weight: 0.10 },
  { pattern: /(?:multiple|several|numerous)\s+(?:bank|banking)\s+(?:relationship|provider|partner)/i, signal: "Fragmented banking", weight: 0.10 },
];

// --- Negative / disqualification signals ---
const NEGATIVE_SIGNALS = [
  { pattern: /(?:going\s+concern|material\s+uncertainty|doubt.*ability\s+to\s+continue)/i, signal: "Going concern doubt", weight: -0.3 },
  { pattern: /(?:in\s+(?:administration|liquidation|receivership))/i, signal: "Distressed", weight: -0.5 },
  { pattern: /(?:dormant|no\s+(?:significant\s+)?trading)/i, signal: "Dormant/Non-trading", weight: -0.5 },
  { pattern: /(?:winding\s+up|cease[d]?\s+trading|closure)/i, signal: "Winding up", weight: -0.5 },
];

// --- Main scoring functions ---

function scoreMotionFromText(text, motion) {
  const signals = MOTION_SIGNALS[motion];
  if (!signals) return { score: 0, evidence: [] };

  let score = 0;
  const evidence = [];

  for (const pattern of signals.high) {
    const match = text.match(pattern);
    if (match) {
      score += 0.25;
      const start = Math.max(0, match.index - 30);
      const ctx = text.substring(start, match.index + match[0].length + 80).trim();
      evidence.push({ text: ctx.substring(0, 150), strength: "high" });
    }
  }

  for (const pattern of signals.medium) {
    if (text.match(pattern)) score += 0.08;
  }

  return { score: Math.min(score, 1), evidence: evidence.slice(0, 3) };
}

function detectCompetitors(text) {
  const detected = [];
  for (const [name, config] of Object.entries(COMPETITOR_PATTERNS)) {
    if (config.regex.test(text)) {
      detected.push({
        name,
        products: config.products,
        weakness: config.weakness,
        stickiness: config.stickiness,
      });
    }
  }
  return detected;
}

function scoreCompetitorContext(competitors) {
  if (competitors.length === 0) return 0.5;
  const avgStickiness = competitors.reduce((s, c) => s + c.stickiness, 0) / competitors.length;
  const weakCompetitors = competitors.filter((c) => c.stickiness <= 2.5).length;
  return Math.min(0.3 + weakCompetitors * 0.2 + (5 - avgStickiness) * 0.1, 1);
}

function detectQualificationSignals(text) {
  const positive = [];
  const negative = [];

  for (const sig of POSITIVE_SIGNALS) {
    if (sig.pattern.test(text)) positive.push(sig);
  }
  for (const sig of NEGATIVE_SIGNALS) {
    if (sig.pattern.test(text)) negative.push(sig);
  }

  return { positive, negative };
}

function scoreCommercialValue(turnover) {
  if (!turnover || turnover < TURNOVER_THRESHOLD) return 0;
  if (turnover >= 500_000_000) return 1.0;
  if (turnover >= 250_000_000) return 0.9;
  if (turnover >= 100_000_000) return 0.8;
  if (turnover >= 50_000_000) return 0.65;
  if (turnover >= 25_000_000) return 0.5;
  return 0.35;
}

function scoreGrowth(filings) {
  if (!filings || filings.length < 2) return { score: 0.5, trend: "unknown" };
  const sorted = filings.filter((f) => f.turnover > 0).sort((a, b) => (a.filing_date || "").localeCompare(b.filing_date || ""));
  if (sorted.length < 2) return { score: 0.5, trend: "unknown" };

  const oldest = sorted[0].turnover;
  const latest = sorted[sorted.length - 1].turnover;
  const growthRate = (latest - oldest) / oldest;

  if (growthRate > 0.2) return { score: 0.9, trend: "strong_growth", rate: growthRate };
  if (growthRate > 0.05) return { score: 0.7, trend: "growing", rate: growthRate };
  if (growthRate > -0.05) return { score: 0.5, trend: "stable", rate: growthRate };
  if (growthRate > -0.2) return { score: 0.3, trend: "declining", rate: growthRate };
  return { score: 0.1, trend: "sharp_decline", rate: growthRate };
}

function extractEmployeeCount(text) {
  const patterns = [
    /average.*?(\d{1,5})\s*(?:employees|staff|people)/i,
    /(\d{1,5})\s*(?:employees|staff|people|team\s+members|FTEs)/i,
    /headcount.*?(\d{1,5})/i,
    /(?:employed|employ)\s+(?:an\s+average\s+of\s+)?(\d{1,5})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const count = parseInt(m[1]);
      if (count > 0 && count < 100000) return count;
    }
  }
  return null;
}

function detectIndustry(text) {
  const indicators = {
    travel: /\b(?:travel|tourism|airline|holiday|tour\s+operator|OTA|booking)\b/i,
    ecommerce: /\b(?:e[- ]?commerce|online\s+(?:retail|store|shop)|DTC|direct\s+to\s+consumer)\b/i,
    retail: /\b(?:retail|store|shop|outlet|high\s+street)\b/i,
    manufacturing: /\b(?:manufactur|factory|production\s+facility|assembly)\b/i,
    logistics: /\b(?:logistics|freight|shipping|haulage|transport|distribution|warehouse)\b/i,
    hospitality: /\b(?:hotel|hospitality|restaurant|pub|bar|catering|leisure)\b/i,
    food: /\b(?:food|beverage|catering|bakery|grocery)\b/i,
    consulting: /\b(?:consult|advisory|professional\s+services)\b/i,
    it: /\b(?:software|IT\s+services|technology|SaaS|platform)\b/i,
    construction: /\b(?:construction|building|civil\s+engineering|contractor)\b/i,
    healthcare: /\b(?:health|hospital|medical|pharmaceutical|care\s+home)\b/i,
    energy: /\b(?:energy|oil|gas|renewable|solar|wind\s+farm|utility)\b/i,
    property: /\b(?:property|real\s+estate|estate\s+agent|lettings)\b/i,
    commodity: /\b(?:commodity|metals?|mining|agriculture|grain|timber)\b/i,
  };

  const detected = [];
  for (const [industry, pattern] of Object.entries(indicators)) {
    if (pattern.test(text)) detected.push(industry);
  }
  return detected;
}

// --- Main scoring function ---

export function scoreCompany(companyNumber) {
  const monitored = getMonitoredCompany(companyNumber);
  if (!monitored) return null;

  const filings = getFilingsForCompany(companyNumber, 5);
  const latestFiling = filings.find((f) => f.raw_data);
  const text = latestFiling?.raw_data || "";
  const turnover = monitored.latest_turnover || 0;

  const motionScores = {};
  let bestMotionScore = 0;
  let bestMotion = null;
  let totalWeightedFit = 0;

  for (const motion of PRODUCT_MOTIONS) {
    const { score, evidence } = scoreMotionFromText(text, motion);
    const gpWeight = PRODUCT_GP_WEIGHTS[motion];
    const weightedScore = score * gpWeight;
    motionScores[motion] = { score, weighted: weightedScore, evidence, fit_level: score >= 0.5 ? "strong" : score >= 0.25 ? "medium" : "weak" };
    if (weightedScore > bestMotionScore) {
      bestMotionScore = weightedScore;
      bestMotion = motion;
    }
    totalWeightedFit += weightedScore;
  }

  const productFitScore = Math.min(totalWeightedFit / 3, 1);
  const commercialValue = scoreCommercialValue(turnover);
  const growth = scoreGrowth(filings);
  const employees = extractEmployeeCount(text);
  const competitors = detectCompetitors(text);
  const competitorScore = scoreCompetitorContext(competitors);
  const industries = detectIndustry(text);
  const qualSignals = detectQualificationSignals(text);

  const positiveBoost = qualSignals.positive.reduce((s, sig) => s + sig.weight, 0);
  const negativeImpact = qualSignals.negative.reduce((s, sig) => s + sig.weight, 0);
  const urgencyScore = Math.min(Math.max(growth.score + positiveBoost, 0), 1);

  const painScore = Math.min(
    (motionScores["FX"]?.score || 0) * 0.25 +
    (motionScores["Cards"]?.score || 0) * 0.20 +
    (motionScores["Spend Management"]?.score || 0) * 0.20 +
    (motionScores["Merchant Acquiring"]?.score || 0) * 0.20 +
    (employees && employees > 200 ? 0.15 : employees && employees > 50 ? 0.08 : 0),
    1
  );

  let compositeScore = (
    productFitScore * SCORING_WEIGHTS.product_fit +
    commercialValue * SCORING_WEIGHTS.commercial_value +
    painScore * SCORING_WEIGHTS.pain_strength +
    urgencyScore * SCORING_WEIGHTS.urgency +
    competitorScore * SCORING_WEIGHTS.competitor_context
  );

  compositeScore = Math.max(compositeScore + negativeImpact, 0);
  compositeScore = Math.round(compositeScore * 100) / 100;

  const eligibleMotions = Object.entries(motionScores)
    .filter(([, v]) => v.score >= 0.25)
    .sort(([, a], [, b]) => b.weighted - a.weighted)
    .map(([motion, data]) => ({ motion, ...data }));

  const result = {
    company_number: companyNumber,
    company_name: monitored.company_name,
    turnover,
    composite_score: compositeScore,
    layers: {
      product_fit: { score: productFitScore, best_motion: bestMotion, best_score: bestMotionScore },
      commercial_value: { score: commercialValue },
      pain_strength: { score: painScore },
      urgency: { score: urgencyScore, trend: growth.trend, growth_rate: growth.rate },
      competitor_context: { score: competitorScore, detected: competitors },
    },
    eligible_motions: eligibleMotions,
    all_motion_scores: motionScores,
    employees,
    growth,
    industries,
    competitors,
    qualification: qualSignals,
    has_filing_text: !!text,
    scored_at: new Date().toISOString(),
  };

  setSetting(`score_${companyNumber}`, result);
  return result;
}

export function getStoredScore(companyNumber) {
  return getSetting(`score_${companyNumber}`, null);
}

export function batchScoreCompanies(companies) {
  const results = [];
  for (const company of companies) {
    const score = scoreCompany(company.company_number);
    if (score) results.push(score);
  }
  results.sort((a, b) => b.composite_score - a.composite_score);
  return results;
}
