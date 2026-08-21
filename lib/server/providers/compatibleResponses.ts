import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesRequestPreview,
  type OpenAIResponsesRequestBody,
  usesHostedOpenAIWebSearch
} from "./openaiResponsesRequest";
import {
  extractOpenAIUsage,
  isFailedOpenAIResponse,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus,
  parseOpenAIResponsesSse
} from "./openaiResponsesResponse";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./types";
import { providerStreamTimingLimits } from "./network";
import {
  OPENAI_RESPONSES_REASONING_REQUEST_MAPPING,
  type ProviderReasoningRequestMapping
} from "../../contracts/providerReasoningRequestMapping";
import {
  applyProviderReasoningRequestMapping,
  isCanonicalResponsesReasoningRequestMapping
} from "./reasoningRequestMapping";

export type CompatibleResponsesAdapterOptions = {
  client: OpenAIResponsesClient;
  maxAttachmentTextChars?: number;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
};

function compatibleRequest(request: ProviderRunRequest): ProviderRunRequest {
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

function stripNativeExtensions(
  body: OpenAIResponsesRequestBody,
  preserveWebSearchSources: boolean,
  reasoningRequestMapping: ProviderReasoningRequestMapping
): Record<string, unknown> {
  const {
    background: _background,
    include,
    metadata: _metadata,
    previous_response_id: _previousResponseId,
    prompt_cache_key: _promptCacheKey,
    prompt_cache_options: _promptCacheOptions,
    prompt_cache_retention: _promptCacheRetention,
    ...portable
  } = body;
  const output: Record<string, unknown> = {
    ...portable,
    ...(preserveWebSearchSources && include ? { include } : {}),
    store: false
  };
  if (!isCanonicalResponsesReasoningRequestMapping(reasoningRequestMapping)) {
    delete output.reasoning;
    applyProviderReasoningRequestMapping(output, reasoningRequestMapping, {
      effort: body.reasoning?.effort,
      mode: body.reasoning?.mode
    });
  }
  return output;
}

export function buildCompatibleResponsesRequest(
  request: ProviderRunRequest,
  options: Readonly<{
    maxAttachmentTextChars?: number;
    reasoningRequestMapping?: ProviderReasoningRequestMapping;
  }> = {}
): Record<string, unknown> {
  const portableRequest = compatibleRequest(request);
  const reasoningRequestMapping = options.reasoningRequestMapping ??
    OPENAI_RESPONSES_REASONING_REQUEST_MAPPING;
  return stripNativeExtensions(
    buildOpenAIResponsesRequest(portableRequest, options),
    usesHostedOpenAIWebSearch(portableRequest),
    reasoningRequestMapping
  );
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
        body: stripNativeExtensions(
          preview.body,
          usesHostedOpenAIWebSearch(portableRequest),
          options.reasoningRequestMapping ?? OPENAI_RESPONSES_REASONING_REQUEST_MAPPING
        ),
        provider: "openai-compatible"
      };
    },
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildCompatibleResponsesRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars,
        reasoningRequestMapping: options.reasoningRequestMapping
      });
      if (body.stream === true) {
        if (!options.client.stream) {
          throw new Error("compatible_responses_stream_unavailable");
        }
        const response = await options.client.stream(body, {
          signal: runOptions.signal,
          ...(typeof runOptions.timeoutMs === "number" ? { timeoutMs: runOptions.timeoutMs } : {})
        });
        if (!response.body) {
          throw new Error("compatible_responses_stream_body_missing");
        }
        return yield* parseOpenAIResponsesSse({
          background: false,
          provider: "openai-compatible",
          responseBody: response.body,
          signal: runOptions.signal,
          stream: true,
          streamLimits: providerStreamTimingLimits(runOptions.timeoutMs)
        });
      }

      const response = await options.client.create(body, {
        signal: runOptions.signal,
        ...(typeof runOptions.timeoutMs === "number" ? { timeoutMs: runOptions.timeoutMs } : {})
      });
      const usageEvent: ModelRunSseEvent | undefined =
        typeof response.usage === "object" && response.usage !== null
          ? { data: extractOpenAIUsage(response), type: "usage" }
          : undefined;
      if (isFailedOpenAIResponse(response)) {
        if (usageEvent) yield usageEvent;
        throw new Error(`compatible_response_${openAIResponseStatus(response)}`);
      }
      if (openAIResponseStatus(response) !== "completed") {
        if (usageEvent) yield usageEvent;
        throw new Error("compatible_response_not_completed");
      }

      const completed = normalizeCompletedOpenAIResponse(
        response,
        typeof response.id === "string" ? response.id : undefined,
        "openai-compatible"
      );
      if (usageEvent) yield usageEvent;
      for (const event of completed.events) {
        yield event;
      }
      return completed.result;
    }
  };
}
