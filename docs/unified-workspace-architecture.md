# One prospecting workspace: audit and integration

Updated 19 September 2026. This is the continuation guide for the combined application.

## Product decision

Sophie wants the company-monitoring, acquisition research, product-fit analysis, contacts and outreach tools in **one application**. Retain GitHub as the code and review workflow. Do not replace the GitHub app with a simple alert dashboard or maintain two disconnected prospecting workflows.

The canonical application code is `SophiePenrose/onemonetry`. The existing React frontend and Express backend remain the integration target because they contain the substantive scoring, filing analysis, email QC, workflow and outreach features. The monitoring dashboard's capabilities are incorporated into that frontend through its authenticated backend.

The prospecting floor is **£30m turnover**, superseding older £15m documents. The current scoring engine's upper threshold defaults to £200m; this change preserves it rather than inventing a different ceiling. Monitoring can retain smaller companies, acquisition vehicles and companies with unknown turnover; those records are research, not automatic outreach candidates.

## Existing systems and verified boundaries

| System | Existing role | Role in the combined application |
| --- | --- | --- |
| GitHub `onemonetry` | React + Express; SQLite filing corpus, scoring, company history, email QC and outreach | Canonical application and GitHub PR workflow |
| Supabase **Mid Market Prospecting** (`dpvmbbefhnajnayrmwyo`) | Production company watchlist, officers, PSCs, filing events, research enquiries, customer/applicant matching and review history | Authoritative monitoring and company-change evidence |
| [MM Prospect Review](https://mm-prospect-review.sophiepenrose.chatgpt.site), Site `appgprj_6aab1e23388c8191bd27168f4be9149d` | Separately published private Sites dashboard | Preserve as the working reference/fallback until unified runtime is verified |
| Supabase `companies-house-batch` | Scheduled collection | Keep as the collector; do not start competing collectors merely to join the UI |
| Supabase `prospect-dashboard` | Scoped, authenticated read/review bridge | Reuse its existing contracts, or call the same RPCs with a backend-only Supabase key |
| Apollo / LinkedIn fallback | Stakeholder discovery and selected enrichment | Company-context discovery after eligibility/CRM review; preserve credit approval |
| We-Connect | Approved LinkedIn campaign handoff | Retain direct API and manual fallback; do not send on alert review or shortlist selection |

Live read-only verification confirmed that `dashboard_read`, `dashboard_research` and `dashboard_closed_won` return data. The edge bridge is version 4. The published Site frontend only exposes the original alerts/watchlist views, while the live bridge also supports research and customer matching. Project health alone is not evidence of end-to-end data access from the GitHub runtime.

## Where sections belong

| Area | Decision it supports | What belongs here |
| --- | --- | --- |
| This Week | Which qualified accounts deserve time? | Existing ranked shortlist, research gaps, live workflow and exclusions |
| Signals & Research | What changed and is it worth investigating? | Company-change inbox, deal enquiries, monitoring watchlist, past-customer/applicant cross-reference |
| All Companies | What do we know about this entity? | Existing company universe and entry to a common dossier |
| Company workspace | Why this company, why now, who and what next? | Overview/fit, changes, source evidence, ownership, people, emails, notes and activity history |
| Outreach Planner | Which approved people fit this week's capacity? | CRM checks, Apollo discovery, contact selection, email/phone availability, 90 automated LinkedIn slots and 10 manual reserve |
| Performance | What happened after selection? | Historical reports and operational outcomes; not automatic changes to model weights |
| Data Pipeline / Settings | What is missing or disconnected? | Imports, collector status, connections and operational configuration |

Monitoring review status is distinct from company workflow and contact/channel approval. In particular, Supabase `qualified` means a human judged a signal relevant for further research; it does **not** establish product fit, CRM ownership clearance, contact permission or campaign enrolment.

## Implemented in this change

- Native Signals & Research screens for existing alerts, enquiries, watchlist and past-customer matching; evidence links, appointment names/effective dates, uncertainty, review history, search and pagination.
- Reuse of the source RPCs, preserving review timestamps and optimistic concurrency. No duplicate alert database or automatic alert score.
- Backend-only source access, supporting the scoped `DASHBOARD_BRIDGE_*` path or existing `SUPABASE_*` credentials. Unconfigured/failed reads produce explicit errors, not apparently empty inboxes.
- Reviews require a valid existing owner session and a server-configured `MONITORING_REVIEWER_EMAIL`; browser-supplied reviewer identity is ignored. Development sessions cannot qualify real alerts.
- Company-number handoff reuses an existing legacy company ID where present. Existing facts, scores, exclusions, held states and history are not overwritten by a source snapshot.
- Exact past-customer matches are carried into the research snapshot and block promotion even if the local closed-won registry has not been synchronised. Applicant email addresses are not copied into that snapshot.
- New monitoring candidates are persisted in `company_monitor` with `status=research`, outside the weekly shortlist. Importing/opening them does not enqueue LLM analysis. Their source snapshot is labelled and dated; unscored candidates do not get the old turnover-derived fallback score.
- Explicit promotion to the shortlist requires the existing full product-fit gate, configured turnover range and existing suppression checks. This does not approve CRM clearance or outreach.
- Company navigation connects changes, product-fit evidence, people, emails and history. Opening the weekly planner from a company carries its search context but does not auto-select it.
- The two partial filing indexes previously verified during Codespace recovery are now in versioned schema initialization. This preserves the fix for nonempty-filing lookups; the first creation on the large live database can take time.
- Unknown `/api` requests return JSON 404 instead of the frontend HTML fallback when serving the built app, avoiding false-positive integration health checks.

## How useful insights should be assembled

Use the Companies House number as the entity join key, preserving leading zeros and Scottish/other supported prefixes. Retain group relationships separately; never merge parent and subsidiary histories just because their names resemble each other.

A useful company dossier should explain:

1. **Change:** the filing/event, observed date, effective date and primary evidence URL.
2. **Context:** legal entity, turnover provenance, parent/jurisdiction and relevant transaction relationships.
3. **Commercial hypothesis:** a specific product motion supported by operating evidence. Overseas control is an investigation lead, not proof of recurring FX exposure.
4. **Timing:** why the event may make an already suitable company receptive now.
5. **People:** verified role, appointment date, company and identity confidence. A CH director is not automatically a CFO. An applicant at a past customer is not automatically the same person as a newly appointed officer, or the original implementation owner.
6. **Action:** outstanding evidence checks, CRM clearance, then approved contacts and channel allocation.

Facts, commercial inferences and missing information must remain separate. Do not pass an unreviewed M&A hypothesis into email copy as an established acquisition.

## Audit findings and prioritised follow-up

| Finding in current code | Implication | Next improvement |
| --- | --- | --- |
| `server.js` is approximately 14,000 lines and mixes reads, writes, analysis and integration handlers | Difficult to test independently or predict read-side effects | Continue extracting modules as in this monitoring integration; avoid a whole-app rewrite |
| `computeProductFitGate` is a multiplier of .35/.6/.8/1, not a binary eligibility gate | The written product-fit principle is stronger than some legacy ranking paths | Calibrate a shared eligibility decision using reviewed examples; no weight change in this PR |
| Some legacy company GETs and shortlist reads enqueue analysis; fallback detail score can use turnover alone | Browsing can trigger work and make thin evidence look scored | New monitoring path avoids both. Separate all remaining read and job-trigger paths in a dedicated change |
| Existing SQLite and Supabase contain overlapping company facts but different histories | Blind migration could overwrite better facts or lose notes/suppression | Keep field-level provenance, explicit conflicts, canonical company-number mapping and rollback checks before migration |
| `WeeklyOutreach` keeps contact selection/CRM clearance in React state | Refresh/navigation loses draft plans; approval is not yet a durable company-level ledger | Persist draft plans and dated CRM clearance, then enforce the same server-side decision across discovery, export and enrolment |
| Unknown turnover can reach legacy planner previews; client-supplied approval data is used in older routes | UI checks alone cannot be the final outreach gate | Consolidate authoritative eligibility and suppression at every send/export boundary |
| We-Connect webhook records stop signals but generic events do not enforce cross-channel cancellation everywhere | A recorded reply is not the same as stopping all future actions | Shared contact stop-state and idempotent executor before unattended multi-channel operation |
| Customer/applicant matching and research exist in Supabase but were absent from the published frontend | Relevant enquiry lines were effectively hidden | Now visible in the same workspace; next add verified person/appointment linkage and confidence review |
| Analysis and email code already embody detailed product rules and v7 QC | Replacing them with a generic LLM prompt would lose the original reasoning | Preserve application-owned scoring and v7 QC; reconcile Sophie's Gem instructions when available |
| Both Supabase and GitHub have collection/scheduling code | Turning everything on can duplicate requests and jobs | Supabase owns monitoring; explicitly assign any remaining accounts-analysis jobs to one scheduler |

## Hosting and release

**Recommended initial home:** deploy this GitHub application's built frontend and Node backend under one private HTTPS origin on a persistent Node host with a durable disk for the existing SQLite database. The backend already serves `frontend/dist`. GitHub remains the source of truth and CI/deployment trigger. Supabase continues collecting independently.

The existing Sites app runs on Cloudflare Workers; the GitHub backend uses native `better-sqlite3`, a large disk-backed filing database, file imports and background jobs. It cannot be copied unchanged into that Worker. Do not replace it with iframe tabs or proxy it through a sleeping Codespace. A later Postgres/object-storage migration can remove the disk requirement after data reconciliation and regression testing.

No permanent Node hosting account has been established in this session. The forwarded Codespace is a development runtime, not the final always-on integration host. This PR prepares the combined app; it does not claim to migrate the live SQLite database, update the running Codespace, or replace the published Site.

Release sequence:

1. Review this GitHub PR and resolve the two independently reproduced baseline API failures before treating CI as green.
2. Preserve/back up the existing Codespace's uncommitted work and database before combining its older working branch with main. Do not overwrite its database or silently discard its Gemini/YAMM work.
3. Configure one of the supported backend source connections in the selected runtime. GitHub Actions secrets alone are not runtime environment variables. Never copy secrets into the React bundle or commit them.
4. Verify the four monitoring views from that runtime, company-number deduplication, existing notes/scores, session-protected review and a small research handoff. Use mocked/isolated writes for automated tests.
5. Configure authenticated persistent hosting, restore the verified live database, and make that origin the everyday app. Keep the existing private dashboard available until parity is accepted.
6. Persist planning/approval state and reconcile reply stops before enabling unattended outreach. No outreach is sent as part of this integration.

## Verification record

- Current Supabase RPCs inspected and called read-only; no alert was qualified, no candidate enrolled and no provider credits consumed.
- Frontend production build and all 84 frontend tests passed; final focused rerun results are recorded in the PR.
- Full backend suite: 243 passed, two Gemini handoff tests failed. Both failures were independently reproduced by running the original API suite on unchanged main (`e30d2a6`). They concern handoff-request pagination/status filtering and retry-429 cooldown handling. Additional focused integration tests were added after that full run.
- Focused tests exercise source errors, leading-zero identifiers, exact-company matching, optimistic concurrency, owner attribution, idempotent handoff, preservation of existing facts/state, and promotion gates.
- Cloud browser could not open this environment's local preview (`ERR_BLOCKED_BY_CLIENT`). DOM interaction tests and the production build were used; no visual browser verification is claimed.
