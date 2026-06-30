import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureHolisticAnalysisShape, parseLlmJsonContent } from "../llm.js";

describe("parseLlmJsonContent", () => {
  it("parses fenced JSON content", () => {
    const content = "```json\n{\"summary\":\"Acme\",\"themes\":[]}\n```";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.deepEqual(parsed.themes, []);
  });

  it("parses raw JSON content without code fences", () => {
    const content = "{\"summary\":\"Acme\",\"turnover_trend\":\"stable\"}";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.equal(parsed.turnover_trend, "stable");
  });

  it("parses leading prose followed by a JSON object", () => {
    const content = "Claude analysis result:\n{\"summary\":\"Acme\",\"turnover_trend\":\"growing\"}";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.equal(parsed.turnover_trend, "growing");
  });

  it("extracts and parses JSON with surrounding prose", () => {
    const content = "Model output follows:\n{\"summary\":\"Acme\",\"turnover_trend\":\"growing\"}\nEnd of output.";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.equal(parsed.turnover_trend, "growing");
  });

  it("repairs truncated JSON by closing open structures", () => {
    const content = "{\"summary\":\"Acme\",\"themes\":[{\"theme\":\"Growth\",\"evidence\":\"Revenue increased\"}],\"opportunities\":[{\"product\":\"FX\",\"confidence\":\"high\"}]";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.equal(parsed.opportunities.length, 1);
    assert.equal(parsed.opportunities[0].product, "FX");
  });

  it("parses prose-wrapped fenced truncated JSON", () => {
    const content = [
      "Here is your analysis:",
      "",
      "```json",
      "{\"summary\":\"Acme\",\"turnover_trend\":\"growing\",\"risks\":[\"legacy setup\",],\"opportunities\":[{\"product\":\"FX\",\"confidence\":\"high\"}]",
      "```",
      "",
      "End.",
    ].join("\n");

    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.equal(parsed.turnover_trend, "growing");
    assert.equal(parsed.opportunities[0].product, "FX");
  });

  it("removes trailing commas when parsing", () => {
    const content = "{\"summary\":\"Acme\",\"themes\":[{\"theme\":\"Growth\",\"evidence\":\"Revenue increased\",}],}";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.equal(parsed.themes[0].theme, "Growth");
  });

  it("normalizes nested level5_extraction into legacy analysis fields", () => {
    const normalized = ensureHolisticAnalysisShape({
      level5_extraction: {
        company_snapshot: {
          segment_fit: "Mid-Market",
          turnover_gbp: 42000000,
          employee_estimate: 180,
          operating_model: "UK retailer with online and wholesale channels",
          international_profile: "Cross-border supplier payments in EUR and USD",
        },
        pain_register: [
          {
            area: "FX",
            evidence: "Significant overseas supplier exposure",
            inferred_problem: "Potential FX spread leakage on recurring payables",
            severity: "high",
          },
        ],
        revolut_opportunity: {
          pitch_summary: "Lead with FX and sequence into cards controls.",
          recommended_use_cases: [
            {
              product: "FX",
              priority: "High",
              why_fit: "Frequent non-GBP settlement needs.",
              example_use_case: "Hold EUR/USD wallets and lock forward rates for known payables.",
            },
          ],
          not_priority: [],
        },
        sequence_inputs: {
          now_trigger: "Recent filing highlights international operations.",
          quantified_hook: "Estimated annual FX leakage opportunity around £120k.",
          operations_hook: "Supplier payments span multiple currencies.",
          governance_hook: "Current setup likely fragmented across providers.",
          directors_language: ["cash flow", "cost control"],
          objection_to_preempt: "Keep existing credit lines while improving FX execution.",
        },
      },
      supplementary_context: {
        people_research: [
          {
            name: "Jane Doe",
            role: "Finance Director",
            linkedin_search_url: null,
            lusha_status: "unknown",
          },
        ],
      },
    }, "The group has overseas supplier commitments and growing payment complexity.", {
      companyName: "Acme Ltd",
      turnover: 42000000,
    });

    assert.ok(Array.isArray(normalized.themes));
    assert.ok(normalized.themes.length >= 1);

    assert.ok(Array.isArray(normalized.pain_indicators));
    assert.equal(normalized.pain_indicators[0].pain, "Potential FX spread leakage on recurring payables");

    assert.ok(Array.isArray(normalized.opportunities));
    assert.equal(normalized.opportunities[0].product, "FX");

    assert.ok(Array.isArray(normalized.key_people));
    assert.equal(normalized.key_people[0].name, "Jane Doe");

    assert.equal(typeof normalized.recommended_approach, "string");
    assert.ok(normalized.recommended_approach.length > 0);
  });
});
