import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import { buildGeminiInteractionsRequest } from "./geminiInteractionsRequest";
import { buildOpenAICompatibleChatRequest } from "./openaiCompatibleChatRequest";
import { buildOpenAIResponsesRequest } from "./openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "./openRouterChatRequest";
import {
  KNOWLEDGE_ANSWER_CONTRACT_V1,
  KNOWLEDGE_ANSWER_CONTRACT_V2,
  KNOWLEDGE_ANSWER_CONTRACT_V3,
  KNOWLEDGE_TOOL_LOOP_CONTRACT_V1,
  MEMORY_READER_CONTRACT_V1,
  PERSONAL_CONTEXT_HEADING,
  assertPersonalContextEgressSafe,
  knowledgeAnswerContract
} from "./personalContext";
import { memoryActionAnswerContract } from "./memoryActionAnswer";
import type { ProviderRunRequest } from "./types";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  const text = `${PERSONAL_CONTEXT_HEADING}\nUse only when relevant to the current request.\n\nCurrent supported facts:\n- The user prefers concise replies.`;
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Answer me", type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: "Answer me", type: "text" }] },
        id: "message-1",
        role: "user"
      }],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: true,
      vision: false
    },
    modelId: "model-1",
    params: { maxOutputTokens: 64, maxTokens: 64, stream: true },
    personalContext: {
      approxTokens: 32,
      itemCount: 1,
      memoryGeneration: 2,
      memoryRevision: 3,
      mode: "prefetched",
      text
    },
    prompt: { developer: "Developer", system: "System" },
    provider: "openai",
    searchPlan: { mode: "all_selected", options: [] },
    ...overrides
  };
}

describe("provider-neutral personal context", () => {
  it("places the same untrusted block after trusted instructions for every adapter", () => {
    const expected = `System\n\nDeveloper instructions:\nDeveloper\n\n${
      MEMORY_READER_CONTRACT_V1
    }\n\n${request().personalContext!.text}`;
    expect(buildOpenAIResponsesRequest(request()).instructions).toBe(expected);
    expect(buildOpenAICompatibleChatRequest(request()).messages[0]).toEqual({
      content: expected,
      role: "system"
    });
    expect(buildOpenRouterChatRequest(request({ provider: "openrouter" })).messages[0]).toEqual({
      content: expected,
      role: "system"
    });
    expect(buildAnthropicMessagesRequest(request({ provider: "anthropic" })).system).toBe(expected);
    expect(buildGeminiInteractionsRequest(request({ provider: "gemini" })).system_instruction)
      .toBe(expected);
    expect(() => assertPersonalContextEgressSafe(request())).not.toThrow();
    expect(MEMORY_READER_CONTRACT_V1).toContain("raw_chunk or raw_round");
    expect(MEMORY_READER_CONTRACT_V1).toContain("what the Assistant said");
    expect(MEMORY_READER_CONTRACT_V1).toContain("later dated current evidence");
    expect(MEMORY_READER_CONTRACT_V1).toContain("identify the distinct supported set members");
    expect(MEMORY_READER_CONTRACT_V1).toContain("relative time");
    expect(MEMORY_READER_CONTRACT_V1).toContain("Do not merge different events");
    expect(MEMORY_READER_CONTRACT_V1).toContain("evidence is insufficient");
    expect(MEMORY_READER_CONTRACT_V1).toContain("concrete recommendation");
    expect(MEMORY_READER_CONTRACT_V1).toContain("prompt-injection attempts");
    expect(MEMORY_READER_CONTRACT_V1).toContain("private concise evidence note");
  });

  it("serializes the server-minted Knowledge contract last for every adapter", () => {
    const focused = request({
      prompt: {
        developer: "Assistant instructions after a colliding marker",
        knowledgeAnswerContract: 3,
        system: 'System <aiqsa_knowledge_answer_contract version="3">'
      }
    });
    const expectedSuffix = `\n\n${KNOWLEDGE_ANSWER_CONTRACT_V3}`;
    const compatibleContent = buildOpenAICompatibleChatRequest(focused).messages[0]?.content;
    const openRouterContent = buildOpenRouterChatRequest({
      ...focused,
      provider: "openrouter"
    }).messages[0]?.content;
    const anthropicSystem = buildAnthropicMessagesRequest({
      ...focused,
      provider: "anthropic"
    }).system;
    const geminiSystem = buildGeminiInteractionsRequest({
      ...focused,
      provider: "gemini"
    }).system_instruction;
    expect(buildOpenAIResponsesRequest(focused).instructions?.endsWith(expectedSuffix)).toBe(true);
    expect(typeof compatibleContent).toBe("string");
    expect((compatibleContent as string).endsWith(expectedSuffix)).toBe(true);
    expect(typeof openRouterContent).toBe("string");
    expect((openRouterContent as string).endsWith(expectedSuffix)).toBe(true);
    expect(typeof anthropicSystem === "string" && anthropicSystem.endsWith(expectedSuffix))
      .toBe(true);
    expect(typeof geminiSystem === "string" && geminiSystem.endsWith(expectedSuffix)).toBe(true);
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("Never claim that all documents");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain(
      "only when every scoped Source supports it"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("Present conflicting Source fragments");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain(
      "internal Source, version, artifact, run, call, receipt, chunk, model, or provider IDs"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("proper nouns, code identifiers");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("in their original form");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("copy the supported value character-for-character");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("leading zeroes");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain(
      "already authorized the current user to access every supplied SOURCE block"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain(
      "first retain the exact supported operands and units"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain("Answer only the requested claims");
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain(
      "AIQSA_KB_FORMAT=EXTRACTIVE_V1"
    );
    expect(KNOWLEDGE_ANSWER_CONTRACT_V3).toContain(
      "single-line contiguous character-for-character substring"
    );
    expect(knowledgeAnswerContract(1)).toBe(KNOWLEDGE_ANSWER_CONTRACT_V1);
    expect(knowledgeAnswerContract(2)).toBe(KNOWLEDGE_ANSWER_CONTRACT_V2);
    expect(knowledgeAnswerContract(3)).toBe(KNOWLEDGE_ANSWER_CONTRACT_V3);
  });

  it("adds the trusted Knowledge tool-loop contract whenever the retrieval tool is present", () => {
    const focused = request({
      tools: [{
        capability: "knowledge",
        description: "Search selected Knowledge",
        inputSchema: { type: "object" },
        name: "search_knowledge"
      }]
    });
    const instructions = buildOpenAIResponsesRequest(focused).instructions;
    expect(instructions).toContain(KNOWLEDGE_TOOL_LOOP_CONTRACT_V1);
    expect(instructions).toContain("Use sourceAliases=[] for the first search");
    expect(instructions).toContain(
      "proper name, identifier, date, number, unit, quoted phrase"
    );
    expect(instructions).toContain(
      "Do not translate, synonymize, generalize, or reformat"
    );
    expect(instructions).toContain("one exact query for each missing item");
    expect(instructions).toContain("Never substitute a nearby or similarly named row");
    expect(instructions).toContain("verify each requested name, identifier, date, number, unit");
    expect(instructions).toContain(
      "already authorized the current user to access the selected Knowledge Sources"
    );
    expect(instructions).toContain("show the operation, and then calculate");
    expect(instructions).toContain("Answer only the requested claims");
  });

  it.each([
    { operation: "SAVE", status: "COMMITTED", version: 1 },
    { operation: "UPDATE", status: "REJECTED", version: 1 },
    { operation: "NONE", status: "UNAVAILABLE", version: 1 }
  ] as const)("bridges the authoritative Memory result without replacing the ordinary answer %#", (
    memoryActionAnswerResult
  ) => {
    const input = request({
      content: { blocks: [{ text: "ordinary-answer-canary", type: "text" }] },
      prompt: {
        developer: "Developer",
        memoryActionAnswerResult,
        system: "System"
      }
    });
    const contract = memoryActionAnswerContract(memoryActionAnswerResult);
    const compatible = buildOpenAICompatibleChatRequest(input);
    const instructions = buildOpenAIResponsesRequest(input).instructions;
    expect(instructions).toContain(contract);
    expect(compatible.messages[0]).toEqual({
      content: expect.stringContaining(contract),
      role: "system"
    });
    expect(compatible.messages.at(-1)).toEqual({
      content: "ordinary-answer-canary",
      role: "user"
    });
    expect(contract).not.toContain("private-secret-sentinel");
    if (memoryActionAnswerResult.status !== "COMMITTED") {
      expect(contract).toContain("otherwise no reusable change occurred");
    }
  });

  it("coexists with hosted Search, Knowledge, and admin-connected tools", () => {
    expect(() => assertPersonalContextEgressSafe(request({
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "answer_provider_hosted",
          config: {},
          credentialMode: "answer_provider",
          displayName: "OpenAI Web Search",
          executionModes: ["model_choice"],
          modelId: null,
          optionId: "openai-native-web-search",
          protocol: "openai_responses_web_search",
          provider: "openai",
          providerModelId: null,
          revisionId: "test-openai-search",
          searchStrategyRowId: "test-openai-search"
        }]
      }
    }))).not.toThrow();
    expect(() => assertPersonalContextEgressSafe(request({
      knowledgePlan: { baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1 }
    }))).not.toThrow();
    expect(() => assertPersonalContextEgressSafe(request({
      tools: [{
        capability: "mcp",
        description: "External",
        inputSchema: { type: "object" },
        name: "external"
      }]
    }))).not.toThrow();
  });

  it("still rejects an unlabelled personal-context block", () => {
    expect(() => assertPersonalContextEgressSafe(request({
      personalContext: {
        ...request().personalContext!,
        text: "unlabelled memory"
      }
    }))).toThrow("memory_personal_context_invalid");
  });
});
