import {
  claimNextAnalysisJob,
  completeAnalysisJob,
  enqueueAnalysisJob,
  getAnalysisQueueStats,
  getFilingsForCompany,
  getMonitoredCompany,
  getSetting,
  resetProcessingAnalysisJobs,
  setSetting,
} from "./db.js";
import { analyseCompany } from "./llm.js";

let workerRunning = false;
let lastRun = null;
let lastCompleted = null;

export function queueCompanyAnalysis(companies, options = {}) {
  let added = 0;
  for (const company of companies || []) {
    const companyNumber = company.company_number || company.companyNumber;
    if (!companyNumber || getSetting(`analysis_${companyNumber}`, null)) continue;

    enqueueAnalysisJob({
      company_number: companyNumber,
      company_name: company.company_name || company.name || `Company ${companyNumber}`,
      turnover: company.turnover || company.latest_turnover || null,
      source: options.source || company.source || "import",
    });
    added++;
  }

  if (added > 0) runAnalysisQueue().catch((err) => {
    console.error("Analysis queue failed:", err.message);
  });
  return { queued: added, status: getAnalysisStatus() };
}

export async function runAnalysisQueue() {
  if (workerRunning) return;
  workerRunning = true;
  lastRun = new Date().toISOString();

  try {
    let job;
    while ((job = claimNextAnalysisJob())) {
      try {
        const filings = getFilingsForCompany(job.company_number, 1);
        if (!filings.some((f) => f.raw_data) || getSetting(`analysis_${job.company_number}`, null)) {
          completeAnalysisJob(job.company_number, "skipped");
          continue;
        }

        const monitored = getMonitoredCompany(job.company_number);
        const analysis = await analyseCompany(
          job.company_number,
          monitored?.company_name || job.company_name,
          monitored?.latest_turnover || job.turnover
        );
        setSetting(`analysis_${job.company_number}`, analysis);
        completeAnalysisJob(job.company_number, "completed");
      } catch (err) {
        completeAnalysisJob(job.company_number, "failed", err.message);
      }
    }
  } finally {
    workerRunning = false;
    lastCompleted = new Date().toISOString();
  }
}

export function resumeAnalysisQueue() {
  resetProcessingAnalysisJobs();
  runAnalysisQueue().catch((err) => {
    console.error("Analysis queue resume failed:", err.message);
  });
}

export function getAnalysisStatus() {
  const stats = getAnalysisQueueStats();
  return {
    running: workerRunning || stats.processing > 0,
    queued: stats.pending,
    processing: stats.processing,
    completed: stats.completed,
    skipped: stats.skipped,
    errors: stats.failed,
    current_company: stats.current_company,
    last_run: lastRun,
    last_completed: lastCompleted,
  };
}
