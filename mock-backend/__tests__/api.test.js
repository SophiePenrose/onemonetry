import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE = "http://localhost:8000";

async function fetchJSON(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

describe("API endpoints", () => {
  describe("GET /api/motions", () => {
    it("returns all 8 product motions", async () => {
      const { status, data } = await fetchJSON("/api/motions");
      assert.equal(status, 200);
      assert.equal(data.motions.length, 8);
      assert.ok(data.motions.includes("FX"));
      assert.ok(data.motions.includes("Merchant Acquiring"));
    });
  });

  describe("GET /api/workflow-states", () => {
    it("returns 9 workflow states with transitions", async () => {
      const { status, data } = await fetchJSON("/api/workflow-states");
      assert.equal(status, 200);
      assert.equal(data.states.length, 9);
      assert.ok(data.transitions.new_candidate.includes("shortlisted"));
      assert.deepEqual(data.transitions.closed_won, []);
    });
  });

  describe("GET /api/scoring-weights", () => {
    it("returns segment weights and propensity config", async () => {
      const { status, data } = await fetchJSON("/api/scoring-weights");
      assert.equal(status, 200);
      assert.ok(data.segment_weights.SMB);
      assert.ok(data.segment_weights["Mid-Market"]);
      assert.ok(data.segment_weights.Enterprise);
      assert.equal(data.layers.length, 5);
      assert.equal(typeof data.propensity_weight, "number");
    });
  });

  describe("GET /api/exclusions", () => {
    it("returns prohibited industries and suppressed states", async () => {
      const { status, data } = await fetchJSON("/api/exclusions");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.exclusions.prohibited_industries));
      assert.ok(data.exclusions.prohibited_industries.includes("Gambling"));
      assert.ok(Array.isArray(data.suppressed_states));
    });
  });

  describe("GET /api/unified-shortlist", () => {
    it("returns companies array with meta", async () => {
      const { status, data } = await fetchJSON("/api/unified-shortlist");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.companies));
      assert.ok(data.meta);
      assert.equal(typeof data.meta.total, "number");
      assert.equal(typeof data.meta.showing, "number");
    });

    it("returns companies sorted by combined score descending", async () => {
      const { data } = await fetchJSON("/api/unified-shortlist");
      for (let i = 1; i < data.companies.length; i++) {
        const prev = data.companies[i - 1];
        const current = data.companies[i];
        if (prev.composite_score !== null && current.composite_score !== null) {
          assert.ok(prev.composite_score >= current.composite_score);
        } else if (prev.composite_score === null && current.composite_score === null) {
          assert.ok(prev.turnover >= current.turnover);
        } else {
          assert.ok(prev.composite_score !== null);
        }
      }
    });
  });

  describe("GET /api/dashboard", () => {
    it("returns pipeline, turnover distribution, monitor stats, and top companies", async () => {
      const { status, data } = await fetchJSON("/api/dashboard");
      assert.equal(status, 200);
      assert.equal(typeof data.total_companies, "number");
      assert.ok(data.pipeline.new_candidate);
      assert.ok(Object.values(data.turnover_distribution).every((bucket) => typeof bucket.count === "number"));
      assert.ok(data.monitor_stats);
      assert.ok(Array.isArray(data.top_companies));
    });
  });

  describe("GET /api/companies-house/status", () => {
    it("returns configuration status", async () => {
      const { status, data } = await fetchJSON("/api/companies-house/status");
      assert.equal(status, 200);
      assert.equal(typeof data.configured, "boolean");
    });
  });

  describe("GET /api/reports/schedule", () => {
    it("returns Sunday evening schedule", async () => {
      const { status, data } = await fetchJSON("/api/reports/schedule");
      assert.equal(status, 200);
      assert.equal(data.schedule, "Sunday evenings at 20:00");
      assert.ok(data.next_generation);
    });
  });

  describe("GET /api/import/bulk/monthly", () => {
    it("returns monthly ZIP file list from Companies House", async () => {
      const { status, data } = await fetchJSON("/api/import/bulk/monthly");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.files));
      if (data.files.length > 0) {
        assert.ok(data.files[0].filename);
        assert.ok(data.files[0].url);
        assert.ok(data.files[0].period);
      }
    });
  });

  describe("GET /api/import/bulk/daily", () => {
    it("returns daily ZIP file list from Companies House", async () => {
      const { status, data } = await fetchJSON("/api/import/bulk/daily");
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.files));
      if (data.files.length > 0) {
        assert.ok(data.files[0].filename);
        assert.ok(data.files[0].url);
        assert.ok(data.files[0].date);
      }
    });
  });

  describe("POST /api/companies", () => {
    it("creates a new company", async () => {
      const { status, data } = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Corp", industry: "Technology", segment: "Mid-Market", turnover: 25000000 }),
      });
      assert.equal(status, 201);
      assert.equal(data.company.name, "Test Corp");
      assert.equal(data.company.industry, "Technology");
    });

    it("rejects missing required fields", async () => {
      const { status } = await fetchJSON("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnover: 1000000 }),
      });
      assert.equal(status, 400);
    });
  });

  describe("Scoring weights CRUD", () => {
    it("PUT validates weights sum to 1", async () => {
      const { status } = await fetchJSON("/api/scoring-weights", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment_weights: { SMB: { product_fit: 0.5, commercial_value: 0.5, pain_strength: 0.5, urgency: 0.5, competitor_context: 0.5 } } }),
      });
      assert.equal(status, 400);
    });

    it("POST reset restores defaults", async () => {
      const { status, data } = await fetchJSON("/api/scoring-weights/reset", { method: "POST" });
      assert.equal(status, 200);
      assert.ok(data.segment_weights.SMB);
      assert.equal(data.propensity_weight, 0.15);
    });
  });
});
