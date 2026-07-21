import { describe, expect, it } from "vitest";
import { openAIResponsesToolBridge, openRouterChatToolBridge } from "./bridges";
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
  name: "search_via_perplexity"
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

describe("provider tool bridges", () => {
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
});
