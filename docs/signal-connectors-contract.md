# External Signal Connector Contract (v1)

## Purpose

Defines expected provider payload shapes and how fields map into runtime envelopes used by scoring and outreach orchestration.

## Ingestion Entry Point

- API route: POST /api/signals/sync/:number
- Runtime writer: mock-backend/signal-connectors.js

## URL Template Placeholders

Supported placeholders inside *_URL_TEMPLATE values:

- {company_number}
- {company_name}
- {company_name_encoded}
- {company_domain}
- {company_domain_encoded}

## Envelope Semantics

### ownership_{company_number}

Primary use:

- ownership structure scoring and non-UK significant corporate controller detection

Minimum normalized outputs:

- significant_corporate_controllers_count
- non_uk_significant_corporate_controllers_count
- significant_corporate_controllers[]
- non_uk_significant_corporate_controllers[]
- parent_company
- parent_country

Interpretation rules:

- Significant control is 25%+ (explicit percentage or matching control-nature strings).
- Corporate entities only count toward significant controller outputs.
- Non-UK uses governing law/country indicators.

### hiring_signals_{company_number}

Primary use:

- urgency, motion boosts, velocity triggers

Minimum normalized outputs:

- total_open_roles
- open_roles[]
- finance_roles_open[]
- treasury_roles_open[]
- international_roles_open[]
- ecommerce_roles_open[]
- hiring_signal_score

### reputation_{company_number}

Primary use:

- pain boost inference from complaints/review pressure

Common normalized outputs:

- trustpilot_review_count
- payment_related_complaints
- checkout_related_complaints

### marketing_intelligence_{company_number}

Primary use:

- traffic and paid demand intensity signals

Common normalized outputs:

- monthly_web_traffic
- estimated_monthly_ad_spend
- traffic_geography

### tech_stack_{company_number}

Primary use:

- incumbent stack and switching feasibility

Common normalized outputs:

- technologies[]
- detected_technologies[]
- signal_count

## Connector-Specific Accepted Keys

### Endole

Expected source structures accepted:

- company.shareholders / ownership.shareholders / beneficial_owners
- company.jobs / jobs / hiring.open_roles
- website.technologies / website.detected_technologies
- website.monthly_visits / traffic.monthly_visits
- traffic.geography
- reviews.count / reviews.payment_related_complaints / reviews.checkout_related_complaints

Primary envelope targets:

- ownership, hiring_signals, reputation, marketing_intelligence, tech_stack

### OpenCorporates

Expected source structures accepted:

- results.company.beneficial_owners
- results.company.controlling_entities
- results.company.company.beneficial_owners
- results.companies[0].company.beneficial_owners
- results.company.company.jurisdiction_code

Primary envelope targets:

- ownership

### Similarweb

Expected source structures accepted:

- visits[] or traffic.visits[]
- countries[] / distribution[] / geo_distribution
- ads.search_spend / ads.estimated_monthly_spend

Primary envelope targets:

- marketing_intelligence

### BuiltWith

Expected source structures accepted:

- Results[].Result.Paths[].Technologies[].Name

Primary envelope targets:

- tech_stack

### Adzuna

Expected source structures accepted:

- results[].title
- count / total_results

Primary envelope targets:

- hiring_signals

### Crunchbase

Expected source structures accepted:

- properties.num_current_positions
- properties.monthly_visits or properties.monthly_web_traffic
- properties.estimated_monthly_ad_spend

Primary envelope targets:

- hiring_signals, marketing_intelligence

### Clearbit

Expected source structures accepted:

- site.tech[] or site.technologies[]
- site.monthlyVisitors / site.monthly_visitors
- metrics.open_positions / metrics.openRoles / metrics.open_roles

Primary envelope targets:

- tech_stack, hiring_signals, marketing_intelligence

## Merge and Precedence Rules

- Source-native parse runs first.
- Generic parse runs as fallback and is coalesced with source-native output.
- Ownership merge preserves stronger Companies House signal when present.
- external_sources accumulates contributing connector sources.

## Parsing Safety Notes

- Missing numeric values must not coerce to 0 during extraction.
- Geography arrays are normalized into traffic_geography object percentages.
- Both object and array payload variants should be handled for provider evolution.

## Fixture References

Fixture payloads for contract verification:

- mock-backend/__tests__/fixtures/signal-connectors/endole.json
- mock-backend/__tests__/fixtures/signal-connectors/opencorporates.json
- mock-backend/__tests__/fixtures/signal-connectors/similarweb.json
- mock-backend/__tests__/fixtures/signal-connectors/builtwith.json
- mock-backend/__tests__/fixtures/signal-connectors/adzuna.json
- mock-backend/__tests__/fixtures/signal-connectors/crunchbase.json
- mock-backend/__tests__/fixtures/signal-connectors/clearbit.json
