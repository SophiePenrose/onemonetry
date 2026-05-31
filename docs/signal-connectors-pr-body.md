# Signal Connectors PR Body

## What changed

- Added connector-native external signal parsing for Endole, OpenCorporates, Similarweb, BuiltWith, Adzuna, Crunchbase, and Clearbit.
- Kept generic fallback parsing, but now run source-native extraction first and coalesce with fallback output.
- Enforced ownership interpretation for strategic scoring:
  - significant controllers (25%+)
  - corporate entities only
  - non-UK inferred from governing law and country signals
- Fixed numeric extraction edge case where missing values could collapse to 0 and mask valid fallback paths.
- Added traffic geography normalization for array/object source formats.
- Added fixture-backed tests with realistic provider payload shapes per connector.
- Added API route coverage for POST /api/signals/sync/:number for configured and unconfigured connector states.
- Added documentation:
  - docs/signal-connectors-pr-changelog.md
  - docs/signal-connectors-contract.md

## Why

- Improve signal fidelity and reduce parser drift by preferring source-native connector mapping.
- Ensure ownership signals align with the current strategic definition used in scoring and outreach prioritization.
- Lock parser behavior with deterministic fixture coverage before broader production rollout.

## Validation

- node --test __tests__/signal-connectors.test.js __tests__/signal-connectors-fixtures.test.js __tests__/signals-sync-api.test.js
- npm test

Result:
64 tests passed, 0 failed.

## Scope Notes

- This PR excludes Salesforce integration by design.
- Ownership merge precedence preserves stronger Companies House ownership signal while accumulating external sources.
