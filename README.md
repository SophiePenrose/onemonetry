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

Every pull request and every push to `main` runs the CI workflow
(`.github/workflows/ci.yml`) on Node 22:

| Job | Working dir | Commands |
|-----|-------------|----------|
| `Backend (mock-backend tests)` | `mock-backend/` | `npm ci` then `npm test` (`node --test`, 85 tests) |
| `Frontend (build + tests)` | `frontend/` | `npm ci`, `npm run build` (`vite build`), then `npm test` (`vitest run`) |

Run the same checks locally before pushing:

```bash
# backend tests
(cd mock-backend && npm ci && npm test)

# frontend build + tests
(cd frontend && npm ci && npm run build && npm test)
```

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

The optional case file supports `company_numbers` and `expected_order` so you can measure pairwise order agreement during calibration.

Recommended calibration loop:

1. Export `--review-csv` and have MM sales/strategy fill `expected_rank` + notes.
2. Apply the review CSV with `benchmark:apply-review` to update `expected_order`.
3. Re-run the benchmark with `--cases` to compare model order vs sales truth.

### Make CI a required merge gate (recommended)

CI is currently advisory — a red run does not block merging. To turn it into a
hard gate, enable branch protection on `main`
(**Settings → Branches → Add branch protection rule / ruleset**) and:

1. **Require status checks to pass before merging**, then select both checks:
   - `Backend (mock-backend tests)`
   - `Frontend (build + tests)`
2. **Require branches to be up to date before merging** (so checks run against the latest `main`).
3. *(Optional)* **Require a pull request before merging** with at least one approving review.

The check names above must match exactly; they are the `name:` values of the two
jobs in `.github/workflows/ci.yml`.

## Notes

This is a design and specification repository, not the final application itself. The files here are intended to support implementation in GitHub and Copilot.
