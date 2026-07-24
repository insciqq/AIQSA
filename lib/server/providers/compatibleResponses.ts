import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesRequestPreview,
  type OpenAIResponsesRequestBody
} from "./openaiResponsesRequest";
import {
  extractOpenAIUsage,
  isFailedOpenAIResponse,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus,
  parseOpenAIResponsesSse
} from "./openaiResponsesResponse";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import { providerStreamIdleTimeoutMs } from "./network";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./types";

export type CompatibleResponsesAdapterOptions = {
  client: OpenAIResponsesClient;
  maxAttachmentTextChars?: number;
};

function compatibleRequest(request: ProviderRunRequest): ProviderRunRequest {
  if (request.searchStrategy === "openai-native-web-search") {
    throw new Error("compatible_responses_native_search_unsupported");
  }

  return {
    ...request,
    params: {
      ...request.params,
      background: false,
      manualContextReplay: true,
      store: false
    },
    previousProviderResponseId: undefined
  };
}

function stripNativeExtensions(body: OpenAIResponsesRequestBody): Record<string, unknown> {
  const {
    include: _include,
    metadata: _metadata,
    previous_response_id: _previousResponseId,
    prompt_cache_key: _promptCacheKey,
    prompt_cache_options: _promptCacheOptions,
    prompt_cache_retention: _promptCacheRetention,
    ...portable
  } = body;

  return {
    ...portable,
    background: false,
    store: false
  };
}

export function buildCompatibleResponsesRequest(
  request: ProviderRunRequest,
  options: Readonly<{ maxAttachmentTextChars?: number }> = {}
): Record<string, unknown> {
  return stripNativeExtensions(buildOpenAIResponsesRequest(compatibleRequest(request), options));
}

export function createCompatibleResponsesAdapter(
  options: CompatibleResponsesAdapterOptions
): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      const portableRequest = compatibleRequest(request);
      const preview = buildOpenAIResponsesRequestPreview(portableRequest, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
      return {
        ...preview,
        body: stripNativeExtensions(preview.body),
        provider: "openai-compatible"
      };
    },
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildCompatibleResponsesRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
      if (body.stream === true) {
        if (!options.client.stream) {
          throw new Error("compatible_responses_stream_unavailable");
        }
        const response = await options.client.stream(body, { signal: runOptions.signal });
        if (!response.body) {
          throw new Error("compatible_responses_stream_body_missing");
        }
        return yield* parseOpenAIResponsesSse({
          background: false,
          idleTimeoutMs: providerStreamIdleTimeoutMs(),
          responseBody: response.body,
          signal: runOptions.signal,
          stream: true
        });
      }

      const response = await options.client.create(body, { signal: runOptions.signal });
      if (typeof response.usage === "object" && response.usage !== null) {
        yield { data: extractOpenAIUsage(response), type: "usage" };
      }
      if (isFailedOpenAIResponse(response)) {
        throw new Error(`compatible_response_${openAIResponseStatus(response)}`);
      }
      if (openAIResponseStatus(response) !== "completed") {
        throw new Error("compatible_response_not_completed");
      }

      const completed = normalizeCompletedOpenAIResponse(
        response,
        typeof response.id === "string" ? response.id : undefined
      );
      for (const event of completed.events) {
        yield event;
      }
      return completed.result;
    }
  };
}
