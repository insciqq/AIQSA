import { describe, expect, it } from "vitest";
import observedFailureCodes from "../../../observability/failureCodes.json";
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
  memoryRelationshipReplacementIsAuthorized,
  memorySemanticAuthorityAdmitsCandidate,
  memorySemanticAdjudicationInput,
  memorySemanticAdjudicationOutputHash,
  memorySemanticAdjudicationPacketIsValid,
  memorySemanticAdjudicationPromptPayload,
  memorySemanticAdjudicationTool,
  MemorySemanticAdjudicationOutputError,
  MEMORY_SEMANTIC_ADJUDICATION_NORMALIZED_REASON_CODES,
  MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_INVALID_CODES,
  MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_VIOLATIONS,
  MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION,
  MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION,
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
    identityProfile: "LEGACY_V1",
    identityKind: "SLOT",
    identityVersion: "slot-v2",
    importance: 0.65,
    languageCode: "und",
    legacyCanonicalKey: "slot:v2:device:macbook:product_status:_",
    legacyProposedValue: { schema: "product-status-v1", state: "owned" },
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
    unicodeCanonicalKey: "slot:v4:device:macbook:product_status:_",
    unicodeProposedValue: { schema: "product-status-v1", state: "owned" },
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
    identityProfile: "UNICODE_V2",
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

function referenceKindsPlan(): MemoryFactExtractionPlan {
  const base = plan();
  const bound = base.input.contextRefs[0]!;
  const message = {
    ...bound, aliases: [], displayName: null, entityId: null, entityType: null,
    identitySubjectKey: null, kind: "MESSAGE" as const, ref: "M1",
    source: {
      contentHash: "f".repeat(64), factVersionId: null, messageId: "older-message",
      messageUpdatedAt: "2026-08-25T09:00:00.000Z",
      projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
    }
  };
  return {
    ...base,
    candidates: [candidate({
      identityKind: "PROPOSITION", proposedIdentityKind: "PROPOSITION",
      dependencies: [{ dependencyKind: "TEMPORAL_CONTEXT", ref: message.ref, source: message.source }]
    })],
    input: { ...base.input, contextRefs: [bound, {
      ...bound, ref: "F2", entityId: null, entityType: null, displayName: null, aliases: []
    }, message] }
  };
}

function relationshipPlan(): MemoryFactExtractionPlan {
  const base = plan(candidate({
    identityKind: "PROPOSITION", proposedIdentityKind: "PROPOSITION",
    predicateKey: null, subjectKey: null,
    entities: [{
      aliases: [], canonicalLabel: "Nerin", contextEntityId: null, contextRef: null,
      entityType: "PERSON", mention: "Nerin", mentionKind: "NAMED",
      qualifiers: {}, role: "SUBJECT"
    }],
    semanticFrame: { ...candidate().semanticFrame,
      changeIntent: "STATE_CHANGE", subjectScope: "USER_RELATIONSHIP_CONTEXT" }
  }));
  const context = { ...base.input.contextRefs[0]!,
    aliases: ["Nera"], displayName: "Nera", entityType: "PERSON" };
  return { ...base, input: { ...base.input,
    contextRefs: [context, { ...context, ref: "F2", entityId: "another-private-entity-id" }] } };
}

/** The exact content-free code a rejected adjudication output carries. */
function outputViolation(decode: () => unknown): string | null {
  try {
    decode();
    return null;
  } catch (error) {
    return error instanceof MemorySemanticAdjudicationOutputError
      ? error.code
      : "unexpected_error";
  }
}

const normalizedAmbiguous = {
  entityRef: null,
  operation: "AMBIGUOUS",
  reasonCode: "normalized_not_entailed_high",
  subjectIdentity: "UNRESOLVED",
  targetRef: null
} as const;

function subjectIdentityDecision() {
  return {
    assertion_status: "ASSERTED", candidate_ref: "C1", confidence_band: "HIGH",
    entailment: "ENTAILED", entity_ref: "F1", operation: "SUPERSEDE_TARGET",
    reason_code: "same_subject_revision", subject_identity: "SAME_ENTITY",
    subject_scope: "USER_RELATIONSHIP_CONTEXT", target_ref: "F1",
    temporal_perspective: "CURRENT"
  };
}

describe("batched Memory semantic adjudication", () => {
  it("requires a fresh explicit subject identity decision separately from the relation target", () => {
    const input = memorySemanticAdjudicationInput(relationshipPlan())!;
    const decode = (decision: Record<string, unknown>) => decodeMemorySemanticAdjudication([{
      arguments: { decisions: [decision] }, id: "call", name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    const packet = decode(subjectIdentityDecision());
    expect(packet.decisions[0]).toMatchObject({ subjectIdentity: "SAME_ENTITY", entityRef: "F1" });
    expect(decodeStoredMemorySemanticAdjudication(encodeStoredMemorySemanticAdjudication(packet)))
      .toEqual(packet);
    const { subject_identity: _identity, ...missingIdentity } = subjectIdentityDecision();
    expect(() => decode(missingIdentity)).toThrow("memory_semantic_adjudication_output_invalid");
    for (const change of [
      { entity_ref: null }, { target_ref: "F2" }, { subject_scope: "CURRENT_USER" },
      { operation: "RETRACT_TARGET" }
    ]) {
      expect(outputViolation(() => decode({ ...subjectIdentityDecision(), ...change })))
        .toBe("memory_semantic_adjudication_output_invalid_subject_identity");
    }
    // A weak identity claim loses its authority instead of the whole packet.
    const weak = decode({ ...subjectIdentityDecision(), confidence_band: "LOW" });
    expect(weak.decisions[0]).toMatchObject({ ...normalizedAmbiguous, confidenceBand: "LOW" });
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[0]!, weak.decisions[0]!, input.plan.input.contextRefs
    )).toBe(false);
  });

  it("supplies bounded entity annotations without database identity", () => {
    const input = memorySemanticAdjudicationInput(relationshipPlan())!;
    const payload = memorySemanticAdjudicationPromptPayload(input);
    expect(JSON.parse(payload).candidates[0].entities).toEqual([{
      context_ref: null, entity_type: "PERSON", mention: "Nerin",
      mention_kind: "NAMED", role: "SUBJECT"
    }]);
    expect(JSON.parse(payload).candidates[0]).toMatchObject({
      memory_type: "STATE", temporary: false
    });
    expect(payload).not.toContain("private-entity-id");
    expect(payload).not.toContain("private-version-id");
  });

  it("admits a distinct new property only for its already bound subject", () => {
    const base = relationshipPlan();
    const context = base.input.contextRefs[0]!;
    const original = base.candidates[0]!;
    const observation = {
      ...original,
      dependencies: [{ dependencyKind: "COREFERENCE_ANTECEDENT" as const,
        ref: context.ref, source: context.source }],
      entities: [{ ...original.entities[0]!, contextRef: context.ref,
        contextEntityId: context.entityId, mentionKind: "PRONOMINAL" as const }],
      semanticFrame: { ...original.semanticFrame, changeIntent: "NONE" as const }
    };
    const input = memorySemanticAdjudicationInput({ ...base, candidates: [observation] })!;
    const raw = { ...subjectIdentityDecision(), operation: "NO_RELATION", target_ref: null };
    const decode = (decision: Record<string, unknown>) => decodeMemorySemanticAdjudication([{
      arguments: { decisions: [decision] }, id: "call", name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    const packet = decode(raw);
    const decision = packet.decisions[0]!;
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(decodeStoredMemorySemanticAdjudication(encodeStoredMemorySemanticAdjudication(packet)))
      .toEqual(packet);
    expect(memorySemanticAuthorityAdmitsCandidate(observation, decision, input.plan.input.contextRefs))
      .toBe(true);
    for (const [change, violation] of [
      [{ entity_ref: null }, "subject_identity"], [{ entity_ref: "F99" }, "entity_ref"],
      [{ target_ref: "F1" }, "operation_target"], [{ subject_scope: "CURRENT_USER" }, "subject_identity"],
      [{ operation: "AMBIGUOUS" }, "subject_identity"]
    ] as const) {
      expect(outputViolation(() => decode({ ...raw, ...change })))
        .toBe(`memory_semantic_adjudication_output_invalid_${violation}`);
    }
    const weak = decode({ ...raw, confidence_band: "LOW" }).decisions[0]!;
    expect(weak).toMatchObject({ ...normalizedAmbiguous, confidenceBand: "LOW" });
    expect(memorySemanticAuthorityAdmitsCandidate(observation, weak, input.plan.input.contextRefs))
      .toBe(false);
    for (const changed of [
      { ...observation, dependencies: [] },
      { ...observation, entities: original.entities },
      { ...observation, entities: [...observation.entities, original.entities[0]!] },
      { ...observation, entities: [{ ...observation.entities[0]!, contextEntityId: "different-entity" }] }
    ]) {
      expect(memorySemanticAuthorityAdmitsCandidate(changed, decision, input.plan.input.contextRefs))
        .toBe(false);
    }
    expect(memorySemanticAuthorityAdmitsCandidate(observation, { ...decision, entityRef: "F2" },
      input.plan.input.contextRefs)).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate(observation, decision, [{ ...context, entityId: null }]))
      .toBe(false);
  });

  it("reads a retained generic decision without granting new subject identity authority", () => {
    const inputHash = "a".repeat(64);
    const decisions = [{
      assertionStatus: "ASSERTED", candidateRef: "C1", confidenceBand: "HIGH",
      entailment: "ENTAILED", entityRef: "F1", operation: "SUPERSEDE_TARGET",
      reasonCode: "retained_relation", subjectScope: "USER_RELATIONSHIP_CONTEXT",
      targetRef: "F1", temporalPerspective: "CURRENT"
    }] as const;
    const outputHash = memorySemanticAdjudicationOutputHash(inputHash, decisions);
    const stored = { decisions, inputHash, outputHash,
      schemaVersion: "memory-semantic-adjudication-schema-v1" };
    const decoded = decodeStoredMemorySemanticAdjudication(stored);
    expect(decoded).toEqual({ decisions, inputHash, outputHash,
      schemaVersion: "memory-semantic-adjudication-schema-v1" });
    expect(decoded.decisions[0]).not.toHaveProperty("subjectIdentity");
    expect(encodeStoredMemorySemanticAdjudication(decoded)).toEqual(stored);
  });

  it("requires fresh distinct-holder authority without transferring entity identity", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    const raw = {
      assertion_status: "ASSERTED", candidate_ref: "C1", confidence_band: "HIGH",
      entailment: "ENTAILED", entity_ref: null, operation: "REPLACE_RELATIONSHIP_TARGET",
      reason_code: "explicit_relationship_successor", subject_identity: "UNRESOLVED",
      subject_scope: "USER_RELATIONSHIP_CONTEXT", target_ref: "F1", temporal_perspective: "CURRENT"
    };
    const decode = (overrides: Record<string, unknown> = {}) => decodeMemorySemanticAdjudication([{
      arguments: { decisions: [{ ...raw, ...overrides }] }, id: "replacement-call",
      name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    const packet = decode();
    expect(memoryRelationshipReplacementIsAuthorized(packet.decisions[0]!)).toBe(true);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(decodeStoredMemorySemanticAdjudication(encodeStoredMemorySemanticAdjudication(packet)))
      .toEqual(packet);
    for (const [overrides, violation] of [
      [{ entity_ref: "F1" }, "subject_identity"], [{ target_ref: null }, "operation_target"],
      [{ target_ref: "unprovided" }, "target_ref"],
      [{ subject_identity: "SAME_ENTITY" }, "subject_identity"],
      [{ subject_scope: "CURRENT_USER" }, "subject_identity"],
      [{ temporal_perspective: "FORMER" }, "subject_identity"],
      [{ assertion_status: "HYPOTHETICAL" }, "subject_identity"]
    ] as const) {
      expect(outputViolation(() => decode(overrides)))
        .toBe(`memory_semantic_adjudication_output_invalid_${violation}`);
    }
    for (const [confidenceBand, entailment] of [["MEDIUM", "ENTAILED"], ["HIGH", "UNKNOWN"]]) {
      const weak = decode({ confidence_band: confidenceBand, entailment }).decisions[0]!;
      expect(weak).toMatchObject({ ...normalizedAmbiguous, confidenceBand, entailment });
      expect(memoryRelationshipReplacementIsAuthorized(weak)).toBe(false);
    }
    for (const schemaVersion of [
      "memory-semantic-adjudication-schema-v1", "memory-semantic-adjudication-schema-v2"
    ]) {
      expect(memorySemanticAdjudicationPacketIsValid(input.plan, { ...packet, schemaVersion }))
        .toBe(false);
      expect(() => encodeStoredMemorySemanticAdjudication({ ...packet, schemaVersion }))
        .toThrow("memory_semantic_adjudication_result_invalid");
      expect(() => decodeStoredMemorySemanticAdjudication({
        ...encodeStoredMemorySemanticAdjudication(packet), schemaVersion
      })).toThrow("memory_semantic_adjudication_result_invalid");
    }
    expect(packet.schemaVersion).toBe(MEMORY_SEMANTIC_ADJUDICATION_SCHEMA_VERSION);

    const previous = decode({ operation: "SUPERSEDE_TARGET" });
    const stored = { ...encodeStoredMemorySemanticAdjudication(previous),
      schemaVersion: "memory-semantic-adjudication-schema-v2" };
    const retained = decodeStoredMemorySemanticAdjudication(stored);
    expect(retained.outputHash).toBe(previous.outputHash);
    expect(memoryRelationshipReplacementIsAuthorized(retained.decisions[0]!)).toBe(false);
    expect(encodeStoredMemorySemanticAdjudication(retained)).toEqual(stored);
  });

  it("makes new-fact ref nullability explicit without weakening the decoder", () => {
    expect(MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION)
      .toBe("memory-semantic-adjudication-prompt-v21");
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
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("A withdrawal closes the target's current applicability");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("short answer to the immediately preceding assistant question");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("A bare confirmation or a value present only in assistant text is not entailed");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("A durable communication preference can be an imperative");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("the requested work is not a fact");
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain("preparing documents for a change does not establish a lasting plan");
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

  it("keeps grounded user relationship context proposition-only and attribution-scoped", () => {
    const relationship = candidate({
      canonicalKey: "proposition:ana-juniper",
      displayText: "The current user reports that their sister Ana works at Juniper bakery.",
      entities: [{
        aliases: ["Ana"],
        canonicalLabel: "Ana",
        contextEntityId: null,
        contextRef: null,
        entityType: "PERSON",
        mention: "Ana",
        mentionKind: "NAMED",
        qualifiers: {},
        role: "SUBJECT"
      }],
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      predicateKey: null,
      proposedIdentityKind: "PROPOSITION",
      proposedValue: {
        normalizedStatement:
          "the current user reports that their sister ana works at juniper bakery.",
        schema: "generic-fact-v1"
      },
      semanticFrame: {
        assertionStatus: "ASSERTED",
        changeIntent: "NONE",
        memoryDirective: "NONE",
        polarity: "AFFIRMED",
        speechAct: "ASSERTION",
        subjectScope: "USER_RELATIONSHIP_CONTEXT",
        temporalPerspective: "CURRENT"
      },
      statement: "The current user reports that their sister Ana works at Juniper bakery.",
      subjectKey: null
    });
    const admitted = {
      assertionStatus: "ASSERTED",
      candidateRef: "C1",
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "NO_RELATION",
      reasonCode: "ordinary_personal_context",
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      targetRef: null,
      temporalPerspective: "CURRENT"
    } as const;

    expect(memoryCandidateRequiresSemanticAdjudication(relationship)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(relationship, admitted)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(relationship, {
      ...admitted,
      subjectScope: "CURRENT_USER"
    })).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate({
      ...relationship,
      entities: []
    }, admitted)).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate({
      ...relationship,
      identityKind: "SLOT",
      proposedIdentityKind: "SLOT"
    }, admitted)).toBe(false);
  });

  it("allows exact relationship updates and withdrawals without crossing subject scope", () => {
    const base = candidate({
      canonicalKey: "proposition:noor-schedule",
      displayText: "The current user reports a new schedule for their colleague Noor.",
      entities: [{
        aliases: ["Noor"], canonicalLabel: "Noor", contextEntityId: null,
        contextRef: null, entityType: "PERSON", mention: "Noor",
        mentionKind: "NAMED", qualifiers: {}, role: "SUBJECT"
      }],
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      predicateKey: null,
      proposedIdentityKind: "PROPOSITION",
      proposedValue: { normalizedStatement: "noor schedule", schema: "generic-fact-v1" },
      semanticFrame: {
        assertionStatus: "ASSERTED",
        changeIntent: "STATE_CHANGE",
        memoryDirective: "NONE",
        polarity: "CORRECTION",
        speechAct: "ASSERTION",
        subjectScope: "USER_RELATIONSHIP_CONTEXT",
        temporalPerspective: "CURRENT"
      },
      subjectKey: null
    });
    const decision = {
      assertionStatus: "ASSERTED",
      candidateRef: "C1",
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "SUPERSEDE_TARGET",
      reasonCode: "exact_relationship_update",
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      targetRef: "F1",
      temporalPerspective: "CURRENT"
    } as const;
    expect(memorySemanticAuthorityAdmitsCandidate(base, decision, plan(base).input.contextRefs))
      .toBe(true);

    const withdrawal = {
      ...base,
      semanticFrame: {
        ...base.semanticFrame,
        changeIntent: "RETRACTION" as const,
        polarity: "RETRACTION" as const
      }
    };
    expect(memorySemanticAuthorityAdmitsCandidate(withdrawal, {
      ...decision,
      operation: "RETRACT_TARGET"
    }, plan(withdrawal).input.contextRefs)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(withdrawal, {
      ...decision,
      operation: "RETRACT_TARGET",
      subjectScope: "CURRENT_USER"
    }, plan(withdrawal).input.contextRefs)).toBe(false);
  });

  it("routes proposition STATE claims through statement-aware adjudication", () => {
    const state = candidate({
      canonicalKey: "proposition:gift-card",
      displayText: "The current user owns a gift card.",
      identityKind: "PROPOSITION",
      identityVersion: "proposition-v1",
      predicateKey: null,
      proposedValue: null,
      statement: "The current user owns a gift card.",
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

  it.each([
    { amount: 1, date: "2024-03-02", perspective: "FUTURE", statement: "I plan to attend training tomorrow." },
    { amount: -1, date: "2024-02-29", perspective: "FORMER", statement: "I attended training yesterday." }
  ] as const)("preserves a relative $perspective claim and its source clock", ({
    amount, date, perspective, statement
  }) => {
    const temporalNormalization = { amount, kind: "CALENDAR_OFFSET", unit: "DAY" } as const;
    const observation = candidate({
      displayText: `${statement} [${perspective === "FUTURE" ? "expected_date" : "event_date"}=${date}]`,
      statement,
      temporalNormalization,
      semanticFrame: { ...candidate().semanticFrame, temporalPerspective: perspective }
    });
    const base = plan(observation);
    const prepared = {
      ...base,
      input: {
        ...base.input,
        messages: [{
          ...base.input.messages[0]!,
          createdAt: "2024-03-01T23:30:00.000Z",
          text: statement
        }],
        timeZone: "America/Los_Angeles"
      }
    };
    const payload = JSON.parse(memorySemanticAdjudicationPromptPayload(
      memorySemanticAdjudicationInput(prepared)!
    ));
    expect(payload.target_message).toBe(statement);
    expect(payload.target_message_created_at).toBe("2024-03-01T23:30:00.000Z");
    expect(payload.time_zone).toBe("America/Los_Angeles");
    expect(payload.candidates[0]).toMatchObject({
      proposed_statement: statement,
      semantic_frame: { temporalPerspective: perspective },
      temporal: { expiration_intent: "NONE", normalization: temporalNormalization }
    });
    expect(payload.candidates[0].proposed_statement).not.toContain(date);
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

  it("distinguishes a candidate's bound dependencies from other comparison context", () => {
    const base = plan();
    const dependency = base.input.contextRefs[0]!;
    const prepared = {
      ...base,
      candidates: [candidate({ dependencies: [{
        dependencyKind: "RELATION_CONTEXT", ref: dependency.ref, source: dependency.source
      }] })],
      input: { ...base.input, contextRefs: [dependency, { ...dependency, ref: "F2" }] }
    };
    const payload = JSON.parse(memorySemanticAdjudicationPromptPayload(memorySemanticAdjudicationInput(prepared)!));
    expect(payload.candidates[0].dependency_refs).toEqual(["F1"]);
    expect(payload.context_refs.map((context: { ref: string }) => context.ref)).toEqual(["F1", "F2"]);
    const independent = { ...prepared, candidates: [candidate()] };
    const independentPayload = JSON.parse(memorySemanticAdjudicationPromptPayload(memorySemanticAdjudicationInput(independent)!));
    expect(independentPayload.candidates[0].dependency_refs).toEqual([]);
  });

  it("covers every admitted observation with one bounded adjudication packet", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate({
      candidateRef: `C${index + 1}`,
      id: String(index + 1).repeat(64)
    }));
    const input = memorySemanticAdjudicationInput({
      ...plan(),
      candidateOrdinals: candidates.map((_, index) => index),
      candidates
    })!;
    const decisions = input.candidateRefs.map((candidateRef) => ({
      assertion_status: "ASSERTED",
      candidate_ref: candidateRef,
      confidence_band: "HIGH",
      entailment: "ENTAILED",
      subject_identity: "UNRESOLVED", entity_ref: null,
      operation: "NO_RELATION",
      reason_code: "direct_assertion",
      subject_scope: "CURRENT_USER",
      target_ref: null,
      temporal_perspective: "CURRENT"
    }));
    expect(input.candidateRefs).toHaveLength(8);
    const schema = memorySemanticAdjudicationTool(input).inputSchema as {
      properties: { decisions: { maxItems: number } };
    };
    expect(schema.properties.decisions.maxItems).toBeGreaterThanOrEqual(decisions.length);
    const packet = decodeMemorySemanticAdjudication([{
      arguments: { decisions },
      id: "batch-call",
      name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(packet.decisions.map(({ candidateRef }) => candidateRef)).toEqual(input.candidateRefs);
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
          subject_identity: "UNRESOLVED", entity_ref: "F1",
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

  it("rejects invented refs and strips authority from non-HIGH pointer operations", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    const decode = (decision: Record<string, unknown>) => decodeMemorySemanticAdjudication([{
      arguments: { decisions: [decision] },
      id: "call-1",
      name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    const pointer = {
      assertion_status: "ASSERTED",
      candidate_ref: "C1",
      confidence_band: "HIGH",
      entailment: "ENTAILED",
      subject_identity: "UNRESOLVED", entity_ref: null,
      operation: "SUPERSEDE_TARGET",
      reason_code: "invented_target",
      subject_scope: "CURRENT_USER",
      target_ref: "F99",
      temporal_perspective: "CURRENT"
    };
    expect(outputViolation(() => decode(pointer)))
      .toBe("memory_semantic_adjudication_output_invalid_target_ref");
    const weak = decode({
      ...pointer, confidence_band: "LOW", reason_code: "weak_target", target_ref: "F1"
    });
    expect(weak.decisions[0]).toMatchObject({ ...normalizedAmbiguous, confidenceBand: "LOW" });
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[0]!, weak.decisions[0]!, input.plan.input.contextRefs
    )).toBe(false);
  });

  it.each([
    { entityRef: "M1", targetRef: null, operation: "NO_RELATION" },
    { entityRef: "F2", targetRef: null, operation: "NO_RELATION" },
    { entityRef: null, targetRef: "M1", operation: "REINFORCE" }
  ])("rejects a context ref outside its authority domain ($entityRef, $targetRef)",
    ({ entityRef, targetRef, operation }) => {
      const input = memorySemanticAdjudicationInput(referenceKindsPlan())!;
      expect(() => decodeMemorySemanticAdjudication([{
        arguments: { decisions: [{
          assertion_status: "ASSERTED", candidate_ref: "C1", confidence_band: "HIGH",
          entailment: "ENTAILED", subject_identity: "UNRESOLVED", entity_ref: entityRef, operation, reason_code: "direct_continuation",
          subject_scope: "CURRENT_USER", target_ref: targetRef, temporal_perspective: "CURRENT"
        }] }, id: "call", name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
      }], input)).toThrow("memory_semantic_adjudication_output_invalid");
    }
  );

  it("admits a declared message continuation without requiring an entity binding", () => {
    const input = memorySemanticAdjudicationInput(referenceKindsPlan())!;
    const packet = decodeMemorySemanticAdjudication([{
      arguments: { decisions: [{
        assertion_status: "ASSERTED", candidate_ref: "C1", confidence_band: "HIGH",
        entailment: "ENTAILED", subject_identity: "UNRESOLVED", entity_ref: null, operation: "NO_RELATION",
        reason_code: "direct_continuation", subject_scope: "CURRENT_USER",
        target_ref: null, temporal_perspective: "CURRENT"
      }] }, id: "call", name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[0]!, packet.decisions[0]!, input.plan.input.contextRefs
    )).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[0]!, { ...packet.decisions[0]!, entailment: "UNKNOWN" },
      input.plan.input.contextRefs
    )).toBe(false);
    expect(input.plan.candidates[0]!.dependencies[0]!.source.messageId).toBe("older-message");
  });

  it("offers only references that the corresponding output field can bind", () => {
    const input = memorySemanticAdjudicationInput(referenceKindsPlan())!;
    const schema = memorySemanticAdjudicationTool(input).inputSchema as {
      properties: { decisions: { items: { properties: Record<string, { enum: unknown[] }> } } };
    };
    const fields = schema.properties.decisions.items.properties;
    expect(fields.candidate_ref!.enum).toEqual(["C1"]);
    expect(fields.entity_ref!.enum).toEqual(["F1", null]);
    expect(fields.target_ref!.enum).toEqual(["F1", "F2", null]);
    const messageOnly = { ...input, plan: {
      ...input.plan, input: { ...input.plan.input,
        contextRefs: input.plan.input.contextRefs.filter(({ kind }) => kind === "MESSAGE") }
    } };
    const restricted = memorySemanticAdjudicationTool(messageOnly).inputSchema as typeof schema;
    expect(restricted.properties.decisions.items.properties.entity_ref!.enum).toEqual([null]);
    expect(restricted.properties.decisions.items.properties.target_ref!.enum).toEqual([null]);
    expect(JSON.parse(memorySemanticAdjudicationPromptPayload(messageOnly)).candidates[0].dependency_refs)
      .toEqual(["M1"]);
  });

  it("offers subject identity only for requested relationship observations", () => {
    const current = plan();
    const relationship = {
      ...relationshipPlan().candidates[0]!, candidateRef: "C2", id: "2".repeat(64)
    };
    const input = memorySemanticAdjudicationInput({
      ...current, candidates: [current.candidates[0]!, relationship],
      candidateOrdinals: [0, 1]
    })!;
    const domain = (candidateRefs: readonly string[]) => {
      const schema = memorySemanticAdjudicationTool({ ...input, candidateRefs }).inputSchema as {
        properties: { decisions: { items: { properties: {
          subject_identity: { enum: string[] }; entity_ref: { enum: unknown[] };
        } } } };
      };
      return schema.properties.decisions.items.properties;
    };
    // An unrequested relationship candidate must not widen a current-user
    // packet's identity domain; binding an object still remains available.
    expect(domain(["C1"]).subject_identity.enum).toEqual(["UNRESOLVED"]);
    expect(domain(["C1"]).entity_ref.enum).toEqual(["F1", null]);
    expect(domain(["C2"]).subject_identity.enum).toEqual(["SAME_ENTITY", "UNRESOLVED"]);
    expect(domain(["C1", "C2"]).subject_identity.enum)
      .toEqual(["SAME_ENTITY", "UNRESOLVED"]);

    const selected = { ...input, candidateRefs: ["C1"] };
    const decision = { ...subjectIdentityDecision(), subject_scope: "CURRENT_USER" };
    const call = (value: typeof decision) => [{
      arguments: { decisions: [value] }, id: "identity-domain-call",
      name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }];
    expect(() => decodeMemorySemanticAdjudication(call(decision), selected))
      .toThrow("memory_semantic_adjudication_output_invalid");
    expect(decodeMemorySemanticAdjudication(call({
      ...decision, subject_identity: "UNRESOLVED"
    }), selected).decisions[0]).toMatchObject({
      subjectScope: "CURRENT_USER", subjectIdentity: "UNRESOLVED",
      entityRef: "F1", targetRef: "F1", operation: "SUPERSEDE_TARGET"
    });
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

describe("Memory semantic adjudication output reliability", () => {
  const currentUserDecision = (overrides: Record<string, unknown> = {}) => ({
    assertion_status: "ASSERTED", candidate_ref: "C1", confidence_band: "HIGH",
    entailment: "ENTAILED", entity_ref: null, operation: "NO_RELATION",
    reason_code: "direct_assertion", subject_identity: "UNRESOLVED",
    subject_scope: "CURRENT_USER", target_ref: null, temporal_perspective: "CURRENT",
    ...overrides
  });
  const call = (decisions: unknown, overrides: Record<string, unknown> = {}) => [{
    arguments: { decisions }, id: "reliability-call",
    name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME, ...overrides
  }];
  const pairPlan = () => {
    const base = plan();
    return { ...base, candidateOrdinals: [0, 1], candidates: [
      candidate(), candidate({ candidateRef: "C2", id: "2".repeat(64) })
    ] };
  };

  it("registers every content-free code within the job, binding and log limits", () => {
    expect(MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_VIOLATIONS).toHaveLength(14);
    expect(Object.isFrozen(MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_VIOLATIONS)).toBe(true);
    expect([...MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_INVALID_CODES]).toEqual([
      "memory_semantic_adjudication_output_invalid",
      ...MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_VIOLATIONS.map((violation) =>
        `memory_semantic_adjudication_output_invalid_${violation}`)
    ]);
    const registered = new Set<string>(observedFailureCodes);
    for (const code of [...MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_INVALID_CODES,
      "memory_fact_provider_transient"]) {
      expect(registered.has(code)).toBe(true);
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
      expect(code).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$/u);
    }
    expect(Math.max(...[...MEMORY_SEMANTIC_ADJUDICATION_OUTPUT_INVALID_CODES]
      .map(({ length }) => length))).toBe(60);
    expect([...MEMORY_SEMANTIC_ADJUDICATION_NORMALIZED_REASON_CODES])
      .toEqual(["normalized_not_entailed_high", "normalized_reason_code"]);
    const error = new MemorySemanticAdjudicationOutputError("enum");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: "memory_semantic_adjudication_output_invalid_enum",
      message: "memory_semantic_adjudication_output_invalid_enum",
      violation: "enum"
    });
  });

  it("names the first violated packet invariant", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    const pair = memorySemanticAdjudicationInput(pairPlan())!;
    const valid = currentUserDecision();
    for (const [decode, violation] of [
      [() => decodeMemorySemanticAdjudication(undefined, input), "call_count"],
      [() => decodeMemorySemanticAdjudication([], input), "call_count"],
      [() => decodeMemorySemanticAdjudication([...call([valid]), ...call([valid])], input), "call_count"],
      [() => decodeMemorySemanticAdjudication(call([valid], { name: "other_tool" }), input), "tool_name"],
      [() => decodeMemorySemanticAdjudication(call([valid], { arguments: [] }), input), "arguments"],
      [() => decodeMemorySemanticAdjudication(call([valid], {
        arguments: { decisions: [valid], extra: true }
      }), input), "arguments"],
      [() => decodeMemorySemanticAdjudication(call({ C1: valid }), input), "arguments"],
      [() => decodeMemorySemanticAdjudication(call([]), input), "decision_count"],
      [() => decodeMemorySemanticAdjudication(call([valid, valid]), input), "decision_count"],
      [() => decodeMemorySemanticAdjudication(call([valid, valid]), pair), "candidate_set"],
      // An invalid decision is reported before the set is checked.
      [() => decodeMemorySemanticAdjudication(call([valid, { ...valid, operation: "MAYBE" }]), pair),
        "operation"]
    ] as const) {
      expect(outputViolation(decode)).toBe(`memory_semantic_adjudication_output_invalid_${violation}`);
    }
  });

  it("names the first violated decision invariant in decoder order", () => {
    const input = memorySemanticAdjudicationInput(referenceKindsPlan())!;
    const decode = (decision: unknown) => () =>
      decodeMemorySemanticAdjudication(call([decision]), input);
    const { reason_code: _reason, ...missingReason } = currentUserDecision();
    for (const [decision, violation] of [
      [null, "decision_shape"],
      [missingReason, "decision_shape"],
      [currentUserDecision({ extra: "field" }), "decision_shape"],
      [currentUserDecision({ candidate_ref: "C9" }), "candidate_ref"],
      [currentUserDecision({ candidate_ref: "C 1" }), "candidate_ref"],
      [currentUserDecision({ operation: "MERGE" }), "operation"],
      [currentUserDecision({ operation: 7 }), "operation"],
      [currentUserDecision({ entailment: "MAYBE" }), "enum"],
      [currentUserDecision({ confidence_band: "VERY_HIGH" }), "enum"],
      [currentUserDecision({ assertion_status: "DOUBTFUL" }), "enum"],
      [currentUserDecision({ subject_identity: "OTHER" }), "enum"],
      [currentUserDecision({ subject_scope: "SOMEONE" }), "enum"],
      [currentUserDecision({ temporal_perspective: null }), "enum"],
      [currentUserDecision({ operation: "REINFORCE", target_ref: "F 1" }), "target_ref"],
      [currentUserDecision({ operation: "REINFORCE", target_ref: "M1" }), "target_ref"],
      [currentUserDecision({ operation: "REINFORCE", target_ref: "C1" }), "target_ref"],
      [currentUserDecision({ entity_ref: 3 }), "entity_ref"],
      [currentUserDecision({ entity_ref: "F2" }), "entity_ref"],
      [currentUserDecision({ entity_ref: "M1" }), "entity_ref"],
      [currentUserDecision({ operation: "REINFORCE" }), "operation_target"],
      [currentUserDecision({ target_ref: "F1" }), "operation_target"],
      [currentUserDecision({ operation: "AMBIGUOUS", target_ref: "F1" }), "operation_target"],
      [currentUserDecision({ reason_code: 42 }), "reason_code"],
      [currentUserDecision({ reason_code: null }), "reason_code"],
      [currentUserDecision({ entity_ref: "F1", subject_identity: "SAME_ENTITY" }), "subject_identity"],
      // Ordering: refs and enums are decided before the band can normalize.
      [currentUserDecision({ confidence_band: "LOW", target_ref: "F1" }), "operation_target"],
      [currentUserDecision({ confidence_band: "LOW", entity_ref: "M1" }), "entity_ref"],
      [currentUserDecision({ entailment: "UNKNOWN", operation: "REINFORCE", target_ref: "M1" }), "target_ref"],
      [currentUserDecision({ confidence_band: "LOW", subject_scope: "SOMEONE" }), "enum"],
      [currentUserDecision({ confidence_band: "LOW", reason_code: 42 }), "reason_code"],
      [currentUserDecision({ target_ref: "M1", entity_ref: "M1", operation: "REINFORCE" }), "target_ref"],
      [currentUserDecision({ entity_ref: "M1", operation: "REINFORCE" }), "entity_ref"]
    ] as const) {
      expect(outputViolation(decode(decision)))
        .toBe(`memory_semantic_adjudication_output_invalid_${violation}`);
    }
  });

  it("keeps identity defects fatal at every band", () => {
    const input = memorySemanticAdjudicationInput(relationshipPlan())!;
    const decode = (decision: unknown) => () =>
      decodeMemorySemanticAdjudication(call([decision]), input);
    for (const entailment of ["ENTAILED", "CONTRADICTED", "UNKNOWN"]) {
      for (const confidenceBand of ["HIGH", "MEDIUM", "LOW"]) {
        expect(outputViolation(decode({
          ...subjectIdentityDecision(), confidence_band: confidenceBand, entailment,
          operation: "AMBIGUOUS", target_ref: null
        }))).toBe("memory_semantic_adjudication_output_invalid_subject_identity");
      }
    }
    expect(outputViolation(decode({ ...subjectIdentityDecision(), subject_scope: "CURRENT_USER" })))
      .toBe("memory_semantic_adjudication_output_invalid_subject_identity");
  });

  it("normalizes every non-ENTAILED/HIGH relation decision to authority-free ambiguity", () => {
    const relationship = relationshipPlan();
    const input = memorySemanticAdjudicationInput(relationship)!;
    const observation = input.plan.candidates[0]!;
    const pairs = ["ENTAILED", "CONTRADICTED", "UNKNOWN"].flatMap((entailment) =>
      ["HIGH", "MEDIUM", "LOW"].map((confidenceBand) => ({ confidenceBand, entailment })))
      .filter(({ confidenceBand, entailment }) =>
        confidenceBand !== "HIGH" || entailment !== "ENTAILED");
    expect(pairs).toHaveLength(8);
    const relations = [
      { entity_ref: null, operation: "NO_RELATION", subject_identity: "UNRESOLVED", target_ref: null },
      { entity_ref: "F1", operation: "NO_RELATION", subject_identity: "SAME_ENTITY", target_ref: null },
      ...["REINFORCE", "MERGE_NEW_INTO_TARGET", "MERGE_TARGET_INTO_NEW", "SUPERSEDE_TARGET",
        "MOVE_TO_DISTINCT_FACT", "RETRACT_TARGET"].map((operation) => ({
        entity_ref: "F1", operation, subject_identity: "SAME_ENTITY", target_ref: "F1"
      })),
      { entity_ref: null, operation: "REPLACE_RELATIONSHIP_TARGET",
        subject_identity: "UNRESOLVED", target_ref: "F2" }
    ];
    for (const relation of relations) {
      for (const { confidenceBand, entailment } of pairs) {
        const packet = decodeMemorySemanticAdjudication(call([{
          ...subjectIdentityDecision(), ...relation, confidence_band: confidenceBand, entailment,
          reason_code: "model_label"
        }]), input);
        const decision = packet.decisions[0]!;
        expect(decision).toEqual({
          ...normalizedAmbiguous, assertionStatus: "ASSERTED", candidateRef: "C1",
          confidenceBand, entailment, subjectScope: "USER_RELATIONSHIP_CONTEXT",
          temporalPerspective: "CURRENT"
        });
        expect(memorySemanticAuthorityAdmitsCandidate(
          observation, decision, input.plan.input.contextRefs
        )).toBe(false);
        expect(memoryRelationshipReplacementIsAuthorized(decision)).toBe(false);
        expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
        expect(decodeStoredMemorySemanticAdjudication(encodeStoredMemorySemanticAdjudication(packet)))
          .toEqual(packet);
      }
    }
  });

  it("replaces only an invalid reason label and leaves accepted output byte-identical", () => {
    const input = memorySemanticAdjudicationInput(plan())!;
    const decode = (overrides: Record<string, unknown>) =>
      decodeMemorySemanticAdjudication(call([currentUserDecision(overrides)]), input);
    for (const label of ["новый_факт", "explicit current state", "", "a".repeat(65), "_leading"]) {
      expect(decode({ reason_code: label }).decisions[0]).toMatchObject({
        operation: "NO_RELATION", reasonCode: "normalized_reason_code"
      });
      expect(decode({ confidence_band: "MEDIUM", reason_code: label }).decisions[0])
        .toMatchObject({ ...normalizedAmbiguous, confidenceBand: "MEDIUM" });
    }
    const accepted = decode({ entity_ref: "F1", operation: "REINFORCE", reason_code: "a".repeat(64),
      target_ref: "F1" });
    const expected = [{
      assertionStatus: "ASSERTED", candidateRef: "C1", confidenceBand: "HIGH",
      entailment: "ENTAILED", entityRef: "F1", operation: "REINFORCE", reasonCode: "a".repeat(64),
      subjectIdentity: "UNRESOLVED", subjectScope: "CURRENT_USER", targetRef: "F1",
      temporalPerspective: "CURRENT"
    }] as const;
    expect(accepted.decisions).toEqual(expected);
    expect(Object.keys(accepted.decisions[0]!)).toEqual(Object.keys(expected[0]));
    expect(accepted.outputHash)
      .toBe(memorySemanticAdjudicationOutputHash(input.inputHash, expected));
    const ambiguous = decode({ confidence_band: "LOW", entailment: "UNKNOWN", operation: "AMBIGUOUS",
      reason_code: "unclear" });
    expect(ambiguous.decisions[0]).toMatchObject({
      confidenceBand: "LOW", entailment: "UNKNOWN", operation: "AMBIGUOUS", reasonCode: "unclear"
    });
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, accepted)).toBe(true);
  });

  it("applies the other decisions of a packet with one normalized decision", () => {
    const input = memorySemanticAdjudicationInput(pairPlan())!;
    const packet = decodeMemorySemanticAdjudication(call([
      currentUserDecision({ candidate_ref: "C2", confidence_band: "LOW", entity_ref: "F1",
        operation: "SUPERSEDE_TARGET", target_ref: "F1" }),
      currentUserDecision()
    ]), input);
    expect(packet.decisions.map(({ candidateRef, operation }) => [candidateRef, operation]))
      .toEqual([["C1", "NO_RELATION"], ["C2", "AMBIGUOUS"]]);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[0]!, packet.decisions[0]!, input.plan.input.contextRefs
    )).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[1]!, packet.decisions[1]!, input.plan.input.contextRefs
    )).toBe(false);
  });
});
