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
    applyResponsePreferences: false,
    category: null,
    categoryHint: null,
    confidenceBand: "HIGH",
    memoryUseful: false,
    pastChatsUseful: false,
    queryText: null,
    reasonCode: "none",
    recencyRequested: false,
    referencedMemoryRef: null,
    replacementStatement: null,
    responsePreference: false,
    sensitiveDomainHint: null,
    sensitivity: "NORMAL",
    statement: null,
    targetQuery: null,
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
      { pastChatsUseful: true },
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
