import type { Prisma } from "@prisma/client";
import { clipPastChatLine, PAST_CHATS_LIMITS } from "../../../contracts/pastChats";
import { logEvent } from "../../observability";
import { redactSavedSecretValues, savedSecretScreenedValues } from "../../redaction/savedSecrets";
import { redactSecrets } from "../../redaction/secrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { decryptWorkspaceSecret, type AcceptedWorkspaceSecret } from "../../workspace/secrets/store";

/**
 * What past-chat search and reading show is redacted at the read, whatever
 * the index already did: a past message is read from the messages themselves,
 * a title was never redacted, and a secret saved after a turn was indexed
 * still sits in its passage. Recognized secrets go (`lib/server/redaction/
 * secrets.ts`), and so do the values of the owner's saved secrets that look
 * like secrets (`lib/server/redaction/savedSecrets.ts`).
 */

/** Text longer than this is cut before it is scanned; nothing past it is ever shown. */
const SCAN_MAX_CODE_UNITS = 100_000;

export type SavedSecretValuesReader = (userId: string) => Promise<readonly string[]>;

type SavedSecretStore = Readonly<{ workspaceSecret: Pick<Prisma.TransactionClient["workspaceSecret"], "findMany"> }>;

/**
 * The screened values of the owner's saved secrets. Saved browser sign-ins are
 * left out (captured, not typed); a value that cannot be decrypted cannot be
 * compared and is skipped with a content-free record.
 */
export function createSavedSecretValuesReader(db: SavedSecretStore, key: () => Buffer = getSecretEncryptionKey): SavedSecretValuesReader {
  return async (userId) => {
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
      try {
        if (encryptionKey) secrets.push(decryptWorkspaceSecret(row.value, userId, encryptionKey));
        else unreadable += 1;
      } catch {
        unreadable += 1;
      }
    }
    if (unreadable > 0) logEvent("service_operation", { action: "skip", count: unreadable, outcome: "degraded", stage: "validate",
      subsystem: "memory_search" });
    return savedSecretScreenedValues(secrets);
  };
}

/**
 * The text with saved secret values, then recognized secrets, replaced by
 * markers: saved values first, so a recognized secret inside one cannot leave
 * the rest of the value behind.
 */
export function redactPastChatText(text: string, savedValues: readonly string[]): string {
  const bounded = text.length > SCAN_MAX_CODE_UNITS ? text.slice(0, SCAN_MAX_CODE_UNITS) : text;
  return redactSecrets(redactSavedSecretValues(bounded, savedValues).text).redactedText;
}

/** A chat's title as a result names it: redacted, one line, clipped; "Untitled chat" when nothing is left. */
export function pastChatTitle(title: string, savedValues: readonly string[]): string {
  return clipPastChatLine(redactPastChatText(title, savedValues), PAST_CHATS_LIMITS.titleChars) || "Untitled chat";
}
