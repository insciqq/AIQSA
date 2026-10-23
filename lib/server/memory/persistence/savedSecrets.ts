import type { Prisma } from "@prisma/client";
import { logEvent } from "../../observability";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import {
  WORKSPACE_ACTIVITY_SECRET_MIN_LENGTH,
  workspaceActivitySecretValues
} from "../../workspace/activityText";
import {
  decryptWorkspaceSecret,
  type AcceptedWorkspaceSecret
} from "../../workspace/secrets/store";
import { memoryPersistenceFailure } from "./errors";

/**
 * The values of the owner's saved secrets (Studio > Secrets) never become
 * Memory text. Safety Lite recognizes only documented credential formats, so a
 * value such as a test token the user saved as a secret would otherwise pass
 * as an ordinary fact, be recalled in other chats and reach providers.
 *
 * Matching is exact and literal, on each value and its trimmed form, so it is
 * language-neutral. Values shorter than the masking threshold are ignored, as
 * in Workspace activity and Skill saves. Saved browser login states are left
 * out: they are captured by the browser, not typed, and too large to decrypt
 * on every write. A value that cannot be decrypted cannot be compared and is
 * skipped with a content-free record.
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
  let extracted: readonly string[];
  try {
    extracted = workspaceActivitySecretValues(secrets);
  } catch {
    extracted = [];
  }
  const values = new Set<string>();
  for (const value of extracted) {
    for (const candidate of [value, value.trim()]) {
      if ([...candidate].length >= WORKSPACE_ACTIVITY_SECRET_MIN_LENGTH) values.add(candidate);
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
