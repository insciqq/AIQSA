// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaDiscordConversationStore } from "./conversations";
import { createPrismaDiscordLimitStore } from "./limits";
import { createPrismaDiscordReplyStore } from "./replies";
import { deleteExpiredDiscordRecords } from "./retention";

/**
 * Discord conversations, question rows, limit counts and retention on a
 * disposable database. Every id is synthetic and unique to the test run; each
 * test removes the user (and so the chats, conversations and questions) it made.
 */

const replies = createPrismaDiscordReplyStore(prisma);
const conversations = createPrismaDiscordConversationStore(prisma);
const limits = createPrismaDiscordLimitStore(prisma);
const users: string[] = [];
const loose: bigint[] = [];
let next = 1_100_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)) * 1_000n;
const snowflake = () => String(next++);

afterEach(async () => {
  await prisma.discordReply.deleteMany({ where: { questionMessageId: { in: loose.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});

async function serviceChat(): Promise<{ userId: string; chatId: string }> {
  const user = await prisma.user.create({ data: { displayName: "Discord", kind: "service", status: "active" } });
  users.push(user.id);
  const chat = await prisma.chat.create({ data: { title: "Synthetic thread", userId: user.id } });
  return { chatId: chat.id, userId: user.id };
}

function claim(input: Partial<Parameters<typeof replies.claim>[0]> = {}) {
  const questionMessageId = input.questionMessageId ?? snowflake();
  if (!input.conversationId) loose.push(BigInt(questionMessageId));
  return {
    authorName: "Synthetic author", channelId: "1100000000000000010", discordUserId: "1100000000000000020", guildId: "1100000000000000001",
    questionMessageId, receivedAt: new Date(), test: false, ...input
  };
}

describe("Discord stores (stateful)", () => {
  it("claims a question exactly once, even from concurrent processes, and updates it only from an expected state", async () => {
    const question = claim();
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => replies.claim(question)));
    expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "duplicate")).toHaveLength(3);
    expect(await replies.find(question.questionMessageId)).toMatchObject({ authorName: "Synthetic author", kind: "answer", state: "claimed", test: false });
    expect(await replies.update(question.questionMessageId, { ackAt: new Date(), state: "admitted", statusMessageId: "1100000000000000030" }, ["claimed"])).toBe(true);
    expect(await replies.update(question.questionMessageId, { state: "failed" }, ["claimed"])).toBe(false);
    expect(await replies.update(question.questionMessageId, {
      answerMessageId: "1100000000000000031", deliveredAt: new Date(), mcpByServer: { mcp_1: { calls: 2, errors: 1 } }, sources: 0, state: "delivered"
    }, ["admitted"])).toBe(true);
    expect(await replies.findByAnswerMessage("1100000000000000031")).toMatchObject({
      mcpByServer: { mcp_1: { calls: 2, errors: 1 } }, questionMessageId: question.questionMessageId, sources: 0, state: "delivered",
      statusMessageId: "1100000000000000030"
    });
    expect((await replies.listUnsettled({ before: new Date(Date.now() + 1_000), limit: 500 }))
      .some((row) => row.questionMessageId === question.questionMessageId)).toBe(false);
  });

  it("fixes a question's admission target once and lets one caller claim its send, once", async () => {
    const question = claim();
    await replies.claim(question);
    const first = "00000000-0000-4000-8000-000000000001";
    const fixed = await Promise.all([first, "00000000-0000-4000-8000-000000000002"].map((plannedChatId) =>
      replies.fixAdmissionTarget(question.questionMessageId, { plannedChatId })));
    expect(new Set(fixed.map((row) => row?.plannedChatId)).size).toBe(1);
    const leaf = claim();
    await replies.claim(leaf);
    expect(await replies.fixAdmissionTarget(leaf.questionMessageId, { expectedLeafId: "leaf-1" })).toMatchObject({ expectedLeafId: "leaf-1" });
    expect(await replies.fixAdmissionTarget(leaf.questionMessageId, { expectedLeafId: "leaf-2" })).toMatchObject({ expectedLeafId: "leaf-1" });
    const at = new Date();
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => replies.claimSend(question.questionMessageId, at)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await replies.claimSend(question.questionMessageId, new Date())).toBe(false);
    expect(await replies.find(question.questionMessageId)).toMatchObject({ sendClaimedAt: at, state: "claimed" });
    const admitted = claim();
    await replies.claim(admitted);
    await replies.update(admitted.questionMessageId, { state: "admitted" });
    expect(await replies.claimSend(admitted.questionMessageId, new Date())).toBe(false);
    expect(await replies.fixAdmissionTarget(admitted.questionMessageId, { plannedChatId: first })).toBeNull();
  });

  it("retires only a claimed question nobody claimed the send of, once", async () => {
    const unsent = claim();
    await replies.claim(unsent);
    const outcomes = await Promise.all(Array.from({ length: 2 }, () => replies.retireUnsent(unsent.questionMessageId, "discord_question_not_addressed")));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await replies.find(unsent.questionMessageId)).toMatchObject({ code: "discord_question_not_addressed", runId: null, state: "interrupted" });
    // A send claimed first wins: the row stays for admission and delivery.
    const sending = claim();
    await replies.claim(sending);
    expect(await replies.claimSend(sending.questionMessageId, new Date())).toBe(true);
    expect(await replies.retireUnsent(sending.questionMessageId, "discord_question_not_addressed")).toBe(false);
    expect(await replies.find(sending.questionMessageId)).toMatchObject({ code: null, state: "claimed" });
    const admitted = claim();
    await replies.claim(admitted);
    await replies.update(admitted.questionMessageId, { state: "admitted" });
    expect(await replies.retireUnsent(admitted.questionMessageId, "discord_question_not_addressed")).toBe(false);
    expect(await replies.find(admitted.questionMessageId)).toMatchObject({ code: null, state: "admitted" });
  });

  it("keeps one conversation per Discord channel, bound to the service account's chat and gone with it", async () => {
    const { chatId, userId } = await serviceChat();
    const channelId = snowflake();
    const input = { botOpened: true, chatId, discordChannelId: channelId, guildId: "1100000000000000001", kind: "thread" as const, now: new Date(),
      parentChannelId: "1100000000000000010", userId };
    const [first, second] = await Promise.all([conversations.create(input), conversations.create(input)]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.record.id).toBe(second.record.id);
    expect(await conversations.findByChat(chatId)).toMatchObject({ botOpened: true, discordChannelId: channelId, kind: "thread" });
    await conversations.touch({ at: new Date(Date.now() + 1_000), id: first.record.id, lastIncludedMessageId: "1100000000000000040" });
    expect(await conversations.findByChannel(channelId)).toMatchObject({ lastIncludedMessageId: "1100000000000000040" });
    // A conversation names its chat's owner: one account's chat cannot carry another's conversation.
    const other = await serviceChat();
    const secondChat = await prisma.chat.create({ data: { title: "Synthetic thread", userId } });
    await expect(conversations.create({ ...input, chatId: secondChat.id, discordChannelId: snowflake(), userId: other.userId })).rejects.toThrow();
    await replies.claim(claim({ channelId, conversationId: first.record.id }));
    await prisma.chat.delete({ where: { id: chatId } });
    expect(await conversations.findByChannel(channelId)).toBeNull();
    expect(await prisma.discordReply.count({ where: { conversationId: first.record.id } })).toBe(0);
  });

  it("counts an author's and a conversation's questions per window, never refused or test ones, and when the window frees", async () => {
    const { chatId, userId } = await serviceChat();
    const { record } = await conversations.create({
      botOpened: false, chatId, discordChannelId: snowflake(), guildId: "1100000000000000001", kind: "thread", now: new Date(), parentChannelId: null, userId
    });
    const author = snowflake();
    const now = new Date();
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
    for (const [minutesAgo, kind] of [[50, "answer"], [30, "follow_up"], [10, "answer"], [5, "refused"], [90, "answer"]] as const) {
      await replies.claim(claim({ conversationId: record.id, discordUserId: author, kind, receivedAt: at(minutesAgo) }));
    }
    // Test questions count toward neither the author's nor the conversation's windows.
    await replies.claim(claim({ conversationId: record.id, discordUserId: author, kind: "answer", receivedAt: at(20), test: true }));
    await replies.claim(claim({ conversationId: record.id, discordUserId: snowflake(), kind: "follow_up", receivedAt: at(15), test: true }));
    const usage = await limits.usage({ conversationId: record.id, discordUserId: author, limits: { perAuthorDaily: 10, perAuthorHourly: 3, perThreadHourly: 5 }, now });
    expect(usage.authorHour).toEqual({ count: 3, freesAt: new Date(at(50).getTime() + 3_600_000), limit: 3 });
    expect(usage.authorDay).toEqual({ count: 4, freesAt: null, limit: 10 });
    expect(usage.threadHour).toEqual({ count: 3, freesAt: null, limit: 5 });
    expect(await limits.noticeSent({ discordUserId: author, kind: "author", now })).toBe(false);
    const refusal = claim({ conversationId: record.id, discordUserId: author, kind: "refused", receivedAt: at(1) });
    await replies.claim(refusal);
    await replies.update(refusal.questionMessageId, { limitKind: "author", state: "failed", statusMessageId: snowflake() });
    expect(await limits.noticeSent({ discordUserId: author, kind: "author", now })).toBe(true);
    expect(await limits.noticeSent({ conversationId: record.id, kind: "thread", now })).toBe(false);
  });

  it("lists conversations for the backfill: active within the window, and every direct-message one", async () => {
    const { chatId, userId } = await serviceChat();
    const dmChat = await prisma.chat.create({ data: { title: "Synthetic DM", userId } });
    const old = new Date(Date.now() - 3 * 86_400_000);
    const quiet = await conversations.create({ botOpened: false, chatId, discordChannelId: snowflake(), guildId: "1100000000000000001", kind: "thread",
      now: old, parentChannelId: null, userId });
    const dm = await conversations.create({ botOpened: false, chatId: dmChat.id, discordChannelId: snowflake(), guildId: null, kind: "dm", now: old,
      parentChannelId: null, userId });
    const listed = await conversations.listForBackfill({ limit: 500, since: new Date(Date.now() - 86_400_000) });
    expect(listed.map((entry) => entry.id)).toContain(dm.record.id);
    expect(listed.map((entry) => entry.id)).not.toContain(quiet.record.id);
  });

  it("prunes question rows after 90 days with their ratings, and revoked monitoring keys after 30 days", async () => {
    const now = new Date();
    const old = claim({ receivedAt: new Date(now.getTime() - 91 * 86_400_000) });
    const kept = claim({ receivedAt: new Date(now.getTime() - 89 * 86_400_000) });
    await replies.claim(old);
    await replies.claim(kept);
    await prisma.discordAnswerRating.create({ data: { discordUserId: 1_100_000_000_000_000_050n, replyId: BigInt(old.questionMessageId), value: -1 } });
    const revokedOld = await prisma.discordMonitoringKey.create({ data: { keyHash: randomUUID().replaceAll("-", "").padEnd(64, "0"), revokedAt: new Date(now.getTime() - 31 * 86_400_000) } });
    const revokedRecent = await prisma.discordMonitoringKey.create({ data: { keyHash: randomUUID().replaceAll("-", "").padEnd(64, "1"), revokedAt: new Date(now.getTime() - 86_400_000) } });
    const active = await prisma.discordMonitoringKey.create({ data: { keyHash: randomUUID().replaceAll("-", "").padEnd(64, "2") } });
    try {
      expect(await deleteExpiredDiscordRecords(prisma, now)).toBeGreaterThanOrEqual(2);
      expect(await replies.find(old.questionMessageId)).toBeNull();
      expect(await replies.find(kept.questionMessageId)).not.toBeNull();
      expect(await prisma.discordAnswerRating.count({ where: { replyId: BigInt(old.questionMessageId) } })).toBe(0);
      expect((await prisma.discordMonitoringKey.findMany({ where: { id: { in: [revokedOld.id, revokedRecent.id, active.id] } } })).map((key) => key.id).sort())
        .toEqual([revokedRecent.id, active.id].sort());
    } finally {
      await prisma.discordMonitoringKey.deleteMany({ where: { id: { in: [revokedOld.id, revokedRecent.id, active.id] } } });
    }
  });
});
