import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import HandoffReviews from "../components/HandoffReviews";
afterEach(() => vi.restoreAllMocks());
it("requires a checked outcome and review note before releasing an uncertain reservation, without sending", async () => {
  const onResolved = vi.fn();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((_url, options = {}) => Promise.resolve({ ok: true, json: async () => options.method === "POST"
    ? { capacity: { used: 0, remaining: 90 } } : { handoffs: [{ batch_id: "uncertain-1", campaign_name: "Finance leaders" }] } }));
  render(<HandoffReviews refreshToken={0} onResolved={onResolved} />);
  const button = await screen.findByRole("button", { name: /Contacts are absent/ }); expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText("What you checked in We-Connect"), { target: { value: "Verified this batch is absent from Finance leaders" } });
  fireEvent.click(button);
  await waitFor(() => expect(onResolved).toHaveBeenCalledWith({ used: 0, remaining: 90 }));
  const writes = fetcher.mock.calls.filter(([, options]) => options.method === "POST");
  expect(writes).toHaveLength(1); expect(writes[0][0]).toBe("/api/outreach/handoffs/uncertain-1/reconcile");
  expect(JSON.parse(writes[0][1].body).outcome).toBe("absent");
});
