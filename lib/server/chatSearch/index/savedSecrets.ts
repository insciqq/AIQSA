import { loadSavedSecretScreenedValues, type SavedSecretReader } from "../../redaction/savedSecretLoader";

export type ChatSearchSavedSecretReader = SavedSecretReader;

/**
 * The screened values of the owner's saved secrets (Settings > Secrets), which the index replaces with a marker before
 * any text is stored or embedded (`lib/server/redaction/savedSecrets.ts`). A value that cannot be decrypted is skipped
 * with a content-free record under past-chat search's subsystem, and recognized secrets are still redacted.
 */
export function chatSearchSavedSecretValues(
  db: ChatSearchSavedSecretReader,
  userId: string,
  key?: () => Buffer
): Promise<readonly string[]> {
  return loadSavedSecretScreenedValues(db, userId,
    { code: "chat_search_saved_secret_unreadable", subsystem: "memory_search" }, key);
}
