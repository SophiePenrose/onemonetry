const styles = {
  card: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
    padding: "1rem",
  },
  title: {
    marginTop: 0,
  },
  grid: {
    display: "grid",
    gap: "0.75rem",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  },
  metric: {
    background: "#f8fafc",
    borderRadius: "0.5rem",
    padding: "0.75rem",
  },
  label: {
    color: "#64748b",
    fontSize: "0.8rem",
    fontWeight: 700,
    textTransform: "uppercase",
  },
  value: {
    fontSize: "1.4rem",
    fontWeight: 800,
  },
};

export default function ScoreExplanation({ company }) {
  const breakdown = company.scoreBreakdown ?? {};
  const evidence = company.evidence ?? [];

  return (
    <section style={styles.card}>
      <h2 style={styles.title}>Score explanation</h2>
      <div style={styles.grid}>
        <div style={styles.metric}>
          <div style={styles.label}>Final score</div>
          <div style={styles.value}>{company.score}</div>
        </div>
        <div style={styles.metric}>
          <div style={styles.label}>Product fit</div>
          <div style={styles.value}>{breakdown.productFit ?? 0}</div>
        </div>
        <div style={styles.metric}>
          <div style={styles.label}>Commercial value</div>
          <div style={styles.value}>{breakdown.commercialValue ?? 0}</div>
        </div>
        <div style={styles.metric}>
          <div style={styles.label}>Timing</div>
          <div style={styles.value}>{breakdown.timing ?? 0}</div>
        </div>
      </div>

      <p>{company.explanation}</p>

      {evidence.length > 0 && (
        <>
          <h3>Evidence</h3>
          <ul>
            {evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
