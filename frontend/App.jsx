import React, { useEffect, useState } from "react";
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
  const [runtimeStatus, setRuntimeStatus] = useState({
    loading: true,
    backendReachable: true,
    openaiConfigured: true,
    openaiModel: null,
    integrationConfiguredCount: 0,
    integrationTotalCount: 0,
    missingRequired: [],
  });

  async function loadRuntimeStatus() {
    try {
      const response = await fetch("/api/integrations/status");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const openai = payload?.integrations?.openai || {};
      const integrations = payload?.integrations && typeof payload.integrations === "object"
        ? payload.integrations
        : {};
      const integrationEntries = Object.values(integrations);
      const integrationConfiguredCount = integrationEntries.filter((item) => item?.configured === true).length;
      const integrationTotalCount = integrationEntries.length;
      setRuntimeStatus({
        loading: false,
        backendReachable: true,
        openaiConfigured: openai.configured === true,
        openaiModel: openai.model || null,
        integrationConfiguredCount,
        integrationTotalCount,
        missingRequired: Array.isArray(payload?.missing_required) ? payload.missing_required : [],
      });
    } catch {
      setRuntimeStatus((current) => ({
        ...current,
        loading: false,
        backendReachable: false,
        integrationConfiguredCount: 0,
        integrationTotalCount: 0,
        missingRequired: [],
      }));
    }
  }

  useEffect(() => {
    loadRuntimeStatus();
    const timer = window.setInterval(() => {
      loadRuntimeStatus();
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);

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
          : returnView === "settings"
            ? "Settings"
            : "Workspace";
  const tabs = [
    { id: "shortlist", label: "This Week", action: navigateShortlist },
    { id: "home", label: "All Companies", action: navigateHome },
    { id: "reports", label: "Performance", action: navigateReports },
    { id: "import", label: "Data Pipeline", action: navigateImport },
  ];
  const showRuntimeBanner = !runtimeStatus.loading && (!runtimeStatus.backendReachable || !runtimeStatus.openaiConfigured);
  const runtimeBannerTone = runtimeStatus.backendReachable ? "warning" : "error";
  const integrationSummaryText = runtimeStatus.loading
    ? "Integrations: checking..."
    : runtimeStatus.integrationTotalCount > 0
      ? `Integrations: ${runtimeStatus.integrationConfiguredCount}/${runtimeStatus.integrationTotalCount} configured`
      : "Integrations: unavailable";
  const missingRequiredMessage = runtimeStatus.missingRequired.length > 0
    ? ` Missing required integrations: ${runtimeStatus.missingRequired.join(", ")}.`
    : "";

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
          <span style={{ color: "#64748b", fontSize: 12 }}>{integrationSummaryText}</span>
        </div>

        <div className="app-secondary-actions" aria-label="Secondary navigation">
          <button
            type="button"
            className={`app-secondary-button${view === "settings" ? " active" : ""}`}
            onClick={navigateSettings}
          >
            Settings & Integrations
          </button>
          <button type="button" className="app-secondary-button" disabled>
            Account
          </button>
        </div>
      </header>

      {showRuntimeBanner && (
        <section
          className={`app-status-banner app-status-banner-${runtimeBannerTone}`}
          role="status"
          aria-live="polite"
        >
          <div className="app-status-banner-copy">
            <strong>
              {runtimeStatus.backendReachable ? "LLM Mode Is Off" : "Backend Unreachable"}
            </strong>
            <span>
              {runtimeStatus.backendReachable
                ? `OPENAI_API_KEY is not configured, so generation is running in fallback mode. Configure the key in Settings for true LLM output${runtimeStatus.openaiModel ? ` (${runtimeStatus.openaiModel})` : ""}.${missingRequiredMessage}`
                : "The frontend cannot reach the backend API right now, so data and LLM generation are unavailable until it reconnects. Start services with npm run start:dev and check health with npm run status:dev."}
            </span>
          </div>
          <div className="app-status-banner-actions">
            <button type="button" onClick={loadRuntimeStatus}>Recheck</button>
            <button type="button" onClick={navigateSettings}>Open Settings</button>
          </div>
        </section>
      )}

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
        {view === "settings" && <Settings onNavigateToCompany={(id) => navigateToCompany(id, "settings")} />}
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
