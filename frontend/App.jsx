import React, { useState } from "react";
import Home from "./pages/Home";
import Shortlist from "./pages/Shortlist";
import CompanyDetail from "./pages/CompanyDetail";
import Reports from "./pages/Reports";

export default function App() {
  const [view, setView] = useState("home");
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);
  const [returnView, setReturnView] = useState(null);

  function navigateHome() {
    setView("home");
    setSelectedCompanyId(null);
    setReturnView(null);
  }

  function navigateShortlist() {
    setView("shortlist");
    setSelectedCompanyId(null);
    setReturnView(null);
  }

  function navigateReports() {
    setView("reports");
    setSelectedCompanyId(null);
    setReturnView(null);
  }

  function navigateToCompany(companyId, fromView) {
    setSelectedCompanyId(companyId);
    setReturnView(fromView || view);
    setView("company_detail");
  }

  function handleBackFromDetail() {
    const target = returnView || "home";
    setView(target);
    setSelectedCompanyId(null);
    setReturnView(null);
  }

  const backLabel = returnView === "reports" ? "Reports" : returnView === "shortlist" ? "Shortlist" : "Workspace";

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#f6f7f9", minHeight: "100vh" }}>
      <header style={{ background: "#0075EB", color: "#fff", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 20, cursor: "pointer" }} onClick={navigateHome}>
          Onemonetry
        </span>
        <span style={{ opacity: 0.7, fontSize: 14 }}>Prospecting Workspace</span>
      </header>

      <nav style={{ display: "flex", gap: 0, background: "#fff", borderBottom: "1px solid #e0e3e8", padding: "0 24px" }}>
        {[
          { id: "home", label: "⌂ Workspace", action: navigateHome },
          { id: "shortlist", label: "📋 Shortlist", action: navigateShortlist },
          { id: "reports", label: "📊 Reports", action: navigateReports },
        ].map((tab) => {
          const isActive = view === tab.id || (view === "company_detail" && returnView === tab.id);
          return (
            <button
              key={tab.id}
              onClick={tab.action}
              style={{
                padding: "12px 20px", border: "none",
                borderBottom: isActive ? "3px solid #0075EB" : "3px solid transparent",
                background: "none",
                color: isActive ? "#0075EB" : "#555",
                fontWeight: isActive ? 600 : 400,
                fontSize: 14, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        {view === "home" && (
          <Home
            onNavigateToCompany={(id) => navigateToCompany(id, "home")}
          />
        )}
        {view === "shortlist" && (
          <Shortlist onSelectCompany={(id) => navigateToCompany(id, "shortlist")} />
        )}
        {view === "reports" && (
          <Reports onNavigateToCompany={(id) => navigateToCompany(id, "reports")} />
        )}
        {view === "company_detail" && selectedCompanyId && (
          <div>
            <button
              onClick={handleBackFromDetail}
              style={{
                padding: "8px 16px", border: "1px solid #ddd", borderRadius: 6,
                background: "#fff", cursor: "pointer", fontSize: 14, marginBottom: 16,
              }}
            >
              ← Back to {backLabel}
            </button>
            <CompanyDetail companyId={selectedCompanyId} />
          </div>
        )}
      </main>
    </div>
  );
}
