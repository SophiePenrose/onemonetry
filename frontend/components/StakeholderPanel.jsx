import React from "react";
import PropTypes from "prop-types";

export default function StakeholderPanel({ stakeholders }) {
  if (!stakeholders || stakeholders.length === 0) {
    return (
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Stakeholders</h3>
        <div style={{ color: "#888", fontSize: 13 }}>No stakeholder data available.</div>
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Stakeholders & Contacts</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {stakeholders.map((s, idx) => (
          <div key={idx} style={{ padding: "12px 14px", background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</span>
              <span style={{
                fontSize: 11, color: "#0075EB", background: "#eff6ff",
                padding: "1px 8px", borderRadius: 8, fontWeight: 500,
              }}>
                {s.role}
              </span>
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#888", marginBottom: s.notes ? 6 : 0 }}>
              {s.email && (
                <a href={`mailto:${s.email}`} style={{ color: "#0075EB", textDecoration: "none" }}>{s.email}</a>
              )}
              {s.linkedin && (
                <a href={s.linkedin} target="_blank" rel="noopener noreferrer" style={{ color: "#0075EB", textDecoration: "none" }}>LinkedIn</a>
              )}
            </div>
            {s.notes && <div style={{ fontSize: 13, color: "#555" }}>{s.notes}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

StakeholderPanel.propTypes = {
  stakeholders: PropTypes.arrayOf(PropTypes.shape({
    name: PropTypes.string.isRequired,
    role: PropTypes.string,
    email: PropTypes.string,
    linkedin: PropTypes.string,
    notes: PropTypes.string,
  })),
};
