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

export {
  buildOpenAICompatibleChatRequest,
  createFetchOpenAICompatibleChatClient
};
export type { OpenAICompatibleChatClient };

export type OpenAICompatibleChatAdapterOptions = {
  client: OpenAICompatibleChatClient;
  maxAttachmentTextChars?: number;
};

export function createOpenAICompatibleChatAdapter(
  options: OpenAICompatibleChatAdapterOptions
): ProviderAdapter {
  return {
    buildRequestPreview: (request) =>
      buildOpenAICompatibleChatRequestPreview(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      }),
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildOpenAICompatibleChatRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });

      if (body.stream) {
        const response = await options.client.streamChatCompletion(body, {
          signal: runOptions.signal
        });
        return yield* streamOpenAICompatibleChatSseResponse(
          response,
          request,
          runOptions.signal
        );
      }

      const response = await options.client.createChatCompletion(body, {
        signal: runOptions.signal
      });
      return yield* streamOpenAICompatibleChatJsonResponse(response, request);
    }
  };
}
