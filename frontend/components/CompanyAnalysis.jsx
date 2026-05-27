import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";

const SEVERITY_COLORS = { high: "#c0392b", medium: "#e67e22", low: "#6b7280" };
const CONFIDENCE_COLORS = { high: "#0a8754", medium: "#c27b00", low: "#6b7280" };

function Badge({ text, bg }) {
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, color: "#fff", background: bg || "#888" }}>
      {text}
    </span>
  );
}

Badge.propTypes = { text: PropTypes.string, bg: PropTypes.string };

export default function CompanyAnalysis({ companyNumber, initialAnalysis }) {
  const [analysis, setAnalysis] = useState(initialAnalysis || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setAnalysis(initialAnalysis || null);
  }, [companyNumber, initialAnalysis]);

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/llm/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_number: companyNumber }),
      });
      if (!res.ok) throw new Error("Analysis failed");
      const data = await res.json();
      setAnalysis(data.analysis);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Company Analysis</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {analysis?.source && (
            <span style={{ fontSize: 11, color: "#888", background: "#f3f4f6", padding: "2px 8px", borderRadius: 8 }}>
              {analysis.source === "llm" ? `via ${analysis.model}` : analysis.source}
            </span>
          )}
          <button
            onClick={runAnalysis}
            disabled={loading}
            style={{
              padding: "6px 16px", borderRadius: 6, border: "none",
              background: "#0075EB", color: "#fff", fontWeight: 600,
              fontSize: 13, cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Analysing…" : analysis ? "Re-analyse" : "Analyse Filing"}
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {!analysis && !loading && !error && (
        <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 16 }}>
          Click &quot;Analyse Filing&quot; to extract themes, pain indicators, and opportunities from this company&apos;s accounts filing.
        </div>
      )}

      {analysis && (
        <div>
          {/* Summary */}
          <div style={{ fontSize: 14, color: "#333", lineHeight: 1.6, marginBottom: 16, padding: "10px 14px", background: "#f8f9fb", borderRadius: 6 }}>
            {analysis.summary}
            {analysis.turnover_trend && analysis.turnover_trend !== "unknown" && (
              <span style={{ marginLeft: 8 }}>
                <Badge text={`Trend: ${analysis.turnover_trend}`} bg={analysis.turnover_trend === "growing" ? "#0a8754" : analysis.turnover_trend === "declining" ? "#c0392b" : "#6b7280"} />
              </span>
            )}
          </div>

          {/* Themes */}
          {analysis.themes?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 8 }}>Key Themes</div>
              {analysis.themes.map((t, idx) => (
                <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13 }}>
                  <span style={{ color: "#0075EB", fontWeight: 600, minWidth: 6 }}>•</span>
                  <div><strong>{t.theme}</strong>: <span style={{ color: "#666" }}>{t.evidence}</span></div>
                </div>
              ))}
            </div>
          )}

          {/* Pain Indicators */}
          {analysis.pain_indicators?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 8 }}>Pain Indicators</div>
              {analysis.pain_indicators.map((p, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, padding: "8px 12px", background: "#fafbfc", borderRadius: 6, borderLeft: `3px solid ${SEVERITY_COLORS[p.severity] || "#888"}` }}>
                  <Badge text={p.severity} bg={SEVERITY_COLORS[p.severity]} />
                  <div style={{ fontSize: 13 }}>
                    <strong>{p.pain}</strong>
                    <div style={{ color: "#666", marginTop: 2 }}>{p.evidence}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Opportunities */}
          {analysis.opportunities?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 8 }}>Product Opportunities</div>
              {analysis.opportunities.map((o, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, padding: "8px 12px", background: "#f0fdf4", borderRadius: 6, borderLeft: `3px solid ${CONFIDENCE_COLORS[o.confidence] || "#888"}` }}>
                  <Badge text={o.product} bg="#0075EB" />
                  <Badge text={o.confidence} bg={CONFIDENCE_COLORS[o.confidence]} />
                  <span style={{ fontSize: 13, color: "#333" }}>{o.rationale}</span>
                </div>
              ))}
            </div>
          )}

          {/* International Exposure */}
          {analysis.international_exposure?.present && (
            <div style={{ marginBottom: 16, padding: "8px 12px", background: "#eff6ff", borderRadius: 6, borderLeft: "3px solid #0075EB", fontSize: 13 }}>
              <strong>🌍 International exposure:</strong> {analysis.international_exposure.details}
              {analysis.international_exposure.currencies?.length > 0 && (
                <span style={{ color: "#666", marginLeft: 8 }}>({analysis.international_exposure.currencies.join(", ")})</span>
              )}
            </div>
          )}

          {/* Current stack */}
          {analysis.competitors_detected?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 8 }}>Current Stack Signals</div>
              {analysis.competitors_detected.map((c, idx) => (
                <div key={idx} style={{ fontSize: 13, color: "#333", background: "#fff7ed", padding: "8px 12px", borderRadius: 6, marginBottom: 6, borderLeft: "3px solid #e67e22" }}>
                  <strong>{c.name}</strong>{c.product ? ` · ${c.product}` : ""}{c.displacement_angle ? ` - ${c.displacement_angle}` : ""}
                  {c.inferred_advantage && (
                    <div style={{ marginTop: 4, color: "#0b3b74", fontSize: 12 }}>Advantage angle: {c.inferred_advantage}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {analysis.evidence_snippets && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 8 }}>Scoring Proof Snippets</div>
              {[
                { key: "pains", label: "Pain" },
                { key: "suitability", label: "Suitability" },
                { key: "competitors", label: "Current Stack" },
              ].map((group) => (
                <div key={group.key} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: "#666", fontWeight: 600, marginBottom: 4 }}>{group.label}</div>
                  {(analysis.evidence_snippets[group.key] || []).slice(0, 2).map((item, idx) => (
                    <div key={`${group.key}-${idx}`} style={{ background: "#fafbfc", border: "1px solid #eceff3", borderRadius: 6, padding: "6px 8px", fontSize: 12, color: "#444", marginBottom: 4 }}>
                      "{item.quote}"{item.insight ? ` - ${item.insight}` : ""}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {analysis.outreach_narrative && (
            <div style={{ marginBottom: 16, padding: "10px 12px", background: "#f8fafc", borderRadius: 6, borderLeft: "3px solid #2563eb" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Pain-to-Communication Link</div>
              {analysis.outreach_narrative.primary_pains?.length > 0 && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 4 }}><strong>Pains:</strong> {analysis.outreach_narrative.primary_pains.join(", ")}</div>
              )}
              {analysis.outreach_narrative.gaps_we_can_fill?.length > 0 && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 4 }}><strong>Gaps:</strong> {analysis.outreach_narrative.gaps_we_can_fill.join(" ")}</div>
              )}
              {analysis.outreach_narrative.execution_plan && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 4 }}><strong>Execution:</strong> {analysis.outreach_narrative.execution_plan}</div>
              )}
              {analysis.outreach_narrative.communication_strategy && (
                <div style={{ fontSize: 13, color: "#333" }}><strong>Comms:</strong> {analysis.outreach_narrative.communication_strategy}</div>
              )}
            </div>
          )}

          {(analysis.deal_type || analysis.estimated_value) && (
            <div style={{ marginBottom: 16, padding: "8px 12px", background: "#f8f9fb", borderRadius: 6, fontSize: 13 }}>
              {analysis.deal_type && <span><strong>Deal type:</strong> {analysis.deal_type}</span>}
              {analysis.estimated_value && <span style={{ marginLeft: analysis.deal_type ? 12 : 0 }}><strong>Estimated value:</strong> {analysis.estimated_value}</span>}
            </div>
          )}

          {/* Key People */}
          {analysis.key_people?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Key People</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {analysis.key_people.map((p, idx) => (
                  <span key={idx} style={{ padding: "4px 10px", background: "#f3f4f6", borderRadius: 12, fontSize: 12 }}>
                    {p.name} <span style={{ color: "#888" }}>({p.role})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recommended Approach */}
          {analysis.recommended_approach && (
            <div style={{ padding: "10px 14px", background: "#f0fdf4", borderRadius: 6, borderLeft: "3px solid #0a8754", fontSize: 13, marginBottom: 16 }}>
              <strong>Recommended approach:</strong> {analysis.recommended_approach}
            </div>
          )}

          {/* Risks */}
          {analysis.risks?.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 6 }}>Risks</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {analysis.risks.map((r, idx) => (
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

CompanyAnalysis.propTypes = {
  companyNumber: PropTypes.string.isRequired,
  initialAnalysis: PropTypes.object,
};
