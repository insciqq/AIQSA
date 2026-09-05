import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { acknowledgeWorkspaceCommandsStopped } from "./executionRegistry";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "./runtime";
import { WORKSPACE_OPERATION_LEASE_MS, failWorkspaceExportsForLostDisk, lockWorkspaceSession } from "./sessionOperation";

/** Caller has authorized deletion of the owning chat/Project and fenced new admission. */
export async function removeWorkspaceForDeletion(input: Readonly<{
  now: Date;
  prisma: PrismaClient;
  runtime?: WorkspaceRuntime;
  sessionId: string;
  signal?: AbortSignal;
}>): Promise<void> {
  input.signal?.throwIfAborted();
  const claim = await input.prisma.$transaction(async (tx) => {
    const session = await lockWorkspaceSession(tx, input.sessionId);
    if (!session || (!session.runtimeSandboxId && !session.operationOwner)) return null;
    if (session.operationOwner && (!session.operationExpiresAt || session.operationExpiresAt > input.now)) {
      throw new WorkspaceRuntimeError("workspace_operation_stale");
    }
    if (await tx.modelRun.count({ where: { chatId: session.chatId, status: { in: ["preparing", "queued", "streaming", "in_progress"] } } }) > 0) {
      throw new WorkspaceRuntimeError("workspace_operation_stale");
    }
    if (!input.runtime?.claimSessionOperation || !input.runtime.retireSessionOperation) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    const token = randomUUID();
    const operation = { generation: session.version + 1, owner: `delete:${token}` };
    await tx.workspaceSession.update({ data: {
      operationOwner: operation.owner, operationExpiresAt: new Date(input.now.getTime() + WORKSPACE_OPERATION_LEASE_MS),
      version: operation.generation, lastErrorCode: null, state: "DELETING"
    }, where: { id: session.id } });
    const job = {
      claimedAt: input.now, claimToken: token, lastAttemptAt: input.now, lastErrorCode: null, nextAttemptAt: input.now,
      runtimeSandboxId: session.runtimeSandboxId, sandboxName: session.sandboxName, state: "RUNNING" as const
    };
    await tx.workspaceCleanupJob.upsert({
      create: { ...job, attemptCount: 1, workspaceSessionId: session.id },
      update: { ...job, attemptCount: { increment: 1 } }, where: { workspaceSessionId: session.id }
    });
    return { operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: session.id, token };
  });
  if (!claim) return;
  const runtime = input.runtime!;
  const identity = { operation: claim.operation, runtimeSandboxId: claim.runtimeSandboxId, sessionId: claim.sessionId };
  try {
    input.signal?.throwIfAborted();
    await runtime.claimSessionOperation!(identity);
    await runtime.removeSession({ ...identity, signal: input.signal });
    await runtime.retireSessionOperation!(identity);
    await input.prisma.$transaction(async (tx) => {
      const session = await lockWorkspaceSession(tx, claim.sessionId);
      if (!session || session.operationOwner !== claim.operation.owner || session.version !== claim.operation.generation ||
        session.runtimeSandboxId !== claim.runtimeSandboxId || session.state !== "DELETING") throw new WorkspaceRuntimeError("workspace_operation_stale");
      const job = await tx.workspaceCleanupJob.findFirst({ where: { claimToken: claim.token, workspaceSessionId: session.id, state: "RUNNING" } });
      if (!job) throw new WorkspaceRuntimeError("workspace_operation_stale");
      await acknowledgeWorkspaceCommandsStopped(tx, session.id);
      await failWorkspaceExportsForLostDisk(tx, session.id);
      await tx.workspaceSession.update({ data: {
        operationOwner: null, operationExpiresAt: null, lastErrorCode: null, runtimeSandboxId: null, stoppedAt: input.now
      }, where: { id: session.id } });
      await tx.workspaceCleanupJob.delete({ where: { id: job.id } });
    });
  } catch (error) {
    await input.prisma.$transaction(async (tx) => {
      const session = await lockWorkspaceSession(tx, claim.sessionId);
      if (!session || session.operationOwner !== claim.operation.owner || session.version !== claim.operation.generation ||
        session.runtimeSandboxId !== claim.runtimeSandboxId) return;
      const nextAttemptAt = new Date(input.now.getTime() + 30_000);
      await tx.workspaceCleanupJob.updateMany({ data: {
        claimedAt: null, claimToken: null, lastErrorCode: "workspace_remove_failed", nextAttemptAt, state: "FAILED"
      }, where: { claimToken: claim.token, workspaceSessionId: session.id, state: "RUNNING" } });
      await tx.workspaceSession.update({ data: { operationExpiresAt: nextAttemptAt }, where: { id: session.id } });
    }).catch(() => undefined);
    throw error;
  }
}
