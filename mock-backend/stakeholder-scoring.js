/**
 * Stakeholder Confidence Scoring — 5-Dimension Framework
 * 
 * Scores: Decision Authority (0-30) + Relevance (0-25) + Reachability (0-20) 
 *         + Timing (0-15) + Influence Network (0-10) = max 100
 * 
 * Final score multiplied by data_confidence to prevent weak enrichment
 * from producing false confidence.
 */

import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS active_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    name TEXT NOT NULL,
    company_id TEXT NOT NULL,
    sequence_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(email, company_id, status)
  );
  CREATE INDEX IF NOT EXISTS idx_active_contacts_email ON active_contacts(email);
  CREATE INDEX IF NOT EXISTS idx_active_contacts_name ON active_contacts(name, company_id);
`);

const CORPORATE_DIRECTOR_PATTERNS = [
  /limited$/i, /ltd$/i, /plc$/i, /llp$/i, /inc$/i, /corp$/i,
  /holdings/i, /nominees/i, /trustees/i, /secretary/i,
  /services\s*$/i, /management\s*(limited|ltd)?$/i,
];

const ROLE_AUTHORITY = {
  "CEO": 28, "Chief Executive": 28, "Managing Director": 27, "MD": 27, "Founder": 26, "Co-Founder": 25,
  "CFO": 30, "Chief Financial Officer": 30,
  "Finance Director": 27, "FD": 27, "Group Finance Director": 28,
  "Head of Finance": 24, "VP Finance": 25, "SVP Finance": 26,
  "Head of Treasury": 25, "Group Treasurer": 25, "Treasurer": 23,
  "Financial Controller": 22, "FC": 22, "Group Financial Controller": 23,
  "Finance Manager": 18, "Treasury Manager": 20,
  "Head of Procurement": 20, "Procurement Director": 22,
  "Head of Payments": 23, "Payments Director": 24,
  "COO": 22, "Chief Operating Officer": 22, "Operations Director": 20,
  "CTO": 18, "Chief Technology Officer": 18,
  "Head of eCommerce": 20, "eCommerce Director": 22,
  "Director": 15, "Non-Executive Director": 10,
  "Company Secretary": 8, "Secretary": 8,
};

const MOTION_RELEVANCE = {
  "FX": ["CFO", "Finance Director", "Head of Treasury", "Treasurer", "Treasury Manager", "Financial Controller", "Group Treasurer"],
  "FX Forwards": ["CFO", "Head of Treasury", "Treasurer", "Treasury Manager", "Finance Director", "Group Treasurer"],
  "Cards": ["CFO", "Finance Director", "Financial Controller", "Head of Finance", "Finance Manager", "COO"],
  "Spend Management": ["CFO", "Finance Director", "Financial Controller", "Head of Procurement", "Procurement Director", "COO", "Finance Manager"],
  "Merchant Acquiring": ["CFO", "Head of Payments", "Head of eCommerce", "eCommerce Director", "CTO", "COO", "Finance Director"],
  "API Integrations": ["CTO", "Head of Payments", "Head of eCommerce", "CFO"],
  "Revolut Pay": ["Head of eCommerce", "Head of Payments", "CTO", "CFO"],
};

const CATEGORY_FAMILIAR_EMPLOYERS = [
  "wise", "transferwise", "stripe", "adyen", "pleo", "spendesk", "airwallex",
  "ebury", "worldpay", "revolut", "monzo", "starling", "tide", "currencycloud",
  "worldremit", "checkout.com", "mollie", "klarna", "square", "paypal",
];

const SOURCE_RELIABILITY = {
  crm: 1.0,
  manual: 0.9,
  email_verification: 0.85,
  linkedin: 0.8,
  website: 0.7,
  news: 0.65,
  job_posting: 0.65,
  companies_house_filing: 0.55,
};

const OPERATIONAL_BUYER_ROLES = [
  "Financial Controller",
  "Group Financial Controller",
  "Treasury Manager",
  "Finance Manager",
  "Head of Payments",
  "Head of Procurement",
];

export function scoreStakeholder(person, context = {}) {
  const { company, analysis, motion, filingDate } = context;
  const enrichment = {
    ...(context.enrichment || {}),
    email: person.email || context.enrichment?.email,
    linkedin_active: Boolean(person.linkedin) || context.enrichment?.linkedin_active,
    linkedin_verified: Boolean(person.linkedin) || context.enrichment?.linkedin_verified,
  };

  const result = {
    name: person.name,
    role: person.role || "Unknown",
    email: person.email || null,
    linkedin: person.linkedin || null,
    scores: { decision_authority: 0, relevance: 0, reachability: 0, timing: 0, influence_network: 0 },
    composite_score: 0,
    data_confidence: 0.5,
    final_score: 0,
    confidence_level: "low",
    buying_role: "unknown",
    flags: [],
    needs_verification: true,
    linkedin_search_url: null,
    email_guess: null,
    source: person.source || "companies_house_filing",
    source_confidence: SOURCE_RELIABILITY[person.source] || SOURCE_RELIABILITY.companies_house_filing,
    category_familiarity_score: 0,
    category_familiarity: [],
    source_date: filingDate || null,
  };

  if (!person.name) {
    result.flags.push("No name available");
    result.final_score = 0;
    return result;
  }

  const isCorporate = CORPORATE_DIRECTOR_PATTERNS.some((p) => p.test(person.name));
  if (isCorporate) {
    result.confidence_level = "excluded";
    result.flags.push("Corporate director entity — not a person");
    result.final_score = 0;
    return result;
  }

  // --- 1. Decision Authority (0-30) ---
  const roleNorm = (person.role || "").replace(/\(.*?\)/g, "").trim();
  let authorityScore = 10;
  for (const [roleKey, score] of Object.entries(ROLE_AUTHORITY)) {
    if (roleNorm.toLowerCase().includes(roleKey.toLowerCase())) {
      authorityScore = Math.max(authorityScore, score);
    }
  }

  const turnover = company?.turnover || 0;
  if (turnover > 200_000_000 && authorityScore < 20) {
    authorityScore = Math.max(authorityScore - 5, 5);
    result.flags.push("Large company — generic Director unlikely to be decision-maker");
  }
  if (turnover < 50_000_000 && roleNorm.toLowerCase().includes("director")) {
    authorityScore = Math.min(authorityScore + 5, 30);
    result.flags.push("Smaller mid-market — Director likely has broader authority");
  }

  result.scores.decision_authority = authorityScore;

  // --- 2. Relevance (0-25) ---
  let relevanceScore = 10;
  const primaryMotion = motion || analysis?.recommended_approach?.split(" ")[2] || "FX";
  const relevantRoles = MOTION_RELEVANCE[primaryMotion] || MOTION_RELEVANCE["FX"];

  if (relevantRoles.some((r) => roleNorm.toLowerCase().includes(r.toLowerCase()))) {
    relevanceScore = 22;
    result.flags.push(`Role directly relevant to ${primaryMotion}`);
  } else if (roleNorm.toLowerCase().includes("director") || roleNorm.toLowerCase().includes("ceo")) {
    relevanceScore = 15;
  }

  if (OPERATIONAL_BUYER_ROLES.some((role) => roleNorm.toLowerCase().includes(role.toLowerCase()))) {
    relevanceScore = Math.min(relevanceScore + 3, 25);
    result.flags.push("Operational buyer — likely to research vendors and influence recommendation");
  }

  result.scores.relevance = relevanceScore;

  // --- 3. Reachability (0-20) ---
  let reachabilityScore = 8;

  if (enrichment?.email_verified) {
    reachabilityScore += 10;
    result.flags.push("Email verified");
  } else if (enrichment?.email) {
    reachabilityScore += 6;
  }

  if (enrichment?.linkedin_active) {
    reachabilityScore += 4;
    result.flags.push("Active on LinkedIn");
  }

  if (enrichment?.website_listed) {
    reachabilityScore += 3;
  }

  result.scores.reachability = Math.min(reachabilityScore, 20);

  // --- 4. Timing (0-15) ---
  let timingScore = 5;

  if (person.role?.includes("Appointed") || enrichment?.is_new_hire) {
    const appointMatch = person.role?.match(/Appointed\s+(\d+\s+\w+\s+\d{4})/i);
    if (appointMatch) {
      const appointDate = new Date(appointMatch[1]);
      const daysSince = Math.floor((Date.now() - appointDate.getTime()) / 86400000);
      if (daysSince >= 14 && daysSince <= 90) {
        timingScore = 15;
        result.flags.push(`New hire — ${daysSince} days in role (optimal window)`);
      } else if (daysSince > 90 && daysSince <= 365) {
        timingScore = 10;
        result.flags.push("Appointed within last year");
      }
    } else {
      timingScore = 12;
      result.flags.push("Recent appointment detected");
    }
  }

  if (analysis?.themes?.some((t) => /acquisition|merger/i.test(t.theme))) {
    timingScore = Math.min(timingScore + 3, 15);
  }

  if (hasSignal(analysis, /hiring|headcount|new role|recruit/i)) {
    timingScore = Math.min(timingScore + 2, 15);
    result.flags.push("Hiring or org-change signal detected");
  }

  if (hasSignal(analysis, /private equity|PE-backed|investor|sponsor|portfolio/i) && /cfo|finance director|fd/i.test(roleNorm)) {
    timingScore = Math.min(timingScore + 3, 15);
    result.flags.push("PE-backed finance leader — optimisation and cost-control angle likely relevant");
  }

  result.scores.timing = timingScore;

  // --- 5. Influence Network (0-10) ---
  let influenceScore = 5;

  const allPeople = context.allPeople || [];
  const sameLastName = allPeople.filter((p) => {
    const thisLast = person.name.split(" ").pop()?.toLowerCase();
    const otherLast = p.name?.split(" ").pop()?.toLowerCase();
    return thisLast && otherLast && thisLast === otherLast && p.name !== person.name;
  });

  if (sameLastName.length > 0) {
    influenceScore += 3;
    result.flags.push("Family business signal — shared surname with other directors");
    result.buying_role = "decision_maker";
  }

  if (allPeople.length === 1) {
    influenceScore += 5;
    result.flags.push("Sole director — likely DM + Champion + User");
    result.buying_role = "decision_maker";
  } else if (authorityScore >= 25) {
    result.buying_role = "decision_maker";
  } else if (/procurement/i.test(roleNorm)) {
    result.buying_role = "gatekeeper";
  } else if (/controller|treasury manager|finance manager|payments/i.test(roleNorm)) {
    result.buying_role = "champion";
  } else if (authorityScore >= 18) {
    result.buying_role = "champion";
  } else {
    result.buying_role = "influencer";
  }

  result.scores.influence_network = Math.min(influenceScore, 10);

  // --- Data Confidence Multiplier ---
  let dataConfidence = result.source_confidence;

  if (filingDate) {
    const daysSinceFiling = Math.floor((Date.now() - new Date(filingDate).getTime()) / 86400000);
    if (daysSinceFiling < 90) dataConfidence += 0.25;
    else if (daysSinceFiling < 365) dataConfidence += 0.15;
    else dataConfidence += 0.05;
  }

  if (enrichment?.linkedin_verified) dataConfidence += 0.2;
  if (enrichment?.email_verified) dataConfidence += 0.15;
  if (person.name.split(/\s+/).every((p) => p.length > 1)) dataConfidence += 0.05;

  const categoryFamiliarity = detectCategoryFamiliarity(person);
  result.category_familiarity = categoryFamiliarity;
  result.category_familiarity_score = Math.min(categoryFamiliarity.length * 5, 15);
  if (result.category_familiarity_score > 0) {
    dataConfidence += 0.05;
    result.flags.push(`Category familiarity: ${categoryFamiliarity.join(", ")}`);
  }

  result.data_confidence = Math.min(dataConfidence, 1.0);

  // --- Composite ---
  const rawScore = result.scores.decision_authority + result.scores.relevance +
    result.scores.reachability + result.scores.timing + result.scores.influence_network;

  result.composite_score = rawScore;
  result.final_score = Math.round(rawScore * result.data_confidence);

  if (result.final_score >= 55) result.confidence_level = "high";
  else if (result.final_score >= 35) result.confidence_level = "medium";
  else result.confidence_level = "low";

  result.needs_verification = result.confidence_level !== "high" || !enrichment?.email_verified;

  // --- LinkedIn + Email ---
  const companyName = company?.name || "";
  const cleanName = person.name.replace(/\b[A-Z]\b\s*/g, "").trim() || person.name;
  result.linkedin_search_url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(cleanName + " " + companyName)}`;

  if (companyName) {
    const domain = guessDomain(companyName);
    if (domain) {
      const nameParts = person.name.trim().split(/\s+/);
      const firstName = nameParts[0].toLowerCase();
      const lastName = nameParts[nameParts.length - 1].toLowerCase();
      result.email_guess = {
        patterns: [
          `${firstName}.${lastName}@${domain}`,
          `${firstName[0]}${lastName}@${domain}`,
          `${firstName}@${domain}`,
        ],
        domain,
        confidence: "guess",
      };
    }
  }

  return result;
}

function guessDomain(companyName) {
  let name = companyName
    .replace(/\b(limited|ltd|plc|llp|inc|corp|group|holdings|company|accounts?|the)\b/gi, "")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (name.length < 3) return null;
  return name + ".co.uk";
}

function hasSignal(analysis, pattern) {
  const chunks = [
    analysis?.summary,
    analysis?.recommended_approach,
    ...(analysis?.themes || []).map((item) => `${item.theme || ""} ${item.evidence || ""}`),
    ...(analysis?.pain_indicators || []).map((item) => `${item.pain || ""} ${item.evidence || ""}`),
  ];
  return chunks.some((chunk) => pattern.test(chunk || ""));
}

function detectCategoryFamiliarity(person) {
  const haystack = [
    person.current_employer,
    person.previous_employer,
    person.previous_employers,
    person.experience,
    person.notes,
    person.linkedin_headline,
  ].flat().filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return [];
  return CATEGORY_FAMILIAR_EMPLOYERS.filter((employer) => haystack.includes(employer));
}

export function normalizeStakeholderName(name = "") {
  return name
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|sir|dame)\b/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 1)
    .join(" ")
    .trim();
}

function nameParts(name = "") {
  return normalizeStakeholderName(name).split(/\s+/).filter(Boolean);
}

export function areLikelySamePerson(a, b) {
  const aParts = nameParts(a?.name);
  const bParts = nameParts(b?.name);
  if (aParts.length === 0 || bParts.length === 0) return false;
  const aFirst = aParts[0];
  const bFirst = bParts[0];
  const aLast = aParts[aParts.length - 1];
  const bLast = bParts[bParts.length - 1];
  if (aLast !== bLast) return false;
  if (aFirst === bFirst) return true;
  return aFirst[0] === bFirst[0] && Math.min(aFirst.length, bFirst.length) <= 2;
}

function bestSource(sources = []) {
  return sources
    .filter(Boolean)
    .sort((a, b) => (SOURCE_RELIABILITY[b] || 0) - (SOURCE_RELIABILITY[a] || 0))[0] || "unknown";
}

export function mergeStakeholderIdentities(people = []) {
  const merged = [];
  for (const person of people) {
    if (!person?.name) continue;
    const match = merged.find((existing) => areLikelySamePerson(existing, person));
    if (!match) {
      merged.push({ ...person, sources: [person.source || "unknown"] });
      continue;
    }

    const sources = [...new Set([...(match.sources || []), person.source || "unknown"])];
    Object.assign(match, {
      ...match,
      ...person,
      name: match.name.length >= person.name.length ? match.name : person.name,
      role: person.role || match.role,
      email: person.email || match.email,
      linkedin: person.linkedin || match.linkedin,
      notes: [match.notes, person.notes].filter(Boolean).join(" | "),
      source: bestSource(sources),
      sources,
    });
  }
  return merged;
}

export function scoreAllStakeholders(keyPeople, context = {}) {
  if (!keyPeople || keyPeople.length === 0) return [];

  const resolvedPeople = mergeStakeholderIdentities(keyPeople);
  const enrichedContext = { ...context, allPeople: resolvedPeople };

  return resolvedPeople
    .map((person) => scoreStakeholder(person, enrichedContext))
    .filter((s) => s.confidence_level !== "excluded")
    .sort((a, b) => b.final_score - a.final_score);
}

export function buildMultiThreadingStrategy(stakeholders) {
  if (!stakeholders || stakeholders.length === 0) {
    return {
      mode: "manual_research",
      max_same_day: 0,
      steps: ["Find at least one finance, treasury, payments, or procurement stakeholder before outreach."],
    };
  }

  const decisionMaker = stakeholders.find((s) => s.buying_role === "decision_maker");
  const champion = stakeholders.find((s) => s.buying_role === "champion");
  const gatekeeper = stakeholders.find((s) => s.buying_role === "gatekeeper");

  if (stakeholders.length === 1) {
    return {
      mode: "single_thread",
      max_same_day: 1,
      primary: stakeholders[0],
      steps: ["Use one sequence; validate role and email before sending."],
    };
  }

  const steps = [];
  if (champion) steps.push(`Start with champion: ${champion.name}`);
  if (decisionMaker) steps.push(`Contact decision maker later with executive/commercial angle: ${decisionMaker.name}`);
  if (gatekeeper) steps.push(`Use procurement/gatekeeper angle only after commercial interest: ${gatekeeper.name}`);
  steps.push("Never email more than 2 people at the same company on the same day.");
  steps.push("Pause parallel outreach after any positive reply.");

  return {
    mode: stakeholders.length >= 3 ? "multi_thread" : "dual_thread",
    max_same_day: 2,
    primary: champion || decisionMaker || stakeholders[0],
    secondary: [decisionMaker, gatekeeper].filter(Boolean),
    steps,
  };
}

export function getOutreachReadiness(stakeholders) {
  if (!stakeholders || stakeholders.length === 0) {
    return {
      ready: false,
      reason: "No stakeholders identified",
      action: "Manual LinkedIn research needed",
      multi_threading: buildMultiThreadingStrategy([]),
    };
  }

  const highConf = stakeholders.filter((s) => s.confidence_level === "high");
  const medConf = stakeholders.filter((s) => s.confidence_level === "medium");

  if (highConf.length > 0) {
    return {
      ready: true,
      reason: `${highConf.length} high-confidence contact(s)`,
      primary_target: highConf[0],
      secondary_targets: highConf.slice(1).concat(medConf),
      all_targets: stakeholders,
      multi_threading: buildMultiThreadingStrategy(stakeholders),
      needs_email: !highConf[0].email_guess,
    };
  }

  if (medConf.length > 0) {
    return {
      ready: false,
      reason: "Only medium-confidence contacts — needs LinkedIn verification",
      action: "Verify top contact on LinkedIn, confirm role and email",
      primary_candidate: medConf[0],
      all_targets: stakeholders,
      multi_threading: buildMultiThreadingStrategy(stakeholders),
    };
  }

  return {
    ready: false,
    reason: "Only low-confidence contacts found",
    action: "Manual research required — Companies House data insufficient",
    all_targets: stakeholders,
    multi_threading: buildMultiThreadingStrategy(stakeholders),
  };
}

// --- Duplicate Detection ---

export function checkDuplicateContact(name, email, companyId) {
  if (email) {
    const byEmail = db.prepare(
      "SELECT * FROM active_contacts WHERE email = ? AND company_id = ? AND status = 'active'"
    ).get(email, companyId);
    if (byEmail) {
      return { duplicate: true, reason: `Email ${email} already in active sequence (${byEmail.sequence_id})`, existing: byEmail };
    }
  }

  const byName = db.prepare(
    "SELECT * FROM active_contacts WHERE name = ? AND company_id = ? AND status = 'active'"
  ).get(name, companyId);
  if (byName) {
    return { duplicate: true, reason: `${name} already in active sequence at this company (${byName.sequence_id})`, existing: byName };
  }

  return { duplicate: false };
}

export function registerActiveContact(name, email, companyId, sequenceId) {
  db.prepare(
    "INSERT OR IGNORE INTO active_contacts (name, email, company_id, sequence_id, status) VALUES (?, ?, ?, ?, 'active')"
  ).run(name, email || null, companyId, sequenceId);
}

export function deactivateContact(sequenceId) {
  db.prepare("UPDATE active_contacts SET status = 'completed' WHERE sequence_id = ?").run(sequenceId);
}

export function getActiveContactsForCompany(companyId) {
  return db.prepare("SELECT * FROM active_contacts WHERE company_id = ? AND status = 'active'").all(companyId);
}
