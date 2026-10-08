import { describe, expect, it, vi } from "vitest";
import {
  AudioTranscriptionError,
  createAudioTranscriptionAdapter,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  parseTranscriptionUsage
} from "./audioTranscription";

const bearer = { allowPrivateNetwork: false, apiRoot: "https://api.example.test/v1", authenticationMode: "bearer" as const, responseTimeoutMs: 30_000 };
const noAuth = { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:9000/v1", authenticationMode: "none" as const, responseTimeoutMs: 30_000 };
const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

function reply(body: unknown, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

describe("audio transcription adapter", () => {
  it("sends an OpenAI-compatible multipart form with the bearer key and parses text and usage", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => reply({ text: "  Hello there. ", usage: { type: "duration", seconds: 4.2 } }));
    const adapter = createAudioTranscriptionAdapter({ connection: bearer, fetchFn, providerFamily: "openai_compatible",
      secret: "test-key", upstreamModelId: "whisper-large-v3" });
    const result = await adapter.transcribe({ audio, mimeType: "audio/webm" });
    expect(result).toEqual({ text: "Hello there.", usage: { costUsd: null, inputTokens: null, outputTokens: null, seconds: 4.2, totalTokens: null } });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect((init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it("sends OpenRouter its JSON base64 shape with data collection denied and reads the reported cost", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => reply({ text: "Bonjour", usage: { seconds: 3, input_tokens: 10, output_tokens: 2, total_tokens: 12, cost: 0.00018 } }));
    const adapter = createAudioTranscriptionAdapter({ connection: { ...bearer, apiRoot: "https://openrouter.ai/api/v1" }, fetchFn,
      providerFamily: "openrouter", secret: async () => "or-key", upstreamModelId: "openai/whisper-1" });
    const result = await adapter.transcribe({ audio: new Uint8Array([0x52, 0x49]), mimeType: "audio/mp4" });
    expect(result.usage).toEqual({ costUsd: 0.00018, inputTokens: 10, outputTokens: 2, seconds: 3, totalTokens: 12 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      input_audio: { data: Buffer.from([0x52, 0x49]).toString("base64"), format: "m4a" },
      model: "openai/whisper-1",
      provider: { data_collection: "deny" },
      response_format: "json"
    });
  });

  it("emits no Authorization header for a no-authentication connection", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => reply({ text: "ok" }));
    await createAudioTranscriptionAdapter({ connection: noAuth, fetchFn, providerFamily: "openai_compatible", secret: null,
      upstreamModelId: "whisper-1" }).transcribe({ audio, mimeType: "audio/webm" });
    expect(Object.keys(fetchFn.mock.calls[0]![1]!.headers as Record<string, string>)).toEqual(["accept"]);
    expect(fetchFn.mock.calls[0]![0]).toBe("http://127.0.0.1:9000/v1/audio/transcriptions");
  });

  it("refuses a mismatched credential, an empty recording and OpenRouter without a key", async () => {
    expect(() => createAudioTranscriptionAdapter({ connection: bearer, providerFamily: "openai", secret: null, upstreamModelId: "whisper-1" }))
      .toThrow(AudioTranscriptionError);
    expect(() => createAudioTranscriptionAdapter({ connection: noAuth, providerFamily: "openrouter", secret: null, upstreamModelId: "x" }))
      .toThrow(AudioTranscriptionError);
    const fetchFn = vi.fn<typeof fetch>();
    const adapter = createAudioTranscriptionAdapter({ connection: bearer, fetchFn, providerFamily: "openai", secret: "k", upstreamModelId: "whisper-1" });
    await expect(adapter.transcribe({ audio: new Uint8Array(), mimeType: "audio/wav" })).rejects.toMatchObject({ code: "transcription_input_invalid" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("types provider failures without keeping their bodies", async () => {
    const run = (fetchFn: typeof fetch) => createAudioTranscriptionAdapter({ connection: bearer, fetchFn, providerFamily: "openai",
      secret: "k", upstreamModelId: "whisper-1" }).transcribe({ audio, mimeType: "audio/webm" });
    const http = await run(async () => reply({ error: { message: "private upstream detail" } }, 400)).catch((error: unknown) => error);
    expect(http).toMatchObject({ code: "transcription_provider_http_error", httpStatus: 400 });
    expect(String((http as Error).message)).not.toContain("private");
    await expect(run(async () => reply("not json"))).rejects.toMatchObject({ code: "transcription_response_invalid" });
    const invalid = await run(async () => reply({ result: "x", usage: { cost: 0.01 } })).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ code: "transcription_response_invalid", usage: { costUsd: 0.01 } });
    await expect(run(async () => reply({ text: "x".repeat(64_001) }))).rejects.toMatchObject({ code: "transcription_response_invalid" });
    await expect(run(async () => reply("x".repeat(MAX_TRANSCRIPTION_RESPONSE_BYTES + 1)))).rejects.toMatchObject({ code: "transcription_response_too_large" });
    await expect(run(async () => { throw new TypeError("socket hang up"); })).rejects.toMatchObject({ code: "transcription_provider_request_failed" });
  });

  it("times out at its deadline and passes caller cancellation through", async () => {
    const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const timed = createAudioTranscriptionAdapter({ connection: bearer, fetchFn: hanging, providerFamily: "openai", secret: "k",
      timeoutMs: 20, upstreamModelId: "whisper-1" });
    await expect(timed.transcribe({ audio, mimeType: "audio/webm" })).rejects.toMatchObject({ code: "transcription_request_timed_out" });
    const controller = new AbortController();
    const pending = createAudioTranscriptionAdapter({ connection: bearer, fetchFn: hanging, providerFamily: "openai", secret: "k",
      upstreamModelId: "whisper-1" }).transcribe({ audio, mimeType: "audio/webm", signal: controller.signal });
    controller.abort(new DOMException("aborted", "AbortError"));
    await expect(pending).rejects.not.toBeInstanceOf(AudioTranscriptionError);
  });

  it("reads usage leniently: malformed fields are unknown and BYOK adds the upstream cost", () => {
    expect(parseTranscriptionUsage(undefined)).toBeNull();
    expect(parseTranscriptionUsage({ seconds: -1, cost: "1" })).toBeNull();
    expect(parseTranscriptionUsage({ prompt_tokens: 5, cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } }))
      .toEqual({ costUsd: 0.003, inputTokens: 5, outputTokens: null, seconds: null, totalTokens: null });
  });
});
