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
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
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
  }
): MemoryFactExtractionPlan {
  const candidateRef = `C-${memorySha256({
    product,
    quote,
    state,
    statement
  }).slice(0, 16)}`;
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: candidateRef,
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
      }]
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
  confidenceBand: "HIGH" | "MEDIUM" = "HIGH"
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        candidate_ref: `C-${memorySha256({ quote, statement }).slice(0, 16)}`,
        confidence_band: confidenceBand,
        dependency_refs: [],
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
          change_intent: "NONE",
          memory_directive: explicitReminder ? "EXPLICIT_REMEMBER" : "NONE",
          polarity: "AFFIRMED",
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
  const scope = await prisma.memoryScope.create({
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
  const candidate = plan.candidates[0];
  const target = plan.input.contextRefs.find(({ source }) =>
    source.factVersionId === targetVersionId);
  if (!input || !candidate || !target) {
    throw new Error("memory_duplicate_test_context_missing");
  }
  const decisions: MemorySemanticAdjudication[] = [{
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
  }];
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
      subjectScope: "CURRENT_USER",
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
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
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
      await prisma.memoryExecutionBinding.create({
        data: {
          ...authority,
          createdAt: new Date(startedAt.getTime() - 1_000),
          id: adjudicationBindingId,
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
          reasonCode: "semantic_not_admitted"
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

  it("indexes a Safety Lite fact and batches its hybrid embedding", async () => {
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
      await expect(prisma.memorySearchEntry.findFirstOrThrow({
        select: { embeddingState: true, itemType: true },
        where: { userId }
      })).resolves.toEqual({
        embeddingState: "PENDING",
        itemType: "FACT_VERSION"
      });
      await expect(prisma.memoryJob.count({
        where: { kind: "EMBED_ITEMS", state: "QUEUED", userId }
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

  it("converges an automatic paraphrase on an explicit fact across canonical keys", async () => {
    const userId = await createOwner("explicit-semantic-duplicate");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Explicit semantic duplicate", userId }
      });
      const quote = "Запомни, что я люблю кофе.";
      const turn = await createTurn({
        assistantText: "Запомнил.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T11:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: quote
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
        true
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
        select: { outcome: true },
        where: { userId }
      })).resolves.toEqual([{ outcome: "REINFORCED" }]);
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

  it("stages a Safety Lite-classified SLOT value behind relation resolution", async () => {
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
        userText: "I bought a MacBook Air."
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
        "owned"
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
