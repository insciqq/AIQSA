import { describe, expect, it } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "./contract";
import {
  decodeMemorySemanticAdjudication,
  decodeStoredMemorySemanticAdjudication,
  encodeStoredMemorySemanticAdjudication,
  memoryCandidateRequiresSemanticAdjudication,
  memoryPotentialDuplicateContext,
  memorySemanticAuthorityAdmitsCandidate,
  memorySemanticAdjudicationInput,
  memorySemanticAdjudicationPacketIsValid,
  memorySemanticAdjudicationPromptPayload,
  MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT,
  MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
} from "./adjudication";

function candidate(
  overrides: Partial<MemoryExtractedCandidate> = {}
): MemoryExtractedCandidate {
  return {
    candidateRef: "C1",
    canonicalKey: "slot:v2:device:macbook:product_status:_",
    category: "about_you",
    confidence: 1,
    confidenceBand: "HIGH",
    correction: false,
    coreEligible: false,
    coreSalience: "NONE",
    dimensionKey: null,
    directness: "DIRECT",
    displayText: "opaque",
    dependencies: [],
    entities: [],
    evidence: [{
      endOffset: 6,
      messageId: "message-1",
      quote: "opaque",
      sourceTextHash: memorySha256("opaque"),
      startOffset: 0
    }],
    expectedAt: null,
    expirationIntent: "NONE",
    expiresAt: null,
    futureUseful: true,
    id: "1".repeat(64),
    identityKind: "SLOT",
    identityVersion: "slot-v2",
    importance: 0.65,
    languageCode: "und",
    modality: "STATE",
    negated: false,
    occurredAt: null,
    predicateKey: "product_status",
    proposedValue: { schema: "product-status-v1", state: "owned" },
    quote: "opaque",
    rawTemporalExpression: null,
    reasonCode: null,
    responsePreference: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    semanticFrame: {
      assertionStatus: "ASSERTED",
      changeIntent: "NONE",
      memoryDirective: "NONE",
      polarity: "AFFIRMED",
      speechAct: "ASSERTION",
      subjectScope: "CURRENT_USER",
      temporalPerspective: "CURRENT"
    },
    sensitivity: "NORMAL",
    state: "PENDING",
    statement: "opaque",
    subjectKey: "device:macbook",
    temporary: false,
    temporalNormalization: { kind: "NONE" },
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null,
    ...overrides
  };
}

function plan(value = candidate()): MemoryFactExtractionPlan {
  const input: MemoryFactExtractionInput = {
    contextRefs: [{
      aliases: ["device"],
      displayName: "Device",
      entityId: "private-entity-id",
      entityType: "DEVICE",
      identitySubjectKey: "device:macbook",
      kind: "FACT_VERSION",
      ref: "F1",
      source: {
        contentHash: null,
        factVersionId: "private-version-id",
        messageId: null,
        messageUpdatedAt: null,
        projectionVersion: null
      },
      text: "bounded current state"
    }],
    folderId: null,
    inputHash: "a".repeat(64),
    messages: [{
      contentHash: memorySha256("opaque"),
      createdAt: "2026-08-25T10:00:00.000Z",
      evidenceEligible: true,
      id: "message-1",
      languageCode: "und",
      redactionSpans: [],
      role: "user",
      text: "opaque",
      updatedAt: "2026-08-25T10:00:00.000Z"
    }],
    source: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 1,
      chatId: "chat-1",
      memoryGenerationSnapshot: 1,
      sourceHash: "b".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 1,
      userId: "user-1"
    },
    sourceProjectionHash: "c".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "d".repeat(64),
    timeZone: "UTC"
  };
  return {
    candidateOrdinals: [0],
    candidates: [value],
    input,
    outputHash: "e".repeat(64),
    rejections: []
  };
}

describe("batched Memory semantic adjudication", () => {
  it("makes new-fact ref nullability explicit without weakening the decoder", () => {
    expect(MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION)
      .toBe("memory-semantic-adjudication-prompt-v5");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("A candidate_ref is never an entity_ref or target_ref");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("When context_refs is empty, set entity_ref and target_ref to null");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("use operation NO_RELATION");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("complete proposed_statement must be entailed");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("item obtained for a distinct recipient");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("including a paraphrase");
  });

  it("routes plausible cross-key paraphrases through governed comparison", () => {
    const paraphrase = candidate({
      canonicalKey: "proposition:automatic-coffee",
      displayText: "Пользователь любит кофе.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      modality: "PREFERENCE",
      predicateKey: null,
      proposedValue: {
        normalizedStatement: "пользователь любит кофе.",
        schema: "generic-fact-v1"
      },
      statement: "Пользователь любит кофе.",
      subjectKey: null
    });
    const duplicatePlan = {
      ...plan(paraphrase),
      input: {
        ...plan(paraphrase).input,
        contextRefs: [{
          ...plan(paraphrase).input.contextRefs[0]!,
          text: "Я люблю кофе."
        }]
      }
    };

    expect(memoryPotentialDuplicateContext(
      paraphrase.displayText,
      duplicatePlan.input.contextRefs[0]!.text
    )).toBe(true);
    expect(memoryCandidateRequiresSemanticAdjudication(
      paraphrase,
      duplicatePlan.input.contextRefs
    )).toBe(true);
    expect(memorySemanticAdjudicationInput(duplicatePlan)?.candidateRefs)
      .toEqual(["C1"]);
  });

  it("does not grant MESSAGE refs duplicate-target authority", () => {
    const proposition = candidate({
      canonicalKey: "proposition:automatic-coffee",
      displayText: "Пользователь любит кофе.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      modality: "PREFERENCE",
      predicateKey: null,
      subjectKey: null
    });
    const context = [{
      ...plan(proposition).input.contextRefs[0]!,
      entityId: null,
      kind: "MESSAGE" as const,
      source: {
        contentHash: "f".repeat(64),
        factVersionId: null,
        messageId: "older-message",
        messageUpdatedAt: "2026-08-25T09:00:00.000Z",
        projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
      },
      text: "Я люблю кофе."
    }];
    expect(memoryCandidateRequiresSemanticAdjudication(proposition, context))
      .toBe(false);
  });

  it("compares explicit reminders with bounded facts even without lexical overlap", () => {
    const reminder = candidate({
      canonicalKey: "proposition:explicit-reminder",
      displayText: "Пользователь предпочитает утренние пробежки.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      modality: "PREFERENCE",
      predicateKey: null,
      semanticFrame: {
        ...candidate().semanticFrame,
        memoryDirective: "EXPLICIT_REMEMBER",
        speechAct: "COMMAND"
      },
      subjectKey: null
    });
    expect(memoryCandidateRequiresSemanticAdjudication(
      reminder,
      plan(reminder).input.contextRefs
    )).toBe(true);
  });

  it("routes translations through bounded fact reconciliation without token overlap", () => {
    const translated = candidate({
      canonicalKey: "proposition:serbian-coffee",
      displayText: "Корисник воли кафу.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      modality: "PREFERENCE",
      predicateKey: null,
      statement: "Корисник воли кафу.",
      subjectKey: null
    });
    const context = [{
      ...plan(translated).input.contextRefs[0]!,
      text: "El usuario ama el café."
    }];

    expect(memoryPotentialDuplicateContext(translated.displayText, context[0]!.text))
      .toBe(false);
    expect(memoryCandidateRequiresSemanticAdjudication(translated, context))
      .toBe(true);
  });

  it("reconciles a MEDIUM supporting proposition without granting mutation authority", () => {
    const supporting = candidate({
      canonicalKey: "proposition:supporting-coffee",
      confidence: 0.6,
      confidenceBand: "MEDIUM",
      displayText: "Кофе сорта Кедровый Маяк мне нравится.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      modality: "PREFERENCE",
      predicateKey: null,
      proposedValue: {
        normalizedStatement: "кофе сорта кедровый маяк мне нравится.",
        schema: "generic-fact-v1"
      },
      statement: "Кофе сорта Кедровый Маяк мне нравится.",
      subjectKey: null
    });
    const context = plan(supporting).input.contextRefs;
    const reinforce = {
      assertionStatus: "ASSERTED",
      candidateRef: "C1",
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "REINFORCE",
      reasonCode: "same_fact",
      subjectScope: "CURRENT_USER",
      targetRef: "F1",
      temporalPerspective: "CURRENT"
    } as const;

    expect(memoryCandidateRequiresSemanticAdjudication(supporting, context)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(supporting, reinforce, context))
      .toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(supporting, {
      ...reinforce,
      operation: "SUPERSEDE_TARGET"
    }, context)).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate(supporting, null, [])).toBe(true);
  });

  it("routes proposition STATE claims through statement-aware adjudication", () => {
    const state = candidate({
      canonicalKey: "proposition:gift-card",
      displayText: "The current user owns a gift card.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      predicateKey: null,
      proposedValue: null,
      subjectKey: null
    });
    const input = memorySemanticAdjudicationInput(plan(state));
    expect(input?.candidateRefs).toEqual(["C1"]);
    const payload = JSON.parse(memorySemanticAdjudicationPromptPayload(input!)) as {
      candidates: Array<{ proposed_statement?: string }>;
    };
    expect(payload.candidates[0]?.proposed_statement)
      .toBe("The current user owns a gift card.");
  });

  it("requires one batch for a high-risk SLOT and hides database ids", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    expect(input.candidateRefs).toEqual(["C1"]);
    expect(memoryCandidateRequiresSemanticAdjudication(input.plan.candidates[0]!))
      .toBe(true);
    const payload = memorySemanticAdjudicationPromptPayload(input);
    expect(payload).toContain('"ref":"F1"');
    expect(payload).not.toContain("private-entity-id");
    expect(payload).not.toContain("private-version-id");
  });

  it("decodes one strict decision per requested candidate and round-trips storage", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    const packet = decodeMemorySemanticAdjudication([{
      arguments: {
        decisions: [{
          assertion_status: "ASSERTED",
          candidate_ref: "C1",
          confidence_band: "HIGH",
          entailment: "ENTAILED",
          entity_ref: "F1",
          operation: "REINFORCE",
          reason_code: "explicit_current_state",
          subject_scope: "CURRENT_USER",
          target_ref: "F1",
          temporal_perspective: "CURRENT"
        }]
      },
      id: "call-1",
      name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    expect(packet.decisions[0]).toMatchObject({
      candidateRef: "C1",
      operation: "REINFORCE",
      targetRef: "F1"
    });
    expect(decodeStoredMemorySemanticAdjudication(
      encodeStoredMemorySemanticAdjudication(packet)
    )).toEqual(packet);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, {
      ...packet,
      inputHash: "f".repeat(64)
    })).toBe(false);
  });

  it("rejects malformed durable decisions even when their outer hash is self-consistent", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    const decisions = [{
      assertionStatus: "ASSERTED",
      candidateRef: "C1",
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "NO_RELATION",
      reasonCode: "bounded",
      subjectScope: "CURRENT_USER",
      targetRef: null,
      temporalPerspective: "CURRENT",
      unexpected: "field"
    }];
    expect(() => decodeStoredMemorySemanticAdjudication({
      decisions,
      inputHash: input.inputHash,
      outputHash: memorySha256({
        decisions,
        domain: "aiqsa.memory.semantic-adjudication-output",
        inputHash: input.inputHash,
        version: 1
      }),
      schemaVersion: "memory-semantic-adjudication-schema-v1"
    })).toThrow("memory_semantic_adjudication_result_invalid");
  });

  it("rejects invented refs and non-HIGH pointer operations", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    for (const decision of [
      {
        assertion_status: "ASSERTED",
        candidate_ref: "C1",
        confidence_band: "HIGH",
        entailment: "ENTAILED",
        entity_ref: null,
        operation: "SUPERSEDE_TARGET",
        reason_code: "invented_target",
        subject_scope: "CURRENT_USER",
        target_ref: "F99",
        temporal_perspective: "CURRENT"
      },
      {
        assertion_status: "ASSERTED",
        candidate_ref: "C1",
        confidence_band: "LOW",
        entailment: "ENTAILED",
        entity_ref: null,
        operation: "SUPERSEDE_TARGET",
        reason_code: "weak_target",
        subject_scope: "CURRENT_USER",
        target_ref: "F1",
        temporal_perspective: "CURRENT"
      }
    ]) {
      expect(() => decodeMemorySemanticAdjudication([{
        arguments: { decisions: [decision] },
        id: "call-1",
        name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
      }], input)).toThrow("memory_semantic_adjudication_output_invalid");
    }
  });

  it("cannot adjudicate fields that are absent from the bounded output contract", () => {
    const unresolved = candidate({
      semanticFrame: {
        ...candidate().semanticFrame,
        speechAct: "UNKNOWN"
      }
    });
    expect(memorySemanticAuthorityAdmitsCandidate(unresolved, {
      assertionStatus: "ASSERTED",
      candidateRef: unresolved.candidateRef,
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "NO_RELATION",
      reasonCode: "otherwise-entailed",
      subjectScope: "CURRENT_USER",
      targetRef: null,
      temporalPerspective: "CURRENT"
    })).toBe(false);
  });
});
