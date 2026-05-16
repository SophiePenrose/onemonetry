import React from 'react';

const styles = {
  wrapper: {
    width: '100%',
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  headCell: {
    padding: '0.75rem',
    borderBottom: '1px solid #d1d5db',
    textAlign: 'left',
    fontSize: '0.875rem',
    fontWeight: 600,
  },
  cell: {
    padding: '0.75rem',
    borderBottom: '1px solid #e5e7eb',
    verticalAlign: 'top',
    fontSize: '0.95rem',
  },
  rowButton: {
    padding: 0,
    border: 0,
    background: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    font: 'inherit',
    textAlign: 'left',
  },
  emptyState: {
    padding: '1rem',
    border: '1px solid #e5e7eb',
    borderRadius: '0.5rem',
    color: '#4b5563',
  },
};

export default function ShortlistTable({ companies = [], onSelectCompany }) {
  const hasCompanies = Array.isArray(companies) && companies.length > 0;
  const canSelect = typeof onSelectCompany === 'function';

  const handleSelect = (company) => {
    if (canSelect) {
      onSelectCompany(company);
    }
  };

  if (!hasCompanies) {
    return <div style={styles.emptyState}>No companies shortlisted yet.</div>;
  }

  return (
    <div style={styles.wrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.headCell}>Rank</th>
            <th style={styles.headCell}>Name</th>
            <th style={styles.headCell}>Score</th>
            <th style={styles.headCell}>Product Motion</th>
            <th style={styles.headCell}>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((company, index) => (
            <tr
              key={company.id ?? company.name ?? index}
              onClick={canSelect ? () => handleSelect(company) : undefined}
              style={canSelect ? { cursor: 'pointer' } : undefined}
            >
              <td style={styles.cell}>{company.rank ?? index + 1}</td>
              <td style={styles.cell}>
                {canSelect ? (
                  <button
                    type="button"
                    style={styles.rowButton}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSelect(company);
                    }}
                  >
                    {company.name}
                  </button>
                ) : (
                  company.name
                )}
              </td>
              <td style={styles.cell}>{company.score ?? '—'}</td>
              <td style={styles.cell}>
                {company.productMotion ?? company.product_motion ?? '—'}
              </td>
              <td style={styles.cell}>{company.explanation ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
