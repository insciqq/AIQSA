import { randomUUID } from "node:crypto";
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
import { lockMemorySettings } from "../../persistence/transaction";
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
import { decodeMemoryFactExtraction } from "../extraction/decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "../extraction/prompt";
import { createPrismaMemoryFactExtractionRepository } from "../extraction/repository";
import {
  MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
  MEMORY_FACT_CONSOLIDATION_POLICY_VERSION,
  MEMORY_FACT_CONSOLIDATION_PROMPT_VERSION,
  MEMORY_FACT_CONSOLIDATION_SCHEMA_VERSION,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationOperation,
  type MemoryFactConsolidationPlan
} from "./contract";
import { decodeMemoryFactConsolidation } from "./decoder";
import { MEMORY_FACT_CONSOLIDATION_TOOL_NAME } from "./prompt";
import {
  createPrismaMemoryFactConsolidationRepository,
  reconcileMemoryFactCandidateJobs
} from "./repository";

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
  text: string;
  userId: string;
}>) {
  const chat = await prisma.chat.create({
    data: { title: `Fact source ${randomUUID()}`, userId: input.userId }
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
      providerRequestPreview: {},
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
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
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
  const plan = decodeMemoryFactExtraction([{
    arguments: {
      candidates: [{
        core_eligible: true,
        core_salience: "HIGH",
        directness: "DIRECT",
        display_text: input.text,
        evidence: [{
          end_offset: input.text.length,
          message_id: turn.userMessage.id,
          start_offset: 0
        }],
        language: "en",
        modality: "PREFERENCE",
        raw_temporal_expression: null,
        scope: { target_id: null, type: "GLOBAL_USER" },
        sensitivity: "NORMAL",
        structured_value: JSON.stringify(input.structuredValue),
        valid_from: null,
        valid_to: null
      }],
      decision: "STORE"
    },
    id: `extract-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], extractionInput);
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
      const settings = await lockMemorySettings(tx, input.userId, true);
      const applied = await extractionRepository().apply(
        tx,
        settings,
        exactClaim,
        plan,
        bindingId,
        new Date()
      );
      if (applied !== "APPLIED") throw new Error("memory_candidate_apply_failed");
    },
    claim,
    now: new Date(),
    stage: "fact_candidates_ready"
  });
  if (!committed) throw new Error("memory_candidate_commit_failed");
  return {
    candidateId: plan.candidates[0]!.id,
    chatId: turn.chat.id,
    extractionJobId: claim.id,
    messageId: turn.userMessage.id,
    userId: input.userId
  };
}

async function prepareConsolidation(candidate: CandidateFixture): Promise<Readonly<{
  claim: MemoryJobClaim;
  input: MemoryFactConsolidationInput;
}>> {
  await reconcileMemoryFactCandidateJobs(prisma);
  const job = await prisma.memoryJob.findFirstOrThrow({
    where: {
      idempotencyFingerprint: { startsWith: `consolidate-candidate:${candidate.candidateId}:` },
      kind: "CONSOLIDATE_CANDIDATE",
      state: "QUEUED",
      userId: candidate.userId
    }
  });
  const claim = await claimJob(job.id);
  const prepared = await consolidationRepository().prepareConsolidation(claim);
  if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
  return { claim, input: prepared.input };
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
  return decodeMemoryFactConsolidation([{
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

  it("does not let an already-enqueued candidate starve later consolidation work", async () => {
    const userId = await createOwner("reconcile-starvation");
    try {
      const first = await createCandidate({
        createdAt: new Date("2026-08-11T06:00:00.000Z"),
        structuredValue: { drink: "tea" },
        text: "I prefer tea.",
        userId
      });
      await expect(reconcileMemoryFactCandidateJobs(prisma, { limit: 1 }))
        .resolves.toBe(1);

      const second = await createCandidate({
        createdAt: new Date("2026-08-11T06:01:00.000Z"),
        structuredValue: { drink: "coffee" },
        text: "I prefer coffee.",
        userId
      });
      await expect(reconcileMemoryFactCandidateJobs(prisma, { limit: 1 }))
        .resolves.toBe(1);
      await expect(prisma.memoryJob.count({
        where: {
          idempotencyFingerprint: {
            startsWith: `consolidate-candidate:${second.candidateId}:`
          },
          kind: "CONSOLIDATE_CANDIDATE",
          userId
        }
      })).resolves.toBe(1);
      await expect(prisma.memoryJob.count({
        where: {
          idempotencyFingerprint: {
            startsWith: `consolidate-candidate:${first.candidateId}:`
          },
          kind: "CONSOLIDATE_CANDIDATE",
          userId
        }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
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

      await expect(reconcileMemoryFactCandidateJobs(prisma)).resolves.toBe(1);
      const job = await prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: {
            startsWith: `consolidate-candidate:${candidate.candidateId}:`
          },
          kind: "CONSOLIDATE_CANDIDATE",
          state: "QUEUED",
          userId
        }
      });
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
      })).rejects.toThrow("memory_consolidation_crash_fixture");
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
      expect(prepared.input.relatedFacts[0]!.canonicalKey).toMatch(/^auto\.[a-f0-9]{64}$/u);
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
        state: "DEFERRED"
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
      const plan = consolidationPlan(prepared.input, "REINFORCE");
      const bindingId = await bindConsolidation(prepared.claim, prepared.input, plan);
      await commitConsolidation({ ...prepared, bindingId, plan });

      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: explicit.versionId, userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: reinforcement.candidateId }
      })).resolves.toMatchObject({
        reasonCode: "explicit_authority_retained",
        state: "DEFERRED"
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
        patch: {}
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
        patch: {}
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
        patch: {}
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
