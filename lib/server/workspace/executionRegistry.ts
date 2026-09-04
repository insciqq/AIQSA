import { Prisma, type PrismaClient, type WorkspaceExecutionState } from "@prisma/client";
import { isWorkspaceRuntimeExecSessionId } from "@/lib/domain/workspace";
import { WorkspaceRuntimeError } from "./runtime";

/**
 * Durable ownership of long-lived guest executions started through
 * `sandbox_exec_start`. The runner keeps a process-local cache, but only this
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
    errorCode?: string | null;
    modelRunId?: string;
    sessionId: string;
    to: "CLOSED" | "LOST";
  }>): Promise<number>;
  find(input: Readonly<{
    runtimeExecSessionId: string;
    sessionId: string;
  }>): Promise<WorkspaceExecutionRecord | null>;
  listOpen(input: Readonly<{
    modelRunId?: string;
    sessionId: string;
  }>): Promise<readonly WorkspaceExecutionRecord[]>;
  register(input: Readonly<{
    modelRunId: string;
    modelRunToolCallId: string;
    runtimeExecSessionId: string;
    sessionId: string;
  }>): Promise<"conflict" | "registered">;
  transition(input: Readonly<{
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

export function createPrismaWorkspaceExecutionRegistry(
  prisma: PrismaClient
): WorkspaceExecutionRegistry {
  return {
    async closeAll({ errorCode, modelRunId, sessionId, to }) {
      const updated = await prisma.workspaceExecution.updateMany({
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
      });
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
        await prisma.workspaceExecution.create({
          data: {
            modelRunId: input.modelRunId,
            modelRunToolCallId: input.modelRunToolCallId,
            runtimeExecSessionId: input.runtimeExecSessionId,
            workspaceSessionId: input.sessionId
          },
          select: { id: true }
        });
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
    async transition({ errorCode, from, id, to }) {
      if (from.length === 0) return false;
      const terminal = to === "CLOSED" || to === "LOST";
      const updated = await prisma.workspaceExecution.updateMany({
        data: {
          state: to,
          ...(terminal ? { completedAt: new Date() } : {}),
          ...(errorCode === undefined ? {} : { lastErrorCode: errorCode?.slice(0, 64) ?? null })
        },
        where: { id, state: { in: [...from] } }
      });
      return updated.count === 1;
    }
  };
}
