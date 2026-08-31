import {
  isGroundingDisplaySseEvent,
  textFromContentBlocks,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import { textMessageContent } from "../../domain/content";
import {
  normalizeTokenUsage,
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
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult,
  type SearchExecutionEvidence
} from "../search/toolExecutor";
import {
  KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS,
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
  "../knowledge/answerGroundingExecutionV21";
import {
  decodeKnowledgeAnswerDraftPrompt,
  decodeKnowledgeAnswerOperationRequestSnapshotV1,
  knowledgeAnswerContractPairForDraftOperation,
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  KNOWLEDGE_COVERAGE_PLANNER_OPERATION,
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION,
  KNOWLEDGE_INSUFFICIENT_MESSAGE,
  KNOWLEDGE_TOOL_LOOP_DRAFT_ROUTE_INSTRUCTION,
  type KnowledgeAnswerContractPair
} from "../knowledge/answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  decodeKnowledgeAnswerDraftPrimaryPromptV21,
  decodeKnowledgeAnswerOperationRequestSnapshotV21
} from "../knowledge/answerGroundingV21";
import { selectKnowledgeAnswerPipelineForNewRun } from
  "../knowledge/answerPipelineRollout";
import {
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
import type { StorageAdapter } from "../uploads/storage";
import {
  finalizeRunCompletion,
  usageAttributionsWithEstimatedCost
} from "./runFinalization";
import {
  providerToolLoopContinuationAfterResult,
  runProviderToolLoop,
  type ProviderToolLoopContinuation
} from "./providerToolLoop";
import { applyProviderRequestContextBudget } from "./runContextBudget";
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
import {
  projectRunOutputArtifactEvent,
  runOutputArtifactEvents
} from "./runOutputEvents";
import { toolRunBudgetsForRequest } from "./toolBudgets";

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
  | "loadRunUsageAttributions"
  | "markAssistantMessageGroundedLiveOnly"
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
  | "groundKnowledgeAnswer"
  | "groundKnowledgeAnswerV5"
  | "groundKnowledgeAnswerV21"
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
    generationId: string;
    inputSchema: Record<string, unknown>;
    name: string;
    signal?: AbortSignal;
  }): Promise<AiqsaMcpToolCallResult>;
  ensureAcceptedGeneration(generationId: string): Promise<boolean>;
}>;

export type RunRecoveryDeps = Readonly<{
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
    prepareProject?(serverIds: readonly string[]): Promise<McpRunPlanResult>;
    router?: McpSemanticRouter;
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

function isRefreshableRun(control: Readonly<{ recoverySettled?: boolean; status: string }>): boolean {
  return isActiveRunStatus(control.status) || (control.status === "error" && !control.recoverySettled);
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
  | "sources_processing"
  | "no_retrieval_candidates"
  | "knowledge_retrieval_failed"
  | "knowledge_answer_failed"
  | "knowledge_answer_contract_failed"
  | "knowledge_citation_contract_failed";

function focusedKnowledgeFailure(
  code: FocusedKnowledgeFailureCode
): Readonly<{ code: FocusedKnowledgeFailureCode; message: string }> {
  const messages: Record<FocusedKnowledgeFailureCode, string> = {
    knowledge_answer_contract_failed:
      "The Knowledge answer did not satisfy the required output contract.",
    knowledge_answer_failed: "The Knowledge answer provider failed.",
    knowledge_citation_contract_failed:
      "The Knowledge answer cited evidence outside the final manifest.",
    knowledge_retrieval_failed: "Knowledge retrieval failed.",
    no_retrieval_candidates:
      "No retrieval candidates were found in the ready Knowledge sources.",
    sources_processing: "The selected Knowledge sources are still processing."
  };
  return { code, message: messages[code] };
}

function recoveryErrorCode(error: unknown): string | null {
  if (error instanceof ToolLoopRecoveryError) return error.code;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : null;
}

function focusedRetrievalFailure(error: unknown): ReturnType<typeof focusedKnowledgeFailure> {
  const code = recoveryErrorCode(error);
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
  label: "Knowledge" | "Search" | "Tool" = "Tool"
): ToolExecutionResult {
  const overflowResult = label === "Knowledge"
    ? null
    : mcpResponseOverflowToolExecutionResult(call, error, label);
  if (overflowResult) return overflowResult;

  const rawMessage = error instanceof Error ? error.message : `${label} execution failed`;
  const message = label === "Knowledge"
    ? "knowledge_retrieval_failed"
    : rawMessage.slice(0, 512);
  return {
    callId: call.id,
    content: [{ text: `${label} failed: ${message}`, type: "text" }],
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
  if (refreshed.result) {
    return refreshed.result.usage;
  }

  for (let index = refreshed.events.length - 1; index >= 0; index -= 1) {
    const event = refreshed.events[index];
    if (event?.type === "usage") {
      return event.data;
    }
  }

  return null;
}

async function recoveredUsageAttributions(
  deps: RunRecoveryDeps,
  control: Readonly<{ modelId: string; provider: string }>,
  usage: ModelRunUsage | null
) {
  if (!usage) {
    return [];
  }

  return usageAttributionsWithEstimatedCost(deps.repository, [
    {
      modelId: control.modelId,
      provider: control.provider,
      usage
    }
  ]);
}

function groupedUsageAttributions(
  attributions: readonly RunUsageAttribution[]
): RunUsageAttribution[] {
  const grouped = new Map<string, {
    modelId: string;
    provider: string;
    usages: ModelRunUsage[];
  }>();
  for (const attribution of attributions) {
    const key = `${attribution.provider}\u0000${attribution.modelId}`;
    const existing = grouped.get(key);
    if (existing) existing.usages.push(attribution.usage);
    else grouped.set(key, {
      modelId: attribution.modelId,
      provider: attribution.provider,
      usages: [attribution.usage]
    });
  }
  return [...grouped.values()].map((entry) => ({
    modelId: entry.modelId,
    provider: entry.provider,
    usage: sumTokenUsage(entry.usages)
  }));
}

function hasTokenUsage(usage: ModelRunUsage): boolean {
  const normalized = normalizeTokenUsage(usage);
  return normalized.cachedInputTokens > 0 || normalized.cacheWriteInputTokens > 0 ||
    normalized.inputTokens > 0 || normalized.outputTokens > 0 ||
    normalized.reasoningTokens > 0 || normalized.totalTokens > 0;
}

function hasValidUsageEvidence(usage: ModelRunUsage): boolean {
  const required = [usage.inputTokens, usage.outputTokens, usage.reasoningTokens];
  const optional = [
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.totalTokens
  ];
  return required.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    optional.every((value) => value === undefined || Number.isSafeInteger(value) && value >= 0);
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
  const answerTotal = sumTokenUsage(answerRoundUsage.map((entry) => entry.usage));
  const remainder = subtractTokenUsage(
    answerAttribution?.usage ?? sumTokenUsage([]),
    answerTotal
  );
  if (!remainder) return null;

  return [
    ...grouped.filter((attribution) =>
      `${attribution.provider}\u0000${attribution.modelId}` !== answerKey),
    ...(hasTokenUsage(remainder)
      ? [{ modelId: answer.modelId, provider: answer.provider, usage: remainder }]
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
  ).catch(() => groupedAttributions);
  await deps.repository.settleRecoveredRunError({
    error,
    outputEvents: runOutputArtifactEvents(events),
    ...(providerResponseId ? { providerResponseId } : {}),
    runId: run.id,
    usageAttributions: attributed,
    userId: run.userId
  });
}

type RecoverySearchExecutor = Readonly<{
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
  activeMcpDiscovery: McpDiscoveryState | undefined;
  activeMcpSnapshot: McpRunPlanSnapshot | undefined;
  deps: RunRecoveryDeps;
  knowledgeResults: Map<string, ToolExecutionResult>;
  mcpDiscoveryBatches: Map<string, Readonly<{
    execute(signal: AbortSignal): Promise<ReadonlyMap<string, ToolExecutionResult>>;
  }>>;
  mcpDiscoveryQueue: Promise<void>;
  persistedUsageRecordedAt: number | null;
  providerRequest: ProviderRunRequest;
  run: CheckpointedToolLoopRun;
  runtime(): RunRecoveryMcpRuntime;
  searchExecutor: RecoverySearchExecutor | null;
  tools: RunTool[];
  usageAttributions: RunUsageAttribution[];
};

function isRecoveredSearchCall(context: RecoveryToolContext, name: string): boolean {
  return context.searchExecutor?.accepts(name) === true;
}

function isRecoveredKnowledgeCall(context: RecoveryToolContext, name: string): boolean {
  return context.run.normalizedRequest.knowledgePlan.mode !== "none" &&
    context.deps.knowledgeExecutor?.accepts(name) === true;
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
  await deps.repository.failRun(
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

async function currentRecoveryMcpDispatchAllowed(
  context: RecoveryToolContext,
  callName: string,
  generationId: string
): Promise<boolean> {
  if (context.run.project && !(await currentProjectRecoveryAuthorityAllowed(
    context.deps,
    context.run.project,
    context.run.userId
  ))) return false;
  if (!context.deps.mcp) return process.env.NODE_ENV !== "production";
  const route = resolveMcpRunTool(context.activeMcpSnapshot, callName);
  if (!route) return false;
  try {
    const current = context.run.project
      ? context.deps.mcp.prepareProject
        ? await context.deps.mcp.prepareProject([route.serverId])
        : null
      : await context.deps.mcp.prepare(context.run.userId, {
          allowedServerIds: [route.serverId]
        });
    if (!current) return false;
    if (!current.ok) return false;
    const binding = current.bindings.find((candidate) =>
      candidate.serverId === route.serverId);
    const server = current.snapshot.servers.find((candidate) =>
      candidate.serverId === route.serverId);
    const tool = current.snapshot.tools.find((candidate) =>
      candidate.serverId === route.serverId &&
      candidate.namespacedName === callName &&
      candidate.originalName === route.originalName);
    return Boolean(
      binding && server && tool &&
      binding.fingerprint === route.fingerprint &&
      server.fingerprint === route.fingerprint &&
      binding.runtimeGenerationId === generationId
    );
  } catch {
    return false;
  }
}

function settledSearchUsageNeedsRecovery(
  call: PersistedToolLoopCall,
  persistedUsageRecordedAt: number | null
): boolean {
  if (persistedUsageRecordedAt === null) return true;
  if (!call.completedAt) return false;
  const completedAt = Date.parse(call.completedAt);
  return Number.isFinite(completedAt) && completedAt > persistedUsageRecordedAt;
}

async function recordRecoveredSearchResult(input: Readonly<{
  context: RecoveryToolContext;
  includeUsage: boolean;
  result: ToolExecutionResult;
}>): Promise<void> {
  const executions = searchExecutionsFromToolResult(input.result);
  const previewCount = searchExecutionPreviewCount(input.result);
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
}

function recordRecoveredKnowledgeResult(input: Readonly<{
  callId: string;
  context: RecoveryToolContext;
  includeUsage: boolean;
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
    const router = context.deps.mcp?.router;
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
      materialize,
      maxResults: toolRunBudgetsForRequest(context.run.normalizedRequest)
        .maxMcpToolsPerDiscovery,
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
          const router = context.deps.mcp?.router;
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
            materialize,
            maxResults: budgets.maxMcpToolsPerDiscovery,
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
  claimCall: RunRepository["claimToolLoopCall"] =
    context.deps.repository.claimToolLoopCall
): Promise<ToolLoopSettledCall<ToolExecutionResult>> {
  const call = modelToolCall(persisted);
  const claim = await claimCall({
    callId: persisted.id,
    runId: context.run.id,
    userId: context.run.userId
  });
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
    const result = parsePersistedToolExecutionResult(call, claim.call.result);
    if (!result) {
      throw new ToolLoopRecoveryError(
        "tool_call_result_invalid",
        "A persisted tool result is invalid and cannot be replayed safely."
      );
    }
    if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      await recordRecoveredSearchResult({
        context,
        includeUsage: settledSearchUsageNeedsRecovery(
          claim.call,
          context.persistedUsageRecordedAt
        ),
        result
      });
    }
    if (isRecoveredKnowledgeCall(context, call.name)) {
      recordRecoveredKnowledgeResult({
        callId: call.id,
        context,
        includeUsage: settledSearchUsageNeedsRecovery(
          claim.call,
          context.persistedUsageRecordedAt
        ),
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
    const externalCall = !preflightResult && !isRecoveredMcpDiscoveryCall(context, call.name);
    if (externalCall) {
      if (!context.deps.memoryEgress && process.env.NODE_ENV === "production") {
        throw new Error("memory_egress_receipt_unavailable");
      }
      const route = resolveMcpRunTool(context.activeMcpSnapshot, call.name);
      const destinationSnapshot = isRecoveredKnowledgeCall(context, call.name)
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
          : {
              fingerprint: route?.fingerprint ?? null,
              kind: "mcp",
              serverId: route?.serverId ?? null,
              toolName: call.name,
              version: 1
            };
      const generationId = claim.call.mcpBinding?.runtimeGenerationId;
      const allowed = isRecoveredKnowledgeCall(context, call.name)
          ? (await currentFocusedKnowledgeRecoveryAuthorization(context.deps, {
              ...(context.run.project ? { project: context.run.project } : {}),
              runId: context.run.id,
              userId: context.run.userId
            })).authorized
          : isRecoveredSearchCall(context, call.name)
          ? await currentRecoverySearchDispatchAllowed(context)
          : generationId
            ? await currentRecoveryMcpDispatchAllowed(context, call.name, generationId)
            : false;
      if (!allowed) {
        await context.deps.memoryEgress?.recordBlockedDispatch({
          destinationKind: String(destinationSnapshot.kind),
          destinationSnapshot,
          errorCode: "memory_egress_destination_revoked",
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
        throw new Error("memory_egress_destination_revoked");
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
    } else if (isRecoveredMcpDiscoveryCall(context, call.name)) {
      result = await executeRecoveredMcpDiscovery(call, persisted, context, signal);
    } else if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      result = await context.searchExecutor.execute(
        call,
        context.providerRequest,
        context.run.id,
        signal
      );
      await recordRecoveredSearchResult({ context, includeUsage: true, result });
    } else if (isRecoveredKnowledgeCall(context, call.name)) {
      result = await context.deps.knowledgeExecutor!.execute(
        call,
        executionContext,
        {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS)
          ])
        }
      );
      recordRecoveredKnowledgeResult({ callId: call.id, context, includeUsage: true, result });
    } else {
      const route = resolveMcpRunTool(context.activeMcpSnapshot, call.name);
      const generationId = claim.call.mcpBinding?.runtimeGenerationId;
      if (!route || !generationId ||
        claim.call.mcpBinding?.runtimeGenerationFingerprint !== route.fingerprint) {
        throw new Error("mcp_run_binding_unavailable");
      }
      const runtime = context.runtime();
      if (!(await runtime.ensureAcceptedGeneration(generationId))) {
        throw new Error("mcp_runtime_not_ready");
      }
      result = mcpToolExecutionResult(call, await runtime.callTool({
        arguments: call.arguments,
        generationId,
        inputSchema: route.tool.inputSchema,
        name: route.originalName,
        signal
      }));
    }
    if (externalReceipt &&
      !(await context.deps.memoryEgress!.completeDispatch(externalReceipt.id))) {
      throw new Error("memory_egress_receipt_conflict");
    }
  } catch (error) {
    if (externalReceipt) {
      await context.deps.memoryEgress!.failDispatch(
        externalReceipt.id,
        error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/u.test(error.message)
          ? error.message
          : "external_tool_dispatch_failed"
      ).catch(() => undefined);
    }
    if (signal.aborted) throw new ToolLoopRecoveryStopped();
    if (error instanceof McpAutoDiscoveryUnavailableError) {
      fatalToolError = new ToolLoopRecoveryError(error.code, error.message);
      result = toolExecutionErrorResult(call, error);
    } else {
      result = toolExecutionErrorResult(
        call,
        error,
        isRecoveredKnowledgeCall(context, call.name)
          ? "Knowledge"
          : context.searchExecutor && isRecoveredSearchCall(context, call.name) ? "Search" : "Tool"
      );
    }
  }
  if (signal.aborted) throw new ToolLoopRecoveryStopped();

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
  const ambiguous = ordered.find((call) =>
    call.state === "running" && call.toolName !== MCP_FIND_TOOLS_NAME);
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
  let cursor = 0;
  let firstError: unknown;
  async function worker(): Promise<void> {
    while (firstError === undefined) {
      const index = cursor;
      cursor += 1;
      const call = ordered[index];
      if (!call) return;
      try {
        results[index] = await executePersistedToolCall(call, context, signal);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, ordered.length) }, () => worker())
  );
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
  let currentProviderResponseId = run.providerResponseId;
  let tokenBuffer: ReturnType<typeof createRunTokenPersistenceBuffer> | null = null;

  function allUsageAttributions(): RunUsageAttribution[] {
    return [
      ...usageAttributions,
      ...answerRoundUsage.map((entry) => ({
        modelId: run.modelId,
        provider: run.provider,
        usage: entry.usage
      }))
    ];
  }

  try {
    if (run.assistantText === null) {
      throw new ToolLoopRecoveryError(
        "grounding_live_only_not_recoverable",
        "Grounded live-only output cannot resume after process recovery."
      );
    }
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
    const persistedUsageRecordedAt = persistedUsage.reduce<number | null>((latest, attribution) => {
      const recordedAt = Date.parse(attribution.recordedAt);
      if (!Number.isFinite(recordedAt)) return latest;
      return latest === null ? recordedAt : Math.max(latest, recordedAt);
    }, null);
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
        limits: attachmentLimits,
        signal
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
      attachments
    };
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
          accepts: (name) => planSearchRouter.accepts(name),
          execute: (call, request, _runId, executionSignal) =>
            planSearchRouter.execute(call, request, { signal: executionSignal }),
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
    const tools: RunTool[] = [
      ...(recoveredKnowledgeEnabled ? deps.knowledgeExecutor?.tools ?? [] : []),
      ...(searchExecutor?.tools ?? []),
      ...(activeMcpDiscovery ? [mcpFindToolsTool] : []),
      ...(clientToolsEnabled ? mcpRunTools(run.normalizedRequest.mcp) : [])
    ];
    if (tools.length === 0) {
      throw new ToolLoopRecoveryError(
        "tool_configuration_empty",
        "The saved run has no recoverable tools."
      );
    }
    const externalToolsPresent = tools.some((tool) => tool.capability !== "memory");
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
      activeMcpDiscovery,
      activeMcpSnapshot: run.normalizedRequest.mcp,
      deps,
      knowledgeResults: new Map(),
      mcpDiscoveryBatches: new Map(),
      mcpDiscoveryQueue: Promise.resolve(),
      persistedUsageRecordedAt,
      providerRequest,
      run,
      runtime() {
        runtime ??= getDefaultMcpRuntimeCoordinator();
        return runtime;
      },
      searchExecutor,
      tools,
      usageAttributions
    };
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
        const stream = adapter!.stream(request, { signal: dispatchSignal });
        let next = await stream.next();
        while (!next.done) {
          yield next.value;
          next = await stream.next();
        }
        if (receipt && !(await deps.memoryEgress!.completeDispatch(receipt.id))) {
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
          ).catch(() => undefined);
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
      if (grouped.length === 0 && !answerRoundEntry) return;
      const recorded = await deps.repository.recordRunUsageEvents({
        ...(answerRoundEntry ? { answerRoundUsage: answerRoundEntry } : {}),
        chatId: run.chatId,
        runId: run.id,
        usageAttributions: await usageAttributionsWithEstimatedCost(deps.repository, grouped),
        userId: run.userId
      });
      if (answerRoundEntry && !recorded) {
        usageEvidenceTrusted = false;
        throw new ToolLoopRecoveryError(
          "tool_loop_usage_checkpoint_conflict",
          "Recovered provider-round usage could not be checkpointed."
        );
      }
    }

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
        usage: normalizeTokenUsage(usage)
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
      const effectiveEvent = withPinnedHostedSearchIdentity(event, run.normalizedRequest);
      if (effectiveEvent.type === "token") {
        if (recoveredKnowledgeEnabled) return;
        await tokenBuffer!.push(effectiveEvent.data.delta);
        return;
      }
      if (isGroundingDisplaySseEvent(effectiveEvent)) {
        await tokenBuffer!.disablePersistence();
        if (run.assistantMessageId) {
          await deps.repository.markAssistantMessageGroundedLiveOnly({
            assistantMessageId: run.assistantMessageId,
            groundedAt: new Date(),
            provider: run.normalizedRequest.provider,
            runId: run.id,
            strategy: run.normalizedRequest.searchPlan.options.find((option) =>
              option.adapterKind === "answer_provider_hosted")?.optionId ?? "provider-grounding"
          });
        }
        throw new ToolLoopRecoveryError(
          "grounding_live_only_not_recoverable",
          "Grounded live-only output cannot resume after process recovery."
        );
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
      round: number
    ): Promise<ProviderRunRequest> {
      const budgeted = applyProviderRequestContextBudget({
        bridge,
        request: {
          ...roundRequest,
          ...(context.activeMcpDiscovery && round === 1
            ? { parallelToolCalls: false }
            : {}),
          ...(context.activeMcpSnapshot ? { mcp: context.activeMcpSnapshot } : {}),
          ...(context.activeMcpDiscovery
            ? { mcpDiscovery: context.activeMcpDiscovery }
            : {})
        }
      });
      if (!budgeted.ok) {
        throw new ToolLoopRecoveryError("context_too_large", budgeted.error.message);
      }
      if (budgeted.contextTruncation) {
        await appendEvent({
          data: {
            artifactType: "context_truncated",
            payload: budgeted.contextTruncation
          },
          type: "artifact"
        });
      }
      return budgeted.request;
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
        return toolLoopKnowledgeEvidenceDispatchDraft({ request: providerRequest, results });
      } catch (error) {
        throw new ToolLoopRecoveryError(
          error instanceof Error && error.message === "no_retrieval_candidates"
            ? "no_retrieval_candidates"
            : "knowledge_retrieval_failed",
          "The recovered Knowledge evidence manifest is invalid."
        );
      }
    }

    async function finalizeRecoveredKnowledgeToolLoop(): Promise<void> {
      await tokenBuffer!.flush();
      await persistCumulativeUsage();
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
            finalText: KNOWLEDGE_INSUFFICIENT_MESSAGE,
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
          modelCapabilities: run.normalizedRequest.modelCapabilities,
          reasoningEffort: typeof run.normalizedRequest.params.reasoningEffort === "string"
            ? run.normalizedRequest.params.reasoningEffort
            : null,
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
      const persisted = await deps.repository.persistToolLoopCallBatch({
        calls: calls.map((call, ordinal) => {
          const route = resolveMcpRunTool(context.activeMcpSnapshot, call.name);
          if (!route && !isRecoveredKnowledgeCall(context, call.name) &&
            searchExecutor?.accepts(call.name) !== true &&
            !isRecoveredMcpDiscoveryCall(context, call.name)) {
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
            toolName: call.name
          };
        }),
        providerContinuation: toolLoopJson(
          continuation,
          toolLoopPersistenceLimits.checkpointBytes,
          "tool_loop_checkpoint_invalid"
        ),
        roundIndex: round,
        runId: run.id,
        userId: run.userId
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
          return bridge.appendToolResult(undefined, result);
        })
      ];
      const completedToolRounds = Math.max(0, round - 1);
      const priorToolCalls = run.calls.length;
      return prepareRecoveredProviderRequest({
        ...providerRequest,
        parallelToolCalls: run.normalizedRequest.modelCapabilities.parallelToolCalls === true,
        providerToolMessages,
        toolChoice: completedToolRounds >= toolBudgets.maxToolRounds ||
          priorToolCalls >= toolBudgets.maxToolCalls
          ? "none"
          : completedToolRounds === 0 && providerRequest.toolChoice === "required"
            ? "required"
            : "auto",
        tools
      }, round);
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
      if ((refreshed.result.toolCalls?.length ?? 0) === 0) {
        if (recoveredKnowledgeEnabled) {
          await finalizeRecoveredKnowledgeToolLoop();
          return;
        }
        const groupedAttributions = groupedUsageAttributions(allUsageAttributions());
        const completion = await finalizeRunCompletion({
          outputEvents: runOutputArtifactEvents(refreshed.events),
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
      projectToolResultForProvider: (result) => result,
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
          toolCalls: run.calls.length +
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
    const completion = await finalizeRunCompletion({
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
    if (signal.aborted || error instanceof ToolLoopRecoveryStopped) {
      await tokenBuffer?.flush().catch(() => undefined);
      return;
    }
    let recoveryError = error;
    const originalStreamSafetyReport = providerStreamSafetyReport(error);
    try {
      await tokenBuffer?.flush();
    } catch (flushError) {
      if (!originalStreamSafetyReport) recoveryError = flushError;
    }
    const streamSafetyReport = providerStreamSafetyReport(recoveryError);
    const safetyCode = streamSafetyReport?.code ??
      (recoveryError instanceof ToolLoopRecoveryError &&
        isProviderStreamSafetyCode(recoveryError.code)
        ? recoveryError.code
        : isRecord(recoveryError) && isProviderStreamSafetyCode(recoveryError.code)
          ? recoveryError.code
          : null);
    const failure = recoveryError instanceof ToolLoopRecoveryError
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
          : new ToolLoopRecoveryError(
              "tool_loop_recovery_failed",
              recoveryError instanceof Error ? recoveryError.message : "Tool-loop recovery failed."
            );
    if (streamSafetyReport) {
      warnProviderStreamSafetyOnce(failure, {
        adapterKind: "direct",
        connectionId: "unbound",
        providerFamily: run.provider,
        providerModelId: "unbound"
      });
    }
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
    .then(() => undefined)
    .catch((error: unknown) => {
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
  const budgeted = applyProviderRequestContextBudget({
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
      ).catch(() => undefined);
    }
    if (!attemptSettled) {
      if (!providerDispatched) {
        await input.deps.knowledgeProviderDispatch!.release(
          input.prepared,
          "provider_dispatch_not_started"
        ).catch(() => undefined);
      } else if (!durableProviderResponseId) {
        await input.deps.knowledgeProviderDispatch!.markAmbiguous(input.prepared, {
          reason: "provider_dispatch_failed"
        }).catch(() => undefined);
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
  let pipeline: "v20_v16" | "v21_audit_v1";
  if (input.draftDispatch) {
    if (input.draftDispatch.attempt.purpose === KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21) {
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
      pipeline = "v21_audit_v1";
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
        ...(draftRequest.version === 2
          ? { executionPolicy: draftRequest.executionPolicy }
          : { reasoningEffort: draftRequest.reasoningEffort }),
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
    pipeline = selectKnowledgeAnswerPipelineForNewRun({ modelRunId: input.runId });
    if (pipeline === "v21_audit_v1") {
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
    (pipeline === "v21_audit_v1"
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
        prompt: { developer: null, system: operation.systemPrompt },
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
      prompt: { developer: null, system: operation.systemPrompt }
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
  const execute = async (
    operation: ProviderStructuredOutputRequest,
    options: KnowledgeAnswerOperationExecutionOptionsV8
  ): Promise<KnowledgeAnswerOperationExecutionV8> => {
    const operationSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(120_000)
    ]);
    if (options.providerResponseId) {
      if (!runtime.adapter.refresh) {
        throw new Error("structured_output_recovery_unavailable");
      }
      const refreshed = await runtime.adapter.refresh(options.providerResponseId);
      if (!refreshed.terminal) throw new KnowledgeAnswerOperationDeferredError();
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
      let operationUsage: ModelRunUsage = {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      };
      const output = await runtime.structuredOutputAdapter.execute(operation, {
        onProviderResponseId(value) {
          providerResponseId = value;
        },
        onUsage(value) {
          operationUsage = value;
        },
        signal: operationSignal,
        timeoutMs: 120_000
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
      const eventResponseId = providerResponseIdFromEvent(next.value);
      if (eventResponseId) providerResponseId = eventResponseId;
      next = await stream.next();
    }
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
  const groundingInput = {
    authorize,
    draft: seed.draft,
    ...(seed.evidenceBindings?.length
      ? { evidenceBindings: seed.evidenceBindings }
      : {}),
    execute,
    forbiddenIdentityFragments: [
      input.runId,
      ...(seed.forbiddenIdentityFragments ?? seed.draft.items.map((item) => item.evidenceId))
    ],
    lifecycle: deps.knowledgeProviderDispatch,
    modelRunId: input.runId,
    ...(seed.executionPolicy
      ? { executionPolicy: seed.executionPolicy }
      : { reasoningEffort: seed.reasoningEffort }),
    request: seed.request,
    routeInstruction: seed.routeInstruction,
    shouldAbort: () => input.signal.aborted,
    transport: seed.transport
  } as const;
  const operationResult = pipeline === "v21_audit_v1"
    ? await executeKnowledgeAnswerGroundingV21({
        ...groundingInput,
        recoveryProviderResponseIds: input.control.providerResponseId
          ? {
              1: input.control.providerResponseId,
              2: input.control.providerResponseId,
              3: input.control.providerResponseId,
              4: input.control.providerResponseId,
              5: input.control.providerResponseId,
              6: input.control.providerResponseId
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
  const usageAttributions = groupedUsageAttributions([
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
      await deps.repository.failRun(
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
      await deps.repository.failRun(
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
      await deps.repository.failRun(
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
          evidenceBindings: recovered.evidenceBindings,
          modelCapabilities: acceptedRequest.modelCapabilities,
          reasoningEffort: typeof acceptedRequest.params.reasoningEffort === "string"
            ? acceptedRequest.params.reasoningEffort
            : null,
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
      await deps.repository.failRun(
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
      await deps.repository.failRun(
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
        await deps.repository.failRun(
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
        let result: ToolExecutionResult;
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
          const executionContext = {
            persistedToolCallId: claim.call.id,
            request: providerRequest,
            runId,
            userId
          };
          const preflight = await deps.knowledgeExecutor.preflight?.(call, executionContext);
          result = preflight && preflight.kind !== "admitted"
            ? preflight.result
            : await deps.knowledgeExecutor.execute(call, executionContext, {
                signal: AbortSignal.any([
                  signal,
                  AbortSignal.timeout(KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS)
                ])
              }).catch((error) => toolExecutionErrorResult(call, error, "Knowledge"));
          const stored = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes);
          if (!stored) {
            throw new ToolLoopRecoveryError(
              "knowledge_retrieval_failed",
              "Recovered focused Knowledge evidence is too large."
            );
          }
          const settled = await deps.repository.settleToolLoopCall({
            callId: claim.call.id,
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
        }
        const evidence = knowledgeEvidenceFromToolResult(result);
        if (result.status !== "complete" || !evidence) {
          throw new ToolLoopRecoveryError(
            "knowledge_retrieval_failed",
            "Focused Knowledge retrieval failed."
          );
        }
        if (evidence.results.length < 1) {
          throw new ToolLoopRecoveryError(
            "no_retrieval_candidates",
            "No Knowledge retrieval candidates were found."
          );
        }
        const retrievalAttributions = knowledgeUsageAttributionsFromToolResult(result);
        if (retrievalAttributions.length > 0) {
          await deps.repository.recordRunUsageEvents({
            chatId: control.chatId,
            runId,
            usageAttributions: await usageAttributionsWithEstimatedCost(
              deps.repository,
              retrievalAttributions
            ),
            userId
          });
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
        const budgeted = applyProviderRequestContextBudget({
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
            forbiddenIdentityFragments: authorization.scope?.sources.flatMap((source) => [
              source.sourceId,
              source.sourceVersionId,
              source.sourceArtifactId
            ]),
            modelCapabilities: acceptedRequest.modelCapabilities,
            reasoningEffort: typeof acceptedRequest.params.reasoningEffort === "string"
              ? acceptedRequest.params.reasoningEffort
              : null,
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
          await deps.repository.failRun(
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
        await deps.repository.failRun(
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
            await deps.repository.failRun(
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
        await deps.repository.failRun(
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
      await deps.repository.failRun(
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
      await deps.repository.failRun(
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
            message: error instanceof Error ? error.message : "Provider refresh failed"
          };
      await deps.repository.failRun(
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
    await deps.repository.settleRecoveredRunError({
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
      if (!focusedRequest) throw error;
      await deps.repository.settleRecoveredRunError({
        error: focusedAnswerFailure(error),
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
  await deps.repository.settleRecoveredRunError({
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

  const refresh = refreshProviderRunOnce(deps, runId, userId);
  runRefreshPromises.set(runId, refresh);
  try {
    await refresh;
  } finally {
    if (runRefreshPromises.get(runId) === refresh) {
      runRefreshPromises.delete(runId);
    }
  }
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

  await Promise.allSettled(candidates.map(async (run) => {
    if (deps.registry.has(run.id)) return;
    const control = await loadRecoveryRunControl(deps, run.id, run.userId);
    if (control && !(await projectRecoveryAuthorityAllowsProceed(
      deps,
      control,
      run.id,
      run.userId
    ))) return;
    if (run.status === "preparing") {
      await deps.repository.recoverPreparingRun({
        now,
        runId: run.id,
        userId: run.userId
      });
      return;
    }
    const checkpointed = await deps.repository.loadCheckpointedToolLoopRun({
      runId: run.id,
      userId: run.userId
    });
    const knowledgeAttempt = deps.knowledgeProviderDispatch
      ? await deps.knowledgeProviderDispatch.inspect({ modelRunId: run.id, ordinal: 1 })
      : null;
    const adapter = (await resolveAnswerRuntime(deps, run.id, run.provider).catch(() => null))
      ?.adapter;
    if (checkpointed || knowledgeAttempt || (run.providerResponseId && adapter?.refresh)) {
      await refreshProviderRunIfNeeded(deps, run.id, run.userId);
      return;
    }
    const updatedAt = run.updatedAt instanceof Date
      ? run.updatedAt
      : new Date(run.updatedAt);
    if (updatedAt.getTime() >= staleBefore.getTime() || !run.assistantMessageId) return;
    await deps.repository.failRun(run.id, run.assistantMessageId, {
      code: "run_orphaned",
      message: "Run stopped reporting progress and was marked failed."
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

    const control = await loadRecoveryRunControl(deps, run.id, input.userId);
    if (control && !(await projectRecoveryAuthorityAllowsProceed(
      deps,
      control,
      run.id,
      input.userId
    ))) continue;

    if (run.status === "preparing") {
      await deps.repository.recoverPreparingRun({
        now,
        runId: run.id,
        userId: input.userId
      });
      continue;
    }

    const checkpointed = await deps.repository.loadCheckpointedToolLoopRun({
      runId: run.id,
      userId: input.userId
    });
    const knowledgeAttempt = deps.knowledgeProviderDispatch
      ? await deps.knowledgeProviderDispatch.inspect({ modelRunId: run.id, ordinal: 1 })
      : null;
    if (checkpointed || knowledgeAttempt) {
      await refreshProviderRunIfNeeded(deps, run.id, input.userId);
      continue;
    }

    const adapter = (await resolveAnswerRuntime(deps, run.id, run.provider).catch(() => null))
      ?.adapter;
    if (run.providerResponseId && adapter?.refresh) {
      await refreshProviderRunIfNeeded(deps, run.id, input.userId);
      continue;
    }

    if (!run.assistantMessageId) {
      continue;
    }

    const payload = {
      code: "run_orphaned",
      message: "Run stopped reporting progress and was marked failed."
    };
    await deps.repository.failRun(run.id, run.assistantMessageId, payload);
  }
}
