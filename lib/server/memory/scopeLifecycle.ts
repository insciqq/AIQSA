import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { memoryPersistenceFailure } from "./persistence/errors";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  type MemoryTransaction
} from "./persistence/transaction";

export type DeletableMemoryScopeType = "ASSISTANT" | "CHAT" | "FOLDER";

type ActiveScopedFact = Readonly<{
  factId: string;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  systemFrom: Date;
  versionId: string;
}>;

export async function applyMemoryScopeTargetDeletion(
  tx: MemoryTransaction,
  input: Readonly<{
    scopeType: DeletableMemoryScopeType;
    targetId: string;
    userId: string;
  }>
): Promise<number> {
  const settings = await lockMemorySettings(tx, input.userId, false);
  const scopes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "MemoryScope"
    WHERE "userId" = ${input.userId}
      AND "scopeType" = ${input.scopeType}::"MemoryScopeType"
      AND "targetIdSnapshot" = ${input.targetId}
      AND "state" = 'ACTIVE'::"MemoryScopeState"
    ORDER BY "id"
    FOR UPDATE
  `);
  if (scopes.length === 0) return 0;
  if (scopes.length !== 1) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }
  const scopeId = scopes[0]!.id;
  const facts = await tx.$queryRaw<ActiveScopedFact[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId",
      version."id" AS "versionId",
      version."sourceMode"::text AS "sourceMode",
      version."systemFrom"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
     AND version."factId" = fact."id"
     AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = ${input.userId}
      AND fact."scopeId" = ${scopeId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
    ORDER BY fact."id"
    FOR UPDATE OF fact, version
  `);

  await advanceMemoryMutation(tx, settings, "SCOPE_TARGET_DELETE", {
    sourceRevisionHandled: true
  });
  for (const fact of facts) {
    const explicit = fact.sourceMode === "EXPLICIT";
    const eventId = randomUUID();
    const transitionAt = new Date(Math.max(Date.now(), fact.systemFrom.getTime() + 1));
    await tx.memoryEvent.create({
      data: {
        actorType: "SYSTEM",
        factId: fact.factId,
        factVersionId: fact.versionId,
        id: eventId,
        metadata: {
          scopeId,
          scopeType: input.scopeType,
          schemaVersion: "memory-scope-target-delete-v1",
          targetIdSnapshot: input.targetId
        },
        operation: explicit ? "SCOPE_CHANGE" : "SOURCE_INVALIDATE",
        userId: input.userId
      }
    });
    const version = await tx.memoryFactVersion.updateMany({
      data: {
        state: explicit ? "ORPHANED" : "RETRACTED",
        systemTo: transitionAt
      },
      where: {
        factId: fact.factId,
        id: fact.versionId,
        state: "ACTIVE",
        userId: input.userId
      }
    });
    const logical = await tx.memoryFact.updateMany({
      data: {
        currentVersionId: null,
        pinned: explicit ? undefined : false,
        state: explicit ? "ORPHANED" : "RETRACTED"
      },
      where: {
        currentVersionId: fact.versionId,
        id: fact.factId,
        state: "ACTIVE",
        userId: input.userId
      }
    });
    if (version.count !== 1 || logical.count !== 1) {
      return memoryPersistenceFailure("memory_fact_version_stale");
    }
    await tx.memorySearchEntry.deleteMany({
      where: { factVersionId: fact.versionId, userId: input.userId }
    });
  }

  const detached = await tx.memoryScope.updateMany({
    data: {
      assistantId: null,
      chatId: null,
      folderId: null,
      orphanedAt: new Date(),
      state: "ORPHANED"
    },
    where: { id: scopeId, state: "ACTIVE", userId: input.userId }
  });
  if (detached.count !== 1) {
    return memoryPersistenceFailure("memory_scope_unavailable");
  }
  return facts.length;
}

export async function applyMemoryAssistantAvailabilityChange(
  tx: MemoryTransaction,
  input: Readonly<{ assistantId: string; userId: string }>
): Promise<boolean> {
  const settings = await lockMemorySettings(tx, input.userId, false);
  const scopes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "MemoryScope"
    WHERE "userId" = ${input.userId}
      AND "scopeType" = 'ASSISTANT'::"MemoryScopeType"
      AND "targetIdSnapshot" = ${input.assistantId}
      AND "state" = 'ACTIVE'::"MemoryScopeState"
    FOR SHARE
  `);
  if (scopes.length === 0) return false;
  if (scopes.length !== 1) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }
  await advanceMemoryMutation(tx, settings, "ASSISTANT_ACCESS_CHANGE");
  return true;
}
