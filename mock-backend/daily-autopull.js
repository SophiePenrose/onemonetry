import { getDailyZipURLs } from "./bulk-processor.js";
import { processZipInChunks } from "./stream-processor.js";
import { createImportJob, updateImportJob, addImportLogEntry, getFilingCount, getMonitoredCompanyCount } from "./db.js";

let autoPullTimer = null;
let autoPullStatus = {
  enabled: false,
  last_run: null,
  next_run: null,
  last_result: null,
  schedule: "Twice weekly (checks every 12 hours for new daily files from Companies House)",
};

const CHECK_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
const MONTHLY_CHECK_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getAutoPullStatus() {
  return {
    ...autoPullStatus,
    filings: getFilingCount(),
    monitored: getMonitoredCompanyCount(),
  };
}

export function startAutoPull() {
  if (autoPullTimer) clearInterval(autoPullTimer);

  autoPullStatus.enabled = true;
  autoPullStatus.next_run = new Date(Date.now() + CHECK_INTERVAL).toISOString();

  console.log(`[AutoPull] Started — checking every 12 hours for new daily files`);
  console.log(`[AutoPull] Monthly check also enabled — processes new monthly files when available`);

  autoPullTimer = setInterval(() => runAutoPullCycle(), CHECK_INTERVAL);

  // Run immediately on first start (daily only — monthly on schedule)
  setTimeout(() => runAutoPullCycle(), 5000);

  // Monthly check — run on the 5th of each month
  scheduleMonthlyCheck();

  return autoPullStatus;
}

function scheduleMonthlyCheck() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 5, 3, 0, 0);
  const delay = nextMonth.getTime() - Date.now();
  console.log(`[AutoPull] Monthly check scheduled for: ${nextMonth.toISOString()}`);

  setTimeout(async () => {
    console.log(`[AutoPull] Running monthly check...`);
    await runMonthlyCheck();
    scheduleMonthlyCheck();
  }, delay);
}

async function runMonthlyCheck() {
  try {
    const { getMonthlyZipURLs } = await import("./bulk-processor.js");
    const monthlyFiles = await getMonthlyZipURLs();
    const unprocessed = monthlyFiles.filter((f) => !f.processed && f.source === "current");

    if (unprocessed.length === 0) {
      console.log(`[AutoPull] No new monthly files to process`);
      return;
    }

    console.log(`[AutoPull] Found ${unprocessed.length} new monthly files`);
    for (const file of unprocessed) {
      console.log(`[AutoPull] Processing monthly: ${file.filename}`);
      try {
        const result = await processZipInChunks(file.url, file.filename, `monthly:${file.period}`, {});
        console.log(`[AutoPull] ✅ Monthly ${file.filename}: ${result.qualifying} qualifying from ${result.total_files} files`);
      } catch (err) {
        console.log(`[AutoPull] ❌ Monthly ${file.filename}: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`[AutoPull] Monthly check error: ${err.message}`);
  }
}

export function stopAutoPull() {
  if (autoPullTimer) { clearInterval(autoPullTimer); autoPullTimer = null; }
  autoPullStatus.enabled = false;
  autoPullStatus.next_run = null;
  console.log(`[AutoPull] Stopped`);
  return autoPullStatus;
}

async function runAutoPullCycle() {
  console.log(`[AutoPull] Checking for new daily files... (${new Date().toISOString()})`);
  autoPullStatus.last_run = new Date().toISOString();

  try {
    const dailyFiles = await getDailyZipURLs();
    const unprocessed = dailyFiles.filter((f) => !f.processed);

    if (unprocessed.length === 0) {
      console.log(`[AutoPull] No new files to process`);
      autoPullStatus.last_result = {
        message: "No new files",
        checked_at: new Date().toISOString(),
        files_checked: dailyFiles.length,
      };
      autoPullStatus.next_run = new Date(Date.now() + CHECK_INTERVAL).toISOString();
      return;
    }

    console.log(`[AutoPull] Found ${unprocessed.length} new daily files to process`);

    const results = [];
    for (const file of unprocessed) {
      const jobId = `autopull-${Date.now()}`;
      createImportJob(jobId, "daily_autopull", 0, { filename: file.filename, url: file.url });

      console.log(`[AutoPull] Processing: ${file.filename}`);

      try {
        const result = await processZipInChunks(file.url, file.filename, `daily:${file.date}`, {
          onProcessProgress: (p) => {
            updateImportJob(jobId, {
              status: "running",
              metadata: JSON.stringify({ stage: "processing", ...p }),
            });
          },
        });

        for (const co of result.companies) {
          addImportLogEntry(jobId, co.company_number, null, "imported",
            `£${(co.turnover / 1e6).toFixed(1)}M (${file.date})`, co.turnover);
        }

        updateImportJob(jobId, {
          status: "completed",
          completed_at: new Date().toISOString(),
          total_items: result.total_files,
          processed_items: result.processed,
          imported_items: result.qualifying,
          skipped_items: result.below_threshold,
          error_count: result.parse_errors,
        });

        console.log(`[AutoPull] ✅ ${file.filename}: ${result.qualifying} qualifying companies from ${result.total_files} files`);
        results.push({ filename: file.filename, qualifying: result.qualifying, total: result.total_files });
      } catch (err) {
        console.log(`[AutoPull] ❌ ${file.filename}: ${err.message}`);
        updateImportJob(jobId, {
          status: "failed",
          completed_at: new Date().toISOString(),
          metadata: JSON.stringify({ error: err.message }),
        });
        results.push({ filename: file.filename, error: err.message });
      }
    }

    autoPullStatus.last_result = {
      files_processed: results.length,
      results,
      checked_at: new Date().toISOString(),
      total_filings: getFilingCount(),
      total_monitored: getMonitoredCompanyCount(),
    };
  } catch (err) {
    console.log(`[AutoPull] Error: ${err.message}`);
    autoPullStatus.last_result = { error: err.message, checked_at: new Date().toISOString() };
  }

  autoPullStatus.next_run = new Date(Date.now() + CHECK_INTERVAL).toISOString();
}
