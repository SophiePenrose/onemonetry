import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "fixtures", "signal-connectors");

const originalDatabasePath = process.env.DATABASE_PATH;
const originalFetch = global.fetch;
const allEnvKeys = [
  "ENDOLE_API_KEY",
  "ENDOLE_URL_TEMPLATE",
  "ENDOLE_AUTH_HEADER",
  "ENDOLE_AUTH_SCHEME",
  "OPENCORPORATES_API_TOKEN",
  "OPENCORPORATES_URL_TEMPLATE",
  "OPENCORPORATES_AUTH_HEADER",
  "OPENCORPORATES_AUTH_SCHEME",
  "PROSPEO_API_KEY",
  "PROSPEO_URL_TEMPLATE",
  "PROSPEO_AUTH_HEADER",
  "PROSPEO_AUTH_SCHEME",
  "SIMILARWEB_API_KEY",
  "SIMILARWEB_URL_TEMPLATE",
  "SIMILARWEB_AUTH_HEADER",
  "SIMILARWEB_AUTH_SCHEME",
  "BUILTWITH_API_KEY",
  "BUILTWITH_URL_TEMPLATE",
  "BUILTWITH_AUTH_HEADER",
  "BUILTWITH_AUTH_SCHEME",
  "ADZUNA_APP_ID",
  "ADZUNA_APP_KEY",
  "ADZUNA_URL_TEMPLATE",
  "ADZUNA_AUTH_HEADER",
  "ADZUNA_AUTH_SCHEME",
  "CRUNCHBASE_API_KEY",
  "CRUNCHBASE_URL_TEMPLATE",
  "CRUNCHBASE_AUTH_HEADER",
  "CRUNCHBASE_AUTH_SCHEME",
  "CLEARBIT_API_KEY",
  "CLEARBIT_URL_TEMPLATE",
  "CLEARBIT_AUTH_HEADER",
  "CLEARBIT_AUTH_SCHEME",
  "STATUSPAGE_URL_TEMPLATE",
  "STATUS_FEED_URL_TEMPLATE",
  "STATUS_API_URL_TEMPLATE",
  "STATUS_INSTATUS_URL_TEMPLATE",
  "STATUS_CACHET_URL_TEMPLATE",
  "ENABLE_STATUS_URL_DISCOVERY",
];

const originalEnv = Object.fromEntries(allEnvKeys.map((key) => [key, process.env[key]]));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-connectors-fixtures-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "signal-connectors-fixtures.db");

const db = await import("../db.js");
const connectors = await import("../signal-connectors.js");

function resetConnectorEnv() {
  for (const key of allEnvKeys) {
    delete process.env[key];
  }
}

function configureSingleConnector(connectorId) {
  resetConnectorEnv();
  process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

  const id = String(connectorId || "").toLowerCase();
  if (id === "endole") {
    process.env.ENDOLE_API_KEY = "test-endole-key";
    process.env.ENDOLE_URL_TEMPLATE = "https://fixtures.example.test/endole/{company_number}";
    return;
  }
  if (id === "opencorporates") {
    process.env.OPENCORPORATES_API_TOKEN = "test-opencorporates-token";
    process.env.OPENCORPORATES_URL_TEMPLATE = "https://fixtures.example.test/opencorporates/{company_number}";
    return;
  }
  if (id === "prospeo") {
    process.env.PROSPEO_API_KEY = "test-prospeo-key";
    process.env.PROSPEO_URL_TEMPLATE = "https://fixtures.example.test/prospeo/{company_number}";
    return;
  }
  if (id === "similarweb") {
    process.env.SIMILARWEB_API_KEY = "test-similarweb-key";
    process.env.SIMILARWEB_URL_TEMPLATE = "https://fixtures.example.test/similarweb/{company_domain}";
    return;
  }
  if (id === "builtwith") {
    process.env.BUILTWITH_API_KEY = "test-builtwith-key";
    process.env.BUILTWITH_URL_TEMPLATE = "https://fixtures.example.test/builtwith/{company_domain}";
    return;
  }
  if (id === "adzuna") {
    process.env.ADZUNA_APP_ID = "test-adzuna-app";
    process.env.ADZUNA_APP_KEY = "test-adzuna-key";
    process.env.ADZUNA_URL_TEMPLATE = "https://fixtures.example.test/adzuna/{company_name_encoded}";
    return;
  }
  if (id === "crunchbase") {
    process.env.CRUNCHBASE_API_KEY = "test-crunchbase-key";
    process.env.CRUNCHBASE_URL_TEMPLATE = "https://fixtures.example.test/crunchbase/{company_name_encoded}";
    return;
  }
  if (id === "clearbit") {
    process.env.CLEARBIT_API_KEY = "test-clearbit-key";
    process.env.CLEARBIT_URL_TEMPLATE = "https://fixtures.example.test/clearbit/{company_domain}";
    return;
  }
  if (id === "statuspage") {
    process.env.STATUSPAGE_URL_TEMPLATE = "https://fixtures.example.test/statuspage/{company_number}";
    return;
  }
  if (id === "status_feed") {
    process.env.STATUS_FEED_URL_TEMPLATE = "https://fixtures.example.test/status-feed/{company_number}";
    return;
  }
  if (id === "status_api") {
    process.env.STATUS_API_URL_TEMPLATE = "https://fixtures.example.test/status-api/{company_number}";
    return;
  }
  if (id === "status_instatus") {
    process.env.STATUS_INSTATUS_URL_TEMPLATE = "https://fixtures.example.test/status-instatus/{company_number}";
    return;
  }
  if (id === "status_cachet") {
    process.env.STATUS_CACHET_URL_TEMPLATE = "https://fixtures.example.test/status-cachet/{company_number}";
    return;
  }

  throw new Error(`Unsupported connector id: ${connectorId}`);
}

function loadFixture(name) {
  const filePath = path.join(fixturesDir, `${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeFetchWithFixture(connectorId, fixtureName) {
  const payload = loadFixture(fixtureName);

  return async (url) => {
    const urlString = String(url || "");
    assert.ok(urlString.includes(`/${connectorId}/`));

    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  };
}

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

describe("external signal connector native fixtures", () => {
  it("maps Endole native fixture to all major envelopes", async () => {
    configureSingleConnector("endole");
    global.fetch = makeFetchWithFixture("endole", "endole");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220001",
      companyName: "Native Endole Co",
      companyDomain: "native-endole.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.succeeded, 1);

    const ownership = db.getSetting("ownership_99220001", null);
    const hiring = db.getSetting("hiring_signals_99220001", null);
    const reputation = db.getSetting("reputation_99220001", null);
    const marketing = db.getSetting("marketing_intelligence_99220001", null);
    const tech = db.getSetting("tech_stack_99220001", null);

    assert.equal(ownership.non_uk_significant_corporate_controllers_count >= 1, true);
    assert.equal(hiring.total_open_roles >= 2, true);
    assert.equal(reputation.payment_related_complaints, 7);
    assert.equal(marketing.monthly_web_traffic, 180000);
    assert.ok((tech.technologies || []).includes("Stripe"));
  });

  it("maps OpenCorporates native fixture to ownership signal", async () => {
    configureSingleConnector("opencorporates");
    global.fetch = makeFetchWithFixture("opencorporates", "opencorporates");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220002",
      companyName: "Native OpenCorp Co",
      companyDomain: "native-opencorp.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.succeeded, 1);

    const ownership = db.getSetting("ownership_99220002", null);
    assert.equal(ownership.non_uk_significant_corporate_controllers_count >= 1, true);
    assert.match(String(ownership.parent_company || ""), /Euro HoldCo/i);
  });

  it("maps OpenCorporates fixture when only URL template is configured", async () => {
    resetConnectorEnv();
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";
    process.env.OPENCORPORATES_URL_TEMPLATE = "https://fixtures.example.test/opencorporates/{company_number}";
    global.fetch = makeFetchWithFixture("opencorporates", "opencorporates");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220009",
      companyName: "Native OpenCorp Free Co",
      companyDomain: "native-opencorp-free.co.uk",
    });

    assert.equal(result.status, "updated");
    assert.equal(result.succeeded, 1);

    const ownership = db.getSetting("ownership_99220009", null);
    assert.equal(ownership.non_uk_significant_corporate_controllers_count >= 1, true);
  });

  it("maps Prospeo native fixture to hiring, marketing, and tech envelopes", async () => {
    configureSingleConnector("prospeo");
    global.fetch = makeFetchWithFixture("prospeo", "prospeo");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220014",
      companyName: "Native Prospeo Co",
      companyDomain: "native-prospeo.co.uk",
    });

    assert.equal(result.status, "updated");

    const hiring = db.getSetting("hiring_signals_99220014", null);
    const marketing = db.getSetting("marketing_intelligence_99220014", null);
    const tech = db.getSetting("tech_stack_99220014", null);

    assert.equal(hiring.total_open_roles >= 5, true);
    assert.equal(marketing.monthly_web_traffic, 120000);
    assert.ok((tech.technologies || []).includes("HubSpot"));
  });

  it("maps Similarweb native fixture to marketing traffic and geography", async () => {
    configureSingleConnector("similarweb");
    global.fetch = makeFetchWithFixture("similarweb", "similarweb");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220003",
      companyName: "Native Similarweb Co",
      companyDomain: "native-similarweb.co.uk",
    });

    assert.equal(result.status, "updated");
    const marketing = db.getSetting("marketing_intelligence_99220003", null);
    assert.equal(marketing.monthly_web_traffic, 245000);
    assert.equal(marketing.estimated_monthly_ad_spend, 42000);
    assert.equal(Number(marketing.traffic_geography?.UK || 0) > 0, true);
  });

  it("maps BuiltWith native fixture to tech stack envelope", async () => {
    configureSingleConnector("builtwith");
    global.fetch = makeFetchWithFixture("builtwith", "builtwith");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220004",
      companyName: "Native BuiltWith Co",
      companyDomain: "native-builtwith.co.uk",
    });

    assert.equal(result.status, "updated");
    const tech = db.getSetting("tech_stack_99220004", null);
    assert.ok((tech.technologies || []).includes("Cloudflare"));
    assert.ok((tech.technologies || []).includes("Stripe"));
  });

  it("maps Adzuna native fixture to hiring envelope", async () => {
    configureSingleConnector("adzuna");
    global.fetch = makeFetchWithFixture("adzuna", "adzuna");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220005",
      companyName: "Native Adzuna Co",
      companyDomain: "native-adzuna.co.uk",
    });

    assert.equal(result.status, "updated");
    const hiring = db.getSetting("hiring_signals_99220005", null);
    assert.equal(hiring.total_open_roles >= 128, true);
    assert.ok((hiring.open_roles || []).some((entry) => String(entry?.role || "").includes("Treasury")));
  });

  it("maps Crunchbase native fixture to hiring and marketing envelopes", async () => {
    configureSingleConnector("crunchbase");
    global.fetch = makeFetchWithFixture("crunchbase", "crunchbase");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220006",
      companyName: "Native Crunchbase Co",
      companyDomain: "native-crunchbase.co.uk",
    });

    assert.equal(result.status, "updated");
    const hiring = db.getSetting("hiring_signals_99220006", null);
    const marketing = db.getSetting("marketing_intelligence_99220006", null);

    assert.equal(hiring.total_open_roles >= 14, true);
    assert.equal(marketing.monthly_web_traffic, 320000);
    assert.equal(marketing.estimated_monthly_ad_spend, 52000);
  });

  it("maps Clearbit native fixture to tech, hiring, and marketing envelopes", async () => {
    configureSingleConnector("clearbit");
    global.fetch = makeFetchWithFixture("clearbit", "clearbit");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220007",
      companyName: "Native Clearbit Co",
      companyDomain: "native-clearbit.co.uk",
    });

    assert.equal(result.status, "updated");

    const hiring = db.getSetting("hiring_signals_99220007", null);
    const marketing = db.getSetting("marketing_intelligence_99220007", null);
    const tech = db.getSetting("tech_stack_99220007", null);

    assert.equal(hiring.total_open_roles >= 9, true);
    assert.equal(marketing.monthly_web_traffic, 190000);
    assert.ok((tech.technologies || []).includes("HubSpot"));
  });

  it("maps Statuspage native fixture to reputation envelope without API key", async () => {
    configureSingleConnector("statuspage");
    global.fetch = makeFetchWithFixture("statuspage", "statuspage");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220008",
      companyName: "Native Statuspage Co",
      companyDomain: "native-statuspage.co.uk",
    });

    assert.equal(result.status, "updated");
    const reputation = db.getSetting("reputation_99220008", null);

    assert.equal(reputation.status_incidents_total, 3);
    assert.equal(reputation.status_incidents_open, 2);
    assert.equal(reputation.status_major_incidents_open, 1);
    assert.equal(reputation.status_degraded_components, 1);
    assert.equal(reputation.status_incident_severity_score >= 0.6, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("maps Status Feed native fixture to reputation envelope without API key", async () => {
    configureSingleConnector("status_feed");
    global.fetch = makeFetchWithFixture("status-feed", "status-feed");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220010",
      companyName: "Native Status Feed Co",
      companyDomain: "native-status-feed.co.uk",
    });

    assert.equal(result.status, "updated");
    const reputation = db.getSetting("reputation_99220010", null);

    assert.equal(reputation.status_feed_entries_total, 3);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(reputation.status_incident_severity_score >= 0.6, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("maps Status API native fixture to reputation envelope without API key", async () => {
    configureSingleConnector("status_api");
    global.fetch = makeFetchWithFixture("status-api", "status-api");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220011",
      companyName: "Native Status API Co",
      companyDomain: "native-status-api.co.uk",
    });

    assert.equal(result.status, "updated");
    const reputation = db.getSetting("reputation_99220011", null);

    assert.equal(reputation.status_incidents_total, 3);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(reputation.status_degraded_components >= 1, true);
    assert.equal(reputation.status_incident_severity_score >= 0.6, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("maps Status Instatus native fixture to reputation envelope without API key", async () => {
    configureSingleConnector("status_instatus");
    global.fetch = makeFetchWithFixture("status-instatus", "status-instatus");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220012",
      companyName: "Native Status Instatus Co",
      companyDomain: "native-status-instatus.co.uk",
    });

    assert.equal(result.status, "updated");
    const reputation = db.getSetting("reputation_99220012", null);

    assert.equal(reputation.status_incidents_total >= 2, true);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(reputation.status_degraded_components >= 1, true);
    assert.equal(reputation.status_incident_severity_score >= 0.6, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });

  it("maps Status Cachet native fixture to reputation envelope without API key", async () => {
    configureSingleConnector("status_cachet");
    global.fetch = makeFetchWithFixture("status-cachet", "status-cachet");

    const result = await connectors.syncExternalSignals({
      companyNumber: "99220013",
      companyName: "Native Status Cachet Co",
      companyDomain: "native-status-cachet.co.uk",
    });

    assert.equal(result.status, "updated");
    const reputation = db.getSetting("reputation_99220013", null);

    assert.equal(reputation.status_incidents_total >= 2, true);
    assert.equal(reputation.status_incidents_open >= 1, true);
    assert.equal(reputation.status_major_incidents_open >= 1, true);
    assert.equal(reputation.status_incident_severity_score >= 0.4, true);
    assert.equal(typeof reputation.status_health_band, "string");
    assert.equal(reputation.payment_related_complaints >= 1, true);
    assert.equal(reputation.checkout_related_complaints >= 1, true);
  });
});
