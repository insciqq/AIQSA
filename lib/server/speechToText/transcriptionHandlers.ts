import { DICTATION_AUDIO_MAX_BYTES, type TranscriptionErrorCode, type TranscriptionResponse } from "../../contracts/speechToText";
import type { UsageLimitRefusalResponse } from "../../contracts/usageLimits";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { RequestBodyTooLargeError, readBoundedFormData } from "../http/requestBody";
import { transcribeUserAudio, type TranscribeUserAudioDeps, type TranscriptionRefusal, type UserAudio } from "./transcribeUserAudio";

/** The audio part plus the multipart envelope. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const NO_STORE = { "cache-control": "no-store" } as const;

const REFUSAL_STATUS: Record<TranscriptionErrorCode, number> = {
  unauthorized: 401,
  multipart_required: 415,
  audio_required: 400,
  audio_too_large: 413,
  audio_type_unsupported: 415,
  dictation_unavailable: 503,
  dictation_rate_limited: 429,
  usage_limits_unavailable: 503,
  transcription_rejected: 422,
  transcription_busy: 503,
  transcription_timed_out: 504,
  transcription_failed: 502
};

function refusal(error: TranscriptionErrorCode, retryAfterSeconds?: number): Response {
  const headers = retryAfterSeconds === undefined ? NO_STORE : { ...NO_STORE, "retry-after": String(retryAfterSeconds) };
  return Response.json({ error }, { headers, status: REFUSAL_STATUS[error] });
}

function refusalResponse(result: TranscriptionRefusal): Response {
  if (!("usageLimit" in result)) return refusal(result.refusal, result.retryAfterSeconds);
  const body: UsageLimitRefusalResponse = { error: result.refusal, usageLimit: result.usageLimit };
  return Response.json(body, { headers: { ...NO_STORE, "retry-after": String(result.retryAfterSeconds) }, status: 429 });
}

export type TranscriptionHandlerDeps = TranscribeUserAudioDeps & Readonly<{ resolveAuth: RequestAuthResolver }>;

/**
 * `POST /api/me/transcriptions`: one dictation. Session-authenticated and
 * multipart; `transcribeUserAudio` owns admission, the audio checks, the
 * provider call and usage. The multipart body is read only once the attempt
 * is admitted, bounded to the audio cap plus its envelope.
 */
export function createTranscriptionHandler(deps: TranscriptionHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return refusal("unauthorized");
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "multipart/form-data") return refusal("multipart_required");

    const readAudio = async (): Promise<UserAudio | TranscriptionRefusal> => {
      let form: FormData;
      try {
        form = await readBoundedFormData(request, DICTATION_AUDIO_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return { refusal: "audio_too_large" };
        if (request.signal.aborted) throw error;
        return { refusal: "audio_required" };
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size < 1) return { refusal: "audio_required" };
      if (file.size > DICTATION_AUDIO_MAX_BYTES) return { refusal: "audio_too_large" };
      return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type };
    };

    const result = await transcribeUserAudio(deps, { audio: readAudio, signal: request.signal, userId: auth.userId });
    if ("refusal" in result) return refusalResponse(result);
    const response: TranscriptionResponse = { text: result.text };
    return Response.json(response, { headers: NO_STORE });
  };
}
