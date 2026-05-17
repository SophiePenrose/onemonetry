import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import ShortlistTable from "../components/ShortlistTable";
import CompanyDetail from "./CompanyDetail";

export default function Shortlist({ productMotion }) {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelectedCompanyId(null);
    fetch(`/api/shortlist?product_motion=${encodeURIComponent(productMotion)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch shortlist");
        return res.json();
      })
      .then((data) => {
        setCompanies(data.companies || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [productMotion]);

  if (selectedCompanyId) {
    return (
      <div>
        <button
          onClick={() => setSelectedCompanyId(null)}
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
          ← Back to Shortlist
        </button>
        <CompanyDetail companyId={selectedCompanyId} productMotion={productMotion} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Shortlist — {productMotion}</h2>
        {!loading && !error && (
          <span style={{ color: "#888", fontSize: 14 }}>{companies.length} {companies.length === 1 ? "company" : "companies"}</span>
        )}
      </div>
      {loading && <div style={{ color: "#888" }}>Loading…</div>}
      {error && <div style={{ color: "#c0392b" }}>Error: {error}</div>}
      {!loading && !error && (
        <ShortlistTable
          companies={companies}
          onSelectCompany={(company) => setSelectedCompanyId(company.id)}
        />
      )}
    </div>
  );
}

Shortlist.propTypes = {
  productMotion: PropTypes.string.isRequired,
};
