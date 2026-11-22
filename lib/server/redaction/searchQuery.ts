import type { MemorySecretFinding } from "../explicit/safety";
import {
  memoryProjectionContainsRedaction,
  memoryRedactionHasSourceText,
  redactMemorySecrets
} from "../explicit/safety";

export const MEMORY_READ_QUERY_SAFETY_VERSION = "memory-read-query-safety-v3";

/** Local processing budget for one Memory utility text. Longer input is
 * reported as too long instead of being scanned, truncated or passed on. */
export const MEMORY_UTILITY_TEXT_MAX_CODE_UNITS = 100_000;

export type MemorySanitizedUtilityText = Readonly<{
  eligible: boolean;
  findingCounts: Readonly<Partial<Record<MemorySecretFinding, number>>>;
  redacted: boolean;
  safeText: string;
  /** The input exceeded the local processing budget; it is not missing. */
  tooLong: boolean;
  version: typeof MEMORY_READ_QUERY_SAFETY_VERSION;
}>;

function containsUnsafeControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f || code >= 0x202a && code <= 0x202e ||
      code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

/** Establishes the local boundary that every read-path provider query uses.
 * It retains ordinary surrounding text, rejects provider-invalid controls,
 * and never returns recognized secret plaintext. Oversized input returns no
 * text at all, so no caller can use an unscanned remainder. */
export function sanitizeMemoryUtilityText(value: string): MemorySanitizedUtilityText {
  if (value.length > MEMORY_UTILITY_TEXT_MAX_CODE_UNITS) {
    return Object.freeze({
      eligible: false,
      findingCounts: Object.freeze({}),
      redacted: false,
      safeText: "",
      tooLong: true,
      version: MEMORY_READ_QUERY_SAFETY_VERSION
    });
  }
  const structurallyEligible = value.trim().length > 0 &&
    !containsUnsafeControls(value);
  const redaction = redactMemorySecrets(value);
  const findingCounts: Partial<Record<MemorySecretFinding, number>> = {};
  for (const span of redaction.detections) {
    findingCounts[span.finding] = (findingCounts[span.finding] ?? 0) + 1;
  }
  const eligible = structurallyEligible && (
    !(redaction.containsSecret || memoryProjectionContainsRedaction(value)) ||
    memoryRedactionHasSourceText(value, redaction));
  return Object.freeze({
    eligible,
    findingCounts: Object.freeze(findingCounts),
    redacted: redaction.containsSecret,
    safeText: eligible ? redaction.redactedText : "",
    tooLong: false,
    version: MEMORY_READ_QUERY_SAFETY_VERSION
  });
}
