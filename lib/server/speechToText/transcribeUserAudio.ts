import type { Prisma } from "@prisma/client";
import {
  DICTATION_AUDIO_MAX_BYTES,
  dictationAudioMimeType,
  type DictationAudioMimeType,
  type TranscriptionErrorCode,
  type TranscriptionResponse
} from "../../contracts/speechToText";
import type { UsageLimitRefusalCode, UsageLimitRefusalFacts } from "../../contracts/usageLimits";
import { decideUsageAdmission } from "../../domain/usageLimits";
import type { LoginRateLimiter } from "../auth/rateLimit";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  AudioTranscriptionError,
  createAudioTranscriptionAdapter,
  type AudioTranscriptionAdapter
} from "../providers/audioTranscription";
import type { UsageLimitsRepository } from "../usageLimits/repository";
import { SpeechToTextCredentialRevokedError, type SpeechToTextConnectionBinding, type SpeechToTextRoleResolution } from "./role";
import { transcriptionUsageEvent } from "./usage";

/** Dictations per user and window; each attempt that reaches the provider step counts. */
export const DICTATION_RATE_LIMIT = 20;
export const DICTATION_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;

export function dictationRateLimitKey(userId: string): string {
  return `dictation:transcribe:user:${userId}`;
}

/** Whether the bytes carry the container signature of the declared type. */
export function audioContentMatches(bytes: Uint8Array, type: DictationAudioMimeType): boolean {
  const ascii = (offset: number, text: string) =>
    bytes.length >= offset + text.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  switch (type) {
    case "audio/webm": return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case "audio/ogg": return ascii(0, "OggS");
    case "audio/mp4": return ascii(4, "ftyp");
    case "audio/mpeg": return ascii(0, "ID3") || bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
    case "audio/wav": return ascii(0, "RIFF") && ascii(8, "WAVE");
  }
}

/** Refusals of one transcription; the caller's transport owns `unauthorized` and `multipart_required`. */
export type TranscriptionRefusal =
  | Readonly<{ refusal: Exclude<TranscriptionErrorCode, "unauthorized" | "multipart_required">; retryAfterSeconds?: number }>
  | Readonly<{ refusal: UsageLimitRefusalCode; retryAfterSeconds: number; usageLimit: UsageLimitRefusalFacts }>;

export type TranscribeUserAudioResult = TranscriptionResponse | TranscriptionRefusal;

/** Audio as received; the MIME value is untrusted and allowlisted here. */
export type UserAudio = Readonly<{ bytes: Uint8Array; mimeType: string }>;

export type TranscribeUserAudioDeps = Readonly<{
  createAdapter?(binding: SpeechToTextConnectionBinding, modelId: string): AudioTranscriptionAdapter;
  now?(): Date;
  rateLimiter: Pick<LoginRateLimiter, "check">;
  resolveRole(): Promise<SpeechToTextRoleResolution>;
  usageLimits: Pick<UsageLimitsRepository, "loadUsageLimitStatus">;
  writeUsage(data: Prisma.UsageEventUncheckedCreateInput): Promise<unknown>;
}>;

export type TranscribeUserAudioInput = Readonly<{
  /**
   * The audio, or a reader called only once the attempt is admitted, so a
   * refused attempt never reads a request body. A reader may refuse itself
   * (missing or oversize part) and may throw when its request was aborted.
   */
  audio: UserAudio | (() => Promise<UserAudio | TranscriptionRefusal>);
  signal?: AbortSignal;
  /** The authenticated user the dictation and its usage row belong to. */
  userId: string;
}>;

function defaultAdapter(binding: SpeechToTextConnectionBinding, modelId: string): AudioTranscriptionAdapter {
  return createAudioTranscriptionAdapter({ connection: binding.connection, providerFamily: binding.family,
    secret: binding.secret, upstreamModelId: modelId });
}

function providerRefusal(error: unknown): TranscriptionRefusal {
  if (error instanceof SpeechToTextCredentialRevokedError) return { refusal: "dictation_unavailable" };
  if (error instanceof AudioTranscriptionError) {
    if (error.code === "transcription_request_timed_out") return { refusal: "transcription_timed_out" };
    if (error.code === "transcription_provider_http_error") {
      const status = error.httpStatus ?? 0;
      if (status === 401 || status === 403) return { refusal: "dictation_unavailable" };
      if (status === 429) return { refusal: "transcription_busy", retryAfterSeconds: 30 };
      if (status >= 400 && status < 500 && status !== 408) return { refusal: "transcription_rejected" };
    }
  }
  return { refusal: "transcription_failed" };
}

/**
 * One user's transcription through the administrator's Speech to text role,
 * for any server caller (the dictation route, a messenger voice message).
 * The role must be usable; the user's budget and the pooled cap are checked
 * like a non-interactive run (no message-window use); a per-user window
 * bounds attempts; the audio is bounded, allowlisted and signature-checked.
 * One provider call, one personal `speech_to_text` usage row, `{ text }`
 * back. Audio and text are never stored or logged; telemetry carries codes
 * and durations only. Throws only when `signal` was aborted.
 */
export async function transcribeUserAudio(deps: TranscribeUserAudioDeps, input: TranscribeUserAudioInput): Promise<TranscribeUserAudioResult> {
  const startedAt = Date.now();
  const role = await deps.resolveRole();
  if (!role.ok) return { refusal: "dictation_unavailable" };

  const now = deps.now?.() ?? new Date();
  let status: Awaited<ReturnType<UsageLimitsRepository["loadUsageLimitStatus"]>>;
  try {
    status = await deps.usageLimits.loadUsageLimitStatus(input.userId, now);
  } catch (error) {
    logEvent("service_operation", { subsystem: "dictation", stage: "preflight", outcome: "failed", code: "usage_limits_unavailable",
      prisma_code: databaseFailureCode(error) });
    return { refusal: "usage_limits_unavailable" };
  }
  const decision = decideUsageAdmission({ ...status, interactive: false, now });
  if (!decision.ok) return { refusal: decision.code, retryAfterSeconds: decision.retryAfterSeconds, usageLimit: decision.facts };

  let limited: Awaited<ReturnType<LoginRateLimiter["check"]>>;
  try {
    limited = await deps.rateLimiter.check(dictationRateLimitKey(input.userId), { maxAttempts: DICTATION_RATE_LIMIT });
  } catch {
    return { refusal: "dictation_unavailable" };
  }
  if (!limited.allowed) return { refusal: "dictation_rate_limited", retryAfterSeconds: Math.max(1, Math.ceil(limited.retryAfterSeconds)) };

  const received = typeof input.audio === "function" ? await input.audio() : input.audio;
  if ("refusal" in received) return received;
  const audio = received.bytes;
  if (audio.byteLength < 1) return { refusal: "audio_required" };
  if (audio.byteLength > DICTATION_AUDIO_MAX_BYTES) return { refusal: "audio_too_large" };
  const mimeType = dictationAudioMimeType(received.mimeType);
  if (!mimeType || !audioContentMatches(audio, mimeType)) return { refusal: "audio_type_unsupported" };

  const record = async (usage: Parameters<typeof transcriptionUsageEvent>[0]["usage"]) => {
    try {
      await deps.writeUsage(transcriptionUsageEvent({ family: role.binding.family, modelId: role.modelId,
        purpose: "speech_to_text", usage, userId: input.userId }));
    } catch (error) {
      // The transcript is still returned: the call was paid and failing would lose the dictation.
      logEvent("service_operation", { subsystem: "dictation", stage: "settle", outcome: "failed",
        code: "speech_to_text_usage_unrecorded", prisma_code: databaseFailureCode(error) });
    }
  };

  const createAdapter = deps.createAdapter ?? defaultAdapter;
  try {
    const result = await createAdapter(role.binding, role.modelId).transcribe({ audio, mimeType, signal: input.signal });
    await record(result.usage);
    logEvent("service_operation", { subsystem: "dictation", stage: "process", outcome: "completed",
      duration_ms: Date.now() - startedAt });
    return { text: result.text };
  } catch (error) {
    if (error instanceof AudioTranscriptionError && error.code === "transcription_response_invalid") await record(error.usage);
    if (input.signal?.aborted) {
      logEvent("service_operation", { subsystem: "dictation", stage: "process", outcome: "cancelled", duration_ms: Date.now() - startedAt });
      throw error;
    }
    logEvent("service_operation", { subsystem: "dictation", stage: "process", outcome: "failed", duration_ms: Date.now() - startedAt,
      code: error instanceof AudioTranscriptionError ? error.code : error instanceof SpeechToTextCredentialRevokedError ? "credential_revoked" : "transcription_failed",
      ...(error instanceof AudioTranscriptionError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
    return providerRefusal(error);
  }
}
