import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ScoreExplanation from "../components/ScoreExplanation";

describe("ScoreExplanation", () => {
  const mockBreakdown = {
    product_fit: { score: 0.95, evidence: "Strong international trade" },
    commercial_value: { score: 0.80, evidence: "High turnover" },
    pain_strength: { score: 0.70, evidence: "Manual processes" },
    urgency: { score: 0.60, evidence: "CFO reviewing options" },
    competitor_context: { score: 0.50, evidence: "Weak incumbent" },
  };

  it("renders composite score", () => {
    render(
      <ScoreExplanation
        productFit={{ fit_level: "strong" }}
        scoreBreakdown={mockBreakdown}
        finalScore={0.85}
        explanation="Strong FX prospect"
      />
    );
    expect(screen.getByText("0.85")).toBeInTheDocument();
  });

  it("renders fit level", () => {
    render(
      <ScoreExplanation
        productFit={{ fit_level: "strong" }}
        scoreBreakdown={mockBreakdown}
        finalScore={0.85}
        explanation="Test"
      />
    );
    expect(screen.getByText("strong")).toBeInTheDocument();
  });

  it("renders all 5 scoring layers", () => {
    render(
      <ScoreExplanation
        productFit={{ fit_level: "strong" }}
        scoreBreakdown={mockBreakdown}
        finalScore={0.85}
        explanation="Test"
      />
    );
    expect(screen.getByText("Product Fit")).toBeInTheDocument();
    expect(screen.getByText("Commercial Value")).toBeInTheDocument();
    expect(screen.getByText("Pain Strength")).toBeInTheDocument();
    expect(screen.getByText("Urgency")).toBeInTheDocument();
    expect(screen.getByText("Current Stack Context")).toBeInTheDocument();
  });

  it("renders evidence text for each layer", () => {
    render(
      <ScoreExplanation
        productFit={{ fit_level: "strong" }}
        scoreBreakdown={mockBreakdown}
        finalScore={0.85}
        explanation="Test"
      />
    );
    expect(screen.getByText("Strong international trade")).toBeInTheDocument();
    expect(screen.getByText("High turnover")).toBeInTheDocument();
  });

  it("renders explanation text", () => {
    render(
      <ScoreExplanation
        productFit={{ fit_level: "medium" }}
        scoreBreakdown={{}}
        finalScore={0.5}
        explanation="Moderate FX need"
      />
    );
    expect(screen.getByText("Moderate FX need")).toBeInTheDocument();
  });
});
