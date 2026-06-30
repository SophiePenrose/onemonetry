import React, { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

const CONNECTOR_META = {
  prospeo: {
    label: "Prospeo",
    envelopeFocus: ["hiring_signals", "marketing_intelligence", "tech_stack"],
  },
  phantombuster: {
    label: "PhantomBuster",
    envelopeFocus: ["hiring_signals", "marketing_intelligence", "tech_stack"],
  },
};

function formatTimestamp(value) {
  if (!value) return "Not available";
  const millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) return String(value);
  return new Date(millis).toLocaleString("en-GB");
}

function toBoolLabel(value) {
  return value ? "Yes" : "No";
}

function toCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(numeric);
}

function summarizeEnvelope(key, envelope) {
  const payload = envelope?.data && typeof envelope.data === "object" ? envelope.data : null;
  if (!payload) {
    return ["No payload stored for this envelope."];
  }

  if (key === "hiring_signals") {
    const financeRoles = Array.isArray(payload.finance_roles_open) ? payload.finance_roles_open : [];
    const treasuryRoles = Array.isArray(payload.treasury_roles_open) ? payload.treasury_roles_open : [];
    const openRoles = Array.isArray(payload.open_roles) ? payload.open_roles : [];
    return [
      `signal score: ${payload.hiring_signal_score ?? "n/a"}`,
      `intensity: ${payload.hiring_intensity || "n/a"}`,
      `total open roles: ${toCount(payload.total_open_roles || openRoles.length)}`,
      `finance roles: ${financeRoles.length}`,
      `treasury roles: ${treasuryRoles.length}`,
      financeRoles.length > 0 ? `sample finance role: ${financeRoles[0]?.name || financeRoles[0]?.role || "n/a"}` : null,
    ].filter(Boolean);
  }

  if (key === "tech_stack") {
    const technologies = Array.isArray(payload.technologies)
      ? payload.technologies
      : (Array.isArray(payload.detected_technologies) ? payload.detected_technologies : []);
    return [
      `confidence score: ${payload.confidence_score ?? "n/a"}`,
      `technology count: ${technologies.length}`,
      technologies.length > 0 ? `sample technologies: ${technologies.slice(0, 6).join(", ")}` : "sample technologies: none",
      `signal count: ${payload.signal_count ?? technologies.length}`,
    ];
  }

  if (key === "marketing_intelligence") {
    const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
    const trafficGeography = payload.traffic_geography && typeof payload.traffic_geography === "object"
      ? payload.traffic_geography
      : {};
    const topTrafficGeo = Object.entries(trafficGeography)
      .map(([country, share]) => ({ country, share: Number(share) }))
      .filter((item) => Number.isFinite(item.share))
      .sort((a, b) => b.share - a.share)[0] || null;

    return [
      `confidence score: ${payload.confidence_score ?? "n/a"}`,
      `monthly web traffic: ${toCompactNumber(payload.monthly_web_traffic ?? payload.web_traffic)}`,
      `estimated ad spend: ${toCompactNumber(payload.estimated_monthly_ad_spend)}`,
      topTrafficGeo ? `top traffic geography: ${topTrafficGeo.country} (${topTrafficGeo.share}%)` : null,
      `growth signal score: ${payload.growth_signal_score ?? "n/a"}`,
      `active channels: ${payload.active_channels ?? payload.channel_count ?? "n/a"}`,
      evidence.length > 0 ? `sample evidence: ${String(evidence[0])}` : null,
    ].filter(Boolean);
  }

  if (key === "reputation") {
    return [
      `confidence score: ${payload.confidence_score ?? "n/a"}`,
      `status health band: ${payload.status_health_band || "n/a"}`,
      `open incidents: ${payload.status_incidents_open ?? "n/a"}`,
      `major incidents open: ${payload.status_major_incidents_open ?? "n/a"}`,
      `incident severity score: ${payload.status_incident_severity_score ?? "n/a"}`,
    ];
  }

  if (key === "ownership") {
    const nonUkControllers = Array.isArray(payload.non_uk_significant_corporate_controllers)
      ? payload.non_uk_significant_corporate_controllers
      : [];
    return [
      `structure: ${payload.structure || "n/a"}`,
      `confidence: ${payload.confidence || "n/a"}`,
      `non-UK controller count: ${payload.non_uk_significant_corporate_controllers_count ?? nonUkControllers.length}`,
      nonUkControllers.length > 0 ? `sample non-UK controller: ${nonUkControllers[0]?.name || "n/a"}` : null,
    ].filter(Boolean);
  }

  const scalarFields = Object.entries(payload)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6)
    .map(([field, value]) => `${field}: ${String(value)}`);

  if (scalarFields.length > 0) return scalarFields;
  return ["Payload exists but has no scalar preview fields."];
}

function EnvelopeCard({ title, envelope }) {
  const payload = envelope?.data && typeof envelope.data === "object" ? envelope.data : null;
  const externalSources = Array.isArray(payload?.external_sources) ? payload.external_sources : [];
  const source = payload?.source || null;
  const previewLines = useMemo(() => summarizeEnvelope(title, envelope), [title, envelope]);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>{title.replaceAll("_", " ")}</div>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: envelope?.available ? "#065f46" : "#92400e",
          background: envelope?.available ? "#dcfce7" : "#fef3c7",
          borderRadius: 999,
          padding: "2px 8px",
        }}>
          {envelope?.available ? "Available" : "Not available"}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#4b5563", marginBottom: 6 }}>
        Updated: {formatTimestamp(envelope?.updated_at)} · Stale: {toBoolLabel(envelope?.stale)}
      </div>
      {source && (
        <div style={{ fontSize: 12, color: "#4b5563", marginBottom: 6 }}>
          Source: {source}
        </div>
      )}
      {externalSources.length > 0 && (
        <div style={{ fontSize: 12, color: "#4b5563", marginBottom: 6 }}>
          External sources: {externalSources.join(", ")}
        </div>
      )}
      <div style={{ fontSize: 12, color: "#374151" }}>
        {previewLines.map((line) => (
          <div key={line} style={{ marginBottom: 3 }}>{line}</div>
        ))}
      </div>
    </div>
  );
}

EnvelopeCard.propTypes = {
  title: PropTypes.string.isRequired,
  envelope: PropTypes.object,
};

export default function EnrichmentSignalsPanel({ companyId, companyNumber }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [integrations, setIntegrations] = useState(null);
  const [syncLoading, setSyncLoading] = useState({ prospeo: false, phantombuster: false });
  const [syncMessage, setSyncMessage] = useState(null);
  const normalizedCompanyNumber = useMemo(() => {
    const raw = String(companyNumber || companyId || "").trim().toUpperCase();
    if (!raw) return "";

    const stripped = raw.replace(/^CH-/, "").replace(/\s+/g, "");
    if (!stripped) return "";
    if (/^\d{1,8}$/.test(stripped)) return stripped.padStart(8, "0");
    return stripped;
  }, [companyId, companyNumber]);

  const loadSnapshot = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [snapshotRes, integrationsRes] = await Promise.all([
        fetch(`/api/company/${encodeURIComponent(companyId)}/enrichment?include_data=true`),
        fetch("/api/integrations/status"),
      ]);

      const snapshotData = await snapshotRes.json().catch(() => ({}));
      const integrationData = await integrationsRes.json().catch(() => ({}));

      if (!snapshotRes.ok) {
        throw new Error(snapshotData.error || "Failed to load enrichment snapshot");
      }
      if (!integrationsRes.ok) {
        throw new Error(integrationData.error || "Failed to load integration status");
      }

      setSnapshot(snapshotData);
      setIntegrations(integrationData.integrations || null);
    } catch (err) {
      setError(err?.message || "Failed to load enrichment data");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  const runTargetedSync = useCallback(async (connectorId) => {
    if (!normalizedCompanyNumber || !connectorId) return;

    setSyncMessage(null);
    setSyncLoading((prev) => ({ ...prev, [connectorId]: true }));
    try {
      const response = await fetch(`/api/signals/sync/${encodeURIComponent(normalizedCompanyNumber)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectors: [connectorId] }),
      });
      const payload = await response.json().catch(() => ({}));
      const connectorLabel = CONNECTOR_META[connectorId]?.label || connectorId;
      const integration = integrations?.[connectorId] || null;

      if (payload?.status === "no_connectors_configured") {
        throw new Error(
          integration?.env_var
            ? `${connectorLabel} is not configured. Required env: ${integration.env_var}.`
            : `${connectorLabel} is not configured in backend runtime.`
        );
      }

      if (!response.ok) {
        throw new Error(payload.error || `${connectorLabel} sync failed`);
      }

      const connectorResult = (Array.isArray(payload.connectors) ? payload.connectors : []).find((item) => item.id === connectorId);
      const success = connectorResult?.ok === true;
      const updatedFlags = [
        connectorResult?.hiring_updated ? "hiring" : null,
        connectorResult?.marketing_updated ? "marketing" : null,
        connectorResult?.tech_updated ? "tech" : null,
        connectorResult?.reputation_updated ? "reputation" : null,
        connectorResult?.ownership_updated ? "ownership" : null,
      ].filter(Boolean);

      setSyncMessage({
        type: success ? "success" : "error",
        text: success
          ? `${connectorLabel} sync completed. Updated: ${updatedFlags.length > 0 ? updatedFlags.join(", ") : "no envelopes"}.`
          : `${connectorLabel} sync failed (${connectorResult?.failure_category || payload?.status || "unknown"}).`,
      });

      await loadSnapshot();
    } catch (err) {
      setSyncMessage({ type: "error", text: err?.message || "Connector sync failed" });
    } finally {
      setSyncLoading((prev) => ({ ...prev, [connectorId]: false }));
    }
  }, [integrations, loadSnapshot, normalizedCompanyNumber]);

  const envelope = snapshot?.enrichment || {};
  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.08)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>External Enrichment Visibility</h3>
        <button
          onClick={loadSnapshot}
          disabled={loading}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: "#fff",
            color: "#374151",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            fontSize: 12,
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>
        Prospeo and PhantomBuster are merged into hiring, marketing, and tech envelopes. These envelopes feed scoring and can influence which companies are selected for Gemini sequence generation.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 12 }}>
        {Object.entries(CONNECTOR_META).map(([connectorId, meta]) => {
          const integration = integrations?.[connectorId] || null;
          const configured = Boolean(integration?.configured);
          const syncing = syncLoading[connectorId] === true;
          const envVarHint = String(integration?.env_var || "").trim();
          return (
            <div key={connectorId} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#1f2937" }}>{meta.label}</div>
                <span style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: configured ? "#166534" : "#92400e",
                  background: configured ? "#dcfce7" : "#fef3c7",
                  borderRadius: 999,
                  padding: "2px 8px",
                }}>
                  {configured ? "Configured" : "Not configured"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>
                Feeds: {meta.envelopeFocus.map((name) => name.replaceAll("_", " ")).join(", ")}
              </div>
              {!configured && envVarHint && (
                <div style={{ fontSize: 11, color: "#7c2d12", marginBottom: 8 }}>
                  Required env: {envVarHint}
                </div>
              )}
              <button
                onClick={() => runTargetedSync(connectorId)}
                disabled={!configured || !normalizedCompanyNumber || syncing}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: "#0f766e",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: !configured || !normalizedCompanyNumber || syncing ? "not-allowed" : "pointer",
                  opacity: !configured || !normalizedCompanyNumber || syncing ? 0.6 : 1,
                  fontSize: 12,
                }}
              >
                {syncing ? "Syncing..." : `Run ${meta.label} Sync`}
              </button>
            </div>
          );
        })}
      </div>

      {syncMessage && (
        <div style={{
          marginBottom: 12,
          fontSize: 12,
          borderRadius: 6,
          padding: "8px 10px",
          background: syncMessage.type === "success" ? "#d1fae5" : "#fee2e2",
          color: syncMessage.type === "success" ? "#065f46" : "#991b1b",
        }}>
          {syncMessage.text}
        </div>
      )}

      {error && (
        <div style={{ color: "#991b1b", fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}

      {!error && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
          <EnvelopeCard title="hiring_signals" envelope={envelope.hiring_signals} />
          <EnvelopeCard title="marketing_intelligence" envelope={envelope.marketing_intelligence} />
          <EnvelopeCard title="tech_stack" envelope={envelope.tech_stack} />
          <EnvelopeCard title="reputation" envelope={envelope.reputation} />
          <EnvelopeCard title="ownership" envelope={envelope.ownership} />
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: "#6b7280" }}>
        Match logic: connector payloads are normalized by company number and merged into settings keys such as hiring_signals_&lt;company&gt;, marketing_intelligence_&lt;company&gt;, and tech_stack_&lt;company&gt;.
      </div>
    </div>
  );
}

EnrichmentSignalsPanel.propTypes = {
  companyId: PropTypes.string.isRequired,
  companyNumber: PropTypes.string,
};
