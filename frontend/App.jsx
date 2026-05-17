import { Link, Navigate, Route, Routes } from "react-router-dom";
import Shortlist from "./pages/Shortlist.jsx";
import CompanyDetail from "./pages/CompanyDetail.jsx";

const styles = {
  app: {
    minHeight: "100vh",
    background: "#f8fafc",
    color: "#0f172a",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  header: {
    background: "#ffffff",
    borderBottom: "1px solid #e2e8f0",
    padding: "1rem 2rem",
  },
  link: {
    color: "#0f172a",
    fontWeight: 700,
    textDecoration: "none",
  },
  main: {
    margin: "0 auto",
    maxWidth: "1100px",
    padding: "2rem",
  },
};

export default function App() {
  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <Link to="/shortlist" style={styles.link}>
          Revolut Prospecting MVP
        </Link>
      </header>
      <main style={styles.main}>
        <Routes>
          <Route path="/" element={<Navigate to="/shortlist" replace />} />
          <Route path="/shortlist" element={<Shortlist />} />
          <Route path="/companies/:companyId" element={<CompanyDetail />} />
        </Routes>
      </main>
    </div>
  );
}
