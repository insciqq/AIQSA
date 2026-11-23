// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { titleFromMessageContent } from "../../chats/titlePolicy";
import { prisma } from "../../prisma";
import { SAVED_SECRET_MARKER } from "../../redaction/savedSecrets";
import type { ChatSearchEmbedder, ChatSearchEmbeddingModel } from "../embedder";
import { createPastChatReader, createPrismaPastChatReadStore } from "../search/read";
import { createPastChatSearch } from "../search/retrieval";
import { createPrismaPastChatSearchStore } from "../search/store";
import { recordChatSearchUsage } from "../usage";
import { runChatSearchBackfillPass } from "./backfill";
import { clearChatSearch, markChatSearchDirty, markOwnerChatsSearchDirty, scheduleChatSearchReembedding } from "./dirty";
import { chatSearchContentHash } from "./passages";
import { runChatSearchIndexPass, runChatSearchIndexPassOn } from "./pass";
import { createPrismaChatSearchIndexStore } from "./prismaStore";

/**
 * The indexer against PostgreSQL (the integrator runs these on a disposable database). Every pass is restricted to
 * this file's owners, so other fixtures in the database are never claimed. A fake embedder stands in for the provider.
 */

const owners: string[] = [];
const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });

afterEach(async () => {
  for (const id of owners.splice(0)) {
    await prisma.chat.deleteMany({ where: { userId: id } });
    await prisma.usageEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
afterAll(() => prisma.$disconnect());

async function owner(): Promise<string> {
  const id = `chat-search-index-${randomUUID()}`;
  owners.push(id);
  await prisma.user.create({ data: { displayName: "Chat search index fixture", id, status: "active" } });
  return id;
}

/** An ordinary chat with `turns` on its active branch; returns its message ids in order. */
async function chat(userId: string, turns: ReadonlyArray<readonly [string, string]>, data: Partial<Prisma.ChatUncheckedCreateInput> = {}) {
  const created = await prisma.chat.create({ data: { title: "Synthetic trip", userId, ...data } });
  let parentMessageId: string | null = null;
  const ids: string[] = [];
  // Distinct times, so turns order by their user message's time.
  const at = (offset: number) => new Date(Date.UTC(2026, 10, 1, 12) + (ids.length + offset) * 60_000);
  for (const [question, answer] of turns) {
    const asked: { id: string } = await prisma.message.create({ data: { chatId: created.id, content: text(question), createdAt: at(0),
      parentMessageId, role: "user", status: "complete" } });
    const answered: { id: string } = await prisma.message.create({ data: { chatId: created.id, content: text(answer),
      createdAt: at(1), parentMessageId: asked.id, role: "assistant", status: "complete" } });
    ids.push(asked.id, answered.id);
    parentMessageId = answered.id;
  }
  await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: created.id } });
  return { chatId: created.id, ids };
}

function fakeEmbedder(model: ChatSearchEmbeddingModel = { kind: "model", providerModelId: "fake-embed-a" }) {
  const embedded = new Map<string, number>();
  const state = { delayMs: 0, model };
  const embedder: ChatSearchEmbedder = {
    async currentModel() { return state.model; },
    async embed(request) {
      for (const value of request.texts) embedded.set(value, (embedded.get(value) ?? 0) + 1);
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      return { dimension: 3, vectors: request.texts.map((value) => [value.length, 1, 0.5]) };
    }
  };
  return { embedded, embedder, state };
}

async function drain(embedder: ChatSearchEmbedder, ownerIds: readonly string[], chatsPerPass = 8): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    const summary = await runChatSearchIndexPass({ db: prisma, embedder, limits: { chatsPerPass, ownerIds } });
    if (!summary.more) return;
  }
  throw new Error("synthetic_drain_did_not_settle");
}

async function passages(chatId: string) {
  return prisma.$queryRaw<Array<{ userId: string; userMessageId: string; assistantMessageId: string; ordinal: number; text: string;
    contentHash: string; embeddingProviderModelId: string | null; embeddingDimension: number | null; dims: number | null }>>`
    SELECT "userId", "userMessageId", "assistantMessageId", "ordinal", "text", "contentHash", "embeddingProviderModelId",
      "embeddingDimension", vector_dims("embedding") AS "dims"
    FROM "ChatSearchPassage" WHERE "chatId" = ${chatId} ORDER BY "turnAt", "ordinal"`;
}

/** The deletion fence as admission writes it: the chat is archived and fenced under the deletion's own opaque id. */
async function fence(chatId: string): Promise<void> {
  await prisma.chat.update({ data: { archived: true, permanentDeletionAt: new Date(), permanentDeletionOperationId: randomUUID() },
    where: { id: chatId } });
}

describe("the past-chat index in PostgreSQL", () => {
  it("indexes a marked chat turn by turn with its files, words searchable and vectors written", async () => {
    const userId = await owner();
    const { chatId, ids } = await chat(userId, [["Which hotel near Termini?", "The Hotel Quirinale."], ["And the train?", "The 9:10."]]);
    await prisma.attachment.create({ data: { byteSize: 1, chatId, fileName: "itinerary.pdf", kind: "file", messageId: ids[0]!, metadata: {},
      mimeType: "application/pdf", status: "ready", storageKey: `chat-search-test/${randomUUID()}`, userId } });
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId }));
    const fake = fakeEmbedder();
    const summary = await runChatSearchIndexPass({ db: prisma, embedder: fake.embedder, limits: { ownerIds: [userId] } });
    expect(summary).toMatchObject({ claimed: 1, embedded: 2, failed: 0, indexed: 1 });
    const rows = await passages(chatId);
    expect(rows.map((row) => [row.userMessageId, row.assistantMessageId, row.ordinal])).toEqual([[ids[0], ids[1], 0], [ids[2], ids[3], 0]]);
    expect(rows[0]!.text).toBe("Chat: Synthetic trip\nFiles: itinerary.pdf\n\nUser: Which hotel near Termini?\n\nAssistant: The Hotel Quirinale.");
    expect(rows.every((row) => row.contentHash === chatSearchContentHash(row.text) && row.userId === userId)).toBe(true);
    expect(rows.every((row) => row.embeddingProviderModelId === "fake-embed-a" && row.embeddingDimension === 3 && row.dims === 3)).toBe(true);
    const words = await prisma.$queryRaw<Array<{ userMessageId: string }>>`
      SELECT "userMessageId" FROM "ChatSearchPassage"
      WHERE "chatId" = ${chatId} AND "searchVectorSimple" @@ plainto_tsquery('simple', 'quirinale itinerary.pdf')`;
    expect(words).toEqual([{ userMessageId: ids[0] }]);
    expect(await prisma.chatSearchState.findUniqueOrThrow({ where: { chatId } })).toMatchObject({
      attemptCount: 0, dirtyAt: null, indexedLeafMessageId: ids[3], lastErrorCode: null, nextAttemptAt: null, userId
    });
  });

  it("loses a chat's passages and state with the chat, and a turn's passages with either of its messages", async () => {
    const userId = await owner();
    const first = await chat(userId, [["One", "Answer one"], ["Two", "Answer two"]]);
    const second = await chat(userId, [["Other", "Other answer"]]);
    for (const target of [first, second]) await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId: target.chatId, userId }));
    await drain(fakeEmbedder().embedder, [userId]);
    expect(await passages(first.chatId)).toHaveLength(2);
    // Deleting the last answer takes its turn's passage at once, before any reindex.
    await prisma.chat.update({ data: { activeLeafMessageId: first.ids[2] }, where: { id: first.chatId } });
    await prisma.message.delete({ where: { id: first.ids[3]! } });
    expect((await passages(first.chatId)).map((row) => row.userMessageId)).toEqual([first.ids[0]]);
    await prisma.chat.delete({ where: { id: second.chatId } });
    expect(await prisma.chatSearchPassage.count({ where: { chatId: second.chatId } })).toBe(0);
    expect(await prisma.chatSearchState.count({ where: { chatId: second.chatId } })).toBe(0);
  });

  it("lets two workers drain the dirty chats concurrently, each chat claimed once and each passage embedded once", async () => {
    const userId = await owner();
    const chats = [];
    for (let index = 0; index < 12; index += 1) chats.push(await chat(userId, [[`Question ${index}`, `Answer ${index}`]]));
    for (const target of chats) await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId: target.chatId, userId }));
    const fake = fakeEmbedder();
    fake.state.delayMs = 20;
    await Promise.all([drain(fake.embedder, [userId], 3), drain(fake.embedder, [userId], 3)]);
    await drain(fake.embedder, [userId], 3);
    expect(fake.embedded.size).toBe(12);
    expect([...fake.embedded.values()].every((count) => count === 1)).toBe(true);
    expect(await prisma.chatSearchState.count({ where: { userId, NOT: { dirtyAt: null } } })).toBe(0);
    expect(await prisma.chatSearchPassage.count({ where: { userId, embeddingProviderModelId: "fake-embed-a" } })).toBe(12);
  });

  it("keeps every row with its chat's owner: foreign marks write nothing and the keys refuse a crossed owner", async () => {
    const userId = await owner();
    const other = await owner();
    const { chatId, ids } = await chat(userId, [["Mine", "My answer"]]);
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId: other }));
    expect(await prisma.chatSearchState.count({ where: { chatId } })).toBe(0);
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId }));
    expect(await prisma.chatSearchState.findUniqueOrThrow({ where: { chatId } })).toMatchObject({ userId });
    await expect(prisma.$executeRaw`
      INSERT INTO "ChatSearchPassage" ("id", "userId", "chatId", "userMessageId", "assistantMessageId", "turnAt", "ordinal", "text", "contentHash")
      VALUES (${randomUUID()}, ${other}, ${chatId}, ${ids[0]}, ${ids[1]}, CURRENT_TIMESTAMP, 0, 'x', ${chatSearchContentHash("x")})`)
      .rejects.toThrow();
    await expect(prisma.$executeRaw`
      INSERT INTO "ChatSearchState" ("chatId", "userId") VALUES (${chatId}, ${other})
      ON CONFLICT ("chatId") DO UPDATE SET "userId" = EXCLUDED."userId"`).rejects.toThrow();
    await drain(fakeEmbedder().embedder, [userId, other]);
    expect((await passages(chatId)).map((row) => row.userId)).toEqual([userId]);
  });

  it("treats the fence's refusal of new passages as the chat being gone, not as a failure to retry", async () => {
    const userId = await owner();
    const { chatId, ids } = await chat(userId, [["Question", "Answer"]]);
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId }));
    const store = createPrismaChatSearchIndexStore(prisma);
    const [claim] = await store.claimDue({ leaseUntil: new Date(Date.now() + 60_000), limit: 1, now: new Date(), ownerIds: [userId] });
    await fence(chatId);
    const passageText = "Chat: Synthetic trip\n\nUser: Question\n\nAssistant: Answer";
    const draft = { assistantMessageId: ids[1]!, contentHash: chatSearchContentHash(passageText), ordinal: 0, text: passageText,
      turnAt: new Date(), userMessageId: ids[0]! };
    // The guard itself: SQLSTATE 23514 on a new passage of the fenced chat.
    const refused = await prisma.$executeRaw`
      INSERT INTO "ChatSearchPassage" ("id", "userId", "chatId", "userMessageId", "assistantMessageId", "turnAt", "ordinal", "text", "contentHash")
      VALUES (${randomUUID()}, ${userId}, ${chatId}, ${ids[0]}, ${ids[1]}, CURRENT_TIMESTAMP, 0, ${passageText}, ${draft.contentHash})`
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((refused as Prisma.PrismaClientKnownRequestError).meta).toMatchObject({ code: "23514" });
    expect(await store.reconcile(claim!, { kind: "passages", leafMessageId: ids[1]!, passages: [draft] })).toEqual({ kind: "gone" });
    expect(await prisma.chatSearchState.count({ where: { chatId } })).toBe(0);
    expect(await prisma.chatSearchPassage.count({ where: { chatId } })).toBe(0);
  });

  it("backfills eligible chats without a state, most recent first, and clears a chat left indexed after it was excluded", async () => {
    const userId = await owner();
    const ordinary = await chat(userId, [["Old question", "Old answer"]]);
    const excluded = await chat(userId, [["Private", "Private answer"]], { memoryMode: "EXCLUDED" });
    const fake = fakeEmbedder();
    expect(await runChatSearchBackfillPass({ db: prisma, embedder: fake.embedder, limits: { ownerIds: [userId] } }))
      .toMatchObject({ added: 1, leftovers: 0 });
    expect(await prisma.chatSearchState.count({ where: { chatId: excluded.chatId } })).toBe(0);
    await drain(fake.embedder, [userId]);
    expect(await passages(ordinary.chatId)).toHaveLength(1);
    // Excluded without anyone calling clearChatSearch: the sweep marks it and the pass clears it.
    await prisma.chat.update({ data: { memoryMode: "EXCLUDED" }, where: { id: ordinary.chatId } });
    expect(await runChatSearchBackfillPass({ db: prisma, embedder: fake.embedder, limits: { ownerIds: [userId] } }))
      .toMatchObject({ added: 0, leftovers: 1 });
    await drain(fake.embedder, [userId]);
    expect(await passages(ordinary.chatId)).toEqual([]);
    expect(await prisma.chatSearchState.count({ where: { chatId: ordinary.chatId } })).toBe(0);
  });

  it("clears a chat at once in the caller's transaction, and marks every chat of an owner after a saved secret", async () => {
    const userId = await owner();
    const other = await owner();
    const mine = await chat(userId, [["Mine", "Answer"]]);
    const theirs = await chat(other, [["Theirs", "Answer"]]);
    for (const [target, user] of [[mine, userId], [theirs, other]] as const) {
      await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId: target.chatId, userId: user }));
    }
    await drain(fakeEmbedder().embedder, [userId, other]);
    expect(await prisma.$transaction((tx) => markOwnerChatsSearchDirty(tx, { userId }))).toBe(1);
    expect(await prisma.chatSearchState.findUniqueOrThrow({ where: { chatId: mine.chatId } })).toMatchObject({ nextAttemptAt: null });
    expect((await prisma.chatSearchState.findUniqueOrThrow({ where: { chatId: mine.chatId } })).dirtyAt).not.toBeNull();
    expect((await prisma.chatSearchState.findUniqueOrThrow({ where: { chatId: theirs.chatId } })).dirtyAt).toBeNull();
    await prisma.$transaction(async (tx) => {
      await tx.chat.update({ data: { memoryMode: "EXCLUDED" }, where: { id: theirs.chatId } });
      await clearChatSearch(tx, { chatId: theirs.chatId });
    });
    expect(await prisma.chatSearchPassage.count({ where: { chatId: theirs.chatId } })).toBe(0);
    expect(await prisma.chatSearchState.count({ where: { chatId: theirs.chatId } })).toBe(0);
  });

  it("re-embeds every passage once after the role changes, while words keep working", async () => {
    const userId = await owner();
    const { chatId } = await chat(userId, [["Rome hotel", "Termini"], ["Florence hotel", "Santa Maria Novella"]]);
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId }));
    const fake = fakeEmbedder();
    await drain(fake.embedder, [userId]);
    fake.state.model = { kind: "model", providerModelId: "fake-embed-b" };
    fake.embedded.clear();
    expect(await scheduleChatSearchReembedding(prisma)).toBeGreaterThanOrEqual(1);
    const words = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS "count" FROM "ChatSearchPassage"
      WHERE "chatId" = ${chatId} AND "searchVectorSimple" @@ plainto_tsquery('simple', 'novella')`;
    expect(words).toEqual([{ count: 1 }]);
    await drain(fake.embedder, [userId]);
    expect(fake.embedded.size).toBe(2);
    expect((await passages(chatId)).every((row) => row.embeddingProviderModelId === "fake-embed-b")).toBe(true);
    fake.embedded.clear();
    await scheduleChatSearchReembedding(prisma);
    await drain(fake.embedder, [userId]);
    expect(fake.embedded.size).toBe(0);
  });

  it("embeds nothing for a deactivated owner or one with search off, and the sweep embeds once the switch is on", async () => {
    const searchOff = await owner();
    const memoryOff = await owner();
    const inactive = await owner();
    await prisma.userSettings.create({ data: { pastChatSearchEnabled: false, userId: searchOff } });
    await prisma.userSettings.create({ data: { memoryEnabled: false, userId: memoryOff } });
    await prisma.user.update({ data: { status: "disabled" }, where: { id: inactive } });
    const chats = [await chat(searchOff, [["Hotel?", "The river one."]]), await chat(memoryOff, [["Train?", "The 9:10."]]),
      await chat(inactive, [["Pack?", "An umbrella."]])];
    const all = [searchOff, memoryOff, inactive];
    const fake = fakeEmbedder();
    expect(await runChatSearchBackfillPass({ db: prisma, embedder: fake.embedder, limits: { ownerIds: all } }))
      .toMatchObject({ added: 3 });
    await drain(fake.embedder, all);
    expect(fake.embedded.size).toBe(0);
    for (const { chatId } of chats) {
      // Words stay searchable in the installation; the chat waits without a retry.
      expect(await passages(chatId)).toEqual([expect.objectContaining({ embeddingProviderModelId: null })]);
      expect(await prisma.chatSearchState.findUniqueOrThrow({ where: { chatId } }))
        .toMatchObject({ attemptCount: 0, dirtyAt: null, lastErrorCode: "owner_search_off", nextAttemptAt: null });
    }
    expect(await runChatSearchBackfillPass({ db: prisma, embedder: fake.embedder, limits: { ownerIds: all } }))
      .toMatchObject({ vectors: 0 });

    await prisma.userSettings.update({ data: { pastChatSearchEnabled: true }, where: { userId: searchOff } });
    expect(await runChatSearchBackfillPass({ db: prisma, embedder: fake.embedder, limits: { ownerIds: all } }))
      .toMatchObject({ vectors: 1 });
    await drain(fake.embedder, all);
    expect(fake.embedded.size).toBe(1);
    expect(await passages(chats[0]!.chatId)).toEqual([expect.objectContaining({ embeddingProviderModelId: "fake-embed-a" })]);
    for (const { chatId } of chats.slice(1)) {
      expect(await passages(chatId)).toEqual([expect.objectContaining({ embeddingProviderModelId: null })]);
    }
  });

  it("builds no passage for a turn with a message the old Memory kept out, and follows the rest of the branch", async () => {
    const userId = await owner();
    const { chatId, ids } = await chat(userId, [["Before the reset", "Old answer"], ["Kept question", "Paused answer"],
      ["After it", "New answer"]]);
    // The first question (a history reset) and the second answer (a pause) stay out, as the migration carried them.
    for (const messageId of [ids[0]!, ids[3]!]) {
      await prisma.$executeRaw`
        INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId") VALUES (${chatId}, ${messageId}, ${userId})`;
    }
    await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId }));
    const fake = fakeEmbedder();
    await drain(fake.embedder, [userId]);
    const rows = await passages(chatId);
    expect(rows.map((row) => [row.userMessageId, row.assistantMessageId])).toEqual([[ids[4], ids[5]]]);
    expect([...fake.embedded.keys()].join("\n")).not.toMatch(/Before the reset|Old answer|Kept question|Paused answer/u);
    // The rows go with their messages.
    await prisma.chat.delete({ where: { id: chatId } });
    expect(await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS "count" FROM "ChatSearchExcludedMessage" WHERE "chatId" = ${chatId}`).toEqual([{ count: 0 }]);
  });

  it("names a chat by its search title in passages, results and reads: screened, and untitled once its first message is kept out", async () => {
    const userId = await owner();
    const saved = "DB_PASSWORD=fixture-pass-42\r\nDB_HOST=cache.example";
    // A new chat takes its first message's first line as its title (`titleFromMessageContent`), here part of a saved secret.
    const { chatId, ids } = await chat(userId, [[saved, "Stored."], ["Which port?", "Port 5432 on the replica."]],
      { title: titleFromMessageContent(text(saved)) });
    const words = fakeEmbedder({ kind: "unset" });
    const store = createPrismaChatSearchIndexStore(prisma);
    const index = async () => {
      await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId, userId }));
      for (let pass = 0; pass < 10; pass += 1) {
        if (!(await runChatSearchIndexPassOn({ ...store, loadSavedSecretValues: async () => [saved] },
          { embedder: words.embedder, limits: { ownerIds: [userId] } })).more) return;
      }
    };
    const search = createPastChatSearch({ embedder: words.embedder, recordUsage: () => undefined, savedSecretValues: async () => [saved],
      store: createPrismaPastChatSearchStore(prisma) });
    const reader = createPastChatReader({ savedSecretValues: async () => [saved], store: createPrismaPastChatReadStore(prisma) });
    const titles = async () => {
      const found = await search.search({ currentChatId: randomUUID(), input: { query: "replica" }, ownerId: userId, timeZone: "UTC" });
      const read = await reader.read({ input: { chat_id: chatId }, ownerId: userId, timeZone: "UTC" });
      return { read: read.kind === "read" ? read.result.chatTitle : read.kind,
        results: found.kind === "searched" ? found.result.results.map((result) => result.chatTitle) : found.kind };
    };

    await index();
    const texts = (await passages(chatId)).map((row) => row.text);
    expect(texts).toHaveLength(2);
    expect(texts.join("\n")).not.toContain("fixture-pass-42");
    expect(texts.every((value) => value.startsWith(`Chat: ${SAVED_SECRET_MARKER}\n`))).toBe(true);
    expect(await titles()).toEqual({ read: SAVED_SECRET_MARKER, results: [SAVED_SECRET_MARKER] });

    // The first message was written before the chat's old Resume: no title made from it is shown or searchable.
    await prisma.$executeRaw`
      INSERT INTO "ChatSearchExcludedMessage" ("chatId", "messageId", "userId") VALUES (${chatId}, ${ids[0]!}, ${userId})`;
    await index();
    expect((await passages(chatId)).map((row) => row.text)).toEqual(["Chat:\n\nUser: Which port?\n\nAssistant: Port 5432 on the replica."]);
    expect(await titles()).toEqual({ read: "Untitled chat", results: ["Untitled chat"] });
    // The owner's own title is the owner's words and stays.
    await prisma.chat.update({ data: { title: "Replica settings", titleRevision: { increment: 1 } }, where: { id: chatId } });
    await index();
    expect(await titles()).toEqual({ read: "Replica settings", results: ["Replica settings"] });
  });

  it("records past-chat search usage without a Memory binding, as the usage checks allow", async () => {
    const userId = await owner();
    const model = await prisma.providerModel.findFirst({ select: { id: true } });
    if (!model) return; // A database without any catalog model cannot name one; the shape check is the point.
    await expect(recordChatSearchUsage(prisma, { costUsd: 0.00001, modelId: "synthetic-embed", provider: "fake",
      providerModelId: model.id, purpose: "memory_indexing", requestCount: 1, usage: { inputTokens: 5, totalTokens: 5 }, userId }))
      .resolves.toBe("recorded");
    expect(await prisma.usageEvent.findFirstOrThrow({ where: { userId } })).toMatchObject({
      estimatedCostMicros: 10, operationCount: 1, purpose: "memory_indexing", usageCompleteness: "PARTIAL"
    });
  });
});
