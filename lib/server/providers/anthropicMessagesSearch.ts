import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { adminSearchExecutionLimits } from "../../contracts/adminSearch";
import { ANTHROPIC_WEB_SEARCH_TOOL_DECLARATION } from "../tools/bridges";
import {
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  type SearchSource
} from "../search/evidence";
import { assertBoundedStructuredTextLength } from "./boundedText";
import { withTimeoutSignal } from "./network";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest,
  type ProviderSearchResult
} from "./types";

const MAX_ANTHROPIC_MESSAGE_ID_LENGTH = 512;
const MAX_ANTHROPIC_MODEL_ID_LENGTH = 256;
const MAX_ANTHROPIC_SEARCH_BLOCKS = 256;
const MAX_ANTHROPIC_PAUSE_CONTINUATIONS = 3;
const MAX_ANTHROPIC_SEARCH_CONTINUATION_BLOCKS =
  MAX_ANTHROPIC_SEARCH_BLOCKS * (MAX_ANTHROPIC_PAUSE_CONTINUATIONS + 1);
const MAX_ANTHROPIC_SEARCH_OPERATIONS = 32;
const MAX_ANTHROPIC_SEARCH_QUERY_LENGTH = 2_048;
const MAX_ANTHROPIC_SEARCH_RESULT_COUNT = 100;
const MAX_ANTHROPIC_SEARCH_CITATIONS = 100;
const MAX_ANTHROPIC_SEARCH_TITLE_LENGTH = 512;
const MAX_ANTHROPIC_SEARCH_URL_LENGTH = 2_048;
const MAX_ANTHROPIC_CITED_TEXT_LENGTH = 2_000;
const MAX_ANTHROPIC_OPAQUE_FIELD_LENGTH = 2 * 1_024 * 1_024;
export const ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS = 8 * 1_024 * 1_024;
const MAX_ANTHROPIC_WEB_SEARCH_REQUESTS = 100;

const anthropicEffortOrder = ["low", "medium", "high", "xhigh", "max"] as const;
const embeddedSearchErrorCodes = new Set([
  "invalid_tool_input",
  "max_uses_exceeded",
  "query_too_long",
  "request_too_large",
  "too_many_requests",
  "unavailable"
]);
const terminalStopReasons = new Set([
  "end_turn",
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "refusal",
  "stop_sequence",
  "tool_use"
]);

export type AnthropicMessagesCreateOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type AnthropicMessagesSearchClient = Readonly<{
  createMessage(
    body: Record<string, unknown>,
    options?: AnthropicMessagesCreateOptions
  ): Promise<Record<string, unknown>>;
}>;

export type AnthropicMessagesSearchRequestBody = Readonly<{
  max_tokens: number;
  messages: readonly [{
    content: readonly [{ text: string; type: "text" }];
    role: "user";
  }];
  model: string;
  output_config?: Readonly<{ effort: string }>;
  stream: false;
  system: string;
  thinking?: Readonly<{ type: "adaptive" }>;
  tools: readonly [Readonly<{
    allowed_callers: readonly ["direct"];
    max_uses: 3;
    name: "web_search";
    type: "web_search_20250305";
  }>];
}>;

export type AnthropicWebSearchUsage = Readonly<{
  present: boolean;
  requests: number;
}>;

export type AnthropicSearchInspection = Readonly<{
  artifacts: ModelRunSseEvent[];
  embeddedErrorCode?: string;
  findingsText: string;
  operationCount: number;
  sources: SearchSource[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function tokenValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("anthropic_usage_invalid");
  }
  return value;
}

function safeAnthropicMessageUsage(usage: ModelRunUsage): ModelRunUsage {
  if (Object.values(usage).some((value) =>
    value !== undefined && value !== null &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))) {
    throw new Error("anthropic_usage_invalid");
  }
  return usage;
}

export function updateAnthropicMessageUsage(
  previous: ModelRunUsage,
  value: unknown
): ModelRunUsage {
  const usage = isRecord(value) ? value : null;
  if (!usage) return safeAnthropicMessageUsage(previous);

  const uncachedInputTokens =
    tokenValue(usage.input_tokens) ?? tokenValue(usage.uncached_input_tokens);
  const cachedInputTokens =
    tokenValue(usage.cache_read_input_tokens) ?? previous.cachedInputTokens ?? 0;
  const cacheWriteInputTokens =
    tokenValue(usage.cache_creation_input_tokens) ?? previous.cacheWriteInputTokens ?? 0;
  const hasInputUsage = uncachedInputTokens !== undefined ||
    tokenValue(usage.cache_read_input_tokens) !== undefined ||
    tokenValue(usage.cache_creation_input_tokens) !== undefined;
  const inputTokens = hasInputUsage
    ? (uncachedInputTokens ?? 0) + cachedInputTokens + cacheWriteInputTokens
    : previous.inputTokens;
  const outputTokens = tokenValue(usage.output_tokens) ?? previous.outputTokens;
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : null;
  const reasoningTokens =
    tokenValue(outputDetails?.thinking_tokens) ??
    tokenValue(usage.reasoning_output_tokens) ??
    tokenValue(usage.thinking_output_tokens) ??
    previous.reasoningTokens;
  const totalTokens = tokenValue(usage.total_tokens);

  return safeAnthropicMessageUsage(normalizeTokenUsage({
    cachedInputTokens,
    cacheWriteInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {})
  }));
}

export function extractAnthropicMessageUsage(value: unknown): ModelRunUsage {
  return updateAnthropicMessageUsage({
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  }, value);
}

export function addAnthropicMessageUsage(
  left: ModelRunUsage,
  right: ModelRunUsage
): ModelRunUsage {
  return safeAnthropicMessageUsage(sumTokenUsage([left, right]));
}

export function updateAnthropicWebSearchUsage(
  previous: AnthropicWebSearchUsage,
  value: unknown
): AnthropicWebSearchUsage {
  const usage = isRecord(value) ? value : null;
  if (!usage || usage.server_tool_use === undefined) return previous;
  if (!isRecord(usage.server_tool_use)) {
    throw new Error("anthropic_search_usage_invalid");
  }
  const rawCount = usage.server_tool_use.web_search_requests;
  if (rawCount === undefined) return previous;
  const requests = nonNegativeInteger(rawCount);
  if (requests === undefined || requests > MAX_ANTHROPIC_WEB_SEARCH_REQUESTS) {
    throw new Error("anthropic_search_usage_invalid");
  }
  return { present: true, requests };
}

export function addAnthropicWebSearchUsage(
  left: AnthropicWebSearchUsage,
  right: AnthropicWebSearchUsage
): AnthropicWebSearchUsage {
  const requests = left.requests + right.requests;
  if (!Number.isSafeInteger(requests) || requests > MAX_ANTHROPIC_WEB_SEARCH_REQUESTS) {
    throw new Error("anthropic_search_usage_invalid");
  }
  return {
    present: left.present || right.present,
    requests
  };
}

function anthropicSearchPolicy(request: ProviderSearchRequest) {
  const policy = request.searchPolicy;
  if (
    policy.provider !== "anthropic" ||
    policy.strategyId !== "anthropic-web-search" ||
    !boundedString(policy.modelId, MAX_ANTHROPIC_MODEL_ID_LENGTH) ||
    !boundedString(request.strategyId, 512) ||
    !Number.isSafeInteger(policy.maxOutputTokens) ||
    policy.maxOutputTokens < adminSearchExecutionLimits.maxOutputTokens.minimum ||
    policy.maxOutputTokens > adminSearchExecutionLimits.maxOutputTokens.maximum ||
    (policy.reasoningPolicy !== "lowest_supported" &&
      policy.reasoningPolicy !== "provider_default")
  ) {
    throw new Error("anthropic_search_policy_invalid");
  }
  return policy;
}

export function lowestSupportedAnthropicSearchEffort(
  capabilities: ProviderModelCapabilities
): string | undefined {
  if (!capabilities.reasoning) return undefined;
  const supported = new Set(
    Array.isArray(capabilities.reasoningEfforts)
      ? capabilities.reasoningEfforts.filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0)
      : []
  );
  return anthropicEffortOrder.find((effort) => supported.has(effort));
}

export function buildAnthropicMessagesSearchRequest(
  request: ProviderSearchRequest
): AnthropicMessagesSearchRequestBody {
  const policy = anthropicSearchPolicy(request);
  const effort = policy.reasoningPolicy === "lowest_supported"
    ? lowestSupportedAnthropicSearchEffort(policy.modelCapabilities)
    : undefined;
  return {
    max_tokens: policy.maxOutputTokens,
    messages: [{
      content: [{ text: request.query, type: "text" }],
      role: "user"
    }],
    model: policy.modelId.trim(),
    ...(effort
      ? {
          output_config: { effort },
          thinking: { type: "adaptive" as const }
        }
      : {}),
    stream: false,
    system: "Use Web Search for the query and return concise source-backed findings.",
    tools: [{
      ...ANTHROPIC_WEB_SEARCH_TOOL_DECLARATION,
      allowed_callers: ["direct"]
    }]
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function searchCall(value: Record<string, unknown>): Readonly<{
  id: string;
  query: string;
}> {
  const input = isRecord(value.input) ? value.input : null;
  const id = boundedString(value.id, MAX_ANTHROPIC_MESSAGE_ID_LENGTH);
  const query = input
    ? boundedString(input.query, MAX_ANTHROPIC_SEARCH_QUERY_LENGTH)
    : undefined;
  if (
    value.type !== "server_tool_use" ||
    value.name !== "web_search" ||
    !exactKeys(value, ["id", "input", "name", "type"]) ||
    !id ||
    !input ||
    !exactKeys(input, ["query"]) ||
    !query
  ) {
    throw new Error("anthropic_search_response_invalid");
  }
  return { id, query };
}

function resultSource(value: Record<string, unknown>): Record<string, unknown> {
  if (
    value.type !== "web_search_result" ||
    !exactKeys(value, ["encrypted_content", "page_age", "title", "type", "url"]) ||
    !boundedString(value.url, MAX_ANTHROPIC_SEARCH_URL_LENGTH) ||
    !boundedString(value.title, MAX_ANTHROPIC_SEARCH_TITLE_LENGTH) ||
    !boundedString(value.encrypted_content, MAX_ANTHROPIC_OPAQUE_FIELD_LENGTH) ||
    (value.page_age !== undefined && value.page_age !== null &&
      !boundedString(value.page_age, 80))
  ) {
    throw new Error("anthropic_search_response_invalid");
  }
  return {
    ...(typeof value.page_age === "string" ? { date: value.page_age } : {}),
    title: value.title,
    url: value.url
  };
}

function embeddedError(value: Record<string, unknown>): string {
  if (
    value.type !== "web_search_tool_result_error" ||
    !exactKeys(value, ["error_code", "type"]) ||
    typeof value.error_code !== "string" ||
    !embeddedSearchErrorCodes.has(value.error_code)
  ) {
    throw new Error("anthropic_search_response_invalid");
  }
  return `anthropic_search_${value.error_code}`;
}

function directSearchCaller(value: unknown): boolean {
  return isRecord(value) && value.type === "direct" && exactKeys(value, ["type"]);
}

function citationSource(value: Record<string, unknown>): Record<string, unknown> {
  if (
    value.type !== "web_search_result_location" ||
    !exactKeys(value, ["cited_text", "encrypted_index", "title", "type", "url"]) ||
    !boundedString(value.url, MAX_ANTHROPIC_SEARCH_URL_LENGTH) ||
    (value.title !== null &&
      !boundedString(value.title, MAX_ANTHROPIC_SEARCH_TITLE_LENGTH)) ||
    !boundedString(value.encrypted_index, MAX_ANTHROPIC_OPAQUE_FIELD_LENGTH) ||
    !boundedString(value.cited_text, MAX_ANTHROPIC_CITED_TEXT_LENGTH)
  ) {
    throw new Error("anthropic_search_response_invalid");
  }
  return {
    snippet: value.cited_text,
    title: typeof value.title === "string" ? value.title : value.url,
    url: value.url
  };
}

function operationArtifact(input: Readonly<{
  id: string;
  outputIndex: number;
  query: string;
  status: "completed" | "error" | "running";
  webSearchUsage?: AnthropicWebSearchUsage;
}>): ModelRunSseEvent {
  return {
    data: {
      artifactType: "search",
      payload: {
        action: { query: input.query, type: "search" },
        id: input.id,
        outputIndex: input.outputIndex,
        provider: "anthropic",
        status: input.status,
        type: "web_search_call",
        ...(input.webSearchUsage?.present
          ? { webSearchRequests: input.webSearchUsage.requests }
          : {})
      }
    },
    type: "artifact"
  };
}

function truncationArtifact(): ModelRunSseEvent {
  return {
    data: {
      artifactType: "search",
      payload: {
        outputIndex: Number.MAX_SAFE_INTEGER,
        provider: "anthropic",
        type: "web_search_call"
      }
    },
    type: "artifact"
  };
}

export function inspectAnthropicWebSearchContent(
  value: unknown,
  options: Readonly<{
    allowUnmatchedCalls?: boolean;
    maxReplayCharacters?: number;
    webSearchUsage?: AnthropicWebSearchUsage;
  }> = {}
): AnthropicSearchInspection {
  if (!Array.isArray(value) ||
    value.length > MAX_ANTHROPIC_SEARCH_CONTINUATION_BLOCKS) {
    throw new Error("anthropic_search_response_invalid");
  }
  assertBoundedStructuredTextLength({
    maxChars: options.maxReplayCharacters ?? ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS,
    retainedTextKind: "citations",
    value
  });

  const calls = new Map<string, { outputIndex: number; query: string }>();
  const results = new Map<string, { embeddedErrorCode?: string; sources: Record<string, unknown>[] }>();
  const citationCandidates: Record<string, unknown>[] = [];
  const textParts: string[] = [];

  for (const [outputIndex, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      throw new Error("anthropic_search_response_invalid");
    }
    if (candidate.type === "server_tool_use") {
      const call = searchCall(candidate);
      if (calls.has(call.id)) throw new Error("anthropic_search_response_invalid");
      calls.set(call.id, { outputIndex, query: call.query });
      continue;
    }
    if (candidate.type === "web_search_tool_result") {
      const toolUseId = boundedString(
        candidate.tool_use_id,
        MAX_ANTHROPIC_MESSAGE_ID_LENGTH
      );
      if (
        !exactKeys(candidate, ["caller", "content", "tool_use_id", "type"]) ||
        !directSearchCaller(candidate.caller) ||
        !toolUseId ||
        !calls.has(toolUseId) ||
        results.has(toolUseId)
      ) {
        throw new Error("anthropic_search_response_invalid");
      }
      if (Array.isArray(candidate.content)) {
        if (candidate.content.length > MAX_ANTHROPIC_SEARCH_RESULT_COUNT) {
          throw new Error("anthropic_search_response_invalid");
        }
        const sources = candidate.content.map((item) => {
          if (!isRecord(item)) throw new Error("anthropic_search_response_invalid");
          return resultSource(item);
        });
        results.set(toolUseId, { sources });
      } else if (isRecord(candidate.content)) {
        results.set(toolUseId, {
          embeddedErrorCode: embeddedError(candidate.content),
          sources: []
        });
      } else {
        throw new Error("anthropic_search_response_invalid");
      }
      continue;
    }
    if (candidate.type === "tool_use") {
      throw new Error("anthropic_search_client_tool_unexpected");
    }
    if (candidate.type === "thinking" || candidate.type === "redacted_thinking") {
      continue;
    }
    if (
      candidate.type !== "text" ||
      !exactKeys(candidate, ["citations", "text", "type"]) ||
      typeof candidate.text !== "string"
    ) {
      throw new Error("anthropic_search_response_invalid");
    }
    textParts.push(candidate.text);
    if (candidate.citations === undefined) continue;
    if (!Array.isArray(candidate.citations) ||
      candidate.citations.length > MAX_ANTHROPIC_SEARCH_CITATIONS) {
      throw new Error("anthropic_search_response_invalid");
    }
    for (const citation of candidate.citations) {
      if (!isRecord(citation)) throw new Error("anthropic_search_response_invalid");
      citationCandidates.push(citationSource(citation));
    }
  }

  for (const id of calls.keys()) {
    if (!results.has(id) && !options.allowUnmatchedCalls) {
      throw new Error("anthropic_search_result_missing");
    }
  }

  const artifacts: ModelRunSseEvent[] = [];
  let embeddedErrorCode: string | undefined;
  let operationIndex = 0;
  let operationsTruncated = false;
  const resultCandidates: Record<string, unknown>[] = [];
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (!result && !options.allowUnmatchedCalls) continue;
    if (operationIndex < MAX_ANTHROPIC_SEARCH_OPERATIONS) {
      artifacts.push(operationArtifact({
        id,
        outputIndex: call.outputIndex,
        query: call.query,
        status: !result
          ? "running"
          : result.embeddedErrorCode
            ? "error"
            : "completed",
        webSearchUsage: options.webSearchUsage
      }));
    } else {
      operationsTruncated = true;
    }
    operationIndex += 1;
    if (result) {
      resultCandidates.push(...result.sources);
      embeddedErrorCode ??= result.embeddedErrorCode;
    }
  }
  if (operationsTruncated) artifacts.push(truncationArtifact());

  const sources = normalizeSearchSources([
    ...citationCandidates,
    ...resultCandidates
  ], 20);
  artifacts.push(...sources.map((source): ModelRunSseEvent => ({
    data: {
      artifactType: "citation",
      payload: {
        index: source.rank,
        source: "anthropic",
        ...(source.snippet ? { snippet: source.snippet } : {}),
        title: source.title,
        url: source.url
      }
    },
    type: "artifact"
  })));

  return {
    artifacts,
    ...(embeddedErrorCode ? { embeddedErrorCode } : {}),
    findingsText: textParts.join(""),
    operationCount: calls.size,
    sources
  };
}

function messageEnvelope(value: unknown): Readonly<{
  content: Record<string, unknown>[];
  id: string;
  model?: string;
  stopReason: string;
  usage: unknown;
}> {
  const id = isRecord(value)
    ? boundedString(value.id, MAX_ANTHROPIC_MESSAGE_ID_LENGTH)
    : undefined;
  const stopReason = isRecord(value) && typeof value.stop_reason === "string"
    ? value.stop_reason
    : undefined;
  if (
    !isRecord(value) ||
    value.type !== "message" ||
    value.role !== "assistant" ||
    !id ||
    (value.model !== undefined && !boundedString(value.model, MAX_ANTHROPIC_MODEL_ID_LENGTH)) ||
    !Array.isArray(value.content) ||
    value.content.length > MAX_ANTHROPIC_SEARCH_BLOCKS ||
    !stopReason ||
    !terminalStopReasons.has(stopReason) ||
    value.content.some((block) => !isRecord(block))
  ) {
    throw new Error("anthropic_search_response_invalid");
  }
  return {
    content: value.content as Record<string, unknown>[],
    id,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    stopReason,
    usage: value.usage
  };
}

function safeStopFailure(stopReason: string): string {
  return stopReason === "tool_use"
    ? "anthropic_search_client_tool_unexpected"
    : `anthropic_message_${stopReason}`;
}

function typedFailure(input: Readonly<{
  artifacts: ModelRunSseEvent[];
  code: string;
  providerStatus?: string;
  usage: ModelRunUsage;
}>): ProviderSearchExecutionError {
  return new ProviderSearchExecutionError(input);
}

function abortReasonMessage(signal: AbortSignal | undefined): string | undefined {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : undefined;
}

function isLocalSearchTimeout(input: Readonly<{
  deadlineSignal: AbortSignal;
  parentSignal?: AbortSignal;
}>): boolean {
  if (input.parentSignal?.aborted) {
    return abortReasonMessage(input.parentSignal) === "search_timeout";
  }
  if (!input.deadlineSignal.aborted) return false;
  const reason = input.deadlineSignal.reason;
  return reason instanceof Error &&
    (reason.name === "TimeoutError" ||
      reason.message === "search_timeout" ||
      /timed out|timeout/iu.test(reason.message));
}

function normalizedAggregateSources(
  sources: readonly SearchSource[]
): SearchSource[] {
  return normalizeSearchSources(sources.map((source) => ({
    ...(source.date ? { date: source.date } : {}),
    ...(source.snippet ? { snippet: source.snippet } : {}),
    title: source.title,
    url: source.url
  })), 20);
}

export function createAnthropicMessagesSearchAdapter(
  options: Readonly<{ client: AnthropicMessagesSearchClient }>
): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const body = buildAnthropicMessagesSearchRequest(request);
      return {
        body: {
          max_tokens: body.max_tokens,
          model: body.model,
          ...(body.output_config ? { output_config: body.output_config } : {}),
          stream: body.stream,
          ...(body.thinking ? { thinking: body.thinking } : {}),
          tool: {
            allowed_callers: ["direct"],
            max_uses: 3,
            name: "web_search",
            type: "web_search_20250305"
          }
        },
        provider: "anthropic",
        queryCharacters: request.query.length,
        redactions: [
          "search_query",
          "encrypted_content",
          "encrypted_index",
          "provider_response_body"
        ],
        stage: "tool_search"
      };
    },
    async search(request, searchOptions = {}): Promise<ProviderSearchResult> {
      const initialBody = buildAnthropicMessagesSearchRequest(request);
      const deadline = withTimeoutSignal(searchOptions.signal, searchOptions.timeoutMs);
      const messages: Record<string, unknown>[] = initialBody.messages.map((message) => ({
        content: message.content.map((block) => ({ ...block })),
        role: message.role
      }));
      const artifacts: ModelRunSseEvent[] = [];
      const assistantContent: Record<string, unknown>[] = [];
      let latestInspection: AnthropicSearchInspection | null = null;
      let totalUsage: ModelRunUsage = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0
      };
      let totalWebSearchUsage: AnthropicWebSearchUsage = { present: false, requests: 0 };
      let latestId: string | undefined;
      let latestModel: string | undefined;
      let continuationCount = 0;

      try {
        while (true) {
          let envelope: ReturnType<typeof messageEnvelope>;
          try {
            const response = await options.client.createMessage({
              ...initialBody,
              messages
            }, {
              signal: deadline.signal,
              ...(typeof searchOptions.timeoutMs === "number"
                ? { timeoutMs: searchOptions.timeoutMs }
                : {})
            });
            envelope = messageEnvelope(response);
          } catch (error) {
            if (error instanceof ProviderSearchExecutionError) throw error;
            if (isLocalSearchTimeout({
              deadlineSignal: deadline.signal,
              parentSignal: searchOptions.signal
            })) {
              throw typedFailure({
                artifacts: latestInspection?.artifacts ?? artifacts,
                code: "search_timeout",
                usage: totalUsage
              });
            }
            if (error instanceof Error && error.message.startsWith("anthropic_search_")) {
              throw typedFailure({
                artifacts: latestInspection?.artifacts ?? artifacts,
                code: error.message,
                usage: totalUsage
              });
            }
            throw error;
          }

          let attemptWebSearchUsage: AnthropicWebSearchUsage = {
            present: false,
            requests: 0
          };
          try {
            const attemptUsage = extractAnthropicMessageUsage(envelope.usage);
            attemptWebSearchUsage = updateAnthropicWebSearchUsage(
              attemptWebSearchUsage,
              envelope.usage
            );
            totalUsage = addAnthropicMessageUsage(totalUsage, attemptUsage);
            totalWebSearchUsage = addAnthropicWebSearchUsage(
              totalWebSearchUsage,
              attemptWebSearchUsage
            );
            assistantContent.push(...envelope.content);
            const inspection = inspectAnthropicWebSearchContent(assistantContent, {
              allowUnmatchedCalls: envelope.stopReason === "pause_turn",
              webSearchUsage: totalWebSearchUsage
            });
            latestInspection = inspection;
            if (inspection.embeddedErrorCode) {
              throw typedFailure({
                artifacts: inspection.artifacts,
                code: inspection.embeddedErrorCode,
                providerStatus: envelope.stopReason,
                usage: totalUsage
              });
            }
          } catch (error) {
            if (error instanceof ProviderSearchExecutionError) throw error;
            const code = error instanceof Error &&
              /^anthropic_[a-z0-9_]{1,120}$/u.test(error.message)
              ? error.message
              : "anthropic_search_response_invalid";
            throw typedFailure({
              artifacts: latestInspection?.artifacts ?? artifacts,
              code,
              providerStatus: envelope.stopReason,
              usage: totalUsage
            });
          }

          latestId = envelope.id;
          latestModel = envelope.model ?? latestModel;
          if (envelope.stopReason === "pause_turn") {
            if (continuationCount >= MAX_ANTHROPIC_PAUSE_CONTINUATIONS) {
              throw typedFailure({
                artifacts: latestInspection?.artifacts ?? artifacts,
                code: "anthropic_search_pause_limit_exceeded",
                providerStatus: envelope.stopReason,
                usage: totalUsage
              });
            }
            messages.push({ content: envelope.content, role: "assistant" });
            assertBoundedStructuredTextLength({
              maxChars: ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS,
              retainedTextKind: "citations",
              value: messages
            });
            continuationCount += 1;
            continue;
          }
          if (envelope.stopReason !== "end_turn") {
            throw typedFailure({
              artifacts: latestInspection?.artifacts ?? artifacts,
              code: safeStopFailure(envelope.stopReason),
              providerStatus: envelope.stopReason,
              usage: totalUsage
            });
          }
          break;
        }
      } finally {
        deadline.clear();
      }

      const finalInspection = latestInspection;
      if (!finalInspection) {
        throw typedFailure({
          artifacts,
          code: "anthropic_search_response_invalid",
          usage: totalUsage
        });
      }
      artifacts.push(...finalInspection.artifacts);
      const operationCount = finalInspection.operationCount;
      if (operationCount === 0) {
        throw typedFailure({
          artifacts,
          code: "anthropic_search_operation_missing",
          providerStatus: "end_turn",
          usage: totalUsage
        });
      }
      let normalizedFindings: string;
      try {
        const joinedFindings = finalInspection.findingsText;
        if (joinedFindings.length > MAX_SEARCH_FINDINGS_CHARACTERS) {
          throw new Error("search_findings_invalid");
        }
        normalizedFindings = normalizeSearchFindings(joinedFindings);
      } catch {
        throw typedFailure({
          artifacts: artifacts.filter((event) =>
            event.type !== "artifact" || event.data.artifactType !== "citation"),
          code: "anthropic_search_findings_invalid",
          usage: totalUsage
        });
      }
      const normalizedSources = normalizedAggregateSources(finalInspection.sources);
      if (normalizedSources.length === 0) {
        throw typedFailure({
          artifacts: artifacts.filter((event) =>
            event.type !== "artifact" || event.data.artifactType !== "citation"),
          code: "anthropic_search_sources_missing",
          providerStatus: "end_turn",
          usage: totalUsage
        });
      }

      return {
        artifacts,
        finalProviderResponsePreview: {
          continuationCount,
          findingsCharacters: normalizedFindings.length,
          model: latestModel ?? initialBody.model,
          operationCount,
          provider: "anthropic",
          sourceCount: normalizedSources.length,
          status: "completed",
          usage: totalUsage,
          ...(totalWebSearchUsage.present
            ? { webSearchRequests: totalWebSearchUsage.requests }
            : {})
        },
        findings: normalizedFindings,
        ...(latestId ? { providerResponseId: latestId } : {}),
        requestPreview: adapter.buildRequestPreview(request),
        sourceAttribution: "available",
        sources: normalizedSources,
        usage: totalUsage
      };
    }
  };
  return adapter;
}
