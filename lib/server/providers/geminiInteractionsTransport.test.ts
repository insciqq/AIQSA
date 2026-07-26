import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderResponseTooLargeError } from "./network";
import {
  createFetchGeminiInteractionsClient,
  deriveGeminiInteractionsEndpoint
} from "./geminiInteractionsTransport";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Gemini Interactions transport", () => {
  it("posts to stable /interactions with only the Google API key auth", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const client = createFetchGeminiInteractionsClient({
      apiKey: "  google-secret  ",
      apiRoot: " https://generativelanguage.googleapis.com/v1/// ",
      fetchFn: async (request, init) => {
        calls.push({ init, url: String(request) });
        return new Response(JSON.stringify({ id: "interaction-1", status: "completed" }));
      }
    });

    await client.createInteraction({ input: "hello", model: "gemini-3.6-flash" });
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    expect(calls[0]?.init).toMatchObject({ method: "POST", redirect: "error" });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-goog-api-key")).toBe("google-secret");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("validates the root and API key", () => {
    expect(() => createFetchGeminiInteractionsClient({ apiKey: " ", apiRoot: "https://x.test/v1" }))
      .toThrow("gemini_interactions_api_key_required");
    for (const root of [
      "ftp://google.test/v1",
      "https://user:password@google.test/v1",
      "https://google.test/v1?key=secret",
      "https://google.test/v1#fragment",
      "not-a-url"
    ]) {
      expect(() => deriveGeminiInteractionsEndpoint(root))
        .toThrow("gemini_interactions_api_root_invalid");
    }
  });

  it("returns the SSE response and composes caller cancellation", async () => {
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    const client = createFetchGeminiInteractionsClient({
      apiKey: "key",
      apiRoot: "http://127.0.0.1:9000/v1",
      fetchFn: async (_request, init) => {
        signal = init?.signal as AbortSignal;
        return new Response("event: done\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" }
        });
      }
    });

    await client.streamInteraction({ stream: true }, { signal: caller.signal });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).not.toBe(caller.signal);
  });

  it("bounds success bodies and never echoes raw remote errors", async () => {
    const remoteSecret = "remote-provider-secret";
    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "8");
    const responses = [
      new Response('{"too":"large"}', { status: 200 }),
      new Response(JSON.stringify({ error: { message: remoteSecret } }), { status: 503 })
    ];
    const client = createFetchGeminiInteractionsClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}")
    });

    await expect(client.createInteraction({})).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "1024");
    let failure: unknown;
    try {
      await client.createInteraction({});
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "Gemini request failed with status 503" });
    expect((failure as Error).message).not.toContain(remoteSecret);
  });
});
