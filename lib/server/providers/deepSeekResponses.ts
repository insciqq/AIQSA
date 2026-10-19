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
import { providerResponseFailure } from "./responseFailure";
import { guardDeepSeekSynthesis } from "./deepSeekSynthesis";
import type { ProviderAdapter, ProviderRunResult } from "./types";

export function deepSeekNotCompletedCode(status: string): string {
  return status === "failed" || status === "incomplete" || status === "cancelled"
    ? `deepseek_response_${status}`
    : "deepseek_response_not_completed";
}

/** An incomplete response whose reported output reached the requested cap
 * exhausted its output budget even when DeepSeek names no incomplete reason. */
export function deepSeekTerminalResponse(
  response: Readonly<Record<string, unknown>>,
  body: Readonly<{ max_output_tokens: number }>
): Readonly<Record<string, unknown>> {
  if (openAIResponseStatus(response) !== "incomplete" || typeof response.incomplete_details === "object" &&
    response.incomplete_details !== null) return response;
  const usage = typeof response.usage === "object" && response.usage !== null
    ? response.usage as Record<string, unknown> : null;
  const outputTokens = usage?.output_tokens;
  return typeof outputTokens === "number" && Number.isSafeInteger(body.max_output_tokens) &&
    body.max_output_tokens > 0 && outputTokens >= body.max_output_tokens
    ? { ...response, incomplete_details: { reason: "max_output_tokens" } } : response;
}

export type DeepSeekResponsesAdapterOptions = Readonly<{
  client: DeepSeekResponsesClient;
  maxAttachmentTextChars?: number;
}>;

export function createDeepSeekResponsesAdapter(
  options: DeepSeekResponsesAdapterOptions
): ProviderAdapter {
  const adapter: ProviderAdapter = {
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
            onToolArguments: runOptions.onToolArguments,
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
        throw providerResponseFailure(deepSeekNotCompletedCode(status), deepSeekTerminalResponse(response, body));
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
  return {
    ...adapter,
    async *stream(request, runOptions) {
      const stream = adapter.stream(request, runOptions);
      return yield* (request.toolChoice === "none" ? guardDeepSeekSynthesis(stream) : stream);
    }
  };
}

export { createFetchDeepSeekResponsesClient } from "./deepSeekResponsesTransport";
