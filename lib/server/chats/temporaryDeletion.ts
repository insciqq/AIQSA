import { Prisma } from "@prisma/client";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { BackgroundWorkError } from "../background/errors";
import { settleLegacyMemoryWorkOfChat } from "../background/legacyMemoryRows";
import {
  ACTIVE_RUN_STATUSES,
  chatDeletionLeaseLost,
  deleteChatAggregate,
  deleteExclusiveChatObjects,
  removeChatWorkspace,
  snapshotChatAttachments,
  type ChatAggregateScope
} from "./aggregateDeletion";
import type { ChatPurgeContext, ChatPurgeDependencies } from "./permanentDeletion/cleanup";

const EXPIRED_MESSAGE = "Temporary retention expired before this run settled.";
const ACTIVE_MESSAGE_STATUSES = ["queued", "streaming"] as const;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

type LockedTemporaryChat = Readonly<{
  memoryMode: string;
  temporaryRetentionDeadline: Date | null;
  temporaryRetentionPolicyVersion: string | null;
}>;

async function lockTemporaryChat(
  tx: Prisma.TransactionClient,
  scope: ChatAggregateScope
): Promise<LockedTemporaryChat | null> {
  const [chat] = await tx.$queryRaw<LockedTemporaryChat[]>(Prisma.sql`
    SELECT "memoryMode"::text AS "memoryMode", "temporaryRetentionDeadline", "temporaryRetentionPolicyVersion"
    FROM "Chat"
    WHERE "id" = ${scope.chatId} AND "userId" = ${scope.userId}
    FOR UPDATE
  `);
  return chat ?? null;
}

function due(chat: LockedTemporaryChat, now: Date): boolean {
  return chat.memoryMode === "TEMPORARY" &&
    chat.temporaryRetentionPolicyVersion === MEMORY_TEMPORARY_RETENTION_POLICY_VERSION &&
    chat.temporaryRetentionDeadline !== null &&
    chat.temporaryRetentionDeadline <= now;
}

/** A run still active past the deadline ends as failed, its open tool calls with it, before the chat goes. */
async function settleOverdueRuns(
  tx: Prisma.TransactionClient,
  scope: ChatAggregateScope,
  now: Date
): Promise<void> {
  const runs = await tx.modelRun.findMany({
    select: { assistantMessageId: true, id: true },
    where: { chatId: scope.chatId, status: { in: [...ACTIVE_RUN_STATUSES] }, userId: scope.userId }
  });
  if (runs.length === 0) return;
  const runIds = runs.map(({ id }) => id);
  await settleLegacyMemoryWorkOfChat(tx, scope, {
    errorCode: "memory_temporary_retention_expired", now, runIds
  });
  await tx.modelRunToolCall.updateMany({
    data: { completedAt: now, result: json({ error: "temporary_retention_expired" }), state: "cancelled" },
    where: { modelRunId: { in: runIds }, state: "pending" }
  });
  await tx.modelRunToolCall.updateMany({
    data: { completedAt: now, result: json({ error: "temporary_retention_expired" }), state: "error" },
    where: { modelRunId: { in: runIds }, state: "running" }
  });
  const assistantMessageIds = runs.flatMap(({ assistantMessageId }) => assistantMessageId ? [assistantMessageId] : []);
  if (assistantMessageIds.length > 0) {
    await tx.message.updateMany({
      data: { errorMessage: EXPIRED_MESSAGE, status: "error" },
      where: { id: { in: assistantMessageIds }, status: { in: [...ACTIVE_MESSAGE_STATUSES] } }
    });
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ModelRun"
    SET "status" = 'error'::"ModelRunStatus",
      "errorPayload" = jsonb_build_object('code', 'temporary_retention_expired', 'message', ${EXPIRED_MESSAGE}::text),
      "normalizedRequest" = COALESCE("normalizedRequest", '{}'::jsonb),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" IN (${Prisma.join(runIds)})
      AND "userId" = ${scope.userId}
      AND "status" IN ('preparing'::"ModelRunStatus", 'queued'::"ModelRunStatus",
        'streaming'::"ModelRunStatus", 'in_progress'::"ModelRunStatus")
  `);
}

/**
 * Deletes one Temporary chat whose retention deadline has passed, with its Workspace and the objects only it
 * references (`lib/server/background/chatDeletionPasses.ts` finds due chats by their deadline). Idempotent and
 * resumable like permanent deletion. `not_due` means the deadline moved (a run finished and extended it): the
 * caller gives the claim back without counting an attempt.
 */
export async function deleteExpiredTemporaryChat(
  dependencies: ChatPurgeDependencies,
  scope: ChatAggregateScope,
  context: ChatPurgeContext
): Promise<"deleted" | "gone" | "not_due"> {
  const { client } = dependencies;
  const snapshot = await client.$transaction(async (tx) => {
    const chat = await lockTemporaryChat(tx, scope);
    if (!chat) return null;
    if (!due(chat, context.now)) return "not_due" as const;
    await settleOverdueRuns(tx, scope, context.now);
    return { attachments: await snapshotChatAttachments(tx, scope) };
  });
  if (snapshot === null) {
    return client.$transaction(async (tx) => {
      if (!(await context.complete(tx))) chatDeletionLeaseLost();
      return "gone" as const;
    });
  }
  if (snapshot === "not_due") return "not_due";
  await removeChatWorkspace({
    client, now: context.now, runtime: dependencies.workspaceRuntime, scope, signal: context.signal
  });
  const dispositions = await deleteExclusiveChatObjects({
    attachments: snapshot.attachments, client, signal: context.signal, storage: dependencies.storage
  });
  // A worker that lost its claim (or is stopping) starts no further work; the new holder finishes the item.
  context.signal.throwIfAborted();
  return client.$transaction(async (tx) => {
    const chat = await lockTemporaryChat(tx, scope);
    if (!chat) throw new BackgroundWorkError("chat_deletion_aggregate_changed");
    if (!due(chat, context.now)) throw new BackgroundWorkError("temporary_chat_deletion_not_due");
    const activeRuns = await tx.modelRun.count({
      where: { chatId: scope.chatId, status: { in: [...ACTIVE_RUN_STATUSES] }, userId: scope.userId }
    });
    if (activeRuns > 0) throw new BackgroundWorkError("chat_deletion_run_still_active");
    await deleteChatAggregate(tx, {
      attachments: snapshot.attachments,
      chatExists: true,
      chatWhere: { memoryMode: "TEMPORARY" },
      dispositions,
      now: context.now,
      scope
    });
    if (!(await context.complete(tx))) chatDeletionLeaseLost();
    return "deleted" as const;
  }, { timeout: 60_000 });
}
