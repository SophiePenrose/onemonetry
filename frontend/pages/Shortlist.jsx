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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stateFilter, setStateFilter] = useState("all");
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  function fetchData(suppressedFlag) {
    setLoading(true);
    setError(null);
    const qs = suppressedFlag ? "show_suppressed=true" : "";
    fetch(`/api/unified-shortlist?${qs}`)
      .then((res) => { if (!res.ok) throw new Error("Failed to fetch"); return res.json(); })
      .then((data) => { setCompanies(data.companies || []); setMeta(data.meta || null); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }

  useEffect(() => { fetchData(false); }, []);

  function toggleSuppressed() {
    const next = !showSuppressed;
    setShowSuppressed(next);
    fetchData(next);
  }

  const stateCounts = {};
  companies.forEach((c) => { stateCounts[c.workflow_state] = (stateCounts[c.workflow_state] || 0) + 1; });

  const afterStateFilter = stateFilter === "all"
    ? companies
    : companies.filter((c) => c.workflow_state === stateFilter);

  const filtered = searchQuery.trim()
    ? afterStateFilter.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.industry.toLowerCase().includes(searchQuery.toLowerCase())
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
              <th style={{ padding: "10px 14px", textAlign: "center" }}>Segment</th>
              <th style={{ padding: "10px 14px", textAlign: "right" }}>Turnover</th>
              <th style={{ padding: "10px 14px", textAlign: "right" }}>Score</th>
              <th style={{ padding: "10px 14px" }}>Best Motion</th>
              <th style={{ padding: "10px 14px" }}>Growth</th>
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
