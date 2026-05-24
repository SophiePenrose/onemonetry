# Revolut Mid-Market Prospecting App

This repository contains a personal-use outbound intelligence and drafting copilot for researching, prioritising, and engaging UK mid-market prospects.

## What this project is for

The app is intended to turn a large universe of companies into a smaller, explainable shortlist, then help a single user draft high-quality outbound cadences. It should enrich companies from public and approved commercial sources, identify likely buyer personas, generate insights and outreach angles, and push campaigns into YAMM for optional human review and scheduled sending.

## Scope boundaries

This is a personal workflow tool, not an internal Revolut platform integration. It should not:

- integrate with Revolut internal CRM systems,
- sync with Salesforce,
- write into company infrastructure,
- automate compliance workflows,
- or function as an autonomous AI SDR platform.

The user remains responsible for reviewing outreach, deciding what to send, and scheduling any send through approved tools such as YAMM.

## Current user setup choices

- People/contact enrichment should prioritise LinkedIn public profile research, company websites/team pages, news, and a Lusha-style contact enrichment tool chosen after review.
- Sales Navigator is not assumed.
- Email sending should use Google Sheets/YAMM export. The user reviews rows, adds missing emails, then schedules/sends.
- The safety list should include opted-out people, bounced emails, and companies the user manually excludes.
- Generated outreach should follow the user's preferred style: observant, commercially intelligent, operationally grounded, evidence-based, concise, low-ego, consultative, and relevant without being invasive.
- Bad outreach patterns include scraped personal details, fake certainty, generic AI fluff, aggressive calendar asks, and obvious mail-merge placeholders.

## What is in this repo

- `master_prompt_outline_v2.md` — the structured master outline and source-of-truth design spec.
- `revolut_prospecting_app_supplementary_context_v2.md` — the written narrative context that explains the logic behind the outline.
- `README.md` — this project overview.

## How to use this repo

Use the outline as the main instruction file and the supplementary context as supporting background. Together, they are meant to guide the build of the app and preserve the nuances of the scoring model.

## Project focus

The current design focuses on:

- product-fit scoring,
- ranking and workspace flow,
- exclusions and closed-won suppression,
- response propensity as a meta-signal,
- competitor context,
- and segment-aware logic with a Mid-Market emphasis.

## Notes

This is a prototype application and supporting specification repository for a single-user workflow.

## Persistence

The mock backend persists monitored companies, filings, analysis results, workflow state, auth sessions, and email sequences in SQLite. By default the database is `mock-backend/onemonetry.db`.

For deployments or Cursor Cloud sessions that need data to survive container rebuilds, set:

- `DATABASE_PATH=/path/on/persistent/volume/onemonetry.db`
- `PROCESSED_ZIPS_DATA_DIR=/path/on/persistent/volume/processed-zips`

Both paths should point at mounted persistent storage. `DATABASE_PATH` may be absolute or relative to the repo root, and the backend creates its parent directory if needed.

Prototype gap: SQLite is suitable for local development and single-instance personal use. A hosted version should migrate to managed Postgres, with migrations for `company_monitor`, `company_filings`, `settings`, `workflow_*`, `import_*`, auth, stakeholder, and email sequence tables; a connection pool; transactional import writes; and a one-off SQLite-to-Postgres backfill script.
