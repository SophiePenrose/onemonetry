import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { PipelineFunnel, ScoreDistribution } from "../components/DashboardCharts";

const STATE_META = {
  new_candidate: { label: "New", color: "#6c757d" },
  shortlisted: { label: "Shortlisted", color: "#0075EB" },
  selected_for_outreach: { label: "Outreach", color: "#6f42c1" },
  in_cadence: { label: "In Cadence", color: "#e67e22" },
  active_opportunity: { label: "Active Opp", color: "#20c997" },
  closed_won: { label: "Won", color: "#0a8754" },
  closed_lost: { label: "Lost", color: "#c0392b" },
  revisit_later: { label: "Revisit", color: "#95a5a6" },
  held_for_review: { label: "Held", color: "#f39c12" },
};

function formatTurnover(value) {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function PipelineCard({ count, label, color }) {
  return (
    <div style={{
      background: "#fff", borderRadius: 8, padding: "14px 16px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", borderLeft: `4px solid ${color}`,
      minWidth: 110, flex: "1 1 0",
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{count}</div>
      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{label}</div>
    </div>
  );
}

PipelineCard.propTypes = { count: PropTypes.number.isRequired, label: PropTypes.string.isRequired, color: PropTypes.string.isRequired };

function MotionSummaryBar({ motionSummary }) {
  const motions = Object.entries(motionSummary)
    .filter(([, s]) => s.total > 0)
    .sort(([, a], [, b]) => b.avg_score - a.avg_score);

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {motions.map(([motion, s]) => (
        <div key={motion} style={{
          background: "#fff", borderRadius: 6, padding: "8px 14px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)", fontSize: 13,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontWeight: 600 }}>{motion}</span>
          <span style={{ color: "#888" }}>{s.total} co.</span>
          <span style={{ fontWeight: 600, color: "#0075EB" }}>{s.avg_score.toFixed(2)} avg</span>
        </div>
      ))}
    </div>
  );
}

MotionSummaryBar.propTypes = { motionSummary: PropTypes.object.isRequired };

function Badge({ text, bg }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 12,
      fontSize: 11, fontWeight: 600, color: "#fff", background: bg || "#888",
      whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

Badge.propTypes = { text: PropTypes.string.isRequired, bg: PropTypes.string };

export default function Home({ onNavigateToCompany }) {
  const [data, setData] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/dashboard").then((r) => r.json()),
      fetch("/api/unified-shortlist").then((r) => r.json()),
    ])
      .then(([dash, shortlist]) => {
        setData(dash);
        setCompanies(shortlist.companies || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: "#888", padding: 24 }}>Loading dashboard…</div>;
  if (!data) return <div style={{ color: "#c0392b", padding: 24 }}>Failed to load dashboard.</div>;

  const pipelineOrder = ["shortlisted", "selected_for_outreach", "in_cadence", "active_opportunity", "closed_won"];
  const secondaryStates = ["new_candidate", "closed_lost", "revisit_later", "held_for_review"];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Workspace</h2>
        <span style={{ color: "#888", fontSize: 14 }}>{data.total_companies} companies in universe</span>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10 }}>Pipeline</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {pipelineOrder.map((stateId) => {
            const p = data.pipeline[stateId];
            return p ? <PipelineCard key={stateId} count={p.count} label={p.label} color={p.color} /> : null;
          })}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {secondaryStates.map((stateId) => {
            const p = data.pipeline[stateId];
            return p ? <PipelineCard key={stateId} count={p.count} label={p.label} color={p.color} /> : null;
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 24 }}>
        <PipelineFunnel pipeline={data.pipeline} />
        <ScoreDistribution companies={companies} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10 }}>Motion Coverage</div>
        <MotionSummaryBar motionSummary={data.motion_summary} />
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10 }}>
          Active Prospects
          {data.active_prospects.length > 0 && (
            <span style={{ fontWeight: 400, color: "#888", marginLeft: 8 }}>
              {data.active_prospects.length} in play
            </span>
          )}
        </div>

        {data.active_prospects.length === 0 ? (
          <div style={{
            background: "#fff", borderRadius: 8, padding: 32, textAlign: "center",
            color: "#888", boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            <div style={{ fontSize: 14 }}>No active prospects yet</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Go to the Shortlist tab and start shortlisting companies.</div>
          </div>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <thead>
              <tr style={{ background: "#f0f2f5", textAlign: "left", fontSize: 13, color: "#555" }}>
                <th style={{ padding: "10px 16px" }}>Company</th>
                <th style={{ padding: "10px 16px" }}>Industry</th>
                <th style={{ padding: "10px 16px", textAlign: "right" }}>Turnover</th>
                <th style={{ padding: "10px 16px", textAlign: "center" }}>Status</th>
                <th style={{ padding: "10px 16px" }}>Best Motion</th>
                <th style={{ padding: "10px 16px", textAlign: "right" }}>Score</th>
                <th style={{ padding: "10px 16px", textAlign: "center" }}>Motions</th>
              </tr>
            </thead>
            <tbody>
              {data.active_prospects.map((p) => {
                const sm = STATE_META[p.workflow_state] || STATE_META.new_candidate;
                return (
                  <tr
                    key={p.id}
                    style={{ borderBottom: "1px solid #eee", cursor: "pointer" }}
                    onClick={() => onNavigateToCompany && onNavigateToCompany(p.id)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f9fb")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "10px 16px", fontWeight: 600 }}>
                      <a href="#" onClick={(e) => { e.preventDefault(); onNavigateToCompany && onNavigateToCompany(p.id); }} style={{ color: "#0075EB", textDecoration: "none" }}>
                        {p.name}
                      </a>
                    </td>
                    <td style={{ padding: "10px 16px", color: "#666", fontSize: 13 }}>{p.industry}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13 }}>{formatTurnover(p.turnover)}</td>
                    <td style={{ padding: "10px 16px", textAlign: "center" }}><Badge text={sm.label} bg={sm.color} /></td>
                    <td style={{ padding: "10px 16px", fontSize: 13 }}>{p.best_motion}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontWeight: 600 }}>{p.best_score.toFixed(2)}</td>
                    <td style={{ padding: "10px 16px", textAlign: "center", fontSize: 13 }}>{p.motion_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

Home.propTypes = {
  onNavigateToCompany: PropTypes.func,
};
