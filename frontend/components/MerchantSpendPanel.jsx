import React from "react";
import PropTypes from "prop-types";

function formatCurrency(value) {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function StatBox({ label, value, sub }) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 100, padding: "10px 14px", background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0075EB" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#aaa", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

StatBox.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.node.isRequired, sub: PropTypes.string };

export default function MerchantSpendPanel({ merchantSpend }) {
  if (!merchantSpend) return null;

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Merchant Spend Data</h3>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#0a8754", background: "#d1fae5", padding: "2px 8px", borderRadius: 8 }}>
          Proprietary
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <StatBox
          label="Annual Card Volume"
          value={formatCurrency(merchantSpend.annual_card_volume)}
        />
        <StatBox
          label="Avg Transaction"
          value={`£${merchantSpend.avg_transaction}`}
        />
        <StatBox
          label="Online Share"
          value={`${Math.round(merchantSpend.online_share * 100)}%`}
        />
        <StatBox
          label="YoY Growth"
          value={`${merchantSpend.growth_rate > 0 ? "+" : ""}${Math.round(merchantSpend.growth_rate * 100)}%`}
        />
      </div>
      <div style={{ fontSize: 13, color: "#555", background: "#eff6ff", padding: "8px 12px", borderRadius: 6, borderLeft: "3px solid #0075EB" }}>
        <strong>Wallet opportunity:</strong> {merchantSpend.wallet_opportunity}
      </div>
    </div>
  );
}

MerchantSpendPanel.propTypes = {
  merchantSpend: PropTypes.shape({
    annual_card_volume: PropTypes.number,
    avg_transaction: PropTypes.number,
    online_share: PropTypes.number,
    growth_rate: PropTypes.number,
    wallet_opportunity: PropTypes.string,
  }),
};
