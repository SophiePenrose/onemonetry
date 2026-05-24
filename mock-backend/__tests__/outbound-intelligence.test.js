import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutboundIntelligence,
  inferEmotionalContext,
  inferInternalPolitics,
  scoreWhyNow,
} from "../outbound-intelligence.js";

describe("outbound intelligence", () => {
  it("decays why-now urgency as trigger recency ages", () => {
    const hot = scoreWhyNow({ type: "new_hire", recency_days: 30 });
    const cold = scoreWhyNow({ type: "new_hire", recency_days: 220 });

    assert.equal(hot.urgency, "hot");
    assert.equal(cold.urgency, "cold");
    assert.ok(hot.score > cold.score);
  });

  it("infers emotional context for pressure and growth", () => {
    const pressure = inferEmotionalContext({}, { summary: "Loss-making with cost pressure" });
    const growth = inferEmotionalContext({}, { themes: [{ theme: "Hiring", evidence: "new finance roles" }] });

    assert.equal(pressure.state, "under_pressure");
    assert.equal(growth.state, "stretched_by_growth");
  });

  it("flags internal politics around credit and incumbent vendors", () => {
    const politics = inferInternalPolitics({}, {
      summary: "Barclays charge registered and Stripe is incumbent",
    });

    assert.equal(politics.friction_level, "medium");
    assert.ok(politics.hints.some((hint) => hint.includes("Credit relationship")));
    assert.ok(politics.hints.some((hint) => hint.includes("Status quo vendor")));
  });

  it("builds combined outbound intelligence", () => {
    const intelligence = buildOutboundIntelligence({
      company: { latest_filing_date: new Date().toISOString() },
      analysis: { summary: "new CFO appointed after acquisition" },
      trigger: { type: "filing_data_available", recency_days: 3 },
    });

    assert.equal(intelligence.why_now.urgency, "hot");
    assert.equal(intelligence.emotional_context.state, "new_leader_proving_value");
    assert.ok(intelligence.internal_politics.hints.length > 0);
  });
});
