import { describe, expect, it } from "vitest";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionInputHash,
  type MemoryFactContextRef,
  type MemoryFactExtractionInput
} from "./contract";
import { decodeMemoryFactExtraction } from "./decoder";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./prompt";

function input(
  text: string,
  contextRefs: readonly MemoryFactContextRef[] = []
): MemoryFactExtractionInput {
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    contextRefs,
    folderId: null,
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-08-24T10:00:00.000Z",
      evidenceEligible: true,
      id: "message-1",
      languageCode: "und",
      role: "user",
      text,
      updatedAt: "2026-08-24T10:00:00.000Z"
    }],
    source: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 1,
      chatId: "chat-1",
      memoryGenerationSnapshot: 0,
      sourceHash: "a".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 1,
      userId: "user-1"
    },
    sourceProjectionHash: "b".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "c".repeat(64),
    timeZone: "Europe/Moscow"
  };
  return { ...withoutHash, inputHash: memoryFactExtractionInputHash(withoutHash) };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    confidence_band: "HIGH",
    correction: false,
    dependency_refs: [],
    entities: [],
    future_useful: true,
    identity: {
      dimension_key: null,
      mode: "SLOT",
      predicate_key: "product_status",
      subject: {
        canonical_label: "MacBook Air",
        entity_type: "DEVICE",
        qualifiers: { brand: "Apple", model: "MacBook Air" }
      }
    },
    memory_type: "EVENT",
    quote: "I bought a MacBook Air.",
    reason_code: "explicit_purchase",
    sensitivity: "NORMAL",
    statement: "The user owns a MacBook Air.",
    temporal: {
      expected_at: null,
      expires_at: null,
      occurred_at: null,
      raw_expression: null,
      valid_from: null,
      valid_to: null
    },
    temporary: false,
    value: {
      frequency: null,
      kind: null,
      limit: null,
      place: null,
      role: null,
      schedule: null,
      state: "owned",
      strength: null,
      value: null
    },
    ...overrides
  };
}

function decode(
  text: string,
  observations: readonly unknown[],
  contextRefs: readonly MemoryFactContextRef[] = []
) {
  return decodeMemoryFactExtraction([{
    arguments: { observations },
    id: "call-1",
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input(text, contextRefs));
}

const macBookContext: MemoryFactContextRef = {
  aliases: ["MacBook Air"],
  displayName: "MacBook Air",
  entityId: "entity-macbook",
  entityType: "DEVICE",
  identitySubjectKey: "device:apple:macbook-air",
  kind: "FACT_VERSION",
  ref: "F1",
  source: {
    contentHash: null,
    factVersionId: "fact-version-macbook",
    messageId: null,
    messageUpdatedAt: null,
    projectionVersion: null
  },
  text: "The user owns a MacBook Air."
};

describe("Memory vNext strict extraction fixtures", () => {
  it.each([
    {
      quote: "I bought a MacBook Air.",
      statement: "The user owns a MacBook Air.",
      text: "I bought a MacBook Air."
    },
    {
      quote: "Я купил MacBook Air.",
      statement: "Пользователь владеет MacBook Air.",
      text: "Я купил MacBook Air."
    }
  ])("creates the same bounded product slot for explicit English/Russian purchase", ({
    quote,
    statement,
    text
  }) => {
    const plan = decode(text, [observation({ quote, statement })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      canonicalKey: "slot:v2:device:apple:macbook-air:product_status:_",
      identityKind: "SLOT",
      identityVersion: "slot-v2",
      predicateKey: "product_status",
      proposedValue: { schema: "product-status-v1", state: "owned" }
    });
  });

  it("accepts a grounded mixed-language ordered state without converting it to owned", () => {
    const quote = "Я ordered a MacBook Air.";
    const plan = decode(quote, [observation({
      memory_type: "EVENT",
      quote,
      statement: "Пользователь заказал MacBook Air.",
      value: {
        ...observation().value as Record<string, unknown>,
        state: "ordered"
      }
    })]);
    expect(plan.candidates[0]?.proposedValue).toEqual({
      schema: "product-status-v1",
      state: "ordered"
    });
  });

  it("rejects setup, hypothetical, third-party, quoted and assistant ownership claims", () => {
    for (const text of [
      "How do I configure a MacBook Air?",
      "If I bought a MacBook Air, would it work?",
      "My brother owns a MacBook Air.",
      "My friend said, \"I bought a MacBook Air.\"",
      "Assistant: I bought a MacBook Air."
    ]) {
      const plan = decode(text, [observation({
        quote: text.includes("friend said") ? "I bought a MacBook Air." : text,
        statement: "The user owns a MacBook Air."
      })]);
      expect(plan.candidates).toEqual([]);
      expect(plan.rejections).toEqual([{
        candidateOrdinal: 0,
        reasonCode: "REJECT_UNSUPPORTED"
      }]);
    }
  });

  it("keeps borrowed/work/shared states separate and rejects an unsupported owned claim", () => {
    const borrowed = "I borrowed a MacBook Air.";
    const accepted = decode(borrowed, [observation({
      quote: borrowed,
      statement: "The user borrowed a MacBook Air.",
      value: {
        ...observation().value as Record<string, unknown>,
        state: "borrowed"
      }
    })]);
    expect(accepted.candidates[0]?.proposedValue).toMatchObject({
      state: "borrowed"
    });

    const rejected = decode("This is my work MacBook Air.", [observation({
      quote: "This is my work MacBook Air.",
      statement: "The user owns a MacBook Air."
    })]);
    expect(rejected.candidates).toEqual([]);

    const hallucinatedSubject = decode("I bought a phone.", [observation({
      quote: "I bought a phone.",
      statement: "The user owns a MacBook Air."
    })]);
    expect(hallucinatedSubject.candidates).toEqual([]);
  });

  it("rejects a correction while no durable dependency ref is supplied", () => {
    const text = "Actually, I prefer tea.";
    const plan = decode(text, [observation({
      correction: true,
      identity: {
        dimension_key: "topic:drink",
        mode: "SLOT",
        predicate_key: "preference",
        subject: {
          canonical_label: null,
          entity_type: "PERSON_SELF",
          qualifiers: { brand: null, model: null }
        }
      },
      memory_type: "PREFERENCE",
      quote: text,
      statement: "The user prefers tea.",
      value: {
        ...observation().value as Record<string, unknown>,
        state: null,
        strength: "normal",
        value: "tea"
      }
    })]);
    expect(plan.candidates).toEqual([]);
  });

  it("accepts a single supplied pronoun antecedent and keeps the pronoun out of aliases", () => {
    const text = "I got it yesterday.";
    const plan = decode(text, [observation({
      dependency_refs: ["F1"],
      entities: [{
        aliases: [],
        canonical_label: null,
        context_entity_ref: "F1",
        entity_type: "DEVICE",
        mention: "it",
        role: "SUBJECT"
      }],
      quote: text,
      statement: "The user received the MacBook Air yesterday.",
      value: {
        ...observation().value as Record<string, unknown>,
        state: "owned"
      }
    })], [macBookContext]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      dependencies: [{
        dependencyKind: "COREFERENCE_ANTECEDENT",
        ref: "F1",
        source: { factVersionId: "fact-version-macbook" }
      }],
      entities: [{
        aliases: [],
        canonicalLabel: "MacBook Air",
        contextEntityId: "entity-macbook",
        contextRef: "F1",
        mention: "it"
      }]
    });
  });

  it("rejects unsupplied, undeclared, and pronoun-alias dependency claims", () => {
    const text = "I got it yesterday.";
    const contextualEntity = {
      aliases: [],
      canonical_label: null,
      context_entity_ref: "F1",
      entity_type: "DEVICE",
      mention: "it",
      role: "SUBJECT"
    };
    expect(decode(text, [observation({
      dependency_refs: ["F1"],
      entities: [contextualEntity],
      quote: text
    })]).candidates).toEqual([]);
    expect(decode(text, [observation({
      dependency_refs: [],
      entities: [contextualEntity],
      quote: text
    })], [macBookContext]).candidates).toEqual([]);
    expect(decode(text, [observation({
      dependency_refs: ["F1"],
      entities: [{ ...contextualEntity, aliases: ["it"] }],
      quote: text
    })], [macBookContext]).candidates).toEqual([]);
    expect(decode(text, [observation({
      dependency_refs: ["F1", "F2"],
      entities: [contextualEntity],
      quote: text
    })], [macBookContext, {
      ...macBookContext,
      entityId: "entity-other-device",
      ref: "F2",
      source: {
        contentHash: null,
        factVersionId: "fact-version-other-device",
        messageId: null,
        messageUpdatedAt: null,
        projectionVersion: null
      }
    }]).candidates).toEqual([]);
  });

  it("isolates invalid siblings and resolves an exact explicit TTL", () => {
    const text = "Remember this until Friday: I prefer tea. I bought a MacBook Air.";
    const plan = decode(text, [
      observation({
        identity: {
          dimension_key: "topic:tea",
          mode: "SLOT",
          predicate_key: "preference",
          subject: {
            canonical_label: null,
            entity_type: "PERSON_SELF",
            qualifiers: { brand: null, model: null }
          }
        },
        memory_type: "PREFERENCE",
        quote: "Remember this until Friday: I prefer tea.",
        statement: "The user prefers tea.",
        temporal: {
          expected_at: null,
          expires_at: null,
          occurred_at: null,
          raw_expression: "Remember this until Friday",
          valid_from: null,
          valid_to: null
        },
        value: {
          ...observation().value as Record<string, unknown>,
          state: null,
          strength: "normal",
          value: "tea"
        }
      }),
      observation({
        quote: "not present",
        statement: "Invalid sibling."
      })
    ]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      expiresAt: "2026-08-28T21:00:00.000Z",
      predicateKey: "preference"
    });
    expect(plan.rejections).toEqual([{
      candidateOrdinal: 1,
      reasonCode: "REJECT_UNSUPPORTED"
    }]);
  });

  it("does not copy a TTL from another observation in the same message", () => {
    const text = "Remember the code until Friday. I bought a MacBook Air.";
    const plan = decode(text, [observation({
      quote: "I bought a MacBook Air.",
      statement: "The user owns a MacBook Air."
    })]);
    expect(plan.rejections).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      expiresAt: null,
      rawTemporalExpression: null
    });

    const forged = decode(text, [observation({
      quote: "I bought a MacBook Air.",
      statement: "The user owns a MacBook Air.",
      temporal: {
        expected_at: null,
        expires_at: null,
        occurred_at: null,
        raw_expression: "until Friday",
        valid_from: null,
        valid_to: null
      }
    })]);
    expect(forged.candidates).toEqual([]);
  });
});
