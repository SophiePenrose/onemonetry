import React, { useState } from "react";
import PropTypes from "prop-types";

const TYPE_META = {
  email: { icon: "✉", color: "#0075EB", label: "Email" },
  call: { icon: "☎", color: "#6f42c1", label: "Call" },
  meeting: { icon: "🤝", color: "#0a8754", label: "Meeting" },
};

const OUTCOME_META = {
  positive: { label: "Positive", color: "#0a8754", bg: "#d1fae5" },
  neutral: { label: "Neutral", color: "#6b7280", bg: "#f3f4f6" },
  replied: { label: "Replied", color: "#0075EB", bg: "#eff6ff" },
  opened: { label: "Opened", color: "#92400e", bg: "#fef3c7" },
  no_reply: { label: "No Reply", color: "#9ca3af", bg: "#f3f4f6" },
  pending: { label: "Pending", color: "#e67e22", bg: "#fff7ed" },
};

const OUTCOMES = ["positive", "neutral", "replied", "opened", "no_reply", "pending"];

function formatDate(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export default function CadenceLog({ cadenceHistory, companyId, onEntryAdded }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), type: "email", summary: "", outcome: "pending" });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.summary.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/cadence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm({ date: new Date().toISOString().slice(0, 10), type: "email", summary: "", outcome: "pending" });
        setShowForm(false);
        if (onEntryAdded) onEntryAdded();
      }
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  }

  const sorted = [...(cadenceHistory || [])].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>
          Communication History
          <span style={{ fontWeight: 400, color: "#888", fontSize: 13, marginLeft: 8 }}>
            {sorted.length} {sorted.length === 1 ? "touchpoint" : "touchpoints"}
          </span>
        </h3>
        {companyId && (
          <button onClick={() => setShowForm(!showForm)} style={{
            padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: showForm ? "#f3f4f6" : "#0075EB", color: showForm ? "#555" : "#fff",
          }}>
            {showForm ? "Cancel" : "+ Log Activity"}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} style={{ background: "#f8f9fb", borderRadius: 6, padding: 14, marginBottom: 14, border: "1px solid #e0e3e8" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 600, display: "block", marginBottom: 4 }}>Date</label>
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 600, display: "block", marginBottom: 4 }}>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" }}>
                <option value="email">Email</option>
                <option value="call">Call</option>
                <option value="meeting">Meeting</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 600, display: "block", marginBottom: 4 }}>Outcome</label>
              <select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}
                style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" }}>
                {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_META[o].label}</option>)}
              </select>
            </div>
          </div>
          <textarea placeholder="What happened?" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })}
            rows={2} style={{ width: "100%", padding: "8px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, resize: "vertical", boxSizing: "border-box", marginBottom: 10 }} />
          <button type="submit" disabled={submitting || !form.summary.trim()} style={{
            padding: "6px 18px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff",
            fontWeight: 600, fontSize: 13, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.6 : 1,
          }}>
            {submitting ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      {sorted.length === 0 && !showForm && (
        <div style={{ color: "#888", fontSize: 13 }}>No communication history yet. Click &quot;Log Activity&quot; to add the first entry.</div>
      )}

      {sorted.length > 0 && (
        <div style={{ borderLeft: "2px solid #e0e3e8", paddingLeft: 16 }}>
          {sorted.map((entry, idx) => {
            const tm = TYPE_META[entry.type] || TYPE_META.email;
            const om = OUTCOME_META[entry.outcome] || OUTCOME_META.neutral;
            return (
              <div key={idx} style={{ marginBottom: idx < sorted.length - 1 ? 16 : 0, position: "relative" }}>
                <div style={{
                  position: "absolute", left: -23, top: 2, width: 12, height: 12,
                  borderRadius: "50%", background: tm.color, border: "2px solid #fff",
                }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, color: "#888" }}>{formatDate(entry.date)}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: tm.color, background: "#f0f2f5", padding: "1px 8px", borderRadius: 8 }}>
                    {tm.icon} {tm.label}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: om.color, background: om.bg, padding: "1px 8px", borderRadius: 8 }}>
                    {om.label}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#555" }}>{entry.summary}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

CadenceLog.propTypes = {
  cadenceHistory: PropTypes.array,
  companyId: PropTypes.string,
  onEntryAdded: PropTypes.func,
};
