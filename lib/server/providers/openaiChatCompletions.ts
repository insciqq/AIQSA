import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import {
  invalidProviderToolArguments,
  type ModelToolCall
} from "../tools/types";
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

export type OpenAIChatCompletionsRecord = Readonly<Record<string, unknown>>;

type OpenAIChatCompletionsContext = Readonly<{
  modelId: string;
  provider?: string;
}>;

export function isOpenAIChatRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openAIChatString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function openAIChatNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function openAIChatValueAtPath(
  value: unknown,
  path: readonly string[]
): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!isOpenAIChatRecord(current) || !(key in current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

export function firstOpenAIChatChoice(
  response: OpenAIChatCompletionsRecord
): Record<string, unknown> | null {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  return isOpenAIChatRecord(choices[0]) ? choices[0] : null;
}

export function firstOpenAIChatMessage(
  response: OpenAIChatCompletionsRecord
): Record<string, unknown> | null {
  const message = firstOpenAIChatChoice(response)?.message;
  return isOpenAIChatRecord(message) ? message : null;
}

export function openAIChatText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => (
      isOpenAIChatRecord(part) && typeof part.text === "string" ? part.text : ""
    ))
    .join("");
}

function rawToolCalls(message: Record<string, unknown> | null): unknown[] {
  return message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

function isOpenAIChatToolCall(value: unknown): boolean {
  if (
    !isOpenAIChatRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !isOpenAIChatRecord(value.function) ||
    typeof value.function.name !== "string" ||
    !value.function.name.trim()
  ) {
    return false;
  }

  const argumentsValue = value.function.arguments;
  return (
    argumentsValue === undefined ||
    typeof argumentsValue === "string" ||
    isOpenAIChatRecord(argumentsValue)
  );
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isOpenAIChatRecord(value)) {
    return value;
  }
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isOpenAIChatRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to the stable provider-tool error.
    }
  }

  return invalidProviderToolArguments();
}

export function parseOpenAIChatToolCalls(
  response: OpenAIChatCompletionsRecord,
  invalidTerminalError: string
): ModelToolCall[] {
  return rawToolCalls(firstOpenAIChatMessage(response)).map((value) => {
    if (
      !isOpenAIChatToolCall(value) ||
      !isOpenAIChatRecord(value) ||
      !isOpenAIChatRecord(value.function)
    ) {
      throw new Error(invalidTerminalError);
    }

    return {
      arguments: parseToolArguments(value.function.arguments),
      id: value.id as string,
      name: value.function.name as string,
      raw: value
    };
  });
}

export function assertOpenAIChatTerminalResponse(
  response: OpenAIChatCompletionsRecord,
  options: Readonly<{
    allowToolCalls?: boolean;
    invalidTerminalError: string;
    validateToolCallsWithText?: boolean;
  }>
): void {
  const message = firstOpenAIChatMessage(response);
  if (!message) {
    throw new Error(options.invalidTerminalError);
  }

  const calls = rawToolCalls(message);
  if (openAIChatText(message.content).trim()) {
    if (
      options.validateToolCallsWithText &&
      calls.length > 0 &&
      !calls.every(isOpenAIChatToolCall)
    ) {
      throw new Error(options.invalidTerminalError);
    }
    return;
  }
  if (
    options.allowToolCalls !== false &&
    calls.length > 0 &&
    calls.every(isOpenAIChatToolCall)
  ) {
    return;
  }

  throw new Error(options.invalidTerminalError);
}

export function extractOpenAIChatUsage(
  response: OpenAIChatCompletionsRecord,
  options: Readonly<{
    includeCacheWrite?: boolean;
    includeTopLevelReasoning?: boolean;
  }> = {}
): ModelRunUsage {
  const usage = isOpenAIChatRecord(response.usage) ? response.usage : {};

  return normalizeTokenUsage({
    cachedInputTokens:
      openAIChatNumber(openAIChatValueAtPath(usage, ["prompt_tokens_details", "cached_tokens"])) ||
      openAIChatNumber(openAIChatValueAtPath(usage, ["input_tokens_details", "cached_tokens"])),
    ...(options.includeCacheWrite
      ? {
          cacheWriteInputTokens:
            openAIChatNumber(usage.cache_write_tokens) ||
            openAIChatNumber(usage.cache_write_input_tokens) ||
            openAIChatNumber(usage.cache_creation_input_tokens) ||
            openAIChatNumber(openAIChatValueAtPath(usage, ["prompt_tokens_details", "cache_write_tokens"])) ||
            openAIChatNumber(openAIChatValueAtPath(usage, ["input_tokens_details", "cache_write_tokens"]))
        }
      : {}),
    inputTokens: openAIChatNumber(usage.prompt_tokens) || openAIChatNumber(usage.input_tokens),
    outputTokens: openAIChatNumber(usage.completion_tokens) || openAIChatNumber(usage.output_tokens),
    reasoningTokens:
      (options.includeTopLevelReasoning ? openAIChatNumber(usage.reasoning_tokens) : 0) ||
      openAIChatNumber(openAIChatValueAtPath(usage, ["completion_tokens_details", "reasoning_tokens"])) ||
      openAIChatNumber(openAIChatValueAtPath(usage, ["output_tokens_details", "reasoning_tokens"])),
    totalTokens: openAIChatNumber(usage.total_tokens)
  });
}

export function openAIChatResponseId(
  response: OpenAIChatCompletionsRecord
): string | undefined {
  return openAIChatString(response.id);
}

function openAIChatSummaryEvent(input: Readonly<{
  id: string | undefined;
  model: unknown;
  provider: string;
}>): ModelRunSseEvent {
  return {
    data: {
      artifactType: "summary",
      payload: {
        model: input.model,
        provider: input.provider,
        responseId: input.id,
        stage: "answer"
      }
    },
    type: "artifact"
  };
}

type OpenAIChatStreamExtension = Readonly<{
  consume(input: Readonly<{
    delta: Record<string, unknown>;
    maxOutputChars: number;
    message: Record<string, unknown>;
    record: Record<string, unknown>;
    snapshot: ProviderStreamSafetySnapshot | null;
  }>): void;
  finish(): Readonly<{
    messageFields?: Record<string, unknown>;
    responseFields?: Record<string, unknown>;
  }>;
}>;

type OpenAIChatResponseProfile<Context extends OpenAIChatCompletionsContext> = Readonly<{
  bodyMissingError: string;
  buildPreview(
    response: OpenAIChatCompletionsRecord,
    request: Context,
    finalText: string,
    rawText: string
  ): Record<string, unknown>;
  createStreamExtension?(): OpenAIChatStreamExtension;
  done(data: string): boolean;
  extractArtifacts?(response: OpenAIChatCompletionsRecord): ModelRunSseEvent[];
  extractUsage(response: OpenAIChatCompletionsRecord): ModelRunUsage;
  initialResponseId?(response: Response): string | undefined;
  invalidTerminalError: string;
  parseToolCalls(response: OpenAIChatCompletionsRecord): ModelToolCall[];
  provider(request: Context): string;
  responseError(response: OpenAIChatCompletionsRecord): string | null;
  streamError: string;
  truncatedError: string;
  validateJsonTerminal(response: OpenAIChatCompletionsRecord): void;
  validateStreamTerminal?(
    response: OpenAIChatCompletionsRecord,
    result: Readonly<{
      finalText: string;
      rawToolCallCount: number;
      toolCalls: readonly ModelToolCall[];
    }>
  ): void;
}>;

export async function* streamOpenAIChatJsonResponse<
  Context extends OpenAIChatCompletionsContext
>(
  response: OpenAIChatCompletionsRecord,
  request: Context,
  profile: OpenAIChatResponseProfile<Context>
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  const responseError = profile.responseError(response);
  if (responseError) {
    throw new Error(responseError);
  }
  profile.validateJsonTerminal(response);

  const rawFinalText = openAIChatText(firstOpenAIChatMessage(response)?.content);
  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = profile.parseToolCalls(response);
  if (!finalText && toolCalls.length === 0) {
    throw new Error(profile.invalidTerminalError);
  }
  const providerResponseId = openAIChatResponseId(response);

  yield openAIChatSummaryEvent({
    id: providerResponseId,
    model: response.model ?? request.modelId,
    provider: profile.provider(request)
  });

  for (const artifact of profile.extractArtifacts?.(response) ?? []) {
    yield artifact;
  }

  if (finalText) {
    yield { data: { delta: finalText }, type: "token" };
  }

  return {
    finalProviderResponsePreview: profile.buildPreview(
      response,
      request,
      finalText,
      rawFinalText
    ),
    finalText,
    ...(toolCalls.length > 0
      ? { providerToolCallMessage: firstOpenAIChatMessage(response) ?? undefined }
      : {}),
    providerResponseId,
    toolCalls,
    usage: profile.extractUsage(response)
  };
}

const MAX_STREAMED_TOOL_CALLS = 16;
const MAX_TOOL_CALL_ID_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 512;
const MAX_TOOL_TYPE_LENGTH = 64;

type StreamedToolCall = {
  arguments: BoundedTextAccumulator | Record<string, unknown>;
  id?: string;
  index: number;
  name?: string;
  type?: string;
};

function accumulateToolCalls(
  target: Map<number, StreamedToolCall>,
  value: unknown,
  maxOutputChars: number,
  snapshot: ProviderStreamSafetySnapshot | null,
  errors: Readonly<{ invalid: string; limit: string }>,
  replaceArguments = false
): void {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((candidate, ordinal) => {
    if (!isOpenAIChatRecord(candidate)) {
      return;
    }

    const index =
      typeof candidate.index === "number" &&
      Number.isInteger(candidate.index) &&
      candidate.index >= 0
        ? candidate.index
        : ordinal;
    let current = target.get(index);
    if (!current) {
      if (target.size >= MAX_STREAMED_TOOL_CALLS) {
        throw new Error(errors.limit);
      }
      current = {
        arguments: new BoundedTextAccumulator({
          maxChars: maxOutputChars,
          retainedTextKind: "tool_arguments"
        }),
        index
      };
    }
    const fn = isOpenAIChatRecord(candidate.function) ? candidate.function : {};

    if (typeof candidate.id === "string" && candidate.id) {
      if (candidate.id.length > MAX_TOOL_CALL_ID_LENGTH) {
        throw new Error(errors.invalid);
      }
      current.id = candidate.id;
    }
    if (typeof candidate.type === "string" && candidate.type) {
      if (candidate.type.length > MAX_TOOL_TYPE_LENGTH) {
        throw new Error(errors.invalid);
      }
      current.type = candidate.type;
    }
    if (typeof fn.name === "string" && fn.name) {
      if (fn.name.length > MAX_TOOL_NAME_LENGTH) {
        throw new Error(errors.invalid);
      }
      current.name = fn.name;
    }
    if (isOpenAIChatRecord(fn.arguments)) {
      assertBoundedStructuredTextLength({
        maxChars: maxOutputChars,
        retainedTextKind: "tool_arguments",
        snapshot,
        value: fn.arguments
      });
      current.arguments = fn.arguments;
    } else if (typeof fn.arguments === "string") {
      if (replaceArguments || !(current.arguments instanceof BoundedTextAccumulator)) {
        current.arguments = new BoundedTextAccumulator({
          initialValue: fn.arguments,
          maxChars: maxOutputChars,
          retainedTextKind: "tool_arguments",
          snapshot
        });
      } else {
        current.arguments.append(fn.arguments, snapshot);
      }
    }

    target.set(index, current);
  });
}

function completedToolCalls(
  target: ReadonlyMap<number, StreamedToolCall>
): Record<string, unknown>[] {
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

export async function* streamOpenAIChatSseResponse<
  Context extends OpenAIChatCompletionsContext
>(
  response: Response,
  request: Context,
  profile: OpenAIChatResponseProfile<Context>,
  signal?: AbortSignal,
  configuredStreamLimits?: Partial<ProviderStreamLimits>
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  if (!response.body) {
    throw new Error(profile.bodyMissingError);
  }

  const streamLimits = resolveProviderStreamLimits(configuredStreamLimits);
  let responseId = profile.initialResponseId?.(response);
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
  const toolCallParts = new Map<number, StreamedToolCall>();
  const extension = profile.createStreamExtension?.();
  const toolCallErrors = {
    invalid: profile.invalidTerminalError.replace("terminal_response_invalid", "stream_tool_call_invalid"),
    limit: profile.invalidTerminalError.replace("terminal_response_invalid", "stream_tool_call_limit_exceeded")
  };

  for await (const event of parseSseStream(response.body, {
    idleTimeoutMs: streamLimits.idleTimeoutMs,
    maxBytes: streamLimits.maxBytes,
    maxDurationMs: streamLimits.maxDurationMs,
    maxEventBytes: streamLimits.maxEventBytes,
    signal
  })) {
    const snapshot = providerStreamSafetySnapshot(event);
    if (profile.done(event.data)) {
      terminalSeen = true;
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new Error(profile.truncatedError);
    }
    if (!isOpenAIChatRecord(parsed)) {
      continue;
    }

    if (profile.responseError(parsed)) {
      throw new Error(profile.streamError);
    }

    responseId = openAIChatString(parsed.id) ?? responseId;
    model = parsed.model ?? model;
    object = parsed.object ?? object;

    if (!summaryEmitted) {
      summaryEmitted = true;
      yield openAIChatSummaryEvent({
        id: responseId,
        model,
        provider: profile.provider(request)
      });
    }

    if (isOpenAIChatRecord(parsed.usage)) {
      rawUsage = parsed.usage;
      usage = profile.extractUsage(parsed);
      yield { data: usage, type: "usage" };
    }

    const choice = firstOpenAIChatChoice(parsed);
    const delta = isOpenAIChatRecord(choice?.delta) ? choice.delta : {};
    const message = isOpenAIChatRecord(choice?.message) ? choice.message : {};
    extension?.consume({
      delta,
      maxOutputChars: streamLimits.maxOutputChars,
      message,
      record: parsed,
      snapshot
    });
    if (!choice) {
      continue;
    }

    finishReason = choice.finish_reason ?? finishReason;
    accumulateToolCalls(
      toolCallParts,
      delta.tool_calls,
      streamLimits.maxOutputChars,
      snapshot,
      toolCallErrors
    );
    accumulateToolCalls(
      toolCallParts,
      message.tool_calls,
      streamLimits.maxOutputChars,
      snapshot,
      toolCallErrors,
      true
    );

    const text = openAIChatText(delta.content);
    if (text) {
      rawFinalText.append(text, snapshot);
      yield { data: { delta: text }, type: "token" };
    }
  }

  if (!terminalSeen) {
    throw new Error(profile.truncatedError);
  }
  if (!summaryEmitted) {
    yield openAIChatSummaryEvent({
      id: responseId,
      model,
      provider: profile.provider(request)
    });
  }

  const rawText = rawFinalText.value();
  const rawToolCalls = completedToolCalls(toolCallParts);
  const extensionResult = extension?.finish();
  const message = {
    ...extensionResult?.messageFields,
    content: rawText || null,
    role: "assistant",
    ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {})
  };
  const syntheticResponse = {
    ...extensionResult?.responseFields,
    choices: [{ finish_reason: finishReason, message }],
    id: responseId,
    model,
    object,
    usage: rawUsage
  };
  const finalText = visibleAnswerText(rawText);
  const toolCalls = profile.parseToolCalls(syntheticResponse);

  profile.validateStreamTerminal?.(syntheticResponse, {
    finalText,
    rawToolCallCount: rawToolCalls.length,
    toolCalls
  });

  for (const artifact of profile.extractArtifacts?.(syntheticResponse) ?? []) {
    yield artifact;
  }

  return {
    finalProviderResponsePreview: profile.buildPreview(
      syntheticResponse,
      request,
      finalText,
      rawText
    ),
    finalText,
    ...(toolCalls.length > 0 ? { providerToolCallMessage: message } : {}),
    providerResponseId: responseId,
    toolCalls,
    usage
  };
}
