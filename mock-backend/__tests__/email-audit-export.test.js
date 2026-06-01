import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 20080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-email-audit-test-"));
const testDatabasePath = path.join(tempDir, "email-audit-tests.db");
const sourceCompaniesPath = path.resolve(__dirname, "..", "companies.json");
const testCompaniesPath = path.join(tempDir, "companies.json");

let serverProcess = null;
let serverLogs = "";

function appendServerLog(chunk) {
  if (!chunk) return;
  serverLogs += chunk.toString();
  if (serverLogs.length > 8000) {
    serverLogs = serverLogs.slice(-8000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess?.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/api/auth/status`);
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  return false;
}

async function fetchJSON(urlPath, options) {
  const res = await fetch(`${BASE}${urlPath}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);
  const serverPath = path.resolve(__dirname, "..", "server.js");
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(TEST_PORT),
      DATABASE_PATH: testDatabasePath,
      COMPANIES_PATH: testCompaniesPath,
      OPENAI_API_KEY: "",
      DETERMINISTIC_TIME: "2026-01-15T08:30:00.000Z",
      DETERMINISTIC_SEED: "email-audit-test-seed",
      DETERMINISTIC_METRIC_SEED: "email-audit-test-metric-seed",
      DETERMINISTIC_SEQUENCE_MODE: "1",
      DETERMINISTIC_METRIC_MODE: "1",
      DETERMINISTIC_TEST_MODE: "1",
      DETERMINISTIC_COMPANY_TIME: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", appendServerLog);
  serverProcess.stderr?.on("data", appendServerLog);

  const ready = await waitForServerReady();
  if (!ready) {
    throw new Error(
      `API test server did not start on port ${TEST_PORT}. `
      + `exitCode=${serverProcess?.exitCode ?? "running"}. `
      + `Recent logs:\n${serverLogs || "<none>"}`
    );
  }
});

after(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await sleep(400);
    if (!serverProcess.killed) {
      serverProcess.kill("SIGKILL");
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("writes email audit records for exported reviewed steps", async () => {
  const createdCompany = await fetchJSON("/api/companies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Email Audit Test Co",
      industry: "Technology",
      segment: "Mid-Market",
      turnover: 18000000,
    }),
  });
  assert.equal(createdCompany.status, 201);
  const companyId = createdCompany.data.company?.id;
  assert.ok(companyId);

  const generated = await fetchJSON("/api/email/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_id: companyId,
      stakeholder_name: "Taylor Reed",
      stakeholder_role: "Finance Director",
      stakeholder_email: "taylor.reed@example.com",
      motion: "FX",
    }),
  });
  assert.equal(generated.status, 201);
  const sequenceId = generated.data.sequence_id;
  assert.ok(sequenceId);

  const sequence = await fetchJSON(`/api/email/sequence/${sequenceId}`);
  assert.equal(sequence.status, 200);
  assert.ok(Array.isArray(sequence.data.sequence?.steps));

  for (const step of sequence.data.sequence.steps) {
    const reviewed = await fetchJSON(`/api/email/sequence/${sequenceId}/step/${step.step_number}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(reviewed.status, 200);
  }

  const exported = await fetchJSON(`/api/email/export/json/${sequenceId}?send_time=08:30`);
  assert.equal(exported.status, 200);
  assert.ok(Array.isArray(exported.data.raw_rows));
  assert.ok(exported.data.raw_rows.length > 0);

  const audit = await fetchJSON(`/api/email/audit/${sequenceId}`);
  assert.equal(audit.status, 200);
  assert.equal(audit.data.sequence_id, sequenceId);
  assert.ok(Array.isArray(audit.data.records));
  assert.equal(audit.data.records.length, exported.data.raw_rows.length);

  for (const record of audit.data.records) {
    assert.equal(typeof record.subject, "string");
    assert.ok(record.subject.trim().length > 0);
    assert.equal(typeof record.body, "string");
    assert.ok(record.body.trim().length > 0);
    assert.ok(Number.isInteger(record.step_number));
    assert.equal(typeof record.validation_results, "object");
    assert.ok(record.validation_results);
    assert.equal(typeof record.consent_status, "object");
    assert.ok(record.consent_status);
  }
});
