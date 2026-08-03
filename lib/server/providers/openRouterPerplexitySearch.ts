import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildOpenRouterPerplexitySearchRequest,
  buildOpenRouterPerplexitySearchRequestPreview
} from "./openRouterChatRequest";
import {
  assertValidOpenRouterTerminalResponse,
  buildOpenRouterResponsePreview,
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

export type OpenRouterPerplexitySearchAdapterOptions = Readonly<{
  client: OpenRouterChatClient;
}>;

function searchArtifact(
  response: Readonly<Record<string, unknown>>,
  request: ProviderSearchRequest
): ModelRunSseEvent {
  return {
    data: {
      artifactType: "search",
      payload: {
        citationCount: Array.isArray(response.citations) ? response.citations.length : 0,
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

      const artifacts = [searchArtifact(response, request), ...extractOpenRouterArtifacts(response)];
      return {
        artifacts,
        finalProviderResponsePreview: buildOpenRouterResponsePreview(response, finalText),
        findings: normalizeSearchFindings(finalText),
        providerResponseId: openRouterProviderResponseId(response),
        requestPreview: adapter.buildRequestPreview(request),
        sources: searchSourcesFromCitationArtifacts(artifacts),
        usage: extractOpenRouterUsage(response)
      };
    }
  };

  return adapter;
}

export function createFakeOpenRouterPerplexitySearchAdapter(): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      return buildOpenRouterPerplexitySearchRequestPreview(request);
    },
    async search(request): Promise<ProviderSearchResult> {
      const question = request.query;
      const finalText = `Fake Perplexity search findings for: ${question}\n[1] https://example.com/aiqsa-search`;
      const usage = {
        inputTokens: Math.max(1, Math.ceil(question.length / 4)),
        outputTokens: Math.max(1, Math.ceil(finalText.length / 4)),
        reasoningTokens: 0
      };
      const normalizedUsage = {
        ...usage,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: usage.inputTokens + usage.outputTokens
      };
      const artifacts: ModelRunSseEvent[] = [
        {
          data: {
            artifactType: "search",
            payload: {
              model: request.searchPolicy.modelId,
              provider: "openrouter",
              strategyId: request.strategyId,
              text: finalText
            }
          },
          type: "artifact"
        },
        {
          data: {
            artifactType: "citation",
            payload: {
              index: 1,
              source: "fake-openrouter-perplexity",
              title: "AIQSA fake search source",
              url: "https://example.com/aiqsa-search"
            }
          },
          type: "artifact"
        }
      ];

      return {
        artifacts,
        finalProviderResponsePreview: {
          citations: ["https://example.com/aiqsa-search"],
          model: request.searchPolicy.modelId,
          provider: "openrouter",
          text: finalText,
          usage
        },
        findings: normalizeSearchFindings(finalText),
        providerResponseId: "fake-openrouter-search-1",
        requestPreview: adapter.buildRequestPreview(request),
        sources: searchSourcesFromCitationArtifacts(artifacts),
        usage: normalizedUsage
      };
    }
  };

  return adapter;
}
