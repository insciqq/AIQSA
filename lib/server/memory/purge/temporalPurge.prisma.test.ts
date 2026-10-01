import { randomUUID } from "node:crypto";
import type { MemoryFactVersion, Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryDeletionClaim } from "../coordinator/types";
import { MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION } from "../learning/consolidation/contract";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { memorySha256 } from "../persistence/lexical";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import {
  MEMORY_DELETE_EXPLICIT_TARGET_ID,
  MEMORY_PURGE_REQUIRED_CONTRIBUTORS,
  memoryPurgeTargetType,
  type MemoryPurgeTargetKind
} from "./contract";
import { registerMemoryDeletionContributors } from "./leaves";
import { auditMemoryDeletion } from "./reconciliation";
import { MemoryDeletionContributorRegistry } from "./registry";

// Every column the vNext temporal guard requires to be NULL before a purge may
// change any of them.
const temporalColumns = [
  "occurredAt",
  "expectedAt",
  "expiresAt",
  "validFrom",
  "validTo",
  "rawTemporalExpression",
  "sourceTimezone",
  "temporalResolverVersion",
  "temporalResolutionEvidence"
] as const;

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

type VersionKind = "VNEXT" | "EXPLICIT" | "LEGACY";

type VersionInput = Readonly<{
  createdAt: Date;
  dated?: boolean;
  kind: VersionKind;
  sourceAt?: Date;
}>;

function purgeRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

async function owner(): Promise<string> {
  const userId = `memory-temporal-purge-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: "Temporal purge test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.memoryScope.create({ data: { scopeType: "GLOBAL_USER", userId } });
  return userId;
}

async function cleanup(userIds: readonly string[]): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: [...userIds] } } });
  await prisma.memorySourceBarrier.deleteMany({ where: { userId: { in: [...userIds] } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
}

/** Temporal attributes as each producer writes them. */
function temporalValues(input: VersionInput) {
  const anchor = input.createdAt;
  const validFrom = new Date(anchor.getTime() - day);
  const validTo = new Date(anchor.getTime() + 30 * day);
  if (input.kind === "EXPLICIT") return { validFrom, validTo };
  const resolver = {
    sourceTimezone: "UTC",
    temporalResolverVersion: "memory-temporal-test-v1"
  };
  if (input.kind === "LEGACY") {
    return {
      ...resolver,
      rawTemporalExpression: "since last month",
      temporalResolutionEvidence: { grounded: true },
      validFrom,
      validTo
    };
  }
  // vNext extraction records its resolver context even for undated facts.
  if (!input.dated) return resolver;
  return {
    ...resolver,
    expectedAt: new Date(anchor.getTime() + 7 * day),
    expiresAt: new Date(Date.now() + 365 * day),
    occurredAt: anchor,
    rawTemporalExpression: "next week",
    temporalResolutionEvidence: { grounded: true },
    validFrom,
    validTo
  };
}

async function insertVersion(
  tx: Prisma.TransactionClient,
  userId: string,
  factId: string,
  input: VersionInput
): Promise<string> {
  const versionId = randomUUID();
  const eventId = randomUUID();
  const text = `Synthetic temporal observation ${versionId}`;
  const explicit = input.kind === "EXPLICIT";
  await tx.memoryEvent.create({
    data: {
      actorType: explicit ? "USER" : "JOB",
      actorUserId: explicit ? userId : null,
      createdAt: input.createdAt,
      factId,
      factVersionId: versionId,
      id: eventId,
      operation: explicit ? "EXPLICIT_SAVE" : "AUTO_PROPOSE",
      userId
    }
  });
  const vnext = input.kind === "VNEXT";
  await tx.memoryFactVersion.create({
    data: {
      category: "other",
      confidence: 0.6,
      createdAt: input.createdAt,
      createdByEventId: eventId,
      directness: "DIRECT",
      displayText: text,
      factId,
      id: versionId,
      importance: 0.4,
      languageCode: "en",
      modality: "STATE",
      normalizedSearchText: text,
      sensitivityClass: "NORMAL",
      sourceMode: explicit ? "EXPLICIT" : "AUTOMATIC",
      structuredValue: { kind: "statement", value: text },
      userId,
      ...memorySafetyLiteFactClassification(input.createdAt),
      ...temporalValues(input),
      ...(vnext
        ? {
            ingestionFingerprint: memorySha256({ versionId }),
            observedAt: input.createdAt,
            pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION
          }
        : {
            pipelineVersion: explicit
              ? "memory-explicit-temporal-test-v1"
              : MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION
          })
    }
  });
  if (vnext) {
    const sourceAt = input.sourceAt ?? input.createdAt;
    const chat = await tx.chat.create({ data: { title: "Synthetic episode", userId } });
    const message = await tx.message.create({
      data: {
        chatId: chat.id,
        content: textMessageContent(text),
        createdAt: sourceAt,
        role: "user",
        status: "complete",
        updatedAt: sourceAt
      }
    });
    await tx.chat.update({
      data: { activeLeafMessageId: message.id, memorySourceRevision: 1 },
      where: { id: chat.id }
    });
    await tx.memoryEvidence.create({
      data: {
        branchGeneration: 0,
        chatId: chat.id,
        createdAt: input.createdAt,
        evidenceFingerprint: memorySha256({ messageId: message.id, versionId }),
        factVersionId: versionId,
        messageId: message.id,
        observedAt: input.createdAt,
        safeExcerpt: text,
        safeSourceHash: memorySha256(text),
        safetyClass: "NORMAL",
        sourceEndOffset: text.length,
        sourceMessageContentHash: memorySha256(text),
        sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
        sourceRole: "user",
        sourceStartOffset: 0,
        sourceType: "MESSAGE",
        stance: "SUPPORTS",
        userId
      }
    });
  }
  return versionId;
}

async function seedFact(
  userId: string,
  input: VersionInput
): Promise<Readonly<{ factId: string; versionId: string }>> {
  const factId = randomUUID();
  const scope = await prisma.memoryScope.findFirstOrThrow({
    where: { scopeType: "GLOBAL_USER", userId }
  });
  const versionId = await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey: `prop:v2:${memorySha256({ factId })}`,
        category: "other",
        createdAt: input.createdAt,
        id: factId,
        identityKind: "PROPOSITION",
        identityVersion: "proposition-v2",
        scopeId: scope.id,
        state: "ORPHANED",
        userId
      }
    });
    const created = await insertVersion(tx, userId, factId, input);
    await tx.memoryFact.update({
      data: { currentVersionId: created, state: "ACTIVE" },
      where: { id: factId }
    });
    return created;
  });
  return { factId, versionId };
}

/** Independently accepted replacement after the old version was forgotten. */
async function reactivate(userId: string, factId: string, input: VersionInput): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const versionId = await insertVersion(tx, userId, factId, input);
    await tx.memoryFact.update({
      data: { currentVersionId: versionId, forgottenAt: null, state: "ACTIVE" },
      where: { id: factId }
    });
    return versionId;
  });
}

async function forget(userId: string, factId: string, at = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "MemoryFactVersion"
      SET "state" = 'FORGOTTEN'::"MemoryFactVersionState",
        "systemTo" = COALESCE("systemTo", GREATEST(${at}, "systemFrom" + INTERVAL '1 millisecond'))
      WHERE "userId" = ${userId} AND "factId" = ${factId}
        AND "state" = 'ACTIVE'::"MemoryFactVersionState"
    `;
    await tx.memoryFact.update({
      data: { currentVersionId: null, forgottenAt: at, state: "FORGOTTEN" },
      where: { id: factId }
    });
  });
}

async function obligation(
  userId: string,
  kind: MemoryPurgeTargetKind,
  targetId: string
): Promise<string> {
  const row = await prisma.memoryDeletionOutbox.create({
    data: {
      memoryGeneration: 0,
      operation: "FORGET_PURGE",
      targetId,
      targetType: memoryPurgeTargetType(kind),
      userId
    },
    select: { id: true }
  });
  return row.id;
}

async function barrier(
  userId: string,
  kind: "ALL_REUSABLE" | "AUTOMATIC_FACTS",
  createdAt: Date,
  sourceCreatedAtCutoff: Date
): Promise<string> {
  const row = await prisma.memorySourceBarrier.create({
    data: { createdAt, kind, memoryGeneration: 0, sourceCreatedAtCutoff, userId },
    select: { id: true }
  });
  return row.id;
}

/** Claims only this test's obligation; the coordinator claim is exercised separately. */
async function claimOwned(
  userId: string,
  deletionId: string,
  now: Date
): Promise<MemoryDeletionClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + minute);
  const claimed = await prisma.memoryDeletionOutbox.updateMany({
    data: {
      attemptCount: { increment: 1 },
      errorCode: null,
      leaseExpiresAt,
      leaseToken: claimToken,
      nextAttemptAt: null,
      state: "RUNNING",
      updatedAt: now
    },
    where: {
      id: deletionId,
      state: { in: ["BLOCKED_REQUIRES_ADMIN", "PENDING", "RETRY_WAIT"] },
      userId
    }
  });
  expect(claimed.count).toBe(1);
  const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: deletionId } });
  return {
    admissionAuthorizationId: row.admissionAuthorizationId,
    admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
    admittedChatSourceRevision: row.admittedChatSourceRevision,
    alsoForgetOriginMemories: row.alsoForgetOriginMemories,
    attemptCount: row.attemptCount,
    claimToken,
    id: deletionId,
    leaseExpiresAt,
    memoryGeneration: row.memoryGeneration,
    operation: row.operation,
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: row.targetId,
    targetType: row.targetType,
    userId
  };
}

async function purge(
  registry: MemoryDeletionContributorRegistry,
  userId: string,
  deletionId: string,
  now = new Date()
): Promise<void> {
  const claim = await claimOwned(userId, deletionId, now);
  const execution = await registry.handler().execute(claim, {
    now: () => now,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitDeletionSuccess({
    apply: execution.apply,
    claim,
    now
  })).resolves.toBe(true);
  await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: deletionId } }))
    .resolves.toMatchObject({ errorCode: null, state: "SUCCEEDED" });
}

/** Reopen an owned completed obligation and run the ordinary purge again. */
async function purgeAgain(
  registry: MemoryDeletionContributorRegistry,
  userId: string,
  deletionId: string
): Promise<void> {
  await prisma.memoryDeletionOutbox.update({
    data: { completedAt: null, state: "PENDING" },
    where: { id: deletionId }
  });
  await purge(registry, userId, deletionId);
}

function version(id: string): Promise<MemoryFactVersion | null> {
  return prisma.memoryFactVersion.findUnique({ where: { id } });
}

function versions(ids: readonly string[]): Promise<MemoryFactVersion[]> {
  return prisma.memoryFactVersion.findMany({ orderBy: { id: "asc" }, where: { id: { in: [...ids] } } });
}

function expectPurged(row: MemoryFactVersion | null): void {
  expect(row).not.toBeNull();
  expect(row).toMatchObject({
    contentPurgedAt: expect.any(Date),
    displayText: null,
    normalizedSearchText: null,
    state: "FORGOTTEN",
    structuredValue: null,
    ...Object.fromEntries(temporalColumns.map((column) => [column, null]))
  });
}

function nonNullTemporalColumns(row: MemoryFactVersion): string[] {
  return temporalColumns.filter((column) => row[column] !== null);
}

async function expectComplete(
  registry: MemoryDeletionContributorRegistry,
  userId: string,
  deletionId: string
): Promise<void> {
  await expect(auditMemoryDeletion(registry, deletionId, userId, prisma))
    .resolves.toMatchObject({ progress: { complete: true }, state: "SUCCEEDED" });
}

afterAll(async () => { await prisma.$disconnect(); });

describe("forget purge of temporal Memory attributes", () => {
  it.each(["VNEXT", "EXPLICIT", "LEGACY"] as const)(
    "purges every temporal field of a forgotten dated %s fact without touching live or foreign versions",
    async (kind) => {
      const registry = purgeRegistry();
      const userId = await owner();
      const otherUserId = await owner();
      try {
        const createdAt = new Date(Date.now() - 2 * hour);
        const forgotten = await seedFact(userId, { createdAt, dated: true, kind });
        const foreign = await seedFact(otherUserId, { createdAt, dated: true, kind });
        const before = (await version(forgotten.versionId))!;
        expect(nonNullTemporalColumns(before).length).toBeGreaterThanOrEqual(2);
        await forget(userId, forgotten.factId);
        await forget(otherUserId, foreign.factId);
        const replacement = await reactivate(userId, forgotten.factId, {
          createdAt: new Date(Date.now() - minute),
          dated: true,
          kind
        });
        const untouched = await versions([replacement, foreign.versionId]);
        const deletionId = await obligation(userId, "MEMORY_FACT", forgotten.factId);

        await purge(registry, userId, deletionId);

        const purged = (await version(forgotten.versionId))!;
        expectPurged(purged);
        expect(purged.observedAt).toEqual(before.observedAt);
        expect(purged.ingestionFingerprint).toBe(before.ingestionFingerprint);
        await expect(versions([replacement, foreign.versionId])).resolves.toEqual(untouched);
        await expectComplete(registry, userId, deletionId);

        await purgeAgain(registry, userId, deletionId);
        await expect(version(forgotten.versionId)).resolves.toEqual(purged);
        await expect(versions([replacement, foreign.versionId])).resolves.toEqual(untouched);
        await expectComplete(registry, userId, deletionId);
      } finally {
        await cleanup([userId, otherUserId]);
      }
    }
  );

  it("resumes a blocked purge obligation through the coordinator retry claim", async () => {
    const registry = purgeRegistry();
    const repository = createPrismaMemoryCoordinatorRepository(prisma);
    const userId = await owner();
    try {
      const fact = await seedFact(userId, {
        createdAt: new Date(Date.now() - 2 * hour),
        dated: true,
        kind: "VNEXT"
      });
      await forget(userId, fact.factId);
      const deletionId = await obligation(userId, "MEMORY_FACT", fact.factId);
      const firstAt = new Date();
      const eligibleForeign = await prisma.memoryDeletionOutbox.count({
        where: {
          OR: [
            {
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(firstAt.getTime() + hour) } }],
              state: { in: ["BLOCKED_REQUIRES_ADMIN", "PENDING", "RETRY_WAIT"] }
            },
            { leaseExpiresAt: { lte: new Date(firstAt.getTime() + hour) }, state: "RUNNING" }
          ],
          operation: "FORGET_PURGE",
          userId: { not: userId }
        }
      });
      // The coordinator claim is global; never claim another test's obligation.
      expect(eligibleForeign).toBe(0);

      // A failed attempt leaves the duty blocked for administrator-visible retry.
      const failed = await repository.claimDeletion({
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(firstAt.getTime() + minute),
        now: firstAt,
        operations: ["FORGET_PURGE"]
      });
      expect(failed).toMatchObject({ id: deletionId, resumedFromBlocked: false });
      await expect(repository.retryDeletion({
        blocked: true,
        claim: failed!,
        errorCode: "memory_deletion_failed",
        nextAttemptAt: new Date(firstAt.getTime() + 1_000),
        now: firstAt
      })).resolves.toBe(true);
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: deletionId } }))
        .resolves.toMatchObject({ state: "BLOCKED_REQUIRES_ADMIN" });

      const retryAt = new Date(firstAt.getTime() + 2_000);
      const retried = await repository.claimDeletion({
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(retryAt.getTime() + minute),
        now: retryAt,
        operations: ["FORGET_PURGE"]
      });
      expect(retried).toMatchObject({ id: deletionId, resumedFromBlocked: true });
      const execution = await registry.handler().execute(retried!, {
        now: () => retryAt,
        signal: new AbortController().signal
      });
      await expect(repository.commitDeletionSuccess({
        apply: execution.apply,
        claim: retried!,
        now: retryAt
      })).resolves.toBe(true);

      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id: deletionId } }))
        .resolves.toMatchObject({ errorCode: null, state: "SUCCEEDED" });
      expectPurged(await version(fact.versionId));
      await expectComplete(registry, userId, deletionId);
    } finally {
      await cleanup([userId]);
    }
  });

  it.each(["VNEXT", "EXPLICIT"] as const)(
    "reopens a completed %s purge that left only temporal residue",
    async (kind) => {
      const registry = purgeRegistry();
      const userId = await owner();
      try {
        const fact = await seedFact(userId, {
          createdAt: new Date(Date.now() - 2 * hour),
          dated: false,
          kind
        });
        await forget(userId, fact.factId);
        // The state the previous purge contract committed as SUCCEEDED: payload
        // and two temporal columns cleared, the rest of the tuple retained.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE "MemoryFactVersion"
            SET "displayText" = NULL, "normalizedSearchText" = NULL, "structuredValue" = NULL,
              "rawTemporalExpression" = NULL, "temporalResolutionEvidence" = NULL,
              "contentPurgedAt" = CURRENT_TIMESTAMP
            WHERE "userId" = ${userId} AND "id" = ${fact.versionId}
          `;
          await tx.memoryEvidence.deleteMany({ where: { factVersionId: fact.versionId, userId } });
        });
        const residue = (await version(fact.versionId))!;
        expect(residue).toMatchObject({ contentPurgedAt: expect.any(Date), displayText: null });
        expect(nonNullTemporalColumns(residue).length).toBeGreaterThan(0);
        const completedAt = new Date(Date.now() - minute);
        const { id: deletionId } = await prisma.memoryDeletionOutbox.create({
          data: {
            attemptCount: 1,
            completedAt,
            lastAuditAt: completedAt,
            memoryGeneration: 0,
            operation: "FORGET_PURGE",
            state: "SUCCEEDED",
            targetId: fact.factId,
            targetType: memoryPurgeTargetType("MEMORY_FACT"),
            userId
          },
          select: { id: true }
        });

        await expect(auditMemoryDeletion(registry, deletionId, userId, prisma))
          .resolves.toMatchObject({
            progress: {
              complete: false,
              completedUnits: MEMORY_PURGE_REQUIRED_CONTRIBUTORS.length - 1
            },
            state: "PENDING"
          });
        await purge(registry, userId, deletionId);
        const purged = (await version(fact.versionId))!;
        expectPurged(purged);
        expect(purged.contentPurgedAt).toEqual(residue.contentPurgedAt);
        await expectComplete(registry, userId, deletionId);
      } finally {
        await cleanup([userId]);
      }
    }
  );

  it("purges AUTOMATIC_SET versions only up to its barrier", async () => {
    const registry = purgeRegistry();
    const userId = await owner();
    try {
      const base = new Date(Date.now() - 4 * hour);
      const barrierAt = new Date(base.getTime() + 2 * hour);
      const selected = await seedFact(userId, { createdAt: base, dated: true, kind: "VNEXT" });
      const late = await seedFact(userId, {
        createdAt: new Date(base.getTime() + 3 * hour),
        dated: true,
        kind: "VNEXT"
      });
      const explicit = await seedFact(userId, { createdAt: base, kind: "EXPLICIT" });
      const active = await seedFact(userId, { createdAt: base, dated: true, kind: "VNEXT" });
      for (const { factId } of [selected, late, explicit]) await forget(userId, factId);
      const untouchedIds = [late.versionId, explicit.versionId, active.versionId];
      const untouched = await versions(untouchedIds);
      const barrierId = await barrier(userId, "AUTOMATIC_FACTS", barrierAt, barrierAt);
      const deletionId = await obligation(userId, "AUTOMATIC_SET", barrierId);

      await purge(registry, userId, deletionId);

      const purged = (await version(selected.versionId))!;
      expectPurged(purged);
      await expect(versions(untouchedIds)).resolves.toEqual(untouched);
      await expectComplete(registry, userId, deletionId);
      await purgeAgain(registry, userId, deletionId);
      await expect(version(selected.versionId)).resolves.toEqual(purged);
      await expect(versions(untouchedIds)).resolves.toEqual(untouched);
    } finally {
      await cleanup([userId]);
    }
  });

  it("purges ALL_REUSABLE versions inside the barrier and source cutoff only", async () => {
    const registry = purgeRegistry();
    const userId = await owner();
    const otherUserId = await owner();
    try {
      const base = new Date(Date.now() - 4 * hour);
      const barrierAt = new Date(base.getTime() + 2 * hour);
      const cutoff = new Date(base.getTime() + hour);
      const afterBarrier = new Date(base.getTime() + 3 * hour);
      const removed = await seedFact(userId, { createdAt: base, dated: true, kind: "VNEXT" });
      const oldSource = await seedFact(userId, {
        createdAt: afterBarrier,
        dated: true,
        kind: "VNEXT",
        sourceAt: new Date(base.getTime() + 30 * minute)
      });
      const outside = await seedFact(userId, { createdAt: afterBarrier, dated: true, kind: "VNEXT" });
      const active = await seedFact(userId, { createdAt: afterBarrier, dated: true, kind: "VNEXT" });
      const foreign = await seedFact(otherUserId, { createdAt: base, dated: true, kind: "VNEXT" });
      for (const { factId } of [removed, oldSource, outside]) await forget(userId, factId);
      await forget(otherUserId, foreign.factId);
      const untouchedIds = [outside.versionId, active.versionId, foreign.versionId];
      const untouched = await versions(untouchedIds);
      const barrierId = await barrier(userId, "ALL_REUSABLE", barrierAt, cutoff);
      const deletionId = await obligation(userId, "ALL_REUSABLE", barrierId);

      await purge(registry, userId, deletionId);

      // The ledger removes facts created before the barrier in the same transaction.
      await expect(version(removed.versionId)).resolves.toBeNull();
      const purged = (await version(oldSource.versionId))!;
      expectPurged(purged);
      await expect(versions(untouchedIds)).resolves.toEqual(untouched);
      await expectComplete(registry, userId, deletionId);
      await purgeAgain(registry, userId, deletionId);
      await expect(version(oldSource.versionId)).resolves.toEqual(purged);
      await expect(versions(untouchedIds)).resolves.toEqual(untouched);
    } finally {
      await cleanup([userId, otherUserId]);
    }
  });

  it("purges EXPLICIT_SET forgotten versions without touching active explicit facts", async () => {
    const registry = purgeRegistry();
    const userId = await owner();
    try {
      const createdAt = new Date(Date.now() - 2 * hour);
      const forgotten = await seedFact(userId, { createdAt, kind: "EXPLICIT" });
      const active = await seedFact(userId, { createdAt, kind: "EXPLICIT" });
      const learned = await seedFact(userId, { createdAt, dated: true, kind: "VNEXT" });
      await forget(userId, forgotten.factId);
      await forget(userId, learned.factId);
      const untouchedIds = [active.versionId, learned.versionId];
      const untouched = await versions(untouchedIds);
      const deletionId = await obligation(userId, "EXPLICIT_SET", MEMORY_DELETE_EXPLICIT_TARGET_ID);

      await purge(registry, userId, deletionId);

      const purged = (await version(forgotten.versionId))!;
      expectPurged(purged);
      await expect(versions(untouchedIds)).resolves.toEqual(untouched);
      await expectComplete(registry, userId, deletionId);
      await purgeAgain(registry, userId, deletionId);
      await expect(version(forgotten.versionId)).resolves.toEqual(purged);
    } finally {
      await cleanup([userId]);
    }
  });

  it("keeps rejecting temporal changes outside an authorized content purge", async () => {
    const userId = await owner();
    try {
      const createdAt = new Date(Date.now() - 2 * hour);
      const active = await seedFact(userId, { createdAt, dated: true, kind: "VNEXT" });
      const forgotten = await seedFact(userId, { createdAt, dated: true, kind: "VNEXT" });
      await forget(userId, forgotten.factId);
      const before = await versions([active.versionId, forgotten.versionId]);
      const rejected = { code: "P2010", meta: { code: "23514" } };

      await expect(prisma.$executeRaw`
        UPDATE "MemoryFactVersion" SET "sourceTimezone" = 'Europe/Berlin'
        WHERE "userId" = ${userId} AND "id" = ${active.versionId}
      `).rejects.toMatchObject(rejected);
      // Clearing the tuple is reserved for a forgotten/retracted content purge.
      for (const versionId of [active.versionId, forgotten.versionId]) {
        await expect(prisma.$executeRaw`
          UPDATE "MemoryFactVersion"
          SET "occurredAt" = NULL, "expectedAt" = NULL, "expiresAt" = NULL,
            "validFrom" = NULL, "validTo" = NULL, "rawTemporalExpression" = NULL,
            "sourceTimezone" = NULL, "temporalResolverVersion" = NULL,
            "temporalResolutionEvidence" = NULL
          WHERE "userId" = ${userId} AND "id" = ${versionId}
        `).rejects.toMatchObject(rejected);
      }
      await expect(versions([active.versionId, forgotten.versionId])).resolves.toEqual(before);
    } finally {
      await cleanup([userId]);
    }
  });
});
