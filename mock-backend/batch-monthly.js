import { getMonthlyZipURLs } from "./bulk-processor.js";
import { processZipInChunks, getTurnoverThreshold } from "./stream-processor.js";
import { getFilingCount, getMonitoredCompanyCount } from "./db.js";
import fs from "fs";

const START_PERIOD = process.argv[2] || "2024-05";
const END_PERIOD = process.argv[3] || "2026-04";

async function run() {
  console.log(`\n=== Monthly Batch Processor ===`);
  console.log(`Period: ${START_PERIOD} to ${END_PERIOD}`);
  console.log(`Threshold: £${(getTurnoverThreshold() / 1e6).toFixed(0)}M`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const allFiles = await getMonthlyZipURLs();
  const target = allFiles
    .filter((f) => f.period >= START_PERIOD && f.period <= END_PERIOD && !f.processed)
    .sort((a, b) => a.period.localeCompare(b.period));

  console.log(`Files to process: ${target.length} of ${allFiles.filter((f) => f.period >= START_PERIOD && f.period <= END_PERIOD).length}`);
  console.log();

  let totalQualifying = 0;
  let totalProcessed = 0;
  let failures = 0;

  for (let i = 0; i < target.length; i++) {
    const file = target[i];
    const startTime = Date.now();
    console.log(`[${i + 1}/${target.length}] ${file.filename} (${file.period})`);
    console.log(`  URL: ${file.url}`);

    try {
      const result = await processZipInChunks(file.url, file.filename, `monthly:${file.period}`, {
        onDownloadProgress: (p) => {
          if (p.percent !== undefined && p.percent % 20 === 0) {
            process.stdout.write(`  Downloading: ${p.percent}% (${(p.downloaded / 1e6).toFixed(0)}MB / ${(p.totalSize / 1e6).toFixed(0)}MB)\r`);
          }
        },
        onProcessProgress: (p) => {
          if (p.percent !== undefined && p.percent % 10 === 0) {
            process.stdout.write(`  Processing: ${p.percent}% (${p.qualifying} qualifying so far)\r`);
          }
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  ✅ Done in ${elapsed}s: ${result.total_files} files, ${result.qualifying} qualifying (£30M-£200M), ${result.below_threshold} out of scope, ${result.no_turnover_data} no data`);
      totalQualifying += result.qualifying;
      totalProcessed++;
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  ❌ Failed after ${elapsed}s: ${err.message}`);
      failures++;
    }

    // Log running totals
    console.log(`  Running total: ${totalQualifying} qualifying companies, ${getFilingCount()} filings, ${getMonitoredCompanyCount()} monitored`);

    // Check disk space
    try {
      const stats = fs.statfsSync("/workspace");
      const freeGB = (stats.bfree * stats.bsize) / 1e9;
      if (freeGB < 5) {
        console.log(`  ⚠️  Low disk space: ${freeGB.toFixed(1)}GB free. Stopping.`);
        break;
      }
    } catch { /* ignore */ }

    console.log();
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Processed: ${totalProcessed} of ${target.length} files`);
  console.log(`Failures: ${failures}`);
  console.log(`Total qualifying companies: ${totalQualifying}`);
  console.log(`Total filings in DB: ${getFilingCount()}`);
  console.log(`Total monitored: ${getMonitoredCompanyCount()}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

run().catch((err) => {
  console.error("Batch processor failed:", err);
  process.exit(1);
});
