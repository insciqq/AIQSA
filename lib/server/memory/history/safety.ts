import {
  memoryProjectionContainsRedaction,
  memoryRedactionHasSourceText,
  memorySecretJoinIsSafe,
  redactMemorySecrets,
  redactMemorySecretsInWindows,
  type MemorySecretSourceMapEntry,
  type MemorySecretWindowedRedactionResult
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

/**
 * How much of a text was scanned, independent of its sensitivity. EMPTY,
 * OVERSIZE and UNSAFE_CONTROL texts were not scanned: they carry no safety
 * class, so size never reads as sensitivity and unscanned text never reads
 * as NORMAL. PARTIAL text was scanned except for ranges withheld behind the
 * unprocessed placeholder.
 */
export type MemoryTextProcessingState =
  | "COMPLETE"
  | "EMPTY"
  | "OVERSIZE"
  | "PARTIAL"
  | "UNSAFE_CONTROL";

export type MemorySafeTextProjection = Readonly<
  | {
      eligible: false;
      processingState: "EMPTY" | "OVERSIZE" | "UNSAFE_CONTROL";
      providerSafeText: null;
      redactionReasonCodes: readonly string[];
      redactionSourceMap: readonly MemorySecretSourceMapEntry[];
      redactionState: "EXCLUDED";
      safetyClass: null;
      safeText: null;
    }
  | {
      eligible: false;
      processingState: "COMPLETE" | "PARTIAL";
      providerSafeText: null;
      redactionReasonCodes: readonly string[];
      redactionSourceMap: readonly MemorySecretSourceMapEntry[];
      redactionState: "EXCLUDED";
      safetyClass: "SECRET_TAINTED";
      safeText: null;
    }
  | {
      eligible: true;
      processingState: "COMPLETE" | "PARTIAL";
      providerSafeText: string;
      redactionReasonCodes: readonly string[];
      redactionSourceMap: readonly MemorySecretSourceMapEntry[];
      redactionState: "NOT_NEEDED" | "REDACTED";
      safetyClass: "NORMAL" | "SENSITIVE";
      safeText: string;
    }
>;

/** Reason for source text withheld unscanned behind the unprocessed marker. */
export const MEMORY_HISTORY_UNPROCESSED_TEXT_REASON = "SOURCE_TEXT_UNPROCESSED";

// Both bounds define the message projection: a text up to one window is
// exactly the former single pass, and each window of a longer text equals a
// full pass over its range. Changing either changes the projection of longer
// texts and requires a new MEMORY_HISTORY_SOURCE_PROJECTION_VERSION.
/** One bounded scan: the single-pass limit and a message projection window. */
const MAX_MEMORY_SOURCE_TEXT_CODE_UNITS = 100_000;
/** Scanned code units of one message; the remainder is withheld unscanned. */
const MAX_MEMORY_SOURCE_PROCESSING_CODE_UNITS = 1_048_576;
const MEMORY_HISTORY_TEXT_JOIN = "\n\n";

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

function unscannedProjection(
  processingState: "EMPTY" | "OVERSIZE" | "UNSAFE_CONTROL",
  reasonCode: string
): MemorySafeTextProjection {
  return {
    eligible: false,
    processingState,
    providerSafeText: null,
    redactionReasonCodes: [reasonCode],
    redactionSourceMap: [],
    redactionState: "EXCLUDED",
    safetyClass: null,
    safeText: null
  };
}

function projectRedaction(
  sourceText: string,
  redaction: MemorySecretWindowedRedactionResult
): MemorySafeTextProjection {
  const withheld = redaction.withheld.length > 0;
  const processingState = withheld ? "PARTIAL" : "COMPLETE";
  const retainsSourceText = memoryRedactionHasSourceText(sourceText, redaction);
  if (
    (redaction.containsSecret || memoryProjectionContainsRedaction(sourceText)) &&
    !retainsSourceText
  ) {
    return {
      eligible: false,
      processingState,
      providerSafeText: null,
      redactionReasonCodes: ["SECRET_ONLY"],
      redactionSourceMap: redaction.sourceMap,
      redactionState: "EXCLUDED",
      safetyClass: "SECRET_TAINTED",
      safeText: null
    };
  }
  // Nothing scanned remains: the text was too large to scan, not sensitive.
  if (withheld && !retainsSourceText) {
    return unscannedProjection("OVERSIZE", "SOURCE_TEXT_LIMIT");
  }

  const reasonCodes = [...new Set([
    ...redaction.spans.map((span) => `SECRET_REDACTED_${span.finding}`),
    ...(withheld ? [MEMORY_HISTORY_UNPROCESSED_TEXT_REASON] : [])
  ])].sort();

  return {
    eligible: true,
    processingState,
    providerSafeText: redaction.redactedText,
    redactionReasonCodes: reasonCodes,
    redactionSourceMap: redaction.sourceMap,
    redactionState: redaction.containsSecret || withheld ? "REDACTED" : "NOT_NEEDED",
    safetyClass: "NORMAL",
    safeText: redaction.redactedText
  };
}

function projectMemoryHistoryWindowedText(
  value: string,
  maxCodeUnits: number
): MemorySafeTextProjection {
  const sourceText = normalizedSourceText(value);
  if (sourceText.length === 0) return unscannedProjection("EMPTY", "EMPTY_TEXT");
  if (containsUnsafeControl(sourceText)) {
    return unscannedProjection("UNSAFE_CONTROL", "UNSAFE_CONTROL");
  }
  return projectRedaction(sourceText, redactMemorySecretsInWindows(sourceText, {
    maxCodeUnits,
    windowCodeUnits: MAX_MEMORY_SOURCE_TEXT_CODE_UNITS
  }));
}

/**
 * Single bounded pass for derived or already bounded texts (statements,
 * digests, tool scalars, chunk text). A longer text is OVERSIZE: not scanned
 * and not classified. Whole message texts use the windowed source projection.
 */
export function projectMemoryHistorySafeText(value: string): MemorySafeTextProjection {
  const sourceText = normalizedSourceText(value);
  if (sourceText.length === 0) return unscannedProjection("EMPTY", "EMPTY_TEXT");
  if (sourceText.length > MAX_MEMORY_SOURCE_TEXT_CODE_UNITS) {
    return unscannedProjection("OVERSIZE", "SOURCE_TEXT_LIMIT");
  }
  if (containsUnsafeControl(sourceText)) {
    return unscannedProjection("UNSAFE_CONTROL", "UNSAFE_CONTROL");
  }
  const redaction = redactMemorySecrets(sourceText);
  return projectRedaction(sourceText, {
    containsSecret: redaction.containsSecret,
    redactedText: redaction.redactedText,
    sourceMap: redaction.sourceMap,
    spans: redaction.spans,
    withheld: []
  });
}

/**
 * The projection of one chat message, shared by history, fact evidence and
 * every revalidation of their offsets and hashes. Long ordinary text is
 * scanned in bounded windows (secrets on a window boundary stay whole); what
 * cannot be scanned within the bounds is withheld behind the unprocessed
 * marker with MEMORY_HISTORY_UNPROCESSED_TEXT_REASON (PARTIAL), and never
 * passed on unscanned or classified by its size.
 */
export function projectMemoryHistorySourceText(value: string): MemorySafeTextProjection {
  return projectMemoryHistoryWindowedText(value, MAX_MEMORY_SOURCE_PROCESSING_CODE_UNITS);
}

/**
 * Whether an already projected text scans back to itself. Its size is bounded
 * by the projection that produced it (markers can outgrow the source they
 * replace), so the rescan uses the same windows without a second budget.
 */
export function memoryHistoryProjectedTextIsStable(text: string): boolean {
  const projection = projectMemoryHistoryWindowedText(text, Number.POSITIVE_INFINITY);
  return projection.eligible && projection.processingState === "COMPLETE" &&
    projection.safeText === text && projection.providerSafeText === text;
}

/**
 * Two independently projected texts (a recall turn, or neighbouring fact
 * sources) are scanned across the boundary that joins them, never gated by
 * their combined length.
 */
export function memoryHistorySafeTextsJoinSafely(left: string, right: string): boolean {
  return memorySecretJoinIsSafe(left, MEMORY_HISTORY_TEXT_JOIN, right);
}
