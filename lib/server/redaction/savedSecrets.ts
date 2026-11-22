import { workspaceActivitySecretValues } from "../workspace/activityText";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";

/**
 * How derived text recognizes the values of the owner's saved secrets
 * (Settings > Secrets): writes repeating one are refused, and indexing
 * replaces them with a marker before anything is stored, embedded or recalled
 * (the memory note and past-chat search; `./savedSecretLoader.ts` loads the
 * values). Matching is exact and literal, on
 * each value and its trimmed form, so it behaves the same in every language.
 *
 * Only values that look like secrets are screened (review 2026-10-23): at
 * least 20 characters of any kind, or at least 8 characters with one that is
 * neither a letter nor whitespace (a digit, punctuation or a symbol). Plain
 * words such as `localhost` or `production`, which settings often hold, stay
 * ordinary text, so a fact or chat turn that mentions them is kept. Lengths
 * count Unicode code points.
 */
const SCREENED_ANY_MIN_LENGTH = 20;
const SCREENED_MIXED_MIN_LENGTH = 8;

/** Replaces a saved value in derived text; a redaction marker, so secret screening treats it as removed text. */
export const SAVED_SECRET_MARKER = "[REDACTED:SAVED_SECRET]";
/** Reason code of a history text that had a saved value redacted. */
export const SAVED_SECRET_REDACTION_REASON = "SECRET_REDACTED_SAVED_SECRET";

export function savedSecretValueIsScreened(value: string): boolean {
  const length = [...value].length;
  return length >= SCREENED_ANY_MIN_LENGTH ||
    (length >= SCREENED_MIXED_MIN_LENGTH && /[^\p{L}\p{M}\s]/u.test(value));
}

/** Text with every CRLF and lone CR as LF, as derived text and most clients write line breaks. */
export function savedSecretLineFeeds(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * The values beside the form each takes with LF line endings, once each: a multi-line value saved with CRLF still
 * matches text whose client or normalization wrote LF (review 2026-11-23). A form that is blank is left out, since
 * it would match ordinary line breaks.
 */
export function savedSecretLineEndingForms(values: readonly string[]): readonly string[] {
  const forms = new Set(values);
  for (const value of values) {
    const lineFeeds = savedSecretLineFeeds(value);
    if (lineFeeds !== value && lineFeeds.trim()) forms.add(lineFeeds);
  }
  return [...forms];
}

/** The screened values of saved secrets: each typed value and its trimmed form, with their LF forms, once. */
export function savedSecretScreenedValues(
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
      if (savedSecretValueIsScreened(candidate)) values.add(candidate);
    }
  }
  return savedSecretLineEndingForms([...values]);
}

/** Whether any string in a value, object keys included, contains one of the saved values. */
export function valueContainsSavedSecret(
  value: unknown,
  savedValues: readonly string[],
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (savedValues.length === 0) return false;
  if (typeof value === "string") return savedValues.some((saved) => value.includes(saved));
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsSavedSecret(entry, savedValues, seen));
  }
  return Object.entries(value).some(([entryKey, entry]) =>
    savedValues.some((saved) => entryKey.includes(saved)) ||
    valueContainsSavedSecret(entry, savedValues, seen));
}

/**
 * The text with every occurrence of the saved values replaced by the marker.
 * Occurrences are found in the original text, the longest first, so a value
 * inside a longer one or inside the marker itself never splits a replacement.
 */
export function redactSavedSecretValues(
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
    output += text.slice(cursor, span.start) + SAVED_SECRET_MARKER;
    cursor = span.end;
  }
  return { redacted: true, text: output + text.slice(cursor) };
}
