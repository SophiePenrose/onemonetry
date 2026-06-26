import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = Number.parseInt(process.env.API_TEST_PORT || "", 10)
  || (18080 + Math.floor(Math.random() * 1000));
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-api-tests-"));
const testDatabasePath = path.join(tempDir, "api-tests.db");
const sourceCompaniesPath = path.resolve(__dirname, "..", "companies.json");
const testCompaniesPath = path.join(tempDir, "companies.json");

let serverProcess = null;
let startedServerForTests = false;
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

async function isServerReady() {
  try {
    // Auth status endpoint is explicitly unauthenticated, so it is a reliable health check.
    const res = await fetch(`${BASE}/api/auth/status`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServerReady(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess?.exitCode !== null) {
      return false;
    }
    if (await isServerReady()) return true;
    await sleep(250);
  }
  return false;
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", appendServerLog);
  serverProcess.stderr?.on("data", appendServerLog);
  startedServerForTests = true;

  const ready = await waitForServerReady();
  if (!ready) {
    throw new Error(
      `API test server did not start on port ${TEST_PORT}. `
      + `exitCode=${serverProcess?.exitCode ?? "running"}. `
      + `Recent logs:\n${serverLogs || "<none>"}`
    );
  }
});

  describe("POST /api/monitor/import-seed-list", () => {
    it("returns dry-run summary for explicit company numbers with website/domain", async () => {
      const payload = {
        dry_run: true,
        sync_now: false,
        queue_analysis: false,
        rows: [
          {
            company_name: "Seed Import Alpha Ltd",
            company_number: "1234567",
            website: "alpha.example.com",
          },
          {
            company_name: "Seed Import Beta Ltd",
            company_number: "OC123456",
            company_website: "https://beta.example.com",
          },
        ],
      };

      const { status, data } = await fetchJSON("/api/monitor/import-seed-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      assert.equal(status, 200);
      assert.equal(data.dry_run, true);
      assert.equal(data.parsed_rows, 2);
      assert.equal(data.resolved_rows, 2);
      assert.equal(data.unresolved_rows, 0);
      assert.equal(data.upsert?.received, 2);
      assert.equal(data.upsert?.upserted, 0);
      assert.equal(data.sync?.skipped, true);
      assert.equal(data.analysis_queue?.skipped, true);
    });

    it("rejects requests without rows or csv_content", async () => {
      const { status, data } = await fetchJSON("/api/monitor/import-seed-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assert.equal(status, 400);
      assert.equal(typeof data.error, "string");
      assert.match(data.error, /Provide either rows\[\] or csv_content/i);
    });
  });

after(async () => {
  if (startedServerForTests && serverProcess) {
    serverProcess.kill("SIGTERM");
    await sleep(400);

    if (!serverProcess.killed) {
      serverProcess.kill("SIGKILL");
    }
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function fetchJSON(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

function buildGeminiHandoffRequestPayload(overrides = {}) {
  return {
    contract_version: "gemini-handoff-v1",
    request_id: "req_api_test_001",
    generated_at: new Date().toISOString(),
    workspace: {
      org: "Revolut Business",
      sheet_id: "sheet_test_1",
      sheet_tab: "queue_week_2026_w26",
      timezone: "Europe/London",
    },
    campaign: {
      campaign_id: "cmp_test_1",
      campaign_name: "API Test Campaign",
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
    response_id: "resp_api_test_001",
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

describe("API endpoints", () => {
  describe("GET /api/motions", () => {
    it("returns all 8 product motions", async () => {
      const { status, data } = await fetchJSON("/api/motions");
      assert.equal(status, 200);
      assert.equal(data.motions.length, 8);
      assert.ok(data.motions.includes("FX"));
      assert.ok(data.motions.includes("Merchant Acquiring"));
    });
  });

  describe("GET /api/workflow-states", () => {
    it("returns 9 workflow states with transitions", async () => {
      const { status, data } = await fetchJSON("/api/workflow-states");
      assert.equal(status, 200);
      assert.equal(data.states.length, 9);
      assert.ok(data.transitions.new_candidate.includes("shortlisted"));
      assert.deepEqual(data.transitions.closed_won, []);
    });
  });

  describe("GET /api/scoring-weights", () => {
    it("returns segment weights and propensity config", async () => {
      const { status, data } = await fetchJSON("/api/scoring-weights");
      assert.equal(status, 200);
      assert.ok(data.segment_weights.SMB);
      assert.ok(data.segment_weights["Mid-Market"]);
      assert.ok(data.segment_weights.Enterprise);
      assert.equal(data.layers.length, 5);
      assert.equal(typeof data.propensity_weight, "number");
    });
  });

  describe("GET /api/exclusions", () => {
    it("returns prohibited industries and suppressed states", async () => {
      const { status, data } = await fetchJSON("/api/exclusions");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.exclusions.prohibited_industries));
      assert.ok(data.exclusions.prohibited_industries.includes("Gambling"));
      assert.ok(Array.isArray(data.exclusions.prohibited_sic_codes));
      assert.ok(Array.isArray(data.suppressed_states));
    });
  });

  describe("PUT /api/exclusions", () => {
    it("accepts and persists prohibited SIC code policy", async () => {
      const baseline = await fetchJSON("/api/exclusions");
      assert.equal(baseline.status, 200);

      const payload = {
        prohibited_sic_codes: ["62012", "62012", "64 201", "invalid"],
      };
      const updated = await fetchJSON("/api/exclusions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      assert.equal(updated.status, 200);
      assert.deepEqual(updated.data.exclusions.prohibited_sic_codes, ["62012", "64201"]);

      const roundtrip = await fetchJSON("/api/exclusions");
      assert.equal(roundtrip.status, 200);
      assert.deepEqual(roundtrip.data.exclusions.prohibited_sic_codes, ["62012", "64201"]);

      await fetchJSON("/api/exclusions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseline.data.exclusions),
      });
    });
  });

  describe("GET /api/unified-shortlist", () => {
    it("returns companies array with meta", async () => {
      const { status, data } = await fetchJSON("/api/unified-shortlist");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.companies));
      assert.ok(data.meta);
      assert.equal(typeof data.meta.total, "number");
      assert.equal(typeof data.meta.showing, "number");
    });

    it("returns companies sorted by combined score descending", async () => {
      const { data } = await fetchJSON("/api/unified-shortlist");
      for (let i = 1; i < data.companies.length; i++) {
        assert.ok(data.companies[i - 1].combined_score >= data.companies[i].combined_score);
      }
    });

    it("includes status health snapshot fields for shortlist rendering", async () => {
      const { status, data } = await fetchJSON("/api/unified-shortlist");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.companies));
      if (data.companies.length === 0) {
        return;
      }

      const row = data.companies[0];
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_health_band"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_incident_severity_score"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_incident_recency_multiplier"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_recent_incident_age_days"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_incidents_open"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_major_incidents_open"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status_degraded_components"), true);
      assert.ok(["low", "medium", "high", null].includes(row.status_health_band));
    });
  });

  describe("GET /api/company/:id", () => {
    it("returns a reputation_signals status snapshot for evidence UI", async () => {
      const created = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Status Snapshot Contract Co",
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 25000000,
        }),
      });

      assert.equal(created.status, 201);
      const companyId = created.data.company?.id;
      assert.ok(companyId);

      const { status, data } = await fetchJSON(`/api/company/${companyId}`);

      assert.equal(status, 200);
      assert.equal(typeof data.company?.reputation_signals, "object");

      const signals = data.company.reputation_signals;
      assert.equal(Object.prototype.hasOwnProperty.call(signals, "status_health_band"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(signals, "status_incident_severity_score"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(signals, "status_incident_recency_multiplier"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(signals, "status_recent_incident_age_days"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(signals, "status_recent_incident_at"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(signals, "status_recent_open_incident_at"), true);
      assert.equal(typeof signals.status_incidents_open, "number");
      assert.equal(typeof signals.status_major_incidents_open, "number");
      assert.equal(typeof signals.status_degraded_components, "number");
      assert.ok(["low", "medium", "high", null].includes(signals.status_health_band));
      assert.equal(Object.prototype.hasOwnProperty.call(data.company, "ownership_structure"), true);
      assert.ok(Array.isArray(data.company.sic_codes));
    });
  });

  describe("POST /api/company/:id/ownership/refresh", () => {
    it("returns ownership refresh result and ownership structure payload", async () => {
      const created = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ownership Refresh Contract Co",
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 32000000,
          company_number: "12345678",
        }),
      });

      assert.equal(created.status, 201);
      const companyId = created.data.company?.id;
      assert.ok(companyId);

      const { status, data } = await fetchJSON(`/api/company/${companyId}/ownership/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assert.equal(status, 200);
      assert.equal(Object.prototype.hasOwnProperty.call(data, "ownership_refresh"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(data, "ownership_structure"), true);
      assert.equal(typeof data.company_number, "string");
    });
  });

  describe("GET /api/unified-shortlist/distribution", () => {
    it("returns shortlist bucket distributions and top-window summaries", async () => {
      const { status, data } = await fetchJSON("/api/unified-shortlist/distribution?limit=500&top_n=25");
      assert.equal(status, 200);
      assert.equal(typeof data.summary?.total, "number");
      assert.equal(typeof data.summary?.confidence_distribution, "object");
      assert.equal(typeof data.summary?.volatility_distribution, "object");
      assert.equal(typeof data.summary?.velocity_distribution, "object");
      assert.equal(data.summary?.top?.label, "top_25");
      assert.ok(data.summary?.top?.count <= 25);
      assert.equal(data.meta?.top_n, 25);

      const velocityCounts = Object.values(data.summary?.velocity_distribution || {})
        .reduce((sum, count) => sum + Number(count || 0), 0);
      assert.equal(velocityCounts, data.summary?.total);
    });
  });

  describe("GET /api/dashboard", () => {
    it("returns pipeline, motion summary, and active prospects", async () => {
      const { status, data } = await fetchJSON("/api/dashboard");
      assert.equal(status, 200);
      assert.equal(typeof data.total_companies, "number");
      assert.ok(data.pipeline.new_candidate);
      assert.ok(data.motion_summary.FX);
      assert.ok(Array.isArray(data.active_prospects));
    });
  });

  describe("GET /api/companies-house/status", () => {
    it("returns configuration status", async () => {
      const { status, data } = await fetchJSON("/api/companies-house/status");
      assert.equal(status, 200);
      assert.equal(typeof data.configured, "boolean");
    });
  });

  describe("GET /api/llm/status", () => {
    it("returns runtime provider and timeout controls", async () => {
      const { status, data } = await fetchJSON("/api/llm/status");
      assert.equal(status, 200);
      assert.equal(typeof data.configured, "boolean");
      assert.ok(data.provider === null || typeof data.provider === "string");
      assert.ok(data.model === null || typeof data.model === "string");
      assert.equal(typeof data.request_timeout_ms, "number");
      assert.equal(typeof data.providers?.openai, "object");
      assert.equal(typeof data.providers?.anthropic, "object");
    });
  });

  describe("POST /api/llm/analyse website resolution", () => {
    it("returns no_site_confirmed and still produces analysis when website discovery is disabled", async () => {
      const { status, data } = await fetchJSON("/api/llm/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_number: "93010001",
          company_name: "Co",
          discover_website: false,
          run_enrichment: true,
          force_enrichment: true,
          run_external_sync: false,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.website_resolution?.status, "no_site_confirmed");
      assert.equal(data.website_resolution?.cache_hit, false);
      assert.equal(data.enrichment?.status, "no_site_hint");
      assert.equal(typeof data.analysis?.summary, "string");
    });

    it("returns verified or probable website resolution when a live site is reachable", async () => {
      const websiteServer = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`
          <html>
            <head>
              <title>Acme Resolver Ltd</title>
              <script src="https://js.stripe.com/v3/"></script>
            </head>
            <body>
              <h1>Acme Resolver platform</h1>
              <p>We support B2C checkout and international card payments.</p>
            </body>
          </html>
        `);
      });

      await new Promise((resolve) => websiteServer.listen(0, "127.0.0.1", resolve));
      const websitePort = websiteServer.address().port;
      const websiteUrl = `http://127.0.0.1:${websitePort}`;

      try {
        const { status, data } = await fetchJSON("/api/llm/analyse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_number: "93010002",
            company_name: "Acme Resolver Ltd",
            company_website: websiteUrl,
            discover_website: true,
            run_enrichment: true,
            force_enrichment: true,
            run_external_sync: false,
          }),
        });

        assert.equal(status, 200);
        assert.ok(["verified", "probable"].includes(data.website_resolution?.status));
        assert.equal(typeof data.website_resolution?.website_url, "string");
        assert.equal(data.enrichment?.updated, true);
        assert.equal(data.enrichment?.status, "updated");
      } finally {
        websiteServer.close();
      }
    });
  });

  describe("website-resolution API", () => {
    it("resolves and returns cached website resolution for a company number", async () => {
      const companyNumber = "94021001";
      const create = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Website Endpoint Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 26000000,
        }),
      });
      assert.equal(create.status, 201);

      const websiteServer = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`
          <html>
            <head><title>Website Endpoint Co</title></head>
            <body>
              <h1>Website Endpoint Co platform</h1>
              <p>Website Endpoint Co supports payments and FX operations.</p>
            </body>
          </html>
        `);
      });

      await new Promise((resolve) => websiteServer.listen(0, "127.0.0.1", resolve));
      const websitePort = websiteServer.address().port;
      const websiteUrl = `http://127.0.0.1:${websitePort}`;

      try {
        const resolved = await fetchJSON(`/api/company/${companyNumber}/website-resolution`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            company_website: websiteUrl,
            discover_website: true,
            force: true,
          }),
        });

        assert.equal(resolved.status, 200);
        assert.ok(["verified", "probable"].includes(resolved.data.website_resolution?.status));
        assert.equal(typeof resolved.data.website_resolution?.website_url, "string");

        const cached = await fetchJSON(`/api/company/ch-${companyNumber}/website-resolution`);
        assert.equal(cached.status, 200);
        assert.ok(["verified", "probable"].includes(cached.data.website_resolution?.status));
        assert.equal(typeof cached.data.website_resolution?.website_url, "string");
        assert.equal(typeof cached.data.monitored_company?.company_website, "string");
      } finally {
        websiteServer.close();
      }
    });

    it("supports explicit no-site confirmation without running full analysis", async () => {
      const companyNumber = "94021002";
      const create = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "SMB",
          turnover: 1500000,
        }),
      });
      assert.equal(create.status, 201);

      const resolved = await fetchJSON(`/api/company/${companyNumber}/website-resolution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discover_website: false,
          force: true,
        }),
      });

      assert.equal(resolved.status, 200);
      assert.equal(resolved.data.website_resolution?.status, "no_site_confirmed");
      assert.equal(resolved.data.website_resolution?.website_url, null);

      const cached = await fetchJSON(`/api/company/${companyNumber}/website-resolution`);
      assert.equal(cached.status, 200);
      assert.equal(cached.data.website_resolution?.status, "no_site_confirmed");
    });

    it("supports manual website-resolution overrides", async () => {
      const companyNumber = "94021003";
      const create = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Manual Override Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 17500000,
        }),
      });
      assert.equal(create.status, 201);

      const manual = await fetchJSON(`/api/company/${companyNumber}/website-resolution/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "verified",
          company_website: "manual-override.example",
          note: "operator validated",
        }),
      });

      assert.equal(manual.status, 200);
      assert.equal(manual.data.website_resolution?.status, "verified");
      assert.equal(manual.data.website_resolution?.source, "manual_override");
      assert.equal(typeof manual.data.website_resolution?.website_url, "string");
      assert.equal(manual.data.website_resolution?.domain, "manual-override.example");

      const cached = await fetchJSON(`/api/company/${companyNumber}/website-resolution`);
      assert.equal(cached.status, 200);
      assert.equal(cached.data.website_resolution?.status, "verified");
      assert.equal(cached.data.website_resolution?.source, "manual_override");
      assert.equal(cached.data.monitored_company?.company_domain, "manual-override.example");
    });

    it("rejects invalid manual verified overrides without website/domain", async () => {
      const companyNumber = "94021004";
      const create = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Manual Invalid Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "SMB",
          turnover: 1200000,
        }),
      });
      assert.equal(create.status, 201);

      const invalid = await fetchJSON(`/api/company/${companyNumber}/website-resolution/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "verified",
        }),
      });

      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.status, "invalid_input");
      assert.equal(invalid.data.updated, false);
    });

    it("clears stale monitored website hints on manual no-site confirmation", async () => {
      const companyNumber = "94021005";
      const create = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Manual Clear Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "SMB",
          turnover: 2200000,
        }),
      });
      assert.equal(create.status, 201);

      const seeded = await fetchJSON(`/api/company/${companyNumber}/website-resolution/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "verified",
          company_website: "stale-hint.example",
        }),
      });
      assert.equal(seeded.status, 200);
      assert.equal(seeded.data.monitored_company?.company_domain, "stale-hint.example");

      const cleared = await fetchJSON(`/api/company/${companyNumber}/website-resolution/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "no_site_confirmed",
          note: "operator confirmed no website",
        }),
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.data.website_resolution?.status, "no_site_confirmed");

      const cached = await fetchJSON(`/api/company/${companyNumber}/website-resolution`);
      assert.equal(cached.status, 200);
      assert.equal(cached.data.website_resolution?.status, "no_site_confirmed");
      assert.equal(cached.data.monitored_company?.company_website, null);
      assert.equal(cached.data.monitored_company?.company_domain, null);
    });

    it("supports force_clear_hints on non-manual website resolution runs", async () => {
      const companyNumber = "94021006";
      const create = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Force Clear Hints Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "SMB",
          turnover: 2300000,
        }),
      });
      assert.equal(create.status, 201);

      const seeded = await fetchJSON(`/api/company/${companyNumber}/website-resolution/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "verified",
          company_website: "force-clear-hints.example",
        }),
      });
      assert.equal(seeded.status, 200);
      assert.equal(seeded.data.monitored_company?.company_domain, "force-clear-hints.example");

      const resolved = await fetchJSON(`/api/company/${companyNumber}/website-resolution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_website: "http://127.0.0.1:9",
          discover_website: false,
          force: true,
          force_clear_hints: true,
          max_candidates: 1,
          timeout_ms: 500,
        }),
      });

      assert.equal(resolved.status, 200);
      assert.equal(resolved.data.website_resolution?.status, "unresolved");

      const cached = await fetchJSON(`/api/company/${companyNumber}/website-resolution`);
      assert.equal(cached.status, 200);
      assert.equal(cached.data.website_resolution?.status, "unresolved");
      assert.equal(cached.data.monitored_company?.company_website, null);
      assert.equal(cached.data.monitored_company?.company_domain, null);
    });
  });

  describe("GET /api/integrations/status", () => {
    it("includes enrichment runtime and scheduler controls", async () => {
      const { status, data } = await fetchJSON("/api/integrations/status");
      assert.equal(status, 200);
      assert.equal(typeof data.integrations.tech_enrichment, "object");
      assert.equal(typeof data.integrations.tech_enrichment_scheduler, "object");
      assert.equal(typeof data.integrations.email_generation_llm, "object");
      assert.equal(typeof data.integrations.prospeo, "object");
      assert.equal(typeof data.integrations.status_api, "object");
      assert.equal(typeof data.integrations.status_instatus, "object");
      assert.equal(typeof data.integrations.status_cachet, "object");
      assert.equal(typeof data.integrations.status_url_discovery, "object");
      assert.equal(typeof data.integrations.website_resolution, "object");
      assert.equal(typeof data.integrations.llm.request_timeout_ms, "number");
      assert.equal(typeof data.integrations.email_generation_llm.runtime?.request_timeout_ms, "number");
      assert.equal(typeof data.integrations.tech_enrichment.defaults?.deep_scan_mode, "string");
      assert.equal(typeof data.integrations.website_resolution.defaults?.timeout_ms, "number");
      assert.ok(Array.isArray(data.env_template));
      assert.ok(data.env_template.includes("LLM_REQUEST_TIMEOUT_MS=30000"));
      assert.ok(data.env_template.includes("OPENAI_MODEL_FALLBACK=gpt-4o-mini"));
      assert.ok(data.env_template.includes("EMAIL_LLM_REQUEST_TIMEOUT_MS=25000"));
      assert.ok(data.env_template.includes("EMAIL_LLM_FAIL_CLOSED=true"));
      assert.ok(data.env_template.includes("TECH_ENRICHMENT_DEEP_SCAN_MODE=auto"));
      assert.ok(data.env_template.includes("TECH_ENRICHMENT_SEED_ENABLED=true"));
      assert.ok(data.env_template.includes("ENABLE_STATUS_URL_DISCOVERY=false"));
      assert.ok(data.env_template.includes("STATUS_API_URL_TEMPLATE=https://status.{company_domain}/api/v1/incidents"));
      assert.ok(data.env_template.includes("STATUS_INSTATUS_URL_TEMPLATE=https://status.{company_domain}/summary.json"));
      assert.ok(data.env_template.includes("STATUS_CACHET_URL_TEMPLATE=https://status.{company_domain}/api/v1/incidents"));
      assert.ok(data.env_template.includes("PROSPEO_URL_TEMPLATE=https://example.com/prospeo?company={company_domain}"));
      assert.ok(data.env_template.includes("WEBSITE_RESOLUTION_TIMEOUT_MS=1800"));
      assert.ok(data.env_template.includes("ANALYSIS_QUEUE_WEBSITE_GUESS=false"));
    });
  });

  describe("Gemini handoff API stubs", () => {
    it("accepts a valid handoff payload and returns status", async () => {
      const payload = buildGeminiHandoffRequestPayload({
        request_id: "req_api_test_accepted_001",
      });

      const accepted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      assert.equal(accepted.status, 202);
      assert.equal(accepted.data.status, "accepted");
      assert.equal(accepted.data.contract_version, "gemini-handoff-v1");
      assert.equal(accepted.data.request_id, payload.request_id);

      const status = await fetchJSON(`/api/gemini/handoff/${payload.request_id}`);
      assert.equal(status.status, 200);
      assert.equal(status.data.status, "accepted");
      assert.equal(status.data.request_id, payload.request_id);
      assert.equal(typeof status.data.retry_count, "number");
    });

    it("lists handoff requests with pagination and status filtering", async () => {
      const acceptedOnlyRequestId = "req_api_test_handoff_list_accepted_001";
      const completedRequestId = "req_api_test_handoff_list_completed_001";

      const acceptedOnly = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: acceptedOnlyRequestId })),
      });
      assert.equal(acceptedOnly.status, 202);

      const acceptedCompleted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: completedRequestId })),
      });
      assert.equal(acceptedCompleted.status, 202);

      const completed = await fetchJSON(`/api/gemini/handoff/${completedRequestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffResponsePayload(completedRequestId)),
      });
      assert.equal(completed.status, 200);

      const listAll = await fetchJSON("/api/gemini/handoff?limit=100&offset=0");
      assert.equal(listAll.status, 200);
      assert.equal(listAll.data.contract_version, "gemini-handoff-v1");
      assert.equal(typeof listAll.data.total, "number");
      assert.equal(Array.isArray(listAll.data.items), true);
      assert.equal(listAll.data.items.some((entry) => entry.request_id === acceptedOnlyRequestId), true);
      assert.equal(listAll.data.items.some((entry) => entry.request_id === completedRequestId), true);

      const completedOnly = await fetchJSON("/api/gemini/handoff?status=completed&limit=100&offset=0");
      assert.equal(completedOnly.status, 200);
      assert.equal(completedOnly.data.filters.status, "completed");
      assert.equal(completedOnly.data.items.every((entry) => entry.status === "completed"), true);
      assert.equal(completedOnly.data.items.some((entry) => entry.request_id === completedRequestId), true);
      assert.equal(completedOnly.data.items.some((entry) => entry.request_id === acceptedOnlyRequestId), false);
    });

    it("validates handoff list pagination parameters", async () => {
      const invalidLimit = await fetchJSON("/api/gemini/handoff?limit=0");
      assert.equal(invalidLimit.status, 400);
      assert.equal(invalidLimit.data.error, "invalid_limit");

      const invalidOffset = await fetchJSON("/api/gemini/handoff?offset=-1");
      assert.equal(invalidOffset.status, 400);
      assert.equal(invalidOffset.data.error, "invalid_offset");
    });

    it("rejects invalid handoff payloads via schema validation", async () => {
      const invalid = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_version: "gemini-handoff-v1" }),
      });

      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.error, "invalid_payload");
      assert.ok(Array.isArray(invalid.data.details));
      assert.equal(invalid.data.details.length > 0, true);
    });

    it("accepts complete response payload, supports retry, and syncs approvals", async () => {
      const requestId = "req_api_test_flow_001";
      const accepted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });
      assert.equal(accepted.status, 202);

      const completed = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffResponsePayload(requestId)),
      });
      assert.equal(completed.status, 200);
      assert.equal(completed.data.status, "completed");
      assert.equal(completed.data.request_id, requestId);
      assert.equal(typeof completed.data.response_payload_sha256, "string");
      assert.equal(completed.data.response_payload_sha256.length, 64);

      const afterComplete = await fetchJSON(`/api/gemini/handoff/${requestId}`);
      assert.equal(afterComplete.status, 200);
      assert.equal(typeof afterComplete.data.request_payload_sha256, "string");
      assert.equal(afterComplete.data.request_payload_sha256.length, 64);
      assert.equal(typeof afterComplete.data.response_payload_sha256, "string");
      assert.equal(afterComplete.data.response_payload_sha256.length, 64);

      const retry = await fetchJSON(`/api/gemini/handoff/${requestId}/retry`, {
        method: "POST",
      });
      assert.equal(retry.status, 202);
      assert.equal(retry.data.status, "retry_requested");
      assert.equal(typeof retry.data.retry_count, "number");
      assert.equal(retry.data.retry_count >= 1, true);

      const synced = await fetchJSON("/api/gemini/sheets/sync-approvals", {
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

      assert.equal(synced.status, 200);
      assert.equal(synced.data.request_id, requestId);
      assert.equal(synced.data.counts.total, 2);
      assert.equal(synced.data.counts.approved, 1);
      assert.equal(synced.data.counts.pending, 1);
    });

    it("treats duplicate complete callbacks with same response_id as idempotent", async () => {
      const requestId = "req_api_test_duplicate_complete_001";
      const accepted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });
      assert.equal(accepted.status, 202);

      const responsePayload = buildGeminiHandoffResponsePayload(requestId);

      const firstComplete = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(responsePayload),
      });
      assert.equal(firstComplete.status, 200);
      assert.equal(firstComplete.data.duplicate, false);

      const secondComplete = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(responsePayload),
      });
      assert.equal(secondComplete.status, 200);
      assert.equal(secondComplete.data.request_id, requestId);
      assert.equal(secondComplete.data.response_id, responsePayload.response_id);
      assert.equal(secondComplete.data.duplicate, true);
    });

    it("rejects duplicate response_id replay when payload differs", async () => {
      const requestId = "req_api_test_duplicate_payload_mismatch_001";
      const accepted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });
      assert.equal(accepted.status, 202);

      const firstPayload = buildGeminiHandoffResponsePayload(requestId);
      const firstComplete = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstPayload),
      });
      assert.equal(firstComplete.status, 200);

      const mismatchedPayload = {
        ...firstPayload,
        status: "partial",
        errors: [
          {
            code: "simulated_mismatch",
            message: "Payload differs for duplicate response id",
            retryable: false,
          },
        ],
      };
      const mismatchComplete = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mismatchedPayload),
      });

      assert.equal(mismatchComplete.status, 409);
      assert.equal(mismatchComplete.data.error, "response_payload_mismatch");
      assert.equal(mismatchComplete.data.request_id, requestId);
      assert.equal(mismatchComplete.data.response_id, firstPayload.response_id);
      assert.equal(typeof mismatchComplete.data.existing_response_payload_sha256, "string");
      assert.equal(typeof mismatchComplete.data.incoming_response_payload_sha256, "string");
      assert.notEqual(
        mismatchComplete.data.existing_response_payload_sha256,
        mismatchComplete.data.incoming_response_payload_sha256
      );
    });

    it("rejects complete callback replay when response_id conflicts with stored response", async () => {
      const requestId = "req_api_test_conflict_complete_001";
      const accepted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });
      assert.equal(accepted.status, 202);

      const firstPayload = buildGeminiHandoffResponsePayload(requestId);
      const firstComplete = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstPayload),
      });
      assert.equal(firstComplete.status, 200);

      const conflictingPayload = {
        ...buildGeminiHandoffResponsePayload(requestId),
        response_id: "resp_api_test_conflict_999",
      };
      const conflictingComplete = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conflictingPayload),
      });

      assert.equal(conflictingComplete.status, 409);
      assert.equal(conflictingComplete.data.error, "response_id_conflict");
      assert.equal(conflictingComplete.data.request_id, requestId);
      assert.equal(conflictingComplete.data.existing_response_id, firstPayload.response_id);
      assert.equal(conflictingComplete.data.incoming_response_id, conflictingPayload.response_id);
    });

    it("returns handoff event history for audit tracing", async () => {
      const requestId = "req_api_test_events_001";
      const accepted = await fetchJSON("/api/gemini/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffRequestPayload({ request_id: requestId })),
      });
      assert.equal(accepted.status, 202);

      const completed = await fetchJSON(`/api/gemini/handoff/${requestId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiHandoffResponsePayload(requestId)),
      });
      assert.equal(completed.status, 200);

      const events = await fetchJSON(`/api/gemini/handoff/${requestId}/events?limit=50`);
      assert.equal(events.status, 200);
      assert.equal(events.data.request_id, requestId);
      assert.equal(typeof events.data.count, "number");
      assert.equal(Array.isArray(events.data.events), true);
      assert.equal(events.data.events.length >= 2, true);

      const eventTypes = events.data.events.map((entry) => entry.event_type);
      assert.equal(eventTypes.includes("handoff_accepted"), true);
      assert.equal(eventTypes.includes("completion_applied"), true);
    });
  });

  describe("GET /api/reports/schedule", () => {
    it("returns Saturday evening schedule", async () => {
      const { status, data } = await fetchJSON("/api/reports/schedule");
      assert.equal(status, 200);
      assert.equal(data.schedule, "Saturday evenings at 18:00");
      assert.ok(data.next_generation);
    });
  });

  describe("GET /api/analysis-queue/status", () => {
    it("returns worker enrichment settings and tech enrichment seeder status", async () => {
      const { status, data } = await fetchJSON("/api/analysis-queue/status");
      assert.equal(status, 200);
      assert.equal(typeof data.enrichment, "object");
      assert.equal(typeof data.tech_enrichment_seed, "object");
      assert.equal(typeof data.tech_enrichment_seed.enabled, "boolean");
      assert.equal(typeof data.tech_enrichment_seed.interval_ms, "number");
    });
  });

  describe("Ownership stale monitor endpoints", () => {
    it("includes ownership monitor snapshot on GET /api/monitor/status", async () => {
      const { status, data } = await fetchJSON("/api/monitor/status");
      assert.equal(status, 200);
      assert.equal(typeof data.ownership_monitor, "object");
      assert.equal(typeof data.ownership_monitor.enabled, "boolean");
      assert.equal(typeof data.ownership_monitor.running, "boolean");
      assert.equal(typeof data.ownership_monitor.stale_days, "number");
      assert.equal(typeof data.ownership_monitor.batch_size, "number");
      assert.equal(typeof data.ownership_monitor.change_tracking_enabled, "boolean");
      assert.equal(Array.isArray(data.ownership_monitor.change_fields), true);
    });

    it("returns ownership scheduler metadata on GET /api/monitor/ownership/status", async () => {
      const { status, data } = await fetchJSON("/api/monitor/ownership/status");
      assert.equal(status, 200);
      assert.equal(typeof data.enabled, "boolean");
      assert.equal(typeof data.running, "boolean");
      assert.equal(typeof data.stale_days, "number");
      assert.equal(typeof data.check_interval_ms, "number");
      assert.equal(typeof data.schedule, "string");
      assert.equal(typeof data.change_tracking_enabled, "boolean");
      assert.equal(Array.isArray(data.change_fields), true);
    });

    it("returns ownership change listing contract on GET /api/monitor/ownership/changes", async () => {
      const { status, data } = await fetchJSON("/api/monitor/ownership/changes?limit=25&offset=0&since_days=90");
      assert.equal(status, 200);
      assert.equal(typeof data.total, "number");
      assert.equal(data.limit, 25);
      assert.equal(data.offset, 0);
      assert.equal(data.since_days, 90);
      assert.equal(typeof data.sort, "string");
      assert.equal(typeof data.min_changed_fields, "number");
      assert.equal(Array.isArray(data.changed_fields_filter), true);
      assert.equal(typeof data.changed_fields_counts, "object");
      assert.equal(typeof data.changed_fields_count_buckets, "object");
      assert.equal(typeof data.parent_country_scope_filter, "string");
      assert.equal(typeof data.parent_country_scope_counts, "object");
      assert.equal(typeof data.impact_filter, "string");
      assert.equal(typeof data.impact_counts, "object");
      assert.ok(Array.isArray(data.rows));

      if (data.rows.length > 0) {
        const row = data.rows[0];
        assert.equal(typeof row.company_number, "string");
        assert.equal(typeof row.company_name === "string" || row.company_name === null, true);
        assert.equal(row.change_detected, true);
        assert.ok(Array.isArray(row.changed_fields));
        assert.equal(typeof row.changed_fields_count, "number");
        assert.equal(typeof row.impact_level, "string");
        assert.equal(typeof row.parent_country_scope, "string");
        assert.equal(typeof row.last_changed_at === "string" || row.last_changed_at === null, true);
        assert.equal(typeof row.last_checked_at === "string" || row.last_checked_at === null, true);
        assert.equal(typeof row.structure === "string" || row.structure === null, true);
      }
    });

    it("accepts changed-field filter on ownership changes endpoint", async () => {
      const { status, data } = await fetchJSON(
        "/api/monitor/ownership/changes?limit=25&offset=0&since_days=90&changed_field=parent_company"
      );
      assert.equal(status, 200);
      assert.equal(Array.isArray(data.changed_fields_filter), true);
      assert.deepEqual(data.changed_fields_filter, ["parent_company"]);
      assert.equal(typeof data.changed_fields_counts, "object");
      assert.equal(typeof data.impact_filter, "string");
      assert.equal(typeof data.impact_counts, "object");

      if (data.rows.length > 0) {
        for (const row of data.rows) {
          assert.equal(Array.isArray(row.changed_fields), true);
          assert.equal(row.changed_fields.includes("parent_company"), true);
        }
      }
    });

    it("accepts impact filter on ownership changes endpoint", async () => {
      const { status, data } = await fetchJSON(
        "/api/monitor/ownership/changes?limit=25&offset=0&since_days=90&impact=high"
      );
      assert.equal(status, 200);
      assert.equal(data.impact_filter, "high");
      assert.equal(typeof data.impact_counts, "object");

      if (data.rows.length > 0) {
        for (const row of data.rows) {
          assert.equal(row.impact_level, "high");
        }
      }
    });

    it("accepts sort mode on ownership changes endpoint", async () => {
      const { status, data } = await fetchJSON(
        "/api/monitor/ownership/changes?limit=25&offset=0&since_days=90&sort=impact"
      );
      assert.equal(status, 200);
      assert.equal(data.sort, "impact");
      assert.equal(typeof data.impact_counts, "object");
    });

    it("accepts min_changed_fields filter on ownership changes endpoint", async () => {
      const { status, data } = await fetchJSON(
        "/api/monitor/ownership/changes?limit=25&offset=0&since_days=90&min_changed_fields=2"
      );
      assert.equal(status, 200);
      assert.equal(data.min_changed_fields, 2);
      assert.equal(typeof data.changed_fields_count_buckets, "object");

      if (data.rows.length > 0) {
        for (const row of data.rows) {
          assert.equal(typeof row.changed_fields_count, "number");
          assert.equal(row.changed_fields_count >= 2, true);
        }
      }
    });

    it("accepts parent_country_scope filter on ownership changes endpoint", async () => {
      const { status, data } = await fetchJSON(
        "/api/monitor/ownership/changes?limit=25&offset=0&since_days=90&parent_country_scope=non_uk"
      );
      assert.equal(status, 200);
      assert.equal(data.parent_country_scope_filter, "non_uk");
      assert.equal(typeof data.parent_country_scope_counts, "object");

      if (data.rows.length > 0) {
        for (const row of data.rows) {
          assert.equal(row.parent_country_scope, "non_uk");
        }
      }
    });
  });

  describe("GET /api/import/bulk/monthly", () => {
    it("returns monthly ZIP file list from Companies House", async () => {
      const { status, data } = await fetchJSON("/api/import/bulk/monthly");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.files));
      if (data.files.length > 0) {
        assert.ok(data.files[0].filename);
        assert.ok(data.files[0].url);
        assert.ok(data.files[0].period);
      }
    });
  });

  describe("GET /api/import/bulk/daily", () => {
    it("returns daily ZIP file list from Companies House", async () => {
      const { status, data } = await fetchJSON("/api/import/bulk/daily");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.files));
      if (data.files.length > 0) {
        assert.ok(data.files[0].filename);
        assert.ok(data.files[0].url);
        assert.ok(data.files[0].date);
      }
    });
  });

  describe("POST /api/companies", () => {
    it("creates a new company", async () => {
      const { status, data } = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Corp", industry: "Technology", segment: "Mid-Market", turnover: 25000000 }),
      });
      assert.equal(status, 201);
      assert.equal(data.company.name, "Test Corp");
      assert.equal(data.company.industry, "Technology");
    });

    it("rejects missing required fields", async () => {
      const { status } = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnover: 1000000 }),
      });
      assert.equal(status, 400);
    });

    it("returns structured score narrative fields in company profile motion scores", async () => {
      const { status: createStatus, data: created } = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Narrative Contract Co",
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 12000000,
          motions: ["FX"],
          product_fit: {
            FX: {
              eligible: true,
              fit_level: "strong",
              explanation: "Strong cross-border settlement footprint",
              layers: {
                product_fit: { score: 0.78, evidence: "Cross-border suppliers" },
                commercial_value: { score: 0.64, evidence: "Turnover supports wallet adoption" },
                pain_strength: { score: 0.61, evidence: "Manual treasury operations" },
                urgency: { score: 0.58, evidence: "Finance leadership change" },
                competitor_context: { score: 0.52, evidence: "Incumbent bank friction" },
              },
            },
          },
        }),
      });

      assert.equal(createStatus, 201);
      const companyId = created.company?.id;
      assert.ok(companyId);

      const { status, data } = await fetchJSON(`/api/company/${companyId}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.company?.all_motion_scores));
      assert.ok(data.company.all_motion_scores.length > 0);

      const motion = data.company.all_motion_scores[0];
      assert.equal(typeof motion.score_narrative, "object");
      assert.equal(typeof motion.score_narrative.headline, "string");
      assert.ok(Array.isArray(motion.score_narrative.drivers));
      assert.ok(Array.isArray(motion.score_narrative.evidence));
      assert.ok(Array.isArray(motion.score_narrative.risks));
      assert.ok(motion.score_narrative.drivers.length > 0);
    });
  });

  describe("POST /api/email/validate", () => {
    it("returns gate-level QC output including voice display metrics", async () => {
      const { status, data } = await fetchJSON("/api/email/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Research note",
          body: "Reading through your latest filing, what stood out was the treasury friction underneath current scale.",
          is_initial: true,
          step_type: "proof",
        }),
      });

      assert.equal(status, 200);
      assert.equal(typeof data.metrics?.voice_percent, "number");
      assert.equal(typeof data.metrics?.voice_display_pass, "boolean");
      assert.equal(typeof data.gates?.gate1?.pass, "boolean");
      assert.equal(typeof data.gates?.gate2?.pass, "boolean");
      assert.equal(typeof data.gates?.gate3?.pass, "boolean");
    });
  });

  describe("Email style profile endpoints", () => {
    it("stores and returns email style profile configuration", async () => {
      const updated = await fetchJSON("/api/email/style-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          name: "Gemini voice pilot",
          description: "Prioritise strategic, filing-grounded narrative with calm confidence.",
          style_prompt: "Use tighter narrative arcs and board-level implication framing before product language.",
          voice_traits: ["concise", "evidence-led", "non-hype"],
          preferred_patterns: ["lead with filing observation", "state implication before offer"],
          avoid_patterns: ["generic pleasantries", "feature laundry lists"],
          examples: [
            {
              label: "Preferred opener",
              text: "Reading your latest filing, the tension appears less about volume and more about execution consistency across treasury lanes.",
            },
          ],
        }),
      });

      assert.equal(updated.status, 200);
      assert.equal(updated.data.saved, true);
      assert.equal(updated.data.profile.enabled, true);
      assert.equal(updated.data.profile.name, "Gemini voice pilot");

      const fetched = await fetchJSON("/api/email/style-profile");
      assert.equal(fetched.status, 200);
      assert.equal(fetched.data.configured, true);
      assert.equal(fetched.data.profile.enabled, true);
      assert.equal(fetched.data.profile.name, "Gemini voice pilot");
      assert.equal(typeof fetched.data.profile.style_prompt, "string");
      assert.ok(Array.isArray(fetched.data.profile.examples));
      assert.ok(fetched.data.profile.examples.length >= 1);
    });
  });

  describe("POST /api/email/generate-advanced/shadow", () => {
    it("returns baseline vs styled shadow outputs without persisting sequence state", async () => {
      const created = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Shadow Style Test Co",
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 22000000,
        }),
      });

      assert.equal(created.status, 201);
      const companyId = created.data.company?.id;
      assert.ok(companyId);

      const shadow = await fetchJSON("/api/email/generate-advanced/shadow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: companyId,
          stakeholder_name: "Morgan Lee",
          stakeholder_role: "Finance Director",
          use_style_profile: true,
          preview_steps: 3,
        }),
      });

      assert.equal(shadow.status, 200);
      assert.equal(shadow.data.preview?.steps, 3);
      assert.equal(shadow.data.baseline?.style_profile_applied, false);
      assert.equal(shadow.data.styled?.style_profile_applied, true);
      assert.ok(Array.isArray(shadow.data.baseline?.steps));
      assert.ok(Array.isArray(shadow.data.styled?.steps));
      assert.ok(Array.isArray(shadow.data.comparison?.step_deltas));
      assert.equal(shadow.data.comparison?.baseline?.steps, 3);
      assert.equal(shadow.data.comparison?.styled?.steps, 3);
    });
  });

  describe("Email company-id aliasing", () => {
    it("accepts CH-prefixed company-number aliases for template generation", async () => {
      const companyNumber = "91234567";
      const created = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alias Generation Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 19000000,
        }),
      });

      assert.equal(created.status, 201);
      const generated = await fetchJSON("/api/email/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: `CH-${companyNumber}`,
          stakeholder_name: "Taylor Jones",
          stakeholder_role: "Finance Director",
          stakeholder_email: "taylor.jones@example.com",
          motion: "FX",
        }),
      });

      assert.equal(generated.status, 201);
      assert.equal(generated.data.source, "template");
      assert.equal(typeof generated.data.sequence_id, "string");
    });

    it("accepts CH-prefixed company-number aliases for exclusion checks", async () => {
      const companyNumber = "92345671";
      const created = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alias Exclusion Co",
          company_number: companyNumber,
          industry: "Technology",
          segment: "Mid-Market",
          turnover: 12500000,
        }),
      });

      assert.equal(created.status, 201);
      const checked = await fetchJSON("/api/email/check-exclusion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: `CH-${companyNumber}` }),
      });

      assert.equal(checked.status, 200);
      assert.equal(typeof checked.data.excluded, "boolean");
    });
  });

  describe("Enrichment endpoints", () => {
    it("refreshes and reads enrichment snapshot", async () => {
      const websiteServer = http.createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");

        if (String(req.url || "").startsWith("/pricing")) {
          res.end(`
            <html>
              <head><title>Pricing</title></head>
              <body>
                <p>Starter £29, Growth EUR 89, Pro USD 129</p>
                <p>International shipping to over 22 countries</p>
              </body>
            </html>
          `);
          return;
        }

        res.end(`
          <html>
            <head>
              <title>Enrichment API Test Co</title>
              <script src="https://js.stripe.com/v3/"></script>
            </head>
            <body>
              <p>Built with WooCommerce and Xero.</p>
              <p>Add to cart and checkout securely.</p>
              <a href="/pricing">Pricing</a>
            </body>
          </html>
        `);
      });

      await new Promise((resolve) => websiteServer.listen(0, "127.0.0.1", resolve));
      const websitePort = websiteServer.address().port;
      const websiteUrl = `http://127.0.0.1:${websitePort}`;

      try {
        const created = await fetchJSON("/api/companies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Enrichment API Test Co",
            industry: "Technology",
            segment: "Mid-Market",
            turnover: 35000000,
          }),
        });

        assert.equal(created.status, 201);
        const companyId = created.data.company.id;

        const refreshed = await fetchJSON(`/api/company/${companyId}/enrichment/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            website: websiteUrl,
            force: true,
            deep_scan: true,
            max_pages: 4,
          }),
        });

        assert.equal(refreshed.status, 200);
        assert.equal(refreshed.data.enrichment_run.updated, true);
        assert.equal(refreshed.data.enrichment_run.deep_scan_mode, "always");
        assert.ok((refreshed.data.enrichment_run.technologies || []).includes("Stripe"));

        const snapshot = await fetchJSON(`/api/company/${companyId}/enrichment?include_data=true`);
        assert.equal(snapshot.status, 200);
        assert.equal(snapshot.data.enrichment.tech_stack.available, true);
        assert.equal(snapshot.data.enrichment.website_intelligence.available, true);
        assert.equal(snapshot.data.enrichment.tech_stack.data?.deep_scan_mode, "always");
        assert.ok((snapshot.data.enrichment.tech_stack.data?.technologies || []).includes("Stripe"));
      } finally {
        websiteServer.close();
      }
    });
  });

  describe("POST /api/import/source3/override", () => {
    it("rejects requests without company number", async () => {
      const { status, data } = await fetchJSON("/api/import/source3/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assert.equal(status, 400);
      assert.match(String(data.error || ""), /company_number/i);
    });
  });

  describe("Scoring weights CRUD", () => {
    it("PUT validates weights sum to 1", async () => {
      const { status } = await fetchJSON("/api/scoring-weights", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment_weights: { SMB: { product_fit: 0.5, commercial_value: 0.5, pain_strength: 0.5, urgency: 0.5, competitor_context: 0.5 } } }),
      });
      assert.equal(status, 400);
    });

    it("POST reset restores defaults", async () => {
      const { status, data } = await fetchJSON("/api/scoring-weights/reset", { method: "POST" });
      assert.equal(status, 200);
      assert.ok(data.segment_weights.SMB);
      assert.equal(data.propensity_weight, 0.15);
    });
  });

  describe("Email export safeguards", () => {
    it("blocks export until steps are manually reviewed, then normalizes forbidden send-time minutes", async () => {
      const createdCompany = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Export Review Test Co",
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
          stakeholder_name: "Alex Brown",
          stakeholder_role: "Finance Director",
          stakeholder_email: "alex.brown@example.com",
          motion: "FX",
        }),
      });

      assert.equal(generated.status, 201);
      const sequenceId = generated.data.sequence_id;
      assert.ok(sequenceId);

      const blockedExport = await fetchJSON(`/api/email/export/json/${sequenceId}`);
      assert.equal(blockedExport.status, 409);
      assert.ok(Array.isArray(blockedExport.data.metadata?.pending_review_steps));
      assert.ok(blockedExport.data.metadata.pending_review_steps.length > 0);

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

      for (const row of exported.data.raw_rows) {
        const parts = String(row.scheduled_time || "").split(":");
        assert.equal(parts.length, 2);
        const minute = Number.parseInt(parts[1], 10);
        assert.ok(![0, 15, 30, 45].includes(minute));
      }
    });
  });
});
