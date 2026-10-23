import type { Prisma } from "@prisma/client";
import { logEvent } from "../../observability";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import {
  decryptWorkspaceSecret,
  type AcceptedWorkspaceSecret
} from "../../workspace/secrets/store";
import { memoryPersistenceFailure } from "./errors";
import {
  memorySavedSecretScreenedValues,
  memoryValueContainsSavedSecret
} from "./savedSecretMatching";

export { memoryValueContainsSavedSecret } from "./savedSecretMatching";

/**
 * The values of the owner's saved secrets (Studio > Secrets) never become
 * Memory text. Safety Lite recognizes only documented credential formats, so a
 * value such as a test token the user saved as a secret would otherwise pass
 * as an ordinary fact, be recalled in other chats and reach providers.
 *
 * Which values are screened and how they match is `./savedSecretMatching.ts`.
 * Saved browser login states are left out: they are captured by the browser,
 * not typed, and too large to decrypt on every write. A value that cannot be
 * decrypted cannot be compared and is skipped with a content-free record.
 */
export const MEMORY_SAVED_SECRET_REASON_CODE = "saved_secret_value";

export type MemorySavedSecretReader = Readonly<{
  workspaceSecret: Pick<Prisma.TransactionClient["workspaceSecret"], "findMany">;
}>;

export async function memorySavedSecretValues(
  db: MemorySavedSecretReader,
  userId: string,
  key: () => Buffer = getSecretEncryptionKey
): Promise<readonly string[]> {
  const rows = await db.workspaceSecret.findMany({
    orderBy: { id: "asc" },
    select: { value: true },
    where: { browserFileName: null, userId }
  });
  if (rows.length === 0) return [];
  let encryptionKey: Buffer | null = null;
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
      action: "skip", code: "memory_saved_secret_unreadable", count: unreadable,
      outcome: "degraded", stage: "validate", subsystem: "memory"
    });
  }
  return memorySavedSecretScreenedValues(secrets);
}

/** Records one refused Memory text without its content. */
export function recordMemorySavedSecretRefusal(): void {
  logEvent("service_operation", {
    action: "skip", code: "memory_saved_secret_value", outcome: "skipped",
    stage: "validate", subsystem: "memory"
  });
}

/** Refuses a Memory write whose text contains a saved secret value; nothing is written. */
export async function assertMemoryTextFreeOfSavedSecrets(
  db: MemorySavedSecretReader,
  userId: string,
  value: unknown,
  key: () => Buffer = getSecretEncryptionKey
): Promise<void> {
  if (!memoryValueContainsSavedSecret(value, await memorySavedSecretValues(db, userId, key))) return;
  recordMemorySavedSecretRefusal();
  return memoryPersistenceFailure("memory_saved_secret_value");
}
