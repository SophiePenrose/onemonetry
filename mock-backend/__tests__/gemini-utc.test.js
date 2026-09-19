import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "gemini-utc-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { default: db, createOrGetGeminiHandoffRequest, getGeminiHandoffRequest, listGeminiHandoffRequests } = await import("../db.js");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

it("serializes legacy SQLite retry dates as UTC in both detail and filtered list results", () => {
  createOrGetGeminiHandoffRequest({ request_id: "utc-legacy", contract_version: "gemini-handoff-v1" });
  db.prepare("UPDATE gemini_handoff_requests SET last_retry_requested_at = ?, updated_at = ? WHERE request_id = ?")
    .run("2026-09-19 09:41:02", "2026-09-19 09:41:02", "utc-legacy");
  const previous = process.env.TZ;
  try {
    for (const zone of ["Europe/Vienna", "America/New_York", "UTC"]) {
      process.env.TZ = zone;
      const record = getGeminiHandoffRequest("utc-legacy");
      assert.equal(record.last_retry_requested_at, "2026-09-19T09:41:02Z");
      const cutoff = new Date(Date.parse(record.last_retry_requested_at) + 1000).toISOString();
      const rows = listGeminiHandoffRequests({ beforeLastRetryRequestedAt: cutoff });
      assert.equal(rows.length, 1); assert.equal(rows[0].last_retry_requested_at, record.last_retry_requested_at);
      assert.equal(rows[0].updated_at, "2026-09-19T09:41:02Z");
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
