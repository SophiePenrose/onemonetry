import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceCompaniesPath = path.resolve(__dirname, "..", "companies.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchJSON(baseUrl, route, options) {
  const res = await fetch(`${baseUrl}${route}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

function randomPort(base = 19600) {
  return base + Math.floor(Math.random() * 1000);
}

async function startApiServer(extraEnv = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onemonetry-signals-api-"));
  const testDatabasePath = path.join(tempDir, "signals-api.db");
  const testCompaniesPath = path.join(tempDir, "companies.json");
  fs.copyFileSync(sourceCompaniesPath, testCompaniesPath);

  const port = randomPort();
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
      ...extraEnv,
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
    throw new Error(`signal sync API test server failed to start. exit=${serverProcess.exitCode}. logs=${logs || "<none>"}`);
  }

  const stop = async () => {
    if (serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await sleep(350);
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  return { baseUrl, stop };
}

describe("POST /api/signals/sync/:number", () => {
  it("returns no_connectors_configured when connector env is absent", async () => {
    const ctx = await startApiServer({
      ENDOLE_API_KEY: "",
      ENDOLE_URL_TEMPLATE: "",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: "",
      STATUS_FEED_URL_TEMPLATE: "",
      STATUS_API_URL_TEMPLATE: "",
      STATUS_INSTATUS_URL_TEMPLATE: "",
      STATUS_CACHET_URL_TEMPLATE: "",
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_name: "No Connector Ltd" }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "no_connectors_configured");
      assert.equal(data.updated, false);
      assert.equal(data.attempted, 0);
      assert.equal(data.telemetry?.request_attempts_total, 0);
      assert.equal(data.telemetry?.retry_attempts_total, 0);
    } finally {
      await ctx.stop();
    }
  });

  it("syncs configured Endole connector and returns updated envelopes", async () => {
    const connectorServer = http.createServer((req, res) => {
      const route = String(req.url || "");
      if (!route.includes("/endole/00000006")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        shareholders: [
          {
            name: "Global Parent BV",
            type: "corporate entity",
            country_registered: "Netherlands",
            share_percent: 60,
          },
        ],
        jobs: [
          { title: "Treasury Manager" },
          { title: "Finance Director" },
        ],
        technologies: ["Stripe", "Xero"],
        monthly_visits: 180000,
      }));
    });

    await new Promise((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));
    const connectorPort = connectorServer.address().port;

    const ctx = await startApiServer({
      ENDOLE_API_KEY: "test-endole-key",
      ENDOLE_URL_TEMPLATE: `http://127.0.0.1:${connectorPort}/endole/{company_number}`,
      ENDOLE_AUTH_SCHEME: "none",
      ENDOLE_AUTH_HEADER: "x-api-key",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: "",
      STATUS_FEED_URL_TEMPLATE: "",
      STATUS_API_URL_TEMPLATE: "",
      STATUS_INSTATUS_URL_TEMPLATE: "",
      STATUS_CACHET_URL_TEMPLATE: "",
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Connector Test Co",
          company_domain: "connector-test.co.uk",
          timeout_ms: 5000,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "updated");
      assert.equal(data.updated, true);
      assert.equal(data.succeeded, 1);
      assert.equal(data.failed, 0);
      assert.equal(data.telemetry?.request_attempts_total >= 1, true);
      assert.equal(data.telemetry?.retry_attempts_total >= 0, true);
      assert.ok(Array.isArray(data.keys_updated));
      assert.ok(data.keys_updated.includes("ownership_00000006"));
      assert.ok(data.keys_updated.includes("hiring_signals_00000006"));

      const connector = (data.connectors || []).find((entry) => entry.id === "endole");
      assert.ok(connector);
      assert.equal(connector.ok, true);
      assert.equal(connector.ownership_updated, true);
      assert.equal(connector.hiring_updated, true);
      assert.equal(connector.tech_updated, true);
      assert.equal(typeof connector.request_attempts, "number");
      assert.equal(typeof connector.retry_attempts, "number");
    } finally {
      await ctx.stop();
      connectorServer.close();
    }
  });

  it("syncs configured Statuspage connector without API key", async () => {
    const connectorServer = http.createServer((req, res) => {
      const route = String(req.url || "");
      if (!route.includes("/statuspage/00000006")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        page: {
          name: "Connector Test Status",
          url: "https://status.connector-test.co.uk",
        },
        components: [
          { name: "Card Processing", status: "degraded_performance" },
          { name: "Public API", status: "operational" },
        ],
        incidents: [
          {
            name: "Card payment authorization delay",
            status: "investigating",
            impact: "major",
            incident_updates: [{ body: "Payment checkout requests are timing out." }],
          },
          {
            name: "Hosted checkout latency",
            status: "identified",
            impact: "minor",
            incident_updates: [{ body: "Checkout pages are slower than normal." }],
          },
        ],
      }));
    });

    await new Promise((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));
    const connectorPort = connectorServer.address().port;

    const ctx = await startApiServer({
      ENDOLE_API_KEY: "",
      ENDOLE_URL_TEMPLATE: "",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: `http://127.0.0.1:${connectorPort}/statuspage/{company_number}`,
      STATUS_FEED_URL_TEMPLATE: "",
      STATUS_API_URL_TEMPLATE: "",
      STATUS_INSTATUS_URL_TEMPLATE: "",
      STATUS_CACHET_URL_TEMPLATE: "",
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Connector Test Co",
          company_domain: "connector-test.co.uk",
          timeout_ms: 5000,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "updated");
      assert.equal(data.updated, true);
      assert.equal(data.succeeded, 1);
      assert.equal(data.failed, 0);
      assert.ok(Array.isArray(data.keys_updated));
      assert.ok(data.keys_updated.includes("reputation_00000006"));

      const connector = (data.connectors || []).find((entry) => entry.id === "statuspage");
      assert.ok(connector);
      assert.equal(connector.ok, true);
      assert.equal(connector.reputation_updated, true);
      assert.equal(connector.ownership_updated, false);
      assert.equal(connector.hiring_updated, false);
    } finally {
      await ctx.stop();
      connectorServer.close();
    }
  });

  it("syncs configured Status Feed connector without API key", async () => {
    const connectorServer = http.createServer((req, res) => {
      const route = String(req.url || "");
      if (!route.includes("/status-feed/00000006")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<rss version=\"2.0\"><channel><title>Connector Status Feed</title>",
        "<item><title>Major payment outage</title><description>Investigating checkout failures.</description></item>",
        "<item><title>Issue resolved</title><description>Payment flow restored.</description></item>",
        "</channel></rss>",
      ].join(""));
    });

    await new Promise((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));
    const connectorPort = connectorServer.address().port;

    const ctx = await startApiServer({
      ENDOLE_API_KEY: "",
      ENDOLE_URL_TEMPLATE: "",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: "",
      STATUS_FEED_URL_TEMPLATE: `http://127.0.0.1:${connectorPort}/status-feed/{company_number}`,
      STATUS_API_URL_TEMPLATE: "",
      STATUS_INSTATUS_URL_TEMPLATE: "",
      STATUS_CACHET_URL_TEMPLATE: "",
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Connector Test Co",
          company_domain: "connector-test.co.uk",
          timeout_ms: 5000,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "updated");
      assert.equal(data.updated, true);
      assert.equal(data.succeeded, 1);
      assert.equal(data.failed, 0);

      const connector = (data.connectors || []).find((entry) => entry.id === "status_feed");
      assert.ok(connector);
      assert.equal(connector.ok, true);
      assert.equal(connector.reputation_updated, true);
    } finally {
      await ctx.stop();
      connectorServer.close();
    }
  });

  it("syncs configured Status API connector without API key", async () => {
    const connectorServer = http.createServer((req, res) => {
      const route = String(req.url || "");
      if (!route.includes("/status-api/00000006")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "Connector Status API",
        incidents: [
          {
            title: "Payment API outage",
            status: "investigating",
            description: "Checkout transaction failures observed",
            severity: "major",
          },
          {
            title: "Issue resolved",
            status: "resolved",
            description: "Payment flow restored",
            severity: "minor",
          },
        ],
        components: [
          { name: "Card Processing", status: "degraded" },
        ],
      }));
    });

    await new Promise((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));
    const connectorPort = connectorServer.address().port;

    const ctx = await startApiServer({
      ENDOLE_API_KEY: "",
      ENDOLE_URL_TEMPLATE: "",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: "",
      STATUS_FEED_URL_TEMPLATE: "",
      STATUS_API_URL_TEMPLATE: `http://127.0.0.1:${connectorPort}/status-api/{company_number}`,
      STATUS_INSTATUS_URL_TEMPLATE: "",
      STATUS_CACHET_URL_TEMPLATE: "",
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Connector Test Co",
          company_domain: "connector-test.co.uk",
          timeout_ms: 5000,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "updated");
      assert.equal(data.updated, true);
      assert.equal(data.succeeded, 1);
      assert.equal(data.failed, 0);

      const connector = (data.connectors || []).find((entry) => entry.id === "status_api");
      assert.ok(connector);
      assert.equal(connector.ok, true);
      assert.equal(connector.reputation_updated, true);
    } finally {
      await ctx.stop();
      connectorServer.close();
    }
  });

  it("syncs configured Status Instatus connector without API key", async () => {
    const connectorServer = http.createServer((req, res) => {
      const route = String(req.url || "");
      if (!route.includes("/status-instatus/00000006")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        page: {
          name: "Connector Instatus",
          url: "https://status.connector-test.co.uk",
        },
        activeIncidents: [
          {
            name: "Major payment disruption",
            status: "investigating",
            severity: "major",
            message: "Checkout transactions are timing out.",
          },
        ],
        components: [
          { name: "Card Processing", status: "major_outage" },
          { name: "Public API", status: "operational" },
        ],
      }));
    });

    await new Promise((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));
    const connectorPort = connectorServer.address().port;

    const ctx = await startApiServer({
      ENDOLE_API_KEY: "",
      ENDOLE_URL_TEMPLATE: "",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: "",
      STATUS_FEED_URL_TEMPLATE: "",
      STATUS_API_URL_TEMPLATE: "",
      STATUS_INSTATUS_URL_TEMPLATE: `http://127.0.0.1:${connectorPort}/status-instatus/{company_number}`,
      STATUS_CACHET_URL_TEMPLATE: "",
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Connector Test Co",
          company_domain: "connector-test.co.uk",
          timeout_ms: 5000,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "updated");
      assert.equal(data.updated, true);
      assert.equal(data.succeeded, 1);
      assert.equal(data.failed, 0);

      const connector = (data.connectors || []).find((entry) => entry.id === "status_instatus");
      assert.ok(connector);
      assert.equal(connector.ok, true);
      assert.equal(connector.reputation_updated, true);
    } finally {
      await ctx.stop();
      connectorServer.close();
    }
  });

  it("syncs configured Status Cachet connector without API key", async () => {
    const connectorServer = http.createServer((req, res) => {
      const route = String(req.url || "");
      if (!route.includes("/status-cachet/00000006")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          {
            name: "Payment API outage",
            status: 1,
            human_status: "Investigating",
            message: "Checkout transaction failures observed",
          },
          {
            name: "Issue fixed",
            status: 4,
            human_status: "Fixed",
            message: "Payment flow restored",
          },
        ],
      }));
    });

    await new Promise((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));
    const connectorPort = connectorServer.address().port;

    const ctx = await startApiServer({
      ENDOLE_API_KEY: "",
      ENDOLE_URL_TEMPLATE: "",
      OPENCORPORATES_API_TOKEN: "",
      OPENCORPORATES_URL_TEMPLATE: "",
      SIMILARWEB_API_KEY: "",
      SIMILARWEB_URL_TEMPLATE: "",
      BUILTWITH_API_KEY: "",
      BUILTWITH_URL_TEMPLATE: "",
      ADZUNA_APP_ID: "",
      ADZUNA_APP_KEY: "",
      ADZUNA_URL_TEMPLATE: "",
      CRUNCHBASE_API_KEY: "",
      CRUNCHBASE_URL_TEMPLATE: "",
      CLEARBIT_API_KEY: "",
      CLEARBIT_URL_TEMPLATE: "",
      STATUSPAGE_URL_TEMPLATE: "",
      STATUS_FEED_URL_TEMPLATE: "",
      STATUS_API_URL_TEMPLATE: "",
      STATUS_INSTATUS_URL_TEMPLATE: "",
      STATUS_CACHET_URL_TEMPLATE: `http://127.0.0.1:${connectorPort}/status-cachet/{company_number}`,
      ENABLE_STATUS_URL_DISCOVERY: "false",
    });

    try {
      const { status, data } = await fetchJSON(ctx.baseUrl, "/api/signals/sync/00000006", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Connector Test Co",
          company_domain: "connector-test.co.uk",
          timeout_ms: 5000,
        }),
      });

      assert.equal(status, 200);
      assert.equal(data.status, "updated");
      assert.equal(data.updated, true);
      assert.equal(data.succeeded, 1);
      assert.equal(data.failed, 0);

      const connector = (data.connectors || []).find((entry) => entry.id === "status_cachet");
      assert.ok(connector);
      assert.equal(connector.ok, true);
      assert.equal(connector.reputation_updated, true);
    } finally {
      await ctx.stop();
      connectorServer.close();
    }
  });
});
