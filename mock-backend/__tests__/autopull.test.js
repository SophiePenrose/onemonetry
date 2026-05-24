import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getDailyAutoPullPlan } from "../daily-autopull-planner.js";
import { getMonthlyAutoPullPlan } from "../monthly-autopull-planner.js";
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

describe("monthly auto-pull planning", () => {
  it("processes unprocessed archive files inside the latest 24-month backfill window", () => {
    const files = [
      ...Array.from({ length: 13 }, (_, index) => ({
        filename: `current-${index + 1}.zip`,
        source: "current",
        processed: false,
      })),
      ...Array.from({ length: 11 }, (_, index) => ({
        filename: `archive-in-window-${index + 1}.zip`,
        source: "archive",
        processed: false,
      })),
      {
        filename: "archive-outside-window.zip",
        source: "archive",
        processed: false,
      },
    ];

    const plan = getMonthlyAutoPullPlan(files);

    assert.equal(plan.filesToCheck.length, 24);
    assert.equal(plan.filesToProcess.length, 24);
    assert.ok(plan.filesToProcess.some((file) => file.source === "archive"));
    assert.equal(
      plan.filesToProcess.some((file) => file.filename === "archive-outside-window.zip"),
      false
    );
  });

  it("skips processed files within the latest 24-month backfill window", () => {
    const files = [
      { filename: "Accounts_Monthly_Data-April2026.zip", source: "current", processed: true },
      { filename: "Accounts_Monthly_Data-March2026.zip", source: "current", processed: false },
      { filename: "Accounts_Monthly_Data-February2026.zip", source: "archive", processed: false },
    ];

    const plan = getMonthlyAutoPullPlan(files);

    assert.deepEqual(plan.filesToProcess, [files[1], files[2]]);
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
