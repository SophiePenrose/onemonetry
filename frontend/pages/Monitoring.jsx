import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";

const VIEWS = [{ id: "alerts", label: "Company changes" }, { id: "research", label: "Deal enquiries" }, { id: "companies", label: "Watchlist" }, { id: "closed_won", label: "Past customers & people" }];
const label = value => String(value || "Unknown").replaceAll("_", " ");
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("en-GB") : "Not recorded";
const money = value => value === null || value === undefined || value === "" ? "Turnover unverified" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", notation: "compact" }).format(value);
const number = row => row.company_number || row.selected_company_number;
const name = row => row.company_name || row.official_company_name || row.account_name || number(row) || "Identity to confirm";
const key = row => row.alert_id || row.enquiry_id || row.closed_won_id || number(row);
const signal = row => row.headline || ({ AP01: "Director appointed", AP02: "Corporate director appointed", TM01: "Director departed" }[row.filing_type]) || (row.filing_type?.startsWith("PSC") ? "Ownership / control change" : label(row.alert_type || row.kind || row.company_status));

export function safeEvidenceUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function errorMessage(error) {
  return ({ monitoring_not_configured: "The company-monitoring connection needs to be configured in this app. Your existing watchlist and alerts remain in Supabase.",
    review_conflict: "This alert changed since you opened it. Refresh and review the latest version before saving.",
    monitoring_review_requires_owner_session: "Sign in with the workspace owner session before saving a review.",
  })[error] || "The monitoring data could not be loaded or saved. Try again; no approval has been assumed.";
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "monitoring_request_failed");
  return body;
}

function Evidence({ row }) {
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const urls = [row.source_url, row.evidence_url, ...evidence.map(item => typeof item === "string" ? item : item.url || item.source_url)].filter(Boolean);
  return <section><h3>Evidence and uncertainty</h3>
    {row.officer_name && <p><strong>{row.officer_name}</strong> · {row.officer_role || "Role unverified"}<br />Effective {date(row.appointment_date || row.termination_date)}</p>}
    {(Array.isArray(row.reasons) ? row.reasons : []).map((reason, index) => <p key={index}>{typeof reason === "string" ? reason : reason.summary || reason.reason}</p>)}
    {row.rationale && <p>{row.rationale}</p>}{row.uncertainty && <p className="monitoring-caution">{row.uncertainty}</p>}
    {row.next_step && <p><strong>Suggested next check:</strong> {row.next_step}</p>}
    {[...new Set(urls)].map((url, index) => safeEvidenceUrl(url) && <a className="monitoring-source" key={url} href={safeEvidenceUrl(url)} target="_blank" rel="noopener noreferrer">Open source {index + 1} ↗</a>)}
    {number(row) && <a className="monitoring-source" href={`https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number(row))}`} target="_blank" rel="noopener noreferrer">Companies House record ↗</a>}
    <p className="monitoring-muted">A filing identifies a change. It does not establish product fit, a finance job title or involvement in a previous implementation.</p>
  </section>;
}
Evidence.propTypes = { row: PropTypes.object.isRequired };

export default function Monitoring({ onOpenCompany, initialSearch = "", compact = false }) {
  const [view, setView] = useState("alerts");
  const [search, setSearch] = useState(initialSearch);
  const [query, setQuery] = useState(initialSearch);
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [decision, setDecision] = useState("reviewing");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  useEffect(() => { setSearch(initialSearch); setQuery(initialSearch); setOffset(0); setSelected(null); }, [initialSearch]);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setOffset(0); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setData(null); setSelected(null);
    request(`/api/monitoring?${new URLSearchParams({ view, search: query, status, offset: String(offset) })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err.message)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [view, query, status, offset, revision]);

  function open(row) { setSelected(row); setDecision(["reviewing", "qualified", "dismissed"].includes(row.status) ? row.status : "reviewing"); setNote(""); setActionError(""); }
  async function save(event) {
    event.preventDefault(); setBusy(true); setActionError("");
    try {
      await request("/api/monitoring/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alert_id: selected.alert_id, status: decision, note, expected_updated_at: selected.updated_at }) });
      setSelected(null); setRevision(value => value + 1);
    } catch (err) { setActionError(errorMessage(err.message)); } finally { setBusy(false); }
  }
  async function research(row) {
    setBusy(true); setActionError("");
    try {
      if (row.workspace?.company_id) { onOpenCompany(row.workspace.company_id); return; }
      const result = await request(`/api/monitoring/companies/${encodeURIComponent(number(row))}/research`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      onOpenCompany(result.company_id);
    } catch (err) { setActionError(errorMessage(err.message)); } finally { setBusy(false); }
  }
  const summary = data?.summary;
  const filters = view === "closed_won" ? ["all", "watchlist", "outside", "review"] : ["all", "new", "reviewing", "qualified", "dismissed", "contacted"];
  return <section className={`monitoring-workspace${compact ? " monitoring-compact" : ""}`}>
    <div className="monitoring-heading"><div><h2>{compact ? "Company changes & monitoring" : "Signals & research"}</h2><p>{compact ? "Live filing evidence and review history for this company." : "Investigate changes, connect the evidence and decide which companies deserve research."}</p></div><button disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
    {!compact && <nav className="monitoring-tabs" aria-label="Monitoring sections">{VIEWS.map(item => <button key={item.id} aria-current={view === item.id ? "page" : undefined} disabled={busy} onClick={() => { setView(item.id); setStatus("all"); setOffset(0); }}>{item.label}</button>)}</nav>}
    {summary && !compact && <div className="monitoring-metrics">{(view === "closed_won" ? [["Past customer accounts", summary.accounts], ["Matched to watchlist", summary.watchlist], ["Identity needs review", summary.review], ["Implementation people", summary.applicants]] : [["Companies watched", summary.watchlist], ["Filing checks completed", summary.filings_checked], ["New alerts", summary.new_alerts], ["Signals qualified for research", summary.qualified]]).map(([title, value]) => <div key={title}><strong>{Number(value || 0).toLocaleString("en-GB")}</strong><span>{title}</span></div>)}</div>}
    <div className="monitoring-toolbar">{!compact && <label>Company name or number<input value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="Search monitored companies" disabled={busy} /></label>}
      {["alerts", "closed_won"].includes(view) && <label>Review status<select value={status} disabled={busy} onChange={event => { setStatus(event.target.value); setOffset(0); }}>{filters.map(item => <option key={item} value={item}>{label(item)}</option>)}</select></label>}
    </div>
    {error ? <p role="alert" className="monitoring-caution">{error}</p> : loading ? <p role="status">Loading monitoring evidence…</p> : <>
      <div className="monitoring-layout"><div className="monitoring-results">
        {!data?.rows.length ? <p className="monitoring-empty">No matching {view === "companies" ? "companies" : view === "research" ? "enquiries" : view === "closed_won" ? "customer records" : "alerts"}. Try another search or status.</p> : <div className="monitoring-table-wrap"><table className="data-table"><thead><tr><th>Company</th><th>{view === "closed_won" ? "Customer history" : "Evidence / status"}</th><th>Next step</th></tr></thead><tbody>{data.rows.map(row => <tr key={key(row)}><td><button className="monitoring-name" onClick={() => open(row)} disabled={busy}>{name(row)}</button><small>{number(row) || "Company number unverified"}</small></td><td>{view === "closed_won" ? label(row.match_group) : signal(row)}<small>{row.officer_name || row.ultimate_parent_name || ""}</small><small>{label(row.status || row.company_status)}{row.filing_date ? ` · Filed ${date(row.filing_date)}` : ""}</small></td><td><button onClick={() => open(row)} disabled={busy}>Review evidence</button><small>{row.workspace?.suppressed ? "Outreach restricted" : row.workspace?.turnover_scope === "below_floor" ? "Below £30m · research only" : row.workspace?.turnover_scope === "turnover_unknown" ? "Verify turnover" : "Check product fit & CRM"}</small></td></tr>)}</tbody></table></div>}
        {data?.total > 0 && <div className="monitoring-pagination"><span>{offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}</span><button disabled={offset === 0 || busy} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</button><button disabled={offset + 50 >= data.total || busy} onClick={() => setOffset(value => value + 50)}>Next</button></div>}
      </div>{selected && <aside className="monitoring-detail" aria-label="Selected evidence"><button className="monitoring-close" disabled={busy} onClick={() => setSelected(null)}>Close details</button><h3>{name(selected)}</h3><p>{money(selected.turnover_gbp)} · {label(selected.company_status || selected.official_company_status)}</p>
        <Evidence row={selected} />
        {selected.ultimate_parent_name && <p><strong>Parent:</strong> {selected.ultimate_parent_name} · {selected.ultimate_parent_country || "Country unverified"}</p>}
        {selected.applicants?.length > 0 && <section><h3>Previous implementation contacts</h3>{selected.applicants.map((person, index) => <p key={index}>{person.name} · {person.role || "Role unverified"}</p>)}<p className="monitoring-muted">These are historical contacts. Verify identity and current employment before treating a new appointment as a warm introduction.</p></section>}
        {selected.alert_id && <section><h3>Review history</h3>{selected.reviews?.length ? selected.reviews.map((review, index) => <p key={index}><strong>{label(review.new_status)}</strong> · {date(review.reviewed_at)}<br />{review.note}</p>) : <p>No reviews yet.</p>}
          {data.review_enabled ? <form onSubmit={save}><label>Decision<select value={decision} disabled={busy} onChange={event => setDecision(event.target.value)}><option value="reviewing">Under review</option><option value="qualified">Relevant signal — research next</option><option value="dismissed">Dismiss signal</option></select></label><label>Evidence and next step<textarea required maxLength={3000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></label><button disabled={busy || !note.trim()}>Save review</button></form> : <p className="monitoring-muted">Reviews are read-only until the owner session and reviewer identity are configured.</p>}
        </section>}
        {number(selected) && onOpenCompany && <section><h3>Continue in this workspace</h3><p>Keep the company’s scores, evidence, people and outreach history together. Research does not approve outreach.</p>{view === "closed_won" && !selected.in_watchlist && !selected.workspace?.company_id ? <p>Confirm the company match and add it to the watchlist before opening a research workspace.</p> : <button className="outreach-primary-button" disabled={busy} onClick={() => research(selected)}>{busy ? "Working…" : selected.workspace?.company_id ? "Open company workspace" : "Add to research workspace"}</button>}</section>}
        {actionError && <p role="alert" className="monitoring-caution">{actionError}</p>}
      </aside>}</div>
      <p className="monitoring-muted">{data?.refreshed_at ? `Checked ${new Date(data.refreshed_at).toLocaleString("en-GB")}. ` : ""}Monitoring is separate from outreach eligibility: £30m turnover, product fit, CRM clearance and channel approval still apply.</p>
    </>}
  </section>;
}
Monitoring.propTypes = { onOpenCompany: PropTypes.func, initialSearch: PropTypes.string, compact: PropTypes.bool };
