import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDatabasePath = process.env.DATABASE_PATH;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalTimeout = process.env.LLM_REQUEST_TIMEOUT_MS;
const originalFetch = globalThis.fetch;

afterEach(() => {
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

  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }

  if (originalTimeout === undefined) {
    delete process.env.LLM_REQUEST_TIMEOUT_MS;
  } else {
    process.env.LLM_REQUEST_TIMEOUT_MS = originalTimeout;
  }

  globalThis.fetch = originalFetch;
});

describe("llm timeout fallback", () => {
  it("returns deterministic fallback with timeout reason when upstream stalls", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-llm-timeout-"));
    const dbPath = path.join(tempDir, "data", "test.db");

    process.env.DATABASE_PATH = dbPath;
    process.env.OPENAI_API_KEY = "sk-timeout-test";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.LLM_REQUEST_TIMEOUT_MS = "15";

    globalThis.fetch = (url, options = {}) => {
      const target = String(url || "");
      if (target.includes("/chat/completions")) {
        return new Promise((_resolve, reject) => {
          const rejectOnAbort = () => {
            const error = new Error("request aborted");
            error.name = "AbortError";
            reject(error);
          };

          if (options.signal?.aborted) {
            rejectOnAbort();
            return;
          }

          options.signal?.addEventListener("abort", rejectOnAbort, { once: true });
        });
      }

      return Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => "",
      });
    };

    const cacheBust = Date.now();
    const dbModule = await import(`../db.js?llm_timeout_test=${cacheBust}`);
    const llmModule = await import(`../llm.js?llm_timeout_test=${cacheBust}`);

    try {
      dbModule.upsertMonitoredCompany({
        company_number: "01234567",
        company_name: "Timeout Co",
        latest_turnover: 12000000,
        status: "active",
        source: "csv_import",
      });

      dbModule.upsertFiling({
        company_number: "01234567",
        filing_date: "2025-03-31",
        filing_type: "accounts",
        barcode: "timeout-doc",
        turnover: 12000000,
        source: "csv_import",
        raw_data: "Revenue increased and the group expanded international operations with more supplier payments.",
      });

      const analysis = await llmModule.analyseCompany("01234567", "Timeout Co", 12000000);
      assert.equal(analysis.source, "fallback");
      assert.match(String(analysis.error || ""), /timed out/i);
    } finally {
      dbModule.closeDb();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
