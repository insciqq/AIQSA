import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { MemoryReadBudgetError, withMemoryReadBudget } from "./readBudget";

describe("Memory read budget PostgreSQL boundary", () => {
  it("terminates server work at statement_timeout", async () => {
    const startedAt = performance.now();
    const failure = await withMemoryReadBudget(prisma, 40, async (tx) =>
      tx.$queryRaw(Prisma.sql`SELECT pg_sleep(1)`)).then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(MemoryReadBudgetError);
    expect(failure).toMatchObject({ code: "memory_read_statement_timeout" });
    expect(performance.now() - startedAt).toBeLessThan(750);
  });

  it("keeps a bounded healthy read available", async () => {
    await expect(withMemoryReadBudget(prisma, 500, async (tx) =>
      tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`SELECT 1::integer AS value`)))
      .resolves.toEqual([{ value: 1 }]);
  });
});
