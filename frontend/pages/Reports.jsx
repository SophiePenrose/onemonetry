import React, { useCallback, useEffect, useMemo, useState } from "react";
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
    <span className="reports-pill" style={{ background: bg || "#888" }}>
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
  const formattedReports = useMemo(
    () => reports.map((report) => ({
      ...report,
      formattedWeek: formatWeek(report.week_label),
      formattedGeneratedAt: formatDate(report.generated_at),
      formattedTopScore: Number.isFinite(report.top_score) ? report.top_score.toFixed(2) : null,
    })),
    [reports],
  );

  return (
    <div className="reports-page">
      <div className="reports-header">
        <h2 className="reports-title">Performance</h2>
        <button
          onClick={onGenerate}
          disabled={generating}
          className="reports-primary-button"
        >
          {generating ? "Generating…" : "Generate This Week's Report"}
        </button>
      </div>

      {reports.length === 0 ? (
        <div className="reports-empty-state">
          <div className="reports-empty-icon">📊</div>
          <div className="reports-empty-title">No reports generated yet</div>
          <div className="reports-empty-subtitle">Click the button above to generate your first weekly report.</div>
        </div>
      ) : (
        <div className="reports-list">
          {formattedReports.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => onSelectReport(r.id)}
              className="report-list-item"
            >
              <div>
                <div className="report-list-week">Week of {r.formattedWeek}</div>
                <div className="report-list-generated">Generated {r.formattedGeneratedAt}</div>
              </div>
              <div className="report-list-meta">
                <div className="report-list-count-wrap">
                  <div className="report-list-count">{r.company_count}</div>
                  <div className="report-list-count-label">companies</div>
                </div>
                {r.top_company && (
                  <div className="report-list-top-prospect">
                    <div className="report-list-top-name">{r.top_company}</div>
                    <div className="report-list-top-score">top prospect ({r.formattedTopScore || "N/A"})</div>
                  </div>
                )}
                <span className="report-list-chevron">&gt;</span>
              </div>
            </button>
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
    const controller = new AbortController();

    setLoading(true);
    fetch(`/api/reports/${encodeURIComponent(reportId)}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => { setReport(data.report); setLoading(false); })
      .catch((err) => {
        if (err?.name !== "AbortError") setLoading(false);
      });

    return () => controller.abort();
  }, [reportId]);

  const changedCount = useMemo(
    () => (report?.companies || []).filter((c) => c.state_changed).length,
    [report],
  );

  if (loading) return <div style={{ color: "#888" }}>Loading report…</div>;
  if (!report) return <div style={{ color: "#c0392b" }}>Report not found.</div>;

  return (
    <div className="reports-page">
      <button
        onClick={onBack}
        className="detail-back-button"
      >
        Back to Reports
      </button>

      <div className="reports-detail-header">
        <h2 className="reports-title">Week of {formatWeek(report.week_label)}</h2>
        <a
          href={`/api/export/report/${encodeURIComponent(reportId)}?format=csv`}
          download
          className="reports-export-link"
        >
          Export CSV
        </a>
      </div>
      <div className="reports-detail-meta">
        Generated {formatDate(report.generated_at)} · {report.companies.length} companies · {changedCount} status {changedCount === 1 ? "change" : "changes"} since generation
      </div>

      <div className="table-shell">
        <table className="data-table interactive-table report-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Company</th>
              <th>Industry</th>
              <th className="align-right">Turnover</th>
              <th>Best Motion</th>
              <th className="align-center">Fit</th>
              <th className="align-right">Score</th>
              <th className="align-center">Status Then</th>
              <th className="align-center">Status Now</th>
            </tr>
          </thead>
          <tbody>
            {report.companies.map((c, idx) => {
              const thenMeta = STATE_META[c.workflow_state_at_generation] || STATE_META.new_candidate;
              const nowMeta = STATE_META[c.current_workflow_state] || STATE_META.new_candidate;
              return (
                <tr
                  key={c.company_id}
                  className={c.state_changed ? "report-row report-row-changed" : "report-row"}
                  onClick={onNavigateToCompany ? () => onNavigateToCompany(c.company_id) : undefined}
                >
                  <td className="row-index">{idx + 1}</td>
                  <td className="row-strong">
                    <button
                      type="button"
                      className="table-link-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigateToCompany && onNavigateToCompany(c.company_id);
                      }}
                    >
                      {c.name}
                    </button>
                  </td>
                  <td className="row-muted">{c.industry}</td>
                  <td className="align-right">{formatTurnover(c.turnover)}</td>
                  <td>{c.best_motion}</td>
                  <td className="align-center">
                    <Badge text={c.fit_level} bg={FIT_COLORS[c.fit_level]} />
                  </td>
                  <td className="align-right row-score">{c.score.toFixed(2)}</td>
                  <td className="align-center">
                    <Badge text={thenMeta.label} bg={thenMeta.color} />
                  </td>
                  <td className="align-center">
                    {c.state_changed ? (
                      <Badge text={nowMeta.label} bg={nowMeta.color} />
                    ) : (
                      <span className="reports-empty-status">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  const [schedule, setSchedule] = useState(null);

  const fetchReports = useCallback((signal) => {
    const requestOptions = signal ? { signal } : undefined;

    fetch("/api/reports", requestOptions)
      .then((res) => res.json())
      .then((data) => { setReports(data.reports || []); setLoading(false); })
      .catch((err) => {
        if (err?.name !== "AbortError") setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchReports(controller.signal);
    fetch("/api/reports/schedule", { signal: controller.signal })
      .then((r) => r.json())
      .then(setSchedule)
      .catch(() => {});

    return () => controller.abort();
  }, [fetchReports]);

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
    <div className="reports-page">
      {schedule && (
        <div className="reports-schedule-banner">
          <span className="reports-schedule-icon">📅</span>
          <span>
            Reports auto-generate <strong>{schedule.schedule}</strong>. Next: <strong>{new Date(schedule.next_generation).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</strong>
          </span>
        </div>
      )}
      {error && <div className="reports-error-message">{error}</div>}
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
