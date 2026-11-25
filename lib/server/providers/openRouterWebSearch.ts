import { OPENROUTER_WEB_SEARCH_TECHNICAL_MODELS } from "../../domain/catalog";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeOpenRouterParams } from "../../domain/providerParams";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { storableUtf16Text, takeUtf16SafePrefix } from "../../domain/utf16";
import {
  normalizeSearchSources,
  SEARCH_NO_RESULTS_FINDINGS,
  type SearchSource
} from "../search/evidence";
import { SEARCH_RESULT_LIST_FINDINGS } from "../search/toolResult";
import { createFetchOpenAIChatCompletionClient } from "./openaiCompatibleChatTransport";
import { buildProviderRouting } from "./openRouterChatRequest";
import { reportedUsageCostUsd } from "./reportedUsageCost";
import { providerResponseFailure } from "./responseFailure";
import { dispatchSearchRequest } from "./searchDispatch";
import { markProviderStreamDrop } from "./streamDrop";
import {
  ProviderSearchExecutionError,
  type ProviderModelCapabilities,
  type ProviderSearchAdapter,
  type ProviderSearchRequest,
  type ProviderSearchResult
} from "./types";

/** The policy discriminator of an OpenRouter web search source. */
export const OPENROUTER_WEB_SEARCH_STRATEGY_ID = "openrouter-web-search";

/** Results one search asks for (`max_results`): ten whole entries fit the
 * tool result the model reads without a cut (search-v2, 2026-11-26). */
export const OPENROUTER_WEB_SEARCH_RESULT_COUNT = 10;

/** The request, and once more when the model did not search or its search
 * found nothing: 6–7% of the technical model's searches came back empty in
 * the 2026-11-26 eval (task Decisions). A second empty answer is an ordinary
 * empty result. */
export const OPENROUTER_WEB_SEARCH_MAX_REQUESTS = 2;

/** The technical model's own reply is discarded; it needs room only for
 * "OK" and, at `minimal` effort, a little reasoning. */
const MAX_OUTPUT_TOKENS = 128;
/** A repeat is sent only when this much of the deadline is left. */
const REPEAT_MIN_REMAINING_MS = 2_000;
const INSTRUCTIONS = "Call the web search tool exactly once with the user's text as the query, verbatim. " +
  "Then reply with the single word OK.";
const EXCERPT_MAX_CHARACTERS = 2_000;
const TITLE_MAX_CHARACTERS = 500;
const QUERY_MAX_CHARACTERS = 4_000;
const LOWEST_EFFORTS = ["none", "minimal", "low"] as const;

export type OpenRouterResponsesSearchClient = Readonly<{
  createResponse(
    body: Record<string, unknown>,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>
  ): Promise<Record<string, unknown>>;
}>;

/**
 * `POST {apiRoot}/responses` on the OpenRouter connection, without streaming.
 * OpenRouter's Responses API is stateless: nothing is stored, so the body
 * carries no `store` or `previous_response_id`. A rejected request throws the
 * shared provider HTTP error (status and Retry-After only), which the Search
 * executor retries when transient and types by its status.
 */
export function createFetchOpenRouterResponsesSearchClient(input: Readonly<{
  apiKey: string;
  baseUrl?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}>): OpenRouterResponsesSearchClient {
  const baseUrl = (input.baseUrl?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/u, "");
  const client = createFetchOpenAIChatCompletionClient({
    bodyMissingError: "openrouter_stream_body_missing",
    defaultTimeoutMs: input.defaultTimeoutMs,
    endpoint: `${baseUrl}/responses`,
    fetchFn: input.fetchFn,
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    invalidJsonError: "openrouter_response_invalid_json",
    notObjectError: "openrouter_response_not_object",
    providerName: "OpenRouter"
  });
  return { createResponse: (body, options) => client.createChatCompletion(body, options ? { ...options } : undefined) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function policy(request: ProviderSearchRequest) {
  const value = request.searchPolicy;
  if (value.provider !== "openrouter" || value.strategyId !== OPENROUTER_WEB_SEARCH_STRATEGY_ID || !value.modelId.trim()) {
    throw new Error("openrouter_search_policy_invalid");
  }
  return value;
}

/**
 * The effort the technical model searches at: the template's own for its
 * models (DeepSeek V4.1 Flash Off, GPT-6 Luna `minimal`), else the model's
 * lowest supported one, else none sent.
 */
export function openRouterWebSearchReasoningEffort(
  modelId: string,
  capabilities: ProviderModelCapabilities
): string | undefined {
  const preset = OPENROUTER_WEB_SEARCH_TECHNICAL_MODELS.find((model) => model.upstreamModelId === modelId.trim());
  if (preset) return preset.reasoningEffort;
  if (!capabilities.reasoning || !Array.isArray(capabilities.reasoningEfforts)) return undefined;
  const supported = new Set<unknown>(capabilities.reasoningEfforts);
  return LOWEST_EFFORTS.find((effort) => supported.has(effort));
}

/** The engine's server tool with the source's engine, mode and result count. */
function searchTool(value: ReturnType<typeof policy>): Record<string, unknown> {
  return {
    parameters: {
      engine: value.engine,
      max_results: OPENROUTER_WEB_SEARCH_RESULT_COUNT,
      ...(value.mode ? { mode: value.mode } : {})
    },
    type: "openrouter:web_search"
  };
}

/**
 * One Responses request: the technical model is told to run OpenRouter's web
 * search exactly once with the query verbatim and at most one tool call. The
 * model's routing and data collection are the model's own settings.
 */
export function buildOpenRouterWebSearchRequest(request: ProviderSearchRequest): Record<string, unknown> {
  const value = policy(request);
  if (!request.query.trim() || request.query.length > QUERY_MAX_CHARACTERS) throw new Error("search_query_too_long");
  const effort = openRouterWebSearchReasoningEffort(value.modelId, value.modelCapabilities);
  return {
    input: request.query,
    instructions: INSTRUCTIONS,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    max_tool_calls: 1,
    model: value.modelId.trim(),
    provider: buildProviderRouting(normalizeOpenRouterParams({ ...value.defaultParams })),
    ...(effort ? { reasoning: { effort } } : {}),
    tools: [searchTool(value)]
  };
}

/** Single-line plain text from an untrusted web field. */
function plainText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = storableUtf16Text(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? takeUtf16SafePrefix(text, maximum).trimEnd() : undefined;
}

function usageRecord(response: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return isRecord(response.usage) ? response.usage : {};
}

function searchItems(response: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  return records(response.output).filter((item) => item.type === "openrouter:web_search");
}

/** OpenRouter's count of the searches it ran (and bills), else its search items. */
function webSearchCount(response: Readonly<Record<string, unknown>>): number {
  const details = usageRecord(response).server_tool_use_details;
  const reported = isRecord(details) ? details.web_search_requests : undefined;
  return typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0
    ? reported
    : searchItems(response).length;
}

function responseUsage(response: Readonly<Record<string, unknown>>): ModelRunUsage {
  const usage = usageRecord(response);
  const input = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const output = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return normalizeTokenUsage({
    cachedInputTokens: input.cached_tokens,
    cacheWriteInputTokens: input.cache_write_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: output.reasoning_tokens,
    totalTokens: usage.total_tokens,
    webSearchCount: webSearchCount(response)
  });
}

/** What OpenRouter reported the request cost, its search fee included; null
 * when it reported no usable amount. */
function responseCostUsd(response: Readonly<Record<string, unknown>>): number | null {
  return reportedUsageCostUsd(usageRecord(response)) ?? null;
}

/** The queries the model's searches ran, in order; "" for a search without one. */
function searchQueries(response: Readonly<Record<string, unknown>>): string[] {
  return searchItems(response).map((item) => {
    const action = isRecord(item.action) ? item.action : {};
    return typeof action.query === "string" ? action.query : "";
  });
}

/**
 * Every `url_citation` annotation of the response's messages, cited and
 * `uncited` alike, in the provider's order and once per link: each is one
 * result whose excerpt is the page text OpenRouter returned (`content`). The
 * model's own text is never read.
 */
function annotationSources(response: Readonly<Record<string, unknown>>): SearchSource[] {
  const candidates = records(response.output)
    .filter((item) => item.type === "message")
    .flatMap((item) => records(item.content))
    .flatMap((part) => records(part.annotations))
    .filter((annotation) => annotation.type === "url_citation")
    .map((annotation) => {
      const title = plainText(annotation.title, TITLE_MAX_CHARACTERS);
      const excerpt = plainText(annotation.content, EXCERPT_MAX_CHARACTERS);
      return { ...(excerpt ? { snippet: excerpt } : {}), ...(title ? { title } : {}), url: annotation.url };
    });
  return normalizeSearchSources(candidates).map((source, index) => ({ ...source, citation: index + 1, rank: index + 1 }));
}

type Accounting = Readonly<{ costUsd: number | null; usage: ModelRunUsage }>;

/** Every answered request's usage, summed; a cost only when each reported one. */
function summed(accountings: readonly Accounting[]): Accounting {
  return {
    costUsd: accountings.length > 0 && accountings.every((entry) => entry.costUsd !== null)
      ? accountings.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
      : null,
    usage: sumTokenUsage(accountings.map((entry) => entry.usage))
  };
}

/** A completed response, or one cut at its output limit after the search
 * ran: the reply is discarded, so only the search matters. */
function usableStatus(status: unknown): boolean {
  return status === "completed" || status === "incomplete";
}

/**
 * OpenRouter's `openrouter:web_search` server tool (engines Perplexity,
 * Parallel, Exa) run by a technical model through the Responses API. A
 * results-only engine: each annotated link is one entry with its excerpt, and
 * the model's prose is discarded. A response without a search or without
 * results is sent once more; a second one is an ordinary empty result. Cost is
 * what OpenRouter reported, its search fee included; unknown stays unknown.
 */
export function createOpenRouterWebSearchAdapter(input: Readonly<{
  client: OpenRouterResponsesSearchClient;
}>): ProviderSearchAdapter {
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const body = buildOpenRouterWebSearchRequest(request);
      const value = policy(request);
      return {
        body: {
          engine: value.engine,
          max_output_tokens: body.max_output_tokens,
          max_results: OPENROUTER_WEB_SEARCH_RESULT_COUNT,
          max_tool_calls: body.max_tool_calls,
          ...(value.mode ? { mode: value.mode } : {}),
          model: body.model
        },
        provider: "openrouter",
        queryCharacters: request.query.length,
        redactions: ["search_query"],
        stage: "tool_search"
      };
    },
    async search(request, options = {}): Promise<ProviderSearchResult> {
      const value = policy(request);
      const body = buildOpenRouterWebSearchRequest(request);
      const startedAt = performance.now();
      const budgetMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : null;
      const remainingMs = () => budgetMs === null ? null : Math.max(0, budgetMs - (performance.now() - startedAt));
      const answered: Accounting[] = [];
      let queries: string[] = [];
      let requests = 0;
      for (;;) {
        requests += 1;
        const timeoutMs = remainingMs();
        const response = await dispatchSearchRequest(options, {
          body,
          cost: responseCostUsd,
          execute: () => input.client.createResponse(body, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(timeoutMs !== null ? { timeoutMs: Math.max(1, Math.floor(timeoutMs)) } : {})
          }),
          usage: responseUsage
        });
        answered.push({ costUsd: responseCostUsd(response), usage: responseUsage(response) });
        if (response.status === "failed" || isRecord(response.error)) {
          // A response OpenRouter failed is a dropped request: the executor
          // sends the search again within its deadline.
          throw markProviderStreamDrop(providerResponseFailure("openrouter_search_response_failed", response),
            "response_failed");
        }
        if (!usableStatus(response.status)) {
          const accounting = summed(answered);
          throw new ProviderSearchExecutionError({
            artifacts: [],
            code: "provider_terminal_response_invalid",
            costUsd: accounting.costUsd,
            usage: accounting.usage
          });
        }
        queries = searchQueries(response);
        const sources = annotationSources(response);
        const accounting = summed(answered);
        const preview = (sourceCount: number) => ({
          engine: value.engine,
          provider: "openrouter",
          requests,
          searchCount: queries.length,
          sourceCount,
          status: "completed"
        });
        if (sources.length > 0) {
          return {
            artifacts: [],
            costUsd: accounting.costUsd,
            finalProviderResponsePreview: preview(sources.length),
            // A result list: the model reads each source's entry, not provider prose.
            findings: SEARCH_RESULT_LIST_FINDINGS,
            requestPreview: adapter.buildRequestPreview(request),
            searchQueries: queries,
            sourceAttribution: "available",
            sources,
            usage: accounting.usage
          };
        }
        const left = remainingMs();
        if (requests >= OPENROUTER_WEB_SEARCH_MAX_REQUESTS || options.signal?.aborted ||
          left !== null && left < REPEAT_MIN_REMAINING_MS) {
          return {
            artifacts: [],
            costUsd: accounting.costUsd,
            finalProviderResponsePreview: preview(0),
            findings: SEARCH_NO_RESULTS_FINDINGS,
            noResults: true,
            requestPreview: adapter.buildRequestPreview(request),
            searchQueries: queries,
            sourceAttribution: "available",
            sources: [],
            usage: accounting.usage
          };
        }
      }
    }
  };
  return adapter;
}
