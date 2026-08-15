import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { openRouterChatToolBridge } from "../tools/bridges";
import {
  assertBoundedStructuredTextLength,
  assertBoundedTextLength,
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
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import { visibleAnswerText } from "./visibleAnswer";
import { normalizeSearchSources } from "../search/evidence";

export type OpenRouterResponseRecord = Readonly<Record<string, unknown>>;

export type OpenRouterResponseContext = Readonly<Pick<ProviderRunRequest, "modelId">>;

export const invalidOpenRouterTerminalResponseError =
  "openrouter_terminal_response_invalid";
const MAX_STREAMED_TOOL_CALLS = 16;
const MAX_TOOL_CALL_ID_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 512;
const MAX_TOOL_TYPE_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

function firstChoice(response: OpenRouterResponseRecord): Record<string, unknown> | null {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0];

  return isRecord(first) ? first : null;
}

function firstMessage(response: OpenRouterResponseRecord): Record<string, unknown> | null {
  const message = firstChoice(response)?.message;

  return isRecord(message) ? message : null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }

      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function hasUsableTextContent(content: unknown): boolean {
  if (typeof content === "string") {
    return Boolean(content.trim());
  }

  return (
    Array.isArray(content) &&
    content.some(
      (part) => isRecord(part) && typeof part.text === "string" && Boolean(part.text.trim())
    )
  );
}

function isValidToolCall(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    !value.function.name.trim()
  ) {
    return false;
  }

  const argumentsValue = value.function.arguments;
  return (
    argumentsValue === undefined ||
    typeof argumentsValue === "string" ||
    isRecord(argumentsValue)
  );
}

export function assertValidOpenRouterTerminalResponse(
  response: OpenRouterResponseRecord,
  options: Readonly<{ allowToolCalls?: boolean }> = {}
): void {
  const message = firstMessage(response);
  if (!message) {
    throw new Error(invalidOpenRouterTerminalResponseError);
  }

  if (hasUsableTextContent(message.content)) {
    return;
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (
    options.allowToolCalls !== false &&
    toolCalls.length > 0 &&
    toolCalls.every(isValidToolCall)
  ) {
    return;
  }

  throw new Error(invalidOpenRouterTerminalResponseError);
}

export function extractOpenRouterText(response: OpenRouterResponseRecord): string {
  return extractTextContent(firstMessage(response)?.content);
}

export function extractOpenRouterUsage(response: OpenRouterResponseRecord): ModelRunUsage {
  const usage = isRecord(response.usage) ? response.usage : {};

  return normalizeTokenUsage({
    cachedInputTokens:
      numberValue(valueAtPath(usage, ["prompt_tokens_details", "cached_tokens"])) ||
      numberValue(valueAtPath(usage, ["input_tokens_details", "cached_tokens"])),
    cacheWriteInputTokens:
      numberValue(usage.cache_write_tokens) ||
      numberValue(usage.cache_write_input_tokens) ||
      numberValue(usage.cache_creation_input_tokens) ||
      numberValue(valueAtPath(usage, ["prompt_tokens_details", "cache_write_tokens"])) ||
      numberValue(valueAtPath(usage, ["input_tokens_details", "cache_write_tokens"])),
    inputTokens: numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.completion_tokens) || numberValue(usage.output_tokens),
    reasoningTokens:
      numberValue(usage.reasoning_tokens) ||
      numberValue(valueAtPath(usage, ["completion_tokens_details", "reasoning_tokens"])) ||
      numberValue(valueAtPath(usage, ["output_tokens_details", "reasoning_tokens"])),
    totalTokens: numberValue(usage.total_tokens)
  });
}

function citationFromValue(
  value: unknown,
  index: number,
  shape: "annotation" | "flat"
): Record<string, unknown> | null {
  let candidate: Record<string, unknown> | null = null;
  if (shape === "annotation") {
    if (!isRecord(value)) return null;
    if (value.type === undefined) {
      candidate = {
        snippet: value.snippet ?? value.content,
        title: value.title ?? `Source ${index + 1}`,
        url: value.url ?? value.href
      };
    } else {
      if (value.type !== "url_citation" || !isRecord(value.url_citation)) return null;
      candidate = {
        snippet: value.url_citation.content ?? value.url_citation.snippet,
        title: value.url_citation.title ?? `Source ${index + 1}`,
        url: value.url_citation.url ?? value.url_citation.href
      };
    }
  } else if (typeof value === "string") {
    candidate = { title: `Source ${index + 1}`, url: value };
  } else if (isRecord(value)) {
    if (value.type === "url_citation") {
      if (!isRecord(value.url_citation)) return null;
      candidate = {
        snippet: value.url_citation.content ?? value.url_citation.snippet,
        title: value.url_citation.title ?? `Source ${index + 1}`,
        url: value.url_citation.url ?? value.url_citation.href
      };
    } else {
      candidate = {
        snippet: value.snippet ?? value.content,
        title: value.title ?? `Source ${index + 1}`,
        url: value.url ?? value.href
      };
    }
  }
  if (!candidate) return null;
  const source = normalizeSearchSources([candidate], 1)[0];
  return source
    ? {
        index: index + 1,
        snippet: source.snippet,
        title: source.title,
        url: source.url
      }
    : null;
}

function citationArtifacts(
  values: unknown,
  source: string,
  shape: "annotation" | "flat" = "flat"
): ModelRunSseEvent[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const artifacts: ModelRunSseEvent[] = [];

  for (const [index, value] of values.entries()) {
    const citation = citationFromValue(value, index, shape);
    if (!citation) {
      continue;
    }

    const key = String(citation.url);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    artifacts.push({
      data: {
        artifactType: "citation",
        payload: {
          ...citation,
          source
        }
      },
      type: "artifact"
    });
  }

  return artifacts;
}

function appendCitationArtifacts(
  target: ModelRunSseEvent[],
  values: unknown,
  source: string,
  shape: "annotation" | "flat" = "flat"
): void {
  for (const artifact of citationArtifacts(values, source, shape)) {
    target.push(artifact);
  }
}

export function extractOpenRouterArtifacts(response: OpenRouterResponseRecord): ModelRunSseEvent[] {
  const message = firstMessage(response);
  const artifacts: ModelRunSseEvent[] = [];
  const reasoning = message?.reasoning ?? message?.reasoning_details ?? response.reasoning_details;

  if (reasoning) {
    artifacts.push({
      data: {
        artifactType: "reasoning",
        payload: {
          reasoning
        }
      },
      type: "artifact"
    });
  }

  appendCitationArtifacts(artifacts, response.citations, "openrouter");
  appendCitationArtifacts(
    artifacts,
    message?.citations,
    "openrouter-message"
  );
  appendCitationArtifacts(
    artifacts,
    message?.annotations,
    "openrouter-annotations",
    "annotation"
  );

  return artifacts;
}

export function buildOpenRouterResponsePreview(
  response: OpenRouterResponseRecord,
  finalText: string,
  rawText = finalText
): Record<string, unknown> {
  return {
    citations: response.citations,
    finishReason: firstChoice(response)?.finish_reason,
    id: response.id,
    model: response.model,
    object: response.object,
    provider: "openrouter",
    rawText: rawText === finalText ? undefined : rawText,
    text: finalText,
    usage: response.usage
  };
}

export function openRouterProviderResponseId(response: OpenRouterResponseRecord): string | undefined {
  return stringValue(response.id);
}

function openRouterStreamError(response: OpenRouterResponseRecord): string | null {
  if (!isRecord(response.error)) {
    return null;
  }

  return "openrouter_response_error";
}

export function openRouterResponseError(response: OpenRouterResponseRecord): string | null {
  const topLevelError = openRouterStreamError(response);
  if (topLevelError) {
    return topLevelError;
  }

  const choice = firstChoice(response);
  if (isRecord(choice?.error)) {
    return "openrouter_response_error";
  }

  const message = isRecord(choice?.message) ? choice.message : null;
  if (isRecord(message?.error)) {
    return "openrouter_response_error";
  }

  return null;
}

function deltaText(delta: Record<string, unknown>): string {
  if (typeof delta.content === "string") {
    return delta.content;
  }

  return extractTextContent(delta.content);
}

function reasoningFromDelta(delta: Record<string, unknown>): unknown {
  return delta.reasoning ?? delta.reasoning_details;
}

function pushBoundedStructuredArray(
  target: unknown[],
  value: unknown,
  currentChars: number,
  maxOutputChars: number,
  snapshot: ProviderStreamSafetySnapshot | null
): number {
  if (!Array.isArray(value)) {
    return currentChars;
  }
  if (value.length === 0) {
    return currentChars;
  }
  const nextChars = assertBoundedStructuredTextLength({
    currentChars: target.length > 0 ? currentChars - 1 : currentChars,
    maxChars: maxOutputChars,
    retainedTextKind: "citations",
    snapshot,
    value
  });
  for (const item of value) {
    target.push(item);
  }
  return nextChars;
}

type StreamedOpenRouterToolCall = {
  arguments: BoundedTextAccumulator | Record<string, unknown>;
  id?: string;
  index: number;
  name?: string;
  type?: string;
};

function accumulateStreamedToolCalls(
  target: Map<number, StreamedOpenRouterToolCall>,
  value: unknown,
  maxOutputChars: number,
  snapshot: ProviderStreamSafetySnapshot | null,
  replaceArguments = false
): void {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((candidate, ordinal) => {
    if (!isRecord(candidate)) {
      return;
    }

    const index =
      typeof candidate.index === "number" && Number.isInteger(candidate.index) && candidate.index >= 0
        ? candidate.index
        : ordinal;
    let existing = target.get(index);
    if (!existing) {
      if (target.size >= MAX_STREAMED_TOOL_CALLS) {
        throw new Error("openrouter_stream_tool_call_limit_exceeded");
      }
      existing = {
        arguments: new BoundedTextAccumulator({
          maxChars: maxOutputChars,
          retainedTextKind: "tool_arguments"
        }),
        index
      };
    }
    const fn = isRecord(candidate.function) ? candidate.function : {};

    if (typeof candidate.id === "string" && candidate.id) {
      if (candidate.id.length > MAX_TOOL_CALL_ID_LENGTH) {
        throw new Error("openrouter_stream_tool_call_invalid");
      }
      existing.id = candidate.id;
    }
    if (typeof candidate.type === "string" && candidate.type) {
      if (candidate.type.length > MAX_TOOL_TYPE_LENGTH) {
        throw new Error("openrouter_stream_tool_call_invalid");
      }
      existing.type = candidate.type;
    }
    if (typeof fn.name === "string" && fn.name) {
      if (fn.name.length > MAX_TOOL_NAME_LENGTH) {
        throw new Error("openrouter_stream_tool_call_invalid");
      }
      existing.name = fn.name;
    }
    if (isRecord(fn.arguments)) {
      assertBoundedStructuredTextLength({
        maxChars: maxOutputChars,
        retainedTextKind: "tool_arguments",
        snapshot,
        value: fn.arguments
      });
      existing.arguments = fn.arguments;
    } else if (typeof fn.arguments === "string") {
      if (replaceArguments || !(existing.arguments instanceof BoundedTextAccumulator)) {
        existing.arguments = new BoundedTextAccumulator({
          initialValue: fn.arguments,
          maxChars: maxOutputChars,
          retainedTextKind: "tool_arguments",
          snapshot
        });
      } else {
        existing.arguments.append(fn.arguments, snapshot);
      }
    }

    target.set(index, existing);
  });
}

function streamedToolCalls(target: ReadonlyMap<number, StreamedOpenRouterToolCall>): Record<string, unknown>[] {
  return [...target.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      function: {
        arguments: call.arguments instanceof BoundedTextAccumulator
          ? call.arguments.value()
          : call.arguments,
        name: call.name
      },
      id: call.id,
      type: call.type ?? "function"
    }));
}

export async function* streamOpenRouterJsonResponse(
  response: OpenRouterResponseRecord,
  request: OpenRouterResponseContext
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  const responseError = openRouterResponseError(response);
  if (responseError) {
    throw new Error(responseError);
  }
  assertValidOpenRouterTerminalResponse(response);

  const rawFinalText = extractOpenRouterText(response);
  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = openRouterChatToolBridge.parseToolCalls(response);
  if (!finalText && toolCalls.length === 0) {
    throw new Error(invalidOpenRouterTerminalResponseError);
  }
  const toolCallMessage = toolCalls.length > 0 ? firstMessage(response) ?? undefined : undefined;

  yield {
    data: {
      artifactType: "summary",
      payload: {
        model: response.model ?? request.modelId,
        provider: "openrouter",
        responseId: openRouterProviderResponseId(response),
        stage: "answer"
      }
    },
    type: "artifact"
  };

  for (const artifact of extractOpenRouterArtifacts(response)) {
    yield artifact;
  }

  if (finalText) {
    yield {
      data: {
        delta: finalText
      },
      type: "token"
    };
  }

  return {
    finalProviderResponsePreview: buildOpenRouterResponsePreview(response, finalText, rawFinalText),
    finalText,
    providerToolCallMessage: toolCallMessage,
    providerResponseId: openRouterProviderResponseId(response),
    toolCalls,
    usage: extractOpenRouterUsage(response)
  };
}

export async function* streamOpenRouterSseResponse(
  response: Response,
  request: OpenRouterResponseContext,
  signal?: AbortSignal,
  configuredStreamLimits?: Partial<ProviderStreamLimits>
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  if (!response.body) {
    throw new Error("openrouter_stream_body_missing");
  }

  const streamLimits = resolveProviderStreamLimits(configuredStreamLimits);
  let responseId: string | undefined = response.headers.get("x-generation-id") ?? undefined;
  let model: unknown = request.modelId;
  let object: unknown = "chat.completion.chunk";
  let finishReason: unknown = null;
  const rawFinalText = new BoundedTextAccumulator({
    maxChars: streamLimits.maxOutputChars,
    retainedTextKind: "visible_output"
  });
  let usage: ModelRunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  };
  let rawUsage: unknown = null;
  let summaryEmitted = false;
  let terminalSeen = false;
  const citations: unknown[] = [];
  const messageCitations: unknown[] = [];
  const annotations: unknown[] = [];
  const reasoningParts: unknown[] = [];
  let reasoningCharacters = 0;
  let reasoningUsesArray = false;
  let citationCharacters = 0;
  const toolCallParts = new Map<number, StreamedOpenRouterToolCall>();

  for await (const event of parseSseStream(response.body, {
    idleTimeoutMs: streamLimits.idleTimeoutMs,
    maxBytes: streamLimits.maxBytes,
    maxDurationMs: streamLimits.maxDurationMs,
    maxEventBytes: streamLimits.maxEventBytes,
    signal
  })) {
    const snapshot = providerStreamSafetySnapshot(event);
    if (event.data === "[DONE]") {
      terminalSeen = true;
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new Error("openrouter_stream_truncated");
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const streamError = openRouterResponseError(parsed);
    if (streamError) {
      throw new Error("openrouter_stream_error");
    }

    responseId = stringValue(parsed.id) ?? responseId;
    model = parsed.model ?? model;
    object = parsed.object ?? object;
    citationCharacters = pushBoundedStructuredArray(
      citations,
      parsed.citations,
      citationCharacters,
      streamLimits.maxOutputChars,
      snapshot
    );
    let reportedUsage: ModelRunUsage | null = null;
    if (isRecord(parsed.usage)) {
      rawUsage = parsed.usage;
      usage = extractOpenRouterUsage(parsed);
      reportedUsage = usage;
    }

    if (!summaryEmitted) {
      summaryEmitted = true;
      yield {
        data: {
          artifactType: "summary",
          payload: {
            model,
            provider: "openrouter",
            responseId,
            stage: "answer"
          }
        },
        type: "artifact"
      };
    }

    if (reportedUsage) {
      yield {
        data: reportedUsage,
        type: "usage"
      };
    }

    const choice = firstChoice(parsed);
    if (!choice) {
      continue;
    }

    finishReason = choice.finish_reason ?? finishReason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const message = isRecord(choice.message) ? choice.message : {};
    accumulateStreamedToolCalls(
      toolCallParts,
      delta.tool_calls,
      streamLimits.maxOutputChars,
      snapshot
    );
    accumulateStreamedToolCalls(
      toolCallParts,
      message.tool_calls,
      streamLimits.maxOutputChars,
      snapshot,
      true
    );
    const text = deltaText(delta);
    if (text) {
      rawFinalText.append(text, snapshot);
      yield {
        data: {
          delta: text
        },
        type: "token"
      };
    }

    const reasoning = reasoningFromDelta(delta) ?? reasoningFromDelta(message) ?? parsed.reasoning_details;
    if (reasoning) {
      if (!reasoningUsesArray && typeof reasoning === "string") {
        reasoningCharacters = assertBoundedTextLength({
          currentChars: reasoningCharacters,
          fragment: reasoning,
          maxChars: streamLimits.maxOutputChars,
          retainedTextKind: "reasoning",
          snapshot
        });
      } else if (!reasoningUsesArray) {
        reasoningCharacters = assertBoundedStructuredTextLength({
          maxChars: streamLimits.maxOutputChars,
          retainedTextKind: "reasoning",
          snapshot,
          value: [...reasoningParts, reasoning]
        });
        reasoningUsesArray = true;
      } else {
        reasoningCharacters = assertBoundedStructuredTextLength({
          currentChars: reasoningCharacters - 1,
          maxChars: streamLimits.maxOutputChars,
          retainedTextKind: "reasoning",
          snapshot,
          value: [reasoning]
        });
      }
      reasoningParts.push(reasoning);
    }

    citationCharacters = pushBoundedStructuredArray(
      messageCitations,
      delta.citations,
      citationCharacters,
      streamLimits.maxOutputChars,
      snapshot
    );
    citationCharacters = pushBoundedStructuredArray(
      messageCitations,
      message.citations,
      citationCharacters,
      streamLimits.maxOutputChars,
      snapshot
    );
    citationCharacters = pushBoundedStructuredArray(
      annotations,
      delta.annotations,
      citationCharacters,
      streamLimits.maxOutputChars,
      snapshot
    );
    citationCharacters = pushBoundedStructuredArray(
      annotations,
      message.annotations,
      citationCharacters,
      streamLimits.maxOutputChars,
      snapshot
    );
  }

  if (!terminalSeen) {
    throw new Error("openrouter_stream_truncated");
  }

  if (!summaryEmitted) {
    yield {
      data: {
        artifactType: "summary",
        payload: {
          model,
          provider: "openrouter",
          responseId,
          stage: "answer"
        }
      },
      type: "artifact"
    };
  }

  const rawText = rawFinalText.value();
  const reasoning =
    reasoningParts.length === 0
      ? undefined
      : reasoningParts.every((part) => typeof part === "string")
        ? reasoningParts.join("")
        : reasoningParts;
  const rawToolCalls = streamedToolCalls(toolCallParts);
  const syntheticResponse = {
    citations,
    choices: [
      {
        finish_reason: finishReason,
        message: {
          annotations,
          citations: messageCitations,
          content: rawText || null,
          ...(reasoning ? { reasoning } : {}),
          role: "assistant",
          ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {})
        }
      }
    ],
    id: responseId,
    model,
    object,
    usage: rawUsage
  };
  const finalText = visibleAnswerText(rawText);
  const toolCalls = openRouterChatToolBridge.parseToolCalls(syntheticResponse);

  if (rawToolCalls.length > 0 && toolCalls.length !== rawToolCalls.length) {
    throw new Error(invalidOpenRouterTerminalResponseError);
  }

  for (const artifact of extractOpenRouterArtifacts(syntheticResponse)) {
    yield artifact;
  }

  return {
    finalProviderResponsePreview: buildOpenRouterResponsePreview(syntheticResponse, finalText, rawText),
    finalText,
    ...(toolCalls.length > 0
      ? { providerToolCallMessage: firstMessage(syntheticResponse) ?? undefined }
      : {}),
    providerResponseId: responseId,
    toolCalls,
    usage
  };
}
