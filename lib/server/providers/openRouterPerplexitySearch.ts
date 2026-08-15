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
      const response = await options.client.createChatCompletion(body, {
        signal: searchOptions.signal,
        ...(typeof searchOptions.timeoutMs === "number"
          ? { timeoutMs: searchOptions.timeoutMs }
          : {})
      });
      const responseError = openRouterResponseError(response);
      if (responseError) {
        throw new Error(responseError);
      }
      assertValidOpenRouterTerminalResponse(response, { allowToolCalls: false });

      const finalText = extractOpenRouterText(response);
      const citationArtifacts = extractOpenRouterArtifacts(response).filter((event) =>
        event.type === "artifact" && event.data.artifactType === "citation"
      );
      const sources = searchSourcesFromCitationArtifacts(citationArtifacts);
      const operationArtifact = searchArtifact(response, request, sources.length);
      const artifacts = [operationArtifact, ...citationArtifacts];
      const usage = extractOpenRouterUsage(response);
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
        sources,
        usage
      };
    }
  };

  return adapter;
}
