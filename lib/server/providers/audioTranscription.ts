import {
  DICTATION_TEXT_MAX_CHARACTERS,
  dictationAudioExtension,
  type DictationAudioMimeType,
  type SpeechToTextProviderFamily
} from "../../contracts/speechToText";
import { reportedTokenCount } from "../../domain/usage";
import {
  ProviderResponseTooLargeError,
  isProviderDeadlineExceededError,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  normalizeProviderConnectionConfiguration,
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "./providerConfiguration";
import { resolveProviderCredentialSource, type ProviderCredentialSource } from "./providerCredentialSource";
import { createProviderSafeFetch } from "./providerSafeFetch";
import { reportedUsageCostUsd } from "./reportedUsageCost";

/** A transcript is short text; anything larger is not a transcription response. */
export const MAX_TRANSCRIPTION_RESPONSE_BYTES = 512 * 1024;
/** OpenRouter's upstream limit is 60 s; a slow local server gets a little more. */
export const MAX_TRANSCRIPTION_TIMEOUT_MS = 120_000;
/** Above the route's 10 MiB audio bound, below every documented provider cap. */
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 12 * 1024 * 1024;

export type AudioTranscriptionUsage = Readonly<{
  /** Audio duration the provider billed, when reported. */
  seconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** USD the provider reported for this call (`reportedUsageCostUsd`), else null. */
  costUsd: number | null;
}>;

export type AudioTranscriptionResult = Readonly<{
  text: string;
  /** Null when the provider reported no usage at all. */
  usage: AudioTranscriptionUsage | null;
}>;

export type AudioTranscriptionErrorCode =
  | "transcription_input_invalid"
  | "transcription_provider_http_error"
  | "transcription_provider_request_failed"
  | "transcription_request_timed_out"
  | "transcription_response_invalid"
  | "transcription_response_too_large";

export class AudioTranscriptionError extends Error {
  readonly httpStatus: number | null;
  /** What a response the adapter then rejected reported, so the paid call can be accounted. */
  readonly usage: AudioTranscriptionUsage | null;

  constructor(
    readonly code: AudioTranscriptionErrorCode,
    options: Readonly<{ httpStatus?: number; usage?: AudioTranscriptionUsage | null }> = {}
  ) {
    super(code);
    this.name = "AudioTranscriptionError";
    this.httpStatus = Number.isSafeInteger(options.httpStatus) && Number(options.httpStatus) >= 100 &&
      Number(options.httpStatus) <= 599 ? Number(options.httpStatus) : null;
    this.usage = options.usage ?? null;
  }
}

export type AudioTranscriptionRequest = Readonly<{
  audio: Uint8Array;
  mimeType: DictationAudioMimeType;
  signal?: AbortSignal;
}>;

export type AudioTranscriptionAdapter = Readonly<{
  transcribe(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lenient: a malformed field is unknown, never a reason to drop the transcript. */
export function parseTranscriptionUsage(value: unknown): AudioTranscriptionUsage | null {
  if (!record(value)) return null;
  const seconds = typeof value.seconds === "number" && Number.isFinite(value.seconds) && value.seconds >= 0
    ? value.seconds : null;
  const inputTokens = reportedTokenCount(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = reportedTokenCount(value.output_tokens ?? value.completion_tokens);
  const totalTokens = reportedTokenCount(value.total_tokens);
  const cost = reportedUsageCostUsd(value);
  const usage = { seconds, inputTokens, outputTokens, totalTokens, costUsd: typeof cost === "number" ? cost : null };
  return Object.values(usage).some((entry) => entry !== null) ? usage : null;
}

function responseBody(value: unknown): AudioTranscriptionResult {
  const usage = record(value) ? parseTranscriptionUsage(value.usage) : null;
  if (!record(value) || typeof value.text !== "string") {
    throw new AudioTranscriptionError("transcription_response_invalid", { usage });
  }
  const text = value.text.trim();
  if (text.length > DICTATION_TEXT_MAX_CHARACTERS) {
    throw new AudioTranscriptionError("transcription_response_invalid", { usage });
  }
  return { text, usage };
}

/** OpenRouter's `input_audio.format` for each admitted format. */
function openRouterFormat(type: DictationAudioMimeType): string {
  return dictationAudioExtension(type);
}

/**
 * Speech to text through `POST {apiRoot}/audio/transcriptions`.
 *
 * OpenRouter receives its documented JSON shape (base64 `input_audio`), which
 * alone carries the installation's `data_collection: "deny"` routing rule;
 * every other OpenAI-compatible server (OpenAI, Groq, local Whisper servers)
 * receives the standard multipart form (`file`, `model`, `response_format`).
 * One attempt, bounded audio, response and time; typed, content-free failures.
 * Audio and text are never retained.
 */
export function createAudioTranscriptionAdapter(input: Readonly<{
  connection: ProviderConnectionConfiguration;
  fetchFn?: typeof fetch;
  providerFamily: SpeechToTextProviderFamily;
  /** Null exactly for a no-authentication connection. */
  secret: ProviderCredentialSource | null;
  timeoutMs?: number;
  upstreamModelId: string;
}>): AudioTranscriptionAdapter {
  const connection = normalizeProviderConnectionConfiguration(input.connection);
  const bearer = providerAuthenticationMode(connection) === "bearer";
  if (bearer !== (input.secret !== null) || !input.upstreamModelId.trim() || input.upstreamModelId.length > 256 ||
    input.providerFamily === "openrouter" && !bearer) {
    throw new AudioTranscriptionError("transcription_input_invalid");
  }
  const fetchFn = input.fetchFn ?? createProviderSafeFetch({ configuration: connection });
  const timeoutMs = Math.min(input.timeoutMs ?? connection.responseTimeoutMs, MAX_TRANSCRIPTION_TIMEOUT_MS);
  const endpoint = `${connection.apiRoot}/audio/transcriptions`;

  return Object.freeze({
    async transcribe(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResult> {
      if (!(request.audio instanceof Uint8Array) || request.audio.byteLength < 1 ||
        request.audio.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
        throw new AudioTranscriptionError("transcription_input_invalid");
      }
      const timeout = withTimeoutSignal(request.signal, timeoutMs);
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (input.secret !== null) {
          headers.authorization = `Bearer ${await resolveProviderCredentialSource(input.secret, "transcription_provider_request_failed")}`;
        }
        let body: BodyInit;
        if (input.providerFamily === "openrouter") {
          headers["content-type"] = "application/json";
          body = JSON.stringify({
            input_audio: { data: Buffer.from(request.audio).toString("base64"), format: openRouterFormat(request.mimeType) },
            model: input.upstreamModelId,
            provider: { data_collection: "deny" },
            response_format: "json"
          });
        } else {
          const form = new FormData();
          form.append("file", new Blob([request.audio], { type: request.mimeType }),
            `audio.${dictationAudioExtension(request.mimeType)}`);
          form.append("model", input.upstreamModelId);
          form.append("response_format", "json");
          body = form;
        }
        const response = await fetchFn(endpoint, { body, headers, method: "POST", redirect: "error", signal: timeout.signal });
        const text = await readBoundedResponseText(response, { maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES, signal: timeout.signal });
        if (!response.ok) throw new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: response.status });
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new AudioTranscriptionError("transcription_response_invalid");
        }
        return responseBody(parsed);
      } catch (error) {
        if (error instanceof AudioTranscriptionError) throw error;
        if (error instanceof ProviderResponseTooLargeError) throw new AudioTranscriptionError("transcription_response_too_large");
        if (isProviderDeadlineExceededError(error) ||
          timeout.signal.aborted && isProviderDeadlineExceededError(timeout.signal.reason)) {
          throw new AudioTranscriptionError("transcription_request_timed_out");
        }
        if (request.signal?.aborted) throw error;
        throw new AudioTranscriptionError("transcription_provider_request_failed");
      } finally {
        timeout.clear();
      }
    }
  });
}
