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

  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return {};
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // The provider completed a tool call with unusable arguments.
    }
  }

  throw new Error("provider_tool_arguments_invalid");
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

function suppliedProviderMessages(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return [...value];
  return value === undefined ? null : [value];
}

function openAIFunctionTool(tool: RunTool): SerializedProviderTool {
  return {
    provider: "openai",
    tool: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
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

function anthropicFunctionTool(tool: RunTool): SerializedProviderTool {
  return {
    provider: "anthropic",
    tool: {
      description: tool.description,
      input_schema: tool.inputSchema,
      name: tool.name,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
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
  serializeAssistantToolCalls({ calls, providerMessage }) {
    return suppliedProviderMessages(providerMessage) ?? calls.map((call) =>
      isRecord(call.raw) ? call.raw : {
        arguments: JSON.stringify(call.arguments),
        call_id: call.id,
        name: call.name,
        status: "completed",
        type: "function_call"
      }
    );
  },
  serializeHostedTools(request) {
    return request.searchStrategy === "openai-native-web-search"
      ? [{ type: "web_search" }]
      : [];
  },
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
  serializeAssistantToolCalls({ calls, providerMessage }) {
    return suppliedProviderMessages(providerMessage) ?? [{
      content: null,
      role: "assistant",
      tool_calls: calls.map((call) => isRecord(call.raw) ? call.raw : {
        function: { arguments: JSON.stringify(call.arguments), name: call.name },
        id: call.id,
        type: "function"
      })
    }];
  },
  serializeTool: openRouterFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "openrouter";
  }
};

function forProviderFamily(
  bridge: ProviderToolBridge,
  provider: string
): ProviderToolBridge {
  return {
    ...bridge,
    provider,
    serializeTool(tool) {
      return {
        ...bridge.serializeTool(tool),
        provider
      };
    },
    supportsToolCalling(input) {
      return input.provider === provider;
    }
  };
}

export const openAICompatibleResponsesToolBridge = forProviderFamily(
  openAIResponsesToolBridge,
  "openai_compatible"
);

export const openAICompatibleChatToolBridge = forProviderFamily(
  openRouterChatToolBridge,
  "openai_compatible"
);

export const geminiChatToolBridge = forProviderFamily(
  openRouterChatToolBridge,
  "gemini"
);

export const anthropicMessagesToolBridge: ProviderToolBridge = {
  appendToolResult(_request, result) {
    return {
      content: [
        {
          content: toolResultText(result),
          ...(result.status === "error" ? { is_error: true } : {}),
          tool_use_id: result.callId,
          type: "tool_result"
        }
      ],
      role: "user"
    };
  },
  parseToolCalls(response) {
    const content = isRecord(response) && Array.isArray(response.content) ? response.content : [];

    return content.flatMap((block): ModelToolCall[] => {
      if (
        !isRecord(block) ||
        block.type !== "tool_use" ||
        typeof block.id !== "string" ||
        !block.id ||
        typeof block.name !== "string" ||
        !block.name
      ) {
        return [];
      }

      return [
        {
          arguments: parseArguments(block.input),
          id: block.id,
          name: block.name,
          raw: block
        }
      ];
    });
  },
  provider: "anthropic",
  serializeAssistantToolCalls({ calls, providerMessage }) {
    return suppliedProviderMessages(providerMessage) ?? [{
      content: calls.map((call) => isRecord(call.raw) ? call.raw : {
        id: call.id,
        input: call.arguments,
        name: call.name,
        type: "tool_use"
      }),
      role: "assistant"
    }];
  },
  serializeTool: anthropicFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "anthropic";
  }
};

export const providerToolBridges = {
  anthropic: anthropicMessagesToolBridge,
  gemini: geminiChatToolBridge,
  openai: openAIResponsesToolBridge,
  openrouter: openRouterChatToolBridge
} satisfies Record<string, ProviderToolBridge>;
