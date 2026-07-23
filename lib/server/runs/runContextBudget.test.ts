import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import {
  applyProviderRequestContextBudget,
  providerFacingSerializedTools
} from "./runContextBudget";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "question", type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: "question", type: "text" }] },
        id: "current",
        role: "user"
      }],
      mode: "branch_path"
    },
    modelCapabilities: {
      contextWindow: 100,
      defaultMaxOutputTokens: 0,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    modelId: "gpt-test",
    params: {},
    prompt: { developer: null, presetId: null, system: null },
    provider: "openai",
    searchStrategy: null,
    ...overrides
  };
}

describe("provider request context budget", () => {
  it("counts the exact serialized provider tool schema", () => {
    const tool = {
      capability: "mcp" as const,
      description: "d".repeat(500),
      inputSchema: { properties: { value: { type: "string" } }, type: "object" },
      name: "mcp_memory_store"
    };
    const input = request({ tools: [tool] });

    expect(providerFacingSerializedTools(input, openAIResponsesToolBridge)).toEqual([
      openAIResponsesToolBridge.serializeTool(tool).tool
    ]);
    expect(applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: input
    })).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("counts provider-hosted tools through the provider bridge", () => {
    const input = request({ searchStrategy: "openai-native-web-search" });

    expect(providerFacingSerializedTools(input, openAIResponsesToolBridge)).toEqual([
      { type: "web_search" }
    ]);
  });

  it("counts prompt, current content, and tools when the first turn has no context rows", () => {
    const budgeted = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: request({
        context: { messages: [], mode: "branch_path" },
        tools: [{
          capability: "mcp",
          description: "d".repeat(500),
          inputSchema: { type: "object" },
          name: "mcp_first_turn"
        }]
      })
    });

    expect(budgeted).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });

  it("counts the retained provider tool transcript on continuation rounds", () => {
    const budgeted = applyProviderRequestContextBudget({
      bridge: openAIResponsesToolBridge,
      request: request({
        providerToolMessages: [{
          call_id: "call-1",
          output: "r".repeat(500),
          type: "function_call_output"
        }]
      })
    });

    expect(budgeted).toMatchObject({ error: { code: "context_too_large" }, ok: false });
  });
});
