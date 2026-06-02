import { getCompanyChargeSummary, getFilingsForCompany, getMonitoredCompany, getSetting, setSetting } from "./db.js";
import { analyseCompany } from "./llm.js";
import { getOutreachReadiness, scoreAllStakeholders } from "./stakeholder-scoring.js";
import { SCORING_ENGINE_FIT_WEIGHTS as SCORING_WEIGHTS } from "./scoring-weights.js";

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
  "HSBC": { regex: /\bHSBC\b/i, products: ["FX", "FX Forwards"], weakness: "digital_friction", stickiness: 4.5 },
  "Barclays": { regex: /\bBarclays?\b/i, products: ["FX", "Cards", "Merchant Acquiring"], weakness: "legacy_costs", stickiness: 4.5 },
  "NatWest": { regex: /\bNatWest\b/i, products: ["FX", "Cards"], weakness: "digital_friction", stickiness: 4.4 },
  "Lloyds": { regex: /\bLloyds\b/i, products: ["FX", "Cards"], weakness: "digital_friction", stickiness: 4.4 },
  "Santander": { regex: /\bSantander\b/i, products: ["FX", "Cards"], weakness: "legacy_costs", stickiness: 4.2 },
  "JP Morgan": { regex: /\b(?:JP\s*Morgan|JPMorgan)\b/i, products: ["FX", "FX Forwards"], weakness: "enterprise_gated", stickiness: 4.5 },
  "Citi": { regex: /\b(?:Citi|Citibank)\b/i, products: ["FX", "FX Forwards"], weakness: "enterprise_gated", stickiness: 4.2 },
  "Deutsche Bank": { regex: /\bDeutsche\s+Bank\b/i, products: ["FX", "FX Forwards"], weakness: "enterprise_gated", stickiness: 4.1 },
  "Standard Chartered": { regex: /\bStandard\s+Chartered\b/i, products: ["FX", "FX Forwards"], weakness: "enterprise_gated", stickiness: 4.1 },
  "Metro Bank": { regex: /\bMetro\s+Bank\b/i, products: ["Cards"], weakness: "limited_mm_depth", stickiness: 3.4 },
  "Tide": {
    regex: /(?:\bTide(?:\s+Business)?\b(?=[^.\n]{0,40}\b(?:bank|banking|business|account|accounts|card|cards|expense|mtd|payment|payments)\b))/i,
    products: ["Cards", "Spend Management", "API Integrations"],
    weakness: "mtd_compliance_edge",
    stickiness: 3.1,
  },
  "Starling Business": { regex: /\bStarling(?:\s+Business)?\b/i, products: ["Cards"], weakness: "scale_cliff", stickiness: 3.2 },
  "Monzo Business": { regex: /\bMonzo(?:\s+Business)?\b/i, products: ["Cards"], weakness: "scale_cliff", stickiness: 3.0 },
  "Worldpay": { regex: /\bWorldpay\b/i, products: ["Merchant Acquiring"], weakness: "legacy_pricing", stickiness: 4.0 },
  "Barclaycard": { regex: /\bBarclay\s*card\b/i, products: ["Merchant Acquiring", "Cards"], weakness: "legacy_pricing", stickiness: 4.1 },
  "Stripe Connect": { regex: /\bStripe\s+Connect\b/i, products: ["Merchant Acquiring", "API Integrations"], weakness: "ecosystem_lock_in", stickiness: 4.1 },
  "Stripe": { regex: /\bStripe\b(?!\s+Connect)\b/i, products: ["Merchant Acquiring", "API Integrations"], weakness: "slow_settlement", stickiness: 3.8 },
  "Adyen": { regex: /\bAdyen\b/i, products: ["Merchant Acquiring"], weakness: "enterprise_gated", stickiness: 4.0 },
  "Checkout.com": { regex: /\bCheckout\.com\b|\bCheckout\b/i, products: ["Merchant Acquiring"], weakness: "enterprise_gated", stickiness: 3.7 },
  "Square": {
    regex: /(?:\bSquare\b(?=[^.\n]{0,40}\b(?:payment|payments|pos|terminal|reader|checkout|merchant|card|cards|gateway|api|seller)\b)|\bSquare\s*Up\b|\bSquareup\b)/i,
    products: ["Merchant Acquiring", "Cards"],
    weakness: "limited_mm_depth",
    stickiness: 3.3,
  },
  "SumUp": { regex: /\bSumUp\b/i, products: ["Merchant Acquiring"], weakness: "limited_mm_depth", stickiness: 2.8 },
  "Zettle": { regex: /\b(?:i?Zettle|Zettle)\b/i, products: ["Merchant Acquiring"], weakness: "limited_mm_depth", stickiness: 2.9 },
  "PayPal": { regex: /\bPayPal\b/i, products: ["Merchant Acquiring", "Revolut Pay"], weakness: "legacy_pricing", stickiness: 3.6 },
  "Shopify Payments": { regex: /\bShopify\s+Payments\b|\bShopify\b/i, products: ["Merchant Acquiring", "Revolut Pay", "API Integrations"], weakness: "ecosystem_lock_in", stickiness: 3.9 },
  "Wise": {
    regex: /(?:\bWise(?:\s+Business)?\b(?=[^.\n]{0,48}\b(?:fx|foreign\s+exchange|currency|currencies|payment|payments|transfer|transfers|cross[- ]?border|international)\b)|\bTransferWise\b)/i,
    products: ["FX"],
    weakness: "no_forwards_no_cards",
    stickiness: 2.4,
  },
  "Airwallex": { regex: /\bAirwallex\b/i, products: ["FX", "API Integrations"], weakness: "no_credit_no_treasury", stickiness: 3.0 },
  "Ebury": { regex: /\bEbury\b/i, products: ["FX", "FX Forwards"], weakness: "no_banking_ecosystem", stickiness: 3.1 },
  "OFX": { regex: /\bOFX\b/i, products: ["FX", "FX Forwards"], weakness: "single_product_scope", stickiness: 2.5 },
  "Moneycorp": { regex: /\bMoneycorp\b/i, products: ["FX", "FX Forwards"], weakness: "single_product_scope", stickiness: 3.0 },
  "Caxton": { regex: /\bCaxton(?:\s+FX)?\b/i, products: ["FX", "Cards"], weakness: "single_product_scope", stickiness: 2.7 },
  "CurrencyCloud": { regex: /\bCurrencyCloud\b/i, products: ["FX", "API Integrations"], weakness: "single_product_scope", stickiness: 2.8 },
  "Modulr": { regex: /\bModulr\b/i, products: ["API Integrations", "Cards"], weakness: "no_credit_no_treasury", stickiness: 3.3 },
  "ClearBank": { regex: /\bClear\s*Bank\b|\bClearBank\b/i, products: ["API Integrations", "Cards"], weakness: "no_credit_no_treasury", stickiness: 3.5 },
  "Pleo": { regex: /\bPleo\b/i, products: ["Cards", "Spend Management"], weakness: "expensive_fx", stickiness: 2.8 },
  "Payhawk": { regex: /\bPayhawk\b/i, products: ["Cards", "Spend Management"], weakness: "no_banking_ecosystem", stickiness: 3.1 },
  "Spendesk": { regex: /\bSpendesk\b/i, products: ["Spend Management"], weakness: "no_banking_ecosystem", stickiness: 3.1 },
  "Ramp": {
    regex: /\bRamp(?:\.com)?\b(?=[^.\n]{0,40}\b(?:expense|spend|card|cards|payment|payments|finance|platform|procurement|bill)\b)/i,
    products: ["Spend Management", "Cards"],
    weakness: "no_banking_ecosystem",
    stickiness: 3.2,
  },
  "SAP Concur": { regex: /\b(?:SAP\s+)?Concur\b/i, products: ["Spend Management", "API Integrations"], weakness: "expensive_complex", stickiness: 4.1 },
  "Coupa": { regex: /\bCoupa\b/i, products: ["Spend Management", "API Integrations"], weakness: "expensive_complex", stickiness: 4.0 },
  "Kyriba": { regex: /\bKyriba\b/i, products: ["FX", "FX Forwards", "API Integrations"], weakness: "enterprise_gated", stickiness: 4.0 },
  "Capital On Tap": { regex: /\bCapital\s+On\s+Tap\b/i, products: ["Cards"], weakness: "single_product_scope", stickiness: 3.1 },
  "Amex": { regex: /\bAm(?:erican\s+)?Ex(?:press)?\b/i, products: ["Cards"], weakness: "high_fees_limited_acceptance", stickiness: 3.5 },
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
  no_credit_no_treasury: "Position broader platform depth where treasury, spend, and banking need to be unified.",
  single_product_scope: "Position consolidation value by replacing point solutions with one finance operating stack.",
  scale_cliff: "Position stronger multi-user governance and controls as teams and entities scale.",
  ecosystem_lock_in: "Position banking-led optionality and lower dependency on a closed commerce ecosystem.",
  mtd_compliance_edge: "Acknowledge MTD strengths and counter with broader multi-product value and cross-border depth.",
  limited_mm_depth: "Position deeper controls, multi-entity support, and higher operational ceiling for mid-market finance teams.",
};

const COMPETITOR_INTELLIGENCE = {
  "HSBC": { isolation_score: 0.38, holistic_score: 0.45, lock_in_strength: 0.92, platform_type: "full_stack_bank", credit_anchor: true },
  "Barclays": { isolation_score: 0.40, holistic_score: 0.46, lock_in_strength: 0.90, platform_type: "full_stack_bank", credit_anchor: true },
  "NatWest": { isolation_score: 0.42, holistic_score: 0.50, lock_in_strength: 0.88, platform_type: "full_stack_bank", credit_anchor: true },
  "Lloyds": { isolation_score: 0.40, holistic_score: 0.46, lock_in_strength: 0.89, platform_type: "full_stack_bank", credit_anchor: true },
  "Santander": { isolation_score: 0.46, holistic_score: 0.52, lock_in_strength: 0.84, platform_type: "full_stack_bank", credit_anchor: true },
  "JP Morgan": { isolation_score: 0.50, holistic_score: 0.46, lock_in_strength: 0.88, platform_type: "enterprise_bank", credit_anchor: true },
  "Citi": { isolation_score: 0.55, holistic_score: 0.52, lock_in_strength: 0.84, platform_type: "enterprise_bank", credit_anchor: true },
  "Deutsche Bank": { isolation_score: 0.56, holistic_score: 0.52, lock_in_strength: 0.82, platform_type: "enterprise_bank", credit_anchor: true },
  "Standard Chartered": { isolation_score: 0.56, holistic_score: 0.53, lock_in_strength: 0.80, platform_type: "enterprise_bank", credit_anchor: true },
  "Metro Bank": { isolation_score: 0.66, holistic_score: 0.62, lock_in_strength: 0.70, platform_type: "full_stack_bank", credit_anchor: true },
  "Tide": { isolation_score: 0.63, holistic_score: 0.67, lock_in_strength: 0.60, platform_type: "digital_bank", credit_anchor: false },
  "Starling Business": { isolation_score: 0.66, holistic_score: 0.69, lock_in_strength: 0.58, platform_type: "digital_bank", credit_anchor: false },
  "Monzo Business": { isolation_score: 0.72, holistic_score: 0.72, lock_in_strength: 0.55, platform_type: "digital_bank", credit_anchor: false },
  "Wise": { isolation_score: 0.53, holistic_score: 0.84, lock_in_strength: 0.52, platform_type: "single_product", credit_anchor: false },
  "Airwallex": { isolation_score: 0.56, holistic_score: 0.80, lock_in_strength: 0.58, platform_type: "single_product", credit_anchor: false },
  "Ebury": { isolation_score: 0.52, holistic_score: 0.74, lock_in_strength: 0.60, platform_type: "single_product", credit_anchor: false },
  "OFX": { isolation_score: 0.72, holistic_score: 0.82, lock_in_strength: 0.45, platform_type: "single_product", credit_anchor: false },
  "Moneycorp": { isolation_score: 0.68, holistic_score: 0.76, lock_in_strength: 0.56, platform_type: "single_product", credit_anchor: false },
  "Caxton": { isolation_score: 0.70, holistic_score: 0.80, lock_in_strength: 0.44, platform_type: "single_product", credit_anchor: false },
  "CurrencyCloud": { isolation_score: 0.70, holistic_score: 0.78, lock_in_strength: 0.50, platform_type: "single_product", credit_anchor: false },
  "Modulr": { isolation_score: 0.55, holistic_score: 0.74, lock_in_strength: 0.68, platform_type: "payments_platform", credit_anchor: false },
  "ClearBank": { isolation_score: 0.50, holistic_score: 0.66, lock_in_strength: 0.74, platform_type: "payments_platform", credit_anchor: false },
  "Pleo": { isolation_score: 0.40, holistic_score: 0.86, lock_in_strength: 0.58, platform_type: "single_product", credit_anchor: false },
  "Payhawk": { isolation_score: 0.50, holistic_score: 0.78, lock_in_strength: 0.62, platform_type: "single_product", credit_anchor: false },
  "Spendesk": { isolation_score: 0.50, holistic_score: 0.76, lock_in_strength: 0.61, platform_type: "single_product", credit_anchor: false },
  "Ramp": { isolation_score: 0.44, holistic_score: 0.82, lock_in_strength: 0.65, platform_type: "single_product", credit_anchor: false },
  "SAP Concur": { isolation_score: 0.54, holistic_score: 0.61, lock_in_strength: 0.82, platform_type: "enterprise_suite", credit_anchor: false },
  "Coupa": { isolation_score: 0.48, holistic_score: 0.56, lock_in_strength: 0.82, platform_type: "enterprise_suite", credit_anchor: false },
  "Kyriba": { isolation_score: 0.52, holistic_score: 0.58, lock_in_strength: 0.84, platform_type: "enterprise_suite", credit_anchor: false },
  "Stripe Connect": { isolation_score: 0.42, holistic_score: 0.62, lock_in_strength: 0.86, platform_type: "commerce_anchor", credit_anchor: false },
  "Barclaycard": { isolation_score: 0.52, holistic_score: 0.66, lock_in_strength: 0.83, platform_type: "payments_platform", credit_anchor: false },
  "Stripe": { isolation_score: 0.34, holistic_score: 0.76, lock_in_strength: 0.82, platform_type: "payments_platform", credit_anchor: false },
  "Adyen": { isolation_score: 0.46, holistic_score: 0.68, lock_in_strength: 0.80, platform_type: "payments_platform", credit_anchor: false },
  "Checkout.com": { isolation_score: 0.50, holistic_score: 0.72, lock_in_strength: 0.72, platform_type: "payments_platform", credit_anchor: false },
  "Worldpay": { isolation_score: 0.60, holistic_score: 0.74, lock_in_strength: 0.75, platform_type: "payments_platform", credit_anchor: false },
  "Square": { isolation_score: 0.58, holistic_score: 0.72, lock_in_strength: 0.67, platform_type: "payments_platform", credit_anchor: false },
  "SumUp": { isolation_score: 0.74, holistic_score: 0.80, lock_in_strength: 0.45, platform_type: "payments_platform", credit_anchor: false },
  "Zettle": { isolation_score: 0.70, holistic_score: 0.78, lock_in_strength: 0.50, platform_type: "payments_platform", credit_anchor: false },
  "PayPal": { isolation_score: 0.60, holistic_score: 0.70, lock_in_strength: 0.72, platform_type: "payments_platform", credit_anchor: false },
  "Shopify Payments": { isolation_score: 0.62, holistic_score: 0.70, lock_in_strength: 0.76, platform_type: "commerce_anchor", credit_anchor: false },
  "Capital On Tap": { isolation_score: 0.58, holistic_score: 0.72, lock_in_strength: 0.62, platform_type: "single_product", credit_anchor: false },
  "Amex": { isolation_score: 0.54, holistic_score: 0.68, lock_in_strength: 0.70, platform_type: "single_product", credit_anchor: false },
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
  "Barclaycard": {
    motion_boosts: { "Merchant Acquiring": 0.07, "Cards": 0.05 },
    competitor_context_delta: 0.03,
    switching_feasibility_delta: -0.04,
  },
  "Stripe Connect": {
    motion_boosts: { "Merchant Acquiring": 0.08, "API Integrations": 0.09 },
    competitor_context_delta: 0.06,
    switching_feasibility_delta: -0.05,
  },
  "SAP Concur": {
    motion_boosts: { "Spend Management": 0.1 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.03,
  },
  "Modulr": {
    motion_boosts: { "API Integrations": 0.08, "Cards": 0.05 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.02,
  },
  "ClearBank": {
    motion_boosts: { "API Integrations": 0.07 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: -0.02,
  },
  "Caxton": {
    motion_boosts: { "FX": 0.08, "Cards": 0.04 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: 0.04,
  },
  "Payhawk": {
    motion_boosts: { "Spend Management": 0.1, "Cards": 0.06 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.03,
  },
  "Spendesk": {
    motion_boosts: { "Spend Management": 0.09 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: 0.02,
  },
  "Ramp": {
    motion_boosts: { "Spend Management": 0.1, "Cards": 0.05 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.03,
  },
  "Checkout.com": {
    motion_boosts: { "Merchant Acquiring": 0.08, "API Integrations": 0.06 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.02,
  },
  "Airwallex": {
    motion_boosts: { "FX": 0.09, "API Integrations": 0.08 },
    competitor_context_delta: 0.06,
    switching_feasibility_delta: 0.04,
  },
  "PayPal": {
    motion_boosts: { "Merchant Acquiring": 0.08, "Revolut Pay": 0.08 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: 0.02,
  },
  "Shopify Payments": {
    motion_boosts: { "Merchant Acquiring": 0.08, "Revolut Pay": 0.1, "API Integrations": 0.05 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: -0.04,
  },
  "Square": {
    motion_boosts: { "Merchant Acquiring": 0.08, "Revolut Pay": 0.07 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.05,
  },
  "SumUp": {
    motion_boosts: { "Merchant Acquiring": 0.08, "Revolut Pay": 0.08 },
    competitor_context_delta: 0.05,
    switching_feasibility_delta: 0.06,
  },
  "Tide": {
    motion_boosts: { "Spend Management": 0.06, "API Integrations": 0.06 },
    competitor_context_delta: 0.04,
    switching_feasibility_delta: -0.02,
  },
  "Starling Business": {
    motion_boosts: { "Cards": 0.07 },
    competitor_context_delta: 0.03,
    switching_feasibility_delta: 0.01,
  },
  "Monzo Business": {
    motion_boosts: { "Cards": 0.06 },
    competitor_context_delta: 0.03,
    switching_feasibility_delta: 0.01,
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
  "Santander": {
    motion_boosts: { "FX": 0.05 },
    competitor_context_delta: 0.02,
    switching_feasibility_delta: -0.05,
  },
  "Kyriba": {
    motion_boosts: { "FX": 0.05, "FX Forwards": 0.05, "API Integrations": 0.05 },
    competitor_context_delta: 0.03,
    switching_feasibility_delta: -0.04,
  },
  "Coupa": {
    motion_boosts: { "Spend Management": 0.07, "API Integrations": 0.05 },
    competitor_context_delta: 0.03,
    switching_feasibility_delta: -0.04,
  },
};

const TECH_STACK_MOTION_SIGNALS = {
  "Worldpay": { motions: { "Merchant Acquiring": 0.35, "Revolut Pay": 0.25 }, switching: 0.08, competitor: true },
  "Barclaycard": { motions: { "Merchant Acquiring": 0.28, "Cards": 0.14, "Revolut Pay": 0.16 }, switching: -0.03, competitor: true },
  "Stripe Connect": { motions: { "Merchant Acquiring": 0.20, "Revolut Pay": 0.10, "API Integrations": 0.22 }, switching: -0.08, competitor: true },
  "Stripe": { motions: { "Merchant Acquiring": 0.30, "Revolut Pay": 0.20, "API Integrations": 0.15 }, switching: 0.12, competitor: true },
  "Adyen": { motions: { "Merchant Acquiring": 0.25, "Revolut Pay": 0.15 }, switching: -0.05, competitor: true },
  "PayPal": { motions: { "Merchant Acquiring": 0.30, "Revolut Pay": 0.25 }, switching: 0.10, competitor: true },
  "Square": { motions: { "Merchant Acquiring": 0.35, "Revolut Pay": 0.30 }, switching: 0.15, competitor: true },
  "SumUp": { motions: { "Merchant Acquiring": 0.35, "Revolut Pay": 0.30 }, switching: 0.18, competitor: true },
  "Modulr": { motions: { "API Integrations": 0.20, "Cards": 0.12 }, switching: 0.03, competitor: true },
  "ClearBank": { motions: { "API Integrations": 0.18, "Cards": 0.08 }, switching: -0.04, competitor: true },
  "Sage Pay": { motions: { "Merchant Acquiring": 0.30, "Revolut Pay": 0.20 }, switching: 0.06, competitor: true },
  "Global Payments": { motions: { "Merchant Acquiring": 0.30, "Revolut Pay": 0.20 }, switching: 0.05, competitor: true },
  "Xero": { motions: { "API Integrations": 0.15, "Spend Management": 0.10 }, switching: 0.12, integration_ready: true },
  "QuickBooks": { motions: { "API Integrations": 0.15, "Spend Management": 0.10 }, switching: 0.12, integration_ready: true },
  "NetSuite": { motions: { "API Integrations": 0.20, "Spend Management": 0.12 }, switching: 0.08, integration_ready: true },
  "Sage": { motions: { "API Integrations": 0.08 }, switching: -0.05, integration_ready: false },
  "SAP": { motions: { "API Integrations": 0.10, "Spend Management": 0.08 }, switching: -0.10, integration_ready: false },
  "Shopify": { motions: { "Merchant Acquiring": 0.25, "Revolut Pay": 0.30 }, switching: 0.15, b2c_confirmed: true },
  "WooCommerce": { motions: { "Merchant Acquiring": 0.25, "Revolut Pay": 0.25 }, switching: 0.12, b2c_confirmed: true },
  "Magento": { motions: { "Merchant Acquiring": 0.30, "Revolut Pay": 0.20 }, switching: 0.06, b2c_confirmed: true },
  "BigCommerce": { motions: { "Merchant Acquiring": 0.25, "Revolut Pay": 0.25 }, switching: 0.10, b2c_confirmed: true },
};

const MULTI_CURRENCY_TECH_SIGNALS = [
  "Multi-Currency for WooCommerce",
  "WPML",
  "Weglot",
  "GeoTargetingWP",
  "hreflang",
];

const HIRING_SIGNAL_WEIGHTS = {
  urgency: {
    "CFO": { boost: 0.22, velocity_trigger: "new_finance_leader" },
    "Finance Director": { boost: 0.20, velocity_trigger: "new_finance_leader" },
    "FD": { boost: 0.20, velocity_trigger: "new_finance_leader" },
    "Head of Finance": { boost: 0.18, velocity_trigger: "new_finance_leader" },
    "VP Finance": { boost: 0.18, velocity_trigger: "new_finance_leader" },
    "Financial Controller": { boost: 0.12, velocity_trigger: null },
  },
  motion_signals: {
    "Treasury Manager": { motions: { "FX": 0.20, "FX Forwards": 0.18 }, pain_boost: 0.10 },
    "Treasury Analyst": { motions: { "FX": 0.15, "FX Forwards": 0.12 }, pain_boost: 0.06 },
    "Head of Treasury": { motions: { "FX": 0.25, "FX Forwards": 0.22 }, pain_boost: 0.15 },
    "FX Dealer": { motions: { "FX": 0.22, "FX Forwards": 0.20 }, pain_boost: 0.12 },
    "Accounts Payable": { motions: { "Cards": 0.10, "Spend Management": 0.12 }, pain_boost: 0.05 },
    "Accounts Receivable": { motions: { "Merchant Acquiring": 0.08 }, pain_boost: 0.04 },
    "Procurement Manager": { motions: { "FX": 0.08, "Cards": 0.10, "Spend Management": 0.15 }, pain_boost: 0.06 },
    "Ecommerce Manager": { motions: { "Merchant Acquiring": 0.15, "Revolut Pay": 0.12 }, pain_boost: 0.06 },
    "Head of Digital": { motions: { "Merchant Acquiring": 0.12, "Revolut Pay": 0.10, "API Integrations": 0.10 }, pain_boost: 0.05 },
    "International Manager": { motions: { "FX": 0.15, "FX Forwards": 0.10 }, pain_boost: 0.08 },
    "EMEA Director": { motions: { "FX": 0.12, "FX Forwards": 0.08 }, pain_boost: 0.06 },
  },
};

const HEADCOUNT_GROWTH_THRESHOLDS = [
  { band: "strong", min_pct: 20, propensity_boost: 0.12, urgency_boost: 0.08 },
  { band: "moderate", min_pct: 10, propensity_boost: 0.06, urgency_boost: 0.04 },
  { band: "stable", min_pct: 0, propensity_boost: 0, urgency_boost: 0 },
  { band: "declining", min_pct: -100, propensity_boost: -0.04, urgency_boost: -0.03 },
];

const OWNERSHIP_SCORING_EFFECTS = {
  pe_backed: {
    switching_feasibility_delta: 0.12,
    urgency_boost: 0.08,
    motion_boosts: { "Spend Management": 0.08 },
    pain_boost: 0.06,
  },
  family_owned: {
    switching_feasibility_delta: -0.08,
    urgency_boost: 0,
    motion_boosts: {},
    pain_boost: 0,
  },
  foreign_subsidiary: {
    switching_feasibility_delta: 0.04,
    urgency_boost: 0.04,
    motion_boosts: { "FX": 0.15, "FX Forwards": 0.10, "API Integrations": 0.08 },
    pain_boost: 0.08,
  },
  public_company: {
    switching_feasibility_delta: -0.06,
    urgency_boost: 0,
    motion_boosts: { "Spend Management": 0.10 },
    pain_boost: 0.04,
  },
};

const BUSINESS_MODEL_MOTION_WEIGHTS = {
  B2C: {
    "Merchant Acquiring": 1.4,
    "Revolut Pay": 1.5,
    "FX": 0.8,
    "FX Forwards": 0.7,
    "Spend Management": 0.7,
    "Cards": 0.9,
    "API Integrations": 1.1,
  },
  B2B: {
    "Merchant Acquiring": 0.6,
    "Revolut Pay": 0.4,
    "FX": 1.3,
    "FX Forwards": 1.3,
    "Spend Management": 1.2,
    "Cards": 1.2,
    "API Integrations": 1.0,
  },
  hybrid: {},
  unknown: {},
};

const MOTION_VELOCITY_CLASS = {
  "FX": { class: "quick_win", typical_months: 2, gp_velocity: 1.0 },
  "FX Forwards": { class: "quick_win", typical_months: 3, gp_velocity: 0.9 },
  "Cards": { class: "quick_win", typical_months: 2, gp_velocity: 0.8 },
  "Spend Management": { class: "quick_win", typical_months: 3, gp_velocity: 0.6 },
  "API Integrations": { class: "long_play", typical_months: 6, gp_velocity: 0.5 },
  "Merchant Acquiring": { class: "long_play", typical_months: 8, gp_velocity: 0.7 },
  "Revolut Pay": { class: "long_play", typical_months: 6, gp_velocity: 0.6 },
};

const ENRICHMENT_STALENESS = {
  tech_stack: { max_age_days: 90, decay_after_days: 60 },
  hiring_signals: { max_age_days: 30, decay_after_days: 14 },
  website: { max_age_days: 90, decay_after_days: 60 },
  marketing: { max_age_days: 60, decay_after_days: 30 },
  reputation: { max_age_days: 180, decay_after_days: 120 },
  ownership: { max_age_days: 365, decay_after_days: 240 },
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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeLookupToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const next = String(value || "").trim();
    if (!next) continue;
    const token = next.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    output.push(next);
  }
  return output;
}

function resolveCompetitorProfile(name) {
  const token = normalizeLookupToken(name);
  if (!token) return null;

  let fallback = null;
  let fallbackScore = 0;

  for (const [knownName, profile] of Object.entries(COMPETITOR_INTELLIGENCE)) {
    const knownToken = normalizeLookupToken(knownName);
    if (!knownToken) continue;
    if (token === knownToken) return { name: knownName, ...profile };

    if (token.includes(knownToken) || knownToken.includes(token)) {
      const score = Math.min(token.length, knownToken.length);
      if (score > fallbackScore) {
        fallback = { name: knownName, ...profile };
        fallbackScore = score;
      }
    }
  }

  return fallback;
}

function inferIsolationScoreFromStickiness(stickiness) {
  const normalized = Math.max(1, Math.min(Number(stickiness || 3), 5));
  return clamp01(0.82 - ((normalized - 1) * 0.12));
}

function inferHolisticScoreFromIsolation(isolationScore, platformType) {
  const base = clamp01(Number(isolationScore || 0.5));
  if (["single_product", "payments_platform"].includes(platformType)) {
    return clamp01(base + 0.18);
  }
  if (["full_stack_bank", "enterprise_bank", "enterprise_suite", "commerce_anchor"].includes(platformType)) {
    return clamp01(base - 0.06);
  }
  return clamp01(base + 0.05);
}

function buildCompetitorRecord(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : { name: raw };
  const name = String(input.name || "").trim();
  if (!name) return null;

  const profile = resolveCompetitorProfile(name);
  const products = uniqueStrings([...(profile?.products || []), ...asArray(input.products)]);
  const weakness = String(input.weakness || profile?.weakness || "single_product_scope");
  const stickinessRaw = Number(input.stickiness ?? profile?.stickiness ?? 3);
  const stickiness = Math.max(1.5, Math.min(Number.isFinite(stickinessRaw) ? stickinessRaw : 3, 5));
  const platformType = String(input.platform_type || profile?.platform_type || "unknown");
  const isolationScore = clamp01(Number(
    input.isolation_score
    ?? profile?.isolation_score
    ?? inferIsolationScoreFromStickiness(stickiness)
  ));
  const holisticScore = clamp01(Number(
    input.holistic_score
    ?? profile?.holistic_score
    ?? inferHolisticScoreFromIsolation(isolationScore, platformType)
  ));
  const lockInStrength = clamp01(Number(input.lock_in_strength ?? profile?.lock_in_strength ?? (stickiness / 5)));
  const creditAnchor = Boolean(input.credit_anchor ?? profile?.credit_anchor ?? false);

  return {
    name,
    products,
    weakness,
    stickiness,
    platform_type: platformType,
    isolation_score: isolationScore,
    holistic_score: holisticScore,
    lock_in_strength: lockInStrength,
    credit_anchor: creditAnchor,
    source: input.source || null,
    snippet: input.snippet || null,
    inferred_advantage: input.inferred_advantage
      || COMPETITOR_ADVANTAGE_INFERENCE[weakness]
      || "Position a clearer operating model with stronger multi-product leverage.",
  };
}

function computeIndustryProductFitHint(industries = []) {
  const entries = asArray(industries)
    .map((industry) => ({
      industry,
      score: Number(INDUSTRY_PRODUCT_FIT[industry] || 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (entries.length === 0) {
    return { best_industry: "unknown", score: 0 };
  }

  return {
    best_industry: entries[0].industry,
    score: Math.round(entries[0].score * 100) / 100,
  };
}

function normalizeCompactToken(value) {
  return normalizeLookupToken(value).replace(/\s+/g, "");
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractApproxNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = String(match[2] || "").toLowerCase();
  if (unit === "k") return base * 1_000;
  if (unit === "m") return base * 1_000_000;
  if (unit === "b") return base * 1_000_000_000;
  return base;
}

function getEnrichmentTimestamp(payload) {
  if (!payload || typeof payload !== "object") return null;
  const keys = [
    "updated_at",
    "fetched_at",
    "generated_at",
    "collected_at",
    "scraped_at",
    "timestamp",
    "as_of",
    "run_at",
    "created_at",
  ];

  for (const key of keys) {
    if (payload[key]) return payload[key];
  }

  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : null;
  if (!meta) return null;
  for (const key of keys) {
    if (meta[key]) return meta[key];
  }
  return null;
}

function resolveEnrichmentPayload(settingKey, profileKey) {
  const raw = getSetting(settingKey, null);
  if (!raw || typeof raw !== "object") {
    return {
      data: null,
      available: false,
      stale: false,
      expired: false,
      decay_multiplier: 0,
      days_old: null,
      as_of: null,
      source_key: settingKey,
    };
  }

  const profile = ENRICHMENT_STALENESS[profileKey] || { max_age_days: 365, decay_after_days: 240 };
  const asOf = getEnrichmentTimestamp(raw);
  const daysOld = daysSinceDate(asOf);

  if (daysOld === null) {
    return {
      data: raw,
      available: true,
      stale: false,
      expired: false,
      decay_multiplier: 1,
      days_old: null,
      as_of: null,
      source_key: settingKey,
    };
  }

  const maxAge = Number(profile.max_age_days || 365);
  const decayAfter = Number(profile.decay_after_days || Math.floor(maxAge * 0.67));
  const expired = daysOld > maxAge;
  const stale = daysOld > decayAfter;

  if (expired) {
    return {
      data: null,
      available: false,
      stale: true,
      expired: true,
      decay_multiplier: 0,
      days_old: daysOld,
      as_of: asOf,
      source_key: settingKey,
    };
  }

  let decayMultiplier = 1;
  if (stale) {
    const span = Math.max(1, maxAge - decayAfter);
    const progress = Math.max(0, Math.min(daysOld - decayAfter, span));
    decayMultiplier = Math.max(0, 1 - (progress / span));
  }

  return {
    data: raw,
    available: true,
    stale,
    expired: false,
    decay_multiplier: Math.round(decayMultiplier * 100) / 100,
    days_old: daysOld,
    as_of: asOf,
    source_key: settingKey,
  };
}

function applyMotionBoostMap(motionScores, boostMap, sourceKey, capPerMotion = 0.35, scale = 1) {
  const adjustments = [];
  if (!boostMap || typeof boostMap !== "object") return adjustments;

  const sourceField = `${sourceKey}_boost`;
  const scaler = Math.max(0, Math.min(Number(scale || 1), 1.5));
  for (const [motion, rawBoost] of Object.entries(boostMap)) {
    if (!motionScores?.[motion]) continue;
    const base = Number(motionScores[motion].score || 0);
    const boost = Math.max(0, Math.min(Number(rawBoost || 0) * scaler, capPerMotion));
    if (!Number.isFinite(boost) || boost <= 0) continue;
    const next = clamp01(base + boost);
    const applied = Math.round((next - base) * 100) / 100;
    if (applied <= 0) continue;

    motionScores[motion].score = next;
    motionScores[motion][sourceField] = Math.round((Number(motionScores[motion][sourceField] || 0) + applied) * 100) / 100;
    adjustments.push({ motion, delta: applied, source: sourceKey });
  }

  return adjustments;
}

function mergeCompetitorSignals(existingCompetitors, extraCompetitors) {
  const output = Array.isArray(existingCompetitors) ? existingCompetitors : [];
  const existingByName = new Map();

  for (let idx = 0; idx < output.length; idx += 1) {
    const enriched = buildCompetitorRecord(output[idx]);
    if (!enriched) continue;
    output[idx] = { ...output[idx], ...enriched, snippet: output[idx]?.snippet || enriched.snippet };
    existingByName.set(normalizeLookupToken(enriched.name), output[idx]);
  }

  for (const item of asArray(extraCompetitors)) {
    const enriched = buildCompetitorRecord(item);
    if (!enriched) continue;

    const nameKey = normalizeLookupToken(enriched.name);
    const existing = existingByName.get(nameKey);
    if (!existing) {
      output.push(enriched);
      existingByName.set(nameKey, enriched);
      continue;
    }

    existing.products = uniqueStrings([...(existing.products || []), ...(enriched.products || [])]);
    existing.stickiness = Math.max(Number(existing.stickiness || 0), Number(enriched.stickiness || 0));
    existing.lock_in_strength = clamp01(Math.max(Number(existing.lock_in_strength || 0), Number(enriched.lock_in_strength || 0)));
    existing.isolation_score = clamp01(Math.max(Number(existing.isolation_score || 0), Number(enriched.isolation_score || 0)));
    existing.holistic_score = clamp01(Math.max(Number(existing.holistic_score || 0), Number(enriched.holistic_score || 0)));
    existing.credit_anchor = Boolean(existing.credit_anchor || enriched.credit_anchor);
    if (!existing.source && enriched.source) existing.source = enriched.source;
    if (!existing.snippet && enriched.snippet) existing.snippet = enriched.snippet;
    if (!existing.weakness) existing.weakness = enriched.weakness;
    if (!existing.inferred_advantage) existing.inferred_advantage = enriched.inferred_advantage;
    if (!existing.platform_type || existing.platform_type === "unknown") existing.platform_type = enriched.platform_type;
  }

  return output;
}

function extractTextEntries(payload, keys) {
  const values = [];
  for (const key of keys) {
    const value = payload?.[key];
    for (const item of asArray(value)) {
      if (item === null || item === undefined) continue;
      if (typeof item === "string" || typeof item === "number") {
        values.push(String(item));
      } else if (typeof item === "object") {
        if (item.name) values.push(String(item.name));
        if (item.value) values.push(String(item.value));
        if (item.title) values.push(String(item.title));
      }
    }
  }
  return values;
}

function resolveTechSignalKey(value) {
  const raw = normalizeCompactToken(value);
  if (!raw) return null;

  let fallback = null;
  let fallbackScore = 0;

  for (const key of Object.keys(TECH_STACK_MOTION_SIGNALS)) {
    const normalizedKey = normalizeCompactToken(key);
    if (!normalizedKey) continue;

    if (raw === normalizedKey) {
      return key;
    }

    if (raw.includes(normalizedKey) || normalizedKey.includes(raw)) {
      const score = Math.min(raw.length, normalizedKey.length);
      if (score > fallbackScore) {
        fallback = key;
        fallbackScore = score;
      }
    }
  }

  return fallback;
}

function scoreTechStackSignals(techStack, freshnessScale = 1) {
  if (!techStack || typeof techStack !== "object") {
    return { applied: false, motion_boosts: {}, competitor_signals: [], switching_delta: 0, b2c_confirmed: false, integration_ready: false, adjustments: [] };
  }

  const textEntries = extractTextEntries(techStack, [
    "technologies",
    "detected_technologies",
    "stack",
    "wappalyzer",
    "plugins",
    "detected_plugins",
    "platforms",
  ]);

  const directCandidates = [
    techStack?.payment_gateway,
    techStack?.payment_processor,
    techStack?.psp,
    techStack?.gateway,
    techStack?.accounting_software,
    techStack?.accounting_system,
    techStack?.erp,
    techStack?.ecommerce_platform,
    techStack?.store_platform,
  ].filter(Boolean);

  const allCandidates = [...directCandidates, ...textEntries];

  const motionBoosts = {};
  const competitorSignals = [];
  const adjustments = [];
  let switchingDelta = 0;
  let b2cConfirmed = false;
  let integrationReady = false;

  const seenSignals = new Set();
  for (const candidate of allCandidates) {
    const signalKey = resolveTechSignalKey(candidate);
    if (!signalKey || seenSignals.has(signalKey)) continue;
    seenSignals.add(signalKey);
    const config = TECH_STACK_MOTION_SIGNALS[signalKey];
    if (!config) continue;

    for (const [motion, boost] of Object.entries(config.motions || {})) {
      motionBoosts[motion] = (motionBoosts[motion] || 0) + Number(boost || 0);
    }
    switchingDelta += Number(config.switching || 0);

    if (config.competitor) {
      competitorSignals.push({
        name: signalKey,
        source: "tech_stack",
        products: Object.keys(config.motions || {}),
      });
    }

    if (config.b2c_confirmed) b2cConfirmed = true;
    if (config.integration_ready) integrationReady = true;
    adjustments.push({ source: "tech_stack", detected: signalKey });
  }

  const plugins = extractTextEntries(techStack, ["plugins", "detected_plugins", "technologies"]);
  const detectedCurrencyPlugins = plugins.filter((plugin) => {
    const token = normalizeLookupToken(plugin);
    return MULTI_CURRENCY_TECH_SIGNALS.some((sig) => token.includes(normalizeLookupToken(sig)));
  });
  if (detectedCurrencyPlugins.length > 0) {
    motionBoosts["FX"] = (motionBoosts["FX"] || 0) + 0.15;
    adjustments.push({ source: "multi_currency_plugins", count: detectedCurrencyPlugins.length });
  }

  const siteCurrencies = extractTextEntries(techStack, ["currencies_detected", "currencies_on_site", "site_currencies", "pricing_currencies"]);
  if (siteCurrencies.length >= 2) {
    motionBoosts["FX"] = (motionBoosts["FX"] || 0) + 0.12;
    if (siteCurrencies.length >= 3) {
      motionBoosts["FX Forwards"] = (motionBoosts["FX Forwards"] || 0) + 0.08;
    }
    adjustments.push({ source: "site_currencies", currencies: siteCurrencies.slice(0, 8) });
  }

  const scaledMotionBoosts = {};
  const scaler = Math.max(0, Math.min(Number(freshnessScale || 1), 1));
  for (const [motion, boost] of Object.entries(motionBoosts)) {
    scaledMotionBoosts[motion] = Math.round((Number(boost || 0) * scaler) * 1000) / 1000;
  }

  return {
    applied: adjustments.length > 0,
    motion_boosts: scaledMotionBoosts,
    competitor_signals: competitorSignals,
    switching_delta: Math.max(-0.15, Math.min(0.2, switchingDelta * scaler)),
    b2c_confirmed: b2cConfirmed,
    integration_ready: integrationReady,
    adjustments,
  };
}

function scoreHiringSignals(hiringData, freshnessScale = 1) {
  if (!hiringData || typeof hiringData !== "object") {
    return {
      applied: false,
      urgency_boost: 0,
      pain_boost: 0,
      propensity_boost: 0,
      headcount_urgency_boost: 0,
      motion_boosts: {},
      velocity_triggers: [],
      adjustments: [],
    };
  }

  const scaler = Math.max(0, Math.min(Number(freshnessScale || 1), 1));
  let urgencyBoost = 0;
  let painBoost = 0;
  const motionBoosts = {};
  const velocityTriggers = [];
  const adjustments = [];

  const newSeniorHires = asArray(hiringData.new_senior_hires);
  for (const hire of newSeniorHires) {
    const role = String(hire?.role || "").trim();
    if (!role) continue;
    const roleToken = normalizeLookupToken(role);
    for (const [pattern, config] of Object.entries(HIRING_SIGNAL_WEIGHTS.urgency)) {
      if (!roleToken.includes(normalizeLookupToken(pattern))) continue;
      const monthsSinceHire = hire?.start_date
        ? Math.max(0, (Date.now() - new Date(hire.start_date).getTime()) / (30 * 86400000))
        : 6;
      const recencyMultiplier = monthsSinceHire <= 3 ? 1 : monthsSinceHire <= 6 ? 0.7 : 0.4;
      const delta = Number(config.boost || 0) * recencyMultiplier;
      urgencyBoost += delta;
      if (config.velocity_trigger) velocityTriggers.push(config.velocity_trigger);
      adjustments.push({ type: "new_senior_hire", role, months_since: Math.round(monthsSinceHire), boost: Math.round(delta * 100) / 100 });
      break;
    }
  }

  const openRoleGroups = [
    ...asArray(hiringData.finance_roles_open),
    ...asArray(hiringData.treasury_roles_open),
    ...asArray(hiringData.international_roles_open),
    ...asArray(hiringData.ecommerce_roles_open),
    ...asArray(hiringData.open_roles),
  ];

  for (const roleValue of openRoleGroups) {
    const role = String(roleValue?.role || roleValue || "").trim();
    if (!role) continue;
    const roleToken = normalizeLookupToken(role);

    for (const [pattern, config] of Object.entries(HIRING_SIGNAL_WEIGHTS.motion_signals)) {
      if (!roleToken.includes(normalizeLookupToken(pattern))) continue;
      for (const [motion, boost] of Object.entries(config.motions || {})) {
        motionBoosts[motion] = (motionBoosts[motion] || 0) + (Number(boost || 0) * 0.6);
      }
      painBoost += Number(config.pain_boost || 0) * 0.6;
      adjustments.push({ type: "open_role", role, pattern });
      break;
    }

    for (const [pattern, config] of Object.entries(HIRING_SIGNAL_WEIGHTS.urgency)) {
      if (!roleToken.includes(normalizeLookupToken(pattern))) continue;
      urgencyBoost += Number(config.boost || 0) * 0.5;
      adjustments.push({ type: "open_urgency_role", role });
      break;
    }
  }

  const headcountGrowthPctRaw = toFiniteNumber(hiringData.headcount_growth_pct, NaN);
  const employeeCount = toFiniteNumber(hiringData.employee_count, NaN);
  const employeeCount12mAgo = toFiniteNumber(hiringData.employee_count_12m_ago, NaN);
  const derivedGrowth = Number.isFinite(employeeCount) && Number.isFinite(employeeCount12mAgo) && employeeCount12mAgo > 0
    ? ((employeeCount - employeeCount12mAgo) / employeeCount12mAgo) * 100
    : NaN;
  const growthPct = Number.isFinite(headcountGrowthPctRaw) ? headcountGrowthPctRaw : derivedGrowth;

  let headcountPropensityBoost = 0;
  let headcountUrgencyBoost = 0;
  if (Number.isFinite(growthPct)) {
    for (const band of HEADCOUNT_GROWTH_THRESHOLDS) {
      if (growthPct < band.min_pct) continue;
      headcountPropensityBoost = Number(band.propensity_boost || 0);
      headcountUrgencyBoost = Number(band.urgency_boost || 0);
      if (growthPct >= 20) velocityTriggers.push("headcount_growth");
      adjustments.push({ type: "headcount_growth", pct: Math.round(growthPct), band: band.band });
      break;
    }
  }

  const totalOpenRoles = toFiniteNumber(hiringData.total_open_roles, 0);
  if (totalOpenRoles >= 20) {
    headcountPropensityBoost += 0.04;
    adjustments.push({ type: "total_open_roles", count: totalOpenRoles });
  }

  const scaledMotionBoosts = {};
  for (const [motion, boost] of Object.entries(motionBoosts)) {
    scaledMotionBoosts[motion] = Math.round((Number(boost || 0) * scaler) * 1000) / 1000;
  }

  return {
    applied: adjustments.length > 0,
    urgency_boost: Math.min(urgencyBoost * scaler, 0.25),
    pain_boost: Math.min(painBoost * scaler, 0.15),
    propensity_boost: headcountPropensityBoost * scaler,
    headcount_urgency_boost: headcountUrgencyBoost * scaler,
    motion_boosts: scaledMotionBoosts,
    velocity_triggers: [...new Set(velocityTriggers)],
    adjustments,
  };
}

function scoreWebsiteIntelligence(websiteData, freshnessScale = 1) {
  if (!websiteData || typeof websiteData !== "object") {
    return {
      applied: false,
      motion_boosts: {},
      pain_boost: 0,
      b2c_confirmed: false,
      employee_count_override: null,
      adjustments: [],
    };
  }

  const scaler = Math.max(0, Math.min(Number(freshnessScale || 1), 1));
  const motionBoosts = {};
  let painBoost = 0;
  let b2cConfirmed = false;
  const adjustments = [];

  const pricingCurrencies = extractTextEntries(websiteData, ["pricing_currencies", "currencies_on_pricing_page", "site_currencies", "currencies"]);
  if (pricingCurrencies.length >= 2) {
    motionBoosts["FX"] = (motionBoosts["FX"] || 0) + 0.18;
    if (pricingCurrencies.length >= 3) {
      motionBoosts["FX Forwards"] = (motionBoosts["FX Forwards"] || 0) + 0.10;
    }
    adjustments.push({ source: "pricing_currencies", count: pricingCurrencies.length });
  }

  const internationalShipping = !!websiteData.international_shipping;
  const shippingCountries = toFiniteNumber(websiteData.shipping_countries, 0);
  if (internationalShipping) {
    motionBoosts["FX"] = (motionBoosts["FX"] || 0) + 0.12;
    if (shippingCountries >= 20) {
      motionBoosts["FX Forwards"] = (motionBoosts["FX Forwards"] || 0) + 0.08;
    }
    adjustments.push({ source: "international_shipping", countries: shippingCountries });
  }

  const officeLocations = extractTextEntries(websiteData, ["office_locations", "locations", "regional_offices"]);
  if (officeLocations.length >= 3) {
    motionBoosts["Cards"] = (motionBoosts["Cards"] || 0) + 0.12;
    motionBoosts["Spend Management"] = (motionBoosts["Spend Management"] || 0) + 0.10;
    painBoost += 0.06;
    adjustments.push({ source: "multi_location", count: officeLocations.length });
  }

  const internationalOffices = officeLocations.filter((location) => {
    const token = normalizeLookupToken(location);
    if (!token) return false;
    return !/(london|uk|england|scotland|wales|northern ireland)/i.test(token);
  });
  if (internationalOffices.length > 0) {
    motionBoosts["FX"] = (motionBoosts["FX"] || 0) + 0.10;
    adjustments.push({ source: "international_offices", count: internationalOffices.length });
  }

  const customerType = normalizeLookupToken(websiteData.customer_type);
  if (customerType.includes("b2c") || customerType.includes("consumer")) {
    b2cConfirmed = true;
    motionBoosts["Merchant Acquiring"] = (motionBoosts["Merchant Acquiring"] || 0) + 0.12;
    motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.10;
    adjustments.push({ source: "customer_type", type: "b2c" });
  }

  const websiteEmployees = toFiniteNumber(websiteData.employee_count_claimed, toFiniteNumber(websiteData.employee_count, 0));
  if (websiteEmployees >= 200) {
    motionBoosts["Cards"] = (motionBoosts["Cards"] || 0) + 0.10;
    motionBoosts["Spend Management"] = (motionBoosts["Spend Management"] || 0) + 0.08;
    painBoost += 0.04;
    adjustments.push({ source: "employee_count", value: websiteEmployees });
  }

  const scaledMotionBoosts = {};
  for (const [motion, boost] of Object.entries(motionBoosts)) {
    scaledMotionBoosts[motion] = Math.round((Number(boost || 0) * scaler) * 1000) / 1000;
  }

  return {
    applied: adjustments.length > 0,
    motion_boosts: scaledMotionBoosts,
    pain_boost: Math.min(painBoost * scaler, 0.12),
    b2c_confirmed: b2cConfirmed,
    employee_count_override: websiteEmployees > 0 ? websiteEmployees : null,
    adjustments,
  };
}

function scoreMarketingIntelligence(marketingData, freshnessScale = 1) {
  if (!marketingData || typeof marketingData !== "object") {
    return {
      applied: false,
      motion_boosts: {},
      pain_boost: 0,
      commercial_value_boost: 0,
      adjustments: [],
    };
  }

  const scaler = Math.max(0, Math.min(Number(freshnessScale || 1), 1));
  const motionBoosts = {};
  let painBoost = 0;
  let commercialValueBoost = 0;
  const adjustments = [];

  const monthlyTraffic = toFiniteNumber(
    marketingData.monthly_web_traffic,
    toFiniteNumber(marketingData.web_traffic, 0)
  );

  if (monthlyTraffic >= 500_000) {
    motionBoosts["Merchant Acquiring"] = (motionBoosts["Merchant Acquiring"] || 0) + 0.15;
    motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.12;
    commercialValueBoost += 0.08;
    adjustments.push({ source: "high_traffic", monthly: monthlyTraffic });
  } else if (monthlyTraffic >= 100_000) {
    motionBoosts["Merchant Acquiring"] = (motionBoosts["Merchant Acquiring"] || 0) + 0.08;
    motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.06;
    commercialValueBoost += 0.04;
    adjustments.push({ source: "moderate_traffic", monthly: monthlyTraffic });
  }

  const adSpendValue = extractApproxNumber(marketingData.estimated_monthly_ad_spend ?? marketingData.estimated_ad_spend);
  if (Number.isFinite(adSpendValue) && adSpendValue >= 50_000) {
    motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.15;
    painBoost += 0.06;
    adjustments.push({ source: "ad_spend", level: "high" });
  } else if (Number.isFinite(adSpendValue) && adSpendValue >= 20_000) {
    motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.08;
    painBoost += 0.03;
    adjustments.push({ source: "ad_spend", level: "moderate" });
  }

  const geography = marketingData.traffic_geography && typeof marketingData.traffic_geography === "object"
    ? marketingData.traffic_geography
    : {};
  const ukShare = toFiniteNumber(geography.UK, toFiniteNumber(geography.uk, 100));
  if (ukShare < 70) {
    motionBoosts["FX"] = (motionBoosts["FX"] || 0) + 0.10;
    if (ukShare < 50) {
      motionBoosts["FX Forwards"] = (motionBoosts["FX Forwards"] || 0) + 0.06;
    }
    adjustments.push({ source: "international_traffic", uk_pct: ukShare });
  }

  const scaledMotionBoosts = {};
  for (const [motion, boost] of Object.entries(motionBoosts)) {
    scaledMotionBoosts[motion] = Math.round((Number(boost || 0) * scaler) * 1000) / 1000;
  }

  return {
    applied: adjustments.length > 0,
    motion_boosts: scaledMotionBoosts,
    pain_boost: Math.min(painBoost * scaler, 0.10),
    commercial_value_boost: Math.max(0, commercialValueBoost * scaler),
    adjustments,
  };
}

function scoreReputationSignals(reputationData, freshnessScale = 1) {
  if (!reputationData || typeof reputationData !== "object") {
    return {
      applied: false,
      motion_boosts: {},
      pain_boost: 0,
      adjustments: [],
    };
  }

  const scaler = Math.max(0, Math.min(Number(freshnessScale || 1), 1));
  const motionBoosts = {};
  let painBoost = 0;
  const adjustments = [];

  const paymentComplaints = toFiniteNumber(reputationData.payment_related_complaints, 0);
  const checkoutComplaints = toFiniteNumber(reputationData.checkout_related_complaints, 0);
  const totalReviews = toFiniteNumber(reputationData.trustpilot_review_count, 0);
  const statusIncidentsOpen = Math.max(0, toFiniteNumber(reputationData.status_incidents_open, 0));
  const statusMajorOpen = Math.max(0, toFiniteNumber(reputationData.status_major_incidents_open, 0));
  const statusDegradedComponents = Math.max(0, toFiniteNumber(reputationData.status_degraded_components, 0));

  const defaultStatusWeightedOpen = statusIncidentsOpen + (statusMajorOpen * 1.5) + (statusDegradedComponents * 0.75);
  const statusWeightedOpen = Math.max(0, toFiniteNumber(reputationData.status_incident_weighted_open, defaultStatusWeightedOpen));
  const statusIncidentTotal = Math.max(statusIncidentsOpen, toFiniteNumber(reputationData.status_incidents_total, 0));
  const statusDenominator = Math.max(4, statusIncidentTotal + statusDegradedComponents + 2);
  const computedStatusSeverity = statusWeightedOpen > 0 ? Math.min(statusWeightedOpen / statusDenominator, 1) : 0;
  const statusSeverityScore = Math.max(0, Math.min(toFiniteNumber(reputationData.status_incident_severity_score, computedStatusSeverity), 1));
  const statusRecencyMultiplier = Math.max(0, Math.min(toFiniteNumber(reputationData.status_incident_recency_multiplier, 1), 1));
  const statusRecentIncidentAgeDaysRaw = Number(reputationData.status_recent_incident_age_days);
  const statusRecentIncidentAgeDays = Number.isFinite(statusRecentIncidentAgeDaysRaw)
    ? Math.max(0, Math.round(statusRecentIncidentAgeDaysRaw * 10) / 10)
    : null;

  if (statusSeverityScore >= 0.2 || statusIncidentsOpen > 0) {
    const acquiringBoost = Math.min(
      0.12,
      0.04 + (statusSeverityScore * 0.08) + (Math.min(statusMajorOpen, 2) * 0.01)
    );
    motionBoosts["Merchant Acquiring"] = (motionBoosts["Merchant Acquiring"] || 0) + acquiringBoost;

    if (statusMajorOpen >= 1 || statusSeverityScore >= 0.6) {
      motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.05;
    }

    painBoost += Math.min(0.06, 0.015 + (statusSeverityScore * 0.06) + (Math.min(statusMajorOpen, 2) * 0.01));
    adjustments.push({
      source: "status_incident_health",
      open_count: statusIncidentsOpen,
      major_open_count: statusMajorOpen,
      degraded_components: statusDegradedComponents,
      severity_score: Math.round(statusSeverityScore * 100) / 100,
      recency_multiplier: Math.round(statusRecencyMultiplier * 100) / 100,
      recent_incident_age_days: statusRecentIncidentAgeDays,
    });
  }

  if (paymentComplaints >= 5 || (totalReviews > 500 && paymentComplaints >= 3)) {
    motionBoosts["Merchant Acquiring"] = (motionBoosts["Merchant Acquiring"] || 0) + 0.10;
    painBoost += 0.06;
    adjustments.push({ source: "payment_complaints", count: paymentComplaints });
  }

  if (checkoutComplaints >= 3) {
    motionBoosts["Revolut Pay"] = (motionBoosts["Revolut Pay"] || 0) + 0.08;
    painBoost += 0.04;
    adjustments.push({ source: "checkout_complaints", count: checkoutComplaints });
  }

  if (totalReviews >= 1000) {
    motionBoosts["Merchant Acquiring"] = (motionBoosts["Merchant Acquiring"] || 0) + 0.06;
    adjustments.push({ source: "high_review_volume", count: totalReviews });
  }

  const scaledMotionBoosts = {};
  for (const [motion, boost] of Object.entries(motionBoosts)) {
    scaledMotionBoosts[motion] = Math.round((Number(boost || 0) * scaler) * 1000) / 1000;
  }

  return {
    applied: adjustments.length > 0,
    motion_boosts: scaledMotionBoosts,
    pain_boost: Math.min(painBoost * scaler, 0.10),
    adjustments,
  };
}

function scoreOwnershipStructure(ownershipData, freshnessScale = 1) {
  if (!ownershipData || typeof ownershipData !== "object") {
    return {
      applied: false,
      classified_as: "unknown",
      switching_feasibility_delta: 0,
      urgency_boost: 0,
      motion_boosts: {},
      pain_boost: 0,
      evidence: {
        significant_corporate_controllers_count: 0,
        non_uk_significant_corporate_controllers_count: 0,
      },
    };
  }

  const structure = normalizeLookupToken(ownershipData.structure);
  const peBacked = ownershipData.pe_backed === true;
  const parentCompany = ownershipData.parent_company || null;
  const parentCountry = normalizeLookupToken(ownershipData.parent_country);
  const significantCorporateCount = toFiniteNumber(
    ownershipData.significant_corporate_controllers_count,
    Array.isArray(ownershipData.significant_corporate_controllers)
      ? ownershipData.significant_corporate_controllers.length
      : 0
  );
  const nonUkSignificantCorporateCount = toFiniteNumber(
    ownershipData.non_uk_significant_corporate_controllers_count,
    Array.isArray(ownershipData.non_uk_significant_corporate_controllers)
      ? ownershipData.non_uk_significant_corporate_controllers.length
      : 0
  );
  const hasNonUkSignificantCorporateController = nonUkSignificantCorporateCount >= 1;
  const scaler = Math.max(0, Math.min(Number(freshnessScale || 1), 1));

  let profile = null;
  let classifiedAs = "unknown";
  let nonUkCorporateMultiplier = 1;

  if (peBacked) {
    profile = OWNERSHIP_SCORING_EFFECTS.pe_backed;
    classifiedAs = "pe_backed";
  } else if (hasNonUkSignificantCorporateController) {
    profile = OWNERSHIP_SCORING_EFFECTS.foreign_subsidiary;
    classifiedAs = "foreign_subsidiary";
    nonUkCorporateMultiplier = Math.min(1.6, 1 + ((nonUkSignificantCorporateCount - 1) * 0.12));
  } else if (parentCompany && parentCountry && parentCountry !== "uk" && parentCountry !== "united kingdom") {
    profile = OWNERSHIP_SCORING_EFFECTS.foreign_subsidiary;
    classifiedAs = "foreign_subsidiary";
  } else if (structure.includes("family") || structure.includes("owner operator") || structure.includes("owner_operator")) {
    profile = OWNERSHIP_SCORING_EFFECTS.family_owned;
    classifiedAs = "family_owned";
  } else if (structure.includes("public") || structure.includes("plc")) {
    profile = OWNERSHIP_SCORING_EFFECTS.public_company;
    classifiedAs = "public_company";
  }

  if (!profile) {
    return {
      applied: false,
      classified_as: "unknown",
      switching_feasibility_delta: 0,
      urgency_boost: 0,
      motion_boosts: {},
      pain_boost: 0,
      evidence: {
        significant_corporate_controllers_count: significantCorporateCount,
        non_uk_significant_corporate_controllers_count: nonUkSignificantCorporateCount,
      },
    };
  }

  const motionBoosts = {};
  for (const [motion, boost] of Object.entries(profile.motion_boosts || {})) {
    motionBoosts[motion] = Math.round((Number(boost || 0) * nonUkCorporateMultiplier * scaler) * 1000) / 1000;
  }

  return {
    applied: true,
    classified_as: classifiedAs,
    switching_feasibility_delta: Number(profile.switching_feasibility_delta || 0) * nonUkCorporateMultiplier * scaler,
    urgency_boost: Number(profile.urgency_boost || 0) * nonUkCorporateMultiplier * scaler,
    motion_boosts: motionBoosts,
    pain_boost: Number(profile.pain_boost || 0) * nonUkCorporateMultiplier * scaler,
    evidence: {
      significant_corporate_controllers_count: significantCorporateCount,
      non_uk_significant_corporate_controllers_count: nonUkSignificantCorporateCount,
      has_non_uk_significant_corporate_controller: hasNonUkSignificantCorporateController,
      source: ownershipData.source || null,
    },
  };
}

function classifyBusinessModel(params = {}) {
  const industries = asArray(params.industries);
  const techStackSignals = params.techStackSignals || {};
  const websiteData = params.websiteData || {};
  const marketingData = params.marketingData || {};
  const reputationData = params.reputationData || {};
  const filingText = String(params.filingText || "");

  let b2cScore = 0;
  let b2bScore = 0;
  const signals = [];

  const b2cIndustries = ["retail", "ecommerce", "hospitality", "food", "travel", "restaurant"];
  const b2bIndustries = ["consulting", "construction", "manufacturing", "logistics", "freight", "it", "saas"];

  for (const industry of industries) {
    if (b2cIndustries.includes(industry)) {
      b2cScore += 0.25;
      signals.push({ source: "industry", type: "b2c", value: industry });
    }
    if (b2bIndustries.includes(industry)) {
      b2bScore += 0.25;
      signals.push({ source: "industry", type: "b2b", value: industry });
    }
  }

  if (techStackSignals?.b2c_confirmed) {
    b2cScore += 0.30;
    signals.push({ source: "tech_stack", type: "b2c" });
  }

  const customerType = normalizeLookupToken(websiteData.customer_type);
  if (customerType.includes("b2c") || customerType.includes("consumer")) {
    b2cScore += 0.25;
    signals.push({ source: "website", type: "b2c" });
  }
  if (customerType.includes("b2b") || customerType.includes("enterprise")) {
    b2bScore += 0.25;
    signals.push({ source: "website", type: "b2b" });
  }

  const reviewCount = toFiniteNumber(reputationData.trustpilot_review_count, 0);
  if (reviewCount >= 500) {
    b2cScore += 0.20;
    signals.push({ source: "reviews", type: "b2c" });
  }

  const monthlyTraffic = toFiniteNumber(marketingData.monthly_web_traffic, toFiniteNumber(marketingData.web_traffic, 0));
  if (monthlyTraffic >= 200_000) {
    b2cScore += 0.15;
    signals.push({ source: "traffic", type: "b2c" });
  }

  if (/(?:consumer|customer|retail|checkout|storefront|shop|basket)/i.test(filingText)) b2cScore += 0.10;
  if (/(?:client|contract|invoice|tender|procurement|b2b)/i.test(filingText)) b2bScore += 0.10;

  const total = b2cScore + b2bScore;
  const classification = total === 0
    ? "unknown"
    : b2cScore > (b2bScore * 1.5)
      ? "B2C"
      : b2bScore > (b2cScore * 1.5)
        ? "B2B"
        : "hybrid";

  return {
    classification,
    b2c_score: Math.round(b2cScore * 100) / 100,
    b2b_score: Math.round(b2bScore * 100) / 100,
    confidence: total > 0.5 ? "high" : total > 0.25 ? "medium" : "low",
    signals,
  };
}

function applyBusinessModelCalibration(motionScores, classification) {
  const weights = BUSINESS_MODEL_MOTION_WEIGHTS[classification] || {};
  const adjustments = [];

  for (const [motion, multiplier] of Object.entries(weights)) {
    if (!motionScores[motion]) continue;
    if (Math.abs(Number(multiplier || 1) - 1) < 0.001) continue;
    const raw = Number(motionScores[motion].score || 0);
    const adjusted = clamp01(raw * Number(multiplier || 1));
    const delta = Math.round((adjusted - raw) * 100) / 100;
    if (Math.abs(delta) < 0.001) continue;
    motionScores[motion].score = adjusted;
    motionScores[motion].business_model_multiplier = Number(multiplier || 1);
    adjustments.push({ motion, multiplier: Number(multiplier || 1), delta });
  }

  return { classification, adjustments };
}

function classifyMotionVelocity(bestMotion) {
  return MOTION_VELOCITY_CLASS[bestMotion] || { class: "unknown", typical_months: 6, gp_velocity: 0.5 };
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
  const brandAwareness = normalizeLookupToken(params.brandAwareness || "unknown");

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

  if (brandAwareness === "known retail") {
    score += 0.06;
    triggers.push("brand_aware_retail");
  } else if (brandAwareness === "known business") {
    score += 0.12;
    triggers.push("brand_aware_business");
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

function buildConfidenceInterval(score, evidenceConfidence, filingRecency, textLength, motionScores, enrichmentMeta = {}) {
  const confidence = clamp01(evidenceConfidence);
  const recencyMultiplier = clamp01(filingRecency?.signal_multiplier ?? 0.6);
  const normalizedTextLength = Number(textLength || 0);
  const activeMotions = Object.values(motionScores || {}).filter((m) => Number(m.score || 0) >= 0.25).length;

  let plusMinus = 0.06;
  plusMinus += (1 - confidence) * 0.24;
  plusMinus += (1 - recencyMultiplier) * 0.14;
  if (normalizedTextLength < 500) plusMinus += 0.08;
  if (activeMotions < 2) plusMinus += 0.05;

  const enrichmentSources = Number(enrichmentMeta?.enrichment_source_count || 0);
  if (enrichmentSources >= 4) plusMinus -= 0.06;
  else if (enrichmentSources >= 2) plusMinus -= 0.03;
  else if (enrichmentSources >= 1) plusMinus -= 0.01;

  if (enrichmentMeta?.tech_stack_confirmed) plusMinus -= 0.02;

  plusMinus = Math.min(0.38, Math.max(0.04, plusMinus));

  const lower = clamp01(Number(score || 0) - plusMinus);
  const upper = clamp01(Number(score || 0) + plusMinus);
  const confidenceLevel = plusMinus <= 0.11 ? "high" : plusMinus <= 0.21 ? "medium" : "low";

  const reasons = [];
  if (normalizedTextLength < 500) reasons.push("thin_filing_text");
  if (recencyMultiplier < 0.7) reasons.push("stale_filing_signals");
  if (activeMotions < 2) reasons.push("limited_motion_evidence");
  if (confidence < 0.55) reasons.push("low_evidence_confidence");
  if (enrichmentSources >= 1) reasons.push("enrichment_supported");

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
  const enrichmentMarker = meta.enrichment_marker || "none";
  return `${filingDate}|${textLength}|${filingCount}|${turnover}|${chargeMarker}|${enrichmentMarker}`;
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

function scoreSwitchingFeasibility(text, competitors, qualSignals, chargeSummary, competitorTuning = null, enrichmentTuning = null, competitorContext = null) {
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

  const anchorDrag = Number(competitorContext?.anchor_drag || 0);
  if (anchorDrag > 0) {
    const impact = -Math.min(anchorDrag * 0.5, 0.14);
    score += impact;
    adjustments.push({ reason: "anchor_effect_drag", impact: Math.round(impact * 100) / 100 });
  }

  const consolidationLift = Number(competitorContext?.platform_consolidation_bonus || 0)
    + Number(competitorContext?.fragmented_stack_bonus || 0);
  if (consolidationLift > 0) {
    const impact = Math.min(consolidationLift * 0.55, 0.12);
    score += impact;
    adjustments.push({ reason: "platform_consolidation_opportunity", impact: Math.round(impact * 100) / 100 });
  }

  const singleProductCount = Number(competitorContext?.single_product_count || 0);
  if (singleProductCount >= 3) {
    score += 0.03;
    adjustments.push({ reason: "multi_specialist_displacement", impact: 0.03 });
  }

  const competitorFeasibilityDelta = Number(competitorTuning?.switching_feasibility_delta || 0);
  if (competitorFeasibilityDelta !== 0) {
    score += competitorFeasibilityDelta;
    adjustments.push({ reason: "competitor_specific_feasibility", impact: competitorFeasibilityDelta });
  }

  const techStackSwitchingDelta = Number(enrichmentTuning?.techStackSwitchingDelta || 0);
  if (techStackSwitchingDelta !== 0) {
    score += Math.max(-0.2, Math.min(0.2, techStackSwitchingDelta));
    adjustments.push({ reason: "tech_stack_switching_signal", impact: Math.max(-0.2, Math.min(0.2, techStackSwitchingDelta)) });
  }

  const ownershipSwitchingDelta = Number(enrichmentTuning?.ownershipSwitchingDelta || 0);
  if (ownershipSwitchingDelta !== 0) {
    score += Math.max(-0.2, Math.min(0.2, ownershipSwitchingDelta));
    adjustments.push({ reason: "ownership_structure", impact: Math.max(-0.2, Math.min(0.2, ownershipSwitchingDelta)) });
  }

  if (enrichmentTuning?.integrationReady) {
    score += 0.04;
    adjustments.push({ reason: "integration_ready_stack", impact: 0.04 });
  }

  return {
    score: clamp01(score),
    has_credit_signals: hasCreditSignals,
    has_multi_bank_signals: hasMultiBankSignals,
    has_long_tenure_incumbent: hasLongTenureIncumbent,
    has_strong_bank_incumbent: hasStrongBankIncumbent,
    integration_ready_stack: !!enrichmentTuning?.integrationReady,
    competitor_context_signal: competitorContext?.strategic_signal || "none",
    platform_consolidation_bonus: Number(competitorContext?.platform_consolidation_bonus || 0),
    anchor_drag: Number(competitorContext?.anchor_drag || 0),
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
      const competitor = buildCompetitorRecord({
        name,
        products: config.products,
        weakness: config.weakness,
        stickiness: config.stickiness,
        snippet: buildSnippet(text, match.index || 0, match[0]?.length || name.length),
      });
      if (competitor) detected.push(competitor);
    }
  }
  return detected;
}

function scoreCompetitorContext(competitors, motionScores = {}, businessModel = "unknown") {
  const detected = Array.isArray(competitors) ? competitors.filter(Boolean) : [];
  if (detected.length === 0) {
    return {
      score: 0.5,
      isolation_score: 0.5,
      holistic_score: 0.5,
      fragmented_stack_bonus: 0,
      platform_consolidation_bonus: 0,
      anchor_drag: 0,
      incumbent_lock_index: 0.5,
      single_product_count: 0,
      strong_incumbent_count: 0,
      product_coverage_count: 0,
      strategic_signal: "none",
      detected_count: 0,
    };
  }

  const strongMotions = new Set(
    Object.entries(motionScores || {})
      .filter(([, data]) => Number(data?.score || 0) >= 0.35)
      .map(([motion]) => motion)
  );

  const legacyWeaknesses = new Set([
    "digital_friction",
    "legacy_costs",
    "legacy_pricing",
    "expensive_complex",
    "enterprise_gated",
    "limited_mm_depth",
  ]);

  let weightedIsolation = 0;
  let weightedHolistic = 0;
  let weightTotal = 0;
  let totalStickiness = 0;
  let totalLockIn = 0;
  let singleProductCount = 0;
  let strongIncumbentCount = 0;
  let legacyOpportunityBoost = 0;
  const productCoverage = new Set();

  for (const competitor of detected) {
    const products = asArray(competitor.products);
    for (const product of products) productCoverage.add(product);

    const stickiness = Math.max(1, Math.min(Number(competitor.stickiness || 3), 5));
    const platformType = String(competitor.platform_type || "unknown");
    const isolationScore = clamp01(Number(
      competitor.isolation_score
      ?? inferIsolationScoreFromStickiness(stickiness)
    ));
    const holisticScore = clamp01(Number(
      competitor.holistic_score
      ?? inferHolisticScoreFromIsolation(isolationScore, platformType)
    ));
    const lockInStrength = clamp01(Number(competitor.lock_in_strength ?? (stickiness / 5)));

    const overlappingStrongMotions = strongMotions.size === 0
      ? 0
      : products.filter((product) => strongMotions.has(product)).length;
    let relevanceWeight = 1;
    if (strongMotions.size > 0) {
      if (overlappingStrongMotions > 0) relevanceWeight += Math.min(overlappingStrongMotions * 0.25, 0.5);
      else if (products.length > 0) relevanceWeight -= 0.15;
    }
    relevanceWeight = Math.max(0.65, relevanceWeight);

    weightedIsolation += isolationScore * relevanceWeight;
    weightedHolistic += holisticScore * relevanceWeight;
    weightTotal += relevanceWeight;

    totalStickiness += stickiness;
    totalLockIn += lockInStrength;

    if (["single_product", "payments_platform"].includes(platformType)) {
      singleProductCount += 1;
    }

    if (["full_stack_bank", "enterprise_bank", "enterprise_suite", "commerce_anchor"].includes(platformType) || competitor.credit_anchor) {
      strongIncumbentCount += 1;
    }

    if (legacyWeaknesses.has(String(competitor.weakness || ""))) {
      legacyOpportunityBoost += 0.015;
    }
  }

  const avgIsolation = weightTotal > 0 ? (weightedIsolation / weightTotal) : 0.5;
  const avgHolistic = weightTotal > 0 ? (weightedHolistic / weightTotal) : 0.5;
  const avgStickiness = totalStickiness / detected.length;
  const avgLockIn = totalLockIn / detected.length;
  const productCoverageCount = productCoverage.size;

  const fragmentedStackBonus = Math.min(
    (singleProductCount >= 2 ? 0.05 : 0)
    + (productCoverageCount >= 3 ? 0.04 : 0)
    + (productCoverageCount >= 4 ? 0.02 : 0),
    0.12
  );
  const platformConsolidationBonus = Math.min(singleProductCount * 0.02, 0.10);
  const anchorDrag = Math.min((avgLockIn * 0.08) + (strongIncumbentCount * 0.02), 0.20);

  let businessModelAdjustment = 0;
  if (businessModel === "B2C" && productCoverage.has("Merchant Acquiring")) businessModelAdjustment += 0.02;
  if (businessModel === "B2B" && (productCoverage.has("FX") || productCoverage.has("FX Forwards"))) businessModelAdjustment += 0.015;

  const score = clamp01(
    (avgIsolation * 0.46)
    + (avgHolistic * 0.36)
    + fragmentedStackBonus
    + platformConsolidationBonus
    + Math.min(legacyOpportunityBoost, 0.06)
    + businessModelAdjustment
    - anchorDrag
  );

  const strategicSignal = anchorDrag >= 0.12 && platformConsolidationBonus < 0.05
    ? "anchor_heavy"
    : platformConsolidationBonus >= 0.08
      ? "consolidation_play"
      : fragmentedStackBonus >= 0.07
        ? "fragmented_stack"
        : "balanced";

  return {
    score,
    isolation_score: Math.round(avgIsolation * 100) / 100,
    holistic_score: Math.round(avgHolistic * 100) / 100,
    fragmented_stack_bonus: Math.round(fragmentedStackBonus * 100) / 100,
    platform_consolidation_bonus: Math.round(platformConsolidationBonus * 100) / 100,
    anchor_drag: Math.round(anchorDrag * 100) / 100,
    incumbent_lock_index: Math.round(clamp01((avgStickiness / 5) * 0.55 + (avgLockIn * 0.45)) * 100) / 100,
    single_product_count: singleProductCount,
    strong_incumbent_count: strongIncumbentCount,
    product_coverage_count: productCoverageCount,
    strategic_signal: strategicSignal,
    detected_count: detected.length,
  };
}

function computeHolisticCompetitorScoreTuning(competitorContext = null) {
  const context = competitorContext && typeof competitorContext === "object"
    ? competitorContext
    : {};

  const detectedCount = Number(context.detected_count || 0);
  if (detectedCount <= 0) {
    return { delta: 0, adjustments: [] };
  }

  const adjustments = [];
  let delta = 0;

  const holisticScore = clamp01(Number(context.holistic_score || 0.5));
  const isolationScore = clamp01(Number(context.isolation_score || 0.5));
  const holisticGap = holisticScore - isolationScore;
  const platformConsolidationBonus = clamp01(Number(context.platform_consolidation_bonus || 0));
  const fragmentedStackBonus = clamp01(Number(context.fragmented_stack_bonus || 0));
  const anchorDrag = clamp01(Number(context.anchor_drag || 0));
  const incumbentLockIndex = clamp01(Number(context.incumbent_lock_index || 0.5));
  const strategicSignal = String(context.strategic_signal || "none");

  if (holisticGap >= 0.08 && platformConsolidationBonus >= 0.04) {
    const impact = Math.min((holisticGap * 0.22) + (platformConsolidationBonus * 0.18), 0.05);
    delta += impact;
    adjustments.push({ reason: "holistic_consolidation_gap", impact: Math.round(impact * 100) / 100 });
  }

  if (fragmentedStackBonus >= 0.07) {
    const impact = Math.min(fragmentedStackBonus * 0.3, 0.03);
    delta += impact;
    adjustments.push({ reason: "fragmented_stack_holistic_lift", impact: Math.round(impact * 100) / 100 });
  }

  if (anchorDrag >= 0.12) {
    const impact = -Math.min(anchorDrag * 0.32, 0.06);
    delta += impact;
    adjustments.push({ reason: "anchor_heavy_holistic_drag", impact: Math.round(impact * 100) / 100 });
  }

  if (incumbentLockIndex >= 0.8 && platformConsolidationBonus < 0.05) {
    const impact = -0.02;
    delta += impact;
    adjustments.push({ reason: "high_lockin_low_consolidation", impact });
  }

  if (strategicSignal === "consolidation_play") {
    const impact = 0.02;
    delta += impact;
    adjustments.push({ reason: "strategic_consolidation_play", impact });
  } else if (strategicSignal === "anchor_heavy") {
    const impact = -0.02;
    delta += impact;
    adjustments.push({ reason: "strategic_anchor_heavy", impact });
  }

  const boundedDelta = Math.max(-0.08, Math.min(0.08, delta));
  if (boundedDelta !== delta) {
    adjustments.push({ reason: "holistic_tuning_cap", impact: Math.round((boundedDelta - delta) * 100) / 100 });
  }

  return {
    delta: Math.round(boundedDelta * 100) / 100,
    adjustments,
  };
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

  const techStackEnvelope = resolveEnrichmentPayload(`tech_stack_${companyNumber}`, "tech_stack");
  const websiteEnvelope = resolveEnrichmentPayload(`website_intelligence_${companyNumber}`, "website");
  const marketingEnvelope = resolveEnrichmentPayload(`marketing_intelligence_${companyNumber}`, "marketing");
  const reputationEnvelope = resolveEnrichmentPayload(`reputation_${companyNumber}`, "reputation");
  const hiringEnvelope = resolveEnrichmentPayload(`hiring_signals_${companyNumber}`, "hiring_signals");
  const ownershipEnvelope = resolveEnrichmentPayload(`ownership_${companyNumber}`, "ownership");

   const brandAwarenessRaw = getSetting(
     `brand_awareness_${companyNumber}`,
     getSetting(`brand_awareness_status_${companyNumber}`, "unknown")
   );
   const brandAwareness = typeof brandAwarenessRaw === "string"
     ? brandAwarenessRaw
     : (brandAwarenessRaw?.status || brandAwarenessRaw?.level || "unknown");

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
  const industryProductFitHint = computeIndustryProductFitHint(industries);
  const priorCategories = inferIndustryPriorCategories(text, industries);
  const qualificationGates = applyMotionQualificationGates(motionScores, text);
  const sparsePriors = applySparseDataIndustryPriors(motionScores, priorCategories, textLength);
  const industryCalibration = applyIndustryMotionCalibration(motionScores, industries, text);
  const filingDecay = applyFilingRecencyDecay(motionScores, filingRecency);
  const competitors = detectCompetitors(text);

   const techSignals = scoreTechStackSignals(techStackEnvelope.data, techStackEnvelope.decay_multiplier || 0);
   const techMotionAdjustments = applyMotionBoostMap(motionScores, techSignals.motion_boosts, "tech_stack", 0.35, 1);
   mergeCompetitorSignals(competitors, techSignals.competitor_signals);

  const competitorMotionTuning = applyCompetitorSpecificMotionAdjustments(motionScores, competitors);

   const webSignals = scoreWebsiteIntelligence(websiteEnvelope.data, websiteEnvelope.decay_multiplier || 0);
   const webMotionAdjustments = applyMotionBoostMap(motionScores, webSignals.motion_boosts, "website", 0.28, 1);

   const mktSignals = scoreMarketingIntelligence(marketingEnvelope.data, marketingEnvelope.decay_multiplier || 0);
   const marketingMotionAdjustments = applyMotionBoostMap(motionScores, mktSignals.motion_boosts, "marketing", 0.24, 1);

   const repSignals = scoreReputationSignals(reputationEnvelope.data, reputationEnvelope.decay_multiplier || 0);
   const reputationMotionAdjustments = applyMotionBoostMap(motionScores, repSignals.motion_boosts, "reputation", 0.2, 1);

   const ownershipSignals = scoreOwnershipStructure(ownershipEnvelope.data, ownershipEnvelope.decay_multiplier || 0);
   const ownershipMotionAdjustments = applyMotionBoostMap(motionScores, ownershipSignals.motion_boosts, "ownership", 0.2, 1);

   const qualSignals = detectQualificationSignals(text);
   const hiringSignals = scoreHiringSignals(hiringEnvelope.data, hiringEnvelope.decay_multiplier || 0);
   const hiringMotionAdjustments = applyMotionBoostMap(motionScores, hiringSignals.motion_boosts, "hiring", 0.25, 1);
   if (hiringSignals.applied) {
     for (const trigger of hiringSignals.velocity_triggers || []) {
       if (trigger === "new_finance_leader") {
         qualSignals.positive.push({ signal: "New CFO/FD", weight: 0.15, source: "hiring" });
       } else if (trigger === "headcount_growth") {
         qualSignals.positive.push({ signal: "Headcount growth", weight: 0.1, source: "hiring" });
       }
     }
   }

   const businessModel = classifyBusinessModel({
     industries,
     techStackSignals: techSignals,
     websiteData: websiteEnvelope.data,
     marketingData: marketingEnvelope.data,
     reputationData: reputationEnvelope.data,
     filingText: text,
   });
   const businessModelCalibration = applyBusinessModelCalibration(motionScores, businessModel.classification);

  const motionSummary = recomputeMotionWeightsAndFit(motionScores);

  const productFitScore = motionSummary.product_fit_score;
  const bestMotionScore = motionSummary.best_score;
  const bestMotion = motionSummary.best_motion;
  const commercialValue = clamp01(scoreCommercialValue(turnover) + Number(mktSignals.commercial_value_boost || 0));
  const growth = scoreGrowth(filings);
  const employeesFromFiling = extractEmployeeCount(text);
  const employees = webSignals.employee_count_override || employeesFromFiling;
  const competitorContext = scoreCompetitorContext(competitors, motionScores, businessModel.classification);
  const competitorHolisticTuning = computeHolisticCompetitorScoreTuning(competitorContext);
  const competitorBaseScore = Number(competitorContext.score || 0.5);
  const competitorMotionDelta = Number(competitorMotionTuning.competitor_context_delta || 0);
  const competitorScore = clamp01(competitorBaseScore + competitorMotionDelta + Number(competitorHolisticTuning.delta || 0));

  const switchingFeasibility = scoreSwitchingFeasibility(
    text,
    competitors,
    qualSignals,
    chargeSummary,
    competitorMotionTuning,
    {
      techStackSwitchingDelta: techSignals.switching_delta || 0,
      ownershipSwitchingDelta: ownershipSignals.switching_feasibility_delta || 0,
      integrationReady: !!techSignals.integration_ready,
    },
    competitorContext
  );

  const evidenceConfidenceRaw = computeEvidenceConfidence(text, filings, motionScores);
  const enrichmentSourceCount = [
    techSignals.applied,
    webSignals.applied,
    mktSignals.applied,
    repSignals.applied,
    hiringSignals.applied,
    ownershipSignals.applied,
  ].filter(Boolean).length;
  const evidenceConfidenceBase = clamp01(
    (evidenceConfidenceRaw * 0.72)
    + (Number(filingRecency.signal_multiplier || 0.55) * 0.28)
    - (sparsePriors.applied ? 0.08 : 0)
  );
  const enrichmentConfidenceBoost = Math.min(enrichmentSourceCount * 0.04, 0.15);
  const evidenceConfidence = clamp01(evidenceConfidenceBase + enrichmentConfidenceBoost);

  const positiveBoost = qualSignals.positive.reduce((s, sig) => s + sig.weight, 0);
  const negativeImpact = qualSignals.negative.reduce((s, sig) => s + sig.weight, 0);
  let urgencyScore = Math.min(
    Math.max(
      growth.score + (positiveBoost * Number(filingRecency.signal_multiplier || 0.55)),
      0
    ),
    1
  );
  urgencyScore = clamp01(
    urgencyScore
    + Number(hiringSignals.urgency_boost || 0)
    + Number(hiringSignals.headcount_urgency_boost || 0)
    + Number(ownershipSignals.urgency_boost || 0)
  );

  let painScore = Math.min(
    (motionScores["FX"]?.score || 0) * 0.25 +
    (motionScores["Cards"]?.score || 0) * 0.20 +
    (motionScores["Spend Management"]?.score || 0) * 0.20 +
    (motionScores["Merchant Acquiring"]?.score || 0) * 0.20 +
    (employees && employees > 200 ? 0.15 : employees && employees > 50 ? 0.08 : 0),
    1
  );
  painScore = clamp01(
    painScore
    + Number(webSignals.pain_boost || 0)
    + Number(hiringSignals.pain_boost || 0)
    + Number(repSignals.pain_boost || 0)
    + Number(ownershipSignals.pain_boost || 0)
  );

  const velocity = estimateConversionVelocity({
    qualSignals,
    growth,
    filingRecency,
    switchingFeasibility,
    competitors,
    brandAwareness,
  });

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

  const propensityScore = clamp01((urgencyScore * 0.65) + (velocity.score * 0.35) + Number(hiringSignals.propensity_boost || 0));
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
  const confidenceInterval = buildConfidenceInterval(
    compositeScore,
    evidenceConfidence,
    filingRecency,
    textLength,
    motionScores,
    {
      enrichment_source_count: enrichmentSourceCount,
      tech_stack_confirmed: techSignals.applied,
    }
  );

  const enrichmentMarker = [
    `tech:${techStackEnvelope.available ? (techStackEnvelope.days_old ?? "na") : "none"}`,
    `web:${websiteEnvelope.available ? (websiteEnvelope.days_old ?? "na") : "none"}`,
    `mkt:${marketingEnvelope.available ? (marketingEnvelope.days_old ?? "na") : "none"}`,
    `rep:${reputationEnvelope.available ? (reputationEnvelope.days_old ?? "na") : "none"}`,
    `hire:${hiringEnvelope.available ? (hiringEnvelope.days_old ?? "na") : "none"}`,
    `own:${ownershipEnvelope.available ? (ownershipEnvelope.days_old ?? "na") : "none"}`,
  ].join("|");

  const dataFingerprint = computeDataFingerprint({
    latest_filing_date: latestFilingDate,
    text_length: textLength,
    filing_count: filings.length,
    turnover,
    charge_marker: chargeSummary?.latest_charge_created_on || chargeSummary?.fetched_at || "none",
    enrichment_marker: enrichmentMarker,
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
    motion_velocity: classifyMotionVelocity(bestMotion),
    velocity,
    synergy,
    business_model: businessModel,
    confidence_interval: confidenceInterval,
    volatility,
    layers: {
      product_fit: { score: productFitScore, best_motion: bestMotion, best_score: bestMotionScore },
      commercial_value: { score: commercialValue },
      pain_strength: { score: painScore },
      urgency: { score: urgencyScore, trend: growth.trend, growth_rate: growth.rate },
      competitor_context: {
        score: competitorScore,
        base_score: Math.round(competitorBaseScore * 100) / 100,
        motion_tuning_delta: Math.round(competitorMotionDelta * 100) / 100,
        holistic_tuning_delta: Number(competitorHolisticTuning.delta || 0),
        holistic_tuning_adjustments: competitorHolisticTuning.adjustments,
        detected: competitors,
        isolation_score: competitorContext.isolation_score,
        holistic_score: competitorContext.holistic_score,
        fragmented_stack_bonus: competitorContext.fragmented_stack_bonus,
        platform_consolidation_bonus: competitorContext.platform_consolidation_bonus,
        anchor_drag: competitorContext.anchor_drag,
        incumbent_lock_index: competitorContext.incumbent_lock_index,
        strategic_signal: competitorContext.strategic_signal,
      },
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
    enrichment: {
      sources_available: enrichmentSourceCount,
      tech_stack: {
        ...techSignals,
        freshness: {
          stale: techStackEnvelope.stale,
          days_old: techStackEnvelope.days_old,
          decay_multiplier: techStackEnvelope.decay_multiplier,
        },
      },
      website: {
        ...webSignals,
        freshness: {
          stale: websiteEnvelope.stale,
          days_old: websiteEnvelope.days_old,
          decay_multiplier: websiteEnvelope.decay_multiplier,
        },
      },
      marketing: {
        ...mktSignals,
        freshness: {
          stale: marketingEnvelope.stale,
          days_old: marketingEnvelope.days_old,
          decay_multiplier: marketingEnvelope.decay_multiplier,
        },
      },
      reputation: {
        ...repSignals,
        freshness: {
          stale: reputationEnvelope.stale,
          days_old: reputationEnvelope.days_old,
          decay_multiplier: reputationEnvelope.decay_multiplier,
        },
      },
      hiring: {
        ...hiringSignals,
        freshness: {
          stale: hiringEnvelope.stale,
          days_old: hiringEnvelope.days_old,
          decay_multiplier: hiringEnvelope.decay_multiplier,
        },
      },
      ownership: {
        ...ownershipSignals,
        freshness: {
          stale: ownershipEnvelope.stale,
          days_old: ownershipEnvelope.days_old,
          decay_multiplier: ownershipEnvelope.decay_multiplier,
        },
      },
      business_model_calibration: businessModelCalibration,
      motion_adjustments: {
        tech_stack: techMotionAdjustments,
        website: webMotionAdjustments,
        marketing: marketingMotionAdjustments,
        reputation: reputationMotionAdjustments,
        hiring: hiringMotionAdjustments,
        ownership: ownershipMotionAdjustments,
      },
    },
    confidence: {
      evidence: Math.round(evidenceConfidence * 100) / 100,
      evidence_base: Math.round(evidenceConfidenceBase * 100) / 100,
      evidence_raw: Math.round(evidenceConfidenceRaw * 100) / 100,
      enrichment_confidence_boost: Math.round(enrichmentConfidenceBoost * 100) / 100,
      enrichment_source_count: enrichmentSourceCount,
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
      competitor_context_model: competitorContext,
      cross_layer_penalty: correlationPenalty,
      industry_calibration: industryCalibration,
      industry_product_fit_hint: industryProductFitHint,
      business_model_calibration: businessModelCalibration,
      switching_adjustments: switchingFeasibility.adjustments,
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
    brand_awareness: brandAwareness,
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
  const peopleResearch = supplementary.people_research || supplementary.people_targets || [];
  const valueNuggets = supplementary.value_nuggets || [];
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
  if (valueNuggets.length > 0) {
    boost += Math.min(valueNuggets.length * 0.003, 0.015);
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
    valueNuggets.length > 0,
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
      value_nuggets: valueNuggets.length,
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
