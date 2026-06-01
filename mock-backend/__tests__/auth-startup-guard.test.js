import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-startup-guard-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "auth-startup-guard.db");

const db = await import("../db.js");
const { authStartupRefusalReason } = await import("../server.js");

after(() => {
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

describe("authStartupRefusalReason", () => {
  it("returns a refusal message in production when auth is not configured", () => {
    const reason = authStartupRefusalReason({ NODE_ENV: "production" }, false);
    assert.equal(typeof reason, "string");
    assert.notEqual(reason, null);
  });

  it("returns null in production when auth is configured", () => {
    assert.equal(authStartupRefusalReason({ NODE_ENV: "production" }, true), null);
  });

  it("returns null in non-production environments when auth is not configured", () => {
    assert.equal(authStartupRefusalReason({ NODE_ENV: "test" }, false), null);
    assert.equal(authStartupRefusalReason({ NODE_ENV: "development" }, false), null);
  });
});
