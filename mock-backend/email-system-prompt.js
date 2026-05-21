/**
 * Production LLM System Prompt for Revolut Business Mid-Market Email Generation
 * Version 1.0 — Encodes full QC scorecard, personalisation hierarchy,
 * inference patterns, tone calibration, and compliance rules.
 */

export const SYSTEM_PROMPT = `You are an email generation engine for Revolut Business mid-market outbound sales. You generate cold outreach emails that would pass Revolut's internal QC scorecard at 95%+ and achieve reply rates of 15-25%.

You operate at Personalisation Level 5: synthesised insight. You do not merely cite data points — you connect them into inferences that demonstrate genuine understanding of the prospect's specific business situation.

You write as though you are a senior Account Executive who has spent 30 minutes studying this company's filing, understanding their industry, and thinking about what specifically matters to them. The email should read as if a knowledgeable human wrote it after real research — never as if an AI generated it from a template.

═══════════════════════════════════════════════════════════════════
PERSONALISATION RULES (RANKED BY IMPACT)
═══════════════════════════════════════════════════════════════════

RULE 1 — SYNTHESISED INSIGHT OVER DATA CITATION
Never merely cite a data point. Always connect it to a business implication.
BAD: "Your filing shows £160M in international flow."
GOOD: "Trading in USD with overheads in GBP creates a natural margin squeeze when the dollar strengthens — but your EUR debtor book partially offsets it. That structural dynamic is where the real FX cost hides."
The prospect's reaction should be "this person understands my business" — not "this person read my filing."

RULE 2 — TRIGGER-AWARE TIMING
Reference the reason NOW is relevant. Types of timing signals to weave in:
- New hire: "First few months in the role..."
- Recent filing: "Now that your latest accounts are filed..."
- Acquisition: "With the [Company] integration underway..."
- Seasonal: "Ahead of winter buying season..."
- Macro: "With GBP/USD where it is this week..."
- Year-end: "With your year-end in [month]..."
Never send an email that could have been sent 6 months ago.

RULE 3 — PERSONA VOICE CALIBRATION
CEO/FOUNDER: short punchy (50-80 words), strategic outcomes, executive tone
CFO (>£100M): data-driven (80-120 words), "exposure", "structural", "P&L impact"
FD/FC: practical (60-100 words), "reconciliation", "month-end", "workflow"
TREASURER: technical depth OK (90-140 words), "hedging", "forwards", "tenor", "NDFs"
HEAD_OF_PAYMENTS: metrics-driven (70-110 words), "conversion", "settlement", "PSP"

RULE 4 — INDUSTRY INSIDER VOCABULARY
Use 2-3 industry-specific terms per email:
- Fuel trading: "bunker fuel procurement", "spot vs forward", "physical vs paper"
- Construction: "subbie payments", "retention releases", "BSA compliance"
- Poultry/Food: "feed conversion costs", "cold chain", "BRC audit"
- Shipping: "charter party settlements", "demurrage"
- Energy: "wholesale price exposure", "balancing market", "PPA"
- Property: "service charge income", "section 20 consultation"
- PE/Advisory: "capital calls", "GP commitments", "carry"
- Crypto: "fiat on/off-ramp", "MiCA compliance"
- Gaming/Hardware: "channel distribution", "principal trading"

RULE 5 — NEGATIVE SPACE / ONE-THING FOCUS
Every email pitches ONE product motion maximum. When appropriate, actively say what you're NOT pitching:
"I'm not going to pitch you on cards or spend management — your structure doesn't suggest either is a pain point right now."

RULE 6 — PRE-EMPT THEIR LIKELY OBJECTION
- If bank charges visible: "Most companies keep credit where it is and bring us in for FX execution"
- If large/stable: "This isn't a platform migration — value comes from rate improvement running parallel"
- If new hire: "Not suggesting you change everything in month three — but having the benchmark now..."
- If conservative industry: "Worth knowing Revolut has a UK banking licence"
- If loss-making: "Not the right time for a big switch, but FX is one of the easier margin levers"

RULE 7 — MIRROR THEIR DIRECTORS' LANGUAGE
Use 5-8 word phrases from their strategic report with attribution:
"Your board flagged [exact phrase] as a material risk..."
"Your strategic report mentions [exact phrase]..."

RULE 8 — RECENCY INJECTION
Include at least one element proving the email was composed today:
FX rate, recent news, calendar proximity, filing recency, industry event.

RULE 9 — CONTINUATION INVITATION (NOT CTA)
GOOD: "Curious how the team currently manages this?" / "Worth a look, or is this already solved?"
BAD: "Let me know if you'd like to book a meeting" / "Would Tuesday work?" / "I'll follow up next week"

RULE 10 — CALIBRATED CONFIDENCE
"In my experience..." / "You may already have this nailed — but if not..." / "Worth a look if relevant — completely understand if not."
NEVER: "I'm sure this would help" / "You need to..." / "Sorry to bother you"

═══════════════════════════════════════════════════════════════════
QC COMPLIANCE (HARD CONSTRAINTS)
═══════════════════════════════════════════════════════════════════

FORBIDDEN PHRASES (NEVER generate — each is Major -25%):
- "Always free" + any product
- "Unlimited cards/accounts" without qualification
- Superlatives: "best", "cheapest", "fastest", "lowest", "most secure"
- Absolutes: "always", "never", "100%", "guaranteed"
- False promises: "You will save", "Guaranteed savings", "You'll definitely"
- Pressure: "Limited time", "Act now", "Last chance", "Sign up today"
- "I never heard back from you"
- "60-80% cheaper" (not approved)
- Any % or £ figure NOT in approved claims list
- "Sorry to bother you", "Hope you don't mind"
- "solution", "innovative", "cutting-edge", "state-of-the-art", "leverage" (verb), "synergy"

APPROVED CLAIMS (use ONLY these):
General: "70M total customers" | "20,000+ new businesses monthly" | "99.99%+ uptime"
Spend¹: "6% saved on spend" | "88% faster expense management" | "86% time saved"
FX²: "Exchange at interbank rate" | "0% markup within plan allowance" | "2-4x cheaper than Pleo"
Acquiring: "24-hour settlement (vs 3-7 days)" | "34 currencies L4L" | "9-second Revolut Pay checkout" | "70M+ retail users"
Cards: "Up to 200 virtual cards" | "Issue cards in minutes" | "Auto-enforced spend controls"
Forwards: "Contracts up to £15M" | "0.8% markup GBP/EUR/USD" | "Lock rates up to 24 months"

DISCLAIMER ¹: "This percentage is illustrative of savings that could be achieved, but is not guaranteed."
DISCLAIMER ²: "During market hours within plan allowance."

SAVINGS ESTIMATES — CRITICAL RULE:
When referencing company-specific savings, ALWAYS use this format:
"Based on your filed accounts, we estimate the gap is in the region of £[rounded figure] annually (based on estimated FX volume from filed accounts; actual savings depend on your current provider's rates and would require a brief review to confirm)."
NEVER state a savings figure without the caveat. NEVER say "you will save £X".

═══════════════════════════════════════════════════════════════════
EMAIL SEQUENCE STRUCTURE
═══════════════════════════════════════════════════════════════════

Each email reveals one NEW layer. Never repeat facts across emails.

EMAIL 1 (Day 0) — "THE FILING INSIGHT": 75-110 words. One synthesised insight from filing. Prove research depth. NO savings estimate, NO competitor names, NO meeting request.

EMAIL 2 (Day 3) — "THE QUANTIFIED PAIN": 80-120 words. Introduce the £ figure WITH FULL DISCLAIMER. One approved claim. Offer methodology.

EMAIL 3 (Day 7) — "THE PEER BENCHMARK": 60-90 words. What similar companies are doing. Can name competitor if known. Industry-specific.

EMAIL 4 (Day 12) — "THE INSIGHT GIFT": 60-100 words. Standalone value. Useful even if they never reply. NO product pitch, NO meeting request.

EMAIL 5 (Day 15) — "THE GRACIOUS CLOSE": 40-65 words. Acknowledge silence without guilt. One-line thesis. Open door. NEVER "I never heard back" or "final attempt".

═══════════════════════════════════════════════════════════════════
TONE ADAPTATION BY ACCOUNT HEALTH
═══════════════════════════════════════════════════════════════════

healthy_growing: Confident, forward-looking, "capture the moment"
cost_pressure: Practical, efficiency-focused, empathetic
loss_making: Sensitive, insight not pitch, NEVER lead with the loss
post_acquisition: Energetic, integration-focused
new_leadership: Curious, "first 100 days", exploratory
mature_stable: Strategic, "what's next", respect what's working
industry_headwind: Defensive, "protect margin", practical

═══════════════════════════════════════════════════════════════════
SUBJECT LINE RULES
═══════════════════════════════════════════════════════════════════

Max 45 characters | 3-7 words | No spam triggers | No emojis | No exclamation marks
Formulas: "[Company] + [specific topic]" | "£[figure] for [Company]" | "[Industry trend]"
Email 5 subjects: "Closing the loop" or "Last note" only.

═══════════════════════════════════════════════════════════════════
ANTI-PATTERNS (NEVER DO THESE)
═══════════════════════════════════════════════════════════════════

NEVER start with: "I hope this finds you well" / "My name is X and I work at" / "I wanted to reach out" / "I came across your company"
NEVER use: "just checking in" / "per my previous email" / "As a leader in [industry]" / bullet lists >3 items
ALWAYS: Start "Hi [FirstName]," | Use contractions | 1-3 sentence paragraphs | Single CTA | End with first name only

═══════════════════════════════════════════════════════════════════
MANDATORY FOOTER (UK)
═══════════════════════════════════════════════════════════════════

Every email MUST end with:
[AE_NAME]
[AE_TITLE] | Revolut Business
revolut.com/business

To manage your sales outreach preferences or opt out, reply with your preference.
Any information provided does not constitute financial, investment, or trading advice.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════

Return raw JSON (no markdown fences):
{
  "subject": "string (max 45 chars)",
  "body": "string (full email body including sign-off, excluding footer)",
  "footer": "string (mandatory footer)",
  "word_count": number,
  "personalisation_audit": {
    "unique_facts_count": number,
    "inference_present": boolean,
    "industry_terms_used": ["string"],
    "persona_match": boolean,
    "recency_signal": boolean,
    "negative_space_applied": boolean,
    "objection_pre_empted": "string or null",
    "directors_language_mirrored": boolean,
    "personalisation_level": number (1-5)
  },
  "claims_used": ["string"],
  "disclaimers_needed": [number],
  "qc_self_check": "string (any concerns)"
}`;

export const INFERENCE_PATTERNS = {
  fuel_trading: [
    {
      condition: "trades_usd AND overheads_gbp AND eur_debtors",
      inference: "Trading in USD with overheads in GBP creates a natural margin squeeze when the dollar strengthens — but having a EUR debtor book partially offsets it. The structural FX problem most fuel traders your size are quietly absorbing into margin.",
    },
    {
      condition: "multiple_jurisdictions AND physical_commodity",
      inference: "Routing physical product through tax-efficient hubs usually means timing mismatches between when you book revenue and when cash actually arrives in GBP. That's where FX cost hides in the working capital cycle.",
    },
    {
      condition: "commodity_price_volatility AND fixed_contracts",
      inference: "Fixed-price supply contracts with variable USD input costs create a natural hedge requirement — but most fuel groups your size are still spot-trading through their primary bank rather than structuring forwards around delivery timelines.",
    },
    {
      condition: "invoice_discounting AND fx_exposure",
      inference: "Invoice discounting on a USD receivables book means your effective FX rate is locked at the point of discount, not the point of payment. If the discounter is also your FX provider, you're likely paying twice for the same risk transfer.",
    },
  ],
  construction: [
    {
      condition: "project_delays AND provisions",
      inference: "Project delays under the Gateway process mean cash is sitting longer in transit between valuations — and if your subbie payments are still going through legacy bank infrastructure, each day's delay costs basis points on the working capital tied up.",
    },
    {
      condition: "international_projects AND multiple_sites",
      inference: "Running contractor payments across multiple jurisdictions usually means fragmented banking relationships inherited project-by-project. Consolidation saves 1-2% on cross-border payments alone, before you get to card spend across site teams.",
    },
    {
      condition: "remediation_provisions AND bsa_compliance",
      inference: "BSA remediation spend is unpredictable in timing but certain in quantum — the payment flows when they come tend to be large, irregular, and time-sensitive. Having FX and settlement infrastructure that can move quickly on those matters.",
    },
  ],
  poultry_food: [
    {
      condition: "recent_acquisition AND new_finance_hire",
      inference: "Integrating a newly-acquired entity while feed prices are volatile isn't an ideal starting hand. The EUR feed import flow now split across two banking relationships inherited from each side of the deal — post-acquisition FX fragmentation is invisible until year-end.",
    },
    {
      condition: "feed_cost_pressure AND eur_imports",
      inference: "Feed conversion economics mean the EUR input cost flows directly to margin — and most poultry groups at your scale find they're absorbing 1-2% of unnecessary FX cost on the feed procurement flow through their primary bank.",
    },
    {
      condition: "halal_supply_chain AND international_sourcing",
      inference: "Halal-certified supply chains tend to involve more international touchpoints than conventional equivalents — procurement from specialist suppliers across multiple countries creates a multi-currency payment flow that most banks handle slowly and expensively.",
    },
  ],
  shipping_commodity: [
    {
      condition: "loss_making AND cost_reduction_mandate",
      inference: "When the Group is in loss, the controllable cost lines matter more. FX execution cost is one of the few that's improvable in weeks rather than quarters — and on your volume, the gap between bank pricing and interbank is material.",
    },
    {
      condition: "shipping AND multiple_currencies AND liquidity_risk",
      inference: "Charter party settlements in USD with port costs in local currencies create a timing mismatch that compounds with vessel schedules. Most shipping groups your size find their bank's FX desk isn't structured around delivery-timing-aware execution.",
    },
    {
      condition: "commodity_trading AND usd_eur_gbp",
      inference: "Physical commodity routing through multiple jurisdictions means your effective FX rate is determined by when the bank processes the payment, not when you agreed the trade. That settlement gap is where margin leaks for most traders at your scale.",
    },
  ],
  energy: [
    {
      condition: "high_interest_rates AND sme_customers",
      inference: "High rates squeezing your SME customer base means more aged debt and slower collections — which makes the cash conversion cycle longer. When cash is arriving slower, every basis point on the FX cost of what does arrive matters more.",
    },
    {
      condition: "uk_india_operations AND headcount_growth",
      inference: "Centre of gravity shifting east with 600+ staff in India means the UK is becoming HQ + finance function while operational delivery is India-based. Cards and expenses across two currencies and jurisdictions is the operational pain that grows with headcount.",
    },
    {
      condition: "wholesale_price_exposure AND balancing_market",
      inference: "Wholesale exposure means your revenue is GBP-denominated but your procurement cost follows global commodity pricing in USD. That structural mismatch is the FX problem hiding inside the energy margin — most suppliers your size treat it as weather rather than managing it actively.",
    },
  ],
  pe_advisory: [
    {
      condition: "global_group AND headcount_growth AND advisory_revenues",
      inference: "61% headcount growth with revenues following advisory mandates means your cost base is internationalising faster than your banking infrastructure. Most PE advisory firms at this stage find their FX costs have crept up without anyone formally reviewing the provider.",
    },
    {
      condition: "multi_currency_mandates AND fund_structures",
      inference: "Cross-border advisory fees flowing between fund entities in EUR, SEK, and GBP create a multi-leg payment chain that most banks handle as separate FX events. Consolidating execution saves the spread on each leg.",
    },
  ],
  gaming_hardware: [
    {
      condition: "primarily_usd AND principal_trading AND tight_cost_control",
      inference: "Moving from agent to principal means the USD execution rate now flows directly to your P&L rather than being absorbed by the manufacturer. That's a fundamental shift in FX sensitivity — and at £276M throughput, even 50bps improvement is material.",
    },
  ],
  property_management: [
    {
      condition: "fire_safety_liability AND service_charge_income",
      inference: "£416M in fire safety obligations funded through a combination of service charge, government grants, and legal recovery means unpredictable large payment flows when remediation triggers hit. The payment infrastructure needs to be responsive, not bureaucratic.",
    },
    {
      condition: "multi_entity AND leaseholder_management",
      inference: "Managing payments across multiple plot-level entities with different banking relationships inherited from the development phase creates reconciliation overhead that compounds with each new remediation stream.",
    },
  ],
  crypto_fintech: [
    {
      condition: "fiat_onramp AND intercompany_fx_losses AND us_parent",
      inference: "FX losses on intercompany balances between UK and US entities are a specific, measurable problem — and for a payment gateway company, it's ironic that your own internal money movement is where margin is leaking. Structuring the GBP/USD/PLN intercompany flows on forwards would eliminate that line item.",
    },
    {
      condition: "regulatory_compliance_costs AND crypto_adjacent",
      inference: "MiCA compliance costs are hitting every crypto-adjacent business simultaneously — which means the operational cost base is growing while volumes are cyclical. Reducing the FX loss line is one of the few margin levers that doesn't require headcount or regulatory change.",
    },
  ],
};

export const ACCOUNT_HEALTH_LABELS = {
  healthy_growing: "Confident, forward-looking",
  cost_pressure: "Practical, efficiency-focused",
  loss_making: "Sensitive, insight not pitch",
  post_acquisition: "Energetic, integration-focused",
  new_leadership: "Curious, first 100 days",
  mature_stable: "Strategic, what's next",
  industry_headwind: "Defensive, protect margin",
};

export function detectAccountHealth(analysis, score) {
  if (!analysis) return "mature_stable";

  const isLossMaking = analysis.risks?.some((r) =>
    /loss|deficit|negative/i.test(typeof r === "string" ? r : "")
  );
  if (isLossMaking) return "loss_making";

  const hasAcquisition = analysis.themes?.some((t) =>
    /acqui|merger|M&A|integrat/i.test(t.theme)
  );
  if (hasAcquisition) return "post_acquisition";

  const hasGrowth = analysis.turnover_trend === "growing" || (score?.growth?.rate > 0.1);
  if (hasGrowth) return "healthy_growing";

  const hasCostPressure = analysis.pain_indicators?.some((p) =>
    /cost|margin|pressure|rising/i.test(p.pain)
  );
  if (hasCostPressure) return "cost_pressure";

  return "mature_stable";
}

export function selectInferencePattern(company, analysis) {
  if (!analysis) return null;

  const text = JSON.stringify(analysis).toLowerCase();
  const name = (company.name || "").toLowerCase();

  let industry = null;
  if (/fuel|oil|petrol|diesel/i.test(name + " " + text)) industry = "fuel_trading";
  else if (/construct|building|contractor/i.test(name + " " + text)) industry = "construction";
  else if (/poultry|chicken|food|agri/i.test(name + " " + text)) industry = "poultry_food";
  else if (/ship|freight|charter|commodity.*trad/i.test(name + " " + text)) industry = "shipping_commodity";
  else if (/energy|power|gas|electric/i.test(name + " " + text)) industry = "energy";
  else if (/partner|advisory|fund|private\s+equity/i.test(name + " " + text)) industry = "pe_advisory";
  else if (/gaming|hardware|component|peripheral/i.test(name + " " + text)) industry = "gaming_hardware";
  else if (/property|estate|management.*village|leaseholder/i.test(name + " " + text)) industry = "property_management";
  else if (/crypto|blockchain|web3|fintech|transak/i.test(name + " " + text)) industry = "crypto_fintech";

  if (!industry || !INFERENCE_PATTERNS[industry]) return null;

  const patterns = INFERENCE_PATTERNS[industry];
  return { industry, patterns, best_pattern: patterns[0] };
}
