import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ActiveOpportunities from "../pages/ActiveOpportunities";

afterEach(() => vi.restoreAllMocks());
it("opens existing profiles and records a confirmed stage change through the workflow API", async () => {
  const opportunity = { id: "ch-00123456", company_number: "00123456", name: "Synthetic Ltd", workflow_state: "active_opportunity", combined_score: null };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options = {}) => {
    if (options.method === "PATCH") opportunity.workflow_state = JSON.parse(options.body).new_state;
    return { ok: true, json: async () => ({ opportunities: [opportunity], meta: { counts: { [opportunity.workflow_state]: 1 } } }) };
  });
  const open = vi.fn(); const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<ActiveOpportunities onNavigateToCompany={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open profile" }));
  expect(open).toHaveBeenCalledWith("ch-00123456");
  fireEvent.click(screen.getByRole("button", { name: "Closed lost", exact: true }));
  expect(fetcher.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  confirmation.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Closed lost", exact: true }));
  await screen.findByRole("button", { name: "Return to triage" });
  const change = fetcher.mock.calls.find(([, options]) => options?.method === "PATCH");
  expect(change[0]).toBe("/api/company/ch-00123456/state");
  expect(JSON.parse(change[1].body).new_state).toBe("closed_lost");
});

it("shows a failed read and lets the owner retry", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, json: async () => ({ error: "Saved workspace unavailable" }) });
  render(<ActiveOpportunities />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Saved workspace unavailable");
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ opportunities: [], meta: {} }) });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
