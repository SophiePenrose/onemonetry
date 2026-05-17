import React from "react";
import PropTypes from "prop-types";

function ShortlistTable({ companies, onSelectCompany }) {
  if (!companies || companies.length === 0) {
    return <div>No companies to display.</div>;
  }

  const handleRowClick = (company) => {
    if (onSelectCompany) {
      onSelectCompany(company);
    }
  };

  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Name</th>
          <th>Score</th>
          <th>Product Motion</th>
          <th>Explanation</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((company) => (
          <tr
            key={company.id}
            style={{ cursor: onSelectCompany ? "pointer" : "default" }}
            onClick={() => handleRowClick(company)}
          >
            <td>{company.rank}</td>
            <td>
              {onSelectCompany ? (
                <a
                  href="#"
                  onClick={e => {
                    e.preventDefault();
                    handleRowClick(company);
                  }}
                >
                  {company.name}
                </a>
              ) : (
                company.name
              )}
            </td>
            <td>{company.score}</td>
            <td>{company.product_motion}</td>
            <td>{company.explanation}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

ShortlistTable.propTypes = {
  companies: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    rank: PropTypes.number.isRequired,
    name: PropTypes.string.isRequired,
    score: PropTypes.number.isRequired,
    product_motion: PropTypes.string.isRequired,
    explanation: PropTypes.string.isRequired,
  })).isRequired,
  onSelectCompany: PropTypes.func,
};

export default ShortlistTable;
