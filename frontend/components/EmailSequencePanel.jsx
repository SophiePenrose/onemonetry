import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";

const STATUS_META = {
  pending: { label: "Pending", color: "#6b7280", bg: "#f3f4f6" },
  sent: { label: "Sent", color: "#0075EB", bg: "#eff6ff" },
  opened: { label: "Opened", color: "#c27b00", bg: "#fef3c7" },
  replied: { label: "Replied", color: "#0a8754", bg: "#d1fae5" },
};

const REVIEW_META = {
  pending: { label: "Review needed", color: "#7f1d1d", bg: "#fee2e2" },
  reviewed: { label: "Reviewed", color: "#0a8754", bg: "#dcfce7" },
};

function CopyButton({ subject, body, footer }) {
  const [copied, setCopied] = React.useState(null);

  async function handleCopy(type) {
    let text;
    if (type === "subject") {
      text = subject;
    } else {
      const fullBody = footer ? `${body}\n\n${footer}` : body;
      text = fullBody;
    }

    try {
      const htmlContent = text.replace(/\n/g, "<br>");
      const blob = new Blob([htmlContent], { type: "text/html" });
      const plainBlob = new Blob([text], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": blob,
          "text/plain": plainBlob,
        }),
      ]);
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    }
  }

  const btnStyle = (active) => ({
    padding: "3px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer",
    border: active ? "1px solid #0a8754" : "1px solid #ddd",
    background: active ? "#d1fae5" : "#fff",
    color: active ? "#0a8754" : "#555",
    fontWeight: 600,
  });

  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button onClick={() => handleCopy("subject")} style={btnStyle(copied === "subject")}>
        {copied === "subject" ? "✓ Subject" : "Copy Subject"}
      </button>
      <button onClick={() => handleCopy("body")} style={btnStyle(copied === "body")}>
        {copied === "body" ? "✓ Body" : "Copy Body"}
      </button>
    </div>
  );
}

CopyButton.propTypes = {
  subject: PropTypes.string,
  body: PropTypes.string,
  footer: PropTypes.string,
};

export default function EmailSequencePanel({ companyId, companyName, stakeholders, keyPeople, motions }) {
  const [sequences, setSequences] = useState([]);
  const [templates, setTemplates] = useState({});
  const [guidance, setGuidance] = useState(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [expandedSeq, setExpandedSeq] = useState(null);
  const [editingStep, setEditingStep] = useState(null);
  const [form, setForm] = useState({ name: "", role: "", email: "", motion: "" });
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [purgingBroken, setPurgingBroken] = useState(false);

  useEffect(() => {
    fetch("/api/email/templates")
      .then((r) => r.json())
      .then((d) => {
        setTemplates(d.templates || {});
        setGuidance(d.guidance || null);
      })
      .catch(() => {});
    if (companyId) loadSequences();
  }, [companyId]);

  function loadSequences() {
    fetch(`/api/email/sequences/${encodeURIComponent(companyId)}`)
      .then((r) => r.json())
      .then((d) => setSequences(d.sequences || []))
      .catch(() => {});
  }

  async function handleGenerate(e) {
    e.preventDefault();
    if (!form.name) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const payload = {
        company_id: companyId,
        stakeholder_name: form.name,
        stakeholder_role: form.role,
        stakeholder_email: form.email,
      };
      if (form.motion) payload.motion = form.motion;

      const res = await fetch("/api/email/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 503 && data?.retry_needed) {
          const reason = data?.reason ? `Reason: ${data.reason}.` : "";
          const detail = data?.detail ? ` ${data.detail}` : "";
          setGenerateError(`${data.error || "Live generation is temporarily unavailable. Please retry."} ${reason}${detail}`.trim());
          return;
        }

        if (res.status === 409 && data?.suppressed) {
          setGenerateError(data.error || "This company is suppressed from outreach sequencing.");
          return;
        }

        setGenerateError(data?.error || "Failed to generate sequence.");
        return;
      }

      setForm({ name: "", role: "", email: "", motion: "" });
      setShowGenerate(false);
      loadSequences();
    } catch (err) {
      setGenerateError(err?.message || "Failed to generate sequence.");
    }
    finally { setGenerating(false); }
  }

  async function handleMarkStatus(seqId, stepNumber, status) {
    await fetch(`/api/email/sequence/${seqId}/step/${stepNumber}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadSequences();
  }

  async function handleMarkReviewed(seqId, stepNumber) {
    await fetch(`/api/email/sequence/${seqId}/step/${stepNumber}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    loadSequences();
  }

  async function handleSaveEdit(seqId, stepNumber, subject, body) {
    await fetch(`/api/email/sequence/${seqId}/step/${stepNumber}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, body }),
    });
    setEditingStep(null);
    loadSequences();
  }

  async function handleDelete(seqId) {
    if (!confirm("Delete this email sequence?")) return;
    await fetch(`/api/email/sequence/${seqId}`, { method: "DELETE" });
    loadSequences();
  }

  async function handlePurgeBrokenSequences() {
    if (!companyId || purgingBroken) return;
    if (!confirm("Delete old drafts that still contain placeholder tokens like [Your Name] or [rounded figure]?")) return;

    setPurgingBroken(true);
    try {
      const [brokenRes, legacyRes] = await Promise.all([
        fetch(`/api/email/sequences/${encodeURIComponent(companyId)}/purge-broken`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dry_run: false }),
        }),
        fetch(`/api/email/sequences/${encodeURIComponent(companyId)}/purge-placeholders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dry_run: false }),
        }),
      ]);

      const broken = await brokenRes.json().catch(() => ({}));
      const legacy = await legacyRes.json().catch(() => ({}));
      if (!brokenRes.ok) throw new Error(broken.error || "Failed to purge broken sequences");
      if (!legacyRes.ok) throw new Error(legacy.error || "Failed to purge legacy sequences");

      const brokenDeleted = Number(broken.deleted_sequences || 0);
      const legacyDeleted = Number(legacy.deleted_sequences || 0);
      const totalDeleted = brokenDeleted + legacyDeleted;

      alert(totalDeleted > 0
        ? `Deleted ${totalDeleted} broken/legacy sequence${totalDeleted === 1 ? "" : "s"}.`
        : "No broken or legacy sequences found.");
      loadSequences();
    } catch (err) {
      alert(err.message || "Failed to purge broken sequences");
    } finally {
      setPurgingBroken(false);
    }
  }

  const allPeople = [
    ...(keyPeople || []).map((p) => ({ ...p, source: "LLM" })),
    ...(stakeholders || []).map((s) => ({ name: s.name, role: s.role || s.title, source: "Manual" })),
  ];

  const availableMotions = Object.keys(templates);
  const inputStyle = { width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" };

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Email Sequences</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handlePurgeBrokenSequences}
            disabled={purgingBroken}
            style={{
              padding: "6px 12px", borderRadius: 6, border: "1px solid #e5e7eb", fontSize: 12, fontWeight: 600, cursor: purgingBroken ? "wait" : "pointer",
              background: "#fff", color: "#374151", opacity: purgingBroken ? 0.7 : 1,
            }}
          >
            {purgingBroken ? "Cleaning..." : "Clean Broken Drafts"}
          </button>
          <button
            onClick={() => setShowGenerate(!showGenerate)}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: showGenerate ? "#f3f4f6" : "#0075EB", color: showGenerate ? "#555" : "#fff",
            }}
          >
            {showGenerate ? "Cancel" : "+ Generate Sequence"}
          </button>
        </div>
      </div>

      {showGenerate && (
        <form onSubmit={handleGenerate} style={{ background: "#f8f9fb", borderRadius: 6, padding: 14, marginBottom: 14, border: "1px solid #e0e3e8" }}>
          <div style={{ fontSize: 12, color: "#555", marginBottom: 10, fontWeight: 600 }}>
            Generate a personalised email sequence for a stakeholder
          </div>

          {allPeople.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Quick select from known contacts:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {allPeople.map((p, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setForm({ ...form, name: p.name, role: p.role || "" })}
                    style={{
                      padding: "3px 10px", borderRadius: 12, border: "1px solid #ddd",
                      background: form.name === p.name ? "#0075EB" : "#fff",
                      color: form.name === p.name ? "#fff" : "#333",
                      fontSize: 12, cursor: "pointer",
                    }}
                  >
                    {p.name} {p.role ? `(${p.role})` : ""} <span style={{ fontSize: 10, opacity: 0.6 }}>[{p.source}]</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Name *</label>
              <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="John Smith" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Role</label>
              <input style={inputStyle} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="CFO" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Email</label>
              <input style={inputStyle} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="john@company.com" />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>Sequence Strategy</label>
            <select style={inputStyle} value={form.motion} onChange={(e) => setForm({ ...form, motion: e.target.value })}>
              <option value="">Auto (Level 5 holistic narrative)</option>
              {availableMotions.map((m) => (
                <option key={m} value={m}>{m} ({templates[m]?.steps} steps)</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "#777", marginTop: 4 }}>
              Auto mode runs an evidence-first 3-step sequence using filing insight, quantified operational angle, and governance narrative.
            </div>
          </div>

          {guidance && (
            <div style={{ marginBottom: 10, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Internal Revolut sequencing guardrails</div>
              <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 6 }}>
                Header template: <strong>{guidance.header_template || "Revolut X [Company Name] - I've done my research"}</strong>
              </div>
              {Array.isArray(guidance.lead_with) && guidance.lead_with.length > 0 && (
                <div style={{ fontSize: 11, color: "#374151", marginBottom: 4 }}>
                  <strong>Lead with:</strong> {guidance.lead_with.join(" | ")}
                </div>
              )}
              {Array.isArray(guidance.avoid_leading_with) && guidance.avoid_leading_with.length > 0 && (
                <div style={{ fontSize: 11, color: "#7f1d1d", marginBottom: 4 }}>
                  <strong>Avoid leading with:</strong> {guidance.avoid_leading_with.join(" | ")}
                </div>
              )}
              {Array.isArray(guidance.reliable_format) && guidance.reliable_format.length > 0 && (
                <div style={{ fontSize: 11, color: "#374151" }}>
                  <strong>Reliable format:</strong> {guidance.reliable_format.join(" -> ")}
                </div>
              )}
            </div>
          )}

          <button type="submit" disabled={generating || !form.name} style={{
            padding: "8px 20px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff",
            fontWeight: 600, fontSize: 13, cursor: generating ? "wait" : "pointer", opacity: generating ? 0.6 : 1,
          }}>
            {generating ? "Generating…" : "Generate Email Sequence"}
          </button>

          {generateError && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 10px" }}>
              {generateError}
            </div>
          )}
        </form>
      )}

      {sequences.length === 0 && !showGenerate && (
        <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 16 }}>
          No email sequences yet. Click &quot;Generate Sequence&quot; to create personalised outreach emails for stakeholders.
        </div>
      )}

      {sequences.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sequences.map((seq) => {
            const isExpanded = expandedSeq === seq.id;
            const sentCount = seq.steps?.filter((s) => s.status !== "pending").length || 0;
            const totalSteps = seq.steps?.length || 0;

            return (
              <div key={seq.id} style={{ background: "#fafbfc", borderRadius: 6, border: "1px solid #f0f0f0", overflow: "hidden" }}>
                <div
                  onClick={() => setExpandedSeq(isExpanded ? null : seq.id)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", cursor: "pointer" }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{seq.stakeholder_name}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>
                      {seq.stakeholder_role ? `${seq.stakeholder_role} · ` : ""}{seq.motion} · {sentCount}/{totalSteps} steps
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#888", background: "#f3f4f6", padding: "2px 8px", borderRadius: 8 }}>
                      {seq.status}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(seq.id); }} style={{
                      border: "none", background: "none", color: "#ccc", cursor: "pointer", fontSize: 16,
                    }}>×</button>
                  </div>
                </div>

                {isExpanded && seq.steps && (
                  <div style={{ padding: "0 14px 14px", borderTop: "1px solid #f0f0f0" }}>
                    {seq.steps.map((step) => {
                      const sm = STATUS_META[step.status] || STATUS_META.pending;
                      const rm = REVIEW_META[step.review_status] || REVIEW_META.pending;
                      const isEditing = editingStep === `${seq.id}-${step.step_number}`;
                      const voicePercentRaw = Number(step.voice_percent ?? step.metrics?.voice_percent);
                      const hasVoicePercent = Number.isFinite(voicePercentRaw);
                      const voicePercent = hasVoicePercent ? Math.round(voicePercentRaw) : null;
                      const voiceDisplayPass = hasVoicePercent
                        ? (step.metrics?.voice_display_pass ?? voicePercent >= 85)
                        : false;

                      return (
                        <div key={step.step_number} style={{ padding: "12px 0", borderBottom: "1px solid #f8f8f8" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#888", minWidth: 24 }}>#{step.step_number}</span>
                              <span style={{ fontSize: 11, color: "#888" }}>
                                {step.send_delay_days === 0 ? "Immediate" : `Day ${step.send_delay_days}`}
                              </span>
                              <span style={{ fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg, padding: "1px 8px", borderRadius: 8 }}>
                                {sm.label}
                              </span>
                              <span style={{ fontSize: 11, fontWeight: 600, color: rm.color, background: rm.bg, padding: "1px 8px", borderRadius: 8 }}>
                                {rm.label}
                              </span>
                              {hasVoicePercent && (
                                <span style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  color: voiceDisplayPass ? "#065f46" : "#92400e",
                                  background: voiceDisplayPass ? "#d1fae5" : "#fef3c7",
                                  padding: "1px 8px",
                                  borderRadius: 8,
                                }}>
                                  Voice {voicePercent}% {voiceDisplayPass ? "pass" : "review"}
                                </span>
                              )}
                              {step.status === "pending" && step.send_delay_days > 0 && (
                                <span style={{ fontSize: 10, color: "#c27b00", fontStyle: "italic" }}>
                                  Send on: {new Date(Date.now() + step.send_delay_days * 86400000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                                </span>
                              )}
                            </div>
                            <div style={{ display: "flex", gap: 4 }}>
                              <CopyButton subject={step.subject} body={step.body} footer={step.footer} />
                              {step.status === "pending" && (
                                <button onClick={() => handleMarkStatus(seq.id, step.step_number, "sent")} style={{
                                  padding: "3px 10px", borderRadius: 4, border: "1px solid #0075EB", background: "#eff6ff", fontSize: 11, cursor: "pointer", color: "#0075EB", fontWeight: 600,
                                }}>Mark Sent</button>
                              )}
                              {step.status === "sent" && (
                                <>
                                  <button onClick={() => handleMarkStatus(seq.id, step.step_number, "opened")} style={{
                                    padding: "3px 10px", borderRadius: 4, border: "1px solid #ddd", background: "#fff", fontSize: 11, cursor: "pointer",
                                  }}>Opened</button>
                                  <button onClick={() => handleMarkStatus(seq.id, step.step_number, "replied")} style={{
                                    padding: "3px 10px", borderRadius: 4, border: "1px solid #0a8754", background: "#d1fae5", fontSize: 11, cursor: "pointer", color: "#0a8754", fontWeight: 600,
                                  }}>Replied!</button>
                                </>
                              )}
                              <button onClick={() => setEditingStep(isEditing ? null : `${seq.id}-${step.step_number}`)} style={{
                                padding: "3px 10px", borderRadius: 4, border: "1px solid #ddd", background: "#fff", fontSize: 11, cursor: "pointer",
                              }}>
                                {isEditing ? "Cancel" : "Edit"}
                              </button>
                              {step.review_status !== "reviewed" && (
                                <button onClick={() => handleMarkReviewed(seq.id, step.step_number)} style={{
                                  padding: "3px 10px", borderRadius: 4, border: "1px solid #0a8754", background: "#dcfce7", fontSize: 11, cursor: "pointer", color: "#0a8754", fontWeight: 600,
                                }}>
                                  Mark Reviewed
                                </button>
                              )}
                            </div>
                          </div>

                          {!isEditing ? (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 4 }}>{step.subject}</div>
                              <pre style={{
                                fontSize: 12, color: "#555", margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit",
                                lineHeight: 1.5, maxHeight: 200, overflow: "auto", background: "#f8f9fb", padding: 10, borderRadius: 4,
                              }}>
                                {step.body}
                              </pre>
                            </>
                          ) : (
                            <EditStepForm
                              step={step}
                              onSave={(subject, body) => handleSaveEdit(seq.id, step.step_number, subject, body)}
                              onCancel={() => setEditingStep(null)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EditStepForm({ step, onSave, onCancel }) {
  const [subject, setSubject] = useState(step.subject);
  const [body, setBody] = useState(step.body);

  return (
    <div>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 13, marginBottom: 8, boxSizing: "border-box", fontWeight: 600 }}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        style={{ width: "100%", padding: "8px 10px", borderRadius: 4, border: "1px solid #ddd", fontSize: 12, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical", boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={() => onSave(subject, body)} style={{
          padding: "6px 16px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>Save Changes</button>
        <button onClick={onCancel} style={{
          padding: "6px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 12, cursor: "pointer",
        }}>Cancel</button>
      </div>
    </div>
  );
}

EditStepForm.propTypes = {
  step: PropTypes.object.isRequired,
  onSave: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

EmailSequencePanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  companyName: PropTypes.string,
  stakeholders: PropTypes.array,
  keyPeople: PropTypes.array,
  motions: PropTypes.array,
};
