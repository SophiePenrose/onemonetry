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
  const { product_motion, state_filter } = req.query;
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  let eligible = COMPANIES.filter(
    (c) => c.motions.includes(product_motion) && c.product_fit[product_motion]?.eligible
  );

  if (state_filter && VALID_STATE_IDS.includes(state_filter)) {
    eligible = eligible.filter((c) => getCompanyState(c.id).state === state_filter);
  }

  const companies = eligible
    .map((c) => {
      const fit = c.product_fit[product_motion];
      const layers = fit.layers || {};
      const compositeScore = computeCompositeScore(layers);
      const ws = getCompanyState(c.id);
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
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((c, idx) => ({ ...c, rank: idx + 1 }));

  res.json({ companies });
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

app.listen(PORT, () => {
  console.log(`Mock backend running on http://localhost:${PORT}`);
});
