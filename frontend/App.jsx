import React, { useEffect, useState } from "react";
import Shortlist from "./pages/Shortlist";

const MOTION_LABELS = {
  FX: "FX / Multicurrency",
  "FX Forwards": "FX Forwards",
  Cards: "Corporate Cards",
  "Spend Management": "Spend Management",
  "API Integrations": "API Integrations",
  "Merchant Acquiring": "Merchant Acquiring",
  "Revolut Pay": "Revolut Pay",
  "Monthly Plans": "Monthly Plans",
};

export default function App() {
  const [motions, setMotions] = useState([]);
  const [selectedMotion, setSelectedMotion] = useState(null);

  useEffect(() => {
    fetch("/api/motions")
      .then((res) => res.json())
      .then((data) => {
        setMotions(data.motions || []);
        if (data.motions?.length > 0) setSelectedMotion(data.motions[0]);
      })
      .catch(() => setMotions(Object.keys(MOTION_LABELS)));
  }, []);

  if (!selectedMotion) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#f6f7f9", minHeight: "100vh" }}>
      <header style={{ background: "#0075EB", color: "#fff", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 20 }}>Onemonetry</span>
        <span style={{ opacity: 0.7, fontSize: 14 }}>Prospecting Workspace</span>
      </header>

      <nav style={{ display: "flex", gap: 0, background: "#fff", borderBottom: "1px solid #e0e3e8", padding: "0 24px", overflowX: "auto" }}>
        {motions.map((m) => (
          <button
            key={m}
            onClick={() => setSelectedMotion(m)}
            style={{
              padding: "12px 20px",
              border: "none",
              borderBottom: selectedMotion === m ? "3px solid #0075EB" : "3px solid transparent",
              background: "none",
              color: selectedMotion === m ? "#0075EB" : "#555",
              fontWeight: selectedMotion === m ? 600 : 400,
              fontSize: 14,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {MOTION_LABELS[m] || m}
          </button>
        ))}
      </nav>

      <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        <Shortlist productMotion={selectedMotion} />
      </main>
    </div>
  );
}
