import { describe, expect, it } from "vitest";
import {
  anthropicMessagesToolBridge,
  openAIResponsesToolBridge,
  openRouterChatToolBridge
} from "./bridges";
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
  name: "search_via_perplexity",
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
  name: "search_via_perplexity",
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
  });

  it("serializes a neutral tool for OpenRouter Chat Completions", () => {
    expect(openRouterChatToolBridge.serializeTool(searchTool).tool).toEqual({
      function: {
        description: "Search the web.",
        name: "search_via_perplexity",
        parameters: searchTool.inputSchema
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
                    name: "search_via_perplexity"
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
        name: "search_via_perplexity",
        raw: {
          function: {
            arguments: "{\"keyword\":\"latest Anthropic model\"}",
            name: "search_via_perplexity"
          },
          id: "call-1"
        }
      }
    ]);

    expect(openRouterChatToolBridge.appendToolResult({}, result)).toEqual({
      content: "Search result text",
      name: "search_via_perplexity",
      role: "tool",
      tool_call_id: "call-1"
    });
  });

  it("maps OpenAI Responses function calls to the same neutral call shape", () => {
    expect(openAIResponsesToolBridge.serializeTool(searchTool).tool).toMatchObject({
      name: "search_via_perplexity",
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
            name: "search_via_perplexity",
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
        name: "search_via_perplexity"
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

  it("fails closed when a provider completes a tool call with malformed arguments", () => {
    expect(() =>
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
    ).toThrow("provider_tool_arguments_invalid");
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
