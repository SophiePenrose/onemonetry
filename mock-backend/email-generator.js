/**
 * LLM-powered email generation with full Revolut Business briefing context.
 * Generates QC-compliant, archetype-driven, persona-specific email sequences.
 */

import { validateEmail, APPROVED_CLAIMS, isCompanyExcluded } from "./email-qc.js";
import { detectTriggers, selectArchetype, getPersonaGuidance, getSectorAngle, COMPETITOR_DISPLACEMENT } from "./email-archetypes.js";
import { getSetting } from "./db.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `You are an email generation agent for the Revolut Business mid-market prospecting tool. Generate compliant, high-converting outbound emails scoring 95%+ on Revolut's QC scorecard.

HARD RULES:
- NEVER use: "always free", "free forever", "we're the best", "cheapest in the market", "nobody else does this", "the only platform that", "best/lowest/fastest/most secure" (superlatives), "100% guaranteed", "unlimited cards/accounts", "you'll definitely save", "guaranteed savings", "limited time only", "sign up now or miss out", "last chance", "act now", "save thousands/millions", "60-80% cheaper"
- ALWAYS qualify "interbank rate" with "during market hours within plan allowance" or append ²
- NEVER use: Dear, Sirs, synergy, leverage, circle back, touch base, low-hanging fruit, deep dive, ideate
- NEVER use emojis
- Max 1 exclamation mark per email
- No "hope you're well", "sorry to bother", "just checking in", "I never heard back", "per my previous email"

APPROVED CLAIMS (use ONLY these numbers):
- 70M total customers
- 20,000+ new businesses join monthly
- 99.99%+ platform uptime
- 6% saved on spend (disclaimer: illustrative, not guaranteed)
- 88% faster expense management
- Exchange at interbank rate (during market hours within plan allowance)
- 0% markup on FX within plan allowance
- FX is 2–4x cheaper than Pleo
- Up to 200 virtual cards
- 24-hour settlement (vs 3–7 days from traditional acquirers)
- Like-for-like settlement in 34 currencies
- 9-second checkout with Revolut Pay
- Access to 70M+ retail users via Revolut Pay

TONE (4 pillars): Trustworthy, Empowering, Sophisticated, Smart.
- Contractions OK (we're, you'll, you've)
- "You/your/your team" — never "users", "clients"
- Confident and direct
- Open with: Hey, Hi, Hello — NEVER "Dear"
- No buzzwords, no padding, no fluff

STRUCTURE (5-block for cold outreach):
1. HOOK: 1 sentence, max 15 words. Specific observation.
2. CONTEXT/PAIN: 1–2 sentences, 20–30 words. Tie to business challenge.
3. VALUE PROP: 1–2 sentences, 25–40 words. One specific approved data point.
4. SOCIAL PROOF (optional): 1 sentence.
5. ASK: 1 sentence, 10–20 words. Interest-based, NOT meeting-based.

WORD LIMITS:
- Cold initial: 75–110 words
- Follow-up: 60–120 words
- Breakup: 40–80 words
- Subject: 3–7 words, max 45 characters

OUTPUT FORMAT: Return raw JSON (no markdown):
{
  "subject": "string",
  "body": "string",
  "archetype_used": "string",
  "claims_used": ["string"],
  "disclaimers_needed": [number],
  "qc_self_check": "string (any potential issues)"
}`;

export async function generateLLMEmail(params) {
  const { company, contact, analysis, score, archetype, trigger, senderName, stepNumber, totalSteps } = params;

  if (!OPENAI_API_KEY) {
    return generateFallbackEmail(params);
  }

  const persona = getPersonaGuidance(contact.role);
  const sector = getSectorAngle(company.industry);
  const displacement = analysis?.competitors_detected?.length > 0
    ? COMPETITOR_DISPLACEMENT[analysis.competitors_detected[0].name]
    : null;

  const userPrompt = buildUserPrompt(params, persona, sector, displacement);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      return generateFallbackEmail(params);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return generateFallbackEmail(params);

    const cleaned = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    const qcResult = validateEmail(
      { subject: parsed.subject, body: parsed.body },
      { isInitialOutreach: stepNumber === 1 }
    );

    return {
      subject: parsed.subject,
      body: parsed.body,
      archetype: archetype?.id || "diagnostic_filing",
      trigger_type: trigger?.type || null,
      qc_score: qcResult.score,
      qc_pass: qcResult.pass,
      qc_issues: qcResult.issues,
      metrics: qcResult.metrics,
      claims_used: parsed.claims_used || [],
      disclaimers_needed: parsed.disclaimers_needed || [],
      source: "llm",
      model: OPENAI_MODEL,
    };
  } catch (err) {
    console.error("Email generation LLM error:", err.message);
    return generateFallbackEmail(params);
  }
}

function buildUserPrompt(params, persona, sector, displacement) {
  const { company, contact, analysis, score, archetype, trigger, stepNumber, totalSteps } = params;

  const parts = [`Generate email step ${stepNumber} of ${totalSteps} for this prospect:`];

  parts.push(`\nCOMPANY DATA:
- Name: ${company.name}
- Turnover: £${company.turnover ? (company.turnover / 1e6).toFixed(1) + "M" : "Unknown"}
- Employees: ${company.employee_count || "Unknown"}
- Industry: ${company.industry || "Unknown"}
- Segment: ${company.segment || "Mid-Market"}`);

  if (analysis?.international_exposure?.present) {
    parts.push(`- International exposure: ${analysis.international_exposure.details}`);
    if (analysis.international_exposure.currencies?.length) {
      parts.push(`- Currencies: ${analysis.international_exposure.currencies.join(", ")}`);
    }
  }

  if (analysis?.turnover_trend) parts.push(`- Growth trend: ${analysis.turnover_trend}`);

  parts.push(`\nCONTACT:
- Name: ${contact.name}
- Role: ${contact.role || "Director"}
- Persona guidance: ${persona.angle}
- Tone: ${persona.tone}`);

  if (archetype) {
    parts.push(`\nARCHETYPE: ${archetype.name} — ${archetype.description}
- Subject formula: ${archetype.subject_formula}`);
  }

  if (trigger) {
    parts.push(`\nTRIGGER: ${trigger.type} (strength: ${trigger.strength})`);
    if (trigger.data?.estimated_savings) {
      parts.push(`- Estimated FX savings: £${(trigger.data.estimated_savings / 1000).toFixed(0)}K/year`);
      parts.push(`- Estimated FX volume: £${(trigger.data.estimated_fx_volume / 1e6).toFixed(1)}M`);
    }
  }

  if (analysis?.pain_indicators?.length > 0) {
    parts.push(`\nPAIN INDICATORS:`);
    for (const p of analysis.pain_indicators.slice(0, 3)) {
      parts.push(`- ${p.pain} (${p.severity}): ${p.evidence}`);
    }
  }

  if (analysis?.opportunities?.length > 0) {
    parts.push(`\nPRODUCT OPPORTUNITIES:`);
    for (const o of analysis.opportunities.slice(0, 3)) {
      parts.push(`- ${o.product} (${o.confidence}): ${o.rationale}`);
    }
  }

  if (displacement) {
    parts.push(`\nCOMPETITOR: ${analysis.competitors_detected[0].name}
- Approved displacement: "${displacement.angle}"`);
  }

  if (sector) {
    parts.push(`\nSECTOR ANGLE (${company.industry}):
- Best motions: ${sector.motions.join(", ")}
- Hook: ${sector.hook}
- Pain: ${sector.pain}`);
  }

  if (stepNumber === 1) {
    parts.push(`\nEMAIL TYPE: Cold initial outreach (75–110 words). Must include self-intro mention of Revolut Business.`);
  } else if (stepNumber === totalSteps) {
    parts.push(`\nEMAIL TYPE: Breakup email (40–80 words). Gracious, low-pressure. Acknowledge silence without guilt. Leave door open.`);
  } else {
    parts.push(`\nEMAIL TYPE: Follow-up ${stepNumber - 1} (60–120 words). Must add new value — case study, data point, or different angle. NEVER "just checking in".`);
  }

  parts.push(`\nSender name: ${params.senderName || "[Your Name]"}`);
  parts.push(`\nReturn raw JSON with: subject, body, archetype_used, claims_used, disclaimers_needed, qc_self_check`);

  return parts.join("\n");
}

function generateFallbackEmail(params) {
  const { company, contact, archetype, stepNumber, totalSteps, senderName } = params;
  const firstName = contact.name?.split(" ")[0] || "there";
  const name = senderName || "[Your Name]";

  let subject, body;

  if (stepNumber === 1) {
    subject = `${company.name} & Revolut`;
    body = `Hi ${firstName},\n\nI came across ${company.name}'s latest filing and noticed your international operations. At your turnover, there's often meaningful FX cost sitting in the payment flow that compresses significantly at interbank rates (during market hours within plan allowance).\n\nWould it make sense to compare your current rates against what we're seeing for similar businesses?\n\nBest,\n${name}`;
  } else if (stepNumber === totalSteps) {
    subject = `Closing the loop — ${company.name}`;
    body = `Hi ${firstName},\n\nHaven't heard back, so I'll assume the timing isn't right.\n\nIf international payments or FX becomes a priority in the next few months, my line is open. Either way, wishing you and the team well.\n\nBest,\n${name}`;
  } else {
    subject = `Re: ${company.name} & Revolut`;
    body = `Hi ${firstName},\n\nAdding a quick data point — businesses at ${company.name}'s size that move to interbank FX pricing (during market hours within plan allowance) typically see their payment costs compress by a meaningful amount.\n\nHappy to share a specific comparison if useful?\n\nBest,\n${name}`;
  }

  const qcResult = validateEmail({ subject, body }, { isInitialOutreach: stepNumber === 1 });

  return {
    subject,
    body,
    archetype: archetype?.id || "diagnostic_filing",
    trigger_type: null,
    qc_score: qcResult.score,
    qc_pass: qcResult.pass,
    qc_issues: qcResult.issues,
    metrics: qcResult.metrics,
    claims_used: [],
    disclaimers_needed: [2],
    source: "fallback",
  };
}

export async function generateFullSequence(params) {
  const { company, contact, analysis, score, motion } = params;

  const exclusion = isCompanyExcluded(company, analysis);
  if (exclusion.excluded) {
    return { error: `Company excluded: ${exclusion.reason}`, excluded: true };
  }

  const triggers = detectTriggers(company, analysis, score);
  const archetype = selectArchetype(triggers, analysis, company);
  const senderName = getSetting("sender_name", "[Your Name]");

  const cadence = determineCadence(triggers, contact);
  const steps = [];

  for (let i = 0; i < cadence.steps; i++) {
    const stepParams = {
      company,
      contact,
      analysis,
      score,
      archetype,
      trigger: triggers[0] || null,
      senderName,
      stepNumber: i + 1,
      totalSteps: cadence.steps,
    };

    const email = await generateLLMEmail(stepParams);
    steps.push({
      step_number: i + 1,
      send_delay_days: cadence.delays[i] || 0,
      ...email,
    });
  }

  return {
    archetype: archetype.id,
    archetype_name: archetype.name,
    triggers,
    cadence,
    steps,
    exclusion_check: { excluded: false },
  };
}

function determineCadence(triggers, contact) {
  const hasHighTrigger = triggers.some((t) => t.strength === "high");

  if (hasHighTrigger) {
    return { steps: 4, delays: [0, 3, 7, 12], strategy: "aggressive" };
  }

  const hasMediumTrigger = triggers.some((t) => t.strength === "medium");
  if (hasMediumTrigger) {
    return { steps: 3, delays: [0, 4, 10], strategy: "standard" };
  }

  return { steps: 3, delays: [0, 5, 12], strategy: "nurture" };
}
