import { getFilingsForCompany, getMonitoredCompany, getSetting, setSetting } from "./db.js";

const TURNOVER_THRESHOLD = 15_000_000;

const PRODUCT_MOTIONS = ["FX", "FX Forwards", "Cards", "Spend Management", "API Integrations", "Merchant Acquiring", "Revolut Pay"];

const SCORING_WEIGHTS = {
  product_fit: 0.35,
  commercial_value: 0.20,
  pain_strength: 0.20,
  urgency: 0.15,
  competitor_context: 0.10,
};

// --- Evidence pattern scoring rubrics ---

const FX_SIGNALS = {
  high: [
    /(?:international|overseas|foreign)\s+(?:revenue|sales|income|operations)/i,
    /(?:export|import)(?:s|ing|ed)\s+(?:to|from)\s+\d+\s+(?:countries|markets)/i,
    /multi[- ]?currency/i,
    /(?:foreign\s+)?exchange\s+(?:risk|exposure|losses|gains)/i,
    /(?:USD|EUR|JPY|CHF|AED|CNY|BDT)\s+(?:revenue|income|payment|exposure)/i,
    /(?:\d+%|majority|significant\s+(?:proportion|portion))\s+(?:of\s+)?(?:revenue|sales|turnover).*(?:overseas|international|foreign)/i,
  ],
  medium: [
    /(?:international|overseas|global|foreign)/i,
    /(?:export|import)/i,
    /(?:currency|currencies)/i,
    /(?:subsidiary|subsidiaries|branch|branches)\s+(?:in|across|throughout)/i,
  ],
};

const FX_FORWARDS_SIGNALS = {
  high: [
    /(?:hedg|forward\s+contract|forward\s+rate)/i,
    /(?:currency|foreign\s+exchange)\s+(?:risk\s+management|hedging)/i,
    /(?:long[- ]?term|12[- ]?month|multi[- ]?year)\s+(?:contract|agreement|supply)/i,
    /(?:fixed|locked)\s+(?:exchange\s+)?rate/i,
  ],
  medium: [
    /(?:seasonal|quarterly|recurring)\s+(?:payment|obligation|exposure)/i,
    /(?:supply\s+chain|procurement)\s+(?:in|from)\s+(?:overseas|abroad|foreign)/i,
  ],
};

const CARDS_SIGNALS = {
  high: [
    /(\d{3,})\s*(?:employees|staff|team\s+members|people)/i,
    /(?:multiple|several|numerous)\s+(?:sites?|locations?|offices?|branches|depots?)/i,
    /(?:travel|expense|procurement|purchasing)\s+(?:policy|management|control)/i,
    /(?:reimburse|petty\s+cash|personal\s+card)/i,
  ],
  medium: [
    /(?:employee|staff|workforce|headcount)/i,
    /(?:travel|expenses?|purchasing)/i,
  ],
};

const SPEND_MANAGEMENT_SIGNALS = {
  high: [
    /(?:budget|spend|expenditure)\s+(?:control|visibility|management|approval)/i,
    /(?:decentrali[sz]ed|distributed|fragmented)\s+(?:spending|purchasing|procurement)/i,
    /(?:multi[- ]?site|multi[- ]?entity|multi[- ]?department)/i,
    /(?:audit|compliance|governance)\s+(?:issue|concern|finding|requirement)/i,
  ],
  medium: [
    /(?:procurement|purchasing|spend)/i,
    /(?:approval|authoris|authoriz)/i,
    /(?:budget|cost\s+control)/i,
  ],
};

const API_SIGNALS = {
  high: [
    /(?:API|integration|automated?\s+payment)/i,
    /(?:ERP|SAP|Oracle|NetSuite|Xero|QuickBooks|Sage)/i,
    /(?:platform|SaaS|software)\s+(?:business|company)/i,
    /(?:developer|engineering|technical)\s+team/i,
    /(?:embedded\s+(?:payment|finance)|banking\s+as\s+a\s+service)/i,
  ],
  medium: [
    /(?:technology|digital|software|system)/i,
    /(?:automat|integrat)/i,
  ],
};

const MERCHANT_SIGNALS = {
  high: [
    /(?:retail|store|shop|outlet|e[- ]?commerce|online\s+(?:sales|shop|store))/i,
    /(?:payment\s+(?:accept|process|terminal)|card\s+(?:payment|transaction))/i,
    /(?:checkout|point\s+of\s+sale|POS|PSP)/i,
    /(?:consumer[- ]?facing|B2C|direct\s+to\s+consumer)/i,
  ],
  medium: [
    /(?:customer|consumer|retail|online)/i,
    /(?:revenue|sales).*(?:online|digital|website)/i,
  ],
};

const MOTION_SIGNAL_MAP = {
  "FX": FX_SIGNALS,
  "FX Forwards": FX_FORWARDS_SIGNALS,
  "Cards": CARDS_SIGNALS,
  "Spend Management": SPEND_MANAGEMENT_SIGNALS,
  "API Integrations": API_SIGNALS,
  "Merchant Acquiring": MERCHANT_SIGNALS,
  "Revolut Pay": MERCHANT_SIGNALS,
};

// --- Scoring functions ---

function scoreMotionFromText(text, motion) {
  const signals = MOTION_SIGNAL_MAP[motion];
  if (!signals) return { score: 0, evidence: [] };

  let score = 0;
  const evidence = [];

  for (const pattern of (signals.high || [])) {
    const match = text.match(pattern);
    if (match) {
      score += 0.3;
      const ctx = text.substring(Math.max(0, match.index - 50), match.index + match[0].length + 100).trim();
      evidence.push({ text: ctx.substring(0, 150), strength: "high" });
    }
  }

  for (const pattern of (signals.medium || [])) {
    if (text.match(pattern)) score += 0.1;
  }

  return { score: Math.min(score, 1), evidence: evidence.slice(0, 3) };
}

function scoreCommercialValue(turnover) {
  if (!turnover || turnover < TURNOVER_THRESHOLD) return 0;
  if (turnover >= 500_000_000) return 1.0;
  if (turnover >= 100_000_000) return 0.85;
  if (turnover >= 50_000_000) return 0.7;
  if (turnover >= 25_000_000) return 0.55;
  return 0.4;
}

function scoreGrowth(filings) {
  if (!filings || filings.length < 2) return { score: 0.5, trend: "unknown" };

  const sorted = filings.filter((f) => f.turnover > 0).sort((a, b) => (a.filing_date || "").localeCompare(b.filing_date || ""));
  if (sorted.length < 2) return { score: 0.5, trend: "unknown" };

  const oldest = sorted[0].turnover;
  const latest = sorted[sorted.length - 1].turnover;
  const growthRate = (latest - oldest) / oldest;

  if (growthRate > 0.2) return { score: 0.9, trend: "strong_growth" };
  if (growthRate > 0.05) return { score: 0.7, trend: "growing" };
  if (growthRate > -0.05) return { score: 0.5, trend: "stable" };
  if (growthRate > -0.2) return { score: 0.3, trend: "declining" };
  return { score: 0.1, trend: "sharp_decline" };
}

function extractEmployeeCount(text) {
  const patterns = [
    /average.*?(\d{1,5})\s*(?:employees|staff|people)/i,
    /(\d{1,5})\s*(?:employees|staff|people|team members)/i,
    /headcount.*?(\d{1,5})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
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

  for (const motion of PRODUCT_MOTIONS) {
    const { score, evidence } = scoreMotionFromText(text, motion);
    motionScores[motion] = { score, evidence, fit_level: score >= 0.6 ? "strong" : score >= 0.3 ? "medium" : "weak" };
    if (score > bestMotionScore) {
      bestMotionScore = score;
      bestMotion = motion;
    }
  }

  const commercialValue = scoreCommercialValue(turnover);
  const growth = scoreGrowth(filings);
  const employees = extractEmployeeCount(text);

  const productFitScore = bestMotionScore;
  const painScore = Math.min(
    (motionScores["FX"]?.score || 0) * 0.3 +
    (motionScores["Cards"]?.score || 0) * 0.2 +
    (motionScores["Spend Management"]?.score || 0) * 0.2 +
    (motionScores["Merchant Acquiring"]?.score || 0) * 0.2 +
    (growth.score > 0.7 ? 0.1 : 0),
    1
  );
  const urgencyScore = growth.score;
  const competitorScore = 0.5;

  const compositeScore = Math.round((
    productFitScore * SCORING_WEIGHTS.product_fit +
    commercialValue * SCORING_WEIGHTS.commercial_value +
    painScore * SCORING_WEIGHTS.pain_strength +
    urgencyScore * SCORING_WEIGHTS.urgency +
    competitorScore * SCORING_WEIGHTS.competitor_context
  ) * 100) / 100;

  const result = {
    company_number: companyNumber,
    company_name: monitored.company_name,
    turnover,
    composite_score: compositeScore,
    layers: {
      product_fit: { score: productFitScore, best_motion: bestMotion },
      commercial_value: { score: commercialValue },
      pain_strength: { score: painScore },
      urgency: { score: urgencyScore, trend: growth.trend },
      competitor_context: { score: competitorScore },
    },
    motion_scores: motionScores,
    employees,
    growth,
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
