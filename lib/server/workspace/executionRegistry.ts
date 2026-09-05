import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type WorkspaceExecutionState } from "@prisma/client";
import { isWorkspaceRuntimeExecSessionId } from "@/lib/domain/workspace";
import { WorkspaceRuntimeError } from "./runtime";
import { namespacedWorkspaceToolName } from "./toolCatalog";
import type { WorkspaceOperation } from "./operationFence";
import { workspaceOperationWhere } from "./sessionOperation";

const SYNC_CLEANUP_PREFIX = "workspace-sync:";

/** Private obligation: the synchronous MCP handler exposes no process handle. */
export function workspaceSyncCleanupId(modelRunToolCallId: string): string {
  return SYNC_CLEANUP_PREFIX + createHash("sha256").update(modelRunToolCallId).digest("hex");
}

export function isWorkspaceSyncCleanupId(value: string): boolean {
  return value.startsWith(SYNC_CLEANUP_PREFIX);
}

// An error or lost reply does not prove that dispatch never reached the guest.
// The accepted tool-call ledger remains the backstop when no registry row exists.
export const UNREGISTERED_WORKSPACE_COMMAND_FILTER = {
  toolName: { in: (["sandbox_shell", "sandbox_exec", "sandbox_exec_start"] as const).map(namespacedWorkspaceToolName) },
  workspaceExecution: { is: null }
} satisfies Prisma.ModelRunToolCallWhereInput;

/**
 * Durable cleanup ownership of commands, including private synchronous
 * obligations and official long-lived execution ids. The runner keeps a
 * process-local cache, but only this
 * registry survives app or runner restarts and therefore decides which
 * executions a terminal run still has to quiesce.
 */
export type WorkspaceExecutionRecord = Readonly<{
  id: string;
  modelRunId: string;
  modelRunToolCallId: string;
  runtimeExecSessionId: string;
  sessionId: string;
  state: WorkspaceExecutionState;
}>;

export const WORKSPACE_EXECUTION_OPEN_STATES = Object.freeze([
  "ACTIVE",
  "TERMINATING"
] as const satisfies readonly WorkspaceExecutionState[]);

export type WorkspaceExecutionRegistry = Readonly<{
  /** Moves every open execution of a session to a terminal state (VM stopped or removed). */
  closeAll(input: Readonly<{
    operation?: WorkspaceOperation;
    errorCode?: string | null;
    modelRunId?: string;
    sessionId: string;
    to: "CLOSED" | "LOST";
  }>): Promise<number>;
  find(input: Readonly<{
    operation?: WorkspaceOperation;
    runtimeExecSessionId: string;
    sessionId: string;
  }>): Promise<WorkspaceExecutionRecord | null>;
  listOpen(input: Readonly<{
    operation?: WorkspaceOperation;
    modelRunId?: string;
    sessionId: string;
  }>): Promise<readonly WorkspaceExecutionRecord[]>;
  register(input: Readonly<{
    operation?: WorkspaceOperation;
    modelRunId: string;
    modelRunToolCallId: string;
    runtimeExecSessionId: string;
    sessionId: string;
  }>): Promise<"conflict" | "registered">;
  transition(input: Readonly<{
    operation?: WorkspaceOperation;
    errorCode?: string | null;
    from: readonly WorkspaceExecutionState[];
    id: string;
    to: WorkspaceExecutionState;
  }>): Promise<boolean>;
}>;

const RECORD_SELECT = {
  id: true,
  modelRunId: true,
  modelRunToolCallId: true,
  runtimeExecSessionId: true,
  state: true,
  workspaceSessionId: true
} as const;

function record(row: Readonly<{
  id: string;
  modelRunId: string;
  modelRunToolCallId: string;
  runtimeExecSessionId: string;
  state: WorkspaceExecutionState;
  workspaceSessionId: string;
}>): WorkspaceExecutionRecord {
  return {
    id: row.id,
    modelRunId: row.modelRunId,
    modelRunToolCallId: row.modelRunToolCallId,
    runtimeExecSessionId: row.runtimeExecSessionId,
    sessionId: row.workspaceSessionId,
    state: row.state
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Caller holds the exact session lock after stop proof; null is reserved for an offline, disk-free installation restore. */
export async function acknowledgeWorkspaceCommandsStopped(tx: Prisma.TransactionClient, sessionId: string | null): Promise<void> {
  await tx.workspaceExecution.updateMany({
    data: { completedAt: new Date(), state: "LOST", lastErrorCode: "workspace_execution_cleanup_failed" },
    where: { ...(sessionId !== null ? { workspaceSessionId: sessionId } : {}), state: { in: [...WORKSPACE_EXECUTION_OPEN_STATES] } }
  });
  // Record the stop proof for accepted dispatches whose reply/registration was
  // lost. A historical missing handle must neither be replayed nor block all
  // future admission after a proven VM stop. Set-based SQL avoids a page cap.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "WorkspaceExecution" (
      "id", "workspaceSessionId", "modelRunId", "modelRunToolCallId", "runtimeExecSessionId",
      "state", "startedAt", "completedAt", "lastErrorCode", "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid()::text, binding."workspaceSessionId", tc."modelRunId", tc."id",
      ${SYNC_CLEANUP_PREFIX} || encode(sha256(convert_to(tc."id", 'UTF8')), 'hex'),
      'LOST'::"WorkspaceExecutionState", now(), now(), 'workspace_execution_cleanup_failed', now(), now()
    FROM "ModelRunToolCall" tc
    JOIN "WorkspaceRunBinding" binding ON binding."modelRunId" = tc."workspaceRunBindingId"
    WHERE ${sessionId !== null ? Prisma.sql`binding."workspaceSessionId" = ${sessionId}` : Prisma.sql`TRUE`}
      AND tc."toolName" IN (${Prisma.join(UNREGISTERED_WORKSPACE_COMMAND_FILTER.toolName.in)})
      AND NOT EXISTS (SELECT 1 FROM "WorkspaceExecution" e WHERE e."modelRunToolCallId" = tc."id")
    ON CONFLICT ("modelRunToolCallId") DO NOTHING
  `);
}

export function createPrismaWorkspaceExecutionRegistry(
  prisma: PrismaClient
): WorkspaceExecutionRegistry {
  async function guarded<T>(sessionId: string, operation: WorkspaceOperation | undefined, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!operation) return action(prisma);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${sessionId} FOR UPDATE`;
      if (!(await tx.workspaceSession.findFirst({
        select: { id: true }, where: { id: sessionId, ...workspaceOperationWhere(operation) }
      }))) throw new WorkspaceRuntimeError("workspace_operation_stale");
      return action(tx);
    });
  }
  return {
    async closeAll({ errorCode, modelRunId, operation, sessionId, to }) {
      const updated = await guarded(sessionId, operation, (tx) => tx.workspaceExecution.updateMany({
        data: {
          completedAt: new Date(),
          state: to,
          ...(errorCode === undefined ? {} : { lastErrorCode: errorCode?.slice(0, 64) ?? null })
        },
        where: {
          state: { in: [...WORKSPACE_EXECUTION_OPEN_STATES] },
          workspaceSessionId: sessionId,
          ...(modelRunId ? { modelRunId } : {})
        }
      }));
      return updated.count;
    },
    async find({ runtimeExecSessionId, sessionId }) {
      if (!isWorkspaceRuntimeExecSessionId(runtimeExecSessionId)) return null;
      const row = await prisma.workspaceExecution.findUnique({
        select: RECORD_SELECT,
        where: {
          workspaceSessionId_runtimeExecSessionId: {
            runtimeExecSessionId,
            workspaceSessionId: sessionId
          }
        }
      });
      return row ? record(row) : null;
    },
    async listOpen({ modelRunId, sessionId }) {
      const rows = await prisma.workspaceExecution.findMany({
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        select: RECORD_SELECT,
        take: 256,
        where: {
          state: { in: [...WORKSPACE_EXECUTION_OPEN_STATES] },
          workspaceSessionId: sessionId,
          ...(modelRunId ? { modelRunId } : {})
        }
      });
      return rows.map(record);
    },
    async register(input) {
      if (!isWorkspaceRuntimeExecSessionId(input.runtimeExecSessionId)) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      try {
        await guarded(input.sessionId, input.operation, (tx) => tx.workspaceExecution.create({
          data: {
            modelRunId: input.modelRunId,
            modelRunToolCallId: input.modelRunToolCallId,
            runtimeExecSessionId: input.runtimeExecSessionId,
            workspaceSessionId: input.sessionId
          },
          select: { id: true }
        }));
        return "registered";
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A replayed registration for the same accepted tool call is idempotent;
        // any other collision means two owners claim one guest execution.
        const existing = await prisma.workspaceExecution.findUnique({
          select: RECORD_SELECT,
          where: { modelRunToolCallId: input.modelRunToolCallId }
        });
        return existing &&
          existing.modelRunId === input.modelRunId &&
          existing.workspaceSessionId === input.sessionId &&
          existing.runtimeExecSessionId === input.runtimeExecSessionId
          ? "registered"
          : "conflict";
      }
    },
    async transition({ errorCode, from, id, operation, to }) {
      if (from.length === 0) return false;
      const terminal = to === "CLOSED" || to === "LOST";
      const row = operation ? await prisma.workspaceExecution.findUnique({ select: { workspaceSessionId: true }, where: { id } }) : null;
      if (operation && !row) return false;
      const updated = await guarded(row?.workspaceSessionId ?? "", operation, (tx) => tx.workspaceExecution.updateMany({
        data: {
          state: to,
          ...(terminal ? { completedAt: new Date() } : {}),
          ...(errorCode === undefined ? {} : { lastErrorCode: errorCode?.slice(0, 64) ?? null })
        },
        where: { id, state: { in: [...from] } }
      }));
      return updated.count === 1;
    }
  };
}
