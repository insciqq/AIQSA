import { textMessageContent } from "@/lib/domain/content";
import type {
  ProviderSearchAdapter,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "@/lib/server/providers/types";
import type { ModelToolCall, RunTool, ToolExecutor } from "./types";

export const perplexityWebSearchTool: RunTool = {
  capability: "web_search",
  description: "Search for current or source-backed information from the internet using Perplexity.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      keyword: {
        description: "The concise web search query.",
        type: "string"
      }
    },
    required: ["keyword"],
    type: "object"
  },
  name: "search_via_perplexity",
  strict: true
};

function stringArgument(call: ModelToolCall, keys: string[]): string {
  for (const key of keys) {
    const value = call.arguments[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

export function queryFromPerplexityToolCall(call: ModelToolCall): string {
  return stringArgument(call, ["keyword", "query", "q"]);
}

export function createPerplexitySearchToolExecutor(input: {
  searchAdapter: ProviderSearchAdapter;
  searchPolicy: ProviderSearchPolicy;
}): ToolExecutor {
  const searchModelId = input.searchPolicy.modelId;
  const strategyId = input.searchPolicy.strategyId;

  return {
    capability: "web_search",
    async execute(call, context, options) {
      const query = queryFromPerplexityToolCall(call);
      const request: ProviderSearchRequest = {
        ...context.request,
        answerModelId: context.request.modelId,
        answerProvider: context.request.provider,
        content: query ? textMessageContent(query) : context.request.content,
        modelId: searchModelId,
        provider: "openrouter",
        searchModelId,
        searchPolicy: input.searchPolicy,
        searchStrategy: strategyId,
        strategyId
      };
      const result = await input.searchAdapter.search(request, options);

      return {
        artifacts: result.artifacts,
        callId: call.id,
        content: [
          {
            text: result.finalText,
            type: "text"
          }
        ],
        name: call.name,
        rawPreview: {
          finalProviderResponsePreview: result.finalProviderResponsePreview,
          providerResponseId: result.providerResponseId,
          requestPreview: result.requestPreview
        },
        status: "complete",
        usage: result.usage
      };
    },
    tool: perplexityWebSearchTool
  };
}
