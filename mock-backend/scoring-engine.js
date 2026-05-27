import { getCompanyChargeSummary, getFilingsForCompany, getMonitoredCompany, getSetting, setSetting } from "./db.js";
import { analyseCompany } from "./llm.js";
import { getOutreachReadiness, scoreAllStakeholders } from "./stakeholder-scoring.js";

const TURNOVER_THRESHOLD = 15_000_000;

// --- Product GP priority (relative, based on internal strategy docs) ---
const PRODUCT_GP_WEIGHTS = {
  "FX": 0.8,
  "FX Forwards": 0.9,
  "Cards": 1.0,
  "Spend Management": 0.5,
  "API Integrations": 0.65,
  "Merchant Acquiring": 0.92,
  "Revolut Pay": 0.82,
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

const INDUSTRY_MOTION_MULTIPLIERS = {
  fuel_trading: {
    "FX": 1.4,
    "FX Forwards": 1.5,
    "Cards": 1.1,
  },
  property_mgmt: {
    "FX": 0.3,
    "Spend Management": 1.3,
    "Cards": 0.8,
  },
  ecommerce: {
    "Merchant Acquiring": 1.5,
    "Revolut Pay": 1.4,
    "FX": 0.9,
  },
  commodity: {
    "FX": 1.5,
    "FX Forwards": 1.6,
    "Cards": 0.7,
  },
  travel: {
    "FX": 1.3,
    "FX Forwards": 1.4,
    "Cards": 1.4,
  },
  food_processing: {
    "FX": 1.2,
    "FX Forwards": 1.1,
    "Spend Management": 1.0,
  },
};

const INDUSTRY_PRIOR_PATTERNS = {
  fuel_trading: [
    /(?:fuel\s+trader|fuel\s+trading|petroleum\s+trading|diesel\s+trading|bunker\s+fuel)/i,
    /(?:aviation\s+fuel|marine\s+fuel|energy\s+trading)/i,
  ],
  property_mgmt: [
    /(?:property\s+management|estate\s+management|lettings?|facility\s+management)/i,
    /(?:service\s+charge|leasehold|block\s+management)/i,
  ],
  ecommerce: [
    /(?:e[- ]?commerce|online\s+retail|direct\s+to\s+consumer|DTC)/i,
    /(?:checkout|cart\s+abandonment|payment\s+gateway)/i,
  ],
  commodity: [
    /(?:commodity\s+trading|metals?\s+trading|grain\s+trading|raw\s+materials?\s+trading)/i,
    /(?:oil\s+trader|gas\s+trader|agri\s+commodit)/i,
  ],
  travel: [
    /(?:travel\s+agency|tour\s+operator|airline|OTA|hospitality\s+group)/i,
    /(?:booking\s+platform|accommodation\s+provider|corporate\s+travel)/i,
  ],
  food_processing: [
    /(?:food\s+processing|food\s+manufacturer|beverage\s+producer)/i,
    /(?:packaging\s+line|cold\s+chain|ingredient\s+cost)/i,
  ],
};

// --- Scoring weights ---
const SCORING_WEIGHTS = {
  product_fit: 0.30,
  commercial_value: 0.20,
  pain_strength: 0.20,
  urgency: 0.12,
  competitor_context: 0.08,
  switching_feasibility: 0.10,
};

const MOTION_LLM_BOOST_CAP = 0.22;
const TOTAL_LLM_BOOST_CAP = 0.22;
const LLM_MAX_DOWNSIDE = -0.08;
const STAKEHOLDER_BOOST_CAP = 0.12;

const FX_FORWARDS_QUALIFIER_PATTERNS = [
  /(?:hedg|forward\s+contract|forward\s+cover|currency\s+policy)/i,
  /(?:fixed\s+price|locked\s+rate|guaranteed\s+rate)/i,
  /(?:long[- ]?term|12[- ]?month|multi[- ]?year)\s+(?:contract|agreement|obligation|supply)/i,
  /(?:commodity|raw\s+material)\s+(?:price|cost|exposure)/i,
];

const MERCHANT_RELEVANCE_PATTERNS = [
  /(?:checkout|point\s+of\s+sale|POS|PSP|payment\s+gateway)/i,
  /(?:card\s+payment|transaction\s+volume|processing\s+volume|merchant)/i,
  /(?:e[- ]?commerce|online\s+(?:sales|store|checkout)|retail\s+(?:store|chain))/i,
];

const CREDIT_GAP_PATTERNS = [
  /(?:credit\s+line|working\s+capital\s+facility|overdraft|revolving\s+credit)/i,
  /(?:covenant|secured\s+facility|lending\s+facility|invoice\s+finance)/i,
  /(?:relationship\s+bank|incumbent\s+bank|main\s+bank)/i,
];

const MULTI_BANKING_PATTERNS = [
  /(?:multiple|several|numerous)\s+(?:bank|banking)\s+(?:relationship|provider|partner)/i,
  /(?:multi[- ]?bank|fragmented\s+banking|more\s+than\s+one\s+bank)/i,
];

const LONG_TENURE_INCBUMBENT_PATTERNS = [
  /(?:long[- ]?standing|decade[- ]?long|since\s+20\d{2})\s+(?:bank|banking\s+partner|relationship)/i,
  /(?:incumbent\s+bank).*(?:since|for\s+over\s+\d+\s+years)/i,
];

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

const COMPETITOR_ADVANTAGE_INFERENCE = {
  digital_friction: "Position faster execution, cleaner workflows, and lower operational drag.",
  legacy_costs: "Position transparent economics with simpler rollout and clearer unit economics.",
  slow_settlement: "Position faster settlement and improved working-capital velocity.",
  legacy_pricing: "Position clearer pricing and simpler commercial structure.",
  enterprise_gated: "Position practical mid-market implementation and faster time-to-value.",
  no_forwards_no_cards: "Position a fuller stack: FX plus treasury, cards, and broader workflow coverage.",
  no_banking_ecosystem: "Position integrated banking-plus-payments instead of point tooling.",
  expensive_fx: "Position lower total cost for cross-border and multi-currency spend flows.",
  expensive_complex: "Position leaner implementation and lower overhead for finance teams.",
  high_fees_limited_acceptance: "Position wider acceptance and better economics for day-to-day spend.",
};

const SPARSE_INDUSTRY_PRIORS = {
  fuel_trading: {
    "FX": 0.6,
    "FX Forwards": 0.58,
    "Cards": 0.35,
  },
  property_mgmt: {
    "FX": 0.1,
    "Spend Management": 0.45,
    "Cards": 0.25,
  },
  ecommerce: {
    "Merchant Acquiring": 0.58,
    "Revolut Pay": 0.52,
    "FX": 0.24,
  },
  commodity: {
    "FX": 0.62,
    "FX Forwards": 0.6,
    "Cards": 0.2,
  },
  travel: {
    "FX": 0.56,
    "FX Forwards": 0.54,
    "Cards": 0.52,
  },
  food_processing: {
    "FX": 0.45,
    "FX Forwards": 0.4,
    "Spend Management": 0.3,
  },
};

const COMPETITOR_SCORING_EFFECTS = {
  "Stripe": {
    motion_boosts: { "Merchant Acquiring": 0.12, "API Integrations": 0.08 },
    competitor_context_delta: 0.08,
    switching_feasibility_delta: 0.06,
  },
  "Pleo": {
    motion_boosts: { "Spend Management": 0.12, "Cards": 0.07 },
    competitor_context_delta: 0.06,
    switching_feasibility_delta: 0.04,
  },
  "Wise": {
    motion_boosts: { "FX": 0.1, "Cards": 0.05 },
    competitor_context_delta: 0.07,
    switching_feasibility_delta: 0.05,
  },
  "Ebury": {
    motion_boosts: { "FX": 0.08, "FX Forwards": 0.08 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.03,
  },
  "Worldpay": {
    motion_boosts: { "Merchant Acquiring": 0.09, "Revolut Pay": 0.06 },
    competitor_context_delta: 0.06,
    switching_feasibility_delta: 0.03,
  },
  "SAP Concur": {
    motion_boosts: { "Spend Management": 0.1 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.03,
  },
  "HSBC": {
    motion_boosts: { "FX": 0.07 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: -0.08,
  },
  "Barclays": {
    motion_boosts: { "FX": 0.06, "Cards": 0.04 },
    competitor_context_delta: 0.03,
    switching_feasibility_delta: -0.07,
  },
  "NatWest": {
    motion_boosts: { "FX": 0.05 },
    competitor_context_delta: 0.02,
    switching_feasibility_delta: -0.07,
  },
  "Lloyds": {
    motion_boosts: { "FX": 0.05 },
    competitor_context_delta: 0.02,
    switching_feasibility_delta: -0.07,
  },
};

function buildSnippet(text, idx, length) {
  const start = Math.max(0, idx - 90);
  const end = Math.min(text.length, idx + length + 140);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 260);
}

function clamp01(value) {
  return Math.max(0, Math.min(Number(value || 0), 1));
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

function getFilingRecencyProfile(filingDate) {
  const daysOld = daysSinceDate(filingDate);
  if (daysOld === null) {
    return {
      days_old: null,
      signal_multiplier: 0.55,
      freshness_signal: 0.35,
      band: "unknown",
      stale: true,
    };
  }

  if (daysOld <= 180) {
    return { days_old: daysOld, signal_multiplier: 1.0, freshness_signal: 1.0, band: "0-6m", stale: false };
  }
  if (daysOld <= 365) {
    return { days_old: daysOld, signal_multiplier: 0.9, freshness_signal: 0.85, band: "6-12m", stale: false };
  }
  if (daysOld <= 548) {
    return { days_old: daysOld, signal_multiplier: 0.7, freshness_signal: 0.65, band: "12-18m", stale: true };
  }
  if (daysOld <= 730) {
    return { days_old: daysOld, signal_multiplier: 0.5, freshness_signal: 0.5, band: "18-24m", stale: true };
  }
  return { days_old: daysOld, signal_multiplier: 0.3, freshness_signal: 0.3, band: "24m+", stale: true };
}

function applyFilingRecencyDecay(motionScores, filingRecency) {
  const multiplier = Number(filingRecency?.signal_multiplier || 1);
  if (Math.abs(multiplier - 1) < 0.001) {
    return { applied: false, multiplier, adjustments: [] };
  }

  const adjustments = [];
  for (const [motion, data] of Object.entries(motionScores || {})) {
    const raw = Number(data.score || 0);
    const nextScore = clamp01(raw * multiplier);
    data.score = nextScore;
    data.filing_recency_multiplier = multiplier;
    adjustments.push({ motion, delta: Math.round((nextScore - raw) * 100) / 100 });
  }

  return {
    applied: true,
    multiplier,
    adjustments,
  };
}

function applySparseDataIndustryPriors(motionScores, categories, textLength) {
  const normalizedLength = Number(textLength || 0);
  const priorCategories = Array.isArray(categories)
    ? categories.filter((c) => !!SPARSE_INDUSTRY_PRIORS[c])
    : [];

  if (normalizedLength >= 500 || priorCategories.length === 0) {
    return {
      applied: false,
      text_length: normalizedLength,
      categories: priorCategories,
      adjustments: [],
    };
  }

  const maxPriorByMotion = {};
  for (const category of priorCategories) {
    const priors = SPARSE_INDUSTRY_PRIORS[category] || {};
    for (const [motion, priorScore] of Object.entries(priors)) {
      maxPriorByMotion[motion] = Math.max(Number(maxPriorByMotion[motion] || 0), Number(priorScore || 0));
    }
  }

  const adjustments = [];
  for (const [motion, priorScore] of Object.entries(maxPriorByMotion)) {
    if (!motionScores[motion]) continue;
    const floorScore = clamp01(Number(priorScore || 0) * 0.8);
    const raw = Number(motionScores[motion].score || 0);
    if (raw >= floorScore) continue;

    motionScores[motion].score = floorScore;
    motionScores[motion].sparse_prior_floor = floorScore;
    adjustments.push({ motion, prior_floor: floorScore, delta: Math.round((floorScore - raw) * 100) / 100 });
  }

  return {
    applied: adjustments.length > 0,
    text_length: normalizedLength,
    categories: priorCategories,
    adjustments,
  };
}

function applyCompetitorSpecificMotionAdjustments(motionScores, competitors) {
  const adjustments = [];
  const appliedByMotion = {};
  let competitorContextDelta = 0;
  let switchingFeasibilityDelta = 0;

  for (const competitor of competitors || []) {
    const config = COMPETITOR_SCORING_EFFECTS[competitor.name];
    if (!config) continue;

    competitorContextDelta += Number(config.competitor_context_delta || 0);
    switchingFeasibilityDelta += Number(config.switching_feasibility_delta || 0);

    for (const [motion, motionBoost] of Object.entries(config.motion_boosts || {})) {
      if (!motionScores[motion]) continue;
      const raw = Number(motionScores[motion].score || 0);
      const alreadyApplied = Number(appliedByMotion[motion] || 0);
      const allowedBoost = Math.max(0, 0.2 - alreadyApplied);
      const boundedBoost = Math.min(Number(motionBoost || 0), allowedBoost);
      if (boundedBoost <= 0) continue;

      const nextScore = clamp01(raw + boundedBoost);
      const actualApplied = Math.round((nextScore - raw) * 100) / 100;
      motionScores[motion].score = nextScore;
      motionScores[motion].competitor_boost = Math.round(((motionScores[motion].competitor_boost || 0) + actualApplied) * 100) / 100;
      appliedByMotion[motion] = alreadyApplied + actualApplied;
      adjustments.push({ competitor: competitor.name, motion, delta: actualApplied });
    }
  }

  return {
    adjustments,
    competitor_context_delta: Math.max(-0.12, Math.min(0.15, competitorContextDelta)),
    switching_feasibility_delta: Math.max(-0.2, Math.min(0.15, switchingFeasibilityDelta)),
  };
}

function computeMotionSynergy(motionScores) {
  const scoreOf = (motion) => Number(motionScores?.[motion]?.score || 0);
  const strong = (motion) => scoreOf(motion) >= 0.6;

  let boost = 0;
  const adjustments = [];

  if (strong("FX") && strong("Cards")) {
    boost += 0.1;
    adjustments.push({ pair: "FX+Cards", delta: 0.1, reason: "operational_lock_in" });
  }
  if (strong("Merchant Acquiring") && strong("Revolut Pay")) {
    boost += 0.08;
    adjustments.push({ pair: "Acquiring+RevolutPay", delta: 0.08, reason: "payments_ecosystem" });
  }
  if (strong("FX") && strong("FX Forwards")) {
    boost += 0.1;
    adjustments.push({ pair: "FX+Forwards", delta: 0.1, reason: "treasury_depth" });
  }

  const strongMotionCount = Object.values(motionScores || {}).filter((m) => Number(m.score || 0) > 0.5).length;
  if (strongMotionCount >= 4) {
    boost += 0.15;
    adjustments.push({ pair: "platform_deal", delta: 0.15, reason: "multi_motion_depth" });
  }

  return {
    boost: Math.min(boost, 0.2),
    strong_motion_count: strongMotionCount,
    adjustments,
  };
}

function detectCrossLayerCorrelationPenalty(params) {
  const motionScores = params?.motionScores || {};
  const painScore = Number(params?.painScore || 0);
  const qualSignals = params?.qualSignals || { positive: [] };
  const switchingFeasibility = params?.switchingFeasibility || {};

  const fxScore = Number(motionScores["FX"]?.score || 0);
  const forwardsScore = Number(motionScores["FX Forwards"]?.score || 0);
  const merchantScore = Number(motionScores["Merchant Acquiring"]?.score || 0);

  let overlapCount = 0;
  const reasons = [];

  if ((fxScore >= 0.45 || forwardsScore >= 0.4) && painScore >= 0.55) {
    overlapCount++;
    reasons.push("fx_and_pain_overlap");
  }
  if (merchantScore >= 0.45 && painScore >= 0.55) {
    overlapCount++;
    reasons.push("merchant_and_pain_overlap");
  }

  const hasInternationalExpansion = (qualSignals.positive || []).some((sig) => sig.signal === "International expansion");
  if (hasInternationalExpansion && (fxScore >= 0.4 || forwardsScore >= 0.35)) {
    overlapCount++;
    reasons.push("international_signal_reused");
  }

  const hasFragmentedBankingSignal = (qualSignals.positive || []).some((sig) => sig.signal === "Fragmented banking");
  if (hasFragmentedBankingSignal && switchingFeasibility?.has_multi_bank_signals) {
    overlapCount++;
    reasons.push("fragmented_banking_reused");
  }

  const penalty = overlapCount >= 3
    ? 0.07
    : overlapCount === 2
      ? 0.04
      : overlapCount === 1
        ? 0.015
        : 0;

  return { penalty, overlap_count: overlapCount, reasons };
}

function estimateConversionVelocity(params = {}) {
  const qualSignals = params.qualSignals || { positive: [] };
  const growth = params.growth || {};
  const filingRecency = params.filingRecency || { freshness_signal: 0.5, days_old: null };
  const switchingFeasibility = params.switchingFeasibility || { score: 0.5 };
  const competitors = params.competitors || [];

  let score = 0.32;
  const triggers = [];

  const hasSignal = (name) => (qualSignals.positive || []).some((sig) => sig.signal === name);

  if (hasSignal("New CFO/FD")) {
    score += 0.28;
    triggers.push("new_finance_leader");
  }
  if (hasSignal("Recent acquisition")) {
    score += 0.22;
    triggers.push("recent_mna");
  }
  if (hasSignal("Headcount growth")) {
    score += 0.12;
    triggers.push("headcount_growth");
  }

  score += (Number(filingRecency.freshness_signal || 0.5) - 0.5) * 0.4;

  const growthTrend = String(growth.trend || "");
  if (growthTrend === "strong_growth" || growthTrend === "growing") {
    score += 0.1;
    triggers.push("growth_momentum");
  }
  if (growthTrend === "declining" || growthTrend === "sharp_decline") {
    score -= 0.12;
    triggers.push("growth_decline_drag");
  }

  const switchingScore = Number(switchingFeasibility.score || 0.5);
  if (switchingScore >= 0.68) {
    score += 0.1;
    triggers.push("switchable_profile");
  } else if (switchingScore < 0.4) {
    score -= 0.1;
    triggers.push("switching_friction");
  }

  const hasStickyBank = (competitors || []).some((c) => ["HSBC", "Barclays", "NatWest", "Lloyds"].includes(c.name));
  if (hasStickyBank) {
    score -= 0.07;
    triggers.push("sticky_incumbent");
  }

  if (triggers.length === 0) {
    score -= 0.08;
  } else if (triggers.length >= 3) {
    score += 0.06;
  }

  const normalized = clamp01(score);
  const band = normalized >= 0.68 ? "high" : normalized >= 0.5 ? "medium" : "low";
  const estimatedMonths = band === "high" ? "3-6" : band === "medium" ? "6-12" : "12+";

  return {
    score: normalized,
    band,
    estimated_months_to_convert: estimatedMonths,
    triggers,
  };
}

function buildConfidenceInterval(score, evidenceConfidence, filingRecency, textLength, motionScores) {
  const confidence = clamp01(evidenceConfidence);
  const recencyMultiplier = clamp01(filingRecency?.signal_multiplier ?? 0.6);
  const normalizedTextLength = Number(textLength || 0);
  const activeMotions = Object.values(motionScores || {}).filter((m) => Number(m.score || 0) >= 0.25).length;

  let plusMinus = 0.06;
  plusMinus += (1 - confidence) * 0.24;
  plusMinus += (1 - recencyMultiplier) * 0.14;
  if (normalizedTextLength < 500) plusMinus += 0.08;
  if (activeMotions < 2) plusMinus += 0.05;

  plusMinus = Math.min(0.38, Math.max(0.04, plusMinus));

  const lower = clamp01(Number(score || 0) - plusMinus);
  const upper = clamp01(Number(score || 0) + plusMinus);
  const confidenceLevel = plusMinus <= 0.11 ? "high" : plusMinus <= 0.21 ? "medium" : "low";

  const reasons = [];
  if (normalizedTextLength < 500) reasons.push("thin_filing_text");
  if (recencyMultiplier < 0.7) reasons.push("stale_filing_signals");
  if (activeMotions < 2) reasons.push("limited_motion_evidence");
  if (confidence < 0.55) reasons.push("low_evidence_confidence");

  return {
    lower: Math.round(lower * 100) / 100,
    upper: Math.round(upper * 100) / 100,
    plus_minus: Math.round(plusMinus * 100) / 100,
    confidence_level: confidenceLevel,
    display: {
      score_10: Math.round(Number(score || 0) * 100) / 10,
      plus_minus_10: Math.round(plusMinus * 100) / 10,
    },
    reasons,
  };
}

function computeDataFingerprint(meta = {}) {
  const filingDate = meta.latest_filing_date || "none";
  const textLength = Number(meta.text_length || 0);
  const filingCount = Number(meta.filing_count || 0);
  const turnover = Number(meta.turnover || 0);
  const chargeMarker = meta.charge_marker || "none";
  return `${filingDate}|${textLength}|${filingCount}|${turnover}|${chargeMarker}`;
}

function deriveScoreVolatility(previousScore, nextScore, dataFingerprint) {
  if (!previousScore || Number(previousScore.composite_score) === 0) {
    return {
      delta: 0,
      delta_points: 0,
      band: "initial",
      data_changed: true,
      instability_flag: false,
      data_fingerprint: dataFingerprint,
    };
  }

  const prev = Number(previousScore.composite_score || 0);
  const next = Number(nextScore.composite_score || 0);
  const delta = Math.abs(next - prev);
  const prevFingerprint = previousScore?.volatility?.data_fingerprint || null;
  const dataChanged = !prevFingerprint || prevFingerprint !== dataFingerprint;

  const band = delta <= 0.03
    ? "stable"
    : delta <= 0.14
      ? "moderate"
      : "high";

  return {
    delta: Math.round(delta * 100) / 100,
    delta_points: Math.round(delta * 10000) / 100,
    band,
    data_changed: dataChanged,
    instability_flag: band === "high" && !dataChanged,
    data_fingerprint: dataFingerprint,
  };
}

function recordScoreHistory(companyNumber, score, fingerprint) {
  const key = `score_history_${companyNumber}`;
  const history = getSetting(key, []);
  const safeHistory = Array.isArray(history) ? history : [];
  safeHistory.push({
    scored_at: score.scored_at,
    composite_score: score.composite_score,
    fit_score: score.fit_score,
    propensity_score: score.propensity_score,
    fingerprint,
  });
  const trimmed = safeHistory.slice(-20);
  setSetting(key, trimmed);
  return trimmed;
}

function buildScoreExplanation(params = {}) {
  const fitScore = Number(params.fitScore || 0);
  const propensityScore = Number(params.propensityScore || 0);
  const compositeScore = Number(params.compositeScore || 0);
  const bestMotion = params.bestMotion || "Unknown";
  const velocity = params.velocity || { band: "medium" };
  const confidenceInterval = params.confidenceInterval || { confidence_level: "medium" };
  const synergy = params.synergy || { adjustments: [] };
  const correlation = params.correlation || { penalty: 0 };
  const switching = params.switchingFeasibility || { score: 0.5 };

  const drivers = [
    `Best motion: ${bestMotion}`,
    `Fit ${(fitScore * 10).toFixed(1)}/10`,
    `Propensity ${(propensityScore * 10).toFixed(1)}/10`,
    `Velocity ${velocity.band}`,
  ];

  if (synergy.adjustments?.length) {
    drivers.push(`Multi-product synergy +${Math.round((synergy.boost || 0) * 100)} pts`);
  }

  const risks = [];
  if (switching.score < 0.4) risks.push("Low switching feasibility");
  if (confidenceInterval.confidence_level === "low") risks.push("Low confidence interval");
  if (Number(correlation.penalty || 0) > 0.03) risks.push("Cross-layer overlap penalty applied");

  return {
    headline: `${(compositeScore * 10).toFixed(1)}/10 with ${confidenceInterval.confidence_level} confidence`,
    drivers,
    risks,
  };
}

function computeProductFitGate(score) {
  if (score < 0.15) return 0.35;
  if (score < 0.25) return 0.6;
  if (score < 0.35) return 0.8;
  return 1;
}

function inferIndustryPriorCategories(text, industries = []) {
  const rawText = String(text || "");
  const categories = new Set();

  for (const [category, patterns] of Object.entries(INDUSTRY_PRIOR_PATTERNS)) {
    if ((patterns || []).some((pattern) => pattern.test(rawText))) {
      categories.add(category);
    }
  }

  if (industries.includes("commodity")) categories.add("commodity");
  if (industries.includes("ecommerce")) categories.add("ecommerce");
  if (industries.includes("travel") || industries.includes("hospitality")) categories.add("travel");
  if (industries.includes("property")) categories.add("property_mgmt");
  if (industries.includes("food")) categories.add("food_processing");

  return [...categories];
}

function getMotionIndustryMultiplier(motion, categories) {
  let multiplier = 1;
  for (const category of categories || []) {
    const categoryMultiplier = Number(INDUSTRY_MOTION_MULTIPLIERS?.[category]?.[motion] || 1);
    multiplier = Math.max(multiplier, categoryMultiplier);
  }
  return multiplier;
}

function applyIndustryMotionCalibration(motionScores, industries, text) {
  const categories = inferIndustryPriorCategories(text, industries);
  if (categories.length === 0) {
    return { industries: industries || [], prior_categories: [], adjustments: [] };
  }

  const adjustments = [];
  for (const [motion, data] of Object.entries(motionScores || {})) {
    const raw = Number(data.score || 0);
    const multiplier = getMotionIndustryMultiplier(motion, categories);
    if (Math.abs(multiplier - 1) < 0.001) continue;

    const nextScore = clamp01(raw * multiplier);
    data.score = nextScore;
    data.industry_prior_multiplier = multiplier;
    adjustments.push({
      motion,
      multiplier,
      delta: Math.round((nextScore - raw) * 100) / 100,
    });
  }

  return {
    industries: industries || [],
    prior_categories: categories,
    adjustments,
  };
}

function applyMotionQualificationGates(motionScores, text) {
  const hasForwardsQualifier = FX_FORWARDS_QUALIFIER_PATTERNS.some((pattern) => pattern.test(text || ""));
  const hasMerchantQualifier = MERCHANT_RELEVANCE_PATTERNS.some((pattern) => pattern.test(text || ""));
  const adjustments = [];

  if (motionScores["FX Forwards"] && !hasForwardsQualifier) {
    const raw = Number(motionScores["FX Forwards"].score || 0);
    const capped = Math.min(raw, 0.45);
    if (capped < raw) {
      motionScores["FX Forwards"].score = capped;
      motionScores["FX Forwards"].qualification_gate = "forwards_exposure_required";
      adjustments.push({ motion: "FX Forwards", reason: "missing_hedgeable_exposure", delta: Math.round((capped - raw) * 100) / 100 });
    }
  }

  if (motionScores["Revolut Pay"]) {
    const raw = Number(motionScores["Revolut Pay"].score || 0);
    const merchantEvidence = Number(motionScores["Merchant Acquiring"]?.score || 0);
    let capped = raw;

    if (merchantEvidence < 0.3) {
      capped = Math.min(capped, 0.25);
    }

    if (!hasMerchantQualifier && merchantEvidence < 0.25) {
      capped = Math.min(capped, 0.35);
    }

    if (capped < raw) {
      motionScores["Revolut Pay"].score = capped;
      motionScores["Revolut Pay"].qualification_gate = "acquiring_dependency_required";
      adjustments.push({
        motion: "Revolut Pay",
        reason: merchantEvidence < 0.3 ? "insufficient_acquiring_evidence" : "missing_merchant_relevance",
        delta: Math.round((capped - raw) * 100) / 100,
      });
    }
  }

  return {
    has_forwards_qualifier: hasForwardsQualifier,
    has_merchant_qualifier: hasMerchantQualifier,
    adjustments,
  };
}

function recomputeMotionWeightsAndFit(motionScores) {
  let bestMotion = null;
  let bestMotionScore = 0;
  let totalWeightedFit = 0;

  for (const [motion, data] of Object.entries(motionScores || {})) {
    const score = clamp01(data.score);
    const gpWeight = PRODUCT_GP_WEIGHTS[motion] || 0.5;
    const weighted = score * gpWeight;

    data.score = score;
    data.weighted = weighted;
    data.fit_level = score >= 0.5 ? "strong" : score >= 0.25 ? "medium" : "weak";

    totalWeightedFit += weighted;
    if (weighted > bestMotionScore) {
      bestMotionScore = weighted;
      bestMotion = motion;
    }
  }

  return {
    best_motion: bestMotion,
    best_score: bestMotionScore,
    product_fit_score: clamp01(totalWeightedFit / 3),
  };
}

function computeEvidenceConfidence(text, filings, motionScores) {
  const contentLength = String(text || "").trim().length;
  const textSignal = Math.min(contentLength / 9000, 1) * 0.35;

  const filingsWithText = (filings || []).filter((f) => !!f.raw_data).length;
  const filingsSignal = Math.min(filingsWithText / 3, 1) * 0.2;

  const evidencePoints = Object.values(motionScores || {}).reduce((sum, motion) => {
    return sum + (Array.isArray(motion.evidence) ? motion.evidence.length : 0);
  }, 0);
  const evidenceSignal = Math.min(evidencePoints / 12, 1) * 0.25;

  const motionsAboveThreshold = Object.values(motionScores || {}).filter((motion) => Number(motion.score || 0) >= 0.25).length;
  const breadthSignal = Math.min(motionsAboveThreshold / 4, 1) * 0.2;

  const confidence = 0.15 + textSignal + filingsSignal + evidenceSignal + breadthSignal;
  return clamp01(confidence);
}

function detectCreditGapPenalty(text, competitors, chargeSummary) {
  const rawText = String(text || "");
  const outstandingCharges = Number(chargeSummary?.outstanding_count || 0);
  const hasChargeCreditSignals = outstandingCharges > 0;
  const hasCreditSignals = CREDIT_GAP_PATTERNS.some((pattern) => pattern.test(rawText)) || hasChargeCreditSignals;
  const hasBankLender = !!chargeSummary?.has_bank_lender;
  const hasLongTenureCharge = !!chargeSummary?.long_tenure_incumbent || Number(chargeSummary?.oldest_outstanding_age_years || 0) >= 10;
  const hasStrongBankIncumbent = (competitors || []).some(
    (competitor) => ["HSBC", "Barclays", "NatWest", "Lloyds"].includes(competitor.name)
  ) || hasBankLender;

  let penalty = 0;
  let signal = null;

  if (hasCreditSignals && hasStrongBankIncumbent) {
    penalty = hasChargeCreditSignals ? 0.18 : 0.14;
    signal = "credit_gap_high";
  } else if (hasCreditSignals) {
    penalty = hasChargeCreditSignals ? 0.11 : 0.08;
    signal = "credit_gap_medium";
  }

  if (penalty > 0 && hasLongTenureCharge) {
    penalty = Math.min(0.24, penalty + 0.04);
    signal = `${signal || "credit_gap"}_long_tenure`;
  }

  return {
    penalty,
    signal,
    charge_data_available: !!chargeSummary,
  };
}

function scoreSwitchingFeasibility(text, competitors, qualSignals, chargeSummary, competitorTuning = null) {
  const rawText = String(text || "");
  const outstandingCharges = Number(chargeSummary?.outstanding_count || 0);
  const uniqueLenders = Number(chargeSummary?.unique_lenders || 0);
  const hasChargeCreditSignals = outstandingCharges > 0;
  const hasMultipleLendersFromCharges = !!chargeSummary?.has_multiple_lenders || uniqueLenders >= 2;
  const hasLongTenureFromCharges = !!chargeSummary?.long_tenure_incumbent || Number(chargeSummary?.oldest_outstanding_age_years || 0) >= 10;
  const hasCreditSignals = CREDIT_GAP_PATTERNS.some((pattern) => pattern.test(rawText)) || hasChargeCreditSignals;
  const hasMultiBankSignals = MULTI_BANKING_PATTERNS.some((pattern) => pattern.test(rawText)) || hasMultipleLendersFromCharges;
  const hasLongTenureIncumbent = LONG_TENURE_INCBUMBENT_PATTERNS.some((pattern) => pattern.test(rawText)) || hasLongTenureFromCharges;
  const hasBankLender = !!chargeSummary?.has_bank_lender;
  const hasStrongBankIncumbent = (competitors || []).some(
    (competitor) => ["HSBC", "Barclays", "NatWest", "Lloyds"].includes(competitor.name)
  ) || hasBankLender;
  const hasNewFinanceLeadership = (qualSignals?.positive || []).some((sig) => sig.signal === "New CFO/FD");

  let score = 0.55;
  const adjustments = [];

  if (hasCreditSignals && hasStrongBankIncumbent) {
    const impact = hasChargeCreditSignals ? -0.28 : -0.25;
    score += impact;
    adjustments.push({ reason: "credit_gap_with_strong_incumbent", impact });
  } else if (hasCreditSignals) {
    const impact = hasChargeCreditSignals ? -0.18 : -0.15;
    score += impact;
    adjustments.push({ reason: "credit_gap_signal", impact });
  }

  if (hasStrongBankIncumbent) {
    score -= 0.08;
    adjustments.push({ reason: "strong_incumbent_presence", impact: -0.08 });
  }

  if (hasLongTenureIncumbent) {
    score -= 0.08;
    adjustments.push({ reason: "long_tenure_incumbent", impact: -0.08 });
  }

  if (hasMultiBankSignals) {
    const impact = hasMultipleLendersFromCharges ? 0.14 : 0.12;
    score += impact;
    adjustments.push({ reason: "fragmented_banking_bonus", impact });
  }

  if (hasNewFinanceLeadership) {
    score += 0.06;
    adjustments.push({ reason: "new_finance_leadership", impact: 0.06 });
  }

  if (chargeSummary && outstandingCharges === 0) {
    score += 0.05;
    adjustments.push({ reason: "no_recorded_charge_dependency", impact: 0.05 });
  }

  if ((qualSignals?.negative || []).length > 0) {
    score -= 0.04;
    adjustments.push({ reason: "negative_qualification_drag", impact: -0.04 });
  }

  const competitorFeasibilityDelta = Number(competitorTuning?.switching_feasibility_delta || 0);
  if (competitorFeasibilityDelta !== 0) {
    score += competitorFeasibilityDelta;
    adjustments.push({ reason: "competitor_specific_feasibility", impact: competitorFeasibilityDelta });
  }

  return {
    score: clamp01(score),
    has_credit_signals: hasCreditSignals,
    has_multi_bank_signals: hasMultiBankSignals,
    has_long_tenure_incumbent: hasLongTenureIncumbent,
    has_strong_bank_incumbent: hasStrongBankIncumbent,
    charge_data_available: !!chargeSummary,
    charge_summary: chargeSummary ? {
      outstanding_count: outstandingCharges,
      unique_lenders: uniqueLenders,
      has_bank_lender: hasBankLender,
      oldest_outstanding_age_years: chargeSummary.oldest_outstanding_age_years ?? null,
    } : null,
    adjustments,
  };
}

function computeGpPotential(productFitScore, commercialValue, bestMotionWeightedScore) {
  return clamp01((bestMotionWeightedScore * 0.65) + (commercialValue * 0.35) + (productFitScore * 0.1));
}

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
  { pattern: /material\s+uncertainty.*(?:going\s+concern|ability\s+to\s+continue)/i, signal: "Going concern doubt", weight: -0.3 },
  { pattern: /(?:doubt|uncertain).*(?:ability\s+to\s+continue\s+as\s+a\s+going\s+concern)/i, signal: "Going concern doubt", weight: -0.3 },
  { pattern: /(?:company|entity)\s+(?:is\s+)?(?:in\s+)?(?:administration|liquidation|receivership)/i, signal: "Distressed", weight: -0.5 },
  { pattern: /(?:company|entity)\s+(?:has\s+been|is|was)\s+dormant/i, signal: "Dormant/Non-trading", weight: -0.5 },
  { pattern: /(?:ceased?\s+trading|closure\s+of\s+(?:the\s+)?(?:business|company|operations))/i, signal: "Ceased trading", weight: -0.5 },
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
    const match = text.match(config.regex);
    if (match) {
      detected.push({
        name,
        products: config.products,
        weakness: config.weakness,
        stickiness: config.stickiness,
        snippet: buildSnippet(text, match.index || 0, match[0]?.length || name.length),
        inferred_advantage: COMPETITOR_ADVANTAGE_INFERENCE[config.weakness] || "Position lower-friction migration with stronger day-to-day economics.",
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
  const latestFilingDate = latestFiling?.filing_date || filings[0]?.filing_date || null;
  const text = latestFiling?.raw_data || "";
  const textLength = String(text).trim().length;
  const turnover = monitored.latest_turnover || 0;
  const chargeSummary = getCompanyChargeSummary(companyNumber, null);
  const previousStored = getSetting(`score_${companyNumber}`, null);
  const filingRecency = getFilingRecencyProfile(latestFilingDate);

  const motionScores = {};

  for (const motion of PRODUCT_MOTIONS) {
    const { score, evidence } = scoreMotionFromText(text, motion);
    motionScores[motion] = {
      score,
      weighted: 0,
      evidence,
      fit_level: score >= 0.5 ? "strong" : score >= 0.25 ? "medium" : "weak",
    };
  }

  const industries = detectIndustry(text);
  const priorCategories = inferIndustryPriorCategories(text, industries);
  const qualificationGates = applyMotionQualificationGates(motionScores, text);
  const sparsePriors = applySparseDataIndustryPriors(motionScores, priorCategories, textLength);
  const industryCalibration = applyIndustryMotionCalibration(motionScores, industries, text);
  const filingDecay = applyFilingRecencyDecay(motionScores, filingRecency);
  const competitors = detectCompetitors(text);
  const competitorMotionTuning = applyCompetitorSpecificMotionAdjustments(motionScores, competitors);
  const motionSummary = recomputeMotionWeightsAndFit(motionScores);

  const productFitScore = motionSummary.product_fit_score;
  const bestMotionScore = motionSummary.best_score;
  const bestMotion = motionSummary.best_motion;
  const commercialValue = scoreCommercialValue(turnover);
  const growth = scoreGrowth(filings);
  const employees = extractEmployeeCount(text);
  const competitorContextBase = scoreCompetitorContext(competitors);
  const competitorScore = clamp01(competitorContextBase + Number(competitorMotionTuning.competitor_context_delta || 0));
  const qualSignals = detectQualificationSignals(text);
  const switchingFeasibility = scoreSwitchingFeasibility(text, competitors, qualSignals, chargeSummary, competitorMotionTuning);
  const evidenceConfidenceRaw = computeEvidenceConfidence(text, filings, motionScores);
  const evidenceConfidence = clamp01(
    (evidenceConfidenceRaw * 0.72)
    + (Number(filingRecency.signal_multiplier || 0.55) * 0.28)
    - (sparsePriors.applied ? 0.08 : 0)
  );

  const positiveBoost = qualSignals.positive.reduce((s, sig) => s + sig.weight, 0);
  const negativeImpact = qualSignals.negative.reduce((s, sig) => s + sig.weight, 0);
  const urgencyScore = Math.min(
    Math.max(
      growth.score + (positiveBoost * Number(filingRecency.signal_multiplier || 0.55)),
      0
    ),
    1
  );

  const velocity = estimateConversionVelocity({
    qualSignals,
    growth,
    filingRecency,
    switchingFeasibility,
    competitors,
  });

  const painScore = Math.min(
    (motionScores["FX"]?.score || 0) * 0.25 +
    (motionScores["Cards"]?.score || 0) * 0.20 +
    (motionScores["Spend Management"]?.score || 0) * 0.20 +
    (motionScores["Merchant Acquiring"]?.score || 0) * 0.20 +
    (employees && employees > 200 ? 0.15 : employees && employees > 50 ? 0.08 : 0),
    1
  );

  const synergy = computeMotionSynergy(motionScores);

  const fitWeightTotal =
    SCORING_WEIGHTS.product_fit
    + SCORING_WEIGHTS.commercial_value
    + SCORING_WEIGHTS.pain_strength
    + SCORING_WEIGHTS.competitor_context
    + SCORING_WEIGHTS.switching_feasibility;

  const fitScoreBase = (
    productFitScore * SCORING_WEIGHTS.product_fit +
    commercialValue * SCORING_WEIGHTS.commercial_value +
    painScore * SCORING_WEIGHTS.pain_strength +
    competitorScore * SCORING_WEIGHTS.competitor_context +
    switchingFeasibility.score * SCORING_WEIGHTS.switching_feasibility
  ) / fitWeightTotal;

  const fitScore = clamp01(fitScoreBase + Number(synergy.boost || 0));

  const propensityScore = clamp01((urgencyScore * 0.65) + (velocity.score * 0.35));
  const preGateComposite = (fitScore * 0.6) + (propensityScore * 0.4);

  const productFitGate = computeProductFitGate(productFitScore);
  const confidenceMultiplier = 0.65 + (evidenceConfidence * 0.35);
  const creditGap = detectCreditGapPenalty(text, competitors, chargeSummary);
  const correlationPenalty = detectCrossLayerCorrelationPenalty({
    motionScores,
    painScore,
    qualSignals,
    switchingFeasibility,
  });

  let compositeScore = preGateComposite;
  compositeScore = compositeScore * productFitGate;
  compositeScore = compositeScore + negativeImpact;
  compositeScore = compositeScore * confidenceMultiplier;
  compositeScore = compositeScore - Number(creditGap.penalty || 0);
  compositeScore = compositeScore - Number(correlationPenalty.penalty || 0);
  compositeScore = Math.max(compositeScore, 0);
  compositeScore = Math.round(compositeScore * 100) / 100;

  const gpPotentialScore = computeGpPotential(productFitScore, commercialValue, bestMotionScore);
  const confidenceInterval = buildConfidenceInterval(compositeScore, evidenceConfidence, filingRecency, textLength, motionScores);
  const dataFingerprint = computeDataFingerprint({
    latest_filing_date: latestFilingDate,
    text_length: textLength,
    filing_count: filings.length,
    turnover,
    charge_marker: chargeSummary?.latest_charge_created_on || chargeSummary?.fetched_at || "none",
  });
  const volatility = deriveScoreVolatility(previousStored, { composite_score: compositeScore }, dataFingerprint);

  const eligibleMotions = Object.entries(motionScores)
    .filter(([, v]) => v.score >= 0.25)
    .sort(([, a], [, b]) => b.weighted - a.weighted)
    .map(([motion, data]) => ({ motion, ...data }));

  const result = {
    company_number: companyNumber,
    company_name: monitored.company_name,
    turnover,
    composite_score: compositeScore,
    fit_score: Math.round(fitScore * 100) / 100,
    propensity_score: Math.round(propensityScore * 100) / 100,
    gp_potential_score: gpPotentialScore,
    velocity,
    synergy,
    confidence_interval: confidenceInterval,
    volatility,
    layers: {
      product_fit: { score: productFitScore, best_motion: bestMotion, best_score: bestMotionScore },
      commercial_value: { score: commercialValue },
      pain_strength: { score: painScore },
      urgency: { score: urgencyScore, trend: growth.trend, growth_rate: growth.rate },
      competitor_context: { score: competitorScore, detected: competitors },
      switching_feasibility: switchingFeasibility,
    },
    eligible_motions: eligibleMotions,
    all_motion_scores: motionScores,
    employees,
    growth,
    industries,
    competitors,
    qualification: qualSignals,
    charge_summary: chargeSummary,
    filing_recency: filingRecency,
    sparse_priors: sparsePriors,
    confidence: {
      evidence: Math.round(evidenceConfidence * 100) / 100,
      evidence_raw: Math.round(evidenceConfidenceRaw * 100) / 100,
      product_fit_gate: productFitGate,
      confidence_multiplier: Math.round(confidenceMultiplier * 100) / 100,
      credit_gap_penalty: creditGap.penalty,
      credit_gap_signal: creditGap.signal,
      charge_data_available: !!chargeSummary,
      switching_feasibility: switchingFeasibility.score,
      industry_signals: industries,
      prior_categories: priorCategories,
      qualification_gates: qualificationGates,
      filing_decay: filingDecay,
      sparse_prior_adjustments: sparsePriors.adjustments,
      competitor_tuning: competitorMotionTuning,
      cross_layer_penalty: correlationPenalty,
      industry_calibration: industryCalibration,
      pre_gate_composite: Math.round(preGateComposite * 100) / 100,
    },
    score_explanation: buildScoreExplanation({
      fitScore,
      propensityScore,
      compositeScore,
      bestMotion,
      velocity,
      confidenceInterval,
      synergy,
      correlation: correlationPenalty,
      switchingFeasibility,
    }),
    has_filing_text: !!text,
    scored_at: new Date().toISOString(),
  };

  recordScoreHistory(companyNumber, result, dataFingerprint);
  setSetting(`score_${companyNumber}`, result);
  return result;
}

export function getStoredScore(companyNumber) {
  return getSetting(`score_${companyNumber}`, null);
}

function normalizeMotionKey(rawProduct) {
  const value = String(rawProduct || "").toLowerCase();
  return Object.keys(PRODUCT_GP_WEIGHTS).find(
    (k) => k.toLowerCase() === value || value.includes(k.toLowerCase())
  ) || null;
}

function recomputeMotionLayers(baseResult) {
  let bestMotion = null;
  let bestWeighted = -1;
  let totalWeighted = 0;

  for (const [motion, motionData] of Object.entries(baseResult.all_motion_scores || {})) {
    const gpWeight = PRODUCT_GP_WEIGHTS[motion] || 0.5;
    const weighted = Math.min(Math.max(Number(motionData.score || 0), 0), 1) * gpWeight;
    motionData.weighted = weighted;
    motionData.fit_level = motionData.score >= 0.5 ? "strong" : motionData.score >= 0.25 ? "medium" : "weak";

    totalWeighted += weighted;
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestMotion = motion;
    }
  }

  const productFitScore = Math.min(totalWeighted / 3, 1);
  if (baseResult.layers?.product_fit) {
    baseResult.layers.product_fit.score = productFitScore;
    baseResult.layers.product_fit.best_motion = bestMotion;
    baseResult.layers.product_fit.best_score = Math.max(bestWeighted, 0);
  }

  const commercialValue = Number(baseResult.layers?.commercial_value?.score || 0);
  baseResult.gp_potential_score = computeGpPotential(productFitScore, commercialValue, Math.max(bestWeighted, 0));

  const painScore = Number(baseResult.layers?.pain_strength?.score || 0);
  const competitorScore = Number(baseResult.layers?.competitor_context?.score || 0);
  const switchingScore = Number(baseResult.layers?.switching_feasibility?.score || 0.5);
  const fitWeightTotal =
    SCORING_WEIGHTS.product_fit
    + SCORING_WEIGHTS.commercial_value
    + SCORING_WEIGHTS.pain_strength
    + SCORING_WEIGHTS.competitor_context
    + SCORING_WEIGHTS.switching_feasibility;

  const fitScoreBase = (
    productFitScore * SCORING_WEIGHTS.product_fit
    + commercialValue * SCORING_WEIGHTS.commercial_value
    + painScore * SCORING_WEIGHTS.pain_strength
    + competitorScore * SCORING_WEIGHTS.competitor_context
    + switchingScore * SCORING_WEIGHTS.switching_feasibility
  ) / fitWeightTotal;

  const synergy = computeMotionSynergy(baseResult.all_motion_scores || {});
  baseResult.synergy = synergy;
  baseResult.fit_score = clamp01(fitScoreBase + Number(synergy.boost || 0));

  if (!baseResult.velocity) {
    const urgency = clamp01(Number(baseResult.layers?.urgency?.score || 0.5));
    const freshness = clamp01(Number(baseResult.filing_recency?.freshness_signal || 0.5));
    const switchability = clamp01(Number(baseResult.layers?.switching_feasibility?.score || 0.5));
    const velocityScore = clamp01((urgency * 0.6) + (freshness * 0.2) + (switchability * 0.2));
    baseResult.velocity = {
      score: velocityScore,
      band: velocityScore >= 0.75 ? "high" : velocityScore >= 0.5 ? "medium" : "low",
      estimated_months_to_convert: velocityScore >= 0.75 ? "3-6" : velocityScore >= 0.5 ? "6-12" : "12+",
      triggers: [],
    };
  }

  if (baseResult.propensity_score === undefined || baseResult.propensity_score === null) {
    const urgency = clamp01(Number(baseResult.layers?.urgency?.score || 0));
    const velocityScore = clamp01(Number(baseResult.velocity?.score || 0.5));
    baseResult.propensity_score = clamp01((urgency * 0.65) + (velocityScore * 0.35));
  }

  baseResult.eligible_motions = Object.entries(baseResult.all_motion_scores || {})
    .filter(([, v]) => Number(v.score || 0) >= 0.25)
    .sort(([, a], [, b]) => Number(b.weighted || 0) - Number(a.weighted || 0))
    .map(([motion, data]) => ({ motion, ...data }));
}

export function integrateAnalysis(baseResult, analysis) {
  if (!analysis || analysis.source === "no_filing_data" || analysis.source === "no_data") return baseResult;

  const previousStored = getSetting(`score_${baseResult.company_number}`, null);

  let boost = 0;
  const llmMotionBoosts = {};
  const supplementary = analysis.supplementary_context || {};
  const evidenceConfidence = Number(baseResult?.confidence?.evidence || 0.5);
  const confidenceScale = 0.5 + (Math.max(0, Math.min(evidenceConfidence, 1)) * 0.5);

  if (analysis.opportunities) {
    for (const opp of analysis.opportunities) {
      const motionKey = normalizeMotionKey(opp.product);
      if (motionKey && baseResult.all_motion_scores[motionKey]) {
        const confBoost = opp.confidence === "high" ? 0.15 : opp.confidence === "medium" ? 0.08 : 0.03;
        llmMotionBoosts[motionKey] = (llmMotionBoosts[motionKey] || 0) + confBoost;
      }
    }
  }

  const recommendedUseCases = analysis?.level5_extraction?.revolut_opportunity?.recommended_use_cases || [];
  for (const useCase of recommendedUseCases.slice(0, 4)) {
    const motionKey = normalizeMotionKey(useCase.product);
    if (!motionKey || !baseResult.all_motion_scores[motionKey]) continue;

    const priority = String(useCase.priority || "").toLowerCase();
    const priorityBoost = priority === "high" ? 0.1 : priority === "medium" ? 0.05 : 0.02;
    llmMotionBoosts[motionKey] = (llmMotionBoosts[motionKey] || 0) + priorityBoost;
  }

  const newsSignals = supplementary.news_signals || [];
  const mnaSignals = supplementary.mna_signals || [];
  const peopleResearch = supplementary.people_research || [];
  const joinedNews = newsSignals.map((n) => `${n.signal || ""} ${n.relevance || ""}`).join(" ");

  if (newsSignals.length > 0) {
    boost += Math.min(newsSignals.length * 0.01, 0.03);
  }
  if (mnaSignals.length > 0) {
    boost += Math.min(mnaSignals.length * 0.012, 0.05);
    llmMotionBoosts["API Integrations"] = (llmMotionBoosts["API Integrations"] || 0) + 0.05;
    llmMotionBoosts["Spend Management"] = (llmMotionBoosts["Spend Management"] || 0) + 0.03;
  }
  if (peopleResearch.length > 0) {
    boost += Math.min(peopleResearch.length * 0.004, 0.02);
  }

  if (/international|overseas|global|cross[- ]?border|export|import|multi[- ]?currency/i.test(joinedNews)) {
    llmMotionBoosts["FX"] = (llmMotionBoosts["FX"] || 0) + 0.05;
    llmMotionBoosts["FX Forwards"] = (llmMotionBoosts["FX Forwards"] || 0) + 0.03;
  }

  if (/checkout|e-?commerce|online|payment|merchant|POS|point\s+of\s+sale/i.test(joinedNews)) {
    llmMotionBoosts["Merchant Acquiring"] = (llmMotionBoosts["Merchant Acquiring"] || 0) + 0.05;
    llmMotionBoosts["Revolut Pay"] = (llmMotionBoosts["Revolut Pay"] || 0) + 0.04;
  }

  if (analysis.pain_indicators) {
    const highPains = analysis.pain_indicators.filter((p) => p.severity === "high").length;
    const medPains = analysis.pain_indicators.filter((p) => p.severity === "medium").length;
    boost += highPains * 0.04 + medPains * 0.02;
  }

  if (analysis.international_exposure?.present) boost += 0.03;
  if (analysis.competitors_detected?.length > 0) {
    const weakComps = analysis.competitors_detected.filter((c) =>
      c.displacement_angle?.toLowerCase().includes("high") || c.displacement_angle?.toLowerCase().includes("cost")
    ).length;
    boost += weakComps * 0.02;
  }

  const integrationCoverageSignals = [
    (analysis.pain_indicators || []).length > 0,
    (analysis.opportunities || []).length > 0,
    !!analysis.international_exposure?.present,
    (analysis.competitors_detected || []).length > 0,
    (analysis?.level5_extraction?.pain_register || []).length > 0,
    (analysis?.level5_extraction?.revolut_opportunity?.recommended_use_cases || []).length > 0,
    (analysis?.level5_extraction?.sequence_inputs ? Object.keys(analysis.level5_extraction.sequence_inputs).length > 0 : false),
    newsSignals.length > 0,
    mnaSignals.length > 0,
    peopleResearch.length > 0,
  ];
  const coveredSignals = integrationCoverageSignals.filter(Boolean).length;
  const coverageRatio = integrationCoverageSignals.length > 0
    ? coveredSignals / integrationCoverageSignals.length
    : 0;
  const coverageBoost = Math.min(coverageRatio * 0.08, 0.08);
  boost += coverageBoost;

  const lowEvidencePenalty = baseResult.has_filing_text ? 0 : 0.04;
  boost -= lowEvidencePenalty;

  for (const [motion, extraScore] of Object.entries(llmMotionBoosts)) {
    if (baseResult.all_motion_scores[motion]) {
      const boundedMotionBoost = Math.min(extraScore, MOTION_LLM_BOOST_CAP) * confidenceScale;
      baseResult.all_motion_scores[motion].score = Math.min(baseResult.all_motion_scores[motion].score + boundedMotionBoost, 1);
      baseResult.all_motion_scores[motion].llm_boost = Math.round(boundedMotionBoost * 100) / 100;
      baseResult.all_motion_scores[motion].llm_boost_raw = Math.round(extraScore * 100) / 100;
    }
  }

  recomputeMotionLayers(baseResult);

  const deterministicBase = clamp01(Number(baseResult.composite_score || 0));
  const relativeBoostLimit = deterministicBase * 0.5;
  const boostCap = Math.min(TOTAL_LLM_BOOST_CAP, relativeBoostLimit);
  const boundedBoost = Math.max(LLM_MAX_DOWNSIDE, Math.min(boost, boostCap));
  const newComposite = Math.max(0, Math.min(Math.round((baseResult.composite_score + boundedBoost) * 100) / 100, 1));
  baseResult.composite_score = newComposite;
  const propensityBase = clamp01(Number(baseResult.propensity_score ?? baseResult.layers?.urgency?.score ?? 0));
  const propensityLift = Math.max(0, boundedBoost) * 0.8;
  baseResult.propensity_score = clamp01(propensityBase + propensityLift);
  baseResult.llm_integrated = true;
  baseResult.analysis_summary = analysis.summary || null;
  baseResult.recommended_approach = analysis.recommended_approach || null;
  baseResult.integration_quality = {
    covered_signals: coveredSignals,
    total_signals: integrationCoverageSignals.length,
    coverage_ratio: Math.round(coverageRatio * 100) / 100,
    coverage_boost: Math.round(coverageBoost * 100) / 100,
    deterministic_base: Math.round(deterministicBase * 100) / 100,
    relative_boost_limit: Math.round(relativeBoostLimit * 100) / 100,
    boost_cap: Math.round(boostCap * 100) / 100,
    bounded_boost: Math.round(boundedBoost * 100) / 100,
    boost_raw: Math.round(boost * 100) / 100,
    low_evidence_penalty: lowEvidencePenalty,
    supplementary: {
      news_signals: newsSignals.length,
      mna_signals: mnaSignals.length,
      people_research: peopleResearch.length,
    },
  };

  if (analysis.competitors_detected?.length > 0) {
    baseResult.llm_competitors = analysis.competitors_detected;
  }
  if (analysis.key_people?.length > 0) {
    baseResult.key_people = analysis.key_people;
    const stakeholders = scoreAllStakeholders(analysis.key_people, {
      company: {
        name: baseResult.company_name,
        turnover: baseResult.turnover,
      },
      analysis,
      motion: baseResult.layers?.product_fit?.best_motion || "FX",
      filingDate: analysis.analysed_at || baseResult.scored_at,
    });
    const readiness = getOutreachReadiness(stakeholders);
    const topStakeholderScore = stakeholders[0]?.final_score || 0;
    const readinessFactor = readiness?.ready ? 1 : readiness?.primary_candidate ? 0.6 : 0.35;
    const stakeholderBoost = Math.min((topStakeholderScore / 100) * STAKEHOLDER_BOOST_CAP, STAKEHOLDER_BOOST_CAP) * readinessFactor;
    baseResult.composite_score = Math.min(Math.round((baseResult.composite_score + stakeholderBoost) * 100) / 100, 1);
    baseResult.propensity_score = clamp01(Number(baseResult.propensity_score || 0) + (stakeholderBoost * 0.9));
    baseResult.stakeholder_priority = {
      boost: Math.round(stakeholderBoost * 100) / 100,
      readiness,
      top_stakeholder: stakeholders[0] || null,
    };
  }

  const recencyProfile = baseResult.filing_recency || getFilingRecencyProfile(null);
  const evidence = clamp01(Number(baseResult?.confidence?.evidence || 0.5));
  const textLengthEstimate = baseResult.has_filing_text ? 1200 : 0;
  baseResult.confidence_interval = buildConfidenceInterval(
    baseResult.composite_score,
    evidence,
    recencyProfile,
    textLengthEstimate,
    baseResult.all_motion_scores || {}
  );

  baseResult.score_explanation = buildScoreExplanation({
    fitScore: baseResult.fit_score,
    propensityScore: baseResult.propensity_score,
    compositeScore: baseResult.composite_score,
    bestMotion: baseResult.layers?.product_fit?.best_motion,
    velocity: baseResult.velocity,
    confidenceInterval: baseResult.confidence_interval,
    synergy: baseResult.synergy,
    correlation: baseResult?.confidence?.cross_layer_penalty,
    switchingFeasibility: baseResult.layers?.switching_feasibility,
  });

  const dataFingerprint = computeDataFingerprint({
    latest_filing_date: baseResult.filing_recency?.band || "unknown",
    text_length: textLengthEstimate,
    filing_count: baseResult.filing_count_total || 0,
    turnover: baseResult.turnover,
    charge_marker: baseResult.charge_summary?.latest_charge_created_on || baseResult.charge_summary?.fetched_at || "none",
  });
  baseResult.volatility = deriveScoreVolatility(previousStored, baseResult, dataFingerprint);
  recordScoreHistory(baseResult.company_number, baseResult, dataFingerprint);

  setSetting(`score_${baseResult.company_number}`, baseResult);
  return baseResult;
}

export async function scoreCompanyWithLLM(companyNumber) {
  const baseResult = scoreCompany(companyNumber);
  if (!baseResult) return null;

  const monitored = getMonitoredCompany(companyNumber);
  const analysis = await analyseCompany(companyNumber, monitored?.company_name, monitored?.latest_turnover);

  if (analysis) {
    setSetting(`analysis_${companyNumber}`, analysis);
  }

  return integrateAnalysis(baseResult, analysis);
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

export async function batchScoreWithLLM(companies, concurrency = 2) {
  const results = [];
  for (let i = 0; i < companies.length; i += concurrency) {
    const batch = companies.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((c) => scoreCompanyWithLLM(c.company_number).catch(() => null))
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }
  results.sort((a, b) => b.composite_score - a.composite_score);
  return results;
}
