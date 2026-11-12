import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import { createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo } from "./access";
import {
  createFakeDiscordRunGateway, createMemoryDiscordConversationStore, createMemoryDiscordLimitStore, createMemoryDiscordReplyStore,
  createMemoryDiscordRunFacts, type FakeRunFinish
} from "./bridge/bridge.testFixtures";
import { createDiscordBridge } from "./bridge/index";
import type { DiscordActiveControl, DiscordEffectiveControl } from "./control/state";
import { createDiscordHandlerRegistry, createDiscordIntake } from "./intake";
import {
  createDiscordLifecycle, discordRatedDownComment, DISCORD_QUESTION_DELETED_CODE, type DiscordProblemReports, type DiscordRatingStore
} from "./lifecycle";
import { createDiscordRest } from "./rest";
import type { DiscordReplyRecord } from "./store/replies";

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observability")>();
  return {
    ...actual,
    logEvent: ((event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }) as typeof actual.logEvent
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  logs.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function controlFor(fake: FakeDiscord): DiscordActiveControl {
  return {
    assistantId: "assistant_1",
    bot: { applicationId: fake.application.id, generation: 1, roleId: fake.botRoleId, token: fake.token, userId: fake.bot.id, username: fake.bot.username },
    channelIds: new Set(),
    channelMode: "all_except",
    dmEnabled: true,
    enabled: true,
    enabledAt: new Date("2026-11-12T08:00:00.000Z"),
    guildId: fake.guild.id,
    limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 },
    serviceUserId: "svc_1",
    session: null,
    testAuthorIds: new Set(),
    testChannelIds: new Set(),
    tokenState: "ready",
    version: 3
  };
}

function createMemoryRatings(): DiscordRatingStore & Readonly<{ rows: Map<string, 1 | -1> }> {
  const rows = new Map<string, 1 | -1>();
  return {
    rows,
    async set({ discordUserId, replyId, value }) { rows.set(`${replyId}:${discordUserId}`, value); },
    async remove({ discordUserId, replyId, value }) {
      const key = `${replyId}:${discordUserId}`;
      if (rows.get(key) !== value) return false;
      rows.delete(key);
      return true;
    }
  };
}

function createMemoryReports(runs: ReturnType<typeof createFakeDiscordRunGateway>): DiscordProblemReports & Readonly<{
  filed: Array<{ chatId: string; messageId: string; runId: string; userId: string; comment: string }>;
}> {
  const filed: Array<{ chatId: string; messageId: string; runId: string; userId: string; comment: string }> = [];
  return {
    filed,
    async answerOfRun({ runId, userId }) {
      const run = runs.runs.find((entry) => entry.runId === runId && entry.userId === userId);
      return run ? { assistantMessageId: run.assistantMessageId, chatId: run.chatId } : null;
    },
    async fileOnce(input) {
      if (filed.some((entry) => entry.messageId === input.messageId && entry.userId === input.userId)) return "exists";
      filed.push({ ...input });
      return "created";
    }
  };
}

function harness(finish: ((run: { runId: string }) => FakeRunFinish | null) | null = () => ({ text: "The answer." })) {
  const fake = createFakeDiscord();
  const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
  const now = () => clock.latest + 500;
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const replies = createMemoryDiscordReplyStore();
  const conversations = createMemoryDiscordConversationStore();
  const runs = createFakeDiscordRunGateway({ autoFinish: finish });
  const control: DiscordEffectiveControl = controlFor(fake);
  const registry = createDiscordHandlerRegistry();
  const directory = createDiscordChannelDirectory();
  for (const id of Object.values(fake.channels)) directory.remember(discordChannelInfo(fake.channel(id), fake.guild.id)!);
  const intake = createDiscordIntake({
    control: async () => control,
    directory,
    lookupChannel: async (channelId) => {
      const answer = await rest.getChannel(channelId);
      return answer.ok ? discordChannelInfo(answer.value) : null;
    },
    membership: createDiscordMembership({ now, rest: async () => rest }),
    now,
    registry
  });
  const bridge = createDiscordBridge({
    control: async () => control, conversations, facts: createMemoryDiscordRunFacts(replies), gateway: runs.gateway, lanes: intake.lanes,
    limits: createMemoryDiscordLimitStore(replies), now, replies, rest: () => rest, setupReady: async () => true,
    shares: { create: async () => null },
    timing: { claimGraceMs: 0, followMs: 0, mergeWindowMs: 0, statusIntervalMs: 60_000, typingIntervalMs: 60_000 }
  });
  cleanups.push(bridge.register(registry));
  const ratings = createMemoryRatings();
  const reports = createMemoryReports(runs);
  const stopRun = vi.fn((input: Readonly<{ userId: string; runId: string }>) => runs.gateway.stop(input));
  const lifecycle = createDiscordLifecycle({ now, ratings, replies, reports, rest: () => rest, stopRun });
  // The real registry and the process-wide delivery hub, as production wires them.
  cleanups.push(lifecycle.register(registry));

  async function idle(): Promise<void> {
    await intake.lanes.idle();
    await bridge.idle();
    await intake.lanes.idle();
  }

  async function ask(authorId: string, content: string): Promise<FakeDiscordMessage> {
    const message = fake.postMessage({ authorId, channelId: fake.channels.text, content: `<@${fake.bot.id}> ${content}`, mentions: [fake.bot.id] });
    clock.latest = Math.max(clock.latest, Date.parse(message.timestamp));
    await intake.accept({ data: message, type: "MESSAGE_CREATE" });
    return message;
  }

  async function deleteQuestion(message: FakeDiscordMessage): Promise<void> {
    fake.deleteMessage(message.channel_id, message.id);
    await intake.accept({ data: { channel_id: message.channel_id, guild_id: fake.guild.id, id: message.id }, type: "MESSAGE_DELETE" });
    await idle();
  }

  async function react(userId: string, username: string, channelId: string, messageId: string, emoji: string, action: "add" | "remove") {
    await intake.accept({
      data: {
        channel_id: channelId, emoji: { id: null, name: emoji }, guild_id: fake.guild.id, message_id: messageId, user_id: userId,
        ...(action === "add" ? { member: { nick: null, roles: [], user: { bot: false, global_name: null, id: userId, username } } } : {})
      },
      type: action === "add" ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE"
    });
    await idle();
  }

  const botMessages = (channelId: string) => fake.messages(channelId).filter((message) => message.author.id === fake.bot.id);
  return { ask, botMessages, deleteQuestion, fake, idle, lifecycle, ratings, react, replies, reports, rest, runs, stopRun };
}

function row(h: ReturnType<typeof harness>, id: string): DiscordReplyRecord {
  return h.replies.rows.get(id)!;
}

describe("Discord lifecycle: a deleted question", () => {
  it("stops the run that is still answering it, removes its status and is journaled interrupted", async () => {
    const h = harness(null);
    const alice = h.fake.addUser({ username: "alice" });
    const question = await h.ask(alice, "what is the release status?");
    await vi.waitFor(() => expect(h.botMessages(question.id)).toHaveLength(1));
    expect(row(h, question.id).state).toBe("admitted");

    await h.deleteQuestion(question);

    expect(h.stopRun).toHaveBeenCalledWith({ runId: h.runs.runs[0]!.runId, userId: "svc_1" });
    expect(h.runs.runs[0]!.status).toBe("cancelled");
    await vi.waitFor(async () => {
      await h.idle();
      expect(h.botMessages(question.id)).toEqual([]);
    });
    expect(row(h, question.id)).toMatchObject({ code: DISCORD_QUESTION_DELETED_CODE, state: "interrupted" });
    // The bridge delivers nothing to a deleted question: no "Stopped", no new message.
    expect(h.fake.calls({ route: "create_message" })).toHaveLength(1);
    expect(logs.filter((entry) => entry.event === "discord_request" && entry.fields.stage === "interrupted")
      .map((entry) => entry.fields)).toEqual([expect.objectContaining({ code: DISCORD_QUESTION_DELETED_CODE, message_id: question.id })]);
  });

  it("removes the delivered answer and keeps the journal's outcome; AIQSA's chat is not touched", async () => {
    const h = harness();
    const alice = h.fake.addUser({ username: "alice" });
    const question = await h.ask(alice, "what is the release status?");
    await vi.waitFor(async () => {
      await h.idle();
      expect(row(h, question.id).state).toBe("delivered");
    });
    const [answer] = h.botMessages(question.id);
    expect(answer!.content).toBe("The answer.");

    await h.deleteQuestion(question);

    expect(h.botMessages(question.id)).toEqual([]);
    expect(h.stopRun).not.toHaveBeenCalled();
    expect(row(h, question.id)).toMatchObject({ answerMessageId: answer!.id, state: "delivered" });
    expect(h.runs.chats.size).toBe(1);
  });

  it("deletes an answer that reached Discord after its question was deleted", async () => {
    const h = harness(null);
    const alice = h.fake.addUser({ username: "alice" });
    const question = await h.ask(alice, "and the dates?");
    await vi.waitFor(() => expect(h.botMessages(question.id)).toHaveLength(1));
    const run = h.runs.runs[0]!;
    // The race: the question is gone, but an answer went out before the bridge saw it.
    await h.replies.update(question.id, { code: DISCORD_QUESTION_DELETED_CODE, state: "interrupted" });
    const late = await h.rest.createMessage(question.id, { content: "Late answer" });
    if (!late.ok) throw new Error("create");
    await h.lifecycle.onRunEvent({ answerMessageId: late.value.id, sent: true, status: "complete", type: "delivered" }, {
      answerChannelId: question.id, chatId: run.chatId, discordUserId: alice, guildId: h.fake.guild.id, questionChannelId: question.channel_id,
      questionMessageId: question.id, runId: run.runId, source: "live", test: false, userId: "svc_1"
    });
    expect(h.botMessages(question.id).map((message) => message.id)).not.toContain(late.value.id);
  });

  it("leaves the run alone when the deleted message was a follow-up of another question", async () => {
    const replies = createMemoryDiscordReplyStore();
    await replies.claim({
      authorName: "bob", channelId: "1100000000000000010", discordUserId: "1100000000000000020", guildId: "1100000000000000001",
      kind: "follow_up", questionMessageId: "1100000000000000030", receivedAt: new Date(), test: false
    });
    await replies.update("1100000000000000030", { runId: "run-1", state: "admitted" });
    const stopRun = vi.fn(async () => "stopped" as const);
    const deleteMessage = vi.fn();
    const lifecycle = createDiscordLifecycle({
      ratings: createMemoryRatings(), replies, reports: createMemoryReports(createFakeDiscordRunGateway()),
      rest: () => ({ deleteMessage }) as unknown as ReturnType<typeof createDiscordRest>, stopRun
    });
    const fake = createFakeDiscord();
    await lifecycle.handleDelete({
      channelId: "1100000000000000010", control: controlFor(fake), guildId: "1100000000000000001", messageIds: ["1100000000000000030", "1100000000000000099"],
      receivedAt: new Date()
    });
    expect(stopRun).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(replies.rows.get("1100000000000000030")).toMatchObject({ code: DISCORD_QUESTION_DELETED_CODE, state: "interrupted" });
  });
});

describe("Discord lifecycle: ratings", () => {
  it("records 👍/👎 per person, removes them with the reaction and files one problem report on the first 👎", async () => {
    const h = harness();
    const alice = h.fake.addUser({ username: "alice" });
    const bob = h.fake.addUser({ username: "bob" });
    const carol = h.fake.addUser({ username: "carol" });
    const question = await h.ask(alice, "what is the release status?");
    await vi.waitFor(async () => {
      await h.idle();
      expect(row(h, question.id).state).toBe("delivered");
    });
    const answerId = row(h, question.id).answerMessageId!;
    const thread = question.id;

    await h.react(alice, "Rating Sentinel Alice", thread, answerId, "👍", "add");
    await h.react(bob, "Rating Sentinel Bob", thread, answerId, "👎", "add");
    expect([...h.ratings.rows]).toEqual([[`${question.id}:${alice}`, 1], [`${question.id}:${bob}`, -1]]);
    const run = h.runs.runs[0]!;
    expect(h.reports.filed).toEqual([{
      chatId: run.chatId, comment: "Discord: rated 👎 by Rating Sentinel Bob", messageId: run.assistantMessageId, runId: run.runId, userId: "svc_1"
    }]);

    // A removal of the other emoji keeps the rating; removing the given one drops it; a second 👎 files nothing more.
    await h.react(bob, "Rating Sentinel Bob", thread, answerId, "👍", "remove");
    expect(h.ratings.rows.get(`${question.id}:${bob}`)).toBe(-1);
    await h.react(bob, "Rating Sentinel Bob", thread, answerId, "👎", "remove");
    expect(h.ratings.rows.has(`${question.id}:${bob}`)).toBe(false);
    await h.react(bob, "Rating Sentinel Bob", thread, answerId, "👎", "add");
    await h.react(carol, "Rating Sentinel Carol", thread, answerId, "👎", "add");
    expect(h.reports.filed).toHaveLength(1);

    // Other emoji, the question itself and the bot's own reactions are no ratings.
    await h.react(alice, "Rating Sentinel Alice", thread, answerId, "🎉", "add");
    await h.react(alice, "Rating Sentinel Alice", h.fake.channels.text, question.id, "👎", "add");
    await h.react(h.fake.bot.id, "aiqsa-test", thread, answerId, "👍", "add");
    expect(h.ratings.rows.size).toBe(3);

    const ratingLogs = logs.filter((entry) => entry.event === "discord_rating").map((entry) => entry.fields);
    expect(ratingLogs.map((fields) => `${String(fields.outcome)}:${String(fields.value)}`))
      .toEqual(["added:up", "added:down", "removed:down", "added:down", "added:down"]);
    expect(ratingLogs[0]).toMatchObject({ author_id: alice, channel_id: thread, chat_id: run.chatId, message_id: answerId, run_id: run.runId });
    expect(JSON.stringify(logs)).not.toContain("Rating Sentinel");
  });

  it("names the rater, or their id, and marks test-mode ratings", () => {
    expect(discordRatedDownComment({ discordUserId: "1100000000000000020", displayName: "Alex", test: false })).toBe("Discord: rated 👎 by Alex");
    expect(discordRatedDownComment({ discordUserId: "1100000000000000020", displayName: "  ", test: true }))
      .toBe("Discord (test): rated 👎 by discord:1100000000000000020");
    expect(discordRatedDownComment({ discordUserId: "1100000000000000020", displayName: "A\u0007lex\u202e", test: false })).toBe("Discord: rated 👎 by Alex");
  });
});
