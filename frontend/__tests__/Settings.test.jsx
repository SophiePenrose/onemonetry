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

const OWNERSHIP_TRIAGE_STORAGE_KEY = "settings.ownershipTriage.v1";

describe("Settings", () => {
  let fetchMock;
  let schedulerEnabled;
  let ownershipMonitorRunning;
  let targetedSyncResponse;

  beforeEach(() => {
    globalThis.localStorage?.clear();
    window.history.replaceState({}, "", "/");
    schedulerEnabled = false;
    ownershipMonitorRunning = false;
    targetedSyncResponse = null;
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
            prospeo: {
              configured: true,
              required: false,
              purpose: "Contact and company intelligence",
              env_var: "PROSPEO_URL_TEMPLATE (+ optional PROSPEO_API_KEY)",
            },
            builtwith: { configured: false, required: false, purpose: "Tech stack", env_var: "BUILTWITH_KEY" },
          },
          ready_for_production: true,
          missing_required: [],
          env_template: ["PROSPEO_URL_TEMPLATE=", "BUILTWITH_KEY="],
        });
      }

      if (typeof url === "string" && url.startsWith("/api/signals/sync/") && method === "POST") {
        if (targetedSyncResponse && typeof targetedSyncResponse === "object") {
          return jsonResponse(targetedSyncResponse.body || {}, targetedSyncResponse.ok === true, targetedSyncResponse.status || 500);
        }

        const companyNumber = String(url.split("/").pop() || "").trim();
        return jsonResponse({
          status: "updated",
          updated: true,
          company_number: companyNumber,
          attempted: 1,
          succeeded: 1,
          failed: 0,
          requested_connectors: ["prospeo"],
          connectors: [{ id: "prospeo", ok: true }],
        });
      }

      if (typeof url === "string" && url.startsWith("/api/signals/sync/") && method === "POST") {
        if (endoleSyncResponse && typeof endoleSyncResponse === "object") {
          return jsonResponse(endoleSyncResponse.body || {}, endoleSyncResponse.ok === true, endoleSyncResponse.status || 500);
        }

        const companyNumber = String(url.split("/").pop() || "").trim();
        return jsonResponse({
          status: "updated",
          updated: true,
          company_number: companyNumber,
          attempted: 1,
          succeeded: 1,
          failed: 0,
          requested_connectors: ["endole"],
          connectors: [{ id: "endole", ok: true }],
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

  it("runs targeted connector sync using Prospeo connector scope", async () => {
    render(<Settings />);

    expect(await screen.findByText("Scoring Settings")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/1\/2 configured/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Targeted sync company number" }), {
      target: { value: "ch-6" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run Prospeo Sync" }));

    await waitFor(() => {
      expect(screen.getByText("Prospeo sync completed for 00000006 (1/1 connectors succeeded).")).toBeInTheDocument();
    });

    const syncCall = fetchMock.mock.calls.find(
      ([url, options]) => String(url || "").startsWith("/api/signals/sync/00000006") && options?.method === "POST"
    );
    expect(syncCall).toBeTruthy();
    expect(JSON.parse(syncCall[1].body)).toEqual({ connectors: ["prospeo"] });
  });

  it("shows validation message for invalid targeted sync company number", async () => {
    render(<Settings />);

    expect(await screen.findByText("Scoring Settings")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/1\/2 configured/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Targeted sync company number" }), {
      target: { value: "!!!" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run Prospeo Sync" }));

    await waitFor(() => {
      expect(screen.getByText("Enter a valid company number.")).toBeInTheDocument();
    });

    const syncCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url || "").startsWith("/api/signals/sync/")
    );
    expect(syncCalls).toHaveLength(0);
  });

  it("shows backend error when targeted Prospeo sync fails", async () => {
    targetedSyncResponse = {
      status: 502,
      ok: false,
      body: { error: "Prospeo sync upstream failed" },
    };

    render(<Settings />);

    expect(await screen.findByText("Scoring Settings")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/1\/2 configured/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Targeted sync company number" }), {
      target: { value: "00000006" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run Prospeo Sync" }));

    await waitFor(() => {
      expect(screen.getByText("Prospeo sync upstream failed")).toBeInTheDocument();
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

  it("restores ownership triage preferences from localStorage on load", async () => {
    globalThis.localStorage?.setItem(OWNERSHIP_TRIAGE_STORAGE_KEY, JSON.stringify({
      preset: "cross_border_priority",
      since_days: 90,
      sort: "impact",
      min_changed_fields: "all",
      parent_country_scope: "non_uk",
      changed_field: "all",
      impact: "all",
    }));

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Ownership triage preset" })).toHaveValue("cross_border_priority");
    });

    const sawRestoredRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes")
        && href.includes("since_days=90")
        && href.includes("sort=impact")
        && href.includes("parent_country_scope=non_uk");
    });
    expect(sawRestoredRequest).toBe(true);
  });

  it("restores ownership triage preferences from URL query when present", async () => {
    globalThis.localStorage?.setItem(OWNERSHIP_TRIAGE_STORAGE_KEY, JSON.stringify({
      preset: "cross_border_priority",
      since_days: 90,
      sort: "impact",
      min_changed_fields: "all",
      parent_country_scope: "non_uk",
      changed_field: "all",
      impact: "all",
    }));

    window.history.replaceState({}, "", "/settings?ownership_since_days=180&ownership_sort=recent&ownership_parent_country_scope=uk&ownership_changed_field=confidence&ownership_impact=standard");

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Ownership change window" })).toHaveValue("180");
      expect(screen.getByRole("combobox", { name: "Ownership change sort mode" })).toHaveValue("recent");
      expect(screen.getByRole("combobox", { name: "Ownership parent country filter" })).toHaveValue("uk");
      expect(screen.getByRole("combobox", { name: "Ownership changed field filter" })).toHaveValue("confidence");
      expect(screen.getByRole("combobox", { name: "Ownership impact filter" })).toHaveValue("standard");
    });

    const sawQueryRestoredRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes")
        && href.includes("since_days=180")
        && href.includes("parent_country_scope=uk")
        && href.includes("changed_field=confidence")
        && href.includes("impact=standard")
        && !href.includes("sort=impact");
    });
    expect(sawQueryRestoredRequest).toBe(true);
  });

  it("persists ownership triage preferences after preset and manual updates", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership triage preset" }), {
      target: { value: "high_impact_multi_signal" },
    });

    await waitFor(() => {
      const saved = JSON.parse(globalThis.localStorage?.getItem(OWNERSHIP_TRIAGE_STORAGE_KEY) || "{}");
      expect(saved.preset).toBe("high_impact_multi_signal");
      expect(saved.sort).toBe("impact");
      expect(saved.min_changed_fields).toBe("2");
      expect(saved.impact).toBe("high");
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership impact filter" }), {
      target: { value: "standard" },
    });

    await waitFor(() => {
      const saved = JSON.parse(globalThis.localStorage?.getItem(OWNERSHIP_TRIAGE_STORAGE_KEY) || "{}");
      expect(saved.preset).toBe("custom");
      expect(saved.impact).toBe("standard");
    });
  });

  it("syncs ownership triage selections to URL query params", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership change sort mode" }), {
      target: { value: "impact" },
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership parent country filter" }), {
      target: { value: "non_uk" },
    });

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("ownership_sort")).toBe("impact");
      expect(params.get("ownership_parent_country_scope")).toBe("non_uk");
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership change sort mode" }), {
      target: { value: "recent" },
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership parent country filter" }), {
      target: { value: "all" },
    });

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("ownership_sort")).toBeNull();
      expect(params.get("ownership_parent_country_scope")).toBeNull();
    });
  });

  it("copies the current ownership triage URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership change sort mode" }), {
      target: { value: "impact" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Ownership parent country filter" }), {
      target: { value: "non_uk" },
    });

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("ownership_sort")).toBe("impact");
      expect(params.get("ownership_parent_country_scope")).toBe("non_uk");
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy ownership triage link" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      const copiedUrl = String(writeText.mock.calls[0]?.[0] || "");
      expect(copiedUrl).toContain("ownership_sort=impact");
      expect(copiedUrl).toContain("ownership_parent_country_scope=non_uk");
      expect(screen.getByRole("button", { name: "Copy ownership triage link" })).toHaveTextContent("Copied Link");
    });
  });

  it("copies ownership triage query parameters only", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ownership change sort mode" }), {
      target: { value: "impact" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy ownership triage query only" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      const copiedQuery = String(writeText.mock.calls[0]?.[0] || "");
      expect(copiedQuery.startsWith("?")).toBe(true);
      expect(copiedQuery).toContain("ownership_sort=impact");
      expect(copiedQuery).toContain("ownership_since_days=30");
      expect(copiedQuery).not.toContain("http");
      expect(screen.getByRole("button", { name: "Copy ownership triage query only" })).toHaveTextContent("Copied Query");
    });
  });

  it("applies a pasted ownership triage shared query", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Ownership triage shared query input" }), {
      target: {
        value: "?ownership_since_days=90&ownership_sort=impact&ownership_min_changed_fields=2&ownership_parent_country_scope=non_uk&ownership_changed_field=parent_company&ownership_impact=high",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply ownership triage shared query" }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Ownership triage preset" })).toHaveValue("custom");
      expect(screen.getByRole("combobox", { name: "Ownership change window" })).toHaveValue("90");
      expect(screen.getByRole("combobox", { name: "Ownership change sort mode" })).toHaveValue("impact");
      expect(screen.getByRole("combobox", { name: "Ownership signal density filter" })).toHaveValue("2");
      expect(screen.getByRole("combobox", { name: "Ownership parent country filter" })).toHaveValue("non_uk");
      expect(screen.getByRole("combobox", { name: "Ownership changed field filter" })).toHaveValue("parent_company");
      expect(screen.getByRole("combobox", { name: "Ownership impact filter" })).toHaveValue("high");
      expect(screen.getByText("Applied shared triage query.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Ownership triage shared query input" })).toHaveValue("");
    });

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("ownership_since_days")).toBe("90");
      expect(params.get("ownership_sort")).toBe("impact");
      expect(params.get("ownership_min_changed_fields")).toBe("2");
      expect(params.get("ownership_parent_country_scope")).toBe("non_uk");
      expect(params.get("ownership_changed_field")).toBe("parent_company");
      expect(params.get("ownership_impact")).toBe("high");
    });

    const sawSharedQueryRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes")
        && href.includes("since_days=90")
        && href.includes("sort=impact")
        && href.includes("min_changed_fields=2")
        && href.includes("parent_country_scope=non_uk")
        && href.includes("changed_field=parent_company")
        && href.includes("impact=high");
    });
    expect(sawSharedQueryRequest).toBe(true);
  });

  it("pastes and applies ownership triage shared query from clipboard", async () => {
    const readText = vi.fn().mockResolvedValue("?ownership_since_days=180&ownership_sort=impact&ownership_impact=high");
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Paste and apply ownership triage shared query" }));

    await waitFor(() => {
      expect(readText).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("combobox", { name: "Ownership change window" })).toHaveValue("180");
      expect(screen.getByRole("combobox", { name: "Ownership change sort mode" })).toHaveValue("impact");
      expect(screen.getByRole("combobox", { name: "Ownership impact filter" })).toHaveValue("high");
      expect(screen.getByText("Applied shared triage query.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Ownership triage shared query input" })).toHaveValue("");
    });
  });

  it("shows clipboard-unavailable error when paste-and-apply is not supported", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Paste and apply ownership triage shared query" }));

    await waitFor(() => {
      expect(screen.getByText("Clipboard paste unavailable.")).toBeInTheDocument();
    });
  });

  it("shows an error when shared query input has no ownership params", async () => {
    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Ownership triage shared query input" }), {
      target: { value: "foo=bar&region=uk" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply ownership triage shared query" }));

    await waitFor(() => {
      expect(screen.getByText("No ownership triage parameters found.")).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Ownership change window" })).toHaveValue("30");
      expect(screen.getByRole("textbox", { name: "Ownership triage shared query input" })).toHaveValue("foo=bar&region=uk");
    });
  });

  it("shows copy failure feedback when triage URL copy fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard blocked"));
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    const expectedFallbackUrl = window.location.href;

    fireEvent.click(screen.getByRole("button", { name: "Copy ownership triage link" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Copy ownership triage link" })).toHaveTextContent("Copy Failed");
      expect(screen.getByLabelText("Ownership triage copy fallback")).toHaveValue(expectedFallbackUrl);
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss ownership triage copy fallback" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Ownership triage copy fallback")).not.toBeInTheDocument();
    });
  });

  it("clears saved ownership triage preferences and resets controls", async () => {
    globalThis.localStorage?.setItem(OWNERSHIP_TRIAGE_STORAGE_KEY, JSON.stringify({
      preset: "cross_border_priority",
      since_days: 90,
      sort: "impact",
      min_changed_fields: "all",
      parent_country_scope: "non_uk",
      changed_field: "all",
      impact: "all",
    }));

    render(<Settings />);

    expect(await screen.findByText("Ownership Change Feed")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Ownership triage preset" })).toHaveValue("cross_border_priority");
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset saved triage preferences" }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Ownership triage preset" })).toHaveValue("custom");
      expect(screen.getByRole("combobox", { name: "Ownership change window" })).toHaveValue("30");
      expect(screen.getByRole("combobox", { name: "Ownership change sort mode" })).toHaveValue("recent");
      expect(screen.getByRole("combobox", { name: "Ownership signal density filter" })).toHaveValue("all");
      expect(screen.getByRole("combobox", { name: "Ownership parent country filter" })).toHaveValue("all");
      expect(screen.getByRole("combobox", { name: "Ownership changed field filter" })).toHaveValue("all");
      expect(screen.getByRole("combobox", { name: "Ownership impact filter" })).toHaveValue("all");
      expect(globalThis.localStorage?.getItem(OWNERSHIP_TRIAGE_STORAGE_KEY)).toBeNull();
      expect(window.location.search).toBe("");
    });

    const sawResetDefaultsRequest = fetchMock.mock.calls.some(([url]) => {
      const href = String(url || "");
      return href.startsWith("/api/monitor/ownership/changes")
        && href.includes("since_days=30")
        && !href.includes("sort=impact")
        && !href.includes("parent_country_scope=non_uk");
    });
    expect(sawResetDefaultsRequest).toBe(true);
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
