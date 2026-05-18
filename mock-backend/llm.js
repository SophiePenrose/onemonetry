const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export function isLLMConfigured() {
  return !!OPENAI_API_KEY;
}

export async function extractEvidence(company, productMotion) {
  if (!OPENAI_API_KEY) {
    return generateMockEvidence(company, productMotion);
  }

  const prompt = buildPrompt(company, productMotion);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content: `You are a Revolut Business prospecting analyst. Extract structured evidence about a company's fit for a specific product motion. Return a JSON object with these fields:
- fit_assessment: string (1-2 sentence summary of product fit)
- evidence_snippets: array of { source: string, text: string, relevance: "high"|"medium"|"low" }
- pain_indicators: array of strings (observable pain signals)
- recommended_angle: string (suggested outreach approach)
- confidence: "high"|"medium"|"low"
- risks: array of strings (potential obstacles)
Return ONLY valid JSON, no markdown.`,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("LLM API error:", response.status, err);
      return { ...generateMockEvidence(company, productMotion), source: "mock_fallback", error: "API call failed" };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { ...generateMockEvidence(company, productMotion), source: "mock_fallback", error: "Empty response" };
    }

    const parsed = JSON.parse(content);
    return { ...parsed, source: "llm", model: OPENAI_MODEL };
  } catch (err) {
    console.error("LLM extraction error:", err.message);
    return { ...generateMockEvidence(company, productMotion), source: "mock_fallback", error: err.message };
  }
}

function buildPrompt(company, productMotion) {
  return `Analyse the following company for the "${productMotion}" product motion at Revolut Business.

Company: ${company.name}
Industry: ${company.industry}
Turnover: £${(company.turnover / 1_000_000).toFixed(1)}M
Employees: ${company.employee_count}
Segment: ${company.segment || "Mid-Market"}

Known competitors: ${(company.competitors || []).map((c) => `${c.name} (${c.product}, ${c.strength})`).join("; ") || "None known"}

Product motion context for "${productMotion}":
${company.product_fit?.[productMotion]?.explanation || "No existing assessment."}

Extract evidence about this company's fit for ${productMotion}, including pain indicators, competitive angle, and recommended outreach approach.`;
}

function generateMockEvidence(company, productMotion) {
  const fit = company.product_fit?.[productMotion];
  const competitors = (company.competitors || []).filter(
    (c) => c.product === productMotion || c.product.toLowerCase().includes(productMotion.toLowerCase().split(" ")[0])
  );

  return {
    source: "mock",
    fit_assessment: fit?.explanation || `${company.name} shows potential for ${productMotion} based on industry profile and scale.`,
    evidence_snippets: [
      {
        source: "Annual Report",
        text: fit?.explanation || `Company operates in ${company.industry} with £${(company.turnover / 1_000_000).toFixed(1)}M turnover.`,
        relevance: fit?.fit_level === "strong" ? "high" : fit?.fit_level === "medium" ? "medium" : "low",
      },
      ...(competitors.length > 0
        ? [
            {
              source: "Competitor Analysis",
              text: `Current provider: ${competitors[0].name} (${competitors[0].strength}). ${competitors[0].notes}`,
              relevance: competitors[0].strength === "weak" ? "high" : "medium",
            },
          ]
        : []),
    ],
    pain_indicators: fit?.layers?.pain_strength
      ? [fit.layers.pain_strength.evidence]
      : [`${company.industry} sector typically experiences friction in ${productMotion.toLowerCase()} workflows`],
    recommended_angle: competitors.length > 0 && competitors[0].strength !== "strong"
      ? `Displacement play: ${competitors[0].name} is ${competitors[0].strength}. Lead with pricing transparency and digital experience.`
      : `Greenfield opportunity: no established ${productMotion} provider. Lead with product demo and quick wins.`,
    confidence: fit?.fit_level === "strong" ? "high" : fit?.fit_level === "medium" ? "medium" : "low",
    risks: [
      ...(competitors.some((c) => c.strength === "strong") ? ["Strong incumbent relationship may slow switching"] : []),
      ...(company.employee_count < 50 ? ["Small team may limit commercial value"] : []),
      ...(!fit?.eligible ? ["Weak product fit — may not justify outreach effort"] : []),
    ],
  };
}
