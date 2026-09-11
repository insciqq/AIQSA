import { describe, expect, it } from "vitest";
import { composerContextGauge } from "./composerContextStats";

describe("composer context statistics", () => {

  it("uses warning and critical tones at the safe-input boundary", () => {
    expect(composerContextGauge({
      approximateInputTokens: 800,
      safeInputBudgetTokens: 1_000,
      totalContextTokens: 2_000
    })).toMatchObject({ percent: 40, inputBudgetFraction: 0.8, tone: "warning" });
    expect(composerContextGauge({
      approximateInputTokens: 1_250,
      safeInputBudgetTokens: 1_000,
      totalContextTokens: 2_000
    })).toMatchObject({ fraction: 0.625, inputBudgetFraction: 1.25, percent: 63, tone: "critical" });
  });

  it("clamps the full-window gauge and distinguishes exhausted input from unavailable capacity", () => {
    expect(composerContextGauge({ approximateInputTokens: 3000, safeInputBudgetTokens: 1000, totalContextTokens: 2000 }))
      .toMatchObject({ fraction: 1, percent: 100, tone: "critical" });
    expect(composerContextGauge({ approximateInputTokens: 200, safeInputBudgetTokens: 0, totalContextTokens: 2000 }))
      .toMatchObject({ percent: 10, tone: "critical" });
    expect(composerContextGauge({ approximateInputTokens: 0, safeInputBudgetTokens: 0, totalContextTokens: 2000 }))
      .toMatchObject({ percent: 0, tone: "critical" });
  });

  it("does not invent utilization when the selected model has no context metadata", () => {
    expect(composerContextGauge({
      approximateInputTokens: 42,
      safeInputBudgetTokens: null,
      totalContextTokens: null
    })).toMatchObject({ fraction: null, percent: null, tone: "neutral" });
  });

});
