import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const originalDatabasePath = process.env.DATABASE_PATH;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoring-competitor-context-tests-"));
process.env.DATABASE_PATH = path.join(tempDir, "scoring-competitor-context.db");

const db = await import("../db.js");
const scoring = await import("../scoring-engine.js");

function seedScorableCompany(companyNumber, rawData) {
  const filingDate = "2026-02-01";
  const turnover = 90_000_000;

  db.upsertMonitoredCompany({
    company_number: companyNumber,
    company_name: `Competitor Test ${companyNumber}`,
    latest_turnover: turnover,
    status: "active",
    source: "unit_test",
  });

  db.upsertFiling({
    company_number: companyNumber,
    filing_date: filingDate,
    description: "Annual accounts",
    filing_type: "AA",
    barcode: `CT-${companyNumber}-${filingDate}`,
    turnover,
    balance_sheet_date: filingDate,
    source: "unit_test",
    source_file: "scoring-competitor-context.test.js",
    raw_data: rawData,
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

describe("competitor holistic context scoring", () => {
  it("treats fragmented specialist stacks as high consolidation opportunity", () => {
    const companyNumber = "91000001";
    const text = [
      "The company operates a multi-currency ecommerce business with online checkout and card processing.",
      "Current finance tooling includes Wise for FX, Pleo for expense cards, and Stripe for online payments.",
      "Management wants to consolidate treasury, banking, spend controls, and acquiring into one platform.",
    ].join(" ");

    seedScorableCompany(companyNumber, text);
    const score = scoring.scoreCompany(companyNumber);

    const context = score.layers.competitor_context;

    assert.ok(Array.isArray(context.detected));
    assert.ok(context.detected.length >= 3);
    assert.ok(Number(context.holistic_score || 0) > Number(context.isolation_score || 0));
    assert.ok(Number(context.platform_consolidation_bonus || 0) > 0);
    assert.ok(Number(context.fragmented_stack_bonus || 0) >= 0.07);
    assert.ok(Number(context.holistic_tuning_delta || 0) > 0);
    assert.ok(
      Number(context.score || 0)
      >= Number(context.base_score || 0) + Number(context.motion_tuning_delta || 0)
    );
    assert.equal(
      ["fragmented_stack", "consolidation_play"].includes(context.strategic_signal),
      true
    );
    assert.equal(
      (context.holistic_tuning_adjustments || []).some((entry) => entry.reason === "fragmented_stack_holistic_lift"),
      true
    );
    assert.equal(
      score.layers.switching_feasibility.adjustments.some((entry) => entry.reason === "platform_consolidation_opportunity"),
      true
    );
  });

  it("applies anchor drag for incumbent bank and enterprise-suite setups", () => {
    const fragmentedCompany = "91000002";
    const anchorHeavyCompany = "91000003";

    seedScorableCompany(fragmentedCompany, [
      "The company sells internationally and accepts online card payments.",
      "Current tooling includes Wise for FX, Pleo for expenses, and Stripe for payment acceptance.",
    ].join(" "));

    seedScorableCompany(anchorHeavyCompany, [
      "The group relies on HSBC and Barclays for treasury, overdraft, and term-loan facilities.",
      "Spend controls and approvals are managed in SAP Concur across multiple entities.",
      "Leadership reports long-standing incumbent banking relationships and lender dependencies.",
    ].join(" "));

    const fragmentedScore = scoring.scoreCompany(fragmentedCompany);
    const anchorHeavyScore = scoring.scoreCompany(anchorHeavyCompany);

    const anchorContext = anchorHeavyScore.layers.competitor_context;
    const anchorAdjustment = anchorHeavyScore.layers.switching_feasibility.adjustments.find(
      (entry) => entry.reason === "anchor_effect_drag"
    );

    assert.equal(anchorContext.strategic_signal, "anchor_heavy");
    assert.ok(Number(anchorContext.anchor_drag || 0) >= 0.12);
    assert.ok(Number(anchorContext.holistic_tuning_delta || 0) < 0);
    assert.ok(
      Number(anchorContext.score || 0)
      <= Number(anchorContext.base_score || 0) + Number(anchorContext.motion_tuning_delta || 0)
    );
    assert.equal(
      (anchorContext.holistic_tuning_adjustments || []).some((entry) => entry.reason === "anchor_heavy_holistic_drag"),
      true
    );
    assert.ok(anchorAdjustment);
    assert.ok(Number(anchorAdjustment.impact || 0) < 0);
    assert.ok(
      Number(anchorHeavyScore.layers.switching_feasibility.score || 0)
      < Number(fragmentedScore.layers.switching_feasibility.score || 0)
    );
  });

  it("hydrates tech-stack competitors with profile-level holistic metadata", () => {
    const companyNumber = "91000004";
    const text = [
      "The company provides software services and has cross-border supplier relationships.",
      "Finance operations include card spend, reconciliation, and recurring payment collections.",
    ].join(" ");

    seedScorableCompany(companyNumber, text);

    db.setSetting(`tech_stack_${companyNumber}`, {
      updated_at: new Date().toISOString(),
      payment_gateway: "Stripe",
      technologies: ["Stripe", "Xero"],
    });

    const score = scoring.scoreCompany(companyNumber);
    const detected = score.layers.competitor_context.detected || [];
    const stripe = detected.find((entry) => entry.name === "Stripe");

    assert.ok(stripe);
    assert.equal(stripe.source, "tech_stack");
    assert.ok(Number(stripe.isolation_score || 0) > 0);
    assert.ok(Number(stripe.holistic_score || 0) > Number(stripe.isolation_score || 0));
  });

  it("avoids false positives for generic words like wise, square, tide, and ramp", () => {
    const companyNumber = "91000005";
    const text = [
      "The engineering team plans to ramp up hiring over the next quarter.",
      "Leadership agreed a wise approach to square footage optimisation across warehouse sites.",
      "Seasonal tide levels affected delivery routes along the coast.",
    ].join(" ");

    seedScorableCompany(companyNumber, text);
    const score = scoring.scoreCompany(companyNumber);
    const names = new Set((score.layers.competitor_context.detected || []).map((entry) => entry.name));

    assert.equal(names.has("Wise"), false);
    assert.equal(names.has("Square"), false);
    assert.equal(names.has("Tide"), false);
    assert.equal(names.has("Ramp"), false);
  });

  it("detects those same competitors when financial product context is explicit", () => {
    const companyNumber = "91000006";
    const text = [
      "Retail stores run on Square POS terminals and card payment acceptance.",
      "Cross-border supplier transfers are processed via Wise Business for international payments.",
      "The finance team is evaluating Ramp spend controls and approvals.",
      "A legacy unit still uses Tide Business accounts for employee cards.",
    ].join(" ");

    seedScorableCompany(companyNumber, text);
    const score = scoring.scoreCompany(companyNumber);
    const names = new Set((score.layers.competitor_context.detected || []).map((entry) => entry.name));

    assert.equal(names.has("Wise"), true);
    assert.equal(names.has("Square"), true);
    assert.equal(names.has("Tide"), true);
    assert.equal(names.has("Ramp"), true);
  });

  it("detects and hydrates additional competitor profiles for cards and embedded finance", () => {
    const companyNumber = "91000007";
    const text = [
      "Payment operations currently run through Barclaycard and Stripe Connect for marketplace collections.",
      "The embedded treasury stack uses Modulr and ClearBank APIs for account rails and settlement.",
      "Legacy travel-card and FX spend still routes through Caxton FX.",
    ].join(" ");

    seedScorableCompany(companyNumber, text);
    const score = scoring.scoreCompany(companyNumber);
    const detected = score.layers.competitor_context.detected || [];
    const names = new Set(detected.map((entry) => entry.name));

    assert.equal(names.has("Barclaycard"), true);
    assert.equal(names.has("Stripe Connect"), true);
    assert.equal(names.has("Modulr"), true);
    assert.equal(names.has("ClearBank"), true);
    assert.equal(names.has("Caxton"), true);
    assert.equal(names.has("Stripe"), false);

    const stripeConnect = detected.find((entry) => entry.name === "Stripe Connect");
    assert.ok(stripeConnect);
    assert.equal(stripeConnect.platform_type, "commerce_anchor");
    assert.ok(Number(stripeConnect.lock_in_strength || 0) >= 0.8);
  });
});
