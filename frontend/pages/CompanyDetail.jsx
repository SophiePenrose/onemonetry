import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import MotionScoresPanel from "../components/MotionScoresPanel";
import WorkflowPanel from "../components/WorkflowPanel";
import CompetitorPanel from "../components/CompetitorPanel";
import StakeholderPanel from "../components/StakeholderPanel";
import CadenceLog from "../components/CadenceLog";
import NotesPanel from "../components/NotesPanel";
import CompanyAnalysis from "../components/CompanyAnalysis";
import EvidencePanel from "../components/EvidencePanel";
import EmailSequencePanel from "../components/EmailSequencePanel";
import MerchantSpendPanel from "../components/MerchantSpendPanel";
import EnrichmentSignalsPanel from "../components/EnrichmentSignalsPanel";
import GeminiYammPanel from "../components/GeminiYammPanel";
import StakeholderAlertsPanel from "../components/StakeholderAlertsPanel";
import { DetailSkeleton } from "../components/LoadingSkeleton";

const EMPTY_ARRAY = [];

function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatTurnover(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 0) return "N/A";
  if (numeric >= 1_000_000) return `£${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `£${(numeric / 1_000).toFixed(0)}K`;
  return `£${numeric}`;
}

export function formatScore(value, digits = 2) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? "N/A" : numeric.toFixed(digits);
}

export function formatPercent(value, digits = 0) {
  const numeric = toFiniteNumber(value);
  return numeric === null ? "N/A" : `${(numeric * 100).toFixed(digits)}%`;
}

export function formatBpsDelta(finalScore, baseScore) {
  const finalNumeric = toFiniteNumber(finalScore);
  const baseNumeric = toFiniteNumber(baseScore);
  if (finalNumeric === null || baseNumeric === null) return "N/A";
  const bps = (finalNumeric - baseNumeric) * 100;
  const sign = bps > 0 ? "+" : "";
  return `${sign}${bps.toFixed(0)}bps`;
}

export function formatOwnershipTimestamp(value) {
  if (!value) return "Unknown";
  const ts = Date.parse(String(value));
  if (!Number.isFinite(ts)) return "Unknown";
  return new Date(ts).toLocaleString("en-GB");
}

function formatUnresolvedCompanyNameReason(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "Name needs confirmation";
  if (token === "missing_company_name") return "Name missing";
  if (token === "placeholder_company_number") return "Placeholder name";
  if (token === "name_lookup_needed") return "Name lookup needed";
  if (token === "name_lookup_pending") return "Name lookup pending";
  if (token === "unknown_company") return "Unknown company label";
  if (token === "not_available") return "Name unavailable";
  if (token === "to_be_confirmed") return "Name to be confirmed";
  if (token === "non_company_heading") return "Heading text detected";
  return token.replaceAll("_", " ");
}

function Field({ label, children }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid #f0f0f0", display: "flex", gap: 12 }}>
      <span style={{ color: "#888", fontSize: 13, minWidth: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 14 }}>{children}</span>
    </div>
  );
}

Field.propTypes = { label: PropTypes.string.isRequired, children: PropTypes.node };

export function selectCompetitorContextMotion(allMotionScores = []) {
  const withContext = (Array.isArray(allMotionScores) ? allMotionScores : [])
    .filter((motion) => {
      const layer = motion?.score_breakdown?.competitor_context;
      return layer && typeof layer === "object";
    });

  if (withContext.length === 0) return null;

  const toFiniteNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return withContext.reduce((best, motion) => {
    if (!best) return motion;

    const bestScore = toFiniteNumber(best?.score);
    const motionScore = toFiniteNumber(motion?.score);
    const bestContextScore = toFiniteNumber(best?.score_breakdown?.competitor_context?.score);
    const motionContextScore = toFiniteNumber(motion?.score_breakdown?.competitor_context?.score);

    if (motionScore !== null && bestScore === null) {
      return motion;
    }

    if (motionScore !== null && bestScore !== null && motionScore > bestScore) {
      return motion;
    }

    if (motionScore !== null && bestScore !== null && motionScore < bestScore) {
      return best;
    }

    if (motionContextScore !== null && bestContextScore === null) {
      return motion;
    }

    if (motionContextScore !== null && bestContextScore !== null && motionContextScore > bestContextScore) {
      return motion;
    }

    return best;
  }, null);
}

export default function CompanyDetail({ companyId }) {
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ownershipRefreshing, setOwnershipRefreshing] = useState(false);
  const [ownershipRefreshError, setOwnershipRefreshError] = useState(null);
  const [transitions, setTransitions] = useState({});
  const companyRequestRef = useRef(0);
  const companyPendingRequestsRef = useRef(0);

  useEffect(() => {
    fetch("/api/workflow-states")
      .then((res) => res.json())
      .then((data) => setTransitions(data.transitions || {}))
      .catch(() => {});
  }, []);

  const loadCompanyDetail = useCallback((background = false) => {
    if (!companyId) return;

    if (background && companyPendingRequestsRef.current > 0) {
      return;
    }

    const requestId = companyRequestRef.current + 1;
    companyRequestRef.current = requestId;
    companyPendingRequestsRef.current += 1;

    if (!background) {
      setLoading(true);
      setError(null);
    }

    fetch(`/api/company/${encodeURIComponent(companyId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to fetch company detail");
        }
        return res.json();
      })
      .then((data) => {
        if (companyRequestRef.current === requestId) {
          setCompany(data.company);
        }
      })
      .catch((err) => {
        if (!background && companyRequestRef.current === requestId) {
          setError(err.message);
        }
      })
      .finally(() => {
        companyPendingRequestsRef.current = Math.max(0, companyPendingRequestsRef.current - 1);
        if (!background && companyRequestRef.current === requestId) {
          setLoading(false);
        }
      });
  }, [companyId]);

  useEffect(() => {
    loadCompanyDetail(false);
  }, [loadCompanyDetail]);

  useEffect(() => {
    if (!companyId) return undefined;
    const timer = setInterval(() => loadCompanyDetail(true), 20000);
    return () => clearInterval(timer);
  }, [companyId, loadCompanyDetail]);

  const handleStateChange = useCallback((data) => {
    setCompany((prev) => prev ? {
      ...prev,
      workflow_state: data.new_state,
      workflow_history: data.history,
    } : prev);
  }, []);

  const refreshCompany = useCallback(() => {
    loadCompanyDetail(true);
  }, [loadCompanyDetail]);

  const refreshOwnershipStructure = useCallback(async () => {
    if (!companyId) return;

    setOwnershipRefreshing(true);
    setOwnershipRefreshError(null);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(companyId)}/ownership/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to refresh ownership structure");
      }

      setCompany((prev) => prev ? {
        ...prev,
        ownership_structure: data.ownership_structure || null,
      } : prev);
    } catch (err) {
      setOwnershipRefreshError(err.message || "Failed to refresh ownership structure");
    } finally {
      setOwnershipRefreshing(false);
    }
  }, [companyId]);

  const analysisStatus = company?.analysis_status || (company?.analysis ? "ready" : "none");
  const analysisStatusLabel = analysisStatus === "queued"
    ? "In progress"
    : analysisStatus === "failed"
      ? "Needs retry"
      : analysisStatus === "ready"
        ? "Ready"
        : "Pending";
  const allMotionScores = company?.all_motion_scores || EMPTY_ARRAY;
  const stakeholders = company?.stakeholders || EMPTY_ARRAY;
  const filings = company?.filings || EMPTY_ARRAY;
  const cadenceHistory = company?.cadence_history || EMPTY_ARRAY;
  const workflowHistory = company?.workflow_history || EMPTY_ARRAY;
  const keyPeople = company?.analysis?.key_people || EMPTY_ARRAY;
  const sicCodes = Array.isArray(company?.sic_codes) ? company.sic_codes : EMPTY_ARRAY;
  const ownershipStructure = company?.ownership_structure || null;
  const significantControllers = Array.isArray(ownershipStructure?.significant_corporate_controllers)
    ? ownershipStructure.significant_corporate_controllers
    : EMPTY_ARRAY;
  const nonUkControllers = Array.isArray(ownershipStructure?.non_uk_significant_corporate_controllers)
    ? ownershipStructure.non_uk_significant_corporate_controllers
    : EMPTY_ARRAY;
  const ownershipClassLabel = String(ownershipStructure?.structure || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const ownershipConfidenceLabel = String(ownershipStructure?.confidence || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const ownershipUpdatedAtLabel = formatOwnershipTimestamp(
    ownershipStructure?.updated_at || ownershipStructure?.fetched_at
  );
  const ownershipSourceLabel = String(ownershipStructure?.source || "companies_house_psc")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const eligibleMotionsLabel = useMemo(
    () => allMotionScores.map((motion) => motion.motion).join(", "),
    [allMotionScores],
  );

  const competitorContextMotionData = useMemo(
    () => selectCompetitorContextMotion(allMotionScores),
    [allMotionScores],
  );

  const competitorContext = competitorContextMotionData?.score_breakdown?.competitor_context || null;
  const competitorContextMotion = competitorContextMotionData?.motion || null;
  const propensityScore = toFiniteNumber(company?.propensity?.score);
  const propensityColor = propensityScore !== null
    ? propensityScore >= 0.7 ? "#0a8754" : propensityScore >= 0.5 ? "#c27b00" : "#6b7280"
    : "#6b7280";
  const propensityDeltaLabel = formatBpsDelta(company?.combined_score, company?.base_score);
  const unresolvedCompanyName = company?.unresolved_company_name === true;
  const unresolvedCompanyNameReason = formatUnresolvedCompanyNameReason(company?.unresolved_company_name_reason);

  if (!companyId) return <div>Missing company ID.</div>;
  if (loading) return <DetailSkeleton />;
  if (error) return <div style={{ color: "#c0392b" }}>{error}</div>;
  if (!company) return null;

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 8, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22 }}>{company.name}</h2>
            {unresolvedCompanyName && (
              <div
                style={{
                  display: "inline-block",
                  marginTop: 6,
                  padding: "3px 10px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#fff",
                  background: "#92400e",
                }}
              >
                Name pending: {unresolvedCompanyNameReason}
              </div>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1 }}>Combined Score</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0075EB" }}>{formatScore(company.combined_score)}</div>
          </div>
        </div>

        <Field label="Company Number">
          <a
            href={`https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#0075EB" }}
          >
            {company.company_number}
          </a>
        </Field>
        <Field label="Industry">{company.industry}</Field>
        <Field label="SIC Codes">{sicCodes.length > 0 ? sicCodes.join(", ") : "—"}</Field>
        <Field label="Turnover">{formatTurnover(company.turnover)}</Field>
        <Field label="Employees">{company.employee_count?.toLocaleString()}</Field>
        <Field label="Annual Report">
          <a href={company.latest_annual_report_url} target="_blank" rel="noopener noreferrer" style={{ color: "#0075EB" }}>View report →</a>
        </Field>
        <Field label="Segment">
          <span style={{
            display: "inline-block", padding: "2px 10px", borderRadius: 10,
            fontSize: 12, fontWeight: 600, color: "#fff",
            background: company.segment === "Enterprise" ? "#6f42c1" : company.segment === "Mid-Market" ? "#0075EB" : "#6b7280",
          }}>
            {company.segment}
          </span>
        </Field>
        <Field label="Eligible Motions">
          <span style={{ fontWeight: 600 }}>{allMotionScores.length}</span>
          <span style={{ color: "#888", marginLeft: 8 }}>
            {eligibleMotionsLabel}
          </span>
        </Field>
        <Field label="Analysis Status">
          <span style={{
            display: "inline-block",
            padding: "2px 10px",
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 600,
            color: analysisStatus === "ready" ? "#0a8754" : analysisStatus === "failed" ? "#7f1d1d" : "#92400e",
            background: analysisStatus === "ready" ? "#d1fae5" : analysisStatus === "failed" ? "#fee2e2" : "#fef3c7",
          }}>
            {analysisStatusLabel}
          </span>
        </Field>
        {company.stakeholder_priority && (
          <Field label="Stakeholder Priority">
            <span style={{ fontWeight: 600 }}>+{Math.round(company.stakeholder_priority.boost * 100)} pts</span>
            <span style={{ color: "#888", marginLeft: 8 }}>
              {company.stakeholder_priority.readiness?.reason}
            </span>
          </Field>
        )}
      </div>

      {company.propensity && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ fontSize: 16, margin: 0 }}>Response Propensity</h3>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 24 }}>
                {company.propensity.warmth === "hot" ? "🔥" : company.propensity.warmth === "warm" ? "☀️" : company.propensity.warmth === "cool" ? "🌤" : "❄️"}
              </span>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: propensityColor }}>
                  {formatPercent(company.propensity.score)}
                </div>
                <div style={{ fontSize: 11, color: "#888", textTransform: "capitalize" }}>{company.propensity.warmth}</div>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
            Base score: {formatScore(company.base_score)} · Propensity adjustment: {propensityDeltaLabel} → Final: {formatScore(company.combined_score)}
          </div>
          {company.propensity.signals?.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Signals</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {company.propensity.signals.map((s, idx) => (
                  <li key={idx} style={{ fontSize: 13, color: "#555", marginBottom: 3 }}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <MotionScoresPanel
        motionScores={allMotionScores}
        combinedScore={company.combined_score}
      />

      {filings.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Companies House Filings Read</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filings.slice(0, 5).map((filing, idx) => (
              <div key={`${filing.transaction_id || filing.balance_sheet_date || filing.description || "filing"}-${idx}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 10px", background: "#f8f9fb", borderRadius: 6, fontSize: 13 }}>
                <span>{filing.description || "Accounts filing"} {filing.balance_sheet_date ? `(${filing.balance_sheet_date})` : ""}</span>
                <span style={{ color: filing.has_content ? "#0a8754" : "#888", fontWeight: 600 }}>
                  {filing.has_content ? "Text extracted" : "Metadata only"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>Ownership Structure (Companies House)</h3>
          <button
            type="button"
            onClick={refreshOwnershipStructure}
            disabled={ownershipRefreshing}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              background: "#fff",
              fontSize: 12,
              cursor: ownershipRefreshing ? "wait" : "pointer",
            }}
          >
            {ownershipRefreshing ? "Refreshing…" : "Refresh from CH"}
          </button>
        </div>

        {ownershipRefreshError && (
          <div style={{ marginBottom: 10, fontSize: 12, color: "#991b1b" }}>{ownershipRefreshError}</div>
        )}

        {ownershipStructure ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, color: "#64748b" }}>Classified Structure</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{ownershipClassLabel}</div>
            </div>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, color: "#64748b" }}>Parent Entity</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{ownershipStructure.parent_company || "—"}</div>
              <div style={{ fontSize: 12, color: "#475569" }}>{ownershipStructure.parent_country || "Country unknown"}</div>
            </div>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, color: "#64748b" }}>Significant Corporate Controllers</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{Number(ownershipStructure.significant_corporate_controllers_count || significantControllers.length || 0)}</div>
              <div style={{ fontSize: 12, color: "#475569" }}>Non-UK: {Number(ownershipStructure.non_uk_significant_corporate_controllers_count || nonUkControllers.length || 0)}</div>
            </div>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, color: "#64748b" }}>Ownership Data Freshness</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937" }}>Updated: {ownershipUpdatedAtLabel}</div>
              <div style={{ fontSize: 12, color: "#475569" }}>Confidence: {ownershipConfidenceLabel} · Source: {ownershipSourceLabel}</div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "#64748b" }}>
            No ownership structure cached yet. Refresh to fetch PSC corporate-controller signals from Companies House.
          </div>
        )}

        {significantControllers.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>Top significant corporate controllers</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {significantControllers.slice(0, 5).map((controller, idx) => (
                <div key={`${controller.name || "controller"}-${idx}`} style={{ padding: "8px 10px", borderRadius: 6, background: "#f8f9fb", fontSize: 12, color: "#334155" }}>
                  <strong>{controller.name || "Unknown controller"}</strong>
                  <span style={{ color: "#64748b" }}> · {controller.country_registered || "Country unknown"}</span>
                  {controller.non_uk_jurisdiction && (
                    <span style={{ marginLeft: 6, color: "#b45309", fontWeight: 600 }}>Non-UK</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="detail-two-column">
        <CompetitorPanel
          competitors={company.competitors}
          companyId={companyId}
          onUpdated={refreshCompany}
          analysisStatus={analysisStatus}
          competitorContext={competitorContext}
          competitorContextMotion={competitorContextMotion}
        />
        <StakeholderPanel
          stakeholders={stakeholders}
          stakeholderAssessment={company.stakeholder_assessment}
          companyId={companyId}
          onUpdated={refreshCompany}
          analysisStatus={analysisStatus}
        />
      </div>

      <StakeholderAlertsPanel
        companyId={companyId}
        initialAlerts={company.stakeholder_alerts}
      />

      <MerchantSpendPanel merchantSpend={company.merchant_spend} />

      <CompanyAnalysis
        companyNumber={company.company_number || companyId.replace("ch-", "")}
        initialAnalysis={company.analysis}
      />

      <EvidencePanel
        companyId={companyId}
        initialAnalysis={company.analysis}
        motions={allMotionScores}
        statusSignals={company.reputation_signals || null}
      />

      <EnrichmentSignalsPanel
        companyId={companyId}
        companyNumber={company.company_number}
      />

      <GeminiYammPanel
        companyId={companyId}
        companyNumber={company.company_number}
      />

      <EmailSequencePanel
        companyId={companyId}
        companyName={company.name}
        stakeholders={stakeholders}
        keyPeople={keyPeople}
        motions={allMotionScores}
      />

      <NotesPanel companyId={companyId} initialNotes={company.notes} />

      <CadenceLog cadenceHistory={cadenceHistory} companyId={companyId} onEntryAdded={refreshCompany} />

      <WorkflowPanel
        companyId={companyId}
        currentState={company.workflow_state || "new_candidate"}
        history={workflowHistory}
        transitions={transitions}
        onStateChange={handleStateChange}
      />
    </div>
  );
}

CompanyDetail.propTypes = {
  companyId: PropTypes.string.isRequired,
};
