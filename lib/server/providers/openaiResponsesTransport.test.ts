import { describe, expect, it, vi } from "vitest";
import {
  compatibleDroppedRoundDecision,
  createFetchOpenAIResponsesClient,
  openAIRetryableErrorPayload
} from "./openaiResponsesTransport";
import { ProviderRequestTimeoutError, ProviderResponseTooLargeError } from "./network";
import { providerFailureMessage } from "./providerFailureMessage";
import { observedFailure, providerContextRejection } from "./providerObservability";
import { ProviderSafeFetchError } from "./providerSafeFetch";
import { markProviderStreamDrop, providerStreamDrop } from "./streamDrop";
import { markProviderStreamProgress, providerStreamProgress, providerStreamProgressFacts } from "./streamProgress";
import { ProviderStreamIdleTimeoutError } from "./streamSafety";

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
  it.each([false, true])("accepts a slow completed response beyond the old ceiling (streamed create=%s)", async streamed => {
    vi.useFakeTimers();
    try {
      const terminal = { id: "synthetic", status: "completed", output: [] };
      const response = delayedResponse({ delayMs: 900_001, text: streamed
        ? `data: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`
        : JSON.stringify(terminal) });
      if (streamed) response.headers.set("content-type", "text/event-stream");
      const client = createFetchOpenAIResponsesClient({ apiKey: "synthetic-key", defaultTimeoutMs: 3_600_000,
        fetchFn: async () => response, acceptStreamedCreate: streamed });
      const result = client.create({ stream: false });
      const expected = expect(result).resolves.toEqual(terminal);
      await vi.advanceTimersByTimeAsync(900_001);
      await expected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("assembles a compatible streamed create from completed items without changing or repeating the request", async () => {
    const item = { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "OK" }] };
    const terminal = { id: "r1", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } };
    const events = [{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: terminal }];
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(events.map(x => `data: ${JSON.stringify(x)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const client = createFetchOpenAIResponsesClient({ apiKey: "synthetic-key", baseUrl: "https://example.test/backend-api/codex", fetchFn, acceptStreamedCreate: true });
    expect(await client.create({ model: "synthetic-model", stream: false })).toEqual({ ...terminal, output: [item] });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![0]).toBe("https://example.test/backend-api/codex/responses");
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)).stream).toBe(false);
  });

  describe("a streamed create's deadlines (decision 2026-11-11)", () => {
    const encoder = new TextEncoder();
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const item = { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "OK" }] };
    const terminal = { id: "r1", status: "completed", output: [] };
    // A Codex LB streamed create of a 300 s request timeout whose body writes each step at its time after the headers;
    // "close" ends it, and a cancelled body takes nothing more.
    const create = (steps: readonly (readonly [atMs: number, text: string])[], keepalive = true) => {
      let cancelled = 0;
      const fetchFn = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const [atMs, text] of steps) setTimeout(() => {
            try { if (text === "close") controller.close(); else controller.enqueue(encoder.encode(text)); } catch { /* cancelled */ }
          }, atMs);
        },
        cancel() { cancelled += 1; }
      }), { headers: { "content-type": "text/event-stream" } }));
      const client = createFetchOpenAIResponsesClient({ apiKey: "synthetic-key", baseUrl: "https://lb.example.test/backend-api/codex",
        defaultTimeoutMs: 300_000, fetchFn, acceptStreamedCreate: true, ...(keepalive ? { streamIdle: "keepalive" as const } : {}) });
      let outcome: unknown = "pending";
      const settled = client.create({ stream: false }).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
      return { cancelled: () => cancelled, outcome: () => outcome, settled };
    };

    it("lets a live streamed create run past its request timeout", async () => {
      vi.useFakeTimers();
      try {
        // Ten minutes of text, a delta every 30 s, before its item and terminal.
        const deltas = Array.from({ length: 20 }, (_, index) => [(index + 1) * 30_000,
          event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "O" })] as const);
        const call = create([[0, event({ type: "response.created", response: { id: "r1", status: "in_progress" } })], ...deltas,
          [610_000, event({ type: "response.output_item.done", output_index: 0, item })],
          [610_000, event({ type: "response.completed", response: terminal })], [610_000, "close"]]);
        await vi.advanceTimersByTimeAsync(610_000);
        await call.settled;
        expect(call.outcome()).toEqual({ ...terminal, output: [item] });
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });

    it.each([true, false])("ends a silent streamed create after a minute only on a keepalive route (keepalive=%s)", async (keepalive) => {
      vi.useFakeTimers();
      try {
        const call = create([], keepalive);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(call.outcome()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(keepalive ? 0 : 240_000);
        expect(call.outcome()).not.toBe("pending");
        await call.settled;
        expect(call.outcome()).toMatchObject(keepalive
          ? { code: "provider_stream_timeout", idleTimeoutMs: 60_000 }
          : { code: "provider_request_timed_out", timeoutMs: 300_000 });
        expect(compatibleDroppedRoundDecision(call.outcome())).toEqual({ retryAfterMs: null });
        expect(call.cancelled()).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });

    it("keeps the request timeout for a streamed create kept alive by comments that never starts", async () => {
      vi.useFakeTimers();
      try {
        const call = create(Array.from({ length: 29 }, (_, index) => [(index + 1) * 10_000, ": keepalive\n\n"] as const));
        await vi.advanceTimersByTimeAsync(299_999);
        expect(call.outcome()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        await call.settled;
        expect(call.outcome()).toMatchObject({ code: "provider_request_timed_out", timeoutMs: 300_000 });
        expect(providerStreamProgress(call.outcome())).toMatchObject({ response_started: false });
        expect(call.cancelled()).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
  });

  it.each(["[DONE]", JSON.stringify({ type: "response.completed", response: { status: "in_progress" } })])("rejects streamed creates without matching terminal proof: %s", async (data) => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(`data: ${data}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const client = createFetchOpenAIResponsesClient({ apiKey: "synthetic-key", fetchFn, acceptStreamedCreate: true });
    await expect(client.create({ stream: false })).rejects.toThrow(/^openai_response_/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

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

  it("assigns a fresh opaque prompt cache key to every isolated physical POST", async () => {
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      new Response("rate limited", { status: 429 }),
      new Response(JSON.stringify({ id: "isolated" }), { status: 200 })
    ];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return responses.shift() ?? new Response("{}", { status: 200 });
      },
      initialRequestRetry: { maxAttempts: 2, random: () => 0, sleep: async () => undefined },
      requestIsolation: true
    });

    await expect(client.create({ model: "model" })).resolves.toEqual({ id: "isolated" });
    expect(bodies).toHaveLength(2);
    expect(typeof bodies[0]!.prompt_cache_key).toBe("string");
    expect(bodies[0]!.prompt_cache_key).not.toBe(bodies[1]!.prompt_cache_key);
    expect(bodies[0]).toMatchObject({ model: "model" });
    expect(bodies[1]).toMatchObject({ model: "model" });
  });

  it("sends a caller's lane key on a request's first isolated POST only, and a fresh key on its replay", async () => {
    const lane = "6f1c2a4e-0b7d-4c3e-9a5f-1d2e3f4a5b6c";
    for (const requestIsolation of [true, false]) {
      const bodies: Record<string, unknown>[] = [];
      const responses = [new Response("rate limited", { status: 429 }), Response.json({ id: "first" }), Response.json({ id: "second" }),
        Response.json({ id: "probe" })];
      const client = createFetchOpenAIResponsesClient({
        apiKey: "key",
        fetchFn: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return responses.shift() ?? Response.json({});
        },
        initialRequestRetry: { maxAttempts: 2, random: () => 0, sleep: async () => undefined },
        requestIsolation
      });
      await expect(client.create({ model: "model" }, { routingKey: lane })).resolves.toEqual({ id: "first" });
      await expect(client.create({ model: "model" }, { routingKey: lane })).resolves.toEqual({ id: "second" });
      // A call without a lane, such as a capability probe, keeps a fresh key.
      await expect(client.create({ model: "model" })).resolves.toEqual({ id: "probe" });
      const keys = bodies.map((body) => body.prompt_cache_key);
      if (!requestIsolation) {
        // Without isolation the lane key never reaches the wire.
        expect(keys).toEqual([undefined, undefined, undefined, undefined]);
        continue;
      }
      expect(keys[0]).toBe(lane);
      expect(keys[2]).toBe(lane);
      // The replay of the first request, and the probe, each have a key of their own.
      expect(new Set(keys).size).toBe(3);
      expect(keys.filter((key) => key === lane)).toHaveLength(2);
    }
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

  describe("context-length rejection", () => {
    const sentinel = "PRIVATE_PROVIDER_MESSAGE_CANARY";

    it.each([
      // OpenAI Responses and codex-lb: explicit code, no stated counts.
      [{ code: "context_length_exceeded", message: `Your input exceeds the context window of this model. ${sentinel}` }, {}],
      [{ code: "context_length_exceeded", param: "input", type: "invalid_request_error",
        message: `Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in 300000 tokens. ${sentinel}` },
      { reportedMaximumTokens: 272_000, reportedPromptTokens: 300_000 }]
    ])("classifies HTTP 400 %# for create and stream, without provider text", async (error, counts) => {
      const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error }, { status: 400 }));
      const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn, initialRequestRetry: { maxAttempts: 3 } });
      for (const send of [() => client.create({}), () => client.stream!({})]) {
        const failure = await send().catch((value: unknown) => value);
        expect(failure).toMatchObject({ code: "provider_context_length_exceeded", status: 400,
          message: "OpenAI request failed with status 400" });
        expect(failure).toEqual(expect.objectContaining(counts));
        if (!("reportedPromptTokens" in counts)) expect(failure).not.toHaveProperty("reportedPromptTokens");
        expect(JSON.stringify(failure)).not.toContain(sentinel);
        expect(String(failure)).not.toContain(sentinel);
        expect(openAIRetryableErrorPayload(failure)).toBeNull();
      }
      // A refusal is never replayed by the transport's own retry.
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("classifies a streamed create's error event and ignores unrelated 400s", async () => {
      const streamed = createFetchOpenAIResponsesClient({ apiKey: "key", acceptStreamedCreate: true, fetchFn: async () => new Response(
        `data: ${JSON.stringify({ type: "error", code: "context_length_exceeded", message: sentinel })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }) });
      const failure = await streamed.create({ stream: false }).catch((value: unknown) => value);
      expect(failure).toMatchObject({ code: "provider_context_length_exceeded", message: "openai_response_stream_failed" });
      expect(JSON.stringify(failure)).not.toContain(sentinel);

      const unrelated = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn: async () => Response.json({
        error: { code: "invalid_value", message: `maximum length of the name ${sentinel}` } }, { status: 400 }) });
      const other = await unrelated.create({}).catch((value: unknown) => value);
      expect(other).not.toHaveProperty("code", "provider_context_length_exceeded");
      expect(other).not.toHaveProperty("reportedPromptTokens");
    });
  });

  it("bounded-retries only opted-in refusals that prove the Responses request was not accepted", async () => {
    const calls: Array<{ body: string; url: string }> = [];
    const sleeps: number[] = [];
    const responses = [
      new Response("rate limited", {
        headers: { "retry-after": "1" },
        status: 429
      }),
      new Response(JSON.stringify({ id: "response-json", status: "completed" })),
      new Response("temporarily unavailable", { headers: { "retry-after": "1" }, status: 503 }),
      new Response("event: response.completed\ndata: {}\n\n")
    ];
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn: async (input, init) => {
        calls.push({ body: String(init?.body), url: String(input) });
        return responses.shift() ?? new Response("{}", { status: 500 });
      },
      initialRequestRetry: {
        maxAttempts: 2,
        random: () => 0,
        sleep: async (delayMs, signal) => {
          expect(signal.aborted).toBe(false);
          sleeps.push(delayMs);
        }
      }
    });

    await expect(client.create({ model: "gpt-test", stream: false })).resolves.toMatchObject({
      id: "response-json"
    });
    const stream = await client.stream!({ model: "gpt-test", stream: true });

    expect(stream.status).toBe(200);
    expect(calls).toEqual([
      { body: JSON.stringify({ model: "gpt-test", stream: false }), url: "https://api.openai.com/v1/responses" },
      { body: JSON.stringify({ model: "gpt-test", stream: false }), url: "https://api.openai.com/v1/responses" },
      { body: JSON.stringify({ model: "gpt-test", stream: true }), url: "https://api.openai.com/v1/responses" },
      { body: JSON.stringify({ model: "gpt-test", stream: true }), url: "https://api.openai.com/v1/responses" }
    ]);
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  describe("ambiguous compatible create", () => {
    const retry = { maxAttempts: 3, random: () => 0, sleep: async () => undefined };

    it.each<[number, string | null]>([
      [500, null], [502, "1"], [504, null], [409, null], [503, null], [408, null]
    ])("never replays HTTP %i (Retry-After %s) that may follow acceptance", async (status, retryAfter) => {
      for (const send of ["create", "stream"] as const) {
        const fetchFn = vi.fn<typeof fetch>(async () => new Response("upstream failure", {
          status, ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) }));
        const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn, initialRequestRetry: retry, requestIsolation: true });
        await expect(client[send]!({ model: "gpt-test" })).rejects.toMatchObject({
          message: `OpenAI request failed with status ${status}`, status });
        expect(fetchFn).toHaveBeenCalledOnce();
      }
    });

    it.each([
      ["a native fetch TypeError", () => new TypeError("synthetic connection lost after dispatch")],
      ["a safe-fetch failure without delivery proof", () => new ProviderSafeFetchError("provider_http_request_failed")]
    ])("reports %s as an unknown outcome without a second POST", async (_label, failure) => {
      for (const send of ["create", "stream"] as const) {
        const cause = failure();
        const fetchFn = vi.fn<typeof fetch>(async () => { throw cause; });
        const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn, initialRequestRetry: retry, requestIsolation: true });
        const error = await client[send]!({ model: "gpt-test" }).catch((value: unknown) => value);
        expect(error).toMatchObject({ code: "provider_request_outcome_unknown", message: "provider_request_outcome_unknown", cause });
        expect(fetchFn).toHaveBeenCalledOnce();
        // Not an unpaid context refusal, and no billing claim either way.
        expect(providerContextRejection(error)).toBeNull();
        expect(observedFailure(error)).toEqual({ code: "provider_request_outcome_unknown", reason: "network" });
        expect(providerFailureMessage(error)).toMatch(/outcome and any provider charge are unknown/u);
      }
    });

    it("replays only transport failures proven undelivered, each with a fresh routing key", async () => {
      const failures = [
        new ProviderSafeFetchError("provider_http_dns_failed"),
        new ProviderSafeFetchError("provider_http_request_failed", { requestNotSent: true })
      ];
      const bodies: Record<string, unknown>[] = [];
      const client = createFetchOpenAIResponsesClient({ apiKey: "key", initialRequestRetry: retry, requestIsolation: true,
        fetchFn: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          const failure = failures.shift();
          if (failure) throw failure;
          return Response.json({ id: "delivered" });
        } });
      await expect(client.create({ model: "gpt-test" })).resolves.toEqual({ id: "delivered" });
      expect(bodies).toHaveLength(3);
      expect(new Set(bodies.map((body) => body.prompt_cache_key)).size).toBe(3);
    });

    it.each([
      ["without the compatible opt-in", undefined],
      ["when the caller disables transport replay", { maxAttempts: 1 }]
    ] as const)("keeps an unproven transport failure's identity %s", async (_label, initialRequestRetry) => {
      const cause = new ProviderSafeFetchError("provider_http_request_failed");
      const fetchFn = vi.fn<typeof fetch>(async () => { throw cause; });
      const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn, initialRequestRetry });
      await expect(client.create({ model: "gpt-test" })).rejects.toBe(cause);
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it("keeps caller cancellation distinct from an unknown outcome", async () => {
      const controller = new AbortController();
      const cancellation = new Error("caller_cancelled");
      const fetchFn = vi.fn<typeof fetch>(async () => {
        controller.abort(cancellation);
        throw new TypeError("socket closed by abort");
      });
      const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn, initialRequestRetry: retry });
      await expect(client.create({}, { signal: controller.signal })).rejects.toBe(cancellation);
      expect(fetchFn).toHaveBeenCalledOnce();
    });
  });

  it("does not replay an initial Responses failure without the stateless opt-in", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response("gateway unavailable", { status: 502 })
    );
    const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn });

    await expect(client.create({ model: "gpt-test" })).rejects.toThrow(
      "OpenAI request failed with status 502"
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps retry backoff inside the original Responses request deadline (isolation=%s)", async (requestIsolation) => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response("rate limited", { status: 429 })
    );
    const sleep = vi.fn(async (_delayMs: number, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        const rejectFromSignal = () => reject(signal.reason);
        if (signal.aborted) rejectFromSignal();
        else signal.addEventListener("abort", rejectFromSignal, { once: true });
      }));
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      defaultTimeoutMs: 5,
      fetchFn,
      requestIsolation,
      initialRequestRetry: { maxAttempts: 3, random: () => 0, sleep }
    });

    // A wait the remaining deadline cannot hold ends with the provider's own
    // refusal at once, never with the deadline it would have outlasted.
    await expect(client.create({ model: "gpt-test" })).rejects.toMatchObject({ status: 429 });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();

    // A Retry-After the deadline holds still waits inside it and is ended by it.
    const later = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503, headers: { "retry-after": "1" } }));
    const bounded = createFetchOpenAIResponsesClient({ apiKey: "key", defaultTimeoutMs: 1_200, fetchFn: later, requestIsolation,
      initialRequestRetry: { maxAttempts: 3, random: () => 0, sleep } });
    await expect(bounded.create({ model: "gpt-test" })).rejects.toMatchObject({ code: "provider_request_timed_out", timeoutMs: 1_200 });
    expect(later).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000, expect.any(AbortSignal));
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

  it.each([false, true])("releases the ordinary deadline at successful SSE headers but keeps caller cancellation (isolation=%s)", async (requestIsolation) => {
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const response = new Response(new ReadableStream<Uint8Array>());

    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      defaultTimeoutMs: 5,
      requestIsolation,
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

  it.each([false, true])("combines caller cancellation with transport timeouts for signal-aware methods (isolation=%s)", async (requestIsolation) => {
    const controller = new AbortController();
    controller.abort(new Error("caller_cancelled"));
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      requestIsolation,
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
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = createFetchOpenAIResponsesClient({
      apiKey: "key",
      fetchFn,
      initialRequestRetry: { maxAttempts: 3 }
    });

    await expect(client.stream!({ stream: true })).rejects.toThrow("openai_stream_body_missing");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("compatible dropped-round decision", () => {
  const failureOf = async (response: () => Response) => {
    const client = createFetchOpenAIResponsesClient({ apiKey: "key", fetchFn: async () => response(),
      acceptStreamedCreate: true, initialRequestRetry: { maxAttempts: 3, sleep: async () => undefined } });
    return client.create({ stream: false }).then(() => null, (error: unknown) => error);
  };
  const sse = (data: readonly unknown[]) => () => new Response(data.map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });

  it("sends a 502 again, with its Retry-After, unless its body classifies it", async () => {
    // The transport itself never replays a 502: the round owner decides.
    const plain = await failureOf(() => new Response(JSON.stringify({ error: { code: "server_is_overloaded", message: "x" } }), { status: 502 }));
    expect(compatibleDroppedRoundDecision(plain)).toEqual({ retryAfterMs: null });
    const later = await failureOf(() => new Response("{}", { headers: { "retry-after": "3" }, status: 502 }));
    expect(compatibleDroppedRoundDecision(later)).toEqual({ retryAfterMs: 3_000 });
    const tooLong = await failureOf(() => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "x" } }), { status: 502 }));
    expect(compatibleDroppedRoundDecision(tooLong)).toBeNull();
    for (const status of [400, 429, 500, 503, 504]) {
      expect(compatibleDroppedRoundDecision(await failureOf(() => new Response("{}", { status })))).toBeNull();
    }
  });

  it("sends a request on an expired gateway connection again", async () => {
    const sentinel = "PRIVATE_GATEWAY_MESSAGE_CANARY";
    // Codex LB's answer when the upstream WebSocket a routing key held passed its 60 minutes.
    const error = { code: "websocket_connection_limit_reached", message: `Responses websocket connection limit reached. ${sentinel}`,
      param: null, type: "invalid_request_error" };
    let sent = 0;
    const http = await failureOf(() => {
      sent += 1;
      return Response.json({ error }, { status: 400 });
    });
    // The transport never replays it itself; the round owner sends it again.
    expect(sent).toBe(1);
    expect(http).toMatchObject({ connectionExpired: true, status: 400 });
    expect(compatibleDroppedRoundDecision(http)).toEqual({ retryAfterMs: null });
    expect(observedFailure(http)).toMatchObject({ httpStatus: 400, provider_error_code: "websocket_connection_limit_reached" });
    expect(JSON.stringify(http)).not.toContain(sentinel);
    expect(String(http)).not.toContain(sentinel);
    // Another 400 of that type stays the request's own.
    const other = await failureOf(() => Response.json({ error: { ...error, code: "invalid_request_error" } }, { status: 400 }));
    expect(other).not.toHaveProperty("connectionExpired");
    expect(compatibleDroppedRoundDecision(other)).toBeNull();
  });

  it("sends a silent stream and a response that never started again, but not a stream cut at its ceiling", () => {
    expect(compatibleDroppedRoundDecision(new ProviderStreamIdleTimeoutError({ idleTimeoutMs: 60_000, observedIdleMs: 60_000 }))).toEqual({ retryAfterMs: null });
    const late = markProviderStreamProgress(new ProviderRequestTimeoutError(300_000), providerStreamProgressFacts({ responseStarted: false }));
    expect(compatibleDroppedRoundDecision(late)).toEqual({ retryAfterMs: null });
    const ceiling = markProviderStreamProgress(new ProviderRequestTimeoutError(1_800_000),
      providerStreamProgressFacts({ lastEventMs: 1_000, responseStarted: true }));
    expect(compatibleDroppedRoundDecision(ceiling)).toBeNull();
    expect(compatibleDroppedRoundDecision(new ProviderRequestTimeoutError(300_000))).toBeNull();
  });

  it("sends a streamed create that dropped before completion again", async () => {
    const truncated = await failureOf(sse(["[DONE]"]));
    expect(providerStreamDrop(truncated)).toBe("truncated");
    expect(compatibleDroppedRoundDecision(truncated)).toEqual({ retryAfterMs: null });
    const cut = await failureOf(sse(["{\"type\":\"response.output_item.do"]));
    expect(providerStreamDrop(cut)).toBe("truncated");
    const errorEvent = await failureOf(sse([{ code: "server_error", message: "x", type: "error" }]));
    expect(providerStreamDrop(errorEvent)).toBe("error_event");
    expect(compatibleDroppedRoundDecision(errorEvent)).toEqual({ retryAfterMs: null });
    const contextLength = await failureOf(sse([{ code: "context_length_exceeded", message: "x", type: "error" }]));
    expect(contextLength).toMatchObject({ code: "provider_context_length_exceeded" });
    expect(providerStreamDrop(contextLength)).toBeNull();
    expect(compatibleDroppedRoundDecision(contextLength)).toBeNull();
  });

  it("keeps every other failure", () => {
    expect(compatibleDroppedRoundDecision(new Error("openai_stream_truncated"))).toBeNull();
    expect(compatibleDroppedRoundDecision(new ProviderSafeFetchError("provider_http_request_failed"))).toBeNull();
    expect(compatibleDroppedRoundDecision(markProviderStreamDrop(Object.assign(new Error("x"), { code: "provider_response_not_retryable" }),
      "response_failed"))).toBeNull();
    expect(compatibleDroppedRoundDecision(markProviderStreamDrop(Object.assign(new Error("x"), { capabilityFailureReason: "refusal" }),
      "response_failed"))).toBeNull();
    expect(compatibleDroppedRoundDecision(markProviderStreamDrop(Object.assign(new Error("aborted"), { code: "ECONNRESET" }), "reset")))
      .toEqual({ retryAfterMs: null });
    expect(compatibleDroppedRoundDecision(null)).toBeNull();
  });
});
