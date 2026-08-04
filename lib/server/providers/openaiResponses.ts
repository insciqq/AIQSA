import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { createOpenAIResponsesLifecycle } from "./openaiResponsesLifecycle";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesRequestPreview
} from "./openaiResponsesRequest";
import {
  extractOpenAIUsage,
  isFailedOpenAIResponse,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus,
  openAIResponseSummaryEvent,
  parseOpenAIResponsesSse,
  shouldPollOpenAIResponse
} from "./openaiResponsesResponse";
import {
  createFetchOpenAIResponsesClient,
  type OpenAIResponsesClient
} from "./openaiResponsesTransport";
import type { ProviderAdapter, ProviderRunRefreshResult, ProviderRunResult } from "./types";

export { buildOpenAIResponsesRequest, createFetchOpenAIResponsesClient };
export type { OpenAIResponsesClient };

export type OpenAIResponsesAdapterOptions = {
  client: OpenAIResponsesClient;
  maxAttachmentTextChars?: number;
  /** Optional deterministic/defensive cap; elapsed time owns the production lifecycle deadline. */
  maxPolls?: number;
  maxRetryableRetrieveErrors?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

function responseId(response: Readonly<Record<string, unknown>>): string | undefined {
  return typeof response.id === "string" ? response.id : undefined;
}

export function createOpenAIResponsesAdapter(options: OpenAIResponsesAdapterOptions): ProviderAdapter {
  const lifecycle = createOpenAIResponsesLifecycle({
    client: options.client,
    maxPolls: options.maxPolls,
    maxRetryableRetrieveErrors: options.maxRetryableRetrieveErrors,
    pollIntervalMs: options.pollIntervalMs,
    pollTimeoutMs: options.pollTimeoutMs
  });

  return {
    buildRequestPreview: (request) =>
      buildOpenAIResponsesRequestPreview(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      }),
    cancel: (providerResponseId) => lifecycle.cancel(providerResponseId),
    async refresh(providerResponseId): Promise<ProviderRunRefreshResult> {
      const outcome = await lifecycle.refresh(providerResponseId);
      if (outcome.kind === "retry") {
        return {
          events: [
            openAIResponseSummaryEvent({
              error: outcome.error,
              providerResponseId,
              status: "retrying"
            })
          ],
          providerResponseId,
          status: "retrying",
          terminal: false
        };
      }

      const status = openAIResponseStatus(outcome.response);
      const events = [
        openAIResponseSummaryEvent({
          providerResponseId,
          status
        })
      ];

      if (shouldPollOpenAIResponse(outcome.response)) {
        return {
          events,
          providerResponseId,
          status,
          terminal: false
        };
      }

      if (isFailedOpenAIResponse(outcome.response)) {
        return {
          error: {
            code: `openai_response_${status}`,
            message: `OpenAI response ${status}`
          },
          events,
          providerResponseId,
          status,
          terminal: true
        };
      }

      if (status !== "completed") {
        return {
          error: {
            code: "openai_response_not_completed",
            message: "OpenAI response did not provide explicit completion proof"
          },
          events,
          providerResponseId,
          status,
          terminal: true
        };
      }

      const completed = normalizeCompletedOpenAIResponse(outcome.response, providerResponseId);

      return {
        events: [...events, ...completed.events],
        providerResponseId,
        result: completed.result,
        status,
        terminal: true
      };
    },
    retrieve: (providerResponseId) => lifecycle.retrieve(providerResponseId),
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildOpenAIResponsesRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars
      });
      if (body.stream === true) {
        const response = await lifecycle.openStream(body, {
          signal: runOptions.signal,
          ...(typeof runOptions.timeoutMs === "number" ? { timeoutMs: runOptions.timeoutMs } : {})
        });
        if (!response.body) {
          throw new Error("openai_stream_body_missing");
        }

        return yield* parseOpenAIResponsesSse({
          background: body.background,
          responseBody: response.body,
          signal: runOptions.signal,
          stream: body.stream
        });
      }

      const execution = lifecycle.createAndPoll(body, {
        signal: runOptions.signal,
        ...(typeof runOptions.timeoutMs === "number" ? { timeoutMs: runOptions.timeoutMs } : {})
      });
      let providerResponseId: string | undefined;
      let next = await execution.next();

      while (!next.done) {
        const observation = next.value;
        if (observation.kind === "created") {
          providerResponseId = responseId(observation.response);
          yield openAIResponseSummaryEvent({
            background: body.background,
            providerResponseId,
            status: openAIResponseStatus(observation.response),
            stream: body.stream
          });
        } else if (observation.kind === "retrieved") {
          yield openAIResponseSummaryEvent({
            attempt: observation.attempt,
            providerResponseId,
            status: openAIResponseStatus(observation.response)
          });
        } else {
          yield openAIResponseSummaryEvent({
            attempt: observation.attempt,
            error: observation.error,
            providerResponseId,
            status: "retrying"
          });
        }

        next = await execution.next();
      }

      const { response } = next.value;
      providerResponseId = next.value.providerResponseId;
      if (typeof response.usage === "object" && response.usage !== null) {
        yield {
          data: extractOpenAIUsage(response),
          type: "usage"
        };
      }
      if (isFailedOpenAIResponse(response)) {
        throw new Error(`openai_response_${openAIResponseStatus(response)}`);
      }
      if (openAIResponseStatus(response) !== "completed") {
        throw new Error("openai_response_not_completed");
      }

      const completed = normalizeCompletedOpenAIResponse(response, providerResponseId);
      for (const event of completed.events) {
        if (runOptions.signal?.aborted) {
          const error = new Error("provider_run_aborted");
          error.name = "AbortError";
          throw error;
        }
        yield event;
      }

      return completed.result;
    }
  };
}
