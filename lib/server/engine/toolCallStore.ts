import { Prisma, type ModelRunStatus, type ModelRunToolCall, type PrismaClient } from "@prisma/client";
import { consumeMcpCallApproval, hasMcpCallApproval, requestMcpApproval } from "../mcp/writeApprovalRepository";
import type { McpApprovalRequest } from "../mcp/writeApproval";
import { mcpApprovalRequiredToolCallResult } from "../runs/mcpApprovalGate";
import { dispatchableModelRunStatuses, isRecord, json } from "../runs/prismaRepositoryShared";
import { snapshotToolLoopJson, toolLoopPersistenceLimits, type ToolLoopJsonValue } from "../runs/toolLoopPersistence";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { LOAD_SKILL_TOOL_NAME } from "../tools/skill";

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
  /** An unknown-outcome retry needs an exact human decision after the uncertain attempt. */
  approvalAfter?: Date;
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

type ToolCallClient = Pick<PrismaClient, "$transaction" | "modelRunToolCall" | "mcpToolApproval">;

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

function boundedArguments(value: Record<string, unknown>): ToolLoopJsonValue {
  return snapshotToolLoopJson(value, toolLoopPersistenceLimits.argumentsBytes) ?? {};
}

/**
 * A completed `load_skill` call loads its Skill for the rest of the run: the
 * binding `read_skill_file`, the Workspace bundle and a task's pinned Skills
 * read (`lib/server/skills/`), written with the call's settlement so neither
 * exists without the other. Only the alias of the run's frozen manifest, with
 * the instructions the call returned, binds its frozen revision.
 */
async function recordLoadedSkill(tx: Prisma.TransactionClient, input: Readonly<{ arguments: Prisma.JsonValue; callId: string;
  result: ToolLoopJsonValue; runId: string }>): Promise<void> {
  const run = await tx.modelRun.findUnique({ select: { normalizedRequest: true }, where: { id: input.runId } });
  const request = run?.normalizedRequest;
  const manifest = isRecord(request) ? decodeFrozenSkillManifest(request.skills) : null;
  const alias = isRecord(input.arguments) ? input.arguments.skill : undefined;
  const reference = manifest?.available.find((skill) => skill.alias === alias);
  const result = input.result;
  const content = isRecord(result) && result.status === "complete" && Array.isArray(result.content) ? result.content[0] : null;
  const loaded = isRecord(content) && content.type === "json" && isRecord(content.value) ? content.value : null;
  if (!reference || !loaded || loaded.skill !== alias || typeof loaded.instructions !== "string") return;
  await tx.modelRunSkillBinding.upsert({
    create: { alias: reference.alias, mode: "loaded", modelRunId: input.runId, modelRunToolCallId: input.callId,
      revisionId: reference.revisionId, skillId: reference.skillId },
    update: {},
    where: { modelRunId_skillId: { modelRunId: input.runId, skillId: reference.skillId } }
  });
}

async function lockActiveRun(tx: Prisma.TransactionClient, runId: string, userId: string): Promise<boolean> {
  const [run] = await tx.$queryRaw<Array<{ status: ModelRunStatus }>>(Prisma.sql`
    SELECT "status" FROM "ModelRun" WHERE "id" = ${runId} AND "userId" = ${userId} AND "engine" = 'native' FOR UPDATE
  `);
  return Boolean(run && dispatchableModelRunStatuses.includes(run.status));
}

export function createToolCallStore(client: ToolCallClient) {
  return {
    hasApproval(input: Pick<ToolCallBegin, "chatId" | "runId" | "userId" | "approvedBy" | "approvalAfter"> & { approval: McpApprovalRequest }) {
      return hasMcpCallApproval(client, input, input.approval, input.approvedBy, input.approvalAfter);
    },
    /** Records one call before it is sent, under the run's lock. */
    async begin(input: ToolCallBegin): Promise<ToolCallBeginResult> {
      if (input.providerCallId.length > toolLoopPersistenceLimits.providerCallIdLength ||
        input.toolName.length > toolLoopPersistenceLimits.toolNameLength) throw new Error("tool_call_identity_invalid");
      return client.$transaction(async (tx) => {
        if (!await lockActiveRun(tx, input.runId, input.userId)) return { kind: "inactive" as const };
        const scope = { chatId: input.chatId, runId: input.runId, userId: input.userId };
        const now = new Date();
        const humanApproved = input.approval
          ? await consumeMcpCallApproval(tx, scope, input.approval, input.approvedBy, input.approvalAfter) : true;
        const approved = humanApproved || input.approval?.guard?.decision === "allow";
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
          if (input.approval?.guard?.decision === "allow" && !humanApproved) {
            await requestMcpApproval(tx, scope, { ...input.approval, source: "model", toolCallId: row.id });
          }
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
     * that the run's ending closed, keeps its row. A completed `load_skill`
     * records its loaded Skill in the same transaction (`recordLoadedSkill`).
     */
    async settle(input: Readonly<{ callId: string; result: ToolLoopJsonValue; runId: string; state: "complete" | "error" }>): Promise<boolean> {
      return client.$transaction(async (tx) => {
        const settled = await tx.modelRunToolCall.updateMany({
          data: { completedAt: new Date(), result: json(input.result), state: input.state },
          where: { id: input.callId, modelRunId: input.runId, state: { in: ["pending", "running"] } }
        });
        if (settled.count !== 1) return false;
        if (input.state === "complete") {
          const call = await tx.modelRunToolCall.findUniqueOrThrow({ select: { arguments: true, toolName: true },
            where: { id: input.callId } });
          if (call.toolName === LOAD_SKILL_TOOL_NAME) {
            await recordLoadedSkill(tx, { arguments: call.arguments, callId: input.callId, result: input.result, runId: input.runId });
          }
        }
        return true;
      });
    }
  };
}

type CreatedToolCallStore = ReturnType<typeof createToolCallStore>;
export type ToolCallStore = Omit<CreatedToolCallStore, "hasApproval"> & Partial<Pick<CreatedToolCallStore, "hasApproval">>;
