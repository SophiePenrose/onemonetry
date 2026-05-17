import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import WorkflowPanel from "../components/WorkflowPanel";

describe("WorkflowPanel", () => {
  const transitions = {
    new_candidate: ["shortlisted", "held_for_review", "revisit_later"],
    shortlisted: ["selected_for_outreach", "revisit_later", "held_for_review", "new_candidate"],
    closed_won: [],
  };

  it("renders current state", () => {
    render(
      <WorkflowPanel
        companyId="c1"
        currentState="new_candidate"
        history={[]}
        transitions={transitions}
      />
    );
    expect(screen.getByText("New Candidate")).toBeInTheDocument();
  });

  it("shows transition buttons for valid next states", () => {
    render(
      <WorkflowPanel
        companyId="c1"
        currentState="new_candidate"
        history={[]}
        transitions={transitions}
      />
    );
    expect(screen.getByText("Shortlisted")).toBeInTheDocument();
    expect(screen.getByText("Held for Review")).toBeInTheDocument();
    expect(screen.getByText("Revisit Later")).toBeInTheDocument();
  });

  it("shows no transitions for terminal state", () => {
    render(
      <WorkflowPanel
        companyId="c1"
        currentState="closed_won"
        history={[]}
        transitions={transitions}
      />
    );
    expect(screen.getByText("No transitions available from this state.")).toBeInTheDocument();
  });

  it("renders history entries", () => {
    const history = [
      { state: "new_candidate", timestamp: "2026-05-01T00:00:00Z", note: "Initial state" },
      { from: "new_candidate", to: "shortlisted", timestamp: "2026-05-10T00:00:00Z", note: "Strong prospect" },
    ];
    render(
      <WorkflowPanel
        companyId="c1"
        currentState="shortlisted"
        history={history}
        transitions={transitions}
      />
    );
    expect(screen.getByText(/Strong prospect/)).toBeInTheDocument();
  });

  it("renders note input field", () => {
    render(
      <WorkflowPanel
        companyId="c1"
        currentState="new_candidate"
        history={[]}
        transitions={transitions}
      />
    );
    expect(screen.getByPlaceholderText(/Add a note/)).toBeInTheDocument();
  });
});
