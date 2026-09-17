export type InstructionPreviewBaseline = {
  renderedSystemPrompt: string;
  timeZone: string;
  timeZoneSource: "client" | "utc_fallback";
};

export type InstructionPreview = {
  baseline: InstructionPreviewBaseline;
  generatedAt: string;
  visibleAnswerContract: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}

export function decodeInstructionPreview(value: unknown): InstructionPreview | null {
  if (!record(value) || !keys(value, ["baseline", "generatedAt", "visibleAnswerContract"]) ||
    !text(value.visibleAnswerContract, 2_000) || !value.visibleAnswerContract ||
    !text(value.generatedAt, 24) || value.generatedAt.length !== 24 || !Number.isFinite(Date.parse(value.generatedAt)) ||
    new Date(value.generatedAt).toISOString() !== value.generatedAt) {
    return null;
  }
  const baseline = value.baseline;
  if (!record(baseline) || !keys(baseline, ["renderedSystemPrompt", "timeZone", "timeZoneSource"]) ||
    !text(baseline.renderedSystemPrompt, 2_000) || !baseline.renderedSystemPrompt ||
    !text(baseline.timeZone, 64) || !baseline.timeZone ||
    (baseline.timeZoneSource !== "client" && baseline.timeZoneSource !== "utc_fallback")) {
    return null;
  }
  return {
    baseline: {
      renderedSystemPrompt: baseline.renderedSystemPrompt,
      timeZone: baseline.timeZone,
      timeZoneSource: baseline.timeZoneSource
    },
    generatedAt: value.generatedAt,
    visibleAnswerContract: value.visibleAnswerContract
  };
}
