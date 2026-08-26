import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import {
  createPrismaMemoryExecutionService,
  type MemoryExecutionAuthorityDependencies
} from "../execution";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  resolveCurrentMemoryUtilityPolicy
} from "../execution/policy";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import { applyMemoryScopeTargetDeletion } from "../scopeLifecycle";
import {
  memoryShadowRebuildJobFingerprint,
  MEMORY_SHADOW_REBUILD_PIPELINE_VERSION
} from "../rebuild/contract";
import {
  MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
  MEMORY_RECLASSIFICATION_POLICY_VERSION,
  MEMORY_RECLASSIFICATION_VERSIONS,
  memoryReclassificationAcceptedOutputHash,
  memoryReclassificationInputHash,
  type MemoryReclassificationProvider,
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

const reclassificationSystemConfiguration = Object.freeze({
  adapterKind: "openai_responses_compatible",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: true,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "memory-reclassification-system-test"
} as const);

async function createReclassificationAuthorityFixture(
  userId: string
): Promise<Readonly<{
  authority: MemoryExecutionAuthorityDependencies;
  cleanup(): Promise<void>;
  modelId: string;
  now: Date;
  providerId: string;
}>> {
  const suffix = randomUUID();
  const connectionId = `memory-reclass-authority-connection-${suffix}`;
  const credentialId = `memory-reclass-authority-credential-${suffix}`;
  const credentialVersionId = `memory-reclass-authority-version-${suffix}`;
  const modelId = `memory-reclass-authority-model-${suffix}`;
  const now = new Date();
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-reclassification.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };
  const originalSystemPolicy = await prisma.systemModelPolicy.findUniqueOrThrow({
    select: {
      providerModelId: true,
      reasoningEffort: true,
      updatedByUserId: true
    },
    where: { id: "installation" }
  });
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfiguration,
      activeVersion: 1,
      activatedAt: now,
      displayName: "Memory reclassification authority provider",
      draftConfig: connectionConfiguration,
      draftVersion: 1,
      enabled: true,
      family: "openai_compatible",
      id: connectionId,
      unassignedPolicy: "use_default"
    }
  });
  await prisma.providerCredential.create({
    data: {
      activatedAt: now,
      connectionId,
      draftVersion: 1,
      enabled: true,
      id: credentialId,
      label: "Memory reclassification authority credential",
      testedAt: now
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId,
      id: credentialVersionId,
      secretEnvelope: "memory-reclassification-test-only-envelope",
      testedAt: now,
      testEvidence: { authenticationMode: "bearer" },
      version: 1
    }
  });
  await prisma.providerCredential.update({
    data: { activeVersionId: credentialVersionId },
    where: { id: credentialId }
  });
  await prisma.providerConnection.update({
    data: { defaultCredentialId: credentialId },
    where: { id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: reclassificationSystemConfiguration,
      activeVersion: 1,
      activatedAt: now,
      capabilities: reclassificationSystemConfiguration.capabilities,
      connectionId,
      defaultParams: {},
      displayName: "Memory reclassification authority model",
      draftConfig: reclassificationSystemConfiguration,
      draftVersion: 1,
      enabled: true,
      id: modelId,
      modelClass: "answer",
      modelId: reclassificationSystemConfiguration.upstreamModelId,
      provider: "openai_compatible"
    }
  });
  await prisma.providerModelCredentialCheck.create({
    data: {
      checkedAt: now,
      connectionId,
      connectionVersion: 1,
      credentialId,
      credentialVersionId,
      evidence: {
        detail: "ok",
        structuredOutput: {
          adapterKind: reclassificationSystemConfiguration.adapterKind,
          probeVersion: 2,
          upstreamModelId: reclassificationSystemConfiguration.upstreamModelId,
          verified: true
        }
      },
      modelVersion: 1,
      providerModelId: modelId,
      status: "available"
    }
  });
  await prisma.systemModelPolicy.update({
    data: {
      providerModelId: modelId,
      reasoningEffort: null,
      updatedByUserId: null,
      version: { increment: 1 }
    },
    where: { id: "installation" }
  });
  const policy = await prisma.$transaction(async (tx) => {
    const settings = await tx.userMemorySettings.findUniqueOrThrow({
      where: { userId }
    });
    return resolveCurrentMemoryUtilityPolicy(tx, userId, settings);
  });
  if (!policy.targets.has("MEMORY_RECLASSIFY")) {
    throw new Error("memory_reclassification_authority_fixture_unavailable");
  }
  await prisma.userMemorySettings.update({
    data: {
      acceptedUtilityEgressAt: now,
      acceptedUtilityEgressFingerprint: policy.fingerprint,
      acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
    },
    where: { userId }
  });
  const authority = {
    egressConsentMode: "PER_USER" as const,
    now: () => new Date(now)
  };
  return {
    authority,
    async cleanup() {
      await prisma.usageEvent.deleteMany({ where: { userId } });
      await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
      await prisma.systemModelPolicy.update({
        data: {
          providerModelId: originalSystemPolicy.providerModelId,
          reasoningEffort: originalSystemPolicy.reasoningEffort,
          updatedByUserId: originalSystemPolicy.updatedByUserId,
          version: { increment: 1 }
        },
        where: { id: "installation" }
      });
      await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
      await prisma.providerConnection.updateMany({
        data: { defaultCredentialId: null },
        where: { id: connectionId }
      });
      await prisma.providerCredential.updateMany({
        data: { activeVersionId: null },
        where: { id: credentialId }
      });
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    },
    modelId,
    now,
    providerId: "openai_compatible"
  };
}

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
      evidenceFingerprint: memorySha256({
        endOffset: sourceText.length,
        messageId: message.id,
        sourceMessageContentHash,
        startOffset: 0,
        version: 1
      }),
      factVersionId: input.factVersionId,
      messageId: message.id,
      observedAt: message.createdAt,
      safeExcerpt: sourceText,
      safeSourceHash: sourceMessageContentHash,
      safetyClass: "NORMAL",
      sourceEndOffset: sourceText.length,
      sourceMessageContentHash,
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceRole: "user",
      sourceStartOffset: 0,
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId: input.userId
    }
  });
  await prisma.memoryFactVersion.update({
    data: {
      ingestionFingerprint: memorySha256({
        domain: "memory-reclassification-test",
        factVersionId: input.factVersionId,
        messageId: message.id
      }),
      observedAt: message.createdAt,
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION
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

  it("rejects a settled reclassification output tuple swapped before the default authorized commit", async () => {
    const fact = await createPendingFact("authorized-output-swap");
    let authorityFixture: Awaited<
      ReturnType<typeof createReclassificationAuthorityFixture>
    > | null = null;
    try {
      authorityFixture = await createReclassificationAuthorityFixture(fact.userId);
      await expect(reconcileMemoryFactReclassificationJobs(prisma))
        .resolves.toBeGreaterThanOrEqual(1);
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const claimAt = new Date(authorityFixture.now.getTime() + 1_000);
      const claim = await coordinator.claimJob({
        claimToken: randomUUID(),
        kinds: ["RECLASSIFY_FACTS"],
        leaseExpiresAt: new Date(claimAt.getTime() + 60_000),
        now: claimAt
      });
      expect(claim).not.toBeNull();
      if (!claim) throw new Error("memory_reclassification_swap_claim_missing");
      expect(claim).toMatchObject({
        id: expect.any(String),
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION,
        userId: fact.userId
      });
      const repository = createPrismaMemoryReclassificationRepository(prisma);
      const [candidate] = await repository.pending(fact.userId);
      if (!candidate) throw new Error("memory_reclassification_swap_candidate_missing");
      const baselineSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: fact.userId }
      });
      const inputHash = memoryReclassificationInputHash(
        candidate.displayText,
        candidate.sourceMode
      );
      const firstDecision = result("NORMAL").decision;
      const secondDecision = result("SENSITIVE", {
        category: "sensitive",
        reasonCode: "private_personal",
        responsePreference: false,
        storageDecision: "ALLOW",
        subjectScope: "USER"
      }).decision;
      const firstOutputHash = memoryReclassificationAcceptedOutputHash(
        inputHash,
        firstDecision
      );
      const secondOutputHash = memoryReclassificationAcceptedOutputHash(
        inputHash,
        secondDecision
      );
      expect(secondOutputHash).not.toBe(firstOutputHash);
      const executionService = createPrismaMemoryExecutionService(
        authorityFixture.authority,
        prisma
      );
      const firstBinding = await executionService.admission.bind(fact.userId, {
        inputHash,
        ordinal: 0,
        owner: { memoryJobId: claim.id, type: "JOB" },
        role: "MEMORY_RECLASSIFY",
        versions: MEMORY_RECLASSIFICATION_VERSIONS
      });
      const secondBinding = await executionService.admission.bind(fact.userId, {
        inputHash,
        ordinal: 1,
        owner: { memoryJobId: claim.id, type: "JOB" },
        role: "MEMORY_RECLASSIFY",
        versions: MEMORY_RECLASSIFICATION_VERSIONS
      });
      for (const receipt of [
        { bindingId: firstBinding.id, outputHash: firstOutputHash },
        { bindingId: secondBinding.id, outputHash: secondOutputHash }
      ]) {
        await executionService.admission.start(fact.userId, receipt.bindingId);
        await executionService.lifecycle.settle(fact.userId, receipt.bindingId, {
          acceptedOutputHash: receipt.outputHash,
          errorCode: null,
          providerResponseId: `memory-reclassification-${randomUUID()}`,
          state: "SUCCEEDED",
          usage: {
            cachedInputTokens: 0,
            completeness: "COMPLETE",
            estimatedCostMicros: null,
            inputTokens: 5,
            outputTokens: 2,
            reasoningTokens: 0,
            totalTokens: 7
          }
        });
      }
      const swappedProvider: MemoryReclassificationProvider = Object.freeze({
        async classify(statement, _signal, sourceMode, execution) {
          expect(statement).toBe(candidate.displayText);
          expect(sourceMode).toBe(candidate.sourceMode);
          expect(execution).toEqual({
            jobId: claim.id,
            ordinal: 0,
            userId: fact.userId
          });
          return {
            acceptedOutputHash: secondOutputHash,
            classifiedAt: authorityFixture!.now,
            decision: secondDecision,
            executionId: firstBinding.id,
            inputHash,
            modelId: authorityFixture!.modelId,
            policyVersion: MEMORY_RECLASSIFICATION_POLICY_VERSION,
            providerId: authorityFixture!.providerId
          };
        }
      });
      const handler = createPrismaMemoryReclassificationHandler(prisma, {
        authority: authorityFixture.authority,
        provider: swappedProvider,
        repository
      });
      await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
      const commitAt = new Date(claimAt.getTime() + 1_000);
      const execution = await handler.execute(claim, {
        now: () => commitAt,
        setStage: async () => undefined,
        signal: new AbortController().signal
      });
      await expect(coordinator.commitJobSuccess({
        acceptedResultHash: execution.acceptedResultHash,
        apply: execution.apply,
        claim,
        now: commitAt,
        stage: execution.stage ?? null
      })).rejects.toMatchObject({ code: "memory_execution_state_conflict" });

      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: fact.factId }
      })).resolves.toMatchObject({
        currentVersionId: fact.versionId,
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: fact.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        displayText: "I prefer tea",
        safetyClassificationReasonCode: null,
        safetyClassificationState: "PENDING",
        safetyClassifierExecutionId: null,
        state: "ACTIVE"
      });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: fact.userId }
      })).resolves.toMatchObject({
        memoryGeneration: baselineSettings.memoryGeneration,
        memoryRevision: baselineSettings.memoryRevision,
        settingsRevision: baselineSettings.settingsRevision
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: claim.id }
      })).resolves.toMatchObject({
        acceptedResultHash: null,
        state: "CLAIMED"
      });
      await expect(prisma.memoryExecutionBinding.findMany({
        orderBy: { ordinal: "asc" },
        where: { id: { in: [firstBinding.id, secondBinding.id] } }
      })).resolves.toMatchObject([{
        acceptedOutputHash: firstOutputHash,
        state: "SUCCEEDED"
      }, {
        acceptedOutputHash: secondOutputHash,
        state: "SUCCEEDED"
      }]);
      await expect(Promise.all([
        prisma.memoryFact.count({ where: { userId: fact.userId } }),
        prisma.memoryFactVersion.count({ where: { userId: fact.userId } }),
        prisma.memoryEvidence.count({ where: { userId: fact.userId } }),
        prisma.memoryEvent.count({ where: { userId: fact.userId } }),
        prisma.memorySearchEntry.count({ where: { userId: fact.userId } })
      ])).resolves.toEqual([1, 1, 0, 1, 0]);
    } finally {
      await authorityFixture?.cleanup();
      await prisma.user.deleteMany({ where: { id: fact.userId } });
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
        return {
          candidate: {
            coreEligible: version.coreEligible,
            coreSalience: version.coreSalience,
            displayText: version.displayText!,
            factId: fact.factId,
            id: fact.versionId,
            modality: version.modality,
            semanticState: "ACTIVE",
            sourceMode: version.sourceMode,
            systemFrom: version.systemFrom,
            userId
          },
          result: localSecretResult()
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
