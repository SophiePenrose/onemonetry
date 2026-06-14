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
  OPENCORPORATES_URL_TEMPLATE: process.env.OPENCORPORATES_URL_TEMPLATE,
  STATUSPAGE_URL_TEMPLATE: process.env.STATUSPAGE_URL_TEMPLATE,
  STATUS_FEED_URL_TEMPLATE: process.env.STATUS_FEED_URL_TEMPLATE,
  STATUS_API_URL_TEMPLATE: process.env.STATUS_API_URL_TEMPLATE,
  STATUS_INSTATUS_URL_TEMPLATE: process.env.STATUS_INSTATUS_URL_TEMPLATE,
  STATUS_CACHET_URL_TEMPLATE: process.env.STATUS_CACHET_URL_TEMPLATE,
  ENABLE_STATUS_URL_DISCOVERY: process.env.ENABLE_STATUS_URL_DISCOVERY,
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
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    const result = await connectors.syncExternalSignals({ companyNumber: "92000010" });

    assert.equal(result.status, "no_connectors_configured");
    assert.equal(result.updated, false);
    assert.equal(result.telemetry?.request_attempts_total, 0);
    assert.equal(result.telemetry?.retry_attempts_total, 0);
  });

  it("runs only requested connectors when connector filter is provided", async () => {
    process.env.ENDOLE_API_KEY = "test-endole-key";
    process.env.ENDOLE_URL_TEMPLATE = "https://signals.example.test/endole/{company_number}";
    process.env.STATUSPAGE_URL_TEMPLATE = "https://signals.example.test/status/{company_number}";
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url) => {
      const href = String(url);
      if (href === "https://signals.example.test/status/99111113") {
        assert.fail("statuspage connector should not be called when endole is explicitly requested");
      }

      assert.equal(href, "https://signals.example.test/endole/99111113");
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
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111113",
      companyName: "Example Co",
      connectors: ["endole"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.attempted, 1);
    assert.equal(result.succeeded, 1);
    assert.deepEqual(result.requested_connectors, ["endole"]);
    assert.equal(result.ignored_connectors?.length || 0, 0);
    assert.equal(Array.isArray(result.connectors), true);
    assert.equal(result.connectors.length, 1);
    assert.equal(result.connectors[0]?.id, "endole");
  });

  it("returns invalid_input when connector filter contains no valid connector IDs", async () => {
    const result = await connectors.syncExternalSignals({
      companyNumber: "99111199",
      connectors: ["not_a_real_connector"],
    });

    assert.equal(result.status, "invalid_input");
    assert.equal(result.updated, false);
    assert.equal(result.error, "valid connector id is required");
    assert.deepEqual(result.requested_connectors, ["not_a_real_connector"]);
    assert.equal(Array.isArray(result.available_connectors), true);
    assert.equal(result.available_connectors.includes("endole"), true);
  });

  it("syncs configured connector payload into ownership and hiring envelopes", async () => {
    process.env.ENDOLE_API_KEY = "test-endole-key";
    process.env.ENDOLE_URL_TEMPLATE = "https://signals.example.test/company/{company_number}";
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

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
    assert.equal(result.telemetry?.request_attempts_total, 1);
    assert.equal(result.telemetry?.retry_attempts_total, 0);
    assert.equal(result.telemetry?.connectors_with_retries, 0);

    const endoleConnector = (result.connectors || []).find((entry) => entry.id === "endole");
    assert.ok(endoleConnector);
    assert.equal(endoleConnector.request_attempts, 1);
    assert.equal(endoleConnector.retry_attempts, 0);
    assert.equal(endoleConnector.request_duration_ms >= 0, true);

    const ownership = db.getSetting("ownership_99111111", null);
    const hiring = db.getSetting("hiring_signals_99111111", null);

    assert.equal(ownership.non_uk_significant_corporate_controllers_count >= 1, true);
    assert.equal(hiring.total_open_roles >= 2, true);
  });

  it("syncs configured status feed XML into reputation envelope", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.STATUS_FEED_URL_TEMPLATE = "https://signals.example.test/status/{company_domain}/history.rss";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url) => {
      assert.equal(String(url), "https://signals.example.test/status/example.co.uk/history.rss");

      return {
        ok: true,
        status: 200,
        async text() {
          return [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<rss version=\"2.0\"><channel>",
            "<title>Example Status Feed</title>",
            "<item><title>Card payment outage</title><description>We are investigating checkout failures.</description></item>",
            "<item><title>Issue resolved</title><description>Payment flow restored.</description></item>",
            "</channel></rss>",
          ].join("");
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111112",
      companyName: "Example Feed Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded, 1);

    const reputation = db.getSetting("reputation_99111112", null);
    assert.equal(reputation.status_feed_entries_total >= 2, true);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_incident_severity_score > 0, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("syncs configured status API JSON into reputation envelope", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.STATUS_API_URL_TEMPLATE = "https://signals.example.test/status-api/{company_domain}/incidents";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url) => {
      assert.equal(String(url), "https://signals.example.test/status-api/example.co.uk/incidents");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            name: "Example JSON Status",
            incidents: [
              {
                title: "Payment API outage",
                status: "investigating",
                description: "Checkout transaction failures observed",
              },
              {
                title: "Issue resolved",
                status: "resolved",
                description: "Payment flow restored",
              },
            ],
            components: [
              { name: "Card Processing", status: "degraded" },
            ],
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111114",
      companyName: "Example Status API Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded, 1);

    const reputation = db.getSetting("reputation_99111114", null);
    assert.equal(reputation.status_incidents_total, 2);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_degraded_components >= 1, true);
    assert.equal(reputation.status_incident_severity_score > 0, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("syncs configured Instatus summary JSON into reputation envelope", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    process.env.STATUS_INSTATUS_URL_TEMPLATE = "https://signals.example.test/instatus/{company_domain}/summary.json";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url) => {
      assert.equal(String(url), "https://signals.example.test/instatus/example.co.uk/summary.json");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            page: {
              name: "Example Instatus",
              url: "https://status.example.co.uk",
            },
            activeIncidents: [
              {
                name: "Card payout outage",
                status: "investigating",
                severity: "major",
                message: "Payment API disruptions affecting checkout",
              },
            ],
            components: [
              { name: "Payments API", status: "major_outage" },
              { name: "Status Site", status: "operational" },
            ],
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111115",
      companyName: "Example Instatus Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded, 1);

    const reputation = db.getSetting("reputation_99111115", null);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(reputation.status_degraded_components >= 1, true);
    assert.equal(reputation.status_incident_severity_score > 0, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("syncs configured Cachet status API JSON into reputation envelope", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    process.env.STATUS_CACHET_URL_TEMPLATE = "https://signals.example.test/cachet/{company_domain}/api/v1/incidents";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url) => {
      assert.equal(String(url), "https://signals.example.test/cachet/example.co.uk/api/v1/incidents");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: [
              {
                name: "Card payment outage",
                status: 1,
                human_status: "Investigating",
                message: "Checkout and payment failures observed",
              },
              {
                name: "Issue resolved",
                status: 4,
                human_status: "Fixed",
                message: "Payment and checkout restored",
              },
            ],
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111116",
      companyName: "Example Cachet Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded, 1);

    const reputation = db.getSetting("reputation_99111116", null);
    assert.equal(reputation.status_incidents_total >= 2, true);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(reputation.status_incident_severity_score > 0, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("applies recency decay when latest status incidents are stale", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.STATUSPAGE_URL_TEMPLATE = "https://signals.example.test/statuspage/{company_domain}/summary.json";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url) => {
      assert.equal(String(url), "https://signals.example.test/statuspage/example.co.uk/summary.json");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            page: {
              id: "stale_page_1",
              name: "Stale Status Example",
              url: "https://status.example.co.uk",
            },
            incidents: [
              {
                id: "incident_stale_1",
                name: "Old payment outage",
                status: "investigating",
                impact: "major",
                created_at: "2021-01-01T10:00:00Z",
                updated_at: "2021-01-01T11:00:00Z",
                incident_updates: [
                  {
                    body: "Historic checkout failures for payment cards.",
                  },
                ],
              },
            ],
            components: [],
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111117",
      companyName: "Example Stale Status Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded, 1);

    const reputation = db.getSetting("reputation_99111117", null);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(typeof reputation.status_recent_incident_at, "string");
    assert.equal(reputation.status_recent_incident_age_days >= 365, true);
    assert.equal(reputation.status_incident_recency_multiplier <= 0.35, true);
    assert.equal(reputation.status_incident_severity_score <= 0.25, true);
  });

  it("discovers common status URLs when enabled and templates are absent", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.ENABLE_STATUS_URL_DISCOVERY = "true";

    global.fetch = async (url) => {
      const urlString = String(url || "");
      if (urlString === "https://status.example.co.uk/api/v2/summary.json") {
        return {
          ok: false,
          status: 404,
          async text() {
            return JSON.stringify({ error: "not_found" });
          },
        };
      }

      if (urlString === "https://example.co.uk.statuspage.io/api/v2/summary.json") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              page: { name: "Example Status", url: "https://status.example.co.uk" },
              components: [{ name: "Cards", status: "degraded_performance" }],
              incidents: [{
                name: "Card payment delays",
                status: "investigating",
                impact: "major",
                incident_updates: [{ body: "Checkout requests timing out" }],
              }],
            });
          },
        };
      }

      return {
        ok: false,
        status: 404,
        async text() {
          return JSON.stringify({ error: "not_found" });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111113",
      companyName: "Example Discovery Co",
      companyDomain: "example.co.uk",
      enableStatusDiscovery: true,
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.succeeded >= 1, true);
    assert.equal(result.telemetry?.request_attempts_total >= 2, true);
    assert.equal(result.telemetry?.retry_attempts_total >= 1, true);
    assert.equal(result.telemetry?.connectors_with_retries >= 1, true);
    assert.equal(result.telemetry?.http_failures >= 1, true);

    const discoveredConnector = (result.connectors || []).find((entry) => entry.id === "statuspage");
    assert.ok(discoveredConnector);
    assert.equal(discoveredConnector.ok, true);
    assert.equal(discoveredConnector.auto_discovery_active, true);
    assert.equal(discoveredConnector.request_attempts >= 2, true);
    assert.equal(discoveredConnector.retry_attempts >= 1, true);
    assert.equal(discoveredConnector.failed_attempts_before_success >= 1, true);
  });

  it("captures failure telemetry when connector responds with upstream error", async () => {
    process.env.ENDOLE_API_KEY = "test-endole-key";
    process.env.ENDOLE_URL_TEMPLATE = "https://signals.example.test/company/{company_number}";
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async () => ({
      ok: false,
      status: 503,
      async text() {
        return JSON.stringify({ error: "upstream_unavailable" });
      },
    });

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111118",
      companyName: "Example Failure Co",
      companyDomain: "example.co.uk",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.updated, false);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.telemetry?.request_attempts_total, 1);
    assert.equal(result.telemetry?.retry_attempts_total, 0);
    assert.equal(result.telemetry?.http_failures, 1);

    const endoleConnector = (result.connectors || []).find((entry) => entry.id === "endole");
    assert.ok(endoleConnector);
    assert.equal(endoleConnector.ok, false);
    assert.equal(endoleConnector.failure_category, "http_error");
    assert.equal(endoleConnector.request_attempts, 1);
    assert.equal(endoleConnector.retry_attempts, 0);
  });
});
