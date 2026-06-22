import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickBestCompanySearchResult } from "../companies-house.js";

describe("companies-house search matching", () => {
  it("prefers exact active company-name matches", () => {
    const result = pickBestCompanySearchResult("Acme Limited", [
      {
        company_number: "1234567",
        title: "Acme Limited",
        company_status: "dissolved",
      },
      {
        company_number: "7654321",
        title: "Acme Limited",
        company_status: "active",
      },
      {
        company_number: "88888888",
        title: "Acme Holdings Limited",
        company_status: "active",
      },
    ]);

    assert.equal(result.best_match?.company_number, "07654321");
    assert.equal(result.best_match?.company_name, "Acme Limited");
    assert.equal(result.best_match?.company_status, "active");
    assert.equal(result.match_confidence, "high");
  });

  it("returns high confidence when normalized tokens match exactly", () => {
    const result = pickBestCompanySearchResult("Beta Payments", [
      {
        company_number: "22222222",
        title: "Beta Payments UK Limited",
        company_status: "active",
      },
      {
        company_number: "33333333",
        title: "Beta Software Limited",
        company_status: "active",
      },
    ]);

    assert.equal(result.best_match?.company_number, "22222222");
    assert.equal(result.best_match?.company_name, "Beta Payments UK Limited");
    assert.equal(result.match_confidence, "high");
  });

  it("returns no match when no search items are available", () => {
    const result = pickBestCompanySearchResult("No Match Co", []);

    assert.equal(result.best_match, null);
    assert.equal(result.best_score, null);
    assert.equal(result.match_confidence, "none");
  });
});
