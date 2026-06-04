import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";

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
const OWNERSHIP_CHANGES_PAGE_SIZE = 20;
const OWNERSHIP_MONITOR_POLL_INTERVAL_MS = 10000;
const OWNERSHIP_SORT_OPTIONS = [
  { value: "recent", label: "Most Recent" },
  { value: "impact", label: "High Impact First" },
];

const OWNERSHIP_TRIAGE_PRESET_OPTIONS = [
  { value: "custom", label: "Custom" },
  { value: "cross_border_priority", label: "Cross-border Priority" },
  { value: "high_impact_multi_signal", label: "High Impact + Multi-Signal" },
  { value: "parent_restructure_watch", label: "Parent Restructure Watch" },
];

const OWNERSHIP_TRIAGE_PRESET_CONFIGS = {
  cross_border_priority: {
    since_days: 90,
    sort: "impact",
    min_changed_fields: "all",
    parent_country_scope: "non_uk",
    changed_field: "all",
    impact: "all",
  },
  high_impact_multi_signal: {
    since_days: 90,
    sort: "impact",
    min_changed_fields: "2",
    parent_country_scope: "all",
    changed_field: "all",
    impact: "high",
  },
  parent_restructure_watch: {
    since_days: 180,
    sort: "recent",
    min_changed_fields: "all",
    parent_country_scope: "all",
    changed_field: "parent_company",
    impact: "all",
  },
};

const OWNERSHIP_TRIAGE_STORAGE_KEY = "settings.ownershipTriage.v1";

function getDefaultOwnershipTriageState() {
  return {
    preset: "custom",
    since_days: 30,
    sort: "recent",
    min_changed_fields: "all",
    parent_country_scope: "all",
    changed_field: "all",
    impact: "all",
  };
}

function readStoredOwnershipTriageState() {
  const defaults = getDefaultOwnershipTriageState();

  if (typeof window === "undefined" || !window.localStorage) {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(OWNERSHIP_TRIAGE_STORAGE_KEY);
    if (!raw) return defaults;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }

    const preset = String(parsed.preset || defaults.preset);
    const sort = String(parsed.sort || defaults.sort);
    const minChangedFields = String(parsed.min_changed_fields || defaults.min_changed_fields);
    const parentCountryScope = String(parsed.parent_country_scope || defaults.parent_country_scope);
    const changedField = String(parsed.changed_field || defaults.changed_field).trim() || defaults.changed_field;
    const impact = String(parsed.impact || defaults.impact);
    const sinceDays = Number.parseInt(String(parsed.since_days ?? defaults.since_days), 10);

    const validPresetValues = new Set(OWNERSHIP_TRIAGE_PRESET_OPTIONS.map((option) => option.value));
    const validSortValues = new Set(OWNERSHIP_SORT_OPTIONS.map((option) => option.value));

    return {
      preset: validPresetValues.has(preset) ? preset : defaults.preset,
      since_days: [30, 90, 180].includes(sinceDays) ? sinceDays : defaults.since_days,
      sort: validSortValues.has(sort) ? sort : defaults.sort,
      min_changed_fields: ["all", "2", "3"].includes(minChangedFields) ? minChangedFields : defaults.min_changed_fields,
      parent_country_scope: ["all", "non_uk", "uk", "unknown"].includes(parentCountryScope)
        ? parentCountryScope
        : defaults.parent_country_scope,
      changed_field: changedField,
      impact: ["all", "high", "standard"].includes(impact) ? impact : defaults.impact,
    };
  } catch {
    return defaults;
  }
}

function writeStoredOwnershipTriageState(state) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(OWNERSHIP_TRIAGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore persistence failures (for example private mode quota restrictions).
  }
}

function clearStoredOwnershipTriageState() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.removeItem(OWNERSHIP_TRIAGE_STORAGE_KEY);
  } catch {
    // Ignore persistence failures (for example private mode quota restrictions).
  }
}

function normalizeSicToken(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 5 ? digits : null;
}

function parseSicListInput(rawValue) {
  const parts = (String(rawValue || "").match(/\d(?:[\s-]?\d){4}/g) || [])
    .map((token) => normalizeSicToken(token))
    .filter(Boolean);

  return [...new Set(parts)];
}

function formatTimestampLabel(value) {
  if (!value) return "Unknown";
  const ts = Date.parse(String(value));
  if (!Number.isFinite(ts)) return "Unknown";
  return new Date(ts).toLocaleString("en-GB");
}

function humanizeFieldToken(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatIntervalLabel(intervalMs) {
  const numeric = Number(intervalMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return "Unknown";

  const totalMinutes = Math.round(numeric / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = totalMinutes / 60;
  const displayHours = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${displayHours} hr`;
}

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

WeightSlider.propTypes = {
  layer: PropTypes.oneOf(Object.keys(LAYER_LABELS)).isRequired,
  value: PropTypes.number,
  color: PropTypes.string,
  onChange: PropTypes.func.isRequired,
};

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

SegmentWeightsCard.propTypes = {
  segment: PropTypes.oneOf(SEGMENTS).isRequired,
  weights: PropTypes.objectOf(PropTypes.number),
  onChange: PropTypes.func.isRequired,
  total: PropTypes.number.isRequired,
};

export default function Settings({ onNavigateToCompany }) {
  const initialOwnershipTriageState = useMemo(() => readStoredOwnershipTriageState(), []);
  const [config, setConfig] = useState(null);
  const [localWeights, setLocalWeights] = useState({});
  const [propensityWeight, setPropensityWeight] = useState(0.15);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [exclusionMessage, setExclusionMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [exclusions, setExclusions] = useState(null);
  const [sicInput, setSicInput] = useState("");
  const [exclusionsLoading, setExclusionsLoading] = useState(false);
  const [savingExclusions, setSavingExclusions] = useState(false);
  const [integrationStatus, setIntegrationStatus] = useState(null);
  const [integrationLoading, setIntegrationLoading] = useState(false);
  const [integrationError, setIntegrationError] = useState(null);
  const [integrationCheckedAt, setIntegrationCheckedAt] = useState(null);
  const [ownershipChanges, setOwnershipChanges] = useState(null);
  const [ownershipChangesLoading, setOwnershipChangesLoading] = useState(false);
  const [ownershipChangesError, setOwnershipChangesError] = useState(null);
  const [ownershipSinceDays, setOwnershipSinceDays] = useState(initialOwnershipTriageState.since_days);
  const [ownershipTriagePreset, setOwnershipTriagePreset] = useState(initialOwnershipTriageState.preset);
  const [ownershipSortMode, setOwnershipSortMode] = useState(initialOwnershipTriageState.sort);
  const [ownershipSignalDensity, setOwnershipSignalDensity] = useState(initialOwnershipTriageState.min_changed_fields);
  const [ownershipParentCountryScope, setOwnershipParentCountryScope] = useState(initialOwnershipTriageState.parent_country_scope);
  const [ownershipChangedField, setOwnershipChangedField] = useState(initialOwnershipTriageState.changed_field);
  const [ownershipImpactFilter, setOwnershipImpactFilter] = useState(initialOwnershipTriageState.impact);
  const [ownershipChangesCheckedAt, setOwnershipChangesCheckedAt] = useState(null);
  const [ownershipMonitorStatus, setOwnershipMonitorStatus] = useState(null);
  const [ownershipMonitorLoading, setOwnershipMonitorLoading] = useState(false);
  const [ownershipMonitorError, setOwnershipMonitorError] = useState(null);
  const [ownershipRunLoading, setOwnershipRunLoading] = useState(false);
  const [ownershipRunMessage, setOwnershipRunMessage] = useState(null);
  const [ownershipBatchSize, setOwnershipBatchSize] = useState("100");
  const [ownershipSchedulerLoading, setOwnershipSchedulerLoading] = useState(false);
  const [ownershipSchedulerMessage, setOwnershipSchedulerMessage] = useState(null);
  const integrationRequestRef = useRef(0);
  const ownershipChangesRequestRef = useRef(0);
  const ownershipMonitorRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const skipOwnershipTriagePersistenceRef = useRef(false);

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

  const formattedOwnershipCheckedAt = useMemo(
    () => (ownershipChangesCheckedAt ? new Date(ownershipChangesCheckedAt).toLocaleString("en-GB") : null),
    [ownershipChangesCheckedAt],
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

  const ownershipProgress = useMemo(
    () => (ownershipMonitorStatus?.progress && typeof ownershipMonitorStatus.progress === "object"
      ? ownershipMonitorStatus.progress
      : null),
    [ownershipMonitorStatus],
  );

  const ownershipProgressPercent = useMemo(() => {
    if (!ownershipProgress) return 0;
    const total = Number(ownershipProgress.total || 0);
    const checked = Number(ownershipProgress.checked || 0);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (!Number.isFinite(checked) || checked <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((checked / total) * 100)));
  }, [ownershipProgress]);

  const ownershipRows = useMemo(
    () => (Array.isArray(ownershipChanges?.rows) ? ownershipChanges.rows : []),
    [ownershipChanges],
  );

  const ownershipMonitorRunning = ownershipMonitorStatus?.running === true;
  const ownershipChangesRefreshing = ownershipChangesLoading && ownershipRows.length > 0;

  const ownershipHasMore = useMemo(() => {
    const total = Number(ownershipChanges?.total || 0);
    return total > ownershipRows.length;
  }, [ownershipChanges, ownershipRows]);

  const ownershipChangedFieldCounts = useMemo(() => {
    const rawCounts = ownershipChanges?.changed_fields_counts;
    if (!rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) return {};

    const normalized = {};
    for (const [field, value] of Object.entries(rawCounts)) {
      const key = String(field || "").trim();
      if (!key) continue;
      const count = Number(value);
      normalized[key] = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
    }
    return normalized;
  }, [ownershipChanges]);

  const ownershipImpactCounts = useMemo(() => {
    const rawCounts = ownershipChanges?.impact_counts;
    if (!rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) {
      return { high: 0, standard: 0 };
    }
    const high = Number(rawCounts.high);
    const standard = Number(rawCounts.standard);
    return {
      high: Number.isFinite(high) && high > 0 ? Math.round(high) : 0,
      standard: Number.isFinite(standard) && standard > 0 ? Math.round(standard) : 0,
    };
  }, [ownershipChanges]);

  const ownershipChangedFieldCountBuckets = useMemo(() => {
    const rawCounts = ownershipChanges?.changed_fields_count_buckets;
    if (!rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) {
      return {
        zero: 0,
        one: 0,
        two: 0,
        threePlus: 0,
      };
    }

    const zero = Number(rawCounts["0"]);
    const one = Number(rawCounts["1"]);
    const two = Number(rawCounts["2"]);
    const threePlus = Number(rawCounts["3_plus"]);

    return {
      zero: Number.isFinite(zero) && zero > 0 ? Math.round(zero) : 0,
      one: Number.isFinite(one) && one > 0 ? Math.round(one) : 0,
      two: Number.isFinite(two) && two > 0 ? Math.round(two) : 0,
      threePlus: Number.isFinite(threePlus) && threePlus > 0 ? Math.round(threePlus) : 0,
    };
  }, [ownershipChanges]);

  const ownershipParentCountryScopeCounts = useMemo(() => {
    const rawCounts = ownershipChanges?.parent_country_scope_counts;
    if (!rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) {
      return {
        uk: 0,
        nonUk: 0,
        unknown: 0,
      };
    }

    const uk = Number(rawCounts.uk);
    const nonUk = Number(rawCounts.non_uk);
    const unknown = Number(rawCounts.unknown);

    return {
      uk: Number.isFinite(uk) && uk > 0 ? Math.round(uk) : 0,
      nonUk: Number.isFinite(nonUk) && nonUk > 0 ? Math.round(nonUk) : 0,
      unknown: Number.isFinite(unknown) && unknown > 0 ? Math.round(unknown) : 0,
    };
  }, [ownershipChanges]);

  const ownershipChangedFieldOptions = useMemo(() => {
    const baseFields = Array.isArray(ownershipMonitorStatus?.change_fields)
      ? ownershipMonitorStatus.change_fields.map((field) => String(field || "").trim()).filter(Boolean)
      : [];
    const extraFields = Object.keys(ownershipChangedFieldCounts)
      .filter((field) => !baseFields.includes(field))
      .sort((a, b) => a.localeCompare(b));
    const uniqueFields = [...new Set([...baseFields, ...extraFields])];

    return [
      { value: "all", label: "All fields" },
      ...uniqueFields.map((field) => {
        const count = Number(ownershipChangedFieldCounts[field] || 0);
        const label = count > 0
          ? `${humanizeFieldToken(field)} (${count})`
          : humanizeFieldToken(field);
        return { value: field, label };
      }),
    ];
  }, [ownershipChangedFieldCounts, ownershipMonitorStatus]);

  const ownershipChangedFieldLabel = ownershipChangedField !== "all"
    ? humanizeFieldToken(ownershipChangedField)
    : null;

  const ownershipImpactOptions = useMemo(() => [
    { value: "all", label: "All impact levels" },
    {
      value: "high",
      label: ownershipImpactCounts.high > 0 ? `High impact (${ownershipImpactCounts.high})` : "High impact",
    },
    {
      value: "standard",
      label: ownershipImpactCounts.standard > 0 ? `Standard impact (${ownershipImpactCounts.standard})` : "Standard impact",
    },
  ], [ownershipImpactCounts]);

  const ownershipImpactFilterLabel = ownershipImpactFilter === "high"
    ? "High impact"
    : ownershipImpactFilter === "standard"
      ? "Standard impact"
      : null;

  const ownershipSortLabel = ownershipSortMode === "impact"
    ? "High impact first"
    : "Most recent";

  const ownershipSignalDensityOptions = useMemo(() => {
    const allCount = ownershipChangedFieldCountBuckets.zero
      + ownershipChangedFieldCountBuckets.one
      + ownershipChangedFieldCountBuckets.two
      + ownershipChangedFieldCountBuckets.threePlus;
    const multiCount = ownershipChangedFieldCountBuckets.two + ownershipChangedFieldCountBuckets.threePlus;
    const broadCount = ownershipChangedFieldCountBuckets.threePlus;

    return [
      {
        value: "all",
        label: allCount > 0 ? `All signals (${allCount})` : "All signals",
      },
      {
        value: "2",
        label: multiCount > 0 ? `2+ fields (${multiCount})` : "2+ fields",
      },
      {
        value: "3",
        label: broadCount > 0 ? `3+ fields (${broadCount})` : "3+ fields",
      },
    ];
  }, [ownershipChangedFieldCountBuckets]);

  const ownershipSignalDensityLabel = ownershipSignalDensity === "2"
    ? "2+ fields"
    : ownershipSignalDensity === "3"
      ? "3+ fields"
      : null;

  const ownershipParentCountryScopeOptions = useMemo(() => {
    const allCount = ownershipParentCountryScopeCounts.uk
      + ownershipParentCountryScopeCounts.nonUk
      + ownershipParentCountryScopeCounts.unknown;
    return [
      {
        value: "all",
        label: allCount > 0 ? `All parent countries (${allCount})` : "All parent countries",
      },
      {
        value: "non_uk",
        label: ownershipParentCountryScopeCounts.nonUk > 0
          ? `Non-UK parent (${ownershipParentCountryScopeCounts.nonUk})`
          : "Non-UK parent",
      },
      {
        value: "uk",
        label: ownershipParentCountryScopeCounts.uk > 0
          ? `UK parent (${ownershipParentCountryScopeCounts.uk})`
          : "UK parent",
      },
      {
        value: "unknown",
        label: ownershipParentCountryScopeCounts.unknown > 0
          ? `Unknown parent (${ownershipParentCountryScopeCounts.unknown})`
          : "Unknown parent",
      },
    ];
  }, [ownershipParentCountryScopeCounts]);

  const ownershipParentCountryScopeLabel = ownershipParentCountryScope === "non_uk"
    ? "Non-UK parent"
    : ownershipParentCountryScope === "uk"
      ? "UK parent"
      : ownershipParentCountryScope === "unknown"
        ? "Unknown parent"
        : null;

  const ownershipTriagePresetLabel = useMemo(() => {
    if (ownershipTriagePreset === "custom") return null;
    const selectedPreset = OWNERSHIP_TRIAGE_PRESET_OPTIONS.find((option) => option.value === ownershipTriagePreset);
    return selectedPreset?.label || null;
  }, [ownershipTriagePreset]);

  const applyOwnershipTriagePreset = useCallback((presetKey) => {
    const preset = OWNERSHIP_TRIAGE_PRESET_CONFIGS[presetKey];
    if (!preset) return;

    setOwnershipSinceDays(Number.parseInt(String(preset.since_days || 30), 10) || 30);
    setOwnershipSortMode(String(preset.sort || "recent"));
    setOwnershipSignalDensity(String(preset.min_changed_fields || "all"));
    setOwnershipParentCountryScope(String(preset.parent_country_scope || "all"));
    setOwnershipChangedField(String(preset.changed_field || "all"));
    setOwnershipImpactFilter(String(preset.impact || "all"));
  }, []);

  const resetOwnershipTriagePreferences = useCallback(() => {
    const defaults = getDefaultOwnershipTriageState();

    skipOwnershipTriagePersistenceRef.current = true;
    clearStoredOwnershipTriageState();
    setOwnershipTriagePreset(defaults.preset);
    setOwnershipSinceDays(defaults.since_days);
    setOwnershipSortMode(defaults.sort);
    setOwnershipSignalDensity(defaults.min_changed_fields);
    setOwnershipParentCountryScope(defaults.parent_country_scope);
    setOwnershipChangedField(defaults.changed_field);
    setOwnershipImpactFilter(defaults.impact);
  }, []);

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

  const loadOwnershipChanges = useCallback((options = {}) => {
    const requestId = ownershipChangesRequestRef.current + 1;
    ownershipChangesRequestRef.current = requestId;

    const requestedOffset = Number.parseInt(String(options.offset ?? 0), 10);
    const safeOffset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    const append = options.append === true && safeOffset > 0;

    setOwnershipChangesLoading(true);
    setOwnershipChangesError(null);

    const query = new URLSearchParams({
      limit: String(OWNERSHIP_CHANGES_PAGE_SIZE),
      offset: String(safeOffset),
      since_days: String(ownershipSinceDays),
    });
    if (ownershipSortMode !== "recent") {
      query.set("sort", ownershipSortMode);
    }
    if (ownershipSignalDensity !== "all") {
      query.set("min_changed_fields", ownershipSignalDensity);
    }
    if (ownershipParentCountryScope !== "all") {
      query.set("parent_country_scope", ownershipParentCountryScope);
    }
    if (ownershipChangedField !== "all") {
      query.set("changed_field", ownershipChangedField);
    }
    if (ownershipImpactFilter !== "all") {
      query.set("impact", ownershipImpactFilter);
    }

    fetch(`/api/monitor/ownership/changes?${query.toString()}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load ownership changes (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (ownershipChangesRequestRef.current !== requestId) return;

        const normalized = {
          total: Number.isFinite(Number(data?.total)) ? Number(data.total) : 0,
          limit: Number.isFinite(Number(data?.limit)) ? Number(data.limit) : OWNERSHIP_CHANGES_PAGE_SIZE,
          offset: Number.isFinite(Number(data?.offset)) ? Number(data.offset) : safeOffset,
          since_days: Number.isFinite(Number(data?.since_days)) ? Number(data.since_days) : ownershipSinceDays,
          sort: String(data?.sort || ownershipSortMode || "recent").toLowerCase(),
          min_changed_fields: Number.isFinite(Number(data?.min_changed_fields)) ? Number(data.min_changed_fields) : 0,
          changed_fields_filter: Array.isArray(data?.changed_fields_filter) ? data.changed_fields_filter.filter(Boolean) : [],
          changed_fields_counts: data?.changed_fields_counts && typeof data.changed_fields_counts === "object" && !Array.isArray(data.changed_fields_counts)
            ? data.changed_fields_counts
            : {},
          changed_fields_count_buckets: data?.changed_fields_count_buckets && typeof data.changed_fields_count_buckets === "object" && !Array.isArray(data.changed_fields_count_buckets)
            ? data.changed_fields_count_buckets
            : {},
          parent_country_scope_filter: String(data?.parent_country_scope_filter || ownershipParentCountryScope || "all").toLowerCase(),
          parent_country_scope_counts: data?.parent_country_scope_counts && typeof data.parent_country_scope_counts === "object" && !Array.isArray(data.parent_country_scope_counts)
            ? data.parent_country_scope_counts
            : {},
          impact_filter: String(data?.impact_filter || ownershipImpactFilter || "all").toLowerCase(),
          impact_counts: data?.impact_counts && typeof data.impact_counts === "object" && !Array.isArray(data.impact_counts)
            ? data.impact_counts
            : {},
          rows: Array.isArray(data?.rows) ? data.rows : [],
        };

        setOwnershipChanges((previous) => {
          if (!append || !previous) return normalized;
          const existingRows = Array.isArray(previous.rows) ? previous.rows : [];
          return {
            ...normalized,
            rows: [...existingRows, ...normalized.rows],
          };
        });
        setOwnershipChangesCheckedAt(new Date().toISOString());
      })
      .catch((err) => {
        if (ownershipChangesRequestRef.current !== requestId) return;
        setOwnershipChanges(null);
        setOwnershipChangesError(err?.message || "Ownership change feed unavailable");
        setOwnershipChangesCheckedAt(new Date().toISOString());
      })
      .finally(() => {
        if (ownershipChangesRequestRef.current === requestId) {
          setOwnershipChangesLoading(false);
        }
      });
  }, [ownershipChangedField, ownershipImpactFilter, ownershipParentCountryScope, ownershipSignalDensity, ownershipSinceDays, ownershipSortMode]);

  const handleOpenOwnershipCompany = useCallback((row) => {
    if (typeof onNavigateToCompany !== "function") return;
    const companyNumber = String(row?.company_number || "").replace(/\D/g, "");
    if (!companyNumber) return;
    onNavigateToCompany(`ch-${companyNumber}`);
  }, [onNavigateToCompany]);

  const loadOwnershipMonitorStatus = useCallback(() => {
    const requestId = ownershipMonitorRequestRef.current + 1;
    ownershipMonitorRequestRef.current = requestId;

    setOwnershipMonitorLoading(true);
    setOwnershipMonitorError(null);

    fetch("/api/monitor/ownership/status")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load ownership monitor status (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (ownershipMonitorRequestRef.current !== requestId) return;
        setOwnershipMonitorStatus(data || null);
      })
      .catch((err) => {
        if (ownershipMonitorRequestRef.current !== requestId) return;
        setOwnershipMonitorStatus(null);
        setOwnershipMonitorError(err?.message || "Ownership monitor status unavailable");
      })
      .finally(() => {
        if (ownershipMonitorRequestRef.current === requestId) {
          setOwnershipMonitorLoading(false);
        }
      });
  }, []);

  const runOwnershipRefresh = useCallback(async () => {
    const batchSize = Number.parseInt(String(ownershipBatchSize || ""), 10);
    if (!Number.isFinite(batchSize) || batchSize < 1) {
      setOwnershipRunMessage({ type: "error", text: "Batch size must be a positive integer." });
      return;
    }

    setOwnershipRunLoading(true);
    setOwnershipRunMessage(null);

    try {
      const response = await fetch("/api/monitor/ownership/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: batchSize }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to start ownership refresh");
      }

      setOwnershipRunMessage({
        type: "success",
        text: data.message || `Starting ownership stale refresh for up to ${batchSize} companies`,
      });
      loadOwnershipMonitorStatus();
      loadOwnershipChanges({ offset: 0 });
    } catch (err) {
      setOwnershipRunMessage({
        type: "error",
        text: err?.message || "Failed to start ownership refresh",
      });
    } finally {
      setOwnershipRunLoading(false);
    }
  }, [ownershipBatchSize, loadOwnershipChanges, loadOwnershipMonitorStatus]);

  const updateOwnershipScheduler = useCallback(async (action) => {
    const endpoint = action === "start"
      ? "/api/monitor/ownership/scheduler/start"
      : "/api/monitor/ownership/scheduler/stop";
    const fallbackMessage = action === "start"
      ? "Ownership scheduler started"
      : "Ownership scheduler stopped";

    setOwnershipSchedulerLoading(true);
    setOwnershipSchedulerMessage(null);

    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Failed to ${action} ownership scheduler`);
      }

      setOwnershipSchedulerMessage({
        type: "success",
        text: data.message || fallbackMessage,
      });

      if (data && typeof data === "object") {
        setOwnershipMonitorStatus((prev) => ({
          ...(prev || {}),
          ...data,
        }));
      }
      loadOwnershipMonitorStatus();
    } catch (err) {
      setOwnershipSchedulerMessage({
        type: "error",
        text: err?.message || `Failed to ${action} ownership scheduler`,
      });
    } finally {
      setOwnershipSchedulerLoading(false);
    }
  }, [loadOwnershipMonitorStatus]);

  const loadExclusions = useCallback(() => {
    setExclusionsLoading(true);
    fetch("/api/exclusions")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load exclusions (${res.status})`);
        return res.json();
      })
      .then((data) => {
        const nextExclusions = data?.exclusions || null;
        setExclusions(nextExclusions);
        setSicInput(Array.isArray(nextExclusions?.prohibited_sic_codes)
          ? nextExclusions.prohibited_sic_codes.join(", ")
          : "");
      })
      .catch((err) => {
        setExclusionMessage({
          type: "error",
          text: err?.message || "Failed to load exclusions",
        });
      })
      .finally(() => {
        setExclusionsLoading(false);
      });
  }, []);

  const handleSaveSicExclusions = useCallback(async () => {
    setSavingExclusions(true);
    setExclusionMessage(null);
    try {
      const prohibitedSicCodes = parseSicListInput(sicInput);
      const res = await fetch("/api/exclusions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prohibited_sic_codes: prohibitedSicCodes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save SIC exclusions");

      const nextExclusions = data?.exclusions || null;
      setExclusions(nextExclusions);
      const normalizedCodes = Array.isArray(nextExclusions?.prohibited_sic_codes)
        ? nextExclusions.prohibited_sic_codes
        : [];
      setSicInput(normalizedCodes.join(", "));
      setExclusionMessage({
        type: "success",
        text: `Saved ${normalizedCodes.length} SIC exclusion code${normalizedCodes.length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      setExclusionMessage({
        type: "error",
        text: err?.message || "Failed to save SIC exclusions",
      });
    } finally {
      setSavingExclusions(false);
    }
  }, [sicInput]);

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
    loadOwnershipChanges({ offset: 0 });
  }, [loadOwnershipChanges]);

  useEffect(() => {
    loadOwnershipMonitorStatus();
  }, [loadOwnershipMonitorStatus]);

  useEffect(() => {
    if (skipOwnershipTriagePersistenceRef.current) {
      skipOwnershipTriagePersistenceRef.current = false;
      return;
    }

    writeStoredOwnershipTriageState({
      preset: ownershipTriagePreset,
      since_days: ownershipSinceDays,
      sort: ownershipSortMode,
      min_changed_fields: ownershipSignalDensity,
      parent_country_scope: ownershipParentCountryScope,
      changed_field: ownershipChangedField,
      impact: ownershipImpactFilter,
    });
  }, [
    ownershipChangedField,
    ownershipImpactFilter,
    ownershipParentCountryScope,
    ownershipSignalDensity,
    ownershipSinceDays,
    ownershipSortMode,
    ownershipTriagePreset,
  ]);

  useEffect(() => {
    loadExclusions();
  }, [loadExclusions]);

  useEffect(() => {
    if (!ownershipMonitorRunning) return undefined;
    const timer = setInterval(() => {
      loadOwnershipMonitorStatus();
      loadOwnershipChanges({ offset: 0 });
    }, OWNERSHIP_MONITOR_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ownershipMonitorRunning, loadOwnershipChanges, loadOwnershipMonitorStatus]);

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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
          <h4 style={{ margin: 0, fontSize: 15 }}>SIC Exclusion Policy</h4>
          <button
            onClick={loadExclusions}
            style={{
              padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff",
              cursor: "pointer", fontSize: 12, color: "#555",
            }}
          >
            Reload
          </button>
        </div>
        <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 10px" }}>
          Enter UK SIC codes (5 digits) to auto-exclude matching entities during Source 3 intake and suppress them in shortlist workflows when SIC data is available.
        </p>

        <textarea
          value={sicInput}
          onChange={(event) => {
            setSicInput(event.target.value);
            setExclusionMessage(null);
          }}
          placeholder="Examples: 64201, 64202, 64301"
          style={{
            width: "100%",
            minHeight: 72,
            borderRadius: 6,
            border: "1px solid #d1d5db",
            padding: 10,
            fontSize: 12,
            fontFamily: "monospace",
            boxSizing: "border-box",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>
            Active codes: {Array.isArray(exclusions?.prohibited_sic_codes) ? exclusions.prohibited_sic_codes.length : 0}
          </span>
          <button
            onClick={handleSaveSicExclusions}
            disabled={savingExclusions || exclusionsLoading}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "none",
              background: "#0a8754",
              color: "#fff",
              fontWeight: 600,
              fontSize: 12,
              cursor: savingExclusions || exclusionsLoading ? "not-allowed" : "pointer",
              opacity: savingExclusions || exclusionsLoading ? 0.65 : 1,
            }}
          >
            {savingExclusions ? "Saving…" : "Save SIC Policy"}
          </button>
        </div>

        {exclusionsLoading && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>Loading exclusions…</div>
        )}

        {exclusionMessage && (
          <div style={{
            marginTop: 10,
            padding: "8px 10px",
            borderRadius: 6,
            fontSize: 12,
            background: exclusionMessage.type === "success" ? "#d1fae5" : "#fee2e2",
            color: exclusionMessage.type === "success" ? "#065f46" : "#991b1b",
          }}>
            {exclusionMessage.text}
          </div>
        )}
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

      <div style={{ background: "#fff", borderRadius: 8, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 10 }}>
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>Enabled</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937" }}>
              {ownershipMonitorStatus?.enabled === true ? "Yes" : "No"}
            </div>
          </div>
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>Running</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: ownershipMonitorStatus?.running ? "#a16207" : "#166534" }}>
              {ownershipMonitorStatus?.running ? "In progress" : "Idle"}
            </div>
          </div>
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>Cadence</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937" }}>
              {ownershipMonitorStatus?.schedule || "Unknown"}
            </div>
          </div>
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>Check Interval</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937" }}>
              {formatIntervalLabel(ownershipMonitorStatus?.check_interval_ms)}
            </div>
          </div>
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>Last Run</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937" }}>
              {formatTimestampLabel(ownershipMonitorStatus?.last_run)}
            </div>
          </div>
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ fontSize: 11, color: "#64748b" }}>Next Run</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937" }}>
              {formatTimestampLabel(ownershipMonitorStatus?.next_run)}
            </div>
          </div>
        </div>

        {ownershipProgress && (
          <div style={{
            marginBottom: 10,
            border: "1px solid #dbeafe",
            background: "#eff6ff",
            borderRadius: 6,
            padding: "10px 12px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#1e3a8a" }}>
                {ownershipMonitorRunning ? "Ownership refresh in progress" : "Latest ownership refresh summary"}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1d4ed8" }}>
                {ownershipProgressPercent}% complete
              </div>
            </div>

            {ownershipMonitorRunning && (
              <div style={{ marginBottom: 6, fontSize: 11, color: "#1e40af" }}>
                Auto-refreshing every 10 seconds while run is active.
              </div>
            )}

            <div style={{
              height: 8,
              borderRadius: 999,
              background: "#bfdbfe",
              overflow: "hidden",
              marginBottom: 8,
            }}>
              <div style={{
                width: `${ownershipProgressPercent}%`,
                height: "100%",
                borderRadius: 999,
                background: "#2563eb",
                transition: "width 180ms ease",
              }} />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "#1e3a8a" }}>
              <span>Checked {Number(ownershipProgress.checked || 0)}/{Number(ownershipProgress.total || 0)}</span>
              <span>Refreshed {Number(ownershipProgress.refreshed || 0)}</span>
              <span>Changed {Number(ownershipProgress.changed || 0)}</span>
              <span>Errors {Number(ownershipProgress.errors || 0)}</span>
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="ownership-batch-size" style={{ fontSize: 12, color: "#475569" }}>Batch size</label>
            <input
              id="ownership-batch-size"
              aria-label="Ownership batch size"
              type="number"
              min={1}
              step={1}
              value={ownershipBatchSize}
              onChange={(event) => {
                setOwnershipBatchSize(event.target.value);
                setOwnershipRunMessage(null);
              }}
              style={{
                width: 86,
                borderRadius: 6,
                border: "1px solid #d1d5db",
                padding: "6px 8px",
                fontSize: 12,
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={loadOwnershipMonitorStatus}
              style={{
                padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff",
                cursor: "pointer", fontSize: 12, color: "#555",
              }}
            >
              Refresh Monitor
            </button>
            <button
              onClick={() => updateOwnershipScheduler("start")}
              disabled={ownershipSchedulerLoading || ownershipMonitorStatus?.enabled === true}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: "#0369a1",
                color: "#fff",
                fontWeight: 600,
                fontSize: 12,
                cursor: ownershipSchedulerLoading || ownershipMonitorStatus?.enabled === true ? "not-allowed" : "pointer",
                opacity: ownershipSchedulerLoading || ownershipMonitorStatus?.enabled === true ? 0.65 : 1,
              }}
            >
              {ownershipSchedulerLoading ? "Updating..." : "Start Scheduler"}
            </button>
            <button
              onClick={() => updateOwnershipScheduler("stop")}
              disabled={ownershipSchedulerLoading || ownershipMonitorStatus?.enabled !== true}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: "#7f1d1d",
                color: "#fff",
                fontWeight: 600,
                fontSize: 12,
                cursor: ownershipSchedulerLoading || ownershipMonitorStatus?.enabled !== true ? "not-allowed" : "pointer",
                opacity: ownershipSchedulerLoading || ownershipMonitorStatus?.enabled !== true ? 0.65 : 1,
              }}
            >
              {ownershipSchedulerLoading ? "Updating..." : "Stop Scheduler"}
            </button>
            <button
              onClick={runOwnershipRefresh}
              disabled={ownershipRunLoading || ownershipSchedulerLoading || ownershipMonitorRunning}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: "#0f766e",
                color: "#fff",
                fontWeight: 600,
                fontSize: 12,
                cursor: ownershipRunLoading || ownershipSchedulerLoading || ownershipMonitorRunning ? "not-allowed" : "pointer",
                opacity: ownershipRunLoading || ownershipSchedulerLoading || ownershipMonitorRunning ? 0.65 : 1,
              }}
            >
              {ownershipRunLoading
                ? "Starting..."
                : ownershipMonitorRunning
                  ? "Run in progress"
                  : "Run Ownership Refresh"}
            </button>
          </div>
        </div>

        {ownershipMonitorLoading && (
          <div style={{ marginBottom: 8, fontSize: 12, color: "#64748b" }}>Loading ownership monitor status...</div>
        )}

        {!ownershipMonitorLoading && ownershipMonitorError && (
          <div style={{ marginBottom: 8, fontSize: 12, color: "#991b1b", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 10px" }}>
            {ownershipMonitorError}
          </div>
        )}

        {ownershipSchedulerMessage && (
          <div style={{
            marginBottom: 10,
            fontSize: 12,
            borderRadius: 6,
            padding: "8px 10px",
            color: ownershipSchedulerMessage.type === "success" ? "#065f46" : "#991b1b",
            background: ownershipSchedulerMessage.type === "success" ? "#d1fae5" : "#fee2e2",
          }}>
            {ownershipSchedulerMessage.text}
          </div>
        )}

        {ownershipRunMessage && (
          <div style={{
            marginBottom: 10,
            fontSize: 12,
            borderRadius: 6,
            padding: "8px 10px",
            color: ownershipRunMessage.type === "success" ? "#065f46" : "#991b1b",
            background: ownershipRunMessage.type === "success" ? "#d1fae5" : "#fee2e2",
          }}>
            {ownershipRunMessage.text}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div>
            <h4 style={{ margin: 0, fontSize: 15 }}>Ownership Change Feed</h4>
            {!ownershipChangesLoading && ownershipChanges && (
              <div style={{ marginTop: 3, fontSize: 12, color: "#475569" }}>
                Showing {ownershipRows.length}/{ownershipChanges.total} changed companies in last {ownershipChanges.since_days} days
                {ownershipTriagePresetLabel ? ` · preset: ${ownershipTriagePresetLabel}` : ""}
                {ownershipSortMode !== "recent" ? ` · sort: ${ownershipSortLabel}` : ""}
                {ownershipSignalDensityLabel ? ` · signals: ${ownershipSignalDensityLabel}` : ""}
                {ownershipParentCountryScopeLabel ? ` · parent: ${ownershipParentCountryScopeLabel}` : ""}
                {ownershipChangedFieldLabel ? ` · field: ${ownershipChangedFieldLabel}` : ""}
                {ownershipImpactFilterLabel ? ` · impact: ${ownershipImpactFilterLabel}` : ""}
              </div>
            )}
            {!ownershipChangesLoading && ownershipChangesCheckedAt && (
              <div style={{ marginTop: 3, fontSize: 11, color: "#64748b" }}>
                Last checked: {formattedOwnershipCheckedAt}
              </div>
            )}
            {ownershipChangesRefreshing && (
              <div style={{ marginTop: 3, fontSize: 11, color: "#1d4ed8" }}>
                Refreshing change feed...
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="ownership-triage-preset" style={{ fontSize: 12, color: "#475569" }}>
              Preset
            </label>
            <select
              id="ownership-triage-preset"
              aria-label="Ownership triage preset"
              value={ownershipTriagePreset}
              onChange={(event) => {
                const selectedPreset = String(event.target.value || "custom");
                setOwnershipTriagePreset(selectedPreset);
                if (selectedPreset !== "custom") {
                  applyOwnershipTriagePreset(selectedPreset);
                }
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              {OWNERSHIP_TRIAGE_PRESET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Reset saved triage preferences"
              onClick={resetOwnershipTriagePreferences}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#f8fafc",
                cursor: "pointer",
                fontSize: 12,
                color: "#374151",
              }}
            >
              Reset Saved
            </button>
            <label htmlFor="ownership-change-window" style={{ fontSize: 12, color: "#475569" }}>
              Window
            </label>
            <select
              id="ownership-change-window"
              aria-label="Ownership change window"
              value={ownershipSinceDays}
              onChange={(event) => {
                setOwnershipTriagePreset("custom");
                setOwnershipSinceDays(Number.parseInt(event.target.value, 10) || 30);
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
            <label htmlFor="ownership-change-field" style={{ fontSize: 12, color: "#475569" }}>
              Field
            </label>
            <select
              id="ownership-change-field"
              aria-label="Ownership changed field filter"
              value={ownershipChangedField}
              onChange={(event) => {
                setOwnershipTriagePreset("custom");
                setOwnershipChangedField(String(event.target.value || "all"));
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              {ownershipChangedFieldOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <label htmlFor="ownership-change-sort" style={{ fontSize: 12, color: "#475569" }}>
              Sort
            </label>
            <select
              id="ownership-change-sort"
              aria-label="Ownership change sort mode"
              value={ownershipSortMode}
              onChange={(event) => {
                setOwnershipTriagePreset("custom");
                setOwnershipSortMode(String(event.target.value || "recent"));
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              {OWNERSHIP_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <label htmlFor="ownership-signal-density-filter" style={{ fontSize: 12, color: "#475569" }}>
              Signals
            </label>
            <select
              id="ownership-signal-density-filter"
              aria-label="Ownership signal density filter"
              value={ownershipSignalDensity}
              onChange={(event) => {
                setOwnershipTriagePreset("custom");
                setOwnershipSignalDensity(String(event.target.value || "all"));
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              {ownershipSignalDensityOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <label htmlFor="ownership-parent-country-filter" style={{ fontSize: 12, color: "#475569" }}>
              Parent
            </label>
            <select
              id="ownership-parent-country-filter"
              aria-label="Ownership parent country filter"
              value={ownershipParentCountryScope}
              onChange={(event) => {
                setOwnershipTriagePreset("custom");
                setOwnershipParentCountryScope(String(event.target.value || "all"));
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              {ownershipParentCountryScopeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <label htmlFor="ownership-impact-filter" style={{ fontSize: 12, color: "#475569" }}>
              Impact
            </label>
            <select
              id="ownership-impact-filter"
              aria-label="Ownership impact filter"
              value={ownershipImpactFilter}
              onChange={(event) => {
                setOwnershipTriagePreset("custom");
                setOwnershipImpactFilter(String(event.target.value || "all"));
              }}
              style={{
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                fontSize: 12,
                padding: "6px 8px",
              }}
            >
              {ownershipImpactOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              onClick={() => loadOwnershipChanges({ offset: 0 })}
              style={{
                padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff",
                cursor: "pointer", fontSize: 12, color: "#555",
              }}
            >
              Refresh Changes
            </button>
          </div>
        </div>

        {ownershipChangesLoading && ownershipRows.length === 0 && (
          <div style={{ fontSize: 12, color: "#888" }}>Loading ownership changes...</div>
        )}

        {!ownershipChangesLoading && ownershipChangesError && (
          <div style={{ fontSize: 12, color: "#991b1b", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 10px" }}>
            {ownershipChangesError}
          </div>
        )}

        {!ownershipChangesLoading && !ownershipChangesError && ownershipChanges && ownershipRows.length === 0 && (
          <div style={{ fontSize: 12, color: "#64748b", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "8px 10px" }}>
            No ownership changes detected in the selected window.
          </div>
        )}

        {!ownershipChangesError && ownershipRows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f8fafc", color: "#475569" }}>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Company</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Changed Fields</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Signals</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Impact</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Last Changed</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Structure</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Parent</th>
                  <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: "1px solid #e2e8f0" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {ownershipRows.map((row, index) => {
                  const fields = Array.isArray(row?.changed_fields)
                    ? row.changed_fields.filter(Boolean).map((field) => humanizeFieldToken(field))
                    : [];
                  const changedFieldsLabel = fields.length > 0 ? fields.join(", ") : "None recorded";
                  const changedFieldsCount = Number.isFinite(Number(row?.changed_fields_count))
                    ? Number(row.changed_fields_count)
                    : fields.length;
                  const impactLevel = row?.impact_level === "high" ? "High" : "Standard";
                  const lastChangedLabel = formatTimestampLabel(row?.last_changed_at || row?.last_checked_at);
                  const structureLabel = row?.structure ? humanizeFieldToken(row.structure) : "Unknown";
                  const parentLabel = row?.parent_company || "-";
                  const parentCountryLabel = row?.parent_country || "Country unknown";

                  return (
                    <tr key={`${row?.company_number || "unknown"}-${index}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "7px 8px" }}>
                        <div style={{ fontWeight: 600, color: "#1f2937" }}>{row?.company_name || "Unknown company"}</div>
                        <div style={{ color: "#64748b", fontSize: 11 }}>{row?.company_number || "N/A"}</div>
                      </td>
                      <td style={{ padding: "7px 8px", color: "#334155" }}>{changedFieldsLabel}</td>
                      <td style={{ padding: "7px 8px", color: "#334155", fontWeight: 600 }}>{changedFieldsCount}</td>
                      <td style={{ padding: "7px 8px", color: row?.impact_level === "high" ? "#9a3412" : "#334155", fontWeight: 600 }}>
                        {impactLevel}
                      </td>
                      <td style={{ padding: "7px 8px", color: "#334155" }}>{lastChangedLabel}</td>
                      <td style={{ padding: "7px 8px", color: "#334155" }}>{structureLabel}</td>
                      <td style={{ padding: "7px 8px" }}>
                        <div style={{ color: "#1f2937" }}>{parentLabel}</div>
                        <div style={{ color: "#64748b", fontSize: 11 }}>{parentCountryLabel}</div>
                      </td>
                      <td style={{ padding: "7px 8px" }}>
                        <button
                          onClick={() => handleOpenOwnershipCompany(row)}
                          disabled={typeof onNavigateToCompany !== "function"}
                          aria-label={`Open company ${row?.company_name || row?.company_number || "company"}`}
                          style={{
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            color: "#1e3a8a",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: typeof onNavigateToCompany !== "function" ? "not-allowed" : "pointer",
                            opacity: typeof onNavigateToCompany !== "function" ? 0.6 : 1,
                          }}
                        >
                          Open Company
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {ownershipHasMore && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button
                  onClick={() => loadOwnershipChanges({ offset: ownershipRows.length, append: true })}
                  disabled={ownershipChangesLoading}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 6,
                    border: "1px solid #ddd",
                    background: "#fff",
                    color: "#334155",
                    fontSize: 12,
                    cursor: ownershipChangesLoading ? "wait" : "pointer",
                    opacity: ownershipChangesLoading ? 0.65 : 1,
                  }}
                >
                  {ownershipChangesLoading ? "Loading..." : "Load More Changes"}
                </button>
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

Settings.propTypes = {
  onNavigateToCompany: PropTypes.func,
};
