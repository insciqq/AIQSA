import type { Prisma } from "@prisma/client";
import {
  DICTATION_AUDIO_MAX_BYTES,
  dictationAudioMimeType,
  type DictationAudioMimeType,
  type TranscriptionErrorCode,
  type TranscriptionResponse
} from "../../contracts/speechToText";
import type { UsageLimitRefusalResponse } from "../../contracts/usageLimits";
import { decideUsageAdmission } from "../../domain/usageLimits";
import type { LoginRateLimiter } from "../auth/rateLimit";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { RequestBodyTooLargeError, readBoundedFormData } from "../http/requestBody";
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
/** The audio part plus the multipart envelope. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const NO_STORE = { "cache-control": "no-store" } as const;

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

function refusal(error: TranscriptionErrorCode, status: number, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { headers: { ...NO_STORE, ...headers }, status });
}

export type TranscriptionHandlerDeps = Readonly<{
  createAdapter?(binding: SpeechToTextConnectionBinding, modelId: string): AudioTranscriptionAdapter;
  now?(): Date;
  rateLimiter: Pick<LoginRateLimiter, "check">;
  resolveAuth: RequestAuthResolver;
  resolveRole(): Promise<SpeechToTextRoleResolution>;
  usageLimits: Pick<UsageLimitsRepository, "loadUsageLimitStatus">;
  writeUsage(data: Prisma.UsageEventUncheckedCreateInput): Promise<unknown>;
}>;

function defaultAdapter(binding: SpeechToTextConnectionBinding, modelId: string): AudioTranscriptionAdapter {
  return createAudioTranscriptionAdapter({ connection: binding.connection, providerFamily: binding.family,
    secret: binding.secret, upstreamModelId: modelId });
}

function providerRefusal(error: unknown): Response {
  if (error instanceof SpeechToTextCredentialRevokedError) return refusal("dictation_unavailable", 503);
  if (error instanceof AudioTranscriptionError) {
    if (error.code === "transcription_request_timed_out") return refusal("transcription_timed_out", 504);
    if (error.code === "transcription_provider_http_error") {
      const status = error.httpStatus ?? 0;
      if (status === 401 || status === 403) return refusal("dictation_unavailable", 503);
      if (status === 429) return refusal("transcription_busy", 503, { "retry-after": "30" });
      if (status >= 400 && status < 500 && status !== 408) return refusal("transcription_rejected", 422);
    }
  }
  return refusal("transcription_failed", 502);
}

/**
 * `POST /api/me/transcriptions`: one dictation. Session-authenticated; the
 * administrator role must be usable; the user's budget and the pooled cap are
 * checked like a non-interactive run (no message-window use); a per-user
 * window bounds attempts; the multipart audio is bounded, allowlisted and
 * signature-checked. One provider call, one personal `speech_to_text` usage
 * row, `{ text }` back. Audio and text exist only in this request: never
 * stored or logged, and telemetry carries codes and durations only.
 */
export function createTranscriptionHandler(deps: TranscriptionHandlerDeps) {
  const createAdapter = deps.createAdapter ?? defaultAdapter;
  return async function POST(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const auth = await deps.resolveAuth(request);
    if (!auth) return refusal("unauthorized", 401);
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "multipart/form-data") return refusal("multipart_required", 415);

    const role = await deps.resolveRole();
    if (!role.ok) return refusal("dictation_unavailable", 503);

    const now = deps.now?.() ?? new Date();
    let status: Awaited<ReturnType<UsageLimitsRepository["loadUsageLimitStatus"]>>;
    try {
      status = await deps.usageLimits.loadUsageLimitStatus(auth.userId, now);
    } catch (error) {
      logEvent("service_operation", { subsystem: "dictation", stage: "preflight", outcome: "failed", code: "usage_limits_unavailable",
        prisma_code: databaseFailureCode(error) });
      return refusal("usage_limits_unavailable", 503);
    }
    const decision = decideUsageAdmission({ ...status, interactive: false, now });
    if (!decision.ok) {
      const body: UsageLimitRefusalResponse = { error: decision.code, usageLimit: decision.facts };
      return Response.json(body, { headers: { ...NO_STORE, "retry-after": String(decision.retryAfterSeconds) }, status: 429 });
    }

    let limited: Awaited<ReturnType<LoginRateLimiter["check"]>>;
    try {
      limited = await deps.rateLimiter.check(dictationRateLimitKey(auth.userId), { maxAttempts: DICTATION_RATE_LIMIT });
    } catch {
      return refusal("dictation_unavailable", 503);
    }
    if (!limited.allowed) {
      return refusal("dictation_rate_limited", 429, { "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterSeconds))) });
    }

    let form: FormData;
    try {
      form = await readBoundedFormData(request, DICTATION_AUDIO_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return refusal("audio_too_large", 413);
      if (request.signal.aborted) throw error;
      return refusal("audio_required", 400);
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1) return refusal("audio_required", 400);
    if (file.size > DICTATION_AUDIO_MAX_BYTES) return refusal("audio_too_large", 413);
    const mimeType = dictationAudioMimeType(file.type);
    if (!mimeType) return refusal("audio_type_unsupported", 415);
    const audio = new Uint8Array(await file.arrayBuffer());
    if (audio.byteLength > DICTATION_AUDIO_MAX_BYTES) return refusal("audio_too_large", 413);
    if (!audioContentMatches(audio, mimeType)) return refusal("audio_type_unsupported", 415);

    const record = async (usage: Parameters<typeof transcriptionUsageEvent>[0]["usage"]) => {
      try {
        await deps.writeUsage(transcriptionUsageEvent({ family: role.binding.family, modelId: role.modelId,
          purpose: "speech_to_text", usage, userId: auth.userId }));
      } catch (error) {
        // The transcript is still returned: the call was paid and failing would lose the dictation.
        logEvent("service_operation", { subsystem: "dictation", stage: "settle", outcome: "failed",
          code: "speech_to_text_usage_unrecorded", prisma_code: databaseFailureCode(error) });
      }
    };

    try {
      const result = await createAdapter(role.binding, role.modelId).transcribe({ audio, mimeType, signal: request.signal });
      await record(result.usage);
      logEvent("service_operation", { subsystem: "dictation", stage: "process", outcome: "completed",
        duration_ms: Date.now() - startedAt });
      const response: TranscriptionResponse = { text: result.text };
      return Response.json(response, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof AudioTranscriptionError && error.code === "transcription_response_invalid") await record(error.usage);
      if (request.signal.aborted) {
        logEvent("service_operation", { subsystem: "dictation", stage: "process", outcome: "cancelled", duration_ms: Date.now() - startedAt });
        throw error;
      }
      logEvent("service_operation", { subsystem: "dictation", stage: "process", outcome: "failed", duration_ms: Date.now() - startedAt,
        code: error instanceof AudioTranscriptionError ? error.code : error instanceof SpeechToTextCredentialRevokedError ? "credential_revoked" : "transcription_failed",
        ...(error instanceof AudioTranscriptionError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
      return providerRefusal(error);
    }
  };
}
