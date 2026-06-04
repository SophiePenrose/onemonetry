import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "../pages/Settings";

function jsonResponse(data, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => data,
  });
}

const baseWeights = {
  product_fit: 0.2,
  commercial_value: 0.2,
  pain_strength: 0.2,
  urgency: 0.2,
  competitor_context: 0.2,
};

describe("Settings", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn((url, options) => {
      const method = options?.method || "GET";

      if (url === "/api/scoring-weights" && method === "GET") {
        return jsonResponse({
          segment_weights: {
            SMB: { ...baseWeights },
            "Mid-Market": { ...baseWeights },
            Enterprise: { ...baseWeights },
          },
          propensity_weight: 0.15,
        });
      }

      if (url === "/api/integrations/status") {
        return jsonResponse({
          integrations: {
            endole: { configured: true, required: true, purpose: "Company data", env_var: "ENDOLE_API_KEY" },
            builtwith: { configured: false, required: false, purpose: "Tech stack", env_var: "BUILTWITH_KEY" },
          },
          ready_for_production: true,
          missing_required: [],
          env_template: ["ENDOLE_API_KEY=", "BUILTWITH_KEY="],
        });
      }

      if (url === "/api/unified-shortlist") {
        return jsonResponse({
          companies: [
            { id: "c1", rank: 1, name: "Acme", segment: "SMB", combined_score: 0.8234 },
            { id: "c2", rank: 2, name: "Beta", segment: "Mid-Market", combined_score: "not-a-number" },
          ],
        });
      }

      if (url === "/api/exclusions" && method === "GET") {
        return jsonResponse({
          exclusions: {
            prohibited_industries: ["Gambling"],
            excluded_company_ids: [],
            prohibited_sic_codes: ["62012"],
          },
          suppressed_states: ["closed_won"],
        });
      }

      if (url === "/api/exclusions" && method === "PUT") {
        const payload = JSON.parse(options?.body || "{}");
        return jsonResponse({
          exclusions: {
            prohibited_industries: ["Gambling"],
            excluded_company_ids: [],
            prohibited_sic_codes: payload.prohibited_sic_codes || [],
          },
        });
      }

      if (url === "/api/scoring-weights" && method === "PUT") {
        return jsonResponse({ ok: true }, true);
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders integration summary and preview score fallback", async () => {
    render(<Settings />);

    expect(await screen.findByText("Scoring Settings")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/1\/2 configured/)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Acme")).toBeInTheDocument();
      expect(screen.getByText("N/A")).toBeInTheDocument();
    });
  });

  it("shows validation error and blocks save when segment totals are invalid", async () => {
    render(<Settings />);

    expect(await screen.findByText("Scoring Settings")).toBeInTheDocument();

    const sliders = await screen.findAllByRole("slider");
    fireEvent.change(sliders[0], { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Weights" }));

    expect(screen.getByText(/SMB weights must sum to 100%/)).toBeInTheDocument();

    const putCalls = fetchMock.mock.calls.filter(
      ([url, options]) => url === "/api/scoring-weights" && options?.method === "PUT"
    );
    expect(putCalls).toHaveLength(0);
  });

  it("loads and saves SIC exclusion policy with normalization", async () => {
    render(<Settings />);

    expect(await screen.findByText("SIC Exclusion Policy")).toBeInTheDocument();
    const input = await screen.findByPlaceholderText("Examples: 64201, 64202, 64301");

    await waitFor(() => {
      expect(input.value).toBe("62012");
    });

    fireEvent.change(input, { target: { value: "62012, 64 201, invalid, 62012" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SIC Policy" }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, options]) => url === "/api/exclusions" && options?.method === "PUT"
      );
      expect(putCall).toBeTruthy();
    });

    const exclusionsPutCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/exclusions" && options?.method === "PUT"
    );
    expect(exclusionsPutCall).toBeTruthy();
    const payload = JSON.parse(exclusionsPutCall[1].body);
    expect(payload.prohibited_sic_codes).toEqual(["62012", "64201"]);

    await waitFor(() => {
      expect(input.value).toBe("62012, 64201");
    });
  });
});
