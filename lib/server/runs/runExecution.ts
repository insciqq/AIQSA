import type { ChatUpdateDataWire } from "../../contracts/chats";
import { estimateApproxTokens, type ContextTruncationSummary } from "../../domain/contextBudget";
import {
  encodeSseEvent,
  type ModelRunChatUpdateData,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import { sumTokenUsage } from "../../domain/usage";
import { validateRunAccess } from "../auth/entitlements";
import { isProviderTimeoutError } from "../providers/network";
import { providerAttachmentBudgetTokens } from "../providers/attachmentPayload";
import type {
  ProviderAdapter,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter
} from "../providers/types";
import { providerToolBridges } from "../tools/bridges";
import { createPerplexitySearchToolExecutor, perplexityWebSearchTool } from "../tools/perplexitySearch";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { applyRunContextBudget } from "./runContextBudget";
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
  }
});

export function activeRunControllersForTest(): Map<string, AbortController> {
  return activeRunControllers;
}

export type RunExecutionRepository = Pick<
  RunRepository,
  | "appendAssistantText"
  | "appendRunEvent"
  | "completeRun"
  | "createSearchRun"
  | "failRun"
  | "getChatUpdateForRun"
  | "isSearchStrategyEnabled"
  | "loadEntitlements"
  | "loadModelConfiguration"
  | "loadModelPricing"
  | "nextRunEventSequence"
  | "recordRunUsageEvents"
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
  searchAdapter?: ProviderSearchAdapter;
  userId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function serializeChatUpdate(update: RunChatUpdateRecord): ModelRunChatUpdateData {
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
      content: message.content,
      createdAt: iso(message.createdAt),
      errorMessage: message.errorMessage ?? null,
      id: message.id,
      modelId: message.modelId,
      modelRunId: message.modelRunId ?? null,
      parentMessageId: message.parentMessageId,
      provider: message.provider,
      role: message.role,
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

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  async function persistPending(): Promise<void> {
    clearFlushTimer();
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
    flush,
    push(delta: string): Promise<void> {
      if (flushError) {
        return Promise.reject(flushError);
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

async function collectProviderRun(input: Readonly<{
  adapter: ProviderAdapter;
  observeEvent?: (event: ModelRunSseEvent) => void;
  request: ProviderRunRequest;
  signal: AbortSignal;
}>): Promise<{ events: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const providerStream = input.adapter.stream(input.request, { signal: input.signal });
  const events: ModelRunSseEvent[] = [];

  let next = await providerStream.next();
  while (!next.done) {
    throwIfAborted(input.signal);
    input.observeEvent?.(next.value);
    if (next.value.type !== "usage") {
      events.push(next.value);
    }
    next = await providerStream.next();
  }

  return {
    events,
    result: next.value
  };
}

function fallbackProviderToolCallMessages(provider: string, calls: ModelToolCall[]): unknown[] {
  if (provider === "openai") {
    return calls.map((call) =>
      isRecord(call.raw)
        ? call.raw
        : {
            arguments: JSON.stringify(call.arguments),
            call_id: call.id,
            name: call.name,
            status: "completed",
            type: "function_call"
          }
    );
  }

  return [
    {
      content: null,
      role: "assistant",
      tool_calls: calls.map((call) =>
        isRecord(call.raw)
          ? call.raw
          : {
              function: {
                arguments: JSON.stringify(call.arguments),
                name: call.name
              },
              id: call.id,
              type: "function"
            }
      )
    }
  ];
}

function providerToolCallMessages(provider: string, result: ProviderRunResult, calls: ModelToolCall[]): unknown[] {
  const providerMessage = result.providerToolCallMessage;
  if (Array.isArray(providerMessage)) {
    return [...providerMessage];
  }

  if (providerMessage !== undefined) {
    return [providerMessage];
  }

  return fallbackProviderToolCallMessages(provider, calls);
}

function toolCallArtifact(input: Readonly<{ call: ModelToolCall; round: number }>): ModelRunSseEvent {
  return {
    data: {
      artifactType: "tool_call",
      payload: {
        arguments: input.call.arguments,
        name: input.call.name,
        round: input.round,
        status: "requested"
      }
    },
    type: "artifact"
  };
}

function toolResultArtifact(
  input: Readonly<{ call: ModelToolCall; result: ToolExecutionResult; round: number }>
): ModelRunSseEvent {
  return {
    data: {
      artifactType: "tool_result",
      payload: {
        name: input.call.name,
        round: input.round,
        status: input.result.status
      }
    },
    type: "artifact"
  };
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

function toolExecutionErrorResult(call: ModelToolCall, error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : "Search tool failed";

  return {
    artifacts: [
      {
        data: {
          artifactType: "tool_result",
          payload: {
            message,
            name: call.name,
            status: "error"
          }
        },
        type: "artifact"
      }
    ],
    callId: call.id,
    content: [
      {
        text: `Search failed: ${message}`,
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

function cumulativeTruncationSummary(
  previous: ContextTruncationSummary | undefined,
  current: ContextTruncationSummary
): ContextTruncationSummary {
  if (!previous) {
    return current;
  }

  return {
    ...current,
    approxDroppedTokens: previous.approxDroppedTokens + current.approxDroppedTokens,
    approxOriginalTokens: previous.approxDroppedTokens + current.approxOriginalTokens,
    droppedMessages: previous.droppedMessages + current.droppedMessages
  };
}

function applyToolRoundContextBudget(request: ProviderRunRequest): Readonly<{
  contextTruncation: ContextTruncationSummary | null;
  request: ProviderRunRequest;
}> {
  const contextMessages = request.context?.messages ?? [];
  if (contextMessages.length === 0) {
    return {
      contextTruncation: null,
      request
    };
  }

  const currentMessageId = contextMessages[contextMessages.length - 1]?.id;
  const attachmentTokens = providerAttachmentBudgetTokens({
    attachments: request.attachments,
    modelCapabilities: request.modelCapabilities
  });
  const toolMessagesTokens = estimateApproxTokens(request.providerToolMessages ?? []);
  const currentMessageExtraTokens = attachmentTokens + toolMessagesTokens;
  const budget = applyRunContextBudget({
    contextMessages,
    messageExtraTokens:
      currentMessageId && currentMessageExtraTokens > 0
        ? { [currentMessageId]: currentMessageExtraTokens }
        : undefined,
    modelCapabilities: request.modelCapabilities,
    params: request.params,
    prompt: request.prompt,
    provider: request.provider
  });

  if (!budget.ok) {
    throw new RunPipelineError("context_too_large", budget.error.message);
  }

  const previousTruncation = request.context?.summary?.truncation;
  const contextTruncation = budget.contextTruncation
    ? cumulativeTruncationSummary(previousTruncation, budget.contextTruncation)
    : null;
  const effectiveTruncation = contextTruncation ?? previousTruncation;

  return {
    contextTruncation,
    request: {
      ...request,
      context: {
        ...budget.context,
        ...(effectiveTruncation
          ? {
              summary: {
                truncation: effectiveTruncation
              }
            }
          : {})
      }
    }
  };
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

        if (event.type === "token") {
          if (!includeTokenEvents) {
            return;
          }

          await tokenBuffer.push(event.data.delta);
          emitTransient(controller, encoder, event);
          return;
        }

        await tokenBuffer.flush();
        const eventProviderResponseId = providerResponseIdFromEvent(event);
        if (eventProviderResponseId && eventProviderResponseId !== persistedProviderResponseId) {
          const publication = await input.repository.updateRunProviderResponseId(runId, eventProviderResponseId);
          persistedProviderResponseId = eventProviderResponseId;
          if (publication === "cancelled") {
            await input.adapter.cancel?.(eventProviderResponseId).catch(() => undefined);
            throw abortError();
          }
          if (publication === "terminal") {
            throw abortError();
          }
        }

        await emit(controller, encoder, input.repository, runId, sequence, event);
      }

      async function applyProviderEvents(
        events: readonly ModelRunSseEvent[],
        options: Readonly<{ includeTokenEvents?: boolean }> = {}
      ): Promise<void> {
        for (const event of events) {
          tokenBuffer.throwIfFailed();
          throwIfAborted(signal);
          await applyProviderEvent(event, options);
        }
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
        if (!input.searchAdapter) {
          throw new Error("search_provider_not_available");
        }

        const provider = normalizedRequest.provider;
        const toolBridge =
          provider === "openai" || provider === "openrouter" ? providerToolBridges[provider] : undefined;
        if (!toolBridge?.supportsToolCalling({ modelId: normalizedRequest.modelId, provider })) {
          throw new Error(`tool_calling_not_supported:${provider}`);
        }

        const searchPolicy = normalizedRequest.searchPolicy;
        if (
          !searchPolicy ||
          searchPolicy.strategyId !== normalizedRequest.searchStrategy
        ) {
          throw new Error("search_policy_not_available");
        }
        const strategyId = searchPolicy.strategyId;
        const searchModelId = searchPolicy.modelId;
        const executor = createPerplexitySearchToolExecutor({
          searchAdapter: input.searchAdapter,
          searchPolicy
        });
        let roundRequest: ProviderRunRequest = {
          ...request,
          forceNonStreaming: true,
          providerToolMessages: [],
          toolChoice: "auto",
          tools: [perplexityWebSearchTool]
        };
        let toolExecutions = 0;

        await input.repository.updateRunProviderRequestPreview(
          runId,
          providerRequestPreviewForToolRound(input.adapter, roundRequest)
        );

        for (let round = 1; round <= maxToolRounds + 1; round += 1) {
          if (toolExecutions >= maxToolRounds) {
            roundRequest = {
              ...roundRequest,
              toolChoice: "none"
            };
          }

          let lastReportedUsage: ModelRunUsage | null = null;
          let collected: Awaited<ReturnType<typeof collectProviderRun>>;
          try {
            collected = await collectProviderRun({
              adapter: input.adapter,
              observeEvent(event) {
                if (event.type === "usage") {
                  lastReportedUsage = event.data;
                }
              },
              request: roundRequest,
              signal
            });
          } catch (error) {
            if (lastReportedUsage) {
              rememberReportedUsage(provider, normalizedRequest.modelId, lastReportedUsage);
            }
            throw error;
          }
          const { events, result } = collected;
          rememberReportedUsage(provider, normalizedRequest.modelId, result.usage);
          const toolCalls = result.toolCalls ?? [];

          if (toolCalls.length === 0) {
            await applyProviderEvents(events);
            return {
              ...result,
              usage: sumTokenUsage(reportedUsageAttributions.map((attribution) => attribution.usage)),
              usageAttributions: groupedUsageAttributions(reportedUsageAttributions)
            };
          }

          const supportedCalls = toolCalls.filter((call) => call.name === executor.tool.name);
          if (supportedCalls.length !== toolCalls.length) {
            throw new Error(`unsupported_tool_call:${toolCalls.map((call) => call.name).join(",")}`);
          }

          if (toolExecutions + supportedCalls.length > maxToolRounds) {
            throw new Error("tool_round_limit_exceeded");
          }

          await applyProviderEvents(events, { includeTokenEvents: false });
          const providerToolMessages = providerToolCallMessages(provider, result, supportedCalls);

          for (const call of supportedCalls) {
            await emit(controller, encoder, input.repository, runId, sequence, toolCallArtifact({ call, round }));
            let toolResult: ToolExecutionResult;
            try {
              toolResult = await executor.execute(call, { request: roundRequest, runId }, { signal });
            } catch (error) {
              if (signal.aborted || isAbortError(error)) {
                throw error;
              }

              toolResult = toolExecutionErrorResult(call, error);
            }

            if (hasReportedUsage(toolResult.usage)) {
              rememberReportedUsage("openrouter", searchModelId, toolResult.usage);
            }
            toolExecutions += 1;
            await persistToolSearchRun({
              call,
              modelRunId: runId,
              repository: input.repository,
              result: toolResult,
              searchModelId,
              strategyId
            });

            for (const artifact of toolResult.artifacts ?? []) {
              throwIfAborted(signal);
              await emit(controller, encoder, input.repository, runId, sequence, artifact);
            }
            await emit(
              controller,
              encoder,
              input.repository,
              runId,
              sequence,
              toolResultArtifact({ call, result: toolResult, round })
            );
            providerToolMessages.push(toolBridge.appendToolResult(roundRequest, toolResult));
          }

          const budgetedToolRound = applyToolRoundContextBudget({
            ...roundRequest,
            providerToolMessages: [...(roundRequest.providerToolMessages ?? []), ...providerToolMessages]
          });
          roundRequest = budgetedToolRound.request;
          if (budgetedToolRound.contextTruncation) {
            await emit(
              controller,
              encoder,
              input.repository,
              runId,
              sequence,
              contextTruncationArtifact(budgetedToolRound.contextTruncation)
            );
          }
          await input.repository.updateRunProviderRequestPreview(
            runId,
            providerRequestPreviewForToolRound(input.adapter, roundRequest)
          );
        }

        throw new Error("tool_round_limit_exceeded");
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

        const providerResult =
          (normalizedRequest.provider === "openai" || normalizedRequest.provider === "openrouter") &&
          normalizedRequest.searchStrategy === "perplexity-tool-search"
            ? await runProviderToolLoop(input.prepared.providerRequest)
            : await streamProviderRequest(input.prepared.providerRequest);

        await tokenBuffer.flush();
        throwIfAborted(signal);
        const finalization = await finalizeRunCompletion({
          repository: input.repository,
          result: providerResult,
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
              data: serializeChatUpdate(chatUpdate),
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
