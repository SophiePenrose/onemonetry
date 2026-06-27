# Gemini Workspace Handoff Contract

## Purpose

Defines the contract between this app (source of ranking, evidence, and workflow state) and Gemini (Google Workspace bridge for Sheets and YAMM-ready output).

Design goals:

- Keep scoring deterministic in this app.
- Use Gemini for Workspace write actions and optional sequence generation/refinement.
- Preserve manual approval gate before send.
- Keep full audit trail for every handoff.

## Contract Version

- `contract_version`: `gemini-handoff-v1`
- Breaking changes must bump major version (for example `v2`).
- Non-breaking additions can be added as optional fields.

## High-Level Flow

1. App computes ranked companies and stakeholder targets.
2. App sends `handoff_request` payload to Gemini.
3. Gemini returns draft sequence content and YAMM rows.
4. Gemini writes rows to Google Sheet tab.
5. Human reviews and marks rows approved in Sheet.
6. Approved rows become send-eligible for YAMM.

## Request Schema (App -> Gemini)

```json
{
  "contract_version": "gemini-handoff-v1",
  "request_id": "req_2026-06-22T23-15-00Z_01",
  "generated_at": "2026-06-22T23:15:00.000Z",
  "workspace": {
    "org": "Revolut Business",
    "sheet_id": "1abc...",
    "sheet_tab": "queue_week_2026_w26",
    "timezone": "Europe/London"
  },
  "campaign": {
    "campaign_id": "cmp_mm_2026_w26",
    "campaign_name": "Mid-Market Priority Outreach",
    "sequence_template": "v7",
    "max_touches": 6,
    "approval_required": true
  },
  "ranked_companies": [
    {
      "rank": 1,
      "company_number": "01234567",
      "company_name": "Example Co Ltd",
      "segment": "Mid-Market",
      "composite_score": 0.8123,
      "priority_band": "P1",
      "score_breakdown": {
        "product_fit": 0.36,
        "commercial_value": 0.18,
        "pain_strength": 0.14,
        "urgency": 0.08,
        "competitor_context": 0.05
      },
      "insights": {
        "top_reasons": [
          "High product-fit for FX and cards",
          "Open finance/treasury roles indicate active pain",
          "Incumbent stack suggests switching opportunity"
        ],
        "connector_evidence": {
          "prospeo": {
            "freshness_days": 2,
            "signals": ["open_roles", "technologies", "monthly_web_traffic"]
          },
          "phantombuster": {
            "freshness_days": 4,
            "signals": ["linkedin_hiring_pattern", "headcount_change"]
          }
        }
      },
      "stakeholders": [
        {
          "person_id": "st_001",
          "full_name": "Jane Doe",
          "role": "Finance Director",
          "email": "",
          "email_status": "missing",
          "persona_bucket": "finance_director",
          "confidence": "medium"
        }
      ]
    }
  ],
  "generation_policy": {
    "provider": "gemini",
    "voice_profile": "sophie_v7",
    "forbidden_phrases_enforced": true,
    "max_steps_per_sequence": 6,
    "require_citations": true,
    "fail_closed_on_qc": true
  }
}
```

## Response Schema (Gemini -> App)

```json
{
  "contract_version": "gemini-handoff-v1",
  "request_id": "req_2026-06-22T23-15-00Z_01",
  "response_id": "resp_2026-06-22T23-15-05Z_01",
  "completed_at": "2026-06-22T23:15:05.000Z",
  "status": "ok",
  "sheet_write": {
    "sheet_id": "1abc...",
    "sheet_tab": "queue_week_2026_w26",
    "rows_written": 12,
    "range": "queue_week_2026_w26!A2:AZ13"
  },
  "sequence_outputs": [
    {
      "company_number": "01234567",
      "person_id": "st_001",
      "sequence_id": "seq_01234567_st_001",
      "qc": {
        "passed": true,
        "score": 0.91,
        "notes": []
      },
      "steps": [
        {
          "step_number": 1,
          "step_type": "proof",
          "day_offset": 0,
          "subject": "Question about FX exposure at Example Co",
          "body": "...",
          "citations": ["prospeo.open_roles", "filings.2025.accounts"]
        }
      ],
      "yamm_rows": [
        {
          "To": "",
          "FirstName": "Jane",
          "Company": "Example Co Ltd",
          "CompanyNumber": "01234567",
          "PriorityRank": 1,
          "PriorityBand": "P1",
          "StepNumber": 1,
          "StepType": "proof",
          "DayOffset": 0,
          "SendDate": "2026-06-23",
          "SendTime": "09:37",
          "Subject": "Question about FX exposure at Example Co",
          "Body": "...",
          "SequenceId": "seq_01234567_st_001",
          "ApprovalStatus": "pending",
          "ApprovedBy": "",
          "ApprovedAt": ""
        }
      ]
    }
  ],
  "errors": []
}
```

## Required YAMM/Sheet Columns

Minimum required columns for interoperability:

- `To`
- `Subject`
- `Body`
- `Company`
- `CompanyNumber`
- `PriorityRank`
- `PriorityBand`
- `SequenceId`
- `StepNumber`
- `StepType`
- `DayOffset`
- `SendDate`
- `SendTime`
- `ApprovalStatus`
- `ApprovedBy`
- `ApprovedAt`
- `ReviewNotes`

Recommended additional control columns:

- `RequestId`
- `ResponseId`
- `ContractVersion`
- `QCScore`
- `QCPassed`
- `EvidenceRefs`
- `DoNotSend` (boolean)

## Approval State Machine

Allowed states for `ApprovalStatus`:

- `pending`
- `approved`
- `rejected`
- `sent`
- `paused`

Rules:

1. New rows must start as `pending`.
2. Only `approved` rows are send-eligible.
3. `rejected` rows are never auto-sent.
4. Any edit to `Subject` or `Body` resets state to `pending`.
5. `sent` is write-once and must include `sent_at` in audit logs.

## Error Contract

If Gemini fails partially, return `status: "partial"` and include structured errors:

```json
{
  "status": "partial",
  "errors": [
    {
      "code": "sheet_write_failed",
      "message": "Could not write rows to Google Sheet",
      "retryable": true,
      "scope": {
        "company_number": "01234567",
        "person_id": "st_001"
      }
    }
  ]
}
```

Error codes:

- `invalid_contract_version`
- `invalid_payload`
- `generation_failed`
- `qc_failed`
- `sheet_write_failed`
- `sheet_permission_denied`
- `rate_limited`
- `approval_sync_conflict`
- `retry_limit_reached`
- `unknown_error`

## Idempotency and Deduplication

Use this idempotency key format:

- `idempotency_key = request_id + ":" + company_number + ":" + person_id + ":" + step_number`

Rules:

1. Replays with same key must not duplicate rows.
2. If row exists, Gemini should update in place, not append.
3. App should treat repeated `response_id` as already-processed.
4. Repeating `POST /api/gemini/handoff/:requestId/complete` with the same `response_id` is an idempotent no-op (`duplicate: true`).
5. Repeating completion with a different `response_id` for the same `request_id` is rejected as `response_id_conflict`.
6. Status responses expose `request_payload_sha256` and `response_payload_sha256` for audit-safe replay tracing without returning raw stored payload text.
7. Repeating completion with the same `response_id` but different payload content is rejected as `response_payload_mismatch`.
8. Retries are bounded by `GEMINI_HANDOFF_MAX_RETRY_COUNT` (default `5`); additional retries are rejected as `retry_limit_reached`.
9. Approval sync can use `expected_revision` for optimistic concurrency; stale revisions are rejected as `approval_sync_conflict`.

## Security and Compliance

1. Do not send secrets in payload body.
2. Do not include fields not needed for generation/export.
3. Keep PII minimal and explicit.
4. Log request/response metadata with content hashes.
5. Keep manual approval as mandatory gate.

## Suggested API Endpoints

- `POST /api/gemini/handoff`
- `GET /api/gemini/handoff` (supports `status`, `has_response`, `has_retries`, `has_approvals`, `has_events`, `has_completed`, `before_accepted_at`, `after_accepted_at`, `before_updated_at`, `after_updated_at`, `before_completed_at`, `after_completed_at`, `min_retry_count`, `max_retry_count`, `retry_count`, `sort`, `limit`, `offset`, `include_yamm_summary`, `include_status_counts`, `include_retry_counts`, `include_queue_metrics` query params)
- `GET /api/gemini/handoff/summary` (supports `recent_hours` query param)
- `GET /api/gemini/handoff/:requestId`
- `GET /api/gemini/handoff/:requestId/yamm-rows` (optional `approval_status` query param, `format=json|csv`, `send_eligible=true|false`)
- `GET /api/gemini/handoff/:requestId/yamm-rows/summary`
- `GET /api/gemini/handoff/:requestId/events` (supports `limit`, `before_id`, `event_type`, `event_stage` query params)
- `POST /api/gemini/handoff/:requestId/retry`
- `POST /api/gemini/sheets/sync-approvals` (optional `expected_revision` query param)

## Local Simulator (Dev/Test)

Use this for contract-safe end-to-end testing before wiring live Workspace credentials:

- `POST /api/dev/gemini/handoff-simulator`

Recommended local flags:

- `ENABLE_GEMINI_HANDOFF_TRANSPORT=true`
- `GEMINI_HANDOFF_TRANSPORT_URL=http://127.0.0.1:8000/api/dev/gemini/handoff-simulator`
- `ENABLE_GEMINI_HANDOFF_DEV_SIMULATOR=true`
- `GEMINI_HANDOFF_TRANSPORT_FAIL_OPEN=false`

Behavior:

1. `POST /api/gemini/handoff` persists the request.
2. Transport dispatch posts the same request payload to the simulator endpoint.
3. Simulator returns contract-compliant response payload.
4. App marks the handoff request as `completed` and stores `response_id`/`completed_at`.
5. `POST /api/gemini/handoff/:requestId/retry` re-dispatches the stored request payload when transport is enabled, then re-completes on success.

This keeps the application-side state transitions, schema validation, and retry handling testable without external dependencies.

## Acceptance Criteria

1. App can submit ranked payload and receive structured response.
2. Gemini writes rows in priority order to target Sheet tab.
3. All rows include approval columns and default to `pending`.
4. Only approved rows become send-eligible.
5. Audit logs can trace from rank -> generated copy -> approval -> send state.
