import { loadSavedSecretScreenedValues, type SavedSecretReader } from "../redaction/savedSecretLoader";
import { savedSecretFoldedValues, savedSecretFoldedWhitespace, valueContainsSavedSecret } from "../redaction/savedSecrets";
import { containsSecret, parseSecrets } from "../redaction/secrets";

/**
 * Credentials never go into the memory note, whoever writes it (operator decision 2026-11-22): the note reaches every
 * ordinary turn of its owner and its provider, while a credential belongs in Settings › Secrets, where the agent reads
 * it when needed (`manage_secret`, `read_secret`). Text is refused, never redacted, so the note always holds what its
 * owner saw: a recognized secret format (`lib/server/redaction/secrets.ts`) or the value of one of the owner's saved
 * secrets (`lib/server/redaction/savedSecrets.ts`, which compares only values that look like secrets).
 */

/** Loads the screened values of an owner's saved secrets. */
export type MemoryNoteSavedSecrets = (userId: string) => Promise<readonly string[]>;

/** Whether text may not enter the note. */
export function memoryNoteTextHoldsSecret(text: string, savedValues: readonly string[]): boolean {
  return containsSecret(text) || valueContainsSavedSecret(text, savedValues);
}

function occurrences(text: string, value: string): number {
  let count = 0;
  for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + value.length)) count += 1;
  return count;
}

function recognizedSecrets(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const span of parseSecrets(text).spans) {
    if (span.action !== "REDACT") continue;
    const value = text.slice(span.start, span.end);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether an edit's resulting note holds a credential the note before it did not (review 2026-11-23): screening only
 * the text an edit puts in misses one the edit assembles from what is around it (a `replace` of a hostname with
 * `user:password@host` inside a link already there). A credential the note already held does not block an edit, so a
 * note that holds a value saved as a secret later can still lose that line; the user's own Settings save screens the
 * whole note (`memoryNoteTextHoldsSecret`).
 */
export function memoryNoteChangeAddsSecret(before: string, after: string, savedValues: readonly string[]): boolean {
  // Counted with whitespace folded, as `memoryNoteTextHoldsSecret` finds them: a value is still added when the edit
  // completes it across a line break (review 2026-11-23).
  const folded = savedSecretFoldedValues(savedValues);
  if (folded.length > 0) {
    const foldedBefore = savedSecretFoldedWhitespace(before);
    const foldedAfter = savedSecretFoldedWhitespace(after);
    if (folded.some((value) => occurrences(foldedAfter, value) > occurrences(foldedBefore, value))) return true;
  }
  const held = recognizedSecrets(before);
  for (const [value, count] of recognizedSecrets(after)) {
    if (count > (held.get(value) ?? 0)) return true;
  }
  return false;
}

/** The owner's saved secret values worth comparing (`loadSavedSecretScreenedValues`). */
export function loadMemoryNoteSavedSecrets(
  db: SavedSecretReader,
  userId: string,
  key?: () => Buffer
): Promise<readonly string[]> {
  return loadSavedSecretScreenedValues(db, userId,
    { code: "memory_note_saved_secret_unreadable", subsystem: "configuration" }, key);
}
