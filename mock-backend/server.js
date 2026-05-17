import cors from "cors";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "companies.json");
const PRODUCT_FIT_GATE = 35;

function loadCompanies() {
  return JSON.parse(readFileSync(DATA_PATH, "utf8"));
}

function getSupportedMotions(companies) {
  return [
    ...new Set(companies.flatMap((company) => Object.keys(company.motions ?? {}))),
  ].sort();
}

function scoreCompany(company, productMotion) {
  const motion = company.motions?.[productMotion];

  if (!motion || motion.productFit < PRODUCT_FIT_GATE) {
    return null;
  }

  const scoreBreakdown = {
    productFit: motion.productFit,
    commercialValue: motion.commercialValue,
    timing: motion.timing,
    competitorContext: motion.competitorContext,
  };
  const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);

  return {
    id: company.id,
    name: company.name,
    companyNumber: company.companyNumber,
    industry: company.industry,
    turnover: company.turnover,
    employeeCount: company.employeeCount,
    workflowStatus: company.workflowStatus,
    annualReportUrl: company.annualReportUrl,
    productMotion,
    score,
    scoreBreakdown,
    summary: motion.summary,
    explanation: motion.explanation,
    evidence: motion.evidence,
  };
}

function buildShortlist(companies, productMotion, limit) {
  return companies
    .map((company) => scoreCompany(company, productMotion))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((company, index) => ({
      ...company,
      rank: index + 1,
    }));
}

export function createApp() {
  const app = express();

  app.use(cors());

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/shortlist", (request, response) => {
    const companies = loadCompanies();
    const supportedMotions = getSupportedMotions(companies);
    const productMotion = request.query.product_motion;
    const limit = Number.parseInt(request.query.limit ?? "100", 10);

    if (!supportedMotions.includes(productMotion)) {
      return response.status(400).json({
        error: "Unsupported product_motion",
        supportedMotions,
      });
    }

    if (!Number.isInteger(limit) || limit < 1) {
      return response.status(400).json({ error: "limit must be a positive integer" });
    }

    return response.json({
      productMotion,
      companies: buildShortlist(companies, productMotion, limit),
    });
  });

  app.get("/api/company/:id", (request, response) => {
    const companies = loadCompanies();
    const supportedMotions = getSupportedMotions(companies);
    const productMotion = request.query.product_motion;

    if (!supportedMotions.includes(productMotion)) {
      return response.status(400).json({
        error: "Unsupported product_motion",
        supportedMotions,
      });
    }

    const company = companies.find((item) => item.id === request.params.id);

    if (!company) {
      return response.status(404).json({ error: "Company not found" });
    }

    const scoredCompany = scoreCompany(company, productMotion);

    if (!scoredCompany) {
      return response.status(404).json({
        error: "Company is not shortlisted for this product motion",
      });
    }

    return response.json({ company: scoredCompany });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT ?? 8000;
  createApp().listen(port, () => {
    console.log(`Mock backend listening on http://localhost:${port}`);
  });
}
