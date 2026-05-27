// companies-house.js

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
  let chargesSummary = null;
  let chargesError = null;

  if (includeCharges) {
    const charges = await lookupCompanyCharges(padded);
    if (charges.error) {
      chargesError = charges.message || "Unable to fetch charges";
    } else {
      chargesSummary = charges.summary || null;
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
    source: "companies_house_api",
  };
}

// Mock lookup removed — all data comes from live Companies House API

// --- CSV Import ---

export function parseCompanyNumbersCSV(csvContent) {
  const lines = csvContent.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase();
  let numberColIdx = 0;

  const cols = header.split(",").map((c) => c.trim().replace(/"/g, ""));
  const numIdx = cols.findIndex(
    (c) => c.includes("company") && (c.includes("number") || c.includes("num") || c.includes("no"))
  );
  if (numIdx >= 0) numberColIdx = numIdx;

  const numbers = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim().replace(/"/g, ""));
    const num = cells[numberColIdx];
    if (num && /^\d{6,8}$/.test(num.replace(/^0+/, "").padStart(1, "0")) || /^[A-Z]{2}\d+$/.test(num)) {
      numbers.push(num.padStart(8, "0"));
    }
  }

  return [...new Set(numbers)];
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
