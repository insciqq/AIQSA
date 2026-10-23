import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { logEvent } from "../observability";
import type { WorkspaceRuntime } from "../workspace/runtime";
import { removeWorkspaceForDeletion } from "../workspace/removal";

/*
 * Projects were removed together with their data (operator decision
 * 2026-10-23). The migration `20261023210000_retire_projects` fenced every
 * remaining Project for deletion, and they are finalized here, a bounded
 * batch per pass: their Workspace VMs are removed, their stored objects are
 * queued for deletion, and the Project's chats, messages, runs, shares and
 * memberships cascade with it. The application's deletion worker takes the
 * Projects that need no Workspace runner, so retirement completes on an
 * installation without Workspace; Workspace maintenance takes the rest. The
 * tables stay until a later release drops them.
 */

const CLAIM_MS = 5 * 60_000;
const activeStatuses = ["preparing", "queued", "streaming", "in_progress"] as const;

export type ProjectDeletionStatus = "pending" | "failed" | "completed";

/** Only a durable deletion fence grants this worker authority. */
export async function finalizeProjectDeletion(input: Readonly<{
  prisma: PrismaClient;
  projectId: string;
  runtime?: WorkspaceRuntime;
}>): Promise<ProjectDeletionStatus> {
  const { prisma, projectId } = input;
  const token = randomUUID();
  let claimed = false;
  try {
    const claim = await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`);
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project) return { status: "completed" as const };
      if (project.status !== "DELETING" || !project.deletionRequestedAt ||
        project.deletionClaimExpiresAt && project.deletionClaimExpiresAt > new Date()) return { status: "pending" as const };
      const now = new Date();
      await tx.project.update({ where: { id: projectId }, data: {
        deletionLastAttemptAt: now, deletionLastErrorCode: null, deletionClaimToken: token,
        deletionClaimExpiresAt: new Date(now.getTime() + CLAIM_MS)
      } });
      const sessions = await tx.workspaceSession.findMany({
        orderBy: { id: "asc" }, select: { id: true }, where: { chat: { projectId } }
      });
      return { status: "claimed" as const, sessions };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (claim.status !== "claimed") return claim.status;
    claimed = true;
    for (const session of claim.sessions) {
      const renewed = await prisma.project.updateMany({
        where: { id: projectId, status: "DELETING", deletionClaimToken: token, deletionClaimExpiresAt: { gt: new Date() } },
        data: { deletionClaimExpiresAt: new Date(Date.now() + CLAIM_MS) }
      });
      if (renewed.count !== 1) return "pending";
      await removeWorkspaceForDeletion({ now: new Date(), prisma, runtime: input.runtime, sessionId: session.id });
    }
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`);
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project) return "completed" as const;
      if (project.status !== "DELETING" || project.deletionClaimToken !== token ||
        !project.deletionClaimExpiresAt || project.deletionClaimExpiresAt <= new Date()) return "pending" as const;
      if (await tx.modelRun.count({ where: { chat: { projectId }, status: { in: [...activeStatuses] } } }) ||
        await tx.workspaceSession.count({ where: { chat: { projectId }, OR: [
          { runtimeSandboxId: { not: null } }, { operationOwner: { not: null } }
        ] } })) throw new Error("project_cleanup_pending");
      const attachments = await tx.attachment.findMany({
        select: { storageKey: true },
        where: { projectId: input.projectId }
      });
      if (attachments.length > 0) {
        await tx.attachmentDeletionJob.createMany({
          data: attachments.map(({ storageKey }) => ({ storageKey })),
          skipDuplicates: true
        });
      }
      // Project run and Memory evidence is immutable while the Project
      // exists; the erasure removes the aggregate as a whole. Clear
      // restrictive evidence/current-version edges before the Project cascade
      // removes the remaining rows.
      await tx.projectRunBinding.deleteMany({ where: { projectId: input.projectId } });
      await tx.projectMemoryProposal.deleteMany({ where: { projectId: input.projectId } });
      await tx.projectMemoryFact.updateMany({
        data: { currentVersionId: null, state: "FORGOTTEN" },
        where: { projectId: input.projectId }
      });
      // Workspace output attachments restrict deletion of their producer
      // ModelRun. Queue object removal first, then remove relational
      // attachments and runs explicitly so the fenced WorkspaceSession can
      // be settled before Chat rows cascade with the Project.
      await tx.attachment.deleteMany({ where: { projectId: input.projectId } });
      await tx.modelRun.deleteMany({
        where: { chat: { projectId: input.projectId } }
      });
      const workspaceSessions = await tx.workspaceSession.findMany({
        select: { id: true },
        where: { chat: { projectId: input.projectId } }
      });
      if (workspaceSessions.length > 0) {
        const workspaceSessionIds = workspaceSessions.map(({ id }) => id);
        await tx.workspaceCleanupJob.deleteMany({
          where: { workspaceSessionId: { in: workspaceSessionIds } }
        });
        await tx.workspaceSession.deleteMany({
          where: { id: { in: workspaceSessionIds } }
        });
      }
      await tx.project.delete({ where: { id: input.projectId } });
      return "completed" as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch {
    if (claimed) {
      // Failure details are deliberately content-free. An expired claim also
      // recovers a crash between any two writes or after successful guest I/O.
      await prisma.project.updateMany({
        where: { id: projectId, status: "DELETING", deletionClaimToken: token },
        data: { deletionLastErrorCode: "project_deletion_failed", deletionClaimToken: null, deletionClaimExpiresAt: null }
      }).catch(() => undefined);
      return "failed";
    }
    return "pending";
  }
}

export type ProjectDeletionPass = Readonly<{ completed: number; failed: number; pending: number }>;

/**
 * One bounded pass over fenced Projects. Without a Workspace runtime it takes
 * only Projects whose chats hold no Workspace VM or operation, since removing
 * one needs the runner.
 */
export async function runProjectDeletionMaintenance(input: Readonly<{
  prisma: PrismaClient;
  runtime?: WorkspaceRuntime;
  limit?: number;
}>): Promise<ProjectDeletionPass> {
  const needsNoRunner = { chats: { none: { workspaceSession: { is: { OR: [
    { runtimeSandboxId: { not: null } }, { operationOwner: { not: null } }
  ] } } } } };
  const rows = await input.prisma.project.findMany({
    where: { status: "DELETING", deletionRequestedAt: { not: null }, OR: [
      { deletionClaimExpiresAt: null }, { deletionClaimExpiresAt: { lte: new Date() } }
    ], ...(input.runtime ? {} : needsNoRunner) },
    orderBy: [{ deletionLastAttemptAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    select: { id: true }, take: Math.min(50, Math.max(1, input.limit ?? 10))
  });
  const result = { completed: 0, failed: 0, pending: 0 };
  for (const { id } of rows) result[await finalizeProjectDeletion({ ...input, projectId: id })]++;
  return result;
}

/** Content-free counts of a pass that deleted or failed something. */
export function logProjectDeletionPass(pass: ProjectDeletionPass): void {
  if (pass.completed === 0 && pass.failed === 0) return;
  logEvent("runtime_lifecycle", { subsystem: "projects", stage: "delete",
    outcome: pass.failed > 0 ? "failed" : "completed",
    completed_count: pass.completed, failed_count: pass.failed, pending_count: pass.pending,
    ...(pass.failed > 0 ? { action: "retry" as const, code: "project_deletion_failed" } : {}) });
}
