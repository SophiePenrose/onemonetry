import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getDailyAutoPullPlan } from "../daily-autopull-planner.js";
import {
  hasProcessedZipStore,
  isZipProcessed,
  loadProcessedZips,
  markZipProcessed,
  markZipsProcessed,
} from "../processed-zips.js";

let tempDir;
let previousDataDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "processed-zips-"));
  previousDataDir = process.env.PROCESSED_ZIPS_DATA_DIR;
  process.env.PROCESSED_ZIPS_DATA_DIR = tempDir;
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env.PROCESSED_ZIPS_DATA_DIR;
  } else {
    process.env.PROCESSED_ZIPS_DATA_DIR = previousDataDir;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("daily auto-pull planning", () => {
  it("baselines currently available daily files when no processed ZIP store exists", () => {
    const files = [
      { filename: "Accounts_Bulk_Data-2026-05-21.zip", processed: false },
      { filename: "Accounts_Bulk_Data-2026-05-20.zip", processed: false },
    ];

    const plan = getDailyAutoPullPlan(files, { processedStoreExists: false });

    assert.equal(plan.initializedBaseline, true);
    assert.deepEqual(plan.filesToProcess, []);
    assert.deepEqual(plan.filesToBaseline, files);
  });

  it("processes only unprocessed files after the baseline exists", () => {
    const files = [
      { filename: "Accounts_Bulk_Data-2026-05-21.zip", processed: false },
      { filename: "Accounts_Bulk_Data-2026-05-20.zip", processed: true },
    ];

    const plan = getDailyAutoPullPlan(files, { processedStoreExists: true });

    assert.equal(plan.initializedBaseline, false);
    assert.deepEqual(plan.filesToProcess, [files[0]]);
    assert.deepEqual(plan.filesToBaseline, []);
  });
});

describe("processed ZIP store", () => {
  it("persists single and bulk processed ZIP markers", () => {
    assert.equal(hasProcessedZipStore(), false);

    markZipProcessed("Accounts_Bulk_Data-2026-05-21.zip", { source: "daily:2026-05-21" });
    markZipsProcessed(["Accounts_Bulk_Data-2026-05-20.zip"], { source: "daily_autopull_baseline" });

    const processed = loadProcessedZips();
    assert.equal(hasProcessedZipStore(), true);
    assert.equal(isZipProcessed("Accounts_Bulk_Data-2026-05-21.zip"), true);
    assert.equal(processed["Accounts_Bulk_Data-2026-05-21.zip"].source, "daily:2026-05-21");
    assert.equal(processed["Accounts_Bulk_Data-2026-05-20.zip"].source, "daily_autopull_baseline");
  });
});
