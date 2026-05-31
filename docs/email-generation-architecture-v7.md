# Email Generation Architecture v7
## Information-Rich Sequence Design (First-Use Focus)

## Core Paradigm
This system is designed for information abundance, not information scarcity.
Traditional cold cadences guess relevance across multiple angles.
Our Research Dossier identifies the strongest angle up front, so the sequence builds conviction on that angle.

## Sequence Configuration
- 4 substantive emails + up to 2 brief nudges over 14 days.
- Default blueprint by tier:
  - Tier A: proof, nudge 1, depth, nudge 2, provocation, close.
  - Tier B: proof, nudge 1, depth, nudge 2, peer benchmark, close.
  - Tier C: proof, peer benchmark, close.
  - Tier D: no auto-generation; needs enrichment.
- Maximum 6 touches over 14 days.

## Caveats Applied
- Manual editing/review is required before YAMM export.
- Send-times never use exact :00, :15, :30, or :45 minutes.
- Replies and outcomes are operational logs only.
- No machine-learning or feedback-loop optimisation is applied to generation.

## Email Roles
| Position | Type | Word Count | Day | Send Condition |
|----------|------|-----------|-----|----------------|
| Email 1  | Proof          | 120-200 (Tier C: 100-150) | 0  | Always |
| Nudge 1  | Check-in       | 8-20                      | 3  | Email 1 opened, no reply |
| Email 2  | Depth          | 130-200                   | 6  | No reply yet |
| Nudge 2  | Check-in       | 8-20                      | 9  | Email 2 opened, no reply |
| Email 3  | Provocation or Peer Benchmark | 80-130 | 11 | No reply yet |
| Email 4  | Gracious Close | 40-70                     | 14 | No reply yet |

## Architecture
1. Scoring engine provides fit and confidence context.
2. Dossier-tier classifier determines A/B/C/D generation eligibility.
3. Email generator produces v7 role-specific steps.
4. QC validator checks forbidden phrases and baseline compliance.
5. Step review state is tracked per step.
6. YAMM export blocks when pending steps are not reviewed.
7. YAMM export computes schedule dates/times with off-minute guardrails.
8. Reply handling logs sequence state and pause/delay controls.
9. Audit metadata is retained with generated/exported content.

## Dossier Quality Tiers
- Tier A (rich): full sequence with provocation enabled.
- Tier B (moderate): full sequence with peer benchmark instead of provocation.
- Tier C (thin): reduced sequence, lower-confidence language, manual-review-first.
- Tier D (insufficient): no auto sequence; enrich data first.

## Manual Review Gate
- Every generated step requires review before export.
- Editing a step resets review state to pending.
- Export endpoints return a blocking response with pending step details when review is incomplete.

## Scheduling Policy
- Day offsets are absolute from export start date.
- Weekend sends shift to Monday.
- Role-aware default times are applied when a send time is not supplied.
- Any requested send time is normalized away from forbidden minute marks (:00/:15/:30/:45).

## Reply Handling
- Reply processing remains deterministic and operational.
- Positive/negative/OOO replies update sequence state.
- No learning or reinforcement updates are applied to generation behavior.

## Success Metrics
- Research density and voice fit quality remain validation targets.
- Export-readiness target: 100% reviewed pending steps.
- Scheduling compliance target: 100% sends avoid forbidden minute marks.

## Key Files
- mock-backend/email-generator.js
- mock-backend/email-sequences.js
- mock-backend/yamm-export.js
- mock-backend/server.js
- frontend/components/EmailSequencePanel.jsx
- mock-backend/__tests__/api.test.js
