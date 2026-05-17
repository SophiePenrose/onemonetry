

import express from "express";
import fs from "fs";
import path from "path";

const app = express();
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

function loadCompanies() {
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

app.get("/api/motions", (_req, res) => {
  res.json({ motions: VALID_MOTIONS });
});

app.get("/api/shortlist", (req, res) => {
  const { product_motion } = req.query;
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  const eligible = COMPANIES
    .filter(c => c.motions.includes(product_motion) && c.product_fit[product_motion]?.eligible)
    .sort((a, b) => b.product_fit[product_motion].score_contribution - a.product_fit[product_motion].score_contribution)
    .map((c, idx) => ({
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
    }));
  res.json({ companies: eligible });
});

app.get("/api/company/:id", (req, res) => {
  const { id } = req.params;
  const { product_motion } = req.query;
  if (!product_motion || !VALID_MOTIONS.includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  const company = COMPANIES.find(c => c.id === id);
  if (!company) {
    return res.status(404).json({ error: "Company not found" });
  }
  const fit = company.product_fit[product_motion];
  if (!fit || !fit.eligible) {
    return res.status(403).json({ error: "Company does not meet current shortlist criteria" });
  }
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
    },
  });
});

app.listen(PORT, () => {
  console.log(`Mock backend running on http://localhost:${PORT}`);
});
