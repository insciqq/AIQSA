import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS } from
  "../../../domain/memory/retrieval/config";
import { prisma } from "../../prisma";
import { MemoryReadBudgetError, withMemoryReadBudget } from "./readBudget";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  memoryVectorProfiledEligibleCountSql
} from "./vector";

type CountingClient = Pick<PrismaClient, "$transaction"> & { dispatched: number };

/** Counts transactions that actually reach Prisma, i.e. were dispatched. */
function counting(client: PrismaClient): CountingClient {
  const wrapper = {
    dispatched: 0,
    $transaction: ((...args: Parameters<PrismaClient["$transaction"]>) => {
      wrapper.dispatched += 1;
      return (client.$transaction as (...values: unknown[]) => Promise<unknown>)(...args);
    }) as PrismaClient["$transaction"]
  };
  return wrapper;
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

function planText(rows: readonly unknown[]): string {
  return JSON.stringify(rows);
}

function sleepingRead(client: Pick<PrismaClient, "$transaction">, seconds: number) {
  return withMemoryReadBudget(client, 2_000, (tx) => tx.$queryRaw<Array<{ active: number }>>(
    Prisma.sql`
      /* aiqsa_read_admission_probe */
      SELECT (SELECT 1 FROM pg_sleep(${seconds}))::integer AS slept, (
        SELECT count(*)::integer FROM pg_stat_activity
        WHERE state = 'active' AND query LIKE '%aiqsa_read_admission_probe%'
      ) AS active
    `
  ));
}

describe("Memory read admission PostgreSQL boundary", () => {
  it("applies JIT, statement and lock settings derived from the remaining deadline", async () => {
    const [settings] = await withMemoryReadBudget(prisma, 1_000, (tx) =>
      tx.$queryRaw<Array<{ jit: string; lock: string; statement: string }>>(Prisma.sql`
        SELECT current_setting('jit') AS jit,
          current_setting('lock_timeout') AS lock,
          current_setting('statement_timeout') AS statement
      `), { deadlineAtMs: Date.now() + 300 });
    expect(settings?.jit).toBe("off");
    const statementMs = Number.parseInt(settings?.statement ?? "", 10);
    const lockMs = Number.parseInt(settings?.lock ?? "", 10);
    expect(statementMs).toBeGreaterThan(0);
    expect(statementMs).toBeLessThanOrEqual(300);
    expect(lockMs).toBeLessThanOrEqual(statementMs);
  });

  it("keeps JIT out of admitted read plans, including the vector profile count", async () => {
    const jitAvailable = await prisma.$queryRaw<Array<{ available: boolean }>>(
      Prisma.sql`SELECT pg_jit_available() AS available`
    );
    const forceJit = Prisma.sql`
      SELECT set_config('jit_above_cost', '0', true),
        set_config('jit_inline_above_cost', '0', true),
        set_config('jit_optimize_above_cost', '0', true)
    `;
    const probe = Prisma.sql`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT sum(value) FROM generate_series(1, 20000) AS value
    `;
    const control = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(forceJit);
      return tx.$queryRaw<unknown[]>(probe);
    });
    if (jitAvailable[0]?.available) expect(planText(control)).toContain('"JIT"');

    const vectorCount = memoryVectorProfiledEligibleCountSql({
      input: {
        eligibility: {
          allowedFactSensitivity: ["NORMAL", "SENSITIVE"],
          allowedHistorySafety: ["NORMAL", "SENSITIVE"],
          assistantId: null,
          chatId: null,
          factMode: "CURRENT",
          factTemporalAsOf: null,
          folderId: null,
          occurredFrom: null,
          occurredTo: null,
          sourceAssistantId: null,
          sourceChatIds: null,
          sourceFolderId: null
        },
        itemTypes: ["RECALL_CHUNK"],
        limit: 12,
        minimumScore: -1,
        profile: {
          configurationFingerprint: "c".repeat(64),
          connectionId: `read-admission-connection-${randomUUID()}`,
          dimension: 1_024,
          generationId: `read-admission-generation-${randomUUID()}`,
          minimumSimilarity: 0.55,
          providerModelId: `read-admission-model-${randomUUID()}`,
          retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
          vectorSpaceFingerprint: "d".repeat(64)
        },
        userId: `read-admission-user-${randomUUID()}`,
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      },
      itemType: "RECALL_CHUNK"
    });
    const admitted = await withMemoryReadBudget(prisma, 1_000, async (tx) => {
      await tx.$queryRaw(forceJit);
      return {
        probe: await tx.$queryRaw<unknown[]>(probe),
        vector: await tx.$queryRaw<unknown[]>(Prisma.sql`
          EXPLAIN (ANALYZE, FORMAT JSON) ${vectorCount}
        `),
        vectorRows: await tx.$queryRaw<unknown[]>(vectorCount)
      };
    });
    expect(planText(admitted.probe)).not.toContain('"JIT"');
    expect(planText(admitted.vector)).not.toContain('"JIT"');
    expect(admitted.vectorRows).toEqual([]);
  });

  it("separates connection acquisition from statement and transaction expiry", async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.searchParams.set("connection_limit", "1");
    url.searchParams.set("pool_timeout", "5");
    const limited = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await limited.$connect();
      let holding: () => void = () => undefined;
      const held = limited.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT 1`);
        await new Promise<void>((resolve) => { holding = resolve; });
      }, { maxWait: 2_000, timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const acquisition = await failureOf(withMemoryReadBudget(limited, 500, (tx) =>
        tx.$queryRaw(Prisma.sql`SELECT 1`)));
      holding();
      await held;
      expect(acquisition).toBeInstanceOf(MemoryReadBudgetError);
      expect(acquisition).toMatchObject({ code: "memory_read_connection_timeout" });
      expect(JSON.stringify(acquisition)).not.toMatch(/given time|connection pool/iu);

      const statement = await failureOf(withMemoryReadBudget(limited, 50, (tx) =>
        tx.$queryRaw(Prisma.sql`SELECT pg_sleep(1)`)));
      expect(statement).toMatchObject({ code: "memory_read_statement_timeout" });

      const expired = await failureOf(withMemoryReadBudget(limited, 50, async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return tx.$queryRaw(Prisma.sql`SELECT 1`);
      }));
      expect(expired).toMatchObject({ code: "memory_read_transaction_expired" });
      await expect(withMemoryReadBudget(limited, 500, (tx) =>
        tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`SELECT 1::integer AS value`)))
        .resolves.toEqual([{ value: 1 }]);
    } finally {
      await limited.$disconnect();
    }
  });

  it("fails an exhausted deadline before any dispatch", async () => {
    const client = counting(prisma);
    await expect(withMemoryReadBudget(client, 500, (tx) => tx.$queryRaw(Prisma.sql`SELECT 1`), {
      deadlineAtMs: Date.now() - 1
    })).rejects.toMatchObject({ code: "memory_read_deadline_exhausted" });
    expect(client.dispatched).toBe(0);
  });

  it("caps concurrent server work and releases permits only after transactions end", async () => {
    const total = MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS * 2;
    const client = counting(prisma);
    const startedAt = performance.now();
    const results = await Promise.all(Array.from({ length: total }, () =>
      sleepingRead(client, 0.25)));
    const elapsedMs = performance.now() - startedAt;
    expect(client.dispatched).toBe(total);
    for (const [row] of results) {
      expect(row?.active).toBeGreaterThanOrEqual(1);
      expect(row?.active).toBeLessThanOrEqual(MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS);
    }
    // Two waves: the second starts only after the first transactions ended.
    expect(elapsedMs).toBeGreaterThanOrEqual(480);
  });

  it("withdraws waiting reads at the wait budget or on abort without dispatch", async () => {
    const holders = Array.from(
      { length: MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS },
      () => sleepingRead(prisma, 0.6)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waiting = counting(prisma);
    const controller = new AbortController();
    const startedAt = performance.now();
    const budget = failureOf(withMemoryReadBudget(waiting, 100, (tx) =>
      tx.$queryRaw(Prisma.sql`SELECT 1`)));
    const aborted = failureOf(withMemoryReadBudget(waiting, 2_000, (tx) =>
      tx.$queryRaw(Prisma.sql`SELECT 1`), { signal: controller.signal }));
    controller.abort({ code: "test_settled" });
    await expect(aborted).resolves.toEqual({ code: "test_settled" });
    await expect(budget).resolves.toMatchObject({ code: "memory_read_admission_timeout" });
    expect(performance.now() - startedAt).toBeLessThan(450);
    expect(waiting.dispatched).toBe(0);
    await Promise.all(holders);
    await expect(withMemoryReadBudget(waiting, 500, (tx) =>
      tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`SELECT 1::integer AS value`)))
      .resolves.toEqual([{ value: 1 }]);
    expect(waiting.dispatched).toBe(1);
  });
});
