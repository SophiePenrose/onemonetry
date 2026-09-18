import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseReadModel, getSupabaseReadConfig, isSupabaseReadConfigured } from "../supabase-read-model.js";

function response(rows, { total = null, status = 200 } = {}) {
  return new Response(JSON.stringify(rows), {
    status,
    headers: total === null ? {} : { "content-range": `0-${Math.max(0, rows.length - 1)}/${total}` },
  });
}

describe("Supabase read model", () => {
  it("recognizes backend configuration without exposing key material", () => {
    const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };
    assert.equal(isSupabaseReadConfigured(env), true);
    assert.equal(getSupabaseReadConfig(env).url, env.SUPABASE_URL);
  });

  it("returns an unconfigured status without making a request", async () => {
    const model = createSupabaseReadModel({ env: {}, fetchImpl: () => assert.fail("fetch should not run") });
    assert.deepEqual(await model.getStatus(), { configured: false, connected: false });
  });

  it("lists companies and attaches enrichment job state", async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/companies?")) {
        return response([{ company_number: "01234567", current_name: "Example Ltd" }], { total: 17 });
      }
      return response([{ company_number: "01234567", status: "completed", attempts: 1 }]);
    };
    const model = createSupabaseReadModel({
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
      fetchImpl,
    });
    const result = await model.listCompanies({ limit: "10", offset: "0", enriched: "true" });

    assert.equal(result.meta.total, 17);
    assert.equal(result.companies[0].enrichment.status, "completed");
    assert.match(requests[0].url, /last_enriched_at=not\.is\.null/);
    assert.equal(requests[0].options.headers.apikey, "sb_secret_test");
  });

  it("lists alerts and attaches company identity", async () => {
    const fetchImpl = async (url) => String(url).includes("/prospect_alerts?")
      ? response([{ alert_id: "a1", company_number: "01234567", status: "new" }], { total: 1 })
      : response([{ company_number: "01234567", current_name: "Example Ltd" }]);
    const model = createSupabaseReadModel({
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
      fetchImpl,
    });
    const result = await model.listAlerts({ status: "new" });

    assert.equal(result.alerts[0].company.current_name, "Example Ltd");
    assert.equal(result.meta.total, 1);
  });
});
