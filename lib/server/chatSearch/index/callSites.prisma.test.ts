// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../../contracts/memoryClient";
import { createPrismaChatRepository } from "../../chats/prismaRepository";
import { TEMPORARY_CHAT_RETENTION_MS } from "../../chats/temporaryRetention";
import { createPrismaMessageBranchRepository } from "../../messages/prismaRepository";
import { prisma } from "../../prisma";
import { settleTerminalChatSource } from "../../runs/prismaRepositoryPreparation";
import { createWorkspaceSecretStore } from "../../workspace/secrets/store";
import type { ChatSearchEmbedder } from "../embedder";
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
    await prisma.chatMemoryCheckpoint.deleteMany({ where: { userId: id } });
    await prisma.memoryScope.deleteMany({ where: { userId: id } });
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
});
