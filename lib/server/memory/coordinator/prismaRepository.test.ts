import { databaseFailureCode } from "../../observability/databaseFailure";
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
  it.each(["COMMITTED", "REJECTED", "AMBIGUOUS", "FAILED", "UNKNOWN", "STALE"] as const)(
    "settles durable %s command receipts without repeating source validation or apply", async (commandStatus) => {
      const apply = vi.fn();
      const tx = {
        $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }])
          .mockResolvedValueOnce([{ commandStatus, commandOperation: "SAVE", commandResult: { private: "checkpoint" } }]),
        memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
      };
      const repository = createPrismaMemoryCoordinatorRepository({
        $transaction: async (consume: (value: typeof tx) => Promise<boolean>) => consume(tx)
      } as never);
      expect(await repository.commitJobSuccess({ acceptedResultHash: "a".repeat(64), apply,
        claim: { ...jobClaim(), kind: "MEMORY_COMMAND", chatId: "chat", sourceMessageId: "source" },
        now: new Date("2026-08-21T10:00:00.000Z"), stage: "old_worker_stage"
      })).toBe(true);
      expect(apply).not.toHaveBeenCalled();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      expect(tx.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ state: "SUCCEEDED", stage: `command_${commandStatus.toLowerCase()}`,
          commandIntent: Prisma.DbNull, commandResult: Prisma.DbNull }),
        where: expect.objectContaining({ commandStatus })
      }));
    });

  it.each([
    { status: "REJECTED", operation: "UNKNOWN", value: { classification: "NONE" }, retained: true },
    { status: "REJECTED", operation: "UNKNOWN", value: { classification: "NONE", private: "checkpoint" }, retained: false },
    { status: "COMMITTED", operation: "SAVE", value: { classification: "NONE" }, retained: false }
  ])("preserves only the exact successful ordinary-command marker ($status/$retained)", async ({ status, operation, value, retained }) => {
    const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([{ commandStatus: status, commandOperation: operation, commandResult: value }]),
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: async (consume: (value: typeof tx) => Promise<boolean>) => consume(tx)
    } as never);
    await repository.commitJobSuccess({ acceptedResultHash: "a".repeat(64),
      claim: { ...jobClaim(), kind: "MEMORY_COMMAND" }, now: new Date(), stage: null });
    expect(tx.memoryJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      commandIntent: Prisma.DbNull, commandResult: retained ? { classification: "NONE" } : Prisma.DbNull
    }) }));
  });

  it("erases private command checkpoints on failure and terminal gates while retaining retry checkpoints", async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ id: "user-1" }]),
      memoryJob: { updateMany: vi.fn(async (_input: { data: Record<string, unknown> }) => ({ count: 1 })) } };
    const repository = createPrismaMemoryCoordinatorRepository({ ...tx,
      $transaction: async (consume: (value: typeof tx) => Promise<boolean>) => consume(tx)
    } as never);
    const claim = { ...jobClaim(), kind: "MEMORY_COMMAND" as const };
    const now = new Date();
    await repository.terminalJob({ claim, now, errorCode: "memory_job_failed" });
    await repository.settleJobGate({ claim, now, decision: { status: "CANCELLED", errorCode: "memory_owner_unavailable" } });
    await repository.resolveWaitingJob({ job: claim, now, decision: { status: "STALE", errorCode: "memory_job_stale" } });
    for (const [input] of tx.memoryJob.updateMany.mock.calls) {
      expect(input).toMatchObject({ data: { commandIntent: Prisma.DbNull, commandResult: Prisma.DbNull } });
    }
    tx.memoryJob.updateMany.mockClear();
    await repository.retryJob({ claim, now, nextAttemptAt: now, errorCode: "memory_job_failed" });
    await repository.settleJobGate({ claim, now, decision: { status: "WAITING_FOR_CONFIGURATION", errorCode: "memory_job_failed" } });
    for (const [input] of tx.memoryJob.updateMany.mock.calls) {
      expect(input).not.toHaveProperty("data.commandIntent");
      expect(input).not.toHaveProperty("data.commandResult");
    }
  });

  it("erases command checkpoints during unsupported-handler and unavailable-owner batch retirement", async () => {
    const executeRaw = vi.fn(async (_query: Prisma.Sql) => 1);
    const repository = createPrismaMemoryCoordinatorRepository({ $executeRaw: executeRaw } as never);
    await repository.terminalUnavailableJobs?.({ now: new Date(), supportedKinds: ["INDEX_HISTORY"] });
    await repository.cancelUnavailableJobOwners({ now: new Date(), kinds: ["MEMORY_COMMAND"] });
    for (const [query] of executeRaw.mock.calls) {
      expect(query.sql).toContain('"commandIntent" = NULL');
      expect(query.sql).toContain('"commandResult" = NULL');
    }
  });

  it("does not settle a command without a durable terminal receipt", async () => {
    const apply = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "user-1" }]).mockResolvedValueOnce([]),
      memoryJob: { updateMany: vi.fn() }
    };
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: async (consume: (value: typeof tx) => Promise<boolean>) => consume(tx)
    } as never);
    expect(await repository.commitJobSuccess({ acceptedResultHash: "a".repeat(64), apply,
      claim: { ...jobClaim(), kind: "MEMORY_COMMAND" },
      now: new Date("2026-08-21T10:00:00.000Z"), stage: null
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(tx.memoryJob.updateMany).not.toHaveBeenCalled();
  });

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
    }),
    new Prisma.PrismaClientKnownRequestError("transaction expired", {
      clientVersion: "6.19.3",
      code: "P2028"
    }),
    new Prisma.PrismaClientKnownRequestError("lock timeout", {
      clientVersion: "6.19.3",
      code: "P2010",
      meta: { code: "55P03" }
    })
  ])("retries a rollback-safe commit transaction failure", async (conflict) => {
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
    } as never, { jobCommitRetryDelay: async () => undefined });

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

  it("backs off and survives a sustained job-commit conflict burst", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("deadlock", {
      clientVersion: "6.19.3",
      code: "P2010",
      meta: { code: "40P01" }
    });
    const delays: number[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "job-commit" }]),
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    let attempts = 0;
    const transaction = vi.fn(async (
      consume: (value: typeof tx) => Promise<boolean>
    ) => {
      attempts += 1;
      if (attempts < 8) throw conflict;
      return consume(tx);
    });
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never, {
      jobCommitRetryDelay: async (retryOrdinal) => {
        delays.push(retryOrdinal);
      }
    });

    await expect(repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64),
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "consolidation_applied"
    })).resolves.toBe(true);
    expect(attempts).toBe(8);
    expect(delays).toEqual([1, 2, 3, 4, 5, 6, 7]);
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

  it("gives history and full-set rebuild commits lease-bounded transaction budgets", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "job-commit" }]),
      memoryIndexGeneration: { findFirst: vi.fn(async () => null) },
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const transaction = vi.fn(async (
      consume: (value: typeof tx) => Promise<boolean>,
      _options?: Readonly<{ maxWait?: number; timeout?: number }>
    ) => consume(tx));
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never);

    await expect(repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64),
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "catching_up"
    })).resolves.toBe(true);
    expect(transaction.mock.calls[0]?.[1]).toEqual({ timeout: 20_000 });

    transaction.mockClear();
    await expect(repository.commitJobSuccess({
      acceptedResultHash: "b".repeat(64),
      claim: { ...jobClaim(), kind: "INDEX_HISTORY" },
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "lexical_apply"
    })).resolves.toBe(true);
    expect(transaction.mock.calls[0]?.[1]).toEqual({
      maxWait: 5_000,
      timeout: 20_000
    });

    transaction.mockClear();
    await expect(repository.commitJobSuccess({
      acceptedResultHash: "b".repeat(64),
      claim: { ...jobClaim(), kind: "CONSOLIDATE_CANDIDATE" },
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "consolidation_applied"
    })).resolves.toBe(true);
    expect(transaction.mock.calls[0]).toHaveLength(1);
  });

  it("exhausts rolled-back commit timeouts as retryable without retaining details", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError(
      "private transaction detail",
      { clientVersion: "6.19.3", code: "P2028" }
    );
    const transaction = vi.fn(async () => {
      throw failure;
    });
    const delays: number[] = [];
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never, {
      jobCommitRetryDelay: async (retryOrdinal) => {
        delays.push(retryOrdinal);
      }
    });

    await expect(repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64),
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "catching_up"
    })).rejects.toMatchObject({
      code: "memory_job_commit_timeout",
      message: "memory_job_commit_timeout",
      retryable: true
    });
    expect(transaction).toHaveBeenCalledTimes(8);
    expect(delays).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("retains the Prisma code through commit policy mapping and reports each internal retry before waiting", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const failure = new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE", {
      clientVersion: "test", code: "P2028", meta: { query: "PRIVATE_SQL" }
    });
    const transaction = vi.fn(async () => { throw failure; });
    const repo = createPrismaMemoryCoordinatorRepository({ $transaction: transaction } as never, {
      jobCommitRetryDelay: async (ordinal) => {
        expect(writer).toHaveBeenCalledTimes(ordinal);
        expect(JSON.parse(String(writer.mock.calls.at(-1)![0]))).toMatchObject({
          event: "job_persistence", stage: "complete", outcome: "unconfirmed", action: "retry", prisma_code: "P2028"
        });
      }
    });
    try {
      const mapped = await repo.commitJobSuccess({ acceptedResultHash: "a".repeat(64), claim: jobClaim(),
        now: new Date("2026-08-21T10:00:00.000Z"), stage: "catching_up" }).catch((error: unknown) => error);
      expect(mapped).toBeInstanceOf(MemoryCoordinatorError);
      expect(databaseFailureCode(mapped)).toBe("P2028");
      expect(transaction).toHaveBeenCalledTimes(8);
      expect(writer).toHaveBeenCalledTimes(7);
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(records.every((record) => !Object.hasOwn(record, "retry_at"))).toBe(true);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    } finally { writer.mockRestore(); }
  });

  it("preserves only code-owned safe commit failures", async () => {
    const safeFailure = new Error("memory_embedding_batch_parent_invalid");
    const privateFailure = new Error("private source detail");
    const failures = [safeFailure, privateFailure];
    const transaction = vi.fn(async () => {
      throw failures.shift();
    });
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: transaction
    } as never);
    const input = {
      acceptedResultHash: "a".repeat(64),
      claim: jobClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"),
      stage: "catching_up"
    } as const;

    await expect(repository.commitJobSuccess(input)).rejects.toMatchObject({
      code: "memory_embedding_batch_parent_invalid"
    });
    await expect(repository.commitJobSuccess(input)).rejects.toMatchObject({
      code: "memory_job_commit_failed"
    });
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
      [{ ownerStatus: "active", userId: "user-1" }],
      [{ memoryGeneration: 2, memoryRevision: 7 }],
      [{ id: "probe-1" }]
    ];
    const tx = {
      $executeRaw: vi.fn(async () => {
        executeIndex += 1;
        return 1;
      }),
      $queryRaw: vi.fn(async () => queryRows[queryIndex++] ?? []),
      memoryIndexGeneration: { findFirst: vi.fn(async () => null) },
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
    expect(queryIndex).toBe(6);
    expect(executeIndex).toBe(3);
    expect(sawSucceeded).toBe(true);
    expect(memoryJob.count).toHaveBeenCalledWith({ where: { id: "probe-1" } });
    expect(durableProbe).toBe(false);
  });
});
