import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";

function formatTurnover(value) {
  if (value >= 1_000_000_000) return `£${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86400000));
}

function filingAgeLabel(value) {
  const days = daysSince(value);
  if (days === null) return "Unknown";
  if (days < 1) return "Today";
  return `${days}d`;
}

function inferSourceBucket(source, latestFilingDate) {
  const raw = String(source || "").toLowerCase();
  const filingAge = daysSince(latestFilingDate);

  if (raw.includes("csv")) return "3";
  if (raw.startsWith("daily:")) return "2";
  if (raw.startsWith("monthly:")) {
    if (filingAge !== null && filingAge > 120) return "1a";
    return "1b";
  }
  if (raw.includes("backfill") || raw.includes("bulk")) return "1a";
  if (raw.includes("scheduled")) return "1b";

  return "?";
}

function sourceBucketForCompany(company) {
  const explicit = String(company?.source_type || "").trim();
  if (explicit) return explicit;
  return inferSourceBucket(company?.source, company?.latest_filing_date);
}

const SOURCE_META = {
  "1a": { label: "1a", color: "#475569", title: "Monthly bulk backfill" },
  "1b": { label: "1b", color: "#0f766e", title: "Monthly scheduled filings" },
  "2": { label: "2", color: "#2563eb", title: "Twice-weekly filings" },
  "3": { label: "3", color: "#9333ea", title: "Mid-market CSV pipeline" },
  "?": { label: "?", color: "#6b7280", title: "Unknown source" },
};

function StatCard({ label, value, color, sub }) {
  return (
    <div className="dashboard-stat-card" style={{ "--stat-accent": color || "#0075EB" }}>
      <div className="dashboard-stat-value">{value}</div>
      <div className="dashboard-stat-label">{label}</div>
      {sub && <div className="dashboard-stat-sub">{sub}</div>}
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
  const [sourceFilter, setSourceFilter] = useState("all");
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
  const sourceFilteredLandingCompanies = sourceFilter === "all"
    ? landingCompanies
    : landingCompanies.filter((c) => sourceBucketForCompany(c) === sourceFilter);

  const filteredLandingCompanies = companySearch.trim()
    ? sourceFilteredLandingCompanies.filter((c) =>
        String(c.name || "").toLowerCase().includes(companySearch.toLowerCase())
        || String(c.company_number || "").toLowerCase().includes(companySearch.toLowerCase())
      )
    : sourceFilteredLandingCompanies;
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
    <div className="dashboard-page">
      <div className="dashboard-page-header">
        <h2 className="dashboard-page-title">All Companies</h2>
        <span className="dashboard-page-subtitle">
          {data.total_companies?.toLocaleString()} mid-market companies · {data.total_filings?.toLocaleString()} filings
        </span>
      </div>

      <div className="dashboard-stat-grid">
        <StatCard label="Mid-Market Companies" value={data.total_companies?.toLocaleString()} color="#0075EB" sub={`£${(data.threshold / 1e6).toFixed(0)}M+ turnover`} />
        <StatCard label="Total Filings" value={data.total_filings?.toLocaleString()} color="#0a8754" />
        <StatCard label="Monitored" value={data.total_monitored?.toLocaleString()} color="#6f42c1" sub="Tracked for new filings" />
        <StatCard label="Below Threshold" value={data.monitor_stats?.below_threshold || 0} color="#e67e22" sub="Previously £15M+, now lower" />
      </div>

      <div className="dashboard-insights-grid">
        <div className="dashboard-panel">
          <h4 className="dashboard-panel-title">Turnover Distribution</h4>
          {Object.entries(turnoverDist).map(([label, bucket]) => {
            const maxCount = Math.max(...Object.values(turnoverDist).map((b) => b.count), 1);
            const width = (bucket.count / maxCount) * 100;
            return (
              <div key={label} className="turnover-row">
                <span className="turnover-label">{label}</span>
                <div className="turnover-track">
                  <div className="turnover-fill" style={{ width: `${Math.max(width, bucket.count > 0 ? 3 : 0)}%` }}>
                    {bucket.count > 0 && <span className="turnover-count">{bucket.count}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="dashboard-panel">
          <h4 className="dashboard-panel-title">Data Pipeline</h4>
          <div className="pipeline-list">
            <div className="pipeline-item">
              <span>Active companies</span>
              <span className="pipeline-value">{data.monitor_stats?.active?.toLocaleString()}</span>
            </div>
            <div className="pipeline-item">
              <span>Inactive / Dissolved</span>
              <span className="pipeline-value">{data.monitor_stats?.inactive || 0}</span>
            </div>
            <div className="pipeline-item">
              <span>No filings found</span>
              <span className="pipeline-value">{data.monitor_stats?.no_filings || 0}</span>
            </div>
            <div className="pipeline-item">
              <span>Needs weekly check</span>
              <span className="pipeline-value">{data.monitor_stats?.needs_check?.toLocaleString()}</span>
            </div>
            <div className="pipeline-item">
              <span>Threshold</span>
              <span className="pipeline-value">£{(data.threshold / 1e6).toFixed(0)}M+</span>
            </div>
          </div>
        </div>
      </div>

      <div className="dashboard-table-section">
        <div className="dashboard-list-header">
          <h4 className="dashboard-section-title">Landing List by Turnover</h4>
          <div className="dashboard-controls">
            <input
              type="text"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              placeholder="Search company number or name"
              className="dashboard-control dashboard-control-search"
            />
            <select
              value={turnoverBand}
              onChange={(e) => setTurnoverBand(e.target.value)}
              className="dashboard-control"
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
              className="dashboard-control dashboard-control-button"
            >
              {sortBy} · {sortDir === "desc" ? "↓ Desc" : "↑ Asc"}
            </button>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="dashboard-control"
            >
              <option value="all">All sources</option>
              <option value="1a">Source 1a</option>
              <option value="1b">Source 1b</option>
              <option value="2">Source 2</option>
              <option value="3">Source 3</option>
            </select>
          </div>
        </div>
        {landingLoading ? (
          <div className="dashboard-table-placeholder">Refreshing landing list…</div>
        ) : visibleLandingCompanies.length > 0 ? (
          <div className="table-shell">
            <table className="data-table interactive-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>
                  <button type="button" onClick={() => handleColumnSort("name")} style={headerButtonStyle}>
                    {renderSortLabel("name", "Company")}
                  </button>
                  </th>
                  <th className="align-center">
                  <button type="button" onClick={() => handleColumnSort("segment")} style={headerButtonStyle}>
                    {renderSortLabel("segment", "Segment")}
                  </button>
                  </th>
                  <th className="align-right">
                  <button type="button" onClick={() => handleColumnSort("turnover")} style={headerButtonStyle}>
                    {renderSortLabel("turnover", "Turnover")}
                  </button>
                  </th>
                  <th className="align-center">Source</th>
                  <th className="align-center">Filed</th>
                  <th className="align-center">
                  <button type="button" onClick={() => handleColumnSort("filing_count")} style={headerButtonStyle}>
                    {renderSortLabel("filing_count", "Filings")}
                  </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleLandingCompanies.map((c, idx) => {
                  const segmentClass = c.segment === "Enterprise"
                    ? "segment-pill-enterprise"
                    : c.segment === "Mid-Market"
                      ? "segment-pill-midmarket"
                      : "segment-pill-smb";

                  return (
                    <tr
                      key={c.id}
                      onClick={onNavigateToCompany ? () => onNavigateToCompany(c.id) : undefined}
                    >
                      <td className="row-index">{idx + 1}</td>
                      <td>
                        <button
                          type="button"
                          className="table-link-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToCompany && onNavigateToCompany(c.id);
                          }}
                        >
                          {c.name}
                        </button>
                        <div className="company-subtext">{c.company_number}</div>
                      </td>
                      <td className="align-center">
                        <span className={`segment-pill ${segmentClass}`}>
                          {c.segment === "Enterprise" ? "ENT" : c.segment === "Mid-Market" ? "MM" : "SMB"}
                        </span>
                      </td>
                      <td className="align-right row-strong">{formatTurnover(c.turnover)}</td>
                      <td className="align-center">
                    {(() => {
                      const sourceBucket = sourceBucketForCompany(c);
                      const sourceMeta = SOURCE_META[sourceBucket] || SOURCE_META["?"];
                      const sourceTitle = c.source_family ? String(c.source_family).replaceAll("_", " ") : sourceMeta.title;
                      return (
                        <span
                          title={sourceTitle}
                          className="source-pill"
                          style={{ background: sourceMeta.color }}
                        >
                          {sourceMeta.label}
                        </span>
                      );
                    })()}
                      </td>
                      <td className="align-center row-muted">{filingAgeLabel(c.latest_filing_date)}</td>
                      <td className="align-center">{c.filing_count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dashboard-table-placeholder">
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
