import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaWorkspaceCoordinatorRepository, WORKSPACE_EXPORT_MAX_ATTEMPTS } from "./coordinator";

describe("Workspace export recovery repository boundary", () => {
  it("continues after the exact timestamp/id cursor without relaxing eligibility or scan bounds", async () => {
    const updatedAt = new Date("2026-09-04T10:00:00.000Z");
    const findMany = vi.fn(async (_input: unknown) => [{ modelRun: { userId: "owner" }, modelRunId: "later", updatedAt }]);
    const repository = createPrismaWorkspaceCoordinatorRepository({ workspaceRunBinding: { findMany } } as unknown as PrismaClient);
    const cursor = { runId: "head", updatedAt };
    const result = await repository.exportRecoveryCandidates({ cursor, limit: 10, staleBefore: updatedAt });
    expect(result).toEqual([{ runId: "later", updatedAt, userId: "owner" }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ updatedAt: "asc" }, { modelRunId: "asc" }],
      take: 10,
      where: expect.objectContaining({
        AND: [{ OR: [{ updatedAt: { gt: updatedAt } }, { modelRunId: { gt: "head" }, updatedAt }] }],
        exportAttemptCount: { lt: WORKSPACE_EXPORT_MAX_ATTEMPTS },
        modelRun: { status: "complete" },
        updatedAt: { lte: updatedAt }
      })
    }));
    await repository.exportRecoveryCandidates({ limit: 1_000, staleBefore: updatedAt });
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({ take: 100 });
  });

  it("checks the recovery attempt cap in the atomic claim, including a stale selected candidate", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const tx = {
      $queryRaw: async () => [{ chatId: "chat" }],
      modelRun: { count: async () => 0 },
      workspaceSession: { findUnique: async () => ({ id: "session", chatId: "chat", operationOwner: null, runtimeSandboxId: "runtime", state: "READY", version: 1 }) },
      workspaceRunBinding: {
        findUnique: async () => ({ exportAttemptCount: WORKSPACE_EXPORT_MAX_ATTEMPTS, exportState: "PENDING", lastExportErrorCode: null, workspaceSessionId: "session" }),
        updateMany
      }
    };
    const repository = createPrismaWorkspaceCoordinatorRepository({ $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaClient);
    await expect(repository.claimExportForRecovery({ generation: 1, runtimeSandboxId: "runtime", leaseMs: 10_000, runId: "run", sessionId: "session" }))
      .resolves.toEqual({ status: "exhausted" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ exportAttemptCount: { lt: WORKSPACE_EXPORT_MAX_ATTEMPTS } }) }));
  });
});
