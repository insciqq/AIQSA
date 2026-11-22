import { loadSavedSecretScreenedValues, type SavedSecretReader } from "../redaction/savedSecretLoader";
import { valueContainsSavedSecret } from "../redaction/savedSecrets";
import { containsSecret } from "../redaction/secrets";

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

/** The owner's saved secret values worth comparing (`loadSavedSecretScreenedValues`). */
export function loadMemoryNoteSavedSecrets(
  db: SavedSecretReader,
  userId: string,
  key?: () => Buffer
): Promise<readonly string[]> {
  return loadSavedSecretScreenedValues(db, userId,
    { code: "memory_note_saved_secret_unreadable", subsystem: "configuration" }, key);
}
