const URGENCY_WINDOWS = {
  new_hire: { hot: 60, warm: 180, label: "new leader review window" },
  filing_data_available: { hot: 14, warm: 60, label: "recent filing review window" },
  fx_exposure_quantified: { hot: 30, warm: 90, label: "fresh FX benchmark window" },
  competitor_detected: { hot: 30, warm: 120, label: "incumbent comparison window" },
  ma_activity: { hot: 30, warm: 120, label: "integration window" },
  fundraise_ma: { hot: 21, warm: 90, label: "capital deployment window" },
  growth_signal: { hot: 60, warm: 180, label: "scaling pressure window" },
  industry_event: { hot: 7, warm: 30, label: "market event window" },
};

function daysSince(value, now = new Date()) {
  if (typeof value === "number") return value;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000));
}

function findRecencyDays(trigger = {}, company = {}, analysis = {}, now = new Date()) {
  return trigger.recency_days
    ?? trigger.data?.recency_days
    ?? daysSince(trigger.data?.date, now)
    ?? daysSince(company.latest_filing_date, now)
    ?? daysSince(analysis?.analysed_at, now);
}

export function scoreWhyNow(trigger = {}, company = {}, analysis = {}, now = new Date()) {
  const type = trigger.type || "filing_data_available";
  const window = URGENCY_WINDOWS[type] || { hot: 30, warm: 120, label: "review window" };
  const recencyDays = findRecencyDays(trigger, company, analysis, now);

  if (recencyDays === null) {
    return {
      urgency: "medium",
      score: 55,
      reason: `${window.label}; no exact trigger date available`,
      recency_days: null,
      decay: "unknown_date",
    };
  }

  if (recencyDays <= window.hot) {
    return {
      urgency: "hot",
      score: 90,
      reason: `${window.label}; ${recencyDays} days old`,
      recency_days: recencyDays,
      decay: "inside_hot_window",
    };
  }

  if (recencyDays <= window.warm) {
    const span = Math.max(window.warm - window.hot, 1);
    const score = Math.round(70 - ((recencyDays - window.hot) / span) * 25);
    return {
      urgency: "warm",
      score,
      reason: `${window.label}; ${recencyDays} days old and cooling`,
      recency_days: recencyDays,
      decay: "inside_warm_window",
    };
  }

  return {
    urgency: "cold",
    score: 25,
    reason: `${window.label}; ${recencyDays} days old, use nurture rather than urgent CTA`,
    recency_days: recencyDays,
    decay: "expired_window",
  };
}

export function inferEmotionalContext(company = {}, analysis = {}) {
  const text = JSON.stringify(analysis).toLowerCase();
  if (/loss|going concern|cash pressure|cost pressure|declin/.test(text)) {
    return {
      state: "under_pressure",
      tone: "Reduce cognitive load; be practical, non-judgemental, and avoid big-change language.",
    };
  }
  if (/new cfo|new fd|new finance director|appointed/.test(text)) {
    return {
      state: "new_leader_proving_value",
      tone: "Offer benchmarks and low-risk review language; avoid implying they inherited a mess.",
    };
  }
  if (/acquisition|merger|integration|post-acquisition/.test(text)) {
    return {
      state: "integration_complexity",
      tone: "Acknowledge inherited systems and consolidation pressure without naming internal blame.",
    };
  }
  if (/growth|hiring|expansion|new market/.test(text)) {
    return {
      state: "stretched_by_growth",
      tone: "Use calm operational language; focus on preventing avoidable workflow drag.",
    };
  }
  if ((company.turnover || 0) > 200_000_000) {
    return {
      state: "mature_cautious",
      tone: "Respect what is working; suggest a benchmark, not a platform change.",
    };
  }
  return {
    state: "neutral",
    tone: "Use balanced, probabilistic language and one practical next step.",
  };
}

export function inferInternalPolitics(company = {}, analysis = {}) {
  const text = JSON.stringify(analysis).toLowerCase();
  const hints = [];

  if (/charge|barclays|hsbc|natwest|lloyds|credit facility|loan/.test(text)) {
    hints.push("Credit relationship may sit with an incumbent bank; position Revolut as parallel operating/FX layer, not a replacement.");
  }
  if (/new cfo|new fd|appointed/.test(text)) {
    hints.push("New finance leader may want benchmarks but avoid public criticism of inherited relationships.");
  }
  if (/acquisition|merger|integration/.test(text)) {
    hints.push("Post-deal systems may be inherited; use consolidation language without blaming prior teams.");
  }
  if (/procurement|vendor onboarding/.test(text)) {
    hints.push("Procurement may gate onboarding; separate commercial value from vendor approval process.");
  }
  if (/stripe|worldpay|adyen|wise|pleo|spendesk|concur|amex/.test(text)) {
    hints.push("Status quo vendor may have internal sponsors; use objective comparison and avoid adversarial displacement.");
  }

  return {
    friction_level: hints.length >= 2 ? "medium" : hints.length === 1 ? "low" : "unknown",
    hints,
  };
}

export function buildOutboundIntelligence({ company = {}, analysis = {}, trigger = null } = {}) {
  return {
    why_now: scoreWhyNow(trigger || {}, company, analysis),
    emotional_context: inferEmotionalContext(company, analysis),
    internal_politics: inferInternalPolitics(company, analysis),
  };
}
