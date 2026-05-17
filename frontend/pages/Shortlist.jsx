import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import ShortlistTable from "../components/ShortlistTable";
import CompanyDetail from "./CompanyDetail";

const STATE_META = {
  new_candidate: { label: "New", color: "#6c757d" },
  shortlisted: { label: "Shortlisted", color: "#0075EB" },
  selected_for_outreach: { label: "Outreach", color: "#6f42c1" },
  in_cadence: { label: "In Cadence", color: "#e67e22" },
  active_opportunity: { label: "Active Opp", color: "#20c997" },
  closed_won: { label: "Won", color: "#0a8754" },
  closed_lost: { label: "Lost", color: "#c0392b" },
  revisit_later: { label: "Revisit", color: "#95a5a6" },
  held_for_review: { label: "Held", color: "#f39c12" },
};

export default function Shortlist({ productMotion }) {
  const [companies, setCompanies] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);
  const [stateFilter, setStateFilter] = useState("all");
  const [showSuppressed, setShowSuppressed] = useState(false);

  function fetchShortlist(suppressedFlag) {
    setLoading(true);
    setError(null);
    const qs = `product_motion=${encodeURIComponent(productMotion)}${suppressedFlag ? "&show_suppressed=true" : ""}`;
    fetch(`/api/shortlist?${qs}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch shortlist");
        return res.json();
      })
      .then((data) => {
        setCompanies(data.companies || []);
        setMeta(data.meta || null);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }

  useEffect(() => {
    setSelectedCompanyId(null);
    setStateFilter("all");
    setShowSuppressed(false);
    fetchShortlist(false);
  }, [productMotion]);

  function toggleSuppressed() {
    const next = !showSuppressed;
    setShowSuppressed(next);
    fetchShortlist(next);
  }

  const stateCounts = {};
  companies.forEach((c) => {
    const s = c.workflow_state || "new_candidate";
    stateCounts[s] = (stateCounts[s] || 0) + 1;
  });

  const filtered = stateFilter === "all"
    ? companies
    : companies.filter((c) => (c.workflow_state || "new_candidate") === stateFilter);

  if (selectedCompanyId) {
    return (
      <div>
        <button
          onClick={() => {
            setSelectedCompanyId(null);
            fetchShortlist(showSuppressed);
          }}
          style={{
            padding: "8px 16px", border: "1px solid #ddd", borderRadius: 6,
            background: "#fff", cursor: "pointer", fontSize: 14, marginBottom: 16,
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
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Shortlist — {productMotion}</h2>
        {!loading && !error && (
          <span style={{ color: "#888", fontSize: 14 }}>
            {filtered.length} of {companies.length} {companies.length === 1 ? "company" : "companies"}
          </span>
        )}
      </div>

      {!loading && !error && meta && (meta.excluded > 0 || meta.suppressed > 0) && (
        <div style={{ fontSize: 12, color: "#888", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
          {meta.excluded > 0 && (
            <span style={{ background: "#fee2e2", color: "#991b1b", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.excluded} excluded
            </span>
          )}
          {meta.suppressed > 0 && (
            <span style={{ background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.suppressed} suppressed
            </span>
          )}
          <span style={{ color: "#aaa" }}>·</span>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={showSuppressed}
              onChange={toggleSuppressed}
              style={{ cursor: "pointer" }}
            />
            <span>Show suppressed</span>
          </label>
        </div>
      )}

      {!loading && !error && companies.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          <button
            onClick={() => setStateFilter("all")}
            style={{
              padding: "4px 14px", borderRadius: 14,
              border: stateFilter === "all" ? "2px solid #333" : "1px solid #ddd",
              background: stateFilter === "all" ? "#333" : "#fff",
              color: stateFilter === "all" ? "#fff" : "#555",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >
            All ({companies.length})
          </button>
          {Object.entries(STATE_META).map(([stateId, meta]) => {
            const count = stateCounts[stateId] || 0;
            if (count === 0) return null;
            const active = stateFilter === stateId;
            return (
              <button
                key={stateId}
                onClick={() => setStateFilter(stateId)}
                style={{
                  padding: "4px 14px", borderRadius: 14,
                  border: active ? `2px solid ${meta.color}` : "1px solid #ddd",
                  background: active ? meta.color : "#fff",
                  color: active ? "#fff" : meta.color,
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >
                {meta.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {loading && <div style={{ color: "#888" }}>Loading…</div>}
      {error && <div style={{ color: "#c0392b" }}>Error: {error}</div>}
      {!loading && !error && (
        <ShortlistTable
          companies={filtered}
          onSelectCompany={(company) => setSelectedCompanyId(company.id)}
        />
      )}
    </div>
  );
}

Shortlist.propTypes = {
  productMotion: PropTypes.string.isRequired,
};
