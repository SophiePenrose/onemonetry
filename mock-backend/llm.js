import { getFilingsForCompany } from "./db.js";
import { getSupplementaryContext } from "./supplementary-context.js";

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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ANTHROPIC_API_KEY = resolveConfiguredSecret(process.env.ANTHROPIC_API_KEY);
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const LLM_REQUEST_TIMEOUT_MS = Math.max(1000, Math.min(90000,
  Number.parseInt(process.env.LLM_REQUEST_TIMEOUT_MS || "30000", 10) || 30000
));
let openAiAuthDisabled = false;
let openAiAuthLogged = false;
let anthropicAuthDisabled = false;
let anthropicAuthLogged = false;

async function fetchWithLlmTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function getActiveProvider() {
  if (ANTHROPIC_API_KEY && !anthropicAuthDisabled) return "anthropic";
  if (OPENAI_API_KEY && !openAiAuthDisabled) return "openai";
  return null;
}

function canUseLLM() {
  return !!getActiveProvider();
}

function disableLlmDueToAuth(provider, status) {
  if (provider === "anthropic") {
    anthropicAuthDisabled = true;
    if (!anthropicAuthLogged) {
      console.warn(`Anthropic LLM disabled for this process after auth failure (${status}). Falling back to deterministic analysis.`);
      anthropicAuthLogged = true;
    }
    return;
  }

  openAiAuthDisabled = true;
  if (!openAiAuthLogged) {
    console.warn(`OpenAI LLM disabled for this process after auth failure (${status}). Falling back to deterministic analysis.`);
    openAiAuthLogged = true;
  }
}

const COMPETITOR_INFERENCE = {
  HSBC: "Often strong on lending but slower for day-to-day FX execution and workflow automation.",
  Barclays: "Typically broad coverage, but legacy onboarding and fragmented tooling can slow execution.",
  NatWest: "Can be relationship-led, but treasury self-serve depth is often limited for scaling teams.",
  Lloyds: "Banking footprint is broad, yet digital finance workflow integration may be constrained.",
  Worldpay: "Incumbent acquiring can mean complex pricing and slower settlement compared with modern flows.",
  Stripe: "Developer-friendly, but settlement speed and commercial-card pricing can create cost pressure.",
  Adyen: "Strong enterprise platform; mid-market teams can face complexity and less tailored support.",
  Wise: "Useful for spot FX, but broader treasury, cards, and acquiring coverage can remain fragmented.",
  Ebury: "Can support FX, though platform breadth beyond FX may require additional tools.",
  Pleo: "Good spend UX but can create higher total cost if multi-currency usage is material.",
  "High-Street Bank Treasury Stack": "Incumbent relationship banks can limit treasury agility, FX transparency, and workflow automation at scale.",
  "Legacy Merchant Acquirer": "Legacy acquirers often introduce slower settlement and more complex card-pricing structures.",
  "Legacy FX Provider": "Traditional FX providers can create spread leakage and fragmented treasury controls.",
  "Legacy Spend Tooling": "Point spend tools can leave finance teams with fragmented controls and reconciliation overhead.",
};

const COMPETITOR_ALIAS_GROUPS = [
  {
    name: "HSBC",
    product: "Banking / FX",
    aliases: ["hsbc", "hsbc uk bank", "hongkong and shanghai banking"],
    displacement_angle: "Incumbent bank and FX relationship noted in filing context.",
  },
  {
    name: "Barclays",
    product: "Banking / FX",
    aliases: ["barclays", "barclays bank"],
    displacement_angle: "Incumbent bank relationship noted in filing context.",
  },
  {
    name: "NatWest",
    product: "Banking / FX",
    aliases: ["natwest", "nat west", "royal bank of scotland", "rbs"],
    displacement_angle: "Incumbent UK bank relationship noted in filing context.",
  },
  {
    name: "Lloyds",
    product: "Banking / FX",
    aliases: ["lloyds", "lloyds bank"],
    displacement_angle: "Incumbent UK bank relationship noted in filing context.",
  },
  {
    name: "Worldpay",
    product: "Merchant Acquiring",
    aliases: ["worldpay", "world pay"],
    displacement_angle: "Incumbent acquirer context appears in filing text.",
  },
  {
    name: "Stripe",
    product: "Merchant Acquiring",
    aliases: ["stripe", "stripe payments"],
    displacement_angle: "Digital acquiring stack context appears in filing text.",
  },
  {
    name: "Adyen",
    product: "Merchant Acquiring",
    aliases: ["adyen"],
    displacement_angle: "Enterprise acquiring platform context appears in filing text.",
  },
  {
    name: "PayPal",
    product: "Payments",
    aliases: ["paypal", "braintree"],
    displacement_angle: "Payments provider context appears in filing text.",
  },
  {
    name: "Wise",
    product: "FX",
    aliases: ["wise", "wise payments"],
    displacement_angle: "FX provider context appears in filing text.",
  },
  {
    name: "Ebury",
    product: "FX",
    aliases: ["ebury"],
    displacement_angle: "FX provider context appears in filing text.",
  },
  {
    name: "Pleo",
    product: "Spend Management",
    aliases: ["pleo"],
    displacement_angle: "Spend tooling context appears in filing text.",
  },
  {
    name: "American Express",
    product: "Corporate Cards",
    aliases: ["american express", "amex"],
    displacement_angle: "Card programme context appears in filing text.",
  },
  {
    name: "Elavon",
    product: "Merchant Acquiring",
    aliases: ["elavon"],
    displacement_angle: "Acquirer context appears in filing text.",
  },
  {
    name: "Global Payments",
    product: "Merchant Acquiring",
    aliases: ["global payments"],
    displacement_angle: "Acquirer context appears in filing text.",
  },
  {
    name: "Fiserv",
    product: "Merchant Acquiring",
    aliases: ["fiserv", "first data"],
    displacement_angle: "Acquiring infrastructure context appears in filing text.",
  },
];

const COMPETITOR_SIGNAL_RULES = [
  {
    name: "High-Street Bank Treasury Stack",
    product: "Banking / FX",
    category: "banking",
    pattern: /\b(bank(?:ing)?\s+facilit(?:y|ies)|overdraft|credit\s+facility|loan\s+covenant|cash\s*flow|treasury|relationship\s+bank|working\s+capital\s+facility)\b/i,
    displacement_angle: "Filing language suggests dependency on a legacy bank-led treasury stack.",
  },
  {
    name: "Legacy Merchant Acquirer",
    product: "Merchant Acquiring",
    category: "acquiring",
    pattern: /\b(merchant|acquir(?:er|ing)|card\s+accept|payment\s+gateway|checkout|chargeback|settlement|payment\s+processing|epos|pos\s+terminal)\b/i,
    displacement_angle: "Filing language suggests merchant-acquiring complexity that may be served by incumbent acquirers.",
  },
  {
    name: "Legacy FX Provider",
    product: "FX",
    category: "fx",
    pattern: /\b(fx|foreign\s+exchange|multi\s*-?\s*currency|cross\s*-?\s*border|international\s+payments?|currency\s+risk|exchange\s+rate|hedg(?:e|ing)|forward\s+contract)\b/i,
    displacement_angle: "Filing language indicates FX exposure likely managed through a traditional provider setup.",
  },
  {
    name: "Legacy Spend Tooling",
    product: "Spend Management",
    category: "spend",
    pattern: /\b(expense\s+management|employee\s+expenses?|corporate\s+cards?|purchase\s+cards?|approval\s+workflow|receipt\s+capture|spend\s+control)\b/i,
    displacement_angle: "Filing language indicates spend-control needs often handled by fragmented tooling.",
  },
];

const USE_CASE_LIBRARY = [
  {
    name: "Revolut merchant acquiring + Pay with Revolut + Open Banking",
    match: /merchant|acquir|checkout|revolut\s*pay|open\s*bank|pis|payments?\s+accept/i,
    priority: "High",
    why: "Improves settlement speed, payment economics, and checkout optionality for UK mid-market payment flows.",
    example: "Accept card, pay-by-bank, and Pay with Revolut in one checkout with faster settlement into the business account.",
  },
  {
    name: "Multi-currency accounts + spot FX + FX Forwards",
    match: /fx|foreign\s+exchange|currency|international|supplier|overseas|forward/i,
    priority: "High",
    why: "Reduces margin leakage on multi-currency flows and improves predictability for future payables/receivables.",
    example: "Hold GBP/EUR/USD wallets, convert with tighter pricing, and lock future rates for known obligations.",
  },
  {
    name: "Cards and spend management controls",
    match: /card|expense|spend|employee|reconciliation|policy|mcc/i,
    priority: "High",
    why: "Adds real-time controls and visibility for distributed employee and supplier spend.",
    example: "Issue virtual cards per team, enforce MCC and limits, and reduce month-end reconciliation effort.",
  },
  {
    name: "API and back-office integrations",
    match: /api|integration|erp|accounting|reconciliation|webhook|sync/i,
    priority: "Medium",
    why: "Improves data flow from payments and banking into accounting and finance reporting systems.",
    example: "Sync transactions and balances into accounting tools and automate reconciliation workflows.",
  },
  {
    name: "Travel virtual cards with Conferma",
    match: /travel|tmc|booking|hotel|airline|conferma|virtual\s+card/i,
    priority: "Medium",
    why: "Useful where travel booking/payment complexity is material and reconciliation control is needed.",
    example: "Issue date-bounded, MCC-restricted virtual cards per booking with travel metadata attached.",
  },
  {
    name: "Working-capital and credit-adjacent options",
    match: /overdraft|facility|working\s+capital|liquidity|credit|charge/i,
    priority: "Experimental",
    why: "Potential fit when liquidity pressure or financing constraints appear in filings.",
    example: "Use payment and cash-flow signals to support practical credit and treasury options where available.",
  },
];

const PAIN_AREA_RULES = [
  { area: "Payments & Acquiring", pattern: /acquir|checkout|merchant|chargeback|dispute|settlement|processor|card\s+accept/i },
  { area: "Banking & Cash Management", pattern: /bank|liquidity|cash\s*flow|reconciliation|multi\s*entity|facility|overdraft/i },
  { area: "FX & International", pattern: /fx|foreign\s+exchange|currency|international|overseas|cross\s*border|hedg|forward/i },
  { area: "Spend Management & Cards", pattern: /employee|expense|spend|card|mcc|approval|policy|receipt/i },
  { area: "Travel & Bookings", pattern: /travel|booking|hotel|airline|tmc|gds|conferma/i },
  { area: "Lending & Working Capital", pattern: /working\s+capital|credit|facility|debt|loan|charge|covenant/i },
];

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateSnippet(value, maxLen = 260) {
  const text = normalizeWhitespace(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function collectKeywordSnippets(rawText, keywords, max = 4) {
  const text = String(rawText || "");
  const lower = text.toLowerCase();
  const snippets = [];
  const seen = new Set();

  for (const keyword of keywords.filter(Boolean)) {
    const needle = String(keyword).toLowerCase();
    if (!needle || needle.length < 3) continue;
    let start = 0;
    while (snippets.length < max) {
      const idx = lower.indexOf(needle, start);
      if (idx === -1) break;
      const snippetStart = Math.max(0, idx - 90);
      const snippetEnd = Math.min(text.length, idx + needle.length + 140);
      const quote = truncateSnippet(text.slice(snippetStart, snippetEnd));
      if (quote && !seen.has(quote)) {
        seen.add(quote);
        snippets.push({ quote, keyword: needle });
      }
      start = idx + needle.length;
    }
    if (snippets.length >= max) break;
  }

  return snippets;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferCompetitorsFromFilingText(filingText, max = 8) {
  const text = String(filingText || "");
  if (!text) return [];

  const inferred = [];
  const seen = new Set();

  for (const group of COMPETITOR_ALIAS_GROUPS) {
    let match = null;
    for (const alias of group.aliases || []) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
      match = pattern.exec(text);
      if (match) break;
    }

    if (!match) continue;
    const key = String(group.name || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const snippetStart = Math.max(0, match.index - 120);
    const snippetEnd = Math.min(text.length, match.index + String(match[0] || "").length + 160);
    inferred.push({
      name: group.name,
      product: group.product || "",
      displacement_angle: group.displacement_angle || "Detected provider context in filing text.",
      snippet: truncateSnippet(text.slice(snippetStart, snippetEnd)),
      inferred_advantage: COMPETITOR_INFERENCE[group.name] || "Use filing context to position switching path with low implementation risk.",
      source: "filing_alias_inference",
    });

    if (inferred.length >= max) break;
  }

  return inferred;
}

function competitorCategoryFromName(name, product) {
  const text = `${String(name || "")} ${String(product || "")}`.toLowerCase();
  if (/hsbc|barclays|natwest|lloyds|bank|treasury/.test(text)) return "banking";
  if (/wise|ebury|foreign\s*exchange|\bfx\b/.test(text)) return "fx";
  if (/worldpay|stripe|adyen|paypal|braintree|elavon|global payments|fiserv|merchant|acquir/.test(text)) return "acquiring";
  if (/pleo|american express|amex|spend|expense|corporate\s+card/.test(text)) return "spend";
  return "other";
}

function inferCompetitorsFromSignals(analysis = {}, filingText, existingCompetitors = [], max = 4) {
  const sourceText = [
    analysis?.summary || "",
    ...(analysis?.themes || []).map((t) => `${t?.theme || ""} ${t?.evidence || ""}`),
    ...(analysis?.pain_indicators || []).map((p) => `${p?.pain || ""} ${p?.evidence || ""}`),
    ...(analysis?.opportunities || []).map((o) => `${o?.product || ""} ${o?.rationale || ""}`),
    filingText || "",
  ].join(" ");

  const knownCategories = new Set(
    (existingCompetitors || []).map((item) => competitorCategoryFromName(item?.name, item?.product)).filter(Boolean)
  );

  const inferred = [];
  for (const rule of COMPETITOR_SIGNAL_RULES) {
    if (knownCategories.has(rule.category)) continue;
    const match = rule.pattern.exec(sourceText);
    if (!match) continue;

    const snippetStart = Math.max(0, match.index - 120);
    const snippetEnd = Math.min(sourceText.length, match.index + String(match[0] || "").length + 180);
    inferred.push({
      name: rule.name,
      product: rule.product,
      displacement_angle: rule.displacement_angle,
      snippet: truncateSnippet(sourceText.slice(snippetStart, snippetEnd)),
      inferred_advantage: COMPETITOR_INFERENCE[rule.name] || "Use filing context to position switching path with low implementation risk.",
      source: "signal_inference",
    });

    if (inferred.length >= max) break;
  }

  return inferred;
}

function buildOutreachNarrative(analysis = {}) {
  const pains = (analysis.pain_indicators || []).slice(0, 3).map((p) => p.pain || p);
  const competitors = (analysis.competitors_detected || []).slice(0, 3).map((c) => c.name || c);
  const opportunities = (analysis.opportunities || []).slice(0, 3).map((o) => o.product || "");
  const themes = (analysis.themes || []).slice(0, 3).map((t) => t.theme || t);

  const gapStatements = [];
  if (pains.length > 0) {
    gapStatements.push(`Current setup appears to leave at least one unresolved pain: ${pains.join(", ")}.`);
  }
  if (competitors.length > 0) {
    gapStatements.push(`Incumbent stack likely includes ${competitors.join(", ")}, creating displacement openings where execution or economics are weak.`);
  }

  const productPlan = opportunities.length > 0
    ? `Start with ${opportunities[0]} and sequence into ${opportunities.slice(1).filter(Boolean).join(", ") || "adjacent treasury/payment workflows"}.`
    : "Start from the highest-confidence operational pain and position a low-friction first step.";

  return {
    primary_pains: pains,
    incumbent_setup: competitors.length > 0 ? competitors.join(", ") : "Not explicitly confirmed",
    gaps_we_can_fill: gapStatements,
    revolut_advantage: analysis.recommended_approach || "Use filing-derived pain points to anchor value before proposing product pathways.",
    execution_plan: productPlan,
    communication_strategy: `Email narrative should progress from proof-of-research to quantified pain to displacement path, then close with a low-friction next step.${themes.length > 0 ? ` Anchor language in themes: ${themes.join(", ")}.` : ""}`,
  };
}

function deriveSupplementaryContext(analysis = {}) {
  const themes = analysis.themes || [];
  const newsSignals = themes
    .filter((t) => /expansion|growth|investment|launch|market|demand|acquisition|merger/i.test(t.theme || ""))
    .slice(0, 4)
    .map((t) => ({ signal: t.theme, relevance: "Monitor current news flow to validate timing and urgency." }));

  const mnaSignals = themes
    .filter((t) => /acquisition|merger|group|integration|subsidiary/i.test(`${t.theme || ""} ${t.evidence || ""}`))
    .slice(0, 4)
    .map((t) => ({ signal: t.theme, evidence: t.evidence || "" }));

  const peopleResearch = (analysis.key_people || []).slice(0, 8).map((p) => {
    const name = p.name || "";
    return {
      name,
      role: p.role || "Unknown",
      linkedin_search_url: name
        ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${p.role || ""}`.trim())}`
        : null,
      lusha_status: process.env.LUSHA_API_KEY ? "configured" : "not_configured",
    };
  });

  const valueNuggets = [
    ...newsSignals.slice(0, 3).map((s) => ({
      type: "news",
      nugget: s.signal,
      source: "analysis_theme",
      relevance: s.relevance,
    })),
    ...mnaSignals.slice(0, 2).map((s) => ({
      type: "mna",
      nugget: s.signal,
      source: "analysis_theme",
      relevance: s.evidence || "M&A/ownership signal",
    })),
    ...(analysis.opportunities || []).slice(0, 2).map((o) => ({
      type: "opportunity",
      nugget: `${o.product || "Motion"}: ${o.rationale || "Evidence-led fit"}`,
      source: "analysis",
      relevance: "Reusable follow-up value nugget",
    })),
  ].slice(0, 10);

  return {
    news_signals: newsSignals,
    mna_signals: mnaSignals,
    people_research: peopleResearch,
    enrichment_status: {
      linkedin_search: true,
      lusha: !!process.env.LUSHA_API_KEY,
      news_api: !!process.env.NEWS_API_KEY,
    },
    value_nuggets: valueNuggets,
  };
}

async function enrichSupplementaryContext(analysis, companyName, filingText) {
  if (!analysis || typeof analysis !== "object") return analysis;

  try {
    const context = await getSupplementaryContext({
      companyName,
      analysis,
      filingText: filingText || "",
    });

    if (!context || typeof context !== "object") return analysis;

    const existing = analysis.supplementary_context && typeof analysis.supplementary_context === "object"
      ? analysis.supplementary_context
      : {};

    const newsSignals = Array.isArray(context.news_signals) && context.news_signals.length > 0
      ? context.news_signals
      : (existing.news_signals || []);
    const mnaSignals = Array.isArray(context.mna_signals) && context.mna_signals.length > 0
      ? context.mna_signals
      : (existing.mna_signals || []);
    const peopleResearch = Array.isArray(context.people_research) && context.people_research.length > 0
      ? context.people_research
      : (Array.isArray(context.people_targets) && context.people_targets.length > 0
          ? context.people_targets
          : (existing.people_research || []));
    const valueNuggets = Array.isArray(context.value_nuggets) && context.value_nuggets.length > 0
      ? context.value_nuggets
      : (Array.isArray(existing.value_nuggets) ? existing.value_nuggets : []);

    analysis.supplementary_context = {
      ...existing,
      ...context,
      news_signals: newsSignals,
      mna_signals: mnaSignals,
      people_research: peopleResearch,
      enrichment_status: context.enrichment_status || existing.enrichment_status || {
        linkedin_search: true,
        lusha: !!process.env.LUSHA_API_KEY,
        news_api: !!process.env.NEWS_API_KEY,
      },
      value_nuggets: valueNuggets,
    };

    const trigger = newsSignals[0]?.signal || newsSignals[0]?.title || null;
    if (trigger && analysis.level5_extraction?.sequence_inputs) {
      const existingTrigger = String(analysis.level5_extraction.sequence_inputs.now_trigger || "");
      if (!existingTrigger || /latest filing context/i.test(existingTrigger)) {
        analysis.level5_extraction.sequence_inputs.now_trigger = trigger;
      }
    }
  } catch {
    // Keep analysis usable even if supplementary enrichment fails.
  }

  return analysis;
}

function inferSegment(turnover, employeeEstimate) {
  if (employeeEstimate && employeeEstimate >= 1000) return "Enterprise";
  if (turnover && turnover > 500_000_000) return "Enterprise";
  if (employeeEstimate && employeeEstimate >= 50) return "Mid-Market";
  if (turnover && turnover >= 10_000_000) return "Mid-Market";
  return "SMB";
}

function estimateEmployeesFromText(filingText) {
  const text = String(filingText || "");
  const patterns = [
    /(average\s+)?number\s+of\s+employees[^\d]{0,30}(\d{2,6})/i,
    /(\d{2,6})\s+(employees|staff|people)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = match[2] || match[1] || "";
    const value = Number.parseInt(String(raw).replace(/,/g, ""), 10);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

function classifyPainArea(text) {
  const value = String(text || "");
  for (const rule of PAIN_AREA_RULES) {
    if (rule.pattern.test(value)) return rule.area;
  }
  return "Banking & Cash Management";
}

function buildLevel5EvidenceMap(analysis = {}) {
  const grouped = {
    "Payments & Acquiring": [],
    "Banking & Cash Management": [],
    "FX & International": [],
    "Spend Management & Cards": [],
    "Travel & Bookings": [],
    "Lending & Working Capital": [],
  };

  for (const pain of analysis.pain_indicators || []) {
    const area = classifyPainArea(`${pain.pain || ""} ${pain.evidence || ""}`);
    grouped[area].push({
      type: "pain_indicator",
      quote: pain.evidence || pain.pain || "",
      insight: pain.pain || "Operational pain signal",
      relevance: pain.severity || "medium",
    });
  }

  const snippetGroups = analysis.evidence_snippets || {};
  const mapping = {
    pains: "Banking & Cash Management",
    suitability: "FX & International",
    competitors: "Payments & Acquiring",
    gaps: "Banking & Cash Management",
    execution: "Spend Management & Cards",
  };

  for (const [key, items] of Object.entries(snippetGroups)) {
    const fallbackArea = mapping[key] || "Banking & Cash Management";
    for (const item of items || []) {
      const area = classifyPainArea(`${item.quote || ""} ${item.insight || ""}`) || fallbackArea;
      grouped[area].push({
        type: `evidence_${key}`,
        quote: item.quote || "",
        insight: item.insight || "",
        relevance: item.relevance || "medium",
      });
    }
  }

  for (const key of Object.keys(grouped)) {
    grouped[key] = grouped[key].slice(0, 5);
  }

  return grouped;
}

function buildLevel5UseCases(analysis = {}, evidenceMap = {}) {
  const candidates = [];
  const sourceText = [
    ...(analysis.opportunities || []).map((o) => `${o.product || ""} ${o.rationale || ""}`),
    ...(analysis.pain_indicators || []).map((p) => `${p.pain || ""} ${p.evidence || ""}`),
    ...(analysis.themes || []).map((t) => `${t.theme || ""} ${t.evidence || ""}`),
  ].join(" ");

  for (const item of USE_CASE_LIBRARY) {
    if (item.match.test(sourceText)) {
      candidates.push({
        product: item.name,
        priority: item.priority,
        why_fit: item.why,
        example_use_case: item.example,
      });
    }
  }

  if (candidates.length === 0) {
    candidates.push({
      product: "Multi-currency accounts + spot FX + FX Forwards",
      priority: "Medium",
      why_fit: "Baseline treasury and international flow coverage while deeper pain points are validated.",
      example_use_case: "Consolidate treasury visibility and reduce avoidable FX leakage on recurring foreign-currency obligations.",
    });
  }

  const notPriority = [];
  if ((evidenceMap["Travel & Bookings"] || []).length === 0) {
    notPriority.push("Travel virtual cards with Conferma - no clear travel-booking complexity in current evidence.");
  }
  if ((evidenceMap["Lending & Working Capital"] || []).length === 0) {
    notPriority.push("Credit-led motions - insufficient direct liquidity/facility signals in current filing evidence.");
  }

  return {
    recommended_use_cases: candidates.slice(0, 7),
    not_priority: notPriority,
  };
}

function buildLevel5Extraction(analysis = {}, filingText, context = {}) {
  const employeeEstimate = estimateEmployeesFromText(filingText);
  const turnover = context.turnover || null;
  const segment = inferSegment(turnover, employeeEstimate);
  const evidenceMap = buildLevel5EvidenceMap(analysis);
  const useCases = buildLevel5UseCases(analysis, evidenceMap);

  const painRegister = (analysis.pain_indicators || []).slice(0, 8).map((p) => ({
    area: classifyPainArea(`${p.pain || ""} ${p.evidence || ""}`),
    evidence: p.evidence || p.pain || "",
    inferred_problem: `${p.pain || "Operational pain"} is likely creating avoidable execution drag for the finance team.`,
    severity: p.severity || "medium",
  }));

  const allEvidenceCount = Object.values(evidenceMap).reduce((sum, arr) => sum + (arr?.length || 0), 0);
  const currencies = analysis?.international_exposure?.currencies || [];
  const estimatedFxVolume = turnover && currencies.length > 0
    ? Math.round(turnover * (currencies.length > 2 ? 0.35 : 0.22))
    : null;
  const estimatedFxGap = estimatedFxVolume ? Math.round(estimatedFxVolume * 0.008) : null;

  const directorsLanguage = collectKeywordSnippets(
    filingText,
    ["material risk", "cost pressure", "working capital", "liquidity", "credit risk", "international expansion"],
    4
  ).map((s) => s.quote);

  const pitchSummary = analysis?.outreach_narrative?.communication_strategy
    || "Lead with one high-confidence operational pain, quantify practical impact, and sequence into adjacent motions only where evidence is strong.";

  return {
    extraction_version: "l5.v1",
    company_snapshot: {
      segment_fit: segment,
      turnover_gbp: turnover,
      employee_estimate: employeeEstimate,
      operating_model: analysis.summary || "No summary available",
      international_profile: analysis?.international_exposure?.details || "No explicit international profile",
    },
    evidence_map: evidenceMap,
    pain_register: painRegister,
    revolut_opportunity: {
      pitch_summary: pitchSummary,
      recommended_use_cases: useCases.recommended_use_cases,
      not_priority: useCases.not_priority,
    },
    sequence_inputs: {
      now_trigger: analysis?.supplementary_context?.news_signals?.[0]?.signal || "Latest filing context",
      quantified_hook: estimatedFxGap
        ? `Estimated annual FX leakage opportunity in the region of £${estimatedFxGap.toLocaleString()}`
        : "Quantified hook requires additional FX volume validation",
      operations_hook: employeeEstimate
        ? `Finance operations likely span approximately ${employeeEstimate.toLocaleString()} employees`
        : "Employee scale signal not explicit in filing",
      governance_hook: analysis?.outreach_narrative?.incumbent_setup || "Current stack not explicitly disclosed",
      directors_language: directorsLanguage,
      objection_to_preempt: "Keep existing credit relationships in place while improving execution on day-to-day treasury and payment flows.",
    },
    quality: {
      evidence_points: allEvidenceCount,
      inference_points: painRegister.length,
      confidence: allEvidenceCount >= 10 ? "high" : allEvidenceCount >= 5 ? "medium" : "low",
    },
  };
}

function mapPriorityToConfidence(priority) {
  const value = String(priority || "").toLowerCase();
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function inferInternationalExposureFromProfile(profile) {
  const text = String(profile || "");
  const present = /international|overseas|cross\s*border|india|europe|usd|eur|currency/i.test(text);
  return {
    present,
    details: text || (present ? "International operations likely" : "No explicit international profile"),
    currencies: [],
  };
}

function normalizeIncomingLevel5Shape(rawAnalysis = {}) {
  const safe = { ...rawAnalysis };
  const modelCompanySnapshot = safe.company_snapshot || null;
  const modelPainRegister = Array.isArray(safe.pain_register) ? safe.pain_register : null;
  const modelOpportunity = safe.revolut_opportunity || null;
  const modelSequenceInputs = safe.sequence_inputs || null;

  const hasModelLevel5Shape = !!(modelCompanySnapshot || modelPainRegister || modelOpportunity || modelSequenceInputs);
  if (!hasModelLevel5Shape) return safe;

  if (!safe.summary && modelCompanySnapshot?.operating_model) {
    safe.summary = String(modelCompanySnapshot.operating_model);
  }

  if ((!safe.international_exposure || typeof safe.international_exposure !== "object") && modelCompanySnapshot?.international_profile) {
    safe.international_exposure = inferInternationalExposureFromProfile(modelCompanySnapshot.international_profile);
  }

  if ((!safe.pain_indicators || safe.pain_indicators.length === 0) && modelPainRegister) {
    safe.pain_indicators = modelPainRegister
      .map((item) => ({
        pain: item.inferred_problem || item.area || "Operational pain signal",
        evidence: item.evidence || item.area || "",
        severity: String(item.severity || "medium").toLowerCase(),
      }))
      .slice(0, 10);
  }

  if ((!safe.opportunities || safe.opportunities.length === 0) && Array.isArray(modelOpportunity?.recommended_use_cases)) {
    safe.opportunities = modelOpportunity.recommended_use_cases
      .map((item) => ({
        product: item.product || "Revolut Business use case",
        rationale: item.why_fit || item.example_use_case || "Evidence-led use-case fit",
        confidence: mapPriorityToConfidence(item.priority),
        estimated_value: item.priority || "Medium",
      }))
      .slice(0, 8);
  }

  if (!safe.recommended_approach && modelOpportunity?.pitch_summary) {
    safe.recommended_approach = String(modelOpportunity.pitch_summary);
  }

  const normalizedPainRegister = (modelPainRegister || []).map((item) => ({
    area: item.area || "Banking & Cash Management",
    evidence: item.evidence || "",
    inferred_problem: item.inferred_problem || "Operational pain inferred from filing context",
    severity: String(item.severity || "medium").toLowerCase(),
  }));

  const qualityEvidencePoints = Object.values(safe.evidence_snippets || {}).reduce((sum, arr) => sum + ((arr || []).length), 0);
  safe.level5_extraction = safe.level5_extraction || {
    extraction_version: "l5.model",
    company_snapshot: {
      segment_fit: modelCompanySnapshot?.segment_fit || "Mid-Market",
      turnover_gbp: modelCompanySnapshot?.turnover_gbp || null,
      employee_estimate: modelCompanySnapshot?.employee_estimate || null,
      operating_model: modelCompanySnapshot?.operating_model || safe.summary || "No summary available",
      international_profile: modelCompanySnapshot?.international_profile || safe.international_exposure?.details || "No explicit international profile",
    },
    pain_register: normalizedPainRegister,
    revolut_opportunity: {
      pitch_summary: modelOpportunity?.pitch_summary || safe.recommended_approach || "Lead with one high-confidence pain and sequence adjacent opportunities only where evidence is strong.",
      recommended_use_cases: Array.isArray(modelOpportunity?.recommended_use_cases) ? modelOpportunity.recommended_use_cases : [],
      not_priority: Array.isArray(modelOpportunity?.not_priority) ? modelOpportunity.not_priority : [],
    },
    sequence_inputs: {
      now_trigger: modelSequenceInputs?.now_trigger || "Latest filing context",
      quantified_hook: modelSequenceInputs?.quantified_hook || "Quantified hook requires provider-rate validation",
      operations_hook: modelSequenceInputs?.operations_hook || "Operational scale signal available",
      governance_hook: modelSequenceInputs?.governance_hook || "Current setup constraints to validate",
      directors_language: Array.isArray(modelSequenceInputs?.directors_language) ? modelSequenceInputs.directors_language : [],
      objection_to_preempt: modelSequenceInputs?.objection_to_preempt || "Keep existing credit relationships in place while improving execution.",
    },
    quality: {
      evidence_points: qualityEvidencePoints,
      inference_points: normalizedPainRegister.length,
      confidence: normalizedPainRegister.length >= 3 ? "high" : normalizedPainRegister.length >= 1 ? "medium" : "low",
    },
  };

  return safe;
}

function ensureHolisticAnalysisShape(analysis, filingText, context = {}) {
  const safe = normalizeIncomingLevel5Shape(analysis || {});

  const inferredCompetitors = inferCompetitorsFromFilingText(filingText, 8);
  const signalInferredCompetitors = inferCompetitorsFromSignals(
    safe,
    filingText,
    [...(safe.competitors_detected || []), ...inferredCompetitors],
    4
  );
  const mergedCompetitors = [];
  const seenCompetitors = new Set();
  for (const item of [...(safe.competitors_detected || []), ...inferredCompetitors, ...signalInferredCompetitors]) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const product = String(item?.product || "").trim();
    const key = `${name.toLowerCase()}::${product.toLowerCase()}`;
    if (seenCompetitors.has(key)) continue;
    seenCompetitors.add(key);
    mergedCompetitors.push({
      ...item,
      name,
      product,
      displacement_angle: item?.displacement_angle || "Detected provider context in filing.",
      snippet: item?.snippet || item?.quote || null,
    });
  }
  safe.competitors_detected = mergedCompetitors;

  const painKeywords = (safe.pain_indicators || []).map((p) => p.pain || p).filter(Boolean);
  const suitabilityKeywords = [
    ...(safe.opportunities || []).map((o) => o.product || ""),
    "international",
    "payments",
    "treasury",
    "expense",
  ].filter(Boolean);
  const competitorNames = (safe.competitors_detected || []).map((c) => c.name || c).filter(Boolean);

  const existing = safe.evidence_snippets || {};
  safe.evidence_snippets = {
    pains: Array.isArray(existing.pains) && existing.pains.length > 0
      ? existing.pains
      : collectKeywordSnippets(filingText, painKeywords, 4).map((s) => ({ quote: s.quote, insight: "Supports identified pain signal", relevance: "high" })),
    suitability: Array.isArray(existing.suitability) && existing.suitability.length > 0
      ? existing.suitability
      : collectKeywordSnippets(filingText, suitabilityKeywords, 4).map((s) => ({ quote: s.quote, insight: "Supports Revolut suitability hypothesis", relevance: "medium" })),
    competitors: Array.isArray(existing.competitors) && existing.competitors.length > 0
      ? existing.competitors
      : collectKeywordSnippets(filingText, competitorNames, 4).map((s) => ({ quote: s.quote, insight: "Mentions incumbent provider context", relevance: "high" })),
    gaps: Array.isArray(existing.gaps) && existing.gaps.length > 0
      ? existing.gaps
      : collectKeywordSnippets(filingText, ["manual", "legacy", "delay", "cost", "pressure", "inefficiency"], 4).map((s) => ({ quote: s.quote, insight: "Potential gap/inefficiency signal", relevance: "medium" })),
    execution: Array.isArray(existing.execution) && existing.execution.length > 0
      ? existing.execution
      : collectKeywordSnippets(filingText, ["strategy", "initiative", "programme", "transformation", "improve"], 3).map((s) => ({ quote: s.quote, insight: "Execution narrative hook", relevance: "medium" })),
  };

  safe.competitors_detected = (safe.competitors_detected || []).map((c) => ({
    ...c,
    product: c.product || "",
    displacement_angle: c.displacement_angle || "Detected provider context in filing.",
    snippet: c.snippet || c.quote || null,
    inferred_advantage: c.inferred_advantage || COMPETITOR_INFERENCE[c.name] || "Use filing context to position switching path with low implementation risk.",
  }));

  safe.outreach_narrative = safe.outreach_narrative || buildOutreachNarrative(safe);
  safe.supplementary_context = safe.supplementary_context || deriveSupplementaryContext(safe);
  safe.level5_extraction = safe.level5_extraction || buildLevel5Extraction(safe, filingText, context);

  const snippetEvidenceCount = Object.values(safe.evidence_snippets || {}).reduce((sum, arr) => sum + ((arr || []).length), 0);
  const inferredPainRegister = (safe.pain_indicators || []).map((p) => ({
    area: classifyPainArea(`${p.pain || ""} ${p.evidence || ""}`),
    evidence: p.evidence || p.pain || "",
    inferred_problem: p.pain || "Operational pain inferred from filing context",
    severity: String(p.severity || "medium").toLowerCase(),
  }));

  if (!Array.isArray(safe.level5_extraction.pain_register) || safe.level5_extraction.pain_register.length === 0) {
    safe.level5_extraction.pain_register = inferredPainRegister.slice(0, 8);
  }

  const inferenceCount = (safe.level5_extraction.pain_register || []).length;
  safe.level5_extraction.quality = {
    ...(safe.level5_extraction.quality || {}),
    evidence_points: snippetEvidenceCount,
    inference_points: inferenceCount,
    confidence: snippetEvidenceCount >= 10 ? "high" : snippetEvidenceCount >= 5 ? "medium" : (inferenceCount >= 3 ? "medium" : "low"),
  };

  const existingHook = String(safe.level5_extraction?.sequence_inputs?.quantified_hook || "");
  if (/\[rounded figure\]|requires additional FX volume validation/i.test(existingHook)) {
    const turnover = Number(context.turnover || safe.level5_extraction?.company_snapshot?.turnover_gbp || 0);
    if (Number.isFinite(turnover) && turnover > 0) {
      const currencies = safe?.international_exposure?.currencies || [];
      const fxVolume = safe?.international_exposure?.present
        ? turnover * (currencies.length > 2 ? 0.35 : 0.22)
        : turnover * 0.15;
      const estimate = Math.max(50_000, Math.round((fxVolume * 0.008) / 10_000) * 10_000);
      safe.level5_extraction.sequence_inputs = {
        ...(safe.level5_extraction.sequence_inputs || {}),
        quantified_hook: `Estimated annual FX leakage opportunity in the region of £${estimate.toLocaleString("en-GB")}`,
      };
    }
  }

  return safe;
}

function stripJsonCodeFences(value) {
  return String(value || "")
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

function extractJsonFenceBody(value) {
  const source = String(value || "");
  const match = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1] ? String(match[1]).trim() : "";
}

function extractFirstJsonObject(value) {
  const source = String(value || "");
  const start = source.indexOf("{");
  if (start === -1) return source.trim();

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1).trim();
      }
    }
  }

  return source.slice(start).trim();
}

function removeTrailingCommas(value) {
  let current = String(value || "");
  for (let i = 0; i < 6; i += 1) {
    const next = current.replace(/,\s*([}\]])/g, "$1");
    if (next === current) break;
    current = next;
  }
  return current;
}

function repairTruncatedJson(value) {
  const source = extractFirstJsonObject(value);
  if (!source) return "";

  const output = [];
  const closerStack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (!inString && source.slice(i, i + 3) === "```") {
      break;
    }

    output.push(ch);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      closerStack.push("}");
      continue;
    }

    if (ch === "[") {
      closerStack.push("]");
      continue;
    }

    if ((ch === "}" || ch === "]") && closerStack.length > 0) {
      const expected = closerStack[closerStack.length - 1];
      if (expected === ch) closerStack.pop();
    }
  }

  let repaired = output.join("").trim();

  if (inString) {
    const trailingBackslashes = repaired.match(/\\+$/);
    if (trailingBackslashes && trailingBackslashes[0].length % 2 === 1) {
      repaired += "\\";
    }
    repaired += "\"";
  }

  repaired = removeTrailingCommas(repaired);
  if (closerStack.length > 0) {
    repaired += closerStack.reverse().join("");
  }
  repaired = removeTrailingCommas(repaired);
  return repaired;
}

export function parseLlmJsonContent(content) {
  const raw = String(content || "").replaceAll("\u0000", "");
  const cleaned = stripJsonCodeFences(raw).trim();
  const fenced = extractJsonFenceBody(raw);
  if (!cleaned && !fenced) throw new Error("Empty LLM response content");

  const candidates = [
    cleaned,
    fenced,
    extractFirstJsonObject(fenced),
    extractFirstJsonObject(cleaned),
    removeTrailingCommas(extractFirstJsonObject(fenced)),
    removeTrailingCommas(extractFirstJsonObject(cleaned)),
    repairTruncatedJson(fenced),
    repairTruncatedJson(cleaned),
  ];

  const seen = new Set();
  let lastError = null;

  for (const candidateRaw of candidates) {
    const candidate = String(candidateRaw || "").trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Failed to parse LLM JSON content");
}

export function isLLMConfigured() {
  return canUseLLM();
}

export function getLLMProviderInfo() {
  const provider = getActiveProvider();
  if (provider === "anthropic") return { provider, model: ANTHROPIC_MODEL };
  if (provider === "openai") return { provider, model: OPENAI_MODEL };
  return { provider: null, model: null };
}

export async function analyseCompany(companyNumber, companyName, turnover) {
  const filings = getFilingsForCompany(companyNumber, 3);
  const filingText = filings.find((f) => f.raw_data)?.raw_data || null;

  if (!canUseLLM()) {
    const fallback = generateFallbackAnalysis(companyName, companyNumber, turnover, filingText);
    return enrichSupplementaryContext(fallback, companyName, filingText);
  }

  if (!filingText) {
    const noData = ensureHolisticAnalysisShape({
      source: "no_filing_data",
      summary: "No filing text available for analysis. Process accounts data first.",
      turnover_trend: "unknown",
      themes: [],
      pain_indicators: [],
      opportunities: [],
      risks: [],
      recommended_approach: "Upload filing data or wait for next accounts processing cycle.",
      international_exposure: { present: false, details: "No filing data to assess" },
      key_people: [],
      evidence_snippets: { pains: [], suitability: [], competitors: [], gaps: [], execution: [] },
      outreach_narrative: buildOutreachNarrative({}),
      supplementary_context: deriveSupplementaryContext({}),
    }, filingText, { companyName, turnover });
    return enrichSupplementaryContext(noData, companyName, filingText);
  }

  const prompt = buildAnalysisPrompt(companyName, companyNumber, turnover, filingText);
  const provider = getActiveProvider();
  const systemPrompt = `You are a Revolut Business mid-market account executive prospecting analyst. You analyse UK company accounts filings to identify prospecting opportunities.

REVOLUT BUSINESS CONTEXT:
- Primary entry product: FX (73% of positioning, interbank rates vs banks charging 1-3%)
- Top revenue generator: Corporate Cards (1.7% GP per transaction, unlimited virtual cards)
- Key differentiator: 24-hour settlement for Merchant Acquiring (vs 3-7 days for Stripe/Worldpay)
- Revolut Pay: 99% profit margin, access to 70M retail users, 9-second checkout
- FX Forwards: 0.8% markup on GBP/EUR/USD vs traditional brokers who bundle with credit lines
- Spend Management: cheaper than Pleo (£5/user vs £9.50), 2-4x cheaper FX
- API: unified platform across banking + acquiring

TARGET: Mid-market companies £15M-£500M turnover with international operations, payment processing needs, or growing teams needing expense management.

KEY COMPETITORS TO DETECT:
- HSBC/Barclays/NatWest (FX): digital friction, 1-3% FX costs, legacy tech
- Stripe (Acquiring): 3-7 day settlement, high fees for commercial cards
- Worldpay (Acquiring): complex pricing, slow settlement
- Wise (FX): no forwards, no cards, no acquiring
- Pleo (Spend): 1.5-2.5% FX markup, no banking ecosystem

POSITIVE SIGNALS: New CFO/FD, recent acquisition, headcount growth 5%+, cost reduction mandate, international expansion, multiple banking relationships, payment costs mentioned, spreadsheets for AP.

NEGATIVE SIGNALS: Going concern doubt, in administration, purely domestic (no FX need), strong incumbent bank relationship with credit lines.

Return ONLY raw valid JSON (no markdown code fences, no commentary) with these fields:
- summary: string (2-3 sentence business description)
- turnover_trend: string ("growing"|"stable"|"declining"|"unknown")
- themes: array of { theme: string, evidence: string }
- pain_indicators: array of { pain: string, evidence: string, severity: "high"|"medium"|"low" }
- opportunities: array of { product: string, rationale: string, confidence: "high"|"medium"|"low", estimated_value: string }
- risks: array of strings
- recommended_approach: string (which product to lead with and why)
- deal_type: string ("transactional"|"transformational") — transactional = 1-2 products, transformational = full suite
- international_exposure: { present: boolean, details: string, currencies: array of strings }
- key_people: array of { name: string, role: string } (from directors report)
- competitors_detected: array of { name: string, product: string, displacement_angle: string, inferred_advantage?: string }
- evidence_snippets: {
    pains: array of { quote: string, insight: string, relevance: "high"|"medium"|"low" },
    suitability: array of { quote: string, insight: string, relevance: "high"|"medium"|"low" },
    competitors: array of { quote: string, insight: string, relevance: "high"|"medium"|"low" },
    gaps: array of { quote: string, insight: string, relevance: "high"|"medium"|"low" },
    execution: array of { quote: string, insight: string, relevance: "high"|"medium"|"low" }
  }
- outreach_narrative: {
    primary_pains: array of strings,
    incumbent_setup: string,
    gaps_we_can_fill: array of strings,
    revolut_advantage: string,
    execution_plan: string,
    communication_strategy: string
  }
- supplementary_context: {
    news_signals: array of { signal: string, relevance: string },
    mna_signals: array of { signal: string, evidence: string },
    people_research: array of { name: string, role: string, linkedin_search_url: string|null, lusha_status: string },
  enrichment_status: { linkedin_search: boolean, lusha: boolean, news_api: boolean },
  value_nuggets: array of { type: string, nugget: string, source: string, relevance: string }
  }
- level5_extraction: {
    company_snapshot: {
      segment_fit: string,
      turnover_gbp: number|null,
      employee_estimate: number|null,
      operating_model: string,
      international_profile: string
    },
    pain_register: array of {
      area: string,
      evidence: string,
      inferred_problem: string,
      severity: "high"|"medium"|"low"
    },
    revolut_opportunity: {
      pitch_summary: string,
      recommended_use_cases: array of {
        product: string,
        priority: "High"|"Medium"|"Experimental",
        why_fit: string,
        example_use_case: string
      },
      not_priority: array of strings
    },
    sequence_inputs: {
      now_trigger: string,
      quantified_hook: string,
      operations_hook: string,
      governance_hook: string,
      directors_language: array of strings,
      objection_to_preempt: string
    },
    quality: {
      evidence_points: number,
      inference_points: number,
      confidence: "high"|"medium"|"low"
    }
  }

Token budget guardrail:
- Keep arrays concise (typically max 4 entries unless explicitly required above).
- Keep each evidence/quote string <= 240 characters where possible.`;

  try {
    const response = provider === "anthropic"
      ? await fetchWithLlmTimeout(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 3200,
          temperature: 0.3,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        }),
      })
      : await fetchWithLlmTimeout(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: ["Bearer", OPENAI_API_KEY].join(" "),
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 3200,
        }),
      });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        disableLlmDueToAuth(provider || "openai", response.status);
        const fallback = { ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText), source: "fallback", error: `API auth failed (${response.status})` };
        return enrichSupplementaryContext(fallback, companyName, filingText);
      }
      const err = await response.text();
      console.error("LLM API error:", response.status, err);
      const fallback = { ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText), source: "fallback", error: "API call failed" };
      return enrichSupplementaryContext(fallback, companyName, filingText);
    }

    const data = await response.json();
    const content = provider === "anthropic"
      ? data.content?.[0]?.text
      : data.choices?.[0]?.message?.content;
    if (!content) {
      const fallback = { ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText), source: "fallback", error: "Empty response" };
      return enrichSupplementaryContext(fallback, companyName, filingText);
    }

    const parsed = parseLlmJsonContent(content);
    const enriched = ensureHolisticAnalysisShape(parsed, filingText, { companyName, turnover });
    const model = provider === "anthropic" ? ANTHROPIC_MODEL : OPENAI_MODEL;
    const result = { ...enriched, source: "llm", model, analysed_at: new Date().toISOString() };
    return enrichSupplementaryContext(result, companyName, filingText);
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    const errorMessage = isTimeout
      ? `LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`
      : err.message;
    console.error("LLM analysis error:", errorMessage);
    const fallback = {
      ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText),
      source: "fallback",
      error: errorMessage,
    };
    return enrichSupplementaryContext(fallback, companyName, filingText);
  }
}

function buildAnalysisPrompt(companyName, companyNumber, turnover, filingText) {
  const truncated = filingText.substring(0, 12000);
  return `Analyse this UK company's accounts filing for prospecting purposes.

Company: ${companyName || "Unknown"}
Company Number: ${companyNumber}
Turnover: £${turnover ? (turnover / 1e6).toFixed(1) + "M" : "Unknown"}

--- FILING CONTENT ---
${truncated}
--- END ---

LEVEL 5 EXTRACTION REQUIREMENTS:
- Use evidence-first reasoning. Every inferred pain should be anchored to filing text.
- Distinguish company context from outreach opportunity. Do not merge them.
- Prioritise UK mid-market relevance and sequence one primary motion before adjacent motions.
- Include practical "not a priority" notes where evidence is weak.
- Do not invent numbers or facts not present in filing context.

OUTPUT SHAPE REQUIREMENTS:
- company context snapshot
- pain register with evidence + inferred operational problem + severity
- revolut opportunity map with priority (High/Medium/Experimental)
- sequence inputs (now trigger, quantified hook, operations hook, governance hook)

Return raw JSON only.`;
}

function generateFallbackAnalysis(companyName, companyNumber, turnover, filingText) {
  const name = companyName || "Name lookup needed";
  const t = turnover ? `£${(turnover / 1e6).toFixed(1)}M` : "unknown";

  if (!filingText) {
    return ensureHolisticAnalysisShape({
      source: "no_data",
      summary: `${name} has ${t} turnover. No filing content available for detailed analysis.`,
      themes: [],
      pain_indicators: [],
      opportunities: [],
      risks: ["No filing data available for analysis"],
      recommended_approach: "Upload filing data or wait for next accounts processing cycle.",
      international_exposure: { present: false, details: "No filing data to assess", currencies: [] },
      key_people: [],
      analysed_at: new Date().toISOString(),
    }, filingText, { companyName, turnover });
  }

  const text = filingText.toLowerCase();
  const themes = [];
  const pains = [];
  const opportunities = [];
  const people = [];

  if (text.includes("international") || text.includes("overseas") || text.includes("export")) {
    themes.push({ theme: "International activity", evidence: "Filing mentions international/overseas operations" });
    pains.push({ pain: "FX exposure", evidence: "International operations suggest multi-currency payment flows", severity: "medium" });
    opportunities.push({ product: "FX", rationale: "International operations indicate FX payment needs", confidence: "medium" });
  }

  if (text.includes("acquisition") || text.includes("merger") || text.includes("group")) {
    themes.push({ theme: "M&A / Group structure", evidence: "Filing references acquisitions or group structure" });
  }

  if (text.includes("employee") || text.includes("staff")) {
    const empMatch = filingText.match(/(\d+)\s*(?:employees|staff|people)/i);
    if (empMatch) {
      const count = parseInt(empMatch[1]);
      if (count > 50) {
        pains.push({ pain: "Expense management at scale", evidence: `${count} employees likely need corporate cards/expense controls`, severity: count > 200 ? "high" : "medium" });
        opportunities.push({ product: "Cards", rationale: `${count} employees represent a significant card programme opportunity`, confidence: count > 200 ? "high" : "medium" });
        opportunities.push({ product: "Spend Management", rationale: `Multi-department organisation with ${count} staff needs spend controls`, confidence: "medium" });
      }
    }
  }

  if (text.includes("revenue") && (text.includes("increas") || text.includes("grew") || text.includes("growth"))) {
    themes.push({ theme: "Revenue growth", evidence: "Filing indicates growing revenue" });
  }

  if (text.includes("payment") || text.includes("merchant") || text.includes("online") || text.includes("e-commerce")) {
    opportunities.push({ product: "Merchant Acquiring", rationale: "Payment/online activity suggests card acceptance needs", confidence: "medium" });
  }

  people.push(...extractKeyPeopleFromText(filingText));

  const isInternational = text.includes("international") || text.includes("overseas") || text.includes("foreign currency");

  return ensureHolisticAnalysisShape({
    source: "text_analysis",
    summary: `${name} is a mid-market company with ${t} turnover.${themes.length > 0 ? " Key themes: " + themes.map((t) => t.theme).join(", ") + "." : ""}`,
    turnover_trend: text.includes("increas") || text.includes("grew") ? "growing" : text.includes("decreas") || text.includes("declined") ? "declining" : "unknown",
    themes,
    pain_indicators: pains,
    opportunities,
    risks: turnover && turnover < 20_000_000 ? ["Relatively lower turnover — may have limited commercial value"] : [],
    recommended_approach: opportunities.length > 0
      ? `Lead with ${opportunities[0].product} — ${opportunities[0].rationale}`
      : "Research further via Companies House and company website before outreach.",
    international_exposure: { present: isInternational, details: isInternational ? "Filing indicates international operations" : "No clear international activity mentioned" },
    key_people: people,
    analysed_at: new Date().toISOString(),
  }, filingText, { companyName, turnover });
}

function extractKeyPeopleFromText(filingText) {
  const people = [];
  const seen = new Set();
  const roles = [
    "Chief Financial Officer",
    "Finance Director",
    "Group Finance Director",
    "Head of Finance",
    "Head of Treasury",
    "Treasurer",
    "Financial Controller",
    "Managing Director",
    "Chief Executive",
    "Head of Payments",
    "Head of Procurement",
    "Procurement Director",
    "Operations Director",
    "Director",
  ];
  const rolePattern = roles.map((r) => r.replace(/\s+/g, "\\s+")).join("|");
  const namePattern = "[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,3}";
  const patterns = [
    new RegExp(`(${namePattern})\\s*(?:,|-|–|—)?\\s*(${rolePattern})`, "g"),
    new RegExp(`(${rolePattern})\\s*(?:,|-|–|—|:)?\\s*(${namePattern})`, "g"),
    /(?:appointed|appointment of|joined)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:as\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(filingText)) !== null) {
      const first = match[1];
      const second = match[2];
      const nameFirst = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(first) && !roles.some((r) => r.toLowerCase() === first.toLowerCase());
      const name = (nameFirst ? first : second).trim();
      const role = (nameFirst ? second : first).trim();
      const key = `${name}:${role}`.toLowerCase();
      if (!seen.has(key) && name.length < 80 && role.length < 80) {
        seen.add(key);
        people.push({ name, role });
      }
    }
  }

  return people.slice(0, 8);
}

// Keep backward compat for the old endpoint
export async function extractEvidence(company, productMotion) {
  return analyseCompany(
    company.company_number || company.id?.replace("ch-", ""),
    company.name,
    company.turnover
  );
}
