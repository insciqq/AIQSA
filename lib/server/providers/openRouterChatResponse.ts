import { safeExternalHref } from "../../domain/links";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { openRouterChatToolBridge } from "../tools/bridges";
import { providerStreamIdleTimeoutMs } from "./network";
import { parseSseStream } from "./sse";
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import { visibleAnswerText } from "./visibleAnswer";

export type OpenRouterResponseRecord = Readonly<Record<string, unknown>>;

export type OpenRouterResponseContext = Readonly<Pick<ProviderRunRequest, "modelId">>;

export const invalidOpenRouterTerminalResponseError =
  "openrouter_terminal_response_invalid";

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

function citationFromValue(value: unknown, index: number): Record<string, unknown> | null {
  if (typeof value === "string") {
    const url = safeExternalHref(value);
    if (!url) {
      return null;
    }

    return {
      index: index + 1,
      title: `Source ${index + 1}`,
      url
    };
  }

  if (!isRecord(value)) {
    return null;
  }

  const url = safeExternalHref(stringValue(value.url) ?? stringValue(value.href));
  if (!url) {
    return null;
  }

  return {
    index: index + 1,
    snippet: value.snippet,
    title: stringValue(value.title) ?? `Source ${index + 1}`,
    url
  };
}

function citationArtifacts(values: unknown, source: string): ModelRunSseEvent[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const artifacts: ModelRunSseEvent[] = [];

  for (const [index, value] of values.entries()) {
    const citation = citationFromValue(value, index);
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

  artifacts.push(...citationArtifacts(response.citations, "openrouter"));
  artifacts.push(...citationArtifacts(message?.citations, "openrouter-message"));
  artifacts.push(...citationArtifacts(message?.annotations, "openrouter-annotations"));

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

  return stringValue(response.error.message) ?? stringValue(response.error.code) ?? "OpenRouter stream error";
}

export function openRouterResponseError(response: OpenRouterResponseRecord): string | null {
  const topLevelError = openRouterStreamError(response);
  if (topLevelError) {
    return topLevelError;
  }

  const choice = firstChoice(response);
  if (isRecord(choice?.error)) {
    return stringValue(choice.error.message) ?? stringValue(choice.error.code) ?? "OpenRouter response error";
  }

  const message = isRecord(choice?.message) ? choice.message : null;
  if (isRecord(message?.error)) {
    return stringValue(message.error.message) ?? stringValue(message.error.code) ?? "OpenRouter response error";
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

function pushArray(target: unknown[], value: unknown) {
  if (Array.isArray(value)) {
    target.push(...value);
  }
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
  idleTimeoutMs = providerStreamIdleTimeoutMs()
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  if (!response.body) {
    throw new Error("openrouter_stream_body_missing");
  }

  let responseId: string | undefined = response.headers.get("x-generation-id") ?? undefined;
  let model: unknown = request.modelId;
  let object: unknown = "chat.completion.chunk";
  let finishReason: unknown = null;
  let rawFinalText = "";
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

  for await (const event of parseSseStream(response.body, {
    idleTimeoutMs,
    signal
  })) {
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
      throw new Error(streamError);
    }

    responseId = stringValue(parsed.id) ?? responseId;
    model = parsed.model ?? model;
    object = parsed.object ?? object;
    pushArray(citations, parsed.citations);
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
    const text = deltaText(delta);
    if (text) {
      rawFinalText += text;
      yield {
        data: {
          delta: text
        },
        type: "token"
      };
    }

    const reasoning = reasoningFromDelta(delta) ?? reasoningFromDelta(message) ?? parsed.reasoning_details;
    if (reasoning) {
      reasoningParts.push(reasoning);
    }

    pushArray(messageCitations, delta.citations);
    pushArray(messageCitations, message.citations);
    pushArray(annotations, delta.annotations);
    pushArray(annotations, message.annotations);
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

  const reasoning =
    reasoningParts.length === 0
      ? undefined
      : reasoningParts.every((part) => typeof part === "string")
        ? reasoningParts.join("")
        : reasoningParts;
  const syntheticResponse = {
    citations,
    choices: [
      {
        finish_reason: finishReason,
        message: {
          annotations,
          citations: messageCitations,
          content: rawFinalText,
          ...(reasoning ? { reasoning } : {}),
          role: "assistant"
        }
      }
    ],
    id: responseId,
    model,
    object,
    usage: rawUsage
  };
  const finalText = visibleAnswerText(rawFinalText);

  for (const artifact of extractOpenRouterArtifacts(syntheticResponse)) {
    yield artifact;
  }

  return {
    finalProviderResponsePreview: buildOpenRouterResponsePreview(syntheticResponse, finalText, rawFinalText),
    finalText,
    providerResponseId: responseId,
    toolCalls: [],
    usage
  };
}
