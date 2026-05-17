import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ShortlistTable from "../components/ShortlistTable.jsx";

const PRODUCT_MOTIONS = [
  "FX",
  "Cards",
  "Spend Management",
  "Merchant Acquiring",
];

const styles = {
  header: {
    display: "flex",
    flexWrap: "wrap",
    gap: "1rem",
    justifyContent: "space-between",
    marginBottom: "1.5rem",
  },
  eyebrow: {
    color: "#64748b",
    fontSize: "0.85rem",
    fontWeight: 700,
    letterSpacing: "0.04em",
    margin: 0,
    textTransform: "uppercase",
  },
  title: {
    margin: "0.25rem 0",
  },
  select: {
    border: "1px solid #cbd5e1",
    borderRadius: "0.5rem",
    padding: "0.6rem",
  },
  state: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
    padding: "1rem",
  },
  error: {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: "0.75rem",
    color: "#991b1b",
    padding: "1rem",
  },
};

export default function Shortlist() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedMotion = searchParams.get("product_motion");
  const initialMotion = PRODUCT_MOTIONS.includes(requestedMotion)
    ? requestedMotion
    : PRODUCT_MOTIONS[0];
  const [productMotion, setProductMotion] = useState(initialMotion);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadShortlist() {
      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({ product_motion: productMotion });
        const response = await fetch(`/api/shortlist?${params}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Shortlist request failed with ${response.status}`);
        }

        const data = await response.json();
        setCompanies(data.companies ?? []);
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

    loadShortlist();

    return () => controller.abort();
  }, [productMotion]);

  const handleSelectCompany = (company) => {
    const params = new URLSearchParams({ product_motion: productMotion });
    navigate(`/companies/${company.id}?${params}`);
  };

  const handleProductMotionChange = (event) => {
    const nextMotion = event.target.value;
    setProductMotion(nextMotion);
    setSearchParams({ product_motion: nextMotion });
  };

  return (
    <>
      <section style={styles.header}>
        <div>
          <p style={styles.eyebrow}>Weekly workspace</p>
          <h1 style={styles.title}>Prospecting shortlist</h1>
          <p>
            Ranked companies that clear the product-fit gate for the selected
            motion.
          </p>
        </div>
        <label>
          Product motion{" "}
          <select
            style={styles.select}
            value={productMotion}
            onChange={handleProductMotionChange}
          >
            {PRODUCT_MOTIONS.map((motion) => (
              <option key={motion} value={motion}>
                {motion}
              </option>
            ))}
          </select>
        </label>
      </section>

      {loading && <div style={styles.state}>Loading shortlist...</div>}
      {!loading && error && <div style={styles.error}>{error}</div>}
      {!loading && !error && (
        <ShortlistTable
          companies={companies}
          onSelectCompany={handleSelectCompany}
        />
      )}
    </>
  );
}
