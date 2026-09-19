import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

const STAGE_META = {
  active_opportunity: { label: "Actively working", color: "#047857", bg: "#ecfdf5" },
  closed_lost: { label: "Closed lost", color: "#b91c1c", bg: "#fef2f2" },
  closed_won: { label: "Closed won", color: "#0f766e", bg: "#f0fdfa" },
};

const STAGE_ORDER = ["active_opportunity", "closed_lost", "closed_won"];

function formatTurnover(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "Turnover unavailable";
  if (numeric >= 1_000_000_000) return `GBP ${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (numeric >= 1_000_000) return `GBP ${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `GBP ${(numeric / 1_000).toFixed(0)}K`;
  return `GBP ${numeric}`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatScore(value) {
  if (value === null || value === undefined) return "Not scored";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function sequenceLabel(activity) {
  if (!activity?.sequence_count) return "No sequence";
  const count = Number(activity.sequence_count || 0);
  const latest = formatDate(activity.latest_sequence_activity_at);
  return `${count} sequence${count === 1 ? "" : "s"} · ${latest}`;
}

function StageBadge({ state }) {
  const meta = STAGE_META[state] || STAGE_META.active_opportunity;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        padding: "3px 9px",
        color: meta.color,
        background: meta.bg,
        fontSize: 12,
        fontWeight: 800,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

StageBadge.propTypes = {
  state: PropTypes.string,
};

export default function ActiveOpportunities({ onNavigateToCompany }) {
  const [opportunities, setOpportunities] = useState([]);
  const [meta, setMeta] = useState({ counts: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [stageFilter, setStageFilter] = useState("active_opportunity");

  const loadOpportunities = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/opportunities");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Failed to load opportunities");
      setOpportunities(Array.isArray(payload.opportunities) ? payload.opportunities : []);
      setMeta(payload.meta || { counts: {} });
    } catch (err) {
      setError(err?.message || "Failed to load opportunities");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOpportunities();
  }, [loadOpportunities]);

  const visibleOpportunities = useMemo(
    () => opportunities.filter((opportunity) => opportunity.workflow_state === stageFilter),
    [opportunities, stageFilter],
  );

  async function updateOpportunity(opportunity, newState) {
    const name = opportunity?.name || opportunity?.company_number || "this company";
    const confirmText = newState === "closed_won"
      ? `Mark ${name} closed won? This excludes it from future prospecting.`
      : newState === "closed_lost"
        ? `Mark ${name} closed lost? It will stay here until you return it to triage.`
        : `Return ${name} to triage?`;
    if (!window.confirm(confirmText)) return;

    setUpdatingId(opportunity.id);
    setError(null);
    try {
      const response = await fetch(`/api/company/${encodeURIComponent(opportunity.id)}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_state: newState,
          note: newState === "new_candidate"
            ? "Manually released from closed lost back to triage"
            : `Opportunity stage changed to ${newState.replaceAll("_", " ")}`,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Failed to update opportunity (${response.status})`);
      await loadOpportunities();
      if (newState !== "new_candidate") setStageFilter(newState);
    } catch (err) {
      setError(err?.message || "Failed to update opportunity");
    } finally {
      setUpdatingId(null);
    }
  }

  if (loading) {
    return <div style={{ color: "#64748b", padding: 24 }}>Loading opportunities...</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, color: "#0f172a" }}>My Active Opportunities</h2>
          <div style={{ marginTop: 4, fontSize: 13, color: "#64748b" }}>
            {(meta.total || opportunities.length).toLocaleString()} companies
          </div>
        </div>
        <button
          type="button"
          onClick={loadOpportunities}
          disabled={updatingId !== null}
          style={{ border: "1px solid #d1d5db", borderRadius: 7, background: "#fff", padding: "7px 11px", fontSize: 13, fontWeight: 700, cursor: updatingId ? "wait" : "pointer" }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" style={{ marginBottom: 12, padding: "9px 11px", borderRadius: 7, border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {STAGE_ORDER.map((state) => {
          const metaForStage = STAGE_META[state];
          const active = stageFilter === state;
          const count = Number(meta?.counts?.[state] || 0);
          return (
            <button
              key={state}
              type="button"
              onClick={() => setStageFilter(state)}
              style={{
                border: active ? `1px solid ${metaForStage.color}` : "1px solid #d1d5db",
                borderRadius: 999,
                background: active ? metaForStage.bg : "#fff",
                color: active ? metaForStage.color : "#334155",
                padding: "6px 11px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 800,
              }}
            >
              {metaForStage.label} ({count})
            </button>
          );
        })}
      </div>

      {visibleOpportunities.length === 0 ? (
        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: 18, color: "#64748b", background: "#fff", fontSize: 14 }}>
          No companies in this stage.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visibleOpportunities.map((opportunity) => {
            const updating = updatingId === opportunity.id;
            return (
              <section
                key={opportunity.id}
                style={{ border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", padding: 14 }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: 17, color: "#111827" }}>{opportunity.name}</h3>
                      <StageBadge state={opportunity.workflow_state} />
                    </div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "#64748b", fontSize: 12 }}>
                      <span>{opportunity.company_number}</span>
                      <span>{formatTurnover(opportunity.turnover)}</span>
                      <span>{opportunity.industry || "Unknown industry"}</span>
                      <span>Score {formatScore(opportunity.combined_score)}</span>
                      {opportunity.best_motion && <span>{opportunity.best_motion}</span>}
                    </div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "#475569", fontSize: 12 }}>
                      <span>Updated {formatDate(opportunity.workflow_updated_at)}</span>
                      <span>Latest filing {formatDate(opportunity.latest_filing_date)}</span>
                      <span>{sequenceLabel(opportunity.sequence_activity)}</span>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {onNavigateToCompany && (
                      <button
                        type="button"
                        onClick={() => onNavigateToCompany(opportunity.id)}
                        style={{ border: "1px solid #d1d5db", borderRadius: 7, background: "#fff", padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                      >
                        Open profile
                      </button>
                    )}
                    {opportunity.workflow_state === "active_opportunity" && (
                      <>
                        <button
                          type="button"
                          onClick={() => updateOpportunity(opportunity, "closed_lost")}
                          disabled={updating}
                          style={{ border: "1px solid #fecaca", borderRadius: 7, background: "#fff", color: "#991b1b", padding: "6px 10px", fontSize: 12, fontWeight: 800, cursor: updating ? "wait" : "pointer" }}
                        >
                          Closed lost
                        </button>
                        <button
                          type="button"
                          onClick={() => updateOpportunity(opportunity, "closed_won")}
                          disabled={updating}
                          style={{ border: "1px solid #99f6e4", borderRadius: 7, background: "#f0fdfa", color: "#0f766e", padding: "6px 10px", fontSize: 12, fontWeight: 800, cursor: updating ? "wait" : "pointer" }}
                        >
                          Closed won
                        </button>
                      </>
                    )}
                    {opportunity.workflow_state === "closed_lost" && (
                      <button
                        type="button"
                        onClick={() => updateOpportunity(opportunity, "new_candidate")}
                        disabled={updating}
                        style={{ border: "1px solid #bfdbfe", borderRadius: 7, background: "#eff6ff", color: "#1d4ed8", padding: "6px 10px", fontSize: 12, fontWeight: 800, cursor: updating ? "wait" : "pointer" }}
                      >
                        Return to triage
                      </button>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

ActiveOpportunities.propTypes = {
  onNavigateToCompany: PropTypes.func,
};
