# Master Prompt Outline v2 for the Revolut Prospecting App

## 1. Purpose

This app is designed to help a Revolut Business Mid-Market account executive identify and prioritise the best companies to contact each week. It should convert a very large universe of companies into a manageable shortlist by scoring them on product fit, commercial relevance, timing, competitor context, and response likelihood.

The score should represent prospecting priority, not company quality in the abstract. A high score means the account is likely to be a good use of time now because it is relevant, commercially meaningful, and actionable.

## 2. Core output

The app should produce a weekly workspace, with the top 100 companies ranked by priority. It should also maintain historical weekly reports, current/live outreach state, and company-level history so the user can see how accounts moved through the system over time.

The app should show a readable explanation of why each company scored where it did, including evidence snippets and the product motion or motions most relevant to that account.

## 3. Guiding principles

- Product fit must gate everything else.
- The model should be explainable and auditable.
- Response propensity should adjust queue order, not manufacture fit.
- Merchant-spend data should be a conditional boost, not a front-door fit criterion.
- Competitor context should refine prioritisation and explanation, not replace core logic.
- The app should preserve workflow history and not behave like a one-off ranking list.

## 4. Scoring architecture

The app should use a layered scoring model rather than a single opaque score. Suggested layers are:

- Product fit.
- Commercial value.
- Pain strength.
- Urgency or response propensity.
- Competitor context.
- Proprietary boosts.
- Workflow suppression or exclusion.

The final score should be computed in application logic from those layers. The LLM, if used, should extract evidence and score rubric criteria, but not own the total score by itself.

## 5. Product fit layer

Product fit is the primary gate. If a company is not meaningfully relevant to a product motion, it should not be pushed up the list by other factors.

The app should assess fit separately for each motion, because each product has different evidence patterns and commercial logic. The product set currently includes:

- Monthly custom plans.
- FX forwards and FX / multicurrency.
- Corporate cards.
- Spend management.
- API integrations.
- Merchant acquiring / payment acceptance.
- Revolut Pay.

Each product motion should have its own rubric with explicit indicators of strong, medium, weak, and absent fit.

## 6. Segment calibration

The app should be calibrated primarily for Mid-Market, but the underlying rubric should still work across SMB and Enterprise where relevant. Mid-Market means stronger operational complexity, more senior buyers, more meaningful treasury or finance behaviour, and more commercially valuable opportunities than a basic SMB model.

The segment should influence weighting, thresholds, evidence expectations, and outreach framing, but should not erase universal logic that applies to multiple segments.

## 7. Pain and relevance

The app should look for observable proxies of pain rather than abstract guesses about company intent. For example, relevant pain can include international exposure, spend complexity, payment acceptance needs, fragmented systems, treasury strain, or multi-entity structure.

Pain should be broken into product-specific evidence signals. The LLM should extract those signals from annual reports, filings, news, and other source material, then score them against a rubric.

## 8. Response propensity

Response propensity is a meta-layer, not a product motion. It should estimate whether an account is likely to respond to outreach now, based on warmth, recency, readiness, prior activity, or similar signals.

This score should be used to reorder already-qualified accounts and improve weekly queue management. It should not elevate weak-fit accounts into the top tier.

## 9. Merchant-spend boost

Merchant-spend data should act as a conditional proprietary boost for merchant-related motions only, especially acquiring, Revolut Pay, and Open Banking. It is valuable because it can quantify actual wallet opportunity and make outreach more specific.

However, it should only be used once merchant relevance is already established. It should not create fit where fit is missing.

## 10. Competitor context

Competitor analysis should be included, but only in a controlled way. The app should capture whether the incumbent is weak, strong, fragmented, expensive, slow, or lightly embedded, because that affects winnability and outreach angle.

Competitor context should help explain why an account is or is not attractive, but it should not dominate the core fit logic.

## 11. Exclusions and suppression

The app should exclude or suppress accounts that are not eligible, including prohibited industries, already closed-won accounts, or accounts that should not be prospecting targets for other operational reasons.

It should also support waiting or review states for accounts held by other account executives or temporarily unavailable because of CRM ownership or closed-lost timing.

## 12. Workflow states

The app should support company states such as:

- New candidate.
- Shortlisted.
- Selected for outreach.
- In cadence.
- Active opportunity.
- Closed won.
- Closed lost.
- Revisit later.
- Held for ownership review.

This state history should persist across weekly reports so the app behaves like a prospecting memory system rather than a temporary ranking list.

## 13. Weekly report behavior

The app should generate a weekly report on a Monday showing the top 100 accounts for the week. The report should include the selected accounts, the ones ruled out manually, the ones already in cadences, and the ones returning from previous weeks.

Each weekly report should be stored and viewable later, with the ability to compare the original weekly shortlist against current/live status.

## 14. Company detail view

Each company page should show:

- Company name.
- Company number with link to Companies House.
- Turnover.
- Employee count.
- Industry.
- Product fit score.
- Readable fit explanation.
- Evidence snippets.
- Latest annual report link or preview.
- Competitors mentioned.
- Current and previous cadence or communication history.
- Current workflow status.
- Any stakeholder mapping or contact data available.

## 15. Home screen

The home screen should act as the main live workspace. It should show current active prospects, their scores, their status, and enough summary information for the user to work from the page without having to drill into every company.

## 16. Ranking logic

Ranking should reflect the best prospecting opportunity for that week, not just the biggest company or the warmest account. Strong product fit, strong pains, useful proprietary signals, and good timing should all matter.

The ranking should be deterministic and easy to tune. Small changes in weights should not completely break the list.

## 17. LLM role

The LLM should read the source material, extract structured evidence, and apply rubric-based judgments for the criteria it can see. It should also generate human-readable explanations for why the account scored the way it did.

The application should own the final weighting, gating, sorting, and state management.

## 18. Open questions

Some details still need tuning, including exact weights, exact thresholds, exact cadence behaviour, and exact handling of ownership conflicts or revisit timing.

Those gaps are acceptable at this stage. The important thing is to preserve the layered structure so future changes do not flatten the design.

## 19. Execution-ready implementation checklist (MVP build order)

### Phase 1 — Core data model and workflow-state backbone

1. **Exact tasks in build order**
   1. Define canonical entities and enums from this outline: `Company`, `Evidence`, `MotionScore`, `AccountScore`, `WorkflowState`, `WeeklyReport`.
   2. Define workflow-state transition rules for: new candidate, shortlisted, selected for outreach, in cadence, active opportunity, closed won, closed lost, revisit later, held for ownership review.
   3. Implement persistence schema and migration for company profile, scoring snapshots, and state history.
   4. Add seed loader for a small MVP mock universe.
   5. Add read/write APIs for company records and state transitions.
2. **File-by-file purpose**
   - `README.md`: keep project-level scope and point implementers to this section as implementation sequence.
   - `master_prompt_outline_v2.md`: source-of-truth structure for data entities, states, and sequence.
   - `revolut_prospecting_app_supplementary_context.md`: rationale for why layered entities and state continuity are required.
3. **Input/output contract for each API**
   - `POST /companies/import`
     - Input: list of companies with minimum identity fields.
     - Output: `{ importedCount, skippedCount, errors[] }`.
   - `GET /companies/{companyId}`
     - Input: path `companyId`.
     - Output: company profile plus latest workflow state and latest score summary if present.
   - `POST /companies/{companyId}/state-transition`
     - Input: `{ fromState, toState, reason, actor, occurredAt }`.
     - Output: `{ companyId, previousState, newState, transitionRecorded: true }`.
4. **Mock data shape**
   - `Company`: `{ companyId, name, companyNumber, turnover, employeeCount, industry, segment }`.
   - `WorkflowHistory`: `{ companyId, state, changedAt, reason, actor }[]`.
   - Include examples covering eligible, prohibited, closed won, and held-for-ownership records.
5. **Definition of done**
   - Data model exists for all required entities and states in sections 11–14.
   - All state changes are persisted with timestamped history.
   - Companies can be imported, fetched, and transitioned without manual DB edits.
6. **Test cases**
   - Valid import creates records and rejects malformed records.
   - Invalid state transition is blocked (for example closed won back to new candidate without explicit reopen rule).
   - Workflow history appends, never overwrites prior transitions.
7. **Risks or ambiguities from the spec**
   - Transition rules are implied but not fully enumerated; implementation needs explicit state-machine policy.
   - Ownership-review timing and release logic are intentionally open (section 18).

### Phase 2 — Evidence extraction and motion-level scoring

1. **Exact tasks in build order**
   1. Define rubric schema per product motion (plans, FX/forwards, cards, spend management, API, acquiring, Revolut Pay).
   2. Implement evidence-ingestion contract from source documents/news/filings into normalized snippets.
   3. Implement motion-level fit scoring with confidence and evidence references.
   4. Enforce product-fit gate before downstream prioritisation.
   5. Store per-motion score snapshots for auditability.
2. **File-by-file purpose**
   - `master_prompt_outline_v2.md`: rubric boundaries, gating rule, and motion list (sections 5, 7, 17).
   - `revolut_prospecting_app_supplementary_context.md`: motion-by-motion nuance and confidence handling rationale.
   - `README.md`: no new behavior; remains orientation to source-of-truth files.
3. **Input/output contract for each API**
   - `POST /evidence/extract`
     - Input: `{ companyId, sourceType, sourceUrlOrText, extractedAt }`.
     - Output: `{ companyId, evidenceItems:[{ evidenceId, motionTags[], snippet, sourceRef, confidence }] }`.
   - `POST /scores/motion-fit`
     - Input: `{ companyId, evidenceIds[] }`.
     - Output: `{ companyId, motionScores:[{ motion, fitLevel, fitScore, confidence, evidenceIds[] }], fitGatePassed }`.
   - `GET /scores/{companyId}/motion-fit/latest`
     - Output: latest motion-fit snapshot with timestamp.
4. **Mock data shape**
   - `EvidenceItem`: `{ evidenceId, companyId, sourceType, sourceRef, snippet, motionTags, extractedSignals, confidence }`.
   - `MotionScore`: `{ motion, fitLevel: strong|medium|weak|absent, fitScore, confidence, explanation, evidenceIds }`.
5. **Definition of done**
   - Every scored company has per-motion fit scores and explanation data.
   - Weak/absent fit cannot pass gate into top-priority ranking.
   - Snapshot history allows “why did this score change” comparisons.
6. **Test cases**
   - Strong FX evidence yields stronger FX than forwards when hedgeable exposure is missing.
   - Merchant-spend-only evidence does not create merchant fit without base relevance.
   - Missing evidence lowers confidence instead of forcing high-confidence conclusions.
7. **Risks or ambiguities from the spec**
   - Rubric thresholds (strong/medium/weak numeric boundaries) are not finalized.
   - Source-trust weighting for extracted evidence is not explicitly defined.

### Phase 3 — Layered final scoring and prioritisation

1. **Exact tasks in build order**
   1. Implement score layers: product fit, commercial value, pain strength, response propensity, competitor context, proprietary boosts, workflow suppression.
   2. Implement deterministic weighting and final-score composition in app logic (not LLM).
   3. Apply segment calibration overlays with Mid-Market default.
   4. Apply conditional merchant-spend boost only for merchant-relevant motions after fit gate.
   5. Persist full score breakdown and explanation text.
2. **File-by-file purpose**
   - `master_prompt_outline_v2.md`: authoritative layering and ranking constraints (sections 4, 6, 8–10, 16–17).
   - `revolut_prospecting_app_supplementary_context.md`: rationale for commercial layer boundaries and meta-layer response propensity.
   - `README.md`: continue as high-level project framing.
3. **Input/output contract for each API**
   - `POST /scores/finalize`
     - Input: `{ companyId, motionFitSnapshotId, commercialInputs, painInputs, propensityInputs, competitorInputs, proprietaryInputs, segment }`.
     - Output: `{ companyId, finalScore, layerBreakdown, rankingEligible, reasons[] }`.
   - `GET /scores/{companyId}/final/latest`
     - Output: latest final score with all layer components and confidence.
   - `POST /rankings/recompute`
     - Input: `{ asOfDate }`.
     - Output: `{ rankedCompanies:[{ companyId, finalScore, rank, rankingEligible }] }`.
4. **Mock data shape**
   - `LayerBreakdown`: `{ productFit, commercialValue, painStrength, responsePropensity, competitorContext, proprietaryBoost, workflowSuppression }`.
   - `FinalScoreRecord`: `{ companyId, finalScore, rankingEligible, fitGatePassed, segment, layerBreakdown, generatedAt }`.
5. **Definition of done**
   - Final score is deterministic and reproducible from saved inputs.
   - Ranking excludes ineligible/suppressed states and weak-fit records.
   - Score explanation maps directly to evidence and layer math.
6. **Test cases**
   - Warm but weak-fit account remains below fit-qualified accounts.
   - Closed-won or prohibited account is suppressed regardless of high raw score.
   - Recompute on same inputs returns identical ranking order.
7. **Risks or ambiguities from the spec**
   - Exact commercial weighting by motion remains an open tuning choice.
   - Competitor-context scoring rubric can drift without strict definitions of “weak/strong incumbent.”

### Phase 4 — Weekly report generation and live workspace

1. **Exact tasks in build order**
   1. Implement Monday weekly-report job selecting top 100 ranking-eligible accounts.
   2. Persist weekly snapshot including selected, manually ruled-out, in-cadence, and returning accounts.
   3. Build live workspace query that shows current status versus weekly snapshot.
   4. Implement company-detail retrieval with required fields and score explanation.
   5. Add report-to-live comparison view contract for historical auditing.
2. **File-by-file purpose**
   - `master_prompt_outline_v2.md`: definitive weekly behavior and company/home-screen requirements (sections 13–15).
   - `revolut_prospecting_app_supplementary_context.md`: continuity rationale (“prospecting memory system”).
   - `README.md`: keep repository navigation and intended usage.
3. **Input/output contract for each API**
   - `POST /reports/weekly/generate`
     - Input: `{ weekOfDate }`.
     - Output: `{ reportId, generatedAt, top100Count, selectedCount, ruledOutCount, inCadenceCount, returningCount }`.
   - `GET /reports/weekly/{reportId}`
     - Output: report snapshot with ordered shortlist and per-company score/explanation summary.
   - `GET /workspace/live`
     - Input (optional filters): `{ state[], segment[], minScore }`.
     - Output: current active prospects with latest score and state.
   - `GET /companies/{companyId}/detail`
     - Output: required company detail fields from section 14 including evidence snippets and communication history.
4. **Mock data shape**
   - `WeeklyReport`: `{ reportId, weekOfDate, generatedAt, rankedAccounts:[{ companyId, rank, finalScore, stateAtSnapshot, includedReason }] }`.
   - `WorkspaceRow`: `{ companyId, companyName, finalScore, currentState, topMotion, confidence, lastUpdatedAt }`.
5. **Definition of done**
   - Monday run generates and stores a retrievable top-100 snapshot.
   - Historical report remains immutable while live workspace reflects current state.
   - Company detail endpoint returns all fields listed in section 14 (or explicit null when unknown).
6. **Test cases**
   - Weekly generation on Monday stores exactly one report per requested week.
   - Manual ruled-out accounts appear in report metadata but are excluded from selected outreach list.
   - Company moved from shortlisted to in-cadence after report appears correctly in live view while historical report remains unchanged.
7. **Risks or ambiguities from the spec**
   - Timezone definition for “Monday” is not explicitly stated.
   - Manual ruled-out semantics and actor permissions are not fully defined.

### Phase 5 — MVP hardening, tuning hooks, and release criteria

1. **Exact tasks in build order**
   1. Add configuration points for weights/thresholds without changing architecture.
   2. Add audit logging around score recomputation and weekly report generation.
   3. Execute end-to-end dry run on mock data for at least two weekly cycles.
   4. Validate unresolved open-question defaults and document temporary decisions.
   5. Freeze MVP scope and publish release readiness checklist.
2. **File-by-file purpose**
   - `master_prompt_outline_v2.md`: preserve architectural constraints while allowing tuning.
   - `revolut_prospecting_app_supplementary_context.md`: maintain rationale so tuning does not flatten model logic.
   - `README.md`: implementation handoff entry point.
3. **Input/output contract for each API**
   - No net-new product APIs in this phase.
   - Reuse existing APIs from phases 1–4 to run replay and tuning validation:
     - `POST /rankings/recompute`
     - `POST /reports/weekly/generate`
     - `GET /reports/weekly/{reportId}`
4. **Mock data shape**
   - `ReplayScenario`: `{ runId, weekOfDate, inputSnapshotRefs, expectedTop100CompanyIds[] }`.
   - `TuningSnapshot`: `{ weightsByLayer, thresholdsByMotion, generatedReportId, top100CompanyIds[] }`.
5. **Definition of done**
   - MVP can run end-to-end from import to weekly report to live state tracking.
   - Tuning can be tested by config changes and replaying existing ranking/report flows.
   - Known ambiguities are captured with explicit default behavior.
6. **Test cases**
   - Weight/threshold change updates ranking outputs only after explicit recompute.
   - Replay run produces auditable before/after rank deltas for changed accounts.
   - Two-week replay preserves state continuity and suppression behavior.
7. **Risks or ambiguities from the spec**
   - Open questions in section 18 may materially change tuning defaults.
   - Data freshness and source availability expectations are not yet defined.
