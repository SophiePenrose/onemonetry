import { describe, it, expect } from "vitest";
import { getStrategicSignalLabel, normalizeStrategicSignal } from "../utils/strategicSignalLabels";

describe("strategic signal helpers", () => {
  it("normalizes empty values to none", () => {
    expect(normalizeStrategicSignal(undefined)).toBe("none");
    expect(normalizeStrategicSignal("   ")).toBe("none");
  });

  it("normalizes to lowercase keys", () => {
    expect(normalizeStrategicSignal("Anchor_Heavy")).toBe("anchor_heavy");
  });

  it("returns canonical labels for known signals", () => {
    expect(getStrategicSignalLabel("anchor_heavy")).toBe("Anchor-Heavy Incumbents");
    expect(getStrategicSignalLabel("FRAGMENTED_STACK")).toBe("Fragmented Stack");
  });

  it("falls back to humanized text for unknown signals", () => {
    expect(getStrategicSignalLabel("custom_stack_alert")).toBe("custom stack alert");
  });

  it("returns None for empty unknown values", () => {
    expect(getStrategicSignalLabel("")).toBe("None");
  });
});
