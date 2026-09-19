import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Monitoring, { safeEvidenceUrl } from "../pages/Monitoring";

const row = { alert_id: "00000000-0000-0000-0000-000000000001", company_number: "00123456", company_name: "Example Limited", filing_type: "AP01", officer_name: "Alex Director", company_status: "active", turnover_gbp: 50000000, status: "new", updated_at: "2026-09-19T09:00:00Z", reasons: [{ summary: "Appointment reported by Companies House" }], workspace: { turnover_scope: "in_scope", company_id: null } };
const json = (data, ok = true) => Promise.resolve({ ok, json: async () => data });
afterEach(() => vi.restoreAllMocks());

describe("Unified monitoring workspace", () => {
  it("opens source evidence without creating a research record, spending credits or approving outreach", async () => {
    const onOpen = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
      if (options.method === "POST") return json({ company_id: "ch-00123456", outreach_approved: false });
      return json({ rows: [row], total: 1, review_enabled: false });
    });
    render(<Monitoring onOpenCompany={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: "Example Limited" }));
    expect(screen.getByText("Appointment reported by Companies House")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options]) => options.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add to research workspace" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("ch-00123456"));
    const writes = fetchMock.mock.calls.filter(([, options]) => options.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/monitoring/companies/00123456/research");
    expect(JSON.parse(writes[0][1].body)).toEqual({});
  });
  it("uses the existing company ID without reimporting or losing its workflow", async () => {
    const onOpen = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => json({ rows: [{ ...row, workspace: { company_id: "c123", suppressed: true } }], total: 1 }));
    render(<Monitoring onOpenCompany={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: "Example Limited" }));
    fireEvent.click(screen.getByRole("button", { name: "Open company workspace" }));
    expect(onOpen).toHaveBeenCalledWith("c123");
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });
  it("keeps review notes mandatory and shows stale-write conflicts without reporting success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => options.method === "POST" ? json({ error: "review_conflict" }, false) : json({ rows: [row], total: 1, review_enabled: true }));
    render(<Monitoring />);
    fireEvent.click(await screen.findByRole("button", { name: "Example Limited" }));
    expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Evidence and next step"), { target: { value: "Verify role before contacting" } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This alert changed");
    const write = fetchMock.mock.calls.find(([, options]) => options.method === "POST");
    expect(JSON.parse(write[1].body).expected_updated_at).toBe(row.updated_at);
  });
  it("shows disconnected monitoring honestly and keeps it distinct from an empty inbox", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json({ error: "monitoring_not_configured" }, false));
    render(<Monitoring />);
    expect(await screen.findByRole("alert")).toHaveTextContent("connection needs to be configured");
    expect(screen.queryByText(/No matching alerts/)).not.toBeInTheDocument();
  });
  it("rejects executable source links", () => {
    expect(safeEvidenceUrl("javascript:alert(1)")).toBe(null);
    expect(safeEvidenceUrl("https://example.com/filing")).toBe("https://example.com/filing");
  });
});
