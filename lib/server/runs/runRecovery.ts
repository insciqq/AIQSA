import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { defaultToolObservations } from "../toolObservations/defaultService";
import { captureMcpObservation, captureWorkspaceObservation, captureSearchObservation, captureOwnedObservation, restoreObservedResult, projectObservationForProvider, type ToolObservationService } from "../toolObservations/sourceAdapters";
import { READ_TOOL_RESULT_NAME, readToolResultTool, executeReadToolResult } from "../tools/readToolResult";
import { defaultWorkspaceCheckpoints } from "../workspace/checkpoints";
import { CHECKPOINT_OUTPUTS_TOOL_NAME, checkpointOutputsTool } from "../tools/checkpointOutputs";
import { executionFailure } from "./executionFailure";
import { RunSettlementError, runSettlementFailure } from "./settlementFailure";
import { ANALYZE_IMAGE_TOOL_NAME, analyzeImageTool } from "../tools/analyzeImage";
import { defaultWorkspaceImageViewer } from "../workspace/directImageView";
import { VIEW_WORKSPACE_IMAGE, viewWorkspaceImageTool } from "../tools/viewWorkspaceImage";
import { agentFailureMessage } from "../agents/failures";
import { knowledgeAnswerInstructions, type KnowledgeAnswerInstructions } from "../knowledge/answerInstructions";
import { AsyncLocalStorage } from "node:async_hooks";
import { logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, runWithContext, type LifecycleStage } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { withKnowledgeToolDeadline } from "./knowledgeToolDeadline";
import { observedFailure, observedFailureCode } from "../providers/providerObservability";

import { filterMcpProviderRequest } from "../mcp/toolAccessProjection";
import { imageDispatchMustStop } from "../images/errors";
import { imageGenerationTool, IMAGE_GENERATION_TOOL_NAME } from "../tools/imageGeneration";
import { dispatchMcpTool } from "../mcp/toolExecutor";
import { currentMcpDispatchFailure, mcpDispatchError, type McpDispatchFailureCode } from "../mcp/dispatchStatus";
import { executeKnowledgeEvidenceAnswerV1, executeKnowledgeEvidenceAnswerWithRefinementV1 } from "../knowledge/evidenceAnswerExecutionV1";
import { knowledgeRefinementUsageAfter, refineKnowledgeEvidence } from "./knowledgeEvidenceRefinement";
import { decodeKnowledgeEvidenceAnswerSnapshot } from "../knowledge/evidenceAnswerSnapshot";
import {
  textFromContentBlocks,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import { textMessageContent } from "../../domain/content";
import { knowledgeSearchFailureCode, knowledgeSearchFailureMessage, knowledgeSearchFailureToolResult,
  knowledgeSearchFailureFromToolResult, knowledgeScopeLimitedMessage, isKnowledgeSearchFailureCode, type KnowledgeSearchFailureCode } from "../knowledge/searchFailure";
import {
  decodeTokenUsage, mergeTokenUsage, normalizeTokenUsage,
  subtractTokenUsage,
  sumTokenUsage
} from "../../domain/usage";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import type {
  McpDiscoveryState,
  McpRunPlanResult,
  McpRunPlanSnapshot
} from "../mcp/runPlan";
import { validateRunAccess } from "../auth/entitlements";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import {
  MCP_FIND_TOOLS_NAME,
  mcpFindToolsArguments,
  mcpFindToolsTool
} from "../mcp/discovery";
import { decodeMcpDiscoveryState } from "../mcp/discoveryState";
import {
  executeDurableMcpDiscovery,
  executeDurableMcpDiscoveryBatch,
  McpAutoDiscoveryUnavailableError
} from "../mcp/durableDiscovery";
import type { McpSemanticRouter } from "../mcp/router";
import { mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool } from "../mcp/toolExecutor";
import type {
  ProviderAdapter,
  ProviderRunRefreshResult,
  ProviderRunRequest,
  ProviderSearchAdapter
} from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import {
  parseProviderStructuredOutputObject,
  type ProviderStructuredOutputRequest
} from "../providers/structuredOutput";
import { DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS } from "../providers/providerConfiguration";
import {
  isProviderStreamSafetyCode,
  providerStreamSafeMessage,
  providerStreamSafetyReport,
  type ProviderStreamSafetyReport
} from "../providers/streamSafety";
import { warnProviderStreamSafetyOnce } from "../providers/streamSafetyObservability";
import type { ProviderRuntimeResolver } from "../providerRuntime/runtimeResolver";
import type { ProviderAdmissionPlan } from "../providerRuntime/admission";
import { providerToolBridges } from "../tools/bridges";
import {
  createSearchPlanToolRouter,
  SearchToolCancelledError,
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult,
  type SearchExecutionEvidence
} from "../search/toolExecutor";
import {
  type KnowledgeToolExecutor
} from "../knowledge/toolExecutor";
import type {
  KnowledgeProviderDispatchLifecycle,
  PreparedKnowledgeProviderDispatch
} from "../knowledge/providerDispatchLifecycle";
import {
  executeKnowledgeAnswerGroundingV8,
  KnowledgeAnswerOperationDeferredError,
  type KnowledgeAnswerOperationExecutionOptionsV8,
  type KnowledgeAnswerOperationExecutionV8
} from "../knowledge/answerGroundingExecutionV5";
import { executeKnowledgeAnswerGroundingV21 } from
  "../knowledge/answerGroundingExecutionV21ScopeV6";
import {
  decodeKnowledgeAnswerDraftPrompt,
  decodeKnowledgeAnswerOperationRequestSnapshotV1,
  knowledgeAnswerContractPairForDraftOperation,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  KNOWLEDGE_COVERAGE_PLANNER_OPERATION,
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_INSUFFICIENT_MESSAGE,
  KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE,
  KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION,
  type KnowledgeAnswerContractPair
} from "../knowledge/answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  decodeKnowledgeAnswerDraftPrimaryPromptV21,
  decodeKnowledgeAnswerOperationRequestSnapshotV21,
  isRecoverableKnowledgeAnswerOperationSnapshotV21
} from "../knowledge/answerGroundingV21";
import { selectKnowledgeAnswerPipelineForNewRun } from
  "../knowledge/answerPipelineRollout";
import {
  knowledgeGroundingInheritedReasoningEffortV1,
  resolveKnowledgeGroundingExecutionPolicyV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1
} from "../knowledge/groundingExecutionPolicy";
import { knowledgeGroundingProviderParams } from
  "../knowledge/groundingProviderParams";
import {
  type KnowledgeRunAdmissionAuthorizationSnapshot,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import type { MemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { memorySha256 } from "../memory/persistence/lexical";
import {
  FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID,
  KNOWLEDGE_EVIDENCE_MESSAGE_ID,
  focusedKnowledgeCallArgumentsMatch,
  focusedKnowledgeEvidenceDispatchDraft,
  isFocusedKnowledgeCall,
  knowledgeEvidenceMessageFromDispatchDraft,
  toolLoopKnowledgeEvidenceDispatchDraft,
  withAutomaticKnowledgeEvidence
} from "../knowledge/automaticEvidence";
import type {
  KnowledgeEvidenceDispatchBinding
} from "../knowledge/evidenceDispatchRepository";
import type {
  KnowledgeEvidenceDispatchManifestDraft
} from "../knowledge/evidenceDispatchManifest";
import { KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT } from "../knowledge/fullContext";
import { decodeKnowledgeFocusedRequest } from "../knowledge/focusedRequest";
import { knowledgeRetrievalToolsForRequest } from "../knowledge/knowledgeTools";
import {
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME
} from "../knowledge/retrievalTypes";
import {
  knowledgeEvidenceFromToolResult,
  knowledgeUsageAttributionsFromToolResult
} from "../knowledge/toolResult";
import {
  hasInvalidProviderToolArguments,
  type ModelToolCall,
  type RunTool,
  type ToolExecutionResult
} from "../tools/types";
import { artifactTool, readArtifactTool, READ_ARTIFACT_TOOL_NAME, ARTIFACT_TOOL_NAME } from "../tools/artifact";
import { acceptsSkillTool, isSkillToolName, skillToolsForRequest } from "../tools/skill";
import { createSkillToolResultBudget } from "../skills/toolResultBudget";
import { deliverSkillWorkspaceBundle } from "../skills/workspaceDelivery";
import type { StorageAdapter } from "../uploads/storage";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { workspaceActivityEvent } from "../workspace/activityProjection";
import { normalizeWorkspaceProviderToolName } from "../workspace/toolCatalog";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import {
  finalizeRunCompletion,
  usageAttributionsWithEstimatedCost
} from "./runFinalization";
import {
  providerToolLoopContinuationAfterResult,
  runProviderToolLoop,
  type ProviderToolLoopContinuation
} from "./providerToolLoop";
import { applyProviderRequestContextBudget, measureSessionContext } from "./runContextBudget";
import { executeSessionStatus, SESSION_STATUS_TOOL_NAME, sessionStatusTool } from "../tools/sessionStatus";
import type { ProviderToolBridge } from "../tools/types";
import { assertPersonalContextEgressSafe } from "../providers/personalContext";
import {
  memoryEgressRequestEvidence,
  requestHasHostedSearchCapability,
  requestHasServerExternalTools
} from "../providers/memoryEgress";
import { mcpResponseOverflowToolExecutionResult } from "./mcpOverflowToolResult";
import {
  getRunAttachmentLimits,
  type RunAttachmentLimits
} from "./attachmentLimits";
import {
  isAttachmentMaterializationError,
  loadProviderAttachments,
  validatePersistedAttachmentReferences
} from "./runAttachmentMaterialization";
import { withPinnedHostedSearchIdentity } from "./searchArtifactIdentity";
import type {
  FocusedKnowledgeRecoveryScope,
  RunRepository,
  RunUsageAttribution
} from "./runRepositoryContract";
import type { ToolLoopSettledCall } from "./toolLoop";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "./toolExecutionPersistence";
import {
  mergeAnswerRoundUsage,
  snapshotToolLoopJson,
  toolLoopPersistenceLimits,
  type CheckpointedToolLoopRun,
  type PersistedAnswerRoundUsage,
  type PersistedToolLoopCall,
  type ProjectRunRecoveryAuthority,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import { createRunTokenPersistenceBuffer } from "./runTokenPersistence";
import { TOOL_SYNTHESIS_FAILURE } from "../../contracts/runs";
import {
  projectRunOutputArtifactEvent,
  runOutputArtifactEvents
} from "./runOutputEvents";
import { toolRunBudgetsForRequest } from "./toolBudgets";
import { contextCompactionCheckpoint } from "./contextCompactionContract";
import { observationCallIdsInProviderMessages, observationHandlesInProviderMessages } from "./contextCompactionPlanner";
import { applyContextSummaryToRequest } from "./contextCompactionSummarizer";
import {
  applyKnowledgeAnswerContextBudget,
  contextCompactionArtifact,
  contextCompactionFailureOutcome,
  createContextCompactionPublisher,
  prepareCompactedProviderRequest
} from "./contextCompactionEvents";

export const activeRunStaleMs = 10 * 60 * 1000;

export type RunRecoveryRegistry = Readonly<{
  has(runId: string): boolean;
  ids(): readonly string[];
  register(runId: string): Readonly<{
    release(): void;
    signal: AbortSignal;
  }> | null;
}>;

export type RunRecoveryRepository = Pick<
  RunRepository,
  | "advanceToolLoopCallBatch"
  | "appendMcpDiscoveryEpoch"
  | "appendAssistantText"
  | "appendRunOutputEvent"
  | "claimToolLoopCall"
  | "completeRun"
  | "createSearchRun"
  | "failRun"
  | "findInstallationRecoverableRuns"
  | "findStaleActiveRunsForUser"
  | "getRunControlForUser"
  | "loadAttachments"
  | "loadCheckpointedToolLoopRun"
  | "loadFocusedKnowledgeCall"
  | "loadFocusedKnowledgeScopeExclusions"
  | "loadModelPricing"
  | "loadPublishedRunAnswer"
  | "loadRunUsageAttributions"
  | "persistToolLoopCallBatch"
  | "recordRunUsageEvents"
  | "recoverPreparingRun"
  | "resetToolLoopAssistantDraft"
  | "settleRecoveredRunError"
  | "settleToolLoopCall"
  | "sweepBootOrphanedRuns"
  | "updateRunProviderResponseId"
> & Partial<Pick<
  RunRepository,
  | "getRunControlForRecovery"
  | "followups"
  | "groundKnowledgeAnswer"
  | "groundKnowledgeAnswerV5"
  | "groundKnowledgeAnswerV21"
  | "groundKnowledgeEvidenceAnswer"
  | "hasPendingPdfPreparation"
  | "hasPendingWorkspacePreparation"
  | "interruptExpiredAgentRun"
  | "isProjectRunAccessCurrent"
  | "isSearchStrategyEnabled"
  | "loadProviderDispatchRecoveryRequest"
  | "loadKnowledgeFullContextDispatchRecovery"
  | "loadFocusedKnowledgeRecoveryScope"
  | "claimAutomaticKnowledgeCall"
  | "loadEntitlements"
>>;

export type RunRecoveryMcpRuntime = Readonly<{
  callTool(input: {
    arguments: Record<string, unknown>;
    beforeDispatch?(): Promise<void>;
    generationId: string;
    inputSchema: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }): Promise<AiqsaMcpToolCallResult>;
  ensureAcceptedGeneration(generationId: string): Promise<boolean>;
}>;

export type RunRecoveryDeps = Readonly<{
  observations?: ToolObservationService;
  skillTools?: import("../skills/toolService").SkillToolService;
  artifacts?: import("../artifacts/service").ArtifactService;
  vision?: import("../vision/service").VisionAnalysisService;
  images?: import("../images/service").ImageGenerationService;
  getAttachmentLimits?: () => RunAttachmentLimits;
  knowledgeExecutor?: KnowledgeToolExecutor;
  knowledgeProviderDispatch?: KnowledgeProviderDispatchLifecycle;
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
  mcpRuntime?: RunRecoveryMcpRuntime;
  mcp?: Readonly<{
    filterTools: import("../mcp/toolAccess").McpToolAccessFilter;
    materialize?(
      userId: string,
      tools: readonly Readonly<{
        namespacedName: string;
        revisionId: string;
        serverId: string;
      }>[]
    ): Promise<McpRunPlanResult>;
    prepare(
      userId: string,
      options?: Readonly<{ allowedServerIds?: readonly string[] }>
    ): Promise<McpRunPlanResult>;
    prepareProject?(userId: string, serverIds: readonly string[]): Promise<McpRunPlanResult>;
    router?: McpSemanticRouter;
    routerForRun?(owner: Readonly<{ runId: string; userId: string }>): McpSemanticRouter;
  }>;
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
  providerRuntime?: ProviderRuntimeResolver;
  providers: Readonly<Record<string, ProviderAdapter>>;
  registry: RunRecoveryRegistry;
  repository: RunRecoveryRepository;
  searchProviders?: Readonly<Record<string, ProviderSearchAdapter>>;
  storage?: Pick<StorageAdapter, "getObject">;
  workspace?: WorkspaceCoordinator;
}>;

async function resolveAnswerRuntime(
  deps: RunRecoveryDeps,
  runId: string,
  provider: string
): Promise<ProviderRuntimeBinding | null> {
  if (deps.providerRuntime) {
    return deps.providerRuntime.resolve(runId, "answer");
  }
  const adapter = deps.providers[provider];
  return adapter
    ? { adapter, responseTimeoutMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS }
    : null;
}

async function resolvePlanSearchRuntime(
  deps: RunRecoveryDeps,
  runId: string,
  option: NonNullable<CheckpointedToolLoopRun["normalizedRequest"]["searchPlan"]>["options"][number]
): Promise<ProviderRuntimeBinding | null> {
  if (deps.providerRuntime) {
    return deps.providerRuntime.resolve(runId, "search", `search:${option.optionId}`);
  }
  const adapter = deps.providers[option.provider];
  if (!adapter) return null;
  return {
    adapter,
    responseTimeoutMs: DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
    ...(deps.searchProviders?.[option.provider]
      ? { searchAdapter: deps.searchProviders[option.provider] }
      : {})
  };
}

type ProcessBootSweepState = {
  bootedAt: Date;
  promise?: Promise<void>;
};

const globalForRunRecovery = globalThis as unknown as {
  __aiqsaRunBootSweepState?: ProcessBootSweepState;
  __aiqsaRunRefreshPromises?: Map<string, Promise<void>>;
};
const processBootSweepState = globalForRunRecovery.__aiqsaRunBootSweepState ?? {
  bootedAt: new Date(performance.timeOrigin)
};
globalForRunRecovery.__aiqsaRunBootSweepState = processBootSweepState;
const runRefreshPromises =
  globalForRunRecovery.__aiqsaRunRefreshPromises ?? new Map<string, Promise<void>>();
globalForRunRecovery.__aiqsaRunRefreshPromises = runRefreshPromises;

function isActiveRunStatus(status: string): boolean {
  return status === "streaming" || status === "queued" || status === "in_progress";
}

function isRefreshableRun(control: Readonly<{ answerComplete?: true; recoverySettled?: boolean; status: string }>): boolean {
  return isActiveRunStatus(control.status) ||
    (control.status === "error" && !control.recoverySettled && !control.answerComplete);
}

class ToolLoopRecoveryError extends Error {
  readonly report?: ProviderStreamSafetyReport;

  constructor(
    readonly code: string,
    message: string,
    report?: ProviderStreamSafetyReport
  ) {
    super(message);
    this.name = "ToolLoopRecoveryError";
    if (report) this.report = report;
  }
}

class WorkspaceHandoffDeferred extends Error {}

class ToolLoopRecoveryStopped extends Error {
  constructor() {
    super("tool_loop_recovery_stopped");
    this.name = "ToolLoopRecoveryStopped";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FocusedKnowledgeFailureCode =
  | KnowledgeSearchFailureCode
  | "sources_processing"
  | "no_retrieval_candidates"
  | "knowledge_retrieval_failed"
  | "knowledge_answer_failed"
  | "knowledge_answer_contract_failed"
  | "knowledge_citation_contract_failed";

function focusedKnowledgeFailure(
  code: FocusedKnowledgeFailureCode
): Readonly<{ code: FocusedKnowledgeFailureCode; message: string }> {
  if (isKnowledgeSearchFailureCode(code)) return { code, message: knowledgeSearchFailureMessage(code) };
  const messages: Record<Exclude<FocusedKnowledgeFailureCode, KnowledgeSearchFailureCode>, string> = {
    knowledge_answer_contract_failed:
      "The Knowledge answer did not satisfy the required output contract.",
    knowledge_answer_failed: "The Knowledge answer provider failed.",
    knowledge_citation_contract_failed:
      "The Knowledge answer cited evidence outside the final manifest.",
    no_retrieval_candidates:
      "No retrieval candidates were found in the ready Knowledge documents.",
    sources_processing: "The selected Knowledge documents are still processing."
  };
  return { code, message: messages[code] };
}

function recoveryErrorCode(error: unknown): string | null {
  if (error instanceof ToolLoopRecoveryError) return error.code;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : null;
}

function focusedRetrievalFailure(error: unknown): ReturnType<typeof focusedKnowledgeFailure> {
  const code = knowledgeSearchFailureCode(error) ?? recoveryErrorCode(error);
  if (isKnowledgeSearchFailureCode(code)) return focusedKnowledgeFailure(code);
  if (code === "no_retrieval_candidates") {
    return focusedKnowledgeFailure("no_retrieval_candidates");
  }
  if (code === "knowledge_sources_not_ready" || code === "sources_processing") {
    return focusedKnowledgeFailure("sources_processing");
  }
  if (code === "attachment_not_available" || code === "context_too_large" ||
    code === "provider_not_available") {
    return focusedKnowledgeFailure("knowledge_answer_failed");
  }
  return focusedKnowledgeFailure("knowledge_retrieval_failed");
}

function focusedAnswerFailure(error: unknown): ReturnType<typeof focusedKnowledgeFailure> {
  const code = recoveryErrorCode(error);
  if (code === "knowledge_answer_contract_failed" ||
    code === "knowledge_citation_contract_failed") {
    return focusedKnowledgeFailure(code);
  }
  return focusedKnowledgeFailure("knowledge_answer_failed");
}

function modelToolCall(call: PersistedToolLoopCall): ModelToolCall {
  return {
    arguments: call.arguments,
    id: call.providerCallId,
    name: call.toolName
  };
}

function parseProviderToolLoopContinuation(value: ToolLoopJsonValue | null): ProviderToolLoopContinuation {
  if (!isRecord(value) ||
    !(value.providerResponseId === null || typeof value.providerResponseId === "string") ||
    !Array.isArray(value.providerToolMessages)) {
    throw new ToolLoopRecoveryError(
      "tool_loop_checkpoint_invalid",
      "The saved tool-loop continuation is invalid. Retry the run."
    );
  }

  return {
    providerResponseId: value.providerResponseId,
    providerToolMessages: value.providerToolMessages
  };
}

function toolLoopJson(value: unknown, maxBytes: number, code: string): ToolLoopJsonValue {
  const snapshot = snapshotToolLoopJson(value, maxBytes);
  if (snapshot === null) {
    throw new ToolLoopRecoveryError(code, "Tool-loop state is invalid or too large.");
  }
  return snapshot;
}

function toolExecutionErrorResult(
  call: ModelToolCall,
  error: unknown,
  label: "Knowledge" | "Search" | "Tool" | "Workspace" = "Tool"
): ToolExecutionResult {
  if (label === "Knowledge") return knowledgeSearchFailureToolResult(call, error);
  const overflowResult = mcpResponseOverflowToolExecutionResult(call, error, label);
  if (overflowResult) return overflowResult;

  const failure = executionFailure(error);
  const message = failure.message;
  return {
    callId: call.id,
    content: [{ text: JSON.stringify({ ok: false, error: failure }), type: "text" }],
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
    status: "error"
  };
}

function providerResponseIdFromEvent(event: ModelRunSseEvent): string | null {
  if (event.type !== "artifact" || event.data.artifactType !== "summary" ||
    !isRecord(event.data.payload)) {
    return null;
  }
  const responseId = event.data.payload.responseId;
  return typeof responseId === "string" && responseId.trim() ? responseId : null;
}

async function persistRecoveredPlanSearchExecution(input: Readonly<{
  execution: SearchExecutionEvidence;
  modelRunId: string;
  repository: RunRecoveryRepository;
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

function reportedUsage(refreshed: ProviderRunRefreshResult): ModelRunUsage | null {
  let usage: ModelRunUsage | null = null;
  for (const event of refreshed.events) if (event.type === "usage") usage = mergeTokenUsage(usage ?? {}, event.data);
  if (refreshed.result) return mergeTokenUsage(usage ?? {}, refreshed.result.usage);
  return usage ? normalizeTokenUsage({ ...usage, ...(refreshed.terminal ? { completeness: "partial" } : {}) }) : null;
}

async function recoveredUsageAttributions(
  deps: RunRecoveryDeps,
  control: Readonly<{ modelId: string; provider: string }>,
  usage: ModelRunUsage | null
) {
  return usageAttributionsWithEstimatedCost(deps.repository, [
    {
      operationCount: 1,
      modelId: control.modelId,
      provider: control.provider,
      usage: usage ?? normalizeTokenUsage({})
    }
  ]);
}

function groupedUsageAttributions(
  attributions: readonly RunUsageAttribution[]
): RunUsageAttribution[] {
  const grouped = new Map<string, {
    providerModelId?: string;
    operationCount: number | null;
    modelId: string;
    provider: string;
    usages: ModelRunUsage[];
  }>();
  for (const attribution of attributions) {
    const key = `${attribution.provider}\u0000${attribution.modelId}\u0000${attribution.providerModelId ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.usages.push(attribution.usage);
      existing.operationCount = existing.operationCount === null || attribution.operationCount == null
        ? null : existing.operationCount + attribution.operationCount;
    }
    else grouped.set(key, {
      ...(attribution.providerModelId ? { providerModelId: attribution.providerModelId } : {}),
      operationCount: attribution.operationCount ?? null,
      modelId: attribution.modelId,
      provider: attribution.provider,
      usages: [attribution.usage]
    });
  }
  return [...grouped.values()].map((entry) => ({
    ...(entry.providerModelId ? { providerModelId: entry.providerModelId } : {}),
    operationCount: entry.operationCount,
    modelId: entry.modelId,
    provider: entry.provider,
    usage: sumTokenUsage(entry.usages)
  }));
}

function hasTokenUsage(usage: ModelRunUsage): boolean {
  return normalizeTokenUsage(usage).completeness !== "unavailable";
}

function hasValidUsageEvidence(usage: ModelRunUsage): boolean {
  return decodeTokenUsage(usage) !== null;
}

function usageAttributionsWithoutAnswerRounds(
  persisted: readonly RunUsageAttribution[],
  answer: Readonly<{ modelId: string; provider: string }>,
  answerRoundUsage: readonly PersistedAnswerRoundUsage[]
): RunUsageAttribution[] | null {
  if (persisted.some((attribution) => !hasValidUsageEvidence(attribution.usage))) return null;
  const grouped = groupedUsageAttributions(persisted);
  if (grouped.some((attribution) => !hasValidUsageEvidence(attribution.usage))) return null;
  if (answerRoundUsage.length === 0) return grouped;

  const answerKey = `${answer.provider}\u0000${answer.modelId}`;
  const answerAttribution = grouped.find((attribution) =>
    `${attribution.provider}\u0000${attribution.modelId}` === answerKey);
  const remainderCount = answerAttribution?.operationCount == null ? null
    : answerAttribution.operationCount - answerRoundUsage.length;
  if (remainderCount !== null && remainderCount < 0) return null;
  const answerTotal = sumTokenUsage(answerRoundUsage.map((entry) => entry.usage));
  const remainder = subtractTokenUsage(
    answerAttribution?.usage ?? sumTokenUsage([]),
    answerTotal
  );
  if (!remainder) return null;

  return [
    ...grouped.filter((attribution) =>
      `${attribution.provider}\u0000${attribution.modelId}` !== answerKey),
    ...(remainderCount !== 0 && (remainderCount !== null || hasTokenUsage(remainder))
      ? [{ operationCount: remainderCount, modelId: answer.modelId, provider: answer.provider, usage: remainder }]
      : [])
  ];
}

async function settleToolLoopRecoveryError(
  deps: RunRecoveryDeps,
  run: CheckpointedToolLoopRun,
  error: Readonly<{ code: string; message: string }>,
  usageAttributions: readonly RunUsageAttribution[],
  events: readonly ModelRunSseEvent[] = [],
  providerResponseId: string | null = run.providerResponseId
): Promise<void> {
  const groupedAttributions = groupedUsageAttributions(usageAttributions);
  const attributed = await usageAttributionsWithEstimatedCost(
    deps.repository,
    groupedAttributions
  ).catch((costError: unknown) => {
    logEvent("run_recovery", { subsystem: "run_recovery", stage: "read", outcome: "degraded",
      code: observedFailureCode(costError), prisma_code: databaseFailureCode(costError), action: "skip" });
    return groupedAttributions;
  });
  await settleRecoveredError(deps.repository, {
    error,
    outputEvents: runOutputArtifactEvents(events),
    ...(providerResponseId ? { providerResponseId } : {}),
    runId: run.id,
    usageAttributions: attributed,
    userId: run.userId
  });
}

const recoveryScope = new AsyncLocalStorage<string>();

async function observeRecoveryRun(runId: string, operation: () => Promise<void>): Promise<void> {
  if (recoveryScope.getStore() === runId) return operation();
  return runInBackground(() => runWithContext({ run_id: runId }, () => recoveryScope.run(runId, async () => {
    const started = performance.now();
    logEvent("run_recovery", { subsystem: "run_recovery", stage: "recovery", outcome: "started" });
    try {
      await operation();
      logEvent("run_recovery", { subsystem: "run_recovery", stage: "recovery", outcome: "completed", duration_ms: performance.now() - started });
    } catch (error) {
      const failure = observedFailure(error);
      logEvent("run_recovery", { subsystem: "run_recovery", stage: "recovery", outcome: failure.reason === "cancelled" ? "cancelled" : "failed",
        code: failure.code, prisma_code: databaseFailureCode(error), duration_ms: performance.now() - started, action: "wait" });
      throw error;
    }
  })));
}

function observeRecoveryWriteFailure(error: unknown, stage: LifecycleStage): void {
  logEvent("job_persistence", { subsystem: "run_recovery", stage, outcome: "unconfirmed",
    code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "wait" });
}

async function persistRecoveryFailure(runId: string, error: { code: string; message: string }, operation: () => Promise<boolean>): Promise<boolean> {
  const failure = observedFailure(error);
  logEvent("run_recovery", { subsystem: "run_recovery", run_id: runId, stage: "process",
    outcome: failure.reason === "cancelled" ? "cancelled" : "failed", code: failure.code, action: "fail" });
  try {
    const applied = await operation();
    logEvent("job_persistence", { subsystem: "run_recovery", run_id: runId, stage: "fail", outcome: applied ? "confirmed" : "not_applied" });
    return applied;
  } catch (writeError) {
    logEvent("job_persistence", { subsystem: "run_recovery", run_id: runId, stage: "fail", outcome: "unconfirmed",
      prisma_code: databaseFailureCode(writeError), action: "wait" });
    throw writeError;
  }
}

function failRecoveredRun(repository: RunRecoveryDeps["repository"], ...args: Parameters<RunRecoveryDeps["repository"]["failRun"]>) {
  return persistRecoveryFailure(args[0], args[2], () => repository.failRun(...args));
}

function settleRecoveredError(repository: RunRecoveryDeps["repository"], input: Parameters<RunRecoveryDeps["repository"]["settleRecoveredRunError"]>[0]) {
  return persistRecoveryFailure(input.runId, input.error, () => repository.settleRecoveredRunError(input));
}

async function recoverPreparingRun(repository: RunRecoveryDeps["repository"], input: Parameters<RunRecoveryDeps["repository"]["recoverPreparingRun"]>[0]) {
  const result = await repository.recoverPreparingRun(input);
  logEvent("run_recovery", { subsystem: "run_recovery", run_id: input.runId, stage: "prepare",
    outcome: result === "deferred" ? "waiting" : result === "not_preparing" ? "stale" : "completed",
    action: result === "deferred" ? "wait" : result === "not_preparing" ? "skip" : "complete" });
  return result;
}

type RecoverySearchExecutor = Readonly<{
  optionIdsForTool(name: string): readonly string[];
  accepts(name: string): boolean;
  execute(
    call: ModelToolCall,
    request: ProviderRunRequest,
    runId: string,
    signal: AbortSignal
  ): Promise<ToolExecutionResult>;
  tools: readonly RunTool[];
}>;

type RecoveryToolContext = {
  skillResultBudget: ReturnType<typeof createSkillToolResultBudget>;
  activeMcpDiscovery: McpDiscoveryState | undefined;
  activeMcpSnapshot: McpRunPlanSnapshot | undefined;
  deps: RunRecoveryDeps;
  knowledgeResults: Map<string, ToolExecutionResult>;
  mcpDiscoveryBatches: Map<string, Readonly<{
    execute(signal: AbortSignal): Promise<ReadonlyMap<string, ToolExecutionResult>>;
  }>>;
  mcpDiscoveryQueue: Promise<void>;
  providerRequest: ProviderRunRequest;
  sessionRequest?: ProviderRunRequest;
  sessionToolBridge?: ProviderToolBridge;
  run: CheckpointedToolLoopRun;
  runtime(): RunRecoveryMcpRuntime;
  searchExecutor: RecoverySearchExecutor | null;
  tools: RunTool[];
  usageAccountedToolCallIds: Set<string>;
  usageAttributions: RunUsageAttribution[];
};

async function recoveredObservations(context: RecoveryToolContext): Promise<ToolObservationService> {
  return context.deps.observations ?? defaultToolObservations();
}

function isRecoveredObservationRead(context: RecoveryToolContext, name: string): boolean {
  return context.run.normalizedRequest.toolObservationVersion === 1 && name === READ_TOOL_RESULT_NAME;
}

function isRecoveredSearchCall(context: RecoveryToolContext, name: string): boolean {
  return context.searchExecutor?.accepts(name) === true;
}

function isRecoveredKnowledgeCall(context: RecoveryToolContext, name: string): boolean {
  return context.run.normalizedRequest.knowledgePlan.mode !== "none" &&
    context.deps.knowledgeExecutor?.accepts(name) === true;
}

function isRecoveredWorkspaceCall(context: RecoveryToolContext, name: string): boolean {
  const workspace = context.run.normalizedRequest.workspace;
  return Boolean(workspace && context.deps.workspace?.accepts({ name, workspace }));
}

function isRecoveredArtifactCall(context: RecoveryToolContext, name: string): boolean {
  return context.run.normalizedRequest.artifactTool === true && (name === ARTIFACT_TOOL_NAME || name === READ_ARTIFACT_TOOL_NAME && Boolean(context.run.normalizedRequest.artifactReferences?.length));
}

function isRecoveredSkillCall(context: RecoveryToolContext, name: string): boolean {
  return acceptsSkillTool(context.run.normalizedRequest, name);
}

function isRecoveredMcpDiscoveryCall(
  context: RecoveryToolContext,
  name: string
): boolean {
  return name === MCP_FIND_TOOLS_NAME && context.activeMcpDiscovery !== undefined;
}

async function currentProjectRecoveryAuthorityAllowed(
  deps: RunRecoveryDeps,
  project: ProjectRunRecoveryAuthority,
  userId: string
): Promise<boolean> {
  if (!deps.repository.isProjectRunAccessCurrent || !deps.providerAdmission) {
    return false;
  }
  try {
    const accessCurrent = await deps.repository.isProjectRunAccessCurrent({
      accessRevision: project.accessRevision,
      instructionsRevision: project.instructionsRevision,
      memoryRevision: project.memoryRevision,
      policyRevision: project.policyRevision,
      projectId: project.projectId,
      userId
    });
    if (!accessCurrent) return false;
    const current = await deps.providerAdmission.load({
      executionScope: "project",
      providerConnectionId: project.providerConnectionId,
      providerModelId: project.providerModelId,
      ...(project.providerRequiresClientTools
        ? { requiresClientToolCoexistence: true }
        : {}),
      searchPlan: project.providerSearchPlan,
      userId
    });
    return current.fingerprint === project.providerAdmissionFingerprint;
  } catch {
    return false;
  }
}

async function loadRecoveryRunControl(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string
) {
  return deps.repository.getRunControlForRecovery
    ? deps.repository.getRunControlForRecovery(runId)
    : deps.repository.getRunControlForUser(runId, userId);
}

async function failProjectRecoveryAuthority(
  deps: RunRecoveryDeps,
  control: Readonly<{ assistantMessageId: string | null }>,
  runId: string,
  message = "Project provider authority is no longer current."
): Promise<void> {
  if (!control.assistantMessageId) return;
  await failRecoveredRun(deps.repository,
    runId,
    control.assistantMessageId,
    { code: "provider_admission_changed", message },
    { recoveryTerminal: true }
  );
}

async function projectRecoveryAuthorityAllowsProceed(
  deps: RunRecoveryDeps,
  control: Readonly<{
    assistantMessageId: string | null;
    project?: ProjectRunRecoveryAuthority;
    projectRecoveryInvalid?: true;
  }>,
  runId: string,
  userId: string
): Promise<boolean> {
  if (control.projectRecoveryInvalid) {
    await failProjectRecoveryAuthority(
      deps,
      control,
      runId,
      "The saved Project run does not contain complete recovery authority."
    );
    return false;
  }
  if (control.project && !(await currentProjectRecoveryAuthorityAllowed(
    deps,
    control.project,
    userId
  ))) {
    await failProjectRecoveryAuthority(deps, control, runId);
    return false;
  }
  return true;
}

async function currentDirectAnswerDispatchAllowed(
  deps: RunRecoveryDeps,
  control: Readonly<{
    modelId: string;
    project?: ProjectRunRecoveryAuthority;
    provider: string;
  }>,
  userId: string
): Promise<boolean> {
  if (control.project) {
    return currentProjectRecoveryAuthorityAllowed(deps, control.project, userId);
  }
  if (!deps.repository.loadEntitlements) return process.env.NODE_ENV !== "production";
  try {
    return validateRunAccess(await deps.repository.loadEntitlements(userId), {
      modelId: control.modelId,
      provider: control.provider
    }).ok;
  } catch {
    return false;
  }
}

async function currentFocusedKnowledgeRecoveryAuthorization(
  deps: RunRecoveryDeps,
  input: Readonly<{
    project?: ProjectRunRecoveryAuthority;
    runId: string;
    userId: string;
  }>
): Promise<Readonly<{
  authorized: boolean;
  failure: "authorization_changed" | null;
  scope: FocusedKnowledgeRecoveryScope | null;
}>> {
  const loadScope = deps.repository.loadFocusedKnowledgeRecoveryScope;
  const authorizeSnapshot = deps.knowledgeAdmission?.authorizeSnapshot;
  if (!loadScope || !authorizeSnapshot) {
    return {
      authorized: process.env.NODE_ENV !== "production",
      failure: process.env.NODE_ENV !== "production" ? null : "authorization_changed",
      scope: null
    };
  }
  try {
    const scope = await loadScope({ runId: input.runId, userId: input.userId });
    if (!scope) {
      return { authorized: false, failure: "authorization_changed", scope: null };
    }
    const authorized = await authorizeSnapshot({
      ...(input.project ? { executionScope: "project" as const } : {}),
      ...(input.project ? { projectId: input.project.projectId } : {}),
      snapshot: scope,
      userId: input.userId
    });
    return {
      authorized,
      failure: authorized ? null : "authorization_changed",
      scope
    };
  } catch {
    return { authorized: false, failure: "authorization_changed", scope: null };
  }
}

async function currentDirectSearchDispatchAllowed(
  deps: RunRecoveryDeps,
  request: ProviderRunRequest,
  userId: string
): Promise<boolean> {
  const optionIds = request.searchPlan.options.map((option) => option.optionId);
  if (optionIds.length === 0) return true;
  if (!deps.repository.loadEntitlements || !deps.repository.isSearchStrategyEnabled) {
    return process.env.NODE_ENV !== "production";
  }
  try {
    const isEnabled = deps.repository.isSearchStrategyEnabled;
    const [entitlements, enabled] = await Promise.all([
      deps.repository.loadEntitlements(userId),
      Promise.all(optionIds.map((optionId) => isEnabled(optionId)))
    ]);
    return optionIds.every((optionId, index) => enabled[index] === true &&
      validateRunAccess(entitlements, {
        modelId: request.modelId,
        provider: request.provider,
        searchStrategy: optionId
      }).ok);
  } catch {
    return false;
  }
}

async function currentRecoverySearchDispatchAllowed(
  context: RecoveryToolContext
): Promise<boolean> {
  if (context.run.project) {
    return currentProjectRecoveryAuthorityAllowed(
      context.deps,
      context.run.project,
      context.run.userId
    );
  }
  if (!context.deps.repository.loadEntitlements ||
    !context.deps.repository.isSearchStrategyEnabled) {
    return process.env.NODE_ENV !== "production";
  }
  const isSearchStrategyEnabled = context.deps.repository.isSearchStrategyEnabled;
  const optionIds = context.run.normalizedRequest.searchPlan.options.map((option) => option.optionId);
  const [entitlements, enabled] = await Promise.all([
    context.deps.repository.loadEntitlements(context.run.userId),
    Promise.all(optionIds.map((optionId) =>
      isSearchStrategyEnabled(optionId)))
  ]);
  return optionIds.every((optionId, index) => enabled[index] === true &&
    validateRunAccess(entitlements, {
      modelId: context.run.modelId,
      provider: context.run.provider,
      searchStrategy: optionId
    }).ok);
}

async function currentRecoveryMcpDispatchFailure(
  context: RecoveryToolContext,
  callName: string,
  generationId: string
): Promise<McpDispatchFailureCode | null> {
  if (context.run.project && !(await currentProjectRecoveryAuthorityAllowed(
    context.deps, context.run.project, context.run.userId
  ))) return "memory_egress_destination_revoked";
  if (!context.deps.mcp) return process.env.NODE_ENV !== "production" ? null : "mcp_runtime_unavailable";
  const route = resolveMcpRunTool(context.activeMcpSnapshot, callName);
  if (!route) return "mcp_accepted_generation_changed";
  try {
    if (!(await context.deps.mcp.filterTools(context.run.userId, [route.tool])).length) return "mcp_tool_access_denied";
    const current = context.run.project
      ? context.deps.mcp.prepareProject
        ? await context.deps.mcp.prepareProject(context.run.userId, [route.serverId]) : null
      : await context.deps.mcp.prepare(context.run.userId, { allowedServerIds: [route.serverId] });
    return currentMcpDispatchFailure(current, route, generationId);
  } catch {
    return "mcp_runtime_unavailable";
  }
}

async function recordRecoveredSearchResult(input: Readonly<{
  modelRunToolCallId: string;
  context: RecoveryToolContext;
  includeUsage: boolean;
  result: ToolExecutionResult;
}>): Promise<void> {
  const executions = input.context.run.normalizedRequest.toolObservationVersion === 1
    ? await (await recoveredObservations(input.context)).searchAccounting({ runId: input.context.run.id,
        userId: input.context.run.userId, toolCallId: input.modelRunToolCallId })
    : searchExecutionsFromToolResult(input.result);
  const previewCount = input.context.run.normalizedRequest.toolObservationVersion === 1 ? null : searchExecutionPreviewCount(input.result);
  if (previewCount !== null && executions.length !== previewCount) {
    throw new ToolLoopRecoveryError(
      "tool_call_result_invalid",
      "Persisted Search result evidence is invalid and cannot be replayed safely."
    );
  }
  for (const execution of executions) {
    if (input.includeUsage && execution.modelId) {
      input.context.usageAttributions.push({
        modelId: execution.modelId,
        provider: execution.provider,
        usage: execution.usage
      });
    }
    await persistRecoveredPlanSearchExecution({
      execution,
      modelRunId: input.context.run.id,
      repository: input.context.deps.repository
    });
  }
  if (input.includeUsage) {
    input.context.usageAccountedToolCallIds.add(input.modelRunToolCallId);
  }
}

function recordRecoveredKnowledgeResult(input: Readonly<{
  callId: string;
  context: RecoveryToolContext;
  includeUsage: boolean;
  modelRunToolCallId: string;
  result: ToolExecutionResult;
}>): void {
  const evidence = knowledgeEvidenceFromToolResult(input.result);
  if (input.result.status === "complete" && !evidence) {
    throw new ToolLoopRecoveryError(
      "tool_call_result_invalid",
      "Persisted Knowledge result evidence is invalid and cannot be replayed safely."
    );
  }
  input.context.knowledgeResults.set(input.callId, input.result);
  if (!input.includeUsage) return;
  input.context.usageAttributions.push(
    ...knowledgeUsageAttributionsFromToolResult(input.result)
  );
  input.context.usageAccountedToolCallIds.add(input.modelRunToolCallId);
}

async function settleRecoveredKnowledgeEgress(input: Readonly<{
  context: RecoveryToolContext;
  modelRunToolCallId: string;
  result: ToolExecutionResult;
}>): Promise<void> {
  if (!knowledgeEvidenceFromToolResult(input.result) || !input.context.deps.memoryEgress) return;
  const settled = await input.context.deps.memoryEgress.settleRecoveredToolDispatch({
    modelRunToolCallId: input.modelRunToolCallId,
    outcome: "COMPLETED",
    runId: input.context.run.id,
    userId: input.context.run.userId
  });
  if (!settled) {
    throw new ToolLoopRecoveryError(
      "memory_egress_receipt_conflict",
      "A recovered Knowledge egress receipt could not be settled."
    );
  }
}

async function executeRecoveredMcpDiscovery(
  call: ModelToolCall,
  persisted: PersistedToolLoopCall,
  context: RecoveryToolContext,
  signal: AbortSignal
): Promise<ToolExecutionResult> {
  const batch = context.mcpDiscoveryBatches.get(call.id);
  if (batch) {
    const results = await batch.execute(signal);
    const coalesced = results.get(call.id);
    if (!coalesced) throw new Error("mcp_discovery_checkpoint_conflict");
    return coalesced;
  }
  const operation = async (): Promise<ToolExecutionResult> => {
    const discovery = context.activeMcpDiscovery;
    const materialize = context.deps.mcp?.materialize;
    const router = context.deps.mcp?.routerForRun?.({ runId: context.run.id, userId: context.run.userId }) ?? context.deps.mcp?.router;
    const appendEpoch = context.deps.repository.appendMcpDiscoveryEpoch;
    if (!discovery || !materialize || !appendEpoch) {
      throw new Error("mcp_discovery_arguments_invalid");
    }
    const executed = await executeDurableMcpDiscovery({
      activeDiscovery: discovery,
      ...(context.activeMcpSnapshot
        ? { activeSnapshot: context.activeMcpSnapshot }
        : {}),
      appendEpoch,
      call,
      filterTools: context.deps.mcp!.filterTools,
      materialize,
      maxResults: toolRunBudgetsForRequest(context.run.normalizedRequest)
        .maxMcpToolsPerDiscovery,
      maxOutputTokens: toolRunBudgetsForRequest(context.run.normalizedRequest)
        .mcpAutoDiscoveryMaxOutputTokens,
      modelRunToolCallId: persisted.id,
      onUsage(attribution) {
        context.usageAttributions.push(attribution);
      },
      request: context.providerRequest,
      roundIndex: persisted.roundIndex,
      router,
      runId: context.run.id,
      signal,
      timeoutMs: toolRunBudgetsForRequest(context.run.normalizedRequest)
        .mcpAutoDiscoveryTimeoutSeconds * 1_000,
      userId: context.run.userId
    });
    context.activeMcpSnapshot = executed.snapshot;
    context.activeMcpDiscovery = executed.discovery;
    const knownToolNames = new Set(context.tools.map((tool) => tool.name));
    for (const tool of mcpRunTools(executed.snapshot)) {
      if (!knownToolNames.has(tool.name)) {
        context.tools.push(tool);
        knownToolNames.add(tool.name);
      }
    }
    return executed.toolResult;
  };
  const result = context.mcpDiscoveryQueue.then(operation, operation);
  context.mcpDiscoveryQueue = result.then(() => undefined, () => undefined);
  return result;
}

function registerRecoveredMcpDiscoveryBatch(
  calls: readonly PersistedToolLoopCall[],
  context: RecoveryToolContext
): void {
  const discoveryCalls = [...calls]
    .sort((left, right) => left.ordinal - right.ordinal)
    .flatMap((persisted) => {
      const call = modelToolCall(persisted);
      return call.name === MCP_FIND_TOOLS_NAME && mcpFindToolsArguments(call.arguments)
        ? [{ call, modelRunToolCallId: persisted.id }]
        : [];
    });
  if (discoveryCalls.length < 2) return;

  let execution: Promise<ReadonlyMap<string, ToolExecutionResult>> | null = null;
  const batch = {
    execute(signal: AbortSignal) {
      execution ??= (() => {
        const operation = async (): Promise<ReadonlyMap<string, ToolExecutionResult>> => {
          const discovery = context.activeMcpDiscovery;
          const materialize = context.deps.mcp?.materialize;
          const router = context.deps.mcp?.routerForRun?.({ runId: context.run.id, userId: context.run.userId }) ?? context.deps.mcp?.router;
          const appendEpoch = context.deps.repository.appendMcpDiscoveryEpoch;
          if (!discovery || !materialize || !appendEpoch) {
            throw new Error("mcp_discovery_arguments_invalid");
          }
          const budgets = toolRunBudgetsForRequest(context.run.normalizedRequest);
          const executed = await executeDurableMcpDiscoveryBatch({
            activeDiscovery: discovery,
            ...(context.activeMcpSnapshot
              ? { activeSnapshot: context.activeMcpSnapshot }
              : {}),
            appendEpoch,
            calls: discoveryCalls,
            filterTools: context.deps.mcp!.filterTools,
            materialize,
            maxResults: budgets.maxMcpToolsPerDiscovery,
            maxOutputTokens: budgets.mcpAutoDiscoveryMaxOutputTokens,
            onUsage(attribution) {
              context.usageAttributions.push(attribution);
            },
            request: context.providerRequest,
            roundIndex: calls[0]!.roundIndex,
            router,
            runId: context.run.id,
            signal,
            timeoutMs: budgets.mcpAutoDiscoveryTimeoutSeconds * 1_000,
            userId: context.run.userId
          });
          context.activeMcpSnapshot = executed.snapshot;
          context.activeMcpDiscovery = executed.discovery;
          const knownToolNames = new Set(context.tools.map((tool) => tool.name));
          for (const tool of mcpRunTools(executed.snapshot)) {
            if (!knownToolNames.has(tool.name)) {
              context.tools.push(tool);
              knownToolNames.add(tool.name);
            }
          }
          return executed.toolResults;
        };
        const result = context.mcpDiscoveryQueue.then(operation, operation);
        context.mcpDiscoveryQueue = result.then(() => undefined, () => undefined);
        return result;
      })();
      return execution;
    }
  } as const;
  for (const candidate of discoveryCalls) {
    context.mcpDiscoveryBatches.set(candidate.call.id, batch);
  }
}

async function executePersistedToolCall(
  persisted: PersistedToolLoopCall,
  context: RecoveryToolContext,
  signal: AbortSignal,
  claimCall: RunRepository["claimToolLoopCall"] = context.deps.repository.claimToolLoopCall
): Promise<ToolLoopSettledCall<ToolExecutionResult>> {
  return runWithContext({ tool_call_id: persisted.id, execution_index: persisted.ordinal },
    () => executePersistedToolCallInContext(persisted, context, signal, claimCall));
}

async function executePersistedToolCallInContext(
  persisted: PersistedToolLoopCall,
  context: RecoveryToolContext,
  signal: AbortSignal,
  claimCall: RunRepository["claimToolLoopCall"] =
    context.deps.repository.claimToolLoopCall
): Promise<ToolLoopSettledCall<ToolExecutionResult>> {
  const call = modelToolCall(persisted);
  if (persisted.state === "running" && isRecoveredKnowledgeCall(context, call.name)) {
    if (signal.aborted) throw new ToolLoopRecoveryStopped();
    let replay: Awaited<ReturnType<NonNullable<KnowledgeToolExecutor["preflight"]>>> | null = null;
    try {
      replay = await context.deps.knowledgeExecutor!.preflight?.(call, {
        persistedToolCallId: persisted.id,
        request: context.providerRequest,
        runId: context.run.id,
        userId: context.run.userId
      }) ?? null;
    } catch {
      // A running call may already have crossed an external-I/O boundary. A
      // receipt read failure must never turn into a fresh dispatch attempt.
    }
    if (signal.aborted) throw new ToolLoopRecoveryStopped();
    if (!replay || replay.kind !== "replayed") {
      throw new ToolLoopRecoveryError(
        "tool_call_outcome_unknown",
        `Tool ${call.name} may have completed before the process stopped and was not repeated.`
      );
    }
    const stored = snapshotToolExecutionResult(
      replay.result,
      toolLoopPersistenceLimits.resultBytes
    );
    if (stored === null) {
      throw new ToolLoopRecoveryError(
        "tool_call_result_invalid",
        "A persisted Knowledge receipt is invalid and cannot be replayed safely."
      );
    }
    const settled = await context.deps.repository.settleToolLoopCall({
      callId: persisted.id,
      result: stored,
      runId: context.run.id,
      state: replay.result.status,
      userId: context.run.userId
    });
    if (settled !== "settled" && settled !== "reused") {
      throw new ToolLoopRecoveryError(
        "tool_call_settle_conflict",
        "A recovered Knowledge receipt could not be durably settled."
      );
    }
    await settleRecoveredKnowledgeEgress({
      context,
      modelRunToolCallId: persisted.id,
      result: replay.result
    });
    recordRecoveredKnowledgeResult({
      callId: call.id,
      context,
      includeUsage: true,
      modelRunToolCallId: persisted.id,
      result: replay.result
    });
    return {
      call,
      ordinal: persisted.ordinal,
      result: { status: "complete", value: replay.result },
      round: persisted.roundIndex
    };
  }
  const claim = await claimCall({
    callId: persisted.id,
    runId: context.run.id,
    userId: context.run.userId
  });
  if (claim.kind === "ambiguous" && isRecoveredObservationRead(context, call.name)) {
    const result = await executeReadToolResult(await recoveredObservations(context), call,
      { runId: context.run.id, userId: context.run.userId }, signal);
    const snapshot = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
    const settled = snapshot && await context.deps.repository.settleToolLoopCall({ callId: persisted.id,
      result: snapshot, runId: context.run.id, state: result.status, userId: context.run.userId });
    if (settled !== "settled" && settled !== "reused") throw new ToolLoopRecoveryError("tool_call_settle_conflict", "Saved-result read could not be settled.");
    return { call, ordinal: persisted.ordinal, result: { status: "complete", value: result }, round: persisted.roundIndex };
  }
  if (claim.kind === "ambiguous" && context.run.normalizedRequest.workspaceCheckpoints && call.name === CHECKPOINT_OUTPUTS_TOOL_NAME) {
    const restored = await (await defaultWorkspaceCheckpoints()).restore(call, { persistedToolCallId: persisted.id, request: context.providerRequest, runId: context.run.id, userId: context.run.userId }, signal);
    return { call, ordinal: persisted.ordinal, result: { status: "complete", value: restored }, round: persisted.roundIndex };
  }
  if (claim.kind === "ambiguous" && context.run.normalizedRequest.visionAnalysis && call.name === ANALYZE_IMAGE_TOOL_NAME && context.deps.vision) {
    const restored = await context.deps.vision.restore(call, { persistedToolCallId: persisted.id, request: context.providerRequest, runId: context.run.id, userId: context.run.userId });
    if (restored) {
      const snapshot = snapshotToolExecutionResult(restored, toolLoopPersistenceLimits.resultBytes);
      const settled = snapshot && await context.deps.repository.settleToolLoopCall({ callId: persisted.id, result: snapshot, runId: context.run.id, state: restored.status, userId: context.run.userId });
      if (settled === "settled" || settled === "reused") {
        await context.deps.memoryEgress?.settleRecoveredToolDispatch({ modelRunToolCallId: persisted.id, outcome: restored.status === "complete" ? "COMPLETED" : "FAILED", runId: context.run.id, userId: context.run.userId });
        return { call, ordinal: persisted.ordinal, result: { status: "complete", value: restored }, round: persisted.roundIndex };
      }
    }
  }
  if (claim.kind === "ambiguous" && context.run.normalizedRequest.imagePlan && call.name === IMAGE_GENERATION_TOOL_NAME && context.deps.images) {
    const restored = await context.deps.images.restore(call, { persistedToolCallId: persisted.id, request: context.providerRequest, runId: context.run.id, userId: context.run.userId });
    if (restored) {
      const snapshot = snapshotToolExecutionResult(restored, toolLoopPersistenceLimits.resultBytes);
      const settled = snapshot && await context.deps.repository.settleToolLoopCall({ callId: persisted.id, result: snapshot, runId: context.run.id, state: "complete", userId: context.run.userId });
      if (settled === "settled" || settled === "reused") {
        await context.deps.memoryEgress?.settleRecoveredToolDispatch({ modelRunToolCallId: persisted.id, outcome: "COMPLETED", runId: context.run.id, userId: context.run.userId });
        return { call, ordinal: persisted.ordinal, result: { status: "complete", value: restored }, round: persisted.roundIndex };
      }
    }
  }
  if (claim.kind === "ambiguous" && isRecoveredArtifactCall(context, call.name) && context.deps.artifacts) {
    const restored = await context.deps.artifacts.restore(call, {
      persistedToolCallId: persisted.id,
      request: context.providerRequest,
      runId: context.run.id,
      userId: context.run.userId
    });
    if (restored) {
      const snapshot = snapshotToolExecutionResult(restored, toolLoopPersistenceLimits.resultBytes);
      const settled = snapshot && await context.deps.repository.settleToolLoopCall({
        callId: persisted.id,
        result: snapshot,
        runId: context.run.id,
        state: restored.status,
        userId: context.run.userId
      });
      if (settled === "settled" || settled === "reused") {
        return { call, ordinal: persisted.ordinal, result: { status: "complete", value: restored }, round: persisted.roundIndex };
      }
    }
  }
  if (claim.kind === "ambiguous" && context.run.normalizedRequest.toolObservationVersion === 1 &&
    (isRecoveredWorkspaceCall(context, call.name) || isRecoveredSearchCall(context, call.name) || resolveMcpRunTool(context.activeMcpSnapshot, call.name))) {
    const restored = await restoreObservedResult({ service: await recoveredObservations(context),
      producer: { runId: context.run.id, userId: context.run.userId, toolCallId: persisted.id }, signal }, call).catch(() => null);
    if (restored) {
      const snapshot = snapshotToolExecutionResult(restored, toolLoopPersistenceLimits.resultBytes);
      const settled = snapshot && await context.deps.repository.settleToolLoopCall({ callId: persisted.id, result: snapshot,
        runId: context.run.id, state: restored.status, userId: context.run.userId });
      if (settled === "settled" || settled === "reused") {
        await context.deps.memoryEgress?.settleRecoveredToolDispatch({ modelRunToolCallId: persisted.id, outcome: "COMPLETED", runId: context.run.id, userId: context.run.userId });
        if (isRecoveredSearchCall(context, call.name)) await recordRecoveredSearchResult({ context,
          includeUsage: persisted.usageAccountedAt == null, modelRunToolCallId: persisted.id, result: restored });
        return { call, ordinal: persisted.ordinal, result: { status: "complete", value: restored }, round: persisted.roundIndex };
      }
    } else if (isRecoveredSearchCall(context, call.name)) {
      // The result is unavailable, but a dispatched Search may hold an
      // immutable usage receipt. It settles with the terminal outcome below;
      // accounting failure never masks that outcome or permits a replay.
      await recordRecoveredSearchResult({ context, includeUsage: persisted.usageAccountedAt == null,
        modelRunToolCallId: persisted.id, result: { callId: call.id, name: call.name, status: "error", content: [] } })
        .catch(() => undefined);
    }
  }
  if (claim.kind === "ambiguous") {
    throw new ToolLoopRecoveryError(
      "tool_call_outcome_unknown",
      `Tool ${call.name} may have completed before the process stopped and was not repeated.`
    );
  }
  if (claim.kind === "cancelled") throw new ToolLoopRecoveryStopped();
  if (claim.kind === "not_found") {
    throw new ToolLoopRecoveryError(
      "tool_call_not_found",
      "A persisted tool call could not be found during recovery."
    );
  }
  if (claim.kind === "settled") {
    let result = isRecoveredObservationRead(context, call.name)
      ? await executeReadToolResult(await recoveredObservations(context), call, { runId: context.run.id, userId: context.run.userId }, signal)
      : parsePersistedToolExecutionResult(call, claim.call.result);
    if (result && !result.observation && context.run.normalizedRequest.toolObservationVersion === 1 &&
      (isRecoveredSkillCall(context, call.name) || isRecoveredKnowledgeCall(context, call.name))) {
      const saved = await (await recoveredObservations(context)).restore({ runId: context.run.id,
        userId: context.run.userId, toolCallId: claim.call.id }, signal).catch(() => null);
      if (saved) result = { ...result, observation: saved.projection.observation };
    }
    if (!result) {
      throw new ToolLoopRecoveryError(
        "tool_call_result_invalid",
        "A persisted tool result is invalid and cannot be replayed safely."
      );
    }
    context.skillResultBudget.restore(result);
    if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      await recordRecoveredSearchResult({
        context,
        includeUsage: claim.call.usageAccountedAt == null,
        modelRunToolCallId: claim.call.id,
        result
      });
    }
    if (isRecoveredKnowledgeCall(context, call.name)) {
      await settleRecoveredKnowledgeEgress({
        context,
        modelRunToolCallId: claim.call.id,
        result
      });
      recordRecoveredKnowledgeResult({
        callId: call.id,
        context,
        includeUsage: claim.call.usageAccountedAt == null,
        modelRunToolCallId: claim.call.id,
        result
      });
    }
    return {
      call,
      ordinal: persisted.ordinal,
      result: { status: "complete", value: result },
      round: persisted.roundIndex
    };
  }

  let result: ToolExecutionResult;
  let fatalToolError: ToolLoopRecoveryError | null = null;
  let resultSettled = false;
  const finishResult = async (result: ToolExecutionResult): Promise<ToolExecutionResult> => {
    if (resultSettled) return result;
    result = context.skillResultBudget.accept(result);
    try {
      result = await deliverSkillWorkspaceBundle({ call, result, request: context.run.normalizedRequest,
        coordinator: context.deps.workspace, runId: context.run.id, userId: context.run.userId, signal,
        onActivity: async (entry) => {
          const event = projectRunOutputArtifactEvent(workspaceActivityEvent(entry));
          if (event) await context.deps.repository.appendRunOutputEvent(context.run.id, event);
        } });
    } catch (error) {
      if (signal.aborted) throw new ToolLoopRecoveryStopped();
      throw error;
    }
    context.skillResultBudget.restore(result);
    const stored = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
    if (stored === null) {
      throw new ToolLoopRecoveryError(
        "tool_call_result_invalid",
        "A recovered tool result is invalid or too large to persist safely."
      );
    }
    const settled = await context.deps.repository.settleToolLoopCall({
      callId: claim.call.id,
      result: stored,
      runId: context.run.id,
      state: result.status,
      userId: context.run.userId
    });
    if (settled !== "settled" && settled !== "reused") {
      throw new ToolLoopRecoveryError(
        "tool_call_settle_conflict",
        "A recovered tool result could not be durably settled."
      );
    }
    resultSettled = true;
    return result;
  };
  let externalReceipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
  try {
    if (hasInvalidProviderToolArguments(call.arguments)) {
      throw new Error("provider_tool_arguments_invalid");
    }
    const executionContext = {
      persistedToolCallId: claim.call.id,
      request: context.providerRequest,
      runId: context.run.id,
      userId: context.run.userId
    };
    let preflightResult: ToolExecutionResult | null = null;
    if (isRecoveredKnowledgeCall(context, call.name)) {
      try {
        const admission = await context.deps.knowledgeExecutor!.preflight?.(
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
    const isCheckpointCall = context.run.normalizedRequest.workspaceCheckpoints === true && call.name === CHECKPOINT_OUTPUTS_TOOL_NAME;
    const isVisionCall = Boolean(context.run.normalizedRequest.visionAnalysis) && call.name === ANALYZE_IMAGE_TOOL_NAME;
    const isViewImageCall = context.run.normalizedRequest.workspaceImageView === true && call.name === VIEW_WORKSPACE_IMAGE;
    const isImageCall = Boolean(context.run.normalizedRequest.imagePlan) && call.name === IMAGE_GENERATION_TOOL_NAME;
    const isSessionCall = context.run.normalizedRequest.sessionStatusTool === true && call.name === SESSION_STATUS_TOOL_NAME;
    const externalCall = !preflightResult && !(isVisionCall && !context.run.normalizedRequest.visionAnalysis?.available) && !isRecoveredMcpDiscoveryCall(context, call.name) && !isSessionCall && !isRecoveredObservationRead(context, call.name) && !isRecoveredArtifactCall(context, call.name) && !isRecoveredSkillCall(context, call.name) && !isViewImageCall && !isCheckpointCall;
    if (externalCall) {
      if (!context.deps.memoryEgress && process.env.NODE_ENV === "production") {
        throw new Error("memory_egress_receipt_unavailable");
      }
      const route = resolveMcpRunTool(context.activeMcpSnapshot, call.name);
      const destinationSnapshot = isVisionCall && context.run.normalizedRequest.visionAnalysis?.available
          ? { kind: "vision_analysis", version: 1, authority: context.run.normalizedRequest.visionAnalysis.authority, snapshot: context.run.normalizedRequest.visionAnalysis.snapshot }
          : isImageCall
          ? { kind: "image", version: 1, authority: context.run.normalizedRequest.imagePlan!.authority, snapshot: context.run.normalizedRequest.imagePlan!.snapshot }
          : isRecoveredKnowledgeCall(context, call.name)
          ? {
              kind: "knowledge",
              scopeFingerprint: memorySha256(context.run.knowledgeScope ?? null),
              selection: context.run.normalizedRequest.knowledgePlan,
              toolName: call.name,
              version: 1
            }
          : isRecoveredSearchCall(context, call.name)
          ? {
              kind: "search",
              optionIds: context.run.normalizedRequest.searchPlan.options.map((option) => option.optionId),
              toolName: call.name,
              version: 1
            }
          : isRecoveredWorkspaceCall(context, call.name)
          ? {
              internetEnabled: context.run.normalizedRequest.workspace!.internetEnabled,
              kind: "workspace",
              sessionId: context.run.normalizedRequest.workspace!.sessionId,
              toolCatalogHash: context.run.normalizedRequest.workspace!.toolCatalogHash,
              toolName: call.name,
              version: 1
            }
          : {
              fingerprint: route?.fingerprint ?? null,
              kind: "mcp",
              serverId: route?.serverId ?? null,
              toolName: call.name,
              version: 1
            };
      const generationId = claim.call.mcpBinding?.runtimeGenerationId;
      let mcpFailure: McpDispatchFailureCode | null = null;
      const allowed = isVisionCall
          ? await context.deps.vision?.authorize(context.run.normalizedRequest.visionAnalysis!) ?? false
          : isImageCall
          ? await context.deps.images?.authorize(context.run.normalizedRequest.imagePlan!) ?? false
          : isRecoveredKnowledgeCall(context, call.name)
          ? (await currentFocusedKnowledgeRecoveryAuthorization(context.deps, {
              ...(context.run.project ? { project: context.run.project } : {}),
              runId: context.run.id,
              userId: context.run.userId
            })).authorized
          : isRecoveredSearchCall(context, call.name)
          ? await currentRecoverySearchDispatchAllowed(context)
          : isRecoveredWorkspaceCall(context, call.name)
            ? claim.call.workspaceBindingId === context.run.id
          : generationId
            ? await currentRecoveryMcpDispatchFailure(context, call.name, generationId).then(async (failure) => {
                try {
                  mcpFailure = failure ?? (await context.runtime().ensureAcceptedGeneration(generationId)
                    ? null : "mcp_runtime_unavailable");
                } catch { mcpFailure = "mcp_runtime_unavailable"; }
                return mcpFailure === null;
              })
            : false;
      if (!allowed) {
        const failureCode: McpDispatchFailureCode = mcpFailure ?? "memory_egress_destination_revoked";
        await context.deps.memoryEgress?.recordBlockedDispatch({
          destinationKind: String(destinationSnapshot.kind),
          destinationSnapshot,
          errorCode: failureCode,
          mode: "TOOL_CALL",
          modelRunToolCallId: claim.call.id,
          requestEvidence: memoryEgressRequestEvidence(context.providerRequest),
          requestPreview: {
            argumentsHash: memorySha256(call.arguments),
            toolName: call.name
          },
          runId: context.run.id,
          userId: context.run.userId
        });
        if (isRecoveredKnowledgeCall(context, call.name)) {
          fatalToolError = new ToolLoopRecoveryError(
            "memory_egress_destination_revoked",
            "Knowledge access changed before retrieval."
          );
        }
        throw mcpDispatchError(failureCode);
      }
      externalReceipt = context.deps.memoryEgress
        ? await context.deps.memoryEgress.beginDispatch({
            destinationKind: String(destinationSnapshot.kind),
            destinationSnapshot,
            mode: "TOOL_CALL",
            modelRunToolCallId: claim.call.id,
            requestEvidence: memoryEgressRequestEvidence(context.providerRequest),
            requestPreview: {
              argumentsHash: memorySha256(call.arguments),
              toolName: call.name
            },
            runId: context.run.id,
            userId: context.run.userId
          })
        : null;
    }
    if (preflightResult) {
      result = preflightResult;
    } else if (isRecoveredSkillCall(context, call.name)) {
      if (!context.deps.skillTools) throw new Error("skill_tool_unavailable");
      const execute = () => context.deps.skillTools!.execute(call, { ...executionContext,
        ...(context.run.project ? { projectId: context.run.project.projectId } : {}) });
      const manifest = decodeFrozenSkillManifest(context.run.normalizedRequest.skills);
      const skill = manifest && [...manifest.pinned, ...manifest.available].find(skill => skill.alias === call.arguments.skill);
      result = context.run.normalizedRequest.toolObservationVersion === 1 && skill
        ? await captureOwnedObservation({ service: await recoveredObservations(context),
            producer: { runId: context.run.id, userId: context.run.userId, toolCallId: claim.call.id }, signal }, "skill",
            { version: 1, source: "skill", skillId: skill.skillId, revisionId: skill.revisionId },
            async () => finishResult(await execute())) : await execute();
    } else if (isRecoveredArtifactCall(context, call.name)) {
      if (!context.deps.artifacts) throw new Error("artifact_tool_unavailable");
      result = await context.deps.artifacts.execute(call, executionContext, { signal });
    } else if (isCheckpointCall) {
      result = await (await defaultWorkspaceCheckpoints()).execute(call, executionContext, signal);
    } else if (isVisionCall) {
      if (!context.deps.vision) throw new Error("vision_model_unavailable");
      result = await context.deps.vision.execute(call, executionContext, signal);
    } else if (isViewImageCall) {
      result = await (await defaultWorkspaceImageViewer()).execute(call, executionContext, signal);
    } else if (isImageCall) {
      if (!context.deps.images) throw new Error("image_tool_unavailable");
      result = await context.deps.images.execute(call, executionContext, signal);
    } else if (isRecoveredObservationRead(context, call.name)) {
      result = await executeReadToolResult(await recoveredObservations(context), call, executionContext, signal);
    } else if (isSessionCall) {
      result = executeSessionStatus(call, context.sessionRequest ?? context.providerRequest, context.sessionToolBridge);
    } else if (isRecoveredMcpDiscoveryCall(context, call.name)) {
      result = await executeRecoveredMcpDiscovery(call, persisted, context, signal);
    } else if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      const execute = () => context.searchExecutor!.execute(
        call,
        context.providerRequest,
        context.run.id,
        signal
      );
      const selected = context.searchExecutor.optionIdsForTool(call.name);
      result = context.run.normalizedRequest.toolObservationVersion === 1
        ? await captureSearchObservation({ service: await recoveredObservations(context),
            producer: { runId: context.run.id, userId: context.run.userId, toolCallId: claim.call.id }, signal }, call,
            context.run.normalizedRequest.searchPlan.options.filter(option => selected.includes(option.optionId))
              .map(({ optionId, revisionId }) => ({ optionId, revisionId })), execute) : await execute();
      await recordRecoveredSearchResult({
        context,
        includeUsage: true,
        modelRunToolCallId: claim.call.id,
        result
      });
    } else if (isRecoveredKnowledgeCall(context, call.name)) {
      const execute = () => withKnowledgeToolDeadline([signal], (knowledgeSignal) =>
        context.deps.knowledgeExecutor!.execute(call, executionContext, { signal: knowledgeSignal }));
      result = context.run.normalizedRequest.toolObservationVersion === 1
        ? await captureOwnedObservation({ service: await recoveredObservations(context),
            producer: { runId: context.run.id, userId: context.run.userId, toolCallId: claim.call.id }, signal }, "knowledge", undefined, execute)
        : await execute();
      recordRecoveredKnowledgeResult({
        callId: call.id,
        context,
        includeUsage: true,
        modelRunToolCallId: claim.call.id,
        result
      });
    } else if (
      context.run.normalizedRequest.workspace &&
      isRecoveredWorkspaceCall(context, call.name)
    ) {
      if (claim.call.workspaceBindingId !== context.run.id) {
        throw new Error("workspace_run_binding_unavailable");
      }
      const execute = () => context.deps.workspace!.execute({
        call,
        modelRunToolCallId: claim.call.id,
        onActivity: async (entry) => {
          const event = projectRunOutputArtifactEvent(workspaceActivityEvent(entry));
          if (event) await context.deps.repository.appendRunOutputEvent(context.run.id, event);
        },
        runId: context.run.id,
        signal,
        userId: context.run.userId,
        workspace: context.run.normalizedRequest.workspace!
      });
      result = context.run.normalizedRequest.toolObservationVersion === 1
        ? await captureWorkspaceObservation({ service: await recoveredObservations(context),
            producer: { runId: context.run.id, userId: context.run.userId, toolCallId: claim.call.id }, signal }, call, execute)
        : await execute();
    } else {
      const route = resolveMcpRunTool(context.activeMcpSnapshot, call.name);
      const generationId = claim.call.mcpBinding?.runtimeGenerationId;
      if (!route || !generationId ||
        claim.call.mcpBinding?.runtimeGenerationFingerprint !== route.fingerprint) {
        throw new Error("mcp_run_binding_unavailable");
      }
      const runtime = context.runtime();
      const execute = () => dispatchMcpTool({
        arguments: call.arguments,
        async assertCurrent() {
          const failure = await currentRecoveryMcpDispatchFailure(context, call.name, generationId);
          if (failure) throw mcpDispatchError(failure);
        },
        callTool: (runtimeInput) => runtime.callTool(runtimeInput),
        generationId,
        route,
        signal
      });
      result = context.run.normalizedRequest.toolObservationVersion === 1
        ? await captureMcpObservation({ service: await recoveredObservations(context),
            producer: { runId: context.run.id, userId: context.run.userId, toolCallId: claim.call.id }, signal }, call,
          { version: 1, source: "mcp", serverId: route.serverId, originalName: route.originalName,
            fingerprint: route.fingerprint, revisionId: context.activeMcpSnapshot!.servers.find(server => server.serverId === route.serverId)!.revisionId }, execute)
        : mcpToolExecutionResult(call, await execute());
    }
    if (externalReceipt &&
      !(await context.deps.memoryEgress!.completeDispatch(externalReceipt.id))) {
      throw new Error("memory_egress_receipt_conflict");
    }
  } catch (error) {
    if (context.run.normalizedRequest.toolObservationVersion === 1 && isRecoveredSearchCall(context, call.name)) {
      const failed = toolExecutionErrorResult(call, error, "Search");
      const snapshot = snapshotToolExecutionResult(failed, toolLoopPersistenceLimits.resultBytes);
      const settled = snapshot && await context.deps.repository.settleToolLoopCall({ callId: claim.call.id,
        result: snapshot, runId: context.run.id, state: "error", userId: context.run.userId });
      if (settled !== "settled" && settled !== "reused") throw new ToolLoopRecoveryError("tool_call_settle_conflict", "Search outcome could not be settled.");
      await recordRecoveredSearchResult({ context, includeUsage: claim.call.usageAccountedAt == null,
        modelRunToolCallId: claim.call.id, result: failed });
    } else if (error instanceof SearchToolCancelledError) {
      // Accounting requires a settled call even when Stop has already won
      // the run's terminal state. Only already observed Search evidence is saved.
      const stored = snapshotToolExecutionResult(error.result, toolLoopPersistenceLimits.resultBytes);
      if (stored === null) {
        throw new ToolLoopRecoveryError("tool_call_result_invalid", "Recovered Search result could not be persisted.");
      }
      const settled = await context.deps.repository.settleToolLoopCall({
        callId: claim.call.id,
        result: stored,
        runId: context.run.id,
        state: error.result.status,
        userId: context.run.userId
      });
      if (settled !== "settled" && settled !== "reused") {
        throw new ToolLoopRecoveryError("tool_call_settle_conflict", "Recovered Search result could not be durably settled.");
      }
      await recordRecoveredSearchResult({
        context,
        includeUsage: claim.call.usageAccountedAt == null,
        modelRunToolCallId: claim.call.id,
        result: error.result
      });
    }
    if (externalReceipt) {
      await context.deps.memoryEgress!.failDispatch(
        externalReceipt.id,
        isRecoveredKnowledgeCall(context, call.name) ? knowledgeSearchFailureCode(error) ?? "knowledge_retrieval_failed"
          : observedFailureCode(error) !== "unknown"
          ? observedFailureCode(error)
          : "external_tool_dispatch_failed"
      ).catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "fail"));
    }
    if (signal.aborted) throw new ToolLoopRecoveryStopped();
    if (call.name === IMAGE_GENERATION_TOOL_NAME && imageDispatchMustStop(error)) {
      fatalToolError = new ToolLoopRecoveryError("image_generation_failed", "Image generation could not finish. The request was not repeated. Any saved image remains in the chat.");
    }
    if (error instanceof McpAutoDiscoveryUnavailableError) {
      fatalToolError = new ToolLoopRecoveryError(error.code, error.message);
      result = toolExecutionErrorResult(call, error);
    } else {
      result = toolExecutionErrorResult(
        call,
        error,
        isRecoveredKnowledgeCall(context, call.name)
          ? "Knowledge"
          : context.searchExecutor && isRecoveredSearchCall(context, call.name)
            ? "Search"
            : isRecoveredWorkspaceCall(context, call.name) ? "Workspace" : "Tool"
      );
    }
  }
  if (signal.aborted) throw new ToolLoopRecoveryStopped();

  result = await finishResult(result);
  if (isRecoveredKnowledgeCall(context, call.name) && result.status === "error") {
    recordRecoveredKnowledgeResult({
      callId: call.id, context, includeUsage: false, modelRunToolCallId: persisted.id, result
    });
  }
  if (fatalToolError) throw fatalToolError;
  return {
    call,
    ordinal: persisted.ordinal,
    result: { status: "complete", value: result },
    round: persisted.roundIndex
  };
}

async function executePersistedToolBatch(
  calls: readonly PersistedToolLoopCall[],
  context: RecoveryToolContext,
  signal: AbortSignal
): Promise<readonly ToolLoopSettledCall<ToolExecutionResult>[]> {
  const ordered = [...calls].sort((left, right) => left.ordinal - right.ordinal);
  if (context.sessionToolBridge) context.skillResultBudget.begin({
    request: context.sessionRequest ?? context.providerRequest, bridge: context.sessionToolBridge,
    calls: ordered.map((call) => ({ id: call.providerCallId, name: call.toolName }))
  });
  const ambiguous = ordered.find((call) =>
    call.state === "running" && call.toolName !== MCP_FIND_TOOLS_NAME &&
    !isSkillToolName(call.toolName) &&
    !isRecoveredObservationRead(context, call.toolName) &&
    !(context.run.normalizedRequest.toolObservationVersion === 1 &&
      (isRecoveredWorkspaceCall(context, call.toolName) || isRecoveredSearchCall(context, call.toolName) ||
        resolveMcpRunTool(context.activeMcpSnapshot, call.toolName))) &&
    !isRecoveredArtifactCall(context, call.toolName) &&
    !(context.run.normalizedRequest.workspaceCheckpoints && call.toolName === CHECKPOINT_OUTPUTS_TOOL_NAME) &&
    !(context.run.normalizedRequest.visionAnalysis && context.deps.vision && call.toolName === ANALYZE_IMAGE_TOOL_NAME) &&
    !isRecoveredKnowledgeCall(context, call.toolName));
  if (ambiguous) {
    throw new ToolLoopRecoveryError(
      "tool_call_outcome_unknown",
      `Tool ${ambiguous.toolName} may have completed before the process stopped and was not repeated.`
    );
  }
  if (ordered.some((call) => call.state === "cancelled")) {
    throw new ToolLoopRecoveryStopped();
  }
  registerRecoveredMcpDiscoveryBatch(ordered, context);

  const results = new Array<ToolLoopSettledCall<ToolExecutionResult> | undefined>(ordered.length);
  const immediate = ordered.map((call, index) => ({ call, index })).filter(({ call }) => !isSkillToolName(call.toolName));
  const deferred = ordered.map((call, index) => ({ call, index })).filter(({ call }) => isSkillToolName(call.toolName));
  let cursor = 0;
  let firstError: unknown;
  async function worker(entries: typeof immediate): Promise<void> {
    while (firstError === undefined) {
      const entry = entries[cursor];
      cursor += 1;
      if (!entry) return;
      const { call, index } = entry;
      try {
        results[index] = await executePersistedToolCall(call, context, signal);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, immediate.length) }, () => worker(immediate))
  );
  cursor = 0;
  await worker(deferred);
  if (firstError !== undefined) throw firstError;
  if (results.some((result) => result === undefined)) {
    throw new ToolLoopRecoveryError(
      "tool_batch_incomplete",
      "The recovered tool batch did not settle every call."
    );
  }
  return results as readonly ToolLoopSettledCall<ToolExecutionResult>[];
}

async function recoverCheckpointedToolLoop(
  deps: RunRecoveryDeps,
  run: CheckpointedToolLoopRun,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || run.status === "cancelled" || !run.assistantMessageId) return;

  const usageAttributions: RunUsageAttribution[] = [];
  let answerRoundUsage = [...run.checkpoint.answerRoundUsage];
  let usageEvidenceTrusted = true;
  let persistCancelledUsage: (() => Promise<void>) | undefined;
  let currentProviderResponseId = run.providerResponseId;
  let tokenBuffer: ReturnType<typeof createRunTokenPersistenceBuffer> | null = null;
  const compactionPublisher = createContextCompactionPublisher(async status => {
    await deps.repository.appendRunOutputEvent(run.id, contextCompactionArtifact(status));
  }, run.contextCompactionStatus);
  // Terminal Workspace settlement for a recovered turn that stops or fails:
  // best effort, never allowed to mask the run's own terminal persistence.
  const onWorkspaceActivity = async (entry: ThreadWorkspaceActivityEntry) => {
    const event = projectRunOutputArtifactEvent(workspaceActivityEvent(entry));
    if (event) await deps.repository.appendRunOutputEvent(run.id, event);
  };
  const settleRecoveredWorkspaceOnExit = async (outcome: "cancelled" | "failed") => {
    const savedWorkspace = run.normalizedRequest.workspace;
    if (!savedWorkspace || !deps.workspace) return;
    await deps.workspace.settle({
      onActivity: onWorkspaceActivity,
      outcome,
      runId: run.id,
      userId: run.userId,
      workspace: savedWorkspace
    }).catch((settlementError: unknown) => logEvent("run_recovery", { subsystem: "run_recovery", stage: "release", outcome: "failed",
      code: observedFailureCode(settlementError), prisma_code: databaseFailureCode(settlementError), action: "retry" }));
  };

  function allUsageAttributions(): RunUsageAttribution[] {
    return [
      ...usageAttributions,
      ...answerRoundUsage.map((entry) => ({
        operationCount: 1,
        modelId: run.modelId,
        provider: run.provider,
        usage: entry.usage
      }))
    ];
  }

  try {
    const savedKnowledgeRuntime = run.normalizedRequest as unknown as Readonly<{
      knowledgeFocusedRequest?: unknown;
      knowledgePlanner?: unknown;
    }>;
    if (savedKnowledgeRuntime.knowledgeFocusedRequest !== undefined) {
      throw new ToolLoopRecoveryError(
        "knowledge_focused_request_unavailable",
        "Focused Knowledge recovery must use its durable one-shot request."
      );
    }
    if (savedKnowledgeRuntime.knowledgePlanner !== undefined) {
      throw new ToolLoopRecoveryError(
        "knowledge_legacy_runtime_retired",
        "The retired Knowledge planning runtime cannot be replayed."
      );
    }
    if (run.normalizedRequest.memoryActionTools !== undefined ||
      run.normalizedRequest.memoryHistoryTool !== undefined) {
      throw new ToolLoopRecoveryError(
        "memory_answer_model_tools_retired",
        "Checkpointed answer-model Memory tools cannot be replayed."
      );
    }
    if (run.calls.some(isFocusedKnowledgeCall) ||
      run.calls.some((call) => call.toolName === "retrieve_knowledge")) {
      throw new ToolLoopRecoveryError(
        "knowledge_legacy_runtime_retired",
        "Checkpointed legacy Knowledge calls cannot be replayed through the generic tool loop."
      );
    }
    const recoveredKnowledgeEnabled =
      run.normalizedRequest.knowledgePlan.mode !== "none";
    if (recoveredKnowledgeEnabled &&
      (!run.knowledgeScope || (run.knowledgeScope.resolvedSourceCount ?? 0) < 1 ||
        !deps.knowledgeExecutor?.tools?.length)) {
      throw new ToolLoopRecoveryError(
        "knowledge_retrieval_failed",
        "The saved Knowledge tool configuration is unavailable."
      );
    }
    const providerRuntime = await resolveAnswerRuntime(deps, run.id, run.provider);
    const adapter = providerRuntime?.adapter;
    const bridge = providerRuntime?.toolBridge ??
      providerToolBridges[run.provider as keyof typeof providerToolBridges];
    const attachmentLimits = deps.getAttachmentLimits?.() ?? getRunAttachmentLimits();
    const attachmentIds = validatePersistedAttachmentReferences(
      run.normalizedRequest.content.blocks,
      run.normalizedRequest.attachmentIds,
      attachmentLimits
    );
    const persistedUsage = await deps.repository.loadRunUsageAttributions({
      runId: run.id,
      userId: run.userId
    });
    const persistedAttributions = persistedUsage.map(
      ({ recordedAt: _recordedAt, ...attribution }) => attribution
    );
    const nonAnswerAttributions = usageAttributionsWithoutAnswerRounds(
      persistedAttributions,
      run,
      answerRoundUsage
    );
    if (!nonAnswerAttributions) {
      usageEvidenceTrusted = false;
      throw new ToolLoopRecoveryError(
        "tool_loop_usage_evidence_invalid",
        "Saved provider-round usage is inconsistent with the persisted run totals."
      );
    }
    usageAttributions.push(...nonAnswerAttributions);
    if (!adapter || !bridge?.supportsToolCalling({ modelId: run.modelId, provider: run.provider })) {
      throw new ToolLoopRecoveryError(
        "tool_calling_not_supported",
        `Tool calling is not available for provider ${run.provider}.`
      );
    }

    const attachments = await loadProviderAttachments(
      deps,
      run.userId,
      attachmentIds,
      {
        capabilities: run.normalizedRequest.modelCapabilities,
        runId: run.id,
        ...(run.project ? { projectId: run.project.projectId } : {}),
        limits: attachmentLimits,
        signal,
        workspaceEnabled: run.normalizedRequest.workspace !== undefined
      }
    );
    if (attachments.length !== attachmentIds.length) {
      throw new ToolLoopRecoveryError(
        "attachment_not_available",
        "A run attachment is no longer available for tool-loop recovery."
      );
    }
    let providerRequest: ProviderRunRequest = {
      ...run.normalizedRequest,
      attachments,
      ...(run.checkpoint.contextCompaction?.measurement
        ? { contextCompaction: run.checkpoint.contextCompaction.measurement }
        : {}),
      ...(run.checkpoint.contextCompaction?.summary ? { contextCompactionSummary: run.checkpoint.contextCompaction.summary } : {}),
      ...(run.checkpoint.contextCompaction?.summaryAttempts ? { contextCompactionSummaryAttempts: run.checkpoint.contextCompaction.summaryAttempts } : {})
    };
    if (run.checkpoint.contextCompaction?.summary) {
      providerRequest = applyContextSummaryToRequest(
        providerRequest,
        run.checkpoint.contextCompaction.summary,
        run.checkpoint.contextCompaction.summaryAttempts
      );
    }
    if (deps.images) providerRequest = await deps.images.withConversationPixels(providerRequest, run.userId, signal);
    const clientToolsEnabled = run.normalizedRequest.toolMode !== "none";
    const planRuntimes: Record<string, ProviderRuntimeBinding> = {};
    for (const option of clientToolsEnabled
      ? run.normalizedRequest.searchPlan.options
      : []) {
      if (option.adapterKind !== "provider_model_client") continue;
      const optionRuntime = await resolvePlanSearchRuntime(deps, run.id, option);
      if (!optionRuntime) {
        throw new ToolLoopRecoveryError(
          "search_policy_not_available",
          `The saved Search source ${JSON.stringify(option.displayName || "Search source")} is no longer available.`
        );
      }
      planRuntimes[option.optionId] = optionRuntime;
    }
    const candidatePlanSearchRouter = clientToolsEnabled
      ? createSearchPlanToolRouter({
          plan: run.normalizedRequest.searchPlan,
          runtimes: planRuntimes
        })
      : null;
    const settledSearchInvocationCounts: Record<string, number> = {};
    if (candidatePlanSearchRouter) {
      for (const call of run.calls) {
        if (
          (call.state !== "complete" && call.state !== "error") ||
          !candidatePlanSearchRouter.accepts(call.toolName)
        ) {
          continue;
        }
        const stored = parsePersistedToolExecutionResult(modelToolCall(call), call.result);
        if (stored?.rawPreview?.providerCall === false) continue;
        for (const optionId of candidatePlanSearchRouter.optionIdsForTool(call.toolName)) {
          settledSearchInvocationCounts[optionId] =
            (settledSearchInvocationCounts[optionId] ?? 0) + 1;
        }
      }
    }
    const planSearchRouter = clientToolsEnabled
      ? createSearchPlanToolRouter({
          initialInvocationCounts: settledSearchInvocationCounts,
          plan: run.normalizedRequest.searchPlan,
          runtimes: planRuntimes
        })
      : null;
    const searchExecutor: RecoverySearchExecutor | null = planSearchRouter
      ? {
          optionIdsForTool: (name) => planSearchRouter.optionIdsForTool(name),
          accepts: (name) => planSearchRouter.accepts(name),
          execute: (call, request, _runId, executionSignal) =>
            planSearchRouter.execute(call, request, { signal: executionSignal,
              ...(run.normalizedRequest.toolObservationVersion === 1 ? { retainOriginal: true as const } : {}) }),
          tools: planSearchRouter.tools
        }
      : null;
    const rawMcpDiscovery = run.normalizedRequest.mcpDiscovery;
    const toolBudgets = toolRunBudgetsForRequest(run.normalizedRequest);
    const decodedMcpDiscovery = rawMcpDiscovery === undefined
      ? undefined
      : decodeMcpDiscoveryState(rawMcpDiscovery, toolBudgets.maxMcpToolsPerDiscovery);
    if (rawMcpDiscovery !== undefined && !decodedMcpDiscovery) {
      throw new ToolLoopRecoveryError(
        "mcp_discovery_state_invalid",
        "The saved MCP discovery state is invalid."
      );
    }
    const activeMcpDiscovery = decodedMcpDiscovery ?? undefined;
    if (activeMcpDiscovery &&
      (!deps.mcp?.materialize || !deps.repository.appendMcpDiscoveryEpoch)) {
      throw new ToolLoopRecoveryError(
        "mcp_discovery_not_available",
        "The saved MCP discovery policy is no longer available."
      );
    }
    const workspace = run.normalizedRequest.workspace;
    if (workspace && !deps.workspace) {
      throw new ToolLoopRecoveryError(
        "workspace_runtime_unavailable",
        "The saved Workspace runtime is unavailable."
      );
    }
    const workspaceTools = clientToolsEnabled && workspace && deps.workspace
      ? await deps.workspace.tools({
          runId: run.id,
          userId: run.userId,
          workspace
        })
      : [];
    const tools: RunTool[] = [
      ...skillToolsForRequest(run.normalizedRequest),
      ...(run.normalizedRequest.workspaceCheckpoints ? [checkpointOutputsTool] : []),
      ...(run.normalizedRequest.visionAnalysis ? [analyzeImageTool(run.normalizedRequest.visionAnalysis)] : []),
      ...(run.normalizedRequest.workspaceImageView ? [viewWorkspaceImageTool] : []),
      ...(clientToolsEnabled && run.normalizedRequest.imagePlan ? [imageGenerationTool(run.normalizedRequest.imagePlan)] : []),
      ...(clientToolsEnabled && run.normalizedRequest.artifactTool ? [artifactTool(run.normalizedRequest.artifactToolDescription), ...(run.normalizedRequest.artifactReferences?.length ? [readArtifactTool()] : [])] : []),
      ...(run.normalizedRequest.sessionStatusTool ? [sessionStatusTool] : []),
      ...(run.normalizedRequest.toolObservationVersion === 1 ? [readToolResultTool] : []),
      ...(recoveredKnowledgeEnabled
        ? knowledgeRetrievalToolsForRequest(run.normalizedRequest, deps.knowledgeExecutor?.tools ?? [])
        : []),
      ...(searchExecutor?.tools ?? []),
      ...(activeMcpDiscovery ? [mcpFindToolsTool] : []),
      ...(clientToolsEnabled ? mcpRunTools(run.normalizedRequest.mcp) : []),
      ...workspaceTools
    ];
    if (tools.length === 0) {
      throw new ToolLoopRecoveryError(
        "tool_configuration_empty",
        "The saved run has no recoverable tools."
      );
    }
    const externalToolsPresent = tools.some((tool) =>
      tool.capability !== "artifact" && tool.capability !== "memory" && tool.capability !== "session" && tool.capability !== "skill"
    );
    const hostedSearchPresent = requestHasHostedSearchCapability(providerRequest);
    const egressReceiptRequired = externalToolsPresent ||
      hostedSearchPresent ||
      requestHasServerExternalTools(providerRequest) ||
      providerRequest.personalContext !== undefined;
    if (egressReceiptRequired && !deps.memoryEgress && process.env.NODE_ENV === "production") {
      throw new ToolLoopRecoveryError(
        "memory_egress_receipt_unavailable",
        "Memory egress evidence is unavailable."
      );
    }
    assertPersonalContextEgressSafe(providerRequest);
    let runtime = deps.mcpRuntime;
    const context: RecoveryToolContext = {
      skillResultBudget: createSkillToolResultBudget(),
      activeMcpDiscovery,
      activeMcpSnapshot: run.normalizedRequest.mcp,
      deps,
      knowledgeResults: new Map(),
      mcpDiscoveryBatches: new Map(),
      mcpDiscoveryQueue: Promise.resolve(),
      sessionToolBridge: bridge,
      sessionRequest: {
        ...providerRequest,
        tools,
        providerToolMessages: [...parseProviderToolLoopContinuation(run.checkpoint.providerContinuation).providerToolMessages]
      },
      providerRequest,
      run,
      runtime() {
        runtime ??= getDefaultMcpRuntimeCoordinator();
        return runtime;
      },
      searchExecutor,
      tools,
      usageAccountedToolCallIds: new Set(),
      usageAttributions
    };
    async function finalizeRecoveredWorkspace(): Promise<void> {
      if (!workspace) return;
      if (!deps.workspace) {
        throw new ToolLoopRecoveryError(
          "workspace_runtime_unavailable",
          "The saved Workspace runtime is unavailable."
        );
      }
      // Capture and receiver retirement are terminal prerequisites; object
      // transfer belongs to the independent durable export worker.
      const handoff = await deps.workspace.handoff({
        onActivity: onWorkspaceActivity,
        runId: run.id,
        signal,
        userId: run.userId,
        workspace
      });
      if (handoff.status === "busy") throw new WorkspaceHandoffDeferred();
      signal.throwIfAborted();
    }
    tokenBuffer = createRunTokenPersistenceBuffer({
      allowErroredAssistant: true,
      assistantMessageId: run.assistantMessageId,
      initialText: run.assistantText ?? "",
      repository: deps.repository,
      runId: run.id
    });

    async function* streamRecoveredProviderRequest(
      request: ProviderRunRequest,
      dispatchSignal: AbortSignal
    ): ReturnType<ProviderAdapter["stream"]> {
      let receipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
      let preview: Record<string, unknown> | null = null;
      const requestPreview = () => {
        preview ??= adapter!.buildRequestPreview(request);
        return preview;
      };
      try {
        if (egressReceiptRequired && !deps.memoryEgress && process.env.NODE_ENV === "production") {
          throw new ToolLoopRecoveryError(
            "memory_egress_receipt_unavailable",
            "Memory egress evidence is unavailable."
          );
        }
        if (run.project && !(await currentProjectRecoveryAuthorityAllowed(
          deps,
          run.project,
          run.userId
        ))) {
          throw new ToolLoopRecoveryError(
            "provider_admission_changed",
            "Project provider authority is no longer current."
          );
        }
        if (requestHasHostedSearchCapability(request) &&
          !(await currentRecoverySearchDispatchAllowed(context))) {
          await deps.memoryEgress?.recordBlockedDispatch({
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
            runId: run.id,
            userId: run.userId
          });
          throw new ToolLoopRecoveryError(
            "search_strategy_not_available",
            "The selected search destination is no longer available."
          );
        }
        receipt = egressReceiptRequired && deps.memoryEgress
          ? await deps.memoryEgress.beginDispatch({
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
              runId: run.id,
              userId: run.userId
            })
          : null;
        const wireRequest = request.workspaceImageView
          ? await (await defaultWorkspaceImageViewer()).materialize(request, run.id, run.userId, dispatchSignal) : request;
        const stream = adapter!.stream(wireRequest, { signal: dispatchSignal });
        let next = await stream.next();
        while (!next.done) {
          yield next.value;
          next = await stream.next();
        }
        if (receipt) yield { type: "usage", data: next.value.usage };
        if (receipt && !(await deps.memoryEgress!.completeDispatch(receipt.id)
          .catch(error => { throw new RunSettlementError("completion", error); }))) {
          throw new ToolLoopRecoveryError(
            "memory_egress_receipt_conflict",
            "Provider dispatch evidence could not be completed."
          );
        }
        return next.value;
      } catch (error) {
        if (receipt) {
          await deps.memoryEgress!.failDispatch(
            receipt.id,
            error instanceof ToolLoopRecoveryError
              ? error.code
              : "provider_dispatch_failed"
          ).catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "fail"));
        }
        throw error;
      }
    }

    const egressAdapter: ProviderAdapter = {
      buildRequestPreview(request) {
        return adapter!.buildRequestPreview(request);
      },
      stream(request, options) {
        return streamRecoveredProviderRequest(
          request,
          options?.signal ?? signal
        );
      }
    };

    async function persistCumulativeUsage(
      answerRoundEntry?: PersistedAnswerRoundUsage
    ): Promise<void> {
      const grouped = groupedUsageAttributions(allUsageAttributions());
      if (grouped.length === 0 && !answerRoundEntry &&
        context.usageAccountedToolCallIds.size === 0) return;
      const recorded = await deps.repository.recordRunUsageEvents({
        ...(answerRoundEntry ? { answerRoundUsage: answerRoundEntry } : {}),
        chatId: run.chatId,
        runId: run.id,
        usageAccountedToolCallIds: [...context.usageAccountedToolCallIds],
        usageAttributions: await usageAttributionsWithEstimatedCost(deps.repository, grouped),
        userId: run.userId
      });
      if ((answerRoundEntry || context.usageAccountedToolCallIds.size > 0) && !recorded) {
        usageEvidenceTrusted = false;
        throw new ToolLoopRecoveryError(
          "tool_loop_usage_checkpoint_conflict",
          "Recovered provider-round usage could not be checkpointed."
        );
      }
      if (recorded) {
        context.usageAccountedToolCallIds.clear();
      }
    }

    persistCancelledUsage = () => persistCumulativeUsage();

    async function recordAnswerRoundUsage(
      usage: ModelRunUsage,
      request: Readonly<{ modelId: string; provider: string }>,
      completeness: PersistedAnswerRoundUsage["completeness"],
      round: number
    ): Promise<void> {
      if (request.modelId !== run.modelId || request.provider !== run.provider) {
        throw new ToolLoopRecoveryError(
          "tool_loop_usage_evidence_invalid",
          "Recovered provider-round usage does not match the saved answer model."
        );
      }
      const entry: PersistedAnswerRoundUsage = {
        completeness,
        roundIndex: round,
        usage: normalizeTokenUsage({ ...usage, ...(completeness === "partial" ? { completeness: "partial" } : {}) })
      };
      const merged = mergeAnswerRoundUsage(answerRoundUsage, entry, round);
      if (!merged) {
        throw new ToolLoopRecoveryError(
          "tool_loop_usage_evidence_invalid",
          "Recovered provider-round usage conflicts with saved terminal evidence."
        );
      }
      answerRoundUsage = [...merged];
      await persistCumulativeUsage(entry);
    }

    async function publishProviderResponseId(providerResponseId: string | undefined): Promise<void> {
      if (!providerResponseId || providerResponseId === currentProviderResponseId) return;
      const publication = await deps.repository.updateRunProviderResponseId(
        run.id,
        providerResponseId
      );
      currentProviderResponseId = providerResponseId;
      if (publication === "cancelled") {
        await adapter!.cancel?.(providerResponseId).catch(() => undefined);
        throw new ToolLoopRecoveryStopped();
      }
      if (publication === "terminal") throw new ToolLoopRecoveryStopped();
    }

    async function appendEvent(event: ModelRunSseEvent): Promise<void> {
      if (event.type === "artifact" && (event.data.artifactType === "context_status" || event.data.artifactType === "context_compaction")) return;
      const effectiveEvent = withPinnedHostedSearchIdentity(event, run.normalizedRequest);
      if (effectiveEvent.type === "token") {
        if (recoveredKnowledgeEnabled) return;
        await tokenBuffer!.push(effectiveEvent.data.delta);
        return;
      }
      await tokenBuffer!.flush();
      await publishProviderResponseId(providerResponseIdFromEvent(effectiveEvent) ?? undefined);
      const outputEvent = projectRunOutputArtifactEvent(effectiveEvent);
      if (outputEvent) {
        await deps.repository.appendRunOutputEvent(run.id, outputEvent);
      }
    }

    async function appendToolResults(
      results: readonly ToolLoopSettledCall<ToolExecutionResult>[]
    ): Promise<void> {
      for (const settled of results) {
        const call = {
          arguments: isRecord(settled.call.arguments) ? settled.call.arguments : {},
          id: settled.call.id,
          name: settled.call.name
        };
        const result = settled.result.status === "complete"
          ? settled.result.value
          : toolExecutionErrorResult(call, settled.result.error.message);
        for (const artifact of result.artifacts ?? []) await appendEvent(artifact);
      }
    }

    async function prepareRecoveredProviderRequest(
      roundRequest: ProviderRunRequest,
      round: number,
      /** `measure` records an already-dispatched round whose result is being
       * refreshed: it is never sent again, so it buys no summary and publishes
       * no cycle for work that did not happen here. */
      mode: "dispatch" | "measure" = "dispatch"
    ): Promise<ProviderRunRequest> {
      const currentRequest = {
          ...roundRequest,
          ...(context.activeMcpDiscovery && round === 1
            ? { parallelToolCalls: false }
            : {}),
          ...(context.activeMcpSnapshot ? { mcp: context.activeMcpSnapshot } : {}),
          ...(context.activeMcpDiscovery
            ? { mcpDiscovery: context.activeMcpDiscovery }
            : {})
      };
      const requestForBudget = deps.mcp
        ? await filterMcpProviderRequest(currentRequest, run.userId, deps.mcp.filterTools)
        : currentRequest;
      if (mode === "measure") {
        const measured = applyProviderRequestContextBudget({ bridge, request: requestForBudget });
        if (!measured.ok) throw new ToolLoopRecoveryError("context_too_large", measured.error.message);
        context.sessionRequest = measured.request;
        return measured.request;
      }
      // The live run's consumer: measure this round first, then decide. A
      // recovered request is never dispatched while it still needs a summary.
      context.sessionRequest = await prepareCompactedProviderRequest({
        bridge,
        failure: (code, message) => new ToolLoopRecoveryError(code, message),
        onSummaryUsage(usage, source) {
          context.usageAttributions.push({ modelId: source.modelId, operationCount: 1, provider: source.provider, usage });
        },
        onTruncation: truncation => appendEvent({
          data: {
            artifactType: "context_truncated",
            payload: truncation
          },
          type: "artifact"
        }),
        publisher: compactionPublisher,
        request: requestForBudget,
        signal,
        summaryAdapter: egressAdapter
      });
      return context.sessionRequest;
    }

    const persistedCalls = new Map<string, PersistedToolLoopCall>(
      run.calls.map((call) => [call.providerCallId, call])
    );

    function recoveredKnowledgeDispatchDraft(): KnowledgeEvidenceDispatchManifestDraft | null {
      const calls = [...persistedCalls.values()]
        .filter((call) => call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME)
        .sort((left, right) => left.roundIndex - right.roundIndex ||
          left.ordinal - right.ordinal ||
          left.providerCallId.localeCompare(right.providerCallId));
      if (calls.length < 1) {
        throw new ToolLoopRecoveryError(
          "knowledge_retrieval_required",
          "The recovered Knowledge run ended without a retrieval call."
        );
      }
      const results = calls.map((call) => {
        const result = context.knowledgeResults.get(call.providerCallId);
        if (!result) {
          throw new ToolLoopRecoveryError(
            "knowledge_retrieval_failed",
            "A recovered Knowledge result is not settled."
          );
        }
        return result;
      });
      try {
        return toolLoopKnowledgeEvidenceDispatchDraft({ exclusions: run.knowledgeScope?.exclusions, request: providerRequest, results });
      } catch (error) {
        const failureCode = knowledgeSearchFailureCode(error);
        throw new ToolLoopRecoveryError(
          failureCode ?? (error instanceof Error && error.message === "no_retrieval_candidates"
            ? "no_retrieval_candidates"
            : "knowledge_retrieval_failed"),
          failureCode ? knowledgeSearchFailureMessage(failureCode) : "The recovered Knowledge evidence manifest is invalid."
        );
      }
    }

    function recoveredKnowledgeSearchUnavailable(): boolean {
      return [...persistedCalls.values()]
        .filter((call) => call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME)
        .some((call) => {
          const result = context.knowledgeResults.get(call.providerCallId);
          return result !== undefined &&
            knowledgeEvidenceFromToolResult(result)?.outcome === "search_unavailable";
        });
    }

    async function finalizeRecoveredKnowledgeToolLoop(): Promise<void> {
      await tokenBuffer!.flush();
      await persistCumulativeUsage();
      await finalizeRecoveredWorkspace();
      const dispatchDraft = recoveredKnowledgeDispatchDraft();
      const latest = await loadRecoveryRunControl(deps, run.id, run.userId);
      if (!latest || !isRefreshableRun(latest) || !latest.assistantMessageId) {
        throw new ToolLoopRecoveryStopped();
      }
      if (!dispatchDraft) {
        const attributions = groupedUsageAttributions(allUsageAttributions());
        const completion = await finalizeRunCompletion({
          knowledgeZeroEvidence: true,
          repository: deps.repository,
          result: {
            finalText: knowledgeScopeLimitedMessage(
              recoveredKnowledgeSearchUnavailable()
                ? KNOWLEDGE_SEARCH_UNAVAILABLE_MESSAGE
                : KNOWLEDGE_INSUFFICIENT_MESSAGE,
              run.knowledgeScope?.exclusions
            ),
            ...(currentProviderResponseId
              ? { providerResponseId: currentProviderResponseId }
              : {}),
            usage: sumTokenUsage(attributions.map((entry) => entry.usage)),
            usageAttributions: attributions
          },
          run: {
            assistantMessageId: latest.assistantMessageId,
            chatId: latest.chatId,
            modelId: latest.modelId,
            provider: latest.provider,
            runId: run.id,
            userId: run.userId
          }
        });
        if (completion.status === "not_completed") throw new ToolLoopRecoveryStopped();
        return;
      }
      const requestText = textFromContentBlocks(run.normalizedRequest.content).trim();
      if (!requestText) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The accepted Knowledge request is empty."
        );
      }
      await recoverKnowledgeAnswerGrounding(deps, {
        control: latest,
        runId: run.id,
        seed: {
          draft: dispatchDraft,
          ...(run.normalizedRequest.knowledgeAnswerWorkflowVersion !== undefined ? { workflowVersion: run.normalizedRequest.knowledgeAnswerWorkflowVersion } : {}),
          repairFeedbackVersion: run.normalizedRequest.knowledgeReviewRepairFeedbackVersion,
          generationBudget: run.normalizedRequest.knowledgeGenerationBudget,
          ...(run.normalizedRequest.prompt.responseReminder !== undefined ? { answerInstructions: knowledgeAnswerInstructions(run.normalizedRequest.prompt) } : {}),
          modelCapabilities: run.normalizedRequest.modelCapabilities,
          reasoningEffort: knowledgeGroundingInheritedReasoningEffortV1({
            acceptedReasoningEffort: run.normalizedRequest.reasoningEffort,
            params: run.normalizedRequest.params
          }),
          request: requestText,
          routeInstruction: KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION,
          transport: providerRuntime?.structuredOutputAdapter
            ? "native_strict"
            : "provider_neutral_json"
        },
        signal,
        userId: run.userId
      });
    }

    async function persistToolBatch(
      calls: readonly Readonly<{ arguments: unknown; id: string; name: string }>[],
      continuation: ProviderToolLoopContinuation,
      round: number
    ): Promise<readonly PersistedToolLoopCall[]> {
      context.sessionRequest = { ...(context.sessionRequest ?? context.providerRequest), providerToolMessages: [...continuation.providerToolMessages] };
      context.skillResultBudget.begin({ calls, request: context.sessionRequest, bridge });
      const persisted = await deps.repository.persistToolLoopCallBatch({
        calls: calls.map((call, ordinal) => {
          const route = resolveMcpRunTool(context.activeMcpSnapshot, call.name);
          if (!route && !isRecoveredKnowledgeCall(context, call.name) &&
            searchExecutor?.accepts(call.name) !== true &&
            !isRecoveredMcpDiscoveryCall(context, call.name) &&
            !(run.normalizedRequest.workspaceCheckpoints && call.name === CHECKPOINT_OUTPUTS_TOOL_NAME) &&
            !(run.normalizedRequest.visionAnalysis && call.name === ANALYZE_IMAGE_TOOL_NAME) &&
            !(run.normalizedRequest.workspaceImageView && call.name === VIEW_WORKSPACE_IMAGE) &&
            !(run.normalizedRequest.imagePlan && call.name === IMAGE_GENERATION_TOOL_NAME) &&
            !isRecoveredArtifactCall(context, call.name) &&
            !isRecoveredWorkspaceCall(context, call.name) &&
            !isRecoveredSkillCall(context, call.name) &&
            !isRecoveredObservationRead(context, call.name) &&
            !(run.normalizedRequest.sessionStatusTool === true && call.name === SESSION_STATUS_TOOL_NAME)) {
            throw new ToolLoopRecoveryError(
              "unsupported_tool_call",
              `The provider requested unsupported tool ${call.name}.`
            );
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
            ...(isRecoveredWorkspaceCall(context, call.name)
              ? { workspace: true as const }
              : {})
          };
        }),
        providerContinuation: toolLoopJson(
          continuation,
          toolLoopPersistenceLimits.checkpointBytes,
          "tool_loop_checkpoint_invalid"
        ),
        roundIndex: round,
        runId: run.id,
        userId: run.userId,
        ...(!run.normalizedRequest.agent && run.normalizedRequest.toolObservationVersion === 1 && context.sessionRequest
          ? { contextCompaction: contextCompactionCheckpoint({
              ownerId: run.userId,
              request: context.sessionRequest,
              runId: run.id,
              observationRefs: observationHandlesInProviderMessages(context.sessionRequest.providerToolMessages ?? []),
              recentTailCallIds: observationCallIdsInProviderMessages(context.sessionRequest.providerToolMessages ?? []),
              ...(context.sessionRequest.contextCompactionSummary ? { summary: context.sessionRequest.contextCompactionSummary } : {}),
              ...(context.sessionRequest.contextCompactionSummaryAttempts ? { summaryAttempts: context.sessionRequest.contextCompactionSummaryAttempts } : {}),
              measurement: context.sessionRequest.contextCompaction
            }) }
          : {})
      });
      if (persisted.kind === "cancelled") throw new ToolLoopRecoveryStopped();
      if (persisted.kind !== "persisted" && persisted.kind !== "reused") {
        throw new ToolLoopRecoveryError(
          "tool_loop_checkpoint_conflict",
          "The recovered tool batch could not be persisted."
        );
      }
      for (const call of persisted.calls) persistedCalls.set(call.providerCallId, call);
      registerRecoveredMcpDiscoveryBatch(persisted.calls, context);
      return persisted.calls;
    }

    async function providerRunningRequest(
      savedContinuation: ProviderToolLoopContinuation,
      round: number
    ): Promise<ProviderRunRequest> {
      const priorCalls = run.calls.filter((call) => call.roundIndex === round - 1);
      const priorResults = priorCalls.length > 0
        ? await executePersistedToolBatch(priorCalls, context, signal)
        : [];
      const providerToolMessages = [
        ...savedContinuation.providerToolMessages,
        ...priorResults.map((settled) => {
          const result = settled.result.status === "complete"
            ? settled.result.value
            : toolExecutionErrorResult(
                {
                  arguments: isRecord(settled.call.arguments) ? settled.call.arguments : {},
                  id: settled.call.id,
                  name: settled.call.name
                },
                settled.result.error.message
              );
          return bridge.appendToolResult(undefined, projectObservationForProvider(result));
        })
      ];
      const completedToolRounds = Math.max(0, round - 1);
      const priorToolCalls = run.calls.filter((call) => call.roundIndex > 0).length;
      const toolChoice = completedToolRounds >= toolBudgets.maxToolRounds ||
        priorToolCalls >= toolBudgets.maxToolCalls || providerRequest.toolChoice === "none"
        ? "none"
        : completedToolRounds === 0 && providerRequest.toolChoice === "required" ? "required" : "auto";
      const prepared = await prepareRecoveredProviderRequest({
        ...providerRequest,
        parallelToolCalls: run.normalizedRequest.modelCapabilities.parallelToolCalls === true,
        providerToolMessages,
        toolChoice,
        tools
      }, round, "measure");
      return toolChoice === "none" ? { ...prepared, toolChoice } : prepared;
    }

    let continuation = parseProviderToolLoopContinuation(run.checkpoint.providerContinuation);
    let currentCalls: readonly PersistedToolLoopCall[];

    if (run.checkpoint.phase === "provider_running") {
      const round = run.checkpoint.roundIndex;
      const roundRequest = await providerRunningRequest(continuation, round);
      let refreshed: ProviderRunRefreshResult;
      if (!currentProviderResponseId) {
        throw new ToolLoopRecoveryError(
          "tool_loop_provider_round_outcome_unknown",
          "The model round stopped before a durable provider response ID was saved and was not repeated."
        );
      }
      if (!adapter.refresh) {
        throw new ToolLoopRecoveryError(
          "provider_resume_not_supported",
          "The provider cannot resume the saved model round."
        );
      }
      refreshed = await adapter.refresh(currentProviderResponseId).catch((error: unknown) => {
        throw new ToolLoopRecoveryError(
          "provider_refresh_failed",
          error instanceof Error ? error.message : "Provider refresh failed"
        );
      });
      await publishProviderResponseId(
        refreshed.result?.providerResponseId ?? refreshed.providerResponseId
      );
      if (!refreshed.terminal) {
        for (const event of refreshed.events) await appendEvent(event);
        await tokenBuffer.flush();
        return;
      }
      if (egressReceiptRequired && deps.memoryEgress &&
        !(await deps.memoryEgress.settleRecoveredProviderDispatch({
          ...(refreshed.result
            ? {}
            : { errorCode: refreshed.error?.code ?? "provider_terminal_response_invalid" }),
          outcome: refreshed.result ? "COMPLETED" : "FAILED",
          runId: run.id,
          userId: run.userId
        }))) {
        throw new ToolLoopRecoveryError(
          "memory_egress_receipt_conflict",
          "Recovered provider dispatch evidence could not be settled."
        );
      }
      if (!refreshed.result) {
        await settleToolLoopRecoveryError(
          deps,
          run,
          refreshed.error ?? {
            code: "provider_terminal_response_invalid",
            message: "The provider returned a terminal response without a final result."
          },
          allUsageAttributions(),
          refreshed.events,
          currentProviderResponseId
        );
        return;
      }
      await recordAnswerRoundUsage(
        refreshed.result.usage,
        run,
        "terminal",
        run.checkpoint.roundIndex
      );
      if (roundRequest.toolChoice === "none" && (refreshed.result.toolCalls?.length ?? 0) > 0) {
        // A refreshed final provider round has the same authority as the live
        // round. Preserve its available text without replaying token deltas or
        // persisting/dispatching the forbidden tool batch.
        const priorText = run.assistantText ?? "";
        if (!recoveredKnowledgeEnabled && refreshed.result.finalText.startsWith(priorText)) {
          await tokenBuffer.push(refreshed.result.finalText.slice(priorText.length));
        }
        throw new ToolLoopRecoveryError(TOOL_SYNTHESIS_FAILURE.code, TOOL_SYNTHESIS_FAILURE.message);
      }
      if ((refreshed.result.toolCalls?.length ?? 0) === 0) {
        if (recoveredKnowledgeEnabled) {
          await finalizeRecoveredKnowledgeToolLoop();
          return;
        }
        const groupedAttributions = groupedUsageAttributions(allUsageAttributions());
        await finalizeRecoveredWorkspace();
        const completion = await finalizeRunCompletion({
          outputEvents: [...runOutputArtifactEvents(refreshed.events), {
            type: "artifact", data: { artifactType: "context_status", payload: measureSessionContext({
              answerText: refreshed.result.finalText, bridge, request: context.sessionRequest ?? providerRequest
            }) }
          }],
          repository: deps.repository,
          result: {
            ...refreshed.result,
            providerResponseId: currentProviderResponseId ?? undefined,
            usage: sumTokenUsage(groupedAttributions.map((entry) => entry.usage)),
            usageAttributions: groupedAttributions
          },
          run: {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            modelId: run.modelId,
            provider: run.provider,
            runId: run.id,
            userId: run.userId
          }
        });
        if (completion.status === "not_completed") {
          throw new ToolLoopRecoveryError(
            "tool_loop_completion_conflict",
            "The recovered model round could not win terminal completion."
          );
        }
        return;
      }
      for (const event of refreshed.events) await appendEvent(event);
      continuation = providerToolLoopContinuationAfterResult(
        bridge,
        continuation,
        refreshed.result
      );
      currentCalls = await persistToolBatch(
        refreshed.result.toolCalls ?? [],
        continuation,
        run.checkpoint.roundIndex
      );
    } else {
      currentCalls = run.calls.filter((call) => call.roundIndex === run.checkpoint.roundIndex);
      if (currentCalls.length === 0) {
        throw new ToolLoopRecoveryError(
          "tool_loop_checkpoint_invalid",
          "The saved tool-loop batch is missing."
        );
      }
      const usageResponseId = currentProviderResponseId ?? continuation.providerResponseId;
      const currentAnswerEvidence = answerRoundUsage.find((entry) =>
        entry.roundIndex === run.checkpoint.roundIndex);
      if (currentAnswerEvidence?.completeness !== "terminal") {
        if (!usageResponseId || !adapter.refresh) {
          throw new ToolLoopRecoveryError(
            "tool_loop_usage_evidence_invalid",
            "The saved tool batch is missing terminal provider-round usage evidence."
          );
        }
        const currentRound = await adapter.refresh(usageResponseId).catch(() => null);
        if (!currentRound?.terminal || !currentRound.result) {
          throw new ToolLoopRecoveryError(
            "tool_loop_usage_evidence_invalid",
            "Terminal provider-round usage could not be recovered for the saved tool batch."
          );
        }
        await recordAnswerRoundUsage(
          currentRound.result.usage,
          run,
          "terminal",
          run.checkpoint.roundIndex
        );
      }
    }

    await tokenBuffer.flush();
    const reset = await deps.repository.resetToolLoopAssistantDraft({
      roundIndex: run.checkpoint.roundIndex,
      runId: run.id,
      userId: run.userId
    });
    if (!reset) {
      throw new ToolLoopRecoveryError(
        "tool_loop_reset_conflict",
        "The recovered assistant draft could not be reset."
      );
    }
    tokenBuffer.resetLocal();

    const previousToolResults = await executePersistedToolBatch(currentCalls, context, signal);
    await appendToolResults(previousToolResults);
    await persistCumulativeUsage();
    const advanced = await deps.repository.advanceToolLoopCallBatch({
      roundIndex: run.checkpoint.roundIndex,
      runId: run.id,
      userId: run.userId
    });
    if (advanced === "cancelled") throw new ToolLoopRecoveryStopped();
    if (advanced !== "advanced") {
      throw new ToolLoopRecoveryError(
        "tool_loop_checkpoint_conflict",
        "The recovered tool batch could not advance."
      );
    }
    currentProviderResponseId = null;

    const outcome = await runProviderToolLoop({
      deferToolUntilBatchEnd: (call) => isSkillToolName(call.name),
      toolObservation(call) {
        const persisted = persistedCalls.get(call.id);
        if (!persisted) return undefined;
        return {
          tool_call_id: persisted.id, execution_index: persisted.ordinal,
          tool_kind: isRecoveredSearchCall(context, call.name) ? "search"
            : isRecoveredKnowledgeCall(context, call.name) ? "knowledge"
            : isRecoveredWorkspaceCall(context, call.name) ? "workspace"
            : isRecoveredMcpDiscoveryCall(context, call.name) || resolveMcpRunTool(context.activeMcpSnapshot, call.name) ? "mcp" : undefined
        };
      },
      adapter: egressAdapter,
      afterToolBatch: async ({ round }) => {
        const next = await deps.repository.advanceToolLoopCallBatch({
          roundIndex: round,
          runId: run.id,
          userId: run.userId
        });
        if (next === "cancelled") throw new ToolLoopRecoveryStopped();
        if (next !== "advanced") {
          throw new ToolLoopRecoveryError(
            "tool_loop_checkpoint_conflict",
            "A recovered tool batch could not advance."
          );
        }
        currentProviderResponseId = null;
      },
      bridge,
      budgets: {
        maxConcurrency: 4,
        maxToolCalls: toolBudgets.maxToolCalls,
        maxToolRounds: toolBudgets.maxToolRounds
      },
      executeTool: async (call, executionContext) => {
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
        try {
          const settled = await executePersistedToolCall(
            persisted,
            context,
            executionContext.signal
          );
          return settled.result;
        } catch (error) {
          if (error instanceof ToolLoopRecoveryStopped) {
            return {
              error: { code: "tool_call_cancelled", fatal: true, message: "Tool call was cancelled." },
              status: "error"
            };
          }
          const failure = error instanceof ToolLoopRecoveryError
            ? error
            : new ToolLoopRecoveryError(
                "tool_call_recovery_failed",
                error instanceof Error ? error.message : "Recovered tool call failed."
              );
          return {
            error: { code: failure.code, fatal: true, message: failure.message },
            status: "error"
          };
        }
      },
      initialRequest: providerRequest,
      onEvent: appendEvent,
      onProviderResult: async ({ result }) => {
        await publishProviderResponseId(result.providerResponseId);
      },
      onSignal: async (signal) => {
        if (signal.type === "text_delta") {
          if (recoveredKnowledgeEnabled) return;
          await tokenBuffer!.push(signal.delta);
          return;
        }
        await tokenBuffer!.flush();
        const didReset = await deps.repository.resetToolLoopAssistantDraft({
          roundIndex: signal.round,
          runId: run.id,
          userId: run.userId
        });
        if (!didReset) {
          throw new ToolLoopRecoveryError(
            "tool_loop_reset_conflict",
            "The recovered assistant draft could not be reset."
          );
        }
        tokenBuffer!.resetLocal();
      },
      onToolBatchSettled: async ({ results }) => {
        await appendToolResults(results);
        await persistCumulativeUsage();
      },
      onUsage: async (usage, request, usageContext) => {
        await recordAnswerRoundUsage(
          usage,
          request,
          usageContext.completeness,
          usageContext.round
        );
      },
      parallelToolCalls: run.normalizedRequest.modelCapabilities.parallelToolCalls === true,
      normalizeToolCallName: workspaceTools.length > 0
        ? normalizeWorkspaceProviderToolName
        : undefined,
      projectToolResultForProvider: projectObservationForProvider,
      persistToolBatch: async ({ calls, continuation: nextContinuation, round }) => {
        await persistToolBatch(calls, nextContinuation, round);
      },
      prepareRequest: async (roundRequest, round) => {
        return prepareRecoveredProviderRequest(roundRequest, round);
      },
      resume: {
        continuation,
        previousToolResults,
        progress: {
          providerRounds: run.checkpoint.roundIndex,
          toolCalls: run.calls.filter((call) => call.roundIndex > 0).length +
            (run.checkpoint.phase === "provider_running" ? currentCalls.length : 0),
          toolRounds: run.checkpoint.roundIndex
        },
        seenCallIds: [...persistedCalls.keys()]
      },
      signal,
      tools
    });

    if (outcome.status === "cancelled") {
      await tokenBuffer.flush();
      return;
    }
    if (outcome.status === "failed") {
      const safetyCode = isProviderStreamSafetyCode(outcome.failure.code)
        ? outcome.failure.code
        : null;
      throw new ToolLoopRecoveryError(
        outcome.failure.code,
        outcome.failure.streamSafetyReport?.message ??
          (safetyCode ? providerStreamSafeMessage(safetyCode) : outcome.failure.message),
        outcome.failure.streamSafetyReport
      );
    }
    await tokenBuffer.flush();
    if (recoveredKnowledgeEnabled) {
      await finalizeRecoveredKnowledgeToolLoop();
      return;
    }
    const groupedAttributions = groupedUsageAttributions(allUsageAttributions());
    const usage = sumTokenUsage(groupedAttributions.map((attribution) => attribution.usage));
    await finalizeRecoveredWorkspace();
    const completion = await finalizeRunCompletion({
      outputEvents: [{
        type: "artifact", data: { artifactType: "context_status", payload: measureSessionContext({
          answerText: outcome.final.finalText, bridge, request: context.sessionRequest ?? providerRequest
        }) }
      }],
      repository: deps.repository,
      result: {
        ...outcome.final,
        providerResponseId: outcome.final.providerResponseId ?? currentProviderResponseId ?? undefined,
        usage,
        usageAttributions: groupedAttributions
      },
      run: {
        assistantMessageId: run.assistantMessageId,
        chatId: run.chatId,
        modelId: run.modelId,
        provider: run.provider,
        runId: run.id,
        userId: run.userId
      }
    });
    if (completion.status === "not_completed") {
      throw new ToolLoopRecoveryError(
        "tool_loop_completion_conflict",
        "The recovered model round could not win terminal completion."
      );
    }
  } catch (error) {
    // A predecessor's live capture lease is retried on a later recovery tick;
    // it is neither provider failure nor permission to retire that owner.
    if (error instanceof WorkspaceHandoffDeferred) {
      logEvent("run_recovery", { subsystem: "run_recovery", stage: "process", outcome: "waiting", action: "wait" });
      return;
    }
    logEvent("run_recovery", { subsystem: "run_recovery", stage: "process",
      outcome: signal.aborted || error instanceof ToolLoopRecoveryStopped ? "cancelled" : "failed",
      code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "stop" });
    if (signal.aborted || error instanceof ToolLoopRecoveryStopped) {
      await compactionPublisher.terminate("unknown").catch(() => undefined);
      await settleRecoveredWorkspaceOnExit("cancelled");
      await tokenBuffer?.flush().catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "progress"));
      if (usageEvidenceTrusted) await persistCancelledUsage?.();
      return;
    }
    await settleRecoveredWorkspaceOnExit("failed");
    const recoveryError = error;
    try {
      await tokenBuffer?.flush();
    } catch (flushError) {
      observeRecoveryWriteFailure(flushError, "progress");
    }
    const streamSafetyReport = providerStreamSafetyReport(recoveryError);
    const safetyCode = streamSafetyReport?.code ??
      (recoveryError instanceof ToolLoopRecoveryError &&
        isProviderStreamSafetyCode(recoveryError.code)
        ? recoveryError.code
        : isRecord(recoveryError) && isProviderStreamSafetyCode(recoveryError.code)
          ? recoveryError.code
          : null);
    const settlement = runSettlementFailure(recoveryError);
    const failure = settlement ? new ToolLoopRecoveryError(settlement.code, settlement.message)
      : recoveryError instanceof ToolLoopRecoveryError
      ? safetyCode && recoveryError.message !== providerStreamSafeMessage(safetyCode)
        ? new ToolLoopRecoveryError(
            safetyCode,
            providerStreamSafeMessage(safetyCode),
            streamSafetyReport ?? undefined
          )
        : recoveryError
      : safetyCode
        ? new ToolLoopRecoveryError(
            safetyCode,
            providerStreamSafeMessage(safetyCode),
            streamSafetyReport ?? undefined
          )
        : isAttachmentMaterializationError(recoveryError)
          ? new ToolLoopRecoveryError(recoveryError.code, recoveryError.message)
          : recoveryError instanceof WorkspaceRuntimeError
            ? new ToolLoopRecoveryError(recoveryError.code, recoveryError.message)
          : new ToolLoopRecoveryError(
              observedFailureCode(recoveryError) !== "unknown" ? observedFailureCode(recoveryError) : "tool_loop_recovery_failed",
              executionFailure(recoveryError).message
            );
    if (streamSafetyReport) {
      warnProviderStreamSafetyOnce(failure, {
        adapterKind: "direct",
        connectionId: "unbound",
        providerFamily: run.provider,
        providerModelId: "unbound"
      });
    }
    await compactionPublisher.terminate(contextCompactionFailureOutcome(failure.code)).catch(() => undefined);
    await settleToolLoopRecoveryError(
      deps,
      run,
      { code: failure.code, message: failure.message },
      usageEvidenceTrusted ? allUsageAttributions() : [],
      [],
      currentProviderResponseId
    );
  }
}

export async function sweepBootOrphanedRunsOnce(
  deps: Pick<RunRecoveryDeps, "registry" | "repository">
): Promise<void> {
  if (processBootSweepState.promise) {
    await processBootSweepState.promise;
    return;
  }

  const promise = deps.repository
    .sweepBootOrphanedRuns({
      createdBefore: processBootSweepState.bootedAt,
      liveRunIds: [...deps.registry.ids()]
    })
    .then((count) => {
      reportSubsystemHealthy("run_recovery", "startup");
      if (count > 0) logEvent("run_recovery", { subsystem: "run_recovery", stage: "startup", outcome: "completed", count });
    })
    .catch((error: unknown) => {
      reportSubsystemFailure({ subsystem: "run_recovery", stage: "startup", prisma_code: databaseFailureCode(error), action: "retry" });
      if (processBootSweepState.promise === promise) {
        processBootSweepState.promise = undefined;
      }
      throw error;
    });

  processBootSweepState.promise = promise;
  await promise;
}

function requiresCheckpointedProviderLoop(request: ProviderRunRequest): boolean {
  if (request.toolChoice === "none") return false;
  if (request.mcpDiscovery !== undefined) return true;
  if (request.toolMode === "none") return false;
  return request.searchPlan.options.some((option) =>
    option.adapterKind === "provider_model_client") ||
    (request.mcp?.tools.length ?? 0) > 0 ||
    request.modelCapabilities.toolCalling === true;
}

async function rebuildReservedAnswerRequest(input: Readonly<{
  control: Readonly<{
    chatId: string;
    modelId: string;
    project?: ProjectRunRecoveryAuthority;
    provider: string;
  }>;
  deps: RunRecoveryDeps;
  dispatch: PreparedKnowledgeProviderDispatch["dispatch"];
  runId: string;
  signal: AbortSignal;
  userId: string;
}>): Promise<Readonly<{
  adapter: ProviderAdapter;
  request: ProviderRunRequest;
}>> {
  if (input.dispatch.attempt.purpose !== "answer" ||
    input.dispatch.attempt.providerBindingKey !== "answer" ||
    input.dispatch.attempt.ordinal !== 1 || input.dispatch.attempt.roundIndex !== 0) {
    throw new ToolLoopRecoveryError(
      "provider_dispatch_checkpoint_missing",
      "The saved provider attempt requires a tool-loop checkpoint."
    );
  }
  const loadRequest = input.deps.repository.loadProviderDispatchRecoveryRequest;
  if (!loadRequest) {
    throw new ToolLoopRecoveryError(
      "provider_dispatch_request_unavailable",
      "The accepted provider request is unavailable for safe recovery."
    );
  }
  const normalizedRequest = await loadRequest({
    runId: input.runId,
    userId: input.userId
  });
  if (!normalizedRequest || normalizedRequest.chatId !== input.control.chatId ||
    normalizedRequest.modelId !== input.control.modelId ||
    normalizedRequest.provider !== input.control.provider) {
    throw new ToolLoopRecoveryError(
      "provider_dispatch_request_invalid",
      "The accepted provider request does not match the saved run."
    );
  }
  if (normalizedRequest.memoryActionTools !== undefined ||
    normalizedRequest.memoryHistoryTool !== undefined) {
    throw new ToolLoopRecoveryError(
      "memory_answer_model_tools_retired",
      "A retired answer-model Memory tool request cannot be rebuilt."
    );
  }
  const runtime = await resolveAnswerRuntime(
    input.deps,
    input.runId,
    input.control.provider
  );
  if (!runtime?.adapter) {
    throw new ToolLoopRecoveryError(
      "provider_not_available",
      "The saved answer provider is unavailable."
    );
  }
  const attachmentLimits = input.deps.getAttachmentLimits?.() ?? getRunAttachmentLimits();
  const attachmentIds = validatePersistedAttachmentReferences(
    normalizedRequest.content.blocks,
    normalizedRequest.attachmentIds,
    attachmentLimits
  );
  const attachments = await loadProviderAttachments(
    input.deps,
    input.userId,
    attachmentIds,
    {
      capabilities: normalizedRequest.modelCapabilities,
      runId: input.runId,
      limits: attachmentLimits,
      ...(input.control.project ? { projectId: input.control.project.projectId } : {}),
      signal: input.signal
    }
  );
  if (attachments.length !== attachmentIds.length) {
    throw new ToolLoopRecoveryError(
      "attachment_not_available",
      "A run attachment is no longer available for provider recovery."
    );
  }
  const requestWithEvidence = withAutomaticKnowledgeEvidence(
    {
      ...normalizedRequest,
      attachments,
      toolChoice: "none",
      tools: undefined
    },
    knowledgeEvidenceMessageFromDispatchDraft(input.dispatch.draft)
  );
  if (requiresCheckpointedProviderLoop(requestWithEvidence)) {
    throw new ToolLoopRecoveryError(
      "provider_dispatch_checkpoint_missing",
      "The saved provider request requires a tool-loop checkpoint."
    );
  }
  // Explicit legacy guard: a reserved Knowledge answer has no summary consumer.
  const budgeted = applyKnowledgeAnswerContextBudget({
    ...(runtime.toolBridge ? { bridge: runtime.toolBridge } : {}),
    request: requestWithEvidence
  });
  if (!budgeted.ok) {
    throw new ToolLoopRecoveryError("context_too_large", budgeted.error.message);
  }
  const retainedEvidence = budgeted.request.context?.messages.find((message) =>
    message.id === KNOWLEDGE_EVIDENCE_MESSAGE_ID && message.purpose === "knowledge_evidence");
  if (!retainedEvidence ||
    textFromContentBlocks(retainedEvidence.content) !== input.dispatch.draft.message) {
    throw new ToolLoopRecoveryError(
      "context_too_large",
      "The exact Knowledge evidence manifest did not survive request reconstruction."
    );
  }
  assertPersonalContextEgressSafe(budgeted.request);
  return { adapter: runtime.adapter, request: budgeted.request };
}

type DirectDispatchRecoveryResult =
  | Readonly<{ kind: "resume_later" }>
  | Readonly<{
      kind: "terminal";
      refreshed: ProviderRunRefreshResult;
    }>;

async function dispatchRecoveredReservedAnswer(input: Readonly<{
  adapter: ProviderAdapter;
  control: Readonly<{
    modelId: string;
    project?: ProjectRunRecoveryAuthority;
    provider: string;
  }>;
  deps: RunRecoveryDeps;
  prepared: PreparedKnowledgeProviderDispatch;
  request: ProviderRunRequest;
  runId: string;
  signal: AbortSignal;
  userId: string;
}>): Promise<DirectDispatchRecoveryResult> {
  const events: ModelRunSseEvent[] = [];
  const egressReceiptRequired = requestHasServerExternalTools(input.request) ||
    requestHasHostedSearchCapability(input.request) ||
    input.request.personalContext !== undefined;
  let receipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
  let providerDispatched = false;
  let attemptSettled = false;
  let durableProviderResponseId: string | null = null;
  let preview: Record<string, unknown> | null = null;
  const requestPreview = () => {
    preview ??= input.adapter.buildRequestPreview(input.request);
    return preview;
  };
  const publishProviderResponseId = async (providerResponseId: string): Promise<void> => {
    if (providerResponseId === durableProviderResponseId) return;
    const publication = await input.deps.repository.updateRunProviderResponseId(
      input.runId,
      providerResponseId
    );
    if (publication === "cancelled") {
      await input.adapter.cancel?.(providerResponseId).catch(() => undefined);
      throw new ToolLoopRecoveryStopped();
    }
    if (publication === "terminal") throw new ToolLoopRecoveryStopped();
    durableProviderResponseId = providerResponseId;
  };

  try {
    const knowledgeAuthorization = await currentFocusedKnowledgeRecoveryAuthorization(input.deps, {
      ...(input.control.project ? { project: input.control.project } : {}),
      runId: input.runId,
      userId: input.userId
    });
    if (!knowledgeAuthorization.authorized) {
      throw new ToolLoopRecoveryError(
        "knowledge_answer_failed",
        "The accepted Knowledge authority is no longer current."
      );
    }
    if (!(await currentDirectAnswerDispatchAllowed(input.deps, input.control, input.userId))) {
      throw new ToolLoopRecoveryError(
        input.control.project ? "provider_admission_changed" : "model_not_available",
        input.control.project
          ? "Project provider authority is no longer current."
          : "The selected model is no longer available."
      );
    }
    if (egressReceiptRequired && !input.deps.memoryEgress &&
      process.env.NODE_ENV === "production") {
      throw new ToolLoopRecoveryError(
        "memory_egress_receipt_unavailable",
        "Memory egress evidence is unavailable."
      );
    }
    if (requestHasHostedSearchCapability(input.request) &&
      !(await currentDirectSearchDispatchAllowed(input.deps, input.request, input.userId))) {
      await input.deps.memoryEgress?.recordBlockedDispatch({
        destinationKind: "answer_provider",
        destinationSnapshot: {
          modelId: input.request.modelId,
          provider: input.request.provider,
          searchOptionIds: input.request.searchPlan.options.map((option) => option.optionId),
          version: 1
        },
        errorCode: "memory_egress_search_revoked",
        mode: "PROVIDER_REQUEST",
        requestEvidence: memoryEgressRequestEvidence(input.request),
        requestPreview: requestPreview(),
        runId: input.runId,
        userId: input.userId
      });
      throw new ToolLoopRecoveryError(
        "search_strategy_not_available",
        "The selected search destination is no longer available."
      );
    }
    receipt = egressReceiptRequired && input.deps.memoryEgress
      ? await input.deps.memoryEgress.beginDispatch({
          destinationKind: "answer_provider",
          destinationSnapshot: {
            modelId: input.request.modelId,
            provider: input.request.provider,
            searchOptionIds: input.request.searchPlan.options.map((option) => option.optionId),
            version: 1
          },
          mode: "PROVIDER_REQUEST",
          requestEvidence: memoryEgressRequestEvidence(input.request),
          requestPreview: requestPreview(),
          runId: input.runId,
          userId: input.userId
        })
      : null;
    await input.deps.knowledgeProviderDispatch!.dispatch(input.prepared);
    providerDispatched = true;
    const stream = input.adapter.stream(input.request, {
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
    });
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      const eventResponseId = providerResponseIdFromEvent(next.value);
      if (eventResponseId) await publishProviderResponseId(eventResponseId);
      next = await stream.next();
    }
    const result = next.value;
    if (result.providerResponseId) await publishProviderResponseId(result.providerResponseId);
    if (receipt && !(await input.deps.memoryEgress!.completeDispatch(receipt.id))) {
      throw new ToolLoopRecoveryError(
        "memory_egress_receipt_conflict",
        "Provider dispatch evidence could not be completed."
      );
    }
    await input.deps.knowledgeProviderDispatch!.settle(input.prepared, {
      providerResponseId: durableProviderResponseId,
      usage: result.usage
    });
    attemptSettled = true;
    return {
      kind: "terminal",
      refreshed: {
        events,
        ...(durableProviderResponseId
          ? { providerResponseId: durableProviderResponseId }
          : {}),
        result: {
          ...result,
          ...(durableProviderResponseId
            ? { providerResponseId: durableProviderResponseId }
            : {})
        },
        status: "complete",
        terminal: true
      }
    };
  } catch (error) {
    if (receipt && !attemptSettled) {
      await input.deps.memoryEgress!.failDispatch(
        receipt.id,
        error instanceof ToolLoopRecoveryError ? error.code : "provider_dispatch_failed"
      ).catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "fail"));
    }
    if (!attemptSettled) {
      if (!providerDispatched) {
        await input.deps.knowledgeProviderDispatch!.release(
          input.prepared,
          "provider_dispatch_not_started"
        ).catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "release"));
      } else if (!durableProviderResponseId) {
        await input.deps.knowledgeProviderDispatch!.markAmbiguous(input.prepared, {
          reason: "provider_dispatch_failed"
        }).catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "settle"));
      }
    }
    if (providerDispatched && durableProviderResponseId && !attemptSettled) {
      return { kind: "resume_later" };
    }
    throw error;
  }
}

type LoadedRecoveryControl = NonNullable<Awaited<ReturnType<typeof loadRecoveryRunControl>>>;

type KnowledgeAnswerGroundingRecoverySeed = Readonly<{
  answerInstructions?: KnowledgeAnswerInstructions;
  workflowVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  repairFeedbackVersion?: 1;
  generationBudget?: import("../providers/modelOutputAllowance").ModelGenerationBudget;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  executionPolicy?: KnowledgeGroundingEffectiveExecutionPolicyV1;
  forbiddenIdentityFragments?: readonly string[];
  modelCapabilities?: ProviderRunRequest["modelCapabilities"];
  reasoningEffort?: string | null;
  request: string;
  routeInstruction: string;
  transport: "native_strict" | "provider_neutral_json";
}>;

async function recoverKnowledgeAnswerGrounding(
  deps: RunRecoveryDeps,
  input: Readonly<{
    control: LoadedRecoveryControl;
    runId: string;
    signal: AbortSignal;
    userId: string;
  }> & (
    | Readonly<{
        draftDispatch: NonNullable<Awaited<ReturnType<KnowledgeProviderDispatchLifecycle["inspect"]>>>;
        seed?: never;
      }>
    | Readonly<{
        draftDispatch?: never;
        seed: KnowledgeAnswerGroundingRecoverySeed;
      }>
  )
): Promise<void> {
  let seed: KnowledgeAnswerGroundingRecoverySeed;
  let contractPair: KnowledgeAnswerContractPair = KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16;
  let pipeline: "v20_v16" | "v21_scope_v6" | "evidence_answer_v1";
  let scopeV6SnapshotVersion: 37 | 38 | 39 | 40 | 41 | 42 | undefined;
  if (input.draftDispatch) {
    if (input.draftDispatch.attempt.purpose === "knowledge_evidence_compose_v1" || input.draftDispatch.attempt.purpose === "knowledge_evidence_compose_v2") {
      const snapshot = decodeKnowledgeEvidenceAnswerSnapshot(input.draftDispatch.attempt.acceptedRequest);
      let request: unknown;
      try { request = snapshot ? JSON.parse(snapshot.userPrompt).request : null; } catch { request = null; }
      if (!snapshot || (snapshot.operation !== "knowledge_evidence_compose_v1" && snapshot.operation !== "knowledge_evidence_compose_v2") || input.draftDispatch.attempt.ordinal !== 1 ||
        input.draftDispatch.attempt.providerBindingKey !== "answer" || typeof request !== "string" || !request.trim()) {
        throw new ToolLoopRecoveryError("knowledge_answer_contract_failed", "The saved Knowledge answer contract is invalid.");
      }
      pipeline = "evidence_answer_v1";
      seed = Object.freeze({ workflowVersion: snapshot.workflowVersion ?? 8,
        ...(snapshot.answerInstructions ? { answerInstructions: snapshot.answerInstructions } : {}), draft: input.draftDispatch.draft,
        repairFeedbackVersion: "repairFeedbackVersion" in snapshot ? snapshot.repairFeedbackVersion : undefined,
        generationBudget: "generationBudget" in snapshot ? snapshot.generationBudget : undefined,
        evidenceBindings: [...input.draftDispatch.items, ...input.draftDispatch.exclusions].flatMap(item => item.evidenceItemId
          ? [{ dispatchEvidenceId: item.dispatchEvidenceId, evidenceItemId: item.evidenceItemId }] : []),
        forbiddenIdentityFragments: input.draftDispatch.draft.items.map(item => item.evidenceId),
        executionPolicy: snapshot.executionPolicy, request, routeInstruction: "", transport: snapshot.transport });
    } else if (input.draftDispatch.attempt.purpose === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21) {
      if (input.draftDispatch.attempt.ordinal !== 1 ||
        input.draftDispatch.attempt.providerBindingKey !== "answer") {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_grounding_unavailable",
          "The saved Knowledge answer operation cannot be recovered."
        );
      }
      const draftRequest = decodeKnowledgeAnswerOperationRequestSnapshotV21(
        input.draftDispatch.attempt.acceptedRequest
      );
      const prompt = draftRequest
        ? decodeKnowledgeAnswerDraftPrimaryPromptV21({
            draft: input.draftDispatch.draft,
            snapshot: draftRequest
          })
        : null;
      if (!draftRequest || !prompt) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The saved Knowledge draft contract snapshot is invalid."
        );
      }
      if (!isRecoverableKnowledgeAnswerOperationSnapshotV21(draftRequest)) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The saved Knowledge draft protocol is retired."
        );
      }
      scopeV6SnapshotVersion = draftRequest.version;
      pipeline = "v21_scope_v6";
      seed = Object.freeze({
        draft: input.draftDispatch.draft,
        evidenceBindings: [
          ...input.draftDispatch.items,
          ...input.draftDispatch.exclusions
        ].flatMap((item) => item.evidenceItemId
          ? [{
              dispatchEvidenceId: item.dispatchEvidenceId,
              evidenceItemId: item.evidenceItemId
            }]
          : []),
        forbiddenIdentityFragments: input.draftDispatch.draft.items.map(
          (item) => item.evidenceId
        ),
        executionPolicy: draftRequest.executionPolicy,
        ...(draftRequest.version === 42 && draftRequest.workflowVersion !== undefined ? { workflowVersion: draftRequest.workflowVersion } : {}),
        request: prompt.request,
        routeInstruction: prompt.routeInstruction,
        transport: draftRequest.transport
      });
    } else {
      const acceptedPair = knowledgeAnswerContractPairForDraftOperation(
        input.draftDispatch.attempt.purpose
      );
      if (!acceptedPair ||
        input.draftDispatch.attempt.ordinal !==
          (acceptedPair.coveragePlannerOperation ? 2 : 1) ||
        input.draftDispatch.attempt.providerBindingKey !== "answer") {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_v5_unavailable",
          "The saved Knowledge answer operation cannot be recovered."
        );
      }
      pipeline = "v20_v16";
      contractPair = acceptedPair;
      const draftRequest = decodeKnowledgeAnswerOperationRequestSnapshotV1(
        input.draftDispatch.attempt.acceptedRequest
      );
      const prompt = draftRequest
        ? decodeKnowledgeAnswerDraftPrompt(draftRequest, input.draftDispatch.draft)
        : null;
      if (!draftRequest || !prompt) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The saved Knowledge draft contract snapshot is invalid."
        );
      }
      seed = Object.freeze({
        draft: input.draftDispatch.draft,
        evidenceBindings: [
          ...input.draftDispatch.items,
          ...input.draftDispatch.exclusions
        ].flatMap((item) => item.evidenceItemId
          ? [{
              dispatchEvidenceId: item.dispatchEvidenceId,
              evidenceItemId: item.evidenceItemId
            }]
          : []),
        forbiddenIdentityFragments: input.draftDispatch.draft.items.map(
          (item) => item.evidenceId
        ),
        reasoningEffort: draftRequest.reasoningEffort,
        request: prompt.request,
        routeInstruction: prompt.routeInstruction,
        transport: draftRequest.transport
      });
    }
  } else {
    seed = input.seed;
    pipeline = seed.workflowVersion === 8 || seed.workflowVersion === 9 || seed.workflowVersion === 10 || seed.workflowVersion === 11 ? "evidence_answer_v1" : selectKnowledgeAnswerPipelineForNewRun({ modelRunId: input.runId });
    if (pipeline === "v21_scope_v6" || pipeline === "evidence_answer_v1") {
      if (!seed.modelCapabilities) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The accepted Knowledge grounding policy cannot be reconstructed."
        );
      }
      seed = Object.freeze({
        ...seed,
        executionPolicy: resolveKnowledgeGroundingExecutionPolicyV1({
          inheritedReasoningEffort: seed.reasoningEffort,
          modelCapabilities: seed.modelCapabilities
        }),
        reasoningEffort: undefined
      });
    }
  }
  const groundingUnavailable = !deps.knowledgeProviderDispatch ||
    (pipeline === "evidence_answer_v1" ? !deps.repository.groundKnowledgeEvidenceAnswer : pipeline === "v21_scope_v6"
      ? !deps.repository.groundKnowledgeAnswerV21
      : !deps.repository.groundKnowledgeAnswerV5);
  if (groundingUnavailable) {
    throw new ToolLoopRecoveryError(
      pipeline === "v20_v16"
        ? "knowledge_answer_v5_unavailable"
        : "knowledge_answer_grounding_unavailable",
      "The saved Knowledge answer operation cannot be recovered."
    );
  }
  const runtime = await resolveAnswerRuntime(deps, input.runId, input.control.provider);
  if (!runtime?.adapter) {
    throw new ToolLoopRecoveryError(
      "provider_not_available",
      "The saved answer provider is unavailable."
    );
  }
  let providerNeutralBase: ProviderRunRequest | null = null;
  const providerNeutralRequest = async (
    operation: ProviderStructuredOutputRequest
  ): Promise<ProviderRunRequest> => {
    if (!providerNeutralBase) {
      const loadRequest = deps.repository.loadProviderDispatchRecoveryRequest;
      const normalized = loadRequest
        ? await loadRequest({ runId: input.runId, userId: input.userId })
        : null;
      if (!normalized || normalized.chatId !== input.control.chatId ||
        normalized.modelId !== input.control.modelId ||
        normalized.provider !== input.control.provider) {
        throw new ToolLoopRecoveryError(
          "provider_dispatch_request_invalid",
          "The accepted provider request does not match the saved run."
        );
      }
      providerNeutralBase = {
        ...normalized,
        attachmentIds: [],
        attachments: [],
        content: textMessageContent(operation.userPrompt),
        context: undefined,
        knowledgeAnswering: undefined,
        knowledgeFocusedRequest: undefined,
        mcp: undefined,
        mcpDiscovery: undefined,
        params: knowledgeGroundingProviderParams({
          baseParams: normalized.params,
          operation
        }),
        personalContext: undefined,
        prompt: { developer: null, system: operation.systemPrompt,
          ...(operation.responseReminder ? { responseReminder: operation.responseReminder } : {}) },
        searchPlan: { mode: "all_selected", options: [] },
        toolChoice: "none",
        toolMode: "none",
        tools: undefined
      };
    }
    return {
      ...providerNeutralBase,
      content: textMessageContent(operation.userPrompt),
      params: knowledgeGroundingProviderParams({
        baseParams: providerNeutralBase.params,
        operation
      }),
      prompt: { developer: null, system: operation.systemPrompt,
          ...(operation.responseReminder ? { responseReminder: operation.responseReminder } : {}) }
    };
  };
  const publishProviderResponseId = async (providerResponseId: string): Promise<void> => {
    const publication = await deps.repository.updateRunProviderResponseId(
      input.runId,
      providerResponseId
    );
    if (publication === "cancelled" || publication === "terminal") {
      throw new ToolLoopRecoveryStopped();
    }
  };
  const authorize = async (): Promise<void> => {
    if (input.signal.aborted) throw new ToolLoopRecoveryStopped();
    const knowledge = await currentFocusedKnowledgeRecoveryAuthorization(deps, {
      ...(input.control.project ? { project: input.control.project } : {}),
      runId: input.runId,
      userId: input.userId
    });
    if (!knowledge.authorized) {
      throw new ToolLoopRecoveryError(
        "knowledge_answer_failed",
        "The accepted Knowledge authority is no longer current."
      );
    }
    if (!(await currentDirectAnswerDispatchAllowed(
      deps,
      input.control,
      input.userId
    ))) {
      throw new ToolLoopRecoveryError(
        input.control.project ? "provider_admission_changed" : "model_not_available",
        "The accepted answer-model authority is no longer current."
      );
    }
  };
  const observedOperationUsage = new Map<number, ModelRunUsage>();
  let activeOperationOrdinal = 0;
  const accountingLifecycle: KnowledgeProviderDispatchLifecycle = {
    ...deps.knowledgeProviderDispatch!,
    async inspect(operation) {
      activeOperationOrdinal = operation.ordinal;
      const dispatch = await deps.knowledgeProviderDispatch!.inspect(operation);
      if (dispatch?.attempt.actualUsage) observedOperationUsage.set(operation.ordinal, dispatch.attempt.actualUsage);
      return dispatch;
    },
    async recover(operation) {
      const recovery = await deps.knowledgeProviderDispatch!.recover(operation);
      if (recovery.kind === "settled" && recovery.dispatch.attempt.actualUsage) {
        observedOperationUsage.set(operation.ordinal, recovery.dispatch.attempt.actualUsage);
      }
      return recovery;
    }
  };
  const executeRequest = async (
    operation: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV8
  ): Promise<KnowledgeAnswerOperationExecutionV8> => {
    const operationTimeoutMs = seed.generationBudget?.timeoutMs ?? 120_000;
    const operationSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(operationTimeoutMs)
    ]);
    if (options.providerResponseId) {
      if (!runtime.adapter.refresh) {
        throw new Error("structured_output_recovery_unavailable");
      }
      const refreshed = await runtime.adapter.refresh(options.providerResponseId);
      if (!refreshed.terminal) throw new KnowledgeAnswerOperationDeferredError();
      const usage = reportedUsage(refreshed);
      if (usage) options.onUsage?.(usage);
      if (!refreshed.result || (refreshed.result.toolCalls?.length ?? 0) > 0) {
        throw new Error("structured_output_recovery_invalid");
      }
      const providerResponseId = refreshed.result.providerResponseId ??
        refreshed.providerResponseId ?? options.providerResponseId;
      await publishProviderResponseId(providerResponseId);
      return Object.freeze({
        output: parseProviderStructuredOutputObject(refreshed.result.finalText),
        providerResponseId,
        usage: normalizeTokenUsage(refreshed.result.usage)
      });
    }
    if (seed.transport === "native_strict") {
      if (!runtime.structuredOutputAdapter) {
        throw new Error("structured_output_not_supported");
      }
      let providerResponseId: string | null = null;
      let operationUsage: ModelRunUsage = normalizeTokenUsage({});
      const output = await runtime.structuredOutputAdapter.execute(operation, {
        onProviderResponseId(value) {
          providerResponseId = value;
        },
        onUsage(value) {
          operationUsage = mergeTokenUsage(operationUsage, value);
          options.onUsage?.(operationUsage);
        },
        signal: operationSignal,
        timeoutMs: operationTimeoutMs
      });
      if (providerResponseId) await publishProviderResponseId(providerResponseId);
      return Object.freeze({
        output,
        providerResponseId,
        usage: normalizeTokenUsage(operationUsage)
      });
    }
    const request = await providerNeutralRequest(operation);
    const stream = runtime.adapter.stream(request, { signal: operationSignal });
    let providerResponseId: string | null = null;
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "usage") options.onUsage?.(next.value.data);
      const eventResponseId = providerResponseIdFromEvent(next.value);
      if (eventResponseId) providerResponseId = eventResponseId;
      next = await stream.next();
    }
    options.onUsage?.(next.value.usage);
    if ((next.value.toolCalls?.length ?? 0) > 0) {
      throw new Error("structured_output_tools_forbidden");
    }
    providerResponseId = next.value.providerResponseId ?? providerResponseId;
    if (providerResponseId) await publishProviderResponseId(providerResponseId);
    return Object.freeze({
      output: parseProviderStructuredOutputObject(next.value.finalText),
      providerResponseId,
      usage: normalizeTokenUsage(next.value.usage)
    });
  };
  const execute: typeof executeRequest = async (operation, options) => {
    const ordinal = activeOperationOrdinal;
    let usage: ModelRunUsage = normalizeTokenUsage(observedOperationUsage.get(ordinal) ?? {});
    try {
      const result = await executeRequest(operation, { ...options, onUsage(value) {
        usage = mergeTokenUsage(usage, value);
        options.onUsage?.(usage);
      } });
      usage = mergeTokenUsage(usage, result.usage);
      observedOperationUsage.set(ordinal, usage);
      return { ...result, usage };
    } catch (error) {
      if (!(error instanceof KnowledgeAnswerOperationDeferredError)) {
        observedOperationUsage.set(ordinal, normalizeTokenUsage({ ...usage, completeness: "partial" }));
      }
      throw error;
    }
  };
  const workflowVersion = seed.workflowVersion;
  const groundingInput = {
    authorize,
    ...(seed.answerInstructions ? { answerInstructions: seed.answerInstructions } : {}),
    draft: seed.draft,
    ...(seed.evidenceBindings?.length
      ? { evidenceBindings: seed.evidenceBindings }
      : {}),
    execute,
    forbiddenIdentityFragments: [
      input.runId,
      ...(seed.forbiddenIdentityFragments ?? seed.draft.items.map((item) => item.evidenceId))
    ],
    lifecycle: accountingLifecycle,
    modelRunId: input.runId,
    ...(workflowVersion === 2 || workflowVersion === 3 || workflowVersion === 4 ||
      workflowVersion === 5 || workflowVersion === 6 || workflowVersion === 7
      ? { workflowVersion } : {}),
    ...(seed.executionPolicy
      ? { executionPolicy: seed.executionPolicy }
      : { reasoningEffort: seed.reasoningEffort }),
    request: seed.request,
    routeInstruction: seed.routeInstruction,
    shouldAbort: () => input.signal.aborted,
    transport: seed.transport
  } as const;
  const operationResult = await (async () => {
    try {
      return seed.workflowVersion === 9 || seed.workflowVersion === 10 || seed.workflowVersion === 11
    ? await executeKnowledgeEvidenceAnswerWithRefinementV1({ ...groundingInput, executionPolicy: seed.executionPolicy!,
        repairFeedbackVersion: seed.repairFeedbackVersion,
        generationBudget: seed.generationBudget,
        workflowVersion: seed.workflowVersion === 10 || seed.workflowVersion === 11 ? seed.workflowVersion : undefined,
        async refineEvidence(result, previousEvidence) {
          // Accepted child operations pin their exact manifest. Never rebuild
          // or redispatch their preceding search during recovery.
          const child = await deps.knowledgeProviderDispatch!.inspect({ modelRunId: input.runId,
            ordinal: result.operations.length + 1 });
          if (child) return child.draft;
          const normalized = await deps.repository.loadProviderDispatchRecoveryRequest?.({ runId: input.runId, userId: input.userId });
          if (!normalized) throw Error("provider_dispatch_request_invalid");
          return refineKnowledgeEvidence({ authorize, executor: deps.knowledgeExecutor, memoryEgress: deps.memoryEgress,
            previousEvidence,
            repository: deps.repository, request: { ...normalized, attachments: [] }, result,
            runId: input.runId, userId: input.userId, signal: input.signal
          });
        } })
    : pipeline === "evidence_answer_v1"
    ? await executeKnowledgeEvidenceAnswerV1({ ...groundingInput, executionPolicy: seed.executionPolicy! })
    : pipeline === "v21_scope_v6"
    ? await executeKnowledgeAnswerGroundingV21({
        ...groundingInput,
        ...(scopeV6SnapshotVersion ? { snapshotVersion: scopeV6SnapshotVersion } : {}),
        recoveryProviderResponseIds: input.control.providerResponseId
          ? {
              1: input.control.providerResponseId,
              2: input.control.providerResponseId,
              3: input.control.providerResponseId,
              4: input.control.providerResponseId,
              5: input.control.providerResponseId,
              6: input.control.providerResponseId,
              7: input.control.providerResponseId,
              8: input.control.providerResponseId
            }
          : undefined
      })
    : await executeKnowledgeAnswerGroundingV8({
        ...groundingInput,
        contractPair,
        recoveryProviderResponseIds: input.control.providerResponseId
          ? {
              ...(contractPair.coveragePlannerOperation
                ? { [contractPair.coveragePlannerOperation]: input.control.providerResponseId }
                : {}),
              [contractPair.draftOperation]: input.control.providerResponseId,
              [contractPair.selectorOperation]: input.control.providerResponseId,
              ...(contractPair.supplementalDraftOperation
                ? {
                    [contractPair.supplementalDraftOperation]:
                      input.control.providerResponseId
                  }
                : {}),
              ...(contractPair.finalSelectorOperation
                ? { [contractPair.finalSelectorOperation]: input.control.providerResponseId }
                : {})
            }
          : undefined
      });
    } catch (error) {
      // Busy/deferred work remains recoverable. Terminal failure or Stop keeps
      // every reused/observed operation without replaying the provider.
      if (observedOperationUsage.size && !(error instanceof KnowledgeAnswerOperationDeferredError) &&
        !(error instanceof Error && error.message === "knowledge_answer_operation_busy")) {
        const persisted = await deps.repository.loadRunUsageAttributions({ runId: input.runId, userId: input.userId });
        const attributions = await usageAttributionsWithEstimatedCost(deps.repository, groupedUsageAttributions([
          ...persisted,
          ...[...observedOperationUsage.values()].map((usage) => ({
            operationCount: 1, modelId: input.control.modelId, provider: input.control.provider, usage
          }))
        ]));
        await deps.repository.recordRunUsageEvents({ chatId: input.control.chatId, runId: input.runId,
          userId: input.userId, usageAttributions: attributions })
          .catch((writeError: unknown) => observeRecoveryWriteFailure(writeError, "settle"));
      }
      throw error;
    }
  })();
  const latest = await loadRecoveryRunControl(
    deps,
    input.runId,
    input.userId
  );
  if (!latest || !isRefreshableRun(latest) || !latest.assistantMessageId) return;
  if (!(await projectRecoveryAuthorityAllowsProceed(
    deps,
    latest,
    input.runId,
    input.userId
  ))) return;
  const persistedUsage = await deps.repository.loadRunUsageAttributions({
    runId: input.runId,
    userId: input.userId
  });
  const refinementRun = seed.workflowVersion === 9 || seed.workflowVersion === 10 || seed.workflowVersion === 11
    ? await deps.repository.loadCheckpointedToolLoopRun({ runId: input.runId, userId: input.userId }) : null;
  const usageAttributions = groupedUsageAttributions([
    ...knowledgeRefinementUsageAfter(refinementRun?.calls ?? [], persistedUsage.map(item => item.recordedAt)),
    ...persistedUsage.map(({ recordedAt: _recordedAt, ...attribution }) => attribution),
    ...operationResult.operations.map((operation) => ({
      modelId: latest.modelId,
      provider: latest.provider,
      usage: operation.usage
    }))
  ]);
  await finalizeRunCompletion({
    knowledgeAnswerContracts: operationResult.contracts,
    repository: deps.repository,
    result: {
      finalText: "",
      ...(operationResult.operations.at(-1)?.providerResponseId
        ? { providerResponseId: operationResult.operations.at(-1)!.providerResponseId! }
        : {}),
      usage: sumTokenUsage(usageAttributions.map((entry) => entry.usage)),
      usageAttributions
    },
    run: {
      assistantMessageId: latest.assistantMessageId,
      chatId: latest.chatId,
      modelId: latest.modelId,
      provider: latest.provider,
      runId: input.runId,
      userId: input.userId
    }
  });
}

async function refreshProviderRunOnceRegistered(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  const control = await loadRecoveryRunControl(deps, runId, userId);
  if (!control || !isRefreshableRun(control)) {
    return;
  }
  if (!(await projectRecoveryAuthorityAllowsProceed(deps, control, runId, userId))) return;

  const publishedAnswer = await deps.repository.loadPublishedRunAnswer?.({ runId, userId });
  if (publishedAnswer) {
    const request = await deps.repository.loadProviderDispatchRecoveryRequest?.({ runId, userId });
    if (!request?.workspace || !deps.workspace) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    let handoff;
    try {
      handoff = await deps.workspace.handoff({ runId, userId, signal, workspace: request.workspace,
        onActivity: async (entry) => {
          const event = projectRunOutputArtifactEvent(workspaceActivityEvent(entry));
          if (event) await deps.repository.appendRunOutputEvent(runId, event);
        }
      });
    } catch (error) {
      signal.throwIfAborted();
      // The answer and its usage are already durable. A failed capture must
      // terminate this turn without replaying the provider or losing that text.
      await failRecoveredRun(deps.repository, runId, publishedAnswer.assistantMessageId, {
        code: error instanceof WorkspaceRuntimeError ? error.code : "workspace_output_export_failed",
        message: "The answer was saved, but Workspace could not finish preparing its files."
      }, { recoveryTerminal: true });
      await deps.workspace.settle({ outcome: "failed", runId, userId, onActivity: recoveredWorkspaceActivity(deps, runId) });
      return;
    }
    if (handoff.status !== "ready") return;
    signal.throwIfAborted();
    await deps.repository.completeRun(publishedAnswer);
    return;
  }

  if (await recoverAgentIfNeeded(deps, runId, userId)) return;

  // Recovery has no live generation fence. Close admission atomically before
  // replaying any old checkpoint; a clarified task cannot reuse an answer or
  // Knowledge review from the lost executor's earlier question.
  const clarifications = await deps.repository.followups?.load({ runId, userId });
  if (clarifications && (clarifications.revision > 0 ||
    !(await deps.repository.followups!.close({ runId, userId, revision: 0 })))) {
    if (control.providerResponseId) {
      const runtime = await resolveAnswerRuntime(deps, runId, control.provider).catch(() => null);
      await runtime?.adapter.cancel?.(control.providerResponseId).catch(() => undefined);
    }
    if (control.assistantMessageId) await failRecoveredRun(deps.repository, runId, control.assistantMessageId, {
      code: "followup_executor_lost",
      message: "This task was interrupted before it could finish with your follow-ups. Your question and clarifications are saved; regenerate to try again."
    }, { recoveryTerminal: true });
    return;
  }

  if (deps.knowledgeProviderDispatch) {
    let draftDispatch: Awaited<ReturnType<KnowledgeProviderDispatchLifecycle["inspect"]>> = null;
    try {
      draftDispatch = await deps.knowledgeProviderDispatch.inspect({
        modelRunId: runId,
        ordinal: 1
      });
      if (draftDispatch?.attempt.purpose === KNOWLEDGE_COVERAGE_PLANNER_OPERATION) {
        draftDispatch = await deps.knowledgeProviderDispatch.inspect({
          modelRunId: runId,
          ordinal: 2
        });
      }
      if (draftDispatch && (
        draftDispatch.attempt.purpose === "knowledge_evidence_compose_v1" || draftDispatch.attempt.purpose === "knowledge_evidence_compose_v2" ||
        draftDispatch.attempt.purpose === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21 ||
        knowledgeAnswerContractPairForDraftOperation(draftDispatch.attempt.purpose)
      )) {
        await recoverKnowledgeAnswerGrounding(deps, {
          control,
          draftDispatch,
          runId,
          signal,
          userId
        });
        return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof ToolLoopRecoveryStopped ||
        error instanceof KnowledgeAnswerOperationDeferredError ||
        error instanceof Error && error.message === "knowledge_answer_operation_busy") {
        return;
      }
      const latest = await loadRecoveryRunControl(deps, runId, userId);
      if (!latest || !isRefreshableRun(latest) || !latest.assistantMessageId) return;
      await failRecoveredRun(deps.repository,
        runId,
        latest.assistantMessageId,
        focusedAnswerFailure(error),
        { recoveryTerminal: true }
      );
      return;
    }
  }

  const acceptedRequest = deps.repository.loadProviderDispatchRecoveryRequest
    ? await deps.repository.loadProviderDispatchRecoveryRequest({ runId, userId })
    : null;
  if (acceptedRequest?.memoryActionTools !== undefined ||
    acceptedRequest?.memoryHistoryTool !== undefined) {
    if (control.assistantMessageId) {
      await failRecoveredRun(deps.repository,
        runId,
        control.assistantMessageId,
        {
          code: "memory_answer_model_tools_retired",
          message: "This saved run uses a retired answer-model Memory tool contract."
        },
        { recoveryTerminal: true }
      );
    }
    return;
  }
  const focusedRequest = acceptedRequest?.knowledgeFocusedRequest
    ? decodeKnowledgeFocusedRequest(acceptedRequest.knowledgeFocusedRequest)
    : null;
  if (acceptedRequest?.knowledgeFocusedRequest !== undefined && !focusedRequest) {
    if (control.assistantMessageId) {
      await failRecoveredRun(deps.repository,
        runId,
        control.assistantMessageId,
        focusedKnowledgeFailure("knowledge_retrieval_failed"),
        { recoveryTerminal: true }
      );
    }
    return;
  }
  const fullContextRequest = acceptedRequest?.knowledgeAnswering?.route ===
    KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT
    ? acceptedRequest.knowledgeAnswering
    : null;
  if (fullContextRequest) {
    try {
      if (!acceptedRequest || !deps.knowledgeProviderDispatch ||
        !deps.repository.loadKnowledgeFullContextDispatchRecovery) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_v5_unavailable",
          "Full-context Knowledge recovery is unavailable."
        );
      }
      const existingAttempt = await deps.knowledgeProviderDispatch.inspect({
        modelRunId: runId,
        ordinal: 1
      });
      if (existingAttempt) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The saved Knowledge operation is not a recoverable versioned Draft attempt."
        );
      }
      const contextWindow = acceptedRequest.modelCapabilities.contextWindow;
      const maximumTokens = Number.isSafeInteger(contextWindow) && Number(contextWindow) > 0
        ? Math.floor(
            Number(contextWindow) *
            fullContextRequest.answerPolicy.fullContextThresholdBasisPoints / 10_000
          )
        : 0;
      if (maximumTokens < 1) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The saved full-context provider budget is invalid."
        );
      }
      const recovered = await deps.repository.loadKnowledgeFullContextDispatchRecovery({
        ...(acceptedRequest.knowledgeEvidencePackingVersion !== undefined
          ? { knowledgeEvidencePackingVersion: acceptedRequest.knowledgeEvidencePackingVersion } : {}),
        maximumTokens,
        modelId: acceptedRequest.modelId,
        provider: acceptedRequest.provider,
        runId,
        userId
      });
      if (!recovered || recovered.draft.items.length !== fullContextRequest.evidenceCount) {
        throw new ToolLoopRecoveryError(
          "knowledge_evidence_receipt_invalid",
          "The accepted full-context Knowledge evidence cannot be recovered."
        );
      }
      const runtime = await resolveAnswerRuntime(deps, runId, control.provider);
      if (!runtime?.adapter) {
        throw new ToolLoopRecoveryError(
          "provider_not_available",
          "The saved answer provider is unavailable."
        );
      }
      const requestText = textFromContentBlocks(acceptedRequest.content).trim();
      if (!requestText) {
        throw new ToolLoopRecoveryError(
          "knowledge_answer_contract_failed",
          "The accepted Knowledge request is empty."
        );
      }
      await recoverKnowledgeAnswerGrounding(deps, {
        control,
        runId,
        seed: {
          draft: recovered.draft,
          ...(acceptedRequest.knowledgeAnswerWorkflowVersion !== undefined ? { workflowVersion: acceptedRequest.knowledgeAnswerWorkflowVersion } : {}),
          repairFeedbackVersion: acceptedRequest.knowledgeReviewRepairFeedbackVersion,
          generationBudget: acceptedRequest.knowledgeGenerationBudget,
          ...(acceptedRequest.prompt.responseReminder !== undefined ? { answerInstructions: knowledgeAnswerInstructions(acceptedRequest.prompt) } : {}),
          evidenceBindings: recovered.evidenceBindings,
          modelCapabilities: acceptedRequest.modelCapabilities,
          reasoningEffort: knowledgeGroundingInheritedReasoningEffortV1({
            acceptedReasoningEffort: acceptedRequest.reasoningEffort,
            params: acceptedRequest.params
          }),
          request: requestText,
          routeInstruction: KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION,
          transport: runtime.structuredOutputAdapter
            ? "native_strict"
            : "provider_neutral_json"
        },
        signal,
        userId
      });
    } catch (error) {
      if (signal.aborted || error instanceof ToolLoopRecoveryStopped ||
        error instanceof KnowledgeAnswerOperationDeferredError ||
        error instanceof Error && error.message === "knowledge_answer_operation_busy") return;
      const latest = await loadRecoveryRunControl(deps, runId, userId);
      if (!latest || !isRefreshableRun(latest) || !latest.assistantMessageId) return;
      await failRecoveredRun(deps.repository,
        runId,
        latest.assistantMessageId,
        focusedAnswerFailure(error),
        { recoveryTerminal: true }
      );
    }
    return;
  }
  if (!focusedRequest) {
    const checkpointed = await deps.repository.loadCheckpointedToolLoopRun({ runId, userId });
    if (checkpointed) {
      await recoverCheckpointedToolLoop(deps, checkpointed, signal);
      return;
    }
  }
  if (focusedRequest && (!acceptedRequest || !deps.knowledgeProviderDispatch)) {
    if (control.assistantMessageId) {
      await failRecoveredRun(deps.repository,
        runId,
        control.assistantMessageId,
        focusedKnowledgeFailure("knowledge_retrieval_failed"),
        { recoveryTerminal: true }
      );
    }
    return;
  }
  if (focusedRequest && acceptedRequest && deps.knowledgeProviderDispatch) {
    let existingAttempt: Awaited<ReturnType<KnowledgeProviderDispatchLifecycle["inspect"]>>;
    try {
      existingAttempt = await deps.knowledgeProviderDispatch.inspect({
        modelRunId: runId,
        ordinal: 1
      });
    } catch (error) {
      if (control.assistantMessageId) {
        await failRecoveredRun(deps.repository,
          runId,
          control.assistantMessageId,
          focusedRetrievalFailure(error),
          { recoveryTerminal: true }
        );
      }
      return;
    }
    if (!existingAttempt) {
      let answerRecoveryStarted = false;
      try {
        const loadCall = deps.repository.loadFocusedKnowledgeCall;
        const loadExclusions = deps.repository.loadFocusedKnowledgeScopeExclusions;
        const claimCall = deps.repository.claimAutomaticKnowledgeCall;
        if (!loadCall || !loadExclusions || !claimCall || !deps.knowledgeExecutor) {
          throw new ToolLoopRecoveryError(
            "knowledge_retrieval_failed",
            "Focused Knowledge recovery is unavailable."
          );
        }
        const authorization = await currentFocusedKnowledgeRecoveryAuthorization(deps, {
          ...(control.project ? { project: control.project } : {}),
          runId,
          userId
        });
        if (!authorization.authorized) {
          throw new ToolLoopRecoveryError(
            "knowledge_retrieval_failed",
            "The accepted Knowledge authority is no longer current."
          );
        }
        const persistedExclusions = authorization.scope?.exclusions ??
          await loadExclusions({ runId, userId });
        if (!persistedExclusions) {
          throw new ToolLoopRecoveryError(
            "knowledge_retrieval_failed",
            "The persisted focused Knowledge scope is unavailable."
          );
        }
        const persisted = await loadCall({ runId, userId });
        if (!persisted || persisted.providerCallId !== FOCUSED_KNOWLEDGE_PROVIDER_CALL_ID ||
          persisted.toolName !== KNOWLEDGE_FOCUSED_OPERATION_NAME ||
          !focusedKnowledgeCallArgumentsMatch(focusedRequest, persisted.arguments)) {
          throw new ToolLoopRecoveryError(
            "knowledge_focused_checkpoint_conflict",
            "The focused Knowledge checkpoint does not match the accepted request."
          );
        }
        const attachmentLimits = deps.getAttachmentLimits?.() ?? getRunAttachmentLimits();
        const attachmentIds = validatePersistedAttachmentReferences(
          acceptedRequest.content.blocks,
          acceptedRequest.attachmentIds,
          attachmentLimits
        );
        const attachments = await loadProviderAttachments(deps, userId, attachmentIds, {
          capabilities: acceptedRequest.modelCapabilities,
          runId,
          limits: attachmentLimits,
          ...(control.project ? { projectId: control.project.projectId } : {}),
          signal
        });
        if (attachments.length !== attachmentIds.length) {
          throw new ToolLoopRecoveryError(
            "attachment_not_available",
            "A run attachment is no longer available."
          );
        }
        const providerRequest: ProviderRunRequest = {
          ...acceptedRequest,
          attachments,
          toolChoice: "none",
          tools: undefined
        };
        const call = modelToolCall(persisted);
        const executionContext = {
          persistedToolCallId: persisted.id,
          request: providerRequest,
          runId,
          userId
        };
        const settleFocusedResult = async (result: ToolExecutionResult): Promise<void> => {
          const stored = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
          if (!stored) {
            throw new ToolLoopRecoveryError(
              "knowledge_retrieval_failed",
              "Recovered focused Knowledge evidence is too large."
            );
          }
          const settled = await deps.repository.settleToolLoopCall({
            callId: persisted.id,
            result: stored,
            runId,
            state: result.status,
            userId
          });
          if (settled !== "settled" && settled !== "reused") {
            throw new ToolLoopRecoveryError(
              "knowledge_focused_checkpoint_conflict",
              "Recovered focused Knowledge evidence could not be settled."
            );
          }
        };
        let result: ToolExecutionResult;
        let usageAccounted = persisted.usageAccountedAt != null;
        if (persisted.state === "running") {
          if (signal.aborted) throw new ToolLoopRecoveryStopped();
          let replay: Awaited<ReturnType<NonNullable<KnowledgeToolExecutor["preflight"]>>> | null =
            null;
          try {
            replay = await deps.knowledgeExecutor.preflight?.(call, executionContext) ?? null;
          } catch {
            // A running focused call may already have completed retrieval. A
            // receipt read failure cannot authorize a second dispatch.
          }
          if (signal.aborted) throw new ToolLoopRecoveryStopped();
          if (!replay || replay.kind !== "replayed") {
            throw new ToolLoopRecoveryError(
              "knowledge_retrieval_outcome_unknown",
              "Focused Knowledge retrieval may have completed and was not repeated."
            );
          }
          result = replay.result;
          await settleFocusedResult(result);
        } else {
          const claim = await claimCall({ callId: persisted.id, runId, userId });
          if (claim.kind === "ambiguous") {
            throw new ToolLoopRecoveryError(
              "knowledge_retrieval_outcome_unknown",
              "Focused Knowledge retrieval may have completed and was not repeated."
            );
          }
          if (claim.kind === "not_found" || claim.kind === "cancelled") {
            throw new ToolLoopRecoveryError(
              "knowledge_focused_checkpoint_conflict",
              "The focused Knowledge checkpoint is unavailable."
            );
          }
          usageAccounted = claim.call.usageAccountedAt != null;
          if (claim.kind === "settled") {
            const stored = parsePersistedToolExecutionResult(call, claim.call.result);
            if (!stored) {
              throw new ToolLoopRecoveryError(
                "knowledge_retrieval_failed",
                "Persisted focused Knowledge evidence is invalid."
              );
            }
            result = stored;
          } else {
            const preflight = await runWithContext({ tool_call_id: persisted.id, execution_index: persisted.ordinal },
              () => deps.knowledgeExecutor!.preflight?.(call, executionContext));
            result = preflight && preflight.kind !== "admitted"
              ? preflight.result
              : await runWithContext({ tool_call_id: persisted.id, execution_index: persisted.ordinal },
                  () => withKnowledgeToolDeadline([signal], (knowledgeSignal) =>
                    deps.knowledgeExecutor!.execute(call, executionContext, { signal: knowledgeSignal })))
                .catch((error) => toolExecutionErrorResult(call, error, "Knowledge"));
            await settleFocusedResult(result);
          }
        }
        if (knowledgeEvidenceFromToolResult(result) && deps.memoryEgress &&
          !(await deps.memoryEgress.settleRecoveredToolDispatch({
            modelRunToolCallId: persisted.id,
            outcome: "COMPLETED",
            runId,
            userId
          }))) {
          throw new ToolLoopRecoveryError(
            "memory_egress_receipt_conflict",
            "The recovered focused Knowledge egress receipt could not be settled."
          );
        }
        if (!usageAccounted) {
          const persistedUsage = await deps.repository.loadRunUsageAttributions({ runId, userId });
          const retrievalAttributions = knowledgeUsageAttributionsFromToolResult(result);
          const cumulativeAttributions = groupedUsageAttributions([
            ...persistedUsage.map(({ recordedAt: _recordedAt, ...attribution }) => attribution),
            ...retrievalAttributions
          ]);
          const recorded = await deps.repository.recordRunUsageEvents({
            chatId: control.chatId,
            runId,
            usageAccountedToolCallIds: [persisted.id],
            usageAttributions: await usageAttributionsWithEstimatedCost(
              deps.repository,
              cumulativeAttributions
            ),
            userId
          });
          if (!recorded) {
            throw new ToolLoopRecoveryError(
              "tool_loop_usage_checkpoint_conflict",
              "Focused Knowledge usage could not be checkpointed."
            );
          }
        }
        const evidence = knowledgeEvidenceFromToolResult(result);
        if (result.status !== "complete" || !evidence) {
          const code = knowledgeSearchFailureFromToolResult(result) ?? "knowledge_retrieval_failed";
          throw new ToolLoopRecoveryError(
            code,
            knowledgeSearchFailureMessage(code)
          );
        }
        if (evidence.results.length < 1) {
          throw new ToolLoopRecoveryError(
            "no_retrieval_candidates",
            "No Knowledge retrieval candidates were found."
          );
        }
        const draft = focusedKnowledgeEvidenceDispatchDraft({
          exclusions: persistedExclusions,
          request: providerRequest,
          result
        });
        const runtime = await resolveAnswerRuntime(deps, runId, control.provider);
        if (!runtime?.adapter) {
          throw new ToolLoopRecoveryError(
            "provider_not_available",
            "The saved answer provider is unavailable."
          );
        }
        const evidenceMessage = knowledgeEvidenceMessageFromDispatchDraft(draft);
        // Explicit legacy guard: this Knowledge answer route has no summary consumer.
        const budgeted = applyKnowledgeAnswerContextBudget({
          ...(runtime.toolBridge ? { bridge: runtime.toolBridge } : {}),
          request: withAutomaticKnowledgeEvidence(providerRequest, evidenceMessage)
        });
        const retainedEvidence = budgeted.ok
          ? budgeted.request.context?.messages.find((message) =>
              message.id === evidenceMessage.id && message.purpose === "knowledge_evidence")
          : null;
        if (!budgeted.ok || !retainedEvidence ||
          textFromContentBlocks(retainedEvidence.content) !==
            textFromContentBlocks(evidenceMessage.content)) {
          throw new ToolLoopRecoveryError(
            "context_too_large",
            "The exact Knowledge evidence manifest does not fit the answer context."
          );
        }
        const requestText = textFromContentBlocks(acceptedRequest.content).trim();
        if (!requestText) {
          throw new ToolLoopRecoveryError(
            "knowledge_answer_contract_failed",
            "The accepted Knowledge request is empty."
          );
        }
        answerRecoveryStarted = true;
        await recoverKnowledgeAnswerGrounding(deps, {
          control,
          runId,
          seed: {
            draft,
            ...(acceptedRequest.knowledgeAnswerWorkflowVersion !== undefined ? { workflowVersion: acceptedRequest.knowledgeAnswerWorkflowVersion } : {}),
            repairFeedbackVersion: acceptedRequest.knowledgeReviewRepairFeedbackVersion,
            generationBudget: acceptedRequest.knowledgeGenerationBudget,
            ...(acceptedRequest.prompt.responseReminder !== undefined ? { answerInstructions: knowledgeAnswerInstructions(acceptedRequest.prompt) } : {}),
            forbiddenIdentityFragments: authorization.scope?.sources.flatMap((source) => [
              source.sourceId,
              source.sourceVersionId,
              source.sourceArtifactId
            ]),
            modelCapabilities: acceptedRequest.modelCapabilities,
            reasoningEffort: knowledgeGroundingInheritedReasoningEffortV1({
              acceptedReasoningEffort: acceptedRequest.reasoningEffort,
              params: acceptedRequest.params
            }),
            request: requestText,
            routeInstruction: KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
            transport: runtime.structuredOutputAdapter
              ? "native_strict"
              : "provider_neutral_json"
          },
          signal,
          userId
        });
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (control.assistantMessageId) {
          await failRecoveredRun(deps.repository,
            runId,
            control.assistantMessageId,
            answerRecoveryStarted
              ? focusedAnswerFailure(error)
              : focusedRetrievalFailure(error),
            { recoveryTerminal: true }
          );
        }
        return;
      }
    }
  }

  let providerResponseId = control.providerResponseId;
  let recoveredKnowledgeAttempt: PreparedKnowledgeProviderDispatch | null = null;
  let directAdapter: ProviderAdapter | null = null;
  let directlyRefreshed: ProviderRunRefreshResult | null = null;
  let storedKnowledgeAttemptFound = false;
  if (deps.knowledgeProviderDispatch) {
    let storedAttempt: Awaited<ReturnType<KnowledgeProviderDispatchLifecycle["inspect"]>>;
    try {
      storedAttempt = await deps.knowledgeProviderDispatch.inspect({
        modelRunId: runId,
        ordinal: 1
      });
    } catch (error) {
      if (!focusedRequest) throw error;
      if (control.assistantMessageId) {
        await failRecoveredRun(deps.repository,
          runId,
          control.assistantMessageId,
          focusedAnswerFailure(error),
          { recoveryTerminal: true }
        );
      }
      return;
    }
    if (storedAttempt) {
      storedKnowledgeAttemptFound = true;
      try {
        let rebuilt: Awaited<ReturnType<typeof rebuildReservedAnswerRequest>> | null = null;
        let recovery = await deps.knowledgeProviderDispatch.recover({
          modelRunId: runId,
          ordinal: 1,
          providerResponseId
        });
        if (recovery.kind === "request_required") {
          rebuilt = await rebuildReservedAnswerRequest({
            control,
            deps,
            dispatch: recovery.dispatch,
            runId,
            signal,
            userId
          });
          recovery = await deps.knowledgeProviderDispatch.recover({
            modelRunId: runId,
            ordinal: 1,
            providerResponseId,
            requestPreview: rebuilt.adapter.buildRequestPreview(rebuilt.request)
          });
        }
        if (recovery.kind === "busy") return;
        if (recovery.kind === "request_required" || recovery.kind === "not_found") {
          throw new ToolLoopRecoveryError(
            "provider_dispatch_request_unavailable",
            "The saved provider request could not be claimed safely."
          );
        }
        if (recovery.kind === "ambiguous" || recovery.kind === "released") {
          if (control.assistantMessageId) {
            await failRecoveredRun(deps.repository,
              runId,
              control.assistantMessageId,
              focusedRequest
                ? focusedKnowledgeFailure("knowledge_answer_failed")
                : {
                    code: "provider_round_outcome_unknown",
                    message: "The saved provider round could not be resumed safely. Retry the run."
                  },
              { recoveryTerminal: true }
            );
          }
          return;
        }
        if (recovery.kind === "dispatch") {
          if (!rebuilt) {
            throw new ToolLoopRecoveryError(
              "provider_dispatch_request_unavailable",
              "The saved provider request was not reconstructed before dispatch."
            );
          }
          const dispatched = await dispatchRecoveredReservedAnswer({
            adapter: rebuilt.adapter,
            control,
            deps,
            prepared: recovery.prepared,
            request: rebuilt.request,
            runId,
            signal,
            userId
          });
          if (dispatched.kind === "resume_later") return;
          directAdapter = rebuilt.adapter;
          directlyRefreshed = dispatched.refreshed;
          providerResponseId = dispatched.refreshed.result?.providerResponseId ??
            dispatched.refreshed.providerResponseId ?? providerResponseId;
        } else if (recovery.kind === "resume" || recovery.kind === "settled") {
          providerResponseId = recovery.providerResponseId ?? providerResponseId;
          recoveredKnowledgeAttempt = recovery.kind === "resume" ? recovery.prepared : null;
        }
      } catch (error) {
        if (signal.aborted || error instanceof ToolLoopRecoveryStopped) return;
        const latest = await loadRecoveryRunControl(deps, runId, userId);
        if (!latest || !isRefreshableRun(latest) || !latest.assistantMessageId) return;
        const failure = focusedRequest
          ? focusedAnswerFailure(error)
          : error instanceof ToolLoopRecoveryError
            ? error
            : isAttachmentMaterializationError(error)
              ? new ToolLoopRecoveryError(error.code, error.message)
              : new ToolLoopRecoveryError(
                  "provider_dispatch_request_mismatch",
                  "The accepted provider request no longer matches its durable dispatch attempt."
                );
        await failRecoveredRun(deps.repository,
          runId,
          latest.assistantMessageId,
          { code: failure.code, message: failure.message },
          { recoveryTerminal: true }
        );
        return;
      }
    }
  }

  if (!directlyRefreshed && !providerResponseId) {
    if (storedKnowledgeAttemptFound && control.assistantMessageId) {
      await failRecoveredRun(deps.repository,
        runId,
        control.assistantMessageId,
        focusedRequest
          ? focusedKnowledgeFailure("knowledge_answer_failed")
          : {
              code: "provider_response_handle_missing",
              message: "The completed provider round has no durable response handle for recovery."
            },
        { recoveryTerminal: true }
      );
    }
    return;
  }

  if (control.project && !(await currentProjectRecoveryAuthorityAllowed(
    deps,
    control.project,
    userId
  ))) {
    await failProjectRecoveryAuthority(deps, control, runId);
    return;
  }

  const adapter = directAdapter ??
    (await resolveAnswerRuntime(deps, runId, control.provider))?.adapter ?? null;
  if (!directlyRefreshed && !adapter?.refresh) {
    if (storedKnowledgeAttemptFound && control.assistantMessageId) {
      await failRecoveredRun(deps.repository,
        runId,
        control.assistantMessageId,
        focusedRequest
          ? focusedKnowledgeFailure("knowledge_answer_failed")
          : {
              code: "provider_refresh_unavailable",
              message: "The saved provider response cannot be refreshed safely."
            },
        { recoveryTerminal: true }
      );
    }
    return;
  }

  const refreshed = directlyRefreshed ??
    await adapter!.refresh!(providerResponseId!).catch(async (error) => {
      const latest = await loadRecoveryRunControl(deps, runId, userId);
      if (!latest || !isActiveRunStatus(latest.status) || !latest.assistantMessageId) {
        return null;
      }

      const payload = focusedRequest
        ? focusedKnowledgeFailure("knowledge_answer_failed")
        : {
            code: "provider_refresh_failed",
            message: "The provider response could not be refreshed. Its outcome remains unconfirmed; the request was not repeated."
          };
      await failRecoveredRun(deps.repository,
        runId,
        latest.assistantMessageId,
        payload,
        focusedRequest ? { recoveryTerminal: true } : undefined
      );

      return null;
    });

  if (!refreshed) {
    return;
  }

  const latestBeforeAppend = await loadRecoveryRunControl(deps, runId, userId);
  if (!latestBeforeAppend || !isRefreshableRun(latestBeforeAppend)) {
    return;
  }
  if (!(await projectRecoveryAuthorityAllowsProceed(
    deps,
    latestBeforeAppend,
    runId,
    userId
  ))) return;

  const refreshedProviderResponseId =
    refreshed.result?.providerResponseId ?? refreshed.providerResponseId ?? latestBeforeAppend.providerResponseId;
  if (refreshedProviderResponseId && refreshedProviderResponseId !== latestBeforeAppend.providerResponseId) {
    const publication = await deps.repository.updateRunProviderResponseId(runId, refreshedProviderResponseId);
    if (publication === "cancelled") {
      await adapter?.cancel?.(refreshedProviderResponseId).catch(() => undefined);
      return;
    }
    if (publication === "terminal") {
      return;
    }
  }

  if (!refreshed.terminal) {
    for (const event of runOutputArtifactEvents(refreshed.events)) {
      await deps.repository.appendRunOutputEvent(runId, event);
    }
    return;
  }

  if (recoveredKnowledgeAttempt) {
    if (refreshed.result) {
      await deps.knowledgeProviderDispatch!.settle(recoveredKnowledgeAttempt, {
        providerResponseId: refreshed.result.providerResponseId ??
          refreshed.providerResponseId ?? providerResponseId,
        usage: refreshed.result.usage
      });
    } else {
      await deps.knowledgeProviderDispatch!.markAmbiguous(recoveredKnowledgeAttempt, {
        providerResponseId: refreshed.providerResponseId ?? providerResponseId,
        reason: "provider_terminal_failed"
      });
    }
  }

  const latestBeforeFinalize = await loadRecoveryRunControl(deps, runId, userId);
  if (!latestBeforeFinalize || !isRefreshableRun(latestBeforeFinalize)) {
    return;
  }
  if (!(await projectRecoveryAuthorityAllowsProceed(
    deps,
    latestBeforeFinalize,
    runId,
    userId
  ))) return;

  if ((refreshed.result?.toolCalls?.length ?? 0) > 0) {
    const payload = focusedRequest
      ? focusedKnowledgeFailure("knowledge_answer_failed")
      : {
          code: "tool_loop_recovery_required",
          message: "The provider response contains outstanding tool calls and cannot be finalized as an answer. Retry the run."
        };
    const usageAttributions = await recoveredUsageAttributions(
      deps,
      latestBeforeFinalize,
      reportedUsage(refreshed)
    );
    await settleRecoveredError(deps.repository, {
      error: payload,
      outputEvents: runOutputArtifactEvents(refreshed.events),
      ...(refreshedProviderResponseId
        ? { providerResponseId: refreshedProviderResponseId }
        : {}),
      runId,
      usageAttributions,
      userId
    });
    return;
  }

  if (refreshed.result && latestBeforeFinalize.assistantMessageId) {
    const usageAttributions = await recoveredUsageAttributions(
      deps,
      latestBeforeFinalize,
      reportedUsage(refreshed)
    );
    let completion: Awaited<ReturnType<typeof finalizeRunCompletion>>;
    try {
      completion = await finalizeRunCompletion({
        outputEvents: runOutputArtifactEvents(refreshed.events),
        repository: deps.repository,
        result: {
          ...refreshed.result,
          providerResponseId: refreshedProviderResponseId ?? undefined,
          usageAttributions
        },
        run: {
          assistantMessageId: latestBeforeFinalize.assistantMessageId,
          chatId: latestBeforeFinalize.chatId,
          modelId: latestBeforeFinalize.modelId,
          provider: latestBeforeFinalize.provider,
          runId,
          userId
        }
      });
    } catch (error) {
      const settlement = runSettlementFailure(error);
      if (!focusedRequest && !settlement) throw error;
      await settleRecoveredError(deps.repository, {
        error: settlement ?? focusedAnswerFailure(error),
        outputEvents: runOutputArtifactEvents(refreshed.events),
        ...(refreshedProviderResponseId
          ? { providerResponseId: refreshedProviderResponseId }
          : {}),
        runId,
        usageAttributions,
        userId
      });
      return;
    }
    if (completion.status === "not_completed") {
      return;
    }

    return;
  }

  const payload = focusedRequest
    ? focusedKnowledgeFailure("knowledge_answer_failed")
    : refreshed.error ?? {
        code: "provider_terminal_response_invalid",
        message: "The provider returned a terminal response without a final result."
      };
  const usageAttributions = await recoveredUsageAttributions(
    deps,
    latestBeforeFinalize,
    reportedUsage(refreshed)
  );
  await settleRecoveredError(deps.repository, {
    error: payload,
    outputEvents: runOutputArtifactEvents(refreshed.events),
    ...(refreshedProviderResponseId
      ? { providerResponseId: refreshedProviderResponseId }
      : {}),
    runId,
    usageAttributions,
    userId
  });
}

async function refreshProviderRunOnce(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string
): Promise<void> {
  if (deps.registry.has(runId)) return;
  const registration = deps.registry.register(runId);
  if (!registration) return;
  try {
    await refreshProviderRunOnceRegistered(deps, runId, userId, registration.signal);
  } finally {
    registration.release();
  }
}

export async function refreshProviderRunIfNeeded(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string
): Promise<void> {
  const existing = runRefreshPromises.get(runId);
  if (existing) {
    await existing;
    return;
  }
  // A foreground owner remains authoritative; its healthy HTTP polls do not
  // constitute recovery attempts.
  if (deps.registry.has(runId)) return;

  const refresh = observeRecoveryRun(runId, () => refreshProviderRunOnce(deps, runId, userId));
  runRefreshPromises.set(runId, refresh);
  try {
    await refresh;
  } finally {
    if (runRefreshPromises.get(runId) === refresh) {
      runRefreshPromises.delete(runId);
    }
  }
}

function recoveredWorkspaceActivity(deps: RunRecoveryDeps, runId: string) {
  return async (entry: ThreadWorkspaceActivityEntry) => {
    const event = projectRunOutputArtifactEvent(workspaceActivityEvent(entry));
    if (event) await deps.repository.appendRunOutputEvent(runId, event);
  };
}

async function recoverAgentIfNeeded(deps: RunRecoveryDeps, runId: string, userId: string, now = new Date()): Promise<boolean> {
  const agent = await deps.repository.interruptExpiredAgentRun?.({ runId, userId, now });
  if (!agent || agent.kind === "not_agent") return false;
  if (agent.kind === "active") return true;
  await settleRecoveredError(deps.repository, {
    runId, userId, outputEvents: [],
    error: { code: agent.failureCode, message: agentFailureMessage(agent.failureCode) },
    usageAttributions: await usageAttributionsWithEstimatedCost(deps.repository, groupedUsageAttributions(agent.usage))
  });
  await deps.workspace?.settle({ outcome: "failed", runId, userId, onActivity: recoveredWorkspaceActivity(deps, runId) });
  return true;
}

export async function reconcileInstallationRuns(
  deps: RunRecoveryDeps,
  input: Readonly<{ now?: Date }> = {}
): Promise<void> {
  await sweepBootOrphanedRunsOnce(deps);
  if (!deps.repository.findInstallationRecoverableRuns) return;

  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - activeRunStaleMs);
  const candidates = await deps.repository.findInstallationRecoverableRuns({
    bootedBefore: processBootSweepState.bootedAt,
    limit: 100,
    staleBefore
  });

  await Promise.allSettled(candidates.map((run) => {
    if (deps.registry.has(run.id)) return;
    // Observe each rejection before allSettled preserves independent progress.
    return observeRecoveryRun(run.id, async () => {
      const control = await loadRecoveryRunControl(deps, run.id, run.userId);
      if (control && !(await projectRecoveryAuthorityAllowsProceed(
        deps,
        control,
        run.id,
        run.userId
      ))) return;
      if (await deps.repository.hasPendingPdfPreparation?.(run.id) ||
        await deps.repository.hasPendingWorkspacePreparation?.(run.id)) return;
      if (await deps.repository.loadPublishedRunAnswer?.({ runId: run.id, userId: run.userId })) {
        await refreshProviderRunIfNeeded(deps, run.id, run.userId);
        return;
      }
      if (run.status === "preparing") {
        await recoverPreparingRun(deps.repository, {
          now,
          runId: run.id,
          userId: run.userId
        });
        return;
      }
      if (await recoverAgentIfNeeded(deps, run.id, run.userId, now)) return;
      const checkpointed = await deps.repository.loadCheckpointedToolLoopRun({
        runId: run.id,
        userId: run.userId
      });
      const knowledgeAttempt = deps.knowledgeProviderDispatch
        ? await deps.knowledgeProviderDispatch.inspect({ modelRunId: run.id, ordinal: 1 })
        : null;
      const adapter = (await resolveAnswerRuntime(deps, run.id, run.provider).catch((error: unknown) => {
        logEvent("run_recovery", { subsystem: "run_recovery", stage: "preflight", outcome: "failed", code: observedFailureCode(error), action: "stop" });
        return null;
      }))
        ?.adapter;
      if (checkpointed || knowledgeAttempt || (run.providerResponseId && adapter?.refresh)) {
        await refreshProviderRunIfNeeded(deps, run.id, run.userId);
        return;
      }
      const updatedAt = run.updatedAt instanceof Date
        ? run.updatedAt
        : new Date(run.updatedAt);
      if (updatedAt.getTime() >= staleBefore.getTime() || !run.assistantMessageId) return;
      await failRecoveredRun(deps.repository, run.id, run.assistantMessageId, {
        code: "run_orphaned",
        message: "Run stopped reporting progress and was marked failed."
      });
      await deps.workspace?.settle({ outcome: "failed", runId: run.id, userId: run.userId, onActivity: recoveredWorkspaceActivity(deps, run.id) })
        .catch((error: unknown) => logEvent("run_recovery", { subsystem: "run_recovery", stage: "release", outcome: "failed",
          code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "retry" }));
    });
  }));
}

export async function reconcileStaleRuns(
  deps: RunRecoveryDeps,
  input: Readonly<{
    chatId?: string;
    now?: Date;
    runId?: string;
    userId: string;
  }>
): Promise<void> {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - activeRunStaleMs);
  const staleRuns = await deps.repository.findStaleActiveRunsForUser({
    chatId: input.chatId,
    runId: input.runId,
    staleBefore,
    userId: input.userId
  });

  for (const run of staleRuns) {
    if (deps.registry.has(run.id)) {
      continue;
    }

    await observeRecoveryRun(run.id, async () => {
      const control = await loadRecoveryRunControl(deps, run.id, input.userId);
      if (control && !(await projectRecoveryAuthorityAllowsProceed(
        deps,
        control,
        run.id,
        input.userId
      ))) return;

      if (await deps.repository.hasPendingPdfPreparation?.(run.id) ||
        await deps.repository.hasPendingWorkspacePreparation?.(run.id)) return;
      if (await deps.repository.loadPublishedRunAnswer?.({ runId: run.id, userId: input.userId })) {
        await refreshProviderRunIfNeeded(deps, run.id, input.userId);
        return;
      }
      if (run.status === "preparing") {
        await recoverPreparingRun(deps.repository, {
          now,
          runId: run.id,
          userId: input.userId
        });
        return;
      }

      if (await recoverAgentIfNeeded(deps, run.id, input.userId, now)) return;

      const checkpointed = await deps.repository.loadCheckpointedToolLoopRun({
        runId: run.id,
        userId: input.userId
      });
      const knowledgeAttempt = deps.knowledgeProviderDispatch
        ? await deps.knowledgeProviderDispatch.inspect({ modelRunId: run.id, ordinal: 1 })
        : null;
      if (checkpointed || knowledgeAttempt) {
        await refreshProviderRunIfNeeded(deps, run.id, input.userId);
        return;
      }

      const adapter = (await resolveAnswerRuntime(deps, run.id, run.provider).catch((error: unknown) => {
        logEvent("run_recovery", { subsystem: "run_recovery", stage: "preflight", outcome: "failed", code: observedFailureCode(error), action: "stop" });
        return null;
      }))
        ?.adapter;
      if (run.providerResponseId && adapter?.refresh) {
        await refreshProviderRunIfNeeded(deps, run.id, input.userId);
        return;
      }

      if (!run.assistantMessageId) {
        return;
      }

      const payload = {
        code: "run_orphaned",
        message: "Run stopped reporting progress and was marked failed."
      };
      await failRecoveredRun(deps.repository, run.id, run.assistantMessageId, payload);
      await deps.workspace?.settle({ outcome: "failed", runId: run.id, userId: input.userId, onActivity: recoveredWorkspaceActivity(deps, run.id) })
        .catch((error: unknown) => logEvent("run_recovery", { subsystem: "run_recovery", stage: "release", outcome: "failed",
          code: observedFailureCode(error), prisma_code: databaseFailureCode(error), action: "retry" }));
    });
  }
}
