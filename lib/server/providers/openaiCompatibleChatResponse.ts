import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ModelToolCall } from "../tools/types";
import {
  assertOpenAIChatTerminalResponse,
  extractOpenAIChatUsage,
  firstOpenAIChatChoice,
  isOpenAIChatRecord,
  parseOpenAIChatToolCalls,
  streamOpenAIChatJsonResponse,
  streamOpenAIChatSseResponse,
  type OpenAIChatCompletionsRecord
} from "./openaiChatCompletions";
import type { ProviderStreamLimits } from "./network";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

export type OpenAICompatibleChatResponseRecord = OpenAIChatCompletionsRecord;

export type OpenAICompatibleChatResponseContext = Readonly<
  Pick<ProviderRunRequest, "modelId" | "provider">
>;

export const invalidOpenAICompatibleChatTerminalResponseError =
  "openai_compatible_chat_terminal_response_invalid";

function responseError(response: OpenAICompatibleChatResponseRecord): string | null {
  return isOpenAIChatRecord(response.error)
    ? "openai_compatible_chat_response_error"
    : null;
}

function assertValidTerminalResponse(response: OpenAICompatibleChatResponseRecord): void {
  assertOpenAIChatTerminalResponse(response, {
    invalidTerminalError: invalidOpenAICompatibleChatTerminalResponseError,
    validateToolCallsWithText: true
  });
}

function parseToolCalls(response: OpenAICompatibleChatResponseRecord): ModelToolCall[] {
  return parseOpenAIChatToolCalls(
    response,
    invalidOpenAICompatibleChatTerminalResponseError
  );
}

export function extractOpenAICompatibleChatUsage(
  response: OpenAICompatibleChatResponseRecord
): ModelRunUsage {
  return extractOpenAIChatUsage(response);
}

function responsePreview(
  response: OpenAICompatibleChatResponseRecord,
  request: OpenAICompatibleChatResponseContext,
  finalText: string,
  rawText: string
): Record<string, unknown> {
  return {
    finishReason: firstOpenAIChatChoice(response)?.finish_reason,
    id: response.id,
    model: response.model,
    object: response.object,
    provider: request.provider,
    rawText: rawText === finalText ? undefined : rawText,
    text: finalText,
    usage: response.usage
  };
}

const responseProfile = {
  bodyMissingError: "openai_compatible_chat_stream_body_missing",
  buildPreview: responsePreview,
  done: (data: string) => data.trim() === "[DONE]",
  extractUsage: extractOpenAICompatibleChatUsage,
  invalidTerminalError: invalidOpenAICompatibleChatTerminalResponseError,
  parseToolCalls,
  provider: (request: OpenAICompatibleChatResponseContext) => request.provider,
  responseError,
  streamError: "openai_compatible_chat_stream_error",
  truncatedError: "openai_compatible_chat_stream_truncated",
  validateJsonTerminal: assertValidTerminalResponse,
  validateStreamTerminal(response: OpenAICompatibleChatResponseRecord, result: {
    finalText: string;
    toolCalls: readonly ModelToolCall[];
  }) {
    assertValidTerminalResponse(response);
    if (!result.finalText && result.toolCalls.length === 0) {
      throw new Error(invalidOpenAICompatibleChatTerminalResponseError);
    }
  }
};

export async function* streamOpenAICompatibleChatJsonResponse(
  response: OpenAICompatibleChatResponseRecord,
  request: OpenAICompatibleChatResponseContext
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  return yield* streamOpenAIChatJsonResponse(response, request, responseProfile);
}

export async function* streamOpenAICompatibleChatSseResponse(
  response: Response,
  request: OpenAICompatibleChatResponseContext,
  signal?: AbortSignal,
  configuredStreamLimits?: Partial<ProviderStreamLimits>
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  return yield* streamOpenAIChatSseResponse(
    response,
    request,
    responseProfile,
    signal,
    configuredStreamLimits
  );
}
