import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import {
  buildDeepSeekResponsesRequest,
  buildDeepSeekResponsesRequestPreview
} from "./deepSeekResponsesRequest";
import {
  deepSeekResponseError,
  type DeepSeekResponsesClient
} from "./deepSeekResponsesTransport";
import {
  extractOpenAIUsage,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus,
  openAIResponseSummaryEvent,
  parseOpenAIResponsesSse
} from "./openaiResponsesResponse";
import { providerStreamTimingLimits } from "./network";
import type { ProviderAdapter, ProviderRunResult } from "./types";

export type DeepSeekResponsesAdapterOptions = Readonly<{
  client: DeepSeekResponsesClient;
  maxAttachmentTextChars?: number;
}>;

export function createDeepSeekResponsesAdapter(
  options: DeepSeekResponsesAdapterOptions
): ProviderAdapter {
  return {
    buildRequestPreview: (request) => buildDeepSeekResponsesRequestPreview(request, {
      maxAttachmentTextChars: options.maxAttachmentTextChars
    }),
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildDeepSeekResponsesRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
      if (body.stream) {
        const response = await options.client.stream(body, {
          signal: runOptions.signal,
          ...(typeof runOptions.timeoutMs === "number"
            ? { timeoutMs: runOptions.timeoutMs }
            : {})
        });
        if (!response.body) throw new Error("deepseek_stream_body_missing");
        try {
          return yield* parseOpenAIResponsesSse({
            background: false,
            provider: "deepseek",
            responseBody: response.body,
            signal: runOptions.signal,
            stream: true,
            streamLimits: providerStreamTimingLimits(runOptions.timeoutMs)
          });
        } catch (error) {
          throw deepSeekResponseError(error);
        }
      }

      const response = await options.client.create(body, {
        signal: runOptions.signal,
        ...(typeof runOptions.timeoutMs === "number"
          ? { timeoutMs: runOptions.timeoutMs }
          : {})
      });
      const status = openAIResponseStatus(response);
      const providerResponseId = typeof response.id === "string" ? response.id : undefined;
      yield openAIResponseSummaryEvent({
        background: false,
        provider: "deepseek",
        providerResponseId,
        status,
        stream: false
      });
      if (typeof response.usage === "object" && response.usage !== null) {
        yield { data: extractOpenAIUsage(response), type: "usage" };
      }
      if (status !== "completed") {
        throw new Error(status === "failed" || status === "incomplete" || status === "cancelled"
          ? `deepseek_response_${status}`
          : "deepseek_response_not_completed");
      }
      try {
        const completed = normalizeCompletedOpenAIResponse(
          response,
          providerResponseId,
          "deepseek"
        );
        for (const event of completed.events) yield event;
        return completed.result;
      } catch (error) {
        throw deepSeekResponseError(error);
      }
    }
  };
}

export { createFetchDeepSeekResponsesClient } from "./deepSeekResponsesTransport";
