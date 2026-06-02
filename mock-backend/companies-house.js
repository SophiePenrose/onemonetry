// companies-house.js

import { parseCsvRow, parseNonEmptyCsvLines } from "./csv-utils.js";

function resolveConfiguredSecret(value) {
  const key = String(value || "").trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  const looksPlaceholder = lower.startsWith("replace_")
    || lower.startsWith("replace-")
    || lower.includes("replace_with")
    || lower.includes("your_companies_house")
    || lower.includes("your_api_key")
    || lower === "changeme"
    || lower === "change_me";
  return looksPlaceholder ? null : key;
}

const CH_API_KEY = [
  process.env.COMPANIES_HOUSE_API_KEY,
  process.env.CH_API_KEY,
].map((value) => resolveConfiguredSecret(value)).find(Boolean) || null;
const CH_BASE_URL = "https://api.company-information.service.gov.uk";
const CH_DOWNLOAD_URL = "https://download.companieshouse.gov.uk";

const BANK_LENDER_PATTERN = /\b(?:hsbc|barclays|natwest|lloyds|santander|rbs|royal\s+bank\s+of\s+scotland|bank\s+of\s+scotland|standard\s+chartered|citibank|citi\b|j\.?p\.?\s*morgan|morgan\s+stanley|bank\s+of\s+america|bnp\s*paribas|deutsche\s+bank|ing\b|abn\s*amro|credit\s+suisse|ubs\b)\b/i;

export function isCompaniesHouseConfigured() {
  return !!CH_API_KEY;
}

function normalizeCompanyNumber(companyNumber) {
  return String(companyNumber || "").padStart(8, "0");
}

function extractChargeLenderNames(charge) {
  const lenders = [];
  for (const entry of charge?.persons_entitled || []) {
    if (typeof entry === "string" && entry.trim()) lenders.push(entry.trim());
    if (entry?.name && typeof entry.name === "string") lenders.push(entry.name.trim());
  }

  const securedDescription = charge?.secured_details?.description;
  if (typeof securedDescription === "string" && securedDescription.trim()) {
    lenders.push(securedDescription.trim());
  }

  return lenders;
}

function parseDate(value) {
  if (!value) return null;
  const ts = Date.parse(String(value));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isCorporatePscKind(kind) {
  const token = String(kind || "").toLowerCase();
  return token.includes("corporate-entity") || token.includes("legal-person");
}

function isSignificantControlNature(nature) {
  const token = String(nature || "").toLowerCase();
  if (!token) return false;
  return token.includes("25-to-50-percent")
    || token.includes("50-to-75-percent")
    || token.includes("75-to-100-percent")
    || token.includes("more-than-25-percent");
}

function controlWeightFromNature(nature) {
  const token = String(nature || "").toLowerCase();
  if (!token) return 0;
  if (token.includes("75-to-100-percent")) return 1;
  if (token.includes("50-to-75-percent")) return 0.8;
  if (token.includes("25-to-50-percent") || token.includes("more-than-25-percent")) return 0.6;
  return 0;
}

function getBestControlWeight(natures) {
  return (natures || []).reduce((max, nature) => {
    const next = controlWeightFromNature(nature);
    return next > max ? next : max;
  }, 0);
}

function isUkJurisdiction(...values) {
  const text = values
    .map((value) => String(value || "").toLowerCase())
    .join(" ")
    .replace(/[^a-z\s]/g, " ");

  if (!text.trim()) return false;

  const ukPatterns = [
    /\bunited\s+kingdom\b/,
    /\buk\b/,
    /\bgreat\s+britain\b/,
    /\bengland\b/,
    /\bwales\b/,
    /\bscotland\b/,
    /\bnorthern\s+ireland\b/,
    /\benglish\s+law\b/,
    /\blaws\s+of\s+england\b/,
    /\blaws\s+of\s+the\s+uk\b/,
  ];

  return ukPatterns.some((pattern) => pattern.test(text));
}

function normalizeOwnershipController(pscItem, detail) {
  const name = String(detail?.name || pscItem?.name || "").trim() || null;
  const kind = String(detail?.kind || pscItem?.kind || "").trim() || null;
  const natures = uniqueStrings([
    ...(Array.isArray(pscItem?.natures_of_control) ? pscItem.natures_of_control : []),
    ...(Array.isArray(detail?.natures_of_control) ? detail.natures_of_control : []),
  ]);

  const isSignificantControl = natures.some((nature) => isSignificantControlNature(nature));
  const controlWeight = getBestControlWeight(natures);
  const governingLaw = String(
    detail?.governing_law
      || detail?.law_governed
      || pscItem?.governing_law
      || ""
  ).trim() || null;
  const countryRegistered = String(
    detail?.country_registered
      || detail?.country_of_residence
      || pscItem?.country_of_residence
      || ""
  ).trim() || null;
  const legalForm = String(detail?.legal_form || "").trim() || null;
  const registrationNumber = String(detail?.registration_number || "").trim() || null;
  const nonUkJurisdiction = isSignificantControl && !isUkJurisdiction(governingLaw, countryRegistered);

  return {
    name,
    kind,
    natures_of_control: natures,
    is_significant_control: isSignificantControl,
    control_weight: controlWeight,
    governing_law: governingLaw,
    country_registered: countryRegistered,
    legal_form: legalForm,
    registration_number: registrationNumber,
    non_uk_jurisdiction: nonUkJurisdiction,
    source_link: pscItem?.links?.self || null,
    notified_on: detail?.notified_on || pscItem?.notified_on || null,
    ceased_on: detail?.ceased_on || pscItem?.ceased_on || null,
  };
}

function summarizeOwnershipControllers(controllers, pscTotalCount) {
  const corporateControllers = Array.isArray(controllers) ? controllers.filter(Boolean) : [];
  const significantCorporateControllers = corporateControllers
    .filter((controller) => controller.is_significant_control)
    .sort((a, b) => Number(b.control_weight || 0) - Number(a.control_weight || 0));
  const nonUkSignificantCorporateControllers = significantCorporateControllers
    .filter((controller) => controller.non_uk_jurisdiction)
    .sort((a, b) => Number(b.control_weight || 0) - Number(a.control_weight || 0));

  const primaryController = nonUkSignificantCorporateControllers[0]
    || significantCorporateControllers[0]
    || corporateControllers[0]
    || null;
  const nowIso = new Date().toISOString();

  return {
    updated_at: nowIso,
    fetched_at: nowIso,
    source: "companies_house_psc",
    structure: nonUkSignificantCorporateControllers.length > 0 ? "foreign_subsidiary" : "unknown",
    pe_backed: false,
    parent_company: primaryController?.name || null,
    parent_country: primaryController?.country_registered || null,
    psc_total_count: Number(pscTotalCount || 0),
    corporate_controller_count: corporateControllers.length,
    significant_corporate_controllers_count: significantCorporateControllers.length,
    non_uk_significant_corporate_controllers_count: nonUkSignificantCorporateControllers.length,
    governing_law_non_uk_present: nonUkSignificantCorporateControllers.length > 0,
    significant_corporate_controllers: significantCorporateControllers.slice(0, 20),
    non_uk_significant_corporate_controllers: nonUkSignificantCorporateControllers.slice(0, 20),
    confidence: nonUkSignificantCorporateControllers.length > 0
      ? "high"
      : significantCorporateControllers.length > 0
        ? "medium"
        : "low",
  };
}

export function summarizeCompanyCharges(chargesPayload) {
  const items = Array.isArray(chargesPayload?.items) ? chargesPayload.items : [];
  const total = Number(chargesPayload?.total_count || items.length || 0);
  const now = Date.now();

  let outstandingCount = 0;
  let satisfiedCount = 0;
  let oldestOutstandingDate = null;
  let latestChargeDate = null;

  const lenderSet = new Set();
  const bankLenderSet = new Set();

  for (const charge of items) {
    const status = String(charge?.status || "").toLowerCase();
    const isSatisfied = status === "satisfied";
    if (isSatisfied) satisfiedCount++;
    else outstandingCount++;

    const created = parseDate(charge?.created_on || charge?.delivered_on);
    if (created) {
      if (!latestChargeDate || created > latestChargeDate) latestChargeDate = created;
      if (!isSatisfied && (!oldestOutstandingDate || created < oldestOutstandingDate)) {
        oldestOutstandingDate = created;
      }
    }

    for (const lenderName of extractChargeLenderNames(charge)) {
      lenderSet.add(lenderName);
      if (BANK_LENDER_PATTERN.test(lenderName)) {
        bankLenderSet.add(lenderName);
      }
    }
  }

  const oldestOutstandingAgeYears = oldestOutstandingDate
    ? Math.max(0, Math.round(((now - oldestOutstandingDate.getTime()) / (365.25 * 24 * 3600 * 1000)) * 10) / 10)
    : null;

  return {
    total_count: total,
    outstanding_count: outstandingCount,
    satisfied_count: satisfiedCount,
    unique_lenders: lenderSet.size,
    lenders_sample: [...lenderSet].slice(0, 8),
    has_bank_lender: bankLenderSet.size > 0,
    bank_lenders_sample: [...bankLenderSet].slice(0, 6),
    has_multiple_lenders: lenderSet.size >= 2,
    oldest_outstanding_created_on: oldestOutstandingDate ? oldestOutstandingDate.toISOString().slice(0, 10) : null,
    oldest_outstanding_age_years: oldestOutstandingAgeYears,
    latest_charge_created_on: latestChargeDate ? latestChargeDate.toISOString().slice(0, 10) : null,
    long_tenure_incumbent: oldestOutstandingAgeYears !== null && oldestOutstandingAgeYears >= 10,
    inferred_credit_dependency: outstandingCount > 0 && bankLenderSet.size > 0,
    fetched_at: new Date().toISOString(),
  };
}

export async function lookupCompanyOwnership(companyNumber) {
  const padded = normalizeCompanyNumber(companyNumber);

  if (!CH_API_KEY) {
    return {
      error: true,
      message: "Companies House API key not set. Configure COMPANIES_HOUSE_API_KEY (or CH_API_KEY) to enable live lookups.",
    };
  }

  const pscList = await chFetch(`/company/${padded}/persons-with-significant-control?items_per_page=100`);
  if (pscList.error) {
    return {
      error: true,
      status: pscList.status,
      message: pscList.message || "Unable to fetch persons with significant control",
    };
  }

  const pscItems = Array.isArray(pscList?.items) ? pscList.items : [];
  const corporateItems = pscItems.filter((item) => isCorporatePscKind(item?.kind));
  const controllers = [];
  const detailErrors = [];

  for (const item of corporateItems) {
    const selfLink = item?.links?.self || null;
    let detail = null;

    if (selfLink) {
      const detailResult = await chFetch(selfLink);
      if (!detailResult.error) {
        detail = detailResult;
      } else {
        detailErrors.push({
          link: selfLink,
          status: detailResult.status || null,
          message: detailResult.message || "detail_fetch_failed",
        });
      }
    }

    controllers.push(normalizeOwnershipController(item, detail));
  }

  return {
    company_number: padded,
    summary: summarizeOwnershipControllers(controllers, pscList?.total_results || pscItems.length || 0),
    source: "companies_house_api",
    errors: detailErrors,
  };
}

function authHeaders() {
  const encoded = Buffer.from(`${CH_API_KEY}:`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

async function chFetch(urlPath, retries = 2) {
  const url = urlPath.startsWith("http") ? urlPath : `${CH_BASE_URL}${urlPath}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: CH_API_KEY ? authHeaders() : {} });
      if (res.status === 429) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        return { error: true, status: res.status, message: `CH API error: ${res.status}` };
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) return { error: true, message: err.message };
    }
  }
}

async function chFetchDocumentText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        ...authHeaders(),
        Accept: "application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchLatestAccountsDocument(companyNumber) {
  try {
    if (!isCompaniesHouseConfigured()) return null;

    const padded = normalizeCompanyNumber(companyNumber);
    const filings = await chFetch(`/company/${padded}/filing-history?category=accounts&items_per_page=10`);
    if (filings?.error) return null;

    const latestWithDoc = (Array.isArray(filings?.items) ? filings.items : [])
      .filter((item) => item?.links?.document_metadata)
      .sort((a, b) => Date.parse(b?.date || "") - Date.parse(a?.date || ""))[0];
    if (!latestWithDoc?.links?.document_metadata) return null;

    const metadataUrl = latestWithDoc.links.document_metadata;
    const metadata = await chFetch(metadataUrl);
    if (metadata?.error) return null;

    const resourceTypes = Object.keys(metadata?.resources || {});
    const hasTextResource = resourceTypes.some((type) => /xhtml\+xml|application\/xml|text\/xml/i.test(type));
    if (!hasTextResource) return null;

    const rawHtml = await chFetchDocumentText(`${metadataUrl}/content`);
    if (!rawHtml) return null;

    return {
      filing_date: latestWithDoc.date || null,
      description: latestWithDoc.description || null,
      barcode: latestWithDoc.barcode || null,
      turnover: extractTurnoverFromIXBRL(rawHtml),
      raw_data: String(rawHtml).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200000),
    };
  } catch {
    return null;
  }
}

export async function lookupCompanyCharges(companyNumber) {
  const padded = normalizeCompanyNumber(companyNumber);

  if (!CH_API_KEY) {
    return {
      error: true,
      message: "Companies House API key not set. Configure COMPANIES_HOUSE_API_KEY (or CH_API_KEY) to enable live lookups.",
    };
  }

  const charges = await chFetch(`/company/${padded}/charges?items_per_page=100`);
  if (charges.error) return { error: true, status: charges.status, message: charges.message };

  return {
    company_number: padded,
    summary: summarizeCompanyCharges(charges),
    source: "companies_house_api",
  };
}

export async function lookupCompany(companyNumber, options = {}) {
  const padded = normalizeCompanyNumber(companyNumber);

  if (!CH_API_KEY) {
    return {
      error: true,
      message: "Companies House API key not set. Configure COMPANIES_HOUSE_API_KEY (or CH_API_KEY) to enable live lookups.",
    };
  }

  const profile = await chFetch(`/company/${padded}`);
  if (profile.error) return { error: true, message: profile.message };

  const filings = await chFetch(`/company/${padded}/filing-history?category=accounts&items_per_page=5`);
  const includeCharges = !!options?.include_charges;
  const includeOwnership = !!options?.include_ownership;
  let chargesSummary = null;
  let chargesError = null;
  let ownershipSummary = null;
  let ownershipError = null;

  if (includeCharges) {
    const charges = await lookupCompanyCharges(padded);
    if (charges.error) {
      chargesError = charges.message || "Unable to fetch charges";
    } else {
      chargesSummary = charges.summary || null;
    }
  }

  if (includeOwnership) {
    const ownership = await lookupCompanyOwnership(padded);
    if (ownership.error) {
      ownershipError = ownership.message || "Unable to fetch ownership details";
    } else {
      ownershipSummary = ownership.summary || null;
    }
  }

  return {
    company_number: padded,
    name: profile.company_name,
    status: profile.company_status,
    type: profile.type,
    date_of_creation: profile.date_of_creation,
    sic_codes: profile.sic_codes || [],
    registered_address: profile.registered_office_address
      ? [
          profile.registered_office_address.address_line_1,
          profile.registered_office_address.address_line_2,
          profile.registered_office_address.locality,
          profile.registered_office_address.postal_code,
        ]
          .filter(Boolean)
          .join(", ")
      : null,
    accounts: profile.accounts
      ? {
          next_due: profile.accounts.next_due,
          last_accounts_made_up_to: profile.accounts.last_accounts?.made_up_to,
          period_start: profile.accounts.accounting_reference_date?.month,
        }
      : null,
    recent_filings: filings.error
      ? []
      : (filings.items || []).map((f) => ({
          date: f.date,
          description: f.description,
          type: f.type,
          barcode: f.barcode,
        })),
    charge_summary: chargesSummary,
    charges_error: chargesError,
    ownership_summary: ownershipSummary,
    ownership_error: ownershipError,
    source: "companies_house_api",
  };
}

// Mock lookup removed — all data comes from live Companies House API

// --- CSV Import ---

export function parseCompanyNumbersCSV(csvContent) {
  const lines = parseNonEmptyCsvLines(csvContent);
  if (lines.length === 0) return [];

  const normalizeCandidateCompanyNumber = (value) => {
    const cleaned = String(value || "")
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/\s+/g, "")
      .toUpperCase();

    if (!cleaned) return null;
    if (/^\d{1,8}$/.test(cleaned)) return cleaned.padStart(8, "0");
    if (/^[A-Z]{2}\d+$/.test(cleaned)) return cleaned;
    return null;
  };

  const parseCombinedNameNumberCell = (value) => {
    const text = String(value || "").trim().replace(/^"|"$/g, "");
    if (!text.includes(",")) return null;

    const parts = text.split(",");
    if (parts.length < 2) return null;

    const maybeNumber = parts[parts.length - 1].trim();
    const normalized = normalizeCandidateCompanyNumber(maybeNumber);
    if (!normalized) return null;

    return {
      company_number: normalized,
      company_name: parts.slice(0, -1).join(",").trim() || null,
    };
  };

  const headerCells = parseCsvRow(lines[0]).map((cell) => String(cell || "").toLowerCase());
  const hasHeader = headerCells.some((cell) =>
    cell.includes("company")
    || cell.includes("number")
    || cell.includes("registration")
  );

  const numberColIdx = hasHeader
    ? headerCells.findIndex(
      (cell) => cell.includes("company")
        && (cell.includes("number") || cell.includes("num") || cell.includes("no") || cell.includes("registration"))
    )
    : -1;
  const startIdx = hasHeader ? 1 : 0;

  const numbers = [];
  const seen = new Set();

  for (let i = startIdx; i < lines.length; i += 1) {
    const cells = parseCsvRow(lines[i]).map((cell) => String(cell || "").trim());
    if (cells.length === 0) continue;

    let candidate = numberColIdx >= 0 ? cells[numberColIdx] : null;
    if (!candidate || !normalizeCandidateCompanyNumber(candidate)) {
      const combined = cells.length === 1 ? parseCombinedNameNumberCell(cells[0]) : null;
      if (combined) {
        candidate = combined.company_number;
      }
    }

    if (!candidate || !normalizeCandidateCompanyNumber(candidate)) {
      candidate = cells.find((cell) => !!normalizeCandidateCompanyNumber(cell)) || null;
    }

    const normalized = normalizeCandidateCompanyNumber(candidate);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    numbers.push(normalized);
  }

  return numbers;
}

// --- Bulk Accounts Zip Processing ---

const ACCOUNTS_DOWNLOAD_DAILY = `${CH_DOWNLOAD_URL}/en_accountsdata.html`;
const ACCOUNTS_DOWNLOAD_MONTHLY = `${CH_DOWNLOAD_URL}/en_monthlyaccountsdata.html`;

export function getBulkDownloadInfo() {
  return {
    daily_url: ACCOUNTS_DOWNLOAD_DAILY,
    monthly_url: ACCOUNTS_DOWNLOAD_MONTHLY,
    note: "Daily files published Tue-Sat, contain previous day's filings. Monthly files cover the previous 12 months.",
    schedule: {
      daily: "Tuesday through Saturday each morning",
      monthly: "Within 5 working days of month end",
    },
    formats: ["iXBRL (.html)", "XBRL (.xml)", "ZIP of iXBRL (.zip)"],
    turnover_filter: "£20M+ only",
  };
}

// --- iXBRL Turnover Extraction ---

export function extractTurnoverFromIXBRL(htmlContent) {
  const turnoverPatterns = [
    /name="[^"]*(?:Turnover|Revenue|TotalRevenue|NetRevenue)[^"]*"[^>]*>([^<]+)</gi,
    /contextRef="[^"]*"[^>]*name="[^"]*(?:Turnover|Revenue)[^"]*"[^>]*>([^<]+)</gi,
    /<ix:nonFraction[^>]*name="[^"]*(?:Turnover|Revenue)[^"]*"[^>]*>([^<]+)</gi,
  ];

  for (const pattern of turnoverPatterns) {
    const match = pattern.exec(htmlContent);
    if (match) {
      const value = match[1].replace(/[,\s£]/g, "");
      const num = parseFloat(value);
      if (!isNaN(num) && num > 0) return num;
    }
  }

  const plainNumberPattern = /turnover[^<]*?[\s:]+£?([\d,]+(?:\.\d+)?)\s*(?:million|m\b)/gi;
  const plainMatch = plainNumberPattern.exec(htmlContent);
  if (plainMatch) {
    const val = parseFloat(plainMatch[1].replace(/,/g, ""));
    if (!isNaN(val)) return val * 1_000_000;
  }

  return null;
}

export function meetsTurnoverThreshold(turnover, threshold = 20_000_000) {
  return turnover !== null && turnover >= threshold;
}
