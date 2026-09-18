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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
      if (String(url).startsWith("/api/unified-shortlist")) {
        return jsonResponse({ companies: [
          { id: "company-1", company_number: "01234567", name: "Example Ltd", website: "https://example.com", turnover: 50000000, priority_score: 92 },
          { id: "company-2", company_number: "09999999", name: "Too Small Ltd", website: "https://small.example", turnover: 15000000, priority_score: 99 },
        ] });
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
    expect(screen.getByText("Sending remains locked.")).toBeInTheDocument();

    const apolloCall = fetchMock.mock.calls.find(([url]) => url === "/api/contacts/apollo/search");
    expect(JSON.parse(apolloCall[1].body)).toEqual({ company_domain: "example.com", per_page: 8 });

    const planCall = fetchMock.mock.calls.find(([url]) => url === "/api/contacts/weekly-plan");
    const planRequest = JSON.parse(planCall[1].body);
    expect(planRequest.linkedin_automated_target).toBe(90);
    expect(planRequest.linkedin_manual_reserve).toBe(10);
    expect(planRequest.contacts[0]).toMatchObject({ crm_approved: true, company_turnover_gbp: 50000000 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });
});
