import express from "express";
import { createMonitoringWorkspace, monitoringCompanyNumber, monitoringReadiness } from "./monitoring-workspace.js";

export function createMonitoringRouter({ env = process.env, workspace = createMonitoringWorkspace({ env }), localContext, addToResearch, addToShortlist, authenticateReviewer }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.method === "POST") {
      if (!req.is("application/json")) return res.status(415).json({ error: "json_required" });
      if (req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ error: "cross_site_write_denied" });
    }
    next();
  });
  const handle = handler => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { await handler(req, res); } catch (error) {
      res.status(error.status || 502).json({ error: error.code || "monitoring_request_failed" });
    }
  };
  router.get("/status", handle(async (req, res) => {
    res.json({ configured: workspace.configured, review_enabled: Boolean(authenticateReviewer(req)), turnover_floor_gbp: 30000000 });
  }));
  router.get("/", handle(async (req, res) => {
    const result = await workspace.read(req.query);
    res.json({ ...result, rows: result.rows.map(row => ({ ...row,
      workspace: monitoringReadiness(row, { ...localContext(row.company_number || row.selected_company_number),
        ...(req.query.view === "closed_won" ? { suppressed: true, reason: "Past-customer record requires CRM review" } : {}),
      }),
    })), review_enabled: Boolean(authenticateReviewer(req)) });
  }));
  router.post("/reviews", handle(async (req, res) => {
    const actor = authenticateReviewer(req);
    if (!actor) return res.status(403).json({ error: "monitoring_review_requires_owner_session" });
    if (!req.is("application/json")) return res.status(415).json({ error: "json_required" });
    res.json(await workspace.review(req.body || {}, actor));
  }));
  router.post("/companies/:number/research", handle(async (req, res) => {
    const number = monitoringCompanyNumber(req.params.number);
    // Read identity and facts from the source; never accept browser-supplied turnover or approval.
    const company = await workspace.getCompany(number);
    const result = await addToResearch(company);
    res.json({ ...result, company_number: number, outreach_approved: false });
  }));
  router.post("/companies/:number/shortlist", handle(async (req, res) => {
    res.json(await addToShortlist(monitoringCompanyNumber(req.params.number)));
  }));
  return router;
}
