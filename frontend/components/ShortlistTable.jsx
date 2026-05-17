import React from "react";
import PropTypes from "prop-types";

function formatTurnover(value) {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

const FIT_COLORS = { strong: "#0a8754", medium: "#c27b00", weak: "#c0392b" };

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

function Badge({ text, bg }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: bg || "#888",
        textTransform: "capitalize",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

Badge.propTypes = { text: PropTypes.string.isRequired, bg: PropTypes.string };

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
          <th style={{ padding: "10px 16px", textAlign: "center" }}>Status</th>
          <th style={{ padding: "10px 16px" }}>Explanation</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((company) => {
          const sm = STATE_META[company.workflow_state] || STATE_META.new_candidate;
          const suppressed = company.suppressed;
          return (
            <tr
              key={company.id}
              onClick={() => onSelectCompany && onSelectCompany(company)}
              style={{
                cursor: onSelectCompany ? "pointer" : "default",
                borderBottom: "1px solid #eee",
                opacity: suppressed ? 0.5 : 1,
                background: suppressed ? "#f9fafb" : "transparent",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = suppressed ? "#f0f1f3" : "#f8f9fb")}
              onMouseLeave={(e) => (e.currentTarget.style.background = suppressed ? "#f9fafb" : "transparent")}
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
              <td style={{ padding: "10px 16px", textAlign: "center" }}>
                <Badge text={company.fit_level} bg={FIT_COLORS[company.fit_level]} />
              </td>
              <td style={{ padding: "10px 16px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{company.score?.toFixed(2)}</td>
              <td style={{ padding: "10px 16px", textAlign: "center" }}>
                <Badge text={sm.label} bg={sm.color} />
              </td>
              <td style={{ padding: "10px 16px", color: "#666", fontSize: 13, maxWidth: 280 }}>{company.explanation}</td>
            </tr>
          );
        })}
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
