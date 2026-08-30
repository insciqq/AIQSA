import type { ProviderRunRequest } from "../providers/types";
import {
  invalidProviderToolArguments,
  type ModelToolCall,
  type ProviderToolBridge,
  type RunTool,
  type SerializedProviderTool,
  type ToolExecutionContent,
  type ToolExecutionResult
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

  return invalidProviderToolArguments();
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

function usesHostedSearchRoute(
  request: ProviderRunRequest,
  protocol: "anthropic_web_search" | "deepseek_responses_web_search" | "gemini_google_search" | "openai_responses_web_search"
): boolean {
  return request.searchPlan.options.some((option) =>
    option.adapterKind === "answer_provider_hosted" && option.protocol === protocol);
}

export const ANTHROPIC_WEB_SEARCH_TOOL_DECLARATION = Object.freeze({
  allowed_callers: Object.freeze(["direct"]),
  max_uses: 3,
  name: "web_search",
  type: "web_search_20250305"
} as const);

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

function deepSeekFunctionTool(tool: RunTool): SerializedProviderTool {
  return {
    provider: "deepseek",
    tool: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
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
        parameters: tool.inputSchema,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {})
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

function geminiFunctionTool(tool: RunTool): SerializedProviderTool {
  return {
    provider: "gemini",
    tool: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
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
    return usesHostedSearchRoute(
      request,
      "openai_responses_web_search"
    )
      ? [{ type: "web_search" }]
      : [];
  },
  serializeTool: openAIFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "openai";
  }
};

/** DeepSeek implements the Responses function-call wire shape, but rejects
 * OpenAI's `strict` member. Keep this as a dedicated bridge so schemas and
 * descriptions remain intact while only that unsupported field is omitted. */
export const deepSeekResponsesToolBridge: ProviderToolBridge = {
  appendToolResult: openAIResponsesToolBridge.appendToolResult,
  parseToolCalls: openAIResponsesToolBridge.parseToolCalls,
  provider: "deepseek",
  serializeAssistantToolCalls: openAIResponsesToolBridge.serializeAssistantToolCalls,
  serializeHostedTools(request) {
    return usesHostedSearchRoute(request, "deepseek_responses_web_search")
      ? [{ type: "web_search" }]
      : [];
  },
  serializeTool: deepSeekFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "deepseek";
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

export const geminiInteractionsToolBridge: ProviderToolBridge = {
  appendToolResult(_request, result) {
    return {
      call_id: result.callId,
      ...(result.status === "error" ? { is_error: true } : {}),
      name: result.name,
      result: [{ text: toolResultText(result), type: "text" }],
      type: "function_result"
    };
  },
  parseToolCalls(response) {
    const steps = Array.isArray(response)
      ? response
      : isRecord(response) && Array.isArray(response.steps)
        ? response.steps
        : [];

    return steps.flatMap((step): ModelToolCall[] => {
      if (
        !isRecord(step) ||
        step.type !== "function_call" ||
        typeof step.id !== "string" ||
        !step.id ||
        typeof step.name !== "string" ||
        !step.name
      ) {
        return [];
      }

      return [{
        arguments: parseArguments(step.arguments),
        id: step.id,
        name: step.name,
        raw: step
      }];
    });
  },
  provider: "gemini",
  serializeAssistantToolCalls({ calls, providerMessage }) {
    return suppliedProviderMessages(providerMessage) ?? calls.map((call) =>
      isRecord(call.raw) ? call.raw : {
        arguments: call.arguments,
        id: call.id,
        name: call.name,
        type: "function_call"
      }
    );
  },
  serializeHostedTools(request) {
    return usesHostedSearchRoute(
      request,
      "gemini_google_search"
    )
      ? [{ type: "google_search" }]
      : [];
  },
  serializeTool: geminiFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "gemini";
  }
};

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
  serializeHostedTools(request) {
    return usesHostedSearchRoute(
      request,
      "anthropic_web_search"
    )
      ? [{
          ...ANTHROPIC_WEB_SEARCH_TOOL_DECLARATION,
          allowed_callers: [...ANTHROPIC_WEB_SEARCH_TOOL_DECLARATION.allowed_callers]
        }]
      : [];
  },
  serializeTool: anthropicFunctionTool,
  supportsToolCalling(input) {
    return input.provider === "anthropic";
  }
};

export const providerToolBridges = {
  anthropic: anthropicMessagesToolBridge,
  deepseek: deepSeekResponsesToolBridge,
  gemini: geminiInteractionsToolBridge,
  openai: openAIResponsesToolBridge,
  openrouter: openRouterChatToolBridge
} satisfies Record<string, ProviderToolBridge>;
