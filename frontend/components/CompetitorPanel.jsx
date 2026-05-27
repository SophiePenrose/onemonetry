import React, { useState } from "react";
import PropTypes from "prop-types";

const STRENGTH_META = {
  strong: { label: "Strong", color: "#c0392b", bg: "#fee2e2" },
  medium: { label: "Medium", color: "#92400e", bg: "#fef3c7" },
  weak: { label: "Weak", color: "#0a8754", bg: "#d1fae5" },
  absent: { label: "None", color: "#6b7280", bg: "#f3f4f6" },
};

export default function CompetitorPanel({ competitors, companyId, onUpdated, analysisStatus }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", product: "", strength: "medium", notes: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const waitingForAnalysis = analysisStatus === "queued";
  const analysisFailed = analysisStatus === "failed";

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/competitors`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm({ name: "", product: "", strength: "medium", notes: "" });
        setShowForm(false);
        if (onUpdated) onUpdated();
      } else {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to add competitor");
      }
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  async function handleDelete(competitor, idx) {
    if (!confirm("Remove this stack entry?")) return;
    setError(null);
    try {
      const deleteIdx = competitor._manual_index ?? idx;
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/competitors/${deleteIdx}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove competitor");
      }
      if (onUpdated) onUpdated();
    } catch (err) { setError(err.message); }
  }

  const inputStyle = { width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Current Tech Stack</h3>
        {companyId && (
          <button onClick={() => setShowForm(!showForm)} style={{
            padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: showForm ? "#f3f4f6" : "#0075EB", color: showForm ? "#555" : "#fff",
          }}>
            {showForm ? "Cancel" : "+ Add Stack Entry"}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleAdd} style={{ background: "#f8f9fb", borderRadius: 6, padding: 14, marginBottom: 14, border: "1px solid #e0e3e8" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Provider / Tool *</label>
              <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Worldpay" /></div>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Category</label>
              <input style={inputStyle} value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} placeholder="e.g. Merchant Acquiring" /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 10 }}>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Strength</label>
              <select style={inputStyle} value={form.strength} onChange={(e) => setForm({ ...form, strength: e.target.value })}>
                <option value="strong">Strong</option>
                <option value="medium">Medium</option>
                <option value="weak">Weak</option>
                <option value="absent">None / Greenfield</option>
              </select>
            </div>
            <div><label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Notes</label>
              <input style={inputStyle} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Pricing, switching cost, embed depth..." /></div>
          </div>
          <button type="submit" disabled={submitting || !form.name.trim()} style={{
            padding: "6px 18px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff",
            fontWeight: 600, fontSize: 13, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.6 : 1,
          }}>
            {submitting ? "Saving…" : "Add Stack Entry"}
          </button>
        </form>
      )}

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {(!competitors || competitors.length === 0) && !showForm && (
        <div style={{ color: "#888", fontSize: 13 }}>
          {waitingForAnalysis
            ? "Tech stack inference is in progress. Entries should appear automatically once analysis completes."
            : analysisFailed
              ? "Stack inference failed on last run. Add entries manually now, then rerun analysis later."
              : "No stack data. Click \"Add Stack Entry\" to map the current provider setup."}
        </div>
      )}

      {competitors && competitors.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {competitors.map((c, idx) => {
            const sm = STRENGTH_META[c.strength] || STRENGTH_META.medium;
            return (
              <div key={idx} style={{ display: "flex", gap: 12, padding: "10px 12px", background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0", position: "relative" }}>
                {companyId && c.source !== "analysis" && c.source !== "filing" && (
                  <button onClick={() => handleDelete(c, idx)} style={{
                    position: "absolute", top: 6, right: 8, border: "none", background: "none",
                    color: "#ccc", cursor: "pointer", fontSize: 16, padding: 0,
                  }} title="Remove">×</button>
                )}
                <div style={{ minWidth: 120 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{c.product}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: "#555" }}>{c.notes}</div>
                  {c.snippet && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#666", background: "#fff", border: "1px solid #eceff3", borderRadius: 6, padding: "6px 8px" }}>
                      "{c.snippet}"
                    </div>
                  )}
                  {c.inferred_advantage && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#0b3b74", background: "#eff6ff", borderRadius: 6, padding: "6px 8px" }}>
                      Inferred advantage: {c.inferred_advantage}
                    </div>
                  )}
                </div>
                <div style={{ flexShrink: 0 }}>
                  <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 10, fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg }}>
                    {sm.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

CompetitorPanel.propTypes = {
  competitors: PropTypes.array,
  companyId: PropTypes.string,
  onUpdated: PropTypes.func,
  analysisStatus: PropTypes.string,
};
