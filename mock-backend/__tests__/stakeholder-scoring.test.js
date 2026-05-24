import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  areLikelySamePerson,
  buildMultiThreadingStrategy,
  mergeStakeholderIdentities,
  scoreAllStakeholders,
} from "../stakeholder-scoring.js";

describe("stakeholder scoring framework", () => {
  it("resolves likely duplicate identities across sources", () => {
    assert.equal(
      areLikelySamePerson({ name: "James Y J Chen" }, { name: "James Chen" }),
      true
    );

    const merged = mergeStakeholderIdentities([
      { name: "James Y J Chen", role: "Director", source: "companies_house_filing" },
      { name: "James Chen", role: "CFO", email: "james@example.com", source: "manual" },
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].role, "CFO");
    assert.equal(merged[0].email, "james@example.com");
    assert.equal(merged[0].source, "manual");
    assert.deepEqual(merged[0].sources.sort(), ["companies_house_filing", "manual"]);
  });

  it("scores operational buyers and category familiarity without ignoring confidence", () => {
    const scored = scoreAllStakeholders(
      [
        {
          name: "Priya Shah",
          role: "Treasury Manager",
          previous_employer: "Wise",
          source: "linkedin",
        },
        {
          name: "Alex Chief",
          role: "CEO",
          source: "companies_house_filing",
        },
      ],
      {
        company: { name: "Export Test Limited", turnover: 45000000 },
        analysis: { themes: [{ theme: "Hiring", evidence: "new finance roles" }] },
        motion: "FX",
      }
    );

    const priya = scored.find((person) => person.name === "Priya Shah");
    assert.equal(priya.buying_role, "champion");
    assert.equal(priya.category_familiarity_score, 5);
    assert.ok(priya.flags.some((flag) => flag.includes("Operational buyer")));
    assert.ok(priya.final_score > 0);
  });

  it("builds a multi-threading plan from champion and decision-maker roles", () => {
    const strategy = buildMultiThreadingStrategy([
      { name: "Priya Shah", buying_role: "champion" },
      { name: "Alex Chief", buying_role: "decision_maker" },
      { name: "Morgan Procure", buying_role: "gatekeeper" },
    ]);

    assert.equal(strategy.mode, "multi_thread");
    assert.equal(strategy.max_same_day, 2);
    assert.ok(strategy.steps.some((step) => step.includes("Start with champion")));
    assert.ok(strategy.steps.some((step) => step.includes("Never email more than 2")));
  });
});
