

import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 8000;

function loadCompanies() {
  const filePath = path.join(process.cwd(), "mock-backend", "companies.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

app.get("/api/shortlist", (req, res) => {
  const { product_motion } = req.query;
  if (!product_motion || !["FX", "Cards"].includes(product_motion)) {
    return res.status(400).json({ error: "Missing or invalid product_motion parameter" });
  }
  const COMPANIES = loadCompanies();
  const companies = COMPANIES.filter(c => c.motions.includes(product_motion) && c.product_fit[product_motion]?.eligible)
    .map((c, idx) => ({
      id: c.id,
      name: c.name,
      score: c.product_fit[product_motion].score_contribution,
      rank: idx + 1,
      product_motion,
      product_fit: c.product_fit[product_motion],
      explanation: c.product_fit[product_motion].explanation
    }));
  res.json({ companies });
});

app.get("/api/company/:id", (req, res) => {
  const { id } = req.params;
  const { product_motion } = req.query;
  if (!product_motion || !["FX", "Cards"].includes(product_motion)) {
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
      explanation: fit.explanation
    }
  });
});

app.listen(PORT, () => {
  console.log(`Mock backend running on http://localhost:${PORT}`);
});
