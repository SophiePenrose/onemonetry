export const STRATEGIC_SIGNAL_LABELS = Object.freeze({
  none: "None",
  balanced: "Balanced",
  fragmented_stack: "Fragmented Stack",
  consolidation_play: "Consolidation Play",
  anchor_heavy: "Anchor-Heavy Incumbents",
});

export function normalizeStrategicSignal(signal) {
  const normalized = String(signal ?? "none").trim().toLowerCase();
  return normalized || "none";
}

export function getStrategicSignalLabel(signal) {
  const normalized = normalizeStrategicSignal(signal);
  if (STRATEGIC_SIGNAL_LABELS[normalized]) {
    return STRATEGIC_SIGNAL_LABELS[normalized];
  }

  const raw = String(signal ?? "").trim();
  return raw ? raw.replace(/_/g, " ") : STRATEGIC_SIGNAL_LABELS.none;
}
