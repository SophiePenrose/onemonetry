# External Signal Connector Contract (v1)

## Purpose

Defines expected provider payload shapes and how fields map into runtime envelopes used by scoring and outreach orchestration.

## Ingestion Entry Point

- API route: POST /api/signals/sync/:number
- Runtime writer: mock-backend/signal-connectors.js

Discovery option:

- Request body flag discover_status_urls (or enable_status_discovery in internal sync calls)
- Environment default override: ENABLE_STATUS_URL_DISCOVERY=false

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
- status_incidents_total
- status_incidents_open
- status_major_incidents_open
- status_degraded_components
- status_incident_weighted_open
- status_incident_severity_score
- status_health_band
- status_recent_incident_at
- status_recent_open_incident_at
- status_recent_incident_age_days
- status_incident_recency_multiplier

Status severity normalization notes:

- status_incident_severity_score is recency-adjusted so stale incidents decay over time.
- status_incident_recency_multiplier ranges 0..1 and is applied to weighted open-incident severity before health band assignment.
- status_recent_open_incident_at is preferred for recency decay when present; otherwise latest incident timestamp is used.

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

Configuration note:

- OPENCORPORATES_URL_TEMPLATE is required
- OPENCORPORATES_API_TOKEN is optional (used when provided)

Expected source structures accepted:

- results.company.beneficial_owners
- results.company.controlling_entities
- results.company.company.beneficial_owners
- results.companies[0].company.beneficial_owners
- results.company.company.jurisdiction_code

Primary envelope targets:

- ownership

### Prospeo

Configuration note:

- PROSPEO_URL_TEMPLATE is required
- PROSPEO_API_KEY is optional (used when provided)

Expected source structures accepted:

- jobs[] / open_roles (when provided)
- technologies[] / tech_stack[]
- monthly_web_traffic / traffic_geography

Primary envelope targets:

- hiring_signals, marketing_intelligence, tech_stack

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

### Statuspage (free, Statuspage-compatible)

Expected source structures accepted:

- incidents[] (name/title, status, impact, incident_updates[])
- components[] (name, status)
- page.name / page.url

Primary envelope targets:

- reputation

### Status Feed (free, RSS/Atom)

Expected source structures accepted:

- RSS item title/description/pubDate/link
- Atom entry title/summary/content/updated/link
- Optional feed title/link metadata

Primary envelope targets:

- reputation

### Status API (free, JSON)

Expected source structures accepted:

- incidents[] / events[] / issues[] / outages[]
- components[] / services[] / systems[]
- Optional top-level status metadata (name/title/url)

Primary envelope targets:

- reputation

### Status Instatus (free, summary JSON)

Expected source structures accepted:

- activeIncidents[] / active_incidents[]
- incidents[] (fallback)
- components[] / page.components[]
- page.name / page.url (or top-level name/url)

Primary envelope targets:

- reputation

### Status Cachet (free, incidents API)

Expected source structures accepted:

- data[] incident rows from /api/v1/incidents
- incidents[] fallback
- incident fields such as name/title/message, human_status/status_name/status

Primary envelope targets:

- reputation

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
- mock-backend/__tests__/fixtures/signal-connectors/statuspage.json
- mock-backend/__tests__/fixtures/signal-connectors/status-feed.json
- mock-backend/__tests__/fixtures/signal-connectors/status-api.json
- mock-backend/__tests__/fixtures/signal-connectors/status-instatus.json
- mock-backend/__tests__/fixtures/signal-connectors/status-cachet.json
