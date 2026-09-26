import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderResponseTooLargeError } from "./network";
import {
  createFetchGeminiInteractionsClient,
  deriveGeminiInteractionsEndpoint,
  GeminiHttpError
} from "./geminiInteractionsTransport";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Gemini Interactions transport", () => {
  it.each(["malformed_tool_call", "malformed_function_call", "invalid_request", "parameter_unknown"] as const)(
    "projects only the allowlisted HTTP error identity %s for unary and streaming requests", async (code) => {
      const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () =>
        Response.json({ error: { code, message: "synthetic private error text", arguments: { secret: "private" } } }, { status: 400 }) });
      for (const send of [client.createInteraction, client.streamInteraction]) {
        const error = await send({}).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(GeminiHttpError);
        expect(error).toMatchObject({ code, httpStatus: 400, message: "Gemini request failed with status 400" });
        expect(JSON.stringify(error)).not.toMatch(/private|arguments|message/u);
      }
    });

  it.each(["invalid_request", "INVALID_ARGUMENT"])(
    "derives the context-length identity from a 400 %s naming the input token count over the maximum", async (code) => {
      const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => Response.json({ error: { code,
        message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). PRIVATE_PROVIDER_MESSAGE_CANARY",
        status: "INVALID_ARGUMENT" } }, { status: 400 }) });
      for (const send of [client.createInteraction, client.streamInteraction]) {
        const error = await send({}).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(GeminiHttpError);
        expect(error).toMatchObject({ code: "context_length_exceeded", httpStatus: 400, reportedMaximumTokens: 1_048_576,
          reportedPromptTokens: 1_200_000, message: "Gemini request failed with status 400" });
        expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|INVALID_ARGUMENT/u);
      }
    });

  it.each([
    ["The input token count exceeds the maximum number of tokens allowed 1048576.", { reportedMaximumTokens: 1_048_576 }],
    ["The input token count exceeds the maximum number of tokens allowed.", {}]
  ])("classifies the sentence %# without stated counts and extracts only what it states", async (message, counts) => {
    const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => Response.json({ error: {
      code: "invalid_request", message } }, { status: 400 }) });
    const failure = await client.createInteraction({}).catch((value: unknown) => value);
    expect(failure).toMatchObject({ code: "context_length_exceeded", httpStatus: 400, ...counts });
    expect(failure).not.toHaveProperty("reportedPromptTokens");
  });

  it("keeps other 400s and a non-400 status out of the context-length identity", async () => {
    for (const [status, error, code] of [
      [400, { code: "invalid_request", message: "Unknown name \"maxItems\": Cannot find field. PRIVATE_PROVIDER_MESSAGE_CANARY" }, "invalid_request"],
      [500, { code: "invalid_request", message: "The input token count (2) exceeds the maximum number of tokens allowed (1)." }, "invalid_request"]
    ] as const) {
      const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => Response.json({ error }, { status }) });
      const failure = await client.createInteraction({}).catch((value: unknown) => value);
      expect(failure).toMatchObject({ code, httpStatus: status });
      expect(failure).not.toHaveProperty("reportedPromptTokens");
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_");
    }
  });

  it.each(["", "null", "[]", "{", '{"error":null}', '{"error":{"code":400}}',
    '{"error":{"code":"malformed_tool_call\\n"}}', '{"error":{"code":"private-unknown"}}',
    JSON.stringify({ error: { code: "malformed_tool_call", message: "x".repeat(16_384) } })])(
    "keeps malformed, unknown and oversized envelopes as safe HTTP fallbacks (%#)", async (body) => {
      const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => new Response(body, { status: 400 }) });
      await expect(client.createInteraction({})).rejects.toMatchObject({ code: undefined, httpStatus: 400,
        message: "Gemini request failed with status 400" });
    });

  it("cancels a pending error body without reclassifying cancellation", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => new Response(
      new ReadableStream({ cancel }), { status: 400 }) });
    const pending = client.createInteraction({}, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("synthetic_cancel"));
    await expect(pending).rejects.toThrow("synthetic_cancel");
  });

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
