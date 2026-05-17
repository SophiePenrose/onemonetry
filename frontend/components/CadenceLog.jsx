import React from "react";
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

function formatDate(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export default function CadenceLog({ cadenceHistory }) {
  if (!cadenceHistory || cadenceHistory.length === 0) {
    return (
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Communication History</h3>
        <div style={{ color: "#888", fontSize: 13 }}>No communication history yet.</div>
      </div>
    );
  }

  const sorted = [...cadenceHistory].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>
        Communication History
        <span style={{ fontWeight: 400, color: "#888", fontSize: 13, marginLeft: 8 }}>
          {cadenceHistory.length} {cadenceHistory.length === 1 ? "touchpoint" : "touchpoints"}
        </span>
      </h3>
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
                <span style={{
                  fontSize: 11, fontWeight: 600, color: tm.color,
                  background: "#f0f2f5", padding: "1px 8px", borderRadius: 8,
                }}>
                  {tm.icon} {tm.label}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 500, color: om.color,
                  background: om.bg, padding: "1px 8px", borderRadius: 8,
                }}>
                  {om.label}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "#555" }}>{entry.summary}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

CadenceLog.propTypes = {
  cadenceHistory: PropTypes.arrayOf(PropTypes.shape({
    date: PropTypes.string.isRequired,
    type: PropTypes.string.isRequired,
    summary: PropTypes.string.isRequired,
    outcome: PropTypes.string,
  })),
};
