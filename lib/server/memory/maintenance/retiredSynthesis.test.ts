import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../../observability";
import { reconcileRetiredMemorySynthesis } from "./retiredSynthesis";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));

afterEach(() => vi.mocked(logEvent).mockReset());

describe("retired Dream synthesis reconciliation", () => {
  function client(input: Readonly<{
    owners: readonly string[];
    lockRows: () => Promise<unknown[]>;
  }>) {
    const queryRaw = vi.fn(async () => input.owners.map((userId) => ({ userId })));
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({ $queryRaw: vi.fn(input.lockRows) }));
    return {
      prisma: { $queryRaw: queryRaw, $transaction: transaction } as unknown as PrismaClient,
      queryRaw,
      transaction
    };
  }

  it("skips an owner that stopped being active and logs nothing without records", async () => {
    const fake = client({ owners: ["owner-a"], lockRows: async () => [] });
    await expect(reconcileRetiredMemorySynthesis(fake.prisma, new Date())).resolves.toEqual({
      forgottenFacts: 0, pinnedFacts: 0
    });
    expect(fake.transaction).toHaveBeenCalledOnce();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("runs every owner before rethrowing the first failure", async () => {
    const ownerFailure = new Error("owner_failed");
    const fake = client({
      owners: ["owner-a", "owner-b"],
      lockRows: async () => { throw ownerFailure; }
    });
    await expect(reconcileRetiredMemorySynthesis(fake.prisma, new Date())).rejects.toBe(ownerFailure);
    expect(fake.transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid clock before any read or write", async () => {
    const fake = client({ owners: [], lockRows: async () => [] });
    await expect(reconcileRetiredMemorySynthesis(fake.prisma, new Date(Number.NaN)))
      .rejects.toThrow("memory_synthesis_retirement_clock_invalid");
    expect(fake.queryRaw).not.toHaveBeenCalled();
    expect(fake.transaction).not.toHaveBeenCalled();
  });
});
