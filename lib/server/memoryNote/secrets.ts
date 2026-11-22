import type { Prisma } from "@prisma/client";
import { logEvent } from "../observability";
import { valueContainsSavedSecret, savedSecretScreenedValues } from "../redaction/savedSecrets";
import { containsSecret } from "../redaction/secrets";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptWorkspaceSecret, type AcceptedWorkspaceSecret } from "../workspace/secrets/store";

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

/**
 * The owner's saved secret values worth comparing. Saved browser sign-ins are left out: the browser captures them, the
 * user never types them, and they are too large to decrypt on every save. A value that cannot be decrypted cannot be
 * compared and is skipped with a content-free record.
 */
export async function loadMemoryNoteSavedSecrets(
  db: Readonly<{ workspaceSecret: Pick<Prisma.TransactionClient["workspaceSecret"], "findMany"> }>,
  userId: string,
  key: () => Buffer = getSecretEncryptionKey
): Promise<readonly string[]> {
  const rows = await db.workspaceSecret.findMany({ orderBy: { id: "asc" }, select: { value: true }, where: { browserFileName: null, userId } });
  if (rows.length === 0) return [];
  let encryptionKey: Buffer | null;
  try {
    encryptionKey = key();
  } catch {
    encryptionKey = null;
  }
  const secrets: AcceptedWorkspaceSecret[] = [];
  let unreadable = 0;
  for (const row of rows) {
    if (!encryptionKey) {
      unreadable += 1;
      continue;
    }
    try {
      secrets.push(decryptWorkspaceSecret(row.value, userId, encryptionKey));
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0) {
    logEvent("service_operation", { action: "skip", code: "memory_note_saved_secret_unreadable", count: unreadable, outcome: "degraded",
      stage: "validate", subsystem: "configuration" });
  }
  return savedSecretScreenedValues(secrets);
}
