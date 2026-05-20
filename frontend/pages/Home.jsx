import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";

function formatTurnover(value) {
  if (value >= 1_000_000_000) return `£${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{
      background: "#fff", borderRadius: 8, padding: "16px 18px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)", borderLeft: `4px solid ${color || "#0075EB"}`,
      flex: "1 1 0", minWidth: 140,
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || "#0075EB" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#aaa", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

StatCard.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.node.isRequired, color: PropTypes.string, sub: PropTypes.string };

export default function Home({ onNavigateToCompany }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: "#888", padding: 24 }}>Loading dashboard…</div>;
  if (!data) return <div style={{ color: "#c0392b", padding: 24 }}>Failed to load dashboard.</div>;

  const turnoverDist = data.turnover_distribution || {};

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Workspace</h2>
        <span style={{ color: "#888", fontSize: 14 }}>
          {data.total_companies?.toLocaleString()} mid-market companies · {data.total_filings?.toLocaleString()} filings
        </span>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
        <StatCard label="Mid-Market Companies" value={data.total_companies?.toLocaleString()} color="#0075EB" sub={`£${(data.threshold / 1e6).toFixed(0)}M+ turnover`} />
        <StatCard label="Total Filings" value={data.total_filings?.toLocaleString()} color="#0a8754" />
        <StatCard label="Monitored" value={data.total_monitored?.toLocaleString()} color="#6f42c1" sub="Tracked for new filings" />
        <StatCard label="Below Threshold" value={data.monitor_stats?.below_threshold || 0} color="#e67e22" sub="Previously £15M+, now lower" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 24 }}>
        <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <h4 style={{ margin: "0 0 14px", fontSize: 15 }}>Turnover Distribution</h4>
          {Object.entries(turnoverDist).map(([label, bucket]) => {
            const maxCount = Math.max(...Object.values(turnoverDist).map((b) => b.count), 1);
            const width = (bucket.count / maxCount) * 100;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: "#888", minWidth: 100, textAlign: "right" }}>{label}</span>
                <div style={{ flex: 1, background: "#f0f2f5", borderRadius: 4, height: 24, overflow: "hidden" }}>
                  <div style={{ width: `${Math.max(width, bucket.count > 0 ? 3 : 0)}%`, height: "100%", background: "#0075EB", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {bucket.count > 0 && <span style={{ color: "#fff", fontSize: 11, fontWeight: 600 }}>{bucket.count}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <h4 style={{ margin: "0 0 14px", fontSize: 15 }}>Data Pipeline</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
              <span style={{ color: "#888" }}>Active companies</span>
              <span style={{ fontWeight: 600 }}>{data.monitor_stats?.active?.toLocaleString()}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
              <span style={{ color: "#888" }}>Inactive / Dissolved</span>
              <span style={{ fontWeight: 600 }}>{data.monitor_stats?.inactive || 0}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
              <span style={{ color: "#888" }}>No filings found</span>
              <span style={{ fontWeight: 600 }}>{data.monitor_stats?.no_filings || 0}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
              <span style={{ color: "#888" }}>Needs weekly check</span>
              <span style={{ fontWeight: 600 }}>{data.monitor_stats?.needs_check?.toLocaleString()}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
              <span style={{ color: "#888" }}>Threshold</span>
              <span style={{ fontWeight: 600 }}>£{(data.threshold / 1e6).toFixed(0)}M+</span>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h4 style={{ margin: "0 0 12px", fontSize: 15 }}>Top Companies by Turnover</h4>
        {data.top_companies?.length > 0 ? (
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <thead>
              <tr style={{ background: "#f0f2f5", textAlign: "left", fontSize: 13, color: "#555" }}>
                <th style={{ padding: "10px 16px" }}>#</th>
                <th style={{ padding: "10px 16px" }}>Company</th>
                <th style={{ padding: "10px 16px", textAlign: "center" }}>Segment</th>
                <th style={{ padding: "10px 16px", textAlign: "right" }}>Turnover</th>
                <th style={{ padding: "10px 16px", textAlign: "center" }}>Filings</th>
              </tr>
            </thead>
            <tbody>
              {data.top_companies.map((c, idx) => (
                <tr
                  key={c.id}
                  style={{ borderBottom: "1px solid #eee", cursor: "pointer" }}
                  onClick={() => onNavigateToCompany && onNavigateToCompany(c.id)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f9fb")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "10px 16px", color: "#888", fontSize: 13 }}>{idx + 1}</td>
                  <td style={{ padding: "10px 16px", fontWeight: 600 }}>
                    <a href="#" onClick={(e) => { e.preventDefault(); onNavigateToCompany && onNavigateToCompany(c.id); }} style={{ color: "#0075EB", textDecoration: "none" }}>
                      {c.name}
                    </a>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{c.company_number}</div>
                  </td>
                  <td style={{ padding: "10px 16px", textAlign: "center" }}>
                    <span style={{
                      display: "inline-block", padding: "2px 8px", borderRadius: 10,
                      fontSize: 11, fontWeight: 600, color: "#fff",
                      background: c.segment === "Enterprise" ? "#6f42c1" : c.segment === "Mid-Market" ? "#0075EB" : "#6b7280",
                    }}>{c.segment === "Enterprise" ? "ENT" : c.segment === "Mid-Market" ? "MM" : "SMB"}</span>
                  </td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontWeight: 700, fontSize: 14 }}>{formatTurnover(c.turnover)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "center", fontSize: 13 }}>{c.filing_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ background: "#fff", borderRadius: 8, padding: 24, textAlign: "center", color: "#888" }}>
            No companies loaded yet. Import data from the Import tab.
          </div>
        )}
      </div>
    </div>
  );
}

Home.propTypes = {
  onNavigateToCompany: PropTypes.func,
};
