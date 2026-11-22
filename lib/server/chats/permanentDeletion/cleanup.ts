import { Prisma, type PrismaClient } from "@prisma/client";
import { BackgroundWorkError } from "../../background/errors";
import type { StorageAdapter } from "../../uploads/storage";
import type { WorkspaceRuntime } from "../../workspace/runtime";
import {
  ACTIVE_RUN_STATUSES,
  deleteChatAggregate,
  deleteExclusiveChatObjects,
  removeChatWorkspace,
  snapshotChatAttachments,
  chatDeletionLeaseLost,
  type ChatAggregateScope
} from "../aggregateDeletion";

export type ChatPurgeDependencies = Readonly<{
  client: PrismaClient;
  storage: Pick<StorageAdapter, "deleteObject">;
  workspaceRuntime?: WorkspaceRuntime;
}>;

export type ChatPurgeContext = Readonly<{
  /** Records the item completed inside the final transaction; false means the worker lost its claim. */
  complete: (tx: Prisma.TransactionClient) => Promise<boolean>;
  now: Date;
  signal: AbortSignal;
}>;

/**
 * The final stage of permanent deletion, run by the background worker for each fenced chat
 * (`lib/server/background/chatDeletionPasses.ts`): it stops and removes the chat's Workspace, deletes the
 * objects only the chat references and then, in one transaction, every row of the chat. It is idempotent: a
 * failure anywhere leaves the fence in place, and the next attempt resumes from whatever is left. A chat that is
 * already gone completes at once.
 */
export async function purgePermanentlyDeletedChat(
  dependencies: ChatPurgeDependencies,
  scope: ChatAggregateScope,
  context: ChatPurgeContext
): Promise<"deleted" | "gone"> {
  const { client } = dependencies;
  await removeChatWorkspace({
    client, now: context.now, runtime: dependencies.workspaceRuntime, scope, signal: context.signal
  });
  const snapshot = await client.$transaction(async (tx) => {
    const [chat] = await tx.$queryRaw<Array<{ archived: boolean; permanentDeletionAt: Date | null }>>(Prisma.sql`
      SELECT "archived", "permanentDeletionAt"
      FROM "Chat"
      WHERE "id" = ${scope.chatId} AND "userId" = ${scope.userId}
      FOR SHARE
    `);
    if (chat) {
      if (!chat.archived || chat.permanentDeletionAt === null) {
        throw new BackgroundWorkError("chat_deletion_fence_invalid");
      }
      // Admission refused while the main answer ran and stopped the chat's background sub-agents after the
      // fence; anything still active settles before the rows go.
      const activeRuns = await tx.modelRun.count({
        where: { chatId: scope.chatId, status: { in: [...ACTIVE_RUN_STATUSES] }, userId: scope.userId }
      });
      if (activeRuns > 0) throw new BackgroundWorkError("chat_deletion_run_still_active");
    }
    return { attachments: await snapshotChatAttachments(tx, scope), chatExists: Boolean(chat) };
  });
  const dispositions = await deleteExclusiveChatObjects({
    attachments: snapshot.attachments, client, signal: context.signal, storage: dependencies.storage
  });
  // A worker that lost its claim (or is stopping) starts no further work; the new holder finishes the item.
  context.signal.throwIfAborted();
  return client.$transaction(async (tx) => {
    const [chat] = await tx.$queryRaw<Array<{ permanentDeletionAt: Date | null }>>(Prisma.sql`
      SELECT "permanentDeletionAt"
      FROM "Chat"
      WHERE "id" = ${scope.chatId} AND "userId" = ${scope.userId}
      FOR UPDATE
    `);
    if (chat && chat.permanentDeletionAt === null) throw new BackgroundWorkError("chat_deletion_fence_invalid");
    if (Boolean(chat) !== snapshot.chatExists) throw new BackgroundWorkError("chat_deletion_aggregate_changed");
    await deleteChatAggregate(tx, {
      attachments: snapshot.attachments,
      chatExists: snapshot.chatExists,
      chatWhere: { permanentDeletionAt: { not: null } },
      dispositions,
      now: context.now,
      scope
    });
    if (!(await context.complete(tx))) chatDeletionLeaseLost();
    return snapshot.chatExists ? "deleted" as const : "gone" as const;
  }, { timeout: 60_000 });
}
