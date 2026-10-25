import { randomUUID } from "node:crypto";
import { Prisma, type MemoryIndexGenerationState } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION } from "../embedding/contract";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION, MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { ensureClassifiedSearchEntry } from "../persistence/factSearchEntry";
import { memorySha256 } from "../persistence/lexical";
import { ensureActiveLexicalGeneration, withLockedMemoryTransaction } from "../persistence/transaction";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import {
  createPrismaMemorySupersededEntryPruneStore,
  pruneSupersededMemorySearchEntries,
  type MemorySupersededEntryPruneLimits,
  type MemorySupersededEntryPruneStore
} from "./supersededRetention";

const old = new Date(Date.now() - 2 * 60 * 60_000);
const prismaStore = createPrismaMemorySupersededEntryPruneStore(prisma);

async function owner(label: string): Promise<string> {
  const userId = `memory-superseded-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: "Superseded retention test", status: "active" } });
  await prisma.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
  await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    ensureActiveLexicalGeneration(tx, settings, settings.memoryRevision));
  return userId;
}

async function cleanup(...userIds: string[]): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

/** One automatic direct fact with exact message evidence and its entry in
 * the active generation. */
async function fact(userId: string, text: string): Promise<string> {
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const scope = await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } });
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic source" } });
  const message = await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(text), role: "user", status: "complete", createdAt: old, updatedAt: old
  } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id, memorySourceRevision: 1 } });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "other",
      canonicalKey: `prop:v2:${memorySha256({ factId })}`, state: "ORPHANED", identityKind: "PROPOSITION", identityVersion: "proposition-v2" } });
    await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId, operation: "AUTO_PROPOSE", actorType: "JOB" } });
    await tx.memoryFactVersion.create({ data: { id: versionId, factId, userId, createdByEventId: eventId, category: "other",
      displayText: text, normalizedSearchText: text, structuredValue: { kind: "statement", value: text }, languageCode: "en",
      modality: "STATE", sourceMode: "AUTOMATIC", confidence: 1, importance: 0.4, directness: "DIRECT", sensitivityClass: "NORMAL",
      ...memorySafetyLiteFactClassification(old), pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      ingestionFingerprint: memorySha256({ factId }), observedAt: old, createdAt: old } });
    await tx.memoryEvidence.create({ data: { userId, factVersionId: versionId, chatId: chat.id, messageId: message.id,
      stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user", branchGeneration: 0, observedAt: old, createdAt: old,
      safeExcerpt: text, safeSourceHash: memorySha256(text), sourceMessageContentHash: memorySha256(text),
      sourceStartOffset: 0, sourceEndOffset: text.length, sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      safetyClass: "NORMAL", evidenceFingerprint: memorySha256({ versionId, messageId: message.id }) } });
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId: versionId } });
  });
  await withLockedMemoryTransaction(prisma, userId,
    (tx, settings) => ensureClassifiedSearchEntry(tx, settings, versionId, `trigger:${versionId}`, new Date()));
  return versionId;
}

async function activeGenerationId(userId: string): Promise<string> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  if (!settings.activeIndexGenerationId) throw new Error("active_generation_missing");
  return settings.activeIndexGenerationId;
}

/** Another generation with the active configuration and a clone of its
 * entries, as a past cutover (SUPERSEDED) or a running rebuild (BUILDING)
 * leaves it. */
async function generation(userId: string, state: Extract<MemoryIndexGenerationState, "BUILDING" | "SUPERSEDED">): Promise<string> {
  const activeId = await activeGenerationId(userId);
  const active = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: activeId } });
  const maximum = await prisma.memoryIndexGeneration.aggregate({ _max: { generation: true }, where: { userId } });
  const id = randomUUID();
  const now = new Date();
  await prisma.memoryIndexGeneration.create({ data: {
    chunkingVersion: active.chunkingVersion, contextualKeyPolicyVersion: active.contextualKeyPolicyVersion,
    generation: (maximum._max.generation ?? 0) + 1, id, indexMode: active.indexMode,
    indexedThroughMemoryRevision: active.indexedThroughMemoryRevision, languageProfile: active.languageProfile,
    normalizationVersion: active.normalizationVersion, retrievalPipelineVersion: active.retrievalPipelineVersion,
    roundProjectionVersion: active.roundProjectionVersion, roundSegmentProjectionVersion: active.roundSegmentProjectionVersion,
    state, targetMemoryRevision: active.targetMemoryRevision, userId,
    ...(state === "SUPERSEDED"
      ? { activatedAt: old, readyAt: old, supersededAt: now }
      : { sourceIndexGenerationId: activeId })
  } });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "MemorySearchEntry" (
      "id", "userId", "indexGenerationId", "itemType", "factVersionId", "normalizedSearchText",
      "safeContentHash", "languageCode", "safetyIdentitySnapshot", "sourceIdentitySnapshot",
      "suppressionIdentitySnapshot", "embeddingState"
    )
    SELECT gen_random_uuid()::text, source."userId", ${id}, source."itemType", source."factVersionId",
      source."normalizedSearchText", source."safeContentHash", source."languageCode",
      source."safetyIdentitySnapshot", source."sourceIdentitySnapshot",
      source."suppressionIdentitySnapshot", source."embeddingState"
    FROM "MemorySearchEntry" AS source
    WHERE source."userId" = ${userId} AND source."indexGenerationId" = ${activeId}
  `);
  return id;
}

/** The production store, limited to the test's owners: other suites share
 * the database, and their rows are none of this test's business. */
function ownStore(...userIds: string[]): MemorySupersededEntryPruneStore {
  return {
    owners: async (limit) => (await prismaStore.owners(100_000))
      .filter((userId) => userIds.includes(userId)).slice(0, limit),
    pruneBatch: (userId, limit) => prismaStore.pruneBatch(userId, limit)
  };
}

async function entryCounts(userId: string): Promise<Record<string, number>> {
  const rows = await prisma.memorySearchEntry.groupBy({ by: ["indexGenerationId"], _count: { _all: true }, where: { userId } });
  return Object.fromEntries(rows.map((row) => [row.indexGenerationId, row._count._all]));
}

async function generationRows(userId: string) {
  return prisma.memoryIndexGeneration.findMany({ orderBy: { generation: "asc" }, where: { userId } });
}

describe("superseded Memory search generation retention", () => {
  it("prunes superseded entries in bounded batches across passes and keeps the active generation and every row", async () => {
    const userId = await owner("batches");
    const bystander = await owner("bystander");
    try {
      for (const text of ["I live in Lisbon.", "I work as a translator.", "I keep bees.", "I speak Danish."]) {
        await fact(userId, text);
      }
      await fact(bystander, "I play the cello.");
      const activeId = await activeGenerationId(userId);
      const first = await generation(userId, "SUPERSEDED");
      const second = await generation(userId, "SUPERSEDED");
      const bystanderActive = await activeGenerationId(bystander);
      const activeEntryIds = (await prisma.memorySearchEntry.findMany({
        orderBy: { id: "asc" }, select: { id: true }, where: { indexGenerationId: activeId, userId }
      })).map(({ id }) => id);
      expect(activeEntryIds).toHaveLength(4);
      await expect(entryCounts(userId)).resolves.toEqual({ [activeId]: 4, [first]: 4, [second]: 4 });
      const rowsBefore = await generationRows(userId);
      expect(rowsBefore).toHaveLength(3);
      await expect(prismaStore.owners(100_000)).resolves.toContain(userId);
      await expect(prismaStore.owners(100_000)).resolves.not.toContain(bystander);

      const store = ownStore(userId, bystander);
      const limits: MemorySupersededEntryPruneLimits = { batchEntries: 3, maxBatches: 2 };
      await expect(pruneSupersededMemorySearchEntries(store, limits)).resolves.toEqual({ batches: 2, deletedEntries: 6 });
      const afterFirstPass = await entryCounts(userId);
      expect(afterFirstPass[activeId]).toBe(4);
      expect((afterFirstPass[first] ?? 0) + (afterFirstPass[second] ?? 0)).toBe(2);
      await expect(pruneSupersededMemorySearchEntries(store, limits)).resolves.toEqual({ batches: 1, deletedEntries: 2 });
      await expect(entryCounts(userId)).resolves.toEqual({ [activeId]: 4 });

      // Repeated passes change nothing.
      await expect(pruneSupersededMemorySearchEntries(store, limits)).resolves.toEqual({ batches: 0, deletedEntries: 0 });
      await expect(prismaStore.pruneBatch(userId, 500)).resolves.toBe(0);
      await expect(prisma.memorySearchEntry.findMany({
        orderBy: { id: "asc" }, select: { id: true }, where: { indexGenerationId: activeId, userId }
      })).resolves.toEqual(activeEntryIds.map((id) => ({ id })));
      await expect(generationRows(userId)).resolves.toEqual(rowsBefore);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ activeIndexGenerationId: activeId });
      await expect(entryCounts(bystander)).resolves.toEqual({ [bystanderActive]: 1 });
    } finally {
      await cleanup(userId, bystander);
    }
  });

  it("leaves a rebuild in progress and entries an open embedding job owns", async () => {
    const userId = await owner("in-flight");
    try {
      for (const text of ["I grow tomatoes.", "I cycle to work."]) await fact(userId, text);
      const activeId = await activeGenerationId(userId);
      const superseded = await generation(userId, "SUPERSEDED");
      const shadow = await generation(userId, "BUILDING");
      const [held] = await prisma.memorySearchEntry.findMany({
        orderBy: { id: "asc" }, take: 1, where: { indexGenerationId: superseded, userId }
      });
      if (!held) throw new Error("superseded_entry_missing");
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const job = await prisma.memoryJob.create({ data: {
        idempotencyFingerprint: memorySha256({ job: randomUUID() }), kind: "EMBED_ITEMS",
        memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_EMBEDDING_BATCH_PIPELINE_VERSION, state: "QUEUED", userId
      } });
      await prisma.memoryEmbeddingBatchItem.create({ data: {
        indexGenerationId: superseded, memoryJobId: job.id, ordinal: 0, searchEntryId: held.id,
        triggerIdentityHash: memorySha256({ trigger: held.id }), userId
      } });

      const store = ownStore(userId);
      await expect(pruneSupersededMemorySearchEntries(store)).resolves.toEqual({ batches: 1, deletedEntries: 1 });
      await expect(entryCounts(userId)).resolves.toEqual({ [activeId]: 2, [shadow]: 2, [superseded]: 1 });
      await expect(prisma.memorySearchEntry.findUniqueOrThrow({ where: { id: held.id } })).resolves.toMatchObject({ id: held.id });
      // Only the held entry remains, so the owner is not selected again.
      await expect(prismaStore.owners(100_000)).resolves.not.toContain(userId);
      await expect(pruneSupersededMemorySearchEntries(store)).resolves.toEqual({ batches: 0, deletedEntries: 0 });

      // Once the job settled, the entry and its batch child go.
      await prisma.memoryJob.update({ data: { completedAt: new Date(), state: "SUCCEEDED" }, where: { id: job.id } });
      await expect(pruneSupersededMemorySearchEntries(store)).resolves.toEqual({ batches: 1, deletedEntries: 1 });
      await expect(entryCounts(userId)).resolves.toEqual({ [activeId]: 2, [shadow]: 2 });
      await expect(prisma.memoryEmbeddingBatchItem.count({ where: { memoryJobId: job.id, userId } })).resolves.toBe(0);
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: shadow } }))
        .resolves.toMatchObject({ sourceIndexGenerationId: activeId, state: "BUILDING" });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: superseded } }))
        .resolves.toMatchObject({ state: "SUPERSEDED" });
    } finally {
      await cleanup(userId);
    }
  });
});
