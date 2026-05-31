import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const originalFetch = global.fetch;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tech-enrichment-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "tech-enrichment.db");

const db = await import("../db.js");
const enrichment = await import("../tech-enrichment.js");

function makeHtmlResponse(url, html, status = 200, contentType = "text/html; charset=utf-8") {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? contentType : null;
      },
    },
    async text() {
      return html;
    },
  };
}

function isoNow() {
  return new Date().toISOString();
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
});

describe("tech enrichment writer", () => {
  it("writes tech_stack and website intelligence from layered deterministic scan", async () => {
    const homeUrl = "https://acmetools.co.uk/";
    const pricingUrl = "https://acmetools.co.uk/pricing";

    global.fetch = async (url) => {
      const target = String(url);

      if (target.startsWith(pricingUrl)) {
        return makeHtmlResponse(
          pricingUrl,
          `
            <html>
              <head><title>Acme Pricing</title></head>
              <body>
                <h1>Plans</h1>
                <p>Starter £29 | Growth EUR 99 | Pro USD 129</p>
                <p>Worldwide shipping to over 34 countries</p>
              </body>
            </html>
          `
        );
      }

      if (target.startsWith("https://acmetools.co.uk/checkout")) {
        return makeHtmlResponse(
          "https://acmetools.co.uk/checkout",
          `
            <html>
              <head><title>Checkout</title></head>
              <body>
                <p>Secure checkout and card payment processing.</p>
              </body>
            </html>
          `
        );
      }

      if (target === "https://acmetools.co.uk" || target.startsWith(homeUrl) || target === "https://www.acmetools.co.uk") {
        return makeHtmlResponse(
          homeUrl,
          `
            <html>
              <head>
                <title>Acme Tools UK</title>
                <script src="https://js.stripe.com/v3/"></script>
              </head>
              <body>
                <p>Built on WooCommerce and Xero finance integration.</p>
                <p>We help B2C teams scale checkout and card acceptance.</p>
                <p>Prices from £19 per month and EUR 25 for EU accounts.</p>
                <p>Our offices in London, Paris and Berlin.</p>
                <a href="https://linkedin.com/company/acmetools">LinkedIn</a>
              </body>
            </html>
          `
        );
      }

      return makeHtmlResponse(target, "Not found", 404);
    };

    const result = await enrichment.runCompanyTechEnrichment({
      companyNumber: "92000001",
      companyName: "Acme Tools Limited",
      companyWebsite: "acmetools.co.uk",
      turnover: 42_000_000,
      force: true,
      maxPages: 6,
    });

    assert.equal(result.status, "updated");
    assert.equal(result.updated, true);
    assert.ok(result.technologies.includes("Stripe"));
    assert.ok(result.technologies.includes("WooCommerce"));
    assert.ok(result.technologies.includes("Xero"));
    assert.ok(result.site_currencies.includes("GBP"));
    assert.ok(result.site_currencies.includes("EUR"));

    const techStack = db.getSetting("tech_stack_92000001", null);
    const websiteIntel = db.getSetting("website_intelligence_92000001", null);
    const marketingIntel = db.getSetting("marketing_intelligence_92000001", null);

    assert.equal(techStack.payment_gateway, "Stripe");
    assert.equal(techStack.ecommerce_platform, "WooCommerce");
    assert.equal(techStack.accounting_software, "Xero");
    assert.equal(Array.isArray(techStack.pricing_currencies), true);

    assert.equal(websiteIntel.international_shipping, true);
    assert.equal(websiteIntel.customer_type, "B2C");
    assert.ok(Array.isArray(websiteIntel.office_locations));

    assert.equal(marketingIntel.has_pricing_page, true);
    assert.equal(marketingIntel.has_checkout_page, true);
  });

  it("skips fetch when a fresh tech payload already exists", async () => {
    db.setSetting("tech_stack_92000002", {
      updated_at: isoNow(),
      source: "unit_test",
      technologies: ["Stripe"],
    });

    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      return makeHtmlResponse("https://example.com", "<html></html>");
    };

    const result = await enrichment.runCompanyTechEnrichment({
      companyNumber: "92000002",
      companyName: "Fresh Example Ltd",
      companyWebsite: "fresh-example.co.uk",
      force: false,
      refreshWindowDays: 30,
    });

    assert.equal(result.status, "fresh_skip");
    assert.equal(result.updated, false);
    assert.equal(fetchCalls, 0);
  });

  it("returns unreachable when no candidate root is fetchable", async () => {
    global.fetch = async (url) => {
      return makeHtmlResponse(String(url), "Unavailable", 503);
    };

    const result = await enrichment.runCompanyTechEnrichment({
      companyNumber: "92000003",
      companyName: "No Site Ltd",
      companyWebsite: "nosite.invalid",
      force: true,
      timeoutMs: 1200,
    });

    assert.equal(result.status, "unreachable");
    assert.equal(result.updated, false);
    assert.ok(Array.isArray(result.attempts));
    assert.ok(result.attempts.length >= 1);
  });

  it("honors deep scan mode overrides", async () => {
    const requested = [];

    global.fetch = async (url) => {
      const target = String(url);
      requested.push(target);

      if (target === "https://modeoff.co.uk" || target.startsWith("https://modeoff.co.uk/")) {
        return makeHtmlResponse(
          "https://modeoff.co.uk/",
          `
            <html>
              <head><title>Mode Off Co</title></head>
              <body>
                <p>Company homepage with limited technology hints.</p>
              </body>
            </html>
          `
        );
      }

      if (target === "https://modealways.co.uk" || target.startsWith("https://modealways.co.uk/")) {
        if (target.includes("/checkout")) {
          return makeHtmlResponse(
            "https://modealways.co.uk/checkout",
            `
              <html>
                <head><title>Checkout</title></head>
                <body><p>Secure checkout page.</p></body>
              </html>
            `
          );
        }

        return makeHtmlResponse(
          "https://modealways.co.uk/",
          `
            <html>
              <head>
                <title>Mode Always Co</title>
                <script src="https://js.stripe.com/v3/"></script>
              </head>
              <body>
                <p>Built with WooCommerce and Xero integrations.</p>
                <p>Starter £10 and EUR 15 plans.</p>
              </body>
            </html>
          `
        );
      }

      return makeHtmlResponse(target, "Not found", 404);
    };

    const offResult = await enrichment.runCompanyTechEnrichment({
      companyNumber: "92000004",
      companyName: "Mode Off Co",
      companyWebsite: "modeoff.co.uk",
      turnover: 80_000_000,
      force: true,
      deepScanMode: "off",
    });

    assert.equal(offResult.status, "updated");
    assert.equal(offResult.scan_mode, "stage1_only");
    assert.equal(offResult.deep_scan_mode, "off");
    assert.equal(requested.some((url) => url.includes("modeoff.co.uk/checkout")), false);

    requested.length = 0;

    const alwaysResult = await enrichment.runCompanyTechEnrichment({
      companyNumber: "92000005",
      companyName: "Mode Always Co",
      companyWebsite: "modealways.co.uk",
      turnover: 2_000_000,
      force: true,
      deepScanMode: "always",
      maxPages: 4,
    });

    assert.equal(alwaysResult.status, "updated");
    assert.equal(alwaysResult.scan_mode, "layered_stage1_stage2");
    assert.equal(alwaysResult.deep_scan_mode, "always");
    assert.equal(requested.some((url) => url.includes("modealways.co.uk/checkout")), true);
  });
});
