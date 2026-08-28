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
  aggregationRequested: false,
  applyResponsePreferences: false,
  category: "preferences",
  categoryHint: null,
  confidenceBand: "HIGH",
  entityMentions: [],
  includePatterns: false,
  memoryUseful: false,
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

describe("MemoryActionIntent service", () => {
  it("builds one bounded strict request with quoted context", () => {
    const request = buildMemoryActionIntentRequest(context);
    expect(request.name).toBe("MemoryActionIntent");
    expect(request.schema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        "action",
        "aggregationRequested",
        "profileRequested",
        "queryDecompositions",
        "thisChatOnly"
      ])
    });
    expect(request.userPrompt).toContain("current_user_message");
    expect(request.userPrompt).toContain("Please remember that I prefer tea.");
    expect(request.systemPrompt).toContain(
      "Call the supplied MemoryActionIntent tool exactly once"
    );
    expect(request.systemPrompt).toContain(
      "JSON null value, never the quoted string \"null\""
    );
    expect(request.systemPrompt).toContain(
      "LIST and SEARCH are explicit management actions over Saved Memories"
    );
    expect(request.systemPrompt).toContain(
      "Never choose LIST for a conversational answer to what the assistant knows"
    );
    expect(request.systemPrompt).toContain("Put that management lookup in targetQuery");
    expect(request.systemPrompt).toContain("ordinary answer requests: choose NONE");
    expect(request.systemPrompt).toContain(
      "targeted question about one specific prior conversation or event"
    );
    expect(request.systemPrompt).toContain(
      "pastChatsUseful true, memoryUseful false, retrievalMode PAST_CHAT_SEARCH"
    );
    expect(request.systemPrompt).toContain(
      "Set aggregationRequested true only when answering requires combining evidence"
    );
    expect(request.systemPrompt).toContain(
      "queryText a recall query for the recurring set-member predicate"
    );
    expect(request.systemPrompt).toContain(
      "queryText should retrieve the X events, not Y"
    );
    expect(request.systemPrompt).toContain(
      "Use queryDecompositions only for a genuinely multi-part answer"
    );
    expect(request.systemPrompt).toContain(
      "one subquery for each event"
    );
    expect(request.systemPrompt).toContain(
      "carry, use, or keep a personal fact or preference in future conversations"
    );
    expect(request.systemPrompt).toContain(
      "A fact being stable, personal, useful, or phrased as a response preference is not itself a persistence directive"
    );
    expect(request.systemPrompt).toContain(
      "'I prefer concise answers.' is a declarative fact and must be NONE"
    );
    expect(request.systemPrompt).toContain(
      "Durability and scope language still do not create a persistence directive"
    );
    expect(request.systemPrompt).toContain(
      "Это моё постоянное имя во всех разговорах"
    );
    expect(request.systemPrompt).toContain(
      "An inexact or multiply matching target is still UPDATE with HIGH confidence"
    );
    expect(request.systemPrompt).toContain(
      "preserve that quoted statement byte-for-byte in replacementStatement"
    );
    expect(request.systemPrompt).toContain(
      "An inexact or multiply matching target is still FORGET with HIGH confidence"
    );
    expect(request.systemPrompt).toContain(
      "never downgrade it to NONE merely because the server may need target selection"
    );
    expect(request.systemPrompt).toContain(
      "For a pure SAVE, UPDATE, FORGET, LIST, SEARCH, or RESET"
    );
    expect(request.systemPrompt).toContain(
      "memoryUseful false, pastChatsUseful false, applyResponsePreferences false"
    );
    expect(request.systemPrompt).toContain(
      "A safety rejection never erases a direct first-party Memory action"
    );
    expect(request.systemPrompt).toContain(
      "return action SAVE, confidenceBand HIGH, sensitivity SECRET"
    );
    expect(request.systemPrompt).toContain(
      "statement must describe only the kind of secret"
    );
    expect(request.systemPrompt).toContain(
      "explicitly described as the current user's own is first-party"
    );
    expect(request.systemPrompt).toContain(
      "retrievalMode TARGETED_CURRENT, temporalIntent CURRENT"
    );
    expect(request.systemPrompt).toContain(
      "retrievalMode PAST_CHAT_SEARCH, temporalIntent ANY"
    );
    expect(request.systemPrompt).toContain(
      "Do not use temporalIntent HISTORICAL"
    );
    expect(request.systemPrompt).toContain("Automatic learning is a separate later stage");
    expect(request.systemPrompt).toContain(
      "responsePreference classifies only the statement or replacementStatement"
    );
    expect(request.systemPrompt).toContain(
      "applyResponsePreferences means that already-saved response-style preferences"
    );
    expect(request.systemPrompt).toContain(
      "any action independently requests answer retrieval"
    );
    expect(request.systemPrompt).toContain(
      "profileRequested true only when the user asks for a broad inventory"
    );
    expect(request.systemPrompt).toContain(
      "profileRequested true always means action NONE"
    );
    expect(request.systemPrompt).toContain(
      "Расскажи всё, что ты знаешь обо мне из сохранённой памяти"
    );
    expect(request.systemPrompt).toContain(
      "false for targeted identity, preference, recommendation, event, and past-conversation questions"
    );
    expect(request.systemPrompt).toContain(
      "current Saved and learned facts directly"
    );
    expect(request.systemPrompt).toContain("meaning, not from surface wording");
    expect(request.systemPrompt).toContain("Do not use SENSITIVE");
  });

  it("decodes exactly one provider result and never treats it as authority", async () => {
    const execute = vi.fn(async () => ({ ...output }));
    const service = createMemoryActionIntentService({ execute });
    await expect(service.decide(context)).resolves.toMatchObject({ action: "SAVE" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("restores one exact quoted UPDATE replacement when the model shortens it", async () => {
    const exact = "My cedar-grid reporting-format preference is visual summaries.";
    const service = createMemoryActionIntentService({
      execute: vi.fn(async () => ({
        ...output,
        action: "UPDATE",
        reasonCode: "update_request",
        replacementStatement:
          "My cedar-grid reporting preference is visual summaries.",
        statement: null,
        targetQuery: "cedar-grid reporting preference"
      }))
    });

    await expect(service.decide({
      ...context,
      currentUserMessage:
        `Change my saved preference. Use this exact replacement statement: "${exact}"`
    })).resolves.toMatchObject({ replacementStatement: exact });
  });

  it("does not substitute a semantically different quoted UPDATE span", async () => {
    const replacementStatement = "I prefer detailed answers.";
    const service = createMemoryActionIntentService({
      execute: vi.fn(async () => ({
        ...output,
        action: "UPDATE",
        reasonCode: "update_request",
        replacementStatement,
        statement: null,
        targetQuery: "answer preference"
      }))
    });

    await expect(service.decide({
      ...context,
      currentUserMessage:
        "Change my saved preference from \"I prefer concise answers.\" to detailed answers."
    })).resolves.toMatchObject({ replacementStatement });
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
