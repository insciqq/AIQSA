// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { chatExportDocument } from "../../domain/chatExportDocument";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import type { ChatSearchEmbedder } from "../chatSearch/embedder";
import { markChatSearchDirty } from "../chatSearch/index/dirty";
import { runChatSearchIndexPass } from "../chatSearch/index/pass";
import { createPrismaPastChatReadStore } from "../chatSearch/search/read";
import { createPastChatSearch } from "../chatSearch/search/retrieval";
import { createPrismaPastChatSearchStore } from "../chatSearch/search/store";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createPrismaShareRepository } from "../shares/prismaRepository";
import { createChatContinuationRepository } from "./continuationRepository";
import { loadAuthorizedChatExportSource } from "./exportChat";
import { createPrismaChatNavigationRepository } from "./navigation";
import { createPrismaChatRepository } from "./prismaRepository";

/**
 * A chat the removed Answer Review recorded, as the drop of its storage left
 * it (`prisma/migrations/20261123020000_drop_answer_review_storage/`): its
 * review and revision requests are ordinary user turns and their answers
 * ordinary answers, still where they were on the stored branch. Such a chat
 * loads, exports, shares, continues and is found by past-chat search like any
 * other, each turn as stored. Nothing here dispatches to a provider.
 */

afterAll(() => prisma.$disconnect());

async function withUser<T>(run: (userId: string) => Promise<T>): Promise<T> {
  const userId = `answer-review-chat-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Reviewed chat test", id: userId, status: "active", settings: { create: {
    defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled"
  } } } });
  try {
    return await run(userId);
  } finally {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.usageEvent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 12, minute));
const REVIEW = "[Answer review request — written by AIQSA for the user, not typed by the user]\nReview the previous answer.";
const REVISION = "[Answer revision request — written by AIQSA for the user, not typed by the user]\nRevise the answer.";

/**
 * The question, its first answer, a review and its revision, then a second
 * round's review on the branch's leaf, and a regenerated version beside the
 * revision.
 */
async function reviewedChat(userId: string) {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Quarterly total",
    userId } });
  let minute = 0;
  const say = async (role: "assistant" | "user", text: string, parentMessageId: string | null) => (await prisma.message.create({
    data: { chatId: chat.id, content: textMessageContent(text), createdAt: at(minute += 1), parentMessageId, role, status: "complete" },
    select: { id: true } })).id;
  const q = await say("user", "What is the quarterly total?", null);
  const a1 = await say("assistant", "First answer: the total is 42.", q);
  const t1 = await say("user", REVIEW, a1);
  const r1 = await say("assistant", "Review submitted: one finding.", t1);
  const t2 = await say("user", REVISION, r1);
  const a2 = await say("assistant", "Revised answer: the total is 41.", t2);
  const copy = await say("assistant", "Revised answer again: the total is 41.", t2);
  const t3 = await say("user", REVIEW, a2);
  const r2 = await say("assistant", "Review submitted: no substantive issues.", t3);
  await prisma.chat.update({ data: { activeLeafMessageId: r2 }, where: { id: chat.id } });
  const ids = { a1, a2, copy, q, r1, r2, t1, t2, t3 };
  return { ...ids, branch: [q, a1, t1, r1, t2, a2, t3, r2], chat: chat.id };
}

const textOf = (content: unknown) => (content as { blocks: Array<{ text?: string }> }).blocks.map((block) => block.text ?? "").join("");

/** Each text embeds to the same direction, so meaning search never decides what these tests read. */
const embedder: ChatSearchEmbedder = {
  currentModel: async () => ({ kind: "model", providerModelId: "fake-embed-review" }),
  embed: async (request) => ({ dimension: 3, vectors: request.texts.map(() => [1, 0, 0]) })
};

describe("a chat the removed Answer Review recorded", () => {
  it("loads every stored turn on its active branch and in its branch graph", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId);
      const chats = createPrismaChatRepository(prisma);
      const detail = await chats.getChat({ chatId: ids.chat, userId });
      expect(detail?.messages.map((message) => message.id)).toEqual(ids.branch);
      expect(detail?.messages.map((message) => message.parentMessageId)).toEqual([null, ...ids.branch.slice(0, -1)]);
      expect(detail?.messages.some((message) => message.systemTurnKind !== undefined)).toBe(false);
      expect([detail?.activeLeafMessageId, detail?.pageInfo.activeLeafMessageId]).toEqual([ids.r2, ids.r2]);
      const graph = await chats.getBranches({ chatId: ids.chat, userId });
      expect(new Map(graph?.nodes.map((node) => [node.id, node.parentMessageId]))).toEqual(new Map([[ids.q, null], [ids.a1, ids.q],
        [ids.t1, ids.a1], [ids.r1, ids.t1], [ids.t2, ids.r1], [ids.a2, ids.t2], [ids.copy, ids.t2], [ids.t3, ids.a2], [ids.r2, ids.t3]]));
      expect(graph?.activeLeafMessageId).toBe(ids.r2);
    });
  });

  it("is found by message search in its former steps' turns and answers", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId);
      const navigation = createPrismaChatNavigationRepository(prisma);
      const matches = async (query: string) => {
        const result = await navigation.searchMessagesPage({ cursor: null, limit: 30, query, userId });
        if (result.kind !== "ok") throw new Error(`message_search_${result.kind}`);
        return result.page.matches.map((match) => [match.messageId, match.matchCount]);
      };
      expect(await matches("Review submitted")).toEqual([[ids.r2, 2]]);
      expect(await matches("Review the previous answer")).toEqual([[ids.t3, 2]]);
      expect(await matches("First answer")).toEqual([[ids.a1, 1]]);
    });
  });

  it("exports its whole tree and shares its active branch, each turn as stored", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId);
      const source = await loadAuthorizedChatExportSource(prisma, { chatId: ids.chat, userId });
      const document = chatExportDocument(source!, at(30));
      // Depth first, siblings oldest first: the regenerated version follows the branch under the one it sits beside.
      expect(document.chat.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "What is the quarterly total?"], ["assistant", "First answer: the total is 42."], ["user", REVIEW],
        ["assistant", "Review submitted: one finding."], ["user", REVISION], ["assistant", "Revised answer: the total is 41."],
        ["user", REVIEW], ["assistant", "Review submitted: no substantive issues."], ["assistant", "Revised answer again: the total is 41."]
      ]);
      expect(document.chat.messages.find((message) => message.id === document.chat.activeLeafId)?.text)
        .toBe("Review submitted: no substantive issues.");
      const shared = await createPrismaShareRepository(prisma).createChatShare({ activeLeafMessageId: null, chatId: ids.chat,
        shareToken: "synthetic", slugHash: randomUUID().replaceAll("-", ""), userId });
      if (!shared || "error" in shared) throw new Error("share_not_created");
      expect(shared.snapshot.messages.map((message) => textOf(message.content))).toEqual([
        "What is the quarterly total?", "First answer: the total is 42.", REVIEW, "Review submitted: one finding.", REVISION,
        "Revised answer: the total is 41.", REVIEW, "Review submitted: no substantive issues."
      ]);
    });
  });

  it("regenerates a former step's answer for its own turn and continues in a new chat from its leaf", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId);
      const source = await createPrismaRunRepository(prisma).findRegenerationSource(ids.r2, userId);
      expect([source?.userMessage.id, source?.assistantMessage?.id]).toEqual([ids.t3, ids.r2]);
      const continued = await createChatContinuationRepository(prisma).loadSource({ chatId: ids.chat, expectedLeafMessageId: ids.r2,
        requestId: randomUUID(), userId });
      expect(continued.leafMessageId).toBe(ids.r2);
      expect(continued.transcript).toBe([
        "USER:\nWhat is the quarterly total?", "ASSISTANT:\nFirst answer: the total is 42.", `USER:\n${REVIEW}`,
        "ASSISTANT:\nReview submitted: one finding.", `USER:\n${REVISION}`, "ASSISTANT:\nRevised answer: the total is 41.",
        `USER:\n${REVIEW}`, "ASSISTANT:\nReview submitted: no substantive issues."
      ].join("\n\n"));
    });
  });

  it("is read and found by past-chat search turn by turn", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId);
      const branch = await createPrismaPastChatReadStore(prisma).branch(userId, ids.chat);
      expect(branch?.messages.map((message) => message.id)).toEqual(ids.branch);
      await prisma.$transaction((tx) => markChatSearchDirty(tx, { chatId: ids.chat, userId }));
      const summary = await runChatSearchIndexPass({ db: prisma, embedder, limits: { ownerIds: [userId] } });
      expect(summary).toMatchObject({ claimed: 1, failed: 0, indexed: 1 });
      const passages = await prisma.chatSearchPassage.findMany({ orderBy: [{ turnAt: "asc" }, { ordinal: "asc" }],
        select: { assistantMessageId: true, userMessageId: true }, where: { chatId: ids.chat } });
      expect(passages.map((passage) => [passage.userMessageId, passage.assistantMessageId]))
        .toEqual([[ids.q, ids.a1], [ids.t1, ids.r1], [ids.t2, ids.a2], [ids.t3, ids.r2]]);
      const outcome = await createPastChatSearch({ embedder, recordUsage: () => undefined, savedSecretValues: async () => [],
        store: createPrismaPastChatSearchStore(prisma) })
        .search({ currentChatId: randomUUID(), input: { query: "substantive issues" }, ownerId: userId, timeZone: "UTC" });
      if (outcome.kind !== "searched") throw new Error(`past_chat_search_${outcome.kind}`);
      expect(outcome.result.results.map((result) => [result.chatId, result.messageId])).toContainEqual([ids.chat, ids.t3]);
    });
  });
});
