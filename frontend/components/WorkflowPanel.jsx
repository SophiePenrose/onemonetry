import React, { useState } from "react";
import PropTypes from "prop-types";

const STATE_META = {
  new_candidate: { label: "New Candidate", color: "#6c757d" },
  shortlisted: { label: "Shortlisted", color: "#0075EB" },
  selected_for_outreach: { label: "Selected for Outreach", color: "#6f42c1" },
  in_cadence: { label: "In Cadence", color: "#e67e22" },
  active_opportunity: { label: "Active Opportunity", color: "#20c997" },
  closed_won: { label: "Closed Won", color: "#0a8754" },
  closed_lost: { label: "Closed Lost", color: "#c0392b" },
  revisit_later: { label: "Revisit Later", color: "#95a5a6" },
  held_for_review: { label: "Held for Review", color: "#f39c12" },
};

function StateBadge({ stateId, large }) {
  const meta = STATE_META[stateId] || { label: stateId, color: "#888" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: large ? "6px 16px" : "2px 10px",
        borderRadius: 16,
        fontSize: large ? 14 : 12,
        fontWeight: 600,
        color: "#fff",
        background: meta.color,
      }}
    >
      {meta.label}
    </span>
  );
}

StateBadge.propTypes = { stateId: PropTypes.string.isRequired, large: PropTypes.bool };

export default function WorkflowPanel({ companyId, currentState, history, transitions, onStateChange }) {
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const allowed = transitions[currentState] || [];

  async function handleTransition(newState) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_state: newState, note: note.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update state");
      }
      const data = await res.json();
      setNote("");
      if (onStateChange) onStateChange(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Workflow</h3>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ color: "#888", fontSize: 13 }}>Current status:</span>
        <StateBadge stateId={currentState} large />
      </div>

      {allowed.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>Move to:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            {allowed.map((s) => {
              const meta = STATE_META[s] || { label: s, color: "#888" };
              return (
                <button
                  key={s}
                  disabled={loading}
                  onClick={() => handleTransition(s)}
                  style={{
                    padding: "6px 16px",
                    borderRadius: 6,
                    border: `2px solid ${meta.color}`,
                    background: "#fff",
                    color: meta.color,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: loading ? "wait" : "pointer",
                    opacity: loading ? 0.6 : 1,
                  }}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="Add a note (optional)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #ddd",
              borderRadius: 6,
              fontSize: 13,
              boxSizing: "border-box",
            }}
          />
        </div>
      )}

      {allowed.length === 0 && (
        <div style={{ color: "#888", fontSize: 13, marginBottom: 16, fontStyle: "italic" }}>
          No transitions available from this state.
        </div>
      )}

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {history && history.length > 0 && (
        <div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>History:</div>
          <div style={{ borderLeft: "2px solid #e0e3e8", paddingLeft: 16 }}>
            {[...history].reverse().map((entry, idx) => (
              <div key={idx} style={{ marginBottom: 12, fontSize: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {entry.from ? (
                    <>
                      <StateBadge stateId={entry.from} />
                      <span style={{ color: "#aaa" }}>→</span>
                      <StateBadge stateId={entry.to} />
                    </>
                  ) : (
                    <StateBadge stateId={entry.state || entry.to || "new_candidate"} />
                  )}
                </div>
                <div style={{ color: "#aaa", fontSize: 11, marginTop: 2 }}>
                  {new Date(entry.timestamp).toLocaleString()}
                  {entry.note && <span style={{ color: "#666", marginLeft: 8 }}>— {entry.note}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

WorkflowPanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  currentState: PropTypes.string.isRequired,
  history: PropTypes.array,
  transitions: PropTypes.object.isRequired,
  onStateChange: PropTypes.func,
};
