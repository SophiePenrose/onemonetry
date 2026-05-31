import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const originalFetch = global.fetch;
const originalEnv = {
  ENDOLE_API_KEY: process.env.ENDOLE_API_KEY,
  ENDOLE_URL_TEMPLATE: process.env.ENDOLE_URL_TEMPLATE,
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-connectors-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "signal-connectors.db");

const db = await import("../db.js");
const connectors = await import("../signal-connectors.js");

after(() => {
  global.fetch = originalFetch;
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("external signal connectors", () => {
  it("returns no_connectors_configured when templates are missing", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;

    const result = await connectors.syncExternalSignals({ companyNumber: "92000010" });

    assert.equal(result.status, "no_connectors_configured");
    assert.equal(result.updated, false);
  });

  it("syncs configured connector payload into ownership and hiring envelopes", async () => {
    process.env.ENDOLE_API_KEY = "test-endole-key";
    process.env.ENDOLE_URL_TEMPLATE = "https://signals.example.test/company/{company_number}";

    global.fetch = async (url) => {
      assert.equal(String(url), "https://signals.example.test/company/99111111");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            shareholders: [
              {
                name: "Acme Holdings BV",
                type: "corporate entity",
                country_registered: "Netherlands",
                share_percent: 60,
              },
            ],
            jobs: [
              { title: "Treasury Manager" },
              { title: "Finance Director" },
            ],
            monthly_visits: 240000,
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111111",
      companyName: "Example Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded, 1);

    const ownership = db.getSetting("ownership_99111111", null);
    const hiring = db.getSetting("hiring_signals_99111111", null);

    assert.equal(ownership.non_uk_significant_corporate_controllers_count >= 1, true);
    assert.equal(hiring.total_open_roles >= 2, true);
  });
});
