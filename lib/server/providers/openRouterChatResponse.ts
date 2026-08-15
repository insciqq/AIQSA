import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeSearchSources } from "../search/evidence";
import { openRouterChatToolBridge } from "../tools/bridges";
import type { ModelToolCall } from "../tools/types";
import {
  assertBoundedStructuredTextLength,
  assertBoundedTextLength
} from "./boundedText";
import type { ProviderStreamLimits } from "./network";
import {
  assertOpenAIChatTerminalResponse,
  extractOpenAIChatUsage,
  firstOpenAIChatChoice,
  firstOpenAIChatMessage,
  isOpenAIChatRecord,
  openAIChatResponseId,
  openAIChatText,
  streamOpenAIChatJsonResponse,
  streamOpenAIChatSseResponse,
  type OpenAIChatCompletionsRecord
} from "./openaiChatCompletions";
import type { ProviderStreamSafetySnapshot } from "./streamSafety";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

export type OpenRouterResponseRecord = OpenAIChatCompletionsRecord;

export type OpenRouterResponseContext = Readonly<Pick<ProviderRunRequest, "modelId">>;

export const invalidOpenRouterTerminalResponseError =
  "openrouter_terminal_response_invalid";

export function assertValidOpenRouterTerminalResponse(
  response: OpenRouterResponseRecord,
  options: Readonly<{ allowToolCalls?: boolean }> = {}
): void {
  assertOpenAIChatTerminalResponse(response, {
    allowToolCalls: options.allowToolCalls,
    invalidTerminalError: invalidOpenRouterTerminalResponseError
  });
}

export function extractOpenRouterText(response: OpenRouterResponseRecord): string {
  return openAIChatText(firstOpenAIChatMessage(response)?.content);
}

export function extractOpenRouterUsage(response: OpenRouterResponseRecord): ModelRunUsage {
  return extractOpenAIChatUsage(response, {
    includeCacheWrite: true,
    includeTopLevelReasoning: true
  });
}

function citationFromValue(
  value: unknown,
  index: number,
  shape: "annotation" | "flat"
): Record<string, unknown> | null {
  let candidate: Record<string, unknown> | null = null;
  if (shape === "annotation") {
    if (!isOpenAIChatRecord(value)) return null;
    if (value.type === undefined) {
      candidate = {
        snippet: value.snippet ?? value.content,
        title: value.title ?? `Source ${index + 1}`,
        url: value.url ?? value.href
      };
    } else {
      if (value.type !== "url_citation" || !isOpenAIChatRecord(value.url_citation)) return null;
      candidate = {
        snippet: value.url_citation.content ?? value.url_citation.snippet,
        title: value.url_citation.title ?? `Source ${index + 1}`,
        url: value.url_citation.url ?? value.url_citation.href
      };
    }
  } else if (typeof value === "string") {
    candidate = { title: `Source ${index + 1}`, url: value };
  } else if (isOpenAIChatRecord(value)) {
    if (value.type === "url_citation") {
      if (!isOpenAIChatRecord(value.url_citation)) return null;
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
  const message = firstOpenAIChatMessage(response);
  const artifacts: ModelRunSseEvent[] = [];
  const reasoning = message?.reasoning ?? message?.reasoning_details ?? response.reasoning_details;

  if (reasoning) {
    artifacts.push({
      data: {
        artifactType: "reasoning",
        payload: { reasoning }
      },
      type: "artifact"
    });
  }

  appendCitationArtifacts(artifacts, response.citations, "openrouter");
  appendCitationArtifacts(artifacts, message?.citations, "openrouter-message");
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
    finishReason: firstOpenAIChatChoice(response)?.finish_reason,
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
  return openAIChatResponseId(response);
}

export function openRouterResponseError(response: OpenRouterResponseRecord): string | null {
  if (isOpenAIChatRecord(response.error)) {
    return "openrouter_response_error";
  }

  const choice = firstOpenAIChatChoice(response);
  if (isOpenAIChatRecord(choice?.error)) {
    return "openrouter_response_error";
  }

  const message = isOpenAIChatRecord(choice?.message) ? choice.message : null;
  return isOpenAIChatRecord(message?.error) ? "openrouter_response_error" : null;
}

function pushBoundedStructuredArray(
  target: unknown[],
  value: unknown,
  currentChars: number,
  maxOutputChars: number,
  snapshot: ProviderStreamSafetySnapshot | null
): number {
  if (!Array.isArray(value) || value.length === 0) {
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

function createOpenRouterStreamExtension() {
  const citations: unknown[] = [];
  const messageCitations: unknown[] = [];
  const annotations: unknown[] = [];
  const reasoningParts: unknown[] = [];
  let reasoningCharacters = 0;
  let reasoningUsesArray = false;
  let citationCharacters = 0;

  return {
    consume({
      delta,
      maxOutputChars,
      message,
      record,
      snapshot
    }: Readonly<{
      delta: Record<string, unknown>;
      maxOutputChars: number;
      message: Record<string, unknown>;
      record: Record<string, unknown>;
      snapshot: ProviderStreamSafetySnapshot | null;
    }>) {
      citationCharacters = pushBoundedStructuredArray(
        citations,
        record.citations,
        citationCharacters,
        maxOutputChars,
        snapshot
      );

      if (firstOpenAIChatChoice(record)) {
        const reasoning =
          delta.reasoning ??
          delta.reasoning_details ??
          message.reasoning ??
          message.reasoning_details ??
          record.reasoning_details;
        if (reasoning) {
          if (!reasoningUsesArray && typeof reasoning === "string") {
            reasoningCharacters = assertBoundedTextLength({
              currentChars: reasoningCharacters,
              fragment: reasoning,
              maxChars: maxOutputChars,
              retainedTextKind: "reasoning",
              snapshot
            });
          } else if (!reasoningUsesArray) {
            reasoningCharacters = assertBoundedStructuredTextLength({
              maxChars: maxOutputChars,
              retainedTextKind: "reasoning",
              snapshot,
              value: [...reasoningParts, reasoning]
            });
            reasoningUsesArray = true;
          } else {
            reasoningCharacters = assertBoundedStructuredTextLength({
              currentChars: reasoningCharacters - 1,
              maxChars: maxOutputChars,
              retainedTextKind: "reasoning",
              snapshot,
              value: [reasoning]
            });
          }
          reasoningParts.push(reasoning);
        }
      }

      citationCharacters = pushBoundedStructuredArray(
        messageCitations,
        delta.citations,
        citationCharacters,
        maxOutputChars,
        snapshot
      );
      citationCharacters = pushBoundedStructuredArray(
        messageCitations,
        message.citations,
        citationCharacters,
        maxOutputChars,
        snapshot
      );
      citationCharacters = pushBoundedStructuredArray(
        annotations,
        delta.annotations,
        citationCharacters,
        maxOutputChars,
        snapshot
      );
      citationCharacters = pushBoundedStructuredArray(
        annotations,
        message.annotations,
        citationCharacters,
        maxOutputChars,
        snapshot
      );
    },
    finish() {
      const reasoning =
        reasoningParts.length === 0
          ? undefined
          : reasoningParts.every((part) => typeof part === "string")
            ? reasoningParts.join("")
            : reasoningParts;
      return {
        messageFields: {
          annotations,
          citations: messageCitations,
          ...(reasoning ? { reasoning } : {})
        },
        responseFields: { citations }
      };
    }
  };
}

const responseProfile = {
  bodyMissingError: "openrouter_stream_body_missing",
  buildPreview: (
    response: OpenRouterResponseRecord,
    _request: OpenRouterResponseContext,
    finalText: string,
    rawText: string
  ) => buildOpenRouterResponsePreview(response, finalText, rawText),
  createStreamExtension: createOpenRouterStreamExtension,
  done: (data: string) => data === "[DONE]",
  extractArtifacts: extractOpenRouterArtifacts,
  extractUsage: extractOpenRouterUsage,
  initialResponseId: (response: Response) => response.headers.get("x-generation-id") ?? undefined,
  invalidTerminalError: invalidOpenRouterTerminalResponseError,
  parseToolCalls: (response: OpenRouterResponseRecord) =>
    openRouterChatToolBridge.parseToolCalls(response),
  provider: () => "openrouter",
  responseError: openRouterResponseError,
  streamError: "openrouter_stream_error",
  truncatedError: "openrouter_stream_truncated",
  validateJsonTerminal: assertValidOpenRouterTerminalResponse,
  validateStreamTerminal(
    _response: OpenRouterResponseRecord,
    result: Readonly<{
      rawToolCallCount: number;
      toolCalls: readonly ModelToolCall[];
    }>
  ) {
    if (result.rawToolCallCount !== result.toolCalls.length) {
      throw new Error(invalidOpenRouterTerminalResponseError);
    }
  }
};

export async function* streamOpenRouterJsonResponse(
  response: OpenRouterResponseRecord,
  request: OpenRouterResponseContext
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  return yield* streamOpenAIChatJsonResponse(response, request, responseProfile);
}

export async function* streamOpenRouterSseResponse(
  response: Response,
  request: OpenRouterResponseContext,
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
