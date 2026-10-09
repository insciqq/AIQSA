// @vitest-environment node
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryPersistence } from "./observability";
import { createPrismaMemoryCoordinatorRepository } from "./prismaRepository";
import type { MemoryJobClaim } from "./types";

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function historyClaim(): MemoryJobClaim {
  return {
    activeLeafMessageId: null, attemptCount: 1, branchGeneration: null, chatId: null, claimToken: "job-commit-claim",
    id: "job-commit", idempotencyFingerprint: "f".repeat(64), kind: "INDEX_HISTORY",
    leaseExpiresAt: new Date("2026-08-21T10:05:00.000Z"), memoryGenerationSnapshot: 4, memoryRevisionSnapshot: 9,
    pipelineVersion: "memory-history-v1", recoveredLease: false, sourceHash: null, sourceMessageId: null, sourceRevision: null,
    stage: null, targetFactVersionId: null, userId: "user-1"
  };
}

function lines(event: string): Record<string, unknown>[] {
  return output.flatMap((chunk) => {
    try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
  }).filter((record) => record.event === event);
}

let output: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Memory commit transaction timing", () => {
  it("reports a history commit holding the chat row past the request budget, and its hold on the commit's record", async () => {
    const tx = {
      $queryRaw: vi.fn(async (statement: Prisma.Sql | TemplateStringsArray, ..._values: unknown[]) => {
        const text = "strings" in statement ? statement.strings.join("?") : statement.join("?");
        // The chat row this commit's history apply locks waits behind a foreground writer for 250 ms.
        if (text.includes("\"Chat\"")) await sleep(250);
        return [{ id: "job-commit" }];
      }),
      memoryIndexGeneration: { findFirst: vi.fn(async () => null) },
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const transaction = vi.fn(async (consume: (value: typeof tx) => Promise<boolean>, _options?: unknown) => consume(tx));
    const repository = createPrismaMemoryCoordinatorRepository({ $transaction: transaction } as never);
    const claim = historyClaim();
    const committed = memoryPersistence(claim, "complete", () => repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64), claim, now: new Date("2026-08-21T10:00:00.000Z"), stage: "lexical_apply",
      apply: async (client) => {
        await (client as unknown as typeof tx).$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${"PRIVATE_CHAT"} FOR SHARE`;
        await sleep(5_800);
        return undefined;
      }
    }));
    await vi.advanceTimersByTimeAsync(6_050);
    await expect(committed).resolves.toBe(true);
    // The history commit keeps its own budget.
    expect(transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 5_000, timeout: 20_000 });
    const [slow] = lines("db_transaction");
    expect(slow).toMatchObject({ level: "error", subsystem: "memory", operation: "job_commit", job_kind: "INDEX_HISTORY",
      duration_ms: 6_050, lock_wait_ms: 250, outcome: "committed" });
    expect(lines("job_persistence")).toEqual([expect.objectContaining({ level: "info", subsystem: "memory",
      stage: "complete", outcome: "confirmed", duration_ms: 6_050, lock_wait_ms: 250 })]);
    expect(JSON.stringify(slow)).not.toContain("PRIVATE_");
  });

  it("reports a quick commit's timing on its record only", async () => {
    const tx = { $queryRaw: vi.fn(async () => [{ id: "job-commit" }]), memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: async (consume: (value: typeof tx) => Promise<boolean>) => consume(tx)
    } as never);
    const claim = { ...historyClaim(), kind: "CONSOLIDATE_CANDIDATE" as const };
    await expect(memoryPersistence(claim, "complete", () => repository.commitJobSuccess({
      acceptedResultHash: "a".repeat(64), claim, now: new Date("2026-08-21T10:00:00.000Z"), stage: "consolidation_applied"
    }))).resolves.toBe(true);
    expect(lines("db_transaction")).toEqual([]);
    expect(lines("job_persistence")).toEqual([expect.objectContaining({ outcome: "confirmed", duration_ms: 0,
      lock_wait_ms: 0 })]);
  });

  it("puts a rolled-back attempt's hold and lock wait on its retry record", async () => {
    const lockTimeout = new Prisma.PrismaClientKnownRequestError("lock timeout", { clientVersion: "6.19.3", code: "P2010",
      meta: { code: "55P03" } });
    let locks = 0;
    const tx = {
      $queryRaw: vi.fn(async (statement: Prisma.Sql | TemplateStringsArray, ..._values: unknown[]) => {
        const text = "strings" in statement ? statement.strings.join("?") : statement.join("?");
        // The first attempt's first lock statement waits out its one-second bound.
        if (/\bFOR (UPDATE|SHARE)\b/u.test(text) && ++locks === 1) {
          await sleep(1_000);
          throw lockTimeout;
        }
        return [{ id: "job-commit", previous: "0" }];
      }),
      memoryIndexGeneration: { findFirst: vi.fn(async () => null) },
      memoryJob: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const repository = createPrismaMemoryCoordinatorRepository({
      $transaction: async (consume: (value: typeof tx) => Promise<boolean>) => consume(tx)
    } as never, { jobCommitRetryDelay: async () => undefined });
    const pending = repository.commitJobSuccess({ acceptedResultHash: "a".repeat(64), claim: historyClaim(),
      now: new Date("2026-08-21T10:00:00.000Z"), stage: "lexical_apply" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(true);
    expect(lines("job_persistence")).toEqual([expect.objectContaining({ outcome: "unconfirmed", action: "retry",
      db_failure: "lock_timeout" })]);
    expect(lines("job_persistence")[0]).toMatchObject({ duration_ms: 1_000, lock_wait_ms: 1_000 });
    expect(locks).toBeGreaterThan(1);
  });
});
