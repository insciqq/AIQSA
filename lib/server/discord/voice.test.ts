import { describe, expect, it, vi } from "vitest";
import { createFakeDiscord } from "@/tests/support/fakeDiscord";
import failureCodes from "../observability/failureCodes.json";
import {
  dictationRateLimitKey, type TranscribeUserAudioInput, type TranscribeUserAudioResult, type UserAudio
} from "../speechToText/transcribeUserAudio";
import { decodeDiscordContextMessage, type DiscordMentionNames } from "./bridge/messages";
import { createDiscordRest } from "./rest";
import { createDiscordVoice, DISCORD_VOICE_LOG_CODES, DISCORD_VOICE_MAX_SECONDS } from "./voice";

const OGG = Buffer.from("OggS\0\x02synthetic voice");

function setup(answer: (input: TranscribeUserAudioInput, audio: UserAudio | null) => TranscribeUserAudioResult = () => ({ text: "  hello there  " })) {
  const fake = createFakeDiscord();
  const rest = createDiscordRest({ token: () => fake.token, transport: fake.transport });
  const names: DiscordMentionNames = { botName: fake.bot.username, botRoleId: fake.botRoleId, botUserId: fake.bot.id };
  const alice = fake.addUser({ username: "alice" });
  const bob = fake.addUser({ username: "bob" });
  const heard: UserAudio[] = [];
  const transcribe = vi.fn(async (input: TranscribeUserAudioInput): Promise<TranscribeUserAudioResult> => {
    const audio = typeof input.audio === "function" ? await input.audio() : input.audio;
    if ("refusal" in audio) return audio;
    heard.push(audio);
    return answer(input, audio);
  });
  const download = vi.fn(fake.transport.download);
  // The fake's clock: its signed URLs are a day from expiry.
  const voice = createDiscordVoice({ download, now: () => Date.parse("2026-11-12T09:00:00.000Z"), rest: () => rest, transcribe });
  const decode = (message: Parameters<typeof decodeDiscordContextMessage>[0]) => decodeDiscordContextMessage(message, names)!;
  return { alice, bob, decode, download, fake, heard, transcribe, voice };
}

describe("Discord voice messages", () => {
  it("decodes the voice flag and the length, and leaves every other message without voice", () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const spoken = s.decode(s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 4.2 }));
    expect(spoken.voice).toMatchObject({ contentType: "audio/ogg", durationSecs: 4.2, filename: "voice-message.ogg", size: OGG.length });
    expect(spoken.text).toBe("");
    const file = s.decode(s.fake.postMessage({
      attachments: [{ contentType: "audio/ogg", data: OGG, filename: "song.ogg" }], authorId: s.alice, channelId: dm, content: "a song"
    }));
    expect(file.voice).toBeNull();
    expect(file.attachments[0]!.durationSecs).toBeNull();
  });

  it("transcribes as the service account, counting the window for the asking author, and returns the trimmed text", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const message = s.decode(s.fake.postVoiceMessage({ authorId: s.bob, channelId: dm, data: OGG, durationSecs: 3 }));
    const outcomes = await s.voice({ askerId: s.alice, messages: [message], userId: "svc_1" });
    expect(outcomes.get(message.id)).toEqual({ ok: true, text: "hello there" });
    expect(s.transcribe).toHaveBeenCalledWith(expect.objectContaining({ rateLimitSubject: `discord:${s.alice}`, userId: "svc_1" }));
    expect(s.heard).toEqual([{ bytes: new Uint8Array(OGG), mimeType: "audio/ogg" }]);
  });

  it("never sends a voice message over ten minutes to Speech to text", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const message = s.decode(s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: DISCORD_VOICE_MAX_SECONDS + 1 }));
    expect((await s.voice({ askerId: s.alice, messages: [message], userId: "svc_1" })).get(message.id)).toEqual({ ok: false, reason: "too_long" });
    expect(s.transcribe).not.toHaveBeenCalled();
    expect(s.download).not.toHaveBeenCalled();
  });

  it("renews an expired signed URL by reading the message again", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const posted = s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 2 });
    const message = s.decode(posted);
    s.fake.expireAttachmentUrls(dm, posted.id);
    expect((await s.voice({ askerId: s.alice, messages: [message], userId: "svc_1" })).get(message.id)).toEqual({ ok: true, text: "hello there" });
    expect(s.download).toHaveBeenCalledTimes(2);
    expect(s.fake.calls({ route: "get_channel_message" })).toHaveLength(1);
  });

  it("names why a voice message stayed without its text", async () => {
    const cases: ReadonlyArray<readonly [TranscribeUserAudioResult, unknown]> = [
      [{ refusal: "dictation_unavailable" }, { ok: false, reason: "unavailable" }],
      [{ refusal: "dictation_rate_limited", retryAfterSeconds: 125 }, { ok: false, reason: "rate_limited", retryAfterSeconds: 125 }],
      [{ refusal: "usage_budget_exhausted", retryAfterSeconds: 60, usageLimit: { limit: 1, resetsAt: "2026-12-01T00:00:00.000Z", scope: "user", used: 1, window: "month" } },
        { ok: false, reason: "usage_limit" }],
      [{ refusal: "transcription_timed_out" }, { ok: false, reason: "failed" }],
      [{ text: "   " }, { ok: false, reason: "no_speech" }]
    ];
    for (const [answer, expected] of cases) {
      const s = setup(() => answer);
      const dm = s.fake.openDm(s.alice);
      const message = s.decode(s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 2 }));
      expect((await s.voice({ askerId: s.alice, messages: [message], userId: "svc_1" })).get(message.id)).toEqual(expected);
    }
  });

  it("reports audio it could not download as unreadable", async () => {
    const s = setup();
    const dm = s.fake.openDm(s.alice);
    const posted = s.fake.postVoiceMessage({ authorId: s.alice, channelId: dm, data: OGG, durationSecs: 2 });
    const message = s.decode(posted);
    // The message is gone, so the refused URL cannot be renewed.
    s.fake.deleteMessage(dm, posted.id);
    s.download.mockResolvedValue({ kind: "http", ok: false, status: 404 });
    expect((await s.voice({ askerId: s.alice, messages: [message], userId: "svc_1" })).get(message.id)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("keeps one transcription window per Discord author within the service account's", () => {
    expect(dictationRateLimitKey("svc_1", "discord:1")).not.toBe(dictationRateLimitKey("svc_1", "discord:2"));
    expect(dictationRateLimitKey("svc_1", "discord:1")).not.toBe(dictationRateLimitKey("svc_1"));
    expect(dictationRateLimitKey("svc_1")).toBe("dictation:transcribe:user:svc_1");
  });

  it("registers its log codes", () => {
    for (const code of DISCORD_VOICE_LOG_CODES) expect((failureCodes as string[]).includes(code), code).toBe(true);
  });
});
