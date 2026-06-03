import { getSetting, getWebsiteResolution, upsertWebsiteResolution } from "./db.js";

const DEFAULT_TIMEOUT_MS = Math.max(
  500,
  Math.min(Number.parseInt(process.env.WEBSITE_RESOLUTION_TIMEOUT_MS || "1800", 10) || 1800, 12000)
);

const DEFAULT_MAX_CANDIDATES = Math.max(
  1,
  Math.min(Number.parseInt(process.env.WEBSITE_RESOLUTION_MAX_CANDIDATES || "4", 10) || 4, 12)
);

const DEFAULT_ENABLE_NAME_GUESSES = String(process.env.WEBSITE_RESOLUTION_ENABLE_NAME_GUESSES || "true").trim().toLowerCase() !== "false";

const MANUAL_ALLOWED_STATUSES = new Set([
  "verified",
  "probable",
  "unresolved",
  "no_site_confirmed",
]);

const STOPWORDS = new Set([
  "ltd",
  "limited",
  "plc",
  "llp",
  "inc",
  "corp",
  "company",
  "co",
  "group",
  "holdings",
  "holding",
  "uk",
  "the",
  "name",
  "lookup",
  "needed",
]);

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const token = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(token)) return true;
  if (["false", "0", "no", "n", "off"].includes(token)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeCompanyNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
  if (!stripped) return null;
  if (/^\d{1,8}$/.test(stripped)) return stripped.padStart(8, "0");
  if (/^[A-Z0-9]{2,12}$/.test(stripped)) return stripped;
  return null;
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
    const prefixed = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(prefixed);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function toOrigin(value) {
  const normalized = normalizeWebsiteUrl(value);
  if (!normalized) return null;
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

function isPlaceholderCompanyName(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return true;
  if (token === "name lookup needed") return true;
  if (/^company\s+[a-z0-9-]+$/i.test(token)) return true;
  return false;
}

function getCompanyTokens(companyName) {
  if (isPlaceholderCompanyName(companyName)) return [];

  return String(companyName || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function guessCompanyDomains(companyName) {
  const tokens = getCompanyTokens(companyName);
  if (tokens.length === 0) return [];

  const slug = tokens.join("");
  if (slug.length < 4) return [];

  return [`${slug}.co.uk`, `${slug}.com`];
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? String(match[1]).trim() : "";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addDaysIso(baseIso, days) {
  const base = Number.isFinite(Date.parse(baseIso)) ? new Date(baseIso) : new Date();
  const next = new Date(base.getTime() + (days * 86400000));
  return next.toISOString();
}

function nextRetryAtForStatus(status, checkedAtIso) {
  if (status === "verified") return addDaysIso(checkedAtIso, 30);
  if (status === "probable") return addDaysIso(checkedAtIso, 14);
  if (status === "no_site_confirmed") return addDaysIso(checkedAtIso, 30);
  return addDaysIso(checkedAtIso, 3);
}

function manualNextRetryAtForStatus(status, checkedAtIso) {
  if (status === "verified") return addDaysIso(checkedAtIso, 90);
  if (status === "probable") return addDaysIso(checkedAtIso, 45);
  if (status === "no_site_confirmed") return addDaysIso(checkedAtIso, 180);
  return addDaysIso(checkedAtIso, 14);
}

function retryDue(cacheEntry) {
  const nextRetryAt = String(cacheEntry?.next_retry_at || "").trim();
  if (!nextRetryAt) return true;
  const nextTs = Date.parse(nextRetryAt);
  if (!Number.isFinite(nextTs)) return true;
  return Date.now() >= nextTs;
}

function collectHistoricalHints(companyNumber) {
  const hints = [];
  const seen = new Set();

  const pushHint = (value, source, usedGuess = false, baseConfidence = 0.55) => {
    const origin = toOrigin(value);
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    hints.push({ origin, source, used_guess: usedGuess === true, base_confidence: baseConfidence });
  };

  const pushDomainHint = (domain, source, usedGuess = false, baseConfidence = 0.5) => {
    const normalized = normalizeDomain(domain);
    if (!normalized) return;
    pushHint(`https://${normalized}`, source, usedGuess, baseConfidence);
    pushHint(`https://www.${normalized}`, source, usedGuess, baseConfidence - 0.03);
  };

  const envelopeKeys = [
    `tech_stack_${companyNumber}`,
    `website_intelligence_${companyNumber}`,
    `marketing_intelligence_${companyNumber}`,
    `hiring_signals_${companyNumber}`,
    `reputation_${companyNumber}`,
  ];

  for (const key of envelopeKeys) {
    const payload = getSetting(key, null);
    if (!payload || typeof payload !== "object") continue;
    pushHint(payload.website_url, `${key}_website`, false, 0.72);
    pushDomainHint(payload.domain, `${key}_domain`, false, 0.68);
  }

  const externalSync = getSetting(`external_signal_sync_${companyNumber}`, null);
  const connectors = Array.isArray(externalSync?.connectors) ? externalSync.connectors : [];
  for (const connector of connectors) {
    pushHint(connector?.request_url, `connector_${connector?.id || "unknown"}`, false, 0.56);
    for (const url of Array.isArray(connector?.attempted_urls) ? connector.attempted_urls : []) {
      pushHint(url, `connector_${connector?.id || "unknown"}_attempt`, false, 0.48);
    }
  }

  return hints;
}

function buildCandidates({
  companyNumber,
  companyName,
  companyWebsite,
  companyDomain,
  cacheEntry,
  enableNameGuesses,
}) {
  const byOrigin = new Map();

  const pushCandidate = (value, source, usedGuess = false, baseConfidence = 0.5) => {
    const origin = toOrigin(value);
    if (!origin) return;

    const existing = byOrigin.get(origin);
    if (existing) {
      existing.base_confidence = Math.max(existing.base_confidence, baseConfidence);
      if (!existing.used_guess && usedGuess) return;
      if (existing.used_guess && !usedGuess) {
        existing.used_guess = false;
        existing.source = source;
      }
      return;
    }

    byOrigin.set(origin, {
      origin,
      source,
      used_guess: usedGuess === true,
      base_confidence: clamp(baseConfidence, 0, 1),
    });
  };

  const pushDomainCandidate = (value, source, usedGuess = false, baseConfidence = 0.48) => {
    const domain = normalizeDomain(value);
    if (!domain) return;
    pushCandidate(`https://${domain}`, source, usedGuess, baseConfidence);
    pushCandidate(`https://www.${domain}`, source, usedGuess, baseConfidence - 0.03);
  };

  pushCandidate(companyWebsite, "input_website", false, 0.96);
  pushDomainCandidate(companyDomain, "input_domain", false, 0.9);

  if (cacheEntry?.website_url) pushCandidate(cacheEntry.website_url, "cache_website", false, 0.88);
  if (cacheEntry?.domain) pushDomainCandidate(cacheEntry.domain, "cache_domain", false, 0.83);

  const historical = collectHistoricalHints(companyNumber);
  for (const hint of historical) {
    pushCandidate(hint.origin, hint.source, hint.used_guess, hint.base_confidence);
  }

  if (enableNameGuesses) {
    for (const domain of guessCompanyDomains(companyName)) {
      pushDomainCandidate(domain, "name_guess", true, 0.44);
    }
  }

  return [...byOrigin.values()];
}

function classifyReachableCandidate(candidate, domain, pageTitle, pageText, companyName) {
  const tokens = getCompanyTokens(companyName);
  const haystack = `${String(pageTitle || "")} ${String(pageText || "")}`.toLowerCase();
  const domainLower = String(domain || "").toLowerCase();

  const domainMatches = tokens.filter((token) => domainLower.includes(token)).length;
  const textMatches = tokens.filter((token) => haystack.includes(token)).length;

  let confidence = Number(candidate.base_confidence || 0.4);
  confidence += domainMatches > 0 ? 0.2 : 0;
  confidence += textMatches > 0 ? 0.15 : 0;
  confidence += textMatches > 1 ? 0.08 : 0;
  confidence = clamp(confidence, 0, 1);

  const acceptableNonGuess = !candidate.used_guess && (domainMatches > 0 || textMatches > 0 || tokens.length === 0);
  // Name guesses require stronger textual corroboration to reduce false-positive website matches.
  const acceptableGuess = candidate.used_guess && domainMatches > 0 && textMatches > 1;

  const classification = acceptableNonGuess
    ? "verified"
    : acceptableGuess
      ? "probable"
      : "weak";

  return {
    confidence_score: confidence,
    domain_matches: domainMatches,
    text_matches: textMatches,
    classification,
  };
}

async function probeCandidate(candidate, companyName, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(candidate.origin, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "onemonetry-website-resolver/1.0",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        url: candidate.origin,
        status: response.status,
        error: `http_${response.status}`,
        source: candidate.source,
        used_guess: candidate.used_guess,
        duration_ms: Math.max(0, Date.now() - startedAt),
      };
    }

    const body = await response.text();
    const finalUrl = String(response.url || candidate.origin);
    const domain = normalizeDomain(finalUrl);
    const pageTitle = extractTitle(body);
    const pageText = htmlToText(body).slice(0, 70000);
    const classification = classifyReachableCandidate(candidate, domain, pageTitle, pageText, companyName);

    return {
      ok: true,
      url: finalUrl,
      domain,
      source: candidate.source,
      used_guess: candidate.used_guess,
      status: response.status,
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...classification,
    };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return {
      ok: false,
      url: candidate.origin,
      status: null,
      error: timedOut ? "request_timeout" : (err?.message || "request_failed"),
      source: candidate.source,
      used_guess: candidate.used_guess,
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
  } finally {
    clearTimeout(timer);
  }
}

function toPublicResolutionResult(entry, extras = {}) {
  return {
    company_number: entry.company_number || null,
    company_name: entry.company_name || null,
    status: entry.status || "unresolved",
    website_url: entry.website_url || null,
    domain: entry.domain || null,
    confidence_score: Number(entry.confidence_score || 0),
    source: entry.source || null,
    checked_at: entry.checked_at || null,
    next_retry_at: entry.next_retry_at || null,
    cache_hit: extras.cache_hit === true,
    updated: extras.updated === true,
    attempts: Array.isArray(extras.attempts) ? extras.attempts : [],
  };
}

export function getWebsiteResolverRuntimeConfig() {
  return {
    timeout_ms: DEFAULT_TIMEOUT_MS,
    max_candidates: DEFAULT_MAX_CANDIDATES,
    enable_name_guesses: DEFAULT_ENABLE_NAME_GUESSES,
  };
}

export function setManualWebsiteResolution(input = {}) {
  const companyNumber = normalizeCompanyNumber(input.companyNumber || input.company_number || input.number);
  if (!companyNumber) {
    return {
      status: "invalid_input",
      updated: false,
      error: "company_number is required",
    };
  }

  const status = String(input.status || "").trim().toLowerCase();
  if (!MANUAL_ALLOWED_STATUSES.has(status)) {
    return {
      status: "invalid_input",
      updated: false,
      error: "manual status must be one of verified|probable|unresolved|no_site_confirmed",
    };
  }

  const companyName = String(input.companyName || input.company_name || "").trim() || null;
  const checkedAt = new Date().toISOString();
  const normalizedWebsite = normalizeWebsiteUrl(
    input.companyWebsite || input.company_website || input.website || input.website_url
  );
  const normalizedDomain = normalizeDomain(
    input.companyDomain || input.company_domain || input.domain || normalizedWebsite
  );

  if (["verified", "probable"].includes(status) && !normalizedWebsite && !normalizedDomain) {
    return {
      status: "invalid_input",
      updated: false,
      error: "verified/probable manual status requires website_url or domain",
    };
  }

  const websiteUrl = status === "no_site_confirmed" || status === "unresolved"
    ? null
    : normalizedWebsite;
  const domain = status === "no_site_confirmed" || status === "unresolved"
    ? null
    : normalizedDomain;

  const defaultConfidence =
    status === "verified"
      ? 1
      : status === "probable"
        ? 0.75
        : 0;
  const confidenceScore = clamp(
    Number(input.confidenceScore ?? input.confidence_score ?? defaultConfidence) || 0,
    0,
    1
  );

  const note = String(input.note || "").trim() || null;
  const nextRetryAt = String(input.nextRetryAt || input.next_retry_at || "").trim()
    || manualNextRetryAtForStatus(status, checkedAt);

  const persisted = upsertWebsiteResolution({
    company_number: companyNumber,
    status,
    website_url: websiteUrl,
    domain,
    confidence_score: confidenceScore,
    source: String(input.source || "manual_override").trim() || "manual_override",
    checked_at: checkedAt,
    next_retry_at: nextRetryAt,
    details: {
      manual_override: true,
      note,
    },
  });

  return toPublicResolutionResult(
    {
      ...(persisted || {}),
      company_number: companyNumber,
      company_name: companyName,
    },
    {
      cache_hit: false,
      updated: true,
      attempts: [],
    }
  );
}

export async function resolveCompanyWebsite(input = {}) {
  const companyNumber = normalizeCompanyNumber(input.companyNumber || input.company_number || input.number);
  if (!companyNumber) {
    return {
      status: "invalid_input",
      updated: false,
      error: "company_number is required",
    };
  }

  const companyName = String(input.companyName || input.company_name || "").trim();
  const companyWebsite = String(input.companyWebsite || input.company_website || input.website || "").trim() || null;
  const companyDomain = String(input.companyDomain || input.company_domain || input.domain || "").trim() || null;

  const force = input.force === true;
  const timeoutMs = parsePositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 12000);
  const maxCandidates = parsePositiveInt(input.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 12);
  const enableNameGuesses = parseBoolean(input.enableNameGuesses, DEFAULT_ENABLE_NAME_GUESSES);

  const cached = getWebsiteResolution(companyNumber, null);
  if (!force && cached && !retryDue(cached)) {
    return toPublicResolutionResult(
      {
        ...cached,
        company_number: companyNumber,
        company_name: companyName || null,
      },
      { cache_hit: true, updated: false, attempts: [] }
    );
  }

  const candidates = buildCandidates({
    companyNumber,
    companyName,
    companyWebsite,
    companyDomain,
    cacheEntry: cached,
    enableNameGuesses,
  }).slice(0, maxCandidates);

  const checkedAt = new Date().toISOString();

  if (candidates.length === 0) {
    const persisted = upsertWebsiteResolution({
      company_number: companyNumber,
      status: "no_site_confirmed",
      website_url: null,
      domain: null,
      confidence_score: 0,
      source: "resolver_no_candidates",
      checked_at: checkedAt,
      next_retry_at: nextRetryAtForStatus("no_site_confirmed", checkedAt),
      details: {
        reason: "no_site_hints",
        enable_name_guesses: enableNameGuesses,
      },
    });

    return toPublicResolutionResult(
      {
        ...(persisted || {}),
        company_number: companyNumber,
        company_name: companyName || null,
      },
      { cache_hit: false, updated: true, attempts: [] }
    );
  }

  let best = null;
  const attempts = [];

  for (const candidate of candidates) {
    const attempt = await probeCandidate(candidate, companyName, timeoutMs);
    attempts.push(attempt);

    if (!attempt.ok) continue;
    if (attempt.classification === "weak") continue;

    if (!best || Number(attempt.confidence_score || 0) > Number(best.confidence_score || 0)) {
      best = attempt;
    }

    if (best && best.classification === "verified" && best.confidence_score >= 0.92) {
      break;
    }
  }

  if (!best) {
    const persisted = upsertWebsiteResolution({
      company_number: companyNumber,
      status: "unresolved",
      website_url: null,
      domain: null,
      confidence_score: 0,
      source: "resolver_unreachable",
      checked_at: checkedAt,
      next_retry_at: nextRetryAtForStatus("unresolved", checkedAt),
      details: {
        attempted: attempts.slice(0, 12),
      },
    });

    return {
      ...toPublicResolutionResult(
        {
          ...(persisted || {}),
          company_number: companyNumber,
          company_name: companyName || null,
        },
        { cache_hit: false, updated: true, attempts }
      ),
      error: "No reachable verified/probable website candidate",
    };
  }

  const finalStatus = best.classification === "verified" ? "verified" : "probable";
  const persisted = upsertWebsiteResolution({
    company_number: companyNumber,
    status: finalStatus,
    website_url: best.url,
    domain: best.domain,
    confidence_score: best.confidence_score,
    source: best.source,
    checked_at: checkedAt,
    next_retry_at: nextRetryAtForStatus(finalStatus, checkedAt),
    details: {
      selected: {
        source: best.source,
        used_guess: best.used_guess === true,
        status: best.status,
        confidence_score: best.confidence_score,
        domain_matches: best.domain_matches,
        text_matches: best.text_matches,
      },
      attempted: attempts.slice(0, 12),
    },
  });

  return toPublicResolutionResult(
    {
      ...(persisted || {}),
      company_number: companyNumber,
      company_name: companyName || null,
    },
    {
      cache_hit: false,
      updated: true,
      attempts,
    }
  );
}
