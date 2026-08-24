import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinator } from "./coordinator";
import { MemoryCoordinatorError } from "./errors";
import type { MemoryCoordinatorRepository } from "./prismaRepository";
import { MemoryCoordinatorRegistry } from "./registry";
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
        return { acceptedResultHash: RESULT_HASH };
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
      stage: "APPLIED"
    }));
  });

  it("releases a pre-call claim into no-lease consent waiting", async () => {
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
        errorCode: "memory_egress_consent_required",
        status: "WAITING_FOR_EGRESS_CONSENT"
      })
    });
    const service = coordinator(registry, coordinatorRepository);

    await service.reconcileNow();
    service.stop();

    expect(execute).not.toHaveBeenCalled();
    expect(settleJobGate).toHaveBeenCalledWith(expect.objectContaining({
      claim,
      decision: {
        errorCode: "memory_egress_consent_required",
        status: "WAITING_FOR_EGRESS_CONSENT"
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
