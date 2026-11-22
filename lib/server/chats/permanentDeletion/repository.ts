import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { PERMANENT_CHAT_DELETION_DUTY } from "../../background/duties";
import { prisma } from "../../prisma";
import type { PermanentChatDeletionRepository } from "./service";

const activeRunStatuses = [
  "preparing",
  "queued",
  "streaming",
  "in_progress"
] as const;

type LockedChat = Readonly<{
  activeLeafMessageId: string | null;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  memorySourceRevision: number;
  permanentDeletionAt: Date | null;
}>;

async function lockChat(
  tx: Prisma.TransactionClient,
  chatId: string,
  userId: string
): Promise<LockedChat | null> {
  const rows = await tx.$queryRaw<LockedChat[]>(Prisma.sql`
    SELECT "activeLeafMessageId", "memoryMode"::text AS "memoryMode", "memorySourceRevision", "permanentDeletionAt"
    FROM "Chat"
    WHERE "id" = ${chatId} AND "userId" = ${userId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

export function createPrismaPermanentChatDeletionRepository(
  client: PrismaClient = prisma
): PermanentChatDeletionRepository {
  return Object.freeze({
    async readSnapshot({ chatId, userId }) {
      const chat = await client.chat.findFirst({
        select: {
          activeLeafMessageId: true,
          memoryMode: true,
          memorySourceRevision: true
        },
        where: {
          id: chatId,
          permanentDeletionAt: null,
          userId
        }
      });
      if (!chat) return null;
      // The main agent's answer holds deletion off; background sub-agents are stopped once the chat is fenced.
      const activeRunCount = await client.modelRun.count({
        where: {
          chatId,
          status: { in: [...activeRunStatuses] },
          subagentTurnId: null,
          userId
        }
      });
      return {
        activeLeafMessageId: chat.activeLeafMessageId,
        activeRunCount,
        memoryMode: chat.memoryMode,
        sourceRevision: chat.memorySourceRevision
      };
    },

    async admit(input) {
      return client.$transaction(async (tx) => {
        const chat = await lockChat(tx, input.chatId, input.userId);
        if (!chat || chat.permanentDeletionAt) return { kind: "not_found" as const };
        if (chat.memoryMode === "TEMPORARY") return { kind: "temporary" as const };
        if (
          chat.memorySourceRevision !== input.expectedChatRevision ||
          chat.activeLeafMessageId !== input.expectedActiveLeafMessageId
        ) {
          return { kind: "stale" as const };
        }
        // Under the chat lock, before any change: the caller's own condition.
        if (input.condition && !(await input.condition(tx))) return { kind: "stale" as const };

        // Under the chat lock: the main agent's answer refuses; background sub-agents are stopped after the fence
        // (`stopSubagents`), and the purge waits until no run of the chat is active.
        const activeRunCount = await tx.modelRun.count({
          where: {
            chatId: input.chatId,
            status: { in: [...activeRunStatuses] },
            subagentTurnId: null,
            userId: input.userId
          }
        });
        if (activeRunCount > 0) return { kind: "active_run" as const };

        // The fence is the durable obligation: immutable once set (SQL guard), it keeps the chat out of every
        // list, search, share and new child write, and the background worker purges every fenced chat.
        const deletionId = randomUUID();
        const fenced = await tx.chat.updateMany({
          data: {
            archived: true,
            permanentDeletionAt: input.now,
            permanentDeletionOperationId: deletionId
          },
          where: {
            id: input.chatId,
            permanentDeletionAt: null,
            permanentDeletionOperationId: null,
            userId: input.userId
          }
        });
        if (fenced.count !== 1) return { kind: "not_found" as const };
        await tx.sharedChatSnapshot.updateMany({
          data: { revokedAt: input.now },
          where: {
            chatId: input.chatId,
            ownerUserId: input.userId,
            revokedAt: null
          }
        });
        return { deletionId, kind: "ok" as const };
      });
    },

    async progress({ chatId, userId }) {
      const fenced = await client.chat.count({
        where: { id: chatId, permanentDeletionAt: { not: null }, userId }
      });
      if (fenced > 0) return "in_progress" as const;
      // The chat is gone: only its owner's completed work row says the deletion finished; anything else reads
      // as unknown, like a chat that never existed.
      const [row] = await client.$queryRaw<Array<{ completed: boolean }>>(Prisma.sql`
        SELECT TRUE AS "completed"
        FROM "BackgroundWorkItem"
        WHERE "duty" = ${PERMANENT_CHAT_DELETION_DUTY}
          AND "itemId" = ${chatId}
          AND "userId" = ${userId}
          AND "completedAt" IS NOT NULL
        LIMIT 1
      `);
      return row?.completed ? "complete" as const : null;
    }
  });
}
