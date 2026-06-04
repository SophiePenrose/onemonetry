import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  let ownershipMonitorRunning;

  beforeEach(() => {
    schedulerEnabled = false;
    ownershipMonitorRunning = false;
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
        const offset = Number(params.get("offset") || "0");
        const sort = String(params.get("sort") || "recent").trim().toLowerCase();
        const minChangedFields = Number(params.get("min_changed_fields") || "0");
        const parentCountryScope = String(params.get("parent_country_scope") || "all").trim().toLowerCase();
        const changedField = String(params.get("changed_field") || "").trim();
        const impact = String(params.get("impact") || "").trim().toLowerCase();

        const resolveParentCountryScope = (value) => {
          const normalized = String(value || "").trim().toLowerCase();
          if (!normalized) return "unknown";
          if (["uk", "gb", "gbr", "united kingdom", "great britain"].includes(normalized)) return "uk";
          return "non_uk";
        };

        const allRows = [
          {
            company_number: "01234567",
            company_name: "Acme Holdings Ltd",
            change_detected: true,
            changed_fields: ["parent_company", "structure"],
            changed_fields_count: 2,
            impact_level: "high",
            last_changed_at: "2026-06-04T10:00:00.000Z",
            last_checked_at: "2026-06-04T10:15:00.000Z",
            structure: "subsidiary",
            parent_company: "Acme Group plc",
            parent_country: "United Kingdom",
          },
          {
            company_number: "76543210",
            company_name: "Beta Payments Ltd",
            change_detected: true,
            changed_fields: ["confidence"],
            changed_fields_count: 1,
            impact_level: "standard",
            last_changed_at: "2026-06-04T09:45:00.000Z",
            last_checked_at: "2026-06-04T10:10:00.000Z",
            structure: "independent",
            parent_company: "Beta Global Inc",
            parent_country: "United States",
          },
        ];
        const filteredRows = allRows.filter((row) => {
          if (Number.isFinite(minChangedFields) && minChangedFields > 0) {
            const changedFieldsCount = Number(row.changed_fields_count || 0);
            if (changedFieldsCount < minChangedFields) {
              return false;
            }
          }
          if (parentCountryScope !== "all" && resolveParentCountryScope(row.parent_country) !== parentCountryScope) {
            return false;
          }
          if (changedField && (!Array.isArray(row.changed_fields) || !row.changed_fields.includes(changedField))) {
            return false;
          }
          if (impact && impact !== "all" && row.impact_level !== impact) {
            return false;
          }
          return true;
        });
        const rows = filteredRows.slice(offset, offset + 1);

        return jsonResponse({
          total: filteredRows.length,
          limit: Number(params.get("limit") || "20"),
          offset,
          since_days: sinceDays,
          sort,
          min_changed_fields: Number.isFinite(minChangedFields) ? minChangedFields : 0,
          changed_fields_filter: changedField ? [changedField] : [],
          changed_fields_counts: {
            parent_company: 1,
            structure: 1,
            confidence: 1,
          },
          changed_fields_count_buckets: {
            "0": 0,
            "1": 1,
            "2": 1,
            "3_plus": 0,
          },
          parent_country_scope_filter: parentCountryScope,
          parent_country_scope_counts: {
            uk: 1,
            non_uk: 1,
            unknown: 0,
          },
          impact_filter: impact || "all",
          impact_counts: {
            high: 1,
            standard: 1,
          },
          rows: rows.map((row) => ({
            ...row,
            parent_country_scope: resolveParentCountryScope(row.parent_country),
          })),
        });
      }

      if (url === "/api/monitor/ownership/status") {
        return jsonResponse({
          enabled: schedulerEnabled,
          running: ownershipMonitorRunning,
          last_run: "2026-06-04T09:30:00.000Z",
          next_run: "2026-06-04T10:30:00.000Z",
          stale_days: 30,
          batch_size: 100,
          check_interval_ms: 3600000,
          schedule: "Daily",
          change_tracking_enabled: true,
          change_fields: ["parent_company", "structure"],
          progress: {
            total: 40,
            checked: 12,
            refreshed: 10,
            changed: 4,
            errors: 1,
          },
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
    vi.useRealTimers();
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
      expect(screen.getByText("Showing 1/2 changed companies in last 30 days")).toBeInTheDocument();
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
      expect(screen.getByText("Showing 1/2 changed companies in last 90 days")).toBeInTheDocument();
    });
  });

  it("loads more ownership change rows with pagination offset", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Showing 1/2 changed companies in last 30 days")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Load More Changes" }));

    await waitFor(() => {
      expect(screen.getByText("Beta Payments Ltd")).toBeInTheDocument();
      expect(screen.getByText("Showing 2/2 changed companies in last 30 days")).toBeInTheDocument();
    });

    const sawOffsetRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes") && href.includes("offset=1");
    });
    expect(sawOffsetRequest).toBe(true);
  });

  it("filters ownership changes by selected changed-field", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Parent Company (1)" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership changed field filter" }), {
      target: { value: "parent_company" },
    });

    await waitFor(() => {
      expect(screen.getByText("Acme Holdings Ltd")).toBeInTheDocument();
      expect(screen.getByText("Showing 1/1 changed companies in last 30 days · field: Parent Company")).toBeInTheDocument();
    });

    const sawFieldRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes") && href.includes("changed_field=parent_company");
    });
    expect(sawFieldRequest).toBe(true);
  });

  it("filters ownership changes by selected impact", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "High impact (1)" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership impact filter" }), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByText("Acme Holdings Ltd")).toBeInTheDocument();
      expect(screen.getByText("Showing 1/1 changed companies in last 30 days · impact: High impact")).toBeInTheDocument();
    });

    const sawImpactRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes") && href.includes("impact=high");
    });
    expect(sawImpactRequest).toBe(true);
  });

  it("requests ownership changes with selected sort mode", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership change sort mode" }), {
      target: { value: "impact" },
    });

    await waitFor(() => {
      expect(screen.getByText("Showing 1/2 changed companies in last 30 days · sort: High impact first")).toBeInTheDocument();
    });

    const sawSortRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes") && href.includes("sort=impact");
    });
    expect(sawSortRequest).toBe(true);
  });

  it("filters ownership changes by selected signal density", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "2+ fields (1)" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership signal density filter" }), {
      target: { value: "2" },
    });

    await waitFor(() => {
      expect(screen.getByText("Acme Holdings Ltd")).toBeInTheDocument();
      expect(screen.getByText("Showing 1/1 changed companies in last 30 days · signals: 2+ fields")).toBeInTheDocument();
    });

    const sawSignalDensityRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes") && href.includes("min_changed_fields=2");
    });
    expect(sawSignalDensityRequest).toBe(true);
  });

  it("filters ownership changes by selected parent country scope", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Non-UK parent (1)" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership parent country filter" }), {
      target: { value: "non_uk" },
    });

    await waitFor(() => {
      expect(screen.getByText("Beta Payments Ltd")).toBeInTheDocument();
      expect(screen.getByText("Showing 1/1 changed companies in last 30 days · parent: Non-UK parent")).toBeInTheDocument();
    });

    const sawParentScopeRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes") && href.includes("parent_country_scope=non_uk");
    });
    expect(sawParentScopeRequest).toBe(true);
  });

  it("applies ownership triage preset and resets to custom on manual filter edits", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership triage preset" }), {
      target: { value: "cross_border_priority" },
    });

    await waitFor(() => {
      expect(screen.getByText("Showing 1/1 changed companies in last 90 days · preset: Cross-border Priority · sort: High impact first · parent: Non-UK parent")).toBeInTheDocument();
    });

    const sawPresetRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes")
        && href.includes("since_days=90")
        && href.includes("sort=impact")
        && href.includes("parent_country_scope=non_uk");
    });
    expect(sawPresetRequest).toBe(true);

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership impact filter" }), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Ownership triage preset" })).toHaveValue("custom");
    });
  });

  it("opens company detail from ownership feed row action", async () => {
    const onNavigateToCompany = vi.fn();
    render(<Settings onNavigateToCompany={onNavigateToCompany} />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Open company Acme Holdings Ltd" }));

    expect(onNavigateToCompany).toHaveBeenCalledWith("ch-01234567");
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

  it("renders ownership progress summary strip", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Latest ownership refresh summary")).toBeInTheDocument();
      expect(screen.getByText("30% complete")).toBeInTheDocument();
      expect(screen.getByText("Checked 12/40")).toBeInTheDocument();
      expect(screen.getByText("Refreshed 10")).toBeInTheDocument();
      expect(screen.getByText("Changed 4")).toBeInTheDocument();
      expect(screen.getByText("Errors 1")).toBeInTheDocument();
    });
  });

  it("auto-refreshes ownership monitor while run is active", async () => {
    ownershipMonitorRunning = true;
    const intervalCallbacks = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
      intervalCallbacks.push(callback);
      return 1;
    });
    render(<Settings />);

    expect(await screen.findByText("Ownership refresh in progress")).toBeInTheDocument();
    expect(screen.getByText("Auto-refreshing every 10 seconds while run is active.")).toBeInTheDocument();

    expect(intervalCallbacks.length).toBeGreaterThan(0);
    await waitFor(() => {
      const hasPollInterval = setIntervalSpy.mock.calls.some(([, intervalMs]) => intervalMs === 10000);
      expect(hasPollInterval).toBe(true);
    });

    const statusCallsBefore = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/monitor/ownership/status"
    ).length;
    const changesCallsBefore = fetchMock.mock.calls.filter(
      ([url]) => String(url || "").startsWith("/api/monitor/ownership/changes")
    ).length;

    const pollCallback = setIntervalSpy.mock.calls.find(([, intervalMs]) => intervalMs === 10000)?.[0];
    expect(typeof pollCallback).toBe("function");
    await act(async () => {
      pollCallback();
    });

    await waitFor(() => {
      const statusCallsAfter = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/monitor/ownership/status"
      ).length;
      const changesCallsAfter = fetchMock.mock.calls.filter(
        ([url]) => String(url || "").startsWith("/api/monitor/ownership/changes")
      ).length;

      expect(statusCallsAfter).toBeGreaterThan(statusCallsBefore);
      expect(changesCallsAfter).toBeGreaterThan(changesCallsBefore);
    });
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
