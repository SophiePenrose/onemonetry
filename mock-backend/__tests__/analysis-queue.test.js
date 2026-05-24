import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

let tempDir;

function runIsolated(script) {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: path.join(tempDir, "onemonetry.db"),
      OPENAI_API_KEY: "",
    },
    encoding: "utf-8",
  });
  return JSON.parse(output);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-queue-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("analysis queue", () => {
  it("persists queued analysis jobs and completes analysis from filing text", async () => {
    const result = runIsolated(`
      import { upsertFiling, upsertMonitoredCompany, getSetting, closeDb } from "./db.js";
      import { queueCompanyAnalysis, runAnalysisQueue, getAnalysisStatus } from "./analysis-queue.js";
      upsertMonitoredCompany({ company_number: "99111111", company_name: "QUEUE TEST LIMITED", latest_turnover: 25000000, status: "active", source: "test" });
      upsertFiling({ company_number: "99111111", filing_date: "2025-12-31", description: "Accounts filed", filing_type: "accounts", barcode: "queue-test", turnover: 25000000, balance_sheet_date: "2025-12-31", source: "test", source_file: "test.html", raw_data: "STRATEGIC REPORT international exports revenue grew with 120 employees and online payments." });
      queueCompanyAnalysis([{ company_number: "99111111", turnover: 25000000 }], { source: "test" });
      await runAnalysisQueue();
      const status = getAnalysisStatus();
      console.log(JSON.stringify({ status, hasAnalysis: !!getSetting("analysis_99111111", null) }));
      closeDb();
    `);

    assert.equal(result.status.completed, 1);
    assert.equal(result.status.queued, 0);
    assert.equal(result.hasAnalysis, true);
  });

  it("resets interrupted processing jobs back to pending on resume", async () => {
    const result = runIsolated(`
      import { enqueueAnalysisJob, claimNextAnalysisJob, closeDb } from "./db.js";
      import { resumeAnalysisQueue, getAnalysisStatus } from "./analysis-queue.js";
      enqueueAnalysisJob({ company_number: "99222222", company_name: "RESUME TEST LIMITED", source: "test" });
      const claimed = claimNextAnalysisJob();
      resumeAnalysisQueue();
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log(JSON.stringify({ claimed: claimed.company_number, status: getAnalysisStatus() }));
      closeDb();
    `);

    assert.equal(result.claimed, "99222222");
    assert.equal(result.status.processing, 0);
    assert.equal(result.status.skipped, 1);
  });
});
