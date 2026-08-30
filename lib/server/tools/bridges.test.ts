import { describe, expect, it } from "vitest";
import {
  anthropicMessagesToolBridge,
  deepSeekResponsesToolBridge,
  geminiInteractionsToolBridge,
  openAICompatibleChatToolBridge,
  openAICompatibleResponsesToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "./bridges";
import type { ProviderRunRequest } from "../providers/types";
import type { RunTool, ToolExecutionResult } from "./types";

const searchTool: RunTool = {
  capability: "web_search",
  description: "Search the web.",
  inputSchema: {
    properties: {
      keyword: {
        type: "string"
      }
    },
    required: ["keyword"],
    type: "object"
  },
  name: "search_engine_1",
  strict: true
};

const result: ToolExecutionResult = {
  callId: "call-1",
  content: [
    {
      text: "Search result text",
      type: "text"
    }
  ],
  name: "search_engine_1",
  status: "complete"
};

const mcpTool: RunTool = {
  capability: "mcp",
  description: "Create a task.",
  inputSchema: {
    properties: {
      content: { type: "string" }
    },
    required: ["content"],
    type: "object"
  },
  name: "todoist__create_task"
};

describe("provider tool bridges", () => {
  it("preserves full DeepSeek function schemas while omitting only unsupported strict", () => {
    const serialized = deepSeekResponsesToolBridge.serializeTool(searchTool);
    expect(serialized).toEqual({
      provider: "deepseek",
      tool: {
        description: searchTool.description,
        name: searchTool.name,
        parameters: searchTool.inputSchema,
        type: "function"
      }
    });
    expect(deepSeekResponsesToolBridge.supportsToolCalling({
      modelId: "deepseek-v4-pro",
      provider: "deepseek"
    })).toBe(true);
  });

  it("selects the explicit compatible wire protocol without treating it as OpenRouter", () => {
    const input = { modelId: "deployment-1", provider: "openai_compatible" };

    expect(openAICompatibleResponsesToolBridge.supportsToolCalling(input)).toBe(true);
    expect(openAICompatibleChatToolBridge.supportsToolCalling(input)).toBe(true);
    expect(openAICompatibleResponsesToolBridge.serializeTool(searchTool).tool).toHaveProperty(
      "name",
      "search_engine_1"
    );
    expect(openAICompatibleChatToolBridge.serializeTool(searchTool).tool).toHaveProperty(
      "function.name",
      "search_engine_1"
    );
  });

  it("uses the native Gemini Interactions wire shape", () => {
    const input = { modelId: "gemini-3.6-flash", provider: "gemini" };

    expect(geminiInteractionsToolBridge.supportsToolCalling(input)).toBe(true);
    expect(geminiInteractionsToolBridge.serializeTool(searchTool)).toEqual({
      provider: "gemini",
      tool: {
        description: "Search the web.",
        name: "search_engine_1",
        parameters: searchTool.inputSchema,
        type: "function"
      }
    });
    expect(geminiInteractionsToolBridge.supportsToolCalling({ ...input, provider: "openai_compatible" }))
      .toBe(false);
    expect(geminiInteractionsToolBridge.appendToolResult({}, result)).toEqual({
      call_id: "call-1",
      name: "search_engine_1",
      result: [{ text: "Search result text", type: "text" }],
      type: "function_result"
    });
  });

  it("derives hosted Search tools from the admitted physical route", () => {
    const logicalGeminiClient = {
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "provider_model_client",
          protocol: "gemini_google_search"
        }]
      },
      searchStrategy: "gemini-google-search"
    } as unknown as ProviderRunRequest;
    const hostedOpenAI = {
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "answer_provider_hosted",
          protocol: "openai_responses_web_search"
        }]
      },
      searchStrategy: "company-search"
    } as unknown as ProviderRunRequest;
    const hostedAnthropic = {
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "answer_provider_hosted",
          protocol: "anthropic_web_search"
        }]
      },
      searchStrategy: "anthropic-web-search"
    } as unknown as ProviderRunRequest;

    expect(geminiInteractionsToolBridge.serializeHostedTools?.(logicalGeminiClient)).toEqual([]);
    expect(openAIResponsesToolBridge.serializeHostedTools?.(hostedOpenAI)).toEqual([
      { type: "web_search" }
    ]);
    expect(anthropicMessagesToolBridge.serializeHostedTools?.(hostedAnthropic)).toEqual([{
      allowed_callers: ["direct"],
      max_uses: 3,
      name: "web_search",
      type: "web_search_20250305"
    }]);
  });

  it("owns provider-specific assistant continuation serialization", () => {
    const calls = [{ arguments: { content: "Review" }, id: "call-1", name: mcpTool.name }];

    expect(openAIResponsesToolBridge.serializeAssistantToolCalls({ calls })).toEqual([{
      arguments: "{\"content\":\"Review\"}",
      call_id: "call-1",
      name: mcpTool.name,
      status: "completed",
      type: "function_call"
    }]);
    expect(openRouterChatToolBridge.serializeAssistantToolCalls({ calls })).toEqual([{
      content: null,
      role: "assistant",
      tool_calls: [{
        function: { arguments: "{\"content\":\"Review\"}", name: mcpTool.name },
        id: "call-1",
        type: "function"
      }]
    }]);
    expect(anthropicMessagesToolBridge.serializeAssistantToolCalls({ calls })).toEqual([{
      content: [{ id: "call-1", input: { content: "Review" }, name: mcpTool.name, type: "tool_use" }],
      role: "assistant"
    }]);
    expect(geminiInteractionsToolBridge.serializeAssistantToolCalls({ calls })).toEqual([{
      arguments: { content: "Review" },
      id: "call-1",
      name: mcpTool.name,
      type: "function_call"
    }]);
  });

  it("serializes a neutral tool for OpenRouter Chat Completions", () => {
    expect(openRouterChatToolBridge.serializeTool(searchTool).tool).toEqual({
      function: {
        description: "Search the web.",
        name: "search_engine_1",
        parameters: searchTool.inputSchema,
        strict: true
      },
      type: "function"
    });
  });

  it("parses OpenRouter tool calls and appends tool results", () => {
    expect(
      openRouterChatToolBridge.parseToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: "{\"keyword\":\"latest Anthropic model\"}",
                    name: "search_engine_1"
                  },
                  id: "call-1"
                }
              ]
            }
          }
        ]
      })
    ).toEqual([
      {
        arguments: {
          keyword: "latest Anthropic model"
        },
        id: "call-1",
        name: "search_engine_1",
        raw: {
          function: {
            arguments: "{\"keyword\":\"latest Anthropic model\"}",
            name: "search_engine_1"
          },
          id: "call-1"
        }
      }
    ]);

    expect(openRouterChatToolBridge.appendToolResult({}, result)).toEqual({
      content: "Search result text",
      name: "search_engine_1",
      role: "tool",
      tool_call_id: "call-1"
    });
  });

  it("maps OpenAI Responses function calls to the same neutral call shape", () => {
    expect(openAIResponsesToolBridge.serializeTool(searchTool).tool).toMatchObject({
      name: "search_engine_1",
      parameters: searchTool.inputSchema,
      strict: true,
      type: "function"
    });
    expect(
      openAIResponsesToolBridge.parseToolCalls({
        output: [
          {
            arguments: "{\"keyword\":\"latest Anthropic model\"}",
            call_id: "call-1",
            name: "search_engine_1",
            type: "function_call"
          }
        ]
      })
    ).toMatchObject([
      {
        arguments: {
          keyword: "latest Anthropic model"
        },
        id: "call-1",
        name: "search_engine_1"
      }
    ]);
    expect(openAIResponsesToolBridge.appendToolResult({}, result)).toEqual({
      call_id: "call-1",
      output: "Search result text",
      type: "function_call_output"
    });
  });

  it("does not force strict mode onto arbitrary MCP schemas", () => {
    expect(openAIResponsesToolBridge.serializeTool(mcpTool).tool).toEqual({
      description: "Create a task.",
      name: "todoist__create_task",
      parameters: mcpTool.inputSchema,
      type: "function"
    });
  });

  it("marks malformed provider arguments for a bounded zero-call tool error", () => {
    expect(
      openRouterChatToolBridge.parseToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: { arguments: "{", name: "todoist__create_task" },
                  id: "call-bad"
                }
              ]
            }
          }
        ]
      })
    ).toEqual([
      expect.objectContaining({
        arguments: { __aiqsa_invalid_provider_tool_arguments__: true },
        id: "call-bad",
        name: "todoist__create_task"
      })
    ]);
  });

  it("maps Anthropic tool_use and tool_result blocks", () => {
    expect(anthropicMessagesToolBridge.serializeTool(mcpTool).tool).toEqual({
      description: "Create a task.",
      input_schema: mcpTool.inputSchema,
      name: "todoist__create_task"
    });
    expect(
      anthropicMessagesToolBridge.parseToolCalls({
        content: [
          { text: "I will create it.", type: "text" },
          {
            id: "toolu-1",
            input: { content: "Review the ADR" },
            name: "todoist__create_task",
            type: "tool_use"
          }
        ]
      })
    ).toMatchObject([
      {
        arguments: { content: "Review the ADR" },
        id: "toolu-1",
        name: "todoist__create_task"
      }
    ]);
    expect(
      anthropicMessagesToolBridge.appendToolResult(
        {},
        {
          ...result,
          callId: "toolu-1",
          name: "todoist__create_task",
          status: "error"
        }
      )
    ).toEqual({
      content: [
        {
          content: "Search result text",
          is_error: true,
          tool_use_id: "toolu-1",
          type: "tool_result"
        }
      ],
      role: "user"
    });
  });
});
