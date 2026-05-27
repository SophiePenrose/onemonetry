import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const originalCompaniesHouseKey = process.env.COMPANIES_HOUSE_API_KEY;
const originalFetch = global.fetch;

afterEach(() => {
  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }

  if (originalCompaniesHouseKey === undefined) {
    delete process.env.COMPANIES_HOUSE_API_KEY;
  } else {
    process.env.COMPANIES_HOUSE_API_KEY = originalCompaniesHouseKey;
  }

  global.fetch = originalFetch;
});

describe("database path configuration", () => {
  it("respects DATABASE_PATH and creates parent directories", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-db-"));
    const dbPath = path.join(tempDir, "nested", "data", "app.db");

    process.env.DATABASE_PATH = dbPath;

    const dbModule = await import(`../db.js?db_test=${Date.now()}`);
    dbModule.setSetting("config_test_key", { ok: true });

    assert.equal(fs.existsSync(dbPath), true);
    assert.deepEqual(dbModule.getSetting("config_test_key"), { ok: true });

    dbModule.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("companies house key handling", () => {
  it("trims COMPANIES_HOUSE_API_KEY before auth header generation", async () => {
    process.env.COMPANIES_HOUSE_API_KEY = "  test_key_with_spaces\n";

    const calls = [];

    global.fetch = async (url, options = {}) => {
      calls.push({ url, headers: options.headers || {} });

      if (String(url).includes("/filing-history")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          company_name: "TESCO PLC",
          company_status: "active",
          type: "plc",
          date_of_creation: "1919-01-01",
          sic_codes: ["47110"],
          registered_office_address: {
            address_line_1: "Tesco House",
            locality: "Welwyn Garden City",
            postal_code: "AL7 1GA",
          },
          accounts: {
            next_due: "2026-12-31",
            last_accounts: { made_up_to: "2025-02-25" },
            accounting_reference_date: { month: "02" },
          },
        }),
      };
    };

    const companiesHouse = await import(`../companies-house.js?ch_test=${Date.now()}`);
    assert.equal(companiesHouse.isCompaniesHouseConfigured(), true);

    const company = await companiesHouse.lookupCompany("445790");

    assert.equal(company.error, undefined);
    assert.equal(company.name, "TESCO PLC");
    assert.equal(calls.length >= 2, true);

    const expectedAuth = `Basic ${Buffer.from("test_key_with_spaces:").toString("base64")}`;
    assert.equal(calls[0].headers.Authorization, expectedAuth);
    assert.equal(calls[1].headers.Authorization, expectedAuth);
  });
});
