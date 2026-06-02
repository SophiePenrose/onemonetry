import React from "react";
import PropTypes from "prop-types";

const LAYER_LABELS = {
  product_fit: "Product Fit",
  commercial_value: "Commercial Value",
  pain_strength: "Pain Strength",
  urgency: "Urgency",
  competitor_context: "Current Stack Context",
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

function ScoreExplanation({ productFit, scoreBreakdown, finalScore, explanation, scoreNarrative }) {
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

  const normalizeNarrativeItems = (items, limit = 3) => {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => String(typeof item === "object" ? item?.text || "" : item || "").trim())
      .filter(Boolean)
      .slice(0, limit);
  };

  const narrativeHeadline = scoreNarrative?.headline || explanation || "N/A";
  const narrativeDrivers = normalizeNarrativeItems(scoreNarrative?.drivers, 3);
  const narrativeEvidence = normalizeNarrativeItems(scoreNarrative?.evidence, 3);
  const narrativeRisks = normalizeNarrativeItems(scoreNarrative?.risks, 3);
  const hasNarrative = narrativeDrivers.length > 0 || narrativeEvidence.length > 0 || narrativeRisks.length > 0;

  const isFiniteNumber = (value) => Number.isFinite(Number(value));
  const formatSignedScore = (value) => {
    const numeric = Number(value || 0);
    const sign = numeric > 0 ? "+" : "";
    return `${sign}${numeric.toFixed(2)}`;
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
          <div style={{ fontSize: 13, color: "#666" }}>{narrativeHeadline}</div>
        </div>
      </div>

      {hasNarrative && (
        <div style={{ marginBottom: 14, border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: "#fff" }}>
          <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
            Why This Score
          </div>

          {narrativeDrivers.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>Drivers</div>
              <ul style={{ margin: 0, paddingLeft: 16, color: "#4b5563", fontSize: 12 }}>
                {narrativeDrivers.map((item, idx) => (
                  <li key={`driver-${idx}`} style={{ marginBottom: 2 }}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {narrativeEvidence.length > 0 && (
            <div style={{ marginBottom: narrativeRisks.length ? 8 : 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>Evidence Highlights</div>
              <ul style={{ margin: 0, paddingLeft: 16, color: "#4b5563", fontSize: 12 }}>
                {narrativeEvidence.map((item, idx) => (
                  <li key={`evidence-${idx}`} style={{ marginBottom: 2 }}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {narrativeRisks.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#9a3412", marginBottom: 4 }}>Watchouts</div>
              <ul style={{ margin: 0, paddingLeft: 16, color: "#9a3412", fontSize: 12 }}>
                {narrativeRisks.map((item, idx) => (
                  <li key={`risk-${idx}`} style={{ marginBottom: 2 }}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {hasLayers && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 10, borderBottom: "1px solid #e0e3e8", paddingBottom: 6 }}>
            Score Layers
          </div>
          {Object.entries(LAYER_LABELS).map(([key, label]) => {
            const layer = scoreBreakdown[key];
            if (!layer) return null;

            const tuningAdjustments = key === "competitor_context" && Array.isArray(layer.holistic_tuning_adjustments)
              ? layer.holistic_tuning_adjustments
                .map((item) => ({
                  reason: String(item?.reason || "").trim(),
                  impact: Number(item?.impact || 0),
                }))
                .filter((item) => item.reason)
              : [];

            const tuningSummary = [];
            if (isFiniteNumber(layer.base_score)) {
              tuningSummary.push(`Base ${Number(layer.base_score).toFixed(2)}`);
            }
            if (isFiniteNumber(layer.motion_tuning_delta)) {
              tuningSummary.push(`Motion ${formatSignedScore(layer.motion_tuning_delta)}`);
            }
            if (isFiniteNumber(layer.holistic_tuning_delta)) {
              tuningSummary.push(`Holistic ${formatSignedScore(layer.holistic_tuning_delta)}`);
            }

            const hasCompetitorTuning = key === "competitor_context"
              && (tuningSummary.length > 0 || tuningAdjustments.length > 0);

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
                {hasCompetitorTuning && (
                  <div style={{ fontSize: 12, color: "#4b5563", paddingLeft: 138, marginTop: 6 }}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>Context Tuning</div>
                    {tuningSummary.length > 0 && (
                      <div>{tuningSummary.join(" | ")}</div>
                    )}
                    {tuningAdjustments.length > 0 && (
                      <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                        {tuningAdjustments.slice(0, 4).map((item, idx) => (
                          <li key={`adj-${idx}`}>
                            {item.reason.replace(/_/g, " ")} ({formatSignedScore(item.impact)})
                          </li>
                        ))}
                      </ul>
                    )}
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
  scoreNarrative: PropTypes.shape({
    headline: PropTypes.string,
    drivers: PropTypes.arrayOf(PropTypes.string),
    risks: PropTypes.arrayOf(PropTypes.string),
    evidence: PropTypes.arrayOf(PropTypes.string),
  }),
};

export default ScoreExplanation;
