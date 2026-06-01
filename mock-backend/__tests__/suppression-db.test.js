import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDatabasePath = process.env.DATABASE_PATH;
const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { fn(); } catch { /* noop */ }
  }

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

async function loadDbModule() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-suppression-db-"));
  const dbPath = path.join(tempDir, "suppression.db");
  process.env.DATABASE_PATH = dbPath;

  const dbModule = await import(`../db.js?suppression_db=${Date.now()}_${Math.random()}`);
  cleanups.push(() => dbModule.closeDb());
  cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return dbModule;
}

describe("suppression db helpers", () => {
  it("normalizes, dedupes, lists, and removes suppressions", async () => {
    const db = await loadDbModule();

    const emailRow = db.addSuppression({
      type: "email",
      value: "Foo@Bar.com",
      reason: "opt_out",
      source: "csv_upload",
    });
    assert.ok(emailRow?.id);

    const emailMatch = db.isContactSuppressed({ email: "foo@bar.com" });
    assert.ok(emailMatch);
    assert.equal(emailMatch.type, "email");

    const companyRow = db.addSuppression({ type: "company_number", value: "1261512" });
    assert.ok(companyRow?.id);
    const companyMatch = db.isContactSuppressed({ company_number: "01261512" });
    assert.ok(companyMatch);
    assert.equal(companyMatch.type, "company_number");

    const duplicateEmail = db.addSuppression({
      type: "email",
      value: "foo@bar.com",
      reason: "dnc",
      source: "manual_flag",
    });
    assert.equal(duplicateEmail.id, emailRow.id);
    assert.equal(db.getSuppressionCount(), 2);

    const listed = db.listSuppressions();
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, companyRow.id);
    assert.equal(listed[1].id, emailRow.id);

    assert.equal(db.removeSuppression(companyRow.id), 1);
    assert.equal(db.getSuppressionCount(), 1);
  });

  it("returns null for invalid suppression values", async () => {
    const db = await loadDbModule();
    assert.equal(db.addSuppression({ type: "email", value: "" }), null);
  });
});
