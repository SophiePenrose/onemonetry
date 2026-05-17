import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";

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

const FIT_COLORS = { strong: "#0a8754", medium: "#c27b00", weak: "#c0392b" };

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

function formatTurnover(value) {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function formatWeek(weekLabel) {
  const d = new Date(weekLabel + "T00:00:00");
  const end = new Date(d);
  end.setDate(d.getDate() + 4);
  const opts = { day: "numeric", month: "short" };
  return `${d.toLocaleDateString("en-GB", opts)} – ${end.toLocaleDateString("en-GB", opts)}, ${d.getFullYear()}`;
}

// --- Report List ---

function ReportList({ reports, onSelectReport, onGenerate, generating }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Weekly Reports</h2>
        <button
          onClick={onGenerate}
          disabled={generating}
          style={{
            padding: "8px 20px", borderRadius: 6, border: "none",
            background: "#0075EB", color: "#fff", fontWeight: 600,
            fontSize: 14, cursor: generating ? "wait" : "pointer",
            opacity: generating ? 0.6 : 1,
          }}
        >
          {generating ? "Generating…" : "Generate This Week's Report"}
        </button>
      </div>

      {reports.length === 0 ? (
        <div style={{
          background: "#fff", borderRadius: 8, padding: 32, textAlign: "center",
          color: "#888", boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14 }}>No reports generated yet</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Click the button above to generate your first weekly report.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reports.map((r) => (
            <div
              key={r.id}
              onClick={() => onSelectReport(r.id)}
              style={{
                background: "#fff", borderRadius: 8, padding: 16,
                boxShadow: "0 1px 3px rgba(0,0,0,0.06)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.12)")}
              onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)")}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>Week of {formatWeek(r.week_label)}</div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Generated {formatDate(r.generated_at)}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>{r.company_count}</div>
                  <div style={{ fontSize: 11, color: "#888" }}>companies</div>
                </div>
                {r.top_company && (
                  <div style={{ textAlign: "right", minWidth: 140 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{r.top_company}</div>
                    <div style={{ fontSize: 11, color: "#888" }}>top prospect ({r.top_score?.toFixed(2)})</div>
                  </div>
                )}
                <span style={{ color: "#ccc", fontSize: 20 }}>›</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

ReportList.propTypes = {
  reports: PropTypes.array.isRequired,
  onSelectReport: PropTypes.func.isRequired,
  onGenerate: PropTypes.func.isRequired,
  generating: PropTypes.bool,
};

// --- Report Detail ---

function ReportDetail({ reportId, onBack, onNavigateToCompany }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/reports/${encodeURIComponent(reportId)}`)
      .then((res) => res.json())
      .then((data) => { setReport(data.report); setLoading(false); })
      .catch(() => setLoading(false));
  }, [reportId]);

  if (loading) return <div style={{ color: "#888" }}>Loading report…</div>;
  if (!report) return <div style={{ color: "#c0392b" }}>Report not found.</div>;

  const changedCount = report.companies.filter((c) => c.state_changed).length;

  return (
    <div>
      <button
        onClick={onBack}
        style={{
          padding: "8px 16px", border: "1px solid #ddd", borderRadius: 6,
          background: "#fff", cursor: "pointer", fontSize: 14, marginBottom: 16,
        }}
      >
        ← Back to Reports
      </button>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Week of {formatWeek(report.week_label)}</h2>
      </div>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        Generated {formatDate(report.generated_at)} · {report.companies.length} companies · {changedCount} status {changedCount === 1 ? "change" : "changes"} since generation
      </div>

      <table style={{
        borderCollapse: "collapse", width: "100%", background: "#fff",
        borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}>
        <thead>
          <tr style={{ background: "#f0f2f5", textAlign: "left", fontSize: 13, color: "#555" }}>
            <th style={{ padding: "10px 16px" }}>#</th>
            <th style={{ padding: "10px 16px" }}>Company</th>
            <th style={{ padding: "10px 16px" }}>Industry</th>
            <th style={{ padding: "10px 16px", textAlign: "right" }}>Turnover</th>
            <th style={{ padding: "10px 16px" }}>Best Motion</th>
            <th style={{ padding: "10px 16px", textAlign: "center" }}>Fit</th>
            <th style={{ padding: "10px 16px", textAlign: "right" }}>Score</th>
            <th style={{ padding: "10px 16px", textAlign: "center" }}>Status Then</th>
            <th style={{ padding: "10px 16px", textAlign: "center" }}>Status Now</th>
          </tr>
        </thead>
        <tbody>
          {report.companies.map((c, idx) => {
            const thenMeta = STATE_META[c.workflow_state_at_generation] || STATE_META.new_candidate;
            const nowMeta = STATE_META[c.current_workflow_state] || STATE_META.new_candidate;
            return (
              <tr
                key={c.company_id}
                style={{
                  borderBottom: "1px solid #eee",
                  cursor: onNavigateToCompany ? "pointer" : "default",
                  background: c.state_changed ? "#fefce8" : "transparent",
                }}
                onClick={() => onNavigateToCompany && onNavigateToCompany(c.company_id, c.best_motion)}
                onMouseEnter={(e) => (e.currentTarget.style.background = c.state_changed ? "#fef9c3" : "#f8f9fb")}
                onMouseLeave={(e) => (e.currentTarget.style.background = c.state_changed ? "#fefce8" : "transparent")}
              >
                <td style={{ padding: "10px 16px", color: "#888", fontSize: 13 }}>{idx + 1}</td>
                <td style={{ padding: "10px 16px", fontWeight: 600 }}>
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); onNavigateToCompany && onNavigateToCompany(c.company_id, c.best_motion); }}
                    style={{ color: "#0075EB", textDecoration: "none" }}
                  >
                    {c.name}
                  </a>
                </td>
                <td style={{ padding: "10px 16px", color: "#666", fontSize: 13 }}>{c.industry}</td>
                <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13 }}>{formatTurnover(c.turnover)}</td>
                <td style={{ padding: "10px 16px", fontSize: 13 }}>{c.best_motion}</td>
                <td style={{ padding: "10px 16px", textAlign: "center" }}>
                  <Badge text={c.fit_level} bg={FIT_COLORS[c.fit_level]} />
                </td>
                <td style={{ padding: "10px 16px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {c.score.toFixed(2)}
                </td>
                <td style={{ padding: "10px 16px", textAlign: "center" }}>
                  <Badge text={thenMeta.label} bg={thenMeta.color} />
                </td>
                <td style={{ padding: "10px 16px", textAlign: "center" }}>
                  {c.state_changed ? (
                    <Badge text={nowMeta.label} bg={nowMeta.color} />
                  ) : (
                    <span style={{ color: "#ccc", fontSize: 12 }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

ReportDetail.propTypes = {
  reportId: PropTypes.string.isRequired,
  onBack: PropTypes.func.isRequired,
  onNavigateToCompany: PropTypes.func,
};

// --- Main Reports Page ---

export default function Reports({ onNavigateToCompany }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedReportId, setSelectedReportId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  function fetchReports() {
    fetch("/api/reports")
      .then((res) => res.json())
      .then((data) => { setReports(data.reports || []); setLoading(false); })
      .catch(() => setLoading(false));
  }

  useEffect(() => { fetchReports(); }, []);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/generate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          setSelectedReportId(data.report_id);
        } else {
          setError(data.error || "Failed to generate report");
        }
      } else {
        fetchReports();
        setSelectedReportId(data.report_id);
      }
    } catch {
      setError("Failed to generate report");
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <div style={{ color: "#888" }}>Loading reports…</div>;

  if (selectedReportId) {
    return (
      <ReportDetail
        reportId={selectedReportId}
        onBack={() => { setSelectedReportId(null); fetchReports(); }}
        onNavigateToCompany={onNavigateToCompany}
      />
    );
  }

  return (
    <div>
      {error && <div style={{ color: "#c0392b", marginBottom: 12, fontSize: 13 }}>{error}</div>}
      <ReportList
        reports={reports}
        onSelectReport={setSelectedReportId}
        onGenerate={handleGenerate}
        generating={generating}
      />
    </div>
  );
}

Reports.propTypes = {
  onNavigateToCompany: PropTypes.func,
};
