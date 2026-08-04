import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildGeminiInteractionsRequest,
  buildGeminiInteractionsRequestPreview
} from "./geminiInteractionsRequest";
import {
  parseGeminiInteractionsSse,
  streamGeminiInteractionsJsonResponse
} from "./geminiInteractionsResponse";
import {
  createFetchGeminiInteractionsClient,
  type GeminiInteractionsClient
} from "./geminiInteractionsTransport";
import type { ProviderAdapter, ProviderRunResult } from "./types";

export {
  buildGeminiInteractionsRequest,
  buildGeminiInteractionsRequestPreview,
  createFetchGeminiInteractionsClient
};
export type { GeminiInteractionsClient };

export type GeminiInteractionsAdapterOptions = Readonly<{
  client: GeminiInteractionsClient;
  maxAttachmentTextChars?: number;
}>;

export function createGeminiInteractionsAdapter(
  options: GeminiInteractionsAdapterOptions
): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      return buildGeminiInteractionsRequestPreview(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
    },
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildGeminiInteractionsRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
      const groundingExpected = body.tools?.some((tool) =>
        tool.type === "google_search"
      ) ?? false;
      if (body.stream === true) {
        const response = await options.client.streamInteraction(body, {
          signal: runOptions.signal
        });
        if (!response.body) {
          throw new Error("gemini_interactions_stream_body_missing");
        }
        return yield* parseGeminiInteractionsSse({
          groundingExpected,
          modelId: request.modelId,
          responseBody: response.body,
          signal: runOptions.signal
        });
      }

      const response = await options.client.createInteraction(body, {
        signal: runOptions.signal
      });
      return yield* streamGeminiInteractionsJsonResponse(response, {
        groundingExpected,
        modelId: request.modelId
      });
    }
  };
}
