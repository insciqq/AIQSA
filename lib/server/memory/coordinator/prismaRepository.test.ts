import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinatorError } from "./errors";
import type { MemoryJobClaim } from "./types";
import {
  createPrismaMemoryCoordinatorRepository,
  preflightPrismaMemoryJobLifecycle
} from "./prismaRepository";

function jobClaim(): MemoryJobClaim {
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: "job-commit-claim",
    id: "job-commit",
    idempotencyFingerprint: "f".repeat(64),
    kind: "REBUILD_INDEX",
    leaseExpiresAt: new Date("2026-08-21T10:05:00.000Z"),
    memoryGenerationSnapshot: 4,
    memoryRevisionSnapshot: 9,
    pipelineVersion: "memory-rebuild-v1",
    recoveredLease: false,
    sourceHash: null,
    sourceMessageId: null,
    sourceRevision: null,
    stage: null,
    targetFactVersionId: null,
    userId: "user-1"
  };
}

describe("Prisma memory coordinator repository preflight", () => {
  it("checks schema bindings before the rollback-only lifecycle probe", async () => {
    const queryRaw = vi.fn(async () => []);
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({ $queryRaw: queryRaw }));
    const preflightJobLifecycle = vi.fn(async () => undefined);
    const client = { $transaction: transaction };
    const repository = createPrismaMemoryCoordinatorRepository(
      client as never,
      { preflightJobLifecycle }
    );

    await repository.preflight?.();

    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(preflightJobLifecycle).toHaveBeenCalledOnce();
  });

  it("provides a durable terminal path for unsupported kinds", async () => {
    const executeRaw = vi.fn(async () => 2);
    const client = { $executeRaw: executeRaw };
    const repository = createPrismaMemoryCoordinatorRepository(
      client as never
    );

    await expect(repository.terminalUnavailableJobs?.({
      now: new Date("2026-08-21T00:00:00.000Z"),
      supportedKinds: ["INDEX_HISTORY"]
    })).resolves.toBe(2);
    expect(executeRaw).toHaveBeenCalledOnce();
  });

  it.each([
    new Prisma.PrismaClientKnownRequestError("serialization conflict", {
      clientVersion: "6.19.3",
      code: "P2034"
    }),
    new Prisma.PrismaClientKnownRequestError("serialization conflict", {
      clientVersion: "6.19.3",
      code: "P2010",
      meta: { code: "40001" }
    })
  ])("retries only the rollback-safe commit transaction", async (conflict) => {
    const apply = vi.fn(async (_tx: unknown, _claim: MemoryJobClaim) => undefined);
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "job-commit" }]),
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    let attempt = 0;
    const transaction = vi.fn(async (
      consume: (value: typeof tx) => Promise<boolean>
    ) => {
      attempt += 1;
      const result = await consume(tx);
      if (attempt === 1) throw conflict;
      return result;
    });
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never);

    await expect(repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64),
      apply,
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "consolidation_applied"
    })).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]?.[1]).toEqual(jobClaim());
    expect(apply.mock.calls[1]?.[1]).toEqual(jobClaim());
    expect(tx.memoryJob.updateMany).toHaveBeenCalledTimes(2);
  });

  it("does not replay the commit closure after an ambiguous database failure", async () => {
    const apply = vi.fn(async (_tx: unknown, _claim: MemoryJobClaim) => undefined);
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "job-commit" }]),
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const failure = new Error("connection_lost_after_commit");
    const transaction = vi.fn(async (
      consume: (value: typeof tx) => Promise<boolean>
    ) => {
      await consume(tx);
      throw failure;
    });
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never);

    await expect(repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64),
      apply,
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "consolidation_applied"
    })).rejects.toMatchObject({
      code: "memory_job_commit_failed",
      retryable: false
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("preserves an explicit coordinator failure from the commit closure", async () => {
    const failure = new MemoryCoordinatorError("memory_job_gate_unavailable", true);
    const apply = vi.fn(async () => {
      throw failure;
    });
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "job-commit" }]),
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const transaction = vi.fn(async (
      consume: (value: typeof tx) => Promise<boolean>
    ) => consume(tx));
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never);

    await expect(repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64),
      apply,
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "consolidation_applied"
    })).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("reaches success through production transitions and leaves no probe residue", async () => {
    let durableProbe = false;
    let queryIndex = 0;
    let executeIndex = 0;
    let sawSucceeded = false;
    const memoryJob = {
      count: vi.fn(async () => durableProbe ? 1 : 0),
      create: vi.fn(async () => {
        durableProbe = true;
        return {};
      }),
      findUnique: vi.fn(async () => ({
        acceptedResultHash: "b".repeat(64),
        state: "SUCCEEDED"
      })),
      updateMany: vi.fn(async () => {
        sawSucceeded = true;
        return { count: 1 };
      })
    };
    const queryRows = [
      [{ memoryGeneration: 2, memoryRevision: 7, userId: "user-1" }],
      [{ lastGrantedOwnerUserId: null }],
      [{
        activeLeafMessageId: null,
        attemptCount: 1,
        branchGeneration: null,
        chatId: null,
        claimToken: "preflight:probe-1",
        id: "probe-1",
        idempotencyFingerprint: "a".repeat(64),
        kind: "RECLASSIFY_FACTS",
        leaseExpiresAt: new Date("2026-08-21T09:31:00.000Z"),
        memoryGenerationSnapshot: 2,
        memoryRevisionSnapshot: 7,
        pipelineVersion: "memory-coordinator-preflight-v1",
        priorState: "QUEUED",
        sourceHash: null,
        sourceMessageId: null,
        sourceRevision: null,
        stage: null,
        userId: "user-1"
      }],
      [{ memoryGeneration: 2, memoryRevision: 7 }],
      [{ id: "probe-1" }]
    ];
    const tx = {
      $executeRaw: vi.fn(async () => {
        executeIndex += 1;
        return 1;
      }),
      $queryRaw: vi.fn(async () => queryRows[queryIndex++] ?? []),
      memoryJob
    };
    const client = {
      $transaction: vi.fn(async (consume: (value: typeof tx) => Promise<unknown>) => {
        try {
          return await consume(tx);
        } catch (error) {
          durableProbe = false;
          throw error;
        }
      }),
      memoryJob
    };

    await expect(preflightPrismaMemoryJobLifecycle(client as never, {
      now: new Date("2026-08-21T09:30:00.000Z"),
      ownerUserId: "user-1",
      probeId: "probe-1"
    })).resolves.toBeUndefined();
    expect(queryIndex).toBe(5);
    expect(executeIndex).toBe(3);
    expect(sawSucceeded).toBe(true);
    expect(memoryJob.count).toHaveBeenCalledWith({ where: { id: "probe-1" } });
    expect(durableProbe).toBe(false);
  });
});
