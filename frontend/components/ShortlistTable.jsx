const styles = {
  wrapper: {
    overflowX: "auto",
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  headCell: {
    borderBottom: "1px solid #e2e8f0",
    color: "#475569",
    fontSize: "0.8rem",
    fontWeight: 700,
    padding: "0.8rem",
    textAlign: "left",
    textTransform: "uppercase",
  },
  cell: {
    borderBottom: "1px solid #f1f5f9",
    padding: "0.9rem 0.8rem",
    verticalAlign: "top",
  },
  button: {
    background: "none",
    border: 0,
    color: "#2563eb",
    cursor: "pointer",
    font: "inherit",
    fontWeight: 700,
    padding: 0,
    textAlign: "left",
  },
  score: {
    fontWeight: 700,
  },
  empty: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
    color: "#475569",
    padding: "1rem",
  },
};

export default function ShortlistTable({ companies = [], onSelectCompany }) {
  if (!companies.length) {
    return <div style={styles.empty}>No companies match this product motion.</div>;
  }

  return (
    <div style={styles.wrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.headCell}>Rank</th>
            <th style={styles.headCell}>Company</th>
            <th style={styles.headCell}>Score</th>
            <th style={styles.headCell}>Best motion</th>
            <th style={styles.headCell}>Why now</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => (
            <tr key={company.id}>
              <td style={styles.cell}>{company.rank}</td>
              <td style={styles.cell}>
                <button
                  type="button"
                  style={styles.button}
                  onClick={() => onSelectCompany(company)}
                >
                  {company.name}
                </button>
                <div>{company.industry}</div>
              </td>
              <td style={{ ...styles.cell, ...styles.score }}>{company.score}</td>
              <td style={styles.cell}>{company.productMotion}</td>
              <td style={styles.cell}>{company.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
