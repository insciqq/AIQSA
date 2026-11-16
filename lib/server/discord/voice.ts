import { DICTATION_AUDIO_MAX_BYTES, DICTATION_MAX_DURATION_MS } from "../../contracts/speechToText";
import { isUsageLimitRefusalCode } from "../../contracts/usageLimits";
import type { TranscribeUserAudioInput, TranscribeUserAudioResult, TranscriptionRefusal } from "../speechToText/transcribeUserAudio";
import { logDiscordBridgeFailure } from "./bridge/journal";
import type { DiscordContextAttachment, DiscordContextMessage } from "./bridge/messages";
import type { DiscordRest } from "./rest";
import type { DiscordTransport } from "./transport";

/**
 * Discord voice messages a question asks with or replies to, as text
 * (operator decision 2026-11-16, replacing PRD §17's "out of v1"): the
 * question's own voice messages (the trigger and those joined to it) and the
 * Reply target's go through the administrator's Speech to text role
 * (`transcribeUserAudio`) as the service account, whose budgets they count
 * against, while the 20-per-10-minutes window counts each asking Discord
 * author on their own. History's voice messages stay named, untranscribed. A
 * voice message over 10 minutes or 10 MiB never reaches the provider. The
 * audio comes from Discord's CDN through the Discord transport, the signed URL
 * renewed by reading the message again; audio and transcript live only in
 * this turn's text and are never stored or logged (a recovered question is
 * transcribed again). Logs carry codes only.
 */

export const DISCORD_VOICE_MAX_SECONDS = DICTATION_MAX_DURATION_MS / 1_000;
export const DISCORD_VOICE_MAX_BYTES = DICTATION_AUDIO_MAX_BYTES;
/** A signed URL this close to its expiry is renewed before the download. */
const EXPIRY_MARGIN_MS = 30_000;

/** Every code this module logs; registered in the failure-code registry. */
export const DISCORD_VOICE_LOG_CODES = ["discord_voice_untranscribed"] as const;

/** Why a voice message stayed without its text. */
export type DiscordVoiceFailure = "unavailable" | "too_long" | "rate_limited" | "usage_limit" | "unreadable" | "no_speech" | "failed";

export type DiscordVoiceOutcome =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; reason: DiscordVoiceFailure; retryAfterSeconds?: number }>;

/**
 * Transcribes the turn's voice messages one after another, as `userId` (the
 * service account) for `askerId` (the Discord author who asked): message id →
 * its outcome.
 */
export type DiscordVoiceHook = (input: Readonly<{
  userId: string;
  askerId: string;
  messages: readonly DiscordContextMessage[];
}>) => Promise<ReadonlyMap<string, DiscordVoiceOutcome>>;

export type DiscordVoiceDeps = Readonly<{
  /** `transcribeUserAudio` with the installation's dependencies. */
  transcribe(input: TranscribeUserAudioInput): Promise<TranscribeUserAudioResult>;
  download: DiscordTransport["download"];
  rest: () => DiscordRest;
  now?: () => number;
}>;

/** The signed URL's expiry (`ex`, hexadecimal seconds); null when it names none. */
function expiresAt(url: string): number | null {
  try {
    const ex = new URL(url).searchParams.get("ex");
    return ex && /^[0-9a-f]{1,12}$/iu.test(ex) ? Number.parseInt(ex, 16) * 1_000 : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Whether the attachment is past the bounds Speech to text takes, by what Discord states. */
export function discordVoiceTooLong(attachment: Pick<DiscordContextAttachment, "durationSecs" | "size">): boolean {
  return (attachment.durationSecs !== null && attachment.durationSecs > DISCORD_VOICE_MAX_SECONDS) ||
    (attachment.size !== null && attachment.size > DISCORD_VOICE_MAX_BYTES);
}

function failure(refusal: TranscriptionRefusal, downloadFailed: boolean): DiscordVoiceOutcome {
  const code = refusal.refusal;
  if (code === "dictation_unavailable") return { ok: false, reason: "unavailable" };
  if (code === "dictation_rate_limited") return { ok: false, reason: "rate_limited", retryAfterSeconds: refusal.retryAfterSeconds ?? 60 };
  if (isUsageLimitRefusalCode(code) || code === "usage_limits_unavailable") return { ok: false, reason: "usage_limit" };
  if (code === "audio_too_large") return { ok: false, reason: "too_long" };
  if (code === "audio_required" && downloadFailed) return { ok: false, reason: "unreadable" };
  return { ok: false, reason: "failed" };
}

export function createDiscordVoice(deps: DiscordVoiceDeps): DiscordVoiceHook {
  const now = deps.now ?? Date.now;

  /** The audio's bytes; the message is read again when its URL expired or was refused. */
  async function audio(message: DiscordContextMessage, attachment: DiscordContextAttachment): Promise<Buffer | "too_large" | null> {
    const fresh = async (): Promise<string | null> => {
      const answer = await deps.rest().getChannelMessage(message.channelId, message.id).catch(() => null);
      if (!answer?.ok) return null;
      const list = record(answer.value)?.attachments;
      const entry = Array.isArray(list) ? list.map(record).find((item) => item?.id === attachment.id) : null;
      return typeof entry?.url === "string" ? entry.url : typeof entry?.proxy_url === "string" ? entry.proxy_url : null;
    };
    let url = attachment.url ?? attachment.proxyUrl;
    let renewed = false;
    const expiry = url ? expiresAt(url) : null;
    if (!url || (expiry !== null && expiry <= now() + EXPIRY_MARGIN_MS)) {
      url = await fresh();
      renewed = true;
    }
    for (;;) {
      if (!url) return null;
      const result = await deps.download({ maxBytes: DISCORD_VOICE_MAX_BYTES, url }).catch(() => null);
      if (result && result.ok) return result.body;
      if (result && !result.ok && result.kind === "too_large") return "too_large";
      // An expired or revoked signature answers 403 or 404: the message read again carries a fresh one.
      if (!renewed && result && !result.ok && result.kind === "http" && (result.status === 403 || result.status === 404 || result.status === 410)) {
        url = await fresh();
        renewed = true;
        continue;
      }
      logDiscordBridgeFailure({ code: "discord_attachment_download_failed", outcome: "skipped" });
      return null;
    }
  }

  async function transcribeOne(userId: string, askerId: string, message: DiscordContextMessage): Promise<DiscordVoiceOutcome> {
    const attachment = message.voice!;
    if (discordVoiceTooLong(attachment)) return { ok: false, reason: "too_long" };
    let downloadFailed = false;
    const result = await deps.transcribe({
      async audio() {
        const bytes = await audio(message, attachment);
        if (bytes === "too_large") return { refusal: "audio_too_large" };
        if (!bytes) {
          downloadFailed = true;
          return { refusal: "audio_required" };
        }
        return { bytes: new Uint8Array(bytes), mimeType: attachment.contentType ?? "audio/ogg" };
      },
      rateLimitSubject: `discord:${askerId}`,
      userId
    }).catch((): TranscribeUserAudioResult => ({ refusal: "transcription_failed" }));
    if ("refusal" in result) return failure(result, downloadFailed);
    const text = result.text.trim();
    return text ? { ok: true, text } : { ok: false, reason: "no_speech" };
  }

  return async ({ askerId, messages, userId }) => {
    const outcomes = new Map<string, DiscordVoiceOutcome>();
    for (const message of messages) {
      if (!message.voice || outcomes.has(message.id)) continue;
      const outcome = await transcribeOne(userId, askerId, message);
      if (!outcome.ok) logDiscordBridgeFailure({ code: "discord_voice_untranscribed", outcome: "skipped" });
      outcomes.set(message.id, outcome);
    }
    return outcomes;
  };
}
