import type { Prisma } from "@prisma/client";
import { logEvent, type Subsystem } from "../observability";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { decryptWorkspaceSecret, type AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import { savedSecretScreenedValues } from "./savedSecrets";

export type SavedSecretReader = Readonly<{
  workspaceSecret: Pick<Prisma.TransactionClient["workspaceSecret"], "findMany">;
}>;

/** The content-free record a caller gives for values that could not be decrypted. */
export type SavedSecretUnreadableRecord = Readonly<{ code: string; subsystem: Subsystem }>;

/**
 * The screened values (`savedSecretScreenedValues`) of the owner's saved secrets (Settings > Secrets). Saved browser
 * sign-ins are left out: the browser captured them, nobody typed them, and they are too large to decrypt on every
 * call. A value that cannot be decrypted cannot be compared; it is skipped with the caller's content-free record.
 * Kept apart from `./savedSecrets` so the pure matching rules load without Prisma or the encryption key.
 */
export async function loadSavedSecretScreenedValues(
  db: SavedSecretReader,
  userId: string,
  unreadableRecord: SavedSecretUnreadableRecord,
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
      action: "skip", code: unreadableRecord.code, count: unreadable,
      outcome: "degraded", stage: "validate", subsystem: unreadableRecord.subsystem
    });
  }
  return savedSecretScreenedValues(secrets);
}
