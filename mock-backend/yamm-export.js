/**
 * YAMM (Yet Another Mail Merge) Export Engine
 * Generates Google Sheets-compatible CSV for automated email sending.
 *
 * YAMM reads columns: To, Subject, Body, (and custom merge fields)
 * Pro plan supports: scheduling, tracking opens/clicks, follow-up sequences
 *
 * Workflow:
 * 1. Tool generates sequences → stores in DB
 * 2. AE reviews/edits in tool UI
 * 3. Export to Google Sheets format (one sheet per sequence)
 * 4. AE adds missing emails, reviews content
 * 5. YAMM sends from Gmail (signature auto-appended by Gmail)
 * 6. On reply → AE marks in tool → remaining steps paused
 */

import db from "./db.js";

export function exportSequenceForYAMM(sequenceId, options = {}) {
  const seq = db.prepare("SELECT * FROM email_sequences WHERE id = ?").get(sequenceId);
  if (!seq) return null;

  const steps = db.prepare(
    "SELECT * FROM email_steps WHERE sequence_id = ? ORDER BY step_number"
  ).all(sequenceId);

  const startDate = options.startDate ? new Date(options.startDate) : new Date();
  const senderName = options.senderName || "[Your Name]";

  const rows = [];
  let cumulativeDelay = 0;

  for (const step of steps) {
    if (step.status === "sent" || step.status === "replied") continue;

    cumulativeDelay += step.send_delay_days;
    const sendDate = new Date(startDate);
    sendDate.setDate(sendDate.getDate() + cumulativeDelay);

    const sendDay = sendDate.getDay();
    if (sendDay === 0) sendDate.setDate(sendDate.getDate() + 1);
    if (sendDay === 6) sendDate.setDate(sendDate.getDate() + 2);

    let body = step.body || "";
    body = body.replace(/\[Your Name\]|\[AE_NAME\]/g, senderName);
    body = body.replace(/\[AE_TITLE\]/g, options.title || "Account Executive");
    body = body.replace(/\[Your Title\]/g, options.title || "Account Executive");

    const footer = `\nTo manage your sales outreach preferences or opt out, reply with your preference.\nAny information provided does not constitute financial, investment, or trading advice.`;

    rows.push({
      to: seq.stakeholder_email || "",
      subject: step.subject || "",
      body: body + footer,
      scheduled_date: sendDate.toISOString().split("T")[0],
      scheduled_time: options.sendTime || "08:30",
      step_number: step.step_number,
      sequence_id: sequenceId,
      stakeholder_name: seq.stakeholder_name,
      company_id: seq.company_id,
      status: step.status,
      needs_email: !seq.stakeholder_email,
      needs_review: true,
    });
  }

  return {
    sequence: seq,
    rows,
    metadata: {
      total_steps: steps.length,
      pending_steps: rows.length,
      sent_steps: steps.filter((s) => s.status === "sent").length,
      needs_email: !seq.stakeholder_email,
      start_date: startDate.toISOString().split("T")[0],
    },
  };
}

export function exportMultipleSequencesForYAMM(companyId, options = {}) {
  const sequences = db.prepare(
    "SELECT * FROM email_sequences WHERE company_id = ? ORDER BY created_at"
  ).all(companyId);

  const allRows = [];
  for (const seq of sequences) {
    const exported = exportSequenceForYAMM(seq.id, options);
    if (exported) {
      allRows.push(...exported.rows);
    }
  }

  allRows.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  return allRows;
}

export function generateCSV(rows) {
  const headers = [
    "To",
    "Subject",
    "Body",
    "Scheduled Date",
    "Scheduled Time",
    "Step #",
    "Stakeholder",
    "Status",
    "Needs Email",
    "Needs Review",
  ];

  const escapeCsv = (val) => {
    const str = String(val || "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines = [headers.map(escapeCsv).join(",")];
  for (const row of rows) {
    lines.push([
      escapeCsv(row.to),
      escapeCsv(row.subject),
      escapeCsv(row.body),
      escapeCsv(row.scheduled_date),
      escapeCsv(row.scheduled_time),
      escapeCsv(row.step_number),
      escapeCsv(row.stakeholder_name),
      escapeCsv(row.status),
      escapeCsv(row.needs_email ? "YES - ADD EMAIL" : ""),
      escapeCsv(row.needs_review ? "REVIEW" : "OK"),
    ].join(","));
  }

  return lines.join("\n");
}

export function generateGoogleSheetsJSON(rows) {
  return rows.map((row) => ({
    "To": row.to || "⚠️ ADD EMAIL",
    "Subject": row.subject,
    "Body": row.body,
    "Scheduled Date": row.scheduled_date,
    "Scheduled Time": row.scheduled_time,
    "Step": row.step_number,
    "Stakeholder": row.stakeholder_name,
    "Status": row.status,
    "Flags": [
      row.needs_email ? "NEEDS_EMAIL" : null,
      row.needs_review ? "NEEDS_REVIEW" : null,
    ].filter(Boolean).join(", "),
  }));
}

export function pauseSequenceOnReply(sequenceId, replyType = "positive") {
  if (replyType === "ooo") {
    const steps = db.prepare(
      "SELECT * FROM email_steps WHERE sequence_id = ? AND status = 'pending' ORDER BY step_number"
    ).all(sequenceId);

    for (const step of steps) {
      db.prepare(
        "UPDATE email_steps SET send_delay_days = send_delay_days + 7 WHERE id = ?"
      ).run(step.id);
    }

    return { action: "delayed", days_added: 7, reason: "OOO detected" };
  }

  db.prepare(
    "UPDATE email_steps SET status = 'paused' WHERE sequence_id = ? AND status = 'pending'"
  ).run(sequenceId);

  db.prepare(
    "UPDATE email_sequences SET status = ? WHERE id = ?"
  ).run(replyType === "positive" ? "replied" : "closed", sequenceId);

  return { action: "paused", reason: `Reply received (${replyType})` };
}

export function resumeSequence(sequenceId) {
  db.prepare(
    "UPDATE email_steps SET status = 'pending' WHERE sequence_id = ? AND status = 'paused'"
  ).run(sequenceId);

  db.prepare(
    "UPDATE email_sequences SET status = 'active' WHERE id = ?"
  ).run(sequenceId);

  return { action: "resumed" };
}
