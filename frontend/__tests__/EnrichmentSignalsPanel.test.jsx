import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EnrichmentSignalsPanel from "../components/EnrichmentSignalsPanel";

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("EnrichmentSignalsPanel", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete globalThis.fetch;
    }
  });

  it("shows people, tech, and intent evidence plus partial Prospeo warnings", async () => {
    const snapshot = {
      enrichment: {
        hiring_signals: {
          available: true,
          updated_at: "2026-07-03T10:00:00.000Z",
          stale: false,
          data: {
            hiring_signal_score: 0.82,
            hiring_intensity: "medium",
            person_candidates: [
              { full_name: "Rae Morgan", job_title: "Head of Ecommerce" },
            ],
            new_senior_hires: [
              { full_name: "Alex Stone", job_title: "Director of Ecommerce" },
            ],
          },
        },
        marketing_intelligence: { available: false, stale: false, data: null },
        tech_stack: {
          available: true,
          updated_at: "2026-07-03T10:00:00.000Z",
          stale: false,
          data: {
            confidence_score: 0.77,
            technologies: ["Shopify", "Stripe"],
          },
        },
        intent_signals: {
          available: true,
          updated_at: "2026-07-03T10:00:00.000Z",
          stale: false,
          data: {
            intent_signal_score: 0.86,
            topics: ["Payment Gateway", "Checkout Optimization"],
            categories: ["Transactions & Payments", "eCommerce"],
            motions: ["Merchant Acquiring"],
            signals: [{ topic: "Payment Gateway", strength: "high" }],
          },
        },
        reputation: { available: false, stale: false, data: null },
        ownership: { available: false, stale: false, data: null },
      },
    };

    globalThis.fetch = vi.fn((url, options = {}) => {
      const method = options?.method || "GET";
      const href = String(url || "");

      if (href.includes("/api/company/SC107277/enrichment")) {
        return jsonResponse(snapshot);
      }

      if (href === "/api/integrations/status") {
        return jsonResponse({
          integrations: {
            prospeo: { configured: true },
            phantombuster: { configured: false, env_var: "PHANTOMBUSTER_API_KEY" },
          },
        });
      }

      if (href === "/api/signals/sync/SC107277" && method === "POST") {
        return jsonResponse({
          status: "updated",
          connectors: [
            {
              id: "prospeo",
              ok: true,
              hiring_updated: true,
              tech_updated: true,
              attempts: [
                { url: "https://api.prospeo.io/search-company", ok: false, status: 400 },
              ],
            },
          ],
        });
      }

      return jsonResponse({ error: "unexpected request" }, 404);
    });

    render(<EnrichmentSignalsPanel companyId="SC107277" companyNumber="SC107277" />);

    expect(await screen.findByText("person candidates: 1")).toBeInTheDocument();
    expect(screen.getByText("recent desired-role hires: 1")).toBeInTheDocument();
    expect(screen.getByText("sample technologies: Shopify, Stripe")).toBeInTheDocument();
    expect(screen.getByText("sample topics: Payment Gateway, Checkout Optimization")).toBeInTheDocument();
    expect(screen.getByText("categories: Transactions & Payments, eCommerce")).toBeInTheDocument();
    expect(screen.getByText("mapped motions: Merchant Acquiring")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run Prospeo Sync" }));

    await waitFor(() => {
      expect(screen.getByText("Prospeo sync completed. Updated: hiring, tech. Partial issue: search-company 400.")).toBeInTheDocument();
    });
  });
});
