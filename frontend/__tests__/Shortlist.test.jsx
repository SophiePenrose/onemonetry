import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Shortlist from "../pages/Shortlist";

const shortlistPayload = {
  companies: [
    {
      id: "ch-99111111",
      rank: 1,
      name: "READY TEST LIMITED",
      industry: "—",
      segment: "Mid-Market",
      turnover: 25000000,
      composite_score: null,
      best_motion: null,
      growth_trend: null,
      analysis_ready: true,
      analysis_status: "completed",
      has_filing_text: true,
      workflow_state: "new_candidate",
      below_threshold: false,
    },
    {
      id: "ch-99222222",
      rank: 2,
      name: "QUEUED TEST LIMITED",
      industry: "—",
      segment: "Mid-Market",
      turnover: 30000000,
      composite_score: null,
      best_motion: null,
      growth_trend: null,
      analysis_ready: false,
      analysis_status: "pending",
      has_filing_text: true,
      workflow_state: "new_candidate",
      below_threshold: false,
    },
  ],
  meta: { total: 42, showing: 2, limit: 100, offset: 0 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Shortlist", () => {
  it("uses API totals and actual analysis queue status badges", async () => {
    global.fetch = vi.fn(async (url) => {
      if (url.toString().startsWith("/api/analysis/status")) {
        return { ok: true, json: async () => ({ analysis: { running: false, queued: 0 } }) };
      }
      return { ok: true, json: async () => shortlistPayload };
    });

    render(<Shortlist />);

    expect(await screen.findByText("READY TEST LIMITED")).toBeInTheDocument();
    expect(screen.getByText("2 shown · 42 total")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();

    fireEvent.click(screen.getByText("↻ Refresh"));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/unified-shortlist?"));
  });
});
