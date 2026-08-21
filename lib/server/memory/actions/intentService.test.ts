import { describe, expect, it, vi } from "vitest";
import { createMemoryActionIntentService, buildMemoryActionIntentRequest } from "./intentService";

const context = {
  capabilities: {
    automaticLearning: true,
    historyRecall: true,
    memoryEnabled: true
  },
  currentUserMessage: "Please remember that I prefer tea.",
  memoryRefs: ["memory-ref-1"],
  recentMessages: [{ role: "assistant" as const, text: "I can help." }]
};

const output = {
  action: "SAVE",
  applyResponsePreferences: false,
  category: "preferences",
  categoryHint: null,
  confidenceBand: "HIGH",
  memoryUseful: false,
  pastChatsUseful: false,
  queryText: null,
  reasonCode: "save_request",
  recencyRequested: false,
  referencedMemoryRef: null,
  replacementStatement: null,
  responsePreference: false,
  sensitiveDomainHint: null,
  sensitivity: "NORMAL",
  statement: "I prefer tea.",
  targetQuery: null,
  thisChatOnly: false
} as const;

describe("MemoryActionIntent service", () => {
  it("builds one bounded strict request with quoted context", () => {
    const request = buildMemoryActionIntentRequest(context);
    expect(request.name).toBe("MemoryActionIntent");
    expect(request.schema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["action", "thisChatOnly"])
    });
    expect(request.userPrompt).toContain("current_user_message");
    expect(request.userPrompt).toContain("Please remember that I prefer tea.");
    expect(request.systemPrompt).toContain(
      "LIST and SEARCH are explicit management actions over Saved Memories"
    );
    expect(request.systemPrompt).toContain("Put that management lookup in targetQuery");
    expect(request.systemPrompt).toContain("ordinary answer requests: choose NONE");
    expect(request.systemPrompt).toContain("meaning, not from surface wording");
    expect(request.systemPrompt).toContain("Do not use SENSITIVE");
  });

  it("decodes exactly one provider result and never treats it as authority", async () => {
    const execute = vi.fn(async () => ({ ...output }));
    const service = createMemoryActionIntentService({ execute });
    await expect(service.decide(context)).resolves.toMatchObject({ action: "SAVE" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unavailable or invalid strict output", async () => {
    const unavailable = createMemoryActionIntentService({
      execute: vi.fn(async () => { throw new Error("provider down"); })
    });
    await expect(unavailable.decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_unavailable"
    });
    const invalid = createMemoryActionIntentService({
      execute: vi.fn(async () => ({ ...output, action: "SAVE", statement: null }))
    });
    await expect(invalid.decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_invalid"
    });
    await expect(invalid.decide({
      ...context,
      currentUserMessage: "bad\u0000input"
    })).rejects.toMatchObject({ code: "memory_action_intent_invalid" });

    const conflatedSearch = createMemoryActionIntentService({
      execute: vi.fn(async () => ({
        ...output,
        action: "SEARCH",
        category: null,
        memoryUseful: true,
        queryText: "how I like tea",
        reasonCode: "search_request",
        statement: null,
        targetQuery: "saved tea preference"
      }))
    });
    await expect(conflatedSearch.decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_invalid"
    });
  });
});
