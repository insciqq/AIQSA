import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { McpClientSessionError } from "../mcp/clientSession";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderRunRefreshResult,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter,
  ProviderSearchRequest
} from "../providers/types";
import { ProviderStreamTooLargeError } from "../providers/streamSafety";
import type {
  PersistedRunUsageAttribution,
  RunControlRecord,
  RunUsageAttribution,
  StaleRunControlRecord
} from "./runRepositoryContract";
import {
  toolLoopCheckpoint,
  toolLoopPersistenceLimits,
  upsertAnswerRoundUsage,
  type CheckpointedToolLoopRun,
  type PersistedAnswerRoundUsage,
  type PersistedToolLoopCall,
  type ToolLoopCheckpoint,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "./toolExecutionPersistence";
import {
  SEARCH_TOOL_RESULT_VERSION,
  searchToolResultContent,
  type SearchExecutionEvidence
} from "../search/toolResult";
import { knowledgeRetrievalTool } from "../knowledge/toolExecutor";
import {
  knowledgeToolResultContent,
  knowledgeToolResultText
} from "../knowledge/toolResult";
import {
  KNOWLEDGE_RESULT_VERSION,
  KNOWLEDGE_TOOL_NAME,
  type KnowledgeRetrievalEvidence
} from "../knowledge/retrievalTypes";
import type { MemoryActionExecutor } from "../memory/actions/toolExecutor";
import {
  activeRunStaleMs,
  reconcileInstallationRuns,
  reconcileStaleRuns,
  refreshProviderRunIfNeeded,
  resetBootOrphanSweepForTest,
  sweepBootOrphanedRunsOnce,
  type RunRecoveryDeps,
  type RunRecoveryRegistry,
  type RunRecoveryRepository
} from "./runRecovery";

const userId = "user-1";
const runId = "run-1";

const providerEvent = {
  data: {
    artifactType: "summary",
    payload: {
      status: "provider_complete"
    }
  },
  type: "artifact"
} satisfies ModelRunSseEvent;

const providerResult = {
  finalProviderResponsePreview: {
    id: "response-new",
    status: "completed"
  },
  finalText: "Recovered answer",
  providerResponseId: "response-new",
  usage: {
    inputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 1
  }
} satisfies ProviderRunResult;

function control(overrides: Partial<RunControlRecord> = {}): RunControlRecord {
  return {
    assistantMessageId: "assistant-1",
    chatId: "chat-1",
    id: runId,
    modelId: "gpt-test",
    provider: "openai",
    providerResponseId: "response-old",
    status: "streaming",
    ...overrides
  };
}

function staleControl(overrides: Partial<StaleRunControlRecord> = {}): StaleRunControlRecord {
  return {
    ...control(overrides),
    updatedAt: new Date("2026-07-12T09:00:00.000Z"),
    ...overrides
  };
}

function providerWithRefresh(refresh: () => Promise<ProviderRunRefreshResult>): ProviderAdapter {
  return {
    buildRequestPreview: () => ({}),
    refresh,
    async *stream() {
      return providerResult;
    }
  };
}

function registry(
  liveRunIds: readonly string[] = []
): RunRecoveryRegistry & { abort(runId: string): boolean } {
  const live = new Map(liveRunIds.map((id) => [id, new AbortController()]));

  return {
    abort(candidateRunId) {
      const controller = live.get(candidateRunId);
      if (!controller) return false;
      controller.abort();
      live.delete(candidateRunId);
      return true;
    },
    has: (candidateRunId) => live.has(candidateRunId),
    ids: () => [...live.keys()],
    register(candidateRunId) {
      if (live.has(candidateRunId)) return null;
      const controller = new AbortController();
      live.set(candidateRunId, controller);
      return {
        release() {
          if (live.get(candidateRunId) === controller) live.delete(candidateRunId);
        },
        signal: controller.signal
      };
    }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function createHarness(options: Readonly<{
  attachmentLimits?: ReturnType<NonNullable<RunRecoveryDeps["getAttachmentLimits"]>>;
  completeRun?: boolean;
  controls?: readonly (RunControlRecord | null)[];
  failRun?: boolean;
  liveRunIds?: readonly string[];
  knowledgeExecutor?: RunRecoveryDeps["knowledgeExecutor"];
  memoryActionExecutor?: MemoryActionExecutor;
  mcpRuntime?: RunRecoveryDeps["mcpRuntime"];
  pricing?: {
    inputTokenPriceMicros: number;
    outputTokenPriceMicros: number;
  } | null;
  pricingError?: Error;
  providers?: Readonly<Record<string, ProviderAdapter>>;
  registry?: RunRecoveryRegistry;
  settleRecoveredRunError?: boolean;
  searchProviders?: RunRecoveryDeps["searchProviders"];
  staleRuns?: readonly StaleRunControlRecord[];
  storage?: RunRecoveryDeps["storage"];
}> = {}) {
  const controls = options.controls ?? [control()];
  const initialControl = controls.find((candidate): candidate is RunControlRecord => candidate !== null) ??
    control();
  let controlIndex = 0;
  let appendCollision = false;
  let nextSequence = 0;
  const state: {
    assistantAppendOptions: Array<Readonly<{ allowErrored?: boolean }> | undefined>;
    assistantTexts: string[];
    appendAttempts: { event: ModelRunSseEvent; runId: string; sequence: number }[];
    completed: Parameters<RunRecoveryRepository["completeRun"]>[0] | null;
    events: { event: ModelRunSseEvent; runId: string; sequence: number }[];
    failed: {
      assistantMessageId: string;
      error: { code: string; message: string };
      runId: string;
    }[];
    operations: string[];
    providerResponseIds: { providerResponseId: string; runId: string }[];
    preparingRecoveries: Parameters<RunRecoveryRepository["recoverPreparingRun"]>[0][];
    recoveredErrors: Parameters<RunRecoveryRepository["settleRecoveredRunError"]>[0][];
    run: {
      providerResponseId: string | null;
      recoverySettled: boolean;
      status: RunControlRecord["status"];
    };
    staleQueries: Parameters<RunRecoveryRepository["findStaleActiveRunsForUser"]>[0][];
    sweeps: string[][];
    usageAttributions: RunUsageAttribution[][];
  } = {
    assistantAppendOptions: [],
    assistantTexts: [],
    appendAttempts: [],
    completed: null,
    events: [],
    failed: [],
    operations: [],
    providerResponseIds: [],
    preparingRecoveries: [],
    recoveredErrors: [],
    run: {
      providerResponseId: initialControl.providerResponseId,
      recoverySettled: initialControl.recoverySettled ?? false,
      status: initialControl.status
    },
    staleQueries: [],
    sweeps: [],
    usageAttributions: []
  };
  const repository: RunRecoveryRepository = {
    advanceToolLoopCallBatch: async () => "not_found",
    appendAssistantText: async (_assistantMessageId, text, appendOptions) => {
      state.operations.push("append_assistant_text");
      state.assistantAppendOptions.push(appendOptions);
      state.assistantTexts.push(text);
    },
    appendRunEvent: async (eventRunId, sequence, event) => {
      state.appendAttempts.push({ event, runId: eventRunId, sequence });
      if (appendCollision) {
        appendCollision = false;
        nextSequence = Math.max(nextSequence, sequence + 1);
        throw new Error("sequence_collision");
      }

      state.operations.push(`append:${event.type}`);
      state.events.push({ event, runId: eventRunId, sequence });
      nextSequence = Math.max(nextSequence, sequence + 1);
    },
    completeRun: async (input) => {
      state.operations.push("complete");
      if (options.completeRun === false) {
        return false;
      }
      const active = state.run.status === "streaming" || state.run.status === "queued" ||
        state.run.status === "in_progress";
      const recovered = state.run.status === "error" && !state.run.recoverySettled &&
        state.run.providerResponseId === (input.providerResponseId ?? null);
      if (!active && !recovered) return false;

      state.completed = input;
      state.run.providerResponseId = input.providerResponseId ?? state.run.providerResponseId;
      state.run.status = "complete";
      for (const event of [
        ...(input.eventsBeforeTerminal ?? []),
        { data: input.usage, type: "usage" as const },
        {
          data: { runId: input.runId, status: "complete" as const },
          type: "done" as const
        }
      ]) {
        state.events.push({ event, runId: input.runId, sequence: nextSequence });
        nextSequence += 1;
      }
      return true;
    },
    claimToolLoopCall: async () => ({ kind: "not_found" }),
    createSearchRun: async () => undefined,
    failRun: async (failedRunId, assistantMessageId, error, failOptions) => {
      if (options.failRun === false) {
        return false;
      }
      state.operations.push(`fail:${error.code}`);
      state.run.recoverySettled = failOptions?.recoveryTerminal === true;
      state.run.status = "error";
      state.failed.push({ assistantMessageId, error, runId: failedRunId });
      state.events.push({
        event: { data: error, type: "error" },
        runId: failedRunId,
        sequence: nextSequence
      });
      nextSequence += 1;
      return true;
    },
    findStaleActiveRunsForUser: async (input) => {
      state.staleQueries.push(input);
      return [...(options.staleRuns ?? [])];
    },
    getRunControlForUser: async () => {
      const value = controls[Math.min(controlIndex, controls.length - 1)] ?? null;
      controlIndex += 1;
      return value;
    },
    loadAttachments: async () => [],
    loadCheckpointedToolLoopRun: async () => null,
    loadModelPricing: async () => {
      if (options.pricingError) throw options.pricingError;
      return options.pricing === undefined
        ? {
            inputTokenPriceMicros: 10,
            outputTokenPriceMicros: 20
          }
        : options.pricing;
    },
    loadRunUsageAttributions: async () => [],
    markAssistantMessageGroundedLiveOnly: async () => true,
    nextRunEventSequence: async () => nextSequence,
    persistToolLoopCallBatch: async () => ({ kind: "not_found" }),
    recordRunUsageEvents: async (input) => {
      if (state.run.status === "complete") return false;
      state.usageAttributions.push(input.usageAttributions);
      return true;
    },
    recoverPreparingRun: async (input) => {
      state.preparingRecoveries.push(input);
      return "settled";
    },
    resetToolLoopAssistantDraft: async () => false,
    settleRecoveredRunError: async (input) => {
      if (options.settleRecoveredRunError === false || state.run.status === "cancelled" ||
        state.run.status === "complete" || state.run.recoverySettled) {
        return false;
      }
      state.operations.push(`settle_recovered:${input.error.code}`);
      state.run.recoverySettled = true;
      state.run.status = "error";
      state.recoveredErrors.push(input);
      state.failed.push({
        assistantMessageId: "assistant-1",
        error: input.error,
        runId: input.runId
      });
      for (const event of [
        ...input.events,
        { data: input.error, type: "error" as const }
      ]) {
        state.events.push({ event, runId: input.runId, sequence: nextSequence });
        nextSequence += 1;
      }
      return true;
    },
    settleToolLoopCall: async () => "not_found",
    sweepBootOrphanedRuns: async ({ liveRunIds }) => {
      state.sweeps.push(liveRunIds);
      return 0;
    },
    updateRunProviderResponseId: async (responseRunId, providerResponseId) => {
      state.operations.push("update_response_id");
      if (state.run.status === "cancelled") return "cancelled";
      const active = state.run.status === "streaming" || state.run.status === "queued" ||
        state.run.status === "in_progress";
      if (!active && !(state.run.status === "error" && !state.run.recoverySettled)) {
        return "terminal";
      }
      state.run.providerResponseId = providerResponseId;
      state.providerResponseIds.push({ providerResponseId, runId: responseRunId });
      return "published";
    },
    updateRunProviderRequestPreview: async () => undefined
  };
  const deps: RunRecoveryDeps = {
    ...(options.attachmentLimits
      ? { getAttachmentLimits: () => options.attachmentLimits! }
      : {}),
    ...(options.knowledgeExecutor ? { knowledgeExecutor: options.knowledgeExecutor } : {}),
    ...(options.memoryActionExecutor ? { memoryActionExecutor: options.memoryActionExecutor } : {}),
    ...(options.mcpRuntime ? { mcpRuntime: options.mcpRuntime } : {}),
    providers: options.providers ?? {},
    registry: options.registry ?? registry(options.liveRunIds),
    repository,
    ...(options.searchProviders ? { searchProviders: options.searchProviders } : {}),
    ...(options.storage ? { storage: options.storage } : {})
  };

  return {
    collideNextAppend() {
      appendCollision = true;
    },
    deps,
    repository,
    setStoredRun(input: Partial<typeof state.run>) {
      Object.assign(state.run, input);
    },
    state
  };
}

const recoveryToolName = "mcp_memory_remember_1234567890";
const recoveryFingerprint = "a".repeat(64);

function normalizedToolRequest(): NormalizedRunRequest {
  return {
    attachmentIds: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "remember this", type: "text" }] },
    context: { messages: [], mode: "branch_path" },
    mcp: {
      servers: [{
        fingerprint: recoveryFingerprint,
        revisionId: "revision-1",
        serverId: "server-1",
        serverName: "Memory"
      }],
      tools: [{
        definitionHash: "b".repeat(64),
        description: "Remember a value",
        inputSchema: { type: "object" },
        name: "remember",
        namespacedName: recoveryToolName,
        originalName: "remember",
        serverId: "server-1",
        serverName: "Memory"
      }],
      version: 1
    },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      parallelToolCalls: true,
      pdf: false,
      reasoning: true,
      streaming: true,
      vision: false
    },
    modelId: "gpt-test",
    params: { background: true, stream: true },
    prompt: { developer: null, system: null },
    provider: "openai",
    searchStrategy: null
  };
}

function normalizedLegacySearchRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    searchPlan: {
      mode: "model_choice",
      options: [{
        adapterKind: "provider_model_client",
        config: {
          maxResults: 8,
          modelCapabilities: {
            nativePdfInput: false,
            nativeSearch: true,
            pdf: false,
            reasoning: false,
            streaming: true,
            toolCalling: false,
            vision: false
          },
          modelDefaultParams: {},
          queryMaxCharacters: 500,
          timeoutMs: 5_000
        },
        credentialMode: "provider_model",
        displayName: "OpenAI Search",
        executionModes: ["all_selected", "model_choice"],
        modelId: "search-model",
        optionId: "openai-native-web-search",
        protocol: "openai_responses_web_search",
        provider: "openai_compatible",
        providerModelId: "search-model-row",
        revisionId: "search-revision-1",
        searchStrategyRowId: "search-strategy-row-1"
      }]
    },
    searchStrategy: "openai-native-web-search"
  };
}

function normalizedKnowledgeRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    knowledgePlan: { baseIds: ["knowledge-base-1"] },
    modelCapabilities: {
      ...request.modelCapabilities,
      toolCalling: true
    },
    toolMode: "auto"
  };
}

function normalizedMemoryActionRequest(): NormalizedRunRequest {
  const { mcp: _mcp, ...request } = normalizedToolRequest();
  return {
    ...request,
    memoryActionPlan: {
      kind: "SAVE",
      sourceEnd: 24,
      sourceStart: 14,
      statement: "I like tea",
      version: "memory-action-plan-v1"
    },
    modelCapabilities: {
      ...request.modelCapabilities,
      toolCalling: true
    },
    toolMode: "auto"
  };
}

function normalizedAnthropicSearchRequest(): NormalizedRunRequest {
  const request = normalizedLegacySearchRequest();
  const option = request.searchPlan!.options[0]!;
  return {
    ...request,
    searchPlan: {
      mode: "model_choice",
      options: [{
        ...option,
        config: {
          ...option.config,
          maxOutputTokens: 4_096,
          maxSearchCallsPerAnswer: 2,
          modelCapabilities: {
            nativePdfInput: true,
            nativeSearch: true,
            pdf: true,
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"],
            streaming: true,
            toolCalling: true,
            vision: true
          },
          reasoningPolicy: "lowest_supported"
        },
        displayName: "Anthropic Web Search",
        modelId: "claude-opus-5",
        optionId: "anthropic-web-search",
        protocol: "anthropic_web_search",
        provider: "anthropic",
        providerModelId: "anthropic-search-deployment",
        revisionId: "anthropic-search-revision-1",
        searchStrategyRowId: "anthropic-search-client-route"
      }]
    },
    searchStrategy: "anthropic-web-search"
  };
}

function checkpoint(
  phase: "provider_running" | "tools_pending" | "tools_running",
  roundIndex: number,
  continuation: ToolLoopJsonValue,
  answerRoundUsage?: readonly PersistedAnswerRoundUsage[]
): ToolLoopCheckpoint {
  if (answerRoundUsage === undefined) {
    return {
      phase,
      providerContinuation: continuation,
      providerCursor: null,
      roundIndex,
      version: 1
    };
  }
  const value = toolLoopCheckpoint({
    answerRoundUsage,
    phase,
    providerContinuation: continuation,
    roundIndex
  });
  if (!value) throw new Error("invalid_test_checkpoint");
  return value;
}

function persistedRecoveryCall(
  state: PersistedToolLoopCall["state"] = "pending"
): PersistedToolLoopCall {
  return {
    arguments: { value: "alpha" },
    completedAt: state === "complete" || state === "error" ? "2026-07-12T09:01:00.000Z" : null,
    id: "stored-call-1",
    mcpBinding: {
      id: "binding-1",
      runtimeGenerationFingerprint: recoveryFingerprint,
      runtimeGenerationId: "generation-1"
    },
    ordinal: 0,
    providerCallId: "provider-call-1",
    result: null,
    roundIndex: 1,
    startedAt: state === "pending" ? null : "2026-07-12T09:00:30.000Z",
    state,
    toolName: recoveryToolName
  };
}

function checkpointedRun(input: Readonly<{
  answerRoundUsage?: readonly PersistedAnswerRoundUsage[];
  calls?: readonly PersistedToolLoopCall[];
  phase: "provider_running" | "tools_pending" | "tools_running";
  providerResponseId?: string | null;
  providerToolMessages?: ToolLoopJsonValue[];
  roundIndex?: number;
}>): CheckpointedToolLoopRun {
  const continuation = {
    providerResponseId: input.providerResponseId ?? "response-tool-1",
    providerToolMessages: input.providerToolMessages ?? [{
      arguments: "{\"value\":\"alpha\"}",
      call_id: "provider-call-1",
      name: recoveryToolName,
      type: "function_call"
    }]
  } satisfies ToolLoopJsonValue;
  return {
    assistantMessageId: "assistant-1",
    assistantText: "",
    calls: [...(input.calls ?? [])],
    chatId: "chat-1",
    checkpoint: checkpoint(
      input.phase,
      input.roundIndex ?? 1,
      continuation,
      input.answerRoundUsage
    ),
    id: runId,
    modelId: "gpt-test",
    normalizedRequest: normalizedToolRequest(),
    provider: "openai",
    providerResponseId: input.providerResponseId ?? null,
    status: "streaming",
    userId
  };
}

function installCheckpointState(
  harness: ReturnType<typeof createHarness>,
  initial: CheckpointedToolLoopRun,
  persistedUsage: PersistedRunUsageAttribution[] = []
) {
  let currentCheckpoint = initial.checkpoint;
  let calls = initial.calls.map((call) => ({ ...call }));
  harness.setStoredRun({
    providerResponseId: initial.providerResponseId,
    recoverySettled: false,
    status: initial.status
  });
  harness.repository.loadCheckpointedToolLoopRun = async () => ({
    ...initial,
    calls,
    checkpoint: currentCheckpoint
  });
  harness.repository.loadRunUsageAttributions = async () => persistedUsage;
  const recordRunUsageEvents = harness.repository.recordRunUsageEvents;
  harness.repository.recordRunUsageEvents = async (input) => {
    if (input.answerRoundUsage) {
      const next = upsertAnswerRoundUsage(currentCheckpoint, input.answerRoundUsage);
      if (!next) return false;
      currentCheckpoint = next;
    }
    return recordRunUsageEvents(input);
  };
  harness.repository.loadAttachments = async () => [];
  harness.repository.claimToolLoopCall = async ({ callId }) => {
    const call = calls.find((candidate) => candidate.id === callId);
    if (!call) return { kind: "not_found" };
    if (call.state === "running") return { call, kind: "ambiguous" };
    if (call.state === "cancelled") return { call, kind: "cancelled" };
    if (call.state === "complete" || call.state === "error") {
      return { call, kind: "settled" };
    }
    const claimed = {
      ...call,
      startedAt: "2026-07-12T09:00:30.000Z",
      state: "running" as const
    };
    calls = calls.map((candidate) => candidate.id === call.id ? claimed : candidate);
    currentCheckpoint = checkpoint(
      "tools_running",
      currentCheckpoint.roundIndex,
      currentCheckpoint.providerContinuation,
      currentCheckpoint.version === 2 ? currentCheckpoint.answerRoundUsage : undefined
    );
    return { call: claimed, kind: "claimed" };
  };
  harness.repository.settleToolLoopCall = async ({ callId, result, state }) => {
    const call = calls.find((candidate) => candidate.id === callId);
    if (!call) return "not_found";
    calls = calls.map((candidate) => candidate.id === callId
      ? {
          ...candidate,
          completedAt: "2026-07-12T09:01:00.000Z",
          result,
          state
        }
      : candidate);
    return "settled";
  };
  harness.repository.persistToolLoopCallBatch = async (input) => {
    const existing = calls.filter((call) => call.roundIndex === input.roundIndex);
    if (existing.length > 0) return { calls: existing, kind: "reused" };
    const created = input.calls.map((call, index): PersistedToolLoopCall => ({
      arguments: call.arguments,
      completedAt: null,
      id: `stored-call-${input.roundIndex}-${index}`,
      mcpBinding: call.runtimeGenerationFingerprint
        ? {
            id: "binding-1",
            runtimeGenerationFingerprint: call.runtimeGenerationFingerprint,
            runtimeGenerationId: "generation-1"
          }
        : null,
      ordinal: call.ordinal,
      providerCallId: call.providerCallId,
      result: null,
      roundIndex: input.roundIndex,
      startedAt: null,
      state: "pending",
      toolName: call.toolName
    }));
    calls = [...calls, ...created];
    currentCheckpoint = checkpoint(
      "tools_pending",
      input.roundIndex,
      input.providerContinuation,
      currentCheckpoint.version === 2 ? currentCheckpoint.answerRoundUsage : undefined
    );
    return { calls: created, kind: "persisted" };
  };
  harness.repository.resetToolLoopAssistantDraft = async () => true;
  harness.repository.advanceToolLoopCallBatch = async ({ roundIndex }) => {
    const current = calls.filter((call) => call.roundIndex === roundIndex);
    if (current.some((call) => call.state !== "complete" && call.state !== "error")) {
      return "incomplete";
    }
    currentCheckpoint = checkpoint(
      "provider_running",
      roundIndex + 1,
      currentCheckpoint.providerContinuation,
      currentCheckpoint.version === 2 ? currentCheckpoint.answerRoundUsage : undefined
    );
    harness.setStoredRun({ providerResponseId: null });
    return "advanced";
  };
  harness.repository.updateRunProviderRequestPreview = async () => undefined;

  return {
    calls: () => calls,
    checkpoint: () => currentCheckpoint
  };
}

describe("run recovery", () => {
  beforeEach(() => {
    resetBootOrphanSweepForTest(new Date("2026-07-12T10:00:00.000Z"));
  });

  it("recovers installation-wide resumable runs without waiting for an owner request", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      providerResponseId: "response-old",
      status: "in_progress",
      terminal: false
    }));
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) }
    });
    const installationQueries: unknown[] = [];
    harness.repository.findInstallationRecoverableRuns = async (input) => {
      installationQueries.push(input);
      return [{
        ...staleControl({ updatedAt: new Date("2026-07-12T09:59:59.000Z") }),
        userId
      }];
    };

    await reconcileInstallationRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:01.000Z")
    });

    expect(harness.state.sweeps).toEqual([[]]);
    expect(installationQueries).toEqual([
      expect.objectContaining({
        bootedBefore: new Date("2026-07-12T10:00:00.000Z"),
        limit: 100
      })
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("settles installation-wide PREPARING rows without resolving a provider", async () => {
    const refresh = vi.fn();
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) }
    });
    harness.repository.findInstallationRecoverableRuns = async () => [{
      ...staleControl({
        providerResponseId: null,
        status: "preparing",
        updatedAt: new Date("2026-07-12T09:00:00.000Z")
      }),
      userId
    }];
    const now = new Date("2026-07-12T10:00:01.000Z");

    await reconcileInstallationRuns(harness.deps, { now });

    expect(harness.state.preparingRecoveries).toEqual([{ now, runId, userId }]);
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
  });

  it("sweeps boot-orphaned runs once with the injected live-run ids", async () => {
    const harness = createHarness({ liveRunIds: ["run-live-1", "run-live-2"] });
    const secondRepository = createHarness({ liveRunIds: ["run-other"] });

    await Promise.all([
      sweepBootOrphanedRunsOnce(harness.deps),
      sweepBootOrphanedRunsOnce(harness.deps),
      sweepBootOrphanedRunsOnce(secondRepository.deps)
    ]);
    await sweepBootOrphanedRunsOnce(harness.deps);

    expect(harness.state.sweeps).toEqual([["run-live-1", "run-live-2"]]);
    expect(secondRepository.state.sweeps).toEqual([]);
  });

  it("retries the one-time boot sweep after a rejected attempt", async () => {
    const harness = createHarness();
    let attempts = 0;
    harness.repository.sweepBootOrphanedRuns = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("boot_sweep_failed");
      }

      return 0;
    };

    await expect(sweepBootOrphanedRunsOnce(harness.deps)).rejects.toThrow("boot_sweep_failed");
    await expect(sweepBootOrphanedRunsOnce(harness.deps)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("refreshes and finalizes before appending provider, usage, and done events", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [providerEvent],
      providerResponseId: "response-new",
      result: providerResult,
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledWith("response-old");
    expect(harness.state.providerResponseIds).toEqual([
      {
        providerResponseId: "response-new",
        runId
      }
    ]);
    expect(harness.state.completed).toMatchObject({
      assistantMessageId: "assistant-1",
      estimatedCostMicros: 80,
      providerResponseId: "response-new",
      runId,
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        estimatedCostMicros: 80,
        inputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 5
      },
      userId
    });
    expect(harness.state.operations).toEqual(["update_response_id", "complete"]);
    expect(harness.state.events.map(({ event, sequence }) => ({ sequence, type: event.type }))).toEqual([
      { sequence: 0, type: "artifact" },
      { sequence: 1, type: "usage" },
      { sequence: 2, type: "done" }
    ]);
  });

  it("fails recovery with attributable usage instead of finalizing an intermediate tool-call response", async () => {
    const intermediateResult: ProviderRunResult = {
      finalProviderResponsePreview: {
        id: "response-tool-call",
        status: "completed"
      },
      finalText: "",
      providerResponseId: "response-tool-call",
      toolCalls: [
        {
          arguments: { query: "current information" },
          id: "call-1",
          name: "search_via_perplexity"
        }
      ],
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 9
      }
    };
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(async () => ({
          events: [providerEvent],
          providerResponseId: "response-tool-call",
          result: intermediateResult,
          status: "completed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.completed).toBeNull();
    expect(harness.state.failed).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "tool_loop_recovery_required",
          message: "The provider response contains outstanding tool calls and cannot be finalized as an answer. Retry the run."
        },
        runId
      }
    ]);
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "tool_loop_recovery_required",
          message: "The provider response contains outstanding tool calls and cannot be finalized as an answer. Retry the run."
        },
        events: [providerEvent],
        providerResponseId: "response-tool-call",
        runId,
        usageAttributions: [
          {
            estimatedCostMicros: 110,
            modelId: "gpt-test",
            provider: "openai",
            usage: {
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              inputTokens: 7,
              outputTokens: 2,
              reasoningTokens: 1,
              totalTokens: 9
            }
          }
        ],
        userId
      })
    ]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact", "error"]);
  });

  it("does not append terminal refresh events when another writer wins completion", async () => {
    const harness = createHarness({
      completeRun: false,
      providers: {
        openai: providerWithRefresh(async () => ({
          events: [providerEvent],
          result: providerResult,
          status: "completed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.operations).toEqual(["update_response_id", "complete"]);
    expect(harness.state.events).toEqual([]);
  });

  it("stops settlement when cancellation changes status after provider refresh", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [providerEvent],
      result: providerResult,
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [control(), control({ status: "cancelled" })],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.providerResponseIds).toEqual([]);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.events).toEqual([]);
  });

  it("appends non-terminal refresh events with sequence-collision retry", async () => {
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(async () => ({
          events: [providerEvent],
          providerResponseId: "response-next",
          status: "in_progress",
          terminal: false
        }))
      }
    });
    harness.collideNextAppend();

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.appendAttempts.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(harness.state.events).toEqual([
      {
        event: providerEvent,
        runId,
        sequence: 1
      }
    ]);
    expect(harness.state.providerResponseIds).toEqual([
      {
        providerResponseId: "response-next",
        runId
      }
    ]);
  });

  it("persists refresh failures only while the latest run is active", async () => {
    const provider = providerWithRefresh(async () => {
      throw new Error("provider unavailable");
    });
    const activeHarness = createHarness({ providers: { openai: provider } });

    await refreshProviderRunIfNeeded(activeHarness.deps, runId, userId);

    expect(activeHarness.state.failed).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "provider_refresh_failed",
          message: "provider unavailable"
        },
        runId
      }
    ]);
    expect(activeHarness.state.events.map(({ event }) => event)).toEqual([
      {
        data: {
          code: "provider_refresh_failed",
          message: "provider unavailable"
        },
        type: "error"
      }
    ]);

    const cancelledHarness = createHarness({
      controls: [control(), control({ status: "cancelled" })],
      providers: { openai: provider }
    });
    await refreshProviderRunIfNeeded(cancelledHarness.deps, runId, userId);
    expect(cancelledHarness.state.failed).toEqual([]);
    expect(cancelledHarness.state.events).toEqual([]);
  });

  it("persists terminal provider errors after refreshed events only for active runs", async () => {
    const providerError = {
      code: "provider_terminal_error",
      message: "Provider stopped"
    };
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(async () => ({
          error: providerError,
          events: [providerEvent],
          status: "failed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.operations).toEqual([
      "settle_recovered:provider_terminal_error"
    ]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact", "error"]);
  });

  it("does not append a recovery error when completion wins the failure CAS", async () => {
    const harness = createHarness({
      settleRecoveredRunError: false,
      providers: {
        openai: providerWithRefresh(async () => ({
          error: {
            code: "provider_terminal_error",
            message: "Provider stopped"
          },
          events: [providerEvent],
          status: "failed",
          terminal: true
        }))
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(harness.state.failed).toEqual([]);
    expect(harness.state.operations).toEqual([]);
    expect(harness.state.events).toEqual([]);
  });

  it("coalesces concurrent refreshes by run id before one terminal settlement", async () => {
    const started = deferred();
    const release = deferred();
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => {
      started.resolve();
      await release.promise;
      return {
        error: {
          code: "provider_terminal_error",
          message: "Provider stopped"
        },
        events: [providerEvent],
        status: "failed",
        terminal: true
      };
    });
    const harness = createHarness({
      controls: [control({ status: "error" })],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    const first = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await started.promise;
    const second = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    release.resolve();
    await Promise.all([first, second]);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.recoveredErrors).toHaveLength(1);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual([
      "artifact",
      "error"
    ]);
  });

  it("does not refresh a definitively settled recovery error again", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      error: {
        code: "provider_terminal_error",
        message: "Provider stopped"
      },
      events: [providerEvent],
      status: "failed",
      terminal: true
    }));
    const harness = createHarness({
      controls: [
        control({ status: "error" }),
        control({ status: "error" }),
        control({ status: "error" }),
        control({ recoverySettled: true, status: "error" })
      ],
      providers: {
        openai: providerWithRefresh(refresh)
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.recoveredErrors).toHaveLength(1);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual([
      "artifact",
      "error"
    ]);
  });

  it("does not block recovery for a different run while one provider read is pending", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const firstHarness = createHarness({
      providers: {
        openai: providerWithRefresh(async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return {
            error: { code: "first_failed", message: "First failed" },
            events: [],
            status: "failed",
            terminal: true
          };
        })
      }
    });
    const secondHarness = createHarness({
      providers: {
        openai: providerWithRefresh(async () => ({
          error: { code: "second_failed", message: "Second failed" },
          events: [],
          status: "failed",
          terminal: true
        }))
      }
    });

    const first = refreshProviderRunIfNeeded(
      firstHarness.deps,
      "run-pending-a",
      userId
    );
    await firstStarted.promise;
    await refreshProviderRunIfNeeded(
      secondHarness.deps,
      "run-independent-b",
      userId
    );

    expect(secondHarness.state.recoveredErrors).toHaveLength(1);
    expect(firstHarness.state.recoveredErrors).toHaveLength(0);
    releaseFirst.resolve();
    await first;
    expect(firstHarness.state.recoveredErrors).toHaveLength(1);
  });

  it("skips refresh and stale reconciliation for locally owned foreground runs", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      status: "in_progress",
      terminal: false
    }));
    const harness = createHarness({
      liveRunIds: [runId],
      providers: {
        openai: providerWithRefresh(refresh)
      },
      staleRuns: [staleControl()]
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await reconcileStaleRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:00.000Z"),
      userId
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
    expect(harness.state.events).toEqual([]);
  });

  it("marks stale non-refreshable runs orphaned using the shared freshness threshold", async () => {
    const now = new Date("2026-07-12T10:00:00.000Z");
    const harness = createHarness({
      staleRuns: [
        staleControl({
          provider: "anthropic",
          providerResponseId: null
        })
      ]
    });

    await reconcileStaleRuns(harness.deps, {
      chatId: "chat-1",
      now,
      runId,
      userId
    });

    expect(harness.state.staleQueries).toEqual([
      {
        chatId: "chat-1",
        runId,
        staleBefore: new Date(now.getTime() - activeRunStaleMs),
        userId
      }
    ]);
    expect(harness.state.failed).toEqual([
      {
        assistantMessageId: "assistant-1",
        error: {
          code: "run_orphaned",
          message: "Run stopped reporting progress and was marked failed."
        },
        runId
      }
    ]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["error"]);
  });

  it("routes stale PREPARING rows only to their owned-attempt recovery", async () => {
    const refresh = vi.fn();
    const now = new Date("2026-07-12T10:00:00.000Z");
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) },
      staleRuns: [staleControl({ providerResponseId: null, status: "preparing" })]
    });

    await reconcileStaleRuns(harness.deps, { now, userId });

    expect(harness.state.preparingRecoveries).toEqual([{ now, runId, userId }]);
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.failed).toEqual([]);
  });

  it("delegates refreshable stale runs to provider recovery", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [providerEvent],
      status: "in_progress",
      terminal: false
    }));
    const harness = createHarness({
      providers: {
        openai: providerWithRefresh(refresh)
      },
      staleRuns: [staleControl()]
    });

    await reconcileStaleRuns(harness.deps, {
      now: new Date("2026-07-12T10:00:00.000Z"),
      userId
    });

    expect(refresh).toHaveBeenCalledWith("response-old");
    expect(harness.state.failed).toEqual([]);
    expect(harness.state.events.map(({ event }) => event.type)).toEqual(["artifact"]);
  });

  it.each([
    { providerResponseId: "response-fresh", variant: "with a provider response id" },
    { providerResponseId: undefined, variant: "without a provider response id" }
  ])("completes a recoverable error-status tool round $variant", async ({
    providerResponseId
  }) => {
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: { status: "completed" },
          finalText: "Recovered fresh answer",
          ...(providerResponseId ? { providerResponseId } : {}),
          usage: { inputTokens: 6, outputTokens: 4, reasoningTokens: 1 }
        };
      }
    };
    const harness = createHarness({
      controls: [control({
        providerResponseId: "response-tool-1",
        recoverySettled: false,
        status: "error"
      })],
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [persistedRecoveryCall()],
        phase: "tools_pending",
        providerResponseId: "response-tool-1"
      }),
      status: "error"
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered fresh answer",
      providerResponseId,
      usage: { inputTokens: 6, outputTokens: 4, reasoningTokens: 1, totalTokens: 10 }
    });
    expect(harness.state.run).toEqual({
      providerResponseId: providerResponseId ?? null,
      recoverySettled: false,
      status: "complete"
    });
    expect(harness.state.providerResponseIds).toEqual(providerResponseId
      ? [{ providerResponseId, runId }]
      : []);
    expect(harness.state.usageAttributions.flat()).toEqual([
      expect.objectContaining({
        modelId: "gpt-test",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 6, outputTokens: 4, reasoningTokens: 1 })
      })
    ]);
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("attributes a finished round when cancellation wins response-id publication", async () => {
    const cancel = vi.fn(async () => ({}));
    let harness!: ReturnType<typeof createHarness>;
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      cancel,
      async *stream() {
        harness.setStoredRun({ status: "cancelled" });
        return {
          finalProviderResponsePreview: { status: "completed" },
          finalText: "Late answer",
          providerResponseId: "response-late",
          usage: { inputTokens: 8, outputTokens: 5, reasoningTokens: 0 }
        };
      }
    };
    harness = createHarness({
      controls: [control({ recoverySettled: false, status: "error" })],
      mcpRuntime: {
        callTool: async () => ({
          isError: false,
          structuredContent: null,
          text: ["remembered"],
          unsupportedContentTypes: []
        }),
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" }),
      status: "error"
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(cancel).toHaveBeenCalledWith("response-late");
    expect(harness.state.providerResponseIds).toEqual([]);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.run.status).toBe("cancelled");
    expect(harness.state.usageAttributions.flat()).toEqual([
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 8, outputTokens: 5 })
      })
    ]);
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("continues a checkpointed OpenAI background tool round from its response id", async () => {
    const requests: ProviderRunRequest[] = [];
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      refresh: async () => ({
        events: [providerEvent],
        providerResponseId: "response-tool-1",
        result: {
          finalProviderResponsePreview: { id: "response-tool-1" },
          finalText: "",
          providerResponseId: "response-tool-1",
          providerToolCallMessage: [{
            arguments: "{\"value\":\"alpha\"}",
            call_id: "provider-call-1",
            name: recoveryToolName,
            type: "function_call"
          }],
          toolCalls: [{
            arguments: { value: "alpha" },
            id: "provider-call-1",
            name: recoveryToolName
          }],
          usage: { inputTokens: 5, outputTokens: 1, reasoningTokens: 0 }
        },
        status: "completed",
        terminal: true
      }),
      async *stream(request) {
        requests.push(request);
        return {
          finalProviderResponsePreview: { id: "response-final" },
          finalText: "Recovered final answer",
          providerResponseId: "response-final",
          usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      controls: [control({ providerResponseId: "response-tool-1" })],
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const durable = checkpointedRun({
      phase: "provider_running",
      providerResponseId: "response-tool-1",
      providerToolMessages: []
    });
    const installed = installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({
      inputSchema: { type: "object" },
      name: "remember"
    }));
    expect(installed.calls()).toEqual([
      expect.objectContaining({ result: expect.any(Object), state: "complete" })
    ]);
    expect(harness.state.events.map(({ event }) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "tool_call",
          payload: expect.objectContaining({ callId: "provider-call-1", ordinal: 0 })
        }),
        type: "artifact"
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "tool_result",
          payload: expect.objectContaining({
            callId: "provider-call-1",
            ordinal: 0,
            status: "complete"
          })
        }),
        type: "artifact"
      })
    ]));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(requests[0]).toMatchObject({ parallelToolCalls: true });
    expect(requests[0]?.providerToolMessages).toEqual([
      {
        arguments: "{\"value\":\"alpha\"}",
        call_id: "provider-call-1",
        name: recoveryToolName,
        type: "function_call"
      },
      {
        call_id: "provider-call-1",
        output: "remembered",
        type: "function_call_output"
      }
    ]);
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered final answer",
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 }
    });
  });

  it.each([
    { code: "mcp_initialize_response_too_large", operation: "initialize" },
    { code: "mcp_inventory_response_too_large", operation: "list_tools" },
    { code: "mcp_call_result_too_large", operation: "call_tool" },
    { code: "mcp_response_too_large", operation: "session" }
  ] as const)("keeps recovered $code evidence and provider output free of overflow data", async ({
    code,
    operation
  }) => {
    const argumentMarker = `private-recovery-argument-${code}`;
    const prohibitedMarkers = {
      body: `private-recovery-body-${code}`,
      credential: `private-recovery-credential-${code}`,
      endpoint: `private-recovery-endpoint-${code}`,
      headers: `private-recovery-headers-${code}`,
      parserDetail: `private-recovery-parser-detail-${code}`,
      partialResult: `private-recovery-partial-result-${code}`
    };
    const canonicalArguments = { password: argumentMarker, value: "alpha" };
    const overflow = new McpClientSessionError({ code, operation });
    for (const [key, value] of Object.entries(prohibitedMarkers)) {
      Object.defineProperty(overflow, key, { enumerable: true, value });
    }

    const requests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        requests.push(request);
        return {
          finalProviderResponsePreview: { id: "response-after-overflow" },
          finalText: "Recovered after safe tool failure",
          providerResponseId: "response-after-overflow",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const runtimeCall = vi.fn(async () => {
      throw overflow;
    });
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const persistedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: canonicalArguments
    };
    const checkpointState = installCheckpointState(harness, checkpointedRun({
      calls: [persistedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: JSON.stringify(canonicalArguments),
        call_id: "provider-call-1",
        name: recoveryToolName,
        type: "function_call"
      }]
    }));

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({
      arguments: canonicalArguments,
      name: "remember"
    }));
    const [settledCall] = checkpointState.calls();
    expect(settledCall).toMatchObject({
      arguments: canonicalArguments,
      state: "error"
    });
    expect(settledCall?.result).toMatchObject({
      callId: "provider-call-1",
      content: [{ text: `Tool failed: ${overflow.message}`, type: "text" }],
      name: recoveryToolName,
      rawPreview: {
        finalProviderResponsePreview: { code, error: overflow.message },
        requestPreview: {
          toolCall: { id: "provider-call-1", name: recoveryToolName }
        }
      },
      status: "error",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      }
    });
    const settledResult = JSON.stringify(settledCall?.result);
    expect(settledResult).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(settledResult).not.toContain(marker);
    }

    const events = harness.state.events.map(({ event }) => event);
    const toolResultEvent = events.find((event) =>
      event.type === "artifact" && event.data.artifactType === "tool_result"
    );
    expect(toolResultEvent).toMatchObject({
      data: { payload: { message: overflow.message, status: "error" } }
    });
    expect(JSON.stringify(toolResultEvent)).not.toContain(argumentMarker);
    expect(JSON.stringify(events)).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(JSON.stringify(events)).not.toContain(marker);
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.providerToolMessages).toEqual([
      {
        arguments: JSON.stringify(canonicalArguments),
        call_id: "provider-call-1",
        name: recoveryToolName,
        type: "function_call"
      },
      {
        call_id: "provider-call-1",
        output: `Tool failed: ${overflow.message}`,
        type: "function_call_output"
      }
    ]);
    const providerOutput = JSON.stringify(requests[0]?.providerToolMessages?.[1]);
    expect(providerOutput).not.toContain(argumentMarker);
    for (const marker of Object.values(prohibitedMarkers)) {
      expect(JSON.stringify(requests)).not.toContain(marker);
    }
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered after safe tool failure"
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("appends a recovered provider delta to durable pre-crash assistant text", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [{ data: { delta: "recovered" }, type: "token" }],
      providerResponseId: "response-tool-1",
      status: "in_progress",
      terminal: false
    }));
    const adapter = providerWithRefresh(refresh);
    const harness = createHarness({
      controls: [control({
        providerResponseId: "response-tool-1",
        recoverySettled: false,
        status: "error"
      })],
      providers: { openai: adapter }
    });
    const durable = {
      ...checkpointedRun({
        phase: "provider_running",
        providerResponseId: "response-tool-1",
        providerToolMessages: []
      }),
      assistantText: "durable ",
      status: "error" as const
    };
    installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.assistantTexts).toEqual(["durable recovered"]);
    expect(harness.state.assistantAppendOptions).toEqual([{ allowErrored: true }]);
    expect(harness.state.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: { data: { delta: "recovered" }, type: "token" }
      })
    ]));
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("keeps a published-response safety failure terminal across later refresh requests", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let answerRounds = 0;
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        answerRounds += 1;
        yield { data: { delta: "recovered partial" }, type: "token" };
        yield {
          data: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0 },
          type: "usage"
        };
        throw new ProviderStreamTooLargeError({
          maxBytes: 512,
          observedBytes: 513,
          snapshot: { durationMs: 88, totalStreamBytes: 513 }
        });
      }
    };
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: ["remembered"],
      unsupportedContentTypes: []
    }));
    const harness = createHarness({
      controls: [
        control({ providerResponseId: "response-tool-1" }),
        control({
          providerResponseId: "response-tool-1",
          recoverySettled: true,
          status: "error"
        })
      ],
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      pricingError: new Error("pricing_lookup_unavailable"),
      providers: { openai: adapter }
    });
    const durable = checkpointedRun({
      calls: [persistedRecoveryCall()],
      phase: "tools_pending",
      providerResponseId: "response-tool-1"
    });
    installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(answerRounds).toBe(1);
    expect(harness.state.assistantTexts).toEqual(["recovered partial"]);
    expect(harness.state.assistantAppendOptions).toEqual([{ allowErrored: true }]);
    expect(harness.state.recoveredErrors).toHaveLength(1);
    expect(harness.state.recoveredErrors[0]).toMatchObject({
      error: {
        code: "provider_stream_too_large",
        message: "The provider stream exceeded a safety limit."
      },
      runId,
      usageAttributions: [{
        modelId: "gpt-test",
        provider: "openai",
        usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0 }
      }]
    });
    expect(harness.state.recoveredErrors[0]).not.toHaveProperty("providerResponseId");
    expect(harness.state.completed).toBeNull();
    expect(harness.state.events.map(({ event }) => event.type)).not.toContain("done");
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      code: "provider_stream_too_large",
      durationMs: 88,
      limit: 512,
      observed: 513,
      termination: "total_limit",
      totalStreamBytes: 513
    });
    warning.mockRestore();
  });

  it("fails grounded live-only checkpoint recovery before contacting the provider", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      status: "in_progress",
      terminal: false
    }));
    const adapter = providerWithRefresh(refresh);
    const stream = vi.spyOn(adapter, "stream");
    const harness = createHarness({
      controls: [control({ providerResponseId: "response-tool-1" })],
      providers: { openai: adapter }
    });
    const durable = {
      ...checkpointedRun({
        phase: "provider_running",
        providerResponseId: "response-tool-1"
      }),
      assistantText: null
    };
    installCheckpointState(harness, durable);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.assistantTexts).toEqual([]);
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "grounding_live_only_not_recoverable",
          message: "Grounded live-only output cannot resume after process recovery."
        },
        runId
      })
    ]);
  });

  it("recovers a persisted pre-release Search tool name through its pinned logical source", async () => {
    const legacyToolName = "search_1_openai_native_web_search";
    const answerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered sourced answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [],
          finalProviderResponsePreview: {
            sources: [{ title: "Source", url: "https://example.test/source" }]
          },
          findings: "Recovered findings",
          requestPreview: {},
          sources: [{ rank: 1, title: "Source", url: "https://example.test/source" }],
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: {
        openai: answerAdapter,
        openai_compatible: answerAdapter
      },
      searchProviders: { openai_compatible: searchAdapter }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "latest verified news" },
      mcpBinding: null,
      toolName: legacyToolName
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"latest verified news\"}",
        call_id: "provider-call-1",
        name: legacyToolName,
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: normalizedLegacySearchRequest()
    }, [{
      modelId: "search-model",
      provider: "openai_compatible",
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 0 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "latest verified news",
      searchPolicy: {
        modelId: "search-model",
        provider: "openai_compatible",
        strategyId: "openai-responses-web-search"
      },
      strategyId: "openai-native-web-search"
    });
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      searchRevisionId: "search-revision-1",
      strategyId: "openai-native-web-search"
    }));
    expect(answerRequests).toHaveLength(1);
    expect(answerRequests[0]?.providerToolMessages).toEqual([
      expect.objectContaining({ name: legacyToolName, type: "function_call" }),
      expect.objectContaining({ output: expect.stringContaining("Recovered findings") })
    ]);
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered sourced answer",
      usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: "search-model",
        provider: "openai_compatible",
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 6 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("recovers a pending Gemini client Search without repeating settled answer context", async () => {
    const answerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered cross-provider answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({ store: false }),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [],
          finalProviderResponsePreview: {
            searchSuggestionsHtml: "<div>RECOVERY_RAW_SUGGESTIONS_CANARY</div>",
            thoughtSignature: "RECOVERY_RAW_SIGNATURE_CANARY"
          },
          findings: "Recovered Gemini findings",
          requestPreview: { queryCharacters: request.query.length, store: false },
          sources: [{
            rank: 1,
            title: "Recovered Gemini source",
            url: "https://example.test/recovered-gemini"
          }],
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { gemini: answerAdapter, openai: answerAdapter },
      searchProviders: { gemini: searchAdapter }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const option = {
      ...normalizedLegacySearchRequest().searchPlan!.options[0]!,
      config: {
        ...normalizedLegacySearchRequest().searchPlan!.options[0]!.config,
        maxOutputTokens: 4_096,
        maxSearchCallsPerAnswer: 2,
        reasoningPolicy: "lowest_supported"
      },
      displayName: "Google Search",
      modelId: "gemini-3.6-flash",
      optionId: "gemini-google-search",
      protocol: "gemini_google_search" as const,
      provider: "gemini",
      providerModelId: "gemini-search-deployment",
      revisionId: "gemini-search-revision-1",
      searchStrategyRowId: "gemini-search-client-route"
    };
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "weather in Valencia" },
      mcpBinding: null,
      toolName: "search_engine_1"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"weather in Valencia\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...normalizedLegacySearchRequest(),
        searchPlan: { mode: "model_choice", options: [option] },
        searchStrategy: "gemini-google-search"
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "weather in Valencia",
      searchPolicy: {
        modelId: "gemini-3.6-flash",
        provider: "gemini",
        reasoningPolicy: "lowest_supported",
        strategyId: "gemini-google-search"
      },
      strategyId: "gemini-google-search"
    });
    expect(JSON.stringify(searchRequests[0])).not.toContain("Recovered cross-provider answer");
    expect(answerRequests).toHaveLength(1);
    expect(answerRequests[0]?.providerToolMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.stringContaining("Recovered Gemini findings") })
    ]));
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({
        findings: "Recovered Gemini findings",
        sources: [{
          rank: 1,
          title: "Recovered Gemini source",
          url: "https://example.test/recovered-gemini"
        }]
      }),
      modelId: "gemini-3.6-flash",
      provider: "gemini",
      query: "weather in Valencia",
      searchRevisionId: "gemini-search-revision-1",
      strategyId: "gemini-google-search"
    }));
    const durable = JSON.stringify(createSearchRun.mock.calls);
    expect(durable).not.toContain("RECOVERY_RAW_SUGGESTIONS_CANARY");
    expect(durable).not.toContain("RECOVERY_RAW_SIGNATURE_CANARY");
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered cross-provider answer",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 }
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("recovers a pending Anthropic client Search with normalized evidence and exact usage", async () => {
    const answerRequests: ProviderRunRequest[] = [];
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered answer from Anthropic evidence",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: (request) => ({
        modelId: request.searchPolicy.modelId,
        protocol: "anthropic_web_search",
        queryCharacters: request.query.length
      }),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [{
            data: {
              artifactType: "search",
              payload: {
                action: { queries: [request.query], type: "search" },
                encrypted_content: "RECOVERY_ENCRYPTED_CONTENT_CANARY",
                encrypted_index: "RECOVERY_ENCRYPTED_INDEX_CANARY",
                id: "srvtoolu_recovery_1",
                provider: "anthropic",
                rawResultBody: "RECOVERY_RAW_RESULT_CANARY",
                status: "completed",
                type: "web_search_call",
                webSearchRequests: 2
              }
            },
            type: "artifact"
          }],
          finalProviderResponsePreview: {
            encrypted_content: "RECOVERY_ENCRYPTED_CONTENT_CANARY",
            encrypted_index: "RECOVERY_ENCRYPTED_INDEX_CANARY",
            rawResultBody: "RECOVERY_RAW_RESULT_CANARY"
          },
          findings: "Recovered Anthropic findings",
          requestPreview: {
            modelId: "claude-opus-5",
            queryCharacters: request.query.length,
            tool: "web_search_20250305"
          },
          sources: [{
            rank: 1,
            title: "Recovered Anthropic source",
            url: "https://example.test/recovered-anthropic"
          }],
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 1 }
        };
      }
    };
    const harness = createHarness({
      providers: { anthropic: answerAdapter, openai: answerAdapter },
      searchProviders: { anthropic: searchAdapter }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "latest Anthropic evidence" },
      mcpBinding: null,
      toolName: "search_engine_1"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"latest Anthropic evidence\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }]
    });
    const checkpointState = installCheckpointState(harness, {
      ...base,
      normalizedRequest: normalizedAnthropicSearchRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "latest Anthropic evidence",
      searchPolicy: {
        maxOutputTokens: 4_096,
        modelId: "claude-opus-5",
        provider: "anthropic",
        reasoningPolicy: "lowest_supported",
        strategyId: "anthropic-web-search"
      },
      strategyId: "anthropic-web-search"
    });
    expect(answerRequests).toHaveLength(1);
    expect(answerRequests[0]?.providerToolMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: expect.stringContaining("Recovered Anthropic findings") })
    ]));
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({
        findings: "Recovered Anthropic findings",
        providerOperations: [expect.objectContaining({
          id: "srvtoolu_recovery_1",
          kind: "search",
          status: "complete"
        })],
        providerUsage: { webSearchRequests: 2 },
        sources: [{
          rank: 1,
          title: "Recovered Anthropic source",
          url: "https://example.test/recovered-anthropic"
        }]
      }),
      modelId: "claude-opus-5",
      provider: "anthropic",
      query: "latest Anthropic evidence",
      searchRevisionId: "anthropic-search-revision-1",
      strategyId: "anthropic-web-search"
    }));
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered answer from Anthropic evidence",
      usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 1, totalTokens: 8 },
      usageAttributions: expect.arrayContaining([
        expect.objectContaining({
          modelId: "gpt-test",
          provider: "openai",
          usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3 })
        }),
        expect.objectContaining({
          modelId: "claude-opus-5",
          provider: "anthropic",
          usage: expect.objectContaining({ inputTokens: 1, outputTokens: 2 })
        })
      ])
    });
    const durable = JSON.stringify({
      checkpointCalls: checkpointState.calls(),
      completed: harness.state.completed,
      events: harness.state.events,
      searchRuns: createSearchRun.mock.calls
    });
    expect(durable).not.toContain("RECOVERY_ENCRYPTED_CONTENT_CANARY");
    expect(durable).not.toContain("RECOVERY_ENCRYPTED_INDEX_CANARY");
    expect(durable).not.toContain("RECOVERY_RAW_RESULT_CANARY");
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("recovers attachment-bearing Anthropic client Search without disclosing the attachment", async () => {
    const search = vi.fn<ProviderSearchAdapter["search"]>(async (request) => ({
      artifacts: [],
      finalProviderResponsePreview: {},
      findings: "Recovered attachment-safe findings",
      requestPreview: { queryCharacters: request.query.length },
      sources: [{
        rank: 1,
        title: "Recovered source",
        url: "https://example.test/recovered-attachment-search"
      }],
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 }
    }));
    const answerRequests: ProviderRunRequest[] = [];
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered with Search and a private attachment",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { anthropic: adapter, openai: adapter },
      searchProviders: {
        anthropic: { buildRequestPreview: () => ({}), search }
      }
    });
    const createSearchRun = vi.fn<RunRecoveryRepository["createSearchRun"]>();
    harness.repository.createSearchRun = createSearchRun;
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "public query with attachment" },
      mcpBinding: null,
      toolName: "search_engine_1"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"public query with attachment\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }]
    });
    const normalized = normalizedAnthropicSearchRequest();
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...normalized,
        attachmentIds: ["document-1"],
        content: {
          blocks: [
            ...normalized.content.blocks,
            { attachmentId: "document-1", type: "attachment" }
          ]
        }
      }
    });
    harness.repository.loadAttachments = async () => [{
      byteSize: 32,
      extractedText: "Private attachment evidence",
      fileName: "private.txt",
      id: "document-1",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      status: "ready",
      storageKey: "private/document-1"
    }];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "public query with attachment" }),
      expect.anything()
    );
    expect(JSON.stringify(search.mock.calls)).not.toContain("Private attachment evidence");
    expect(createSearchRun).toHaveBeenCalledWith(expect.objectContaining({
      artifacts: expect.objectContaining({
        findings: "Recovered attachment-safe findings"
      }),
      query: "public query with attachment",
      status: "complete",
      strategyId: "anthropic-web-search"
    }));
    expect(answerRequests).toHaveLength(1);
    expect(JSON.stringify(answerRequests[0]?.providerToolMessages))
      .toContain("Recovered attachment-safe findings");
    expect(JSON.stringify(answerRequests[0]?.providerToolMessages))
      .not.toContain("Private attachment evidence");
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered with Search and a private attachment"
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("compacts a large pending fan-out Search result before settling recovery", async () => {
    const answerRequests: ProviderRunRequest[] = [];
    const findingsByModel = new Map<string, string>();
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        answerRequests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered large fan-out answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        const modelId = request.searchPolicy.modelId;
        const findings = `${modelId}:${modelId.slice(-1).repeat(44_000)}`;
        findingsByModel.set(modelId, findings);
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings,
          requestPreview: { queryCharacters: request.query.length },
          sources: [{
            rank: 1,
            title: `Source ${modelId}`,
            url: `https://example.com/${modelId}`
          }],
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { openai: answerAdapter, openai_compatible: answerAdapter },
      searchProviders: { openai_compatible: searchAdapter }
    });
    const baseRequest = normalizedLegacySearchRequest();
    const baseOption = baseRequest.searchPlan!.options[0]!;
    const options = Array.from({ length: 3 }, (_, index) => ({
      ...baseOption,
      displayName: `Search ${index + 1}`,
      modelId: `search-model-${index + 1}`,
      optionId: `search-option-${index + 1}`,
      providerModelId: `search-model-row-${index + 1}`,
      revisionId: `search-revision-${index + 1}`,
      searchStrategyRowId: `search-strategy-row-${index + 1}`
    }));
    const storedCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "large recovery evidence" },
      mcpBinding: null,
      toolName: "search_selected_engines"
    };
    const base = checkpointedRun({
      calls: [storedCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"large recovery evidence\"}",
        call_id: "provider-call-1",
        name: "search_selected_engines",
        type: "function_call"
      }]
    });
    const checkpointState = installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...baseRequest,
        searchPlan: { mode: "all_selected", options }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(findingsByModel.size).toBe(3);
    expect(answerRequests).toHaveLength(1);
    const [settledCall] = checkpointState.calls();
    expect(settledCall?.state).toBe("complete");
    if (!settledCall?.result) throw new Error("expected settled large Search result");
    const serialized = JSON.stringify(settledCall.result);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      toolLoopPersistenceLimits.resultBytes
    );
    expect(serialized).toContain('"aiqsaType":"search_result"');
    for (const findings of findingsByModel.values()) {
      expect(serialized.split(findings)).toHaveLength(2);
    }
    const replayed = parsePersistedToolExecutionResult({
      id: settledCall.providerCallId,
      name: settledCall.toolName
    }, settledCall.result);
    expect(replayed?.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("search-model-1"),
        type: "text"
      })
    ]);
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("restores Search budgets per source and replays settled Search usage without duplicating it", async () => {
    const baseRequest = normalizedLegacySearchRequest();
    const baseOption = baseRequest.searchPlan!.options[0]!;
    const firstOption = {
      ...baseOption,
      config: { ...baseOption.config, maxSearchCallsPerAnswer: 1 },
      displayName: "First Search",
      modelId: "search-model-1",
      optionId: "search-option-1",
      providerModelId: "search-model-row-1",
      revisionId: "search-revision-1",
      searchStrategyRowId: "search-strategy-row-1"
    };
    const secondOption = {
      ...baseOption,
      config: { ...baseOption.config, maxSearchCallsPerAnswer: 1 },
      displayName: "Second Search",
      modelId: "search-model-2",
      optionId: "search-option-2",
      providerModelId: "search-model-row-2",
      revisionId: "search-revision-2",
      searchStrategyRowId: "search-strategy-row-2"
    };
    const settledExecution: SearchExecutionEvidence = {
      displayName: firstOption.displayName,
      durationMs: 10,
      findings: "already persisted findings",
      invocationId: "provider-call-1:search-option-1",
      modelId: firstOption.modelId,
      optionId: firstOption.optionId,
      provider: firstOption.provider,
      providerOperationsTruncated: false,
      query: "first source query",
      requestPreview: {},
      revisionId: firstOption.revisionId,
      sources: [{
        rank: 1,
        title: "First source",
        url: "https://example.com/first-source"
      }],
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    };
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: searchToolResultContent([settledExecution]),
      name: "search_engine_1",
      rawPreview: {
        finalProviderResponsePreview: {
          searchExecutions: [settledExecution]
        },
        providerCall: true,
        requestPreview: {},
        searchResultVersion: SEARCH_TOOL_RESULT_VERSION
      },
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_search_fixture");
    expect(JSON.stringify(settledResult).split("already persisted findings")).toHaveLength(2);
    const firstCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("complete"),
      arguments: { query: "first source query" },
      mcpBinding: null,
      result: settledResult,
      toolName: "search_engine_1"
    };
    const secondCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { query: "second source query" },
      id: "stored-call-2",
      mcpBinding: null,
      ordinal: 1,
      providerCallId: "provider-call-2",
      toolName: "search_engine_2"
    };
    const searchRequests: ProviderSearchRequest[] = [];
    const answerAdapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered with the second source",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const searchAdapter: ProviderSearchAdapter = {
      buildRequestPreview: () => ({}),
      async search(request) {
        searchRequests.push(request);
        return {
          artifacts: [],
          finalProviderResponsePreview: {},
          findings: "fresh second-source findings",
          requestPreview: {},
          sources: [{
            rank: 1,
            title: "Second source",
            url: "https://example.com/second-source"
          }],
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { openai: answerAdapter, openai_compatible: answerAdapter },
      searchProviders: { openai_compatible: searchAdapter }
    });
    const base = checkpointedRun({
      calls: [firstCall, secondCall],
      phase: "tools_pending",
      providerToolMessages: [{
        arguments: "{\"query\":\"first source query\"}",
        call_id: "provider-call-1",
        name: "search_engine_1",
        type: "function_call"
      }, {
        arguments: "{\"query\":\"second source query\"}",
        call_id: "provider-call-2",
        name: "search_engine_2",
        type: "function_call"
      }]
    });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...baseRequest,
        searchPlan: { mode: "model_choice", options: [firstOption, secondOption] }
      }
    }, [{
      modelId: "search-model-1",
      provider: "openai_compatible",
      recordedAt: "2026-07-12T09:02:00.000Z",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]).toMatchObject({
      query: "second source query",
      searchPolicy: { modelId: "search-model-2", provider: "openai_compatible" }
    });
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered with the second source",
      usage: { inputTokens: 9, outputTokens: 12, totalTokens: 21 },
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: "search-model-1",
        provider: "openai_compatible",
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 6 })
      }), expect.objectContaining({
        modelId: "search-model-2",
        provider: "openai_compatible",
        usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("executes a pending first-party Memory action once from its durable recovery call", async () => {
    const requests: ProviderRunRequest[] = [];
    const execute = vi.fn<MemoryActionExecutor["execute"]>(async (_plan, call, context) => {
      expect(context).toMatchObject({
        persistedToolCallId: "stored-call-1",
        runId,
        userId
      });
      return {
        callId: call.id,
        content: [{ type: "json", value: { operation: "SAVE", result: "applied" } }],
        name: call.name,
        rawPreview: { operation: "SAVE", result: "applied" },
        status: "complete"
      };
    });
    const memoryActionExecutor: MemoryActionExecutor = {
      accepts: (plan, name) => plan.kind === "SAVE" && name === "save_memory",
      execute
    };
    const harness = createHarness({
      memoryActionExecutor,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered after saving Memory",
              usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    const memoryCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall(),
      arguments: { statement: "I like tea" },
      mcpBinding: null,
      toolName: "save_memory"
    };
    const installed = installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [memoryCall],
        phase: "tools_pending",
        providerToolMessages: [{
          arguments: JSON.stringify(memoryCall.arguments),
          call_id: memoryCall.providerCallId,
          name: memoryCall.toolName,
          type: "function_call"
        }]
      }),
      normalizedRequest: normalizedMemoryActionRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).toHaveBeenCalledOnce();
    expect(installed.calls()).toEqual([
      expect.objectContaining({ state: "complete", toolName: "save_memory" })
    ]);
    expect(JSON.stringify(requests)).toContain("SAVE");
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered after saving Memory"
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("rehydrates settled Knowledge evidence and usage without repeating retrieval", async () => {
    const draft: KnowledgeRetrievalEvidence = {
      bases: [{
        baseContentRevision: 2,
        baseName: "PRIVATE-BASE-NAME",
        candidateCount: 1,
        indexedContentRevision: 2,
        indexGenerationId: "private-generation-id",
        knowledgeBaseId: "knowledge-base-1",
        ordinal: 0,
        state: "ready",
        targetDimension: 1024,
        vectorSpaceFingerprint: "c".repeat(64)
      }],
      candidateCount: 1,
      candidateLimit: 40,
      durationMs: 15,
      embeddingExecutions: [{
        bindingOrdinals: [0],
        durationMs: 4,
        inputTokens: 3,
        modelId: "embedding-v1",
        provider: "openai_compatible",
        providerModelId: "private-embedding-deployment",
        requestId: "embedding-request-1",
        status: "complete",
        totalTokens: 3
      }],
      fusion: "rrf_k60",
      invocationOrdinal: 1,
      outcome: "complete",
      postRerankOrder: null,
      preRerankOrder: null,
      providerText: "pending",
      query: "accepted recovery passage",
      rerankerBinding: null,
      resultLimit: 8,
      results: [{
        annRank: 1,
        baseName: "PRIVATE-BASE-NAME",
        bindingOrdinal: 0,
        chunkId: "private-chunk-id",
        chunkIndex: 0,
        documentId: "private-document-id",
        documentVersionId: "private-document-version-id",
        fileName: "PRIVATE-FILE-NAME.pdf",
        ftsRank: 1,
        ftsScore: 0.1,
        fusedScore: 2 / 61,
        handle: "K1.1",
        includedText: "already persisted Knowledge passage",
        includedTextBytes: 35,
        knowledgeBaseId: "knowledge-base-1",
        page: 3,
        sourceTextBytes: 35,
        textTruncated: false,
        vectorDistance: 0,
        vectorScore: 1
      }],
      threshold: 0.01,
      version: KNOWLEDGE_RESULT_VERSION
    };
    const evidence: KnowledgeRetrievalEvidence = {
      ...draft,
      providerText: knowledgeToolResultText(draft)
    };
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: knowledgeToolResultContent(evidence),
      name: KNOWLEDGE_TOOL_NAME,
      rawPreview: {
        finalProviderResponsePreview: { knowledgeRetrieval: evidence },
        knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
        providerCall: true,
        requestPreview: {}
      },
      status: "complete",
      usage: { inputTokens: 3, outputTokens: 0, reasoningTokens: 0, totalTokens: 3 }
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_knowledge_fixture");
    const settledCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("complete"),
      arguments: { query: evidence.query },
      mcpBinding: null,
      result: settledResult,
      toolName: KNOWLEDGE_TOOL_NAME
    };
    const execute = vi.fn<NonNullable<RunRecoveryDeps["knowledgeExecutor"]>["execute"]>();
    const requests: ProviderRunRequest[] = [];
    const harness = createHarness({
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_TOOL_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered with Knowledge",
              usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [settledCall],
        phase: "tools_pending",
        providerToolMessages: [{
          arguments: JSON.stringify({ query: evidence.query }),
          call_id: "provider-call-1",
          name: KNOWLEDGE_TOOL_NAME,
          type: "function_call"
        }]
      }),
      normalizedRequest: normalizedKnowledgeRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(requests)).toContain("already persisted Knowledge passage");
    expect(JSON.stringify(requests)).not.toContain("PRIVATE-BASE-NAME");
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered with Knowledge",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: "embedding-v1",
        provider: "openai_compatible",
        usage: expect.objectContaining({ inputTokens: 3, totalTokens: 3 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("replays a settled Knowledge tool error without inventing receipt evidence", async () => {
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: [{ text: "Knowledge retrieval limit reached.", type: "text" }],
      name: KNOWLEDGE_TOOL_NAME,
      rawPreview: {
        finalProviderResponsePreview: { error: "knowledge_invocation_limit_reached" },
        providerCall: false,
        requestPreview: { queryCharacters: 14 }
      },
      status: "error",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_knowledge_error_fixture");
    const settledCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("error"),
      arguments: { query: "one call too many" },
      mcpBinding: null,
      result: settledResult,
      toolName: KNOWLEDGE_TOOL_NAME
    };
    const execute = vi.fn<NonNullable<RunRecoveryDeps["knowledgeExecutor"]>["execute"]>();
    const requests: ProviderRunRequest[] = [];
    const harness = createHarness({
      knowledgeExecutor: {
        accepts: (name) => name === KNOWLEDGE_TOOL_NAME,
        capability: "knowledge",
        execute,
        tool: knowledgeRetrievalTool
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return {
              finalProviderResponsePreview: {},
              finalText: "Recovered after Knowledge limit",
              usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
            };
          }
        }
      }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [settledCall],
        phase: "tools_pending",
        providerToolMessages: [{
          arguments: JSON.stringify({ query: "one call too many" }),
          call_id: "provider-call-1",
          name: KNOWLEDGE_TOOL_NAME,
          type: "function_call"
        }]
      }),
      normalizedRequest: normalizedKnowledgeRequest()
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(requests)).toContain("Knowledge retrieval limit reached");
    expect(harness.state.completed).toMatchObject({ finalText: "Recovered after Knowledge limit" });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("reuses a settled Anthropic Search and recovers usage recorded after the prior snapshot", async () => {
    const request = normalizedAnthropicSearchRequest();
    const selected = {
      ...request.searchPlan!.options[0]!,
      modelId: "search-model-1",
      optionId: "search-option-1",
      providerModelId: "search-model-row-1",
      revisionId: "search-revision-1",
      searchStrategyRowId: "search-strategy-row-1"
    };
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: [{ text: "settled findings", type: "text" }],
      name: "search_engine_1",
      rawPreview: {
        finalProviderResponsePreview: {
          searchExecutions: [{
            displayName: "Anthropic Web Search",
            durationMs: 10,
            invocationId: "provider-call-1:search-option-1",
            modelId: selected.modelId,
            optionId: selected.optionId,
            provider: selected.provider,
            providerOperationsTruncated: false,
            query: "settled query",
            requestPreview: {},
            revisionId: selected.revisionId,
            findings: "settled findings",
            sources: [{
              rank: 1,
              title: "Settled source",
              url: "https://example.com/settled-source"
            }],
            status: "complete",
            usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
          }]
        },
        providerCall: true,
        requestPreview: {}
      },
      status: "complete",
      usage: { inputTokens: 5, outputTokens: 6, reasoningTokens: 0 }
    }, 32_000);
    if (!settledResult) throw new Error("invalid_settled_search_fixture");
    const settledCall: PersistedToolLoopCall = {
      ...persistedRecoveryCall("complete"),
      arguments: { query: "settled query" },
      mcpBinding: null,
      result: settledResult,
      toolName: "search_engine_1"
    };
    const search = vi.fn<ProviderSearchAdapter["search"]>();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream() {
        return {
          finalProviderResponsePreview: {},
          finalText: "Recovered answer",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      providers: { anthropic: adapter, openai: adapter },
      searchProviders: {
        anthropic: { buildRequestPreview: () => ({}), search }
      }
    });
    installCheckpointState(harness, {
      ...checkpointedRun({
        calls: [settledCall],
        phase: "tools_pending",
        providerToolMessages: [{
          arguments: "{\"query\":\"settled query\"}",
          call_id: "provider-call-1",
          name: "search_engine_1",
          type: "function_call"
        }]
      }),
      normalizedRequest: {
        ...request,
        searchPlan: { mode: "model_choice", options: [selected] }
      }
    }, [{
      modelId: selected.modelId!,
      provider: selected.provider,
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 0 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(search).not.toHaveBeenCalled();
    expect(harness.state.completed).toMatchObject({
      finalText: "Recovered answer",
      usage: { inputTokens: 11, outputTokens: 14, totalTokens: 25 },
      usageAttributions: expect.arrayContaining([expect.objectContaining({
        modelId: selected.modelId,
        provider: selected.provider,
        usage: expect.objectContaining({ inputTokens: 9, outputTokens: 11 })
      })])
    });
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("aborts an in-flight MCP call owned by checkpoint recovery", async () => {
    const callStarted = deferred();
    const recoveryRegistry = registry();
    let observedAbort = false;
    const runtimeCall = vi.fn(async (input: { signal?: AbortSignal }) => {
      callStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          observedAbort = true;
          const error = new Error("recovered MCP call aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            return providerResult;
          }
        }
      },
      registry: recoveryRegistry
    });
    installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" })
    );

    const recovery = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await callStarted.promise;
    expect(recoveryRegistry.has(runId)).toBe(true);
    expect(recoveryRegistry.abort(runId)).toBe(true);
    await recovery;

    expect(observedAbort).toBe(true);
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("hydrates image and native PDF bytes before a recovered continuation", async () => {
    const requests: ProviderRunRequest[] = [];
    const getObject = vi.fn(async (storageKey: string) => ({
      body: Buffer.from(storageKey === "image-key" ? "image-bytes" : "pdf-bytes"),
      contentType: storageKey === "image-key" ? "image/png" : "application/pdf",
      storageKey
    }));
    const harness = createHarness({
      mcpRuntime: {
        callTool: async () => ({
          isError: false,
          structuredContent: null,
          text: ["remembered"],
          unsupportedContentTypes: []
        }),
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream(request) {
            requests.push(request);
            return providerResult;
          }
        }
      },
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1", "pdf-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" },
            { attachmentId: "pdf-1", type: "attachment" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          nativePdfInput: true,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [
      {
        byteSize: 11,
        extractedText: null,
        fileName: "diagram.png",
        id: "image-1",
        kind: "image",
        metadata: { image: { height: 10, width: 10 } },
        mimeType: "image/png",
        status: "ready",
        storageKey: "image-key"
      },
      {
        byteSize: 9,
        extractedText: null,
        fileName: "document.pdf",
        id: "pdf-1",
        kind: "pdf",
        metadata: { pdf: { pageCount: 1 } },
        mimeType: "application/pdf",
        status: "ready",
        storageKey: "pdf-key"
      }
    ];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(getObject).toHaveBeenCalledTimes(2);
    expect(requests[0]?.attachments).toEqual([
      expect.objectContaining({
        dataUrl: `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`,
        id: "image-1"
      }),
      expect.objectContaining({
        base64Data: Buffer.from("pdf-bytes").toString("base64"),
        id: "pdf-1"
      })
    ]);
  });

  it("reapplies the shared attachment preflight before recovery storage or provider I/O", async () => {
    const getObject = vi.fn();
    const providerStream = vi.fn();
    const harness = createHarness({
      attachmentLimits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 10,
        readConcurrency: 2
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      },
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [
      {
        byteSize: 11,
        extractedText: null,
        fileName: "diagram.png",
        id: "image-1",
        kind: "image",
        metadata: { image: { height: 10, width: 10 } },
        mimeType: "image/png",
        status: "ready",
        storageKey: "image-key"
      }
    ];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(getObject).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "attachment_materialization_limit_exceeded",
          message: "Selected attachments require 11 source bytes; the limit is 10."
        }
      })
    ]);
  });

  it.each([
    {
      attachmentIds: ["one", "two"],
      blocks: [
        { attachmentId: "one", type: "image" },
        { attachmentId: "two", type: "image" }
      ],
      code: "attachment_count_limit_exceeded",
      label: "count overflow",
      maxCount: 1
    },
    {
      attachmentIds: [],
      blocks: Array.from({ length: 257 }, () => ({ text: "x", type: "text" })),
      code: "content_block_limit_exceeded",
      label: "content-block overflow",
      maxCount: 20
    },
    {
      attachmentIds: ["persisted-only"],
      blocks: [{ text: "missing attachment block", type: "text" }],
      code: "attachment_reference_invalid",
      label: "persisted/content mismatch",
      maxCount: 20
    }
  ])("rejects a recovered $label before attachment or provider I/O", async ({
    attachmentIds,
    blocks,
    code,
    maxCount
  }) => {
    const providerStream = vi.fn();
    const harness = createHarness({
      attachmentLimits: {
        maxCount,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds,
        content: { blocks }
      }
    });
    const loadAttachments = vi.fn(async () => []);
    harness.repository.loadAttachments = loadAttachments;

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(loadAttachments).not.toHaveBeenCalled();
    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code }) })
    ]);
  });

  it.each([
    {
      body: Buffer.alloc(3),
      code: "attachment_encoded_size_limit_exceeded",
      expectedReads: 0,
      storageError: null,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 25,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      }
    },
    {
      body: Buffer.alloc(2),
      code: "attachment_object_size_mismatch",
      expectedReads: 1,
      storageError: null,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      }
    },
    {
      body: Buffer.alloc(3),
      code: "attachment_object_read_failed",
      expectedReads: 1,
      limits: {
        maxCount: 20,
        maxEncodedBytes: 1_000,
        maxMaterializedBytes: 1_000,
        readConcurrency: 2
      },
      storageError: "ENOENT /private/bucket/image-key"
    }
  ])("preserves $code during recovery parity", async ({
    body,
    code,
    expectedReads,
    limits: attachmentLimits,
    storageError
  }) => {
    const getObject = vi.fn(async (storageKey: string) => {
      if (storageError) throw new Error(storageError);
      return {
        body,
        contentType: "image/png",
        storageKey
      };
    });
    const providerStream = vi.fn();
    const harness = createHarness({
      attachmentLimits,
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      },
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [{
      byteSize: 3,
      extractedText: null,
      fileName: "diagram.png",
      id: "image-1",
      kind: "image",
      metadata: {},
      mimeType: "image/png",
      status: "ready",
      storageKey: "image-key"
    }];

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(getObject).toHaveBeenCalledTimes(expectedReads);
    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code }) })
    ]);
    if (storageError) {
      expect(JSON.stringify(harness.state.recoveredErrors)).not.toContain(storageError);
      expect(harness.state.recoveredErrors[0]?.error.message)
        .toBe("An attachment object could not be read.");
    }
  });

  it("treats cancellation during recovered attachment I/O as cancellation, not failure", async () => {
    const readStarted = deferred();
    const recoveryRegistry = registry();
    const providerStream = vi.fn();
    const getObject = vi.fn((
      _storageKey: string,
      options?: { signal?: AbortSignal }
    ) => new Promise<never>((_resolve, reject) => {
      readStarted.resolve();
      const abort = () => reject(options?.signal?.reason);
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    }));
    const harness = createHarness({
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            providerStream();
            return providerResult;
          }
        }
      },
      registry: recoveryRegistry,
      storage: { getObject }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        attachmentIds: ["image-1"],
        content: {
          blocks: [
            ...base.normalizedRequest.content.blocks,
            { attachmentId: "image-1", type: "image" }
          ]
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          vision: true
        }
      }
    });
    harness.repository.loadAttachments = async () => [{
      byteSize: 3,
      extractedText: null,
      fileName: "diagram.png",
      id: "image-1",
      kind: "image",
      metadata: {},
      mimeType: "image/png",
      status: "ready",
      storageKey: "image-key"
    }];

    const recovery = refreshProviderRunIfNeeded(harness.deps, runId, userId);
    await readStarted.promise;
    expect(recoveryRegistry.abort(runId)).toBe(true);
    await recovery;

    expect(providerStream).not.toHaveBeenCalled();
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([]);
  });

  it("continues multiple post-recovery OpenAI tool rounds through successive response ids", async () => {
    const requests: ProviderRunRequest[] = [];
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: null,
      text: [`result-${runtimeCall.mock.calls.length}`],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            finalProviderResponsePreview: {},
            finalText: "",
            providerResponseId: "response-tool-2",
            providerToolCallMessage: [{
              arguments: "{\"value\":\"beta\"}",
              call_id: "provider-call-2",
              name: recoveryToolName,
              type: "function_call"
            }],
            toolCalls: [{
              arguments: { value: "beta" },
              id: "provider-call-2",
              name: recoveryToolName
            }],
            usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0 }
          };
        }
        return {
          finalProviderResponsePreview: {},
          finalText: "two rounds complete",
          providerResponseId: "response-final",
          usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" })
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(requests[0]?.providerToolMessages).toEqual([
      expect.objectContaining({ call_id: "provider-call-1", type: "function_call" }),
      expect.objectContaining({ call_id: "provider-call-1", type: "function_call_output" })
    ]);
    expect(requests[1]?.previousProviderResponseId).toBeUndefined();
    expect(requests[1]?.providerToolMessages).toEqual([
      expect.objectContaining({ call_id: "provider-call-1", type: "function_call" }),
      expect.objectContaining({ call_id: "provider-call-1", type: "function_call_output" }),
      expect.objectContaining({ call_id: "provider-call-2", type: "function_call" }),
      expect.objectContaining({ call_id: "provider-call-2", type: "function_call_output" })
    ]);
    expect(harness.state.completed).toMatchObject({ finalText: "two rounds complete" });
  });

  it("re-budgets the retained tool transcript before a recovered provider continuation", async () => {
    const stream = vi.fn();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        stream(request);
        return providerResult;
      }
    };
    const harness = createHarness({
      mcpRuntime: {
        callTool: async () => ({
          isError: false,
          structuredContent: null,
          text: ["large recovered result ".repeat(200)],
          unsupportedContentTypes: []
        }),
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const base = checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" });
    installCheckpointState(harness, {
      ...base,
      normalizedRequest: {
        ...base.normalizedRequest,
        context: {
          messages: [{
            content: { blocks: [{ text: "remember", type: "text" }] },
            id: "current-message",
            role: "user"
          }],
          mode: "branch_path"
        },
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          contextWindow: 500,
          defaultMaxOutputTokens: 0
        }
      }
    });

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "context_too_large" }) })
    ]);
  });

  it("claims pending calls, reuses persisted usage, and does not double-count the completed round", async () => {
    const requests: ProviderRunRequest[] = [];
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      result: {
        finalProviderResponsePreview: {},
        finalText: "",
        providerResponseId: "response-tool-1",
        toolCalls: [{ arguments: {}, id: "provider-call-1", name: recoveryToolName }],
        usage: { inputTokens: 99, outputTokens: 99, reasoningTokens: 0 }
      },
      status: "completed",
      terminal: true
    }));
    const runtimeCall = vi.fn(async () => ({
      isError: false,
      structuredContent: { stored: true },
      text: [],
      unsupportedContentTypes: []
    }));
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      refresh,
      async *stream(request) {
        requests.push(request);
        return {
          finalProviderResponsePreview: {},
          finalText: "done",
          providerResponseId: "response-final",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0 }
        };
      }
    };
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: { openai: adapter }
    });
    const checkpointState = installCheckpointState(
      harness,
      checkpointedRun({
        answerRoundUsage: [{
          completeness: "terminal",
          roundIndex: 1,
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 7,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 8
          }
        }],
        calls: [persistedRecoveryCall()],
        phase: "tools_pending"
      }),
      [{
        modelId: "gpt-test",
        provider: "openai",
        recordedAt: "2026-07-12T09:00:00.000Z",
        usage: { inputTokens: 7, outputTokens: 1, reasoningTokens: 0 }
      }]
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).not.toHaveBeenCalled();
    expect(runtimeCall).toHaveBeenCalledOnce();
    expect(requests[0]?.previousProviderResponseId).toBeUndefined();
    expect(harness.state.completed).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
      usageAttributions: [{
        modelId: "gpt-test",
        provider: "openai",
        usage: expect.objectContaining({ inputTokens: 9, outputTokens: 4 })
      }]
    });
    expect(checkpointState.checkpoint()).toMatchObject({
      answerRoundUsage: [
        expect.objectContaining({ completeness: "terminal", roundIndex: 1 }),
        expect.objectContaining({ completeness: "terminal", roundIndex: 2 })
      ],
      phase: "provider_running",
      roundIndex: 2,
      version: 2
    });
  });

  it("replaces partial later-round usage without dropping same-model tool usage", async () => {
    const refresh = vi.fn(async (): Promise<ProviderRunRefreshResult> => ({
      events: [],
      result: {
        finalProviderResponsePreview: {},
        finalText: "Recovered after round two",
        providerResponseId: "response-round-2",
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5 }
      },
      status: "completed",
      terminal: true
    }));
    const harness = createHarness({
      providers: { openai: providerWithRefresh(refresh) }
    });
    const checkpointState = installCheckpointState(harness, checkpointedRun({
      answerRoundUsage: [
        {
          completeness: "terminal",
          roundIndex: 1,
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 7,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 8
          }
        },
        {
          completeness: "partial",
          roundIndex: 2,
          usage: {
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            inputTokens: 2,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 3
          }
        }
      ],
      phase: "provider_running",
      providerResponseId: "response-round-2",
      providerToolMessages: [],
      roundIndex: 2
    }), [{
      // The grouped row also includes 3 input and 4 output tokens consumed by
      // a tool which intentionally uses the same provider/model as the answer.
      modelId: "gpt-test",
      provider: "openai",
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 12, outputTokens: 6, reasoningTokens: 0, totalTokens: 18 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.state.completed).toMatchObject({
      estimatedCostMicros: 280,
      finalText: "Recovered after round two",
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      usageAttributions: [{
        modelId: "gpt-test",
        provider: "openai",
        estimatedCostMicros: 280,
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 8, totalTokens: 20 })
      }]
    });
    expect(checkpointState.checkpoint()).toMatchObject({
      answerRoundUsage: [
        expect.objectContaining({ completeness: "terminal", roundIndex: 1 }),
        expect.objectContaining({
          completeness: "terminal",
          roundIndex: 2,
          usage: expect.objectContaining({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
        })
      ],
      version: 2
    });
  });

  it("fails closed when answer-round usage exceeds the persisted aggregate", async () => {
    const refresh = vi.fn();
    const harness = createHarness({
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          refresh,
          async *stream() {
            return providerResult;
          }
        }
      }
    });
    installCheckpointState(harness, checkpointedRun({
      answerRoundUsage: [{
        completeness: "partial",
        roundIndex: 1,
        usage: {
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 9,
          outputTokens: 3,
          reasoningTokens: 0,
          totalTokens: 12
        }
      }],
      phase: "provider_running",
      providerResponseId: "response-tool-1"
    }), [{
      modelId: "gpt-test",
      provider: "openai",
      recordedAt: "2026-07-12T09:00:00.000Z",
      usage: { inputTokens: 4, outputTokens: 2, reasoningTokens: 0, totalTokens: 6 }
    }]);

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(refresh).not.toHaveBeenCalled();
    expect(harness.state.completed).toBeNull();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "tool_loop_usage_evidence_invalid" }),
        usageAttributions: []
      })
    ]);
  });

  it("never repeats a call left running across a process crash", async () => {
    const runtimeCall = vi.fn();
    const harness = createHarness({
      mcpRuntime: {
        callTool: runtimeCall,
        ensureAcceptedGeneration: async () => true
      },
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          async *stream() {
            return providerResult;
          }
        }
      }
    });
    installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall("running")], phase: "tools_running" })
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(runtimeCall).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: "tool_call_outcome_unknown" })
      })
    ]);
  });

  it("fails a checkpointed provider round without a durable native handle actionably", async () => {
    const stream = vi.fn();
    const harness = createHarness({
      controls: [control({ providerResponseId: null })],
      providers: {
        openai: {
          buildRequestPreview: () => ({}),
          stream: stream as ProviderAdapter["stream"]
        }
      }
    });
    installCheckpointState(
      harness,
      checkpointedRun({ phase: "provider_running", providerResponseId: null })
    );

    await refreshProviderRunIfNeeded(harness.deps, runId, userId);

    expect(stream).not.toHaveBeenCalled();
    expect(harness.state.recoveredErrors).toEqual([
      expect.objectContaining({
        error: {
          code: "tool_loop_provider_round_outcome_unknown",
          message: "The model round stopped before a durable provider response ID was saved and was not repeated."
        }
      })
    ]);
  });
});
