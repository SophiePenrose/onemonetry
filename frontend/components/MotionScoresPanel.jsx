import React, { useState } from "react";
import PropTypes from "prop-types";
import ScoreExplanation from "./ScoreExplanation";

const FIT_COLORS = { strong: "#0a8754", medium: "#c27b00", weak: "#c0392b" };

function MotionCard({ motionScore, isExpanded, onToggle }) {
  return (
    <div style={{
      background: "#fff", border: isExpanded ? "2px solid #0075EB" : "1px solid #e0e3e8",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div
        onClick={onToggle}
        style={{
          padding: "12px 16px", cursor: "pointer", display: "flex",
          alignItems: "center", justifyContent: "space-between",
          background: isExpanded ? "#f0f7ff" : "transparent",
        }}
        onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = "#f8f9fb"; }}
        onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{motionScore.motion}</span>
          <span style={{
            display: "inline-block", padding: "2px 8px", borderRadius: 10,
            fontSize: 11, fontWeight: 600, color: "#fff",
            background: FIT_COLORS[motionScore.fit_level] || "#888",
            textTransform: "capitalize",
          }}>
            {motionScore.fit_level}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {motionScore.merchant_boost > 0 && (
            <span style={{ fontSize: 10, fontWeight: 600, color: "#0a8754", background: "#d1fae5", padding: "2px 6px", borderRadius: 6 }}>
              +{(motionScore.merchant_boost * 100).toFixed(0)}bps merchant
            </span>
          )}
          <span style={{ fontWeight: 700, fontSize: 16, fontVariantNumeric: "tabular-nums", color: "#0075EB" }}>
            {motionScore.score.toFixed(2)}
          </span>
          <span style={{ color: "#aaa", fontSize: 14 }}>{isExpanded ? "▾" : "▸"}</span>
        </div>
      </div>
      {isExpanded && (
        <div style={{ padding: "0 16px 16px" }}>
          <div style={{ fontSize: 13, color: "#555", marginBottom: 12 }}>{motionScore.explanation}</div>
          <ScoreExplanation
            productFit={{ fit_level: motionScore.fit_level }}
            scoreBreakdown={motionScore.score_breakdown}
            finalScore={motionScore.score}
            explanation={motionScore.explanation}
          />
        </div>
      )}
    </div>
  );
}

MotionCard.propTypes = {
  motionScore: PropTypes.object.isRequired,
  isExpanded: PropTypes.bool,
  onToggle: PropTypes.func,
};

export default function MotionScoresPanel({ motionScores, combinedScore }) {
  const [expandedMotion, setExpandedMotion] = useState(motionScores?.[0]?.motion || null);

  if (!motionScores || motionScores.length === 0) {
    return null;
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>
          Product Motion Scores
          <span style={{ fontWeight: 400, color: "#888", fontSize: 13, marginLeft: 8 }}>
            {motionScores.length} eligible {motionScores.length === 1 ? "motion" : "motions"}
          </span>
        </h3>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1 }}>Combined</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#0075EB" }}>{combinedScore?.toFixed(2)}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {motionScores.map((ms) => (
          <MotionCard
            key={ms.motion}
            motionScore={ms}
            isExpanded={expandedMotion === ms.motion}
            onToggle={() => setExpandedMotion(expandedMotion === ms.motion ? null : ms.motion)}
          />
        ))}
      </div>
    </div>
  );
}

MotionScoresPanel.propTypes = {
  motionScores: PropTypes.array.isRequired,
  combinedScore: PropTypes.number,
};
