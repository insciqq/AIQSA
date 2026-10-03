import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS } from
  "../../../domain/memory/retrieval/config";
import {
  MEMORY_READ_BUDGET_ERROR_CODES,
  MEMORY_READ_BUDGET_MS,
  MemoryReadBudgetError,
  memoryReadBudgetFailureCode,
  memoryReadBudgetTimedOut,
  withMemoryReadBudget
} from "./readBudget";

const REQUIRED = { admission: "REQUIRED" } as const;
const LANE = { admission: "LANE" } as const;

function clientWith(work: (query: unknown) => Promise<unknown>) {
  const $queryRaw = vi.fn(work);
  const $transaction = vi.fn(async (
    callback: (tx: { $queryRaw: typeof $queryRaw }) => Promise<unknown>
  ) => callback({ $queryRaw }));
  return {
    $queryRaw,
    $transaction,
    client: { $transaction } as unknown as PrismaClient
  };
}

describe("Memory read budgets", () => {
  it("applies transaction-local server budgets before executing the read", async () => {
    const mocked = clientWith(async () => []);

    await expect(withMemoryReadBudget(
      mocked.client,
      MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE,
      async (tx) => tx.$queryRaw`SELECT 1`,
      LANE
    )).resolves.toEqual([]);

    expect(mocked.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxWait: 100,
        timeout: MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE + 100
      })
    );
    const setup = mocked.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(setup.strings?.join(" ")).toContain("statement_timeout");
    expect(setup.strings?.join(" ")).toContain("lock_timeout");
    expect(setup.strings?.join(" ")).toContain("set_config('jit', 'off', true)");
    expect(setup.values).toEqual(expect.arrayContaining([
      "250ms",
      `${MEMORY_READ_BUDGET_MS.LEXICAL_CANDIDATE}ms`
    ]));
  });

  it("maps only bounded PostgreSQL cancellation classes", () => {
    expect(memoryReadBudgetFailureCode({ code: "P2010", meta: { code: "57014" } }))
      .toBe("memory_read_statement_timeout");
    expect(memoryReadBudgetFailureCode({ code: "P2010", meta: { code: "55P03" } }))
      .toBe("memory_read_lock_timeout");
    expect(memoryReadBudgetFailureCode({
      code: "P2028",
      message: "Transaction API error: Unable to start a transaction in the given time."
    })).toBe("memory_read_connection_timeout");
    expect(memoryReadBudgetFailureCode({
      code: "P2028",
      message: "Transaction API error: Transaction already closed: expired."
    })).toBe("memory_read_transaction_expired");
    expect(memoryReadBudgetFailureCode({ code: "P2028" }))
      .toBe("memory_read_transaction_expired");
    expect(memoryReadBudgetFailureCode({ code: "P2024" }))
      .toBe("memory_read_connection_timeout");
    expect(memoryReadBudgetFailureCode(new MemoryReadBudgetError(
      "memory_read_admission_timeout"
    ))).toBe("memory_read_admission_timeout");
    expect(memoryReadBudgetFailureCode(new Error("private database detail"))).toBeNull();
  });

  it("reports every read-budget code except an expired transaction as timed out", () => {
    expect(MEMORY_READ_BUDGET_ERROR_CODES.filter(memoryReadBudgetTimedOut)).toEqual([
      "memory_read_admission_timeout",
      "memory_read_connection_timeout",
      "memory_read_deadline_exhausted",
      "memory_read_lock_timeout",
      "memory_read_statement_timeout"
    ]);
  });

  it("keeps the pool acquisition engine text out of the typed error", async () => {
    const mocked = clientWith(async () => []);
    mocked.$transaction.mockRejectedValueOnce(Object.assign(
      new Error("Transaction API error: Unable to start a transaction in the given time."),
      { code: "P2028" }
    ));
    const failure = await withMemoryReadBudget(mocked.client, 50, async () => true, REQUIRED)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MemoryReadBudgetError);
    expect(failure).toMatchObject({
      code: "memory_read_connection_timeout",
      message: "memory_read_connection_timeout"
    });
  });

  it("can fence an explicit candidate-first join order transaction-locally", async () => {
    const mocked = clientWith(async () => []);

    await withMemoryReadBudget(
      mocked.client,
      MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION,
      async (tx) => tx.$queryRaw`SELECT 1`,
      { ...REQUIRED, preserveExplicitJoinOrder: true }
    );

    const setup = mocked.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
    };
    expect(setup.strings?.join(" ")).toContain("join_collapse_limit");
  });

  it("returns a content-free timeout error and never retries", async () => {
    const databaseError = { code: "P2010", meta: { code: "57014" } };
    const mocked = clientWith(async () => {
      if (mocked.$queryRaw.mock.calls.length > 1) throw databaseError;
      return [];
    });

    await expect(withMemoryReadBudget(
      mocked.client,
      50,
      async (tx) => tx.$queryRaw`SELECT pg_sleep(1)`,
      LANE
    )).rejects.toEqual(expect.objectContaining({
      code: "memory_read_statement_timeout",
      message: "memory_read_statement_timeout",
      name: "MemoryReadBudgetError"
    } satisfies Partial<MemoryReadBudgetError>));
    expect(mocked.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid budgets before database work", async () => {
    const mocked = clientWith(async () => []);
    await expect(withMemoryReadBudget(mocked.client, 0, async () => true, REQUIRED))
      .rejects.toThrow("memory_read_budget_invalid");
    await expect(withMemoryReadBudget(mocked.client, 100, async () => true,
      { admission: "OTHER" } as unknown as typeof REQUIRED))
      .rejects.toThrow("memory_read_budget_invalid");
    expect(mocked.$transaction).not.toHaveBeenCalled();
  });

  it("caps concurrent read transactions per process and admits waiters in order", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const order: number[] = [];
    const $transaction = vi.fn(async (
      callback: (tx: { $queryRaw: () => Promise<unknown> }) => Promise<unknown>
    ) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        return await callback({ $queryRaw: async () => [] });
      } finally {
        active -= 1;
      }
    });
    const client = { $transaction } as unknown as PrismaClient;
    const total = MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS + 2;
    const reads = Array.from({ length: total }, (_, index) =>
      withMemoryReadBudget(client, 2_000, async () => {
        order.push(index);
        return index;
      }, index % 2 ? LANE : REQUIRED));

    await vi.waitFor(() => expect($transaction).toHaveBeenCalledTimes(
      MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect($transaction).toHaveBeenCalledTimes(
      MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
    );
    while (releases.length > 0 || $transaction.mock.calls.length < total) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await expect(Promise.all(reads)).resolves.toEqual(
      Array.from({ length: total }, (_, index) => index)
    );
    expect(maximum).toBe(MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS);
    expect(order).toEqual(Array.from({ length: total }, (_, index) => index));
  });

  it("withdraws waiting reads on abort, deadline or budget without dispatch", async () => {
    const releases: Array<() => void> = [];
    const blocking = vi.fn(async (
      callback: (tx: { $queryRaw: () => Promise<unknown> }) => Promise<unknown>
    ) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return callback({ $queryRaw: async () => [] });
    });
    const holders = Array.from(
      { length: MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS },
      () => withMemoryReadBudget({ $transaction: blocking } as unknown as PrismaClient,
        2_000, async () => true, LANE)
    );
    await vi.waitFor(() => expect(blocking).toHaveBeenCalledTimes(
      MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
    ));
    const waiting = clientWith(async () => []);
    const controller = new AbortController();
    const aborted = withMemoryReadBudget(waiting.client, 2_000, async () => true, {
      ...REQUIRED,
      signal: controller.signal
    }).catch((error: unknown) => error);
    const startedAt = Date.now();
    const deadline = withMemoryReadBudget(waiting.client, 2_000, async () => true, {
      ...LANE,
      deadlineAtMs: Date.now() + 40
    }).catch((error: unknown) => error);
    const budget = withMemoryReadBudget(waiting.client, 60, async () => true, REQUIRED)
      .catch((error: unknown) => error);
    controller.abort({ code: "test_settled" });

    await expect(aborted).resolves.toEqual({ code: "test_settled" });
    await expect(deadline).resolves.toMatchObject({ code: "memory_read_admission_timeout" });
    await expect(budget).resolves.toMatchObject({ code: "memory_read_admission_timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(waiting.$transaction).not.toHaveBeenCalled();

    for (const release of releases.splice(0)) release();
    await Promise.all(holders);
    await expect(withMemoryReadBudget(waiting.client, 50, async () => "free", LANE))
      .resolves.toBe("free");
  });

  it("fails an exhausted deadline before admission or dispatch", async () => {
    const mocked = clientWith(async () => []);
    await expect(withMemoryReadBudget(mocked.client, 1_000, async () => true, {
      ...REQUIRED,
      deadlineAtMs: Date.now() - 1
    })).rejects.toMatchObject({ code: "memory_read_deadline_exhausted" });
    const aborted = new AbortController();
    aborted.abort({ code: "test_settled" });
    await expect(withMemoryReadBudget(mocked.client, 1_000, async () => true, {
      ...LANE,
      signal: aborted.signal
    })).rejects.toEqual({ code: "test_settled" });
    expect(mocked.$transaction).not.toHaveBeenCalled();
  });

  it("derives server budgets from the deadline remaining after admission", async () => {
    const mocked = clientWith(async () => []);
    await withMemoryReadBudget(mocked.client, 1_000, async (tx) => tx.$queryRaw`SELECT 1`, {
      ...LANE,
      deadlineAtMs: Date.now() + 120
    });
    const setup = mocked.$queryRaw.mock.calls[0]?.[0] as { values?: readonly unknown[] };
    const [lock, statement] = (setup.values ?? []).map((value) =>
      Number.parseInt(String(value), 10));
    expect(statement).toBeGreaterThan(0);
    expect(statement).toBeLessThanOrEqual(120);
    expect(lock).toBeLessThanOrEqual(statement!);
    const call = mocked.$transaction.mock.calls[0] as readonly unknown[] | undefined;
    const options = call?.[1] as { timeout?: number } | undefined;
    expect(options?.timeout).toBe(statement! + 100);
  });

  it("holds the permit until the transaction itself has settled", async () => {
    const settle: Array<() => void> = [];
    const slow = vi.fn(async (
      callback: (tx: { $queryRaw: () => Promise<unknown> }) => Promise<unknown>
    ) => {
      const value = await callback({ $queryRaw: async () => [] });
      // The callback finished; the transaction has not committed yet.
      await new Promise<void>((resolve) => settle.push(resolve));
      return value;
    });
    const holders = Array.from(
      { length: MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS },
      () => withMemoryReadBudget({ $transaction: slow } as unknown as PrismaClient,
        2_000, async () => true, LANE)
    );
    await vi.waitFor(() => expect(settle).toHaveLength(
      MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
    ));
    const next = clientWith(async () => []);
    const pending = withMemoryReadBudget(next.client, 2_000, async () => "next", REQUIRED);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(next.$transaction).not.toHaveBeenCalled();
    settle.shift()?.();
    await expect(pending).resolves.toBe("next");
    for (const release of settle.splice(0)) release();
    await Promise.all(holders);
  });

  it("rejects a nested read admission instead of waiting on its own permit", async () => {
    const mocked = clientWith(async () => []);
    await expect(withMemoryReadBudget(mocked.client, 200, async () =>
      withMemoryReadBudget(mocked.client, 200, async () => true, REQUIRED), LANE))
      .rejects.toThrow("memory_read_admission_nested");
    expect(mocked.$transaction).toHaveBeenCalledTimes(1);
    await expect(Promise.all(Array.from(
      { length: MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS },
      () => withMemoryReadBudget(mocked.client, 200, async () => true, LANE)
    ))).resolves.toHaveLength(MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS);
  });

  describe("admission classes", () => {
    /** Holds every dispatched transaction until released; records order. */
    function gatedClient() {
      const releases: Array<() => void> = [];
      const order: string[] = [];
      const client = (label: string) => ({
        $transaction: vi.fn(async (
          callback: (tx: { $queryRaw: () => Promise<unknown> }) => Promise<unknown>
        ) => {
          order.push(label);
          await new Promise<void>((resolve) => releases.push(resolve));
          return callback({ $queryRaw: async () => [] });
        })
      }) as unknown as PrismaClient;
      const releaseOne = async () => {
        releases.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
      };
      return { client, order, releaseOne, releases };
    }

    async function fillPermits(gate: ReturnType<typeof gatedClient>) {
      const holders = Array.from({ length: MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS },
        (_, index) => withMemoryReadBudget(gate.client(`holder-${index}`), 2_000, async () => true, LANE));
      await vi.waitFor(() => expect(gate.releases).toHaveLength(
        MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS
      ));
      return holders;
    }

    it("grants required reads before queued lane reads, FIFO within each class", async () => {
      const gate = gatedClient();
      const holders = await fillPermits(gate);
      const reads = [
        withMemoryReadBudget(gate.client("lane-1"), 2_000, async () => true, LANE),
        withMemoryReadBudget(gate.client("lane-2"), 2_000, async () => true, LANE),
        withMemoryReadBudget(gate.client("required-1"), 2_000, async () => true, REQUIRED),
        withMemoryReadBudget(gate.client("lane-3"), 2_000, async () => true, LANE),
        withMemoryReadBudget(gate.client("required-2"), 2_000, async () => true, REQUIRED)
      ];
      while (gate.order.length < MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS + reads.length ||
        gate.releases.length > 0) {
        await gate.releaseOne();
      }
      await Promise.all([...holders, ...reads]);
      expect(gate.order.slice(MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS)).toEqual([
        "required-1", "required-2", "lane-1", "lane-2", "lane-3"
      ]);
    });

    it("lets a required read bypass a lane queue only while a permit is free", async () => {
      const gate = gatedClient();
      const holders = await fillPermits(gate);
      const lane = withMemoryReadBudget(gate.client("lane"), 2_000, async () => true, LANE);
      await gate.releaseOne();
      // The released permit went to the waiting lane read, not to a later arrival.
      expect(gate.order.at(-1)).toBe("lane");
      const required = withMemoryReadBudget(gate.client("required"), 2_000, async () => true, REQUIRED);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(gate.order).not.toContain("required");
      while (gate.releases.length > 0 || !gate.order.includes("required")) await gate.releaseOne();
      await Promise.all([...holders, lane, required]);
    });

    it("withdraws waiting reads of either class on abort or timeout", async () => {
      const gate = gatedClient();
      const holders = await fillPermits(gate);
      const controller = new AbortController();
      const failures = await Promise.all([
        withMemoryReadBudget(gate.client("required-aborted"), 2_000, async () => true,
          { ...REQUIRED, signal: controller.signal }).catch((error: unknown) => error),
        withMemoryReadBudget(gate.client("lane-aborted"), 2_000, async () => true,
          { ...LANE, signal: controller.signal }).catch((error: unknown) => error),
        withMemoryReadBudget(gate.client("required-timeout"), 30, async () => true, REQUIRED)
          .catch((error: unknown) => error),
        withMemoryReadBudget(gate.client("lane-timeout"), 30, async () => true, LANE)
          .catch((error: unknown) => error),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.abort({ code: "test_settled" });
          return null;
        })()
      ]);
      expect(failures.slice(0, 4)).toEqual([
        { code: "test_settled" },
        { code: "test_settled" },
        expect.objectContaining({ code: "memory_read_admission_timeout" }),
        expect.objectContaining({ code: "memory_read_admission_timeout" })
      ]);
      while (gate.releases.length > 0) await gate.releaseOne();
      await Promise.all(holders);
      expect(gate.order.filter((label) => !label.startsWith("holder"))).toEqual([]);
      // Withdrawn waiters left no queue entries: all permits are free again.
      const free = gatedClient();
      const again = await fillPermits(free);
      while (free.releases.length > 0) await free.releaseOne();
      await Promise.all(again);
    });

    it("serves queued lane reads once required arrivals stop", async () => {
      const gate = gatedClient();
      const holders = await fillPermits(gate);
      const lanes = Array.from({ length: 6 }, (_, index) =>
        withMemoryReadBudget(gate.client(`lane-${index}`), 2_000, async () => true, LANE));
      const required = Array.from({ length: 3 }, (_, index) =>
        withMemoryReadBudget(gate.client(`required-${index}`), 2_000, async () => true, REQUIRED));
      while (gate.order.length < MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS + 9 ||
        gate.releases.length > 0) {
        await gate.releaseOne();
      }
      await expect(Promise.all([...holders, ...lanes, ...required])).resolves.toHaveLength(13);
      expect(gate.order.slice(MEMORY_READ_ADMISSION_MAX_CONCURRENT_TRANSACTIONS)).toEqual([
        "required-0", "required-1", "required-2",
        "lane-0", "lane-1", "lane-2", "lane-3", "lane-4", "lane-5"
      ]);
    });
  });
});
