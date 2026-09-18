import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLinkedInFallbackRequests,
  buildWeConnectEnrollmentPreview,
  createApolloContactSource,
  mergeContactCandidates,
  planWeeklyOutreach,
} from "../contact-orchestration.js";

describe("contact orchestration", () => {
  it("searches Apollo without requesting credit-consuming enrichment", async () => {
    let captured;
    const source = createApolloContactSource({
      env: { APOLLO_API_KEY: "test_key" },
      fetchImpl: async (url, options) => {
        captured = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          people: [{ id: "p1", first_name: "Jane", last_name: "Doe", title: "Finance Director", linkedin_url: "https://linkedin.com/in/jane-doe" }],
          pagination: { total_entries: 1 },
        }), { status: 200 });
      },
    });
    const result = await source.searchPeople({ companyDomain: "https://www.example.com" });
    assert.match(captured.url, /mixed_people\/api_search$/);
    assert.deepEqual(captured.body.q_organization_domains_list, ["example.com"]);
    assert.equal(captured.body.reveal_phone_number, undefined);
    assert.equal(result.credit_policy.search_credits, 0);
    assert.equal(result.candidates[0].source, "apollo");
  });

  it("requires explicit credit approval before selected-person enrichment", async () => {
    const source = createApolloContactSource({ env: { APOLLO_API_KEY: "test_key" }, fetchImpl: () => assert.fail("fetch should not run") });
    await assert.rejects(() => source.enrichSelectedPerson({ apollo_person_id: "p1" }), { code: "apollo_credit_approval_required" });
  });

  it("deduplicates Apollo and LinkedIn candidates while preserving provenance", () => {
    const candidates = mergeContactCandidates([
      { source: "apollo", candidates: [{ id: "p1", name: "Jane Doe", title: "Finance Director", linkedin_url: "https://linkedin.com/in/jane-doe" }] },
      { source: "linkedin", candidates: [{ id: "li1", name: "Jane Doe", title: "Finance Director", linkedin_url: "https://www.linkedin.com/in/jane-doe/" }] },
    ]);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].sources, ["apollo", "linkedin"]);
  });

  it("creates LinkedIn fallback requests only for unresolved profiles", () => {
    const requests = buildLinkedInFallbackRequests([
      { full_name: "Jane Doe", company_name: "Example Ltd", role: "Finance Director", linkedin_url: null },
      { full_name: "Alex Roe", linkedin_url: "https://linkedin.com/in/alex-roe" },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].first_name, "Jane");
  });

  it("builds a non-sending We-Connect preview with an approval gate", () => {
    const preview = buildWeConnectEnrollmentPreview({ campaign_id: "campaign_1", linkedin_url: "https://linkedin.com/in/jane-doe", full_name: "Jane Doe" });
    assert.equal(preview.status, "awaiting_human_approval");
    assert.equal(preview.safeguards.send_performed, false);
  });

  it("plans a 90-contact LinkedIn week while preserving ten manual slots", () => {
    const contacts = Array.from({ length: 110 }, (_, index) => ({
      id: `p${index + 1}`,
      full_name: `Person ${index + 1}`,
      role: index % 2 === 0 ? "Finance Director" : "Head of Treasury",
      company_name: `Company ${Math.floor(index / 3) + 1}`,
      company_number: String(10000000 + Math.floor(index / 3)),
      company_turnover_gbp: 50000000,
      crm_approved: true,
      linkedin_url: `https://linkedin.com/in/person-${index + 1}`,
      email: `person${index + 1}@example.com`,
    }));

    const plan = planWeeklyOutreach({ contacts, we_connect_campaign_id: "campaign_1" });

    assert.equal(plan.policy.linkedin_automated_target, 90);
    assert.equal(plan.summary.linkedin_automated_selected, 90);
    assert.equal(plan.summary.linkedin_manual_slots_reserved, 10);
    assert.equal(plan.assignments.filter((item) => item.we_connect_preview).length, 90);
    assert.equal(plan.safeguards.send_performed, false);
  });

  it("limits ordinary companies to three active stakeholders and queues overflow", () => {
    const contacts = Array.from({ length: 5 }, (_, index) => ({
      id: `same-company-${index}`,
      full_name: `Stakeholder ${index}`,
      role: index === 0 ? "Chief Financial Officer" : "Finance Director",
      company_name: "Example Ltd",
      company_number: "01234567",
      company_turnover_gbp: 40000000,
      approval_status: "approved",
      linkedin_url: `https://linkedin.com/in/stakeholder-${index}`,
    }));

    const plan = planWeeklyOutreach({ contacts });

    assert.equal(plan.assignments.length, 3);
    assert.equal(plan.overflow.filter((item) => item.reason === "company_contact_cap").length, 2);
    assert.equal(plan.assignments[0].role, "Chief Financial Officer");
  });

  it("routes each approved contact through only usable permitted channels", () => {
    const plan = planWeeklyOutreach({
      contacts: [
        {
          id: "all-three",
          full_name: "Jane Doe",
          role: "Finance Director",
          company_name: "Example Ltd",
          company_turnover_gbp: 35000000,
          crm_approved: true,
          linkedin_url: "https://linkedin.com/in/jane-doe",
          email: "jane@example.com",
          phone: "+44 7700 900123",
        },
        {
          id: "dnc",
          full_name: "Alex Roe",
          role: "Head of Finance",
          company_name: "Other Ltd",
          company_turnover_gbp: 45000000,
          crm_approved: true,
          email: "alex@example.com",
          phone: "+44 7700 900124",
          phone_dnc: true,
        },
      ],
    });

    const jane = plan.assignments.find((item) => item.full_name === "Jane Doe");
    const alex = plan.assignments.find((item) => item.full_name === "Alex Roe");
    assert.deepEqual(jane.routes, { linkedin: "awaiting_human_approval", email: "ready", phone: "call_task_ready" });
    assert.deepEqual(alex.routes, { linkedin: "unavailable", email: "ready", phone: "unavailable" });
    assert.equal(plan.summary.phone_tasks_ready, 1);
  });

  it("rejects unapproved, suppressed, and below-floor contacts", () => {
    const base = { full_name: "Test Person", role: "CFO", email: "test@example.com" };
    const plan = planWeeklyOutreach({ contacts: [
      { ...base, id: "unapproved", company_name: "One Ltd", company_turnover_gbp: 50000000 },
      { ...base, id: "suppressed", company_name: "Two Ltd", company_turnover_gbp: 50000000, crm_approved: true, suppressed: true },
      { ...base, id: "small", company_name: "Three Ltd", company_turnover_gbp: 29999999, crm_approved: true },
    ] });

    assert.equal(plan.assignments.length, 0);
    assert.deepEqual(plan.rejected.map((item) => item.reason).sort(), ["below_turnover_floor", "crm_approval_required", "suppressed"]);
  });
});
