// Reads current company facts and existing product-fit decisions; never computes new scores.
export function createOutreachCompanyResolver({ normalizeCompanyNumber, loadCompanies, getMonitoredCompany,
  getStoredScore, isExcluded, isSuppressed, getSetting, getTurnoverThreshold, getTurnoverMaxThreshold }) {
  return function resolveOutreachCompany(number) {
    const normalized = normalizeCompanyNumber(number);
    if (!normalized) return { eligible: false, reason: "company_number_required" };
    const existing = loadCompanies().find(row => normalizeCompanyNumber(row.company_number) === normalized);
    const monitored = getMonitoredCompany(normalized);
    if (!existing && !monitored) return { eligible: false, reason: "company_not_found" };
    const company = existing || monitored;
    const id = existing?.id || `ch-${normalized}`;
    const score = getStoredScore(normalized);
    const exclusion = isExcluded({ ...company, id, company_number: normalized, industry: company.industry || (score?.industries || []).join(" ") });
    const held = isSuppressed(id, normalized);
    const customerMatch = getSetting(`monitoring_context_${normalized}`, null)?.customer_matches?.length > 0;
    if (exclusion.excluded || held.suppressed || customerMatch || (monitored && monitored.status !== "active"))
      return { eligible: false, reason: "company_suppressed_or_in_research" };
    const turnover = Number(monitored?.latest_turnover ?? existing?.turnover_gbp ?? existing?.turnover);
    if (!Number.isFinite(turnover) || turnover < Math.max(30000000, getTurnoverThreshold()) || turnover > getTurnoverMaxThreshold())
      return { eligible: false, reason: "turnover_outside_scope" };
    if (score?.confidence?.product_fit_gate !== 1) return { eligible: false, reason: "product_fit_research_required" };
    return { eligible: true, company_number: normalized, name: company.company_name || company.name, turnover,
      domain: company.company_domain || company.domain || company.website || "", priority: score.composite_score };
  };
}
