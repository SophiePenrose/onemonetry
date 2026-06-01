import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(
  os.tmpdir(),
  `email-sequences-all-motions-qc-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
);
process.env.DATABASE_PATH = dbPath;

const db = (await import("../db.js")).default;
const { generateSequence, getSequence, deleteSequence } = await import("../email-sequences.js");
const { validateEmail } = await import("../email-qc.js");

const motions = ["FX", "FX Forwards", "Cards", "Spend Management", "Merchant Acquiring", "Holistic Narrative"];
const createdSequenceIds = [];

after(() => {
  for (const sequenceId of createdSequenceIds.splice(0)) {
    deleteSequence(sequenceId);
  }
  try {
    db.close();
  } catch {
    // ignore close errors during teardown
  }
  fs.rmSync(dbPath, { force: true });
});

test("all deterministic motions generate gate2+gate3 clean steps", () => {
  const companyName = "Very Long International Manufacturing and Distribution Group plc";
  const analysis = {
    international_exposure: {
      present: true,
      details: "USD and EUR supplier settlement exposure",
    },
    pain_indicators: [
      { pain: "manual reconciliation between treasury and AP teams" },
      { pain: "payment approval handoffs slow month-end close" },
    ],
    opportunities: [{ product: "FX" }, { product: "Cards" }],
    competitors_detected: [{ name: "Incumbent Bank", displacement_angle: "better visibility and control" }],
    evidence_snippets: {
      pains: [{ quote: "Manual handoffs increase reconciliation effort in finance operations." }],
      suitability: [{ quote: "Management continues investing in systems that tighten controls and reporting cadence." }],
      gaps: [{ quote: "The report highlights pressure on working capital visibility and cash planning accuracy." }],
    },
    outreach_narrative: {
      revolut_advantage: "Start from one validated lane, then widen scope only after measurable operational gains.",
    },
    level5_extraction: {
      sequence_inputs: {
        now_trigger: "Your latest filing points to active finance process redesign and execution pressure.",
        quantified_hook: "A measured baseline pass can isolate spread, fee, and workflow friction quickly.",
        operations_hook: "cross-border payment volume and month-end controls remain tightly coupled",
        governance_hook: "handoffs between existing payment providers and internal finance controls",
        objection_to_preempt: "This can run alongside current providers while ownership remains unchanged.",
        directors_language: ["The board commentary highlights execution consistency and control discipline as priorities."],
      },
      pain_register: [
        {
          inferred_problem: "finance teams absorb avoidable execution drag across payment workflows",
          evidence: "Board commentary flags process complexity and reporting pressure.",
        },
      ],
      revolut_opportunity: {
        recommended_use_cases: [
          { product: "Cards", example_use_case: "Start with cards controls and approval routing in one region." },
          { product: "FX", example_use_case: "Pilot FX conversion for scheduled supplier payments first." },
          { product: "Merchant Acquiring", example_use_case: "Tighten settlement timing for card collections." },
        ],
      },
    },
  };

  for (const motion of motions) {
    const generated = generateSequence({
      companyId: `qc-all-motions-${motion.toLowerCase().replace(/\s+/g, "-")}`,
      companyName,
      stakeholderName: "Alex Carter",
      stakeholderRole: "CFO",
      motion,
      analysis,
      turnover: 245_000_000,
      employeeCount: 820,
      industry: "Manufacturing",
    });

    assert.ok(generated, `expected sequence for motion ${motion}`);
    createdSequenceIds.push(generated.id);
    assert.equal(generated.motion, motion, `expected returned motion to remain ${motion}`);

    const persisted = getSequence(generated.id);
    assert.ok(persisted, `expected persisted sequence for motion ${motion}`);
    assert.equal(persisted.motion, motion, `expected persisted motion to remain ${motion}`);

    for (const step of persisted.steps) {
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

      assert.equal(qc.gates.gate2.pass, true, `gate2 should pass for motion ${motion}, step ${step.step_number}`);
      assert.equal(qc.gates.gate3.pass, true, `gate3 should pass for motion ${motion}, step ${step.step_number}`);
      assert.ok((step.subject || "").length <= 45, `subject should be <=45 chars for motion ${motion}, step ${step.step_number}`);
    }
  }
});
