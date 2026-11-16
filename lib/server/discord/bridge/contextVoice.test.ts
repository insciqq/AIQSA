import { describe, expect, it, vi } from "vitest";
import { createFakeDiscord, type FakeDiscordMessage } from "@/tests/support/fakeDiscord";
import { DISCORD_VOICE_COPY } from "../copy";
import { createDiscordRest } from "../rest";
import type { DiscordVoiceHook, DiscordVoiceOutcome } from "../voice";
import { readDiscordTurnContext, type DiscordAttachmentHook, type DiscordContextScope } from "./context";
import { decodeDiscordContextMessage, type DiscordMentionNames } from "./messages";

const OGG = Buffer.from("OggS\0\x02synthetic voice");

function setup() {
  const fake = createFakeDiscord();
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const names: DiscordMentionNames = { botName: fake.bot.username, botRoleId: fake.botRoleId, botUserId: fake.bot.id };
  const alice = fake.addUser({ globalName: "Alice", username: "alice" });
  const bob = fake.addUser({ username: "bob" });
  const seen: Parameters<DiscordAttachmentHook>[0][] = [];
  const attachments: DiscordAttachmentHook = async (input) => {
    seen.push(input);
    return { blocks: [], notes: [] };
  };
  return { alice, attachments, bob, fake, names, rest, seen };
}

type Setup = ReturnType<typeof setup>;

/** A voice hook that answers every message with `outcome`. */
function hearing(outcome: (messageId: string) => DiscordVoiceOutcome) {
  return vi.fn<DiscordVoiceHook>(async ({ messages }) => new Map(messages.map((message) => [message.id, outcome(message.id)] as const)));
}

async function read(s: Setup, message: FakeDiscordMessage, scope: DiscordContextScope, voice?: DiscordVoiceHook) {
  return readDiscordTurnContext({
    attachments: s.attachments, conversationId: null, facts: { aiqsaMessages: async () => new Map() }, header: "Header.",
    mergeWindowMs: 0, names: s.names, rest: s.rest, scope, trigger: decodeDiscordContextMessage(message, s.names)!, uploads: null,
    userId: "svc_1", ...(voice ? { voice } : {})
  });
}

describe("Discord turn context: voice messages", () => {
  it("gives a direct message's voice question its transcript as its text, marked, and its audio no attachment", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const question = s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 3 });
    const voice = hearing(() => ({ ok: true, text: "What is the capital of France?" }));
    const context = await read(s, question, { channelId: dm, kind: "channel_window" }, voice);
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.text).toContain(`Question from Alice (discord:${s.alice}):\n[Transcript of a voice message from Alice (discord:${s.alice})]\nWhat is the capital of France?`);
    expect(context.text).not.toContain("voice-message.ogg");
    expect(voice).toHaveBeenCalledWith(expect.objectContaining({ askerId: s.alice, userId: "svc_1" }));
    expect(s.seen[0]!.question[0]!.attachments).toEqual([]);
  });

  it("transcribes the voice message a mention replies to, for the asker, and leaves history's voice messages named", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    const earlier = s.fake.postVoiceMessage({ authorId: s.bob, channelId, data: OGG, durationSecs: 2 });
    const target = s.fake.postVoiceMessage({ authorId: s.bob, channelId, data: OGG, durationSecs: 5 });
    const question = s.fake.postMessage({
      authorId: s.alice, channelId, content: `<@${s.fake.bot.id}> what does it say?`, mentions: [s.fake.bot.id], replyTo: target.id
    });
    const voice = hearing(() => ({ ok: true, text: "Lunch is at noon." }));
    const context = await read(s, question, { channelId, kind: "channel_window" }, voice);
    if (!context.ok) throw new Error(context.code);
    expect(context.text).toContain(
      `Replying to bob (discord:${s.bob}), message ${target.id}:\n[Transcript of a voice message from bob (discord:${s.bob})]\nLunch is at noon.`
    );
    expect(voice).toHaveBeenCalledOnce();
    expect(voice.mock.calls[0]![0]).toMatchObject({ askerId: s.alice, messages: [expect.objectContaining({ id: target.id })] });
    // History keeps its voice messages as names: nobody asked about them.
    expect(context.text).toContain(`bob (discord:${s.bob}):  [attachments: voice-message.ogg]`);
    expect(s.seen[0]!.reference!.attachments).toEqual([]);
    expect(s.seen[0]!.history.find((message) => message.id === earlier.id)!.attachments).toHaveLength(1);
  });

  it("runs a mention whose replied voice message could not be transcribed, with a line why", async () => {
    const s = setup();
    const channelId = s.fake.channels.text;
    const target = s.fake.postVoiceMessage({ authorId: s.bob, channelId, data: OGG, durationSecs: 5 });
    const question = s.fake.postMessage({
      authorId: s.alice, channelId, content: `<@${s.fake.bot.id}> what does it say?`, mentions: [s.fake.bot.id], replyTo: target.id
    });
    const context = await read(s, question, { channelId, kind: "channel_window" }, hearing(() => ({ ok: false, reason: "unavailable" })));
    if (!context.ok) throw new Error(context.code);
    expect(context.text).toContain(`[A voice message from bob (discord:${s.bob}) could not be transcribed: ${DISCORD_VOICE_COPY.unavailable.line}]`);
  });

  it("refuses a question that is only a voice message it could not transcribe, with the reason", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const question = s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 3 });
    expect(await read(s, question, { channelId: dm, kind: "channel_window" }, hearing(() => ({ ok: false, reason: "unavailable" }))))
      .toEqual({ code: "discord_voice_untranscribed", ok: false, text: DISCORD_VOICE_COPY.unavailable.reply });
    expect(await read(s, question, { channelId: dm, kind: "channel_window" },
      hearing(() => ({ ok: false, reason: "rate_limited", retryAfterSeconds: 125 }))))
      .toMatchObject({ code: "discord_voice_untranscribed", text: `${DISCORD_VOICE_COPY.rate_limited.reply} Try again in 3 min.` });
    expect(s.seen).toEqual([]);
  });

  it("names a voice message like any file without a voice hook", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const question = s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 3 });
    const context = await read(s, question, { channelId: dm, kind: "channel_window" });
    if (!context.ok) throw new Error(context.code);
    expect(context.text).toContain("[attachments: voice-message.ogg]");
    expect(s.seen[0]!.question[0]!.attachments).toHaveLength(1);
  });
});
