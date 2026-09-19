import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WeeklyOutreach from "../pages/WeeklyOutreach";
import { createOutreachDraftClient } from "../hooks/useOutreachDraft";

const json = data => Promise.resolve({ ok: true, status: 200, json: async () => data });
afterEach(() => vi.restoreAllMocks());
function setup(turnover = 50000000) {
  let saved = { week_start: "2026-09-14", revision: 1, draft: {
    selected_company_numbers: ["00123456"], selected_contact_keys: ["person-1"], campaign_name: "Saved cadence",
    contacts: [{ person_id: "person-1", full_name: "Jane Example", company_number: "00123456", company_name: "Example Ltd", company_turnover_gbp: 50000000, linkedin_url: "https://linkedin.com/in/example", phone_dnc: true }],
  } };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
    if (url === "/api/outreach/capacity") return json({ used: 0, remaining: 90 });
    if (url === "/api/outreach/handoffs/pending") return json({ handoffs: [] });
    if (url === "/api/outreach/draft") {
      if (options.method === "PUT") { const body = JSON.parse(options.body); saved = { ...saved, revision: saved.revision + 1, draft: body.draft }; }
      return json(saved);
    }
    if (url.startsWith("/api/unified-shortlist")) return json({ companies: [{ company_number: "00123456", name: "Example Ltd", turnover, website: "example.com" }] });
    if (url === "/api/integrations/we-connect/status") return json({ configured: true });
    if (url === "/api/contacts/weekly-plan") return json({ summary: {}, assignments: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  return fetcher;
}
describe("Saved outreach review", () => {
  it("restores review choices after remount without restoring a sendable plan or calling a provider", async () => {
    const fetcher = setup();
    const first = render(<WeeklyOutreach draftClient={createOutreachDraftClient()} />);
    expect(await screen.findByLabelText("Include Jane Example")).toBeChecked();
    expect(screen.queryByRole("button", { name: /Confirm and add/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Include Jane Example"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Draft saved"));
    first.unmount();
    render(<WeeklyOutreach draftClient={createOutreachDraftClient()} />);
    expect(await screen.findByLabelText("Include Jane Example")).not.toBeChecked();
    expect(fetcher.mock.calls.some(([, options]) => options.method === "POST")).toBe(false);
  });
  it("excludes contacts when their company is removed and invalidates any previous plan", async () => {
    setup(); render(<WeeklyOutreach draftClient={createOutreachDraftClient()} />);
    await screen.findByLabelText("Include Jane Example");
    expect(screen.getByRole("button", { name: "Confirm CRM clearance and generate plan" })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm CRM clearance and generate plan" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Confirm CRM clearance and generate plan" }));
    expect(await screen.findByRole("button", { name: "Prepare manual fallback" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Example Ltd/ }));
    expect(screen.queryByRole("button", { name: "Prepare manual fallback" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm CRM clearance and generate plan" })).toBeDisabled();
    expect(screen.getByLabelText("Include Jane Example")).toBeDisabled();
    expect(screen.getByLabelText("Include Jane Example")).not.toBeChecked();
  });
  it.each([15000000, null])("rechecks current turnover (%s) instead of trusting the saved contact's old value", async turnover => {
    setup(turnover); render(<WeeklyOutreach draftClient={createOutreachDraftClient()} />);
    await screen.findByLabelText("Include Jane Example");
    expect(screen.getByRole("button", { name: "Confirm CRM clearance and generate plan" })).toBeDisabled();
    expect(screen.getByLabelText("Include Jane Example")).toBeDisabled();
  });
});
