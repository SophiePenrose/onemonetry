import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWeConnectApiImport, createWeConnectApiClient } from "../we-connect-api.js";

describe("We-Connect API import", () => {
  it("maps approved contacts to the documented campaign import payload", () => {
    const result = buildWeConnectApiImport({
      contacts: [{
        person_id: "person-1",
        full_name: "Jane Alex Doe",
        email: "jane@example.com",
        linkedin_url: "https://www.linkedin.com/in/jane-doe/?trk=test",
        routes: { linkedin: "awaiting_human_approval" },
      }],
    });
    assert.equal(result.summary.ready_to_import, 1);
    assert.deepEqual(result.contacts[0], {
      first_name: "Jane",
      middle_name: "Alex",
      last_name: "Doe",
      linkedin: "https://linkedin.com/in/jane-doe",
      email: "jane@example.com",
      custom_fields: {},
    });
  });

  it("sends the key only from the backend and uses the campaign name", async () => {
    let request;
    const client = createWeConnectApiClient({
      env: { WE_CONNECT_API_KEY: "server-secret", WE_CONNECT_API_BASE_URL: "https://api.example.test" },
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ success: "Contacts imported" }), { status: 200 });
      },
    });
    const result = await client.importContacts({
      campaignName: "Weekly Finance Leaders",
      contacts: [{ linkedin: "https://linkedin.com/in/jane-doe", first_name: "Jane", middle_name: "", last_name: "Doe", email: "", custom_fields: {} }],
    });
    assert.equal(result.success, true);
    assert.equal(request.url, "https://api.example.test/api/v1/campaign/contacts");
    assert.equal(request.body.api_key, "server-secret");
    assert.equal(request.body.name, "Weekly Finance Leaders");
    assert.equal(request.options.headers.Authorization, undefined);
  });

  it("fails closed when the backend key is missing", async () => {
    const client = createWeConnectApiClient({ env: {}, fetchImpl: () => assert.fail("fetch should not run") });
    await assert.rejects(
      () => client.importContacts({ campaignName: "Campaign", contacts: [{}] }),
      { code: "we_connect_not_configured" }
    );
  });
});
