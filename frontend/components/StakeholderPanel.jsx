import React, { useRef, useState } from "react";
import PropTypes from "prop-types";

const EMPTY_ARRAY = [];

function normalizePersonKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function StakeholderPanel({ stakeholders, stakeholderAssessment, companyId, onUpdated, analysisStatus }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", role: "", email: "", linkedin: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState(null);
  const [supplementary, setSupplementary] = useState(null);
  const [supplementaryLoading, setSupplementaryLoading] = useState(false);
  const reviewRef = useRef(null);

  const automatedStakeholders = (stakeholders || []).filter((s) => s.source === "analysis");
  const manualStakeholders = (stakeholders || []).filter((s) => s.source !== "analysis");
  const readiness = stakeholderAssessment?.readiness;
  const waitingForAnalysis = analysisStatus === "queued";
  const analysisFailed = analysisStatus === "failed";
  const supplementaryPeople = supplementary?.people_research || supplementary?.people_targets || EMPTY_ARRAY;

  const supplementaryPeopleByName = React.useMemo(() => {
    const map = new Map();
    for (const person of supplementaryPeople) {
      const key = normalizePersonKey(person?.name);
      if (!key) continue;
      if (!map.has(key)) map.set(key, person);
    }
    return map;
  }, [supplementaryPeople]);

  const automatedStakeholdersWithContacts = React.useMemo(
    () => automatedStakeholders.map((stakeholder) => {
      const key = normalizePersonKey(stakeholder?.name);
      const contact = supplementaryPeopleByName.get(key);
      return contact ? { ...stakeholder, _supplementaryContact: contact } : stakeholder;
    }),
    [automatedStakeholders, supplementaryPeopleByName]
  );

  React.useEffect(() => {
    if (!companyId) return;
    setSupplementaryLoading(true);
    fetch(`/api/company/${encodeURIComponent(companyId)}/supplementary-context`)
      .then((r) => r.json())
      .then((d) => setSupplementary(d.context || null))
      .catch(() => setSupplementary(null))
      .finally(() => setSupplementaryLoading(false));
  }, [companyId]);

  async function handleRunReview() {
    if (!companyId) return;
    setReviewing(true);
    setError(null);
    try {
      const res = await fetch(`/api/stakeholders/${encodeURIComponent(companyId)}/review`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to run stakeholder review");
      }
      if (onUpdated) onUpdated();
      [100, 500, 1000].forEach((delay) => {
        setTimeout(() => reviewRef.current?.scrollIntoView({ block: "center" }), delay);
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setReviewing(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/stakeholders`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm({ name: "", role: "", email: "", linkedin: "", notes: "" });
        setShowForm(false);
        if (onUpdated) onUpdated();
      } else {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to add contact");
      }
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  async function handleDelete(stakeholder, idx) {
    if (!confirm("Remove this stakeholder?")) return;
    setError(null);
    try {
      const deleteIdx = stakeholder._manual_index ?? idx;
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/stakeholders/${deleteIdx}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove contact");
      }
      if (onUpdated) onUpdated();
    } catch (err) { setError(err.message); }
  }

  const inputStyle = { width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Stakeholders & Contacts</h3>
        {companyId && (
          <button onClick={() => setShowForm(!showForm)} style={{
            padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: showForm ? "#f3f4f6" : "#0075EB", color: showForm ? "#555" : "#fff",
          }}>
            {showForm ? "Cancel" : "+ Add Contact"}
          </button>
        )}
      </div>

      <div ref={reviewRef} style={{ background: "#f8f9fb", border: "1px solid #e0e3e8", borderRadius: 6, padding: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>Automated stakeholder review</div>
            <div style={{ fontSize: 12, color: "#666" }}>
              {readiness?.reason || "Run review to rank directors and finance/payment stakeholders from filing insights."}
            </div>
          </div>
          {companyId && (
            <button onClick={handleRunReview} disabled={reviewing} style={{
              padding: "6px 12px", borderRadius: 6, border: "1px solid #0075EB", background: "#fff",
              color: "#0075EB", fontSize: 12, fontWeight: 700, cursor: reviewing ? "wait" : "pointer",
              opacity: reviewing ? 0.6 : 1,
            }}>
              {reviewing ? "Reviewing..." : automatedStakeholders.length > 0 ? "Refresh Review" : "Run Review"}
            </button>
          )}
        </div>

        {automatedStakeholders.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {automatedStakeholdersWithContacts.slice(0, 4).map((s, idx) => {
              const supplemental = s._supplementaryContact || null;
              const contactEmail = supplemental?.contact_email || null;
              const contactPhone = supplemental?.contact_phone || null;
              const linkedInUrl = supplemental?.linkedin_profile_url || supplemental?.linkedin_search_url || null;
              const lushaStatus = supplemental?.lusha_status || null;

              return (
                <div key={`${s.name}-${idx}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, background: "#fff", borderRadius: 6, padding: "8px 10px", border: "1px solid #edf0f3" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{s.name} <span style={{ color: "#0075EB", fontWeight: 600 }}>({s.role})</span></div>
                    <div style={{ fontSize: 12, color: "#666" }}>{s.buying_role || "stakeholder"}{s.needs_verification ? " · verify before outreach" : " · ready for outreach"}</div>
                    {(contactEmail || contactPhone || linkedInUrl) && (
                      <div style={{ fontSize: 12, color: "#444", marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {contactEmail && <a href={`mailto:${contactEmail}`} style={{ color: "#0075EB", textDecoration: "none" }}>{contactEmail}</a>}
                        {contactPhone && <a href={`tel:${contactPhone}`} style={{ color: "#0075EB", textDecoration: "none" }}>{contactPhone}</a>}
                        {linkedInUrl && <a href={linkedInUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#0075EB", textDecoration: "none" }}>LinkedIn</a>}
                      </div>
                    )}
                    {lushaStatus && (
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>
                        Lusha: {String(lushaStatus).replace(/_/g, " ")}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: s.confidence_level === "high" ? "#0a8754" : s.confidence_level === "medium" ? "#c27b00" : "#6b7280" }}>{s.final_score}</div>
                    <div style={{ fontSize: 11, color: "#888", textTransform: "capitalize" }}>{s.confidence_level}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "#888" }}>
            {waitingForAnalysis
              ? "Analysis is running. Stakeholder recommendations will populate automatically."
              : analysisFailed
                ? "Last analysis failed. Run review to refresh stakeholders."
                : "No automated stakeholder recommendations yet."}
          </div>
        )}
      </div>

      <div style={{ background: "#fff", border: "1px solid #e6ecf2", borderRadius: 6, padding: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 6 }}>Supplementary context integrations</div>
        {supplementaryLoading && <div style={{ fontSize: 12, color: "#888" }}>Loading context...</div>}
        {!supplementaryLoading && supplementary && (
          <div>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>
              News: {supplementary.integrations?.news_lookup?.configured ? "configured" : "disabled"} ({supplementary.integrations?.news_lookup?.signals_found || 0} signals) | LinkedIn research: {supplementary.integrations?.linkedin_research?.signals_found || 0} targets | Lusha: {supplementary.integrations?.lusha?.configured ? "configured" : "not configured"} ({supplementary.integrations?.lusha?.signals_found || 0} matches)
            </div>
            {supplementary.news_signals?.length > 0 && (
              <div style={{ fontSize: 12, color: "#444", marginBottom: 4 }}>
                <strong>Latest news:</strong> {supplementary.news_signals[0].title}
              </div>
            )}
            {supplementary.mna_signals?.length > 0 && (
              <div style={{ fontSize: 12, color: "#444" }}>
                <strong>M&A signals:</strong> {supplementary.mna_signals.slice(0, 2).map((s) => s.signal).join(", ")}
              </div>
            )}
            {supplementary.value_nuggets?.length > 0 && (
              <div style={{ fontSize: 12, color: "#444", marginTop: 6 }}>
                <strong>Value nuggets:</strong>
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                  {supplementary.value_nuggets.slice(0, 3).map((item, idx) => (
                    <div key={`stakeholder-nugget-${idx}`}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#374151", background: "#eef2ff", borderRadius: 999, padding: "2px 7px", textTransform: "uppercase", marginRight: 6 }}>
                        {item.type || "signal"}
                      </span>
                      <span>{item.nugget}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleAdd} style={{ background: "#f8f9fb", borderRadius: 6, padding: 14, marginBottom: 14, border: "1px solid #e0e3e8" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Name *</label>
              <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Jane Smith" /></div>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Role</label>
              <input style={inputStyle} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="e.g. CFO" /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Email</label>
              <input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@company.com" /></div>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>LinkedIn</label>
              <input style={inputStyle} value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} placeholder="https://linkedin.com/in/..." /></div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Notes</label>
            <input style={inputStyle} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Decision maker, interests, etc." />
          </div>
          <button type="submit" disabled={submitting || !form.name.trim()} style={{
            padding: "6px 18px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff",
            fontWeight: 600, fontSize: 13, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.6 : 1,
          }}>
            {submitting ? "Saving…" : "Add Contact"}
          </button>
        </form>
      )}

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {manualStakeholders.length === 0 && automatedStakeholders.length === 0 && !showForm && (
        <div style={{ color: "#888", fontSize: 13 }}>
          {waitingForAnalysis
            ? "No stakeholder data yet. Analysis is still processing and will add recommendations automatically."
            : "No stakeholder data. Click \"Add Contact\" to start building your contact map."}
        </div>
      )}

      {manualStakeholders.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {manualStakeholders.map((s, idx) => (
            <div key={idx} style={{ padding: "12px 14px", background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0", position: "relative" }}>
              {companyId && s.source !== "analysis" && (
                <button onClick={() => handleDelete(s, idx)} style={{
                  position: "absolute", top: 8, right: 8, border: "none", background: "none",
                  color: "#ccc", cursor: "pointer", fontSize: 16, padding: 0,
                }} title="Remove">×</button>
              )}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</span>
                {s.role && <span style={{ fontSize: 11, color: "#0075EB", background: "#eff6ff", padding: "1px 8px", borderRadius: 8, fontWeight: 500 }}>{s.role}</span>}
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#888", marginBottom: s.notes ? 6 : 0 }}>
                {s.email && <a href={`mailto:${s.email}`} style={{ color: "#0075EB", textDecoration: "none" }}>{s.email}</a>}
                {s.linkedin && <a href={s.linkedin} target="_blank" rel="noopener noreferrer" style={{ color: "#0075EB", textDecoration: "none" }}>LinkedIn</a>}
              </div>
              {s.notes && <div style={{ fontSize: 13, color: "#555" }}>{s.notes}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

StakeholderPanel.propTypes = {
  stakeholders: PropTypes.array,
  stakeholderAssessment: PropTypes.object,
  companyId: PropTypes.string,
  onUpdated: PropTypes.func,
  analysisStatus: PropTypes.string,
};
