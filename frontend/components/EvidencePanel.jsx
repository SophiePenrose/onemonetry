import React, { useState } from "react";
import PropTypes from "prop-types";

const RELEVANCE_COLORS = {
  high: { bg: "#d1fae5", color: "#065f46" },
  medium: { bg: "#fef3c7", color: "#92400e" },
  low: { bg: "#f3f4f6", color: "#6b7280" },
};

const CONFIDENCE_META = {
  high: { label: "High confidence", color: "#0a8754", icon: "●●●" },
  medium: { label: "Medium confidence", color: "#c27b00", icon: "●●○" },
  low: { label: "Low confidence", color: "#c0392b", icon: "●○○" },
};

const SEVERITY_COLORS = {
  high: { bg: "#fee2e2", color: "#991b1b" },
  medium: { bg: "#fef3c7", color: "#92400e" },
  low: { bg: "#f3f4f6", color: "#6b7280" },
};

export default function EvidencePanel({ companyId, motions }) {
  const [selectedMotion, setSelectedMotion] = useState(motions?.[0]?.motion || null);
  const [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleExtract() {
    if (!companyId || !selectedMotion) return;
    setLoading(true);
    setError(null);
    setEvidence(null);
    try {
      const res = await fetch("/api/llm/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId, product_motion: selectedMotion }),
      });
      if (!res.ok) throw new Error("Failed to extract evidence");
      const data = await res.json();
      setEvidence(data.evidence);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const motionOpportunity = evidence?.opportunities?.find(
    (o) => o.product?.toLowerCase() === selectedMotion?.toLowerCase()
  );

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>AI Evidence Extraction</h3>
        {evidence?.source && (
          <span style={{ fontSize: 11, color: "#888", background: "#f3f4f6", padding: "2px 8px", borderRadius: 8 }}>
            {evidence.source === "llm" ? `via ${evidence.model}` : evidence.source}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <select
          value={selectedMotion || ""}
          onChange={(e) => { setSelectedMotion(e.target.value); setEvidence(null); }}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13, flex: 1 }}
        >
          {(motions || []).map((m) => (
            <option key={m.motion} value={m.motion}>{m.motion}</option>
          ))}
        </select>
        <button
          onClick={handleExtract}
          disabled={loading || !selectedMotion}
          style={{
            padding: "6px 20px", borderRadius: 6, border: "none",
            background: "#0075EB", color: "#fff", fontWeight: 600,
            fontSize: 13, cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Extracting…" : "Extract Evidence"}
        </button>
      </div>

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {!evidence && !loading && !error && (
        <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 16 }}>
          Select a product motion and click &quot;Extract Evidence&quot; to generate an AI-powered analysis.
        </div>
      )}

      {evidence && (
        <div>
          {/* Summary / Fit Assessment */}
          {evidence.summary && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Summary</div>
              <div style={{ fontSize: 14, color: "#333", lineHeight: 1.5 }}>{evidence.summary}</div>
            </div>
          )}

          {/* Motion-specific opportunity confidence */}
          {motionOpportunity && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>
                {selectedMotion} Fit Assessment
              </div>
              <div style={{ fontSize: 13, color: "#333", background: "#f8f9fb", padding: "10px 12px", borderRadius: 6 }}>
                <div style={{ marginBottom: 6 }}>{motionOpportunity.rationale}</div>
                {(() => {
                  const cm = CONFIDENCE_META[motionOpportunity.confidence] || CONFIDENCE_META.medium;
                  return (
                    <span style={{ fontSize: 12, fontWeight: 600, color: cm.color }}>
                      {cm.icon} {cm.label}
                    </span>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Themes as evidence snippets */}
          {evidence.themes?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 8 }}>Evidence Themes</div>
              {evidence.themes.map((t, idx) => (
                <div key={idx} style={{ marginBottom: 8, padding: "8px 12px", background: "#fafbfc", borderRadius: 6, borderLeft: "3px solid #0075EB" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#333" }}>{t.theme}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#555" }}>{t.evidence}</div>
                </div>
              ))}
            </div>
          )}

          {/* Pain Indicators */}
          {evidence.pain_indicators?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Pain Indicators</div>
              {evidence.pain_indicators.map((p, idx) => {
                const sc = SEVERITY_COLORS[p.severity] || SEVERITY_COLORS.medium;
                return (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: sc.color, background: sc.bg, padding: "2px 8px", borderRadius: 8, textTransform: "capitalize" }}>
                      {p.severity}
                    </span>
                    <span style={{ fontSize: 13, color: "#333" }}>{typeof p === "string" ? p : p.pain}</span>
                    {p.evidence && <span style={{ fontSize: 12, color: "#888" }}>— {p.evidence}</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Recommended Approach */}
          {(evidence.recommended_approach || evidence.recommended_angle) && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Recommended Outreach Angle</div>
              <div style={{ fontSize: 13, color: "#333", background: "#eff6ff", padding: "8px 12px", borderRadius: 6, borderLeft: "3px solid #0075EB" }}>
                {evidence.recommended_approach || evidence.recommended_angle}
              </div>
            </div>
          )}

          {/* International Exposure */}
          {evidence.international_exposure?.present && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>International Exposure</div>
              <div style={{ fontSize: 13, color: "#333" }}>
                {evidence.international_exposure.details}
                {evidence.international_exposure.currencies?.length > 0 && (
                  <span style={{ marginLeft: 8, color: "#888" }}>
                    ({evidence.international_exposure.currencies.join(", ")})
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Risks */}
          {evidence.risks?.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Risks</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {evidence.risks.map((r, idx) => (
                  <li key={idx} style={{ fontSize: 13, color: "#c0392b", marginBottom: 3 }}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

EvidencePanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  motions: PropTypes.array,
};
