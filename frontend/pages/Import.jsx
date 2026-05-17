import React, { useEffect, useState, useRef } from "react";

const ACTION_COLORS = {
  imported: { bg: "#d1fae5", color: "#065f46" },
  skipped: { bg: "#fef3c7", color: "#92400e" },
  error: { bg: "#fee2e2", color: "#991b1b" },
};

function Badge({ text, bg, color }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 8,
      fontSize: 11, fontWeight: 600, color: color || "#fff", background: bg || "#888",
    }}>
      {text}
    </span>
  );
}

function StatusBadge({ status }) {
  const meta = {
    running: { bg: "#0075EB", label: "Running" },
    completed: { bg: "#0a8754", label: "Completed" },
    pending: { bg: "#6b7280", label: "Pending" },
    failed: { bg: "#c0392b", label: "Failed" },
  };
  const m = meta[status] || meta.pending;
  return <Badge text={m.label} bg={m.bg} color="#fff" />;
}

export default function Import() {
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [jobDetail, setJobDetail] = useState(null);
  const [chStatus, setCHStatus] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    fetch("/api/companies-house/status").then((r) => r.json()).then(setCHStatus).catch(() => {});
    refreshJobs();
  }, []);

  function refreshJobs() {
    fetch("/api/import/jobs").then((r) => r.json()).then((d) => setJobs(d.jobs || [])).catch(() => {});
  }

  function loadJobDetail(jobId) {
    setSelectedJob(jobId);
    fetch(`/api/import/jobs/${jobId}`).then((r) => r.json()).then(setJobDetail).catch(() => {});
  }

  async function handleCSVUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadResult(null);

    const text = await file.text();

    try {
      const res = await fetch("/api/import/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_content: text, filename: file.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setUploadResult({ success: true, ...data });
      fileRef.current.value = "";
      setTimeout(refreshJobs, 1000);
      setTimeout(() => loadJobDetail(data.job_id), 2000);
    } catch (err) {
      setUploadResult({ success: false, error: err.message });
    } finally {
      setUploading(false);
    }
  }

  async function handleLookup() {
    const num = prompt("Enter a company number:");
    if (!num) return;
    try {
      const res = await fetch(`/api/companies-house/lookup/${num.trim()}`);
      const data = await res.json();
      if (data.error) {
        alert(`Lookup failed: ${data.message || data.error}`);
      } else {
        alert(`Found: ${data.company.name} (${data.company.status})\nSource: ${data.company.source}`);
      }
    } catch {
      alert("Lookup failed");
    }
  }

  if (selectedJob && jobDetail) {
    const { job, logs } = jobDetail;
    const pct = job.total_items > 0 ? Math.round((job.processed_items / job.total_items) * 100) : 0;

    return (
      <div>
        <button
          onClick={() => { setSelectedJob(null); setJobDetail(null); refreshJobs(); }}
          style={{ padding: "8px 16px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 14, marginBottom: 16 }}
        >
          ← Back to Import Dashboard
        </button>

        <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Import Job: {job.id}</h2>
            <StatusBadge status={job.status} />
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 13, color: "#666", marginBottom: 12 }}>
            <span>Type: <strong>{job.type.toUpperCase()}</strong></span>
            <span>Total: <strong>{job.total_items}</strong></span>
            <span>Processed: <strong>{job.processed_items}</strong></span>
          </div>
          <div style={{ background: "#f0f2f5", borderRadius: 4, height: 8, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "#0075EB", borderRadius: 4, transition: "width 0.3s" }} />
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <span style={{ color: "#065f46" }}>Imported: <strong>{job.imported_items}</strong></span>
            <span style={{ color: "#92400e" }}>Skipped: <strong>{job.skipped_items}</strong></span>
            <span style={{ color: "#991b1b" }}>Errors: <strong>{job.error_count}</strong></span>
          </div>
        </div>

        <div style={{ background: "#fff", borderRadius: 8, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <h3 style={{ fontSize: 15, margin: "0 0 12px" }}>Import Log ({logs.length} entries)</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f0f2f5", color: "#555" }}>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Company</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Number</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>Action</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Turnover</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, idx) => {
                const ac = ACTION_COLORS[log.action] || ACTION_COLORS.error;
                return (
                  <tr key={idx} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "8px 12px", fontWeight: log.action === "imported" ? 600 : 400 }}>{log.company_name || "—"}</td>
                    <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 12 }}>{log.company_number}</td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <Badge text={log.action} bg={ac.bg} color={ac.color} />
                    </td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      {log.turnover ? `£${(log.turnover / 1e6).toFixed(1)}M` : "—"}
                    </td>
                    <td style={{ padding: "8px 12px", color: "#888" }}>{log.detail || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Data Import</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleLookup} style={{
            padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd",
            background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500,
          }}>
            🔍 Lookup Company
          </button>
          <button onClick={refreshJobs} style={{
            padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd",
            background: "#fff", cursor: "pointer", fontSize: 13,
          }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {chStatus && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <strong>Companies House API:</strong>
            <Badge
              text={chStatus.configured ? "Connected" : "Mock Mode"}
              bg={chStatus.configured ? "#0a8754" : "#6b7280"}
              color="#fff"
            />
          </div>
          <div style={{ color: "#888" }}>
            {chStatus.configured
              ? "Live lookups enabled. CSV imports will fetch real company data."
              : "Set COMPANIES_HOUSE_API_KEY to enable live lookups. Currently using mock data."}
          </div>
        </div>
      )}

      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Phase 1: CSV Import</h3>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
          Upload a CSV file containing company numbers for entities with £20M+ turnover.
          Each company will be looked up via Companies House and added to the universe.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".csv" style={{ fontSize: 13 }} />
          <button
            onClick={handleCSVUpload}
            disabled={uploading}
            style={{
              padding: "8px 20px", borderRadius: 6, border: "none",
              background: "#0075EB", color: "#fff", fontWeight: 600,
              fontSize: 13, cursor: uploading ? "wait" : "pointer",
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading ? "Uploading…" : "Import CSV"}
          </button>
        </div>
        {uploadResult && (
          <div style={{
            marginTop: 12, padding: "8px 14px", borderRadius: 6, fontSize: 13,
            background: uploadResult.success ? "#d1fae5" : "#fee2e2",
            color: uploadResult.success ? "#065f46" : "#991b1b",
          }}>
            {uploadResult.success
              ? `Job ${uploadResult.job_id} started — processing ${uploadResult.company_numbers_found} company numbers.`
              : `Error: ${uploadResult.error}`}
          </div>
        )}
      </div>

      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Phase 2: Bulk Accounts Data</h3>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
          Companies House publishes accounts data as ZIP files — monthly archives covering the last 12 months,
          and daily files (Tue-Sat) with the previous day&apos;s filings. Only accounts from £20M+ turnover companies
          are processed.
        </p>
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <a href="https://download.companieshouse.gov.uk/en_monthlyaccountsdata.html" target="_blank" rel="noopener noreferrer" style={{ color: "#0075EB" }}>
            Monthly archives →
          </a>
          <a href="https://download.companieshouse.gov.uk/en_accountsdata.html" target="_blank" rel="noopener noreferrer" style={{ color: "#0075EB" }}>
            Daily files →
          </a>
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Import Jobs</h3>
        {jobs.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 8, padding: 24, textAlign: "center", color: "#888", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            No import jobs yet. Upload a CSV to get started.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {jobs.map((job) => {
              const pct = job.total_items > 0 ? Math.round((job.processed_items / job.total_items) * 100) : 0;
              return (
                <div
                  key={job.id}
                  onClick={() => loadJobDetail(job.id)}
                  style={{
                    background: "#fff", borderRadius: 8, padding: 16, cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.12)")}
                  onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)")}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{job.id}</div>
                    <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                      {job.type.toUpperCase()} · {job.total_items} companies · {pct}% complete
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 13, textAlign: "right" }}>
                      <span style={{ color: "#065f46" }}>{job.imported_items} imported</span>
                      {job.skipped_items > 0 && <span style={{ color: "#92400e", marginLeft: 8 }}>{job.skipped_items} skipped</span>}
                    </div>
                    <StatusBadge status={job.status} />
                    <span style={{ color: "#ccc", fontSize: 20 }}>›</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
