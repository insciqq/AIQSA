import { describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import { createDiscordChannelDirectory, createDiscordMembership, discordChannelInfo } from "../access";
import type { DiscordEffectiveControl } from "../control/state";
import { DISCORD_VOICE_COPY, discordFailureStatus } from "../copy";
import { createDiscordHandlerRegistry, createDiscordIntake } from "../intake";
import { createDiscordRest } from "../rest";
import type { DiscordVoiceHook, DiscordVoiceOutcome } from "../voice";
import {
  createFakeDiscordRunGateway, createMemoryDiscordConversationStore, createMemoryDiscordLimitStore, createMemoryDiscordReplyStore,
  createMemoryDiscordRunFacts
} from "./bridge.testFixtures";
import { createDiscordBridge } from "./index";
import { DISCORD_REACTION_FAILED } from "./status";

vi.mock("../../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../observability")>();
  return { ...actual, logEvent: (() => undefined) as typeof actual.logEvent };
});

const OGG = Buffer.from("OggS\0\x02synthetic voice");

function harness(outcome: (messageId: string) => DiscordVoiceOutcome) {
  const fake = createFakeDiscord();
  const clock = { latest: Date.parse("2026-11-12T09:00:00.000Z") };
  const now = () => clock.latest + 500;
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const replies = createMemoryDiscordReplyStore();
  const runs = createFakeDiscordRunGateway({ autoFinish: () => ({ text: "The answer." }) });
  const control: DiscordEffectiveControl = {
    assistantId: "assistant_1",
    bot: { applicationId: fake.application.id, generation: 1, roleId: fake.botRoleId, token: fake.token, userId: fake.bot.id, username: fake.bot.username },
    callNames: [], channelIds: new Set(), channelMode: "all_except", dmEnabled: true, enabled: true,
    enabledAt: new Date("2026-11-12T08:00:00.000Z"), guildId: fake.guild.id,
    limits: { parallelThreads: 16, perAuthorDaily: 100, perAuthorHourly: 20, perThreadHourly: 60 },
    serviceUserId: "svc_1", session: null, testAuthorIds: new Set(), testChannelIds: new Set(), tokenState: "ready", version: 3
  };
  const registry = createDiscordHandlerRegistry();
  const directory = createDiscordChannelDirectory();
  for (const id of Object.values(fake.channels)) directory.remember(discordChannelInfo(fake.channel(id), fake.guild.id)!);
  const intake = createDiscordIntake({
    control: async () => control, directory,
    lookupChannel: async (channelId) => {
      const answer = await rest.getChannel(channelId);
      return answer.ok ? discordChannelInfo(answer.value) : null;
    },
    membership: createDiscordMembership({ now, rest: async () => rest }), now, registry
  });
  const voice = vi.fn<DiscordVoiceHook>(async ({ messages }) => new Map(messages.map((message) => [message.id, outcome(message.id)] as const)));
  const bridge = createDiscordBridge({
    control: async () => control, conversations: createMemoryDiscordConversationStore(), facts: createMemoryDiscordRunFacts(replies),
    gateway: runs.gateway, lanes: intake.lanes, limits: createMemoryDiscordLimitStore(replies), now, publish: async () => undefined, replies,
    rest: () => rest, setupReady: async () => true, shares: { create: async () => null },
    timing: { claimGraceMs: 0, followMs: 0, mergeWindowMs: 0, statusIntervalMs: 60_000, typingIntervalMs: 60_000 }, voice
  });
  bridge.register(registry);

  async function deliver(message: FakeDiscordMessage): Promise<FakeDiscordMessage> {
    clock.latest = Math.max(clock.latest, Date.parse(message.timestamp));
    await intake.accept({ data: message, type: "MESSAGE_CREATE" });
    await vi.waitFor(async () => {
      await intake.lanes.idle();
      await bridge.idle();
      expect([...replies.rows.values()].filter((row) => row.state === "claimed" || row.state === "admitted")).toEqual([]);
    });
    return message;
  }
  return { deliver, fake, replies, runs, voice };
}

function sentText(body: Record<string, unknown>): string {
  return (body.content as { blocks: Array<{ type: string; text?: string }> }).blocks
    .filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function botMessages(fake: FakeDiscord, channelId: string): FakeDiscordMessage[] {
  return fake.messages(channelId).filter((message) => message.author.id === fake.bot.id);
}

describe("Discord bridge: voice messages", () => {
  it("answers a direct message's voice message from its transcript", async () => {
    const h = harness(() => ({ ok: true, text: "What is the capital of France?" }));
    const alice = h.fake.addUser({ username: "alice" });
    const dm = h.fake.openDm(alice);
    await h.deliver(h.fake.postVoiceMessage({ authorId: alice, channelId: dm, data: OGG, durationSecs: 3 }));
    expect(h.runs.runs).toHaveLength(1);
    expect(sentText(h.runs.runs[0]!.body)).toContain(`[Transcript of a voice message from alice (discord:${alice})]\nWhat is the capital of France?`);
    expect(h.voice).toHaveBeenCalledWith(expect.objectContaining({ askerId: alice, userId: "svc_1" }));
    expect(botMessages(h.fake, dm).map((message) => message.content)).toEqual(["The answer."]);
  });

  it("lets a mention in a Reply to someone's voice message ask about what it says", async () => {
    const h = harness(() => ({ ok: true, text: "Lunch is at noon." }));
    const alice = h.fake.addUser({ username: "alice" });
    const bob = h.fake.addUser({ username: "bob" });
    const channelId = h.fake.channels.text;
    const target = h.fake.postVoiceMessage({ authorId: bob, channelId, data: OGG, durationSecs: 4 });
    await h.deliver(h.fake.postMessage({
      authorId: alice, channelId, content: `<@${h.fake.bot.id}> what does it say?`, mentions: [h.fake.bot.id], replyTo: target.id
    }));
    expect(h.runs.runs).toHaveLength(1);
    expect(sentText(h.runs.runs[0]!.body)).toContain(
      `Replying to bob (discord:${bob}), message ${target.id}:\n[Transcript of a voice message from bob (discord:${bob})]\nLunch is at noon.`
    );
    expect(h.voice).toHaveBeenCalledOnce();
    expect(h.voice.mock.calls[0]![0]).toMatchObject({ askerId: alice });
  });

  it("tells the asker why when a voice-only question cannot be transcribed, and starts no run", async () => {
    const h = harness(() => ({ ok: false, reason: "unavailable" }));
    const alice = h.fake.addUser({ username: "alice" });
    const dm = h.fake.openDm(alice);
    const question = await h.deliver(h.fake.postVoiceMessage({ authorId: alice, channelId: dm, data: OGG, durationSecs: 3 }));
    expect(h.runs.runs).toHaveLength(0);
    expect(botMessages(h.fake, dm).map((message) => message.content)).toEqual([discordFailureStatus(DISCORD_VOICE_COPY.unavailable.reply)]);
    expect(h.fake.reactionsBy(question.id, h.fake.bot.id)).toEqual([DISCORD_REACTION_FAILED]);
    expect(h.replies.rows.get(question.id)).toMatchObject({ code: "discord_voice_untranscribed", failureKind: "context", state: "failed" });
  });
});
