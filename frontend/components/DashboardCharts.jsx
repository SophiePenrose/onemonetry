import React from "react";
import PropTypes from "prop-types";

const FUNNEL_STAGES = [
  { id: "new_candidate", label: "New Candidate", color: "#6c757d" },
  { id: "shortlisted", label: "Shortlisted", color: "#0075EB" },
  { id: "selected_for_outreach", label: "Outreach", color: "#6f42c1" },
  { id: "in_cadence", label: "In Cadence", color: "#e67e22" },
  { id: "active_opportunity", label: "Active Opp", color: "#20c997" },
  { id: "closed_won", label: "Won", color: "#0a8754" },
];

export function PipelineFunnel({ pipeline }) {
  const max = Math.max(...FUNNEL_STAGES.map((s) => pipeline[s.id]?.count || 0), 1);

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <h4 style={{ margin: "0 0 14px", fontSize: 15 }}>Pipeline Funnel</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {FUNNEL_STAGES.map((stage, idx) => {
          const count = pipeline[stage.id]?.count || 0;
          const width = count > 0 ? Math.max((count / max) * 100, 8) : 0;
          const maxWidth = 100 - idx * 8;
          return (
            <div key={stage.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, color: "#888", minWidth: 80, textAlign: "right" }}>{stage.label}</span>
              <div style={{ flex: 1, position: "relative" }}>
                <div style={{
                  height: 28, borderRadius: 4,
                  background: stage.color,
                  width: `${Math.min(width, maxWidth)}%`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "width 0.5s ease",
                  minWidth: count > 0 ? 32 : 0,
                }}>
                  {count > 0 && (
                    <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>{count}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

PipelineFunnel.propTypes = { pipeline: PropTypes.object.isRequired };

export function ScoreDistribution({ companies }) {
  if (!companies || companies.length === 0) return null;

  const buckets = [
    { label: "0.8+", min: 0.8, max: 1.01, color: "#0a8754" },
    { label: "0.7-0.8", min: 0.7, max: 0.8, color: "#0075EB" },
    { label: "0.6-0.7", min: 0.6, max: 0.7, color: "#e67e22" },
    { label: "0.5-0.6", min: 0.5, max: 0.6, color: "#6b7280" },
    { label: "<0.5", min: 0, max: 0.5, color: "#c0392b" },
  ];

  const counts = buckets.map((b) => ({
    ...b,
    count: companies.filter((c) => c.combined_score >= b.min && c.combined_score < b.max).length,
  }));

  const maxCount = Math.max(...counts.map((c) => c.count), 1);

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <h4 style={{ margin: "0 0 14px", fontSize: 15 }}>Score Distribution</h4>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
        {counts.map((bucket) => (
          <div key={bucket.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{bucket.count}</span>
            <div style={{
              width: "100%", borderRadius: "4px 4px 0 0",
              background: bucket.color,
              height: `${(bucket.count / maxCount) * 90}%`,
              minHeight: bucket.count > 0 ? 8 : 0,
              transition: "height 0.5s ease",
            }} />
            <span style={{ fontSize: 10, color: "#888", marginTop: 4, textAlign: "center" }}>{bucket.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

ScoreDistribution.propTypes = { companies: PropTypes.array };
