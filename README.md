# Revolut Mid-Market Prospecting App

This repository contains a small MVP prospecting app plus the design context for helping a Revolut Business Mid-Market account executive identify, score, and prioritise the best companies to contact each week.

## What this project is for

The app is intended to turn a large universe of companies into a smaller, explainable weekly shortlist. It should help prioritise outreach based on product fit, pain signals, competitor context, commercial value, and response likelihood.

## What is in this repo

- `master_prompt_outline_v2.md` — the structured master outline and source-of-truth design spec.
- `revolut_prospecting_app_supplementary_context.md` — the written narrative context that explains the logic behind the outline.
- `frontend/` — a Vite React MVP with shortlist and company detail pages.
- `mock-backend/` — a local Express API with mock company data and deterministic scoring.
- `README.md` — this project overview and local run instructions.

## How to use this repo

Use the outline as the main instruction file and the supplementary context as supporting background. Together, they guide the app and preserve the nuances of the scoring model.

## Run the MVP locally

In one terminal:

```bash
cd mock-backend
npm install
npm run dev
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

The frontend proxies `/api` requests to the mock backend at `http://localhost:8000`.

## Project focus

The current design focuses on:

- product-fit scoring,
- weekly ranking and workspace flow,
- exclusions and closed-won suppression,
- response propensity as a meta-signal,
- competitor context,
- and segment-aware logic with a Mid-Market emphasis.

## Notes

The current app is intentionally small. It is designed to prove the shortlist to company-detail flow with mock data before adding production integrations or persistence.
