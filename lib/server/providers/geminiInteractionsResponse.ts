import { safeExternalHref } from "../../domain/links";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import { geminiInteractionsToolBridge } from "../tools/bridges";
import { validateGeminiSearchSuggestionsHtml } from "./geminiInteractionsGrounding";
import {
  geminiInteractionStepForWire,
  protectGeminiInteractionStep
} from "./geminiInteractionsProtocol";
import { parseSseStream } from "./sse";
import type { ProviderRunResult } from "./types";
import { visibleAnswerText } from "./visibleAnswer";

const MAX_INTERACTION_ID_LENGTH = 512;
const MAX_MODEL_LENGTH = 512;
const MAX_STEP_COUNT = 10_000;
const MAX_TOOL_NAME_LENGTH = 512;
const MAX_TOOL_CALL_ID_LENGTH = 512;
const MAX_SIGNATURE_LENGTH = 1_000_000;
const MAX_SEARCH_CALL_COUNT = 100;
const MAX_SEARCH_QUERY_COUNT = 100;
const MAX_SEARCH_QUERY_LENGTH = 2_048;
const MAX_SEARCH_SUGGESTION_COUNT = 20;
const MAX_SEARCH_SUGGESTIONS_BYTES = 256 * 1_024;
const MAX_CITATION_COUNT = 100;
const MAX_CITATION_URL_LENGTH = 2_048;
const MAX_CITATION_TITLE_LENGTH = 512;
const MAX_CITATION_INDEX = 10_000_000;

const interactionStatuses = new Set([
  "in_progress",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
  "incomplete"
]);

type GeminiInteractionRecord = Readonly<Record<string, unknown>>;
type GroundingDisplayEvent = Extract<ModelRunSseEvent, { type: "grounding_display" }>;

export type GeminiInteractionsResponseContext = Readonly<{
  groundingExpected?: boolean;
  modelId: string;
}>;

export type ParseGeminiInteractionsSseInput = Readonly<{
  groundingExpected: boolean;
  idleTimeoutMs: number;
  modelId: string;
  responseBody: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}>;

type NormalizedInteraction = Readonly<{
  finalText: string;
  grounding: GroundingDisplayEvent | null;
  id: string;
  model: string;
  protectedSteps: Record<string, unknown>[];
  rawFinalText: string;
  status: "completed" | "requires_action";
  toolCalls: NonNullable<ProviderRunResult["toolCalls"]>;
  usage: ModelRunUsage;
}>;

type StreamStepAccumulator = {
  argumentDelta: string;
  index: number;
  provisionalSignature: boolean;
  step: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function tokenCount(value: unknown): number {
  const count = nonNegativeInteger(value);
  return count ?? 0;
}

function statusValue(value: unknown): string | null {
  return typeof value === "string" && interactionStatuses.has(value) ? value : null;
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function extractGeminiInteractionsUsage(value: unknown): ModelRunUsage {
  const usage = usageRecord(value) ?? {};
  const thoughtTokens = tokenCount(usage.total_thought_tokens);
  const outputTokens = tokenCount(usage.total_output_tokens) + thoughtTokens;

  return normalizeTokenUsage({
    cachedInputTokens: tokenCount(usage.total_cached_tokens),
    inputTokens: tokenCount(usage.total_input_tokens),
    outputTokens,
    reasoningTokens: thoughtTokens,
    totalTokens: tokenCount(usage.total_tokens)
  });
}

function interactionFailure(status: string): Error {
  return new Error(`gemini_interaction_${status}`);
}

function validateTerminalStatus(value: unknown): "completed" | "requires_action" {
  const status = statusValue(value);
  if (status === "failed" || status === "cancelled" || status === "incomplete") {
    throw interactionFailure(status);
  }
  if (status !== "completed" && status !== "requires_action") {
    throw new Error("gemini_interaction_not_terminal");
  }
  return status;
}

function validateTextContent(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") {
    throw new Error("gemini_interactions_step_invalid");
  }
  if (value.annotations !== undefined && !Array.isArray(value.annotations)) {
    throw new Error("gemini_interactions_step_invalid");
  }
  if (Array.isArray(value.annotations) && value.annotations.length > MAX_CITATION_COUNT) {
    throw new Error("gemini_interactions_grounding_invalid");
  }
  return { ...value };
}

function validateTextContentArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_STEP_COUNT) {
    throw new Error("gemini_interactions_step_invalid");
  }
  return value.map(validateTextContent);
}

function validateArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("gemini_interactions_tool_arguments_invalid");
  }
  return { ...value };
}

function validateSearchArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("gemini_interactions_grounding_invalid");
  }
  if (value.queries !== undefined) {
    if (
      !Array.isArray(value.queries) ||
      value.queries.length > MAX_SEARCH_QUERY_COUNT ||
      value.queries.some((query) => !boundedString(query, MAX_SEARCH_QUERY_LENGTH))
    ) {
      throw new Error("gemini_interactions_grounding_invalid");
    }
  }
  return { ...value };
}

function validateSignature(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!boundedString(value, MAX_SIGNATURE_LENGTH)) {
    throw new Error("gemini_interactions_step_invalid");
  }
  return value;
}

function signatureAtStepStart(value: unknown): Readonly<{
  provisional: boolean;
  signature?: string;
}> {
  if (value === "") {
    return { provisional: true };
  }
  const signature = validateSignature(value);
  return {
    provisional: false,
    ...(signature ? { signature } : {})
  };
}

function validateSearchResults(value: unknown): Record<string, unknown>[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_SEARCH_SUGGESTION_COUNT) {
    throw new Error("gemini_interactions_grounding_invalid");
  }

  let totalBytes = 0;
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("gemini_interactions_grounding_invalid");
    }
    if (item.search_suggestions !== undefined) {
      const suggestionsHtml = validateGeminiSearchSuggestionsHtml(item.search_suggestions);
      totalBytes += Buffer.byteLength(suggestionsHtml, "utf8");
      if (totalBytes > MAX_SEARCH_SUGGESTIONS_BYTES) {
        throw new Error("gemini_interactions_grounding_invalid");
      }
    }
    return { ...item };
  });
}

function normalizeProviderStep(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("gemini_interactions_step_invalid");
  }

  switch (value.type) {
    case "model_output":
      return protectGeminiInteractionStep({
        content: value.content === undefined ? [] : validateTextContentArray(value.content),
        type: "model_output"
      });
    case "thought": {
      const signature = validateSignature(value.signature);
      const summary = value.summary === undefined ? undefined : validateTextContentArray(value.summary);
      return protectGeminiInteractionStep({
        ...(signature ? { signature } : {}),
        ...(summary ? { summary } : {}),
        type: "thought"
      });
    }
    case "function_call": {
      if (
        !boundedString(value.id, MAX_TOOL_CALL_ID_LENGTH) ||
        !boundedString(value.name, MAX_TOOL_NAME_LENGTH)
      ) {
        throw new Error("gemini_interactions_step_invalid");
      }
      const signature = validateSignature(value.signature);
      return protectGeminiInteractionStep({
        arguments: validateArguments(value.arguments),
        id: value.id,
        name: value.name,
        ...(signature ? { signature } : {}),
        type: "function_call"
      });
    }
    case "google_search_call": {
      if (!boundedString(value.id, MAX_TOOL_CALL_ID_LENGTH)) {
        throw new Error("gemini_interactions_grounding_invalid");
      }
      if (
        value.search_type !== undefined &&
        value.search_type !== "web_search" &&
        value.search_type !== "image_search"
      ) {
        throw new Error("gemini_interactions_grounding_invalid");
      }
      const signature = validateSignature(value.signature);
      return protectGeminiInteractionStep({
        arguments: validateSearchArguments(value.arguments),
        id: value.id,
        ...(value.search_type ? { search_type: value.search_type } : {}),
        ...(signature ? { signature } : {}),
        type: "google_search_call"
      });
    }
    case "google_search_result": {
      if (!boundedString(value.call_id, MAX_TOOL_CALL_ID_LENGTH)) {
        throw new Error("gemini_interactions_grounding_invalid");
      }
      if (value.is_error !== undefined && typeof value.is_error !== "boolean") {
        throw new Error("gemini_interactions_grounding_invalid");
      }
      const result = validateSearchResults(value.result);
      const signature = validateSignature(value.signature);
      return protectGeminiInteractionStep({
        call_id: value.call_id,
        ...(typeof value.is_error === "boolean" ? { is_error: value.is_error } : {}),
        ...(result ? { result } : {}),
        ...(signature ? { signature } : {}),
        type: "google_search_result"
      });
    }
    default:
      throw new Error("gemini_interactions_step_unsupported");
  }
}

function textFromSteps(steps: readonly Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const protectedStep of steps) {
    const step = geminiInteractionStepForWire(protectedStep);
    if (step.type !== "model_output" || !Array.isArray(step.content)) {
      continue;
    }
    for (const content of step.content) {
      if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function validCitationIndex(value: unknown): number | null {
  const index = nonNegativeInteger(value);
  return index !== null && index <= MAX_CITATION_INDEX ? index : null;
}

function citationFromAnnotation(value: unknown): GroundingDisplayEvent["data"]["citations"][number] | null {
  if (!isRecord(value) || value.type !== "url_citation") {
    return null;
  }
  if (typeof value.url !== "string" || value.url.length > MAX_CITATION_URL_LENGTH) {
    return null;
  }
  const url = safeExternalHref(value.url);
  if (!url || (!url.startsWith("https://") && !url.startsWith("http://"))) {
    return null;
  }
  const startIndex = validCitationIndex(value.start_index);
  const endIndex = validCitationIndex(value.end_index);
  if (startIndex === null || endIndex === null || endIndex < startIndex) {
    return null;
  }
  const title = typeof value.title === "string"
    ? value.title.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, MAX_CITATION_TITLE_LENGTH)
    : "";

  return { endIndex, startIndex, title, url };
}

function groundingDisplayEvent(
  protectedSteps: readonly Record<string, unknown>[]
): GroundingDisplayEvent | null {
  let callCount = 0;
  let queryCount = 0;
  const suggestions: string[] = [];
  const citations: GroundingDisplayEvent["data"]["citations"] = [];

  for (const protectedStep of protectedSteps) {
    const step = geminiInteractionStepForWire(protectedStep);
    if (step.type === "google_search_call") {
      callCount += 1;
      if (callCount > MAX_SEARCH_CALL_COUNT) {
        throw new Error("gemini_interactions_grounding_invalid");
      }
      const argumentsRecord = isRecord(step.arguments) ? step.arguments : {};
      const queries = Array.isArray(argumentsRecord.queries) ? argumentsRecord.queries : [];
      queryCount += queries.length;
      if (queryCount > MAX_SEARCH_QUERY_COUNT) {
        throw new Error("gemini_interactions_grounding_invalid");
      }
    }
    if (step.type === "google_search_result" && Array.isArray(step.result)) {
      for (const item of step.result) {
        if (isRecord(item) && typeof item.search_suggestions === "string" && item.search_suggestions) {
          suggestions.push(item.search_suggestions);
        }
      }
    }
    if (step.type === "model_output" && Array.isArray(step.content)) {
      for (const content of step.content) {
        if (!isRecord(content) || !Array.isArray(content.annotations)) {
          continue;
        }
        for (const annotation of content.annotations) {
          const citation = citationFromAnnotation(annotation);
          if (citation) {
            citations.push(citation);
            if (citations.length > MAX_CITATION_COUNT) {
              throw new Error("gemini_interactions_grounding_invalid");
            }
          }
        }
      }
    }
  }

  if (callCount === 0 && suggestions.length === 0 && citations.length === 0) {
    return null;
  }
  const suggestionsHtml = suggestions.join("\n");
  if (Buffer.byteLength(suggestionsHtml, "utf8") > MAX_SEARCH_SUGGESTIONS_BYTES) {
    throw new Error("gemini_interactions_grounding_invalid");
  }
  if (callCount > 0 && !suggestionsHtml) {
    throw new Error("gemini_interactions_grounding_suggestions_missing");
  }

  return {
    data: {
      citations,
      provider: "gemini",
      runSearch: { callCount, queryCount },
      suggestionsHtml
    },
    type: "grounding_display"
  };
}

function groundingMarkerEvent(callCount: number, queryCount: number): GroundingDisplayEvent {
  return {
    data: {
      citations: [],
      provider: "gemini",
      runSearch: { callCount, queryCount },
      suggestionsHtml: ""
    },
    type: "grounding_display"
  };
}

function hasSearchSuggestions(steps: readonly Record<string, unknown>[]): boolean {
  return steps.some((protectedStep) => {
    const step = geminiInteractionStepForWire(protectedStep);
    return step.type === "google_search_result" && Array.isArray(step.result) &&
      step.result.some((item) => isRecord(item) &&
        typeof item.search_suggestions === "string" && item.search_suggestions.length > 0);
  });
}

function queryCountFromSearchCall(step: Record<string, unknown>): number {
  const argumentsRecord = isRecord(step.arguments) ? step.arguments : null;
  return Array.isArray(argumentsRecord?.queries) ? argumentsRecord.queries.length : 0;
}

function responsePreview(input: NormalizedInteraction): Record<string, unknown> {
  return {
    ...(input.id ? { id: input.id } : {}),
    model: input.model,
    provider: "gemini",
    status: input.status,
    steps: input.protectedSteps.map((step) => {
      const record: Record<string, unknown> = { type: step.type };
      if (typeof step.id === "string") record.id = step.id;
      if (typeof step.call_id === "string") record.callId = step.call_id;
      if (typeof step.name === "string") record.name = step.name;
      if (Array.isArray(step.content)) record.contentCount = step.content.length;
      return record;
    }),
    text: input.finalText,
    usage: input.usage
  };
}

export function geminiInteractionSummaryEvent(input: Readonly<{
  model: string;
  providerResponseId?: string;
  status: string;
}>): ModelRunSseEvent {
  return {
    data: {
      artifactType: "summary",
      payload: {
        model: input.model,
        provider: "gemini",
        ...(input.providerResponseId ? { responseId: input.providerResponseId } : {}),
        status: input.status
      }
    },
    type: "artifact"
  };
}

function normalizeInteraction(
  response: GeminiInteractionRecord,
  context: GeminiInteractionsResponseContext
): NormalizedInteraction {
  const status = validateTerminalStatus(response.status);
  if (
    response.id !== undefined &&
    (typeof response.id !== "string" ||
      (response.id !== "" && !boundedString(response.id, MAX_INTERACTION_ID_LENGTH)))
  ) {
    throw new Error("gemini_interactions_response_id_invalid");
  }
  const id = typeof response.id === "string" ? response.id : "";
  const model = response.model === undefined
    ? context.modelId
    : boundedString(response.model, MAX_MODEL_LENGTH)
      ? response.model
      : (() => { throw new Error("gemini_interactions_response_model_invalid"); })();
  if (!Array.isArray(response.steps) || response.steps.length > MAX_STEP_COUNT) {
    throw new Error("gemini_interactions_steps_invalid");
  }
  const protectedSteps = response.steps.map(normalizeProviderStep);
  const toolCalls = geminiInteractionsToolBridge.parseToolCalls(protectedSteps);
  const rawFinalText = textFromSteps(protectedSteps);
  const finalText = visibleAnswerText(rawFinalText);
  const grounding = groundingDisplayEvent(protectedSteps);

  if (status === "requires_action" && toolCalls.length === 0) {
    throw new Error("gemini_interactions_required_action_missing");
  }
  if (status === "completed" && !finalText && toolCalls.length === 0) {
    throw new Error("gemini_interactions_empty_response");
  }
  return {
    finalText,
    grounding,
    id,
    model,
    protectedSteps,
    rawFinalText,
    status,
    toolCalls,
    usage: extractGeminiInteractionsUsage(response.usage)
  };
}

function resultFromNormalized(input: NormalizedInteraction): ProviderRunResult {
  return {
    finalProviderResponsePreview: responsePreview(input),
    finalText: input.finalText,
    ...(input.id ? { providerResponseId: input.id } : {}),
    providerToolCallMessage: input.toolCalls.length > 0 ? input.protectedSteps : undefined,
    toolCalls: input.toolCalls,
    usage: input.usage
  };
}

export async function* streamGeminiInteractionsJsonResponse(
  response: GeminiInteractionRecord,
  context: GeminiInteractionsResponseContext
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  const normalized = normalizeInteraction(response, context);
  yield geminiInteractionSummaryEvent({
    model: normalized.model,
    ...(normalized.id ? { providerResponseId: normalized.id } : {}),
    status: normalized.status
  });
  if (normalized.grounding) {
    yield normalized.grounding;
  }
  yield { data: normalized.usage, type: "usage" };
  if (normalized.finalText) {
    yield { data: { delta: normalized.finalText }, type: "token" };
  }
  return resultFromNormalized(normalized);
}

function streamIndex(value: unknown): number {
  const index = nonNegativeInteger(value);
  if (index === null || index >= MAX_STEP_COUNT) {
    throw new Error("gemini_interactions_stream_step_invalid");
  }
  return index;
}

function startStep(value: unknown, index: number): StreamStepAccumulator {
  if (!isRecord(value)) {
    throw new Error("gemini_interactions_stream_step_invalid");
  }

  switch (value.type) {
    case "model_output":
      return {
        argumentDelta: "",
        index,
        provisionalSignature: false,
        step: {
          content: value.content === undefined ? [] : validateTextContentArray(value.content),
          type: "model_output"
        }
      };
    case "thought": {
      const signature = signatureAtStepStart(value.signature);
      return {
        argumentDelta: "",
        index,
        provisionalSignature: signature.provisional,
        step: {
          ...(signature.signature ? { signature: signature.signature } : {}),
          ...(value.summary !== undefined ? { summary: validateTextContentArray(value.summary) } : {}),
          type: "thought"
        }
      };
    }
    case "function_call":
      if (
        !boundedString(value.id, MAX_TOOL_CALL_ID_LENGTH) ||
        !boundedString(value.name, MAX_TOOL_NAME_LENGTH)
      ) {
        throw new Error("gemini_interactions_stream_step_invalid");
      }
      return {
        argumentDelta: "",
        index,
        provisionalSignature: false,
        step: {
          arguments: value.arguments === undefined ? {} : validateArguments(value.arguments),
          id: value.id,
          name: value.name,
          ...(value.signature !== undefined ? { signature: validateSignature(value.signature) } : {}),
          type: "function_call"
        }
      };
    case "google_search_call":
    case "google_search_result": {
      const signature = signatureAtStepStart(value.signature);
      return {
        argumentDelta: "",
        index,
        provisionalSignature: signature.provisional,
        step: normalizeProviderStep({
          ...value,
          ...(signature.provisional ? { signature: undefined } : {})
        })
      };
    }
    default:
      throw new Error("gemini_interactions_stream_step_unsupported");
  }
}

function textContent(step: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(step.content) ? step.content : [];
  const latest = content.at(-1);
  if (isRecord(latest) && latest.type === "text") {
    return latest;
  }
  const block: Record<string, unknown> = { text: "", type: "text" };
  content.push(block);
  step.content = content;
  return block;
}

function appendDelta(accumulator: StreamStepAccumulator, value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("gemini_interactions_stream_delta_invalid");
  }
  const step = accumulator.step;

  if (step.type === "model_output" && value.type === "text" && typeof value.text === "string") {
    const block = textContent(step);
    block.text = `${typeof block.text === "string" ? block.text : ""}${value.text}`;
    return value.text;
  }
  if (step.type === "model_output" && value.type === "text_annotation_delta") {
    if (!Array.isArray(value.annotations) || value.annotations.length > MAX_CITATION_COUNT) {
      throw new Error("gemini_interactions_grounding_invalid");
    }
    const block = textContent(step);
    const annotations = Array.isArray(block.annotations) ? block.annotations : [];
    annotations.push(...value.annotations);
    if (annotations.length > MAX_CITATION_COUNT) {
      throw new Error("gemini_interactions_grounding_invalid");
    }
    block.annotations = annotations;
    return null;
  }
  if (step.type === "thought" && value.type === "thought_signature") {
    step.signature = validateSignature(value.signature);
    return null;
  }
  if (step.type === "thought" && value.type === "thought_summary") {
    const content = validateTextContent(value.content);
    const summary = Array.isArray(step.summary) ? step.summary : [];
    summary.push(content);
    step.summary = summary;
    return null;
  }
  if (step.type === "function_call" && value.type === "arguments_delta") {
    if (typeof value.arguments !== "string") {
      throw new Error("gemini_interactions_tool_arguments_invalid");
    }
    accumulator.argumentDelta += value.arguments;
    return null;
  }
  if (step.type === "google_search_call" && value.type === "google_search_call") {
    if (value.arguments !== undefined) step.arguments = validateSearchArguments(value.arguments);
    if (value.signature !== undefined) step.signature = validateSignature(value.signature);
    return null;
  }
  if (step.type === "google_search_result" && value.type === "google_search_result") {
    if (value.result !== undefined) step.result = validateSearchResults(value.result);
    if (value.signature !== undefined) step.signature = validateSignature(value.signature);
    if (value.is_error !== undefined) {
      if (typeof value.is_error !== "boolean") {
        throw new Error("gemini_interactions_grounding_invalid");
      }
      step.is_error = value.is_error;
    }
    return null;
  }

  throw new Error("gemini_interactions_stream_delta_invalid");
}

function finalizeStep(accumulator: StreamStepAccumulator): Record<string, unknown> {
  if (accumulator.provisionalSignature && accumulator.step.signature === undefined) {
    throw new Error("gemini_interactions_step_invalid");
  }
  if (accumulator.step.type === "function_call" && accumulator.argumentDelta) {
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(accumulator.argumentDelta) as unknown;
    } catch {
      throw new Error("gemini_interactions_tool_arguments_invalid");
    }
    accumulator.step.arguments = validateArguments(argumentsValue);
  }
  return normalizeProviderStep(geminiInteractionStepForWire(accumulator.step));
}

function totalUsageFromEvent(event: Record<string, unknown>): unknown {
  const metadata = isRecord(event.metadata) ? event.metadata : null;
  return metadata?.total_usage ?? event.usage;
}

function interactionFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(event.interaction)) {
    throw new Error("gemini_interactions_stream_interaction_invalid");
  }
  return event.interaction;
}

export async function* parseGeminiInteractionsSse(
  input: ParseGeminiInteractionsSseInput
): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
  const activeSteps = new Map<number, StreamStepAccumulator>();
  const protectedSteps: Record<string, unknown>[] = [];
  let created = false;
  let done = false;
  let terminal = false;
  let interactionId = "";
  let model = input.modelId;
  let terminalStatus: "completed" | "requires_action" | null = null;
  let usage = extractGeminiInteractionsUsage(undefined);
  let groundingProven = false;
  let groundingDecisionPending = input.groundingExpected;
  let groundingReady = false;
  let finalGroundingEmitted = false;
  let searchCallCount = 0;
  let searchQueryCount = 0;
  let streamedRawText = "";
  const bufferedText: string[] = [];

  for await (const event of parseSseStream(input.responseBody, {
    idleTimeoutMs: input.idleTimeoutMs,
    signal: input.signal
  })) {
    if (done) {
      throw new Error("gemini_interactions_stream_trailing_data");
    }
    if (event.data === "[DONE]") {
      if (event.event !== "done" || !terminal) {
        throw new Error("gemini_interactions_stream_truncated");
      }
      done = true;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch {
      throw new Error("gemini_interactions_stream_invalid_json");
    }
    if (!isRecord(parsed) || typeof parsed.event_type !== "string" || event.event !== parsed.event_type) {
      throw new Error("gemini_interactions_stream_event_invalid");
    }
    if (terminal) {
      throw new Error("gemini_interactions_stream_trailing_data");
    }

    const eventType = parsed.event_type;
    if (eventType === "error") {
      throw new Error("gemini_interactions_stream_error");
    }
    if (!created && eventType !== "interaction.created") {
      throw new Error("gemini_interactions_stream_created_missing");
    }

    const cumulativeUsage = totalUsageFromEvent(parsed);
    if (cumulativeUsage !== undefined) {
      usage = extractGeminiInteractionsUsage(cumulativeUsage);
    }

    if (eventType === "interaction.created") {
      if (created) {
        throw new Error("gemini_interactions_stream_created_duplicate");
      }
      const interaction = interactionFromEvent(parsed);
      if (typeof interaction.id !== "string") {
        throw new Error("gemini_interactions_stream_created_id_missing");
      }
      if (interaction.id.length > MAX_INTERACTION_ID_LENGTH) {
        throw new Error("gemini_interactions_stream_created_id_too_long");
      }
      if (interaction.id && !boundedString(interaction.id, MAX_INTERACTION_ID_LENGTH)) {
        throw new Error("gemini_interactions_stream_created_id_invalid");
      }
      if (statusValue(interaction.status) !== "in_progress") {
        throw new Error("gemini_interactions_stream_created_status_invalid");
      }
      if (interaction.model !== undefined) {
        if (!boundedString(interaction.model, MAX_MODEL_LENGTH)) {
          throw new Error("gemini_interactions_stream_created_model_invalid");
        }
        model = interaction.model;
      }
      created = true;
      interactionId = interaction.id;
      yield geminiInteractionSummaryEvent({
        model,
        ...(interactionId ? { providerResponseId: interactionId } : {}),
        status: "in_progress"
      });
      continue;
    }

    if (eventType === "interaction.status_update") {
      if (
        typeof parsed.interaction_id !== "string" ||
        (parsed.interaction_id !== "" &&
          !boundedString(parsed.interaction_id, MAX_INTERACTION_ID_LENGTH)) ||
        (interactionId && parsed.interaction_id !== "" && parsed.interaction_id !== interactionId) ||
        !statusValue(parsed.status)
      ) {
        throw new Error("gemini_interactions_stream_status_invalid");
      }
      if (parsed.interaction_id) interactionId = parsed.interaction_id;
      if (parsed.status === "failed" || parsed.status === "cancelled" || parsed.status === "incomplete") {
        throw interactionFailure(parsed.status);
      }
      continue;
    }

    if (eventType === "step.start") {
      const index = streamIndex(parsed.index);
      if (
        activeSteps.size > 0 ||
        activeSteps.has(index) ||
        protectedSteps.length >= MAX_STEP_COUNT ||
        index !== protectedSteps.length
      ) {
        throw new Error("gemini_interactions_stream_step_invalid");
      }
      const accumulator = startStep(parsed.step, index);
      activeSteps.set(index, accumulator);
      if (accumulator.step.type === "google_search_call") {
        groundingProven = true;
        groundingDecisionPending = false;
        searchCallCount += 1;
        searchQueryCount += queryCountFromSearchCall(accumulator.step);
        if (searchCallCount > MAX_SEARCH_CALL_COUNT || searchQueryCount > MAX_SEARCH_QUERY_COUNT) {
          throw new Error("gemini_interactions_grounding_invalid");
        }
        yield groundingMarkerEvent(searchCallCount, searchQueryCount);
      } else if (accumulator.step.type === "google_search_result" && !groundingProven) {
        groundingProven = true;
        groundingDecisionPending = false;
        yield groundingMarkerEvent(searchCallCount, searchQueryCount);
      }
      const initialText = textFromSteps([protectGeminiInteractionStep(accumulator.step)]);
      if (initialText) {
        streamedRawText += initialText;
        if ((groundingDecisionPending || groundingProven) && !groundingReady) {
          bufferedText.push(initialText);
        } else {
          yield { data: { delta: initialText }, type: "token" };
        }
      }
      continue;
    }

    if (eventType === "step.delta") {
      const index = streamIndex(parsed.index);
      const accumulator = activeSteps.get(index);
      if (!accumulator) {
        throw new Error("gemini_interactions_stream_step_invalid");
      }
      const previousQueryCount = accumulator.step.type === "google_search_call"
        ? queryCountFromSearchCall(accumulator.step)
        : 0;
      const textDelta = appendDelta(accumulator, parsed.delta);
      if (accumulator.step.type === "google_search_call") {
        searchQueryCount += queryCountFromSearchCall(accumulator.step) - previousQueryCount;
        if (searchQueryCount < 0 || searchQueryCount > MAX_SEARCH_QUERY_COUNT) {
          throw new Error("gemini_interactions_grounding_invalid");
        }
      }
      if (
        groundingProven &&
        !groundingReady &&
        accumulator.step.type === "google_search_result"
      ) {
        const candidateSteps = [
          ...protectedSteps,
          protectGeminiInteractionStep(accumulator.step)
        ];
        if (hasSearchSuggestions(candidateSteps)) {
          const grounding = groundingDisplayEvent(candidateSteps);
          if (!grounding || !grounding.data.suggestionsHtml) {
            throw new Error("gemini_interactions_grounding_suggestions_missing");
          }
          groundingReady = true;
          yield grounding;
          for (const buffered of bufferedText.splice(0)) {
            yield { data: { delta: buffered }, type: "token" };
          }
        }
      }
      if (textDelta) {
        streamedRawText += textDelta;
        if ((groundingDecisionPending || groundingProven) && !groundingReady) {
          bufferedText.push(textDelta);
        } else {
          yield { data: { delta: textDelta }, type: "token" };
        }
      }
      continue;
    }

    if (eventType === "step.stop") {
      const index = streamIndex(parsed.index);
      const accumulator = activeSteps.get(index);
      if (!accumulator) {
        throw new Error("gemini_interactions_stream_step_invalid");
      }
      activeSteps.delete(index);
      protectedSteps.push(finalizeStep(accumulator));
      if (
        groundingProven &&
        !groundingReady &&
        accumulator.step.type === "google_search_result" &&
        hasSearchSuggestions(protectedSteps)
      ) {
        const grounding = groundingDisplayEvent(protectedSteps);
        if (!grounding || !grounding.data.suggestionsHtml) {
          throw new Error("gemini_interactions_grounding_suggestions_missing");
        }
        groundingReady = true;
        yield grounding;
        for (const buffered of bufferedText.splice(0)) {
          yield { data: { delta: buffered }, type: "token" };
        }
      }
      if (parsed.usage !== undefined) {
        usage = extractGeminiInteractionsUsage(parsed.usage);
      }
      if (parsed.usage !== undefined || cumulativeUsage !== undefined) {
        yield { data: usage, type: "usage" };
      }
      continue;
    }

    if (eventType === "interaction.completed") {
      if (activeSteps.size > 0) {
        throw new Error("gemini_interactions_stream_step_unfinished");
      }
      const interaction = interactionFromEvent(parsed);
      if (
        typeof interaction.id !== "string" ||
        (interaction.id !== "" && !boundedString(interaction.id, MAX_INTERACTION_ID_LENGTH)) ||
        (interactionId && interaction.id !== "" && interaction.id !== interactionId)
      ) {
        throw new Error("gemini_interactions_stream_completed_id_invalid");
      }
      if (interaction.id) interactionId = interaction.id;
      terminalStatus = validateTerminalStatus(interaction.status);
      if (interaction.steps !== undefined) {
        if (!Array.isArray(interaction.steps) || interaction.steps.length > MAX_STEP_COUNT) {
          throw new Error("gemini_interactions_steps_invalid");
        }
        if (!groundingProven) {
          const terminalSearchCalls = interaction.steps
            .filter((step) => isRecord(step) && step.type === "google_search_call")
            .map(normalizeProviderStep);
          if (terminalSearchCalls.length > 0) {
            const terminalQueryCount = terminalSearchCalls.reduce(
              (count, step) => count + queryCountFromSearchCall(geminiInteractionStepForWire(step)),
              0
            );
            groundingProven = true;
            groundingDecisionPending = false;
            searchCallCount = terminalSearchCalls.length;
            searchQueryCount = terminalQueryCount;
            yield groundingMarkerEvent(searchCallCount, searchQueryCount);
          }
        }
        const terminalSteps = interaction.steps.map(normalizeProviderStep);
        const terminalText = textFromSteps(terminalSteps);
        if (streamedRawText && terminalText !== streamedRawText) {
          throw new Error("gemini_interactions_stream_text_mismatch");
        }
        protectedSteps.splice(0, protectedSteps.length, ...terminalSteps);
      }
      const terminalGrounding = groundingDisplayEvent(protectedSteps);
      if (terminalGrounding) {
        if (
          !terminalGrounding.data.suggestionsHtml ||
          (input.groundingExpected && terminalGrounding.data.runSearch.callCount === 0)
        ) {
          throw new Error("gemini_interactions_grounding_suggestions_missing");
        }
        groundingReady = true;
        finalGroundingEmitted = true;
        yield terminalGrounding;
        for (const buffered of bufferedText.splice(0)) {
          yield { data: { delta: buffered }, type: "token" };
        }
      } else if (groundingProven) {
        throw new Error("gemini_interactions_grounding_suggestions_missing");
      } else if (groundingDecisionPending) {
        groundingDecisionPending = false;
        for (const buffered of bufferedText.splice(0)) {
          yield { data: { delta: buffered }, type: "token" };
        }
      }
      if (interaction.usage !== undefined) {
        usage = extractGeminiInteractionsUsage(interaction.usage);
        yield { data: usage, type: "usage" };
      } else if (cumulativeUsage !== undefined) {
        yield { data: usage, type: "usage" };
      }
      terminal = true;
      continue;
    }

    throw new Error("gemini_interactions_stream_event_unsupported");
  }

  if (!created || !terminal || !done || !terminalStatus || activeSteps.size > 0) {
    throw new Error("gemini_interactions_stream_truncated");
  }

  const rawFinalText = textFromSteps(protectedSteps);
  const finalText = visibleAnswerText(rawFinalText);
  const toolCalls = geminiInteractionsToolBridge.parseToolCalls(protectedSteps);
  if (terminalStatus === "requires_action" && toolCalls.length === 0) {
    throw new Error("gemini_interactions_required_action_missing");
  }
  if (terminalStatus === "completed" && !finalText && toolCalls.length === 0) {
    throw new Error("gemini_interactions_empty_response");
  }

  const normalized: NormalizedInteraction = {
    finalText,
    grounding: groundingDisplayEvent(protectedSteps),
    id: interactionId,
    model,
    protectedSteps,
    rawFinalText,
    status: terminalStatus,
    toolCalls,
    usage
  };
  if (normalized.grounding && !finalGroundingEmitted) {
    yield normalized.grounding;
  }
  return resultFromNormalized(normalized);
}
