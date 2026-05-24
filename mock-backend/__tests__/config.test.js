import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

describe("runtime configuration", () => {
  afterEach(() => {
    delete process.env.COMPANIES_HOUSE_API_KEY;
  });

  it("uses DATABASE_PATH for SQLite storage and creates the parent directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "database-path-"));
    const databasePath = path.join(tempDir, "nested", "onemonetry.db");

    try {
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import fs from 'fs'; import { DB_PATH, closeDb } from './db.js'; console.log(JSON.stringify({ DB_PATH, exists: fs.existsSync(DB_PATH) })); closeDb();",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_PATH: databasePath },
          encoding: "utf-8",
        }
      );

      const result = JSON.parse(output);
      assert.equal(result.DB_PATH, databasePath);
      assert.equal(result.exists, true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("trims whitespace from COMPANIES_HOUSE_API_KEY before building auth headers", async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    process.env.COMPANIES_HOUSE_API_KEY = " test-key \n";

    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.toString().includes("/filing-history")) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          company_name: "TEST PLC",
          company_status: "active",
          type: "plc",
          date_of_creation: "2000-01-01",
        }),
      };
    };

    try {
      const moduleUrl = `${pathToFileURL(path.join(process.cwd(), "companies-house.js")).href}?t=${Date.now()}`;
      const { lookupCompany } = await import(moduleUrl);
      await lookupCompany("445790");

      const authHeader = calls[0].options.headers.Authorization;
      assert.equal(Buffer.from(authHeader.replace("Basic ", ""), "base64").toString("utf-8"), "test-key:");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
