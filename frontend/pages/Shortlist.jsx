import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { TableSkeleton } from "../components/LoadingSkeleton";

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

const ANALYSIS_META = {
  ready: { label: "Ready", color: "#0a8754" },
  queued: { label: "Queued", color: "#d97706" },
  failed: { label: "Failed", color: "#c0392b" },
  none: { label: "Pending", color: "#6b7280" },
};

function Badge({ text, bg }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10,
      fontSize: 11, fontWeight: 600, color: "#fff", background: bg || "#888",
      whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

Badge.propTypes = { text: PropTypes.string.isRequired, bg: PropTypes.string };

const SEGMENT_COLORS = { SMB: "#6b7280", "Mid-Market": "#0075EB", Enterprise: "#6f42c1" };

function SegmentBadge({ segment }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10,
      fontSize: 11, fontWeight: 600, color: "#fff",
      background: SEGMENT_COLORS[segment] || "#888",
      whiteSpace: "nowrap",
    }}>
      {segment === "Mid-Market" ? "MM" : segment === "Enterprise" ? "ENT" : "SMB"}
    </span>
  );
}

SegmentBadge.propTypes = { segment: PropTypes.string };

const WARMTH_META = {
  hot: { label: "🔥", color: "#dc2626", title: "Hot — likely to respond now" },
  warm: { label: "☀️", color: "#ea580c", title: "Warm — engaged, some signals" },
  cool: { label: "🌤", color: "#6b7280", title: "Cool — limited signals" },
  cold: { label: "❄️", color: "#94a3b8", title: "Cold — no engagement signals" },
};

function WarmthIndicator({ warmth }) {
  const wm = WARMTH_META[warmth] || WARMTH_META.cold;
  return <span title={wm.title} style={{ fontSize: 16, cursor: "default" }}>{wm.label}</span>;
}

WarmthIndicator.propTypes = { warmth: PropTypes.string };

function MotionChip({ motion, score, fitLevel }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 10, fontSize: 11,
      background: "#f0f2f5", color: "#555", whiteSpace: "nowrap",
      border: `1px solid ${FIT_COLORS[fitLevel] || "#ddd"}`,
    }}>
      <span style={{ fontWeight: 600, color: FIT_COLORS[fitLevel] || "#555" }}>{score.toFixed(2)}</span>
      <span>{motion}</span>
    </span>
  );
}

MotionChip.propTypes = { motion: PropTypes.string.isRequired, score: PropTypes.number.isRequired, fitLevel: PropTypes.string };

export default function Shortlist({ onSelectCompany, onShowAddCompany }) {
  const [companies, setCompanies] = useState([]);
  const [meta, setMeta] = useState(null);
  const [queueStatus, setQueueStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stateFilter, setStateFilter] = useState("all");
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [queueBusy, setQueueBusy] = useState(false);
  const [retryingCompany, setRetryingCompany] = useState(null);

  async function fetchData(suppressedFlag) {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (suppressedFlag) params.set("show_suppressed", "true");
    const qs = params.toString();

    try {
      const [shortlistRes, queueRes] = await Promise.all([
        fetch(`/api/unified-shortlist${qs ? `?${qs}` : ""}`),
        fetch("/api/analysis-queue/status"),
      ]);

      if (!shortlistRes.ok) throw new Error("Failed to fetch");

      const shortlistData = await shortlistRes.json();
      setCompanies(shortlistData.companies || []);
      setMeta(shortlistData.meta || null);

      if (queueRes.ok) {
        const queueData = await queueRes.json();
        setQueueStatus(queueData);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(false); }, []);

  function toggleSuppressed() {
    const next = !showSuppressed;
    setShowSuppressed(next);
    fetchData(next);
  }

  async function handleProcessQueueNow() {
    setQueueBusy(true);
    try {
      await fetch("/api/analysis-queue/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: 5 }),
      });
      await fetchData(showSuppressed);
    } finally {
      setQueueBusy(false);
    }
  }

  async function handleRetryFailed(companyNumber = null, event = null) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (companyNumber) setRetryingCompany(companyNumber);
    else setQueueBusy(true);

    try {
      await fetch("/api/analysis-queue/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(companyNumber ? { company_number: companyNumber } : {}),
      });
      await fetchData(showSuppressed);
    } finally {
      if (companyNumber) setRetryingCompany(null);
      else setQueueBusy(false);
    }
  }

  const stateCounts = {};
  companies.forEach((c) => { stateCounts[c.workflow_state] = (stateCounts[c.workflow_state] || 0) + 1; });

  const afterStateFilter = stateFilter === "all"
    ? companies
    : companies.filter((c) => c.workflow_state === stateFilter);

  const filtered = searchQuery.trim()
    ? afterStateFilter.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.industry.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.company_number?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : afterStateFilter;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Shortlist</h2>
          {!loading && !error && (
            <span style={{ color: "#888", fontSize: 14 }}>
              {filtered.length} of {companies.length} companies
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search companies…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd",
              fontSize: 13, width: 200,
            }}
          />
          <a
            href="/api/export/shortlist?format=csv"
            download
            style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid #ddd",
              background: "#fff", color: "#555", fontSize: 13, textDecoration: "none",
              display: "inline-flex", alignItems: "center", cursor: "pointer",
            }}
          >
            ↓ CSV
          </a>
          <button
            onClick={() => fetchData(showSuppressed)}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid #ddd",
              background: "#fff", color: "#555", fontSize: 13, cursor: "pointer",
            }}
          >
            ↻ Refresh
          </button>
          {onShowAddCompany && (
            <button
              onClick={onShowAddCompany}
              style={{
                padding: "6px 16px", borderRadius: 6, border: "none",
                background: "#0075EB", color: "#fff", fontWeight: 600,
                fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              + Add Company
            </button>
          )}
        </div>
      </div>

      {!loading && !error && meta && (meta.excluded > 0 || meta.suppressed > 0) && (
        <div style={{ fontSize: 12, color: "#888", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
          {meta.excluded > 0 && (
            <span style={{ background: "#fee2e2", color: "#991b1b", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.excluded} excluded
            </span>
          )}
          {meta.suppressed > 0 && (
            <span style={{ background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.suppressed} suppressed
            </span>
          )}
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={showSuppressed} onChange={toggleSuppressed} style={{ cursor: "pointer" }} />
            <span>Show suppressed</span>
          </label>
        </div>
      )}

      {!loading && !error && meta?.analysis && (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "#ffedd5", color: "#9a3412", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
            {meta.analysis.queued || 0} queued
          </span>
          <span style={{ background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
            {meta.analysis.ready || 0} ready
          </span>
          {(meta.analysis.failed || 0) > 0 && (
            <span style={{ background: "#fee2e2", color: "#991b1b", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.analysis.failed} failed
            </span>
          )}
        </div>
      )}

      {!loading && !error && queueStatus && (
        <div style={{ marginBottom: 14, background: "#fff", border: "1px solid #eceff3", borderRadius: 8, padding: "10px 12px", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#555" }}>
              <strong style={{ fontSize: 13 }}>Analysis Queue</strong>
              <span style={{ background: queueStatus.enabled ? "#dcfce7" : "#f3f4f6", color: queueStatus.enabled ? "#166534" : "#4b5563", padding: "2px 8px", borderRadius: 999 }}>
                {queueStatus.enabled ? "Worker On" : "Worker Off"}
              </span>
              <span>{queueStatus.counts?.queued || 0} queued</span>
              <span>{queueStatus.counts?.processing || 0} processing</span>
              <span>{queueStatus.counts?.ready || 0} ready</span>
              {(queueStatus.counts?.failed || 0) > 0 && (
                <span style={{ color: "#b91c1c", fontWeight: 600 }}>{queueStatus.counts.failed} failed</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={handleProcessQueueNow}
                disabled={queueBusy}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #d5d9df", background: "#fff", cursor: queueBusy ? "wait" : "pointer", fontSize: 12 }}
              >
                {queueBusy ? "Working..." : "Process Now"}
              </button>
              <button
                onClick={() => handleRetryFailed()}
                disabled={queueBusy || (queueStatus.counts?.failed || 0) === 0}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #d5d9df", background: "#fff", cursor: (queueBusy || (queueStatus.counts?.failed || 0) === 0) ? "not-allowed" : "pointer", fontSize: 12 }}
              >
                Retry Failed
              </button>
            </div>
          </div>
          {queueStatus.last_error && (
            <div style={{ marginTop: 8, color: "#991b1b" }}>Last queue error: {queueStatus.last_error}</div>
          )}
        </div>
      )}

      {!loading && !error && companies.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          <button onClick={() => setStateFilter("all")} style={{
            padding: "4px 14px", borderRadius: 14,
            border: stateFilter === "all" ? "2px solid #333" : "1px solid #ddd",
            background: stateFilter === "all" ? "#333" : "#fff",
            color: stateFilter === "all" ? "#fff" : "#555",
            fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>All ({companies.length})</button>
          {Object.entries(STATE_META).map(([stateId, sm]) => {
            const count = stateCounts[stateId] || 0;
            if (count === 0) return null;
            const active = stateFilter === stateId;
            return (
              <button key={stateId} onClick={() => setStateFilter(stateId)} style={{
                padding: "4px 14px", borderRadius: 14,
                border: active ? `2px solid ${sm.color}` : "1px solid #ddd",
                background: active ? sm.color : "#fff",
                color: active ? "#fff" : sm.color,
                fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>{sm.label} ({count})</button>
            );
          })}
        </div>
      )}

      {loading && <TableSkeleton rows={8} />}
      {error && <div style={{ color: "#c0392b" }}>Error: {error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ color: "#888", padding: 16, background: "#fff", borderRadius: 8 }}>No companies match the current filter.</div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <thead>
            <tr style={{ background: "#f0f2f5", textAlign: "left", fontSize: 13, color: "#555" }}>
              <th style={{ padding: "10px 14px" }}>#</th>
              <th style={{ padding: "10px 14px" }}>Company</th>
              <th style={{ padding: "10px 14px" }}>Industry</th>
              <th style={{ padding: "10px 14px", textAlign: "center" }}>Segment</th>
              <th style={{ padding: "10px 14px", textAlign: "right" }}>Turnover</th>
              <th style={{ padding: "10px 14px", textAlign: "right" }}>Score</th>
              <th style={{ padding: "10px 14px" }}>Best Motion</th>
              <th style={{ padding: "10px 14px" }}>Growth</th>
              <th style={{ padding: "10px 14px", textAlign: "center" }}>Analysis</th>
              <th style={{ padding: "10px 14px", textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const sm = STATE_META[c.workflow_state] || STATE_META.new_candidate;
              return (
                <tr
                  key={c.id}
                  onClick={() => onSelectCompany && onSelectCompany(c.id)}
                  style={{
                    borderBottom: "1px solid #eee",
                    cursor: onSelectCompany ? "pointer" : "default",
                    background: c.below_threshold ? "#fefce8" : "transparent",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f9fb")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = c.below_threshold ? "#fefce8" : "transparent")}
                >
                  <td style={{ padding: "10px 14px", color: "#888", fontSize: 13 }}>{c.rank}</td>
                  <td style={{ padding: "10px 14px", fontWeight: 600 }}>
                    <a href="#" onClick={(e) => { e.preventDefault(); onSelectCompany && onSelectCompany(c.id); }} style={{ color: "#0075EB", textDecoration: "none" }}>
                      {c.name}
                    </a>
                  </td>
                  <td style={{ padding: "10px 14px", color: "#666", fontSize: 13 }}>{c.industry}</td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    <SegmentBadge segment={c.segment} />
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "right", fontSize: 13 }}>
                    {c.turnover ? `£${(c.turnover / 1e6).toFixed(1)}M` : "—"}
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "right", fontWeight: 700, fontSize: 15, color: c.composite_score ? "#0075EB" : "#ccc" }}>
                    {c.composite_score ? c.composite_score.toFixed(2) : "—"}
                  </td>
                  <td style={{ padding: "10px 14px", fontSize: 12 }}>
                    {c.best_motion ? (
                      <span style={{ padding: "2px 8px", borderRadius: 8, background: "#eff6ff", color: "#0075EB", fontWeight: 500 }}>
                        {c.best_motion}
                      </span>
                    ) : "—"}
                  </td>
                  <td style={{ padding: "10px 14px", fontSize: 12, color: c.growth_trend === "strong_growth" ? "#0a8754" : c.growth_trend === "declining" ? "#c0392b" : "#888" }}>
                    {c.growth_trend || "—"}
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    <Badge
                      text={(ANALYSIS_META[c.analysis_status] || ANALYSIS_META.none).label}
                      bg={(ANALYSIS_META[c.analysis_status] || ANALYSIS_META.none).color}
                    />
                    {c.analysis_status === "failed" && (
                      <button
                        onClick={(e) => handleRetryFailed(c.company_number, e)}
                        style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", color: "#333", fontSize: 11, cursor: "pointer" }}
                      >
                        {retryingCompany === c.company_number ? "Retrying..." : "Retry"}
                      </button>
                    )}
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "center" }}>
                    <Badge text={sm.label} bg={sm.color} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

Shortlist.propTypes = {
  onSelectCompany: PropTypes.func,
  onShowAddCompany: PropTypes.func,
};
