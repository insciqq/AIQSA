import type { ValidatedSearchQuery } from "../../domain/search";
import { mergeSearchEvidence } from "../../domain/search";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import {
  adminSearchExecutionDefaults,
  adminSearchExecutionLimits,
  type AdminSearchReasoningPolicy
} from "../../contracts/adminSearch";
import {
  decodeThreadSearchProviderOperation,
  type ThreadSearchProviderOperation
} from "../../contracts/toolActivity";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { isProviderSearchExecutionError } from "../providers/types";
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
  MAX_SEARCH_FINDINGS_CHARACTERS,
  normalizeSearchFindings,
  normalizeSearchSources,
  type SearchSource
} from "./evidence";
import { providerSearchOperationsFromArtifacts } from "./providerOperations";
import { validateSearchToolArguments } from "./query";

const allSelectedToolName = "search_selected_engines";

export type SearchExecutionEvidence = Readonly<{
  displayName: string;
  durationMs: number;
  failure?: Readonly<{
    code: string;
    providerStatus?: string;
    reason?: string;
  }>;
  findings?: string;
  invocationId: string;
  modelId: string | null;
  optionId: string;
  provider: string;
  providerOperations?: readonly ThreadSearchProviderOperation[];
  providerOperationsTruncated: boolean;
  query: string;
  requestPreview: Readonly<Record<string, unknown>>;
  revisionId: string;
  sources: readonly SearchSource[];
  status: "complete" | "error";
  usage: ModelRunUsage;
  warning?: string;
}>;

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

function decodedFindings(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeSearchFindings(value);
  } catch {
    return undefined;
  }
}

function decodedFailure(value: unknown): SearchFailureEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const code = normalizedFailureCode(value.code);
  const providerStatus = boundedFailureField(value.providerStatus, 64);
  const reason = boundedFailureField(value.reason, 128);
  return {
    code,
    ...(providerStatus ? { providerStatus } : {}),
    ...(reason ? { reason } : {})
  };
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

function legacyToolName(option: NormalizedSearchPlanOption, ordinal: number): string {
  const slug = option.optionId.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 36);
  return `search_${ordinal + 1}_${slug || "engine"}`;
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
    maxResults: Number.isSafeInteger(config.maxResults) ? Number(config.maxResults) : 8,
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
  artifacts: ModelRunSseEvent[];
  findings: string;
  requestPreview: Record<string, unknown>;
  sources: SearchSource[];
  usage: ModelRunUsage;
}> {
  if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
  const result = await runtime.searchAdapter.search(request, { signal, timeoutMs });
  return {
    artifacts: result.artifacts,
    findings: normalizeSearchFindings(result.findings),
    requestPreview: result.requestPreview,
    sources: normalizeSearchSources(result.sources, configuration(option).maxResults),
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
  const started = Date.now();
  const invocationId = `${input.call.id}:${input.option.optionId}`.slice(0, 500);
  if (!input.runtime || !input.option.modelId) {
    return {
      displayName: searchDisplayName(input.option),
      durationMs: Date.now() - started,
      failure: { code: "search_runtime_not_available" },
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      providerOperationsTruncated: false,
      query: input.query,
      requestPreview: { queryCharacters: input.query.length },
      revisionId: input.option.revisionId,
      sources: [],
      status: "error",
      usage: zeroUsage()
    };
  }
  const request = queryOnlyRequest(invocationId, input.option, input.query);
  const configured = configuration(input.option);
  const executionRequestPreview = {
    maxOutputTokens: configured.maxOutputTokens,
    modelId: input.option.modelId,
    protocol: input.option.protocol,
    provider: input.option.provider,
    queryCharacters: input.query.length,
    reasoningPolicy: configured.reasoningPolicy,
    sourceLimit: configured.maxResults,
    ...(input.runtime.searchAdapter
      ? { providerRequest: input.runtime.searchAdapter.buildRequestPreview(request) }
      : {})
  };
  const timeoutController = new AbortController();
  const relayAbort = () => timeoutController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("search_timeout")),
    configuration(input.option).timeoutMs
  );
  try {
    const result = await consumeProviderSearch(
      input.runtime,
      request,
      input.option,
      timeoutController.signal,
      configured.timeoutMs
    );
    const providerTrace = providerSearchOperationsFromArtifacts(result.artifacts);
    return {
      displayName: searchDisplayName(input.option),
      durationMs: Date.now() - started,
      findings: result.findings,
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      ...(providerTrace
        ? { providerOperations: providerTrace.operations }
        : {}),
      providerOperationsTruncated: providerTrace?.truncated ?? false,
      query: input.query,
      requestPreview: executionRequestPreview,
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
    const providerTrace = providerFailure
      ? providerSearchOperationsFromArtifacts(providerFailure.artifacts)
      : null;
    return {
      displayName: searchDisplayName(input.option),
      durationMs: Date.now() - started,
      failure,
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      ...(providerTrace ? { providerOperations: providerTrace.operations } : {}),
      providerOperationsTruncated: providerTrace?.truncated ?? false,
      query: input.query,
      requestPreview: executionRequestPreview,
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

export function searchExecutionsFromToolResult(
  result: ToolExecutionResult
): SearchExecutionEvidence[] {
  const preview = result.rawPreview?.finalProviderResponsePreview;
  if (!isRecord(preview) || !Array.isArray(preview.searchExecutions)) return [];
  return preview.searchExecutions.flatMap((value): SearchExecutionEvidence[] => {
    if (!isRecord(value)) return [];
    const valid = (
      typeof value.durationMs === "number" &&
      typeof value.invocationId === "string" &&
      (value.modelId === null || typeof value.modelId === "string") &&
      typeof value.optionId === "string" &&
      typeof value.provider === "string" &&
      (value.providerOperationsTruncated === undefined ||
        typeof value.providerOperationsTruncated === "boolean") &&
      typeof value.query === "string" &&
      typeof value.revisionId === "string" &&
      Array.isArray(value.sources) &&
      (value.findings === undefined || (
        typeof value.findings === "string" &&
        value.findings.length <= MAX_SEARCH_FINDINGS_CHARACTERS
      )) &&
      (value.status === "complete" || value.status === "error") &&
      isRecord(value.usage)
    );
    if (!valid) return [];
    const failure = value.failure === undefined ? undefined : decodedFailure(value.failure);
    if (value.failure !== undefined && !failure) return [];
    const findings = decodedFindings(value.findings);
    if (value.findings !== undefined && !findings) return [];
    let providerOperations: ThreadSearchProviderOperation[] | undefined;
    if (value.providerOperations !== undefined) {
      if (!Array.isArray(value.providerOperations) || value.providerOperations.length > 32) return [];
      providerOperations = value.providerOperations.flatMap((operation) => {
        const decoded = decodeThreadSearchProviderOperation(operation);
        return decoded ? [decoded] : [];
      });
      if (providerOperations.length !== value.providerOperations.length) return [];
    }
    return [{
      ...(value as unknown as SearchExecutionEvidence),
      displayName: typeof value.displayName === "string" && value.displayName.trim()
        ? value.displayName.trim().slice(0, 256)
        : "Search source",
      providerOperationsTruncated: value.providerOperationsTruncated === true,
      ...(failure ? { failure } : {}),
      ...(findings ? { findings } : {}),
      ...(providerOperations ? { providerOperations } : {})
    }];
  });
}

export function createSearchPlanToolRouter(input: Readonly<{
  acceptLegacyToolNames?: boolean;
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
  const legacyRoute = (name: string) => input.acceptLegacyToolNames &&
    input.plan.mode === "model_choice"
    ? routes.find((candidate, ordinal) =>
        candidate.options.length === 1 &&
        legacyToolName(candidate.options[0]!, ordinal) === name)
    : undefined;
  const routeForName = (name: string) =>
    routes.find((candidate) => candidate.tool.name === name) ?? legacyRoute(name);

  return {
    accepts(name) {
      return routeForName(name) !== undefined;
    },
    async execute(call, request, options) {
      const route = routeForName(call.name);
      if (!route) throw new Error("search_tool_not_selected");
      const queryLimit = Math.min(
        ...route.options.map((option) => configuration(option).queryMaxCharacters)
      );
      const validation = validateSearchToolArguments(call.arguments, queryLimit);
      const attachmentDisclosureBlocked =
        request.attachmentIds.length > 0 || request.attachments.length > 0;
      const code = attachmentDisclosureBlocked
        ? "client_search_with_attachments_not_supported"
        : validation.ok
          ? null
          : validation.code;
      if (code) {
        return {
          callId: call.id,
          content: [{ text: `Search failed: ${code}`, type: "text" }],
          name: call.name,
          rawPreview: {
            finalProviderResponsePreview: { error: code },
            providerCall: false,
            requestPreview: {
              queryCharacters:
                typeof call.arguments.query === "string"
                  ? Math.min(call.arguments.query.length, queryLimit + 1)
                  : 0,
              selectedOptionIds: route.options.map((option) => option.optionId)
            }
          },
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
        const invocationCount = invocationCounts.get(exhaustedOption.optionId) ?? 0;
        const maxInvocations = configuration(exhaustedOption).maxSearchCallsPerAnswer;
        return {
          callId: call.id,
          content: [{
            text: `Search failed: ${limitCode}. Continue with the Search evidence already returned.`,
            type: "text"
          }],
          name: call.name,
          rawPreview: {
            finalProviderResponsePreview: {
              error: limitCode,
              invocationCount,
              maxInvocations
            },
            providerCall: false,
            requestPreview: {
              queryCharacters: validation.query.length,
              selectedOptionIds: route.options.map((option) => option.optionId)
            }
          },
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
      const successful = executions.filter((execution) => execution.status === "complete");
      const sources = mergeSearchEvidence(
        route.options.map((option) => option.optionId),
        successful.map((execution) => ({
          invocationId: execution.invocationId,
          optionId: execution.optionId,
          sources: execution.sources
        }))
      );
      const warnings = executions.flatMap((execution) => {
        const warning = execution.failure?.code ?? execution.warning;
        return warning
          ? [{
            displayName: execution.displayName,
            optionId: execution.optionId,
            warning
          }]
          : [];
      });
      const text = [
        ...successful.flatMap((execution) => execution.findings
          ? [`Search source ${JSON.stringify(execution.displayName)}:\n${execution.findings}`]
          : []),
        sources.length
          ? `Sources:\n${sources.map((source, index) =>
              `${index + 1}. ${source.title} — ${source.url}`).join("\n")}`
          : "",
        warnings.length
          ? `Search warnings: ${warnings.map((warning) =>
              `${JSON.stringify(warning.displayName)}: ${warning.warning}`).join("; ")}`
          : ""
      ].filter(Boolean).join("\n\n");
      return {
        callId: call.id,
        content: [{
          text: text || "Every selected search engine failed.",
          type: "text"
        }],
        name: call.name,
        rawPreview: {
          finalProviderResponsePreview: {
            searchExecutions: executions,
            sources,
            warnings
          },
          requestPreview: {
            invocationCounts: Object.fromEntries(route.options.map((option) => [
              option.optionId,
              invocationCounts.get(option.optionId) ?? 0
            ])),
            maxInvocations: Object.fromEntries(route.options.map((option) => [
              option.optionId,
              configuration(option).maxSearchCallsPerAnswer
            ])),
            queryCharacters: query.length,
            selectedOptionIds: route.options.map((option) => option.optionId)
          }
        },
        status: successful.length > 0 ? "complete" : "error",
        usage: executions.reduce((usage, execution) => ({
          inputTokens: usage.inputTokens + execution.usage.inputTokens,
          outputTokens: usage.outputTokens + execution.usage.outputTokens,
          reasoningTokens: usage.reasoningTokens + execution.usage.reasoningTokens,
          totalTokens: (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) +
            (execution.usage.totalTokens ??
              execution.usage.inputTokens + execution.usage.outputTokens)
        }), zeroUsage())
      };
    },
    optionIdsForTool(name) {
      return routeForName(name)?.options.map((option) => option.optionId) ?? [];
    },
    tools: routes.map((route) => route.tool)
  };
}
