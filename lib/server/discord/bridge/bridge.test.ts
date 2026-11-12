import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeDiscord, FAKE_DISCORD_CHANNEL_TYPES, type FakeDiscord, type FakeDiscordMessage, type FakeDiscordReply
} from "@/tests/support/fakeDiscord";
import { createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo } from "../access";
import type { DiscordEffectiveControl } from "../control/state";
import { DISCORD_BRIDGE_COPY, DISCORD_COPY } from "../copy";
import { createDiscordHandlerRegistry, createDiscordIntake, createDiscordLanes, type DiscordIntake, type DiscordLanes } from "../intake";
import { createDiscordRest } from "../rest";
import type { DiscordConversationStore } from "../store/conversations";
import {
  createFakeDiscordRunGateway, createMemoryDiscordConversationStore, createMemoryDiscordLimitStore, createMemoryDiscordReplyStore,
  createMemoryDiscordRunFacts, type FakeRunFinish
} from "./bridge.testFixtures";
import { discordAttachmentNamesOnly, type DiscordAttachmentHook } from "./context";
import { createDiscordBridge, discordSendBody, type DiscordBridgeTiming } from "./index";
import type { DiscordRunEvent, DiscordRunEventContext } from "./events";

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("../../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../observability")>();
  return {
    ...actual,
    logEvent: ((event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }) as typeof actual.logEvent
  };
});

afterEach(() => {
  logs.length = 0;
});

const SHARE_URL = "https://aiqsa.example.com/s/synthetic-share-token";

function controlFor(fake: FakeDiscord, overrides: Partial<DiscordEffectiveControl> = {}): DiscordEffectiveControl {
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
    version: 3,
    ...overrides
  };
}

type HarnessOptions = Readonly<{
  control?: Partial<DiscordEffectiveControl>;
  finish?: ((run: { runId: string }) => FakeRunFinish | null) | null;
  silent?: boolean;
  timing?: Partial<DiscordBridgeTiming>;
  setupReady?: boolean;
  fake?: FakeDiscord;
  stores?: Stores;
  runs?: ReturnType<typeof createFakeDiscordRunGateway>;
  /** Shared by harnesses that stand for one process and the next. */
  clock?: { latest: number };
  /** The conversation row cannot be written (its link to the chat is missing). */
  conversationWriteFails?: boolean;
  attachments?: DiscordAttachmentHook;
  newChatId?: () => string;
}>;

type Stores = Readonly<{
  replies: ReturnType<typeof createMemoryDiscordReplyStore>;
  conversations: ReturnType<typeof createMemoryDiscordConversationStore>;
}>;

function harness(options: HarnessOptions = {}) {
  const fake = options.fake ?? createFakeDiscord();
  const clock = options.clock ?? { latest: Date.parse("2026-11-12T09:00:00.000Z") };
  const now = () => clock.latest + 500;
  let sending = true;
  const rest = createDiscordRest({ authorize: () => sending, token: () => fake.token, transport: fake.transport });
  const replies = options.stores?.replies ?? createMemoryDiscordReplyStore();
  const conversations = options.stores?.conversations ?? createMemoryDiscordConversationStore();
  const limits = createMemoryDiscordLimitStore(replies);
  const runs = options.runs ?? createFakeDiscordRunGateway({
    autoFinish: options.finish === undefined ? () => ({ text: "The answer." }) : options.finish, silent: options.silent
  });
  const facts = createMemoryDiscordRunFacts(replies);
  const conversationStore: DiscordConversationStore = options.conversationWriteFails
    ? { ...conversations, create: async () => { throw new Error("synthetic write failure"); } }
    : conversations;
  const shares = { create: vi.fn(async (_input: Readonly<{ userId: string; chatId: string; assistantMessageId: string }>) => SHARE_URL) };
  const published: Array<{ event: DiscordRunEvent; context: DiscordRunEventContext }> = [];
  let control = controlFor(fake, options.control);
  const registry = createDiscordHandlerRegistry();
  const directory = createDiscordChannelDirectory();
  for (const id of Object.values(fake.channels)) directory.remember(discordChannelInfo(fake.channel(id), fake.guild.id)!);
  const makeIntake = (lanes?: DiscordLanes): DiscordIntake => createDiscordIntake({
    control: async () => control,
    directory,
    lookupChannel: async (channelId) => {
      const answer = await rest.getChannel(channelId);
      return answer.ok ? discordChannelInfo(answer.value) : null;
    },
    membership: createDiscordMembership({ now, rest: async () => rest }),
    now,
    registry,
    ...(lanes ? { lanes } : {})
  });
  const intake = makeIntake();
  const bridge = createDiscordBridge({
    control: async () => control, conversations: conversationStore, facts, gateway: runs.gateway, lanes: intake.lanes, limits,
    newChatId: options.newChatId ?? (() => {
      let next = 0;
      return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    })(),
    now, publish: async (event, context) => { published.push({ context, event }); }, replies, rest: () => rest,
    setupReady: async () => options.setupReady ?? true, shares, ...(options.attachments ? { attachments: options.attachments } : {}),
    timing: { claimGraceMs: 0, followMs: 0, mergeWindowMs: 0, statusIntervalMs: 60_000, typingIntervalMs: 60_000, ...options.timing }
  });
  bridge.register(registry);

  function post(input: Parameters<FakeDiscord["postMessage"]>[0]): FakeDiscordMessage {
    const message = fake.postMessage(input);
    clock.latest = Math.max(clock.latest, Date.parse(message.timestamp));
    return message;
  }

  /** Waits until intake and the bridge are idle and every question whose run settled has its ending. */
  async function settle(target: DiscordIntake = intake): Promise<void> {
    await vi.waitFor(async () => {
      await target.lanes.idle();
      await bridge.idle();
      const pending = [...replies.rows.values()].filter((row) => row.state === "claimed" ||
        (row.state === "admitted" && runs.runs.find((run) => run.runId === row.runId)?.status !== "streaming"));
      expect(pending.map((row) => row.questionMessageId)).toEqual([]);
    });
    await bridge.idle();
  }

  async function say(input: Parameters<FakeDiscord["postMessage"]>[0], target: DiscordIntake = intake): Promise<FakeDiscordMessage> {
    const message = post(input);
    await target.accept({ data: message, type: "MESSAGE_CREATE" });
    return message;
  }

  const user = (username: string) => fake.addUser({ username });
  return {
    bridge, conversations, control: () => control, facts, fake, intake, makeIntake, now, post, published, replies, rest, runs, say, settle, shares,
    setControl: (next: Partial<DiscordEffectiveControl>) => { control = controlFor(fake, { ...options.control, ...next }); },
    /** The kill switch as the REST client sees it. */
    setSending: (value: boolean) => { sending = value; },
    /** Time goes on (a later sweep). */
    advance: (ms: number) => { clock.latest += ms; },
    user
  };
}

type Harness = ReturnType<typeof harness>;

function mention(h: Harness, authorId: string, content: string, channelId = h.fake.channels.text) {
  return { authorId, channelId, content: `<@${h.fake.bot.id}> ${content}`, mentions: [h.fake.bot.id] };
}

function botMessages(h: Harness, channelId: string): FakeDiscordMessage[] {
  return h.fake.messages(channelId).filter((message) => message.author.id === h.fake.bot.id);
}

function sentText(body: Record<string, unknown>): string {
  const blocks = (body.content as { blocks: Array<{ type: string; text?: string }> }).blocks;
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function stages(messageId: string): string[] {
  return logs.filter((entry) => entry.event === "discord_request" && entry.fields.message_id === messageId).map((entry) => String(entry.fields.stage));
}

describe("Discord bridge: a mention becomes a run and its answer", () => {
  it("opens a thread from a channel mention, edits the status into the answer, reacts ✅ and writes the journal", async () => {
    const h = harness();
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "what is the release status?"));
    await h.settle();

    const thread = h.fake.channel(question.id)!;
    expect(thread).toMatchObject({ parent_id: h.fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread, name: "what is the release status?" });
    const [run] = h.runs.runs;
    expect(run!.body).toEqual(discordSendBody({
      admissionId: `dc-${question.id}`, blocks: [{ text: sentText(run!.body), type: "text" }], expectedActiveLeafId: null, newChatAssistantId: "assistant_1"
    }));
    expect(run!.body).toMatchObject({ personalDraft: { folderId: null, memoryMode: "EXCLUDED" }, timeZone: "UTC", workspace: { enabled: false } });
    expect(sentText(run!.body)).toContain(`Discord thread "what is the release status?" in #agent-test, server "Example server".`);
    expect(sentText(run!.body)).toContain(`Question from alice (discord:${alice}):\n@${h.fake.bot.username} what is the release status?`);

    const answers = botMessages(h, thread.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toBe("The answer.");
    expect(h.fake.reactions(question.id, "✅")).toEqual([h.fake.bot.id]);
    expect(h.fake.reactions(question.id, "👀")).toEqual([]);
    expect(h.fake.violations()).toEqual([]);
    for (const call of [...h.fake.calls({ route: "create_message" }), ...h.fake.calls({ route: "edit_message" })]) {
      expect(call.json).toMatchObject({ allowed_mentions: { parse: [] }, flags: 4 });
    }
    expect(h.fake.calls({ route: "create_message" })[0]!.json).toMatchObject({ enforce_nonce: true, nonce: expect.stringMatching(/^aiqsa[a-z0-9]+s$/u) });

    const row = h.replies.rows.get(question.id)!;
    expect(row).toMatchObject({
      answerMessageId: answers[0]!.id, kind: "answer", runId: run!.runId, sources: 0, state: "delivered", statusMessageId: answers[0]!.id
    });
    for (const field of ["ackAt", "admittedAt", "firstStatusAt", "deliveredAt"] as const) expect(row[field], field).toBeInstanceOf(Date);
    const conversation = await h.conversations.findByChannel(thread.id);
    expect(conversation).toMatchObject({ botOpened: true, chatId: run!.chatId, kind: "thread", lastIncludedMessageId: question.id, parentChannelId: h.fake.channels.text });
    expect(row.conversationId).toBe(conversation!.id);
    expect(stages(question.id)).toEqual(["received", "acked", "admitted", "first_status", "delivered"]);
    expect(logs.find((entry) => entry.event === "discord_run_summary")?.fields).toMatchObject({ message_id: question.id, not_found: true, sources: 0 });
    expect(h.published.map((entry) => entry.event.type)).toContain("delivered");
  });

  it("answers people in its own thread without a mention, stays out of their talk and reads it as context", async () => {
    const h = harness();
    const [alice, bob, carol] = [h.user("alice"), h.user("bob"), h.user("carol")];
    const first = await h.say(mention(h, alice, "plan the launch"));
    await h.settle();
    const threadId = first.id;
    // People talking to each other: a mention of someone else, a Reply to someone else.
    const toCarol = await h.say({ authorId: bob, channelId: threadId, content: `<@${carol}> take a look`, mentions: [carol] });
    await h.say({ authorId: alice, channelId: threadId, content: "Sure, the dates are fine", replyTo: toCarol.id });
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    const asked = await h.say({ authorId: carol, channelId: threadId, content: "and the deadlines?" });
    await h.settle();

    expect(h.runs.runs).toHaveLength(2);
    const second = h.runs.runs[1]!;
    expect(second.chatId).toBe(h.runs.runs[0]!.chatId);
    expect(second.body).toMatchObject({ expectedActiveLeafId: h.runs.runs[0]!.assistantMessageId });
    expect(second.body).not.toHaveProperty("personalDraft");
    const text = sentText(second.body);
    expect(text).toContain("Messages since your last reply:");
    expect(text).toContain(`bob (discord:${bob}): @carol take a look`);
    expect(text).not.toContain("The answer.");
    expect(text.indexOf("Sure, the dates are fine")).toBeLessThan(text.indexOf(`Question from carol (discord:${carol}):`));
    expect(h.fake.reactions(asked.id, "✅")).toEqual([h.fake.bot.id]);
    expect(logs.filter((entry) => entry.event === "discord_intake" && entry.fields.reason === "no_trigger")).toHaveLength(2);
  });

  it("imports a whole existing thread of 300 messages, its starter message from the parent channel included", async () => {
    const h = harness();
    const alice = h.user("alice");
    const starter = h.post({ authorId: alice, channelId: h.fake.channels.text, content: "Starter of the release thread" });
    const opened = await h.rest.startThreadFromMessage(h.fake.channels.text, starter.id, { name: "release" });
    if (!opened.ok) throw new Error("thread");
    for (let index = 1; index <= 300; index += 1) h.post({ authorId: alice, channelId: opened.value.id, content: `note ${index}` });
    const question = await h.say(mention(h, alice, "sum it up", opened.value.id));
    await h.settle();

    const text = sentText(h.runs.runs[0]!.body);
    expect(text).toContain(`Discord thread "release" in #agent-test`);
    expect(text).toContain("Earlier messages:");
    const order = ["Starter of the release thread", ": note 1\n", ": note 150\n", ": note 300\n", "Question from alice"].map((part) => text.indexOf(part));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(botMessages(h, opened.value.id)).toHaveLength(1);
    expect(h.fake.messages(opened.value.id).find((message) => message.id === question.id)).toBeDefined();
    expect(await h.conversations.findByChannel(opened.value.id)).toMatchObject({ botOpened: false, kind: "thread" });
  });

  it("imports a forum post whole, its starter inside the post", async () => {
    const h = harness();
    const alice = h.user("alice");
    const post = h.fake.createForumPost({ authorId: alice, content: "How do I rotate the key?", forumId: h.fake.channels.forum, name: "Key rotation" });
    h.post({ authorId: alice, channelId: post.threadId, content: "Tried the admin page already" });
    await h.say(mention(h, alice, "any idea?", post.threadId));
    await h.settle();
    const text = sentText(h.runs.runs[0]!.body);
    expect(text).toContain(`Discord forum post "Key rotation" in #questions`);
    expect(text.match(/How do I rotate the key\?/gu)).toHaveLength(1);
    expect(text).toContain("Tried the admin page already");
    expect(await h.conversations.findByChannel(post.threadId)).toMatchObject({ kind: "forum_post" });
  });

  it("answers in place in a voice-channel chat and continues the same chat there", async () => {
    const h = harness();
    const alice = h.user("alice");
    const first = await h.say(mention(h, alice, "first question", h.fake.channels.voice));
    await h.settle();
    const second = await h.say(mention(h, alice, "second question", h.fake.channels.voice));
    await h.settle();
    const answers = botMessages(h, h.fake.channels.voice);
    expect(answers.map((message) => message.message_reference?.message_id)).toEqual([first.id, second.id]);
    expect(h.runs.runs).toHaveLength(2);
    expect(h.runs.runs[1]!.chatId).toBe(h.runs.runs[0]!.chatId);
    expect(sentText(h.runs.runs[0]!.body)).toContain("Discord voice channel chat #voice-room");
    expect(await h.conversations.findByChannel(h.fake.channels.voice)).toMatchObject({ botOpened: false, kind: "voice_chat" });
    expect(h.fake.calls({ route: "start_thread_from_message" })).toHaveLength(0);
  });

  it("answers a direct message in the same channel, one chat for the conversation", async () => {
    const h = harness();
    const alice = h.user("alice");
    const dm = h.fake.openDm(alice);
    await h.say({ authorId: alice, channelId: dm, content: "hello there" });
    await h.settle();
    await h.say({ authorId: alice, channelId: dm, content: "and again" });
    await h.settle();
    expect(botMessages(h, dm)).toHaveLength(2);
    expect(h.runs.runs[1]!.chatId).toBe(h.runs.runs[0]!.chatId);
    expect(sentText(h.runs.runs[0]!.body)).toContain(`Discord direct message with alice (discord:${alice}).`);
    // The first question is the chat's already: the next turn reads only what came after it.
    expect(sentText(h.runs.runs[1]!.body)).not.toContain("hello there");
    expect(sentText(h.runs.runs[1]!.body)).toContain("and again");
    expect(await h.conversations.findByChannel(dm)).toMatchObject({ guildId: null, kind: "dm" });
  });

  it("answers a Reply to another service's post by the same bot, the post in context marked (bot)", async () => {
    const h = harness();
    const alice = h.user("alice");
    const card = h.post({ authorId: h.fake.bot.id, channelId: h.fake.channels.text, content: "Daily card: item 3 is blocked" });
    const reply = await h.say({ authorId: alice, channelId: h.fake.channels.text, content: "what was decided on item 3?", replyTo: card.id });
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    const text = sentText(h.runs.runs[0]!.body);
    expect(text).toContain(`Replying to ${h.fake.bot.global_name} (discord:${h.fake.bot.id}) (bot), message ${card.id}:\nDaily card: item 3 is blocked`);
    expect(text).toContain(`(discord:${h.fake.bot.id}) (bot): Daily card`);
    expect(botMessages(h, reply.id)).toHaveLength(1);
  });

  it("refuses visibly while setup is incomplete", async () => {
    const h = harness({ setupReady: false });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "hi"));
    await h.settle();
    expect(h.runs.runs).toHaveLength(0);
    expect(botMessages(h, h.fake.channels.text).map((message) => message.content)).toEqual([`❌ ${DISCORD_COPY.notSetUp}`]);
    expect(h.fake.reactions(question.id, "❌")).toEqual([h.fake.bot.id]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_setup_incomplete", kind: "refused", state: "failed" });
  });
});

describe("Discord bridge: follow-ups, order and parallel threads", () => {
  it("adds a question asked during a run to it (👀 then ✅ on both) and keeps one thread's questions in order", async () => {
    const h = harness({ finish: null });
    const [alice, bob] = [h.user("alice"), h.user("bob")];
    const first = await h.say(mention(h, alice, "start the report"));
    await h.settle();
    const [run] = h.runs.runs;
    const second = await h.say({ authorId: bob, channelId: first.id, content: "include Y" });
    const third = await h.say({ authorId: alice, channelId: first.id, content: "and Z" });
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    expect(run!.followups.map((entry) => entry.nonce)).toEqual([`dc-${second.id}`, `dc-${third.id}`]);
    expect(run!.followups[0]!.text).toContain(`Question from bob (discord:${bob}):\ninclude Y`);
    expect(run!.followups[1]!.text).not.toContain("include Y");
    expect(h.fake.reactions(second.id, "👀")).toEqual([h.fake.bot.id]);
    run!.finish({ text: "Report with Y and Z." });
    await h.settle();
    for (const id of [first.id, second.id, third.id]) expect(h.fake.reactions(id, "✅"), id).toEqual([h.fake.bot.id]);
    expect(h.replies.rows.get(second.id)).toMatchObject({ kind: "follow_up", runId: run!.runId, state: "delivered" });
    expect(botMessages(h, first.id)).toHaveLength(1);
  });

  it("runs two threads side by side", async () => {
    const h = harness({ finish: null });
    const [alice, bob] = [h.user("alice"), h.user("bob")];
    await h.say(mention(h, alice, "first topic"));
    await h.say(mention(h, bob, "second topic"));
    await h.settle();
    expect(h.runs.runs).toHaveLength(2);
    expect(h.runs.runs.every((run) => run.status === "streaming")).toBe(true);
    expect(new Set(h.runs.runs.map((run) => run.chatId)).size).toBe(2);
    for (const run of h.runs.runs) run.finish({ text: `Answer for ${run.runId}` });
    await h.settle();
    expect(h.replies.rows.size).toBe(2);
    expect([...h.replies.rows.values()].every((row) => row.state === "delivered")).toBe(true);
  });

  it("makes a question the run no longer takes the next turn once its answer is out", async () => {
    const h = harness({ finish: null });
    const alice = h.user("alice");
    const first = await h.say(mention(h, alice, "first"));
    await h.settle();
    h.runs.runs[0]!.status = "complete";
    const later = h.say({ authorId: alice, channelId: first.id, content: "next please" });
    await vi.waitFor(() => expect(h.runs.runs).toHaveLength(1));
    h.runs.runs[0]!.status = "streaming";
    h.runs.runs[0]!.finish({ text: "First answer." });
    await later;
    await h.settle();
    expect(h.runs.runs).toHaveLength(2);
    expect(h.runs.runs[1]!.chatId).toBe(h.runs.runs[0]!.chatId);
  });
});

describe("Discord bridge: limits", () => {
  it("refuses an author over the hourly limit with one short notice an hour, then ❌ only", async () => {
    const h = harness({ control: { limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 1, perThreadHourly: 60 } } });
    const alice = h.user("alice");
    await h.say(mention(h, alice, "one"));
    await h.settle();
    const second = await h.say(mention(h, alice, "two"));
    await h.settle();
    const third = await h.say(mention(h, alice, "three"));
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    const notices = botMessages(h, h.fake.channels.text);
    expect(notices.map((message) => message.content)).toEqual([expect.stringMatching(/^❌ You've reached the limit of 1 questions per hour\. Try again in \d+ min\.$/u)]);
    expect(h.fake.reactions(second.id, "❌")).toEqual([h.fake.bot.id]);
    expect(h.fake.reactions(third.id, "❌")).toEqual([h.fake.bot.id]);
    expect(h.replies.rows.get(third.id)).toMatchObject({ code: "discord_user_limit", kind: "refused", limitKind: "author", statusMessageId: null });
    expect(logs.find((entry) => entry.event === "discord_request" && entry.fields.stage === "limited")?.fields).toMatchObject({ limit_kind: "author" });
  });

  it("refuses a thread over its hourly limit", async () => {
    const h = harness({ control: { limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 1 } } });
    const [alice, bob] = [h.user("alice"), h.user("bob")];
    const first = await h.say(mention(h, alice, "one"));
    await h.settle();
    await h.say({ authorId: bob, channelId: first.id, content: "two" });
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    expect(botMessages(h, first.id).map((message) => message.content).at(-1)).toMatch(/^❌ This thread has reached its limit of 1 questions per hour\./u);
  });

  it("never holds a test author's questions by the author or thread limits, nor counts them toward people's", async () => {
    const fake = createFakeDiscord();
    const tester = fake.addUser({ bot: true, username: "e2e-bot" });
    const h = harness({
      control: {
        limits: { parallelThreads: 16, perAuthorDaily: 1, perAuthorHourly: 1, perThreadHourly: 1 },
        testAuthorIds: new Set([tester]), testChannelIds: new Set([fake.channels.text])
      },
      fake
    });
    const first = await h.say(mention(h, tester, "one"));
    await h.settle();
    const second = await h.say(mention(h, tester, "two", first.id));
    await h.settle();
    const third = await h.say(mention(h, tester, "three", first.id));
    await h.settle();
    expect(h.runs.runs).toHaveLength(3);
    for (const question of [first, second, third]) {
      expect(h.replies.rows.get(question.id)).toMatchObject({ kind: "answer", state: "delivered", test: true });
    }
    // People in the same thread start from zero: the test questions count toward neither the thread nor anyone's limit.
    const [alice, bob] = [h.user("alice"), h.user("bob")];
    const fourth = await h.say({ authorId: alice, channelId: first.id, content: "four" });
    await h.settle();
    expect(h.runs.runs).toHaveLength(4);
    expect(h.replies.rows.get(fourth.id)).toMatchObject({ kind: "answer", test: false });
    // The thread's limit still holds people: Alice's question filled it.
    const fifth = await h.say({ authorId: bob, channelId: first.id, content: "five" });
    await h.settle();
    expect(h.runs.runs).toHaveLength(4);
    expect(h.replies.rows.get(fifth.id)).toMatchObject({ code: "discord_thread_limit", kind: "refused", limitKind: "thread", test: false });
    // And a test question after it is still answered.
    const sixth = await h.say(mention(h, tester, "six", first.id));
    await h.settle();
    expect(h.runs.runs).toHaveLength(5);
    expect(h.replies.rows.get(sixth.id)).toMatchObject({ kind: "answer", state: "delivered", test: true });
  });
});

describe("Discord bridge: answers", () => {
  it("cuts a long answer, links a share of its chat with an Open in AIQSA button and pings nobody", async () => {
    const paragraph = (index: number) => `Paragraph ${index}: ${"detail ".repeat(40)}`;
    const h = harness({ finish: () => ({ text: Array.from({ length: 12 }, (_, index) => paragraph(index)).join("\n\n") }) });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "explain everything"));
    await h.settle();
    const [answer] = botMessages(h, question.id);
    expect(answer!.content.length).toBeLessThanOrEqual(2_000);
    expect(answer!.content.endsWith("…")).toBe(true);
    expect(answer!.components).toEqual([{ components: [{ label: "Open in AIQSA", style: 5, type: 2, url: SHARE_URL }], type: 1 }]);
    const run = h.runs.runs[0]!;
    expect(h.shares.create).toHaveBeenCalledExactlyOnceWith({ assistantMessageId: run.assistantMessageId, chatId: run.chatId, userId: "svc_1" });
  });

  it("never lets model text mention anyone or leak a recognized secret", async () => {
    const h = harness({
      finish: () => ({ text: "Hi <@1100000000000000999> and <@&1100000000000000998> @everyone, DB_PASSWORD=hunter2-hunter2-hunter2 ok" })
    });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "tell me"));
    await h.settle();
    const [answer] = botMessages(h, question.id);
    expect(answer!.content).not.toMatch(/<@|<#|@everyone|@here/u);
    expect(answer!.content).not.toContain("hunter2");
    expect(answer!.content).toContain("DB\\_PASSWORD=\\[redacted\\]");
    expect(h.fake.violations()).toEqual([]);
    expect(logs.find((entry) => entry.event === "discord_request" && entry.fields.stage === "delivered")?.fields.redactions).toBeGreaterThanOrEqual(1);
  });

  it("shows activities in the status and records a foreground sub-agent and MCP totals", async () => {
    const h = harness({ finish: null, timing: { statusIntervalMs: 10 } });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "investigate"));
    await h.settle();
    const run = h.runs.runs[0]!;
    run.emit({ data: { artifactType: "tool_call", payload: { name: "call_subagent", origin: "session", serverName: "Sub-agents", status: "requested" } }, type: "artifact" });
    await vi.waitFor(() => expect(h.fake.calls({ route: "edit_message" }).some((call) =>
      String((call.json as { content?: string }).content).includes(DISCORD_BRIDGE_COPY.activitySubagent))).toBe(true));
    run.emit({ data: { artifactType: "tool_call", payload: { name: "search_issues", origin: "mcp", serverName: "Tracker", status: "requested" } }, type: "artifact" });
    await vi.waitFor(() => expect(h.fake.calls({ route: "edit_message" }).some((call) =>
      String((call.json as { content?: string }).content).includes("Using Tracker"))).toBe(true));
    h.facts.summaries.set(run.runId, { compactions: 1, errorCode: null, mcpByServer: { mcp_tracker: { calls: 2, errors: 1 } }, subagents: 1 });
    run.finish({ citations: [{ index: 1, title: "Source", url: "https://example.com/a" }], text: "Found it [1]." });
    await h.settle();
    expect(botMessages(h, question.id)[0]!.content).toBe("Found it [1](<https://example.com/a>).");
    expect(h.replies.rows.get(question.id)).toMatchObject({ compactions: 1, mcpByServer: { mcp_tracker: { calls: 2, errors: 1 } }, sources: 1, subagents: 1 });
    expect(logs.filter((entry) => entry.event === "discord_run_summary").map((entry) => entry.fields)).toEqual([
      expect.objectContaining({ mcp_calls: 2, mcp_errors: 1, mcp_server: "mcp_tracker" }),
      expect.objectContaining({ compactions: 1, not_found: false, sources: 1, subagents: 1 })
    ]);
  });

  it("names the Discord model key's limit when the provider refused the run with it", async () => {
    const h = harness({ finish: () => ({ code: "provider_rate_limited", status: "error" }) });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "anything"));
    await h.settle();
    expect(botMessages(h, question.id)[0]!.content).toBe(`❌ ${DISCORD_COPY.keyLimit}`);
    expect(h.fake.reactions(question.id, "❌")).toEqual([h.fake.bot.id]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_key_limit", failureKind: "run", limitKind: "key", state: "failed" });
    expect(stages(question.id)).toContain("limited");
    expect(logs.find((entry) => entry.event === "discord_request" && entry.fields.stage === "limited")?.fields).toMatchObject({ limit_kind: "key" });
  });

  it("edits the status to Stopped for a stopped run", async () => {
    const h = harness({ finish: () => ({ status: "cancelled" }) });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "anything"));
    await h.settle();
    expect(botMessages(h, question.id)[0]!.content).toBe(DISCORD_COPY.stopped);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_stopped", state: "interrupted" });
  });
});

describe("Discord bridge: one answer per question, across replays and restarts", () => {
  it("answers once when a replayed dispatch reaches a new intake after RESUME", async () => {
    const h = harness();
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "once"));
    await h.settle();
    const restarted = h.makeIntake();
    await restarted.accept({ data: question, type: "MESSAGE_CREATE" });
    await h.settle(restarted);
    expect(h.runs.runs).toHaveLength(1);
    expect(botMessages(h, question.id)).toHaveLength(1);
    expect(logs.filter((entry) => entry.event === "discord_intake" && entry.fields.outcome === "duplicate")).toHaveLength(1);
  });

  it("delivers a run a restart interrupted once, from the next process's recovery", async () => {
    const fake = createFakeDiscord();
    const stores = { conversations: createMemoryDiscordConversationStore(), replies: createMemoryDiscordReplyStore() };
    const runs = createFakeDiscordRunGateway({ silent: true });
    const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
    const before = harness({ clock, fake, runs, stores });
    const alice = before.user("alice");
    const question = await before.say(mention(before, alice, "long job"));
    await before.settle();
    expect(stores.replies.rows.get(question.id)).toMatchObject({ state: "admitted" });
    runs.runs[0]!.finish({ text: "Done after restart." });

    // The next process started after the run was admitted.
    clock.latest += 5_000;
    const after = harness({ clock, fake, runs, stores });
    await after.bridge.recover(new Date(after.now()));
    await after.bridge.recover(new Date(after.now()));
    await before.bridge.recover(new Date(before.now()));
    const answers = botMessages(after, question.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toBe("Done after restart.");
    expect(stores.replies.rows.get(question.id)).toMatchObject({ answerMessageId: answers[0]!.id, state: "delivered" });
    expect(fake.reactions(question.id, "✅")).toEqual([fake.bot.id]);
  });

  it("asks a claimed question with no run again once, from recovery", async () => {
    const fake = createFakeDiscord();
    const stores = { conversations: createMemoryDiscordConversationStore(), replies: createMemoryDiscordReplyStore() };
    const h = harness({ fake, stores });
    const alice = h.user("alice");
    const question = h.post(mention(h, alice, "lost in a restart"));
    await stores.replies.claim({
      authorName: "alice", channelId: question.channel_id, discordUserId: alice, guildId: fake.guild.id, kind: "refused",
      questionMessageId: question.id, receivedAt: new Date(h.now() - 60_000), test: false
    });
    await h.bridge.recover(new Date(h.now()));
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    expect(stores.replies.rows.get(question.id)).toMatchObject({ kind: "answer", state: "delivered" });
    await h.bridge.recover(new Date(h.now()));
    expect(h.runs.runs).toHaveLength(1);
  });
});

describe("Discord bridge: logs stay content-free", () => {
  it("never logs message text, answer text or names", async () => {
    const h = harness({ finish: () => ({ text: "SENTINEL_ANSWER_TEXT" }) });
    const alice = h.fake.addUser({ globalName: "SENTINEL_NAME", username: "sentinel_user" });
    const question = await h.say(mention(h, alice, "SENTINEL_QUESTION_TEXT"));
    await h.settle();
    await h.say({ authorId: alice, channelId: question.id, content: "SENTINEL_FOLLOWUP_TEXT" });
    await h.settle();
    expect(botMessages(h, question.id).length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logs);
    for (const sentinel of ["SENTINEL_ANSWER_TEXT", "SENTINEL_NAME", "sentinel_user", "SENTINEL_QUESTION_TEXT", "SENTINEL_FOLLOWUP_TEXT", "discord.com",
      "cdn.discordapp", SHARE_URL]) {
      expect(serialized, sentinel).not.toContain(sentinel);
    }
  });
});

describe("Discord bridge: joined messages, the kill switch, test authors and a full lane", () => {
  it("joins the same author's next message to the question; a later handler for it gets the answer's ✅, not a second run", async () => {
    const h = harness({ finish: null, timing: { mergeWindowMs: 1_500 } });
    const alice = h.user("alice");
    const first = await h.say(mention(h, alice, "first part"));
    const second = h.post(mention(h, alice, "second part"));
    await vi.waitFor(() => expect(h.runs.runs).toHaveLength(1));
    expect(sentText(h.runs.runs[0]!.body)).toMatch(/first part\n@aiqsa-test second part$/u);
    await h.intake.accept({ data: second, type: "MESSAGE_CREATE" });
    await h.settle();
    expect(h.replies.rows.get(second.id)).toMatchObject({ kind: "follow_up", runId: h.runs.runs[0]!.runId, state: "admitted" });
    h.runs.runs[0]!.finish({ text: "Both parts." });
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
    expect(h.runs.runs[0]!.followups).toEqual([]);
    expect(h.fake.reactions(second.id, "✅")).toEqual([h.fake.bot.id]);
    expect(h.fake.channel(second.id)).toBeUndefined();
    expect(botMessages(h, first.id)).toHaveLength(1);
  });

  it("sends nothing once the bot is switched off mid-run, and records why", async () => {
    const h = harness({ finish: null });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "long one"));
    await h.settle();
    const edits = h.fake.calls({ route: "edit_message" }).length;
    h.setSending(false);
    h.runs.runs[0]!.finish({ text: "Too late." });
    await h.settle();
    expect(h.fake.calls({ route: "edit_message" })).toHaveLength(edits);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_disabled", failureKind: "delivery", state: "failed" });
  });

  it("answers a test author's bot in a test channel and marks the question test in its row and records", async () => {
    const fake = createFakeDiscord();
    const tester = fake.addUser({ bot: true, username: "e2e-bot" });
    const h = harness({ control: { testAuthorIds: new Set([tester]), testChannelIds: new Set([fake.channels.text]) }, fake });
    const question = await h.say(mention(h, tester, "test question"));
    await h.settle();
    expect(botMessages(h, question.id)).toHaveLength(1);
    expect(h.replies.rows.get(question.id)).toMatchObject({ state: "delivered", test: true });
    const records = logs.filter((entry) => entry.event === "discord_request" && entry.fields.message_id === question.id);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((entry) => entry.fields.test === true)).toBe(true);
  });

  it("answers a question whose conversation's lane is full as busy", async () => {
    const h = harness();
    const alice = h.user("alice");
    const full = h.makeIntake(createDiscordLanes({ concurrency: () => 16, queueLimit: 0 }));
    const question = await h.say(mention(h, alice, "anyone?"), full);
    await h.settle(full);
    expect(h.runs.runs).toHaveLength(0);
    expect(botMessages(h, h.fake.channels.text).map((message) => message.content)).toEqual([`❌ ${DISCORD_COPY.busy}`]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_busy", failureKind: "busy", kind: "refused", state: "failed" });
  });

  it("joins a question to a run another process follows, when the chat already has one", async () => {
    const h = harness({ finish: null });
    const alice = h.user("alice");
    const voice = h.fake.channels.voice;
    await h.say(mention(h, alice, "first", voice));
    await h.settle();
    const restarted = harness({ fake: h.fake, finish: null, runs: h.runs, stores: { conversations: h.conversations, replies: h.replies } });
    const second = await restarted.say(mention(restarted, alice, "second", voice));
    await restarted.settle();
    expect(h.runs.runs).toHaveLength(1);
    expect(h.runs.runs[0]!.followups.map((entry) => entry.nonce)).toEqual([`dc-${second.id}`]);
    expect(h.replies.rows.get(second.id)).toMatchObject({ kind: "follow_up", runId: h.runs.runs[0]!.runId, state: "admitted" });
  });
});

describe("Discord bridge: review fixes", () => {
  const longAnswer = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}: ${"detail ".repeat(40)}`).join("\n\n");

  it("delivers a cut answer without a share link when its chat is not linked to the conversation", async () => {
    const h = harness({ conversationWriteFails: true, finish: () => ({ text: `${longAnswer}\nDB_PASSWORD=hunter2-hunter2-hunter2` }) });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "explain"));
    await h.settle();
    const [answer] = botMessages(h, question.id);
    expect(answer!.content.endsWith("…")).toBe(true);
    expect(answer!.components).toEqual([]);
    expect(h.shares.create).not.toHaveBeenCalled();
    expect(h.replies.rows.get(question.id)).toMatchObject({ conversationId: null, state: "delivered" });
  });

  function claimed(h: Harness, question: FakeDiscordMessage, extra: Partial<Parameters<Harness["replies"]["claim"]>[0]> = {}) {
    return h.replies.claim({
      authorName: "alice", channelId: question.channel_id, discordUserId: question.author.id, guildId: h.fake.guild.id, kind: "refused",
      questionMessageId: question.id, receivedAt: new Date(h.now() - 60_000), test: false, ...extra
    });
  }

  it("neither sends again nor adopts a question whose send was claimed but never recorded; it ends visibly after ten minutes", async () => {
    const h = harness({ finish: null });
    const alice = h.user("alice");
    const question = h.post(mention(h, alice, "crashed after the send"));
    await claimed(h, question);
    const planned = "00000000-0000-4000-8000-00000000aaaa";
    await h.replies.fixAdmissionTarget(question.id, { plannedChatId: planned });
    expect(await h.replies.claimSend(question.id, new Date(h.now() - 60_000))).toBe(true);
    // The claimer reached the send handler, which made the chat and its run, then the process died.
    await h.runs.gateway.send({
      body: discordSendBody({ admissionId: `dc-${question.id}`, blocks: [{ text: "x", type: "text" }], expectedActiveLeafId: null, newChatAssistantId: "assistant_1" }),
      chatId: planned, userId: "svc_1"
    });
    await h.bridge.recover(new Date(h.now()));
    expect(h.replies.rows.get(question.id)).toMatchObject({ runId: null, state: "claimed" });
    h.runs.runs[0]!.finish({ text: "Never delivered." });
    h.advance(10 * 60_000);
    await h.bridge.recover(new Date(h.now()));
    expect(h.runs.runs).toHaveLength(1);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_reply_expired", runId: null, state: "failed" });
    expect(botMessages(h, h.fake.channels.text).map((message) => message.content)).toEqual([`❌ ${DISCORD_COPY.somethingWrong}`]);
  });

  it("asks a question whose send was never claimed again from the start, into the chat it planned", async () => {
    const h = harness();
    const alice = h.user("alice");
    const question = h.post(mention(h, alice, "crashed before the send"));
    await claimed(h, question);
    const planned = "00000000-0000-4000-8000-00000000bbbb";
    await h.replies.fixAdmissionTarget(question.id, { plannedChatId: planned });
    await h.bridge.recover(new Date(h.now()));
    await h.settle();
    expect(h.runs.runs.map((run) => run.chatId)).toEqual([planned]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ plannedChatId: planned, sendClaimedAt: expect.any(Date), state: "delivered" });
  });

  it("waits for a claimed send whose run is not found, then ends it visibly ten minutes after the claim, sending nothing", async () => {
    const h = harness();
    const alice = h.user("alice");
    const question = h.post(mention(h, alice, "the chat exists without a run"));
    await claimed(h, question);
    const planned = "00000000-0000-4000-8000-00000000cccc";
    await h.replies.fixAdmissionTarget(question.id, { plannedChatId: planned });
    await h.replies.claimSend(question.id, new Date(h.now() - 60_000));
    h.runs.chats.set(planned, { activeLeafMessageId: null, assistantId: "assistant_1", id: planned });
    await h.bridge.recover(new Date(h.now()));
    expect(h.replies.rows.get(question.id)).toMatchObject({ state: "claimed" });
    h.advance(10 * 60_000);
    await h.bridge.recover(new Date(h.now()));
    expect(h.runs.runs).toHaveLength(0);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_reply_expired", state: "failed" });
    expect(h.fake.reactions(question.id, "❌")).toEqual([h.fake.bot.id]);
  });

  it("asks a claimed question again from one process only, while two recover side by side", async () => {
    const fake = createFakeDiscord();
    const stores = { conversations: createMemoryDiscordConversationStore(), replies: createMemoryDiscordReplyStore() };
    const runs = createFakeDiscordRunGateway({ autoFinish: () => ({ text: "Once." }) });
    const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
    const one = harness({ clock, fake, runs, stores });
    const two = harness({ clock, fake, runs, stores });
    const alice = one.user("alice");
    const question = one.post(mention(one, alice, "lost in an upgrade"));
    await claimed(one, question);
    await Promise.all([one.bridge.recover(new Date(one.now())), two.bridge.recover(new Date(two.now()))]);
    await one.settle();
    await two.settle();
    expect(runs.runs).toHaveLength(1);
    expect(stores.replies.rows.get(question.id)).toMatchObject({ sendClaimedAt: expect.any(Date), state: "delivered" });
  });

  it("ends a question whose send was claimed long ago and has no run", async () => {
    const h = harness();
    const alice = h.user("alice");
    const question = h.post(mention(h, alice, "stuck"));
    await claimed(h, question);
    expect(await h.replies.claimSend(question.id, new Date(h.now() - 11 * 60_000))).toBe(true);
    await h.bridge.recover(new Date(h.now()));
    expect(h.runs.runs).toHaveLength(0);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_reply_expired", state: "failed" });
    expect(h.fake.reactions(question.id, "❌")).toEqual([h.fake.bot.id]);
  });

  it("sends a slow live question once while recovery in another process asks it again", async () => {
    const fake = createFakeDiscord();
    const stores = { conversations: createMemoryDiscordConversationStore(), replies: createMemoryDiscordReplyStore() };
    const runs = createFakeDiscordRunGateway({ autoFinish: () => ({ text: "Once." }) });
    const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
    let release!: () => void;
    const transfer = new Promise<void>((resolve) => { release = resolve; });
    let preparing = 0;
    // The attachments' transfer takes longer than the recovery grace.
    const attachments: DiscordAttachmentHook = async (input) => {
      preparing += 1;
      await transfer;
      return discordAttachmentNamesOnly(input);
    };
    const live = harness({ attachments, clock, fake, newChatId: () => "00000000-0000-4000-8000-000000000001", runs, stores, timing: { claimGraceMs: 120_000 } });
    const recovery = harness({
      attachments, clock, fake, newChatId: () => "00000000-0000-4000-8000-000000000002", runs, stores, timing: { claimGraceMs: 120_000 }
    });
    const alice = live.user("alice");
    const question = await live.say(mention(live, alice, "summarize", fake.channels.voice));
    await vi.waitFor(() => expect(preparing).toBe(1));
    live.advance(121_000);
    const sweep = recovery.bridge.recover(new Date(recovery.now()));
    await vi.waitFor(() => expect(preparing).toBe(2));
    release();
    await sweep;
    await live.settle();
    await recovery.settle();
    expect(runs.runs).toHaveLength(1);
    expect(stores.replies.rows.get(question.id)).toMatchObject({ plannedChatId: runs.runs[0]!.chatId, state: "delivered" });
    expect(botMessages(live, fake.channels.voice).map((message) => message.content)).toEqual(["Once."]);
  });

  it("keeps a question whose preparation failed in recovery for the next sweep", async () => {
    const h = harness();
    const question = h.post(mention(h, h.user("alice"), "recover me"));
    await claimed(h, question);
    h.fake.fail({ reply: { status: 503 as const }, route: "get_channel_message", times: 2 });
    await h.bridge.recover(new Date(h.now()));
    expect(h.runs.runs).toHaveLength(0);
    h.advance(60_000);
    await h.bridge.recover(new Date(h.now()));
    await h.settle();
    expect(h.runs.runs).toHaveLength(1);
  });

  it("makes a follow-up with a file the next turn, its file through the attachment hook, not a text-only follow-up", async () => {
    const seen: string[][] = [];
    const attachments: DiscordAttachmentHook = async (input) => {
      seen.push(input.question.flatMap((message) => message.attachments.map((attachment) => attachment.filename)));
      return discordAttachmentNamesOnly(input);
    };
    const h = harness({ attachments, finish: null });
    const alice = h.user("alice");
    const first = await h.say(mention(h, alice, "start"));
    await h.settle();
    const withFile = await h.say({
      attachments: [{ contentType: "image/png", data: Buffer.from("png"), filename: "diagram.png" }], authorId: alice, channelId: first.id,
      content: "use this image"
    });
    await vi.waitFor(() => expect(h.fake.reactions(withFile.id, "👀")).toEqual([h.fake.bot.id]));
    expect(h.runs.runs[0]!.followups).toEqual([]);
    h.runs.runs[0]!.finish({ text: "Done." });
    await h.settle();
    expect(h.runs.runs).toHaveLength(2);
    expect(seen.at(-1)).toEqual(["diagram.png"]);
    expect(sentText(h.runs.runs[1]!.body)).toContain("use this image [attachments: diagram.png]");
    expect(h.replies.rows.get(withFile.id)).toMatchObject({ kind: "answer", runId: h.runs.runs[1]!.runId, state: "admitted" });
    expect(h.replies.rows.get(first.id)).toMatchObject({ state: "delivered" });
  });

  it("makes a Reply to a message with a file the next turn, while plain text joins the run", async () => {
    const h = harness({ finish: null });
    const [alice, bob, carol] = [h.user("alice"), h.user("bob"), h.user("carol")];
    const first = await h.say(mention(h, alice, "start"));
    await h.settle();
    const plain = await h.say({ authorId: carol, channelId: first.id, content: "plain text" });
    await vi.waitFor(() => expect(h.runs.runs[0]!.followups.map((entry) => entry.nonce)).toEqual([`dc-${plain.id}`]));
    const picture = await h.say({
      attachments: [{ contentType: "image/png", data: Buffer.from("png"), filename: "chart.png" }], authorId: bob, channelId: first.id,
      content: `<@${carol}> look`, mentions: [carol]
    });
    const reply = await h.say({
      authorId: alice, channelId: first.id, content: `<@${h.fake.bot.id}> make it blue`, mentions: [h.fake.bot.id], replyTo: picture.id
    });
    await vi.waitFor(() => expect(h.fake.reactions(reply.id, "👀")).toEqual([h.fake.bot.id]));
    expect(h.runs.runs[0]!.followups).toHaveLength(1);
    h.runs.runs[0]!.finish({ text: "Done." });
    await h.settle();
    expect(h.runs.runs).toHaveLength(2);
    const next = sentText(h.runs.runs[1]!.body);
    expect(next).toContain(`Replying to bob (discord:${bob}), message ${picture.id}:\n@carol look [attachments: chart.png]`);
    expect(next).not.toContain("plain text");
  });

  it("never gives a question whose send was claimed another question's unrecorded run (reviewer: wrong owner)", async () => {
    const h = harness({ finish: null, timing: { claimGraceMs: 120_000 } });
    const alice = h.user("alice");
    await h.say(mention(h, alice, "baseline", h.fake.channels.voice));
    await h.settle();
    const baseline = h.runs.runs[0]!;
    baseline.finish({ text: "Baseline." });
    await h.settle();
    const old = h.post(mention(h, alice, "old question", h.fake.channels.voice));
    await claimed(h, old, { expectedLeafId: baseline.assistantMessageId });
    await h.replies.claimSend(old.id, new Date(h.now()));
    // The worker dies before sending the old question.
    h.advance(121_000);
    const newer = h.post(mention(h, alice, "different question", h.fake.channels.voice));
    await claimed(h, newer, { expectedLeafId: baseline.assistantMessageId });
    await h.replies.claimSend(newer.id, new Date(h.now()));
    // The newer question's run commits before its journal row names it.
    await h.runs.gateway.send({
      body: discordSendBody({ admissionId: `dc-${newer.id}`, blocks: [{ text: "different question", type: "text" }],
        expectedActiveLeafId: baseline.assistantMessageId, newChatAssistantId: null }),
      chatId: baseline.chatId, userId: "svc_1"
    });
    await h.bridge.recover(new Date(h.now()));
    expect(h.replies.rows.get(old.id)?.runId).toBeNull();
    h.runs.runs[1]!.finish({ text: "Answer to the different question." });
    h.advance(10 * 60_000);
    await h.bridge.recover(new Date(h.now()));
    expect(h.replies.rows.get(old.id)).toMatchObject({ code: "discord_reply_expired", runId: null, state: "failed" });
    expect(h.fake.reactions(old.id, "❌")).toEqual([h.fake.bot.id]);
    const posted = botMessages(h, h.fake.channels.voice).map((message) => message.content);
    expect(posted).not.toContain("Answer to the different question.");
  });

  it("answers no message twice when a claimed merged send was lost (reviewer: merged replay)", async () => {
    const h = harness({ timing: { claimGraceMs: 120_000, mergeWindowMs: 1_500 } });
    const alice = h.user("alice");
    const first = h.post(mention(h, alice, "first part", h.fake.channels.voice));
    const second = h.post(mention(h, alice, "second part", h.fake.channels.voice));
    await claimed(h, first);
    expect(Date.parse(second.timestamp) - Date.parse(first.timestamp)).toBeLessThanOrEqual(1_500);
    const chatId = "00000000-0000-4000-8000-00000000aaaa";
    await h.replies.fixAdmissionTarget(first.id, { plannedChatId: chatId });
    await h.replies.claimSend(first.id, new Date(h.now()));
    // The merged send went out; the process died before recording its run.
    await h.runs.gateway.send({
      body: discordSendBody({ admissionId: `dc-${first.id}`, blocks: [{ text: "first part\nsecond part", type: "text" }],
        expectedActiveLeafId: null, newChatAssistantId: "assistant_1" }),
      chatId, userId: "svc_1"
    });
    h.advance(121_000);
    await h.bridge.recover(new Date(h.now()));
    await h.intake.accept({ data: second, type: "MESSAGE_CREATE" });
    // The lost one stays claimed until its ending, so only the second message's own answer is waited for.
    await vi.waitFor(() => expect(h.replies.rows.get(second.id)?.state).toBe("delivered"));
    await h.intake.lanes.idle();
    await h.bridge.idle();
    h.advance(10 * 60_000);
    await h.bridge.recover(new Date(h.now()));
    // The lost send's run is never adopted; the second message, its own trigger, is answered once on its own.
    expect(h.runs.runs).toHaveLength(2);
    expect(h.replies.rows.get(first.id)).toMatchObject({ code: "discord_reply_expired", runId: null, state: "failed" });
    expect(h.replies.rows.get(second.id)).toMatchObject({ runId: h.runs.runs[1]!.runId, state: "delivered" });
    expect(botMessages(h, h.fake.channels.voice).filter((message) => message.message_reference?.message_id === second.id)).toHaveLength(1);
  });

  it("never sends a turn with files as a text follow-up into another process's running answer (reviewer: remote files)", async () => {
    const fake = createFakeDiscord();
    const stores = { conversations: createMemoryDiscordConversationStore(), replies: createMemoryDiscordReplyStore() };
    const runs = createFakeDiscordRunGateway({ autoFinish: null });
    const one = harness({ fake, runs, stores });
    const two = harness({ fake, runs, stores });
    const alice = one.user("alice");
    const first = await one.say(mention(one, alice, "start"));
    await one.settle();
    const file = await two.say({
      attachments: [{ contentType: "image/png", data: Buffer.from("png"), filename: "diagram.png" }], authorId: alice, channelId: first.id,
      content: "describe this image"
    });
    await two.intake.lanes.idle();
    await two.bridge.idle();
    expect(runs.runs[0]!.followups).toEqual([]);
    expect(stores.replies.rows.get(file.id)?.state).toBe("claimed");
  });

  it("sends a turn with files as the next turn, with its blocks, once another process's answer settles", async () => {
    const fake = createFakeDiscord();
    const stores = { conversations: createMemoryDiscordConversationStore(), replies: createMemoryDiscordReplyStore() };
    const runs = createFakeDiscordRunGateway({ autoFinish: null });
    const imageBlock = { alt: "diagram.png", attachmentId: "attachment-image-1", type: "image" as const };
    const attachments: DiscordAttachmentHook = async (input) => ({
      blocks: input.question.some((message) => message.attachments.length > 0) ? [imageBlock] : [], notes: []
    });
    const one = harness({ fake, runs, stores });
    const two = harness({ attachments, fake, runs, stores, timing: { followMs: 30_000 } });
    const alice = one.user("alice");
    const first = await one.say(mention(one, alice, "start"));
    await one.settle();
    const file = await two.say({
      attachments: [{ contentType: "image/png", data: Buffer.from("png"), filename: "diagram.png" }], authorId: alice, channelId: first.id,
      content: "describe this image"
    });
    await vi.waitFor(() => expect(stores.replies.rows.get(file.id)?.sendClaimedAt).toBeInstanceOf(Date));
    runs.runs[0]!.finish({ text: "First." });
    await vi.waitFor(() => expect(runs.runs).toHaveLength(2), { timeout: 5_000 });
    expect(runs.runs[0]!.followups).toEqual([]);
    expect((runs.runs[1]!.body.content as { blocks: unknown[] }).blocks).toContainEqual(imageBlock);
    expect(stores.replies.rows.get(file.id)).toMatchObject({ kind: "answer", runId: runs.runs[1]!.runId });
  });

  it("never leaves a refused final message as Working with 👀", async () => {
    const h = harness({ finish: null });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "permissions change"));
    await h.settle();
    h.fake.fail({ method: "PATCH", reply: { code: 50013, status: 403 }, route: "edit_message", times: 1 });
    h.runs.runs[0]!.finish({ text: "Never shown." });
    await vi.waitFor(() => expect(h.replies.rows.get(question.id)?.state).toBe("failed"));
    await h.bridge.idle();
    expect(botMessages(h, question.id).map((message) => message.content)).toEqual([`❌ ${DISCORD_COPY.somethingWrong}`]);
    expect(h.fake.reactions(question.id, "❌")).toEqual([h.fake.bot.id]);
    expect(h.fake.reactions(question.id, "👀")).toEqual([]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_api_error", failureKind: "delivery" });
  });

  const retried: Array<[string, FakeDiscordReply, string]> = [
    ["an outcome Discord left unknown", { status: 500 }, "discord_delivery_unknown"],
    ["a rate limit past its repeat", { retryAfter: 0.01, status: 429 }, "discord_rate_limited"]
  ];
  it.each(retried)("keeps a final edit that failed with %s for the next sweep, which delivers it", async (_name, reply, code) => {
    const h = harness({ finish: null });
    const alice = h.user("alice");
    const question = await h.say(mention(h, alice, "flaky Discord"));
    await h.settle();
    h.fake.fail({ method: "PATCH", reply, route: "edit_message", times: 2 });
    h.runs.runs[0]!.finish({ text: "Delivered later." });
    await vi.waitFor(() => expect(h.replies.rows.get(question.id)?.code).toBe(code));
    await h.bridge.idle();
    expect(h.replies.rows.get(question.id)).toMatchObject({ failureKind: "delivery", state: "admitted" });
    expect(botMessages(h, question.id)[0]!.content).toMatch(/^Working/u);
    h.advance(60_000);
    await h.bridge.recover(new Date(h.now()));
    expect(botMessages(h, question.id).map((message) => message.content)).toEqual(["Delivered later."]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: null, state: "delivered" });
    expect(h.fake.reactions(question.id, "✅")).toEqual([h.fake.bot.id]);
  });
});
