import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Shortlist from "../pages/Shortlist";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

describe("Shortlist export modal", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async (input) => {
      const url = String(input || "");

      if (url.startsWith("/api/unified-shortlist")) {
        return jsonResponse({
          companies: [
            {
              id: "c1",
              name: "Acme Imports Ltd",
              company_number: "12345678",
              industry: "Logistics",
              segment: "Mid-Market",
              turnover: 32000000,
              combined_score: 0.84,
              priority_score: 0.84,
              workflow_state: "shortlisted",
              analysis_status: "ready",
              source: "daily:2026-05-31",
              latest_filing_date: "2026-05-30",
              rank: 1,
            },
          ],
          meta: {
            total: 1,
            showing: 1,
            excluded: 0,
            suppressed: 0,
          },
        });
      }

      if (url === "/api/analysis-queue/status") {
        return jsonResponse({
          enabled: true,
          counts: { queued: 0, ready: 0, failed: 0 },
        });
      }

      if (url.startsWith("/api/company/c1")) {
        return jsonResponse({
          company: {
            id: "c1",
            analysis: { summary: "Cross-border payment complexity." },
            stakeholders: [],
          },
        });
      }

      if (url.startsWith("/api/email/sequences/c1")) {
        return jsonResponse({
          sequences: [
            {
              id: "seq-1",
              stakeholder_name: "Alex Brown",
              created_at: "2026-05-31T10:00:00Z",
              steps: [
                {
                  step_number: 1,
                  step_type: "proof",
                  subject: "Treasury friction spotted",
                  body: "Your filing suggests avoidable cashflow drag.",
                  send_condition: "always",
                  review_status: "reviewed",
                },
              ],
            },
          ],
        });
      }

      if (url.startsWith("/api/email/export/json/seq-1")) {
        return jsonResponse({
          raw_rows: [
            {
              to: "",
              subject: "Treasury friction spotted",
              body: "Your filing suggests avoidable cashflow drag.",
              scheduled_date: "2026-06-02",
              scheduled_time: "08:37",
              step_number: 1,
              step_type: "proof",
              send_condition: "always",
              stakeholder_name: "Alex Brown",
              status: "pending",
              needs_email: true,
              needs_review: false,
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch call in test: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prepares export artifacts and enables Sheets + missing-email downloads", async () => {
    render(<Shortlist />);

    await screen.findByText("Acme Imports Ltd");

    fireEvent.click(screen.getByLabelText("Select all visible"));
    fireEvent.click(screen.getByRole("button", { name: "Prepare export" }));

    await screen.findByText("Batch Export for This Week");

    fireEvent.change(screen.getByLabelText("Missing email handling"), {
      target: { value: "include" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Prepare export file" }));

    await waitFor(() => {
      expect(screen.getByText(/Generated 1 rows from 1 companies/)).toBeInTheDocument();
    });

    const summaryText = screen.getByText((content) =>
      content.includes("Needs email: 1") && content.includes("missing contacts: 1")
    );
    expect(summaryText).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Download YAMM CSV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download Sheets JSON" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download Missing-Email CSV" })).toBeEnabled();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/email\/export\/json\/seq-1\?/));
  });
});