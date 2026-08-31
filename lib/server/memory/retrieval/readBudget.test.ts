import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_READ_BUDGET_MS,
  MemoryReadBudgetError,
  memoryReadBudgetFailureCode,
  withMemoryReadBudget
} from "./readBudget";

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
      async (tx) => tx.$queryRaw`SELECT 1`
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
    expect(memoryReadBudgetFailureCode({ code: "P2028" }))
      .toBe("memory_read_statement_timeout");
    expect(memoryReadBudgetFailureCode(new Error("private database detail"))).toBeNull();
  });

  it("can fence an explicit candidate-first join order transaction-locally", async () => {
    const mocked = clientWith(async () => []);

    await withMemoryReadBudget(
      mocked.client,
      MEMORY_READ_BUDGET_MS.CANONICAL_REJOIN_EXPANSION,
      async (tx) => tx.$queryRaw`SELECT 1`,
      { preserveExplicitJoinOrder: true }
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
      async (tx) => tx.$queryRaw`SELECT pg_sleep(1)`
    )).rejects.toEqual(expect.objectContaining({
      code: "memory_read_statement_timeout",
      message: "memory_read_statement_timeout",
      name: "MemoryReadBudgetError"
    } satisfies Partial<MemoryReadBudgetError>));
    expect(mocked.$transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid budgets before database work", async () => {
    const mocked = clientWith(async () => []);
    await expect(withMemoryReadBudget(mocked.client, 0, async () => true))
      .rejects.toThrow("memory_read_budget_invalid");
    expect(mocked.$transaction).not.toHaveBeenCalled();
  });
});
