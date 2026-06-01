# Consent / DNC / opt-out suppression

This app **exports** email sequences to YAMM for the user to send manually — it never
sends directly and has **no CRM integration**. Suppression therefore comes from exactly
two operator-controlled sources, never a CRM sync:

1. **CSV uploads** you provide (`POST /api/suppression/upload`).
2. **Manual per-company / per-contact flags** you set (`POST /api/suppression`).

## Data model

`suppression_list` (SQLite, see `mock-backend/db.js`):

| column | meaning |
|--------|---------|
| `type` | `email` \| `company_number` \| `domain` |
| `value` | the value as entered |
| `value_normalized` | match key (`email` lowercased; `company_number` padded via `normalizeCompanyNumber`; `domain` lowercased, `www.` stripped) |
| `reason` | `opt_out` \| `dnc` \| `bounce` \| `manual` |
| `source` | `csv_upload` \| `manual_flag` |
| `company_name`, `notes`, `created_at` | metadata |

Uniqueness is on `(type, value_normalized)`; re-adding the same target updates the
existing row rather than duplicating it.

## CSV format

Opt-out CSVs may use a single column where each cell holds the company name and number
separated by a comma inside one (quoted) cell, e.g. `"Acme Holdings Ltd, 01234567"`.
Plain `email` rows and plain `company_number` rows are also accepted. Header-only lines
(no email and no resolvable company number) are skipped.

## Management API

- `GET /api/suppression?type=` — list current suppressions (newest first) + total.
- `POST /api/suppression` — manual flag: `{ email | company_number | domain, reason?, notes? }`.
- `POST /api/suppression/upload` — `{ csv_content, reason="opt_out", source="csv_upload" }`.
- `DELETE /api/suppression/:id` — remove a suppression.

## Enforcement (skip, don't block)

At export time the three export endpoints
(`/api/email/export/csv|json/:sequenceId`, `/api/email/export/company/:companyId`)
resolve each sequence's recipient (`company_number` from `company_id` + `stakeholder_email`)
against the suppression list:

- A **suppressed** recipient is **skipped** — its rows are removed from the export payload
  (the single-sequence JSON export returns empty `raw_rows` with `metadata.suppressed: true`;
  the CSV export returns an empty body with an `X-Suppressed: true` header) — the rest of an
  export is **not** blocked.
- Skipped recipients are still written to `email_audit_log` with
  `consent_status.suppressed = true` (plus `suppression_reason` / `suppression_source`), so
  there is a compliance trail that an export was attempted and suppressed.
- When nothing matches, export behaviour and response shapes are unchanged.
