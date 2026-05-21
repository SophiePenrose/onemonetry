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
    expect(screen.getByText(/No competitor data/)).toBeInTheDocument();
  });

  it("handles absent strength", () => {
    const competitors = [
      { name: "None (greenfield)", product: "Cards", strength: "absent", notes: "No corporate card" },
    ];
    render(<CompetitorPanel competitors={competitors} />);
    expect(screen.getByText("None")).toBeInTheDocument();
  });
});
