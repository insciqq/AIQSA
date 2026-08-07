import {
  isGroundingDisplaySseEvent,
  type ModelRunSseEvent,
  type ModelRunUsage
} from "../../domain/modelRunEvents";
import { sumTokenUsage } from "../../domain/usage";
import type { AiqsaMcpToolCallResult } from "../mcp/clientSession";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { mcpRunTools, mcpToolExecutionResult, resolveMcpRunTool } from "../mcp/toolExecutor";
import type {
  ProviderAdapter,
  ProviderRunRefreshResult,
  ProviderRunRequest,
  ProviderRunResult,
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
import { createPerplexitySearchToolExecutor, perplexityWebSearchTool } from "../tools/perplexitySearch";
import {
  createSearchPlanToolRouter,
  searchExecutionPreviewCount,
  searchExecutionsFromToolResult,
  type SearchExecutionEvidence
} from "../search/toolExecutor";
import {
  hasInvalidProviderToolArguments,
  type ModelToolCall,
  type RunTool,
  type ToolExecutionResult
} from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import {
  appendRunEventWithRetry,
  appendStoredRunEvents,
  finalizeRunCompletion,
  usageAttributionsWithEstimatedCost
} from "./runFinalization";
import {
  providerToolLoopContinuationAfterResult,
  runProviderToolLoop,
  type ProviderToolLoopContinuation
} from "./providerToolLoop";
import { applyProviderRequestContextBudget } from "./runContextBudget";
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
  snapshotToolLoopJson,
  toolLoopPersistenceLimits,
  type CheckpointedToolLoopRun,
  type PersistedToolLoopCall,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import {
  persistedToolDurationMs,
  toolCallInspectionArtifact,
  toolLoopPhaseArtifact,
  toolResultInspectionArtifact
} from "./toolInspection";
import { createRunTokenPersistenceBuffer } from "./runTokenPersistence";

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
  | "appendRunEvent"
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
  | "nextRunEventSequence"
  | "persistToolLoopCallBatch"
  | "recordRunUsageEvents"
  | "resetToolLoopAssistantDraft"
  | "settleRecoveredRunError"
  | "settleToolLoopCall"
  | "sweepBootOrphanedRuns"
  | "updateRunProviderRequestPreview"
  | "updateRunProviderResponseId"
>;

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
  mcpRuntime?: RunRecoveryMcpRuntime;
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

async function resolveSearchRuntime(
  deps: RunRecoveryDeps,
  runId: string,
  provider: string
): Promise<ProviderSearchAdapter | undefined> {
  if (deps.providerRuntime) {
    return (await deps.providerRuntime.resolve(runId, "search")).searchAdapter;
  }
  return deps.searchProviders?.[provider];
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

export function resetBootOrphanSweepForTest(bootedAt = new Date()): void {
  processBootSweepState.bootedAt = bootedAt;
  processBootSweepState.promise = undefined;
}

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
  label: "Search" | "Tool" = "Tool"
): ToolExecutionResult {
  const overflowResult = mcpResponseOverflowToolExecutionResult(call, error, label);
  if (overflowResult) return overflowResult;

  const rawMessage = error instanceof Error ? error.message : `${label} execution failed`;
  const message = rawMessage.slice(0, 512);
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

function recordFromPreview(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function persistRecoveredSearchRun(input: Readonly<{
  call: ModelToolCall;
  modelRunId: string;
  repository: RunRecoveryRepository;
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
      providerResponseId: typeof preview.providerResponseId === "string"
        ? preview.providerResponseId
        : undefined,
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

async function persistRecoveredPlanSearchExecution(input: Readonly<{
  execution: SearchExecutionEvidence;
  modelRunId: string;
  repository: RunRecoveryRepository;
}>): Promise<void> {
  await input.repository.createSearchRun({
    artifacts: {
      displayName: input.execution.displayName,
      ...(input.execution.failure ? { failure: input.execution.failure } : {}),
      ...(input.execution.findings ? { findings: input.execution.findings } : {}),
      invocationId: input.execution.invocationId,
      ...(input.execution.providerOperations
        ? { providerOperations: input.execution.providerOperations }
        : {}),
      providerOperationsTruncated: input.execution.providerOperationsTruncated,
      ...(input.execution.providerUsage ? { providerUsage: input.execution.providerUsage } : {}),
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
    events: [...events],
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
  legacy: null | Readonly<{
    modelId: string;
    strategyId: string;
  }>;
  tools: readonly RunTool[];
}>;

type RecoveryToolContext = Readonly<{
  deps: RunRecoveryDeps;
  durations: Map<string, number>;
  persistedUsageRecordedAt: number | null;
  providerRequest: ProviderRunRequest;
  run: CheckpointedToolLoopRun;
  runtime(): RunRecoveryMcpRuntime;
  searchExecutor: RecoverySearchExecutor | null;
  usageAttributions: RunUsageAttribution[];
}>;

function isRecoveredSearchCall(context: RecoveryToolContext, name: string): boolean {
  return context.searchExecutor?.accepts(name) === true;
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
  call: ModelToolCall;
  context: RecoveryToolContext;
  includeUsage: boolean;
  result: ToolExecutionResult;
}>): Promise<void> {
  const legacy = input.context.searchExecutor?.legacy;
  if (legacy) {
    if (input.includeUsage && input.result.usage) {
      input.context.usageAttributions.push({
        modelId: legacy.modelId,
        provider: "openrouter",
        usage: input.result.usage
      });
    }
    await persistRecoveredSearchRun({
      call: input.call,
      modelRunId: input.context.run.id,
      repository: input.context.deps.repository,
      result: input.result,
      searchModelId: legacy.modelId,
      strategyId: legacy.strategyId
    });
    return;
  }

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
  const startedAt = Date.now();
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
    const persistedDuration = persistedToolDurationMs(claim.call);
    if (persistedDuration !== undefined) context.durations.set(call.id, persistedDuration);
    const result = parsePersistedToolExecutionResult(call, claim.call.result);
    if (!result) {
      throw new ToolLoopRecoveryError(
        "tool_call_result_invalid",
        "A persisted tool result is invalid and cannot be replayed safely."
      );
    }
    if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      await recordRecoveredSearchResult({
        call,
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
  try {
    if (hasInvalidProviderToolArguments(call.arguments)) {
      throw new Error("provider_tool_arguments_invalid");
    }
    if (context.searchExecutor && isRecoveredSearchCall(context, call.name)) {
      result = await context.searchExecutor.execute(
        call,
        context.providerRequest,
        context.run.id,
        signal
      );
      await recordRecoveredSearchResult({ call, context, includeUsage: true, result });
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
  } catch (error) {
    if (signal.aborted) throw new ToolLoopRecoveryStopped();
    result = toolExecutionErrorResult(
      call,
      error,
      context.searchExecutor && isRecoveredSearchCall(context, call.name) ? "Search" : "Tool"
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
  if (!context.durations.has(call.id)) {
    context.durations.set(call.id, Date.now() - startedAt);
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
  const persistedUsageKeys = new Set<string>();
  let currentProviderResponseId = run.providerResponseId;
  let tokenBuffer: ReturnType<typeof createRunTokenPersistenceBuffer> | null = null;

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
    usageAttributions.push(...persistedUsage.map(({ recordedAt: _recordedAt, ...attribution }) =>
      attribution
    ));
    for (const attribution of persistedUsage) {
      persistedUsageKeys.add(`${attribution.provider}\u0000${attribution.modelId}`);
    }
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
    const searchEnabled = !run.normalizedRequest.searchPlan &&
      run.normalizedRequest.searchStrategy === "perplexity-tool-search";
    const searchPolicy = run.normalizedRequest.searchPolicy;
    const searchAdapter = searchPolicy
      ? await resolveSearchRuntime(deps, run.id, searchPolicy.provider)
      : undefined;
    if (searchEnabled && (!searchPolicy || !searchAdapter)) {
      throw new ToolLoopRecoveryError(
        "search_policy_not_available",
        "The saved search tool policy is no longer available."
      );
    }
    const legacySearchExecutor = searchEnabled
      ? createPerplexitySearchToolExecutor({ searchAdapter: searchAdapter!, searchPolicy: searchPolicy! })
      : null;
    const planRuntimes: Record<string, ProviderRuntimeBinding> = {};
    for (const option of run.normalizedRequest.searchPlan?.options ?? []) {
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
    const candidatePlanSearchRouter = run.normalizedRequest.searchPlan
      ? createSearchPlanToolRouter({
          acceptLegacyToolNames: true,
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
    const planSearchRouter = run.normalizedRequest.searchPlan
      ? createSearchPlanToolRouter({
          acceptLegacyToolNames: true,
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
          legacy: null,
          tools: planSearchRouter.tools
        }
      : legacySearchExecutor
        ? {
            accepts: (name) => name === legacySearchExecutor.tool.name,
            execute: (call, request, recoveredRunId, executionSignal) =>
              legacySearchExecutor.execute(
                call,
                { request, runId: recoveredRunId },
                { signal: executionSignal }
              ),
            legacy: {
              modelId: searchPolicy!.modelId,
              strategyId: searchPolicy!.strategyId
            },
            tools: [perplexityWebSearchTool]
          }
        : null;
    const tools: RunTool[] = [
      ...(searchExecutor?.tools ?? []),
      ...mcpRunTools(run.normalizedRequest.mcp)
    ];
    if (tools.length === 0) {
      throw new ToolLoopRecoveryError(
        "tool_configuration_empty",
        "The saved run has no recoverable tools."
      );
    }
    const hasMcpTools = tools.some((tool) => tool.capability === "mcp");

    let runtime = deps.mcpRuntime;
    const context: RecoveryToolContext = {
      deps,
      durations: new Map(),
      persistedUsageRecordedAt,
      providerRequest,
      run,
      runtime() {
        runtime ??= getDefaultMcpRuntimeCoordinator();
        return runtime;
      },
      searchExecutor,
      usageAttributions
    };
    const sequence = { value: await deps.repository.nextRunEventSequence(run.id) };
    tokenBuffer = createRunTokenPersistenceBuffer({
      allowErroredAssistant: true,
      assistantMessageId: run.assistantMessageId,
      initialText: run.assistantText ?? "",
      repository: deps.repository,
      runId: run.id,
      sequence
    });

    async function persistCumulativeUsage(): Promise<void> {
      const grouped = groupedUsageAttributions(usageAttributions);
      if (grouped.length === 0) return;
      await deps.repository.recordRunUsageEvents({
        chatId: run.chatId,
        runId: run.id,
        usageAttributions: await usageAttributionsWithEstimatedCost(deps.repository, grouped),
        userId: run.userId
      });
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
            strategy: run.normalizedRequest.searchStrategy ?? "provider-grounding"
          });
        }
        throw new ToolLoopRecoveryError(
          "grounding_live_only_not_recoverable",
          "Grounded live-only output cannot resume after process recovery."
        );
      }
      await tokenBuffer!.flush();
      await publishProviderResponseId(providerResponseIdFromEvent(effectiveEvent) ?? undefined);
      await appendRunEventWithRetry(deps.repository, run.id, sequence, effectiveEvent);
    }

    async function appendToolResults(
      results: readonly ToolLoopSettledCall<ToolExecutionResult>[],
      round: number
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
        await appendEvent(toolResultInspectionArtifact({
          call,
          durationMs: context.durations.get(call.id) ??
            persistedToolDurationMs(persistedCalls.get(call.id)),
          mcp: run.normalizedRequest.mcp,
          ordinal: settled.ordinal,
          result,
          round
        }));
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
          if (!route && searchExecutor?.accepts(call.name) !== true) {
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
      if (persisted.kind === "persisted") {
        if (hasMcpTools) {
          await appendEvent(toolLoopPhaseArtifact({
            count: persisted.calls.length,
            phase: "tools",
            round
          }));
        }
        for (const call of persisted.calls) {
          await appendEvent(toolCallInspectionArtifact({
            call: modelToolCall(call),
            mcp: run.normalizedRequest.mcp,
            ordinal: call.ordinal,
            round
          }));
        }
      }
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
      if (hasMcpTools) {
        await appendEvent(toolLoopPhaseArtifact({
          phase: "model",
          round: run.checkpoint.roundIndex
        }));
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
      if (!refreshed.result) {
        await settleToolLoopRecoveryError(
          deps,
          run,
          refreshed.error ?? {
            code: "provider_terminal_response_invalid",
            message: "The provider returned a terminal response without a final result."
          },
          usageAttributions,
          refreshed.events,
          currentProviderResponseId
        );
        return;
      }
      const providerUsageKey = `${run.provider}\u0000${run.modelId}`;
      if (!persistedUsageKeys.has(providerUsageKey)) {
        usageAttributions.push({
          modelId: run.modelId,
          provider: run.provider,
          usage: refreshed.result.usage
        });
      }
      await persistCumulativeUsage();
      if ((refreshed.result.toolCalls?.length ?? 0) === 0) {
        const groupedAttributions = groupedUsageAttributions(usageAttributions);
        const completion = await finalizeRunCompletion({
          eventsBeforeTerminal: refreshed.events,
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
      const providerUsageKey = `${run.provider}\u0000${run.modelId}`;
      if (usageResponseId && adapter.refresh && !persistedUsageKeys.has(providerUsageKey)) {
        const currentRound = await adapter.refresh(usageResponseId).catch(() => null);
        if (currentRound?.terminal && currentRound.result) {
          usageAttributions.push({
            modelId: run.modelId,
            provider: run.provider,
            usage: currentRound.result.usage
          });
          await persistCumulativeUsage();
        }
      }
    }

    await tokenBuffer.flush();
    const reset = await deps.repository.resetToolLoopAssistantDraft({
      roundIndex: run.checkpoint.roundIndex,
      runId: run.id,
      sequence: sequence.value,
      userId: run.userId
    });
    if (!reset) {
      throw new ToolLoopRecoveryError(
        "tool_loop_reset_conflict",
        "The recovered assistant draft could not be reset."
      );
    }
    sequence.value += 1;
    tokenBuffer.resetLocal();

    if (hasMcpTools && run.checkpoint.phase !== "provider_running") {
      await appendEvent(toolLoopPhaseArtifact({
        count: currentCalls.length,
        phase: "tools",
        round: run.checkpoint.roundIndex
      }));
    }
    const previousToolResults = await executePersistedToolBatch(currentCalls, context, signal);
    await appendToolResults(previousToolResults, run.checkpoint.roundIndex);
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
      adapter,
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
      beforeProviderRound: async ({ request, round }) => {
        await deps.repository.updateRunProviderRequestPreview(
          run.id,
          adapter.buildRequestPreview(request)
        );
        if (hasMcpTools) {
          await appendEvent(toolLoopPhaseArtifact({ phase: "model", round }));
        }
      },
      bridge,
      budgets: { maxConcurrency: 4, maxToolCalls: 16, maxToolRounds: 3 },
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
          sequence: sequence.value,
          userId: run.userId
        });
        if (!didReset) {
          throw new ToolLoopRecoveryError(
            "tool_loop_reset_conflict",
            "The recovered assistant draft could not be reset."
          );
        }
        sequence.value += 1;
        tokenBuffer!.resetLocal();
      },
      onToolBatchSettled: async ({ results, round }) => {
        await appendToolResults(results, round);
        await persistCumulativeUsage();
      },
      onUsage: async (usage, request) => {
        usageAttributions.push({ modelId: request.modelId, provider: request.provider, usage });
        await persistCumulativeUsage();
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
    const groupedAttributions = groupedUsageAttributions(usageAttributions);
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
      usageAttributions,
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
    const sequence = { value: await deps.repository.nextRunEventSequence(runId) };
    await appendStoredRunEvents({
      events: refreshed.events,
      repository: deps.repository,
      runId,
      sequence
    });
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
      events: [...refreshed.events],
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
      eventsBeforeTerminal: refreshed.events,
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
    events: [...refreshed.events],
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
  const staleBefore = new Date((input.now ?? new Date()).getTime() - activeRunStaleMs);
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
