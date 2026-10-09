// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { ActiveRunConflictError } from "./runRepositoryContract";
import {
  isRollbackSafeSettlementFailure,
  mapActiveRunConflict,
  retryRollbackSafeSettlement
} from "./prismaRepositoryShared";

function uniqueError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.19.3",
    meta
  });
}

describe("active run conflict mapping", () => {
  it("maps only the ModelRun chat uniqueness target", async () => {
    await expect(mapActiveRunConflict(async () => {
      throw uniqueError({ modelName: "ModelRun", target: ["chatId"] });
    })).rejects.toBeInstanceOf(ActiveRunConflictError);
  });

  it.each(["ModelRun_one_active_per_chat_idx", "ModelRun_one_workspace_wait_per_chat_idx"])(
    "maps exact named %s uniqueness diagnostics", async (index) => {
      const errors = [
        uniqueError({ target: index }),
        uniqueError({ modelName: "ModelRun", target: [index] }),
        new Prisma.PrismaClientKnownRequestError("Raw query failed", { code: "P2010", clientVersion: "6.19.3",
          meta: { code: "23505", message: `duplicate key value violates unique constraint "${index}"` } }),
        new Error(`duplicate key value violates unique constraint "${index}"`)
      ];
      for (const error of errors) {
        await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBeInstanceOf(ActiveRunConflictError);
      }
    });

  it.each([
    { modelName: "Message", target: ["id"] },
    { modelName: "ModelRun", target: ["id"] },
    { modelName: "ModelRun", target: ["userId", "chatId", "id"] },
    { modelName: "WorkspaceSession", target: ["chatId"] },
    { target: ["chatId"] },
    { modelName: "ModelRun", target: "ModelRun_pkey" },
    { modelName: "ModelRun", target: "ModelRun_one_active_per_chat_idx_other" }
  ])("does not relabel unrelated uniqueness failures (%s)", async (meta) => {
    const error = uniqueError(meta);
    await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBe(error);
  });

  it("does not treat generic duplicate-key text as an active run", async () => {
    const error = new Error("duplicate key value violates unique constraint Message_pkey");
    await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBe(error);
  });

  it("preserves non-unique failures even when they mention a known index", async () => {
    const error = new Error('could not access index "ModelRun_one_active_per_chat_idx"');
    await expect(mapActiveRunConflict(async () => { throw error; })).rejects.toBe(error);
  });
});

describe("rollback-safe settlement retry", () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_CANARY", { code, clientVersion: "6.19.3", meta });

  it.each([
    ["an expired transaction", known("P2028", { error: "A query cannot be executed on an expired transaction." }), true],
    ["an unstartable transaction", known("P2028", { error: "Unable to start a transaction in the given time." }), true],
    ["a bounded lock wait", known("P2010", { code: "55P03" }), true],
    ["a connector lock timeout", new Prisma.PrismaClientUnknownRequestError(
      "QueryError(PostgresError { code: \"55P03\", message: \"PRIVATE_CANARY\" })", { clientVersion: "6.19.3" }), true],
    ["a serialization conflict", known("P2034"), true],
    ["a deadlock", known("P2010", { code: "40P01" }), true],
    ["a statement timeout", known("P2010", { code: "57014" }), false],
    ["a constraint violation", known("P2002"), false],
    ["an unavailable database", new Prisma.PrismaClientInitializationError("PRIVATE_CANARY", "6.19.3", "P1001"), false],
    ["an application failure", new Error("tool_call_usage_checkpoint_conflict"), false]
  ])("classifies %s", (_case, error, safe) => {
    expect(isRollbackSafeSettlementFailure(error)).toBe(safe);
  });

  it("runs a rolled-back transaction again, at most three times, and never an unsafe one", async () => {
    const lockTimeout = known("P2010", { code: "55P03" });
    const waits: number[] = [];
    const wait = async (attempt: number) => { waits.push(attempt); };
    let calls = 0;
    await expect(retryRollbackSafeSettlement(async () => {
      calls += 1;
      if (calls === 1) throw lockTimeout;
      return "settled";
    }, wait)).resolves.toBe("settled");
    expect([calls, waits]).toEqual([2, [1]]);

    calls = 0;
    await expect(retryRollbackSafeSettlement(async () => { calls += 1; throw lockTimeout; }, wait)).rejects.toBe(lockTimeout);
    expect(calls).toBe(3);

    const unsafe = known("P2002");
    calls = 0;
    await expect(retryRollbackSafeSettlement(async () => { calls += 1; throw unsafe; }, wait)).rejects.toBe(unsafe);
    expect(calls).toBe(1);
  });
});
