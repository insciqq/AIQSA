import type { ChatUpdateDataWire } from "../../contracts/chats";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import { textMessageContent } from "../../domain/content";
import {
  GROUNDED_LIVE_ONLY_PLACEHOLDER
} from "../../domain/grounding";
import {
  encodeSseEvent,
  isGroundingDisplaySseEvent,
  textFromContentBlocks,
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
  ProviderConversationMessage,
  ProviderRunRequest,
  ProviderRunResult
} from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import {
  parseProviderStructuredOutputObject,
  type ProviderStructuredOutputAdapter,
  type ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import {
  sameProviderAdmissionPlan,
  type ProviderAdmissionPlan
} from "../providerRuntime/admission";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import {
  MCP_FIND_TOOLS_NAME,
  mcpFindToolsArguments,
  mcpFindToolsTool
} from "../mcp/discovery";
import {
  executeDurableMcpDiscovery,
  executeDurableMcpDiscoveryBatch,
  McpAutoDiscoveryUnavailableError
} from "../mcp/durableDiscovery";
import type { McpSemanticRouter } from "../mcp/router";
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
import {
  KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS,
  type KnowledgeToolExecutor
} from "../knowledge/toolExecutor";
import {
  knowledgeRunAdmissionHasReadySources,
  type KnowledgeRunAdmissionAuthorizationSnapshot,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import type { ChatTitleGenerator } from "../chats/titleGeneration";
import { memorySha256 } from "../memory/persistence/lexical";
import {
  FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
  focusedKnowledgeCallArguments,
  focusedKnowledgeCallArgumentsMatch,
  focusedKnowledgeEvidenceDispatchDraft,
  knowledgeEvidenceMessageFromDispatchDraft,
  toolLoopKnowledgeEvidenceDispatchDraft,
  withAutomaticKnowledgeEvidence
} from "../knowledge/automaticEvidence";
import type { KnowledgeEvidenceDispatchManifestDraft } from "../knowledge/evidenceDispatchManifest";
import type { KnowledgeEvidenceDispatchBinding } from "../knowledge/evidenceDispatchRepository";
import { KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT } from "../knowledge/fullContext";
import type {
  KnowledgeProviderDispatchLifecycle
} from "../knowledge/providerDispatchLifecycle";
import {
  executeKnowledgeAnswerGroundingV8,
  type KnowledgeAnswerOperationExecutionV8
} from "../knowledge/answerGroundingExecutionV5";
import { executeKnowledgeAnswerGroundingV21 } from
  "../knowledge/answerGroundingExecutionV21ScopeV6";
import { selectKnowledgeAnswerPipelineForNewRun } from
  "../knowledge/answerPipelineRollout";
import {
  knowledgeGroundingInheritedReasoningEffortV1,
  resolveKnowledgeGroundingExecutionPolicyV1,
  type KnowledgeGroundingExecutionPolicyV1
} from "../knowledge/groundingExecutionPolicy";
import { knowledgeGroundingProviderParams } from
  "../knowledge/groundingProviderParams";
import {
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_INSUFFICIENT_MESSAGE,
  KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE,
  KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION
} from "../knowledge/answerGroundingV5";
import { decodeKnowledgeFocusedRequest } from "../knowledge/focusedRequest";
import { KNOWLEDGE_FOCUSED_OPERATION_NAME } from "../knowledge/retrievalTypes";
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
  usageAttributionsWithEstimatedCost,
  type KnowledgeAnswerFinalizationContracts
} from "./runFinalization";
import type { MaterializedPreparedRunData } from "./runPreparation";
import type {
  RunChatUpdateRecord,
  RunRepository,
  RunUsageAttribution
} from "./runRepositoryContract";
import { UNAVAILABLE_CHAT_WORKSPACE_STATE } from "../../contracts/workspace";
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
import { notifyProjectEvent } from "../projects/events";
import { createRunTokenPersistenceBuffer } from "./runTokenPersistence";
import { mcpResponseOverflowToolExecutionResult } from "./mcpOverflowToolResult";
import { toolRunBudgetsForRequest } from "./toolBudgets";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { workspaceActivityEvent } from "../workspace/activityProjection";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import { workspaceToolNameFromNamespaced } from "../workspace/toolCatalog";

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
  | "appendMcpDiscoveryEpoch"
  | "appendAssistantText"
  | "appendRunOutputEvent"
  | "beginToolLoopProviderRound"
  | "cancelPendingToolLoopCalls"
  | "claimAutomaticKnowledgeCall"
  | "claimToolLoopCall"
  | "completeRun"
  | "createSearchRun"
  | "failRun"
  | "getChatUpdateForRun"
  | "getRunControlForUser"
  | "groundKnowledgeAnswer"
  | "groundKnowledgeAnswerV5"
  | "groundKnowledgeAnswerV21"
  | "isProjectRunAccessCurrent"
  | "isSearchStrategyEnabled"
  | "loadEntitlements"
  | "loadFocusedKnowledgeRecoveryScope"
  | "loadModelPricing"
  | "markAssistantMessageGroundedLiveOnly"
  | "markRunAnswerStarted"
  | "persistToolLoopCallBatch"
  | "prepareAutomaticKnowledgeCallBatch"
  | "recordRunUsageEvents"
  | "resetToolLoopAssistantDraft"
  | "settleToolLoopCall"
  | "updateRunProviderResponseId"
>;

export type RunExecutionInput = Readonly<{
  adapter: ProviderAdapter;
  /** Names a personal chat after its first answer; absent on recovery paths. */
  chatTitleGenerator?: ChatTitleGenerator;
  created: Readonly<{
    assistantMessageId: string;
    runId: string;
    userMessageId: string;
  }>;
  prepared: MaterializedPreparedRunData;
  repository: RunExecutionRepository;
  knowledgeExecutor?: KnowledgeToolExecutor;
  knowledgeProviderDispatch?: KnowledgeProviderDispatchLifecycle;
  knowledgeGroundingExecutionPolicy?: KnowledgeGroundingExecutionPolicyV1;
  structuredOutputAdapter?: ProviderStructuredOutputAdapter;
  knowledgeAdmission?: Readonly<{
    authorizeSnapshot?(input: {
      executionScope?: "project";
      projectId?: string;
      snapshot: KnowledgeRunAdmissionAuthorizationSnapshot;
      userId: string;
    }): Promise<boolean>;
    load(input: {
      executionScope?: "project";
      knowledgePlan: ProviderRunRequest["knowledgePlan"];
      preferredProfileRevisionId?: string;
      projectId?: string;
      userId: string;
    }): Promise<KnowledgeRunAdmissionPlan>;
  }>;
  memoryEgress?: MemoryToolEgressReceiptService;
  providerAdmission?: Readonly<{
    load(input: {
      executionScope?: "project";
      providerConnectionId: string;
      providerModelId: string;
      requiresClientToolCoexistence?: boolean;
      searchPlan: ProviderAdmissionPlan["requestedSearchPlan"];
      userId: string;
    }): Promise<ProviderAdmissionPlan>;
  }>;
  mcp?: Readonly<{
    materialize?(
      userId: string,
      tools: readonly Readonly<{
        namespacedName: string;
        revisionId: string;
        serverId: string;
      }>[]
    ): Promise<import("../mcp/runPlan").McpRunPlanResult>;
    prepare(
      userId: string,
      options?: Readonly<{ allowedServerIds?: readonly string[] }>
    ): Promise<import("../mcp/runPlan").McpRunPlanResult>;
    prepareProject?(serverIds: readonly string[]): Promise<import("../mcp/runPlan").McpRunPlanResult>;
    router?: McpSemanticRouter;
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
  workspace?: WorkspaceCoordinator;
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
      ...(update.chat.projectId !== undefined ? { projectId: update.chat.projectId } : {}),
      title: update.chat.title,
      updatedAt: iso(update.chat.updatedAt),
      usageStats: update.chat.usageStats ?? null,
      workspace: update.chat.workspace ?? UNAVAILABLE_CHAT_WORKSPACE_STATE
    },
    messages: update.messages.map((message) => ({
      artifactSummary: message.artifactSummary ?? null,
      assistantIdentity: message.assistantIdentity ?? null,
      ...(message.author !== undefined ? { author: message.author } : {}),
      citationMessageId: message.citationMessageId ?? null,
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
      status: message.status,
      toolActivity: message.toolActivity ?? null,
      workspaceActivity: message.workspaceActivity ?? null
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
  label: "Knowledge" | "Search" | "Tool" | "Workspace" = "Tool"
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

function safeKnowledgeFailureMessage(code: string): string {
  switch (code) {
    case "sources_processing":
      return "The selected Knowledge documents are still processing.";
    case "no_retrieval_candidates":
      return "No retrieval candidates were found in the ready Knowledge documents.";
    case "knowledge_retrieval_failed":
      return "Knowledge retrieval failed.";
    case "knowledge_answer_failed":
      return "The Knowledge answer provider failed.";
    case "knowledge_citation_contract_failed":
    case "knowledge_answer_contract_failed":
      return "The Knowledge answer did not satisfy the required citation contract.";
    default:
      return "The Knowledge request failed.";
  }
}

/**
 * Focused Knowledge is a one-shot route.  Any failure after admission must
 * settle into the small public Knowledge state machine; leaking an internal
 * pipeline/checkpoint code would make the state replayable (and expose
 * implementation details to the client).
 */
function focusedKnowledgeFailureCode(error: unknown): string {
  const code = error instanceof RunPipelineError
    ? error.code
    : isRecord(error) && typeof error.code === "string"
      ? error.code
      : null;
  switch (code) {
    case "sources_processing":
    case "no_retrieval_candidates":
    case "knowledge_retrieval_failed":
    case "knowledge_answer_failed":
    case "knowledge_answer_contract_failed":
    case "knowledge_citation_contract_failed":
      return code;
    case "knowledge_focused_request_invalid":
    case "knowledge_focused_checkpoint_conflict":
    case "knowledge_retrieval_outcome_unknown":
      return "knowledge_retrieval_failed";
    default:
      return "knowledge_answer_failed";
  }
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
  const toolBudgets = toolRunBudgetsForRequest(normalizedRequest);
  const clientToolsEnabled = normalizedRequest.toolMode !== "none";
  const admittedKnowledgeReady = knowledgeRunAdmissionHasReadySources(
    input.prepared.knowledgeAdmissionPlan
  );
  const fullContextPlan = input.prepared.knowledgeAdmissionPlan?.answeringPlan?.route ===
    KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT
    ? input.prepared.knowledgeAdmissionPlan.answeringPlan
    : null;
  const groundedKnowledgeAnswer = normalizedRequest.knowledgeFocusedRequest !== undefined ||
    normalizedRequest.knowledgeAnswering?.route === KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT;
  const knowledgeCitationAnswer = normalizedRequest.knowledgePlan.mode !== "none";
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
      const workspaceTurnController = normalizedRequest.workspace
        ? new AbortController()
        : null;
      const workspaceTurnTimer = workspaceTurnController && normalizedRequest.workspace
        ? setTimeout(
            () => workspaceTurnController.abort(
              new WorkspaceRuntimeError("workspace_tool_timeout")
            ),
            normalizedRequest.workspace.turnTimeoutSeconds * 1_000
          )
        : null;
      const signal = workspaceTurnController
        ? AbortSignal.any([abortController.signal, workspaceTurnController.signal])
        : abortController.signal;
      // Terminal Workspace settlement runs on every exit path so a stopped,
      // timed-out, or failed turn never leaves a live guest process or a
      // session stuck in RUNNING/CREATING. Best effort: it must not mask the
      // run's own terminal persistence.
      // Client-safe Workspace timeline entries ride the same emit path as
      // every other durable artifact: persisted exactly, streamed live.
      const onWorkspaceActivity = async (entry: ThreadWorkspaceActivityEntry) => {
        await emit(controller, encoder, input.repository, runId, workspaceActivityEvent(entry));
      };
      const settleWorkspace = async (
        outcome: "cancelled" | "completed" | "failed" | "timed_out"
      ) => {
        if (!normalizedRequest.workspace || !input.workspace) return;
        await input.workspace.settle({
          onActivity: onWorkspaceActivity,
          outcome,
          runId,
          userId: input.userId,
          workspace: normalizedRequest.workspace
        }).catch(() => undefined);
      };
      const tokenBuffer = createRunTokenPersistenceBuffer({
        assistantMessageId: input.created.assistantMessageId,
        ...(input.prepared.project
          ? { onPersist: () => notifyProjectEvent(input.prepared.project!.projectId) }
          : {}),
        repository: input.repository,
        runId
      });
      let persistedProviderResponseId: string | null = null;
      let answerStartMarked = false;
      let groundedLiveOnly = false;
      let projectAccessCheck: Promise<boolean> | null = null;
      let projectAccessRevoked = false;
      let projectAccessValidatedAt = Number.NEGATIVE_INFINITY;
      const reportedUsageAttributions: RunUsageAttribution[] = [];
      const usageAccountedToolCallIds = new Set<string>();

      async function assertProjectRunAccessCurrent(force = false): Promise<void> {
        const project = input.prepared.project;
        if (!project) return;
        if (projectAccessRevoked) {
          throw new RunPipelineError(
            "project_access_changed",
            "Project access changed during the run"
          );
        }
        const validate = input.repository.isProjectRunAccessCurrent;
        if (!validate) {
          if (process.env.NODE_ENV === "production") {
            throw new RunPipelineError(
              "project_access_revalidation_unavailable",
              "Project access could not be revalidated"
            );
          }
          return;
        }
        const now = Date.now();
        if (!projectAccessCheck && !force && now - projectAccessValidatedAt < 250) return;
        if (!projectAccessCheck) {
          projectAccessValidatedAt = now;
          projectAccessCheck = validate({
            accessRevision: project.accessRevision,
            instructionsRevision: project.instructionsRevision,
            memoryRevision: project.memoryRevision,
            policyRevision: project.policyRevision,
            projectId: project.projectId,
            userId: input.userId
          });
        }
        let current: boolean;
        try {
          current = await projectAccessCheck;
        } catch {
          throw new RunPipelineError(
            "project_access_revalidation_failed",
            "Project access could not be revalidated"
          );
        } finally {
          projectAccessCheck = null;
        }
        if (current) return;
        projectAccessRevoked = true;
        if (persistedProviderResponseId) {
          await input.adapter.cancel?.(persistedProviderResponseId).catch(() => undefined);
        }
        throw new RunPipelineError(
          "project_access_changed",
          "Project access changed during the run"
        );
      }

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
        if (grouped.length === 0 && !answerRoundUsage && usageAccountedToolCallIds.size === 0) {
          return;
        }

        const usageAttributions = await usageAttributionsWithEstimatedCost(input.repository, grouped);
        const recorded = await input.repository.recordRunUsageEvents({
          ...(answerRoundUsage ? { answerRoundUsage } : {}),
          chatId: normalizedRequest.chatId,
          runId,
          usageAccountedToolCallIds: [...usageAccountedToolCallIds],
          usageAttributions,
          userId: input.userId
        });
        if ((answerRoundUsage || usageAccountedToolCallIds.size > 0) && !recorded) {
          throw new RunPipelineError(
            "tool_loop_usage_checkpoint_conflict",
            "Provider-round usage could not be checkpointed"
          );
        }
        if (recorded) {
          usageAccountedToolCallIds.clear();
        }
      }

      async function applyProviderEvent(
        event: ModelRunSseEvent,
        options: Readonly<{ includeTokenEvents?: boolean }> = {}
      ): Promise<void> {
        await assertProjectRunAccessCurrent();
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
          if (includeTokenEvents && !answerStartMarked) {
            answerStartMarked = true;
            await input.repository.markRunAnswerStarted({ at: new Date(), runId });
          }
          if (!includeTokenEvents || knowledgeCitationAnswer) {
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
        const providerStream = streamAnswerProviderWithEgress(
          request,
          signal
        );
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
        if (input.prepared.project?.executionScope === "project") {
          return currentProjectProviderDispatchAllowed();
        }
        const selection = input.prepared.providerAdmissionPlan.selection;
        const [entitlements, enabled] = await Promise.all([
          input.repository.loadEntitlements(input.userId),
          Promise.all(optionIds.map((optionId) =>
            input.repository.isSearchStrategyEnabled(optionId)))
        ]);
        const modelAccess = validateRunAccess(entitlements, {
          modelId: selection.providerModelId,
          provider: selection.providerConnectionId
        });
        return modelAccess.ok && optionIds.every((optionId, index) => enabled[index] === true &&
          validateRunAccess(entitlements, {
            modelId: selection.providerModelId,
            provider: selection.providerConnectionId,
            searchStrategy: optionId
          }).ok);
      }

      async function currentAnswerDispatchAllowed(): Promise<boolean> {
        if (input.prepared.project?.executionScope === "project") {
          return currentProjectProviderDispatchAllowed();
        }
        const entitlements = await input.repository.loadEntitlements(input.userId);
        const selection = input.prepared.providerAdmissionPlan.selection;
        return validateRunAccess(entitlements, {
          modelId: selection.providerModelId,
          provider: selection.providerConnectionId
        }).ok;
      }

      async function currentProjectProviderDispatchAllowed(): Promise<boolean> {
        const project = input.prepared.project;
        if (project?.executionScope !== "project") return true;
        if (!input.providerAdmission) return process.env.NODE_ENV !== "production";
        const expected = input.prepared.providerAdmissionPlan;
        try {
          const current = await input.providerAdmission.load({
            executionScope: "project",
            providerConnectionId: expected.selection.providerConnectionId,
            providerModelId: expected.selection.providerModelId,
            ...(expected.requiresClientToolCoexistence
              ? { requiresClientToolCoexistence: true }
              : {}),
            searchPlan: expected.requestedSearchPlan,
            userId: input.userId
          });
          return sameProviderAdmissionPlan(current, expected);
        } catch {
          return false;
        }
      }

      async function currentKnowledgeDispatchAllowed(): Promise<boolean> {
        const authorizeSnapshot = input.knowledgeAdmission?.authorizeSnapshot;
        const loadScope = input.repository.loadFocusedKnowledgeRecoveryScope;
        if (!authorizeSnapshot || !loadScope) {
          return process.env.NODE_ENV !== "production";
        }
        try {
          const snapshot = await loadScope({ runId, userId: input.userId });
          if (!snapshot) return false;
          return await authorizeSnapshot({
            ...(input.prepared.project ? { executionScope: "project" as const } : {}),
            ...(input.prepared.project ? { projectId: input.prepared.project.projectId } : {}),
            snapshot,
            userId: input.userId
          });
        } catch {
          return false;
        }
      }

      async function requestWithKnowledgeEvidenceMessage(
        request: ProviderRunRequest,
        message: ProviderConversationMessage
      ): Promise<ProviderRunRequest> {
        const budgeted = applyProviderRequestContextBudget({
          ...(input.toolBridge ? { bridge: input.toolBridge } : {}),
          request: withAutomaticKnowledgeEvidence(request, message)
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
        const retainedEvidence = budgeted.request.context?.messages.find((candidate) =>
          candidate.id === message.id && candidate.purpose === "knowledge_evidence");
        if (!retainedEvidence ||
          textFromContentBlocks(retainedEvidence.content) !== textFromContentBlocks(message.content)) {
          throw new RunPipelineError(
            "context_too_large",
            "The exact Knowledge evidence manifest did not fit the answer context"
          );
        }
        return budgeted.request;
      }

      async function requestWithAutomaticKnowledgeEvidence(
        request: ProviderRunRequest
      ): Promise<Readonly<{
        dispatchDraft: KnowledgeEvidenceDispatchManifestDraft | null;
        evidenceBindings: readonly KnowledgeEvidenceDispatchBinding[] | null;
        request: ProviderRunRequest;
      }>> {
        if (normalizedRequest.knowledgeAnswering?.route ===
          KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) {
          if (!fullContextPlan ||
            normalizedRequest.knowledgeAnswering.evidenceCount !==
              fullContextPlan.evidenceItems.length ||
            fullContextPlan.dispatchDraft.items.length !== fullContextPlan.evidenceItems.length) {
            throw new RunPipelineError(
              "knowledge_evidence_receipt_invalid",
              "The accepted full-context Knowledge evidence is unavailable"
            );
          }
          if (!(await currentKnowledgeDispatchAllowed())) {
            throw new RunPipelineError(
              "memory_egress_destination_revoked",
              "Knowledge access changed before answer dispatch"
            );
          }
          const answerRequest: ProviderRunRequest = {
            ...request,
            toolChoice: "none",
            tools: undefined
          };
          return {
            dispatchDraft: fullContextPlan.dispatchDraft,
            evidenceBindings: fullContextPlan.evidenceItems.map((item) => ({
              dispatchEvidenceId: item.evidenceId,
              evidenceItemId: item.id
            })),
            request: await requestWithKnowledgeEvidenceMessage(
              answerRequest,
              knowledgeEvidenceMessageFromDispatchDraft(fullContextPlan.dispatchDraft)
            )
          };
        }
        const rawFocusedRequest = normalizedRequest.knowledgeFocusedRequest;
        if (rawFocusedRequest === undefined) {
          return { dispatchDraft: null, evidenceBindings: null, request };
        }
        const focusedRequest = decodeKnowledgeFocusedRequest(rawFocusedRequest);
        if (!focusedRequest) {
          throw new RunPipelineError(
            "knowledge_focused_request_invalid",
            "The saved focused Knowledge request is invalid"
          );
        }
        if (!admittedKnowledgeReady || !input.prepared.knowledgeAdmissionPlan) {
          throw new RunPipelineError(
            "sources_processing",
            "Selected Knowledge documents are not ready"
          );
        }
        const answerRequest: ProviderRunRequest = {
          ...request,
          toolChoice: "none",
          tools: undefined
        };
        const prepare = input.repository.prepareAutomaticKnowledgeCallBatch;
        const claimAutomatic = input.repository.claimAutomaticKnowledgeCall;
        if (!prepare || !claimAutomatic || !input.knowledgeExecutor) {
          throw new RunPipelineError(
            "knowledge_retrieval_failed",
            "Focused Knowledge retrieval is unavailable"
          );
        }
        const prepared = await prepare({
          calls: [{
            arguments: focusedKnowledgeCallArguments(focusedRequest),
            ordinal: 0,
            providerCallId: FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID
          }],
          runId,
          userId: input.userId
        });
        if (prepared.kind === "cancelled") throw abortError();
        if ((prepared.kind !== "prepared" && prepared.kind !== "reused") ||
          prepared.calls.length !== 1) {
          throw new RunPipelineError(
            "knowledge_focused_checkpoint_conflict",
            "Focused Knowledge retrieval could not be durably prepared"
          );
        }
        const persisted = prepared.calls[0]!;
        const call = modelToolCall({
          arguments: persisted.arguments,
          id: persisted.providerCallId,
          name: persisted.toolName
        });
        if (call.id !== FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID ||
          call.name !== KNOWLEDGE_FOCUSED_OPERATION_NAME ||
          !focusedKnowledgeCallArgumentsMatch(focusedRequest, persisted.arguments)) {
          throw new RunPipelineError(
            "knowledge_focused_checkpoint_conflict",
            "Focused Knowledge retrieval checkpoint does not match the accepted request"
          );
        }
        const claim = await claimAutomatic({
          callId: persisted.id,
          runId,
          userId: input.userId
        });
        if (claim.kind === "ambiguous") {
          throw new RunPipelineError(
            "knowledge_retrieval_outcome_unknown",
            "Focused Knowledge retrieval may have completed and was not repeated"
          );
        }
        if (claim.kind === "cancelled") throw abortError();
        if (claim.kind === "not_found") {
          throw new RunPipelineError(
            "knowledge_focused_checkpoint_conflict",
            "Focused Knowledge retrieval checkpoint was not found"
          );
        }

        let result: ToolExecutionResult;
        let focusedUsageAccounted = persisted.usageAccountedAt != null;
        if (claim.kind === "settled") {
          const stored = parsePersistedToolExecutionResult(call, claim.call.result);
          if (!stored) {
            throw new RunPipelineError(
              "knowledge_retrieval_failed",
              "Persisted focused Knowledge evidence is invalid"
            );
          }
          result = stored;
          if (knowledgeEvidenceFromToolResult(result) && input.memoryEgress &&
            !(await input.memoryEgress.settleRecoveredToolDispatch({
              modelRunToolCallId: claim.call.id,
              outcome: "COMPLETED",
              runId,
              userId: input.userId
            }))) {
            throw new RunPipelineError(
              "memory_egress_receipt_conflict",
              "The focused Knowledge egress receipt could not be settled"
            );
          }
          focusedUsageAccounted = claim.call.usageAccountedAt != null;
        } else {
          const executionContext = {
            persistedToolCallId: claim.call.id,
            request: answerRequest,
            runId,
            userId: input.userId
          };
          let preflightResult: ToolExecutionResult | null = null;
          try {
            const admission = await input.knowledgeExecutor.preflight?.(call, executionContext);
            if (admission && admission.kind !== "admitted") {
              preflightResult = admission.result;
            }
          } catch (error) {
            preflightResult = toolExecutionErrorResult(call, error, "Knowledge");
          }
          if (preflightResult) {
            result = preflightResult;
          } else {
            await assertProjectRunAccessCurrent(true);
            if (!(await currentKnowledgeDispatchAllowed())) {
              throw new RunPipelineError(
                "memory_egress_destination_revoked",
                "Knowledge access changed before focused retrieval"
              );
            }
            const receipt = input.memoryEgress
              ? await input.memoryEgress.beginDispatch({
                  destinationKind: "knowledge",
                  destinationSnapshot: {
                    baseIds: normalizedRequest.knowledgePlan.baseIds,
                    kind: "knowledge",
                    toolName: call.name,
                    version: 1
                  },
                  mode: "TOOL_CALL",
                  modelRunToolCallId: claim.call.id,
                  requestEvidence: memoryEgressRequestEvidence(answerRequest),
                  requestPreview: {
                    argumentsHash: memorySha256(call.arguments),
                    toolName: call.name
                  },
                  runId,
                  userId: input.userId
                })
              : null;
            try {
              const retrievalSignal = AbortSignal.any([
                signal,
                AbortSignal.timeout(KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS)
              ]);
              result = await input.knowledgeExecutor.execute(
                call,
                executionContext,
                { signal: retrievalSignal }
              );
              if (receipt && !(await input.memoryEgress!.completeDispatch(receipt.id))) {
                throw new Error("memory_egress_receipt_conflict");
              }
            } catch (error) {
              if (receipt) {
                await input.memoryEgress!.failDispatch(
                  receipt.id,
                  "knowledge_retrieval_failed"
                ).catch(() => undefined);
              }
              if (signal.aborted || error instanceof RunPipelineError) {
                throw error;
              }
              result = toolExecutionErrorResult(call, error, "Knowledge");
            }
          }
          const storedResult = snapshotToolExecutionResult(
            result,
            toolLoopPersistenceLimits.resultBytes
          );
          if (storedResult === null) {
            throw new RunPipelineError(
              "knowledge_retrieval_failed",
              "Focused Knowledge result is invalid or too large"
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
            throw new RunPipelineError(
              "knowledge_focused_checkpoint_conflict",
              "Focused Knowledge result could not be durably settled"
            );
          }
        }

        if (!focusedUsageAccounted) {
          for (const attribution of knowledgeUsageAttributionsFromToolResult(result)) {
            rememberReportedUsage(attribution.provider, attribution.modelId, attribution.usage);
          }
          usageAccountedToolCallIds.add(persisted.id);
          await persistReportedUsageForIncompleteRun();
        }
        const evidence = knowledgeEvidenceFromToolResult(result);
        if (result.status !== "complete" || !evidence) {
          throw new RunPipelineError(
            "knowledge_retrieval_failed",
            "Focused Knowledge retrieval failed"
          );
        }
        if (evidence.results.length < 1) {
          throw new RunPipelineError(
            "no_retrieval_candidates",
            "No Knowledge retrieval candidates were found"
          );
        }
        let dispatchDraft: KnowledgeEvidenceDispatchManifestDraft;
        try {
          dispatchDraft = focusedKnowledgeEvidenceDispatchDraft({
            exclusions: input.prepared.knowledgeAdmissionPlan.exclusions,
            request: answerRequest,
            result
          });
        } catch (error) {
          const code = error instanceof Error &&
            error.message === "no_retrieval_candidates"
            ? "no_retrieval_candidates"
            : "knowledge_retrieval_failed";
          throw new RunPipelineError(code, "Focused Knowledge evidence could not be prepared");
        }
        return {
          dispatchDraft,
          evidenceBindings: null,
          request: await requestWithKnowledgeEvidenceMessage(
            answerRequest,
            knowledgeEvidenceMessageFromDispatchDraft(dispatchDraft)
          )
        };
      }

      function providerNeutralKnowledgeRequest(
        operation: ProviderStructuredOutputRequest
      ): ProviderRunRequest {
        return {
          ...input.prepared.providerRequest,
          attachmentIds: [],
          attachments: [],
          content: textMessageContent(operation.userPrompt),
          context: undefined,
          knowledgeAnswering: undefined,
          knowledgeFocusedRequest: undefined,
          mcp: undefined,
          mcpDiscovery: undefined,
          params: knowledgeGroundingProviderParams({
            baseParams: input.prepared.providerRequest.params,
            operation
          }),
          personalContext: undefined,
          prompt: {
            developer: null,
            system: operation.systemPrompt
          },
          searchPlan: { mode: "all_selected", options: [] },
          toolChoice: "none",
          toolMode: "none",
          tools: undefined
        };
      }

      async function authorizeKnowledgeAnswerOperation(): Promise<void> {
        await assertProjectRunAccessCurrent(true);
        if (!(await currentAnswerDispatchAllowed())) {
          throw new RunPipelineError(
            "model_not_available",
            "The selected model is no longer available"
          );
        }
        if (!(await currentKnowledgeDispatchAllowed())) {
          throw new RunPipelineError(
            "memory_egress_destination_revoked",
            "Knowledge access changed before answer-provider dispatch"
          );
        }
        if (egressReceiptRequired && !input.memoryEgress &&
          process.env.NODE_ENV === "production") {
          throw new RunPipelineError(
            "memory_egress_receipt_unavailable",
            "Memory egress evidence is unavailable."
          );
        }
      }

      async function executeKnowledgeStructuredOutput(
        operation: ProviderStructuredOutputRequest
      ): Promise<KnowledgeAnswerOperationExecutionV8> {
        const dispatchRequest = providerNeutralKnowledgeRequest(operation);
        const operationSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(120_000)
        ]);
        const receipt = input.memoryEgress && egressReceiptRequired
          ? await input.memoryEgress.beginDispatch({
              destinationKind: "answer_provider",
              destinationSnapshot: {
                modelId: normalizedRequest.modelId,
                operation: operation.name,
                provider: normalizedRequest.provider,
                version: 1
              },
              mode: "PROVIDER_REQUEST",
              requestEvidence: memoryEgressRequestEvidence(dispatchRequest),
              requestPreview: {
                operation: operation.name,
                requestHash: memorySha256(operation)
              },
              runId,
              userId: input.userId
            })
          : null;
        try {
          let providerResponseId: string | null = null;
          let reportedUsage: ModelRunUsage = {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0
          };
          let output: Readonly<Record<string, unknown>>;
          if (input.structuredOutputAdapter) {
            output = await input.structuredOutputAdapter.execute(operation, {
              onProviderResponseId(value) {
                providerResponseId = value;
              },
              onUsage(value) {
                reportedUsage = value;
              },
              signal: operationSignal,
              timeoutMs: 120_000
            });
          } else {
            const stream = input.adapter.stream(dispatchRequest, {
              signal: operationSignal
            });
            let next = await stream.next();
            while (!next.done) {
              const eventResponseId = providerResponseIdFromEvent(next.value);
              if (eventResponseId) providerResponseId = eventResponseId;
              if (next.value.type === "usage") reportedUsage = next.value.data;
              next = await stream.next();
            }
            if ((next.value.toolCalls?.length ?? 0) > 0) {
              throw new Error("structured_output_tools_forbidden");
            }
            providerResponseId = next.value.providerResponseId ?? providerResponseId;
            reportedUsage = next.value.usage;
            output = parseProviderStructuredOutputObject(next.value.finalText);
          }
          if (providerResponseId) await publishProviderResponseId(providerResponseId);
          if (receipt && !(await input.memoryEgress!.completeDispatch(receipt.id))) {
            throw new RunPipelineError(
              "memory_egress_receipt_conflict",
              "Provider dispatch evidence could not be completed."
            );
          }
          return Object.freeze({
            output,
            providerResponseId,
            usage: normalizeTokenUsage(reportedUsage)
          });
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

      async function runAutomaticKnowledgeAnswer(inputRequest: Readonly<{
        dispatchDraft: KnowledgeEvidenceDispatchManifestDraft;
        evidenceBindings: readonly KnowledgeEvidenceDispatchBinding[] | null;
        routeInstruction?: string;
      }>): Promise<Readonly<{
        contracts: KnowledgeAnswerFinalizationContracts;
        result: ProviderRunResult & { usageAttributions: RunUsageAttribution[] };
      }>> {
        const pipeline = selectKnowledgeAnswerPipelineForNewRun({ modelRunId: runId });
        const groundingUnavailable = !input.knowledgeProviderDispatch ||
          (pipeline === "v20_v16" && !input.repository.groundKnowledgeAnswerV5) ||
          (pipeline === "v21_scope_v6" && !input.repository.groundKnowledgeAnswerV21);
        if (groundingUnavailable) {
          throw new RunPipelineError(
            pipeline === "v20_v16"
              ? "knowledge_answer_v5_unavailable"
              : "knowledge_answer_grounding_unavailable",
            pipeline === "v20_v16"
              ? "Knowledge answer grounding V5 is unavailable"
              : "Knowledge answer grounding is unavailable"
          );
        }
        const requestText = textFromContentBlocks(normalizedRequest.content).trim();
        if (!requestText) {
          throw new RunPipelineError(
            "knowledge_answer_request_invalid",
            "The effective Knowledge request is empty"
          );
        }
        const reasoningEffort = knowledgeGroundingInheritedReasoningEffortV1({
          acceptedReasoningEffort: normalizedRequest.reasoningEffort,
          params: normalizedRequest.params
        });
        const groundingExecutionPolicy = pipeline === "v21_scope_v6"
          ? resolveKnowledgeGroundingExecutionPolicyV1({
              inheritedReasoningEffort: reasoningEffort,
              modelCapabilities: normalizedRequest.modelCapabilities,
              ...(input.knowledgeGroundingExecutionPolicy
                ? { policy: input.knowledgeGroundingExecutionPolicy }
                : {})
            })
          : null;
        const executionInput = {
          authorize: authorizeKnowledgeAnswerOperation,
          draft: inputRequest.dispatchDraft,
          ...(inputRequest.evidenceBindings
            ? { evidenceBindings: inputRequest.evidenceBindings }
            : {}),
          execute: executeKnowledgeStructuredOutput,
          forbiddenIdentityFragments: [
            runId,
            ...inputRequest.dispatchDraft.items.map((item) => item.evidenceId),
            ...(input.prepared.knowledgeAdmissionPlan?.sources ?? []).flatMap((source) => [
              source.sourceId,
              source.sourceVersionId,
              source.sourceArtifactId
            ])
          ],
          lifecycle: input.knowledgeProviderDispatch,
          modelRunId: runId,
          ...(groundingExecutionPolicy
            ? { executionPolicy: groundingExecutionPolicy }
            : { reasoningEffort }),
          request: requestText,
          routeInstruction: inputRequest.routeInstruction ?? (fullContextPlan
            ? KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION
            : KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION),
          shouldAbort: () => signal.aborted,
          transport: input.structuredOutputAdapter
            ? "native_strict"
            : "provider_neutral_json"
        } as const;
        const operationResult = pipeline === "v21_scope_v6"
          ? await executeKnowledgeAnswerGroundingV21(executionInput)
          : await executeKnowledgeAnswerGroundingV8(executionInput);
        const contractConflict = pipeline === "v20_v16"
          ? operationResult.contracts.draftContractVersion !== 20 ||
            operationResult.contracts.selectorContractVersion !== 16
          : operationResult.contracts.draftContractVersion !== 21 ||
            operationResult.contracts.selectorContractVersion !== 21 ||
            !("coverageAuditorContractVersion" in operationResult.contracts) ||
            operationResult.contracts.coverageAuditorContractVersion !== 6 ||
            operationResult.contracts.settlementVersion !== 6;
        if (contractConflict) {
          throw new RunPipelineError(
            "knowledge_answer_contract_conflict",
            "The current Knowledge answer run returned an unexpected contract pair"
          );
        }
        const usageAttributions = operationResult.operations.map((operation) => ({
          modelId: normalizedRequest.modelId,
          provider: normalizedRequest.provider,
          usage: operation.usage
        }));
        for (const operation of operationResult.operations) {
          rememberReportedUsage(
            normalizedRequest.provider,
            normalizedRequest.modelId,
            operation.usage
          );
        }
        const usage = sumTokenUsage(usageAttributions.map((entry) => entry.usage));
        return Object.freeze({
          contracts: operationResult.contracts,
          result: {
            finalText: "",
            finalProviderResponsePreview: pipeline === "v21_scope_v6"
              ? {
                  coverageAuditorContractVersion: 6,
                  draftContractVersion: 21,
                  selectorContractVersion: 21,
                  settlementVersion: 6,
                  structuredKnowledgeAnswer: true
                }
              : {
                  draftContractVersion: 20,
                  selectorContractVersion: 16,
                  structuredKnowledgeAnswer: true
                },
            ...((operationResult.operations.at(-1)?.providerResponseId ??
              operationResult.operations[0]?.providerResponseId)
              ? {
                  providerResponseId: operationResult.operations.at(-1)?.providerResponseId ??
                    operationResult.operations[0]!.providerResponseId!
                }
              : {}),
            usage,
            usageAttributions
          }
        });
      }

      async function currentMcpDispatchAllowed(inputRoute: Readonly<{
        fingerprint: string;
        namespacedName: string;
        originalName: string;
        serverId: string;
      }>, generationId: string): Promise<boolean> {
        if (!input.mcp) return process.env.NODE_ENV !== "production";
        try {
          const current = input.prepared.project?.executionScope === "project" && input.mcp.prepareProject
            ? await input.mcp.prepareProject([inputRoute.serverId])
            : input.prepared.project?.executionScope === "project"
              ? null
              : await input.mcp.prepare(input.userId, { allowedServerIds: [inputRoute.serverId] });
          if (!current || !current.ok) return false;
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
        let preview: Record<string, unknown> | null = null;
        const requestPreview = () => {
          preview ??= input.adapter.buildRequestPreview(request);
          return preview;
        };
        await assertProjectRunAccessCurrent(true);
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
        let receipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
        try {
          receipt = input.memoryEgress && egressReceiptRequired
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
          await assertProjectRunAccessCurrent(true);
          const stream = input.adapter.stream(request, { signal: dispatchSignal });
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
      ): Promise<ProviderRunResult & {
        knowledgeDispatchDraft?: KnowledgeEvidenceDispatchManifestDraft;
        knowledgeEvidenceEmpty?: true;
        knowledgeSearchUnavailable?: true;
        usageAttributions: RunUsageAttribution[];
      }> {
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
        const isSearchCall = (name: string) =>
          searchPlanRouter?.accepts(name) === true;
        const knowledgeTools = clientToolsEnabled && admittedKnowledgeReady
          ? input.knowledgeExecutor?.tools ?? []
          : [];
        const isKnowledgeCall = (name: string) =>
          knowledgeTools.length > 0 && input.knowledgeExecutor?.accepts(name) === true;
        const workspace = normalizedRequest.workspace;
        if (workspace && !input.workspace) {
          throw new RunPipelineError(
            "workspace_runtime_unavailable",
            "Workspace execution is unavailable"
          );
        }
        const workspaceTools = clientToolsEnabled && workspace && input.workspace
          ? await input.workspace.tools({
              runId,
              userId: input.userId,
              workspace
            })
          : [];
        const isWorkspaceCall = (name: string) =>
          Boolean(workspace && input.workspace?.accepts({ name, workspace }));
        let activeMcpSnapshot = normalizedRequest.mcp;
        let activeMcpDiscovery = normalizedRequest.mcpDiscovery;
        const materializeMcpTools = input.mcp?.materialize;
        const mcpRouter = input.mcp?.router;
        const appendMcpDiscoveryEpoch = input.repository.appendMcpDiscoveryEpoch;
        if (activeMcpDiscovery && (!materializeMcpTools || !appendMcpDiscoveryEpoch)) {
          throw new RunPipelineError(
            "mcp_discovery_not_available",
            "MCP discovery is not available"
          );
        }
        const isMcpDiscoveryCall = (name: string) =>
          name === MCP_FIND_TOOLS_NAME && activeMcpDiscovery !== undefined;
        const tools: RunTool[] = [
          ...knowledgeTools,
          ...(searchPlanRouter?.tools ?? []),
          ...(activeMcpDiscovery ? [mcpFindToolsTool] : []),
          ...(clientToolsEnabled ? mcpRunTools(activeMcpSnapshot) : []),
          ...workspaceTools
        ];
        if (tools.length === 0) {
          throw new RunPipelineError("tool_configuration_empty", "No run tools are configured");
        }

        const persistedCalls = new Map<string, PersistedToolLoopCall>();
        const knowledgeToolResults = new Map<string, ToolExecutionResult>();
        const mcpDiscoveryBatches = new Map<string, Readonly<{
          calls: readonly Readonly<{
            call: ModelToolCall;
            modelRunToolCallId: string;
          }>[];
          execute(): Promise<ReadonlyMap<string, ToolExecutionResult>>;
        }>>();
        let mcpDiscoveryQueue = Promise.resolve();
        const serializeMcpDiscovery = async <T>(operation: () => Promise<T>): Promise<T> => {
          const result = mcpDiscoveryQueue.then(operation, operation);
          mcpDiscoveryQueue = result.then(() => undefined, () => undefined);
          return result;
        };
        const hasMcpTools = tools.some((tool) =>
          tool.capability === "mcp" || tool.capability === "workspace"
        );
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
            return streamAnswerProviderWithEgress(
              request,
              options?.signal ?? signal
            );
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
            await assertProjectRunAccessCurrent(true);
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
                const persistedCall = persistedCalls.get(call.id);
                if (persistedCall && persistedCall.usageAccountedAt == null) {
                  usageAccountedToolCallIds.add(persistedCall.id);
                }
              }
              if (isKnowledgeCall(call.name)) {
                knowledgeToolResults.set(call.id, result);
                for (const attribution of knowledgeUsageAttributionsFromToolResult(result)) {
                  rememberReportedUsage(
                    attribution.provider,
                    attribution.modelId,
                    attribution.usage
                  );
                }
                const persistedCall = persistedCalls.get(call.id);
                if (persistedCall && persistedCall.usageAccountedAt == null) {
                  usageAccountedToolCallIds.add(persistedCall.id);
                }
              }
              for (const artifact of result.artifacts ?? []) {
                await emit(controller, encoder, input.repository, runId, artifact);
              }
            }
            await persistReportedUsageForIncompleteRun();
          },
          beforeProviderRound: async ({ continuation, request: roundRequest, round }) => {
            await assertProjectRunAccessCurrent(true);
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
            maxToolCalls: toolBudgets.maxToolCalls,
            maxToolRounds: toolBudgets.maxToolRounds
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
                if (stored && isKnowledgeCall(call.name) &&
                  knowledgeEvidenceFromToolResult(stored) && input.memoryEgress &&
                  !(await input.memoryEgress.settleRecoveredToolDispatch({
                    modelRunToolCallId: claim.call.id,
                    outcome: "COMPLETED",
                    runId,
                    userId: input.userId
                  }))) {
                  return {
                    error: {
                      code: "memory_egress_receipt_conflict",
                      fatal: true,
                      message: "The Knowledge egress receipt could not be settled."
                    },
                    status: "error"
                  };
                }
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

              await assertProjectRunAccessCurrent(true);

              let result: ToolExecutionResult;
              let fatalToolError: Readonly<{
                code: string;
                fatal: true;
                message: string;
              }> | null = null;
              let externalReceipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
              try {
                if (hasInvalidProviderToolArguments(call.arguments)) {
                  throw new Error("provider_tool_arguments_invalid");
                }
                const executionContext = {
                  persistedToolCallId: claim.call.id,
                  request,
                  runId,
                  userId: input.userId
                };
                let preflightResult: ToolExecutionResult | null = null;
                if (isKnowledgeCall(call.name)) {
                  try {
                    const admission = await input.knowledgeExecutor!.preflight?.(
                      call,
                      executionContext
                    );
                    if (admission && admission.kind !== "admitted") {
                      preflightResult = admission.result;
                    }
                  } catch (error) {
                    preflightResult = toolExecutionErrorResult(call, error, "Knowledge");
                  }
                }
                const externalCall = !preflightResult && !isMcpDiscoveryCall(call.name);
                if (externalCall) {
                  if (!input.memoryEgress && process.env.NODE_ENV === "production") {
                    throw new Error("memory_egress_receipt_unavailable");
                  }
                  const destinationSnapshot = isKnowledgeCall(call.name)
                    ? {
                        kind: "knowledge",
                        scopeFingerprint: input.prepared.knowledgeAdmissionPlan?.fingerprint ?? null,
                        selection: normalizedRequest.knowledgePlan,
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
                      : isWorkspaceCall(call.name)
                        ? {
                            internetEnabled: workspace!.internetEnabled,
                            kind: "workspace",
                            sessionId: workspace!.sessionId,
                            toolCatalogHash: workspace!.toolCatalogHash,
                            toolName: call.name,
                            version: 1
                          }
                      : (() => {
                          const mcpRoute = resolveMcpRunTool(activeMcpSnapshot, call.name);
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
                      : isWorkspaceCall(call.name)
                        ? Promise.resolve(claim.call.workspaceBindingId === runId)
                      : (() => {
                          const route = resolveMcpRunTool(activeMcpSnapshot, call.name);
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
                    if (isKnowledgeCall(call.name)) {
                      fatalToolError = {
                        code: "memory_egress_destination_revoked",
                        fatal: true,
                        message: "Knowledge access changed before retrieval."
                      };
                    }
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
                if (preflightResult) {
                  result = preflightResult;
                } else if (isMcpDiscoveryCall(call.name)) {
                  const batch = mcpDiscoveryBatches.get(call.id);
                  if (batch) {
                    const results = await batch.execute();
                    const coalesced = results.get(call.id);
                    if (!coalesced) throw new Error("mcp_discovery_checkpoint_conflict");
                    result = coalesced;
                  } else {
                    result = await serializeMcpDiscovery(async () => {
                    const discovery = activeMcpDiscovery;
                    if (!discovery || !materializeMcpTools || !appendMcpDiscoveryEpoch) {
                      throw new Error("mcp_discovery_arguments_invalid");
                    }
                    const executed = await executeDurableMcpDiscovery({
                      activeDiscovery: discovery,
                      ...(activeMcpSnapshot ? { activeSnapshot: activeMcpSnapshot } : {}),
                      appendEpoch: appendMcpDiscoveryEpoch,
                      call,
                      materialize: materializeMcpTools,
                      maxResults: toolBudgets.maxMcpToolsPerDiscovery,
                      modelRunToolCallId: claim.call.id,
                      onUsage(attribution) {
                        rememberReportedUsage(
                          attribution.provider,
                          attribution.modelId,
                          attribution.usage
                        );
                      },
                      request,
                      roundIndex: context.round,
                      router: mcpRouter,
                      runId,
                      signal: context.signal,
                      timeoutMs: toolBudgets.mcpAutoDiscoveryTimeoutSeconds * 1_000,
                      userId: input.userId
                    });
                    activeMcpSnapshot = executed.snapshot;
                    activeMcpDiscovery = executed.discovery;
                    normalizedRequest.mcp = executed.snapshot;
                    normalizedRequest.mcpDiscovery = executed.discovery;
                    const knownToolNames = new Set(tools.map((tool) => tool.name));
                    for (const tool of mcpRunTools(executed.snapshot)) {
                      if (!knownToolNames.has(tool.name)) {
                        tools.push(tool);
                        knownToolNames.add(tool.name);
                      }
                    }
                    return executed.toolResult;
                    });
                  }
                } else if (searchPlanRouter?.accepts(call.name)) {
                  result = await searchPlanRouter.execute(
                    call,
                    request,
                    { signal: context.signal }
                  );
                } else if (isKnowledgeCall(call.name)) {
                  result = await input.knowledgeExecutor!.execute(
                    call,
                    executionContext,
                    {
                      signal: AbortSignal.any([
                        context.signal,
                        AbortSignal.timeout(KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS)
                      ])
                    }
                  );
                } else if (workspace && isWorkspaceCall(call.name)) {
                  if (claim.call.workspaceBindingId !== runId) {
                    throw new Error("workspace_run_binding_unavailable");
                  }
                  result = await input.workspace!.execute({
                    call,
                    modelRunToolCallId: claim.call.id,
                    onActivity: onWorkspaceActivity,
                    runId,
                    signal: context.signal,
                    userId: input.userId,
                    workspace
                  });
                } else {
                  const route = resolveMcpRunTool(activeMcpSnapshot, call.name);
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
                // A local deadline on read-only Knowledge retrieval is a known
                // technical result and must be durably settled. Only the
                // parent run cancellation, or an abort from a potentially
                // side-effecting non-Knowledge tool, remains crash-ambiguous.
                if (signal.aborted ||
                  isAbortError(error) && !isKnowledgeCall(call.name)) throw error;
                if (error instanceof McpAutoDiscoveryUnavailableError) {
                  fatalToolError = {
                    code: error.code,
                    fatal: true,
                    message: error.message
                  };
                  result = toolExecutionErrorResult(call, error);
                } else {
                  result = toolExecutionErrorResult(
                    call,
                    error,
                    isKnowledgeCall(call.name)
                      ? "Knowledge"
                      : isSearchCall(call.name)
                        ? "Search"
                        : isWorkspaceCall(call.name) ? "Workspace" : "Tool"
                  );
                }
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
              if (fatalToolError) {
                return { error: fatalToolError, status: "error" };
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
            answerStartMarked = false;
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
                const route = resolveMcpRunTool(activeMcpSnapshot, call.name);
                if (!route && !isKnowledgeCall(call.name) &&
                  !isSearchCall(call.name) && !isMcpDiscoveryCall(call.name) &&
                  !isWorkspaceCall(call.name)) {
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
                  toolName: call.name,
                  ...(isWorkspaceCall(call.name) ? { workspace: true as const } : {})
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
            const discoveryCalls = calls.flatMap((candidate) => {
              const call = modelToolCall(candidate);
              const persistedCall = persistedCalls.get(call.id);
              return call.name === MCP_FIND_TOOLS_NAME && persistedCall &&
                mcpFindToolsArguments(call.arguments)
                ? [{ call, modelRunToolCallId: persistedCall.id }]
                : [];
            });
            if (discoveryCalls.length > 1) {
              let execution: Promise<ReadonlyMap<string, ToolExecutionResult>> | null = null;
              const batch = {
                calls: discoveryCalls,
                execute() {
                  execution ??= serializeMcpDiscovery(async () => {
                    const discovery = activeMcpDiscovery;
                    if (!discovery || !materializeMcpTools || !appendMcpDiscoveryEpoch) {
                      throw new Error("mcp_discovery_arguments_invalid");
                    }
                    const executed = await executeDurableMcpDiscoveryBatch({
                      activeDiscovery: discovery,
                      ...(activeMcpSnapshot ? { activeSnapshot: activeMcpSnapshot } : {}),
                      appendEpoch: appendMcpDiscoveryEpoch,
                      calls: discoveryCalls,
                      materialize: materializeMcpTools,
                      maxResults: toolBudgets.maxMcpToolsPerDiscovery,
                      onUsage(attribution) {
                        rememberReportedUsage(
                          attribution.provider,
                          attribution.modelId,
                          attribution.usage
                        );
                      },
                      request,
                      roundIndex: round,
                      router: mcpRouter,
                      runId,
                      signal,
                      timeoutMs: toolBudgets.mcpAutoDiscoveryTimeoutSeconds * 1_000,
                      userId: input.userId
                    });
                    activeMcpSnapshot = executed.snapshot;
                    activeMcpDiscovery = executed.discovery;
                    normalizedRequest.mcp = executed.snapshot;
                    normalizedRequest.mcpDiscovery = executed.discovery;
                    const knownToolNames = new Set(tools.map((tool) => tool.name));
                    for (const tool of mcpRunTools(executed.snapshot)) {
                      if (!knownToolNames.has(tool.name)) {
                        tools.push(tool);
                        knownToolNames.add(tool.name);
                      }
                    }
                    return executed.toolResults;
                  });
                  return execution;
                }
              } as const;
              for (const candidate of discoveryCalls) {
                mcpDiscoveryBatches.set(candidate.call.id, batch);
              }
            }
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
              const route = resolveMcpRunTool(activeMcpSnapshot, call.name);
              const builtInServer = call.name === "find_tools"
                ? "Auto tools"
                : isKnowledgeCall(call.name)
                  ? "Knowledge"
                  : isWorkspaceCall(call.name)
                    ? "Workspace"
                : call.name.includes("memory")
                    ? "Memory"
                    : call.name.startsWith("search_engine_")
                      ? "Web search"
                      : undefined;
              const workspaceToolName = isWorkspaceCall(call.name)
                ? workspaceToolNameFromNamespaced(call.name)
                : null;
              await emit(
                controller,
                encoder,
                input.repository,
                runId,
                liveToolCallStatus(modelToolCall(call), {
                  round,
                  ...(route ? {
                    serverName: route.tool.serverName,
                    toolName: route.originalName
                  } : builtInServer ? {
                      serverName: builtInServer,
                      ...(workspaceToolName ? { toolName: workspaceToolName } : {})
                    } : {})
                })
              );
            }
          },
          prepareRequest: async (roundRequest, round) => {
            const budgeted = applyProviderRequestContextBudget({
              bridge: toolBridge,
              request: {
                ...roundRequest,
                ...(activeMcpDiscovery && round === 1
                  ? { parallelToolCalls: false }
                  : {}),
                ...(activeMcpSnapshot ? { mcp: activeMcpSnapshot } : {}),
                ...(activeMcpDiscovery ? { mcpDiscovery: activeMcpDiscovery } : {})
              }
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
        let knowledgeDispatchDraft: KnowledgeEvidenceDispatchManifestDraft | undefined;
        let knowledgeEvidenceEmpty = false;
        let knowledgeSearchUnavailable = false;
        if (knowledgeToolResults.size > 0) {
          const results = [...knowledgeToolResults.entries()]
            .sort(([leftId], [rightId]) => {
              const left = persistedCalls.get(leftId);
              const right = persistedCalls.get(rightId);
              if (!left || !right) return leftId.localeCompare(rightId);
              return left.roundIndex - right.roundIndex || left.ordinal - right.ordinal;
            })
            .map(([, result]) => result);
          knowledgeSearchUnavailable = results.some((result) =>
            knowledgeEvidenceFromToolResult(result)?.outcome === "search_unavailable");
          try {
            knowledgeDispatchDraft = toolLoopKnowledgeEvidenceDispatchDraft({
              request,
              results
            }) ?? undefined;
            knowledgeEvidenceEmpty = knowledgeDispatchDraft === undefined;
          } catch (error) {
            throw new RunPipelineError(
              error instanceof Error && error.message === "no_retrieval_candidates"
                ? "no_retrieval_candidates"
                : "knowledge_retrieval_failed",
              "The final Knowledge tool evidence could not be prepared"
            );
          }
        }
        return {
          ...outcome.final,
          ...(knowledgeDispatchDraft ? { knowledgeDispatchDraft } : {}),
          ...(knowledgeEvidenceEmpty ? { knowledgeEvidenceEmpty: true as const } : {}),
          ...(knowledgeSearchUnavailable ? { knowledgeSearchUnavailable: true as const } : {}),
          usage: sumTokenUsage(reportedUsageAttributions.map((attribution) => attribution.usage)),
          usageAttributions: groupedUsageAttributions(reportedUsageAttributions)
        };
      }

      try {
        throwIfAborted(signal);
        await assertProjectRunAccessCurrent(true);
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
        if (normalizedRequest.memoryActionTools !== undefined ||
          normalizedRequest.memoryHistoryTool !== undefined ||
          input.prepared.providerRequest.memoryActionTools !== undefined ||
          input.prepared.providerRequest.memoryHistoryTool !== undefined) {
          throw new RunPipelineError(
            "memory_answer_model_tools_retired",
            "This run uses a retired answer-model Memory tool contract."
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
        const hasClientKnowledge = !groundedKnowledgeAnswer && clientToolsEnabled &&
          admittedKnowledgeReady &&
          normalizedRequest.knowledgePlan.mode !== "none";
        const hasClientTools = hasClientKnowledge || hasClientSearch ||
          (clientToolsEnabled && (normalizedRequest.mcp?.tools.length ?? 0) > 0) ||
          normalizedRequest.mcpDiscovery !== undefined ||
          normalizedRequest.workspace !== undefined;
        const preparedProviderRequest = await requestWithAutomaticKnowledgeEvidence(
          input.prepared.providerRequest
        );
        const providerRequest = preparedProviderRequest.request;
        assertPersonalContextEgressSafe(providerRequest);
        let knowledgeZeroEvidence = false;
        let knowledgeAnswerExecution = groundedKnowledgeAnswer
          ? preparedProviderRequest.dispatchDraft
            ? await runAutomaticKnowledgeAnswer({
                dispatchDraft: preparedProviderRequest.dispatchDraft,
                evidenceBindings: preparedProviderRequest.evidenceBindings
              })
            : (() => {
                throw new RunPipelineError(
                  "knowledge_evidence_receipt_invalid",
                  "The Knowledge answer evidence manifest is unavailable"
                );
              })()
          : null;
        let providerResult: ProviderRunResult & {
          usageAttributions?: RunUsageAttribution[];
        };
        if (knowledgeAnswerExecution) {
          providerResult = knowledgeAnswerExecution.result;
        } else if (hasClientTools) {
          const toolLoopResult = await runProviderToolLoop(providerRequest);
          if (hasClientKnowledge) {
            if (!toolLoopResult.knowledgeDispatchDraft) {
              if (!toolLoopResult.knowledgeEvidenceEmpty) {
                throw new RunPipelineError(
                  "knowledge_retrieval_required",
                  "The Knowledge tool loop ended without settled evidence"
                );
              }
              const {
                knowledgeDispatchDraft: _knowledgeDispatchDraft,
                knowledgeEvidenceEmpty: _knowledgeEvidenceEmpty,
                knowledgeSearchUnavailable: _knowledgeSearchUnavailable,
                ...emptyResult
              } = toolLoopResult;
              void _knowledgeDispatchDraft;
              void _knowledgeEvidenceEmpty;
              void _knowledgeSearchUnavailable;
              knowledgeZeroEvidence = true;
              providerResult = {
                ...emptyResult,
                finalText: toolLoopResult.knowledgeSearchUnavailable
                  ? KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE
                  : KNOWLEDGE_INSUFFICIENT_MESSAGE
              };
            } else {
              knowledgeAnswerExecution = await runAutomaticKnowledgeAnswer({
                dispatchDraft: toolLoopResult.knowledgeDispatchDraft,
                evidenceBindings: null,
                routeInstruction: KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION
              });
              providerResult = knowledgeAnswerExecution.result;
            }
          } else {
            const { knowledgeDispatchDraft: _knowledgeDispatchDraft, ...ordinaryResult } =
              toolLoopResult;
            void _knowledgeDispatchDraft;
            providerResult = ordinaryResult;
          }
        } else {
          providerResult = await streamProviderRequest(providerRequest);
        }
        // First-turn chat title (UX audit 2026-09-02 #4): the System Model
        // names the chat before the run settles so its usage lands in this
        // run's own accounting; any failure keeps the heuristic title.
        if (input.chatTitleGenerator && providerResult.finalText) {
          const titleOutcome = await input.chatTitleGenerator.generate({
            answerText: providerResult.finalText,
            chatId: normalizedRequest.chatId,
            userId: input.userId,
            userMessageId: input.created.userMessageId
          }, { signal }).catch(() => null);
          if (titleOutcome && titleOutcome.status !== "skipped" && titleOutcome.usage) {
            rememberReportedUsage(titleOutcome.usage.provider, titleOutcome.usage.modelId, titleOutcome.usage.usage);
          }
        }
        const attributedProviderResult = {
          ...providerResult,
          usage: sumTokenUsage(reportedUsageAttributions.map((attribution) => attribution.usage)),
          usageAttributions: groupedUsageAttributions(reportedUsageAttributions)
        };

        await tokenBuffer.flush();
        throwIfAborted(signal);
        await assertProjectRunAccessCurrent(true);
        if (normalizedRequest.workspace) {
          if (!input.workspace) {
            throw new RunPipelineError(
              "workspace_runtime_unavailable",
              "Workspace execution is unavailable"
            );
          }
          // Output publication is not on the answer's critical path: a
          // busy or failed export leaves the binding in a retryable state for
          // background recovery while the answer itself completes.
          await input.workspace.finalize({
            onActivity: onWorkspaceActivity,
            runId,
            signal,
            userId: input.userId,
            workspace: normalizedRequest.workspace
          });
          await settleWorkspace("completed");
        }
        const persistedProviderResult = groundedLiveOnly
          ? {
              ...attributedProviderResult,
              finalText: GROUNDED_LIVE_ONLY_PLACEHOLDER
            }
          : attributedProviderResult;
        const finalization = await finalizeRunCompletion({
          ...(knowledgeAnswerExecution
            ? { knowledgeAnswerContracts: knowledgeAnswerExecution.contracts }
            : {}),
          ...(knowledgeZeroEvidence ? { knowledgeZeroEvidence: true as const } : {}),
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

        if (knowledgeCitationAnswer && finalization.finalText) {
          emitTransient(controller, encoder, {
            data: { delta: finalization.finalText },
            type: "token"
          });
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
        const workspaceTurnTimedOut = workspaceTurnController?.signal.aborted === true &&
          !abortController.signal.aborted;
        if (abortController.signal.aborted || isAbortError(error) && !workspaceTurnTimedOut) {
          await input.repository.cancelPendingToolLoopCalls({ runId, userId: input.userId }).catch(() => undefined);
          await settleWorkspace("cancelled");
          await tokenBuffer.flush().catch(() => undefined);
          await persistReportedUsageForIncompleteRun().catch(() => undefined);
          return;
        }

        if (workspaceTurnTimedOut) {
          await input.repository.cancelPendingToolLoopCalls({
            runId,
            userId: input.userId
          }).catch(() => undefined);
        }
        await settleWorkspace(workspaceTurnTimedOut ? "timed_out" : "failed");
        let failure = workspaceTurnTimedOut
          ? workspaceTurnController.signal.reason
          : error;
        const originalStreamSafetyReport = providerStreamSafetyReport(error);
        try {
          await tokenBuffer.flush();
        } catch (flushError) {
          if (!originalStreamSafetyReport) failure = flushError;
        }

        const deadlineExceeded = isProviderDeadlineExceededError(failure);
        const pipelineError = failure instanceof RunPipelineError ? failure : null;
        const streamSafetyReport = providerStreamSafetyReport(failure);
        const contractFailureCode = isRecord(failure) &&
          (failure.code === "knowledge_answer_contract_failed" ||
            failure.code === "knowledge_citation_contract_failed")
          ? failure.code
          : null;
        const safetyCode = streamSafetyReport?.code ??
          (pipelineError && isProviderStreamSafetyCode(pipelineError.code)
            ? pipelineError.code
            : isRecord(failure) && isProviderStreamSafetyCode(failure.code)
              ? failure.code
              : null);
        const failureCode = contractFailureCode ??
          (groundedKnowledgeAnswer
            ? focusedKnowledgeFailureCode(failure)
            : pipelineError?.code ??
              (failure instanceof WorkspaceRuntimeError ? failure.code : null) ??
              (deadlineExceeded ? "provider_request_timed_out" : "provider_stream_failed"));
        const payload = safetyCode
          ? {
              code: safetyCode,
              message: providerStreamSafeMessage(safetyCode)
            }
          : {
              code: failureCode,
              message: groundedKnowledgeAnswer
                ? safeKnowledgeFailureMessage(failureCode)
                : failure instanceof Error ? failure.message : "Provider stream failed"
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
          safetyCode || deadlineExceeded || groundedKnowledgeAnswer ||
            failureCode === "memory_answer_model_tools_retired"
            ? { recoveryTerminal: true }
            : undefined
        );
        await persistReportedUsageForIncompleteRun().catch(() => undefined);
        if (failed) {
          emitTransient(controller, encoder, {
            data: payload,
            type: "error"
          });
        }
      } finally {
        if (workspaceTurnTimer) clearTimeout(workspaceTurnTimer);
        if (input.prepared.project) notifyProjectEvent(input.prepared.project.projectId);
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
