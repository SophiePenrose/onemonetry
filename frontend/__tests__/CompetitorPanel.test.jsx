import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import CompetitorPanel from "../components/CompetitorPanel";

describe("CompetitorPanel", () => {
  it("renders competitor entries", () => {
    const competitors = [
      { name: "HSBC", product: "FX", strength: "strong", notes: "Long-standing relationship" },
      { name: "Shell Fleet", product: "Cards", strength: "weak", notes: "Fuel cards only" },
    ];
    render(<CompetitorPanel competitors={competitors} />);
    expect(screen.getByText("HSBC")).toBeInTheDocument();
    expect(screen.getByText("Shell Fleet")).toBeInTheDocument();
    expect(screen.getByText("Strong")).toBeInTheDocument();
    expect(screen.getByText("Weak")).toBeInTheDocument();
    expect(screen.getByText("Long-standing relationship")).toBeInTheDocument();
  });

  it("renders empty state", () => {
    render(<CompetitorPanel competitors={[]} />);
    expect(screen.getByText(/No stack data/)).toBeInTheDocument();
  });

  it("handles absent strength", () => {
    const competitors = [
      { name: "None (greenfield)", product: "Cards", strength: "absent", notes: "No corporate card" },
    ];
    render(<CompetitorPanel competitors={competitors} />);
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("renders stack context scoring summary when competitor context is provided", () => {
    const competitorContext = {
      score: 0.61,
      base_score: 0.52,
      motion_tuning_delta: 0.04,
      holistic_tuning_delta: 0.05,
      strategic_signal: "consolidation_play",
      holistic_tuning_adjustments: [
        { reason: "holistic_consolidation_gap", impact: 0.03 },
      ],
    };

    render(<CompetitorPanel competitors={[]} competitorContext={competitorContext} />);

    expect(screen.getByText("Stack Context Scoring")).toBeInTheDocument();
    expect(screen.getByText("61%")).toBeInTheDocument();
    expect(screen.getByText(/Signal:/)).toBeInTheDocument();
    expect(screen.getByText("Consolidation Play")).toBeInTheDocument();
    expect(screen.getByText(/Base 0\.52 \| Motion \+0\.04 \| Holistic \+0\.05/)).toBeInTheDocument();
    expect(screen.getByText(/holistic consolidation gap \(\+0\.03\)/i)).toBeInTheDocument();
  });
});
