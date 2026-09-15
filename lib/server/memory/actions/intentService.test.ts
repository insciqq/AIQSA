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

const legacyOutput = {
  action: "SAVE",
  aggregationRequested: false,
  applyResponsePreferences: false,
  category: "preferences",
  categoryHint: null,
  confidenceBand: "HIGH",
  entityMentions: [],
  memoryUseful: false,
  patternExclusionRequested: false,
  pastChatsUseful: false,
  profileRequested: false,
  queryDecompositions: [],
  queryText: null,
  reasonCode: "save_request",
  recencyRequested: false,
  retrievalMode: "TARGETED_CURRENT",
  referencedMemoryRef: null,
  replacementStatement: null,
  responsePreference: false,
  sensitiveDomainHint: null,
  sensitivity: "NORMAL",
  statement: "I prefer tea.",
  targetQuery: null,
  temporalAsOf: null,
  temporalFrom: null,
  temporalIntent: "CURRENT",
  temporalTo: null,
  thisChatOnly: false
} as const;

const controlDecision = {
  action: "SAVE",
  answerRequested: false,
  category: "preferences",
  confidenceBand: "HIGH",
  patternExclusionRequested: false,
  reasonCode: "save_request",
  responsePreference: false,
  sensitivity: "NORMAL",
  statement: "I prefer tea.",
  thisChatOnly: false
} as const;

function updateDecision(overrides: Record<string, unknown> = {}) {
  const { statement: _statement, ...common } = controlDecision;
  return { decision: {
    ...common, action: "UPDATE", referencedMemoryRef: null,
    replacementStatement: "I prefer coffee.", targetQuery: "drink preference",
    ...overrides
  } };
}

describe("Memory control without model read planning", () => {
  it("accepts a pure command without requesting a generated search plan", async () => {
    const execute = vi.fn(async (_request: ReturnType<typeof buildMemoryActionIntentRequest>) =>
      ({ decision: controlDecision }));
    await expect(createMemoryActionIntentService({ execute }).decide(context)).resolves.toMatchObject({
      action: "SAVE",
      memoryUseful: false,
      queryText: null,
      statement: "I prefer tea."
    });
    const request = execute.mock.calls[0]![0];
    expect(request.schema).toMatchObject({
      additionalProperties: false,
      required: ["decision"]
    });
    const branches = (request.schema.properties as { decision: { anyOf: Array<{
      properties: Record<string, unknown>; required: string[]
    }> } }).decision.anyOf;
    expect(branches).toHaveLength(7);
    for (const field of ["queryText", "queryDecompositions", "entityMentions",
      "aggregationRequested", "temporalIntent", "retrievalMode", "profileRequested"]) {
      for (const branch of branches) expect(branch.properties).not.toHaveProperty(field);
    }
  });

  it("keeps a mixed update and answer with the exact source turn", async () => {
    const execute = vi.fn(async (_request: ReturnType<typeof buildMemoryActionIntentRequest>) => updateDecision({
      answerRequested: true,
      replacementStatement: "I prefer coffee.",
      targetQuery: "drink preference"
    }));
    const currentUserMessage = "Update my drink preference to coffee.\nWhat drink fits my breakfast?";
    await expect(createMemoryActionIntentService({ execute }).decide({
      ...context, currentUserMessage
    })).resolves.toMatchObject({
      action: "UPDATE",
      memoryUseful: true,
      pastChatsUseful: true,
      replacementStatement: "I prefer coffee."
    });
    expect(JSON.parse(execute.mock.calls[0]![0].userPrompt).current_user_message)
      .toBe(currentUserMessage);
  });

  it("retains ordinary reads and the explicit inferred-memory opt-out", async () => {
    const execute = vi.fn(async () => ({ decision: {
      action: "NONE",
      patternExclusionRequested: true,
      reasonCode: "no_memory_request"
    } }));
    await expect(createMemoryActionIntentService({ execute }).decide({
      ...context,
      currentUserMessage: "What do you remember? Exclude inferred patterns."
    })).resolves.toMatchObject({
      action: "NONE",
      memoryUseful: true,
      pastChatsUseful: true,
      patternExclusionRequested: true
    });
  });

  it("rejects a fresh legacy planner packet as the new provider wire", async () => {
    const execute = vi.fn(async () => ({ ...legacyOutput }));
    await expect(createMemoryActionIntentService({ execute }).decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_invalid"
    });
  });
});

describe("MemoryActionIntent service", () => {
  it("keeps the current turn and reference context as separate bounded data", () => {
    const request = buildMemoryActionIntentRequest(context);
    expect(request.name).toBe("MemoryActionIntent");
    expect(request.maxOutputTokens).toBe(1_024);
    expect(JSON.parse(request.userPrompt)).toEqual({
      capabilities: context.capabilities,
      current_user_message: context.currentUserMessage,
      memory_refs: context.memoryRefs,
      recent_messages: context.recentMessages
    });
    expect(() => buildMemoryActionIntentRequest({
      ...context, currentUserMessage: "x".repeat(2_001)
    })).toThrow(expect.objectContaining({ code: "memory_action_intent_invalid" }));
    expect(() => buildMemoryActionIntentRequest({
      ...context, memoryRefs: Array.from({ length: 21 }, () => "memory-ref")
    })).toThrow(expect.objectContaining({ code: "memory_action_intent_invalid" }));
  });

  it("decodes exactly one provider result and never treats it as authority", async () => {
    const execute = vi.fn(async () => ({ decision: controlDecision }));
    const service = createMemoryActionIntentService({ execute });
    await expect(service.decide(context)).resolves.toMatchObject({ action: "SAVE" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves the complete selected literal replacement among quoted states", async () => {
    const exact = "My cedar-grid reporting-format preference is visual summaries.";
    const service = createMemoryActionIntentService({
      execute: vi.fn(async () => updateDecision({
        reasonCode: "update_request",
        replacementStatement: exact,
        targetQuery: "cedar-grid reporting preference"
      }))
    });

    await expect(service.decide({
      ...context,
      currentUserMessage:
        `The old note was "My reporting format is prose." Change my saved preference. Use this exact replacement statement: "${exact}"`
    })).resolves.toMatchObject({ replacementStatement: exact });
  });

  it("does not substitute a semantically different quoted UPDATE span", async () => {
    const replacementStatement = "I prefer detailed answers.";
    const service = createMemoryActionIntentService({
      execute: vi.fn(async () => updateDecision({
        reasonCode: "update_request",
        replacementStatement,
        targetQuery: "answer preference"
      }))
    });

    await expect(service.decide({
      ...context,
      currentUserMessage:
        "Change my saved preference from \"I prefer concise answers.\" to detailed answers."
    })).resolves.toMatchObject({ replacementStatement });
  });

  it.each([
    [
      "negated old statement",
      'The previous note was "I do not want phone calls". Replace it with: I want phone calls.',
      "I want phone calls."
    ],
    [
      "different speaker in the old statement",
      "The previous note was “My colleague says I prefer concise answers”. Replace it with: I prefer concise answers.",
      "I prefer concise answers."
    ],
    [
      "negated old statement with guillemets",
      "La nota anterior era «No deseo llamadas telefónicas». Sustitúyela por: Deseo llamadas telefónicas.",
      "Deseo llamadas telefónicas."
    ],
    [
      "old statement with corner quotes",
      "The previous note was 「I do not want phone calls」. Replace it with: I want phone calls.",
      "I want phone calls."
    ],
    [
      "old statement with low and high quotes",
      "The previous note was „I do not want phone calls“. Replace it with: I want phone calls.",
      "I want phone calls."
    ]
  ])("preserves the semantic replacement beside a %s", async (
    _label, currentUserMessage, replacementStatement
  ) => {
    const execute = vi.fn(async () => updateDecision({
      reasonCode: "update_request",
      replacementStatement,
      targetQuery: "communication preference"
    }));

    await expect(createMemoryActionIntentService({ execute }).decide({
      ...context,
      currentUserMessage
    })).resolves.toMatchObject({ replacementStatement });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed for unavailable or invalid strict output", async () => {
    const unavailable = createMemoryActionIntentService({
      execute: vi.fn(async () => { throw new Error("provider down"); })
    });
    await expect(unavailable.decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_unavailable"
    });
    const invalid = createMemoryActionIntentService({
      execute: vi.fn(async () => ({ decision: { ...controlDecision, statement: null } }))
    });
    await expect(invalid.decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_invalid"
    });
    await expect(invalid.decide({
      ...context,
      currentUserMessage: "bad\u0000input"
    })).rejects.toMatchObject({ code: "memory_action_intent_invalid" });

    const conflatedSearch = createMemoryActionIntentService({
      execute: vi.fn(async () => ({ decision: {
        action: "SEARCH",
        memoryUseful: true,
        queryText: "how I like tea",
        reasonCode: "search_request",
        targetQuery: "saved tea preference"
      } }))
    });
    await expect(conflatedSearch.decide(context)).rejects.toMatchObject({
      code: "memory_action_intent_invalid"
    });
  });
});
