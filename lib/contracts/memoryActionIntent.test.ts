import { describe, expect, it } from "vitest";
import {
  MEMORY_ACTION_CONTROL_JSON_SCHEMA,
  MEMORY_ACTION_INTENT_MAX_TARGET_SELECTION_CALLS,
  decodeMemoryActionControlDecision,
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
    memoryUseful: false,
    patternExclusionRequested: false,
    pastChatsUseful: false,
    profileRequested: false,
    queryDecompositions: [],
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

function command(overrides: Record<string, unknown> = {}) {
  return {
    action: "SAVE",
    answerRequested: false,
    category: "preferences",
    confidenceBand: "HIGH",
    patternExclusionRequested: false,
    reasonCode: "save_request",
    referencedMemoryRef: null,
    replacementStatement: null,
    responsePreference: false,
    sensitivity: "NORMAL",
    statement: "I prefer tea.",
    targetQuery: null,
    thisChatOnly: false,
    ...overrides
  };
}

describe("Fresh Memory action control contract", () => {
  it("requires exactly the compact provider fields", () => {
    expect(Object.keys(MEMORY_ACTION_CONTROL_JSON_SCHEMA.properties).sort())
      .toEqual([...MEMORY_ACTION_CONTROL_JSON_SCHEMA.required].sort());
    const source = "Remember that I prefer tea.";
    expect(decodeMemoryActionControlDecision(command(), source)).toMatchObject({
      ok: true,
      value: { action: "SAVE", statement: "I prefer tea.", queryText: null }
    });
    for (const key of MEMORY_ACTION_CONTROL_JSON_SCHEMA.required) {
      const missing: Record<string, unknown> = command();
      delete missing[key];
      expect(decodeMemoryActionControlDecision(missing, source)).toMatchObject({ ok: false });
    }
    expect(decodeMemoryActionControlDecision(command({ queryText: "generated query" }), source))
      .toMatchObject({ ok: false });
    expect(decodeMemoryActionControlDecision(intent(), source)).toMatchObject({ ok: false });
    expect(decodeMemoryActionIntent(intent())).toMatchObject({ ok: true });
  });

  it.each([
    { statement: null },
    { action: "UPDATE", statement: null, replacementStatement: null },
    { action: "SEARCH", statement: null, targetQuery: null },
    { action: "RESET", statement: "I prefer tea." },
    { action: "LIST", statement: null, answerRequested: true },
    { action: "SEARCH", statement: null, targetQuery: "drink", answerRequested: true },
    { statement: "x".repeat(2_001) }
  ])("retains action payload validation for %j", (invalid) => {
    expect(decodeMemoryActionControlDecision(command(invalid), "A current user turn."))
      .toMatchObject({ ok: false });
  });

  it("does not turn a source-only or malformed packet into a command", () => {
    for (const source of ["", "bad\u0000source", "x".repeat(2_001)]) {
      expect(decodeMemoryActionControlDecision(command(), source)).toMatchObject({ ok: false });
    }
    expect(decodeMemoryActionControlDecision({ statement: "I prefer tea." }, "Remember this."))
      .toMatchObject({ ok: false });
  });

  it("keeps ordinary retrieval eligible and bounds only its compatibility query", () => {
    const source = "x" + "😀".repeat(300);
    const decoded = decodeMemoryActionControlDecision(command({
      action: "NONE", statement: null, patternExclusionRequested: true
    }), source);
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        memoryUseful: true,
        pastChatsUseful: true,
        applyResponsePreferences: true,
        patternExclusionRequested: true,
        queryText: "x" + "😀".repeat(249)
      }
    });
  });
});

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
    const missingPatternExclusion = intent() as Record<string, unknown>;
    delete missingPatternExclusion.patternExclusionRequested;
    expect(decodeMemoryActionIntent(missingPatternExclusion)).toMatchObject({ ok: false });
    expect(decodeMemoryActionIntent({ ...intent(), includePatterns: true }))
      .toMatchObject({ ok: false });
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

  it("bounds multi-part retrieval decompositions and strips them from inert plans", () => {
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      aggregationRequested: true,
      memoryUseful: false,
      pastChatsUseful: true,
      queryDecompositions: ["when the first event happened", "when the second event happened"],
      queryText: "events relevant to the comparison",
      retrievalMode: "PAST_CHAT_SEARCH",
      temporalIntent: "ANY"
    }))).toMatchObject({
      ok: true,
      value: {
        queryDecompositions: [
          "when the first event happened",
          "when the second event happened"
        ]
      }
    });
    expect(decodeMemoryActionIntent(intent({
      queryDecompositions: ["unused decomposition"]
    }))).toMatchObject({
      ok: true,
      value: { queryDecompositions: [] }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      memoryUseful: true,
      queryDecompositions: ["one", "two", "three"],
      queryText: "multi-part query"
    }))).toMatchObject({ ok: false });
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

  it("keeps planner hints and pattern exclusion only on an admitted targeted read", () => {
    const mention = { occurrenceIndex: 0, resolvedRef: "opaque-ref", text: "Acme" };
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      entityMentions: [mention],
      memoryUseful: true,
      patternExclusionRequested: true,
      queryText: "Acme workflow"
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [mention], patternExclusionRequested: true }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "NONE",
      entityMentions: [mention],
      memoryUseful: true,
      patternExclusionRequested: true,
      profileRequested: true,
      queryText: "current profile",
      retrievalMode: "CURRENT_PROFILE"
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [mention], patternExclusionRequested: false }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      entityMentions: [mention],
      patternExclusionRequested: true,
      statement: "I use Acme."
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [], patternExclusionRequested: false }
    });
    expect(decodeMemoryActionIntent(intent({
      action: "SAVE",
      entityMentions: [mention],
      memoryUseful: true,
      patternExclusionRequested: true,
      queryText: "Acme workflow",
      statement: "I use Acme."
    }))).toMatchObject({
      ok: true,
      value: { entityMentions: [mention], patternExclusionRequested: true }
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
