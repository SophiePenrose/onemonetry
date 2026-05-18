import React, { useState } from "react";
import PropTypes from "prop-types";

export default function StakeholderPanel({ stakeholders, companyId, onUpdated }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", role: "", email: "", linkedin: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/stakeholders`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm({ name: "", role: "", email: "", linkedin: "", notes: "" });
        setShowForm(false);
        if (onUpdated) onUpdated();
      }
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  }

  async function handleDelete(idx) {
    if (!confirm("Remove this stakeholder?")) return;
    try {
      await fetch(`/api/company/${encodeURIComponent(companyId)}/stakeholders/${idx}`, { method: "DELETE" });
      if (onUpdated) onUpdated();
    } catch { /* ignore */ }
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

      {(!stakeholders || stakeholders.length === 0) && !showForm && (
        <div style={{ color: "#888", fontSize: 13 }}>No stakeholder data. Click &quot;Add Contact&quot; to start building your contact map.</div>
      )}

      {stakeholders && stakeholders.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {stakeholders.map((s, idx) => (
            <div key={idx} style={{ padding: "12px 14px", background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0", position: "relative" }}>
              {companyId && (
                <button onClick={() => handleDelete(idx)} style={{
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
  companyId: PropTypes.string,
  onUpdated: PropTypes.func,
};
