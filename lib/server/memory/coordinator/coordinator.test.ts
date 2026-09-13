import { rememberDatabaseFailure } from "../../observability/databaseFailure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCoordinator } from "./coordinator";
import { MemoryCoordinatorError } from "./errors";
import type { MemoryCoordinatorRepository } from "./prismaRepository";
import { MemoryCoordinatorRegistry } from "./registry";
import { getContext, reportSubsystemHealthy, runWithContext, type ObservabilityContext } from "../../observability";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim,
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
      async onDrain() { shared.push(getContext()); },
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

  it("records content-free worker liveness once at the start of an idle drain", async () => {
    const onDrain = vi.fn(async () => undefined);
    const claimDeletion = vi.fn(async () => null);
    const registry = new MemoryCoordinatorRegistry();
    registry.registerDeletion({
      execute: vi.fn(),
      operation: "TEMPORARY_DELETE"
    });
    const service = new MemoryCoordinator({
      now: () => new Date(NOW),
      onDrain,
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
    service.stop();

    expect(onDrain).toHaveBeenCalledOnce();
    expect(onDrain.mock.invocationCallOrder[0])
      .toBeLessThan(claimDeletion.mock.invocationCallOrder[0]!);
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
    ["EXTRACT_FACTS", 1, "retry"],
    ["EXTRACT_FACTS", 2, "terminal"],
    ["RESOLVE_FACT_RELATIONS", 1, "retry"],
    ["RESOLVE_FACT_RELATIONS", 2, "terminal"]
  ] as const)(
    "uses the two-attempt provider-learning ceiling for %s attempt %s",
    async (kind, attemptCount, expected) => {
      const claim = jobClaim({ attemptCount, kind });
      const claimJob = vi.fn()
        .mockResolvedValueOnce(claim)
        .mockResolvedValue(null);
      const retryJob = vi.fn(async () => true);
      const terminalJob = vi.fn(async () => true);
      const coordinatorRepository = repository({ claimJob, retryJob, terminalJob });
      const registry = new MemoryCoordinatorRegistry();
      registry.registerJob({
        execute: async () => {
          throw new MemoryCoordinatorError("memory_learning_provider_transient", true);
        },
        kind,
        preflight: async () => ({ status: "READY" })
      });
      const service = coordinator(registry, coordinatorRepository);

      await service.reconcileNow();
      service.stop();

      if (expected === "retry") {
        expect(retryJob).toHaveBeenCalledWith(expect.objectContaining({
          claim,
          errorCode: "memory_learning_provider_transient"
        }));
        expect(terminalJob).not.toHaveBeenCalled();
      } else {
        expect(terminalJob).toHaveBeenCalledWith(expect.objectContaining({
          claim,
          errorCode: "memory_learning_provider_transient"
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
