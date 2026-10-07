import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { AudioTranscriptionError, type AudioTranscriptionAdapter } from "../providers/audioTranscription";
import type { UsageLimitStatus } from "../usageLimits/repository";
import type { SpeechToTextConnectionBinding, SpeechToTextRoleResolution } from "./role";
import { audioContentMatches, createTranscriptionHandler, dictationRateLimitKey, type TranscriptionHandlerDeps } from "./transcriptionHandlers";

const NO_LIMITS: UsageLimitStatus = {
  effective: { exempt: false, messagesPerDay: { source: null, value: null }, messagesPerHour: { source: null, value: null },
    monthlyBudgetMicros: { source: null, value: null } },
  installationCapMicros: null, installationSpentMicros: 0,
  lastDay: { count: 0, freesAt: null }, lastHour: { count: 0, freesAt: null }, userSpentMicros: 0
};
// Message windows are full: dictation must not consult them.
const MESSAGES_EXHAUSTED: UsageLimitStatus = { ...NO_LIMITS,
  effective: { ...NO_LIMITS.effective, messagesPerHour: { source: { kind: "installation" }, value: 1 } }, lastHour: { count: 5, freesAt: null } };
const BUDGET_EXHAUSTED: UsageLimitStatus = { ...NO_LIMITS,
  effective: { ...NO_LIMITS.effective, monthlyBudgetMicros: { source: { kind: "user" }, value: 1_000_000 } }, userSpentMicros: 1_000_000 };

const binding = { connection: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 },
  connectionDisplayName: "OpenRouter", connectionId: "c1", credentialId: "k", credentialVersionId: "kv", family: "openrouter",
  secret: async () => "key" } satisfies SpeechToTextConnectionBinding;
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const PRIVATE_TEXT = "PRIVATE_DICTATION_TEXT";

const session: AuthenticatedSession = { expiresAt: new Date(Date.now() + 60_000), id: "s",
  user: { displayName: "U", email: null, id: "user-1", role: "user", status: "active" }, userId: "user-1" };

function setup(overrides: Partial<TranscriptionHandlerDeps> & { transcribe?: AudioTranscriptionAdapter["transcribe"] } = {}) {
  const usage: Prisma.UsageEventUncheckedCreateInput[] = [];
  const transcribe = vi.fn<AudioTranscriptionAdapter["transcribe"]>(overrides.transcribe ??
    (async () => ({ text: PRIVATE_TEXT, usage: { costUsd: 0.0003, inputTokens: null, outputTokens: null, seconds: 6, totalTokens: null } })));
  const rateLimiter = { check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) };
  const deps: TranscriptionHandlerDeps = {
    createAdapter: () => ({ transcribe }),
    rateLimiter,
    resolveAuth: async () => session,
    resolveRole: async (): Promise<SpeechToTextRoleResolution> => ({ binding, modelId: "openai/whisper-1", ok: true }),
    usageLimits: { loadUsageLimitStatus: async () => NO_LIMITS },
    writeUsage: async (data) => { usage.push(data); },
    ...overrides
  };
  return { POST: createTranscriptionHandler(deps), rateLimiter, transcribe, usage };
}

function request(file: Blob | string | null = new Blob([WEBM], { type: "audio/webm;codecs=opus" }), name = "dictation.webm") {
  const form = new FormData();
  if (file instanceof Blob) form.append("file", file, name);
  else if (typeof file === "string") form.append("file", file);
  return new Request("http://app.test/api/me/transcriptions", { body: form, method: "POST" });
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/me/transcriptions", () => {
  it("transcribes once, records one personal speech_to_text row with the reported cost and never logs the text", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST, rateLimiter, transcribe, usage } = setup();
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ text: PRIVATE_TEXT });
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ audio: WEBM, mimeType: "audio/webm" }));
    expect(rateLimiter.check).toHaveBeenCalledWith(dictationRateLimitKey("user-1"), { maxAttempts: 20 });
    expect(usage).toEqual([expect.objectContaining({ purpose: "speech_to_text", userId: "user-1", provider: "openrouter",
      modelId: "openai/whisper-1", providerModelId: null, estimatedCostMicros: 300 })]);
    expect(usage[0]).not.toHaveProperty("chatId");
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(PRIVATE_TEXT);
  });

  it("refuses without a session, without multipart and when the role is not usable", async () => {
    expect((await setup({ resolveAuth: async () => null }).POST(request())).status).toBe(401);
    const plain = await setup().POST(new Request("http://app.test/x", { body: "{}", headers: { "content-type": "application/json" }, method: "POST" }));
    expect(plain.status).toBe(415);
    for (const reason of ["not_configured", "verification_required"] as const) {
      const { POST, transcribe } = setup({ resolveRole: async () => ({ ok: false, reason }) });
      const response = await POST(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "dictation_unavailable" });
      expect(transcribe).not.toHaveBeenCalled();
    }
  });

  it("refuses an exhausted budget like a run, ignores message windows and never calls the provider", async () => {
    const refused = setup({ usageLimits: { loadUsageLimitStatus: async () => BUDGET_EXHAUSTED } });
    const response = await refused.POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(await response.json()).toMatchObject({ error: "usage_budget_exhausted", usageLimit: { scope: "user", window: "month" } });
    expect(refused.transcribe).not.toHaveBeenCalled();
    expect(refused.rateLimiter.check).not.toHaveBeenCalled();
    const windows = setup({ usageLimits: { loadUsageLimitStatus: async () => MESSAGES_EXHAUSTED } });
    expect((await windows.POST(request())).status).toBe(200);
    const unreadable = setup({ usageLimits: { loadUsageLimitStatus: async () => { throw new Error("db"); } } });
    expect((await unreadable.POST(request())).status).toBe(503);
  });

  it("applies the per-user window and fails closed when the limiter is down", async () => {
    const { POST, rateLimiter, transcribe } = setup();
    rateLimiter.check.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 120.2 });
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("121");
    expect(await limited.json()).toEqual({ error: "dictation_rate_limited" });
    rateLimiter.check.mockRejectedValueOnce(new Error("down"));
    expect((await POST(request())).status).toBe(503);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("bounds and validates the audio: required, size, allowlisted type and matching content", async () => {
    const { POST, transcribe } = setup();
    expect((await POST(request(null))).status).toBe(400);
    expect((await POST(request("text"))).status).toBe(400);
    expect((await POST(request(new Blob([], { type: "audio/webm" })))).status).toBe(400);
    expect((await POST(request(new Blob([WEBM], { type: "video/webm" })))).status).toBe(415);
    expect((await POST(request(new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/webm" })))).status).toBe(415);
    const tooLarge = await POST(request(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "audio/webm" })));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: "audio_too_large" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("maps provider failures to stable codes and accounts a paid invalid response", async () => {
    const cases: Array<[unknown, number, string]> = [
      [new AudioTranscriptionError("transcription_request_timed_out"), 504, "transcription_timed_out"],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 400 }), 422, "transcription_rejected"],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 429 }), 503, "transcription_busy"],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 401 }), 503, "dictation_unavailable"],
      [new AudioTranscriptionError("transcription_provider_http_error", { httpStatus: 502 }), 502, "transcription_failed"],
      [new AudioTranscriptionError("transcription_provider_request_failed"), 502, "transcription_failed"]
    ];
    for (const [error, status, code] of cases) {
      const { POST, usage } = setup({ transcribe: async () => { throw error; } });
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
      expect(usage).toEqual([]);
    }
    const invalid = setup({ transcribe: async () => {
      throw new AudioTranscriptionError("transcription_response_invalid", { usage: { costUsd: 0.001, inputTokens: null, outputTokens: null, seconds: 2, totalTokens: null } });
    } });
    expect((await invalid.POST(request())).status).toBe(502);
    expect(invalid.usage).toEqual([expect.objectContaining({ purpose: "speech_to_text", estimatedCostMicros: 1_000 })]);
  });

  it("still returns the transcript when the usage write fails", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST } = setup({ writeUsage: async () => { throw new Error("db"); } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: PRIVATE_TEXT });
  });

  it("recognizes the container signature of each allowlisted type", () => {
    expect(audioContentMatches(WEBM, "audio/webm")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("OggS\0"), "audio/ogg")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("\0\0\0\x18ftypM4A "), "audio/mp4")).toBe(true);
    expect(audioContentMatches(new Uint8Array([0xff, 0xfb, 0x90]), "audio/mpeg")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("ID3\x04"), "audio/mpeg")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "), "audio/wav")).toBe(true);
    expect(audioContentMatches(new TextEncoder().encode("RIFF\0\0\0\0AVI "), "audio/wav")).toBe(false);
    expect(audioContentMatches(WEBM, "audio/ogg")).toBe(false);
  });
});
