import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import type { RunRepository } from "../runs/runRepositoryContract";
import { createChatContinuationRepository } from "./continuationRepository";
import { createPrismaChatNavigationRepository } from "./navigation";
import { createPrismaChatRepository } from "./prismaRepository";

/**
 * An answer review the previous release recorded before Answer Review was
 * removed (operator decision 2026-10-25) reads as its question and latest
 * version wherever the chat is read, and every action on that version acts
 * on an answer of the question. The fixtures write the rows as that release
 * did; nothing here dispatches to a provider.
 */

afterAll(() => prisma.$disconnect());

/** The automatic review choice the previous release stored; nothing reads it any more. */
const storedAutoReview = { enabled: true, maxRounds: 2, reviewers: [{ modelId: "fixture-reviewer", provider: "fake" }] };

async function withUser<T>(run: (userId: string) => Promise<T>): Promise<T> {
  const userId = `legacy-review-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Legacy review test", id: userId, status: "active", settings: { create: {
    defaultAnswerReview: storedAutoReview, defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled"
  } } } });
  try {
    return await run(userId);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

type Say = (role: "assistant" | "user", text: string, parentMessageId: string | null,
  extra?: Partial<Prisma.MessageUncheckedCreateInput>) => Promise<string>;

/** A personal chat with a question, its answer and that answer's session, as the previous release wrote them. */
async function sessionChat(userId: string) {
  const chat = await prisma.chat.create({ data: { answerReviewConfig: storedAutoReview,
    defaultProviderModelId: providerTemplateIds.fakeModel, title: "Reviewed", userId } });
  const say: Say = async (role, text, parentMessageId, extra = {}) => (await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(text), parentMessageId, role, status: "complete", ...extra
  }, select: { id: true } })).id;
  const q = await say("user", "Question", null);
  const a1 = await say("assistant", "First answer", q);
  const session = await prisma.answerReviewSession.create({ data: {
    authorModel: { modelId: "fake-qsa", name: "Fake QSA", provider: "fake" }, chatId: chat.id, mode: "manual",
    reviewers: [{ modelId: "fixture-reviewer", name: "Reviewer", provider: "fake" }], sourceAssistantMessageId: a1, userId
  } });
  const turn = (round: number, step: number, kind: "answer_review_request" | "answer_revision_request") =>
    ({ answerReviewRound: round, answerReviewSessionId: session.id, answerReviewStep: step, systemTurnKind: kind });
  const member = { answerReviewSessionId: session.id };
  const setLeaf = (messageId: string) => prisma.chat.update({ data: { activeLeafMessageId: messageId }, where: { id: chat.id } });
  return { a1, chat: chat.id, member, q, say, setLeaf, turn };
}

/** Then a review and the revision (round 1) and a second round's review; the chat's leaf as given. */
async function reviewedChat(userId: string, leaf: "a2" | "r2") {
  const { a1, chat, member, q, say, setLeaf, turn } = await sessionChat(userId);
  const t1 = await say("user", "Review the previous answer.", a1, turn(1, 0, "answer_review_request"));
  const r1 = await say("assistant", "Review submitted: one finding.", t1, member);
  const t2 = await say("user", "Revise the answer.", r1, turn(1, 1, "answer_revision_request"));
  const a2 = await say("assistant", "Revised answer", t2, member);
  const t3 = await say("user", "Review the previous answer.", a2, turn(2, 0, "answer_review_request"));
  const r2 = await say("assistant", "Review submitted: no substantive issues.", t3, member);
  const ids = { a1, a2, chat, q, r1, r2, t1, t2, t3 };
  await setLeaf(ids[leaf]);
  return { ...ids, say };
}

function runInput(chatId: string, userId: string, question: string): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent(question);
  return {
    chatId, content,
    defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId },
    expectedActiveLeafId: null, modelId: "fake-qsa",
    normalizedRequest: { attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: false, vision: false }, modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto" },
    provider: "fake", providerRequestPreview: {}, userId
  };
}

function regenerationInput(chatId: string, userId: string, userMessageId: string, preSendAssistantMessageId: string):
  Parameters<RunRepository["createRegenerationRun"]>[0] {
  const { content: _content, expectedActiveLeafId: _leaf, workspaceFollowup: _followup, ...input } = runInput(chatId, userId, "Question");
  return { ...input, preSendAssistantMessageId, userMessageId };
}

const leafOf = async (chatId: string) => (await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true },
  where: { id: chatId } })).activeLeafMessageId;
const idsOf = (messages: readonly Readonly<{ id?: string }>[] | null) => messages?.map((message) => message.id) ?? null;

describe("an answer review recorded before the removal", () => {
  it("reads as its question and latest version in the chat and its branch graph", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      const chats = createPrismaChatRepository(prisma);
      const detail = await chats.getChat({ chatId: ids.chat, userId });
      expect(detail?.messages.map((message) => [message.id, message.parentMessageId])).toEqual([[ids.q, null], [ids.a2, ids.q]]);
      expect(detail?.messages.some((message) => message.systemTurnKind !== undefined)).toBe(false);
      expect(detail).not.toHaveProperty("answerReview");
      // The stored leaf is the second round's review; the browser reads it as the version.
      expect([detail?.activeLeafMessageId, detail?.pageInfo.activeLeafMessageId]).toEqual([ids.a2, ids.a2]);
      const graph = await chats.getBranches({ chatId: ids.chat, userId });
      expect(new Map(graph?.nodes.map((node) => [node.id, node.parentMessageId]))).toEqual(new Map([[ids.q, null], [ids.a2, ids.q]]));
      expect(graph?.activeLeafMessageId).toBe(ids.a2);
    });
  });

  it("offers message search only the latest version, never a step or a superseded version", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      const navigation = createPrismaChatNavigationRepository(prisma);
      const matches = async (query: string) => {
        const result = await navigation.searchMessagesPage({ cursor: null, limit: 30, query, userId });
        if (result.kind !== "ok") throw new Error(`message_search_${result.kind}`);
        return result.page.matches.map((match) => [match.messageId, match.matchCount]);
      };
      expect(await matches("Review submitted")).toEqual([]);
      expect(await matches("First answer")).toEqual([]);
      expect(await matches("answer")).toEqual([[ids.a2, 1]]);
    });
  });

  it.each(["a2", "r2"] as const)("regenerates the latest version as an answer of the source question (leaf %s)", async (leaf) => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, leaf);
      const runs = createPrismaRunRepository(prisma);
      const source = await runs.findRegenerationSource(ids.a2, userId);
      expect([source?.userMessage.id, source?.assistantMessage?.id]).toEqual([ids.q, ids.a2]);
      // A step's own answer or its server-written turn is never answered again.
      for (const step of [ids.r1, ids.t2, ids.r2]) expect(await runs.findRegenerationSource(step, userId)).toBeNull();
      const regenerated = await runs.createRegenerationRun(regenerationInput(ids.chat, userId, ids.q, ids.a2));
      await expect(prisma.message.findUniqueOrThrow({ select: { parentMessageId: true }, where: { id: regenerated.assistantMessageId } }))
        .resolves.toEqual({ parentMessageId: ids.q });
      expect(await leafOf(ids.chat)).toBe(regenerated.assistantMessageId);
    });
  });

  it("takes a send after a step under that step, shows it under the version and gives it the version as context", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      const runs = createPrismaRunRepository(prisma);
      expect(await runs.loadVisibleLeafMessageId?.(ids.chat, ids.r2)).toBe(ids.a2);
      expect(await runs.loadVisibleLeafMessageId?.(ids.chat, ids.q)).toBe(ids.q);
      expect(idsOf(await runs.loadConversationContextForExpectedLeaf(ids.chat, userId, ids.r2))).toEqual([ids.q, ids.a2]);
      const created = await runs.createRun({ ...runInput(ids.chat, userId, "Next question"), expectedActiveLeafId: ids.r2 });
      await expect(prisma.message.findUniqueOrThrow({ select: { parentMessageId: true }, where: { id: created.userMessageId } }))
        .resolves.toEqual({ parentMessageId: ids.r2 });
      expect(idsOf(await runs.loadConversationContextForLeaf(ids.chat, userId, created.userMessageId)))
        .toEqual([ids.q, ids.a2, created.userMessageId]);
      const update = await runs.getChatUpdateForRun({ assistantMessageId: created.assistantMessageId, chatId: ids.chat, userId,
        userMessageId: created.userMessageId });
      expect(update?.messages.find((message) => message.id === created.userMessageId)?.parentMessageId).toBe(ids.a2);
      const detail = await createPrismaChatRepository(prisma).getChat({ chatId: ids.chat, userId });
      expect(detail?.messages.map((message) => [message.id, message.parentMessageId])).toEqual([[ids.q, null], [ids.a2, ids.q],
        [created.userMessageId, ids.a2], [created.assistantMessageId, created.userMessageId]]);
    });
  });

  it("gives later turns the source answer when no revision completed, after a stopped step or an approval", async () => {
    await withUser(async (userId) => {
      const { a1, chat, member, q, say, turn } = await sessionChat(userId);
      const t1 = await say("user", "Review the previous answer.", a1, turn(1, 0, "answer_review_request"));
      // Stopped with partial text, which a path keeps for a stopped ordinary answer.
      const r1 = await say("assistant", "I checked the first figure and", t1, { ...member, status: "cancelled" });
      const t2 = await say("user", "Revise the answer.", r1, turn(1, 1, "answer_revision_request"));
      const stopped = await say("assistant", "The total is", t2, { ...member, status: "cancelled" });
      const runs = createPrismaRunRepository(prisma);
      for (const leaf of [r1, stopped]) {
        expect(idsOf(await runs.loadConversationContextForExpectedLeaf(chat, userId, leaf)), leaf).toEqual([q, a1]);
      }
      // A continuation after a step's approval card reads the path up to it: the step leaves whole.
      const continuation = await say("user", "The user approved `lookup` on `Records`. Continue the task.", r1,
        { systemTurnKind: "mcp_approval_continuation" });
      expect(idsOf(await runs.loadConversationContextForLeaf(chat, userId, continuation))).toEqual([q, a1, continuation]);
    });
  });

  it("copies a path through the reviewed answer as its question, the latest version and what followed", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      // What the user asked after the version: under the stored leaf, as a send after a step is taken.
      const next = await ids.say("user", "Next question", ids.r2);
      const answer = await ids.say("assistant", "Next answer", next);
      const branches = createPrismaMessageBranchRepository(prisma);
      const copied = async (sourceMessageId: string) => {
        const branch = await branches.createChatBranchFromMessage({ sourceMessageId, userId });
        const rows = await prisma.message.findMany({ orderBy: { createdAt: "asc" }, select: { answerReviewSessionId: true,
          content: true, id: true, parentMessageId: true, systemTurnKind: true }, where: { chatId: branch!.id } });
        expect(rows.every((row) => row.answerReviewSessionId === null && row.systemTurnKind === null)).toBe(true);
        expect(await prisma.answerReviewSession.count({ where: { chatId: branch!.id } })).toBe(0);
        // One linear chain ending on the chat's leaf.
        expect(rows.map((row) => row.parentMessageId)).toEqual(rows.map((_row, index) => index === 0 ? null : rows[index - 1]!.id));
        expect(await leafOf(branch!.id)).toBe(rows.at(-1)!.id);
        return rows.map((row) => (row.content as { blocks: Array<{ text: string }> }).blocks.map((block) => block.text).join(""));
      };
      expect(await copied(answer)).toEqual(["Question", "Revised answer", "Next question", "Next answer"]);
      // The version itself, and a step as the version it stood for.
      expect(await copied(ids.a2)).toEqual(["Question", "Revised answer"]);
      expect(await copied(ids.r2)).toEqual(["Question", "Revised answer"]);
      expect(await copied(ids.r1)).toEqual(["Question", "First answer"]);
    });
  });

  it("deletes the reviewed answer from its source answer, never bringing an earlier version back", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      const deleted = await createPrismaMessageBranchRepository(prisma).deleteMessageSubtree({ messageId: ids.a2, userId });
      expect(new Set(deleted?.deletedMessageIds)).toEqual(new Set([ids.a1, ids.t1, ids.r1, ids.t2, ids.a2, ids.t3, ids.r2]));
      expect(deleted?.activeLeafMessageId).toBe(ids.q);
      expect(await prisma.answerReviewSession.count({ where: { chatId: ids.chat } })).toBe(0);
    });
  });

  it("deletes the version without the source answer the chat still shows with a branch under a hidden step", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      const other = await ids.say("user", "Other branch", ids.r1);
      const otherReply = await ids.say("assistant", "Other reply", other);
      const chats = createPrismaChatRepository(prisma);
      expect(new Map((await chats.getBranches({ chatId: ids.chat, userId }))?.nodes.map((node) => [node.id, node.parentMessageId])))
        .toEqual(new Map([[ids.q, null], [ids.a1, ids.q], [ids.a2, ids.q], [other, ids.a1], [otherReply, other]]));
      const deleted = await createPrismaMessageBranchRepository(prisma).deleteMessageSubtree({ messageId: ids.a2, userId });
      expect(new Set(deleted?.deletedMessageIds)).toEqual(new Set([ids.t2, ids.a2, ids.t3, ids.r2]));
      expect(deleted?.activeLeafMessageId).toBe(ids.q);
      const graph = await chats.getBranches({ chatId: ids.chat, userId });
      expect(new Map(graph?.nodes.map((node) => [node.id, node.parentMessageId])))
        .toEqual(new Map([[ids.q, null], [ids.a1, ids.q], [other, ids.a1], [otherReply, other]]));
      expect(await prisma.answerReviewSession.count({ where: { chatId: ids.chat } })).toBe(1);
    });
  });

  it("reads a version the previous release regenerated beside the one it copied", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "a2");
      // A regeneration of the version copied it under the revision request without its session.
      const copy = await ids.say("assistant", "Revised answer again", ids.t2, { modelId: "fake-qsa", provider: "fake" });
      await prisma.chat.update({ data: { activeLeafMessageId: copy }, where: { id: ids.chat } });
      const chats = createPrismaChatRepository(prisma);
      expect((await chats.getChat({ chatId: ids.chat, userId }))?.messages.map((message) => [message.id, message.parentMessageId]))
        .toEqual([[ids.q, null], [copy, ids.q]]);
      expect(new Map((await chats.getBranches({ chatId: ids.chat, userId }))?.nodes.map((node) => [node.id, node.parentMessageId])))
        .toEqual(new Map([[ids.q, null], [ids.a2, ids.q], [copy, ids.q]]));
      const source = await createPrismaRunRepository(prisma).findRegenerationSource(copy, userId);
      expect([source?.userMessage.id, source?.assistantMessage?.id]).toEqual([ids.q, copy]);
      const navigation = createPrismaChatNavigationRepository(prisma);
      const matches = async (query: string) => {
        const result = await navigation.searchMessagesPage({ cursor: null, limit: 30, query, userId });
        if (result.kind !== "ok") throw new Error(`message_search_${result.kind}`);
        return result.page.matches.map((match) => [match.messageId, match.matchCount]);
      };
      expect(await matches("First answer")).toEqual([]);
      expect(await matches("Revised answer")).toEqual([[copy, 2]]);
    });
  });

  it.each(["a2", "r2"] as const)("continues in a new chat from the version the chat shows (stored leaf %s)", async (leaf) => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, leaf);
      const source = await createChatContinuationRepository(prisma).loadSource({ chatId: ids.chat, expectedLeafMessageId: ids.a2,
        requestId: randomUUID(), userId });
      expect(source.transcript).toBe("USER:\nQuestion\n\nASSISTANT:\nRevised answer");
      // Every later check compares the stored leaf.
      expect(source.leafMessageId).toBe(ids[leaf]);
    });
  });

  it("deletes a chat with its recorded sessions and steps", async () => {
    await withUser(async (userId) => {
      const ids = await reviewedChat(userId, "r2");
      await prisma.chat.delete({ where: { id: ids.chat } });
      expect(await prisma.answerReviewSession.count({ where: { chatId: ids.chat } })).toBe(0);
      expect(await prisma.message.count({ where: { chatId: ids.chat } })).toBe(0);
    });
  });
});
