import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateEmail } from "../email-qc.js";
import { deleteSequence, generateSequence } from "../email-sequences.js";

const createdSequenceIds = [];

afterEach(() => {
  for (const id of createdSequenceIds.splice(0)) {
    deleteSequence(id);
  }
});

function assertDeterministicStepQuality(step) {
  const qc = validateEmail(
    {
      subject: step.subject,
      body: step.body,
    },
    {
      isInitialOutreach: step.step_number === 1,
      assumeManagedFooter: true,
    }
  );

  assert.equal(qc.gates.gate3.pass, true);
  assert.equal(qc.metrics.within_subject_limit, true);
  assert.ok((step.subject || "").length <= 45);

  assert.equal(typeof step.qc_score, "number");
  assert.equal(typeof step.voice_percent, "number");
  assert.equal(step.quality_gates?.gate3?.pass, true);
}

describe("deterministic sequence QC persistence", () => {
  it("keeps Holistic and FX deterministic steps compliant and within subject limits", () => {
    const longCompanyName = "Very Long International Manufacturing Group Limited";

    const holistic = generateSequence({
      companyId: "qc-holistic-test-company",
      companyName: longCompanyName,
      stakeholderName: "Alex Carter",
      stakeholderRole: "CFO",
      motion: "Holistic Narrative",
      analysis: {
        pain_indicators: [{ pain: "manual treasury workflows" }],
        opportunities: [{ product: "FX" }],
        evidence_snippets: {
          pains: [{ quote: "Manual reconciliation stretches month-end close cycles." }],
        },
      },
      turnover: 125_000_000,
      employeeCount: 240,
      industry: "Manufacturing",
    });

    assert.ok(holistic);
    createdSequenceIds.push(holistic.id);
    assert.ok(Array.isArray(holistic.steps) && holistic.steps.length > 0);
    holistic.steps.forEach(assertDeterministicStepQuality);

    const fx = generateSequence({
      companyId: "qc-fx-test-company",
      companyName: longCompanyName,
      stakeholderName: "Sam Patel",
      stakeholderRole: "Finance Director",
      motion: "FX",
      analysis: {
        international_exposure: {
          present: true,
          details: "USD and EUR supplier payments",
        },
        pain_indicators: [{ pain: "high spread costs on international transfers" }],
        competitors_detected: [{ name: "Traditional Bank" }],
      },
      turnover: 160_000_000,
      employeeCount: 180,
      industry: "Retail",
    });

    assert.ok(fx);
    createdSequenceIds.push(fx.id);
    assert.ok(Array.isArray(fx.steps) && fx.steps.length > 0);
    fx.steps.forEach(assertDeterministicStepQuality);
  });
});
