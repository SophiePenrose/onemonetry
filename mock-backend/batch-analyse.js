import { getMonitoredCompanies, getFilingsForCompany } from "./db.js";
import { analyseCompany, isLLMConfigured } from "./llm.js";
import { setSetting, getSetting } from "./db.js";

const BATCH_SIZE = parseInt(process.argv[2]) || 50;
const DELAY_MS = parseInt(process.argv[3]) || 2000;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  console.log(`\n=== Batch Company Analyser ===`);
  console.log(`LLM configured: ${isLLMConfigured()}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Delay between analyses: ${DELAY_MS}ms`);
  console.log();

  const companies = getMonitoredCompanies({ limit: BATCH_SIZE });
  const withFilings = companies.filter((c) => {
    const filings = getFilingsForCompany(c.company_number, 1);
    return filings.length > 0 && filings[0].raw_data;
  });

  console.log(`Companies with filing text: ${withFilings.length} of ${companies.length}`);
  console.log();

  let analysed = 0;
  let errors = 0;

  for (let i = 0; i < withFilings.length; i++) {
    const company = withFilings[i];
    const existing = getSetting(`analysis_${company.company_number}`, null);
    if (existing) {
      if (i < 3) console.log(`  ⏭  ${company.company_number} ${company.company_name} — already analysed`);
      continue;
    }

    try {
      const result = await analyseCompany(company.company_number, company.company_name, company.latest_turnover);
      setSetting(`analysis_${company.company_number}`, result);
      analysed++;

      console.log(`  ✅ ${company.company_number} ${company.company_name || "?"}`);
      if (result.summary) console.log(`     ${result.summary.substring(0, 100)}...`);
    } catch (err) {
      errors++;
      console.log(`  ❌ ${company.company_number}: ${err.message}`);
    }

    if (i > 0 && i % 10 === 0) {
      console.log(`  ... ${i}/${withFilings.length} (${analysed} analysed, ${errors} errors)`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n=== Done ===`);
  console.log(`Analysed: ${analysed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Skipped (already done): ${withFilings.length - analysed - errors}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
