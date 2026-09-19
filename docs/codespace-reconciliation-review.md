# Preserved Codespace code: reconciliation review

Review date: 2026-09-19. This is a static review of the uploaded changed-file bundle, not a completed migration or a full audit of the old application. No legacy scripts were executed, integrations called or live data changed.

## Evidence and current blocker

- Saved source commit: `d37e65e2442d1ed5c2466a2072041db96956860c`.
- Current main / prepared target: `91900a94cc92f00961d3e11e98b982cd58d383d5`.
- Upload contains 44 final source files and 48 saved Git-status entries.
- GitHub cannot supply the source commit (`upload-pack: not our ref`). Therefore a diff against current main combines older committed branch differences with uncommitted edits. It must not be represented as the user's uncommitted patch.
- The uploaded server has 22,064 lines versus 13,770 on current main. Replacing main's server would remove newer monitoring and outreach routes and safeguards.
- The changed-file export omitted unchanged dependencies. This is a limitation of the initial export helper, not a problem with the user's upload.

The corrected exporter supports `--include-baseline`: it reads original committed code from the already-prepared candidate Git objects and all allowlisted final code from the preserved archive. It creates a small filtered ZIP without another database or Git-history copy. See [codespace-upgrade.md](codespace-upgrade.md).

## Confirmed missing dependencies

These imports are absent from both the upload and current main:

- `frontend/pages/CustomGemHandoff.jsx` (extension inferred from the extensionless import).
- `frontend/utils/customGemYammBasket` (extensionless import).
- `mock-backend/crypto-exposure.js`.
- `mock-backend/company-presence.js`.
- `mock-backend/yamm-bridge-apps-script.js`.

The uploaded package scripts also reference unavailable files:

- `scripts/backfill-scoring-coverage.mjs`.
- `scripts/backfill-filing-text-from-accounts.mjs`.
- `scripts/latest-filing-turnover-backfill-service.sh`.
- `scripts/sync-filings-for-monitor-list.mjs`.
- `scripts/prospeo-likely-match-review.mjs`.
- `scripts/endole-name-reconciliation.mjs`.
- `scripts/endole-retry-backoff-pass.mjs`.

Named exports from unchanged modules also need comparison against the original baseline; the uploaded server expects `prepareYammBodyForGmail` from `yamm-export.js`, for example. Resolving these direct missing imports alone does not establish that the old app builds.

## Changes that need reconciliation

| Area | Observed behavior | Required treatment |
| --- | --- | --- |
| Navigation | Old App adds Active Opportunities, Matched Prospects and Custom Gem but removes current Monitoring and Weekly Outreach views. Matched count is hardcoded to 86. | Preserve current views and company-detail outreach links. Integrate recovered views into the same app; derive counts from data. |
| Background jobs | Old devcontainer starts the filing watchdog automatically. `stop:dev` stops app ports but not the watchdog/service. The watchdog can restart the backfill after it exits. | Make backfill an explicit managed job, expose status, stop watchdog before worker, and keep candidate startup free of automatic backfill. This explains why stopping the app alone did not stabilize the backup. |
| Matched prospects | Endpoint reads a named export CSV and five dated July retry CSVs. It splits rows on commas. The UI does not check HTTP status before parsing. | Preserve source provenance; replace dated-file assumptions with a persistent reviewed import. Handle CSV quoting and missing-file/error states. Matching must not itself qualify a company for outreach. |
| Discovery import | Applying selected rows sets `crm_checked: true`, `selected_for_sequence: true`, and availability based on email presence. | Selection must not stand in for explicit CRM clearance or re-enable an existing stopped contact. Route through current selection/clearance/suppression rules. |
| YAMM approval helper | `build_send_approved_yamm.py` checks name/company scope and email status in `prospect_workspace`, then emits approved CSV/XLSX. That approval loop does not consult current contact stops or company eligibility. | Reuse current export gates and recheck reply stops at export. Preserve reviewed content; do not call this standalone output current send approval. |
| Weekly acceptance | Old weekly-workspace decision route defaults `trigger_enrichment` to true when accepting a company. | Separate selection from paid/provider enrichment and use the current provider flow with explicit controls. |
| Turnover | Old UI still says “Previously £15M+, now lower”; old weekly turnover bands include under-15 and 15–25. | Use the agreed £30m prospecting floor. Sub-threshold records may be researched but must remain outside qualified outreach. Preserve product-fit gates. |
| Role filter | The ecommerce regex uses truncated words followed by a word boundary, so it misses ordinary full-word forms. Unknown roles default to keep. | Correct matching with representative role tests and make uncertainty reviewable; do not remove saved contacts retroactively. |
| Storage/runtime | Legacy scripts include absolute Codespace paths, dated batch defaults and direct database writes. | Use explicit paths and stopped-copy migration; consolidate reusable behavior into app services. Do not run historical batches during startup or upgrade. |

## Inventory and intended disposition

All 44 uploaded files are accounted for below. Grouping is a migration inventory, not a claim that every line has been audited.

| Files | Disposition |
| --- | --- |
| `.devcontainer/devcontainer.json`, `package.json`, `start.sh`, `scripts/status-dev.sh`, `scripts/stop-dev.sh` | Reconcile port/runtime improvements, remove automatic unmanaged work, retain current runtime safety. |
| `frontend/App.jsx`, `frontend/pages/Home.jsx`, `frontend/pages/Shortlist.jsx`, `frontend/styles.css` | Selectively integrate with current navigation and planner; do not replace current files wholesale. |
| `frontend/pages/ActiveOpportunities.jsx` | Preserve opportunity visibility and intentional state transitions, subject to current authorization and stop rules. |
| `frontend/pages/MatchedProspects.jsx` | Recover as reviewed research intake, replacing dated CSV/count assumptions. |
| `frontend/components/ProspectWorkspacePanel.jsx` | Preserve useful selection and content-review work after recovering its basket dependency; connect to authoritative server draft/clearance. |
| `frontend/__tests__/ShortlistExportModal.test.jsx` | Port behavior tests alongside reconciled UI; preserve newer outreach tests. |
| `mock-backend/server.js`, `mock-backend/db.js`, `mock-backend/companies-house.js`, `mock-backend/email-sequences.js` | Require original baseline, dependency recovery and selective three-way reconciliation. Retain current monitoring, UTC, reliability, suppression and export behavior. |
| `mock-backend/__tests__/api.test.js`, `mock-backend/__tests__/signal-connectors.test.js` | Port applicable tests; run backend tests under the existing local-only network guard. |
| `mock-backend/role-relevance-filter.js` | Reconcile role classification separately from approval and suppression. |
| `docs/discovery-inbox-workflow.md`, `docs/phantombuster-pilot-shortlist-52.md` | Preserve historical rationale; rewrite active instructions for the current Apollo/review workflow. |
| `scripts/backfill-ready-filing-coverage.mjs`, `scripts/ready-filing-coverage-service.sh`, `scripts/ready-filing-coverage-watchdog.sh` | Recover as explicit managed maintenance after dependency/schema review; not startup hooks. |
| `scripts/discovery-inbox.mjs`, `scripts/import-prospeo-people-export.mjs`, `scripts/normalize-phantombuster-people.mjs`, `scripts/build-crm-reconciliation-pack.mjs` | Preserve import/reconciliation utility; normalize identity and require explicit CRM clearance, respecting existing stops. |
| `scripts/build-final-yamm-merge.py`, `scripts/build-leads-reference-file.py`, `scripts/build_send_approved_yamm.py`, `scripts/verify_yamm_stage_batch.py` | Review export transformations and move active outputs behind current eligibility, review and reply-stop gates. |
| `scripts/build-manual-gem-handoff-bundle.mjs`, `scripts/build-manual-gem-handoff-pdfs-from-applied.mjs`, `scripts/generate-gemini-yamm-batch.mjs`, `scripts/run-gemini-yamm-reliable.sh` | Preserve Gem content handoff and resumability; recover dependencies and consolidate with current generation/review services. |
| `scripts/create-noemail-sequences-20260714.mjs`, `scripts/generate-advanced-sequences-20260714.mjs`, `scripts/generate-gemini-sequences-20260714.mjs`, `scripts/generate-missing-sequences-20260714.mjs`, `scripts/generate-prospeo-gemini-sequences-20260714.mjs`, `scripts/resume-sequence-batch-20260714.mjs`, `scripts/run-sequence-batch-20260714.mjs` | Treat as historical batch tools. Extract reusable logic only after review; do not rerun dated batches. |

The saved status also lists `CH-00651051-dossier-for-gem.json`, `PROSPEO_SEARCH_PERSON_DEMO.md`, `PROSPEO_UI_EXAMPLE.html` and `works/`, which the filtered upload omitted. They remain in the full private backup; their contents and any required migration have not been reviewed.

## Integration and validation sequence

1. Obtain the corrected baseline/source bundle and establish exact differences against both original HEAD and current main.
2. Preserve current Signals & Research, Apollo, We-Connect handoff, authoritative weekly drafts, explicit CRM clearance, £30m/product-fit eligibility, 90 automated slots plus 10 manual reserve, atomic reservations, ambiguous-handoff reconciliation and cross-channel reply stops.
3. Port reviewed legacy features in small coherent changes. Add schema migrations that preserve company identities, saved contacts, content, history and workflow state. Use isolated synthetic fixtures first.
4. Test on the separate copied database only after schema review. Reconcile historical stop/approval state; never assume the snapshot authorizes outreach.
5. Validate the unified UI/build and guarded backend tests before a separately planned cutover. Keep the successful backup and original account ZIPs.

No application cutover is ready on the evidence currently available. The original source baseline and unchanged dependencies are the immediate prerequisite.
