# Supplementary Written Context v2 for the Revolut Prospecting App

This document is the narrative companion to the master outline. It explains the reasoning behind the app design so that the implementation prompt can be read with the right commercial and operational context. The goal is to help GitHub Copilot or any other builder understand not just what the app should do, but why the structure matters and which nuances should not be flattened.

## 1. What the app is for

The app is being designed to help a Revolut Business Mid-Market account executive decide which companies are most worth contacting now. It is not a generic research tool and it is not just a scoring toy. Its job is to turn a very large universe of UK companies into a weekly, manageable, explainable, action-oriented shortlist.

The score should represent prospecting priority. That means a company is high-scoring if it is relevant to one or more Revolut product motions, commercially meaningful, realistically actionable, and timely enough to justify effort this week. A lower score does not necessarily mean the company is bad; it may simply mean the fit is weaker, the evidence is thin, the timing is poor, or another account is a better use of time.

## 2. Why a layered model is needed

The problem is not a lack of companies. The problem is that the relevant evidence is scattered across filings, annual reports, websites, news, product usage clues, and internal proprietary signals. A useful system therefore needs several layers rather than one blended score.

Those layers should remain separate: product fit, commercial value, urgency or response propensity, competitor context, proprietary boosts, and workflow suppression. If these get collapsed into a single black box, the result becomes hard to trust, hard to tune, and hard to explain.

## 3. Why the LLM should not do everything

The LLM should be used to read messy documents and extract structured evidence. It should identify facts, infer likely signals, and score each rubric criterion against a locked definition. But the final score should be calculated by application logic, not by a one-shot AI opinion.

That separation matters because it keeps the model auditable. If the app produces a surprising ranking, you need to be able to see which evidence was used, which score was assigned to which criterion, and which modifier changed the final result.

## 4. Product fit is the gate

One of the most important design decisions is that product fit should gate everything else. If the account is not actually relevant to a product motion, then warmth, timing, competitor weakness, or commercial potential should not manufacture priority out of nowhere.

This is especially important because some signals are seductive. A warm account may look attractive even if it is a poor fit. A big company may look valuable even if the specific product angle is weak. The app should not confuse those things.

## 5. Motion-by-motion nuance

Each motion has its own shape and should therefore be scored differently.

FX and FX Forwards are the clearest example. A company may have international activity and therefore be a good FX account, but still not be a strong forwards account if recurring hedgeable exposure is missing. Those are related but not identical motions.

Cards and Spend Management are different again. In mid-market, the need is often broadly present, so the key question becomes whether Revolut has a strong wedge in the current workflow, team structure, or finance stack.

Merchant Acquiring is different because vague sector fit is not enough. The app should need evidence of payment acceptance relevance such as checkout flow, consumer-facing sales, retail presence, or processor pain.

API and Integrations depend on technical capability. A company can be strategically attractive but still not be a real API prospect if there is no sign that they can or want to consume integrations.

Plans and package expansion are often wrappers around stronger motions rather than the primary reason to prospect a brand-new account. They matter commercially, but they should not dominate the model on their own.

## 6. Why segment overlays matter

The app should work across SMB, Mid-Market, and Enterprise, but the scoring thresholds and outreach framing should change by segment. The base motion should stay the same, but the evidence threshold, buyer seniority, commercial importance, and practical sales motion should shift.

Mid-Market is the primary lens for this project, so the system should naturally lean toward more complex finance teams, higher-value transactions, more operational complexity, and stronger switching friction than an SMB model would assume. But the rubric should still keep enough universal logic to recognise strong signals in smaller or larger companies where relevant.

## 7. Commercial value matters, but should not take over

This is a commission-driven role, so commercial value absolutely matters. Some motions will generate much more GP than others, and the app should reflect that reality. However, it should not become a pure commission-maximiser that pushes weak-fit accounts to the top just because the product is lucrative.

The right approach is to use commercial value as a reordering layer within accounts that already clear the fit gate. That way the app still helps the user spend time on the best opportunities, but it does not distort the underlying logic.

## 8. Response propensity is a meta-layer

Response propensity should not be treated as a product motion. It is a meta-signal about whether the account is likely to respond if contacted now. That is different from whether the account is a fit.

A company can be a great fit but not very warm. Another can be quite warm but only weakly relevant. The app should keep those ideas separate and only use response propensity to adjust queue order among already qualified accounts.

## 9. Merchant-spend data should be conditional

The proprietary merchant-spend signal is extremely useful, but only in the right place. It should be used as a conditional boost for merchant-related motions such as acquiring, Revolut Pay, and Open Banking, and only after merchant relevance is already visible.

It should improve urgency, explainability, and commercial specificity. It should not create merchant fit where the underlying evidence is missing.

## 10. Competitor context adds realism

Competitor signals should be included because they help answer a practical sales question: how winnable is this scenario?

The app should not just ask whether a competitor exists. It should ask whether that competitor is weak, expensive, fragmented, slow, lightly used, or badly matched to the scenario. It should also ask whether the incumbent is deeply embedded and genuinely strong. That distinction matters more than simple name matching.

Competitor context should improve the explanation and the priority logic, but it should never replace product fit.

## 11. Workflow continuity matters

The app is not just a weekly list; it is a prospecting memory system. Accounts should move through states such as new candidate, shortlisted, selected for outreach, in cadence, active opportunity, closed won, closed lost, revisit later, or held for ownership review.

This matters because prospecting is cumulative. Accounts do not vanish after one week. They move, re-enter, pause, get released, or come back later. The app needs to preserve that history so the user can understand what happened and why the list changed.

## 12. Exclusions and held states

Not every account should be ranked. Prohibited industries, ineligible business types, already closed-won accounts, and accounts held by another AE may need to be suppressed or parked rather than shown as active priorities.

In some cases a waiting or ownership-review state is more appropriate than exclusion. That distinction matters because some accounts can become prospectable again later if the original opp closes out or ownership is released back to a holding state.

## 13. Confidence and uncertainty

The model should be comfortable saying that evidence is missing or uncertain. In this kind of system, unknown is often more honest than forcing a weak conclusion. If evidence is incomplete, the app should reduce confidence rather than pretend to know more than it does.

That confidence should show up on each motion score and on the final account score. Low-confidence cases can stay in the universe, but they should be marked clearly so the user knows what is solid and what is inferred.

## 14. Why the outline stays the source of truth

At this stage, the detailed outline should remain the main design spec. This narrative document exists to preserve nuance and explain the rationale, not to replace the structure.

The best workflow is: outline for structure, narrative for context, and later a shorter implementation prompt when the system is mature enough that compression will not strip out useful detail.

## 15. Current open questions

The remaining open questions are mostly tuning choices, not architectural gaps. These include exact weights, exact threshold rules, cadence timing, prohibited vertical configuration, revisit timing, and how much imported data or model output should be trusted directly.

That means the project is already far enough along to be implemented in a meaningful way. The next step is to keep enriching the motion-level rubrics and scoring thresholds while preserving the layered structure.

## 16. Final framing

The app should be treated as a prospecting operating system. Its value comes from combining evidence extraction, rubric-based scoring, commercial awareness, competitor awareness, workflow persistence, and explainable prioritisation into one coherent weekly decision tool.

If it is built that way, it should save substantial time and improve the quality of the accounts the user chooses to work.
