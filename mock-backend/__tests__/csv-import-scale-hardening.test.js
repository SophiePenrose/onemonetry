import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDirs = [];

function createTempDir(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

describe("csv import scale hardening", () => {
  it("parses quoted multi-column company-number CSV content", async () => {
    const companiesHouse = await import(`../companies-house.js?csv_parse_numbers=${Date.now()}`);

    const csv = [
      "Company Name,Company Number,Notes",
      '"Alpha, Limited",1234567,first',
      'Beta Ltd,OC123456,"row, with comma"',
      'Gamma Ltd,"00123456",ok',
      'Beta Ltd,OC123456,duplicate',
    ].join("\n");

    const numbers = companiesHouse.parseCompanyNumbersCSV(csv);

    assert.deepEqual(numbers, ["01234567", "OC123456", "00123456"]);
  });

  it("imports monitor-list CSV with quoted names and deduplicated company numbers", async () => {
    const tempDir = createTempDir("onemonetry-monitor-import-");
    process.env.DATABASE_PATH = path.join(tempDir, "monitor.db");

    const companyMonitor = await import(`../company-monitor.js?csv_monitor_import=${Date.now()}`);
    const db = await import("../db.js");

    const csv = [
      "Company Name,Company Registration Number",
      '"Alpha, Limited",1234567',
      "Alpha Duplicate,1234567",
      "Bravo Ltd,OC123456",
    ].join("\n");

    const result = await companyMonitor.importMonitorListFromCSV(csv, "bulk_csv_test");

    assert.equal(result.total_parsed, 2);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);

    const alpha = db.getMonitoredCompany("01234567");
    const bravo = db.getMonitoredCompany("OC123456");

    assert.ok(alpha);
    assert.equal(alpha.company_name, "Alpha, Limited");
    assert.equal(alpha.source, "bulk_csv_test");
    assert.ok(bravo);
    assert.equal(bravo.company_name, "Bravo Ltd");

    db.closeDb();
  });

  it("bulk monitored-company upsert skips invalid rows", async () => {
    const tempDir = createTempDir("onemonetry-monitor-bulk-");
    process.env.DATABASE_PATH = path.join(tempDir, "bulk.db");

    const db = await import(`../db.js?bulk_monitor_upsert=${Date.now()}`);

    const result = db.upsertMonitoredCompanies([
      { company_number: "1234567", company_name: "Alpha Ltd" },
      { companyNumber: "OC123456", name: "Bravo Ltd" },
      { company_number: "", company_name: "Invalid Co" },
      { company_number: null, company_name: "Missing" },
    ], "bulk_script");

    assert.equal(result.received, 4);
    assert.equal(result.upserted, 2);
    assert.equal(result.skipped_invalid, 2);

    const monitored = db.getMonitoredCompanies({ limit: 10 });
    assert.equal(monitored.length, 2);
    assert.equal(monitored.some((row) => row.company_number === "01234567"), true);
    assert.equal(monitored.some((row) => row.company_number === "OC123456"), true);

    db.closeDb();
  });
});