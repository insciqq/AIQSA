import { describe, expect, it } from "vitest";
import { composerContextGauge } from "./composerContextStats";

describe("composer context statistics", () => {

  it("uses warning and critical tones at the safe-input boundary", () => {
    expect(composerContextGauge({
      approximateInputTokens: 800,
      safeInputBudgetTokens: 1_000,
      totalContextTokens: 2_000
    })).toMatchObject({ percent: 80, tone: "warning" });
    expect(composerContextGauge({
      approximateInputTokens: 1_250,
      safeInputBudgetTokens: 1_000,
      totalContextTokens: 2_000
    })).toMatchObject({ fraction: 1.25, percent: 125, tone: "critical" });
  });

  it("does not invent utilization when the selected model has no context metadata", () => {
    expect(composerContextGauge({
      approximateInputTokens: 42,
      safeInputBudgetTokens: null,
      totalContextTokens: null
    })).toMatchObject({ fraction: null, percent: null, tone: "neutral" });
  });

});
