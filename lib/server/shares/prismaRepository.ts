import { Prisma } from "@prisma/client";
import { messageFollowupSelect } from "../runs/prismaRepositoryFollowups";
import { omitSubagentCallbackTurns } from "../../domain/subagentCallbackTurns";
import { projectMessageFollowups } from "../runs/runFollowups";
import {
  buildPublicShareSnapshot,
  projectPublicShareSnapshot
} from "../../domain/shareSnapshot";
import { prisma } from "../prisma";
import { collapseChatAnswerReviews } from "../chats/legacyAnswerReviews";
import { quietCheckOmission } from "../chats/quietScheduledChecks";
import { getVisibleMessagePath, type MessageRole } from "../../domain/branching";
import { redactOutgoing } from "../discord/redaction";
import type { ShareRepository } from "./handlers";
import type { PublicShareSnapshot } from "../../domain/shareSnapshot";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * A Discord chat's snapshot with every recognized secret replaced (PRD D-21,
 * D-22): its text came from Discord threads and an agent reading cluster
 * state, and its link is posted to Discord. Other chats' shares keep their text.
 */
export function redactDiscordShareSnapshot(snapshot: PublicShareSnapshot): PublicShareSnapshot {
  return {
    messages: snapshot.messages.map((message) => ({
      content: { blocks: message.content.blocks.map((block) => ({ text: redactOutgoing(block.text).text, type: block.type })) },
      role: message.role
    })),
    title: redactOutgoing(snapshot.title).text,
    version: snapshot.version
  };
}

export function createPrismaShareRepository(prismaClient = prisma): ShareRepository {
  return {
    createChatShare: async ({ activeLeafMessageId, chatId, shareToken, slugHash, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          include: { messages: true },
          where: {
            archived: false,
            id: chatId,
            memoryMode: { not: "TEMPORARY" },
            permanentDeletionAt: null,
            userId
          }
        });

        if (!chat) {
          return null;
        }

        const leaf = activeLeafMessageId ?? chat.activeLeafMessageId;
        if (!leaf) {
          return null;
        }

        if (!chat.messages.some((message) => message.id === leaf)) {
          return {
            error: "invalid_active_leaf" as const
          };
        }

        const history = await tx.message.findMany({ where: { chatId: chat.id, role: "assistant" },
          select: { id: true, ...messageFollowupSelect } });
        const followups = new Map(history.map(message => [message.id, projectMessageFollowups(message)]));
        // Only the shared leaf's own path is read: a review that went on past
        // it (a later version) stays out. On that path each answer review
        // recorded before the feature's removal reads as its answer: the
        // latest version stands in the source answer's place; the review
        // turns stay out of the snapshot.
        const path = getVisibleMessagePath(chat.messages.map((message) => ({ ...message, role: message.role as MessageRole })), leaf);
        const collapse = await collapseChatAnswerReviews(tx, chat.id, path.map((message) => ({
          answerReviewSessionId: message.answerReviewSessionId, id: message.id, parentId: message.parentMessageId,
          role: message.role, status: message.status, systemTurnKind: message.systemTurnKind
        })));
        const collapsed = path.filter((message) => !collapse.removed.has(message.id)).map((message) => ({ ...message,
          parentMessageId: collapse.parents.has(message.id) ? collapse.parents.get(message.id) ?? null : message.parentMessageId }));
        // A quiet check is no result: the share leaves it out as the chat's history does (`lib/server/chats/quietScheduledChecks.ts`).
        const quiet = await quietCheckOmission(tx, chat.id, collapsed);
        const kept = collapsed.filter((message) => !quiet.removed.has(message.id)).map((message) => ({ ...message,
          parentMessageId: quiet.parents.has(message.id) ? quiet.parents.get(message.id) ?? null : message.parentMessageId }));
        // A sub-agent wake-up turn is the server's, never the user's speech: the share leaves it out.
        const wakeUps = omitSubagentCallbackTurns(kept.map((message) => ({ id: message.id, parentId: message.parentMessageId,
          role: message.role, systemTurnKind: message.systemTurnKind })));
        const shownLeaf = quiet.resolve(collapse.replacements.get(leaf) ?? leaf);
        if (!shownLeaf) return { error: "invalid_active_leaf" as const };
        const built = buildPublicShareSnapshot({
          activeLeafMessageId: wakeUps.resolve(shownLeaf) ?? shownLeaf,
          messages: kept.filter((message) => !wakeUps.removed.has(message.id)).map((message) => ({
            content: message.content,
            id: message.id,
            parentMessageId: wakeUps.parents.has(message.id) ? wakeUps.parents.get(message.id) ?? null : message.parentMessageId,
            role: message.role as "assistant" | "system" | "tool" | "user",
            ...(followups.get(message.id) ? { followups: followups.get(message.id)! } : {})
          })),
          title: chat.title
        });
        // A chat bound to a Discord conversation is shared with its secrets redacted, its title too.
        const discord = await tx.discordConversation.findUnique({ select: { id: true }, where: { chatId: chat.id } });
        const snapshot = discord ? redactDiscordShareSnapshot(built) : built;

        const share = await tx.sharedChatSnapshot.create({
          data: {
            chatId: chat.id,
            ownerUserId: userId,
            slugHash,
            snapshot: json(snapshot),
            title: snapshot.title
          }
        });

        return {
          createdAt: share.createdAt,
          id: share.id,
          shareToken,
          snapshot,
          title: share.title
        };
      }),
    findPublicShare: async (slugHash, now) => {
      const share = await prismaClient.sharedChatSnapshot.findFirst({
        where: {
          AND: [
            {
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: now } }
              ]
            },
            {
              OR: [
                { chatId: null },
                {
                  chat: {
                    memoryMode: { not: "TEMPORARY" },
                    permanentDeletionAt: null
                  }
                }
              ]
            }
          ],
          revokedAt: null,
          slugHash
        }
      });

      if (!share) {
        return null;
      }
      const snapshot = projectPublicShareSnapshot(share.snapshot);
      if (!snapshot) return null;

      return {
        createdAt: share.createdAt,
        id: share.id,
        snapshot,
        title: share.title
      };
    },
    listChatShares: async ({ chatId, now, userId }) => {
      const chat = await prismaClient.chat.findUnique({
        select: { userId: true },
        where: { id: chatId }
      });
      if (!chat || chat.userId !== userId) return [];
      const shares = await prismaClient.sharedChatSnapshot.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          id: true
        },
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          chat: {
            memoryMode: { not: "TEMPORARY" },
            permanentDeletionAt: null
          },
          chatId,
          ownerUserId: userId,
          revokedAt: null
        }
      });

      return shares;
    },
    revokeShare: async ({ shareId, userId }) => prismaClient.$transaction(async (tx) => {
      const share = await tx.sharedChatSnapshot.findUnique({
        select: { ownerUserId: true },
        where: { id: shareId }
      });
      if (!share || share.ownerUserId !== userId) return false;
      const result = await tx.sharedChatSnapshot.updateMany({
        data: {
          revokedAt: new Date()
        },
        where: {
          id: shareId,
          ownerUserId: userId,
          revokedAt: null
        }
      });

      return result.count > 0;
    })
  };
}
