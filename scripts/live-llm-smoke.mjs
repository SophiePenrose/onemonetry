const base = "http://127.0.0.1:8000";

async function request(path, options = null) {
  const response = await fetch(`${base}${path}`, options || undefined);
  const payload = await response.json();
  return { status: response.status, payload };
}

async function main() {
  const shortlist = await request("/api/unified-shortlist?turnover_band=all&sort_by=priority_score&sort_dir=desc");
  const companies = Array.isArray(shortlist.payload?.companies) ? shortlist.payload.companies : [];
  if (shortlist.status !== 200 || companies.length === 0) {
    console.log("SHORTLIST_STATUS", shortlist.status);
    console.log("NO_COMPANY");
    return;
  }

  const companyId = companies[0].id;
  const generated = await request("/api/email/generate-advanced", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_id: companyId,
      stakeholder_name: "Alex Morgan",
      stakeholder_role: "Finance Director",
      force: true,
      use_style_profile: true,
    }),
  });

  console.log("STATUS", generated.status);
  if (generated.status !== 200) {
    console.log("ERROR", generated.payload?.error || "unknown");
    console.log("RETRY_NEEDED", generated.payload?.retry_needed ?? null);
    console.log("REASON", generated.payload?.reason || null);
    console.log("DETAIL", generated.payload?.detail || null);
    console.log("SOURCE", generated.payload?.source || null);
    return;
  }

  const step1 = Array.isArray(generated.payload?.steps) ? generated.payload.steps[0] || {} : {};
  console.log("STEP1_SOURCE", step1.source || null);
  console.log("STEP1_MODEL", step1.model || null);
  console.log("STEP1_QC", step1.qc_score || null);
}

main().catch((error) => {
  console.error("SMOKE_ERROR", error?.message || error);
  if (error?.cause) {
    console.error("SMOKE_CAUSE", error.cause.code || error.cause.message || error.cause);
  }
  process.exitCode = 1;
});
