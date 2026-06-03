import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

const VALID_MOTIONS = [
  "FX", "FX Forwards", "Cards", "Spend Management",
  "API Integrations", "Merchant Acquiring", "Revolut Pay", "Monthly Plans",
];

const SEGMENTS = ["SMB", "Mid-Market", "Enterprise"];

const INPUT_STYLE = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #ddd",
  fontSize: 14,
  boxSizing: "border-box",
};

const LABEL_STYLE = {
  fontSize: 13,
  fontWeight: 600,
  color: "#555",
  marginBottom: 4,
  display: "block",
};

function createInitialForm() {
  return {
    name: "",
    company_number: "",
    industry: "",
    segment: "Mid-Market",
    turnover: "",
    employee_count: "",
    motions: [],
  };
}

function createDefaultLayers() {
  return {
    product_fit: { score: 0.5, evidence: "Pending assessment" },
    commercial_value: { score: 0.5, evidence: "Pending assessment" },
    pain_strength: { score: 0.5, evidence: "Pending assessment" },
    urgency: { score: 0.5, evidence: "Pending assessment" },
    competitor_context: { score: 0.5, evidence: "Pending assessment" },
  };
}

function buildProductFit(motions) {
  return (motions || []).reduce((accumulator, motion) => {
    accumulator[motion] = {
      eligible: true,
      fit_level: "medium",
      explanation: `Manually added — ${motion} relevance to be assessed.`,
      layers: createDefaultLayers(),
    };
    return accumulator;
  }, {});
}

export default function AddCompany({ onCompanyAdded, onCancel }) {
  const [industries, setIndustries] = useState([]);
  const [form, setForm] = useState(() => createInitialForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/industries", { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => setIndustries(Array.isArray(d.industries) ? d.industries : []))
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setIndustries([]);
        }
      });

    return () => controller.abort();
  }, []);

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const toggleMotion = useCallback((motion) => {
    setForm((prev) => ({
      ...prev,
      motions: prev.motions.includes(motion)
        ? prev.motions.filter((m) => m !== motion)
        : [...prev.motions, motion],
    }));
  }, []);

  const handleMotionToggle = useCallback((e) => {
    toggleMotion(e.currentTarget.dataset.motion);
  }, [toggleMotion]);

  const selectedMotions = useMemo(() => new Set(form.motions), [form.motions]);

  const fieldChangeHandlers = useMemo(() => ({
    name: (e) => updateField("name", e.target.value),
    companyNumber: (e) => updateField("company_number", e.target.value),
    industry: (e) => updateField("industry", e.target.value),
    segment: (e) => updateField("segment", e.target.value),
    turnover: (e) => updateField("turnover", e.target.value),
    employeeCount: (e) => updateField("employee_count", e.target.value),
  }), [updateField]);

  const industryOptions = useMemo(
    () => industries.map((industry) => <option key={industry} value={industry} />),
    [industries],
  );

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.industry.trim()) {
      setError("Company name and industry are required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    const productFit = buildProductFit(form.motions);

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
      setForm(createInitialForm());
      if (onCompanyAdded) onCompanyAdded(data.company);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }, [form, onCompanyAdded]);

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
            <label style={LABEL_STYLE}>Company Name *</label>
            <input style={INPUT_STYLE} value={form.name} onChange={fieldChangeHandlers.name} placeholder="e.g. Acme Widgets Ltd" />
          </div>
          <div>
            <label style={LABEL_STYLE}>Company Number</label>
            <input style={INPUT_STYLE} value={form.company_number} onChange={fieldChangeHandlers.companyNumber} placeholder="e.g. 12345678" />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={LABEL_STYLE}>Industry *</label>
            <input
              style={INPUT_STYLE}
              list="industry-list"
              value={form.industry}
              onChange={fieldChangeHandlers.industry}
              placeholder="e.g. Manufacturing"
            />
            <datalist id="industry-list">
              {industryOptions}
            </datalist>
          </div>
          <div>
            <label style={LABEL_STYLE}>Segment</label>
            <select style={INPUT_STYLE} value={form.segment} onChange={fieldChangeHandlers.segment}>
              {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={LABEL_STYLE}>Turnover (£)</label>
            <input style={INPUT_STYLE} type="number" value={form.turnover} onChange={fieldChangeHandlers.turnover} placeholder="e.g. 5000000" />
          </div>
          <div>
            <label style={LABEL_STYLE}>Employee Count</label>
            <input style={INPUT_STYLE} type="number" value={form.employee_count} onChange={fieldChangeHandlers.employeeCount} placeholder="e.g. 50" />
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={LABEL_STYLE}>Relevant Product Motions</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            {VALID_MOTIONS.map((m) => {
              const selected = selectedMotions.has(m);
              return (
                <button
                  key={m}
                  type="button"
                  data-motion={m}
                  onClick={handleMotionToggle}
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
