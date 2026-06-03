import { describe, it, expect } from "vitest";
import { selectCompetitorContextMotion } from "../pages/CompanyDetail";

describe("selectCompetitorContextMotion", () => {
  it("returns the highest-score motion that has competitor context", () => {
    const motions = [
      {
        motion: "Cards",
        score: 0.62,
        score_breakdown: {
          competitor_context: { score: 0.51 },
        },
      },
      {
        motion: "API Integrations",
        score: 0.74,
        score_breakdown: {
          competitor_context: { score: 0.58 },
        },
      },
      {
        motion: "FX",
        score: 0.66,
        score_breakdown: {
          competitor_context: { score: 0.53 },
        },
      },
    ];

    const selected = selectCompetitorContextMotion(motions);
    expect(selected?.motion).toBe("API Integrations");
  });

  it("falls back to first competitor-context motion when scores are non-numeric", () => {
    const motions = [
      {
        motion: "Cards",
        score: "N/A",
        score_breakdown: {
          competitor_context: { score: 0.51 },
        },
      },
      {
        motion: "API Integrations",
        score: "unknown",
        score_breakdown: {
          competitor_context: { score: 0.58 },
        },
      },
    ];

    const selected = selectCompetitorContextMotion(motions);
    expect(selected?.motion).toBe("Cards");
  });

  it("returns null when no motion has competitor context", () => {
    const motions = [
      {
        motion: "Cards",
        score: 0.62,
        score_breakdown: {
          product_fit: { score: 0.8 },
        },
      },
    ];

    const selected = selectCompetitorContextMotion(motions);
    expect(selected).toBeNull();
  });
});
