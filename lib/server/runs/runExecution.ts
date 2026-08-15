import type { ChatUpdateDataWire } from "../../contracts/chats";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import { textMessageContent } from "../../domain/content";
import {
  GROUNDED_LIVE_ONLY_PLACEHOLDER
} from "../../domain/grounding";
import {
  encodeSseEvent,
  isGroundingDisplaySseEvent,
  type ModelRunChatUpdateData,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { validateRunAccess } from "../auth/entitlements";
import { isProviderDeadlineExceededError } from "../providers/network";
import {
  isProviderStreamSafetyCode,
  providerStreamSafeMessage,
  providerStreamSafetyReport,
  type ProviderStreamSafetyReport
} from "../providers/streamSafety";
import { warnProviderStreamSafetyOnce } from "../providers/streamSafetyObservability";
import type {
  ProviderAdapter,
  ProviderRunRequest,
  ProviderRunResult
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
import {
  createSearchPlanToolRouter,
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult,
  type SearchExecutionEvidence
} from "../search/toolExecutor";
import type { KnowledgeToolExecutor } from "../knowledge/toolExecutor";
import {
  sameKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import { defaultMemoryActionExecutor } from "../memory/actions/defaultAction";
import {
  MEMORY_LIST_TOOL_NAME,
  memoryActionTools
} from "../memory/actions/tools";
import type { MemoryActionExecutor } from "../memory/actions/toolExecutor";
import { defaultMemoryHistoryToolExecutor } from "../memory/history/search/defaultTool";
import type { MemoryHistoryToolExecutor } from "../memory/history/search/toolExecutor";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { memorySha256 } from "../memory/persistence/lexical";
import {
  knowledgeEvidenceFromToolResult,
  knowledgeUsageAttributionsFromToolResult
} from "../knowledge/toolResult";
import {
  hasInvalidProviderToolArguments,
  type ModelToolCall,
  type ProviderToolBridge,
  type RunTool,
  type ToolExecutionResult
} from "../tools/types";
import { applyProviderRequestContextBudget } from "./runContextBudget";
import { assertPersonalContextEgressSafe } from "../providers/personalContext";
import {
  memoryEgressRequestEvidence,
  requestHasHostedSearchCapability,
  requestHasServerExternalTools
} from "../providers/memoryEgress";
import { withPinnedHostedSearchIdentity } from "./searchArtifactIdentity";
import {
  finalizeRunCompletion,
  usageAttributionsWithEstimatedCost
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
  type PersistedAnswerRoundUsage,
  type PersistedToolLoopCall,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import { liveToolCallStatus, liveToolLoopStatus } from "./liveToolStatus";
import { projectRunOutputArtifactEvent } from "./runOutputEvents";
import { createRunTokenPersistenceBuffer } from "./runTokenPersistence";
import { mcpResponseOverflowToolExecutionResult } from "./mcpOverflowToolResult";

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

export type RunExecutionRepository = Pick<
  RunRepository,
  | "advanceToolLoopCallBatch"
  | "appendAssistantText"
  | "appendRunOutputEvent"
  | "beginToolLoopProviderRound"
  | "cancelPendingToolLoopCalls"
  | "claimToolLoopCall"
  | "completeRun"
  | "createSearchRun"
  | "failRun"
  | "getChatUpdateForRun"
  | "getRunControlForUser"
  | "isSearchStrategyEnabled"
  | "loadEntitlements"
  | "loadModelPricing"
  | "markAssistantMessageGroundedLiveOnly"
  | "persistToolLoopCallBatch"
  | "recordRunUsageEvents"
  | "resetToolLoopAssistantDraft"
  | "settleToolLoopCall"
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
  knowledgeExecutor?: KnowledgeToolExecutor;
  knowledgeAdmission?: Readonly<{
    load(input: {
      knowledgePlan: ProviderRunRequest["knowledgePlan"];
      userId: string;
    }): Promise<KnowledgeRunAdmissionPlan>;
  }>;
  memoryActionExecutor?: MemoryActionExecutor;
  memoryHistoryToolExecutor?: MemoryHistoryToolExecutor;
  memoryEgress?: MemoryToolEgressReceiptService;
  mcp?: Readonly<{
    prepare(
      userId: string,
      options?: Readonly<{ allowedServerIds?: readonly string[] }>
    ): Promise<import("../mcp/runPlan").McpRunPlanResult>;
  }>;
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
      contextStats: update.chat.contextStats,
      createdAt: iso(update.chat.createdAt),
      defaultModelId: update.chat.defaultModelId,
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
      assistantIdentity: message.assistantIdentity ?? null,
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
      status: message.status
    }))
  } satisfies ChatUpdateDataWire;
}

async function emit(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  repository: RunExecutionRepository,
  runId: string,
  event: ModelRunSseEvent
): Promise<void> {
  const outputEvent = projectRunOutputArtifactEvent(event);
  if (outputEvent) {
    await repository.appendRunOutputEvent(runId, outputEvent);
  }

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
  readonly report?: ProviderStreamSafetyReport;

  constructor(code: string, message: string, report?: ProviderStreamSafetyReport) {
    super(message);
    this.code = code;
    if (report) this.report = report;
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
  label: "Knowledge" | "Search" | "Tool" = "Tool"
): ToolExecutionResult {
  const overflowResult = label === "Knowledge"
    ? null
    : mcpResponseOverflowToolExecutionResult(call, error, label);
  if (overflowResult) return overflowResult;

  const message = label === "Knowledge"
    ? "knowledge_retrieval_failed"
    : error instanceof Error ? error.message : `${label} execution failed`;

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
      finalProviderResponsePreview: { error: message },
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

async function persistPlanSearchExecution(input: Readonly<{
  execution: SearchExecutionEvidence;
  modelRunId: string;
  repository: RunExecutionRepository;
}>): Promise<void> {
  await input.repository.createSearchRun({
    artifacts: {
      sources: input.execution.sources
    },
    invocationId: input.execution.invocationId,
    modelId: input.execution.modelId,
    modelRunId: input.modelRunId,
    provider: input.execution.provider,
    searchRevisionId: input.execution.revisionId,
    status: input.execution.status,
    strategyId: input.execution.optionId
  });
}

export function createRunExecutionResponse(input: RunExecutionInput): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const runId = input.created.runId;
  const normalizedRequest = input.prepared.normalizedRequest;
  const memoryActionsRequested =
    normalizedRequest.memoryActionTools?.version === "model-driven-v2";
  const clientToolsEnabled = normalizedRequest.toolMode !== "none";
  const knowledgeEnabled = clientToolsEnabled &&
    normalizedRequest.modelCapabilities.toolCalling === true &&
    normalizedRequest.knowledgePlan.baseIds.length > 0;
  const memoryActionEnabled = clientToolsEnabled &&
    normalizedRequest.modelCapabilities.toolCalling === true &&
    memoryActionsRequested;
  const memoryHistoryEnabled = clientToolsEnabled &&
    normalizedRequest.modelCapabilities.toolCalling === true &&
    normalizedRequest.memoryHistoryTool?.maxCalls === 2 &&
    normalizedRequest.memoryHistoryTool.pageSize === 20;
  const serverExternalToolMode = requestHasServerExternalTools(
    input.prepared.providerRequest
  );
  const hostedSearchMode = requestHasHostedSearchCapability(
    input.prepared.providerRequest
  );
  const egressReceiptRequired = serverExternalToolMode || hostedSearchMode ||
    input.prepared.providerRequest.personalContext !== undefined;
  activeRunControllers.set(runId, abortController);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const signal = abortController.signal;
      const tokenBuffer = createRunTokenPersistenceBuffer({
        assistantMessageId: input.created.assistantMessageId,
        repository: input.repository,
        runId
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

      async function persistReportedUsageForIncompleteRun(
        answerRoundUsage?: PersistedAnswerRoundUsage
      ): Promise<void> {
        const grouped = groupedUsageAttributions(reportedUsageAttributions);
        if (grouped.length === 0 && !answerRoundUsage) {
          return;
        }

        const usageAttributions = await usageAttributionsWithEstimatedCost(input.repository, grouped);
        const recorded = await input.repository.recordRunUsageEvents({
          ...(answerRoundUsage ? { answerRoundUsage } : {}),
          chatId: normalizedRequest.chatId,
          runId,
          usageAttributions,
          userId: input.userId
        });
        if (answerRoundUsage && !recorded) {
          throw new RunPipelineError(
            "tool_loop_usage_checkpoint_conflict",
            "Provider-round usage could not be checkpointed"
          );
        }
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
              strategy: normalizedRequest.searchPlan.options.find((option) =>
                option.adapterKind === "answer_provider_hosted")?.optionId ?? "provider-grounding"
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

        await emit(controller, encoder, input.repository, runId, effectiveEvent);
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
        const providerStream = streamAnswerProviderWithEgress(request);
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

      async function currentSearchDispatchAllowed(): Promise<boolean> {
        const optionIds = normalizedRequest.searchPlan.options.map((option) => option.optionId);
        const [entitlements, enabled] = await Promise.all([
          input.repository.loadEntitlements(input.userId),
          Promise.all(optionIds.map((optionId) =>
            input.repository.isSearchStrategyEnabled(optionId)))
        ]);
        const modelAccess = validateRunAccess(entitlements, {
          modelId: normalizedRequest.modelId,
          provider: normalizedRequest.provider
        });
        return modelAccess.ok && optionIds.every((optionId, index) => enabled[index] === true &&
          validateRunAccess(entitlements, {
            modelId: normalizedRequest.modelId,
            provider: normalizedRequest.provider,
            searchStrategy: optionId
          }).ok);
      }

      async function currentAnswerDispatchAllowed(): Promise<boolean> {
        const entitlements = await input.repository.loadEntitlements(input.userId);
        return validateRunAccess(entitlements, {
          modelId: normalizedRequest.modelId,
          provider: normalizedRequest.provider
        }).ok;
      }

      async function currentKnowledgeDispatchAllowed(): Promise<boolean> {
        if (!input.knowledgeAdmission || !input.prepared.knowledgeAdmissionPlan) {
          return process.env.NODE_ENV !== "production";
        }
        try {
          const current = await input.knowledgeAdmission.load({
            knowledgePlan: normalizedRequest.knowledgePlan,
            userId: input.userId
          });
          return sameKnowledgeRunAdmissionPlan(
            current,
            input.prepared.knowledgeAdmissionPlan
          );
        } catch {
          return false;
        }
      }

      async function currentMcpDispatchAllowed(inputRoute: Readonly<{
        fingerprint: string;
        namespacedName: string;
        originalName: string;
        serverId: string;
      }>, generationId: string): Promise<boolean> {
        if (!input.mcp) return process.env.NODE_ENV !== "production";
        try {
          const current = await input.mcp.prepare(input.userId, {
            allowedServerIds: [inputRoute.serverId]
          });
          if (!current.ok) return false;
          const binding = current.bindings.find((candidate) =>
            candidate.serverId === inputRoute.serverId);
          const tool = current.snapshot.tools.find((candidate) =>
            candidate.serverId === inputRoute.serverId &&
            candidate.namespacedName === inputRoute.namespacedName &&
            candidate.originalName === inputRoute.originalName);
          const server = current.snapshot.servers.find((candidate) =>
            candidate.serverId === inputRoute.serverId);
          return Boolean(
            binding && tool && server &&
            binding.fingerprint === inputRoute.fingerprint &&
            server.fingerprint === inputRoute.fingerprint &&
            binding.runtimeGenerationId === generationId
          );
        } catch {
          return false;
        }
      }

      async function* streamAnswerProviderWithEgress(
        request: ProviderRunRequest,
        dispatchSignal: AbortSignal = signal
      ): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
        if (!(await currentAnswerDispatchAllowed())) {
          throw new RunPipelineError(
            "model_not_available",
            "The selected model is no longer available"
          );
        }
        if (egressReceiptRequired && !input.memoryEgress &&
          process.env.NODE_ENV === "production") {
          throw new RunPipelineError(
            "memory_egress_receipt_unavailable",
            "Memory egress evidence is unavailable."
          );
        }
        let preview: Record<string, unknown> | null = null;
        const requestPreview = () => {
          preview ??= input.adapter.buildRequestPreview(request);
          return preview;
        };
        if (requestHasHostedSearchCapability(request) &&
          !(await currentSearchDispatchAllowed())) {
          await input.memoryEgress?.recordBlockedDispatch({
            destinationKind: "answer_provider",
            destinationSnapshot: {
              modelId: request.modelId,
              provider: request.provider,
              searchOptionIds: request.searchPlan.options.map((option) => option.optionId),
              version: 1
            },
            errorCode: "memory_egress_search_revoked",
            mode: "PROVIDER_REQUEST",
            requestEvidence: memoryEgressRequestEvidence(request),
            requestPreview: requestPreview(),
            runId,
            userId: input.userId
          });
          throw new RunPipelineError(
            "search_strategy_not_available",
            "The selected search destination is no longer available."
          );
        }
        const receipt = input.memoryEgress && egressReceiptRequired
          ? await input.memoryEgress.beginDispatch({
              destinationKind: "answer_provider",
              destinationSnapshot: {
                modelId: request.modelId,
                provider: request.provider,
                searchOptionIds: request.searchPlan.options.map((option) => option.optionId),
                version: 1
              },
              mode: "PROVIDER_REQUEST",
              requestEvidence: memoryEgressRequestEvidence(request),
              requestPreview: requestPreview(),
              runId,
              userId: input.userId
            })
          : null;
        const stream = input.adapter.stream(request, { signal: dispatchSignal });
        try {
          let next = await stream.next();
          while (!next.done) {
            yield next.value;
            next = await stream.next();
          }
          if (receipt && !(await input.memoryEgress!.completeDispatch(receipt.id))) {
            throw new RunPipelineError(
              "memory_egress_receipt_conflict",
              "Provider dispatch evidence could not be completed."
            );
          }
          return next.value;
        } catch (error) {
          if (receipt) {
            await input.memoryEgress!.failDispatch(
              receipt.id,
              error instanceof RunPipelineError ? error.code : "provider_dispatch_failed"
            ).catch(() => undefined);
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

        const searchPlanRouter = clientToolsEnabled
          ? createSearchPlanToolRouter({
              plan: normalizedRequest.searchPlan,
              runtimes: input.searchRuntimes ?? {}
            })
          : null;
        if (knowledgeEnabled && !input.knowledgeExecutor) {
          throw new RunPipelineError(
            "knowledge_policy_not_available",
            "Knowledge retrieval is not available"
          );
        }
        const knowledgeExecutor = knowledgeEnabled ? input.knowledgeExecutor ?? null : null;
        const memoryActionExecutor = memoryActionEnabled
          ? input.memoryActionExecutor ?? defaultMemoryActionExecutor
          : null;
        const memoryHistoryExecutor = memoryHistoryEnabled
          ? input.memoryHistoryToolExecutor ?? defaultMemoryHistoryToolExecutor
          : null;
        const isSearchCall = (name: string) =>
          searchPlanRouter?.accepts(name) === true;
        const isKnowledgeCall = (name: string) => knowledgeExecutor?.accepts(name) === true;
        const isMemoryCall = (name: string) =>
          memoryActionExecutor?.accepts(name) === true;
        const isMemoryHistoryCall = (name: string) =>
          memoryHistoryExecutor?.accepts(name) === true;
        const tools: RunTool[] = [
          ...(knowledgeExecutor ? [knowledgeExecutor.tool] : []),
          ...(searchPlanRouter?.tools ?? []),
          ...(memoryActionExecutor ? memoryActionTools : []),
          ...(memoryHistoryExecutor ? [memoryHistoryExecutor.tool] : []),
          ...(clientToolsEnabled ? mcpRunTools(normalizedRequest.mcp) : [])
        ];
        if (tools.length === 0) {
          throw new RunPipelineError("tool_configuration_empty", "No run tools are configured");
        }

        const persistedCalls = new Map<string, PersistedToolLoopCall>();
        let memoryMutationAttempted = false;
        const hasMcpTools = tools.some((tool) => tool.capability === "mcp");
        let mcpRuntime = input.mcpRuntime ?? null;
        const runtime = () => {
          mcpRuntime ??= getDefaultMcpRuntimeCoordinator();
          return mcpRuntime;
        };
        const egressAdapter: ProviderAdapter = {
          buildRequestPreview(request) {
            return input.adapter.buildRequestPreview(request);
          },
          stream(request, options) {
            return streamAnswerProviderWithEgress(request, options?.signal ?? signal);
          }
        };
        const outcome = await continueProviderToolLoop({
          adapter: egressAdapter,
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
          onToolBatchSettled: async ({ results }) => {
            for (const settled of results) {
              const call = modelToolCall(settled.call);
              const result = settled.result.status === "complete"
                ? settled.result.value
                : toolExecutionErrorResult(call, new Error(settled.result.error.message));
              if (searchPlanRouter?.accepts(call.name)) {
                const executions = searchExecutionsFromToolResult(result);
                const previewCount = searchExecutionPreviewCount(result);
                if (previewCount !== null && executions.length !== previewCount) {
                  throw new RunPipelineError(
                    "tool_call_result_invalid",
                    "Persisted Search result evidence is invalid"
                  );
                }
                for (const execution of executions) {
                  if (hasReportedUsage(execution.usage)) {
                    rememberReportedUsage(execution.provider, execution.modelId ?? "search", execution.usage);
                  }
                  await persistPlanSearchExecution({
                    execution,
                    modelRunId: runId,
                    repository: input.repository
                  });
                }
              } else if (isKnowledgeCall(call.name)) {
                const evidence = knowledgeEvidenceFromToolResult(result);
                if (result.status === "complete" && !evidence) {
                  throw new RunPipelineError(
                    "tool_call_result_invalid",
                    "Persisted Knowledge result evidence is invalid"
                  );
                }
                if (evidence) {
                  for (const attribution of knowledgeUsageAttributionsFromToolResult(result)) {
                    rememberReportedUsage(attribution.provider, attribution.modelId, attribution.usage);
                  }
                }
              }
              for (const artifact of result.artifacts ?? []) {
                await emit(controller, encoder, input.repository, runId, artifact);
              }
            }
            await persistReportedUsageForIncompleteRun();
          },
          beforeProviderRound: async ({ continuation, round }) => {
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
            if (hasMcpTools) {
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                liveToolLoopStatus({ phase: "model" })
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
              let externalReceipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
              try {
                if (hasInvalidProviderToolArguments(call.arguments)) {
                  throw new Error("provider_tool_arguments_invalid");
                }
                const externalCall = isKnowledgeCall(call.name) ||
                  isSearchCall(call.name) ||
                  (!isMemoryCall(call.name) && !isMemoryHistoryCall(call.name));
                if (externalCall) {
                  const destinationSnapshot = isKnowledgeCall(call.name)
                    ? {
                        baseIds: normalizedRequest.knowledgePlan.baseIds,
                        kind: "knowledge",
                        toolName: call.name,
                        version: 1
                      }
                    : isSearchCall(call.name)
                      ? {
                          kind: "search",
                          optionIds: searchPlanRouter?.optionIdsForTool(call.name) ?? [],
                          toolName: call.name,
                          version: 1
                        }
                      : (() => {
                          const mcpRoute = resolveMcpRunTool(normalizedRequest.mcp, call.name);
                          return {
                            fingerprint: mcpRoute?.fingerprint ?? null,
                            kind: "mcp",
                            serverId: mcpRoute?.serverId ?? null,
                            toolName: call.name,
                            version: 1
                          };
                        })();
                  const currentAuthorization = await (isKnowledgeCall(call.name)
                    ? currentKnowledgeDispatchAllowed()
                    : isSearchCall(call.name)
                      ? currentSearchDispatchAllowed()
                      : (() => {
                          const route = resolveMcpRunTool(normalizedRequest.mcp, call.name);
                          const generationId = claim.call.mcpBinding?.runtimeGenerationId;
                          return route && generationId
                            ? currentMcpDispatchAllowed({
                                fingerprint: route.fingerprint,
                                namespacedName: call.name,
                                originalName: route.originalName,
                                serverId: route.serverId
                              }, generationId)
                            : Promise.resolve(false);
                        })());
                  if (!currentAuthorization) {
                    await input.memoryEgress?.recordBlockedDispatch({
                      destinationKind: String(destinationSnapshot.kind),
                      destinationSnapshot,
                      errorCode: "memory_egress_destination_revoked",
                      mode: "TOOL_CALL",
                      modelRunToolCallId: claim.call.id,
                      requestEvidence: memoryEgressRequestEvidence(request),
                      requestPreview: {
                        argumentsHash: memorySha256(call.arguments),
                        toolName: call.name
                      },
                      runId,
                      userId: input.userId
                    });
                    throw new Error("memory_egress_destination_revoked");
                  }
                  externalReceipt = input.memoryEgress
                    ? await input.memoryEgress.beginDispatch({
                        destinationKind: String(destinationSnapshot.kind),
                        destinationSnapshot,
                        mode: "TOOL_CALL",
                        modelRunToolCallId: claim.call.id,
                        requestEvidence: memoryEgressRequestEvidence(request),
                        requestPreview: {
                          argumentsHash: memorySha256(call.arguments),
                          toolName: call.name
                        },
                        runId,
                        userId: input.userId
                      })
                    : null;
                }
                if (isKnowledgeCall(call.name)) {
                  result = await knowledgeExecutor!.execute(call, {
                    persistedToolCallId: claim.call.id,
                    request,
                    runId,
                    userId: input.userId
                  }, { signal: context.signal });
                } else if (isMemoryCall(call.name)) {
                  if (call.name !== MEMORY_LIST_TOOL_NAME && memoryMutationAttempted) {
                    throw new Error("memory_action_already_attempted");
                  }
                  if (call.name !== MEMORY_LIST_TOOL_NAME) memoryMutationAttempted = true;
                  result = await memoryActionExecutor!.execute(
                    call,
                    {
                    persistedToolCallId: claim.call.id,
                    request,
                    runId,
                    userId: input.userId
                    }
                  );
                } else if (isMemoryHistoryCall(call.name)) {
                  result = await memoryHistoryExecutor!.execute(call, {
                    persistedToolCallId: claim.call.id,
                    request,
                    runId,
                    userId: input.userId
                  });
                } else if (searchPlanRouter?.accepts(call.name)) {
                  result = await searchPlanRouter.execute(
                    call,
                    request,
                    { signal: context.signal }
                  );
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
                if (externalReceipt &&
                  !(await input.memoryEgress!.completeDispatch(externalReceipt.id))) {
                  throw new Error("memory_egress_receipt_conflict");
                }
              } catch (error) {
                if (externalReceipt) {
                  await input.memoryEgress!.failDispatch(
                    externalReceipt.id,
                    error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/u.test(error.message)
                      ? error.message
                      : "external_tool_dispatch_failed"
                  ).catch(() => undefined);
                }
                if (signal.aborted || isAbortError(error)) throw error;
                result = toolExecutionErrorResult(
                  call,
                  error,
                  isKnowledgeCall(call.name)
                    ? "Knowledge"
                    : isSearchCall(call.name) ? "Search" : "Tool"
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
              userId: input.userId
            });
            if (!reset) throw new RunPipelineError("tool_loop_reset_conflict", "Assistant draft could not reset");
            tokenBuffer.resetLocal();
            emitTransient(controller, encoder, {
              data: { round: toolSignal.round },
              type: "message_reset"
            });
          },
          onUsage: async (usage, roundRequest, context) => {
            rememberReportedUsage(roundRequest.provider, roundRequest.modelId, usage);
            await persistReportedUsageForIncompleteRun({
              completeness: context.completeness,
              roundIndex: context.round,
              usage: normalizeTokenUsage(usage)
            });
          },
          parallelToolCalls: normalizedRequest.modelCapabilities.parallelToolCalls === true,
          persistToolBatch: async ({ calls, continuation, round }) => {
            const persisted = await input.repository.persistToolLoopCallBatch({
              calls: calls.map((call, ordinal) => {
                const route = resolveMcpRunTool(normalizedRequest.mcp, call.name);
                if (!route && !isSearchCall(call.name) &&
                  !isKnowledgeCall(call.name) && !isMemoryCall(call.name) &&
                  !isMemoryHistoryCall(call.name)) {
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
                liveToolLoopStatus({ count: calls.length, phase: "tools" })
              );
            }
            for (const call of calls) {
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                liveToolCallStatus(modelToolCall(call))
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
          const streamSafetyReport = outcome.failure.streamSafetyReport;
          const safetyCode = isProviderStreamSafetyCode(outcome.failure.code)
            ? outcome.failure.code
            : null;
          throw new RunPipelineError(
            outcome.failure.code === "provider_round_failed"
              ? "provider_stream_failed"
              : outcome.failure.code,
            streamSafetyReport?.message ??
              (safetyCode ? providerStreamSafeMessage(safetyCode) : outcome.failure.message),
            streamSafetyReport
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
        const dispatchControl = await input.repository.getRunControlForUser(
          runId,
          input.userId
        );
        if (
          !dispatchControl ||
          !["streaming", "queued", "in_progress"].includes(dispatchControl.status)
        ) {
          throw new RunPipelineError(
            dispatchControl?.status === "preparing"
              ? "memory_preparing_run_not_finalized"
              : "model_run_not_active",
            "Run is not finalized for provider dispatch"
          );
        }
        await emit(controller, encoder, input.repository, runId, {
          data: {
            modelId: normalizedRequest.modelId,
            provider: normalizedRequest.provider,
            runId,
            status: "streaming"
          },
          type: "run_start"
        });
        await emit(controller, encoder, input.repository, runId, {
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
            contextTruncationArtifact(input.prepared.contextTruncation)
          );
        }

        const hasClientSearch = clientToolsEnabled && normalizedRequest.searchPlan.options.some((option) =>
          option.adapterKind === "provider_model_client");
        const hasClientTools = hasClientSearch ||
          (clientToolsEnabled && (normalizedRequest.mcp?.tools.length ?? 0) > 0) ||
          knowledgeEnabled || memoryActionEnabled || memoryHistoryEnabled;
        assertPersonalContextEgressSafe(input.prepared.providerRequest);
        const providerResult = hasClientTools
          ? await runProviderToolLoop(input.prepared.providerRequest)
          : await streamProviderRequest(input.prepared.providerRequest);

        await tokenBuffer.flush();
        throwIfAborted(signal);
        const persistedProviderResult = groundedLiveOnly
          ? {
              ...providerResult,
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
        const originalStreamSafetyReport = providerStreamSafetyReport(error);
        try {
          await tokenBuffer.flush();
        } catch (flushError) {
          if (!originalStreamSafetyReport) failure = flushError;
        }

        const deadlineExceeded = isProviderDeadlineExceededError(failure);
        const pipelineError = failure instanceof RunPipelineError ? failure : null;
        const streamSafetyReport = providerStreamSafetyReport(failure);
        const safetyCode = streamSafetyReport?.code ??
          (pipelineError && isProviderStreamSafetyCode(pipelineError.code)
            ? pipelineError.code
            : isRecord(failure) && isProviderStreamSafetyCode(failure.code)
              ? failure.code
              : null);
        const payload = safetyCode
          ? {
              code: safetyCode,
              message: providerStreamSafeMessage(safetyCode)
            }
          : {
              code: pipelineError?.code ??
                (deadlineExceeded ? "provider_request_timed_out" : "provider_stream_failed"),
              message: failure instanceof Error ? failure.message : "Provider stream failed"
            };
        if (streamSafetyReport) {
          warnProviderStreamSafetyOnce(failure, {
            adapterKind: "direct",
            connectionId: "unbound",
            providerFamily: normalizedRequest.provider,
            providerModelId: "unbound"
          });
        }
        const failed = await input.repository.failRun(
          runId,
          input.created.assistantMessageId,
          payload,
          safetyCode || deadlineExceeded ? { recoveryTerminal: true } : undefined
        );
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
