import type {
  ProviderSearchAdapter,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "@/lib/server/providers/types";
import {
  DEFAULT_SEARCH_QUERY_MAX_CHARACTERS,
  validateSearchToolArguments
} from "@/lib/server/search/query";
import {
  normalizeSearchFindings,
  normalizeSearchSources
} from "@/lib/server/search/evidence";
import type { ModelToolCall, RunTool, ToolExecutor } from "./types";

export const perplexityWebSearchTool: RunTool = {
  capability: "web_search",
  description: "Search for current or source-backed information from the internet using Perplexity.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      query: {
        description: "The concise web search query.",
        maxLength: DEFAULT_SEARCH_QUERY_MAX_CHARACTERS,
        minLength: 1,
        type: "string"
      }
    },
    required: ["query"],
    type: "object"
  },
  name: "search_via_perplexity",
  strict: true
};

export function createPerplexitySearchToolExecutor(input: {
  searchAdapter: ProviderSearchAdapter;
  searchPolicy: ProviderSearchPolicy;
}): ToolExecutor {
  const strategyId = input.searchPolicy.strategyId;

  return {
    capability: "web_search",
    async execute(call, context, options) {
      const validation = validateSearchToolArguments(call.arguments);
      const attachmentDisclosureBlocked =
        context.request.attachmentIds.length > 0 || context.request.attachments.length > 0;
      const code = attachmentDisclosureBlocked
        ? "client_search_with_attachments_not_supported"
        : validation.ok
          ? null
          : validation.code;
      if (code) {
        return {
          callId: call.id,
          content: [{ text: `Search failed: ${code}`, type: "text" }],
          name: call.name,
          rawPreview: {
            finalProviderResponsePreview: { error: code },
            providerCall: false,
            requestPreview: {
              queryCharacters:
                typeof call.arguments.query === "string"
                  ? Math.min(call.arguments.query.length, DEFAULT_SEARCH_QUERY_MAX_CHARACTERS + 1)
                  : 0
            }
          },
          status: "error"
        };
      }
      if (!validation.ok) throw new Error("search_query_validation_invariant");
      const request: ProviderSearchRequest = {
        correlationId: context.runId ?? call.id,
        query: validation.query,
        ...(context.request.params.search && typeof context.request.params.search === "object"
          ? { searchControls: context.request.params.search as Readonly<Record<string, unknown>> }
          : {}),
        searchPolicy: input.searchPolicy,
        strategyId
      };
      const result = await input.searchAdapter.search(request, options);
      const sources = normalizeSearchSources(result.sources, 20);
      let findings: string;
      try {
        findings = normalizeSearchFindings(result.findings);
      } catch {
        return {
          callId: call.id,
          content: [{ text: "Search failed: search_findings_invalid", type: "text" }],
          name: call.name,
          rawPreview: {
            finalProviderResponsePreview: { error: "search_findings_invalid" },
            requestPreview: {
              modelId: input.searchPolicy.modelId,
              provider: input.searchPolicy.provider,
              queryCharacters: validation.query.length,
              strategyId
            }
          },
          status: "error",
          usage: result.usage
        };
      }
      if (sources.length === 0) {
        return {
          callId: call.id,
          content: [{ text: "Search failed: search_sources_invalid", type: "text" }],
          name: call.name,
          rawPreview: {
            finalProviderResponsePreview: { error: "search_sources_invalid" },
            requestPreview: {
              modelId: input.searchPolicy.modelId,
              provider: input.searchPolicy.provider,
              queryCharacters: validation.query.length,
              strategyId
            }
          },
          status: "error",
          usage: result.usage
        };
      }

      return {
        artifacts: result.artifacts,
        callId: call.id,
        content: [
          {
            text: findings,
            type: "text"
          }
        ],
        name: call.name,
        rawPreview: {
          finalProviderResponsePreview: {
            findingsCharacters: findings.length,
            sourceCount: sources.length,
            sources,
            status: "completed"
          },
          providerResponseId: result.providerResponseId,
          requestPreview: {
            modelId: input.searchPolicy.modelId,
            provider: input.searchPolicy.provider,
            queryCharacters: validation.query.length,
            strategyId
          }
        },
        status: "complete",
        usage: result.usage
      };
    },
    tool: perplexityWebSearchTool
  };
}
