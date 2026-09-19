import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "auth-expiry-"));
process.env.DATABASE_PATH = path.join(dir, "test.db");
const { default: db } = await import("../db.js");
const { validateSession, cleanExpiredSessions } = await import("../auth.js");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
it("rejects and cleans sessions expired earlier today while preserving future sessions", () => {
  const insert = db.prepare("INSERT INTO auth_sessions (token, expires_at) VALUES (?, ?)");
  insert.run("expired", new Date(Date.now() - 1000).toISOString()); insert.run("future", new Date(Date.now() + 60000).toISOString()); insert.run("invalid", "invalid-date");
  assert.equal(validateSession("expired"), false); assert.equal(validateSession("invalid"), false); assert.equal(validateSession("future"), true);
  cleanExpiredSessions(); assert.deepEqual(db.prepare("SELECT token FROM auth_sessions").all(), [{ token: "future" }]);
});
