import React, { useEffect, useState } from "react";

// Stub import for ShortlistTable (do not implement yet)
// import ShortlistTable from "../components/ShortlistTable";
const ShortlistTable = () => <div>ShortlistTable component (stub)</div>;

const SUPPORTED_MOTIONS = ["FX", "Cards", "Spend Management"];

export default function Shortlist() {
  const [productMotion, setProductMotion] = useState("FX");
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
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
      <div>
        <label htmlFor="motion-select">Product Motion: </label>
        <select
          id="motion-select"
          value={productMotion}
          onChange={(e) => setProductMotion(e.target.value)}
        >
          {SUPPORTED_MOTIONS.map((motion) => (
            <option key={motion} value={motion}>
              {motion}
            </option>
          ))}
        </select>
      </div>
      {loading && <div>Loading...</div>}
      {error && <div style={{ color: "red" }}>Error: {error}</div>}
      {!loading && !error && companies.length === 0 && <div>No companies found.</div>}
      {!loading && !error && companies.length > 0 && (
        <ShortlistTable companies={companies} />
      )}
    </div>
  );
}
