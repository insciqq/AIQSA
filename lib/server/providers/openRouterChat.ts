import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  createFakeOpenRouterPerplexitySearchAdapter as createFakeOpenRouterPerplexitySearchAdapterBoundary,
  createOpenRouterPerplexitySearchAdapter as createOpenRouterPerplexitySearchAdapterBoundary
} from "./openRouterPerplexitySearch";
import {
  buildOpenRouterChatRequest,
  buildOpenRouterChatRequestPreview,
  buildOpenRouterPerplexitySearchRequest,
  buildOpenRouterPerplexitySearchRequestPreview
} from "./openRouterChatRequest";
import {
  streamOpenRouterJsonResponse,
  streamOpenRouterSseResponse
} from "./openRouterChatResponse";
import {
  createFetchOpenRouterChatClient,
  type OpenRouterChatClient
} from "./openRouterChatTransport";
import type {
  ProviderAdapter,
  ProviderRunResult,
  ProviderSearchAdapter
} from "./types";

export {
  buildOpenRouterChatRequest,
  buildOpenRouterPerplexitySearchRequest,
  createFetchOpenRouterChatClient
};
export type { OpenRouterChatClient };

export type OpenRouterAdapterOptions = {
  client: OpenRouterChatClient;
  maxAttachmentTextChars?: number;
};

export function createOpenRouterChatAdapter(options: OpenRouterAdapterOptions): ProviderAdapter {
  return {
    buildRequestPreview: (request) =>
      buildOpenRouterChatRequestPreview(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      }),
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildOpenRouterChatRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
      if (body.stream && options.client.streamChatCompletion) {
        const response = await options.client.streamChatCompletion(body, {
          signal: runOptions.signal
        });
        return yield* streamOpenRouterSseResponse(response, request, runOptions.signal);
      }

      const response = await options.client.createChatCompletion(body, {
        signal: runOptions.signal
      });
      return yield* streamOpenRouterJsonResponse(response, request);
    }
  };
}

export function createOpenRouterPerplexitySearchAdapter(
  options: OpenRouterAdapterOptions
): ProviderSearchAdapter {
  return createOpenRouterPerplexitySearchAdapterBoundary({ client: options.client });
}

export function createFakeOpenRouterPerplexitySearchAdapter(): ProviderSearchAdapter {
  return createFakeOpenRouterPerplexitySearchAdapterBoundary();
}
