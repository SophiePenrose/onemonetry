# UI/UX Specification v2

## Data Ingestion -> Weekly Top 100 -> YAMM Export

## Core Concept

The app is a research-and-draft tool. It ingests company filings
from 4 sources, scores them, builds Research Dossiers, generates
email sequences, and surfaces a weekly Top 100 for AE review
and YAMM export. It does NOT send emails, track opens/replies,
or manage ongoing sequences.

## Navigation

- This Week: Weekly Top 100 three-pane workspace
- All Companies: Full universe browse + filter
- Performance: Output and pipeline metrics
- Data Pipeline: Ingestion health and status

## Data Sources

- Source 1a: Monthly bulk (historic backfill)
- Source 1b: Monthly scheduled filings (ongoing fresh)
- Source 2: Twice-weekly accounts filings (freshest)
- Source 3: Monthly mid-market CSVs (~40k companies, lookup
  required, spread ~2k/day across month)

## Weekly Top 100

- Generated every Monday 06:00
- Ranked by composite score, filing recency, dossier tier
- Filters out: existing customers, non-trading, holding/SPV,
  EDD, insufficient data, already-in-sequence
- Mid-week refresh when Source 2 delivers new high-scoring
  prospects
- Carryover logic for unreviewed vs reviewed-but-not-exported

## Export

- YAMM-ready CSV with columns: Email Address, First Name,
  Last Name, Company, Subject, Email Body
- Optional Google Sheets push
- Batch export with missing-email-address handling
- Status tracking per prospect per email step
- Smart next-step defaulting in export dropdown

## Source 3 Quality Control

- Automated filtering: non-trading, holding, SPV detection
- Confidence-based: high -> auto-filter, medium -> flag,
  low -> include
- AE override available for all filtered companies
- Transparent filtering stats in Pipeline view

## Design System

- 4 primary colours: brand dark, green (success), amber
  (attention), red (critical)
- 8px spacing grid
- Inter typeface
- 1400px max content width
- Skeleton loaders, meaningful empty states, clear error states
- Full keyboard navigation + WCAG 2.1 AA

## Build Priority

1. Weekly Top 100 generation logic + This Week view
2. Three-pane layout (queue + brief + emails)
3. YAMM CSV export with batch selection
4. Data Pipeline view (all 4 sources)
5. Source 3 filtering logic
6. All Companies browse + filter
7. Performance dashboard
8. Google Sheets push integration
9. Onboarding flow
10. Settings
