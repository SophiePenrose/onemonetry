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
import { normalizeEmailBodyForOutbound } from "./email-sequences.js";
import { MANDATORY_OUTREACH_FOOTER } from "./email-qc.js";

const COMPLIANCE_FOOTER = MANDATORY_OUTREACH_FOOTER;

function stripSignatureAndLegacyFooter(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\[(?:Your\s+Name|AE_NAME|Your\s+Title|AE_TITLE)\]/gi, "").trimEnd());

  const isLegalLine = (line) => /^(To manage your sales outreach preferences|Any information provided is not intended to be|As part of our sales process|For more details, please refer to our privacy notice|revolut\.com\/business|\[Title\]\s*\|\s*Revolut Business|Sophie Louise Penrose|---)/i.test(line.trim());
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

const FORBIDDEN_MINUTES = new Set([0, 15, 30, 45]);

const PERSONA_SEND_TIMES = {
  cfo_ceo: {
    proof: "07:23",
    nudge_1: "10:23",
    depth: "09:23",
    nudge_2: "10:23",
    provocation: "09:37",
    peer_benchmark: "09:37",
    close: "08:23",
  },
  finance_director: {
    proof: "09:37",
    nudge_1: "11:23",
    depth: "14:23",
    nudge_2: "11:37",
    provocation: "09:37",
    peer_benchmark: "09:37",
    close: "08:37",
  },
  treasury: {
    proof: "10:23",
    nudge_1: "10:37",
    depth: "10:23",
    nudge_2: "10:37",
    provocation: "10:23",
    peer_benchmark: "10:23",
    close: "08:23",
  },
  founder: {
    proof: "19:23",
    nudge_1: "09:23",
    depth: "08:23",
    nudge_2: "09:37",
    provocation: "09:23",
    peer_benchmark: "09:23",
    close: "08:23",
  },
  default: {
    proof: "08:37",
    nudge_1: "10:23",
    depth: "09:37",
    nudge_2: "10:37",
    provocation: "09:37",
    peer_benchmark: "09:37",
    close: "08:37",
  },
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeSendTime(rawTime, fallback = "08:37") {
  const selected = String(rawTime || "").trim() || fallback;
  const match = selected.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return fallback;
  }

  let hour = Number.parseInt(match[1], 10);
  let minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }

  while (FORBIDDEN_MINUTES.has(minute)) {
    minute += 7;
    if (minute >= 60) {
      minute -= 60;
      hour = (hour + 1) % 24;
    }
  }

  return `${pad2(hour)}:${pad2(minute)}`;
}

function resolvePersonaBucket(stakeholderRole) {
  const role = String(stakeholderRole || "").toLowerCase();
  if (role.includes("cfo") || role.includes("chief financial") || role.includes("ceo") || role.includes("chief executive")) {
    return "cfo_ceo";
  }
  if (role.includes("treasury")) {
    return "treasury";
  }
  if (role.includes("founder")) {
    return "founder";
  }
  if (role.includes("finance director") || role.includes("financial director")) {
    return "finance_director";
  }
  return "default";
}

function getDefaultStepSendTime(sequence, step) {
  const personaBucket = resolvePersonaBucket(sequence?.stakeholder_role);
  const table = PERSONA_SEND_TIMES[personaBucket] || PERSONA_SEND_TIMES.default;
  const stepType = String(step?.step_type || "depth").toLowerCase();
  const selected = table[stepType] || PERSONA_SEND_TIMES.default[stepType] || "08:37";
  return normalizeSendTime(selected);
}

function shiftWeekendForward(date) {
  const d = new Date(date);
  const sendDay = d.getDay();
  if (sendDay === 0) d.setDate(d.getDate() + 1);
  if (sendDay === 6) d.setDate(d.getDate() + 2);
  return d;
}

function hasReply(steps) {
  return steps.some((step) => step.status === "replied" || !!step.replied_at);
}

function wasOpened(step) {
  if (!step) return false;
  return step.status === "opened" || !!step.opened_at;
}

function meetsSendCondition(step, allSteps) {
  const condition = String(step?.send_condition || "always").toLowerCase();
  if (condition === "always") return true;

  if (condition === "no_reply_yet") {
    return !hasReply(allSteps);
  }

  if (condition === "opened_no_reply_after_step_1") {
    const stepOne = allSteps.find((item) => Number(item.step_number) === 1);
    return wasOpened(stepOne) && !hasReply(allSteps);
  }

  if (condition === "opened_no_reply_after_step_3") {
    const stepThree = allSteps.find((item) => Number(item.step_number) === 3);
    return wasOpened(stepThree) && !hasReply(allSteps);
  }

  return true;
}

const COMPLIANCE_FOOTER = "To manage your sales outreach preferences or opt out, reply with your preference.\nAny information provided does not constitute financial, investment, or trading advice.";

function stripSignatureAndLegacyFooter(text) {
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

export function exportSequenceForYAMM(sequenceId, options = {}) {
  const seq = db.prepare("SELECT * FROM email_sequences WHERE id = ?").get(sequenceId);
  if (!seq) return null;

  const steps = db.prepare(
    "SELECT * FROM email_steps WHERE sequence_id = ? ORDER BY step_number"
  ).all(sequenceId);

  const startDate = options.startDate ? new Date(options.startDate) : new Date();
  const includeComplianceFooter = options.includeComplianceFooter !== false;
  const requireManualReview = options.requireManualReview !== false;

  const pendingSteps = steps.filter((step) => step.status === "pending");
  const pendingReviewSteps = pendingSteps
    .filter((step) => Number(step.requires_manual_review || 0) === 1 && String(step.review_status || "pending") !== "reviewed")
    .map((step) => ({
      step_number: step.step_number,
      step_type: step.step_type,
      review_status: step.review_status,
      edited_at: step.edited_at,
      reviewed_at: step.reviewed_at,
    }));

  if (requireManualReview && pendingReviewSteps.length > 0) {
    return {
      sequence: seq,
      rows: [],
      blocked: true,
      metadata: {
        total_steps: steps.length,
        pending_steps: pendingSteps.length,
        pending_review_steps: pendingReviewSteps,
        sent_steps: steps.filter((s) => s.status === "sent").length,
        needs_email: !seq.stakeholder_email,
        start_date: startDate.toISOString().split("T")[0],
      },
    };
  }

  const rows = [];
  const skippedByCondition = [];

  for (const step of steps) {
    if (step.status === "sent" || step.status === "replied") continue;

    const conditionMet = meetsSendCondition(step, steps);
    if (!conditionMet) {
      skippedByCondition.push({
        step_number: step.step_number,
        step_type: step.step_type,
        send_condition: step.send_condition,
      });
      continue;
    }

    const delayDays = Number.parseInt(String(step.send_delay_days || 0), 10);
    const sendDate = new Date(startDate);
    sendDate.setDate(sendDate.getDate() + (Number.isFinite(delayDays) ? delayDays : 0));
    const normalizedDate = shiftWeekendForward(sendDate);

    const requestedTime = options.sendTime ? normalizeSendTime(options.sendTime) : null;
    const scheduledTime = requestedTime || getDefaultStepSendTime(seq, step);

    let body = normalizeEmailBodyForOutbound(stripSignatureAndLegacyFooter(step.body || ""), {
      stakeholderName: seq.stakeholder_name,
      stepType: step.step_type,
    });
    if (includeComplianceFooter && !/As part of our sales process/i.test(body)) {
      body = `${body}\n\n${COMPLIANCE_FOOTER}`;
    }

    rows.push({
      to: seq.stakeholder_email || "",
      subject: step.subject || "",
      body,
      scheduled_date: normalizedDate.toISOString().split("T")[0],
      scheduled_time: scheduledTime,
      step_number: step.step_number,
      step_type: step.step_type,
      send_condition: step.send_condition,
      review_status: step.review_status,
      sequence_id: sequenceId,
      stakeholder_name: seq.stakeholder_name,
      company_id: seq.company_id,
      status: step.status,
      needs_email: !seq.stakeholder_email,
      needs_review: String(step.review_status || "pending") !== "reviewed",
    });
  }

  return {
    sequence: seq,
    rows,
    blocked: false,
    metadata: {
      total_steps: steps.length,
      pending_steps: rows.length,
      sent_steps: steps.filter((s) => s.status === "sent").length,
      needs_email: !seq.stakeholder_email,
      start_date: startDate.toISOString().split("T")[0],
      skipped_by_condition: skippedByCondition,
      require_manual_review: requireManualReview,
    },
  };
}

export function exportMultipleSequencesForYAMM(companyId, options = {}) {
  const sequences = db.prepare(
    "SELECT * FROM email_sequences WHERE company_id = ? ORDER BY created_at"
  ).all(companyId);

  const allRows = [];
  const blockedSequences = [];
  for (const seq of sequences) {
    const exported = exportSequenceForYAMM(seq.id, options);
    if (exported) {
      if (exported.blocked) {
        blockedSequences.push({
          sequence_id: seq.id,
          stakeholder_name: seq.stakeholder_name,
          pending_review_steps: exported.metadata?.pending_review_steps || [],
        });
        continue;
      }
      allRows.push(...exported.rows);
    }
  }

  allRows.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  return {
    rows: allRows,
    blocked_sequences: blockedSequences,
  };
}

export function generateCSV(rows) {
  const headers = [
    "To",
    "Subject",
    "Body",
    "Scheduled Date",
    "Scheduled Time",
    "Step #",
    "Step Type",
    "Send Condition",
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
      escapeCsv(row.step_type),
      escapeCsv(row.send_condition),
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
    "Step Type": row.step_type,
    "Send Condition": row.send_condition,
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
