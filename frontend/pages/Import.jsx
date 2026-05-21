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

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "calculating...";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function Import() {
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [jobDetail, setJobDetail] = useState(null);
  const [chStatus, setCHStatus] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [monthlyFiles, setMonthlyFiles] = useState([]);
  const [dailyFiles, setDailyFiles] = useState([]);
  const [bulkFilesError, setBulkFilesError] = useState(false);
  const [autoPull, setAutoPull] = useState(null);
  const [bulkBackfill, setBulkBackfill] = useState(null);
  const [bulkTab, setBulkTab] = useState("monthly");
  const fileRef = useRef(null);

  useEffect(() => {
    fetch("/api/companies-house/status").then((r) => r.json()).then(setCHStatus).catch(() => {});
    refreshJobs();
    refreshBulkFiles();
    refreshAutoPull();
    refreshBulkBackfillStatus();

    const interval = setInterval(() => {
      refreshJobs();
      refreshBulkBackfillStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  function refreshJobs() {
    fetch("/api/import/jobs").then((r) => r.json()).then((d) => setJobs(d.jobs || [])).catch(() => {});
  }

  function refreshBulkFiles() {
    Promise.all([
      fetch("/api/import/bulk/monthly").then((r) => r.json()),
      fetch("/api/import/bulk/daily").then((r) => r.json()),
    ])
      .then(([monthly, daily]) => {
        setMonthlyFiles(monthly.files || []);
        setDailyFiles(daily.files || []);
        setBulkFilesError(false);
      })
      .catch(() => {
        setMonthlyFiles([]);
        setDailyFiles([]);
        setBulkFilesError(true);
      });
  }

  function refreshAutoPull() {
    fetch("/api/import/autopull/status").then((r) => r.json()).then(setAutoPull).catch(() => {});
  }

  function refreshBulkBackfillStatus() {
    fetch("/api/import/bulk/process-remaining/status").then((r) => r.json()).then(setBulkBackfill).catch(() => {});
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

  async function handleProcessZip(url, filename) {
    try {
      const res = await fetch("/api/import/bulk/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, filename }),
      });
      const data = await res.json();
      if (data.job_id) {
        setTimeout(refreshJobs, 2000);
        setTimeout(() => loadJobDetail(data.job_id), 3000);
      }
    } catch {
      alert("Failed to start processing");
    }
  }

  async function toggleAutoPull() {
    const endpoint = autoPull?.enabled ? "/api/import/autopull/stop" : "/api/import/autopull/start";
    try {
      await fetch(endpoint, { method: "POST" });
      refreshAutoPull();
    } catch {
      alert("Failed to toggle auto-pull");
    }
  }

  async function handleProcessAllRemaining() {
    try {
      const res = await fetch("/api/import/bulk/process-remaining", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          include_daily: true,
          include_monthly: true,
          include_monthly_archive: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start bulk backfill");
      setTimeout(refreshBulkBackfillStatus, 800);
      setTimeout(refreshJobs, 1000);
    } catch (err) {
      alert(err.message || "Failed to start bulk backfill");
    }
  }

  async function handleStopProcessAllRemaining() {
    try {
      await fetch("/api/import/bulk/process-remaining/stop", { method: "POST" });
      setTimeout(refreshBulkBackfillStatus, 600);
    } catch {
      alert("Failed to request stop");
    }
  }

  async function handleProcessNextHistoricBatch() {
    try {
      const res = await fetch("/api/import/bulk/process-next-historic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: 3, inter_file_delay_ms: 3000 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start historic batch");
      setTimeout(refreshBulkBackfillStatus, 800);
      setTimeout(refreshJobs, 1000);
    } catch (err) {
      alert(err.message || "Failed to start historic batch");
    }
  }

  async function handleProcessLast24Months() {
    try {
      const res = await fetch("/api/import/bulk/process-last-24-months", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inter_file_delay_ms: 2500 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start last-24-months processing");
      setTimeout(refreshBulkBackfillStatus, 800);
      setTimeout(refreshJobs, 1000);
    } catch (err) {
      alert(err.message || "Failed to start last-24-months processing");
    }
  }

  async function handleLookup() {
    const num = prompt("Enter a company number:");
    if (!num) return;
    try {
      const res = await fetch(`/api/companies-house/lookup/${num.trim()}`);
      const data = await res.json();
      if (data.error) alert(`Lookup failed: ${data.message || data.error}`);
      else alert(`Found: ${data.company.name} (${data.company.status})\nSource: ${data.company.source}`);
    } catch { alert("Lookup failed"); }
  }

  // --- Job Detail View ---
  if (selectedJob && jobDetail) {
    const { job, logs } = jobDetail;
    const pct = job.total_items > 0 ? Math.round((job.processed_items / job.total_items) * 100) : 0;
    return (
      <div>
        <button onClick={() => { setSelectedJob(null); setJobDetail(null); refreshJobs(); refreshBulkFiles(); }} style={{ padding: "8px 16px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 14, marginBottom: 16 }}>
          ← Back to Import Dashboard
        </button>
        <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{job.id}</h2>
            <StatusBadge status={job.status} />
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 13, color: "#666", marginBottom: 12 }}>
            <span>Type: <strong>{job.type.toUpperCase()}</strong></span>
            <span>Total: <strong>{job.total_items}</strong></span>
            <span>Processed: <strong>{job.processed_items}</strong></span>
          </div>
          {job.total_items > 0 && (
            <div style={{ background: "#f0f2f5", borderRadius: 4, height: 8, overflow: "hidden", marginBottom: 8 }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "#0075EB", borderRadius: 4 }} />
            </div>
          )}
          <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <span style={{ color: "#065f46" }}>Imported: <strong>{job.imported_items}</strong></span>
            <span style={{ color: "#92400e" }}>Skipped: <strong>{job.skipped_items}</strong></span>
            <span style={{ color: "#991b1b" }}>Errors: <strong>{job.error_count}</strong></span>
          </div>
        </div>
        {logs.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 8, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <h3 style={{ fontSize: 15, margin: "0 0 12px" }}>Import Log ({logs.length})</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "#f0f2f5", color: "#555" }}>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Company</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Number</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>Action</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Turnover</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Detail</th>
              </tr></thead>
              <tbody>
                {logs.map((log, idx) => {
                  const ac = ACTION_COLORS[log.action] || ACTION_COLORS.error;
                  return (
                    <tr key={idx} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "8px 12px", fontWeight: log.action === "imported" ? 600 : 400 }}>{log.company_name || "—"}</td>
                      <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 12 }}>{log.company_number || "—"}</td>
                      <td style={{ padding: "8px 12px", textAlign: "center" }}><Badge text={log.action} bg={ac.bg} color={ac.color} /></td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>{log.turnover ? `£${(log.turnover / 1e6).toFixed(1)}M` : "—"}</td>
                      <td style={{ padding: "8px 12px", color: "#888" }}>{log.detail || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // --- Main Dashboard ---
  const bulkFiles = bulkTab === "monthly" ? monthlyFiles : dailyFiles;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Data Import</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleLookup} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 13 }}>🔍 Lookup</button>
          <button onClick={() => { refreshJobs(); refreshBulkFiles(); refreshAutoPull(); }} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 13 }}>↻ Refresh</button>
        </div>
      </div>

      {/* CH Status */}
      {chStatus && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <strong>Companies House:</strong>
          <Badge text={chStatus.configured ? "Live" : "Mock Mode"} bg={chStatus.configured ? "#0a8754" : "#6b7280"} color="#fff" />
          <span style={{ color: "#888" }}>{chStatus.configured ? "Live API lookups enabled" : "Set COMPANIES_HOUSE_API_KEY for live data"}</span>
        </div>
      )}

      {/* Phase 1: CSV */}
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Phase 1: CSV Import</h3>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>Upload CSV with company numbers for £20M+ turnover entities.</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".csv" style={{ fontSize: 13 }} />
          <button onClick={handleCSVUpload} disabled={uploading} style={{ padding: "8px 20px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff", fontWeight: 600, fontSize: 13, cursor: uploading ? "wait" : "pointer", opacity: uploading ? 0.6 : 1 }}>
            {uploading ? "Uploading…" : "Import CSV"}
          </button>
        </div>
        {uploadResult && (
          <div style={{ marginTop: 12, padding: "8px 14px", borderRadius: 6, fontSize: 13, background: uploadResult.success ? "#d1fae5" : "#fee2e2", color: uploadResult.success ? "#065f46" : "#991b1b" }}>
            {uploadResult.success ? `Job ${uploadResult.job_id} — processing ${uploadResult.company_numbers_found} companies.` : `Error: ${uploadResult.error}`}
          </div>
        )}
      </div>

      {/* Phase 2: Bulk ZIP */}
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>Phase 2: Bulk Accounts Data</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={handleProcessAllRemaining}
              disabled={bulkBackfill?.running}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: bulkBackfill?.running ? "#9ca3af" : "#0a8754",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: bulkBackfill?.running ? "not-allowed" : "pointer",
              }}
            >
              Process All Remaining
            </button>
            <button
              onClick={handleProcessNextHistoricBatch}
              disabled={bulkBackfill?.running}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #0b4f8a",
                background: bulkBackfill?.running ? "#f3f4f6" : "#fff",
                color: bulkBackfill?.running ? "#9ca3af" : "#0b4f8a",
                fontSize: 12,
                fontWeight: 600,
                cursor: bulkBackfill?.running ? "not-allowed" : "pointer",
              }}
            >
              Process Next Historic Batch (3)
            </button>
            <button
              onClick={handleProcessLast24Months}
              disabled={bulkBackfill?.running}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #0a8754",
                background: bulkBackfill?.running ? "#f3f4f6" : "#fff",
                color: bulkBackfill?.running ? "#9ca3af" : "#0a8754",
                fontSize: 12,
                fontWeight: 600,
                cursor: bulkBackfill?.running ? "not-allowed" : "pointer",
              }}
            >
              Process Last 24 Months
            </button>
            {bulkBackfill?.running && (
              <button
                onClick={handleStopProcessAllRemaining}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #c0392b",
                  background: "#fff",
                  color: "#c0392b",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Stop Backfill
              </button>
            )}
            <span style={{ fontSize: 12, color: "#888" }}>Auto-pull:</span>
            <button onClick={toggleAutoPull} style={{
              padding: "4px 14px", borderRadius: 14, border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: autoPull?.enabled ? "#0a8754" : "#6b7280", color: "#fff",
            }}>
              {autoPull?.enabled ? "● Enabled" : "○ Disabled"}
            </button>
          </div>
        </div>

        {autoPull?.enabled && (
          <div style={{ fontSize: 12, color: "#0a8754", background: "#d1fae5", padding: "6px 12px", borderRadius: 6, marginBottom: 12 }}>
            Auto-pull active — checking for new daily files every 12 hours.
            {autoPull.next_run && <span> Next run: {new Date(autoPull.next_run).toLocaleString()}</span>}
          </div>
        )}

        {bulkBackfill?.running && (
          <div style={{ fontSize: 12, color: "#0b4f8a", background: "#e6f3ff", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
            Backfill running — processed {bulkBackfill.job?.processed_items || 0} / {bulkBackfill.job?.total_items || 0} ZIP files.
            {bulkBackfill.job?.metadata?.current_file && <span> Current: {bulkBackfill.job.metadata.current_file}</span>}
            <span> · ETA: {formatDuration(bulkBackfill.job?.metadata?.eta_seconds)}</span>
            <span> · Elapsed: {formatDuration(bulkBackfill.job?.metadata?.elapsed_seconds)}</span>
          </div>
        )}

        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
          Companies House publishes accounts as ZIP files. Monthly archives cover the last 24 months (historical backfill).
          Daily files (Tue-Sat) contain the latest filings. Only £20M+ turnover companies are imported.
        </p>

        <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
          {[{ id: "monthly", label: `Monthly (${monthlyFiles.length})` }, { id: "daily", label: `Daily (${dailyFiles.length})` }].map((t) => (
            <button key={t.id} onClick={() => setBulkTab(t.id)} style={{
              padding: "8px 16px", border: "1px solid #ddd", borderBottom: bulkTab === t.id ? "2px solid #0075EB" : "1px solid #ddd",
              background: bulkTab === t.id ? "#fff" : "#f8f9fb", color: bulkTab === t.id ? "#0075EB" : "#555",
              fontWeight: bulkTab === t.id ? 600 : 400, fontSize: 13, cursor: "pointer",
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {bulkFilesError && (
          <div style={{ fontSize: 12, color: "#991b1b", background: "#fee2e2", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
            Could not load bulk ZIP data. Backend may be offline.
          </div>
        )}

        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "#f0f2f5", color: "#555" }}>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>File</th>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>{bulkTab === "monthly" ? "Period" : "Date"}</th>
              <th style={{ padding: "6px 12px", textAlign: "center" }}>Status</th>
              <th style={{ padding: "6px 12px", textAlign: "right" }}>Action</th>
            </tr></thead>
            <tbody>
              {!bulkFilesError && bulkFiles.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: "16px 12px", textAlign: "center", color: "#888" }}>
                    No {bulkTab} data available yet.
                  </td>
                </tr>
              )}
              {bulkFiles.map((f) => (
                <tr key={f.filename} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "6px 12px", fontFamily: "monospace", fontSize: 11 }}>{f.filename}</td>
                  <td style={{ padding: "6px 12px" }}>{f.period || f.date} {f.day_name ? `(${f.day_name})` : ""}</td>
                  <td style={{ padding: "6px 12px", textAlign: "center" }}>
                    {f.processed
                      ? <Badge text="Processed" bg="#d1fae5" color="#065f46" />
                      : <Badge text="Pending" bg="#f3f4f6" color="#6b7280" />}
                  </td>
                  <td style={{ padding: "6px 12px", textAlign: "right" }}>
                    {!f.processed && (
                      <button onClick={() => handleProcessZip(f.url, f.filename)} style={{
                        padding: "4px 12px", borderRadius: 4, border: "1px solid #0075EB", background: "#fff",
                        color: "#0075EB", fontSize: 12, cursor: "pointer", fontWeight: 500,
                      }}>
                        Process
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Import Jobs */}
      <div>
        <h3 style={{ fontSize: 16, margin: "0 0 12px" }}>Import Jobs</h3>
        {jobs.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 8, padding: 24, textAlign: "center", color: "#888", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            No import jobs yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {jobs.map((job) => {
              const pct = job.total_items > 0 ? Math.round((job.processed_items / job.total_items) * 100) : 0;
              return (
                <div key={job.id} onClick={() => loadJobDetail(job.id)} style={{
                  background: "#fff", borderRadius: 8, padding: 14, cursor: "pointer",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.12)")}
                onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)")}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{job.id}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>{job.type.toUpperCase()} · {job.total_items > 0 ? `${pct}%` : "—"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 12, color: "#065f46" }}>{job.imported_items} imported</span>
                    <StatusBadge status={job.status} />
                    <span style={{ color: "#ccc" }}>›</span>
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
