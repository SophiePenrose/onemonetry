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

export function getSequenceTemplates() {
  return Object.keys(SEQUENCE_TEMPLATES);
}

export function generateSequence(params) {
  const { companyId, companyName, stakeholderName, stakeholderRole, motion, analysis, turnover, employeeCount, industry } = params;

  const template = SEQUENCE_TEMPLATES[motion];
  if (!template) return null;

  const firstName = stakeholderName?.split(" ")[0] || "there";
  const senderName = getSetting("sender_name", "[Your Name]");

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

  const steps = template.steps.map((step, idx) => {
    let subject = step.subject_template;
    let body = step.body_template;
    for (const [key, val] of Object.entries(vars)) {
      subject = subject.replaceAll(key, val);
      body = body.replaceAll(key, val);
    }
    return {
      step_number: idx + 1,
      subject,
      body,
      send_delay_days: step.delay,
      status: "pending",
    };
  });

  db.prepare(`
    INSERT INTO email_sequences (id, company_id, stakeholder_name, stakeholder_role, stakeholder_email, motion, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(sequenceId, companyId, stakeholderName, stakeholderRole || null, params.stakeholderEmail || null, motion);

  for (const step of steps) {
    db.prepare(`
      INSERT INTO email_steps (sequence_id, step_number, subject, body, send_delay_days, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(sequenceId, step.step_number, step.subject, step.body, step.send_delay_days);
  }

  return { id: sequenceId, steps };
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

export { SEQUENCE_TEMPLATES };
