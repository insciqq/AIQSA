import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { WorkspaceConfig } from "./config";
import { createPrismaWorkspaceExecutionRegistry } from "./executionRegistry";
import { quiesceWorkspaceExecutions } from "./quiescence";
import type { WorkspaceRuntime } from "./runtime";

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
    const reset = await tx.workspaceSession.updateMany({
      data: {
        lastErrorCode: "workspace_restored_without_disk",
        runtimeSandboxId: null,
        state: "PENDING",
        stoppedAt: null,
        version: { increment: 1 }
      },
      where: {
        OR: [
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
  const staleOperationsRecovered = await input.prisma.workspaceSession.updateMany({
    data: {
      lastErrorCode: "workspace_operation_interrupted",
      state: "READY",
      stoppedAt: null
    },
    where: {
      updatedAt: { lte: staleOperationBefore },
      lastErrorCode: {
        in: ["workspace_archive_in_progress", "workspace_idle_stop_in_progress"]
      },
      state: "CREATING"
    }
  });

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
      AND ws."lastErrorCode" IS NULL
      AND ws."state" IN (
        'RUNNING'::"WorkspaceSessionState",
        'CREATING'::"WorkspaceSessionState"
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
  for (const session of staleSessions) {
    let stoppedVm = false;
    if (session.runtimeSandboxId) {
      const ambiguousStarts = await input.prisma.modelRunToolCall.count({
        where: {
          state: { in: ["pending", "running"] },
          toolName: { contains: "sandbox_exec_start" },
          workspaceExecution: { is: null },
          workspaceRunBinding: { workspaceSessionId: session.id }
        }
      });
      const quiescence = await quiesceWorkspaceExecutions({
        ambiguousStarts,
        registry,
        runtime: input.runtime,
        runtimeSandboxId: session.runtimeSandboxId,
        sessionId: session.id
      });
      if (!quiescence.proven) continue;
      stoppedVm = quiescence.stoppedVm;
    }
    const settled = await input.prisma.workspaceSession.updateMany({
      data: stoppedVm
        ? { state: "STOPPED", stoppedAt: now }
        : { state: session.runtimeSandboxId ? "READY" : "PENDING", stoppedAt: null },
      where: {
        id: session.id,
        lastErrorCode: null,
        state: { in: ["RUNNING", "CREATING"] },
        updatedAt: { lte: staleSessionBefore }
      }
    });
    if (settled.count === 1) {
      staleSessionsSettled += 1;
      if (stoppedVm) staleSessionsStopped += 1;
    }
  }

  const expired = await input.prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<SessionCandidate[]>(Prisma.sql`
      SELECT ws."id", ws."chatId", ws."sandboxName", ws."runtimeSandboxId"
      FROM "WorkspaceSession" ws
      WHERE ws."expiresAt" <= ${now}
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
      state: { in: ["READY", "RUNNING"] }
    }
  });
  let idleStopped = 0;
  let idleFailed = 0;
  for (const candidate of idleCandidates) {
    const acquired = await input.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Chat" WHERE "id" = ${candidate.chatId} FOR UPDATE
      `);
      if (!rows[0]) return false;
      const activeRuns = await tx.modelRun.count({
        where: {
          chatId: candidate.chatId,
          status: { in: [...ACTIVE_RUN_STATUSES] }
        }
      });
      if (activeRuns > 0) return false;
      const updated = await tx.workspaceSession.updateMany({
        data: {
          lastErrorCode: "workspace_idle_stop_in_progress",
          state: "CREATING",
          stoppedAt: null
        },
        where: {
          id: candidate.id,
          expiresAt: { gt: now },
          ...(candidate.chat.archived
            ? { chat: { archived: true } }
            : { lastActiveAt: { lte: idleBefore } }),
          runtimeSandboxId: candidate.runtimeSandboxId,
          state: { in: ["READY", "RUNNING"] }
        }
      });
      return updated.count === 1;
    });
    if (!acquired) continue;
    try {
      await input.runtime.stopSession({
        runtimeSandboxId: candidate.runtimeSandboxId,
        sessionId: candidate.id
      });
      await input.prisma.workspaceSession.updateMany({
        data: {
          lastErrorCode: null,
          state: "STOPPED",
          stoppedAt: now
        },
        where: { id: candidate.id, state: "CREATING" }
      });
      idleStopped += 1;
    } catch {
      await input.prisma.workspaceSession.updateMany({
        data: {
          lastErrorCode: "workspace_idle_stop_failed",
          state: "FAILED"
        },
        where: { id: candidate.id, state: "CREATING" }
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
          OR: [
            { state: { in: ["PENDING", "FAILED"] } },
            { claimedAt: { lte: staleClaimBefore }, state: "RUNNING" }
          ]
        }
      });
      const job = jobs[0];
      if (!job) return null;
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
      return updated.count === 1
        ? {
            claimToken,
            id: job.id,
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
      await input.runtime.removeSession({
        runtimeSandboxId: claim.runtimeSandboxId,
        sessionId: claim.workspaceSessionId
      });
      await registry.closeAll({ sessionId: claim.workspaceSessionId, to: "CLOSED" });
      const completed = await input.prisma.$transaction(async (tx) => {
        const job = await tx.workspaceCleanupJob.findFirst({
          select: { id: true },
          where: {
            claimToken: claim.claimToken,
            id: claim.id,
            state: "RUNNING"
          }
        });
        if (!job) return false;
        await tx.workspaceSession.update({
          data: {
            expiresAt: new Date(now.getTime() + input.config.retentionSeconds * 1_000),
            lastActiveAt: now,
            lastErrorCode: null,
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
      const job = await input.prisma.workspaceCleanupJob.findFirst({
        select: { attemptCount: true },
        where: { id: claim.id }
      });
      await input.prisma.workspaceCleanupJob.updateMany({
        data: {
          claimedAt: null,
          claimToken: null,
          lastErrorCode: "workspace_remove_failed",
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(job?.attemptCount ?? 1)),
          state: "FAILED"
        },
        where: { claimToken: claim.claimToken, id: claim.id, state: "RUNNING" }
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
    staleOperationsRecovered: staleOperationsRecovered.count,
    staleSessionsSettled,
    staleSessionsStopped
  };
}
