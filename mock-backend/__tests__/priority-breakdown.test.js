import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "priority-breakdown-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "priority-breakdown.db");

const db = await import("../db.js");
const { computePriorityBreakdown } = await import("../server.js");

const BASE_COMPANY = {
  latest_turnover: 80_000_000,
  latest_filing_date: "2026-01-15",
  below_threshold: 0,
};

function buildScore({
  productFit = 0.6,
  commercialValue = 0.6,
  painStrength = 0.5,
  urgency = 0.5,
  competitorContext = 0.5,
  sourcesAvailable = 0,
} = {}) {
  return {
    fit_score: 0.6,
    gp_potential_score: 0.5,
    propensity_score: 0.5,
    layers: {
      product_fit: { score: productFit, best_score: productFit },
      commercial_value: { score: commercialValue },
      pain_strength: { score: painStrength },
      urgency: { score: urgency },
      competitor_context: { score: competitorContext },
    },
    enrichment: {
      sources_available: sourcesAvailable,
    },
    velocity: { score: 0.5 },
    confidence_interval: {
      plus_minus: 0,
      confidence_level: "medium",
    },
    volatility: {
      band: "stable",
      instability_flag: false,
    },
    stakeholder_priority: { boost: 0 },
  };
}

after(() => {
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });

  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
});

describe("computePriorityBreakdown", () => {
  it("reorders priorities when stored segment weights change", () => {
    db.setSetting("propensity_weight", 0.15);

    const productWeighted = {
      "Mid-Market": {
        product_fit: 0.85,
        commercial_value: 0.05,
        pain_strength: 0.04,
        urgency: 0.03,
        competitor_context: 0.03,
      },
    };
    const commercialWeighted = {
      "Mid-Market": {
        product_fit: 0.05,
        commercial_value: 0.85,
        pain_strength: 0.04,
        urgency: 0.03,
        competitor_context: 0.03,
      },
    };

    const scoreProductLean = buildScore({ productFit: 0.9, commercialValue: 0.45 });
    const scoreCommercialLean = buildScore({ productFit: 0.45, commercialValue: 0.9 });

    db.setSetting("segment_weights", productWeighted);
    const productHeavyA = computePriorityBreakdown(BASE_COMPANY, scoreProductLean, "none", "Mid-Market");
    const productHeavyB = computePriorityBreakdown(BASE_COMPANY, scoreCommercialLean, "none", "Mid-Market");
    assert.ok(productHeavyA.priority_score > productHeavyB.priority_score);

    db.setSetting("segment_weights", commercialWeighted);
    const commercialHeavyA = computePriorityBreakdown(BASE_COMPANY, scoreProductLean, "none", "Mid-Market");
    const commercialHeavyB = computePriorityBreakdown(BASE_COMPANY, scoreCommercialLean, "none", "Mid-Market");
    assert.ok(commercialHeavyA.priority_score < commercialHeavyB.priority_score);
  });

  it("increases priority when deterministic connector coverage is higher", () => {
    db.setSetting("propensity_weight", 0.15);
    db.setSetting("segment_weights", {
      "Mid-Market": {
        product_fit: 0.3,
        commercial_value: 0.22,
        pain_strength: 0.2,
        urgency: 0.15,
        competitor_context: 0.13,
      },
    });

    const lowCoverage = computePriorityBreakdown(
      BASE_COMPANY,
      buildScore({ sourcesAvailable: 0 }),
      "none",
      "Mid-Market"
    );
    const highCoverage = computePriorityBreakdown(
      BASE_COMPANY,
      buildScore({ sourcesAvailable: 6 }),
      "none",
      "Mid-Market"
    );

    assert.ok(highCoverage.propensity_score > lowCoverage.propensity_score);
    assert.ok(highCoverage.priority_score > lowCoverage.priority_score);
  });
});
