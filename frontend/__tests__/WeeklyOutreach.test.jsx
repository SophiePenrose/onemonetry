import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WeeklyOutreach, { companyDomain, turnoverValue } from "../pages/WeeklyOutreach";

function jsonResponse(data, ok = true) {
  return Promise.resolve({ ok, json: async () => data });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WeeklyOutreach", () => {
  it("normalises company data used for eligibility and Apollo search", () => {
    expect(companyDomain({ website: "https://www.example.com/about" })).toBe("example.com");
    expect(turnoverValue({ turnover: "£45,000,000" })).toBe(45000000);
  });

  it("builds an approval-only weekly plan from CRM-cleared companies", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
      if (String(url).startsWith("/api/unified-shortlist")) {
        return jsonResponse({ companies: [
          { id: "company-1", company_number: "01234567", name: "Example Ltd", website: "https://example.com", turnover: 50000000, priority_score: 92 },
          { id: "company-2", company_number: "09999999", name: "Too Small Ltd", website: "https://small.example", turnover: 15000000, priority_score: 99 },
        ] });
      }
      if (url === "/api/integrations/we-connect/status") {
        return jsonResponse({ configured: true, mode: "direct_api", approval_required: true });
      }
      if (url === "/api/contacts/apollo/search") {
        return jsonResponse({ candidates: [{ person_id: "apollo-1", full_name: "Jane Doe", role: "Finance Director", linkedin_url: "https://linkedin.com/in/jane-doe", email: "jane@example.com" }] });
      }
      if (url === "/api/contacts/weekly-plan") {
        return jsonResponse({
          summary: { linkedin_automated_selected: 1, email_ready: 1, phone_tasks_ready: 0, overflow_contacts: 0, active_companies_this_week: 1 },
          assignments: [{ person_id: "apollo-1", full_name: "Jane Doe", role: "Finance Director", company_name: "Example Ltd", priority: 92, routes: { linkedin: "awaiting_human_approval", email: "ready" } }],
        });
      }
      if (url === "/api/linkedin/we-connect/manual-export") {
        return jsonResponse({
          url_text: "https://linkedin.com/in/jane-doe",
          summary: { ready_to_paste: 1, previously_exported: 0, skipped: 0 },
          batch: { id: "batch-1", status: "prepared" },
        });
      }
      if (url === "/api/linkedin/we-connect/manual-export/batch-1/confirm") {
        return jsonResponse({ id: "batch-1", status: "confirmed_pasted" });
      }
      if (url === "/api/linkedin/we-connect/import") {
        return jsonResponse({
          success: true,
          campaign_name: "Weekly Finance Leaders",
          summary: { ready_to_import: 1, previously_exported: 0, skipped: 0 },
          batch: { id: "batch-api-1", status: "imported_api" },
        });
      }
      throw new Error(`Unexpected fetch: ${url} ${options.method || "GET"}`);
    });

    render(<WeeklyOutreach />);
    expect(await screen.findByText("Example Ltd")).toBeInTheDocument();
    expect(screen.queryByText("Too Small Ltd")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Example Ltd"));
    fireEvent.click(screen.getByRole("button", { name: "Find contacts for 1 companies" }));
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate weekly plan" }));
    expect(await screen.findByText("Ready for approval")).toBeInTheDocument();
    expect(screen.getByText("Human approval stays mandatory.")).toBeInTheDocument();

    const apolloCall = fetchMock.mock.calls.find(([url]) => url === "/api/contacts/apollo/search");
    expect(JSON.parse(apolloCall[1].body)).toEqual({ company_domain: "example.com", per_page: 8 });

    const planCall = fetchMock.mock.calls.find(([url]) => url === "/api/contacts/weekly-plan");
    const planRequest = JSON.parse(planCall[1].body);
    expect(planRequest.linkedin_automated_target).toBe(90);
    expect(planRequest.linkedin_manual_reserve).toBe(10);
    expect(planRequest.contacts[0]).toMatchObject({ crm_approved: true, company_turnover_gbp: 50000000 });

    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Weekly Finance Leaders" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and add 1 contacts" }));
    expect(await screen.findByText("Added to Weekly Finance Leaders")).toBeInTheDocument();
    const importCall = fetchMock.mock.calls.find(([url]) => url === "/api/linkedin/we-connect/import");
    expect(JSON.parse(importCall[1].body)).toMatchObject({ approved: true, campaign_name: "Weekly Finance Leaders" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
  });
});
