// Live Companies House Document API fetch is exercised at runtime.
// CI has no COMPANIES_HOUSE_API_KEY, so this guards the stored-filing-text -> full-dossier invariant.
// Note: db.js calls fs.mkdirSync(dirname(DATABASE_PATH), { recursive: true }) at load,
// so the nested data/ subdirectory in the temp DATABASE_PATH below is created automatically.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;

afterEach(() => {
  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

describe("csv import filing-text invariant", () => {
  it("uses stored filing raw_data to avoid no_filing_data analysis", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-csv-filing-text-"));
    const dbPath = path.join(tempDir, "data", "test.db");

    process.env.DATABASE_PATH = dbPath;

    const dbModule = await import(`../db.js?csv_filing_text_test=${Date.now()}`);
    const llmModule = await import(`../llm.js?csv_filing_text_test=${Date.now()}`);

    dbModule.upsertMonitoredCompany({
      company_number: "01261512",
      company_name: "Doc Co",
      latest_turnover: 80000000,
      status: "active",
      source: "csv_import",
    });

    dbModule.upsertFiling({
      company_number: "01261512",
      filing_date: "2025-03-31",
      filing_type: "accounts",
      barcode: "test-doc",
      turnover: 80000000,
      source: "csv_import",
      raw_data: "The group has significant international operations across Europe and the USA. Average number of employees 540. Turnover increased year on year.",
    });

    assert.equal(dbModule.getFilingsForCompany("01261512").some((f) => f.raw_data), true);

    const analysis = await llmModule.analyseCompany("01261512", "Doc Co", 80000000);
    assert.notEqual(analysis.source, "no_filing_data");
    assert.equal(
      analysis.pain_indicators.length > 0 || analysis.opportunities.length > 0,
      true
    );

    dbModule.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
