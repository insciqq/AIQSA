import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { resolveChatAccess } from "../projects/access";
import { lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { appendRunOutputEvents } from "../runs/prismaRepositoryToolLoop";
import { runOutputArtifactEvents } from "../runs/runOutputEvents";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { uploadFormatForExtension } from "@/lib/domain/uploadFormats";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { CHECKPOINT_OUTPUTS_TOOL_NAME, WORKSPACE_CHECKPOINT_LIMITS } from "../tools/checkpointOutputs";
import { WorkspaceCheckpointError, type WorkspaceCheckpointInput } from "./checkpointInput";
import { workspaceCheckpointResult, type WorkspaceCheckpointFileView } from "./checkpointResult";
import { lockWorkspaceSession, workspaceRunOperationOwner } from "./sessionOperation";

export type CheckpointContext = Readonly<{ runId: string; userId: string; toolCallId: string; call: ModelToolCall }>;
const unavailable = () => new WorkspaceCheckpointError("workspace_checkpoint_unavailable");
const limited = () => new WorkspaceCheckpointError("workspace_checkpoint_limit_exceeded");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export function createWorkspaceCheckpointStore(prisma: PrismaClient, maximumBytes: number) {
  async function checkByteReservation(tx: Prisma.TransactionClient, runId: string, checkpointId: string,
    files: readonly Readonly<{ byteSize: number }>[]) {
    // Binding reserves bytes before retention. Concurrent unfinished checkpoints
    // must consume the same allowance as already published versions.
    const reserved = await tx.workspaceOutputCheckpoint.findMany({ where: {
      modelRunId: runId, id: { not: checkpointId }, state: { in: ["PENDING", "SETTLED"] }, captureId: { not: null }
    }, select: { capture: { select: { files: { select: { byteSize: true } } } } } });
    const used = reserved.reduce((sum, row) => sum + (row.capture?.files.reduce((bytes, file) => bytes + file.byteSize, 0) ?? 0), 0);
    if (used + files.reduce((sum, file) => sum + file.byteSize, 0) > maximumBytes) throw limited();
  }
  async function access(tx: Prisma.TransactionClient, context: CheckpointContext, active: boolean) {
    const run = await tx.modelRun.findFirst({ where: { id: context.runId, userId: context.userId }, select: {
      id: true, chatId: true, userId: true, status: true, assistantMessageId: true,
      workspaceRunBinding: { select: { workspaceSessionId: true } }, chat: { select: { projectId: true } }
    } });
    if (!run?.workspaceRunBinding || !run.assistantMessageId || !await tx.user.findFirst({ where: { id: context.userId, status: "active" } }) ||
      !await resolveChatAccess(tx, { chatId: run.chatId, userId: context.userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" })) throw unavailable();
    if (active) {
      if (!["streaming", "in_progress"].includes(run.status)) throw unavailable();
      const session = await tx.workspaceSession.findUnique({ where: { id: run.workspaceRunBinding.workspaceSessionId } });
      if (!session || session.operationOwner !== workspaceRunOperationOwner(run.id)) throw unavailable();
      const agent = await tx.agentRunBinding.findUnique({ where: { modelRunId: run.id } });
      if (agent && (agent.revokedAt || agent.completedAt || agent.failureCode || agent.followupInterruptAt ||
        !agent.leaseExpiresAt || agent.leaseExpiresAt <= new Date() || agent.expiresAt && agent.expiresAt <= new Date())) throw unavailable();
    }
    const tool = await tx.modelRunToolCall.findFirst({ where: { id: context.toolCallId, modelRunId: run.id,
      providerCallId: context.call.id, toolName: CHECKPOINT_OUTPUTS_TOOL_NAME } });
    if (!tool || active && !["pending", "running", "complete"].includes(tool.state)) throw unavailable();
    return { run, tool };
  }
  async function locked<T>(context: CheckpointContext, active: boolean, action: (tx: Prisma.TransactionClient, current: Awaited<ReturnType<typeof access>>) => Promise<T>) {
    return prisma.$transaction(async tx => {
      await lockRunSettlementScope(tx, context.runId);
      const binding = await tx.workspaceRunBinding.findUnique({ where: { modelRunId: context.runId } });
      if (!binding || !await lockWorkspaceSession(tx, binding.workspaceSessionId)) throw unavailable();
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${context.runId} FOR UPDATE`;
      return action(tx, await access(tx, context, active));
    });
  }
  const hash = (context: CheckpointContext) => hashCanonicalMcpValue(context.call.arguments);
  const decode = (context: CheckpointContext, value: unknown): ToolExecutionResult => {
    const result = parsePersistedToolExecutionResult(context.call, value as Parameters<typeof parsePersistedToolExecutionResult>[1]);
    if (!result) throw unavailable();
    return result;
  };
  async function read(context: CheckpointContext, active = true) {
    return locked(context, active, async tx => {
      const row = await tx.workspaceOutputCheckpoint.findUnique({ where: { toolCallId: context.toolCallId } });
      if (row && (row.modelRunId !== context.runId || row.requestHash !== hash(context))) throw unavailable();
      return row;
    });
  }
  return {
    read,
    async reserve(context: CheckpointContext, input: WorkspaceCheckpointInput) {
      return locked(context, true, async (tx, { tool }) => {
        const existing = await tx.workspaceOutputCheckpoint.findUnique({ where: { toolCallId: context.toolCallId } });
        if (existing) {
          if (existing.requestHash !== hash(context) || existing.modelRunId !== context.runId) throw unavailable();
          return existing;
        }
        if (!["pending", "running"].includes(tool.state)) throw unavailable();
        if (await tx.workspaceOutputCheckpoint.count({ where: { modelRunId: context.runId } }) >= WORKSPACE_CHECKPOINT_LIMITS.perRun) throw limited();
        return tx.workspaceOutputCheckpoint.create({ data: { modelRunId: context.runId, toolCallId: context.toolCallId,
          requestHash: hash(context), description: input.description, selection: json(input.files), arguments: json(context.call.arguments) } });
      });
    },
    async bind(context: CheckpointContext, captureId: string, expectedPaths: readonly string[]) {
      return locked(context, true, async (tx, { run }) => {
        const checkpoint = await tx.workspaceOutputCheckpoint.findUnique({ where: { toolCallId: context.toolCallId } });
        if (!checkpoint || checkpoint.requestHash !== hash(context) || checkpoint.state !== "PENDING" || checkpoint.captureId && checkpoint.captureId !== captureId) throw unavailable();
        const capture = await tx.workspaceSelectedCapture.findUnique({ where: { id: captureId }, include: { files: true,
          binding: { select: { modelRun: { select: { chatId: true, assistantMessageId: true } } } } } });
        if (!capture || capture.state !== "CAPTURED" || capture.binding.modelRun.chatId !== run.chatId ||
          JSON.stringify(capture.files.map(file => file.relativePath).sort()) !== JSON.stringify([...expectedPaths].sort())) throw unavailable();
        if (capture.modelRunId !== run.id) {
          const ancestors = await tx.$queryRaw<Array<{ id: string }>>`WITH RECURSIVE path AS (
            SELECT "id", "parentMessageId" FROM "Message" WHERE "id" = ${run.assistantMessageId} AND "chatId" = ${run.chatId}
            UNION ALL SELECT p."id", p."parentMessageId" FROM path c JOIN "Message" p ON p."id" = c."parentMessageId" WHERE p."chatId" = ${run.chatId}
          ) SELECT "id" FROM path WHERE "id" = ${capture.binding.modelRun.assistantMessageId}`;
          if (!ancestors.length) throw unavailable();
        }
        await checkByteReservation(tx, run.id, checkpoint.id, capture.files);
        await tx.workspaceOutputCheckpoint.update({ where: { id: checkpoint.id }, data: { captureId } });
      });
    },
    async publish(tx: Prisma.TransactionClient, context: CheckpointContext, captured: readonly Readonly<{
      relativePath: string; byteSize: number; checksum: string; mimeType: string; storageKey: string;
    }>[], terminalRecovery = false): Promise<ToolExecutionResult> {
      await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${context.runId} FOR UPDATE`;
      const { run, tool } = await access(tx, context, !terminalRecovery);
      const checkpoint = await tx.workspaceOutputCheckpoint.findUnique({ where: { toolCallId: context.toolCallId } });
      if (!checkpoint || checkpoint.requestHash !== hash(context)) throw unavailable();
      if (checkpoint.state === "SETTLED") return decode(context, checkpoint.result);
      if (checkpoint.state !== "PENDING" || !checkpoint.captureId) throw unavailable();
      const selected = checkpoint.selection as unknown as WorkspaceCheckpointInput["files"];
      if (JSON.stringify(selected.map(f => `${f.root}/${f.relativePath}`).sort()) !== JSON.stringify(captured.map(f => f.relativePath).sort())) throw unavailable();
      await checkByteReservation(tx, run.id, checkpoint.id, captured);
      const view = { id: checkpoint.id, description: checkpoint.description, createdAt: checkpoint.createdAt.toISOString() };
      const user = run.chat.projectId ? await tx.user.findUnique({ where: { id: context.userId }, select: { displayName: true } }) : null;
      const files: WorkspaceCheckpointFileView[] = [];
      for (const file of captured) {
        const fileName = file.relativePath.split("/").at(-1)!;
        const attachment = await tx.attachment.create({ data: { id: randomUUID(), byteSize: file.byteSize, checksum: file.checksum,
          chatId: run.chatId, messageId: run.assistantMessageId, producerModelRunId: run.id, fileName, mimeType: file.mimeType,
          kind: uploadFormatForExtension(fileName, "workspace")?.kind ?? "file", origin: "WORKSPACE_OUTPUT", status: "ready",
          metadata: {}, storageKey: file.storageKey,
          ...(run.chat.projectId ? { projectId: run.chat.projectId, uploaderUserId: context.userId, uploaderDisplayName: user?.displayName }
            : { userId: context.userId }) } });
        await tx.workspaceCheckpointFile.create({ data: { checkpointId: checkpoint.id, captureId: checkpoint.captureId,
          relativePath: file.relativePath, attachmentId: attachment.id } });
        files.push({ attachmentId: attachment.id, byteSize: file.byteSize, fileName, mimeType: file.mimeType, relativePath: file.relativePath, checkpoint: view });
      }
      const result = workspaceCheckpointResult(context.call, view, checkpoint.captureId, files);
      const snapshot = snapshotToolExecutionResult(result, 64 * 1024);
      if (!snapshot) throw unavailable();
      await tx.workspaceOutputCheckpoint.update({ where: { id: checkpoint.id }, data: { state: "SETTLED", settledAt: new Date(), result: json(snapshot) } });
      if (["pending", "running"].includes(tool.state)) await tx.modelRunToolCall.update({ where: { id: tool.id }, data: {
        result: json(snapshot), state: "complete", completedAt: new Date() } });
      await appendRunOutputEvents(tx, run.id, runOutputArtifactEvents(result.artifacts ?? []));
      return result;
    },
    decode,
    async defer(id: string) {
      await prisma.workspaceOutputCheckpoint.updateMany({ where: { id, state: "PENDING" }, data: { updatedAt: new Date() } });
    },
    async pending(limit = 10) {
      return prisma.workspaceOutputCheckpoint.findMany({ where: { state: "PENDING",
        binding: { modelRun: { status: { notIn: ["in_progress", "streaming", "queued", "preparing"] } } } },
        include: { toolCall: true, binding: { select: { modelRun: { select: { userId: true } } } }, capture: { include: { files: true } } },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: Math.min(100, limit) });
    },
    async unavailable(context: CheckpointContext) {
      await locked(context, false, async tx => { await tx.workspaceOutputCheckpoint.updateMany({ where: { toolCallId: context.toolCallId,
        modelRunId: context.runId, state: "PENDING" }, data: { state: "UNAVAILABLE", settledAt: new Date(), failureCode: "workspace_checkpoint_unavailable" } }); });
    }
  };
}
