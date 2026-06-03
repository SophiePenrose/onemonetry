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
    <div className="company-detail-field">
      <span className="company-detail-field-label">{label}</span>
      <span className="company-detail-field-value">{children}</span>
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
  const segmentClass = company.segment === "Enterprise"
    ? "segment-pill-enterprise"
    : company.segment === "Mid-Market"
      ? "segment-pill-midmarket"
      : "segment-pill-smb";
  const analysisTone = analysisStatus === "ready"
    ? { color: "#0a8754", background: "#d1fae5" }
    : analysisStatus === "failed"
      ? { color: "#7f1d1d", background: "#fee2e2" }
      : { color: "#92400e", background: "#fef3c7" };

  return (
    <div className="company-detail-page">
      <div className="company-detail-card">
        <div className="company-detail-header">
          <h2 className="company-detail-title">{company.name}</h2>
          <div className="company-detail-score-block">
            <div className="company-detail-score-label">Combined Score</div>
            <div className="company-detail-score-value">{formatScore(company.combined_score)}</div>
          </div>
        </div>

        <Field label="Company Number">
          <a
            href={`https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`}
            target="_blank"
            rel="noopener noreferrer"
            className="company-detail-link"
          >
            {company.company_number}
          </a>
        </Field>
        <Field label="Industry">{company.industry}</Field>
        <Field label="Turnover">{formatTurnover(company.turnover)}</Field>
        <Field label="Employees">{company.employee_count?.toLocaleString()}</Field>
        <Field label="Annual Report">
          <a href={company.latest_annual_report_url} target="_blank" rel="noopener noreferrer" className="company-detail-link">View report</a>
        </Field>
        <Field label="Segment">
          <span className={`segment-pill ${segmentClass}`}>
            {company.segment}
          </span>
        </Field>
        <Field label="Eligible Motions">
          <span className="company-detail-inline-strong">{company.all_motion_scores?.length || 0}</span>
          <span className="company-detail-inline-muted">
            {company.all_motion_scores?.map((m) => m.motion).join(", ")}
          </span>
        </Field>
        <Field label="Analysis Status">
          <span className="company-detail-status-pill" style={analysisTone}>
            {analysisStatusLabel}
          </span>
        </Field>
        {company.stakeholder_priority && (
          <Field label="Stakeholder Priority">
            <span className="company-detail-inline-strong">+{Math.round(company.stakeholder_priority.boost * 100)} pts</span>
            <span className="company-detail-inline-muted">
              {company.stakeholder_priority.readiness?.reason}
            </span>
          </Field>
        )}
      </div>

      {company.propensity && (
        <div className="company-detail-subcard">
          <div className="company-detail-subcard-header">
            <h3 className="company-detail-subcard-title">Response Propensity</h3>
            <div className="company-detail-propensity-summary">
              <span className="company-detail-propensity-emoji">
                {company.propensity.warmth === "hot" ? "🔥" : company.propensity.warmth === "warm" ? "☀️" : company.propensity.warmth === "cool" ? "🌤" : "❄️"}
              </span>
              <div className="company-detail-propensity-values">
                <div className="company-detail-propensity-score" style={{ color: propensityColor }}>
                  {formatPercent(company.propensity.score)}
                </div>
                <div className="company-detail-propensity-warmth">{company.propensity.warmth}</div>
              </div>
            </div>
          </div>
          <div className="company-detail-propensity-meta">
            Base score: {formatScore(company.base_score)} · Propensity adjustment: {propensityDeltaLabel} → Final: {formatScore(company.combined_score)}
          </div>
          {company.propensity.signals?.length > 0 && (
            <div>
              <div className="company-detail-signals-title">Signals</div>
              <ul className="company-detail-signals-list">
                {company.propensity.signals.map((s, idx) => (
                  <li key={idx}>{s}</li>
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
        <div className="company-detail-subcard">
          <h3 className="company-detail-subcard-title company-detail-subcard-title-block">Companies House Filings Read</h3>
          <div className="company-detail-filings-list">
            {company.filings.slice(0, 5).map((filing, idx) => (
              <div key={idx} className="company-detail-filing-row">
                <span>{filing.description || "Accounts filing"} {filing.balance_sheet_date ? `(${filing.balance_sheet_date})` : ""}</span>
                <span className={filing.has_content ? "company-detail-filing-ready" : "company-detail-filing-muted"}>
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
