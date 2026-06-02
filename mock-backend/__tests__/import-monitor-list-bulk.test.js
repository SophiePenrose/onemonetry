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
const scriptPath = path.join(repoRoot, "scripts", "import-monitor-list-bulk.mjs");

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDirs = [];

function createTempDir(prefix = "onemonetry-import-monitor-bulk-") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeCsv(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function runScript(args, databasePath) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
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

describe("bulk monitor-list import script", () => {
  it("supports dry-run mode without writing monitor rows", async () => {
    const tempDir = createTempDir();
    const dbPath = path.join(tempDir, "dryrun.db");
    const csvPath = path.join(tempDir, "source.csv");

    writeCsv(csvPath, [
      "Company Name,Company Number",
      "Alpha Ltd,1234567",
      "Bravo Ltd,OC123456",
    ]);

    const result = runScript(["--dry-run", csvPath], dbPath);

    assert.equal(result.status, 0, result.stderr);
    assert.match(String(result.stdout || ""), /dry-run/);

    process.env.DATABASE_PATH = dbPath;
    const db = await import(`../db.js?bulk_import_dry_run=${Date.now()}`);
    assert.equal(db.getMonitoredCompanyCount(), 0);
    db.closeDb();
  });

  it("excludes closed-won rows and honors --new-only", async () => {
    const tempDir = createTempDir();
    const dbPath = path.join(tempDir, "apply.db");
    const csvPath = path.join(tempDir, "source.csv");

    process.env.DATABASE_PATH = dbPath;
    const dbSeed = await import(`../db.js?bulk_import_seed=${Date.now()}`);

    dbSeed.upsertClosedWonCompanies([
      { company_number: "00000001", company_name: "Closed Won Co" },
    ], "unit_test");

    dbSeed.upsertMonitoredCompany({
      company_number: "00000002",
      company_name: "Existing Co",
      latest_turnover: 25_000_000,
      source: "unit_test",
      status: "active",
    });

    dbSeed.closeDb();

    writeCsv(csvPath, [
      "Company Number,Company Name",
      "00000001,Closed Won Co",
      "00000002,Existing Co",
      "00000003,New Co",
    ]);

    const result = runScript(["--new-only", "--report", path.join(tempDir, "report.json"), csvPath], dbPath);

    assert.equal(result.status, 0, result.stderr);
    assert.match(String(result.stdout || ""), /closed_won_excluded=1/);
    assert.match(String(result.stdout || ""), /already_monitored=1/);
    assert.match(String(result.stdout || ""), /new_only_skipped=1/);

    process.env.DATABASE_PATH = dbPath;
    const dbVerify = await import(`../db.js?bulk_import_verify=${Date.now()}`);
    const monitored = dbVerify.getMonitoredCompanies({ limit: 20 });
    assert.equal(monitored.length, 2);
    assert.equal(monitored.some((row) => row.company_number === "00000002"), true);
    assert.equal(monitored.some((row) => row.company_number === "00000003"), true);
    assert.equal(monitored.some((row) => row.company_number === "00000001"), false);
    dbVerify.closeDb();
  });
});