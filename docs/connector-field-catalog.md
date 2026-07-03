# Connector Field Catalog (Prospeo + PhantomBuster)

## Purpose

This catalog lists high-value connector fields we can use for:

- selecting and validating relevant individuals
- improving recipient quality in YAMM/CSV exports
- improving personalization signals for sequence generation

It complements [docs/signal-connectors-contract.md](docs/signal-connectors-contract.md) by focusing on practical outreach fields, not just envelope shape.

## Current Export Target (YAMM / CSV)

The Gemini YAMM export now supports person-focused columns in addition to core send columns:

- `To`
- `FirstName`
- `Stakeholder`
- `StakeholderFullName`
- `StakeholderRole`
- `StakeholderEmailStatus`
- `StakeholderConfidence`
- `StakeholderPersonaBucket`
- `PersonId`
- `RelevantIndividuals`
- `RelevantIndividualsJSON`

These fields are intended to create a clear place for "relevant individuals" data before/after approval.
Recent-hire metadata is preserved inside `RelevantIndividualsJSON` when available.

## Prospeo

### Endpoint and auth

- Company endpoint: `POST https://api.prospeo.io/bulk-enrich-company`
- People endpoint: `POST https://api.prospeo.io/search-person`
- Headers:
  - `Content-Type: application/json`
  - `X-KEY: <api_key>`

When `PROSPEO_URL_TEMPLATE=https://api.prospeo.io/bulk-enrich-company`, the backend calls both official endpoints and merges the payloads before envelope parsing.

### Request fields (high-confidence)

Each row in `data[]` should include:

- `identifier` (required)
- `company_website` (recommended)
- `company_linkedin_url` (recommended when available)

Notes:

- Sending only `company_website`/`company_domain` without `identifier` leads to `400 Field required`.
- `company_website` works best as a host/domain string (e.g. `intercom.com`) in this flow.

### Useful response fields (observed live)

Company profile and fit:

- `company.name`
- `company.domain`
- `company.industry`
- `company.description`
- `company.employee_count`
- `company.employee_range`
- `company.revenue_range` / `company.revenue_range_printed`
- `company.location.*`
- `company.keywords[]`

Relevant-individual and persona signals:

- `company.job_postings.active_count`
- `company.job_postings.active_titles[]`
- `data.results[].person.first_name` / `last_name` / `full_name`
- `data.results[].person.job_title`
- `data.results[].person.linkedin_url`
- `data.results[].person.email.email`
- `data.results[].person.email.status` / `revealed`
- current-role/job-change dates such as `data.results[].person.current_position.start_date`, `job_start_date`, or `job_change.date`
- new-hire flags such as `recent_hire`, `new_hire`, or `job_change`

Scoring note:

- Recent desired-role hires, including Head/Director of Ecommerce, are normalized into `hiring_signals_<company>.new_senior_hires[]` and used as a bounded timing/motion boost. This reorders otherwise qualified accounts; it does not override the product-fit gate.

Tech and stack context:

- `company.technology.count`
- `company.technology.technology_names[]`
- `company.technology.technology_list[].name`
- `company.technology.technology_list[].category`

Commercial/change context:

- `company.funding.*`
- `company.attributes.*` (for example B2B, free trial, pricing availability)
- `company_intent.topic_ids[]` using the selected Prospeo/Bombora topic IDs from Intent settings, such as `10183` (Payment Orchestration Platform), `10715` (Payment Gateway), and `10218` (Foreign Exchange Risk Management)

Intent configuration:

- Set `PROSPEO_INTENT_TOPIC_IDS` to the selected topic IDs, comma-separated. The connector also maps the nine selected topic names to their IDs for backwards compatibility.
- The built-in selected topic map is: `10183` Payment Orchestration Platform, `10720` Payment Service Provider (PSP), `10715` Payment Gateway, `15036` Checkout Optimization, `10218` Foreign Exchange Risk Management, `9880` Multi-Currency Accounting, `9943` Enterprise Spend Management, `10748` Virtual Cards, `10185` Payments API. Add `PROSPEO_INTENT_TOPIC_CATALOG_JSON` if this catalog changes.
- The backend sends those values to `/search-company` separately from `/search-person`, so people discovery still runs even when a company has no matching intent surge.
- Positive intent matches normalize into `intent_signals_<company>` with readable topic names/categories and influence scoring/Gemini as internal evidence only.

## PhantomBuster

### API surface relevant to this app

Discovered endpoint families on PhantomBuster API docs include:

- `/agents/launch`
- `/agents/launch-sync`
- `/agents/fetch`
- `/agents/fetch-output`
- `/agent/{id}/output`
- `/containers/fetch-output`
- `/containers/fetch-result-object`

### Data model guidance

PhantomBuster output is agent-specific. We should normalize by intent, not by single rigid schema.

High-value categories to extract when present:

- person identity: full name, title, profile URL, company
- contactability: email, email validity, website domain
- role seniority: decision-maker clues (Head/Director/C-level)
- hiring intensity: open roles and role titles
- tech footprint: technologies/platform tags
- demand/traffic: visits, growth, geo distribution

### Recommended ingestion strategy

- Prefer explicit mapping per configured PhantomBuster agent type.
- Preserve raw payload snapshots for audit/debug.
- Normalize only fields needed by scoring + outreach + YAMM.

## Intent Signals

### API surface relevant to this app

The app exposes a provider-neutral `intent` connector via:

- `INTENT_SIGNALS_URL_TEMPLATE`
- `INTENT_SIGNALS_API_KEY`
- `INTENT_SIGNALS_AUTH_HEADER`
- `INTENT_SIGNALS_AUTH_SCHEME`

Cursor or any other mapped intent source can feed this connector. The provider name stays internal.

### Useful response fields

- `intent_signals[]`, `intent.signals[]`, `company_intent[]`, `buyer_intent[]`
- `topics[]`, `intent_topics[]`, `keywords[]`, `surging_topics[]`
- per-signal `topic`, `intent_topic`, `keyword`, `signal`, `title`
- per-signal `motion`, `product_motion`, `motions[]`, `product_motions[]`
- per-signal `strength`, `intent_strength`, `score`, `intent_score`, `confidence_score`
- per-signal `recency_days`, `freshness_days`, `observed_at`, `detected_at`, `last_seen_at`
- per-signal `evidence`, `description`, `snippet`, `context`, `summary`

### Scoring and sequence use

- Scoring uses intent as a capped, freshness-decayed timing and motion-relevance boost after the core product-fit evidence has been established.
- Gemini/YAMM uses topics, motions, and evidence snippets as internal context for natural commercial hypotheses.
- Outbound copy must never mention provider names or direct phrases such as "intent data shows".

## Suggested Normalized Person Fields (cross-connector)

Where available, keep these stable fields for all provider payloads:

- `person_id`
- `full_name`
- `first_name`
- `role`
- `seniority`
- `persona_bucket`
- `email`
- `email_status` (`verified`, `guessed`, `missing`, `invalid`, provider-specific)
- `linkedin_url`
- `source`
- `source_freshness_days`
- `confidence`

## How to use these fields in workflow

1. Ranking and targeting:
- prioritize stakeholders by role relevance + confidence + contactability

2. Sequence generation:
- inject role and context evidence from connector fields

3. Approval and send:
- review person-level rows in YAMM with explicit confidence and email status

4. Auditability:
- keep `RelevantIndividualsJSON` so approved/exported rows preserve full context

## Next Implementation Candidates

1. Add connector-derived `email_status` provenance tags (provider + method).
2. Add optional `RecipientSource` column in YAMM rows.
3. Add UI panel in Gemini YAMM preview for `RelevantIndividuals` roster per company.
4. Add per-provider freshness stamps for person rows to prevent stale targeting.
5. Add a UI preview of normalized `intent_signals` topics and motion hints before sequence generation.
