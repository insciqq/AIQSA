import type { SessionContextStatus } from "@/lib/contracts/sessionStatus";

export type ComposerContextStats = Readonly<{
  approximateInputTokens: number;
  safeInputBudgetTokens: number | null;
  totalContextTokens: number | null;
  session?: SessionContextStatus;
  answerReserveTokens?: number | null;
  safetyMarginTokens?: number | null;
  requestRejected?: boolean;
}>;

export type ComposerContextGauge = Readonly<{
  fraction: number | null;
  inputBudgetFraction: number | null;
  percent: number | null;
  tone: "critical" | "neutral" | "proof" | "warning";
}>;

export function composerContextGauge(stats: ComposerContextStats): ComposerContextGauge {
  const budget = stats.safeInputBudgetTokens;
  const window = stats.totalContextTokens;
  const fraction = window === null || window <= 0 ? null :
    Math.min(1, Math.max(0, stats.approximateInputTokens / window));
  const inputBudgetFraction = budget === null ? null : budget <= 0 ? 1 :
    Math.max(0, stats.approximateInputTokens / budget);
  return {
    fraction,
    inputBudgetFraction,
    percent: fraction === null ? null : Math.round(fraction * 100),
    tone: stats.requestRejected || (inputBudgetFraction !== null && inputBudgetFraction >= 1) ? "critical"
      : inputBudgetFraction === null ? "neutral" : inputBudgetFraction >= 0.7 ? "warning" : "proof"
  };
}
