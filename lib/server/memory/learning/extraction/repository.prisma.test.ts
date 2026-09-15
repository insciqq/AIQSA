import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTestProviderExecutionAuthority,
  deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority
} from "@/tests/support/providerExecutionAuthority";
import { textMessageContent } from "../../../../domain/content";
import { providerTemplateIds } from "../../../../domain/providerTemplates";
import { prisma } from "../../../prisma";
import type { MemoryJobClaim } from "../../coordinator/types";
import { detachExpiredMemoryExecutionBindings } from "../../execution/lifecycle";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import { loadPersonalEligibleFactVersionIds } from "../../persistence/eligibility";
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
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  memoryFactCandidateId,
  memoryFactExtractionInputHash,
  memoryFactExtractionJobFingerprint,
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
  memoryCandidateRequiresSemanticAdjudication,
  memorySemanticAdjudicationInput,
  memorySemanticAdjudicationOutputHash,
  type MemorySemanticAdjudicationPacket
} from "./adjudication";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { createPrismaMemoryFactExtractionRepository } from "./repository";
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
import { commitMemoryVNextExtractionPlan } from "../../vnext/repository";
import { loadMemoryFactContextRefs } from "../dependencies/context";

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
          entity_type: "DEVICE",
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
        future_useful: true,
        identity: {
          dimension_key: null,
          mode: "SLOT",
          predicate_key: "product_status",
          subject: {
            canonical_label: product.label,
            entity_type: "DEVICE",
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
    correctionTargetRef !== null || polarity === "CORRECTION" ? "CORRECTION" : "NONE"
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [quote, ...additionalQuotes].map((quote) => ({
        candidate_ref: `C-${memorySha256({ quote, statement }).slice(0, 16)}`,
        confidence_band: confidenceBand,
        dependency_refs: correctionTargetRef === null ? [] : [correctionTargetRef],
        entities: [],
        evidence: exactTextRef(quote),
        future_useful: true,
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
        future_useful: true,
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
  entities: readonly unknown[] = []
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: "C-scheduled-workshop",
        confidence_band: "HIGH",
        dependency_refs: [],
        entities,
        evidence: exactTextRef(quote),
        future_useful: true,
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
        memory_type: "PLAN",
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
        future_useful: true,
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
  const quote = "Я заказал макбук.";
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: "C-context-order",
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
        future_useful: true,
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
        reason_code: "context_resolved_order",
        semantic_frame: currentUserAssertion,
        sensitivity: "NORMAL",
        statement: "Пользователь заказал MacBook Air.",
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
          state: "ordered",
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
        future_useful: true,
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
        future_useful: true,
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
  sourceContext?: Readonly<{ antecedentRef: string; messageRef: string }>
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
        }],
        evidence: exactTextRef(quote),
        future_useful: true,
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
  operation: "RETRACT_TARGET" | "SUPERSEDE_TARGET"
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
    entityRef: target.entityId === null ? null : target.ref,
    operation,
    reasonCode: "relationship_mutation",
    subjectScope: candidate.semanticFrame.subjectScope,
    targetRef: target.ref,
    temporalPerspective: "CURRENT"
  }];
  return {
    decisions,
    inputHash: input.inputHash,
    outputHash: memorySemanticAdjudicationOutputHash(input.inputHash, decisions)
  };
}

async function createSucceededBinding(
  userId: string,
  claim: MemoryJobClaim,
  inputHash: string,
  _outputHash: string
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
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
      promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
      providerId: "openai_compatible",
      providerModelId: authority.providerModelId,
      recoverableUntil: null,
      relationsDetachedAt: null,
      schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
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

describe("Prisma Memory vNext source-message ingestion", () => {
  afterAll(async () => {
    if (executionAuthority) {
      await deleteTestProviderExecutionAuthority(prisma, executionAuthority);
    }
    await prisma.$disconnect();
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
        : { outcome: "REJECTED", reasonCode: "semantic_not_admitted" });
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
    { date: "2026-10-07", weakSubjectType: undefined },
    { date: "2026-10-28", weakSubjectType: undefined },
    { date: "2026-10-07", weakSubjectType: "GOAL" as const },
    { date: "2026-10-28", weakSubjectType: "PROJECT" as const }
  ])(
    "retains the revised future schedule $date ($weakSubjectType) and the superseded schedule's evidence",
    async ({ date, weakSubjectType }) => {
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
        const firstPlan = scheduledPropositionPlan(firstInput, initialText, "2026-10-14", "NONE", weakSubjectType);
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
        const plan = scheduledPropositionPlan(input, revisedText, date, "STATE_CHANGE", weakSubjectType);
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

  it("[E02] atomically persists the bounded adjudication result before settlement", async () => {
    const userId = await createOwner("adjudication-result-contract");
    try {
      const sourceText = "I currently own a MacBook Air.";
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
      const plan = extractionPlan(input, sourceText);
      const extractionBindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await stagePlanOnly(userId, claim, plan, extractionBindingId);
      const packet = await semanticAdjudicationForPlan(userId, plan);
      if (!packet) throw new Error("memory_test_adjudication_packet_missing");
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
          schemaVersion: MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION,
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
          schemaVersion: MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION
        }
      });
      expect(stored.completedAt?.getTime()).toBeGreaterThanOrEqual(
        startedAt.getTime()
      );
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
        const oldInput = { ...oldFields, inputHash: memoryFactExtractionInputHash(oldFields) };
        // Seed the accepted storage boundary. No retired calculator or provider
        // is used to manufacture a historical result in the current runtime.
        const canonicalKey = `prop:v1:${"a".repeat(64)}`;
        const { id: _id, ...candidateFields } = decoded.candidates[0]!;
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
        expect(await prepare(oldClaim)).toEqual(oldInput);
        const oldBinding = await createSucceededBinding(userId, oldClaim, oldInput.inputHash, oldPlan.outputHash);
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

  it("persists assistant-resolved MEDIUM context as a fenced supporting fact", async () => {
    const userId = await createOwner("supporting-assistant-context");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Supporting context", userId }
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
      expect(input.messages.map(({ evidenceEligible, id, role }) => ({
        evidenceEligible,
        id,
        role
      }))).toEqual([
        { evidenceEligible: false, id: first.userMessage.id, role: "user" },
        { evidenceEligible: false, id: first.assistantMessage.id, role: "assistant" },
        { evidenceEligible: true, id: second.userMessage.id, role: "user" }
      ]);
      const assistantRef = input.contextRefs.find(({ source }) =>
        source.messageId === first.assistantMessage.id);
      expect(assistantRef).toMatchObject({ kind: "MESSAGE", ref: "M2" });

      const plan = supportingContextPlan(input, targetText, assistantRef!.ref);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");

      const version = await prisma.memoryFactVersion.findFirstOrThrow({
        select: {
          confidence: true,
          coreEligible: true,
          coreSalience: true,
          createdByEventId: true,
          factId: true,
          id: true,
          sourceMode: true,
          structuredValue: true
        },
        where: { userId }
      });
      expect(version).toMatchObject({
        confidence: 0.6,
        coreEligible: false,
        coreSalience: "NONE",
        sourceMode: "AUTOMATIC",
        structuredValue: {
          authority: "supporting",
          schema: "supporting-observation-v1"
        }
      });
      await expect(prisma.memoryEvent.findUniqueOrThrow({
        select: { operation: true },
        where: { id: version.createdByEventId }
      })).resolves.toEqual({ operation: "AUTO_PROPOSE" });
      await expect(prisma.memoryEvidence.findFirstOrThrow({
        select: { messageId: true, sourceRole: true },
        where: { factVersionId: version.id, userId }
      })).resolves.toEqual({
        messageId: second.userMessage.id,
        sourceRole: "user"
      });
      await expect(prisma.memoryFactVersionSourceDependency.findFirstOrThrow({
        select: { sourceMessageId: true, targetFactVersionId: true },
        where: { targetFactVersionId: version.id, userId }
      })).resolves.toEqual({
        sourceMessageId: first.assistantMessage.id,
        targetFactVersionId: version.id
      });
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [version.id]
      )).resolves.toEqual(new Set([version.id]));

      await prisma.message.update({
        data: {
          content: textMessageContent("Changed assistant context."),
          updatedAt: new Date("2026-08-25T10:30:00.000Z")
        },
        where: { id: first.assistantMessage.id }
      });
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [version.id]
      )).resolves.toEqual(new Set());
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

  it.each(["message", "fact"] as const)(
    "persists one pronoun antecedent with its message source and fences changed %s",
    async (changedSource) => {
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
        await expect(applyPlan(userId, claim, plan, await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        ))).resolves.toBe("APPLIED");
        const retained = await prisma.memoryFactVersion.findFirstOrThrow({
          where: { id: { not: original.id }, userId }
        });
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

  it("keeps relationship updates and withdrawals on the exact grounded subject", async () => {
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
          "USER_RELATIONSHIP_CONTEXT"
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
          input, text, subject, statement, changeIntent, targetVersionId, subjectScope
        );
        const bindingId = await createSucceededBinding(
          userId, claim, input.inputHash, plan.outputHash
        );
        return { bindingId, claim, createdAt, plan };
      }

      const initial = await turnPlan(
        "My sister Lia works at North Bakery.",
        "Lia",
        "The current user's sister Lia works at North Bakery."
      );
      await expect(applyPlan(
        userId, initial.claim, initial.plan, initial.bindingId,
        new Date(initial.createdAt.getTime() + 30_000)
      )).resolves.toBe("APPLIED");
      const original = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "ACTIVE", userId }
      });

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
        "My sister Lia now works at South Bakery.",
        "Lia",
        "The current user's sister Lia now works at South Bakery.",
        "STATE_CHANGE",
        original.id
      );
      await expect(applyPlan(
        userId,
        update.claim,
        update.plan,
        update.bindingId,
        new Date(update.createdAt.getTime() + 30_000),
        relationshipMutationPacket(update.plan, original.id, "SUPERSEDE_TARGET")
      )).resolves.toBe("APPLIED");
      const pendingUpdate = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { state: "PENDING_RELATION", userId }
      });
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
      const updated = activeAfterUpdate.find(({ displayText }) => displayText?.includes("South Bakery"));
      if (!updated) throw new Error("memory_relationship_update_value_missing");

      const withdrawal = await turnPlan(
        "My sister Lia no longer works at South Bakery.",
        "Lia",
        "The current user withdraws the report that sister Lia works at South Bakery.",
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
      })).resolves.toBe(0);
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
        userText: "Я заказал макбук."
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
        safeExcerpt: "Я заказал макбук.",
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
        "The user likes coffee.",
        false,
        "MEDIUM"
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
        userText: "I ordered a MacBook Air."
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
      const orderedPlan = extractionPlan(
        orderedInput,
        "I ordered a MacBook Air.",
        "The user ordered a MacBook Air.",
        "ordered"
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
});
