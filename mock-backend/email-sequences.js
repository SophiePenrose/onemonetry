import { getSetting } from "./db.js";
import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS email_sequences (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    stakeholder_name TEXT NOT NULL,
    stakeholder_role TEXT,
    stakeholder_email TEXT,
    motion TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    send_delay_days INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at TEXT,
    opened_at TEXT,
    replied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sequence_id) REFERENCES email_sequences(id),
    UNIQUE(sequence_id, step_number)
  );

  CREATE INDEX IF NOT EXISTS idx_sequences_company ON email_sequences(company_id);
  CREATE INDEX IF NOT EXISTS idx_steps_sequence ON email_steps(sequence_id);
`);

const SEQUENCE_TEMPLATES = {
  FX: {
    persona_hooks: {
      CFO: "treasury cost reduction and FX visibility",
      "Finance Director": "FX cost savings and automated hedging",
      "Head of Treasury": "interbank rates and forward contract flexibility",
      Director: "reducing international payment costs",
    },
    steps: [
      {
        delay: 0,
        subject_template: "Quick question on {{company}}'s international payments",
        body_template: `Hi {{first_name}},

I noticed {{company}} has significant international operations{{international_detail}}. I wanted to reach out because we're helping similar mid-market businesses reduce their FX costs by 60-80% vs traditional banks.

{{pain_hook}}

Would you be open to a 15-minute call to see if there's a fit? Happy to share a quick comparison based on your likely currency flows.

Best,
{{sender_name}}`,
      },
      {
        delay: 3,
        subject_template: "Re: Quick question on {{company}}'s international payments",
        body_template: `Hi {{first_name}},

Just following up on my note from earlier this week. I appreciate you're busy, so I'll keep this brief.

We recently helped a {{industry}} business of similar size save over £{{estimated_savings}} annually on FX alone — interbank rates with no hidden markups.

{{competitor_angle}}

Would a quick 10-minute overview be useful? I can share relevant case studies from your sector.

Best,
{{sender_name}}`,
      },
      {
        delay: 7,
        subject_template: "{{company}} — FX cost benchmark (no obligation)",
        body_template: `Hi {{first_name}},

Final thought from me — I've put together a rough FX cost benchmark for businesses like {{company}} based on your turnover and likely currency split.

The numbers typically surprise finance teams who've been with their bank for a while. No obligation, no hard sell — just data to inform your next review.

Shall I send it across?

Best,
{{sender_name}}`,
      },
    ],
  },
  "FX Forwards": {
    persona_hooks: {
      CFO: "locking in FX rates to protect margins",
      "Finance Director": "forward cover without credit line requirements",
      "Head of Treasury": "flexible forwards with no minimum contract size",
      Director: "hedging international payment obligations",
    },
    steps: [
      {
        delay: 0,
        subject_template: "{{company}} — protecting margins on international payments",
        body_template: `Hi {{first_name}},

I came across {{company}}'s accounts and noticed your international operations{{international_detail}}. With currency volatility where it is, I imagine budget certainty on overseas payments is important.

We offer FX forwards at 0.8% markup — no credit line needed, no minimum contract — which is typically 50-70% cheaper than what traditional brokers charge.

{{pain_hook}}

Would it be worth 15 minutes to explore whether forward cover could protect your margins without the usual bank overheads?

Best,
{{sender_name}}`,
      },
      {
        delay: 4,
        subject_template: "Re: {{company}} — protecting margins on international payments",
        body_template: `Hi {{first_name}},

Quick follow-up — I wanted to share that we've recently onboarded several {{industry}} businesses who were paying 2-3% on forwards through their existing bank.

The switch typically takes less than a week, and most clients see the rate improvement immediately on their next batch of payments.

Happy to walk you through how it works in practice?

Best,
{{sender_name}}`,
      },
    ],
  },
  Cards: {
    persona_hooks: {
      CFO: "real-time spend visibility and control",
      "Finance Director": "eliminating expense report chaos",
      "Head of Finance": "instant virtual cards with per-card spending limits",
      Director: "corporate card programme with no personal guarantees",
    },
    steps: [
      {
        delay: 0,
        subject_template: "{{company}} — corporate cards for {{employee_count}}+ staff?",
        body_template: `Hi {{first_name}},

With {{employee_count}}+ employees at {{company}}, I imagine managing expenses, subscriptions, and team spending is a meaningful operational headache.

We offer unlimited virtual and physical corporate cards with:
• Real-time spend tracking per card, team, and department
• Instant freeze/unfreeze and per-card limits
• No personal guarantees or credit checks
• 1.7% cashback on qualifying spend

{{pain_hook}}

Would you be open to seeing how this works for a team your size?

Best,
{{sender_name}}`,
      },
      {
        delay: 4,
        subject_template: "Re: {{company}} — corporate cards for {{employee_count}}+ staff?",
        body_template: `Hi {{first_name}},

Just circling back. One thing finance teams consistently tell us is that the visibility alone — seeing every transaction in real-time rather than waiting for month-end statements — changes how they manage spend.

For a business with {{company}}'s operational complexity, that level of control often saves significant admin time on top of the direct cost savings.

Worth a 10-minute demo?

Best,
{{sender_name}}`,
      },
    ],
  },
  "Spend Management": {
    persona_hooks: {
      CFO: "real-time budget visibility across departments",
      "Finance Director": "automated approvals and spend controls",
      "Head of Finance": "eliminating manual expense processes",
      Director: "streamlining procurement and expense management",
    },
    steps: [
      {
        delay: 0,
        subject_template: "{{company}} — spend visibility across {{employee_count}} staff",
        body_template: `Hi {{first_name}},

I noticed {{company}} operates across multiple sites/departments, which typically means fragmented spend visibility. If that resonates, I'd love to show you how our spend management platform gives instant oversight without the enterprise price tag.

At £5/user (vs Pleo at £9.50 or Concur at £20+), with built-in approval workflows and 2-4x cheaper FX on international purchases.

{{pain_hook}}

Would a quick overview be helpful?

Best,
{{sender_name}}`,
      },
    ],
  },
  "Merchant Acquiring": {
    persona_hooks: {
      CFO: "faster settlement and lower processing fees",
      "Finance Director": "24-hour settlement improving cash flow",
      "Head of Payments": "reducing processing costs by 20-30%",
      Director: "card payment processing with next-day settlement",
    },
    steps: [
      {
        delay: 0,
        subject_template: "{{company}} — card payments settling in 24 hours?",
        body_template: `Hi {{first_name}},

I noticed {{company}} accepts card payments. Quick question — how long does your current settlement cycle take?

Most processors (Stripe, Worldpay, etc.) take 3-7 days. We settle in 24 hours, which for a business doing {{company}}'s volume, can meaningfully improve cash flow.

Combined with transparent pricing (no hidden fees, commercial card surcharges absorbed), it's typically 20-30% cheaper than existing setups.

{{pain_hook}}

Worth a quick comparison?

Best,
{{sender_name}}`,
      },
    ],
  },
};

const HOLISTIC_MOTION = "Holistic Narrative";
const PLACEHOLDER_TOKEN_PATTERN = /\[(?:rounded\s*figure|your\s*name|your\s*title|ae_name|ae_title)\]/i;
const RESEARCH_HEADER_PREFIX = "Revolut X";
const INTERNAL_MOTION_PRIORITY = {
  "Cards": 0.95,
  "FX": 0.9,
  "FX Forwards": 0.85,
  "Merchant Acquiring": 0.8,
  "Revolut Pay": 0.75,
  "API Integrations": 0.6,
  "Spend Management": 0.5,
  "Monthly Plans": 0.4,
};

function buildResearchHeaderSubject(companyName) {
  const safeCompanyName = String(companyName || "Company").trim() || "Company";
  return `${RESEARCH_HEADER_PREFIX} ${safeCompanyName} - I've done my research`;
}

function rankUseCasesByInternalPriority(useCases) {
  return [...(useCases || [])]
    .map((item) => ({
      ...item,
      _priorityWeight: INTERNAL_MOTION_PRIORITY[String(item?.product || "")] ?? 0,
    }))
    .sort((a, b) => {
      if (b._priorityWeight !== a._priorityWeight) {
        return b._priorityWeight - a._priorityWeight;
      }
      return String(a.product || "").localeCompare(String(b.product || ""));
    })
    .map(({ _priorityWeight, ...item }) => item);
}

function extractPlaceholderToken(text) {
  const match = String(text || "").match(PLACEHOLDER_TOKEN_PATTERN);
  return match ? match[0] : null;
}

function stripSignatureAndFooterForYamm(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\[(?:Your\s+Name|AE_NAME|Your\s+Title|AE_TITLE)\]/gi, "").trimEnd());

  const isLegalLine = (line) => /^(To manage your sales outreach preferences|Any information provided does not constitute)/i.test(line.trim());
  const isSignatureLine = (line) => /^(Best|Thanks|Kind regards|Regards|Sincerely|Cheers|Many thanks)[,!\.\s-]*$/i.test(line.trim())
    || /^(Revolut Business Team|Account Executive\s*\|\s*Revolut Business|revolut\.com\/business)$/i.test(line.trim());

  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || isLegalLine(lines[lines.length - 1]))) {
    lines.pop();
  }

  let removedSignatureMarkers = false;
  while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || isSignatureLine(lines[lines.length - 1]))) {
    if (isSignatureLine(lines[lines.length - 1])) removedSignatureMarkers = true;
    lines.pop();
  }

  if (removedSignatureMarkers && lines.length > 0) {
    const candidate = lines[lines.length - 1].trim();
    if (/^[A-Za-z][A-Za-z'\.-]*(?:\s+[A-Za-z][A-Za-z'\.-]*){0,3}$/.test(candidate)) {
      lines.pop();
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function getSequenceTemplates() {
  return [HOLISTIC_MOTION, ...Object.keys(SEQUENCE_TEMPLATES)];
}

function uniqStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function firstOrFallback(items, fallback) {
  return (Array.isArray(items) && items.length > 0) ? items[0] : fallback;
}

function buildHolisticSteps(params) {
  const {
    companyName,
    stakeholderName,
    stakeholderRole,
    analysis,
    turnover,
    senderName,
  } = params;

  const firstName = stakeholderName?.split(" ")[0] || "there";
  const company = companyName || "your company";
  const painList = uniqStrings((analysis?.pain_indicators || []).map((p) => p.pain || p));
  const oppList = uniqStrings((analysis?.opportunities || []).map((o) => o.product || ""));
  const competitorList = uniqStrings((analysis?.competitors_detected || []).map((c) => c.name || c));
  const painSnippet = firstOrFallback(analysis?.evidence_snippets?.pains || [], null);
  const fitSnippet = firstOrFallback(analysis?.evidence_snippets?.suitability || [], null);
  const gapSnippet = firstOrFallback(analysis?.evidence_snippets?.gaps || [], null);
  const narrative = analysis?.outreach_narrative || {};
  const level5 = analysis?.level5_extraction || {};
  const sequenceInputs = level5.sequence_inputs || {};
  const painRegister = level5.pain_register || [];
  const useCases = rankUseCasesByInternalPriority(level5.revolut_opportunity?.recommended_use_cases || []);

  const primaryPain = firstOrFallback(painList, "payment and treasury inefficiency");
  const primaryPath = firstOrFallback(oppList, "an operational finance first step");
  const competitor = firstOrFallback(competitorList, "your current stack");
  const turnoverBand = turnover ? `around £${(turnover / 1e6).toFixed(1)}M` : "mid-market scale";
  const recommendedAngle = analysis?.recommended_approach || narrative.revolut_advantage || "a sequencing approach that starts from the highest-confidence pain and expands only where value is proven.";
  const topPain = firstOrFallback(painRegister, null);
  const topUseCase = firstOrFallback(useCases, null);
  const secondUseCase = useCases.length > 1 ? useCases[1] : null;
  const nowTrigger = sequenceInputs.now_trigger || "your latest filing context";
  const quantifiedHook = sequenceInputs.quantified_hook || "a quantification pass after confirming your current provider rates";
  const operationsHook = sequenceInputs.operations_hook || `teams operating at ${turnoverBand}`;
  const governanceHook = sequenceInputs.governance_hook || competitor;
  const objectionPreempt = sequenceInputs.objection_to_preempt || "This can usually run alongside existing facilities and ownership structures.";
  const directorsPhrase = firstOrFallback(sequenceInputs.directors_language || [], null);
  const roleLower = String(stakeholderRole || "").toLowerCase();
  const roleAnchor = roleLower.includes("cfo") || roleLower.includes("finance")
    ? "from a finance-control perspective"
    : "from an operating-model perspective";
  const fixedSubject = buildResearchHeaderSubject(company);

  const steps = [
    {
      delay: 0,
      subject: fixedSubject,
      body: `Observation & Origin: ${nowTrigger || `${company} has a live finance execution signal in the latest filing`}. ${painSnippet?.quote ? `Source line: "${painSnippet.quote}".` : topPain?.evidence ? `Source line: "${topPain.evidence}".` : "Source: latest filing narrative and accounts context."}\n\nMain Pain Link: ${topPain?.inferred_problem || primaryPain}. This likely creates avoidable execution drag ${roleAnchor}.\n\nValue Path (Suggestions): Start with ${topUseCase?.product || primaryPath} to validate one high-confidence lane first, then expand only where data confirms value.\n\nIf useful, I can share the exact pain-to-action map we would use, including what we would not change initially.`,
    },
    {
      delay: 3,
      subject: fixedSubject,
      body: `Observation & Origin: ${quantifiedHook}. ${fitSnippet?.quote ? `Source line: "${fitSnippet.quote}".` : "Source: filing signals on scale, complexity, and current process design."}\n\nMain Pain Link: ${operationsHook}. Without a controlled first-step sequence, teams at this scale often carry hidden cost and reconciliation overhead.\n\nValue Path (Suggestions): Prioritise ${topUseCase?.product || primaryPath}${secondUseCase ? `, then ${secondUseCase.product}` : ""}. ${topUseCase?.example_use_case || "Run the first lane in parallel with current setup to avoid disruption."}\n\nWould a one-page assumptions sheet be useful?`,
    },
    {
      delay: 7,
      subject: fixedSubject,
      body: `Observation & Origin: Governance risk usually appears where strategy intent and day-to-day execution diverge; in your case that appears tied to ${governanceHook}. ${gapSnippet?.quote ? `Source line: "${gapSnippet.quote}".` : directorsPhrase ? `Source line: "${directorsPhrase}".` : "Source: filing context and operating narrative."}\n\nMain Pain Link: Left unaddressed, this typically shows up as avoidable delay, leakage, and fragmented accountability across finance workflows.\n\nValue Path (Suggestions): ${objectionPreempt} ${recommendedAngle} Keep scope tight at first: one lane, one owner, one measurement loop.\n\nIf useful, I can share the short brief we would use with a CFO/FD team to validate this in one pass.`,
    },
  ];

  return steps.map((step, idx) => ({
    step_number: idx + 1,
    subject: step.subject,
    body: step.body,
    send_delay_days: step.delay,
    status: "pending",
  }));
}

function normalizeSteps(steps) {
  return (steps || [])
    .map((step, idx) => {
      const stepNumber = Number.parseInt(String(step.step_number || idx + 1), 10);
      const delay = Number.parseInt(String(step.send_delay_days || 0), 10);
      const safeBody = stripSignatureAndFooterForYamm(String(step.body || "").trim());
      const footer = stripSignatureAndFooterForYamm(String(step.footer || "").trim());
      const mergedBody = [safeBody, footer].filter(Boolean).join("\n\n").trim();
      return {
        step_number: Number.isFinite(stepNumber) && stepNumber > 0 ? stepNumber : idx + 1,
        subject: String(step.subject || "").trim() || `Step ${idx + 1}`,
        body: mergedBody,
        send_delay_days: Number.isFinite(delay) && delay >= 0 ? delay : 0,
        status: String(step.status || "pending"),
      };
    })
    .sort((a, b) => a.step_number - b.step_number);
}

export function saveGeneratedSequence(params) {
  const {
    id,
    companyId,
    companyName,
    stakeholderName,
    stakeholderRole,
    stakeholderEmail,
    motion,
    steps,
    sequenceStatus,
  } = params;

  const fixedSubject = companyName ? buildResearchHeaderSubject(companyName) : null;
  const normalizedSteps = normalizeSteps(steps).map((step) => ({
    ...step,
    subject: fixedSubject || step.subject,
  }));
  if (!companyId || !stakeholderName || normalizedSteps.length === 0) return null;

  const sequenceId = id || `seq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resolvedMotion = motion || HOLISTIC_MOTION;

  db.prepare(`
    INSERT INTO email_sequences (id, company_id, stakeholder_name, stakeholder_role, stakeholder_email, motion, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sequenceId,
    companyId,
    stakeholderName,
    stakeholderRole || null,
    stakeholderEmail || null,
    resolvedMotion,
    sequenceStatus || "draft"
  );

  for (const step of normalizedSteps) {
    db.prepare(`
      INSERT INTO email_steps (sequence_id, step_number, subject, body, send_delay_days, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sequenceId, step.step_number, step.subject, step.body, step.send_delay_days, step.status || "pending");
  }

  return { id: sequenceId, steps: normalizedSteps, motion: resolvedMotion };
}

export function generateSequence(params) {
  const { companyId, companyName, stakeholderName, stakeholderRole, motion, analysis, turnover, employeeCount, industry } = params;

  const requestedMotion = motion && SEQUENCE_TEMPLATES[motion] ? motion : HOLISTIC_MOTION;
  const senderName = String(getSetting("sender_name", "") || "").trim();

  let steps = [];

  if (requestedMotion === HOLISTIC_MOTION) {
    steps = buildHolisticSteps({
      companyName,
      stakeholderName,
      stakeholderRole,
      analysis,
      turnover,
      employeeCount,
      industry,
      senderName,
    });
  }

  const template = requestedMotion === HOLISTIC_MOTION ? null : SEQUENCE_TEMPLATES[requestedMotion];
  if (!template && requestedMotion !== HOLISTIC_MOTION) return null;

  const firstName = stakeholderName?.split(" ")[0] || "there";

  const internationalDetail = analysis?.international_exposure?.present
    ? ` (${analysis.international_exposure.details})`
    : "";

  const painHook = analysis?.pain_indicators?.length > 0
    ? `I also noticed ${analysis.pain_indicators[0].pain.toLowerCase()} — something we help similar businesses address directly.`
    : "";

  const competitorAngle = analysis?.competitors_detected?.length > 0
    ? `I understand you may currently work with ${analysis.competitors_detected[0].name}. Many of our clients switched from similar providers and typically see ${analysis.competitors_detected[0].displacement_angle?.toLowerCase() || "meaningful improvement"}.`
    : "Many finance teams we speak to are surprised by how much they're overpaying on what feels like a commodity service.";

  const estimatedSavings = turnover ? Math.round((turnover * 0.003) / 1000) + "K" : "50K+";

  const vars = {
    "{{company}}": companyName || "your company",
    "{{first_name}}": firstName,
    "{{sender_name}}": senderName,
    "{{international_detail}}": internationalDetail,
    "{{pain_hook}}": painHook,
    "{{competitor_angle}}": competitorAngle,
    "{{estimated_savings}}": estimatedSavings,
    "{{employee_count}}": employeeCount?.toLocaleString() || "100",
    "{{industry}}": industry || "mid-market",
  };

  const sequenceId = `seq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fixedSubject = buildResearchHeaderSubject(companyName || "Company");

  if (template) {
    steps = template.steps.map((step, idx) => {
      let body = step.body_template;
      for (const [key, val] of Object.entries(vars)) {
        body = body.replaceAll(key, val);
      }
      return {
        step_number: idx + 1,
        subject: fixedSubject,
        body,
        send_delay_days: step.delay,
        status: "pending",
      };
    });
  }

  return saveGeneratedSequence({
    id: sequenceId,
    companyId,
    companyName,
    stakeholderName,
    stakeholderRole,
    stakeholderEmail: params.stakeholderEmail,
    motion: requestedMotion,
    steps,
    sequenceStatus: "draft",
  });
}

export function getSequencesForCompany(companyId) {
  const sequences = db.prepare("SELECT * FROM email_sequences WHERE company_id = ? ORDER BY created_at DESC").all(companyId);
  return sequences.map((seq) => ({
    ...seq,
    steps: db.prepare("SELECT * FROM email_steps WHERE sequence_id = ? ORDER BY step_number").all(seq.id),
  }));
}

export function getSequence(sequenceId) {
  const seq = db.prepare("SELECT * FROM email_sequences WHERE id = ?").get(sequenceId);
  if (!seq) return null;
  return {
    ...seq,
    steps: db.prepare("SELECT * FROM email_steps WHERE sequence_id = ? ORDER BY step_number").all(seq.id),
  };
}

export function updateStepStatus(sequenceId, stepNumber, status) {
  const updates = { status };
  if (status === "sent") updates.sent_at = new Date().toISOString();
  if (status === "opened") updates.opened_at = new Date().toISOString();
  if (status === "replied") updates.replied_at = new Date().toISOString();

  const sets = Object.entries(updates).map(([k]) => `${k} = ?`);
  const vals = Object.values(updates);
  db.prepare(`UPDATE email_steps SET ${sets.join(", ")} WHERE sequence_id = ? AND step_number = ?`).run(...vals, sequenceId, stepNumber);
}

export function updateStepContent(sequenceId, stepNumber, subject, body) {
  db.prepare("UPDATE email_steps SET subject = ?, body = ? WHERE sequence_id = ? AND step_number = ?")
    .run(subject, body, sequenceId, stepNumber);
}

export function deleteSequence(sequenceId) {
  db.prepare("DELETE FROM email_steps WHERE sequence_id = ?").run(sequenceId);
  db.prepare("DELETE FROM email_sequences WHERE id = ?").run(sequenceId);
}

export function purgePlaceholderSequencesForCompany(companyId, options = {}) {
  const dryRun = options.dryRun === true;
  const rows = db.prepare("SELECT id, created_at FROM email_sequences WHERE company_id = ? ORDER BY created_at DESC").all(companyId);
  const matches = [];

  for (const row of rows) {
    const steps = db.prepare("SELECT step_number, subject, body FROM email_steps WHERE sequence_id = ? ORDER BY step_number").all(row.id);
    let matchDetail = null;

    for (const step of steps) {
      const token = extractPlaceholderToken(`${step.subject || ""}\n${step.body || ""}`);
      if (!token) continue;
      matchDetail = {
        step_number: step.step_number,
        token,
      };
      break;
    }

    if (!matchDetail) continue;

    matches.push({
      id: row.id,
      created_at: row.created_at,
      ...matchDetail,
    });
  }

  if (!dryRun) {
    for (const match of matches) {
      deleteSequence(match.id);
    }
  }

  return {
    company_id: companyId,
    dry_run: dryRun,
    scanned_sequences: rows.length,
    matched_sequences: matches.length,
    deleted_sequences: dryRun ? 0 : matches.length,
    matches,
  };
}

export { SEQUENCE_TEMPLATES };
