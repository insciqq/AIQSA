import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { DICTATION_AUDIO_MAX_BYTES } from "../../contracts/speechToText";
import { AudioTranscriptionError, type AudioTranscriptionAdapter } from "../providers/audioTranscription";
import type { UsageLimitStatus } from "../usageLimits/repository";
import { SpeechToTextCredentialRevokedError, type SpeechToTextConnectionBinding, type SpeechToTextRoleResolution } from "./role";
import {
  audioContentMatches,
  dictationRateLimitKey,
  transcribeUserAudio,
  type TranscribeUserAudioDeps,
  type UserAudio
} from "./transcribeUserAudio";

const NO_LIMITS: UsageLimitStatus = {
  effective: { exempt: false, messagesPerDay: { source: null, value: null }, messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null } },
  installationCapMicros: null, installationSpentMicros: 0,
  lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null }, userSpentMicros: 0
};
const BUDGET_EXHAUSTED: UsageLimitStatus = { ...NO_LIMITS,
  effective: { ...NO_LIMITS.effective, monthlyBudgetMicros: { source: { kind: "user" }, value: 1_000_000 } }, userSpentMicros: 1_000_000 };

const binding = { connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
  connectionDisplayName: "OpenRouter", connectionId: "c1", credentialId: "k", credentialVersionId: "kv", family: "openrouter",
  secret: async () => "key" } satisfies SpeechToTextConnectionBinding;
/** A Telegram-style voice message: OGG/Opus bytes. */
const OGG: UserAudio = { bytes: new TextEncoder().encode("OggS\0\x02voice"), mimeType: "audio/ogg" };
const PRIVATE_TEXT = "PRIVATE_VOICE_TEXT";

function setup(overrides: Partial<TranscribeUserAudioDeps> & { transcribe?: AudioTranscriptionAdapter["transcribe"] } = {}) {
  const usage: Prisma.UsageEventUncheckedCreateInput[] = [];
  const transcribe = vi.fn<AudioTranscriptionAdapter["transcribe"]>(overrides.transcribe ??
    (async () => ({ text: PRIVATE_TEXT, usage: { costUsd: 0.0006, inputTokens: null, outputTokens: null, seconds: 12, totalTokens: null } })));
  const rateLimiter = { check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) };
  const deps: TranscribeUserAudioDeps = {
    createAdapter: () => ({ transcribe }),
    rateLimiter,
    resolveRole: async (): Promise<SpeechToTextRoleResolution> => ({ binding, modelId: "openai/whisper-1", ok: true }),
    usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS },
    writeUsage: async (data) => { usage.push(data); },
    ...overrides
  };
  return { deps, rateLimiter, transcribe, usage };
}

afterEach(() => vi.restoreAllMocks());

describe("transcribeUserAudio", () => {
  it("transcribes OGG bytes once, records one personal speech_to_text row and never logs the text", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { deps, rateLimiter, transcribe, usage } = setup();
    expect(await transcribeUserAudio(deps, { audio: OGG, userId: "user-1" })).toEqual({ text: PRIVATE_TEXT });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ audio: OGG.bytes, mimeType: "audio/ogg" }));
    expect(rateLimiter.check).toHaveBeenCalledWith(dictationRateLimitKey("user-1"), { maxAttempts: 20 });
    expect(usage).toEqual([expect.objectContaining({ purpose: "speech_to_text", userId: "user-1", provider: "openrouter",
      modelId: "openai/whisper-1", providerModelId: null, estimatedCostMicros: 600 })]);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(PRIVATE_TEXT);
  });

  it("refuses when the role is not usable, before budget, rate limit or audio", async () => {
    const audio = vi.fn(async () => OGG);
    const { deps, rateLimiter, transcribe } = setup({ resolveRole: async () => ({ ok: false, reason: "not_configured" }) });
    expect(await transcribeUserAudio(deps, { audio, userId: "user-1" })).toEqual({ refusal: "dictation_unavailable" });
    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(audio).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("refuses an exhausted budget with its facts and fails closed when usage cannot be read", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const audio = vi.fn(async () => OGG);
    const refused = setup({ usageLimits: { loadUsageLimitStatus: async () => BUDGET_EXHAUSTED } });
    expect(await transcribeUserAudio(refused.deps, { audio, userId: "user-1" })).toMatchObject({
      refusal: "usage_budget_exhausted", retryAfterSeconds: expect.any(Number), usageLimit: { scope: "user", window: "month" }
    });
    expect(refused.rateLimiter.check).not.toHaveBeenCalled();
    expect(audio).not.toHaveBeenCalled();
    const unreadable = setup({ usageLimits: { loadUsageLimitStatus: async () => { throw new Error("db"); } } });
    expect(await transcribeUserAudio(unreadable.deps, { audio: OGG, userId: "user-1" })).toEqual({ refusal: "usage_limits_unavailable" });
    expect(unreadable.transcribe).not.toHaveBeenCalled();
  });

  it("applies the per-user window and fails closed when the limiter is down", async () => {
    const audio = vi.fn(async () => OGG);
    const { deps, rateLimiter, transcribe } = setup();
    rateLimiter.check.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 120.2 });
    expect(await transcribeUserAudio(deps, { audio, userId: "user-1" })).toEqual({ refusal: "dictation_rate_limited", retryAfterSeconds: 121 });
    rateLimiter.check.mockRejectedValueOnce(new Error("down"));
    expect(await transcribeUserAudio(deps, { audio, userId: "user-1" })).toEqual({ refusal: "dictation_unavailable" });
    expect(audio).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("bounds and validates the audio: required, size, allowlisted type and matching signature", async () => {
    const { deps, rateLimiter, transcribe } = setup();
    const run = (audio: UserAudio) => transcribeUserAudio(deps, { audio, userId: "user-1" });
    expect(await run({ bytes: new Uint8Array(), mimeType: "audio/ogg" })).toEqual({ refusal: "audio_required" });
    const oversize = new Uint8Array(DICTATION_AUDIO_MAX_BYTES + 1);
    oversize.set(OGG.bytes);
    expect(await run({ bytes: oversize, mimeType: "audio/ogg" })).toEqual({ refusal: "audio_too_large" });
    expect(await run({ ...OGG, mimeType: "video/ogg" })).toEqual({ refusal: "audio_type_unsupported" });
    expect(await run({ ...OGG, mimeType: "audio/webm" })).toEqual({ refusal: "audio_type_unsupported" });
    expect(await run({ bytes: new Uint8Array([1, 2, 3, 4, 5]), mimeType: "audio/ogg" })).toEqual({ refusal: "audio_type_unsupported" });
    expect(rateLimiter.check).toHaveBeenCalledTimes(5);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("reads lazily supplied audio only after admission and passes the reader's refusal through", async () => {
    const { deps, transcribe } = setup();
    expect(await transcribeUserAudio(deps, { audio: async () => ({ refusal: "audio_too_large" }), userId: "user-1" }))
      .toEqual({ refusal: "audio_too_large" });
    expect(await transcribeUserAudio(deps, { audio: async () => OGG, userId: "user-1" })).toEqual({ text: PRIVATE_TEXT });
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("maps provider failures to stable codes and accounts a paid invalid response", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const cases: Array<[unknown, object]> = [
      [new AudioTranscriptionError("transcription_request_timed_out"), { refusal: "transcription_timed_out" }],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 400 }), { refusal: "transcription_rejected" }],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 429 }), { refusal: "transcription_busy", retryAfterSeconds: 30 }],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 403 }), { refusal: "dictation_unavailable" }],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 408 }), { refusal: "transcription_failed" }],
      [new AudioTranscriptionError("transcription_provider_request_failed"), { refusal: "transcription_failed" }],
      [new SpeechToTextCredentialRevokedError(), { refusal: "dictation_unavailable" }]
    ];
    for (const [error, expected] of cases) {
      const { deps, usage } = setup({ transcribe: async () => { throw error; } });
      expect(await transcribeUserAudio(deps, { audio: OGG, userId: "user-1" })).toEqual(expected);
      expect(usage).toEqual([]);
    }
    const invalid = setup({ transcribe: async () => {
      throw new AudioTranscriptionError("transcription_response_invalid", { usage: { costUsd: 0.001, inputTokens: null, outputTokens: null, seconds: 2, totalTokens: null } });
    } });
    expect(await transcribeUserAudio(invalid.deps, { audio: OGG, userId: "user-1" })).toEqual({ refusal: "transcription_failed" });
    expect(invalid.usage).toEqual([expect.objectContaining({ purpose: "speech_to_text", estimatedCostMicros: 1_000 })]);
  });

  it("rethrows a provider failure after its caller aborted", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const controller = new AbortController();
    const aborted = new Error("aborted");
    const { deps } = setup({ transcribe: async () => { controller.abort(); throw aborted; } });
    await expect(transcribeUserAudio(deps, { audio: OGG, signal: controller.signal, userId: "user-1" })).rejects.toBe(aborted);
  });

  it("still returns the transcript when the usage write fails", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { deps } = setup({ writeUsage: async () => { throw new Error("db"); } });
    expect(await transcribeUserAudio(deps, { audio: OGG, userId: "user-1" })).toEqual({ text: PRIVATE_TEXT });
  });

  it("recognizes the container signature of each allowlisted type", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);
    expect(audioContentMatches(webm, "audio/webm")).toBe(true);
    expect(audioContentMatches(OGG.bytes, "audio/ogg")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("\0\0\0\x18ftypM4A "), "audio/mp4")).toBe(true);
    expect(audioContentMatches(new Uint8Array([0xff, 0xfb, 0x90]), "audio/mpeg")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("ID3\x04"), "audio/mpeg")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "), "audio/wav")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("RIFF\0\0\0\0AVI "), "audio/wav")).toBe(false);
    expect(audioContentMatches(webm, "audio/ogg")).toBe(false);
  });
});
