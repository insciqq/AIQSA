import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { WorkspaceConfig } from "./config";
import { UNREGISTERED_WORKSPACE_COMMAND_FILTER, acknowledgeWorkspaceCommandsStopped, createPrismaWorkspaceExecutionRegistry } from "./executionRegistry";
import { quiesceWorkspaceExecutions } from "./quiescence";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "./runtime";
import { WORKSPACE_OPERATION_LEASE_MS, failWorkspaceExportsForLostDisk, lockWorkspaceSession, workspaceOperationWhere } from "./sessionOperation";
import type { WorkspaceOperation } from "./operationFence";

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "in_progress", "streaming"] as const;
const CLAIM_STALE_MS = 15 * 60 * 1_000;
const OPERATION_STALE_MS = 5 * 60 * 1_000;
// A run's own settlement follows its terminal status within seconds; a
// session still RUNNING/CREATING with no active run after this grace was
// left behind (app crash, or a runner that was unreachable at settle time)
// and must not wait for the operation-marker window.
const SESSION_BACKSTOP_STALE_MS = 30 * 1_000;

type SessionCandidate = Readonly<{
  chatId: string;
  id: string;
  runtimeSandboxId: string | null;
  sandboxName: string;
}>;

type CleanupClaim = Readonly<{
  claimToken: string;
  id: string;
  operation: WorkspaceOperation;
  runtimeSandboxId: string | null;
  workspaceSessionId: string;
}>;

export type WorkspaceMaintenanceSummary = Readonly<{
  cleanupClaimed: number;
  cleanupCompleted: number;
  cleanupFailed: number;
  expiredFenced: number;
  idleFailed: number;
  idleStopped: number;
  staleOperationsRecovered: number;
  /** Sessions left RUNNING/CREATING by a crashed app that were settled here. */
  staleSessionsSettled: number;
  /** Of those, sessions whose VM had to be stopped to prove quiescence. */
  staleSessionsStopped: number;
}>;

/**
 * Workspace disks are deliberately outside backup authority. A restored
 * database must therefore forget every runtime identity before recovery or a
 * new run can recreate the filesystem from canonical attachments.
 */
export async function reconcileWorkspaceAfterRestore(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.workspaceCleanupJob.deleteMany();
    // Restore runs offline without guest disks. Neither an old registered
    // process nor a lost dispatch can exist in this installation afterwards.
    await acknowledgeWorkspaceCommandsStopped(tx, null);
    await failWorkspaceExportsForLostDisk(tx, null);
    const reset = await tx.workspaceSession.updateMany({
      data: {
        lastErrorCode: "workspace_restored_without_disk",
        operationOwner: null, operationExpiresAt: null,
        runtimeSandboxId: null,
        state: "PENDING",
        stoppedAt: null,
        version: { increment: 1 }
      },
      where: {
        OR: [
          { operationOwner: { not: null } },
          { runtimeSandboxId: { not: null } },
          { state: { not: "PENDING" } }
        ]
      }
    });
    return reset.count;
  });
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(60 * 60 * 1_000, 5_000 * 2 ** Math.min(attemptCount, 8));
}

export async function runWorkspaceMaintenance(input: Readonly<{
  config: WorkspaceConfig;
  limit?: number;
  now?: Date;
  prisma: PrismaClient;
  runtime: WorkspaceRuntime;
}>): Promise<WorkspaceMaintenanceSummary> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const staleOperationBefore = new Date(now.getTime() - OPERATION_STALE_MS);
  let staleOperationsRecovered = 0;

  // App-crash backstop: a session still RUNNING, or CREATING without an
  // operation marker, whose chat has no active run was abandoned by a run that
  // never settled. Quiesce what the registry knows, stop the VM when anything
  // is uncertain, and move it out of the active states without waiting for
  // the idle TTL.
  const registry = createPrismaWorkspaceExecutionRegistry(input.prisma);
  const staleSessionBefore = new Date(now.getTime() - SESSION_BACKSTOP_STALE_MS);
  const staleSessions = await input.prisma.$queryRaw<SessionCandidate[]>(Prisma.sql`
    SELECT ws."id", ws."chatId", ws."sandboxName", ws."runtimeSandboxId"
    FROM "WorkspaceSession" ws
    WHERE ws."updatedAt" <= ${staleSessionBefore}
      AND ws."state" <> 'DELETING'::"WorkspaceSessionState"
      AND (ws."operationExpiresAt" IS NULL OR ws."operationExpiresAt" <= ${now})
      AND (
        ws."operationOwner" IS NOT NULL
        OR (ws."state" IN ('RUNNING'::"WorkspaceSessionState", 'CREATING'::"WorkspaceSessionState", 'FAILED'::"WorkspaceSessionState")
          AND (ws."lastErrorCode" IS NULL
            OR ws."lastErrorCode" NOT IN ('workspace_archive_in_progress', 'workspace_idle_stop_in_progress')
            OR ws."updatedAt" <= ${staleOperationBefore}))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "ModelRun" mr
        WHERE mr."chatId" = ws."chatId"
          AND mr."status" IN (
            'preparing'::"ModelRunStatus",
            'queued'::"ModelRunStatus",
            'in_progress'::"ModelRunStatus",
            'streaming'::"ModelRunStatus"
          )
      )
    ORDER BY ws."updatedAt" ASC, ws."id" ASC
    LIMIT ${limit}
  `);
  let staleSessionsSettled = 0;
  let staleSessionsStopped = 0;
  for (const candidate of staleSessions) {
    const session = await input.prisma.$transaction(async (tx) => {
      const current = await lockWorkspaceSession(tx, candidate.id);
      if (!current || current.state === "DELETING" || current.updatedAt > staleSessionBefore ||
        (current.operationExpiresAt && current.operationExpiresAt > now)) return null;
      const legacyMarker = current.lastErrorCode === "workspace_archive_in_progress" || current.lastErrorCode === "workspace_idle_stop_in_progress";
      if (!current.operationOwner && (!(["RUNNING", "CREATING", "FAILED"] as string[]).includes(current.state) ||
        (legacyMarker && current.updatedAt > staleOperationBefore))) return null;
      if (await tx.modelRun.count({ where: { chatId: current.chatId, status: { in: [...ACTIVE_RUN_STATUSES] } } }) > 0) return null;
      const claimed = await tx.workspaceSession.update({
        data: {
          operationOwner: `maintenance:${randomUUID()}`,
          operationExpiresAt: new Date(now.getTime() + WORKSPACE_OPERATION_LEASE_MS),
          version: { increment: 1 }
        },
        where: { id: current.id }
      });
      return { ...claimed, legacyMarker };
    });
    if (!session?.operationOwner) continue;
    const operation = { generation: session.version, owner: session.operationOwner };
    const runtimeInput = { operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: session.id };
    try {
      if (!input.runtime.claimSessionOperation || !input.runtime.retireSessionOperation) {
        throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      }
      await input.runtime.claimSessionOperation(runtimeInput);
      if (session.runtimeSandboxId) {
      const unregisteredCommands = await input.prisma.modelRunToolCall.count({
        where: {
          ...UNREGISTERED_WORKSPACE_COMMAND_FILTER,
          workspaceRunBinding: { workspaceSessionId: session.id }
        }
      });
      const quiescence = await quiesceWorkspaceExecutions({
        operation,
        unregisteredCommands,
        registry,
        runtime: input.runtime,
        runtimeSandboxId: session.runtimeSandboxId,
        sessionId: session.id
      });
      if (!quiescence.proven) continue;
      }
      await input.runtime.retireSessionOperation(runtimeInput);
    } catch { continue; }
    const stoppedVm = session.runtimeSandboxId !== null;
    const settled = await input.prisma.$transaction(async (tx) => {
      const current = await lockWorkspaceSession(tx, session.id);
      if (!current || current.version !== operation.generation || current.operationOwner !== operation.owner ||
        current.runtimeSandboxId !== session.runtimeSandboxId || current.state === "DELETING") return false;
      await acknowledgeWorkspaceCommandsStopped(tx, session.id);
      await tx.workspaceSession.update({
        data: {
          operationOwner: null, operationExpiresAt: null,
          lastErrorCode: session.legacyMarker ? "workspace_operation_interrupted" : null,
          ...(stoppedVm ? { state: "STOPPED" as const, stoppedAt: now } : { state: "PENDING" as const, stoppedAt: null })
        },
        where: { id: session.id }
      });
      return true;
    });
    if (settled) {
      if (session.legacyMarker) staleOperationsRecovered += 1;
      else staleSessionsSettled += 1;
      if (stoppedVm) staleSessionsStopped += 1;
    }
  }

  const expired = await input.prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<SessionCandidate[]>(Prisma.sql`
      SELECT ws."id", ws."chatId", ws."sandboxName", ws."runtimeSandboxId"
      FROM "WorkspaceSession" ws
      WHERE ws."expiresAt" <= ${now}
        AND ws."operationOwner" IS NULL
        AND ws."state" <> 'DELETING'::"WorkspaceSessionState"
        AND NOT EXISTS (
          SELECT 1
          FROM "ModelRun" mr
          WHERE mr."chatId" = ws."chatId"
            AND mr."status" IN (
              'preparing'::"ModelRunStatus",
              'queued'::"ModelRunStatus",
              'in_progress'::"ModelRunStatus",
              'streaming'::"ModelRunStatus"
            )
        )
      ORDER BY ws."expiresAt" ASC, ws."id" ASC
      FOR UPDATE OF ws SKIP LOCKED
      LIMIT ${limit}
    `);
    for (const session of candidates) {
      await tx.workspaceCleanupJob.upsert({
        create: {
          nextAttemptAt: now,
          runtimeSandboxId: session.runtimeSandboxId,
          sandboxName: session.sandboxName,
          state: "PENDING",
          workspaceSessionId: session.id
        },
        update: {
          claimedAt: null,
          claimToken: null,
          lastErrorCode: null,
          nextAttemptAt: now,
          runtimeSandboxId: session.runtimeSandboxId,
          sandboxName: session.sandboxName,
          state: "PENDING"
        },
        where: { workspaceSessionId: session.id }
      });
      await tx.workspaceSession.update({
        data: { lastErrorCode: null, state: "DELETING" },
        where: { id: session.id }
      });
    }
    return candidates.length;
  });

  const idleBefore = new Date(now.getTime() - input.config.idleTtlSeconds * 1_000);
  const idleCandidates = await input.prisma.workspaceSession.findMany({
    orderBy: [{ lastActiveAt: "asc" }, { id: "asc" }],
    select: {
      chat: { select: { archived: true } },
      chatId: true,
      id: true,
      runtimeSandboxId: true,
      sandboxName: true
    },
    take: limit,
    where: {
      expiresAt: { gt: now },
      OR: [
        { lastActiveAt: { lte: idleBefore } },
        { chat: { archived: true } }
      ],
      runtimeSandboxId: { not: null },
      operationOwner: null,
      state: { in: ["READY", "RUNNING"] }
    }
  });
  let idleStopped = 0;
  let idleFailed = 0;
  for (const candidate of idleCandidates) {
    const acquired = await input.prisma.$transaction(async (tx) => {
      const session = await lockWorkspaceSession(tx, candidate.id);
      if (!session || session.operationOwner) return null;
      const activeRuns = await tx.modelRun.count({
        where: {
          chatId: candidate.chatId,
          status: { in: [...ACTIVE_RUN_STATUSES] }
        }
      });
      if (activeRuns > 0) return null;
      const operation = { generation: session.version + 1, owner: `idle:${randomUUID()}` };
      const updated = await tx.workspaceSession.updateMany({
        data: {
          operationOwner: operation.owner, operationExpiresAt: new Date(now.getTime() + WORKSPACE_OPERATION_LEASE_MS),
          version: operation.generation,
          lastErrorCode: "workspace_idle_stop_in_progress",
          state: "CREATING",
          stoppedAt: null
        },
        where: {
          id: candidate.id,
          operationOwner: null,
          expiresAt: { gt: now },
          ...(candidate.chat.archived
            ? { chat: { archived: true } }
            : { lastActiveAt: { lte: idleBefore } }),
          runtimeSandboxId: candidate.runtimeSandboxId,
          state: { in: ["READY", "RUNNING"] }
        }
      });
      return updated.count === 1 ? operation : null;
    });
    if (!acquired) continue;
    const operation = acquired;
    const runtimeInput = { operation, runtimeSandboxId: candidate.runtimeSandboxId, sessionId: candidate.id };
    try {
      if (!input.runtime.claimSessionOperation || !input.runtime.retireSessionOperation) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      await input.runtime.claimSessionOperation(runtimeInput);
      await input.runtime.retireSessionOperation(runtimeInput);
      const settled = await input.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${candidate.id} FOR UPDATE`;
      if (!(await tx.workspaceSession.findFirst({ select: { id: true }, where: {
        ...workspaceOperationWhere(operation), id: candidate.id, runtimeSandboxId: candidate.runtimeSandboxId
      } }))) return false;
      await acknowledgeWorkspaceCommandsStopped(tx, candidate.id);
      const updated = await tx.workspaceSession.updateMany({
        data: {
          operationOwner: null, operationExpiresAt: null,
          lastErrorCode: null,
          state: "STOPPED",
          stoppedAt: now
        },
        where: { ...workspaceOperationWhere(operation), id: candidate.id, runtimeSandboxId: candidate.runtimeSandboxId, state: "CREATING" }
      });
      return updated.count === 1;
      });
      if (settled) idleStopped += 1;
    } catch {
      await input.prisma.workspaceSession.updateMany({
        data: {
          lastErrorCode: "workspace_idle_stop_failed",
          state: "FAILED"
        },
        where: { ...workspaceOperationWhere(operation), id: candidate.id, runtimeSandboxId: candidate.runtimeSandboxId, state: "CREATING" }
      });
      idleFailed += 1;
    }
  }

  const claims: CleanupClaim[] = [];
  const staleClaimBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  for (let index = 0; index < limit; index += 1) {
    const claim = await input.prisma.$transaction(async (tx) => {
      const jobs = await tx.workspaceCleanupJob.findMany({
        orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          attemptCount: true,
          id: true,
          runtimeSandboxId: true,
          workspaceSessionId: true
        },
        take: 1,
        where: {
          nextAttemptAt: { lte: now },
          workspaceSession: { OR: [{ operationOwner: null }, { operationExpiresAt: { lte: now } }] },
          OR: [
            { state: { in: ["PENDING", "FAILED"] } },
            { claimedAt: { lte: staleClaimBefore }, state: "RUNNING" }
          ]
        }
      });
      const job = jobs[0];
      if (!job) return null;
      const session = await lockWorkspaceSession(tx, job.workspaceSessionId);
      if (!session || session.state !== "DELETING" || session.runtimeSandboxId !== job.runtimeSandboxId ||
        (session.operationOwner && (!session.operationExpiresAt || session.operationExpiresAt > now))) return null;
      const claimToken = randomUUID();
      const updated = await tx.workspaceCleanupJob.updateMany({
        data: {
          attemptCount: { increment: 1 },
          claimedAt: now,
          claimToken,
          lastAttemptAt: now,
          lastErrorCode: null,
          state: "RUNNING"
        },
        where: {
          id: job.id,
          nextAttemptAt: { lte: now },
          OR: [
            { state: { in: ["PENDING", "FAILED"] } },
            { claimedAt: { lte: staleClaimBefore }, state: "RUNNING" }
          ]
        }
      });
      const operation = { generation: session.version + 1, owner: `cleanup:${claimToken}` };
      if (updated.count === 1) await tx.workspaceSession.update({
        data: { version: operation.generation, operationOwner: operation.owner, operationExpiresAt: new Date(now.getTime() + WORKSPACE_OPERATION_LEASE_MS) },
        where: { id: session.id }
      });
      return updated.count === 1
        ? {
            claimToken,
            id: job.id,
            operation,
            runtimeSandboxId: job.runtimeSandboxId,
            workspaceSessionId: job.workspaceSessionId
          }
        : null;
    });
    if (!claim) break;
    claims.push(claim);
  }

  let cleanupCompleted = 0;
  let cleanupFailed = 0;
  for (const claim of claims) {
    try {
      const runtimeInput = { operation: claim.operation, runtimeSandboxId: claim.runtimeSandboxId, sessionId: claim.workspaceSessionId };
      if (!input.runtime.claimSessionOperation || !input.runtime.retireSessionOperation) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      await input.runtime.claimSessionOperation(runtimeInput);
      await input.runtime.removeSession({
        operation: claim.operation,
        runtimeSandboxId: claim.runtimeSandboxId,
        sessionId: claim.workspaceSessionId
      });
      await input.runtime.retireSessionOperation(runtimeInput);
      const completed = await input.prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, claim.workspaceSessionId);
        if (!session || session.version !== claim.operation.generation || session.operationOwner !== claim.operation.owner ||
          session.runtimeSandboxId !== claim.runtimeSandboxId || session.state !== "DELETING") return false;
        const job = await tx.workspaceCleanupJob.findFirst({
          select: { id: true },
          where: {
            claimToken: claim.claimToken,
            id: claim.id,
            state: "RUNNING"
          }
        });
        if (!job) return false;
        await acknowledgeWorkspaceCommandsStopped(tx, session.id);
        await failWorkspaceExportsForLostDisk(tx, session.id);
        await tx.workspaceSession.update({
          data: {
            expiresAt: new Date(now.getTime() + input.config.retentionSeconds * 1_000),
            lastActiveAt: now,
            lastErrorCode: null,
            operationOwner: null, operationExpiresAt: null,
            runtimeSandboxId: null,
            state: "PENDING",
            stoppedAt: null,
            version: { increment: 1 }
          },
          where: { id: claim.workspaceSessionId }
        });
        await tx.workspaceCleanupJob.delete({ where: { id: job.id } });
        return true;
      });
      if (completed) cleanupCompleted += 1;
    } catch {
      await input.prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, claim.workspaceSessionId);
        if (!session || session.version !== claim.operation.generation || session.operationOwner !== claim.operation.owner ||
          session.runtimeSandboxId !== claim.runtimeSandboxId) return;
        const job = await tx.workspaceCleanupJob.findFirst({
          select: { attemptCount: true },
          where: { claimToken: claim.claimToken, id: claim.id, state: "RUNNING" }
        });
        if (!job) return;
        const nextAttemptAt = new Date(now.getTime() + retryDelayMs(job.attemptCount));
        // The retry remains fenced and must acquire a higher generation at
        // the receiver; its due time must also permit that guarded takeover.
        await tx.workspaceSession.update({ data: { operationExpiresAt: nextAttemptAt }, where: { id: session.id } });
        await tx.workspaceCleanupJob.updateMany({
        data: {
          claimedAt: null,
          claimToken: null,
          lastErrorCode: "workspace_remove_failed",
          nextAttemptAt,
          state: "FAILED"
        },
        where: { claimToken: claim.claimToken, id: claim.id, state: "RUNNING" }
        });
      });
      cleanupFailed += 1;
    }
  }

  return {
    cleanupClaimed: claims.length,
    cleanupCompleted,
    cleanupFailed,
    expiredFenced: expired,
    idleFailed,
    idleStopped,
    staleOperationsRecovered,
    staleSessionsSettled,
    staleSessionsStopped
  };
}
