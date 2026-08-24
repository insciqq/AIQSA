import { describe, expect, it } from "vitest";
import {
  decodeMemoryConsumerListInput,
  decodeMemoryConsumerListResponse,
  decodeMemoryConsumerSearchInput,
  decodeMemoryConsumerSettingsResponse
} from "./memoryConsumer";

describe("Memory consumer contracts", () => {
  it("accepts only bounded server-side management filters", () => {
    expect(decodeMemoryConsumerListInput({
      category: "PREFERENCES",
      pageSize: 20,
      provenance: "SAVED"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryConsumerSearchInput({
      category: "WORK",
      provenance: "LEARNED",
      query: "release"
    })).toMatchObject({ ok: true });
    expect(decodeMemoryConsumerListInput({ provenance: "ALL" })).toEqual({
      code: "memory_contract_invalid",
      ok: false
    });
  });

  it("accepts only the simple settings/status projection", () => {
    const safe = {
      capabilities: {
        automaticLearningAvailable: true,
        decayAvailable: true,
        managementAvailable: true,
        naturalLanguageActionsAvailable: true,
        permanentChatDeletion: true,
        pastChatIndexingAvailable: true,
        retrievalAvailable: true,
        synthesisAvailable: true,
        temporaryChats: true
      },
      resetState: "IDLE",
      settings: {
        decayEnabled: false,
        learnAutomatically: true,
        referenceChatHistory: true,
        synthesisEnabled: false,
        useMemoryFacts: true
      },
      status: "ON"
    };
    expect(decodeMemoryConsumerSettingsResponse(safe)).toEqual({ ok: true, value: safe });
    expect(decodeMemoryConsumerSettingsResponse({
      ...safe,
      memoryRevision: 4
    })).toEqual({ code: "memory_contract_invalid", ok: false });
    expect(decodeMemoryConsumerSettingsResponse({
      ...safe,
      destination: "provider.example"
    })).toEqual({ code: "memory_contract_invalid", ok: false });
  });

  it("rejects repository IDs, versions, scores, and hashes on managed items", () => {
    const item = {
      allowedActions: ["EDIT", "FORGET"],
      category: "PREFERENCES",
      createdAt: "2026-08-21T05:00:00.000Z",
      memoryRef: "opaque-memory-ref",
      provenance: "SAVED",
      sourceAvailable: true,
      statement: "I prefer concise answers.",
      updatedAt: "2026-08-21T05:00:00.000Z"
    };
    expect(decodeMemoryConsumerListResponse({ items: [item], nextCursor: null }).ok)
      .toBe(true);
    for (const forbidden of [
      "id",
      "versionId",
      "eventId",
      "feedbackId",
      "deletionId",
      "score",
      "hash",
      "generation",
      "revision"
    ]) {
      expect(decodeMemoryConsumerListResponse({
        items: [{ ...item, [forbidden]: "private" }],
        nextCursor: null
      })).toEqual({ code: "memory_contract_invalid", ok: false });
    }
  });
});
