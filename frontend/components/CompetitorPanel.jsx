import React from "react";
import PropTypes from "prop-types";

const STRENGTH_META = {
  strong: { label: "Strong", color: "#c0392b", bg: "#fee2e2" },
  medium: { label: "Medium", color: "#92400e", bg: "#fef3c7" },
  weak: { label: "Weak", color: "#0a8754", bg: "#d1fae5" },
  absent: { label: "None", color: "#6b7280", bg: "#f3f4f6" },
};

export default function CompetitorPanel({ competitors }) {
  if (!competitors || competitors.length === 0) {
    return (
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Competitors</h3>
        <div style={{ color: "#888", fontSize: 13 }}>No competitor data available.</div>
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Competitors</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {competitors.map((c, idx) => {
          const sm = STRENGTH_META[c.strength] || STRENGTH_META.medium;
          return (
            <div key={idx} style={{ display: "flex", gap: 12, padding: "10px 12px", background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0" }}>
              <div style={{ minWidth: 120 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{c.product}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "#555" }}>{c.notes}</div>
              </div>
              <div style={{ flexShrink: 0 }}>
                <span style={{
                  display: "inline-block", padding: "2px 10px", borderRadius: 10,
                  fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg,
                }}>
                  {sm.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

CompetitorPanel.propTypes = {
  competitors: PropTypes.arrayOf(PropTypes.shape({
    name: PropTypes.string.isRequired,
    product: PropTypes.string,
    strength: PropTypes.string,
    notes: PropTypes.string,
  })),
};
