import { describe, it, after, beforeEach } from "node:test";
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
  PROSPEO_API_KEY: process.env.PROSPEO_API_KEY,
  PROSPEO_URL_TEMPLATE: process.env.PROSPEO_URL_TEMPLATE,
  PROSPEO_AUTH_HEADER: process.env.PROSPEO_AUTH_HEADER,
  PROSPEO_AUTH_SCHEME: process.env.PROSPEO_AUTH_SCHEME,
  PROSPEO_SEARCH_PERSON_JOB_TITLES: process.env.PROSPEO_SEARCH_PERSON_JOB_TITLES,
  PROSPEO_SEARCH_PERSON_SENIORITIES: process.env.PROSPEO_SEARCH_PERSON_SENIORITIES,
  PROSPEO_SEARCH_PERSON_DEPARTMENTS: process.env.PROSPEO_SEARCH_PERSON_DEPARTMENTS,
  PROSPEO_SEARCH_PERSON_MAX_PER_COMPANY: process.env.PROSPEO_SEARCH_PERSON_MAX_PER_COMPANY,
  PROSPEO_SEARCH_PERSON_REQUIRE_VERIFIED_EMAIL: process.env.PROSPEO_SEARCH_PERSON_REQUIRE_VERIFIED_EMAIL,
  PROSPEO_SEARCH_PERSON_RECENT_ROLE_MONTHS: process.env.PROSPEO_SEARCH_PERSON_RECENT_ROLE_MONTHS,
  PROSPEO_SEARCH_PERSON_JOB_CHANGE_DAYS: process.env.PROSPEO_SEARCH_PERSON_JOB_CHANGE_DAYS,
  PHANTOMBUSTER_API_KEY: process.env.PHANTOMBUSTER_API_KEY,
  PHANTOMBUSTER_URL_TEMPLATE: process.env.PHANTOMBUSTER_URL_TEMPLATE,
  PHANTOMBUSTER_AUTH_HEADER: process.env.PHANTOMBUSTER_AUTH_HEADER,
  PHANTOMBUSTER_AUTH_SCHEME: process.env.PHANTOMBUSTER_AUTH_SCHEME,
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
  beforeEach(() => {
    delete process.env.PROSPEO_API_KEY;
    delete process.env.PROSPEO_URL_TEMPLATE;
    delete process.env.PROSPEO_AUTH_HEADER;
    delete process.env.PROSPEO_AUTH_SCHEME;
    delete process.env.PROSPEO_SEARCH_PERSON_JOB_TITLES;
    delete process.env.PROSPEO_SEARCH_PERSON_SENIORITIES;
    delete process.env.PROSPEO_SEARCH_PERSON_DEPARTMENTS;
    delete process.env.PROSPEO_SEARCH_PERSON_MAX_PER_COMPANY;
    delete process.env.PROSPEO_SEARCH_PERSON_REQUIRE_VERIFIED_EMAIL;
    delete process.env.PROSPEO_SEARCH_PERSON_RECENT_ROLE_MONTHS;
    delete process.env.PROSPEO_SEARCH_PERSON_JOB_CHANGE_DAYS;
    delete process.env.PHANTOMBUSTER_API_KEY;
    delete process.env.PHANTOMBUSTER_URL_TEMPLATE;
    delete process.env.PHANTOMBUSTER_AUTH_HEADER;
    delete process.env.PHANTOMBUSTER_AUTH_SCHEME;
  });

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
    assert.equal(result.available_connectors.includes("prospeo"), true);
    assert.equal(result.available_connectors.includes("phantombuster"), true);
  });

  it("syncs configured PhantomBuster connector payload into hiring, marketing, and tech envelopes", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PHANTOMBUSTER_API_KEY = "test-phantombuster-key";
    process.env.PHANTOMBUSTER_URL_TEMPLATE = "https://signals.example.test/phantombuster/{company_number}";
    process.env.PHANTOMBUSTER_AUTH_SCHEME = "none";
    process.env.PHANTOMBUSTER_AUTH_HEADER = "x-phantombuster-key";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), "https://signals.example.test/phantombuster/99111117");
      assert.equal(String(options?.headers?.["x-phantombuster-key"] || ""), "test-phantombuster-key");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            open_roles: 3,
            jobs: [
              { title: "Treasury Operations Manager" },
              { title: "Payment Product Manager" },
            ],
            monthly_web_traffic: 420000,
            technologies: ["Stripe", "Shopify", "Segment"],
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111117",
      companyName: "Example PhantomBuster Co",
      companyDomain: "example.co.uk",
      connectors: ["phantombuster"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(result.attempted, 1);
    assert.equal(result.succeeded, 1);
    assert.deepEqual(result.requested_connectors, ["phantombuster"]);

    const connector = (result.connectors || []).find((entry) => entry.id === "phantombuster");
    assert.ok(connector);

    const hiring = db.getSetting("hiring_signals_99111117", null);
    const marketing = db.getSetting("marketing_intelligence_99111117", null);
    const tech = db.getSetting("tech_stack_99111117", null);

    assert.equal(hiring.total_open_roles >= 2, true);
    assert.equal(marketing.monthly_web_traffic >= 420000, true);
    assert.equal(tech.signal_count >= 3, true);
  });

  it("maps nested Prospeo payload using provider-specific parser", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PROSPEO_API_KEY = "test-prospeo-key";
    process.env.PROSPEO_URL_TEMPLATE = "https://signals.example.test/prospeo/{company_number}";
    process.env.PROSPEO_AUTH_SCHEME = "none";
    process.env.PROSPEO_AUTH_HEADER = "x-prospeo-key";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), "https://signals.example.test/prospeo/99111119");
      assert.equal(String(options?.headers?.["x-prospeo-key"] || ""), "test-prospeo-key");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: {
              organization: {
                monthly_visits: 133000,
                traffic_geography: { UK: 0.58, US: 0.21 },
                technologies: [{ name: "HubSpot" }, { name: "Stripe" }],
              },
              contacts: [
                { jobTitle: "Head of Treasury" },
                { headline: "Finance Director at Example" },
              ],
            },
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111119",
      companyName: "Example Prospeo Nested Co",
      companyDomain: "nested-prospeo.example",
      connectors: ["prospeo"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    const hiring = db.getSetting("hiring_signals_99111119", null);
    const marketing = db.getSetting("marketing_intelligence_99111119", null);
    const tech = db.getSetting("tech_stack_99111119", null);

    assert.equal(hiring.total_open_roles >= 2, true);
    assert.equal(marketing.monthly_web_traffic, 133000);
    assert.ok((tech.technologies || []).includes("HubSpot"));
  });

  it("fans out official Prospeo bulk configuration to company enrichment and people discovery", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PROSPEO_API_KEY = "test-prospeo-key";
    process.env.PROSPEO_URL_TEMPLATE = "https://api.prospeo.io/bulk-enrich-company";
    process.env.PROSPEO_AUTH_SCHEME = "none";
    process.env.PROSPEO_AUTH_HEADER = "X-KEY";
    process.env.PROSPEO_SEARCH_PERSON_RECENT_ROLE_MONTHS = "6";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";
    const recentHireStartDate = new Date(Date.now() - (28 * 86400000)).toISOString();

    const requestedUrls = [];
    global.fetch = async (url, options = {}) => {
      const href = String(url);
      requestedUrls.push(href);
      assert.equal(String(options?.method || ""), "POST");
      assert.equal(String(options?.headers?.["X-KEY"] || ""), "test-prospeo-key");
      assert.equal(String(options?.headers?.["Content-Type"] || ""), "application/json");

      const parsedBody = JSON.parse(String(options?.body || "{}"));

      if (href === "https://api.prospeo.io/bulk-enrich-company") {
        assert.equal(Array.isArray(parsedBody?.data), true);
        assert.equal(parsedBody.data.length, 1);
        assert.equal(parsedBody.data[0]?.identifier, "99111123");
        assert.equal(parsedBody.data[0]?.company_website, "bulk-prospeo.example");
        assert.equal(Object.hasOwn(parsedBody.data[0] || {}, "company_number"), false);

        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              error: false,
              not_matched: [],
              invalid_datapoints: [],
              matched: [
                {
                  identifier: "99111123",
                  company: {
                    technology: {
                      technology_names: ["Stripe", "HubSpot"],
                    },
                    job_postings: {
                      active_count: 2,
                      active_titles: ["Treasury Operations Manager", "Finance Analyst"],
                    },
                  },
                },
              ],
            });
          },
        };
      }

      if (href === "https://api.prospeo.io/search-person") {
        assert.equal(Array.isArray(parsedBody?.filters?.company?.websites?.include), true);
        assert.equal(parsedBody.filters.company.websites.include[0], "bulk-prospeo.example");
        assert.equal(Array.isArray(parsedBody?.filters?.person_job_title?.include), true);
        assert.equal(parsedBody.filters.person_job_title.include.length > 0, true);
        assert.equal(parsedBody.filters.person_job_title.include.includes("Head of Ecommerce"), true);
        assert.equal(parsedBody.filters.person_job_title.include.includes("Director of Ecommerce"), true);
        assert.deepEqual(parsedBody.filters.person_time_in_current_role, { min: 0, max: 6 });

        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: {
                total_results: 1,
                results: [
                  {
                    person: {
                      id: "prospeo-person-1",
                      first_name: "Mia",
                      last_name: "Taylor",
                      job_title: "Director of Ecommerce",
                      current_position: {
                        start_date: recentHireStartDate,
                      },
                      linkedin_url: "https://linkedin.com/in/mia-taylor",
                      email: {
                        email: "mia@example.com",
                        status: "VERIFIED",
                        revealed: true,
                      },
                    },
                  },
                ],
              },
            });
          },
        };
      }

      assert.fail(`unexpected Prospeo URL: ${href}`);
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111123",
      companyName: "Example Prospeo Bulk Co",
      companyDomain: "bulk-prospeo.example",
      connectors: ["prospeo"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.deepEqual(requestedUrls, [
      "https://api.prospeo.io/bulk-enrich-company",
      "https://api.prospeo.io/search-person",
    ]);

    const connector = (result.connectors || []).find((entry) => entry.id === "prospeo");
    assert.ok(connector);
    assert.equal(connector.request_attempts, 2);
    assert.deepEqual(connector.attempted_urls, requestedUrls);
    assert.deepEqual(connector.successful_urls, requestedUrls);

    const raw = db.getSetting("external_signal_prospeo_99111123", null);
    assert.equal(Array.isArray(raw?.payload?.connector_payloads), true);
    assert.equal(raw.payload.connector_payloads.length, 2);

    const hiring = db.getSetting("hiring_signals_99111123", null);
    const tech = db.getSetting("tech_stack_99111123", null);

    assert.equal(hiring.total_open_roles >= 2, true);
    assert.ok((tech.technologies || []).includes("Stripe"));

    const person = (hiring.person_candidates || []).find((entry) => entry.full_name === "Mia Taylor");
    assert.ok(person);
    assert.equal(person.email, "mia@example.com");
    assert.equal(person.role, "Director of Ecommerce");
    assert.equal(person.email_status, "verified");
    assert.equal(person.start_date, recentHireStartDate);
    assert.equal(person.is_new_hire, true);
    assert.equal(person.source, "prospeo_search_person_api");
    const newHire = (hiring.new_senior_hires || []).find((entry) => entry.full_name === "Mia Taylor");
    assert.ok(newHire);
    assert.equal(newHire.role, "Director of Ecommerce");
    assert.equal(newHire.start_date, recentHireStartDate);
    assert.equal(newHire.is_new_hire, true);
  });

  it("uses Prospeo search-person POST payload and maps relevant person candidates", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PROSPEO_API_KEY = "test-prospeo-key";
    process.env.PROSPEO_URL_TEMPLATE = "https://api.prospeo.io/search-person";
    process.env.PROSPEO_AUTH_SCHEME = "none";
    process.env.PROSPEO_AUTH_HEADER = "X-KEY";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), "https://api.prospeo.io/search-person");
      assert.equal(String(options?.method || ""), "POST");
      assert.equal(String(options?.headers?.["X-KEY"] || ""), "test-prospeo-key");
      assert.equal(String(options?.headers?.["Content-Type"] || ""), "application/json");

      const parsedBody = JSON.parse(String(options?.body || "{}"));
      assert.equal(Array.isArray(parsedBody?.filters?.company?.websites?.include), true);
      assert.equal(parsedBody.filters.company.websites.include[0], "search-prospeo.example");
      assert.equal(Array.isArray(parsedBody?.filters?.person_job_title?.include), true);
      assert.equal(parsedBody.filters.person_job_title.include.length > 0, true);

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: {
              total_results: 2,
              results: [
                {
                  first_name: "Ava",
                  last_name: "Stone",
                  job_title: "Finance Director",
                  email: "ava@example.com",
                  linkedin_url: "https://linkedin.com/in/ava-stone",
                },
                {
                  full_name: "Noah Price",
                  title: "Head of Treasury",
                  email: "noah@example.com",
                },
              ],
            },
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111124",
      companyName: "Example Prospeo Search Co",
      companyDomain: "search-prospeo.example",
      connectors: ["prospeo"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);

    const hiring = db.getSetting("hiring_signals_99111124", null);
    assert.equal(Array.isArray(hiring?.person_candidates), true);
    assert.equal(hiring.person_candidates.length >= 2, true);
    assert.equal(
      hiring.person_candidates.some((entry) => String(entry?.full_name || "") === "Ava Stone"),
      true
    );
    assert.equal(
      hiring.person_candidates.some((entry) => String(entry?.email || "") === "ava@example.com"),
      true
    );
    assert.equal(
      hiring.person_candidates.some((entry) => entry?.full_name === "Ava Stone" && entry?.source === "prospeo_search_person_api"),
      true
    );
  });

  it("retries Prospeo search-person with reduced filters when PLAN_REQUIRED is returned", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PROSPEO_API_KEY = "test-prospeo-key";
    process.env.PROSPEO_URL_TEMPLATE = "https://api.prospeo.io/search-person";
    process.env.PROSPEO_AUTH_SCHEME = "none";
    process.env.PROSPEO_AUTH_HEADER = "X-KEY";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    let callCount = 0;
    global.fetch = async (url, options = {}) => {
      callCount += 1;
      assert.equal(String(url), "https://api.prospeo.io/search-person");
      assert.equal(String(options?.method || ""), "POST");

      const parsedBody = JSON.parse(String(options?.body || "{}"));
      if (callCount === 1) {
        assert.equal(Array.isArray(parsedBody?.filters?.person_job_title?.include), true);
        return {
          ok: false,
          status: 400,
          async text() {
            return JSON.stringify({
              error_code: "PLAN_REQUIRED",
              filter_error: ["person_job_title (PRO+)"],
              message: "Plan upgrade required",
            });
          },
        };
      }

      assert.equal(Object.hasOwn(parsedBody?.filters || {}, "person_job_title"), false);
      assert.equal(Object.hasOwn(parsedBody?.filters || {}, "company"), true);

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: {
              results: [
                {
                  full_name: "Jordan Case",
                  role: "Treasury Manager",
                  email: "jordan@example.com",
                },
              ],
            },
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111125",
      companyName: "Example Prospeo Plan Co",
      companyDomain: "plan-prospeo.example",
      connectors: ["prospeo"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.equal(callCount, 2);

    const connector = (result.connectors || []).find((entry) => entry.id === "prospeo");
    assert.ok(connector);
    assert.equal(connector.request_attempts >= 2, true);
    assert.equal(connector.retry_attempts >= 1, true);

    const hiring = db.getSetting("hiring_signals_99111125", null);
    assert.equal(Number(hiring?.person_candidates_count || 0) >= 1, true);
  });

  it("maps nested PhantomBuster export payload using provider-specific parser", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PHANTOMBUSTER_API_KEY = "test-phantombuster-key";
    process.env.PHANTOMBUSTER_URL_TEMPLATE = "https://signals.example.test/phantombuster/{company_number}";
    process.env.PHANTOMBUSTER_AUTH_SCHEME = "none";
    process.env.PHANTOMBUSTER_AUTH_HEADER = "x-phantombuster-key";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), "https://signals.example.test/phantombuster/99111120");
      assert.equal(String(options?.headers?.["x-phantombuster-key"] || ""), "test-phantombuster-key");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: {
              open_roles: 6,
              website: {
                monthly_visits: 210000,
              },
              rows: [
                {
                  jobTitle: "Director of Treasury",
                  technologies: "Stripe, Segment",
                },
                {
                  headline: "Head of Finance at Example Co",
                  tech_stack: ["HubSpot", "Shopify"],
                },
              ],
            },
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111120",
      companyName: "Example Phantom Nested Co",
      companyDomain: "phantom-nested.example",
      connectors: ["phantombuster"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    const hiring = db.getSetting("hiring_signals_99111120", null);
    const marketing = db.getSetting("marketing_intelligence_99111120", null);
    const tech = db.getSetting("tech_stack_99111120", null);

    assert.equal(hiring.total_open_roles >= 2, true);
    assert.equal(marketing.monthly_web_traffic, 210000);
    assert.ok((tech.technologies || []).includes("HubSpot"));
  });

  it("maps array-root Prospeo payload into hiring, marketing, and tech envelopes", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PROSPEO_API_KEY = "test-prospeo-key";
    process.env.PROSPEO_URL_TEMPLATE = "https://signals.example.test/prospeo/{company_number}";
    process.env.PROSPEO_AUTH_SCHEME = "none";
    process.env.PROSPEO_AUTH_HEADER = "x-prospeo-key";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), "https://signals.example.test/prospeo/99111121");
      assert.equal(String(options?.headers?.["x-prospeo-key"] || ""), "test-prospeo-key");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify([
            {
              jobTitle: "Head of Treasury",
              technologies: "Stripe, HubSpot",
              monthly_web_traffic: 155000,
            },
          ]);
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111121",
      companyName: "Example Prospeo Array Co",
      companyDomain: "array-prospeo.example",
      connectors: ["prospeo"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);

    const hiring = db.getSetting("hiring_signals_99111121", null);
    const marketing = db.getSetting("marketing_intelligence_99111121", null);
    const tech = db.getSetting("tech_stack_99111121", null);

    assert.equal(hiring.total_open_roles >= 1, true);
    assert.equal(marketing.monthly_web_traffic, 155000);
    assert.ok((tech.technologies || []).includes("Stripe"));
  });

  it("maps data-array PhantomBuster payload into hiring, marketing, and tech envelopes", async () => {
    delete process.env.ENDOLE_API_KEY;
    delete process.env.ENDOLE_URL_TEMPLATE;
    delete process.env.OPENCORPORATES_URL_TEMPLATE;
    delete process.env.STATUSPAGE_URL_TEMPLATE;
    delete process.env.STATUS_FEED_URL_TEMPLATE;
    delete process.env.STATUS_API_URL_TEMPLATE;
    delete process.env.STATUS_INSTATUS_URL_TEMPLATE;
    delete process.env.STATUS_CACHET_URL_TEMPLATE;
    process.env.PHANTOMBUSTER_API_KEY = "test-phantombuster-key";
    process.env.PHANTOMBUSTER_URL_TEMPLATE = "https://signals.example.test/phantombuster/{company_number}";
    process.env.PHANTOMBUSTER_AUTH_SCHEME = "none";
    process.env.PHANTOMBUSTER_AUTH_HEADER = "x-phantombuster-key";
    process.env.ENABLE_STATUS_URL_DISCOVERY = "false";

    global.fetch = async (url, options = {}) => {
      assert.equal(String(url), "https://signals.example.test/phantombuster/99111122");
      assert.equal(String(options?.headers?.["x-phantombuster-key"] || ""), "test-phantombuster-key");

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: [
              {
                headline: "Head of Finance at Example Co",
                technologies: "Shopify, Segment",
                monthly_web_traffic: 222000,
              },
            ],
          });
        },
      };
    };

    const result = await connectors.syncExternalSignals({
      companyNumber: "99111122",
      companyName: "Example Phantom Data Array Co",
      companyDomain: "array-phantom.example",
      connectors: ["phantombuster"],
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);

    const hiring = db.getSetting("hiring_signals_99111122", null);
    const marketing = db.getSetting("marketing_intelligence_99111122", null);
    const tech = db.getSetting("tech_stack_99111122", null);

    assert.equal(hiring.total_open_roles >= 1, true);
    assert.equal(marketing.monthly_web_traffic, 222000);
    assert.ok((tech.technologies || []).includes("Shopify"));
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
