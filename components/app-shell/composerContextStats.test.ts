import { describe, expect, it } from "vitest";
import {
  composerContextGauge,
  composerContextGaugeTitle,
  formatComposerContextStats
} from "./composerContextStats";

describe("composer context statistics", () => {
  it("formats the estimate separately from the safe and total budgets", () => {
    expect(formatComposerContextStats({
      approximateInputTokens: 121_900,
      safeInputBudgetTokens: 232_000,
      totalContextTokens: 400_000
    })).toBe("Approx. input: ~122k / 232k safe input · 400k total context");
  });

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

  it("offers a human hover label in safe-budget percent or honest tokens", () => {
    expect(composerContextGaugeTitle({
      approximateInputTokens: 800,
      safeInputBudgetTokens: 10_000,
      totalContextTokens: 12_000
    })).toBe("~8% контекста");
    expect(composerContextGaugeTitle({
      approximateInputTokens: 42_000,
      safeInputBudgetTokens: null,
      totalContextTokens: null
    })).toBe("Контекст: ~42k токенов");
  });
});
