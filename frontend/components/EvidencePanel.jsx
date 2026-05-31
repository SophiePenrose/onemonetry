import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";

const RELEVANCE_COLORS = {
  high: { bg: "#d1fae5", color: "#065f46" },
  medium: { bg: "#fef3c7", color: "#92400e" },
  low: { bg: "#f3f4f6", color: "#6b7280" },
};

function SnippetGroup({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#555", marginBottom: 6 }}>{title}</div>
      {items.map((item, idx) => {
        const rc = RELEVANCE_COLORS[item.relevance] || RELEVANCE_COLORS.medium;
        return (
          <div key={`${title}-${idx}`} style={{ padding: "8px 10px", background: "#fafbfc", border: "1px solid #eceff3", borderRadius: 6, marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#333", marginBottom: 4 }}>
              "{item.quote}"
            </div>
            {item.insight && <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>{item.insight}</div>}
            <span style={{ fontSize: 11, fontWeight: 700, color: rc.color, background: rc.bg, borderRadius: 999, padding: "2px 8px", textTransform: "capitalize" }}>
              {item.relevance || "medium"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

SnippetGroup.propTypes = {
  title: PropTypes.string.isRequired,
  items: PropTypes.array,
};

export default function EvidencePanel({ companyId, initialAnalysis, motions }) {
  const [analysis, setAnalysis] = useState(initialAnalysis || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setAnalysis(initialAnalysis || null);
  }, [companyId, initialAnalysis, motions]);

  async function refreshEvidence() {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/llm/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId }),
      });
      if (!res.ok) throw new Error("Failed to refresh analysis evidence");
      const data = await res.json();
      setAnalysis(data.evidence || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const snippets = analysis?.evidence_snippets || {};
  const narrative = analysis?.outreach_narrative || null;
  const supplementary = analysis?.supplementary_context || null;

  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Evidence And Narrative Proof</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {analysis?.source && (
            <span style={{ fontSize: 11, color: "#888", background: "#f3f4f6", padding: "2px 8px", borderRadius: 8 }}>
              {analysis.source === "llm" ? `via ${analysis.model}` : analysis.source}
            </span>
          )}
          <button
            onClick={refreshEvidence}
            disabled={loading}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid #dbe2ea", background: "#fff", color: "#333",
              fontSize: 12, fontWeight: 700, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {!analysis && !loading && !error && (
        <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 16 }}>
          Evidence will appear automatically once analysis has run.
        </div>
      )}

      {analysis && (
        <div>
          <SnippetGroup title="Pain Evidence" items={snippets.pains} />
          <SnippetGroup title="Suitability Evidence" items={snippets.suitability} />
          <SnippetGroup title="Current Stack Mentions" items={snippets.competitors} />
          <SnippetGroup title="Gap Signals" items={snippets.gaps} />
          <SnippetGroup title="Execution Signals" items={snippets.execution} />

          {narrative && (
            <div style={{ marginBottom: 14, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#555", marginBottom: 6 }}>Pain To Plan Narrative</div>
              {narrative.primary_pains?.length > 0 && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 6 }}>
                  <strong>Pains:</strong> {narrative.primary_pains.join(", ")}
                </div>
              )}
              {narrative.incumbent_setup && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 6 }}>
                  <strong>Current setup:</strong> {narrative.incumbent_setup}
                </div>
              )}
              {narrative.gaps_we_can_fill?.length > 0 && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 6 }}>
                  <strong>Gaps:</strong> {narrative.gaps_we_can_fill.join(" ")}
                </div>
              )}
              {narrative.execution_plan && (
                <div style={{ fontSize: 13, color: "#333", marginBottom: 6 }}>
                  <strong>Execution plan:</strong> {narrative.execution_plan}
                </div>
              )}
              {narrative.communication_strategy && (
                <div style={{ fontSize: 13, color: "#333" }}>
                  <strong>Comms:</strong> {narrative.communication_strategy}
                </div>
              )}
            </div>
          )}

          {supplementary && (
            <div style={{ background: "#fff", border: "1px solid #eceff3", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#555", marginBottom: 6 }}>Supplementary Context</div>
              <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>
                LinkedIn: {supplementary.enrichment_status?.linkedin_search ? "available" : "not configured"} | Lusha: {supplementary.enrichment_status?.lusha ? "configured" : "not configured"} | News API: {supplementary.enrichment_status?.news_api ? "configured" : "not configured"}
              </div>
              {supplementary.news_signals?.length > 0 && (
                <div style={{ fontSize: 12, color: "#444", marginBottom: 4 }}>
                  <strong>News/Momentum signals:</strong> {supplementary.news_signals.map((s) => s.signal).join(", ")}
                </div>
              )}
              {supplementary.mna_signals?.length > 0 && (
                <div style={{ fontSize: 12, color: "#444", marginBottom: 4 }}>
                  <strong>M&A signals:</strong> {supplementary.mna_signals.map((s) => s.signal).join(", ")}
                </div>
              )}
              {supplementary.value_nuggets?.length > 0 && (
                <div style={{ fontSize: 12, color: "#444" }}>
                  <strong>Value nuggets:</strong>
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    {supplementary.value_nuggets.slice(0, 6).map((item, idx) => (
                      <div key={`value-nugget-${idx}`} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#374151", background: "#eef2ff", borderRadius: 999, padding: "2px 7px", textTransform: "uppercase" }}>
                          {item.type || "signal"}
                        </span>
                        <span>{item.nugget}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

EvidencePanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  initialAnalysis: PropTypes.object,
  motions: PropTypes.array,
};
