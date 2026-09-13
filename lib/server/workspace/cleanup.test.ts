import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import { runWorkspaceMaintenance } from "./cleanup";
import { getWorkspaceConfig } from "./config";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "./runtime";

const { lockSession } = vi.hoisted(() => ({ lockSession: vi.fn() }));
vi.mock("./sessionOperation", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sessionOperation")>(), lockWorkspaceSession: lockSession
}));

const now = new Date("2026-09-13T10:00:00.000Z");
const config = getWorkspaceConfig({ NODE_ENV: "test" });

function fixture(outcome: "confirmed" | "not_applied" | "unconfirmed", beforeRetry: () => void, expired = false) {
  const writeError = new Prisma.PrismaClientKnownRequestError("PRIVATE_RETRY_DATABASE", { code: "P2024", clientVersion: "fixture" });
  const session = { id: "fixture_session", state: "DELETING", version: 0, runtimeSandboxId: "fixture_vm", operationOwner: null };
  lockSession.mockImplementation(async () => session);
  const updateJob = vi.fn(async ({ data }: { data: { state: string } }) => {
    expect(data.state).toBe("FAILED");
    beforeRetry();
    if (outcome === "unconfirmed") throw writeError;
    return outcome === "confirmed" ? [{ nextAttemptAt: new Date("2026-09-13T10:00:10.000Z") }] : [];
  });
  const transaction = {
    $queryRaw: vi.fn(async () => expired ? [{ ...session, chatId: "fixture_chat", sandboxName: "fixture_sandbox" }] : []),
    workspaceSession: { update: vi.fn(async ({ data }: { data: object }) => Object.assign(session, data)) },
    workspaceCleanupJob: {
      upsert: vi.fn(async () => ({ id: "fixture_cleanup_job" })),
      findMany: vi.fn().mockResolvedValueOnce([{ id: "fixture_cleanup_job", workspaceSessionId: session.id,
        attemptCount: 0, runtimeSandboxId: session.runtimeSandboxId }]).mockResolvedValue([]),
      findFirst: vi.fn(async () => ({ attemptCount: 1, id: "fixture_cleanup_job" })),
      updateMany: vi.fn(async () => ({ count: 1 })), updateManyAndReturn: updateJob
    }
  };
  const transact = vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction));
  const prisma = {
    $queryRaw: vi.fn(async () => []),
    $transaction: transact,
    workspaceSession: { findMany: vi.fn(async () => []) }
  } as unknown as PrismaClient;
  const runtime = {
    claimSessionOperation: vi.fn(async () => undefined), retireSessionOperation: vi.fn(async () => undefined),
    removeSession: vi.fn(async () => { throw Object.assign(new WorkspaceRuntimeError("workspace_runtime_unavailable"), {
      message: "PRIVATE_RUNTIME_DETAIL"
    }); })
  } as unknown as WorkspaceRuntime;
  return { input: { config, now, prisma, runtime }, writeError, transaction, transact, updateJob };
}

afterEach(() => vi.restoreAllMocks());

describe("Workspace cleanup failure persistence", () => {
  it("confirms only preparation after enqueue commits and never reports cleanup completion when removal fails", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const preparation = { event: "job_persistence", subsystem: "workspace", stage: "prepare",
      work_stage: "cleanup", outcome: "confirmed", count: 1 };
    const value = fixture("confirmed", () => undefined, true);
    const transact = value.transact.getMockImplementation()!;
    value.transact.mockImplementation(async (callback) => {
      const result = await transact(callback);
      if (typeof result === "number") expect(records()).not.toContainEqual(expect.objectContaining(preparation));
      return result;
    });
    const remove = vi.mocked(value.input.runtime.removeSession);
    const removeSession = remove.getMockImplementation()!;
    remove.mockImplementation(async (input) => {
      expect(records()).toContainEqual(expect.objectContaining(preparation));
      expect(records().filter((record) => record.stage === "cleanup" && record.outcome === "completed")).toEqual([]);
      return removeSession(input);
    });
    await expect(runWorkspaceMaintenance(value.input)).resolves.toMatchObject({ expiredFenced: 1, cleanupCompleted: 0, cleanupFailed: 1 });
    expect(value.transaction.workspaceCleanupJob.upsert).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(records().filter((record) => record.stage === "cleanup" && record.outcome === "completed")).toEqual([]);
    expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "cleanup", outcome: "failed" }));
  });

  it.each(["confirmed", "not_applied", "unconfirmed"] as const)("logs the original failure before a %s retry write", async (outcome) => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const value = fixture(outcome, () => {
      expect(records()).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "cleanup",
        outcome: "failed", code: "workspace_runtime_unavailable", job_id: "fixture_cleanup_job" }));
    });
    const running = runWithContext({ run_id: "foreign_run", trace_id: "f".repeat(32) }, () => runWorkspaceMaintenance(value.input));
    if (outcome === "unconfirmed") await expect(running).rejects.toBe(value.writeError);
    else await expect(running).resolves.toMatchObject({ cleanupClaimed: 1, cleanupFailed: 1, cleanupCompleted: 0 });
    const retry = records().find((record) => record.event === "job_persistence" && record.stage === "retry");
    expect(retry).toMatchObject({ outcome, job_id: "fixture_cleanup_job" });
    if (outcome === "confirmed") {
      expect(retry?.retry_at).toBe("2026-09-13T10:00:10.000Z");
      expect(value.updateJob.mock.calls.at(-1)?.[0].data).toMatchObject({ nextAttemptAt: new Date(String(retry?.retry_at)) });
    } else expect(retry).not.toHaveProperty("retry_at");
    if (outcome === "unconfirmed") expect(retry?.prisma_code).toBe("P2024");
    expect(retry).not.toHaveProperty("run_id");
    expect(retry?.trace_id).not.toBe("f".repeat(32));
    expect(lines.join("")).not.toContain("PRIVATE");
    expect(lines.join("")).not.toContain("foreign_run");
  });
});
