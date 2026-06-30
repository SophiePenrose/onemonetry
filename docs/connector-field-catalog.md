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

## Prospeo

### Endpoint and auth

- Endpoint: `POST https://api.prospeo.io/bulk-enrich-company`
- Headers:
  - `Content-Type: application/json`
  - `X-KEY: <api_key>`

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

Tech and stack context:

- `company.technology.count`
- `company.technology.technology_names[]`
- `company.technology.technology_list[].name`
- `company.technology.technology_list[].category`

Commercial/change context:

- `company.funding.*`
- `company.attributes.*` (for example B2B, free trial, pricing availability)

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
