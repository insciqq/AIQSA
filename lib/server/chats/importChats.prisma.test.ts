import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ChatExportDocument } from "../../contracts/chatExport";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memoryClient";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { prisma } from "../prisma";
import { createChatContinuationRepository } from "./continuationRepository";
import { importChatForUser } from "./importChats";
import { createPrismaChatRepository } from "./prismaRepository";

afterAll(() => prisma.$disconnect());

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function owner(): Promise<string> {
  const userId = randomUUID();
  await prisma.user.create({ data: { displayName: "Import fixture", id: userId, status: "active" } });
  cleanups.push(async () => {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });
  return userId;
}

/**
 * An edited first question (two roots) and an answer with a flattened
 * follow-up, whose final answer is dated before its follow-up turn, as
 * export v1 writes it.
 */
function document(title = "Imported fixture"): ChatExportDocument {
  return {
    format: "aiqsa.chat",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    chat: {
      activeLeafId: "m4",
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages: [
        { createdAt: "2026-09-01T10:00:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: "Synthetic question" },
        { createdAt: "2026-09-01T10:02:00.000Z", id: "m2", parentId: "m1", role: "assistant", status: "complete", text: "Partial answer before follow-up:\n\nDraft" },
        { createdAt: "2026-09-01T10:03:00.000Z", id: "m3", parentId: "m2", role: "user", status: "complete", text: "Follow-up 1:\n\nClarification" },
        { createdAt: "2026-09-01T10:01:00.000Z", id: "m4", parentId: "m3", role: "assistant", status: "cancelled", text: "Final answer" },
        { createdAt: "2026-09-01T11:00:00.000Z", id: "m5", parentId: null, role: "user", status: "complete", text: "Edited question" }
      ],
      pinned: true,
      title,
      updatedAt: "2026-09-02T10:00:00.000Z"
    }
  };
}

const textOf = (content: unknown) =>
  ((content as { blocks?: Array<{ text?: string }> }).blocks ?? []).map((block) => block.text ?? "").join("\n");

async function importedChat(userId: string) {
  return prisma.chat.findFirstOrThrow({ include: { messages: true }, where: { importSourceKey: { not: null }, userId } });
}

describe("chat import against PostgreSQL", () => {
  it("creates the whole tree in one transaction: Excluded, source dates, no model, runs or usage", async () => {
    const userId = await owner();
    expect(await importChatForUser(prisma, userId, { document: document(), source: "AIQSA", sourceModel: "fixture-model" }))
      .toEqual({ messages: 5, status: "imported" });
    const chat = await importedChat(userId);
    expect(chat).toMatchObject({
      archived: false, defaultProviderModelId: null, folderId: null, importSource: "AIQSA", importSourceModel: "fixture-model",
      memoryMode: "EXCLUDED", pinned: true, projectId: null, title: "Imported fixture"
    });
    expect(chat.importSourceKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(chat.createdAt.toISOString()).toBe("2026-09-01T09:59:00.000Z");
    expect(chat.updatedAt.toISOString()).toBe("2026-09-02T10:00:00.000Z");
    const byText = new Map(chat.messages.map((message) => [textOf(message.content), message]));
    expect(chat.activeLeafMessageId).toBe(byText.get("Final answer")?.id);
    expect(byText.get("Final answer")?.parentMessageId).toBe(byText.get("Follow-up 1:\n\nClarification")?.id);
    expect(byText.get("Final answer")?.createdAt.toISOString()).toBe("2026-09-01T10:01:00.000Z");
    expect(byText.get("Edited question")?.parentMessageId).toBeNull();
    expect(chat.messages.every((message) => message.status === "complete" && message.provider === null &&
      message.modelId === null && message.inputTokens === null && message.outputTokens === null &&
      message.reasoningTokens === null && message.authorUserId === null)).toBe(true);
    expect(await prisma.modelRun.count({ where: { chatId: chat.id } })).toBe(0);
    expect(await prisma.usageEvent.count({ where: { userId } })).toBe(0);
    expect(chat).toMatchObject({ totalInputTokens: 0, totalOutputTokens: 0 });
  });

  it("reports a re-import as already imported, also when duplicate imports race", async () => {
    const userId = await owner();
    await importChatForUser(prisma, userId, { document: document(), source: "AIQSA" });
    expect(await importChatForUser(prisma, userId, { document: { ...document("Renamed"), exportedAt: "2026-10-04T00:00:00.000Z" }, source: "AIQSA" }))
      .toEqual({ status: "already_imported" });
    const raced = await Promise.all([1, 2, 3, 4].map(() =>
      importChatForUser(prisma, userId, { document: document("Raced"), source: "CHATGPT", sourceKey: "conversation-raced" })));
    expect(raced.filter((result) => result.status === "imported")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "already_imported")).toHaveLength(3);
    expect(await prisma.chat.count({ where: { userId } })).toBe(2);
    // Another owner imports the same conversation independently.
    const other = await owner();
    expect(await importChatForUser(prisma, other, { document: document(), source: "AIQSA" })).toMatchObject({ status: "imported" });
  });

  it("frees the key when the chat is deleted or enters permanent deletion", async () => {
    const userId = await owner();
    const item = { document: document(), source: "AIQSA" as const };
    await importChatForUser(prisma, userId, item);
    const first = await importedChat(userId);
    const deletionId = randomUUID();
    // The permanent-deletion fence: an exact durable operation, then the chat leaves the live key space.
    await prisma.$transaction(async (tx) => {
      await tx.memoryDeletionOutbox.create({ data: {
        admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: first.memorySourceRevision,
        alsoForgetOriginMemories: false, id: deletionId, memoryGeneration: 0, operation: "SOURCE_PURGE",
        targetId: first.id, targetType: "CHAT@memory-chat-delete-v1", userId
      } });
      await tx.chat.update({ data: { archived: true, permanentDeletionAt: new Date(), permanentDeletionOperationId: deletionId }, where: { id: first.id } });
    });
    expect(await importChatForUser(prisma, userId, item)).toMatchObject({ status: "imported" });
    const second = await prisma.chat.findFirstOrThrow({ where: { permanentDeletionAt: null, userId } });
    await prisma.chat.delete({ where: { id: second.id } });
    expect(await importChatForUser(prisma, userId, item)).toMatchObject({ status: "imported" });
  });

  it("stores an empty or blank source title as the default chat title", async () => {
    const userId = await owner();
    await importChatForUser(prisma, userId, { document: document(""), source: "CHATGPT", sourceKey: "untitled-1" });
    await importChatForUser(prisma, userId, { document: document(" ".repeat(300)), source: "CHATGPT", sourceKey: "untitled-2" });
    const titles = (await prisma.chat.findMany({ select: { title: true }, where: { userId } })).map((chat) => chat.title);
    expect(titles).toEqual(["New Chat", "New Chat"]);
  });

  it("rolls a failing import back completely", async () => {
    const userId = await owner();
    await expect(importChatForUser(prisma, userId, { document: document("Broken\u0000title"), source: "AIQSA" })).rejects.toThrow();
    expect(await prisma.chat.count({ where: { userId } })).toBe(0);
    expect(await importChatForUser(prisma, userId, { document: document(), source: "AIQSA" })).toMatchObject({ status: "imported" });
  });

  it("keeps the chat, its continuation and its branch copy out of Memory, against every writer", async () => {
    const userId = await owner();
    await importChatForUser(prisma, userId, { document: document(), source: "CLAUDE", sourceKey: "conversation-memory", sourceModel: "Claude" });
    const chat = await importedChat(userId);
    const chats = createPrismaChatRepository(prisma);
    const resume = (chatId: string) => chats.setMemoryMode({
      chatId, mode: "NORMAL", resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, userId
    });
    expect(await resume(chat.id)).toEqual({ kind: "imported" });
    expect(await chats.getChatMemoryState({ chatId: chat.id, userId })).toMatchObject({ importSource: "CLAUDE", mode: "EXCLUDED" });
    await expect(prisma.chat.update({ data: { memoryMode: "NORMAL" }, where: { id: chat.id } })).rejects.toThrow();

    const continuation = createChatContinuationRepository(prisma);
    const input = { chatId: chat.id, expectedLeafMessageId: chat.activeLeafMessageId!, requestId: randomUUID(), userId };
    const source = await continuation.loadSource(input);
    const claimed = await continuation.claim(source, input.requestId);
    if (claimed.kind !== "claimed") throw new Error("claim missing");
    const completed = await continuation.complete(source, claimed.claim, "Conversation summary");
    if (completed.status !== "complete") throw new Error("continuation missing");
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: completed.chatId } })).toMatchObject({
      importSource: "CLAUDE", importSourceKey: null, importSourceModel: "Claude", memoryMode: "EXCLUDED"
    });
    expect(await resume(completed.chatId)).toEqual({ kind: "imported" });

    const branch = await createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({
      sourceMessageId: chat.activeLeafMessageId!, userId
    });
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: branch!.id } })).toMatchObject({
      importSource: "CLAUDE", importSourceKey: null, memoryMode: "EXCLUDED"
    });
    expect(await resume(branch!.id)).toEqual({ kind: "imported" });
    expect(await prisma.usageEvent.count({ where: { userId } })).toBe(0);
  });
});
