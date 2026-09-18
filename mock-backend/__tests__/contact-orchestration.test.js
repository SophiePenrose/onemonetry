import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLinkedInFallbackRequests,
  buildWeConnectEnrollmentPreview,
  createApolloContactSource,
  mergeContactCandidates,
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
});
