import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

function formatTimestamp(value) {
  if (!value) return "Not available";
  const millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) return String(value);
  return new Date(millis).toLocaleString("en-GB");
}

function formatScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "n/a";
}

function formatDelta(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(1)}`;
}

function severityStyle(level) {
  const key = String(level || "info").toLowerCase();
  if (key === "high") {
    return { color: "#991b1b", background: "#fee2e2" };
  }
  if (key === "medium") {
    return { color: "#92400e", background: "#fef3c7" };
  }
  return { color: "#1e3a8a", background: "#dbeafe" };
}

function compactTypeCount(counts = {}) {
  return Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

export default function StakeholderAlertsPanel({ companyId, initialAlerts }) {
  const [alerts, setAlerts] = useState(initialAlerts || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setAlerts(initialAlerts || null);
  }, [initialAlerts, companyId]);

  const loadAlerts = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/company/${encodeURIComponent(companyId)}/stakeholder-alerts?limit=12&offset=0`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load stakeholder alerts");
      }
      setAlerts(payload);
    } catch (err) {
      setError(err?.message || "Failed to load stakeholder alerts");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const items = Array.isArray(alerts?.items) ? alerts.items : [];
  const total = Number(alerts?.total || 0);
  const recentCount = useMemo(() => compactTypeCount(alerts?.recent_7d_by_type || {}), [alerts]);

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Stakeholder Delta Alerts</h3>
        <button
          onClick={loadAlerts}
          disabled={loading}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: "#fff",
            color: "#374151",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            fontSize: 12,
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div style={{ fontSize: 12, color: "#475569", marginBottom: 10 }}>
        Detects newly relevant people and priority changes from latest filing-derived stakeholder scoring snapshots.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, marginBottom: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", background: "#f8fafc" }}>
          <div style={{ fontSize: 11, color: "#64748b" }}>Total events</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{total}</div>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", background: "#f8fafc" }}>
          <div style={{ fontSize: 11, color: "#64748b" }}>Recent (7d)</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{recentCount}</div>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", background: "#f8fafc" }}>
          <div style={{ fontSize: 11, color: "#64748b" }}>Priority increases</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{Number(alerts?.by_type?.stakeholder_priority_increase || 0)}</div>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", background: "#f8fafc" }}>
          <div style={{ fontSize: 11, color: "#64748b" }}>New relevant people</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{Number(alerts?.by_type?.new_relevant_stakeholder || 0)}</div>
        </div>
      </div>

      {error && (
        <div style={{ color: "#991b1b", fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div style={{ fontSize: 13, color: "#64748b" }}>
          No stakeholder delta alerts yet. Alerts appear when newly relevant people are detected or stakeholder priority changes materially.
        </div>
      )}

      {!error && items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((item) => {
            const severity = severityStyle(item?.severity);
            return (
              <div
                key={`stakeholder-alert-${item.id}`}
                style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", background: "#fff" }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1f2937" }}>
                    {item.event_label || item.event_type}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      borderRadius: 999,
                      padding: "2px 8px",
                      color: severity.color,
                      background: severity.background,
                    }}
                  >
                    {String(item?.severity || "info").toUpperCase()}
                  </span>
                </div>

                <div style={{ fontSize: 12, color: "#334155", marginBottom: 3 }}>
                  <strong>{item.stakeholder_name || "Unknown stakeholder"}</strong>
                  {item.stakeholder_role ? ` · ${item.stakeholder_role}` : ""}
                </div>

                <div style={{ fontSize: 12, color: "#475569", marginBottom: 3 }}>
                  Score: {formatScore(item.previous_score)} → {formatScore(item.current_score)} · Delta: {formatDelta(item.delta_score)}
                </div>

                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {formatTimestamp(item.created_at)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

StakeholderAlertsPanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  initialAlerts: PropTypes.shape({
    total: PropTypes.number,
    by_type: PropTypes.object,
    recent_7d_by_type: PropTypes.object,
    items: PropTypes.array,
  }),
};
