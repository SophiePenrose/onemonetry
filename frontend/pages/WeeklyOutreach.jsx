import React, { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import HandoffReviews from "../components/HandoffReviews";
import useOutreachDraft from "../hooks/useOutreachDraft";

const COMPANY_REVIEW_TARGET = 35;

function outreachError(code) {
  return ({ reviewed_plan_required: "Generate a fresh reviewed plan first.", outreach_draft_changed: "Your selections changed. Save the draft and generate a new plan.",
    outreach_week_changed: "A new week has started. Reload the planner.", weekly_capacity_changed: "Another plan used some slots. Generate a fresh plan for the remaining capacity.",
    outreach_contacts_already_reserved: "Some contacts are already reserved or handed over. Generate a new plan.",
    outreach_eligibility_changed: "A company or contact is no longer eligible. Generate a new plan.",
    we_connect_import_needs_reconciliation: "We-Connect’s response was uncertain. Check the campaign before retrying; these slots remain reserved.",
    we_connect_import_rejected: "We-Connect rejected the import. Fix the configuration, then generate a new plan; its slots were released.",
    handoff_requires_review: "Check the previous handoff in We-Connect before continuing.",
    handoff_in_progress: "This handoff is already in progress. Do not submit it again.",
    product_fit_research_required: "Product-fit research is required.", turnover_outside_scope: "Turnover is missing or outside the target range.",
    company_suppressed_or_in_research: "Company is excluded, held or still in research.", contact_stopped_or_suppressed: "Contact has replied or is suppressed.",
  })[code] || code;
}

function companyName(company) {
  return String(company?.name || company?.company_name || company?.legal_name || "Unnamed company").trim();
}

function companyNumber(company) {
  return String(company?.company_number || company?.registration_number || company?.id || "").trim();
}

function companyDomain(company) {
  const raw = String(company?.company_domain || company?.domain || company?.website || company?.website_url || company?.company_website || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0];
  }
}

function turnoverValue(company) {
  const value = company?.turnover_gbp ?? company?.turnover ?? company?.annual_turnover;
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "Not recorded";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", notation: "compact", maximumFractionDigits: 1 }).format(parsed);
}

function contactKey(contact, index = 0) {
  return String(contact?.person_id || contact?.source_id || contact?.linkedin_url || contact?.email || `${contact?.full_name || "contact"}-${index}`);
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function Metric({ value, label, detail, tone = "blue" }) {
  return (
    <div className={`outreach-metric outreach-metric-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}

Metric.propTypes = {
  value: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
  label: PropTypes.string.isRequired,
  detail: PropTypes.string,
  tone: PropTypes.string,
};

export default function WeeklyOutreach({ initialSearch = "", draftClient }) {
  const [companies, setCompanies] = useState([]);
  const { draft, status: draftStatus, loaded: draftLoaded, error: draftError, week_start: draftWeek, revision: draftRevision, updateDraft, retrySave, reloadDraft } = useOutreachDraft(draftClient);
  const selectedCompanies = useMemo(() => new Set(draft.selected_company_numbers), [draft.selected_company_numbers]);
  const selectedContacts = useMemo(() => new Set(draft.selected_contact_keys), [draft.selected_contact_keys]);
  const contacts = draft.contacts;
  const campaignName = draft.campaign_name;
  const draftBlocked = !draftLoaded || draftStatus === "conflict" || draftStatus === "loading";
  function setSelectedCompanies(updater) {
    updateDraft(current => ({ ...current, selected_company_numbers: [...(typeof updater === "function" ? updater(new Set(current.selected_company_numbers)) : updater)] }));
  }
  function setSelectedContacts(updater) {
    updateDraft(current => ({ ...current, selected_contact_keys: [...(typeof updater === "function" ? updater(new Set(current.selected_contact_keys)) : updater)] }));
  }
  function setCampaignName(value) { updateDraft(current => ({ ...current, campaign_name: value })); }
  const [plan, setPlan] = useState(null);
  const [capacity, setCapacity] = useState(null);
  const [handoffRefresh, setHandoffRefresh] = useState(0);
  const [weConnectStatus, setWeConnectStatus] = useState({ configured: false, loading: true });
  const [weConnectExport, setWeConnectExport] = useState(null);
  const [companySearch, setCompanySearch] = useState(initialSearch);
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [discoveryNotes, setDiscoveryNotes] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/unified-shortlist?sort_by=priority_score&sort_dir=desc&turnover_band=all", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the current shortlist");
        return response.json();
      })
      .then((payload) => setCompanies(Array.isArray(payload?.companies) ? payload.companies : []))
      .catch((fetchError) => {
        if (fetchError?.name !== "AbortError") setError(fetchError.message || "Could not load companies");
      })
      .finally(() => setLoadingCompanies(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/integrations/we-connect/status", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not check We-Connect configuration")))
      .then((payload) => setWeConnectStatus({ ...payload, loading: false }))
      .catch((statusError) => {
        if (statusError?.name !== "AbortError") setWeConnectStatus({ configured: false, loading: false });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    fetch("/api/outreach/capacity", { cache: "no-store" }).then(response => response.ok ? response.json() : null)
      .then(setCapacity).catch(() => setCapacity(null));
  }, []);

  useEffect(() => { setPlan(null); setWeConnectExport(null); }, [draft.selected_company_numbers, draft.selected_contact_keys, draft.contacts]);

  const filteredCompanies = useMemo(() => {
    const query = companySearch.trim().toLowerCase();
    const rows = companies.filter((company) => {
      const turnover = turnoverValue(company);
      if (turnover !== null && turnover < 30000000) return false;
      if (!query) return true;
      return companyName(company).toLowerCase().includes(query) || companyNumber(company).toLowerCase().includes(query);
    });
    return rows.slice(0, 80);
  }, [companies, companySearch]);

  const approvedCompanies = useMemo(
    () => companies.filter((company) => selectedCompanies.has(companyNumber(company)) && turnoverValue(company) >= 30000000),
    [companies, selectedCompanies]
  );

  const approvedContacts = useMemo(
    () => contacts.filter((contact, index) => selectedContacts.has(contactKey(contact, index))
      && approvedCompanies.some(company => companyNumber(company) === contact.company_number))
      .map(contact => {
        const company = approvedCompanies.find(row => companyNumber(row) === contact.company_number);
        return { ...contact, company_turnover_gbp: turnoverValue(company), crm_approved: true };
      }),
    [contacts, selectedContacts, approvedCompanies]
  );

  function toggleCompany(company) {
    const key = companyNumber(company);
    setSelectedCompanies((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setPlan(null);
  }

  function selectSuggestedCompanies() {
    setSelectedCompanies(new Set(filteredCompanies.slice(0, COMPANY_REVIEW_TARGET).map(companyNumber).filter(Boolean)));
    setPlan(null);
  }

  function toggleContact(contact, index) {
    const key = contactKey(contact, index);
    setSelectedContacts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setPlan(null);
  }

  async function discoverContacts() {
    if (approvedCompanies.length === 0) {
      setError("Select at least one CRM-cleared company first.");
      return;
    }
    setDiscovering(true);
    setError(null);
    setPlan(null);
    try {
      const results = await runWithConcurrency(approvedCompanies, 3, async (company) => {
        const domain = companyDomain(company);
        if (!domain) return { company, candidates: [], note: `${companyName(company)} needs a website/domain before Apollo search.` };
        const response = await fetch("/api/contacts/apollo/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company_domain: domain, per_page: 8 }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return { company, candidates: [], note: `${companyName(company)}: ${payload?.detail || payload?.error || "Apollo search failed"}` };
        return { company, candidates: Array.isArray(payload?.candidates) ? payload.candidates : [] };
      });

      const discovered = results.flatMap(({ company, candidates }) => candidates.map((candidate) => ({
        ...candidate,
        company_name: companyName(company),
        company_number: companyNumber(company),
        company_domain: companyDomain(company),
        company_turnover_gbp: turnoverValue(company),
        priority_score: Number(company?.priority_score || company?.composite_score || 0),
        crm_approved: true,
      })));
      updateDraft(current => ({ ...current, contacts: discovered,
        selected_contact_keys: discovered.map((contact, index) => contactKey(contact, index)) }));
      setDiscoveryNotes(results.map((result) => result.note).filter(Boolean));
      if (discovered.length === 0) setError("Apollo returned no contacts for the selected companies. Check the recorded domains or widen the role search later.");
    } catch (discoveryError) {
      setError(discoveryError.message || "Contact discovery failed");
    } finally {
      setDiscovering(false);
    }
  }

  async function generatePlan() {
    if (approvedContacts.length === 0) {
      setError("Select at least one contact to include in the weekly plan.");
      return;
    }
    setPlanning(true);
    setError(null);
    try {
      const response = await fetch("/api/contacts/weekly-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_confirmed: true,
          draft_revision: draftRevision,
          week_start: draftWeek,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(outreachError(payload?.error) || "Weekly planning failed");
      setPlan(payload);
      setCapacity(payload.capacity || null);
    } catch (planError) {
      setError(planError.message || "Weekly planning failed");
    } finally {
      setPlanning(false);
    }
  }

  async function prepareWeConnectExport() {
    if (!plan?.assignments?.length) return;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/linkedin/we-connect/manual-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.plan_id, campaign_name: campaignName.trim() || undefined }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(outreachError(payload?.error) || "Could not prepare the We-Connect list");
      setWeConnectExport(payload);
      if (payload.capacity) setCapacity(payload.capacity);
    } catch (exportError) {
      setError(exportError.message || "Could not prepare the We-Connect list");
    } finally {
      setExporting(false);
    }
  }

  async function importToWeConnect() {
    if (!plan?.assignments?.length || !campaignName.trim()) {
      setError("Enter the exact We-Connect campaign name before importing.");
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/linkedin/we-connect/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, campaign_name: campaignName.trim(), plan_id: plan.plan_id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(outreachError(payload?.error) || "Could not add contacts to We-Connect");
      setWeConnectExport(payload);
      if (payload.capacity) setCapacity(payload.capacity);
    } catch (importError) {
      setError(importError.message || "Could not add contacts to We-Connect");
    } finally {
      setExporting(false);
      setHandoffRefresh(current => current + 1);
    }
  }

  async function copyWeConnectUrls() {
    if (!weConnectExport?.url_text) return;
    try {
      const response = await fetch(`/api/linkedin/we-connect/manual-export/${encodeURIComponent(weConnectExport.batch.id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(outreachError(payload.error) || "Could not recheck this handoff.");
      await navigator.clipboard.writeText(payload.items.map(item => item.linkedin_url).join("\n"));
    } catch (copyError) { setError(copyError.message); }
  }

  async function confirmWeConnectPaste() {
    const batchId = weConnectExport?.batch?.id;
    if (!batchId) return;
    setExporting(true);
    try {
      const response = await fetch(`/api/linkedin/we-connect/manual-export/${encodeURIComponent(batchId)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const batch = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(batch?.detail || batch?.error || "Could not confirm the handoff");
      setWeConnectExport((current) => ({ ...current, batch }));
    } catch (confirmError) {
      setError(confirmError.message || "Could not confirm the handoff");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="outreach-page">
      <header className="outreach-header">
        <div>
          <div className="outreach-eyebrow">Weekly multichannel capacity</div>
          <h1>Outreach Planner</h1>
          <p>Select companies only after checking the CRM, find stakeholders with Apollo, then review the channel allocation before anything enters We-Connect.</p>
        </div>
        <div className="outreach-capacity-pill"><strong>{capacity ? capacity.remaining : "—"}</strong><span>of 90 weekly slots remaining</span><small>10 kept for manual outreach</small></div>
      </header>

      <div className="outreach-alert" role="status">
        {draftStatus === "loading" ? "Loading weekly draft…" : draftStatus === "saving" ? "Saving draft…" : draftStatus === "saved" ? `Draft saved · week of ${draftWeek}` : "Draft needs attention"}
        <span> · Saved choices do not enrol contacts. Generate a fresh plan before confirming an import.</span>
      </div>
      {capacity && <div className="outreach-alert">{capacity.used} slots reserved or handed over this week across all plans. Manual exports reserve slots too.</div>}
      {draftError && <div className="outreach-alert outreach-alert-error" role="alert">{draftError} {draftStatus === "save_error"
        ? <button type="button" onClick={retrySave}>Retry save</button>
        : <button type="button" onClick={reloadDraft}>Reload saved draft</button>}</div>}
      <HandoffReviews refreshToken={handoffRefresh} onResolved={updatedCapacity => { setCapacity(updatedCapacity); setPlan(null); setWeConnectExport(null); }} />
      <fieldset disabled={draftBlocked || discovering || planning || exporting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {error && <div className="outreach-alert outreach-alert-error" role="alert">{error}</div>}
      {discoveryNotes.length > 0 && <div className="outreach-alert">{discoveryNotes.slice(0, 5).join(" ")}</div>}

      <section className="outreach-step-card">
        <div className="outreach-step-heading">
          <div><span>1</span><div><h2>CRM-clear the companies</h2><p>Select after checking the CRM. Choices are saved for this week; confirmed turnover of at least £30m is required to include contacts.</p></div></div>
          <button type="button" className="outreach-secondary-button" onClick={selectSuggestedCompanies} disabled={loadingCompanies}>Select top {COMPANY_REVIEW_TARGET}</button>
        </div>
        <div className="outreach-toolbar">
          <input aria-label="Search companies" placeholder="Search company or number" value={companySearch} onChange={(event) => setCompanySearch(event.target.value)} />
          <strong>{selectedCompanies.size} selected</strong>
          <span>Suggested range: 30–35</span>
        </div>
        {loadingCompanies ? <div className="outreach-empty">Loading shortlist…</div> : (
          <div className="outreach-company-grid">
            {filteredCompanies.map((company) => {
              const key = companyNumber(company);
              const selected = selectedCompanies.has(key);
              return (
                <label key={key} className={`outreach-company-card${selected ? " selected" : ""}`}>
                  <input type="checkbox" checked={selected} onChange={() => toggleCompany(company)} />
                  <span><strong>{companyName(company)}</strong><small>{key || "No company number"} · {formatMoney(turnoverValue(company))}</small><small>{companyDomain(company) || "Website/domain needed"}</small></span>
                </label>
              );
            })}
          </div>
        )}
        <div className="outreach-step-actions">
          <button type="button" className="outreach-primary-button" onClick={discoverContacts} disabled={discovering || approvedCompanies.length === 0}>
            {discovering ? "Finding contacts…" : `Find contacts for ${approvedCompanies.length} companies`}
          </button>
          <span>Zero-credit Apollo search; no email or phone enrichment.</span>
        </div>
      </section>

      <section className="outreach-step-card">
        <div className="outreach-step-heading">
          <div><span>2</span><div><h2>Review the stakeholders</h2><p>Remove anyone unsuitable. Generating the plan confirms you have checked the selected companies in the CRM; that clearance is dated and recorded.</p></div></div>
          <strong>{approvedContacts.length} of {contacts.length} included</strong>
        </div>
        {contacts.length === 0 ? <div className="outreach-empty">Run Apollo discovery to populate this review queue.</div> : (
          <div className="table-shell outreach-table-shell">
            <table className="data-table outreach-table">
              <thead><tr><th>Include</th><th>Person</th><th>Company</th><th>Role</th><th>Channels found</th></tr></thead>
              <tbody>{contacts.map((contact, index) => {
                const key = contactKey(contact, index);
                const companyIncluded = approvedCompanies.some(company => companyNumber(company) === contact.company_number);
                return <tr key={key}>
                  <td><input aria-label={`Include ${contact.full_name}`} type="checkbox" checked={companyIncluded && selectedContacts.has(key)} disabled={!companyIncluded} onChange={() => toggleContact(contact, index)} /></td>
                  <td><strong>{contact.full_name || "Unnamed contact"}</strong></td>
                  <td>{contact.company_name}{!companyIncluded && <small className="outreach-table-sub">Select an eligible, CRM-cleared company to include this contact.</small>}</td>
                  <td>{contact.role || "Role unavailable"}</td>
                  <td><div className="outreach-channel-list"><span className={contact.linkedin_url ? "available" : "missing"}>LinkedIn</span><span className={contact.email ? "available" : "missing"}>Email</span><span className={contact.phone ? "available" : "missing"}>Phone</span></div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
        <div className="outreach-plan-controls">
          <button type="button" className="outreach-primary-button" onClick={generatePlan} disabled={planning || draftStatus !== "saved" || approvedContacts.length === 0}>{planning ? "Calculating…" : "Confirm CRM clearance and generate plan"}</button>
        </div>
      </section>

      <section className="outreach-step-card">
        <div className="outreach-step-heading"><div><span>3</span><div><h2>Approval queue</h2><p>Review the allocation, then explicitly confirm any We-Connect import below.</p></div></div>{plan && <strong>{plan.summary?.active_companies_this_week || 0} active companies</strong>}</div>
        {plan?.rejected?.length > 0 && <div className="outreach-alert">{plan.rejected.length} contacts excluded by current company, product-fit or contact checks. {plan.rejected.slice(0, 3).map(row => `${row.full_name || row.candidate?.full_name || "Contact"}: ${outreachError(row.reason)}`).join(" ")}</div>}
        {!plan ? <div className="outreach-empty">Generate the weekly plan to see capacity and channel assignments.</div> : <>
          <div className="outreach-metrics">
            <Metric value={plan.summary?.linkedin_automated_selected || 0} label="LinkedIn selected" detail="of 90 automated slots" />
            <Metric value={plan.summary?.email_ready || 0} label="Email ready" detail="work emails available" tone="green" />
            <Metric value={plan.summary?.phone_tasks_ready || 0} label="Call tasks" detail="permitted numbers only" tone="purple" />
            <Metric value={plan.summary?.overflow_contacts || 0} label="Overflow" detail="held for a later week" tone="amber" />
          </div>
          <div className="table-shell outreach-table-shell">
            <table className="data-table outreach-table">
              <thead><tr><th>Priority</th><th>Contact</th><th>Company</th><th>LinkedIn</th><th>Email</th><th>Phone</th><th>We-Connect</th></tr></thead>
              <tbody>{(plan.assignments || []).map((assignment, index) => <tr key={contactKey(assignment, index)}>
                <td>{Math.round(Number(assignment.priority || 0))}</td><td><strong>{assignment.full_name}</strong><small className="outreach-table-sub">{assignment.role}</small></td><td>{assignment.company_name}</td>
                <td>{assignment.routes?.linkedin === "awaiting_human_approval" ? "Ready for approval" : assignment.routes?.linkedin === "queued_next_week" ? "Next week" : "—"}</td>
                <td>{assignment.routes?.email === "ready" ? "Ready" : "—"}</td><td>{assignment.routes?.phone === "call_task_ready" ? "Call task" : "—"}</td>
                <td>{assignment.routes?.linkedin === "awaiting_human_approval" ? "Ready to add" : "Not selected"}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="outreach-manual-handoff">
            <div><h3>Send approved contacts to We-Connect</h3><p>Enter the campaign name exactly as it appears in We-Connect, then confirm the import. Only the LinkedIn contacts selected for this week are sent.</p></div>
            <label>Campaign name <input value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="Exact We-Connect campaign name" /></label>
            <div className="outreach-step-actions">
              {weConnectStatus.configured && <button type="button" className="outreach-primary-button" onClick={importToWeConnect} disabled={exporting || !campaignName.trim() || !(plan.summary?.linkedin_automated_selected > 0)}>{exporting ? "Adding…" : `Confirm and add ${plan.summary?.linkedin_automated_selected || 0} contacts`}</button>}
              <button type="button" className="outreach-secondary-button" onClick={prepareWeConnectExport} disabled={exporting || !(plan.summary?.linkedin_automated_selected > 0)}>{exporting ? "Preparing…" : "Prepare manual fallback"}</button>
              {weConnectExport?.batch?.status === "prepared" && weConnectExport?.summary?.ready_to_paste > 0 && <button type="button" className="outreach-secondary-button" onClick={copyWeConnectUrls}>Copy {weConnectExport.summary.ready_to_paste} LinkedIn URLs</button>}
              {weConnectExport?.batch?.status === "prepared" && <button type="button" className="outreach-secondary-button" onClick={confirmWeConnectPaste} disabled={exporting}>I’ve pasted the fallback list</button>}
            </div>
            {weConnectExport && <div className="outreach-export-summary" role="status">
              <strong>{weConnectExport.summary?.ready_to_import ?? weConnectExport.summary?.ready_to_paste ?? 0} ready</strong>
              <span>{weConnectExport.summary?.previously_exported || 0} previously exported</span>
              <span>{weConnectExport.summary?.skipped || 0} skipped</span>
              {weConnectExport.batch?.status === "confirmed_pasted" && <strong>Handoff recorded</strong>}
              {weConnectExport.batch?.status === "imported_api" && <strong>Added to {weConnectExport.campaign_name}</strong>}
            </div>}
          </div>
          <div className="outreach-safety-note"><strong>Human approval stays mandatory.</strong> {weConnectStatus.configured ? "Nothing is added until you press the confirmation button." : "Direct API import is not configured yet, so use the manual fallback."} We-Connect activity can flow back through the protected webhook.</div>
        </>}
      </section>
      </fieldset>
    </div>
  );
}

export { companyDomain, companyName, turnoverValue };

WeeklyOutreach.propTypes = { initialSearch: PropTypes.string, draftClient: PropTypes.object };
