import React, { useEffect, useState } from "react";
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
import { DetailSkeleton } from "../components/LoadingSkeleton";

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
  const [transitions, setTransitions] = useState({});

  useEffect(() => {
    fetch("/api/workflow-states")
      .then((res) => res.json())
      .then((data) => setTransitions(data.transitions || {}))
      .catch(() => {});
  }, []);

  function loadCompanyDetail(background = false) {
    if (!companyId) return;

    if (!background) {
      setLoading(true);
      setError(null);
      setCompany(null);
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
        setCompany(data.company);
        if (!background) setLoading(false);
      })
      .catch((err) => {
        if (!background) {
          setError(err.message);
          setLoading(false);
        }
      });
  }

  useEffect(() => {
    loadCompanyDetail(false);
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return undefined;
    const timer = setInterval(() => loadCompanyDetail(true), 20000);
    return () => clearInterval(timer);
  }, [companyId]);

  function handleStateChange(data) {
    setCompany((prev) => prev ? {
      ...prev,
      workflow_state: data.new_state,
      workflow_history: data.history,
    } : prev);
  }

  function refreshCompany() {
    loadCompanyDetail(true);
  }

  if (!companyId) return <div>Missing company ID.</div>;
  if (loading) return <DetailSkeleton />;
  if (error) return <div style={{ color: "#c0392b" }}>{error}</div>;
  if (!company) return null;

  const analysisStatus = company.analysis_status || (company.analysis ? "ready" : "none");
  const analysisStatusLabel = analysisStatus === "queued"
    ? "In progress"
    : analysisStatus === "failed"
      ? "Needs retry"
      : analysisStatus === "ready"
        ? "Ready"
        : "Pending";
  const competitorContextMotionData = selectCompetitorContextMotion(company.all_motion_scores || []);
  const competitorContext = competitorContextMotionData?.score_breakdown?.competitor_context || null;
  const competitorContextMotion = competitorContextMotionData?.motion || null;
  const propensityScore = toFiniteNumber(company.propensity?.score);
  const propensityColor = propensityScore !== null
    ? propensityScore >= 0.7 ? "#0a8754" : propensityScore >= 0.5 ? "#c27b00" : "#6b7280"
    : "#6b7280";
  const propensityDeltaLabel = formatBpsDelta(company.combined_score, company.base_score);

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 8, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{company.name}</h2>
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
          <span style={{ fontWeight: 600 }}>{company.all_motion_scores?.length || 0}</span>
          <span style={{ color: "#888", marginLeft: 8 }}>
            {company.all_motion_scores?.map((m) => m.motion).join(", ")}
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
        motionScores={company.all_motion_scores || []}
        combinedScore={company.combined_score}
      />

      {company.filings?.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Companies House Filings Read</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {company.filings.slice(0, 5).map((filing, idx) => (
              <div key={idx} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 10px", background: "#f8f9fb", borderRadius: 6, fontSize: 13 }}>
                <span>{filing.description || "Accounts filing"} {filing.balance_sheet_date ? `(${filing.balance_sheet_date})` : ""}</span>
                <span style={{ color: filing.has_content ? "#0a8754" : "#888", fontWeight: 600 }}>
                  {filing.has_content ? "Text extracted" : "Metadata only"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
          stakeholders={company.stakeholders}
          stakeholderAssessment={company.stakeholder_assessment}
          companyId={companyId}
          onUpdated={refreshCompany}
          analysisStatus={analysisStatus}
        />
      </div>

      <MerchantSpendPanel merchantSpend={company.merchant_spend} />

      <CompanyAnalysis
        companyNumber={company.company_number || companyId.replace("ch-", "")}
        initialAnalysis={company.analysis}
      />

      <EvidencePanel
        companyId={companyId}
        initialAnalysis={company.analysis}
        motions={company.all_motion_scores || []}
        statusSignals={company.reputation_signals || null}
      />

      <EmailSequencePanel
        companyId={companyId}
        companyName={company.name}
        stakeholders={company.stakeholders || []}
        keyPeople={company.analysis?.key_people || []}
        motions={company.all_motion_scores || []}
      />

      <NotesPanel companyId={companyId} initialNotes={company.notes} />

      <CadenceLog cadenceHistory={company.cadence_history} companyId={companyId} onEntryAdded={refreshCompany} />

      <WorkflowPanel
        companyId={companyId}
        currentState={company.workflow_state || "new_candidate"}
        history={company.workflow_history || []}
        transitions={transitions}
        onStateChange={handleStateChange}
      />
    </div>
  );
}

CompanyDetail.propTypes = {
  companyId: PropTypes.string.isRequired,
};
