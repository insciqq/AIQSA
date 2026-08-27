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
      .toBe("memory-semantic-adjudication-prompt-v2");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("A candidate_ref is never an entity_ref or target_ref");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("When context_refs is empty, set entity_ref and target_ref to null");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("use operation NO_RELATION");
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
