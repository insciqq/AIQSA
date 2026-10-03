import { describe, expect, it } from "vitest";
import {
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
  MEMORY_FACT_MAX_TARGET_CHARACTERS,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactTargetView,
  type MemoryFactExtractionInput
} from "./contract";
import {
  MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT,
  memoryFactExtractionPromptPayload,
  memoryFactExtractionTool
} from "./prompt";
import { MEMORY_PREFERENCE_DIMENSION_PREFIXES } from "../identity/registry";
import { MEMORY_LONG_TERM_USEFULNESS_GUIDANCE } from "../../../../domain/memory/usefulness";
import {
  MEMORY_ASSERTED_PLAN_GUIDANCE,
  MEMORY_FACT_EXTRACTION_PLAN_GUIDANCE,
  MEMORY_PERSONAL_SUBJECT_SCOPE_GUIDANCE
} from "./contract";
import { MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT } from "./adjudication";
import { memorySha256 } from "../../persistence/lexical";

describe("Memory semantic-frame extraction prompt", () => {
  it("locks the v7 long-term forced-strict wire shape under the current prompt policy", () => {
    expect(MEMORY_FACT_EXTRACTION_PROMPT_VERSION)
      .toBe("memory-fact-extraction-prompt-v52");
    expect(MEMORY_FACT_EXTRACTION_SCHEMA_VERSION)
      .toBe("memory-fact-extraction-schema-v7");
    expect(memoryFactExtractionTool).toMatchObject({
      name: "submit_memory_fact_observations_v7",
      strict: true
    });
    const observation = (memoryFactExtractionTool.inputSchema as {
      properties: { observations: { items: { properties: Record<string, unknown> } } };
    }).properties.observations.items.properties;
    expect(Object.keys(observation).sort()).toEqual([
      "candidate_ref", "confidence_band", "dependency_refs", "entities",
      "evidence", "identity", "memory_type", "reason_code",
      "semantic_frame", "sensitivity", "statement", "temporal", "temporary", "usefulness",
      "value"
    ]);
    const items = (memoryFactExtractionTool.inputSchema as {
      properties: { observations: { items: { required: string[] } } };
    }).properties.observations.items;
    expect(items.required).toContain("usefulness");
    expect(items.required).not.toContain("future_useful");
    expect(observation.usefulness).toEqual({
      enum: ["DURABLE", "ONGOING", "EPISODIC", "SHORT_TERM", "COMMON", "TRANSIENT"],
      type: "string"
    });
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT)
      .toContain("Return exactly one submit_memory_fact_observations_v7 tool call");
  });

  it("scopes the user's own unmentioned relationship status as CURRENT_USER in both prompts", () => {
    // USER_RELATIONSHIP_CONTEXT needs a grounded non-self SUBJECT; without a
    // mention the status or role is the user's own state.
    expect(MEMORY_PERSONAL_SUBJECT_SCOPE_GUIDANCE).toContain(
      "A relationship to a person or animal that the evidence mentions by name or description"
    );
    expect(MEMORY_PERSONAL_SUBJECT_SCOPE_GUIDANCE).toContain(
      "The user's own relationship status or family role stated without such a mention is " +
      "the user's own state and has CURRENT_USER scope."
    );
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(MEMORY_PERSONAL_SUBJECT_SCOPE_GUIDANCE);
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .toContain(MEMORY_PERSONAL_SUBJECT_SCOPE_GUIDANCE);
  });

  it("limits the product_status subject to an identifiable or help-relevant item", () => {
    // A generic purchase is a completed action, not durable ownership.
    for (const rule of [
      "A named PRODUCT, DEVICE, or SERVICE is an item the source identifies as a specific " +
        "product by a brand, model, or service name, or an item of a kind for which later help " +
        "depends on which one the user has",
      "An ordinary item identified only by a generic category is not one and gets no " +
        "product_status SLOT: acquiring it is a single completed action classified EPISODIC, " +
        "and lasting ownership of an ordinary item almost everyone has is COMMON."
    ]) expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(rule);
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT.split("A named PRODUCT, DEVICE, or SERVICE is ")
      .length).toBe(2);
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT)
      .not.toContain("A named PRODUCT, DEVICE, or SERVICE is ");
  });

  it("states the long-term criterion once and keeps the adjudication plan wording", () => {
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(MEMORY_LONG_TERM_USEFULNESS_GUIDANCE);
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(MEMORY_FACT_EXTRACTION_PLAN_GUIDANCE);
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).not.toContain(MEMORY_ASSERTED_PLAN_GUIDANCE);
    expect(MEMORY_SEMANTIC_ADJUDICATION_SYSTEM_PROMPT).toContain(MEMORY_ASSERTED_PLAN_GUIDANCE);
    expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).not.toContain("future_useful");
    for (const retired of [
      "Retain directly asserted personal plans, goals, scheduled activities",
      "independently meaningful past or scheduled event",
      "independently stated dated vacation",
      "but remains future-useful",
      "plan, or errand"
    ]) expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).not.toContain(retired);
    for (const rule of [
      "Rejection classes, never stored",
      "SHORT_TERM for an active but brief matter",
      "COMMON for a lasting habit or trait shared by almost everyone",
      "is applied only to an existing stored fact",
      "considering, planned, and ordered are passing steps",
      "returned, sold, cancelled, and no_longer_owned only update an existing product fact",
      "a short task or deliverable is SHORT_TERM and gets no lifecycle SLOT",
      "only the profession qualifies",
      "classify the resulting state, not the moment of change",
      "never omit it as a single event",
      "memory_directive EXPLICIT_REMEMBER, and its honest usefulness class, even a rejection class",
      "that the earlier restriction or state no longer holds",
      "copy its ref into dependency_refs",
      "running every morning or learning a language, does qualify",
      "Every product_status SLOT, whether its state is lasting, passing, or terminal, uses the same shape"
    ]) expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(rule);
  });

  it("makes semantic authority and exact occurrences explicit", () => {
    for (const rule of [
      "zero-based exact occurrence index",
      "target_message is the only evidence",
      "same language as target_message",
      "never translate it into English",
      "exact evidence text must entail the complete statement with references resolved only through declared dependencies",
      "subject, semantic relation, object or value, recipient",
      "assistant-role context message is never user testimony",
      "short answer to the immediately preceding assistant question",
      "bare confirmation such as yes",
      "copy that item's opaque context_ref into dependency_refs",
      "zero-based ordinal among identical exact-text matches",
      "never a character offset",
      "language-neutral semantic_frame",
      "the name value is not a separate PERSON_SELF object or alias",
      "question, condition, hypothesis, quotation",
      "must produce one HIGH-confidence observation",
      "synthetic-looking, hyphenated, non-Latin",
      "memory_type STATE, confidence_band HIGH, usefulness DURABLE",
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
      "limited to a local choice, one episode, or the present moment",
      "MEDIUM PROPOSITION",
      "pure present withdrawal",
      "Do not invent an opposite assertion or a new value",
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
      "distinct source-grounded SUBJECT entity",
      "USER_RELATIONSHIP_CONTEXT",
      "close person, pet, or colleague",
      "pet's constraint",
      "preserve the attribution in statement",
      "pasted public bio",
      "arbitrary third-party dossier",
      "profession, employment role, or work identity remains eligible",
      "first-person plural report about their own team or project",
      "preserve every value",
      "Tool use does not imply ownership",
      "self-assessed skill level or long-term learning goal",
      "closed set: considering, planned, ordered, owned",
      "active license or subscription with no matching state",
      "imperative addressed to the assistant may still assert a durable response preference",
      "current assistant task or artifact",
      "ONGOING for a current circumstance, routine, commitment, or long-term goal",
      "even with a stated end date",
      "EPISODIC for a single event or completed experience",
      "judging the complete assertion",
      "Preserve recurrence and time bounds without inferring completion or expiration",
      "A need to change an arrangement that only explains why the user wants the assistant to prepare documents",
      "A dated vacation or other single scheduled activity is SHORT_TERM or EPISODIC",
      "cannot form an employment_status SLOT",
      "structured temporal normalization",
      "target_message.created_at in time_zone",
      "preserving the exact original wording",
      "PRONOMINAL, ELLIPSIS, UNKNOWN",
      "no prose or hidden rationale",
      "in the order their evidence first appears in target_message.text and return at most 8",
      "requested again in a continuation",
      "preceding_text is earlier text of that same message for reading only",
      "never cite it as evidence",
      "text_continues is true",
      "An excerpt edge may cut a sentence, quotation, condition, or negation",
      "is not an actual personal fact"
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
      supplied_context_refs: Array<{ entity_bound: boolean; kind: string; ref: string }>;
      target_message: { context_ref: null; text: string };
    };
    expect(payload.context_before).toEqual([expect.objectContaining({
      context_ref: "M1",
      role: "assistant",
      text: priorText
    })]);
    expect(payload.context_after).toEqual([]);
    expect(payload.supplied_context_refs).toEqual([
      expect.objectContaining({ entity_bound: true, kind: "FACT_VERSION", ref: "F1" })
    ]);
    expect(payload.target_message).toMatchObject({
      context_ref: null,
      text: targetText
    });
    const unboundPayload = JSON.parse(memoryFactExtractionPromptPayload({
      ...input,
      contextRefs: input.contextRefs.map((context) => ({ ...context, entityId: null }))
    })) as typeof payload;
    expect(unboundPayload.supplied_context_refs).toEqual([
      expect.objectContaining({ entity_bound: false, kind: "FACT_VERSION", ref: "F1" })
    ]);
    expect(Object.keys(payload.target_message).sort()).toEqual([
      "context_ref", "created_at", "id", "role", "text", "updated_at"
    ]);
  });

  it("shows a page with its read-only preceding text and continuation flag", () => {
    const fullText = Array.from({ length: 1_200 }, (_, index) =>
      `Paragraph ${index} describes ordinary background notes.\n`).join("");
    expect(fullText.length).toBeGreaterThan(MEMORY_FACT_MAX_TARGET_CHARACTERS * 2);
    const view = memoryFactTargetView(fullText, { cursor: 25_000, ordinal: 1 }, false);
    if (view.kind !== "PAGE") throw new Error("page_expected");
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
      contextRefs: [],
      folderId: null,
      identityProfile: "UNICODE_V2",
      inputHash: "b".repeat(64),
      messages: [{
        contentHash: memorySha256(fullText),
        createdAt: "2026-08-27T10:00:00.000Z",
        evidenceEligible: true,
        id: source.sourceMessageId,
        languageCode: "en",
        redactionSpans: [],
        role: "user",
        text: view.text,
        updatedAt: "2026-08-27T10:00:00.000Z"
      }],
      source,
      sourceProjectionHash: "c".repeat(64),
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      suppressionIdentitySnapshot: "d".repeat(64),
      targetPage: view.page,
      timeZone: "UTC"
    };
    const payload = JSON.parse(memoryFactExtractionPromptPayload(input)) as {
      target_message: { preceding_text: string; text: string; text_continues: boolean };
    };
    expect(payload.target_message.text).toBe(fullText.slice(25_000, 47_000));
    expect(payload.target_message.preceding_text).toBe(fullText.slice(23_000, 25_000));
    expect(payload.target_message.text_continues).toBe(true);

    const last = memoryFactTargetView(
      fullText,
      { cursor: fullText.length - 100, ordinal: 3 },
      false
    );
    if (last.kind !== "PAGE") throw new Error("page_expected");
    const lastPayload = JSON.parse(memoryFactExtractionPromptPayload({
      ...input,
      messages: [{ ...input.messages[0]!, text: last.text }],
      targetPage: last.page
    })) as typeof payload;
    expect(lastPayload.target_message.text).toBe(fullText.slice(-100));
    expect(lastPayload.target_message.text_continues).toBe(false);
    expect(() => memoryFactExtractionPromptPayload({
      ...input,
      targetPage: { ...view.page, precedingText: "x".repeat(2_001) }
    })).toThrow("memory_fact_target_message_invalid");
  });
});
