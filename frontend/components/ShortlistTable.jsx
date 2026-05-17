import React from "react";
import PropTypes from "prop-types";

function formatTurnover(value) {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function fitBadge(level) {
  const colors = { strong: "#0a8754", medium: "#c27b00", weak: "#c0392b" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: colors[level] || "#888",
        textTransform: "capitalize",
      }}
    >
      {level}
    </span>
  );
}

function ShortlistTable({ companies, onSelectCompany }) {
  if (!companies || companies.length === 0) {
    return <div style={{ color: "#888", padding: 16 }}>No companies match this motion.</div>;
  }

  return (
    <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
      <thead>
        <tr style={{ background: "#f0f2f5", textAlign: "left", fontSize: 13, color: "#555" }}>
          <th style={{ padding: "10px 16px" }}>#</th>
          <th style={{ padding: "10px 16px" }}>Company</th>
          <th style={{ padding: "10px 16px" }}>Industry</th>
          <th style={{ padding: "10px 16px", textAlign: "right" }}>Turnover</th>
          <th style={{ padding: "10px 16px", textAlign: "center" }}>Fit</th>
          <th style={{ padding: "10px 16px", textAlign: "right" }}>Score</th>
          <th style={{ padding: "10px 16px" }}>Explanation</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((company) => (
          <tr
            key={company.id}
            onClick={() => onSelectCompany && onSelectCompany(company)}
            style={{ cursor: onSelectCompany ? "pointer" : "default", borderBottom: "1px solid #eee" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f9fb")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <td style={{ padding: "10px 16px", color: "#888", fontSize: 13 }}>{company.rank}</td>
            <td style={{ padding: "10px 16px", fontWeight: 600 }}>
              {onSelectCompany ? (
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); onSelectCompany(company); }}
                  style={{ color: "#0075EB", textDecoration: "none" }}
                >
                  {company.name}
                </a>
              ) : (
                company.name
              )}
            </td>
            <td style={{ padding: "10px 16px", color: "#666", fontSize: 13 }}>{company.industry || "—"}</td>
            <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13 }}>{company.turnover ? formatTurnover(company.turnover) : "—"}</td>
            <td style={{ padding: "10px 16px", textAlign: "center" }}>{fitBadge(company.fit_level)}</td>
            <td style={{ padding: "10px 16px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{company.score?.toFixed(2)}</td>
            <td style={{ padding: "10px 16px", color: "#666", fontSize: 13, maxWidth: 300 }}>{company.explanation}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

ShortlistTable.propTypes = {
  companies: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      rank: PropTypes.number.isRequired,
      name: PropTypes.string.isRequired,
      score: PropTypes.number.isRequired,
      product_motion: PropTypes.string.isRequired,
      explanation: PropTypes.string.isRequired,
    })
  ).isRequired,
  onSelectCompany: PropTypes.func,
};

export default ShortlistTable;
