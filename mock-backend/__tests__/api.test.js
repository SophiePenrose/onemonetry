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
    it("returns all companies with combined scores", async () => {
      const { status, data } = await fetchJSON("/api/unified-shortlist");
      assert.equal(status, 200);
      assert.ok(data.companies.length > 0);
      assert.equal(data.meta.total, 20);

      const first = data.companies[0];
      assert.ok(first.combined_score > 0);
      assert.ok(first.segment);
      assert.ok(first.propensity_warmth);
      assert.ok(Array.isArray(first.eligible_motions));
      assert.ok(first.eligible_motions.length > 0);
    });

    it("returns companies sorted by combined score descending", async () => {
      const { data } = await fetchJSON("/api/unified-shortlist");
      for (let i = 1; i < data.companies.length; i++) {
        assert.ok(data.companies[i - 1].combined_score >= data.companies[i].combined_score);
      }
    });

    it("assigns sequential ranks", async () => {
      const { data } = await fetchJSON("/api/unified-shortlist");
      data.companies.forEach((c, i) => assert.equal(c.rank, i + 1));
    });
  });

  describe("GET /api/company/:id", () => {
    it("returns company with all motion scores when no motion specified", async () => {
      const { status, data } = await fetchJSON("/api/company/c18");
      assert.equal(status, 200);
      const c = data.company;
      assert.equal(c.name, "Sigma Renewable Energy");
      assert.equal(c.segment, "Enterprise");
      assert.ok(c.combined_score > 0);
      assert.ok(Array.isArray(c.all_motion_scores));
      assert.ok(c.all_motion_scores.length >= 4);
      assert.ok(c.propensity);
      assert.equal(c.propensity.warmth, "hot");
      assert.ok(Array.isArray(c.competitors));
      assert.ok(Array.isArray(c.stakeholders));
      assert.ok(Array.isArray(c.cadence_history));
    });

    it("returns motion-specific detail when product_motion is provided", async () => {
      const { status, data } = await fetchJSON("/api/company/c18?product_motion=FX");
      assert.equal(status, 200);
      assert.ok(data.company.product_fit);
      assert.ok(data.company.score_breakdown);
      assert.ok(data.company.final_score > 0);
    });

    it("returns 404 for unknown company", async () => {
      const { status } = await fetchJSON("/api/company/nonexistent");
      assert.equal(status, 404);
    });

    it("returns 403 for ineligible motion", async () => {
      const { status } = await fetchJSON("/api/company/c2?product_motion=FX");
      assert.equal(status, 403);
    });
  });

  describe("GET /api/dashboard", () => {
    it("returns pipeline, motion summary, and active prospects", async () => {
      const { status, data } = await fetchJSON("/api/dashboard");
      assert.equal(status, 200);
      assert.equal(data.total_companies, 20);
      assert.ok(data.pipeline.new_candidate);
      assert.ok(data.motion_summary.FX);
      assert.ok(Array.isArray(data.active_prospects));
    });
  });

  describe("PATCH /api/company/:id/state", () => {
    it("allows valid transitions", async () => {
      const checkRes = await fetchJSON("/api/company/c20");
      const currentState = checkRes.data.company.workflow_state;
      let targetState, testCompany;
      if (currentState === "new_candidate") {
        targetState = "shortlisted";
        testCompany = "c20";
      } else {
        testCompany = "c19";
        const c19Res = await fetchJSON("/api/company/c19");
        targetState = c19Res.data.company.workflow_state === "new_candidate" ? "shortlisted" : "held_for_review";
      }

      const { status, data } = await fetchJSON(`/api/company/${testCompany}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_state: targetState, note: "Test transition" }),
      });
      assert.equal(status, 200);
      assert.equal(data.new_state, targetState);
      assert.ok(data.history.length >= 1);
    });

    it("rejects invalid transitions from new_candidate to closed_won", async () => {
      const { status, data } = await fetchJSON("/api/company/c14/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_state: "closed_won" }),
      });
      assert.equal(status, 422);
      assert.ok(data.error.includes("Cannot transition"));
    });

    it("returns 400 for invalid state", async () => {
      const { status } = await fetchJSON("/api/company/c14/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_state: "fake_state" }),
      });
      assert.equal(status, 400);
    });
  });
});
