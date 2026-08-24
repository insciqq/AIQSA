import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput
} from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { decodeMemorySynthesisOutput } from "./contract";
import { memorySynthesisPatternAuthorityPredicate } from "./eligibility";
import {
  memorySynthesisJobFingerprint,
  MEMORY_SYNTHESIS_PIPELINE_VERSION,
  MEMORY_SYNTHESIS_POLICY_VERSION
} from "./policy";
import {
  memorySynthesisAcceptedOutputHash,
  memorySynthesisInputHash
} from "./provider";
import { reconcileMemorySynthesisWork } from "./reconcile";
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
      confidence: 1,
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

async function patternAuthority(userId: string, versionId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::integer AS count
    FROM "MemoryFactVersion" AS version
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

  it("keeps the first opt-in boundary, applies one source-bound pattern, and retracts it when a source loses authority", async () => {
    const userId = await createOwner();
    try {
      const base = new Date(Date.now() - 60 * 60 * 1_000);
      const firstBoundary = new Date(base);
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

      const deniedReconcile = await reconcileMemorySynthesisWork(
        prisma,
        new Date(),
        async () => false
      );
      expect(deniedReconcile.scheduled).toBe(0);
      const firstReconcile = await reconcileMemorySynthesisWork(
        prisma,
        new Date(),
        async () => true
      );
      expect(firstReconcile.scheduled).toBe(1);
      const secondReconcile = await reconcileMemorySynthesisWork(
        prisma,
        new Date(),
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
        patterns: [{
          confidence_band: "HIGH",
          entity_refs: [entityId],
          reason_code: "repeated_workflow_pattern",
          source_refs: cluster.sources.slice(0, 3).map(({ ref }) => ref),
          statement: "The user tends to follow a recurring weekly review workflow."
        }]
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
        promptVersion: "memory-synthesis-prompt-v2",
        schemaVersion: "memory-synthesis-schema-v2",
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
      const repository = createPrismaMemorySynthesisRepository(prisma);
      await repository.stage(claim, plan, result);
      const applyAt = new Date();
      await expect(prisma.$transaction((tx) =>
        repository.apply(tx, claim, plan, result, applyAt)
      )).resolves.toBe(1);

      const pattern = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { modality: "PATTERN", userId }
      });
      expect(pattern).toMatchObject({
        directness: "INFERRED",
        ingestionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        safetyClassificationState: "PENDING",
        sourceMode: "AUTOMATIC",
        state: "ACTIVE",
        synthesisDepth: 1,
        synthesisGeneration: snapshot.settings.memoryGeneration,
        synthesisSourceSetFingerprint: plan.sourceSetFingerprint
      });
      expect(await prisma.memorySearchEntry.count({
        where: { factVersionId: pattern.id, userId }
      })).toBe(0);
      const relations = await prisma.memoryFactVersionRelation.findMany({
        where: {
          kind: "SYNTHESIZED_FROM",
          sourceVersionId: pattern.id,
          userId
        }
      });
      expect(relations).toHaveLength(3);
      expect(relations.every((relation) =>
        relation.executionId === executionId &&
        /^[a-f0-9]{64}$/u.test(relation.sourceEligibilityHash ?? "")
      )).toBe(true);
      expect(await patternAuthority(userId, pattern.id)).toBe(1);

      await expect(prisma.$transaction((tx) =>
        repository.apply(tx, claim, plan, result, applyAt)
      )).rejects.toThrow("memory_synthesis_source_stale");
      expect(await prisma.memoryFactVersion.count({
        where: { modality: "PATTERN", userId }
      })).toBe(1);

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

      const invalidatedSource = plan.sources.find(({ versionId }) =>
        versionId === relations[0]!.targetVersionId
      );
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

      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => retractInvalidMemorySynthesisPatterns(
          tx,
          settings,
          invalidatedAt
        )
      )).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: pattern.id }
      })).resolves.toMatchObject({ state: "RETRACTED", systemTo: invalidatedAt });
      expect(await prisma.memoryFactVersionRelation.count({
        where: { sourceVersionId: pattern.id, userId }
      })).toBe(3);
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
    } finally {
      await cleanupOwner(userId);
    }
  });
});
