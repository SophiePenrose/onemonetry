# Revolut Mid-Market Prospecting App

[![CI](https://github.com/SophiePenrose/onemonetry/actions/workflows/ci.yml/badge.svg)](https://github.com/SophiePenrose/onemonetry/actions/workflows/ci.yml)

This repository contains the design context for a prospecting app that helps a Revolut Business Mid-Market account executive identify, score, and prioritise the best companies to contact each week.

## What this project is for

The app is intended to turn a large universe of companies into a smaller, explainable weekly shortlist. It should help prioritise outreach based on product fit, pain signals, competitor context, commercial value, and response likelihood.

## What is in this repo

- `master_prompt_outline_v2.md` — the structured master outline and source-of-truth design spec.
- `revolut_prospecting_app_supplementary_context_v2.md` — the written narrative context that explains the logic behind the outline.
- `README.md` — this project overview.

## How to use this repo

Use the outline as the main instruction file and the supplementary context as supporting background. Together, they are meant to guide the build of the app and preserve the nuances of the scoring model.

## Project focus

The current design focuses on:

- product-fit scoring,
- weekly ranking and workspace flow,
- exclusions and closed-won suppression,
- response propensity as a meta-signal,
- competitor context,
- and segment-aware logic with a Mid-Market emphasis.

## Continuous integration

The CI workflow (`.github/workflows/ci.yml`) runs on Node 22.

Core checks run on every pull request and every push to `main`:

| Job | Working dir | Commands |
|-----|-------------|----------|
| `Backend (mock-backend tests)` | `mock-backend/` | `npm ci` then `npm test` |
| `Frontend (build + tests)` | `frontend/` | `npm ci`, `npm run build`, then `npm test` |
| `Smoke (quick e2e)` | repo root | `npm ci` for backend+frontend, then `npm run smoke:e2e:quick` |

Pull requests additionally run:

| Job | Output |
|-----|--------|
| `Benchmark Delta (scoring)` | base-vs-head benchmark delta JSON + markdown artifact, plus an auto-updated PR comment summary |

Run the same checks locally before pushing:

```bash
# backend tests
(cd mock-backend && npm ci && npm test)

# frontend build + tests
(cd frontend && npm ci && npm run build && npm test)

# quick e2e smoke (auto-starts backend/frontend if needed)
npm run smoke:e2e:quick
```

## Lightweight Backend Runtime

For low-memory validation workflows (for example API smoke checks, shortlist/detail payload checks, or large import dry-runs), start the backend in lightweight mode:

```bash
npm run start:backend:light
```

This sets `LIGHTWEIGHT_RUNTIME=true`, which disables background workers and schedulers such as:

- analysis queue worker + auto-seed
- tech enrichment auto-refresh seeding
- daily/monthly auto-pull jobs
- stale filing monitor
- backfill autorun

Use normal `npm run start:backend` for full-runtime behavior.

## Quick End-to-End Smoke

Run a one-command smoke pass that verifies backend endpoints directly and via the frontend `/api` proxy:

```bash
npm run smoke:e2e:quick
```

Behavior:

- Reuses existing backend/frontend services if they are already running.
- Auto-starts missing services (backend in lightweight mode) and waits for readiness.
- Runs `scripts/smoke-api.sh` checks.
- Cleans up only the services it started.

Optional environment overrides:

- `BACKEND_BASE` (default `http://localhost:8000`)
- `FRONTEND_BASE` (default `http://localhost:5173`)
- `FRONTEND_PORT` (default `5173`)
- `CURL_TIMEOUT` (default `6`)
- `BACKEND_LOG` (default `/tmp/onemonetry-backend.log`)
- `FRONTEND_LOG` (default `/tmp/onemonetry-frontend.log`)

## Scoring Calibration Benchmark

Use the benchmark runner to snapshot current ranking behavior and competitor-context diagnostics before/after scoring changes.

```bash
# auto-select active monitored companies with enough filing text
npm run benchmark:scoring

# run against a curated benchmark case set
npm run benchmark:scoring -- --cases docs/scoring-calibration-cases.example.json

# run against the current bootstrap baseline set
npm run benchmark:scoring -- --cases docs/scoring-calibration-cases.bootstrap.json

# export a sales review sheet with blank expected_rank values
npm run benchmark:scoring -- --cases docs/scoring-calibration-cases.bootstrap.json --review-csv exports/scoring-calibration-review.csv

# same export, but pre-fill expected_rank from the case file expected_order
npm run benchmark:scoring -- --cases docs/scoring-calibration-cases.bootstrap.json --review-csv exports/scoring-calibration-review-prefilled.csv --prefill-expected

# apply expected_rank values from a filled review CSV into expected_order
npm run benchmark:apply-review -- --cases docs/scoring-calibration-cases.bootstrap.json --review-csv exports/scoring-calibration-review.csv --out docs/scoring-calibration-cases.bootstrap.updated.json

# overwrite the case file directly once reviewed
npm run benchmark:apply-review -- --cases docs/scoring-calibration-cases.bootstrap.json --review-csv exports/scoring-calibration-review.csv --in-place
```

Outputs:

- Timestamped snapshot in `exports/`
- Rolling latest snapshot at `exports/scoring-calibration-benchmark-latest.json`
- Optional review CSV in `exports/` for manual expected-rank input

Benchmark delta comparison helper:

```bash
npm run benchmark:delta -- \
   --base exports/scoring-calibration-benchmark-base.json \
   --head exports/scoring-calibration-benchmark-head.json \
   --out exports/scoring-calibration-benchmark-delta.json \
   --markdown exports/scoring-calibration-benchmark-delta.md
```

CI uses the same helper on pull requests to publish a benchmark-delta artifact and a sticky PR comment.

The optional case file supports `company_numbers` and `expected_order` so you can measure pairwise order agreement during calibration.

Recommended calibration loop:

1. Export `--review-csv` and have MM sales/strategy fill `expected_rank` + notes.
2. Apply the review CSV with `benchmark:apply-review` to update `expected_order`.
3. Re-run the benchmark with `--cases` to compare model order vs sales truth.

## Large CSV Monitor Import

Use the bulk monitor-list importer when you need to ingest large company-number CSV sets (for example multiple source files totaling tens of thousands of rows).

```bash
# import multiple CSV files in one deduplicated batch
npm run import:monitor-list -- data/source3-part1.csv data/source3-part2.csv data/source3-part3.csv data/source3-part4.csv

# same import with explicit source tag and JSON report output
npm run import:monitor-list -- --source source_3_csv --report exports/monitor-import-report.json data/source3-part1.csv data/source3-part2.csv data/source3-part3.csv data/source3-part4.csv

# dry-run preview (no DB writes) before a large ingest
npm run import:monitor-list -- --dry-run --source source_3_csv --report exports/monitor-import-dry-run.json data/source3-part1.csv data/source3-part2.csv data/source3-part3.csv data/source3-part4.csv

# import only companies not already in company_monitor
npm run import:monitor-list -- --new-only --source source_3_csv data/source3-part1.csv data/source3-part2.csv data/source3-part3.csv data/source3-part4.csv
```

Notes:

- This command updates `company_monitor` only (no Companies House lookup fan-out during import).
- Company numbers are deduplicated across all provided files before database upsert.
- Closed-won company numbers are excluded by default (use `--include-closed-won` to override).
- The optional report captures per-file parse and dedupe counts.

### Make CI a required merge gate (recommended)

CI is currently advisory — a red run does not block merging. To turn it into a
hard gate, enable branch protection on `main`
(**Settings → Branches → Add branch protection rule / ruleset**) and:

1. **Require status checks to pass before merging**, then select these checks:
   - `Backend (mock-backend tests)`
   - `Frontend (build + tests)`
   - `Smoke (quick e2e)`
   - `Benchmark Delta (scoring)`
2. **Require branches to be up to date before merging** (so checks run against the latest `main`).
3. *(Optional)* **Require a pull request before merging** with at least one approving review.

The check names above must match exactly; they are the `name:` values of the two
jobs in `.github/workflows/ci.yml`.

## Notes

This is a design and specification repository, not the final application itself. The files here are intended to support implementation in GitHub and Copilot.
