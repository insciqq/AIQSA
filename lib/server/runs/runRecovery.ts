import {
  isGroundingDisplaySseEvent,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import {
  normalizeTokenUsage,
  subtractTokenUsage,
  sumTokenUsage
} from "../../domain/usage";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import type { McpRunPlanResult } from "../mcp/runPlan";
import { validateRunAccess } from "../auth/entitlements";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool } from "../mcp/toolExecutor";
import type {
  ProviderAdapter,
  ProviderRunRefreshResult,
  ProviderRunRequest,
  ProviderSearchAdapter
} from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS } from "../providers/providerConfiguration";
import {
  isProviderStreamSafetyCode,
  providerStreamSafeMessage,
  providerStreamSafetyReport,
  type ProviderStreamSafetyReport
} from "../providers/streamSafety";
import { warnProviderStreamSafetyOnce } from "../providers/streamSafetyObservability";
import type { ProviderRuntimeResolver } from "../providerRuntime/runtimeResolver";
import { providerToolBridges } from "../tools/bridges";
import {
  createSearchPlanToolRouter,
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult,
  type SearchExecutionEvidence
} from "../search/toolExecutor";
import type { KnowledgeToolExecutor } from "../knowledge/toolExecutor";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import { defaultMemoryActionExecutor } from "../memory/actions/defaultAction";
import { memoryActionTools } from "../memory/actions/tools";
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
import type { RunRepository, RunUsageAttribution } from "./runRepositoryContract";
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
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import { createRunTokenPersistenceBuffer } from "./runTokenPersistence";
import {
  projectRunOutputArtifactEvent,
  runOutputArtifactEvents
} from "./runOutputEvents";

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
> & Partial<Pick<RunRepository, "isSearchStrategyEnabled" | "loadEntitlements">>;

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
  knowledgeAdmission?: Readonly<{
    load(input: {
      knowledgePlan: ProviderRunRequest["knowledgePlan"];
      userId: string;
    }): Promise<KnowledgeRunAdmissionPlan>;
  }>;
  memoryEgress?: MemoryToolEgressReceiptService;
  memoryActionExecutor?: MemoryActionExecutor;
  memoryHistoryToolExecutor?: MemoryHistoryToolExecutor;
  mcpRuntime?: RunRecoveryMcpRuntime;
  mcp?: Readonly<{
    prepare(
      userId: string,
      options?: Readonly<{ allowedServerIds?: readonly string[] }>
    ): Promise<McpRunPlanResult>;
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

type RecoveryToolContext = Readonly<{
  deps: RunRecoveryDeps;
  persistedUsageRecordedAt: number | null;
  providerRequest: ProviderRunRequest;
  run: CheckpointedToolLoopRun;
  runtime(): RunRecoveryMcpRuntime;
  knowledgeExecutor: KnowledgeToolExecutor | null;
  memoryActionExecutor: MemoryActionExecutor | null;
  memoryHistoryToolExecutor: MemoryHistoryToolExecutor | null;
  searchExecutor: RecoverySearchExecutor | null;
  usageAttributions: RunUsageAttribution[];
}>;

function isRecoveredSearchCall(context: RecoveryToolContext, name: string): boolean {
  return context.searchExecutor?.accepts(name) === true;
}

function isRecoveredKnowledgeCall(context: RecoveryToolContext, name: string): boolean {
  return context.knowledgeExecutor?.accepts(name) === true;
}

function isRecoveredMemoryCall(context: RecoveryToolContext, name: string): boolean {
  return context.memoryActionExecutor?.accepts(name) === true;
}

function isRecoveredMemoryHistoryCall(
  context: RecoveryToolContext,
  name: string
): boolean {
  return context.memoryHistoryToolExecutor?.accepts(name) === true;
}

async function currentRecoverySearchDispatchAllowed(
  context: RecoveryToolContext
): Promise<boolean> {
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

async function currentRecoveryKnowledgeDispatchAllowed(
  context: RecoveryToolContext
): Promise<boolean> {
  if (!context.deps.knowledgeAdmission) return process.env.NODE_ENV !== "production";
  try {
    const expected = context.run.normalizedRequest.knowledgePlan.baseIds;
    const current = await context.deps.knowledgeAdmission.load({
      knowledgePlan: { baseIds: expected },
      userId: context.run.userId
    });
    return current.bindings.length === expected.length &&
      current.bindings.every((binding, ordinal) =>
        binding.knowledgeBaseId === expected[ordinal]);
  } catch {
    return false;
  }
}

async function currentRecoveryMcpDispatchAllowed(
  context: RecoveryToolContext,
  callName: string,
  generationId: string
): Promise<boolean> {
  if (!context.deps.mcp) return process.env.NODE_ENV !== "production";
  const route = resolveMcpRunTool(context.run.normalizedRequest.mcp, callName);
  if (!route) return false;
  try {
    const current = await context.deps.mcp.prepare(context.run.userId, {
      allowedServerIds: [route.serverId]
    });
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

async function executePersistedToolCall(
  persisted: PersistedToolLoopCall,
  context: RecoveryToolContext,
  signal: AbortSignal
): Promise<ToolLoopSettledCall<ToolExecutionResult>> {
  const call = modelToolCall(persisted);
  const claim = await context.deps.repository.claimToolLoopCall({
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
    } else if (isRecoveredKnowledgeCall(context, call.name)) {
      const evidence = knowledgeEvidenceFromToolResult(result);
      if (result.status === "complete" && !evidence) {
        throw new ToolLoopRecoveryError(
          "tool_call_result_invalid",
          "Persisted Knowledge result evidence is invalid and cannot be replayed safely."
        );
      }
      if (evidence && settledSearchUsageNeedsRecovery(claim.call, context.persistedUsageRecordedAt)) {
        context.usageAttributions.push(...knowledgeUsageAttributionsFromToolResult(result));
      }
    }
    return {
      call,
      ordinal: persisted.ordinal,
      result: { status: "complete", value: result },
      round: persisted.roundIndex
    };
  }

  let result: ToolExecutionResult;
  let externalReceipt: Awaited<ReturnType<MemoryToolEgressReceiptService["beginDispatch"]>> | null = null;
  try {
    if (hasInvalidProviderToolArguments(call.arguments)) {
      throw new Error("provider_tool_arguments_invalid");
    }
    const externalCall = !isRecoveredMemoryCall(context, call.name) &&
      !isRecoveredMemoryHistoryCall(context, call.name);
    if (externalCall) {
      if (!context.deps.memoryEgress && process.env.NODE_ENV === "production") {
        throw new Error("memory_egress_receipt_unavailable");
      }
      const route = resolveMcpRunTool(context.run.normalizedRequest.mcp, call.name);
      const destinationSnapshot = isRecoveredKnowledgeCall(context, call.name)
          ? {
            baseIds: context.run.normalizedRequest.knowledgePlan.baseIds,
            kind: "knowledge",
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
        ? await currentRecoveryKnowledgeDispatchAllowed(context)
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
    if (isRecoveredKnowledgeCall(context, call.name)) {
      result = await context.knowledgeExecutor!.execute(call, {
        persistedToolCallId: claim.call.id,
        request: context.providerRequest,
        runId: context.run.id,
        userId: context.run.userId
      }, { signal });
      const evidence = knowledgeEvidenceFromToolResult(result);
      if (result.status === "complete" && !evidence) {
        throw new ToolLoopRecoveryError(
          "tool_call_result_invalid",
          "Knowledge result evidence is invalid and cannot be persisted safely."
        );
      }
      if (evidence) {
        context.usageAttributions.push(...knowledgeUsageAttributionsFromToolResult(result));
      }
    } else if (isRecoveredMemoryCall(context, call.name)) {
      result = await context.memoryActionExecutor!.execute(
        call,
        {
          persistedToolCallId: claim.call.id,
          request: context.providerRequest,
          runId: context.run.id,
          userId: context.run.userId
        }
      );
    } else if (isRecoveredMemoryHistoryCall(context, call.name)) {
      result = await context.memoryHistoryToolExecutor!.execute(call, {
        persistedToolCallId: claim.call.id,
        request: context.providerRequest,
        runId: context.run.id,
        userId: context.run.userId
      });
    } else if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      result = await context.searchExecutor.execute(
        call,
        context.providerRequest,
        context.run.id,
        signal
      );
      await recordRecoveredSearchResult({ context, includeUsage: true, result });
    } else {
      const route = resolveMcpRunTool(context.run.normalizedRequest.mcp, call.name);
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
    result = toolExecutionErrorResult(
      call,
      error,
      isRecoveredKnowledgeCall(context, call.name)
        ? "Knowledge"
        : context.searchExecutor && isRecoveredSearchCall(context, call.name) ? "Search" : "Tool"
    );
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
  const ambiguous = ordered.find((call) => call.state === "running");
  if (ambiguous) {
    throw new ToolLoopRecoveryError(
      "tool_call_outcome_unknown",
      `Tool ${ambiguous.toolName} may have completed before the process stopped and was not repeated.`
    );
  }
  if (ordered.some((call) => call.state === "cancelled")) {
    throw new ToolLoopRecoveryStopped();
  }

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
    const providerRequest: ProviderRunRequest = {
      ...run.normalizedRequest,
      attachments
    };
    const clientToolsEnabled = run.normalizedRequest.toolMode !== "none";
    const memoryActionsRequested =
      run.normalizedRequest.memoryActionTools?.version === "model-driven-v2";
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
    const knowledgeEnabled = clientToolsEnabled &&
      run.normalizedRequest.modelCapabilities.toolCalling === true &&
      run.normalizedRequest.knowledgePlan.baseIds.length > 0;
    if (knowledgeEnabled && !deps.knowledgeExecutor) {
      throw new ToolLoopRecoveryError(
        "knowledge_policy_not_available",
        "The saved Knowledge retrieval policy is no longer available."
      );
    }
    const knowledgeExecutor = knowledgeEnabled ? deps.knowledgeExecutor ?? null : null;
    const memoryActionEnabled = memoryActionsRequested &&
      clientToolsEnabled &&
      run.normalizedRequest.modelCapabilities.toolCalling === true;
    const memoryActionExecutor = memoryActionEnabled
      ? deps.memoryActionExecutor ?? defaultMemoryActionExecutor
      : null;
    const memoryHistoryEnabled = clientToolsEnabled &&
      run.normalizedRequest.modelCapabilities.toolCalling === true &&
      run.normalizedRequest.memoryHistoryTool?.maxCalls === 2 &&
      run.normalizedRequest.memoryHistoryTool.pageSize === 20;
    const memoryHistoryToolExecutor = memoryHistoryEnabled
      ? deps.memoryHistoryToolExecutor ?? defaultMemoryHistoryToolExecutor
      : null;
    const tools: RunTool[] = [
      ...(knowledgeExecutor ? [knowledgeExecutor.tool] : []),
      ...(searchExecutor?.tools ?? []),
      ...(memoryActionExecutor ? memoryActionTools : []),
      ...(memoryHistoryToolExecutor ? [memoryHistoryToolExecutor.tool] : []),
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
      deps,
      persistedUsageRecordedAt,
      providerRequest,
      run,
      knowledgeExecutor,
      memoryActionExecutor,
      memoryHistoryToolExecutor,
      runtime() {
        runtime ??= getDefaultMcpRuntimeCoordinator();
        return runtime;
      },
      searchExecutor,
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
      if (egressReceiptRequired && !deps.memoryEgress && process.env.NODE_ENV === "production") {
        throw new ToolLoopRecoveryError(
          "memory_egress_receipt_unavailable",
          "Memory egress evidence is unavailable."
        );
      }
      let preview: Record<string, unknown> | null = null;
      const requestPreview = () => {
        preview ??= adapter!.buildRequestPreview(request);
        return preview;
      };
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
      const receipt = egressReceiptRequired && deps.memoryEgress
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
      try {
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
        return streamRecoveredProviderRequest(request, options?.signal ?? signal);
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

    const persistedCalls = new Map<string, PersistedToolLoopCall>(
      run.calls.map((call) => [call.providerCallId, call])
    );

    async function persistToolBatch(
      calls: readonly Readonly<{ arguments: unknown; id: string; name: string }>[],
      continuation: ProviderToolLoopContinuation,
      round: number
    ): Promise<readonly PersistedToolLoopCall[]> {
      const persisted = await deps.repository.persistToolLoopCallBatch({
        calls: calls.map((call, ordinal) => {
          const route = resolveMcpRunTool(run.normalizedRequest.mcp, call.name);
          if (!route && searchExecutor?.accepts(call.name) !== true &&
            knowledgeExecutor?.accepts(call.name) !== true &&
            memoryActionExecutor?.accepts(call.name) !== true &&
            memoryHistoryToolExecutor?.accepts(call.name) !== true) {
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
      return persisted.calls;
    }

    let continuation = parseProviderToolLoopContinuation(run.checkpoint.providerContinuation);
    let currentCalls: readonly PersistedToolLoopCall[];

    if (run.checkpoint.phase === "provider_running") {
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
      const refreshed = await adapter.refresh(currentProviderResponseId).catch((error: unknown) => {
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
      beforeProviderRound: async () => undefined,
      bridge,
      budgets: {
        maxConcurrency: 4,
        maxToolCalls: 16,
        maxToolRounds: 3
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
      persistToolBatch: async ({ calls, continuation: nextContinuation, round }) => {
        await persistToolBatch(calls, nextContinuation, round);
      },
      prepareRequest: async (roundRequest) => {
        const budgeted = applyProviderRequestContextBudget({
          bridge,
          request: roundRequest
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

async function refreshProviderRunOnceRegistered(
  deps: RunRecoveryDeps,
  runId: string,
  userId: string,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  const control = await deps.repository.getRunControlForUser(runId, userId);
  if (!control || !isRefreshableRun(control)) {
    return;
  }

  const checkpointed = await deps.repository.loadCheckpointedToolLoopRun({ runId, userId });
  if (checkpointed) {
    await recoverCheckpointedToolLoop(deps, checkpointed, signal);
    return;
  }

  if (!control.providerResponseId) return;

  const adapter = (await resolveAnswerRuntime(deps, runId, control.provider))?.adapter;
  if (!adapter?.refresh) {
    return;
  }

  const refreshed = await adapter.refresh(control.providerResponseId).catch(async (error) => {
    const latest = await deps.repository.getRunControlForUser(runId, userId);
    if (!latest || !isActiveRunStatus(latest.status) || !latest.assistantMessageId) {
      return null;
    }

    const payload = {
      code: "provider_refresh_failed",
      message: error instanceof Error ? error.message : "Provider refresh failed"
    };
    await deps.repository.failRun(runId, latest.assistantMessageId, payload);

    return null;
  });

  if (!refreshed) {
    return;
  }

  const latestBeforeAppend = await deps.repository.getRunControlForUser(runId, userId);
  if (!latestBeforeAppend || !isRefreshableRun(latestBeforeAppend)) {
    return;
  }

  const refreshedProviderResponseId =
    refreshed.result?.providerResponseId ?? refreshed.providerResponseId ?? latestBeforeAppend.providerResponseId;
  if (refreshedProviderResponseId && refreshedProviderResponseId !== latestBeforeAppend.providerResponseId) {
    const publication = await deps.repository.updateRunProviderResponseId(runId, refreshedProviderResponseId);
    if (publication === "cancelled") {
      await adapter.cancel?.(refreshedProviderResponseId).catch(() => undefined);
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

  const latestBeforeFinalize = await deps.repository.getRunControlForUser(runId, userId);
  if (!latestBeforeFinalize || !isRefreshableRun(latestBeforeFinalize)) {
    return;
  }

  if ((refreshed.result?.toolCalls?.length ?? 0) > 0) {
    const payload = {
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
    const completion = await finalizeRunCompletion({
      outputEvents: runOutputArtifactEvents(refreshed.events),
      repository: deps.repository,
      result: {
        ...refreshed.result,
        providerResponseId: refreshedProviderResponseId ?? undefined
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
    if (completion.status === "not_completed") {
      return;
    }

    return;
  }

  const payload = refreshed.error ?? {
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
    const adapter = (await resolveAnswerRuntime(deps, run.id, run.provider).catch(() => null))
      ?.adapter;
    if (checkpointed || (run.providerResponseId && adapter?.refresh)) {
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
    if (checkpointed) {
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
