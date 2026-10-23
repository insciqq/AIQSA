import { Prisma, type ModelRunStatus, type ModelRunToolCall, type PrismaClient } from "@prisma/client";
import { consumeMcpApproval, requestMcpApproval, type McpApprovalScope } from "../mcp/writeApprovalRepository";
import { MCP_APPROVAL_TTL_MS, type McpApprovalCallKey, type McpApprovalRequest } from "../mcp/writeApproval";
import { mcpApprovalRequiredToolCallResult } from "../runs/mcpApprovalGate";
import { dispatchableModelRunStatuses, json } from "../runs/prismaRepositoryShared";
import { snapshotToolLoopJson, toolLoopPersistenceLimits, type ToolLoopJsonValue } from "../runs/toolLoopPersistence";

/**
 * The native engine's `ModelRunToolCall` rows: the record every other table
 * references (Workspace executions, MCP approvals and call details, images,
 * Memory receipts, usage) and the source of the answer's step list. A call is
 * recorded running before it is sent, so an external effect always has its
 * record first; a process that stops mid-call leaves it running, and the
 * run's ending closes it with an unknown outcome that is never sent again.
 */
export type ToolCallRowState = "cancelled" | "complete" | "error" | "pending" | "running";

export type ToolCallRow = Readonly<{
  arguments: Readonly<Record<string, ToolLoopJsonValue>>;
  id: string;
  ordinal: number;
  providerCallId: string;
  result: ToolLoopJsonValue | null;
  roundIndex: number;
  startedAt: string | null;
  state: ToolCallRowState;
  toolName: string;
}>;

export type ToolCallBegin = Readonly<{
  /** The call needs its initiator's approval (`mcpApprovalRequestForCall`). */
  approval?: McpApprovalRequest;
  /**
   * The approval continuation's Allow, which must name exactly this call
   * (`approval`): an Allow once is consumed, an Always allow stands. Without
   * it the call is gated with a new card.
   */
  approvedBy?: string;
  arguments: Record<string, unknown>;
  chatId: string;
  mcpRunBindingId?: string;
  ordinal: number;
  providerCallId: string;
  roundIndex: number;
  runId: string;
  toolName: string;
  userId: string;
  workspaceRunBindingId?: string;
}>;

export type ToolCallBeginResult =
  /** Recorded running: send it. */
  | Readonly<{ kind: "running"; row: ToolCallRow }>
  /** Settled undispatched for the initiator's approval; the card is the approval row. */
  | Readonly<{ approvalId: string; kind: "gated"; row: ToolCallRow }>
  /** The run is no longer active (Stop won): nothing is recorded or sent. */
  | Readonly<{ kind: "inactive" }>;

type ToolCallClient = Pick<PrismaClient, "$transaction" | "modelRunToolCall">;

function rowOf(row: ModelRunToolCall): ToolCallRow {
  return {
    // Written by `begin` and `refuse` as a bounded JSON object only.
    arguments: (row.arguments ?? {}) as Readonly<Record<string, ToolLoopJsonValue>>,
    id: row.id,
    ordinal: row.ordinal,
    providerCallId: row.providerCallId,
    result: row.result as ToolLoopJsonValue | null,
    roundIndex: row.roundIndex,
    startedAt: row.startedAt?.toISOString() ?? null,
    state: row.state,
    toolName: row.toolName
  };
}

/**
 * The user's Allow a continuation names, for exactly this call and still
 * usable: decided within the approval window and not consumed. An Allow once
 * is consumed by this run; an Always allow is a standing consent that is
 * never consumed (`McpToolApproval_state_check`).
 */
async function claimNamedApproval(tx: Prisma.TransactionClient, scope: McpApprovalScope, approvalId: string,
  key: McpApprovalCallKey, now: Date): Promise<boolean> {
  const row = await tx.mcpToolApproval.findFirst({
    select: { decision: true, id: true },
    where: { argumentsDigest: key.argumentsDigest, chatId: scope.chatId, consumedAt: null,
      decidedAt: { gt: new Date(now.getTime() - MCP_APPROVAL_TTL_MS) }, decision: { in: ["allow_once", "allow_server"] },
      definitionHash: key.definitionHash, id: approvalId, modelRunId: { not: scope.runId }, serverId: key.serverId,
      toolName: key.toolName, userId: scope.userId }
  });
  if (!row) return false;
  if (row.decision === "allow_server") return true;
  const consumed = await tx.mcpToolApproval.updateMany({
    data: { consumedAt: now, consumedByRunId: scope.runId },
    where: { consumedAt: null, decision: "allow_once", expiresAt: { gt: now }, id: row.id }
  });
  return consumed.count === 1;
}

function boundedArguments(value: Record<string, unknown>): ToolLoopJsonValue {
  return snapshotToolLoopJson(value, toolLoopPersistenceLimits.argumentsBytes) ?? {};
}

async function lockActiveRun(tx: Prisma.TransactionClient, runId: string, userId: string): Promise<boolean> {
  const [run] = await tx.$queryRaw<Array<{ status: ModelRunStatus }>>(Prisma.sql`
    SELECT "status" FROM "ModelRun" WHERE "id" = ${runId} AND "userId" = ${userId} AND "engine" = 'native' FOR UPDATE
  `);
  return Boolean(run && dispatchableModelRunStatuses.includes(run.status));
}

export function createToolCallStore(client: ToolCallClient) {
  return {
    /** Records one call before it is sent, under the run's lock. */
    async begin(input: ToolCallBegin): Promise<ToolCallBeginResult> {
      if (input.providerCallId.length > toolLoopPersistenceLimits.providerCallIdLength ||
        input.toolName.length > toolLoopPersistenceLimits.toolNameLength) throw new Error("tool_call_identity_invalid");
      return client.$transaction(async (tx) => {
        if (!await lockActiveRun(tx, input.runId, input.userId)) return { kind: "inactive" as const };
        const scope = { chatId: input.chatId, runId: input.runId, userId: input.userId };
        const now = new Date();
        const approved = input.approval && input.approvedBy
          ? await claimNamedApproval(tx, scope, input.approvedBy, input.approval, now)
          : input.approval ? await consumeMcpApproval(tx, scope, input.approval) : true;
        const base = {
          arguments: json(boundedArguments(input.arguments)),
          modelRunId: input.runId,
          ordinal: input.ordinal,
          providerCallId: input.providerCallId,
          roundIndex: input.roundIndex,
          toolName: input.toolName,
          ...(input.mcpRunBindingId ? { mcpRunBindingId: input.mcpRunBindingId } : {}),
          ...(input.workspaceRunBindingId ? { workspaceRunBindingId: input.workspaceRunBindingId } : {})
        };
        if (approved) {
          const row = await tx.modelRunToolCall.create({ data: { ...base, startedAt: now, state: "running" } });
          return { kind: "running" as const, row: rowOf(row) };
        }
        // Never sent: the row is the gated form the step list and the cards read.
        const row = await tx.modelRunToolCall.create({ data: { ...base, completedAt: now, state: "error",
          result: json(mcpApprovalRequiredToolCallResult({ providerCallId: input.providerCallId, toolName: input.toolName })) } });
        const approvalId = await requestMcpApproval(tx, scope, { ...input.approval!, source: "model", toolCallId: row.id });
        return { approvalId, kind: "gated" as const, row: rowOf(row) };
      });
    },

    /** Records a call that is never sent (an unknown tool, a blocked repeat, an exhausted budget) as settled. */
    async refuse(input: Omit<ToolCallBegin, "approval" | "approvedBy" | "mcpRunBindingId" | "workspaceRunBindingId"> &
      Readonly<{ result: ToolLoopJsonValue }>): Promise<ToolCallRow | null> {
      return client.$transaction(async (tx) => {
        if (!await lockActiveRun(tx, input.runId, input.userId)) return null;
        const row = await tx.modelRunToolCall.create({ data: {
          arguments: json(boundedArguments(input.arguments)), completedAt: new Date(), modelRunId: input.runId,
          ordinal: input.ordinal, providerCallId: input.providerCallId, result: json(input.result), roundIndex: input.roundIndex,
          state: "error", toolName: input.toolName
        } });
        return rowOf(row);
      });
    },

    /**
     * Settles a running call with its outcome. A call its executor already
     * settled in its own transaction (a scheduled task or a Skill save), or
     * that the run's ending closed, keeps its row.
     */
    async settle(input: Readonly<{ callId: string; result: ToolLoopJsonValue; runId: string; state: "complete" | "error" }>): Promise<boolean> {
      const settled = await client.modelRunToolCall.updateMany({
        data: { completedAt: new Date(), result: json(input.result), state: input.state },
        where: { id: input.callId, modelRunId: input.runId, state: { in: ["pending", "running"] } }
      });
      return settled.count === 1;
    }
  };
}

export type ToolCallStore = ReturnType<typeof createToolCallStore>;
