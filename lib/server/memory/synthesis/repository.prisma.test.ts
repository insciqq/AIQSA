import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createMemoryClientRefService } from "../actions/clientRef";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput
} from "../persistence/facts";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { ensureActiveLexicalGeneration, withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION } from "../learning/relations/explicitPolicy";
import { createMemoryRebuildHandler } from "../rebuild/handler";
import { createPrismaMemoryRebuildRepository } from "../rebuild/repository";
import { ensureClassifiedSearchEntry } from "../persistence/factSearchEntry";
import { createMemorySuppressionInTransaction } from "../persistence/suppressions";
import { planMemoryRetrieval } from "../../../domain/memory/retrieval";
import { createPrismaLocalMemoryRetrievalRepository } from
  "../retrieval/localRepository";
import { createPrismaMemoryItemEmbeddingRepository } from
  "../embedding/repository";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import { resolvePreparingMemoryItem } from "../../runs/preparingMemoryItems";
import { loadMemoryRunSources } from "../sources/runProjection";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  buildMemorySynthesisRequest,
  decodeMemorySynthesisOutput,
  type MemorySynthesisReasonCode
} from "./contract";
import {
  loadMemoryReusableFactVersionIds,
  memorySynthesisPatternAuthorityPredicate
} from "./eligibility";
import {
  memorySynthesisJobFingerprint,
  memorySynthesisSourceEligibilityHash,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  MEMORY_SYNTHESIS_PROMPT_VERSION,
  MEMORY_SYNTHESIS_QUIET_PERIOD_MS,
  type MemorySynthesisPlan
} from "./policy";
import {
  memorySynthesisAcceptedOutputHash,
  memorySynthesisInputHash
} from "./provider";
import {
  loadMemorySynthesisScheduleStatus,
  reconcileMemorySynthesisWork
} from "./reconcile";
import {
  createPrismaMemorySynthesisRepository,
  loadMemorySynthesisSnapshot,
  retractInvalidMemorySynthesisPatterns
} from "./repository";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 181));
const keyring = MemorySuppressionKeyring.parse(
  `current=synthesis-v1,synthesis-v1=${keyBytes.toString("base64")}`
);

async function createOwner(): Promise<string> {
  const suffix = randomUUID();
  const userId = `memory-synthesis-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory synthesis test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: { useMemoryFacts: true },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

function sourceInput(input: Readonly<{
  confidence?: number;
  index: number;
  observedAt: Date;
  scopeId: string;
}>): MemoryFactSaveInput {
  const statement = `I use the review workflow step ${input.index} every week.`;
  const fingerprint = memorySha256({
    domain: "aiqsa.test.memory-synthesis-source",
    index: input.index,
    observedAt: input.observedAt.toISOString(),
    version: 1
  });
  return {
    authorization: {
      action: "SAVE",
      authorizationId: `synthesis-source-authorization-${fingerprint}`,
      authorizedPayloadHash: "f".repeat(64)
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: input.observedAt,
      safeExcerpt: statement,
      safeSourceHash: memorySha256(statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-explicit-action-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: fingerprint,
    requestId: `synthesis-source-request-${fingerprint}`,
    scopeId: input.scopeId,
    value: {
      canonicalKey: `synthesis.source.${input.index}.${fingerprint.slice(0, 16)}`,
      category: "habits",
      confidence: input.confidence ?? 1,
      directness: "DIRECT",
      displayText: statement,
      importance: 0.7,
      languageCode: "en",
      modality: "HABIT",
      pipelineVersion: "memory-explicit-synthesis-source-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      structuredValue: { kind: "habit", step: input.index }
    }
  };
}

async function createSucceededJobBinding(input: Readonly<{
  acceptedOutputHash: string;
  inputHash: string;
  jobId: string;
  logicalRole: "MEMORY_RECLASSIFY" | "MEMORY_SYNTHESIZE";
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  schemaVersion: string;
  userId: string;
}>): Promise<string> {
  const id = `memory-synthesis-binding-${randomUUID()}`;
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - 1_000);
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: input.acceptedOutputHash,
      completedAt,
      createdAt: startedAt,
      destinationFingerprint: "d".repeat(64),
      id,
      inputHash: input.inputHash,
      logicalRole: input.logicalRole,
      memoryJobId: input.jobId,
      ordinal: 0,
      ownerType: "JOB",
      pipelineVersion: input.pipelineVersion,
      policyVersion: input.policyVersion,
      promptVersion: input.promptVersion,
      providerId: "openai_compatible",
      recoverableUntil: completedAt,
      relationsDetachedAt: completedAt,
      schemaVersion: input.schemaVersion,
      secretFreeExecutionSnapshot: {},
      startedAt,
      state: "SUCCEEDED",
      usageCompleteness: "UNAVAILABLE",
      userId: input.userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      memoryExecutionBindingId: id,
      modelId: "memory-synthesis-stateful-model",
      provider: "openai_compatible",
      providerModelId: "memory-synthesis-stateful-model",
      userId: input.userId
    }
  });
  return id;
}

async function classifySources(
  userId: string,
  versionIds: readonly string[]
): Promise<void> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId }
  });
  const completedAt = new Date();
  const job = await prisma.memoryJob.create({
    data: {
      acceptedResultHash: "a".repeat(64),
      completedAt,
      idempotencyFingerprint: memorySha256({
        domain: "aiqsa.test.memory-synthesis-classification",
        userId,
        versionIds: [...versionIds].sort(),
        version: 1
      }),
      kind: "RECLASSIFY_FACTS",
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      pipelineVersion: "memory-reclassification-stateful-test-v1",
      state: "SUCCEEDED",
      userId
    }
  });
  const executionId = await createSucceededJobBinding({
    acceptedOutputHash: "b".repeat(64),
    inputHash: "c".repeat(64),
    jobId: job.id,
    logicalRole: "MEMORY_RECLASSIFY",
    pipelineVersion: job.pipelineVersion,
    policyVersion: "memory-reclassification-policy-v1",
    promptVersion: "memory-reclassification-prompt-v1",
    schemaVersion: "memory-reclassification-schema-v1",
    userId
  });
  const classifiedAt = new Date(completedAt.getTime() + 1);
  const updated = await prisma.memoryFactVersion.updateMany({
    data: {
      safetyClassificationReasonCode: "allowed",
      safetyClassificationState: "CLASSIFIED",
      safetyClassifiedAt: classifiedAt,
      safetyClassifierExecutionId: executionId,
      safetyClassifierModelId: "memory-synthesis-stateful-model",
      safetyClassifierPolicyVersion: "memory-reclassification-policy-v1",
      safetyClassifierProviderId: "openai_compatible"
    },
    where: { id: { in: [...versionIds] }, userId }
  });
  expect(updated.count).toBe(versionIds.length);
}

async function attachDirectMessage(
  userId: string,
  versionId: string,
  index: number,
  client: Pick<Prisma.TransactionClient, "chat" | "message" | "memoryEvidence"> = prisma
): Promise<void> {
  const statement = `I use the review workflow step ${index} every week.`;
  const observedAt = new Date();
  const chat = await client.chat.create({
    data: { title: "Memory synthesis evidence", userId }
  });
  const message = await client.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(statement),
      createdAt: observedAt,
      role: "user",
      status: "complete",
      updatedAt: observedAt
    }
  });
  await client.chat.update({
    data: { activeLeafMessageId: message.id, memorySourceRevision: 1 },
    where: { id: chat.id }
  });
  const sourceHash = memorySha256(statement);
  await client.memoryEvidence.create({
    data: {
      branchGeneration: 0,
      chatId: chat.id,
      evidenceFingerprint: memorySha256({
        domain: "aiqsa.test.memory-synthesis-message-evidence",
        messageId: message.id,
        versionId
      }),
      factVersionId: versionId,
      messageId: message.id,
      observedAt,
      safeExcerpt: statement,
      safeSourceHash: sourceHash,
      safetyClass: "NORMAL",
      sourceEndOffset: statement.length,
      sourceMessageContentHash: sourceHash,
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceRole: "user",
      sourceStartOffset: 0,
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId
    }
  });
}

async function createScheduleSources(
  userId: string,
  withPlan: boolean,
  sourceCount = 3,
  confidence = 1,
  sourceMode: "EXPLICIT" | "AUTOMATIC" = "EXPLICIT"
): Promise<readonly { factId: string; versionId: string }[]> {
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  const facts = createPrismaMemoryFactRepository(keyring, prisma, {
    consumeExplicitAuthorization: async () => undefined
  });
  const sources: Array<{ factId: string; versionId: string }> = [];
  for (let index = 0; index < sourceCount; index += 1) {
    sources.push(sourceMode === "AUTOMATIC"
      ? await createAutomaticScheduleSource(userId, scope.id, index, confidence)
      : await facts.save(userId, sourceInput({
          confidence, index, observedAt: new Date(), scopeId: scope.id
        })));
  }
  await classifySources(userId, sources.map(({ versionId }) => versionId));
  if (withPlan) {
    for (const [index, source] of sources.entries()) {
      if (sourceMode === "EXPLICIT") await attachDirectMessage(userId, source.versionId, index);
    }
    const entityId = `memory-synthesis-entity-${randomUUID()}`;
    await prisma.memoryEntity.create({
      data: {
        canonicalKey: `workflow:${randomUUID()}`,
        displayName: "Review workflow",
        entityType: "workflow",
        id: entityId,
        languageCode: "en",
        userId
      }
    });
    await prisma.memoryFactVersionEntity.createMany({
      data: sources.map(({ versionId }) => ({
        confidence: 1,
        entityId,
        factVersionId: versionId,
        role: "SUBJECT" as const,
        userId
      }))
    });
    if (sourceMode === "AUTOMATIC") {
      await withLockedMemoryTransaction(prisma, userId, async (tx, settings) => {
        await ensureActiveLexicalGeneration(tx, settings, settings.memoryRevision);
        for (const { versionId } of sources) {
          await ensureClassifiedSearchEntry(tx, settings, versionId, memorySha256(versionId), new Date());
        }
      });
    }
  }
  return sources;
}

/** Direct synthetic testimony with no owner-save/edit lineage. A genuine
 * automatic fixture is needed to exercise UI collapsing of unprotected facts. */
async function createAutomaticScheduleSource(
  userId: string, scopeId: string, index: number, confidence = 1
): Promise<{ factId: string; versionId: string }> {
  const factId = randomUUID(), versionId = randomUUID(), eventId = randomUUID();
  const observedAt = new Date();
  const statement = `I use the review workflow step ${index} every week.`;
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: {
      id: factId, userId, scopeId, canonicalKey: `automatic-synthesis:${factId}`,
      category: "habits", currentVersionId: versionId
    } });
    await tx.memoryEvent.create({ data: {
      id: eventId, userId, factId, factVersionId: versionId,
      actorType: "JOB", operation: "PROMOTE"
    } });
    await tx.memoryFactVersion.create({ data: {
      id: versionId, userId, factId, createdByEventId: eventId,
      category: "habits", displayText: statement,
      normalizedSearchText: normalizeMemorySearchText(statement),
      structuredValue: { kind: "habit", step: index }, languageCode: "en",
      modality: "HABIT", sourceMode: "AUTOMATIC", directness: "DIRECT",
      confidence, importance: 0.7, sensitivityClass: "NORMAL", observedAt,
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      ingestionFingerprint: memorySha256({ factId, versionId }),
      ...memorySafetyLiteFactClassification(observedAt)
    } });
    // vNext source authority is a deferred transaction invariant: exact source
    // message/span evidence must exist before the fact transaction commits.
    await attachDirectMessage(userId, versionId, index, tx);
  });
  return { factId, versionId };
}

function claimFromJob(job: Awaited<ReturnType<typeof prisma.memoryJob.update>>): MemoryJobClaim {
  if (!job.leaseToken || !job.leaseExpiresAt) {
    throw new Error("memory_synthesis_test_claim_missing");
  }
  return {
    activeLeafMessageId: job.activeLeafMessageId,
    attemptCount: job.attemptCount,
    branchGeneration: job.branchGeneration,
    chatId: job.chatId,
    claimToken: job.leaseToken,
    id: job.id,
    idempotencyFingerprint: job.idempotencyFingerprint,
    kind: job.kind,
    leaseExpiresAt: job.leaseExpiresAt,
    memoryGenerationSnapshot: job.memoryGenerationSnapshot,
    memoryRevisionSnapshot: job.memoryRevisionSnapshot,
    pipelineVersion: job.pipelineVersion,
    recoveredLease: false,
    sourceHash: job.sourceHash,
    sourceMessageId: job.sourceMessageId,
    sourceRevision: job.sourceRevision,
    stage: job.stage,
    targetFactVersionId: job.targetFactVersionId,
    userId: job.userId
  };
}

async function applySyntheticProposals(
  userId: string,
  plan: MemorySynthesisPlan,
  proposals: readonly Readonly<{
    claims?: readonly Readonly<{ sourceRefs: readonly string[]; statement: string }>[];
    sourceRefs: readonly string[];
    statement: string;
  }>[],
  reasonCode: MemorySynthesisReasonCode = "combined_overlapping_facts"
): Promise<Readonly<{
  applied: number;
  claim: MemoryJobClaim;
  result: {
    acceptedOutputHash: string;
    executionId: string;
    inputHash: string;
    modelId: string;
    output: ReturnType<typeof decodeMemorySynthesisOutput>;
    policyVersion: string;
    providerId: string;
  };
}>> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const now = new Date();
  const job = await prisma.memoryJob.create({
    data: {
      attemptCount: 1,
      idempotencyFingerprint: memorySynthesisJobFingerprint({
        sourceSetFingerprint: plan.sourceSetFingerprint,
        userId
      }),
      kind: "SYNTHESIZE_MEMORIES",
      leaseExpiresAt: new Date(now.getTime() + 120_000),
      leaseToken: randomUUID(),
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
      state: "CLAIMED",
      userId
    }
  });
  const claim = claimFromJob(job);
  const output = decodeMemorySynthesisOutput({
    patterns: proposals.map(({ claims, sourceRefs, statement }) => ({
      ...(claims ? { claims: claims.map((claim) => ({
        source_refs: claim.sourceRefs, statement: claim.statement
      })) } : {}),
      confidence_band: "HIGH",
      entity_refs: [],
      reason_code: reasonCode,
      source_refs: sourceRefs,
      statement
    }))
  }, plan);
  const inputHash = memorySynthesisInputHash(plan);
  const acceptedOutputHash = memorySynthesisAcceptedOutputHash(inputHash, output);
  const executionId = await createSucceededJobBinding({
    acceptedOutputHash,
    inputHash,
    jobId: claim.id,
    logicalRole: "MEMORY_SYNTHESIZE",
    pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
    policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
    promptVersion: MEMORY_SYNTHESIS_PROMPT_VERSION,
    schemaVersion: "memory-synthesis-schema-v4",
    userId
  });
  const result = {
    acceptedOutputHash,
    executionId,
    inputHash,
    modelId: "memory-synthesis-stateful-model",
    output,
    policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
    providerId: "openai_compatible"
  };
  const repository = createPrismaMemorySynthesisRepository(prisma, keyring);
  const applied = await prisma.$transaction((tx) =>
    repository.apply(tx, claim, plan, result, now));
  return { applied, claim, result };
}

async function processLexicalRebuild(
  jobId: string,
  repository: ReturnType<typeof createPrismaMemoryRebuildRepository>
): Promise<void> {
  const now = new Date();
  const row = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      leaseToken: `memory-synthesis-rebuild-${randomUUID()}`,
      state: "CLAIMED"
    },
    where: { id: jobId }
  });
  const claim = claimFromJob(row);
  const handler = createMemoryRebuildHandler(repository);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const result = await handler.execute(claim, {
    now: () => now,
    setStage: async () => undefined,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
}

async function patternAuthority(userId: string, versionId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::integer AS count
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = version."userId"
    WHERE version."userId" = ${userId}
      AND version."id" = ${versionId}
      AND ${memorySynthesisPatternAuthorityPredicate(userId)}
  `);
  return rows[0]?.count ?? 0;
}

describe("Prisma Memory Dream synthesis", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records a no-plan evaluation and reconsiders all sources after new activity", async () => {
    const userId = await createOwner();
    try {
      const originalSources = await createScheduleSources(userId, false);
      const firstNow = new Date(Date.now() + 26 * 60 * 60 * 1_000);
      await expect(loadMemorySynthesisScheduleStatus(prisma, userId, firstNow))
        .resolves.toMatchObject({ decision: { due: true } });
      expect(await reconcileMemorySynthesisWork(prisma, firstNow, async () => true))
        .toMatchObject({ scheduled: 0 });
      expect((await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .lastSynthesisAt).toEqual(firstNow);

      const transaction = vi.spyOn(prisma, "$transaction");
      const authority = vi.fn(async () => true);
      try {
        await expect(loadMemorySynthesisScheduleStatus(prisma, userId, firstNow))
          .resolves.toMatchObject({ decision: { due: false, reason: "NO_NEW_ACTIVITY" } });
        expect(await reconcileMemorySynthesisWork(prisma, firstNow, authority))
          .toMatchObject({ scheduled: 0 });
        expect(authority).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }

      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const facts = createPrismaMemoryFactRepository(keyring, prisma, {
        consumeExplicitAuthorization: async () => undefined
      });
      const newSource = await facts.save(userId, sourceInput({
        index: 3,
        observedAt: new Date(firstNow.getTime() + 60_000),
        scopeId: scope.id
      }));
      await classifySources(userId, [newSource.versionId]);
      for (const [index, source] of [...originalSources, newSource].entries()) {
        await attachDirectMessage(userId, source.versionId, index);
      }
      await prisma.memoryFactVersion.update({
        data: { createdAt: new Date(firstNow.getTime() + 60_000) },
        where: { id: newSource.versionId }
      });
      const entityId = `memory-synthesis-entity-${randomUUID()}`;
      await prisma.memoryEntity.create({
        data: {
          canonicalKey: `workflow:${randomUUID()}`,
          displayName: "Review workflow",
          entityType: "workflow",
          id: entityId,
          languageCode: "en",
          userId
        }
      });
      await prisma.memoryFactVersionEntity.createMany({
        data: [...originalSources, newSource].map(({ versionId }) => ({
          confidence: 1,
          entityId,
          factVersionId: versionId,
          role: "SUBJECT" as const,
          userId
        }))
      });
      const nextNow = new Date(firstNow.getTime() + 26 * 60 * 60 * 1_000);
      await expect(loadMemorySynthesisScheduleStatus(prisma, userId, nextNow))
        .resolves.toMatchObject({
          activity: { changedFactCount: 1, eligibleSourceCount: 4 },
          decision: { due: true, reason: "LOW_ACTIVITY_FALLBACK" }
        });
      const snapshot = await loadMemorySynthesisSnapshot(prisma, userId);
      expect(snapshot?.plan?.sources).toHaveLength(4);
      expect(await reconcileMemorySynthesisWork(prisma, nextNow, async () => true))
        .toMatchObject({ scheduled: 1 });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("moves 24 owners without plans out of the scheduling window", async () => {
    const ownerIds: string[] = [];
    try {
      for (let index = 0; index < 25; index += 1) {
        const userId = await createOwner();
        ownerIds.push(userId);
        await createScheduleSources(userId, index === 24);
      }
      const now = new Date(Date.now() + 26 * 60 * 60 * 1_000);
      expect(await reconcileMemorySynthesisWork(prisma, now, async () => true))
        .toMatchObject({ scheduled: 0 });
      expect(await prisma.userMemorySettings.count({
        where: { userId: { in: ownerIds }, lastSynthesisAt: now }
      })).toBe(24);
      expect(await reconcileMemorySynthesisWork(prisma, now, async () => true))
        .toMatchObject({ scheduled: 1 });
      expect(await prisma.memoryJob.count({
        where: { kind: "SYNTHESIZE_MEMORIES", userId: ownerIds[24] }
      })).toBe(1);
    } finally {
      for (const userId of ownerIds) await cleanupOwner(userId);
    }
  });

  it("does not count three explicit facts from one user message as independent roots", async () => {
    const userId = await createOwner();
    try {
      const sources = await createScheduleSources(userId, false);
      const entityId = `memory-synthesis-entity-${randomUUID()}`;
      await prisma.memoryEntity.create({
        data: {
          canonicalKey: `workflow:${randomUUID()}`,
          displayName: "Shared workflow",
          entityType: "workflow",
          id: entityId,
          languageCode: "en",
          userId
        }
      });
      await prisma.memoryFactVersionEntity.createMany({
        data: sources.map(({ versionId }) => ({
          confidence: 1,
          entityId,
          factVersionId: versionId,
          role: "SUBJECT" as const,
          userId
        }))
      });
      const text = "I use review workflow steps zero, one, and two every week.";
      const sourceHash = memorySha256(text);
      const chat = await prisma.chat.create({ data: { title: "Shared source", userId } });
      const message = await prisma.message.create({
        data: { chatId: chat.id, content: textMessageContent(text), role: "user" }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: message.id, memorySourceRevision: 1 },
        where: { id: chat.id }
      });
      await prisma.memoryEvidence.createMany({
        data: sources.map(({ versionId }) => ({
          branchGeneration: 0,
          chatId: chat.id,
          evidenceFingerprint: memorySha256({ messageId: message.id, versionId }),
          factVersionId: versionId,
          messageId: message.id,
          observedAt: message.createdAt,
          safeExcerpt: text,
          safeSourceHash: sourceHash,
          safetyClass: "NORMAL" as const,
          sourceEndOffset: text.length,
          sourceMessageContentHash: sourceHash,
          sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
          sourceRole: "user",
          sourceStartOffset: 0,
          sourceType: "MESSAGE" as const,
          stance: "SUPPORTS" as const,
          userId
        }))
      });
      const plan = (await loadMemorySynthesisSnapshot(prisma, userId))?.plan;
      expect(plan?.clusters).toHaveLength(1);
      if (!plan) throw new Error("memory_synthesis_episode_plan_missing");
      const refs = plan.sources.map(({ ref }) => ref);
      expect(() => decodeMemorySynthesisOutput({ patterns: [{
        confidence_band: "HIGH", entity_refs: [], reason_code: "repeated_workflow_pattern",
        source_refs: refs, statement: "The user tends to follow this workflow."
      }] }, plan)).toThrow();
      const claims = plan.sources.slice(0, 2).map((source) => ({
        sourceRefs: [source.ref], statement: source.displayText
      }));
      expect((await applySyntheticProposals(userId, plan, [{
        claims, sourceRefs: refs.slice(0, 2), statement: claims.map(({ statement }) => statement).join(" ")
      }], "combined_episode_facts")).applied).toBe(1);
      const projection = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { modality: "PATTERN", userId }
      });
      expect(projection.structuredValue).toMatchObject({
        claims: claims.map((claim) => ({
          sourceVersionIds: [plan.sources.find(({ ref }) => ref === claim.sourceRefs[0])!.versionId],
          statement: claim.statement
        })),
        reasonCode: "combined_episode_facts"
      });
      expect(await prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_synthesis_claims_valid(${userId}, ${projection.id}) AS valid
      `)).toEqual([{ valid: true }]);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("persists a pairwise display combination while retaining both direct sources", async () => {
    const userId = await createOwner();
    try {
      const sources = await createScheduleSources(userId, true, 2, 0.6);
      const plan = (await loadMemorySynthesisSnapshot(prisma, userId))?.plan;
      if (!plan) throw new Error("memory_synthesis_pair_plan_missing");
      const applied = await applySyntheticProposals(userId, plan, [{
        sourceRefs: plan.sources.map(({ ref }) => ref), statement: "The user follows a weekly review workflow."
      }]);
      expect(applied.applied).toBe(1);
      expect(await prisma.memoryFact.count({ where: {
        id: { in: sources.map(({ factId }) => factId) }, state: "ACTIVE", userId
      } })).toBe(2);
      const projection = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { modality: "PATTERN", userId }
      });
      expect(projection.confidence).toBe(0.6);
      expect(await loadMemoryReusableFactVersionIds(prisma, userId, [projection.id], {
        includePatterns: true
      })).toEqual(new Set([projection.id]));
      const protectedList = await createPrismaExplicitMemoryRepository(prisma).list(userId, {
        scope: { type: "GLOBAL_USER" }, state: "ACTIVE"
      });
      expect(protectedList.memories.map(({ id }) => id))
        .toEqual(expect.arrayContaining(sources.map(({ factId }) => factId)));
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("keeps disjoint conclusions and replaces only a conclusion with shared facts", async () => {
    const userId = await createOwner();
    try {
      const sources = await createScheduleSources(userId, true, 6, 1, "AUTOMATIC");
      const initialPlan = (await loadMemorySynthesisSnapshot(prisma, userId))?.plan;
      if (!initialPlan) throw new Error("memory_synthesis_overlap_plan_missing");
      const refs = new Map(initialPlan.sources.map(({ factId, ref }) => [factId, ref]));
      const group = (entries: readonly { factId: string }[]) =>
        entries.map(({ factId }) => refs.get(factId)!);
      const first = await applySyntheticProposals(userId, initialPlan, [
        { sourceRefs: group(sources.slice(0, 3)), statement: "I use a weekly review workflow." },
        { sourceRefs: group(sources.slice(3, 6)), statement: "I follow a weekly review workflow." }
      ]);
      expect(first.applied).toBe(2);
      const readRepository = createPrismaExplicitMemoryRepository(prisma);
      const firstPage = await readRepository.list(userId, {
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        state: "ACTIVE"
      });
      expect(firstPage.memories).toHaveLength(1);
      expect(firstPage.memories[0]?.modality).toBe("PATTERN");
      expect(firstPage.memories[0]?.combinedSources).toHaveLength(3);
      expect(await readRepository.getEditable(userId, firstPage.memories[0]!.id))
        .toBeNull();
      expect(firstPage.nextCursor).not.toBeNull();
      const nextPage = await readRepository.list(userId, {
        cursor: firstPage.nextCursor,
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        state: "ACTIVE"
      });
      expect(nextPage.memories).toHaveLength(1);
      expect(nextPage.memories[0]?.combinedSources).toHaveLength(3);
      expect(nextPage.nextCursor).toBeNull();
      expect(new Set(firstPage.memories.concat(nextPage.memories).map(({ id }) => id)).size)
        .toBe(2);
      await prisma.userMemorySettings.update({
        data: { useMemoryFacts: false, learnAutomatically: false }, where: { userId }
      });
      try {
        const pausedList = await readRepository.list(userId, {
          scope: { type: "GLOBAL_USER" }, state: "ACTIVE"
        });
        expect(pausedList.memories).toHaveLength(2);
        expect(pausedList.memories.every((item) => item.combinedSources?.length === 3))
          .toBe(true);
        expect(await patternAuthority(userId, firstPage.memories[0]!.currentVersionId!))
          .toBe(0);
      } finally {
        await prisma.userMemorySettings.update({
          data: { useMemoryFacts: true, learnAutomatically: true }, where: { userId }
        });
      }
      expect((await readRepository.list(userId, {
        includePatterns: false,
        scope: { type: "GLOBAL_USER" },
        state: "ACTIVE"
      })).memories).toHaveLength(6);
      const sourceOnlySearch = await readRepository.search(userId, {
        query: "step 0",
        scope: { type: "GLOBAL_USER" },
        state: "ACTIVE"
      });
      expect(sourceOnlySearch.memories.some(({ id }) => id === sources[0]!.factId))
        .toBe(true);
      const before = await prisma.memoryFactVersion.findMany({
        where: { modality: "PATTERN", state: "ACTIVE", userId }
      });
      expect(before).toHaveLength(2);
      const firstPattern = before.find(({ displayText }) =>
        displayText === "I use a weekly review workflow.");
      const secondPattern = before.find(({ displayText }) =>
        displayText === "I follow a weekly review workflow.");
      if (!firstPattern || !secondPattern) {
        throw new Error("memory_synthesis_overlap_patterns_missing");
      }
      expect(firstPattern.factId).not.toBe(secondPattern.factId);

      const current = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      expect(await prisma.$transaction((tx) =>
        createPrismaMemorySynthesisRepository(prisma, keyring).apply(
          tx,
          { ...first.claim, memoryRevisionSnapshot: current.memoryRevision },
          initialPlan,
          first.result,
          new Date()
        ))).toBe(0);

      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const newSource = await createPrismaMemoryFactRepository(keyring, prisma, {
        consumeExplicitAuthorization: async () => undefined
      }).save(userId, sourceInput({ index: 6, observedAt: new Date(), scopeId: scope.id }));
      await classifySources(userId, [newSource.versionId]);
      await attachDirectMessage(userId, newSource.versionId, 6);
      const subject = await prisma.memoryFactVersionEntity.findFirstOrThrow({
        select: { entityId: true },
        where: { factVersionId: sources[0]!.versionId, role: "SUBJECT", userId }
      });
      await prisma.memoryFactVersionEntity.create({
        data: {
          confidence: 1,
          entityId: subject.entityId,
          factVersionId: newSource.versionId,
          role: "SUBJECT",
          userId
        }
      });
      const expandedPlan = (await loadMemorySynthesisSnapshot(prisma, userId))?.plan;
      if (!expandedPlan) throw new Error("memory_synthesis_expanded_plan_missing");
      const expandedRefs = new Map(expandedPlan.sources.map(({ factId, ref }) => [factId, ref]));
      expect((await applySyntheticProposals(userId, expandedPlan, [{
        sourceRefs: [sources[0]!, sources[1]!, newSource]
          .map(({ factId }) => expandedRefs.get(factId)!),
        statement: "I use a weekly review workflow with recurring steps."
      }])).applied).toBe(1);
      expect((await prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: firstPattern.id }
      })).state).toBe("RETRACTED");
      expect((await prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: secondPattern.id }
      })).state).toBe("ACTIVE");
      expect(await prisma.memoryFactVersion.count({
        where: { modality: "PATTERN", state: "ACTIVE", userId }
      })).toBe(2);

      const newest = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { id: { not: secondPattern.id }, modality: "PATTERN", state: "ACTIVE", userId }
      });
      const newestFact = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: newest.factId }
      });
      await withLockedMemoryTransaction(prisma, userId, async (tx, settings) => {
        await createMemorySuppressionInTransaction(tx, settings, keyring, {
          canonicalKey: newestFact.canonicalKey,
          explicitOverrideAllowed: false,
          scope: "FACT",
          suppressionId: randomUUID()
        });
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED", systemTo: new Date() },
          where: { id: newest.id }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: null, forgottenAt: new Date(), state: "FORGOTTEN" },
          where: { id: newest.factId }
        });
      });
      const beforeRetry = await prisma.memoryFactVersion.count({
        where: { factId: newest.factId, userId }
      });
      expect(beforeRetry).toBe(1);
      const afterForget = (await loadMemorySynthesisSnapshot(prisma, userId))?.plan;
      if (!afterForget) throw new Error("memory_synthesis_forget_plan_missing");
      const afterForgetRefs = new Map(afterForget.sources.map(({ factId, ref }) => [factId, ref]));
      expect((await applySyntheticProposals(userId, afterForget, [{
        sourceRefs: [sources[0]!, sources[1]!, newSource]
          .map(({ factId }) => afterForgetRefs.get(factId)!),
        statement: "I use a weekly review workflow with recurring steps."
      }])).applied).toBe(0);
      expect(await prisma.memoryFactVersion.count({
        where: { factId: newest.factId, userId }
      })).toBe(1);
      expect((await prisma.memoryFact.findUniqueOrThrow({
        where: { id: newest.factId }
      })).state).toBe("FORGOTTEN");
      expect((await prisma.memoryFact.findUniqueOrThrow({
        where: { id: secondPattern.factId }
      })).state).toBe("ACTIVE");
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("keeps PostgreSQL source eligibility hashing byte-identical to TypeScript", async () => {
    const observedAt = new Date("2026-08-25T01:02:03.456Z");
    const input = {
      canonicalKey: "workflow:\"escaped\"",
      directness: "DIRECT" as const,
      factId: "fact-hash",
      ingestionFingerprint: null,
      memoryGeneration: 7,
      modality: "WORKFLOW" as const,
      observedAt,
      pipelineVersion: "memory-hash-test-v1",
      sourceMode: "EXPLICIT" as const,
      versionId: "version-hash"
    };
    const [row] = await prisma.$queryRaw<Array<{ value: string }>>(Prisma.sql`
      SELECT aiqsa_memory_synthesis_source_eligibility_hash(
        ${input.canonicalKey},
        ${input.directness},
        ${input.factId},
        ${input.ingestionFingerprint}::text,
        ${input.memoryGeneration}::integer,
        ${input.modality},
        (${input.observedAt}::timestamptz AT TIME ZONE 'UTC'),
        ${input.pipelineVersion},
        ${input.sourceMode},
        ${input.versionId}
      ) AS value
    `);
    expect(row?.value).toBe(memorySynthesisSourceEligibilityHash(input));
  });

  it("admits only post-creation evidence for synthesis without a preference save", async () => {
    const userId = await createOwner();
    try {
      const initial = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      expect(initial).toMatchObject({ synthesisEnabled: true, synthesisPolicyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
        settingsRevision: 0, lastSynthesisAt: null });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const facts = createPrismaMemoryFactRepository(keyring, prisma, { consumeExplicitAuthorization: async () => undefined });
      await facts.save(userId, sourceInput({ index: 0, scopeId: scope.id,
        observedAt: new Date(initial.synthesisEnabledAt!.getTime() - 1_000) }));
      for (let index = 1; index <= 3; index += 1) {
        await facts.save(userId, sourceInput({ index, scopeId: scope.id, observedAt: new Date() }));
      }
      await expect(loadMemorySynthesisScheduleStatus(prisma, userId, new Date())).resolves.toMatchObject({
        activity: { eligibleSourceCount: 3 }
      });
      expect((await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } })).settingsRevision).toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E06] synthesizes, retrieves, invalidates, and replaces a source-bound pattern", async () => {
    const userId = await createOwner();
    const embeddingConnectionId = `memory-synthesis-connection-${randomUUID()}`;
    const embeddingModelId = `memory-synthesis-model-${randomUUID()}`;
    try {
      const base = new Date(Date.now() - 60 * 60 * 1_000);
      const firstBoundary = new Date(base);
      // This fixture exercises a previously disabled account's first enable.
      await prisma.userMemorySettings.update({ where: { userId }, data: {
        synthesisEnabled: false, synthesisEnabledAt: null, synthesisPolicyVersion: null
      } });
      const firstSettings = createPrismaMemorySettingsRepository(prisma, {
        now: () => new Date(firstBoundary)
      });
      const initial = await firstSettings.get(userId);
      const enabled = await firstSettings.patch(userId, {
        expectedMemoryRevision: initial.memoryRevision,
        expectedSettingsRevision: initial.settingsRevision,
        synthesisEnabled: true
      });
      expect(enabled.synthesisEnabledAt).toEqual(firstBoundary);
      expect(enabled.synthesisPolicyVersion).toBe(MEMORY_SYNTHESIS_POLICY_VERSION);

      const disabled = await createPrismaMemorySettingsRepository(prisma, {
        now: () => new Date(firstBoundary.getTime() + 60_000)
      }).patch(userId, {
        expectedMemoryRevision: enabled.memoryRevision,
        expectedSettingsRevision: enabled.settingsRevision,
        synthesisEnabled: false
      });
      const reenabled = await createPrismaMemorySettingsRepository(prisma, {
        now: () => new Date(firstBoundary.getTime() + 120_000)
      }).patch(userId, {
        expectedMemoryRevision: disabled.memoryRevision,
        expectedSettingsRevision: disabled.settingsRevision,
        synthesisEnabled: true
      });
      expect(reenabled.synthesisEnabledAt).toEqual(firstBoundary);

      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const facts = createPrismaMemoryFactRepository(keyring, prisma, {
        consumeExplicitAuthorization: async () => undefined
      });
      const sources = [] as Array<Readonly<{ factId: string; versionId: string }>>;
      sources.push(await facts.save(userId, sourceInput({
        index: 0,
        observedAt: new Date(firstBoundary.getTime() - 60_000),
        scopeId: scope.id
      })));
      for (let index = 1; index <= 20; index += 1) {
        sources.push(await facts.save(userId, sourceInput({
          index,
          observedAt: new Date(firstBoundary.getTime() + (index + 5) * 60_000),
          scopeId: scope.id
        })));
      }
      const missingReceipt = await facts.save(userId, sourceInput({
        index: 21,
        observedAt: new Date(firstBoundary.getTime() + 30 * 60_000),
        scopeId: scope.id
      }));
      sources.push(missingReceipt);
      await prisma.memoryOperationReceipt.deleteMany({
        where: { targetVersionId: missingReceipt.versionId, userId }
      });

      const entityId = `memory-synthesis-entity-${randomUUID()}`;
      await prisma.memoryEntity.create({
        data: {
          canonicalKey: `workflow:${randomUUID()}`,
          displayName: "Weekly review workflow",
          entityType: "workflow",
          id: entityId,
          languageCode: "en",
          userId
        }
      });
      await prisma.memoryFactVersionEntity.createMany({
        data: sources.map((source) => ({
          confidence: 1,
          entityId,
          factVersionId: source.versionId,
          role: "SUBJECT" as const,
          userId
        }))
      });
      await classifySources(userId, sources.map(({ versionId }) => versionId));
      for (let index = 1; index <= 20; index += 1) {
        await attachDirectMessage(userId, sources[index]!.versionId, index);
      }

      const snapshot = await loadMemorySynthesisSnapshot(prisma, userId);
      const plan = snapshot?.plan;
      expect(plan).not.toBeNull();
      if (!plan) throw new Error("memory_synthesis_test_plan_missing");
      expect(plan.sources).toHaveLength(20);
      expect(plan.sources.map(({ versionId }) => versionId)).not.toContain(
        sources[0]!.versionId
      );
      expect(plan.sources.map(({ versionId }) => versionId)).not.toContain(
        missingReceipt.versionId
      );
      expect(plan.clusters[0]?.sources).toHaveLength(20);
      const providerPayload = buildMemorySynthesisRequest(plan).userPrompt;
      expect(providerPayload).not.toContain(userId);
      expect(providerPayload).not.toContain(entityId);
      for (const source of plan.sources) {
        expect(providerPayload).not.toContain(source.factId);
        expect(providerPayload).not.toContain(source.versionId);
        for (const chatId of source.sourceChatIds) {
          expect(providerPayload).not.toContain(chatId);
        }
        for (const messageId of source.sourceMessageIds) {
          expect(providerPayload).not.toContain(messageId);
        }
      }

      const cadenceNow = new Date(Date.now() + MEMORY_SYNTHESIS_QUIET_PERIOD_MS + 1);
      await expect(loadMemorySynthesisScheduleStatus(
        prisma,
        userId,
        new Date()
      )).resolves.toMatchObject({
        activity: { changedFactCount: 20, eligibleSourceCount: 20 },
        decision: { due: false, reason: "QUIET_PERIOD" }
      });
      await expect(loadMemorySynthesisScheduleStatus(
        prisma,
        userId,
        cadenceNow
      )).resolves.toMatchObject({
        activity: { changedFactCount: 20, eligibleSourceCount: 20 },
        decision: { due: true, reason: "CHAT_ACTIVITY" }
      });
      const deniedReconcile = await reconcileMemorySynthesisWork(
        prisma,
        cadenceNow,
        async () => false
      );
      expect(deniedReconcile.scheduled).toBe(0);
      const firstReconcile = await reconcileMemorySynthesisWork(
        prisma,
        cadenceNow,
        async () => true
      );
      expect(firstReconcile.scheduled).toBe(1);
      const secondReconcile = await reconcileMemorySynthesisWork(
        prisma,
        cadenceNow,
        async () => true
      );
      expect(secondReconcile.scheduled).toBe(0);
      const queued = await prisma.memoryJob.findFirstOrThrow({
        where: { kind: "SYNTHESIZE_MEMORIES", userId }
      });
      expect(queued.idempotencyFingerprint).toBe(memorySynthesisJobFingerprint({
        sourceSetFingerprint: plan.sourceSetFingerprint,
        userId
      }));

      const leaseToken = `memory-synthesis-lease-${randomUUID()}`;
      const claimedRow = await prisma.memoryJob.update({
        data: {
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 120_000),
          leaseToken,
          state: "CLAIMED"
        },
        where: { id: queued.id }
      });
      const claim = claimFromJob(claimedRow);
      const cluster = plan.clusters[0]!;
      const output = decodeMemorySynthesisOutput({
        patterns: [
          {
            confidence_band: "HIGH",
            entity_refs: cluster.entityRefs.slice(0, 1),
            reason_code: "repeated_workflow_pattern",
            source_refs: cluster.sources.slice(0, 4).map(({ ref }) => ref),
            statement: "The user tends to follow a recurring weekly review workflow."
          },
          {
            confidence_band: "HIGH",
            entity_refs: cluster.entityRefs.slice(0, 1),
            reason_code: "repeated_habit_pattern",
            source_refs: cluster.sources.slice(0, 3).map(({ ref }) => ref),
            statement: "The user often repeats the same weekly review steps."
          }
        ]
      }, plan);
      const inputHash = memorySynthesisInputHash(plan);
      const acceptedOutputHash = memorySynthesisAcceptedOutputHash(inputHash, output);
      const executionId = await createSucceededJobBinding({
        acceptedOutputHash,
        inputHash,
        jobId: claim.id,
        logicalRole: "MEMORY_SYNTHESIZE",
        pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
        policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
        promptVersion: MEMORY_SYNTHESIS_PROMPT_VERSION,
        schemaVersion: "memory-synthesis-schema-v4",
        userId
      });
      const result = {
        acceptedOutputHash,
        executionId,
        inputHash,
        modelId: "memory-synthesis-stateful-model",
        output,
        policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
        providerId: "openai_compatible"
      };
      const repository = createPrismaMemorySynthesisRepository(prisma, keyring);
      await repository.stage(claim, plan, result);
      const applyAt = new Date();
      let appliedPatternCount: number | null = null;
      await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
        acceptedResultHash: result.acceptedOutputHash,
        apply: async (tx, exactClaim) => {
          appliedPatternCount = await repository.apply(
            tx,
            exactClaim,
            plan,
            result,
            applyAt
          );
        },
        claim,
        now: applyAt,
        stage: "authorized_apply"
      })).resolves.toBe(true);
      expect(appliedPatternCount).toBe(2);

      const patterns = await prisma.memoryFactVersion.findMany({
        orderBy: { displayText: "asc" },
        where: { modality: "PATTERN", userId }
      });
      expect(patterns).toHaveLength(2);
      const patternFacts = await prisma.memoryFact.findMany({
        select: { canonicalKey: true, identityVersion: true },
        where: { category: "patterns", userId }
      });
      expect(patternFacts).toHaveLength(2);
      expect(patternFacts.every((fact) =>
        fact.identityVersion === "proposition-v2" &&
        /^prop:v2:[a-f0-9]{64}$/u.test(fact.canonicalKey)))
        .toBe(true);
      const [identityMappings] = await prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`
          SELECT COUNT(*) AS count
          FROM "MemoryIdentityCompatibility"
          WHERE "userId" = ${userId} AND "namespace" = 'FACT'
        `
      );
      expect(identityMappings?.count).toBe(0n);
      const pattern = patterns.find(({ displayText }) =>
        displayText?.includes("recurring weekly review"));
      const shortPattern = patterns.find(({ displayText }) =>
        displayText?.includes("same weekly review steps"));
      if (!pattern || !shortPattern) throw new Error("memory_synthesis_test_pattern_missing");
      expect(pattern).toMatchObject({
        directness: "INFERRED",
        ingestionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierProviderId: null,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE",
        synthesisDepth: 1,
        synthesisGeneration: snapshot.settings.memoryGeneration,
        synthesisSourceSetFingerprint: plan.sourceSetFingerprint
      });
      expect(await prisma.memorySearchEntry.count({
        where: { factVersionId: pattern.id, userId }
      })).toBe(1);
      await expect(reconcileMemorySynthesisWork(
        prisma,
        new Date(applyAt.getTime() + 1),
        async () => true
      )).resolves.toEqual({ invalidated: 0, scheduled: 0 });
      await expect(prisma.memoryFactVersion.count({
        where: {
          id: { in: patterns.map(({ id }) => id) },
          safetyClassificationState: "CLASSIFIED",
          state: "ACTIVE",
          userId
        }
      })).resolves.toBe(2);
      expect(await prisma.memorySearchEntry.count({
        where: { factVersionId: pattern.id, userId }
      })).toBe(1);
      const relations = await prisma.memoryFactVersionRelation.findMany({
        where: {
          kind: "SYNTHESIZED_FROM",
          sourceVersionId: pattern.id,
          userId
        }
      });
      expect(relations).toHaveLength(4);
      expect(relations.every((relation) =>
        relation.executionId === executionId &&
        /^[a-f0-9]{64}$/u.test(relation.sourceEligibilityHash ?? "")
      )).toBe(true);
      const supportVersions = await prisma.memoryFactVersion.findMany({
        select: {
          displayText: true,
          id: true,
          observedAt: true,
          sourceMode: true
        },
        where: {
          id: { in: relations.map(({ targetVersionId }) => targetVersionId) },
          userId
        }
      });
      const supportVersionById = new Map(supportVersions.map((version) =>
        [version.id, version]));
      const patternSupportingEvidence = relations.map((relation) => {
        const support = supportVersionById.get(relation.targetVersionId);
        if (!support?.displayText || !support.observedAt || support.sourceMode !== "EXPLICIT") {
          throw new Error("memory_synthesis_test_pattern_support_missing");
        }
        return {
          factVersionId: support.id,
          observedAt: support.observedAt.toISOString(),
          sourceAuthority: "user_saved" as const,
          sourceRootHash: memorySha256(`explicit:${support.id}`),
          textHash: memorySha256(support.displayText.normalize("NFKC")
            .replace(/\s+/gu, " ").trim())
        };
      });
      expect(await patternAuthority(userId, pattern.id)).toBe(1);
      expect(await patternAuthority(userId, shortPattern.id)).toBe(1);
      await expect(loadMemoryReusableFactVersionIds(
        prisma,
        userId,
        [pattern.id]
      )).resolves.toEqual(new Set());
      await expect(loadMemoryReusableFactVersionIds(
        prisma,
        userId,
        [pattern.id],
        { includePatterns: true }
      )).resolves.toEqual(new Set([pattern.id]));
      expect(await prisma.memoryFactVersionEntity.count({
        where: { entityId, factVersionId: { in: [pattern.id, shortPattern.id] }, userId }
      })).toBe(2);

      const indexedAt = new Date(applyAt.getTime() + 10);
      await withLockedMemoryTransaction(prisma, userId, async (tx, settings) => {
        for (const currentPattern of [pattern, shortPattern]) {
          await ensureClassifiedSearchEntry(
            tx,
            settings,
            currentPattern.id,
            `synthesis-pattern-${currentPattern.id}`,
            indexedAt
          );
        }
      });
      let incrementalEntries = await prisma.memorySearchEntry.findMany({
        where: { factVersionId: { in: [pattern.id, shortPattern.id] }, userId }
      });
      expect(incrementalEntries).toHaveLength(2);

      // Direct fixture saves now enqueue relation work. Settle the distinct
      // source facts without a mutation before exercising the rebuild fence.
      const relationJobs = await prisma.memoryJob.findMany({
        where: {
          kind: "RESOLVE_FACT_RELATIONS",
          pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
          state: "QUEUED",
          userId
        }
      });
      expect(relationJobs).toHaveLength(sources.length - 1);
      for (const relationJob of relationJobs) {
        const settledAt = new Date();
        const row = await prisma.memoryJob.update({
          data: {
            attemptCount: { increment: 1 },
            leaseExpiresAt: new Date(settledAt.getTime() + 60_000),
            leaseToken: randomUUID(),
            state: "CLAIMED"
          },
          where: { id: relationJob.id }
        });
        await expect(createPrismaMemoryCoordinatorRepository(prisma)
          .commitJobSuccess({
            acceptedResultHash: memorySha256({
              domain: "memory-synthesis-test-distinct-relations",
              jobId: relationJob.id
            }),
            claim: claimFromJob(row),
            now: settledAt,
            stage: "relations_settled"
          })).resolves.toBe(true);
      }

      const rebuildRepository = createPrismaMemoryRebuildRepository(prisma);
      const beforeRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await rebuildRepository.admit(userId, {
        expectedMemoryRevision: beforeRebuild.memoryRevision,
        expectedSettingsRevision: beforeRebuild.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: `synthesis-pattern-rebuild-${randomUUID()}` }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      await processLexicalRebuild(admitted.jobId, rebuildRepository);

      const afterRebuild = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(afterRebuild).toMatchObject({
        memoryGeneration: beforeRebuild.memoryGeneration,
        memoryRevision: beforeRebuild.memoryRevision + 1
      });
      expect(afterRebuild.activeIndexGenerationId)
        .not.toBe(beforeRebuild.activeIndexGenerationId);
      expect(await patternAuthority(userId, pattern.id)).toBe(1);
      expect(await patternAuthority(userId, shortPattern.id)).toBe(1);
      incrementalEntries = await prisma.memorySearchEntry.findMany({
        where: {
          factVersionId: { in: [pattern.id, shortPattern.id] },
          indexGenerationId: afterRebuild.activeIndexGenerationId!,
          userId
        }
      });
      expect(incrementalEntries.map(({ factVersionId }) => factVersionId).sort())
        .toEqual([pattern.id, shortPattern.id].sort());

      const inventory = await rebuildRepository.inventory(
        userId,
        indexedAt
      );
      expect(inventory).toMatchObject({
        compatibleAutomaticFactVersions: 2,
        incompatibleAutomaticFactVersions: 0
      });

      const consumerChat = await prisma.chat.create({
        data: { title: "Pattern authority consumer", userId }
      });
      const consumerUserMessage = await prisma.message.create({
        data: {
          chatId: consumerChat.id,
          content: textMessageContent("What recurring workflow pattern do I follow?"),
          role: "user",
          status: "complete"
        }
      });
      const consumerAssistantMessage = await prisma.message.create({
        data: {
          chatId: consumerChat.id,
          content: textMessageContent("Here is the relevant Personal Memory pattern."),
          parentMessageId: consumerUserMessage.id,
          role: "assistant",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: consumerAssistantMessage.id },
        where: { id: consumerChat.id }
      });
      const retrieval = createPrismaLocalMemoryRetrievalRepository(prisma);
      const disabledPatternPlan = planMemoryRetrieval({
        currentUserText: pattern.displayText!,
        now: indexedAt
      });
      const enabledPatternPlan = planMemoryRetrieval({
        currentUserText: pattern.displayText!,
        includePatterns: true,
        now: indexedAt
      });
      const disabledResult = await retrieval.retrieve({
        assistantId: null,
        chatId: consumerChat.id,
        now: indexedAt,
        plan: disabledPatternPlan,
        userId
      });
      expect(disabledResult.laneResults.flatMap(({ candidates }) => candidates)
        .map(({ itemId }) => itemId)).not.toContain(pattern.id);
      const enabledResult = await retrieval.retrieve({
        assistantId: null,
        chatId: consumerChat.id,
        now: indexedAt,
        plan: enabledPatternPlan,
        userId
      });
      expect(enabledResult.laneResults.flatMap(({ candidates }) => candidates)
        .map(({ itemId }) => itemId)).toContain(pattern.id);

      const activeSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const frozen = await prisma.$transaction((tx) => resolvePreparingMemoryItem(
        tx,
        {
          assistantId: null,
          chatId: consumerChat.id,
          folderId: null,
          indexGenerationId: activeSettings.activeIndexGenerationId,
          userId
        },
        "What recurring workflow pattern do I follow?",
        {
          exactItemId: pattern.id,
          exactSafeText: pattern.displayText!,
          factVersionId: pattern.id,
          featureSnapshot: {
            directFactAuthority: false,
            historical: false,
            includePatterns: true,
            patternSupportingEvidence,
            retrievalMode: "TARGETED_CURRENT",
            tier: "DYNAMIC"
          },
          finalScore: 0.9,
          itemType: "FACT_VERSION",
          laneRanks: { FACT_EXACT: 1 },
          projectionKind: "FACT_DISPLAY_TEXT",
          selectionReason: "pattern_authority_parity",
          supportingItemId: null
        }
      ));
      expect(frozen).toMatchObject({
        sourceMessageIdsSnapshot: [],
        sourceSnapshot: {
          synthesisRelations: expect.arrayContaining([
            expect.objectContaining({ targetVersionId: relations[0]!.targetVersionId })
          ])
        },
        versionSnapshot: { modality: "PATTERN" }
      });

      const run = await prisma.modelRun.create({
        data: {
          assistantMessageId: consumerAssistantMessage.id,
          chatId: consumerChat.id,
          modelId: "memory-synthesis-answer-model",
          normalizedRequest: {},
          provider: "memory-synthesis-fixture",
          status: "complete",
          userId,
          userMessageId: consumerUserMessage.id
        }
      });
      const query = "What recurring workflow pattern do I follow?";
      const preparedContext = pattern.displayText!;
      const binding = await prisma.$transaction(async (tx) => {
        const attempt = await tx.memoryRetrievalAttempt.create({
          data: {
            admissionKind: "NORMAL_SEND",
            admittedAssistantLeafMessageId: consumerAssistantMessage.id,
            admittedUserMessageId: consumerUserMessage.id,
            attemptOrdinal: 0,
            baseRequestHash: memorySha256({ domain: "memory-synthesis-source-test" }),
            boundedPrivateBaseRequestSnapshot: {},
            boundedSafeQuerySnapshot: query,
            budgetSnapshot: { plan: { includePatterns: true } },
            chatId: consumerChat.id,
            chatMemoryModeSnapshot: "NORMAL",
            consumedAt: indexedAt,
            expiresAt: new Date(indexedAt.getTime() + 60_000),
            indexGenerationIdSnapshot: activeSettings.activeIndexGenerationId,
            memoryGenerationSnapshot: activeSettings.memoryGeneration,
            modelRunId: run.id,
            outcome: "USED",
            preparedContextHash: memorySha256(preparedContext),
            preparedContextText: preparedContext,
            preparedContextTokenCount: 16,
            queryHash: memorySha256(query),
            retrievalRevisionSnapshot: activeSettings.memoryRevision,
            settingsSnapshot: {},
            state: "CONSUMED",
            userId,
            utilityEgressMode: "LOCAL_ONLY"
          }
        });
        const created = await tx.modelRunMemoryBinding.create({
          data: {
            boundedSafeQuerySnapshot: query,
            contextTextHash: memorySha256(preparedContext),
            contextTokenCount: 16,
            finalizedAt: indexedAt,
            finalizedRevisionSnapshot: activeSettings.memoryRevision,
            indexGenerationId: activeSettings.activeIndexGenerationId,
            memoryGenerationSnapshot: activeSettings.memoryGeneration,
            modelRunId: run.id,
            outcome: "USED",
            queryHash: memorySha256(query),
            queryPlannerVersion: "memory-synthesis-test-planner-v1",
            retrievalAttemptId: attempt.id,
            retrievalPipelineVersion: "memory-synthesis-test-retrieval-v1",
            retrievalRevisionSnapshot: activeSettings.memoryRevision,
            settingsSnapshot: {},
            userId
          }
        });
        await tx.modelRunMemoryItem.create({
          data: {
            bindingId: created.id,
            exactItemId: pattern.id,
            factVersionId: pattern.id,
            featureSnapshot: { includePatterns: true, patternSupportingEvidence },
            finalScore: 0.9,
            includedText: pattern.displayText!,
            includedTextHash: memorySha256(pattern.displayText!),
            itemStateAtAdmission: "ACTIVE",
            itemType: "FACT_VERSION",
            laneRanks: { FACT_EXACT: 1 },
            ordinal: 0,
            selectionReason: "pattern_authority_parity",
            sourceMessageIdsSnapshot: [],
            userId
          }
        });
        return created;
      });
      const sourcesByRun = await loadMemoryRunSources(prisma, {
        clientRefs: createMemoryClientRefService({ encryptionKey: () => randomBytes(32) }),
        runIds: [run.id],
        userId
      });
      expect(sourcesByRun.get(run.id)).toEqual([expect.objectContaining({
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
        sourceAvailable: true,
        sourceType: "LEARNED_MEMORY",
        text: pattern.displayText
      })]);
      expect(binding.modelRunId).toBe(run.id);

      const incremental = incrementalEntries.find(({ factVersionId }) =>
        factVersionId === pattern.id)!;
      const activeGeneration = await prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: activeSettings.activeIndexGenerationId! }
      });
      const maximumGeneration = await prisma.memoryIndexGeneration.aggregate({
        _max: { generation: true },
        where: { userId }
      });
      await prisma.providerConnection.create({
        data: {
          displayName: "Memory synthesis embedding fixture",
          family: "openai_compatible",
          id: embeddingConnectionId
        }
      });
      await prisma.providerModel.create({
        data: {
          capabilities: {},
          connectionId: embeddingConnectionId,
          defaultParams: {},
          displayName: "Memory synthesis embedding model",
          id: embeddingModelId,
          modelClass: "embedding",
          modelId: "memory-synthesis-embedding-test",
          provider: "openai_compatible"
        }
      });
      const hybridGeneration = await prisma.$transaction(async (tx) => {
        await tx.memoryIndexGeneration.update({
          data: { state: "SUPERSEDED", supersededAt: indexedAt },
          where: { id: activeGeneration.id }
        });
        const generation = await tx.memoryIndexGeneration.create({
          data: {
            activatedAt: indexedAt,
            chunkingVersion: activeGeneration.chunkingVersion,
            embeddingConfigurationFingerprint: "1".repeat(64),
            embeddingConnectionId,
            embeddingDimension: 1024,
            embeddingProviderModelId: embeddingModelId,
            generation: (maximumGeneration._max.generation ?? 0) + 1,
            indexMode: "HYBRID",
            indexedThroughMemoryRevision: activeSettings.memoryRevision,
            languageProfile: activeGeneration.languageProfile,
            normalizationVersion: activeGeneration.normalizationVersion,
            retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
            readyAt: indexedAt,
            state: "ACTIVE",
            targetMemoryRevision: activeSettings.memoryRevision,
            userId,
            vectorSpaceFingerprint: "2".repeat(64)
          }
        });
        await tx.userMemorySettings.update({
          data: {
            activeIndexGenerationId: generation.id,
            embeddingProviderModelId: embeddingModelId
          },
          where: { userId }
        });
        return generation;
      });
      const hybridEntry = await prisma.memorySearchEntry.create({
        data: {
          embeddingState: "PENDING",
          factVersionId: pattern.id,
          indexGenerationId: hybridGeneration.id,
          itemType: "FACT_VERSION",
          languageCode: incremental.languageCode,
          normalizedSearchText: incremental.normalizedSearchText,
          safeContentHash: incremental.safeContentHash,
          safetyIdentitySnapshot: incremental.safetyIdentitySnapshot,
          sourceIdentitySnapshot: incremental.sourceIdentitySnapshot,
          suppressionIdentitySnapshot: incremental.suppressionIdentitySnapshot,
          userId
        }
      });
      await expect(createPrismaMemoryItemEmbeddingRepository(prisma).loadTarget(
        userId,
        hybridEntry.id
      )).resolves.toMatchObject({
        factVersionId: pattern.id,
        itemType: "FACT_VERSION"
      });

      await expect(prisma.$transaction((tx) =>
        repository.apply(tx, claim, plan, result, applyAt)
      )).rejects.toThrow("memory_synthesis_source_stale");
      expect(await prisma.memoryFactVersion.count({
        where: { modality: "PATTERN", userId }
      })).toBe(2);

      const beforeDisable = await firstSettings.get(userId);
      const disabledWithPattern = await createPrismaMemorySettingsRepository(prisma, {
        now: () => new Date(applyAt.getTime() + 100)
      }).patch(userId, {
        expectedMemoryRevision: beforeDisable.memoryRevision,
        expectedSettingsRevision: beforeDisable.settingsRevision,
        synthesisEnabled: false
      });
      expect(disabledWithPattern.synthesisEnabledAt).toEqual(firstBoundary);
      expect(await patternAuthority(userId, pattern.id)).toBe(1);
      expect(await reconcileMemorySynthesisWork(
        prisma,
        new Date(applyAt.getTime() + 200),
        async () => true
      )).toMatchObject({ scheduled: 0 });
      const reenabledWithPattern = await createPrismaMemorySettingsRepository(prisma, {
        now: () => new Date(applyAt.getTime() + 300)
      }).patch(userId, {
        expectedMemoryRevision: disabledWithPattern.memoryRevision,
        expectedSettingsRevision: disabledWithPattern.settingsRevision,
        synthesisEnabled: true
      });
      expect(reenabledWithPattern.synthesisEnabledAt).toEqual(firstBoundary);

      const invalidatedSource = cluster.sources[0];
      if (!invalidatedSource) throw new Error("memory_synthesis_test_source_missing");
      const invalidatedAt = new Date(applyAt.getTime() + 1_000);
      await prisma.$transaction(async (tx) => {
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED", systemTo: invalidatedAt },
          where: { id: invalidatedSource.versionId }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: null, state: "RETRACTED" },
          where: { id: invalidatedSource.factId }
        });
      });
      expect(await patternAuthority(userId, pattern.id)).toBe(0);

      const concurrentInvalidations = await Promise.all([
        withLockedMemoryTransaction(
          prisma,
          userId,
          (tx, settings) => retractInvalidMemorySynthesisPatterns(
            tx,
            settings,
            invalidatedAt
          )
        ),
        withLockedMemoryTransaction(
          prisma,
          userId,
          (tx, settings) => retractInvalidMemorySynthesisPatterns(
            tx,
            settings,
            invalidatedAt
          )
        )
      ]);
      expect(concurrentInvalidations.sort((left, right) => left - right)).toEqual([0, 2]);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: pattern.id }
      })).resolves.toMatchObject({ state: "RETRACTED", systemTo: invalidatedAt });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: shortPattern.id }
      })).resolves.toMatchObject({ state: "RETRACTED", systemTo: invalidatedAt });
      expect(await prisma.memoryFactVersionRelation.count({
        where: { sourceVersionId: pattern.id, userId }
      })).toBe(4);
      const targetedJobs = await prisma.memoryJob.findMany({
        where: {
          kind: "SYNTHESIZE_MEMORIES",
          pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
          targetFactVersionId: { in: [pattern.id, shortPattern.id] },
          userId
        }
      });
      // Both source sets can now be reconsidered: the smaller one retains two
      // facts and may combine them, but cannot recreate a recurring pattern.
      expect(targetedJobs).toHaveLength(2);
      const mainTarget = targetedJobs.find(({ targetFactVersionId }) => targetFactVersionId === pattern.id)!;
      expect(mainTarget).toMatchObject({
        state: "QUEUED",
        targetFactVersionId: pattern.id
      });
      const shorterTarget = targetedJobs.find(({ targetFactVersionId }) => targetFactVersionId === shortPattern.id)!;
      expect(shorterTarget).toMatchObject({ state: "QUEUED", targetFactVersionId: shortPattern.id });
      const shorterPlan = (await loadMemorySynthesisSnapshot(prisma, userId, shortPattern.id))?.plan;
      expect(shorterPlan?.sources).toHaveLength(2);
      expect(() => decodeMemorySynthesisOutput({ patterns: [{
        confidence_band: "HIGH", entity_refs: [], reason_code: "repeated_habit_pattern",
        source_refs: shorterPlan!.sources.map(({ ref }) => ref),
        statement: "The user often repeats the same weekly review steps."
      }] }, shorterPlan!)).toThrow();
      const replacementLeaseToken = `memory-synthesis-replacement-${randomUUID()}`;
      const replacementRow = await prisma.memoryJob.update({
        data: {
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 120_000),
          leaseToken: replacementLeaseToken,
          state: "CLAIMED"
        },
        where: { id: mainTarget.id }
      });
      const replacementClaim = claimFromJob(replacementRow);
      const replacementSnapshot = await repository.snapshot(replacementClaim);
      const replacementPlan = replacementSnapshot?.plan;
      expect(replacementPlan?.sources).toHaveLength(3);
      if (!replacementPlan) {
        throw new Error("memory_synthesis_replacement_plan_missing");
      }
      const replacementCluster = replacementPlan.clusters[0];
      if (!replacementCluster) {
        throw new Error("memory_synthesis_replacement_cluster_missing");
      }
      const replacementOutput = decodeMemorySynthesisOutput({
        patterns: [{
          confidence_band: "HIGH",
          entity_refs: replacementCluster.entityRefs.slice(0, 1),
          reason_code: "repeated_workflow_pattern",
          source_refs: replacementCluster.sources.map(({ ref }) => ref),
          statement: pattern.displayText
        }]
      }, replacementPlan);
      const replacementInputHash = memorySynthesisInputHash(replacementPlan);
      const replacementAcceptedOutputHash = memorySynthesisAcceptedOutputHash(
        replacementInputHash,
        replacementOutput
      );
      const replacementExecutionId = await createSucceededJobBinding({
        acceptedOutputHash: replacementAcceptedOutputHash,
        inputHash: replacementInputHash,
        jobId: replacementClaim.id,
        logicalRole: "MEMORY_SYNTHESIZE",
        pipelineVersion: MEMORY_SYNTHESIS_PIPELINE_VERSION,
        policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
        promptVersion: MEMORY_SYNTHESIS_PROMPT_VERSION,
        schemaVersion: "memory-synthesis-schema-v4",
        userId
      });
      const replacementResult = {
        acceptedOutputHash: replacementAcceptedOutputHash,
        executionId: replacementExecutionId,
        inputHash: replacementInputHash,
        modelId: "memory-synthesis-stateful-model",
        output: replacementOutput,
        policyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
        providerId: "openai_compatible"
      };
      await repository.stage(
        replacementClaim,
        replacementPlan,
        replacementResult
      );
      const replacementAppliedAt = new Date(invalidatedAt.getTime() + 1);
      const replacementRace = await Promise.allSettled([1, 2].map(() =>
        prisma.$transaction((tx) => repository.apply(
          tx,
          replacementClaim,
          replacementPlan,
          replacementResult,
          replacementAppliedAt
        ))
      ));
      expect(replacementRace.filter(({ status }) => status === "fulfilled"))
        .toEqual([expect.objectContaining({ value: 1 })]);
      expect(replacementRace.filter(({ status }) => status === "rejected"))
        .toHaveLength(1);
      const replacementVersions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: {
          modality: "PATTERN",
          synthesisSourceSetFingerprint: replacementPlan.sourceSetFingerprint,
          userId
        }
      });
      expect(replacementVersions).toHaveLength(1);
      expect(replacementVersions[0]).toMatchObject({
        state: "ACTIVE",
        synthesisSourceSetFingerprint: replacementPlan.sourceSetFingerprint
      });
      expect(replacementVersions[0]!.factId).not.toBe(pattern.factId);
      await classifySources(userId, [replacementVersions[0]!.id]);
      expect(await patternAuthority(userId, replacementVersions[0]!.id)).toBe(1);
      await expect(prisma.memoryFactVersionRelation.count({
        where: {
          sourceVersionId: replacementVersions[0]!.id,
          userId
        }
      })).resolves.toBe(3);
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: replacementVersions[0]!.factId }
      })).resolves.toMatchObject({
        currentVersionId: replacementVersions[0]!.id,
        state: "ACTIVE"
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: pattern.factId }
      })).resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
      await expect(prisma.memoryFactVersion.count({
        where: { modality: "PATTERN", state: "ACTIVE", userId }
      })).resolves.toBe(1);
      expect(await prisma.memoryFactVersion.count({
        where: { modality: "HABIT", state: "ACTIVE", userId }
      })).toBe(21);
      await expect(prisma.memorySynthesisExecution.findUniqueOrThrow({
        where: { userId_memoryJobId: { memoryJobId: claim.id, userId } }
      })).resolves.toMatchObject({
        acceptedOutput: null,
        appliedAt: expect.any(Date),
        sourceBindings: null
      });
      expect(await reconcileMemorySynthesisWork(
        prisma,
        new Date(applyAt.getTime() + 24 * 60 * 60 * 1_000),
        async () => true
      )).toMatchObject({ scheduled: 0 });

      await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
        createMemorySuppressionInTransaction(tx, settings, keyring, {
          canonicalKey: "synthetic.unrelated",
          explicitOverrideAllowed: false,
          scope: "FACT",
          suppressionId: randomUUID()
        }).then(() => undefined));
      expect(await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
        retractInvalidMemorySynthesisPatterns(tx, settings, new Date())))
        .toBe(1);
      expect((await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .lastSynthesisAt).toBeNull();
      const renewedPlan = (await loadMemorySynthesisSnapshot(prisma, userId))?.plan;
      if (!renewedPlan) throw new Error("memory_synthesis_generation_plan_missing");
      const renewedRefs = new Map(renewedPlan.sources.map(({ factId, ref }) => [factId, ref]));
      expect((await applySyntheticProposals(userId, renewedPlan, [{
        sourceRefs: replacementPlan.sources.map(({ factId }) => renewedRefs.get(factId)!),
        statement: pattern.displayText!
      }], "repeated_workflow_pattern")).applied).toBe(1);
      const restored = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: replacementVersions[0]!.factId }
      });
      expect(restored.state).toBe("ACTIVE");
      expect(restored.currentVersionId).not.toBe(replacementVersions[0]!.id);
    } finally {
      await cleanupOwner(userId);
      await prisma.providerModel.deleteMany({ where: { id: embeddingModelId } });
      await prisma.providerConnection.deleteMany({ where: { id: embeddingConnectionId } });
    }
  }, 30_000);
});
