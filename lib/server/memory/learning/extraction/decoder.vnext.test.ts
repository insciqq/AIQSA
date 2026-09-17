import { describe, expect, it } from "vitest";
import { MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE } from "../../../../contracts/memory";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  type MemoryFactContextRef,
  type MemoryFactExtractionInput
} from "./contract";
import { decodeMemoryFactExtraction } from "./decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import {
  memoryCandidateRequiresSemanticAdjudication,
  memorySemanticAuthorityAdmitsCandidate
} from "./adjudication";
import { memoryPropositionCanonicalKey } from "../identity/normalization";

function input(
  text: string,
  contextRefs: readonly MemoryFactContextRef[] = [],
  redactionSpans: readonly Readonly<{ endOffset: number; startOffset: number }>[] = [],
  priorMessages: readonly Readonly<{
    id: string;
    role: "assistant" | "user";
    text: string;
  }>[] = [],
  languageCode: MemoryFactExtractionInput["messages"][number]["languageCode"] = "und"
): MemoryFactExtractionInput {
  const source = {
    activeLeafMessageId: "assistant-1",
    branchGeneration: 1,
    chatId: "chat-1",
    memoryGenerationSnapshot: 1,
    sourceHash: "a".repeat(64),
    sourceMessageId: "message-1",
    sourceRevision: 1,
    userId: "user-1"
  };
  return {
    contextRefs,
    folderId: null,
    identityProfile: "UNICODE_V2",
    inputHash: "b".repeat(64),
    messages: [...priorMessages.map((message, index) => ({
      contentHash: memorySha256(message.text),
      createdAt: `2026-08-25T09:0${index}:00.000Z`,
      evidenceEligible: false,
      id: message.id,
      languageCode: "und" as const,
      redactionSpans: [],
      role: message.role,
      text: message.text,
      updatedAt: `2026-08-25T09:0${index}:00.000Z`
    })), {
      contentHash: memorySha256(text),
      createdAt: "2026-08-25T10:00:00.000Z",
      evidenceEligible: true,
      id: source.sourceMessageId,
      languageCode,
      redactionSpans,
      role: "user",
      text,
      updatedAt: "2026-08-25T10:00:00.000Z"
    }],
    source,
    sourceProjectionHash: "c".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "d".repeat(64),
    timeZone: "UTC"
  };
}

const textRef = (text: string, occurrenceIndex = 0) => ({
  occurrence_index: occurrenceIndex,
  text
});

const nullValue = {
  frequency: null,
  kind: null,
  limit: null,
  place: null,
  role: null,
  schedule: null,
  state: null,
  strength: null,
  value: null
};

const frame = {
  assertion_status: "ASSERTED",
  change_intent: "NONE",
  memory_directive: "NONE",
  polarity: "AFFIRMED",
  speech_act: "ASSERTION",
  subject_scope: "CURRENT_USER",
  temporal_perspective: "CURRENT"
};

function observation(
  quote: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    candidate_ref: "C1",
    confidence_band: "HIGH",
    dependency_refs: [],
    entities: [],
    evidence: textRef(quote),
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
    reason_code: "explicit_fact",
    semantic_frame: frame,
    sensitivity: "NORMAL",
    statement: "An explicit source-grounded fact.",
    temporal: {
      expiration_intent: "NONE",
      normalization: { kind: "NONE" },
      perspective: "CURRENT",
      raw_expression: null
    },
    temporary: false,
    value: nullValue,
    ...overrides
  };
}

function productObservation(
  quote: string,
  state = "owned",
  candidateRef = "C1"
): Record<string, unknown> {
  return observation(quote, {
    candidate_ref: candidateRef,
    entities: [{
      aliases: [],
      canonical_label: "MacBook Air M4",
      context_entity_ref: null,
      entity_type: "DEVICE",
      mention: textRef("MacBook Air M4"),
      mention_kind: "NAMED",
      qualifier_supports: [{
        key: "model",
        source: textRef("MacBook Air M4"),
        value: "MacBook Air M4"
      }],
      role: "SUBJECT"
    }],
    identity: {
      dimension_key: null,
      mode: "SLOT",
      predicate_key: "product_status",
      subject: {
        canonical_label: "MacBook Air M4",
        entity_type: "DEVICE",
        qualifiers: { brand: null, model: "MacBook Air M4" }
      }
    },
    statement: "The current user has the proposed product state.",
    value: { ...nullValue, state }
  });
}

function personalContextObservation(
  quote: string,
  input: Readonly<{
    confidenceBand?: "HIGH" | "MEDIUM";
    entityType: "OTHER" | "PERSON";
    name: string;
    sensitivity?: "NORMAL" | "SENSITIVE";
    statement: string;
  }>
): Record<string, unknown> {
  return observation(quote, {
    confidence_band: input.confidenceBand ?? "HIGH",
    entities: [{
      aliases: [textRef(input.name)],
      canonical_label: input.name,
      context_entity_ref: null,
      entity_type: input.entityType,
      mention: textRef(input.name),
      mention_kind: "NAMED",
      qualifier_supports: [],
      role: "SUBJECT"
    }],
    semantic_frame: {
      ...frame,
      subject_scope: "USER_RELATIONSHIP_CONTEXT"
    },
    sensitivity: input.sensitivity ?? "NORMAL",
    statement: input.statement
  });
}

function decode(
  sourceText: string,
  observations: readonly unknown[],
  contextRefs: readonly MemoryFactContextRef[] = [],
  redactionSpans: readonly Readonly<{ endOffset: number; startOffset: number }>[] = [],
  priorMessages: readonly Readonly<{
    id: string;
    role: "assistant" | "user";
    text: string;
  }>[] = [],
  languageCode: MemoryFactExtractionInput["messages"][number]["languageCode"] = "und"
) {
  return decodeMemoryFactExtraction([{
    arguments: { observations },
    id: "call-1",
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input(sourceText, contextRefs, redactionSpans, priorMessages, languageCode));
}

describe("Memory v5 semantic-frame decoder", () => {
  describe("optional entity annotations on direct propositions", () => {
    const quote = "My Oriole workshop is on 2027-02-08.";
    const entity = {
      aliases: [], canonical_label: "Oriole", context_entity_ref: null,
      entity_type: "PROJECT", mention: textRef("Oriole"), mention_kind: "NAMED",
      qualifier_supports: [], role: "SUBJECT"
    };
    const scheduled = (overrides: Record<string, unknown> = {}) => observation(quote, {
      memory_type: "PLAN", statement: quote,
      semantic_frame: { ...frame, temporal_perspective: "FUTURE" },
      temporal: {
        expiration_intent: "NONE", perspective: "FUTURE",
        normalization: { kind: "ABSOLUTE", local_date: "2027-02-08", local_time: null, zone: null },
        raw_expression: textRef("2027-02-08")
      },
      ...overrides
    });

    it.each(["mention", "alias", "qualifier"])("requires semantic authority after dropping an unsupported %s", (kind) => {
      const annotation = {
        ...entity,
        ...(kind === "mention" ? { mention: textRef("Oriole", 1) } : {}),
        ...(kind === "alias" ? { aliases: [textRef("Oriole workshop", 1)] } : {}),
        ...(kind === "qualifier" ? { qualifier_supports: [{
          key: "model", source: textRef("advanced"), value: "advanced"
        }] } : {})
      };
      const proposed = scheduled({ entities: [annotation] });
      const plan = decode(quote, [proposed]);
      expect(plan.rejections).toEqual([]);
      expect(plan.candidates).toHaveLength(1);
      const candidate = plan.candidates[0]!;
      expect(candidate).toMatchObject({
        entities: [], entityAnnotationReviewRequired: true, identityKind: "PROPOSITION",
        expectedAt: "2027-02-08T00:00:00.000Z", statement: quote
      });
      const direct = decode(quote, [scheduled()]).candidates[0]!;
      expect(candidate.id).toBe(direct.id);
      const withSupportedPeer = decode(quote, [scheduled({ entities: [entity, annotation] })]);
      expect(withSupportedPeer.candidates[0]?.entities).toEqual(
        decode(quote, [scheduled({ entities: [entity] })]).candidates[0]?.entities
      );
      expect(memoryCandidateRequiresSemanticAdjudication(direct)).toBe(false);
      expect(memoryCandidateRequiresSemanticAdjudication(candidate)).toBe(true);
      expect(memorySemanticAuthorityAdmitsCandidate(candidate, null)).toBe(false);
      const decision = {
        assertionStatus: "ASSERTED" as const, candidateRef: candidate.candidateRef,
        confidenceBand: "HIGH" as const, entailment: "ENTAILED" as const,
        entityRef: null, operation: "NO_RELATION" as const, reasonCode: "direct_schedule",
        subjectScope: "CURRENT_USER" as const, targetRef: null, temporalPerspective: "FUTURE" as const
      };
      expect(memorySemanticAuthorityAdmitsCandidate(candidate, decision)).toBe(true);
      for (const denied of [
        { ...decision, subjectScope: "UNKNOWN" as const },
        { ...decision, subjectScope: "THIRD_PARTY" as const },
        { ...decision, assertionStatus: "QUOTED" as const },
        { ...decision, entailment: "CONTRADICTED" as const },
        { ...decision, confidenceBand: "MEDIUM" as const }
      ]) expect(memorySemanticAuthorityAdmitsCandidate(candidate, denied)).toBe(false);
      expect(memorySemanticAuthorityAdmitsCandidate({
        ...candidate, confidenceBand: "MEDIUM", confidence: MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE
      }, decision)).toBe(false);
      expect(decode(quote, [{ ...proposed, confidence_band: "MEDIUM" }]).candidates).toEqual([]);
    });

    it.each(["entity", "qualifier"])("retains a discarded annotation's %s source dependency", (kind) => {
      const context: MemoryFactContextRef = {
        aliases: [], displayName: "Oriole", entityId: "entity-1", entityType: "PROJECT",
        identitySubjectKey: "project:oriole", kind: "FACT_VERSION", ref: "F1",
        source: { contentHash: null, factVersionId: "version-1", messageId: null,
          messageUpdatedAt: null, projectionVersion: null },
        text: "The user is organizing the Oriole workshop."
      };
      const proposed = scheduled({ entities: [{
        ...entity, mention: textRef("Oriole", 1),
        context_entity_ref: kind === "entity" ? "F1" : null,
        qualifier_supports: kind === "qualifier" ? [{
          key: "organizer", source: { context_ref: "F1" }, value: "current user"
        }] : []
      }] });
      const plan = decode(quote, [proposed], [context]);
      expect(plan.rejections).toEqual([]);
      expect(plan.candidates[0]).toMatchObject({
        entities: [], entityAnnotationReviewRequired: true,
        dependencies: [{ dependencyKind: "TEMPORAL_CONTEXT", ref: "F1", source: context.source }]
      });
      expect(decode(quote, [proposed]).candidates).toEqual([]);
    });

    it("rejects malformed annotations and authority-bearing omissions even after an unresolved mention", () => {
      for (const override of [
        { mention: { text: "Oriole", occurrence_index: -1 } },
        { mention: textRef("Oriole", 1), aliases: [{ text: "Oriole" }] },
        { mention: textRef("Oriole", 1), canonical_label: 7 },
        { mention: textRef("Oriole", 1), entity_type: "PERSON", role: "OBJECT" },
        { mention: textRef("Oriole", 1), mention_kind: "PRONOMINAL" },
        { mention: textRef("Oriole", 1), qualifier_supports: [{
          key: "organizer", source: { context_ref: "UNSUPPLIED" }, value: "current user"
        }] }
      ]) expect(decode(quote, [scheduled({ entities: [{ ...entity, ...override }] })]).candidates).toEqual([]);
      expect(decode(quote, [scheduled({
        evidence: textRef(quote, 1), entities: [{ ...entity, mention: textRef("Oriole", 1) }]
      })]).candidates).toEqual([]);
      const productQuote = "I own a MacBook Air M4.";
      const product = productObservation(productQuote);
      expect(decode(productQuote, [{
        ...product, entities: (product.entities as Record<string, unknown>[]).map((item) => ({
          ...item, mention: textRef("MacBook Air M4", 1)
        }))
      }]).candidates).toEqual([]);
    });
  });

  it("[E01] preserves repeated exact occurrences with UTF-16 offsets", () => {
    const quote = "🙂e\u0301 fact";
    const source = `${quote} / ${quote}`;
    const plan = decode(source, [observation(quote, {
      evidence: textRef(quote, 1)
    })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]?.evidence[0]).toMatchObject({
      endOffset: source.lastIndexOf(quote) + quote.length,
      quote,
      startOffset: source.lastIndexOf(quote)
    });
    expect(source.slice(
      plan.candidates[0]!.evidence[0]!.startOffset,
      plan.candidates[0]!.evidence[0]!.endOffset
    )).toBe(quote);
  });

  it("rejects only candidates whose exact evidence intersects a redacted span", () => {
    const safeQuote = "I moved to Helsinki";
    const placeholder = "[REDACTED:TOKEN]";
    const source = `${safeQuote}; token ${placeholder}.`;
    const startOffset = source.indexOf(placeholder);
    const plan = decode(source, [
      observation(safeQuote, { candidate_ref: "C1" }),
      observation(placeholder, {
        candidate_ref: "C2",
        statement: "The current user supplied a token."
      })
    ], [], [{ endOffset: startOffset + placeholder.length, startOffset }]);

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.evidence[0]?.quote).toBe(safeQuote);
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 1,
      reasonCode: "REJECT_SECRET"
    }]);
  });

  it.each(["AFFIRMED", "NEGATED"] as const)("admits direct non-secret personal testimony labeled SENSITIVE with %s polarity", (polarity) => {
    const quote = polarity === "AFFIRMED"
      ? "I use a hearing aid."
      : "I do not use a hearing aid.";
    const plan = decode(quote, [observation(quote, {
      semantic_frame: { ...frame, polarity },
      sensitivity: "SENSITIVE",
      statement: quote
    })]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      evidence: [{ quote }],
      semanticFrame: { polarity, subjectScope: "CURRENT_USER" },
      sensitivity: "NORMAL",
      statement: quote
    });
    if (polarity === "NEGATED") {
      expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
      expect(memorySemanticAuthorityAdmitsCandidate(plan.candidates[0]!, null)).toBe(false);
    }
  });

  it.each([
    ["SECRET", "REJECT_SECRET"],
    ["UNCERTAIN", "REJECT_UNSUPPORTED"]
  ])("keeps the %s classification fence", (sensitivity, reasonCode) => {
    const quote = "I use a hearing aid.";
    const plan = decode(quote, [observation(quote, { sensitivity, statement: quote })]);
    expect(plan.candidates).toEqual([]);
    expect(plan.rejections).toEqual([{ candidateOrdinal: 0, reasonCode }]);
  });

  it("does not admit a sensitive hypothetical as direct testimony", () => {
    const quote = "I might need a hearing aid.";
    const plan = decode(quote, [observation(quote, {
      semantic_frame: { ...frame, assertion_status: "HYPOTHETICAL" },
      sensitivity: "SENSITIVE",
      statement: quote
    })]);
    expect(plan.candidates).toEqual([]);
    expect(plan.rejections).toHaveLength(1);
  });

  it.each(["NORMAL", "SENSITIVE"])("rejects a recognized secret hallucinated inside a %s structured value", (sensitivity) => {
    const quote = "I prefer tea.";
    const token = `sk-${"a1".repeat(16)}`;
    const plan = decode(quote, [observation(quote, {
      sensitivity,
      value: { ...nullValue, value: token }
    })]);

    expect(plan.candidates).toEqual([]);
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 0,
      reasonCode: "REJECT_SECRET"
    }]);
  });

  it.each([
    "Omistan MacBook Air M4 nyt.",
    "Ahora tengo MacBook Air M4.",
    "現在はMacBook Air M4を所有しています。",
    "Сейчас у меня MacBook Air M4.",
    "I currently own MacBook Air M4.",
    "yo щас hav MacBook Air M4!!!"
  ])("[E01] applies identical code policy to multilingual/noisy packets", (quote) => {
    const plan = decode(quote, [productObservation(quote)]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      identityKind: "SLOT",
      predicateKey: "product_status",
      proposedValue: { schema: "product-status-v1", state: "owned" }
    });
    expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
  });

  it.each([
    { assertion_status: "CONDITIONAL" },
    { assertion_status: "HYPOTHETICAL" },
    { assertion_status: "QUOTED" },
    { speech_act: "QUESTION" },
    { subject_scope: "THIRD_PARTY" },
    { subject_scope: "ASSISTANT" }
  ])("[E01] rejects non-authoritative frames without reading punctuation", (change) => {
    const quote = "opaque source without diagnostic punctuation";
    const plan = decode(quote, [observation(quote, {
      semantic_frame: { ...frame, ...change }
    })]);
    expect(plan.candidates).toEqual([]);
    expect(plan.rejections).toHaveLength(1);
  });

  it("[E01] executes the Finnish, Spanish, Japanese and mixed-language set", () => {
    const finnish = "Asun Turussa.";
    const residence = decode(finnish, [observation(finnish, {
      entities: [{
        aliases: [],
        canonical_label: "Turku",
        context_entity_ref: null,
        entity_type: "PLACE",
        mention: textRef("Turussa"),
        mention_kind: "NAMED",
        qualifier_supports: [{
          key: "canonical_place",
          source: textRef("Turussa"),
          value: "Turku"
        }],
        role: "OBJECT"
      }],
      identity: {
        dimension_key: "primary",
        mode: "SLOT",
        predicate_key: "residence",
        subject: {
          canonical_label: null,
          entity_type: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      },
      statement: "The current user has a primary residence in Turku.",
      value: { ...nullValue, kind: "primary", place: "Turku" }
    })]);
    expect(residence.candidates[0]).toMatchObject({
      dimensionKey: "primary",
      identityKind: "SLOT",
      predicateKey: "residence",
      proposedValue: { kind: "primary", schema: "residence-v1" }
    });

    const spanish = "Ahora tengo un MacBok Air M4.";
    const acquired = productObservation(spanish) as Record<string, unknown>;
    acquired.entities = [{
      aliases: [],
      canonical_label: "MacBook Air M4",
      context_entity_ref: null,
      entity_type: "PRODUCT",
      mention: textRef("MacBok Air M4"),
      mention_kind: "NAMED",
      qualifier_supports: [{
        key: "model",
        source: textRef("MacBok Air M4"),
        value: "MacBook Air M4"
      }],
      role: "SUBJECT"
    }];
    const product = decode(spanish, [acquired]);
    expect(product.candidates[0]).toMatchObject({
      identityKind: "SLOT",
      predicateKey: "product_status",
      proposedValue: { state: "owned" }
    });

    const japanese = "MacBook Air M4を設定したらどうなりますか。";
    const conditional = productObservation(japanese) as Record<string, unknown>;
    conditional.semantic_frame = {
      ...frame,
      assertion_status: "CONDITIONAL",
      speech_act: "QUESTION"
    };
    expect(decode(japanese, [conditional]).candidates).toEqual([]);

    const mixed = "Prefiero concise technical ответы.";
    const preference = decode(mixed, [observation(mixed, {
      memory_type: "PREFERENCE",
      statement: "The current user prefers concise technical answers."
    })]);
    expect(preference.candidates).toHaveLength(1);
    expect(preference.candidates[0]).toMatchObject({
      category: "preferences",
      identityKind: "PROPOSITION"
    });
  });

  it("[E02] rejects five ownership false positives and admits one direct statement", () => {
    const framed = (
      source: string,
      semanticFrame: Record<string, unknown>
    ) => {
      const proposed = productObservation(source) as Record<string, unknown>;
      proposed.semantic_frame = { ...frame, ...semanticFrame };
      return decode(source, [proposed]);
    };
    expect(framed("How do I set up MacBook Air M4?", {
      speech_act: "QUESTION"
    }).candidates).toEqual([]);
    expect(framed("My colleague owns MacBook Air M4.", {
      subject_scope: "THIRD_PARTY"
    }).candidates).toEqual([]);
    expect(framed("If I bought MacBook Air M4, I would travel more.", {
      assertion_status: "HYPOTHETICAL"
    }).candidates).toEqual([]);
    expect(framed("The sample says I own MacBook Air M4.", {
      assertion_status: "QUOTED"
    }).candidates).toEqual([]);
    expect(decode(
      "I got a discount recommendation for MacBook Air M4.",
      []
    ).candidates).toEqual([]);

    const directText = "Ik bezit nu MacBook Air M4.";
    const direct = decode(directText, [productObservation(directText)]);
    expect(direct.candidates).toHaveLength(1);
    expect(direct.candidates[0]).toMatchObject({
      predicateKey: "product_status",
      proposedValue: { state: "owned" }
    });
    expect(memoryCandidateRequiresSemanticAdjudication(direct.candidates[0]!))
      .toBe(true);
  });

  it("routes authority-critical UNKNOWN to adjudication", () => {
    const quote = "opaque source";
    const plan = decode(quote, [observation(quote, {
      semantic_frame: { ...frame, subject_scope: "UNKNOWN" }
    })]);
    expect(plan.candidates).toHaveLength(1);
    expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
  });

  it("admits direct ordinary current-user relationship context", () => {
    const quote = "My spouse is Alex.";
    const plan = decode(quote, [observation(quote, {
      entities: [{
        aliases: [textRef("Alex")],
        canonical_label: "Alex",
        context_entity_ref: null,
        entity_type: "PERSON",
        mention: textRef("Alex"),
        mention_kind: "NAMED",
        qualifier_supports: [],
        role: "SUBJECT"
      }],
      memory_type: "STATE",
      statement: "The current user's spouse is Alex."
    })]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      directness: "DIRECT",
      entities: [expect.objectContaining({
        canonicalLabel: "Alex",
        entityType: "PERSON",
        mention: "Alex",
        role: "SUBJECT"
      })],
      identityKind: "PROPOSITION",
      sensitivity: "NORMAL",
      statement: "The current user's spouse is Alex."
    });
  });

  it.each([
    {
      entityType: "PERSON" as const,
      name: "Ana",
      quote: "My sister Ana works at Juniper bakery.",
      statement: "The current user reports that their sister Ana works at Juniper bakery."
    },
    {
      entityType: "OTHER" as const,
      name: "Pepper",
      quote: "My dog Pepper cannot use stairs during rehabilitation.",
      sensitivity: "SENSITIVE" as const,
      statement: "The current user reports that their dog Pepper cannot use stairs during rehabilitation."
    },
    {
      entityType: "PERSON" as const,
      name: "Noor",
      quote: "My colleague Noor has a rotating schedule.",
      statement: "The current user reports that their colleague Noor has a rotating schedule."
    }
  ])("admits grounded ordinary personal context without turning $name into the user", (sample) => {
    const plan = decode(sample.quote, [personalContextObservation(sample.quote, sample)]);
    expect(plan.rejections).toEqual([]);
    const retained = plan.candidates[0]!;
    expect(retained).toMatchObject({
      entities: [expect.objectContaining({
        canonicalLabel: sample.name,
        entityType: sample.entityType,
        role: "SUBJECT"
      })],
      identityKind: "PROPOSITION",
      sensitivity: "NORMAL",
      subjectKey: null
    });
    expect(memoryCandidateRequiresSemanticAdjudication(retained)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(retained, {
      assertionStatus: "ASSERTED",
      candidateRef: retained.candidateRef,
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "NO_RELATION",
      reasonCode: "ordinary_personal_context",
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      targetRef: null,
      temporalPerspective: "CURRENT"
    })).toBe(true);
  });

  it("retains the user's attributed report as supporting personal context", () => {
    const quote = "My brother Milo told me he works night shifts.";
    const plan = decode(quote, [personalContextObservation(quote, {
      confidenceBand: "MEDIUM",
      entityType: "PERSON",
      name: "Milo",
      statement: "The current user reports that their brother Milo told them he works night shifts."
    })]);
    const retained = plan.candidates[0]!;
    expect(retained).toMatchObject({
      confidence: MEMORY_SUPPORTING_OBSERVATION_CONFIDENCE,
      confidenceBand: "MEDIUM",
      identityKind: "PROPOSITION",
      statement: expect.stringContaining("Milo told them")
    });
    expect(memorySemanticAuthorityAdmitsCandidate(retained, {
      assertionStatus: "ASSERTED",
      candidateRef: retained.candidateRef,
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "NO_RELATION",
      reasonCode: "attributed_personal_context",
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      targetRef: null,
      temporalPerspective: "CURRENT"
    })).toBe(true);
  });

  it("keeps the user's activity and related place in current-user scope", () => {
    const quote = "My pottery class meets at Riverside Studio on Tuesdays.";
    const plan = decode(quote, [observation(quote, {
      entities: [{
        aliases: [textRef("Riverside Studio")],
        canonical_label: "Riverside Studio",
        context_entity_ref: null,
        entity_type: "PLACE",
        mention: textRef("Riverside Studio"),
        mention_kind: "NAMED",
        qualifier_supports: [],
        role: "OBJECT"
      }],
      memory_type: "PLAN",
      statement: "The current user's pottery class meets at Riverside Studio on Tuesdays."
    })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      identityKind: "PROPOSITION",
      semanticFrame: { subjectScope: "CURRENT_USER" }
    });
  });

  it("fails closed for standalone third-party material and ungrounded relationship subjects", () => {
    const external = "Public bio: 'Milo works night shifts.'";
    const quoted = personalContextObservation(external, {
      entityType: "PERSON",
      name: "Milo",
      statement: "Milo works night shifts."
    });
    quoted.semantic_frame = {
      ...frame,
      assertion_status: "QUOTED",
      subject_scope: "THIRD_PARTY"
    };
    expect(decode(external, [quoted]).candidates).toEqual([]);

    const arbitrary = personalContextObservation(
      "Milo works night shifts.",
      { entityType: "PERSON", name: "Milo", statement: "Milo works night shifts." }
    );
    arbitrary.semantic_frame = { ...frame, subject_scope: "THIRD_PARTY" };
    expect(decode("Milo works night shifts.", [arbitrary]).candidates).toEqual([]);

    const unresolved = personalContextObservation(
      "He works night shifts.",
      { entityType: "PERSON", name: "He", statement: "He works night shifts." }
    );
    unresolved.entities = [{
      aliases: [], canonical_label: null, context_entity_ref: null,
      entity_type: "PERSON", mention: textRef("He"), mention_kind: "PRONOMINAL",
      qualifier_supports: [], role: "SUBJECT"
    }];
    expect(decode("He works night shifts.", [unresolved]).candidates).toEqual([]);

    const nonSelfSlot = productObservation("My colleague Noor owns MacBook Air M4.");
    nonSelfSlot.semantic_frame = { ...frame, subject_scope: "USER_RELATIONSHIP_CONTEXT" };
    expect(decode("My colleague Noor owns MacBook Air M4.", [nonSelfSlot]).candidates)
      .toEqual([]);
  });

  it("keeps a source-language profession as an open-world proposition", () => {
    const quote = "Я работаю девопсом.";
    const plan = decode(quote, [observation(quote, {
      identity: {
        dimension_key: null,
        mode: "SLOT",
        predicate_key: "employment_status",
        subject: {
          canonical_label: null,
          entity_type: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      },
      memory_type: "STATE",
      statement: "Пользователь работает девопсом.",
      value: { ...nullValue, role: "девопс", state: "current" }
    })], [], [], [], "ru");

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      category: "work",
      displayText: "Пользователь работает девопсом.",
      identityKind: "PROPOSITION",
      languageCode: "ru",
      predicateKey: null,
      proposedValue: {
        normalizedStatement: "пользователь работает девопсом.",
        schema: "generic-fact-v1"
      },
      subjectKey: null
    });
  });

  it("keeps MEDIUM output as a disjoint supporting proposition", () => {
    const quote = "I usually choose cedar for document layouts.";
    const statement = "The current user usually chooses cedar for document layouts.";
    const plan = decode(quote, [observation(quote, {
      confidence_band: "MEDIUM",
      identity: {
        dimension_key: "format:document layout",
        mode: "SLOT",
        predicate_key: "preference",
        subject: {
          canonical_label: null,
          entity_type: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      },
      memory_type: "PREFERENCE",
      statement,
      value: { ...nullValue, value: "cedar" }
    })]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      confidence: 0.6,
      confidenceBand: "MEDIUM",
      coreEligible: false,
      coreSalience: "NONE",
      identityKind: "PROPOSITION",
      predicateKey: null,
      proposedValue: {
        authority: "supporting",
        schema: "supporting-observation-v1"
      },
      subjectKey: null
    });
    expect(plan.candidates[0]?.canonicalKey)
      .not.toBe(memoryPropositionCanonicalKey(statement));
    expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!))
      .toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate(plan.candidates[0]!, null))
      .toBe(true);
  });

  it("retains all eight independent observations from one bounded packet", () => {
    const statements = [
      "I prefer early meetings.",
      "I prefer short emails.",
      "I prefer tea without sugar.",
      "I prefer quiet offices.",
      "I prefer written instructions.",
      "I prefer weekly planning.",
      "I prefer dark editor themes.",
      "I prefer numbered checklists."
    ];
    const observations = statements.map((statement, index) => observation(statement, {
      candidate_ref: `C${index + 1}`,
      memory_type: "PREFERENCE",
      statement
    }));
    const plan = decode(statements.join(" "), observations);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates.map(({ statement }) => statement)).toEqual(statements);
    expect(plan.candidateOrdinals).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(() => decode(statements.join(" "), [...observations, observations[0]!]))
      .toThrow();
  });

  it.each(["entities", "aliases", "qualifier_supports"] as const)(
    "enforces the local %s limit even when the provider schema omits maxItems",
    (field) => {
      const quote = "I own a MacBook Air M4.";
      const proposed = productObservation(quote);
      const entity = (proposed.entities as Record<string, unknown>[])[0]!;
      const limit = field === "entities" ? 6 : 4;
      const value = field === "entities" ? entity : field === "aliases"
        ? textRef("MacBook Air M4")
        : { key: "model", source: textRef("MacBook Air M4"), value: "MacBook Air M4" };
      const withCount = (count: number) => ({
        ...proposed,
        entities: field === "entities" ? Array.from({ length: count }, () => value)
          : [{ ...entity, [field]: Array.from({ length: count }, () => value) }]
      });
      expect(decode(quote, [withCount(limit)])).toMatchObject({
        candidates: [expect.anything()], rejections: []
      });
      expect(decode(quote, [withCount(limit + 1)])).toMatchObject({
        candidates: [], rejections: [expect.objectContaining({ candidateOrdinal: 0 })]
      });
    }
  );

  it("enforces the local dependency limit with otherwise valid supplied references", () => {
    const quote = "I prefer short emails.";
    const refs: MemoryFactContextRef[] = Array.from({ length: 4 }, (_, index) => ({
      aliases: [], displayName: null, entityId: null, entityType: null,
      identitySubjectKey: null, kind: "MESSAGE", ref: `M${index + 1}`,
      source: {
        contentHash: "a".repeat(64), factVersionId: null, messageId: `prior-${index + 1}`,
        messageUpdatedAt: "2026-08-25T09:00:00.000Z", projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
      },
      text: "Prior user context."
    }));
    const withCount = (count: number) => observation(quote, {
      dependency_refs: refs.slice(0, count).map(({ ref }) => ref), statement: quote
    });
    expect(decode(quote, [withCount(3)], refs)).toMatchObject({
      candidates: [expect.objectContaining({ dependencies: expect.any(Array) })], rejections: []
    });
    expect(decode(quote, [withCount(4)], refs)).toMatchObject({
      candidates: [], rejections: [expect.objectContaining({ candidateOrdinal: 0 })]
    });
  });

  it("rejects LOW output and MEDIUM correction semantics", () => {
    const quote = "I usually choose cedar.";
    const result = decode(quote, [
      observation(quote, { candidate_ref: "C1", confidence_band: "LOW" }),
      observation(quote, {
        candidate_ref: "C2",
        confidence_band: "MEDIUM",
        semantic_frame: {
          ...frame,
          change_intent: "CORRECTION",
          polarity: "CORRECTION"
        }
      })
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.rejections).toEqual([
      { candidateOrdinal: 0, reasonCode: "REJECT_LOW_CONFIDENCE" },
      { candidateOrdinal: 1, reasonCode: "REJECT_UNSUPPORTED" }
    ]);
  });

  it.each([
    ["I do not drink coffee.", "The user does not drink coffee."],
    ["Я не пью кофе.", "Пользователь не пьёт кофе."]
  ])("retains an asserted negative proposition only after semantic review: %s", (quote, statement) => {
    const plan = decode(quote, [observation(quote, {
      memory_type: "PREFERENCE",
      semantic_frame: { ...frame, polarity: "NEGATED" },
      statement
    })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    const candidate = plan.candidates[0]!;
    expect(candidate).toMatchObject({
      correction: false,
      identityKind: "PROPOSITION",
      semanticFrame: { polarity: "NEGATED" },
      statement
    });
    expect(memoryCandidateRequiresSemanticAdjudication(candidate)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, null)).toBe(false);
    const admitted = {
      assertionStatus: "ASSERTED",
      candidateRef: candidate.candidateRef,
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "NO_RELATION",
      reasonCode: "direct_negative_assertion",
      subjectScope: "CURRENT_USER",
      targetRef: null,
      temporalPerspective: "CURRENT"
    } as const;
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, admitted)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, {
      ...admitted, entailment: "CONTRADICTED"
    })).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, {
      ...admitted, confidenceBand: "MEDIUM"
    })).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, {
      ...admitted, assertionStatus: "HYPOTHETICAL"
    })).toBe(false);
  });

  it("retains a negative SLOT proposal as a proposition requiring full semantic review", () => {
    const quote = "I do not own a MacBook Air M4.";
    const statement = "The user does not own a MacBook Air M4.";
    const result = decode(quote, [{
      ...productObservation(quote, "owned", "C1"),
      semantic_frame: { ...frame, polarity: "NEGATED" },
      statement
    }]);
    expect(result.rejections).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      identityKind: "PROPOSITION",
      predicateKey: null,
      semanticFrame: { polarity: "NEGATED" },
      statement
    });
    expect(result.candidates[0]!.proposedValue).not.toHaveProperty("state");
    expect(memoryCandidateRequiresSemanticAdjudication(result.candidates[0]!)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(result.candidates[0]!, null)).toBe(false);
  });

  it("admits a pure withdrawal only with exact retraction adjudication", () => {
    const quote = "I withdraw my cedar layout preference.";
    const plan = decode(quote, [observation(quote, {
      memory_type: "PREFERENCE",
      semantic_frame: {
        ...frame,
        change_intent: "RETRACTION",
        polarity: "RETRACTION"
      },
      statement: "The user withdraws the cedar layout preference."
    })]);
    expect(plan.rejections).toEqual([]);
    const candidate = plan.candidates[0]!;
    expect(candidate).toMatchObject({
      identityKind: "PROPOSITION",
      semanticFrame: {
        changeIntent: "RETRACTION",
        polarity: "RETRACTION",
        temporalPerspective: "CURRENT"
      }
    });
    expect(memoryCandidateRequiresSemanticAdjudication(candidate)).toBe(true);
    const decision = {
      assertionStatus: "ASSERTED",
      candidateRef: candidate.candidateRef,
      confidenceBand: "HIGH",
      entailment: "ENTAILED",
      entityRef: null,
      operation: "RETRACT_TARGET",
      reasonCode: "pure_withdrawal",
      subjectScope: "CURRENT_USER",
      targetRef: "F1",
      temporalPerspective: "CURRENT"
    } as const;
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, decision)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, {
      ...decision,
      operation: "SUPERSEDE_TARGET"
    })).toBe(false);
    for (const temporalPerspective of ["FORMER", "FUTURE"] as const) {
      expect(memorySemanticAuthorityAdmitsCandidate({
        ...candidate,
        semanticFrame: { ...candidate.semanticFrame, temporalPerspective }
      }, { ...decision, temporalPerspective })).toBe(false);
    }
    expect(memorySemanticAuthorityAdmitsCandidate({
      ...candidate,
      semanticFrame: { ...candidate.semanticFrame, polarity: "AFFIRMED" }
    }, decision)).toBe(false);
  });

  it("does not admit negative questions, quoted claims or weak testimony", () => {
    const quote = "I do not own a MacBook Air M4.";
    const negative = { ...frame, polarity: "NEGATED" };
    const result = decode(quote, [
      observation(quote, {
        candidate_ref: "C1", semantic_frame: { ...negative, speech_act: "QUESTION" }
      }),
      observation(quote, {
        candidate_ref: "C2", semantic_frame: { ...negative, assertion_status: "QUOTED" }
      }),
      observation(quote, {
        candidate_ref: "C3", confidence_band: "MEDIUM", semantic_frame: negative
      })
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.rejections).toHaveLength(3);
  });

  it.each([
    ["My desk is on floor two. Correction: my desk is on floor five.", "The current user's desk is on floor five."],
    ["Мой рабочий стол на втором этаже. Исправляю: мой рабочий стол на пятом этаже.", "Рабочий стол текущего пользователя находится на пятом этаже."]
  ])("admits a self-contained correction while retaining semantic review: %s", (quote, statement) => {
    const plan = decode(quote, [observation(quote, {
      semantic_frame: { ...frame, change_intent: "CORRECTION", polarity: "CORRECTION" },
      statement
    })]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ correction: true, dependencies: [], statement });
    expect(plan.candidates[0]?.evidence).toEqual([
      expect.objectContaining({ messageId: "message-1", quote, startOffset: 0, endOffset: quote.length })
    ]);
    expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(plan.candidates[0]!, null)).toBe(false);
  });

  it("uses assistant context only through a dependency, never as evidence", () => {
    const assistantText = "Cedar is your preferred layout option.";
    const target = "Yes, cedar is my preferred option.";
    const context: MemoryFactContextRef = {
      aliases: [],
      displayName: null,
      entityId: null,
      entityType: null,
      identitySubjectKey: null,
      kind: "MESSAGE",
      ref: "M1",
      source: {
        contentHash: memorySha256(assistantText),
        factVersionId: null,
        messageId: "assistant-prior",
        messageUpdatedAt: "2026-08-25T09:00:00.000Z",
        projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
      },
      text: assistantText
    };
    const accepted = decode(target, [observation(target, {
      confidence_band: "MEDIUM",
      dependency_refs: ["M1"],
      memory_type: "PREFERENCE",
      statement: "The current user prefers cedar as a layout option."
    })], [context], [], [{
      id: "assistant-prior",
      role: "assistant",
      text: assistantText
    }]);
    expect(accepted.candidates[0]?.dependencies).toEqual([
      expect.objectContaining({ ref: "M1", source: context.source })
    ]);
    expect(accepted.candidates[0]?.evidence[0]?.messageId).toBe("message-1");

    const assistantOnly = decode(target, [observation(assistantText)], [context], [], [{
      id: "assistant-prior",
      role: "assistant",
      text: assistantText
    }]);
    expect(assistantOnly.candidates).toEqual([]);
    expect(assistantOnly.rejections).toEqual([{
      candidateOrdinal: 0,
      reasonCode: "REJECT_UNSUPPORTED"
    }]);
  });

  it.each([false, true])("retains structural PRONOMINAL context with correction=%s and never writes it as an alias", (correction) => {
    const quote = "it is returned";
    const context: MemoryFactContextRef = {
      aliases: ["MacBook"],
      displayName: "MacBook Air M4",
      entityId: "entity-1",
      entityType: "DEVICE",
      identitySubjectKey: "device:macbook-air-m4",
      kind: "FACT_VERSION",
      ref: "F1",
      source: {
        contentHash: null,
        factVersionId: "version-1",
        messageId: null,
        messageUpdatedAt: null,
        projectionVersion: null
      },
      text: "bounded context"
    };
    const proposed = productObservation(quote, "returned") as Record<string, unknown>;
    if (correction) proposed.semantic_frame = { ...frame, change_intent: "CORRECTION", polarity: "CORRECTION" };
    proposed.dependency_refs = ["F1"];
    proposed.entities = [{
      aliases: [],
      canonical_label: null,
      context_entity_ref: "F1",
      entity_type: "DEVICE",
      mention: textRef("it"),
      mention_kind: "PRONOMINAL",
      qualifier_supports: [{
        key: "model",
        source: { context_ref: "F1" },
        value: "MacBook Air M4"
      }],
      role: "SUBJECT"
    }];
    const plan = decode(quote, [proposed], [context]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]?.entities[0]).toMatchObject({
      aliases: [],
      contextEntityId: "entity-1",
      mention: "it",
      mentionKind: "PRONOMINAL"
    });
    expect(plan.candidates[0]?.dependencies[0]).toMatchObject({
      dependencyKind: correction ? "CORRECTION_TARGET" : "COREFERENCE_ANTECEDENT",
      ref: "F1"
    });
    const derived = decode(quote, [{ ...proposed, dependency_refs: [] }], [context]);
    expect(derived.rejections).toEqual([]);
    expect(derived.candidates[0]?.dependencies).toEqual(plan.candidates[0]?.dependencies);
    expect(derived.candidates[0]?.id).toBe(plan.candidates[0]?.id);
    expect(decode(quote, [{ ...proposed, dependency_refs: [] }]).candidates).toEqual([]);
  });

  it.each([false, true].flatMap(correction =>
    ["PRONOMINAL", "ELLIPSIS"].map(mentionKind => ({ correction, mentionKind }))))(
    "keeps one $mentionKind antecedent separate from its source with correction=$correction",
    ({ correction, mentionKind }) => {
      const quote = mentionKind === "PRONOMINAL" ? "It starts at noon." : "Starts at noon.";
      const context: MemoryFactContextRef = {
        aliases: [], displayName: "Oriole", entityId: "entity-oriole",
        entityType: "PROJECT", identitySubjectKey: null, kind: "FACT_VERSION", ref: "F1",
        source: { contentHash: null, factVersionId: "version-oriole", messageId: null,
          messageUpdatedAt: null, projectionVersion: null },
        text: "Oriole is my workshop."
      };
      const prior: MemoryFactContextRef = {
        aliases: [], displayName: null, entityId: null, entityType: null,
        identitySubjectKey: null, kind: "MESSAGE", ref: "M1",
        source: { contentHash: memorySha256(context.text), factVersionId: null,
          messageId: "prior-message", messageUpdatedAt: "2026-08-13T00:00:00.000Z",
          projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION },
        text: context.text
      };
      const entity = {
        aliases: [], canonical_label: null, context_entity_ref: "F1",
        entity_type: "PROJECT", mention: mentionKind === "PRONOMINAL" ? textRef("It") : null,
        mention_kind: mentionKind, qualifier_supports: [], role: "SUBJECT"
      };
      const proposed = observation(quote, {
        dependency_refs: ["M1"], entities: [entity],
        semantic_frame: { ...frame,
          change_intent: correction ? "CORRECTION" : "NONE",
          polarity: correction ? "CORRECTION" : "AFFIRMED" },
        statement: "The user's Oriole workshop starts at noon."
      });
      const plan = decode(quote, [proposed], [context, prior]);
      expect(plan.rejections).toEqual([]);
      expect(plan.candidates[0]?.dependencies).toEqual([
        { dependencyKind: "COREFERENCE_ANTECEDENT", ref: "F1", source: context.source },
        { dependencyKind: correction ? "CORRECTION_TARGET" : "RELATION_CONTEXT",
          ref: "M1", source: prior.source }
      ]);
      for (const declared of [["M1", "F1"], ["F1", "M1"]]) {
        const repeated = decode(quote, [{ ...proposed, dependency_refs: declared }], [context, prior]);
        expect(repeated.candidates).toEqual(plan.candidates);
        expect(repeated.rejections).toEqual([]);
      }
      expect(memorySemanticAuthorityAdmitsCandidate(plan.candidates[0]!, null)).toBe(false);
      expect(decode(quote, [proposed], [context]).candidates).toEqual([]);

      const other: MemoryFactContextRef = { ...context, ref: "F2", entityId: "entity-peer",
        source: { contentHash: null, factVersionId: "version-peer", messageId: null,
          messageUpdatedAt: null, projectionVersion: null } };
      expect(decode(quote, [{ ...proposed, entities: [entity,
        { ...entity, context_entity_ref: "F2" }] }], [context, prior, other]).candidates)
        .toEqual([]);
    }
  );

  it("keeps one correction source separate from the named subject context", () => {
    const quote = "My sister Ren now teaches drawing.";
    const context: MemoryFactContextRef = {
      aliases: [], displayName: "Ren", entityId: "entity-ren",
      entityType: "PERSON", identitySubjectKey: null, kind: "FACT_VERSION", ref: "F1",
      source: { contentHash: null, factVersionId: "version-ren", messageId: null,
        messageUpdatedAt: null, projectionVersion: null },
      text: "My sister Ren teaches music."
    };
    const prior: MemoryFactContextRef = {
      aliases: [], displayName: null, entityId: null, entityType: null,
      identitySubjectKey: null, kind: "MESSAGE", ref: "M1",
      source: { contentHash: memorySha256(context.text), factVersionId: null,
        messageId: "prior-message", messageUpdatedAt: "2026-08-13T00:00:00.000Z",
        projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION },
      text: context.text
    };
    const proposed = observation(quote, {
      statement: quote, dependency_refs: ["M1"],
      semantic_frame: { ...frame, subject_scope: "USER_RELATIONSHIP_CONTEXT",
        change_intent: "CORRECTION", polarity: "CORRECTION" },
      entities: [{ aliases: [], canonical_label: "Ren", context_entity_ref: "F1",
        entity_type: "PERSON", mention: textRef("Ren"), mention_kind: "NAMED",
        qualifier_supports: [], role: "SUBJECT" }]
    });
    const plan = decode(quote, [proposed], [context, prior]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      correction: true,
      dependencies: [
        { dependencyKind: "RELATION_CONTEXT", ref: "F1", source: context.source },
        { dependencyKind: "CORRECTION_TARGET", ref: "M1", source: prior.source }
      ],
      entities: [{ contextEntityId: "entity-ren", role: "SUBJECT" }]
    });
    expect(memoryCandidateRequiresSemanticAdjudication(plan.candidates[0]!)).toBe(true);
    for (const declared of [["M1", "F1"], ["F1", "M1"]]) {
      const repeated = decode(quote, [{ ...proposed, dependency_refs: declared }], [context, prior]);
      expect(repeated.candidates).toEqual(plan.candidates);
      expect(repeated.rejections).toEqual([]);
    }
    const otherSource: MemoryFactContextRef = { ...prior, ref: "M2",
      source: { contentHash: memorySha256(context.text), factVersionId: null,
        messageId: "other-prior-message", messageUpdatedAt: "2026-08-13T00:00:00.000Z",
        projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION } };
    expect(decode(quote, [{ ...proposed, dependency_refs: ["M1", "M2", "F1"] }],
      [context, prior, otherSource]).candidates).toEqual([]);
    expect(decode(quote, [proposed], [context]).candidates).toEqual([]);
  });

  it.each(["entity", "qualifier"])("closes %s context dependencies without repeated provider bookkeeping", (referenceKind) => {
    const quote = "My Helix project uses phased delivery.";
    const context = (ref: string): MemoryFactContextRef => ({
      aliases: [], displayName: "Helix", entityId: `entity-${ref}`,
      entityType: "PROJECT", identitySubjectKey: "project:helix", kind: "FACT_VERSION", ref,
      source: {
        contentHash: null, factVersionId: `version-${ref}`, messageId: null,
        messageUpdatedAt: null, projectionVersion: null
      },
      text: "The user's Helix project has a delivery plan."
    });
    const refs = [context("F1"), context("F2")];
    const proposed = observation(quote, {
      dependency_refs: ["F1"], statement: quote,
      entities: [{
        aliases: [], canonical_label: "Helix",
        context_entity_ref: referenceKind === "entity" ? "F2" : null,
        entity_type: "PROJECT", mention: textRef("Helix"), mention_kind: "NAMED",
        qualifier_supports: referenceKind === "qualifier" ? [{
          key: "delivery_context", source: { context_ref: "F2" }, value: "delivery plan"
        }] : [],
        role: "SUBJECT"
      }]
    });
    const closed = decode(quote, [proposed], refs);
    expect(closed.rejections).toEqual([]);
    const candidate = closed.candidates[0]!;
    expect(candidate.dependencies).toEqual(refs.map(({ ref, source }) => ({
      dependencyKind: "RELATION_CONTEXT", ref, source
    })));
    const repeated = decode(quote, [{ ...proposed, dependency_refs: ["F2", "F1"] }], refs);
    expect(repeated.candidates[0]?.id).toBe(candidate.id);
    expect(memoryCandidateRequiresSemanticAdjudication(candidate)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, null)).toBe(false);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, {
      assertionStatus: "ASSERTED", candidateRef: candidate.candidateRef,
      confidenceBand: "HIGH", entailment: "ENTAILED", entityRef: null,
      operation: "NO_RELATION", reasonCode: "unresolved_subject",
      subjectScope: "UNKNOWN", targetRef: null, temporalPerspective: "CURRENT"
    })).toBe(false);
    expect(decode(quote, [proposed], refs.slice(0, 1)).candidates).toEqual([]);
    expect(decode(quote, [{ ...proposed, dependency_refs: ["UNSUPPLIED"] }], refs).candidates).toEqual([]);
    expect(decode(quote, [{ ...proposed, dependency_refs: ["F1", "F1"] }], refs).candidates).toEqual([]);
    expect(decode(quote, [{ ...proposed, dependency_refs: ["F1", "F3", "F4"] }], [
      ...refs, context("F3"), context("F4")
    ]).candidates).toEqual([]);
  });

  it("accepts a direct current-user PERSON_SELF pronoun without a context dependency", () => {
    const quote = "I consistently prefer concise technical answers.";
    const proposed = observation(quote, {
      entities: [{
        aliases: [],
        canonical_label: "current user",
        context_entity_ref: null,
        entity_type: "PERSON_SELF",
        mention: textRef("I"),
        mention_kind: "PRONOMINAL",
        qualifier_supports: [],
        role: "SUBJECT"
      }],
      memory_type: "PREFERENCE",
      statement: "The current user prefers concise technical answers."
    });
    const plan = decode(quote, [proposed]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      category: "preferences",
      dependencies: [],
      entities: [],
      identityKind: "PROPOSITION"
    });
  });

  it("ignores a self-name PERSON_SELF object annotation when identity agrees", () => {
    const name = "Алина-abcdefghijkl";
    const quote = `Меня зовут ${name}.`;
    const proposed = observation(quote, {
      entities: [{
        aliases: [textRef(name)],
        canonical_label: name,
        context_entity_ref: null,
        entity_type: "PERSON_SELF",
        mention: textRef(name),
        mention_kind: "NAMED",
        qualifier_supports: [],
        role: "OBJECT"
      }],
      identity: {
        dimension_key: "name",
        mode: "SLOT",
        predicate_key: null,
        subject: {
          canonical_label: name,
          entity_type: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      },
      statement: `The current user's name is ${name}.`
    });
    const plan = decode(quote, [proposed]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      entities: [],
      identityKind: "PROPOSITION",
      predicateKey: null
    });
  });

  it("does not accept PERSON_SELF as a non-subject entity", () => {
    const quote = "opaque source";
    const proposed = observation(quote, {
      entities: [{
        aliases: [],
        canonical_label: "current user",
        context_entity_ref: null,
        entity_type: "PERSON_SELF",
        mention: textRef("opaque"),
        mention_kind: "NOMINAL",
        qualifier_supports: [],
        role: "OBJECT"
      }]
    });
    const plan = decode(quote, [proposed]);

    expect(plan.candidates).toEqual([]);
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 0,
      reasonCode: "REJECT_UNSUPPORTED"
    }]);
  });

  it.each([
    ["project_status", "PROJECT", null],
    ["project_status", "PROJECT", "unsupported-classifier-label"],
    ["goal_status", "GOAL", null],
    ["goal_status", "GOAL", "unsupported-classifier-label"]
  ])("retains an ungrounded %s/%s/%s proposal only with proposition authority", (predicate, entityType, label) => {
    const quote = "My workshop is scheduled for 2026-10-05.";
    const common = {
      memory_type: "PLAN", statement: quote,
      semantic_frame: { ...frame, temporal_perspective: "FUTURE" },
      temporal: {
        expiration_intent: "NONE", perspective: "FUTURE",
        normalization: { kind: "ABSOLUTE", local_date: "2026-10-05", local_time: null, zone: null },
        raw_expression: textRef("2026-10-05")
      }
    };
    const plan = decode(quote, [observation(quote, {
      ...common,
      identity: {
        dimension_key: null, mode: "SLOT", predicate_key: predicate,
        subject: { canonical_label: label, entity_type: entityType, qualifiers: { brand: null, model: null } }
      },
      value: { ...nullValue, state: "planned" }
    })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    const candidate = plan.candidates[0]!;
    expect(candidate).toMatchObject({
      identityKind: "PROPOSITION", proposedIdentityKind: "SLOT",
      subjectKey: null, predicateKey: null, dimensionKey: null,
      expectedAt: "2026-10-05T00:00:00.000Z", expiresAt: null
    });
    expect(JSON.stringify(candidate.proposedValue)).not.toContain("unsupported-classifier-label");
    expect(memoryCandidateRequiresSemanticAdjudication(candidate)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, null)).toBe(false);
    const decision = {
      assertionStatus: "ASSERTED" as const, candidateRef: candidate.candidateRef,
      confidenceBand: "HIGH" as const, entailment: "ENTAILED" as const,
      entityRef: null, operation: "NO_RELATION" as const, reasonCode: "direct_plan",
      subjectScope: "CURRENT_USER" as const, targetRef: null, temporalPerspective: "FUTURE" as const
    };
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, decision)).toBe(true);
    expect(memorySemanticAuthorityAdmitsCandidate(candidate, { ...decision, entailment: "CONTRADICTED" })).toBe(false);
    const direct = decode(quote, [observation(quote, common)]).candidates[0]!;
    expect(candidate.id).toBe(direct.id);
  });

  it.each([
    ["PLAN", "FUTURE", "My workshop is scheduled for 2026-10-05.", "2026-10-05"],
    ["STATE", "CURRENT", "My remote assignment lasts through the autumn.", null],
    ["EVENT", "EVENT", "I attended a training session on 2026-08-20.", "2026-08-20"]
  ])("retains future-useful temporary %s testimony without inventing expiration", (memoryType, perspective, quote, date) => {
    const temporal = {
      expiration_intent: "NONE", perspective,
      normalization: date === null ? { kind: "NONE" }
        : { kind: "ABSOLUTE", local_date: date, local_time: null, zone: null },
      raw_expression: date === null ? null : textRef(date)
    };
    const proposed = observation(quote!, {
      memory_type: memoryType, statement: quote, temporary: true,
      semantic_frame: { ...frame, temporal_perspective: perspective }, temporal
    });
    const plan = decode(quote!, [proposed]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ expiresAt: null, statement: quote, modality: memoryType });
    expect(decode(quote!, [{ ...proposed, future_useful: false }]).candidates).toEqual([]);
    expect(decode(quote!, [{ ...proposed, temporal: {
      expiration_intent: "EXPLICIT", perspective, normalization: { kind: "NONE" }, raw_expression: null
    } }]).candidates).toEqual([]);
  });

  it("resolves only the structured explicit TTL operation", () => {
    const quote = "opaque fact ttl-token";
    const plan = decode(quote, [observation(quote, {
      temporary: true,
      temporal: {
        expiration_intent: "EXPLICIT",
        normalization: { amount: 3, kind: "CALENDAR_OFFSET", unit: "DAY" },
        perspective: "CURRENT",
        raw_expression: textRef("ttl-token")
      }
    })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      displayText: "An explicit source-grounded fact.",
      expiresAt: "2026-08-28T10:00:00.000Z",
      rawTemporalExpression: "ttl-token"
    });
  });

  it("adds a grounded absolute event date while retaining the source wording", () => {
    const quote = "The launch happened yesterday.";
    const plan = decode(quote, [observation(quote, {
      memory_type: "EVENT",
      semantic_frame: { ...frame, temporal_perspective: "EVENT" },
      statement: "The launch happened yesterday.",
      temporal: {
        expiration_intent: "NONE",
        normalization: { amount: -1, kind: "CALENDAR_OFFSET", unit: "DAY" },
        perspective: "EVENT",
        raw_expression: textRef("yesterday")
      }
    })]);

    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      displayText: "The launch happened yesterday. [event_date=2026-08-24]",
      occurredAt: "2026-08-24T10:00:00.000Z",
      rawTemporalExpression: "yesterday"
    });
  });

  it("isolates malformed siblings and duplicate candidate refs", () => {
    const quote = "one durable fact";
    const plan = decode(quote, [
      observation(quote),
      observation(quote, { statement: "second", unexpected: true }),
      observation(quote)
    ]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.rejections).toEqual([
      { candidateOrdinal: 1, reasonCode: "REJECT_UNSUPPORTED" },
      { candidateOrdinal: 2, reasonCode: "REJECT_UNSUPPORTED" }
    ]);
  });

  it("rejects non-machine candidate refs before adjudication", () => {
    const quote = "one durable fact";
    const result = decode(quote, [observation(quote, {
      candidate_ref: "candidate with spaces"
    })]);
    expect(result.candidates).toEqual([]);
    expect(result.rejections).toEqual([
      { candidateOrdinal: 0, reasonCode: "REJECT_UNSUPPORTED" }
    ]);
  });
});
