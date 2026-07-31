import { formatTokenCount } from "@/components/app-shell/shellFormatting";

export type ComposerContextStats = Readonly<{
  approximateInputTokens: number;
  safeInputBudgetTokens: number | null;
  totalContextTokens: number | null;
}>;

export type ComposerContextGauge = Readonly<{
  accessibleLabel: string;
  fraction: number | null;
  percent: number | null;
  tone: "critical" | "neutral" | "proof" | "warning";
}>;

export function formatComposerContextStats(stats: ComposerContextStats): string {
  const approximate = `Approx. input: ~${formatTokenCount(stats.approximateInputTokens)}`;
  if (stats.safeInputBudgetTokens === null || stats.totalContextTokens === null) {
    return approximate;
  }
  return `${approximate} / ${formatTokenCount(stats.safeInputBudgetTokens)} safe input · ${formatTokenCount(stats.totalContextTokens)} total context`;
}

export function composerContextGauge(stats: ComposerContextStats): ComposerContextGauge {
  const budget = stats.safeInputBudgetTokens;
  if (budget === null || budget <= 0) {
    return {
      accessibleLabel: `Context estimate: approximately ${formatTokenCount(stats.approximateInputTokens)} input tokens; safe input budget unavailable`,
      fraction: null,
      percent: null,
      tone: "neutral"
    };
  }

  const fraction = Math.max(0, stats.approximateInputTokens / budget);
  const percent = Math.round(fraction * 100);
  return {
    accessibleLabel: `Context estimate: approximately ${formatTokenCount(stats.approximateInputTokens)} input tokens, ${percent}% of the ${formatTokenCount(budget)} safe input budget`,
    fraction,
    percent,
    tone: fraction >= 1 ? "critical" : fraction >= 0.8 ? "warning" : "proof"
  };
}
