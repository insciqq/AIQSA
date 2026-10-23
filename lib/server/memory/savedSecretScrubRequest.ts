import { Prisma } from "@prisma/client";
import type { WorkspaceSecretValue } from "@/lib/contracts/workspaceSecrets";
import { memorySavedSecretScreenedValues } from "./persistence/savedSecretMatching";

/** SOURCE_PURGE target of the obligation `./savedSecretScrub.ts` carries out. */
export const MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE = "SAVED_SECRET@memory-saved-secret-scrub-v1";

/** Whether the owner's Memory holds any fact or history item, in any state. */
export function memoryHoldsAnythingSql(userId: Prisma.Sql | string): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (SELECT 1 FROM "MemoryFact" WHERE "userId" = ${userId})
    OR EXISTS (SELECT 1 FROM "MemoryRecallChunk" WHERE "userId" = ${userId})
    OR EXISTS (SELECT 1 FROM "MemoryRecallRound" WHERE "userId" = ${userId})
    OR EXISTS (SELECT 1 FROM "MemoryToolEvent" WHERE "userId" = ${userId})
  )`;
}

/**
 * Runs in the transaction that saves a secret value, for every path that saves
 * one (`../workspace/secrets/store.ts`), after the owner row is locked. When
 * the value has a part Memory screens and the owner's Memory holds any fact or
 * history, records one durable obligation for the Memory worker to remove the
 * owner's saved values from it. The obligation names only the new revision and
 * holds no value; the worker compares Memory with the values saved when it
 * runs. Memory written later already refuses or redacts the value, because its
 * writers read the saved values under the same owner lock.
 */
export async function requestMemorySavedSecretScrub(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    name: string;
    revisionId: string;
    userId: string;
    value: WorkspaceSecretValue;
  }>
): Promise<boolean> {
  if (memorySavedSecretScreenedValues([{ name: input.name, value: input.value }]).length === 0) {
    return false;
  }
  const settings = await tx.userMemorySettings.findUnique({
    select: { memoryGeneration: true },
    where: { userId: input.userId }
  });
  if (!settings) return false;
  const [held] = await tx.$queryRaw<Array<{ held: boolean }>>(Prisma.sql`
    SELECT ${memoryHoldsAnythingSql(input.userId)} AS "held"
  `);
  if (!held?.held) return false;
  await tx.memoryDeletionOutbox.create({
    data: {
      memoryGeneration: settings.memoryGeneration,
      operation: "SOURCE_PURGE",
      targetId: input.revisionId,
      targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE,
      userId: input.userId
    }
  });
  return true;
}
