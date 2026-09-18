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
- The preview status is always `awaiting_human_approval` and includes a campaign/profile dedupe key.
- A later send endpoint must require a persisted approval record, idempotency key and selected campaign ID.
- Webhook reconciliation should record invite sent, accepted, replied, failed and removed events.
- No live send endpoint should be implemented until authenticated We-Connect API schemas and account permissions have been verified.

## Pending input

Sophie's Gemini Gem instructions remain pending. They should be reconciled with the v7 prompt and QC rules before sequence-generation logic is changed.
