import express from "express";
import fs from "fs";
import path from "path";
import {
  getCompanyWorkflowState,
  setCompanyWorkflowState,
  saveReport as dbSaveReport,
  getReport as dbGetReport,
  getReportByWeek,
  listReports,
  getExclusions as dbGetExclusions,
  setExclusions as dbSetExclusions,
  getSetting,
  setSetting,
  createImportJob,
  updateImportJob,
  getImportJob,
  listImportJobs,
  addImportLogEntry,
  getImportLogs,
  resetDemoState,
} from "./db.js";
import {
  isCompaniesHouseConfigured,
  lookupCompany,
  parseCompanyNumbersCSV,
  getBulkDownloadInfo,
} from "./companies-house.js";
import {
  getMonthlyZipURLs,
  getDailyZipURLs,
  processAccountsZip,
  getAutoPullStatus,
  startAutoPull,
  stopAutoPull,
} from "./bulk-processor.js";

const app = express();
app.use(express.json());
const PORT = 8000;

const VALID_MOTIONS = [
  "FX",
  "FX Forwards",
  "Cards",
  "Spend Management",
  "API Integrations",
  "Merchant Acquiring",
  "Revolut Pay",
  "Monthly Plans",
];

const WORKFLOW_STATES = [
  { id: "new_candidate", label: "New Candidate", color: "#6c757d" },
  { id: "shortlisted", label: "Shortlisted", color: "#0075EB" },
  { id: "selected_for_outreach", label: "Selected for Outreach", color: "#6f42c1" },
  { id: "in_cadence", label: "In Cadence", color: "#e67e22" },
  { id: "active_opportunity", label: "Active Opportunity", color: "#20c997" },
  { id: "closed_won", label: "Closed Won", color: "#0a8754" },
  { id: "closed_lost", label: "Closed Lost", color: "#c0392b" },
  { id: "revisit_later", label: "Revisit Later", color: "#95a5a6" },
  { id: "held_for_review", label: "Held for Review", color: "#f39c12" },
];

const VALID_STATE_IDS = WORKFLOW_STATES.map((s) => s.id);

const ALLOWED_TRANSITIONS = {
  new_candidate: ["shortlisted", "held_for_review", "revisit_later"],
  shortlisted: ["selected_for_outreach", "revisit_later", "held_for_review", "new_candidate"],
  selected_for_outreach: ["in_cadence", "shortlisted", "revisit_later"],
  in_cadence: ["active_opportunity", "closed_lost", "revisit_later"],
  active_opportunity: ["closed_won", "closed_lost", "in_cadence"],
  closed_won: [],
  closed_lost: ["revisit_later", "new_candidate"],
  revisit_later: ["new_candidate", "shortlisted"],
  held_for_review: ["new_candidate", "shortlisted"],
};

// --- Exclusions and suppression ---

const SUPPRESSED_STATES = ["closed_won", "closed_lost", "held_for_review", "revisit_later"];

function isExcluded(company) {
  const exclusions = dbGetExclusions();
  if (exclusions.excluded_company_ids.includes(company.id)) return { excluded: true, reason: "Manually excluded" };
  if (exclusions.prohibited_industries.some((ind) => company.industry.toLowerCase().includes(ind.toLowerCase()))) {
    return { excluded: true, reason: `Prohibited industry: ${company.industry}` };
  }
  return { excluded: false };
}

function isSuppressed(companyId) {
  const ws = getCompanyState(companyId);
  if (SUPPRESSED_STATES.includes(ws.state)) {
    const label = WORKFLOW_STATES.find((s) => s.id === ws.state)?.label || ws.state;
    return { suppressed: true, reason: `Status: ${label}` };
  }
  return { suppressed: false };
}

// --- Scoring weights (segment-aware) ---

const VALID_SEGMENTS = ["SMB", "Mid-Market", "Enterprise"];

const LAYER_NAMES = ["product_fit", "commercial_value", "pain_strength", "urgency", "competitor_context"];

const DEFAULT_SEGMENT_WEIGHTS = {
  SMB: {
    product_fit: 0.35,
    commercial_value: 0.15,
    pain_strength: 0.25,
    urgency: 0.15,
    competitor_context: 0.10,
  },
  "Mid-Market": {
    product_fit: 0.30,
    commercial_value: 0.22,
    pain_strength: 0.20,
    urgency: 0.15,
    competitor_context: 0.13,
  },
  Enterprise: {
    product_fit: 0.28,
    commercial_value: 0.25,
    pain_strength: 0.18,
    urgency: 0.14,
    competitor_context: 0.15,
  },
};

const DEFAULT_PROPENSITY_WEIGHT = 0.15;

function getSegmentWeights() {
  return getSetting("segment_weights", DEFAULT_SEGMENT_WEIGHTS);
}

function getPropensityWeight() {
  return getSetting("propensity_weight", DEFAULT_PROPENSITY_WEIGHT);
}

const DEFAULT_WEIGHTS = DEFAULT_SEGMENT_WEIGHTS["Mid-Market"];
const PROPENSITY_WEIGHT = DEFAULT_PROPENSITY_WEIGHT;

const MERCHANT_MOTIONS = ["Merchant Acquiring", "Revolut Pay"];
const MERCHANT_BOOST_MAX = 0.08;

function computeMerchantBoost(merchantSpend, motion) {
  if (!merchantSpend || !MERCHANT_MOTIONS.includes(motion)) return 0;
  const volume = merchantSpend.annual_card_volume || 0;
  const growth = merchantSpend.growth_rate || 0;
  const volumeScore = Math.min(volume / 20_000_000, 1);
  const growthScore = Math.min(growth / 0.25, 1);
  return Math.round((volumeScore * 0.6 + growthScore * 0.4) * MERCHANT_BOOST_MAX * 100) / 100;
}

function getWeightsForSegment(segment) {
  const weights = getSegmentWeights();
  return weights[segment] || DEFAULT_WEIGHTS;
}

function computeCompositeScore(layers, weights = DEFAULT_WEIGHTS) {
  let total = 0;
  let weightSum = 0;
  for (const layer of LAYER_NAMES) {
    if (layers[layer]) {
      total += (layers[layer].score || 0) * (weights[layer] || 0);
      weightSum += weights[layer] || 0;
    }
  }
  return weightSum > 0 ? Math.round((total / weightSum) * 100) / 100 : 0;
}

function buildScoreBreakdown(layers) {
  const breakdown = {};
  for (const layer of LAYER_NAMES) {
    if (layers[layer]) {
      breakdown[layer] = {
        score: layers[layer].score,
        evidence: layers[layer].evidence,
      };
    }
  }
  return breakdown;
}

// --- State persistence (SQLite) ---

function getCompanyState(companyId) {
  return getCompanyWorkflowState(companyId);
}

// --- Unified multi-motion scoring ---

function computeCompanyProfile(company) {
  const segment = company.segment || "Mid-Market";
  const weights = getWeightsForSegment(segment);
  const propensity = company.response_propensity || { score: 0.5, warmth: "cold", signals: [] };

  const merchantSpend = company.merchant_spend || null;
  const motionScores = [];
  for (const motion of company.motions) {
    const fit = company.product_fit[motion];
    if (!fit?.eligible) continue;
    const layers = fit.layers || {};
    const baseScore = computeCompositeScore(layers, weights);
    const mBoost = computeMerchantBoost(merchantSpend, motion);
    const score = Math.round(Math.min(baseScore + mBoost, 1) * 100) / 100;
    motionScores.push({
      motion,
      score,
      base_motion_score: baseScore,
      merchant_boost: mBoost,
      fit_level: fit.fit_level,
      explanation: fit.explanation,
      score_breakdown: buildScoreBreakdown(layers),
    });
  }
  motionScores.sort((a, b) => b.score - a.score);

  const bestScore = motionScores[0]?.score || 0;
  const avgScore = motionScores.length > 0
    ? Math.round((motionScores.reduce((s, m) => s + m.score, 0) / motionScores.length) * 100) / 100
    : 0;

  const propWeight = getPropensityWeight();
  const baseScore = bestScore * 0.6 + avgScore * 0.4;
  const adjustedScore = baseScore * (1 - propWeight) + propensity.score * propWeight;
  const combinedScore = Math.round(adjustedScore * 100) / 100;

  return {
    segment,
    weights_used: weights,
    motion_scores: motionScores,
    best_motion: motionScores[0] || null,
    combined_score: combinedScore,
    base_score: Math.round(baseScore * 100) / 100,
    propensity,
    merchant_spend: merchantSpend,
    eligible_motion_count: motionScores.length,
  };
}

// --- Report persistence (SQLite) ---

// --- Data loading ---

function loadCompanies() {
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveCompanies(companies) {
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(companies, null, 2));
}

// --- Routes ---

app.get("/api/motions", (_req, res) => {
  res.json({ motions: VALID_MOTIONS });
});

app.get("/api/workflow-states", (_req, res) => {
  res.json({ states: WORKFLOW_STATES, transitions: ALLOWED_TRANSITIONS });
});

app.get("/api/scoring-weights", (_req, res) => {
  res.json({
    segment_weights: getSegmentWeights(),
    propensity_weight: getPropensityWeight(),
    defaults: { segment_weights: DEFAULT_SEGMENT_WEIGHTS, propensity_weight: DEFAULT_PROPENSITY_WEIGHT },
    layers: LAYER_NAMES,
    segments: VALID_SEGMENTS,
  });
});

app.put("/api/scoring-weights", (req, res) => {
  const { segment_weights, propensity_weight } = req.body;

  if (segment_weights) {
    for (const [seg, weights] of Object.entries(segment_weights)) {
      if (!VALID_SEGMENTS.includes(seg)) continue;
      const total = Object.values(weights).reduce((s, v) => s + v, 0);
      if (Math.abs(total - 1) > 0.01) {
        return res.status(400).json({ error: `${seg} weights must sum to 1.0 (got ${total.toFixed(2)})` });
      }
    }
    setSetting("segment_weights", { ...getSegmentWeights(), ...segment_weights });
  }

  if (propensity_weight !== undefined) {
    if (propensity_weight < 0 || propensity_weight > 0.5) {
      return res.status(400).json({ error: "propensity_weight must be between 0 and 0.5" });
    }
    setSetting("propensity_weight", propensity_weight);
  }

  res.json({
    segment_weights: getSegmentWeights(),
    propensity_weight: getPropensityWeight(),
    message: "Scoring weights updated. Rankings will reflect new weights.",
  });
});

app.post("/api/scoring-weights/reset", (_req, res) => {
  setSetting("segment_weights", DEFAULT_SEGMENT_WEIGHTS);
  setSetting("propensity_weight", DEFAULT_PROPENSITY_WEIGHT);
  res.json({
    segment_weights: DEFAULT_SEGMENT_WEIGHTS,
    propensity_weight: DEFAULT_PROPENSITY_WEIGHT,
    message: "Scoring weights reset to defaults.",
  });
});

app.get("/api/exclusions", (_req, res) => {
  const exclusions = dbGetExclusions();
  res.json({ exclusions, suppressed_states: SUPPRESSED_STATES });
});

app.put("/api/exclusions", (req, res) => {
  const { prohibited_industries, excluded_company_ids } = req.body;
  const current = dbGetExclusions();
  const updated = {
    prohibited_industries: prohibited_industries ?? current.prohibited_industries,
    excluded_company_ids: excluded_company_ids ?? current.excluded_company_ids,
  };
  dbSetExclusions(updated);
  res.json({ exclusions: updated });
});

app.get("/api/dashboard", (_req, res) => {
  const COMPANIES = loadCompanies();

  const pipeline = {};
  for (const s of WORKFLOW_STATES) {
    pipeline[s.id] = { count: 0, label: s.label, color: s.color };
  }

  const motionSummary = {};
  for (const motion of VALID_MOTIONS) {
    motionSummary[motion] = { total: 0, avg_score: 0, top_company: null };
  }

  const activeProspects = [];
  const activeStates = ["shortlisted", "selected_for_outreach", "in_cadence", "active_opportunity"];

  for (const company of COMPANIES) {
    const ws = getCompanyState(company.id);
    if (pipeline[ws.state]) pipeline[ws.state].count++;

    for (const motion of company.motions) {
      const fit = company.product_fit[motion];
      if (!fit?.eligible) continue;
      const layers = fit.layers || {};
      const score = computeCompositeScore(layers);
      motionSummary[motion].total++;
      motionSummary[motion].avg_score += score;
      if (!motionSummary[motion].top_company || score > motionSummary[motion].top_company.score) {
        motionSummary[motion].top_company = { id: company.id, name: company.name, score };
      }
    }

    if (activeStates.includes(ws.state)) {
      const bestMotion = company.motions.reduce((best, motion) => {
        const fit = company.product_fit[motion];
        if (!fit?.eligible) return best;
        const score = computeCompositeScore(fit.layers || {});
        return !best || score > best.score ? { motion, score, fit_level: fit.fit_level } : best;
      }, null);

      if (bestMotion) {
        activeProspects.push({
          id: company.id,
          name: company.name,
          industry: company.industry,
          turnover: company.turnover,
          workflow_state: ws.state,
          best_motion: bestMotion.motion,
          best_score: bestMotion.score,
          best_fit_level: bestMotion.fit_level,
          motion_count: company.motions.filter((m) => company.product_fit[m]?.eligible).length,
          last_activity: ws.history?.length > 0
            ? ws.history[ws.history.length - 1].timestamp
            : null,
        });
      }
    }
  }

  for (const motion of VALID_MOTIONS) {
    const s = motionSummary[motion];
    if (s.total > 0) s.avg_score = Math.round((s.avg_score / s.total) * 100) / 100;
  }

  activeProspects.sort((a, b) => b.best_score - a.best_score);

  res.json({
    total_companies: COMPANIES.length,
    pipeline,
    motion_summary: motionSummary,
    active_prospects: activeProspects,
  });
});

app.get("/api/unified-shortlist", (req, res) => {
  const { state_filter, show_suppressed } = req.query;
  const COMPANIES = loadCompanies();

  let excludedCount = 0;
  let suppressedCount = 0;
  const entries = [];

  for (const company of COMPANIES) {
    const excl = isExcluded(company);
    if (excl.excluded) { excludedCount++; continue; }

    const ws = getCompanyState(company.id);
    const supp = isSuppressed(company.id);
    if (supp.suppressed) {
      suppressedCount++;
      if (show_suppressed !== "true") continue;
    }

    if (state_filter && VALID_STATE_IDS.includes(state_filter) && ws.state !== state_filter) continue;

    const profile = computeCompanyProfile(company);
    if (profile.eligible_motion_count === 0) continue;

    entries.push({
      id: company.id,
      name: company.name,
      industry: company.industry,
      turnover: company.turnover,
      employee_count: company.employee_count,
      segment: profile.segment,
      combined_score: profile.combined_score,
      base_score: profile.base_score,
      propensity_score: profile.propensity.score,
      propensity_warmth: profile.propensity.warmth,
      best_motion: profile.best_motion?.motion || null,
      best_score: profile.best_motion?.score || 0,
      best_fit_level: profile.best_motion?.fit_level || null,
      eligible_motions: profile.motion_scores.map((m) => ({
        motion: m.motion,
        score: m.score,
        fit_level: m.fit_level,
      })),
      motion_count: profile.eligible_motion_count,
      has_merchant_spend: !!profile.merchant_spend,
      workflow_state: ws.state,
      suppressed: supp.suppressed,
      suppression_reason: supp.reason || null,
      rank: 0,
    });
  }

  entries.sort((a, b) => b.combined_score - a.combined_score);
  entries.forEach((e, idx) => { e.rank = idx + 1; });

  res.json({
    companies: entries,
    meta: {
      total: COMPANIES.length,
      excluded: excludedCount,
      suppressed: suppressedCount,
      showing: entries.length,
    },
  });
});

app.get("/api/shortlist", (req, res) => {
  const { product_motion, state_filter, show_suppressed } = req.query;
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  const motionEligible = COMPANIES.filter(
    (c) => c.motions.includes(product_motion) && c.product_fit[product_motion]?.eligible
  );

  let excludedCount = 0;
  let suppressedCount = 0;
  const active = [];

  for (const c of motionEligible) {
    const excl = isExcluded(c);
    if (excl.excluded) { excludedCount++; continue; }
    const supp = isSuppressed(c.id);
    if (supp.suppressed) { suppressedCount++; if (show_suppressed !== "true") continue; }
    active.push(c);
  }

  let filtered = active;
  if (state_filter && VALID_STATE_IDS.includes(state_filter)) {
    filtered = active.filter((c) => getCompanyState(c.id).state === state_filter);
  }

  const companies = filtered
    .map((c) => {
      const fit = c.product_fit[product_motion];
      const layers = fit.layers || {};
      const compositeScore = computeCompositeScore(layers);
      const ws = getCompanyState(c.id);
      const supp = isSuppressed(c.id);
      return {
        id: c.id,
        name: c.name,
        industry: c.industry,
        turnover: c.turnover,
        score: compositeScore,
        rank: 0,
        product_motion,
        fit_level: fit.fit_level,
        product_fit: fit,
        explanation: fit.explanation,
        workflow_state: ws.state,
        score_breakdown: buildScoreBreakdown(layers),
        suppressed: supp.suppressed,
        suppression_reason: supp.reason || null,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((c, idx) => ({ ...c, rank: idx + 1 }));

  res.json({
    companies,
    meta: {
      total_eligible: motionEligible.length,
      excluded: excludedCount,
      suppressed: suppressedCount,
      showing: companies.length,
    },
  });
});

app.get("/api/company/:id", (req, res) => {
  const { id } = req.params;
  const { product_motion } = req.query;
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }

  const ws = getCompanyState(id);
  const profile = computeCompanyProfile(company);

  if (product_motion && VALID_MOTIONS.includes(product_motion)) {
    const fit = company.product_fit[product_motion];
    if (!fit || !fit.eligible) {
      return res.status(403).json({ error: "Company does not meet current shortlist criteria" });
    }
    const layers = fit.layers || {};
    const compositeScore = computeCompositeScore(layers);
    res.json({
      company: {
        id: company.id,
        name: company.name,
        company_number: company.company_number,
        industry: company.industry,
        turnover: company.turnover,
        employee_count: company.employee_count,
        latest_annual_report_url: company.latest_annual_report_url,
        product_fit: fit,
        score_breakdown: buildScoreBreakdown(layers),
        final_score: compositeScore,
        explanation: fit.explanation,
        workflow_state: ws.state,
        workflow_history: ws.history || [],
        competitors: company.competitors || [],
        stakeholders: company.stakeholders || [],
        cadence_history: company.cadence_history || [],
        notes: getSetting(`notes_${company.id}`, ""),
        all_motion_scores: profile.motion_scores,
        combined_score: profile.combined_score,
        base_score: profile.base_score,
        segment: profile.segment,
        segment_weights: profile.weights_used,
        propensity: profile.propensity,
        merchant_spend: profile.merchant_spend,
      },
    });
  } else {
    res.json({
      company: {
        id: company.id,
        name: company.name,
        company_number: company.company_number,
        industry: company.industry,
        turnover: company.turnover,
        employee_count: company.employee_count,
        latest_annual_report_url: company.latest_annual_report_url,
        combined_score: profile.combined_score,
        base_score: profile.base_score,
        segment: profile.segment,
        segment_weights: profile.weights_used,
        propensity: profile.propensity,
        merchant_spend: profile.merchant_spend,
        best_motion: profile.best_motion,
        all_motion_scores: profile.motion_scores,
        workflow_state: ws.state,
        workflow_history: ws.history || [],
        competitors: company.competitors || [],
        stakeholders: company.stakeholders || [],
        cadence_history: company.cadence_history || [],
        notes: getSetting(`notes_${company.id}`, ""),
      },
    });
  }
});

app.patch("/api/company/:id/state", (req, res) => {
  const { id } = req.params;
  const { new_state, note } = req.body;

  if (!new_state || !VALID_STATE_IDS.includes(new_state)) {
    return res.status(400).json({ error: "Missing or invalid new_state", valid_states: VALID_STATE_IDS });
  }

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }

  const current = getCompanyState(id);
  const allowed = ALLOWED_TRANSITIONS[current.state] || [];
  if (!allowed.includes(new_state)) {
    return res.status(422).json({
      error: `Cannot transition from "${current.state}" to "${new_state}"`,
      allowed_transitions: allowed,
    });
  }

  setCompanyWorkflowState(id, current.state, new_state, note || null);
  const updated = getCompanyState(id);

  res.json({
    company_id: id,
    previous_state: current.state,
    new_state,
    allowed_transitions: ALLOWED_TRANSITIONS[new_state],
    history: updated.history,
  });
});

// --- Weekly Reports ---

function getWeekLabel(date) {
  const d = new Date(date);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay() + 1);
  return start.toISOString().slice(0, 10);
}

function generateReportSnapshot(COMPANIES, topN = 20) {
  const entries = [];
  for (const company of COMPANIES) {
    const ws = getCompanyState(company.id);
    if (["closed_won", "closed_lost"].includes(ws.state)) continue;

    const bestMotion = company.motions.reduce((best, motion) => {
      const fit = company.product_fit[motion];
      if (!fit?.eligible) return best;
      const score = computeCompositeScore(fit.layers || {});
      return !best || score > best.score
        ? { motion, score, fit_level: fit.fit_level, explanation: fit.explanation }
        : best;
    }, null);

    if (bestMotion) {
      entries.push({
        company_id: company.id,
        name: company.name,
        industry: company.industry,
        turnover: company.turnover,
        best_motion: bestMotion.motion,
        score: bestMotion.score,
        fit_level: bestMotion.fit_level,
        explanation: bestMotion.explanation,
        workflow_state_at_generation: ws.state,
        eligible_motions: company.motions.filter((m) => company.product_fit[m]?.eligible),
      });
    }
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, topN);
}

app.get("/api/reports/schedule", (_req, res) => {
  const nextRun = getNextSundayEvening();
  res.json({
    schedule: "Sunday evenings at 20:00",
    next_generation: nextRun.toISOString(),
    note: "Report will be ready for Monday morning review.",
  });
});

app.get("/api/reports", (_req, res) => {
  const rows = listReports();
  const summary = rows.map((r) => {
    const report = dbGetReport(r.id);
    return {
      id: r.id,
      week_label: r.week_label,
      generated_at: r.generated_at,
      company_count: report?.companies?.length || 0,
      top_company: report?.companies?.[0]?.name || null,
      top_score: report?.companies?.[0]?.score || null,
    };
  });
  res.json({ reports: summary });
});

app.get("/api/reports/:id", (req, res) => {
  const { id } = req.params;
  const report = dbGetReport(id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }

  const companiesWithCurrentState = report.companies.map((entry) => {
    const ws = getCompanyState(entry.company_id);
    return {
      ...entry,
      current_workflow_state: ws.state,
      state_changed: entry.workflow_state_at_generation !== ws.state,
    };
  });

  res.json({
    report: {
      ...report,
      companies: companiesWithCurrentState,
    },
  });
});

app.post("/api/reports/generate", (_req, res) => {
  const COMPANIES = loadCompanies();
  const now = new Date();
  const weekLabel = getWeekLabel(now);

  const existing = getReportByWeek(weekLabel);
  if (existing) {
    return res.status(409).json({
      error: "Report already exists for this week",
      report_id: existing.id,
      week_label: weekLabel,
    });
  }

  const snapshot = generateReportSnapshot(COMPANIES);
  const report = {
    id: `report-${weekLabel}`,
    week_label: weekLabel,
    generated_at: now.toISOString(),
    companies: snapshot,
  };

  dbSaveReport(report);

  res.status(201).json({ report_id: report.id, week_label: weekLabel, company_count: snapshot.length });
});

// --- Search and Add Companies ---

app.get("/api/search", (req, res) => {
  const { q, industry, segment, min_turnover, max_turnover } = req.query;
  const COMPANIES = loadCompanies();
  let results = COMPANIES;

  if (q) {
    const lower = q.toLowerCase();
    results = results.filter(
      (c) => c.name.toLowerCase().includes(lower) || c.industry.toLowerCase().includes(lower) || c.id.toLowerCase().includes(lower)
    );
  }
  if (industry) {
    results = results.filter((c) => c.industry.toLowerCase().includes(industry.toLowerCase()));
  }
  if (segment) {
    results = results.filter((c) => c.segment === segment);
  }
  if (min_turnover) {
    results = results.filter((c) => c.turnover >= Number(min_turnover));
  }
  if (max_turnover) {
    results = results.filter((c) => c.turnover <= Number(max_turnover));
  }

  const mapped = results.map((c) => {
    const profile = computeCompanyProfile(c);
    const ws = getCompanyState(c.id);
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      segment: c.segment,
      turnover: c.turnover,
      employee_count: c.employee_count,
      combined_score: profile.combined_score,
      motion_count: profile.eligible_motion_count,
      workflow_state: ws.state,
    };
  });

  res.json({ results: mapped, total: mapped.length });
});

app.post("/api/companies", (req, res) => {
  const { name, company_number, industry, segment, turnover, employee_count, motions, product_fit } = req.body;

  if (!name || !industry) {
    return res.status(400).json({ error: "name and industry are required" });
  }

  const COMPANIES = loadCompanies();
  const id = `c${Date.now()}`;
  const newCompany = {
    id,
    name,
    company_number: company_number || "",
    industry,
    segment: segment || "Mid-Market",
    turnover: turnover || 0,
    employee_count: employee_count || 0,
    latest_annual_report_url: "",
    motions: motions || [],
    product_fit: product_fit || {},
    competitors: [],
    stakeholders: [],
    cadence_history: [],
    response_propensity: { score: 0.5, warmth: "cool", signals: ["Newly added — no engagement data yet"] },
  };

  COMPANIES.push(newCompany);
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  res.status(201).json({ company: newCompany });
});

app.get("/api/industries", (_req, res) => {
  const COMPANIES = loadCompanies();
  const industries = [...new Set(COMPANIES.map((c) => c.industry))].sort();
  res.json({ industries });
});

// --- Companies House Integration ---

app.get("/api/companies-house/status", (_req, res) => {
  res.json({
    configured: isCompaniesHouseConfigured(),
    bulk_data: getBulkDownloadInfo(),
  });
});

app.get("/api/companies-house/lookup/:number", async (req, res) => {
  const { number } = req.params;
  try {
    const data = await lookupCompany(number);
    if (data.error) return res.status(data.status || 500).json(data);
    res.json({ company: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/import/csv", (req, res) => {
  const { csv_content, filename } = req.body;
  if (!csv_content) return res.status(400).json({ error: "csv_content is required" });

  const companyNumbers = parseCompanyNumbersCSV(csv_content);
  if (companyNumbers.length === 0) {
    return res.status(400).json({ error: "No valid company numbers found in CSV" });
  }

  const jobId = `csv-${Date.now()}`;
  createImportJob(jobId, "csv", companyNumbers.length, { filename: filename || "upload.csv" });

  processCSVImport(jobId, companyNumbers);

  res.status(202).json({
    job_id: jobId,
    company_numbers_found: companyNumbers.length,
    status: "processing",
    message: `Found ${companyNumbers.length} company numbers. Processing in background.`,
  });
});

async function processCSVImport(jobId, companyNumbers) {
  let imported = 0, skipped = 0, errors = 0;
  const COMPANIES = loadCompanies();
  const existingNumbers = new Set(COMPANIES.map((c) => c.company_number));

  for (let i = 0; i < companyNumbers.length; i++) {
    const num = companyNumbers[i];

    if (existingNumbers.has(num)) {
      addImportLogEntry(jobId, num, null, "skipped", "Already exists in universe");
      skipped++;
      updateImportJob(jobId, { processed_items: i + 1, imported_items: imported, skipped_items: skipped, error_count: errors });
      continue;
    }

    try {
      const chData = await lookupCompany(num);
      if (chData.error) {
        addImportLogEntry(jobId, num, null, "error", chData.message);
        errors++;
      } else if (chData.status === "dissolved" || chData.status === "liquidation") {
        addImportLogEntry(jobId, num, chData.name, "skipped", `Status: ${chData.status} (non-trading)`);
        skipped++;
      } else {
        const newCompany = {
          id: `ch-${num}`,
          name: chData.name || `Company ${num}`,
          company_number: num,
          industry: chData.industry_hint || mapSICToIndustry(chData.sic_codes),
          segment: guessTurnoverSegment(chData.turnover_hint),
          turnover: chData.turnover_hint || 0,
          employee_count: chData.employee_hint || 0,
          latest_annual_report_url: `https://find-and-update.company-information.service.gov.uk/company/${num}/filing-history`,
          motions: [],
          product_fit: {},
          competitors: [],
          stakeholders: [],
          cadence_history: [],
          response_propensity: { score: 0.3, warmth: "cold", signals: ["Imported from CSV — no engagement data"] },
          source: chData.source,
          imported_at: new Date().toISOString(),
        };

        COMPANIES.push(newCompany);
        existingNumbers.add(num);
        addImportLogEntry(jobId, num, newCompany.name, "imported", `Added as ${newCompany.segment}`, newCompany.turnover);
        imported++;
      }
    } catch (err) {
      addImportLogEntry(jobId, num, null, "error", err.message);
      errors++;
    }

    updateImportJob(jobId, { processed_items: i + 1, imported_items: imported, skipped_items: skipped, error_count: errors });

    if (isCompaniesHouseConfigured()) await new Promise((r) => setTimeout(r, 500));
  }

  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  updateImportJob(jobId, {
    status: "completed",
    completed_at: new Date().toISOString(),
    processed_items: companyNumbers.length,
    imported_items: imported,
    skipped_items: skipped,
    error_count: errors,
  });
}

function mapSICToIndustry(sicCodes) {
  if (!sicCodes || sicCodes.length === 0) return "Unknown";
  const code = sicCodes[0];
  const prefix = parseInt(code.substring(0, 2));
  if (prefix <= 3) return "Agriculture";
  if (prefix <= 9) return "Mining";
  if (prefix <= 33) return "Manufacturing";
  if (prefix <= 35) return "Energy";
  if (prefix <= 39) return "Utilities";
  if (prefix <= 43) return "Construction";
  if (prefix <= 47) return "Retail";
  if (prefix <= 53) return "Logistics";
  if (prefix <= 56) return "Hospitality";
  if (prefix <= 63) return "Technology";
  if (prefix <= 66) return "Financial Services";
  if (prefix <= 68) return "Real Estate";
  if (prefix <= 75) return "Professional Services";
  if (prefix <= 82) return "Business Services";
  if (prefix <= 84) return "Public Administration";
  if (prefix <= 85) return "Education";
  if (prefix <= 88) return "Healthcare";
  if (prefix <= 93) return "Entertainment";
  return "Other Services";
}

function guessTurnoverSegment(turnover) {
  if (!turnover) return "Mid-Market";
  if (turnover >= 250_000_000) return "Enterprise";
  if (turnover >= 10_000_000) return "Mid-Market";
  return "SMB";
}

app.get("/api/import/jobs", (_req, res) => {
  res.json({ jobs: listImportJobs() });
});

app.get("/api/import/jobs/:id", (req, res) => {
  const job = getImportJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const logs = getImportLogs(req.params.id, 200);
  res.json({ job, logs });
});

app.post("/api/admin/reset-demo-data", (_req, res) => {
  try {
    stopAutoPull();
    resetDemoState();

    const companies = loadCompanies();
    let removedImported = 0;
    const retainedCompanies = companies.filter((company) => {
      const isImported =
        ["csv", "bulk_zip", "auto_pull"].includes(company.source) ||
        (typeof company.id === "string" && company.id.startsWith("ch-"));
      if (isImported) removedImported++;
      return !isImported;
    });
    saveCompanies(retainedCompanies);

    const processedFile = path.join(process.cwd(), "mock-backend", "data", "processed_zips.json");
    if (fs.existsSync(processedFile)) {
      fs.writeFileSync(processedFile, JSON.stringify({}, null, 2));
    }

    res.json({
      message: "Demo data reset completed.",
      removed_imported_companies: removedImported,
      remaining_companies: retainedCompanies.length,
      processed_zip_cache_cleared: true,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset demo data", detail: err.message });
  }
});

// --- Bulk ZIP Processing ---

app.get("/api/import/bulk/monthly", async (req, res) => {
  const months = parseInt(req.query.months) || 24;
  const files = await getMonthlyZipURLs(months);
  res.json({ files });
});

app.get("/api/import/bulk/daily", async (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const files = await getDailyZipURLs(days);
  res.json({ files });
});

app.post("/api/import/bulk/process", async (req, res) => {
  const { url, filename } = req.body;
  if (!url || !filename) return res.status(400).json({ error: "url and filename required" });

  const jobId = `bulk-${Date.now()}`;
  createImportJob(jobId, "bulk_zip", 0, { filename, url });

  res.status(202).json({ job_id: jobId, status: "processing", filename });

  try {
    const result = await processAccountsZip(url, filename, (progress) => {
      updateImportJob(jobId, {
        status: "running",
        metadata: JSON.stringify({ ...progress }),
      });
    });

    if (result.error) {
      updateImportJob(jobId, {
        status: "failed",
        completed_at: new Date().toISOString(),
        metadata: JSON.stringify({ error: result.message, stage: result.stage }),
      });
      addImportLogEntry(jobId, null, null, "error", `${result.stage}: ${result.message}`);
      return;
    }

    if (result.skipped) {
      updateImportJob(jobId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        metadata: JSON.stringify({ skipped: true, reason: result.reason }),
      });
      return;
    }

    const COMPANIES = loadCompanies();
    const existingNumbers = new Set(COMPANIES.map((c) => c.company_number));
    let imported = 0;

    for (const co of result.companies) {
      if (existingNumbers.has(co.company_number)) {
        addImportLogEntry(jobId, co.company_number, null, "skipped", "Already in universe", co.turnover);
        continue;
      }

      const newCompany = {
        id: `ch-${co.company_number}`,
        name: `Company ${co.company_number}`,
        company_number: co.company_number,
        industry: "Unknown",
        segment: guessTurnoverSegment(co.turnover),
        turnover: co.turnover,
        employee_count: 0,
        latest_annual_report_url: `https://find-and-update.company-information.service.gov.uk/company/${co.company_number}/filing-history`,
        motions: [],
        product_fit: {},
        competitors: [],
        stakeholders: [],
        cadence_history: [],
        response_propensity: { score: 0.2, warmth: "cold", signals: ["Imported from bulk accounts data"] },
        source: "bulk_zip",
        source_file: co.source_file,
        imported_at: new Date().toISOString(),
      };

      COMPANIES.push(newCompany);
      existingNumbers.add(co.company_number);
      addImportLogEntry(jobId, co.company_number, newCompany.name, "imported", `£${(co.turnover / 1e6).toFixed(1)}M turnover from ${filename}`, co.turnover);
      imported++;
    }

    const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
    fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

    updateImportJob(jobId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      total_items: result.stats.total_files,
      processed_items: result.stats.total_files,
      imported_items: imported,
      skipped_items: result.stats.below_threshold + (result.companies.length - imported),
      error_count: result.stats.parse_errors,
    });
  } catch (err) {
    updateImportJob(jobId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      metadata: JSON.stringify({ error: err.message }),
    });
  }
});

// --- Auto-pull Schedule ---

app.get("/api/import/autopull/status", (_req, res) => {
  res.json(getAutoPullStatus());
});

app.post("/api/import/autopull/start", (_req, res) => {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const status = startAutoPull(TWELVE_HOURS, async (companies) => {
    const COMPANIES = loadCompanies();
    const existingNumbers = new Set(COMPANIES.map((c) => c.company_number));
    for (const co of companies) {
      if (existingNumbers.has(co.company_number)) continue;
      COMPANIES.push({
        id: `ch-${co.company_number}`,
        name: `Company ${co.company_number}`,
        company_number: co.company_number,
        industry: "Unknown",
        segment: guessTurnoverSegment(co.turnover),
        turnover: co.turnover,
        employee_count: 0,
        latest_annual_report_url: `https://find-and-update.company-information.service.gov.uk/company/${co.company_number}/filing-history`,
        motions: [],
        product_fit: {},
        competitors: [],
        stakeholders: [],
        cadence_history: [],
        response_propensity: { score: 0.2, warmth: "cold", signals: ["Auto-imported from daily accounts data"] },
        source: "auto_pull",
        imported_at: new Date().toISOString(),
      });
      existingNumbers.add(co.company_number);
    }
    const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
    fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));
  });
  res.json({ message: "Auto-pull started (every 12 hours)", ...status });
});

app.post("/api/import/autopull/stop", (_req, res) => {
  const status = stopAutoPull();
  res.json({ message: "Auto-pull stopped", ...status });
});

// --- LLM Evidence Extraction ---

import { extractEvidence, isLLMConfigured } from "./llm.js";

app.get("/api/llm/status", (_req, res) => {
  res.json({ configured: isLLMConfigured(), model: process.env.OPENAI_MODEL || "gpt-4o-mini" });
});

app.post("/api/llm/extract", async (req, res) => {
  const { company_id, product_motion } = req.body;
  if (!company_id) {
    return res.status(400).json({ error: "Missing company_id" });
  }

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === company_id);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }

  const motion = product_motion || company.motions?.[0] || "FX";

  try {
    const evidence = await extractEvidence(company, motion);
    res.json({ company_id, product_motion: motion, evidence });
  } catch (err) {
    res.status(500).json({ error: "Evidence extraction failed", detail: err.message });
  }
});

// --- Export ---

app.get("/api/export/shortlist", (req, res) => {
  const { format } = req.query;
  const COMPANIES = loadCompanies();

  const entries = COMPANIES
    .filter((c) => {
      const excl = isExcluded(c);
      if (excl.excluded) return false;
      const supp = isSuppressed(c.id);
      if (supp.suppressed) return false;
      return true;
    })
    .map((c) => {
      const profile = computeCompanyProfile(c);
      if (profile.eligible_motion_count === 0) return null;
      const ws = getCompanyState(c.id);
      return {
        rank: 0,
        name: c.name,
        company_number: c.company_number,
        industry: c.industry,
        segment: profile.segment,
        turnover: c.turnover,
        employee_count: c.employee_count,
        combined_score: profile.combined_score,
        best_motion: profile.best_motion?.motion || "",
        best_score: profile.best_motion?.score || 0,
        eligible_motions: profile.motion_scores.map((m) => m.motion).join("; "),
        motion_count: profile.eligible_motion_count,
        workflow_state: ws.state,
        propensity_warmth: profile.propensity.warmth,
        propensity_score: profile.propensity.score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.combined_score - a.combined_score)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  if (format === "csv") {
    const headers = Object.keys(entries[0] || {});
    const csvLines = [headers.join(",")];
    for (const row of entries) {
      csvLines.push(headers.map((h) => {
        const val = String(row[h] ?? "");
        return val.includes(",") || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="shortlist-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvLines.join("\n"));
  } else {
    res.json({ companies: entries, exported_at: new Date().toISOString() });
  }
});

app.get("/api/export/report/:id", (req, res) => {
  const { id } = req.params;
  const { format } = req.query;
  const report = dbGetReport(id);
  if (!report) return res.status(404).json({ error: "Report not found" });

  const companies = report.companies.map((c) => {
    const ws = getCompanyState(c.company_id);
    return {
      ...c,
      current_workflow_state: ws.state,
      state_changed: c.workflow_state_at_generation !== ws.state,
    };
  });

  if (format === "csv") {
    const headers = ["rank", "name", "company_number", "industry", "turnover", "best_motion", "score", "fit_level", "status_then", "status_now", "state_changed"];
    const csvLines = [headers.join(",")];
    companies.forEach((c, i) => {
      csvLines.push([
        i + 1, `"${c.name}"`, c.company_id, `"${c.industry}"`, c.turnover,
        `"${c.best_motion}"`, c.score, c.fit_level,
        c.workflow_state_at_generation, c.current_workflow_state,
        c.state_changed,
      ].join(","));
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="report-${report.week_label}.csv"`);
    res.send(csvLines.join("\n"));
  } else {
    res.json({ report: { ...report, companies }, exported_at: new Date().toISOString() });
  }
});

// --- Company Notes ---

app.get("/api/company/:id/notes", (req, res) => {
  const { id } = req.params;
  const notes = getSetting(`notes_${id}`, "");
  res.json({ company_id: id, notes });
});

app.put("/api/company/:id/notes", (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;
  if (notes === undefined) return res.status(400).json({ error: "notes field required" });
  setSetting(`notes_${id}`, notes);
  res.json({ company_id: id, notes, saved_at: new Date().toISOString() });
});

// --- Cadence, Stakeholder, Competitor CRUD ---

app.post("/api/company/:id/cadence", (req, res) => {
  const { id } = req.params;
  const { date, type, summary, outcome } = req.body;
  if (!date || !type || !summary) {
    return res.status(400).json({ error: "date, type, and summary are required" });
  }
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) return res.status(404).json({ error: "Company not found" });

  const entry = { date, type, summary, outcome: outcome || null };
  if (!company.cadence_history) company.cadence_history = [];
  company.cadence_history.push(entry);

  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  res.status(201).json({ entry, total: company.cadence_history.length });
});

app.post("/api/company/:id/stakeholders", (req, res) => {
  const { id } = req.params;
  const { name, role, email, linkedin, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) return res.status(404).json({ error: "Company not found" });

  const stakeholder = { name, role: role || "", email: email || "", linkedin: linkedin || "", notes: notes || "" };
  if (!company.stakeholders) company.stakeholders = [];
  company.stakeholders.push(stakeholder);

  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  res.status(201).json({ stakeholder, total: company.stakeholders.length });
});

app.delete("/api/company/:id/stakeholders/:idx", (req, res) => {
  const { id, idx } = req.params;
  const index = parseInt(idx);

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) return res.status(404).json({ error: "Company not found" });
  if (!company.stakeholders || index < 0 || index >= company.stakeholders.length) {
    return res.status(404).json({ error: "Stakeholder not found" });
  }

  company.stakeholders.splice(index, 1);
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  res.json({ deleted: true, remaining: company.stakeholders.length });
});

app.post("/api/company/:id/competitors", (req, res) => {
  const { id } = req.params;
  const { name, product, strength, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) return res.status(404).json({ error: "Company not found" });

  const competitor = { name, product: product || "", strength: strength || "medium", notes: notes || "" };
  if (!company.competitors) company.competitors = [];
  company.competitors.push(competitor);

  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  res.status(201).json({ competitor, total: company.competitors.length });
});

app.delete("/api/company/:id/competitors/:idx", (req, res) => {
  const { id, idx } = req.params;
  const index = parseInt(idx);

  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) return res.status(404).json({ error: "Company not found" });
  if (!company.competitors || index < 0 || index >= company.competitors.length) {
    return res.status(404).json({ error: "Competitor not found" });
  }

  company.competitors.splice(index, 1);
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  fs.writeFileSync(filePath, JSON.stringify(COMPANIES, null, 2));

  res.json({ deleted: true, remaining: company.competitors.length });
});

// --- Serve frontend in production ---

const frontendDist = path.join(process.cwd(), "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  console.log("Serving frontend from", frontendDist);
}

// --- Weekly Report Auto-Generation (Sunday evenings) ---

let reportScheduleTimer = null;

function getNextSundayEvening() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilSunday);
  next.setHours(20, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

function scheduleWeeklyReport() {
  const nextRun = getNextSundayEvening();
  const delay = nextRun.getTime() - Date.now();

  console.log(`Weekly report scheduled for: ${nextRun.toISOString()} (in ${Math.round(delay / 3600000)}h)`);

  reportScheduleTimer = setTimeout(() => {
    generateAndSaveWeeklyReport();
    scheduleWeeklyReport();
  }, delay);
}

function generateAndSaveWeeklyReport() {
  try {
    const COMPANIES = loadCompanies();
    const now = new Date();
    const weekLabel = getWeekLabel(now);

    const existing = getReportByWeek(weekLabel);
    if (existing) {
      console.log(`Weekly report for ${weekLabel} already exists, skipping.`);
      return;
    }

    const snapshot = generateReportSnapshot(COMPANIES);
    const report = {
      id: `report-${weekLabel}`,
      week_label: weekLabel,
      generated_at: now.toISOString(),
      companies: snapshot,
    };

    dbSaveReport(report);
    console.log(`Weekly report generated: ${report.id} (${snapshot.length} companies)`);
  } catch (err) {
    console.error("Failed to auto-generate weekly report:", err.message);
  }
}


app.listen(PORT, () => {
  console.log(`Onemonetry running on http://localhost:${PORT}`);
  console.log(`LLM: ${isLLMConfigured() ? "configured" : "mock mode (set OPENAI_API_KEY to enable)"}`);
  scheduleWeeklyReport();
});
