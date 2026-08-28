import { safeExternalHref } from "../../domain/links";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { openAIResponsesToolBridge } from "../tools/bridges";
import {
  assertBoundedStructuredTextLength,
  BoundedTextAccumulator
} from "./boundedText";
import {
  resolveProviderStreamLimits,
  type ProviderStreamLimits
} from "./network";
import { parseSseStream } from "./sse";
import {
  providerStreamSafetySnapshot,
  type ProviderStreamSafetySnapshot
} from "./streamSafety";
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
const MAX_OPENAI_TOOL_CALLS = 16;
const MAX_OPENAI_TOOL_ID_LENGTH = 512;
const MAX_OPENAI_TOOL_NAME_LENGTH = 512;

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
  provider?: string;
  responseBody: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  stream: unknown;
  streamLimits?: Partial<ProviderStreamLimits>;
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

function nonBlankStringValue(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate?.trim() ? candidate : undefined;
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

export function resolveOpenAIResponseIdentity(
  response: OpenAIResponseRecord,
  pinnedProviderResponseId?: string
): string | undefined {
  const pinnedId = nonBlankStringValue(pinnedProviderResponseId);
  const responseId = nonBlankStringValue(response.id);
  if (pinnedId && responseId && pinnedId !== responseId) {
    throw new Error("openai_response_identity_mismatch");
  }

  return pinnedId ?? responseId;
}

function extractOpenAIText(
  response: OpenAIResponseRecord,
  maxOutputChars?: number,
  snapshot?: ProviderStreamSafetySnapshot | null
): string {
  const outputText = stringValue(response.output_text);
  if (outputText) {
    if (maxOutputChars !== undefined) {
      return new BoundedTextAccumulator({
        initialValue: outputText,
        maxChars: maxOutputChars,
        retainedTextKind: "visible_output",
        snapshot
      }).value();
    }
    return outputText;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const accumulator = maxOutputChars === undefined
    ? null
    : new BoundedTextAccumulator({
        maxChars: maxOutputChars,
        retainedTextKind: "visible_output"
      });
  const parts: string[] = [];

  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const block of item.content) {
      if (isRecord(block) && block.type === "output_text" && typeof block.text === "string") {
        if (accumulator) {
          accumulator.append(block.text, snapshot);
        } else {
          parts.push(block.text);
        }
      }
    }
  }

  return accumulator?.value() ?? parts.join("");
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

function assertValidOpenAIFunctionCalls(response: OpenAIResponseRecord): void {
  const output = Array.isArray(response.output) ? response.output : [];
  let toolCallCount = 0;

  for (const item of output) {
    if (!isRecord(item) || item.type !== "function_call") continue;

    toolCallCount += 1;
    const id = typeof item.call_id === "string" ? item.call_id : stringValue(item.id);
    const name = nonBlankStringValue(item.name);
    if (
      toolCallCount > MAX_OPENAI_TOOL_CALLS ||
      !id?.trim() ||
      id.length > MAX_OPENAI_TOOL_ID_LENGTH ||
      !name ||
      name.length > MAX_OPENAI_TOOL_NAME_LENGTH
    ) {
      throw new Error("openai_response_tool_call_invalid");
    }
  }
}

function assertBoundedOpenAIRetainedOutput(
  response: OpenAIResponseRecord,
  maxOutputChars: number,
  snapshot: ProviderStreamSafetySnapshot | null
): void {
  const output = Array.isArray(response.output) ? response.output : [];
  let reasoningCharacters = 0;

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "reasoning") {
      for (const value of [item.summary, item.content, item.encrypted_content]) {
        reasoningCharacters = assertBoundedStructuredTextLength({
          currentChars: reasoningCharacters,
          maxChars: maxOutputChars,
          retainedTextKind: "reasoning",
          snapshot,
          value
        });
      }
    }
    if (item.type !== "function_call") continue;

    assertBoundedStructuredTextLength({
      maxChars: maxOutputChars,
      retainedTextKind: "tool_arguments",
      snapshot,
      value: item.arguments
    });
  }
}

function extractArtifacts(
  response: OpenAIResponseRecord,
  provider = "openai"
): ModelRunSseEvent[] {
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
            ...(provider === "deepseek"
              ? { provider, sourceAttribution: "provider_unavailable" }
              : {}),
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
  provider = "openai",
  providerResponseId?: string
): Record<string, unknown> {
  return {
    id: providerResponseId,
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
  streamedRawText: string | undefined,
  provider = "openai",
  maxOutputChars?: number,
  snapshot?: ProviderStreamSafetySnapshot | null
): Readonly<{ artifacts: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const normalizedProviderResponseId = resolveOpenAIResponseIdentity(
    response,
    providerResponseId
  );
  assertValidOpenAIFunctionCalls(response);
  if (maxOutputChars !== undefined) {
    assertBoundedOpenAIRetainedOutput(response, maxOutputChars, snapshot ?? null);
  }
  const terminalRawText = extractOpenAIText(response, maxOutputChars, snapshot);
  if (streamedRawText !== undefined && terminalRawText !== streamedRawText) {
    throw new Error("openai_response_terminal_text_mismatch");
  }
  const rawFinalText = terminalRawText || streamedRawText || "";
  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = openAIResponsesToolBridge.parseToolCalls(response);

  return {
    artifacts: extractArtifacts(response, provider),
    result: {
      finalProviderResponsePreview: buildResponsePreview(
        response,
        finalText,
        rawFinalText,
        provider,
        normalizedProviderResponseId
      ),
      finalText,
      providerToolCallMessage: toolCalls.length > 0 ? toolContinuationItems(response) : undefined,
      providerResponseId: normalizedProviderResponseId,
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

  const normalized = normalizeOpenAIResponseResult(response, providerResponseId, undefined, provider);
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

function responseFromStreamPayload(
  eventType: string,
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  const nestedResponse = recordValue(payload.response);
  if (nestedResponse) {
    return nestedResponse;
  }

  return /^(?:response\.)?(?:created|queued|in_progress|completed|failed|incomplete|cancelled)$/.test(
    eventType
  )
    ? payload
    : null;
}

function providerResponseIdsFromStreamPayload(
  payload: Record<string, unknown>,
  response?: Record<string, unknown> | null
): string[] {
  return [
    nonBlankStringValue(response?.id),
    nonBlankStringValue(payload.response_id),
    nonBlankStringValue(payload.responseId),
    ...(response === payload ? [nonBlankStringValue(payload.id)] : [])
  ].filter((value): value is string => value !== undefined);
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
  provider?: string;
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
        ...(input.provider === "deepseek"
          ? { provider: input.provider, sourceAttribution: "provider_unavailable" }
          : {}),
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
  const streamLimits = resolveProviderStreamLimits(input.streamLimits);
  let providerResponseId: string | undefined;
  let finalResponse: Record<string, unknown> | null = null;
  let streamedRawText: BoundedTextAccumulator | undefined;
  let summaryEmitted = false;
  let publishedProviderResponseId: string | undefined;
  let terminalSeen = false;
  let latestSnapshot: ProviderStreamSafetySnapshot | null = null;

  for await (const event of parseSseStream(input.responseBody, {
    idleTimeoutMs: streamLimits.idleTimeoutMs,
    maxBytes: streamLimits.maxBytes,
    maxDurationMs: streamLimits.maxDurationMs,
    maxEventBytes: streamLimits.maxEventBytes,
    signal: input.signal
  })) {
    latestSnapshot = providerStreamSafetySnapshot(event);
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
    const response = responseFromStreamPayload(eventType, parsed);
    for (const candidateResponseId of providerResponseIdsFromStreamPayload(parsed, response)) {
      if (providerResponseId && candidateResponseId !== providerResponseId) {
        throw new Error("openai_response_identity_mismatch");
      }
      providerResponseId ??= candidateResponseId;
    }
    const isCompletedEvent = eventType === "response.completed";
    if (!isCompletedEvent && response && isRecord(response.usage)) {
      yield {
        data: extractOpenAIUsage(response),
        type: "usage"
      };
    }

    const errorCode = streamErrorCode(eventType, parsed);
    if (errorCode) {
      throw new Error(errorCode);
    }

    if (isCompletedEvent) {
      const status = response ? stringValue(response.status) : undefined;
      if (status !== "completed") {
        if (status === "failed" || status === "incomplete" || status === "cancelled") {
          throw new Error(`openai_response_${status}`);
        }

        throw new Error("openai_stream_truncated");
      }
    }

    const shouldPublishIdentity =
      providerResponseId !== undefined && providerResponseId !== publishedProviderResponseId;
    if (
      !isCompletedEvent &&
      ((!summaryEmitted && eventType === "response.created") || shouldPublishIdentity)
    ) {
      summaryEmitted = true;
      publishedProviderResponseId = providerResponseId;
      yield openAIResponseSummaryEvent({
        background: input.background,
        provider: input.provider,
        providerResponseId,
        status: failureStatus ?? (response ? openAIResponseStatus(response) : "streaming"),
        stream: input.stream
      });
    }

    const searchArtifact = isCompletedEvent
      ? null
      : webSearchLifecycleArtifact({
          eventType,
          payload: parsed,
          provider: input.provider,
          providerResponseId
        });
    if (searchArtifact) {
      yield searchArtifact;
    }

    if (eventType === "response.output_text.delta" && typeof parsed.delta === "string") {
      streamedRawText ??= new BoundedTextAccumulator({
        maxChars: streamLimits.maxOutputChars,
        retainedTextKind: "visible_output"
      });
      streamedRawText.append(parsed.delta, latestSnapshot);
      yield {
        data: {
          delta: parsed.delta
        },
        type: "token"
      };
      continue;
    }

    if (isCompletedEvent && response) {
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

  const normalized = normalizeOpenAIResponseResult(
    finalResponse,
    providerResponseId,
    streamedRawText?.value(),
    input.provider,
    streamLimits.maxOutputChars,
    latestSnapshot
  );

  if (
    !summaryEmitted ||
    (providerResponseId !== undefined && providerResponseId !== publishedProviderResponseId)
  ) {
    yield openAIResponseSummaryEvent({
      background: input.background,
      provider: input.provider,
      providerResponseId,
      status: openAIResponseStatus(finalResponse),
      stream: input.stream
    });
  }

  if (isRecord(finalResponse.usage)) {
    yield {
      data: extractOpenAIUsage(finalResponse),
      type: "usage"
    };
  }

  for (const artifact of normalized.artifacts) {
    yield artifact;
  }

  return normalized.result;
}
