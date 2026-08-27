import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { applyMemoryScopeTargetDeletion } from "../scopeLifecycle";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import {
  memoryShadowRebuildJobFingerprint,
  MEMORY_SHADOW_REBUILD_PIPELINE_VERSION
} from "../rebuild/contract";
import {
  MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
  MEMORY_RECLASSIFICATION_POLICY_VERSION,
  memoryReclassificationAcceptedOutputHash,
  memoryReclassificationInputHash,
  type MemoryReclassificationResult
} from "./classifier";
import { createPrismaMemoryReclassificationHandler } from "./handler";
import {
  MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS,
  reconcileMemoryFactReclassificationJobs
} from "./reconcile";
import {
  createPrismaMemoryReclassificationRepository,
  type MemoryReclassificationCandidate
} from "./repository";

async function createPendingVersion(
  userId: string,
  scopeId: string,
  label: string,
  sourceMode: "EXPLICIT" | "AUTOMATIC" = "EXPLICIT"
): Promise<Readonly<{
  factId: string;
  versionId: string;
}>> {
  const suffix = randomUUID();
  const factId = `memory-reclass-fact-${suffix}`;
  const versionId = `memory-reclass-version-${suffix}`;
  const eventId = `memory-reclass-event-${suffix}`;
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey: `reclass.${suffix}`,
        category: "about_you",
        id: factId,
        scopeId,
        state: "ORPHANED",
        userId
      }
    });
    await tx.memoryEvent.create({
      data: {
        actorType: "USER",
        actorUserId: userId,
        factId,
        factVersionId: versionId,
        id: eventId,
        operation: "EXPLICIT_SAVE",
        userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "about_you",
        confidence: 1,
        createdByEventId: eventId,
        directness: "DIRECT",
        displayText: "I prefer tea",
        factId,
        id: versionId,
        importance: 1,
        languageCode: "en",
        modality: "STATE",
        normalizedSearchText: "i prefer tea",
        pipelineVersion: "legacy-memory-test-v1",
        safetyClassificationState: "PENDING",
        sensitivityClass: "NORMAL",
        sourceMode,
        state: "ACTIVE",
        structuredValue: { statement: "I prefer tea" },
        userId
      }
    });
    await tx.memoryFact.update({
      data: { currentVersionId: versionId, state: "ACTIVE" },
      where: { id: factId }
    });
  });
  return { factId, versionId };
}

async function createPendingFact(
  label: string,
  sourceMode: "EXPLICIT" | "AUTOMATIC" = "EXPLICIT"
): Promise<Readonly<{
  factId: string;
  userId: string;
  versionId: string;
}>> {
  const suffix = randomUUID();
  const userId = `memory-reclass-${label}-${suffix}`;
  const scopeId = `memory-reclass-scope-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory reclassification fixture",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.memoryScope.create({
    data: { id: scopeId, scopeType: "GLOBAL_USER", userId }
  });
  return {
    ...await createPendingVersion(userId, scopeId, label, sourceMode),
    userId
  };
}

async function attachAutomaticEvidence(input: Readonly<{
  factVersionId: string;
  legacyExactProvenance?: boolean;
  userId: string;
}>): Promise<void> {
  const sourceText = "I prefer tea";
  const chat = await prisma.chat.create({
    data: {
      title: "Memory reclassification automatic evidence",
      userId: input.userId
    }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(sourceText),
      role: "user",
      status: "complete"
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: message.id },
    where: { id: chat.id }
  });
  const sourceMessageContentHash = memorySha256(sourceText);
  await prisma.memoryEvidence.create({
    data: {
      branchGeneration: 0,
      chatId: chat.id,
      ...(input.legacyExactProvenance
        ? {}
        : {
            evidenceFingerprint: memorySha256({
              endOffset: sourceText.length,
              messageId: message.id,
              sourceMessageContentHash,
              startOffset: 0,
              version: 1
            }),
            sourceEndOffset: sourceText.length,
            sourceMessageContentHash,
            sourceStartOffset: 0
          }),
      factVersionId: input.factVersionId,
      messageId: message.id,
      observedAt: message.createdAt,
      safeExcerpt: sourceText,
      safeSourceHash: sourceMessageContentHash,
      safetyClass: "NORMAL",
      sourceProjectionVersion: input.legacyExactProvenance
        ? "memory-fact-source-projection-v4"
        : MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceRole: "user",
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId: input.userId
    }
  });
  await prisma.memoryFactVersion.update({
    data: {
      ...(input.legacyExactProvenance
        ? {}
        : {
            ingestionFingerprint: memorySha256({
              domain: "memory-reclassification-test",
              factVersionId: input.factVersionId,
              messageId: message.id
            })
          }),
      observedAt: message.createdAt,
      pipelineVersion: input.legacyExactProvenance
        ? "memory-fact-extraction-vnext-v5"
        : MEMORY_FACT_EXTRACTION_PIPELINE_VERSION
    },
    where: { id: input.factVersionId }
  });
}

function result(
  sensitivity: MemoryReclassificationResult["decision"]["sensitivity"],
  options: Partial<MemoryReclassificationResult["decision"]> = {}
): MemoryReclassificationResult {
  return {
    decision: {
      category: sensitivity === "SENSITIVE" ? "sensitive" : "preferences",
      reasonCode: sensitivity === "SECRET" ? "secret_material" : "ordinary_personal",
      responsePreference: sensitivity !== "SECRET",
      sensitivity,
      subjectScope: "USER",
      storageDecision: sensitivity === "SECRET" ? "REJECT_SECRET" : "ALLOW",
      ...options
    },
    modelId: "reclass-model-v1",
    policyVersion: MEMORY_RECLASSIFICATION_POLICY_VERSION,
    providerId: "fixture-provider"
  };
}

async function createReclassificationExecution(
  userId: string,
  now: Date
): Promise<string> {
  const executionId = randomUUID();
  const jobId = randomUUID();
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: { memoryGeneration: true, memoryRevision: true },
    where: { userId }
  });
  const startedAt = new Date(now.getTime() - 2);
  const completedAt = new Date(now.getTime() - 1);
  await prisma.$transaction(async (tx) => {
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: "7".repeat(64),
        completedAt,
        id: jobId,
        idempotencyFingerprint: `memory-reclass-execution-${randomUUID()}`,
        kind: "RECLASSIFY_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: "8".repeat(64),
        cachedInputTokens: 0,
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: "9".repeat(64),
        id: executionId,
        inputHash: "a".repeat(64),
        inputTokens: 5,
        logicalRole: "MEMORY_RECLASSIFY",
        memoryJobId: jobId,
        ordinal: 0,
        outputTokens: 2,
        ownerType: "JOB",
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
        policyVersion: MEMORY_RECLASSIFICATION_POLICY_VERSION,
        promptVersion: "memory-safety-reclassification-prompt-v1",
        providerId: "fixture-provider",
        reasoningTokens: 0,
        recoverableUntil: completedAt,
        relationsDetachedAt: now,
        schemaVersion: "memory-safety-classification-schema-v1",
        secretFreeExecutionSnapshot: {
          providerExecutionSnapshot: {
            providerFamily: "fixture-provider",
            providerModelId: "reclass-model-v1"
          },
          version: 1
        },
        startedAt,
        state: "SUCCEEDED",
        totalTokens: 7,
        usageCompleteness: "COMPLETE",
        userId
      }
    });
    await tx.usageEvent.create({
      data: {
        cachedInputTokens: 0,
        inputTokens: 5,
        memoryExecutionBindingId: executionId,
        modelId: "reclass-model-v1",
        outputTokens: 2,
        provider: "fixture-provider",
        providerModelId: "reclass-model-v1",
        reasoningTokens: 0,
        totalTokens: 7,
        userId
      }
    });
  });
  return executionId;
}

function governedResult(
  candidate: MemoryReclassificationCandidate,
  sensitivity: MemoryReclassificationResult["decision"]["sensitivity"],
  executionId: string,
  options: Partial<MemoryReclassificationResult["decision"]> = {}
): MemoryReclassificationResult {
  const classified = result(sensitivity, options);
  const inputHash = memoryReclassificationInputHash(
    candidate.displayText,
    candidate.sourceMode
  );
  return {
    ...classified,
    acceptedOutputHash: memoryReclassificationAcceptedOutputHash(
      inputHash,
      classified.decision
    ),
    executionId,
    inputHash
  };
}

function localSecretResult(): MemoryReclassificationResult {
  return {
    ...result("SECRET"),
    executionId: null,
    modelId: "format-aware-secret-parser-v1",
    policyVersion: "memory-local-secret-parser-v1",
    providerId: "aiqsa-local-policy"
  };
}

function localLiteResult(
  candidate: MemoryReclassificationCandidate
): MemoryReclassificationResult {
  return {
    classifiedAt: new Date("2026-08-21T10:00:00.000Z"),
    decision: {
      category: candidate.category === "about_you" ? "about_you" : "other",
      reasonCode: "ordinary_personal",
      responsePreference: candidate.modality === "PREFERENCE",
      sensitivity: "NORMAL",
      storageDecision: "ALLOW",
      subjectScope: "USER"
    },
    executionId: null,
    modelId: MEMORY_SAFETY_LITE_POLICY_VERSION,
    policyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
    providerId: "aiqsa-local-policy"
  };
}

async function createShadowWakeFixture(userId: string): Promise<Readonly<{
  activeGenerationId: string;
  rebuildJobId: string;
  shadowGenerationId: string;
}>> {
  const activeGenerationId = randomUUID();
  const shadowGenerationId = randomUUID();
  const rebuildJobId = randomUUID();
  const now = new Date("2026-08-21T07:00:00.000Z");
  await prisma.$transaction(async (tx) => {
    await tx.memoryIndexGeneration.create({
      data: {
        activatedAt: now,
        chunkingVersion: "memory-lexical-chunking-v1",
        generation: 0,
        id: activeGenerationId,
        indexedThroughMemoryRevision: 0,
        indexMode: "LEXICAL_ONLY",
        languageProfile: "multilingual-simple-v1",
        normalizationVersion: "memory-normalization-v1",
        readyAt: now,
        retrievalPipelineVersion: "memory-retrieval-v1",
        state: "ACTIVE",
        targetMemoryRevision: 0,
        userId
      }
    });
    await tx.userMemorySettings.update({
      data: { activeIndexGenerationId: activeGenerationId },
      where: { userId }
    });
    await tx.memoryIndexGeneration.create({
      data: {
        chunkingVersion: "memory-lexical-chunking-v1",
        generation: 1,
        id: shadowGenerationId,
        indexedThroughMemoryRevision: 0,
        indexMode: "LEXICAL_ONLY",
        languageProfile: "multilingual-simple-v1",
        normalizationVersion: "memory-normalization-v1",
        retrievalPipelineVersion: "memory-retrieval-v1",
        sourceIndexGenerationId: activeGenerationId,
        state: "BUILDING",
        targetMemoryRevision: 0,
        userId
      }
    });
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: "b".repeat(64),
        attemptCount: 1,
        completedAt: now,
        id: rebuildJobId,
        idempotencyFingerprint: memoryShadowRebuildJobFingerprint({
          generationId: shadowGenerationId,
          operation: "REBUILD_SEARCH_INDEX",
          requestIdentity: { test: "reclassification-wake" }
        }),
        kind: "REBUILD_INDEX",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        pipelineVersion: MEMORY_SHADOW_REBUILD_PIPELINE_VERSION,
        state: "SUCCEEDED",
        userId
      }
    });
  });
  return { activeGenerationId, rebuildJobId, shadowGenerationId };
}

describe("Prisma Memory safety reclassification", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records classification metadata and fences secret content", async () => {
    const normal = await createPendingFact("normal");
    const legacyReset = await createPendingFact("legacy-reset");
    const secret = await createPendingFact("secret");
    const thirdParty = await createPendingFact("third-party");
    const automaticRelationship = await createPendingFact("automatic-relationship", "AUTOMATIC");
    const wake = await createShadowWakeFixture(normal.userId);
    const repository = createPrismaMemoryReclassificationRepository(prisma);
    const now = new Date("2026-08-21T08:00:00.000Z");
    try {
      await prisma.memoryFactVersion.update({
        data: {
          coreEligible: true,
          coreSalience: "HIGH",
          modality: "PREFERENCE"
        },
        where: { id: legacyReset.versionId }
      });
      const legacySecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
      await prisma.memoryFactVersion.update({
        data: {
          displayText: legacySecret,
          normalizedSearchText: legacySecret,
          structuredValue: { credential: legacySecret }
        },
        where: { id: secret.versionId }
      });
      const [normalExecutionId, legacyResetExecutionId,
        thirdPartyExecutionId] = await Promise.all([
        createReclassificationExecution(normal.userId, now),
        createReclassificationExecution(legacyReset.userId, now),
        createReclassificationExecution(thirdParty.userId, now)
      ]);
      const candidates = await repository.pending(normal.userId);
      expect(candidates).toHaveLength(1);
      const legacyResetCandidates = await repository.pending(legacyReset.userId);
      const secretCandidates = await repository.pending(secret.userId);
      const thirdPartyCandidates = await repository.pending(thirdParty.userId);
      const automaticRelationshipCandidates = await repository.pending(automaticRelationship.userId);
      const normalCandidate = candidates[0] as MemoryReclassificationCandidate;
      const legacyResetCandidate = legacyResetCandidates[0] as MemoryReclassificationCandidate;
      const secretCandidate = secretCandidates[0] as MemoryReclassificationCandidate;
      const thirdPartyCandidate = thirdPartyCandidates[0] as MemoryReclassificationCandidate;
      expect(automaticRelationshipCandidates).toEqual([]);
      await prisma.$transaction((tx) => repository.apply(tx, normal.userId, [{
        candidate: normalCandidate,
        result: governedResult(normalCandidate, "NORMAL", normalExecutionId)
      }], now));
      await prisma.$transaction((tx) => repository.apply(tx, legacyReset.userId, [{
        candidate: legacyResetCandidate,
        result: governedResult(legacyResetCandidate, "NORMAL", legacyResetExecutionId, {
          category: "goals",
          responsePreference: false
        })
      }], now));
      await prisma.$transaction((tx) => repository.apply(tx, secret.userId, [{
        candidate: secretCandidate,
        result: localSecretResult()
      }], now));
      await prisma.$transaction((tx) => repository.apply(tx, thirdParty.userId, [{
        candidate: thirdPartyCandidate,
        result: governedResult(thirdPartyCandidate, "NORMAL", thirdPartyExecutionId, {
          category: "other",
          reasonCode: "third_party_rejected",
          responsePreference: false,
          subjectScope: "THIRD_PARTY",
          storageDecision: "REJECT_THIRD_PARTY"
        })
      }], now));
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: normal.versionId },
        select: {
          category: true,
          coreEligible: true,
          coreSalience: true,
          safetyClassifiedAt: true,
          safetyClassificationState: true,
          safetyClassifierExecutionId: true,
          safetyClassifierModelId: true,
          safetyClassifierPolicyVersion: true,
          safetyClassifierProviderId: true
        }
      })).resolves.toMatchObject({
        category: "preferences",
        coreEligible: true,
        coreSalience: "HIGH",
        safetyClassifiedAt: now,
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: normalExecutionId,
        safetyClassifierModelId: "reclass-model-v1",
        safetyClassifierPolicyVersion: MEMORY_RECLASSIFICATION_POLICY_VERSION,
        safetyClassifierProviderId: "fixture-provider"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: legacyReset.versionId }
      })).resolves.toMatchObject({
        category: "goals",
        coreEligible: false,
        coreSalience: "NONE",
        modality: "STATE",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: legacyResetExecutionId
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: normal.userId }
      })).resolves.toMatchObject({
        activeIndexGenerationId: wake.activeGenerationId,
        memoryGeneration: 0,
        memoryRevision: 1
      });
      await expect(prisma.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: wake.activeGenerationId }
      })).resolves.toMatchObject({ indexedThroughMemoryRevision: 1 });
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: normal.versionId, userId: normal.userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: wake.rebuildJobId }
      })).resolves.toMatchObject({
        acceptedResultHash: null,
        attemptCount: 0,
        completedAt: null,
        state: "QUEUED"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: secret.versionId },
        select: {
          contentPurgedAt: true,
          displayText: true,
          safetyClassificationState: true,
          safetyClassifierExecutionId: true,
          safetyClassifierModelId: true,
          safetyClassifierPolicyVersion: true,
          safetyClassifierProviderId: true,
          state: true,
          structuredValue: true
        }
      })).resolves.toMatchObject({
        contentPurgedAt: now,
        displayText: null,
        safetyClassificationState: "SECRET_FENCED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: "format-aware-secret-parser-v1",
        safetyClassifierPolicyVersion: "memory-local-secret-parser-v1",
        safetyClassifierProviderId: "aiqsa-local-policy",
        state: "RETRACTED",
        structuredValue: null
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: thirdParty.versionId },
        select: {
          contentPurgedAt: true,
          displayText: true,
          safetyClassificationReasonCode: true,
          safetyClassificationState: true,
          state: true
        }
      })).resolves.toMatchObject({
        contentPurgedAt: now,
        displayText: null,
        safetyClassificationReasonCode: "third_party_rejected",
        safetyClassificationState: "REJECTED_FENCED",
        state: "RETRACTED"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: automaticRelationship.versionId },
        select: {
          contentPurgedAt: true,
          displayText: true,
          safetyClassificationReasonCode: true,
          safetyClassificationState: true,
          state: true
        }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        displayText: "I prefer tea",
        safetyClassificationReasonCode: null,
        safetyClassificationState: "PENDING",
        state: "ACTIVE"
      });
    } finally {
      await prisma.user.delete({ where: { id: normal.userId } });
      await prisma.user.delete({ where: { id: legacyReset.userId } });
      await prisma.user.delete({ where: { id: secret.userId } });
      await prisma.user.delete({ where: { id: thirdParty.userId } });
      await prisma.user.delete({ where: { id: automaticRelationship.userId } });
    }
  });

  it("canonicalizes a legacy SENSITIVE result to ordinary active state", async () => {
    const fact = await createPendingFact("legacy-sensitive-normalization");
    const repository = createPrismaMemoryReclassificationRepository(prisma);
    const now = new Date("2026-08-21T08:15:00.000Z");
    try {
      const executionId = await createReclassificationExecution(fact.userId, now);
      const [candidate] = await repository.pending(fact.userId);
      if (!candidate) throw new Error("memory_reclassification_candidate_missing");

      await prisma.$transaction((tx) => repository.apply(tx, fact.userId, [{
        candidate,
        result: governedResult(candidate, "SENSITIVE", executionId, {
          category: "sensitive",
          reasonCode: "private_personal",
          responsePreference: false,
          storageDecision: "ALLOW",
          subjectScope: "USER"
        })
      }], now));

      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: fact.versionId }
      })).resolves.toMatchObject({
        category: "about_you",
        safetyClassificationState: "CLASSIFIED",
        sensitivityClass: "NORMAL",
        state: "ACTIVE"
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: fact.factId }
      })).resolves.toMatchObject({ category: "about_you", state: "ACTIVE" });
    } finally {
      await prisma.user.delete({ where: { id: fact.userId } });
    }
  });

  it("indexes a normal automatic fact only after independent classification", async () => {
    const fact = await createPendingFact("automatic-normal", "AUTOMATIC");
    const repository = createPrismaMemoryReclassificationRepository(prisma);
    const now = new Date("2026-08-21T08:18:00.000Z");
    try {
      await attachAutomaticEvidence({
        factVersionId: fact.versionId,
        userId: fact.userId
      });
      await createShadowWakeFixture(fact.userId);
      await expect(prisma.memorySearchEntry.count({ where: { userId: fact.userId } }))
        .resolves.toBe(0);
      const [candidate] = await repository.pending(fact.userId);
      if (!candidate) throw new Error("memory_reclassification_candidate_missing");
      const executionId = await createReclassificationExecution(fact.userId, now);

      await prisma.$transaction((tx) => repository.apply(tx, fact.userId, [{
        candidate,
        result: governedResult(candidate, "NORMAL", executionId, {
          category: "about_you",
          responsePreference: false
        })
      }], now));

      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: fact.versionId }
      })).resolves.toMatchObject({
        coreEligible: false,
        safetyClassificationState: "CLASSIFIED",
        sourceMode: "AUTOMATIC",
        state: "ACTIVE"
      });
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: fact.versionId, userId: fact.userId }
      })).resolves.toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: fact.userId } });
    }
  });

  it("fences automatic SENSITIVE and UNCERTAIN results under EXPLICIT_ONLY", async () => {
    const sensitive = await createPendingFact("automatic-sensitive", "AUTOMATIC");
    const uncertain = await createPendingFact("automatic-uncertain", "AUTOMATIC");
    const repository = createPrismaMemoryReclassificationRepository(prisma);
    const now = new Date("2026-08-21T08:20:00.000Z");
    try {
      await Promise.all([
        attachAutomaticEvidence({
          factVersionId: sensitive.versionId,
          userId: sensitive.userId
        }),
        attachAutomaticEvidence({
          factVersionId: uncertain.versionId,
          userId: uncertain.userId
        })
      ]);
      const [sensitiveCandidate] = await repository.pending(sensitive.userId);
      const [uncertainCandidate] = await repository.pending(uncertain.userId);
      if (!sensitiveCandidate || !uncertainCandidate) {
        throw new Error("memory_reclassification_candidate_missing");
      }
      const [sensitiveExecutionId, uncertainExecutionId] = await Promise.all([
        createReclassificationExecution(sensitive.userId, now),
        createReclassificationExecution(uncertain.userId, now)
      ]);
      await prisma.$transaction((tx) => repository.apply(tx, sensitive.userId, [{
        candidate: sensitiveCandidate,
        result: governedResult(sensitiveCandidate, "SENSITIVE", sensitiveExecutionId, {
          category: "sensitive",
          reasonCode: "private_personal",
          responsePreference: false,
          storageDecision: "ALLOW",
          subjectScope: "USER"
        })
      }], now));
      await prisma.$transaction((tx) => repository.apply(tx, uncertain.userId, [{
        candidate: uncertainCandidate,
        result: governedResult(uncertainCandidate, "UNCERTAIN", uncertainExecutionId, {
          category: "other",
          reasonCode: "uncertain",
          responsePreference: false,
          storageDecision: "REJECT_UNSUITABLE",
          subjectScope: "UNCERTAIN"
        })
      }], now));

      for (const fact of [sensitive, uncertain]) {
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: fact.versionId }
        })).resolves.toMatchObject({
          contentPurgedAt: now,
          displayText: null,
          safetyClassificationState: "REJECTED_FENCED",
          state: "RETRACTED",
          structuredValue: null
        });
        await expect(prisma.memoryFact.findUniqueOrThrow({
          where: { id: fact.factId }
        })).resolves.toMatchObject({
          currentVersionId: null,
          state: "RETRACTED"
        });
      }
    } finally {
      await prisma.user.delete({ where: { id: sensitive.userId } });
      await prisma.user.delete({ where: { id: uncertain.userId } });
    }
  });

  it("rejects external classification provenance without an execution binding", async () => {
    const fact = await createPendingFact("missing-execution");
    const repository = createPrismaMemoryReclassificationRepository(prisma);
    try {
      const [candidate] = await repository.pending(fact.userId);
      expect(candidate).toBeDefined();
      await expect(prisma.$transaction((tx) => repository.apply(
        tx,
        fact.userId,
        [{
          candidate: candidate!,
          result: result("NORMAL")
        }],
        new Date("2026-08-21T08:30:00.000Z")
      ))).rejects.toThrow();
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: fact.versionId }
      })).resolves.toMatchObject({
        safetyClassificationState: "PENDING",
        safetyClassifierExecutionId: null,
        safetyClassifierProviderId: null
      });
    } finally {
      await prisma.user.delete({ where: { id: fact.userId } });
    }
  });

  it("reprojects pending and surviving legacy safety states without provider egress", async () => {
    const mixed = await createPendingFact("lite-mixed-uncertain");
    const secretOnly = await createPendingFact("lite-secret-only");
    const legacyFenced = await createPendingFact("lite-surviving-secret-fenced");
    const legacyAutomatic = await createPendingFact(
      "lite-legacy-automatic-pending",
      "AUTOMATIC"
    );
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const mixedText =
      `I moved to Helsinki. API key ${token}; the move is permanent.`;
    const fencedText =
      `I work in Espoo. Credential ${token}; keep the commute preference.`;
    const now = new Date("2026-08-27T09:30:00.000Z");
    const repository = createPrismaMemoryReclassificationRepository(prisma);
    const classify = vi.fn(async () => {
      throw new Error("semantic safety provider must remain unused");
    });
    const handler = createPrismaMemoryReclassificationHandler(prisma, {
      provider: { classify },
      repository
    });

    async function applyLite(userId: string): Promise<void> {
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      });
      const claim: MemoryJobClaim = {
        activeLeafMessageId: null,
        attemptCount: 1,
        branchGeneration: null,
        chatId: null,
        claimToken: randomUUID(),
        id: randomUUID(),
        idempotencyFingerprint: memorySha256({
          domain: "memory-safety-lite-stateful",
          userId
        }),
        kind: "RECLASSIFY_FACTS",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
        recoveredLease: false,
        sourceHash: null,
        sourceMessageId: null,
        sourceRevision: null,
        stage: null,
        targetFactVersionId: null,
        userId
      };
      await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
      const execution = await handler.execute(claim, {
        now: () => now,
        setStage: async () => undefined,
        signal: new AbortController().signal
      });
      expect(execution.apply).toBeDefined();
      await prisma.$transaction((tx) => execution.apply!(tx, claim));
    }

    try {
      const uncertainExecutionId = await createReclassificationExecution(
        mixed.userId,
        now
      );
      const mixedVersion = await prisma.memoryFactVersion.findUniqueOrThrow({
        select: { createdByEventId: true },
        where: { id: mixed.versionId }
      });
      if (!mixedVersion.createdByEventId) {
        throw new Error("memory_safety_lite_explicit_event_missing");
      }
      await prisma.memoryFactVersion.update({
        data: {
          displayText: mixedText,
          normalizedSearchText: mixedText.toLowerCase(),
          safetyClassificationReasonCode: "uncertain",
          safetyClassificationState: "UNCERTAIN",
          safetyClassifiedAt: new Date(now.getTime() - 1_000),
          safetyClassifierExecutionId: uncertainExecutionId,
          safetyClassifierModelId: "reclass-model-v1",
          safetyClassifierPolicyVersion: MEMORY_RECLASSIFICATION_POLICY_VERSION,
          safetyClassifierProviderId: "fixture-provider",
          sensitivityClass: "HIGHLY_SENSITIVE",
          structuredValue: {
            [token]: token,
            location: "Helsinki",
            nested: { credential: token }
          }
        },
        where: { id: mixed.versionId }
      });
      await prisma.memoryEvidence.create({
        data: {
          factVersionId: mixed.versionId,
          memoryEventId: mixedVersion.createdByEventId,
          observedAt: now,
          safeExcerpt: mixedText,
          safeSourceHash: memorySha256(mixedText),
          safetyClass: "HIGHLY_SENSITIVE",
          sourceProjectionVersion: "legacy-memory-source-v1",
          sourceType: "EXPLICIT_ACTION",
          stance: "SUPPORTS",
          userId: mixed.userId
        }
      });
      await prisma.memoryFactVersion.update({
        data: {
          displayText: token,
          normalizedSearchText: token,
          structuredValue: { credential: token }
        },
        where: { id: secretOnly.versionId }
      });
      await prisma.memoryFactVersion.update({
        data: {
          displayText: fencedText,
          normalizedSearchText: fencedText.toLowerCase(),
          safetyClassificationReasonCode: "secret_material",
          safetyClassificationState: "SECRET_FENCED",
          safetyClassifiedAt: new Date(now.getTime() - 1_000),
          safetyClassifierExecutionId: null,
          safetyClassifierModelId: "format-aware-secret-parser-v1",
          safetyClassifierPolicyVersion: "memory-local-secret-parser-v1",
          safetyClassifierProviderId: "aiqsa-local-policy",
          sensitivityClass: "SECRET",
          structuredValue: { credential: token, location: "Espoo" }
        },
        where: { id: legacyFenced.versionId }
      });
      await prisma.memoryFactVersion.update({
        data: {
          structuredValue: {
            credential: token,
            preference: "tea"
          }
        },
        where: { id: legacyAutomatic.versionId }
      });
      await attachAutomaticEvidence({
        factVersionId: legacyAutomatic.versionId,
        legacyExactProvenance: true,
        userId: legacyAutomatic.userId
      });
      await Promise.all([
        createShadowWakeFixture(mixed.userId),
        createShadowWakeFixture(legacyFenced.userId),
        createShadowWakeFixture(legacyAutomatic.userId)
      ]);
      await expect(reconcileMemoryFactReclassificationJobs(prisma, now))
        .resolves.toBeGreaterThanOrEqual(4);

      await expect(repository.pending(mixed.userId)).resolves.toEqual([
        expect.objectContaining({
          id: mixed.versionId,
          safetyClassificationState: "UNCERTAIN"
        })
      ]);
      await expect(repository.pending(legacyFenced.userId)).resolves.toEqual([
        expect.objectContaining({
          id: legacyFenced.versionId,
          safetyClassificationState: "SECRET_FENCED"
        })
      ]);
      await expect(repository.pending(legacyAutomatic.userId)).resolves.toEqual([
        expect.objectContaining({
          id: legacyAutomatic.versionId,
          safetyClassificationState: "PENDING",
          sourceMode: "AUTOMATIC"
        })
      ]);

      await applyLite(mixed.userId);
      await applyLite(secretOnly.userId);
      await applyLite(legacyFenced.userId);
      await applyLite(legacyAutomatic.userId);

      const mixedProjection = await prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: mixed.versionId }
      });
      expect(mixedProjection).toMatchObject({
        contentPurgedAt: null,
        displayText:
          "I moved to Helsinki. API key [REDACTED:TOKEN]; the move is permanent.",
        safetyClassificationReasonCode: "lite_span_redacted",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        safetyClassifierProviderId: null,
        sensitivityClass: "NORMAL",
        state: "ACTIVE"
      });
      expect(JSON.stringify(mixedProjection.structuredValue)).not.toContain(token);
      expect(JSON.stringify(mixedProjection.structuredValue))
        .toContain("[REDACTED:TOKEN]");
      await expect(prisma.memoryEvidence.findFirstOrThrow({
        where: { factVersionId: mixed.versionId, userId: mixed.userId }
      })).resolves.toMatchObject({
        safeExcerpt:
          "I moved to Helsinki. API key [REDACTED:TOKEN]; the move is permanent.",
        sourceProjectionVersion: MEMORY_SAFETY_LITE_POLICY_VERSION
      });
      const mixedEntry = await prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: mixed.versionId, userId: mixed.userId }
      });
      expect(mixedEntry.normalizedSearchText).toContain("helsinki");
      expect(mixedEntry.normalizedSearchText).not.toContain(token);

      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: secretOnly.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: now,
        displayText: null,
        safetyClassificationReasonCode: "lite_secret_only",
        safetyClassificationState: "SECRET_FENCED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        safetyClassifierProviderId: null,
        state: "RETRACTED",
        structuredValue: null
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: secretOnly.factId }
      })).resolves.toMatchObject({
        currentVersionId: null,
        state: "RETRACTED"
      });

      const restoredProjection = await prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: legacyFenced.versionId }
      });
      expect(restoredProjection).toMatchObject({
        contentPurgedAt: null,
        displayText:
          "I work in Espoo. Credential [REDACTED:TOKEN]; keep the commute preference.",
        safetyClassificationReasonCode: "lite_span_redacted",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        safetyClassifierProviderId: null,
        sensitivityClass: "NORMAL",
        state: "ACTIVE"
      });
      expect(JSON.stringify(restoredProjection.structuredValue)).not.toContain(token);
      await expect(prisma.memorySearchEntry.count({
        where: {
          factVersionId: legacyFenced.versionId,
          userId: legacyFenced.userId
        }
      })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: legacyAutomatic.versionId }
      })).resolves.toMatchObject({
        pipelineVersion: "memory-fact-extraction-vnext-v5",
        safetyClassificationReasonCode: "lite_span_redacted",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        safetyClassifierProviderId: null,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE"
      });
      const legacyAutomaticProjection = await prisma.memoryFactVersion
        .findUniqueOrThrow({ where: { id: legacyAutomatic.versionId } });
      expect(JSON.stringify(legacyAutomaticProjection.structuredValue))
        .not.toContain(token);
      expect(JSON.stringify(legacyAutomaticProjection.structuredValue))
        .toContain("[REDACTED:TOKEN]");
      // Safety reprojection may inspect source-authorized legacy facts, but it
      // must not relabel their extraction provenance or make them retrievable
      // under the stricter vNext authority contract.
      await expect(prisma.memorySearchEntry.count({
        where: {
          factVersionId: legacyAutomatic.versionId,
          userId: legacyAutomatic.userId
        }
      })).resolves.toBe(0);
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [
              mixed.userId,
              secretOnly.userId,
              legacyFenced.userId,
              legacyAutomatic.userId
            ]
          }
        }
      });
    }
  });

  it("revives a current-epoch provider failure only after guarded backoff", async () => {
    const fact = await createPendingFact("provider-revival");
    try {
      await reconcileMemoryFactReclassificationJobs(prisma);
      const job = await prisma.memoryJob.findFirstOrThrow({
        where: { kind: "RECLASSIFY_FACTS", userId: fact.userId }
      });
      const failedAt = new Date(job.createdAt.getTime() + 1_000);
      await prisma.memoryJob.update({
        data: {
          attemptCount: 3,
          completedAt: failedAt,
          errorCode: "memory_reclassification_provider_unavailable",
          state: "TERMINAL_FAILED",
          updatedAt: failedAt
        },
        where: { id: job.id }
      });

      await reconcileMemoryFactReclassificationJobs(
        prisma,
        new Date(
          failedAt.getTime() +
          MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS - 1
        )
      );
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ state: "TERMINAL_FAILED" });

      await reconcileMemoryFactReclassificationJobs(
        prisma,
        new Date(
          failedAt.getTime() +
          MEMORY_RECLASSIFICATION_TERMINAL_REVIVAL_BACKOFF_MS + 1
        )
      );
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({
          acceptedResultHash: null,
          attemptCount: 0,
          completedAt: null,
          errorCode: null,
          state: "QUEUED"
        });
    } finally {
      await prisma.user.delete({ where: { id: fact.userId } });
    }
  });

  it("creates a fresh reclassification epoch after master pause and resume", async () => {
    const fact = await createPendingFact("pause-resume");
    const settingsRepository = createPrismaMemorySettingsRepository(prisma);
    try {
      await expect(reconcileMemoryFactReclassificationJobs(prisma))
        .resolves.toBeGreaterThanOrEqual(1);
      const originalJob = await prisma.memoryJob.findFirstOrThrow({
        where: { kind: "RECLASSIFY_FACTS", userId: fact.userId }
      });
      const before = await settingsRepository.get(fact.userId);
      const paused = await settingsRepository.patch(fact.userId, {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        useMemoryFacts: false
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: originalJob.id }
      })).resolves.toMatchObject({
        errorCode: "memory_master_paused",
        state: "CANCELLED"
      });
      const resumed = await settingsRepository.patch(fact.userId, {
        expectedMemoryRevision: paused.memoryRevision,
        expectedSettingsRevision: paused.settingsRevision,
        useMemoryFacts: true
      });

      await expect(reconcileMemoryFactReclassificationJobs(prisma))
        .resolves.toBeGreaterThanOrEqual(1);
      const jobs = await prisma.memoryJob.findMany({
        orderBy: { createdAt: "asc" },
        where: { kind: "RECLASSIFY_FACTS", userId: fact.userId }
      });
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({ id: originalJob.id, state: "CANCELLED" });
      expect(jobs[1]).toMatchObject({
        memoryGenerationSnapshot: resumed.memoryGeneration,
        memoryRevisionSnapshot: resumed.memoryRevision,
        state: "QUEUED"
      });
      expect(jobs[1]?.idempotencyFingerprint).not.toBe(
        originalJob.idempotencyFingerprint
      );
      await expect(prisma.memoryFactVersion.count({
        where: {
          safetyClassificationState: "PENDING",
          userId: fact.userId
        }
      })).resolves.toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: fact.userId } });
    }
  });

  it("rejects a provider result when the memory revision changed before commit", async () => {
    const fact = await createPendingFact("revision-fence");
    const settingsRepository = createPrismaMemorySettingsRepository(prisma);
    const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
    const claimAt = new Date("2026-08-21T09:00:00.000Z");
    try {
      await expect(reconcileMemoryFactReclassificationJobs(prisma))
        .resolves.toBeGreaterThanOrEqual(1);
      const claim = await coordinator.claimJob({
        claimToken: randomUUID(),
        kinds: ["RECLASSIFY_FACTS"],
        leaseExpiresAt: new Date(claimAt.getTime() + 60_000),
        now: claimAt
      });
      expect(claim).not.toBeNull();
      if (!claim) return;
      expect(claim.userId).toBe(fact.userId);
      expect(claim.pipelineVersion).toBe(MEMORY_RECLASSIFICATION_PIPELINE_VERSION);

      const before = await settingsRepository.get(fact.userId);
      const changed = await settingsRepository.patch(fact.userId, {
        expectedMemoryRevision: before.memoryRevision,
        expectedSettingsRevision: before.settingsRevision,
        referenceChatHistory: false
      });
      expect(changed.memoryGeneration).toBe(claim.memoryGenerationSnapshot);
      expect(changed.memoryRevision).toBe(claim.memoryRevisionSnapshot + 1);

      let applied = false;
      await expect(coordinator.commitJobSuccess({
        acceptedResultHash: "c".repeat(64),
        apply: async () => {
          applied = true;
        },
        claim,
        now: new Date(claimAt.getTime() + 1_000),
        stage: "reclassification_applied"
      })).resolves.toBe(true);
      expect(applied).toBe(false);
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: claim.id }
      })).resolves.toMatchObject({
        acceptedResultHash: null,
        errorCode: "memory_source_stale",
        state: "STALE"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: fact.versionId }
      })).resolves.toMatchObject({ safetyClassificationState: "PENDING" });
      await expect(reconcileMemoryFactReclassificationJobs(prisma))
        .resolves.toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.user.delete({ where: { id: fact.userId } });
    }
  });

  it("never discovers or mutates pending legacy scoped facts", async () => {
    const userId = `memory-reclass-legacy-${randomUUID()}`;
    let assistantId: string | null = null;
    await prisma.user.create({
      data: {
        displayName: "Legacy reclassification fixture",
        email: `${userId}@example.test`,
        id: userId,
        status: "active"
      }
    });
    try {
      const folder = await prisma.folder.create({
        data: { name: "Legacy reclassification folder", userId }
      });
      const assistant = await prisma.assistantDefinition.create({
        data: { ownerUserId: userId }
      });
      assistantId = assistant.id;
      const chat = await prisma.chat.create({
        data: { title: "Legacy reclassification chat", userId }
      });
      const scopeRepository = createPrismaMemoryScopeRepository(prisma);
      const scopes = await Promise.all([
        scopeRepository.ensure(userId, { targetId: folder.id, type: "FOLDER" }),
        scopeRepository.ensure(userId, { targetId: assistant.id, type: "ASSISTANT" }),
        scopeRepository.ensure(userId, { targetId: chat.id, type: "CHAT" })
      ]);
      const facts = await Promise.all(scopes.map((scope, index) =>
        createPendingVersion(userId, scope.id, ["folder", "assistant", "chat"][index]!)));
      const repository = createPrismaMemoryReclassificationRepository(prisma);

      await reconcileMemoryFactReclassificationJobs(prisma);
      await expect(repository.pending(userId)).resolves.toEqual([]);
      const before = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const plans = await Promise.all(facts.map(async (fact) => {
        const version = await prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: fact.versionId }
        });
        const candidate: MemoryReclassificationCandidate = {
          category: version.category,
          coreEligible: version.coreEligible,
          coreSalience: version.coreSalience,
          displayText: version.displayText!,
          factId: fact.factId,
          id: fact.versionId,
          modality: version.modality,
          safetyClassificationState: "PENDING",
          semanticState: "ACTIVE",
          sourceMode: version.sourceMode,
          structuredValue: version.structuredValue!,
          systemFrom: version.systemFrom,
          userId
        };
        return {
          candidate,
          result: localLiteResult(candidate)
        } satisfies Readonly<{
          candidate: MemoryReclassificationCandidate;
          result: MemoryReclassificationResult;
        }>;
      }));
      await prisma.$transaction((tx) => repository.apply(
        tx,
        userId,
        plans,
        new Date("2026-08-21T10:00:00.000Z")
      ));

      await expect(prisma.memoryFactVersion.count({
        where: { safetyClassificationState: "PENDING", userId }
      })).resolves.toBe(3);
      await expect(prisma.memoryJob.count({
        where: { kind: "RECLASSIFY_FACTS", userId }
      })).resolves.toBe(0);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ memoryRevision: before.memoryRevision });
    } finally {
      if (assistantId) {
        await prisma.$transaction((tx) => applyMemoryScopeTargetDeletion(tx, {
          scopeType: "ASSISTANT",
          targetId: assistantId!,
          userId
        }));
        await prisma.assistantDefinition.deleteMany({ where: { id: assistantId } });
      }
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
