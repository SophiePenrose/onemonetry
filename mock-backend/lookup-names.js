import { getMonitoredCompanies, updateMonitorCheck } from "./db.js";
import { lookupCompany, isCompaniesHouseConfigured } from "./companies-house.js";

const BATCH_SIZE = parseInt(process.argv[2]) || 100;
const DELAY_MS = parseInt(process.argv[3]) || 600;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  if (!isCompaniesHouseConfigured()) {
    console.log("❌ Companies House API key not set. Cannot look up names.");
    console.log("Use COMPANIES_HOUSE_API_KEY (or CH_API_KEY). ");
    console.log("Set the environment variable and try again.");
    process.exit(1);
  }

  const companies = getMonitoredCompanies({ limit: BATCH_SIZE });
  const needsName = companies.filter((c) => !c.company_name || c.company_name.startsWith("Company "));

  console.log(`\n=== Company Name Lookup ===`);
  console.log(`Total monitored: ${companies.length}`);
  console.log(`Needs name lookup: ${needsName.length}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Delay: ${DELAY_MS}ms between requests`);
  console.log();

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < needsName.length; i++) {
    const company = needsName[i];
    try {
      const data = await lookupCompany(company.company_number);
      if (data.error) {
        errors++;
        if (i < 5) console.log(`  ❌ ${company.company_number}: ${data.message}`);
        continue;
      }

      const name = data.name || data.company_name;
      if (name) {
        updateMonitorCheck(company.company_number, { company_name: name });
        updated++;
        if (i < 20 || i % 50 === 0) {
          console.log(`  ✅ ${company.company_number} → ${name}`);
        }
      }

      if (data.status && ["dissolved", "liquidation", "converted-closed"].includes(data.status)) {
        updateMonitorCheck(company.company_number, { status: data.status });
        console.log(`  ⚠️  ${company.company_number} ${name}: marked ${data.status}`);
      }
    } catch (err) {
      errors++;
    }

    await sleep(DELAY_MS);

    if (i > 0 && i % 100 === 0) {
      console.log(`  ... ${i}/${needsName.length} checked (${updated} names found, ${errors} errors)`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Names updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log(`Remaining without names: ${needsName.length - updated - errors}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
