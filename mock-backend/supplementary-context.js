function stripHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasConfiguredSecret(value) {
  const key = String(value || "").trim();
  if (!key) return false;
  const lower = key.toLowerCase();
  const looksPlaceholder = lower.startsWith("replace_")
    || lower.startsWith("replace-")
    || lower.startsWith("replace")
    || lower.includes("replace_with")
    || lower.includes("replacewith")
    || lower.includes("your_api_key")
    || lower.includes("optional_")
    || lower.includes("example")
    || lower === "changeme"
    || lower === "change_me";
  return !looksPlaceholder;
}

const NEWS_API_KEY = hasConfiguredSecret(process.env.NEWS_API_KEY)
  ? String(process.env.NEWS_API_KEY || "").trim()
  : null;
const LUSHA_API_KEY = hasConfiguredSecret(process.env.LUSHA_API_KEY)
  ? String(process.env.LUSHA_API_KEY || "").trim()
  : null;
const LUSHA_CONFIGURED = !!LUSHA_API_KEY;
const LUSHA_BASE_URL = String(process.env.LUSHA_BASE_URL || "https://api.lusha.com").replace(/\/+$/, "");
const LUSHA_TIMEOUT_MS = Number.parseInt(process.env.LUSHA_TIMEOUT_MS || "5000", 10);

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

function extractDomainFromUrl(value) {
  return normalizeDomain(value);
}

function guessCompanyDomain(companyName) {
  const slug = String(companyName || "")
    .toLowerCase()
    .replace(/\b(limited|ltd|plc|llp|inc|corp|group|holdings|holding|company|co|the)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, "")
    .trim();
  return slug.length >= 4 ? `${slug}.co.uk` : null;
}

function getCompanyTokens(companyName) {
  const stopwords = new Set(["ltd", "limited", "plc", "llp", "uk", "group", "holdings", "holding", "company", "co"]);
  return String(companyName || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !stopwords.has(t));
}

function filterSignalsByCompanyName(signals, companyName, companyWebsite, companyDomain) {
  const tokens = getCompanyTokens(companyName);
  const knownDomains = [
    normalizeDomain(companyDomain),
    normalizeDomain(companyWebsite),
    guessCompanyDomain(companyName),
  ].filter(Boolean);

  if (tokens.length === 0 && knownDomains.length === 0) return signals;

  const filtered = (signals || []).filter((item) => {
    const haystack = `${item?.title || ""} ${item?.signal || ""} ${item?.source_name || ""}`.toLowerCase();
    const sourceDomain = normalizeDomain(item?.source_domain || extractDomainFromUrl(item?.link));
    const tokenMatch = tokens.some((token) => haystack.includes(token));
    const domainMatch = knownDomains.some((domain) => haystack.includes(domain) || (sourceDomain && sourceDomain.includes(domain)));
    return tokenMatch || domainMatch;
  });

  return filtered.length > 0 ? filtered : signals;
}

function parseRssItems(xml, maxItems = 6) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) !== null && items.length < maxItems) {
    const chunk = match[1];
    const title = stripHtml((chunk.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = stripHtml((chunk.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const pubDate = stripHtml((chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (!title || !link) continue;
    items.push({
      title,
      signal: title,
      relevance: "Recent public momentum signal from Google News",
      link,
      published_at: pubDate || null,
      source: "google_rss",
      source_name: "Google News",
      source_domain: extractDomainFromUrl(link),
    });
  }
  return items;
}

async function fetchNewsApiSignals({ companyName, companyWebsite, companyDomain }, maxItems = 5) {
  if (!NEWS_API_KEY || !companyName) return [];

  const domainHint = normalizeDomain(companyDomain) || normalizeDomain(companyWebsite) || guessCompanyDomain(companyName);
  const q = encodeURIComponent(`"${companyName}"${domainHint ? ` OR "${domainHint}"` : ""} AND (acquisition OR merger OR growth OR expansion OR partnership OR funding OR launch)`);
  const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=${maxItems}`;

  try {
    const res = await fetch(url, {
      headers: {
        "X-Api-Key": NEWS_API_KEY,
        "User-Agent": "onemonetry/1.0",
      },
    });
    if (!res.ok) return [];

    const data = await res.json().catch(() => ({}));
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    return articles
      .filter((a) => a?.title && a?.url)
      .slice(0, maxItems)
      .map((a) => ({
        title: stripHtml(a.title),
        signal: stripHtml(a.title),
        relevance: "Recent public momentum signal from premium news feed",
        link: String(a.url),
        published_at: a.publishedAt || null,
        source: "newsapi",
        source_name: stripHtml(a?.source?.name || ""),
        source_domain: extractDomainFromUrl(a.url),
      }));
  } catch {
    return [];
  }
}

async function fetchNewsSignals({ companyName, companyWebsite, companyDomain }) {
  if (!companyName) return [];
  if ((process.env.ENABLE_NEWS_LOOKUP || "true").toLowerCase() === "false") return [];

  const premiumSignals = await fetchNewsApiSignals({ companyName, companyWebsite, companyDomain }, 5);
  if (premiumSignals.length > 0) return filterSignalsByCompanyName(premiumSignals, companyName, companyWebsite, companyDomain);

  const q = encodeURIComponent(`${companyName} UK company`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": "onemonetry/1.0" } });
    if (!res.ok) return [];
    const xml = await res.text();
    return filterSignalsByCompanyName(parseRssItems(xml, 5), companyName, companyWebsite, companyDomain);
  } catch {
    return [];
  }
}

function deriveMnaSignals(analysis, filingText) {
  const themeSignals = (analysis?.themes || [])
    .filter((t) => /acquisition|merger|group|integration|subsidiary/i.test(`${t.theme || ""} ${t.evidence || ""}`))
    .slice(0, 5)
    .map((t) => ({ signal: t.theme || "M&A/Group signal", evidence: t.evidence || null }));

  const text = String(filingText || "");
  const lower = text.toLowerCase();
  const keywordHits = ["acquisition", "acquired", "merger", "subsidiary", "group", "integration"];
  const textSignals = [];

  for (const keyword of keywordHits) {
    const idx = lower.indexOf(keyword);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 90);
    const end = Math.min(text.length, idx + keyword.length + 140);
    textSignals.push({
      signal: `Keyword match: ${keyword}`,
      evidence: text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 260),
    });
    if (textSignals.length >= 4) break;
  }

  return [...themeSignals, ...textSignals].slice(0, 8);
}

function buildPeopleTargets(companyName, keyPeople) {
  return (keyPeople || []).slice(0, 10).map((person) => {
    const name = person.name || "";
    const role = person.role || "Unknown";
    const linkedInQuery = `${name} ${companyName || ""} ${role}`.trim();
    return {
      name,
      role,
      linkedin_search_url: name
        ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(linkedInQuery)}`
        : null,
      lusha_status: LUSHA_CONFIGURED ? "configured" : "not_configured",
      note: LUSHA_CONFIGURED
        ? "Lusha key detected; direct contact lookup will run for top stakeholders."
        : "Set LUSHA_API_KEY to enable direct contact enrichment.",
    };
  });
}

function normalizeNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toStrings(value, candidateKeys = []) {
  const out = [];

  const push = (entry) => {
    const next = String(entry || "").trim();
    if (!next) return;
    out.push(next);
  };

  if (typeof value === "string" || typeof value === "number") {
    push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" || typeof item === "number") {
        push(item);
      } else if (item && typeof item === "object") {
        for (const key of candidateKeys) {
          if (item[key]) push(item[key]);
        }
      }
    }
  } else if (value && typeof value === "object") {
    for (const key of candidateKeys) {
      if (value[key]) push(value[key]);
    }
  }

  return [...new Set(out)];
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "");
  return /\d{6,}/.test(compact) ? compact : null;
}

function parseLushaContactPayload(payload) {
  const roots = [
    payload,
    payload?.data,
    payload?.person,
    payload?.contact,
    payload?.result,
    Array.isArray(payload?.results) ? payload.results[0] : null,
    Array.isArray(payload?.contacts) ? payload.contacts[0] : null,
    Array.isArray(payload?.people) ? payload.people[0] : null,
  ].filter(Boolean);

  for (const root of roots) {
    const emails = toStrings(
      root?.emails || root?.emailAddresses || root?.email_addresses || root?.email,
      ["email", "address", "value"]
    ).filter((e) => /@/.test(e));

    const phones = toStrings(
      root?.phones || root?.phoneNumbers || root?.phone_numbers || root?.phone,
      ["phone", "number", "value", "internationalNumber", "international_number"]
    )
      .map((p) => normalizePhone(p))
      .filter(Boolean);

    const linkedinProfile = String(root?.linkedinUrl || root?.linkedin_url || root?.linkedinProfile || "").trim() || null;
    const confidence = root?.confidence || root?.match_confidence || root?.score || null;

    if (emails.length > 0 || phones.length > 0 || linkedinProfile) {
      return {
        email: emails[0] || null,
        phone: phones[0] || null,
        linkedin_profile_url: linkedinProfile,
        confidence: typeof confidence === "number" ? confidence : null,
      };
    }
  }

  return null;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(800, timeoutMs));
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: null, json: null };
  } finally {
    clearTimeout(timer);
  }
}

function buildLushaRequestCandidates({ name, role, companyName }) {
  const qs = new URLSearchParams();
  qs.set("name", name);
  if (companyName) qs.set("company", companyName);
  if (role) qs.set("job_title", role);

  return [
    { method: "GET", url: `${LUSHA_BASE_URL}/prospecting/person?${qs.toString()}` },
    { method: "GET", url: `${LUSHA_BASE_URL}/person?${qs.toString()}` },
    {
      method: "POST",
      url: `${LUSHA_BASE_URL}/prospecting/person`,
      body: {
        name,
        company: companyName || undefined,
        job_title: role || undefined,
      },
    },
  ];
}

async function fetchLushaContact({ name, role, companyName }) {
  if (!LUSHA_CONFIGURED || !name) return { status: LUSHA_CONFIGURED ? "missing_name" : "not_configured" };

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${LUSHA_API_KEY}`,
    "x-api-key": LUSHA_API_KEY,
    api_key: LUSHA_API_KEY,
    "User-Agent": "onemonetry/1.0",
  };

  const candidates = buildLushaRequestCandidates({ name, role, companyName });
  let lastStatus = null;

  for (const request of candidates) {
    const response = await fetchJsonWithTimeout(request.url, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
    }, Number.isFinite(LUSHA_TIMEOUT_MS) ? LUSHA_TIMEOUT_MS : 5000);

    lastStatus = response.status;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { status: "auth_failed" };
      if (response.status === 429) return { status: "rate_limited" };
      continue;
    }

    const parsed = parseLushaContactPayload(response.json || {});
    if (parsed) return { status: "enriched", ...parsed };
    return { status: "no_match" };
  }

  return { status: lastStatus ? `http_${lastStatus}` : "no_match" };
}

async function enrichPeopleTargetsWithLusha(peopleTargets, companyName) {
  if (!Array.isArray(peopleTargets) || peopleTargets.length === 0) {
    return { peopleTargets: [], signalsFound: 0, lookupsAttempted: 0 };
  }
  if (!LUSHA_CONFIGURED) {
    return { peopleTargets, signalsFound: 0, lookupsAttempted: 0 };
  }

  const configuredLimit = Number.parseInt(process.env.LUSHA_ENRICHMENT_LIMIT || "4", 10);
  const lookupLimit = Number.isFinite(configuredLimit)
    ? Math.max(1, Math.min(configuredLimit, peopleTargets.length))
    : Math.min(4, peopleTargets.length);

  const cache = new Map();
  const runLookup = async (person) => {
    const key = `${normalizeNameKey(person?.name)}|${normalizeNameKey(companyName)}`;
    if (cache.has(key)) return cache.get(key);
    const promise = fetchLushaContact({ name: person?.name, role: person?.role, companyName });
    cache.set(key, promise);
    return promise;
  };

  const lookupResults = await Promise.all(
    peopleTargets.slice(0, lookupLimit).map((person) => runLookup(person))
  );

  let signalsFound = 0;
  const enrichedPeople = peopleTargets.map((person, idx) => {
    if (idx >= lookupLimit) {
      return {
        ...person,
        lusha_status: person.lusha_status === "configured" ? "configured_not_queried" : person.lusha_status,
        note: person.lusha_status === "configured"
          ? `Lusha lookup capped at ${lookupLimit} targets per company.`
          : person.note,
      };
    }

    const lookup = lookupResults[idx] || { status: "no_match" };
    const hasContact = !!(lookup.email || lookup.phone);
    if (hasContact) signalsFound += 1;

    return {
      ...person,
      contact_email: lookup.email || null,
      contact_phone: lookup.phone || null,
      linkedin_profile_url: lookup.linkedin_profile_url || null,
      lusha_confidence: lookup.confidence ?? null,
      lusha_status: lookup.status || person.lusha_status,
      note: lookup.status === "enriched"
        ? "Direct Lusha contact enrichment matched this stakeholder."
        : lookup.status === "no_match"
          ? "Lusha queried but no direct person match found."
          : person.note,
    };
  });

  return {
    peopleTargets: enrichedPeople,
    signalsFound,
    lookupsAttempted: lookupLimit,
  };
}

function buildValueNuggets(analysis, newsSignals, mnaSignals) {
  const nuggets = [];
  const seen = new Set();

  for (const item of (newsSignals || []).slice(0, 4)) {
    const nugget = String(item?.title || item?.signal || "").trim();
    if (!nugget) continue;
    const key = `news:${nugget.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nuggets.push({
      type: "news",
      nugget,
      source: item?.link || item?.source || "news",
      relevance: item?.relevance || "Recent external momentum signal",
    });
  }

  for (const item of (mnaSignals || []).slice(0, 3)) {
    const nugget = String(item?.signal || "").trim();
    if (!nugget) continue;
    const key = `mna:${nugget.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nuggets.push({
      type: "mna",
      nugget,
      source: "filing_inference",
      relevance: String(item?.evidence || "M&A or ownership signal inferred from filing context").slice(0, 260),
    });
  }

  for (const opp of (analysis?.opportunities || []).slice(0, 2)) {
    const product = String(opp?.product || "").trim();
    const rationale = String(opp?.rationale || "").trim();
    if (!product || !rationale) continue;
    const nugget = `${product}: ${rationale}`;
    const key = `opp:${nugget.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nuggets.push({
      type: "opportunity",
      nugget,
      source: "analysis",
      relevance: "Reusable value nugget for future follow-up sequencing",
    });
  }

  return nuggets.slice(0, 10);
}

export async function getSupplementaryContext({ companyName, companyWebsite, companyDomain, analysis, filingText }) {
  const news = await fetchNewsSignals({ companyName, companyWebsite, companyDomain });
  const mnaSignals = deriveMnaSignals(analysis, filingText);
  const basePeopleTargets = buildPeopleTargets(companyName, analysis?.key_people || []);
  const lushaEnrichment = await enrichPeopleTargetsWithLusha(basePeopleTargets, companyName);
  const peopleTargets = lushaEnrichment.peopleTargets;
  const valueNuggets = buildValueNuggets(analysis, news, mnaSignals);
  const newsSource = news[0]?.source === "newsapi" ? "NewsAPI" : "Google News RSS";
  const enrichmentStatus = {
    linkedin_search: true,
    lusha: LUSHA_CONFIGURED,
    news_api: !!NEWS_API_KEY,
  };

  return {
    generated_at: new Date().toISOString(),
    integrations: {
      news_lookup: {
        configured: (process.env.ENABLE_NEWS_LOOKUP || "true").toLowerCase() !== "false",
        source: newsSource,
        signals_found: news.length,
      },
      news_api: {
        configured: !!NEWS_API_KEY,
        source: "NewsAPI",
      },
      linkedin_research: {
        configured: true,
        signals_found: peopleTargets.length,
      },
      lusha: {
        configured: LUSHA_CONFIGURED,
        signals_found: lushaEnrichment.signalsFound,
        lookups_attempted: lushaEnrichment.lookupsAttempted,
      },
    },
    news_signals: news,
    mna_signals: mnaSignals,
    people_targets: peopleTargets,
    people_research: peopleTargets,
    enrichment_status: enrichmentStatus,
    value_nuggets: valueNuggets,
  };
}
