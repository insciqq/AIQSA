import { admittedOutputAllowance, isModelGenerationBudget } from "../providers/modelOutputAllowance";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import type { ValidatedSearchQuery } from "../../domain/search";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import {
  adminSearchExecutionLimits,
  type AdminSearchReasoningPolicy
} from "../../contracts/adminSearch";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { ProviderSearchDispatch } from "../providers/searchDispatch";
import {
  isProviderSearchExecutionError,
  ProviderSearchExecutionError
} from "../providers/types";
import type {
  NormalizedSearchPlan,
  NormalizedSearchPlanOption,
  ProviderModelCapabilities,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "../providers/types";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import {
  boundedEngineSearchSources,
  normalizeSearchFindings,
  SEARCH_NO_RESULTS_FINDINGS,
  type SearchSource
} from "./evidence";
import { validateSearchToolArguments } from "./query";
import {
  SEARCH_TOOL_RESULT_VERSION,
  searchToolResultContent,
  type SearchExecutionEvidence
} from "./toolResult";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { bindContext, logEvent } from "../observability";
import { observedFailure } from "../providers/providerObservability";
import { providerRetryDelayMs, sleepWithSignal } from "../providers/providerRetry";
import { MODEL_CALL_RETRY, modelCallRetryDecision } from "../engine/modelCall";

export {
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult,
  searchUsageAttribution
} from "./toolResult";
export type { SearchExecutionEvidence } from "./toolResult";

const allSelectedToolName = "search_selected_engines";

// Older accepted runs may contain snapshots created before these controls
// existed. Missing fields in those snapshots retain their historical values;
// newly admitted integrations always persist explicit controls.
const legacySearchExecutionDefaults = Object.freeze({
  maxOutputTokens: 4_096,
  maxResults: 8,
  maxSearchCallsPerAnswer: 2,
  queryMaxCharacters: 500,
  reasoningPolicy: "lowest_supported" as const,
  timeoutMs: 300_000
});

type SearchExecutionResult = SearchExecutionEvidence;

type SearchFailureEvidence = NonNullable<SearchExecutionEvidence["failure"]>;

/** Requests of one engine's Search call, the first included. A read-only
 * Search retries transparently (answer first, RUN_CONTRACTS.md) within its
 * own deadline and under Stop; the DeepSeek Search API retries itself. */
export const SEARCH_ENGINE_MAX_ATTEMPTS = 3;

/** A retry is sent only when this much of the engine's deadline is left
 * after its wait, so no paid request starts that cannot finish. */
const SEARCH_RETRY_MIN_ATTEMPT_MS = 2_000;

/** The waits between an engine's attempts; seams for tests. */
export type SearchRetryPorts = Readonly<{
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

/** What the provider reported one attempt cost. */
type SearchAccounting = Readonly<{ costUsd: number | null; usage: ModelRunUsage }>;

/**
 * Accounts each physical request of one attempt that the provider answered,
 * so a failure after it (a dropped continuation, an unreadable body) keeps
 * that request's reported usage and cost.
 */
function searchAttemptLedger() {
  const usages: ModelRunUsage[] = [];
  const costs: number[] = [];
  async function dispatch<T>(request: Readonly<{
    body: unknown;
    cost?(value: T): number | null;
    execute(): Promise<T>;
    usage(value: T): ModelRunUsage;
  }>): Promise<T> {
    const value = await request.execute();
    try {
      usages.push(request.usage(value));
      const cost = request.cost?.(value);
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) costs.push(cost);
    } catch {
      // Unreadable usage stays unknown; the adapter reports that failure itself.
    }
    return value;
  }
  return {
    accounting: (): SearchAccounting => ({
      costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      usage: sumTokenUsage(usages)
    }),
    dispatch
  };
}

/** A failed attempt's accounting: what its typed failure carries, else what its answered requests reported. */
function failedAttemptAccounting(error: unknown, ledger: ReturnType<typeof searchAttemptLedger>): SearchAccounting {
  return isProviderSearchExecutionError(error)
    ? { costUsd: error.costUsd, usage: error.usage }
    : ledger.accounting();
}

function reportedAccounting(accounting: SearchAccounting): boolean {
  return accounting.costUsd !== null || normalizeTokenUsage(accounting.usage).completeness !== "unavailable";
}

/** Every attempt's reported usage, summed; a cost only when every attempt that reported usage reported one. */
function combinedAccounting(accountings: readonly SearchAccounting[]): SearchAccounting {
  const reported = accountings.filter(reportedAccounting);
  if (reported.length <= 1) return reported[0] ?? accountings[accountings.length - 1] ?? { costUsd: null, usage: zeroUsage() };
  return {
    costUsd: reported.every((accounting) => accounting.costUsd !== null)
      ? reported.reduce((sum, accounting) => sum + (accounting.costUsd ?? 0), 0)
      : null,
    usage: sumTokenUsage(reported.map((accounting) => accounting.usage))
  };
}

/** Carries accounting from every settled engine while cancellation still stops
 * the caller before another tool or answer request can be dispatched. */
export class SearchToolCancelledError extends Error {
  constructor(readonly result: ToolExecutionResult, cause: unknown) {
    super("search_cancelled", { cause });
    this.name = "AbortError";
  }
}

class SearchDeadlineError extends Error {
  readonly code = "search_timeout";
  constructor() { super("search_timeout"); this.name = "SearchDeadlineError"; }
}

function parentAbortCode(signal?: AbortSignal): "search_cancelled" | "search_timeout" {
  return observedFailure(undefined, signal).reason === "deadline" ? "search_timeout" : "search_cancelled";
}

export type SearchPlanToolRouter = Readonly<{
  accepts(name: string): boolean;
  execute(
    call: ModelToolCall,
    request: unknown,
    options?: { signal?: AbortSignal; retainOriginal?: true }
  ): Promise<ToolExecutionResult>;
  optionIdsForTool(name: string): readonly string[];
  tools: readonly RunTool[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroUsage(): ModelRunUsage {
  return normalizeTokenUsage({});
}

function normalizedFailureCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value)
    ? value
    : "search_execution_failed";
}

function boundedFailureField(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function toolName(ordinal: number): string {
  return `search_engine_${ordinal + 1}`;
}

/** What the model is told about Search, after how it reaches the web. */
const SEARCH_GUIDANCE =
  "Search before answering anything that may have changed or that you are not sure about: news, prices, rates, " +
  "versions, releases, schedules, people, laws, documentation. Write one focused query in the language most likely " +
  "to find good sources, and search again with a refined query when results are thin. Results give findings and " +
  "numbered sources with URLs; cite the sources you use.";

const ALL_SELECTED_DESCRIPTION = `Search the web through the user's selected search sources. ${SEARCH_GUIDANCE}`;

function toolDescription(option: NormalizedSearchPlanOption): string {
  const displayName = option.displayName?.trim().slice(0, 160);
  return displayName
    ? `Search the web through the user-selected source ${JSON.stringify(displayName)}. ${SEARCH_GUIDANCE}`
    : `Search the web through one user-selected source. ${SEARCH_GUIDANCE}`;
}

function searchDisplayName(option: NormalizedSearchPlanOption): string {
  return option.displayName?.trim().slice(0, 256) || "Search source";
}

function searchTool(name: string, description: string, queryMaxCharacters: number): RunTool {
  return {
    capability: "web_search",
    description,
    inputSchema: {
      additionalProperties: false,
      properties: {
        query: {
          description: "The concise web search query.",
          maxLength: queryMaxCharacters,
          minLength: 1,
          type: "string"
        }
      },
      required: ["query"],
      type: "object"
    },
    name,
    strict: true
  };
}

/** A source's own call timeout, frozen with the run's Search plan; the runtime's response timeout may shorten it. */
export function searchOptionTimeoutMs(option: NormalizedSearchPlanOption): number {
  const value = option.config.timeoutMs;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : legacySearchExecutionDefaults.timeoutMs;
}

/**
 * The search tools a plan offers: each tool's name and description and the client sources its calls go to, all of
 * them at once in `all_selected` mode, otherwise one each. Sources the answer model searches in its own call have none.
 */
export function searchToolRoutes(plan: NormalizedSearchPlan): readonly Readonly<{
  description: string; name: string; options: readonly NormalizedSearchPlanOption[];
}>[] {
  const options = plan.options.filter((option) => option.adapterKind === "provider_model_client");
  if (options.length === 0) return [];
  return plan.mode === "all_selected"
    ? [{ description: ALL_SELECTED_DESCRIPTION, name: allSelectedToolName, options }]
    : options.map((option, ordinal) => ({ description: toolDescription(option), name: toolName(ordinal), options: [option] }));
}

export function searchExecutionConfiguration(option: NormalizedSearchPlanOption, input: unknown = ""): {
  capabilities: ProviderModelCapabilities;
  defaultParams: Record<string, unknown>;
  maxOutputTokens: number;
  maxResults: number;
  maxSearchCallsPerAnswer: number;
  queryMaxCharacters: number;
  reasoningPolicy: AdminSearchReasoningPolicy;
  timeoutMs: number;
} {
  const config = option.config;
  if (config.maxOutputTokens === null && !isModelGenerationBudget(config.generationBudget)) {
    throw Object.assign(new Error("search_generation_budget_invalid"), { code: "search_generation_budget_invalid" });
  }
  const capabilities = isRecord(config.modelCapabilities)
    ? config.modelCapabilities as ProviderModelCapabilities
    : {
        nativePdfInput: false,
        nativeSearch: true,
        pdf: false,
        reasoning: false,
        streaming: true,
        toolCalling: false,
        vision: false
      };
  return {
    capabilities,
    defaultParams: isRecord(config.modelDefaultParams) ? config.modelDefaultParams : {},
    maxOutputTokens: isModelGenerationBudget(config.generationBudget)
      ? admittedOutputAllowance(config.generationBudget, input) : boundedInteger(
      config.maxOutputTokens,
      adminSearchExecutionLimits.maxOutputTokens.minimum,
      adminSearchExecutionLimits.maxOutputTokens.maximum,
      legacySearchExecutionDefaults.maxOutputTokens
    ),
    maxResults: boundedInteger(
      config.maxResults,
      adminSearchExecutionLimits.maxResults.minimum,
      adminSearchExecutionLimits.maxResults.maximum,
      legacySearchExecutionDefaults.maxResults
    ),
    maxSearchCallsPerAnswer: boundedInteger(
      config.maxSearchCallsPerAnswer,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.minimum,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.maximum,
      legacySearchExecutionDefaults.maxSearchCallsPerAnswer
    ),
    queryMaxCharacters: Number.isSafeInteger(config.queryMaxCharacters) &&
      Number(config.queryMaxCharacters) >= 1 &&
      Number(config.queryMaxCharacters) <= adminSearchExecutionLimits.queryMaxCharacters.maximum
      ? Number(config.queryMaxCharacters)
      : legacySearchExecutionDefaults.queryMaxCharacters,
    reasoningPolicy: config.reasoningPolicy === "provider_default"
      ? "provider_default"
      : legacySearchExecutionDefaults.reasoningPolicy,
    timeoutMs: searchOptionTimeoutMs(option)
  };
}

function queryOnlyRequest(
  correlationId: string,
  option: NormalizedSearchPlanOption,
  query: ValidatedSearchQuery
): ProviderSearchRequest {
  const configured = searchExecutionConfiguration(option, { query });
  let searchPolicy: ProviderSearchPolicy;
  if (option.protocol === "openrouter_perplexity_chat") {
    searchPolicy = {
      controls: {
        maxOutputTokens: {
          defaultValue: configured.maxOutputTokens,
          maxValue: adminSearchExecutionLimits.maxOutputTokens.maximum
        },
        temperature: { defaultValue: 0, maxValue: 2, minValue: 0, supported: true }
      },
      defaultParams: {
        ...configured.defaultParams,
        maxOutputTokens: configured.maxOutputTokens,
        stream: false,
        temperature: 0
      },
      modelId: option.modelId ?? "",
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    };
  } else if (
    option.protocol === "openai_responses_web_search" &&
    (option.provider === "openai" || option.provider === "openai_compatible")
  ) {
    searchPolicy = {
      maxOutputTokens: configured.maxOutputTokens,
      modelCapabilities: configured.capabilities,
      modelId: option.modelId ?? "",
      provider: option.provider,
      reasoningPolicy: configured.reasoningPolicy,
      strategyId: "openai-responses-web-search"
    };
  } else if (
    option.protocol === "deepseek_responses_web_search" &&
    option.provider === "deepseek"
  ) {
    searchPolicy = {
      maxOutputTokens: configured.maxOutputTokens,
      modelCapabilities: configured.capabilities,
      modelId: option.modelId ?? "",
      provider: "deepseek",
      reasoningPolicy: configured.reasoningPolicy,
      strategyId: "deepseek-responses-web-search"
    };
  } else if (option.protocol === "deepseek_search_api" && option.provider === "deepseek") {
    searchPolicy = {
      maxResults: configured.maxResults,
      modelId: option.modelId ?? "",
      provider: "deepseek",
      strategyId: "deepseek-search-api"
    };
  } else if (option.protocol === "gemini_google_search" && option.provider === "gemini") {
    searchPolicy = {
      maxOutputTokens: configured.maxOutputTokens,
      modelCapabilities: configured.capabilities,
      modelId: option.modelId ?? "",
      provider: "gemini",
      reasoningPolicy: configured.reasoningPolicy,
      strategyId: "gemini-google-search"
    };
  } else if (option.protocol === "anthropic_web_search" && option.provider === "anthropic") {
    searchPolicy = {
      maxOutputTokens: configured.maxOutputTokens,
      modelCapabilities: configured.capabilities,
      modelId: option.modelId ?? "",
      provider: "anthropic",
      reasoningPolicy: configured.reasoningPolicy,
      strategyId: "anthropic-web-search"
    };
  } else {
    throw new Error("search_protocol_not_supported");
  }
  return {
    correlationId,
    query,
    ...(isModelGenerationBudget(option.config.generationBudget) ? { generationBudget: option.config.generationBudget } : {}),
    searchPolicy,
    strategyId: option.optionId
  };
}

async function consumeProviderSearch(
  runtime: ProviderRuntimeBinding,
  request: ProviderSearchRequest,
  option: NormalizedSearchPlanOption,
  signal?: AbortSignal,
  timeoutMs?: number,
  dispatch?: ProviderSearchDispatch
): Promise<{
  costUsd: number | null;
  findings: string;
  noResults?: true;
  sourceAttribution: "available" | "provider_unavailable";
  sources: SearchSource[];
  usage: ModelRunUsage;
}> {
  if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
  const result = await runtime.searchAdapter.search(request, { ...(dispatch ? { dispatch } : {}), signal, timeoutMs });
  const costUsd = result.costUsd ?? null;
  const sourceAttribution = result.sourceAttribution ?? "available";
  if (result.noResults === true) {
    // An explicit empty answer of a raw results API is an ordinary outcome:
    // no sources and no provider text, only the server's own words.
    if (option.protocol !== "deepseek_search_api" || option.provider !== "deepseek" || result.sources.length > 0 ||
      result.findings !== SEARCH_NO_RESULTS_FINDINGS || sourceAttribution !== "available") {
      throw new ProviderSearchExecutionError({
        artifacts: result.artifacts,
        code: "search_sources_invalid",
        costUsd,
        usage: result.usage
      });
    }
    return { costUsd, findings: SEARCH_NO_RESULTS_FINDINGS, noResults: true, sourceAttribution, sources: [], usage: result.usage };
  }
  const sources = boundedEngineSearchSources(result.sources, searchExecutionConfiguration(option).maxResults);
  const providerSourcesUnavailable =
    sourceAttribution === "provider_unavailable" &&
    option.provider === "deepseek" &&
    option.protocol === "deepseek_responses_web_search";
  if (
    (sourceAttribution === "provider_unavailable" && !providerSourcesUnavailable) ||
    (sources.length === 0 && !providerSourcesUnavailable)
  ) {
    throw new ProviderSearchExecutionError({
      artifacts: result.artifacts,
      code: "search_sources_invalid",
      costUsd,
      usage: result.usage
    });
  }
  let findings: string;
  try {
    findings = normalizeSearchFindings(result.findings);
  } catch {
    throw new ProviderSearchExecutionError({
      artifacts: result.artifacts,
      code: "search_findings_invalid",
      costUsd,
      usage: result.usage
    });
  }
  return {
    costUsd,
    findings,
    sourceAttribution,
    sources,
    usage: result.usage
  };
}

function failedSearchExecution(input: Readonly<{
  call: ModelToolCall;
  costUsd?: number | null;
  failure: SearchFailureEvidence;
  option: NormalizedSearchPlanOption;
  usage?: ModelRunUsage;
}>): SearchExecutionResult {
  return {
    ...(input.costUsd != null ? { costUsd: input.costUsd } : {}),
    displayName: searchDisplayName(input.option),
    failure: input.failure,
    invocationId: `${input.call.id}:${input.option.optionId}`.slice(0, 500),
    modelId: input.option.modelId,
    optionId: input.option.optionId,
    provider: input.option.provider,
    revisionId: input.option.revisionId,
    sources: [],
    status: "error",
    usage: input.usage ?? zeroUsage()
  };
}

async function executeOne(input: Readonly<{
  call: ModelToolCall;
  engineIndex: number;
  option: NormalizedSearchPlanOption;
  query: ValidatedSearchQuery;
  retry?: SearchRetryPorts;
  runtime: ProviderRuntimeBinding | undefined;
  signal?: AbortSignal;
}>): Promise<SearchExecutionResult> {
  const invocationId = `${input.call.id}:${input.option.optionId}`.slice(0, 500);
  if (!input.runtime || !input.option.modelId || input.signal?.aborted) {
    if (input.signal?.aborted) {
      logEvent("nested_abort", {
        layer: "search", stage: "before_start", abort_source: "unknown", engine_index: input.engineIndex
      });
    }
    logEvent("tool_execution", {
      tool_kind: "search", stage: "execution", engine_index: input.engineIndex,
      outcome: !input.runtime || !input.option.modelId || parentAbortCode(input.signal) === "search_timeout" ? "failed" : "cancelled",
      code: !input.runtime || !input.option.modelId ? "search_runtime_not_available" : parentAbortCode(input.signal)
    });
    return failedSearchExecution({
      call: input.call,
      failure: {
        code: !input.runtime || !input.option.modelId
          ? "search_runtime_not_available"
          : parentAbortCode(input.signal)
      },
      option: input.option
    });
  }
  const request = queryOnlyRequest(invocationId, input.option, input.query);
  const configured = searchExecutionConfiguration(input.option);
  const effectiveTimeoutMs = Math.min(
    configured.timeoutMs,
    input.runtime.responseTimeoutMs
  );
  const startedAt = performance.now();
  logEvent("tool_deadline", {
    tool_kind: "search", configured_timeout_ms: configured.timeoutMs, engine_index: input.engineIndex,
    effective_timeout_ms: effectiveTimeoutMs
  });
  logEvent("tool_execution", {
    tool_kind: "search", stage: "execution", outcome: "started", engine_index: input.engineIndex
  });
  const attemptController = new AbortController();
  let abortCode: "search_cancelled" | "search_timeout" | undefined;
  const abortAttempt = (code: "search_cancelled" | "search_timeout", reason: unknown, local = false) => {
    // Provider settlement may lag behind both events; keep the first cause.
    if (abortCode !== undefined) return;
    abortCode = code;
    logEvent("nested_abort", {
      layer: "search", stage: "delivery", engine_index: input.engineIndex,
      abort_source: local ? "search_deadline" : "parent_signal",
      duration_ms: performance.now() - startedAt,
      ...(local ? { timeout_ms: effectiveTimeoutMs } : {})
    });
    attemptController.abort(reason);
  };
  const relayAbort = bindContext(() => abortAttempt(parentAbortCode(input.signal), input.signal?.reason));
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(
    bindContext(() => abortAttempt("search_timeout", new SearchDeadlineError(), true)),
    effectiveTimeoutMs
  );
  const runtime = input.runtime;
  const remainingMs = () => Math.max(0, effectiveTimeoutMs - (performance.now() - startedAt));
  // Each failed attempt that was sent again; the last attempt's own failure is accounted in the catch.
  const retried: SearchAccounting[] = [];
  let ledger = searchAttemptLedger();
  /** The same request to the same engine again after a transient failure:
   * a network error, a rate limit, a server error or a dropped stream, never
   * a deterministic rejection or a response the adapter refused. */
  const retryDelayMs = (error: unknown, attempt: number): number | null => {
    if (abortCode !== undefined || attemptController.signal.aborted || isProviderSearchExecutionError(error) ||
      input.option.protocol === "deepseek_search_api") return null;
    const decision = modelCallRetryDecision(error, attemptController.signal);
    if (!decision) return null;
    const proposed = attempt < SEARCH_ENGINE_MAX_ATTEMPTS
      ? providerRetryDelayMs(attempt, decision.retryAfterMs, input.retry?.random, MODEL_CALL_RETRY.backoff) : null;
    const delayMs = proposed !== null && proposed + SEARCH_RETRY_MIN_ATTEMPT_MS <= remainingMs() ? proposed : null;
    const failure = observedFailure(error);
    logEvent("provider_retry", {
      action: delayMs === null ? "stop" : "retry", attempt, code: failure.code, reason: failure.reason, stage: "search",
      ...(delayMs === null ? {} : { delay_ms: delayMs }),
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {})
    });
    return delayMs;
  };
  const searchWithRetries = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await consumeProviderSearch(
          runtime,
          request,
          input.option,
          attemptController.signal,
          // A later attempt gets only what the engine's deadline leaves.
          attempt === 1 ? effectiveTimeoutMs : Math.max(1, Math.floor(remainingMs())),
          ledger.dispatch
        );
      } catch (error) {
        const delayMs = retryDelayMs(error, attempt);
        if (delayMs === null) throw error;
        retried.push(failedAttemptAccounting(error, ledger));
        ledger = searchAttemptLedger();
        await (input.retry?.sleep ?? sleepWithSignal)(delayMs, attemptController.signal);
      }
    }
  };
  try {
    const attempt = await searchWithRetries();
    const { costUsd, usage } = combinedAccounting([...retried, { costUsd: attempt.costUsd, usage: attempt.usage }]);
    const result = { ...attempt, costUsd, usage };
    // A caller cancellation may happen while another engine settles; preserve
    // that engine's settled evidence for fan-out accounting. A local deadline,
    // however, invalidates a result that arrived after the Search-owned timer.
    if (abortCode === "search_timeout") {
      // This attempt's own accounting: the earlier ones are already in `retried`.
      throw new ProviderSearchExecutionError({ artifacts: [], code: abortCode, costUsd: attempt.costUsd, usage: attempt.usage });
    }
    logEvent("tool_execution", {
      tool_kind: "search", stage: "execution", engine_index: input.engineIndex,
      duration_ms: performance.now() - startedAt,
      outcome: result.sourceAttribution === "provider_unavailable" ? "degraded" : "completed",
      ...(result.sourceAttribution === "provider_unavailable"
        ? { code: "provider_sources_unavailable", action: "degrade" as const } : {}),
      count: result.sources.length
    });
    return {
      ...(result.costUsd !== null ? { costUsd: result.costUsd } : {}),
      displayName: searchDisplayName(input.option),
      findings: result.findings,
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      // The protocol vouches for a source-free result: DeepSeek's hosted
      // Search without URLs, or a raw results API that found nothing.
      ...(result.sourceAttribution === "provider_unavailable" || result.noResults
        ? { protocol: input.option.protocol }
        : {}),
      revisionId: input.option.revisionId,
      sourceAttribution: result.sourceAttribution,
      sources: result.sources,
      status: "complete",
      usage: result.usage,
      ...(result.sourceAttribution === "provider_unavailable"
        ? { warning: "provider_sources_unavailable" }
        : {})
    };
  } catch (error) {
    const providerFailure = isProviderSearchExecutionError(error) ? error : null;
    const failure: SearchFailureEvidence = abortCode
      ? { code: abortCode }
      : providerFailure
        ? {
            code: normalizedFailureCode(providerFailure.code),
            ...(boundedFailureField(providerFailure.providerStatus, 64)
              ? { providerStatus: providerFailure.providerStatus }
              : {}),
            ...(boundedFailureField(providerFailure.reason, 128)
              ? { reason: providerFailure.reason }
              : {})
          }
        : { code: normalizedFailureCode(error instanceof Error ? error.message : undefined) };
    const observed = observedFailure(error);
    logEvent("tool_execution", {
      tool_kind: "search", stage: "execution", engine_index: input.engineIndex,
      duration_ms: performance.now() - startedAt,
      outcome: failure.code === "search_cancelled" ? "cancelled" : "failed", code: failure.code,
      reason: abortCode === "search_timeout" ? "deadline"
        : abortCode === "search_cancelled" ? "cancelled" : observed.reason,
      httpStatus: observed.httpStatus
    });
    const accounting = combinedAccounting([...retried, failedAttemptAccounting(error, ledger)]);
    return failedSearchExecution({
      call: input.call,
      costUsd: accounting.costUsd,
      failure,
      option: input.option,
      usage: normalizeTokenUsage({ ...accounting.usage, completeness: "partial" })
    });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", relayAbort);
  }
}

function aggregateSearchUsage(executions: readonly SearchExecutionEvidence[]): ModelRunUsage {
  return sumTokenUsage(executions.map((execution) => execution.usage));
}

function searchToolExecutionResult(input: Readonly<{
  call: ModelToolCall;
  executions: readonly SearchExecutionEvidence[];
  name: string;
}>): ToolExecutionResult {
  return {
    callId: input.call.id,
    content: searchToolResultContent(input.executions),
    name: input.name,
    rawPreview: {
      searchExecutions: input.executions,
      searchResultVersion: SEARCH_TOOL_RESULT_VERSION
    },
    status: input.executions.some((execution) => execution.status === "complete")
      ? "complete"
      : "error",
    usage: aggregateSearchUsage(input.executions)
  };
}

function oversizedSearchExecution(execution: SearchExecutionEvidence, engineIndex: number): SearchExecutionEvidence {
  logEvent("tool_execution", {
    tool_kind: "search", stage: "result", outcome: "degraded", engine_index: engineIndex,
    code: "search_result_too_large", action: "degrade"
  });
  return {
    ...(execution.costUsd !== undefined ? { costUsd: execution.costUsd } : {}),
    displayName: execution.displayName,
    failure: { code: "search_result_too_large" },
    invocationId: execution.invocationId,
    modelId: execution.modelId,
    optionId: execution.optionId,
    provider: execution.provider,
    revisionId: execution.revisionId,
    sources: [],
    status: "error",
    usage: execution.usage
  };
}

function executionByteSize(execution: SearchExecutionEvidence): number {
  return Buffer.byteLength(JSON.stringify(execution), "utf8");
}

/** The Search result Off persists, and an unretained v1 call delivers: whole
 * when it fits `resultBytes`; otherwise the largest successful engines, one by
 * one, become `search_result_too_large` errors whose findings and sources leave
 * this result while their usage stays (an unretained call's receipt also keeps
 * the sources). The model reads that code in the warnings line; findings are
 * never cut silently and no reader is promised without a retained original. */
export function fitDurableSearchToolResult(input: Readonly<{
  call: ModelToolCall;
  executions: readonly SearchExecutionEvidence[];
  name: string;
  onDegraded?(): void;
}>): ToolExecutionResult {
  const executions = [...input.executions];
  const result = () => searchToolExecutionResult({ ...input, executions });
  let candidate = result();
  if (snapshotToolExecutionResult(candidate, toolLoopPersistenceLimits.resultBytes)) {
    return candidate;
  }

  const successfulBySize = executions
    .map((execution, index) => ({ execution, index }))
    .filter(({ execution }) => execution.status === "complete")
    .sort((left, right) =>
      executionByteSize(right.execution) - executionByteSize(left.execution) ||
      right.index - left.index
    );
  for (const { index } of successfulBySize) {
    input.onDegraded?.();
    executions[index] = oversizedSearchExecution(executions[index]!, index + 1);
    candidate = result();
    if (snapshotToolExecutionResult(candidate, toolLoopPersistenceLimits.resultBytes)) {
      return candidate;
    }
  }

  for (const [index, execution] of executions.entries()) {
    input.onDegraded?.();
    executions[index] = oversizedSearchExecution(execution, index + 1);
  }
  candidate = result();
  if (snapshotToolExecutionResult(candidate, toolLoopPersistenceLimits.resultBytes)) {
    return candidate;
  }

  return {
    callId: input.call.id,
    content: [{ text: "Search failed: search_result_too_large", type: "text" }],
    name: input.name,
    rawPreview: {
      providerCall: true
    },
    status: "error",
    usage: aggregateSearchUsage(input.executions)
  };
}

export function createSearchPlanToolRouter(input: Readonly<{
  initialInvocationCounts?: Readonly<Record<string, number>>;
  plan: NormalizedSearchPlan;
  retry?: SearchRetryPorts;
  runtimes: Readonly<Record<string, ProviderRuntimeBinding | undefined>>;
}>): SearchPlanToolRouter | null {
  const searchRoutes = searchToolRoutes(input.plan);
  if (searchRoutes.length === 0) return null;
  const clientOptions = searchRoutes.flatMap((route) => route.options);
  const invocationCounts = new Map(clientOptions.map((option) => {
    const count = input.initialInvocationCounts?.[option.optionId];
    return [
      option.optionId,
      Number.isSafeInteger(count) && Number(count) > 0 ? Number(count) : 0
    ] as const;
  }));
  const budgetDescription = (options: readonly NormalizedSearchPlanOption[]) => {
    const available = Math.min(
      ...options.map((option) => searchExecutionConfiguration(option).maxSearchCallsPerAnswer)
    );
    return ` This source can be requested at most ${available} ${
      available === 1 ? "time" : "times"
    } for this answer.`;
  };
  const routes = searchRoutes.map((route) => ({
    options: route.options,
    tool: searchTool(
      route.name,
      route.description + budgetDescription(route.options),
      Math.min(...route.options.map((option) => searchExecutionConfiguration(option).queryMaxCharacters))
    )
  }));
  const routeForName = (name: string) =>
    routes.find((candidate) => candidate.tool.name === name);

  return {
    accepts(name) {
      return routeForName(name) !== undefined;
    },
    async execute(call, _request, options) {
      const startedAt = performance.now();
      logEvent("tool_execution", { tool_kind: "search", stage: "admission", outcome: "started" });
      let stage: "admission" | "execution" | "result" = "admission";
      let thrownCode: string | undefined;
      try {
      const route = routeForName(call.name);
      if (!route) {
        thrownCode = "search_tool_not_selected";
        throw new Error("search_tool_not_selected");
      }
      if (options?.signal?.aborted) {
        logEvent("nested_abort", { layer: "search", stage: "before_start", abort_source: "unknown" });
        const result = fitDurableSearchToolResult({
          call,
          executions: route.options.map((option, index) => {
            const code = !input.runtimes[option.optionId] || !option.modelId
              ? "search_runtime_not_available" : parentAbortCode(options.signal);
            logEvent("tool_execution", {
              tool_kind: "search", stage: "result", engine_index: index + 1,
              outcome: code === "search_cancelled" ? "cancelled" : "failed", code
            });
            return failedSearchExecution({ call, failure: { code }, option });
          }),
          name: call.name
        });
        throw new SearchToolCancelledError(result, options.signal.reason);
      }
      const queryLimit = Math.min(
        ...route.options.map((option) => searchExecutionConfiguration(option).queryMaxCharacters)
      );
      const validation = validateSearchToolArguments(call.arguments, queryLimit);
      const code = validation.ok ? null : validation.code;
      if (code) {
        logEvent("tool_execution", {
          tool_kind: "search", stage: "admission", outcome: "failed", code, reason: "policy"
        });
        logEvent("tool_execution", { tool_kind: "search", stage: "result", outcome: "failed", code });
        return {
          callId: call.id,
          content: [{ text: `Search failed: ${code}`, type: "text" }],
          name: call.name,
          rawPreview: { providerCall: false },
          status: "error",
          usage: zeroUsage()
        };
      }
      if (!validation.ok) throw new Error("search_query_validation_invariant");
      const exhaustedOption = route.options.find((option) =>
        (invocationCounts.get(option.optionId) ?? 0) >=
          searchExecutionConfiguration(option).maxSearchCallsPerAnswer
      );
      if (exhaustedOption) {
        const limitCode = "search_invocation_limit_reached";
        logEvent("tool_execution", {
          tool_kind: "search", stage: "admission", outcome: "degraded",
          code: limitCode, reason: "policy", action: "skip"
        });
        logEvent("tool_execution", {
          tool_kind: "search", stage: "result", outcome: "failed", code: limitCode
        });
        return {
          callId: call.id,
          content: [{
            text: `Search failed: ${limitCode}. Continue with the Search evidence already returned.`,
            type: "text"
          }],
          name: call.name,
          rawPreview: { providerCall: false },
          status: "error",
          usage: zeroUsage()
        };
      }
      for (const option of route.options) {
        invocationCounts.set(option.optionId, (invocationCounts.get(option.optionId) ?? 0) + 1);
      }
      logEvent("tool_execution", { tool_kind: "search", stage: "admission", outcome: "completed" });
      stage = "execution";
      const query = validation.query;
      const executions = await Promise.all(route.options.map((option, index) => executeOne({
        call,
        engineIndex: index + 1,
        option,
        query,
        ...(input.retry ? { retry: input.retry } : {}),
        runtime: input.runtimes[option.optionId],
        ...(options?.signal ? { signal: options.signal } : {})
      })));
      stage = "result";
      logEvent("tool_execution", { tool_kind: "search", stage: "result", outcome: "started" });
      let resultDegraded = false;
      const result = (options?.retainOriginal ? searchToolExecutionResult : fitDurableSearchToolResult)({
        call,
        executions,
        name: call.name,
        onDegraded() { resultDegraded = true; }
      });
      if (options?.signal?.aborted) {
        throw new SearchToolCancelledError(result, options.signal.reason);
      }
      logEvent("tool_execution", {
        tool_kind: "search", stage: "result", duration_ms: performance.now() - startedAt,
        outcome: result.status === "error" ? "failed"
          : resultDegraded || executions.some((execution) => execution.status === "error" || execution.warning)
            ? "degraded" : "completed"
      });
      return result;
      } catch (error) {
        const cancelled = error instanceof SearchToolCancelledError;
        const abortCode = cancelled ? parentAbortCode(options?.signal) : undefined;
        const failure = observedFailure(error);
        logEvent("tool_execution", {
          error,
          tool_kind: "search", stage, outcome: abortCode === "search_cancelled" ? "cancelled" : "failed",
          code: abortCode ?? thrownCode ?? failure.code,
          reason: abortCode === "search_timeout" ? "deadline" : cancelled ? "cancelled" : failure.reason,
          httpStatus: failure.httpStatus,
          // A pre-aborted call has not started an execution timer.
          ...(stage === "admission" && cancelled ? {} : { duration_ms: performance.now() - startedAt })
        });
        throw error;
      }
    },
    optionIdsForTool(name) {
      return routeForName(name)?.options.map((option) => option.optionId) ?? [];
    },
    tools: routes.map((route) => route.tool)
  };
}
