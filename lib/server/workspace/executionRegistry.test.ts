import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_EXECUTION_REGISTER_ATTEMPTS,
  createPrismaWorkspaceExecutionRegistry,
  workspaceSyncCleanupId
} from "./executionRegistry";
import { WorkspaceRuntimeError } from "./runtime";

const deadlock = () => new Prisma.PrismaClientKnownRequestError("fixture", { clientVersion: "test", code: "P2010", meta: { code: "40P01" } });
const writeConflict = () => new Prisma.PrismaClientKnownRequestError("fixture", { clientVersion: "test", code: "P2034" });
const taken = () => new Prisma.PrismaClientKnownRequestError("fixture", { clientVersion: "test", code: "P2002" });

const unguarded = {
  modelRunId: "run_1",
  modelRunToolCallId: "call_1",
  runtimeExecSessionId: workspaceSyncCleanupId("call_1"),
  sessionId: "session_1"
};
const registration = { ...unguarded, operation: { generation: 1, owner: "run:run_1" } };

/** A registry whose guarded transaction fails with `failures` in order, then writes the row. */
function registry(failures: readonly unknown[]) {
  const remaining = [...failures];
  const rows: unknown[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: registration.sessionId }]),
    workspaceExecution: { create: vi.fn(async ({ data }: { data: unknown }) => { rows.push(data); return { id: "execution_1" }; }) },
    workspaceSession: { findFirst: vi.fn(async () => ({ id: registration.sessionId })) }
  };
  const client = {
    $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
      const failure = remaining.shift();
      if (failure !== undefined) throw failure;
      return work(tx);
    }),
    workspaceExecution: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        const failure = remaining.shift();
        if (failure !== undefined) throw failure;
        rows.push(data);
        return { id: "execution_1" };
      }),
      findUnique: vi.fn(async () => ({ id: "execution_1", lastErrorCode: null, modelRunId: registration.modelRunId,
        modelRunToolCallId: registration.modelRunToolCallId, runtimeExecSessionId: registration.runtimeExecSessionId,
        state: "ACTIVE", workspaceSessionId: registration.sessionId }))
    }
  };
  return { client, rows, store: createPrismaWorkspaceExecutionRegistry(client as unknown as PrismaClient) };
}

describe("Workspace execution registration", () => {
  it("makes a registration a deadlock or a serialization conflict rolled back again, whole, within its bound", async () => {
    const value = registry([deadlock(), writeConflict()]);
    await expect(value.store.register(registration)).resolves.toBe("registered");
    // Three whole transactions, each with the session lock first; only the last one wrote the row.
    expect(value.client.$transaction).toHaveBeenCalledTimes(WORKSPACE_EXECUTION_REGISTER_ATTEMPTS);
    expect(value.rows).toEqual([{ modelRunId: "run_1", modelRunToolCallId: "call_1",
      runtimeExecSessionId: registration.runtimeExecSessionId, workspaceSessionId: "session_1" }]);
  });

  it("gives up with the conflict itself once the bound is spent, writing nothing", async () => {
    const failures = Array.from({ length: WORKSPACE_EXECUTION_REGISTER_ATTEMPTS }, deadlock);
    const value = registry(failures);
    await expect(value.store.register(registration)).rejects.toBe(failures.at(-1));
    expect(value.client.$transaction).toHaveBeenCalledTimes(WORKSPACE_EXECUTION_REGISTER_ATTEMPTS);
    expect(value.rows).toEqual([]);
  });

  it("repeats an unguarded registration the same way", async () => {
    const value = registry([writeConflict()]);
    await expect(value.store.register(unguarded)).resolves.toBe("registered");
    expect(value.client.workspaceExecution.create).toHaveBeenCalledTimes(2);
    expect(value.client.$transaction).not.toHaveBeenCalled();
  });

  it("never repeats any other failure", async () => {
    const stale = new WorkspaceRuntimeError("workspace_operation_stale");
    const fenced = registry([stale]);
    await expect(fenced.store.register(registration)).rejects.toBe(stale);
    expect(fenced.client.$transaction).toHaveBeenCalledOnce();
    const unavailable = new Prisma.PrismaClientKnownRequestError("fixture", { clientVersion: "test", code: "P1001" });
    const down = registry([unavailable]);
    await expect(down.store.register(registration)).rejects.toBe(unavailable);
    expect(down.client.$transaction).toHaveBeenCalledOnce();
  });

  it("keeps a repeated registration of the same call idempotent and a foreign claim a conflict", async () => {
    const same = registry([taken()]);
    await expect(same.store.register(registration)).resolves.toBe("registered");
    expect(same.client.$transaction).toHaveBeenCalledOnce();
    const foreign = registry([taken()]);
    await expect(foreign.store.register({ ...registration, modelRunId: "run_2" })).resolves.toBe("conflict");
  });
});
