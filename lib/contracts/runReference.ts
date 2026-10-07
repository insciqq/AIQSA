/**
 * The error reference of a failed answer: the first characters of its run id.
 * The answer's viewer can copy the full id; an administrator looks either one
 * up in Control Center Health. Run ids are lowercase UUIDs.
 */
export const RUN_REFERENCE_LENGTH = 8;
export const RUN_ID_LENGTH = 36;

const UUID_DASHES = new Set([8, 13, 18, 23]);
const HEX = /^[0-9a-f]$/u;
const LABEL = /^reference\s*:?\s*/iu;

/** The short reference shown beside a failed answer. */
export function runReferenceLabel(runId: string): string {
  return runId.slice(0, RUN_REFERENCE_LENGTH);
}

/**
 * A pasted reference as a lowercase run-id prefix of at least eight
 * characters, or `null`. A leading "Reference:" label and surrounding spaces
 * are ignored; dashes must sit where a UUID has them.
 */
export function normalizeRunReference(value: string): string | null {
  const candidate = value.trim().replace(LABEL, "").toLowerCase();
  if (candidate.length < RUN_REFERENCE_LENGTH || candidate.length > RUN_ID_LENGTH) return null;
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index]!;
    if (UUID_DASHES.has(index) ? character !== "-" : !HEX.test(character)) return null;
  }
  return candidate;
}

/**
 * Index range of a normalized reference for a text btree: every UUID starting
 * with `prefix` sorts in `[prefix, prefix + "g")`, because its next character
 * is a hex digit or a dash, both below "g". This holds bytewise ("C") and in
 * the libc and ICU collations PostgreSQL databases use, whether a dash is
 * ignorable (equal UUID dash positions) or sorts below digits. Queries add an
 * exact prefix check, so the range only bounds the index scan.
 */
export function runReferenceRange(prefix: string): Readonly<{ lower: string; upper: string }> {
  return { lower: prefix, upper: `${prefix}g` };
}
