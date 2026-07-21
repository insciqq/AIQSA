import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRefreshResult, ProviderRunResult } from "../providers/types";
import type { RunControlRecord, StaleRunControlRecord } from "./runRepositoryContract";
import {
  activeRunStaleMs,
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

function registry(liveRunIds: readonly string[] = []): RunRecoveryRegistry {
  const live = new Set(liveRunIds);

  return {
    has: (candidateRunId) => live.has(candidateRunId),
    ids: () => [...live]
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
  pricing?: {
    inputTokenPriceMicros: number;
    outputTokenPriceMicros: number;
  } | null;
  providers?: Readonly<Record<string, ProviderAdapter>>;
  settleRecoveredRunError?: boolean;
  staleRuns?: readonly StaleRunControlRecord[];
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
    loadModelPricing: async () =>
      options.pricing === undefined
        ? {
            inputTokenPriceMicros: 10,
            outputTokenPriceMicros: 20
          }
        : options.pricing,
    nextRunEventSequence: async () => nextSequence,
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
    sweepBootOrphanedRuns: async ({ liveRunIds }) => {
      state.sweeps.push(liveRunIds);
      return 0;
    },
    updateRunProviderResponseId: async (responseRunId, providerResponseId) => {
      state.operations.push("update_response_id");
      state.providerResponseIds.push({ providerResponseId, runId: responseRunId });
      return "published";
    }
  };
  const deps: RunRecoveryDeps = {
    providers: options.providers ?? {},
    registry: registry(options.liveRunIds),
    repository
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

describe("run recovery", () => {
  beforeEach(() => {
    resetBootOrphanSweepForTest(new Date("2026-07-12T10:00:00.000Z"));
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
});
