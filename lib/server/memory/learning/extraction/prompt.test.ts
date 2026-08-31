import { describe, expect, it } from "vitest";
import {
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  type MemoryFactExtractionInput
} from "./contract";
import {
  MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT,
  memoryFactExtractionPromptPayload,
  memoryFactExtractionTool
} from "./prompt";
import { MEMORY_PREFERENCE_DIMENSION_PREFIXES } from "../identity/registry";
import { memorySha256 } from "../../persistence/lexical";

describe("Memory semantic-frame extraction prompt", () => {
  it("locks the v5 forced-strict wire shape under the current prompt policy", () => {
    expect(MEMORY_FACT_EXTRACTION_PROMPT_VERSION)
      .toBe("memory-fact-extraction-prompt-v29");
    expect(MEMORY_FACT_EXTRACTION_SCHEMA_VERSION)
      .toBe("memory-fact-extraction-schema-v5");
    expect(memoryFactExtractionTool).toMatchObject({
      name: "submit_memory_fact_observations_v5",
      strict: true
    });
    const observation = (memoryFactExtractionTool.inputSchema as {
      properties: { observations: { items: { properties: Record<string, unknown> } } };
    }).properties.observations.items.properties;
    expect(Object.keys(observation).sort()).toEqual([
      "candidate_ref", "confidence_band", "dependency_refs", "entities",
      "evidence", "future_useful", "identity", "memory_type", "reason_code",
      "semantic_frame", "sensitivity", "statement", "temporal", "temporary",
      "value"
    ]);
  });

  it("makes semantic authority and exact occurrences explicit", () => {
    for (const rule of [
      "zero-based exact occurrence index",
      "target_message is the only evidence",
      "same language as target_message",
      "never translate it into English",
      "exact evidence text must by itself entail the complete statement",
      "subject, semantic relation, object or value, recipient",
      "assistant-role context message is never user testimony",
      "copy that item's opaque context_ref into dependency_refs",
      "zero-based ordinal among identical exact-text matches",
      "never a character offset",
      "language-neutral semantic_frame",
      "the name value is not a separate PERSON_SELF object or alias",
      "question, condition, hypothesis, quotation",
      "must produce one HIGH-confidence observation",
      "synthetic-looking, hyphenated, non-Latin",
      "memory_type STATE, confidence_band HIGH, future_useful true",
      "Put X in value.value, use value.kind name and value.state known",
      "Apply this semantic rule language-neutrally",
      "predicate_key product_status",
      "Set value.state to owned and every other value field to null",
      "must exactly equal the entity_type and canonical_label",
      "never leave identity.subject.canonical_label null",
      "Every non-null identity.subject brand or model qualifier",
      "same key and value plus an exact source occurrence",
      "full exact mention as canonical_label with null brand and model qualifiers",
      "mere neighboring product mention is never direct ownership",
      "Preserve agent, possessor, recipient, beneficiary",
      "does not establish that the CURRENT_USER owns or keeps that item",
      "must use the product_status SLOT shape above, never PROPOSITION",
      "one residence SLOT observation",
      "predicate_key residence, dimension_key primary",
      "value.place to the grounded PLACE canonical label",
      "qualifier_supports key canonical_place",
      "one PREFERENCE observation",
      "One direct target message is sufficient",
      "never require repetition or cross-chat corroboration",
      "Preserve the most specific source-grounded object and scope",
      "unscoped rhetorical, comparative, or evaluative self-description",
      "no concrete object, domain, dimension, behavior, or preferred value",
      "taste or selectiveness are not themselves a preference value",
      "limited to a local choice or episode",
      "MEDIUM PROPOSITION",
      "never promote it to a HIGH SLOT or global profile fact",
      "use identity mode SLOT with subject PERSON_SELF",
      "predicate_key preference",
      "Positive preference SLOT anchor",
      "do not downgrade it to PROPOSITION",
      "value.value to the explicitly preferred value",
      "never infer or manufacture a missing preference dimension",
      "does not explicitly supply a stable category, format, interaction, or topic dimension",
      "preserve the preference meaning and its exact scope",
      "never invent a SLOT dimension",
      "MEDIUM observation must use PROPOSITION identity",
      "cannot propose a SLOT, current-state change, or override",
      "named third party as a distinct PERSON entity with role SUBJECT",
      "profession, employment role, or work identity remains eligible",
      "cannot form an employment_status SLOT",
      "structured temporal normalization",
      "target_message.created_at in time_zone",
      "preserving the exact original wording",
      "PRONOMINAL, ELLIPSIS, UNKNOWN",
      "no prose or hidden rationale"
    ]) {
      expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(rule);
    }
    for (const prefix of MEMORY_PREFERENCE_DIMENSION_PREFIXES) {
      expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT)
        .toContain(`${prefix}:<grounded dimension>`);
    }
  });

  it("labels prior message refs without duplicating them as evidence refs", () => {
    const priorText = "The assistant suggested cedar.";
    const targetText = "Yes, cedar is my preferred option.";
    const source = {
      activeLeafMessageId: "assistant-current",
      branchGeneration: 1,
      chatId: "chat-1",
      memoryGenerationSnapshot: 1,
      sourceHash: "a".repeat(64),
      sourceMessageId: "user-current",
      sourceRevision: 1,
      userId: "user-1"
    };
    const input: MemoryFactExtractionInput = {
      contextRefs: [{
        aliases: [],
        displayName: null,
        entityId: null,
        entityType: null,
        identitySubjectKey: null,
        kind: "MESSAGE",
        ref: "M1",
        source: {
          contentHash: memorySha256(priorText),
          factVersionId: null,
          messageId: "assistant-prior",
          messageUpdatedAt: "2026-08-27T09:00:00.000Z",
          projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
        },
        text: priorText
      }, {
        aliases: ["Cedar"],
        displayName: "Cedar choice",
        entityId: "entity-1",
        entityType: "OTHER",
        identitySubjectKey: null,
        kind: "FACT_VERSION",
        ref: "F1",
        source: {
          contentHash: null,
          factVersionId: "version-1",
          messageId: null,
          messageUpdatedAt: null,
          projectionVersion: null
        },
        text: "The current saved option is cedar."
      }],
      folderId: null,
      identityProfile: "UNICODE_V2",
      inputHash: "b".repeat(64),
      messages: [{
        contentHash: memorySha256(priorText),
        createdAt: "2026-08-27T09:00:00.000Z",
        evidenceEligible: false,
        id: "assistant-prior",
        languageCode: "en",
        redactionSpans: [],
        role: "assistant",
        text: priorText,
        updatedAt: "2026-08-27T09:00:00.000Z"
      }, {
        contentHash: memorySha256(targetText),
        createdAt: "2026-08-27T10:00:00.000Z",
        evidenceEligible: true,
        id: source.sourceMessageId,
        languageCode: "en",
        redactionSpans: [],
        role: "user",
        text: targetText,
        updatedAt: "2026-08-27T10:00:00.000Z"
      }],
      source,
      sourceProjectionHash: "c".repeat(64),
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      suppressionIdentitySnapshot: "d".repeat(64),
      timeZone: "UTC"
    };

    const payload = JSON.parse(memoryFactExtractionPromptPayload(input)) as {
      context_after: unknown[];
      context_before: Array<{ context_ref: string; role: string; text: string }>;
      supplied_context_refs: Array<{ kind: string; ref: string }>;
      target_message: { context_ref: null; text: string };
    };
    expect(payload.context_before).toEqual([expect.objectContaining({
      context_ref: "M1",
      role: "assistant",
      text: priorText
    })]);
    expect(payload.context_after).toEqual([]);
    expect(payload.supplied_context_refs).toEqual([
      expect.objectContaining({ kind: "FACT_VERSION", ref: "F1" })
    ]);
    expect(payload.target_message).toMatchObject({
      context_ref: null,
      text: targetText
    });
  });
});
