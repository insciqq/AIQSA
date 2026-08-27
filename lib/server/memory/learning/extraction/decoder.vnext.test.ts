import { describe, expect, it } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import type {
  MemoryFactContextRef,
  MemoryFactExtractionInput
} from "./contract";
import { decodeMemoryFactExtraction } from "./decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";
import { memoryCandidateRequiresSemanticAdjudication } from "./adjudication";

function input(
  text: string,
  contextRefs: readonly MemoryFactContextRef[] = []
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
    inputHash: "b".repeat(64),
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-25T10:00:00.000Z",
      evidenceEligible: true,
      id: source.sourceMessageId,
      languageCode: "und",
      role: "user",
      text,
      updatedAt: "2026-08-25T10:00:00.000Z"
    }],
    source,
    sourceProjectionHash: "c".repeat(64),
    sourceProjectionVersion: "memory-fact-source-projection-v4",
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

function decode(
  sourceText: string,
  observations: readonly unknown[],
  contextRefs: readonly MemoryFactContextRef[] = []
) {
  return decodeMemoryFactExtraction([{
    arguments: { observations },
    id: "call-1",
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input(sourceText, contextRefs));
}

describe("Memory v5 semantic-frame decoder", () => {
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

  it("uses structural PRONOMINAL context and never writes it as an alias", () => {
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
      dependencyKind: "COREFERENCE_ANTECEDENT",
      ref: "F1"
    });
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
