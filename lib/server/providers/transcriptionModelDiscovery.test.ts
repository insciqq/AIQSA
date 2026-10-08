import { describe, expect, it, vi } from "vitest";
import { discoverTranscriptionModels, transcriptionModelIds, TranscriptionModelDiscoveryError } from "./transcriptionModelDiscovery";

const connection = { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1", authenticationMode: "bearer" as const, responseTimeoutMs: 30_000 };

describe("transcription model discovery", () => {
  it("asks OpenRouter for the transcription modality and re-checks each row", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: [
      { id: "openai/whisper-1", architecture: { output_modalities: ["transcription"] } },
      { id: "openai/gpt-5", architecture: { output_modalities: ["text"] } },
      { id: "groq/whisper-large-v3", architecture: { output_modalities: ["transcription"] } },
      { id: "bad id\n", architecture: { output_modalities: ["transcription"] } }
    ] }));
    await expect(discoverTranscriptionModels({ connection, family: "openrouter", fetchFn, secret: "k" }))
      .resolves.toEqual(["groq/whisper-large-v3", "openai/whisper-1"]);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/models?output_modalities=transcription");
    expect((fetchFn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("offers only Whisper or transcription ids from an OpenAI-compatible list", () => {
    expect(transcriptionModelIds({ data: [{ id: "whisper-1" }, { id: "gpt-4o-mini-transcribe" }, { id: "gpt-4o" }, { id: "tts-1" }] },
      "openai_compatible")).toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
    expect(() => transcriptionModelIds({ models: [] }, "openai")).toThrow(TranscriptionModelDiscoveryError);
  });

  it("separates a refused key from other failures", async () => {
    const run = (fetchFn: typeof fetch) => discoverTranscriptionModels({ connection, family: "openai", fetchFn, secret: "k" });
    await expect(run(async () => new Response("{}", { status: 401 }))).rejects.toMatchObject({ code: "transcription_discovery_unauthorized" });
    await expect(run(async () => new Response("{}", { status: 500 }))).rejects.toMatchObject({ code: "transcription_discovery_failed" });
    await expect(run(async () => new Response("nope"))).rejects.toMatchObject({ code: "transcription_discovery_failed" });
    await expect(run(async () => { throw new TypeError("offline"); })).rejects.toMatchObject({ code: "transcription_discovery_failed" });
  });
});
