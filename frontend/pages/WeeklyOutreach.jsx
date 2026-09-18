import React, { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

const LINKEDIN_TARGET = 90;
const COMPANY_REVIEW_TARGET = 35;

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

export default function WeeklyOutreach() {
  const [companies, setCompanies] = useState([]);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set());
  const [contacts, setContacts] = useState([]);
  const [selectedContacts, setSelectedContacts] = useState(new Set());
  const [plan, setPlan] = useState(null);
  const [campaignId, setCampaignId] = useState("");
  const [companySearch, setCompanySearch] = useState("");
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [planning, setPlanning] = useState(false);
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
    () => companies.filter((company) => selectedCompanies.has(companyNumber(company))),
    [companies, selectedCompanies]
  );

  const approvedContacts = useMemo(
    () => contacts.filter((contact, index) => selectedContacts.has(contactKey(contact, index))),
    [contacts, selectedContacts]
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
      setContacts(discovered);
      setSelectedContacts(new Set(discovered.map((contact, index) => contactKey(contact, index))));
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
          contacts: approvedContacts,
          linkedin_weekly_cap: 100,
          linkedin_automated_target: LINKEDIN_TARGET,
          linkedin_manual_reserve: 10,
          we_connect_campaign_id: campaignId.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "Weekly planning failed");
      setPlan(payload);
    } catch (planError) {
      setError(planError.message || "Weekly planning failed");
    } finally {
      setPlanning(false);
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
        <div className="outreach-capacity-pill"><strong>90</strong><span>automated LinkedIn slots</span><small>10 kept for manual outreach</small></div>
      </header>

      {error && <div className="outreach-alert outreach-alert-error" role="alert">{error}</div>}
      {discoveryNotes.length > 0 && <div className="outreach-alert">{discoveryNotes.slice(0, 5).join(" ")}</div>}

      <section className="outreach-step-card">
        <div className="outreach-step-heading">
          <div><span>1</span><div><h2>CRM-clear the companies</h2><p>Selecting a company records your manual CRM clearance for this planning preview.</p></div></div>
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
          <div><span>2</span><div><h2>Review the stakeholders</h2><p>Remove anyone unsuitable before calculating the weekly channel plan.</p></div></div>
          <strong>{approvedContacts.length} of {contacts.length} included</strong>
        </div>
        {contacts.length === 0 ? <div className="outreach-empty">Run Apollo discovery to populate this review queue.</div> : (
          <div className="table-shell outreach-table-shell">
            <table className="data-table outreach-table">
              <thead><tr><th>Include</th><th>Person</th><th>Company</th><th>Role</th><th>Channels found</th></tr></thead>
              <tbody>{contacts.map((contact, index) => {
                const key = contactKey(contact, index);
                return <tr key={key}>
                  <td><input aria-label={`Include ${contact.full_name}`} type="checkbox" checked={selectedContacts.has(key)} onChange={() => toggleContact(contact, index)} /></td>
                  <td><strong>{contact.full_name || "Unnamed contact"}</strong></td>
                  <td>{contact.company_name}</td>
                  <td>{contact.role || "Role unavailable"}</td>
                  <td><div className="outreach-channel-list"><span className={contact.linkedin_url ? "available" : "missing"}>LinkedIn</span><span className={contact.email ? "available" : "missing"}>Email</span><span className={contact.phone ? "available" : "missing"}>Phone</span></div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
        <div className="outreach-plan-controls">
          <label>We-Connect campaign ID <input value={campaignId} onChange={(event) => setCampaignId(event.target.value)} placeholder="Optional until campaign is created" /></label>
          <button type="button" className="outreach-primary-button" onClick={generatePlan} disabled={planning || approvedContacts.length === 0}>{planning ? "Calculating…" : "Generate weekly plan"}</button>
        </div>
      </section>

      <section className="outreach-step-card">
        <div className="outreach-step-heading"><div><span>3</span><div><h2>Approval queue</h2><p>Preview only. No LinkedIn, email or phone action is sent from this screen.</p></div></div>{plan && <strong>{plan.summary?.active_companies_this_week || 0} active companies</strong>}</div>
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
                <td>{assignment.we_connect_preview ? "Preview built" : campaignId.trim() ? "Not selected" : "Campaign ID needed"}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="outreach-safety-note"><strong>Sending remains locked.</strong> Live We-Connect enrolment will only be enabled after its authenticated API schema is verified and a persisted final approval step is added.</div>
        </>}
      </section>
    </div>
  );
}

export { companyDomain, companyName, turnoverValue };
