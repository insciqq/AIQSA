// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import {
  MEMORY_TEMPORARY_DELETION_GENERATION,
  MEMORY_TEMPORARY_DELETION_TARGET_TYPE
} from "../memory/temporaryRetention";
import { prisma } from "../prisma";
import { createPrismaAttachmentLibraryRepository } from "./libraryRepository";

async function createAttachment(input: Readonly<{
  chatId: string;
  fileName: string;
  messageId: string;
  userId: string;
}>) {
  return prisma.attachment.create({
    data: {
      byteSize: 12,
      chatId: input.chatId,
      fileName: input.fileName,
      kind: "document",
      messageId: input.messageId,
      metadata: {},
      mimeType: "text/plain",
      status: "ready",
      storageKey: `file-library-test/${randomUUID()}`,
      userId: input.userId
    }
  });
}

describe("Prisma attachment Library repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("pages saved files before recent chat attachments without dropping a date tie", async () => {
    const userId = `file-library-test-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, displayName: "Library pagination" } });
    try {
      const chat = await prisma.chat.create({ data: { title: "Recent files", userId } });
      const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: {} } });
      await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id } });
      const recent = await createAttachment({ chatId: chat.id, messageId: message.id, fileName: "recent.txt", userId });
      const saved = await Promise.all([1, 2].map((value) => prisma.attachment.create({ data: {
        byteSize: 4, fileName: `saved-${value}.txt`, kind: "document", metadata: {}, mimeType: "text/plain",
        savedAt: new Date("2020-01-01T00:00:00Z"), status: "ready", storageKey: `file-library-test/${randomUUID()}`, userId
      } })));
      const repository = createPrismaAttachmentLibraryRepository(prisma);
      const expected = [...saved.map((file) => file.id).sort().reverse(), recent.id];
      let cursor: string | null = null;
      const actual: string[] = [];
      for (let page = 0; page < 4; page += 1) {
        const files = await repository.listSent({ cursor, limit: 1, userId });
        if (!files.length) break;
        cursor = files[0]!.id;
        actual.push(cursor);
      }
      expect(actual).toEqual(expected);
      expect(await repository.listSent({ cursor: recent.id, limit: 1, userId: "other-owner" })).toEqual([]);
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it("lists only sources on active paths of durable personal chats", async () => {
    const userId = `file-library-test-${randomUUID()}`;
    await prisma.user.create({
      data: {
        displayName: "File Library Test User",
        id: userId
      }
    });

    try {
      const durableChat = await prisma.chat.create({
        data: { title: "Durable chat", userId }
      });
      const root = await prisma.message.create({
        data: {
          chatId: durableChat.id,
          content: { blocks: [{ text: "Question", type: "text" }] },
          role: "user"
        }
      });
      const commonAnswer = await prisma.message.create({
        data: {
          chatId: durableChat.id,
          content: { blocks: [{ text: "Answer", type: "text" }] },
          parentMessageId: root.id,
          role: "assistant"
        }
      });
      const inactiveMessage = await prisma.message.create({
        data: {
          chatId: durableChat.id,
          content: { blocks: [{ text: "Old version", type: "text" }] },
          parentMessageId: commonAnswer.id,
          role: "user"
        }
      });
      const activeMessage = await prisma.message.create({
        data: {
          chatId: durableChat.id,
          content: { blocks: [{ text: "Edited version", type: "text" }] },
          parentMessageId: commonAnswer.id,
          role: "user"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: activeMessage.id },
        where: { id: durableChat.id }
      });

      const temporaryChat = await prisma.$transaction(async (tx) => {
        const deadline = new Date(Date.now() + 60 * 60 * 1000);
        const chat = await tx.chat.create({
          data: {
            memoryMode: "TEMPORARY",
            temporaryRetentionDeadline: deadline,
            temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
            title: "Temporary chat",
            userId
          }
        });
        await tx.memoryDeletionOutbox.create({
          data: {
            memoryGeneration: MEMORY_TEMPORARY_DELETION_GENERATION,
            nextAttemptAt: deadline,
            operation: "TEMPORARY_DELETE",
            targetId: chat.id,
            targetType: MEMORY_TEMPORARY_DELETION_TARGET_TYPE,
            userId
          }
        });
        return chat;
      });
      const temporaryMessage = await prisma.message.create({
        data: {
          chatId: temporaryChat.id,
          content: { blocks: [{ text: "Temporary question", type: "text" }] },
          role: "user"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: temporaryMessage.id },
        where: { id: temporaryChat.id }
      });

      await Promise.all([
        createAttachment({
          chatId: durableChat.id,
          fileName: "active.txt",
          messageId: activeMessage.id,
          userId
        }),
        createAttachment({
          chatId: durableChat.id,
          fileName: "inactive-branch.txt",
          messageId: inactiveMessage.id,
          userId
        }),
        createAttachment({
          chatId: temporaryChat.id,
          fileName: "temporary.txt",
          messageId: temporaryMessage.id,
          userId
        })
      ]);

      await expect(
        createPrismaAttachmentLibraryRepository(prisma).listSent({ limit: 200, userId })
      ).resolves.toEqual([
        expect.objectContaining({
          chatId: durableChat.id,
          fileName: "active.txt",
          messageId: activeMessage.id
        })
      ]);
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.memoryDeletionOutbox.updateMany({
          data: {
            leaseExpiresAt: new Date(Date.now() + 60_000),
            leaseToken: "file-library-test-cleanup",
            nextAttemptAt: null,
            state: "RUNNING"
          },
          where: { operation: "TEMPORARY_DELETE", userId }
        });
        await tx.chat.deleteMany({ where: { userId } });
        await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
        await tx.user.deleteMany({ where: { id: userId } });
      });
    }
  });
});
