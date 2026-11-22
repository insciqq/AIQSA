import type { Prisma } from "@prisma/client";
import { logEvent } from "../../observability";
import { savedSecretScreenedValues } from "../../redaction/savedSecrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { decryptWorkspaceSecret, type AcceptedWorkspaceSecret } from "../../workspace/secrets/store";

export type ChatSearchSavedSecretReader = Readonly<{
  workspaceSecret: Pick<Prisma.TransactionClient["workspaceSecret"], "findMany">;
}>;

/**
 * The screened values of the owner's saved secrets (Settings > Secrets), which the index replaces with a marker before
 * any text is stored or embedded (`lib/server/redaction/savedSecrets.ts`). Saved browser sign-ins are left out: the
 * browser captured them, nobody typed them into a chat. A value that cannot be decrypted cannot be compared; it is
 * skipped with a content-free record, as the old Memory skipped it, and recognized secrets are still redacted.
 */
export async function chatSearchSavedSecretValues(
  db: ChatSearchSavedSecretReader,
  userId: string,
  key: () => Buffer = getSecretEncryptionKey
): Promise<readonly string[]> {
  const rows = await db.workspaceSecret.findMany({
    orderBy: { id: "asc" },
    select: { value: true },
    where: { browserFileName: null, userId }
  });
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
    logEvent("service_operation", {
      action: "skip", code: "chat_search_saved_secret_unreadable", count: unreadable,
      outcome: "degraded", stage: "validate", subsystem: "memory_search"
    });
  }
  return savedSecretScreenedValues(secrets);
}
