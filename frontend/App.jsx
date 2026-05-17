import React, { useEffect, useState } from "react";
import Home from "./pages/Home";
import Shortlist from "./pages/Shortlist";
import CompanyDetail from "./pages/CompanyDetail";

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
  const [view, setView] = useState("home");
  const [selectedMotion, setSelectedMotion] = useState(null);
  const [deepLinkCompany, setDeepLinkCompany] = useState(null);

  useEffect(() => {
    fetch("/api/motions")
      .then((res) => res.json())
      .then((data) => setMotions(data.motions || []))
      .catch(() => setMotions(Object.keys(MOTION_LABELS)));
  }, []);

  function navigateToMotion(motion) {
    setSelectedMotion(motion);
    setDeepLinkCompany(null);
    setView("shortlist");
  }

  function navigateToCompany(companyId, motion) {
    setSelectedMotion(motion);
    setDeepLinkCompany(companyId);
    setView("company_detail");
  }

  function navigateHome() {
    setView("home");
    setDeepLinkCompany(null);
  }

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#f6f7f9", minHeight: "100vh" }}>
      <header style={{ background: "#0075EB", color: "#fff", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{ fontWeight: 700, fontSize: 20, cursor: "pointer" }}
          onClick={navigateHome}
        >
          Onemonetry
        </span>
        <span style={{ opacity: 0.7, fontSize: 14 }}>Prospecting Workspace</span>
      </header>

      <nav style={{ display: "flex", gap: 0, background: "#fff", borderBottom: "1px solid #e0e3e8", padding: "0 24px", overflowX: "auto" }}>
        <button
          onClick={navigateHome}
          style={{
            padding: "12px 20px",
            border: "none",
            borderBottom: view === "home" ? "3px solid #0075EB" : "3px solid transparent",
            background: "none",
            color: view === "home" ? "#0075EB" : "#555",
            fontWeight: view === "home" ? 600 : 400,
            fontSize: 14,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          ⌂ Workspace
        </button>
        <div style={{ width: 1, background: "#e0e3e8", margin: "8px 4px" }} />
        {motions.map((m) => {
          const isActive = view === "shortlist" && selectedMotion === m;
          return (
            <button
              key={m}
              onClick={() => navigateToMotion(m)}
              style={{
                padding: "12px 20px",
                border: "none",
                borderBottom: isActive ? "3px solid #0075EB" : "3px solid transparent",
                background: "none",
                color: isActive ? "#0075EB" : "#555",
                fontWeight: isActive ? 600 : 400,
                fontSize: 14,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {MOTION_LABELS[m] || m}
            </button>
          );
        })}
      </nav>

      <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        {view === "home" && (
          <Home
            onNavigateToMotion={navigateToMotion}
            onNavigateToCompany={navigateToCompany}
          />
        )}
        {view === "shortlist" && selectedMotion && (
          <Shortlist productMotion={selectedMotion} />
        )}
        {view === "company_detail" && deepLinkCompany && selectedMotion && (
          <div>
            <button
              onClick={navigateHome}
              style={{
                padding: "8px 16px",
                border: "1px solid #ddd",
                borderRadius: 6,
                background: "#fff",
                cursor: "pointer",
                fontSize: 14,
                marginBottom: 16,
              }}
            >
              ← Back to Workspace
            </button>
            <CompanyDetail companyId={deepLinkCompany} productMotion={selectedMotion} />
          </div>
        )}
      </main>
    </div>
  );
}
