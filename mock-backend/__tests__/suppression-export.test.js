import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 21080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-suppression-export-test-"));
const testDatabasePath = path.join(tempDir, "suppression-export-tests.db");
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
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${urlPath} (status ${res.status}), got: ${text.slice(0, 200)}`);
  }
  return { status: res.status, data };
}

async function createReviewedSequence({ name, email, motion }) {
  const createdCompany = await fetchJSON("/api/companies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      industry: "Technology",
      segment: "Mid-Market",
      turnover: 22000000,
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
      stakeholder_name: "Jordan Blake",
      stakeholder_role: "Finance Director",
      stakeholder_email: email,
      motion,
    }),
  });
  assert.equal(generated.status, 201);
  const sequenceId = generated.data.sequence_id;
  assert.ok(sequenceId);

  const sequence = await fetchJSON(`/api/email/sequence/${sequenceId}`);
  assert.equal(sequence.status, 200);
  for (const step of sequence.data.sequence.steps || []) {
    const reviewed = await fetchJSON(`/api/email/sequence/${sequenceId}/step/${step.step_number}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(reviewed.status, 200);
  }

  return { sequenceId };
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
      DETERMINISTIC_SEED: "suppression-export-test-seed",
      DETERMINISTIC_METRIC_SEED: "suppression-export-test-metric-seed",
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

test("suppressed recipients are skipped at export while still audited", async () => {
  const blocked = await createReviewedSequence({
    name: "Suppression Blocked Co",
    email: "block.me@example.com",
    motion: "FX",
  });

  const suppression = await fetchJSON("/api/suppression", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "block.me@example.com" }),
  });
  assert.equal(suppression.status, 200);

  const blockedExport = await fetchJSON(`/api/email/export/json/${blocked.sequenceId}?send_time=08:30`);
  assert.equal(blockedExport.status, 200);
  assert.deepEqual(blockedExport.data.raw_rows, []);
  assert.equal(blockedExport.data.metadata?.suppressed, true);

  const blockedAudit = await fetchJSON(`/api/email/audit/${blocked.sequenceId}`);
  assert.equal(blockedAudit.status, 200);
  assert.ok(blockedAudit.data.records.length > 0);
  for (const record of blockedAudit.data.records) {
    assert.equal(record.consent_status?.suppressed, true);
  }

  const clear = await createReviewedSequence({
    name: "Suppression Clear Co",
    email: "allowed.person@example.com",
    motion: "FX",
  });

  const clearExport = await fetchJSON(`/api/email/export/json/${clear.sequenceId}?send_time=08:30`);
  assert.equal(clearExport.status, 200);
  assert.ok(Array.isArray(clearExport.data.raw_rows));
  assert.ok(clearExport.data.raw_rows.length > 0);

  const clearAudit = await fetchJSON(`/api/email/audit/${clear.sequenceId}`);
  assert.equal(clearAudit.status, 200);
  assert.ok(clearAudit.data.records.length > 0);
  for (const record of clearAudit.data.records) {
    assert.notEqual(record.consent_status?.suppressed, true);
  }

  const upload = await fetchJSON("/api/suppression/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      csv_content: "\"Acme Holdings Ltd, 01234567\"\n\"Beta Ltd, 07654321\"\nopt.out@x.com",
    }),
  });
  assert.equal(upload.status, 200);
  assert.ok(upload.data.stored >= 3);

  const listed = await fetchJSON("/api/suppression");
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.data.suppressions));
  assert.ok(
    listed.data.suppressions.some((row) => row.type === "company_number" && row.value_normalized === "01234567")
  );
  assert.ok(
    listed.data.suppressions.some((row) => row.type === "email" && row.value_normalized === "opt.out@x.com")
  );
});
