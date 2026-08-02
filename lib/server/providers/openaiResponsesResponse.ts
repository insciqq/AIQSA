import { safeExternalHref } from "../../domain/links";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { parseSseStream } from "./sse";
import type { ProviderRunResult } from "./types";
import { visibleAnswerText } from "./visibleAnswer";

const responseStatuses = new Set([
  "cancelled",
  "completed",
  "failed",
  "in_progress",
  "incomplete",
  "queued"
]);
const terminalStatuses = new Set(["cancelled", "completed", "failed", "incomplete"]);

type OpenAIResponseRecord = Readonly<Record<string, unknown>>;

export type NormalizedCompletedOpenAIResponse = Readonly<{
  events: ModelRunSseEvent[];
  result: ProviderRunResult;
}>;

export type OpenAIResponseSummaryInput = Readonly<{
  attempt?: number;
  background?: unknown;
  error?: Record<string, unknown>;
  providerResponseId?: string;
  provider?: string;
  status: string;
  stream?: unknown;
}>;

export type ParseOpenAIResponsesSseInput = Readonly<{
  background: unknown;
  idleTimeoutMs: number;
  provider?: string;
  responseBody: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  stream: unknown;
}>;

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function openAIResponseStatus(response: OpenAIResponseRecord): string {
  const status = stringValue(response.status);
  return status && responseStatuses.has(status) ? status : "unknown";
}

export function shouldPollOpenAIResponse(response: OpenAIResponseRecord): boolean {
  const status = openAIResponseStatus(response);
  return status === "queued" || status === "in_progress";
}

export function isFailedOpenAIResponse(response: OpenAIResponseRecord): boolean {
  const status = openAIResponseStatus(response);
  return status === "cancelled" || status === "failed" || status === "incomplete";
}

export function isTerminalOpenAIResponse(response: OpenAIResponseRecord): boolean {
  return terminalStatuses.has(openAIResponseStatus(response));
}

function extractOpenAIText(response: OpenAIResponseRecord): string {
  const outputText = stringValue(response.output_text);
  if (outputText) {
    return outputText;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const block of item.content) {
      if (isRecord(block) && block.type === "output_text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }

  return parts.join("");
}

export function extractOpenAIUsage(response: OpenAIResponseRecord): ModelRunUsage {
  const usage = typeof response.usage === "object" && response.usage !== null ? response.usage : {};

  return normalizeTokenUsage({
    cachedInputTokens: numberValue(valueAtPath(usage, ["input_tokens_details", "cached_tokens"])),
    cacheWriteInputTokens: numberValue(valueAtPath(usage, ["input_tokens_details", "cache_write_tokens"])),
    inputTokens: numberValue(valueAtPath(usage, ["input_tokens"])),
    outputTokens: numberValue(valueAtPath(usage, ["output_tokens"])),
    reasoningTokens: numberValue(valueAtPath(usage, ["output_tokens_details", "reasoning_tokens"])),
    totalTokens: numberValue(valueAtPath(usage, ["total_tokens"]))
  });
}

function summarizeOutput(response: OpenAIResponseRecord): Record<string, unknown>[] {
  const output = Array.isArray(response.output) ? response.output : [];

  return output.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    return [
      {
        ...(item.action !== undefined ? { action: item.action } : {}),
        ...(item.id !== undefined ? { id: item.id } : {}),
        ...(item.status !== undefined ? { status: item.status } : {}),
        type: item.type
      }
    ];
  });
}

function toolContinuationItems(response: OpenAIResponseRecord): Record<string, unknown>[] {
  const output = Array.isArray(response.output) ? response.output : [];

  return output.filter((item): item is Record<string, unknown> => {
    return isRecord(item) && (item.type === "function_call" || item.type === "reasoning");
  });
}

function extractArtifacts(response: OpenAIResponseRecord): ModelRunSseEvent[] {
  const output = Array.isArray(response.output) ? response.output : [];
  const artifacts: ModelRunSseEvent[] = [];

  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "web_search_call") {
      artifacts.push({
        data: {
          artifactType: "search",
          payload: {
            ...(item.action !== undefined ? { action: item.action } : {}),
            id: item.id,
            status: item.status,
            type: item.type
          }
        },
        type: "artifact"
      });
    }

    if (item.type === "reasoning") {
      artifacts.push({
        data: {
          artifactType: "reasoning",
          payload: {
            id: item.id,
            summary: item.summary,
            type: item.type
          }
        },
        type: "artifact"
      });
    }

    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }

      const annotations = Array.isArray(block.annotations) ? block.annotations : [];
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") {
          continue;
        }

        const url = safeExternalHref(annotation.url);
        if (!url) {
          continue;
        }

        artifacts.push({
          data: {
            artifactType: "citation",
            payload: {
              title: annotation.title,
              type: annotation.type,
              url
            }
          },
          type: "artifact"
        });
      }
    }
  }

  return artifacts;
}

function buildResponsePreview(
  response: OpenAIResponseRecord,
  finalText: string,
  rawText = finalText,
  provider = "openai"
): Record<string, unknown> {
  return {
    id: response.id,
    model: response.model,
    output: summarizeOutput(response),
    provider,
    rawText: rawText === finalText ? undefined : rawText,
    status: response.status,
    text: finalText,
    usage: response.usage
  };
}

export function openAIResponseSummaryEvent(input: OpenAIResponseSummaryInput): ModelRunSseEvent {
  return {
    data: {
      artifactType: "summary",
      payload: {
        ...(typeof input.attempt === "number" ? { attempt: input.attempt } : {}),
        ...(typeof input.background !== "undefined" ? { background: input.background } : {}),
        provider: input.provider ?? "openai",
        responseId: input.providerResponseId,
        status: input.status,
        ...(input.error ? { error: input.error } : {}),
        ...(typeof input.stream !== "undefined" ? { stream: input.stream } : {})
      }
    },
    type: "artifact"
  };
}

function normalizeOpenAIResponseResult(
  response: OpenAIResponseRecord,
  providerResponseId: string | undefined,
  fallbackRawText = "",
  provider = "openai"
): Readonly<{ artifacts: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const rawFinalText = extractOpenAIText(response) || fallbackRawText;
  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = openAIResponsesToolBridge.parseToolCalls(response);

  return {
    artifacts: extractArtifacts(response),
    result: {
      finalProviderResponsePreview: buildResponsePreview(response, finalText, rawFinalText, provider),
      finalText,
      providerToolCallMessage: toolCalls.length > 0 ? toolContinuationItems(response) : undefined,
      providerResponseId,
      toolCalls,
      usage: extractOpenAIUsage(response)
    }
  };
}

export function normalizeCompletedOpenAIResponse(
  response: OpenAIResponseRecord,
  providerResponseId?: string,
  provider = "openai"
): NormalizedCompletedOpenAIResponse {
  if (openAIResponseStatus(response) !== "completed") {
    throw new Error("openai_response_not_completed");
  }

  const normalized = normalizeOpenAIResponseResult(response, providerResponseId, "", provider);
  const events = [...normalized.artifacts];

  if (normalized.result.finalText) {
    events.push({
      data: {
        delta: normalized.result.finalText
      },
      type: "token"
    });
  }

  return {
    events,
    result: normalized.result
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function responseFromStreamPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  return recordValue(payload.response) ?? (payload.status || payload.output || payload.output_text ? payload : null);
}

function providerResponseIdFromStreamPayload(
  payload: Record<string, unknown>,
  response?: Record<string, unknown> | null
): string | undefined {
  return (
    stringValue(response?.id) ??
    stringValue(payload.response_id) ??
    stringValue(payload.responseId) ??
    stringValue(payload.id)
  );
}

function streamErrorCode(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType === "error") {
    return "openai_stream_error";
  }

  const error = recordValue(payload.error);
  if (error && !eventType.startsWith("response.completed")) {
    return "openai_stream_error";
  }

  return null;
}

function webSearchLifecycleArtifact(input: Readonly<{
  eventType: string;
  payload: Record<string, unknown>;
  providerResponseId?: string;
}>): ModelRunSseEvent | null {
  const item = recordValue(input.payload.item);
  const isWebSearchItem = item?.type === "web_search_call";
  const lifecyclePrefix = "response.web_search_call.";
  const isLifecycleEvent = input.eventType.startsWith(lifecyclePrefix);

  if (!isLifecycleEvent && !isWebSearchItem) {
    return null;
  }

  const lifecycleStatus = isLifecycleEvent ? input.eventType.slice(lifecyclePrefix.length) : undefined;
  const status = lifecycleStatus || stringValue(item?.status) || stringValue(input.payload.status) || "in_progress";

  return {
    data: {
      artifactType: "search",
      payload: {
        ...(item?.action !== undefined ? { action: item.action } : {}),
        eventType: input.eventType,
        id: stringValue(item?.id) ?? stringValue(input.payload.item_id) ?? stringValue(input.payload.id),
        outputIndex: input.payload.output_index,
        responseId: input.providerResponseId,
        status,
        type: "web_search_call"
      }
    },
    type: "artifact"
  };
}

export async function* parseOpenAIResponsesSse(
  input: ParseOpenAIResponsesSseInput
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  let providerResponseId: string | undefined;
  let finalResponse: Record<string, unknown> | null = null;
  let rawFinalText = "";
  let summaryEmitted = false;
  let terminalSeen = false;

  for await (const event of parseSseStream(input.responseBody, {
    idleTimeoutMs: input.idleTimeoutMs,
    signal: input.signal
  })) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new Error("openai_stream_truncated");
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const eventType = stringValue(parsed.type) ?? event.event;
    const failureStatus =
      eventType === "response.failed" || eventType === "response.incomplete" || eventType === "response.cancelled"
        ? eventType.replace("response.", "")
        : null;
    const response = responseFromStreamPayload(parsed);
    providerResponseId = providerResponseIdFromStreamPayload(parsed, response) ?? providerResponseId;
    if (response && isRecord(response.usage)) {
      yield {
        data: extractOpenAIUsage(response),
        type: "usage"
      };
    }

    const errorCode = streamErrorCode(eventType, parsed);
    if (errorCode) {
      throw new Error(errorCode);
    }

    if (eventType === "response.completed") {
      const status = response ? stringValue(response.status) : undefined;
      if (status !== "completed") {
        if (status === "failed" || status === "incomplete" || status === "cancelled") {
          throw new Error(`openai_response_${status}`);
        }

        throw new Error("openai_stream_truncated");
      }
    }

    if (!summaryEmitted && (providerResponseId || eventType === "response.created")) {
      summaryEmitted = true;
      yield openAIResponseSummaryEvent({
        background: input.background,
        provider: input.provider,
        providerResponseId,
        status: failureStatus ?? (response ? openAIResponseStatus(response) : "streaming"),
        stream: input.stream
      });
    }

    const searchArtifact = webSearchLifecycleArtifact({
      eventType,
      payload: parsed,
      providerResponseId
    });
    if (searchArtifact) {
      yield searchArtifact;
    }

    if (eventType === "response.output_text.delta" && typeof parsed.delta === "string") {
      rawFinalText += parsed.delta;
      yield {
        data: {
          delta: parsed.delta
        },
        type: "token"
      };
      continue;
    }

    if (eventType === "response.completed" && response) {
      terminalSeen = true;
      finalResponse = response;
      break;
    }

    if (failureStatus) {
      throw new Error(`openai_response_${failureStatus}`);
    }
  }

  if (!terminalSeen || !finalResponse) {
    throw new Error("openai_stream_truncated");
  }

  if (!summaryEmitted) {
    yield openAIResponseSummaryEvent({
      background: input.background,
      provider: input.provider,
      providerResponseId,
      status: openAIResponseStatus(finalResponse),
      stream: input.stream
    });
  }

  const normalized = normalizeOpenAIResponseResult(
    finalResponse,
    providerResponseId,
    rawFinalText,
    input.provider
  );

  for (const artifact of normalized.artifacts) {
    yield artifact;
  }

  return normalized.result;
}
