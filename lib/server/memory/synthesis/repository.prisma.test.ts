import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createMemoryClientRefService } from "../actions/clientRef";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput
} from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { createMemoryRebuildHandler } from "../rebuild/handler";
import { createPrismaMemoryRebuildRepository } from "../rebuild/repository";
import { ensureClassifiedSearchEntry } from "../persistence/factSearchEntry";
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
  decodeMemorySynthesisOutput
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
  MEMORY_SYNTHESIS_QUIET_PERIOD_MS
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

  it("[E06] synthesizes, retrieves, invalidates, and replaces a source-bound pattern", async () => {
    const userId = await createOwner();
    const embeddingConnectionId = `memory-synthesis-connection-${randomUUID()}`;
    const embeddingModelId = `memory-synthesis-model-${randomUUID()}`;
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
        decision: { due: true, reason: "FACT_ACTIVITY" }
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
      expect(identityMappings?.count).toBe(2n);
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
      })).toBe(0);
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
          targetFactVersionId: { in: [pattern.id, shortPattern.id] },
          userId
        }
      });
      expect(targetedJobs).toHaveLength(1);
      expect(targetedJobs[0]).toMatchObject({
        state: "QUEUED",
        targetFactVersionId: pattern.id
      });
      const replacementLeaseToken = `memory-synthesis-replacement-${randomUUID()}`;
      const replacementRow = await prisma.memoryJob.update({
        data: {
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 120_000),
          leaseToken: replacementLeaseToken,
          state: "CLAIMED"
        },
        where: { id: targetedJobs[0]!.id }
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
        schemaVersion: "memory-synthesis-schema-v2",
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
        where: { factId: pattern.factId, modality: "PATTERN", userId }
      });
      expect(replacementVersions).toHaveLength(2);
      expect(replacementVersions[0]).toMatchObject({ state: "RETRACTED" });
      expect(replacementVersions[1]).toMatchObject({
        state: "ACTIVE",
        synthesisSourceSetFingerprint: replacementPlan.sourceSetFingerprint
      });
      await classifySources(userId, [replacementVersions[1]!.id]);
      expect(await patternAuthority(userId, replacementVersions[1]!.id)).toBe(1);
      await expect(prisma.memoryFactVersionRelation.count({
        where: {
          sourceVersionId: replacementVersions[1]!.id,
          userId
        }
      })).resolves.toBe(3);
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: pattern.factId }
      })).resolves.toMatchObject({
        currentVersionId: replacementVersions[1]!.id,
        state: "ACTIVE"
      });
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
    } finally {
      await cleanupOwner(userId);
      await prisma.providerModel.deleteMany({ where: { id: embeddingModelId } });
      await prisma.providerConnection.deleteMany({ where: { id: embeddingConnectionId } });
    }
  }, 30_000);
});
