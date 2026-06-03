import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const originalFetch = global.fetch;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "website-resolver-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "website-resolver.db");

const db = await import("../db.js");
const resolver = await import("../website-resolver.js");

function makeHtmlResponse(url, html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async text() {
      return html;
    },
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
});

describe("website resolver guess precision", () => {
  it("marks guessed domains unresolved when only thin textual evidence exists", async () => {
    global.fetch = async (url) => {
      const target = String(url);
      if (target.startsWith("https://acmeresolver.co.uk")) {
        return makeHtmlResponse(
          "https://acmeresolver.co.uk/",
          `
            <html>
              <head><title>Acme Services</title></head>
              <body>
                <p>Welcome to Acme.</p>
              </body>
            </html>
          `
        );
      }
      return makeHtmlResponse(target, "<html><body>Unavailable</body></html>", 503);
    };

    const result = await resolver.resolveCompanyWebsite({
      companyNumber: "94000001",
      companyName: "Acme Resolver Limited",
      enableNameGuesses: true,
      force: true,
      maxCandidates: 1,
    });

    assert.equal(result.status, "unresolved");
    assert.equal(result.website_url, null);
    assert.ok(Array.isArray(result.attempts));
    assert.equal(result.attempts[0]?.classification, "weak");
  });

  it("returns probable (not verified) for guessed domains only when evidence is strong", async () => {
    global.fetch = async (url) => {
      const target = String(url);
      if (target.startsWith("https://acmeresolver.co.uk")) {
        return makeHtmlResponse(
          "https://acmeresolver.co.uk/",
          `
            <html>
              <head><title>Acme Resolver Platform</title></head>
              <body>
                <h1>Acme Resolver checkout</h1>
                <p>Acme Resolver supports international payments.</p>
              </body>
            </html>
          `
        );
      }
      return makeHtmlResponse(target, "<html><body>Unavailable</body></html>", 503);
    };

    const result = await resolver.resolveCompanyWebsite({
      companyNumber: "94000002",
      companyName: "Acme Resolver Limited",
      enableNameGuesses: true,
      force: true,
      maxCandidates: 1,
    });

    assert.equal(result.status, "probable");
    assert.equal(result.source, "name_guess");
    assert.equal(typeof result.website_url, "string");
    assert.ok(result.website_url.includes("acmeresolver.co.uk"));
  });

  it("keeps explicit website inputs eligible for verified resolution", async () => {
    global.fetch = async (url) => {
      const target = String(url);
      if (target.startsWith("https://provided.example")) {
        return makeHtmlResponse(
          "https://provided.example/",
          `
            <html>
              <head><title>Welcome</title></head>
              <body>
                <p>Acme services for finance teams.</p>
              </body>
            </html>
          `
        );
      }
      return makeHtmlResponse(target, "<html><body>Unavailable</body></html>", 503);
    };

    const result = await resolver.resolveCompanyWebsite({
      companyNumber: "94000003",
      companyName: "Acme Resolver Limited",
      companyWebsite: "https://provided.example",
      enableNameGuesses: false,
      force: true,
      maxCandidates: 1,
    });

    assert.equal(result.status, "verified");
    assert.equal(result.source, "input_website");
    assert.equal(typeof result.website_url, "string");
  });

  it("allows explicit manual no-site confirmations", () => {
    const result = resolver.setManualWebsiteResolution({
      companyNumber: "94000010",
      companyName: "Manual No Site Co",
      status: "no_site_confirmed",
      note: "checked by operator",
    });

    assert.equal(result.status, "no_site_confirmed");
    assert.equal(result.source, "manual_override");
    assert.equal(result.website_url, null);
    assert.equal(result.domain, null);
    assert.equal(result.updated, true);

    const persisted = db.getWebsiteResolution("94000010", null);
    assert.equal(persisted?.status, "no_site_confirmed");
    assert.equal(persisted?.source, "manual_override");
  });

  it("rejects manual verified overrides without website/domain hints", () => {
    const result = resolver.setManualWebsiteResolution({
      companyNumber: "94000011",
      companyName: "Manual Invalid Co",
      status: "verified",
    });

    assert.equal(result.status, "invalid_input");
    assert.equal(result.updated, false);
  });
});
