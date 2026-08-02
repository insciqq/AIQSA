import type { ChatUpdateDataWire } from "../../contracts/chats";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import { textMessageContent } from "../../domain/content";
import {
  GROUNDED_LIVE_ONLY_PLACEHOLDER,
  groundedLiveOnlyProviderPreview
} from "../../domain/grounding";
import {
  encodeSseEvent,
  isGroundingDisplaySseEvent,
  type ModelRunChatUpdateData,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import { sumTokenUsage } from "../../domain/usage";
import { validateRunAccess } from "../auth/entitlements";
import { isProviderTimeoutError } from "../providers/network";
import type {
  ProviderAdapter,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter
} from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import {
  mcpRunTools,
  mcpToolExecutionResult,
  resolveMcpRunTool
} from "../mcp/toolExecutor";
import { providerToolBridges } from "../tools/bridges";
import { createPerplexitySearchToolExecutor, perplexityWebSearchTool } from "../tools/perplexitySearch";
import {
  createSearchPlanToolRouter,
  searchExecutionsFromToolResult,
  type SearchExecutionEvidence
} from "../search/toolExecutor";
import {
  hasInvalidProviderToolArguments,
  type ModelToolCall,
  type ProviderToolBridge,
  type RunTool,
  type ToolExecutionResult
} from "../tools/types";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import { withPinnedHostedSearchIdentity } from "./searchArtifactIdentity";
import {
  appendRunEventWithRetry,
  finalizeRunCompletion,
  usageAttributionsWithEstimatedCost,
  type RunEventSequence
} from "./runFinalization";
import type { MaterializedPreparedRunData } from "./runPreparation";
import type {
  RunChatUpdateRecord,
  RunRepository,
  RunUsageAttribution
} from "./runRepositoryContract";
import { runProviderToolLoop as continueProviderToolLoop } from "./providerToolLoop";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "./toolExecutionPersistence";
import {
  snapshotToolLoopJson,
  toolLoopPersistenceLimits,
  type PersistedToolLoopCall,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import {
  persistedToolDurationMs,
  toolCallInspectionArtifact,
  toolLoopPhaseArtifact,
  toolResultInspectionArtifact
} from "./toolInspection";

const tokenPersistenceFlushIntervalMs = 400;
const tokenPersistenceMaxTokens = 32;
const maxToolRounds = 3;

const globalForRuns = globalThis as unknown as {
  __aiqsaActiveRunControllers?: Map<string, AbortController>;
};
const activeRunControllers = globalForRuns.__aiqsaActiveRunControllers ?? new Map<string, AbortController>();
globalForRuns.__aiqsaActiveRunControllers = activeRunControllers;

export type ActiveRunControllerRegistry = Readonly<{
  abort(runId: string): boolean;
  has(runId: string): boolean;
  ids(): readonly string[];
  register(runId: string): Readonly<{
    release(): void;
    signal: AbortSignal;
  }> | null;
}>;

export const activeRunControllerRegistry: ActiveRunControllerRegistry = Object.freeze({
  abort(runId: string): boolean {
    const controller = activeRunControllers.get(runId);
    if (!controller) {
      return false;
    }

    controller.abort();
    if (activeRunControllers.get(runId) === controller) {
      activeRunControllers.delete(runId);
    }
    return true;
  },
  has(runId: string): boolean {
    return activeRunControllers.has(runId);
  },
  ids(): readonly string[] {
    return [...activeRunControllers.keys()];
  },
  register(runId: string) {
    if (activeRunControllers.has(runId)) return null;
    const controller = new AbortController();
    activeRunControllers.set(runId, controller);
    return Object.freeze({
      release() {
        if (activeRunControllers.get(runId) === controller) {
          activeRunControllers.delete(runId);
        }
      },
      signal: controller.signal
    });
  }
});

export function activeRunControllersForTest(): Map<string, AbortController> {
  return activeRunControllers;
}

export type RunExecutionRepository = Pick<
  RunRepository,
  | "advanceToolLoopCallBatch"
  | "appendAssistantText"
  | "appendRunEvent"
  | "beginToolLoopProviderRound"
  | "cancelPendingToolLoopCalls"
  | "claimToolLoopCall"
  | "completeRun"
  | "createSearchRun"
  | "failRun"
  | "getChatUpdateForRun"
  | "isSearchStrategyEnabled"
  | "loadEntitlements"
  | "loadModelConfiguration"
  | "loadModelPricing"
  | "markAssistantMessageGroundedLiveOnly"
  | "nextRunEventSequence"
  | "persistToolLoopCallBatch"
  | "recordRunUsageEvents"
  | "resetToolLoopAssistantDraft"
  | "settleToolLoopCall"
  | "updateRunProviderRequestPreview"
  | "updateRunProviderResponseId"
>;

export type RunExecutionInput = Readonly<{
  adapter: ProviderAdapter;
  created: Readonly<{
    assistantMessageId: string;
    runId: string;
    userMessageId: string;
  }>;
  prepared: MaterializedPreparedRunData;
  repository: RunExecutionRepository;
  mcpRuntime?: Readonly<{
    callTool(input: {
      arguments: Record<string, unknown>;
      generationId: string;
      inputSchema: Record<string, unknown>;
      name: string;
      signal?: AbortSignal;
    }): Promise<AiqsaMcpToolCallResult>;
    ensureAcceptedGeneration(generationId: string): Promise<boolean>;
  }>;
  searchAdapter?: ProviderSearchAdapter;
  searchRuntimes?: Readonly<Record<string, ProviderRuntimeBinding>>;
  toolBridge?: ProviderToolBridge;
  userId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelToolCall(call: Readonly<{
  arguments: unknown;
  id: string;
  name: string;
}>): ModelToolCall {
  return {
    arguments: isRecord(call.arguments) ? call.arguments : {},
    id: call.id,
    name: call.name
  };
}

function contextTruncationArtifact(summary: ContextTruncationSummary): ModelRunSseEvent {
  return {
    data: {
      artifactType: "context_truncated",
      payload: summary
    },
    type: "artifact"
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeChatUpdate(
  update: RunChatUpdateRecord,
  liveGroundedAnswer?: Readonly<{ assistantMessageId: string; finalText: string }>
): ModelRunChatUpdateData {
  return {
    chat: {
      activeLeafMessageId: update.chat.activeLeafMessageId,
      createdAt: iso(update.chat.createdAt),
      defaultModelId: update.chat.defaultModelId,
      defaultPromptPresetId: update.chat.defaultPromptPresetId,
      defaultProvider: update.chat.defaultProvider,
      folderId: update.chat.folderId,
      id: update.chat.id,
      messageCount: update.chat.messageCount,
      pinned: update.chat.pinned,
      title: update.chat.title,
      updatedAt: iso(update.chat.updatedAt),
      usageStats: update.chat.usageStats ?? null
    },
    messages: update.messages.map((message) => ({
      artifactSummary: message.artifactSummary ?? null,
      content:
        liveGroundedAnswer && message.id === liveGroundedAnswer.assistantMessageId
          ? textMessageContent(liveGroundedAnswer.finalText)
          : message.content,
      createdAt: iso(message.createdAt),
      errorMessage: message.errorMessage ?? null,
      id: message.id,
      modelId: message.modelId,
      modelRunId: message.modelRunId ?? null,
      parentMessageId: message.parentMessageId,
      provider: message.provider,
      role: message.role,
      runUsage: message.runUsage ?? null,
      status: message.status
    }))
  } satisfies ChatUpdateDataWire;
}

async function emit(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  repository: RunExecutionRepository,
  runId: string,
  sequence: RunEventSequence,
  event: ModelRunSseEvent
): Promise<void> {
  await appendRunEventWithRetry(repository, runId, sequence, event);

  try {
    controller.enqueue(encoder.encode(encodeSseEvent(event)));
  } catch {
    // Keep provider execution and durable persistence alive after a response
    // consumer disconnects. Task 102 owns any future configurable abort policy.
  }
}

function emitTransient(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: ModelRunSseEvent
): void {
  try {
    controller.enqueue(encoder.encode(encodeSseEvent(event)));
  } catch {
    // The client may already have disconnected.
  }
}

function createTokenPersistenceBuffer(input: Readonly<{
  assistantMessageId: string;
  repository: RunExecutionRepository;
  runId: string;
  sequence: RunEventSequence;
}>) {
  let assistantText = "";
  let pendingDelta = "";
  let pendingTokenCount = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain = Promise.resolve();
  let flushError: unknown = null;
  let persistenceDisabled = false;

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  async function persistPending(): Promise<void> {
    clearFlushTimer();
    if (persistenceDisabled) {
      pendingDelta = "";
      pendingTokenCount = 0;
      return;
    }
    if (!pendingDelta) {
      return;
    }

    const delta = pendingDelta;
    const text = assistantText;
    pendingDelta = "";
    pendingTokenCount = 0;

    await input.repository.appendAssistantText(input.assistantMessageId, text);
    await appendRunEventWithRetry(input.repository, input.runId, input.sequence, {
      data: {
        delta
      },
      type: "token"
    });
  }

  function flush(): Promise<void> {
    if (flushError) {
      return Promise.reject(flushError);
    }

    flushChain = flushChain.then(persistPending, persistPending);
    return flushChain.catch((error: unknown) => {
      flushError = error;
      throw error;
    });
  }

  function scheduleFlush(): void {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch((error: unknown) => {
        flushError = error;
      });
    }, tokenPersistenceFlushIntervalMs);
  }

  return {
    async disablePersistence(): Promise<void> {
      persistenceDisabled = true;
      clearFlushTimer();
      assistantText = "";
      pendingDelta = "";
      pendingTokenCount = 0;
      // Wait until a previously-started flush settles before the repository
      // replaces the message and purges durable provider events. Preserve the
      // original flush error for the normal pipeline failure path, but do not
      // let it bypass the live-only persistence fence.
      await flushChain.catch(() => undefined);
    },
    flush,
    push(delta: string): Promise<void> {
      if (flushError) {
        return Promise.reject(flushError);
      }

      if (persistenceDisabled) {
        return Promise.resolve();
      }

      assistantText += delta;
      pendingDelta += delta;
      pendingTokenCount += 1;

      if (pendingTokenCount >= tokenPersistenceMaxTokens) {
        return flush();
      }

      scheduleFlush();
      return Promise.resolve();
    },
    resetLocal(): void {
      clearFlushTimer();
      assistantText = "";
      pendingDelta = "";
      pendingTokenCount = 0;
    },
    throwIfFailed(): void {
      if (flushError) {
        throw flushError;
      }
    }
  };
}

function providerResponseIdFromEvent(event: ModelRunSseEvent): string | null {
  if (event.type !== "artifact" || event.data.artifactType !== "summary") {
    return null;
  }

  const payload = isRecord(event.data.payload) ? event.data.payload : {};
  return typeof payload.responseId === "string" && payload.responseId.trim() ? payload.responseId : null;
}

function abortError(): Error {
  const error = new Error("provider_run_aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "provider_run_aborted");
}

class RunPipelineError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function zeroUsage(): ModelRunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
}

function groupedUsageAttributions(attributions: readonly RunUsageAttribution[]): RunUsageAttribution[] {
  const grouped = new Map<string, RunUsageAttribution & { usages: ModelRunUsage[] }>();

  for (const attribution of attributions) {
    const key = `${attribution.provider}\u0000${attribution.modelId}`;
    const current = grouped.get(key);
    if (current) {
      current.usages.push(attribution.usage);
      continue;
    }

    grouped.set(key, {
      modelId: attribution.modelId,
      provider: attribution.provider,
      usage: attribution.usage,
      usages: [attribution.usage]
    });
  }

  return [...grouped.values()].map(({ usages, ...attribution }) => ({
    ...attribution,
    usage: sumTokenUsage(usages)
  }));
}

function hasReportedUsage(usage: ModelRunUsage | undefined): usage is ModelRunUsage {
  if (!usage) {
    return false;
  }

  const normalized = sumTokenUsage([usage]);
  return (
    normalized.cachedInputTokens > 0 ||
    normalized.cacheWriteInputTokens > 0 ||
    normalized.inputTokens > 0 ||
    normalized.outputTokens > 0 ||
    normalized.reasoningTokens > 0 ||
    normalized.totalTokens > 0
  );
}

function toolExecutionErrorResult(
  call: ModelToolCall,
  error: unknown,
  label: "Search" | "Tool" = "Tool"
): ToolExecutionResult {
  const message = error instanceof Error ? error.message : `${label} execution failed`;

  return {
    callId: call.id,
    content: [
      {
        text: `${label} failed: ${message}`,
        type: "text"
      }
    ],
    name: call.name,
    rawPreview: {
      finalProviderResponsePreview: {
        error: message
      },
      requestPreview: {
        toolCall: {
          arguments: call.arguments,
          id: call.id,
          name: call.name
        }
      }
    },
    status: "error",
    usage: zeroUsage()
  };
}

function toolLoopJson(value: unknown, maxBytes: number, code: string): ToolLoopJsonValue {
  const snapshot = snapshotToolLoopJson(value, maxBytes);
  if (snapshot === null) throw new RunPipelineError(code, "Tool-loop state is invalid or too large");
  return snapshot;
}

function providerRequestPreviewForToolRound(adapter: ProviderAdapter, request: ProviderRunRequest) {
  const preview = adapter.buildRequestPreview(request);
  const truncation = request.context?.summary?.truncation;

  return truncation
    ? {
        ...preview,
        contextTruncation: truncation
      }
    : preview;
}

function recordFromPreview(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function persistToolSearchRun(input: Readonly<{
  call: ModelToolCall;
  modelRunId: string;
  repository: RunExecutionRepository;
  result: ToolExecutionResult;
  searchModelId: string;
  strategyId: string;
}>): Promise<void> {
  const preview = input.result.rawPreview ?? {};
  if (preview.providerCall === false) return;
  await input.repository.createSearchRun({
    artifacts: {
      events: input.result.artifacts?.map((artifact) => artifact.data) ?? [],
      finalProviderResponsePreview: recordFromPreview(preview.finalProviderResponsePreview),
      providerResponseId: typeof preview.providerResponseId === "string" ? preview.providerResponseId : undefined,
      toolCall: {
        arguments: input.call.arguments,
        id: input.call.id,
        name: input.call.name
      },
      usage: input.result.usage
    },
    modelId: input.searchModelId,
    modelRunId: input.modelRunId,
    provider: "openrouter",
    requestPreview: recordFromPreview(preview.requestPreview),
    status: input.result.status === "complete" ? "complete" : "error",
    strategyId: input.strategyId
  });
}

async function persistPlanSearchExecution(input: Readonly<{
  execution: SearchExecutionEvidence;
  modelRunId: string;
  repository: RunExecutionRepository;
}>): Promise<void> {
  await input.repository.createSearchRun({
    artifacts: {
      displayName: input.execution.displayName,
      invocationId: input.execution.invocationId,
      ...(input.execution.providerOperations
        ? { providerOperations: input.execution.providerOperations }
        : {}),
      providerOperationsTruncated: input.execution.providerOperationsTruncated,
      sources: input.execution.sources,
      usage: input.execution.usage,
      ...(input.execution.warning ? { warning: input.execution.warning } : {})
    },
    durationMs: input.execution.durationMs,
    invocationId: input.execution.invocationId,
    modelId: input.execution.modelId,
    modelRunId: input.modelRunId,
    provider: input.execution.provider,
    query: input.execution.query,
    requestPreview: { ...input.execution.requestPreview },
    searchRevisionId: input.execution.revisionId,
    status: input.execution.status,
    strategyId: input.execution.optionId
  });
}

export function createRunExecutionResponse(input: RunExecutionInput): Response {
  const encoder = new TextEncoder();
  const sequence: RunEventSequence = { value: 0 };
  const abortController = new AbortController();
  const runId = input.created.runId;
  const normalizedRequest = input.prepared.normalizedRequest;
  activeRunControllers.set(runId, abortController);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const signal = abortController.signal;
      const tokenBuffer = createTokenPersistenceBuffer({
        assistantMessageId: input.created.assistantMessageId,
        repository: input.repository,
        runId,
        sequence
      });
      let persistedProviderResponseId: string | null = null;
      let groundedLiveOnly = false;
      const reportedUsageAttributions: RunUsageAttribution[] = [];

      function rememberReportedUsage(provider: string, modelId: string, usage: ModelRunUsage): void {
        if (!hasReportedUsage(usage)) {
          return;
        }

        reportedUsageAttributions.push({
          modelId,
          provider,
          usage
        });
      }

      async function persistReportedUsageForIncompleteRun(): Promise<void> {
        const grouped = groupedUsageAttributions(reportedUsageAttributions);
        if (grouped.length === 0) {
          return;
        }

        const usageAttributions = await usageAttributionsWithEstimatedCost(input.repository, grouped);
        await input.repository.recordRunUsageEvents({
          chatId: normalizedRequest.chatId,
          runId,
          usageAttributions,
          userId: input.userId
        });
      }

      async function applyProviderEvent(
        event: ModelRunSseEvent,
        options: Readonly<{ includeTokenEvents?: boolean }> = {}
      ): Promise<void> {
        const includeTokenEvents = options.includeTokenEvents ?? true;
        const effectiveEvent = withPinnedHostedSearchIdentity(event, normalizedRequest);

        if (isGroundingDisplaySseEvent(effectiveEvent)) {
          if (!groundedLiveOnly) {
            groundedLiveOnly = true;
            await tokenBuffer.disablePersistence();
            const marked = await input.repository.markAssistantMessageGroundedLiveOnly({
              assistantMessageId: input.created.assistantMessageId,
              groundedAt: new Date(),
              provider: normalizedRequest.provider,
              runId,
              strategy: normalizedRequest.searchStrategy ?? "provider-grounding"
            });
            if (!marked) {
              throw new RunPipelineError(
                "grounding_persistence_fence_failed",
                "Grounded answer could not enter live-only mode"
              );
            }
          }
          emitTransient(controller, encoder, effectiveEvent);
          return;
        }

        if (effectiveEvent.type === "token") {
          if (!includeTokenEvents) {
            return;
          }

          if (!groundedLiveOnly) {
            await tokenBuffer.push(effectiveEvent.data.delta);
          }
          emitTransient(controller, encoder, effectiveEvent);
          return;
        }

        if (groundedLiveOnly) {
          const eventProviderResponseId = providerResponseIdFromEvent(effectiveEvent);
          if (eventProviderResponseId) await publishProviderResponseId(eventProviderResponseId);
          emitTransient(controller, encoder, effectiveEvent);
          return;
        }

        await tokenBuffer.flush();
        const eventProviderResponseId = providerResponseIdFromEvent(effectiveEvent);
        if (eventProviderResponseId) await publishProviderResponseId(eventProviderResponseId);

        await emit(controller, encoder, input.repository, runId, sequence, effectiveEvent);
      }

      async function publishProviderResponseId(providerResponseId: string): Promise<void> {
        if (providerResponseId === persistedProviderResponseId) return;
        const publication = await input.repository.updateRunProviderResponseId(runId, providerResponseId);
        persistedProviderResponseId = providerResponseId;
        if (publication === "cancelled") {
          await input.adapter.cancel?.(providerResponseId).catch(() => undefined);
          throw abortError();
        }
        if (publication === "terminal") throw abortError();
      }

      async function streamProviderRequest(request: ProviderRunRequest): Promise<ProviderRunResult> {
        const providerStream = input.adapter.stream(request, { signal });
        let lastReportedUsage: ModelRunUsage | null = null;

        try {
          let next = await providerStream.next();

          while (!next.done) {
            tokenBuffer.throwIfFailed();
            throwIfAborted(signal);
            if (next.value.type === "usage") {
              lastReportedUsage = next.value.data;
              next = await providerStream.next();
              continue;
            }
            await applyProviderEvent(next.value);
            next = await providerStream.next();
          }

          rememberReportedUsage(request.provider, request.modelId, next.value.usage);
          return next.value;
        } catch (error) {
          if (lastReportedUsage) {
            rememberReportedUsage(request.provider, request.modelId, lastReportedUsage);
          }
          throw error;
        }
      }

      async function runProviderToolLoop(
        request: ProviderRunRequest
      ): Promise<ProviderRunResult & { usageAttributions: RunUsageAttribution[] }> {
        const provider = normalizedRequest.provider;
        const toolBridge = input.toolBridge ??
          providerToolBridges[provider as keyof typeof providerToolBridges];
        if (!toolBridge?.supportsToolCalling({ modelId: normalizedRequest.modelId, provider })) {
          throw new RunPipelineError(
            "tool_calling_not_supported",
            `Tool calling is not supported by provider ${provider}`
          );
        }

        const searchPolicy = normalizedRequest.searchPolicy;
        const searchEnabled = !normalizedRequest.searchPlan &&
          normalizedRequest.searchStrategy === "perplexity-tool-search";
        if (searchEnabled && (!input.searchAdapter || !searchPolicy ||
          searchPolicy.strategyId !== normalizedRequest.searchStrategy)) {
          throw new RunPipelineError("search_policy_not_available", "Search policy is not available");
        }
        const searchExecutor = searchEnabled
          ? createPerplexitySearchToolExecutor({
              searchAdapter: input.searchAdapter!,
              searchPolicy: searchPolicy!
            })
          : null;
        const searchPlanRouter = normalizedRequest.searchPlan
          ? createSearchPlanToolRouter({
              plan: normalizedRequest.searchPlan,
              runtimes: input.searchRuntimes ?? {}
            })
          : null;
        const isSearchCall = (name: string) =>
          (searchExecutor !== null && name === searchExecutor.tool.name) ||
          searchPlanRouter?.accepts(name) === true;
        const tools: RunTool[] = [
          ...(searchPlanRouter?.tools ?? (searchExecutor ? [perplexityWebSearchTool] : [])),
          ...mcpRunTools(normalizedRequest.mcp)
        ];
        if (tools.length === 0) {
          throw new RunPipelineError("tool_configuration_empty", "No run tools are configured");
        }

        const persistedCalls = new Map<string, PersistedToolLoopCall>();
        const toolDurations = new Map<string, number>();
        const hasMcpTools = tools.some((tool) => tool.capability === "mcp");
        let mcpRuntime = input.mcpRuntime ?? null;
        const runtime = () => {
          mcpRuntime ??= getDefaultMcpRuntimeCoordinator();
          return mcpRuntime;
        };
        const outcome = await continueProviderToolLoop({
          adapter: input.adapter,
          afterToolBatch: async ({ round }) => {
            const advanced = await input.repository.advanceToolLoopCallBatch({
              roundIndex: round,
              runId,
              userId: input.userId
            });
            if (advanced === "cancelled") throw abortError();
            if (advanced !== "advanced") {
              throw new RunPipelineError("tool_loop_checkpoint_conflict", "Tool batch could not advance");
            }
          },
          onToolBatchSettled: async ({ results, round }) => {
            for (const settled of results) {
              const call = modelToolCall(settled.call);
              const result = settled.result.status === "complete"
                ? settled.result.value
                : toolExecutionErrorResult(call, new Error(settled.result.error.message));
              if (searchExecutor && call.name === searchExecutor.tool.name) {
                if (hasReportedUsage(result.usage)) {
                  rememberReportedUsage("openrouter", searchPolicy!.modelId, result.usage!);
                }
                await persistToolSearchRun({
                  call,
                  modelRunId: runId,
                  repository: input.repository,
                  result,
                  searchModelId: searchPolicy!.modelId,
                  strategyId: searchPolicy!.strategyId
                });
              } else if (searchPlanRouter?.accepts(call.name)) {
                for (const execution of searchExecutionsFromToolResult(result)) {
                  if (hasReportedUsage(execution.usage)) {
                    rememberReportedUsage(execution.provider, execution.modelId ?? "search", execution.usage);
                  }
                  await persistPlanSearchExecution({
                    execution,
                    modelRunId: runId,
                    repository: input.repository
                  });
                }
              }
              for (const artifact of result.artifacts ?? []) {
                await emit(controller, encoder, input.repository, runId, sequence, artifact);
              }
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                sequence,
                toolResultInspectionArtifact({
                  call,
                  durationMs: toolDurations.get(call.id) ??
                    persistedToolDurationMs(persistedCalls.get(call.id)),
                  mcp: normalizedRequest.mcp,
                  ordinal: settled.ordinal,
                  result,
                  round
                })
              );
            }
            await persistReportedUsageForIncompleteRun();
          },
          beforeProviderRound: async ({ continuation, request: roundRequest, round }) => {
            if (round === 1) {
              const started = await input.repository.beginToolLoopProviderRound({
                providerContinuation: toolLoopJson(
                  continuation,
                  toolLoopPersistenceLimits.checkpointBytes,
                  "tool_loop_checkpoint_invalid"
                ),
                roundIndex: round,
                runId,
                userId: input.userId
              });
              if (started === "cancelled") throw abortError();
              if (started !== "started" && started !== "reused") {
                throw new RunPipelineError("tool_loop_checkpoint_conflict", "Provider round could not start");
              }
            }
            await input.repository.updateRunProviderRequestPreview(
              runId,
              providerRequestPreviewForToolRound(input.adapter, roundRequest)
            );
            if (hasMcpTools) {
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                sequence,
                toolLoopPhaseArtifact({ phase: "model", round })
              );
            }
          },
          bridge: toolBridge,
          budgets: {
            maxConcurrency: 4,
            maxToolCalls: 16,
            maxToolRounds
          },
          executeTool: async (call, context) => {
            const startedAt = Date.now();
            try {
              const persisted = persistedCalls.get(call.id);
              if (!persisted) {
                return {
                  error: {
                    code: "tool_call_not_persisted",
                    fatal: true,
                    message: "Tool call was not durably persisted before dispatch."
                  },
                  status: "error"
                };
              }
              const claim = await input.repository.claimToolLoopCall({
                callId: persisted.id,
                runId,
                userId: input.userId
              });
              if (claim.kind === "ambiguous") {
                return {
                  error: {
                    code: "tool_call_outcome_unknown",
                    fatal: true,
                    message: "The tool call may have completed before the process stopped and was not repeated."
                  },
                  status: "error"
                };
              }
              if (claim.kind === "cancelled") {
                return {
                  error: { code: "tool_call_cancelled", fatal: true, message: "Tool call was cancelled." },
                  status: "error"
                };
              }
              if (claim.kind === "not_found") {
                return {
                  error: { code: "tool_call_not_found", fatal: true, message: "Persisted tool call was not found." },
                  status: "error"
                };
              }
              if (claim.kind === "settled") {
                const stored = parsePersistedToolExecutionResult(call, claim.call.result);
                const persistedDuration = persistedToolDurationMs(claim.call);
                if (persistedDuration !== undefined) toolDurations.set(call.id, persistedDuration);
                return stored
                  ? { status: "complete", value: stored }
                  : {
                      error: {
                        code: "tool_call_result_invalid",
                        fatal: true,
                        message: "Persisted tool result is invalid."
                      },
                      status: "error"
                    };
              }

              let result: ToolExecutionResult;
              try {
                if (hasInvalidProviderToolArguments(call.arguments)) {
                  throw new Error("provider_tool_arguments_invalid");
                }
                if (searchPlanRouter?.accepts(call.name)) {
                  result = await searchPlanRouter.execute(call, request, { signal: context.signal });
                } else if (searchExecutor && call.name === searchExecutor.tool.name) {
                  result = await searchExecutor.execute(call, { request, runId }, { signal: context.signal });
                } else {
                  const route = resolveMcpRunTool(normalizedRequest.mcp, call.name);
                  const generationId = claim.call.mcpBinding?.runtimeGenerationId;
                  if (!route || !generationId ||
                    claim.call.mcpBinding?.runtimeGenerationFingerprint !== route.fingerprint) {
                    throw new Error("mcp_run_binding_unavailable");
                  }
                  const activeRuntime = runtime();
                  if (!(await activeRuntime.ensureAcceptedGeneration(generationId))) {
                    throw new Error("mcp_runtime_not_ready");
                  }
                  result = mcpToolExecutionResult(call, await activeRuntime.callTool({
                    arguments: call.arguments,
                    generationId,
                    inputSchema: route.tool.inputSchema,
                    name: route.originalName,
                    signal: context.signal
                  }));
                }
              } catch (error) {
                if (signal.aborted || isAbortError(error)) throw error;
                result = toolExecutionErrorResult(
                  call,
                  error,
                  isSearchCall(call.name) ? "Search" : "Tool"
                );
              }
              const storedResult = snapshotToolExecutionResult(
                result,
                toolLoopPersistenceLimits.resultBytes
              );
              if (storedResult === null) {
                throw new RunPipelineError(
                  "tool_call_result_invalid",
                  "Tool result is invalid or too large"
                );
              }
              const settled = await input.repository.settleToolLoopCall({
                callId: claim.call.id,
                result: storedResult,
                runId,
                state: result.status,
                userId: input.userId
              });
              if (settled !== "settled" && settled !== "reused") {
                return {
                  error: {
                    code: "tool_call_settle_conflict",
                    fatal: true,
                    message: "Tool result could not be durably settled."
                  },
                  status: "error"
                };
              }
              return { status: "complete", value: result };
            } finally {
              if (!toolDurations.has(call.id)) {
                toolDurations.set(call.id, Date.now() - startedAt);
              }
            }
          },
          initialRequest: request,
          onEvent: applyProviderEvent,
          onProviderResult: async ({ result }) => {
            if (result.providerResponseId) await publishProviderResponseId(result.providerResponseId);
          },
          onSignal: async (toolSignal) => {
            if (toolSignal.type === "text_delta") {
              await applyProviderEvent({ data: { delta: toolSignal.delta }, type: "token" });
              return;
            }
            await tokenBuffer.flush();
            const reset = await input.repository.resetToolLoopAssistantDraft({
              roundIndex: toolSignal.round,
              runId,
              sequence: sequence.value,
              userId: input.userId
            });
            if (!reset) throw new RunPipelineError("tool_loop_reset_conflict", "Assistant draft could not reset");
            sequence.value += 1;
            tokenBuffer.resetLocal();
            emitTransient(controller, encoder, {
              data: { round: toolSignal.round },
              type: "message_reset"
            });
          },
          onUsage: async (usage, roundRequest) => {
            rememberReportedUsage(roundRequest.provider, roundRequest.modelId, usage);
            await persistReportedUsageForIncompleteRun();
          },
          parallelToolCalls: normalizedRequest.modelCapabilities.parallelToolCalls === true,
          persistToolBatch: async ({ calls, continuation, round }) => {
            const persisted = await input.repository.persistToolLoopCallBatch({
              calls: calls.map((call, ordinal) => {
                const route = resolveMcpRunTool(normalizedRequest.mcp, call.name);
                if (!route && !isSearchCall(call.name)) {
                  throw new RunPipelineError("unsupported_tool_call", `Unsupported tool ${call.name}`);
                }
                return {
                  arguments: toolLoopJson(
                    call.arguments,
                    toolLoopPersistenceLimits.argumentsBytes,
                    "tool_call_arguments_invalid"
                  ) as Readonly<Record<string, ToolLoopJsonValue>>,
                  ordinal,
                  providerCallId: call.id,
                  ...(route ? { runtimeGenerationFingerprint: route.fingerprint } : {}),
                  toolName: call.name
                };
              }),
              providerContinuation: toolLoopJson(
                continuation,
                toolLoopPersistenceLimits.checkpointBytes,
                "tool_loop_checkpoint_invalid"
              ),
              roundIndex: round,
              runId,
              userId: input.userId
            });
            if (persisted.kind === "cancelled") throw abortError();
            if (persisted.kind !== "persisted" && persisted.kind !== "reused") {
              throw new RunPipelineError("tool_loop_checkpoint_conflict", "Tool batch could not persist");
            }
            for (const call of persisted.calls) persistedCalls.set(call.providerCallId, call);
            await tokenBuffer.flush();
            if (hasMcpTools) {
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                sequence,
                toolLoopPhaseArtifact({ count: calls.length, phase: "tools", round })
              );
            }
            for (const [ordinal, call] of calls.entries()) {
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                sequence,
                toolCallInspectionArtifact({
                  call: modelToolCall(call),
                  mcp: normalizedRequest.mcp,
                  ordinal,
                  round
                })
              );
            }
          },
          prepareRequest: async (roundRequest) => {
            const budgeted = applyProviderRequestContextBudget({
              bridge: toolBridge,
              request: roundRequest
            });
            if (!budgeted.ok) {
              throw new RunPipelineError("context_too_large", budgeted.error.message);
            }
            if (budgeted.contextTruncation) {
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                sequence,
                contextTruncationArtifact(budgeted.contextTruncation)
              );
            }
            return budgeted.request;
          },
          signal,
          tools
        });

        if (outcome.status === "cancelled") throw abortError();
        if (outcome.status === "failed") {
          throw new RunPipelineError(
            outcome.failure.code === "provider_round_failed"
              ? "provider_stream_failed"
              : outcome.failure.code,
            outcome.failure.message
          );
        }
        return {
          ...outcome.final,
          usage: sumTokenUsage(reportedUsageAttributions.map((attribution) => attribution.usage)),
          usageAttributions: groupedUsageAttributions(reportedUsageAttributions)
        };
      }

      try {
        throwIfAborted(signal);
        await emit(controller, encoder, input.repository, runId, sequence, {
          data: {
            modelId: normalizedRequest.modelId,
            provider: normalizedRequest.provider,
            runId,
            status: "streaming"
          },
          type: "run_start"
        });
        await emit(controller, encoder, input.repository, runId, sequence, {
          data: {
            assistantMessageId: input.created.assistantMessageId,
            userMessageId: input.created.userMessageId
          },
          type: "message_start"
        });
        if (input.prepared.contextTruncation) {
          await emit(
            controller,
            encoder,
            input.repository,
            runId,
            sequence,
            contextTruncationArtifact(input.prepared.contextTruncation)
          );
        }

        // A provider admission plan was revalidated and bound atomically with
        // the run. Later ordinary RBAC/config changes affect future runs only.
        // The legacy injected test path retains its pre-dispatch guard.
        if (!input.prepared.providerAdmissionPlan) {
          const selectedSearchStrategy = normalizedRequest.searchStrategy ?? "search-disabled";
          const [entitlements, modelConfiguration, searchStrategyEnabled] = await Promise.all([
            input.repository.loadEntitlements(input.userId),
            input.repository.loadModelConfiguration(normalizedRequest.provider, normalizedRequest.modelId),
            input.repository.isSearchStrategyEnabled(selectedSearchStrategy)
          ]);
          const dispatchAccess = validateRunAccess(entitlements, {
            modelId: normalizedRequest.modelId,
            provider: normalizedRequest.provider,
            searchStrategy: selectedSearchStrategy
          });
          if (!dispatchAccess.ok) {
            throw new RunPipelineError(
              dispatchAccess.code,
              dispatchAccess.code === "model_not_available"
                ? "The selected model is no longer available"
                : "The selected search strategy is no longer available"
            );
          }
          if (!modelConfiguration) {
            throw new RunPipelineError(
              "model_not_available",
              "The selected model is no longer available"
            );
          }
          if (!searchStrategyEnabled) {
            throw new RunPipelineError(
              "search_strategy_not_available",
              "The selected search strategy is no longer available"
            );
          }
        }

        const hasClientSearch = (normalizedRequest.searchPlan?.options.some((option) =>
          option.adapterKind === "provider_model_client") ?? false) ||
          (!normalizedRequest.searchPlan && normalizedRequest.searchStrategy === "perplexity-tool-search");
        const hasClientTools = hasClientSearch ||
          (normalizedRequest.mcp?.tools.length ?? 0) > 0;
        const providerResult = hasClientTools
          ? await runProviderToolLoop(input.prepared.providerRequest)
          : await streamProviderRequest(input.prepared.providerRequest);

        await tokenBuffer.flush();
        throwIfAborted(signal);
        const persistedProviderResult = groundedLiveOnly
          ? {
              ...providerResult,
              finalProviderResponsePreview: groundedLiveOnlyProviderPreview(),
              finalText: GROUNDED_LIVE_ONLY_PLACEHOLDER
            }
          : providerResult;
        const finalization = await finalizeRunCompletion({
          repository: input.repository,
          result: persistedProviderResult,
          run: {
            assistantMessageId: input.created.assistantMessageId,
            chatId: normalizedRequest.chatId,
            modelId: normalizedRequest.modelId,
            provider: normalizedRequest.provider,
            runId,
            userId: input.userId
          }
        });
        if (finalization.status === "not_completed") {
          await persistReportedUsageForIncompleteRun().catch(() => undefined);
          return;
        }

        emitTransient(controller, encoder, {
          data: finalization.usage,
          type: "usage"
        });
        try {
          const chatUpdate = await input.repository.getChatUpdateForRun({
            assistantMessageId: input.created.assistantMessageId,
            chatId: normalizedRequest.chatId,
            userId: input.userId,
            userMessageId: input.created.userMessageId
          });
          if (chatUpdate) {
            emitTransient(controller, encoder, {
              data: serializeChatUpdate(
                chatUpdate,
                groundedLiveOnly
                  ? {
                      assistantMessageId: input.created.assistantMessageId,
                      finalText: providerResult.finalText
                    }
                  : undefined
              ),
              type: "chat_update"
            });
          }
        } catch {
          // The browser falls back to lazy chat detail fetch when this transient sync is absent.
        }
        emitTransient(controller, encoder, {
          data: {
            runId,
            status: "complete"
          },
          type: "done"
        });
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
          await input.repository.cancelPendingToolLoopCalls({ runId, userId: input.userId }).catch(() => undefined);
          await tokenBuffer.flush().catch(() => undefined);
          await persistReportedUsageForIncompleteRun().catch(() => undefined);
          return;
        }

        let failure = error;
        try {
          await tokenBuffer.flush();
        } catch (flushError) {
          failure = flushError;
        }

        const timedOut = isProviderTimeoutError(failure);
        const pipelineError = failure instanceof RunPipelineError ? failure : null;
        const payload = {
          code: pipelineError?.code ?? (timedOut ? "provider_stream_timeout" : "provider_stream_failed"),
          message: failure instanceof Error ? failure.message : "Provider stream failed"
        };
        const failed = await input.repository.failRun(runId, input.created.assistantMessageId, payload);
        await persistReportedUsageForIncompleteRun().catch(() => undefined);
        if (failed) {
          emitTransient(controller, encoder, {
            data: payload,
            type: "error"
          });
        }
      } finally {
        if (activeRunControllers.get(runId) === abortController) {
          activeRunControllers.delete(runId);
        }

        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream"
    }
  });
}
