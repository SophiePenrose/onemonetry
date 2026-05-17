import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import MotionScoresPanel from "../components/MotionScoresPanel";
import WorkflowPanel from "../components/WorkflowPanel";
import CompetitorPanel from "../components/CompetitorPanel";
import StakeholderPanel from "../components/StakeholderPanel";
import CadenceLog from "../components/CadenceLog";

function formatTurnover(value) {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
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

  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    setCompany(null);
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
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [companyId]);

  function handleStateChange(data) {
    setCompany((prev) => prev ? {
      ...prev,
      workflow_state: data.new_state,
      workflow_history: data.history,
    } : prev);
  }

  if (!companyId) return <div>Missing company ID.</div>;
  if (loading) return <div style={{ color: "#888" }}>Loading…</div>;
  if (error) return <div style={{ color: "#c0392b" }}>{error}</div>;
  if (!company) return null;

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 8, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{company.name}</h2>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 1 }}>Combined Score</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0075EB" }}>{company.combined_score?.toFixed(2)}</div>
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
        <Field label="Eligible Motions">
          <span style={{ fontWeight: 600 }}>{company.all_motion_scores?.length || 0}</span>
          <span style={{ color: "#888", marginLeft: 8 }}>
            {company.all_motion_scores?.map((m) => m.motion).join(", ")}
          </span>
        </Field>
      </div>

      <MotionScoresPanel
        motionScores={company.all_motion_scores || []}
        combinedScore={company.combined_score}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
        <CompetitorPanel competitors={company.competitors} />
        <StakeholderPanel stakeholders={company.stakeholders} />
      </div>

      <CadenceLog cadenceHistory={company.cadence_history} />

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
