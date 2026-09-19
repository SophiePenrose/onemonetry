# Outreach reliability and weekly capacity

Implemented after PR #209, September 2026. GitHub remains the application source; this change does not deploy the running Codespace or modify live prospects.

## Reviewed plans and CRM clearance

The weekly planner saves choices as a draft. Clicking **Confirm CRM clearance and generate plan** explicitly records the single workspace owner's manual CRM check against a dated, persisted plan. This is an attestation, not a CRM integration or an assertion that the app independently queried Salesforce.

`POST /api/contacts/weekly-plan` now requires `crm_confirmed: true`, `week_start` and `draft_revision`. It reads contacts and selected companies from the saved draft; posted contact arrays, scores, approval flags and capacity overrides cannot authorize a handoff. The server rechecks current company identity, turnover (at least £30m and within the configured range), exclusions, workflow holds, customer matches and the existing full product-fit gate. It does not recalculate or alter scores.

Imports and manual exports require the resulting `plan_id`. Direct import additionally requires `approved: true` and an exact campaign name. The server checks current draft selections, CRM clearance, eligibility and contact suppression again before reserving slots. Campaign-name-only edits do not invalidate reviewed people. Company/contact changes and UK week rollover require a fresh plan. Old clients submitting arbitrary contact arrays must refresh to the new frontend.

## Shared weekly reservations

The 90 automated slots are shared across every plan/tab, with ten of the nominal 100 kept for personal outreach. A SQLite immediate transaction reserves contact URLs before the external API call or release of a manual export. Current-week legacy batches are counted too. A manual export occupies slots as soon as its URLs can be obtained, even before the user confirms pasting them.

Weeks start Monday at midnight in Europe/London, with daylight-saving transitions handled explicitly. Capacity resets weekly; duplicate protection also checks past weeks. The limit measures **contacts handed over by this application**, not actual invitations sent by We-Connect on a particular day. Cadence scheduling, external activity and LinkedIn's account-specific limits remain outside this counter.

A repeated successful request returns the same batch rather than dispatching again. Competing plans cannot reserve the same URL or exceed the remaining allowance. Definitive HTTP 4xx refusals (except ambiguous HTTP 408) release slots; timeouts, 5xx responses and uncertain failures retain them. A fresh reviewed plan is required after a definite refusal.

## Uncertain handoffs

The planner shows imports awaiting reconciliation. The owner checks the batch in We-Connect and records a note of at least ten characters plus either **present** or **absent**. Present keeps the slots used; absent releases them. Both outcomes are auditable and neither sends anything. Requests still actively in flight cannot be reconciled; abandoned reservations become reviewable after 15 minutes.

Endpoints: `GET /api/outreach/capacity`, `GET /api/outreach/handoffs/pending`, and `POST /api/outreach/handoffs/:batchId/reconcile` with `{ outcome, note }`. Existing historical failed batches without the new plan record remain conservatively blocked and require separate historical reconciliation; this release does not infer that they were never delivered.

## Reply stops and suppression

We-Connect replies (including unclassified replies), positive replies, meetings and opt-outs establish a durable contact stop. The app uses exact LinkedIn URL/email links captured from reviewed contacts; it never links people by a similar name. Stops exclude contacts from subsequent channel plans, LinkedIn handoffs and ordinary/Gemini YAMM exports where an exact email match is available. Existing explicit stop events are imported into the stop table at startup. Duplicate or later activity callbacks cannot clear a stop.

A stop without a known email association cannot suppress an unidentified email recipient. Previously downloaded spreadsheets, copied URLs and cadences already running outside the app cannot be recalled by these checks. Existing email reply controls remain separate; this change adds We-Connect-to-app stop propagation, not a Gmail connection or a remote cadence cancellation API. Manual URL copying rechecks the batch before reading its current URLs.

Email export lookup/audit failures now return an error rather than falling through to unfiltered rows. Stop removal/resumption requires a future explicit review workflow; resuming an email sequence alone does not clear a contact stop.

## Authentication and testing

Session expiry uses SQLite date comparison rather than lexicographic comparison between ISO and timezone-free strings. Expired and malformed sessions fail validation and are cleaned up.

All new routes inherit app authentication, reject cross-site/non-JSON mutations and return noncached responses. Production still requires configured owner authentication. A development-mode attestation is identified as a local-development owner, not a named authenticated reviewer.

Backend `npm test` / `npm run test:ci` preload a local-only fetch guard, inherited by child test servers. Provider adapters use mocked responses; incidental news lookups are rejected before network access and local redirects cannot escape to external hosts. This addresses the automatic-review rejection of an earlier broad API test run. Current validation: 272 backend tests, 95 frontend tests and the production build passed. Focused checks cover stale selections, suppressed contacts, capacity races, retries, week/DST boundaries, owner reconciliation and same-day session expiry. No live prospects were enrolled by these tests.
