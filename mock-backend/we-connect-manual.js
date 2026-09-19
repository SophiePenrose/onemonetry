import { createHash } from "crypto";

export function normalizeLinkedInProfileUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match) return null;
    return `https://linkedin.com/in/${match[1].replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

export function buildManualWeConnectExport(input = {}) {
  const contacts = Array.isArray(input.contacts) ? input.contacts : [];
  const previous = new Set((input.previously_exported_urls || []).map(normalizeLinkedInProfileUrl).filter(Boolean));
  const included = [];
  const skipped = [];
  const seen = new Set();

  contacts.forEach((contact, index) => {
    const linkedinUrl = normalizeLinkedInProfileUrl(contact?.linkedin_url);
    const route = String(contact?.routes?.linkedin || contact?.linkedin_status || "").trim();
    const candidate = {
      contact_key: String(contact?.person_id || contact?.source_id || contact?.id || linkedinUrl || `contact-${index}`),
      full_name: String(contact?.full_name || contact?.name || "Unnamed contact").trim(),
      company_name: String(contact?.company_name || "").trim() || null,
      role: String(contact?.role || contact?.title || "").trim() || null,
      first_name: String(contact?.first_name || "").trim() || null,
      middle_name: String(contact?.middle_name || "").trim() || null,
      last_name: String(contact?.last_name || "").trim() || null,
      email: String(contact?.email || "").trim() || null,
      custom_fields: contact?.custom_fields && typeof contact.custom_fields === "object" ? contact.custom_fields : {},
      linkedin_url: linkedinUrl,
    };

    if (!linkedinUrl) skipped.push({ ...candidate, reason: "linkedin_url_required" });
    else if (route && route !== "awaiting_human_approval") skipped.push({ ...candidate, reason: "not_selected_for_linkedin" });
    else if (previous.has(linkedinUrl)) skipped.push({ ...candidate, reason: "previously_exported" });
    else if (seen.has(linkedinUrl)) skipped.push({ ...candidate, reason: "duplicate_in_batch" });
    else {
      seen.add(linkedinUrl);
      included.push(candidate);
    }
  });

  return {
    status: "prepared",
    send_performed: false,
    format: "we_connect_bulk_add_urls",
    url_text: included.map((contact) => contact.linkedin_url).join("\n"),
    included,
    skipped,
    summary: {
      submitted: contacts.length,
      ready_to_paste: included.length,
      skipped: skipped.length,
      previously_exported: skipped.filter((item) => item.reason === "previously_exported").length,
    },
  };
}

function firstValue(payload, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], payload);
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return null;
}

export function normalizeWeConnectWebhook(payload = {}) {
  const rawType = String(firstValue(payload, ["event_type", "event", "action", "type", "event.name", "data.event"]) || "unknown").trim();
  const token = rawType.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  let eventCategory = "activity";
  let stopOtherChannels = false;
  if (/opt.?out|unsubscribe|do.?not.?contact/.test(token)) {
    eventCategory = "opt_out";
    stopOtherChannels = true;
  } else if (/meeting|booked|appointment/.test(token)) {
    eventCategory = "meeting_booked";
    stopOtherChannels = true;
  } else if (/positive.*reply|reply.*positive|marked.*lead|lead.*marked/.test(token)) {
    eventCategory = "positive_reply";
    stopOtherChannels = true;
  } else if (/reply|message.*received/.test(token)) { eventCategory = "reply_received"; stopOtherChannels = true; }
  else if (/accept|connect/.test(token)) eventCategory = "connection_accepted";
  else if (/sent|invite/.test(token)) eventCategory = "invite_sent";
  else if (/fail|error/.test(token)) eventCategory = "failed";

  const linkedinUrl = normalizeLinkedInProfileUrl(firstValue(payload, [
    "linkedin_url", "profile_url", "contact.linkedin_url", "contact.profile_url", "data.linkedin_url", "data.profile_url",
  ]));
  const externalId = String(firstValue(payload, ["event_id", "id", "data.id"]) || "").trim() || null;
  const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

  return {
    event_key: externalId ? `we-connect:${externalId}` : `we-connect:sha256:${payloadHash}`,
    event_type: rawType,
    event_category: eventCategory,
    linkedin_url: linkedinUrl,
    stop_other_channels: stopOtherChannels,
    received_payload: payload,
  };
}
