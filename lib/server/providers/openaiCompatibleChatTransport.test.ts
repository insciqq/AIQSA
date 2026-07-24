import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderResponseTooLargeError } from "./network";
import {
  createFetchOpenAICompatibleChatClient,
  deriveOpenAICompatibleChatEndpoint
} from "./openaiCompatibleChatTransport";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAI-compatible Chat Completions transport", () => {
  const remoteSecret = "sk-aiqsa-remote-error-regression-123456789";

  it("posts to the derived endpoint with only explicit bearer JSON headers", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const client = createFetchOpenAICompatibleChatClient({
      apiRoot: "  https://llm.example.test/openai/v1///  ",
      bearerToken: "  secret-key  ",
      fetchFn: async (input, init) => {
        calls.push({ init, url: String(input) });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }], id: "response-1" }),
          { status: 200 }
        );
      }
    });

    await expect(client.createChatCompletion({ model: "model-1" })).resolves.toMatchObject({
      id: "response-1"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://llm.example.test/openai/v1/chat/completions");
    expect(calls[0]?.init).toMatchObject({
      body: JSON.stringify({ model: "model-1" }),
      headers: {
        authorization: "Bearer secret-key",
        "content-type": "application/json"
      },
      method: "POST",
      redirect: "error"
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("HTTP-Referer")).toBeNull();
    expect(headers.get("X-Title")).toBeNull();
  });

  it("requires a canonical explicit API root and bearer credential", () => {
    expect(() =>
      createFetchOpenAICompatibleChatClient({ apiRoot: "", bearerToken: "key" })
    ).toThrow("openai_compatible_chat_api_root_required");
    expect(() =>
      createFetchOpenAICompatibleChatClient({
        apiRoot: "https://llm.example.test/v1",
        bearerToken: " "
      })
    ).toThrow("openai_compatible_chat_bearer_token_required");

    for (const root of [
      "ftp://llm.example.test/v1",
      "https://user:secret@llm.example.test/v1",
      "https://llm.example.test/v1?token=secret",
      "https://llm.example.test/v1#fragment",
      "not-a-url"
    ]) {
      expect(() => deriveOpenAICompatibleChatEndpoint(root)).toThrow(
        "openai_compatible_chat_api_root_invalid"
      );
    }
  });

  it("returns an SSE response and composes caller cancellation into the request", async () => {
    const caller = new AbortController();
    const signals: AbortSignal[] = [];
    const client = createFetchOpenAICompatibleChatClient({
      apiRoot: "http://127.0.0.1:9000/v1",
      bearerToken: "local-key",
      fetchFn: async (_input, init) => {
        if (!(init?.signal instanceof AbortSignal)) {
          throw new Error("missing_signal");
        }
        signals.push(init.signal);
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" }
        });
      }
    });

    const response = await client.streamChatCompletion(
      { stream: true },
      { signal: caller.signal }
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(signals).toHaveLength(1);
    expect(signals[0]).not.toBe(caller.signal);
  });

  it("bounds successful JSON and drops provider HTTP error details", async () => {
    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "8");
    const responses = [
      new Response('{"long":"provider-body"}', { status: 200 }),
      new Response(
        JSON.stringify({ error: { message: `${remoteSecret} unavailable` } }),
        { status: 503 }
      )
    ];
    const client = createFetchOpenAICompatibleChatClient({
      apiRoot: "https://llm.example.test/v1",
      bearerToken: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}")
    });

    await expect(client.createChatCompletion({})).rejects.toBeInstanceOf(
      ProviderResponseTooLargeError
    );
    vi.stubEnv("AIQSA_PROVIDER_RESPONSE_MAX_BYTES", "1024");
    let failure: unknown;
    try {
      await client.createChatCompletion({});
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "OpenAI-compatible request failed with status 503"
    });
    expect((failure as Error).message).not.toContain(remoteSecret);
    expect((failure as Error).message).not.toContain("unavailable");
  });

  it("collapses malformed remote JSON without echoing it", async () => {
    const client = createFetchOpenAICompatibleChatClient({
      apiRoot: "https://llm.example.test/v1",
      bearerToken: "key",
      fetchFn: async () => new Response(`{"error":"${remoteSecret}`, { status: 200 })
    });

    await expect(client.createChatCompletion({})).rejects.toThrow(
      "openai_compatible_chat_response_invalid_json"
    );
  });
});
