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
- `unknown_error`

## Idempotency and Deduplication

Use this idempotency key format:

- `idempotency_key = request_id + ":" + company_number + ":" + person_id + ":" + step_number`

Rules:

1. Replays with same key must not duplicate rows.
2. If row exists, Gemini should update in place, not append.
3. App should treat repeated `response_id` as already-processed.

## Security and Compliance

1. Do not send secrets in payload body.
2. Do not include fields not needed for generation/export.
3. Keep PII minimal and explicit.
4. Log request/response metadata with content hashes.
5. Keep manual approval as mandatory gate.

## Suggested API Endpoints

- `POST /api/gemini/handoff`
- `GET /api/gemini/handoff/:requestId`
- `POST /api/gemini/handoff/:requestId/retry`
- `POST /api/gemini/sheets/sync-approvals`

## Acceptance Criteria

1. App can submit ranked payload and receive structured response.
2. Gemini writes rows in priority order to target Sheet tab.
3. All rows include approval columns and default to `pending`.
4. Only approved rows become send-eligible.
5. Audit logs can trace from rank -> generated copy -> approval -> send state.
