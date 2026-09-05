import type { SessionContextStatus } from "@/lib/contracts/sessionStatus";

export type ComposerContextStats = Readonly<{
  approximateInputTokens: number;
  safeInputBudgetTokens: number | null;
  totalContextTokens: number | null;
  session?: SessionContextStatus;
}>;

export type ComposerContextGauge = Readonly<{
  fraction: number | null;
  percent: number | null;
  tone: "critical" | "neutral" | "proof" | "warning";
}>;

export function composerContextGauge(stats: ComposerContextStats): ComposerContextGauge {
  const budget = stats.safeInputBudgetTokens;
  if (budget === null || budget <= 0) {
    return {
      fraction: null,
      percent: null,
      tone: "neutral"
    };
  }

  const fraction = Math.max(0, stats.approximateInputTokens / budget);
  const percent = Math.round(fraction * 100);
  return {
    fraction,
    percent,
    tone: fraction >= 1 ? "critical" : fraction >= 0.7 ? "warning" : "proof"
  };
}
