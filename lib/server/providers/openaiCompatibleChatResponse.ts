import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import type { ModelToolCall } from "../tools/types";
import {
  providerStreamIdleTimeoutMs
} from "./network";
import { parseSseStream } from "./sse";
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import { visibleAnswerText } from "./visibleAnswer";

export type OpenAICompatibleChatResponseRecord = Readonly<Record<string, unknown>>;

export type OpenAICompatibleChatResponseContext = Readonly<
  Pick<ProviderRunRequest, "modelId" | "provider">
>;

export const invalidOpenAICompatibleChatTerminalResponseError =
  "openai_compatible_chat_terminal_response_invalid";

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

function firstChoice(response: OpenAICompatibleChatResponseRecord): Record<string, unknown> | null {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  return isRecord(choices[0]) ? choices[0] : null;
}

function firstMessage(response: OpenAICompatibleChatResponseRecord): Record<string, unknown> | null {
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
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function rawToolCalls(message: Record<string, unknown> | null): unknown[] {
  return message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

function isStructurallyValidToolCall(value: unknown): boolean {
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

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to the stable provider-tool error.
    }
  }

  throw new Error("provider_tool_arguments_invalid");
}

function parseToolCalls(message: Record<string, unknown> | null): ModelToolCall[] {
  return rawToolCalls(message).map((value) => {
    if (!isStructurallyValidToolCall(value) || !isRecord(value) || !isRecord(value.function)) {
      throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
    }

    return {
      arguments: parseToolArguments(value.function.arguments),
      id: value.id as string,
      name: value.function.name as string,
      raw: value
    };
  });
}

function responseError(response: OpenAICompatibleChatResponseRecord): string | null {
  if (!isRecord(response.error)) {
    return null;
  }

  return "openai_compatible_chat_response_error";
}

function assertValidTerminalResponse(response: OpenAICompatibleChatResponseRecord): void {
  const message = firstMessage(response);
  if (!message) {
    throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
  }

  const calls = rawToolCalls(message);
  if (extractTextContent(message.content).trim()) {
    if (calls.length > 0 && !calls.every(isStructurallyValidToolCall)) {
      throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
    }
    return;
  }
  if (calls.length > 0 && calls.every(isStructurallyValidToolCall)) {
    return;
  }

  throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
}

export function extractOpenAICompatibleChatUsage(
  response: OpenAICompatibleChatResponseRecord
): ModelRunUsage {
  const usage = isRecord(response.usage) ? response.usage : {};

  return normalizeTokenUsage({
    cachedInputTokens:
      numberValue(valueAtPath(usage, ["prompt_tokens_details", "cached_tokens"])) ||
      numberValue(valueAtPath(usage, ["input_tokens_details", "cached_tokens"])),
    inputTokens: numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.completion_tokens) || numberValue(usage.output_tokens),
    reasoningTokens:
      numberValue(valueAtPath(usage, ["completion_tokens_details", "reasoning_tokens"])) ||
      numberValue(valueAtPath(usage, ["output_tokens_details", "reasoning_tokens"])),
    totalTokens: numberValue(usage.total_tokens)
  });
}

function responseId(response: OpenAICompatibleChatResponseRecord): string | undefined {
  return stringValue(response.id);
}

function responsePreview(
  response: OpenAICompatibleChatResponseRecord,
  request: OpenAICompatibleChatResponseContext,
  finalText: string,
  rawText = finalText
): Record<string, unknown> {
  return {
    finishReason: firstChoice(response)?.finish_reason,
    id: response.id,
    model: response.model,
    object: response.object,
    provider: request.provider,
    rawText: rawText === finalText ? undefined : rawText,
    text: finalText,
    usage: response.usage
  };
}

function summaryEvent(
  request: OpenAICompatibleChatResponseContext,
  model: unknown,
  id: string | undefined
): ModelRunSseEvent {
  return {
    data: {
      artifactType: "summary",
      payload: {
        model,
        provider: request.provider,
        responseId: id,
        stage: "answer"
      }
    },
    type: "artifact"
  };
}

export async function* streamOpenAICompatibleChatJsonResponse(
  response: OpenAICompatibleChatResponseRecord,
  request: OpenAICompatibleChatResponseContext
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  const error = responseError(response);
  if (error) {
    throw new Error(error);
  }
  assertValidTerminalResponse(response);

  const rawFinalText = extractTextContent(firstMessage(response)?.content);
  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = parseToolCalls(firstMessage(response));
  if (!finalText && toolCalls.length === 0) {
    throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
  }

  yield summaryEvent(request, response.model ?? request.modelId, responseId(response));
  if (finalText) {
    yield { data: { delta: finalText }, type: "token" };
  }

  return {
    finalProviderResponsePreview: responsePreview(
      response,
      request,
      finalText,
      rawFinalText
    ),
    finalText,
    ...(toolCalls.length > 0
      ? { providerToolCallMessage: firstMessage(response) ?? undefined }
      : {}),
    providerResponseId: responseId(response),
    toolCalls,
    usage: extractOpenAICompatibleChatUsage(response)
  };
}

type StreamedToolCall = {
  arguments: Record<string, unknown> | string;
  extraContent?: unknown;
  id?: string;
  index: number;
  name?: string;
  type?: string;
};

function accumulateToolCalls(
  target: Map<number, StreamedToolCall>,
  value: unknown,
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
      typeof candidate.index === "number" &&
      Number.isInteger(candidate.index) &&
      candidate.index >= 0
        ? candidate.index
        : ordinal;
    const current = target.get(index) ?? { arguments: "", index };
    const fn = isRecord(candidate.function) ? candidate.function : {};

    if (typeof candidate.id === "string" && candidate.id) {
      current.id = candidate.id;
    }
    if (typeof candidate.type === "string" && candidate.type) {
      current.type = candidate.type;
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "extra_content")) {
      current.extraContent = candidate.extra_content;
    }
    if (typeof fn.name === "string" && fn.name) {
      current.name = fn.name;
    }
    if (isRecord(fn.arguments)) {
      current.arguments = fn.arguments;
    } else if (typeof fn.arguments === "string") {
      current.arguments =
        replaceArguments || typeof current.arguments !== "string"
          ? fn.arguments
          : `${current.arguments}${fn.arguments}`;
    }

    target.set(index, current);
  });
}

function completedToolCalls(target: ReadonlyMap<number, StreamedToolCall>): Record<string, unknown>[] {
  return [...target.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      function: {
        arguments: call.arguments,
        name: call.name
      },
      id: call.id,
      ...(call.extraContent !== undefined ? { extra_content: call.extraContent } : {}),
      type: call.type ?? "function"
    }));
}

export async function* streamOpenAICompatibleChatSseResponse(
  response: Response,
  request: OpenAICompatibleChatResponseContext,
  signal?: AbortSignal,
  idleTimeoutMs = providerStreamIdleTimeoutMs()
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  if (!response.body) {
    throw new Error("openai_compatible_chat_stream_body_missing");
  }

  let id: string | undefined;
  let model: unknown = request.modelId;
  let object: unknown = "chat.completion.chunk";
  let finishReason: unknown = null;
  let rawFinalText = "";
  let rawUsage: unknown = null;
  let usage: ModelRunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  };
  let summaryEmitted = false;
  let terminalSeen = false;
  const toolCallParts = new Map<number, StreamedToolCall>();

  for await (const event of parseSseStream(response.body, { idleTimeoutMs, signal })) {
    if (event.data.trim() === "[DONE]") {
      terminalSeen = true;
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new Error("openai_compatible_chat_stream_truncated");
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const error = responseError(parsed);
    if (error) {
      throw new Error("openai_compatible_chat_stream_error");
    }

    id = stringValue(parsed.id) ?? id;
    model = parsed.model ?? model;
    object = parsed.object ?? object;
    if (!summaryEmitted) {
      summaryEmitted = true;
      yield summaryEvent(request, model, id);
    }

    if (isRecord(parsed.usage)) {
      rawUsage = parsed.usage;
      usage = extractOpenAICompatibleChatUsage(parsed);
      yield { data: usage, type: "usage" };
    }

    const choice = firstChoice(parsed);
    if (!choice) {
      continue;
    }

    finishReason = choice.finish_reason ?? finishReason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const message = isRecord(choice.message) ? choice.message : {};
    accumulateToolCalls(toolCallParts, delta.tool_calls);
    accumulateToolCalls(toolCallParts, message.tool_calls, true);

    const text = extractTextContent(delta.content);
    if (text) {
      rawFinalText += text;
      yield { data: { delta: text }, type: "token" };
    }
  }

  if (!terminalSeen) {
    throw new Error("openai_compatible_chat_stream_truncated");
  }
  if (!summaryEmitted) {
    yield summaryEvent(request, model, id);
  }

  const streamedToolCalls = completedToolCalls(toolCallParts);
  const message = {
    content: rawFinalText || null,
    role: "assistant",
    ...(streamedToolCalls.length > 0 ? { tool_calls: streamedToolCalls } : {})
  };
  const syntheticResponse = {
    choices: [{ finish_reason: finishReason, message }],
    id,
    model,
    object,
    usage: rawUsage
  };
  assertValidTerminalResponse(syntheticResponse);

  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = parseToolCalls(message);
  if (!finalText && toolCalls.length === 0) {
    throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
  }

  return {
    finalProviderResponsePreview: responsePreview(
      syntheticResponse,
      request,
      finalText,
      rawFinalText
    ),
    finalText,
    ...(toolCalls.length > 0 ? { providerToolCallMessage: message } : {}),
    providerResponseId: id,
    toolCalls,
    usage
  };
}
