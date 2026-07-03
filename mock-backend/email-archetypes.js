/**
 * Email Archetypes — 8 trigger-based email types with data-driven selection.
 * Each archetype has a trigger condition, subject formula, and generation guidance.
 */

export const ARCHETYPES = {
  diagnostic_filing: {
    id: "diagnostic_filing",
    name: "Filing Diagnostic",
    description: "I noticed X in your filing",
    trigger: "Specific quantifiable signal in Companies House filing",
    conversion_strength: "Highest — feels uniquely researched",
    subject_formula: "[Company]'s [specific number]",
    required_data: ["filing_text", "turnover", "international_exposure"],
    priority: 1,
  },
  new_hire: {
    id: "new_hire",
    name: "New Hire",
    description: "New CFO/FD/Treasurer joined in last 90 days",
    trigger: "CFO/FD/Treasurer joined in last 90 days",
    conversion_strength: "Very high — they're actively reviewing",
    subject_formula: "First 100 days at [Company]",
    best_timing_days: [14, 60],
    required_data: ["key_people", "contact_tenure"],
    priority: 2,
  },
  fundraise_ma: {
    id: "fundraise_ma",
    name: "Fundraise / M&A",
    description: "Recent funding round, acquisition, or merger",
    trigger: "Recent funding round, acquisition, or merger",
    conversion_strength: "High — buying mode active",
    subject_formula: "Post-[round] financial stack",
    required_data: ["themes"],
    priority: 3,
  },
  competitor_intelligence: {
    id: "competitor_intelligence",
    name: "Competitor Intelligence",
    description: "Confirmed incumbent with displacement angle",
    trigger: "Confirmed incumbent (filing, job posting, tech stack)",
    conversion_strength: "High when displacement angle is sharp",
    subject_formula: "[Company] + [Competitor] question",
    required_data: ["competitors_detected"],
    priority: 4,
  },
  peer_benchmark: {
    id: "peer_benchmark",
    name: "Peer Benchmark",
    description: "Peer companies converted recently",
    trigger: "Peer companies in same industry converted",
    conversion_strength: "Very high — social proof + FOMO",
    subject_formula: "What 5 of your peers just did",
    required_data: ["industry"],
    priority: 5,
  },
  growth_signal: {
    id: "growth_signal",
    name: "Growth Signal",
    description: "YoY revenue growth, hiring surge, office expansion",
    trigger: "YoY revenue growth, hiring surge, expansion",
    conversion_strength: "Medium-High",
    subject_formula: "Scaling [function] at [Company]",
    required_data: ["turnover_trend", "growth_rate"],
    priority: 6,
  },
  industry_event: {
    id: "industry_event",
    name: "Industry Event",
    description: "Industry-wide change affecting the prospect",
    trigger: "Bank exit, regulatory shift, FX volatility spike, competitor outage",
    conversion_strength: "Medium — timing-dependent",
    subject_formula: "What [event] means for [Company]",
    required_data: ["industry"],
    priority: 7,
  },
  roi_calculator: {
    id: "roi_calculator",
    name: "ROI Calculator",
    description: "Specific £ saving calculated from financial data",
    trigger: "Have enough financial data to calculate specific £ saving",
    conversion_strength: "Highest reply rate of any archetype",
    subject_formula: "£[specific number] for [Company]",
    required_data: ["turnover", "international_exposure", "fx_volume_estimate"],
    priority: 8,
  },
};

export const PERSONA_HOOKS = {
  CEO: {
    cares_about: "Profitability, growth, market share, operational efficiency",
    tone: "Direct, business-outcome focused, less detail-heavy",
    switch_triggers: "Rising costs, competitive pressure, need for international payments",
    angle: "Strategic value, business growth, cost optimisation, future-proofing",
  },
  CFO: {
    cares_about: "Financial performance, cash flow visibility, compliance, risk mitigation, cost optimisation",
    tone: "Data-driven, technical depth acceptable, ROI-focused",
    switch_triggers: "Manual reporting, fragmented systems, FX exposure, regulatory pressure",
    angle: "Cost reduction, visibility, control, compliance, ROI",
  },
  "Finance Director": {
    cares_about: "Day-to-day operations, reconciliation, spend visibility, system consolidation",
    tone: "Practical, specific features, focus on day-to-day pain",
    switch_triggers: "Headcount growth, audit issues, M&A integration",
    angle: "Time savings, automation, consolidation, ease of use",
  },
  "Head of Treasury": {
    cares_about: "Settlement speed, payment costs, hedging strategy, counterparty risk",
    tone: "Sophisticated, specific to treasury function, technical terms acceptable",
    switch_triggers: "Bank exiting market, settlement complaint, hedging loss event",
    angle: "Technical depth, settlement times, multi-currency, hedging tools, API",
  },
  "Head of Payments": {
    cares_about: "Online revenue, conversion rates, payment security, fraud",
    tone: "Outcome-focused, conversion metrics, competitive analysis",
    switch_triggers: "Settlement delay, conversion drop, fraud incident",
    angle: "Conversion uplift, settlement speed, all-in-one acquiring + banking",
  },
  Director: {
    cares_about: "Business performance, vendor consolidation, scalability",
    tone: "Balanced, outcome-focused, process-aware",
    switch_triggers: "Rising costs, vendor proliferation, scaling challenges",
    angle: "Single platform, fewer vendors, time savings, scalability",
  },
};

export const COMPETITOR_DISPLACEMENT = {
  HSBC: { weakness: "Potential digital friction and FX workflow complexity", angle: "If a high-street bank remains the primary relationship, the useful comparison is usually where FX execution, international payments, and day-to-day controls can run alongside it without forcing a full switch." },
  Barclays: { weakness: "Potential legacy workflow and FX execution complexity", angle: "If a high-street bank remains the primary relationship, the useful comparison is usually where FX execution, international payments, and day-to-day controls can run alongside it without forcing a full switch." },
  NatWest: { weakness: "Potential digital workflow friction", angle: "If a high-street bank remains the primary relationship, the useful comparison is usually where FX execution, international payments, and day-to-day controls can run alongside it without forcing a full switch." },
  Lloyds: { weakness: "Potential digital workflow friction", angle: "If a high-street bank remains the primary relationship, the useful comparison is usually where FX execution, international payments, and day-to-day controls can run alongside it without forcing a full switch." },
  Stripe: { weakness: "Settlement, reconciliation, and checkout workflow to benchmark", angle: "If a specialist PSP is already in place, the useful comparison is settlement timing, reconciliation flow, currency handling, and what can be consolidated without disrupting checkout." },
  Worldpay: { weakness: "Settlement, reconciliation, and checkout workflow to benchmark", angle: "If a specialist PSP is already in place, the useful comparison is settlement timing, reconciliation flow, currency handling, and what can be consolidated without disrupting checkout." },
  Adyen: { weakness: "Enterprise payment workflow to benchmark", angle: "If an enterprise PSP is already in place, the useful comparison is which payment and treasury workflows genuinely need that depth and which can be simplified around the operating account." },
  Wise: { weakness: "Single-workflow FX/transfer setup to benchmark", angle: "If a transfer-led setup is already in place, the useful comparison is whether currency execution, cards, payments, and spend controls now need to work as one operating layer." },
  Ebury: { weakness: "FX-led relationship to benchmark", angle: "If FX is already handled separately, the useful comparison is whether recurring currency obligations, cards, AP, and operating-account visibility should remain split." },
  Pleo: { weakness: "Spend workflow isolated from banking and multicurrency controls", angle: "If expenses are already managed in a standalone tool, the useful comparison is whether spend controls, cards, FX, and operating-account visibility should remain separate." },
  Amex: { weakness: "Premium card workflow isolated from operating controls", angle: "If premium cards are already used by senior stakeholders, the useful comparison is travel, FX, spend controls, and reconciliation rather than a simple reward-led card swap." },
};

export const SECTOR_ANGLES = {
  travel: { motions: ["Cards", "FX", "FX Forwards", "Merchant Acquiring"], hook: "Booking windows 3–5 months ahead = perfect forwards use case", pain: "FX volatility on advance bookings, GDS supplier payments" },
  retail: { motions: ["FX", "FX Forwards", "Spend Management", "Cards"], hook: "Fixed contract pricing with variable FX inputs", pain: "Supplier payments in EUR/USD, hedging gap, margin erosion" },
  wholesale: { motions: ["FX", "FX Forwards", "Spend Management"], hook: "Fixed contract pricing with variable FX inputs", pain: "Supplier payments in EUR/USD, hedging gap, margin erosion" },
  manufacturing: { motions: ["FX", "FX Forwards", "Spend Management", "Cards"], hook: "Fixed contract pricing with variable FX inputs", pain: "Supplier payments in EUR/USD, hedging gap, margin erosion" },
  commodity: { motions: ["FX", "FX Forwards"], hook: "Spot exposure on multi-month delivery contracts", pain: "Hedging cost, counterparty risk, currency volatility on margin" },
  ecommerce: { motions: ["Merchant Acquiring", "Revolut Pay", "FX"], hook: "Checkout conversion, settlement speed, cross-border fees", pain: "3–7 day settlement creating cash flow drag" },
  consulting: { motions: ["FX", "Cards", "Spend Management"], hook: "International client base with multi-currency invoicing", pain: "FX on monthly revenue, employee expenses" },
  it: { motions: ["FX", "Cards", "Spend Management", "API Integrations"], hook: "International client base with multi-currency invoicing", pain: "SaaS subscriptions via cards, FX on revenue" },
  hospitality: { motions: ["Merchant Acquiring", "Cards", "FX", "FX Forwards"], hook: "Convenience tax of flat-rate processors, settlement speed", pain: "Square/Zettle 1.75% flat rate, slow settlement" },
  logistics: { motions: ["FX", "API Integrations", "Cards"], hook: "Multi-currency fuel/supplier payments, driver expense management", pain: "International payouts, fuel spend visibility" },
  energy: { motions: ["FX", "FX Forwards", "Cards", "Spend Management"], hook: "Commodity price volatility and international operations", pain: "Currency exposure on traded commodities" },
  property: { motions: ["Cards", "Spend Management"], hook: "Multi-site spend visibility and contractor payments", pain: "Fragmented spend across multiple properties" },
};

export function detectTriggers(company, analysis, score) {
  const triggers = [];

  if (analysis?.international_exposure?.present && company.turnover) {
    const estimatedFxVolume = company.turnover * (analysis.international_exposure.currencies?.length > 1 ? 0.4 : 0.2);
    const estimatedSavings = Math.round(estimatedFxVolume * 0.015);
    if (estimatedSavings > 10000) {
      triggers.push({
        type: "fx_exposure_quantified",
        strength: estimatedSavings > 50000 ? "high" : "medium",
        data: { estimated_fx_volume: estimatedFxVolume, estimated_savings: estimatedSavings, currencies: analysis.international_exposure.currencies },
        best_archetype: "roi_calculator",
      });
    }
  }

  if (analysis?.key_people?.length > 0) {
    triggers.push({
      type: "key_people_identified",
      strength: "medium",
      data: { people: analysis.key_people },
      best_archetype: "diagnostic_filing",
    });
  }

  if (analysis?.competitors_detected?.length > 0) {
    const displaceable = analysis.competitors_detected.filter((c) => COMPETITOR_DISPLACEMENT[c.name]);
    if (displaceable.length > 0) {
      triggers.push({
        type: "competitor_detected",
        strength: "high",
        data: { competitors: displaceable },
        best_archetype: "competitor_intelligence",
      });
    }
  }

  if (analysis?.turnover_trend === "growing" || (score?.growth?.rate && score.growth.rate > 0.1)) {
    triggers.push({
      type: "growth_signal",
      strength: score?.growth?.rate > 0.2 ? "high" : "medium",
      data: { trend: analysis.turnover_trend, rate: score?.growth?.rate },
      best_archetype: "growth_signal",
    });
  }

  if (analysis?.themes?.some((t) => /acquisition|merger|M&A/i.test(t.theme))) {
    triggers.push({
      type: "ma_activity",
      strength: "high",
      data: {},
      best_archetype: "fundraise_ma",
    });
  }

  if (analysis?.themes || analysis?.pain_indicators) {
    triggers.push({
      type: "filing_data_available",
      strength: "medium",
      data: {},
      best_archetype: "diagnostic_filing",
    });
  }

  triggers.sort((a, b) => {
    const strengthOrder = { high: 0, medium: 1, low: 2 };
    return (strengthOrder[a.strength] || 2) - (strengthOrder[b.strength] || 2);
  });

  return triggers;
}

export function selectArchetype(triggers, analysis, company) {
  if (!triggers || triggers.length === 0) return ARCHETYPES.diagnostic_filing;

  const topTrigger = triggers[0];
  const archetype = ARCHETYPES[topTrigger.best_archetype] || ARCHETYPES.diagnostic_filing;

  return {
    ...archetype,
    selected_trigger: topTrigger,
    all_triggers: triggers,
  };
}

export function getPersonaGuidance(role) {
  const normalised = Object.keys(PERSONA_HOOKS).find(
    (k) => k.toLowerCase() === (role || "").toLowerCase()
  ) || "Director";
  return PERSONA_HOOKS[normalised] || PERSONA_HOOKS.Director;
}

export function getSectorAngle(industry) {
  const key = Object.keys(SECTOR_ANGLES).find(
    (k) => (industry || "").toLowerCase().includes(k)
  );
  return key ? SECTOR_ANGLES[key] : null;
}
