import type {
  ModelToolCall,
  ProviderToolBridge,
  RunTool,
  SerializedProviderTool,
  ToolExecutionContent,
  ToolExecutionResult
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textFromContent(content: ToolExecutionContent): string {
  if (content.type === "text") {
    return content.text;
  }

  return JSON.stringify(content.value);
}

function toolResultText(result: ToolExecutionResult): string {
  return result.content.map(textFromContent).join("\n\n");
}

function openAIFunctionTool(tool: RunTool): SerializedProviderTool {
  return {
    provider: "openai",
    tool: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
      strict: true,
      type: "function"
    }
  };
}

function openRouterFunctionTool(tool: RunTool): SerializedProviderTool {
  return {
    provider: "openrouter",
    tool: {
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema
      },
      type: "function"
    }
  };
}

export const openAIResponsesToolBridge: ProviderToolBridge = {
  appendToolResult(_request, result) {
    return {
      call_id: result.callId,
      output: toolResultText(result),
      type: "function_call_output"
    };
  },
  parseToolCalls(response) {
    const output = isRecord(response) && Array.isArray(response.output) ? response.output : [];

    return output.flatMap((item): ModelToolCall[] => {
      if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") {
        return [];
      }

      const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "";
      if (!id) {
        return [];
      }

      return [
        {
          arguments: parseArguments(item.arguments),
          id,
          name: item.name,
          raw: item
        }
      ];
    });
  },
  provider: "openai",
  serializeTool: openAIFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "openai";
  }
};

export const openRouterChatToolBridge: ProviderToolBridge = {
  appendToolResult(_request, result) {
    return {
      content: toolResultText(result),
      name: result.name,
      role: "tool",
      tool_call_id: result.callId
    };
  },
  parseToolCalls(response) {
    const choices = isRecord(response) && Array.isArray(response.choices) ? response.choices : [];

    return choices.flatMap((choice): ModelToolCall[] => {
      const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
      const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];

      return toolCalls.flatMap((toolCall): ModelToolCall[] => {
        if (!isRecord(toolCall) || typeof toolCall.id !== "string" || !isRecord(toolCall.function)) {
          return [];
        }

        const name = toolCall.function.name;
        if (typeof name !== "string") {
          return [];
        }

        return [
          {
            arguments: parseArguments(toolCall.function.arguments),
            id: toolCall.id,
            name,
            raw: toolCall
          }
        ];
      });
    });
  },
  provider: "openrouter",
  serializeTool: openRouterFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "openrouter";
  }
};

export const providerToolBridges = {
  openai: openAIResponsesToolBridge,
  openrouter: openRouterChatToolBridge
} satisfies Record<string, ProviderToolBridge>;
