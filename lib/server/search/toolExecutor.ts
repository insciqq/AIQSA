import { textMessageContent } from "../../domain/content";
import type { ValidatedSearchQuery } from "../../domain/search";
import { mergeSearchEvidence } from "../../domain/search";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import {
  decodeThreadSearchProviderOperation,
  type ThreadSearchProviderOperation
} from "../../contracts/toolActivity";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type {
  NormalizedSearchPlan,
  NormalizedSearchPlanOption,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderSearchPolicy,
  ProviderSearchRequest
} from "../providers/types";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import { normalizeSearchSources, type SearchSource } from "./evidence";
import { providerSearchOperationsFromArtifacts } from "./providerOperations";
import { validateSearchToolArguments } from "./query";

const allSelectedToolName = "search_selected_engines";

export type SearchExecutionEvidence = Readonly<{
  displayName: string;
  durationMs: number;
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

type SearchExecutionResult = SearchExecutionEvidence & Readonly<{
  finalText?: string;
}>;

export type SearchPlanToolRouter = Readonly<{
  execute(
    call: ModelToolCall,
    request: ProviderRunRequest,
    options?: { signal?: AbortSignal }
  ): Promise<ToolExecutionResult>;
  tools: readonly RunTool[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zeroUsage(): ModelRunUsage {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function toolName(option: NormalizedSearchPlanOption, ordinal: number): string {
  const slug = option.optionId.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 36);
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
  maxResults: number;
  queryMaxCharacters: number;
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
    maxResults: Number.isSafeInteger(config.maxResults) ? Number(config.maxResults) : 8,
    queryMaxCharacters: Number.isSafeInteger(config.queryMaxCharacters) &&
      Number(config.queryMaxCharacters) >= 1 && Number(config.queryMaxCharacters) <= 1_000
      ? Number(config.queryMaxCharacters)
      : 500,
    timeoutMs: Number.isSafeInteger(config.timeoutMs) ? Number(config.timeoutMs) : 300_000
  };
}

function queryOnlyRequest(
  correlationId: string,
  option: NormalizedSearchPlanOption,
  query: ValidatedSearchQuery
): ProviderRunRequest {
  const configured = configuration(option);
  const content = textMessageContent(query);
  return {
    attachmentIds: [],
    attachments: [],
    chatId: correlationId,
    content,
    context: {
      messages: [{ content, id: `search-query:${option.optionId}`, role: "user" }],
      mode: "branch_path"
    },
    forceNonStreaming: true,
    modelCapabilities: configured.capabilities,
    modelId: option.modelId ?? "",
    params: {
      ...configured.defaultParams,
      background: false,
      maxOutputTokens: 1_024,
      max_output_tokens: 1_024,
      store: false,
      stream: false
    },
    prompt: {
      developer: "Search the web for the query. Return concise source-backed findings.",
      presetId: null,
      system: null
    },
    provider: option.provider,
    searchStrategy: null
  };
}

async function consumeProviderSearch(
  runtime: ProviderRuntimeBinding,
  request: ProviderRunRequest,
  option: NormalizedSearchPlanOption,
  query: ValidatedSearchQuery,
  correlationId: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<{
  artifacts: ModelRunSseEvent[];
  finalText: string;
  sources: SearchSource[];
  usage: ModelRunUsage;
}> {
  if (option.protocol === "openrouter_perplexity_chat") {
    if (!runtime.searchAdapter) throw new Error("search_adapter_not_available");
    const searchPolicy: ProviderSearchPolicy = {
      controls: {
        maxOutputTokens: { defaultValue: 1_024, maxValue: 4_096 },
        temperature: { defaultValue: 0, maxValue: 2, minValue: 0, supported: true }
      },
      defaultParams: { ...configuration(option).defaultParams, stream: false },
      modelId: request.modelId,
      provider: "openrouter",
      strategyId: "perplexity-tool-search"
    };
    const searchRequest: ProviderSearchRequest = {
      correlationId,
      query,
      searchPolicy,
      strategyId: option.optionId
    };
    const result = await runtime.searchAdapter.search(searchRequest, { signal, timeoutMs });
    return {
      artifacts: result.artifacts,
      finalText: result.finalText,
      sources: normalizeSearchSources([
        result.artifacts,
        result.finalProviderResponsePreview
      ], configuration(option).maxResults),
      usage: result.usage
    };
  }
  if (option.protocol !== "openai_responses_web_search") {
    throw new Error("search_protocol_not_supported");
  }
  const artifacts: ModelRunSseEvent[] = [];
  const stream = runtime.adapter.stream({
    ...request,
    searchStrategy: "openai-native-web-search"
  }, { signal, timeoutMs });
  let next = await stream.next();
  while (!next.done) {
    if (next.value.type === "artifact") artifacts.push(next.value);
    next = await stream.next();
  }
  return {
    artifacts,
    finalText: next.value.finalText,
    sources: normalizeSearchSources([
      artifacts,
      next.value.finalProviderResponsePreview
    ], configuration(option).maxResults),
    usage: next.value.usage
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
      displayName: input.option.displayName ?? input.option.optionId,
      durationMs: Date.now() - started,
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
      usage: zeroUsage(),
      warning: "search_runtime_not_available"
    };
  }
  const request = queryOnlyRequest(invocationId, input.option, input.query);
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
      input.query,
      invocationId,
      timeoutController.signal,
      configuration(input.option).timeoutMs
    );
    const providerTrace = input.option.protocol === "openai_responses_web_search"
      ? providerSearchOperationsFromArtifacts(result.artifacts)
      : null;
    return {
      displayName: input.option.displayName ?? input.option.optionId,
      durationMs: Date.now() - started,
      finalText: result.finalText,
      invocationId,
      modelId: input.option.modelId,
      optionId: input.option.optionId,
      provider: input.option.provider,
      ...(providerTrace
        ? { providerOperations: providerTrace.operations }
        : {}),
      providerOperationsTruncated: providerTrace?.truncated ?? false,
      query: input.query,
      requestPreview: {
        modelId: input.option.modelId,
        protocol: input.option.protocol,
        provider: input.option.provider,
        queryCharacters: input.query.length,
        sourceLimit: configuration(input.option).maxResults
      },
      revisionId: input.option.revisionId,
      sources: result.sources,
      status: "complete",
      usage: result.usage
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      displayName: input.option.displayName ?? input.option.optionId,
      durationMs: Date.now() - started,
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
      usage: zeroUsage(),
      warning: timeoutController.signal.aborted
        ? "search_timeout"
        : error instanceof Error
          ? error.message.slice(0, 200)
          : "search_execution_failed"
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
      (value.status === "complete" || value.status === "error") &&
      isRecord(value.usage)
    );
    if (!valid) return [];
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
        : value.optionId as string,
      providerOperationsTruncated: value.providerOperationsTruncated === true,
      ...(providerOperations ? { providerOperations } : {})
    }];
  });
}

export function createSearchPlanToolRouter(input: Readonly<{
  plan: NormalizedSearchPlan;
  runtimes: Readonly<Record<string, ProviderRuntimeBinding | undefined>>;
}>): SearchPlanToolRouter | null {
  const clientOptions = input.plan.options.filter(
    (option) => option.adapterKind === "provider_model_client"
  );
  if (clientOptions.length === 0) return null;
  const routes = input.plan.mode === "all_selected"
    ? [{
        options: clientOptions,
        tool: searchTool(
          allSelectedToolName,
          "Search every user-selected web engine with the same concise query and combine attributed sources.",
          Math.min(...clientOptions.map((option) => configuration(option).queryMaxCharacters))
        )
      }]
    : clientOptions.map((option, ordinal) => ({
        options: [option],
        tool: searchTool(
          toolName(option, ordinal),
          `Search the user-selected engine ${option.optionId} with a concise query.`,
          configuration(option).queryMaxCharacters
        )
      }));

  return {
    async execute(call, request, options) {
      const route = routes.find((candidate) => candidate.tool.name === call.name);
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
      const warnings = executions.flatMap((execution) => execution.warning
        ? [{ optionId: execution.optionId, warning: execution.warning }]
        : []);
      const text = [
        ...successful.flatMap((execution) => execution.finalText
          ? [`[${execution.optionId}]\n${execution.finalText}`]
          : []),
        sources.length
          ? `Sources:\n${sources.map((source, index) =>
              `${index + 1}. ${source.title} — ${source.url}`).join("\n")}`
          : "",
        warnings.length
          ? `Search warnings: ${warnings.map((warning) =>
              `${warning.optionId}: ${warning.warning}`).join("; ")}`
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
            searchExecutions: executions.map(({ finalText: _finalText, ...execution }) => execution),
            sources,
            warnings
          },
          requestPreview: {
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
    tools: routes.map((route) => route.tool)
  };
}
