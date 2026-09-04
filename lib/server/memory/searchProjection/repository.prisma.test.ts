import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import {
  advanceMemoryLexicalProjectionRevisionFence,
  claimMemoryLexicalProjectionEvents,
  enqueueMemoryLexicalProjectionUserPurge,
  resetMemoryLexicalProjection,
  settleMemoryLexicalProjectionFailure,
  settleMemoryLexicalProjectionSuccess
} from "./repository";

type Fixture = Readonly<{
  chatId: string;
  chunkId: string;
  generationId: string;
  userId: string;
}>;

afterAll(async () => {
  await prisma.$disconnect();
});

async function createFixture(): Promise<Fixture> {
  const userId = randomUUID();
  const chatId = randomUUID();
  const chunkId = randomUUID();
  const generationId = randomUUID();
  await prisma.user.create({
    data: {
      displayName: "Memory lexical projection fixture",
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: { memoryRevision: 7 },
    where: { userId }
  });
  await prisma.chat.create({
    data: {
      createdByDisplayName: "Memory lexical projection fixture",
      createdByUserId: userId,
      id: chatId,
      title: "Memory lexical projection fixture",
      userId
    }
  });
  await prisma.memoryRecallChunk.create({
    data: {
      branchGeneration: 0,
      chatId,
      chunkOrdinal: 0,
      chunkingVersion: "memory-projection-test-chunking-v1",
      contentHash: "a".repeat(64),
      id: chunkId,
      languageCode: "und",
      normalizedSafeSearchText: "first lexical projection",
      occurredFrom: new Date("2026-08-31T03:00:00.000Z"),
      occurredTo: new Date("2026-08-31T03:00:01.000Z"),
      redactionState: "NOT_NEEDED",
      safeProjectedText: "first lexical projection",
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-projection-test-source-v1",
      sourceRevisionAtCreation: 0,
      userId
    }
  });
  await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: "memory-projection-test-chunking-v1",
      generation: 1,
      id: generationId,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: 7,
      languageProfile: "multilingual",
      normalizationVersion: "memory-unicode-query-analysis-v1",
      retrievalPipelineVersion: "memory-personal-retrieval-v63",
      state: "BUILDING",
      targetMemoryRevision: 7,
      userId
    }
  });
  return { chatId, chunkId, generationId, userId };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await prisma.memorySearchEntry.deleteMany({ where: { userId: fixture.userId } });
  await prisma.memoryIndexGeneration.deleteMany({ where: { userId: fixture.userId } });
  await prisma.memoryLexicalProjectionEvent.deleteMany({
    where: { userId: fixture.userId }
  });
  await prisma.memoryLexicalProjectionState.deleteMany({
    where: { userId: fixture.userId }
  });
  await prisma.user.deleteMany({ where: { id: fixture.userId } });
}

async function enqueue(
  fixture: Fixture,
  searchEntryId: string
): Promise<bigint> {
  const [row] = await prisma.$queryRaw<Array<{ sequence: bigint }>>(Prisma.sql`
    SELECT aiqsa_enqueue_memory_lexical_projection_event(
      ${fixture.userId},
      ${fixture.generationId},
      ${searchEntryId},
      'SYNC_ENTRY'::"MemoryLexicalProjectionOperation",
      7
    ) AS "sequence"
  `);
  if (!row) throw new Error("memory_projection_test_enqueue_failed");
  return row.sequence;
}

async function quiesceUnrelatedProjectionEvents(
  userIds: readonly string[],
  now: Date
): Promise<void> {
  await prisma.memoryLexicalProjectionEvent.updateMany({
    data: {
      completedAt: now,
      errorCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      state: "SUCCEEDED",
      updatedAt: now
    },
    where: {
      state: { not: "SUCCEEDED" },
      userId: { notIn: [...userIds] }
    }
  });
}

describe("Memory lexical projection PostgreSQL repository", () => {
  it("advances a ready projection through a document-stable revision fence", async () => {
    const fixture = await createFixture();
    const now = new Date("2026-08-31T03:05:00.000Z");
    try {
      const sequence = await enqueue(fixture, randomUUID());
      await prisma.memoryLexicalProjectionState.update({
        data: {
          expectedContentFingerprint: "a".repeat(64),
          expectedDocumentCount: 0,
          lastIntegrityCheckAt: now,
          lastSuccessfulRefreshAt: now,
          projectedThroughRevision: 7,
          projectionFingerprint: "b".repeat(64),
          readyAt: now,
          status: "READY",
          visibleContentFingerprint: "a".repeat(64),
          visibleDocumentCount: 0,
          visibleThroughSequence: sequence
        },
        where: {
          userId_indexGenerationId: {
            indexGenerationId: fixture.generationId,
            userId: fixture.userId
          }
        }
      });

      await prisma.$transaction((tx) =>
        advanceMemoryLexicalProjectionRevisionFence(tx, {
          indexGenerationId: fixture.generationId,
          now,
          targetMemoryRevision: 8,
          userId: fixture.userId
        }));

      await expect(prisma.memoryLexicalProjectionState.findUniqueOrThrow({
        where: {
          userId_indexGenerationId: {
            indexGenerationId: fixture.generationId,
            userId: fixture.userId
          }
        }
      })).resolves.toMatchObject({
        projectedThroughRevision: 7,
        readyAt: null,
        status: "CATCHING_UP",
        targetMemoryRevision: 8
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("captures lexical mutations but ignores embedding-only updates", async () => {
    const fixture = await createFixture();
    const entryId = randomUUID();
    try {
      await prisma.memorySearchEntry.create({
        data: {
          embeddingState: "NOT_APPLICABLE",
          id: entryId,
          indexGenerationId: fixture.generationId,
          itemType: "RECALL_CHUNK",
          languageCode: "und",
          normalizedSearchText: "first lexical projection",
          recallChunkId: fixture.chunkId,
          safeContentHash: "a".repeat(64),
          safetyIdentitySnapshot: "b".repeat(64),
          sourceIdentitySnapshot: "c".repeat(64),
          suppressionIdentitySnapshot: "d".repeat(64),
          userId: fixture.userId
        }
      });
      await prisma.memorySearchEntry.update({
        data: { embeddingState: "NOT_APPLICABLE" },
        where: { id: entryId }
      });
      expect(await prisma.memoryLexicalProjectionEvent.count({
        where: { userId: fixture.userId }
      })).toBe(1);

      await prisma.memorySearchEntry.update({
        data: { normalizedSearchText: "second lexical projection" },
        where: { id: entryId }
      });
      await prisma.memorySearchEntry.delete({ where: { id: entryId } });
      await prisma.memoryIndexGeneration.delete({
        where: { id: fixture.generationId }
      });
      const events = await prisma.memoryLexicalProjectionEvent.findMany({
        orderBy: { sequence: "asc" },
        select: { operation: true, sequence: true },
        where: { userId: fixture.userId }
      });
      expect(events.map(({ operation }) => operation)).toEqual([
        "SYNC_ENTRY", "SYNC_ENTRY", "DELETE_ENTRY", "PURGE_GENERATION"
      ]);
      await expect(prisma.memoryLexicalProjectionEvent.update({
        data: { userId: randomUUID() },
        where: { sequence: events[0]!.sequence }
      })).rejects.toThrow(/memory_lexical_projection_event_admission_immutable/u);
      const state = await prisma.memoryLexicalProjectionState.findUniqueOrThrow({
        where: {
          userId_indexGenerationId: {
            indexGenerationId: fixture.generationId,
            userId: fixture.userId
          }
        }
      });
      expect(state.enqueuedThroughSequence).toBe(events.at(-1)!.sequence);
      expect(state.status).toBe("CATCHING_UP");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("claims only the oldest outstanding event per user and preserves retries", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const initialNow = new Date("2026-08-31T03:10:00.000Z");
    try {
      const firstSequence = await enqueue(first, randomUUID());
      const blockedSequence = await enqueue(first, randomUUID());
      const independentSequence = await enqueue(second, randomUUID());
      // Stateful files intentionally share one disposable database. Quiesce
      // unrelated derived work for this focused ordering assertion; the
      // finally block reconstructs it from canonical rows.
      await quiesceUnrelatedProjectionEvents(
        [first.userId, second.userId],
        initialNow
      );
      const claimed = await claimMemoryLexicalProjectionEvents(prisma, {
        leaseMs: 60_000,
        limit: 3,
        maximumAttempts: 2,
        now: initialNow
      });
      expect(claimed.map(({ sequence }) => sequence).sort()).toEqual(
        [firstSequence, independentSequence].sort()
      );
      expect(claimed.some(({ sequence }) => sequence === blockedSequence)).toBe(false);

      const failed = claimed.find(({ userId }) => userId === first.userId)!;
      const succeeded = claimed.find(({ userId }) => userId === second.userId)!;
      await settleMemoryLexicalProjectionFailure(prisma, failed, {
        errorCode: "opensearch_timeout",
        maximumAttempts: 2,
        now: initialNow
      });
      await settleMemoryLexicalProjectionSuccess(prisma, succeeded, initialNow);

      expect(await claimMemoryLexicalProjectionEvents(prisma, {
        leaseMs: 60_000,
        limit: 3,
        maximumAttempts: 2,
        now: new Date(initialNow.getTime() + 500)
      })).toEqual([]);
      const retry = await claimMemoryLexicalProjectionEvents(prisma, {
        leaseMs: 60_000,
        limit: 3,
        maximumAttempts: 2,
        now: new Date(initialNow.getTime() + 5_000)
      });
      expect(retry.map(({ sequence }) => sequence)).toEqual([firstSequence]);
      await settleMemoryLexicalProjectionSuccess(
        prisma,
        retry[0]!,
        new Date(initialNow.getTime() + 5_000)
      );
      const next = await claimMemoryLexicalProjectionEvents(prisma, {
        leaseMs: 60_000,
        limit: 3,
        maximumAttempts: 2,
        now: new Date(initialNow.getTime() + 5_001)
      });
      expect(next.map(({ sequence }) => sequence)).toEqual([blockedSequence]);
    } finally {
      await cleanupFixture(first);
      await cleanupFixture(second);
      await resetMemoryLexicalProjection(prisma, {
        mode: "RESTORE",
        now: new Date(initialNow.getTime() + 10_000)
      });
    }
  });

  it("rebuilds from canonical rows and preserves only terminal user purge duties", async () => {
    const fixture = await createFixture();
    const purgeUserId = randomUUID();
    const entryId = randomUUID();
    const now = new Date("2026-08-31T03:20:00.000Z");
    try {
      await prisma.memorySearchEntry.create({
        data: {
          embeddingState: "NOT_APPLICABLE",
          id: entryId,
          indexGenerationId: fixture.generationId,
          itemType: "RECALL_CHUNK",
          languageCode: "und",
          normalizedSearchText: "restore projection snapshot",
          recallChunkId: fixture.chunkId,
          safeContentHash: "a".repeat(64),
          safetyIdentitySnapshot: "b".repeat(64),
          sourceIdentitySnapshot: "c".repeat(64),
          suppressionIdentitySnapshot: "d".repeat(64),
          userId: fixture.userId
        }
      });
      const original = await prisma.memoryLexicalProjectionEvent.findFirstOrThrow({
        where: { operation: "SYNC_ENTRY", userId: fixture.userId }
      });
      await prisma.memoryLexicalProjectionState.update({
        data: {
          expectedContentFingerprint: "e".repeat(64),
          expectedDocumentCount: 1,
          lastIntegrityCheckAt: now,
          lastSuccessfulRefreshAt: now,
          projectedThroughRevision: 7,
          projectionFingerprint: "f".repeat(64),
          readyAt: now,
          status: "READY",
          visibleContentFingerprint: "e".repeat(64),
          visibleDocumentCount: 1,
          visibleThroughSequence: original.sequence
        },
        where: {
          userId_indexGenerationId: {
            indexGenerationId: fixture.generationId,
            userId: fixture.userId
          }
        }
      });

      await prisma.user.create({
        data: {
          displayName: "Memory projection purge fixture",
          id: purgeUserId,
          status: "disabled"
        }
      });
      await prisma.memoryDeletionOutbox.create({
        data: {
          memoryGeneration: 0,
          operation: "ACCOUNT_MEMORY_DELETE",
          targetId: purgeUserId,
          targetType: "ACCOUNT@memory-account-delete-v1",
          userId: purgeUserId
        }
      });
      const purgeSequence = await enqueueMemoryLexicalProjectionUserPurge(prisma, {
        memoryRevision: 0,
        userId: purgeUserId
      });
      await prisma.memoryLexicalProjectionEvent.update({
        data: {
          leaseExpiresAt: new Date(now.getTime() + 60_000),
          leaseToken: randomUUID(),
          state: "CLAIMED"
        },
        where: { sequence: purgeSequence }
      });

      const [eventsReset, statesReset, syncRows] = await Promise.all([
        prisma.memoryLexicalProjectionEvent.count(),
        prisma.memoryLexicalProjectionState.count(),
        prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::integer AS "count"
          FROM "MemorySearchEntry" AS entry
          WHERE NOT EXISTS (
            SELECT 1
            FROM "MemoryLexicalProjectionEvent" AS purge
            WHERE purge."userId" = entry."userId"
              AND purge."operation" =
                'PURGE_USER'::"MemoryLexicalProjectionOperation"
          )
        `)
      ]);

      await expect(resetMemoryLexicalProjection(prisma, {
        mode: "REBUILD",
        now
      })).rejects.toThrow("memory_lexical_projection_rebuild_active_leases");
      await expect(resetMemoryLexicalProjection(prisma, {
        mode: "RESTORE",
        now
      })).resolves.toEqual({
        eventsReset,
        statesReset,
        syncEventsCreated: syncRows[0]?.count ?? 0
      });

      const canonicalEvents = await prisma.memoryLexicalProjectionEvent.findMany({
        orderBy: { sequence: "asc" },
        where: { userId: fixture.userId }
      });
      expect(canonicalEvents).toHaveLength(1);
      expect(canonicalEvents[0]).toMatchObject({
        operation: "SYNC_ENTRY",
        searchEntryId: entryId,
        state: "PENDING"
      });
      expect(canonicalEvents[0]!.sequence).toBeGreaterThan(original.sequence);
      await expect(prisma.memoryLexicalProjectionState.findUniqueOrThrow({
        where: {
          userId_indexGenerationId: {
            indexGenerationId: fixture.generationId,
            userId: fixture.userId
          }
        }
      })).resolves.toMatchObject({
        expectedContentFingerprint: null,
        readyAt: null,
        status: "CATCHING_UP",
        visibleThroughSequence: 0n
      });

      await expect(prisma.memoryLexicalProjectionEvent.findUniqueOrThrow({
        where: { sequence: purgeSequence }
      })).resolves.toMatchObject({
        attemptCount: 0,
        leaseExpiresAt: null,
        leaseToken: null,
        operation: "PURGE_USER",
        state: "PENDING"
      });
      await expect(prisma.memoryLexicalProjectionState.count({
        where: { userId: purgeUserId }
      })).resolves.toBe(0);
      await expect(prisma.memoryLexicalProjectionEvent.count({
        where: { state: "CLAIMED" }
      })).resolves.toBe(0);
      await expect(prisma.memoryLexicalProjectionState.count({
        where: { status: "READY" }
      })).resolves.toBe(0);
    } finally {
      await prisma.memoryLexicalProjectionEvent.deleteMany({
        where: { userId: purgeUserId }
      });
      await prisma.memoryLexicalProjectionState.deleteMany({
        where: { userId: purgeUserId }
      });
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: purgeUserId } });
      await prisma.user.deleteMany({ where: { id: purgeUserId } });
      await cleanupFixture(fixture);
    }
  });
});
