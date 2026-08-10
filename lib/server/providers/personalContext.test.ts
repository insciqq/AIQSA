import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import { buildGeminiInteractionsRequest } from "./geminiInteractionsRequest";
import { buildOpenAICompatibleChatRequest } from "./openaiCompatibleChatRequest";
import { buildOpenAIResponsesRequest } from "./openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "./openRouterChatRequest";
import {
  PERSONAL_CONTEXT_HEADING,
  assertPersonalContextEgressSafe
} from "./personalContext";
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
    searchStrategy: "search-disabled",
    ...overrides
  };
}

describe("provider-neutral personal context", () => {
  it("places the same untrusted block after trusted instructions for every adapter", () => {
    const expected = `System\n\nDeveloper instructions:\nDeveloper\n\n${request().personalContext!.text}`;
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
    expect(() => assertPersonalContextEgressSafe(request({ searchStrategy: null }))).not.toThrow();
  });

  it("fails closed with hosted Search, MCP, Knowledge, or non-Memory tools", () => {
    expect(() => assertPersonalContextEgressSafe(request({
      searchStrategy: "openai-native-web-search"
    }))).toThrow("memory_tool_egress_forbidden");
    expect(() => assertPersonalContextEgressSafe(request({
      knowledgePlan: { baseIds: ["base-1"] }
    }))).toThrow("memory_tool_egress_forbidden");
    expect(() => assertPersonalContextEgressSafe(request({
      tools: [{
        capability: "mcp",
        description: "External",
        inputSchema: { type: "object" },
        name: "external"
      }]
    }))).toThrow("memory_tool_egress_forbidden");
  });
});
