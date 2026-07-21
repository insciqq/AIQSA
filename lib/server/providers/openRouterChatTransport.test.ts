import { describe, expect, it } from "vitest";
import { ProviderResponseTooLargeError } from "./network";
import { createFetchOpenRouterChatClient } from "./openRouterChatTransport";

function delayedResponse(input: {
  delayMs: number;
  onCancel?: (reason: unknown) => void;
  status?: number;
  text?: string;
}): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Response(
    new ReadableStream<Uint8Array>({
      cancel(reason) {
        if (timer) {
          clearTimeout(timer);
        }
        input.onCancel?.(reason);
      },
      start(controller) {
        timer = setTimeout(() => {
          if (input.text) {
            controller.enqueue(new TextEncoder().encode(input.text));
          }
          controller.close();
        }, input.delayMs);
      }
    }),
    { status: input.status ?? 200 }
  );
}

describe("OpenRouter Chat transport", () => {
  it("preserves the endpoint, method, body, headers, and normalized custom base URL", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const client = createFetchOpenRouterChatClient({
      apiKey: "secret-key",
      appTitle: "AIQSA Tests",
      baseUrl: "  https://openrouter.example/api/v1///  ",
      fetchFn: async (input, init) => {
        calls.push({ init, url: String(input) });
        return new Response(JSON.stringify({ choices: [], id: `response-${calls.length}` }), {
          status: 200
        });
      },
      httpReferer: "https://aiqsa.example"
    });

    await expect(client.createChatCompletion({ model: "model-test" })).resolves.toEqual({
      choices: [],
      id: "response-1"
    });
    await expect(
      client.streamChatCompletion!({ model: "model-stream", stream: true })
    ).resolves.toBeInstanceOf(Response);

    expect(calls.map(({ url }) => url)).toEqual([
      "https://openrouter.example/api/v1/chat/completions",
      "https://openrouter.example/api/v1/chat/completions"
    ]);
    expect(calls.map(({ init }) => init?.method)).toEqual(["POST", "POST"]);
    expect(calls.map(({ init }) => init?.body)).toEqual([
      JSON.stringify({ model: "model-test" }),
      JSON.stringify({ model: "model-stream", stream: true })
    ]);
    for (const { init } of calls) {
      expect(init?.headers).toEqual({
        authorization: "Bearer secret-key",
        "content-type": "application/json",
        "HTTP-Referer": "https://aiqsa.example",
        "X-Title": "AIQSA Tests"
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("uses the official base URL and omits optional headers when configuration is blank", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const client = createFetchOpenRouterChatClient({
      apiKey: "key",
      appTitle: "",
      baseUrl: "   ",
      fetchFn: async (input, init) => {
        calls.push({ init, url: String(input) });
        return new Response("{}", { status: 200 });
      },
      httpReferer: ""
    });

    await client.createChatCompletion({});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer key",
      "content-type": "application/json"
    });
  });

  it("keeps the existing empty, non-object, and malformed JSON behavior", async () => {
    const responses = [
      new Response("", { status: 200 }),
      new Response("[]", { status: 200 }),
      new Response("null", { status: 200 }),
      new Response('"text"', { status: 200 }),
      new Response("{", { status: 200 })
    ];
    const client = createFetchOpenRouterChatClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}", { status: 200 })
    });

    await expect(client.createChatCompletion({})).resolves.toEqual({});
    await expect(client.createChatCompletion({})).rejects.toThrow("openrouter_response_not_object");
    await expect(client.createChatCompletion({})).rejects.toThrow("openrouter_response_not_object");
    await expect(client.createChatCompletion({})).rejects.toThrow("openrouter_response_not_object");
    await expect(client.createChatCompletion({})).rejects.toBeInstanceOf(SyntaxError);
  });

  it("sanitizes JSON and non-JSON HTTP error bodies for regular and streaming calls", async () => {
    const responses = [
      new Response(
        JSON.stringify({ error: { message: "<script>bad()</script> Temporarily unavailable\u0000" } }),
        { status: 503 }
      ),
      new Response("<html><body><style>p{}</style><p>Gateway down</p></body></html>", {
        status: 502
      }),
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429 }),
      new Response("", { status: 504 })
    ];
    const client = createFetchOpenRouterChatClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}", { status: 200 })
    });

    await expect(client.createChatCompletion({})).rejects.toThrow(
      "OpenRouter request failed with status 503: Temporarily unavailable"
    );
    await expect(client.streamChatCompletion!({ stream: true })).rejects.toThrow(
      "OpenRouter request failed with status 502: Gateway down"
    );
    await expect(client.createChatCompletion({})).rejects.toThrow(
      'OpenRouter request failed with status 429: {"error":{"code":"rate_limited"}}'
    );
    await expect(client.createChatCompletion({})).rejects.toThrow(
      "OpenRouter request failed with status 504"
    );
  });

  it("combines caller cancellation with the transport timeout signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller_cancelled"));
    const receivedSignals: AbortSignal[] = [];
    const client = createFetchOpenRouterChatClient({
      apiKey: "key",
      fetchFn: async (_input, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("missing_signal");
        }
        receivedSignals.push(signal);

        if (!signal.aborted) {
          throw new Error("expected_aborted_signal");
        }

        throw signal.reason;
      }
    });

    await expect(
      client.createChatCompletion({}, { signal: controller.signal })
    ).rejects.toThrow("caller_cancelled");
    await expect(
      client.streamChatCompletion!({}, { signal: controller.signal })
    ).rejects.toThrow("caller_cancelled");
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals.every((signal) => signal !== controller.signal)).toBe(true);
  });

  it("applies the configured provider timeout to regular and streaming calls", async () => {
    const previousTimeout = process.env.AIQSA_PROVIDER_TIMEOUT_MS;
    process.env.AIQSA_PROVIDER_TIMEOUT_MS = "5";

    try {
      const client = createFetchOpenRouterChatClient({
        apiKey: "key",
        fetchFn: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("missing_signal"));
              return;
            }

            const rejectFromSignal = () => reject(signal.reason);
            if (signal.aborted) {
              rejectFromSignal();
              return;
            }
            signal.addEventListener("abort", rejectFromSignal, { once: true });
          })
      });

      await expect(client.createChatCompletion({})).rejects.toThrow("Provider request timed out");
      await expect(client.streamChatCompletion!({ stream: true })).rejects.toThrow(
        "Provider request timed out"
      );
    } finally {
      if (typeof previousTimeout === "undefined") {
        delete process.env.AIQSA_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.AIQSA_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("keeps the request deadline active after headers through JSON and HTTP-error bodies", async () => {
    const previousTimeout = process.env.AIQSA_PROVIDER_TIMEOUT_MS;
    process.env.AIQSA_PROVIDER_TIMEOUT_MS = "5";
    const cancellationReasons: unknown[] = [];
    const responses = [
      delayedResponse({
        delayMs: 50,
        onCancel: (reason) => cancellationReasons.push(reason),
        text: "{}"
      }),
      delayedResponse({
        delayMs: 50,
        onCancel: (reason) => cancellationReasons.push(reason),
        status: 503,
        text: "temporarily unavailable"
      })
    ];

    try {
      const client = createFetchOpenRouterChatClient({
        apiKey: "key",
        fetchFn: async () => responses.shift() ?? new Response("{}")
      });

      await expect(client.createChatCompletion({})).rejects.toMatchObject({
        message: "Provider request timed out",
        name: "TimeoutError"
      });
      await expect(client.streamChatCompletion!({ stream: true })).rejects.toMatchObject({
        message: "Provider request timed out",
        name: "TimeoutError"
      });
      expect(cancellationReasons).toHaveLength(2);
    } finally {
      if (typeof previousTimeout === "undefined") {
        delete process.env.AIQSA_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.AIQSA_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("bounds raw success and error bodies with an explicit overflow marker", async () => {
    const previousMaxBytes = process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
    process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "5";
    const responses = [
      new Response('{"ok":true}', { status: 200 }),
      new Response("service unavailable", { status: 503 })
    ];
    const client = createFetchOpenRouterChatClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}")
    });

    try {
      await expect(client.createChatCompletion({})).rejects.toBeInstanceOf(
        ProviderResponseTooLargeError
      );
      await expect(client.streamChatCompletion!({ stream: true })).rejects.toThrow(
        "OpenRouter request failed with status 503: provider_response_too_large"
      );
    } finally {
      if (typeof previousMaxBytes === "undefined") {
        delete process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
      } else {
        process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = previousMaxBytes;
      }
    }
  });

  it("releases the ordinary deadline at successful SSE headers but keeps caller cancellation", async () => {
    const previousTimeout = process.env.AIQSA_PROVIDER_TIMEOUT_MS;
    process.env.AIQSA_PROVIDER_TIMEOUT_MS = "5";
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const response = new Response(new ReadableStream<Uint8Array>());

    try {
      const client = createFetchOpenRouterChatClient({
        apiKey: "key",
        fetchFn: async (_input, init) => {
          transportSignal = init?.signal ?? undefined;
          return response;
        }
      });

      await expect(
        client.streamChatCompletion!({}, { signal: caller.signal })
      ).resolves.toBe(response);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(transportSignal?.aborted).toBe(false);

      const cancellation = new Error("caller_cancelled_after_headers");
      caller.abort(cancellation);
      expect(transportSignal?.aborted).toBe(true);
      expect(transportSignal?.reason).toBe(cancellation);
      await response.body?.cancel();
    } finally {
      if (typeof previousTimeout === "undefined") {
        delete process.env.AIQSA_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.AIQSA_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("rejects successful streaming responses without a body", async () => {
    const client = createFetchOpenRouterChatClient({
      apiKey: "key",
      fetchFn: async () => new Response(null, { status: 200 })
    });

    await expect(client.streamChatCompletion!({ stream: true })).rejects.toThrow(
      "openrouter_stream_body_missing"
    );
  });
});
