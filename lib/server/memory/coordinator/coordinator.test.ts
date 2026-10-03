import { memoryRecoveryStatusFixture } from "@/tests/support/memoryStatus";
import { rememberDatabaseFailure } from "../../observability/databaseFailure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCoordinator } from "./coordinator";
import { MemoryCoordinatorError, MemoryJobFencedError } from "./errors";
import type { MemoryCoordinatorRepository } from "./prismaRepository";
import { MemoryCoordinatorRegistry } from "./registry";
import { getContext, reportSubsystemHealthy, runWithContext, type ObservabilityContext } from "../../observability";
import { createAdminMemoryStatusService } from "../../admin/memory/statusService";
import { readMemoryCapabilityOperationalState } from "../settings/capabilities";
import {
  createPrismaMemoryWorkerHeartbeat,
  MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS
} from "./workerHeartbeat";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim,
  MemoryJobGateDecision,
  MemoryJobHandler,
  MemoryWaitingJob
} from "./types";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const RESULT_HASH = "a".repeat(64);

function jobClaim(input: Partial<MemoryJobClaim> = {}): MemoryJobClaim {
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: "job-claim-token",
    id: "job-1",
    idempotencyFingerprint: "job-idempotency-1",
    kind: "EMBED_ITEMS",
    leaseExpiresAt: new Date(NOW.getTime() + 100),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 0,
    pipelineVersion: "memory-test-v1",
    recoveredLease: false,
    sourceHash: null,
    sourceMessageId: null,
    sourceRevision: null,
    stage: null,
    targetFactVersionId: null,
    userId: "user-1",
    ...input
  };
}

function waitingJob(): MemoryWaitingJob {
  const { claimToken: _claimToken, leaseExpiresAt: _leaseExpiresAt,
    recoveredLease: _recoveredLease, ...job } = jobClaim();
  return job;
}

function deletionClaim(input: Partial<MemoryDeletionClaim> = {}): MemoryDeletionClaim {
  return {
    admissionAuthorizationId: null,
    admittedActiveLeafMessageId: null,
    admittedChatSourceRevision: null,
    alsoForgetOriginMemories: null,
    attemptCount: 1,
    claimToken: "deletion-claim-token",
    id: "deletion-1",
    leaseExpiresAt: new Date(NOW.getTime() + 100),
    memoryGeneration: 0,
    operation: "TEMPORARY_DELETE",
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: "target-1",
    targetType: "CHAT",
    userId: "user-1",
    ...input
  };
}

function repository(
  overrides: Partial<MemoryCoordinatorRepository> = {}
): MemoryCoordinatorRepository {
  return {
    cancelUnavailableJobOwners: vi.fn(async () => 0),
    claimDeletion: vi.fn(async () => null),
    claimJob: vi.fn(async () => null),
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
    terminalUnavailableJobs: vi.fn(async () => 0),
    ...overrides
  };
}

function coordinator(
  registry: MemoryCoordinatorRegistry,
  coordinatorRepository: MemoryCoordinatorRepository
): MemoryCoordinator {
  return new MemoryCoordinator({
    now: () => new Date(NOW),
    policy: {
      heartbeatMs: 10,
      intervalMs: 10_000,
      leaseMs: 100,
      maxDeletionParallel: 1,
      maxJobParallel: 1
    },
    registry,
    repository: coordinatorRepository
  });
}

describe("Memory coordinator", () => {
  it("bounds automatic recovery polling across repeated ticks and retries after a database failure", async () => {
    let now = NOW;
    const repo = repository({ recoverEligibleJobs: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(0) });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async () => ({ acceptedResultHash: RESULT_HASH }) });
    const service = new MemoryCoordinator({ now: () => now, registry, repository: repo });
    await service.reconcileNow();
    await service.reconcileNow();
    expect(repo.recoverEligibleJobs).toHaveBeenCalledTimes(1);
    now = new Date(NOW.getTime() + 60_000);
    await service.reconcileNow();
    expect(repo.recoverEligibleJobs).toHaveBeenCalledTimes(2);
    expect(repo.recoverEligibleJobs).toHaveBeenLastCalledWith({ limit: 8, now });
    await service.stop();
  });

  it("isolates concurrent jobs and deletion from startup, repeated kicks, and shared reconciliation", async () => {
    const request = { trace_id: "e".repeat(32), run_id: "request-run", job_id: "request-job" };
    const jobs = [jobClaim(), jobClaim({ id: "job-2", userId: "user-2" })];
    const deletions = [deletionClaim({ userId: "user-3" })];
    const processed = new Map<string, ObservabilityContext | undefined>();
    const resumed = new Map<string, ObservabilityContext | undefined>();
    const beats = new Map<string, ObservabilityContext | undefined>();
    const committed = new Map<string, ObservabilityContext | undefined>();
    const shared: Array<ObservabilityContext | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let heartbeatsSeen!: () => void;
    const heartbeats = new Promise<void>((resolve) => { heartbeatsSeen = resolve; });
    const recordBeat = (id: string) => {
      beats.set(id, getContext());
      if (beats.size === 3) heartbeatsSeen();
      return true;
    };
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      kind: "EMBED_ITEMS",
      preflight: async () => ({ status: "READY" }),
      async execute(claim) {
        processed.set(claim.id, getContext());
        await gate;
        resumed.set(claim.id, getContext());
        return { acceptedResultHash: RESULT_HASH };
      }
    });
    registry.registerDeletion({
      operation: "TEMPORARY_DELETE",
      async execute(claim) {
        processed.set(claim.id, getContext());
        await gate;
        resumed.set(claim.id, getContext());
        return {};
      }
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      async onWorkerHeartbeat() { shared.push(getContext()); },
      async reconcileWork() { shared.push(getContext()); },
      policy: { heartbeatMs: 10, intervalMs: 60_000, leaseMs: 100, maxDeletionParallel: 1, maxJobParallel: 2 },
      registry,
      repository: repository({
        async claimJob() { shared.push(getContext()); return jobs.shift() ?? null; },
        async claimDeletion() { shared.push(getContext()); return deletions.shift() ?? null; },
        async heartbeatJob({ claim }) { return recordBeat(claim.id); },
        async heartbeatDeletion({ claim }) { return recordBeat(claim.id); },
        async commitJobSuccess({ claim }) { committed.set(claim.id, getContext()); return true; },
        async commitDeletionSuccess({ claim }) { committed.set(claim.id, getContext()); return true; }
      })
    });
    try {
      runWithContext(request, () => service.start());
      const drain = runWithContext({ trace_id: "f".repeat(32), run_id: "next-request" }, () => service.reconcileNow());
      await heartbeats;
      release();
      await drain;

      expect(processed.size).toBe(3);
      expect(resumed).toEqual(processed);
      expect(new Set([...processed.values()].map((context) => context?.trace_id)).size).toBe(3);
      for (const [jobId, context] of processed) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u), job_id: jobId });
        expect(context?.trace_id).not.toBe(request.trace_id);
        expect(beats.get(jobId)).toEqual(context);
        expect(committed.get(jobId)).toEqual(context);
      }
      for (const context of shared) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
        expect(context?.trace_id).not.toBe(request.trace_id);
      }
    } finally {
      release();
      service.stop();
    }
  });

  it("records content-free worker liveness at startup without making one-off drains claim availability", async () => {
    const onWorkerHeartbeat = vi.fn(async () => undefined);
    const claimDeletion = vi.fn(async () => null);
    const registry = new MemoryCoordinatorRegistry();
    registry.registerDeletion({
      execute: vi.fn(),
      operation: "TEMPORARY_DELETE"
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      onWorkerHeartbeat,
      policy: {
        heartbeatMs: 10,
        intervalMs: 10_000,
        leaseMs: 100,
        maxDeletionParallel: 1,
        maxJobParallel: 1
      },
      registry,
      repository: repository({ claimDeletion })
    });

    await service.reconcileNow();
    expect(onWorkerHeartbeat).not.toHaveBeenCalled();
    service.start();
    await service.reconcileNow();
    await service.stop();

    expect(onWorkerHeartbeat).toHaveBeenCalledOnce();
  });

  it("does not turn timer ticks during a slow pass into a continuous catch-up loop", async () => {
    vi.useFakeTimers();
    let releasePass!: () => void;
    let markPassStarted!: () => void;
    const passStarted = new Promise<void>((resolve) => {
      markPassStarted = resolve;
    });
    const passGate = new Promise<void>((resolve) => {
      releasePass = resolve;
    });
    const reconcileWork = vi.fn(async () => {
      markPassStarted();
      await passGate;
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: {
        heartbeatMs: 10,
        intervalMs: 10,
        leaseMs: 100,
        maxDeletionParallel: 1,
        maxJobParallel: 1
      },
      reconcileWork,
      registry: new MemoryCoordinatorRegistry(),
      repository: repository()
    });

    try {
      service.start();
      await passStarted;
      await vi.advanceTimersByTimeAsync(35);
      releasePass();
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileWork).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(9);
      expect(reconcileWork).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileWork).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("discovers bounded durable work after servicing existing claims", async () => {
    const callOrder: string[] = [];
    const reconcileWork = vi.fn(async () => {
      callOrder.push("reconcile");
    });
    const claimJob = vi.fn(async () => {
      callOrder.push("claim");
      return null;
    });
    const claimDeletion = vi.fn(async () => {
      callOrder.push("delete");
      return null;
    });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: vi.fn(),
      kind: "EMBED_ITEMS",
      preflight: async () => ({ status: "READY" })
    });
    registry.registerDeletion({
      execute: vi.fn(),
      operation: "TEMPORARY_DELETE"
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: {
        heartbeatMs: 10,
        intervalMs: 10_000,
        leaseMs: 100,
        maxDeletionParallel: 1,
        maxJobParallel: 1
      },
      reconcileWork,
      registry,
      repository: repository({ claimDeletion, claimJob })
    });

    await service.reconcileNow();
    service.stop();

    expect(reconcileWork).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(["claim", "delete", "reconcile"]);
  });

  it("terminalises queued kinds that have no registered handler", async () => {
    const terminalUnavailableJobs = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    const claimJob = vi.fn(async () => null);
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: vi.fn(),
      kind: "EMBED_ITEMS",
      preflight: async () => ({ status: "READY" })
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: {
        heartbeatMs: 10,
        intervalMs: 10_000,
        leaseMs: 100,
        maxDeletionParallel: 1,
        maxJobParallel: 1
      },
      registry,
      repository: repository({ claimJob, terminalUnavailableJobs })
    });

    await service.reconcileNow();
    service.stop();

    expect(terminalUnavailableJobs).toHaveBeenCalledWith({
      now: NOW,
      supportedKinds: ["EMBED_ITEMS"]
    });
    expect(claimJob).toHaveBeenCalled();
  });

  it("preflights before and after work, persists stages, and commits through the lease fence", async () => {
    const claim = jobClaim();
    const claimJob = vi.fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    const setJobStage = vi.fn(async () => true);
    const commitJobSuccess = vi.fn(async () => true);
    const coordinatorRepository = repository({ claimJob, commitJobSuccess, setJobStage });
    const registry = new MemoryCoordinatorRegistry();
    const preflight = vi.fn(async () => ({ status: "READY" as const }));
    registry.registerJob({
      execute: async (_claim, context) => {
        await context.setStage("APPLIED");
        return {
          acceptedResultHash: RESULT_HASH,
          operationalCounters: { historyChunksBuilt: 2 }
        };
      },
      kind: claim.kind,
      preflight
    });
    const service = coordinator(registry, coordinatorRepository);

    await service.reconcileNow();
    service.stop();

    expect(preflight).toHaveBeenCalledTimes(2);
    expect(setJobStage).toHaveBeenCalledWith(expect.objectContaining({
      claim,
      stage: "APPLIED"
    }));
    expect(commitJobSuccess).toHaveBeenCalledWith(expect.objectContaining({
      acceptedResultHash: RESULT_HASH,
      claim,
      operationalCounters: { historyChunksBuilt: 2 },
      stage: "APPLIED"
    }));
  });

  it("releases a pre-call claim into no-lease configuration waiting", async () => {
    const claim = jobClaim();
    const claimJob = vi.fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    const settleJobGate = vi.fn(async () => true);
    const coordinatorRepository = repository({ claimJob, settleJobGate });
    const registry = new MemoryCoordinatorRegistry();
    const execute = vi.fn();
    registry.registerJob({
      execute,
      kind: claim.kind,
      preflight: async () => ({
        errorCode: "memory_execution_target_unavailable",
        status: "WAITING_FOR_CONFIGURATION"
      })
    });
    const service = coordinator(registry, coordinatorRepository);

    await service.reconcileNow();
    service.stop();

    expect(execute).not.toHaveBeenCalled();
    expect(settleJobGate).toHaveBeenCalledWith(expect.objectContaining({
      claim,
      decision: {
        errorCode: "memory_execution_target_unavailable",
        status: "WAITING_FOR_CONFIGURATION"
      }
    }));
  });

  it("rechecks waiting work and queues it only after its registered gate accepts", async () => {
    const waiting = waitingJob();
    const listWaitingJobs = vi.fn()
      .mockResolvedValueOnce([waiting])
      .mockResolvedValue([]);
    const resolveWaitingJob = vi.fn(async () => true);
    const coordinatorRepository = repository({ listWaitingJobs, resolveWaitingJob });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: vi.fn(),
      kind: waiting.kind,
      preflight: async () => ({ status: "READY" })
    });
    const service = coordinator(registry, coordinatorRepository);

    await service.reconcileNow();
    service.stop();

    expect(resolveWaitingJob).toHaveBeenCalledWith(expect.objectContaining({
      decision: { status: "READY" },
      job: waiting
    }));
  });

  it("aborts work on heartbeat lease loss without a stale commit or retry write", async () => {
    const claim = jobClaim();
    const claimJob = vi.fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    const heartbeatJob = vi.fn(async () => false);
    const commitJobSuccess = vi.fn(async () => true);
    const retryJob = vi.fn(async () => true);
    const terminalJob = vi.fn(async () => true);
    const coordinatorRepository = repository({
      claimJob,
      commitJobSuccess,
      heartbeatJob,
      retryJob,
      terminalJob
    });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: async (_claim, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), {
          once: true
        });
      }),
      kind: claim.kind,
      preflight: async () => ({ status: "READY" })
    });
    const service = coordinator(registry, coordinatorRepository);

    await service.reconcileNow();
    service.stop();

    expect(heartbeatJob).toHaveBeenCalled();
    expect(commitJobSuccess).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
    expect(terminalJob).not.toHaveBeenCalled();
  });

  it("makes exhausted deletion failures visible and keeps a slow retry", async () => {
    const claim = deletionClaim({ attemptCount: 3 });
    const claimDeletion = vi.fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    const retryDeletion = vi.fn(async () => true);
    const coordinatorRepository = repository({ claimDeletion, retryDeletion });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerDeletion({
      execute: async () => {
        throw new MemoryCoordinatorError("memory_purge_incomplete", true);
      },
      operation: claim.operation
    });
    const service = coordinator(registry, coordinatorRepository);

    await service.reconcileNow();
    service.stop();

    expect(retryDeletion).toHaveBeenCalledWith(expect.objectContaining({
      blocked: true,
      claim,
      errorCode: "memory_purge_incomplete",
      nextAttemptAt: new Date(NOW.getTime() + 15 * 60_000)
    }));
  });

  it.each([
    ["EXTRACT_FACTS", 1, "retry", "memory_learning_provider_transient"],
    ["EXTRACT_FACTS", 1, "retry", "memory_semantic_adjudication_output_invalid"],
    ["EXTRACT_FACTS", 2, "terminal", "memory_learning_provider_transient"],
    ["EXTRACT_FACTS", 2, "terminal", "memory_semantic_adjudication_output_invalid"],
    ["RESOLVE_FACT_RELATIONS", 1, "retry", "memory_learning_provider_transient"],
    ["RESOLVE_FACT_RELATIONS", 2, "terminal", "memory_learning_provider_transient"]
  ] as const)(
    "uses the two-attempt provider-learning ceiling for %s attempt %s",
    async (kind, attemptCount, expected, errorCode) => {
      const claim = jobClaim({ attemptCount, kind });
      const claimJob = vi.fn()
        .mockResolvedValueOnce(claim)
        .mockResolvedValue(null);
      const retryJob = vi.fn(async () => true);
      const terminalJob = vi.fn(async () => true);
      const commitJobSuccess = vi.fn(async () => true);
      const coordinatorRepository = repository({ claimJob, commitJobSuccess, retryJob, terminalJob });
      const registry = new MemoryCoordinatorRegistry();
      registry.registerJob({
        execute: async () => {
          throw new MemoryCoordinatorError(errorCode, true);
        },
        kind,
        preflight: async () => ({ status: "READY" })
      });
      const service = coordinator(registry, coordinatorRepository);

      await service.reconcileNow();
      service.stop();
      expect(commitJobSuccess).not.toHaveBeenCalled();

      if (expected === "retry") {
        expect(retryJob).toHaveBeenCalledWith(expect.objectContaining({
          claim,
          errorCode
        }));
        expect(terminalJob).not.toHaveBeenCalled();
      } else {
        expect(terminalJob).toHaveBeenCalledWith(expect.objectContaining({
          claim,
          errorCode
        }));
        expect(retryJob).not.toHaveBeenCalled();
      }
    }
  );

  it("bounds claims per worker pass even while the queue stays non-empty", async () => {
    const claim = jobClaim({ kind: "INDEX_HISTORY" });
    const claimJob = vi.fn(async () => claim);
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: async () => ({ acceptedResultHash: RESULT_HASH }),
      kind: claim.kind,
      preflight: async () => ({ status: "READY" })
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: {
        heartbeatMs: 10,
        intervalMs: 10_000,
        leaseMs: 100,
        maxDeletionParallel: 1,
        maxJobClaimsPerWorkerPass: 1,
        maxJobParallel: 1
      },
      registry,
      repository: repository({ claimJob })
    });

    await service.reconcileNow();
    service.stop();

    expect(claimJob).toHaveBeenCalledOnce();
  });

  it("serializes same-owner handlers without consuming the second worker", async () => {
    const claims = [
      jobClaim({ id: "job-a", kind: "INDEX_HISTORY" }),
      jobClaim({
        claimToken: "job-claim-token-b",
        id: "job-b",
        idempotencyFingerprint: "job-idempotency-b",
        kind: "INDEX_HISTORY"
      })
    ];
    const claimJob = vi.fn()
      .mockResolvedValueOnce(claims[0])
      .mockResolvedValueOnce(claims[1]);
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (execute.mock.calls.length === 1) await firstGate;
      active -= 1;
      return { acceptedResultHash: RESULT_HASH };
    });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute,
      kind: "INDEX_HISTORY",
      preflight: async () => ({ status: "READY" })
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: {
        heartbeatMs: 10,
        intervalMs: 10_000,
        leaseMs: 100,
        maxDeletionParallel: 1,
        maxJobClaimsPerWorkerPass: 1,
        maxJobParallel: 2,
        maxJobParallelPerUser: 1
      },
      registry,
      repository: repository({ claimJob })
    });

    const pending = service.reconcileNow();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(maximumActive).toBe(1);
    releaseFirst();
    await pending;
    service.stop();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it("services destructive work while an ordinary job is still running", async () => {
    const claim = jobClaim({ kind: "INDEX_HISTORY" });
    const deletion = deletionClaim();
    const claimJob = vi.fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    const claimDeletion = vi.fn()
      .mockResolvedValueOnce(deletion)
      .mockResolvedValue(null);
    let releaseJob!: () => void;
    const jobGate = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    const deletionExecute = vi.fn(async () => ({}));
    const commitDeletionSuccess = vi.fn(async () => true);
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: async () => {
        await jobGate;
        return { acceptedResultHash: RESULT_HASH };
      },
      kind: claim.kind,
      preflight: async () => ({ status: "READY" })
    });
    registry.registerDeletion({
      execute: deletionExecute,
      operation: deletion.operation
    });
    const service = coordinator(registry, repository({
      claimDeletion,
      claimJob,
      commitDeletionSuccess
    }));

    const pending = service.reconcileNow();
    await vi.waitFor(() => expect(commitDeletionSuccess).toHaveBeenCalledOnce());
    expect(deletionExecute).toHaveBeenCalledOnce();
    releaseJob();
    await pending;
    service.stop();
  });
});

describe("Memory coordinator worker liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    reportSubsystemHealthy("memory", "health");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("keeps admin and user liveness fresh throughout a long claimed job without claiming extra work", async () => {
    let lastSeenAt: Date | null = null;
    const heartbeat = createPrismaMemoryWorkerHeartbeat({
      memoryWorkerHeartbeat: {
        upsert: vi.fn(async ({ update }: { update: { lastSeenAt: Date } }) => {
          lastSeenAt = update.lastSeenAt;
        })
      }
    } as never, { instanceId: "fixture-worker", startedAt: NOW });
    const onWorkerHeartbeat = vi.fn(() => heartbeat.beat());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { acceptedResultHash: RESULT_HASH };
    });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", execute, preflight: async () => ({ status: "READY" }) });
    const repo = repository({ claimJob: vi.fn().mockResolvedValueOnce(jobClaim()).mockResolvedValue(null) });
    const service = new MemoryCoordinator({
      onWorkerHeartbeat,
      policy: { intervalMs: 60_000, maxJobParallel: 1 },
      registry,
      repository: repo
    });
    const status = createAdminMemoryStatusService({ repository: {
      read: async () => ({
        searchTimeout: { seconds: 30, version: 1 },
        processing: { enabled: true, issues: [] },
        configuredTargets: [],
        index: { activeGenerations: [], ownerCount: 0, preparing: false,
          rebuildCandidates: [], rebuilding: false, requiresRebuild: false },
        inProgressCount: 1,
        oldestQueuedAt: null,
        queueLength: 0,
        recovery: memoryRecoveryStatusFixture(),
        workerReady: true,
        workerActiveStages: ["INDEXING"],
        workerHasStalledClaims: false,
        workerLastProgressAt: NOW,
        workerLastSuccessfulJobAt: null,
        workerLastSeenAt: lastSeenAt
      }),
      startRebuild: vi.fn(),
      recoverEligible: vi.fn(async () => 0),
      updateSearchTimeout: vi.fn()
    } });
    const userState = () => readMemoryCapabilityOperationalState({
      memoryIndexGeneration: { findFirst: vi.fn() },
      memoryWorkerHeartbeat: { findUnique: async () => lastSeenAt ? { lastSeenAt, ready: true } : null }
    } as never, {
      now: new Date(),
      settings: {
        acceptedUtilityEgressAt: null, acceptedUtilityEgressFingerprint: null, acceptedUtilityPolicyVersion: null,
        activeIndexGenerationId: null, decayEnabled: false, decayPolicyVersion: null,
        embeddingProviderModelId: null, learnAutomatically: true, memoryConsentRevision: 0,
        memoryGeneration: 0, memoryRevision: 0, referenceChatHistory: true,
        sensitiveAutomaticPolicy: "EXPLICIT_ONLY", settingsRevision: 0,
        updatedAt: NOW, useMemoryFacts: true, userId: "user-1"
      }
    });
    try {
      service.start();
      const pending = service.reconcileNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledOnce();
      expect(onWorkerHeartbeat).toHaveBeenCalledOnce();
      service.start();
      service.start();
      for (let step = 0; step < 10; step += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(status.get()).resolves.toMatchObject({
          queue: { inProgress: 1, length: 0, oldestAgeSeconds: null },
          worker: { state: "RUNNING" }
        });
        await expect(userState()).resolves.toMatchObject({ workerAvailable: true });
      }
      expect(Date.now() - NOW.getTime()).toBeGreaterThan(MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS);
      expect(onWorkerHeartbeat).toHaveBeenCalledTimes(11);
      expect(repo.claimJob).toHaveBeenCalledOnce();
      expect(repo.heartbeatJob).toHaveBeenCalled();
      expect(repo.commitJobSuccess).not.toHaveBeenCalled();
      release();
      await pending;
      expect(repo.commitJobSuccess).toHaveBeenCalledOnce();
      await service.stop();
      const beatCount = onWorkerHeartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS + 1);
      expect(onWorkerHeartbeat).toHaveBeenCalledTimes(beatCount);
      expect(vi.getTimerCount()).toBe(0);
      await expect(status.get()).resolves.toMatchObject({ worker: { state: "NOT_RUNNING" } });
      await expect(userState()).resolves.toMatchObject({ workerAvailable: false });
    } finally {
      release();
      await service.stop();
    }
  });

  it("serializes slow heartbeat writes, drains one at stop and starts only one replacement loop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onWorkerHeartbeat = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const service = new MemoryCoordinator({
      onWorkerHeartbeat, registry: new MemoryCoordinatorRegistry(), repository: repository()
    });
    try {
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(onWorkerHeartbeat).toHaveBeenCalledOnce();
      const stopped = vi.fn();
      const stopping = service.stop().then(stopped);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(stopped).not.toHaveBeenCalled();
      expect(onWorkerHeartbeat).toHaveBeenCalledOnce();
      release();
      await stopping;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(onWorkerHeartbeat).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onWorkerHeartbeat).toHaveBeenCalledTimes(4);
      await service.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); await service.stop(); }
  });

  it("contains failed liveness writes while job leases and completion remain authoritative", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signal: AbortSignal | undefined;
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async (_claim, context) => {
        signal = context.signal;
        await gate;
        return { acceptedResultHash: RESULT_HASH };
      }
    });
    const repo = repository({ claimJob: vi.fn().mockResolvedValueOnce(jobClaim()).mockResolvedValue(null) });
    const onWorkerHeartbeat = vi.fn()
      .mockRejectedValueOnce(new Error("PRIVATE_HEARTBEAT_PAYLOAD"))
      .mockRejectedValueOnce(new Error("PRIVATE_HEARTBEAT_PAYLOAD"))
      .mockResolvedValue(undefined);
    const contexts: Array<ObservabilityContext | undefined> = [];
    const service = new MemoryCoordinator({
      onWorkerHeartbeat: () => { contexts.push(getContext()); return onWorkerHeartbeat(); },
      registry, repository: repo
    });
    try {
      runWithContext({ trace_id: "b".repeat(32), run_id: "PRIVATE_REQUEST" }, () => service.start());
      const pending = service.reconcileNow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onWorkerHeartbeat).toHaveBeenCalledTimes(3);
      expect(signal?.aborted).toBe(false);
      expect(repo.heartbeatJob).toHaveBeenCalled();
      release();
      await pending;
      expect(repo.commitJobSuccess).toHaveBeenCalledOnce();
      expect(repo.retryJob).not.toHaveBeenCalled();
      expect(repo.terminalJob).not.toHaveBeenCalled();
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
      expect(records.filter((record) => record.stage === "health")).toEqual([
        expect.objectContaining({ event: "runtime_lifecycle", code: "memory_coordinator_failed", outcome: "failed" }),
        expect.objectContaining({ event: "runtime_lifecycle", code: "memory_coordinator_failed", outcome: "failed" }),
        expect.objectContaining({ event: "subsystem.recovered", repeat_count: 1 })
      ]);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
      for (const context of contexts) {
        expect(context).toEqual({ trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u) });
        expect(context?.trace_id).not.toBe("b".repeat(32));
      }
    } finally { release(); await service.stop(); }
  });
});


describe("Memory job diagnostics", () => {
  beforeEach(() => {
    for (const stage of ["claim", "discover", "reconcile", "preflight", "heartbeat", "health"] as const) {
      reportSubsystemHealthy("memory", stage);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function capture() {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    return () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
  }

  it("keeps each processing failure before its retry write and distinguishes true, false, and rejection", async () => {
    const records = capture();
    const queued = ["confirmed", "stale", "rejected"].map((id) => jobClaim({ id }));
    const databaseError = new Error("PRIVATE_DATABASE_PAYLOAD");
    rememberDatabaseFailure(databaseError, "P1001");
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async () => {
        const error = new MemoryCoordinatorError("memory_job_failed", true);
        error.message = "PRIVATE_PROCESSING_PAYLOAD";
        throw error;
      }
    });
    const retries = new Map<string, Date>();
    const service = coordinator(registry, repository({
      claimJob: vi.fn(async () => queued.shift() ?? null),
      retryJob: vi.fn(async ({ claim, nextAttemptAt }) => {
        expect(records().at(-1)).toMatchObject({
          event: "job_attempt", job_id: claim.id, outcome: "failed", action: "retry", code: "memory_job_failed"
        });
        retries.set(claim.id, nextAttemptAt);
        if (claim.id === "rejected") throw databaseError;
        return claim.id === "confirmed";
      })
    }));
    await runWithContext({ trace_id: "a".repeat(32), run_id: "PRIVATE_REQUEST_RUN" }, () => service.reconcileNow());
    const observed = records();
    expect(observed).toHaveLength(9);
    const writes = observed.filter((record) => record.event === "job_persistence");
    expect(writes).toEqual([
      expect.objectContaining({ job_id: "confirmed", outcome: "confirmed", delay_ms: 1000,
        retry_at: retries.get("confirmed")!.toISOString() }),
      expect.objectContaining({ job_id: "stale", outcome: "not_applied" }),
      expect.objectContaining({ job_id: "rejected", outcome: "unconfirmed", prisma_code: "P1001", level: "error" })
    ]);
    for (const write of writes.slice(1)) {
      expect(write).not.toHaveProperty("retry_at");
      expect(write).not.toHaveProperty("delay_ms");
    }
    for (const jobId of retries.keys()) {
      const jobRecords = observed.filter((record) => record.job_id === jobId);
      expect(new Set(jobRecords.map((record) => record.trace_id)).size).toBe(1);
      expect(jobRecords.every((record) => !Object.hasOwn(record, "run_id"))).toBe(true);
    }
    expect(new Set(writes.map((record) => record.trace_id)).size).toBe(3);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
  });

  it("records success only at the guarded commit and retains lost ownership without retry", async () => {
    const records = capture();
    const queued = [jobClaim({ id: "success", recoveredLease: true }), jobClaim({ id: "lease-lost" })];
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async () => ({ acceptedResultHash: RESULT_HASH }) });
    const repo = repository({
      claimJob: vi.fn(async () => queued.shift() ?? null),
      commitJobSuccess: vi.fn(async ({ claim }) => claim.id === "success")
    });
    await coordinator(registry, repo).reconcileNow();
    expect(records()).toHaveLength(5);
    expect(records()).toContainEqual(expect.objectContaining({ job_id: "success", stage: "recovery", outcome: "started" }));
    expect(records()).toContainEqual(expect.objectContaining({ job_id: "success", event: "job_persistence", stage: "complete", outcome: "confirmed" }));
    expect(records()).toContainEqual(expect.objectContaining({ job_id: "lease-lost", event: "job_persistence", outcome: "not_applied" }));
    expect(records().at(-1)).toMatchObject({ job_id: "lease-lost", outcome: "lost_lease", level: "info" });
    expect(repo.retryJob).not.toHaveBeenCalled();
    expect(repo.terminalJob).not.toHaveBeenCalled();
  });

  it("retains the processing and persistence failures when terminal settlement also fails", async () => {
    const records = capture();
    const queued = [jobClaim({ attemptCount: 3 })];
    const commitFailure = new Error("PRIVATE_COMMIT");
    const terminalFailure = new Error("PRIVATE_TERMINAL");
    rememberDatabaseFailure(commitFailure, "P2028");
    rememberDatabaseFailure(terminalFailure, "P1001");
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async () => ({ acceptedResultHash: RESULT_HASH }) });
    const repo = repository({
      claimJob: vi.fn(async () => queued.shift() ?? null),
      commitJobSuccess: async () => { throw commitFailure; },
      terminalJob: async () => {
        expect(records().at(-1)).toMatchObject({ event: "job_attempt", stage: "complete", outcome: "failed",
          prisma_code: "P2028", action: "fail" });
        throw terminalFailure;
      }
    });
    await coordinator(registry, repo).reconcileNow();
    expect(records()).toHaveLength(4);
    expect(records()[1]).toMatchObject({ event: "job_persistence", stage: "complete", outcome: "unconfirmed", prisma_code: "P2028" });
    expect(records()[3]).toMatchObject({ event: "job_persistence", stage: "fail", outcome: "unconfirmed", prisma_code: "P1001" });
    expect(repo.retryJob).not.toHaveBeenCalled();
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("projects progress separately from publication and keeps stale processing informational", async () => {
    const records = capture();
    const queued = [jobClaim()];
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async (_claim, context) => {
        await context.setStage("authorized_apply");
        await context.setStage("PRIVATE_STAGE");
        throw new MemoryCoordinatorError("memory_embedding_binding_stale", false);
      } });
    const repo = repository({ claimJob: async () => queued.shift() ?? null });
    await coordinator(registry, repo).reconcileNow();
    expect(records()).toContainEqual(expect.objectContaining({ event: "job_persistence", stage: "progress",
      work_stage: "publish", outcome: "confirmed" }));
    expect(records()).toContainEqual(expect.objectContaining({ event: "job_persistence", stage: "progress",
      work_stage: "progress", outcome: "confirmed" }));
    expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", outcome: "stale", level: "info" }));
    expect(repo.terminalJob).toHaveBeenCalledOnce();
    expect(records().some((record) => record.stage === "publish" && record.outcome === "confirmed")).toBe(false);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("does not let a healthy job lane hide repeated deletion claim failures", async () => {
    const records = capture();
    let unavailable = true;
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }), execute: vi.fn() });
    registry.registerDeletion({ operation: "TEMPORARY_DELETE", execute: vi.fn() });
    const service = coordinator(registry, repository({ claimDeletion: async () => {
      if (unavailable) throw new Error("PRIVATE_DELETION_CLAIM");
      return null;
    } }));
    for (let pass = 0; pass < 10; pass += 1) await service.reconcileNow();
    expect(records()).toHaveLength(1);
    unavailable = false;
    await service.reconcileNow();
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ event: "subsystem.recovered", stage: "claim", repeat_count: 9 });
  });

  it("preserves heartbeat-failure cancellation and reports recovery from the next successful owned heartbeat", async () => {
    vi.useFakeTimers();
    const records = capture();
    const queued = [jobClaim({ id: "heartbeat-failure" }), jobClaim({ id: "heartbeat-recovery" })];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: "EMBED_ITEMS", preflight: async () => ({ status: "READY" }),
      execute: async (claim, { signal }) => {
        if (claim.id === "heartbeat-failure") await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        else await gate;
        return { acceptedResultHash: RESULT_HASH };
      } });
    const repo = repository({ claimJob: async () => queued.shift() ?? null,
      heartbeatJob: async ({ claim }) => {
        if (claim.id === "heartbeat-failure") throw new Error("PRIVATE_HEARTBEAT");
        return true;
      } });
    const pending = coordinator(registry, repo).reconcileNow();
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(records()).toContainEqual(expect.objectContaining({ event: "job_persistence", job_id: "heartbeat-failure",
        stage: "heartbeat", outcome: "unconfirmed" }));
      expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", job_id: "heartbeat-failure",
        outcome: "cancelled", level: "info" }));
      expect(records().filter((record) => record.event === "subsystem.recovered")).toEqual([
        expect.objectContaining({ subsystem: "memory", stage: "heartbeat" })
      ]);
      expect(repo.retryJob).not.toHaveBeenCalled();
      expect(repo.terminalJob).not.toHaveBeenCalled();
      expect(JSON.stringify(records())).not.toContain("PRIVATE_");
    } finally { release(); await pending; }
  });

  it("keeps blocked deletions retryable and confirms their actual next attempt", async () => {
    const records = capture();
    const queued = [deletionClaim({ attemptCount: 4, resumedFromBlocked: true })];
    const registry = new MemoryCoordinatorRegistry();
    registry.registerDeletion({ operation: "TEMPORARY_DELETE", execute: async () => {
      throw new MemoryCoordinatorError("memory_deletion_failed", true);
    } });
    const retryDeletion = vi.fn(async () => true);
    await coordinator(registry, repository({
      claimDeletion: vi.fn(async () => queued.shift() ?? null), retryDeletion
    })).reconcileNow();
    expect(records()).toHaveLength(3);
    expect(records()[1]).toMatchObject({ outcome: "blocked", action: "retry", level: "warn" });
    expect(records()[2]).toMatchObject({ outcome: "confirmed", stage: "retry", delay_ms: 900000,
      retry_at: new Date(NOW.getTime() + 900000).toISOString() });
    expect(retryDeletion).toHaveBeenCalledWith(expect.objectContaining({ blocked: true }));
  });

  it("keeps idle silent, bounds repeated discovery failures, and reports one recovery without request context", async () => {
    const records = capture();
    const registry = new MemoryCoordinatorRegistry();
    let unavailable = false;
    const service = new MemoryCoordinator({
      registry, repository: repository(), reconcileWork: async () => {
        if (unavailable) throw new Error("PRIVATE_DISCOVERY");
      }
    });
    for (let pass = 0; pass < 20; pass += 1) await service.reconcileNow();
    expect(records()).toHaveLength(0);
    unavailable = true;
    for (let pass = 0; pass < 20; pass += 1) {
      await runWithContext({ trace_id: "b".repeat(32), run_id: "PRIVATE_RUN" }, () => service.reconcileNow());
    }
    expect(records()).toHaveLength(1);
    unavailable = false;
    await service.reconcileNow();
    await service.reconcileNow();
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ event: "subsystem.recovered", subsystem: "memory", stage: "discover", repeat_count: 19 });
    for (const record of records()) {
      expect(record).not.toHaveProperty("run_id");
      expect(record).not.toHaveProperty("job_id");
      expect(record).not.toHaveProperty("trace_id");
    }
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });
});

describe("Memory job fences outrank failures", () => {
  const fenced = () => new MemoryJobFencedError("memory_history_job_invalid", {
    errorCode: "memory_source_stale", status: "STALE"
  });

  beforeEach(() => {
    for (const stage of ["claim", "discover", "reconcile", "preflight", "heartbeat", "health"] as const) {
      reportSubsystemHealthy("memory", stage);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** The first gate admits the claim; the job then fails and `regate`
   * answers every later gate run. */
  async function failedJob(input: Readonly<{
    claim?: MemoryJobClaim;
    failure: unknown;
    regate: () => Promise<MemoryJobGateDecision>;
  }>) {
    const claim = input.claim ?? jobClaim();
    const repo = repository({
      claimJob: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null)
    });
    const preflight = vi.fn<MemoryJobHandler["preflight"]>()
      .mockResolvedValueOnce({ status: "READY" })
      .mockImplementation(input.regate);
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({ kind: claim.kind, preflight, execute: async () => { throw input.failure; } });
    const service = coordinator(registry, repo);
    await service.reconcileNow();
    await service.stop();
    return { claim, preflight, repo };
  }

  it.each([
    { errorCode: "memory_source_stale", status: "STALE" },
    { errorCode: "memory_history_disabled", status: "CANCELLED" }
  ] as const)("settles a fenced job with the re-run gate's $status decision", async (decision) => {
    const { claim, preflight, repo } = await failedJob({ failure: fenced(), regate: async () => decision });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(repo.settleJobGate).toHaveBeenCalledExactlyOnceWith({ claim, decision, now: NOW });
    expect(repo.terminalJob).not.toHaveBeenCalled();
    expect(repo.retryJob).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", async (): Promise<MemoryJobGateDecision> => { throw new Error("PRIVATE_GATE"); }],
    ["waits for configuration", async (): Promise<MemoryJobGateDecision> => ({
      errorCode: "memory_execution_target_unavailable", status: "WAITING_FOR_CONFIGURATION"
    })],
    ["returns an invalid decision", async (): Promise<MemoryJobGateDecision> => ({
      errorCode: "Private gate detail", status: "STALE"
    })]
  ] as const)("keeps a proven fence's own decision when the re-run gate %s", async (_name, regate) => {
    const { claim, repo } = await failedJob({ failure: fenced(), regate });
    expect(repo.settleJobGate).toHaveBeenCalledExactlyOnceWith({ claim, now: NOW,
      decision: { errorCode: "memory_source_stale", status: "STALE" } });
    expect(repo.terminalJob).not.toHaveBeenCalled();
  });

  it("keeps today's terminal failure when the re-run gate still accepts a fenced claim", async () => {
    const { claim, preflight, repo } = await failedJob({ failure: fenced(), regate: async () => ({ status: "READY" }) });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(repo.terminalJob).toHaveBeenCalledExactlyOnceWith({ claim, errorCode: "memory_history_job_invalid", now: NOW });
    expect(repo.settleJobGate).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-retryable failure", jobClaim(), new MemoryCoordinatorError("memory_fact_binding_stale", false)],
    ["an exhausted retryable failure", jobClaim({ attemptCount: 3 }), new Error("PRIVATE_PROCESSING")]
  ] as const)("settles %s whose gate now rejects the job instead of failing it", async (_name, claim, failure) => {
    const decision = { errorCode: "memory_maintenance_source_stale", status: "STALE" } as const;
    const { preflight, repo } = await failedJob({ claim, failure, regate: async () => decision });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(repo.settleJobGate).toHaveBeenCalledExactlyOnceWith({ claim, decision, now: NOW });
    expect(repo.terminalJob).not.toHaveBeenCalled();
    expect(repo.retryJob).not.toHaveBeenCalled();
  });

  it.each([
    ["accepts the job", async (): Promise<MemoryJobGateDecision> => ({ status: "READY" })],
    ["waits for configuration", async (): Promise<MemoryJobGateDecision> => ({
      errorCode: "memory_execution_target_unavailable", status: "WAITING_FOR_CONFIGURATION"
    })],
    ["throws", async (): Promise<MemoryJobGateDecision> => { throw new Error("PRIVATE_GATE"); }],
    ["returns an invalid decision", async (): Promise<MemoryJobGateDecision> => ({
      errorCode: "Private gate detail", status: "CANCELLED"
    })]
  ] as const)("keeps a genuine failure terminal when the re-run gate %s", async (_name, regate) => {
    const { claim, preflight, repo } = await failedJob({
      failure: new MemoryCoordinatorError("memory_history_classification_invalid", false), regate
    });
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(repo.terminalJob).toHaveBeenCalledExactlyOnceWith({
      claim, errorCode: "memory_history_classification_invalid", now: NOW
    });
    expect(repo.settleJobGate).not.toHaveBeenCalled();
  });

  it("neither re-gates a failure that will be retried nor an owned lease loss", async () => {
    const regate = vi.fn(async (): Promise<MemoryJobGateDecision> => ({
      errorCode: "memory_source_stale", status: "STALE"
    }));
    const retried = await failedJob({ failure: new MemoryCoordinatorError("memory_job_failed", true), regate });
    expect(retried.repo.retryJob).toHaveBeenCalledOnce();
    const lost = await failedJob({ failure: new MemoryCoordinatorError("memory_job_lease_lost", false), regate });
    expect(lost.repo.terminalJob).toHaveBeenCalledOnce();
    expect(regate).not.toHaveBeenCalled();
    for (const { repo } of [retried, lost]) expect(repo.settleJobGate).not.toHaveBeenCalled();
  });

  it("records the fenced failure and the settled gate decision content-free", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const records = () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
    await failedJob({ failure: fenced(), regate: async () => ({ errorCode: "memory_source_stale", status: "STALE" }) });
    expect(records().filter((record) => record.job_id === "job-1").slice(-3)).toEqual([
      expect.objectContaining({ event: "job_attempt", code: "memory_history_job_invalid",
        outcome: "stale", action: "none", level: "info" }),
      expect.objectContaining({ event: "job_attempt", stage: "preflight", code: "memory_source_stale",
        outcome: "stale", level: "info" }),
      expect.objectContaining({ event: "job_persistence", stage: "preflight", code: "memory_source_stale",
        outcome: "confirmed" })
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });
});

describe("Memory coordinator while one job runs long", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  function gated() {
    const releases: Array<() => void> = [];
    return {
      release: (index: number) => releases[index]!(),
      wait: () => new Promise<void>((resolve) => { releases.push(resolve); })
    };
  }

  function busyCoordinator(input: Readonly<{
    deletion?: () => Promise<void>;
    job: () => Promise<void>;
    reconcileWork: () => Promise<void>;
  }>) {
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: async () => { await input.job(); return { acceptedResultHash: RESULT_HASH }; },
      kind: "INDEX_HISTORY",
      preflight: async () => ({ status: "READY" })
    });
    if (input.deletion) {
      const deletion = input.deletion;
      registry.registerDeletion({
        execute: async () => { await deletion(); return {}; },
        operation: "TEMPORARY_DELETE"
      });
    }
    const commitJobSuccess = vi.fn(async () => true);
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: { heartbeatMs: 10, intervalMs: 100, leaseMs: 1_000, maxDeletionParallel: 1, maxJobParallel: 1 },
      reconcileWork: input.reconcileWork,
      registry,
      repository: repository({
        claimDeletion: vi.fn().mockResolvedValueOnce(deletionClaim()).mockResolvedValue(null),
        claimJob: vi.fn().mockResolvedValueOnce(jobClaim({ kind: "INDEX_HISTORY" })).mockResolvedValue(null),
        commitJobSuccess
      })
    });
    return { commitJobSuccess, service };
  }

  it("keeps discovering at the coordinator interval while one job outlasts it", async () => {
    const job = gated();
    const reconcileWork = vi.fn(async () => undefined);
    const { commitJobSuccess, service } = busyCoordinator({ job: job.wait, reconcileWork });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(99);
      expect(reconcileWork).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcileWork).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcileWork).toHaveBeenCalledTimes(11);
      expect(commitJobSuccess).not.toHaveBeenCalled();

      job.release(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(commitJobSuccess).toHaveBeenCalledOnce();
      // The pass still ends with its own discovery after claims and reconciliation.
      expect(reconcileWork).toHaveBeenCalledTimes(12);
    } finally {
      await service.stop();
    }
  });

  it("never overlaps discovery passes across cadence ticks and the end of the pass", async () => {
    const job = gated();
    const discovery = gated();
    let active = 0;
    let maximumActive = 0;
    const reconcileWork = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await discovery.wait();
      active -= 1;
    });
    const { service } = busyCoordinator({ job: job.wait, reconcileWork });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(reconcileWork).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcileWork).toHaveBeenCalledTimes(1);

      job.release(0);
      await vi.advanceTimersByTimeAsync(0);
      // The end-of-pass discovery waits for the busy-phase pass.
      expect(reconcileWork).toHaveBeenCalledTimes(1);
      discovery.release(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileWork).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcileWork).toHaveBeenCalledTimes(2);
      discovery.release(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(maximumActive).toBe(1);
    } finally {
      await service.stop();
    }
  });

  it("lets privacy-critical deletions of the pass finish before busy-phase discovery", async () => {
    const job = gated();
    const deletion = gated();
    const reconcileWork = vi.fn(async () => undefined);
    const { service } = busyCoordinator({ deletion: deletion.wait, job: job.wait, reconcileWork });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(reconcileWork).not.toHaveBeenCalled();
      deletion.release(0);
      await vi.advanceTimersByTimeAsync(99);
      expect(reconcileWork).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcileWork).toHaveBeenCalledTimes(1);
    } finally {
      job.release(0);
      await service.stop();
    }
  });

  it("stops the discovery cadence at shutdown even while a job is still running", async () => {
    const job = gated();
    const reconcileWork = vi.fn(async () => undefined);
    const { service } = busyCoordinator({ job: job.wait, reconcileWork });
    service.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcileWork).toHaveBeenCalledTimes(1);
    await service.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcileWork).toHaveBeenCalledTimes(1);

    // A stopped coordinator arms neither cadence once the running job settles.
    job.release(0);
    await vi.advanceTimersByTimeAsync(0);
    const settled = reconcileWork.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcileWork).toHaveBeenCalledTimes(settled);
  });

  function idleSlotCoordinator() {
    const longJob = gated();
    const queue: MemoryJobClaim[] = [jobClaim({ id: "job-long", kind: "INDEX_HISTORY" })];
    const claimJob = vi.fn(async () => queue.shift() ?? null);
    const executed: string[] = [];
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob({
      execute: async (claim) => {
        executed.push(claim.id);
        if (claim.id === "job-long") await longJob.wait();
        return { acceptedResultHash: RESULT_HASH };
      },
      kind: "INDEX_HISTORY",
      preflight: async () => ({ status: "READY" })
    });
    const reconcileWork = vi.fn(async () => undefined);
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      policy: { heartbeatMs: 10, intervalMs: 100, leaseMs: 1_000, maxDeletionParallel: 1, maxJobParallel: 2 },
      reconcileWork,
      registry,
      repository: repository({ claimJob })
    });
    return { claimJob, executed, queue, reconcileWork, release: () => longJob.release(0), service };
  }

  it("lets an idle slot claim work enqueued during a long job once per interval", async () => {
    const { claimJob, executed, queue, release, service } = idleSlotCoordinator();
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(executed).toEqual(["job-long"]);
      expect(claimJob).toHaveBeenCalledTimes(2);
      // The idle slot claims again once per interval, never in a tight loop.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(claimJob).toHaveBeenCalledTimes(12);

      queue.push(jobClaim({ id: "job-later", kind: "INDEX_HISTORY", userId: "user-2" }));
      await vi.advanceTimersByTimeAsync(99);
      expect(executed).toEqual(["job-long"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(executed).toEqual(["job-long", "job-later"]);
      expect(claimJob).toHaveBeenCalledTimes(14);
    } finally {
      release();
      await service.stop();
    }
  });

  it("releases a waiting idle slot at shutdown", async () => {
    const { claimJob, release, service } = idleSlotCoordinator();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimJob).toHaveBeenCalledTimes(2);
    await service.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claimJob).toHaveBeenCalledTimes(2);

    release();
    await service.reconcileNow();
    expect(claimJob).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the pass as before once the long job settles", async () => {
    const { claimJob, reconcileWork, release, service } = idleSlotCoordinator();
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(250);
      expect(claimJob).toHaveBeenCalledTimes(4);
      expect(reconcileWork).toHaveBeenCalledTimes(2);

      release();
      await vi.advanceTimersByTimeAsync(0);
      // Only the finished slot's own empty claim; the idle slot exits unclaimed.
      expect(claimJob).toHaveBeenCalledTimes(5);
      expect(reconcileWork).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(99);
      expect(claimJob).toHaveBeenCalledTimes(5);
      // The next ordinary pass starts from the coordinator timer.
      await vi.advanceTimersByTimeAsync(1);
      expect(claimJob).toHaveBeenCalledTimes(7);
    } finally {
      await service.stop();
    }
  });
});
