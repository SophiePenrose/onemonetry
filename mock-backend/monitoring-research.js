// Company-number handoff: source evidence never overwrites existing workflow or scores.
export function createMonitoringResearch({
  normalizeCompanyNumber, loadCompanies, getMonitoredCompany, getCompanyState,
  isSuppressed, getStoredScore, upsertMonitoredCompany, setSetting, getSetting,
  getTurnoverThreshold, getTurnoverMaxThreshold,
}) {
  return {
  localContext(number) {
    const normalized = normalizeCompanyNumber(number);
    if (!normalized) return {};
    const existing = loadCompanies().find(company => normalizeCompanyNumber(company.company_number) === normalized);
    const monitored = getMonitoredCompany(normalized);
    const id = existing?.id || `ch-${normalized}`;
    const customerMatch = getSetting(`monitoring_context_${normalized}`, null)?.customer_matches?.length > 0;
    return {
      company_id: existing || monitored ? id : null,
      workflow_state: getCompanyState(id).state,
      ...isSuppressed(id, normalized),
      ...(customerMatch ? { suppressed: true, reason: "Past-customer match requires CRM review" } : {}),
      scored: Boolean(getStoredScore(normalized)),
    };
  },
  addToResearch(company) {
    const number = company.company_number;
    const existing = loadCompanies().find(row => normalizeCompanyNumber(row.company_number) === number);
    const monitored = getMonitoredCompany(number);
    // Preserve existing facts, suppression, workflow and scores. New records remain outside the shortlist.
    if (!existing && !monitored) upsertMonitoredCompany({
      company_number: number, company_name: company.company_name,
      company_domain: company.company_domain, latest_turnover: company.turnover_gbp ?? null,
      source: "supabase_monitoring", status: "research",
    });
    setSetting(`monitoring_context_${number}`, { ...company, source: "supabase", fetched_at: new Date().toISOString() });
    return { company_id: existing?.id || `ch-${number}`, created: !existing && !monitored };
  },
  addToShortlist(number) {
    const company = getMonitoredCompany(number);
    const score = getStoredScore(number);
    if (!company || company.source !== "supabase_monitoring") throw Object.assign(new Error(), { code: "monitoring_research_company_required", status: 400 });
    if (isSuppressed(`ch-${number}`, number).suppressed) throw Object.assign(new Error(), { code: "company_suppressed", status: 409 });
    if (getSetting(`monitoring_context_${number}`, null)?.customer_matches?.length > 0) throw Object.assign(new Error(), { code: "company_suppressed", status: 409 });
    if (company.latest_turnover == null || company.latest_turnover < getTurnoverThreshold() || company.latest_turnover > getTurnoverMaxThreshold()) throw Object.assign(new Error(), { code: "company_outside_turnover_scope", status: 409 });
    // Reuse the engine's full fit gate without changing its weights or calibration.
    if (!score || score.confidence?.product_fit_gate !== 1) throw Object.assign(new Error(), { code: "product_fit_research_required", status: 409 });
    upsertMonitoredCompany({ ...company, status: "active" });
    return { company_id: `ch-${number}`, shortlisted: true, crm_approved: false, outreach_approved: false };
  }
  };
}
