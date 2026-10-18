import { normalizeTokenUsage } from "../../domain/usage";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { storableUtf16Text, takeUtf16SafePrefix } from "../../domain/utf16";
import { DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS } from "../../contracts/adminSearch";
import { parseRetryAfterMs } from "../retryAfter";
import {
  MAX_SEARCH_ENGINE_SOURCES,
  normalizeSearchFindings,
  normalizeSearchSources,
  SEARCH_NO_RESULTS_FINDINGS,
  type SearchSource
} from "../search/evidence";
import {
  isProviderDeadlineExceededError,
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import { observeJsonParse } from "./providerObservability";
import { executeWithProviderRetry, sleepWithSignal, type ProviderRetryOptions } from "./providerRetry";
import { dispatchSearchRequest } from "./searchDispatch";
import {
  ProviderSearchExecutionError,
  type ProviderSearchAdapter,
  type ProviderSearchRequest,
  type ProviderSearchResult
} from "./types";

/** The policy discriminator of a DeepSeek binding's raw results Search. */
export const DEEPSEEK_SEARCH_API_STRATEGY_ID = "deepseek-search-api";
/** Usage rows and Search evidence name the API, not the model whose
 * connection key it borrows. */
export const DEEPSEEK_SEARCH_API_MODEL_ID = "deepseek-search-api";
/** USD per successful request: $0.75 per 1,000 requests answered with HTTP 200
 * and a non-empty result list (https://api-docs.deepseek.com/guides/search,
 * checked 2026-10-18). Empty results, failures and timeouts are free, and
 * `count` does not change the price. DeepSeek reports no per-request cost. */
export const DEEPSEEK_SEARCH_API_REQUEST_USD = 0.00075;
/** One request plus two retries, all inside the Search deadline. */
export const DEEPSEEK_SEARCH_API_MAX_ATTEMPTS = 3;
/** DeepSeek admits 5 Search requests per second per account. */
export const DEEPSEEK_SEARCH_API_REQUESTS_PER_SECOND = 5;

const DEFAULT_API_ROOT = "https://api.deepseek.com";
const RESPONSE_MAX_BYTES = 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const SUMMARY_MAX_CHARACTERS = 2_000;
const TITLE_MAX_CHARACTERS = 500;
const LABEL_MAX_CHARACTERS = 200;

export type DeepSeekSearchApiRequestBody = Readonly<{
  count: number;
  need_content: false;
  query: string;
}>;

export type DeepSeekSearchApiClient = Readonly<{
  search(
    body: DeepSeekSearchApiRequestBody,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>
  ): Promise<Readonly<Record<string, unknown>>>;
}>;

/** A rejected request. Only its status and Retry-After leave the bounded,
 * discarded body. */
export class DeepSeekSearchApiHttpError extends Error {
  readonly retryAfterMs: number | null;
  readonly status: number;

  constructor(status: number, retryAfterMs: number | null) {
    super(providerHttpErrorMessage("DeepSeek Search API", status));
    this.name = "DeepSeekSearchApiHttpError";
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** A 200 answer that is not a JSON object: its billing is unknown. */
class DeepSeekSearchApiResponseError extends Error {
  constructor(readonly code: "provider_response_invalid_json" | "provider_terminal_response_invalid") {
    super(code);
    this.name = "DeepSeekSearchApiResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Search endpoint beside the connection's API root: the documented
 * `/v1/tools/search`, also when the root already names `/v1`. */
export function deepSeekSearchApiEndpoint(apiRoot?: string): string {
  const root = apiRoot?.trim().replace(/\/+$/u, "") || DEFAULT_API_ROOT;
  return root.endsWith("/v1") ? `${root}/tools/search` : `${root}/v1/tools/search`;
}

export function createFetchDeepSeekSearchApiClient(input: Readonly<{
  apiKey: string;
  apiRoot?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}>): DeepSeekSearchApiClient {
  const endpoint = deepSeekSearchApiEndpoint(input.apiRoot);
  const fetchFn = input.fetchFn ?? fetch;
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json"
  };
  return {
    async search(body, options = {}) {
      const timeout = withTimeoutSignal(options.signal, options.timeoutMs ?? input.defaultTimeoutMs);
      try {
        const response = await fetchFn(endpoint, {
          body: JSON.stringify(body),
          headers,
          method: "POST",
          redirect: "error",
          signal: timeout.signal
        });
        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          try {
            await readBoundedResponseText(response, {
              maxBytes: Math.min(providerResponseMaxBytes(), ERROR_BODY_MAX_BYTES),
              signal: timeout.signal
            });
          } catch (error) {
            if (!(error instanceof ProviderResponseTooLargeError)) throw error;
          }
          throw new DeepSeekSearchApiHttpError(response.status, retryAfterMs);
        }
        const text = await readBoundedResponseText(response, {
          maxBytes: Math.min(providerResponseMaxBytes(), RESPONSE_MAX_BYTES),
          signal: timeout.signal
        });
        let parsed: unknown;
        try {
          parsed = observeJsonParse(response, () => JSON.parse(text) as unknown);
        } catch {
          throw new DeepSeekSearchApiResponseError("provider_response_invalid_json");
        }
        if (!isRecord(parsed)) throw new DeepSeekSearchApiResponseError("provider_terminal_response_invalid");
        return parsed;
      } finally {
        timeout.clear();
      }
    }
  };
}

export type SearchRequestRateLimiter = Readonly<{
  /** Waits, within the signal, until `key` may start another request. */
  acquire(key: string, signal: AbortSignal): Promise<void>;
}>;

/** At most `maxRequests` request starts per key in any `windowMs`. Retries
 * count as requests; a waiter ends with its own signal. */
export function createSlidingWindowRateLimiter(input: Readonly<{
  maxRequests: number;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  windowMs: number;
}>): SearchRequestRateLimiter {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? sleepWithSignal;
  const starts = new Map<string, number[]>();
  return {
    async acquire(key, signal) {
      for (;;) {
        signal.throwIfAborted();
        const current = now();
        const recent = (starts.get(key) ?? []).filter((startedAt) => current - startedAt < input.windowMs);
        if (recent.length < input.maxRequests) {
          recent.push(current);
          starts.set(key, recent);
          return;
        }
        starts.set(key, recent);
        await sleep(Math.max(1, recent[0]! + input.windowMs - current), signal);
      }
    }
  };
}

/** One limiter for the installation's process, keyed by the DeepSeek
 * credential (one account) that sends the request. */
const installationSearchApiRateLimiter = createSlidingWindowRateLimiter({
  maxRequests: DEEPSEEK_SEARCH_API_REQUESTS_PER_SECOND,
  windowMs: 1_000
});

function policy(request: ProviderSearchRequest) {
  const value = request.searchPolicy;
  if (
    value.provider !== "deepseek" ||
    value.strategyId !== DEEPSEEK_SEARCH_API_STRATEGY_ID ||
    !Number.isSafeInteger(value.maxResults) ||
    value.maxResults < 1 ||
    value.maxResults > MAX_SEARCH_ENGINE_SOURCES
  ) {
    throw new Error("deepseek_search_policy_invalid");
  }
  return value;
}

export function buildDeepSeekSearchApiRequest(request: ProviderSearchRequest): DeepSeekSearchApiRequestBody {
  const configured = policy(request);
  // The admitted query is already validated against the source's limit;
  // a longer one is refused here rather than cut.
  if (!request.query || request.query.length > DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS) {
    throw new Error("search_query_too_long");
  }
  return { count: configured.maxResults, need_content: false, query: request.query };
}

/** Tokens are not part of this API's price; a request costs only when it
 * returns results, and then counts as one billed search. */
function searchUsage(billed: boolean): ModelRunUsage {
  return normalizeTokenUsage({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...(billed ? { webSearchCount: 1 } : {})
  });
}

function resultList(response: Readonly<Record<string, unknown>>): readonly unknown[] | null {
  return Array.isArray(response.results) ? response.results : null;
}

/** The cost of one answered request; null when its billing is unknown. */
function responseCostUsd(response: Readonly<Record<string, unknown>>): number | null {
  const results = resultList(response);
  return results === null ? null : results.length > 0 ? DEEPSEEK_SEARCH_API_REQUEST_USD : 0;
}

function responseUsage(response: Readonly<Record<string, unknown>>): ModelRunUsage {
  const results = resultList(response);
  return results === null ? normalizeTokenUsage({}) : searchUsage(results.length > 0);
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

type SearchApiEntry = Readonly<{
  label?: string;
  source: SearchSource;
  summary: string | undefined;
}>;

/** Each result with a usable link becomes one cited source, numbered in the
 * provider's order. Results without one cannot be cited and are dropped. */
function searchApiEntries(results: readonly unknown[], maximum: number): SearchApiEntry[] {
  const entries: SearchApiEntry[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (entries.length >= maximum) break;
    if (!isRecord(result)) continue;
    const siteName = plainText(result.site_name, LABEL_MAX_CHARACTERS);
    const title = plainText(result.title, TITLE_MAX_CHARACTERS) ?? siteName;
    const snippet = plainText(result.snippet, SUMMARY_MAX_CHARACTERS);
    const [normalized] = normalizeSearchSources([{
      ...(typeof result.date === "string" ? { date: result.date } : {}),
      ...(snippet ? { snippet } : {}),
      ...(title ? { title } : {}),
      url: result.url
    }], 1);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    const citation = entries.length + 1;
    const label = [siteName && siteName !== normalized.title ? siteName : undefined, plainText(normalized.date, 80)]
      .filter(Boolean).join(" · ");
    entries.push({
      ...(label ? { label } : {}),
      source: { ...normalized, citation, rank: citation },
      summary: plainText(result.summary, SUMMARY_MAX_CHARACTERS) ?? snippet
    });
  }
  return entries;
}

/** The model reads each result's summary under the number its source keeps. */
function searchApiFindings(entries: readonly SearchApiEntry[]): string {
  return entries.map((entry) => {
    const heading = `[${entry.source.citation}] ${entry.source.title}${entry.label ? ` — ${entry.label}` : ""}`;
    return entry.summary ? `${heading}\n${entry.summary}` : heading;
  }).join("\n\n");
}

function httpFailureCode(status: number): string {
  if (status === 400) return "provider_http_invalid_request";
  if (status === 401 || status === 403) return "provider_auth_rejected";
  if (status === 402) return "provider_quota_exhausted";
  if (status === 408) return "provider_request_timed_out";
  if (status === 413) return "provider_http_request_body_too_large";
  if (status === 429) return "provider_rate_limited";
  return status >= 500 && status <= 599 ? "provider_server_error" : "provider_response_failed";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

/** A failed request's typed, content-free Search failure. DeepSeek charges
 * nothing for a rejected request; an unreadable answer has unknown billing. */
function searchFailure(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error;
  if (error instanceof DeepSeekSearchApiHttpError) {
    return Object.assign(new ProviderSearchExecutionError({
      artifacts: [],
      code: httpFailureCode(error.status),
      costUsd: 0,
      usage: searchUsage(false)
    }), { httpStatus: error.status });
  }
  if (error instanceof DeepSeekSearchApiResponseError || error instanceof ProviderResponseTooLargeError ||
    isProviderDeadlineExceededError(error)) {
    return new ProviderSearchExecutionError({
      artifacts: [],
      code: error.code,
      usage: normalizeTokenUsage({})
    });
  }
  return error;
}

/**
 * DeepSeek Search API (`POST /v1/tools/search`): raw ranked results for one
 * generated query. Summaries become findings and each linked result one
 * cited source; an empty list is an ordinary, unbilled no-results answer.
 * Only 408, 429 and 5xx are retried, within the Search deadline, and every
 * request waits for the account's request-rate slot.
 */
export function createDeepSeekSearchApiAdapter(input: Readonly<{
  client: DeepSeekSearchApiClient;
  maxAttempts?: number;
  rateLimiter?: SearchRequestRateLimiter;
  /** The DeepSeek account the request bills: its credential identity. */
  rateLimitKey: string;
  retry?: Pick<ProviderRetryOptions, "random" | "sleep">;
}>): ProviderSearchAdapter {
  const rateLimiter = input.rateLimiter ?? installationSearchApiRateLimiter;
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview(request) {
      const body = buildDeepSeekSearchApiRequest(request);
      return {
        body: { count: body.count, need_content: body.need_content },
        provider: "deepseek",
        queryCharacters: request.query.length,
        redactions: ["search_query"],
        stage: "tool_search"
      };
    },
    async search(request, options = {}): Promise<ProviderSearchResult> {
      const configured = policy(request);
      const body = buildDeepSeekSearchApiRequest(request);
      const signal = options.signal ?? new AbortController().signal;
      // The caller's signal carries the Search deadline; retries and their
      // waits stay inside the time it leaves.
      const startedAt = performance.now();
      const budgetMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : null;
      const remainingMs = budgetMs === null
        ? undefined
        : () => Math.max(0, budgetMs - (performance.now() - startedAt));
      let response: Readonly<Record<string, unknown>>;
      try {
        response = await executeWithProviderRetry({
          operation: async () => {
            await rateLimiter.acquire(input.rateLimitKey, signal);
            return dispatchSearchRequest(options, {
              body,
              cost: responseCostUsd,
              execute: () => input.client.search(body, { signal }),
              usage: responseUsage
            });
          },
          options: {
            maxAttempts: input.maxAttempts ?? DEEPSEEK_SEARCH_API_MAX_ATTEMPTS,
            ...input.retry
          },
          ...(remainingMs ? { remainingMs } : {}),
          shouldRetry: (error) => error instanceof DeepSeekSearchApiHttpError && retryableStatus(error.status)
            ? { retryAfterMs: error.retryAfterMs }
            : null,
          signal
        });
      } catch (error) {
        throw searchFailure(error, signal);
      }
      const results = resultList(response);
      if (results === null) {
        throw new ProviderSearchExecutionError({
          artifacts: [],
          code: "provider_terminal_response_invalid",
          usage: normalizeTokenUsage({})
        });
      }
      const requestPreview = adapter.buildRequestPreview(request);
      if (results.length === 0) {
        return {
          artifacts: [],
          costUsd: 0,
          finalProviderResponsePreview: { provider: "deepseek", resultCount: 0, sourceCount: 0, status: "completed" },
          findings: SEARCH_NO_RESULTS_FINDINGS,
          noResults: true,
          requestPreview,
          sourceAttribution: "available",
          sources: [],
          usage: searchUsage(false)
        };
      }
      const usage = searchUsage(true);
      const entries = searchApiEntries(results, configured.maxResults);
      if (entries.length === 0) {
        throw new ProviderSearchExecutionError({
          artifacts: [],
          code: "search_sources_invalid",
          costUsd: DEEPSEEK_SEARCH_API_REQUEST_USD,
          usage
        });
      }
      let findings: string;
      try {
        findings = normalizeSearchFindings(searchApiFindings(entries));
      } catch {
        throw new ProviderSearchExecutionError({
          artifacts: [],
          code: "search_findings_invalid",
          costUsd: DEEPSEEK_SEARCH_API_REQUEST_USD,
          usage
        });
      }
      return {
        artifacts: [],
        costUsd: DEEPSEEK_SEARCH_API_REQUEST_USD,
        finalProviderResponsePreview: {
          findingsCharacters: findings.length,
          provider: "deepseek",
          resultCount: results.length,
          sourceCount: entries.length,
          status: "completed"
        },
        findings,
        requestPreview,
        sourceAttribution: "available",
        sources: entries.map((entry) => entry.source),
        usage
      };
    }
  };
  return adapter;
}

/** A DeepSeek binding's one Search adapter: the raw results API for its
 * policy, else the model's hosted Search when the model has it. */
export function createDeepSeekSearchAdapter(input: Readonly<{
  responses?: ProviderSearchAdapter;
  searchApi: ProviderSearchAdapter;
}>): ProviderSearchAdapter {
  const adapterFor = (request: ProviderSearchRequest): ProviderSearchAdapter => {
    const adapter = request.searchPolicy.strategyId === DEEPSEEK_SEARCH_API_STRATEGY_ID
      ? input.searchApi
      : input.responses;
    if (!adapter) throw new Error("search_adapter_not_available");
    return adapter;
  };
  return {
    buildRequestPreview: (request) => adapterFor(request).buildRequestPreview(request),
    async search(request, options) {
      return adapterFor(request).search(request, options);
    }
  };
}
