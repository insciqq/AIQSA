import { dispatchSearchRequest } from "./searchDispatch";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildOpenRouterPerplexitySearchRequest,
  buildOpenRouterPerplexitySearchRequestPreview
} from "./openRouterChatRequest";
import {
  assertValidOpenRouterTerminalResponse,
  extractOpenRouterArtifacts,
  extractOpenRouterText,
  extractOpenRouterUsage,
  openRouterProviderResponseId,
  openRouterResponseError
} from "./openRouterChatResponse";
import type { OpenRouterChatClient } from "./openRouterChatTransport";
import {
  normalizeSearchFindings,
  searchSourcesFromCitationArtifacts
} from "../search/evidence";
import type {
  ProviderSearchAdapter,
  ProviderSearchRequest,
  ProviderSearchResult
} from "./types";
import { ProviderSearchExecutionError } from "./types";
import { firstOpenAIChatChoice, firstOpenAIChatMessage } from "./openaiChatCompletions";

export type OpenRouterPerplexitySearchAdapterOptions = Readonly<{
  client: OpenRouterChatClient;
}>;

function searchArtifact(
  response: Readonly<Record<string, unknown>>,
  request: ProviderSearchRequest,
  citationCount: number
): ModelRunSseEvent {
  return {
    data: {
      artifactType: "search",
      payload: {
        citationCount,
        model: response.model ?? request.searchPolicy.modelId,
        provider: "openrouter",
        responseId: openRouterProviderResponseId(response),
        strategyId: request.strategyId
      }
    },
    type: "artifact"
  };
}

export function createOpenRouterPerplexitySearchAdapter(
  options: OpenRouterPerplexitySearchAdapterOptions
): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      return buildOpenRouterPerplexitySearchRequestPreview(request);
    },
    async search(request, searchOptions = {}): Promise<ProviderSearchResult> {
      const body = buildOpenRouterPerplexitySearchRequest(request);
      const response = await dispatchSearchRequest(searchOptions, {
        body, execute: () => options.client.createChatCompletion(body, {
          signal: searchOptions.signal,
          ...(typeof searchOptions.timeoutMs === "number"
            ? { timeoutMs: searchOptions.timeoutMs }
            : {})
        }), usage: extractOpenRouterUsage
      });
      const usage = extractOpenRouterUsage(response);
      const responseError = openRouterResponseError(response);
      if (responseError) {
        throw new ProviderSearchExecutionError({ artifacts: [], code: responseError, usage });
      }
      const finishReason = firstOpenAIChatChoice(response)?.finish_reason;
      const message = firstOpenAIChatMessage(response);
      try {
        assertValidOpenRouterTerminalResponse(response, { allowToolCalls: false });
        // A text-bearing response can still be truncated, interrupted, or asking
        // for a tool. Query-only Search needs successful terminal proof.
        if (finishReason !== "stop" ||
          Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
          throw new Error("openrouter_terminal_response_invalid");
        }
      } catch {
        const providerStatus = finishReason === "length" || finishReason === "content_filter" ||
          finishReason === "error" || finishReason === "tool_calls" ? finishReason : undefined;
        throw new ProviderSearchExecutionError({
          artifacts: [],
          code: "openrouter_terminal_response_invalid",
          ...(providerStatus ? { providerStatus } : {}),
          ...(finishReason === "length" ? { reason: "max_output_tokens" } : {}),
          usage
        });
      }

      const finalText = extractOpenRouterText(response);
      const citationArtifacts = extractOpenRouterArtifacts(response).filter((event) =>
        event.type === "artifact" && event.data.artifactType === "citation"
      );
      const sources = searchSourcesFromCitationArtifacts(citationArtifacts);
      const operationArtifact = searchArtifact(response, request, sources.length);
      const artifacts = [operationArtifact, ...citationArtifacts];
      let findings: string;
      try {
        findings = normalizeSearchFindings(finalText);
      } catch {
        throw new ProviderSearchExecutionError({
          artifacts: [operationArtifact],
          code: "openrouter_search_findings_invalid",
          usage
        });
      }
      if (sources.length === 0) {
        throw new ProviderSearchExecutionError({
          artifacts: [operationArtifact],
          code: "openrouter_search_sources_invalid",
          usage
        });
      }
      return {
        artifacts,
        finalProviderResponsePreview: {
          findingsCharacters: findings.length,
          model: response.model ?? request.searchPolicy.modelId,
          provider: "openrouter",
          sourceCount: sources.length,
          status: "completed",
          usage
        },
        findings,
        providerResponseId: openRouterProviderResponseId(response),
        requestPreview: adapter.buildRequestPreview(request),
        sourceAttribution: "available",
        sources,
        usage
      };
    }
  };

  return adapter;
}
