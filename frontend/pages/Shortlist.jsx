import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { TableSkeleton } from "../components/LoadingSkeleton";

const STATE_META = {
  new_candidate: { label: "New", color: "#6c757d" },
  shortlisted: { label: "Shortlisted", color: "#0075EB" },
  selected_for_outreach: { label: "Outreach", color: "#6f42c1" },
  in_cadence: { label: "In Cadence", color: "#e67e22" },
  active_opportunity: { label: "Active Opp", color: "#20c997" },
  closed_won: { label: "Won", color: "#0a8754" },
  closed_lost: { label: "Lost", color: "#c0392b" },
  revisit_later: { label: "Revisit", color: "#95a5a6" },
  held_for_review: { label: "Held", color: "#f39c12" },
};

const ANALYSIS_META = {
  ready: { label: "Ready", color: "#0a8754" },
  queued: { label: "Queued", color: "#d97706" },
  failed: { label: "Failed", color: "#c0392b" },
  none: { label: "Pending", color: "#6b7280" },
};

const STATUS_HEALTH_META = {
  low: {
    label: "Status stable",
    badge: "Status Stable",
    color: "#0f766e",
    text: "#065f46",
    background: "#ecfdf5",
  },
  medium: {
    label: "Status watch",
    badge: "Status Watch",
    color: "#d97706",
    text: "#92400e",
    background: "#fffbeb",
  },
  high: {
    label: "Status risk",
    badge: "Status Risk",
    color: "#b91c1c",
    text: "#991b1b",
    background: "#fef2f2",
  },
  unknown: {
    label: "Status unknown",
    badge: "Status Unknown",
    color: "#475569",
    text: "#475569",
    background: "#f8fafc",
  },
};

const TURNOVER_BANDS = [
  { value: "all", label: "All turnover bands" },
  { value: "15-25", label: "GBP 15M-25M" },
  { value: "25-50", label: "GBP 25M-50M" },
  { value: "50-100", label: "GBP 50M-100M" },
  { value: "100-500", label: "GBP 100M-500M" },
  { value: "500+", label: "GBP 500M+" },
];

const SORT_OPTIONS = [
  { value: "priority_score", label: "Priority score" },
  { value: "combined_score", label: "Composite score" },
  { value: "name", label: "Company name" },
  { value: "industry", label: "Industry" },
  { value: "segment", label: "Segment" },
  { value: "turnover", label: "Turnover" },
  { value: "best_motion", label: "Best motion" },
  { value: "growth_trend", label: "Growth trend" },
  { value: "workflow_state", label: "Workflow status" },
  { value: "filing_count", label: "Filing count" },
  { value: "latest_filing_date", label: "Latest filing date" },
  { value: "analysis_status", label: "Analysis status" },
];

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "1a", label: "Source 1a" },
  { value: "1b", label: "Source 1b" },
  { value: "2", label: "Source 2" },
  { value: "3", label: "Source 3" },
];

const SOURCE_META = {
  "1a": { label: "1a", title: "Monthly bulk backfill", color: "#475569" },
  "1b": { label: "1b", title: "Monthly scheduled filings", color: "#0f766e" },
  "2": { label: "2", title: "Twice-weekly filings", color: "#2563eb" },
  "3": { label: "3", title: "Mid-market CSV pipeline", color: "#9333ea" },
  unknown: { label: "?", title: "Unknown source", color: "#6b7280" },
};

const TIER_OPTIONS = [
  { value: "all", label: "All tiers" },
  { value: "A", label: "Tier A" },
  { value: "B", label: "Tier B" },
  { value: "C", label: "Tier C" },
];

const EXPORT_STEP_PRESETS = [
  { value: "email1", label: "Email 1 only", maxStep: 1 },
  { value: "email1_n1", label: "Email 1 + Nudge 1", maxStep: 2 },
  { value: "email1_n1_email2", label: "Email 1 + Nudge 1 + Email 2", maxStep: 3 },
  { value: "full", label: "Full pending cadence", maxStep: Number.POSITIVE_INFINITY },
];

const POST_EXPORT_STATE_OPTIONS = [
  { value: "none", label: "Do not change workflow state" },
  { value: "selected_for_outreach", label: "Mark selected as outreach" },
  { value: "in_cadence", label: "Mark selected as in cadence" },
];

const CARRYOVER_ACTIVE_STATES = new Set(["new_candidate", "shortlisted", "selected_for_outreach"]);
const REVIEWED_WORKFLOW_STATES = new Set(["selected_for_outreach", "in_cadence", "active_opportunity", "closed_won", "closed_lost", "revisit_later", "held_for_review"]);
const EXPORTED_WORKFLOW_STATES = new Set(["in_cadence", "active_opportunity", "closed_won"]);
const FORBIDDEN_SEND_MINUTES = new Set([0, 15, 30, 45]);
const STALE_SEQUENCE_DRAFT_DAYS = 14;

function getWeekStartMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseSequenceTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const iso = /[zZ]$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? millis : null;
}

function sequenceLatestTimestamp(sequence) {
  return Math.max(
    parseSequenceTimestamp(sequence?.updated_at) || 0,
    parseSequenceTimestamp(sequence?.created_at) || 0
  );
}

function sequenceDraftAgeDays(sequence) {
  const latest = sequenceLatestTimestamp(sequence);
  if (!latest) return null;
  return Math.max(0, Math.floor((Date.now() - latest) / 86400000));
}

function sequenceDraftFreshnessLabel(sequence) {
  const ageDays = sequenceDraftAgeDays(sequence);
  if (ageDays === null) return "updated date unavailable";
  if (ageDays === 0) return "updated today";
  if (ageDays === 1) return "updated 1 day ago";
  return `updated ${ageDays} days ago`;
}

function daysSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  const now = new Date();
  const ms = now.getTime() - d.getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function filingAgeLabel(value) {
  const days = daysSince(value);
  if (days === null) return "Unknown";
  if (days < 1) return "Today";
  return `Filed ${days}d`;
}

function normalizeStatusBand(value) {
  const band = String(value || "").trim().toLowerCase();
  if (band === "low" || band === "medium" || band === "high") return band;
  return "unknown";
}

function formatStatusSeverityPercent(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return `${Math.round(Math.max(0, Math.min(score, 1)) * 100)}%`;
}

function formatStatusIncidentAge(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return null;
  if (days < 1) return "<1d ago";
  return `${Math.round(days)}d ago`;
}

function inferSourceBucket(source, latestFilingDate) {
  const raw = String(source || "").toLowerCase();
  const filingAge = daysSince(latestFilingDate);

  if (raw.includes("csv")) return "3";
  if (raw.startsWith("daily:")) return "2";

  if (raw.startsWith("monthly:")) {
    if (filingAge !== null && filingAge > 120) return "1a";
    return "1b";
  }

  if (raw.includes("backfill") || raw.includes("bulk")) return "1a";
  if (raw.includes("scheduled")) return "1b";

  return "unknown";
}

function sourceBucketForCompany(company) {
  const explicit = String(company?.source_type || "").trim();
  if (explicit) return explicit;
  return inferSourceBucket(company?.source, company?.latest_filing_date);
}

function normalizeSendTime(rawTime, fallback = "08:37") {
  const selected = String(rawTime || "").trim() || fallback;
  const match = selected.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;

  let hour = Number.parseInt(match[1], 10);
  let minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }

  while (FORBIDDEN_SEND_MINUTES.has(minute)) {
    minute += 7;
    if (minute >= 60) {
      minute -= 60;
      hour = (hour + 1) % 24;
    }
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isDateInsideWeek(value, weekStart, weekEnd) {
  const d = parseDate(value);
  if (!d) return false;

  const normalized = new Date(d);
  normalized.setHours(0, 0, 0, 0);
  return normalized.getTime() >= weekStart.getTime() && normalized.getTime() <= weekEnd.getTime();
}

function computeCarryoverPriority(company, carryoverDays = 0) {
  const baseScore = Number(company?.priority_score ?? company?.combined_score ?? company?.composite_score ?? 0);
  let score = baseScore * 100;
  score += Math.min(carryoverDays, 45);
  score += company?.analysis_status === "ready" ? 8 : company?.analysis_status === "queued" ? 2 : 0;
  score += company?.score_tier === "A" ? 12 : company?.score_tier === "B" ? 6 : 0;
  return Math.round(score * 10) / 10;
}

function buildYammCsv(rows) {
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
    "Company",
  ];

  function escapeCsv(value) {
    const str = String(value || "");
    if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
      return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
  }

  const lines = [headers.map(escapeCsv).join(",")];

  rows.forEach((row) => {
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
      escapeCsv(row.company_name),
    ].join(","));
  });

  return lines.join("\n");
}

function buildGoogleSheetsJson(rows) {
  return rows.map((row) => ({
    To: row.to || "⚠️ ADD EMAIL",
    Subject: row.subject,
    Body: row.body,
    "Scheduled Date": row.scheduled_date,
    "Scheduled Time": row.scheduled_time,
    Step: row.step_number,
    "Step Type": row.step_type,
    "Send Condition": row.send_condition,
    Stakeholder: row.stakeholder_name,
    Status: row.status,
    Flags: [
      row.needs_email ? "NEEDS_EMAIL" : null,
      row.needs_review ? "NEEDS_REVIEW" : null,
    ].filter(Boolean).join(", "),
  }));
}

function buildMissingEmailCsv(rows) {
  const headers = [
    "Company",
    "Stakeholder",
    "Sequence ID",
    "Current Email",
    "First Step #",
    "First Step Type",
    "Example Subject",
    "Action Required",
  ];

  const escapeCsv = (value) => {
    const str = String(value || "");
    if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
      return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
  };

  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    const key = [
      String(row.company_id || ""),
      String(row.sequence_id || ""),
      String(row.stakeholder_name || "").toLowerCase(),
    ].join("::");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const lines = [headers.map(escapeCsv).join(",")];
  for (const row of deduped) {
    lines.push([
      escapeCsv(row.company_name),
      escapeCsv(row.stakeholder_name),
      escapeCsv(row.sequence_id),
      escapeCsv(row.current_email),
      escapeCsv(row.step_number),
      escapeCsv(row.step_type),
      escapeCsv(row.subject),
      escapeCsv("Add stakeholder email before send"),
    ].join(","));
  }

  return lines.join("\n");
}

function triggerTextDownload(fileName, content, mimeType = "text/plain;charset=utf-8;") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function triggerCsvDownload(fileName, csvText) {
  triggerTextDownload(fileName, csvText, "text/csv;charset=utf-8;");
}

function triggerJsonDownload(fileName, payload) {
  triggerTextDownload(fileName, JSON.stringify(payload, null, 2), "application/json;charset=utf-8;");
}

function scoreTier(company) {
  const score = Number(company?.combined_score ?? company?.composite_score ?? 0);
  if (score >= 0.78) return "A";
  if (score >= 0.62) return "B";
  return "C";
}

function formatTurnover(value) {
  if (!value) return "-";
  if (value >= 1000000000) return `GBP ${(value / 1000000000).toFixed(1)}B`;
  if (value >= 1000000) return `GBP ${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `GBP ${(value / 1000).toFixed(0)}K`;
  return `GBP ${value}`;
}

function trimSentence(value, max = 170) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function Badge({ text, bg }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color: "#fff",
        background: bg || "#888",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

Badge.propTypes = {
  text: PropTypes.string.isRequired,
  bg: PropTypes.string,
};

function SourceBadge({ bucket }) {
  const meta = SOURCE_META[bucket] || SOURCE_META.unknown;
  return (
    <span
      title={meta.title}
      style={{
        display: "inline-block",
        borderRadius: 999,
        padding: "2px 7px",
        fontSize: 10,
        fontWeight: 700,
        color: "#fff",
        background: meta.color,
      }}
    >
      {meta.label}
    </span>
  );
}

SourceBadge.propTypes = {
  bucket: PropTypes.string,
};

function buildBriefSignals(company, detail) {
  const analysis = detail?.analysis || {};
  const topThemes = Array.isArray(analysis.themes) ? analysis.themes.slice(0, 2) : [];
  const statusSignals = detail?.reputation_signals || company || {};
  const statusBand = normalizeStatusBand(statusSignals.status_health_band);
  const statusMeta = STATUS_HEALTH_META[statusBand] || STATUS_HEALTH_META.unknown;
  const statusSeverity = formatStatusSeverityPercent(statusSignals.status_incident_severity_score);
  const statusIncidentAge = formatStatusIncidentAge(statusSignals.status_recent_incident_age_days);
  const statusOpenIncidents = Math.max(0, Number(statusSignals.status_incidents_open || 0));
  const statusMajorOpenIncidents = Math.max(0, Number(statusSignals.status_major_incidents_open || 0));

  const firstPain = Array.isArray(analysis.pain_indicators) ? analysis.pain_indicators[0] : null;
  const firstPainText = typeof firstPain === "string"
    ? firstPain
    : (firstPain?.pain || firstPain?.indicator || "");

  const useCases = Array.isArray(analysis?.level5_extraction?.revolut_opportunity?.recommended_use_cases)
    ? analysis.level5_extraction.revolut_opportunity.recommended_use_cases
    : [];

  const primaryUseCase = useCases[0] || null;
  const firstStakeholder = Array.isArray(detail?.stakeholders) ? detail.stakeholders[0] : null;

  const whyCompany = [];
  if (analysis.summary) whyCompany.push(trimSentence(analysis.summary, 220));
  if (topThemes.length > 0) whyCompany.push(`Themes: ${topThemes.join(", ")}`);
  if (firstPainText) whyCompany.push(`Pain signal: ${trimSentence(firstPainText, 140)}`);

  const whyNow = [];
  if (company.latest_filing_date) whyNow.push(`${filingAgeLabel(company.latest_filing_date)} (${company.latest_filing_date})`);
  if (company.growth_trend && company.growth_trend !== "unknown") whyNow.push(`Growth trend: ${company.growth_trend}`);
  if (statusBand !== "unknown" || statusSeverity || statusIncidentAge) {
    const statusLine = [statusMeta.label];
    if (statusSeverity) statusLine.push(`severity ${statusSeverity}`);
    if (statusIncidentAge) statusLine.push(`last incident ${statusIncidentAge}`);
    if (statusOpenIncidents > 0) {
      statusLine.push(`open incidents ${statusOpenIncidents}${statusMajorOpenIncidents > 0 ? ` (${statusMajorOpenIncidents} major)` : ""}`);
    }
    whyNow.push(`Status health: ${statusLine.join(" · ")}`);
  }
  whyNow.push(`Analysis: ${(company.analysis_status || "none").replaceAll("_", " ")}`);

  const angle = [];
  if (company.best_motion) angle.push(`Primary: ${company.best_motion}`);
  if (primaryUseCase?.product) {
    angle.push(`Suggested: ${primaryUseCase.product}${primaryUseCase.why_fit ? ` - ${trimSentence(primaryUseCase.why_fit, 120)}` : ""}`);
  }

  const stakeholder = [];
  if (firstStakeholder?.name) {
    stakeholder.push(`${firstStakeholder.name}${firstStakeholder.role ? `, ${firstStakeholder.role}` : ""}`);
  }
  if (firstStakeholder?.email) stakeholder.push(firstStakeholder.email);

  const watchFor = [];
  if (company.below_threshold) watchFor.push("Below turnover threshold flag present");
  if (company.suppressed) watchFor.push(company.suppression_reason || "Suppressed in shortlist");
  if (company.analysis_status === "failed") watchFor.push("Analysis failed, retry may be needed");
  if (company.filter_reason && company.filter_reason !== "eligible") {
    watchFor.push(`Pipeline reason: ${String(company.filter_reason).replaceAll("_", " ")}`);
  }
  if (statusBand === "high") watchFor.push("Status provider reports elevated incident risk");
  if (statusOpenIncidents > 0) {
    watchFor.push(`Status incidents currently open: ${statusOpenIncidents}${statusMajorOpenIncidents > 0 ? ` (${statusMajorOpenIncidents} major)` : ""}`);
  }

  return {
    whyCompany,
    whyNow,
    angle,
    stakeholder,
    watchFor,
  };
}

export default function Shortlist({ onSelectCompany, onShowAddCompany }) {
  const [companies, setCompanies] = useState([]);
  const [meta, setMeta] = useState(null);
  const [queueStatus, setQueueStatus] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [stateFilter, setStateFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [showSuppressed, setShowSuppressed] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [turnoverBand, setTurnoverBand] = useState("all");
  const [sortBy, setSortBy] = useState("priority_score");
  const [sortDir, setSortDir] = useState("desc");

  const [queueBusy, setQueueBusy] = useState(false);

  const [activeCompanyId, setActiveCompanyId] = useState(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState(new Set());

  const [companyDetail, setCompanyDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [sequences, setSequences] = useState([]);
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [copiedStep, setCopiedStep] = useState(null);

  const [weekOffset, setWeekOffset] = useState(0);
  const [weekFocus, setWeekFocus] = useState("all");

  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportStepPreset, setExportStepPreset] = useState("email1_n1_email2");
  const [exportStartDate, setExportStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [exportSendTime, setExportSendTime] = useState("08:37");
  const [exportMissingEmailMode, setExportMissingEmailMode] = useState("skip");
  const [postExportState, setPostExportState] = useState("none");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [exportResult, setExportResult] = useState(null);

  const fetchData = useCallback(async (suppressedFlag, sortByValue, sortDirValue, turnoverBandValue) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (suppressedFlag) params.set("show_suppressed", "true");
    params.set("sort_by", sortByValue);
    params.set("sort_dir", sortDirValue);
    params.set("turnover_band", turnoverBandValue);

    try {
      const qs = params.toString();
      const [shortlistRes, queueRes] = await Promise.all([
        fetch(`/api/unified-shortlist${qs ? `?${qs}` : ""}`),
        fetch("/api/analysis-queue/status"),
      ]);

      if (!shortlistRes.ok) throw new Error("Failed to fetch shortlist");

      const shortlistData = await shortlistRes.json();
      setCompanies(shortlistData.companies || []);
      setMeta(shortlistData.meta || null);

      if (queueRes.ok) {
        const queueData = await queueRes.json();
        setQueueStatus(queueData);
      }
    } catch (err) {
      setError(err.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(false, "priority_score", "desc", "all");
  }, [fetchData]);

  useEffect(() => {
    const timer = setInterval(() => {
      fetchData(showSuppressed, sortBy, sortDir, turnoverBand);
    }, 20000);
    return () => clearInterval(timer);
  }, [fetchData, showSuppressed, sortBy, sortDir, turnoverBand]);

  const weekContext = useMemo(() => {
    const start = addDays(getWeekStartMonday(), weekOffset * 7);
    const end = addDays(start, 6);
    return {
      weekStart: start,
      weekEnd: end,
      weekLabel: start.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
      weekEndLabel: end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    };
  }, [weekOffset]);

  const { weekStart, weekEnd, weekLabel, weekEndLabel } = weekContext;

  const normalizedCompanies = useMemo(
    () => companies.map((c) => ({
      ...c,
      source_bucket: sourceBucketForCompany(c),
      source_family: c.source_family || null,
      filter_reason: c.filter_reason || null,
      score_tier: scoreTier(c),
    })),
    [companies]
  );

  const weeklyCompanies = useMemo(() => {
    return normalizedCompanies.map((company) => {
      const isNewThisWeek = isDateInsideWeek(company.latest_filing_date, weekStart, weekEnd);
      const isCarryover = !isNewThisWeek && CARRYOVER_ACTIVE_STATES.has(company.workflow_state);
      const carryoverDays = isCarryover ? (daysSince(company.latest_filing_date) ?? 0) : 0;

      return {
        ...company,
        is_new_this_week: isNewThisWeek,
        is_carryover: isCarryover,
        carryover_days: carryoverDays,
        carryover_priority: isCarryover ? computeCarryoverPriority(company, carryoverDays) : 0,
      };
    });
  }, [normalizedCompanies, weekStart, weekEnd]);

  const stateCounts = useMemo(() => {
    const counts = {};
    weeklyCompanies.forEach((c) => {
      counts[c.workflow_state] = (counts[c.workflow_state] || 0) + 1;
    });
    return counts;
  }, [weeklyCompanies]);

  const sourceCounts = useMemo(() => {
    const counts = { "1a": 0, "1b": 0, "2": 0, "3": 0, unknown: 0 };
    weeklyCompanies.forEach((c) => {
      counts[c.source_bucket] = (counts[c.source_bucket] || 0) + 1;
    });
    return counts;
  }, [weeklyCompanies]);

  const filteredCompanies = useMemo(() => {
    const byState = stateFilter === "all"
      ? weeklyCompanies
      : weeklyCompanies.filter((c) => c.workflow_state === stateFilter);

    const byTier = tierFilter === "all"
      ? byState
      : byState.filter((c) => c.score_tier === tierFilter);

    const bySource = sourceFilter === "all"
      ? byTier
      : byTier.filter((c) => c.source_bucket === sourceFilter);

    const byWeekFocus = weekFocus === "new"
      ? bySource.filter((c) => c.is_new_this_week)
      : weekFocus === "carryover"
        ? bySource.filter((c) => c.is_carryover)
        : bySource;

    const q = searchQuery.trim().toLowerCase();
    if (!q) return byWeekFocus;

    return byWeekFocus.filter((c) =>
      String(c.name || "").toLowerCase().includes(q)
      || String(c.industry || "").toLowerCase().includes(q)
      || String(c.company_number || "").toLowerCase().includes(q)
    );
  }, [weeklyCompanies, stateFilter, tierFilter, sourceFilter, weekFocus, searchQuery]);

  useEffect(() => {
    setSelectedCompanyIds((prev) => {
      const validIds = new Set(weeklyCompanies.map((c) => c.id));
      const filtered = [...prev].filter((id) => validIds.has(id));
      if (filtered.length === prev.size) return prev;
      return new Set(filtered);
    });
  }, [weeklyCompanies]);

  useEffect(() => {
    if (filteredCompanies.length === 0) {
      setActiveCompanyId(null);
      return;
    }

    const exists = filteredCompanies.some((c) => c.id === activeCompanyId);
    if (!exists) setActiveCompanyId(filteredCompanies[0].id);
  }, [filteredCompanies, activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId) {
      setCompanyDetail(null);
      setSequences([]);
      return;
    }

    let cancelled = false;

    async function loadActiveDetail() {
      setDetailLoading(true);
      setSequenceLoading(true);
      setDetailError(null);

      try {
        const [companyRes, seqRes] = await Promise.all([
          fetch(`/api/company/${encodeURIComponent(activeCompanyId)}`),
          fetch(`/api/email/sequences/${encodeURIComponent(activeCompanyId)}`),
        ]);

        if (!companyRes.ok) throw new Error("Failed to fetch company brief");

        const companyData = await companyRes.json();
        const seqData = seqRes.ok ? await seqRes.json() : { sequences: [] };

        if (!cancelled) {
          setCompanyDetail(companyData.company || null);
          setSequences(Array.isArray(seqData.sequences) ? seqData.sequences : []);
        }
      } catch (err) {
        if (!cancelled) {
          setDetailError(err.message || "Failed to load company brief");
          setCompanyDetail(null);
          setSequences([]);
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
          setSequenceLoading(false);
        }
      }
    }

    loadActiveDetail();

    return () => {
      cancelled = true;
    };
  }, [activeCompanyId]);

  function applySort(nextSortBy, nextSortDir) {
    setSortBy(nextSortBy);
    setSortDir(nextSortDir);
    fetchData(showSuppressed, nextSortBy, nextSortDir, turnoverBand);
  }

  function toggleSuppressed() {
    const next = !showSuppressed;
    setShowSuppressed(next);
    fetchData(next, sortBy, sortDir, turnoverBand);
  }

  async function handleProcessQueueNow() {
    setQueueBusy(true);
    try {
      await fetch("/api/analysis-queue/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: 5 }),
      });
      await fetchData(showSuppressed, sortBy, sortDir, turnoverBand);
    } finally {
      setQueueBusy(false);
    }
  }

  async function handleRetryFailed(companyNumber = null, event = null) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    setQueueBusy(true);

    try {
      await fetch("/api/analysis-queue/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(companyNumber ? { company_number: companyNumber } : {}),
      });
      await fetchData(showSuppressed, sortBy, sortDir, turnoverBand);
    } finally {
      setQueueBusy(false);
    }
  }

  function openBatchExportModal() {
    if (selectedCompanyIds.size === 0) return;
    setExportError(null);
    setExportResult(null);
    setExportStartDate(new Date().toISOString().slice(0, 10));
    setExportSendTime(normalizeSendTime(exportSendTime || "08:37"));
    setExportModalOpen(true);
  }

  function closeBatchExportModal() {
    if (exportBusy) return;
    setExportModalOpen(false);
  }

  async function handlePrepareBatchExport() {
    const selectedCompanies = weeklyCompanies.filter((c) => selectedCompanyIds.has(c.id));
    if (selectedCompanies.length === 0) {
      setExportError("Select at least one company before preparing export.");
      return;
    }

    setExportBusy(true);
    setExportError(null);
    setExportResult(null);

    const selectedById = new Map(selectedCompanies.map((company) => [company.id, company]));
    const preset = EXPORT_STEP_PRESETS.find((option) => option.value === exportStepPreset) || EXPORT_STEP_PRESETS[0];
    const maxStep = preset.maxStep;
    const normalizedTime = normalizeSendTime(exportSendTime || "08:37");
    const effectiveStartDate = exportStartDate || new Date().toISOString().slice(0, 10);

    setExportSendTime(normalizedTime);

    const params = new URLSearchParams({
      start_date: effectiveStartDate,
      send_time: normalizedTime,
    });

    const mergedRows = [];
    const missingEmailRows = [];
    const blockedSequences = [];
    const companiesWithoutSequences = [];
    const exportFailures = [];
    const transitionFailures = [];
    const transitionedCompanies = [];

    const companiesWithRows = new Set();

    let totalSequencesScanned = 0;
    let rowsNeedingEmail = 0;
    let skippedForMissingEmail = 0;
    let rowsBeforeMissingFilter = 0;

    try {
      for (const company of selectedCompanies) {
        let sequencesPayload;
        try {
          const seqRes = await fetch(`/api/email/sequences/${encodeURIComponent(company.id)}`);
          if (!seqRes.ok) {
            exportFailures.push({
              company_id: company.id,
              company_name: company.name,
              reason: `Failed to load sequences (${seqRes.status})`,
            });
            continue;
          }
          sequencesPayload = await seqRes.json();
        } catch (err) {
          exportFailures.push({
            company_id: company.id,
            company_name: company.name,
            reason: err.message || "Failed to load sequences",
          });
          continue;
        }

        const companySequences = Array.isArray(sequencesPayload?.sequences) ? sequencesPayload.sequences : [];
        if (companySequences.length === 0) {
          companiesWithoutSequences.push({ company_id: company.id, company_name: company.name });
          continue;
        }

        for (const sequence of companySequences) {
          totalSequencesScanned += 1;
          try {
            const exportRes = await fetch(`/api/email/export/json/${encodeURIComponent(sequence.id)}?${params.toString()}`);
            if (exportRes.status === 409) {
              const blockedPayload = await exportRes.json().catch(() => ({}));
              const pendingReviewSteps = blockedPayload?.metadata?.pending_review_steps
                || blockedPayload?.detail?.pending_review_steps
                || [];

              blockedSequences.push({
                company_id: company.id,
                company_name: company.name,
                sequence_id: sequence.id,
                stakeholder_name: sequence.stakeholder_name || "Unknown",
                pending_review_steps: pendingReviewSteps,
              });
              continue;
            }

            if (!exportRes.ok) {
              exportFailures.push({
                company_id: company.id,
                company_name: company.name,
                sequence_id: sequence.id,
                reason: `Sequence export failed (${exportRes.status})`,
              });
              continue;
            }

            const exportedPayload = await exportRes.json();
            const rawRows = Array.isArray(exportedPayload?.raw_rows) ? exportedPayload.raw_rows : [];

            rawRows.forEach((row) => {
              const numericStep = Number(row.step_number || 0);
              if (numericStep > maxStep) return;

              rowsBeforeMissingFilter += 1;

              const needsEmail = Boolean(row.needs_email) || !String(row.to || "").trim();
              if (needsEmail) {
                rowsNeedingEmail += 1;
                missingEmailRows.push({
                  company_id: company.id,
                  company_name: company.name,
                  sequence_id: sequence.id,
                  stakeholder_name: row.stakeholder_name || sequence.stakeholder_name || "Unknown",
                  current_email: row.to || "",
                  step_number: row.step_number,
                  step_type: row.step_type,
                  subject: row.subject || "",
                });
              }

              if (needsEmail && exportMissingEmailMode === "skip") {
                skippedForMissingEmail += 1;
                return;
              }

              mergedRows.push({
                ...row,
                needs_email: needsEmail,
                company_id: company.id,
                company_name: company.name,
                sequence_id: sequence.id,
              });

              companiesWithRows.add(company.id);
            });
          } catch (err) {
            exportFailures.push({
              company_id: company.id,
              company_name: company.name,
              sequence_id: sequence.id,
              reason: err.message || "Sequence export failed",
            });
          }
        }
      }

      if (postExportState !== "none" && companiesWithRows.size > 0) {
        for (const companyId of companiesWithRows) {
          try {
            const stateRes = await fetch(`/api/company/${encodeURIComponent(companyId)}/state`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                new_state: postExportState,
                note: `Batch export prepared (${preset.label})`,
              }),
            });

            if (!stateRes.ok) {
              const statePayload = await stateRes.json().catch(() => ({}));
              transitionFailures.push({
                company_id: companyId,
                company_name: selectedById.get(companyId)?.name || companyId,
                reason: statePayload.error || `Transition failed (${stateRes.status})`,
              });
              continue;
            }

            transitionedCompanies.push({
              company_id: companyId,
              company_name: selectedById.get(companyId)?.name || companyId,
            });
          } catch (err) {
            transitionFailures.push({
              company_id: companyId,
              company_name: selectedById.get(companyId)?.name || companyId,
              reason: err.message || "Transition failed",
            });
          }
        }
      }

      const csv = buildYammCsv(mergedRows);
      const sheetsJson = buildGoogleSheetsJson(mergedRows);
      const missingEmailCsv = buildMissingEmailCsv(missingEmailRows);
      const missingEmailContacts = new Set(
        missingEmailRows.map((row) => [
          String(row.company_id || ""),
          String(row.sequence_id || ""),
          String(row.stakeholder_name || "").toLowerCase(),
        ].join("::"))
      ).size;
      const weekKey = weekStart.toISOString().slice(0, 10);
      const fileName = `this-week-${weekKey}-${preset.value}.csv`;
      const sheetsFileName = `this-week-${weekKey}-${preset.value}-sheets.json`;
      const missingEmailFileName = `this-week-${weekKey}-${preset.value}-missing-emails.csv`;

      setExportResult({
        generated_at: new Date().toISOString(),
        selected_companies: selectedCompanies.length,
        sequences_scanned: totalSequencesScanned,
        rows_before_missing_filter: rowsBeforeMissingFilter,
        rows_exportable: mergedRows.length,
        rows_needing_email: rowsNeedingEmail,
        missing_email_contacts: missingEmailContacts,
        skipped_missing_email_rows: skippedForMissingEmail,
        blocked_sequences: blockedSequences,
        no_sequence_companies: companiesWithoutSequences,
        export_failures: exportFailures,
        transitioned_companies: transitionedCompanies,
        transition_failures: transitionFailures,
        step_preset: preset,
        start_date: effectiveStartDate,
        send_time: normalizedTime,
        csv,
        file_name: fileName,
        sheets_json: sheetsJson,
        sheets_file_name: sheetsFileName,
        missing_email_csv: missingEmailCsv,
        missing_email_file_name: missingEmailFileName,
      });

      if (transitionedCompanies.length > 0) {
        await fetchData(showSuppressed, sortBy, sortDir, turnoverBand);
      }
    } catch (err) {
      setExportError(err.message || "Failed to prepare export");
    } finally {
      setExportBusy(false);
    }
  }

  function handleDownloadPreparedCsv() {
    if (!exportResult?.csv) return;
    triggerCsvDownload(exportResult.file_name || "this-week-export.csv", exportResult.csv);
  }

  function handleDownloadPreparedSheetsJson() {
    if (!exportResult?.sheets_json || exportResult.rows_exportable === 0) return;
    triggerJsonDownload(
      exportResult.sheets_file_name || "this-week-export-sheets.json",
      exportResult.sheets_json
    );
  }

  function handleDownloadMissingEmailCsv() {
    if (!exportResult?.missing_email_csv || exportResult.rows_needing_email === 0) return;
    triggerCsvDownload(
      exportResult.missing_email_file_name || "this-week-missing-emails.csv",
      exportResult.missing_email_csv
    );
  }

  function toggleSelected(id) {
    setSelectedCompanyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedCompanyIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        filteredCompanies.forEach((c) => next.delete(c.id));
      } else {
        filteredCompanies.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  async function copyStep(step) {
    const payload = `Subject: ${step.subject || ""}\n\n${step.body || ""}`;
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedStep(step.step_number);
      setTimeout(() => setCopiedStep(null), 1500);
    } catch {
      setCopiedStep(null);
    }
  }

  async function copyAllSteps(steps) {
    const payload = steps
      .map((step) => `Step ${step.step_number}: ${step.subject || ""}\n${step.body || ""}`)
      .join("\n\n--------------------\n\n");
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedStep(-1);
      setTimeout(() => setCopiedStep(null), 1500);
    } catch {
      setCopiedStep(null);
    }
  }

  const weeklyCompanyById = useMemo(
    () => new Map(weeklyCompanies.map((company) => [company.id, company])),
    [weeklyCompanies],
  );

  const activeCompany = activeCompanyId ? weeklyCompanyById.get(activeCompanyId) || null : null;

  const latestSequence = useMemo(() => {
    if (!Array.isArray(sequences) || sequences.length === 0) return null;
    const sorted = [...sequences].sort((a, b) => sequenceLatestTimestamp(b) - sequenceLatestTimestamp(a));
    return sorted[0];
  }, [sequences]);

  const latestSequenceFreshness = latestSequence ? sequenceDraftFreshnessLabel(latestSequence) : null;
  const latestSequenceAgeDays = latestSequence ? sequenceDraftAgeDays(latestSequence) : null;
  const latestSequenceIsStale = Number.isFinite(latestSequenceAgeDays) && latestSequenceAgeDays > STALE_SEQUENCE_DRAFT_DAYS;

  const sequenceSteps = useMemo(() => {
    const steps = Array.isArray(latestSequence?.steps) ? latestSequence.steps : [];
    return [...steps].sort((a, b) => Number(a.step_number || 0) - Number(b.step_number || 0));
  }, [latestSequence]);

  const weeklySummary = useMemo(() => {
    let reviewedCount = 0;
    let exportedCount = 0;
    let tierACount = 0;
    let tierBCount = 0;
    let sourceFreshCount = 0;
    let newThisWeekCount = 0;

    const carryoverCompanies = [];

    for (const company of weeklyCompanies) {
      if (REVIEWED_WORKFLOW_STATES.has(company.workflow_state)) reviewedCount += 1;
      if (EXPORTED_WORKFLOW_STATES.has(company.workflow_state)) exportedCount += 1;
      if (company.score_tier === "A") tierACount += 1;
      if (company.score_tier === "B") tierBCount += 1;
      if (company.source_bucket === "2" || company.source_bucket === "1b") sourceFreshCount += 1;
      if (company.is_new_this_week) newThisWeekCount += 1;
      if (company.is_carryover) carryoverCompanies.push(company);
    }

    carryoverCompanies.sort((a, b) => Number(b.carryover_priority || 0) - Number(a.carryover_priority || 0));

    return {
      reviewedCount,
      exportedCount,
      tierACount,
      tierBCount,
      sourceFreshCount,
      newThisWeekCount,
      carryoverCount: carryoverCompanies.length,
      carryoverSpotlight: carryoverCompanies.slice(0, 3),
    };
  }, [weeklyCompanies]);

  const {
    reviewedCount,
    exportedCount,
    tierACount,
    tierBCount,
    sourceFreshCount,
    newThisWeekCount,
    carryoverCount,
    carryoverSpotlight,
  } = weeklySummary;

  const selectionSummary = useMemo(() => {
    let selectedVisibleCount = 0;
    let selectedTotalCount = 0;
    let allVisibleSelected = filteredCompanies.length > 0;

    for (const company of filteredCompanies) {
      if (selectedCompanyIds.has(company.id)) selectedVisibleCount += 1;
      else allVisibleSelected = false;
    }

    for (const company of weeklyCompanies) {
      if (selectedCompanyIds.has(company.id)) selectedTotalCount += 1;
    }

    return {
      selectedVisibleCount,
      selectedTotalCount,
      allVisibleSelected,
    };
  }, [filteredCompanies, weeklyCompanies, selectedCompanyIds]);

  const { selectedVisibleCount, selectedTotalCount, allVisibleSelected } = selectionSummary;

  const briefSignals = useMemo(
    () => buildBriefSignals(activeCompany || {}, companyDetail || {}),
    [activeCompany, companyDetail],
  );

  const briefStatus = useMemo(() => {
    const briefStatusSignals = companyDetail?.reputation_signals || activeCompany || {};
    const briefStatusBand = normalizeStatusBand(briefStatusSignals.status_health_band);
    const briefStatusMeta = STATUS_HEALTH_META[briefStatusBand] || STATUS_HEALTH_META.unknown;

    return {
      briefStatusBand,
      briefStatusMeta,
      briefStatusSeverity: formatStatusSeverityPercent(briefStatusSignals.status_incident_severity_score),
      briefStatusIncidentAge: formatStatusIncidentAge(briefStatusSignals.status_recent_incident_age_days),
      briefStatusOpenIncidents: Math.max(0, Number(briefStatusSignals.status_incidents_open || 0)),
      briefStatusMajorIncidents: Math.max(0, Number(briefStatusSignals.status_major_incidents_open || 0)),
      briefStatusDegradedComponents: Math.max(0, Number(briefStatusSignals.status_degraded_components || 0)),
    };
  }, [activeCompany, companyDetail]);

  const {
    briefStatusBand,
    briefStatusMeta,
    briefStatusSeverity,
    briefStatusIncidentAge,
    briefStatusOpenIncidents,
    briefStatusMajorIncidents,
    briefStatusDegradedComponents,
  } = briefStatus;

  if (loading && weeklyCompanies.length === 0) {
    return <TableSkeleton rows={8} />;
  }

  return (
    <div>
      <div style={{ marginBottom: 14, background: "#eef6ff", border: "1px solid #cfe2ff", borderRadius: 10, padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14, color: "#1d4e89" }}>Week of {weekLabel} to {weekEndLabel}</strong>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setWeekOffset((prev) => prev - 1)}
              style={{ border: "1px solid #cddcf2", borderRadius: 8, background: "#fff", padding: "4px 8px", cursor: "pointer", fontSize: 12 }}
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setWeekOffset((prev) => prev + 1)}
              style={{ border: "1px solid #cddcf2", borderRadius: 8, background: "#fff", padding: "4px 8px", cursor: "pointer", fontSize: 12 }}
            >
              Next
            </button>
          </div>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: "#35506c" }}>
          {weeklyCompanies.length} prospects · {tierACount} Tier A · {tierBCount} Tier B · {newThisWeekCount} new this week · {carryoverCount} carryover · {reviewedCount} reviewed · {exportedCount} exported · {sourceFreshCount} fresh-source prospects
        </div>
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {[{ value: "all", label: "All" }, { value: "new", label: `New this week (${newThisWeekCount})` }, { value: "carryover", label: `Carryover (${carryoverCount})` }].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setWeekFocus(opt.value)}
              style={{
                border: weekFocus === opt.value ? "1px solid #2563eb" : "1px solid #cddcf2",
                borderRadius: 999,
                background: weekFocus === opt.value ? "#eff6ff" : "#fff",
                color: weekFocus === opt.value ? "#1d4ed8" : "#33557a",
                padding: "4px 10px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {carryoverSpotlight.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#475569" }}>
            Carryover priority: {carryoverSpotlight.map((company) => `${company.name} (${Math.round(company.carryover_priority)})`).join(" · ")}
          </div>
        )}
      </div>

      {!loading && !error && queueStatus && (
        <div style={{ marginBottom: 12, background: "#fff", border: "1px solid #eceff3", borderRadius: 8, padding: "10px 12px", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#555" }}>
              <strong style={{ fontSize: 13 }}>Analysis Queue</strong>
              <span style={{ background: queueStatus.enabled ? "#dcfce7" : "#f3f4f6", color: queueStatus.enabled ? "#166534" : "#4b5563", padding: "2px 8px", borderRadius: 999 }}>
                {queueStatus.enabled ? "Worker On" : "Worker Off"}
              </span>
              <span>{queueStatus.counts?.queued || 0} queued</span>
              <span>{queueStatus.counts?.ready || 0} ready</span>
              {(queueStatus.counts?.failed || 0) > 0 && (
                <span style={{ color: "#b91c1c", fontWeight: 600 }}>{queueStatus.counts.failed} failed</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={handleProcessQueueNow}
                disabled={queueBusy}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #d5d9df", background: "#fff", cursor: queueBusy ? "wait" : "pointer", fontSize: 12 }}
              >
                {queueBusy ? "Working..." : "Process Now"}
              </button>
              <button
                type="button"
                onClick={() => handleRetryFailed()}
                disabled={queueBusy || (queueStatus.counts?.failed || 0) === 0}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #d5d9df", background: "#fff", cursor: (queueBusy || (queueStatus.counts?.failed || 0) === 0) ? "not-allowed" : "pointer", fontSize: 12 }}
              >
                Retry Failed
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>This Week</h2>
          <span style={{ color: "#6b7280", fontSize: 13 }}>{filteredCompanies.length} visible</span>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Search company or number"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, minWidth: 220 }}
          />
          <select
            value={turnoverBand}
            onChange={(e) => {
              const nextBand = e.target.value;
              setTurnoverBand(nextBand);
              fetchData(showSuppressed, sortBy, sortDir, nextBand);
            }}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" }}
          >
            {TURNOVER_BANDS.map((band) => (
              <option key={band.value} value={band.value}>{band.label}</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => {
              const nextSortBy = e.target.value;
              const nextSortDir = sortBy === nextSortBy ? sortDir : "desc";
              applySort(nextSortBy, nextSortDir);
            }}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" }}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => applySort(sortBy, sortDir === "desc" ? "asc" : "desc")}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 13 }}
          >
            {sortDir === "desc" ? "Desc" : "Asc"}
          </button>
          <button
            type="button"
            onClick={() => fetchData(showSuppressed, sortBy, sortDir, turnoverBand)}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 13 }}
          >
            Refresh
          </button>
          {onShowAddCompany && (
            <button
              type="button"
              onClick={onShowAddCompany}
              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
            >
              Add Company
            </button>
          )}
        </div>
      </div>

      {error && <div style={{ color: "#c0392b", marginBottom: 12 }}>Error: {error}</div>}

      {!loading && !error && meta && (meta.excluded > 0 || meta.suppressed > 0) && (
        <div style={{ fontSize: 12, color: "#888", marginBottom: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {meta.excluded > 0 && (
            <span style={{ background: "#fee2e2", color: "#991b1b", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.excluded} excluded
            </span>
          )}
          {meta.suppressed > 0 && (
            <span style={{ background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: 10, fontWeight: 500 }}>
              {meta.suppressed} suppressed
            </span>
          )}
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={showSuppressed} onChange={toggleSuppressed} style={{ cursor: "pointer" }} />
            <span>Show suppressed</span>
          </label>
        </div>
      )}

      <div className="this-week-grid">
        <section className="this-week-pane this-week-queue-pane">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Prospects</h3>
            <span style={{ fontSize: 12, color: "#64748b" }}>{filteredCompanies.length} items</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, background: "#fff" }}>
              {TIER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, background: "#fff" }}>
              {SOURCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{opt.value !== "all" ? ` (${sourceCounts[opt.value] || 0})` : ""}
                </option>
              ))}
            </select>
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={{ gridColumn: "1 / span 2", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, background: "#fff" }}>
              <option value="all">All statuses ({weeklyCompanies.length})</option>
              {Object.entries(STATE_META).map(([stateId, sm]) => {
                const count = stateCounts[stateId] || 0;
                if (count === 0) return null;
                return <option key={stateId} value={stateId}>{sm.label} ({count})</option>;
              })}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#475569" }}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} />
              Select all visible
            </label>
            <a href="/api/export/shortlist?format=csv" download style={{ fontSize: 12, color: "#0075EB", textDecoration: "none" }}>Download CSV</a>
          </div>

          {loading && <TableSkeleton rows={6} />}

          {!loading && filteredCompanies.length === 0 && (
            <div style={{ color: "#64748b", fontSize: 13, padding: 12, border: "1px dashed #d4dce6", borderRadius: 8 }}>
              No prospects match current filters.
            </div>
          )}

          {!loading && filteredCompanies.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 620, overflowY: "auto", paddingRight: 2 }}>
              {filteredCompanies.map((company) => {
                const isActive = company.id === activeCompanyId;
                const isChecked = selectedCompanyIds.has(company.id);
                const analysisMeta = ANALYSIS_META[company.analysis_status] || ANALYSIS_META.none;
                const sourceMeta = SOURCE_META[company.source_bucket] || SOURCE_META.unknown;
                const state = STATE_META[company.workflow_state] || STATE_META.new_candidate;
                const statusBand = normalizeStatusBand(company.status_health_band);
                const statusMeta = STATUS_HEALTH_META[statusBand] || STATUS_HEALTH_META.unknown;
                const statusSeverity = formatStatusSeverityPercent(company.status_incident_severity_score);
                const statusIncidentAge = formatStatusIncidentAge(company.status_recent_incident_age_days);
                const statusOpenIncidents = Math.max(0, Number(company.status_incidents_open || 0));
                const sourceTitle = company.source_family
                  ? String(company.source_family).replaceAll("_", " ")
                  : sourceMeta.title;

                return (
                  <button
                    key={company.id}
                    type="button"
                    onClick={() => setActiveCompanyId(company.id)}
                    style={{
                      textAlign: "left",
                      border: isActive ? "2px solid #0075EB" : "1px solid #dde3eb",
                      borderRadius: 10,
                      padding: 10,
                      background: isActive ? "#f3f8ff" : "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(event) => {
                          event.stopPropagation();
                          toggleSelected(company.id);
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <strong style={{ fontSize: 13, color: "#1f2937", flex: 1, minWidth: 0 }}>{company.name}</strong>
                      <span style={{ fontSize: 12, color: "#334155", fontWeight: 700 }}>{Number(company.combined_score || company.composite_score || 0).toFixed(2)}</span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                      <Badge text={`Tier ${company.score_tier}`} bg={company.score_tier === "A" ? "#047857" : company.score_tier === "B" ? "#2563eb" : "#6b7280"} />
                      <Badge text={analysisMeta.label} bg={analysisMeta.color} />
                      <Badge text={state.label} bg={state.color} />
                      {(statusBand !== "unknown" || statusSeverity || statusOpenIncidents > 0) && (
                        <Badge text={statusMeta.badge} bg={statusMeta.color} />
                      )}
                      {company.is_new_this_week && <Badge text="New this week" bg="#0f766e" />}
                      {company.is_carryover && (
                        <Badge
                          text={`Carryover ${company.carryover_days}d`}
                          bg={company.carryover_days >= 30 ? "#b45309" : "#64748b"}
                        />
                      )}
                      <span style={{ fontSize: 11, color: "#475569", marginLeft: "auto" }}>#{company.rank || "-"}</span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#5b6676" }}>
                      <SourceBadge bucket={company.source_bucket} />
                      <span title={sourceTitle}>Source {sourceMeta.label}</span>
                      <span>•</span>
                      <span>{filingAgeLabel(company.latest_filing_date)}</span>
                      {company.filter_reason && (
                        <>
                          <span>•</span>
                          <span title="Backend filter reason" style={{ textTransform: "capitalize" }}>{String(company.filter_reason).replaceAll("_", " ")}</span>
                        </>
                      )}
                      {(statusBand !== "unknown" || statusSeverity || statusIncidentAge || statusOpenIncidents > 0) && (
                        <>
                          <span>•</span>
                          <span title="Status health signal" style={{ color: statusMeta.text }}>
                            {statusSeverity ? `Severity ${statusSeverity}` : statusMeta.label}
                            {statusIncidentAge ? ` · ${statusIncidentAge}` : ""}
                            {statusOpenIncidents > 0 ? ` · ${statusOpenIncidents} open` : ""}
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12, color: "#475569" }}>{selectedVisibleCount} visible selected · {selectedTotalCount} total selected</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={openBatchExportModal}
                disabled={selectedTotalCount === 0}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #2563eb",
                  background: selectedTotalCount === 0 ? "#f8fafc" : "#eff6ff",
                  color: selectedTotalCount === 0 ? "#9ca3af" : "#1d4ed8",
                  fontSize: 12,
                  cursor: selectedTotalCount === 0 ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                Prepare export
              </button>
              <button
                type="button"
                onClick={() => {
                  if (activeCompanyId && onSelectCompany) onSelectCompany(activeCompanyId);
                }}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}
              >
                Open full view
              </button>
            </div>
          </div>
        </section>

        <section className="this-week-pane this-week-brief-pane">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Company Brief</h3>
            {activeCompany && <span style={{ fontSize: 12, color: "#64748b" }}>{activeCompany.company_number || ""}</span>}
          </div>

          {!activeCompany && (
            <div style={{ color: "#64748b", fontSize: 13, padding: 12, border: "1px dashed #d4dce6", borderRadius: 8 }}>
              Select a prospect to view its brief.
            </div>
          )}

          {activeCompany && (
            <div>
              <div style={{ marginBottom: 10 }}>
                <h4 style={{ margin: "0 0 4px", fontSize: 18 }}>{activeCompany.name}</h4>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "#5b6676" }}>
                  <span>{activeCompany.industry || "Unknown industry"}</span>
                  <span>•</span>
                  <span>{formatTurnover(activeCompany.turnover)}</span>
                  <span>•</span>
                  <span>{activeCompany.segment || "Unknown segment"}</span>
                </div>
              </div>

              {detailLoading && <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>Loading brief...</div>}
              {detailError && <div style={{ fontSize: 12, color: "#b91c1c", marginBottom: 10 }}>{detailError}</div>}

              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fcfdff" }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#1f2937", marginBottom: 6 }}>Why this company</div>
                  {briefSignals.whyCompany.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No brief signals yet.</div>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: 12 }}>
                      {briefSignals.whyCompany.map((line, idx) => <li key={`why-${idx}`}>{line}</li>)}
                    </ul>
                  )}
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fcfdff" }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#1f2937", marginBottom: 6 }}>Why now</div>
                  {briefSignals.whyNow.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No timing context available.</div>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: 12 }}>
                      {briefSignals.whyNow.map((line, idx) => <li key={`now-${idx}`}>{line}</li>)}
                    </ul>
                  )}
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: briefStatusMeta.background }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#1f2937", marginBottom: 8 }}>Status health</div>
                  {(briefStatusBand !== "unknown" || briefStatusSeverity || briefStatusOpenIncidents > 0 || briefStatusIncidentAge) ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Badge text={briefStatusMeta.badge} bg={briefStatusMeta.color} />
                        {briefStatusSeverity && <span style={{ fontSize: 12, color: briefStatusMeta.text }}>Severity {briefStatusSeverity}</span>}
                        {briefStatusIncidentAge && <span style={{ fontSize: 12, color: briefStatusMeta.text }}>Recent incident {briefStatusIncidentAge}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: "#334155" }}>
                        Open incidents: {briefStatusOpenIncidents}
                        {briefStatusMajorIncidents > 0 ? ` (${briefStatusMajorIncidents} major)` : ""}
                        {briefStatusDegradedComponents > 0 ? ` · Degraded components: ${briefStatusDegradedComponents}` : ""}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No status telemetry captured yet.</div>
                  )}
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fcfdff" }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#1f2937", marginBottom: 6 }}>The angle</div>
                  {briefSignals.angle.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No angle available.</div>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: 12 }}>
                      {briefSignals.angle.map((line, idx) => <li key={`angle-${idx}`}>{line}</li>)}
                    </ul>
                  )}
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fcfdff" }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#1f2937", marginBottom: 6 }}>Stakeholder</div>
                  {briefSignals.stakeholder.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No stakeholder mapped yet.</div>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: 12 }}>
                      {briefSignals.stakeholder.map((line, idx) => <li key={`stake-${idx}`}>{line}</li>)}
                    </ul>
                  )}
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fcfdff" }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#1f2937", marginBottom: 6 }}>Watch for</div>
                  {briefSignals.watchFor.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No active caution flags.</div>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#334155", fontSize: 12 }}>
                      {briefSignals.watchFor.map((line, idx) => <li key={`watch-${idx}`}>{line}</li>)}
                    </ul>
                  )}
                </div>
              </div>

              {onSelectCompany && (
                <button
                  type="button"
                  onClick={() => onSelectCompany(activeCompany.id)}
                  style={{ marginTop: 10, padding: "7px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}
                >
                  View full dossier
                </button>
              )}
            </div>
          )}
        </section>

        <section className="this-week-pane this-week-email-pane">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Email Drafts</h3>
            {latestSequence && <span style={{ fontSize: 12, color: "#64748b" }}>{sequenceSteps.length} steps</span>}
          </div>

          {sequenceLoading && <div style={{ fontSize: 12, color: "#64748b" }}>Loading drafts...</div>}

          {!sequenceLoading && activeCompany && !latestSequence && (
            <div style={{ color: "#64748b", fontSize: 13, padding: 12, border: "1px dashed #d4dce6", borderRadius: 8 }}>
              No sequence available yet for this company.
            </div>
          )}

          {!sequenceLoading && latestSequence && (
            <div>
              <div style={{ marginBottom: 10, fontSize: 12, color: "#475569" }}>
                Latest sequence: {latestSequence.id} · Stakeholder: {latestSequence.stakeholder_name || "Unknown"}
                {latestSequenceFreshness ? ` · ${latestSequenceFreshness}` : ""}
                {latestSequenceIsStale ? " · older draft" : ""}
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => copyAllSteps(sequenceSteps)}
                  style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}
                >
                  {copiedStep === -1 ? "Copied all" : "Copy all"}
                </button>
                {onSelectCompany && (
                  <button
                    type="button"
                    onClick={() => onSelectCompany(activeCompanyId)}
                    style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}
                  >
                    Open editor
                  </button>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 620, overflowY: "auto", paddingRight: 2 }}>
                {sequenceSteps.map((step) => (
                  <div key={`${latestSequence.id}-${step.step_number}`} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fcfdff" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13, color: "#1f2937" }}>
                        Step {step.step_number}: {step.step_type || "email"}
                      </strong>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Badge text={String(step.send_condition || "always").replaceAll("_", " ")} bg="#475569" />
                        <Badge text={step.review_status || "pending"} bg={step.review_status === "reviewed" ? "#047857" : "#d97706"} />
                      </div>
                    </div>

                    <div style={{ fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4 }}>
                      {step.subject || "No subject"}
                    </div>
                    <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 8 }}>
                      {trimSentence(step.body, 420) || "No body"}
                    </div>

                    <button
                      type="button"
                      onClick={() => copyStep(step)}
                      style={{ padding: "5px 9px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}
                    >
                      {copiedStep === step.step_number ? "Copied" : "Copy email"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {exportModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
            zIndex: 50,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width: "min(920px, 100%)",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "#fff",
              borderRadius: 12,
              border: "1px solid #dbe4ef",
              boxShadow: "0 20px 45px rgba(15, 23, 42, 0.26)",
              padding: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 17 }}>Batch Export for This Week</h3>
                <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
                  {selectedTotalCount} selected companies · manual review is enforced before YAMM export rows are included.
                </div>
              </div>
              <button
                type="button"
                onClick={closeBatchExportModal}
                disabled={exportBusy}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", padding: "5px 10px", cursor: exportBusy ? "not-allowed" : "pointer" }}
              >
                Close
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#334155" }}>
                Cadence steps
                <select
                  value={exportStepPreset}
                  onChange={(e) => setExportStepPreset(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 12 }}
                >
                  {EXPORT_STEP_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>{preset.label}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#334155" }}>
                Start date
                <input
                  type="date"
                  value={exportStartDate}
                  onChange={(e) => setExportStartDate(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 12 }}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#334155" }}>
                Send time (non-quarter-hour)
                <input
                  type="time"
                  value={exportSendTime}
                  onChange={(e) => setExportSendTime(e.target.value)}
                  onBlur={(e) => setExportSendTime(normalizeSendTime(e.target.value || "08:37"))}
                  step={60}
                  style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 12 }}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#334155" }}>
                Missing email handling
                <select
                  value={exportMissingEmailMode}
                  onChange={(e) => setExportMissingEmailMode(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 12 }}
                >
                  <option value="skip">Skip rows with missing email</option>
                  <option value="include">Include rows and flag NEEDS EMAIL</option>
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#334155" }}>
                Post-export workflow update
                <select
                  value={postExportState}
                  onChange={(e) => setPostExportState(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 12 }}
                >
                  {POST_EXPORT_STATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button
                type="button"
                onClick={handlePrepareBatchExport}
                disabled={exportBusy}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: "#2563eb",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: exportBusy ? "wait" : "pointer",
                  opacity: exportBusy ? 0.8 : 1,
                }}
              >
                {exportBusy ? "Preparing..." : "Prepare export file"}
              </button>
              <button
                type="button"
                onClick={handleDownloadPreparedCsv}
                disabled={!exportResult || exportResult.rows_exportable === 0}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: (!exportResult || exportResult.rows_exportable === 0) ? "#f8fafc" : "#fff",
                  color: (!exportResult || exportResult.rows_exportable === 0) ? "#94a3b8" : "#334155",
                  fontWeight: 600,
                  cursor: (!exportResult || exportResult.rows_exportable === 0) ? "not-allowed" : "pointer",
                }}
              >
                Download YAMM CSV
              </button>
              <button
                type="button"
                onClick={handleDownloadPreparedSheetsJson}
                disabled={!exportResult || exportResult.rows_exportable === 0}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: (!exportResult || exportResult.rows_exportable === 0) ? "#f8fafc" : "#fff",
                  color: (!exportResult || exportResult.rows_exportable === 0) ? "#94a3b8" : "#334155",
                  fontWeight: 600,
                  cursor: (!exportResult || exportResult.rows_exportable === 0) ? "not-allowed" : "pointer",
                }}
              >
                Download Sheets JSON
              </button>
              <button
                type="button"
                onClick={handleDownloadMissingEmailCsv}
                disabled={!exportResult || exportResult.rows_needing_email === 0}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: (!exportResult || exportResult.rows_needing_email === 0) ? "#f8fafc" : "#fff",
                  color: (!exportResult || exportResult.rows_needing_email === 0) ? "#94a3b8" : "#334155",
                  fontWeight: 600,
                  cursor: (!exportResult || exportResult.rows_needing_email === 0) ? "not-allowed" : "pointer",
                }}
              >
                Download Missing-Email CSV
              </button>
            </div>

            {exportError && (
              <div style={{ marginBottom: 10, fontSize: 12, color: "#b91c1c", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 10px" }}>
                {exportError}
              </div>
            )}

            {exportResult && (
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, background: "#f8fbff" }}>
                <div style={{ fontSize: 12, color: "#334155", marginBottom: 8 }}>
                  Generated {exportResult.rows_exportable} rows from {exportResult.selected_companies} companies · scanned {exportResult.sequences_scanned} sequences · preset: {exportResult.step_preset.label}
                </div>
                <div style={{ fontSize: 12, color: "#334155", marginBottom: 8 }}>
                  Needs email: {exportResult.rows_needing_email} · missing contacts: {exportResult.missing_email_contacts || 0} · skipped missing-email rows: {exportResult.skipped_missing_email_rows} · blocked sequences: {exportResult.blocked_sequences.length}
                </div>
                <div style={{ fontSize: 12, color: "#334155", marginBottom: 8 }}>
                  Start date: {exportResult.start_date} · send time: {exportResult.send_time}
                </div>

                {exportResult.blocked_sequences.length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 12, color: "#7c2d12" }}>
                    Blocked for review: {exportResult.blocked_sequences.slice(0, 5).map((entry) => `${entry.company_name} (${entry.stakeholder_name})`).join(" · ")}
                    {exportResult.blocked_sequences.length > 5 ? ` · +${exportResult.blocked_sequences.length - 5} more` : ""}
                  </div>
                )}

                {exportResult.no_sequence_companies.length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 12, color: "#92400e" }}>
                    No sequence found: {exportResult.no_sequence_companies.slice(0, 5).map((entry) => entry.company_name).join(" · ")}
                    {exportResult.no_sequence_companies.length > 5 ? ` · +${exportResult.no_sequence_companies.length - 5} more` : ""}
                  </div>
                )}

                {exportResult.transitioned_companies.length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 12, color: "#166534" }}>
                    Workflow updated: {exportResult.transitioned_companies.length} companies.
                  </div>
                )}

                {exportResult.transition_failures.length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 12, color: "#b91c1c" }}>
                    Workflow transition failures: {exportResult.transition_failures.slice(0, 4).map((entry) => `${entry.company_name} (${entry.reason})`).join(" · ")}
                    {exportResult.transition_failures.length > 4 ? ` · +${exportResult.transition_failures.length - 4} more` : ""}
                  </div>
                )}

                {exportResult.export_failures.length > 0 && (
                  <div style={{ fontSize: 12, color: "#9a3412" }}>
                    Export failures: {exportResult.export_failures.slice(0, 4).map((entry) => `${entry.company_name} (${entry.reason})`).join(" · ")}
                    {exportResult.export_failures.length > 4 ? ` · +${exportResult.export_failures.length - 4} more` : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

Shortlist.propTypes = {
  onSelectCompany: PropTypes.func,
  onShowAddCompany: PropTypes.func,
};
