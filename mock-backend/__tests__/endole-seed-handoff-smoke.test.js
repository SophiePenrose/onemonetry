import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const seedImportScriptPath = path.join(repoRoot, "scripts", "import-monitor-seed-list.mjs");

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDirs = [];

function createTempDir(prefix = "onemonetry-endole-seed-smoke-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function runSeedImportScript(args, databasePath) {
  return spawnSync(process.execPath, [seedImportScriptPath, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
    },
  });
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

describe("Endole seed import handoff smoke", () => {
  it("imports Endole-shaped seed CSV rows and exposes a created handoff in listing", async () => {
    const tempDir = createTempDir();
    const dbPath = path.join(tempDir, "seed-smoke.db");
    const csvPath = path.join(tempDir, "endole-seed.csv");
    const reportPath = path.join(tempDir, "seed-import-report.json");

    const csv = [
      "company_number,company_name,company_website,company_domain,source_url,scraped_at",
      "1234567,Alpha Payments Ltd,https://alpha-payments.example,alpha-payments.example,https://app.endole.co.uk/company-lists/test,2026-06-27T10:00:00.000Z",
      "01234567,Alpha Payments Duplicate,https://alpha-payments.example,alpha-payments.example,https://app.endole.co.uk/company-lists/test,2026-06-27T10:00:00.000Z",
      "OC123456,Bravo FX Ltd,https://bravo-fx.example,bravo-fx.example,https://app.endole.co.uk/company-lists/test,2026-06-27T10:00:00.000Z",
    ].join("\n");

    fs.writeFileSync(csvPath, `${csv}\n`, "utf8");

    const importResult = runSeedImportScript(
      ["--no-sync", "--no-queue-analysis", "--report", reportPath, csvPath],
      dbPath
    );

    assert.equal(importResult.status, 0, importResult.stderr);
    assert.match(String(importResult.stdout || ""), /\[seed-import\] parsed=3 considered=3/);
    assert.match(String(importResult.stdout || ""), /\[seed-import\] resolved=2 unresolved=0/);
    assert.match(String(importResult.stdout || ""), /\[seed-import\] upserted=2/);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.parsed_rows, 3);
    assert.equal(report.resolution.resolved, 2);
    assert.equal(report.resolution.unresolved, 0);
    assert.equal(report.upsert.upserted, 2);

    process.env.DATABASE_PATH = dbPath;
    const db = await import(`../db.js?endole_seed_handoff_smoke=${Date.now()}`);

    const alpha = db.getMonitoredCompany("01234567");
    assert.ok(alpha);
    assert.equal(alpha.company_website, "https://alpha-payments.example");
    assert.equal(alpha.company_domain, "alpha-payments.example");

    const bravo = db.getMonitoredCompany("OC123456");
    assert.ok(bravo);
    assert.equal(bravo.company_website, "https://bravo-fx.example");
    assert.equal(bravo.company_domain, "bravo-fx.example");

    const requestId = `req_endole_seed_smoke_${Date.now()}`;
    const created = db.createOrGetGeminiHandoffRequest({
      request_id: requestId,
      contract_version: "gemini-handoff-v1",
      company_number: "01234567",
      company_name: String(alpha.company_name || "Alpha Payments Ltd"),
    });

    assert.equal(created.created, true);
    const listed = db.listGeminiHandoffRequests({ status: "accepted", limit: 50, offset: 0 });
    assert.equal(listed.some((row) => row.request_id === requestId), true);

    db.closeDb();
  });
});
