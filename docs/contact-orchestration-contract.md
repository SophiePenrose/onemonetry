# Contact Orchestration Contract

## Purpose

Defines the approval-gated path from a qualified company to stakeholder discovery and LinkedIn cadence enrolment.

## Eligibility

- Prospecting floor: **£30m turnover**.
- A company below the floor may remain monitored but must not enter an outreach cadence solely because a signal exists.
- Product fit, suppression and account-ownership checks remain mandatory before contact discovery becomes actionable.

## Source order

1. Apollo people search is the primary discovery source.
2. Apollo selected-person enrichment runs only after explicit approval because it may consume credits.
3. ChatGPT LinkedIn lookup is an interactive fallback for named people missing a reliable LinkedIn URL.
4. Provider results are deduplicated by LinkedIn URL, then business email, then normalized name plus company.
5. Every merged candidate retains `sources[]` and provider payload provenance.

## Apollo guardrails

- `POST /api/contacts/apollo/search` calls Apollo People API Search and must not request email/phone enrichment.
- `POST /api/contacts/apollo/enrich-selected` requires `allow_credit_spend=true`.
- Personal-email reveal, phone reveal and waterfall enrichment default to false.
- DNC and applicable contact restrictions must be checked separately before any phone outreach.

## LinkedIn fallback

- `POST /api/contacts/resolve` returns `linkedin_fallback_requests[]` for named candidates without a LinkedIn URL.
- These are handoff records for the installed ChatGPT LinkedIn connector, not proof that an unattended backend lookup occurred.
- A resolved profile must be returned to the app with its source and confidence before outreach approval.

## We-Connect handoff

- `POST /api/linkedin/we-connect/enrollment-preview` produces the canonical enrolment payload.
- Preview generation never sends a request or enrols a contact.
- `POST /api/linkedin/we-connect/import` sends an explicitly approved, deduplicated batch to We-Connect's documented `POST /api/v1/campaign/contacts` endpoint. The API key remains backend-only and the exact campaign name is required.
- `GET /api/integrations/we-connect/status` reports whether direct import is configured without exposing the key.
- `POST /api/linkedin/we-connect/manual-export` remains a fallback that prepares newline-separated profile URLs for We-Connect's Bulk Add screen and persists a prepared batch.
- `POST /api/linkedin/we-connect/manual-export/:batchId/confirm` is called only after the user confirms the URLs were pasted. Confirmed URLs are excluded from later exports.
- Direct import records successful and failed batches. Both are excluded from automatic resubmission: an uncertain failure is held for manual reconciliation before any retry, preventing duplicates when We-Connect received a request but its response was lost.
- `POST /api/linkedin/we-connect/webhook?token=...` accepts outbound We-Connect activity when `WE_CONNECT_WEBHOOK_SECRET` is configured. Events are idempotent and retain the original payload for later schema reconciliation.
- Generic replies are recorded but do not automatically stop other channels. Only an explicit positive reply/lead, meeting or opt-out produces `stop_other_channels: true`.
- Once the app has a public HTTPS base URL, configure the exact webhook callback in We-Connect using the endpoint above and the secret token from the deployment environment.

## Weekly multichannel capacity plan

- `POST /api/contacts/weekly-plan` turns CRM-approved contacts into a preview-only weekly plan.
- Default LinkedIn capacity is 100 total weekly connection slots: 90 automated and 10 reserved for Sophie's manual, highly personalised outreach.
- The automated target may be lowered at runtime if LinkedIn or We-Connect applies a smaller account-specific limit.
- Ordinary companies may have at most three stakeholders active in the same week. An explicitly marked strategic company may have four.
- Contacts are ranked by supplied priority plus role relevance. Finance and treasury decision-makers lead the default ordering, followed by payments, operations, executive and ecommerce roles.
- A contact can proceed through any usable combination of LinkedIn, work email and permitted phone. Missing one channel does not disqualify the other channels.
- DNC-marked phone numbers never create call tasks. Email, LinkedIn and global suppression flags are applied independently.
- Contacts above the company cap or LinkedIn capacity are returned in `overflow[]` for a later week; they are not discarded.
- Positive replies, meetings, opt-outs and new suppressions are stop conditions for all remaining channels.
- Suppressed contacts, companies without CRM approval and companies below the £30m turnover floor are rejected. A below-floor company requires an explicit audited turnover override.
- When a We-Connect campaign is supplied, selected LinkedIn contacts receive an approval-gated enrolment preview. Sending occurs only through the separate direct-import endpoint with `approved: true`.

### Expected weekly funnel

- Shortlist approximately 35–40 companies for CRM review.
- Approve approximately 30–35 companies.
- Discover approximately 100–120 relevant stakeholders.
- Select up to 90 LinkedIn-ready contacts for automated connection requests.
- Continue email and permitted call routes wherever those channels are available.
- Preserve at least ten weekly LinkedIn slots for manual personalised outreach.

## Pending input

Sophie's Gemini Gem instructions remain pending. They should be reconciled with the v7 prompt and QC rules before sequence-generation logic is changed.
