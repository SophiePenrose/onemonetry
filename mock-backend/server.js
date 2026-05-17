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

app.get("/api/shortlist", (req, res) => {
  const { product_motion, state_filter } = req.query;
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  let eligible = COMPANIES
    .filter((c) => c.motions.includes(product_motion) && c.product_fit[product_motion]?.eligible)
    .sort((a, b) => b.product_fit[product_motion].score_contribution - a.product_fit[product_motion].score_contribution);

  if (state_filter && VALID_STATE_IDS.includes(state_filter)) {
    eligible = eligible.filter((c) => getCompanyState(c.id).state === state_filter);
  }

  const companies = eligible.map((c, idx) => {
    const ws = getCompanyState(c.id);
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      turnover: c.turnover,
      score: c.product_fit[product_motion].score_contribution,
      rank: idx + 1,
      product_motion,
      fit_level: c.product_fit[product_motion].fit_level,
      product_fit: c.product_fit[product_motion],
      explanation: c.product_fit[product_motion].explanation,
      workflow_state: ws.state,
    };
  });
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
      score_breakdown: { product_fit: fit.score_contribution },
      final_score: fit.score_contribution,
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
