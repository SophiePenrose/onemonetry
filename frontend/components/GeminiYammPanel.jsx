import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

function normalizeCompanyNumber(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/^CH-/, "").replace(/\s+/g, "");
  if (!raw) return "";
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, "0");
  return raw;
}

function formatTimestamp(value) {
  if (!value) return "Not available";
  const millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) return String(value);
  return new Date(millis).toLocaleString("en-GB");
}

function toFlag(value) {
  if (value === true) return true;
  const token = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(token);
}

function deriveLocalSequenceId(sequenceId) {
  const token = String(sequenceId || "").trim();
  if (!token) return null;
  return `gemini_${token}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

const GEMINI_APPROVAL_STATUSES = ["pending", "approved", "rejected", "sent", "paused"];
const GEMINI_APPROVAL_STATUS_SET = new Set(GEMINI_APPROVAL_STATUSES);

function parseStepNumber(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeApprovalStatus(value) {
  const token = String(value || "").trim().toLowerCase();
  if (GEMINI_APPROVAL_STATUS_SET.has(token)) return token;
  return "pending";
}

function buildRowApprovalKey(row) {
  const sequenceId = String(row?.SequenceId || "").trim();
  const stepNumber = parseStepNumber(row?.StepNumber);
  if (!sequenceId || !stepNumber) return null;
  return `${sequenceId}::${stepNumber}`;
}

function isSendEligibleRow(row) {
  const approvalStatus = normalizeApprovalStatus(row?.ApprovalStatus);
  const hasRecipient = String(row?.To || "").trim().length > 0;
  const doNotSend = toFlag(row?.DoNotSend);
  const companyNameNeedsReview = toFlag(row?.CompanyNameNeedsReview);
  return approvalStatus === "approved" && hasRecipient && !doNotSend && !companyNameNeedsReview;
}

function applyApprovalToRows(rows = [], targetRowKey, nextStatus, approvedBy = "Sophie") {
  const nextApprovalStatus = normalizeApprovalStatus(nextStatus);
  const nowIso = new Date().toISOString();
  return rows.map((row) => {
    const rowKey = buildRowApprovalKey(row);
    if (!rowKey || rowKey !== targetRowKey) return row;
    return {
      ...row,
      ApprovalStatus: nextApprovalStatus,
      ApprovedBy: nextApprovalStatus === "approved" ? approvedBy : null,
      ApprovedAt: nextApprovalStatus === "approved" ? nowIso : null,
      ReviewNotes: row?.ReviewNotes || null,
    };
  });
}

function applyApprovalToManyRows(rows = [], rowKeys = new Set(), nextStatus, approvedBy = "Sophie") {
  if (!(rowKeys instanceof Set) || rowKeys.size < 1) return rows;
  const nextApprovalStatus = normalizeApprovalStatus(nextStatus);
  const nowIso = new Date().toISOString();
  return rows.map((row) => {
    const rowKey = buildRowApprovalKey(row);
    if (!rowKey || !rowKeys.has(rowKey)) return row;
    return {
      ...row,
      ApprovalStatus: nextApprovalStatus,
      ApprovedBy: nextApprovalStatus === "approved" ? approvedBy : null,
      ApprovedAt: nextApprovalStatus === "approved" ? nowIso : null,
      ReviewNotes: row?.ReviewNotes || null,
    };
  });
}

function buildApprovalsPayloadFromRows(rows = []) {
  const approvals = [];
  const seen = new Set();

  for (const row of rows) {
    const sequenceId = String(row?.SequenceId || "").trim();
    const stepNumber = parseStepNumber(row?.StepNumber);
    if (!sequenceId || !stepNumber) continue;

    const dedupeKey = `${sequenceId}::${stepNumber}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const approvalStatus = normalizeApprovalStatus(row?.ApprovalStatus);
    const approval = {
      sequence_id: sequenceId,
      step_number: stepNumber,
      approval_status: approvalStatus,
    };

    const approvedBy = String(row?.ApprovedBy || "").trim();
    const approvedAt = String(row?.ApprovedAt || "").trim();
    const reviewNotes = String(row?.ReviewNotes || "").trim();

    if (approvedBy) approval.approved_by = approvedBy;
    if (approvedAt) approval.approved_at = approvedAt;
    if (reviewNotes) approval.review_notes = reviewNotes;

    approvals.push(approval);
  }

  return approvals;
}

function RowPreview({ title, row }) {
  if (!row) return null;

  const fields = [
    ["To", row.To || ""],
    ["FirstName", row.FirstName || ""],
    ["Company", row.Company || ""],
    ["CompanyNumber", row.CompanyNumber || ""],
    ["SequenceId", row.SequenceId || ""],
    ["StepNumber", row.StepNumber || ""],
    ["ApprovalStatus", row.ApprovalStatus || ""],
    ["CompanyNameNeedsReview", toFlag(row.CompanyNameNeedsReview) ? "true" : "false"],
    ["CompanyNameReviewReason", row.CompanyNameReviewReason || ""],
    ["DoNotSend", toFlag(row.DoNotSend) ? "true" : "false"],
  ];

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff", marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 6, marginBottom: 8 }}>
        {fields.map(([name, value]) => (
          <div key={name} style={{ fontSize: 12, color: "#4b5563" }}>
            <strong>{name}:</strong> {String(value || "-")}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
        <strong>Subject:</strong> {String(row.Subject || "").slice(0, 180) || "-"}
      </div>
      <div style={{ fontSize: 12, color: "#374151" }}>
        <strong>Body preview:</strong> {String(row.Body || "").slice(0, 220) || "-"}
      </div>
    </div>
  );
}

RowPreview.propTypes = {
  title: PropTypes.string.isRequired,
  row: PropTypes.object,
};

export default function GeminiYammPanel({ companyId, companyNumber }) {
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const [requests, setRequests] = useState([]);
  const [selectedRequestId, setSelectedRequestId] = useState("");

  const [loadingRows, setLoadingRows] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [sequenceLink, setSequenceLink] = useState(null);
  const [approvalCounts, setApprovalCounts] = useState(null);
  const [approvalsRevision, setApprovalsRevision] = useState(0);
  const [approvalSyncing, setApprovalSyncing] = useState(false);
  const [pendingApprovalKey, setPendingApprovalKey] = useState("");
  const [approvalError, setApprovalError] = useState(null);
  const [approvalInfo, setApprovalInfo] = useState(null);

  const normalizedCompany = normalizeCompanyNumber(companyNumber);

  const loadRequests = useCallback(async () => {
    setLoadingRequests(true);
    setRequestError(null);
    try {
      const res = await fetch("/api/gemini/handoff?has_response=true&sort=accepted_desc&limit=20&include_yamm_summary=true");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load Gemini handoff requests");
      }
      const items = Array.isArray(data.items) ? data.items : [];
      setRequests(items);
      if (items.length > 0) {
        setSelectedRequestId((current) => {
          if (current && items.some((item) => item.request_id === current)) return current;
          return String(items[0].request_id || "");
        });
      } else {
        setSelectedRequestId("");
      }
    } catch (err) {
      setRequestError(err?.message || "Failed to load Gemini handoff requests");
    } finally {
      setLoadingRequests(false);
    }
  }, []);

  const loadRowsForRequest = useCallback(async (requestId) => {
    if (!requestId) {
      setRows([]);
      setSummary(null);
      setSequenceLink(null);
      setApprovalCounts(null);
      setApprovalsRevision(0);
      setApprovalError(null);
      setApprovalInfo(null);
      return;
    }

    setLoadingRows(true);
    setRowsError(null);
    setApprovalError(null);
    try {
      const [rowsRes, summaryRes, statusRes] = await Promise.all([
        fetch(`/api/gemini/handoff/${encodeURIComponent(requestId)}/yamm-rows`),
        fetch(`/api/gemini/handoff/${encodeURIComponent(requestId)}/yamm-rows/summary`),
        fetch(`/api/gemini/handoff/${encodeURIComponent(requestId)}`),
      ]);

      const rowsData = await rowsRes.json().catch(() => ({}));
      const summaryData = await summaryRes.json().catch(() => ({}));
      const statusData = await statusRes.json().catch(() => ({}));

      if (!rowsRes.ok) {
        throw new Error(rowsData.error || "Failed to load YAMM rows");
      }
      if (!summaryRes.ok) {
        throw new Error(summaryData.error || "Failed to load YAMM summary");
      }
      if (!statusRes.ok) {
        throw new Error(statusData.error || "Failed to load handoff status");
      }

      const parsedRows = Array.isArray(rowsData.rows) ? rowsData.rows : [];
      setRows(parsedRows);
      setSummary(summaryData);
      setApprovalCounts(statusData.approval_counts || null);
      setApprovalsRevision(Number.parseInt(String(statusData.approvals_revision || 0), 10) || 0);

      const matchingRow = parsedRows.find((row) => normalizeCompanyNumber(row?.CompanyNumber) === normalizedCompany) || parsedRows[0] || null;
      if (!matchingRow?.SequenceId) {
        setSequenceLink(null);
        return;
      }

      const localSequenceId = deriveLocalSequenceId(matchingRow.SequenceId);
      if (!localSequenceId) {
        setSequenceLink(null);
        return;
      }

      const sequenceRes = await fetch(`/api/email/sequence/${encodeURIComponent(localSequenceId)}`);
      const sequenceData = await sequenceRes.json().catch(() => ({}));
      if (!sequenceRes.ok || !sequenceData?.sequence) {
        setSequenceLink({ id: localSequenceId, exists: false });
        return;
      }

      setSequenceLink({
        id: localSequenceId,
        exists: true,
        status: sequenceData.sequence.status,
        stakeholder_name: sequenceData.sequence.stakeholder_name,
        stakeholder_email: sequenceData.sequence.stakeholder_email,
        step_count: Array.isArray(sequenceData.sequence.steps) ? sequenceData.sequence.steps.length : 0,
      });
    } catch (err) {
      setRowsError(err?.message || "Failed to load YAMM rows");
      setRows([]);
      setSummary(null);
      setSequenceLink(null);
    } finally {
      setLoadingRows(false);
    }
  }, [normalizedCompany]);

  const syncApprovals = useCallback(async (nextRows, actionLabel, rowKey = "") => {
    if (!selectedRequestId) return;

    const approvals = buildApprovalsPayloadFromRows(nextRows);
    if (approvals.length < 1) {
      setApprovalError("No sequenced rows are available to sync approvals.");
      return;
    }

    const expectedRevision = Math.max(0, Number.parseInt(String(approvalsRevision || 0), 10) || 0);

    setApprovalSyncing(true);
    setPendingApprovalKey(rowKey);
    setApprovalError(null);
    setApprovalInfo(null);
    setRows(nextRows);

    try {
      const response = await fetch(`/api/gemini/sheets/sync-approvals?expected_revision=${encodeURIComponent(String(expectedRevision))}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_version: "gemini-handoff-v1",
          request_id: selectedRequestId,
          approvals,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 409 && payload?.error === "approval_sync_conflict") {
          setApprovalError("Approvals were updated elsewhere. Latest statuses have been reloaded.");
          await loadRowsForRequest(selectedRequestId);
          return;
        }
        throw new Error(payload.error || "Failed to sync approvals");
      }

      setApprovalsRevision(Number.parseInt(String(payload.approvals_revision || expectedRevision + 1), 10) || expectedRevision + 1);
      setApprovalCounts(payload.counts || null);
      setApprovalInfo(actionLabel || "Approvals synced");
      await loadRowsForRequest(selectedRequestId);
    } catch (err) {
      setApprovalError(err?.message || "Failed to sync approvals");
      await loadRowsForRequest(selectedRequestId);
    } finally {
      setApprovalSyncing(false);
      setPendingApprovalKey("");
    }
  }, [approvalsRevision, loadRowsForRequest, selectedRequestId]);

  useEffect(() => {
    loadRequests();
  }, [companyId, loadRequests]);

  useEffect(() => {
    loadRowsForRequest(selectedRequestId);
  }, [selectedRequestId, loadRowsForRequest]);

  const selectedRequest = useMemo(
    () => requests.find((item) => item.request_id === selectedRequestId) || null,
    [requests, selectedRequestId]
  );

  const companyRows = useMemo(() => {
    if (!normalizedCompany) return [];
    return rows.filter((row) => normalizeCompanyNumber(row?.CompanyNumber) === normalizedCompany);
  }, [rows, normalizedCompany]);

  const reviewRows = useMemo(() => {
    if (companyRows.length > 0) return companyRows;
    return rows.slice(0, 8);
  }, [companyRows, rows]);

  const handleSetRowApproval = useCallback((row, nextStatus) => {
    const rowKey = buildRowApprovalKey(row);
    if (!rowKey) {
      setApprovalError("This row is missing sequence id or step number, so it cannot be approved.");
      return;
    }
    const nextRows = applyApprovalToRows(rows, rowKey, nextStatus);
    const actionLabel = `Row set to ${normalizeApprovalStatus(nextStatus)}`;
    syncApprovals(nextRows, actionLabel, rowKey);
  }, [rows, syncApprovals]);

  const handleApproveCompanyRows = useCallback(() => {
    if (companyRows.length < 1) return;
    const targetKeys = new Set(companyRows.map((row) => buildRowApprovalKey(row)).filter(Boolean));
    if (targetKeys.size < 1) {
      setApprovalError("No valid company rows are available for approval sync.");
      return;
    }
    const nextRows = applyApprovalToManyRows(rows, targetKeys, "approved");
    syncApprovals(nextRows, "Approved all rows for this company");
  }, [companyRows, rows, syncApprovals]);

  const handleResetCompanyRowsToPending = useCallback(() => {
    if (companyRows.length < 1) return;
    const targetKeys = new Set(companyRows.map((row) => buildRowApprovalKey(row)).filter(Boolean));
    if (targetKeys.size < 1) {
      setApprovalError("No valid company rows are available for approval sync.");
      return;
    }
    const nextRows = applyApprovalToManyRows(rows, targetKeys, "pending");
    syncApprovals(nextRows, "Set company rows to pending");
  }, [companyRows, rows, syncApprovals]);

  const flaggedRow = useMemo(
    () => rows.find((row) => toFlag(row?.CompanyNameNeedsReview)) || null,
    [rows]
  );

  const sampleRow = useMemo(() => companyRows[0] || rows[0] || null, [companyRows, rows]);

  const totals = summary?.totals || {};
  const byApproval = approvalCounts || summary?.by_approval_status || {};
  const reasons = summary?.company_name_review_reasons || {};

  const approvalBadgeStyle = (token, active) => {
    const palette = {
      pending: { border: "#cbd5e1", bg: "#f8fafc", color: "#334155" },
      approved: { border: "#86efac", bg: "#dcfce7", color: "#166534" },
      rejected: { border: "#fca5a5", bg: "#fee2e2", color: "#991b1b" },
      paused: { border: "#fde68a", bg: "#fef3c7", color: "#92400e" },
      sent: { border: "#93c5fd", bg: "#dbeafe", color: "#1d4ed8" },
    };
    const selected = palette[token] || palette.pending;
    return {
      padding: "4px 10px",
      borderRadius: 999,
      border: `1px solid ${selected.border}`,
      background: selected.bg,
      color: selected.color,
      fontWeight: active ? 700 : 600,
      fontSize: 11,
      cursor: "pointer",
      opacity: active ? 1 : 0.92,
    };
  };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Gemini YAMM Preview</h3>
        <button
          onClick={loadRequests}
          disabled={loadingRequests}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: "#fff",
            color: "#374151",
            fontWeight: 600,
            cursor: loadingRequests ? "wait" : "pointer",
            fontSize: 12,
          }}
        >
          {loadingRequests ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>
        This preview shows exactly what is returned by Gemini handoff YAMM rows, lets you approve/reject each step, and confirms what is send-ready for YAMM export.
      </div>

      <div style={{ border: "1px solid #dbeafe", borderRadius: 8, padding: 10, marginBottom: 12, background: "#eff6ff" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#1e3a8a", marginBottom: 6 }}>How to send through YAMM</div>
        <div style={{ fontSize: 12, color: "#1e3a8a" }}>1. Review rows and set each step to <strong>approved</strong> when ready.</div>
        <div style={{ fontSize: 12, color: "#1e3a8a" }}>2. Download <strong>send-eligible CSV</strong> (approved rows with recipient + no blocking flags).</div>
        <div style={{ fontSize: 12, color: "#1e3a8a" }}>3. Import CSV into Google Sheets and run YAMM from that sheet.</div>
      </div>

      {requestError && <div style={{ color: "#991b1b", fontSize: 12, marginBottom: 8 }}>{requestError}</div>}

      {requests.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginRight: 8 }} htmlFor="yamm-request-select">
            Handoff request:
          </label>
          <select
            id="yamm-request-select"
            value={selectedRequestId}
            onChange={(event) => setSelectedRequestId(event.target.value)}
            style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, minWidth: 360 }}
          >
            {requests.map((item) => (
              <option key={item.request_id} value={item.request_id}>
                {item.request_id} · {item.status} · {formatTimestamp(item.accepted_at)}
              </option>
            ))}
          </select>
        </div>
      )}

      {rowsError && <div style={{ color: "#991b1b", fontSize: 12, marginBottom: 8 }}>{rowsError}</div>}
      {approvalError && <div style={{ color: "#991b1b", fontSize: 12, marginBottom: 8 }}>{approvalError}</div>}
      {approvalInfo && <div style={{ color: "#065f46", fontSize: 12, marginBottom: 8 }}>{approvalInfo}</div>}

      {selectedRequest && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "#374151" }}>
          <div><strong>Status:</strong> {selectedRequest.status}</div>
          <div><strong>Accepted:</strong> {formatTimestamp(selectedRequest.accepted_at)}</div>
          <div><strong>Retry count:</strong> {selectedRequest.retry_count ?? 0}</div>
          <div><strong>Approvals revision:</strong> {approvalsRevision}</div>
          <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a href={`/api/gemini/handoff/${encodeURIComponent(selectedRequest.request_id)}/yamm-rows?format=csv`} style={{ color: "#0075EB", fontWeight: 600 }}>
              Download all CSV
            </a>
            <a href={`/api/gemini/handoff/${encodeURIComponent(selectedRequest.request_id)}/yamm-rows?format=csv&send_eligible=true`} style={{ color: "#0075EB", fontWeight: 600 }}>
              Download send-eligible CSV
            </a>
          </div>
        </div>
      )}

      {loadingRows && <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>Loading YAMM rows...</div>}

      {!loadingRows && summary && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 12, background: "#f8fafc" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Current request summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 6 }}>
            <div style={{ fontSize: 12 }}>rows: <strong>{totals.rows ?? 0}</strong></div>
            <div style={{ fontSize: 12 }}>send eligible: <strong>{totals.send_eligible ?? 0}</strong></div>
            <div style={{ fontSize: 12 }}>pending approvals: <strong>{byApproval.pending ?? 0}</strong></div>
            <div style={{ fontSize: 12 }}>approved: <strong>{byApproval.approved ?? 0}</strong></div>
            <div style={{ fontSize: 12 }}>company-name review: <strong>{totals.company_name_needs_review ?? 0}</strong></div>
            <div style={{ fontSize: 12 }}>missing recipient: <strong>{totals.missing_recipient ?? 0}</strong></div>
          </div>
          {Object.keys(reasons).length > 0 && (
            <div style={{ fontSize: 12, marginTop: 6, color: "#374151" }}>
              review reasons: {Object.entries(reasons).map(([name, count]) => `${name}: ${count}`).join(", ")}
            </div>
          )}
        </div>
      )}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 12, background: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>Approval controls</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleApproveCompanyRows}
              disabled={approvalSyncing || companyRows.length < 1}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #86efac",
                background: "#dcfce7",
                color: "#166534",
                fontSize: 11,
                fontWeight: 700,
                cursor: approvalSyncing || companyRows.length < 1 ? "not-allowed" : "pointer",
                opacity: approvalSyncing || companyRows.length < 1 ? 0.6 : 1,
              }}
            >
              Approve all company rows
            </button>
            <button
              onClick={handleResetCompanyRowsToPending}
              disabled={approvalSyncing || companyRows.length < 1}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "#f8fafc",
                color: "#334155",
                fontSize: 11,
                fontWeight: 700,
                cursor: approvalSyncing || companyRows.length < 1 ? "not-allowed" : "pointer",
                opacity: approvalSyncing || companyRows.length < 1 ? 0.6 : 1,
              }}
            >
              Set company rows pending
            </button>
          </div>
        </div>

        <div style={{ fontSize: 12, color: "#374151", marginBottom: 8 }}>
          Rows shown for approval: <strong>{reviewRows.length}</strong>{companyRows.length > 0 ? " (current company only)" : " (sample from selected request)"}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reviewRows.map((row, index) => {
            const rowKey = buildRowApprovalKey(row) || `row_${index}`;
            const approvalStatus = normalizeApprovalStatus(row?.ApprovalStatus);
            const stepNumber = parseStepNumber(row?.StepNumber) || index + 1;
            const stepType = String(row?.StepType || "step").trim() || "step";
            const sendEligible = isSendEligibleRow(row);
            const isPendingAction = approvalSyncing && pendingApprovalKey === rowKey;

            return (
              <div key={rowKey} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, background: "#f8fafc" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: "#374151", fontWeight: 700 }}>
                    Step {stepNumber} · {stepType}
                  </div>
                  <div style={{ fontSize: 11, color: sendEligible ? "#166534" : "#475569", fontWeight: 700 }}>
                    {sendEligible ? "Send-eligible" : "Not send-eligible"}
                  </div>
                </div>

                <div style={{ fontSize: 12, color: "#475569", marginBottom: 6 }}>
                  <strong>Recipient:</strong> {String(row?.To || "(missing)")} · <strong>Company:</strong> {String(row?.Company || "(missing)")}
                </div>

                <div style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
                  <strong>Subject:</strong> {String(row?.Subject || "").slice(0, 160) || "-"}
                </div>
                <div style={{ fontSize: 12, color: "#374151", marginBottom: 6 }}>
                  <strong>Body preview:</strong> {String(row?.Body || "").slice(0, 220) || "-"}
                </div>

                {(toFlag(row?.CompanyNameNeedsReview) || toFlag(row?.DoNotSend)) && (
                  <div style={{ fontSize: 11, color: "#92400e", marginBottom: 6 }}>
                    {toFlag(row?.CompanyNameNeedsReview) ? `Company name review required (${row?.CompanyNameReviewReason || "reason_unknown"}). ` : ""}
                    {toFlag(row?.DoNotSend) ? "Row marked do-not-send." : ""}
                  </div>
                )}

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {GEMINI_APPROVAL_STATUSES.map((statusToken) => {
                    const active = approvalStatus === statusToken;
                    const label = statusToken.charAt(0).toUpperCase() + statusToken.slice(1);
                    return (
                      <button
                        key={`${rowKey}_${statusToken}`}
                        onClick={() => handleSetRowApproval(row, statusToken)}
                        disabled={approvalSyncing || isPendingAction}
                        style={approvalBadgeStyle(statusToken, active)}
                      >
                        {label}
                      </button>
                    );
                  })}
                  {isPendingAction && (
                    <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>Syncing...</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ fontSize: 12, color: "#374151", marginBottom: 8 }}>
        Rows for this company in selected request: <strong>{companyRows.length}</strong>
      </div>

      {sequenceLink && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff", marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Local sequence linkage</div>
          <div style={{ fontSize: 12, color: "#4b5563" }}>Local sequence id: {sequenceLink.id}</div>
          <div style={{ fontSize: 12, color: "#4b5563" }}>Exists in email_sequences: {sequenceLink.exists ? "Yes" : "No"}</div>
          {sequenceLink.exists && (
            <>
              <div style={{ fontSize: 12, color: "#4b5563" }}>Status: {sequenceLink.status || "n/a"}</div>
              <div style={{ fontSize: 12, color: "#4b5563" }}>Stakeholder: {sequenceLink.stakeholder_name || "n/a"}</div>
              <div style={{ fontSize: 12, color: "#4b5563" }}>Email: {sequenceLink.stakeholder_email || "n/a"}</div>
              <div style={{ fontSize: 12, color: "#4b5563" }}>Step count: {sequenceLink.step_count ?? 0}</div>
            </>
          )}
        </div>
      )}

      <RowPreview
        title={companyRows.length > 0 ? "Sample row for this company" : "Sample row from selected request"}
        row={sampleRow}
      />

      <RowPreview title="Example company-name-review row" row={flaggedRow} />
    </div>
  );
}

GeminiYammPanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  companyNumber: PropTypes.string,
};
