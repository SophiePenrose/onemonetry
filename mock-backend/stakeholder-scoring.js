/**
 * Stakeholder Confidence Scoring
 * Assesses how confident we are that the right person has been identified
 * for outreach, and flags low-confidence contacts for manual review.
 */

const CORPORATE_DIRECTOR_PATTERNS = [
  /limited$/i,
  /ltd$/i,
  /plc$/i,
  /llp$/i,
  /inc$/i,
  /corp$/i,
  /holdings/i,
  /nominees/i,
  /trustees/i,
  /management/i,
  /services$/i,
  /secretary/i,
];

const HIGH_VALUE_ROLES = [
  "CFO", "Chief Financial Officer",
  "Finance Director", "FD",
  "Head of Finance", "VP Finance",
  "Head of Treasury", "Treasurer", "Group Treasurer",
  "Financial Controller", "FC",
  "Head of Payments", "Payments Director",
  "COO", "Chief Operating Officer",
  "CEO", "Managing Director", "MD",
  "Founder", "Co-Founder",
];

const MEDIUM_VALUE_ROLES = [
  "Director", "Non-Executive Director",
  "Company Secretary",
];

export function scoreStakeholder(person, company, filingDate) {
  const result = {
    name: person.name,
    role: person.role,
    confidence: "low",
    confidence_score: 0,
    flags: [],
    source: "companies_house_filing",
    source_date: filingDate || null,
    needs_verification: true,
    linkedin_search_url: null,
    email_guess: null,
  };

  if (!person.name) {
    result.flags.push("No name available");
    return result;
  }

  const isCorporate = CORPORATE_DIRECTOR_PATTERNS.some((p) => p.test(person.name));
  if (isCorporate) {
    result.confidence = "none";
    result.confidence_score = 0;
    result.flags.push("Corporate director entity — not a person");
    result.needs_verification = false;
    return result;
  }

  let score = 30;

  const isHighValue = HIGH_VALUE_ROLES.some((r) =>
    (person.role || "").toLowerCase().includes(r.toLowerCase())
  );
  const isMediumValue = MEDIUM_VALUE_ROLES.some((r) =>
    (person.role || "").toLowerCase().includes(r.toLowerCase())
  );

  if (isHighValue) {
    score += 40;
    result.flags.push("High-value role for outreach");
  } else if (isMediumValue) {
    score += 20;
    result.flags.push("Generic 'Director' role — may not be finance decision-maker");
  } else {
    score += 10;
    result.flags.push("Role unclear — needs LinkedIn verification");
  }

  if (filingDate) {
    const daysSinceFiling = Math.floor((Date.now() - new Date(filingDate).getTime()) / 86400000);
    if (daysSinceFiling < 90) {
      score += 15;
    } else if (daysSinceFiling < 365) {
      score += 10;
    } else {
      score += 0;
      result.flags.push("Filing >12 months old — person may have left");
    }
  }

  const nameParts = person.name.trim().split(/\s+/);
  if (nameParts.length >= 2 && nameParts[0].length > 1) {
    score += 5;
  } else if (nameParts[0].length <= 2) {
    result.flags.push("Name may be initials only — harder to locate on LinkedIn");
  }

  if (score >= 70) result.confidence = "high";
  else if (score >= 45) result.confidence = "medium";
  else result.confidence = "low";

  result.confidence_score = Math.min(score, 100);
  result.needs_verification = result.confidence !== "high";

  const companyName = company?.name || "";
  const searchName = person.name.replace(/\b[A-Z]\b/g, "").trim();
  result.linkedin_search_url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchName + " " + companyName)}`;

  if (company?.name) {
    const domain = guessDomain(company.name);
    if (domain && nameParts.length >= 2) {
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
    .replace(/\b(limited|ltd|plc|llp|inc|corp|group|holdings)\b/gi, "")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  if (name.length < 3) return null;
  return name + ".com";
}

export function scoreAllStakeholders(keyPeople, company, filingDate) {
  if (!keyPeople || keyPeople.length === 0) return [];

  return keyPeople
    .map((person) => scoreStakeholder(person, company, filingDate))
    .filter((s) => s.confidence !== "none")
    .sort((a, b) => b.confidence_score - a.confidence_score);
}

export function getOutreachReadiness(stakeholders) {
  if (!stakeholders || stakeholders.length === 0) {
    return { ready: false, reason: "No stakeholders identified", action: "Manual LinkedIn research needed" };
  }

  const highConfidence = stakeholders.filter((s) => s.confidence === "high");
  const withEmails = stakeholders.filter((s) => s.email_guess);

  if (highConfidence.length === 0) {
    return {
      ready: false,
      reason: "No high-confidence contacts found",
      action: "Verify stakeholders on LinkedIn before outreach",
      stakeholders,
    };
  }

  return {
    ready: true,
    reason: `${highConfidence.length} high-confidence contact(s) identified`,
    primary_target: highConfidence[0],
    all_targets: stakeholders,
    needs_email: !highConfidence[0].email_guess,
  };
}
