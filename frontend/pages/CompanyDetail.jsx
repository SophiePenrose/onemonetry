import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import ScoreExplanation from "../components/ScoreExplanation";

export default function CompanyDetail({ companyId, productMotion }) {
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!companyId || !productMotion) return;
    setLoading(true);
    setError(null);
    setCompany(null);
    fetch(`/api/company/${encodeURIComponent(companyId)}?product_motion=${encodeURIComponent(productMotion)}`)
      .then(async (res) => {
        if (res.status === 403) {
          throw new Error("Company does not meet current shortlist criteria");
        }
        if (res.status === 404) {
          throw new Error("Company not found");
        }
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
  }, [companyId, productMotion]);

  if (!companyId || !productMotion) {
    return <div>Missing company or product motion.</div>;
  }
  if (loading) return <div>Loading...</div>;
  if (error) return <div style={{ color: "red" }}>{error}</div>;
  if (!company) return null;

  return (
    <div>
      <h1>Company Detail</h1>
      <div><strong>Name:</strong> {company.name}</div>
      <div><strong>Company Number:</strong> {company.company_number}</div>
      <div><strong>Industry:</strong> {company.industry}</div>
      <div><strong>Turnover:</strong> {company.turnover}</div>
      <div><strong>Employee Count:</strong> {company.employee_count}</div>
      <div><strong>Annual Report:</strong> <a href={company.latest_annual_report_url} target="_blank" rel="noopener noreferrer">View</a></div>
      <div><strong>Final Score:</strong> {company.final_score}</div>
      <div><strong>Score Breakdown:</strong> {JSON.stringify(company.score_breakdown)}</div>
      <div><strong>Explanation:</strong></div>
      <ScoreExplanation
        productFit={company.product_fit}
        scoreBreakdown={company.score_breakdown}
        finalScore={company.final_score}
        explanation={company.explanation}
      />
    </div>
  );
}

CompanyDetail.propTypes = {
  companyId: PropTypes.string.isRequired,
  productMotion: PropTypes.string.isRequired,
};
