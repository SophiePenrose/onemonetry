import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";

const VALID_MOTIONS = [
  "FX", "FX Forwards", "Cards", "Spend Management",
  "API Integrations", "Merchant Acquiring", "Revolut Pay", "Monthly Plans",
];

const SEGMENTS = ["SMB", "Mid-Market", "Enterprise"];

export default function AddCompany({ onCompanyAdded, onCancel }) {
  const [industries, setIndustries] = useState([]);
  const [form, setForm] = useState({
    name: "",
    company_number: "",
    industry: "",
    segment: "Mid-Market",
    turnover: "",
    employee_count: "",
    motions: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    fetch("/api/industries")
      .then((r) => r.json())
      .then((d) => setIndustries(d.industries || []))
      .catch(() => {});
  }, []);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function toggleMotion(motion) {
    setForm((prev) => ({
      ...prev,
      motions: prev.motions.includes(motion)
        ? prev.motions.filter((m) => m !== motion)
        : [...prev.motions, motion],
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.industry.trim()) {
      setError("Company name and industry are required.");
      return;
    }
    setSubmitting(true);
    setError(null);

    const productFit = {};
    for (const motion of form.motions) {
      productFit[motion] = {
        eligible: true,
        fit_level: "medium",
        explanation: `Manually added — ${motion} relevance to be assessed.`,
        layers: {
          product_fit: { score: 0.5, evidence: "Pending assessment" },
          commercial_value: { score: 0.5, evidence: "Pending assessment" },
          pain_strength: { score: 0.5, evidence: "Pending assessment" },
          urgency: { score: 0.5, evidence: "Pending assessment" },
          competitor_context: { score: 0.5, evidence: "Pending assessment" },
        },
      };
    }

    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          turnover: Number(form.turnover) || 0,
          employee_count: Number(form.employee_count) || 0,
          product_fit: productFit,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to add company");
      }
      const data = await res.json();
      setSuccess(`${data.company.name} added successfully.`);
      setForm({ name: "", company_number: "", industry: "", segment: "Mid-Market", turnover: "", employee_count: "", motions: [] });
      if (onCompanyAdded) onCompanyAdded(data.company);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle = {
    width: "100%", padding: "8px 12px", borderRadius: 6,
    border: "1px solid #ddd", fontSize: 14, boxSizing: "border-box",
  };

  const labelStyle = { fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 4, display: "block" };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Add Company</h2>
        {onCancel && (
          <button onClick={onCancel} style={{ padding: "6px 14px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
        )}
      </div>

      {success && (
        <div style={{ background: "#d1fae5", color: "#065f46", padding: "8px 14px", borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
          {success}
        </div>
      )}
      {error && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: "8px 14px", borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Company Name *</label>
            <input style={inputStyle} value={form.name} onChange={(e) => updateField("name", e.target.value)} placeholder="e.g. Acme Widgets Ltd" />
          </div>
          <div>
            <label style={labelStyle}>Company Number</label>
            <input style={inputStyle} value={form.company_number} onChange={(e) => updateField("company_number", e.target.value)} placeholder="e.g. 12345678" />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Industry *</label>
            <input
              style={inputStyle}
              list="industry-list"
              value={form.industry}
              onChange={(e) => updateField("industry", e.target.value)}
              placeholder="e.g. Manufacturing"
            />
            <datalist id="industry-list">
              {industries.map((i) => <option key={i} value={i} />)}
            </datalist>
          </div>
          <div>
            <label style={labelStyle}>Segment</label>
            <select style={inputStyle} value={form.segment} onChange={(e) => updateField("segment", e.target.value)}>
              {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Turnover (£)</label>
            <input style={inputStyle} type="number" value={form.turnover} onChange={(e) => updateField("turnover", e.target.value)} placeholder="e.g. 5000000" />
          </div>
          <div>
            <label style={labelStyle}>Employee Count</label>
            <input style={inputStyle} type="number" value={form.employee_count} onChange={(e) => updateField("employee_count", e.target.value)} placeholder="e.g. 50" />
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>Relevant Product Motions</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            {VALID_MOTIONS.map((m) => {
              const selected = form.motions.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleMotion(m)}
                  style={{
                    padding: "6px 14px", borderRadius: 16, fontSize: 13, fontWeight: 500,
                    border: selected ? "2px solid #0075EB" : "1px solid #ddd",
                    background: selected ? "#eff6ff" : "#fff",
                    color: selected ? "#0075EB" : "#555",
                    cursor: "pointer",
                  }}
                >
                  {selected ? "✓ " : ""}{m}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "10px 28px", borderRadius: 6, border: "none",
            background: "#0075EB", color: "#fff", fontWeight: 600,
            fontSize: 14, cursor: submitting ? "wait" : "pointer",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? "Adding…" : "Add Company"}
        </button>
      </form>
    </div>
  );
}

AddCompany.propTypes = {
  onCompanyAdded: PropTypes.func,
  onCancel: PropTypes.func,
};
