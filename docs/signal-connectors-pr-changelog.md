# Signal Connectors: PR Changelog

## Summary

This change set finalizes external signal connector ingestion for strategic intelligence (excluding Salesforce) by adding connector-native parsing, strict ownership semantics, and full fixture/API test coverage.

## Scope

- Added connector-specific mappers for Endole, OpenCorporates, Similarweb, BuiltWith, Adzuna, Crunchbase, and Clearbit.
- Preserved generic fallback parsing, but now prefer source-native extraction first.
- Enforced ownership interpretation aligned with current strategy: significant controllers (25%+), corporate entities only, and non-UK jurisdiction inferred by governing law/country signals.
- Added fixture-driven tests for each connector using realistic payload shapes.
- Added API route tests for POST /api/signals/sync/:number for configured and unconfigured paths.

## Connector Impact Matrix

| Connector | Native payload focus | Envelopes written | Key normalized fields |
| --- | --- | --- | --- |
| Endole | shareholders, jobs, website tech, traffic, reviews | ownership, hiring_signals, reputation, marketing_intelligence, tech_stack | non_uk_significant_corporate_controllers_count, total_open_roles, payment_related_complaints, monthly_web_traffic, technologies |
| OpenCorporates | beneficial_owners, controlling_entities, jurisdiction | ownership | significant_corporate_controllers_count, non_uk_significant_corporate_controllers_count, parent_company |
| Similarweb | visits series, geo distribution, ad spend | marketing_intelligence | monthly_web_traffic, estimated_monthly_ad_spend, traffic_geography |
| BuiltWith | Results/Paths/Technologies graph | tech_stack | technologies, signal_count |
| Adzuna | results jobs list, count | hiring_signals | total_open_roles, open_roles, role buckets |
| Crunchbase | properties positions + traffic + ad spend | hiring_signals, marketing_intelligence | total_open_roles, monthly_web_traffic, estimated_monthly_ad_spend |
| Clearbit | site tech + site/metrics visitors + open positions | tech_stack, hiring_signals, marketing_intelligence | technologies, total_open_roles, monthly_web_traffic |

## Cross-Cutting Parser Fixes

- Fixed numeric parsing behavior to avoid false 0 values from missing fields.
- Added geography normalization so array distributions map into traffic_geography object percentages.
- Expanded accepted source paths for nested provider payload variants.

## Runtime Behavior

- Sync entrypoint: POST /api/signals/sync/:number
- Orchestration: connector-native parse first, then generic fallback coalescing.
- Merge policy: preserves stronger Companies House ownership baseline while allowing external source accumulation.
- Status/config visibility: /api/integrations/status reflects connector readiness based on credentials + URL templates.

## Test Coverage Added

- Connector unit/integration tests:
  - mock-backend/__tests__/signal-connectors.test.js
  - mock-backend/__tests__/signal-connectors-fixtures.test.js
- API route tests:
  - mock-backend/__tests__/signals-sync-api.test.js

## Validation Snapshot

- Targeted connector suites: pass
- Full backend suite: pass (64/64)

## PR Body (Copy/Paste)

```md
## What changed
- Implemented source-native connector parsing for Endole, OpenCorporates, Similarweb, BuiltWith, Adzuna, Crunchbase, and Clearbit.
- Added fixture-driven validation for realistic provider payloads.
- Added API tests for POST /api/signals/sync/:number (configured + unconfigured paths).
- Fixed numeric parsing edge case where missing values could collapse to 0 and hide deeper fallback paths.

## Why
- Improve signal fidelity and reduce heuristic drift by using provider-native structures.
- Ensure ownership signal logic matches strategy (25%+, corporate-only, non-UK inference).
- Lock behavior with deterministic tests before broadening connector rollout.

## Risk
- Low to moderate. Parsing paths expanded and tested; fallback logic remains intact.

## Validation
- node --test __tests__/signal-connectors.test.js __tests__/signal-connectors-fixtures.test.js __tests__/signals-sync-api.test.js
- npm test
```
