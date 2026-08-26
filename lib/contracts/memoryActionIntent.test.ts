import { describe, expect, it } from "vitest";
import {
  MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS,
  decodeMemoryActionIntent,
  memoryActionIntentCurrentTurnAuthorizesMutation,
  memoryActionIntentNeedsTargetSelection,
  memoryActionIntentRequiresCurrentUserEvidence,
  memoryActionIntentSourceTextMatchesCurrentUser,
  memoryActionIntentTargetSelectionCallAllowed
} from "./memoryActionIntent";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    action: "NONE",
    aggregationRequested: false,
    applyResponsePreferences: false,
    category: null,
    categoryHint: null,
    confidenceBand: "HIGH",
    entityMentions: [],
    includePatterns: false,
    memoryUseful: false,
    pastChatsUseful: false,
    profileRequested: false,
    queryText: null,
    reasonCode: "none",
    recencyRequested: false,
    retrievalMode: "TARGETED_CURRENT",
    referencedMemoryRef: null,
    replacementStatement: null,
    responsePreference: false,
    sensitiveDomainHint: null,
    sensitivity: "NORMAL",
    statement: null,
    targetQuery: null,
    temporalAsOf: null,
    temporalFrom: null,
    temporalIntent: "CURRENT",
    temporalTo: null,
    thisChatOnly: false,
    ...overrides
  };
}

describe("MemoryActionIntent strict contract", () => {
  it("accepts a complete nullable control decision", () => {
    expect(decodeMemoryActionIntent(intent())).toMatchObject({
      ok: true,
      value: { action: "NONE", reasonCode: "none" }
    });
  });

  it("canonicalizes legacy SENSITIVE provider output to ordinary memory", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      category: "sensitive",
      categoryHint: "about_you",
      reasonCode: "save_request",
      sensitivity: "SENSITIVE",
      statement: "The user lives in Rostov."
    }))).toMatchObject({
      ok: true,
      value: {
        category: "about_you",
        categoryHint: "about_you",
        sensitivity: "NORMAL"
      }
    });
  });

  it("requires the exact strict field set and bounded action payloads", () => {
    expect(decodeMemoryActionIntent({ ...intent(), unexpected: true })).toEqual({
      code: "memory_action_intent_invalid",
      ok: false
    });
    const missing = intent() as Record<string, unknown>;
    delete missing.queryText;
    expect(decodeMemoryActionIntent(missing)).toMatchObject({ ok: false });
    const missingProfileDecision = intent() as Record<string, unknown>;
    delete missingProfileDecision.profileRequested;
    expect(decodeMemoryActionIntent(missingProfileDecision)).toMatchObject({ ok: false });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      statement: "remembered preference",
      targetQuery: "x"
    }))).toMatchObject({ ok: true });
    expect(decodeMemoryActionIntent(intent({ action: "SAVE" }))).toMatchObject({ ok: false });
    expect(decodeMemoryActionIntent(intent({ action: "SEARCH" }))).toMatchObject({ ok: false });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      statement: "x".repeat(2_001)
    }))).toMatchObject({ ok: false });
  });

  it("admits only an unqualified NONE fact inventory as a broad profile request", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      categoryHint: "null",
      memoryUseful: true,
      profileRequested: true,
      queryText: "current Saved and learned facts about the user",
      retrievalMode: "CURRENT_PROFILE"
    }))).toMatchObject({
      ok: true,
      value: { memoryUseful: true, profileRequested: true, recencyRequested: false }
    });

    for (const invalid of [
      {
        memoryUseful: false,
        profileRequested: true,
        queryText: "current Saved and learned facts about the user",
        retrievalMode: "CURRENT_PROFILE"
      },
      {
        action: "SAVE",
        memoryUseful: true,
        profileRequested: true,
        queryText: "current Saved and learned facts about the user",
        retrievalMode: "CURRENT_PROFILE",
        statement: "The user prefers tea."
      },
      {
        memoryUseful: true,
        profileRequested: true,
        queryText: "current Saved and learned facts about the user",
        recencyRequested: true,
        retrievalMode: "CURRENT_PROFILE"
      },
      {
        memoryUseful: true,
        profileRequested: true,
        queryText: null,
        retrievalMode: "CURRENT_PROFILE"
      }
    ]) {
      expect(decodeMemoryActionIntent(intent(invalid))).toMatchObject({ ok: false });
    }
  });

  it("keeps Saved Memories management search separate from answer retrieval", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "SEARCH",
      reasonCode: "search_request",
      targetQuery: "saved preference about concise replies"
    }))).toMatchObject({ ok: true });
    expect(decodeMemoryActionIntent(intent({
      action: "LIST",
      reasonCode: "list_request"
    }))).toMatchObject({ ok: true });

    for (const retrieval of [
      { memoryUseful: true },
      { pastChatsUseful: true },
      { applyResponsePreferences: true },
      { memoryUseful: true, profileRequested: true },
      { queryText: "how the user likes replies" }
    ]) {
      expect(decodeMemoryActionIntent(intent({
        action: "SEARCH",
        reasonCode: "search_request",
        targetQuery: "saved preference about concise replies",
        ...retrieval
      }))).toMatchObject({ ok: false });
      expect(decodeMemoryActionIntent(intent({
        action: "LIST",
        reasonCode: "list_request",
        ...retrieval
      }))).toMatchObject({ ok: false });
    }
  });

  it("requires a retrieval query for ordinary NONE answer plans", () => {
    for (const retrieval of [
      { memoryUseful: true },
      { pastChatsUseful: true, retrievalMode: "PAST_CHAT_SEARCH" },
      { applyResponsePreferences: true }
    ]) {
      expect(decodeMemoryActionIntent(intent({
        action: "NONE",
        queryText: "identity, preferences, or relevant past conversations",
        ...retrieval
      }))).toMatchObject({ ok: true });
      expect(decodeMemoryActionIntent(intent({ action: "NONE", ...retrieval })))
        .toMatchObject({ ok: false });
    }
  });

  it("keeps prior-chat lookup time semantics aligned with retrieval planning", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "the codename chosen for the aquarium launch",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    }))).toMatchObject({ ok: true });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "the codename chosen for the aquarium launch",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "HISTORICAL"
    }))).toMatchObject({
      ok: true,
      value: { retrievalMode: "PAST_CHAT_SEARCH", temporalIntent: "ANY" }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "overview of recent conversations",
      recencyRequested: true,
      retrievalMode: "HISTORY_OVERVIEW",
      temporalIntent: "ANY"
    }))).toMatchObject({
      ok: true,
      value: { recencyRequested: true, retrievalMode: "PAST_CHAT_SEARCH" }
    });
  });

  it("admits aggregation only for a bounded past-chat answer plan", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      aggregationRequested: true,
      memoryUseful: false,
      pastChatsUseful: true,
      queryText: "all deployment rehearsals completed before launch day",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    }))).toMatchObject({
      ok: true,
      value: { aggregationRequested: true }
    });
    expect(decodeMemoryActionIntent(intent({
      aggregationRequested: true,
      memoryUseful: true,
      queryText: "current preference"
    }))).toMatchObject({
      ok: true,
      value: { aggregationRequested: false }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "LIST",
      aggregationRequested: true,
      reasonCode: "list_request"
    }))).toMatchObject({
      ok: true,
      value: { action: "LIST", aggregationRequested: false }
    });
  });

  it("safely normalizes only contradictory read-only routing fields", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: true,
      queryText: "the user's current name",
      retrievalMode: "CURRENT_PROFILE",
      temporalIntent: "ANY"
    }))).toMatchObject({
      ok: true,
      value: {
        memoryUseful: true,
        profileRequested: false,
        retrievalMode: "TARGETED_CURRENT",
        temporalIntent: "CURRENT"
      }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      confidenceBand: "HIGH",
      memoryUseful: true,
      queryText: "the user's preference",
      reasonCode: "save_request",
      retrievalMode: "CURRENT_PROFILE",
      statement: "I prefer concise replies.",
      temporalIntent: "ANY"
    }))).toMatchObject({
      ok: true,
      value: {
        action: "SAVE",
        confidenceBand: "HIGH",
        retrievalMode: "TARGETED_CURRENT",
        statement: "I prefer concise replies.",
        temporalIntent: "CURRENT"
      }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      memoryUseful: true,
      queryText: null,
      retrievalMode: "CURRENT_PROFILE",
      statement: "I prefer concise replies.",
      temporalIntent: "ANY"
    }))).toMatchObject({
      ok: true,
      value: {
        action: "SAVE",
        memoryUseful: false,
        queryText: null,
        retrievalMode: "TARGETED_CURRENT",
        statement: "I prefer concise replies.",
        temporalIntent: "CURRENT"
      }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: true,
      queryText: null,
      retrievalMode: "CURRENT_PROFILE",
      temporalIntent: "ANY"
    }))).toMatchObject({ ok: false });
  });

  it("canonicalizes provider string-null timestamps and unused read-only payloads", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: true,
      queryText: "the user's current response-length preference",
      referencedMemoryRef: "null",
      replacementStatement: "null",
      statement: "null",
      targetQuery: "null",
      temporalAsOf: "null",
      temporalFrom: "null",
      temporalTo: "null"
    }))).toMatchObject({
      ok: true,
      value: {
        action: "NONE",
        referencedMemoryRef: null,
        replacementStatement: null,
        statement: null,
        targetQuery: null,
        temporalAsOf: null,
        temporalFrom: null,
        temporalTo: null
      }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: true,
      queryText: "the user's earlier response-length preference",
      retrievalMode: "HISTORICAL_MEMORY",
      temporalAsOf: "null",
      temporalIntent: "AS_OF"
    }))).toMatchObject({ ok: false });
  });

  it("keeps planner hints only on an admitted read and gates patterns to targeted current", () => {
    const mention = { occurrenceIndex: 0, resolvedRef: "opaque-ref", text: "Acme" };
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      entityMentions: [mention],
      includePatterns: true,
      memoryUseful: true,
      queryText: "Acme workflow"
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [mention], includePatterns: true }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      entityMentions: [mention],
      includePatterns: true,
      memoryUseful: true,
      profileRequested: true,
      queryText: "current profile",
      retrievalMode: "CURRENT_PROFILE"
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [mention], includePatterns: false }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      entityMentions: [mention],
      includePatterns: true,
      statement: "I use Acme."
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [], includePatterns: false }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      entityMentions: [mention],
      includePatterns: true,
      memoryUseful: true,
      queryText: "Acme workflow",
      statement: "I use Acme."
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [mention], includePatterns: true }
    });
  });

  it("limits ambiguous destructive target selection to one extra call", () => {
    const ambiguous = intent({
      action: "FORGET",
      targetQuery: "the old editor preference"
    });
    expect(decodeMemoryActionIntent(ambiguous)).toMatchObject({ ok: true });
    const decoded = decodeMemoryActionIntent(ambiguous);
    if (decoded.ok) {
      expect(memoryActionIntentNeedsTargetSelection(decoded.value))
        .toBe(true);
    }
    expect(memoryActionIntentTargetSelectionCallAllowed("FORGET", 0)).toBe(true);
    expect(memoryActionIntentTargetSelectionCallAllowed(
      "FORGET",
      MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS
    )).toBe(false);
    expect(memoryActionIntentTargetSelectionCallAllowed("SAVE", 0)).toBe(false);
  });

  it("uses byte-for-byte current-user source validation", () => {
    expect(memoryActionIntentSourceTextMatchesCurrentUser("Запомни это", "Запомни это"))
      .toBe(true);
    expect(memoryActionIntentSourceTextMatchesCurrentUser(
      "Запомни это:\nответы покороче",
      "Запомни это:\nответы покороче"
    )).toBe(true);
    expect(memoryActionIntentSourceTextMatchesCurrentUser("Запомни это ", "Запомни это"))
      .toBe(false);
    expect(memoryActionIntentSourceTextMatchesCurrentUser(
      "Запомни\u0000это",
      "Запомни\u0000это"
    )).toBe(false);
    expect(memoryActionIntentSourceTextMatchesCurrentUser(null, "Запомни это")).toBe(false);
    expect(memoryActionIntentRequiresCurrentUserEvidence("SAVE")).toBe(true);
    expect(memoryActionIntentRequiresCurrentUserEvidence("LIST")).toBe(false);
    expect(memoryActionIntentCurrentTurnAuthorizesMutation(
      { action: "SAVE" },
      "Запомни это",
      "Запомни это"
    )).toBe(true);
    expect(memoryActionIntentCurrentTurnAuthorizesMutation(
      { action: "FORGET" },
      "Забудь это",
      "Покажи список"
    )).toBe(false);
    expect(memoryActionIntentCurrentTurnAuthorizesMutation(
      { action: "LIST" },
      null,
      null
    )).toBe(true);
  });
});
