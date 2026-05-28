import React, { useState } from "react";
import Home from "./pages/Home";
import Shortlist from "./pages/Shortlist";
import CompanyDetail from "./pages/CompanyDetail";
import Reports from "./pages/Reports";
import AddCompany from "./pages/AddCompany";
import Import from "./pages/Import";
import Settings from "./pages/Settings";

export default function App() {
  const [view, setView] = useState("shortlist");
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

  function navigateImport() {
    setView("import");
    setSelectedCompanyId(null);
    setReturnView(null);
  }

  function navigateSettings() {
    setView("settings");
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

  const backLabel = returnView === "reports"
    ? "Performance"
    : returnView === "shortlist"
      ? "This Week"
      : returnView === "home"
        ? "All Companies"
        : returnView === "import"
          ? "Data Pipeline"
          : "Workspace";
  const tabs = [
    { id: "shortlist", label: "This Week", action: navigateShortlist },
    { id: "home", label: "All Companies", action: navigateHome },
    { id: "reports", label: "Performance", action: navigateReports },
    { id: "import", label: "Data Pipeline", action: navigateImport },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <button type="button" className="app-brand" onClick={navigateShortlist}>
          <span className="app-brand-mark">Prospector</span>
          <span className="app-brand-subtitle">Mid-Market Intelligence</span>
        </button>

        <div className="app-top-meta" aria-label="Workspace context">
          <span className="app-live-dot" aria-hidden="true" />
          <span>Revolut Business</span>
        </div>

        <div className="app-secondary-actions" aria-label="Secondary navigation">
          <button
            type="button"
            className={`app-secondary-button${view === "settings" ? " active" : ""}`}
            onClick={navigateSettings}
          >
            Settings
          </button>
          <button type="button" className="app-secondary-button" disabled>
            Account
          </button>
        </div>
      </header>

      <div className="app-nav-wrap">
        <nav className="app-nav" aria-label="Primary">
          {tabs.map((tab) => {
          const isActive = view === tab.id || (view === "company_detail" && returnView === tab.id) || (view === "add_company" && tab.id === "shortlist");
          return (
            <button
              key={tab.id}
              onClick={tab.action}
              className={`app-nav-button${isActive ? " active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              {tab.label}
            </button>
          );
        })}
        </nav>
      </div>

      <main className="app-main">
        {view === "home" && (
          <Home onNavigateToCompany={(id) => navigateToCompany(id, "home")} />
        )}
        {view === "shortlist" && (
          <Shortlist
            onSelectCompany={(id) => navigateToCompany(id, "shortlist")}
            onShowAddCompany={() => setView("add_company")}
          />
        )}
        {view === "add_company" && (
          <AddCompany
            onCompanyAdded={(company) => navigateToCompany(company.id, "shortlist")}
            onCancel={navigateShortlist}
          />
        )}
        {view === "import" && <Import />}
        {view === "settings" && <Settings />}
        {view === "reports" && (
          <Reports onNavigateToCompany={(id) => navigateToCompany(id, "reports")} />
        )}
        {view === "company_detail" && selectedCompanyId && (
          <div>
            <button
              onClick={handleBackFromDetail}
              className="detail-back-button"
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
