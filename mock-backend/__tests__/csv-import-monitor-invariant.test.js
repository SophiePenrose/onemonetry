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

describe("csv import monitored-table invariant", () => {
  it("upserted csv_import company is readable by monitored + shortlist queries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-csv-monitor-"));
    const dbPath = path.join(tempDir, "data", "test.db");

    process.env.DATABASE_PATH = dbPath;

    const dbModule = await import(`../db.js?csv_monitor_test=${Date.now()}`);

    // End-to-end /api/import/csv also requires a live COMPANIES_HOUSE_API_KEY at runtime.
    // CI does not provide that key, so this test guards the monitored-table invariant
    // that makes CSV-imported companies appear in This Week via shortlist queries.
    dbModule.upsertMonitoredCompany({
      company_number: "01261512",
      company_name: "Test Co",
      latest_turnover: 30000000,
      status: "active",
      source: "csv_import",
    });

    const monitored = dbModule.getMonitoredCompany("01261512");
    assert.ok(monitored);
    assert.equal(monitored.latest_turnover, 30000000);
    assert.equal(monitored.status, "active");

    const shortlist = dbModule.getShortlistCompanies({ min_turnover: 15000000 });
    assert.equal(shortlist.some((company) => company.company_number === "01261512"), true);

    dbModule.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
