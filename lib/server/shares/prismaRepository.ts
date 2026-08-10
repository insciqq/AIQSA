import { Prisma } from "@prisma/client";
import {
  buildPublicShareSnapshot,
  GroundedContentNotShareableError,
  projectPublicShareSnapshot,
  type PublicShareSnapshot
} from "../../domain/shareSnapshot";
import { prisma } from "../prisma";
import type { ShareRepository } from "./handlers";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function createPrismaShareRepository(prismaClient = prisma): ShareRepository {
  return {
    createChatShare: async ({ activeLeafMessageId, chatId, shareToken, slugHash, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          include: {
            messages: true
          },
          where: {
            archived: false,
            id: chatId,
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

        let snapshot: PublicShareSnapshot;
        try {
          snapshot = buildPublicShareSnapshot({
            activeLeafMessageId: leaf,
            messages: chat.messages.map((message) => ({
              content: message.content,
              groundedAt: message.groundedAt,
              id: message.id,
              parentMessageId: message.parentMessageId,
              role: message.role as "assistant" | "system" | "tool" | "user"
            })),
            title: chat.title
          });
        } catch (error) {
          if (error instanceof GroundedContentNotShareableError) {
            return { error: "grounded_content_not_shareable" as const };
          }
          throw error;
        }

        const share = await tx.sharedChatSnapshot.create({
          data: {
            chatId: chat.id,
            ownerUserId: userId,
            slugHash,
            snapshot: json(snapshot),
            title: chat.title
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
          OR: [
            {
              expiresAt: null
            },
            {
              expiresAt: {
                gt: now
              }
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
      const shares = await prismaClient.sharedChatSnapshot.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          id: true
        },
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          chatId,
          ownerUserId: userId,
          revokedAt: null
        }
      });

      return shares;
    },
    revokeShare: async ({ shareId, userId }) => {
      const result = await prismaClient.sharedChatSnapshot.updateMany({
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
    }
  };
}
