import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../../domain/content";
import { prisma } from "../../../prisma";
import {
  createPrismaMemoryCoordinatorRepository
} from "../../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../../coordinator/types";
import { createPrismaMemoryFactRepository } from "../../persistence/facts";
import { memorySha256 } from "../../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../../persistence/scopes";
import { createPrismaMemorySettingsRepository } from "../../persistence/settings";
import { lockMemorySettings } from "../../persistence/transaction";
import { createMemoryRebuildHandler } from "../../rebuild/handler";
import { createPrismaMemoryRebuildRepository } from "../../rebuild/repository";
import { defaultMemorySourceMutationHooks } from "../../sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../../sourceState";
import { MemorySuppressionKeyring } from "../../suppressionKeyring";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  type MemoryFactExtractionInput
} from "../extraction/contract";
import { decodeMemoryFactExtractionV1 } from "../extraction/decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "../extraction/prompt";
import { createPrismaMemoryFactExtractionRepository } from "../extraction/repository";
import {
  MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
  MEMORY_FACT_CONSOLIDATION_POLICY_VERSION,
  MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION,
  MEMORY_FACT_CONSOLIDATION_SCHEMA_VERSION,
  memoryFactConsolidationJobFingerprint,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationOperation,
  type MemoryFactConsolidationPlan
} from "./contract";
import {
  decodeLegacyMemoryFactConsolidation,
  decodeMemoryFactConsolidation
} from "./decoder";
import { MEMORY_FACT_CONSOLIDATION_TOOL_NAME } from "./prompt";
import { createPrismaMemoryFactConsolidationRepository } from "./repository";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 151));
const keyring = MemorySuppressionKeyring.parse(
  `current=consolidation-v1,consolidation-v1=${keyBytes.toString("base64")}`
);
const coordinator = createPrismaMemoryCoordinatorRepository(prisma);

type CandidateFixture = Readonly<{
  candidateId: string;
  chatId: string;
  extractionJobId: string;
  messageId: string;
  userId: string;
}>;

async function createOwner(label: string): Promise<string> {
  const suffix = randomUUID();
  const userId = `memory-consolidation-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory consolidation test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: {
      learnAutomatically: true,
      referenceChatHistory: false,
      useMemoryFacts: true
    },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryCandidateDecision.deleteMany({ where: { userId } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function createTurn(input: Readonly<{
  createdAt: Date;
  folderId?: string;
  text: string;
  userId: string;
}>) {
  const chat = await prisma.chat.create({
    data: {
      folderId: input.folderId,
      title: `Fact source ${randomUUID()}`,
      userId: input.userId
    }
  });
  const userMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(input.text),
      createdAt: input.createdAt,
      role: "user",
      status: "complete",
      updatedAt: input.createdAt
    }
  });
  const assistantAt = new Date(input.createdAt.getTime() + 1_000);
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Understood."),
      createdAt: assistantAt,
      modelId: "memory-consolidation-test-model",
      parentMessageId: userMessage.id,
      provider: "memory-consolidation-test-provider",
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: chat.id,
      modelId: "memory-consolidation-test-model",
      normalizedRequest: {
        prompt: {
          baseline: {
            source: "standard_chat",
            timeZone: "UTC",
            timeZoneSource: "client"
          }
        }
      },
      provider: "memory-consolidation-test-provider",
      status: "complete",
      userId: input.userId,
      userMessageId: userMessage.id
    }
  });
  await mutateSource(input.userId, chat.id, {
    mutations: ["NORMAL_APPEND"],
    patch: { activeLeafMessageId: assistantMessage.id }
  });
  await mutateSource(input.userId, chat.id, {
    mutations: ["TERMINAL_SETTLEMENT"],
    terminalSettlement: {
      assistantMessageId: assistantMessage.id,
      runId: run.id,
      status: "complete"
    }
  });
  return { assistantMessage, chat, userMessage };
}

async function mutateSource(
  userId: string,
  chatId: string,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">
) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_consolidation_test_chat_missing");
    return applyMemorySourceMutations(tx, {
      ...input,
      chat,
      hooks: defaultMemorySourceMutationHooks
    });
  });
}

async function claimJob(jobId: string): Promise<MemoryJobClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 120_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED"
    },
    where: { id: jobId }
  });
  return {
    activeLeafMessageId: claimed.activeLeafMessageId,
    attemptCount: claimed.attemptCount,
    branchGeneration: claimed.branchGeneration,
    chatId: claimed.chatId,
    claimToken,
    id: claimed.id,
    idempotencyFingerprint: claimed.idempotencyFingerprint,
    kind: claimed.kind,
    leaseExpiresAt,
    memoryGenerationSnapshot: claimed.memoryGenerationSnapshot,
    memoryRevisionSnapshot: claimed.memoryRevisionSnapshot,
    pipelineVersion: claimed.pipelineVersion,
    recoveredLease: false,
    sourceHash: claimed.sourceHash,
    sourceMessageId: claimed.sourceMessageId,
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId,
    userId: claimed.userId
  };
}

async function createSucceededBinding(input: Readonly<{
  inputHash: string;
  jobId: string;
  outputHash: string;
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  role: "MEMORY_CONSOLIDATE" | "MEMORY_FACT_EXTRACT" | "MEMORY_VERIFY";
  schemaVersion: string;
  userId: string;
}>): Promise<string> {
  const id = `memory-decision-binding-${randomUUID()}`;
  const completedAt = new Date();
  const createdAt = new Date(completedAt.getTime() - 1_000);
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: input.outputHash,
      completedAt,
      createdAt,
      destinationFingerprint: "d".repeat(64),
      id,
      inputHash: input.inputHash,
      logicalRole: input.role,
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
      startedAt: createdAt,
      state: "SUCCEEDED",
      usageCompleteness: "UNAVAILABLE",
      userId: input.userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      memoryExecutionBindingId: id,
      modelId: "memory-decision-model-v1",
      provider: "openai_compatible",
      providerModelId: "memory-decision-model-v1",
      userId: input.userId
    }
  });
  return id;
}

function extractionRepository() {
  return createPrismaMemoryFactExtractionRepository(prisma, {
    keyring: () => keyring
  });
}

function consolidationRepository() {
  return createPrismaMemoryFactConsolidationRepository(prisma, {
    keyring: () => keyring
  });
}

async function createCandidate(input: Readonly<{
  createdAt: Date;
  folderId?: string;
  structuredValue: Record<string, unknown>;
  text: string;
  userId: string;
}>): Promise<CandidateFixture> {
  const turn = await createTurn(input);
  const job = await prisma.memoryJob.findFirstOrThrow({
    where: {
      chatId: turn.chat.id,
      kind: "EXTRACT_FACTS",
      state: "QUEUED",
      userId: input.userId
    }
  });
  const claim = await claimJob(job.id);
  const prepared = await extractionRepository().prepare(claim);
  if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
  const extractionInput: MemoryFactExtractionInput = prepared.input;
  const plan = decodeMemoryFactExtractionV1([{
    arguments: {
      candidates: [{
        category: "preferences",
        confidence_band: "HIGH",
        correction: false,
        future_useful: true,
        quote: input.text,
        reason_code: "durable_preference",
        response_preference: input.text,
        sensitivity: "NORMAL",
        statement: input.text,
        temporary: false
      }]
    },
    id: `extract-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], extractionInput);
  const extractedCandidate = plan.candidates[0];
  if (!extractedCandidate) throw new Error("memory_candidate_fixture_missing");
  const legacyCandidateId = memorySha256({
    candidate: {
      category: extractedCandidate.category,
      confidence: extractedCandidate.confidence,
      coreEligible: extractedCandidate.coreEligible,
      coreSalience: extractedCandidate.coreSalience,
      directness: extractedCandidate.directness,
      displayText: extractedCandidate.displayText,
      evidence: extractedCandidate.evidence.map((evidence) => ({
        endOffset: evidence.endOffset,
        messageId: evidence.messageId,
        sourceTextHash: evidence.sourceTextHash,
        startOffset: evidence.startOffset
      })),
      importance: extractedCandidate.importance,
      languageCode: extractedCandidate.languageCode,
      modality: extractedCandidate.modality,
      negated: extractedCandidate.negated,
      proposedValue: extractedCandidate.proposedValue,
      rawTemporalExpression: extractedCandidate.rawTemporalExpression,
      reasonCode: null,
      scope: extractedCandidate.scope,
      sensitivity: extractedCandidate.sensitivity,
      state: "PENDING",
      temporalResolutionEvidence: extractedCandidate.temporalResolutionEvidence,
      validFrom: extractedCandidate.validFrom,
      validTo: extractedCandidate.validTo
    },
    domain: "aiqsa.memory.fact-candidate",
    source: {
      chatId: extractionInput.source.chatId,
      userId: extractionInput.source.userId
    },
    version: 1
  });
  const bindingId = await createSucceededBinding({
    inputHash: extractionInput.inputHash,
    jobId: claim.id,
    outputHash: plan.outputHash,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
    role: "MEMORY_FACT_EXTRACT",
    schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
    userId: input.userId
  });
  const committed = await coordinator.commitJobSuccess({
    acceptedResultHash: plan.outputHash,
    apply: async (tx, exactClaim) => {
      const candidate = extractedCandidate;
      if (
        exactClaim.branchGeneration === null || exactClaim.chatId === null ||
        exactClaim.sourceHash === null || exactClaim.sourceRevision === null
      ) throw new Error("memory_candidate_fixture_source_missing");
      const sourceChatId = exactClaim.chatId;
      // Slice 1 promotes active vNext extraction directly to MemoryFact. This
      // suite still owns the retained legacy consolidation module, so seed its
      // input boundary explicitly instead of routing a live extraction job
      // through an obsolete candidate-producing path.
      await tx.memoryCandidate.create({
        data: {
          branchGeneration: exactClaim.branchGeneration,
          chatId: sourceChatId,
          confidence: candidate.confidence,
          createdByExecutionId: bindingId,
          id: legacyCandidateId,
          importance: candidate.importance,
          jobId: exactClaim.id,
          languageCode: candidate.languageCode,
          negated: candidate.negated,
          pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
          proposedCanonicalKey: candidate.canonicalKey,
          proposedCategory: candidate.category,
          proposedCoreEligible: candidate.coreEligible,
          proposedCoreSalience: candidate.coreSalience,
          proposedDirectness: candidate.directness,
          proposedDisplayText: candidate.displayText,
          proposedModality: candidate.modality,
          proposedScope: {
            target_id: candidate.scope.targetId,
            type: candidate.scope.type
          },
          proposedSensitivity: candidate.sensitivity,
          proposedValidFrom: candidate.validFrom
            ? new Date(candidate.validFrom)
            : null,
          proposedValidTo: candidate.validTo ? new Date(candidate.validTo) : null,
          proposedValue: candidate.proposedValue === null
            ? Prisma.JsonNull
            : candidate.proposedValue as Prisma.InputJsonValue,
          rawTemporalExpression: candidate.rawTemporalExpression,
          reasonCode: candidate.reasonCode,
          sourceHash: exactClaim.sourceHash,
          sourceProjectionHash: plan.input.sourceProjectionHash,
          sourceProjectionVersion: plan.input.sourceProjectionVersion,
          sourceRevision: exactClaim.sourceRevision,
          sourceTimezone: plan.input.timeZone,
          state: candidate.state,
          temporalResolutionEvidence: candidate.temporalResolutionEvidence === null
            ? Prisma.DbNull
            : candidate.temporalResolutionEvidence as Prisma.InputJsonValue,
          userId: exactClaim.userId
        }
      });
      await tx.memoryCandidateMessage.createMany({
        data: candidate.evidence.map((evidence, ordinal) => ({
          candidateId: legacyCandidateId,
          chatId: sourceChatId,
          endOffset: evidence.endOffset,
          messageId: evidence.messageId,
          ordinal,
          sourceTextHash: evidence.sourceTextHash,
          startOffset: evidence.startOffset,
          userId: exactClaim.userId
        }))
      });
    },
    claim,
    now: new Date(),
    stage: "fact_candidates_ready"
  });
  if (!committed) throw new Error("memory_candidate_commit_failed");
  return {
    candidateId: legacyCandidateId,
    chatId: turn.chat.id,
    extractionJobId: claim.id,
    messageId: turn.userMessage.id,
    userId: input.userId
  };
}

async function cloneCandidateIntoLegacyFolder(
  candidate: CandidateFixture,
  folderId: string
): Promise<CandidateFixture> {
  const original = await prisma.memoryCandidate.findUniqueOrThrow({
    where: { id: candidate.candidateId }
  });
  const evidence = await prisma.memoryCandidateMessage.findMany({
    orderBy: [{ ordinal: "asc" }, { messageId: "asc" }],
    where: { candidateId: candidate.candidateId, userId: candidate.userId }
  });
  const scope = { targetId: folderId, type: "FOLDER" as const };
  const legacyId = memorySha256({
    candidate: {
      category: original.proposedCategory,
      confidence: original.confidence,
      coreEligible: original.proposedCoreEligible,
      coreSalience: original.proposedCoreSalience,
      directness: original.proposedDirectness,
      displayText: original.proposedDisplayText,
      evidence: evidence.map((item) => ({
        endOffset: item.endOffset,
        messageId: item.messageId,
        sourceTextHash: item.sourceTextHash,
        startOffset: item.startOffset
      })),
      importance: original.importance,
      languageCode: original.languageCode,
      modality: original.proposedModality,
      negated: original.negated,
      proposedValue: original.proposedValue,
      rawTemporalExpression: original.rawTemporalExpression,
      reasonCode: null,
      scope,
      sensitivity: original.proposedSensitivity,
      state: "PENDING",
      temporalResolutionEvidence: original.temporalResolutionEvidence,
      validFrom: original.proposedValidFrom?.toISOString() ?? null,
      validTo: original.proposedValidTo?.toISOString() ?? null
    },
    domain: "aiqsa.memory.fact-candidate",
    source: { chatId: original.chatId, userId: original.userId },
    version: 1
  });
  await prisma.$transaction(async (tx) => {
    await tx.memoryCandidate.create({
      data: {
        ...original,
        id: legacyId,
        proposedScope: { target_id: folderId, type: "FOLDER" },
        proposedValue: original.proposedValue === null
          ? Prisma.JsonNull
          : original.proposedValue as Prisma.InputJsonValue,
        temporalResolutionEvidence: original.temporalResolutionEvidence === null
          ? Prisma.DbNull
          : original.temporalResolutionEvidence as Prisma.InputJsonValue
      }
    });
    await tx.memoryCandidateMessage.createMany({
      data: evidence.map(({ candidateId: _candidateId, ...item }) => ({
        ...item,
        candidateId: legacyId
      }))
    });
  });
  return { ...candidate, candidateId: legacyId };
}

async function prepareConsolidation(candidate: CandidateFixture): Promise<Readonly<{
  claim: MemoryJobClaim;
  input: MemoryFactConsolidationInput;
}>> {
  const job = await enqueueLegacyConsolidationFixture(candidate);
  const claim = await claimJob(job.id);
  const prepared = await consolidationRepository().prepareConsolidation(claim);
  if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
  return { claim, input: prepared.input };
}

async function enqueueLegacyConsolidationFixture(candidate: CandidateFixture) {
  const [source, sourceJob, settings] = await Promise.all([
    prisma.memoryCandidate.findUniqueOrThrow({
      select: {
        branchGeneration: true,
        chatId: true,
        sourceHash: true,
        sourceRevision: true
      },
      where: { id: candidate.candidateId }
    }),
    prisma.memoryJob.findUniqueOrThrow({
      select: { activeLeafMessageId: true },
      where: { id: candidate.extractionJobId }
    }),
    prisma.userMemorySettings.findUniqueOrThrow({
      select: { memoryGeneration: true, memoryRevision: true },
      where: { userId: candidate.userId }
    })
  ]);
  if (!sourceJob.activeLeafMessageId) {
    throw new Error("memory_consolidation_fixture_leaf_missing");
  }
  return prisma.memoryJob.create({
    data: {
      activeLeafMessageId: sourceJob.activeLeafMessageId,
      branchGeneration: source.branchGeneration,
      chatId: source.chatId,
      idempotencyFingerprint: memoryFactConsolidationJobFingerprint({
        candidateId: candidate.candidateId,
        sourceHash: source.sourceHash,
        sourceRevision: source.sourceRevision
      }),
      kind: "CONSOLIDATE_CANDIDATE",
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      pipelineVersion: MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
      sourceHash: source.sourceHash,
      sourceRevision: source.sourceRevision,
      userId: candidate.userId
    }
  });
}

function consolidationPlan(
  input: MemoryFactConsolidationInput,
  operation: MemoryFactConsolidationOperation
): MemoryFactConsolidationPlan {
  const targeted = ["REINFORCE", "SUPERSEDE", "CONFLICT", "EXPIRE"]
    .includes(operation);
  const target = targeted
    ? input.relatedFacts.find((fact) =>
        fact.scope.type === input.candidate.scope.type &&
        fact.scope.targetId === input.candidate.scope.targetId &&
        fact.state === "ACTIVE")
    : null;
  if (targeted && (!target || !target.currentVersionId)) {
    throw new Error("memory_consolidation_test_target_missing");
  }
  const reasons = {
    ADD: "new_supported_fact",
    CONFLICT: "simultaneous_contradiction",
    DEFER: "insufficient_support",
    EXPIRE: "direct_end_evidence",
    NOOP: "duplicate_or_explicit",
    REINFORCE: "same_current_value",
    SUPERSEDE: "direct_newer_evidence"
  } as const;
  return decodeLegacyMemoryFactConsolidation([{
    arguments: {
      candidate_id: input.candidate.id,
      effective_from: operation === "SUPERSEDE" ? input.candidate.validFrom : null,
      evidence_ids: input.candidate.evidence.map(({ messageId }) => messageId),
      operation,
      reason_code: reasons[operation],
      target_fact_id: target?.id ?? null,
      target_version_id: target?.currentVersionId ?? null
    },
    id: `consolidate-call-${randomUUID()}`,
    name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME
  }], input);
}

async function bindConsolidation(
  claim: MemoryJobClaim,
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan
): Promise<string> {
  return createSucceededBinding({
    inputHash: input.inputHash,
    jobId: claim.id,
    outputHash: plan.outputHash,
    pipelineVersion: MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_CONSOLIDATION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION,
    role: "MEMORY_CONSOLIDATE",
    schemaVersion: MEMORY_FACT_CONSOLIDATION_SCHEMA_VERSION,
    userId: claim.userId
  });
}

async function commitConsolidation(input: Readonly<{
  bindingId: string;
  claim: MemoryJobClaim;
  input: MemoryFactConsolidationInput;
  plan: MemoryFactConsolidationPlan;
}>): Promise<void> {
  const committed = await coordinator.commitJobSuccess({
    acceptedResultHash: input.plan.outputHash,
    apply: (tx, exactClaim) => consolidationRepository().applyConsolidation(
      tx,
      exactClaim,
      input.input,
      input.plan,
      input.bindingId,
      new Date()
    ),
    claim: input.claim,
    now: new Date(),
    stage: "consolidation_applied"
  });
  if (!committed) throw new Error("memory_consolidation_commit_failed");
}

async function processLexicalRebuild(
  jobId: string,
  repository: ReturnType<typeof createPrismaMemoryRebuildRepository>
): Promise<void> {
  const claim = await claimJob(jobId);
  const handler = createMemoryRebuildHandler(repository);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const now = new Date();
  const result = await handler.execute(claim, {
    now: () => now,
    setStage: async () => undefined,
    signal: new AbortController().signal
  });
  await expect(coordinator.commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  })).resolves.toBe(true);
}

async function addCandidateAsFact(candidate: CandidateFixture): Promise<string> {
  const prepared = await prepareConsolidation(candidate);
  const plan = consolidationPlan(prepared.input, "ADD");
  const bindingId = await bindConsolidation(prepared.claim, prepared.input, plan);
  await commitConsolidation({ ...prepared, bindingId, plan });
  const row = await prisma.memoryCandidate.findUniqueOrThrow({
    select: { resolvedFactId: true },
    where: { id: candidate.candidateId }
  });
  if (!row.resolvedFactId) throw new Error("memory_consolidation_test_fact_missing");
  return row.resolvedFactId;
}

async function saveExplicitFact(userId: string): Promise<Readonly<{
  factId: string;
  versionId: string;
}>> {
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  const statement = "I prefer coffee.";
  const authorizationId = `explicit-race-${randomUUID()}`;
  return createPrismaMemoryFactRepository(keyring, prisma, {
    consumeExplicitAuthorization: async () => undefined
  }).save(userId, {
    authorization: {
      action: "SAVE",
      authorizationId,
      authorizedPayloadHash: memorySha256(statement)
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: new Date("2026-08-11T15:00:00.000Z"),
      safeExcerpt: statement,
      safeSourceHash: memorySha256(statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-explicit-action-v1"
    },
    explicitSuppressionOverride: true,
    idempotencyFingerprint: memorySha256({ authorizationId, version: 1 }),
    requestId: `request-${randomUUID()}`,
    scopeId: scope.id,
    value: {
      canonicalKey: "user.preference.drink",
      category: "preference",
      confidence: 1,
      directness: "DIRECT",
      displayText: statement,
      importance: 1,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "memory-explicit-api-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      structuredValue: { drink: "coffee" }
    }
  });
}

describe("Prisma Memory fact consolidation", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(["AUTOMATIC_FACTS", "ALL_REUSABLE"] as const)(
    "rejects delayed candidate consolidation across a %s cutoff",
    async (barrierKind) => {
    const userId = await createOwner(`${barrierKind.toLowerCase()}-cutoff`);
    try {
      const sourceAt = new Date("2026-08-11T07:00:00.000Z");
      const candidate = await createCandidate({
        createdAt: sourceAt,
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      await prisma.memorySourceBarrier.create({
        data: {
          explicitOverrideAllowed: false,
          kind: barrierKind,
          memoryGeneration: settings.memoryGeneration,
          sourceCreatedAtCutoff: new Date(sourceAt.getTime() + 60_000),
          userId
        }
      });

      const job = await enqueueLegacyConsolidationFixture(candidate);
      const claim = await claimJob(job.id);
      await expect(consolidationRepository().prepareConsolidation(claim))
        .resolves.toEqual({
          decision: {
            errorCode: "memory_fact_candidate_stale",
            status: "STALE"
          }
        });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("retains legacy A/C, rejects delayed B, and excludes all three from the vNext index", async () => {
    const userId = await createOwner("learn-pause-abc");
    const pausedAt = new Date("2026-08-21T10:12:00.000Z");
    const resumedAt = new Date("2026-08-21T10:20:00.000Z");
    let settingsNow = pausedAt;
    const settingsRepository = createPrismaMemorySettingsRepository(prisma, {
      now: () => settingsNow
    });
    try {
      const candidateA = await createCandidate({
        createdAt: new Date("2026-08-21T10:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "A-before: I prefer tea.",
        userId
      });
      const factAId = await addCandidateAsFact(candidateA);
      const factA = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factAId }
      });

      // Prepare B just before the OFF transaction wins. The source timestamp
      // lands exactly on the inclusive pause boundary; apply must re-read the
      // durable interval after resume even if a lease is later recovered.
      const turnB = await createTurn({
        createdAt: pausedAt,
        text: "B-during: I prefer the forbidden delayed value.",
        userId
      });
      const bJob = await prisma.memoryJob.findFirstOrThrow({
        where: {
          chatId: turnB.chat.id,
          kind: "EXTRACT_FACTS",
          state: "QUEUED",
          userId
        }
      });
      const bClaim = await claimJob(bJob.id);
      const bPrepared = await extractionRepository().prepare(bClaim);
      if ("decision" in bPrepared) throw new Error(bPrepared.decision.errorCode);
      expect(bPrepared.input.messages.map(({ id }) => id))
        .toEqual([turnB.userMessage.id]);
      expect(bPrepared.input.messages
        .filter(({ evidenceEligible }) => evidenceEligible)
        .map(({ id }) => id)).toEqual([turnB.userMessage.id]);
      const bPlan = decodeMemoryFactExtractionV1([{
        arguments: {
          candidates: [{
            category: "preferences",
            confidence_band: "HIGH",
            correction: false,
            future_useful: true,
            quote: "B-during: I prefer the forbidden delayed value.",
            reason_code: "durable_preference",
            response_preference: "the forbidden delayed value",
            sensitivity: "NORMAL",
            statement: "B-during: I prefer the forbidden delayed value.",
            temporary: false
          }]
        },
        id: `extract-call-${randomUUID()}`,
        name: MEMORY_FACT_EXTRACTION_TOOL_NAME
      }], bPrepared.input);
      const bBindingId = await createSucceededBinding({
        inputHash: bPrepared.input.inputHash,
        jobId: bClaim.id,
        outputHash: bPlan.outputHash,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
        promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
        role: "MEMORY_FACT_EXTRACT",
        schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
        userId
      });

      const beforePause = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const paused = await settingsRepository.patch(userId, {
        expectedMemoryRevision: beforePause.memoryRevision,
        expectedSettingsRevision: beforePause.settingsRevision,
        learnAutomatically: false
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: bClaim.id } }))
        .resolves.toMatchObject({
          errorCode: "memory_automatic_learning_paused",
          state: "CANCELLED"
        });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factAId } }))
        .resolves.toMatchObject({
          currentVersionId: factA.currentVersionId,
          state: "ACTIVE"
        });
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: factA.currentVersionId, userId }
      })).resolves.toBe(1);

      settingsNow = resumedAt;
      await settingsRepository.patch(userId, {
        expectedMemoryRevision: paused.memoryRevision,
        expectedSettingsRevision: paused.settingsRevision,
        learnAutomatically: true
      });
      await expect(prisma.memoryPauseInterval.findFirstOrThrow({
        where: { scope: "AUTOMATIC_LEARNING", userId }
      })).resolves.toMatchObject({ pausedAt, resumedAt });

      // Restore only the synthetic raced lease. Admission must still reject
      // the formerly prepared B plan because prepareWith re-reads intervals.
      await prisma.memoryJob.update({
        data: {
          completedAt: null,
          errorCode: null,
          leaseExpiresAt: new Date(Date.now() + 120_000),
          leaseToken: bClaim.claimToken,
          state: "CLAIMED"
        },
        where: { id: bClaim.id }
      });
      await expect(prisma.$transaction(async (tx) => {
        const settings = await lockMemorySettings(tx, userId, true);
        return extractionRepository().apply(
          tx,
          settings,
          bClaim,
          bPlan,
          bBindingId,
          new Date()
        );
      })).resolves.toBe("STALE");
      await expect(prisma.memoryCandidate.findUnique({
        where: { id: bPlan.candidates[0]!.id }
      })).resolves.toBeNull();

      const candidateC = await createCandidate({
        createdAt: new Date("2026-08-21T10:22:00.000Z"),
        structuredValue: { color: "blue" },
        text: "C-after: I prefer blue dashboards.",
        userId
      });
      const factCId = await addCandidateAsFact(candidateC);
      const factC = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factCId }
      });
      expect(factC.id).not.toBe(factA.id);

      const rebuildRepository = createPrismaMemoryRebuildRepository(prisma);
      const rebuildSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const admitted = await rebuildRepository.admit(userId, {
        expectedMemoryRevision: rebuildSettings.memoryRevision,
        expectedSettingsRevision: rebuildSettings.settingsRevision,
        operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: `learn-pause-abc-${randomUUID()}` }
      });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      await processLexicalRebuild(admitted.jobId, rebuildRepository);

      const activeSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const rebuiltFactVersionIds = (await prisma.memorySearchEntry.findMany({
        orderBy: { factVersionId: "asc" },
        select: { factVersionId: true },
        where: {
          indexGenerationId: activeSettings.activeIndexGenerationId!,
          itemType: "FACT_VERSION",
          userId
        }
      })).flatMap(({ factVersionId }) => factVersionId ? [factVersionId] : []);
      expect(rebuiltFactVersionIds).toEqual([]);
      await expect(prisma.memoryFactVersion.count({
        where: {
          displayText: { contains: "B-during" },
          sourceMode: "AUTOMATIC",
          userId
        }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects a valid matching-folder legacy candidate before consolidation", async () => {
    const userId = await createOwner("legacy-candidate-scope");
    try {
      const folder = await prisma.folder.create({
        data: { name: "Legacy candidate folder", userId }
      });
      const canonical = await createCandidate({
        createdAt: new Date("2026-08-11T07:30:00.000Z"),
        folderId: folder.id,
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const legacy = await cloneCandidateIntoLegacyFolder(canonical, folder.id);
      const job = await enqueueLegacyConsolidationFixture(legacy);
      const claim = await claimJob(job.id);

      await expect(consolidationRepository().prepareConsolidation(claim))
        .resolves.toEqual({
          decision: {
            errorCode: "memory_fact_candidate_stale",
            status: "STALE"
          }
        });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("atomically adds and reinforces one logical fact without duplicate support", async () => {
    const userId = await createOwner("add-reinforce");
    try {
      const first = await createCandidate({
        createdAt: new Date("2026-08-11T08:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const prepared = await prepareConsolidation(first);
      const plan = consolidationPlan(prepared.input, "ADD");
      const bindingId = await bindConsolidation(prepared.claim, prepared.input, plan);

      await expect(coordinator.commitJobSuccess({
        acceptedResultHash: plan.outputHash,
        apply: async (tx, exactClaim) => {
          await consolidationRepository().applyConsolidation(
            tx,
            exactClaim,
            prepared.input,
            plan,
            bindingId,
            new Date()
          );
          throw new Error("memory_consolidation_crash_fixture");
        },
        claim: prepared.claim,
        now: new Date(),
        stage: "consolidation_applied"
      })).rejects.toMatchObject({
        code: "memory_job_commit_failed",
        retryable: false
      });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryCandidateDecision.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: first.candidateId }
      })).resolves.toMatchObject({ state: "PENDING" });

      await commitConsolidation({ ...prepared, bindingId, plan });
      const fact = await prisma.memoryFact.findFirstOrThrow({ where: { userId } });
      expect(fact).toMatchObject({
        currentVersionId: expect.any(String),
        state: "ACTIVE"
      });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: first.candidateId }
      })).resolves.toMatchObject({
        resolvedFactId: fact.id,
        state: "PROMOTED"
      });
      await expect(prisma.memoryCandidateDecision.findFirstOrThrow({
        where: { candidateId: first.candidateId, userId }
      })).resolves.toMatchObject({ operation: "ADD", state: "APPLIED" });
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: fact.currentVersionId, userId }
      })).resolves.toBe(1);

      const repeated = await createCandidate({
        createdAt: new Date("2026-08-11T09:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "Tea is always my first choice.",
        userId
      });
      const reinforcement = await prepareConsolidation(repeated);
      const reinforcePlan = consolidationPlan(reinforcement.input, "REINFORCE");
      const reinforceBinding = await bindConsolidation(
        reinforcement.claim,
        reinforcement.input,
        reinforcePlan
      );
      await commitConsolidation({
        ...reinforcement,
        bindingId: reinforceBinding,
        plan: reinforcePlan
      });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { factId: fact.id, userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: fact.currentVersionId!, stance: "SUPPORTS", userId }
      })).resolves.toBe(2);

      const replayed = await consolidationRepository().prepareConsolidation(
        reinforcement.claim
      );
      expect(replayed).toMatchObject({
        decision: { status: "STALE" }
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("applies v1 SAME as a targeted semantic no-op", async () => {
    const userId = await createOwner("same-noop-target");
    try {
      const original = await createCandidate({
        createdAt: new Date("2026-08-11T09:05:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const factId = await addCandidateAsFact(original);
      const fact = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      });
      const versionId = fact.currentVersionId!;
      const duplicate = await createCandidate({
        createdAt: new Date("2026-08-11T09:10:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "Tea is still my preference.",
        userId
      });
      const prepared = await prepareConsolidation(duplicate);
      expect(prepared.input.relatedFacts).toContainEqual(expect.objectContaining({
        currentVersionId: versionId,
        id: factId,
        state: "ACTIVE"
      }));
      const plan = decodeMemoryFactConsolidation([{
        arguments: {
          candidate_id: prepared.input.candidate.id,
          comparison: "SAME",
          evidence_ids: prepared.input.candidate.evidence.map(({ messageId }) => messageId),
          target_fact_id: factId,
          target_version_id: versionId
        },
        id: `consolidate-call-${randomUUID()}`,
        name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME
      }], prepared.input);
      expect(plan).toMatchObject({
        operation: "NOOP",
        targetFactId: factId,
        targetVersionId: versionId
      });
      const bindingId = await bindConsolidation(prepared.claim, prepared.input, plan);
      const semanticBefore = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryRevision: true },
          where: { userId }
        }),
        prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }),
        prisma.memoryFactVersion.count({ where: { factId, userId } }),
        prisma.memoryEvidence.count({ where: { factVersionId: versionId, userId } }),
        prisma.memorySearchEntry.count({ where: { factVersionId: versionId, userId } }),
        prisma.memoryEvent.count({ where: { factId, userId } })
      ]);

      await expect(commitConsolidation({ ...prepared, bindingId, plan }))
        .resolves.toBeUndefined();

      await expect(prisma.memoryJob.findUniqueOrThrow({
        where: { id: prepared.claim.id }
      })).resolves.toMatchObject({
        stage: "consolidation_applied",
        state: "SUCCEEDED"
      });
      await expect(prisma.memoryCandidateDecision.findFirstOrThrow({
        where: { candidateId: duplicate.candidateId, userId }
      })).resolves.toMatchObject({
        operation: "NOOP",
        state: "APPLIED",
        targetFactId: factId,
        targetVersionId: versionId
      });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: duplicate.candidateId }
      })).resolves.toMatchObject({
        reasonCode: "consolidation_noop",
        resolvedAt: expect.any(Date),
        resolvedFactId: null,
        state: "REJECTED"
      });
      await expect(Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryRevision: true },
          where: { userId }
        }),
        prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }),
        prisma.memoryFactVersion.count({ where: { factId, userId } }),
        prisma.memoryEvidence.count({ where: { factVersionId: versionId, userId } }),
        prisma.memorySearchEntry.count({ where: { factVersionId: versionId, userId } }),
        prisma.memoryEvent.count({ where: { factId, userId } })
      ])).resolves.toEqual(semanticBefore);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("supplies a bounded same-scope neighborhood without canonical-key identity", async () => {
    const userId = await createOwner("entity-neighborhood");
    try {
      const tea = await createCandidate({
        createdAt: new Date("2026-08-11T09:15:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      await addCandidateAsFact(tea);
      const paraphrase = await createCandidate({
        createdAt: new Date("2026-08-11T09:20:00.000Z"),
        structuredValue: { beverage: "tea" },
        text: "I always choose tea.",
        userId
      });
      const prepared = await prepareConsolidation(paraphrase);
      expect(prepared.input.relatedFacts).toHaveLength(1);
      expect(prepared.input.relatedFacts[0]).toMatchObject({
        scope: { targetId: null, type: "GLOBAL_USER" }
      });
      expect(prepared.input.relatedFacts[0]!.canonicalKey)
        .toMatch(/^prop:v1:[a-f0-9]{64}$/u);
      expect(prepared.input.relatedFacts[0]!.canonicalKey)
        .not.toBe(prepared.input.candidate.canonicalKey);
      expect(prepared.input.relatedFacts[0]?.versions).toHaveLength(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("fails closed when an explicit fact wins the race after consolidation input", async () => {
    const userId = await createOwner("explicit-race");
    try {
      const automatic = await createCandidate({
        createdAt: new Date("2026-08-11T09:30:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const prepared = await prepareConsolidation(automatic);
      const plan = consolidationPlan(prepared.input, "ADD");
      const bindingId = await bindConsolidation(prepared.claim, prepared.input, plan);
      const explicit = await saveExplicitFact(userId);

      await commitConsolidation({ ...prepared, bindingId, plan });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: automatic.candidateId }
      })).resolves.toMatchObject({
        reasonCode: "consolidation_precondition_stale",
        resolvedFactId: null,
        state: "REJECTED"
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: explicit.factId }
      })).resolves.toMatchObject({
        currentVersionId: explicit.versionId,
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: explicit.versionId }
      })).resolves.toMatchObject({ sourceMode: "EXPLICIT", state: "ACTIVE" });
      await expect(prisma.memoryCandidateDecision.count({
        where: { candidateId: automatic.candidateId, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({
        where: { sourceMode: "AUTOMATIC", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("retains explicit authority without attaching automatic support", async () => {
    const userId = await createOwner("explicit-support-invalidation");
    try {
      const reinforcement = await createCandidate({
        createdAt: new Date("2026-08-11T15:10:00.000Z"),
        structuredValue: { drink: "coffee" },
        text: "I prefer coffee.",
        userId
      });
      const explicit = await saveExplicitFact(userId);
      const prepared = await prepareConsolidation(reinforcement);
      expect(prepared.input.relatedFacts).toEqual([]);
      const plan = decodeMemoryFactConsolidation([{
        arguments: {
          candidate_id: prepared.input.candidate.id,
          comparison: "AMBIGUOUS",
          evidence_ids: prepared.input.candidate.evidence.map(({ messageId }) => messageId),
          target_fact_id: null,
          target_version_id: null
        },
        id: `consolidate-call-${randomUUID()}`,
        name: MEMORY_FACT_CONSOLIDATION_TOOL_NAME
      }], prepared.input);
      const bindingId = await bindConsolidation(prepared.claim, prepared.input, plan);
      await commitConsolidation({ ...prepared, bindingId, plan });

      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: explicit.versionId, userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: reinforcement.candidateId }
      })).resolves.toMatchObject({
        reasonCode: "unsafe_or_ambiguous",
        state: "REJECTED"
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: explicit.factId }
      })).resolves.toMatchObject({
        currentVersionId: explicit.versionId,
        lastConfirmedAt: new Date("2026-08-11T15:00:00.000Z"),
        state: "ACTIVE"
      });

      await mutateSource(userId, reinforcement.chatId, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: null }
      });

      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: explicit.factId }
      })).resolves.toMatchObject({
        currentVersionId: explicit.versionId,
        lastConfirmedAt: new Date("2026-08-11T15:00:00.000Z"),
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: explicit.versionId }
      })).resolves.toMatchObject({ sourceMode: "EXPLICIT", state: "ACTIVE" });
      await expect(prisma.memoryEvidence.count({
        where: {
          factVersionId: explicit.versionId,
          sourceType: "MESSAGE",
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({
        where: {
          factVersionId: explicit.versionId,
          sourceType: "EXPLICIT_ACTION",
          userId
        }
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: explicit.versionId, userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("applies a newer direct correction without a second verifier", async () => {
    const userId = await createOwner("direct-correction");
    try {
      const tea = await createCandidate({
        createdAt: new Date("2026-08-11T10:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const factId = await addCandidateAsFact(tea);
      const oldVersionId = (await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      })).currentVersionId!;

      const coffee = await createCandidate({
        createdAt: new Date("2026-08-11T11:00:00.000Z"),
        structuredValue: { drink: "coffee" },
        text: "I prefer coffee now.",
        userId
      });
      const proposed = await prepareConsolidation(coffee);
      const supersede = consolidationPlan(proposed.input, "SUPERSEDE");
      const consolidationBinding = await bindConsolidation(
        proposed.claim,
        proposed.input,
        supersede
      );
      await commitConsolidation({
        ...proposed,
        bindingId: consolidationBinding,
        plan: supersede
      });
      const superseded = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      });
      expect(superseded).toMatchObject({
        currentVersionId: expect.not.stringMatching(oldVersionId),
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: oldVersionId }
      })).resolves.toMatchObject({ state: "SUPERSEDED", systemTo: expect.any(Date) });
      await expect(prisma.memoryCandidateDecision.findFirstOrThrow({
        where: { candidateId: coffee.candidateId, userId }
      })).resolves.toMatchObject({
        operation: "SUPERSEDE",
        requiresVerification: false,
        state: "APPLIED",
        verificationExecutionId: null,
        verificationOutputHash: null
      });
      await expect(prisma.memoryJob.count({
        where: { kind: "VERIFY_CANDIDATE", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("normalizes a conflict to one then zero claims as source evidence disappears", async () => {
    const userId = await createOwner("conflict-normalization");
    try {
      const tea = await createCandidate({
        createdAt: new Date("2026-08-11T13:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const factId = await addCandidateAsFact(tea);
      const teaVersionId = (await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      })).currentVersionId!;
      const coffee = await createCandidate({
        createdAt: new Date("2026-08-11T13:00:00.000Z"),
        structuredValue: { drink: "coffee" },
        text: "I prefer coffee too.",
        userId
      });
      const proposed = await prepareConsolidation(coffee);
      const conflict = consolidationPlan(proposed.input, "CONFLICT");
      const consolidationBinding = await bindConsolidation(
        proposed.claim,
        proposed.input,
        conflict
      );
      await commitConsolidation({
        ...proposed,
        bindingId: consolidationBinding,
        plan: conflict
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "CONFLICTED" });
      await expect(prisma.memoryFactVersion.count({
        where: { factId, state: "CONFLICTING", userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryJob.count({
        where: { kind: "VERIFY_CANDIDATE", userId }
      })).resolves.toBe(0);

      await mutateSource(userId, coffee.chatId, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: null }
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: teaVersionId, state: "ACTIVE" });
      await expect(prisma.memoryFactVersion.findFirstOrThrow({
        where: { factId, id: { not: teaVersionId }, userId }
      })).resolves.toMatchObject({ state: "RETRACTED", systemTo: expect.any(Date) });
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: teaVersionId, userId }
      })).resolves.toBe(1);

      await mutateSource(userId, tea.chatId, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: null }
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: teaVersionId }
      })).resolves.toMatchObject({ state: "RETRACTED", systemTo: expect.any(Date) });
      await expect(prisma.memoryEvidence.count({ where: { factVersionId: teaVersionId, userId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { factVersionId: teaVersionId, userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryEvent.count({
        where: { factId, operation: "SOURCE_INVALIDATE", userId }
      })).resolves.toBeGreaterThanOrEqual(3);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("expires an automatic fact from a direct later ending claim without a verifier", async () => {
    const userId = await createOwner("expiry");
    try {
      const active = await createCandidate({
        createdAt: new Date("2026-08-11T14:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      const factId = await addCandidateAsFact(active);
      const versionId = (await prisma.memoryFact.findUniqueOrThrow({
        where: { id: factId }
      })).currentVersionId!;
      const ended = await createCandidate({
        createdAt: new Date("2026-08-11T14:10:00.000Z"),
        structuredValue: { active: false, drink: "tea" },
        text: "I no longer drink tea.",
        userId
      });
      const proposed = await prepareConsolidation(ended);
      const expiration = consolidationPlan(proposed.input, "EXPIRE");
      const bindingId = await bindConsolidation(
        proposed.claim,
        proposed.input,
        expiration
      );
      await commitConsolidation({ ...proposed, bindingId, plan: expiration });

      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }))
        .resolves.toMatchObject({ currentVersionId: null, state: "EXPIRED" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({
        state: "EXPIRED",
        systemTo: expect.any(Date),
        validTo: expect.any(Date)
      });
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: versionId, stance: "CONTRADICTS", userId }
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: versionId, userId }
      })).resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: { kind: "VERIFY_CANDIDATE", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });
});
