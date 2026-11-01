// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaChatFileReader } from "./readChatFile";

describe("chat file read authority in PostgreSQL", () => {
  afterAll(() => prisma.$disconnect());
  it("refuses another user, another chat, detached and deleted files exactly like a missing file", async () => {
    const users: string[] = [];
    const chats: string[] = [];
    const attachments: string[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const user = await prisma.user.create({ data: { id: randomUUID(), displayName: "Chat file fixture", status: "active" } });
        users.push(user.id);
        const chat = await prisma.chat.create({ data: { userId: user.id, title: "File fixture", memoryMode: "EXCLUDED" } });
        chats.push(chat.id);
      }
      const otherChat = await prisma.chat.create({ data: { userId: users[0]!, title: "Other file fixture", memoryMode: "EXCLUDED" } });
      chats.push(otherChat.id);
      const attachment = await prisma.attachment.create({ data: { userId: users[0]!, chatId: chats[0]!, kind: "document",
        fileName: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 1, storageKey: `test-chat-file-${randomUUID()}`, metadata: {}, extractedText: "Section 3: Synthetic evidence.", status: "ready" } });
      attachments.push(attachment.id);
      const reader = createPrismaChatFileReader(prisma);
      const scope = { attachmentId: attachment.id, chatId: chats[0]!, userId: users[0]! };
      expect(await reader.read(scope)).toMatchObject({ extractedText: "Section 3: Synthetic evidence." });
      const missing = await reader.read({ ...scope, attachmentId: randomUUID() });
      expect(missing).toBeNull();
      expect(await reader.read({ ...scope, userId: users[1]! })).toEqual(missing);
      expect(await reader.read({ ...scope, userId: users[1]!, chatId: chats[1]! })).toEqual(missing);
      expect(await reader.read({ ...scope, chatId: otherChat.id })).toEqual(missing);
      await prisma.attachment.update({ where: { id: attachment.id }, data: { chatId: null, savedAt: new Date() } });
      expect(await reader.read(scope)).toEqual(missing);
      await prisma.attachment.update({ where: { id: attachment.id }, data: { chatId: chats[0]!, savedAt: null } });
      await prisma.chat.update({ where: { id: chats[0]! }, data: { permanentDeletionAt: new Date() } });
      expect(await reader.read(scope)).toEqual(missing);
    } finally {
      await prisma.attachment.deleteMany({ where: { id: { in: attachments } } });
      await prisma.chat.deleteMany({ where: { id: { in: chats } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  });
});
