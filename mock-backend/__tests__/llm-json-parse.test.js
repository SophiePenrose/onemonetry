import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseLlmJsonContent } from "../llm.js";

describe("parseLlmJsonContent", () => {
  it("parses fenced JSON content", () => {
    const content = "```json\n{\"summary\":\"Acme\",\"themes\":[]}\n```";
    const parsed = parseLlmJsonContent(content);

    assert.equal(parsed.summary, "Acme");
    assert.deepEqual(parsed.themes, []);
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
});
