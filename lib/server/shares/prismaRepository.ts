import { Prisma } from "@prisma/client";
import {
  buildPublicShareSnapshot,
  projectPublicShareSnapshot
} from "../../domain/shareSnapshot";
import { prisma } from "../prisma";
import { resolveProjectAccess } from "../projects/access";
import type { ShareRepository } from "./handlers";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE
  `);
}

export function createPrismaShareRepository(prismaClient = prisma): ShareRepository {
  return {
    createChatShare: async ({ activeLeafMessageId, chatId, shareToken, slugHash, userId }) =>
      prismaClient.$transaction(async (tx) => {
        let chat = await tx.chat.findFirst({
          include: {
            messages: true,
            project: { select: { publicSharingEnabled: true, status: true } }
          },
          where: {
            archived: false,
            id: chatId,
            memoryMode: { not: "TEMPORARY" },
            permanentDeletionAt: null,
            OR: [{ userId }, { projectId: { not: null } }]
          }
        });

        if (!chat) {
          return null;
        }
        let projectCreator: { displayName: string } | null = null;
        if (chat.projectId) {
          await lockProject(tx, chat.projectId);
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "Chat" WHERE "id" = ${chat.id} FOR UPDATE
          `);
          const access = await resolveProjectAccess(tx, {
            minimumRole: "MANAGER",
            projectId: chat.projectId,
            requireActive: true,
            userId
          });
          if (!access) {
            return null;
          }
          const currentChat = await tx.chat.findFirst({
            include: {
              messages: true,
              project: { select: { publicSharingEnabled: true, status: true } }
            },
            where: {
              archived: false,
              id: chat.id,
              memoryMode: { not: "TEMPORARY" },
              permanentDeletionAt: null,
              projectId: chat.projectId
            }
          });
          if (
            !currentChat ||
            currentChat.project?.status !== "ACTIVE" ||
            !currentChat.project.publicSharingEnabled
          ) {
            return null;
          }
          chat = currentChat;
          projectCreator = await tx.user.findUnique({
            select: { displayName: true },
            where: { id: userId }
          });
          if (!projectCreator) return null;
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

        const snapshot = buildPublicShareSnapshot({
          activeLeafMessageId: leaf,
          messages: chat.messages.map((message) => ({
            content: message.content,
            id: message.id,
            parentMessageId: message.parentMessageId,
            role: message.role as "assistant" | "system" | "tool" | "user"
          })),
          title: chat.title
        });

        const share = await tx.sharedChatSnapshot.create({
          data: {
            chatId: chat.id,
            ...(chat.projectId
              ? {
                  createdByDisplayName: projectCreator?.displayName ?? "Project member",
                  ownerUserId: null,
                  projectId: chat.projectId
                }
              : { ownerUserId: userId, projectId: null }),
            slugHash,
            snapshot: json(snapshot),
            title: chat.title
          }
        });
        if (chat.projectId) {
          await tx.projectAuditEvent.create({
            data: {
              actorDisplayName: projectCreator?.displayName ?? "Project member",
              actorUserId: userId,
              eventType: "public_snapshot_created",
              metadata: { chatId: chat.id, shareId: share.id },
              projectId: chat.projectId
            }
          });
        }

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
        select: { projectId: true, userId: true },
        where: { id: chatId }
      });
      if (!chat) return [];
      if (chat.projectId) {
        const access = await resolveProjectAccess(prismaClient, {
          minimumRole: "MANAGER",
          projectId: chat.projectId,
          userId
        });
        if (!access) return [];
      } else if (chat.userId !== userId) {
        return [];
      }
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
          ...(chat.projectId ? { projectId: chat.projectId } : { ownerUserId: userId }),
          revokedAt: null
        }
      });

      return shares;
    },
    revokeShare: async ({ shareId, userId }) => prismaClient.$transaction(async (tx) => {
      const share = await tx.sharedChatSnapshot.findUnique({
        select: { ownerUserId: true, projectId: true },
        where: { id: shareId }
      });
      if (!share) return false;
      if (share.projectId) {
        await lockProject(tx, share.projectId);
        const access = await resolveProjectAccess(tx, {
          minimumRole: "MANAGER",
          projectId: share.projectId,
          userId
        });
        if (!access) return false;
      } else if (share.ownerUserId !== userId) {
        return false;
      }
      const result = await tx.sharedChatSnapshot.updateMany({
        data: {
          revokedAt: new Date()
        },
        where: {
          id: shareId,
          ...(share.projectId ? { projectId: share.projectId } : { ownerUserId: userId }),
          revokedAt: null
        }
      });
      if (result.count > 0 && share.projectId) {
        const actor = await tx.user.findUnique({
          select: { displayName: true },
          where: { id: userId }
        });
        await tx.projectAuditEvent.create({
          data: {
            actorDisplayName: actor?.displayName ?? "Project member",
            actorUserId: userId,
            eventType: "public_snapshot_revoked",
            metadata: { shareId },
            projectId: share.projectId
          }
        });
      }

      return result.count > 0;
    })
  };
}
