import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { activeModelRunStatuses, json } from "./prismaRepositoryShared";
import { ActiveRunConflictError, type PreparingRunAdmissionInput, type PreparingRunAdmissionResult } from "./runRepositoryContract";

export const WORKSPACE_FOLLOWUP_WAIT_MS = 120_000;
export const WORKSPACE_FOLLOWUP_LEASE_MS = 30_000;

export class WorkspaceFollowupError extends Error {
  constructor(readonly code: "workspace_followup_invalid" | "workspace_followup_unavailable" |
    "workspace_followup_expired" | "workspace_followup_predecessor_failed" | "workspace_followup_interrupted") {
    super(code);
    this.name = "WorkspaceFollowupError";
  }
}

export type WorkspaceFollowupClaim = Readonly<{ claimToken: string; runId: string; userId: string }>;
export type WorkspaceFollowupAdmission = Readonly<{
  admissionKey: string;
  predecessorRunId: string;
  snapshot: unknown;
  sourceRevisionAdvance: 0 | 1;
}>;

/** The caller holds the chat lock. Acceptance permits one waiting successor,
 * never another executor. A completed predecessor takes the ordinary path. */
export async function prepareWorkspaceFollowupAdmission(
  tx: Prisma.TransactionClient, input: PreparingRunAdmissionInput, personalMemory: boolean
): Promise<WorkspaceFollowupAdmission | null> {
  const active = await tx.modelRun.findMany({
    select: { id: true, workspaceWaitPending: true },
    where: { chatId: input.chatId, status: { in: activeModelRunStatuses } }
  });
  if (active.some((run) => run.workspaceWaitPending)) throw new ActiveRunConflictError();
  const followup = input.workspaceFollowup;
  if (!followup) {
    if (active.length) throw new ActiveRunConflictError();
    return null;
  }
  if (input.admissionKind !== "NORMAL_SEND" || !/^[a-f0-9]{64}$/u.test(followup.admissionKey)) {
    throw new WorkspaceFollowupError("workspace_followup_invalid");
  }
  const [previous] = await tx.$queryRaw<Array<{
    answerCompletedAt: Date | null;
    assistantMessageId: string | null;
    status: string;
    workspaceSessionId: string | null;
  }>>(Prisma.sql`
    SELECT r."answerCompletedAt", r."assistantMessageId", r."status", w."workspaceSessionId"
    FROM "ModelRun" r LEFT JOIN "WorkspaceRunBinding" w ON w."modelRunId" = r."id"
    WHERE r."id" = ${followup.predecessorRunId} AND r."chatId" = ${input.chatId}
    FOR UPDATE OF r
  `);
  if (!previous?.answerCompletedAt || !previous.workspaceSessionId ||
    previous.assistantMessageId !== input.expectedActiveLeafId ||
    (input.workspaceAdmissionPlan && input.workspaceAdmissionPlan.sessionId !== previous.workspaceSessionId) ||
    active.some((run) => run.id !== followup.predecessorRunId)) {
    throw new ActiveRunConflictError();
  }
  if (previous.status === "complete") return null;
  if (!active.some((run) => run.id === followup.predecessorRunId)) {
    throw new WorkspaceFollowupError("workspace_followup_predecessor_failed");
  }
  return { ...followup, sourceRevisionAdvance: personalMemory ? 1 : 0 };
}

export async function storeWorkspaceFollowupAdmission(
  tx: Prisma.TransactionClient, input: WorkspaceFollowupAdmission,
  chatId: string, created: PreparingRunAdmissionResult
): Promise<void> {
  await tx.workspaceFollowup.create({ data: {
    admissionKey: input.admissionKey, admissionResult: json(created), chatId,
    deadlineAt: new Date(Date.now() + WORKSPACE_FOLLOWUP_WAIT_MS), modelRunId: created.runId,
    predecessorRunId: input.predecessorRunId, snapshot: json(input.snapshot),
    sourceRevisionAdvance: input.sourceRevisionAdvance
  } });
}

/** Caller locks the run before its job; cancellation uses the same order.
 * A current worker may settle rejected work after scope revocation, but that
 * cleanup authority never permits preparation or external dispatch. */
export async function assertWorkspaceFollowupClaim(
  tx: Prisma.TransactionClient, claim: WorkspaceFollowupClaim,
  purpose: "execution" | "settlement" = "execution"
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT f."modelRunId" AS "id" FROM "WorkspaceFollowup" f
    JOIN "ModelRun" r ON r."id" = f."modelRunId"
    JOIN "Chat" c ON c."id" = r."chatId"
    JOIN "User" u ON u."id" = r."userId"
    WHERE f."modelRunId" = ${claim.runId} AND f."claimToken" = ${claim.claimToken}
      AND f."state" = 'preparing' AND f."leaseExpiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      AND r."status" IN ('preparing', 'streaming') AND r."userId" = ${claim.userId}
      ${purpose === "execution" ? Prisma.sql`
        AND c."permanentDeletionAt" IS NULL AND NOT c."archived" AND u."status" = 'active'
        AND (c."temporaryRetentionDeadline" IS NULL OR c."temporaryRetentionDeadline" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      ` : Prisma.empty}
    FOR UPDATE OF f
  `);
  if (rows.length !== 1) throw new WorkspaceFollowupError("workspace_followup_unavailable");
}

export function createWorkspaceFollowupRepository(prisma: PrismaClient) {
  return {
    async claim(now = new Date(), liveRunIds: readonly string[] = []): Promise<WorkspaceFollowupClaim | null> {
      return prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ runId: string; userId: string }>>(Prisma.sql`
          SELECT f."modelRunId" AS "runId", r."userId" FROM "WorkspaceFollowup" f
          JOIN "ModelRun" r ON r."id" = f."modelRunId"
          JOIN "ModelRun" p ON p."id" = f."predecessorRunId"
          WHERE r."status" IN ('preparing', 'streaming')
            ${liveRunIds.length ? Prisma.sql`AND r."id" NOT IN (${Prisma.join([...liveRunIds])})` : Prisma.empty}
            AND (
            (f."state" = 'waiting' AND
              (p."status" NOT IN ('preparing','queued','streaming','in_progress') OR f."deadlineAt" <= ${now}))
            OR (f."state" = 'preparing' AND (f."leaseExpiresAt" IS NULL OR f."leaseExpiresAt" <= ${now})))
          ORDER BY f."createdAt", f."modelRunId" LIMIT 1 FOR UPDATE OF f SKIP LOCKED
        `);
        if (!row) return null;
        const claimToken = randomUUID();
        await tx.workspaceFollowup.update({ where: { modelRunId: row.runId }, data: {
          claimToken, leaseExpiresAt: new Date(now.getTime() + WORKSPACE_FOLLOWUP_LEASE_MS), state: "preparing"
        } });
        return { ...row, claimToken };
      });
    },
    async hasPending(): Promise<boolean> {
      return await prisma.workspaceFollowup.count({ where: {
        state: { in: ["waiting", "preparing"] }, modelRun: { status: { in: ["preparing", "streaming"] } }
      } }) > 0;
    },
    async release(claim: WorkspaceFollowupClaim): Promise<void> {
      await prisma.workspaceFollowup.updateMany({ where: {
        modelRunId: claim.runId, claimToken: claim.claimToken, state: "preparing"
      }, data: { claimToken: null, leaseExpiresAt: null } });
    },
    async heartbeat(claim: WorkspaceFollowupClaim, now = new Date()): Promise<boolean> {
      const updated = await prisma.workspaceFollowup.updateMany({ where: {
        modelRunId: claim.runId, claimToken: claim.claimToken, state: "preparing",
        leaseExpiresAt: { gt: now }, modelRun: { userId: claim.userId, status: { in: ["preparing", "streaming"] } }
      }, data: { leaseExpiresAt: new Date(now.getTime() + WORKSPACE_FOLLOWUP_LEASE_MS) } });
      return updated.count === 1;
    },
    async load(claim: WorkspaceFollowupClaim) {
      return prisma.workspaceFollowup.findFirst({ where: {
        modelRunId: claim.runId, claimToken: claim.claimToken, state: "preparing",
        leaseExpiresAt: { gt: new Date() }, modelRun: { userId: claim.userId }
      }, include: {
        predecessor: { select: { status: true } },
        modelRun: { select: { chatId: true, status: true, normalizedRequest: true, workspaceWaitPending: true } }
      } });
    },
    async markAnswerDispatched(claim: WorkspaceFollowupClaim): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${claim.runId} FOR UPDATE`;
        await assertWorkspaceFollowupClaim(tx, claim);
        const run = await tx.modelRun.findUnique({ where: { id: claim.runId },
          select: { status: true, workspaceWaitPending: true } });
        if (run?.status !== "streaming" || run.workspaceWaitPending) return false;
        await tx.workspaceFollowup.update({ where: { modelRunId: claim.runId }, data: {
          admissionResult: Prisma.DbNull, snapshot: Prisma.DbNull, state: "dispatched",
          claimToken: null, leaseExpiresAt: null
        } });
        return true;
      });
    }
  };
}
