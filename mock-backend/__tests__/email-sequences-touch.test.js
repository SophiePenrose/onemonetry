import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Use ONE temp DB for the whole file. DATABASE_PATH must be set before db.js is
// imported so its module-level better-sqlite3 connection points at this file.
// The previous version reloaded email-sequences.js with a `?test=` query string
// per test, but that does not re-import the db.js singleton, so the module kept
// the first test's connection (bound to a temp DB the first test then deleted),
// causing the second test to fail with "no such table: email_sequences".
const dbPath = path.join(
  os.tmpdir(),
  `email-sequences-touch-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
);
process.env.DATABASE_PATH = dbPath;

const db = (await import("../db.js")).default;
const {
  saveGeneratedSequence,
  getSequence,
  getSequencesForCompany,
  updateStepContent,
  markStepReviewed,
  updateStepStatus,
} = await import("../email-sequences.js");

after(() => {
  try {
    db.close();
  } catch {
    // ignore close errors during teardown
  }
  fs.rmSync(dbPath, { force: true });
});

function parseSqliteDateTime(value) {
  return Date.parse(`${String(value).replace(" ", "T")}Z`);
}

// Use the module's own connection so writes are visible to the functions under test.
function setSequenceTimestamps(id, createdAt, updatedAt) {
  db.prepare("UPDATE email_sequences SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(createdAt, updatedAt, id);
}

function createSequence(companyId, stakeholderName) {
  const seq = saveGeneratedSequence({
    companyId,
    companyName: "Atlas",
    stakeholderName,
    stakeholderRole: "COO",
    steps: [{ step_number: 1, subject: "Subject", body: "Body", send_delay_days: 0 }],
  });
  assert.ok(seq && seq.id, "expected saveGeneratedSequence to return an id");
  return seq;
}

test("updateStepContent bumps updated_at and floats the edited sequence to the top", () => {
  const companyId = "co-touch-sort";
  const first = createSequence(companyId, "Jordan");
  const second = createSequence(companyId, "Casey");

  setSequenceTimestamps(first.id, "2024-01-01 00:00:00", "2024-01-01 00:00:00");
  setSequenceTimestamps(second.id, "2024-01-02 00:00:00", "2024-01-02 00:00:00");

  const initial = getSequencesForCompany(companyId);
  assert.equal(initial[0].id, second.id);
  assert.equal(initial[1].id, first.id);

  updateStepContent(first.id, 1, "Subject updated", "Body updated");

  const touched = getSequence(first.id);
  assert.ok(
    parseSqliteDateTime(touched.updated_at) > parseSqliteDateTime("2024-01-01 00:00:00"),
    "updateStepContent should advance the parent sequence updated_at"
  );

  const reordered = getSequencesForCompany(companyId);
  assert.equal(reordered[0].id, first.id);
  assert.equal(reordered[1].id, second.id);
});

test("markStepReviewed and updateStepStatus both advance updated_at", () => {
  const companyId = "co-touch-actions";
  const seq = createSequence(companyId, "Sam");

  setSequenceTimestamps(seq.id, "2024-01-01 00:00:00", "2024-01-01 00:00:00");
  markStepReviewed(seq.id, 1);
  assert.ok(
    parseSqliteDateTime(getSequence(seq.id).updated_at) > parseSqliteDateTime("2024-01-01 00:00:00"),
    "markStepReviewed should advance updated_at"
  );

  setSequenceTimestamps(seq.id, "2024-01-01 00:00:00", "2024-01-01 00:00:00");
  updateStepStatus(seq.id, 1, "sent");
  assert.ok(
    parseSqliteDateTime(getSequence(seq.id).updated_at) > parseSqliteDateTime("2024-01-01 00:00:00"),
    "updateStepStatus should advance updated_at"
  );
});
