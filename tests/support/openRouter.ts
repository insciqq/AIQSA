import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import {
  buildOpenRouterPerplexitySearchRequestPreview
} from "@/lib/server/providers/openRouterChatRequest";
import {
  normalizeSearchFindings,
  searchSourcesFromCitationArtifacts
} from "@/lib/server/search/evidence";
import type {
  ProviderSearchAdapter,
  ProviderSearchResult
} from "@/lib/server/providers/types";

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
          findingsCharacters: finalText.length,
          model: request.searchPolicy.modelId,
          provider: "openrouter",
          sourceCount: 1,
          status: "completed",
          usage
        },
        findings: normalizeSearchFindings(finalText),
        providerResponseId: "fake-openrouter-search-1",
        requestPreview: adapter.buildRequestPreview(request),
        sources: searchSourcesFromCitationArtifacts(artifacts),
        usage: {
          ...usage,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: usage.inputTokens + usage.outputTokens
        }
      };
    }
  };

  return adapter;
}
