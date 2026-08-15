import type { ValidatedSearchQuery } from "../../domain/search";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import {
  adminSearchExecutionDefaults,
  adminSearchExecutionLimits,
  type AdminSearchReasoningPolicy
} from "../../contracts/adminSearch";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import {
  isProviderSearchExecutionError,
  ProviderSearchExecutionError
} from "../providers/types";
import type {
  NormalizedSearchPlan,
  NormalizedSearchPlanOption,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "../providers/types";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import {
  normalizeSearchFindings,
  normalizeSearchSources,
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

export {
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult
} from "./toolResult";
export type { SearchExecutionEvidence } from "./toolResult";

const allSelectedToolName = "search_selected_engines";

type SearchExecutionResult = SearchExecutionEvidence;

type SearchFailureEvidence = NonNullable<SearchExecutionEvidence["failure"]>;

export type SearchPlanToolRouter = Readonly<{
  accepts(name: string): boolean;
  execute(
    call: ModelToolCall,
    request: ProviderRunRequest,
    options?: { signal?: AbortSignal }
  ): Promise<ToolExecutionResult>;
  optionIdsForTool(name: string): readonly string[];
  tools: readonly RunTool[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroUsage(): ModelRunUsage {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
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

function toolDescription(option: NormalizedSearchPlanOption): string {
  const displayName = option.displayName?.trim().slice(0, 160);
  return displayName
    ? `Search the user-selected web source ${JSON.stringify(displayName)} with a concise query.`
    : "Search one user-selected web source with a concise query.";
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

function configuration(option: NormalizedSearchPlanOption): {
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
    maxOutputTokens: boundedInteger(
      config.maxOutputTokens,
      adminSearchExecutionLimits.maxOutputTokens.minimum,
      adminSearchExecutionLimits.maxOutputTokens.maximum,
      adminSearchExecutionDefaults.maxOutputTokens
    ),
    maxResults: boundedInteger(config.maxResults, 1, 20, 8),
    maxSearchCallsPerAnswer: boundedInteger(
      config.maxSearchCallsPerAnswer,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.minimum,
      adminSearchExecutionLimits.maxSearchCallsPerAnswer.maximum,
      adminSearchExecutionDefaults.maxSearchCallsPerAnswer
    ),
    queryMaxCharacters: Number.isSafeInteger(config.queryMaxCharacters) &&
      Number(config.queryMaxCharacters) >= 1 && Number(config.queryMaxCharacters) <= 1_000
      ? Number(config.queryMaxCharacters)
      : 500,
    reasoningPolicy: config.reasoningPolicy === "provider_default"
      ? "provider_default"
      : adminSearchExecutionDefaults.reasoningPolicy,
    timeoutMs: Number.isSafeInteger(config.timeoutMs) ? Number(config.timeoutMs) : 300_000
  };
}

function queryOnlyRequest(
  correlationId: string,
  option: NormalizedSearchPlanOption,
  query: ValidatedSearchQuery
): ProviderSearchRequest {
  const configured = configuration(option);
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
    searchPolicy,
    strategyId: option.optionId
  };
}

async function consumeProviderSearch(
  runtime: ProviderRuntimeBinding,
  request: ProviderSearchRequest,
  option: NormalizedSearchPlanOption,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<{
  findings: string;
  sources: SearchSource[];
  usage: ModelRunUsage;
}> {
  if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
  const result = await runtime.searchAdapter.search(request, { signal, timeoutMs });
  const sources = normalizeSearchSources(result.sources, configuration(option).maxResults);
  if (sources.length === 0) {
    throw new ProviderSearchExecutionError({
      artifacts: result.artifacts,
      code: "search_sources_invalid",
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
      usage: result.usage
    });
  }
  return {
    findings,
    sources,
    usage: result.usage
  };
}

async function executeOne(input: Readonly<{
  call: ModelToolCall;
  option: NormalizedSearchPlanOption;
  query: ValidatedSearchQuery;
  runtime: ProviderRuntimeBinding | undefined;
  signal?: AbortSignal;
}>): Promise<SearchExecutionResult> {
  const invocationId = `${input.call.id}:${input.option.optionId}`.slice(0, 500);
  if (!input.runtime || !input.option.modelId) {
    return {
      displayName: searchDisplayName(input.option),
      failure: { code: "search_runtime_not_available" },
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      revisionId: input.option.revisionId,
      sources: [],
      status: "error",
      usage: zeroUsage()
    };
  }
  const request = queryOnlyRequest(invocationId, input.option, input.query);
  const configured = configuration(input.option);
  const effectiveTimeoutMs = Math.min(
    configured.timeoutMs,
    input.runtime.responseTimeoutMs
  );
  const timeoutController = new AbortController();
  const relayAbort = () => timeoutController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("search_timeout")),
    effectiveTimeoutMs
  );
  try {
    const result = await consumeProviderSearch(
      input.runtime,
      request,
      input.option,
      timeoutController.signal,
      effectiveTimeoutMs
    );
    return {
      displayName: searchDisplayName(input.option),
      findings: result.findings,
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      revisionId: input.option.revisionId,
      sources: result.sources,
      status: "complete",
      usage: result.usage
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const timedOut = timeoutController.signal.aborted;
    const providerFailure = isProviderSearchExecutionError(error) ? error : null;
    const failure: SearchFailureEvidence = timedOut
      ? { code: "search_timeout" }
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
    return {
      displayName: searchDisplayName(input.option),
      failure,
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      revisionId: input.option.revisionId,
      sources: [],
      status: "error",
      usage: providerFailure?.usage ?? zeroUsage()
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", relayAbort);
  }
}

function aggregateSearchUsage(executions: readonly SearchExecutionEvidence[]): ModelRunUsage {
  return executions.reduce((usage, execution) => ({
    inputTokens: usage.inputTokens + execution.usage.inputTokens,
    outputTokens: usage.outputTokens + execution.usage.outputTokens,
    reasoningTokens: usage.reasoningTokens + execution.usage.reasoningTokens,
    totalTokens: (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) +
      (execution.usage.totalTokens ??
        execution.usage.inputTokens + execution.usage.outputTokens)
  }), zeroUsage());
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

function oversizedSearchExecution(execution: SearchExecutionEvidence): SearchExecutionEvidence {
  return {
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

function fitDurableSearchToolResult(input: Readonly<{
  call: ModelToolCall;
  executions: readonly SearchExecutionEvidence[];
  name: string;
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
    executions[index] = oversizedSearchExecution(executions[index]!);
    candidate = result();
    if (snapshotToolExecutionResult(candidate, toolLoopPersistenceLimits.resultBytes)) {
      return candidate;
    }
  }

  for (const [index, execution] of executions.entries()) {
    executions[index] = oversizedSearchExecution(execution);
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
  runtimes: Readonly<Record<string, ProviderRuntimeBinding | undefined>>;
}>): SearchPlanToolRouter | null {
  const clientOptions = input.plan.options.filter(
    (option) => option.adapterKind === "provider_model_client"
  );
  if (clientOptions.length === 0) return null;
  const invocationCounts = new Map(clientOptions.map((option) => {
    const count = input.initialInvocationCounts?.[option.optionId];
    return [
      option.optionId,
      Number.isSafeInteger(count) && Number(count) > 0 ? Number(count) : 0
    ] as const;
  }));
  const budgetDescription = (options: readonly NormalizedSearchPlanOption[]) => {
    const available = Math.min(
      ...options.map((option) => configuration(option).maxSearchCallsPerAnswer)
    );
    return ` This source can be requested at most ${available} ${
      available === 1 ? "time" : "times"
    } for this answer.`;
  };
  const routes = input.plan.mode === "all_selected"
    ? [{
        options: clientOptions,
        tool: searchTool(
          allSelectedToolName,
          "Search every user-selected web engine with the same concise query and combine attributed sources." +
            budgetDescription(clientOptions),
          Math.min(...clientOptions.map((option) => configuration(option).queryMaxCharacters))
        )
      }]
    : clientOptions.map((option, ordinal) => ({
        options: [option],
        tool: searchTool(
          toolName(ordinal),
          toolDescription(option) + budgetDescription([option]),
          configuration(option).queryMaxCharacters
        )
      }));
  const routeForName = (name: string) =>
    routes.find((candidate) => candidate.tool.name === name);

  return {
    accepts(name) {
      return routeForName(name) !== undefined;
    },
    async execute(call, _request, options) {
      const route = routeForName(call.name);
      if (!route) throw new Error("search_tool_not_selected");
      const queryLimit = Math.min(
        ...route.options.map((option) => configuration(option).queryMaxCharacters)
      );
      const validation = validateSearchToolArguments(call.arguments, queryLimit);
      const code = validation.ok ? null : validation.code;
      if (code) {
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
          configuration(option).maxSearchCallsPerAnswer
      );
      if (exhaustedOption) {
        const limitCode = "search_invocation_limit_reached";
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
      const query = validation.query;
      const executions = await Promise.all(route.options.map((option) => executeOne({
        call,
        option,
        query,
        runtime: input.runtimes[option.optionId],
        ...(options?.signal ? { signal: options.signal } : {})
      })));
      return fitDurableSearchToolResult({
        call,
        executions,
        name: call.name
      });
    },
    optionIdsForTool(name) {
      return routeForName(name)?.options.map((option) => option.optionId) ?? [];
    },
    tools: routes.map((route) => route.tool)
  };
}
