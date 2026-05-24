/**
 * LLM-powered email generation with full Revolut Business briefing context.
 * Generates QC-compliant, archetype-driven, persona-specific email sequences.
 */

import { validateEmail, APPROVED_CLAIMS, isCompanyExcluded } from "./email-qc.js";
import { detectTriggers, selectArchetype, getPersonaGuidance, getSectorAngle, COMPETITOR_DISPLACEMENT } from "./email-archetypes.js";
import { SYSTEM_PROMPT, selectInferencePattern, detectAccountHealth } from "./email-system-prompt.js";
import { getSetting } from "./db.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function mandatoryFooter(senderName = "[Your Name]") {
  return `${senderName}
Account Executive | Revolut Business
revolut.com/business

To manage your sales outreach preferences or opt out, reply with your preference.
Any information provided does not constitute financial, investment, or trading advice.`;
}

function withMandatoryFooter(body, footer) {
  const cleanBody = (body || "").trim();
  const cleanFooter = (footer || "").trim();
  const required = cleanFooter || mandatoryFooter();
  if (/sales outreach preferences|does not constitute financial/i.test(cleanBody)) return cleanBody;
  return `${cleanBody}\n\n${required}`;
}

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
  const inferenceData = selectInferencePattern(company, analysis);
  const accountHealth = detectAccountHealth(analysis, score);

  const enrichedParams = { ...params, inferenceData, accountHealth };
  const userPrompt = buildUserPrompt(enrichedParams, persona, sector, displacement);

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

    const body = withMandatoryFooter(parsed.body, parsed.footer || mandatoryFooter(senderName));
    const qcResult = validateEmail(
      { subject: parsed.subject, body },
      { isInitialOutreach: stepNumber === 1 }
    );

    return {
      subject: parsed.subject,
      body,
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
  const { company, contact, analysis, score, archetype, trigger, stepNumber, totalSteps, merchantSpend } = params;

  const parts = [`Generate email step ${stepNumber} of ${totalSteps} for this prospect.

CRITICAL INSTRUCTION: This email MUST reference specific facts from the company data below. Every paragraph should contain a verifiable observation. Do NOT write generic copy. Show proof-of-research by citing:
- Specific countries they operate in
- Specific currencies they trade in
- Specific financial figures or trends from their filing
- Specific pain points unique to THIS company
- Named competitors detected in their setup

The "proof of research" principle: the prospect should think "how do they know that?" within the first 2 sentences.`];

  parts.push(`\nCOMPANY FACTS (USE THESE SPECIFICALLY — do not generalise):
- Company name: ${company.name}
- Annual turnover: £${company.turnover ? (company.turnover / 1e6).toFixed(1) + "M" : "Unknown"}
- Employees: ${company.employee_count || "Unknown"}
- Industry: ${company.industry || "Unknown"}
- Segment: ${company.segment || "Mid-Market"}`);

  if (analysis?.summary) {
    parts.push(`- LLM summary: "${analysis.summary}"`);
  }

  if (analysis?.international_exposure?.present) {
    parts.push(`- International operations: ${analysis.international_exposure.details}`);
    if (analysis.international_exposure.currencies?.length) {
      parts.push(`- Currencies traded: ${analysis.international_exposure.currencies.join(", ")}`);
      const vol = company.turnover * (analysis.international_exposure.currencies.length > 2 ? 0.5 : 0.3);
      parts.push(`- Estimated annual FX volume: ~£${(vol / 1e6).toFixed(0)}M`);
      parts.push(`- Estimated FX cost at bank rates (1.5%): ~£${(vol * 0.015 / 1000).toFixed(0)}K/year`);
      parts.push(`- Estimated saving on interbank: ~£${(vol * 0.012 / 1000).toFixed(0)}K/year`);
    }
  }

  if (analysis?.turnover_trend) {
    parts.push(`- Revenue trend: ${analysis.turnover_trend}${score?.growth?.rate ? ` (${(score.growth.rate * 100).toFixed(0)}% YoY)` : ""}`);
  }

  if (analysis?.themes?.length > 0) {
    parts.push(`\nKEY THEMES FROM FILING (reference at least one):`);
    for (const t of analysis.themes) {
      parts.push(`- ${t.theme}: "${t.evidence}"`);
    }
  }

  if (analysis?.pain_indicators?.length > 0) {
    parts.push(`\nSPECIFIC PAIN POINTS (weave one into the email):`);
    for (const p of analysis.pain_indicators) {
      parts.push(`- [${p.severity}] ${p.pain}: "${p.evidence}"`);
    }
  }

  if (analysis?.opportunities?.length > 0) {
    parts.push(`\nPRODUCT OPPORTUNITIES IDENTIFIED:`);
    for (const o of analysis.opportunities) {
      parts.push(`- ${o.product} [${o.confidence} confidence]: "${o.rationale}"`);
    }
  }

  if (analysis?.competitors_detected?.length > 0) {
    parts.push(`\nCOMPETITORS DETECTED IN THEIR SETUP:`);
    for (const c of analysis.competitors_detected) {
      const disp = COMPETITOR_DISPLACEMENT[c.name];
      parts.push(`- ${c.name} (${c.product}): weakness = "${disp?.weakness || c.displacement_angle}"`);
      if (disp) parts.push(`  Approved angle: "${disp.angle}"`);
    }
  }

  if (analysis?.key_people?.length > 0) {
    parts.push(`\nKEY PEOPLE FROM FILING: ${analysis.key_people.map(p => `${p.name} (${p.role})`).join(", ")}`);
  }

  if (merchantSpend) {
    parts.push(`\nREVOLUT USER SPEND DATA (B2C insight — use carefully):
- Revolut users spent £${(merchantSpend.monthly_volume / 1000).toFixed(0)}K/month at this company
- ${merchantSpend.transaction_count} transactions/month from Revolut users
- Avg transaction: £${merchantSpend.avg_transaction?.toFixed(2)}
- This proves consumer demand already exists on our network
- Angle: "Your customers are already Revolut users — Revolut Pay gives you direct access to them with 9-second checkout"`);
  }

  parts.push(`\nCONTACT:
- Name: ${contact.name} (use first name "${contact.name.split(" ")[0]}" in greeting)
- Role: ${contact.role || "Director"}
- What they care about: ${persona.cares_about}
- Email tone for this persona: ${persona.tone}
- Angle: ${persona.angle}`);

  if (archetype) {
    parts.push(`\nARCHETYPE: "${archetype.name}"
- Core idea: ${archetype.description}
- Subject line formula: ${archetype.subject_formula}
- Why it converts: ${archetype.conversion_strength}`);
  }

  if (trigger) {
    parts.push(`\nPRIMARY TRIGGER: ${trigger.type} (${trigger.strength} strength)`);
    if (trigger.data?.estimated_savings) {
      parts.push(`- Use this number in the email: "~£${(trigger.data.estimated_savings / 1000).toFixed(0)}K/year in FX cost"`);
      parts.push(`- FX volume basis: £${(trigger.data.estimated_fx_volume / 1e6).toFixed(1)}M across ${trigger.data.currencies?.join("/") || "multiple currencies"}`);
    }
  }

  if (sector) {
    parts.push(`\nSECTOR INTELLIGENCE:
- Industry hook: "${sector.hook}"
- Core pain: "${sector.pain}"`);
  }

  if (stepNumber === 1) {
    parts.push(`\nEMAIL TYPE: Cold initial outreach
- 75–110 words max
- Must mention "Revolut Business" once (not just "Revolut")
- Open with a SPECIFIC observation from their filing that shows you've done the work
- The first sentence must contain a fact unique to this company (country, currency, figure)
- Subject line: 3–7 words, max 45 chars. Use their company name + a specific number or fact.`);
  } else if (stepNumber === totalSteps) {
    parts.push(`\nEMAIL TYPE: Breakup email
- 40–80 words
- Gracious, acknowledge silence without guilt
- Reference a specific data point you shared earlier (FX savings figure, currency corridors)
- Leave the specific benchmark/insight in their inbox as standalone value
- End with well-wishes, no pressure`);
  } else if (merchantSpend && stepNumber === 2) {
    parts.push(`\nEMAIL TYPE: Revolut user spend insight (unique value-add)
- 80–120 words
- Lead with the merchant spend data: their customers are already Revolut users
- Frame as insight they can't get elsewhere
- Tie to Revolut Pay (9-second checkout, 70M+ retail users)
- This is a "proof of demand" email — show them revenue they're leaving on the table`);
  } else {
    const angles = [
      "Share a peer benchmark or case study from their industry",
      "Use the competitor displacement angle — name the incumbent and its specific weakness",
      "Quantify the ROI: calculate their specific £ saving based on their FX volume",
      "Reference a different pain point from the filing than Step 1 used",
    ];
    const angleIdx = Math.min(stepNumber - 2, angles.length - 1);
    parts.push(`\nEMAIL TYPE: Follow-up ${stepNumber - 1} (value-add, not bump)
- 60–120 words
- ANGLE FOR THIS STEP: ${angles[angleIdx]}
- Must add NEW information not in previous steps
- NEVER say "just checking in", "following up", "bumping this"
- Lead with value, ask permission second`);
  }

  if (params.inferenceData?.best_pattern) {
    parts.push(`\nINFERENCE PATTERN TO USE (adapt to this company's specifics — do NOT copy verbatim):
"${params.inferenceData.best_pattern.inference}"
This is how an insider would describe their situation. Adapt the language to match their specific data.`);
  }

  if (params.accountHealth) {
    parts.push(`\nACCOUNT HEALTH: ${params.accountHealth}
Adjust your tone accordingly. ${params.accountHealth === "loss_making" ? "Be sensitive — do NOT lead with loss. Focus on controllable costs." : params.accountHealth === "post_acquisition" ? "Frame around integration and consolidation opportunity." : params.accountHealth === "healthy_growing" ? "Be confident and forward-looking." : ""}`);
  }

  parts.push(`\nSender name: ${params.senderName || "[Your Name]"}`);
  parts.push(`\nIMPORTANT REMINDERS:
- Savings estimates MUST include caveat: "(based on estimated FX volume from filed accounts; actual savings depend on your current provider's rates and would require a brief review to confirm)"
- Do NOT merely cite data. SYNTHESISE it into an insight about their business.
- The first sentence must make the prospect think "how do they know that?"
- Use industry-specific terminology (not generic business language)
- End with a genuine question, not a meeting request`);
  parts.push(`\nReturn raw JSON: { "subject": "...", "body": "...", "footer": "...", "word_count": N, "personalisation_audit": {...}, "claims_used": [...], "disclaimers_needed": [...], "qc_self_check": "..." }`);

  return parts.join("\n");
}

function generateFallbackEmail(params) {
  const { company, contact, archetype, stepNumber, totalSteps, senderName } = params;
  const firstName = contact.name?.split(" ")[0] || "there";
  const name = senderName || "[Your Name]";

  let subject, body;

  if (stepNumber === 1) {
    subject = `${company.name} & Revolut`;
    body = `Hi ${firstName},\n\n${company.name}'s latest filing points to international activity, which often makes FX cost harder to see until year-end.\n\nRevolut Business can help finance teams compare that flow against interbank FX during market hours within plan allowance, without asking them to move credit relationships.\n\nDoes it make sense to compare the methodology against your current setup?`;
  } else if (stepNumber === totalSteps) {
    subject = `Closing the loop — ${company.name}`;
    body = `Hi ${firstName},\n\nI'll assume timing is not right for now.\n\nIf international payments or FX becomes a priority later this year, the filing benchmark may still be useful as a reference point.\n\nEither way, wishing you and the team well.`;
  } else {
    subject = `Re: ${company.name} & Revolut`;
    body = `Hi ${firstName},\n\nAdding one useful benchmark: when finance teams review FX after filing accounts, the first gap is usually visibility rather than rate.\n\nA simple comparison against interbank FX during market hours within plan allowance can show whether there is anything worth changing.\n\nWorth seeing the assumptions?`;
  }

  const bodyWithFooter = withMandatoryFooter(body, mandatoryFooter(name));
  const qcResult = validateEmail({ subject, body: bodyWithFooter }, { isInitialOutreach: stepNumber === 1 });

  return {
    subject,
    body: bodyWithFooter,
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
  const { company, contact, analysis, score, motion, merchantSpend } = params;

  const exclusion = isCompanyExcluded(company, analysis);
  if (exclusion.excluded) {
    return { error: `Company excluded: ${exclusion.reason}`, excluded: true };
  }

  const triggers = detectTriggers(company, analysis, score);
  const archetype = selectArchetype(triggers, analysis, company);
  const senderName = getSetting("sender_name", "[Your Name]");

  const cadence = determineCadence(triggers, contact, merchantSpend);
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
      merchantSpend: cadence.merchantSpendStep === (i + 1) ? merchantSpend : null,
    };

    const email = await generateLLMEmail(stepParams);
    steps.push({
      step_number: i + 1,
      send_delay_days: cadence.delays[i] || 0,
      step_type: cadence.merchantSpendStep === (i + 1) ? "merchant_spend_insight" : (i === 0 ? "initial" : i === cadence.steps - 1 ? "breakup" : "follow_up"),
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
    merchant_spend_included: !!merchantSpend,
  };
}

function determineCadence(triggers, contact, merchantSpend) {
  const hasHighTrigger = triggers.some((t) => t.strength === "high");

  let cadence;
  if (hasHighTrigger) {
    cadence = { steps: 5, delays: [0, 3, 6, 10, 15], strategy: "high_trigger_multithread_ready" };
  } else if (triggers.some((t) => t.strength === "medium")) {
    cadence = { steps: 4, delays: [0, 3, 7, 15], strategy: "standard_value_add" };
  } else {
    cadence = { steps: 4, delays: [0, 5, 12, 21], strategy: "nurture_insight_first" };
  }

  if (merchantSpend && merchantSpend.monthly_volume > 0) {
    cadence.steps += 1;
    cadence.delays.splice(1, 0, 2);
    cadence.merchantSpendStep = 2;
    cadence.strategy += "+merchant_insight";
  }

  return cadence;
}
