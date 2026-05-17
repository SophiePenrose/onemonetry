import express from "express";
import fs from "fs";
import path from "path";

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

const EXCLUSIONS_FILE = path.join(process.cwd(), "mock-backend", "exclusions.json");

function loadExclusions() {
  try {
    return JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, "utf-8"));
  } catch {
    return {
      prohibited_industries: ["Gambling", "Tobacco", "Weapons", "Adult Entertainment"],
      excluded_company_ids: [],
    };
  }
}

function saveExclusions(exclusions) {
  fs.writeFileSync(EXCLUSIONS_FILE, JSON.stringify(exclusions, null, 2));
}

function isExcluded(company) {
  const exclusions = loadExclusions();
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

// --- Scoring weights (configurable) ---

const LAYER_NAMES = ["product_fit", "commercial_value", "pain_strength", "urgency", "competitor_context"];

const DEFAULT_WEIGHTS = {
  product_fit: 0.35,
  commercial_value: 0.20,
  pain_strength: 0.20,
  urgency: 0.15,
  competitor_context: 0.10,
};

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

// --- State persistence ---

const STATE_FILE = path.join(process.cwd(), "mock-backend", "workflow_state.json");

function loadWorkflowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveWorkflowState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let workflowState = loadWorkflowState();

function getCompanyState(companyId) {
  return workflowState[companyId] || {
    state: "new_candidate",
    history: [{ state: "new_candidate", timestamp: new Date().toISOString(), note: "Initial state" }],
  };
}

// --- Report persistence ---

const REPORTS_FILE = path.join(process.cwd(), "mock-backend", "weekly_reports.json");

function loadReports() {
  try {
    return JSON.parse(fs.readFileSync(REPORTS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveReports(reports) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}

// --- Data loading ---

function loadCompanies() {
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// --- Routes ---

app.get("/api/motions", (_req, res) => {
  res.json({ motions: VALID_MOTIONS });
});

app.get("/api/workflow-states", (_req, res) => {
  res.json({ states: WORKFLOW_STATES, transitions: ALLOWED_TRANSITIONS });
});

app.get("/api/scoring-weights", (_req, res) => {
  res.json({ weights: DEFAULT_WEIGHTS, layers: LAYER_NAMES });
});

app.get("/api/exclusions", (_req, res) => {
  const exclusions = loadExclusions();
  res.json({ exclusions, suppressed_states: SUPPRESSED_STATES });
});

app.put("/api/exclusions", (req, res) => {
  const { prohibited_industries, excluded_company_ids } = req.body;
  const current = loadExclusions();
  const updated = {
    prohibited_industries: prohibited_industries ?? current.prohibited_industries,
    excluded_company_ids: excluded_company_ids ?? current.excluded_company_ids,
  };
  saveExclusions(updated);
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
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find((c) => c.id === id);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }
  const fit = company.product_fit[product_motion];
  if (!fit || !fit.eligible) {
    return res.status(403).json({ error: "Company does not meet current shortlist criteria" });
  }
  const layers = fit.layers || {};
  const compositeScore = computeCompositeScore(layers);
  const ws = getCompanyState(id);
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
    },
  });
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

  const historyEntry = {
    from: current.state,
    to: new_state,
    timestamp: new Date().toISOString(),
    note: note || null,
  };

  workflowState[id] = {
    state: new_state,
    history: [...(current.history || []), historyEntry],
  };

  saveWorkflowState(workflowState);

  res.json({
    company_id: id,
    previous_state: current.state,
    new_state,
    allowed_transitions: ALLOWED_TRANSITIONS[new_state],
    history: workflowState[id].history,
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

app.get("/api/reports", (_req, res) => {
  const reports = loadReports();
  const summary = reports.map((r) => ({
    id: r.id,
    week_label: r.week_label,
    generated_at: r.generated_at,
    company_count: r.companies.length,
    top_company: r.companies[0]?.name || null,
    top_score: r.companies[0]?.score || null,
  }));
  summary.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  res.json({ reports: summary });
});

app.get("/api/reports/:id", (req, res) => {
  const { id } = req.params;
  const reports = loadReports();
  const report = reports.find((r) => r.id === id);
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
  const reports = loadReports();
  const now = new Date();
  const weekLabel = getWeekLabel(now);

  const existing = reports.find((r) => r.week_label === weekLabel);
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
    company_count: snapshot.length,
    companies: snapshot,
  };

  reports.push(report);
  saveReports(reports);

  res.status(201).json({ report_id: report.id, week_label: weekLabel, company_count: snapshot.length });
});

app.listen(PORT, () => {
  console.log(`Mock backend running on http://localhost:${PORT}`);
});
