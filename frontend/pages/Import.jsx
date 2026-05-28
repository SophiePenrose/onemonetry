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

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(value) {
  const d = parseDate(value);
  if (!d) return "-";
  return d.toLocaleString();
}

function source3ReasonBucket(detail) {
  const text = String(detail || "").toLowerCase();
  if (text.includes("non-trading") || text.includes("dormant")) return "nonTrading";
  if (text.includes("holding") || text.includes("spv")) return "holdingSpv";
  if (text.includes("no recent filing") || text.includes("stale")) return "stale";
  if (text.includes("duplicate") || text.includes("already scored")) return "duplicate";
  return "other";
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
  const [autoPull, setAutoPull] = useState(null);
  const [backfillStatus, setBackfillStatus] = useState(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [bulkTab, setBulkTab] = useState("monthly");
  const [bulkSortDir, setBulkSortDir] = useState("desc");
  const [jobSortDir, setJobSortDir] = useState("desc");
  const [logSortDir, setLogSortDir] = useState("desc");
  const [dashboardStats, setDashboardStats] = useState(null);
  const [source3Breakdown, setSource3Breakdown] = useState(null);
  const [source3Loading, setSource3Loading] = useState(false);
  const [closedWonInput, setClosedWonInput] = useState("");
  const [closedWonBusy, setClosedWonBusy] = useState(false);
  const [closedWonResult, setClosedWonResult] = useState(null);
  const [closedWonRegistry, setClosedWonRegistry] = useState({ total: 0, rows: [] });
  const fileRef = useRef(null);
  const closedWonFileRef = useRef(null);

  useEffect(() => {
    fetch("/api/companies-house/status").then((r) => r.json()).then(setCHStatus).catch(() => {});
    refreshDashboardStats();
    refreshJobs();
    refreshBulkFiles();
    refreshAutoPull();
    refreshBackfillStatus();
    refreshClosedWonRegistry();
  }, []);

  useEffect(() => {
    refreshSource3Breakdown(jobs);
  }, [jobs]);

  function refreshJobs() {
    fetch("/api/import/jobs").then((r) => r.json()).then((d) => setJobs(d.jobs || [])).catch(() => {});
  }

  function refreshDashboardStats() {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setDashboardStats)
      .catch(() => setDashboardStats(null));
  }

  async function refreshSource3Breakdown(currentJobs = jobs) {
    const csvJobs = (currentJobs || []).filter((job) => String(job.type || "").toLowerCase() === "csv");
    if (csvJobs.length === 0) {
      setSource3Breakdown({
        csvJobCount: 0,
        totalItems: 0,
        processedItems: 0,
        importedItems: 0,
        skippedItems: 0,
        errorItems: 0,
        nonTrading: 0,
        holdingSpv: 0,
        stale: 0,
        duplicate: 0,
        otherSkipped: 0,
        latestJobId: null,
      });
      return;
    }

    const sorted = [...csvJobs].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    const latest = sorted[0];

    const aggregate = sorted.reduce((acc, job) => {
      acc.totalItems += Number(job.total_items || 0);
      acc.processedItems += Number(job.processed_items || 0);
      acc.importedItems += Number(job.imported_items || 0);
      acc.skippedItems += Number(job.skipped_items || 0);
      acc.errorItems += Number(job.error_count || 0);
      return acc;
    }, { totalItems: 0, processedItems: 0, importedItems: 0, skippedItems: 0, errorItems: 0 });

    setSource3Loading(true);
    try {
      const detailRes = await fetch(`/api/import/jobs/${latest.id}`);
      const detail = detailRes.ok ? await detailRes.json() : { logs: [] };
      const logs = Array.isArray(detail.logs) ? detail.logs : [];

      const breakdown = {
        nonTrading: 0,
        holdingSpv: 0,
        stale: 0,
        duplicate: 0,
        otherSkipped: 0,
      };

      logs.forEach((log) => {
        if (String(log.action || "") !== "skipped") return;
        const bucket = source3ReasonBucket(log.detail);
        breakdown[bucket] += 1;
      });

      setSource3Breakdown({
        csvJobCount: sorted.length,
        latestJobId: latest.id,
        latestStatus: latest.status,
        latestCreatedAt: latest.created_at,
        ...aggregate,
        ...breakdown,
      });
    } catch {
      setSource3Breakdown({
        csvJobCount: sorted.length,
        latestJobId: latest.id,
        latestStatus: latest.status,
        latestCreatedAt: latest.created_at,
        ...aggregate,
        nonTrading: 0,
        holdingSpv: 0,
        stale: 0,
        duplicate: 0,
        otherSkipped: aggregate.skippedItems,
      });
    } finally {
      setSource3Loading(false);
    }
  }

  function refreshBulkFiles() {
    fetch("/api/import/bulk/monthly").then((r) => r.json()).then((d) => setMonthlyFiles(d.files || [])).catch(() => {});
    fetch("/api/import/bulk/daily").then((r) => r.json()).then((d) => setDailyFiles(d.files || [])).catch(() => {});
  }

  function refreshAutoPull() {
    fetch("/api/import/autopull/status").then((r) => r.json()).then(setAutoPull).catch(() => {});
  }

  function refreshBackfillStatus() {
    fetch("/api/import/bulk/process-remaining/status")
      .then((r) => r.json())
      .then(setBackfillStatus)
      .catch(() => {});
  }

  function refreshClosedWonRegistry() {
    fetch("/api/closed-won/registry?limit=8")
      .then((r) => r.json())
      .then((data) => setClosedWonRegistry({ total: Number(data?.total || 0), rows: Array.isArray(data?.rows) ? data.rows : [] }))
      .catch(() => setClosedWonRegistry({ total: 0, rows: [] }));
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

  async function handleRunBackfill(mode = "all") {
    setBackfillBusy(true);
    try {
      const res = await fetch("/api/import/bulk/process-remaining", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start backfill");
      refreshBackfillStatus();
      setTimeout(refreshBackfillStatus, 3000);
      setTimeout(refreshJobs, 2000);
    } catch (err) {
      alert(err.message || "Failed to start backfill");
    } finally {
      setBackfillBusy(false);
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

  async function handleClosedWonImport() {
    if (closedWonBusy) return;
    setClosedWonBusy(true);
    setClosedWonResult(null);

    try {
      let csvContent = String(closedWonInput || "").trim();
      const file = closedWonFileRef.current?.files?.[0];

      if (!csvContent && file) {
        csvContent = String(await file.text()).trim();
      }

      if (!csvContent) {
        throw new Error("Paste CSV content or choose a CSV file first.");
      }

      const res = await fetch("/api/closed-won/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv_content: csvContent,
          source: "closed_won_ui_ingest",
          dry_run: false,
          mark_existing_closed_won: true,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Closed-won import failed.");

      setClosedWonResult({ success: true, ...data });
      setClosedWonInput("");
      if (closedWonFileRef.current) closedWonFileRef.current.value = "";

      refreshClosedWonRegistry();
      refreshDashboardStats();
      refreshJobs();
    } catch (err) {
      setClosedWonResult({ success: false, error: err?.message || "Closed-won import failed." });
    } finally {
      setClosedWonBusy(false);
    }
  }

  // --- Job Detail View ---
  if (selectedJob && jobDetail) {
    const { job, logs } = jobDetail;
    const pct = job.total_items > 0 ? Math.round((job.processed_items / job.total_items) * 100) : 0;
    const sortedLogs = [...logs].sort((a, b) => {
      const aTs = String(a.timestamp || "");
      const bTs = String(b.timestamp || "");
      return logSortDir === "asc" ? aTs.localeCompare(bTs) : bTs.localeCompare(aTs);
    });
    return (
      <div>
        <button onClick={() => { setSelectedJob(null); setJobDetail(null); refreshJobs(); refreshBulkFiles(); }} style={{ padding: "8px 16px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 14, marginBottom: 16 }}>
          ← Back to Data Pipeline
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>Import Log ({logs.length})</h3>
              <button
                onClick={() => setLogSortDir((prev) => (prev === "desc" ? "asc" : "desc"))}
                style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 12 }}
              >
                {logSortDir === "desc" ? "Newest first" : "Oldest first"}
              </button>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "#f0f2f5", color: "#555" }}>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Company</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Number</th>
                <th style={{ padding: "8px 12px", textAlign: "center" }}>Action</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Turnover</th>
                <th style={{ padding: "8px 12px", textAlign: "left" }}>Detail</th>
              </tr></thead>
              <tbody>
                {sortedLogs.map((log, idx) => {
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
  const sortedBulkFiles = [...bulkFiles].sort((a, b) => {
    const aKey = String(a.period || a.date || "");
    const bKey = String(b.period || b.date || "");
    return bulkSortDir === "asc" ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
  });
  const sortedJobs = [...jobs].sort((a, b) => {
    const aKey = String(a.created_at || "");
    const bKey = String(b.created_at || "");
    return jobSortDir === "asc" ? aKey.localeCompare(bKey) : bKey.localeCompare(aKey);
  });

  const processedMonthly = monthlyFiles.filter((f) => f.processed);
  const processedDaily = dailyFiles.filter((f) => f.processed);
  const latestMonthly = [...processedMonthly].sort((a, b) => String(b.period || "").localeCompare(String(a.period || "")))[0] || null;
  const latestDaily = [...processedDaily].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0] || null;

  const source3ProgressPct = source3Breakdown?.totalItems
    ? Math.round((source3Breakdown.processedItems / source3Breakdown.totalItems) * 100)
    : 0;
  const source3IsProcessing = source3Breakdown?.totalItems > 0 && source3Breakdown.processedItems < source3Breakdown.totalItems;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Data Pipeline</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleLookup} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 13 }}>🔍 Lookup</button>
          <button onClick={() => { refreshDashboardStats(); refreshJobs(); refreshBulkFiles(); refreshAutoPull(); refreshBackfillStatus(); refreshClosedWonRegistry(); }} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 13 }}>↻ Refresh</button>
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 8, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Overall Health</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, fontSize: 13 }}>
          <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
            <div style={{ color: "#64748b", fontSize: 12 }}>Total companies scored</div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "#0f172a" }}>{dashboardStats?.total_companies?.toLocaleString() || "-"}</div>
          </div>
          <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
            <div style={{ color: "#64748b", fontSize: 12 }}>Filings processed</div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "#0f172a" }}>{dashboardStats?.total_filings?.toLocaleString() || "-"}</div>
          </div>
          <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
            <div style={{ color: "#64748b", fontSize: 12 }}>Monitored companies</div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "#0f172a" }}>{dashboardStats?.total_monitored?.toLocaleString() || "-"}</div>
          </div>
          <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
            <div style={{ color: "#64748b", fontSize: 12 }}>Queue failed items</div>
            <div style={{ fontWeight: 700, fontSize: 20, color: "#0f172a" }}>{queueStatus?.counts?.failed?.toLocaleString() || 0}</div>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div style={{ background: "#fff", borderRadius: 8, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Source 1a: Monthly bulk</strong>
            <Badge text={processedMonthly.length > 0 ? "Complete" : "Pending"} bg={processedMonthly.length > 0 ? "#0a8754" : "#6b7280"} color="#fff" />
          </div>
          <div style={{ fontSize: 12, color: "#475569" }}>Files processed: {processedMonthly.length}/{monthlyFiles.length || 0}</div>
          <div style={{ fontSize: 12, color: "#475569" }}>Last processed: {latestMonthly?.period || "-"}</div>
          <div style={{ fontSize: 12, color: "#475569" }}>Qualifying companies: {backfillStatus?.total_qualifying_companies || 0}</div>
        </div>

        <div style={{ background: "#fff", borderRadius: 8, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Source 1b: Scheduled monthly</strong>
            <Badge text={autoPull?.enabled ? "Up to date" : "Check config"} bg={autoPull?.enabled ? "#0a8754" : "#d97706"} color="#fff" />
          </div>
          <div style={{ fontSize: 12, color: "#475569" }}>Latest monthly batch: {latestMonthly?.period || "-"}</div>
          <div style={{ fontSize: 12, color: "#475569" }}>Auto-pull: {autoPull?.enabled ? "enabled" : "disabled"}</div>
          <div style={{ fontSize: 12, color: "#475569" }}>Next run: {formatDateTime(autoPull?.next_run)}</div>
        </div>

        <div style={{ background: "#fff", borderRadius: 8, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Source 2: Twice-weekly</strong>
            <Badge text={processedDaily.length > 0 ? "Up to date" : "Pending"} bg={processedDaily.length > 0 ? "#0a8754" : "#d97706"} color="#fff" />
          </div>
          <div style={{ fontSize: 12, color: "#475569" }}>Daily files processed: {processedDaily.length}/{dailyFiles.length || 0}</div>
          <div style={{ fontSize: 12, color: "#475569" }}>Latest batch: {latestDaily?.date || "-"}</div>
          <div style={{ fontSize: 12, color: "#475569" }}>Next expected run: {formatDateTime(autoPull?.next_run)}</div>
        </div>

        <div style={{ background: "#fff", borderRadius: 8, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Source 3: Mid-market CSV</strong>
            <Badge text={source3IsProcessing ? `Processing ${source3ProgressPct}%` : "Idle"} bg={source3IsProcessing ? "#2563eb" : "#6b7280"} color="#fff" />
          </div>
          <div style={{ fontSize: 12, color: "#475569", marginBottom: 6 }}>
            Jobs: {source3Breakdown?.csvJobCount || 0} · Processed: {source3Breakdown?.processedItems || 0}/{source3Breakdown?.totalItems || 0}
          </div>
          <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>
            Imported: {source3Breakdown?.importedItems || 0} · Skipped: {source3Breakdown?.skippedItems || 0} · Errors: {source3Breakdown?.errorItems || 0}
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginBottom: 8 }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left" }}>
                <th style={{ padding: "2px 0" }}>Outcome</th>
                <th style={{ padding: "2px 0", textAlign: "right" }}>Count</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ padding: "2px 0" }}>Non-trading</td><td style={{ padding: "2px 0", textAlign: "right" }}>{source3Breakdown?.nonTrading || 0}</td></tr>
              <tr><td style={{ padding: "2px 0" }}>Holding/SPV</td><td style={{ padding: "2px 0", textAlign: "right" }}>{source3Breakdown?.holdingSpv || 0}</td></tr>
              <tr><td style={{ padding: "2px 0" }}>No recent filing</td><td style={{ padding: "2px 0", textAlign: "right" }}>{source3Breakdown?.stale || 0}</td></tr>
              <tr><td style={{ padding: "2px 0" }}>Duplicate</td><td style={{ padding: "2px 0", textAlign: "right" }}>{source3Breakdown?.duplicate || 0}</td></tr>
              <tr><td style={{ padding: "2px 0" }}>Other skipped</td><td style={{ padding: "2px 0", textAlign: "right" }}>{source3Breakdown?.otherSkipped || 0}</td></tr>
            </tbody>
          </table>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => handleRetryFailed()}
              disabled={queueBusy || (queueStatus?.counts?.failed || 0) === 0}
              style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 11, cursor: (queueBusy || (queueStatus?.counts?.failed || 0) === 0) ? "not-allowed" : "pointer" }}
            >
              Retry errors
            </button>
            <button
              onClick={() => source3Breakdown?.latestJobId && loadJobDetail(source3Breakdown.latestJobId)}
              disabled={!source3Breakdown?.latestJobId || source3Loading}
              style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 11, cursor: (!source3Breakdown?.latestJobId || source3Loading) ? "not-allowed" : "pointer" }}
            >
              View latest job
            </button>
          </div>
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Closed-Won Registry Suppression</h3>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
          Ingest your closed-won company list (name + Companies House registration number) to suppress them from analysis, shortlist, and outreach workflows.
        </p>

        <div style={{ fontSize: 12, color: "#475569", marginBottom: 10 }}>
          Registry size: <strong>{closedWonRegistry.total.toLocaleString()}</strong>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 10 }}>
          <textarea
            value={closedWonInput}
            onChange={(e) => setClosedWonInput(e.target.value)}
            placeholder={"Paste CSV rows here. Example:\ncompany_name,company_number\nAcme Ltd,01234567"}
            style={{ width: "100%", minHeight: 90, borderRadius: 6, border: "1px solid #d1d5db", padding: 10, fontSize: 12, fontFamily: "monospace", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input ref={closedWonFileRef} type="file" accept=".csv" style={{ fontSize: 13 }} />
            <button
              onClick={handleClosedWonImport}
              disabled={closedWonBusy}
              style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#0a8754", color: "#fff", fontWeight: 600, fontSize: 13, cursor: closedWonBusy ? "wait" : "pointer", opacity: closedWonBusy ? 0.65 : 1 }}
            >
              {closedWonBusy ? "Importing…" : "Import Closed-Won List"}
            </button>
          </div>
        </div>

        {closedWonResult && (
          <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 6, fontSize: 12, background: closedWonResult.success ? "#d1fae5" : "#fee2e2", color: closedWonResult.success ? "#065f46" : "#991b1b" }}>
            {closedWonResult.success
              ? `Stored ${closedWonResult.stored || 0} records, skipped ${closedWonResult.skipped_invalid || 0} invalid, marked ${closedWonResult.marked_closed_won_states || 0} existing companies as closed won.`
              : `Error: ${closedWonResult.error}`}
          </div>
        )}

        {closedWonRegistry.rows.length > 0 && (
          <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f8fafc", color: "#475569" }}>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>Company</th>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>Number</th>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {closedWonRegistry.rows.map((row, idx) => (
                  <tr key={`${row.company_number}-${idx}`} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "6px 8px" }}>{row.company_name || "—"}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{row.company_number}</td>
                    <td style={{ padding: "6px 8px", color: "#64748b" }}>{formatDateTime(row.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* CH Status */}
      {chStatus && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <strong>Companies House:</strong>
          <Badge text={chStatus.configured ? "Live" : "Mock Mode"} bg={chStatus.configured ? "#0a8754" : "#6b7280"} color="#fff" />
          <span style={{ color: "#888" }}>{chStatus.configured ? "Live API lookups enabled" : "Set COMPANIES_HOUSE_API_KEY for live data"}</span>
        </div>
      )}

      {/* Source 3 */}
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: "0 0 8px" }}>Source 3: Mid-Market CSV Lists</h3>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>Upload monthly CSV lists of company numbers for staged lookup, deduplication, and scoring.</p>
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

      {/* Sources 1a/1b/2 */}
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>Sources 1a/1b/2: Companies House Filings</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
          Monthly archives power historic backfill (Source 1a), monthly publication drops deliver fresh batches (Source 1b),
          and daily files keep twice-weekly recency flowing (Source 2).
        </p>

        <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 6, padding: 10, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: "#374151" }}>
              <strong>24-month backfill runner:</strong> {backfillStatus?.running ? "running" : "idle"}
              {backfillStatus?.running && (
                <span> · {backfillStatus.processed_files || 0}/{backfillStatus.total_files || 0} files · current: {backfillStatus.current_file || "-"}</span>
              )}
              {!backfillStatus?.running && backfillStatus?.pending && (
                <span> · pending monthly: {backfillStatus.pending.monthly_pending || 0}, daily: {backfillStatus.pending.daily_pending || 0}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => handleRunBackfill("monthly")} disabled={backfillBusy || backfillStatus?.running} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: (backfillBusy || backfillStatus?.running) ? "not-allowed" : "pointer", fontSize: 12 }}>
                Run Monthly 24m
              </button>
              <button onClick={() => handleRunBackfill("all")} disabled={backfillBusy || backfillStatus?.running} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff", cursor: (backfillBusy || backfillStatus?.running) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600 }}>
                Run Remaining All
              </button>
            </div>
          </div>
          {(backfillStatus?.processed_files || 0) > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#4b5563" }}>
              Files: {backfillStatus.processed_files || 0}/{backfillStatus.total_files || 0}
              {" · "}Qualifying: {backfillStatus.total_qualifying_companies || 0}
              {" · "}Records processed: {backfillStatus.total_records_processed || 0}
              {" · "}Parse errors: {backfillStatus.total_parse_errors || 0}
              {" · "}Retries: {backfillStatus.retry_attempts || 0}
            </div>
          )}
          {backfillStatus?.last_error && (
            <div style={{ marginTop: 6, fontSize: 12, color: "#b91c1c" }}>Last backfill error: {backfillStatus.last_error}</div>
          )}
        </div>

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
          <button
            onClick={() => setBulkSortDir((prev) => (prev === "desc" ? "asc" : "desc"))}
            style={{
              marginLeft: 8,
              padding: "8px 14px",
              border: "1px solid #ddd",
              borderRadius: 6,
              background: "#fff",
              color: "#555",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {bulkSortDir === "desc" ? "Newest first" : "Oldest first"}
          </button>
        </div>

        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "#f0f2f5", color: "#555" }}>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>File</th>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>{bulkTab === "monthly" ? "Period" : "Date"}</th>
              <th style={{ padding: "6px 12px", textAlign: "center" }}>Status</th>
              <th style={{ padding: "6px 12px", textAlign: "right" }}>Action</th>
            </tr></thead>
            <tbody>
              {sortedBulkFiles.map((f) => (
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>Import Jobs</h3>
          <button
            onClick={() => setJobSortDir((prev) => (prev === "desc" ? "asc" : "desc"))}
            style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 12 }}
          >
            {jobSortDir === "desc" ? "Newest first" : "Oldest first"}
          </button>
        </div>
        {jobs.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 8, padding: 24, textAlign: "center", color: "#888", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            No import jobs yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sortedJobs.map((job) => {
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
