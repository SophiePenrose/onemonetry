import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-queue-tests-"));

process.env.DATABASE_PATH = path.join(tempDir, "queue.db");
delete process.env.OPENAI_API_KEY;

const db = await import("../db.js");
const queue = await import("../analysis-queue.js");

after(() => {
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }

  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

describe("analysis queue persistence", () => {
  it("enqueues, claims, and marks a queue item as ready", () => {
    const queued = db.enqueueAnalysisQueueItem("00004567", "Acme Holdings", "unit_test");
    assert.equal(queued, true);

    const claimed = db.claimNextAnalysisQueueItem();
    assert.equal(claimed.company_number, "00004567");
    assert.equal(claimed.status, "processing");

    db.markAnalysisQueueItemReady("00004567", "Acme Holdings");
    const item = db.getAnalysisQueueItem("00004567");
    assert.equal(item.status, "ready");
    assert.equal(item.company_name, "Acme Holdings");
  });

  it("processes queued items and stores fallback analysis when no OpenAI key is configured", async () => {
    db.enqueueAnalysisQueueItem("00007890", "Queue Co", "unit_test");

    const result = await queue.processAnalysisQueueBatch({ batchSize: 1 });
    assert.equal(result.processed, 1);

    const item = db.getAnalysisQueueItem("00007890");
    assert.equal(item.status, "ready");

    const analysis = db.getSetting("analysis_00007890", null);
    assert.equal(!!analysis, true);
    assert.equal(typeof analysis.summary, "string");
  });

  it("processes an explicitly requested queued company without consuming a different queued item", async () => {
    db.enqueueAnalysisQueueItem("00001111", "Older Queue Co", "unit_test");
    db.enqueueAnalysisQueueItem("00002222", "Target Queue Co", "manual_retry");

    const result = await queue.processAnalysisQueueItem("00002222");
    assert.equal(result.processed, 1);
    assert.equal(result.items[0].company_number, "00002222");
    assert.equal(result.items[0].status, "ready");

    const target = db.getAnalysisQueueItem("00002222");
    const older = db.getAnalysisQueueItem("00001111");
    assert.equal(target.status, "ready");
    assert.equal(older.status, "queued");
  });
});
