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
  let schedulerEnabled;

  beforeEach(() => {
    schedulerEnabled = false;
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

      if (typeof url === "string" && url.startsWith("/api/monitor/ownership/changes")) {
        const search = url.includes("?") ? url.split("?")[1] : "";
        const params = new URLSearchParams(search);
        const sinceDays = Number(params.get("since_days") || "30");
        return jsonResponse({
          total: 1,
          limit: Number(params.get("limit") || "20"),
          offset: Number(params.get("offset") || "0"),
          since_days: sinceDays,
          rows: [
            {
              company_number: "01234567",
              company_name: "Acme Holdings Ltd",
              change_detected: true,
              changed_fields: ["parent_company", "structure"],
              last_changed_at: "2026-06-04T10:00:00.000Z",
              last_checked_at: "2026-06-04T10:15:00.000Z",
              structure: "subsidiary",
              parent_company: "Acme Group plc",
              parent_country: "United Kingdom",
            },
          ],
        });
      }

      if (url === "/api/monitor/ownership/status") {
        return jsonResponse({
          enabled: schedulerEnabled,
          running: false,
          stale_days: 30,
          batch_size: 100,
          check_interval_ms: 3600000,
          schedule: "Daily",
          change_tracking_enabled: true,
          change_fields: ["parent_company", "structure"],
        });
      }

      if (url === "/api/monitor/ownership/scheduler/start" && method === "POST") {
        schedulerEnabled = true;
        return jsonResponse({
          message: "Ownership stale monitor scheduler started",
          enabled: schedulerEnabled,
          running: false,
          stale_days: 30,
          batch_size: 100,
          check_interval_ms: 3600000,
          schedule: "Daily",
          change_tracking_enabled: true,
          change_fields: ["parent_company", "structure"],
        });
      }

      if (url === "/api/monitor/ownership/scheduler/stop" && method === "POST") {
        schedulerEnabled = false;
        return jsonResponse({
          message: "Ownership stale monitor scheduler stopped",
          enabled: schedulerEnabled,
          running: false,
          stale_days: 30,
          batch_size: 100,
          check_interval_ms: 3600000,
          schedule: "Daily",
          change_tracking_enabled: true,
          change_fields: ["parent_company", "structure"],
        });
      }

      if (url === "/api/monitor/ownership/run" && method === "POST") {
        const payload = JSON.parse(options?.body || "{}");
        const batchSize = Number(payload?.batch_size || 100);
        return jsonResponse({
          message: `Starting ownership stale refresh for up to ${batchSize} companies`,
          batch_size: batchSize,
        }, true, 202);
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

  it("renders ownership change feed and refreshes when window changes", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Acme Holdings Ltd")).toBeInTheDocument();
      expect(screen.getByText("Parent Company, Structure")).toBeInTheDocument();
      expect(screen.getByText("Showing 1/1 changed companies in last 30 days")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership change window" }), {
      target: { value: "90" },
    });

    await waitFor(() => {
      const sawWindowRequest = fetchMock.mock.calls.some(([url]) => {
        const href = String(url || "");
        return href.startsWith("/api/monitor/ownership/changes") && href.includes("since_days=90");
      });
      expect(sawWindowRequest).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByText("Showing 1/1 changed companies in last 90 days")).toBeInTheDocument();
    });
  });

  it("shows ownership monitor status and starts a manual run", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Daily")).toBeInTheDocument();
      expect(screen.getByText("1 hr")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Ownership batch size" }), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run Ownership Refresh" }));

    await waitFor(() => {
      expect(screen.getByText("Starting ownership stale refresh for up to 42 companies")).toBeInTheDocument();
    });

    const runCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/monitor/ownership/run" && options?.method === "POST"
    );
    expect(runCall).toBeTruthy();
    expect(JSON.parse(runCall[1].body)).toEqual({ batch_size: 42 });
  });

  it("starts and stops ownership scheduler", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    const startButton = await screen.findByRole("button", { name: "Start Scheduler" });
    const stopButton = await screen.findByRole("button", { name: "Stop Scheduler" });
    expect(startButton).toBeEnabled();
    expect(stopButton).toBeDisabled();

    fireEvent.click(startButton);

    await waitFor(() => {
      expect(screen.getByText("Ownership stale monitor scheduler started")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop Scheduler" })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop Scheduler" }));

    await waitFor(() => {
      expect(screen.getByText("Ownership stale monitor scheduler stopped")).toBeInTheDocument();
    });

    const startCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/monitor/ownership/scheduler/start" && options?.method === "POST"
    );
    const stopCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/monitor/ownership/scheduler/stop" && options?.method === "POST"
    );
    expect(startCall).toBeTruthy();
    expect(stopCall).toBeTruthy();
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
