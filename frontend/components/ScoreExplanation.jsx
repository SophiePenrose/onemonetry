import React from "react";
import PropTypes from "prop-types";

function ScoreExplanation({ productFit, scoreBreakdown, finalScore, explanation }) {
  return (
    <div style={{ border: "1px solid #ccc", padding: 12, marginTop: 8 }}>
      <div><strong>Final Score:</strong> {finalScore ?? "N/A"}</div>
      <div><strong>Product Motion:</strong> {productFit?.motion ?? "N/A"}</div>
      <div><strong>Fit Level:</strong> {productFit?.fit_level ?? "N/A"}</div>
      <div><strong>Eligible:</strong> {productFit?.eligible === undefined ? "N/A" : productFit.eligible ? "Yes" : "No"}</div>
      <div><strong>Score Breakdown:</strong></div>
      <ul>
        {scoreBreakdown && Object.keys(scoreBreakdown).length > 0 ? (
          Object.entries(scoreBreakdown).map(([k, v]) => (
            <li key={k}><strong>{k}:</strong> {v}</li>
          ))
        ) : (
          <li>N/A</li>
        )}
      </ul>
      <div><strong>Explanation:</strong></div>
      <div>{explanation ?? "N/A"}</div>
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
