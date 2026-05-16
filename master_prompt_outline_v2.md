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
