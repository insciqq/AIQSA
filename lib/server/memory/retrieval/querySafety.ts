import type { MemorySecretFinding } from "../explicit/safety";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../explicit/safety";

export const MEMORY_READ_QUERY_SAFETY_VERSION = "memory-read-query-safety-v2";

export type MemorySanitizedUtilityText = Readonly<{
  eligible: boolean;
  findingCounts: Readonly<Partial<Record<MemorySecretFinding, number>>>;
  redacted: boolean;
  safeText: string;
  version: typeof MEMORY_READ_QUERY_SAFETY_VERSION;
}>;

const MAX_MEMORY_UTILITY_TEXT_CODE_UNITS = 100_000;

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
 * and never returns recognized secret plaintext. */
export function sanitizeMemoryUtilityText(value: string): MemorySanitizedUtilityText {
  const structurallyEligible = value.trim().length > 0 &&
    value.length <= MAX_MEMORY_UTILITY_TEXT_CODE_UNITS &&
    !containsUnsafeControls(value);
  const redaction = redactMemorySecrets(value);
  const findingCounts: Partial<Record<MemorySecretFinding, number>> = {};
  for (const span of redaction.detections) {
    findingCounts[span.finding] = (findingCounts[span.finding] ?? 0) + 1;
  }
  const eligible = structurallyEligible && (!redaction.containsSecret ||
    memoryRedactionHasMeaningfulRemainder(value, redaction));
  return Object.freeze({
    eligible,
    findingCounts: Object.freeze(findingCounts),
    redacted: redaction.containsSecret,
    safeText: eligible ? redaction.redactedText : "",
    version: MEMORY_READ_QUERY_SAFETY_VERSION
  });
}
