# Go-Live Readiness Checklist

Last updated: 2026-06-28

## Objective

Use this checklist to validate the system before wiring paid API keys and enabling production traffic.

## Phase 1: Requirements and Quality Sweep (No Paid Keys)

### A. Source-of-truth alignment

- [ ] Scoring logic still follows `master_prompt_outline_v2.md` and `revolut_prospecting_app_supplementary_context.md`.
- [ ] Email generation still follows `prompts/email-generation-v7.txt` and `docs/email-generation-architecture-v7.md`.
- [ ] External signal mapping still follows `docs/signal-connectors-contract.md`.
- [ ] Gemini handoff schema and optional summary flags still match `docs/gemini-handoff-contract.md`.

### B. Core CI-equivalent gates

Run:

```bash
(cd /workspaces/onemonetry/mock-backend && npm test)
(cd /workspaces/onemonetry/frontend && npm run build && npm test)
(cd /workspaces/onemonetry && npm run smoke:e2e:quick)
```

Current baseline (2026-06-28):

- Backend tests: PASS (`184 passed, 0 failed`)
- Frontend build: PASS
- Frontend tests: PASS (`77 passed, 0 failed`)
- Quick smoke e2e: PASS (`6 passed, 0 failed`)

### C. Contract-critical integration checks

- [ ] `GET /api/integrations/status` includes connector readiness and env template entries.
- [ ] `POST /api/signals/sync/:number` supports connector filters and returns deterministic envelope updates.
- [ ] Gemini handoff summary include flags return expected shapes and strict invalid-flag errors.
- [ ] YAMM export safeguards still enforce manual review gate.

### D. Operational safety checks

- [ ] Lightweight runtime (`start:backend:light`) still supports smoke/API validation.
- [ ] Required CI checks are branch-protection gates on `main`.
- [ ] Alerting/log capture paths are known (`/tmp/onemonetry-backend.log`, `/tmp/onemonetry-frontend.log`).

## Phase 2: Controlled API Key Wiring (Staging First)

### E. Key setup order

1. Configure one connector at a time in staging (never commit keys).
2. Start with low-risk, high-value connectors used in scoring and evidence display.
3. Confirm connector status flips to configured in `GET /api/integrations/status`.

### F. Connector validation loop (per connector)

1. Run targeted sync:

```bash
curl -X POST "http://localhost:8000/api/signals/sync/<company_number>" \
  -H "Content-Type: application/json" \
  -d '{"connectors":["<connector_id>"]}'
```

2. Verify envelope writes (`ownership_*`, `hiring_signals_*`, `reputation_*`, `marketing_intelligence_*`, `tech_stack_*`).
3. Verify scoring and shortlist remain explainable and stable after enrichment.
4. Record latency, error rate, and payload quality before enabling next connector.

### G. Promotion criteria

- [ ] No failing backend/frontend/smoke gates.
- [ ] Connector error rates acceptable under expected load.
- [ ] Ranking and email outputs still align with strategy intent.
- [ ] Manual review and send safeguards unchanged.

## Suggested Immediate Next Step

Wire API keys in staging in this order:

1. `PROSPEO` / `PHANTOMBUSTER` / `CURSOR` (new connector parity covered)
2. `SIMILARWEB` / `BUILTWITH`
3. `ADZUNA` / `CRUNCHBASE` / `CLEARBIT`

After each step, re-run the Phase 1.B command block.
