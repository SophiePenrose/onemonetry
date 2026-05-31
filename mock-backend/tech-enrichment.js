import { getSetting, setSetting } from "./db.js";

const DEFAULT_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.TECH_ENRICHMENT_TIMEOUT_MS || "4500", 10) || 4500
);

const DEFAULT_MAX_PAGES = Math.max(
  1,
  Math.min(Number.parseInt(process.env.TECH_ENRICHMENT_MAX_PAGES || "6", 10) || 6, 12)
);

const DEFAULT_REFRESH_WINDOW_DAYS = Math.max(
  1,
  Math.min(Number.parseInt(process.env.TECH_ENRICHMENT_REFRESH_DAYS || "21", 10) || 21, 365)
);

const DEFAULT_DEEP_SCAN_MODE = normalizeDeepScanMode(process.env.TECH_ENRICHMENT_DEEP_SCAN_MODE || "auto");

const DEFAULT_HIGH_VALUE_TURNOVER = Math.max(
  1_000_000,
  Number.parseInt(process.env.TECH_ENRICHMENT_HIGH_VALUE_TURNOVER || "25000000", 10) || 25_000_000
);

const TECH_SCAN_USER_AGENT = process.env.TECH_ENRICHMENT_USER_AGENT || "onemonetry-tech-scan/1.0";

const TECH_SIGNAL_RULES = [
  {
    key: "Stripe",
    patterns: [/js\.stripe\.com/i, /\bstripe\b/i],
    fields: { payment_gateway: "Stripe", payment_processor: "Stripe" },
  },
  {
    key: "Worldpay",
    patterns: [/\bworld\s?pay\b/i],
    fields: { payment_gateway: "Worldpay", payment_processor: "Worldpay" },
  },
  {
    key: "Adyen",
    patterns: [/\badyen\b/i],
    fields: { payment_gateway: "Adyen", payment_processor: "Adyen" },
  },
  {
    key: "PayPal",
    patterns: [/\bpaypal\b/i, /\bbraintree\b/i],
    fields: { payment_gateway: "PayPal", payment_processor: "PayPal" },
  },
  {
    key: "Square",
    patterns: [/\bsquareup\b/i, /\bsquare\s+payments?\b/i],
    fields: { payment_gateway: "Square", payment_processor: "Square" },
  },
  {
    key: "SumUp",
    patterns: [/\bsumup\b/i],
    fields: { payment_gateway: "SumUp", payment_processor: "SumUp" },
  },
  {
    key: "Sage Pay",
    patterns: [/\bsage\s?pay\b/i, /\bopayo\b/i],
    fields: { payment_gateway: "Sage Pay", payment_processor: "Sage Pay" },
  },
  {
    key: "Global Payments",
    patterns: [/\bglobal\s+payments\b/i],
    fields: { payment_gateway: "Global Payments", payment_processor: "Global Payments" },
  },
  {
    key: "Xero",
    patterns: [/\bxero\b/i],
    fields: { accounting_software: "Xero", accounting_system: "Xero" },
  },
  {
    key: "QuickBooks",
    patterns: [/\bquickbooks\b/i, /\bintuit\b/i],
    fields: { accounting_software: "QuickBooks", accounting_system: "QuickBooks" },
  },
  {
    key: "NetSuite",
    patterns: [/\bnetsuite\b/i],
    fields: { accounting_software: "NetSuite", accounting_system: "NetSuite", erp: "NetSuite" },
  },
  {
    key: "Sage",
    patterns: [/\bsage\s+(?:accounting|business\s+cloud|intacct|50)\b/i],
    fields: { accounting_software: "Sage", accounting_system: "Sage" },
  },
  {
    key: "SAP",
    patterns: [/\bsap\b/i],
    fields: { erp: "SAP" },
  },
  {
    key: "Shopify",
    patterns: [/\bshopify\b/i],
    fields: { ecommerce_platform: "Shopify", store_platform: "Shopify" },
  },
  {
    key: "WooCommerce",
    patterns: [/\bwoocommerce\b/i, /wp-content\/plugins\/woocommerce/i],
    fields: { ecommerce_platform: "WooCommerce", store_platform: "WooCommerce" },
  },
  {
    key: "Magento",
    patterns: [/\bmagento\b/i, /\badobe\s+commerce\b/i],
    fields: { ecommerce_platform: "Magento", store_platform: "Magento" },
  },
  {
    key: "BigCommerce",
    patterns: [/\bbigcommerce\b/i],
    fields: { ecommerce_platform: "BigCommerce", store_platform: "BigCommerce" },
  },
];

const MULTI_CURRENCY_PLUGIN_PATTERNS = [
  /multi-currency\s+for\s+woocommerce/i,
  /\bwpml\b/i,
  /\bweglot\b/i,
  /\bgeotargetingwp\b/i,
  /\bhreflang\b/i,
];

const CUSTOMER_TYPE_PATTERNS = {
  b2c: [
    /\badd\s+to\s+cart\b/i,
    /\bcheckout\b/i,
    /\bshop\s+now\b/i,
    /\bconsumer\b/i,
    /\bb2c\b/i,
    /\bfree\s+shipping\b/i,
    /\bbuy\s+now\b/i,
  ],
  b2b: [
    /\bbook\s+(?:a\s+)?demo\b/i,
    /\brequest\s+(?:a\s+)?demo\b/i,
    /\benterprise\b/i,
    /\bfor\s+business(?:es)?\b/i,
    /\bprocurement\b/i,
    /\binvoice\s+terms\b/i,
    /\bb2b\b/i,
  ],
};

const HIRING_SIGNAL_RULES = [
  { pattern: /\/careers?\b|\/jobs?\b/i, evidence: "Careers or jobs page route", score: 0.3 },
  { pattern: /\bwe(?:'|\s*a)?re\s+hiring\b/i, evidence: "Hiring language detected", score: 0.25 },
  { pattern: /\bopen\s+roles?\b|\bvacancies?\b/i, evidence: "Open role language detected", score: 0.2 },
  { pattern: /\bjoin\s+our\s+team\b/i, evidence: "Team growth language detected", score: 0.2 },
  { pattern: /\blinkedin\.com\/jobs\b/i, evidence: "LinkedIn jobs integration detected", score: 0.15 },
];

const HIRING_ROLE_PATTERNS = [
  { pattern: /\bcfo\b|\bchief\s+financial\s+officer\b/i, role: "CFO", bucket: "finance" },
  { pattern: /\bfinance\s+director\b|\bhead\s+of\s+finance\b/i, role: "Finance Director", bucket: "finance" },
  { pattern: /\bfinancial\s+controller\b/i, role: "Financial Controller", bucket: "finance" },
  { pattern: /\btreasury\s+manager\b|\bhead\s+of\s+treasury\b/i, role: "Treasury Manager", bucket: "treasury" },
  { pattern: /\btreasury\s+analyst\b/i, role: "Treasury Analyst", bucket: "treasury" },
  { pattern: /\baccounts\s+payable\b|\bap\s+manager\b/i, role: "Accounts Payable", bucket: "finance" },
  { pattern: /\baccounts\s+receivable\b|\bar\s+manager\b/i, role: "Accounts Receivable", bucket: "finance" },
  { pattern: /\bprocurement\s+manager\b/i, role: "Procurement Manager", bucket: "international" },
  { pattern: /\becommerce\s+manager\b/i, role: "Ecommerce Manager", bucket: "ecommerce" },
  { pattern: /\bhead\s+of\s+digital\b/i, role: "Head of Digital", bucket: "ecommerce" },
  { pattern: /\binternational\s+manager\b|\bemea\s+director\b/i, role: "International Manager", bucket: "international" },
];

const REPUTATION_SIGNAL_RULES = [
  { pattern: /\biso\s*27001\b/i, evidence: "ISO 27001 signal", score: 0.2 },
  { pattern: /\bsoc\s*2\b/i, evidence: "SOC 2 signal", score: 0.2 },
  { pattern: /\bpci[-\s]?dss\b/i, evidence: "PCI DSS signal", score: 0.2 },
  { pattern: /\bgdpr\b/i, evidence: "GDPR signal", score: 0.15 },
  { pattern: /\btrusted\s+by\s+[\w\s]+/i, evidence: "Customer trust language", score: 0.15 },
  { pattern: /\bcase\s+stud(?:y|ies)\b|\btestimonials?\b/i, evidence: "Case study/testimonial language", score: 0.1 },
  { pattern: /\bawards?\b|\bcertified\b/i, evidence: "Awards/certification language", score: 0.1 },
];

const CURRENCY_PATTERNS = {
  GBP: [/\bGBP\b/i, /£\s?\d/i, /\bpound(?:s)?\b/i],
  EUR: [/\bEUR\b/i, /€\s?\d/i],
  USD: [/\bUSD\b/i, /\$\s?\d/i, /\bUS\s*dollars?\b/i],
  CAD: [/\bCAD\b/i],
  AUD: [/\bAUD\b/i],
  CHF: [/\bCHF\b/i],
  JPY: [/\bJPY\b/i],
  AED: [/\bAED\b/i],
};

const LOCATION_HINTS = [
  "London",
  "Manchester",
  "Birmingham",
  "Leeds",
  "Bristol",
  "Edinburgh",
  "Glasgow",
  "Dublin",
  "Paris",
  "Berlin",
  "Madrid",
  "Milan",
  "Amsterdam",
  "Warsaw",
  "Dubai",
  "Singapore",
  "Hong Kong",
  "New York",
  "San Francisco",
  "Los Angeles",
  "Toronto",
  "Sydney",
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDomain(value) {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return null;
  try {
    const prefixed = /^https?:\/\//.test(input) ? input : `https://${input}`;
    const hostname = new URL(prefixed).hostname.toLowerCase();
    return hostname.replace(/^www\./, "");
  } catch {
    return input
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .trim() || null;
  }
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function guessCompanySlug(companyName) {
  return String(companyName || "")
    .toLowerCase()
    .replace(/\b(limited|ltd|plc|llp|inc|corp|group|holdings|holding|company|co|the)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function guessCompanyDomains(companyName) {
  const slug = guessCompanySlug(companyName);
  if (!slug || slug.length < 4) return [];
  return [`${slug}.co.uk`, `${slug}.com`];
}

function getCompanyTokens(companyName) {
  const stopwords = new Set([
    "ltd",
    "limited",
    "plc",
    "llp",
    "uk",
    "group",
    "holdings",
    "holding",
    "company",
    "co",
    "the",
  ]);

  return String(companyName || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stopwords.has(token));
}

function daysSince(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  const delta = Date.now() - ts;
  if (!Number.isFinite(delta) || delta < 0) return 0;
  return Math.floor(delta / 86400000);
}

function isFreshPayload(payload, refreshWindowDays) {
  if (!payload || typeof payload !== "object") return false;
  const stamp = payload.updated_at || payload.fetched_at || payload.generated_at || payload.timestamp;
  const age = daysSince(stamp);
  if (age === null) return false;
  return age <= refreshWindowDays;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

function extractPluginSlugs(html) {
  const slugs = [];
  const seen = new Set();
  const source = String(html || "");
  const regex = /wp-content\/plugins\/([a-z0-9-]{2,80})/gi;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const slug = String(match[1] || "").trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }

  return slugs;
}

function slugToName(slug) {
  return String(slug || "")
    .split("-")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : ""))
    .join(" ")
    .trim();
}

function detectCurrencies(text) {
  const detected = [];
  for (const [code, patterns] of Object.entries(CURRENCY_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(text))) {
      detected.push(code);
    }
  }
  return detected;
}

function detectSocialChannels(html) {
  const source = String(html || "").toLowerCase();
  const channels = [];
  if (source.includes("linkedin.com")) channels.push("linkedin");
  if (source.includes("instagram.com")) channels.push("instagram");
  if (source.includes("facebook.com")) channels.push("facebook");
  if (source.includes("x.com") || source.includes("twitter.com")) channels.push("x");
  if (source.includes("youtube.com")) channels.push("youtube");
  if (source.includes("tiktok.com")) channels.push("tiktok");
  return [...new Set(channels)];
}

function detectEmployeeCount(text) {
  const patterns = [
    /(\d{2,6})\+?\s+(?:employees|staff|team\s+members|people|colleagues|fte)\b/i,
    /team\s+of\s+(\d{2,6})\b/i,
    /(?:headcount|workforce)\s+(?:of\s+)?(\d{2,6})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed >= 10 && parsed <= 250000) {
      return parsed;
    }
  }

  return null;
}

function detectOfficeLocations(text) {
  const found = [];
  const seen = new Set();

  for (const location of LOCATION_HINTS) {
    const pattern = new RegExp(`\\b${location.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (!pattern.test(text)) continue;
    const key = location.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(location);
  }

  const officesMatch = text.match(/offices?\s+(?:in|across)\s+([a-zA-Z\s,&-]{8,180})/i);
  if (officesMatch) {
    const parts = officesMatch[1]
      .split(/,|\band\b/i)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3 && item.length <= 40)
      .slice(0, 10);

    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(part);
    }
  }

  return found.slice(0, 12);
}

function detectCustomerTypeScore(text) {
  let b2c = 0;
  let b2b = 0;

  for (const pattern of CUSTOMER_TYPE_PATTERNS.b2c) {
    if (pattern.test(text)) b2c += 1;
  }
  for (const pattern of CUSTOMER_TYPE_PATTERNS.b2b) {
    if (pattern.test(text)) b2b += 1;
  }

  return { b2c, b2b };
}

function detectInternationalShipping(text) {
  const normalized = String(text || "");
  let shippingCountries = 0;
  let internationalShipping = false;

  const countryCountMatch = normalized.match(/(?:ship|deliver)\w*\s+(?:to\s+)?(?:over|more\s+than|across)\s+(\d{1,3})\s+countries/i);
  if (countryCountMatch) {
    internationalShipping = true;
    shippingCountries = Number.parseInt(countryCountMatch[1], 10) || 0;
  }

  if (/(?:international|worldwide|global)\s+(?:shipping|delivery)/i.test(normalized)) {
    internationalShipping = true;
  }

  if (/ships?\s+to\s+\d{1,3}\+?\s+countries/i.test(normalized)) {
    internationalShipping = true;
  }

  return { internationalShipping, shippingCountries };
}

function ensureUniquePush(target, value) {
  const next = String(value || "").trim();
  if (!next) return;
  if (!target.includes(next)) target.push(next);
}

function detectRuleHits(text, rules) {
  const hits = [];
  for (const rule of rules) {
    if (!rule.pattern.test(text)) continue;
    hits.push({
      evidence: rule.evidence,
      score: Number(rule.score || 0),
    });
  }
  return hits;
}

function detectHiringRoles(text) {
  const roles = [];
  for (const rule of HIRING_ROLE_PATTERNS) {
    if (!rule.pattern.test(text)) continue;
    roles.push({ role: rule.role, bucket: rule.bucket });
  }
  return roles;
}

function buildTechFromPage(scan, page) {
  const combined = `${page.url}\n${page.html}\n${page.text}`;

  for (const rule of TECH_SIGNAL_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(combined))) continue;

    scan.technologies.add(rule.key);
    scan.detections.push({ technology: rule.key, page: page.url, stage: page.stage });

    for (const [field, fieldValue] of Object.entries(rule.fields || {})) {
      if (!scan[field]) scan[field] = fieldValue;
    }
  }

  for (const slug of extractPluginSlugs(page.html)) {
    const name = slugToName(slug);
    if (!name) continue;
    scan.plugins.add(name);
    if (MULTI_CURRENCY_PLUGIN_PATTERNS.some((pattern) => pattern.test(name))) {
      scan.multiCurrencyPlugins.add(name);
    }
  }

  for (const code of detectCurrencies(page.text)) {
    scan.siteCurrencies.add(code);
    if (page.pageType === "pricing") {
      scan.pricingCurrencies.add(code);
    }
  }

  const shipping = detectInternationalShipping(page.text);
  if (shipping.internationalShipping) {
    scan.internationalShipping = true;
    if (shipping.shippingCountries > scan.shippingCountries) {
      scan.shippingCountries = shipping.shippingCountries;
    }
  }

  const locations = detectOfficeLocations(page.text);
  for (const location of locations) {
    scan.officeLocations.add(location);
  }

  const employees = detectEmployeeCount(page.text);
  if (employees && (!scan.employeeCountClaimed || employees > scan.employeeCountClaimed)) {
    scan.employeeCountClaimed = employees;
  }

  const customerTypeScore = detectCustomerTypeScore(page.text);
  scan.customerTypeSignals.b2c += customerTypeScore.b2c;
  scan.customerTypeSignals.b2b += customerTypeScore.b2b;

  const hiringHits = detectRuleHits(combined, HIRING_SIGNAL_RULES);
  for (const hit of hiringHits) {
    scan.hiringSignalScore += hit.score;
    ensureUniquePush(scan.hiringEvidence, hit.evidence);
  }

  const reputationHits = detectRuleHits(combined, REPUTATION_SIGNAL_RULES);
  for (const hit of reputationHits) {
    scan.reputationSignalScore += hit.score;
    ensureUniquePush(scan.reputationEvidence, hit.evidence);
  }

  const hiringRoles = detectHiringRoles(combined);
  for (const hit of hiringRoles) {
    const roleKey = `${hit.bucket}:${hit.role}`;
    if (scan.detectedHiringRoleKeys.has(roleKey)) continue;
    scan.detectedHiringRoleKeys.add(roleKey);
    scan.detectedHiringRoles.push({ role: hit.role, bucket: hit.bucket });
  }

  if (page.pageType === "pricing") scan.hasPricingPage = true;
  if (page.pageType === "checkout") scan.hasCheckoutPage = true;
  if (page.pageType === "careers") scan.hasCareersPage = true;

  for (const channel of detectSocialChannels(page.html)) {
    scan.socialChannels.add(channel);
  }
}

function classifyPageType(url, text) {
  const needle = `${url} ${text}`.toLowerCase();
  if (/\/pricing|\/plans|pricing|plans|billing/.test(needle)) return "pricing";
  if (/\/checkout|\/cart|\/payment|add\s+to\s+cart|basket|buy\s+now/.test(needle)) return "checkout";
  if (/\/careers?|\/jobs?|careers?|vacancies|join\s+our\s+team/.test(needle)) return "careers";
  if (/\/about|about\s+us/.test(needle)) return "about";
  if (/\/contact|contact\s+us/.test(needle)) return "contact";
  return "home";
}

function scoreConfidence(scan) {
  const signalCount =
    scan.technologies.size
    + scan.plugins.size
    + scan.siteCurrencies.size
    + (scan.internationalShipping ? 1 : 0)
    + (scan.officeLocations.size >= 2 ? 1 : 0)
    + (scan.employeeCountClaimed ? 1 : 0)
    + (scan.customerType !== "unknown" ? 1 : 0);

  const score = clamp(signalCount / 10, 0, 1);
  const level = score >= 0.65 ? "high" : score >= 0.35 ? "medium" : "low";

  return {
    score: Math.round(score * 100) / 100,
    level,
    signal_count: signalCount,
  };
}

function deriveCustomerType(scan) {
  const b2c = Number(scan.customerTypeSignals.b2c || 0);
  const b2b = Number(scan.customerTypeSignals.b2b || 0);
  if (b2c === 0 && b2b === 0) return "unknown";
  if (b2c >= b2b * 1.4) return "B2C";
  if (b2b >= b2c * 1.4) return "B2B";
  return "hybrid";
}

function getScanPaths(scan) {
  const paths = [];
  const hasPaymentSignal = !!scan.payment_gateway || !!scan.payment_processor;

  if (!hasPaymentSignal || !scan.hasCheckoutPage) {
    paths.push("/checkout", "/payments", "/shop");
  }

  if (scan.pricingCurrencies.size < 2) {
    paths.push("/pricing", "/plans");
  }

  if (!scan.hasCareersPage) {
    paths.push("/careers", "/jobs");
  }

  paths.push("/about", "/contact");

  return [...new Set(paths)];
}

function buildCandidateRoots({ companyWebsite, companyDomain, companyName }) {
  const roots = [];
  const pushRoot = (value) => {
    const normalized = normalizeWebsiteUrl(value);
    if (!normalized) return;
    try {
      const parsed = new URL(normalized);
      const origin = parsed.origin;
      if (!roots.includes(origin)) roots.push(origin);
    } catch {
      // Ignore invalid values after normalization.
    }
  };

  if (companyWebsite) pushRoot(companyWebsite);

  const domain = normalizeDomain(companyDomain);
  if (domain) {
    pushRoot(`https://${domain}`);
    pushRoot(`https://www.${domain}`);
  }

  if (roots.length === 0) {
    for (const guessedDomain of guessCompanyDomains(companyName)) {
      pushRoot(`https://${guessedDomain}`);
      pushRoot(`https://www.${guessedDomain}`);
      if (roots.length >= 4) break;
    }
  }

  return roots;
}

function isLikelyCompanySite({ companyName, domain, pageTitle, pageText, usedGuess }) {
  if (!usedGuess) return true;

  const tokens = getCompanyTokens(companyName);
  if (tokens.length === 0) return true;

  const haystack = `${String(pageTitle || "")} ${String(pageText || "")}`.toLowerCase();
  const domainLower = String(domain || "").toLowerCase();
  const tokenDomainMatch = tokens.some((token) => domainLower.includes(token));
  const tokenTextMatches = tokens.filter((token) => haystack.includes(token)).length;

  return tokenDomainMatch && tokenTextMatches >= 1;
}

async function fetchHtmlPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": TECH_SCAN_USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        url,
        status: response.status,
        error: `http_${response.status}`,
      };
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return {
        ok: false,
        url,
        status: response.status,
        error: "unsupported_content_type",
      };
    }

    const html = await response.text();
    return {
      ok: true,
      status: response.status,
      url: response.url || url,
      html,
    };
  } catch (err) {
    return {
      ok: false,
      url,
      status: null,
      error: err?.name === "AbortError" ? "timeout" : (err?.message || "network_error"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  const token = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(token)) return true;
  if (["false", "0", "no", "n", "off"].includes(token)) return false;
  return null;
}

function normalizeDeepScanMode(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "off" || token === "false" || token === "0") return "off";
  if (token === "always" || token === "on" || token === "true" || token === "1") return "always";
  return "auto";
}

function resolveDeepScanPreference(input = {}) {
  const deepScanBoolean = parseOptionalBoolean(input.deepScan ?? input.deep_scan);
  if (deepScanBoolean !== null) {
    return {
      mode: deepScanBoolean ? "always" : "off",
      source: "boolean_override",
    };
  }

  const explicitMode = input.deepScanMode ?? input.deep_scan_mode;
  if (explicitMode !== undefined && explicitMode !== null) {
    return {
      mode: normalizeDeepScanMode(explicitMode),
      source: "mode_override",
    };
  }

  return {
    mode: DEFAULT_DEEP_SCAN_MODE,
    source: "default",
  };
}

function resolveRefreshWindowDays(value) {
  return parsePositiveInt(value, DEFAULT_REFRESH_WINDOW_DAYS, 1, 365);
}

function buildSnapshotEnvelope(key, profile, includeData = false) {
  const payload = getSetting(key, null);
  if (!payload || typeof payload !== "object") {
    return {
      key,
      available: false,
      stale: false,
      expired: false,
      days_old: null,
      updated_at: null,
      ...(includeData ? { data: null } : {}),
    };
  }

  const timestamp = payload.updated_at || payload.fetched_at || payload.generated_at || payload.timestamp || null;
  const daysOld = daysSince(timestamp);
  const staleAfter = Number(profile?.decay_after_days || 60);
  const maxAge = Number(profile?.max_age_days || 90);
  const stale = daysOld !== null ? daysOld > staleAfter : false;
  const expired = daysOld !== null ? daysOld > maxAge : false;

  return {
    key,
    available: !expired,
    stale,
    expired,
    days_old: daysOld,
    updated_at: timestamp,
    ...(includeData ? { data: payload } : {}),
  };
}

export function getCompanyEnrichmentSnapshot(companyNumber, options = {}) {
  const includeData = options.includeData !== false;
  const keyPrefix = String(companyNumber || "").trim();
  const profile = {
    tech_stack: { decay_after_days: 60, max_age_days: 90 },
    website_intelligence: { decay_after_days: 60, max_age_days: 90 },
    marketing_intelligence: { decay_after_days: 30, max_age_days: 60 },
    reputation: { decay_after_days: 120, max_age_days: 180 },
    hiring_signals: { decay_after_days: 14, max_age_days: 30 },
    ownership: { decay_after_days: 240, max_age_days: 365 },
  };

  return {
    company_number: keyPrefix,
    tech_stack: buildSnapshotEnvelope(`tech_stack_${keyPrefix}`, profile.tech_stack, includeData),
    website_intelligence: buildSnapshotEnvelope(`website_intelligence_${keyPrefix}`, profile.website_intelligence, includeData),
    marketing_intelligence: buildSnapshotEnvelope(`marketing_intelligence_${keyPrefix}`, profile.marketing_intelligence, includeData),
    reputation: buildSnapshotEnvelope(`reputation_${keyPrefix}`, profile.reputation, includeData),
    hiring_signals: buildSnapshotEnvelope(`hiring_signals_${keyPrefix}`, profile.hiring_signals, includeData),
    ownership: buildSnapshotEnvelope(`ownership_${keyPrefix}`, profile.ownership, includeData),
  };
}

export function getTechEnrichmentRuntimeConfig() {
  return {
    timeout_ms: DEFAULT_TIMEOUT_MS,
    max_pages: DEFAULT_MAX_PAGES,
    refresh_window_days: DEFAULT_REFRESH_WINDOW_DAYS,
    deep_scan_mode: DEFAULT_DEEP_SCAN_MODE,
    high_value_turnover: DEFAULT_HIGH_VALUE_TURNOVER,
  };
}

export async function runCompanyTechEnrichment(input = {}) {
  const companyNumber = String(input.companyNumber || input.company_number || "").trim();
  if (!companyNumber) {
    return {
      status: "invalid_input",
      updated: false,
      error: "company_number is required",
    };
  }

  const companyName = String(input.companyName || input.company_name || "").trim();
  const companyWebsite = String(input.companyWebsite || input.company_website || "").trim() || null;
  const companyDomain = String(input.companyDomain || input.company_domain || "").trim() || null;
  const turnover = Number(input.turnover || 0);

  const force = input.force === true;
  const deepScanPreference = resolveDeepScanPreference(input);
  const refreshWindowDays = resolveRefreshWindowDays(input.refreshWindowDays);
  const timeoutMs = parsePositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 20000);
  const maxPages = parsePositiveInt(input.maxPages, DEFAULT_MAX_PAGES, 1, 12);

  const existingTech = getSetting(`tech_stack_${companyNumber}`, null);
  if (!force && isFreshPayload(existingTech, refreshWindowDays)) {
    return {
      status: "fresh_skip",
      updated: false,
      company_number: companyNumber,
      refresh_window_days: refreshWindowDays,
      last_updated_at: existingTech?.updated_at || existingTech?.fetched_at || null,
    };
  }

  const roots = buildCandidateRoots({ companyWebsite, companyDomain, companyName });
  if (roots.length === 0) {
    return {
      status: "no_site_hint",
      updated: false,
      company_number: companyNumber,
      error: "No website or domain available for enrichment scan",
    };
  }

  let homepage = null;
  let rootUrl = null;
  let usedGuess = !companyWebsite && !companyDomain;
  const rootAttempts = [];

  for (const root of roots.slice(0, 6)) {
    const attempt = await fetchHtmlPage(root, timeoutMs);
    rootAttempts.push({ url: root, ok: attempt.ok, error: attempt.error || null, status: attempt.status || null });
    if (!attempt.ok) continue;

    const title = extractTitle(attempt.html);
    const text = htmlToText(attempt.html).slice(0, 70000);

    const domain = normalizeDomain(attempt.url || root);
    const likely = isLikelyCompanySite({
      companyName,
      domain,
      pageTitle: title,
      pageText: text,
      usedGuess,
    });

    if (!likely) {
      continue;
    }

    homepage = {
      url: attempt.url || root,
      html: attempt.html,
      text,
      title,
      pageType: "home",
      stage: "stage1",
    };
    rootUrl = attempt.url || root;
    break;
  }

  if (!homepage || !rootUrl) {
    return {
      status: "unreachable",
      updated: false,
      company_number: companyNumber,
      attempts: rootAttempts,
      error: "Unable to resolve reachable company website",
    };
  }

  const scan = {
    technologies: new Set(),
    plugins: new Set(),
    multiCurrencyPlugins: new Set(),
    siteCurrencies: new Set(),
    pricingCurrencies: new Set(),
    officeLocations: new Set(),
    socialChannels: new Set(),
    detections: [],
    pagesScanned: [],
    customerTypeSignals: { b2c: 0, b2b: 0 },
    payment_gateway: null,
    payment_processor: null,
    accounting_software: null,
    accounting_system: null,
    erp: null,
    ecommerce_platform: null,
    store_platform: null,
    internationalShipping: false,
    shippingCountries: 0,
    employeeCountClaimed: null,
    hasPricingPage: false,
    hasCheckoutPage: false,
    hasCareersPage: false,
    hiringSignalScore: 0,
    hiringEvidence: [],
    detectedHiringRoles: [],
    detectedHiringRoleKeys: new Set(),
    reputationSignalScore: 0,
    reputationEvidence: [],
    customerType: "unknown",
  };

  buildTechFromPage(scan, homepage);
  scan.pagesScanned.push({
    url: homepage.url,
    page_type: homepage.pageType,
    stage: homepage.stage,
    title: homepage.title,
  });

  const weakSignals =
    scan.technologies.size < 2
    && scan.siteCurrencies.size < 2
    && !scan.payment_gateway
    && !scan.payment_processor;

  const highValue = Number.isFinite(turnover) && turnover >= DEFAULT_HIGH_VALUE_TURNOVER;
  const autoDeepScan = weakSignals || highValue;
  const shouldDeepScan = deepScanPreference.mode === "always"
    ? true
    : deepScanPreference.mode === "off"
      ? false
      : autoDeepScan;

  const rootOrigin = new URL(rootUrl).origin;
  const deepPaths = shouldDeepScan ? getScanPaths(scan) : [];
  const remainingBudget = Math.max(0, maxPages - 1);

  for (const nextPath of deepPaths.slice(0, remainingBudget)) {
    const fullUrl = `${rootOrigin}${nextPath}`;
    const pageRes = await fetchHtmlPage(fullUrl, timeoutMs);
    if (!pageRes.ok) continue;

    const pageText = htmlToText(pageRes.html).slice(0, 70000);
    const pageTitle = extractTitle(pageRes.html);
    const pageType = classifyPageType(pageRes.url || fullUrl, pageText);

    const page = {
      url: pageRes.url || fullUrl,
      html: pageRes.html,
      text: pageText,
      title: pageTitle,
      pageType,
      stage: "stage2",
    };

    buildTechFromPage(scan, page);
    scan.pagesScanned.push({
      url: page.url,
      page_type: page.pageType,
      stage: page.stage,
      title: page.title,
    });
  }

  scan.customerType = deriveCustomerType(scan);
  const confidence = scoreConfidence(scan);
  const nowIso = new Date().toISOString();
  const normalizedDomain = normalizeDomain(rootUrl);

  const technologies = [...scan.technologies];
  const plugins = [...scan.plugins];
  const siteCurrencies = [...scan.siteCurrencies];
  const pricingCurrencies = [...scan.pricingCurrencies];
  const officeLocations = [...scan.officeLocations];

  const techPayload = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: "deterministic_web_stack_scan_v1",
    scan_mode: shouldDeepScan ? "layered_stage1_stage2" : "stage1_only",
    deep_scan_mode: deepScanPreference.mode,
    company_number: companyNumber,
    company_name: companyName || null,
    website_url: rootUrl,
    domain: normalizedDomain,
    pages_scanned: scan.pagesScanned,
    technologies,
    detected_technologies: technologies,
    stack: technologies,
    wappalyzer: technologies,
    plugins,
    detected_plugins: plugins,
    platforms: [...new Set([scan.ecommerce_platform, scan.accounting_software, scan.erp].filter(Boolean))],
    payment_gateway: scan.payment_gateway,
    payment_processor: scan.payment_processor,
    psp: scan.payment_processor,
    gateway: scan.payment_gateway,
    accounting_software: scan.accounting_software,
    accounting_system: scan.accounting_system,
    erp: scan.erp,
    ecommerce_platform: scan.ecommerce_platform,
    store_platform: scan.store_platform,
    currencies_on_site: siteCurrencies,
    site_currencies: siteCurrencies,
    pricing_currencies: pricingCurrencies,
    confidence: confidence.level,
    confidence_score: confidence.score,
    signal_count: confidence.signal_count,
    evidence: scan.detections.slice(0, 40),
  };

  if (scan.multiCurrencyPlugins.size > 0) {
    techPayload.multi_currency_plugins = [...scan.multiCurrencyPlugins];
  }

  const websitePayload = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: "deterministic_web_stack_scan_v1",
    scan_mode: techPayload.scan_mode,
    deep_scan_mode: deepScanPreference.mode,
    website_url: rootUrl,
    domain: normalizedDomain,
    customer_type: scan.customerType,
    pricing_currencies: pricingCurrencies,
    currencies_on_pricing_page: pricingCurrencies,
    site_currencies: siteCurrencies,
    currencies: siteCurrencies,
    international_shipping: scan.internationalShipping,
    shipping_countries: scan.shippingCountries,
    office_locations: officeLocations,
    locations: officeLocations,
    regional_offices: officeLocations,
    employee_count_claimed: scan.employeeCountClaimed,
    confidence: confidence.level,
    confidence_score: confidence.score,
    signal_count: confidence.signal_count,
    pages_scanned: scan.pagesScanned,
  };

  const marketingPayload = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: "deterministic_web_stack_scan_v1",
    scan_mode: techPayload.scan_mode,
    deep_scan_mode: deepScanPreference.mode,
    website_url: rootUrl,
    domain: normalizedDomain,
    has_pricing_page: scan.hasPricingPage,
    has_checkout_page: scan.hasCheckoutPage,
    social_channels: [...scan.socialChannels],
    b2c_signal_count: scan.customerTypeSignals.b2c,
    b2b_signal_count: scan.customerTypeSignals.b2b,
    detected_technologies: technologies,
  };

  const hiringSignalScore = clamp(
    Number(scan.hiringSignalScore || 0) + (scan.hasCareersPage ? 0.1 : 0),
    0,
    1
  );
  const financeRoles = scan.detectedHiringRoles.filter((entry) => entry.bucket === "finance").map((entry) => ({ role: entry.role }));
  const treasuryRoles = scan.detectedHiringRoles.filter((entry) => entry.bucket === "treasury").map((entry) => ({ role: entry.role }));
  const internationalRoles = scan.detectedHiringRoles.filter((entry) => entry.bucket === "international").map((entry) => ({ role: entry.role }));
  const ecommerceRoles = scan.detectedHiringRoles.filter((entry) => entry.bucket === "ecommerce").map((entry) => ({ role: entry.role }));
  const openRoles = scan.detectedHiringRoles.map((entry) => ({ role: entry.role }));
  const hiringPayload = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: "deterministic_web_stack_scan_v1",
    scan_mode: techPayload.scan_mode,
    deep_scan_mode: deepScanPreference.mode,
    website_url: rootUrl,
    domain: normalizedDomain,
    has_careers_page: scan.hasCareersPage,
    finance_roles_open: financeRoles,
    treasury_roles_open: treasuryRoles,
    international_roles_open: internationalRoles,
    ecommerce_roles_open: ecommerceRoles,
    open_roles: openRoles,
    total_open_roles: openRoles.length,
    hiring_signal_score: Math.round(hiringSignalScore * 100) / 100,
    hiring_intensity: hiringSignalScore >= 0.7 ? "high" : hiringSignalScore >= 0.35 ? "medium" : "low",
    evidence: scan.hiringEvidence.slice(0, 20),
    confidence: confidence.level,
    confidence_score: confidence.score,
  };

  const reputationSignalScore = clamp(Number(scan.reputationSignalScore || 0), 0, 1);
  const reputationPayload = {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: "deterministic_web_stack_scan_v1",
    scan_mode: techPayload.scan_mode,
    deep_scan_mode: deepScanPreference.mode,
    website_url: rootUrl,
    domain: normalizedDomain,
    reputation_signal_score: Math.round(reputationSignalScore * 100) / 100,
    reputation_level: reputationSignalScore >= 0.7 ? "high" : reputationSignalScore >= 0.35 ? "medium" : "low",
    trust_signals: scan.reputationEvidence.slice(0, 20),
    confidence: confidence.level,
    confidence_score: confidence.score,
  };

  setSetting(`tech_stack_${companyNumber}`, techPayload);
  setSetting(`website_intelligence_${companyNumber}`, websitePayload);
  setSetting(`marketing_intelligence_${companyNumber}`, marketingPayload);
  setSetting(`hiring_signals_${companyNumber}`, hiringPayload);
  setSetting(`reputation_${companyNumber}`, reputationPayload);

  return {
    status: "updated",
    updated: true,
    company_number: companyNumber,
    company_name: companyName || null,
    website_url: rootUrl,
    domain: normalizedDomain,
    deep_scan_mode: deepScanPreference.mode,
    scan_mode: techPayload.scan_mode,
    pages_scanned: scan.pagesScanned.length,
    technologies,
    site_currencies: siteCurrencies,
    customer_type: scan.customerType,
    confidence: {
      level: confidence.level,
      score: confidence.score,
      signal_count: confidence.signal_count,
    },
    keys_written: [
      `tech_stack_${companyNumber}`,
      `website_intelligence_${companyNumber}`,
      `marketing_intelligence_${companyNumber}`,
      `hiring_signals_${companyNumber}`,
      `reputation_${companyNumber}`,
    ],
    attempts: rootAttempts,
  };
}
