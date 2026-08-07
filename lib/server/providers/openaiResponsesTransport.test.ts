import { describe, expect, it, vi } from "vitest";
import {
  createFetchOpenAIResponsesClient,
  openAIRetryableErrorPayload
} from "./openaiResponsesTransport";
import { ProviderResponseTooLargeError } from "./network";

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

describe("OpenAI Responses transport", () => {
  const remoteSecret = "sk-aiqsa-remote-error-regression-123456789";

  it("preserves the Responses endpoints, methods, headers, bodies, and custom base URL", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "secret-key",
      baseUrl: "  https://openai.example/v1  ",
      fetchFn: async (input, init) => {
        calls.push({ init, url: String(input) });
        return new Response(JSON.stringify({ id: `response-${calls.length}` }), { status: 200 });
      }
    });

    await expect(client.create({ model: "gpt-test" })).resolves.toEqual({ id: "response-1" });
    await expect(client.retrieve("resp-1")).resolves.toEqual({ id: "response-2" });
    await expect(client.cancel("resp-1")).resolves.toEqual({ id: "response-3" });
    await expect(client.stream!({ model: "gpt-stream", stream: true })).resolves.toBeInstanceOf(Response);

    expect(calls.map(({ url }) => url)).toEqual([
      "https://openai.example/v1/responses",
      "https://openai.example/v1/responses/resp-1",
      "https://openai.example/v1/responses/resp-1/cancel",
      "https://openai.example/v1/responses"
    ]);
    expect(calls.map(({ init }) => init?.method)).toEqual(["POST", "GET", "POST", "POST"]);
    expect(calls.map(({ init }) => init?.body)).toEqual([
      JSON.stringify({ model: "gpt-test" }),
      undefined,
      "{}",
      JSON.stringify({ model: "gpt-stream", stream: true })
    ]);
    for (const { init } of calls) {
      expect(init?.headers).toEqual({
        authorization: "Bearer secret-key",
        "content-type": "application/json"
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("omits authorization for an explicit no-auth compatible transport", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
      return new Response(JSON.stringify({ id: "response-no-auth" }), { status: 200 });
    });
    const client = createFetchOpenAIResponsesClient({
      apiKey: null,
      baseUrl: "http://127.0.0.1:11434/v1",
      fetchFn
    });

    await expect(client.create({ model: "local-model" })).resolves.toEqual({
      id: "response-no-auth"
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("uses the official base URL when the configured URL is blank", async () => {
    const urls: string[] = [];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      baseUrl: "   ",
      fetchFn: async (input) => {
        urls.push(String(input));
        return new Response("{}", { status: 200 });
      }
    });

    await client.retrieve("resp-official");

    expect(urls).toEqual(["https://api.openai.com/v1/responses/resp-official"]);
  });

  it("keeps empty and non-object behavior while collapsing malformed remote JSON", async () => {
    const responses = [
      new Response("", { status: 200 }),
      new Response("[]", { status: 200 }),
      new Response(`{"broken":"${remoteSecret}`, { status: 200 })
    ];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}", { status: 200 })
    });

    await expect(client.create({})).resolves.toEqual({});
    await expect(client.create({})).rejects.toThrow("openai_response_not_object");
    await expect(client.create({})).rejects.toThrow("openai_response_invalid_json");
  });

  it("drops provider error bodies and classifies only transport-created retryable errors", async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: `${remoteSecret} Temporarily unavailable` } }), {
        status: 503
      }),
      new Response("<html><body>Unauthorized\u0000 request</body></html>", { status: 401 })
    ];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}", { status: 200 })
    });

    let retryableError: unknown;
    try {
      await client.retrieve("resp-retry");
    } catch (error) {
      retryableError = error;
    }

    expect(retryableError).toBeInstanceOf(Error);
    expect((retryableError as Error).message).toBe("OpenAI request failed with status 503");
    expect((retryableError as Error).message).not.toContain(remoteSecret);
    expect((retryableError as Error).message).not.toContain("Temporarily unavailable");
    expect(openAIRetryableErrorPayload(retryableError)).toEqual({
      message: "OpenAI request failed with status 503",
      retryable: true,
      status: 503
    });

    let nonRetryableError: unknown;
    try {
      await client.retrieve("resp-auth");
    } catch (error) {
      nonRetryableError = error;
    }

    expect((nonRetryableError as Error).message).toBe("OpenAI request failed with status 401");
    expect(openAIRetryableErrorPayload(nonRetryableError)).toBeNull();
    expect(openAIRetryableErrorPayload({ retryable: true, status: 503 })).toBeNull();
  });

  it("applies the provider request timeout to create, retrieve, cancel, and stream", async () => {
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      defaultTimeoutMs: 5,
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

    for (const operation of [
      () => client.create({}),
      () => client.retrieve("resp-timeout"),
      () => client.cancel("resp-timeout"),
      () => client.stream!({ stream: true })
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "provider_request_timed_out",
        timeoutMs: 5
      });
    }
  });

  it("keeps the request deadline active after headers through JSON and HTTP-error bodies", async () => {
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

    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      defaultTimeoutMs: 5,
      fetchFn: async () => responses.shift() ?? new Response("{}")
    });

    await expect(client.create({})).rejects.toMatchObject({
      code: "provider_request_timed_out",
      timeoutMs: 5
    });
    await expect(client.retrieve("resp-stalled-error")).rejects.toMatchObject({
      code: "provider_request_timed_out",
      timeoutMs: 5
    });
    expect(cancellationReasons).toHaveLength(2);
    expect(openAIRetryableErrorPayload(cancellationReasons[1])).toBeNull();
  });

  it("bounds raw success and error bodies while retaining HTTP retry classification", async () => {
    const previousMaxBytes = process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
    process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = "5";
    const responses = [
      new Response('{"ok":true}', { status: 200 }),
      new Response("service unavailable", { status: 503 })
    ];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async () => responses.shift() ?? new Response("{}")
    });

    try {
      await expect(client.create({})).rejects.toBeInstanceOf(ProviderResponseTooLargeError);

      let error: unknown;
      try {
        await client.retrieve("resp-oversized-error");
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        message: "OpenAI request failed with status 503",
        name: "OpenAIHttpError"
      });
      expect(openAIRetryableErrorPayload(error)).toEqual({
        message: "OpenAI request failed with status 503",
        retryable: true,
        status: 503
      });
    } finally {
      if (typeof previousMaxBytes === "undefined") {
        delete process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES;
      } else {
        process.env.AIQSA_PROVIDER_RESPONSE_MAX_BYTES = previousMaxBytes;
      }
    }
  });

  it("releases the ordinary deadline at successful SSE headers but keeps caller cancellation", async () => {
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const response = new Response(new ReadableStream<Uint8Array>());

    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      defaultTimeoutMs: 5,
      fetchFn: async (_input, init) => {
        transportSignal = init?.signal ?? undefined;
        return response;
      }
    });

    await expect(client.stream!({}, { signal: caller.signal })).resolves.toBe(response);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(transportSignal?.aborted).toBe(false);

    const cancellation = new Error("caller_cancelled_after_headers");
    caller.abort(cancellation);
    expect(transportSignal?.aborted).toBe(true);
    expect(transportSignal?.reason).toBe(cancellation);
    await response.body?.cancel();
  });

  it("combines caller cancellation with transport timeouts for signal-aware methods", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller_cancelled"));
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async (_input, init) => {
        const signal = init?.signal;
        if (!signal?.aborted) {
          throw new Error("expected_aborted_signal");
        }

        throw signal.reason;
      }
    });

    await expect(client.create({}, { signal: controller.signal })).rejects.toThrow("caller_cancelled");
    await expect(client.retrieve("resp-abort", { signal: controller.signal })).rejects.toThrow("caller_cancelled");
    await expect(client.stream!({}, { signal: controller.signal })).rejects.toThrow("caller_cancelled");
  });

  it("rejects successful streaming responses without a body", async () => {
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async () => new Response(null, { status: 200 })
    });

    await expect(client.stream!({ stream: true })).rejects.toThrow("openai_stream_body_missing");
  });
});
