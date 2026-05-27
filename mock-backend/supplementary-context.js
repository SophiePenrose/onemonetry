function stripHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    items.push({ title, link, published_at: pubDate || null });
  }
  return items;
}

async function fetchNewsSignals(companyName) {
  if (!companyName) return [];
  if ((process.env.ENABLE_NEWS_LOOKUP || "true").toLowerCase() === "false") return [];

  const q = encodeURIComponent(`${companyName} UK company`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": "onemonetry/1.0" } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, 5);
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
      lusha_status: process.env.LUSHA_API_KEY ? "configured" : "not_configured",
      note: process.env.LUSHA_API_KEY
        ? "Lusha key detected; enrichment can be added in downstream pipeline."
        : "Set LUSHA_API_KEY to enable direct contact enrichment.",
    };
  });
}

export async function getSupplementaryContext({ companyName, analysis, filingText }) {
  const news = await fetchNewsSignals(companyName);
  const mnaSignals = deriveMnaSignals(analysis, filingText);
  const peopleTargets = buildPeopleTargets(companyName, analysis?.key_people || []);

  return {
    generated_at: new Date().toISOString(),
    integrations: {
      news_lookup: {
        configured: (process.env.ENABLE_NEWS_LOOKUP || "true").toLowerCase() !== "false",
        source: "Google News RSS",
        signals_found: news.length,
      },
      linkedin_research: {
        configured: true,
        signals_found: peopleTargets.length,
      },
      lusha: {
        configured: !!process.env.LUSHA_API_KEY,
        signals_found: 0,
      },
    },
    news_signals: news,
    mna_signals: mnaSignals,
    people_targets: peopleTargets,
  };
}
