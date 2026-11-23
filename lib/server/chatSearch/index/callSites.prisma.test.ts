// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MEMORY_RESUME_DISCLOSURE_COPY_VERSION, MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../../contracts/memoryClient";
import { createPrismaChatRepository } from "../../chats/prismaRepository";
import { TEMPORARY_CHAT_RETENTION_MS } from "../../chats/temporaryRetention";
import { createPrismaMessageBranchRepository } from "../../messages/prismaRepository";
import { prisma } from "../../prisma";
import { settleTerminalChatSource } from "../../runs/prismaRepositoryPreparation";
import { createWorkspaceSecretStore } from "../../workspace/secrets/store";
import type { ChatSearchEmbedder } from "../embedder";
import { createPastChatReader, createPrismaPastChatReadStore } from "../search/read";
import { markChatSearchDirty } from "./dirty";
import { runChatSearchIndexPass } from "./pass";

/**
 * The writers that feed past-chat search, against PostgreSQL (the integrator runs these on a disposable database):
 * each marks or clears the index in its own transaction, and none is held back any more by the old Memory history
 * a chat may still hold (`prisma/migrations/20261122135500_retire_memory_source_guards/migration.sql`).
 */

const owners: string[] = [];
const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });
const wordsOnly: ChatSearchEmbedder = {
  currentModel: async () => ({ kind: "unset" }),
  embed: async () => { throw new Error("no embedding model in this test"); }
};

afterEach(async () => {
  for (const id of owners.splice(0)) {
    // A Temporary chat goes once its deadline has passed.
    await prisma.chat.updateMany({
      data: { temporaryRetentionDeadline: new Date(Date.now() - 60_000) },
      where: { memoryMode: "TEMPORARY", userId: id }
    });
    await prisma.chat.deleteMany({ where: { userId: id } });
    await prisma.folder.deleteMany({ where: { userId: id } });
    await prisma.workspaceSecret.deleteMany({ where: { userId: id } });
    await prisma.workspaceSecretValue.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
afterAll(() => prisma.$disconnect());

async function owner(): Promise<string> {
  const id = `chat-search-call-sites-${randomUUID()}`;
  owners.push(id);
  await prisma.user.create({ data: { displayName: "Chat search call sites", id, status: "active" } });
  return id;
}

async function chatWithTurn(userId: string, data: Record<string, unknown> = {}) {
  const chat = await prisma.chat.create({ data: { title: "Lisbon trip", userId, ...data } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: text("Where should we stay?"),
    createdAt: new Date(Date.now() - 120_000), role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: text("Alfama, near the river."),
    createdAt: new Date(Date.now() - 60_000), parentMessageId: question.id, role: "assistant", status: "complete" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  return { answer, chat, question };
}

const state = (chatId: string) =>
  prisma.chatSearchState.findUnique({ select: { dirtyAt: true }, where: { chatId } });

describe("past-chat search call sites", () => {
  it("a settled answer marks its chat in the settling transaction, and the next pass makes its words searchable", async () => {
    const userId = await owner();
    const { answer, chat } = await chatWithTurn(userId);

    await prisma.$transaction((tx) => settleTerminalChatSource(tx, {
      assistantMessageId: answer.id, chatId: chat.id, runId: randomUUID(), status: "complete", userId
    }));
    expect((await state(chat.id))?.dirtyAt).toBeInstanceOf(Date);

    const summary = await runChatSearchIndexPass({ db: prisma, embedder: wordsOnly, limits: { ownerIds: [userId] } });
    expect(summary).toMatchObject({ indexed: 1 });
    await expect(prisma.chatSearchPassage.count({ where: { chatId: chat.id } })).resolves.toBeGreaterThan(0);
    await expect(state(chat.id)).resolves.toEqual({ dirtyAt: null });
  });

  it("a Temporary answer moves its chat's deadline a day on and creates no index state", async () => {
    const userId = await owner();
    const createdAt = new Date(Date.now() - 3_600_000);
    const { answer, chat } = await chatWithTurn(userId, {
      createdAt, memoryMode: "TEMPORARY", temporaryRetentionDeadline: new Date(createdAt.getTime() + 60_000),
      temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
    });
    const before = Date.now();

    await prisma.$transaction((tx) => settleTerminalChatSource(tx, {
      assistantMessageId: answer.id, chatId: chat.id, runId: randomUUID(), status: "complete", userId
    }));

    const { temporaryRetentionDeadline } = await prisma.chat.findUniqueOrThrow({
      select: { temporaryRetentionDeadline: true }, where: { id: chat.id }
    });
    expect(temporaryRetentionDeadline!.getTime()).toBeGreaterThanOrEqual(before + TEMPORARY_CHAT_RETENTION_MS - 1_000);
    await expect(state(chat.id)).resolves.toBeNull();
  });

  it("a newly saved secret marks every indexed chat of its owner, so passages are rebuilt redacted", async () => {
    const userId = await owner();
    const { chat } = await chatWithTurn(userId);
    await prisma.$executeRaw`
      INSERT INTO "ChatSearchState" ("chatId", "userId", "updatedAt") VALUES (${chat.id}, ${userId}, CURRENT_TIMESTAMP)`;

    await createWorkspaceSecretStore(prisma, { key: () => Buffer.alloc(32, 9) }).mutate(userId, {
      action: "create", description: "", name: "Deploy token", value: { kind: "text", text: "tok_live_8hQ2mZp4Lw9x" }
    });

    expect((await state(chat.id))?.dirtyAt).toBeInstanceOf(Date);
  });

  it("a branch copy keeps out what the old Memory kept out, reads skip it, and Resume brings the whole chat back", async () => {
    const userId = await owner();
    const { answer, chat, question } = await chatWithTurn(userId);
    const later = await prisma.message.create({ data: { chatId: chat.id, content: text("And the train?"),
      createdAt: new Date(Date.now() - 30_000), parentMessageId: answer.id, role: "user", status: "complete" } });
    const laterAnswer = await prisma.message.create({ data: { chatId: chat.id, content: text("The 9:10 to Sintra."),
      createdAt: new Date(Date.now() - 20_000), parentMessageId: later.id, role: "assistant", status: "complete" } });
    await prisma.chat.update({ data: { activeLeafMessageId: laterAnswer.id }, where: { id: chat.id } });
    // The first question was written before the chat's old Resume.
    await prisma.$executeRaw`
      INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId") VALUES (${chat.id}, ${question.id}, ${userId})`;
    const excludedIn = (chatId: string) => prisma.$queryRaw<Array<{ messageId: string }>>`
      SELECT "messageId" FROM "ChatSearchExcludedMessage" WHERE "chatId" = ${chatId}`;
    const drain = async () => {
      for (let pass = 0; pass < 10; pass += 1) {
        if (!(await runChatSearchIndexPass({ db: prisma, embedder: wordsOnly, limits: { ownerIds: [userId] } })).more) return;
      }
    };
    const questionsIn = async (chatId: string) => (await prisma.chatSearchPassage.findMany({ orderBy: { turnAt: "asc" },
      select: { userMessageId: true }, where: { chatId } })).map((row) => row.userMessageId);
    const reader = createPastChatReader({ savedSecretValues: async () => [], store: createPrismaPastChatReadStore(prisma) });
    const readTexts = async (chatId: string) => {
      const outcome = await reader.read({ input: { chat_id: chatId }, ownerId: userId, timeZone: "UTC" });
      return outcome.kind === "read" ? outcome.result.messages.map((message) => message.text) : outcome.kind;
    };
    /** The title a direct read names the chat by, and the first line of each of its passages. */
    const named = async (chatId: string) => {
      const outcome = await reader.read({ input: { chat_id: chatId }, ownerId: userId, timeZone: "UTC" });
      const rows = await prisma.chatSearchPassage.findMany({ orderBy: { turnAt: "asc" }, select: { text: true }, where: { chatId } });
      return { headers: rows.map((row) => row.text.split("\n")[0]), read: outcome.kind === "read" ? outcome.result.chatTitle : outcome.kind };
    };

    const copy = await createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({
      sourceMessageId: laterAnswer.id, userId
    });
    const copiedQuestion = await prisma.message.findFirstOrThrow({ where: { chatId: copy!.id, parentMessageId: null } });
    expect(await excludedIn(copy!.id)).toEqual([{ messageId: copiedQuestion.id }]);
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId: chat.id, userId }));
    await drain();
    for (const chatId of [chat.id, copy!.id]) {
      expect(await questionsIn(chatId)).toHaveLength(1);
      expect(await readTexts(chatId)).toEqual(["And the train?", "The 9:10 to Sintra."]);
      // A chat holding a withheld message is untitled in search, and so is the copy that carries its rows.
      expect(await named(chatId)).toEqual({ headers: ["Chat:"], read: "Untitled chat" });
    }

    // A Resume under the retired disclosure changes nothing; the current one makes the whole chat searchable.
    const chats = createPrismaChatRepository(prisma);
    await expect(chats.setMemoryMode({ chatId: chat.id, mode: "EXCLUDED", userId })).resolves.toEqual({ kind: "ok" });
    await expect(chats.setMemoryMode({ chatId: chat.id, mode: "NORMAL", resumeDisclosureCopyVersion: "memory-confirmation-v1",
      userId })).resolves.toEqual({ kind: "reload_required" });
    await expect(prisma.chat.findUniqueOrThrow({ select: { memoryMode: true }, where: { id: chat.id } }))
      .resolves.toEqual({ memoryMode: "EXCLUDED" });
    expect(await excludedIn(chat.id)).toHaveLength(1);
    await expect(chats.setMemoryMode({ chatId: chat.id, mode: "NORMAL",
      resumeDisclosureCopyVersion: MEMORY_RESUME_DISCLOSURE_COPY_VERSION, userId })).resolves.toEqual({ kind: "ok" });
    expect(await excludedIn(chat.id)).toEqual([]);
    await drain();
    expect(await questionsIn(chat.id)).toEqual([question.id, later.id]);
    expect(await readTexts(chat.id)).toEqual(["Where should we stay?", "Alfama, near the river.", "And the train?",
      "The 9:10 to Sintra."]);
    // Resume cleared the rows, so the title returns in every passage and the read.
    expect(await named(chat.id)).toEqual({ headers: ["Chat: Lisbon trip", "Chat: Lisbon trip"], read: "Lisbon trip" });
    // The copy is a chat of its own: its rows stay until it is resumed itself.
    expect(await excludedIn(copy!.id)).toHaveLength(1);
    expect(await named(copy!.id)).toEqual({ headers: ["Chat:"], read: "Untitled chat" });
  });
});
