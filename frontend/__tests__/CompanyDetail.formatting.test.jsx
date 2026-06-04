import { describe, it, expect } from "vitest";
import {
  formatTurnover,
  formatScore,
  formatPercent,
  formatBpsDelta,
  formatOwnershipTimestamp,
} from "../pages/CompanyDetail";

describe("CompanyDetail formatting helpers", () => {
  it("formats turnover across ranges and numeric strings", () => {
    expect(formatTurnover(1250000)).toBe("£1.3M");
    expect(formatTurnover(12500)).toBe("£13K");
    expect(formatTurnover("900")).toBe("£900");
  });

  it("returns N/A for invalid turnover", () => {
    expect(formatTurnover(undefined)).toBe("N/A");
    expect(formatTurnover("not-a-number")).toBe("N/A");
    expect(formatTurnover(-1)).toBe("N/A");
  });

  it("formats score values and numeric strings", () => {
    expect(formatScore(0.873)).toBe("0.87");
    expect(formatScore("0.6")).toBe("0.60");
  });

  it("returns N/A for invalid scores", () => {
    expect(formatScore("n/a")).toBe("N/A");
    expect(formatScore(null)).toBe("N/A");
  });

  it("formats propensity percent and fallback", () => {
    expect(formatPercent(0.73)).toBe("73%");
    expect(formatPercent("0.5")).toBe("50%");
    expect(formatPercent("unknown")).toBe("N/A");
  });

  it("formats bps deltas with sign and fallback", () => {
    expect(formatBpsDelta(0.86, 0.74)).toBe("+12bps");
    expect(formatBpsDelta(0.66, 0.74)).toBe("-8bps");
    expect(formatBpsDelta("bad", 0.74)).toBe("N/A");
  });

  it("formats ownership timestamps and unknown fallback", () => {
    expect(formatOwnershipTimestamp("2026-06-04T10:00:00.000Z")).toContain("2026");
    expect(formatOwnershipTimestamp("bad-date")).toBe("Unknown");
    expect(formatOwnershipTimestamp(null)).toBe("Unknown");
  });
});
