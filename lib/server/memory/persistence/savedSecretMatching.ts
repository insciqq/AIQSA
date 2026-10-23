import { workspaceActivitySecretValues } from "../../workspace/activityText";
import type { AcceptedWorkspaceSecret } from "../../workspace/secrets/store";

/**
 * How Memory recognizes the values of the owner's saved secrets (Studio >
 * Secrets) in its own text; fact writes refuse them (`./savedSecrets.ts`).
 * Matching is exact and literal, on each value and its trimmed form, so it
 * behaves the same in every language.
 *
 * Only values that look like secrets are screened (operator review
 * 2026-10-23): at least 20 characters of any kind, or at least 8 characters
 * with a character that is neither a letter nor whitespace (a digit,
 * punctuation or a symbol). Plain words such as `localhost` or `production`,
 * which settings often hold, stay ordinary text, so a fact or chat turn that
 * mentions them is kept. Lengths count Unicode code points.
 */
const SCREENED_ANY_MIN_LENGTH = 20;
const SCREENED_MIXED_MIN_LENGTH = 8;

/** Replaces a saved value in Memory text; a redaction marker, so Safety Lite treats it as removed text. */
export const MEMORY_SAVED_SECRET_MARKER = "[REDACTED:SAVED_SECRET]";
/** Reason code of a history text that had a saved value redacted. */
export const MEMORY_SAVED_SECRET_REDACTION_REASON = "SECRET_REDACTED_SAVED_SECRET";

export function memorySavedSecretValueIsScreened(value: string): boolean {
  const length = [...value].length;
  return length >= SCREENED_ANY_MIN_LENGTH ||
    (length >= SCREENED_MIXED_MIN_LENGTH && /[^\p{L}\p{M}\s]/u.test(value));
}

/** The screened values of saved secrets: each typed value and its trimmed form, once. */
export function memorySavedSecretScreenedValues(
  secrets: readonly Pick<AcceptedWorkspaceSecret, "name" | "value">[]
): readonly string[] {
  let extracted: readonly string[];
  try {
    extracted = workspaceActivitySecretValues(secrets as readonly AcceptedWorkspaceSecret[]);
  } catch {
    extracted = [];
  }
  const values = new Set<string>();
  for (const value of extracted) {
    for (const candidate of [value, value.trim()]) {
      if (memorySavedSecretValueIsScreened(candidate)) values.add(candidate);
    }
  }
  return [...values];
}

/** Whether any string in a value, object keys included, contains one of the saved values. */
export function memoryValueContainsSavedSecret(
  value: unknown,
  savedValues: readonly string[],
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (savedValues.length === 0) return false;
  if (typeof value === "string") return savedValues.some((saved) => value.includes(saved));
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => memoryValueContainsSavedSecret(entry, savedValues, seen));
  }
  return Object.entries(value).some(([entryKey, entry]) =>
    savedValues.some((saved) => entryKey.includes(saved)) ||
    memoryValueContainsSavedSecret(entry, savedValues, seen));
}

/**
 * The text with every occurrence of the saved values replaced by the marker.
 * Occurrences are found in the original text, the longest first, so a value
 * inside a longer one or inside the marker itself never splits a replacement.
 */
export function redactMemorySavedSecretValues(
  text: string,
  savedValues: readonly string[]
): Readonly<{ redacted: boolean; text: string }> {
  const found: Array<Readonly<{ end: number; start: number }>> = [];
  for (const value of savedValues) {
    if (!value) continue;
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      found.push({ end: start + value.length, start });
    }
  }
  if (found.length === 0) return { redacted: false, text };
  found.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start) || left.start - right.start);
  const selected: Array<Readonly<{ end: number; start: number }>> = [];
  for (const span of found) {
    if (!selected.some((kept) => span.start < kept.end && span.end > kept.start)) selected.push(span);
  }
  selected.sort((left, right) => left.start - right.start);
  let output = "";
  let cursor = 0;
  for (const span of selected) {
    output += text.slice(cursor, span.start) + MEMORY_SAVED_SECRET_MARKER;
    cursor = span.end;
  }
  return { redacted: true, text: output + text.slice(cursor) };
}
