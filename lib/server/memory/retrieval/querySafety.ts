import type { MemorySecretFinding } from "../explicit/safety";
import { redactMemorySecrets } from "../explicit/safety";

export const MEMORY_READ_QUERY_SAFETY_VERSION = "memory-read-query-safety-v1";

export type MemorySanitizedUtilityText = Readonly<{
  findingCounts: Readonly<Partial<Record<MemorySecretFinding, number>>>;
  redacted: boolean;
  safeText: string;
  version: typeof MEMORY_READ_QUERY_SAFETY_VERSION;
}>;

function removeUnsafeControls(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    safe += (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ? " " : character;
  }
  return safe;
}

/** Establishes the local boundary that every read-path provider query uses.
 * It retains ordinary surrounding text, removes provider-invalid controls,
 * and never returns recognized secret plaintext. */
export function sanitizeMemoryUtilityText(value: string): MemorySanitizedUtilityText {
  const redaction = redactMemorySecrets(value);
  const findingCounts: Partial<Record<MemorySecretFinding, number>> = {};
  for (const span of redaction.spans) {
    findingCounts[span.finding] = (findingCounts[span.finding] ?? 0) + 1;
  }
  return Object.freeze({
    findingCounts: Object.freeze(findingCounts),
    redacted: redaction.containsSecret,
    safeText: removeUnsafeControls(redaction.redactedText),
    version: MEMORY_READ_QUERY_SAFETY_VERSION
  });
}
