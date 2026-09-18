import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildManualWeConnectExport, normalizeLinkedInProfileUrl, normalizeWeConnectWebhook } from "../we-connect-manual.js";

describe("manual We-Connect handoff", () => {
  it("normalizes profile URLs and excludes prior or ineligible contacts", () => {
    const result = buildManualWeConnectExport({
      previously_exported_urls: ["https://linkedin.com/in/already-sent"],
      contacts: [
        { person_id: "1", full_name: "Ready Person", linkedin_url: "https://www.linkedin.com/in/ready-person/?trk=test", routes: { linkedin: "awaiting_human_approval" } },
        { person_id: "2", full_name: "Already Sent", linkedin_url: "https://linkedin.com/in/already-sent", routes: { linkedin: "awaiting_human_approval" } },
        { person_id: "3", full_name: "Queued Person", linkedin_url: "https://linkedin.com/in/queued-person", routes: { linkedin: "queued_next_week" } },
      ],
    });
    assert.equal(result.summary.ready_to_paste, 1);
    assert.equal(result.url_text, "https://linkedin.com/in/ready-person");
    assert.deepEqual(result.skipped.map((item) => item.reason), ["previously_exported", "not_selected_for_linkedin"]);
    assert.equal(result.send_performed, false);
  });

  it("rejects non-profile and non-LinkedIn URLs", () => {
    assert.equal(normalizeLinkedInProfileUrl("https://example.com/in/person"), null);
    assert.equal(normalizeLinkedInProfileUrl("https://linkedin.com/company/example"), null);
  });

  it("normalizes outbound webhook events and only stops other channels for explicit outcomes", () => {
    const positive = normalizeWeConnectWebhook({ event_id: "evt-1", action: "Contact marked as lead", contact: { linkedin_url: "https://www.linkedin.com/in/jane-doe/" } });
    assert.equal(positive.event_category, "positive_reply");
    assert.equal(positive.stop_other_channels, true);
    assert.equal(positive.linkedin_url, "https://linkedin.com/in/jane-doe");

    const genericReply = normalizeWeConnectWebhook({ action: "Message received", profile_url: "https://linkedin.com/in/jane-doe" });
    assert.equal(genericReply.event_category, "reply_received");
    assert.equal(genericReply.stop_other_channels, false);
  });
});
