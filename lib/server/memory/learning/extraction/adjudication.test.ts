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
  memorySemanticAdjudicationTool,
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

describe("batched Memory semantic adjudication", () => {
  it("makes new-fact ref nullability explicit without weakening the decoder", () => {
    expect(MEMORY_SEMANTIC_ADJUDICATION_PROMPT_VERSION)
      .toBe("memory-semantic-adjudication-prompt-v12");
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
      entity_ref: null,
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
          entailment: "ENTAILED", entity_ref: entityRef, operation, reason_code: "direct_continuation",
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
        entailment: "ENTAILED", entity_ref: null, operation: "NO_RELATION",
        reason_code: "direct_continuation", subject_scope: "CURRENT_USER",
        target_ref: null, temporal_perspective: "CURRENT"
      }] }, id: "call", name: MEMORY_SEMANTIC_ADJUDICATION_TOOL_NAME
    }], input);
    expect(memorySemanticAdjudicationPacketIsValid(input.plan, packet)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(
      input.plan.candidates[0]!, packet.decisions[0]!, input.plan.input.contextRefs
    )).toBe(true);
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
