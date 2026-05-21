import { getFilingsForCompany } from "./db.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export function isLLMConfigured() {
  return !!OPENAI_API_KEY;
}

export async function analyseCompany(companyNumber, companyName, turnover) {
  const filings = getFilingsForCompany(companyNumber, 3);
  const filingText = filings.find((f) => f.raw_data)?.raw_data || null;

  if (!OPENAI_API_KEY) {
    return generateFallbackAnalysis(companyName, companyNumber, turnover, filingText);
  }

  if (!filingText) {
    return {
      source: "no_filing_data",
      summary: "No filing text available for analysis. Process accounts data first.",
      turnover_trend: "unknown",
      themes: [],
      pain_indicators: [],
      opportunities: [],
      risks: [],
      recommended_approach: "Upload filing data or wait for next accounts processing cycle.",
      international_exposure: { present: false, details: "No filing data to assess" },
      key_people: [],
    };
  }

  const prompt = buildAnalysisPrompt(companyName, companyNumber, turnover, filingText);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a Revolut Business mid-market account executive prospecting analyst. You analyse UK company accounts filings to identify prospecting opportunities.

REVOLUT BUSINESS CONTEXT:
- Primary entry product: FX (73% of positioning, interbank rates vs banks charging 1-3%)
- Top revenue generator: Corporate Cards (1.7% GP per transaction, unlimited virtual cards)
- Key differentiator: 24-hour settlement for Merchant Acquiring (vs 3-7 days for Stripe/Worldpay)
- Revolut Pay: 99% profit margin, access to 70M retail users, 9-second checkout
- FX Forwards: 0.8% markup on GBP/EUR/USD vs traditional brokers who bundle with credit lines
- Spend Management: cheaper than Pleo (£5/user vs £9.50), 2-4x cheaper FX
- API: unified platform across banking + acquiring

TARGET: Mid-market companies £15M-£500M turnover with international operations, payment processing needs, or growing teams needing expense management.

KEY COMPETITORS TO DETECT:
- HSBC/Barclays/NatWest (FX): digital friction, 1-3% FX costs, legacy tech
- Stripe (Acquiring): 3-7 day settlement, high fees for commercial cards
- Worldpay (Acquiring): complex pricing, slow settlement
- Wise (FX): no forwards, no cards, no acquiring
- Pleo (Spend): 1.5-2.5% FX markup, no banking ecosystem

POSITIVE SIGNALS: New CFO/FD, recent acquisition, headcount growth 5%+, cost reduction mandate, international expansion, multiple banking relationships, payment costs mentioned, spreadsheets for AP.

NEGATIVE SIGNALS: Going concern doubt, in administration, purely domestic (no FX need), strong incumbent bank relationship with credit lines.

Return ONLY raw valid JSON (no markdown code fences, no commentary) with these fields:
- summary: string (2-3 sentence business description)
- turnover_trend: string ("growing"|"stable"|"declining"|"unknown")
- themes: array of { theme: string, evidence: string }
- pain_indicators: array of { pain: string, evidence: string, severity: "high"|"medium"|"low" }
- opportunities: array of { product: string, rationale: string, confidence: "high"|"medium"|"low", estimated_value: string }
- risks: array of strings
- recommended_approach: string (which product to lead with and why)
- deal_type: string ("transactional"|"transformational") — transactional = 1-2 products, transformational = full suite
- international_exposure: { present: boolean, details: string, currencies: array of strings }
- key_people: array of { name: string, role: string } (from directors report)
- competitors_detected: array of { name: string, product: string, displacement_angle: string }`,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("LLM API error:", response.status, err);
      return { ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText), source: "fallback", error: "API call failed" };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText), source: "fallback", error: "Empty response" };
    }

    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return { ...parsed, source: "llm", model: OPENAI_MODEL, analysed_at: new Date().toISOString() };
  } catch (err) {
    console.error("LLM analysis error:", err.message);
    return { ...generateFallbackAnalysis(companyName, companyNumber, turnover, filingText), source: "fallback", error: err.message };
  }
}

function buildAnalysisPrompt(companyName, companyNumber, turnover, filingText) {
  const truncated = filingText.substring(0, 12000);
  return `Analyse this UK company's accounts filing for prospecting purposes.

Company: ${companyName || "Unknown"}
Company Number: ${companyNumber}
Turnover: £${turnover ? (turnover / 1e6).toFixed(1) + "M" : "Unknown"}

--- FILING CONTENT ---
${truncated}
--- END ---

Based on this filing, provide a structured JSON analysis for a Revolut Business mid-market account executive looking to identify prospecting opportunities. Return raw JSON only.`;
}

function generateFallbackAnalysis(companyName, companyNumber, turnover, filingText) {
  const name = companyName || `Company ${companyNumber}`;
  const t = turnover ? `£${(turnover / 1e6).toFixed(1)}M` : "unknown";

  if (!filingText) {
    return {
      source: "no_data",
      summary: `${name} has ${t} turnover. No filing content available for detailed analysis.`,
      themes: [],
      pain_indicators: [],
      opportunities: [],
      risks: ["No filing data available for analysis"],
      recommended_approach: "Upload filing data or wait for next accounts processing cycle.",
    };
  }

  const text = filingText.toLowerCase();
  const themes = [];
  const pains = [];
  const opportunities = [];
  const people = [];

  if (text.includes("international") || text.includes("overseas") || text.includes("export")) {
    themes.push({ theme: "International activity", evidence: "Filing mentions international/overseas operations" });
    pains.push({ pain: "FX exposure", evidence: "International operations suggest multi-currency payment flows", severity: "medium" });
    opportunities.push({ product: "FX", rationale: "International operations indicate FX payment needs", confidence: "medium" });
  }

  if (text.includes("acquisition") || text.includes("merger") || text.includes("group")) {
    themes.push({ theme: "M&A / Group structure", evidence: "Filing references acquisitions or group structure" });
  }

  if (text.includes("employee") || text.includes("staff")) {
    const empMatch = filingText.match(/(\d+)\s*(?:employees|staff|people)/i);
    if (empMatch) {
      const count = parseInt(empMatch[1]);
      if (count > 50) {
        pains.push({ pain: "Expense management at scale", evidence: `${count} employees likely need corporate cards/expense controls`, severity: count > 200 ? "high" : "medium" });
        opportunities.push({ product: "Cards", rationale: `${count} employees represent a significant card programme opportunity`, confidence: count > 200 ? "high" : "medium" });
        opportunities.push({ product: "Spend Management", rationale: `Multi-department organisation with ${count} staff needs spend controls`, confidence: "medium" });
      }
    }
  }

  if (text.includes("revenue") && (text.includes("increas") || text.includes("grew") || text.includes("growth"))) {
    themes.push({ theme: "Revenue growth", evidence: "Filing indicates growing revenue" });
  }

  if (text.includes("payment") || text.includes("merchant") || text.includes("online") || text.includes("e-commerce")) {
    opportunities.push({ product: "Merchant Acquiring", rationale: "Payment/online activity suggests card acceptance needs", confidence: "medium" });
  }

  if (text.includes("director")) {
    const dirMatch = filingText.match(/(?:directors?|DIRECTORS?)[:\s]+([A-Z][a-zA-Z\s,.'()-]+?)(?:\n|REGISTERED|COMPANY|SECRETARY)/);
    if (dirMatch) {
      const names = dirMatch[1].split(/[,\n]/).map((n) => n.trim()).filter((n) => n.length > 3 && n.length < 50);
      for (const n of names.slice(0, 5)) {
        people.push({ name: n, role: "Director" });
      }
    }
  }

  const isInternational = text.includes("international") || text.includes("overseas") || text.includes("foreign currency");

  return {
    source: "text_analysis",
    summary: `${name} is a mid-market company with ${t} turnover.${themes.length > 0 ? " Key themes: " + themes.map((t) => t.theme).join(", ") + "." : ""}`,
    turnover_trend: text.includes("increas") || text.includes("grew") ? "growing" : text.includes("decreas") || text.includes("declined") ? "declining" : "unknown",
    themes,
    pain_indicators: pains,
    opportunities,
    risks: turnover && turnover < 20_000_000 ? ["Relatively lower turnover — may have limited commercial value"] : [],
    recommended_approach: opportunities.length > 0
      ? `Lead with ${opportunities[0].product} — ${opportunities[0].rationale}`
      : "Research further via Companies House and company website before outreach.",
    international_exposure: { present: isInternational, details: isInternational ? "Filing indicates international operations" : "No clear international activity mentioned" },
    key_people: people,
    analysed_at: new Date().toISOString(),
  };
}

// Keep backward compat for the old endpoint
export async function extractEvidence(company, productMotion) {
  return analyseCompany(
    company.company_number || company.id?.replace("ch-", ""),
    company.name,
    company.turnover
  );
}
