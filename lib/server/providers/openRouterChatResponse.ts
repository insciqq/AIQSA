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
  assertOpenAIChatFinished,
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
import { reportedUsageCostUsd } from "./reportedUsageCost";
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

/** What OpenRouter charged for one answer call, under the shared BYOK rule; a
 * missing or malformed amount is no usable cost, so token prices apply. */
export function openRouterReportedCostUsd(usage: Readonly<Record<string, unknown>>): number | undefined {
  return reportedUsageCostUsd(usage) ?? undefined;
}

export function extractOpenRouterUsage(response: OpenRouterResponseRecord): ModelRunUsage {
  return extractOpenAIChatUsage(response, {
    includeCacheWrite: true,
    includeTopLevelReasoning: true
  });
}

type CitationShape = "annotation" | "flat";

type CitationPayload = Readonly<{
  index: number;
  snippet: string | undefined;
  title: string;
  url: string;
}>;

/** A URL with raw whitespace inside it (a space in a path or query) goes
 * through the WHATWG parser, which percent-encodes it, so one stray space does
 * not cost the source. The result still has to pass every rule of
 * `normalizeSearchSources`; any other value is passed on unchanged. */
function citationUrl(value: unknown): unknown {
  if (typeof value !== "string" || !/\s/u.test(value.trim())) return value;
  try {
    return new URL(value.trim()).href;
  } catch {
    return value;
  }
}

/** The fields of one citation record. An OpenAI-style `url_citation` object is
 * read whether or not `type` names it; without that object, a record of type
 * `url_citation` or of no type carries its fields flat. A `url_citation` that
 * is present but not an object is malformed. An annotation of any other type
 * is not a citation, while a flat citation list keeps every record. */
function citationRecordFields(
  value: Record<string, unknown>,
  shape: CitationShape
): Record<string, unknown> | null {
  const flat = { snippet: value.snippet ?? value.content, title: value.title, url: value.url ?? value.href };
  if (value.type !== undefined && value.type !== "url_citation") {
    return shape === "flat" ? flat : null;
  }
  const nested = value.url_citation;
  if (isOpenAIChatRecord(nested)) {
    return { snippet: nested.content ?? nested.snippet, title: nested.title, url: nested.url ?? nested.href };
  }
  return nested === undefined || value.type === undefined ? flat : null;
}

function citationFromValue(
  value: unknown,
  index: number,
  shape: CitationShape
): Readonly<{ payload: CitationPayload; titled: boolean }> | null {
  const fields = typeof value === "string" && shape === "flat"
    ? { url: value }
    : isOpenAIChatRecord(value) ? citationRecordFields(value, shape) : null;
  if (!fields) return null;
  const source = normalizeSearchSources([{
    snippet: fields.snippet,
    title: fields.title ?? `Source ${index + 1}`,
    url: citationUrl(fields.url)
  }])[0];
  return source
    ? {
        payload: {
          index: index + 1,
          snippet: source.snippet,
          title: source.title,
          url: source.url
        },
        titled: typeof fields.title === "string" && fields.title.trim() !== ""
      }
    : null;
}

function appendCitationArtifacts(
  target: ModelRunSseEvent[],
  values: unknown,
  source: string,
  shape: CitationShape = "flat"
): void {
  if (!Array.isArray(values)) {
    return;
  }

  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const citation = citationFromValue(value, index, shape);
    if (!citation || seen.has(citation.payload.url)) {
      continue;
    }

    seen.add(citation.payload.url);
    target.push({ data: { artifactType: "citation", payload: { ...citation.payload, source } }, type: "artifact" });
  }
}

/** Perplexity's documented `search_results` (`{title, url, date, ...}`, in the
 * order of its `citations`). A result whose URL another field already cited
 * gives that citation its title and excerpt when it had none and is not
 * repeated; every other result becomes a citation of its own. */
function appendSearchResultArtifacts(target: ModelRunSseEvent[], values: unknown): void {
  if (!Array.isArray(values)) {
    return;
  }

  const cited = new Map<string, Record<string, unknown>>();
  for (const event of target) {
    if (event.type === "artifact" && event.data.artifactType === "citation" &&
      isOpenAIChatRecord(event.data.payload) && typeof event.data.payload.url === "string" &&
      !cited.has(event.data.payload.url)) {
      cited.set(event.data.payload.url, event.data.payload);
    }
  }

  for (const [index, value] of values.entries()) {
    const result = citationFromValue(value, index, "flat");
    if (!result) {
      continue;
    }

    const existing = cited.get(result.payload.url);
    if (!existing) {
      const payload = { ...result.payload, source: "openrouter-search-results" };
      cited.set(payload.url, payload);
      target.push({ data: { artifactType: "citation", payload }, type: "artifact" });
      continue;
    }
    if (result.titled && existing.title === `Source ${String(existing.index)}`) {
      existing.title = result.payload.title;
    }
    if (existing.snippet === undefined && result.payload.snippet !== undefined) {
      existing.snippet = result.payload.snippet;
    }
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
  appendSearchResultArtifacts(artifacts, response.search_results);

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
  const reasoningDetails: unknown[] = [];
  let reasoningDetailCharacters = 0;
  const originalReasoning: string[] = [];
  let originalReasoningCharacters = 0;
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
        const original = delta.reasoning ?? message.reasoning;
        if (typeof original === "string") {
          originalReasoningCharacters = assertBoundedTextLength({ currentChars: originalReasoningCharacters,
            fragment: original, maxChars: maxOutputChars, retainedTextKind: "reasoning", snapshot });
          originalReasoning.push(original);
        }
        const details = delta.reasoning_details ?? message.reasoning_details ?? record.reasoning_details;
        if (Array.isArray(details)) {
          reasoningDetailCharacters = assertBoundedStructuredTextLength({ currentChars: reasoningDetailCharacters,
            value: details, maxChars: maxOutputChars, retainedTextKind: "reasoning", snapshot });
          for (const detail of details) {
            const previous = reasoningDetails.at(-1);
            const field = isOpenAIChatRecord(detail) && detail.type === "reasoning.text" ? "text"
              : isOpenAIChatRecord(detail) && detail.type === "reasoning.summary" ? "summary" : null;
            // Text/summary deltas extend their consecutive block. Encrypted
            // entries remain discrete opaque blobs. A repeated index alone
            // cannot prove identity, but an explicit index/signature change
            // proves a boundary and must never combine signed blocks.
            if (field && isOpenAIChatRecord(detail) && isOpenAIChatRecord(previous) &&
              previous.type === detail.type &&
              (previous[field] == null || typeof previous[field] === "string") &&
              (detail[field] == null || typeof detail[field] === "string") &&
              (previous.index == null || detail.index == null || previous.index === detail.index) &&
              (previous.signature == null || detail.signature == null || previous.signature === detail.signature) &&
              (!previous.id || !detail.id || previous.id === detail.id) &&
              (!previous.format || !detail.format || previous.format === detail.format)) {
              reasoningDetails[reasoningDetails.length - 1] = {
                ...previous,
                ...detail,
                [field]: `${previous[field] ?? ""}${detail[field] ?? ""}`,
                ...(previous.signature !== undefined || detail.signature !== undefined
                  ? { signature: previous.signature ?? detail.signature } : {})
              };
            } else reasoningDetails.push(detail);
          }
        }
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
        ...(reasoningDetails.length ? { continuationFields: {
          reasoning_details: reasoningDetails,
          reasoning: originalReasoning.length ? originalReasoning.join("") : undefined
        } } : {}),
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
  extractCostUsd: openRouterReportedCostUsd,
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
    response: OpenRouterResponseRecord,
    result: Readonly<{
      rawToolCallCount: number;
      toolCalls: readonly ModelToolCall[];
    }>
  ) {
    assertOpenAIChatFinished(response, invalidOpenRouterTerminalResponseError);
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
  configuredStreamLimits?: Partial<ProviderStreamLimits>,
  onToolArguments?: import("./types").ProviderToolArgumentObserver
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  return yield* streamOpenAIChatSseResponse(
    response,
    request,
    responseProfile,
    signal,
    configuredStreamLimits,
    onToolArguments
  );
}
