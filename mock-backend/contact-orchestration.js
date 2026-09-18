const APOLLO_API_BASE_URL = "https://api.apollo.io/api/v1";
const DEFAULT_TIMEOUT_MS = 10000;

export const DEFAULT_BUYER_TITLES = [
  "Chief Financial Officer", "Finance Director", "Head of Finance", "Head of Treasury",
  "Treasury Manager", "VP Finance", "Financial Controller", "Head of Payments",
  "Payments Manager", "Procurement Director", "Head of Ecommerce", "Director of Ecommerce",
];

export const DEFAULT_WEEKLY_OUTREACH_POLICY = Object.freeze({
  linkedin_weekly_cap: 100,
  linkedin_automated_target: 90,
  linkedin_manual_reserve: 10,
  default_company_contact_cap: 3,
  strategic_company_contact_cap: 4,
  minimum_turnover_gbp: 30000000,
});

function configuredValue(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  const lower = token.toLowerCase();
  if (lower.includes("replace_with") || lower.includes("your_api_key") || lower === "changeme") return "";
  return token;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeDomain(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  }
}

function normalizeLinkedInUrl(value) {
  const raw = normalizeText(value);
  if (!raw || !/linkedin\.com\/in\//i.test(raw)) return null;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    url.protocol = "https:";
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

function confidenceRank(value) {
  return { high: 3, medium: 2, low: 1, none: 0 }[String(value || "").toLowerCase()] ?? 0;
}

function candidateKey(candidate = {}) {
  const linkedin = normalizeLinkedInUrl(candidate.linkedin_url);
  if (linkedin) return `linkedin:${linkedin.toLowerCase()}`;
  const email = normalizeText(candidate.email).toLowerCase();
  if (email) return `email:${email}`;
  return `identity:${normalizeText(candidate.full_name).toLowerCase()}::${normalizeText(candidate.company_name).toLowerCase()}`;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on", "approved"].includes(String(value || "").trim().toLowerCase());
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[,£$]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEmail(value) {
  const email = normalizeText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePhone(value) {
  const phone = normalizeText(value);
  if (!phone) return null;
  const compact = phone.replace(/[^+\d]/g, "");
  return /^\+?\d{7,15}$/.test(compact) ? compact : null;
}

function rolePriority(role) {
  const token = normalizeText(role).toLowerCase();
  const priorities = [
    [/chief financial officer|\bcfo\b/, 100],
    [/finance director|director of finance/, 96],
    [/head of treasury|treasury director|vp treasury/, 94],
    [/head of finance|vp finance/, 92],
    [/treasury manager/, 88],
    [/head of payments|payments director|director of payments/, 86],
    [/chief operating officer|\bcoo\b/, 82],
    [/chief executive officer|\bceo\b|managing director/, 80],
    [/head of e.?commerce|e.?commerce director|director of e.?commerce/, 78],
    [/financial controller|controller/, 76],
    [/payments manager|procurement director/, 72],
  ];
  return priorities.find(([pattern]) => pattern.test(token))?.[1] ?? 50;
}

function outreachPriority(candidate) {
  const explicit = parseOptionalNumber(candidate.priority_score) ?? parseOptionalNumber(candidate.score) ?? 0;
  const confidence = confidenceRank(candidate.confidence) * 3;
  return rolePriority(candidate.role) + Math.max(-20, Math.min(20, explicit)) + confidence;
}

function companyKey(candidate) {
  return normalizeText(candidate.company_number).toUpperCase()
    || normalizeDomain(candidate.company_domain)
    || normalizeText(candidate.company_name).toLowerCase()
    || "unknown-company";
}

export function normalizeContactCandidate(raw = {}, source = "unknown") {
  const firstName = normalizeText(raw.first_name || raw.firstName);
  const lastName = normalizeText(raw.last_name || raw.lastName);
  const fullName = normalizeText(raw.full_name || raw.name || [firstName, lastName].filter(Boolean).join(" "));
  const organization = raw.organization && typeof raw.organization === "object" ? raw.organization : {};
  const email = normalizeText(raw.email || raw.email_address || raw.work_email) || null;
  const sourceId = normalizeText(raw.source_id || raw.person_id || raw.id) || null;
  return {
    person_id: sourceId ? `${source}:${sourceId}` : null,
    source_id: sourceId,
    source,
    sources: [source],
    full_name: fullName || null,
    first_name: firstName || null,
    last_name: lastName || null,
    role: normalizeText(raw.role || raw.title || raw.job_title || raw.headline) || null,
    company_name: normalizeText(raw.company_name || raw.organization_name || organization.name) || null,
    company_number: normalizeText(raw.company_number || raw.registration_number) || null,
    company_domain: normalizeDomain(raw.company_domain || raw.organization_domain || organization.primary_domain || organization.website_url) || null,
    email,
    email_status: normalizeText(raw.email_status || raw.emailStatus) || (email ? "provided" : "missing"),
    linkedin_url: normalizeLinkedInUrl(raw.linkedin_url || raw.linkedinUrl || raw.linkedin),
    phone: normalizePhone(raw.phone || raw.phone_number || raw.mobile_phone || raw.mobile),
    confidence: normalizeText(raw.confidence || raw.match_confidence) || "medium",
    provider_payload: raw,
  };
}

export function planWeeklyOutreach(input = {}) {
  if (!Array.isArray(input.contacts)) {
    const error = new Error("contacts must be an array");
    error.code = "weekly_contacts_required";
    throw error;
  }

  const requestedCap = Math.max(1, Math.floor(parseOptionalNumber(input.linkedin_weekly_cap) ?? DEFAULT_WEEKLY_OUTREACH_POLICY.linkedin_weekly_cap));
  const requestedReserve = Math.max(0, Math.floor(parseOptionalNumber(input.linkedin_manual_reserve) ?? DEFAULT_WEEKLY_OUTREACH_POLICY.linkedin_manual_reserve));
  const automaticTarget = Math.max(0, Math.min(
    requestedCap - Math.min(requestedCap, requestedReserve),
    Math.floor(parseOptionalNumber(input.linkedin_automated_target) ?? DEFAULT_WEEKLY_OUTREACH_POLICY.linkedin_automated_target)
  ));
  const defaultCompanyCap = Math.max(1, Math.min(4, Math.floor(
    parseOptionalNumber(input.default_company_contact_cap) ?? DEFAULT_WEEKLY_OUTREACH_POLICY.default_company_contact_cap
  )));
  const minimumTurnover = Math.max(0, parseOptionalNumber(input.minimum_turnover_gbp) ?? DEFAULT_WEEKLY_OUTREACH_POLICY.minimum_turnover_gbp);
  const campaignId = normalizeText(input.we_connect_campaign_id);

  const rejected = [];
  const deduped = new Map();
  for (const raw of input.contacts) {
    const source = normalizeText(raw?.source) || "approved_contact";
    const candidate = { ...normalizeContactCandidate(raw, source), ...raw };
    candidate.linkedin_url = normalizeLinkedInUrl(raw?.linkedin_url || raw?.linkedinUrl || raw?.linkedin);
    candidate.email = normalizeEmail(raw?.email || raw?.email_address || raw?.work_email);
    candidate.phone = normalizePhone(raw?.phone || raw?.phone_number || raw?.mobile_phone || raw?.mobile);
    candidate.company_number = normalizeText(raw?.company_number || raw?.registration_number) || null;
    candidate.company_name = normalizeText(raw?.company_name || raw?.organization_name || candidate.company_name) || null;
    candidate.company_domain = normalizeDomain(raw?.company_domain || raw?.organization_domain || candidate.company_domain) || null;

    const approvalStatus = normalizeText(raw?.approval_status).toLowerCase();
    const crmApproved = parseBoolean(raw?.crm_approved) || approvalStatus === "approved";
    const turnover = parseOptionalNumber(raw?.company_turnover_gbp ?? raw?.turnover_gbp);
    const suppressed = parseBoolean(raw?.suppressed) || parseBoolean(raw?.do_not_contact);
    if (!crmApproved) {
      rejected.push({ candidate, reason: "crm_approval_required" });
      continue;
    }
    if (turnover !== null && turnover < minimumTurnover && !parseBoolean(raw?.turnover_override_approved)) {
      rejected.push({ candidate, reason: "below_turnover_floor" });
      continue;
    }
    if (suppressed) {
      rejected.push({ candidate, reason: "suppressed" });
      continue;
    }

    const emailAllowed = Boolean(candidate.email) && !parseBoolean(raw?.do_not_email);
    const linkedinAllowed = Boolean(candidate.linkedin_url) && !parseBoolean(raw?.do_not_linkedin);
    const phoneAllowed = Boolean(candidate.phone) && !parseBoolean(raw?.do_not_call) && !parseBoolean(raw?.phone_dnc);
    candidate.channels = { linkedin: linkedinAllowed, email: emailAllowed, phone: phoneAllowed };
    candidate.priority = outreachPriority(candidate);
    if (!emailAllowed && !linkedinAllowed && !phoneAllowed) {
      rejected.push({ candidate, reason: "no_usable_channel" });
      continue;
    }

    const key = candidateKey(candidate);
    const existing = deduped.get(key);
    if (!existing || candidate.priority > existing.priority) deduped.set(key, candidate);
  }

  const byCompany = new Map();
  for (const candidate of deduped.values()) {
    const key = companyKey(candidate);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(candidate);
  }

  const selected = [];
  const overflow = [];
  for (const [key, contacts] of byCompany.entries()) {
    contacts.sort((a, b) => b.priority - a.priority || normalizeText(a.full_name).localeCompare(normalizeText(b.full_name)));
    const strategic = contacts.some((contact) => parseBoolean(contact.allow_fourth_contact) || parseBoolean(contact.strategic_company));
    const cap = strategic ? DEFAULT_WEEKLY_OUTREACH_POLICY.strategic_company_contact_cap : defaultCompanyCap;
    selected.push(...contacts.slice(0, cap));
    overflow.push(...contacts.slice(cap).map((candidate) => ({ candidate, reason: "company_contact_cap", company_key: key })));
  }
  selected.sort((a, b) => b.priority - a.priority || companyKey(a).localeCompare(companyKey(b)));

  let linkedinAllocated = 0;
  const assignments = [];
  for (const candidate of selected) {
    const linkedinSelected = candidate.channels.linkedin && linkedinAllocated < automaticTarget;
    if (linkedinSelected) linkedinAllocated += 1;
    const linkedinStatus = !candidate.channels.linkedin
      ? "unavailable"
      : linkedinSelected ? "awaiting_human_approval" : "queued_next_week";
    const routes = {
      linkedin: linkedinStatus,
      email: candidate.channels.email ? "ready" : "unavailable",
      phone: candidate.channels.phone ? "call_task_ready" : "unavailable",
    };
    const assignment = {
      ...candidate,
      routes,
      stop_conditions: ["positive_reply", "meeting_booked", "opt_out", "suppression_added"],
      we_connect_preview: linkedinSelected && campaignId
        ? buildWeConnectEnrollmentPreview({ ...candidate, campaign_id: campaignId })
        : null,
    };
    assignments.push(assignment);
    if (candidate.channels.linkedin && !linkedinSelected) {
      overflow.push({
        candidate,
        reason: "linkedin_weekly_capacity",
        company_key: companyKey(candidate),
        other_routes_active: candidate.channels.email || candidate.channels.phone,
      });
    }
  }

  const thisWeek = assignments.filter((assignment) => (
    assignment.routes.linkedin === "awaiting_human_approval"
    || assignment.routes.email === "ready"
    || assignment.routes.phone === "call_task_ready"
  ));
  const companyCounts = new Map();
  for (const assignment of thisWeek) {
    const key = companyKey(assignment);
    companyCounts.set(key, (companyCounts.get(key) || 0) + 1);
  }

  return {
    status: "preview_only",
    send_performed: false,
    policy: {
      linkedin_weekly_cap: requestedCap,
      linkedin_automated_target: automaticTarget,
      linkedin_manual_reserve: Math.max(0, requestedCap - automaticTarget),
      default_company_contact_cap: defaultCompanyCap,
      strategic_company_contact_cap: DEFAULT_WEEKLY_OUTREACH_POLICY.strategic_company_contact_cap,
      minimum_turnover_gbp: minimumTurnover,
    },
    summary: {
      submitted_contacts: input.contacts.length,
      unique_eligible_contacts: deduped.size,
      active_contacts_this_week: thisWeek.length,
      active_companies_this_week: companyCounts.size,
      linkedin_automated_selected: linkedinAllocated,
      linkedin_manual_slots_reserved: Math.max(0, requestedCap - automaticTarget),
      email_ready: thisWeek.filter((item) => item.routes.email === "ready").length,
      phone_tasks_ready: thisWeek.filter((item) => item.routes.phone === "call_task_ready").length,
      overflow_contacts: overflow.length,
      rejected_contacts: rejected.length,
    },
    assignments: thisWeek,
    overflow,
    rejected,
    safeguards: {
      crm_approval_required: true,
      human_approval_required_for_we_connect: true,
      deduplication_enabled: true,
      stop_on_response_enabled: true,
      send_performed: false,
    },
  };
}

export function mergeContactCandidates(groups = []) {
  const merged = new Map();
  for (const group of groups) {
    const source = normalizeText(group?.source) || "unknown";
    for (const raw of Array.isArray(group?.candidates) ? group.candidates : []) {
      const candidate = normalizeContactCandidate(raw, source);
      if (!candidate.full_name) continue;
      const key = candidateKey(candidate);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, candidate);
        continue;
      }
      const candidateWins = confidenceRank(candidate.confidence) > confidenceRank(existing.confidence);
      merged.set(key, {
        ...(candidateWins ? existing : candidate),
        ...(candidateWins ? candidate : existing),
        email: existing.email || candidate.email,
        email_status: existing.email ? existing.email_status : candidate.email_status,
        linkedin_url: existing.linkedin_url || candidate.linkedin_url,
        sources: [...new Set([...(existing.sources || []), ...(candidate.sources || [])])],
        provider_payloads: {
          ...(existing.provider_payloads || { [existing.source]: existing.provider_payload }),
          [candidate.source]: candidate.provider_payload,
        },
      });
    }
  }
  return [...merged.values()].map(({ provider_payload: _payload, ...candidate }) => candidate);
}

export function buildLinkedInFallbackRequests(candidates = []) {
  return candidates.filter((candidate) => candidate?.full_name && !candidate?.linkedin_url).map((candidate) => ({
    status: "needs_interactive_lookup",
    first_name: candidate.first_name || normalizeText(candidate.full_name).split(" ")[0] || null,
    last_name: candidate.last_name || normalizeText(candidate.full_name).split(" ").slice(1).join(" ") || null,
    company: candidate.company_name || null,
    title: candidate.role || null,
    reason: "apollo_candidate_missing_linkedin_url",
  }));
}

export function getApolloConfig(env = process.env) {
  return {
    apiKey: configuredValue(env.APOLLO_API_KEY),
    timeoutMs: Math.max(1000, Number.parseInt(env.APOLLO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS),
  };
}

export function createApolloContactSource({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getApolloConfig(env);
  async function request(path, body) {
    if (!config.apiKey) {
      const error = new Error("Apollo is not configured");
      error.code = "apollo_not_configured";
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${APOLLO_API_BASE_URL}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": config.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`Apollo request failed (${response.status})`);
        error.code = "apollo_request_failed";
        error.status = response.status;
        error.detail = normalizeText(payload?.message || payload?.error);
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function searchPeople({ companyDomain, organizationIds = [], titles = DEFAULT_BUYER_TITLES, page = 1, perPage = 25 } = {}) {
    const domain = normalizeDomain(companyDomain);
    if (!domain && organizationIds.length === 0) {
      const error = new Error("A company domain or Apollo organization ID is required");
      error.code = "apollo_company_identifier_required";
      throw error;
    }
    const body = {
      person_titles: titles.slice(0, 50), include_similar_titles: true,
      person_seniorities: ["c_suite", "vp", "head", "director", "manager"],
      page: Math.max(1, Number.parseInt(page, 10) || 1),
      per_page: Math.max(1, Math.min(100, Number.parseInt(perPage, 10) || 25)),
    };
    if (domain) body.q_organization_domains_list = [domain];
    if (organizationIds.length > 0) body.organization_ids = organizationIds.slice(0, 100);
    const payload = await request("/mixed_people/api_search", body);
    const rows = Array.isArray(payload?.people) ? payload.people : [];
    return {
      candidates: rows.map((person) => normalizeContactCandidate(person, "apollo")),
      pagination: payload?.pagination || null,
      credit_policy: { search_credits: 0, enrichment_performed: false },
    };
  }

  async function enrichSelectedPerson(input = {}) {
    if (input.allow_credit_spend !== true) {
      const error = new Error("Explicit allow_credit_spend=true is required for Apollo enrichment");
      error.code = "apollo_credit_approval_required";
      throw error;
    }
    const identifiers = {
      id: normalizeText(input.apollo_person_id) || undefined,
      linkedin_url: normalizeLinkedInUrl(input.linkedin_url) || undefined,
      name: normalizeText(input.full_name) || undefined,
      domain: normalizeDomain(input.company_domain) || undefined,
      organization_name: normalizeText(input.company_name) || undefined,
      reveal_personal_emails: false, reveal_phone_number: false,
      run_waterfall_email: false, run_waterfall_phone: false,
    };
    if (!identifiers.id && !identifiers.linkedin_url && !identifiers.name) {
      const error = new Error("A selected person identifier is required");
      error.code = "apollo_person_identifier_required";
      throw error;
    }
    const payload = await request("/people/match", identifiers);
    const person = payload?.person || payload?.contact || null;
    return {
      candidate: person ? normalizeContactCandidate({ ...person, match_confidence: payload?.match_confidence }, "apollo") : null,
      match_confidence: payload?.match_confidence || null,
      credit_policy: { enrichment_performed: true, phone_reveal: false, personal_email_reveal: false, waterfall: false },
    };
  }
  return { configured: Boolean(config.apiKey), searchPeople, enrichSelectedPerson };
}

export const apolloContactSource = createApolloContactSource();

export function buildWeConnectEnrollmentPreview(input = {}) {
  const linkedinUrl = normalizeLinkedInUrl(input.linkedin_url);
  if (!linkedinUrl) {
    const error = new Error("A valid LinkedIn profile URL is required");
    error.code = "linkedin_profile_required";
    throw error;
  }
  if (!normalizeText(input.campaign_id)) {
    const error = new Error("A We-Connect campaign ID is required");
    error.code = "we_connect_campaign_required";
    throw error;
  }
  return {
    integration: "we_connect", operation: "enrol_contact", status: "awaiting_human_approval", approved: false,
    campaign_id: normalizeText(input.campaign_id),
    contact: {
      linkedin_url: linkedinUrl,
      first_name: normalizeText(input.first_name) || null, last_name: normalizeText(input.last_name) || null,
      full_name: normalizeText(input.full_name) || null, company_name: normalizeText(input.company_name) || null,
      company_number: normalizeText(input.company_number) || null, role: normalizeText(input.role) || null,
    },
    custom_fields: input.custom_fields && typeof input.custom_fields === "object" ? input.custom_fields : {},
    safeguards: {
      requires_human_approval: true,
      dedupe_key: `${normalizeText(input.campaign_id)}::${linkedinUrl.toLowerCase()}`,
      send_performed: false,
    },
  };
}
