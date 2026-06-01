import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

function loadModuleFresh(dbPath) {
  process.env.DATABASE_PATH = dbPath;
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return import(`../email-sequences.js?test=${stamp}`);
}

function makeTmpDbPath(name) {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function parseSqliteDateTime(value) {
  return Date.parse(String(value).replace(" ", "T") + "Z");
}

test("updateStepContent touch moves older sequence to top by updated_at", async () => {
  const dbPath = makeTmpDbPath("email-seq-touch-sort");
  const mod = await loadModuleFresh(dbPath);
  const sqlite = new Database(dbPath);

  const first = mod.saveGeneratedSequence({
    companyId: "co-touch-sort",
    companyName: "Atlas",
    stakeholderName: "Jordan",
    stakeholderRole: "COO",
    steps: [{ step_number: 1, subject: "First", body: "Body first", send_delay_days: 0 }],
  });
  const second = mod.saveGeneratedSequence({
    companyId: "co-touch-sort",
    companyName: "Atlas",
    stakeholderName: "Casey",
    stakeholderRole: "VP Operations",
    steps: [{ step_number: 1, subject: "Second", body: "Body second", send_delay_days: 0 }],
  });

  sqlite.prepare("UPDATE email_sequences SET created_at = ?, updated_at = ? WHERE id = ?").run("2024-01-01 00:00:00", "2024-01-01 00:00:00", first.id);
  sqlite.prepare("UPDATE email_sequences SET created_at = ?, updated_at = ? WHERE id = ?").run("2024-01-02 00:00:00", "2024-01-02 00:00:00", second.id);

  const initial = mod.getSequencesForCompany("co-touch-sort");
  assert.equal(initial[0].id, second.id);
  assert.equal(initial[1].id, first.id);

  mod.updateStepContent(first.id, 1, "First updated", "Body first updated");
  const touchedFirst = mod.getSequence(first.id);
  assert.ok(parseSqliteDateTime(touchedFirst.updated_at) > parseSqliteDateTime("2024-01-01 00:00:00"));

  const reordered = mod.getSequencesForCompany("co-touch-sort");
  assert.equal(reordered[0].id, first.id);
  assert.equal(reordered[1].id, second.id);

  sqlite.close();
  fs.rmSync(dbPath, { force: true });
});

test("markStepReviewed and updateStepStatus both advance sequence updated_at", async () => {
  const dbPath = makeTmpDbPath("email-seq-touch-actions");
  const mod = await loadModuleFresh(dbPath);
  const sqlite = new Database(dbPath);

  const created = mod.saveGeneratedSequence({
    companyId: "co-touch-actions",
    companyName: "Touch Co",
    stakeholderName: "Sam",
    stakeholderRole: "COO",
    steps: [{ step_number: 1, subject: "Initial", body: "Body", send_delay_days: 0 }],
  });

  sqlite.prepare("UPDATE email_sequences SET updated_at = ? WHERE id = ?").run("2024-01-01 00:00:00", created.id);
  mod.markStepReviewed(created.id, 1);
  const reviewed = mod.getSequence(created.id);
  assert.ok(parseSqliteDateTime(reviewed.updated_at) > parseSqliteDateTime("2024-01-01 00:00:00"));

  sqlite.prepare("UPDATE email_sequences SET updated_at = ? WHERE id = ?").run("2024-01-01 00:00:00", created.id);
  mod.updateStepStatus(created.id, 1, "sent");
  const statusUpdated = mod.getSequence(created.id);
  assert.ok(parseSqliteDateTime(statusUpdated.updated_at) > parseSqliteDateTime("2024-01-01 00:00:00"));

  sqlite.close();
  fs.rmSync(dbPath, { force: true });
});
