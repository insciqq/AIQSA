import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildOpenAICompatibleChatRequest,
  buildOpenAICompatibleChatRequestPreview
} from "./openaiCompatibleChatRequest";
import {
  streamOpenAICompatibleChatJsonResponse,
  streamOpenAICompatibleChatSseResponse
} from "./openaiCompatibleChatResponse";
import {
  createFetchOpenAICompatibleChatClient,
  type OpenAICompatibleChatClient
} from "./openaiCompatibleChatTransport";
import type { ProviderAdapter, ProviderRunResult } from "./types";
import type { ProviderReasoningRequestMapping } from "../../contracts/providerReasoningRequestMapping";
import { providerStreamTimingLimits } from "./network";

export {
  buildOpenAICompatibleChatRequest,
  createFetchOpenAICompatibleChatClient
};
export type { OpenAICompatibleChatClient };

export type OpenAICompatibleChatAdapterOptions = {
  client: OpenAICompatibleChatClient;
  maxAttachmentTextChars?: number;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
};

export function createOpenAICompatibleChatAdapter(
  options: OpenAICompatibleChatAdapterOptions
): ProviderAdapter {
  return {
    buildRequestPreview: (request) =>
      buildOpenAICompatibleChatRequestPreview(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars,
        reasoningRequestMapping: options.reasoningRequestMapping
      }),
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildOpenAICompatibleChatRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars,
        reasoningRequestMapping: options.reasoningRequestMapping
      });

      if (body.stream) {
        const response = await options.client.streamChatCompletion(body, {
          signal: runOptions.signal,
          timeoutMs: runOptions.timeoutMs
        });
        return yield* streamOpenAICompatibleChatSseResponse(
          response,
          request,
          runOptions.signal,
          providerStreamTimingLimits(runOptions.timeoutMs)
        );
      }

      const response = await options.client.createChatCompletion(body, {
        signal: runOptions.signal,
        timeoutMs: runOptions.timeoutMs
      });
      return yield* streamOpenAICompatibleChatJsonResponse(response, request);
    }
  };
}
