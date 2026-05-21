import React from "react";
import PropTypes from "prop-types";

const LAYER_LABELS = {
  product_fit: "Product Fit",
  commercial_value: "Commercial Value",
  pain_strength: "Pain Strength",
  urgency: "Urgency",
  competitor_context: "Competitor Context",
};

const LAYER_COLORS = {
  product_fit: "#0075EB",
  commercial_value: "#0a8754",
  pain_strength: "#c0392b",
  urgency: "#e67e22",
  competitor_context: "#6f42c1",
};

function ScoreBar({ score, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
      <div style={{ flex: 1, background: "#eee", borderRadius: 4, height: 8, overflow: "hidden" }}>
        <div
          style={{
            width: `${Math.round(score * 100)}%`,
            background: color,
            height: "100%",
            borderRadius: 4,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>
        {(score * 100).toFixed(0)}%
      </span>
    </div>
  );
}

ScoreBar.propTypes = { score: PropTypes.number.isRequired, color: PropTypes.string.isRequired };

function ScoreExplanation({ productFit, scoreBreakdown, finalScore, explanation }) {
  const hasLayers = scoreBreakdown && Object.keys(scoreBreakdown).some((k) => scoreBreakdown[k]?.evidence);
  const renderEvidence = (evidence) => {
    if (Array.isArray(evidence)) {
      return evidence.map((item, idx) => (
        <div key={idx}>{typeof item === "object" ? item.text || JSON.stringify(item) : item}</div>
      ));
    }
    if (typeof evidence === "object") return JSON.stringify(evidence);
    return evidence;
  };

  return (
    <div style={{ border: "1px solid #e0e3e8", borderRadius: 8, padding: 16, background: "#fafbfc" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: "#0075EB" }}>{finalScore?.toFixed(2) ?? "N/A"}</div>
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1 }}>Composite</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "#555", marginBottom: 4 }}>
            <strong>Fit Level:</strong>{" "}
            <span style={{ textTransform: "capitalize" }}>{productFit?.fit_level ?? "N/A"}</span>
          </div>
          <div style={{ fontSize: 13, color: "#666" }}>{explanation ?? "N/A"}</div>
        </div>
      </div>

      {hasLayers && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10, borderBottom: "1px solid #e0e3e8", paddingBottom: 6 }}>
            Score Layers
          </div>
          {Object.entries(LAYER_LABELS).map(([key, label]) => {
            const layer = scoreBreakdown[key];
            if (!layer) return null;
            return (
              <div key={key} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: LAYER_COLORS[key], minWidth: 130 }}>{label}</span>
                  <ScoreBar score={layer.score} color={LAYER_COLORS[key]} />
                </div>
                {layer.evidence && (
                  <div style={{ fontSize: 12, color: "#888", paddingLeft: 138 }}>
                    {renderEvidence(layer.evidence)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!hasLayers && scoreBreakdown && (
        <div>
          <div style={{ fontSize: 13, color: "#888" }}>Score Breakdown:</div>
          <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
            {Object.entries(scoreBreakdown).map(([k, v]) => (
              <li key={k} style={{ fontSize: 13 }}>
                <strong>{k}:</strong> {typeof v === "object" ? v.score : v}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

ScoreExplanation.propTypes = {
  productFit: PropTypes.shape({
    motion: PropTypes.string,
    fit_level: PropTypes.string,
    eligible: PropTypes.bool,
  }),
  scoreBreakdown: PropTypes.object,
  finalScore: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  explanation: PropTypes.string,
};

export default ScoreExplanation;
