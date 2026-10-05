import { EventEmitter } from "node:events";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCoordinator, type MemoryCoordinatorStopResult } from "./coordinator";
import type { MemoryCoordinatorRepository } from "./prismaRepository";
import { MemoryCoordinatorRegistry } from "./registry";
import type { MemoryJobClaim } from "./types";
import { MEMORY_WORKER_SHUTDOWN_STEP_MS, runMemoryCoordinatorWorker } from "./workerProcess";
import {
  executeGovernedMemoryStructuredOutput,
  MemoryStructuredOutputProviderError,
  unavailableMemoryReportedUsage,
  type MemoryStructuredOutputProvider
} from "../execution/structuredClassifier";

const { bind, start, settle } = vi.hoisted(() => ({ bind: vi.fn(), start: vi.fn(), settle: vi.fn() }));
vi.mock("../execution/admission", () => ({
  createPrismaMemoryExecutionAdmission: () => ({ bind, start })
}));
vi.mock("../execution/lifecycle", () => ({
  createPrismaMemoryExecutionLifecycle: () => ({ settle, settleSucceededWithDurableResult: vi.fn() })
}));

const NOW = new Date("2026-10-05T12:00:00.000Z");
const RESULT_HASH = "a".repeat(64);

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

function claim(): MemoryJobClaim {
  return {
    activeLeafMessageId: null, attemptCount: 1, branchGeneration: null, chatId: null,
    claimToken: "claim-token", id: "job-1", idempotencyFingerprint: "job-1", kind: "INDEX_HISTORY",
    leaseExpiresAt: new Date(NOW.getTime() + 30_000), memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 0, pipelineVersion: "memory-test-v1", recoveredLease: false,
    sourceHash: null, sourceMessageId: null, sourceRevision: null, stage: null,
    targetFactVersionId: null, userId: "user-1"
  };
}

function repository(): MemoryCoordinatorRepository {
  return {
    cancelUnavailableJobOwners: vi.fn(async () => 0),
    claimDeletion: vi.fn(async () => null),
    claimJob: vi.fn().mockResolvedValueOnce(claim()).mockResolvedValue(null),
    commitDeletionSuccess: vi.fn(async () => true),
    commitJobSuccess: vi.fn(async () => true),
    heartbeatDeletion: vi.fn(async () => true),
    heartbeatJob: vi.fn(async () => true),
    listWaitingJobs: vi.fn(async () => []),
    preflight: vi.fn(async () => undefined),
    requeueDueJobs: vi.fn(async () => 0),
    recoverEligibleJobs: vi.fn(async () => 0),
    resolveWaitingJob: vi.fn(async () => false),
    retryDeletion: vi.fn(async () => true),
    retryJob: vi.fn(async () => true),
    setJobStage: vi.fn(async () => true),
    settleJobGate: vi.fn(async () => true),
    terminalJob: vi.fn(async () => true),
    terminalUnavailableJobs: vi.fn(async () => 0)
  };
}

/** A worker whose only job dispatches one governed classifier call. */
function classifierWorker(input: Readonly<{
  honorsCancellation?: boolean;
  stop?: (coordinator: MemoryCoordinator) => Promise<MemoryCoordinatorStopResult>;
}> = {}) {
  const events: string[] = [];
  const dispatched = gate();
  const ignored = gate();
  const run = vi.fn<MemoryStructuredOutputProvider["run"]>((_snapshot, _request, signal) =>
    new Promise((_resolve, reject) => {
      dispatched.release();
      if (input.honorsCancellation === false) {
        void ignored.opened.then(() => reject(new Error("late_provider_failure")));
        return;
      }
      signal.addEventListener("abort", () => reject(new MemoryStructuredOutputProviderError(
        null, null, { cause: signal.reason })), { once: true });
    }));
  const registry = new MemoryCoordinatorRegistry();
  registry.registerJob({
    kind: "INDEX_HISTORY",
    preflight: async () => ({ status: "READY" }),
    async execute(job, context) {
      await executeGovernedMemoryStructuredOutput({
        authority: {}, client: {} as PrismaClient, decode: (value) => value, inputHash: "b".repeat(64),
        ordinal: 0, owner: { memoryJobId: job.id, type: "JOB" }, provider: { run },
        request: { maxOutputTokens: 128, name: "bounded_decision", schema: { type: "object" },
          systemPrompt: "Classify supplied data.", userPrompt: "Synthetic data" },
        role: "MEMORY_HISTORY_CLASSIFY", signal: context.signal, userId: job.userId,
        versions: { pipelineVersion: "pipeline", policyVersion: "policy", promptVersion: "prompt",
          retrievalConfigFingerprint: "retrieval", schemaVersion: "schema" }
      });
      return { acceptedResultHash: RESULT_HASH };
    }
  });
  const repo = repository();
  const coordinator = new MemoryCoordinator({
    now: () => new Date(NOW),
    policy: { heartbeatMs: 10_000, intervalMs: 60_000, leaseMs: 30_000, maxDeletionParallel: 1, maxJobParallel: 1 },
    registry,
    repository: repo
  });
  const signals = new EventEmitter();
  const stopCoordinator = vi.fn(async () => {
    const result = await (input.stop?.(coordinator) ?? coordinator.stop());
    events.push(`drained:${result.drained}`);
    return result;
  });
  const exit = runMemoryCoordinatorWorker({
    disconnect: async () => { events.push("disconnect"); },
    signals,
    start: async () => { coordinator.start(); return { status: "ready" }; },
    stopCoordinator,
    stopHeartbeat: async () => { events.push("liveness"); }
  });
  return {
    coordinator, dispatched: dispatched.opened, events, exit, release: ignored.release, repo, run, signals,
    stopCoordinator
  };
}

let records: () => Array<Record<string, unknown>> = () => [];

beforeEach(() => {
  vi.resetAllMocks();
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  records = () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
  bind.mockResolvedValue({ id: "binding" });
  start.mockResolvedValue({ snapshot: {
    logicalRole: "MEMORY_HISTORY_CLASSIFY", requiresStrictStructuredOutput: true,
    providerExecutionSnapshot: { providerFamily: "fixture", providerModelId: "configured-model" }
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Memory worker shutdown", () => {
  it("persists an interrupted classifier dispatch before liveness clears and the database closes", async () => {
    const settlement = gate();
    const worker = classifierWorker();
    settle.mockImplementation(async () => {
      worker.events.push("settlement:start");
      await settlement.opened;
      worker.events.push("settlement:end");
      return { completedAt: NOW };
    });
    await worker.dispatched;
    worker.signals.emit("SIGTERM");
    // A repeated signal neither restarts nor cuts the drain short.
    worker.signals.emit("SIGINT");
    worker.signals.emit("SIGTERM");
    await vi.waitFor(() => expect(worker.events).toEqual(["settlement:start"]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(worker.events).toEqual(["settlement:start"]);

    settlement.release();
    await expect(worker.exit).resolves.toBe(0);
    expect(worker.events).toEqual([
      "settlement:start", "settlement:end", "drained:true", "liveness", "disconnect"
    ]);
    // The aborted call is settled as a cancelled dispatch, never replayed.
    expect(settle).toHaveBeenCalledExactlyOnceWith("user-1", "binding", expect.objectContaining({
      state: "CANCELLED", errorCode: "memory_classifier_cancelled", providerResponseId: null,
      usage: expect.objectContaining({ completeness: unavailableMemoryReportedUsage.completeness, totalTokens: null })
    }));
    expect(worker.run).toHaveBeenCalledOnce();
    expect(worker.stopCoordinator).toHaveBeenCalledOnce();
    expect(worker.repo.commitJobSuccess).not.toHaveBeenCalled();
    expect(worker.repo.retryJob).not.toHaveBeenCalled();
    expect(worker.repo.terminalJob).not.toHaveBeenCalled();
    expect(worker.signals.listenerCount("SIGTERM") + worker.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("closes in order when the interrupted dispatch cannot be settled, leaving it to recovery", async () => {
    const worker = classifierWorker();
    settle.mockImplementation(async () => {
      worker.events.push("settlement:failed");
      throw new Error("PRIVATE_DATABASE_FAILURE");
    });
    await worker.dispatched;
    worker.signals.emit("SIGTERM");
    await expect(worker.exit).resolves.toBe(0);
    expect(worker.events).toEqual(["settlement:failed", "drained:true", "liveness", "disconnect"]);
    expect(worker.repo.retryJob).not.toHaveBeenCalled();
    expect(worker.repo.terminalJob).not.toHaveBeenCalled();
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("reports a timed-out drain and still clears liveness before closing", async () => {
    const worker = classifierWorker({
      honorsCancellation: false,
      stop: (coordinator) => coordinator.stop({ drainTimeoutMs: 30 })
    });
    settle.mockResolvedValue({ completedAt: NOW });
    await worker.dispatched;
    worker.signals.emit("SIGTERM");
    await expect(worker.exit).resolves.toBe(0);
    expect(worker.events).toEqual(["drained:false", "liveness", "disconnect"]);
    expect(settle).not.toHaveBeenCalled();
    expect(records()).toContainEqual(expect.objectContaining({ event: "runtime_lifecycle", stage: "shutdown",
      outcome: "failed", code: "memory_coordinator_drain_timeout", pending_count: 1 }));
    // After a real disconnect this late settlement fails and the binding
    // stays RUNNING for orphan recovery; here it only ends the stopped pass.
    worker.release();
    await worker.coordinator.reconcileNow();
    expect(worker.repo.commitJobSuccess).not.toHaveBeenCalled();
  });

  it("bounds each shutdown write after the drain", async () => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const events: string[] = [];
    const exit = runMemoryCoordinatorWorker({
      disconnect: async () => { events.push("disconnect"); },
      signals,
      start: async () => ({ status: "ready" }),
      stopCoordinator: async () => { events.push("drained"); },
      stopHeartbeat: () => new Promise<void>(() => { events.push("liveness"); })
    });
    await vi.advanceTimersByTimeAsync(0);
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(MEMORY_WORKER_SHUTDOWN_STEP_MS - 1);
    expect(events).toEqual(["drained", "liveness"]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(exit).resolves.toBe(0);
    expect(events).toEqual(["drained", "liveness", "disconnect"]);
  });

  it("closes the database without starting a stop when startup is blocked", async () => {
    const signals = new EventEmitter();
    const stopCoordinator = vi.fn(async () => undefined);
    const stopHeartbeat = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    await expect(runMemoryCoordinatorWorker({
      disconnect, signals, stopCoordinator, stopHeartbeat,
      start: async () => ({ code: "memory_suppression_historical_key_missing", missingKeyIds: ["v1"], status: "blocked" })
    })).resolves.toBe(1);
    expect(stopCoordinator).not.toHaveBeenCalled();
    expect(stopHeartbeat).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(records()).toContainEqual(expect.objectContaining({ event: "runtime_lifecycle", stage: "startup",
      outcome: "blocked", code: "memory_suppression_historical_key_missing" }));
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops, clears liveness and closes after a failed startup", async () => {
    const events: string[] = [];
    await expect(runMemoryCoordinatorWorker({
      disconnect: async () => { events.push("disconnect"); },
      signals: new EventEmitter(),
      start: async () => { throw new Error("PRIVATE_STARTUP_FAILURE"); },
      stopCoordinator: async () => { events.push("drained"); },
      stopHeartbeat: async () => { events.push("liveness"); }
    })).resolves.toBe(1);
    expect(events).toEqual(["drained", "liveness", "disconnect"]);
    expect(records()).toContainEqual(expect.objectContaining({ stage: "startup",
      code: "memory_coordinator_startup_failed" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("stops right after startup when the signal arrived while it was starting", async () => {
    const signals = new EventEmitter();
    const started = gate();
    const events: string[] = [];
    const exit = runMemoryCoordinatorWorker({
      disconnect: async () => { events.push("disconnect"); },
      signals,
      start: async () => { await started.opened; events.push("started"); return { status: "ready" }; },
      stopCoordinator: async () => { events.push("drained"); },
      stopHeartbeat: async () => { events.push("liveness"); }
    });
    signals.emit("SIGTERM");
    started.release();
    await expect(exit).resolves.toBe(0);
    expect(events).toEqual(["started", "drained", "liveness", "disconnect"]);
  });
});
