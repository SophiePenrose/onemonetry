import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const LAYER_LABELS = {
  product_fit: "Product Fit",
  commercial_value: "Commercial Value",
  pain_strength: "Pain Strength",
  urgency: "Urgency",
  competitor_context: "Current Stack Context",
};

const LAYER_COLORS = {
  product_fit: "#0075EB",
  commercial_value: "#0a8754",
  pain_strength: "#c0392b",
  urgency: "#e67e22",
  competitor_context: "#6f42c1",
};

const LAYER_ENTRIES = Object.entries(LAYER_LABELS);

const SEGMENTS = ["SMB", "Mid-Market", "Enterprise"];

const WeightSlider = React.memo(function WeightSlider({ layer, value, color, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 500, color, minWidth: 130 }}>{LAYER_LABELS[layer]}</span>
      <input
        type="range" min={0} max={50} step={1}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(layer, parseInt(e.target.value) / 100)}
        style={{ flex: 1, accentColor: color }}
      />
      <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 40, textAlign: "right" }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  );
});

const SegmentWeightsCard = React.memo(function SegmentWeightsCard({ segment, weights, onChange, total }) {
  const isValid = Math.abs(total - 1) < 0.02;
  const handleLayerChange = useCallback((layer, value) => {
    onChange(segment, layer, value);
  }, [onChange, segment]);

  return (
    <div style={{
      background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      border: isValid ? "1px solid #e0e3e8" : "2px solid #c0392b",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h4 style={{ margin: 0, fontSize: 15 }}>{segment}</h4>
        <span style={{ fontSize: 12, fontWeight: 600, color: isValid ? "#0a8754" : "#c0392b" }}>
          Total: {Math.round(total * 100)}%
          {!isValid && " (must be 100%)"}
        </span>
      </div>
      {LAYER_ENTRIES.map(([layer]) => (
        <WeightSlider
          key={layer}
          layer={layer}
          value={weights[layer] || 0}
          color={LAYER_COLORS[layer]}
          onChange={handleLayerChange}
        />
      ))}
    </div>
  );
});

export default function Settings() {
  const [config, setConfig] = useState(null);
  const [localWeights, setLocalWeights] = useState({});
  const [propensityWeight, setPropensityWeight] = useState(0.15);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [integrationStatus, setIntegrationStatus] = useState(null);
  const [integrationLoading, setIntegrationLoading] = useState(false);
  const [integrationError, setIntegrationError] = useState(null);
  const [integrationCheckedAt, setIntegrationCheckedAt] = useState(null);
  const integrationRequestRef = useRef(0);
  const previewRequestRef = useRef(0);

  const segmentTotals = useMemo(
    () => SEGMENTS.reduce((totals, segment) => {
      const weights = localWeights[segment] || {};
      totals[segment] = Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0);
      return totals;
    }, {}),
    [localWeights],
  );

  const integrationView = useMemo(() => {
    const entries = integrationStatus?.integrations
      ? Object.entries(integrationStatus.integrations)
      : [];

    let configuredCount = 0;
    let requiredCount = 0;
    let requiredConfiguredCount = 0;

    for (const [, cfg] of entries) {
      const configured = cfg?.configured === true;
      const required = cfg?.required === true;

      if (configured) configuredCount += 1;
      if (required) {
        requiredCount += 1;
        if (configured) requiredConfiguredCount += 1;
      }
    }

    const sortedEntries = [...entries].sort((a, b) => {
      const aCfg = a[1]?.configured === true ? 1 : 0;
      const bCfg = b[1]?.configured === true ? 1 : 0;
      if (bCfg !== aCfg) return bCfg - aCfg;

      const aReq = a[1]?.required === true ? 1 : 0;
      const bReq = b[1]?.required === true ? 1 : 0;
      if (bReq !== aReq) return bReq - aReq;

      return String(a[0] || "").localeCompare(String(b[0] || ""));
    });

    return {
      entries,
      sortedEntries,
      configuredCount,
      requiredCount,
      requiredConfiguredCount,
    };
  }, [integrationStatus]);

  const {
    entries: integrationEntries,
    sortedEntries: sortedIntegrationEntries,
    configuredCount,
    requiredCount,
    requiredConfiguredCount,
  } = integrationView;

  const formattedCheckedAt = useMemo(
    () => (integrationCheckedAt ? new Date(integrationCheckedAt).toLocaleString("en-GB") : null),
    [integrationCheckedAt],
  );

  const previewRows = useMemo(
    () => (preview || []).map((company) => {
      const numericScore = Number(company.combined_score);
      return {
        ...company,
        displayScore: Number.isFinite(numericScore) ? numericScore.toFixed(2) : "N/A",
      };
    }),
    [preview],
  );

  const loadIntegrationStatus = useCallback(() => {
    const requestId = integrationRequestRef.current + 1;
    integrationRequestRef.current = requestId;

    setIntegrationLoading(true);
    setIntegrationError(null);
    fetch("/api/integrations/status")
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(`Failed to load integration status (${r.status})`);
        }
        return r.json();
      })
      .then((d) => {
        if (integrationRequestRef.current !== requestId) return;
        setIntegrationStatus(d);
        setIntegrationCheckedAt(new Date().toISOString());
      })
      .catch((err) => {
        if (integrationRequestRef.current !== requestId) return;
        setIntegrationStatus(null);
        setIntegrationError(err?.message || "Integration status unavailable");
        setIntegrationCheckedAt(new Date().toISOString());
      })
      .finally(() => {
        if (integrationRequestRef.current === requestId) {
          setIntegrationLoading(false);
        }
      });
  }, []);

  const refreshPreview = useCallback(() => {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;

    fetch("/api/unified-shortlist")
      .then((r) => r.json())
      .then((d) => {
        if (previewRequestRef.current === requestId) {
          setPreview(d.companies?.slice(0, 5) || []);
        }
      })
      .catch(() => {
        if (previewRequestRef.current === requestId) {
          setPreview([]);
        }
      });
  }, []);

  useEffect(() => {
    fetch("/api/scoring-weights")
      .then((r) => r.json())
      .then((d) => {
        setConfig(d);
        setLocalWeights(JSON.parse(JSON.stringify(d.segment_weights)));
        setPropensityWeight(d.propensity_weight);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadIntegrationStatus();
  }, [loadIntegrationStatus]);

  useEffect(() => {
    if (!localWeights || Object.keys(localWeights).length === 0) return;
    const timer = setTimeout(() => {
      refreshPreview();
    }, 300);
    return () => clearTimeout(timer);
  }, [localWeights, propensityWeight, refreshPreview]);

  const handleWeightChange = useCallback((segment, layer, value) => {
    setLocalWeights((prev) => ({
      ...prev,
      [segment]: { ...prev[segment], [layer]: value },
    }));
    setMessage(null);
  }, []);

  async function handleSave() {
    for (const seg of SEGMENTS) {
      const total = segmentTotals[seg] || 0;
      if (Math.abs(total - 1) > 0.02) {
        setMessage({ type: "error", text: `${seg} weights must sum to 100% (currently ${Math.round(total * 100)}%)` });
        return;
      }
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/scoring-weights", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment_weights: localWeights, propensity_weight: propensityWeight }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage({ type: "success", text: "Scoring weights saved. Rankings updated." });
      refreshPreview();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!confirm("Reset all scoring weights to defaults?")) return;
    setSaving(true);
    try {
      const res = await fetch("/api/scoring-weights/reset", { method: "POST" });
      const data = await res.json();
      setLocalWeights(JSON.parse(JSON.stringify(data.segment_weights)));
      setPropensityWeight(data.propensity_weight);
      setMessage({ type: "success", text: "Weights reset to defaults." });
    } catch {
      setMessage({ type: "error", text: "Reset failed" });
    } finally {
      setSaving(false);
    }
  }

  if (!config) return <div style={{ color: "#888" }}>Loading settings…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Scoring Settings</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleReset} style={{
            padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff",
            cursor: "pointer", fontSize: 13, color: "#555",
          }}>
            Reset to Defaults
          </button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: "8px 20px", borderRadius: 6, border: "none", background: "#0075EB", color: "#fff",
            fontWeight: 600, fontSize: 13, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1,
          }}>
            {saving ? "Saving…" : "Save Weights"}
          </button>
        </div>
      </div>

      {message && (
        <div style={{
          padding: "8px 14px", borderRadius: 6, marginBottom: 16, fontSize: 13,
          background: message.type === "success" ? "#d1fae5" : "#fee2e2",
          color: message.type === "success" ? "#065f46" : "#991b1b",
        }}>
          {message.text}
        </div>
      )}

      <p style={{ fontSize: 13, color: "#666", marginBottom: 16 }}>
        Adjust how each scoring layer is weighted per segment. Weights must sum to 100% within each segment. 
        Changes affect how companies are ranked in the shortlist.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
        {SEGMENTS.map((seg) => (
          <SegmentWeightsCard
            key={seg}
            segment={seg}
            weights={localWeights[seg] || {}}
            onChange={handleWeightChange}
            total={segmentTotals[seg] || 0}
          />
        ))}
      </div>

      <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 20 }}>
        <h4 style={{ margin: "0 0 12px", fontSize: 15 }}>Response Propensity Weight</h4>
        <p style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>
          How much propensity (warmth/engagement) adjusts the final ranking. Higher = more weight on engagement signals.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "#888" }}>0%</span>
          <input
            type="range" min={0} max={50} step={1}
            value={Math.round(propensityWeight * 100)}
            onChange={(e) => { setPropensityWeight(parseInt(e.target.value) / 100); setMessage(null); }}
            style={{ flex: 1, accentColor: "#e67e22" }}
          />
          <span style={{ fontSize: 12, color: "#888" }}>50%</span>
          <span style={{ fontSize: 14, fontWeight: 600, minWidth: 40, textAlign: "right" }}>
            {Math.round(propensityWeight * 100)}%
          </span>
        </div>
      </div>

      <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <h4 style={{ margin: 0, fontSize: 15 }}>API Integrations Setup</h4>
            {!integrationLoading && integrationEntries.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 12, color: "#475569" }}>
                {configuredCount}/{integrationEntries.length} configured · required {requiredConfiguredCount}/{requiredCount}
              </div>
            )}
            {!integrationLoading && integrationCheckedAt && (
              <div style={{ marginTop: 3, fontSize: 11, color: "#64748b" }}>
                Last checked: {formattedCheckedAt}
              </div>
            )}
          </div>
          <button
            onClick={loadIntegrationStatus}
            style={{
              padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff",
              cursor: "pointer", fontSize: 12, color: "#555",
            }}
          >
            Refresh Status
          </button>
        </div>

        {integrationLoading && (
          <div style={{ fontSize: 12, color: "#888" }}>Checking integration status...</div>
        )}

        {!integrationLoading && integrationError && (
          <div style={{ fontSize: 12, color: "#991b1b", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 10px" }}>
            {integrationError}
          </div>
        )}

        {!integrationLoading && !integrationError && !integrationStatus && (
          <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            Integration status has not loaded yet. Click "Refresh Status" to retry.
          </div>
        )}

        {!integrationLoading && integrationStatus?.integrations && (
          <div>
            {sortedIntegrationEntries.map(([name, cfg]) => (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#333", textTransform: "capitalize" }}>{name.replace(/_/g, " ")}</div>
                  <div style={{ fontSize: 12, color: "#777" }}>{cfg.purpose}</div>
                  {cfg.env_var && <div style={{ fontSize: 11, color: "#999" }}>env: {cfg.env_var}</div>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: cfg.configured ? "#166534" : cfg.required ? "#991b1b" : "#92400e" }}>
                  {cfg.configured ? "Configured" : cfg.required ? "Missing (required)" : "Not configured"}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 10, fontSize: 12, color: integrationStatus.ready_for_production ? "#166534" : "#991b1b", fontWeight: 600 }}>
              {integrationStatus.ready_for_production
                ? "Required integrations are configured."
                : `Missing required: ${(integrationStatus.missing_required || []).join(", ")}`}
            </div>

            {integrationStatus.env_template?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#555", marginBottom: 6 }}>Suggested .env entries</div>
                <pre style={{ margin: 0, background: "#f8f9fb", border: "1px solid #eceff3", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto" }}>
                  {integrationStatus.env_template.join("\n")}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {preview && preview.length > 0 && (
        <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <h4 style={{ margin: "0 0 12px", fontSize: 15 }}>
            Ranking Preview
            <span style={{ fontWeight: 400, color: "#888", fontSize: 12, marginLeft: 8 }}>Top 5 with current weights</span>
          </h4>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: "#f0f2f5", color: "#555" }}>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>#</th>
              <th style={{ padding: "6px 12px", textAlign: "left" }}>Company</th>
              <th style={{ padding: "6px 12px", textAlign: "center" }}>Segment</th>
              <th style={{ padding: "6px 12px", textAlign: "right" }}>Score</th>
            </tr></thead>
            <tbody>
              {previewRows.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "6px 12px" }}>{c.rank}</td>
                  <td style={{ padding: "6px 12px", fontWeight: 600 }}>{c.name}</td>
                  <td style={{ padding: "6px 12px", textAlign: "center", fontSize: 11 }}>{c.segment}</td>
                  <td style={{ padding: "6px 12px", textAlign: "right", fontWeight: 600 }}>{c.displayScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
