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
    setSelectedCompanyId(null); // Clear selection when motion changes
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

  return (
    <div>
      <h1>Shortlist</h1>
      {loading && <div>Loading...</div>}
      {error && <div style={{ color: "red" }}>Error: {error}</div>}
      {!loading && !error && companies.length === 0 && <div>No companies found.</div>}
      {!loading && !error && companies.length > 0 && !selectedCompanyId && (
        <ShortlistTable
          companies={companies}
          onSelectCompany={(company) => setSelectedCompanyId(company.id)}
        />
      )}
      {selectedCompanyId && (
        <div style={{ marginTop: 24 }}>
          <button onClick={() => setSelectedCompanyId(null)}>
            &larr; Back to Shortlist
          </button>
          <CompanyDetail
            companyId={selectedCompanyId}
            productMotion={productMotion}
          />
        </div>
      )}
    </div>
  );
}

Shortlist.propTypes = {
  productMotion: PropTypes.string.isRequired,
};
