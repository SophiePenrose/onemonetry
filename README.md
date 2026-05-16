# Revolut Mid-Market Prospecting App

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

## Notes

This is a design and specification repository, not the final application itself. The files here are intended to support implementation in GitHub and Copilot.
