import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoring-enrichment-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "scoring-enrichment.db");

const db = await import("../db.js");
const scoring = await import("../scoring-engine.js");

const DEFAULT_FILING_TEXT = [
  "The company operates an online retail ecommerce checkout platform with 320 employees.",
  "It processes card payments and point of sale transactions across multiple sites.",
  "The business exports internationally and pays overseas suppliers in EUR and USD.",
  "Management is focused on digital transformation, cost reduction, and treasury visibility.",
].join(" ");

function isoDaysAgo(daysAgo = 0) {
  return new Date(Date.now() - (daysAgo * 86400000)).toISOString();
}

function seedScorableCompany(companyNumber, overrides = {}) {
  const companyName = overrides.company_name || `Test Co ${companyNumber}`;
  const turnover = overrides.turnover ?? 80_000_000;
  const filingDate = overrides.filing_date || "2026-01-15";
  const filingText = overrides.raw_data || DEFAULT_FILING_TEXT;

  db.upsertMonitoredCompany({
    company_number: companyNumber,
    company_name: companyName,
    latest_turnover: turnover,
    status: "active",
    source: "unit_test",
  });

  db.upsertFiling({
    company_number: companyNumber,
    filing_date: filingDate,
    description: "Annual accounts",
    filing_type: "AA",
    barcode: `UT-${companyNumber}-${filingDate}`,
    turnover,
    balance_sheet_date: filingDate,
    source: "unit_test",
    source_file: "scoring-enrichment.test.js",
    raw_data: filingText,
  });
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

describe("enrichment-aware scoring", () => {
  it("applies fresh tech-stack boosts and switching tuning", () => {
    const companyNumber = "90000001";
    seedScorableCompany(companyNumber);

    db.setSetting(`tech_stack_${companyNumber}`, {
      updated_at: isoDaysAgo(2),
      payment_gateway: "Stripe",
      accounting_software: "Xero",
      technologies: ["Stripe", "Xero", "WooCommerce"],
      currencies_on_site: ["GBP", "EUR", "USD"],
    });

    const score = scoring.scoreCompany(companyNumber);

    assert.equal(score.enrichment.tech_stack.applied, true);
    assert.ok(Number(score.enrichment.tech_stack.motion_boosts["Merchant Acquiring"] || 0) > 0);
    assert.equal(score.layers.switching_feasibility.integration_ready_stack, true);
    assert.equal(
      score.layers.switching_feasibility.adjustments.some((entry) => entry.reason === "tech_stack_switching_signal"),
      true
    );
  });

  it("ignores expired enrichment payloads after max-age window", () => {
    const companyNumber = "90000002";
    seedScorableCompany(companyNumber);

    db.setSetting(`marketing_intelligence_${companyNumber}`, {
      updated_at: "2020-01-01T00:00:00Z",
      monthly_web_traffic: 900000,
      estimated_monthly_ad_spend: "120k",
      traffic_geography: { UK: 35 },
    });

    const score = scoring.scoreCompany(companyNumber);

    assert.equal(score.enrichment.marketing.freshness.decay_multiplier, 0);
    assert.equal(score.enrichment.marketing.applied, false);
    assert.equal(Number(score.all_motion_scores["Merchant Acquiring"].marketing_boost || 0), 0);
    assert.ok(Number(score.enrichment.marketing.freshness.days_old || 0) > 365);
  });

  it("narrows confidence interval when multiple fresh enrichment sources exist", () => {
    const baselineCompany = "90000003";
    const enrichedCompany = "90000004";

    seedScorableCompany(baselineCompany);
    seedScorableCompany(enrichedCompany);

    const baselineScore = scoring.scoreCompany(baselineCompany);

    db.setSetting(`tech_stack_${enrichedCompany}`, {
      updated_at: isoDaysAgo(1),
      payment_gateway: "Stripe",
      technologies: ["Stripe", "Xero", "Shopify"],
      currencies_on_site: ["GBP", "EUR"],
    });

    db.setSetting(`website_intelligence_${enrichedCompany}`, {
      updated_at: isoDaysAgo(1),
      pricing_currencies: ["GBP", "EUR", "USD"],
      customer_type: "B2C",
      international_shipping: true,
      shipping_countries: 24,
      office_locations: ["London", "Paris", "Berlin"],
    });

    db.setSetting(`hiring_signals_${enrichedCompany}`, {
      updated_at: isoDaysAgo(1),
      new_senior_hires: [{ role: "CFO", start_date: isoDaysAgo(25) }],
      headcount_growth_pct: 24,
      total_open_roles: 28,
      open_roles: ["Treasury Manager", "Ecommerce Manager"],
    });

    db.setSetting(`reputation_${enrichedCompany}`, {
      updated_at: isoDaysAgo(1),
      payment_related_complaints: 6,
      checkout_related_complaints: 4,
      trustpilot_review_count: 1300,
    });

    const enrichedScore = scoring.scoreCompany(enrichedCompany);

    assert.ok(enrichedScore.confidence.enrichment_source_count >= 4);
    assert.ok(enrichedScore.confidence_interval.plus_minus < baselineScore.confidence_interval.plus_minus);
    assert.equal(enrichedScore.confidence_interval.reasons.includes("enrichment_supported"), true);
  });

  it("boosts qualified companies when a desired ecommerce leader was newly hired", () => {
    const baselineCompany = "90000006";
    const enrichedCompany = "90000007";

    seedScorableCompany(baselineCompany);
    seedScorableCompany(enrichedCompany);

    const baselineScore = scoring.scoreCompany(baselineCompany);

    db.setSetting(`hiring_signals_${enrichedCompany}`, {
      updated_at: isoDaysAgo(1),
      new_senior_hires: [
        {
          full_name: "Morgan Lane",
          role: "Director of Ecommerce",
          start_date: isoDaysAgo(20),
          is_new_hire: true,
        },
      ],
      person_candidates_count: 1,
      person_candidates: [
        {
          full_name: "Morgan Lane",
          role: "Director of Ecommerce",
          email_status: "verified",
          confidence: "high",
          persona_bucket: "operations_lead",
          start_date: isoDaysAgo(20),
          is_new_hire: true,
        },
      ],
    });

    const enrichedScore = scoring.scoreCompany(enrichedCompany);

    assert.equal(enrichedScore.enrichment.hiring.applied, true);
    assert.equal(enrichedScore.enrichment.hiring.velocity_triggers.includes("new_ecommerce_leader"), true);
    assert.ok(Number(enrichedScore.enrichment.hiring.urgency_boost || 0) > 0);
    assert.ok(Number(enrichedScore.enrichment.hiring.motion_boosts["Merchant Acquiring"] || 0) > 0);
    assert.ok(Number(enrichedScore.enrichment.hiring.motion_boosts["Revolut Pay"] || 0) > 0);
    assert.ok(enrichedScore.layers.urgency.score > baselineScore.layers.urgency.score);
  });

  it("applies normalized status incident severity to reputation boosts", () => {
    const companyNumber = "90000005";
    seedScorableCompany(companyNumber, {
      raw_data: [
        "The company offers business process software and advisory services to enterprise clients.",
        "Current priorities include procurement controls, finance automation, and operational resilience.",
      ].join(" "),
    });

    db.setSetting(`reputation_${companyNumber}`, {
      updated_at: isoDaysAgo(1),
      status_incidents_total: 3,
      status_incidents_open: 2,
      status_major_incidents_open: 1,
      status_degraded_components: 1,
      status_incident_severity_score: 0.71,
      status_health_band: "critical",
    });

    const score = scoring.scoreCompany(companyNumber);

    assert.equal(score.enrichment.reputation.applied, true);
    assert.equal(
      score.enrichment.reputation.adjustments.some((entry) => entry.source === "status_incident_health"),
      true
    );
    assert.ok(Number(score.enrichment.reputation.pain_boost || 0) > 0);
    assert.ok(Number(score.all_motion_scores["Merchant Acquiring"]?.reputation_boost || 0) > 0);
    assert.ok(Number(score.all_motion_scores["Revolut Pay"]?.reputation_boost || 0) > 0);
  });
});
