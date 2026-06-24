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

function randomPort(base = 18900) {
  return base + Math.floor(Math.random() * 1000);
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
    throw new Error(`Gemini persistence test server failed to start. exit=${serverProcess.exitCode}. logs=${logs || "<none>"}`);
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
    request_id: "req_persistence_test_001",
    generated_at: new Date().toISOString(),
    workspace: {
      org: "Revolut Business",
      sheet_id: "sheet_test_1",
      sheet_tab: "queue_week_2026_w26",
      timezone: "Europe/London",
    },
    campaign: {
      campaign_id: "cmp_test_persistence_1",
      campaign_name: "Persistence Test Campaign",
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
            role: "Finance Director",
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

function buildGeminiHandoffResponsePayload(requestId) {
  return {
    contract_version: "gemini-handoff-v1",
    request_id: requestId,
    response_id: "resp_persistence_test_001",
    completed_at: new Date().toISOString(),
    status: "ok",
    sheet_write: {
      sheet_id: "sheet_test_1",
      sheet_tab: "queue_week_2026_w26",
      rows_written: 1,
      range: "queue_week_2026_w26!A2:AZ2",
    },
    sequence_outputs: [
      {
        company_number: "01234567",
        person_id: "st_001",
        sequence_id: "seq_01234567_st_001",
        qc: {
          passed: true,
          score: 0.91,
          notes: [],
        },
        steps: [
          {
            step_number: 1,
            step_type: "proof",
            day_offset: 0,
            subject: "Question about Example Co",
            body: "Example body",
            citations: ["prospeo.open_roles"],
          },
        ],
        yamm_rows: [
          {
            To: "",
            Subject: "Question about Example Co",
            Body: "Example body",
            Company: "Example Co Ltd",
            CompanyNumber: "01234567",
            PriorityRank: 1,
            SequenceId: "seq_01234567_st_001",
            StepNumber: 1,
            ApprovalStatus: "pending",
          },
        ],
      },
    ],
    errors: [],
  };
}

describe("Gemini handoff persistence across server restart", () => {
  it("keeps handoff request state after API restart", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-gemini-persist-"));
    const testDatabasePath = path.join(tempDir, "gemini-persistence.db");
    const testCompaniesPath = path.join(tempDir, "companies.json");
    fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);

    const requestId = "req_persistence_test_restart_001";
    const firstPort = randomPort();
    const secondPort = randomPort(19900);

    const first = await startApiServer({
      port: firstPort,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const accepted = await fetchJSON(first.baseUrl, "/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });

      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.status, "accepted");
      assert.equal(accepted.data.request_id, requestId);
    } finally {
      await first.stop();
    }

    const second = await startApiServer({
      port: secondPort,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const status = await fetchJSON(second.baseUrl, `/api/gemini/handoff/${requestId}`);
      assert.equal(status.status, 200);
      assert.equal(status.data.request_id, requestId);
      assert.equal(status.data.status, "accepted");
      assert.equal(typeof status.data.accepted_at, "string");
      assert.equal(status.data.retry_count, 0);
    } finally {
      await second.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps completed status and approval counts after API restart", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-gemini-persist-"));
    const testDatabasePath = path.join(tempDir, "gemini-persistence-complete.db");
    const testCompaniesPath = path.join(tempDir, "companies.json");
    fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);

    const requestId = "req_persistence_test_restart_complete_001";
    const firstPort = randomPort();
    const secondPort = randomPort(20900);

    const first = await startApiServer({
      port: firstPort,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const accepted = await fetchJSON(first.baseUrl, "/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });
      assert.equal(accepted.status, 202);

      const completed = await fetchJSON(first.baseUrl, `/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffResponsePayload(requestId)),
      });
      assert.equal(completed.status, 200);
      assert.equal(completed.data.status, "completed");

      const approvalsSynced = await fetchJSON(first.baseUrl, "/api/gemini/sheets/sync-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_version: "gemini-handoff-v1",
          request_id: requestId,
          approvals: [
            {
              sequence_id: "seq_01234567_st_001",
              step_number: 1,
              approval_status: "approved",
              approved_by: "Sophie",
              approved_at: new Date().toISOString(),
            },
            {
              sequence_id: "seq_01234567_st_001",
              step_number: 2,
              approval_status: "pending",
            },
          ],
        }),
      });

      assert.equal(approvalsSynced.status, 200);
      assert.equal(approvalsSynced.data.counts.total, 2);
      assert.equal(approvalsSynced.data.counts.approved, 1);
      assert.equal(approvalsSynced.data.counts.pending, 1);
    } finally {
      await first.stop();
    }

    const second = await startApiServer({
      port: secondPort,
      testDatabasePath,
      testCompaniesPath,
    });

    try {
      const status = await fetchJSON(second.baseUrl, `/api/gemini/handoff/${requestId}`);
      assert.equal(status.status, 200);
      assert.equal(status.data.request_id, requestId);
      assert.equal(status.data.status, "completed");
      assert.equal(typeof status.data.response_id, "string");
      assert.equal(typeof status.data.completed_at, "string");
      assert.equal(status.data.approval_counts.total, 2);
      assert.equal(status.data.approval_counts.approved, 1);
      assert.equal(status.data.approval_counts.pending, 1);
    } finally {
      await second.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
