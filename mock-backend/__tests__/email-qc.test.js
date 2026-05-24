import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { assessInferenceSafety, validateEmail } from "../email-qc.js";

describe("email QC calibration", () => {
  it("blocks forbidden claims and missing compliance footer", () => {
    const result = validateEmail(
      {
        subject: "Act now for free FX",
        body: "Hi Sarah,\n\nWe're the best and 60-80% cheaper. You will save thousands.",
      },
      { isInitialOutreach: true }
    );

    assert.equal(result.pass, false);
    assert.ok(result.issues.some((issue) => issue.violation.includes("Unapproved claim")));
    assert.ok(result.issues.some((issue) => issue.violation.includes("Missing opt-out")));
  });

  it("fallback generator appends the required footer and passes QC", async () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { generateLLMEmail } from "./email-generator.js";
         const email = await generateLLMEmail({
           company: { name: "ACME LIMITED", turnover: 25000000, employee_count: 80, industry: "Manufacturing", segment: "Mid-Market" },
           contact: { name: "Sarah Finance", role: "CFO" },
           analysis: { international_exposure: { present: true, details: "exports into Europe", currencies: ["EUR"] } },
           score: null,
           archetype: { id: "diagnostic_filing" },
           trigger: null,
           senderName: "Alex",
           stepNumber: 1,
           totalSteps: 4,
         });
         console.log(JSON.stringify(email));`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENAI_API_KEY: "" },
        encoding: "utf-8",
      }
    );
    const email = JSON.parse(output);

    assert.equal(email.qc_pass, true);
    assert.match(email.body, /sales outreach preferences/i);
    assert.match(email.body, /does not constitute financial/i);
    assert.doesNotMatch(email.body, /60[- ]?80%|unlimited cards|just checking in/i);
  });

  it("flags creepy or over-certain operational inference", () => {
    const safety = assessInferenceSafety({
      body: "We can see your customers are already Revolut users. This proves you need to switch. The gap is £67k.",
    });

    assert.equal(safety.level, "unsafe");
    assert.ok(safety.issues.some((issue) => issue.issue.includes("creepy")));
    assert.ok(safety.issues.some((issue) => issue.issue.includes("Over-certain")));
  });

  it("passes calibrated consultative outreach examples", () => {
    const result = validateEmail(
      {
        subject: "FX visibility at Acme",
        body: `Hi Sarah,

Noticed Acme has expanded across several European entities over the last 12 months.

We often see finance teams at that stage start running into friction around FX visibility, fragmented banking relationships, and reconciliation complexity as cross-border payment volume increases.

There may be an opportunity to simplify parts of that operational layer, particularly around multicurrency management and treasury workflows.

Worth a quick conversation if this is becoming an active area internally?

Alex
Account Executive | Revolut Business
revolut.com/business

To manage your sales outreach preferences or opt out, reply with your preference.
Any information provided does not constitute financial, investment, or trading advice.`,
      },
      { isInitialOutreach: true }
    );

    assert.equal(result.pass, true);
    assert.equal(result.metrics.inference_safety_level, "safe");
  });

  it("blocks creepy details, mail merge residue, and aggressive calendar asks", () => {
    const result = validateEmail(
      {
        subject: "Quick demo tomorrow",
        body: "Hi {{first_name}}, saw your daughter started school after you moved from Manchester to London. Are you free tomorrow at 2pm for a 30-minute demo?",
      },
      { isInitialOutreach: true }
    );

    assert.equal(result.pass, false);
    assert.ok(result.issues.some((issue) => issue.violation.includes("Creepy personal detail")));
    assert.ok(result.issues.some((issue) => issue.violation.includes("Mail merge placeholder")));
    assert.ok(result.issues.some((issue) => issue.violation.includes("Aggressive")));
  });
});
