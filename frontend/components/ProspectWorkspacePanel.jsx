import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

const STATUS_OPTIONS = [
  { value: "unknown", label: "Unknown" },
  { value: "available", label: "Available" },
  { value: "owned_in_crm", label: "Owned in CRM" },
  { value: "unavailable", label: "Unavailable" },
  { value: "needs_email", label: "Needs Email" },
  { value: "do_not_contact", label: "Do Not Contact" },
];

const STATUS_META = {
  unknown: { color: "#475569", bg: "#f8fafc", border: "#cbd5e1" },
  available: { color: "#166534", bg: "#dcfce7", border: "#86efac" },
  owned_in_crm: { color: "#92400e", bg: "#fef3c7", border: "#fde68a" },
  unavailable: { color: "#7f1d1d", bg: "#fee2e2", border: "#fecaca" },
  needs_email: { color: "#1d4ed8", bg: "#dbeafe", border: "#93c5fd" },
  do_not_contact: { color: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
};

function prospectKey(person, index = 0) {
  return String(person?.workspace_id || person?.identity_key || person?.person_id || `${person?.full_name || "person"}_${person?.role || "role"}_${index}`);
}

function formatDate(value) {
  if (!value) return null;
  const millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) return String(value);
  return new Date(millis).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function roleChangeLabel(person = {}) {
  const type = String(person.role_change_type || "").trim();
  if (!type && !person.role_change_at && !person.last_job_change_detected_at) return null;
  const label = type === "joined_relevant_company"
    ? "Joined"
    : type === "left_relevant_company"
      ? "Left"
      : "Role changed";
  const dateLabel = formatDate(person.role_change_at || person.last_job_change_detected_at || person.start_date);
  return dateLabel ? `${label} ${dateLabel}` : label;
}

function normalizeLinkedInUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^linkedin\.com\//i.test(raw)) return `https://${raw}`;
  if (/^www\.linkedin\.com\//i.test(raw)) return `https://${raw}`;
  return raw;
}

function buildLinkedInSearchUrl(person = {}, companyNumber = "") {
  const terms = [
    person.full_name || person.name,
    person.role,
    person.current_company_name,
    person.company_name,
    companyNumber,
  ].filter(Boolean).join(" ");
  if (!terms.trim()) return "";
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(terms)}`;
}

function LinkedInAction({ person, companyNumber }) {
  const profileUrl = normalizeLinkedInUrl(person?.linkedin_url || person?.linkedin || person?.linkedin_profile);
  const searchUrl = buildLinkedInSearchUrl(person, companyNumber);
  const href = profileUrl || searchUrl;
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 22,
        padding: "3px 8px",
        borderRadius: 6,
        border: "1px solid #93c5fd",
        background: "#eff6ff",
        color: "#1d4ed8",
        fontSize: 11,
        fontWeight: 700,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
      title={profileUrl ? "Open LinkedIn profile" : "Search LinkedIn for this person"}
    >
      {profileUrl ? "LinkedIn" : "Find LinkedIn"}
    </a>
  );
}

LinkedInAction.propTypes = {
  person: PropTypes.object,
  companyNumber: PropTypes.string,
};

function Badge({ children, tone = "unknown" }) {
  const meta = STATUS_META[tone] || STATUS_META.unknown;
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      minHeight: 20,
      padding: "2px 8px",
      borderRadius: 999,
      border: `1px solid ${meta.border}`,
      background: meta.bg,
      color: meta.color,
      fontSize: 11,
      fontWeight: 700,
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

Badge.propTypes = {
  children: PropTypes.node,
  tone: PropTypes.string,
};

export default function ProspectWorkspacePanel({ companyId, companyNumber, onSelectedProspectsChange }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [prospects, setProspects] = useState([]);
  const [counts, setCounts] = useState(null);
  const [emailDrafts, setEmailDrafts] = useState({});
  const [savingKey, setSavingKey] = useState("");

  const loadProspects = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/company/${encodeURIComponent(companyId)}/prospects`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load prospects");
      }
      const rows = Array.isArray(payload.prospects) ? payload.prospects : [];
      setProspects(rows);
      setCounts(payload.counts || null);
      setEmailDrafts((prev) => {
        const next = { ...prev };
        rows.forEach((person, index) => {
          const key = prospectKey(person, index);
          if (!Object.hasOwn(next, key)) next[key] = person.email || "";
        });
        return next;
      });
    } catch (err) {
      setError(err?.message || "Failed to load prospects");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadProspects();
  }, [loadProspects]);

  const selectedProspects = useMemo(
    () => prospects.filter((person) => person.selected_for_sequence === true),
    [prospects]
  );

  useEffect(() => {
    if (typeof onSelectedProspectsChange === "function") {
      onSelectedProspectsChange(selectedProspects);
    }
  }, [onSelectedProspectsChange, selectedProspects]);

  const applyWorkspacePayload = useCallback((payload) => {
    const workspace = payload?.workspace || payload;
    const rows = Array.isArray(workspace?.prospects) ? workspace.prospects : null;
    if (rows) {
      setProspects(rows);
      setCounts(workspace.counts || null);
    }
  }, []);

  const saveProspect = useCallback(async (person, patch = {}) => {
    const key = prospectKey(person);
    setSavingKey(key);
    setError(null);
    setInfo(null);
    try {
      const hasWorkspaceRow = Number.isFinite(Number(person?.workspace_id));
      const url = hasWorkspaceRow
        ? `/api/company/${encodeURIComponent(companyId)}/prospects/${encodeURIComponent(String(person.workspace_id))}`
        : `/api/company/${encodeURIComponent(companyId)}/prospects`;
      const method = hasWorkspaceRow ? "PATCH" : "POST";
      const body = hasWorkspaceRow
        ? patch
        : { candidate: person, ...patch };
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to save prospect");
      applyWorkspacePayload(payload);
      return payload.prospect || null;
    } catch (err) {
      setError(err?.message || "Failed to save prospect");
      return null;
    } finally {
      setSavingKey("");
    }
  }, [applyWorkspacePayload, companyId]);

  const requestEmail = useCallback(async (person) => {
    setError(null);
    setInfo(null);
    let target = person;
    if (!target?.workspace_id) {
      const saved = await saveProspect(person, { availability_status: "needs_email", crm_checked: true });
      if (!saved) return;
      target = { ...person, ...saved, workspace_id: saved.id };
    }

    const key = prospectKey(target);
    setSavingKey(key);
    try {
      const response = await fetch(`/api/company/${encodeURIComponent(companyId)}/prospects/${encodeURIComponent(String(target.workspace_id || target.id))}/request-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_number: companyNumber }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Email request failed");
      applyWorkspacePayload(payload);
      setEmailDrafts((prev) => ({ ...prev, [key]: payload.email || "" }));
      setInfo("Verified email added.");
    } catch (err) {
      setError(err?.message || "Email request failed");
    } finally {
      setSavingKey("");
    }
  }, [applyWorkspacePayload, companyId, companyNumber, saveProspect]);

  const updateEmailDraft = useCallback((person, index, value) => {
    const key = prospectKey(person, index);
    setEmailDrafts((prev) => ({ ...prev, [key]: value }));
  }, []);

  const saveEmailDraft = useCallback(async (person, index) => {
    const key = prospectKey(person, index);
    const email = String(emailDrafts[key] || "").trim();
    await saveProspect(person, {
      email,
      email_status: email ? "provided" : "missing",
      availability_status: email && person.availability_status === "needs_email" ? "available" : person.availability_status,
    });
  }, [emailDrafts, saveProspect]);

  const headerCounts = counts || {};

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: 16, margin: 0 }}>Prospect Workspace</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            <Badge>{headerCounts.total || 0} people</Badge>
            <Badge tone="available">{headerCounts.available || 0} available</Badge>
            <Badge tone="needs_email">{headerCounts.selected_for_sequence || 0} selected</Badge>
            <Badge>{headerCounts.role_change || 0} role changes</Badge>
            <Badge>{headerCounts.missing_email || 0} missing email</Badge>
          </div>
        </div>
        <button
          type="button"
          onClick={loadProspects}
          disabled={loading}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: "#fff",
            color: "#374151",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            fontSize: 12,
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ color: "#991b1b", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 10px", fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}
      {info && (
        <div style={{ color: "#065f46", background: "#d1fae5", border: "1px solid #86efac", borderRadius: 6, padding: "8px 10px", fontSize: 12, marginBottom: 10 }}>
          {info}
        </div>
      )}

      {!loading && prospects.length < 1 ? (
        <div style={{ color: "#64748b", fontSize: 13, padding: 14, border: "1px dashed #d4dce6", borderRadius: 8 }}>
          No connector prospects are available yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {prospects.map((person, index) => {
            const key = prospectKey(person, index);
            const saving = savingKey === key;
            const statusMeta = STATUS_META[person.availability_status] || STATUS_META.unknown;
            const emailDraft = Object.hasOwn(emailDrafts, key) ? emailDrafts[key] : (person.email || "");
            const roleChange = roleChangeLabel(person);

            return (
              <div key={key} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: "#f8fafc" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 220, flex: "1 1 260px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{person.full_name || "Unknown person"}</div>
                      <LinkedInAction person={person} companyNumber={companyNumber} />
                    </div>
                    <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{person.role || "Role unavailable"}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                      {person.source && <Badge>{person.source.replaceAll("_", " ")}</Badge>}
                      {person.is_new_hire && <Badge tone="available">New hire</Badge>}
                      {roleChange && <Badge tone="needs_email">{roleChange}</Badge>}
                      <Badge tone={person.availability_status}>{STATUS_OPTIONS.find((item) => item.value === person.availability_status)?.label || "Unknown"}</Badge>
                    </div>
                    {(person.previous_company_name || person.current_company_name) && (
                      <div style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>
                        {[person.previous_company_name, person.current_company_name].filter(Boolean).join(" -> ")}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1fr) minmax(170px, 1fr)", gap: 8, flex: "2 1 360px" }}>
                    <label style={{ fontSize: 12, color: "#374151", fontWeight: 700 }}>
                      Status
                      <select
                        value={person.availability_status || "unknown"}
                        onChange={(event) => saveProspect(person, { availability_status: event.target.value })}
                        disabled={saving}
                        style={{
                          display: "block",
                          width: "100%",
                          marginTop: 4,
                          padding: "6px 8px",
                          borderRadius: 6,
                          border: `1px solid ${statusMeta.border}`,
                          background: "#fff",
                          color: statusMeta.color,
                          fontSize: 12,
                        }}
                      >
                        {STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>

                    <label style={{ fontSize: 12, color: "#374151", fontWeight: 700 }}>
                      Email
                      <input
                        value={emailDraft}
                        onChange={(event) => updateEmailDraft(person, index, event.target.value)}
                        placeholder="name@company.com"
                        style={{
                          display: "block",
                          width: "100%",
                          marginTop: 4,
                          padding: "6px 8px",
                          borderRadius: 6,
                          border: "1px solid #d1d5db",
                          fontSize: 12,
                          boxSizing: "border-box",
                        }}
                      />
                    </label>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#374151", fontWeight: 700 }}>
                      <input
                        type="checkbox"
                        checked={person.crm_checked === true}
                        onChange={(event) => saveProspect(person, { crm_checked: event.target.checked })}
                        disabled={saving}
                      />
                      CRM checked
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#374151", fontWeight: 700 }}>
                      <input
                        type="checkbox"
                        checked={person.selected_for_sequence === true}
                        onChange={(event) => saveProspect(person, { selected_for_sequence: event.target.checked })}
                        disabled={saving}
                      />
                      Selected
                    </label>
                    <span style={{ fontSize: 12, color: "#64748b" }}>
                      Email status: {person.email_status || "missing"}
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => saveEmailDraft(person, index)}
                      disabled={saving}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: "1px solid #d1d5db",
                        background: "#fff",
                        color: "#374151",
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: saving ? "wait" : "pointer",
                      }}
                    >
                      Save Email
                    </button>
                    <button
                      type="button"
                      onClick={() => requestEmail(person)}
                      disabled={saving || Boolean(person.email)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: "none",
                        background: "#0f766e",
                        color: "#fff",
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: saving || person.email ? "not-allowed" : "pointer",
                        opacity: saving || person.email ? 0.55 : 1,
                      }}
                    >
                      {saving ? "Saving..." : "Request Email"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

ProspectWorkspacePanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  companyNumber: PropTypes.string,
  onSelectedProspectsChange: PropTypes.func,
};
