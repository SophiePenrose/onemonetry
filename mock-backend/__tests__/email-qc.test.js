import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEmail, MANDATORY_OUTREACH_FOOTER } from "../email-qc.js";

describe("email QC gate engine", () => {
  it("fails Gate 1 on low-specificity copy", () => {
    const result = validateEmail(
      {
        subject: "Quick question",
        body: "Hi there, I wanted to reach out quickly and see if this is of interest.",
      },
      {
        isInitialOutreach: true,
        stepType: "proof",
        assumeManagedFooter: true,
        footerTemplate: MANDATORY_OUTREACH_FOOTER,
      }
    );

    assert.equal(result.pass, false);
    assert.equal(result.gates.gate1.pass, false);
    assert.ok(
      result.metrics.citation_density < 0.5
        || result.metrics.specificity_score < 1.5
        || result.metrics.research_density < 4.0
    );
  });

  it("reports Voice % and passes display threshold for strong prose", () => {
    const result = validateEmail(
      {
        subject: "Revolut X Propeller Fuels - I've done my research",
        body: [
          "Hi Alex,",
          "",
          "Reading through the FY2025 filing, what stood out was the structural mismatch under current scale. Usually, when a group trades USD flow while carrying GBP costs, the challenge shifts from payment execution to treasury control and operational friction.",
          "",
          "Your board flagged currency fluctuations in the strategic report, and the latest accounts indicate sustained cross-border exposure. Based on your filed accounts, we estimate the gap versus interbank execution on about GBP 160m annual flow is in the region of GBP 1.9m, though the actual figure depends on your current provider rates and would need a short review to confirm.",
          "",
          "At Revolut Business we see this pattern across similar mid-market teams. This estimate is illustrative of savings that could be achieved, but is not guaranteed. Would it be worth a short call to compare this against your current setup?",
        ].join("\n"),
      },
      {
        isInitialOutreach: true,
        stepType: "proof",
        assumeManagedFooter: true,
        footerTemplate: MANDATORY_OUTREACH_FOOTER,
      }
    );

    assert.equal(result.gates.gate1.pass, true);
    assert.equal(result.gates.gate3.pass, true);
    assert.equal(result.metrics.voice_display_pass, true);
    assert.ok(result.metrics.voice_percent >= 85);
  });

  it("fails Gate 3 when forbidden compliance phrases are present", () => {
    const result = validateEmail(
      {
        subject: "Guaranteed savings",
        body: "This is always free and guaranteed. Act now for the best rates.",
      },
      {
        isInitialOutreach: false,
        stepType: "depth",
        assumeManagedFooter: true,
        footerTemplate: MANDATORY_OUTREACH_FOOTER,
      }
    );

    assert.equal(result.gates.gate3.pass, false);
    assert.equal(result.pass, false);
  });

  it("uses the exact Gate 2 checklist contract", () => {
    const result = validateEmail(
      {
        subject: "Revolut X Propeller Fuels - I've done my research",
        body: [
          "Hi Alex,",
          "",
          "Reading through the FY2025 filing, what stood out was the structural mismatch under current scale.",
          "",
          "Based on your filed accounts, we estimate the gap versus interbank execution on about GBP 160m annual flow is in the region of GBP 1.9m, though the actual figure depends on your current provider rates and would need a short review to confirm.",
          "",
          "Best,",
          "Sophie Louise Penrose",
        ].join("\n"),
      },
      {
        isInitialOutreach: true,
        stepType: "proof",
        assumeManagedFooter: true,
        footerTemplate: MANDATORY_OUTREACH_FOOTER,
      }
    );

    const gate2Ids = result.gates.gate2.checks.map((check) => check.id);
    assert.deepEqual(gate2Ids, [
      "ai_tell",
      "pleasantries",
      "exclamation",
      "emdash",
      "and_but_openers",
      "three_item_rhythm",
      "closing_summary",
      "signoff",
      "full_name",
    ]);
  });

  it("uses the exact Gate 3 checklist contract", () => {
    const result = validateEmail(
      {
        subject: "Revolut X Propeller Fuels - I've done my research",
        body: [
          "Hi Alex,",
          "",
          "Based on your filed accounts, we estimate the gap versus interbank execution on about GBP 160m annual flow is in the region of GBP 1.9m, though the actual figure depends on your current provider rates and would need a short review to confirm.",
        ].join("\n"),
      },
      {
        isInitialOutreach: true,
        stepType: "proof",
        assumeManagedFooter: true,
        footerTemplate: MANDATORY_OUTREACH_FOOTER,
      }
    );

    const gate3Ids = result.gates.gate3.checks.map((check) => check.id);
    assert.deepEqual(gate3Ids, [
      "forbidden_phrases",
      "claims_traceability",
      "required_disclaimers",
      "rb_link",
      "opt_out",
      "privacy_notice",
    ]);
  });
});
