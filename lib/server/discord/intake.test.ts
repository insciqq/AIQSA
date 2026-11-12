import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDiscord, FAKE_DISCORD_CHANNEL_TYPES, type FakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import { createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo, type DiscordChannelInfo } from "./access";
import type { DiscordEffectiveControl } from "./control/state";
import {
  createDiscordHandlerRegistry, createDiscordIntake, createDiscordLanes, discordSnowflakeAt, discordSnowflakeTime,
  type DiscordIntakeDeps, type DiscordMessageContext
} from "./intake";
import { createDiscordRest } from "./rest";

const logs = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observability")>();
  return {
    ...actual,
    logEvent: ((event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }) as typeof actual.logEvent
  };
});

const NOW = Date.parse("2026-11-12T09:05:00.000Z");

afterEach(() => {
  logs.length = 0;
  vi.useRealTimers();
});

function controlFor(fake: FakeDiscord, overrides: Partial<DiscordEffectiveControl> = {}): DiscordEffectiveControl {
  return {
    assistantId: "assistant_1",
    bot: {
      applicationId: fake.application.id, generation: 1, roleId: fake.botRoleId, token: fake.token, userId: fake.bot.id,
      username: fake.bot.username
    },
    channelIds: new Set([fake.channels.text]),
    channelMode: "only_listed",
    dmEnabled: false,
    enabled: true,
    enabledAt: new Date("2026-11-12T08:00:00.000Z"),
    guildId: fake.guild.id,
    limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 },
    serviceUserId: "svc_1",
    session: null,
    testAuthorIds: new Set(),
    testChannelIds: new Set(),
    callNames: [],
    tokenState: "ready",
    version: 3,
    ...overrides
  };
}

function harness(
  fake: FakeDiscord,
  { control: controlOverrides, ...overrides }: Partial<Omit<DiscordIntakeDeps, "control">> & { control?: Partial<DiscordEffectiveControl> } = {}
) {
  const registry = createDiscordHandlerRegistry();
  const handled: DiscordMessageContext[] = [];
  registry.registerMessage(async (context) => { handled.push(context); return true; });
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const directory = createDiscordChannelDirectory();
  // What a real session learns from GUILD_CREATE.
  for (const id of Object.values(fake.channels)) directory.remember(discordChannelInfo(fake.channel(id), fake.guild.id)!);
  let control = controlFor(fake, controlOverrides);
  const intake = createDiscordIntake({
    control: async () => control,
    directory,
    lookupChannel: async (channelId) => {
      const answer = await rest.getChannel(channelId);
      return answer.ok ? discordChannelInfo(answer.value) : null;
    },
    membership: createDiscordMembership({ now: () => NOW, rest: async () => rest }),
    now: () => NOW,
    registry,
    ...overrides
  });
  return {
    directory, handled, intake, registry, rest,
    setControl: (next: Partial<DiscordEffectiveControl>) => { control = controlFor(fake, { ...controlOverrides, ...next }); }
  };
}

function created(message: FakeDiscordMessage): { type: string; data: unknown } {
  return { data: message, type: "MESSAGE_CREATE" };
}

function intakeLogs(): Array<Record<string, unknown>> {
  return logs.filter((entry) => entry.event === "discord_intake").map((entry) => entry.fields);
}

describe("Discord intake filters", () => {
  it("hands a person's message in a listed channel to the handlers with the bot identity, and drops everything else with a log", async () => {
    const fake = createFakeDiscord();
    const h = harness(fake);
    const alice = fake.addUser({ username: "alice" });
    const bot = fake.addUser({ bot: true, username: "other-bot" });
    const excluded = fake.addChannel({ name: "excluded", type: FAKE_DISCORD_CHANNEL_TYPES.text });
    h.directory.remember(discordChannelInfo(fake.channel(excluded), fake.guild.id)!);

    const question = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "hello", mentions: [fake.bot.id] });
    await h.intake.accept(created(question));
    await h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: excluded, content: "x" })));
    await h.intake.accept(created(fake.postMessage({ authorId: bot, channelId: fake.channels.text, content: "x" })));
    await h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "x", webhookId: "1100000000000009999" })));
    await h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "", type: 7 })));
    await h.intake.accept(created({ ...fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "x" }), guild_id: "1100000000000008888" }));
    fake.editUserMessage(fake.channels.text, question.id, "edited");
    await h.intake.accept({ data: fake.messages(fake.channels.text).find((entry) => entry.id === question.id), type: "MESSAGE_UPDATE" });
    // The bot's own posts are not news and leave no record.
    await h.intake.accept(created({ ...question, author: fake.bot, id: "1100000000000007777" }));
    await h.intake.lanes.idle();

    expect(h.handled.map((context) => context.message.id)).toEqual([question.id]);
    const [context] = h.handled;
    expect(context).toMatchObject({
      channel: { guildId: fake.guild.id, id: fake.channels.text, type: 0 }, kind: "text", source: "live", test: false,
      control: { bot: { roleId: fake.botRoleId, userId: fake.bot.id } },
      message: { author: { bot: false, id: alice, username: "alice" }, content: "hello", guildId: fake.guild.id, mentionUserIds: [fake.bot.id] }
    });
    expect(intakeLogs().map((fields) => fields.reason)).toEqual(["channel_rule", "bot_author", "webhook", "system_type", "other_guild", "edit"]);
    expect(intakeLogs().every((fields) => fields.outcome === "ignored")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("hello");
  });

  it("judges threads and forum posts by their parent channel, looking a thread up through Discord when no event named it", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const excluded = fake.addChannel({ name: "secret", type: FAKE_DISCORD_CHANNEL_TYPES.text });
    const listedThread = fake.addChannel({ name: "thread", parentId: fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
    const excludedThread = fake.addChannel({ name: "thread", parentId: excluded, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
    const allExcept = harness(fake, { control: { channelIds: new Set([excluded]), channelMode: "all_except" } });
    allExcept.directory.remember(discordChannelInfo(fake.channel(excluded), fake.guild.id)!);
    const post = fake.createForumPost({ authorId: alice, content: "forum question", forumId: fake.channels.forum, name: "Post" });

    for (const channelId of [listedThread, excludedThread]) {
      await allExcept.intake.accept(created(fake.postMessage({ authorId: alice, channelId, content: "in thread" })));
    }
    await allExcept.intake.accept(created(post.message));
    await allExcept.intake.lanes.idle();
    expect(allExcept.handled.map((context) => [context.channel.id, context.kind])).toEqual([
      [listedThread, "thread"], [post.threadId, "forum_post"]
    ]);
    expect(fake.calls({ route: "get_channel" }).map((call) => call.path)).toEqual([
      `/channels/${listedThread}`, `/channels/${excludedThread}`, `/channels/${post.threadId}`
    ]);
    expect(intakeLogs()).toEqual([expect.objectContaining({ channel_id: excludedThread, outcome: "ignored", reason: "channel_rule" })]);

    const onlyListed = harness(fake);
    await onlyListed.intake.accept(created(fake.postMessage({ authorId: alice, channelId: listedThread, content: "listed parent" })));
    await onlyListed.intake.accept(created(fake.postMessage({ authorId: alice, channelId: excludedThread, content: "other parent" })));
    await onlyListed.intake.lanes.idle();
    expect(onlyListed.handled.map((context) => context.channel.id)).toEqual([listedThread]);
  });

  it("keeps a channel's events in order while the first one waits for Discord to name the channel", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const thread = fake.addChannel({ name: "slow", parentId: fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
    let answer!: (info: DiscordChannelInfo) => void;
    const lookup = vi.fn(() => new Promise<DiscordChannelInfo>((resolve) => { answer = resolve; }));
    const h = harness(fake, { lookupChannel: lookup });
    const first = h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: thread, content: "first" })));
    const second = h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: thread, content: "second" })));
    await new Promise((resolve) => setImmediate(resolve));
    answer(discordChannelInfo(fake.channel(thread), fake.guild.id)!);
    await Promise.all([first, second]);
    await h.intake.lanes.idle();
    expect(h.handled.map((context) => context.message.content)).toEqual(["first", "second"]);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("refuses a thread whose parent cannot be named, in every channel mode", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const h = harness(fake, { control: { channelIds: new Set(), channelMode: "all_except" }, lookupChannel: async () => null });
    const thread = fake.addChannel({ name: "unknown", parentId: fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
    await h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: thread, content: "x" })));
    await h.intake.lanes.idle();
    expect(h.handled).toEqual([]);
    expect(intakeLogs()).toEqual([expect.objectContaining({ code: "discord_channel_unknown", reason: "channel_rule" })]);
  });

  it("takes direct messages only while they are on and only from members of the server, remembering membership ten minutes", async () => {
    const fake = createFakeDiscord();
    const member = fake.addUser({ username: "member" });
    const stranger = fake.addUser({ member: false, username: "stranger" });
    const memberDm = fake.openDm(member);
    const strangerDm = fake.openDm(stranger);
    const h = harness(fake);
    await h.intake.accept(created(fake.postMessage({ authorId: member, channelId: memberDm, content: "off" })));
    h.setControl({ dmEnabled: true });
    await h.intake.accept(created(fake.postMessage({ authorId: member, channelId: memberDm, content: "on" })));
    await h.intake.accept(created(fake.postMessage({ authorId: member, channelId: memberDm, content: "again" })));
    await h.intake.accept(created(fake.postMessage({ authorId: stranger, channelId: strangerDm, content: "stranger" })));
    await h.intake.lanes.idle();
    expect(h.handled.map((context) => [context.kind, context.message.guildId, context.message.content])).toEqual([
      ["dm", null, "on"], ["dm", null, "again"]
    ]);
    expect(intakeLogs().map((fields) => fields.reason)).toEqual(["dm_disabled", "not_member"]);
    // One membership check per person within ten minutes.
    expect(fake.calls({ route: "get_guild_member" })).toHaveLength(2);
  });

  it("refuses a direct message when Discord cannot say whether the author is a member", async () => {
    const fake = createFakeDiscord();
    const member = fake.addUser({ username: "member" });
    const dm = fake.openDm(member);
    const h = harness(fake, { control: { dmEnabled: true } });
    fake.fail({ reply: { status: 500 }, route: "get_guild_member", times: 2 });
    await h.intake.accept(created(fake.postMessage({ authorId: member, channelId: dm, content: "x" })));
    await h.intake.lanes.idle();
    expect(h.handled).toEqual([]);
    expect(intakeLogs()).toEqual([expect.objectContaining({ code: "discord_http_error", outcome: "refused", reason: "not_member" })]);
  });

  it("treats a test author's bot messages as a person's only in test channels and their threads, marked test", async () => {
    const fake = createFakeDiscord();
    const tester = fake.addUser({ bot: true, username: "test-runner" });
    const other = fake.addChannel({ name: "other", type: FAKE_DISCORD_CHANNEL_TYPES.text });
    const testThread = fake.addChannel({ name: "t", parentId: fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
    const h = harness(fake, {
      control: { channelIds: new Set([fake.channels.text, other]), testAuthorIds: new Set([tester]), testChannelIds: new Set([fake.channels.text]) }
    });
    h.directory.remember(discordChannelInfo(fake.channel(other), fake.guild.id)!);
    await h.intake.accept(created(fake.postMessage({ authorId: tester, channelId: fake.channels.text, content: "test question" })));
    await h.intake.accept(created(fake.postMessage({ authorId: tester, channelId: testThread, content: "in its thread" })));
    await h.intake.accept(created(fake.postMessage({ authorId: tester, channelId: other, content: "elsewhere" })));
    await h.intake.lanes.idle();
    expect(h.handled.map((context) => [context.message.content, context.test])).toEqual([["test question", true], ["in its thread", true]]);
    expect(intakeLogs()).toEqual([expect.objectContaining({ channel_id: other, reason: "bot_author" })]);
  });

  it("never answers a question older than ten minutes or sent while the bot was off", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const h = harness(fake, { control: { enabledAt: new Date("2026-11-12T09:00:03.000Z") } });
    const beforeEnable = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "before" });
    await h.intake.accept(created(beforeEnable));
    await h.intake.accept(created({ ...fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "old" }), timestamp: "2026-11-12T08:50:00.000Z" }));
    const fresh = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "fresh" });
    await h.intake.accept(created(fresh));
    await h.intake.lanes.idle();
    expect(h.handled.map((context) => context.message.id)).toEqual([fresh.id]);
    expect(intakeLogs().map((fields) => fields.reason)).toEqual(["disabled", "disabled"]);
    h.setControl({ enabled: false });
    await h.intake.accept(created(fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "off" })));
    expect(intakeLogs().at(-1)).toMatchObject({ reason: "disabled" });
  });

  it("hands a repeated event on once, whether repeated by id or by the session's sequence", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const h = harness(fake);
    const message = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "once" });
    await h.intake.accept({ ...created(message), seq: 5, sessionId: "session-a" });
    await h.intake.accept({ ...created(message), seq: 5, sessionId: "session-a" });
    await h.intake.accept({ ...created(message), seq: 9, sessionId: "session-b" });
    await h.intake.lanes.idle();
    expect(h.handled).toHaveLength(1);
    expect(intakeLogs()).toEqual([
      expect.objectContaining({ message_id: message.id, outcome: "duplicate", reason: "duplicate" }),
      expect.objectContaining({ message_id: message.id, outcome: "duplicate", reason: "duplicate" })
    ]);
  });

  it("passes deletes and 👍/👎 from people to their handlers in the channel's lane, never the bot's own reactions", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice", nick: "Alice A." });
    const h = harness(fake);
    const deletes: string[][] = [];
    const reactions: Array<[string, number, string, string | null]> = [];
    h.registry.registerDelete(async (context) => { deletes.push([...context.messageIds]); });
    h.registry.registerReaction(async (context) => { reactions.push([context.action, context.value, context.userId, context.displayName]); });
    const answer = fake.postMessage({ authorId: fake.bot.id, channelId: fake.channels.text, content: "answer" });
    const reaction = (name: string, userId = alice) => ({
      data: { channel_id: fake.channels.text, emoji: { id: null, name }, guild_id: fake.guild.id, member: { nick: "Alice A.", roles: [], user: { id: userId } },
        message_id: answer.id, user_id: userId },
      type: "MESSAGE_REACTION_ADD"
    });
    await h.intake.accept(reaction("👍"));
    await h.intake.accept(reaction("🎉"));
    await h.intake.accept(reaction("👀", fake.bot.id));
    await h.intake.accept({ data: { channel_id: fake.channels.text, emoji: { id: null, name: "👎" }, guild_id: fake.guild.id, message_id: answer.id, user_id: alice },
      type: "MESSAGE_REACTION_REMOVE" });
    await h.intake.accept({ data: { channel_id: fake.channels.text, guild_id: fake.guild.id, id: "1100000000000005555" }, type: "MESSAGE_DELETE" });
    await h.intake.accept({ data: { channel_id: fake.channels.text, guild_id: fake.guild.id, ids: ["1100000000000005556", "1100000000000005557"] },
      type: "MESSAGE_DELETE_BULK" });
    await h.intake.lanes.idle();
    expect(reactions).toEqual([["add", 1, alice, "Alice A."], ["remove", -1, alice, null]]);
    expect(deletes).toEqual([["1100000000000005555"], ["1100000000000005556", "1100000000000005557"]]);
  });

  it("learns the bot's managed role from GUILD_CREATE and the channels and threads named there", async () => {
    const fake = createFakeDiscord();
    const roles: Array<{ guildId: string; roleId: string | null }> = [];
    const h = harness(fake, { onBotRole: (role) => { roles.push(role); } });
    await h.intake.accept({
      data: {
        channels: [{ id: "1100000000000006001", name: "late", type: 0 }],
        id: fake.guild.id,
        roles: [{ id: "1100000000000006100", name: "@everyone" }, { id: fake.botRoleId, name: "aiqsa", tags: { bot_id: fake.bot.id } }],
        threads: [{ id: "1100000000000006002", parent_id: "1100000000000006001", type: 11 }]
      },
      type: "GUILD_CREATE"
    });
    expect(roles).toEqual([{ guildId: fake.guild.id, roleId: fake.botRoleId }]);
    expect(h.directory.get("1100000000000006002")).toEqual({ guildId: fake.guild.id, id: "1100000000000006002", parentId: "1100000000000006001", type: 11 });
  });
});

describe("Discord lanes", () => {
  it("runs 20 conversations in parallel up to Parallel threads while each stays in order", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const registry = createDiscordHandlerRegistry();
    const directory = createDiscordChannelDirectory();
    const threads: DiscordChannelInfo[] = Array.from({ length: 20 }, (_, index) => {
      const id = fake.addChannel({ name: `t${index}`, parentId: fake.channels.text, type: FAKE_DISCORD_CHANNEL_TYPES.publicThread });
      return discordChannelInfo(fake.channel(id), fake.guild.id)!;
    });
    for (const channel of [...threads, discordChannelInfo(fake.channel(fake.channels.text), fake.guild.id)!]) directory.remember(channel);
    let running = 0;
    let peak = 0;
    const order = new Map<string, string[]>();
    const release: Array<() => void> = [];
    registry.registerMessage(async (context) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      order.set(context.channel.id, [...(order.get(context.channel.id) ?? []), context.message.content]);
      running -= 1;
      return true;
    });
    const intake = createDiscordIntake({
      control: async () => controlFor(fake, { limits: { parallelThreads: 8, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 } }),
      directory, lookupChannel: async () => null, membership: { check: async () => ({ member: true }) }, now: () => NOW, registry
    });
    for (const thread of threads) {
      for (const step of ["first", "second"]) {
        await intake.accept(created(fake.postMessage({ authorId: alice, channelId: thread.id, content: step })));
      }
    }
    expect(intake.lanes.stats()).toMatchObject({ active: 8, lanes: 20 });
    while (release.length > 0 || intake.lanes.stats().active > 0) {
      release.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setImmediate(resolve));
    }
    await intake.lanes.idle();
    expect(peak).toBe(8);
    expect([...order.values()].every((steps) => steps.join() === "first,second")).toBe(true);
    expect(order.size).toBe(20);
  });

  it("keeps at most 20 waiting in one lane and sends the rest to the overflow handlers", async () => {
    const lanes = createDiscordLanes({ concurrency: () => 1 });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    expect(lanes.enqueue("thread", () => blocker)).toBe("queued");
    const outcomes = Array.from({ length: 21 }, () => lanes.enqueue("thread", async () => undefined));
    expect(outcomes.filter((outcome) => outcome === "queued")).toHaveLength(20);
    expect(outcomes.at(-1)).toBe("overflow");
    release();
    await lanes.idle();
    expect(lanes.stats()).toEqual({ active: 0, held: 0, lanes: 0, waiting: 0 });
  });

  it("keeps a held slot for a running answer: its follow-ups run at once, a new conversation waits for the slot", async () => {
    const lanes = createDiscordLanes({ concurrency: () => 1 });
    const ran: string[] = [];
    let finish!: () => void;
    const answer = new Promise<void>((resolve) => { finish = resolve; });
    lanes.enqueue("thread-a", async () => { ran.push("a:question"); lanes.hold("thread-a", answer); });
    await lanes.idle();
    expect(lanes.stats()).toMatchObject({ active: 1, held: 1 });
    lanes.enqueue("thread-b", async () => { ran.push("b:question"); });
    lanes.enqueue("thread-a", async () => { ran.push("a:follow-up"); });
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran).toEqual(["a:question", "a:follow-up"]);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    await lanes.idle();
    expect(ran).toEqual(["a:question", "a:follow-up", "b:question"]);
    expect(lanes.stats()).toEqual({ active: 0, held: 0, lanes: 0, waiting: 0 });
  });
});

describe("Discord backfill after a new session", () => {
  it("reads known conversations from the stale window on, in id order, and drops what is too old", async () => {
    const fake = createFakeDiscord();
    const alice = fake.addUser({ username: "alice" });
    const recent = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "recent" });
    const later = fake.postMessage({ authorId: alice, channelId: fake.channels.text, content: "later" });
    const asked: Array<[string, string]> = [];
    const h = harness(fake, {
      backfillSource: {
        conversations: async (since) => {
          expect(since.getTime()).toBe(NOW - 24 * 3_600_000);
          return [{ channelId: fake.channels.text, guildId: fake.guild.id }];
        },
        messagesAfter: async (channelId, afterId) => {
          asked.push([channelId, afterId]);
          // REST messages carry no guild id; newest first, as Discord answers.
          const strip = ({ guild_id: _guild, ...rest }: FakeDiscordMessage) => rest;
          return [strip(later), strip(recent), { ...strip(recent), id: "1100000000000004444", timestamp: "2026-11-12T08:00:00.000Z" }];
        }
      }
    });
    await h.intake.backfill();
    await h.intake.lanes.idle();
    expect(asked).toEqual([[fake.channels.text, discordSnowflakeAt(NOW - 10 * 60_000)]]);
    expect(h.handled.map((context) => [context.message.id, context.source, context.message.guildId])).toEqual([
      [recent.id, "backfill", fake.guild.id], [later.id, "backfill", fake.guild.id]
    ]);
    expect(intakeLogs()).toEqual([expect.objectContaining({ reason: "stale" })]);
  });

  it("converts between snowflakes and times", () => {
    const at = Date.parse("2026-11-12T09:00:00.000Z");
    expect(discordSnowflakeTime(discordSnowflakeAt(at))).toBe(at);
  });
});
