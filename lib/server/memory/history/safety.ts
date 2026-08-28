import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets,
  type MemorySecretSourceMapEntry
} from "../explicit/safety";
export { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";

export const MEMORY_DERIVED_SAFETY_CLASSES = [
  "NORMAL",
  "SENSITIVE",
  "HIGHLY_SENSITIVE",
  "SECRET_TAINTED"
] as const;

export type MemoryDerivedSafetyClass =
  (typeof MEMORY_DERIVED_SAFETY_CLASSES)[number];

export type MemoryRedactionState = "EXCLUDED" | "NOT_NEEDED" | "REDACTED";

export type MemorySafeTextProjection = Readonly<
  | {
      eligible: false;
      providerSafeText: null;
      redactionReasonCodes: readonly string[];
      redactionSourceMap: readonly MemorySecretSourceMapEntry[];
      redactionState: "EXCLUDED";
      safetyClass: "HIGHLY_SENSITIVE" | "SECRET_TAINTED";
      safeText: null;
    }
  | {
      eligible: true;
      providerSafeText: string;
      redactionReasonCodes: readonly string[];
      redactionSourceMap: readonly MemorySecretSourceMapEntry[];
      redactionState: "NOT_NEEDED" | "REDACTED";
      safetyClass: "NORMAL" | "SENSITIVE";
      safeText: string;
    }
>;

const MAX_MEMORY_SOURCE_TEXT_CODE_UNITS = 100_000;
const MAX_MEMORY_RECALL_GROUP_TEXT_CODE_UNITS = 200_000;

function normalizedSourceText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function containsUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) return true;
  }
  return false;
}

function projectMemoryHistoryText(
  value: string,
  maximumCodeUnits: number
): MemorySafeTextProjection {
  const sourceText = normalizedSourceText(value);
  if (
    sourceText.length === 0 ||
    sourceText.length > maximumCodeUnits ||
    containsUnsafeControl(sourceText)
  ) {
    return {
      eligible: false,
      providerSafeText: null,
      redactionReasonCodes: [
        sourceText.length === 0
          ? "EMPTY_TEXT"
          : sourceText.length > maximumCodeUnits
            ? "SOURCE_TEXT_LIMIT"
            : "UNSAFE_CONTROL"
      ],
      redactionSourceMap: [],
      redactionState: "EXCLUDED",
      safetyClass: "HIGHLY_SENSITIVE",
      safeText: null
    };
  }

  const redaction = redactMemorySecrets(sourceText);
  if (
    redaction.containsSecret &&
    !memoryRedactionHasMeaningfulRemainder(sourceText, redaction)
  ) {
    return {
      eligible: false,
      providerSafeText: null,
      redactionReasonCodes: ["SECRET_ONLY"],
      redactionSourceMap: redaction.sourceMap,
      redactionState: "EXCLUDED",
      safetyClass: "SECRET_TAINTED",
      safeText: null
    };
  }

  const reasonCodes = [...new Set(redaction.spans.map((span) =>
    `SECRET_REDACTED_${span.finding}`))].sort();

  return {
    eligible: true,
    providerSafeText: redaction.redactedText,
    redactionReasonCodes: reasonCodes,
    redactionSourceMap: redaction.sourceMap,
    redactionState: redaction.containsSecret ? "REDACTED" : "NOT_NEEDED",
    safetyClass: "NORMAL",
    safeText: redaction.redactedText
  };
}

export function projectMemoryHistorySafeText(value: string): MemorySafeTextProjection {
  return projectMemoryHistoryText(value, MAX_MEMORY_SOURCE_TEXT_CODE_UNITS);
}

/**
 * A recall turn may contain two independently bounded source messages. The
 * wider projection repeats secret/control screening across their joined text
 * without weakening the 100k limit for any individual source message.
 */
export function projectMemoryHistorySafeRecallGroupText(
  value: string
): MemorySafeTextProjection {
  return projectMemoryHistoryText(value, MAX_MEMORY_RECALL_GROUP_TEXT_CODE_UNITS);
}
