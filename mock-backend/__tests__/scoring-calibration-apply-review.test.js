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
const applyScriptPath = path.join(repoRoot, "scripts", "scoring-calibration-apply-review.mjs");

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    fs.rmSync(next, { recursive: true, force: true });
  }
});

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoring-apply-review-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeCsv(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.join("\n")}\n`, "utf8");
}

function runApplyReview(args) {
  return spawnSync(process.execPath, [applyScriptPath, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

function runApplyReviewExpectFailure(args) {
  const result = runApplyReview(args);
  if (result.status === 0) {
    assert.fail("Expected apply-review command to fail");
  }

  return [String(result.stdout || ""), String(result.stderr || "")].join("\n");
}

describe("scoring calibration apply-review script", () => {
  it("updates expected_order from expected_rank and appends unranked companies", () => {
    const tempDir = createTempDir();
    const casesPath = path.join(tempDir, "cases.json");
    const reviewCsvPath = path.join(tempDir, "review.csv");
    const outputPath = path.join(tempDir, "cases.updated.json");

    writeJson(casesPath, {
      label: "unit-test-case",
      metadata: { owner: "unit-test" },
      company_numbers: ["001", "002", "003"],
      expected_order: ["001", "002", "003"],
    });

    writeCsv(reviewCsvPath, [
      "company_number,model_rank,expected_rank,notes",
      "002,2,1,highest priority",
      "001,1,2,second",
      "003,3,,not yet reviewed",
    ]);

    const result = runApplyReview([
      "--cases", casesPath,
      "--review-csv", reviewCsvPath,
      "--out", outputPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(String(result.stdout || ""), /Ranked companies applied: 2\/3/);
    assert.match(String(result.stdout || ""), /Unranked companies appended: 1/);

    const updated = JSON.parse(fs.readFileSync(outputPath, "utf8"));

    assert.deepEqual(updated.expected_order, ["002", "001", "003"]);
    assert.equal(updated.metadata.ranked_count, 2);
    assert.equal(updated.metadata.total_company_count, 3);
    assert.equal(typeof updated.metadata.review_applied_at, "string");
    assert.ok(updated.metadata.review_csv);
  });

  it("fails when review CSV contains company numbers absent from the case file", () => {
    const tempDir = createTempDir();
    const casesPath = path.join(tempDir, "cases.json");
    const reviewCsvPath = path.join(tempDir, "review.csv");

    writeJson(casesPath, {
      label: "unit-test-case",
      company_numbers: ["001"],
      expected_order: ["001"],
    });

    writeCsv(reviewCsvPath, [
      "company_number,expected_rank",
      "999,1",
    ]);

    const failureOutput = runApplyReviewExpectFailure([
      "--cases", casesPath,
      "--review-csv", reviewCsvPath,
      "--in-place",
    ]);

    assert.match(failureOutput, /Review CSV includes companies not in case file/);
  });

  it("fails when expected_rank is non-numeric", () => {
    const tempDir = createTempDir();
    const casesPath = path.join(tempDir, "cases.json");
    const reviewCsvPath = path.join(tempDir, "review.csv");

    writeJson(casesPath, {
      label: "unit-test-case",
      company_numbers: ["001"],
      expected_order: ["001"],
    });

    writeCsv(reviewCsvPath, [
      "company_number,expected_rank",
      "001,first",
    ]);

    const failureOutput = runApplyReviewExpectFailure([
      "--cases", casesPath,
      "--review-csv", reviewCsvPath,
    ]);

    assert.match(failureOutput, /Invalid expected_rank rows/);
  });
});