import { Prisma, type PrismaClient } from "@prisma/client";
import { BackgroundWorkError } from "../background/errors";
import { purgeLegacyMemoryRowsOfChat } from "../background/legacyMemoryRows";
import type { StorageAdapter } from "../uploads/storage";
import { WorkspaceRuntimeError, type WorkspaceRuntime } from "../workspace/runtime";
import { removeWorkspaceForDeletion } from "../workspace/removal";

/**
 * The steps Temporary expiry and permanent deletion share to remove one chat with everything it owns: its
 * Workspace, the object bytes only it references, and in one final transaction its rows. Guest and object I/O
 * run outside any transaction; the final transaction rechecks every reference before it deletes a row.
 */

export type ChatAggregateScope = Readonly<{ chatId: string; userId: string }>;

export type ChatAttachmentSnapshot = Readonly<{
  chatPdfArtifacts?: readonly Readonly<{ id: string; storageKey: string }>[];
  id: string;
  storageKey: string;
}>;

export type ChatObjectDisposition = Readonly<{ deleted: boolean; storageKey: string }>;

export const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"] as const;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("chat_deletion_aborted");
}

/** The chat's attachments in a stable order; another owner's attachment in the chat blocks deletion. */
export async function snapshotChatAttachments(
  tx: Prisma.TransactionClient,
  scope: ChatAggregateScope
): Promise<readonly ChatAttachmentSnapshot[]> {
  const attachments = await tx.attachment.findMany({
    orderBy: { id: "asc" },
    select: {
      chatPdfArtifacts: { orderBy: { id: "asc" }, select: { id: true, storageKey: true } },
      id: true,
      storageKey: true,
      userId: true
    },
    where: { chatId: scope.chatId }
  });
  if (attachments.some((attachment) => attachment.userId !== scope.userId)) {
    throw new BackgroundWorkError("chat_deletion_attachment_owner_mismatch");
  }
  return attachments.map(({ chatPdfArtifacts, id, storageKey }) => ({
    id,
    storageKey,
    ...(chatPdfArtifacts.length > 0 ? { chatPdfArtifacts } : {})
  }));
}

function sameAttachments(
  left: readonly ChatAttachmentSnapshot[],
  right: readonly ChatAttachmentSnapshot[]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.id === right[index]?.id && entry.storageKey === right[index]?.storageKey &&
    JSON.stringify(entry.chatPdfArtifacts ?? []) === JSON.stringify(right[index]?.chatPdfArtifacts ?? []));
}

async function otherReferences(
  client: Pick<Prisma.TransactionClient, "attachment" | "chatPdfArtifact">,
  attachmentIds: readonly string[],
  storageKey: string
): Promise<number> {
  const [attachments, pdfArtifacts] = await Promise.all([
    client.attachment.count({ where: { id: { notIn: [...attachmentIds] }, storageKey } }),
    client.chatPdfArtifact.count({ where: { attachmentId: { notIn: [...attachmentIds] }, storageKey } })
  ]);
  return attachments + pdfArtifacts;
}

/** Stops and removes the chat's Workspace VM, if it has one; idempotent, retried on failure. */
export async function removeChatWorkspace(
  input: Readonly<{
    client: PrismaClient;
    now: Date;
    runtime?: WorkspaceRuntime;
    scope: ChatAggregateScope;
    signal: AbortSignal;
  }>
): Promise<void> {
  const session = await input.client.workspaceSession.findUnique({
    select: { id: true },
    where: { chatId: input.scope.chatId }
  });
  if (!session) return;
  try {
    await removeWorkspaceForDeletion({
      now: input.now, prisma: input.client, runtime: input.runtime, sessionId: session.id, signal: input.signal
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new BackgroundWorkError(
      error instanceof WorkspaceRuntimeError && error.code === "workspace_runtime_unavailable"
        ? "chat_deletion_workspace_runtime_unavailable"
        : "chat_deletion_workspace_cleanup_failed"
    );
  }
}

/** Deletes the bytes no other attachment or PDF page references; shared bytes stay. Idempotent. */
export async function deleteExclusiveChatObjects(
  input: Readonly<{
    attachments: readonly ChatAttachmentSnapshot[];
    client: Pick<PrismaClient, "attachment" | "chatPdfArtifact">;
    signal: AbortSignal;
    storage: Pick<StorageAdapter, "deleteObject">;
  }>
): Promise<readonly ChatObjectDisposition[]> {
  const attachmentIds = input.attachments.map(({ id }) => id);
  const keys = [...new Set(input.attachments.flatMap(({ chatPdfArtifacts, storageKey }) =>
    [storageKey, ...(chatPdfArtifacts ?? []).map((artifact) => artifact.storageKey)]))].sort();
  const dispositions: ChatObjectDisposition[] = [];
  for (const storageKey of keys) {
    throwIfAborted(input.signal);
    const shared = await otherReferences(input.client, attachmentIds, storageKey) > 0;
    if (!shared) {
      try {
        await input.storage.deleteObject(storageKey, { signal: input.signal });
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new BackgroundWorkError("chat_deletion_object_delete_failed");
      }
    }
    dispositions.push({ deleted: !shared, storageKey });
  }
  throwIfAborted(input.signal);
  return dispositions;
}

// Occurrence history outlives the chat with its chat, message and run links cleared, the end state of their
// SET NULL foreign keys. Clearing them in one statement before any run or the chat goes is required: otherwise
// deleting the runs rewrites the occurrence rows first, and PostgreSQL re-checks every foreign key of a row this
// transaction already wrote when the chat's cascade later clears its chatId, while the cascaded messages are
// already gone and their own SET NULL has not run yet (P2003 on the userMessageId key).
async function detachScheduledTaskOccurrences(
  tx: Prisma.TransactionClient,
  scope: ChatAggregateScope
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    WITH chat_runs AS (
      SELECT run."id" FROM "ModelRun" AS run
      WHERE run."userId" = ${scope.userId} AND run."chatId" = ${scope.chatId}
    ), chat_messages AS (
      SELECT message."id" FROM "Message" AS message
      WHERE message."chatId" = ${scope.chatId}
    )
    UPDATE "ScheduledTaskOccurrence" AS occurrence
    SET
      "chatId" = CASE WHEN occurrence."chatId" = ${scope.chatId}
        THEN NULL ELSE occurrence."chatId" END,
      "runId" = CASE WHEN occurrence."runId" IN (SELECT "id" FROM chat_runs)
        THEN NULL ELSE occurrence."runId" END,
      "userMessageId" = CASE WHEN occurrence."userMessageId" IN (SELECT "id" FROM chat_messages)
        THEN NULL ELSE occurrence."userMessageId" END
    WHERE occurrence."userId" = ${scope.userId}
      AND (
        occurrence."chatId" = ${scope.chatId}
        OR occurrence."runId" IN (SELECT "id" FROM chat_runs)
        OR occurrence."userMessageId" IN (SELECT "id" FROM chat_messages)
      )
  `);
}

/**
 * Inside the final transaction, with the chat row locked by the caller: rechecks the attachments and every kept
 * object's references, then deletes the chat's shares, attachments, runs, Workspace session and the chat itself.
 * Usage keeps its rows (their run and chat links clear through their own keys); deleting chats never resets spend.
 */
export async function deleteChatAggregate(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    attachments: readonly ChatAttachmentSnapshot[];
    chatExists: boolean;
    dispositions: readonly ChatObjectDisposition[];
    now: Date;
    scope: ChatAggregateScope;
    /** Exactly the chat row to delete; the caller's fence (Temporary mode, the permanent-deletion fence). */
    chatWhere: Prisma.ChatWhereInput;
  }>
): Promise<void> {
  const { scope } = input;
  const current = await snapshotChatAttachments(tx, scope);
  if (!sameAttachments(input.attachments, current)) {
    throw new BackgroundWorkError("chat_deletion_aggregate_changed");
  }
  const attachmentIds = current.map(({ id }) => id);
  const kept = input.dispositions.filter(({ deleted }) => !deleted).map(({ storageKey }) => storageKey).sort();
  for (const storageKey of kept) {
    // The per-object lock retention and saved files take (`lib/server/retention/prune.ts`): two deletions removing
    // the last references to one shared object serialize here, so the later one, reading after the earlier one
    // committed, finds no other reference left and stages the object's deletion instead of stranding its bytes.
    // The object worker deletes it only once nothing references it any more.
    await tx.$queryRaw<Array<{ lock: string }>>(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 260))::text AS "lock"
    `);
    if (await otherReferences(tx, attachmentIds, storageKey) > 0) continue;
    const staged = await tx.attachmentDeletionJob.findUnique({ select: { id: true }, where: { storageKey } });
    if (!staged) await tx.attachmentDeletionJob.create({ data: { storageKey } });
  }
  const runs = await tx.modelRun.findMany({
    select: { id: true },
    where: { chatId: scope.chatId, userId: scope.userId }
  });
  const runIds = runs.map(({ id }) => id);
  // Until the old Memory tables are dropped, their rows of this chat must go first (restrictive keys).
  await purgeLegacyMemoryRowsOfChat(tx, scope, { now: input.now, runIds });
  await tx.sharedChatSnapshot.deleteMany({ where: { chatId: scope.chatId, ownerUserId: scope.userId } });
  if (current.length > 0) {
    await tx.attachment.deleteMany({ where: { chatId: scope.chatId, userId: scope.userId } });
    const deletedKeys = input.dispositions
      .filter(({ deleted, storageKey }) => deleted && !storageKey.startsWith("chat-pdf/"))
      .map(({ storageKey }) => storageKey);
    if (deletedKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: deletedKeys } } });
    }
  }
  await detachScheduledTaskOccurrences(tx, scope);
  if (runIds.length > 0) {
    await tx.modelRun.deleteMany({ where: { id: { in: runIds }, userId: scope.userId } });
  }
  const session = await tx.workspaceSession.findUnique({
    select: { id: true, runtimeSandboxId: true },
    where: { chatId: scope.chatId }
  });
  if (session) {
    if (session.runtimeSandboxId !== null) {
      throw new BackgroundWorkError("chat_deletion_workspace_cleanup_pending");
    }
    await tx.workspaceCleanupJob.deleteMany({ where: { workspaceSessionId: session.id } });
    await tx.workspaceSession.delete({ where: { id: session.id } });
  }
  if (input.chatExists) {
    const deleted = await tx.chat.deleteMany({
      where: { ...input.chatWhere, id: scope.chatId, userId: scope.userId }
    });
    if (deleted.count !== 1) throw new BackgroundWorkError("chat_deletion_aggregate_changed");
  }
  const [row] = await tx.$queryRaw<Array<{ residual: number }>>(Prisma.sql`
    SELECT (
      (SELECT COUNT(*) FROM "Chat" WHERE "userId" = ${scope.userId} AND "id" = ${scope.chatId})
      + (SELECT COUNT(*) FROM "Message" WHERE "chatId" = ${scope.chatId})
      + (SELECT COUNT(*) FROM "ModelRun" WHERE "userId" = ${scope.userId} AND "chatId" = ${scope.chatId})
      + (SELECT COUNT(*) FROM "Attachment" WHERE "userId" = ${scope.userId} AND "chatId" = ${scope.chatId})
      + (SELECT COUNT(*) FROM "SharedChatSnapshot" WHERE "ownerUserId" = ${scope.userId} AND "chatId" = ${scope.chatId})
    )::integer AS "residual"
  `);
  if (row?.residual !== 0) throw new BackgroundWorkError("chat_deletion_purge_incomplete");
}

/** Lost the item's lease inside the final transaction: roll everything back; the new holder finishes it. */
export function chatDeletionLeaseLost(): never {
  throw new BackgroundWorkError("chat_deletion_lease_lost");
}
