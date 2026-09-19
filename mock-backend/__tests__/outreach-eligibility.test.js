import { it } from "node:test";
import assert from "node:assert/strict";
import { createOutreachCompanyResolver } from "../outreach-eligibility.js";
it("uses authoritative turnover/fit and preserves exclusions, research holds and customer matches", () => {
  const state = { company_number: "00123456", company_name: "Example", latest_turnover: 50000000, status: "active" };
  let gate = 1, excluded = false, held = false, customer = false;
  const resolve = createOutreachCompanyResolver({ normalizeCompanyNumber: () => "00123456", loadCompanies: () => [], getMonitoredCompany: () => state,
    getStoredScore: () => ({ confidence: { product_fit_gate: gate } }), isExcluded: () => ({ excluded }), isSuppressed: () => ({ suppressed: held }),
    getSetting: () => ({ customer_matches: customer ? [{}] : [] }), getTurnoverThreshold: () => 30000000, getTurnoverMaxThreshold: () => 200000000 });
  assert.equal(resolve("00123456").eligible, true);
  for (const value of [null, 15000000, 250000000]) { state.latest_turnover = value; assert.equal(resolve("00123456").eligible, false); }
  state.latest_turnover = 50000000; gate = 0.8; assert.equal(resolve("00123456").reason, "product_fit_research_required");
  gate = 1; excluded = true; assert.equal(resolve("00123456").eligible, false);
  excluded = false; held = true; assert.equal(resolve("00123456").eligible, false);
  held = false; customer = true; assert.equal(resolve("00123456").eligible, false);
  customer = false; state.status = "research"; assert.equal(resolve("00123456").eligible, false);
});
