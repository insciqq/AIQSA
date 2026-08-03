import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type {
  NormalizedRunRequest,
  ProviderAdapter,
  ProviderRunRefreshResult,
  ProviderRunRequest,
  ProviderRunResult,
  ProviderSearchAdapter,
  ProviderSearchRequest
} from "../providers/types";
import type {
  PersistedRunUsageAttribution,
  RunControlRecord,
  RunUsageAttribution,
  StaleRunControlRecord
} from "./runRepositoryContract";
import {
  toolLoopCheckpoint,
  type CheckpointedToolLoopRun,
  type PersistedToolLoopCall,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import { snapshotToolExecutionResult } from "./toolExecutionPersistence";
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
  completeRun?: boolean;
  controls?: readonly (RunControlRecord | null)[];
  failRun?: boolean;
  liveRunIds?: readonly string[];
  mcpRuntime?: RunRecoveryDeps["mcpRuntime"];
  pricing?: {
    inputTokenPriceMicros: number;
    outputTokenPriceMicros: number;
  } | null;
  providers?: Readonly<Record<string, ProviderAdapter>>;
  registry?: RunRecoveryRegistry;
  settleRecoveredRunError?: boolean;
  searchProviders?: RunRecoveryDeps["searchProviders"];
  staleRuns?: readonly StaleRunControlRecord[];
  storage?: RunRecoveryDeps["storage"];
}> = {}) {
  const controls = options.controls ?? [control()];
  let controlIndex = 0;
  let appendCollision = false;
  let nextSequence = 0;
  const state: {
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
    recoveredErrors: Parameters<RunRecoveryRepository["settleRecoveredRunError"]>[0][];
    staleQueries: Parameters<RunRecoveryRepository["findStaleActiveRunsForUser"]>[0][];
    sweeps: string[][];
  } = {
    appendAttempts: [],
    completed: null,
    events: [],
    failed: [],
    operations: [],
    providerResponseIds: [],
    recoveredErrors: [],
    staleQueries: [],
    sweeps: []
  };
  const repository: RunRecoveryRepository = {
    advanceToolLoopCallBatch: async () => "not_found",
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

      state.completed = input;
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
    failRun: async (failedRunId, assistantMessageId, error) => {
      if (options.failRun === false) {
        return false;
      }
      state.operations.push(`fail:${error.code}`);
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
    loadModelPricing: async () =>
      options.pricing === undefined
        ? {
            inputTokenPriceMicros: 10,
            outputTokenPriceMicros: 20
          }
        : options.pricing,
    loadRunUsageAttributions: async () => [],
    markAssistantMessageGroundedLiveOnly: async () => true,
    nextRunEventSequence: async () => nextSequence,
    persistToolLoopCallBatch: async () => ({ kind: "not_found" }),
    recordRunUsageEvents: async () => true,
    resetToolLoopAssistantDraft: async () => false,
    settleRecoveredRunError: async (input) => {
      if (options.settleRecoveredRunError === false) {
        return false;
      }
      state.operations.push(`settle_recovered:${input.error.code}`);
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
      state.providerResponseIds.push({ providerResponseId, runId: responseRunId });
      return "published";
    },
    updateRunProviderRequestPreview: async () => undefined
  };
  const deps: RunRecoveryDeps = {
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
    prompt: { developer: null, presetId: null, system: null },
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

function checkpoint(
  phase: "provider_running" | "tools_pending" | "tools_running",
  roundIndex: number,
  continuation: ToolLoopJsonValue
) {
  const value = toolLoopCheckpoint({
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
  calls?: readonly PersistedToolLoopCall[];
  phase: "provider_running" | "tools_pending" | "tools_running";
  providerResponseId?: string | null;
  providerToolMessages?: ToolLoopJsonValue[];
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
    calls: [...(input.calls ?? [])],
    chatId: "chat-1",
    checkpoint: checkpoint(input.phase, 1, continuation),
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
  harness.repository.loadCheckpointedToolLoopRun = async () => ({
    ...initial,
    calls,
    checkpoint: currentCheckpoint
  });
  harness.repository.loadRunUsageAttributions = async () => persistedUsage;
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
    currentCheckpoint = checkpoint("tools_running", currentCheckpoint.roundIndex, currentCheckpoint.providerContinuation);
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
    currentCheckpoint = checkpoint("tools_pending", input.roundIndex, input.providerContinuation);
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
      currentCheckpoint.providerContinuation
    );
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
    const settledResult = snapshotToolExecutionResult({
      callId: "provider-call-1",
      content: [{ text: "already persisted findings", type: "text" }],
      name: "search_engine_1",
      rawPreview: {
        finalProviderResponsePreview: {
          searchExecutions: [{
            displayName: firstOption.displayName,
            durationMs: 10,
            invocationId: "provider-call-1:search-option-1",
            modelId: firstOption.modelId,
            optionId: firstOption.optionId,
            provider: firstOption.provider,
            providerOperationsTruncated: false,
            query: "first source query",
            requestPreview: {},
            revisionId: firstOption.revisionId,
            sources: [],
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
          sources: [],
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

  it("recovers settled Search usage recorded after the previous usage snapshot", async () => {
    const request = normalizedLegacySearchRequest();
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
            displayName: "OpenAI Search",
            durationMs: 10,
            invocationId: "provider-call-1:search-option-1",
            modelId: selected.modelId,
            optionId: selected.optionId,
            provider: selected.provider,
            providerOperationsTruncated: false,
            query: "settled query",
            requestPreview: {},
            revisionId: selected.revisionId,
            sources: [],
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
      providers: { openai: adapter, openai_compatible: adapter },
      searchProviders: {
        openai_compatible: { buildRequestPreview: () => ({}), search }
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
        modelCapabilities: {
          ...base.normalizedRequest.modelCapabilities,
          nativePdfInput: true
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
    installCheckpointState(
      harness,
      checkpointedRun({ calls: [persistedRecoveryCall()], phase: "tools_pending" }),
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
