# AGENTS.md

## Cursor Cloud specific instructions

### Services

| Service | Directory | Port | Start command |
|---------|-----------|------|---------------|
| Mock Backend (Express) | `mock-backend/` | 8000 | `node mock-backend/server.js` (run from repo root) |
| Mock Backend auto-restart | `mock-backend/` | 8000 | `npm run dev` (run from `mock-backend/`) |
| Frontend (Vite + React) | `frontend/` | 5173 | `npm run dev` (run from `frontend/`) |

### Important caveats

- The **mock-backend resolves its data files relative to its own directory** (`__dirname`), so it can be started from anywhere — e.g. `node mock-backend/server.js` from the repo root, or `npm start` from inside `mock-backend/`. Override the data locations with the `COMPANIES_PATH` and `DATABASE_PATH` environment variables if needed.
- The **frontend Vite dev server** proxies `/api` requests to `http://localhost:8000`, so the mock-backend must be running before the frontend can fetch data.
- Start the backend **before** the frontend to avoid proxy errors on initial page load.
- During development, prefer `npm run dev` in `mock-backend/` so Node restarts automatically on backend file changes. Vite already hot-reloads frontend changes.
- Both services use `npm` (lockfiles are `package-lock.json`).
- Both services define `lint` and `test` scripts in their `package.json`. The frontend additionally defines `build`/`dev`/`preview` (`npm run build` runs `vite build`), while the backend defines `start`/`dev` (no backend build step). `npm test` runs `vitest run` (frontend) and `node --test __tests__/*.test.js` (backend).
- **CI:** every pull request and every push to `main` runs `.github/workflows/ci.yml` (Node 22) — a `Backend (mock-backend tests)` job (`npm ci` + `npm test`) and a `Frontend (build + tests)` job (`npm ci` + `npm run build` + `npm test`). To make CI a hard merge gate, enable branch protection on `main` requiring those two checks (see the README "Continuous integration" section).
- `mock-backend/companies.json` ships as a single placeholder company — a clean slate intended for real Companies House data loaded via the import pipeline. A fuller 27-company reference dataset with varied product motions (`FX`, `Cards`, `Merchant Acquiring`, etc.) is available in `mock-backend/companies.sample.json`.

## Context for agents (read this BEFORE changing scoring or email logic)

These files hold the design intent and are easy to miss — read them first; they are the source of truth, not the code:

- `master_prompt_outline_v2.md` + `revolut_prospecting_app_supplementary_context.md` — the layered scoring philosophy: **product fit gates everything**; commercial value and response propensity only *reorder* already-qualified accounts; merchant-spend/competitor signals are conditional refinements; the LLM extracts evidence but **application logic owns the final weighting, gating, and sorting**. Keep the model explainable, auditable, and tunable — small weight changes must not break the list.
- `prompts/email-generation-v7.txt` + `docs/email-generation-architecture-v7.md` — Sophie's calibrated prospecting voice (with an explicit banned-vocabulary list: "I noticed", "quick question", em-dash filler, AI tells), the 4-email + 2-nudge / 14-day structure, dossier tiers A–D, and the three QC gates (citation density / voice authenticity / compliance) enforced by `mock-backend/email-qc.js`. The QC-aware deterministic path is the **Holistic Narrative** generator in `mock-backend/email-sequences.js`.
- `docs/signal-connectors-contract.md` — external signal connector payload → envelope mapping (`reputation_<n>`, `hiring_signals_<n>`, `ownership_<n>`, `tech_stack_<n>`, `marketing_intelligence_<n>`) written by `mock-backend/signal-connectors.js` (`POST /api/signals/sync/:number`) and consumed by `mock-backend/scoring-engine.js`.

### Scoring weights — two related sets (don't let them drift)

There are two weight definitions, kept in sync deliberately: the user-tunable **5 UI/segment layers** (`product_fit, commercial_value, pain_strength, urgency, competitor_context`) exposed by `GET /api/scoring-weights` (which a test asserts is length **5**), and the scoring engine's internal **6-layer fit weights** that additionally include `switching_feasibility` and feed `composite_score`. Reconciling their numeric values changes `composite_score`/ranking and the scoring tests — only do that with real calibration input, and re-baseline the tests when you do.

### Continuous integration gotcha (bot-authored PRs)

PRs opened by the **Copilot coding agent** (or any GitHub App) do **not** run CI automatically — GitHub holds the workflows behind **"Approve and run workflows"** in the PR's Checks tab. A maintainer must approve once, or push to / "Update branch" on the PR, before the backend + frontend checks run. Never assume a bot-authored PR is green until you've actually triggered and seen the two checks pass.
