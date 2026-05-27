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
  const [turnoverBand, setTurnoverBand] = useState("all");
  const [sortBy, setSortBy] = useState("turnover");
  const [sortDir, setSortDir] = useState("desc");
  const [companySearch, setCompanySearch] = useState("");
  const [landingCompanies, setLandingCompanies] = useState([]);
  const [landingLoading, setLandingLoading] = useState(false);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLandingCompanies(d.top_companies || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLandingLoading(true);
    const params = new URLSearchParams({
      limit: "150",
      sort_by: sortBy,
      sort_dir: sortDir,
      turnover_band: turnoverBand,
    });

    fetch(`/api/unified-shortlist?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        setLandingCompanies(d.companies || []);
      })
      .catch(() => {})
      .finally(() => setLandingLoading(false));
  }, [turnoverBand, sortBy, sortDir]);

  if (loading) return <div style={{ color: "#888", padding: 24 }}>Loading dashboard…</div>;
  if (!data) return <div style={{ color: "#c0392b", padding: 24 }}>Failed to load dashboard.</div>;

  const turnoverDist = data.turnover_distribution || {};
  const filteredLandingCompanies = companySearch.trim()
    ? landingCompanies.filter((c) =>
        String(c.name || "").toLowerCase().includes(companySearch.toLowerCase())
        || String(c.company_number || "").toLowerCase().includes(companySearch.toLowerCase())
      )
    : landingCompanies;
  const visibleLandingCompanies = filteredLandingCompanies.slice(0, 20);

  function handleColumnSort(field) {
    if (sortBy === field) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
      return;
    }
    setSortBy(field);
    setSortDir("desc");
  }

  function renderSortLabel(field, label) {
    if (sortBy !== field) return label;
    return `${label} ${sortDir === "desc" ? "↓" : "↑"}`;
  }

  const headerButtonStyle = {
    border: "none",
    background: "none",
    padding: 0,
    margin: 0,
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
  };

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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <h4 style={{ margin: 0, fontSize: 15 }}>Landing List by Turnover</h4>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              placeholder="Search company number or name"
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, minWidth: 220 }}
            />
            <select
              value={turnoverBand}
              onChange={(e) => setTurnoverBand(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" }}
            >
              <option value="all">All turnover bands</option>
              <option value="15-25">£15M-£25M</option>
              <option value="25-50">£25M-£50M</option>
              <option value="50-100">£50M-£100M</option>
              <option value="100-500">£100M-£500M</option>
              <option value="500+">£500M+</option>
            </select>
            <button
              onClick={() => setSortDir((prev) => (prev === "desc" ? "asc" : "desc"))}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 13 }}
            >
              {sortBy} · {sortDir === "desc" ? "↓ Desc" : "↑ Asc"}
            </button>
          </div>
        </div>
        {landingLoading ? (
          <div style={{ background: "#fff", borderRadius: 8, padding: 18, color: "#888" }}>Refreshing landing list…</div>
        ) : visibleLandingCompanies.length > 0 ? (
          <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <thead>
              <tr style={{ background: "#f0f2f5", textAlign: "left", fontSize: 13, color: "#555" }}>
                <th style={{ padding: "10px 16px" }}>#</th>
                <th style={{ padding: "10px 16px" }}>
                  <button type="button" onClick={() => handleColumnSort("name")} style={headerButtonStyle}>
                    {renderSortLabel("name", "Company")}
                  </button>
                </th>
                <th style={{ padding: "10px 16px", textAlign: "center" }}>
                  <button type="button" onClick={() => handleColumnSort("segment")} style={headerButtonStyle}>
                    {renderSortLabel("segment", "Segment")}
                  </button>
                </th>
                <th style={{ padding: "10px 16px", textAlign: "right" }}>
                  <button type="button" onClick={() => handleColumnSort("turnover")} style={headerButtonStyle}>
                    {renderSortLabel("turnover", "Turnover")}
                  </button>
                </th>
                <th style={{ padding: "10px 16px", textAlign: "center" }}>
                  <button type="button" onClick={() => handleColumnSort("filing_count")} style={headerButtonStyle}>
                    {renderSortLabel("filing_count", "Filings")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleLandingCompanies.map((c, idx) => (
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
            No companies match the selected turnover band/search.
          </div>
        )}
      </div>
    </div>
  );
}

Home.propTypes = {
  onNavigateToCompany: PropTypes.func,
};
