import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createTestProviderExecutionAuthority,
  deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority
} from "@/tests/support/providerExecutionAuthority";
import { textMessageContent } from "../../../../domain/content";
import { providerTemplateIds } from "../../../../domain/providerTemplates";
import { prisma } from "../../../prisma";
import { createPrismaMessageBranchRepository } from "../../../messages/prismaRepository";
import type { MemoryJobClaim } from "../../coordinator/types";
import { enqueueMemoryCommand } from "../../commands/repository";
import { detachExpiredMemoryExecutionBindings } from "../../execution/lifecycle";
import {
  reconcileMemoryMaintenanceWork,
  scheduleOwnerMemoryMaintenance
} from "../../maintenance/reconcile";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import {
  loadPersonalEligibleFactVersionIds,
  loadPersonalMemoryEvidenceSnapshots
} from "../../persistence/eligibility";
import { loadMemoryReusableFactVersionIds } from "../../persistence/reusableFactAuthority";
import { projectMemoryHistorySourceText } from "../../history/safety";
import {
  lockMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../../persistence/transaction";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../../retrieval/vector";
import {
  memorySafetyLiteFactClassification,
  MEMORY_SAFETY_LITE_POLICY_VERSION
} from "../../safetyLite";
import { defaultMemorySourceMutationHooks } from "../../sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../../sourceState";
import { MemorySuppressionKeyring } from "../../suppressionKeyring";
import {
  MEMORY_EXPLICIT_PIPELINE_VERSION,
  MEMORY_EXPLICIT_SOURCE_PROJECTION_VERSION
} from "../../explicit/service";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS,
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  MEMORY_FACT_MAX_SOURCE_PAGES,
  memoryFactCandidateId,
  memoryFactExtractionInputHash,
  memoryFactExtractionJobFingerprint,
  memoryFactExtractionJobIdentity,
  type MemoryFactJobPage,
  memoryFactExtractionOutputHash,
  type MemorySemanticAdjudication,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import { decodeMemoryFactExtraction } from "./decoder";
import {
  MEMORY_SEMANTIC_ADJUDICATION_PIPELINE_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_POLICY_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME,
  decodeMemorySemanticAdjudication,
  decodeStoredMemorySemanticAdjudication,
  encodeStoredMemorySemanticAdjudication,
  memoryCandidateRequiresSemanticAdjudication,
  memorySemanticAdjudicationInput,
  memorySemanticAdjudicationOutputHash,
  type MemorySemanticAdjudicationPacket
} from "./adjudication";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { createPrismaMemoryFactExtractionRepository } from "./repository";
import {
  createMemoryFactExtractionHandler,
  type MemoryFactExtractionHandlerDependencies
} from "./handler";
import { materializeMemoryCandidateEntityIdentity } from "../entities/repository";
import { registerMemoryIdentityCompatibility } from "../identity/compatibility";
import { createMemorySuppressionInTransaction } from "../../persistence/suppressions";
import { MEMORY_IDENTITY_WRITE_PROFILE_ENV } from "../identity/config";
import { createPrismaMemoryIdentityCutoverRepository } from
  "../identity/cutover";
import {
  decideMemoryFactRelation,
  MEMORY_FACT_RELATION_PIPELINE_VERSION
} from "../relations/policy";
import { createPrismaMemoryRelationRepository } from "../relations/repository";
import { createPrismaMemoryRelationHandler } from "../relations/handler";
import { reconcileMemoryFactRelationJobs } from "../relations/reconcile";
import { createPrismaMemoryCoordinatorRepository } from "../../coordinator/prismaRepository";
import { commitMemoryVNextExtractionPlan } from "../../vnext/repository";
import { loadMemoryFactContextRefs } from "../dependencies/context";
import { MEMORY_MAINTENANCE_POLICY_VERSION } from "../../maintenance/policy";
import { memoryPurgeTargetType } from "../../purge/contract";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 101));
const keyring = MemorySuppressionKeyring.parse(
  `current=facts-v1,facts-v1=${keyBytes.toString("base64")}`
);
let executionAuthority: TestProviderExecutionAuthority | null = null;

async function loadExecutionAuthority(): Promise<TestProviderExecutionAuthority> {
  executionAuthority ??= await createTestProviderExecutionAuthority(
    prisma,
    "memory-extraction"
  );
  return executionAuthority;
}

async function createOwner(label: string): Promise<string> {
  const suffix = randomUUID();
  const userId = `memory-vnext-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory vNext extraction test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: true, referenceChatHistory: false },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function createTurn(input: Readonly<{
  assistantText: string;
  chatId: string;
  createdAt: Date;
  parentMessageId: string | null;
  /** A scheduled task's turn: run creation marks the prompt and gives the run its scheduled origin. */
  scheduled?: true;
  userId: string;
  userText: string;
}>) {
  const userMessage = await prisma.message.create({
    data: {
      chatId: input.chatId,
      content: textMessageContent(input.userText),
      createdAt: input.createdAt,
      parentMessageId: input.parentMessageId,
      role: "user",
      ...(input.scheduled ? { scheduledTaskPrompt: true } : {}),
      status: "complete",
      updatedAt: input.createdAt
    }
  });
  const assistantAt = new Date(input.createdAt.getTime() + 1_000);
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: input.chatId,
      content: textMessageContent(input.assistantText),
      createdAt: assistantAt,
      modelId: "memory-vnext-test-model",
      parentMessageId: userMessage.id,
      provider: "memory-vnext-test-provider",
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: input.chatId,
      modelId: "memory-vnext-test-model",
      normalizedRequest: {
        prompt: {
          baseline: {
            source: "standard_chat",
            timeZone: "Europe/Moscow",
            timeZoneSource: "client"
          }
        }
      },
      provider: "memory-vnext-test-provider",
      // Plain values that outlive the task.
      ...(input.scheduled
        ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID() }
        : {}),
      status: "complete",
      userId: input.userId,
      userMessageId: userMessage.id
    }
  });
  return { assistantMessage, run, userMessage };
}

async function settleChat(
  userId: string,
  chatId: string,
  turn: Awaited<ReturnType<typeof createTurn>>
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_vnext_test_chat_missing");
    await applyMemorySourceMutations(tx, {
      chat,
      hooks: defaultMemorySourceMutationHooks,
      mutations: ["NORMAL_APPEND"],
      patch: { activeLeafMessageId: turn.assistantMessage.id }
    });
  });
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_vnext_test_chat_missing");
    await applyMemorySourceMutations(tx, {
      chat,
      hooks: defaultMemorySourceMutationHooks,
      mutations: ["TERMINAL_SETTLEMENT"],
      terminalSettlement: {
        assistantMessageId: turn.assistantMessage.id,
        runId: turn.run.id,
        status: "complete"
      }
    });
  });
}

async function claimFactJob(
  userId: string,
  sourceMessageId: string
): Promise<MemoryJobClaim> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    where: {
      kind: "EXTRACT_FACTS",
      sourceMessageId,
      state: "QUEUED",
      userId
    }
  });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 120_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED"
    },
    where: { id: job.id }
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

const exactTextRef = (text: string, occurrenceIndex = 0) => ({
  occurrence_index: occurrenceIndex,
  text
});

const currentUserAssertion = Object.freeze({
  assertion_status: "ASSERTED",
  change_intent: "STATE_CHANGE",
  memory_directive: "NONE",
  polarity: "AFFIRMED",
  speech_act: "ASSERTION",
  subject_scope: "CURRENT_USER",
  temporal_perspective: "CURRENT"
});

type ExtractionTemporalFixture = Readonly<{
  expiration_intent: "EXPLICIT" | "NONE" | "UNKNOWN";
  normalization: Readonly<Record<string, unknown>>;
  perspective: "CURRENT" | "FORMER" | "FUTURE" | "EVENT" | "INTERVAL" |
    "UNKNOWN";
  raw_expression: ReturnType<typeof exactTextRef> | null;
}>;

function extractionPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  statement = "The user bought a MacBook Air.",
  state = "owned",
  temporal: ExtractionTemporalFixture = {
    expiration_intent: "NONE",
    normalization: { kind: "NONE" },
    perspective: "CURRENT",
    raw_expression: null,
  },
  product: Readonly<{
    brand: string;
    entityType?: "DEVICE" | "PRODUCT" | "SERVICE";
    label: string;
    model: string;
  }> = {
    brand: "Apple",
    label: "MacBook Air",
    model: "MacBook Air"
  },
  additionalQuotes: readonly string[] = []
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [quote, ...additionalQuotes].map((quote) => ({
        candidate_ref: `C-${memorySha256({ product, quote, state, statement }).slice(0, 16)}`,
        confidence_band: "HIGH",
        dependency_refs: [],
        entities: [{
          aliases: [],
          canonical_label: product.label,
          context_entity_ref: null,
          entity_type: product.entityType ?? "DEVICE",
          mention: exactTextRef(product.model),
          mention_kind: "NAMED",
          qualifier_supports: [{
            key: "model",
            source: exactTextRef(product.model),
            value: product.model
          }],
          role: "SUBJECT"
        }],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: null,
          mode: "SLOT",
          predicate_key: "product_status",
          subject: {
            canonical_label: product.label,
            entity_type: product.entityType ?? "DEVICE",
            qualifiers: { brand: product.brand, model: product.model }
          }
        },
        memory_type: "EVENT",
        reason_code: "durable_direct_fact",
        semantic_frame: currentUserAssertion,
        sensitivity: "NORMAL",
        statement,
        temporal,
        temporary: temporal.expiration_intent === "EXPLICIT",
        value: {
          frequency: null,
          kind: null,
          limit: null,
          place: null,
          role: null,
          schedule: null,
          state,
          strength: null,
          value: null
        }
      }))
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function preferencePlan(
  input: MemoryFactExtractionInput,
  quote: string,
  statement: string,
  explicitReminder = false,
  confidenceBand: "HIGH" | "MEDIUM" = "HIGH",
  additionalQuotes: readonly string[] = [],
  correctionTargetRef: string | null = null,
  polarity: "AFFIRMED" | "CORRECTION" | "NEGATED" = "AFFIRMED",
  changeIntent: "NONE" | "CORRECTION" | "STATE_CHANGE" =
    correctionTargetRef !== null || polarity === "CORRECTION" ? "CORRECTION" : "NONE",
  usefulness: "DURABLE" | "ONGOING" | "EPISODIC" | "SHORT_TERM" | "COMMON" | "TRANSIENT" =
    "DURABLE"
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [quote, ...additionalQuotes].map((quote) => ({
        candidate_ref: `C-${memorySha256({ quote, statement }).slice(0, 16)}`,
        confidence_band: confidenceBand,
        dependency_refs: correctionTargetRef === null ? [] : [correctionTargetRef],
        entities: [],
        evidence: exactTextRef(quote),
        usefulness,
        identity: {
          dimension_key: null,
          mode: "PROPOSITION",
          predicate_key: null,
          subject: {
            canonical_label: null,
            entity_type: "NONE",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "PREFERENCE",
        reason_code: "durable_direct_preference",
        semantic_frame: {
          assertion_status: "ASSERTED",
          change_intent: changeIntent,
          memory_directive: explicitReminder ? "EXPLICIT_REMEMBER" : "NONE",
          polarity: correctionTargetRef === null ? polarity : "CORRECTION",
          speech_act: explicitReminder ? "COMMAND" : "ASSERTION",
          subject_scope: "CURRENT_USER",
          temporal_perspective: "CURRENT"
        },
        sensitivity: "NORMAL",
        statement,
        temporal: {
          expiration_intent: "NONE",
          normalization: { kind: "NONE" },
          perspective: "CURRENT",
          raw_expression: null
        },
        temporary: false,
        value: emptyObservationValue
      }))
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function pureWithdrawalPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  identityKind: "PROPOSITION" | "SLOT",
  temporalPerspective: "CURRENT" | "FORMER" | "FUTURE" = "CURRENT",
  statement = "The user withdraws the cedar layout preference."
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: `C-${memorySha256({ identityKind, quote }).slice(0, 16)}`,
        confidence_band: "HIGH",
        dependency_refs: [],
        entities: [],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: identityKind === "SLOT" ? {
          dimension_key: "format:layouts",
          mode: "SLOT",
          predicate_key: "preference",
          subject: {
            canonical_label: null,
            entity_type: "PERSON_SELF",
            qualifiers: { brand: null, model: null }
          }
        } : {
          dimension_key: null,
          mode: "PROPOSITION",
          predicate_key: null,
          subject: {
            canonical_label: null,
            entity_type: "NONE",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "PREFERENCE",
        reason_code: "pure_withdrawal",
        semantic_frame: {
          assertion_status: "ASSERTED",
          change_intent: "RETRACTION",
          memory_directive: "NONE",
          polarity: "RETRACTION",
          speech_act: "ASSERTION",
          subject_scope: "CURRENT_USER",
          temporal_perspective: temporalPerspective
        },
        sensitivity: "NORMAL",
        statement,
        temporal: {
          expiration_intent: "NONE",
          normalization: { kind: "NONE" },
          perspective: temporalPerspective,
          raw_expression: null
        },
        temporary: false,
        value: identityKind === "SLOT"
          ? { ...emptyObservationValue, value: "cedar" }
          : emptyObservationValue
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function withdrawalPacket(
  plan: MemoryFactExtractionPlan,
  targetVersionId: string,
  temporalPerspective: "CURRENT" | "FORMER" | "FUTURE" = "CURRENT"
): MemorySemanticAdjudicationPacket {
  const input = memorySemanticAdjudicationInput(plan);
  const target = plan.input.contextRefs.find(({ source }) =>
    source.factVersionId === targetVersionId);
  const candidate = plan.candidates[0];
  if (!input || !target || !candidate) {
    throw new Error("memory_withdrawal_test_context_missing");
  }
  const decisions: MemorySemanticAdjudication[] = [{
    assertionStatus: "ASSERTED",
    candidateRef: candidate.candidateRef,
    confidenceBand: "HIGH",
    entailment: "ENTAILED",
    entityRef: null,
    operation: "RETRACT_TARGET",
    reasonCode: "pure_withdrawal",
    subjectScope: "CURRENT_USER",
    targetRef: target.ref,
    temporalPerspective
  }];
  return {
    decisions,
    inputHash: input.inputHash,
    outputHash: memorySemanticAdjudicationOutputHash(input.inputHash, decisions)
  };
}

function scheduledPropositionPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  date: string,
  changeIntent: "NONE" | "STATE_CHANGE",
  weakSubjectType?: "GOAL" | "PROJECT",
  entities: readonly unknown[] = [],
  memoryType: "PLAN" | "STATE" = "PLAN"
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: "C-scheduled-workshop",
        confidence_band: "HIGH",
        dependency_refs: [],
        entities,
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: null,
          mode: weakSubjectType ? "SLOT" : "PROPOSITION",
          predicate_key: weakSubjectType === "GOAL" ? "goal_status"
            : weakSubjectType === "PROJECT" ? "project_status" : null,
          subject: {
            canonical_label: null,
            entity_type: weakSubjectType ?? "NONE",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: memoryType,
        reason_code: "agreed_workshop_schedule",
        semantic_frame: {
          ...supportingUserAssertion,
          change_intent: changeIntent,
          temporal_perspective: "FUTURE"
        },
        sensitivity: "NORMAL",
        statement: `The user's workshop is scheduled for ${date}.`,
        temporal: {
          expiration_intent: "NONE",
          normalization: {
            kind: "ABSOLUTE", local_date: date, local_time: null, zone: null
          },
          perspective: "FUTURE",
          raw_expression: exactTextRef(date)
        },
        temporary: weakSubjectType !== undefined,
        value: weakSubjectType ? { ...emptyObservationValue, state: "planned" } : emptyObservationValue
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function slotPreferencePlan(
  input: MemoryFactExtractionInput,
  quote: string,
  dimension: string,
  options: Readonly<{
    changeIntent?: "NONE" | "CORRECTION" | "STATE_CHANGE";
    polarity?: "AFFIRMED" | "NEGATED";
    sensitivity?: "NORMAL" | "SENSITIVE";
    value?: string;
  }> = {}
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: `C-${memorySha256({ dimension, quote }).slice(0, 16)}`,
        confidence_band: "HIGH",
        dependency_refs: [],
        entities: [],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: dimension,
          mode: "SLOT",
          predicate_key: "preference",
          subject: {
            canonical_label: null,
            entity_type: "PERSON_SELF",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "PREFERENCE",
        reason_code: "durable_direct_preference",
        semantic_frame: {
          assertion_status: "ASSERTED",
          change_intent: options.changeIntent ?? "NONE",
          memory_directive: "NONE",
          polarity: options.polarity ?? "AFFIRMED",
          speech_act: "ASSERTION",
          subject_scope: "CURRENT_USER",
          temporal_perspective: "CURRENT"
        },
        sensitivity: options.sensitivity ?? "NORMAL",
        statement: quote,
        temporal: {
          expiration_intent: "NONE",
          normalization: { kind: "NONE" },
          perspective: "CURRENT",
          raw_expression: null
        },
        temporary: false,
        value: { ...emptyObservationValue, value: options.value ?? "concise" }
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

async function createExplicitPreferenceFact(
  userId: string,
  statement: string,
  observedAt: Date
): Promise<Readonly<{ factId: string; versionId: string }>> {
  const scope = await prisma.memoryScope.findFirst({
    where: { scopeType: "GLOBAL_USER", userId }
  }) ?? await prisma.memoryScope.create({
    data: { scopeType: "GLOBAL_USER", userId }
  });
  const factId = randomUUID();
  const versionId = randomUUID();
  const eventId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey: `custom.${memorySha256({
          normalizedStatement: normalizeMemorySearchText(statement),
          version: "memory-explicit-custom-key-v1"
        }).slice(0, 48)}`,
        category: "preferences",
        id: factId,
        lastConfirmedAt: observedAt,
        scopeId: scope.id,
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
        category: "preferences",
        confidence: 1,
        createdByEventId: eventId,
        directness: "DIRECT",
        displayText: statement,
        factId,
        id: versionId,
        importance: 1,
        languageCode: "und",
        modality: "PREFERENCE",
        normalizedSearchText: normalizeMemorySearchText(statement),
        pipelineVersion: MEMORY_EXPLICIT_PIPELINE_VERSION,
        ...memorySafetyLiteFactClassification(observedAt),
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "ACTIVE",
        structuredValue: {
          kind: "explicit_statement",
          statement
        },
        userId
      }
    });
    await tx.memoryEvidence.create({
      data: {
        factVersionId: versionId,
        memoryEventId: eventId,
        observedAt,
        safeExcerpt: statement,
        safeSourceHash: memorySha256(statement),
        safetyClass: "NORMAL",
        sourceProjectionVersion: MEMORY_EXPLICIT_SOURCE_PROJECTION_VERSION,
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
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

function reinforcementPacket(
  plan: MemoryFactExtractionPlan,
  targetVersionId: string
): MemorySemanticAdjudicationPacket {
  const input = memorySemanticAdjudicationInput(plan);
  const target = plan.input.contextRefs.find(({ source }) =>
    source.factVersionId === targetVersionId);
  if (!input || plan.candidates.length === 0 || !target) {
    throw new Error("memory_duplicate_test_context_missing");
  }
  const decisions: MemorySemanticAdjudication[] = plan.candidates.map((candidate) => ({
    assertionStatus: "ASSERTED",
    candidateRef: candidate.candidateRef,
    confidenceBand: "HIGH",
    entailment: "ENTAILED",
    entityRef: null,
    operation: "REINFORCE",
    reasonCode: "semantic_duplicate",
    subjectScope: "CURRENT_USER",
    targetRef: target.ref,
    temporalPerspective: candidate.semanticFrame.temporalPerspective
  }));
  return {
    decisions,
    inputHash: input.inputHash,
    outputHash: memorySemanticAdjudicationOutputHash(input.inputHash, decisions)
  };
}

function contextualProductPlan(
  input: MemoryFactExtractionInput,
  contextRef: string
): MemoryFactExtractionPlan {
  const quote = "Я одолжил макбук.";
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: "C-context-borrow",
        confidence_band: "HIGH",
        dependency_refs: [contextRef],
        entities: [{
          aliases: [exactTextRef("макбук")],
          canonical_label: null,
          context_entity_ref: contextRef,
          entity_type: "PRODUCT",
          mention: exactTextRef("макбук"),
          mention_kind: "NOMINAL",
          qualifier_supports: [{
            key: "model",
            source: { context_ref: contextRef },
            value: "MacBook Air"
          }],
          role: "SUBJECT"
        }],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: null,
          mode: "SLOT",
          predicate_key: "product_status",
          subject: {
            canonical_label: "Portable Computer",
            entity_type: "PRODUCT",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "EVENT",
        reason_code: "context_resolved_borrow",
        semantic_frame: currentUserAssertion,
        sensitivity: "NORMAL",
        statement: "Пользователь одолжил MacBook Air.",
        temporal: {
          expiration_intent: "NONE",
          normalization: { kind: "NONE" },
          perspective: "CURRENT",
          raw_expression: null,
        },
        temporary: false,
        value: {
          frequency: null,
          kind: null,
          limit: null,
          place: null,
          role: null,
          schedule: null,
          state: "borrowed",
          strength: null,
          value: null
        }
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

const supportingUserAssertion = Object.freeze({
  assertion_status: "ASSERTED",
  change_intent: "NONE",
  memory_directive: "NONE",
  polarity: "AFFIRMED",
  speech_act: "ASSERTION",
  subject_scope: "CURRENT_USER",
  temporal_perspective: "CURRENT"
});

const emptyObservationValue = Object.freeze({
  frequency: null,
  kind: null,
  limit: null,
  place: null,
  role: null,
  schedule: null,
  state: null,
  strength: null,
  value: null
});

function supportingContextPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  dependencyRef: string
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: "C-supporting-context",
        confidence_band: "MEDIUM",
        dependency_refs: [dependencyRef],
        entities: [],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: null,
          mode: "PROPOSITION",
          predicate_key: null,
          subject: {
            canonical_label: null,
            entity_type: "NONE",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "PREFERENCE",
        reason_code: "contextual_support",
        semantic_frame: supportingUserAssertion,
        sensitivity: "NORMAL",
        statement: "The current user usually prefers cedar layouts.",
        temporal: {
          expiration_intent: "NONE",
          normalization: { kind: "NONE" },
          perspective: "CURRENT",
          raw_expression: null
        },
        temporary: false,
        value: emptyObservationValue
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function relationshipTemporalPlan(
  input: MemoryFactExtractionInput,
  quote: string
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: "C-relationship-event",
        confidence_band: "HIGH",
        dependency_refs: [],
        entities: [{
          aliases: [exactTextRef("Alex")],
          canonical_label: "Alex",
          context_entity_ref: null,
          entity_type: "PERSON",
          mention: exactTextRef("Alex"),
          mention_kind: "NAMED",
          qualifier_supports: [],
          role: "SUBJECT"
        }],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: null,
          mode: "PROPOSITION",
          predicate_key: null,
          subject: {
            canonical_label: null,
            entity_type: "NONE",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "EVENT",
        reason_code: "relationship_event",
        semantic_frame: {
          ...supportingUserAssertion,
          subject_scope: "USER_RELATIONSHIP_CONTEXT",
          temporal_perspective: "EVENT"
        },
        sensitivity: "NORMAL",
        statement: "The current user's spouse Alex arrived yesterday.",
        temporal: {
          expiration_intent: "NONE",
          normalization: { amount: -1, kind: "CALENDAR_OFFSET", unit: "DAY" },
          perspective: "EVENT",
          raw_expression: exactTextRef("yesterday")
        },
        temporary: false,
        value: emptyObservationValue
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function relationshipCurrentPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  subject: string,
  statement: string,
  changeIntent: "NONE" | "STATE_CHANGE" | "RETRACTION" = "NONE",
  targetVersionId: string | null = null,
  subjectScope: "CURRENT_USER" | "USER_RELATIONSHIP_CONTEXT" =
    "USER_RELATIONSHIP_CONTEXT",
  sourceContext?: Readonly<{ antecedentRef: string; messageRef: string }>,
  additionalSubject?: string
): MemoryFactExtractionPlan {
  const targetRef = targetVersionId === null ? null : input.contextRefs.find(
    ({ source }) => source.factVersionId === targetVersionId
  )?.ref ?? null;
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: `C-${memorySha256({ quote, statement }).slice(0, 16)}`,
        confidence_band: "HIGH",
        dependency_refs: sourceContext ? [sourceContext.messageRef] : targetRef === null ? [] : [targetRef],
        entities: subjectScope === "CURRENT_USER" ? [] : [{
          aliases: sourceContext ? [] : [exactTextRef(subject)],
          canonical_label: sourceContext ? null : subject,
          context_entity_ref: sourceContext?.antecedentRef ?? null,
          entity_type: "PERSON",
          mention: exactTextRef(subject),
          mention_kind: sourceContext ? "PRONOMINAL" : "NAMED",
          qualifier_supports: [],
          role: "SUBJECT"
        }, ...(additionalSubject ? [{
          aliases: [exactTextRef(additionalSubject)], canonical_label: additionalSubject,
          context_entity_ref: null, entity_type: "PERSON",
          mention: exactTextRef(additionalSubject), mention_kind: "NAMED",
          qualifier_supports: [], role: "SUBJECT"
        }] : [])],
        evidence: exactTextRef(quote),
        usefulness: "DURABLE",
        identity: {
          dimension_key: null,
          mode: "PROPOSITION",
          predicate_key: null,
          subject: {
            canonical_label: null,
            entity_type: "NONE",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "STATE",
        reason_code: "relationship_state",
        semantic_frame: {
          ...supportingUserAssertion,
          change_intent: changeIntent,
          polarity: changeIntent === "RETRACTION" ? "RETRACTION" : "AFFIRMED",
          subject_scope: subjectScope
        },
        sensitivity: "NORMAL",
        statement,
        temporal: {
          expiration_intent: "NONE",
          normalization: { kind: "NONE" },
          perspective: "CURRENT",
          raw_expression: null
        },
        temporary: false,
        value: emptyObservationValue
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function relationshipMutationPacket(
  plan: MemoryFactExtractionPlan,
  targetVersionId: string,
  operation: "RETRACT_TARGET" | "SUPERSEDE_TARGET" | "REPLACE_RELATIONSHIP_TARGET",
  subjectIdentity?: "SAME_ENTITY"
): MemorySemanticAdjudicationPacket {
  const input = memorySemanticAdjudicationInput(plan);
  const target = plan.input.contextRefs.find(({ source }) =>
    source.factVersionId === targetVersionId);
  const candidate = plan.candidates[0];
  if (!input || !target || !candidate) {
    throw new Error("memory_relationship_mutation_test_context_missing");
  }
  const decisions: MemorySemanticAdjudication[] = [{
    assertionStatus: "ASSERTED",
    candidateRef: candidate.candidateRef,
    confidenceBand: "HIGH",
    entailment: "ENTAILED",
    entityRef: operation === "REPLACE_RELATIONSHIP_TARGET" || target.entityId === null
      ? null : target.ref,
    operation,
    reasonCode: "relationship_mutation",
    ...(subjectIdentity === undefined ? {} : { subjectIdentity }),
    ...(operation === "REPLACE_RELATIONSHIP_TARGET"
      ? { subjectIdentity: "UNRESOLVED" as const } : {}),
    subjectScope: candidate.semanticFrame.subjectScope,
    targetRef: target.ref,
    temporalPerspective: "CURRENT"
  }];
  return {
    decisions,
    inputHash: input.inputHash,
    outputHash: memorySemanticAdjudicationOutputHash(input.inputHash, decisions),
    ...(operation === "REPLACE_RELATIONSHIP_TARGET"
      ? { schemaVersion: MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION } : {})
  };
}

async function createSucceededBinding(
  userId: string,
  claim: MemoryJobClaim,
  inputHash: string,
  _outputHash: string,
  versions: Readonly<{
    pipelineVersion: string;
    policyVersion: string;
    promptVersion: string;
    schemaVersion: string;
  }> = {
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
    promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
    schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
  }
): Promise<string> {
  const id = `fact-binding-${randomUUID()}`;
  const completedAt = new Date();
  const createdAt = new Date(completedAt.getTime() - 1_000);
  const authority = await loadExecutionAuthority();
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: null,
      completedAt: null,
      connectionId: authority.connectionId,
      createdAt,
      credentialId: authority.credentialId,
      credentialVersionId: authority.credentialVersionId,
      destinationFingerprint: "d".repeat(64),
      id,
      inputHash,
      logicalRole: "MEMORY_FACT_EXTRACT",
      memoryJobId: claim.id,
      ordinal: 0,
      ownerType: "JOB",
      pipelineVersion: versions.pipelineVersion,
      policyVersion: versions.policyVersion,
      promptVersion: versions.promptVersion,
      providerId: "openai_compatible",
      providerModelId: authority.providerModelId,
      recoverableUntil: null,
      relationsDetachedAt: null,
      schemaVersion: versions.schemaVersion,
      secretFreeExecutionSnapshot: {},
      startedAt: createdAt,
      state: "RUNNING",
      usageCompleteness: "UNAVAILABLE",
      userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      memoryExecutionBindingId: id,
      modelId: "memory-vnext-test-model",
      provider: "openai_compatible",
      providerModelId: "memory-vnext-test-model",
      userId
    }
  });
  return id;
}

function repository() {
  return createPrismaMemoryFactExtractionRepository(prisma, {
    keyring: () => keyring
  });
}

function failAfterFirstAppliedCandidate(
  tx: MemoryTransaction
): MemoryTransaction {
  let injected = false;
  const delegate = tx.memoryFactExtractionCandidateReceipt;
  const receiptProxy = new Proxy(delegate, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      if (property !== "updateMany") return member.bind(target);
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, args);
        const request = args[0] as Readonly<{
          data?: Readonly<{ outcome?: unknown }>;
        }> | undefined;
        if (!injected && request?.data?.outcome === "APPLIED") {
          injected = true;
          throw new Error("memory_eval_fault_after_candidate_one");
        }
        return result;
      };
    }
  });
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === "memoryFactExtractionCandidateReceipt") {
        return receiptProxy;
      }
      const member = Reflect.get(target, property, receiver);
      return typeof member === "function" ? member.bind(target) : member;
    }
  });
}

async function prepare(claim: MemoryJobClaim): Promise<MemoryFactExtractionInput> {
  const result = await repository().prepare(claim);
  if ("decision" in result) throw new Error(result.decision.errorCode);
  return result.input;
}

async function semanticAdjudicationForPlan(
  userId: string,
  plan: MemoryFactExtractionPlan
): Promise<MemorySemanticAdjudicationPacket | null> {
  const input = memorySemanticAdjudicationInput(plan);
  if (!input) return null;
  const active = await prisma.$queryRaw<Array<{
    canonicalKey: string;
    predicateKey: string | null;
    structuredValue: Prisma.JsonValue;
    versionId: string;
  }>>(Prisma.sql`
    SELECT fact."canonicalKey", version."id" AS "versionId",
      fact."predicateKey", version."structuredValue"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = ${userId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
  `);
  const decisions: MemorySemanticAdjudication[] = [];
  for (const candidate of plan.candidates.filter((candidate) =>
    memoryCandidateRequiresSemanticAdjudication(
      candidate,
      plan.input.contextRefs
    ))) {
    const current = active.find(({ canonicalKey }) =>
      canonicalKey === candidate.canonicalKey) ??
      (candidate.predicateKey === "product_status"
        ? active.find(({ predicateKey }) => predicateKey === "product_status")
        : undefined);
    const target = current
      ? plan.input.contextRefs.find(({ source }) =>
          source.factVersionId === current.versionId)
      : null;
    const targetRef = target?.ref ?? null;
    const sameValue = current !== undefined &&
      memorySha256(current.structuredValue) === memorySha256(candidate.proposedValue);
    const operation = targetRef === null
      ? "NO_RELATION"
      : sameValue
        ? "REINFORCE"
        : "SUPERSEDE_TARGET";
    const entityRef = candidate.entities
      .map(({ contextRef }) => contextRef)
      .find((ref): ref is string => ref !== null &&
        plan.input.contextRefs.some((context) =>
          context.ref === ref && context.entityId !== null)) ??
      (target?.entityId ? target.ref : null);
    decisions.push({
      assertionStatus: "ASSERTED",
      candidateRef: candidate.candidateRef,
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef,
      operation,
      reasonCode: sameValue ? "state-match" : "state-transition",
      subjectIdentity: "UNRESOLVED",
      subjectScope: candidate.semanticFrame.subjectScope ===
        "USER_RELATIONSHIP_CONTEXT"
        ? "USER_RELATIONSHIP_CONTEXT"
        : "CURRENT_USER",
      targetRef,
      temporalPerspective: candidate.semanticFrame.temporalPerspective
    });
  }
  return {
    decisions,
    inputHash: input.inputHash,
    outputHash: memorySemanticAdjudicationOutputHash(input.inputHash, decisions)
  };
}

async function applyPlan(
  userId: string,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  now = new Date(),
  adjudicationOverride?: MemorySemanticAdjudicationPacket | null
) {
  const adjudication = adjudicationOverride === undefined
    ? await semanticAdjudicationForPlan(userId, plan)
    : adjudicationOverride;
  await stagePlanOnly(userId, claim, plan, bindingId, now);
  return withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    repository().apply(
      tx,
      settings,
      claim,
      plan,
      bindingId,
      now,
      adjudication
    ));
}

async function stagePlanOnly(
  userId: string,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  now = new Date()
): Promise<void> {
  await withLockedMemoryTransaction(prisma, userId, async (tx) => {
    const binding = await tx.memoryExecutionBinding.findFirstOrThrow({
      select: { startedAt: true, state: true },
      where: { id: bindingId, userId }
    });
    if (binding.state === "RUNNING") {
      const recoveryWindowStartedAt = Math.max(
        now.getTime(),
        binding.startedAt?.getTime() ?? Date.now()
      );
      const recoverableUntil = new Date(
        recoveryWindowStartedAt + 86_400_000
      );
      await repository().stage(tx, claim, plan, bindingId, recoverableUntil);
      const settledAt = new Date(Math.max(
        now.getTime(),
        (await tx.memoryExecutionBinding.findUniqueOrThrow({
          select: { startedAt: true },
          where: { id: bindingId }
        })).startedAt?.getTime() ?? now.getTime()
      ));
      await tx.memoryExecutionBinding.update({
        data: {
          acceptedOutputHash: plan.outputHash,
          completedAt: settledAt,
          recoverableUntil,
          state: "SUCCEEDED"
        },
        where: { id: bindingId }
      });
    }
  });
}

async function activateHybridIndex(userId: string): Promise<void> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId }
  });
  const model = await prisma.providerModel.findUniqueOrThrow({
    select: { connectionId: true },
    where: { id: providerTemplateIds.fakeModel }
  });
  const latest = await prisma.memoryIndexGeneration.aggregate({
    _max: { generation: true },
    where: { userId }
  });
  const now = new Date();
  const generation = await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
      embeddingConfigurationFingerprint: "b".repeat(64),
      embeddingConnectionId: model.connectionId,
      embeddingDimension: 1_024,
      embeddingProviderModelId: providerTemplateIds.fakeModel,
      generation: (latest._max.generation ?? -1) + 1,
      indexMode: "HYBRID",
      indexedThroughMemoryRevision: settings.memoryRevision,
      languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
      readyAt: now,
      retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
      state: "READY",
      targetMemoryRevision: settings.memoryRevision,
      userId,
      vectorSpaceFingerprint: "c".repeat(64)
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generation.id,
        embeddingProviderModelId: providerTemplateIds.fakeModel
      },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: now, state: "ACTIVE" },
      where: { id: generation.id }
    });
  });
}

async function seedAutomaticallyPurgedFact(
  label: string,
  options: Readonly<{
    cleanupPolicyVersion?: string;
    outboxState?: "PENDING" | "SUCCEEDED";
    pinned?: boolean;
    sourceMode?: "AUTOMATIC" | "EXPLICIT";
    userEvent?: boolean;
  }> = {}
) {
  const userId = await createOwner(`relearn-${label}`);
  try {
    const chat = await prisma.chat.create({ data: { title: `Relearn ${label}`, userId } });
    const text = "I prefer quiet rooms.";
    const turn = await createTurn({
      assistantText: "Noted.",
      chatId: chat.id,
      createdAt: new Date("2026-09-01T10:00:00.000Z"),
      parentMessageId: null,
      userId,
      userText: text
    });
    await settleChat(userId, chat.id, turn);
    const claim = await claimFactJob(userId, turn.userMessage.id);
    const input = await prepare(claim);
    const plan = preferencePlan(input, text, text);
    const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
    await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
    const original = await prisma.memoryFact.findFirstOrThrow({ where: { userId } });
    const originalVersion = await prisma.memoryFactVersion.findFirstOrThrow({
      select: { systemFrom: true },
      where: { factId: original.id, userId }
    });
    const forgottenAt = new Date(originalVersion.systemFrom.getTime() + 60_000);
    await prisma.$transaction(async (tx) => {
      await tx.memoryFactVersion.updateMany({
        data: {
          contentPurgedAt: forgottenAt,
          displayText: null,
          normalizedSearchText: null,
          rawTemporalExpression: null,
          occurredAt: null,
          expectedAt: null,
          expiresAt: null,
          validFrom: null,
          validTo: null,
          sourceTimezone: null,
          temporalResolverVersion: null,
          semanticAdjudication: Prisma.DbNull,
          semanticFrame: Prisma.DbNull,
          state: "FORGOTTEN",
          structuredValue: Prisma.DbNull,
          systemTo: forgottenAt,
          temporalResolutionEvidence: Prisma.DbNull
        },
        where: { factId: original.id, userId }
      });
      await tx.memoryFact.update({
        data: {
          currentVersionId: null,
          forgottenAt,
          pinned: options.pinned ?? false,
          state: "FORGOTTEN"
        },
        where: { id: original.id, userId }
      });
      await tx.memoryEvent.create({
        data: {
          actorType: "JOB",
          factId: original.id,
          factVersionId: original.currentVersionId,
          metadata: {
            policyVersion: options.cleanupPolicyVersion ?? MEMORY_MAINTENANCE_POLICY_VERSION,
            reasonCode: "automatic_transient_cleanup"
          },
          operation: "FORGET",
          userId
        }
      });
      if (options.sourceMode === "EXPLICIT") {
        await tx.memoryEvent.create({
          data: { actorType: "USER", factId: original.id, factVersionId: original.currentVersionId,
            operation: "EDIT", userId }
        });
      }
      if (options.userEvent) {
        await tx.memoryEvent.create({
          data: { actorType: "USER", factId: original.id, operation: "FORGET", userId }
        });
      }
      await tx.memoryDeletionOutbox.create({
        data: {
          id: randomUUID(),
          memoryGeneration: 0,
          operation: "FORGET_PURGE",
          completedAt: options.outboxState === "PENDING" ? null : forgottenAt,
          lastAuditAt: options.outboxState === "PENDING" ? null : forgottenAt,
          state: options.outboxState ?? "SUCCEEDED",
          targetId: original.id,
          targetType: memoryPurgeTargetType("MEMORY_FACT"),
          userId
        }
      });
    });
    return { chat, factId: original.id, forgottenAt, text, turn, userId };
  } catch (error) {
    await cleanupOwner(userId);
    throw error;
  }
}

type BudgetSettlement = Readonly<{
  acceptedOutputHash: string | null;
  errorCode: string | null;
  providerResponseId: string | null;
  state: "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN" | "CANCELLED";
  usage: Readonly<{
    cachedInputTokens: number | null;
    completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
    estimatedCostMicros: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

/** Writes real binding and usage rows, so the unique job/role/ordinal index,
 * the binding shape check and the per-binding usage event hold, while the
 * provider and its authority stay fake. */
async function budgetExecution(userId: string) {
  const authority = await loadExecutionAuthority();
  const settleRow = async (
    tx: MemoryTransaction,
    bindingId: string,
    result: BudgetSettlement,
    recoverableUntil: Date
  ) => {
    const binding = await tx.memoryExecutionBinding.findUniqueOrThrow({
      where: { id: bindingId }
    });
    if (binding.state !== "RUNNING") throw new Error("memory_execution_state_conflict");
    await tx.memoryExecutionBinding.update({
      data: {
        acceptedOutputHash: result.acceptedOutputHash,
        cachedInputTokens: result.usage.cachedInputTokens,
        completedAt: new Date(Math.max(Date.now(), binding.startedAt!.getTime())),
        errorCode: result.errorCode,
        estimatedCostMicros: result.usage.estimatedCostMicros,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        providerResponseId: result.providerResponseId,
        reasoningTokens: result.usage.reasoningTokens,
        recoverableUntil,
        state: result.state,
        totalTokens: result.usage.totalTokens,
        usageCompleteness: result.usage.completeness
      },
      where: { id: bindingId }
    });
    await tx.usageEvent.create({
      data: {
        cachedInputTokens: result.usage.cachedInputTokens,
        estimatedCostMicros: result.usage.estimatedCostMicros,
        inputTokens: result.usage.inputTokens,
        memoryExecutionBindingId: bindingId,
        modelId: "memory-vnext-test-model",
        outputTokens: result.usage.outputTokens,
        provider: "openai_compatible",
        providerModelId: authority.providerModelId,
        reasoningTokens: result.usage.reasoningTokens,
        totalTokens: result.usage.totalTokens,
        usageCompleteness: result.usage.completeness,
        userId
      }
    });
    return { state: result.state };
  };
  return {
    admission: {
      async bind(_userId: string, request: Readonly<{
        inputHash: string;
        ordinal: number;
        owner: Readonly<{ memoryJobId: string }>;
        versions: Readonly<{
          pipelineVersion: string;
          policyVersion: string;
          promptVersion: string;
          schemaVersion: string;
        }>;
      }>) {
        const binding = await prisma.memoryExecutionBinding.create({
          data: {
            connectionId: authority.connectionId,
            // The database clock may lead this process; keep startedAt valid.
            createdAt: new Date(Date.now() - 1_000),
            credentialId: authority.credentialId,
            credentialVersionId: authority.credentialVersionId,
            destinationFingerprint: "d".repeat(64),
            inputHash: request.inputHash,
            logicalRole: "MEMORY_FACT_EXTRACT",
            memoryJobId: request.owner.memoryJobId,
            ordinal: request.ordinal,
            ownerType: "JOB",
            pipelineVersion: request.versions.pipelineVersion,
            policyVersion: request.versions.policyVersion,
            promptVersion: request.versions.promptVersion,
            providerId: "openai_compatible",
            providerModelId: authority.providerModelId,
            schemaVersion: request.versions.schemaVersion,
            secretFreeExecutionSnapshot: {},
            userId
          }
        });
        return { id: binding.id };
      },
      async start(_userId: string, bindingId: string) {
        const started = await prisma.memoryExecutionBinding.updateMany({
          data: { startedAt: new Date(), state: "RUNNING" },
          where: { id: bindingId, state: "PENDING", userId }
        });
        if (started.count !== 1) throw new Error("memory_execution_state_conflict");
        return {
          bindingId,
          snapshot: {
            logicalRole: "MEMORY_FACT_EXTRACT",
            providerExecutionSnapshot: {
              connectionId: authority.connectionId,
              credentialId: authority.credentialId,
              credentialVersionId: authority.credentialVersionId,
              providerModelId: authority.providerModelId
            },
            requiresStrictStructuredOutput: true
          }
        };
      }
    },
    lifecycle: {
      settle(_userId: string, bindingId: string, result: BudgetSettlement) {
        return withLockedMemoryTransaction(prisma, userId, (tx) =>
          settleRow(tx, bindingId, result, new Date(Date.now() + 86_400_000)));
      },
      settleSucceededWithDurableResult(
        _userId: string,
        bindingId: string,
        result: BudgetSettlement,
        persist: (tx: MemoryTransaction, evidence: Readonly<{
          recoverableUntil: Date;
        }>) => Promise<void>
      ) {
        const recoverableUntil = new Date(Date.now() + 86_400_000);
        return withLockedMemoryTransaction(prisma, userId, async (tx) => {
          await persist(tx, { recoverableUntil });
          return settleRow(tx, bindingId, result, recoverableUntil);
        });
      },
      withAuthorizedResultCommit<T>(
        _userId: string,
        _result: unknown,
        commit: (tx: MemoryTransaction, evidence: Readonly<{ settings: unknown }>) => Promise<T>
      ) {
        return withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
          commit(tx, { settings }));
      }
    }
  } as unknown as MemoryFactExtractionHandlerDependencies["execution"];
}

function budgetPacket(index: number, observations: unknown) {
  return {
    providerResponseId: `budget-response-${index}`,
    toolCalls: [{
      arguments: { observations },
      id: `budget-call-${index}`,
      name: MEMORY_FACT_EXTRACTION_TOOL_NAME
    }],
    usage: {
      cachedInputTokens: 0,
      inputTokens: 100 + index,
      outputTokens: 10 + index,
      reasoningTokens: 0,
      totalTokens: 110 + 2 * index
    }
  };
}

async function reclaimFactJob(claim: MemoryJobClaim): Promise<MemoryJobClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 120_000);
  const row = await prisma.memoryJob.update({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken },
    where: { id: claim.id }
  });
  return {
    ...claim,
    attemptCount: row.attemptCount,
    claimToken,
    leaseExpiresAt,
    recoveredLease: true
  };
}

async function budgetBindings(userId: string, jobId: string) {
  const bindings = await prisma.memoryExecutionBinding.findMany({
    orderBy: { ordinal: "asc" },
    select: { errorCode: true, id: true, ordinal: true, outputTokens: true, state: true },
    where: { logicalRole: "MEMORY_FACT_EXTRACT", memoryJobId: jobId, userId }
  });
  const usage = await prisma.usageEvent.findMany({
    select: { memoryExecutionBindingId: true, outputTokens: true },
    where: { memoryExecutionBindingId: { in: bindings.map(({ id }) => id) } }
  });
  return { bindings, usage };
}

describe("Prisma Memory vNext source-message ingestion", () => {
  afterAll(async () => {
    if (executionAuthority) {
      await deleteTestProviderExecutionAuthority(prisma, executionAuthority);
    }
    await prisma.$disconnect();
  });

  it("persists a direct service product_status observation as an entity-backed fact", async () => {
    const userId = await createOwner("service-subject");
    try {
      const quote = "I own an Oriole Cloud subscription.\n\tIt renews monthly.";
      const chat = await prisma.chat.create({ data: { title: "Service testimony", userId } });
      const turn = await createTurn({
        assistantText: "Noted.", chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"), parentMessageId: null,
        userId, userText: quote
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, quote, "I own an Oriole Cloud subscription.", "owned", undefined, {
        brand: "Oriole", entityType: "SERVICE", label: "Oriole Cloud", model: "Oriole Cloud"
      });
      expect(plan.rejections).toEqual([]);
      expect(plan.candidates).toHaveLength(1);
      const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
      await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
      const entity = await prisma.memoryEntity.findFirstOrThrow({ where: { userId } });
      expect(entity).toMatchObject({ entityType: "SERVICE", state: "ACTIVE" });
      await expect(prisma.memoryFact.findMany({
        select: { identityVersion: true, subjectEntityId: true }, where: { userId }
      })).resolves.toEqual([{ identityVersion: "slot-v3", subjectEntityId: entity.id }]);
      await expect(prisma.memoryEvidence.findMany({
        select: { safeExcerpt: true }, where: { userId }
      })).resolves.toEqual([{ safeExcerpt: quote }]);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        select: { outcome: true, reasonCode: true }, where: { userId }
      })).resolves.toEqual([{ outcome: "APPLIED", reasonCode: null }]);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("enqueues no fact extraction from a scheduled task's turn, whatever the chat's mode", async () => {
    const userId = await createOwner("scheduled-turn");
    try {
      // The owner switched the task's chat to Memory: an ordinary NORMAL chat.
      const chat = await prisma.chat.create({ data: { title: "Scheduled task chat", userId } });
      const scheduled = await createTurn({
        assistantText: "Here is today's brief.", chatId: chat.id, createdAt: new Date("2026-10-05T06:00:00.000Z"),
        parentMessageId: null, scheduled: true, userId, userText: "I live in Lisbon. Summarize the news."
      });
      await settleChat(userId, chat.id, scheduled);
      await expect(prisma.memoryJob.count({
        where: { kind: "EXTRACT_FACTS", sourceMessageId: scheduled.userMessage.id, userId }
      })).resolves.toBe(0);
      // The owner's own next turn in the same chat is still learned from.
      const own = await createTurn({
        assistantText: "Noted.", chatId: chat.id, createdAt: new Date("2026-10-05T07:00:00.000Z"),
        parentMessageId: scheduled.assistantMessage.id, userId, userText: "I prefer quiet rooms."
      });
      await settleChat(userId, chat.id, own);
      await expect(prisma.memoryJob.count({
        where: { kind: "EXTRACT_FACTS", sourceMessageId: own.userMessage.id, userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("never extracts a scheduled task's prompt through a Regenerate or a queued job, nor uses it as context", async () => {
    const userId = await createOwner("scheduled-regenerate");
    try {
      const chat = await prisma.chat.create({ data: { title: "Scheduled task chat", userId } });
      const scheduled = await createTurn({
        assistantText: "Here is today's brief.", chatId: chat.id, createdAt: new Date("2026-10-05T06:00:00.000Z"),
        parentMessageId: null, userId, userText: "I live in Lisbon. Summarize the news."
      });
      // Settled before it is marked, the turn leaves the job that an earlier
      // regeneration or a re-extraction pass would have queued. It is marked
      // as the migration marks an existing prompt: beside its run's scheduled
      // origin, without touching the message's update time.
      await settleChat(userId, chat.id, scheduled);
      const queued = await claimFactJob(userId, scheduled.userMessage.id);
      await prisma.$executeRaw`UPDATE "Message" SET "scheduledTaskPrompt" = true WHERE "id" = ${scheduled.userMessage.id}`;
      await prisma.modelRun.update({
        data: { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID() },
        where: { id: scheduled.run.id }
      });
      const stale = { errorCode: "memory_fact_source_stale", status: "STALE" };
      await expect(repository().preflight(queued)).resolves.toEqual(stale);
      await expect(repository().prepare(queued)).resolves.toEqual({ decision: stale });

      // A Regenerate of the scheduled answer runs without a scheduled origin.
      const regeneratedAt = new Date("2026-10-05T06:10:00.000Z");
      const regenerated = await prisma.message.create({
        data: {
          chatId: chat.id, content: textMessageContent("Here is a fresh brief."), createdAt: regeneratedAt,
          modelId: "memory-vnext-test-model", parentMessageId: scheduled.userMessage.id,
          provider: "memory-vnext-test-provider", role: "assistant", status: "complete", updatedAt: regeneratedAt
        }
      });
      const regeneratedRun = await prisma.modelRun.create({
        data: {
          assistantMessageId: regenerated.id, chatId: chat.id, modelId: "memory-vnext-test-model",
          normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } },
          provider: "memory-vnext-test-provider", status: "complete", userId, userMessageId: scheduled.userMessage.id
        }
      });
      const mutate = (input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">) =>
        prisma.$transaction(async (tx) => {
          const locked = await lockMemorySourceChat(tx, { chatId: chat.id, lock: "UPDATE", userId });
          if (!locked) throw new Error("memory_vnext_test_chat_missing");
          await applyMemorySourceMutations(tx, { ...input, chat: locked, hooks: defaultMemorySourceMutationHooks });
        });
      await mutate({ mutations: ["BRANCH_PATH_CHANGE"], patch: { activeLeafMessageId: regenerated.id } });
      await mutate({
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: { assistantMessageId: regenerated.id, runId: regeneratedRun.id, status: "complete" }
      });
      // The regeneration admitted no job beside the refused one.
      await expect(prisma.memoryJob.count({
        where: { id: { not: queued.id }, kind: "EXTRACT_FACTS", sourceMessageId: scheduled.userMessage.id, userId }
      })).resolves.toBe(0);

      // The owner's next turn is learned from, without the scheduled turn as context.
      const own = await createTurn({
        assistantText: "Noted.", chatId: chat.id, createdAt: new Date("2026-10-05T07:00:00.000Z"),
        parentMessageId: regenerated.id, userId, userText: "I prefer quiet rooms."
      });
      await settleChat(userId, chat.id, own);
      const input = await prepare(await claimFactJob(userId, own.userMessage.id));
      expect(input.messages.map(({ id }) => id)).toEqual([own.userMessage.id]);
      expect(JSON.stringify(input)).not.toContain("Lisbon");
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("never learns from a scheduled task's prompt copied into a Memory branch, at any depth or after a Regenerate there", async () => {
    const userId = await createOwner("scheduled-branch");
    try {
      const branches = createPrismaMessageBranchRepository(prisma);
      const factJobs = (sourceMessageId: string) =>
        prisma.memoryJob.count({ where: { kind: "EXTRACT_FACTS", sourceMessageId, userId } });
      const mutate = (chatId: string, input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">) =>
        prisma.$transaction(async (tx) => {
          const locked = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
          if (!locked) throw new Error("memory_vnext_test_chat_missing");
          await applyMemorySourceMutations(tx, { ...input, chat: locked, hooks: defaultMemorySourceMutationHooks });
        });
      /** A settled Regenerate: a new answer to the same prompt from an ordinary run without a scheduled origin. */
      const regenerate = async (chatId: string, userMessageId: string, at: Date) => {
        const answer = await prisma.message.create({
          data: {
            chatId, content: textMessageContent("Here is a fresh brief."), createdAt: at, modelId: "memory-vnext-test-model",
            parentMessageId: userMessageId, provider: "memory-vnext-test-provider", role: "assistant", status: "complete",
            updatedAt: at
          }
        });
        const run = await prisma.modelRun.create({
          data: {
            assistantMessageId: answer.id, chatId, modelId: "memory-vnext-test-model",
            normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } },
            provider: "memory-vnext-test-provider", status: "complete", userId, userMessageId
          }
        });
        await mutate(chatId, { mutations: ["BRANCH_PATH_CHANGE"], patch: { activeLeafMessageId: answer.id } });
        await mutate(chatId, {
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: { assistantMessageId: answer.id, runId: run.id, status: "complete" }
        });
        return answer;
      };
      /** A branch from `sourceMessageId`, with its copied path in order. */
      const branch = async (sourceMessageId: string) => {
        const created = await branches.createChatBranchFromMessage({ sourceMessageId, userId });
        if (!created) throw new Error("memory_vnext_test_branch_missing");
        const copies = await prisma.message.findMany({ orderBy: { createdAt: "asc" }, where: { chatId: created.id } });
        expect(copies.map(({ role, scheduledTaskPrompt }) => [role, scheduledTaskPrompt]))
          .toEqual([["user", true], ["assistant", false]]);
        return { chatId: created.id, copies };
      };

      // The owner switched the task's chat to Memory; a branch keeps its mode.
      const chat = await prisma.chat.create({ data: { title: "Scheduled task chat", userId } });
      const scheduled = await createTurn({
        assistantText: "Here is today's brief.", chatId: chat.id, createdAt: new Date("2026-10-03T06:00:00.000Z"),
        parentMessageId: null, scheduled: true, userId, userText: "I live in Lisbon. Summarize the news."
      });
      await settleChat(userId, chat.id, scheduled);

      // The copies carry no runs; a Regenerate in the branch answers the marked copy.
      const first = await branch(scheduled.assistantMessage.id);
      const regenerated = await regenerate(first.chatId, first.copies[0]!.id, new Date("2026-10-03T06:10:00.000Z"));
      await expect(factJobs(first.copies[0]!.id)).resolves.toBe(0);

      // The owner's own turn in the branch is learned from, without the copied prompt as context.
      const own = await createTurn({
        assistantText: "Noted.", chatId: first.chatId, createdAt: new Date("2026-10-03T07:00:00.000Z"),
        parentMessageId: regenerated.id, userId, userText: "I prefer quiet rooms."
      });
      await settleChat(userId, first.chatId, own);
      const input = await prepare(await claimFactJob(userId, own.userMessage.id));
      expect(input.messages.map(({ id }) => id)).toEqual([own.userMessage.id]);
      expect(JSON.stringify(input)).not.toContain("Lisbon");

      // A branch of the branch, from the regenerated answer: its Regenerate admits no job either.
      const second = await branch(regenerated.id);
      await regenerate(second.chatId, second.copies[0]!.id, new Date("2026-10-03T08:00:00.000Z"));
      await expect(factJobs(second.copies[0]!.id)).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("finds an old proposition beyond fifty recent facts and preserves frozen owner refs", async () => {
    const userId = await createOwner("context-relevance");
    const foreign = await createOwner("context-relevance-foreign");
    try {
      const chat = await prisma.chat.create({ data: { title: "Old workshop", userId } });
      const quote = "My Oriole workshop is on 2027-02-08.";
      const turn = await createTurn({ assistantText: "Noted.", chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"), parentMessageId: null, userId, userText: quote });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = scheduledPropositionPlan(input, quote, "2027-02-08", "NONE");
      const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
      await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
      const old = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
      for (let ordinal = 0; ordinal < 50; ordinal++) {
        await createExplicitPreferenceFact(userId, `My independent setting ${ordinal} is enabled.`,
          new Date(Date.now() + ordinal));
      }
      const other = await createExplicitPreferenceFact(foreign, quote, new Date());
      const query = { ...input.messages.find(({ evidenceEligible }) => evidenceEligible)!,
        id: "fresh-target", text: "The Oriole workshop schedule has changed." };
      const selected = await prisma.$transaction((tx) => loadMemoryFactContextRefs(tx, { userId, messages: [query] }));
      expect(selected.length).toBeLessThanOrEqual(8);
      expect(selected.some(({ source }) => source.factVersionId === old.id)).toBe(true);
      expect(selected.some(({ source }) => source.factVersionId === other.versionId)).toBe(false);
      expect(selected.some(({ text }) => text === "My independent setting 49 is enabled.")).toBe(true);
      const frozenIds = selected.flatMap(({ source }) => source.factVersionId ? [source.factVersionId] : []);
      const frozen = await prisma.$transaction((tx) => loadMemoryFactContextRefs(tx, {
        userId, messages: [{ ...query, text: "A different input cannot retarget frozen context." }], factVersionIds: frozenIds
      }));
      expect(frozen.map(({ source }) => source.factVersionId)).toEqual(frozenIds);
    } finally { await cleanupOwner(userId); await cleanupOwner(foreign); }
  });

  it.each([false, true])("persists a proposition with discarded entity annotations only with semantic authority: %s", async (admitted) => {
    const userId = await createOwner("optional-entity-authority");
    try {
      const chat = await prisma.chat.create({ data: { title: "Workshop schedule", userId } });
      const quote = "My Oriole workshop is on 2027-02-08.";
      const turn = await createTurn({
        assistantText: "Noted.", chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        parentMessageId: null, userId, userText: quote
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = scheduledPropositionPlan(input, quote, "2027-02-08", "NONE", undefined, [{
        aliases: [], canonical_label: "Oriole", context_entity_ref: null,
        entity_type: "PROJECT", mention: exactTextRef("Oriole", 1), mention_kind: "NAMED",
        qualifier_supports: [], role: "SUBJECT"
      }]);
      expect(plan.rejections).toEqual([]);
      expect(plan.candidates).toHaveLength(1);
      expect(memorySemanticAdjudicationInput(plan)).not.toBeNull();
      const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
      await expect(applyPlan(userId, claim, plan, binding, new Date(), admitted ? undefined : null))
        .resolves.toBe(admitted ? "APPLIED" : "EMPTY");
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(admitted ? 1 : 0);
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryEntityAlias.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findFirstOrThrow({
        select: { outcome: true, reasonCode: true }, where: { userId }
      })).resolves.toEqual(admitted
        ? { outcome: "APPLIED", reasonCode: null }
        : { outcome: "REJECTED", reasonCode: "semantic_adjudication_unavailable" });
      if (admitted) {
        await expect(prisma.memoryFactVersion.findFirstOrThrow({
          select: { expectedAt: true, state: true }, where: { userId }
        })).resolves.toEqual({ expectedAt: new Date("2027-02-07T21:00:00.000Z"), state: "ACTIVE" });
        await expect(prisma.memoryEvidence.findFirstOrThrow({
          select: { safeExcerpt: true, messageId: true }, where: { userId }
        })).resolves.toEqual({ safeExcerpt: quote, messageId: turn.userMessage.id });
      } else {
        await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(0);
      }
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([
    { changeIntent: "CORRECTION", declaredDependency: true, from: "PROPOSITION", to: "PROPOSITION" },
    { changeIntent: "CORRECTION", declaredDependency: false, from: "PROPOSITION", to: "PROPOSITION" },
    { changeIntent: "STATE_CHANGE", declaredDependency: false, from: "PROPOSITION", to: "PROPOSITION" },
    { changeIntent: "CORRECTION", declaredDependency: false, from: "PROPOSITION", to: "SLOT" },
    { changeIntent: "STATE_CHANGE", declaredDependency: false, from: "SLOT", to: "PROPOSITION" }
  ] as const)("persists an exact proposition correction for guarded relation resolution with $changeIntent and declared dependency $declaredDependency from $from to $to", async ({ changeIntent, declaredDependency, from, to }) => {
    const userId = await createOwner("proposition-correction");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Preference correction", userId }
      });
      const first = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer cedar layouts."
      });
      await settleChat(userId, chat.id, first);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const firstInput = await prepare(firstClaim);
      const firstPlan = from === "PROPOSITION"
        ? preferencePlan(firstInput, "I prefer cedar layouts.", "The user prefers cedar layouts.")
        : slotPreferencePlan(firstInput, "I prefer cedar layouts.", "format:layouts", { value: "cedar" });
      await applyPlan(userId, firstClaim, firstPlan, await createSucceededBinding(
        userId, firstClaim, firstInput.inputHash, firstPlan.outputHash
      ));
      const original = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "ACTIVE", userId }
      });
      const updatedPreference = changeIntent === "CORRECTION"
        ? "Correction: I prefer maple layouts."
        : "My preference has changed: I now prefer maple layouts.";
      const second = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T12:01:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: updatedPreference
      });
      await settleChat(userId, chat.id, second);
      const claim = await claimFactJob(userId, second.userMessage.id);
      const input = await prepare(claim);
      const target = input.contextRefs.find(({ source }) =>
        source.factVersionId === original.id);
      if (!target) throw new Error("memory_test_correction_target_missing");
      const plan = to === "PROPOSITION"
        ? preferencePlan(
            input, updatedPreference,
            "The user prefers maple layouts.", false, "HIGH", [],
            declaredDependency ? target.ref : null,
            changeIntent === "CORRECTION" ? "CORRECTION" : "AFFIRMED", changeIntent
          )
        : slotPreferencePlan(input, updatedPreference, "format:layouts", {
            changeIntent, value: "maple"
          });
      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]).toMatchObject({
        correction: changeIntent === "CORRECTION",
        identityKind: to
      });
      const semanticInput = memorySemanticAdjudicationInput(plan);
      if (!semanticInput) throw new Error("memory_test_adjudication_input_missing");
      const decisions: MemorySemanticAdjudication[] = [{
        assertionStatus: "ASSERTED",
        candidateRef: plan.candidates[0]!.candidateRef,
        confidenceBand: "HIGH",
        entailment: "ENTAILED",
        entityRef: null,
        operation: "SUPERSEDE_TARGET",
        reasonCode: "direct-preference-correction",
        subjectScope: "CURRENT_USER",
        targetRef: target.ref,
        temporalPerspective: "CURRENT"
      }];
      await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
        userId, claim, input.inputHash, plan.outputHash
      ), new Date(), {
        decisions,
        inputHash: semanticInput.inputHash,
        outputHash: memorySemanticAdjudicationOutputHash(semanticInput.inputHash, decisions)
      })).resolves.toBe("APPLIED");
      const proposed = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "PENDING_RELATION", userId }
      });
      expect(proposed.factId).not.toBe(original.factId);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: original.id }
      })).resolves.toMatchObject({ state: "ACTIVE", systemTo: null });
      await expect(prisma.memoryFactVersionSourceDependency.count({
        where: {
          dependencyKind: "CORRECTION_TARGET",
          sourceFactVersionId: original.id,
          targetFactVersionId: proposed.id,
          userId
        }
      })).resolves.toBe(1);
      const now = new Date();
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const relationClaim: MemoryJobClaim = {
        ...claim,
        id: randomUUID(),
        kind: "RESOLVE_FACT_RELATIONS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
        targetFactVersionId: proposed.id
      };
      const relations = createPrismaMemoryRelationRepository(prisma);
      const prepared = await relations.prepare(relationClaim, now);
      if (prepared.status !== "READY") {
        throw new Error(`memory_test_relation_not_ready:${prepared.reason}`);
      }
      const decision = decideMemoryFactRelation(prepared.prepared.snapshot, now);
      expect(decision).toMatchObject({
        operation: "MOVE_TO_DISTINCT_FACT",
        targetVersionId: original.id
      });
      const relationPlan = {
        decision,
        executionId: null,
        expectedSnapshotHash: prepared.prepared.snapshotHash
      };
      await prisma.$transaction((tx) =>
        relations.apply(tx, relationClaim, relationPlan, now));
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: original.factId }
      })).resolves.toMatchObject({
        currentVersionId: null,
        movedToFactId: proposed.factId,
        state: "RETRACTED"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: original.id }
      })).resolves.toMatchObject({ state: "SUPERSEDED" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: proposed.id }
      })).resolves.toMatchObject({
        movedFromVersionId: original.id,
        state: "ACTIVE",
        supersedesVersionId: original.id,
        systemTo: null
      });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: proposed.factId }
      })).resolves.toMatchObject({
        currentVersionId: proposed.id,
        state: "ACTIVE"
      });
      await expect(loadPersonalEligibleFactVersionIds(
        prisma, userId, [proposed.id]
      )).resolves.toEqual(new Set([proposed.id]));
      await prisma.$transaction((tx) =>
        relations.apply(tx, relationClaim, relationPlan, now));
      await expect(prisma.memoryFactVersion.count({
        where: { state: "ACTIVE", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([
    { date: "2026-10-07", weakSubjectType: undefined, memoryType: "PLAN" },
    { date: "2026-10-28", weakSubjectType: undefined, memoryType: "PLAN" },
    { date: "2026-10-07", weakSubjectType: "GOAL", memoryType: "PLAN" },
    { date: "2026-10-28", weakSubjectType: "PROJECT", memoryType: "PLAN" },
    { date: "2026-10-07", weakSubjectType: undefined, memoryType: "STATE" },
    { date: "2026-10-28", weakSubjectType: undefined, memoryType: "STATE" }
  ] as const)(
    "retains the revised future $memoryType schedule $date ($weakSubjectType) and the superseded schedule's evidence",
    async ({ date, weakSubjectType, memoryType }) => {
      const userId = await createOwner("scheduled-proposition-revision");
      try {
        const chat = await prisma.chat.create({ data: { title: "Workshop schedule", userId } });
        const initialText = "My workshop is scheduled for 2026-10-14.";
        const first = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-25T12:00:00.000Z"),
          parentMessageId: null, userId, userText: initialText
        });
        await settleChat(userId, chat.id, first);
        const firstClaim = await claimFactJob(userId, first.userMessage.id);
        const firstInput = await prepare(firstClaim);
        const firstPlan = scheduledPropositionPlan(firstInput, initialText, "2026-10-14", "NONE", weakSubjectType, [], memoryType);
        expect(firstPlan.candidates).toHaveLength(1);
        await applyPlan(userId, firstClaim, firstPlan, await createSucceededBinding(
          userId, firstClaim, firstInput.inputHash, firstPlan.outputHash
        ));
        const original = await prisma.memoryFactVersion.findFirstOrThrow({ where: { state: "ACTIVE", userId } });
        const revisedText = `We agreed to reschedule my workshop to ${date}.`;
        const second = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-25T12:01:00.000Z"),
          parentMessageId: first.assistantMessage.id, userId, userText: revisedText
        });
        await settleChat(userId, chat.id, second);
        const claim = await claimFactJob(userId, second.userMessage.id);
        const input = await prepare(claim);
        const target = input.contextRefs.find(({ source }) => source.factVersionId === original.id);
        if (!target) throw new Error("memory_test_schedule_target_missing");
        const plan = scheduledPropositionPlan(input, revisedText, date, "STATE_CHANGE", weakSubjectType, [], memoryType);
        expect(plan.candidates).toHaveLength(1);
        const semanticInput = memorySemanticAdjudicationInput(plan);
        if (!semanticInput) throw new Error("memory_test_schedule_adjudication_missing");
        const decisions: MemorySemanticAdjudication[] = [{
          assertionStatus: "ASSERTED", candidateRef: plan.candidates[0]!.candidateRef,
          confidenceBand: "HIGH", entailment: "ENTAILED", entityRef: null,
          operation: "SUPERSEDE_TARGET", reasonCode: "agreed_schedule_revision",
          subjectScope: "CURRENT_USER", targetRef: target.ref, temporalPerspective: "FUTURE"
        }];
        await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        ), new Date(), {
          decisions, inputHash: semanticInput.inputHash,
          outputHash: memorySemanticAdjudicationOutputHash(semanticInput.inputHash, decisions)
        })).resolves.toBe("APPLIED");
        const pending = await prisma.memoryFactVersion.findFirstOrThrow({ where: { state: "PENDING_RELATION", userId } });
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
        const relationClaim: MemoryJobClaim = {
          ...claim, id: randomUUID(), kind: "RESOLVE_FACT_RELATIONS",
          memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION, targetFactVersionId: pending.id
        };
        const relations = createPrismaMemoryRelationRepository(prisma);
        const now = new Date();
        const prepared = await relations.prepare(relationClaim, now);
        if (prepared.status !== "READY") throw new Error("memory_test_schedule_relation_not_ready");
        const decision = decideMemoryFactRelation(prepared.prepared.snapshot, now);
        expect(decision).toMatchObject({ operation: "MOVE_TO_DISTINCT_FACT", targetVersionId: original.id });
        await prisma.$transaction((tx) => relations.apply(tx, relationClaim, {
          decision, executionId: null, expectedSnapshotHash: prepared.prepared.snapshotHash
        }, now));
        const active = await prisma.memoryFactVersion.findFirstOrThrow({ where: { state: "ACTIVE", userId } });
        expect(active.id).toBe(pending.id);
        expect(active.expectedAt?.toISOString()).toBe(plan.candidates[0]!.expectedAt);
        expect(active.supersedesVersionId).toBe(original.id);
        expect(active.observedAt!.getTime()).toBeGreaterThan(original.observedAt!.getTime());
        expect(active.observedAt!.getTime()).toBeLessThan(active.expectedAt!.getTime());
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
          .resolves.toMatchObject({ state: "SUPERSEDED", expectedAt: original.expectedAt });
        await expect(prisma.memoryEvidence.count({ where: { factVersionId: original.id, userId } }))
          .resolves.toBe(1);
        await expect(prisma.memoryFactVersion.count({ where: { state: "ACTIVE", userId } }))
          .resolves.toBe(1);
        await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: original.factId } }))
          .resolves.toMatchObject({ currentVersionId: null, movedToFactId: active.factId, state: "RETRACTED" });
        await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: active.factId } }))
          .resolves.toMatchObject({ currentVersionId: active.id, state: "ACTIVE" });
        // Source authority also remains valid for historical recall. Currentness
        // is separately defined by the active version and canonical pointer.
        await expect(loadPersonalEligibleFactVersionIds(prisma, userId, [original.id, active.id]))
          .resolves.toEqual(new Set([original.id, active.id]));
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it("learns an exact fact near the end of a long direct user message", async () => {
    const userId = await createOwner("long-target");
    try {
      const quote = "I prefer written instructions.";
      const text = "These notes describe background context. ".repeat(400) + quote;
      const chat = await prisma.chat.create({
        data: { title: "Long direct message", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: text
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      expect(input.messages.find(({ evidenceEligible }) => evidenceEligible)?.text).toBe(text);
      const plan = preferencePlan(input, quote, "The user prefers written instructions.");
      await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
        userId, claim, input.inputHash, plan.outputHash
      ))).resolves.toBe("APPLIED");
      await expect(prisma.memoryEvidence.findFirstOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        safeExcerpt: quote,
        sourceEndOffset: text.length,
        sourceStartOffset: text.length - quote.length
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("atomically persists all eight admitted facts from one source packet", async () => {
    const userId = await createOwner("complete-packet");
    try {
      const statements = [
        "I prefer early meetings.", "I prefer short emails.",
        "I prefer unsweetened tea.", "I prefer quiet offices.",
        "I prefer written instructions.", "I prefer weekly planning.",
        "I prefer dark editor themes.", "I prefer numbered checklists."
      ];
      const chat = await prisma.chat.create({
        data: { title: "Independent preferences", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: statements.join(" ")
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const candidates = statements.flatMap((statement) =>
        preferencePlan(input, statement, statement).candidates);
      const candidateOrdinals = candidates.map((_, index) => index);
      const plan: MemoryFactExtractionPlan = {
        candidateOrdinals,
        candidates,
        input,
        outputHash: memoryFactExtractionOutputHash(input, candidates, candidateOrdinals, []),
        rejections: []
      };
      expect(candidates).toHaveLength(8);
      const binding = await createSucceededBinding(
        userId, claim, input.inputHash, plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
      await expect(prisma.memoryFactVersion.count({
        where: { state: "ACTIVE", userId }
      })).resolves.toBe(8);
      await expect(prisma.memoryFactExtractionCandidateReceipt.count({
        where: { outcome: "APPLIED", userId }
      })).resolves.toBe(8);
      await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
      await expect(prisma.memoryFactVersion.count({
        where: { state: "ACTIVE", userId }
      })).resolves.toBe(8);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([
    ["PROPOSITION", "NORMAL"],
    ["SLOT", "NORMAL"],
    ["SLOT", "SENSITIVE"]
  ] as const)("persists a semantically admitted negative %s proposal labeled %s without losing its polarity", async (identityKind, sensitivity) => {
    const userId = await createOwner("negative-preference");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Negative preference", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I do not drink coffee."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = identityKind === "PROPOSITION"
        ? preferencePlan(
            input, "I do not drink coffee.", "The user does not drink coffee.",
            false, "HIGH", [], null, "NEGATED"
          )
        : slotPreferencePlan(input, "I do not drink coffee.", "category:drinks", {
            polarity: "NEGATED", sensitivity, value: "coffee"
          });
      expect(plan.candidates).toHaveLength(1);
      expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
      await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
        userId, claim, input.inputHash, plan.outputHash
      ))).resolves.toBe("APPLIED");
      const version = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "ACTIVE", userId }
      });
      expect(version).toMatchObject({
        displayText: plan.candidates[0]!.displayText,
        semanticFrame: { polarity: "NEGATED" },
        safetyClassificationState: "CLASSIFIED",
        sensitivityClass: "NORMAL",
        sourceMode: "AUTOMATIC"
      });
      expect(version.structuredValue).toMatchObject({ schema: "generic-fact-v1" });
      expect(version.structuredValue).not.toHaveProperty("value");
      await expect(loadPersonalEligibleFactVersionIds(
        prisma, userId, [version.id]
      )).resolves.toEqual(new Set([version.id]));
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([
    ["retained", 1], ["retained", 8], ["identity", 1], ["identity", 8],
    ["current", 1], ["current", 8]
  ] as const)("[E02] atomically persists the bounded adjudication result before settlement (%s, %i)", async (format, count) => {
    const userId = await createOwner("adjudication-result-contract");
    try {
      const statements = [
        "I do not drink coffee.", "I do not drink black tea.",
        "I do not drink green tea.", "I do not drink soda.",
        "I do not drink energy drinks.", "I do not drink milk.",
        "I do not drink cocoa.", "I do not drink lemonade."
      ].slice(0, count);
      const sourceText = statements.join(" ");
      const chat = await prisma.chat.create({
        data: { title: "Adjudication result contract", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: sourceText
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const candidates = statements.flatMap((statement) => preferencePlan(
        input, statement, statement, false, "HIGH", [], null, "NEGATED"
      ).candidates);
      const candidateOrdinals = candidates.map((_, index) => index);
      const plan: MemoryFactExtractionPlan = {
        candidateOrdinals, candidates, input, rejections: [],
        outputHash: memoryFactExtractionOutputHash(input, candidates, candidateOrdinals, [])
      };
      const extractionBindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await stagePlanOnly(userId, claim, plan, extractionBindingId);
      const currentPacket = await semanticAdjudicationForPlan(userId, plan);
      if (!currentPacket) throw new Error("memory_test_adjudication_packet_missing");
      const decisions = format !== "retained" ? currentPacket.decisions
        : currentPacket.decisions.map(({ subjectIdentity: _identity, ...decision }) => decision);
      const packetSchema = format === "current" ? MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION
        : format === "retained" ? "memory-semantic-adjudication-schema-v1"
          : "memory-semantic-adjudication-schema-v2";
      const packet = { ...currentPacket, decisions, schemaVersion: packetSchema,
        outputHash: memorySemanticAdjudicationOutputHash(currentPacket.inputHash, decisions) };
      expect(packet.decisions).toHaveLength(count);
      await expect(repository().reserveAdjudication(claim))
        .resolves.toBe("ACQUIRED");

      const authority = await prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: {
          connectionId: true,
          credentialId: true,
          credentialVersionId: true,
          destinationFingerprint: true,
          providerId: true,
          providerModelId: true,
          secretFreeExecutionSnapshot: true
        },
        where: { id: extractionBindingId }
      });
      const adjudicationBindingId = `fact-adjudication-${randomUUID()}`;
      const startedAt = new Date("2026-08-25T12:01:00.000Z");
      const failedBindingId = `fact-adjudication-failed-${randomUUID()}`;
      await prisma.memoryExecutionBinding.create({
        data: {
          ...authority,
          completedAt: startedAt,
          createdAt: new Date(startedAt.getTime() - 1_000),
          errorCode: "memory_fact_provider_transient",
          id: failedBindingId,
          inputHash: packet.inputHash,
          logicalRole: "MEMORY_FACT_EXTRACT",
          memoryJobId: claim.id,
          ordinal: 1,
          ownerType: "JOB",
          pipelineVersion: MEMORY_SEMANTIC_ADJUDICATION_PIPELINE_VERSION,
          policyVersion: MEMORY_SEMANTIC_ADJUDICATION_POLICY_VERSION,
          promptVersion: MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
          schemaVersion: packetSchema,
          secretFreeExecutionSnapshot:
            authority.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
          startedAt,
          state: "FAILED",
          usageCompleteness: "UNAVAILABLE",
          userId
        }
      });
      await expect(repository().bindings(userId, claim.id)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({
          acceptedOutputHash: null,
          errorCode: "memory_fact_provider_transient",
          id: failedBindingId,
          inputHash: packet.inputHash,
          state: "FAILED"
        })])
      );
      await expect(repository().reserveAdjudication(claim))
        .resolves.toBe("ACQUIRED");
      await expect(repository().staged(claim, extractionBindingId, input, startedAt))
        .resolves.toMatchObject({ outputHash: plan.outputHash });
      await prisma.memoryExecutionBinding.create({
        data: {
          ...authority,
          createdAt: new Date(startedAt.getTime() - 1_000),
          id: adjudicationBindingId,
          inputHash: packet.inputHash,
          logicalRole: "MEMORY_FACT_EXTRACT",
          memoryJobId: claim.id,
          ordinal: 2,
          ownerType: "JOB",
          pipelineVersion: MEMORY_SEMANTIC_ADJUDICATION_PIPELINE_VERSION,
          policyVersion: MEMORY_SEMANTIC_ADJUDICATION_POLICY_VERSION,
          promptVersion: MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
          schemaVersion: packetSchema,
          secretFreeExecutionSnapshot:
            authority.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
          startedAt,
          state: "RUNNING",
          usageCompleteness: "UNAVAILABLE",
          userId
        }
      });

      const encoded = encodeStoredMemorySemanticAdjudication(packet);
      for (const invalid of [
        { ...encoded, schemaVersion: "memory-semantic-adjudication-schema-v999" },
        { ...encoded, decisions: Array.from({ length: 9 }, () => decisions[0]) },
        { ...encoded, inputHash: "unbound-input" }
      ]) {
        await expect(prisma.memoryAuxiliarySemanticCall.updateMany({
          data: {
            acceptedOutputHash: packet.outputHash, completedAt: new Date(),
            executionId: adjudicationBindingId, inputHash: packet.inputHash,
            result: invalid as Prisma.InputJsonObject
          },
          where: { ownerJobId: claim.id, userId }
        })).rejects.toThrow("MemoryAuxiliarySemanticCall_result_contract_check");
      }

      await withLockedMemoryTransaction(prisma, userId, async (tx) => {
        await repository().completeAdjudication(
          tx,
          claim,
          adjudicationBindingId,
          packet,
          startedAt
        );
        const settled = await tx.memoryExecutionBinding.updateMany({
          data: {
            acceptedOutputHash: packet.outputHash,
            completedAt: startedAt,
            recoverableUntil: new Date(startedAt.getTime() + 86_400_000),
            state: "SUCCEEDED"
          },
          where: {
            id: adjudicationBindingId,
            state: "RUNNING",
            userId
          }
        });
        expect(settled.count).toBe(1);
      });

      const stored = await prisma.memoryAuxiliarySemanticCall.findFirstOrThrow({
        select: {
          acceptedOutputHash: true,
          completedAt: true,
          executionId: true,
          inputHash: true,
          result: true
        },
        where: { ownerJobId: claim.id, userId }
      });
      expect(stored).toMatchObject({
        acceptedOutputHash: packet.outputHash,
        executionId: adjudicationBindingId,
        inputHash: packet.inputHash,
        result: {
          inputHash: packet.inputHash,
          outputHash: packet.outputHash,
          schemaVersion: packetSchema
        }
      });
      expect(stored.completedAt?.getTime()).toBeGreaterThanOrEqual(
        startedAt.getTime()
      );
      expect(decodeStoredMemorySemanticAdjudication(stored.result)).toEqual(packet);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E02] commits direct Dutch ownership with exact evidence and deduplicates retry", async () => {
    const userId = await createOwner("rapid-retry");
    try {
      const directOwnership = "Ik bezit nu een MacBook Air.";
      const chat = await prisma.chat.create({
        data: { title: "Stable per-message ingestion", userId }
      });
      const first = await createTurn({
        assistantText: "Congratulations.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: directOwnership
      });
      await settleChat(userId, chat.id, first);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const firstInput = await prepare(firstClaim);
      expect(firstInput.messages.map(({ evidenceEligible, id, role }) => ({
        evidenceEligible,
        id,
        role
      }))).toEqual([
        { evidenceEligible: true, id: first.userMessage.id, role: "user" }
      ]);
      expect(firstInput.source.sourceMessageId).toBe(first.userMessage.id);

      const second = await createTurn({
        assistantText: "Still noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T10:01:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: directOwnership
      });
      await settleChat(userId, chat.id, second);

      const preparedAfterNextTurn = await prepare(firstClaim);
      expect(preparedAfterNextTurn.inputHash).toBe(firstInput.inputHash);
      const firstPlan = extractionPlan(firstInput, directOwnership);
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await expect(applyPlan(userId, firstClaim, firstPlan, firstBinding))
        .resolves.toBe("APPLIED");

      const secondClaim = await claimFactJob(userId, second.userMessage.id);
      const secondInput = await prepare(secondClaim);
      const secondPlan = extractionPlan(secondInput, directOwnership);
      const secondBinding = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await expect(applyPlan(userId, secondClaim, secondPlan, secondBinding))
        .resolves.toBe("APPLIED");
      await expect(applyPlan(userId, firstClaim, firstPlan, firstBinding))
        .resolves.toBe("APPLIED");

      const facts = await prisma.memoryFact.findMany({ where: { userId } });
      const versions = await prisma.memoryFactVersion.findMany({ where: { userId } });
      const evidence = await prisma.memoryEvidence.findMany({
        orderBy: { observedAt: "asc" },
        where: { userId }
      });
      expect(facts).toHaveLength(1);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        observedAt: first.userMessage.createdAt,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        safetyClassifierProviderId: null,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE"
      });
      expect(versions[0]!.ingestionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      await expect(prisma.memoryFactVersion.update({
        data: { observedAt: second.userMessage.createdAt },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/observedAt is immutable once assigned/u);
      await expect(prisma.memoryFactVersion.update({
        data: { displayText: "A rewritten semantic observation." },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/semantic observation is immutable/u);
      await expect(prisma.memoryFactVersion.update({
        data: { ingestionFingerprint: null },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/ingestionFingerprint is immutable once assigned/u);
      await expect(prisma.memoryFactVersion.create({
        data: {
          category: versions[0]!.category,
          confidence: versions[0]!.confidence,
          coreEligible: versions[0]!.coreEligible,
          coreSalience: versions[0]!.coreSalience,
          createdByEventId: versions[0]!.createdByEventId,
          directness: versions[0]!.directness,
          displayText: versions[0]!.displayText,
          factId: versions[0]!.factId,
          id: randomUUID(),
          importance: versions[0]!.importance,
          languageCode: versions[0]!.languageCode,
          modality: versions[0]!.modality,
          normalizedSearchText: versions[0]!.normalizedSearchText,
          pipelineVersion: "memory-vnext-active-duplicate-test",
          sensitivityClass: versions[0]!.sensitivityClass,
          sourceMode: "EXPLICIT",
          state: "ACTIVE",
          structuredValue: versions[0]!.structuredValue as Prisma.InputJsonValue,
          userId
        }
      })).rejects.toMatchObject({ code: "P2002" });
      expect(evidence).toHaveLength(2);
      expect(evidence.map((item) => ({
        contentHash: item.sourceMessageContentHash,
        endOffset: item.sourceEndOffset,
        evidenceFingerprint: item.evidenceFingerprint,
        excerpt: item.safeExcerpt,
        messageId: item.messageId,
        role: item.sourceRole,
        startOffset: item.sourceStartOffset
      }))).toEqual([
        {
          contentHash: memorySha256(directOwnership),
          endOffset: directOwnership.length,
          evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          excerpt: directOwnership,
          messageId: first.userMessage.id,
          role: "user",
          startOffset: 0
        },
        {
          contentHash: memorySha256(directOwnership),
          endOffset: directOwnership.length,
          evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          excerpt: directOwnership,
          messageId: second.userMessage.id,
          role: "user",
          startOffset: 0
        }
      ]);
      expect(evidence[0]!.evidenceFingerprint)
        .not.toBe(evidence[1]!.evidenceFingerprint);
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryEntityAliasSupport.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryFactVersionEntity.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.update({
        data: { sourceStartOffset: 1 },
        where: { id: evidence[0]!.id }
      })).rejects.toThrow(/exact provenance is immutable once assigned/u);
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: {
          kind: { in: ["CONSOLIDATE_CANDIDATE", "VERIFY_CANDIDATE"] },
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryEvent.count({
        where: { operation: "PROMOTE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvent.count({
        where: { operation: "REINFORCE", userId }
      })).resolves.toBe(1);
      const stagedExecutions = await prisma.memoryFactExtractionExecution.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          acceptedOutput: true,
          appliedAt: true,
          contextBindings: true,
          id: true
        },
        where: { userId }
      });
      expect(stagedExecutions).toHaveLength(2);
      expect(stagedExecutions).toEqual(stagedExecutions.map((execution) => ({
        acceptedOutput: null,
        appliedAt: expect.any(Date),
        contextBindings: null,
        id: execution.id
      })));
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: [{ createdAt: "asc" }, { candidateOrdinal: "asc" }],
        select: { candidateOrdinal: true, outcome: true },
        where: { userId }
      })).resolves.toEqual([
        { candidateOrdinal: 0, outcome: "APPLIED" },
        { candidateOrdinal: 0, outcome: "REINFORCED" }
      ]);
      await expect(prisma.memoryEvidence.create({
        data: {
          branchGeneration: evidence[0]!.branchGeneration,
          chatId: evidence[0]!.chatId,
          evidenceFingerprint: memorySha256({ probe: randomUUID() }),
          factVersionId: evidence[0]!.factVersionId,
          messageId: null,
          observedAt: evidence[0]!.observedAt,
          safeExcerpt: evidence[0]!.safeExcerpt,
          safeSourceHash: evidence[0]!.safeSourceHash,
          safetyClass: evidence[0]!.safetyClass,
          sourceEndOffset: evidence[0]!.sourceEndOffset,
          sourceMessageContentHash: evidence[0]!.sourceMessageContentHash,
          sourceProjectionVersion: evidence[0]!.sourceProjectionVersion,
          sourceRole: evidence[0]!.sourceRole,
          sourceStartOffset: evidence[0]!.sourceStartOffset,
          sourceType: evidence[0]!.sourceType,
          stance: evidence[0]!.stance,
          userId
        }
      })).rejects.toThrow(/MemoryEvidence_exact_provenance_check/u);
      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.update({
          data: { currentVersionId: null, state: "RETRACTED" },
          where: { id: versions[0]!.factId }
        });
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED" },
          where: { id: versions[0]!.id }
        });
        await tx.memoryEvidence.deleteMany({
          where: { factVersionId: versions[0]!.id, userId }
        });
      });
      await expect(prisma.$transaction(async (tx) => {
        await tx.memoryFactVersion.update({
          data: { state: "ACTIVE" },
          where: { id: versions[0]!.id }
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryFactVersion_vnext_evidence_assert" IMMEDIATE'
        );
      })).rejects.toThrow(/require exact direct-user evidence/u);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("keeps distinct Unicode slots on default admission and pins queued identity", async () => {
    const userId = await createOwner("identity-default-unicode");
    const previousProfile = process.env[MEMORY_IDENTITY_WRITE_PROFILE_ENV];
    try {
      await expect(createPrismaMemoryIdentityCutoverRepository(prisma)
        .assertActivationReady(userId)).resolves.toMatchObject({
          legacyFactCount: 0,
          readyForUnicodeWrites: true
        });
      const chat = await prisma.chat.create({
        data: { title: "Distinct topic identities", userId }
      });
      let parentMessageId: string | null = null;
      for (const [index, label] of ["report café", "report cafè"].entries()) {
        delete process.env[MEMORY_IDENTITY_WRITE_PROFILE_ENV];
        const quote = `I prefer ${label} topics.`;
        const turn = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date(Date.UTC(2026, 7, 30, 9, index)),
          parentMessageId,
          userId,
          userText: quote
        });
        parentMessageId = turn.assistantMessage.id;
        await settleChat(userId, chat.id, turn);
        const claim = await claimFactJob(userId, turn.userMessage.id);
        process.env[MEMORY_IDENTITY_WRITE_PROFILE_ENV] = "LEGACY_V1";
        const input = await prepare(claim);
        expect(input.identityProfile).toBe("UNICODE_V2");
        const plan = slotPreferencePlan(input, quote, `topic:${label}`);
        const binding = await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        );
        await expect(applyPlan(userId, claim, plan, binding))
          .resolves.toBe("APPLIED");
      }
      const facts = await prisma.memoryFact.findMany({
        select: { canonicalKey: true, identityVersion: true, state: true },
        where: { userId }
      });
      expect(facts).toHaveLength(2);
      expect(new Set(facts.map((fact) => fact.canonicalKey)).size).toBe(2);
      expect(facts.every((fact) =>
        fact.identityVersion === "slot-v4" && fact.state === "ACTIVE")).toBe(true);
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(2);
    } finally {
      if (previousProfile === undefined) {
        delete process.env[MEMORY_IDENTITY_WRITE_PROFILE_ENV];
      } else {
        process.env[MEMORY_IDENTITY_WRITE_PROFILE_ENV] = previousProfile;
      }
      await cleanupOwner(userId);
    }
  });

  it.each(["mapped", "unmapped", "ambiguous"] as const)(
    "recovers recorded legacy identity and bounds future lookup (%s)", async (mapping) => {
      const userId = await createOwner(`identity-recorded-${mapping}`);
      try {
        const chat = await prisma.chat.create({ data: { title: "Recorded identity", userId } });
        const text = "I prefer quiet rooms.";
        const first = await createTurn({ assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-30T10:00:00Z"), parentMessageId: null, userId, userText: text });
        await settleChat(userId, chat.id, first);
        const admittedClaim = await claimFactJob(userId, first.userMessage.id);
        const modernInput = await prepare(admittedClaim);
        const decoded = preferencePlan(modernInput, text, text);
        const { inputHash: _inputHash, ...inputFields } = modernInput;
        const oldFields = { ...inputFields, identityProfile: "LEGACY_V1" as const };
        const oldInput = {
          ...oldFields,
          inputHash: memoryFactExtractionInputHash(
            oldFields,
            MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS
          )
        };
        // Seed the accepted storage boundary. No retired calculator or provider
        // is used to manufacture a historical result in the current runtime.
        const canonicalKey = `prop:v1:${"a".repeat(64)}`;
        const { id: _id, usefulness: _usefulness, ...candidateFields } = decoded.candidates[0]!;
        const oldCandidate = { ...candidateFields, canonicalKey,
          identityProfile: "LEGACY_V1" as const, identityVersion: "proposition-v1" as const,
          legacyCanonicalKey: canonicalKey, legacyProposedValue: candidateFields.proposedValue };
        const candidates = [{ ...oldCandidate, id: memoryFactCandidateId(oldInput, oldCandidate) }];
        const oldPlan = { ...decoded, candidates, input: oldInput,
          outputHash: memoryFactExtractionOutputHash(oldInput, candidates, decoded.candidateOrdinals, decoded.rejections) };
        const oldClaim = { ...admittedClaim,
          idempotencyFingerprint: memoryFactExtractionJobFingerprint(modernInput.source, "LEGACY_V1") };
        await prisma.memoryJob.update({ where: { id: oldClaim.id },
          data: { idempotencyFingerprint: oldClaim.idempotencyFingerprint } });
        const oldBinding = await createSucceededBinding(
          userId,
          oldClaim,
          oldInput.inputHash,
          oldPlan.outputHash,
          MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS
        );
        await expect(applyPlan(userId, oldClaim, oldPlan, oldBinding)).resolves.toBe("APPLIED");
        const retained = await prisma.memoryFact.findFirstOrThrow({ where: { userId, canonicalKey } });
        if (mapping === "unmapped") {
          await prisma.memoryIdentityCompatibility.deleteMany({ where: { userId } });
        } else if (mapping === "ambiguous") {
          await prisma.$transaction((tx) => registerMemoryIdentityCompatibility(tx, {
            containerId: retained.scopeId, legacyCanonicalKey: canonicalKey, namespace: "FACT",
            now: new Date(), unicodeCanonicalKey: `prop:v2:${"b".repeat(64)}`, userId
          }));
        }
        const second = await createTurn({ assistantText: "Noted again.", chatId: chat.id,
          createdAt: new Date("2026-08-30T10:01:00Z"), parentMessageId: first.assistantMessage.id, userId, userText: text });
        await settleChat(userId, chat.id, second);
        const claim = await claimFactJob(userId, second.userMessage.id);
        const input = await prepare(claim);
        const plan = preferencePlan(input, text, text);
        expect(plan.candidates[0]).not.toHaveProperty("legacyCanonicalKey");
        expect(plan.candidates[0]).not.toHaveProperty("legacyProposedValue");
        const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
        await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
        const facts = await prisma.memoryFact.findMany({ where: { userId } });
        expect(facts).toHaveLength(mapping === "mapped" ? 1 : 2);
        expect(facts.find(({ id }) => id === retained.id)).toMatchObject({ canonicalKey,
          identityVersion: "proposition-v1", currentVersionId: retained.currentVersionId });
      } finally { await cleanupOwner(userId); }
    }
  );

  it.each(["mapped", "unmapped", "ambiguous"] as const)(
    "does not resurrect a forgotten legacy identity (%s)", async (mapping) => {
      const userId = await createOwner(`identity-forgotten-${mapping}`);
      try {
        const text = "回答は簡潔にしてください。";
        const chat = await prisma.chat.create({ data: { title: "Suppression identity", userId } });
        const scope = await prisma.memoryScope.create({ data: { scopeType: "GLOBAL_USER", userId } });
        const legacyKey = `prop:v1:${"c".repeat(64)}`;
        await prisma.memoryFact.create({ data: { id: randomUUID(), userId, scopeId: scope.id,
          canonicalKey: legacyKey, category: "preferences", identityKind: "PROPOSITION",
          identityVersion: "proposition-v1", state: "FORGOTTEN", forgottenAt: new Date() } });
        await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
          createMemorySuppressionInTransaction(tx, settings, keyring, {
            canonicalKey: legacyKey, explicitOverrideAllowed: false, scope: "FACT", suppressionId: randomUUID()
          }));
        const turn = await createTurn({ assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-30T10:00:00Z"), parentMessageId: null, userId, userText: text });
        await settleChat(userId, chat.id, turn);
        const claim = await claimFactJob(userId, turn.userMessage.id);
        const input = await prepare(claim);
        const plan = preferencePlan(input, text, text);
        if (mapping !== "unmapped") await prisma.$transaction(async (tx) => {
          for (const unicodeCanonicalKey of [plan.candidates[0]!.canonicalKey,
            ...mapping === "ambiguous" ? [`prop:v2:${"d".repeat(64)}`] : []]) {
            await registerMemoryIdentityCompatibility(tx, { containerId: scope.id,
              legacyCanonicalKey: legacyKey, namespace: "FACT", now: new Date(), unicodeCanonicalKey, userId });
          }
        });
        const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
        await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("EMPTY");
        await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(0);
        await expect(prisma.memoryFact.count({ where: { userId, state: "FORGOTTEN", canonicalKey: legacyKey } }))
          .resolves.toBe(1);
      } finally { await cleanupOwner(userId); }
    }
  );

  it.each([
    ["success", {}, 1, "APPLIED"],
    ["retained-v1", { cleanupPolicyVersion: "memory-maintenance-policy-v1" }, 1, "APPLIED"],
    ["unrecognized-policy", { cleanupPolicyVersion: "memory-maintenance-policy-v0" }, 1, "EMPTY"],
    ["pinned", { pinned: true }, 1, "EMPTY"],
    ["pending-purge", { outboxState: "PENDING" }, 1, "EMPTY"],
    ["old-source", {}, -1, "EMPTY"],
    ["explicit-lineage", { sourceMode: "EXPLICIT", userEvent: true }, 1, "EMPTY"]
  ] as const)(
    "relearns only after completed automatic cleanup (%s)",
    async (_label, options, observedOffsetMinutes, expected) => {
      const fixture = await seedAutomaticallyPurgedFact(_label, options);
      try {
        const observedAt = new Date(
          fixture.forgottenAt.getTime() + observedOffsetMinutes * 60_000
        );
        const second = await createTurn({
          assistantText: "Noted again.",
          chatId: fixture.chat.id,
          createdAt: observedAt,
          parentMessageId: fixture.turn.assistantMessage.id,
          userId: fixture.userId,
          userText: fixture.text
        });
        await settleChat(fixture.userId, fixture.chat.id, second);
        const claim = await claimFactJob(fixture.userId, second.userMessage.id);
        const input = await prepare(claim);
        const plan = preferencePlan(input, fixture.text, fixture.text);
        const beforeVersions = await prisma.memoryFactVersion.count({
          where: { factId: fixture.factId, userId: fixture.userId }
        });
        const binding = await createSucceededBinding(
          fixture.userId,
          claim,
          input.inputHash,
          plan.outputHash
        );
        await expect(applyPlan(fixture.userId, claim, plan, binding)).resolves.toBe(expected);
        const fact = await prisma.memoryFact.findUniqueOrThrow({
          where: { userId_id: { id: fixture.factId, userId: fixture.userId } }
        });
        expect(await prisma.memoryFactVersion.count({
          where: { factId: fixture.factId, userId: fixture.userId }
        })).toBe(expected === "APPLIED" ? beforeVersions + 1 : beforeVersions);
        if (expected === "APPLIED") {
          expect(fact.currentVersionId).toEqual(expect.any(String));
        } else {
          expect(fact.currentVersionId).toBeNull();
        }
      } finally {
        await cleanupOwner(fixture.userId);
      }
    }
  );

  it("terminalizes a valid empty extraction without writing semantic rows", async () => {
    const userId = await createOwner("empty");
    try {
      const chat = await prisma.chat.create({ data: { title: "No memory", userId } });
      const turn = await createTurn({
        assistantText: "Hello.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Hello!"
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = decodeMemoryFactExtraction([{
        arguments: { observations: [] },
        id: `fact-call-${randomUUID()}`,
        name: MEMORY_FACT_EXTRACTION_TOOL_NAME
      }], input);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("EMPTY");
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: claim.id } }))
        .resolves.toMatchObject({ stage: "fact_observations_empty_applied" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("stores no MEDIUM observation, while a HIGH remember request is stored as before", async () => {
    const userId = await createOwner("medium-admission");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Medium admission", userId }
      });
      const first = await createTurn({
        assistantText: "Cedar is the layout option we just discussed.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T09:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I am considering cedar for my usual document layouts."
      });
      await settleChat(userId, chat.id, first);
      const targetText = "Yes, that one is usually my preferred option.";
      const second = await createTurn({
        assistantText: "Understood.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T10:00:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: targetText
      });
      await settleChat(userId, chat.id, second);

      const claim = await claimFactJob(userId, second.userMessage.id);
      const input = await prepare(claim);
      const assistantRef = input.contextRefs.find(({ source }) =>
        source.messageId === first.assistantMessage.id);
      expect(assistantRef).toMatchObject({ kind: "MESSAGE", ref: "M2" });
      // The observation an earlier release kept as a fenced supporting fact.
      const plan = supportingContextPlan(input, targetText, assistantRef!.ref);
      expect(plan.candidates).toEqual([]);
      expect(plan.rejections).toEqual([
        { candidateOrdinal: 0, reasonCode: "REJECT_LOW_CONFIDENCE" }
      ]);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("EMPTY");
      // No fact, evidence or search entry exists, so nothing can reach
      // standing context or search.
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memorySearchEntry.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        select: { outcome: true, reasonCode: true },
        where: { userId }
      })).resolves.toEqual([{ outcome: "REJECTED", reasonCode: "REJECT_LOW_CONFIDENCE" }]);

      const rememberText = "Remember that I usually prefer cedar layouts.";
      const third = await createTurn({
        assistantText: "Saved.",
        chatId: chat.id,
        createdAt: new Date("2026-08-25T10:05:00.000Z"),
        parentMessageId: second.assistantMessage.id,
        userId,
        userText: rememberText
      });
      await settleChat(userId, chat.id, third);
      const rememberClaim = await claimFactJob(userId, third.userMessage.id);
      const rememberInput = await prepare(rememberClaim);
      const remembered = preferencePlan(
        rememberInput,
        rememberText,
        "The user usually prefers cedar layouts.",
        true
      );
      expect(remembered.rejections).toEqual([]);
      const rememberBinding = await createSucceededBinding(
        userId,
        rememberClaim,
        rememberInput.inputHash,
        remembered.outputHash
      );
      await expect(applyPlan(userId, rememberClaim, remembered, rememberBinding))
        .resolves.toBe("APPLIED");
      const version = await prisma.memoryFactVersion.findFirstOrThrow({
        select: { confidence: true, id: true, semanticFrame: true, sourceMode: true },
        where: { userId }
      });
      expect(version).toMatchObject({
        confidence: 1,
        semanticFrame: { memoryDirective: "EXPLICIT_REMEMBER" },
        sourceMode: "AUTOMATIC"
      });
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [version.id]
      )).resolves.toEqual(new Set([version.id]));
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each(["error", "cancelled"] as const)(
    "keeps earlier turns past a %s reply without showing or binding it",
    async (status) => {
      const userId = await createOwner(`passed-over-${status}`);
      try {
        const chat = await prisma.chat.create({ data: { title: "Failed reply context", userId } });
        const first = await createTurn({
          assistantText: "Both laptops suit travel.", chatId: chat.id,
          createdAt: new Date("2026-08-25T09:00:00.000Z"), parentMessageId: null,
          userId, userText: "Which laptop suits travel?"
        });
        await settleChat(userId, chat.id, first);
        const askedAt = new Date("2026-08-25T09:30:00.000Z");
        const question = await prisma.message.create({
          data: {
            chatId: chat.id, content: textMessageContent("Compare their batteries."),
            createdAt: askedAt, parentMessageId: first.assistantMessage.id,
            role: "user", status: "complete", updatedAt: askedAt
          }
        });
        const failedAt = new Date(askedAt.getTime() + 1_000);
        const failedText = "Partial unsettled battery comparison.";
        const failed = await prisma.message.create({
          data: {
            chatId: chat.id, content: textMessageContent(failedText), createdAt: failedAt,
            modelId: "memory-vnext-test-model", parentMessageId: question.id,
            provider: "memory-vnext-test-provider", role: "assistant", status, updatedAt: failedAt
          }
        });
        await prisma.modelRun.create({
          data: {
            assistantMessageId: failed.id, chatId: chat.id, modelId: "memory-vnext-test-model",
            normalizedRequest: { prompt: { baseline: {
              source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client"
            } } },
            provider: "memory-vnext-test-provider", status, userId, userMessageId: question.id
          }
        });
        const quote = "I bought a MacBook Air.";
        const target = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-25T10:00:00.000Z"), parentMessageId: failed.id,
          userId, userText: quote
        });
        await settleChat(userId, chat.id, target);

        const claim = await claimFactJob(userId, target.userMessage.id);
        const input = await prepare(claim);
        expect(input.messages.map(({ evidenceEligible, id, role }) => ({ evidenceEligible, id, role })))
          .toEqual([
            { evidenceEligible: false, id: first.userMessage.id, role: "user" },
            { evidenceEligible: false, id: first.assistantMessage.id, role: "assistant" },
            { evidenceEligible: false, id: question.id, role: "user" },
            { evidenceEligible: true, id: target.userMessage.id, role: "user" }
          ]);
        expect(JSON.stringify(input)).not.toContain(failedText);
        expect(JSON.stringify(input)).not.toContain(failed.id);

        const plan = extractionPlan(input, quote);
        const bindingId = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
        await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");
        await expect(prisma.memoryFactVersionSourceDependency.count({
          where: { sourceMessageId: failed.id, userId }
        })).resolves.toBe(0);
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it("stops the context walk at a reply that never settled", async () => {
    const userId = await createOwner("unsettled-reply");
    try {
      const chat = await prisma.chat.create({ data: { title: "Unsettled reply context", userId } });
      const first = await createTurn({
        assistantText: "Both laptops suit travel.", chatId: chat.id,
        createdAt: new Date("2026-08-25T09:00:00.000Z"), parentMessageId: null,
        userId, userText: "Which laptop suits travel?"
      });
      await settleChat(userId, chat.id, first);
      const askedAt = new Date("2026-08-25T09:30:00.000Z");
      const question = await prisma.message.create({
        data: {
          chatId: chat.id, content: textMessageContent("Compare their batteries."),
          createdAt: askedAt, parentMessageId: first.assistantMessage.id,
          role: "user", status: "complete", updatedAt: askedAt
        }
      });
      const unsettledAt = new Date(askedAt.getTime() + 1_000);
      const unsettledText = "Streaming battery comparison.";
      const unsettled = await prisma.message.create({
        data: {
          chatId: chat.id, content: textMessageContent(unsettledText), createdAt: unsettledAt,
          modelId: "memory-vnext-test-model", parentMessageId: question.id,
          provider: "memory-vnext-test-provider", role: "assistant", status: "streaming", updatedAt: unsettledAt
        }
      });
      const target = await createTurn({
        assistantText: "Noted.", chatId: chat.id,
        createdAt: new Date("2026-08-25T10:00:00.000Z"), parentMessageId: unsettled.id,
        userId, userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, target);

      const input = await prepare(await claimFactJob(userId, target.userMessage.id));
      expect(input.messages.map(({ evidenceEligible, id }) => ({ evidenceEligible, id })))
        .toEqual([{ evidenceEligible: true, id: target.userMessage.id }]);
      expect(JSON.stringify(input)).not.toContain(unsettledText);
      expect(JSON.stringify(input)).not.toContain(question.id);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("binds a dated relationship fact to the third-party entity and raw time", async () => {
    const userId = await createOwner("relationship-temporal");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Relationship event", userId }
      });
      const sourceText = "My spouse Alex arrived yesterday.";
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: sourceText
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = relationshipTemporalPlan(input, sourceText);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");

      const version = await prisma.memoryFactVersion.findFirstOrThrow({
        select: {
          displayText: true,
          id: true,
          occurredAt: true,
          rawTemporalExpression: true,
          semanticFrame: true,
          sourceTimezone: true,
          temporalResolutionEvidence: true
        },
        where: { userId }
      });
      expect(version).toMatchObject({
        displayText: "The current user's spouse Alex arrived yesterday. " +
          "[event_date=2026-08-25]",
        occurredAt: new Date("2026-08-25T10:00:00.000Z"),
        rawTemporalExpression: "yesterday",
        semanticFrame: expect.objectContaining({
          subjectScope: "USER_RELATIONSHIP_CONTEXT"
        }),
        sourceTimezone: "Europe/Moscow",
        temporalResolutionEvidence: expect.any(Object)
      });
      const link = await prisma.memoryFactVersionEntity.findFirstOrThrow({
        select: { entityId: true, role: true },
        where: { factVersionId: version.id, userId }
      });
      await expect(prisma.memoryEntity.findUniqueOrThrow({
        select: { displayName: true, entityType: true },
        where: { id: link.entityId }
      })).resolves.toEqual({ displayName: "Alex", entityType: "PERSON" });
      expect(link.role).toBe("SUBJECT");
      await expect(prisma.memoryEvidence.findFirstOrThrow({
        select: { messageId: true, safeExcerpt: true, sourceRole: true },
        where: { factVersionId: version.id, userId }
      })).resolves.toEqual({
        messageId: turn.userMessage.id,
        safeExcerpt: sourceText,
        sourceRole: "user"
      });
      await expect(prisma.memoryFact.findFirstOrThrow({
        select: { identityKind: true, subjectEntityId: true },
        where: { userId }
      })).resolves.toEqual({
        identityKind: "PROPOSITION",
        subjectEntityId: null
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([
    { changedSource: "message", subjectIdentity: "UNRESOLVED" },
    { changedSource: "fact", subjectIdentity: "UNRESOLVED" },
    { changedSource: "message", subjectIdentity: "SAME_ENTITY" },
    { changedSource: "fact", subjectIdentity: "SAME_ENTITY" }
  ] as const)(
    "preserves an independent pronoun fact with $subjectIdentity and fences changed $changedSource",
    async ({ changedSource, subjectIdentity }) => {
      const userId = await createOwner("pronoun-source-fences");
      try {
        const chat = await prisma.chat.create({ data: { title: "Personal context", userId } });
        const firstText = "My colleague Alex uses a quiet office.";
        const first = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
          parentMessageId: null, userId, userText: firstText
        });
        await settleChat(userId, chat.id, first);
        const firstClaim = await claimFactJob(userId, first.userMessage.id);
        const firstInput = await prepare(firstClaim);
        const firstPlan = relationshipCurrentPlan(firstInput, firstText, "Alex", firstText);
        await expect(applyPlan(userId, firstClaim, firstPlan, await createSucceededBinding(
          userId, firstClaim, firstInput.inputHash, firstPlan.outputHash
        ))).resolves.toBe("APPLIED");
        const original = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
        const nextText = "She starts at noon.";
        const second = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-26T10:01:00.000Z"),
          parentMessageId: first.assistantMessage.id, userId, userText: nextText
        });
        await settleChat(userId, chat.id, second);
        const claim = await claimFactJob(userId, second.userMessage.id);
        const input = await prepare(claim);
        const antecedent = input.contextRefs.find(({ source }) => source.factVersionId === original.id)!;
        const message = input.contextRefs.find(({ source }) => source.messageId === first.userMessage.id)!;
        expect(antecedent.entityId).not.toBeNull();
        const plan = relationshipCurrentPlan(input, nextText, "She",
          "The user's colleague Alex starts at noon.", "NONE", null,
          "USER_RELATIONSHIP_CONTEXT", { antecedentRef: antecedent.ref, messageRef: message.ref });
        expect(plan.rejections).toEqual([]);
        const packet = (await semanticAdjudicationForPlan(userId, plan))!;
        expect(packet.decisions).toHaveLength(1);
        expect(packet.decisions[0]).toMatchObject({
          entityRef: antecedent.ref, operation: "NO_RELATION", targetRef: null
        });
        const decisions = packet.decisions.map((decision) => ({ ...decision, subjectIdentity }));
        await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        ), new Date(), {
          ...packet, decisions,
          outputHash: memorySemanticAdjudicationOutputHash(packet.inputHash, decisions)
        })).resolves.toBe("APPLIED");
        const retained = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { id: { not: original.id }, userId }
        });
        expect(retained.factId).not.toBe(original.factId);
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          select: { state: true, systemTo: true }, where: { id: original.id }
        })).resolves.toEqual({ state: "ACTIVE", systemTo: null });
        await expect(prisma.memoryFact.findMany({
          select: { currentVersionId: true, state: true }, where: { userId }
        })).resolves.toEqual(expect.arrayContaining([
          { currentVersionId: original.id, state: "ACTIVE" },
          { currentVersionId: retained.id, state: "ACTIVE" }
        ]));
        await expect(prisma.memoryFactVersionSourceDependency.findMany({
          select: { dependencyKind: true, sourceFactVersionId: true, sourceMessageId: true },
          where: { targetFactVersionId: retained.id, userId }
        })).resolves.toEqual(expect.arrayContaining([
          { dependencyKind: "COREFERENCE_ANTECEDENT", sourceFactVersionId: original.id, sourceMessageId: null },
          { dependencyKind: "RELATION_CONTEXT", sourceFactVersionId: null, sourceMessageId: first.userMessage.id }
        ]));
        await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
        await expect(prisma.memoryEvidence.findMany({
          select: { messageId: true, sourceRole: true },
          where: { factVersionId: retained.id, userId }
        })).resolves.toEqual([{ messageId: second.userMessage.id, sourceRole: "user" }]);
        await expect(loadPersonalEligibleFactVersionIds(prisma, userId, [retained.id]))
          .resolves.toEqual(new Set([retained.id]));
        if (changedSource === "message") {
          await prisma.message.update({
            data: { content: textMessageContent("The source was corrected."),
              updatedAt: new Date("2026-08-26T10:02:00.000Z") },
            where: { id: first.userMessage.id }
          });
        } else {
          await prisma.$transaction(async (tx) => {
            await tx.memoryFactVersion.update({
              data: { state: "RETRACTED", systemTo: new Date() }, where: { id: original.id }
            });
            await tx.memoryFact.update({
              data: { currentVersionId: null, state: "RETRACTED" }, where: { id: original.factId }
            });
          });
        }
        await expect(loadPersonalEligibleFactVersionIds(prisma, userId, [retained.id]))
          .resolves.toEqual(new Set());
        await expect(prisma.memoryEvidence.count({
          where: { factVersionId: retained.id, userId }
        })).resolves.toBe(1);
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it.each(["exact", "unbound", "successor", "ambiguous-successor"] as const)(
    "preserves subjects and exact relationships across updates and withdrawals (%s)", async (identity) => {
    const successor = identity === "successor" || identity === "ambiguous-successor";
    const ambiguous = identity === "ambiguous-successor";
    const userId = await createOwner("relationship-mutation-guard");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Relationship mutation guard", userId }
      });
      let parentMessageId: string | null = null;
      let minute = 0;
      async function turnPlan(
        text: string,
        subject: string,
        statement: string,
        changeIntent: "NONE" | "STATE_CHANGE" | "RETRACTION" = "NONE",
        targetVersionId: string | null = null,
        subjectScope: "CURRENT_USER" | "USER_RELATIONSHIP_CONTEXT" =
          "USER_RELATIONSHIP_CONTEXT",
        additionalSubject?: string
      ) {
        const createdAt = new Date(`2026-08-27T10:${String(minute).padStart(2, "0")}:00.000Z`);
        minute += 1;
        const turn = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt,
          parentMessageId,
          userId,
          userText: text
        });
        parentMessageId = turn.assistantMessage.id;
        await settleChat(userId, chat.id, turn);
        const claim = await claimFactJob(userId, turn.userMessage.id);
        const input = await prepare(claim);
        const plan = relationshipCurrentPlan(
          input, text, subject, statement, changeIntent, targetVersionId, subjectScope,
          undefined, additionalSubject
        );
        const bindingId = await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        );
        return { bindingId, claim, createdAt, plan };
      }

      const initial = await turnPlan(
        successor ? "My manager is Lia." : "My sister Lia works at North Bakery.",
        "Lia",
        successor ? "The current user's manager is Lia."
          : "The current user's sister Lia works at North Bakery."
      );
      await expect(applyPlan(
        userId, initial.claim, initial.plan, initial.bindingId,
        new Date(initial.createdAt.getTime() + 30_000)
      )).resolves.toBe("APPLIED");
      const original = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "ACTIVE", userId }
      });
      const originalSubject = await prisma.memoryFactVersionEntity.findFirstOrThrow({
        where: { factVersionId: original.id, role: "SUBJECT", userId }
      });
      let neighborId: string | null = null;
      if (successor) {
        const neighbor = await turnPlan("Lia is also my piano teacher.", "Lia",
          "The current user's piano teacher is Lia.");
        await expect(applyPlan(userId, neighbor.claim, neighbor.plan, neighbor.bindingId,
          new Date(neighbor.createdAt.getTime() + 30_000))).resolves.toBe("APPLIED");
        neighborId = (await prisma.memoryFactVersion.findFirstOrThrow({
          where: { state: "ACTIVE", userId, id: { not: original.id } }
        })).id;
      }

      for (const mismatch of [
        await turnPlan(
          "My colleague Remy works at East Studio now.",
          "Remy",
          "The current user's colleague Remy works at East Studio.",
          "STATE_CHANGE",
          original.id
        ),
        await turnPlan(
          "I work at North Bakery now.",
          "Lia",
          "The current user works at North Bakery.",
          "STATE_CHANGE",
          original.id,
          "CURRENT_USER"
        )
      ]) {
        await expect(applyPlan(
          userId,
          mismatch.claim,
          mismatch.plan,
          mismatch.bindingId,
          new Date(mismatch.createdAt.getTime() + 30_000),
          relationshipMutationPacket(mismatch.plan, original.id, "SUPERSEDE_TARGET")
        )).resolves.toBe("EMPTY");
        const mismatchExecution = await prisma.memoryFactExtractionExecution.findFirstOrThrow({
          select: { id: true }, where: { memoryJobId: mismatch.claim.id, userId }
        });
        await expect(prisma.memoryFactExtractionCandidateReceipt.findFirstOrThrow({
          select: { outcome: true, reasonCode: true },
          where: { extractionExecutionId: mismatchExecution.id, userId }
        })).resolves.toMatchObject({ outcome: "REJECTED", reasonCode: "repository_guarded_noop" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: original.id }
        })).resolves.toMatchObject({ state: "ACTIVE", systemTo: null });
      }

      const update = await turnPlan(
        successor ? "My new manager is Remy, replacing Lia." : identity === "unbound"
          ? "My sister Lia's new workplace is South Bakery."
          : "My sister Lia now works at South Bakery.",
        successor ? "Remy" : identity === "unbound" ? "Lia's" : "Lia",
        successor ? "The current user's manager is now Remy."
          : "The current user's sister Lia now works at South Bakery.",
        "STATE_CHANGE",
        identity === "unbound" ? null : original.id,
        "USER_RELATIONSHIP_CONTEXT",
        ambiguous ? "Lia" : undefined
      );
      if (identity === "unbound") {
        expect(update.plan.candidates[0]!.dependencies).toEqual([]);
        expect(update.plan.candidates[0]!.entities[0]!.contextEntityId).toBeNull();
      }
      await expect(applyPlan(
        userId,
        update.claim,
        update.plan,
        update.bindingId,
        new Date(update.createdAt.getTime() + 30_000),
        relationshipMutationPacket(update.plan, original.id,
          successor ? "REPLACE_RELATIONSHIP_TARGET" : "SUPERSEDE_TARGET",
          identity === "unbound" ? "SAME_ENTITY" : undefined)
      )).resolves.toBe(identity === "unbound" || ambiguous ? "EMPTY" : "APPLIED");
      if (identity === "unbound" || ambiguous) {
        const execution = await prisma.memoryFactExtractionExecution.findFirstOrThrow({
          select: { id: true }, where: { memoryJobId: update.claim.id, userId }
        });
        await expect(prisma.memoryFactExtractionCandidateReceipt.findFirstOrThrow({
          select: { outcome: true, reasonCode: true },
          where: { extractionExecutionId: execution.id, userId }
        })).resolves.toMatchObject({ outcome: "REJECTED", reasonCode: "repository_guarded_noop" });
        await expect(prisma.memoryFactVersion.findMany({
          select: { id: true, state: true, systemTo: true }, where: { userId }
        })).resolves.toEqual(expect.arrayContaining([
          { id: original.id, state: "ACTIVE", systemTo: null },
          ...(neighborId ? [{ id: neighborId, state: "ACTIVE", systemTo: null }] : [])
        ]));
        await expect(prisma.memoryFactVersion.count({ where: { userId } }))
          .resolves.toBe(neighborId ? 2 : 1);
        await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
        await expect(prisma.memoryFactVersionEntity.findMany({
          select: { entityId: true }, where: { factVersionId: original.id, role: "SUBJECT", userId }
        })).resolves.toEqual([{ entityId: originalSubject.entityId }]);
        return;
      }
      const pendingUpdate = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "PENDING_RELATION", userId }
      });
      const newSubjects = await prisma.memoryFactVersionEntity.findMany({
        select: { entityId: true },
        where: { factVersionId: pendingUpdate.id, role: "SUBJECT", userId }
      });
      if (successor) {
        expect(newSubjects).toHaveLength(1);
        expect(newSubjects[0]!.entityId).not.toBe(originalSubject.entityId);
        await expect(prisma.memoryFactVersionEntity.findMany({
          select: { entityId: true }, where: { factVersionId: neighborId!, role: "SUBJECT", userId }
        })).resolves.toEqual([{ entityId: originalSubject.entityId }]);
      } else expect(newSubjects).toEqual([{ entityId: originalSubject.entityId }]);
      await expect(prisma.memoryEntity.count({ where: { userId } }))
        .resolves.toBe(successor ? 2 : 1);
      await expect(prisma.memoryFactVersionSourceDependency.findMany({
        select: { dependencyKind: true, sourceFactVersionId: true },
        where: { targetFactVersionId: pendingUpdate.id, userId }
      })).resolves.toEqual(expect.arrayContaining([{
        dependencyKind: "CORRECTION_TARGET", sourceFactVersionId: original.id
      }]));
      const relationSettings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const relationClaim: MemoryJobClaim = {
        ...update.claim,
        id: randomUUID(),
        kind: "RESOLVE_FACT_RELATIONS",
        memoryGenerationSnapshot: relationSettings.memoryGeneration,
        memoryRevisionSnapshot: relationSettings.memoryRevision,
        pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
        targetFactVersionId: pendingUpdate.id
      };
      const relations = createPrismaMemoryRelationRepository(prisma);
      const relationPrepared = await relations.prepare(relationClaim, new Date());
      if (relationPrepared.status !== "READY") throw new Error("memory_relationship_relation_not_ready");
      const relationDecision = decideMemoryFactRelation(relationPrepared.prepared.snapshot, new Date());
      expect(relationDecision).toMatchObject({ operation: "MOVE_TO_DISTINCT_FACT", targetVersionId: original.id });
      await prisma.$transaction((tx) => relations.apply(tx, relationClaim, {
        decision: relationDecision,
        executionId: null,
        expectedSnapshotHash: relationPrepared.prepared.snapshotHash
      }, new Date()));
      const activeAfterUpdate = await prisma.memoryFactVersion.findMany({
        orderBy: { createdAt: "asc" }, select: { id: true, displayText: true, state: true },
        where: { state: "ACTIVE", userId }
      });
      const updated = activeAfterUpdate.find(({ displayText }) =>
        displayText?.includes(successor ? "Remy" : "South Bakery"));
      if (!updated) throw new Error("memory_relationship_update_value_missing");
      if (neighborId) expect(activeAfterUpdate.map(({ id }) => id)).toContain(neighborId);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
        .resolves.toMatchObject({ state: "SUPERSEDED" });

      const withdrawal = await turnPlan(
        successor ? "Remy is no longer my manager."
          : "My sister Lia no longer works at South Bakery.",
        successor ? "Remy" : "Lia",
        successor ? "The current user withdraws that Remy is their manager."
          : "The current user withdraws the report that sister Lia works at South Bakery.",
        "RETRACTION",
        updated.id
      );
      await expect(applyPlan(
        userId,
        withdrawal.claim,
        withdrawal.plan,
        withdrawal.bindingId,
        new Date(withdrawal.createdAt.getTime() + 30_000),
        relationshipMutationPacket(withdrawal.plan, updated.id, "RETRACT_TARGET")
      )).resolves.toBe("APPLIED");
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: updated.id }
      })).resolves.toMatchObject({ state: "RETRACTED", systemTo: expect.any(Date) });
      await expect(prisma.memoryFactVersion.count({
        where: { state: "ACTIVE", userId }
      })).resolves.toBe(successor ? 1 : 0);
      if (neighborId) await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: neighborId } }))
        .resolves.toMatchObject({ state: "ACTIVE", systemTo: null });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E04] recovers a three-candidate staged packet after a post-first-candidate fault", async () => {
    const userId = await createOwner("candidate-isolation");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Per-candidate recovery", userId }
      });
      const sourceText = [
        "I bought a MacBook Air.",
        "I bought a Dell XPS 13.",
        "I bought a Lenovo ThinkPad X1 yesterday."
      ].join(" ");
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:30:00.000Z"),
        parentMessageId: null,
        userId,
        userText: sourceText
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const first = extractionPlan(input, "I bought a MacBook Air.");
      const middle = extractionPlan(
        input,
        "I bought a Dell XPS 13.",
        "The user bought a Dell XPS 13.",
        "owned",
        undefined,
        { brand: "Dell", label: "XPS 13", model: "XPS 13" }
      );
      const last = extractionPlan(
        input,
        "I bought a Lenovo ThinkPad X1 yesterday.",
        "The user bought a Lenovo ThinkPad X1.",
        "owned",
        undefined,
        { brand: "Lenovo", label: "ThinkPad X1", model: "ThinkPad X1" }
      );
      const { id: _middleId, ...middleWithoutId } = middle.candidates[0]!;
      const rejectedWithoutId = {
        ...middleWithoutId,
        dependencies: [{
          dependencyKind: "COREFERENCE_ANTECEDENT" as const,
          ref: "missing-fact-context",
          source: {
            contentHash: null,
            factVersionId: randomUUID(),
            messageId: null,
            messageUpdatedAt: null,
            projectionVersion: null
          }
        }]
      };
      const rejected = {
        ...rejectedWithoutId,
        id: memoryFactCandidateId(input, rejectedWithoutId)
      };
      const candidates = [first.candidates[0]!, rejected, last.candidates[0]!];
      const candidateOrdinals = [0, 1, 2];
      const plan: MemoryFactExtractionPlan = {
        candidateOrdinals,
        candidates,
        input,
        outputHash: memoryFactExtractionOutputHash(
          input,
          candidates,
          candidateOrdinals,
          []
        ),
        rejections: []
      };
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      const firstAttemptAt = new Date();
      const adjudication = await semanticAdjudicationForPlan(userId, plan);
      await stagePlanOnly(userId, claim, plan, bindingId, firstAttemptAt);
      await expect(withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
        repository().apply(
          failAfterFirstAppliedCandidate(tx),
          settings,
          claim,
          plan,
          bindingId,
          firstAttemptAt,
          adjudication
        )
      )).rejects.toThrow("memory_eval_fault_after_candidate_one");
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { candidateOrdinal: "asc" },
        select: { candidateOrdinal: true, outcome: true },
        where: { userId }
      })).resolves.toEqual([
        { candidateOrdinal: 0, outcome: "PENDING" },
        { candidateOrdinal: 1, outcome: "PENDING" },
        { candidateOrdinal: 2, outcome: "PENDING" }
      ]);
      await expect(prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { acceptedOutput: true, appliedAt: true },
        where: { userId }
      })).resolves.toMatchObject({
        acceptedOutput: expect.any(Object),
        appliedAt: null
      });
      await expect(prisma.memoryJob.findUniqueOrThrow({
        select: { stage: true, state: true },
        where: { id: claim.id }
      })).resolves.toEqual({ stage: null, state: "CLAIMED" });

      await expect(withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
        repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date(firstAttemptAt.getTime() + 1),
          adjudication
        )
      ))
        .resolves.toBe("APPLIED");
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { candidateOrdinal: "asc" },
        select: { candidateOrdinal: true, outcome: true, reasonCode: true },
        where: { userId }
      })).resolves.toEqual([
        { candidateOrdinal: 0, outcome: "APPLIED", reasonCode: null },
        {
          candidateOrdinal: 1,
          outcome: "REJECTED",
          reasonCode: "dependency_source_stale"
        },
        { candidateOrdinal: 2, outcome: "APPLIED", reasonCode: null }
      ]);
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(2);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { acceptedOutput: true, appliedAt: true, contextBindings: true },
        where: { userId }
      })).resolves.toEqual({
        acceptedOutput: null,
        appliedAt: expect.any(Date),
        contextBindings: null
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E04] converges concurrent staged recovery without duplicate rows", async () => {
    const userId = await createOwner("staged-recovery-race");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Concurrent staged recovery", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:45:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      const now = new Date();
      await expect(prisma.memoryExecutionBinding.update({
        data: {
          acceptedOutputHash: plan.outputHash,
          completedAt: now,
          recoverableUntil: new Date(now.getTime() + 86_400_000),
          state: "SUCCEEDED"
        },
        where: { id: bindingId }
      })).rejects.toThrow(/lacks staged result/u);
      await stagePlanOnly(userId, claim, plan, bindingId, now);
      await expect(repository().staged(
        claim,
        bindingId,
        input,
        new Date(now.getTime() + 1)
      )).resolves.toMatchObject({
        candidateOrdinals: [0],
        outputHash: plan.outputHash,
        rejections: []
      });

      const adjudication = await semanticAdjudicationForPlan(userId, plan);
      await expect(Promise.all([1, 2].map(() =>
        withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
          repository().apply(
            tx,
            settings,
            claim,
            plan,
            bindingId,
            now,
            adjudication
          ))
      ))).resolves.toEqual(["APPLIED", "APPLIED"]);
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvent.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactExtractionCandidateReceipt.count({
        where: { userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("expires an unapplied packet before detaching its execution authority", async () => {
    const userId = await createOwner("staged-recovery-expiry");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Expired staged recovery", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:50:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      const stagedAt = new Date();
      await stagePlanOnly(userId, claim, plan, bindingId, stagedAt);
      const expiredAt = new Date(stagedAt.getTime() + 86_400_001);

      await expect(prisma.$transaction((tx) =>
        detachExpiredMemoryExecutionBindings(tx, { bindingId }, expiredAt)
      )).resolves.toBe(1);
      await expect(prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { acceptedOutput: true, appliedAt: true, contextBindings: true },
        where: { userId }
      })).resolves.toEqual({
        acceptedOutput: null,
        appliedAt: expiredAt,
        contextBindings: null
      });
      await expect(prisma.memoryFactExtractionCandidateReceipt.findFirstOrThrow({
        select: { outcome: true, reasonCode: true },
        where: { userId }
      })).resolves.toEqual({
        outcome: "STALE",
        reasonCode: "recovery_window_expired"
      });
      await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({
        select: {
          connectionId: true,
          credentialId: true,
          credentialVersionId: true,
          providerModelId: true,
          relationsDetachedAt: true
        },
        where: { id: bindingId }
      })).resolves.toEqual({
        connectionId: null,
        credentialId: null,
        credentialVersionId: null,
        providerModelId: null,
        relationsDetachedAt: expiredAt
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E03] resolves a cross-language context reference to one entity-backed fact", async () => {
    const userId = await createOwner("context-dependency");
    try {
      await activateHybridIndex(userId);
      const sourceChat = await prisma.chat.create({
        data: { title: "MacBook source", userId }
      });
      const sourceTurn = await createTurn({
        assistantText: "Purchase noted.",
        chatId: sourceChat.id,
        createdAt: new Date("2026-08-24T06:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, sourceChat.id, sourceTurn);
      const sourceClaim = await claimFactJob(userId, sourceTurn.userMessage.id);
      const sourceInput = await prepare(sourceClaim);
      const sourcePlan = extractionPlan(
        sourceInput,
        "I bought a MacBook Air."
      );
      const sourceBinding = await createSucceededBinding(
        userId,
        sourceClaim,
        sourceInput.inputHash,
        sourcePlan.outputHash
      );
      await expect(applyPlan(
        userId,
        sourceClaim,
        sourcePlan,
        sourceBinding
      )).resolves.toBe("APPLIED");
      const sourceVersion = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      expect(sourceVersion).toMatchObject({
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION
      });

      const contextChat = await prisma.chat.create({
        data: { title: "MacBook context", userId }
      });
      const contextTurn = await createTurn({
        assistantText: "Order noted.",
        chatId: contextChat.id,
        createdAt: new Date("2026-08-24T06:01:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Я одолжил макбук."
      });
      await settleChat(userId, contextChat.id, contextTurn);
      const contextClaim = await claimFactJob(userId, contextTurn.userMessage.id);
      const contextInput = await prepare(contextClaim);
      const factRef = contextInput.contextRefs.find(({ kind }) =>
        kind === "FACT_VERSION");
      expect(factRef).toMatchObject({
        displayName: "MacBook Air",
        entityType: "DEVICE",
        source: { factVersionId: sourceVersion.id }
      });
      expect(factRef?.entityId).toMatch(/^[a-f0-9]{64}$/u);
      const contextPlan = contextualProductPlan(contextInput, factRef!.ref);
      expect(contextPlan.rejections).toEqual([]);
      const contextBinding = await createSucceededBinding(
        userId,
        contextClaim,
        contextInput.inputHash,
        contextPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        contextClaim,
        contextPlan,
        contextBinding
      )).resolves.toBe("APPLIED");

      const dependency = await prisma.memoryFactVersionSourceDependency
        .findFirstOrThrow({ where: { userId } });
      expect(dependency).toMatchObject({
        dependencyKind: "RELATION_CONTEXT",
        sourceFactVersionId: sourceVersion.id
      });
      const targetEvidence = await prisma.memoryEvidence.findMany({
        where: { factVersionId: dependency.targetFactVersionId, userId }
      });
      expect(targetEvidence).toHaveLength(1);
      expect(targetEvidence[0]).toMatchObject({
        messageId: contextTurn.userMessage.id,
        safeExcerpt: "Я одолжил макбук.",
        sourceRole: "user"
      });
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFact.findMany({
        select: {
          canonicalKey: true,
          identityVersion: true,
          subjectEntityId: true
        },
        where: { userId }
      })).resolves.toEqual([{
        canonicalKey: `slot:v3:entity:${factRef!.entityId}:product_status:_`,
        identityVersion: "slot-v3",
        subjectEntityId: factRef!.entityId
      }]);
      await expect(prisma.memoryEntityAlias.findMany({
        orderBy: { normalizedAlias: "asc" },
        select: { normalizedAlias: true },
        where: { userId }
      })).resolves.toEqual([
        { normalizedAlias: "macbook air" },
        { normalizedAlias: "макбук" }
      ]);

      const replacement = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: textMessageContent("Replacement source branch."),
          createdAt: new Date("2026-08-24T06:02:00.000Z"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: replacement.id },
        where: { id: sourceChat.id }
      });
      await expect(prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_fact_dependencies_valid(
          ${userId},
          ${dependency.targetFactVersionId}
        ) AS valid
      `)).resolves.toEqual([{ valid: false }]);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: dependency.targetFactVersionId, userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("converges assistant regeneration on one exact source-message job", async () => {
    const userId = await createOwner("regeneration");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Assistant regeneration", userId }
      });
      const original = await createTurn({
        assistantText: "First answer.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:10:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, original);
      const originalJob = await claimFactJob(userId, original.userMessage.id);
      const originalInput = await prepare(originalJob);
      const originalPlan = extractionPlan(
        originalInput,
        "I bought a MacBook Air."
      );
      const originalBinding = await createSucceededBinding(
        userId,
        originalJob,
        originalInput.inputHash,
        originalPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        originalJob,
        originalPlan,
        originalBinding
      )).resolves.toBe("APPLIED");
      const learnedVersion = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      const { subjectEntityId } = await prisma.memoryFact.findUniqueOrThrow({
        select: { subjectEntityId: true },
        where: { id: learnedVersion.factId }
      });
      expect(subjectEntityId).toEqual(expect.any(String));
      await expect(loadMemoryReusableFactVersionIds(
        prisma,
        userId,
        [learnedVersion.id]
      )).resolves.toEqual(new Set([learnedVersion.id]));
      await prisma.modelRun.create({
        data: {
          assistantMessageId: original.assistantMessage.id,
          chatId: chat.id,
          createdAt: new Date(original.run.createdAt.getTime() + 1_000),
          modelId: "memory-vnext-test-model",
          normalizedRequest: {
            prompt: {
              baseline: {
                source: "standard_chat",
                timeZone: "America/New_York",
                timeZoneSource: "client"
              }
            }
          },
          provider: "memory-vnext-test-provider",
          status: "complete",
          userId,
          userMessageId: original.userMessage.id
        }
      });
      const assistantAt = new Date("2026-08-22T11:10:02.000Z");
      const regeneratedAssistant = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Regenerated answer."),
          createdAt: assistantAt,
          modelId: "memory-vnext-test-model",
          parentMessageId: original.userMessage.id,
          provider: "memory-vnext-test-provider",
          role: "assistant",
          status: "complete",
          updatedAt: assistantAt
        }
      });
      const regeneratedRun = await prisma.modelRun.create({
        data: {
          assistantMessageId: regeneratedAssistant.id,
          chatId: chat.id,
          modelId: "memory-vnext-test-model",
          normalizedRequest: {
            prompt: {
              baseline: {
                source: "standard_chat",
                timeZone: "Asia/Tokyo",
                timeZoneSource: "client"
              }
            }
          },
          provider: "memory-vnext-test-provider",
          status: "complete",
          userId,
          userMessageId: original.userMessage.id
        }
      });
      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("memory_vnext_test_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["BRANCH_PATH_CHANGE"],
          patch: { activeLeafMessageId: regeneratedAssistant.id }
        });
      });
      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("memory_vnext_test_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: {
            assistantMessageId: regeneratedAssistant.id,
            runId: regeneratedRun.id,
            status: "complete"
          }
        });
      });

      const jobs = await prisma.memoryJob.findMany({
        where: {
          kind: "EXTRACT_FACTS",
          sourceMessageId: original.userMessage.id,
          userId
        }
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.idempotencyFingerprint)
        .toBe(originalJob.idempotencyFingerprint);
      await expect(repository().preflight(originalJob)).resolves.toEqual({
        status: "READY"
      });
      await expect(prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { appliedAt: true, inputHash: true },
        where: { memoryJobId: originalJob.id, userId }
      })).resolves.toMatchObject({
        appliedAt: expect.any(Date),
        inputHash: originalInput.inputHash
      });
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [learnedVersion.id]
      )).resolves.toEqual(new Set([learnedVersion.id]));
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryFact.findFirstOrThrow({ where: { userId } }))
        .resolves.toMatchObject({
          currentVersionId: learnedVersion.id,
          state: "ACTIVE"
        });
      // The regenerated answer keeps the source message on the active path,
      // so the product's subject entity keeps its exact alias support and the
      // fact stays reusable for standing context and search.
      await expect(prisma.memoryEntity.findUniqueOrThrow({
        select: { state: true },
        where: { id: subjectEntityId! }
      })).resolves.toEqual({ state: "ACTIVE" });
      await expect(loadMemoryReusableFactVersionIds(
        prisma,
        userId,
        [learnedVersion.id]
      )).resolves.toEqual(new Set([learnedVersion.id]));
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([
    ["ordinary", "/memory remember that I bought a MacBook Air."],
    ["leading whitespace", "\n/MEMORY\tremember that I bought a MacBook Air."],
    ["oversized", `/memory ${"context ".repeat(13_000)}remember that I bought a MacBook Air.`]
  ])("excludes an explicit %s protocol command without a mutation receipt from automatic testimony", async (_label, userText) => {
    const userId = await createOwner("explicit-command-fence");
    try {
      const chat = await prisma.chat.create({ data: { title: "Explicit command fence", userId } });
      const turn = await createTurn({
        assistantText: "The Memory operation could not be completed.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: userText!
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      expect(await prisma.memoryJob.count({ where: { kind: "MEMORY_COMMAND", userId } })).toBe(0);
      const excluded = { errorCode: "memory_fact_source_command_excluded", status: "CANCELLED" };
      expect(await repository().preflight(claim)).toEqual(excluded);
      expect(await repository().prepare(claim)).toEqual({ decision: excluded });
      expect(await prisma.memoryExecutionBinding.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryFact.count({ where: { userId } })).toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rechecks the command fence before applying already staged automatic facts", async () => {
    const userId = await createOwner("command-fence");
    try {
      const chat = await prisma.chat.create({ data: { title: "Command fence", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
      await stagePlanOnly(userId, claim, plan, bindingId);
      await withLockedMemoryTransaction(prisma, userId, async (tx, settings) => {
        await enqueueMemoryCommand(tx, settings, {
          activeLeafMessageId: turn.assistantMessage.id,
          branchGeneration: claim.branchGeneration!,
          chatId: chat.id,
          sourceHash: claim.sourceHash!,
          sourceMessageId: turn.userMessage.id,
          sourceRevision: claim.sourceRevision!
        });
      });

      expect(await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
        repository().apply(tx, settings, claim, plan, bindingId, new Date())))
        .toBe("STALE");
      expect(await prisma.memoryFact.count({ where: { userId } })).toBe(0);
      expect(await prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { acceptedOutput: true, appliedAt: true },
        where: { memoryJobId: claim.id, userId }
      })).toEqual({ acceptedOutput: null, appliedAt: expect.any(Date) });
      expect(await prisma.memoryFactExtractionCandidateReceipt.findMany({
        select: { outcome: true, reasonCode: true },
        where: { userId }
      })).toEqual([{ outcome: "STALE", reasonCode: "source_stale" }]);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects a delayed job whose direct source message was deleted", async () => {
    const userId = await createOwner("deleted-source");
    try {
      const chat = await prisma.chat.create({ data: { title: "Deleted source", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      await prisma.memoryJob.delete({ where: { id: claim.id } });
      await prisma.modelRun.delete({ where: { id: turn.run.id } });
      await prisma.message.delete({ where: { id: turn.assistantMessage.id } });
      await prisma.message.delete({ where: { id: turn.userMessage.id } });

      await expect(repository().preflight(claim)).resolves.toEqual({
        errorCode: "memory_fact_source_stale",
        status: "STALE"
      });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects a delayed job when the active branch no longer contains its source", async () => {
    const userId = await createOwner("branch-exclusion");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Branch exclusion", userId }
      });
      const retained = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:10:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, retained);
      const claim = await claimFactJob(userId, retained.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await stagePlanOnly(userId, claim, plan, bindingId);
      const sibling = await createTurn({
        assistantText: "A separate branch.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:11:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "This branch replaces the first one."
      });
      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("memory_vnext_test_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["BRANCH_PATH_CHANGE"],
          patch: { activeLeafMessageId: sibling.assistantMessage.id }
        });
      });

      await expect(repository().preflight(claim)).resolves.toEqual({
        errorCode: "memory_fact_source_stale",
        status: "STALE"
      });
      await expect(prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { acceptedOutput: true, appliedAt: true, contextBindings: true },
        where: { userId }
      })).resolves.toEqual({
        acceptedOutput: null,
        appliedAt: expect.any(Date),
        contextBindings: null
      });
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        select: { outcome: true, reasonCode: true },
        where: { userId }
      })).resolves.toEqual([{
        outcome: "STALE",
        reasonCode: "source_invalidated"
      }]);
      await expect(repository().applied(claim, bindingId)).resolves.toBeNull();
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects messages created inside a closed automatic-learning pause interval", async () => {
    const userId = await createOwner("pause");
    try {
      const chat = await prisma.chat.create({ data: { title: "Paused source", userId } });
      const createdAt = new Date("2026-08-22T13:00:00.000Z");
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt,
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      await prisma.memoryPauseInterval.create({
        data: {
          memoryGeneration: claim.memoryGenerationSnapshot,
          pausedAt: new Date(createdAt.getTime() - 1_000),
          resumedAt: new Date(createdAt.getTime() + 1_000),
          scope: "AUTOMATIC_LEARNING",
          userId
        }
      });
      await expect(repository().preflight(claim)).resolves.toMatchObject({
        status: "STALE"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects a pre-reset job after the Memory generation advances", async () => {
    const userId = await createOwner("generation");
    try {
      const chat = await prisma.chat.create({ data: { title: "Generation fence", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T14:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      await prisma.userMemorySettings.update({
        data: { memoryGeneration: { increment: 1 } },
        where: { userId }
      });
      await expect(repository().preflight(claim)).resolves.toMatchObject({
        status: "STALE"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("[E04] fences a staged apply behind a concurrent Memory reset", async () => {
    const userId = await createOwner("generation-apply-race");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Generation/apply race", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T14:10:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      const stagedAt = new Date();
      await stagePlanOnly(userId, claim, plan, bindingId, stagedAt);
      const adjudication = await semanticAdjudicationForPlan(userId, plan);

      let markResetLocked!: () => void;
      const resetLocked = new Promise<void>((resolve) => {
        markResetLocked = resolve;
      });
      let releaseReset!: () => void;
      const resetMayCommit = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      const reset = prisma.$transaction(async (tx) => {
        await lockMemorySettings(tx, userId, true);
        await tx.userMemorySettings.update({
          data: { memoryGeneration: { increment: 1 } },
          where: { userId }
        });
        markResetLocked();
        await resetMayCommit;
      });
      await resetLocked;

      let markApplyWaiting!: () => void;
      const applyWaiting = new Promise<void>((resolve) => {
        markApplyWaiting = resolve;
      });
      const apply = prisma.$transaction(async (tx) => {
        markApplyWaiting();
        const settings = await lockMemorySettings(tx, userId, true);
        return repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date(stagedAt.getTime() + 1),
          adjudication
        );
      });
      await applyWaiting;
      releaseReset();
      const [, outcome] = await Promise.all([reset, apply]);

      expect(outcome).toBe("STALE");
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        select: { outcome: true, reasonCode: true },
        where: { userId }
      })).resolves.toEqual([{
        outcome: "STALE",
        reasonCode: "source_stale"
      }]);
      await expect(prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { acceptedOutput: true, appliedAt: true },
        where: { userId }
      })).resolves.toEqual({
        acceptedOutput: null,
        appliedAt: expect.any(Date)
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("enforces direct-user source identity at the database boundary", async () => {
    const userId = await createOwner("assistant-source");
    try {
      const chat = await prisma.chat.create({ data: { title: "Assistant source", userId } });
      const turn = await createTurn({
        assistantText: "Assistant text is not evidence.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T15:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Hello."
      });
      await expect(prisma.memoryJob.create({
        data: {
          activeLeafMessageId: turn.assistantMessage.id,
          branchGeneration: 0,
          chatId: chat.id,
          idempotencyFingerprint: memorySha256(randomUUID()),
          kind: "EXTRACT_FACTS",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
          sourceHash: "a".repeat(64),
          sourceMessageId: turn.assistantMessage.id,
          sourceRevision: 0,
          userId
        }
      })).rejects.toThrow(/exact settled direct USER message/u);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("commits Safety Lite semantics and independently queues hybrid indexing", async () => {
    const userId = await createOwner("embedding-outage");
    try {
      await activateHybridIndex(userId);
      const chat = await prisma.chat.create({ data: { title: "Embedding outage", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T16:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const input = await prepare(claim);
      const plan = extractionPlan(input, "I bought a MacBook Air.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");

      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(1);
      const version = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      expect(version).toMatchObject({
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        safetyClassifierProviderId: null,
        state: "ACTIVE"
      });
      await expect(prisma.memorySearchEntry.findFirstOrThrow({
        where: { factVersionId: version.id, userId }
      })).resolves.toMatchObject({
        embeddingState: "PENDING",
        factVersionId: version.id,
        itemType: "FACT_VERSION"
      });
      await expect(prisma.memoryJob.count({
        where: { kind: "EMBED_ITEMS", state: "QUEUED", userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEmbeddingBatchItem.count({
        where: { userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("reinforces the exact value without replacing explicit authority", async () => {
    const userId = await createOwner("explicit-authority");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Explicit authority reinforcement", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const source = await prepare(claim);
      const plan = extractionPlan(source, "I bought a MacBook Air.");
      const candidate = plan.candidates[0]!;
      const scope = await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      const factId = randomUUID();
      const versionId = randomUUID();
      const eventId = randomUUID();
      await prisma.$transaction(async (tx) => {
        const materializedCandidate = await materializeMemoryCandidateEntityIdentity(
          tx,
          { adjudicatedEntityId: null, candidate, userId }
        );
        await tx.memoryFact.create({
          data: {
            canonicalKey: materializedCandidate.canonicalKey,
            category: materializedCandidate.category,
            dimensionKey: materializedCandidate.dimensionKey,
            id: factId,
            identityKind: materializedCandidate.identityKind,
            identityVersion: materializedCandidate.identityVersion,
            predicateKey: materializedCandidate.predicateKey,
            scopeId: scope.id,
            state: "ORPHANED",
            subjectEntityId: materializedCandidate.subjectEntityId,
            subjectKey: materializedCandidate.subjectKey,
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
            category: materializedCandidate.category,
            confidence: 1,
            createdByEventId: eventId,
            directness: "DIRECT",
            displayText: materializedCandidate.displayText,
            factId,
            id: versionId,
            importance: 1,
            languageCode: materializedCandidate.languageCode,
            modality: materializedCandidate.modality,
            normalizedSearchText: normalizeMemorySearchText(
              materializedCandidate.displayText
            ),
            pipelineVersion: "memory-explicit-authority-test-v1",
            safetyClassificationState: "PENDING",
            sensitivityClass: "NORMAL",
            sourceMode: "EXPLICIT",
            state: "ACTIVE",
            structuredValue: materializedCandidate.proposedValue as Prisma.InputJsonValue,
            userId
          }
        });
        await tx.memoryEvidence.create({
          data: {
            factVersionId: versionId,
            memoryEventId: eventId,
            observedAt: turn.userMessage.createdAt,
            safeExcerpt: materializedCandidate.displayText,
            safeSourceHash: memorySha256(materializedCandidate.displayText),
            safetyClass: "NORMAL",
            sourceProjectionVersion: "memory-explicit-authority-test-v1",
            sourceType: "EXPLICIT_ACTION",
            stance: "SUPPORTS",
            userId
          }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: versionId, state: "ACTIVE" },
          where: { id: factId }
        });
      });

      const bindingId = await createSucceededBinding(
        userId,
        claim,
        source.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");

      await expect(prisma.memoryFactVersion.findMany({ where: { userId } }))
        .resolves.toMatchObject([{
          id: versionId,
          sourceMode: "EXPLICIT",
          state: "ACTIVE"
        }]);
      await expect(prisma.memoryEvidence.count({ where: { factVersionId: versionId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryEvent.count({
        where: { factVersionId: versionId, operation: "REINFORCE", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([false, true])("converges on an explicit fact without duplicate testimony (repeat=%s)", async (repeat) => {
    const userId = await createOwner("explicit-semantic-duplicate");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Explicit semantic duplicate", userId }
      });
      const quote = "Запомни, что я люблю кофе.";
      const expandedQuote = `${quote} Это моё предпочтение.`;
      const turn = await createTurn({
        assistantText: "Запомнил.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T11:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: repeat ? expandedQuote : quote
      });
      await settleChat(userId, chat.id, turn);
      const explicit = await createExplicitPreferenceFact(
        userId,
        "Я люблю кофе.",
        turn.userMessage.createdAt
      );
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const source = await prepare(claim);
      expect(source.contextRefs.some(({ source }) =>
        source.factVersionId === explicit.versionId)).toBe(true);
      const plan = preferencePlan(
        source,
        quote,
        "Пользователь любит кофе.",
        true,
        "HIGH",
        repeat ? [expandedQuote] : []
      );
      const explicitFact = await prisma.memoryFact.findUniqueOrThrow({
        select: { canonicalKey: true },
        where: { id: explicit.factId }
      });
      expect(plan.candidates[0]?.canonicalKey).not.toBe(explicitFact.canonicalKey);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        source.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(
        userId,
        claim,
        plan,
        bindingId,
        new Date("2026-08-23T11:01:00.000Z"),
        reinforcementPacket(plan, explicit.versionId)
      )).resolves.toBe("APPLIED");

      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.findMany({ where: { userId } }))
        .resolves.toMatchObject([{
          id: explicit.versionId,
          sourceMode: "EXPLICIT",
          state: "ACTIVE"
        }]);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: explicit.versionId, userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { candidateOrdinal: "asc" },
        select: { outcome: true },
        where: { userId }
      })).resolves.toEqual(repeat ? [{ outcome: "REINFORCED" }, { outcome: "REPLAY" }] : [{ outcome: "REINFORCED" }]);
      await expect(prisma.memoryEvent.count({
        where: {
          factVersionId: explicit.versionId,
          operation: "REINFORCE",
          userId
        }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("replays equivalent spans in one message without reinforcing its testimony twice", async () => {
    const userId = await createOwner("same-message-support");
    try {
      const chat = await prisma.chat.create({ data: { title: "Equivalent spans", userId } });
      const firstQuote = "I enjoy white tea.";
      const secondQuote = "I prefer white tea.";
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: `${firstQuote} ${secondQuote}`
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const source = await prepare(claim);
      const plan = preferencePlan(
        source, firstQuote, "The user prefers white tea.", false, "HIGH", [secondQuote]
      );
      expect(plan.candidates).toHaveLength(2);
      expect(plan.candidates[0]!.id).not.toBe(plan.candidates[1]!.id);
      expect(plan.candidates[0]!.canonicalKey).toBe(plan.candidates[1]!.canonicalKey);
      const binding = await createSucceededBinding(userId, claim, source.inputHash, plan.outputHash);
      const before = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
      const evidence = await prisma.memoryEvidence.findMany({ where: { userId } });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        messageId: turn.userMessage.id,
        safeExcerpt: firstQuote,
        sourceMessageContentHash: memorySha256(`${firstQuote} ${secondQuote}`)
      });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryEvent.count({ where: { operation: "REINFORCE", userId } }))
        .resolves.toBe(0);
      const after = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      expect(after.memoryRevision).toBe(before.memoryRevision + 1);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { candidateOrdinal: "asc" },
        select: { outcome: true, resultingEvidenceId: true },
        where: { userId }
      })).resolves.toEqual([
        { outcome: "APPLIED", resultingEvidenceId: evidence[0]!.id },
        { outcome: "REPLAY", resultingEvidenceId: evidence[0]!.id }
      ]);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("converges paraphrased automatic observations across canonical keys", async () => {
    const userId = await createOwner("automatic-semantic-duplicate");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Automatic semantic duplicate", userId }
      });
      const first = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T12:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer coffee."
      });
      await settleChat(userId, chat.id, first);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const firstInput = await prepare(firstClaim);
      const firstPlan = preferencePlan(
        firstInput,
        "I prefer coffee.",
        "The user prefers coffee."
      );
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        firstClaim,
        firstPlan,
        firstBinding,
        new Date("2026-08-23T12:00:30.000Z")
      )).resolves.toBe("APPLIED");
      const firstVersion = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });

      const second = await createTurn({
        assistantText: "Got it.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T12:01:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "Coffee is something I like."
      });
      await settleChat(userId, chat.id, second);
      const secondClaim = await claimFactJob(userId, second.userMessage.id);
      const secondInput = await prepare(secondClaim);
      expect(secondInput.contextRefs.some(({ source }) =>
        source.factVersionId === firstVersion.id)).toBe(true);
      const secondPlan = preferencePlan(
        secondInput,
        "Coffee is something I like.",
        "The user likes coffee."
      );
      expect(secondPlan.candidates[0]?.canonicalKey)
        .not.toBe(firstPlan.candidates[0]?.canonicalKey);
      const secondBinding = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        secondClaim,
        secondPlan,
        secondBinding,
        new Date("2026-08-23T12:01:30.000Z"),
        reinforcementPacket(secondPlan, firstVersion.id)
      )).resolves.toBe("APPLIED");

      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: firstVersion.id, userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { createdAt: "asc" },
        select: { outcome: true },
        where: { userId }
      })).resolves.toEqual([
        { outcome: "APPLIED" },
        { outcome: "REINFORCED" }
      ]);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([false, true])("stages a SLOT value without duplicating pending support (repeat=%s)", async (repeat) => {
    const userId = await createOwner("pending-relation");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Relation staging", userId }
      });
      const ordered = await createTurn({
        assistantText: "Order noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T08:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I borrowed a MacBook Air."
      });
      await settleChat(userId, chat.id, ordered);
      const purchased = await createTurn({
        assistantText: "Purchase noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T08:01:00.000Z"),
        parentMessageId: ordered.assistantMessage.id,
        userId,
        userText: repeat ? "I bought a MacBook Air. I own it." : "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, purchased);
      const orderedClaim = await claimFactJob(userId, ordered.userMessage.id);
      const orderedInput = await prepare(orderedClaim);
      // A passing order is no longer retained; a lasting borrowed state is.
      const orderedPlan = extractionPlan(
        orderedInput,
        "I borrowed a MacBook Air.",
        "The user borrowed a MacBook Air.",
        "borrowed"
      );
      const orderedBinding = await createSucceededBinding(
        userId,
        orderedClaim,
        orderedInput.inputHash,
        orderedPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        orderedClaim,
        orderedPlan,
        orderedBinding
      )).resolves.toBe("APPLIED");
      const orderedVersion = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      expect(orderedVersion).toMatchObject({
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null
      });

      const purchasedClaim = await claimFactJob(userId, purchased.userMessage.id);
      const purchasedInput = await prepare(purchasedClaim);
      expect(purchasedInput.contextRefs.some(({ source }) =>
        source.factVersionId === orderedVersion.id)).toBe(true);
      const purchasedPlan = extractionPlan(
        purchasedInput,
        "I bought a MacBook Air.",
        "The user owns a MacBook Air.",
        "owned",
        undefined,
        undefined,
        repeat ? ["I bought a MacBook Air. I own it."] : []
      );
      const purchasedBinding = await createSucceededBinding(
        userId,
        purchasedClaim,
        purchasedInput.inputHash,
        purchasedPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        purchasedClaim,
        purchasedPlan,
        purchasedBinding
      )).resolves.toBe("APPLIED");

      const fact = await prisma.memoryFact.findFirstOrThrow({ where: { userId } });
      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ systemFrom: "asc" }, { id: "asc" }],
        where: { userId }
      });
      expect(fact).toMatchObject({
        canonicalKey: `slot:v3:entity:${fact.subjectEntityId}:product_status:_`,
        currentVersionId: versions.find(({ state }) => state === "ACTIVE")?.id,
        dimensionKey: null,
        identityKind: "SLOT",
        identityVersion: "slot-v3",
        predicateKey: "product_status"
      });
      expect(versions.map(({ safetyClassificationState, state }) => ({
        safetyClassificationState,
        state
      }))).toEqual([
        { safetyClassificationState: "CLASSIFIED", state: "ACTIVE" },
        { safetyClassificationState: "CLASSIFIED", state: "PENDING_RELATION" }
      ]);
      await expect(prisma.memorySearchEntry.findMany({
        select: { factVersionId: true },
        where: { userId }
      })).resolves.toEqual([{ factVersionId: orderedVersion.id }]);
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: fact.id }
      })).resolves.toMatchObject({
        currentVersionId: orderedVersion.id,
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "PENDING_RELATION", userId }
      })).resolves.toMatchObject({
        contentPurgedAt: null,
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierPolicyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION,
        state: "PENDING_RELATION"
      });
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: fact.currentVersionId!, userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(2);
      await expect(prisma.memoryEvent.count({ where: { operation: "REINFORCE", userId } }))
        .resolves.toBe(0);
      const execution = await prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { id: true },
        where: { memoryJobId: purchasedClaim.id, userId }
      });
      await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { candidateOrdinal: "asc" },
        select: { outcome: true },
        where: { extractionExecutionId: execution.id, userId }
      })).resolves.toEqual(repeat ? [{ outcome: "APPLIED" }, { outcome: "REPLAY" }] : [{ outcome: "APPLIED" }]);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("materializes elapsed explicit TTL before reusing the same identity", async () => {
    const userId = await createOwner("expiration");
    try {
      const temporaryCreatedAt = new Date();
      const localDateFormatter = new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "Europe/Moscow",
        year: "numeric"
      });
      const untilLocalDate = localDateFormatter.format(
        new Date(temporaryCreatedAt.getTime() + 6 * 24 * 60 * 60 * 1_000)
      );
      const expirationBoundaryLocalDate = localDateFormatter.format(
        new Date(temporaryCreatedAt.getTime() + 7 * 24 * 60 * 60 * 1_000)
      );
      const temporaryText =
        `Remember this until ${untilLocalDate}: I bought a MacBook Air.`;
      const chat = await prisma.chat.create({
        data: { title: "Explicit expiration", userId }
      });
      const temporary = await createTurn({
        assistantText: "Temporarily noted.",
        chatId: chat.id,
        createdAt: temporaryCreatedAt,
        parentMessageId: null,
        userId,
        userText: temporaryText
      });
      await settleChat(userId, chat.id, temporary);
      const firstClaim = await claimFactJob(userId, temporary.userMessage.id);
      const firstInput = await prepare(firstClaim);
      const firstPlan = extractionPlan(
        firstInput,
        temporaryText,
        "The user owns a MacBook Air.",
        "owned",
        {
          expiration_intent: "EXPLICIT",
          normalization: {
            kind: "ABSOLUTE",
            local_date: expirationBoundaryLocalDate,
            local_time: null,
            zone: null
          },
          perspective: "CURRENT",
          raw_expression: exactTextRef(`Remember this until ${untilLocalDate}`)
        }
      );
      const expirationAt = new Date(firstPlan.candidates[0]!.expiresAt!);
      const firstApplyAt = new Date(temporaryCreatedAt.getTime() + 60 * 60 * 1_000);
      const permanentCreatedAt = new Date(expirationAt.getTime() + 60 * 60 * 1_000);
      const secondApplyAt = new Date(permanentCreatedAt.getTime() + 60 * 60 * 1_000);
      const leaseExpiresAt = new Date(secondApplyAt.getTime() + 24 * 60 * 60 * 1_000);
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await prisma.memoryJob.update({
        data: { leaseExpiresAt },
        where: { id: firstClaim.id }
      });
      await expect(applyPlan(
        userId,
        firstClaim,
        firstPlan,
        firstBinding,
        firstApplyAt
      )).resolves.toBe("APPLIED");

      const permanent = await createTurn({
        assistantText: "Noted again.",
        chatId: chat.id,
        createdAt: permanentCreatedAt,
        parentMessageId: temporary.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, permanent);
      const secondClaim = await claimFactJob(userId, permanent.userMessage.id);
      const secondInput = await prepare(secondClaim);
      const secondPlan = extractionPlan(
        secondInput,
        "I bought a MacBook Air.",
        "The user owns a MacBook Air."
      );
      const secondBinding = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await prisma.memoryJob.update({
        data: { leaseExpiresAt },
        where: { id: secondClaim.id }
      });
      await expect(applyPlan(
        userId,
        secondClaim,
        secondPlan,
        secondBinding,
        secondApplyAt
      )).resolves.toBe("APPLIED");

      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ systemFrom: "asc" }, { id: "asc" }],
        where: { userId }
      });
      const expired = versions.find(({ state }) => state === "EXPIRED");
      const active = versions.find(({ state }) => state === "ACTIVE");
      expect(expired).toMatchObject({
        expiresAt: expirationAt,
        state: "EXPIRED",
        systemTo: secondApplyAt
      });
      expect(active).toMatchObject({ expiresAt: null, state: "ACTIVE" });
      await expect(prisma.memoryFact.findFirstOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        currentVersionId: active?.id,
        state: "ACTIVE"
      });
      await expect(prisma.memoryEvent.count({
        where: { operation: "EXPIRE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: expired?.id, userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("creates a fresh entity-backed fact instead of resolving a retracted root", async () => {
    const userId = await createOwner("reobserve-retracted");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Fresh evidence after source invalidation", userId }
      });
      const first = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, first);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const firstInput = await prepare(firstClaim);
      const firstPlan = extractionPlan(firstInput, "I bought a MacBook Air.");
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await expect(applyPlan(userId, firstClaim, firstPlan, firstBinding))
        .resolves.toBe("APPLIED");
      const original = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      const originalFact = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: original.factId }
      });
      const invalidatedAt = new Date(original.systemFrom.getTime() + 1);
      await prisma.$transaction(async (tx) => {
        await tx.memoryEvent.create({
          data: {
            actorType: "SYSTEM",
            factId: original.factId,
            factVersionId: original.id,
            operation: "SOURCE_INVALIDATE",
            userId
          }
        });
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED", systemTo: invalidatedAt },
          where: { id: original.id }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: null, state: "RETRACTED" },
          where: { id: original.factId }
        });
        await tx.memoryEvidence.deleteMany({
          where: { factVersionId: original.id, userId }
        });
      });

      const second = await createTurn({
        assistantText: "Noted again from fresh evidence.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T10:02:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, second);
      const secondClaim = await claimFactJob(userId, second.userMessage.id);
      const secondInput = await prepare(secondClaim);
      const secondPlan = extractionPlan(secondInput, "I bought a MacBook Air.");
      const secondBinding = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await expect(applyPlan(userId, secondClaim, secondPlan, secondBinding))
        .resolves.toBe("APPLIED");

      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ systemFrom: "asc" }, { id: "asc" }],
        where: { userId }
      });
      expect(versions).toHaveLength(2);
      expect(versions.find(({ id }) => id === original.id)).toMatchObject({
        state: "RETRACTED",
        systemTo: invalidatedAt
      });
      const current = versions.find(({ id }) => id !== original.id);
      expect(current).toMatchObject({ state: "ACTIVE", systemTo: null });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: original.factId }
      })).resolves.toMatchObject({
        currentVersionId: null,
        state: "RETRACTED",
        subjectEntityId: originalFact.subjectEntityId
      });
      const replacement = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: current!.factId }
      });
      expect(replacement).toMatchObject({
        currentVersionId: current?.id,
        movedToFactId: null,
        state: "ACTIVE"
      });
      expect(replacement.subjectEntityId).not.toBe(originalFact.subjectEntityId);
      await expect(prisma.memoryEntity.findMany({
        orderBy: { createdAt: "asc" },
        select: { id: true, state: true },
        where: { userId }
      })).resolves.toEqual([
        { id: originalFact.subjectEntityId, state: "RETRACTED" },
        { id: replacement.subjectEntityId, state: "ACTIVE" }
      ]);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: current?.id, userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: original.id, userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  /** One applied automatic product fact with its subject entity and search
   * entries, then the state an earlier release could leave behind: the
   * subject root retracted while the fact stayed ACTIVE, fenced from standing
   * context, search and review but never retired. */
  async function factUnderRetractedSubjectRoot(
    userId: string,
    protect: (version: Readonly<{ factId: string; id: string; semanticFrame: Prisma.JsonValue }>) => Promise<void> =
      async () => undefined
  ) {
    const chat = await prisma.chat.create({
      data: { title: "Subject root retraction", userId }
    });
    const first = await createTurn({
      assistantText: "Noted.",
      chatId: chat.id,
      createdAt: new Date("2026-08-24T10:00:00.000Z"),
      parentMessageId: null,
      userId,
      userText: "I bought a MacBook Air."
    });
    await settleChat(userId, chat.id, first);
    const claim = await claimFactJob(userId, first.userMessage.id);
    const input = await prepare(claim);
    const plan = extractionPlan(input, "I bought a MacBook Air.");
    const binding = await createSucceededBinding(userId, claim, input.inputHash, plan.outputHash);
    await expect(applyPlan(userId, claim, plan, binding)).resolves.toBe("APPLIED");
    const version = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
    const { subjectEntityId } = await prisma.memoryFact.findUniqueOrThrow({
      select: { subjectEntityId: true },
      where: { id: version.factId }
    });
    expect(subjectEntityId).toEqual(expect.any(String));
    await expect(loadMemoryReusableFactVersionIds(prisma, userId, [version.id]))
      .resolves.toEqual(new Set([version.id]));
    await protect(version);
    await prisma.memoryEntity.update({
      data: { state: "RETRACTED" },
      where: { id: subjectEntityId! }
    });
    await expect(loadMemoryReusableFactVersionIds(prisma, userId, [version.id]))
      .resolves.toEqual(new Set());
    return { subjectEntityId: subjectEntityId!, version };
  }

  /** One coordinator maintenance pass with quiet evidence, in which only
   * this owner has Memory model authority; whether the owner was offered. */
  async function maintenancePass(userId: string): Promise<boolean> {
    const offered: string[] = [];
    await reconcileMemoryMaintenanceWork(prisma, new Date(Date.now() + 2 * 60 * 60_000), async (candidate) => {
      offered.push(candidate);
      return candidate === userId;
    });
    return offered.includes(userId);
  }

  it.each(["unprotected", "pinned", "owner-touched", "remember-requested"] as const)(
    "retires a fact left under a retracted subject root once, in the owner's first maintenance pass, only when unprotected (%s)",
    async (protection) => {
      const userId = await createOwner(`subject-root-${protection}`);
      try {
        const { subjectEntityId, version } = await factUnderRetractedSubjectRoot(userId, async (current) => {
          if (protection === "pinned") {
            await prisma.memoryFact.update({ data: { pinned: true }, where: { id: current.factId } });
          } else if (protection === "owner-touched") {
            await prisma.memoryEvent.create({
              data: {
                actorType: "USER",
                actorUserId: userId,
                factId: current.factId,
                factVersionId: current.id,
                operation: "UNPIN",
                userId
              }
            });
          } else if (protection === "remember-requested") {
            await prisma.memoryFactVersion.update({
              data: {
                semanticFrame: {
                  ...(current.semanticFrame as Prisma.JsonObject),
                  memoryDirective: "EXPLICIT_REMEMBER"
                }
              },
              where: { id: current.id }
            });
          }
        });
        const searchEntries = () => prisma.memorySearchEntry.count({
          where: { factVersionId: version.id, userId }
        });
        const retirements = () => prisma.memoryEvent.findMany({
          select: { actorType: true, factVersionId: true, metadata: true },
          where: { factId: version.factId, operation: "SOURCE_INVALIDATE", userId }
        });
        const revision = async () => (await prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryRevision: true },
          where: { userId }
        })).memoryRevision;
        expect(await searchEntries()).toBeGreaterThan(0);
        const before = await revision();

        if (protection !== "unprotected") {
          // A protected lineage is no owner work, and its first pass keeps it.
          await expect(maintenancePass(userId)).resolves.toBe(false);
          await expect(scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).resolves.toBe(0);
          await expect(prisma.memoryFact.findUniqueOrThrow({
            select: { currentVersionId: true, pinned: true, state: true },
            where: { id: version.factId }
          })).resolves.toEqual({
            currentVersionId: version.id,
            pinned: protection === "pinned",
            state: "ACTIVE"
          });
          await expect(prisma.memoryFactVersion.findUniqueOrThrow({
            select: { state: true, systemTo: true },
            where: { id: version.id }
          })).resolves.toEqual({ state: "ACTIVE", systemTo: null });
          await expect(retirements()).resolves.toEqual([]);
          expect(await searchEntries()).toBeGreaterThan(0);
          expect(await revision()).toBe(before);
          return;
        }

        // The retirement is this owner's only maintenance work; its first pass
        // under the policy does it without a model call or review row.
        await expect(maintenancePass(userId)).resolves.toBe(true);
        await expect(prisma.memoryFact.findUniqueOrThrow({
          select: { currentVersionId: true, state: true, subjectEntityId: true },
          where: { id: version.factId }
        })).resolves.toEqual({
          currentVersionId: null,
          state: "RETRACTED",
          subjectEntityId
        });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          select: { state: true, systemTo: true },
          where: { id: version.id }
        })).resolves.toEqual({ state: "RETRACTED", systemTo: expect.any(Date) });
        await expect(retirements()).resolves.toEqual([{
          actorType: "SYSTEM",
          factVersionId: version.id,
          metadata: expect.objectContaining({
            outcome: "FACT_RETRACTED",
            reason: "subject_entity_retracted"
          })
        }]);
        await expect(searchEntries()).resolves.toBe(0);
        expect(await revision()).toBe(before + 1);
        await expect(prisma.memoryJob.count({ where: { kind: "SYNTHESIZE_MEMORIES", userId } })).resolves.toBe(0);
        await expect(prisma.memoryMaintenanceReview.count({ where: { userId } })).resolves.toBe(0);

        // Nothing is left to retire: the owner is not offered again and a
        // repeated pass changes nothing.
        await expect(maintenancePass(userId)).resolves.toBe(false);
        await expect(scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).resolves.toBe(0);
        await expect(retirements()).resolves.toHaveLength(1);
        expect(await revision()).toBe(before + 1);

        // Re-observing the product learns it under a fresh entity; neither the
        // retired fact nor its retracted root comes back.
        const laterChat = await prisma.chat.create({
          data: { title: "Later conversation", userId }
        });
        const again = await createTurn({
          assistantText: "Noted again.",
          chatId: laterChat.id,
          createdAt: new Date("2026-08-24T10:07:00.000Z"),
          parentMessageId: null,
          userId,
          userText: "I bought a MacBook Air."
        });
        await settleChat(userId, laterChat.id, again);
        const againClaim = await claimFactJob(userId, again.userMessage.id);
        const againInput = await prepare(againClaim);
        const againPlan = extractionPlan(againInput, "I bought a MacBook Air.");
        const againBinding = await createSucceededBinding(
          userId,
          againClaim,
          againInput.inputHash,
          againPlan.outputHash
        );
        await expect(applyPlan(userId, againClaim, againPlan, againBinding))
          .resolves.toBe("APPLIED");
        const relearned = await prisma.memoryFact.findFirstOrThrow({
          select: { id: true, subjectEntityId: true },
          where: { state: "ACTIVE", userId }
        });
        expect(relearned.id).not.toBe(version.factId);
        expect(relearned.subjectEntityId).not.toBe(subjectEntityId);
        await expect(prisma.memoryEntity.findUniqueOrThrow({
          select: { state: true },
          where: { id: subjectEntityId }
        })).resolves.toEqual({ state: "RETRACTED" });
        await expect(retirements()).resolves.toHaveLength(1);
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it("leaves a fact under a retracted subject root to a later policy once the owner's first pass ran", async () => {
    const userId = await createOwner("subject-root-later-pass");
    try {
      const { version } = await factUnderRetractedSubjectRoot(userId, async (current) => {
        // The owner's first pass under the current policy already recorded a row.
        await prisma.memoryMaintenanceReview.create({
          data: {
            disposition: "UNREVIEWABLE",
            evidenceThrough: new Date(),
            factVersionId: current.id,
            memoryJobId: null,
            policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION,
            reasonCode: "statement_too_long",
            reviewedAt: new Date(),
            sourceSnapshotHash: "a".repeat(64),
            userId
          }
        });
      });
      await expect(scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).resolves.toBe(0);
      await expect(prisma.memoryFact.findUniqueOrThrow({
        select: { currentVersionId: true, state: true },
        where: { id: version.factId }
      })).resolves.toEqual({ currentVersionId: version.id, state: "ACTIVE" });
      await expect(prisma.memoryEvent.count({
        where: { factId: version.factId, operation: "SOURCE_INVALIDATE", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each([true, false].flatMap(supported =>
    [false, true].map(structuralContext => ({ supported, structuralContext }))))(
    "binds a shared-message correction to its adjudicated source member (supported=$supported, structural context=$structuralContext)",
    async ({ supported, structuralContext }) => {
      const userId = await createOwner("shared-message-correction");
      try {
        const chat = await prisma.chat.create({ data: { title: "Two preferences", userId } });
        const initialText = "I prefer cedar layouts.";
        const neighborText = "I prefer maple desks.";
        const first = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
          parentMessageId: null, userId, userText: `${initialText} ${neighborText}`
        });
        await settleChat(userId, chat.id, first);
        const firstClaim = await claimFactJob(userId, first.userMessage.id);
        const firstInput = await prepare(firstClaim);
        const initialCandidates = [
          ...preferencePlan(firstInput, initialText, initialText).candidates,
          ...preferencePlan(firstInput, neighborText, neighborText).candidates
        ];
        const firstPlan: MemoryFactExtractionPlan = {
          candidateOrdinals: [0, 1], candidates: initialCandidates, input: firstInput, rejections: [],
          outputHash: memoryFactExtractionOutputHash(firstInput, initialCandidates, [0, 1], [])
        };
        await applyPlan(userId, firstClaim, firstPlan, await createSucceededBinding(
          userId, firstClaim, firstInput.inputHash, firstPlan.outputHash
        ));
        const original = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { displayText: initialText, state: "ACTIVE", userId }
        });
        const neighbor = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { displayText: neighborText, state: "ACTIVE", userId }
        });
        const replacementText = "The layout preference I mentioned is now birch.";
        const second = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-26T10:01:00.000Z"),
          parentMessageId: first.assistantMessage.id, userId, userText: replacementText
        });
        await settleChat(userId, chat.id, second);
        const claim = await claimFactJob(userId, second.userMessage.id);
        const input = await prepare(claim);
        const context = input.contextRefs.find(({ source }) => source.messageId ===
          (supported ? first.userMessage.id : first.assistantMessage.id))!;
        const target = input.contextRefs.find(({ source }) => source.factVersionId === original.id)!;
        const initialPlan = preferencePlan(input, replacementText, "I now prefer birch layouts.",
          false, "HIGH", [], context.ref);
        const candidates = initialPlan.candidates.map((candidate) => {
          if (!structuralContext) return candidate;
          const withContext = { ...candidate, dependencies: [...candidate.dependencies, {
            dependencyKind: "RELATION_CONTEXT" as const, ref: target.ref, source: target.source
          }] };
          return { ...withContext, id: memoryFactCandidateId(input, withContext) };
        });
        const plan = { ...initialPlan, candidates,
          outputHash: memoryFactExtractionOutputHash(input, candidates, initialPlan.candidateOrdinals, []) };
        const semanticInput = memorySemanticAdjudicationInput(plan)!;
        const decisions: MemorySemanticAdjudication[] = [{
          assertionStatus: "ASSERTED", candidateRef: plan.candidates[0]!.candidateRef,
          confidenceBand: "HIGH", entailment: "ENTAILED", entityRef: null,
          operation: "SUPERSEDE_TARGET", reasonCode: "explicit_preference_correction",
          subjectScope: "CURRENT_USER", targetRef: target.ref, temporalPerspective: "CURRENT"
        }];
        await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        ), new Date(), {
          decisions, inputHash: semanticInput.inputHash,
          outputHash: memorySemanticAdjudicationOutputHash(semanticInput.inputHash, decisions)
        })).resolves.toBe(supported ? "APPLIED" : "EMPTY");
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
          .resolves.toMatchObject({ state: "ACTIVE" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: neighbor.id } }))
          .resolves.toMatchObject({ state: "ACTIVE" });
        if (!supported) {
          await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(2);
          return;
        }
        const pending = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { state: "PENDING_RELATION", userId }
        });
        await expect(prisma.memoryFactVersionSourceDependency.findMany({
          select: { dependencyKind: true, sourceFactVersionId: true, sourceMessageId: true },
          where: { targetFactVersionId: pending.id, userId }
        })).resolves.toEqual(expect.arrayContaining([
          { dependencyKind: "CORRECTION_TARGET", sourceFactVersionId: original.id, sourceMessageId: null },
          { dependencyKind: "RELATION_CONTEXT", sourceFactVersionId: null, sourceMessageId: first.userMessage.id },
          ...(structuralContext ? [{ dependencyKind: "RELATION_CONTEXT", sourceFactVersionId: original.id, sourceMessageId: null }] : [])
        ]));
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
        const relationClaim: MemoryJobClaim = {
          ...claim, id: randomUUID(), kind: "RESOLVE_FACT_RELATIONS",
          memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION, targetFactVersionId: pending.id
        };
        const relations = createPrismaMemoryRelationRepository(prisma);
        const now = new Date();
        const prepared = await relations.prepare(relationClaim, now);
        if (prepared.status !== "READY") throw new Error("memory_shared_message_relation_not_ready");
        const decision = decideMemoryFactRelation(prepared.prepared.snapshot, now);
        expect(decision).toMatchObject({ operation: "MOVE_TO_DISTINCT_FACT", targetVersionId: original.id });
        await prisma.$transaction(tx => relations.apply(tx, relationClaim, {
          decision, executionId: null, expectedSnapshotHash: prepared.prepared.snapshotHash
        }, now));
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
          .resolves.toMatchObject({ state: "SUPERSEDED" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: pending.id } }))
          .resolves.toMatchObject({ state: "ACTIVE" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: neighbor.id } }))
          .resolves.toMatchObject({ state: "ACTIVE" });
        await expect(loadPersonalEligibleFactVersionIds(prisma, userId, [pending.id]))
          .resolves.toEqual(new Set([pending.id]));
        await prisma.message.update({
          data: { updatedAt: new Date(first.userMessage.updatedAt.getTime() + 1_000) },
          where: { id: first.userMessage.id }
        });
        await expect(loadPersonalEligibleFactVersionIds(prisma, userId, [pending.id]))
          .resolves.toEqual(new Set());
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it.each([false, true].flatMap(withdrawalFirst =>
    ["same-target", "different-target", "replacement-rejected"].map(mode => ({ mode, withdrawalFirst }))))(
    "keeps a same-packet replacement and withdrawal target-scoped ($mode, withdrawal first=$withdrawalFirst)",
    async ({ mode, withdrawalFirst }) => {
      const userId = await createOwner("replacement-with-withdrawal");
      try {
        const chat = await prisma.chat.create({ data: { title: "Preference revision", userId } });
        const initialText = "I prefer cedar layouts.";
        const neighborText = "I prefer maple desks.";
        const first = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
          parentMessageId: null, userId, userText: `${initialText} ${neighborText}`
        });
        await settleChat(userId, chat.id, first);
        const firstClaim = await claimFactJob(userId, first.userMessage.id);
        const firstInput = await prepare(firstClaim);
        const initialCandidates = [
          ...preferencePlan(firstInput, initialText, initialText).candidates,
          ...preferencePlan(firstInput, neighborText, neighborText).candidates
        ];
        const firstPlan: MemoryFactExtractionPlan = {
          candidateOrdinals: [0, 1], candidates: initialCandidates, input: firstInput, rejections: [],
          outputHash: memoryFactExtractionOutputHash(firstInput, initialCandidates, [0, 1], [])
        };
        await applyPlan(userId, firstClaim, firstPlan, await createSucceededBinding(
          userId, firstClaim, firstInput.inputHash, firstPlan.outputHash
        ));
        const original = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { displayText: initialText, state: "ACTIVE", userId }
        });
        const neighbor = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { displayText: neighborText, state: "ACTIVE", userId }
        });
        const replacementText = "I now prefer birch layouts.";
        const withdrawalText = mode === "different-target"
          ? "I no longer prefer maple desks." : "I no longer prefer cedar layouts.";
        const second = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-08-26T10:01:00.000Z"),
          parentMessageId: first.assistantMessage.id, userId,
          userText: `${replacementText} ${withdrawalText}`
        });
        await settleChat(userId, chat.id, second);
        const claim = await claimFactJob(userId, second.userMessage.id);
        const input = await prepare(claim);
        const replacement = preferencePlan(input, replacementText, replacementText,
          false, "HIGH", [], null, "AFFIRMED", "STATE_CHANGE").candidates[0]!;
        const withdrawal = pureWithdrawalPlan(input, withdrawalText, "PROPOSITION",
          "CURRENT", withdrawalText).candidates[0]!;
        const candidates = withdrawalFirst ? [withdrawal, replacement] : [replacement, withdrawal];
        const plan: MemoryFactExtractionPlan = {
          candidateOrdinals: [0, 1], candidates, input, rejections: [],
          outputHash: memoryFactExtractionOutputHash(input, candidates, [0, 1], [])
        };
        const semanticInput = memorySemanticAdjudicationInput(plan)!;
        const target = input.contextRefs.find(({ source }) => source.factVersionId === original.id)!;
        const withdrawalTarget = mode === "different-target"
          ? input.contextRefs.find(({ source }) => source.factVersionId === neighbor.id)!
          : target;
        const decisions: MemorySemanticAdjudication[] = candidates.map(candidate => ({
          assertionStatus: "ASSERTED", candidateRef: candidate.candidateRef,
          confidenceBand: "HIGH", entailment: "ENTAILED", entityRef: null,
          operation: candidate === withdrawal ? "RETRACT_TARGET"
            : mode === "replacement-rejected" ? "AMBIGUOUS" : "SUPERSEDE_TARGET",
          reasonCode: "direct_current_revision", subjectScope: "CURRENT_USER",
          targetRef: candidate === withdrawal ? withdrawalTarget.ref
            : mode === "replacement-rejected" ? null : target.ref,
          temporalPerspective: "CURRENT"
        }));
        await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        ), new Date(), {
          decisions, inputHash: semanticInput.inputHash,
          outputHash: memorySemanticAdjudicationOutputHash(semanticInput.inputHash, decisions)
        })).resolves.toBe("APPLIED");
        if (mode === "replacement-rejected") {
          await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
            .resolves.toMatchObject({ state: "RETRACTED" });
          await expect(prisma.memoryFactVersion.count({ where: { state: "PENDING_RELATION", userId } }))
            .resolves.toBe(0);
          await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: neighbor.id } }))
            .resolves.toMatchObject({ state: "ACTIVE" });
          return;
        }
        // A separate withdrawal must not destroy the still-current comparison
        // target before the accepted replacement can complete its transition.
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
          .resolves.toMatchObject({ state: "ACTIVE", systemTo: null });
        const pending = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { state: "PENDING_RELATION", userId }
        });
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
        const relationClaim: MemoryJobClaim = {
          ...claim, id: randomUUID(), kind: "RESOLVE_FACT_RELATIONS",
          memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION, targetFactVersionId: pending.id
        };
        const relations = createPrismaMemoryRelationRepository(prisma);
        const now = new Date();
        const prepared = await relations.prepare(relationClaim, now);
        if (prepared.status !== "READY") throw new Error("memory_replacement_relation_not_ready");
        const decision = decideMemoryFactRelation(prepared.prepared.snapshot, now);
        expect(decision).toMatchObject({ operation: "MOVE_TO_DISTINCT_FACT", targetVersionId: original.id });
        await prisma.$transaction(tx => relations.apply(tx, relationClaim, {
          decision, executionId: null, expectedSnapshotHash: prepared.prepared.snapshotHash
        }, now));
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
          .resolves.toMatchObject({ state: "SUPERSEDED" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: pending.id } }))
          .resolves.toMatchObject({ state: "ACTIVE", displayText: replacementText });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: neighbor.id } }))
          .resolves.toMatchObject({ state: mode === "different-target" ? "RETRACTED" : "ACTIVE" });
        await expect(prisma.memoryFactVersion.count({ where: { state: "ACTIVE", userId } }))
          .resolves.toBe(mode === "different-target" ? 1 : 2);
        const execution = await prisma.memoryFactExtractionExecution.findFirstOrThrow({
          select: { id: true }, where: { memoryJobId: claim.id, userId }
        });
        await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
          select: { outcome: true, reasonCode: true },
          where: { userId, candidateOrdinal: withdrawalFirst ? 0 : 1,
            extractionExecutionId: execution.id }
        })).resolves.toEqual([mode === "different-target"
          ? { outcome: "SUPERSEDED", reasonCode: null }
          : { outcome: "REJECTED", reasonCode: "withdrawal_replaced_in_packet" }]);
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it.each(["PROPOSITION", "SLOT"] as const)(
    "withdraws one exact current %s without creating a negative version",
    async (identityKind) => {
      const userId = await createOwner(`pure-withdrawal-${identityKind.toLowerCase()}`);
      try {
        const chat = await prisma.chat.create({
          data: { title: "Pure withdrawal", userId }
        });
        const initialText = "I prefer cedar layouts.";
        const first = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
          parentMessageId: null,
          userId,
          userText: initialText
        });
        await settleChat(userId, chat.id, first);
        const firstClaim = await claimFactJob(userId, first.userMessage.id);
        const firstInput = await prepare(firstClaim);
        const firstPlan = identityKind === "PROPOSITION"
          ? preferencePlan(firstInput, initialText, "The user prefers cedar layouts.")
          : slotPreferencePlan(firstInput, initialText, "format:layouts", {
              value: "cedar"
            });
        const firstBinding = await createSucceededBinding(
          userId,
          firstClaim,
          firstInput.inputHash,
          firstPlan.outputHash
        );
        await expect(applyPlan(
          userId,
          firstClaim,
          firstPlan,
          firstBinding,
          new Date("2026-08-26T10:00:30.000Z")
        )).resolves.toBe("APPLIED");
        const original = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { userId }
        });

        const neighborText = identityKind === "PROPOSITION"
          ? "I prefer birch desks."
          : "My stable interaction preference for verbosity is concise.";
        const neighbor = await createTurn({
          assistantText: "Also noted.",
          chatId: chat.id,
          createdAt: new Date("2026-08-26T10:01:00.000Z"),
          parentMessageId: first.assistantMessage.id,
          userId,
          userText: neighborText
        });
        await settleChat(userId, chat.id, neighbor);
        const neighborClaim = await claimFactJob(userId, neighbor.userMessage.id);
        const neighborInput = await prepare(neighborClaim);
        const neighborPlan = identityKind === "PROPOSITION"
          ? preferencePlan(neighborInput, neighborText, "The user prefers birch desks.")
          : slotPreferencePlan(neighborInput, neighborText, "interaction:verbosity", {
              value: "concise"
            });
        await expect(applyPlan(
          userId,
          neighborClaim,
          neighborPlan,
          await createSucceededBinding(
            userId,
            neighborClaim,
            neighborInput.inputHash,
            neighborPlan.outputHash
          ),
          new Date("2026-08-26T10:01:30.000Z")
        )).resolves.toBe("APPLIED");
        const neighborVersion = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { id: { not: original.id }, state: "ACTIVE", userId }
        });

        const withdrawalText = "I withdraw my cedar layout preference.";
        const withdrawal = await createTurn({
          assistantText: "Understood.",
          chatId: chat.id,
          createdAt: new Date("2026-08-26T10:02:00.000Z"),
          parentMessageId: neighbor.assistantMessage.id,
          userId,
          userText: withdrawalText
        });
        await settleChat(userId, chat.id, withdrawal);
        const withdrawalClaim = await claimFactJob(userId, withdrawal.userMessage.id);
        const withdrawalInput = await prepare(withdrawalClaim);
        const withdrawalPlan = pureWithdrawalPlan(
          withdrawalInput,
          withdrawalText,
          identityKind
        );
        expect(withdrawalPlan.candidates).toHaveLength(1);
        const withdrawalBinding = await createSucceededBinding(
          userId,
          withdrawalClaim,
          withdrawalInput.inputHash,
          withdrawalPlan.outputHash
        );
        const withdrawalApplyResult = await applyPlan(
          userId,
          withdrawalClaim,
          withdrawalPlan,
          withdrawalBinding,
          new Date("2026-08-26T10:02:30.000Z"),
          withdrawalPacket(withdrawalPlan, original.id)
        );
        expect(withdrawalApplyResult).toBe("APPLIED");

        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: original.id }
        })).resolves.toMatchObject({
          state: "RETRACTED",
          systemTo: new Date("2026-08-26T10:02:30.000Z")
        });
        await expect(prisma.memoryFact.findUniqueOrThrow({
          where: { id: original.factId }
        })).resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: neighborVersion.id }
        })).resolves.toMatchObject({ state: "ACTIVE", systemTo: null });
        const originalEvidence = await prisma.memoryEvidence.findMany({
          orderBy: { observedAt: "asc" },
          select: {
            id: true,
            memoryEventId: true,
            messageId: true,
            safeExcerpt: true,
            stance: true
          },
          where: { factVersionId: original.id, userId }
        });
        expect(originalEvidence).toEqual([
          expect.objectContaining({ stance: "SUPPORTS" }),
          expect.objectContaining({
            memoryEventId: null,
            messageId: withdrawal.userMessage.id,
            safeExcerpt: withdrawalText,
            stance: "CONTRADICTS"
          })
        ]);
        const retractionEvent = await prisma.memoryEvent.findFirstOrThrow({
          select: { metadata: true },
          where: { factVersionId: original.id, operation: "RETRACT", userId }
        });
        expect(retractionEvent.metadata).toMatchObject({
          relatedEvidenceId: originalEvidence[1]!.id
        });
        await expect(prisma.memorySearchEntry.count({
          where: { factVersionId: original.id, userId }
        })).resolves.toBe(0);
        await expect(loadPersonalEligibleFactVersionIds(
          prisma,
          userId,
          [neighborVersion.id]
        )).resolves.toEqual(new Set([neighborVersion.id]));
        const withdrawalExecution = await prisma.memoryFactExtractionExecution
          .findFirstOrThrow({
            select: { id: true },
            where: { memoryJobId: withdrawalClaim.id, userId }
          });
        await expect(prisma.memoryFactExtractionCandidateReceipt.findFirstOrThrow({
          select: { outcome: true, reasonCode: true },
          where: { extractionExecutionId: withdrawalExecution.id, userId }
        })).resolves.toEqual({ outcome: "SUPERSEDED", reasonCode: null });
        await expect(prisma.memoryFactVersion.count({
          where: { factId: original.factId, userId }
        })).resolves.toBe(1);

        const replay = await withLockedMemoryTransaction(
          prisma,
          userId,
          (tx, settings) => commitMemoryVNextExtractionPlan(
            tx,
            settings,
            firstClaim,
            firstPlan,
            firstBinding,
            new Date("2026-08-26T10:03:00.000Z"),
            null
          )
        );
        expect(replay).toMatchObject({
          attachedEvidence: 0,
          createdVersions: 0,
          receiptOutcome: "REPLAY"
        });
        await expect(prisma.memoryFact.findUniqueOrThrow({
          where: { id: original.factId }
        })).resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
        const replayContexts = await prisma.$transaction((tx) => loadMemoryFactContextRefs(tx, {
          factVersionIds: [original.id, neighborVersion.id], messages: [], userId
        }));
        expect(replayContexts.map(({ source }) => source.factVersionId))
          .toEqual([neighborVersion.id]);

        const fresh = await createTurn({
          assistantText: "Noted as fresh testimony.",
          chatId: chat.id,
          createdAt: new Date("2026-08-26T10:04:00.000Z"),
          parentMessageId: withdrawal.assistantMessage.id,
          userId,
          userText: initialText
        });
        await settleChat(userId, chat.id, fresh);
        const freshClaim = await claimFactJob(userId, fresh.userMessage.id);
        const freshInput = await prepare(freshClaim);
        const freshPlan = identityKind === "PROPOSITION"
          ? preferencePlan(freshInput, initialText, "The user prefers cedar layouts.")
          : slotPreferencePlan(freshInput, initialText, "format:layouts", {
              value: "cedar"
            });
        await expect(applyPlan(
          userId,
          freshClaim,
          freshPlan,
          await createSucceededBinding(
            userId,
            freshClaim,
            freshInput.inputHash,
            freshPlan.outputHash
          ),
          new Date("2026-08-26T10:04:30.000Z")
        )).resolves.toBe("APPLIED");
        const refreshed = await prisma.memoryFact.findUniqueOrThrow({
          where: { id: original.factId }
        });
        expect(refreshed).toMatchObject({ state: "ACTIVE" });
        expect(refreshed.currentVersionId).not.toBe(original.id);
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          where: { id: original.id }
        })).resolves.toMatchObject({ state: "RETRACTED" });
        await expect(prisma.memoryFactVersion.count({
          where: { factId: original.factId, userId }
        })).resolves.toBe(2);
      } finally {
        await cleanupOwner(userId);
      }
    }
  );

  it("converges concurrent same-value observations to one version and two supports", async () => {
    const userId = await createOwner("concurrent-reinforcement");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Concurrent reinforcement", userId }
      });
      const first = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T17:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, first);
      const second = await createTurn({
        assistantText: "Confirmed.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T17:01:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, second);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const secondClaim = await claimFactJob(userId, second.userMessage.id);
      const [firstInput, secondInput] = await Promise.all([
        prepare(firstClaim),
        prepare(secondClaim)
      ]);
      const firstPlan = extractionPlan(firstInput, "I bought a MacBook Air.");
      const secondPlan = extractionPlan(secondInput, "I bought a MacBook Air.");
      const [firstBinding, secondBinding] = await Promise.all([
        createSucceededBinding(
          userId,
          firstClaim,
          firstInput.inputHash,
          firstPlan.outputHash
        ),
        createSucceededBinding(
          userId,
          secondClaim,
          secondInput.inputHash,
          secondPlan.outputHash
        )
      ]);

      await expect(Promise.all([
        applyPlan(userId, firstClaim, firstPlan, firstBinding),
        applyPlan(userId, secondClaim, secondPlan, secondBinding)
      ])).resolves.toEqual(["APPLIED", "APPLIED"]);

      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryEvent.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });
  describe("[LTO] long-term change-only commit", () => {
    const changeOnlyPlan = (
      input: MemoryFactExtractionInput,
      quote: string,
      statement: string,
      usefulness: "DURABLE" | "COMMON" = "COMMON"
    ) => preferencePlan(
      input, quote, statement, false, "HIGH", [], null, "AFFIRMED", "STATE_CHANGE", usefulness
    );

    async function observedTurn(
      userId: string,
      chatId: string,
      text: string,
      createdAt: Date,
      parentMessageId: string | null = null
    ) {
      const turn = await createTurn({
        assistantText: "Noted.", chatId, createdAt, parentMessageId, userId, userText: text
      });
      await settleChat(userId, chatId, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      return { claim, input: await prepare(claim), turn };
    }

    /** The adjudicator found no existing fact for any candidate. */
    function noRelationPacket(plan: MemoryFactExtractionPlan): MemorySemanticAdjudicationPacket {
      const input = memorySemanticAdjudicationInput(plan);
      if (!input) throw new Error("memory_change_only_test_adjudication_missing");
      const decisions: MemorySemanticAdjudication[] = plan.candidates
        .filter((candidate) => memoryCandidateRequiresSemanticAdjudication(
          candidate, plan.input.contextRefs
        ))
        .map((candidate) => ({
          assertionStatus: "ASSERTED", candidateRef: candidate.candidateRef,
          confidenceBand: "HIGH", entailment: "ENTAILED", entityRef: null,
          operation: "NO_RELATION", reasonCode: "no_prior_fact",
          subjectIdentity: "UNRESOLVED", subjectScope: "CURRENT_USER", targetRef: null,
          temporalPerspective: candidate.semanticFrame.temporalPerspective
        }));
      return {
        decisions, inputHash: input.inputHash,
        outputHash: memorySemanticAdjudicationOutputHash(input.inputHash, decisions)
      };
    }

    async function applyWithoutTarget(
      userId: string,
      observed: Awaited<ReturnType<typeof observedTurn>>,
      plan: MemoryFactExtractionPlan
    ) {
      return applyPlan(userId, observed.claim, plan, await createSucceededBinding(
        userId, observed.claim, observed.input.inputHash, plan.outputHash
      ), new Date(), noRelationPacket(plan));
    }

    async function receipts(userId: string, jobId: string) {
      const execution = await prisma.memoryFactExtractionExecution.findFirstOrThrow({
        select: { id: true }, where: { memoryJobId: jobId, userId }
      });
      return prisma.memoryFactExtractionCandidateReceipt.findMany({
        orderBy: { candidateOrdinal: "asc" },
        select: { outcome: true, reasonCode: true },
        where: { extractionExecutionId: execution.id, userId }
      });
    }

    const missingTarget = [{ outcome: "REJECTED", reasonCode: "change_target_missing" }];

    it("creates no first fact from a change-only candidate but keeps a lasting change", async () => {
      const userId = await createOwner("change-only-first");
      try {
        const chat = await prisma.chat.create({ data: { title: "Change only", userId } });
        const bread = await observedTurn(
          userId, chat.id, "Я начал есть хлеб.", new Date("2026-08-25T09:00:00.000Z")
        );
        const breadPlan = changeOnlyPlan(bread.input, "Я начал есть хлеб.", "Пользователь начал есть хлеб.");
        expect(breadPlan.candidates[0]).toMatchObject({ changeOnly: "COMMON" });
        expect(breadPlan.candidates[0]).not.toHaveProperty("usefulness");
        await expect(applyWithoutTarget(userId, bread, breadPlan)).resolves.toBe("EMPTY");
        await expect(receipts(userId, bread.claim.id)).resolves.toEqual(missingTarget);
        await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);

        const returned = await observedTurn(
          userId, chat.id, "I returned the MacBook Air.", new Date("2026-08-25T09:01:00.000Z"),
          bread.turn.assistantMessage.id
        );
        const returnedPlan = extractionPlan(
          returned.input, "I returned the MacBook Air.", "The user returned the MacBook Air.", "returned"
        );
        expect(returnedPlan.candidates[0]).toMatchObject({
          changeOnly: "TERMINAL_PRODUCT_STATUS", usefulness: "DURABLE"
        });
        await expect(applyWithoutTarget(userId, returned, returnedPlan)).resolves.toBe("EMPTY");
        await expect(receipts(userId, returned.claim.id)).resolves.toEqual(missingTarget);
        await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
        await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(0);

        const moved = await observedTurn(
          userId, chat.id, "I moved to Berlin.", new Date("2026-08-25T09:02:00.000Z"),
          returned.turn.assistantMessage.id
        );
        const movedPlan = changeOnlyPlan(moved.input, "I moved to Berlin.", "The user lives in Berlin.", "DURABLE");
        expect(movedPlan.candidates[0]).not.toHaveProperty("changeOnly");
        await expect(applyWithoutTarget(userId, moved, movedPlan)).resolves.toBe("APPLIED");
        await expect(prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } }))
          .resolves.toMatchObject({ state: "ACTIVE", usefulness: "DURABLE" });
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("never relearns a forgotten identity from a change-only candidate", async () => {
      const fixture = await seedAutomaticallyPurgedFact("change-only");
      try {
        const observed = await observedTurn(
          fixture.userId, fixture.chat.id, fixture.text,
          new Date(fixture.forgottenAt.getTime() + 60_000),
          fixture.turn.assistantMessage.id
        );
        const plan = changeOnlyPlan(observed.input, fixture.text, fixture.text);
        const forgotten = await prisma.memoryFact.findUniqueOrThrow({
          where: { userId_id: { id: fixture.factId, userId: fixture.userId } }
        });
        expect(plan.candidates[0]?.canonicalKey).toBe(forgotten.canonicalKey);
        const versionsBefore = await prisma.memoryFactVersion.count({ where: { userId: fixture.userId } });
        await expect(applyWithoutTarget(fixture.userId, observed, plan)).resolves.toBe("EMPTY");
        await expect(receipts(fixture.userId, observed.claim.id)).resolves.toEqual(missingTarget);
        await expect(prisma.memoryFactVersion.count({ where: { userId: fixture.userId } }))
          .resolves.toBe(versionsBefore);
        await expect(prisma.memoryFact.findUniqueOrThrow({
          where: { userId_id: { id: fixture.factId, userId: fixture.userId } }
        })).resolves.toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
      } finally {
        await cleanupOwner(fixture.userId);
      }
    });

    it("never reopens a retracted identity from a change-only candidate", async () => {
      const userId = await createOwner("change-only-retracted");
      try {
        const chat = await prisma.chat.create({ data: { title: "Change only retracted", userId } });
        const text = "I prefer quiet rooms.";
        const first = await observedTurn(userId, chat.id, text, new Date("2026-08-25T10:00:00.000Z"));
        const firstPlan = preferencePlan(first.input, text, text);
        await expect(applyPlan(userId, first.claim, firstPlan, await createSucceededBinding(
          userId, first.claim, first.input.inputHash, firstPlan.outputHash
        ))).resolves.toBe("APPLIED");
        const original = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
        await prisma.$transaction(async (tx) => {
          await tx.memoryFactVersion.update({
            data: { state: "RETRACTED", systemTo: new Date() }, where: { id: original.id }
          });
          await tx.memoryFact.update({
            data: { currentVersionId: null, state: "RETRACTED" }, where: { id: original.factId }
          });
        });
        const second = await observedTurn(
          userId, chat.id, text, new Date("2026-08-25T10:05:00.000Z"),
          first.turn.assistantMessage.id
        );
        const plan = changeOnlyPlan(second.input, text, text);
        expect(plan.candidates[0]?.canonicalKey).toBe(firstPlan.candidates[0]?.canonicalKey);
        await expect(applyWithoutTarget(userId, second, plan)).resolves.toBe("EMPTY");
        await expect(receipts(userId, second.claim.id)).resolves.toEqual(missingTarget);
        await expect(prisma.memoryFactVersion.findMany({
          select: { id: true, state: true }, where: { userId }
        })).resolves.toEqual([{ id: original.id, state: "RETRACTED" }]);
        await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: original.factId } }))
          .resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("never reopens an expired identity from a terminal product status", async () => {
      const userId = await createOwner("change-only-expired");
      try {
        const createdAt = new Date();
        const localDate = new Intl.DateTimeFormat("en-CA", {
          day: "2-digit", month: "2-digit", timeZone: "Europe/Moscow", year: "numeric"
        });
        const untilLocalDate = localDate.format(new Date(createdAt.getTime() + 6 * 86_400_000));
        const boundaryLocalDate = localDate.format(new Date(createdAt.getTime() + 7 * 86_400_000));
        const text = `Remember this until ${untilLocalDate}: I bought a MacBook Air.`;
        const chat = await prisma.chat.create({ data: { title: "Change only expired", userId } });
        const first = await observedTurn(userId, chat.id, text, createdAt);
        const firstPlan = extractionPlan(first.input, text, "The user owns a MacBook Air.", "owned", {
          expiration_intent: "EXPLICIT",
          normalization: {
            kind: "ABSOLUTE", local_date: boundaryLocalDate, local_time: null, zone: null
          },
          perspective: "CURRENT",
          raw_expression: exactTextRef(`Remember this until ${untilLocalDate}`)
        });
        const expiresAt = new Date(firstPlan.candidates[0]!.expiresAt!);
        const secondCreatedAt = new Date(expiresAt.getTime() + 60 * 60_000);
        const secondApplyAt = new Date(secondCreatedAt.getTime() + 60 * 60_000);
        const leaseExpiresAt = new Date(secondApplyAt.getTime() + 86_400_000);
        await prisma.memoryJob.update({ data: { leaseExpiresAt }, where: { id: first.claim.id } });
        await expect(applyPlan(userId, first.claim, firstPlan, await createSucceededBinding(
          userId, first.claim, first.input.inputHash, firstPlan.outputHash
        ), new Date(createdAt.getTime() + 60 * 60_000))).resolves.toBe("APPLIED");
        const original = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
        const second = await observedTurn(
          userId, chat.id, "I returned the MacBook Air.", secondCreatedAt,
          first.turn.assistantMessage.id
        );
        await prisma.memoryJob.update({ data: { leaseExpiresAt }, where: { id: second.claim.id } });
        const plan = extractionPlan(
          second.input, "I returned the MacBook Air.", "The user returned the MacBook Air.", "returned"
        );
        expect(plan.candidates[0]?.canonicalKey).toBe(firstPlan.candidates[0]?.canonicalKey);
        await expect(applyPlan(userId, second.claim, plan, await createSucceededBinding(
          userId, second.claim, second.input.inputHash, plan.outputHash
        ), secondApplyAt, noRelationPacket(plan))).resolves.toBe("EMPTY");
        await expect(receipts(userId, second.claim.id)).resolves.toEqual(missingTarget);
        // Materializing the elapsed TTL is rolled back with the rejected candidate.
        await expect(prisma.memoryFactVersion.findMany({
          select: { id: true, state: true }, where: { userId }
        })).resolves.toEqual([{ id: original.id, state: "ACTIVE" }]);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("changes an existing automatic fact through the relation path", async () => {
      const userId = await createOwner("change-only-update");
      try {
        const chat = await prisma.chat.create({ data: { title: "Gluten", userId } });
        const restriction = "I do not eat gluten.";
        const first = await observedTurn(userId, chat.id, restriction, new Date("2026-08-25T11:00:00.000Z"));
        const firstPlan = preferencePlan(first.input, restriction, "The user does not eat gluten.");
        await expect(applyPlan(userId, first.claim, firstPlan, await createSucceededBinding(
          userId, first.claim, first.input.inputHash, firstPlan.outputHash
        ))).resolves.toBe("APPLIED");
        const original = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
        const change = "After years without gluten I eat gluten bread again now.";
        const second = await observedTurn(
          userId, chat.id, change, new Date("2026-08-25T11:01:00.000Z"), first.turn.assistantMessage.id
        );
        const target = second.input.contextRefs.find(({ source }) =>
          source.factVersionId === original.id);
        if (!target) throw new Error("memory_change_only_test_target_missing");
        const plan = changeOnlyPlan(second.input, change, "The user eats gluten again.");
        expect(plan.candidates[0]).toMatchObject({ changeOnly: "COMMON" });
        const semanticInput = memorySemanticAdjudicationInput(plan);
        if (!semanticInput) throw new Error("memory_change_only_test_adjudication_missing");
        const decisions: MemorySemanticAdjudication[] = [{
          assertionStatus: "ASSERTED", candidateRef: plan.candidates[0]!.candidateRef,
          confidenceBand: "HIGH", entailment: "ENTAILED", entityRef: null,
          operation: "SUPERSEDE_TARGET", reasonCode: "restriction_cancelled",
          subjectScope: "CURRENT_USER", targetRef: target.ref, temporalPerspective: "CURRENT"
        }];
        await expect(applyPlan(userId, second.claim, plan, await createSucceededBinding(
          userId, second.claim, second.input.inputHash, plan.outputHash
        ), new Date(), {
          decisions, inputHash: semanticInput.inputHash,
          outputHash: memorySemanticAdjudicationOutputHash(semanticInput.inputHash, decisions)
        })).resolves.toBe("APPLIED");
        await expect(receipts(userId, second.claim.id)).resolves.toEqual([
          { outcome: "APPLIED", reasonCode: null }
        ]);
        const pending = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { state: "PENDING_RELATION", userId }
        });
        // A rejected class is never persisted as the new version's usefulness.
        expect(pending.usefulness).toBeNull();
        const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
        const relationClaim: MemoryJobClaim = {
          ...second.claim, id: randomUUID(), kind: "RESOLVE_FACT_RELATIONS",
          memoryGenerationSnapshot: settings.memoryGeneration,
          memoryRevisionSnapshot: settings.memoryRevision,
          pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION, targetFactVersionId: pending.id
        };
        const relations = createPrismaMemoryRelationRepository(prisma);
        const now = new Date();
        const prepared = await relations.prepare(relationClaim, now);
        if (prepared.status !== "READY") throw new Error("memory_change_only_test_relation_not_ready");
        const decision = decideMemoryFactRelation(prepared.prepared.snapshot, now);
        expect(decision.targetVersionId).toBe(original.id);
        await prisma.$transaction((tx) => relations.apply(tx, relationClaim, {
          decision, executionId: null, expectedSnapshotHash: prepared.prepared.snapshotHash
        }, now));
        const active = await prisma.memoryFactVersion.findMany({ where: { state: "ACTIVE", userId } });
        expect(active.map(({ id }) => id)).toEqual([pending.id]);
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: original.id } }))
          .resolves.toMatchObject({ state: "SUPERSEDED" });
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("changes an existing product fact with a terminal status", async () => {
      const userId = await createOwner("change-only-product");
      try {
        const chat = await prisma.chat.create({ data: { title: "Product status", userId } });
        const first = await observedTurn(userId, chat.id, "I bought a MacBook Air.", new Date("2026-08-25T12:00:00.000Z"));
        const firstPlan = extractionPlan(first.input, "I bought a MacBook Air.");
        await expect(applyPlan(userId, first.claim, firstPlan, await createSucceededBinding(
          userId, first.claim, first.input.inputHash, firstPlan.outputHash
        ))).resolves.toBe("APPLIED");
        const owned = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });
        const second = await observedTurn(
          userId, chat.id, "I returned the MacBook Air.", new Date("2026-08-25T12:01:00.000Z"),
          first.turn.assistantMessage.id
        );
        const plan = extractionPlan(
          second.input, "I returned the MacBook Air.", "The user returned the MacBook Air.", "returned"
        );
        expect(plan.candidates[0]?.changeOnly).toBe("TERMINAL_PRODUCT_STATUS");
        await expect(applyPlan(userId, second.claim, plan, await createSucceededBinding(
          userId, second.claim, second.input.inputHash, plan.outputHash
        ))).resolves.toBe("APPLIED");
        await expect(receipts(userId, second.claim.id)).resolves.toEqual([
          { outcome: "APPLIED", reasonCode: null }
        ]);
        const pending = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { state: "PENDING_RELATION", userId }
        });
        expect(pending).toMatchObject({ factId: owned.factId, usefulness: "DURABLE" });
        expect(pending.structuredValue).toMatchObject({ state: "returned" });

        // The coordinator's relation reconciliation queues the resolution job;
        // the ordinary relation handler then replaces the owned state.
        await reconcileMemoryFactRelationJobs(prisma);
        const queued = await prisma.memoryJob.findFirstOrThrow({
          where: { kind: "RESOLVE_FACT_RELATIONS", state: "QUEUED", targetFactVersionId: pending.id, userId }
        });
        const claimToken = randomUUID();
        const leaseExpiresAt = new Date(Date.now() + 120_000);
        const claimed = await prisma.memoryJob.update({
          data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, state: "CLAIMED" },
          where: { id: queued.id }
        });
        const relationClaim: MemoryJobClaim = {
          activeLeafMessageId: claimed.activeLeafMessageId, attemptCount: claimed.attemptCount,
          branchGeneration: claimed.branchGeneration, chatId: claimed.chatId, claimToken,
          id: claimed.id, idempotencyFingerprint: claimed.idempotencyFingerprint, kind: claimed.kind,
          leaseExpiresAt, memoryGenerationSnapshot: claimed.memoryGenerationSnapshot,
          memoryRevisionSnapshot: claimed.memoryRevisionSnapshot,
          pipelineVersion: claimed.pipelineVersion, recoveredLease: false,
          sourceHash: claimed.sourceHash, sourceMessageId: claimed.sourceMessageId,
          sourceRevision: claimed.sourceRevision, stage: claimed.stage,
          targetFactVersionId: claimed.targetFactVersionId, userId: claimed.userId
        };
        const handler = createPrismaMemoryRelationHandler(prisma);
        await expect(handler.preflight(relationClaim)).resolves.toMatchObject({ status: "READY" });
        const result = await handler.execute(relationClaim, {
          now: () => new Date(), setStage: async () => undefined, signal: new AbortController().signal
        });
        await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
          acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim: relationClaim,
          now: new Date(), stage: result.stage ?? null
        })).resolves.toBe(true);
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: pending.id } }))
          .resolves.toMatchObject({ state: "ACTIVE" });
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: owned.id } }))
          .resolves.toMatchObject({ state: "SUPERSEDED" });
      } finally {
        await cleanupOwner(userId);
      }
    });
  });

  describe("[L10] paged fact extraction", () => {
    const filler = "These notes describe ordinary background context. ";

    function placedText(
      parts: ReadonlyArray<readonly [offset: number, sentence: string]>,
      length: number
    ): string {
      let text = "";
      for (const [offset, sentence] of parts) {
        while (text.length < offset) text += filler;
        text = `${text.slice(0, offset - 1)} ${sentence}`;
      }
      while (text.length < length) text += filler;
      return `${text.slice(0, length - 1)}.`;
    }

    function pagedPlan(
      input: MemoryFactExtractionInput,
      entries: ReadonlyArray<
        readonly [quote: string, statement: string, entryPolarity?: "AFFIRMED" | "NEGATED"]
      >,
      polarity: "AFFIRMED" | "NEGATED" = "AFFIRMED"
    ): MemoryFactExtractionPlan {
      return decodeMemoryFactExtraction([{
        arguments: {
          observations: entries.map(([quote, statement, entryPolarity], index) => ({
            candidate_ref: `P${index + 1}`,
            confidence_band: "HIGH",
            dependency_refs: [],
            entities: [],
            evidence: exactTextRef(quote),
            usefulness: "DURABLE",
            identity: {
              dimension_key: null,
              mode: "PROPOSITION",
              predicate_key: null,
              subject: {
                canonical_label: null,
                entity_type: "NONE",
                qualifiers: { brand: null, model: null }
              }
            },
            memory_type: "PREFERENCE",
            reason_code: "durable_direct_preference",
            semantic_frame: { ...supportingUserAssertion, polarity: entryPolarity ?? polarity },
            sensitivity: "NORMAL",
            statement,
            temporal: {
              expiration_intent: "NONE",
              normalization: { kind: "NONE" },
              perspective: "CURRENT",
              raw_expression: null
            },
            temporary: false,
            value: emptyObservationValue
          }))
        },
        id: `fact-call-${randomUUID()}`,
        name: MEMORY_FACT_EXTRACTION_TOOL_NAME
      }], input);
    }

    function pageFingerprint(claim: MemoryJobClaim, page: MemoryFactJobPage): string {
      const identity = memoryFactExtractionJobIdentity(claim);
      if (!identity) throw new Error("memory_test_page_identity_missing");
      return memoryFactExtractionJobFingerprint({
        activeLeafMessageId: claim.activeLeafMessageId!,
        branchGeneration: claim.branchGeneration!,
        chatId: claim.chatId!,
        memoryGenerationSnapshot: claim.memoryGenerationSnapshot,
        sourceHash: claim.sourceHash!,
        sourceMessageId: claim.sourceMessageId!,
        sourceRevision: claim.sourceRevision!,
        userId: claim.userId
      }, identity.identityProfile, page);
    }

    async function createPageJob(
      claim: MemoryJobClaim,
      page: MemoryFactJobPage
    ): Promise<string> {
      const job = await prisma.memoryJob.create({
        data: {
          activeLeafMessageId: claim.activeLeafMessageId,
          branchGeneration: claim.branchGeneration,
          chatId: claim.chatId,
          idempotencyFingerprint: pageFingerprint(claim, page),
          kind: "EXTRACT_FACTS",
          memoryGenerationSnapshot: claim.memoryGenerationSnapshot,
          memoryRevisionSnapshot: claim.memoryRevisionSnapshot,
          pipelineVersion: claim.pipelineVersion,
          sourceHash: claim.sourceHash,
          sourceMessageId: claim.sourceMessageId,
          sourceRevision: claim.sourceRevision,
          userId: claim.userId
        },
        select: { id: true }
      });
      return job.id;
    }

    async function claimPageJob(
      claim: MemoryJobClaim,
      page: MemoryFactJobPage
    ): Promise<MemoryJobClaim> {
      const job = await prisma.memoryJob.findFirstOrThrow({
        where: {
          idempotencyFingerprint: pageFingerprint(claim, page),
          state: "QUEUED",
          userId: claim.userId
        }
      });
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(Date.now() + 120_000);
      const claimed = await prisma.memoryJob.update({
        data: {
          attemptCount: { increment: 1 },
          leaseExpiresAt,
          leaseToken: claimToken,
          state: "CLAIMED"
        },
        where: { id: job.id }
      });
      return {
        ...claim,
        attemptCount: claimed.attemptCount,
        claimToken,
        id: claimed.id,
        idempotencyFingerprint: claimed.idempotencyFingerprint,
        leaseExpiresAt,
        stage: claimed.stage
      };
    }

    async function evidenceProofs(userId: string) {
      const versions = await prisma.memoryFactVersion.findMany({
        select: { id: true },
        where: { userId }
      });
      return loadPersonalMemoryEvidenceSnapshots(
        prisma,
        userId,
        versions.map(({ id }) => id),
        { exactVNext: true }
      );
    }

    it("pages a long message with exact full-text evidence and fences its continuation", async () => {
      const userId = await createOwner("paged-source");
      try {
        const early = "I prefer written instructions.";
        const boundary = "I prefer quiet offices.";
        const lookahead = "I prefer weekly planning.";
        const late = "I prefer dark editor themes.";
        const text = placedText([
          [1_000, early], [19_990, boundary], [21_000, lookahead], [30_000, late]
        ], 45_000);
        expect(text.indexOf(boundary)).toBe(19_990);
        expect(text.length).toBe(45_000);
        const chat = await prisma.chat.create({ data: { title: "Paged source", userId } });
        const turn = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-09-27T09:00:00.000Z"),
          parentMessageId: null,
          userId,
          userText: text
        });
        await settleChat(userId, chat.id, turn);
        const first = await claimFactJob(userId, turn.userMessage.id);
        const firstInput = await prepare(first);
        expect(firstInput.targetPage).toMatchObject({
          coreEnd: 20_000,
          coreStart: 0,
          ordinal: 0,
          precedingText: "",
          sourceLength: text.length,
          sourceUnprocessed: false
        });
        const firstTarget = firstInput.messages.find(({ evidenceEligible }) =>
          evidenceEligible)!;
        expect(firstTarget.text).toBe(text.slice(0, 22_000));
        expect(firstTarget.contentHash).toBe(memorySha256(text));

        const firstPlan = pagedPlan(firstInput, [
          [early, "The user prefers written instructions."],
          [boundary, "The user prefers quiet offices."],
          [lookahead, "The user prefers weekly planning."],
          [late, "The user prefers dark editor themes."]
        ]);
        expect(firstPlan.candidates.map(({ evidence }) => evidence[0]!.startOffset))
          .toEqual([1_000, 19_990]);
        expect(firstPlan.rejections).toEqual([
          { candidateOrdinal: 2, reasonCode: "REJECT_OUTSIDE_PAGE" },
          { candidateOrdinal: 3, reasonCode: "REJECT_EVIDENCE_NOT_IN_TARGET" }
        ]);
        const firstBinding = await createSucceededBinding(
          userId, first, firstInput.inputHash, firstPlan.outputHash
        );
        await expect(applyPlan(userId, first, firstPlan, firstBinding))
          .resolves.toBe("APPLIED");
        // Replaying the settled page neither duplicates facts nor pages twice.
        await expect(applyPlan(userId, first, firstPlan, firstBinding))
          .resolves.toBe("APPLIED");
        await expect(prisma.memoryJob.count({
          where: { kind: "EXTRACT_FACTS", sourceMessageId: turn.userMessage.id, userId }
        })).resolves.toBe(2);

        const second = await claimPageJob(first, { cursor: 20_000, ordinal: 1 });
        const secondInput = await prepare(second);
        expect(secondInput.targetPage).toMatchObject({
          coreEnd: 40_000,
          coreStart: 20_000,
          ordinal: 1,
          precedingText: text.slice(18_000, 20_000),
          sourceLength: text.length
        });
        expect(secondInput.messages.find(({ evidenceEligible }) =>
          evidenceEligible)?.text).toBe(text.slice(20_000, 42_000));
        const secondPlan = pagedPlan(secondInput, [
          [boundary, "The user prefers quiet offices."],
          [lookahead, "The user prefers weekly planning."],
          [late, "The user prefers dark editor themes."]
        ]);
        expect(secondPlan.rejections).toEqual([
          { candidateOrdinal: 0, reasonCode: "REJECT_EVIDENCE_NOT_IN_TARGET" }
        ]);
        await expect(applyPlan(userId, second, secondPlan, await createSucceededBinding(
          userId, second, secondInput.inputHash, secondPlan.outputHash
        ))).resolves.toBe("APPLIED");

        const evidence = await prisma.memoryEvidence.findMany({
          orderBy: { sourceStartOffset: "asc" },
          select: {
            safeExcerpt: true,
            sourceEndOffset: true,
            sourceMessageContentHash: true,
            sourceStartOffset: true
          },
          where: { userId }
        });
        expect(evidence.map(({ sourceStartOffset }) => sourceStartOffset))
          .toEqual([1_000, 19_990, 21_000, 30_000]);
        for (const row of evidence) {
          expect(text.slice(row.sourceStartOffset!, row.sourceEndOffset!))
            .toBe(row.safeExcerpt);
          expect(row.sourceMessageContentHash).toBe(memorySha256(text));
        }
        await expect(evidenceProofs(userId)).resolves.toHaveLength(4);
        await expect(prisma.memoryFactVersion.count({ where: { userId } }))
          .resolves.toBe(4);

        // Forgetting the source fences the queued continuation before any
        // provider work, and no further page is created.
        const third = await claimPageJob(first, { cursor: 40_000, ordinal: 2 });
        await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
          createMemorySuppressionInTransaction(tx, settings, keyring, {
            branchGeneration: third.branchGeneration!,
            chatId: chat.id,
            explicitOverrideAllowed: false,
            messageId: turn.userMessage.id,
            scope: "SOURCE_MESSAGE",
            suppressionId: randomUUID()
          }));
        await expect(repository().prepare(third)).resolves.toMatchObject({
          decision: { status: "STALE" }
        });
        await expect(prisma.memoryJob.count({
          where: { kind: "EXTRACT_FACTS", sourceMessageId: turn.userMessage.id, userId }
        })).resolves.toBe(3);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("continues a full packet on the same message without losing or repeating a fact", async () => {
      const userId = await createOwner("full-packet");
      try {
        const statements = [
          "I prefer early meetings.", "I prefer short emails.",
          "I prefer unsweetened tea.", "I prefer quiet offices.",
          "I prefer written instructions.", "I prefer weekly planning.",
          "I prefer dark editor themes.", "I prefer numbered checklists.",
          "I prefer paper notebooks."
        ];
        const text = statements.join(" ");
        const chat = await prisma.chat.create({ data: { title: "Full packet", userId } });
        const turn = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-09-27T09:30:00.000Z"),
          parentMessageId: null,
          userId,
          userText: text
        });
        await settleChat(userId, chat.id, turn);
        const first = await claimFactJob(userId, turn.userMessage.id);
        const firstInput = await prepare(first);
        expect(firstInput.targetPage).toBeUndefined();
        // Nine observations, as from a provider schema without maxItems.
        const firstPlan = pagedPlan(firstInput, statements.map((statement) =>
          [statement, statement] as const));
        const resume = text.indexOf(statements[8]!);
        expect(firstPlan.candidates).toHaveLength(8);
        expect(firstPlan.coverageEnd).toBe(resume);
        await expect(applyPlan(userId, first, firstPlan, await createSucceededBinding(
          userId, first, firstInput.inputHash, firstPlan.outputHash
        ))).resolves.toBe("APPLIED");
        await expect(prisma.memoryFactExtractionCandidateReceipt.findFirstOrThrow({
          select: { outcome: true, reasonCode: true },
          where: { candidateOrdinal: 8, userId }
        })).resolves.toEqual({ outcome: "REJECTED", reasonCode: "REJECT_PACKET_OVERFLOW" });

        const second = await claimPageJob(first, { cursor: resume, ordinal: 1 });
        const secondInput = await prepare(second);
        expect(secondInput.targetPage).toMatchObject({
          coreEnd: text.length,
          coreStart: resume,
          precedingText: text.slice(0, resume)
        });
        const secondPlan = pagedPlan(secondInput, [
          [statements[7]!, statements[7]!],
          [statements[8]!, statements[8]!]
        ]);
        expect(secondPlan.rejections).toEqual([
          { candidateOrdinal: 0, reasonCode: "REJECT_EVIDENCE_NOT_IN_TARGET" }
        ]);
        const secondBinding = await createSucceededBinding(
          userId, second, secondInput.inputHash, secondPlan.outputHash
        );
        await expect(applyPlan(userId, second, secondPlan, secondBinding))
          .resolves.toBe("APPLIED");
        await expect(applyPlan(userId, second, secondPlan, secondBinding))
          .resolves.toBe("APPLIED");
        await expect(prisma.memoryFactVersion.count({ where: { userId } }))
          .resolves.toBe(9);
        await expect(prisma.memoryEvidence.findFirstOrThrow({
          select: { sourceEndOffset: true, sourceStartOffset: true },
          where: { safeExcerpt: statements[8], userId }
        })).resolves.toEqual({ sourceEndOffset: text.length, sourceStartOffset: resume });
        // Coverage ended with the message: no third page, one usage per page.
        await expect(prisma.memoryJob.count({
          where: { kind: "EXTRACT_FACTS", sourceMessageId: turn.userMessage.id, userId }
        })).resolves.toBe(2);
        await expect(prisma.usageEvent.count({ where: { userId } })).resolves.toBe(2);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("applies a page without adjudication and still queues its continuation", async () => {
      const userId = await createOwner("unadjudicated-page");
      try {
        const statements = [
          "I prefer early meetings.", "I prefer short emails.",
          "I prefer unsweetened tea.", "I do not drink coffee.",
          "I prefer quiet offices.", "I prefer written instructions.",
          "I prefer weekly planning.", "I prefer dark editor themes.",
          "I prefer paper notebooks."
        ];
        const negated = statements[3]!;
        const text = statements.join(" ");
        const chat = await prisma.chat.create({ data: { title: "Unadjudicated page", userId } });
        const turn = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-09-27T09:45:00.000Z"),
          parentMessageId: null,
          userId,
          userText: text
        });
        await settleChat(userId, chat.id, turn);
        const first = await claimFactJob(userId, turn.userMessage.id);
        const input = await prepare(first);
        const plan = pagedPlan(input, statements.map((statement) =>
          [statement, statement, statement === negated ? "NEGATED" : "AFFIRMED"] as const));
        const resume = text.indexOf(statements[8]!);
        expect(plan.candidates).toHaveLength(8);
        expect(plan.coverageEnd).toBe(resume);
        expect(memorySemanticAdjudicationInput(plan)?.candidateRefs).toEqual(["P4"]);
        // Exhausted adjudication: the ordinary apply runs without a packet.
        await expect(applyPlan(userId, first, plan, await createSucceededBinding(
          userId, first, input.inputHash, plan.outputHash
        ), new Date(), null)).resolves.toBe("APPLIED");
        await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
          orderBy: { candidateOrdinal: "asc" },
          select: { candidateOrdinal: true, outcome: true, reasonCode: true },
          where: { userId }
        })).resolves.toEqual(Array.from({ length: 9 }, (_, candidateOrdinal) => ({
          candidateOrdinal,
          ...(candidateOrdinal === 3
            ? { outcome: "REJECTED", reasonCode: "semantic_adjudication_unavailable" }
            : candidateOrdinal === 8
              ? { outcome: "REJECTED", reasonCode: "REJECT_PACKET_OVERFLOW" }
              : { outcome: "APPLIED", reasonCode: null })
        })));
        await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(7);
        await expect(prisma.memoryEvidence.count({ where: { safeExcerpt: negated, userId } }))
          .resolves.toBe(0);
        // The next page is queued exactly as after an adjudicated apply.
        const second = await claimPageJob(first, { cursor: resume, ordinal: 1 });
        await expect(prepare(second)).resolves.toMatchObject({
          targetPage: { coreEnd: text.length, coreStart: resume }
        });
        await expect(prisma.memoryJob.count({
          where: { kind: "EXTRACT_FACTS", sourceMessageId: turn.userMessage.id, userId }
        })).resolves.toBe(2);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("keeps a target unchanged when its weak decision normalizes to ambiguity", async () => {
      const userId = await createOwner("normalized-ambiguity");
      try {
        const chat = await prisma.chat.create({ data: { title: "Normalized ambiguity", userId } });
        const restriction = "I do not drink coffee.";
        const firstTurn = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-09-27T10:30:00.000Z"),
          parentMessageId: null, userId, userText: restriction
        });
        await settleChat(userId, chat.id, firstTurn);
        const first = await claimFactJob(userId, firstTurn.userMessage.id);
        const firstInput = await prepare(first);
        const firstPlan = pagedPlan(firstInput, [[restriction, restriction]], "NEGATED");
        await expect(applyPlan(userId, first, firstPlan, await createSucceededBinding(
          userId, first, firstInput.inputHash, firstPlan.outputHash
        ))).resolves.toBe("APPLIED");
        const original = await prisma.memoryFactVersion.findFirstOrThrow({ where: { userId } });

        const change = "I drink coffee again.";
        const neighbour = "I prefer quiet offices.";
        const secondTurn = await createTurn({
          assistantText: "Noted.", chatId: chat.id,
          createdAt: new Date("2026-09-27T10:31:00.000Z"),
          parentMessageId: firstTurn.assistantMessage.id, userId,
          userText: `${change} ${neighbour}`
        });
        await settleChat(userId, chat.id, secondTurn);
        const second = await claimFactJob(userId, secondTurn.userMessage.id);
        const input = await prepare(second);
        const target = input.contextRefs.find(({ source }) => source.factVersionId === original.id);
        if (!target) throw new Error("memory_test_normalized_target_missing");
        const plan = pagedPlan(input, [[change, change], [neighbour, neighbour]]);
        const semanticInput = memorySemanticAdjudicationInput(plan);
        expect(semanticInput?.candidateRefs).toEqual(["P1", "P2"]);
        const raw = (candidateRef: string, overrides: Record<string, unknown> = {}) => ({
          assertion_status: "ASSERTED", candidate_ref: candidateRef, confidence_band: "HIGH",
          entailment: "ENTAILED", entity_ref: null, operation: "NO_RELATION",
          reason_code: "bounded_label", subject_identity: "UNRESOLVED",
          subject_scope: "CURRENT_USER", target_ref: null, temporal_perspective: "CURRENT",
          ...overrides
        });
        const packet = decodeMemorySemanticAdjudication([{
          arguments: { decisions: [
            raw("P1", { confidence_band: "LOW", operation: "SUPERSEDE_TARGET",
              reason_code: "смена привычки", target_ref: target.ref }),
            raw("P2")
          ] },
          id: "normalized-call",
          name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
        }], semanticInput!);
        expect(packet.decisions[0]).toMatchObject({
          operation: "AMBIGUOUS", reasonCode: "normalized_not_entailed_high", targetRef: null
        });
        await expect(applyPlan(userId, second, plan, await createSucceededBinding(
          userId, second, input.inputHash, plan.outputHash
        ), new Date(), packet)).resolves.toBe("APPLIED");
        const execution = await prisma.memoryFactExtractionExecution.findFirstOrThrow({
          select: { id: true }, where: { memoryJobId: second.id, userId }
        });
        await expect(prisma.memoryFactExtractionCandidateReceipt.findMany({
          orderBy: { candidateOrdinal: "asc" },
          select: { outcome: true, reasonCode: true },
          where: { extractionExecutionId: execution.id, userId }
        })).resolves.toEqual([
          { outcome: "REJECTED", reasonCode: "semantic_not_admitted" },
          { outcome: "APPLIED", reasonCode: null }
        ]);
        await expect(prisma.memoryFactVersion.findUniqueOrThrow({
          select: { state: true }, where: { id: original.id }
        })).resolves.toEqual({ state: "ACTIVE" });
        await expect(prisma.memoryFact.findUniqueOrThrow({
          select: { currentVersionId: true }, where: { id: original.factId }
        })).resolves.toEqual({ currentVersionId: original.id });
        await expect(prisma.memoryFactVersion.count({
          where: { state: { not: "ACTIVE" }, userId }
        })).resolves.toBe(0);
        await expect(prisma.memoryEvidence.count({ where: { safeExcerpt: neighbour, userId } }))
          .resolves.toBe(1);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("gives a continuation page its own semantic adjudication", async () => {
      const userId = await createOwner("page-adjudication");
      try {
        const statements = [
          "I prefer early meetings.", "I prefer short emails.",
          "I prefer unsweetened tea.", "I prefer quiet offices.",
          "I prefer written instructions.", "I prefer weekly planning.",
          "I prefer dark editor themes.", "I prefer numbered checklists."
        ];
        const negated = "I do not drink coffee.";
        const text = [...statements, negated].join(" ");
        const chat = await prisma.chat.create({ data: { title: "Page adjudication", userId } });
        const turn = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-09-27T10:00:00.000Z"),
          parentMessageId: null,
          userId,
          userText: text
        });
        await settleChat(userId, chat.id, turn);
        const first = await claimFactJob(userId, turn.userMessage.id);
        const resume = text.indexOf(negated);
        await createPageJob(first, { cursor: resume, ordinal: 1 });
        const second = await claimPageJob(first, { cursor: resume, ordinal: 1 });

        // The message-level budget stays with page 0: a message-less
        // reservation is admitted only for a continuation page job.
        await expect(prisma.memoryAuxiliarySemanticCall.create({
          data: {
            id: `page-zero-${randomUUID()}`,
            ownerJobId: first.id,
            purpose: "FACT_EXTRACTION_ADJUDICATION",
            sourceMessageId: null,
            userId
          }
        })).rejects.toThrow("Memory semantic adjudication owner is invalid");
        await expect(repository().reserveAdjudication(first)).resolves.toBe("ACQUIRED");
        await expect(repository().reserveAdjudication(second)).resolves.toBe("ACQUIRED");
        await expect(repository().auxiliary(first)).resolves.toMatchObject({
          ownerJobId: first.id
        });
        await expect(repository().auxiliary(second)).resolves.toMatchObject({
          ownerJobId: second.id
        });
        await expect(prisma.memoryAuxiliarySemanticCall.findMany({
          orderBy: { sourceMessageId: "asc" },
          select: { ownerJobId: true, sourceMessageId: true },
          where: { userId }
        })).resolves.toEqual([
          { ownerJobId: first.id, sourceMessageId: turn.userMessage.id },
          { ownerJobId: second.id, sourceMessageId: null }
        ]);

        const input = await prepare(second);
        const plan = pagedPlan(input, [[negated, "The user does not drink coffee."]], "NEGATED");
        expect(plan.candidates).toHaveLength(1);
        expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
        const extractionBindingId = await createSucceededBinding(
          userId, second, input.inputHash, plan.outputHash
        );
        await stagePlanOnly(userId, second, plan, extractionBindingId);
        const packet = await semanticAdjudicationForPlan(userId, plan);
        if (!packet) throw new Error("memory_test_adjudication_packet_missing");
        const authority = await prisma.memoryExecutionBinding.findUniqueOrThrow({
          select: {
            connectionId: true,
            credentialId: true,
            credentialVersionId: true,
            destinationFingerprint: true,
            providerId: true,
            providerModelId: true,
            secretFreeExecutionSnapshot: true
          },
          where: { id: extractionBindingId }
        });
        const adjudicationBindingId = `fact-adjudication-${randomUUID()}`;
        const startedAt = new Date();
        await prisma.memoryExecutionBinding.create({
          data: {
            ...authority,
            createdAt: new Date(startedAt.getTime() - 1_000),
            id: adjudicationBindingId,
            inputHash: packet.inputHash,
            logicalRole: "MEMORY_FACT_EXTRACT",
            memoryJobId: second.id,
            ordinal: 1,
            ownerType: "JOB",
            pipelineVersion: MEMORY_SEMANTIC_ADJUDICATION_PIPELINE_VERSION,
            policyVersion: MEMORY_SEMANTIC_ADJUDICATION_POLICY_VERSION,
            promptVersion: MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
            schemaVersion: MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION,
            secretFreeExecutionSnapshot:
              authority.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
            startedAt,
            state: "RUNNING",
            usageCompleteness: "UNAVAILABLE",
            userId
          }
        });
        await withLockedMemoryTransaction(prisma, userId, async (tx) => {
          await repository().completeAdjudication(
            tx, second, adjudicationBindingId, packet, startedAt
          );
          await tx.memoryExecutionBinding.update({
            data: {
              acceptedOutputHash: packet.outputHash,
              completedAt: startedAt,
              recoverableUntil: new Date(startedAt.getTime() + 86_400_000),
              state: "SUCCEEDED"
            },
            where: { id: adjudicationBindingId }
          });
        });
        await expect(repository().auxiliary(second)).resolves.toMatchObject({
          acceptedOutputHash: packet.outputHash,
          executionId: adjudicationBindingId,
          ownerJobId: second.id
        });
        await expect(applyPlan(userId, second, plan, extractionBindingId, startedAt, packet))
          .resolves.toBe("APPLIED");
        await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(1);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("reports an oversized, partially processed or uncovered source as failed, not stale", async () => {
      const userId = await createOwner("incomplete-source");
      try {
        const chat = await prisma.chat.create({ data: { title: "Incomplete source", userId } });
        const blob = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-09-27T11:00:00.000Z"),
          parentMessageId: null,
          userId,
          userText: "A".repeat(1_100_000)
        });
        await settleChat(userId, chat.id, blob);
        const blobClaim = await claimFactJob(userId, blob.userMessage.id);
        await expect(repository().prepare(blobClaim)).resolves.toEqual({
          decision: { errorCode: "memory_fact_source_oversized", status: "CANCELLED" }
        });

        const longText = `${"Short neutral sentence number. ".repeat(40_000)}End.`;
        const projected = projectMemoryHistorySourceText(longText);
        expect(projected.processingState).toBe("PARTIAL");
        const long = await createTurn({
          assistantText: "Noted.",
          chatId: chat.id,
          createdAt: new Date("2026-09-27T11:10:00.000Z"),
          parentMessageId: blob.assistantMessage.id,
          userId,
          userText: longText
        });
        await settleChat(userId, chat.id, long);
        const longClaim = await claimFactJob(userId, long.userMessage.id);
        const firstInput = await prepare(longClaim);
        expect(firstInput.targetPage).toMatchObject({
          coreEnd: 20_000,
          sourceLength: projected.safeText!.length,
          sourceUnprocessed: true
        });
        const remainder = { cursor: projected.safeText!.length, ordinal: 1 };
        await createPageJob(longClaim, remainder);
        await expect(repository().prepare(await claimPageJob(longClaim, remainder)))
          .resolves.toEqual({
            decision: {
              errorCode: "memory_fact_source_partially_processed",
              status: "CANCELLED"
            }
          });
        const exhausted = { cursor: 20_000, ordinal: MEMORY_FACT_MAX_SOURCE_PAGES };
        await createPageJob(longClaim, exhausted);
        await expect(repository().prepare(await claimPageJob(longClaim, exhausted)))
          .resolves.toEqual({
            decision: {
              errorCode: "memory_fact_source_coverage_exhausted",
              status: "CANCELLED"
            }
          });
      } finally {
        await cleanupOwner(userId);
      }
    });
  });

  describe("Prisma Memory fact extraction invalid-output budget", () => {
    const context = () => ({
      now: () => new Date(),
      setStage: async () => undefined,
      signal: new AbortController().signal
    });

    async function budgetFixture(label: string) {
      const userId = await createOwner(label);
      const chat = await prisma.chat.create({ data: { title: "Budget", userId } });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Hello there!"
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      return { claim, execution: await budgetExecution(userId), userId };
    }

    it("holds the durable invalid-output budget across re-claims", async () => {
      const { claim, execution, userId } = await budgetFixture("invalid-budget");
      try {
        let calls = 0;
        const run = vi.fn(async () => budgetPacket(++calls, "invalid"));
        const crashingRepository = (crashAfterReads: number) => {
          const base = repository();
          let reads = 0;
          return {
            ...base,
            async bindings(owner: string, jobId: string) {
              reads += 1;
              if (reads > crashAfterReads) throw new Error("memory_test_process_lost");
              return base.bindings(owner, jobId);
            }
          };
        };
        const handler = (repo: MemoryFactExtractionHandlerDependencies["repository"]) =>
          createMemoryFactExtractionHandler({
            execution,
            now: () => new Date(),
            probeAuthority: async () => undefined,
            provider: { run },
            repository: repo
          });

        // The process is lost after two settled invalid packets.
        await expect(handler(crashingRepository(3)).execute(claim, context()))
          .rejects.toThrow("memory_test_process_lost");
        let stored = await budgetBindings(userId, claim.id);
        expect(stored.bindings).toMatchObject([0, 1].map((ordinal) => ({
          errorCode: "memory_fact_output_invalid",
          ordinal,
          state: "FAILED"
        })));

        // A re-claim spends only the remaining call.
        const reclaimed = await reclaimFactJob(claim);
        await expect(handler(repository()).execute(reclaimed, context()))
          .resolves.toMatchObject({ stage: "fact_output_rejected" });
        expect(run).toHaveBeenCalledTimes(3);
        stored = await budgetBindings(userId, claim.id);
        expect(stored.bindings).toMatchObject([0, 1, 2].map((ordinal) => ({
          errorCode: "memory_fact_output_invalid",
          ordinal,
          outputTokens: 11 + ordinal,
          state: "FAILED"
        })));
        expect(stored.usage.map(({ outputTokens }) => outputTokens).sort())
          .toEqual([11, 12, 13]);

        // A further re-claim never dispatches past the exhausted budget.
        await expect(handler(repository()).execute(await reclaimFactJob(reclaimed), context()))
          .resolves.toMatchObject({ stage: "fact_output_rejected" });
        expect(run).toHaveBeenCalledTimes(3);
        expect((await budgetBindings(userId, claim.id)).bindings).toHaveLength(3);
      } finally {
        await cleanupOwner(userId);
      }
    });

    it("stages one receipt for the call that succeeded after an invalid packet", async () => {
      const { claim, execution, userId } = await budgetFixture("invalid-then-valid");
      try {
        const run = vi.fn()
          .mockResolvedValueOnce(budgetPacket(1, "invalid"))
          .mockResolvedValueOnce(budgetPacket(2, []));
        const result = await createMemoryFactExtractionHandler({
          execution,
          now: () => new Date(),
          probeAuthority: async () => undefined,
          provider: { run },
          repository: repository()
        }).execute(claim, context());

        expect(result.stage).toBe("fact_observations_empty");
        const stored = await budgetBindings(userId, claim.id);
        expect(stored.bindings).toMatchObject([
          { errorCode: "memory_fact_output_invalid", ordinal: 0, state: "FAILED" },
          { errorCode: null, ordinal: 1, state: "SUCCEEDED" }
        ]);
        expect(stored.usage).toHaveLength(2);
        const receipts = await prisma.memoryFactExtractionExecution.findMany({
          select: { executionBindingId: true },
          where: { memoryJobId: claim.id, userId }
        });
        expect(receipts).toEqual([{ executionBindingId: stored.bindings[1]!.id }]);
      } finally {
        await cleanupOwner(userId);
      }
    });
  });
});
