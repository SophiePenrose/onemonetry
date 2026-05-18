// companies-house.js

const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY || null;
const CH_BASE_URL = "https://api.company-information.service.gov.uk";
const CH_DOWNLOAD_URL = "https://download.companieshouse.gov.uk";

export function isCompaniesHouseConfigured() {
  return !!CH_API_KEY;
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

export async function lookupCompany(companyNumber) {
  const padded = companyNumber.toString().padStart(8, "0");

  if (!CH_API_KEY) {
    return mockCompanyLookup(padded);
  }

  const profile = await chFetch(`/company/${padded}`);
  if (profile.error) return { error: true, message: profile.message };

  const filings = await chFetch(`/company/${padded}/filing-history?category=accounts&items_per_page=5`);

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
    source: "companies_house_api",
  };
}

function mockCompanyLookup(companyNumber) {
  const mockData = {
    "00445790": { name: "Tesco PLC", industry: "Retail", turnover: 65000000000, employees: 300000, sic: ["47110"] },
    "00218442": { name: "British American Tobacco p.l.c.", industry: "Tobacco", turnover: 25000000000, employees: 52000, sic: ["12000"] },
    "02400871": { name: "JD Sports Fashion Plc", industry: "Retail", turnover: 10000000000, employees: 60000, sic: ["47640"] },
    "01397169": { name: "Associated British Foods plc", industry: "Food & Beverage", turnover: 19000000000, employees: 128000, sic: ["10890"] },
    "03824658": { name: "Rightmove Group Limited", industry: "Technology", turnover: 365000000, employees: 800, sic: ["63120"] },
  };

  const mock = mockData[companyNumber];
  if (mock) {
    return {
      company_number: companyNumber,
      name: mock.name,
      status: "active",
      type: "plc",
      sic_codes: mock.sic,
      industry_hint: mock.industry,
      turnover_hint: mock.turnover,
      employee_hint: mock.employees,
      recent_filings: [
        { date: "2025-12-15", description: "Full accounts made up to 30 September 2025", type: "AA" },
        { date: "2024-12-18", description: "Full accounts made up to 30 September 2024", type: "AA" },
      ],
      source: "mock",
    };
  }

  return {
    company_number: companyNumber,
    name: `Company ${companyNumber}`,
    status: "active",
    type: "ltd",
    sic_codes: [],
    recent_filings: [],
    source: "mock",
    note: "No mock data available for this company number. Set COMPANIES_HOUSE_API_KEY for live lookups.",
  };
}

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
