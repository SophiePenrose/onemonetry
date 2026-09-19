# Codespace restoration: opportunities and saved prospects

The complete source review bundle received on 2026-09-19 contains 206 saved source files and 179 original committed versions from source commit `d37e65e2442d1ed5c2466a2072041db96956860c`. Its intended merged target is `91900a94cc92f00961d3e11e98b982cd58d383d5`. The upload includes source code, not the Codespace database or export datasets.

This first restoration ports the saved Active Opportunities screen and connects the older prospect workspace to the current outreach planner. It is a selective integration, not a wholesale replacement with the old server or a completed Codespace cutover.

## What now lives together

- **Signals & Research** retains the current monitoring and evidence workflow.
- **This Week / All Companies** retain current scoring and qualification behavior.
- **Outreach Planner → Load saved people** reads people already in the older `prospect_workspace` SQLite table for selected, currently eligible companies. It performs no provider search or enrichment. New people arrive unchecked; previously reviewed selections remain. Subsequent Apollo searches merge with saved people rather than replacing the draft.
- **Active Opportunities** shows active, closed-lost and closed-won companies with stored fit and sequence activity. Profiles open in the existing company view, and confirmed changes use the existing workflow transition API. Unscored and sub-threshold opportunities remain visible as history; visibility does not qualify them for new outreach.

The same £30m floor, product-fit gate, company exclusions, current CRM confirmation, weekly capacity, reply stops and handoff confirmation continue to apply. Old `crm_checked` and `selected_for_sequence` values do not become new clearance. Legacy phone numbers remain in their original table and are held out of automated call tasks because that schema does not establish phone permission.

Saved rows marked `do_not_contact`, `suppressed` or `hidden` now participate in the central contact-stop check by exact normalized email or LinkedIn identity. That check is used by plan generation, handoff and existing email exports. A stop recorded after approval blocks the later handoff. Lookup/schema errors fail closed.

## Data and runtime behavior

The integration reads the legacy prospect table without migrating, clearing or rewriting it. A fresh database without that table returns an empty saved-person list. It does not pretend to recover contact data from a source ZIP. The existing Codespace database or its isolated copy must be configured at runtime to see those saved people.

The opportunities endpoint reads existing workflow and sequence tables and never triggers scoring. Multiple workflow IDs for one company are collapsed using the same authoritative state as the profile and transition API. Retained legacy files, database snapshots, account ZIPs and uncommitted work must remain preserved until the full cutover is reviewed.

No app startup hooks, background backfill service, provider credentials, scoring weights, prompts or generation templates change in this restoration. No production database was used for validation, and no live outreach or enrichment was performed.

## Remaining reconciliation

| Area | Work still required |
| --- | --- |
| Custom Gem/YAMM and old prospect editor | Reconcile review/basket behavior and approved content with current suppression and export gates. The recovered code also changes generation templates and cadence structure; these must not silently replace the current behavior. |
| Matched Prospects | Replace hardcoded July export filenames and the fixed 86 count with a reviewed import and persistent provenance. The CSV datasets were deliberately not included in the code bundle. |
| Scoring/enrichment extensions | Review saved intent and role-change scoring changes separately; retain product-fit gates and calibrated weights. |
| Filing coverage and maintenance | Manage worker/watchdog lifecycle explicitly. Do not restore the old unconditional devcontainer watchdog startup. |
| Schema/data cutover | Review the recovered database schema and configuration on the separate copy, reconcile any subsequent live changes, then validate before starting the updated app. |

## Validation

Tests cover loading saved people without inheriting approval, preserving original rows, missing legacy tables, invalid schemas, identity-based stops, a stop added between plan approval and handoff, company eligibility, opportunity alias deduplication, unchecked UI imports, preservation of selected/deselected contacts through Apollo merges, and confirmed opportunity transitions. Backend tests use the repository's local-only fetch guard and synthetic temporary databases. The frontend test suite and production build also pass.
