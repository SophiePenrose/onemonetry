import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import ScoreExplanation from "../components/ScoreExplanation.jsx";

const styles = {
  back: {
    color: "#2563eb",
    display: "inline-block",
    marginBottom: "1rem",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
    marginBottom: "1rem",
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
  label: {
    color: "#64748b",
    fontSize: "0.8rem",
    fontWeight: 700,
    textTransform: "uppercase",
  },
  error: {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "0.75rem",
    color: "#991b1b",
    padding: "1rem",
  },
};

export default function CompanyDetail() {
  const { companyId } = useParams();
  const [searchParams] = useSearchParams();
  const productMotion = searchParams.get("product_motion") ?? "FX";
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadCompany() {
      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({ product_motion: productMotion });
        const response = await fetch(`/api/company/${companyId}?${params}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Company request failed with ${response.status}`);
        }

        const data = await response.json();
        setCompany(data.company);
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(err.message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    loadCompany();

    return () => controller.abort();
  }, [companyId, productMotion]);

  return (
    <>
      <Link to={`/shortlist?product_motion=${encodeURIComponent(productMotion)}`} style={styles.back}>
        Back to shortlist
      </Link>

      {loading && <div style={styles.card}>Loading company...</div>}
      {!loading && error && <div style={styles.error}>{error}</div>}
      {!loading && !error && company && (
        <>
          <section style={styles.card}>
            <p style={styles.label}>{productMotion}</p>
            <h1 style={styles.title}>{company.name}</h1>
            <div style={styles.grid}>
              <div>
                <div style={styles.label}>Company number</div>
                <a
                  href={`https://find-and-update.company-information.service.gov.uk/company/${company.companyNumber}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {company.companyNumber}
                </a>
              </div>
              <div>
                <div style={styles.label}>Industry</div>
                <div>{company.industry}</div>
              </div>
              <div>
                <div style={styles.label}>Turnover</div>
                <div>{company.turnover}</div>
              </div>
              <div>
                <div style={styles.label}>Employees</div>
                <div>{company.employeeCount}</div>
              </div>
              <div>
                <div style={styles.label}>Workflow status</div>
                <div>{company.workflowStatus}</div>
              </div>
            </div>
          </section>

          <ScoreExplanation company={company} />
        </>
      )}
    </>
  );
}
