import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceCompaniesPath = path.resolve(__dirname, "..", "companies.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(base = 21000) {
  return base + Math.floor(Math.random() * 2000);
}

async function waitForServerReady(baseUrl, serverProcess, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess?.exitCode !== null) return false;
    try {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      if (res.ok) return true;
    } catch {
      // Keep polling until timeout.
    }
    await sleep(200);
  }
  return false;
}

async function startApiServer({ port, testDatabasePath, testCompaniesPath }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverPath = path.resolve(__dirname, "..", "server.js");
  let logs = "";

  const serverProcess = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: testDatabasePath,
      COMPANIES_PATH: testCompaniesPath,
      ENABLE_GEMINI_HANDOFF_TRANSPORT: "true",
      ENABLE_GEMINI_HANDOFF_DEV_SIMULATOR: "true",
      GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN: "false",
      GEMINI_HANDOFF_TRANSPORT_TIMEOUT_MS: "5000",
      GEMINI_HANDOFF_TRANSPORT_URL: `${baseUrl}/api/dev/gemini/handoff-simulator`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout?.on("data", (chunk) => {
    logs += chunk?.toString() || "";
    if (logs.length > 6000) logs = logs.slice(-6000);
  });
  serverProcess.stderr?.on("data", (chunk) => {
    logs += chunk?.toString() || "";
    if (logs.length > 6000) logs = logs.slice(-6000);
  });

  const ready = await waitForServerReady(baseUrl, serverProcess);
  if (!ready) {
    throw new Error(`Gemini simulator test server failed to start. exit=${serverProcess.exitCode}. logs=${logs || "<none>"}`);
  }

  const stop = async () => {
    if (serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await sleep(350);
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
      }
    }
  };

  return { baseUrl, stop };
}

async function fetchJSON(baseUrl, route, options) {
  const res = await fetch(`${baseUrl}${route}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

function buildGeminiHandoffRequestPayload(overrides = {}) {
  return {
    contract_version: "gemini-handoff-v1",
    request_id: "req_dev_simulator_test_001",
    generated_at: new Date().toISOString(),
    workspace: {
      org: "Revolut Business",
      sheet_id: "sheet_test_1",
      sheet_tab: "queue_week_2026_w26",
      timezone: "Europe/London",
    },
    campaign: {
      campaign_id: "cmp_test_dev_sim_1",
      campaign_name: "Simulator Test Campaign",
      sequence_template: "v7",
      max_touches: 6,
      approval_required: true,
    },
    ranked_companies: [
      {
        rank: 1,
        company_number: "01234567",
        company_name: "Example Co Ltd",
        composite_score: 0.83,
        priority_band: "P1",
        score_breakdown: {
          product_fit: 0.36,
          commercial_value: 0.18,
          pain_strength: 0.14,
          urgency: 0.1,
          competitor_context: 0.05,
        },
        stakeholders: [
          {
            person_id: "st_001",
            full_name: "Jane Doe",
            role: "finance_director",
            persona_bucket: "finance_director",
            confidence: "medium",
          },
        ],
      },
    ],
    generation_policy: {
      provider: "gemini",
      voice_profile: "sophie_v7",
      forbidden_phrases_enforced: true,
      max_steps_per_sequence: 6,
      require_citations: true,
      fail_closed_on_qc: true,
    },
    ...overrides,
  };
}

describe("Gemini handoff dev simulator transport", () => {
  it("completes handoff through local simulator endpoint when transport is enabled", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-gemini-dev-sim-"));
    const testDatabasePath = path.join(tempDir, "gemini-dev-simulator.db");
    const testCompaniesPath = path.join(tempDir, "companies.json");
    fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);

    const requestId = "req_dev_simulator_flow_001";
    const port = randomPort();
    const server = await startApiServer({
      port,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const accepted = await fetchJSON(server.baseUrl, "/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });

      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.request_id, requestId);
      assert.equal(accepted.data.status, "completed");
      assert.equal(accepted.data.next_action, "request_completed");
      assert.equal(accepted.data.transport?.attempted, true);
      assert.equal(accepted.data.transport?.success, true);
      assert.equal(typeof accepted.data.response_id, "string");

      const status = await fetchJSON(server.baseUrl, `/api/gemini/handoff/${requestId}`);
      assert.equal(status.status, 200);
      assert.equal(status.data.status, "completed");
      assert.equal(status.data.request_id, requestId);
      assert.equal(typeof status.data.response_id, "string");
      assert.equal(typeof status.data.completed_at, "string");
    } finally {
      await server.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-dispatches on retry and keeps request completed via simulator", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-gemini-dev-sim-"));
    const testDatabasePath = path.join(tempDir, "gemini-dev-simulator-retry.db");
    const testCompaniesPath = path.join(tempDir, "companies.json");
    fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);

    const requestId = "req_dev_simulator_retry_001";
    const port = randomPort(24000);
    const server = await startApiServer({
      port,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const accepted = await fetchJSON(server.baseUrl, "/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });

      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.status, "completed");

      const retry = await fetchJSON(server.baseUrl, `/api/gemini/handoff/${requestId}/retry`, {
        method: "POST",
      });

      assert.equal(retry.status, 202);
      assert.equal(retry.data.request_id, requestId);
      assert.equal(retry.data.status, "completed");
      assert.equal(typeof retry.data.retry_count, "number");
      assert.equal(retry.data.retry_count >= 1, true);
      assert.equal(retry.data.transport?.attempted, true);
      assert.equal(retry.data.transport?.success, true);

      const status = await fetchJSON(server.baseUrl, `/api/gemini/handoff/${requestId}`);
      assert.equal(status.status, 200);
      assert.equal(status.data.status, "completed");
      assert.equal(status.data.retry_count >= 1, true);
    } finally {
      await server.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits multi-step YAMM rows and summary for simulator responses", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-gemini-dev-sim-"));
    const testDatabasePath = path.join(tempDir, "gemini-dev-simulator-steps.db");
    const testCompaniesPath = path.join(tempDir, "companies.json");
    fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);

    const requestId = "req_dev_simulator_steps_001";
    const stepCount = 5;
    const port = randomPort(26000);
    const server = await startApiServer({
      port,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const accepted = await fetchJSON(server.baseUrl, "/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({
          request_id: requestId,
          campaign: {
            campaign_id: "cmp_test_dev_sim_steps",
            campaign_name: "Simulator Step Depth Campaign",
            sequence_template: "v7",
            max_touches: stepCount,
            approval_required: true,
          },
          generation_policy: {
            provider: "gemini",
            voice_profile: "sophie_v7",
            forbidden_phrases_enforced: true,
            max_steps_per_sequence: stepCount,
            require_citations: true,
            fail_closed_on_qc: true,
          },
        })),
      });

      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.request_id, requestId);
      assert.equal(accepted.data.status, "completed");

      const rows = await fetchJSON(server.baseUrl, `/api/gemini/handoff/${requestId}/yamm-rows`);
      assert.equal(rows.status, 200);
      assert.equal(Array.isArray(rows.data.rows), true);
      assert.equal(rows.data.rows.length, stepCount);
      assert.deepEqual(rows.data.rows.map((row) => Number(row.StepNumber)), [1, 2, 3, 4, 5]);
      assert.deepEqual(rows.data.rows.map((row) => String(row.StepType || "")), ["proof", "nudge_1", "depth", "nudge_2", "provocation"]);
      assert.equal(rows.data.rows.every((row) => String(row.ApprovalStatus || "").toLowerCase() === "pending"), true);
      assert.equal(rows.data.rows.every((row) => Number.isInteger(Number(row.DayOffset))), true);
      assert.equal(rows.data.rows.every((row) => String(row.FirstName || "").length > 0), true);
      assert.equal(rows.data.rows.every((row) => String(row.Stakeholder || "").length > 0), true);
      assert.equal(rows.data.rows.every((row) => String(row.StakeholderRole || "").length > 0), true);
      assert.equal(rows.data.rows.every((row) => typeof row.RelevantIndividuals === "string"), true);
      assert.equal(rows.data.rows.every((row) => typeof row.RelevantIndividualsJSON === "string"), true);
      assert.equal(rows.data.rows.every((row) => Array.isArray(JSON.parse(row.RelevantIndividualsJSON || "[]"))), true);

      const summary = await fetchJSON(server.baseUrl, `/api/gemini/handoff/${requestId}/yamm-rows/summary`);
      assert.equal(summary.status, 200);
      assert.equal(summary.data.totals.rows, stepCount);
      assert.equal(summary.data.by_approval_status.pending, stepCount);
      assert.equal(summary.data.totals.send_eligible, 0);
    } finally {
      await server.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
