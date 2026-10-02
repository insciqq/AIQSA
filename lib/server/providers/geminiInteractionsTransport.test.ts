import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderResponseTooLargeError } from "./network";
import {
  createFetchGeminiInteractionsClient,
  deriveGeminiInteractionsEndpoint,
  GeminiHttpError
} from "./geminiInteractionsTransport";
import {
  observedFailure,
  observeProviderFetch,
  observeProviderOperation,
  providerContextRejection,
  providerHttpFailureMessage
} from "./providerObservability";
import { ProviderSafeFetchError } from "./providerSafeFetch";

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

  it.each([
    ["the Interactions envelope without status or details",
      { error: { code: "invalid_request", message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)." } },
      { reportedMaximumTokens: 1_048_576, reportedPromptTokens: 1_200_000 }],
    ["a Google standard envelope",
      { error: { code: 400, message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
        status: "INVALID_ARGUMENT" } },
      { reportedMaximumTokens: 1_048_576, reportedPromptTokens: 1_200_000 }],
    ["a streaming array envelope",
      [{ error: { code: 400, message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
        status: "INVALID_ARGUMENT" } }],
      { reportedMaximumTokens: 1_048_576, reportedPromptTokens: 1_200_000 }],
    ["the Vertex wording",
      { error: { code: 400, message: "Unable to submit request because the input token count is 1234567 but model only supports up to 1048576. Reduce the input token count and try again.",
        status: "INVALID_ARGUMENT" } },
      { reportedMaximumTokens: 1_048_576, reportedPromptTokens: 1_234_567 }]
  ])("reaches the classifier before any identity reduction for %s", async (_case, envelope, counts) => {
    const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => Response.json(envelope, { status: 400 }) });
    for (const send of [client.createInteraction, client.streamInteraction]) {
      const failure = await send({}).catch((value: unknown) => value);
      expect(failure).toBeInstanceOf(GeminiHttpError);
      expect(failure).toMatchObject({ code: "context_length_exceeded", httpStatus: 400, ...counts });
      expect(JSON.stringify(failure)).not.toMatch(/token count|INVALID_ARGUMENT/u);
    }
  });

  it("keeps the Interactions API's generic overflow envelope an ordinary invalid_request", async () => {
    // Observed 2026-09-27 for an oversized input; a rejected tool schema gets the same answer.
    const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => Response.json({ error: {
      code: "invalid_request", message: "Invalid input received." } }, { status: 400 }) });
    for (const send of [client.createInteraction, client.streamInteraction]) {
      const failure = await send({}).catch((value: unknown) => value);
      expect(failure).toMatchObject({ code: "invalid_request", httpStatus: 400 });
      expect(failure).not.toHaveProperty("reportedPromptTokens");
      expect(failure).not.toHaveProperty("reportedMaximumTokens");
    }
  });

  it("recovers the ordinary identity from a streaming array envelope", async () => {
    const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn: async () => Response.json([{ error: {
      code: "invalid_request", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } }], { status: 400 }) });
    const failure = await client.createInteraction({}).catch((value: unknown) => value);
    expect(failure).toMatchObject({ code: "invalid_request", httpStatus: 400 });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_");
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
  describe("opted-in initial-request replay", () => {
    const sends = ["createInteraction", "streamInteraction"] as const;
    const body = { input: "PRIVATE_PROMPT_CANARY", model: "gemini-test", store: false };
    const success = () => new Response(JSON.stringify({ id: "interaction-ok", status: "completed" }));
    type Step = () => Response | Promise<never>;

    function replayClient(steps: Step[], sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>) {
      const bodies: string[] = [];
      const sleeps: number[] = [];
      const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
        bodies.push(String(init?.body));
        const next = steps.shift();
        return next ? await next() : success();
      });
      const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn, initialRequestRetry: {
        maxAttempts: 3,
        random: () => 0,
        sleep: sleep ?? (async (delayMs) => { sleeps.push(delayMs); })
      } });
      return { bodies, client, fetchFn, sleeps };
    }

    const refusal = (status: number, retryAfter?: string): Step => () => new Response(
      JSON.stringify({ error: { message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } }),
      { status, ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) });
    const thrown = (failure: () => unknown): Step => () => Promise.reject(failure());

    it.each<[string, () => Step, readonly number[]]>([
      ["a DNS failure", () => thrown(() => new ProviderSafeFetchError("provider_http_dns_failed")), [125, 250]],
      ["a proven-unsent connection failure",
        () => thrown(() => new ProviderSafeFetchError("provider_http_request_failed", { requestNotSent: true })), [125, 250]],
      ["HTTP 429", () => refusal(429), [125, 250]],
      ["HTTP 429 with Retry-After", () => refusal(429, "2"), [2_000, 2_000]],
      ["HTTP 408 with Retry-After", () => refusal(408, "2"), [2_000, 2_000]],
      ["HTTP 503 with Retry-After", () => refusal(503, "2"), [2_000, 2_000]],
      ["HTTP 503 without Retry-After (Gemini-owned admission)", () => refusal(503), [125, 250]]
    ])("replays %s with a byte-identical body and completes on a later attempt", async (_label, failure, delays) => {
      for (const send of sends) {
        const { bodies, client, fetchFn, sleeps } = replayClient([failure(), failure()]);
        const result = await client[send](body);
        if (send === "createInteraction") expect(result).toEqual({ id: "interaction-ok", status: "completed" });
        else expect((result as Response).status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(bodies).toEqual(Array(3).fill(JSON.stringify(body)));
        expect(sleeps).toEqual(delays);
      }
    });

    it("fails three consecutive 503s after three fetches with the value-free status message", async () => {
      for (const send of sends) {
        const { client, fetchFn, sleeps } = replayClient([refusal(503), refusal(503), refusal(503), refusal(503)]);
        const failure = await client[send](body).catch((value: unknown) => value);
        expect(failure).toBeInstanceOf(GeminiHttpError);
        expect(failure).toMatchObject({ httpStatus: 503, retryAfterMs: null, message: "Gemini request failed with status 503" });
        expect(JSON.stringify(failure)).not.toContain("PRIVATE_");
        expect(fetchFn).toHaveBeenCalledTimes(3);
        expect(sleeps).toHaveLength(2);
      }
    });

    it.each([429, 408, 503])("stops after one fetch when the HTTP %i Retry-After exceeds the shared ceiling", async (status) => {
      for (const send of sends) {
        const { client, fetchFn, sleeps } = replayClient([refusal(status, "301")]);
        await expect(client[send](body)).rejects.toMatchObject({ httpStatus: status, retryAfterMs: 301_000 });
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(sleeps).toEqual([]);
      }
    });

    it.each(sends)("ends a backoff longer than the remaining deadline as a request timeout (%s)", async (send) => {
      const fetchFn = vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }));
      const client = createFetchGeminiInteractionsClient({ apiKey: "key", defaultTimeoutMs: 5, fetchFn, initialRequestRetry: {
        maxAttempts: 3,
        sleep: async (_delayMs, signal) => new Promise<void>((_resolve, reject) => {
          const rejectFromSignal = () => reject(signal.reason);
          if (signal.aborted) rejectFromSignal();
          else signal.addEventListener("abort", rejectFromSignal, { once: true });
        })
      } });
      await expect(client[send](body)).rejects.toMatchObject({ code: "provider_request_timed_out", timeoutMs: 5 });
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it.each<[number, string | null]>([
      [400, null], [401, null], [403, null], [404, null], [409, null], [500, null], [502, null], [502, "1"], [504, null], [408, null]
    ])("never replays HTTP %i (Retry-After %s)", async (status, retryAfter) => {
      for (const send of sends) {
        const { client, fetchFn, sleeps } = replayClient([refusal(status, retryAfter ?? undefined)]);
        const failure = await client[send](body).catch((value: unknown) => value);
        expect(failure).toBeInstanceOf(GeminiHttpError);
        expect(failure).toMatchObject({ httpStatus: status, message: `Gemini request failed with status ${status}` });
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(sleeps).toEqual([]);
      }
    });

    it.each([
      ["a native fetch TypeError", () => new TypeError("synthetic connection lost after dispatch")],
      ["a safe-fetch failure without delivery proof", () => new ProviderSafeFetchError("provider_http_request_failed")]
    ])("reports %s as an unknown outcome without a second POST when replay is owned", async (_label, make) => {
      for (const send of sends) {
        const cause = make();
        const { client, fetchFn } = replayClient([() => Promise.reject(cause)]);
        const error = await client[send](body).catch((value: unknown) => value);
        expect(error).toMatchObject({ code: "provider_request_outcome_unknown", message: "provider_request_outcome_unknown", cause });
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(providerContextRejection(error)).toBeNull();
        expect(observedFailure(error)).toEqual({ code: "provider_request_outcome_unknown", reason: "network" });
        expect(providerHttpFailureMessage(error)).toMatch(/outcome and any provider charge are unknown/u);
      }
    });

    it.each([
      ["without the opt-in", undefined],
      ["when the caller disables replay", { maxAttempts: 1 }]
    ] as const)("keeps an unproven transport failure's raw identity %s", async (_label, initialRequestRetry) => {
      for (const cause of [new TypeError("synthetic connection lost"), new ProviderSafeFetchError("provider_http_request_failed")]) {
        for (const send of sends) {
          const fetchFn = vi.fn<typeof fetch>(async () => { throw cause; });
          const client = createFetchGeminiInteractionsClient({ apiKey: "key", fetchFn, initialRequestRetry });
          await expect(client[send](body)).rejects.toBe(cause);
          expect(fetchFn).toHaveBeenCalledOnce();
        }
      }
    });

    it("never replays after a 2xx response, whatever its body later does", async () => {
      const invalidJson = replayClient([() => new Response("{not json")]);
      await expect(invalidJson.client.createInteraction(body)).rejects.toThrow("gemini_interactions_response_invalid_json");
      expect(invalidJson.fetchFn).toHaveBeenCalledOnce();

      const missingBody = replayClient([() => new Response(null)]);
      await expect(missingBody.client.streamInteraction(body)).rejects.toThrow("gemini_interactions_stream_body_missing");
      expect(missingBody.fetchFn).toHaveBeenCalledOnce();

      const brokenStream = replayClient([() => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new TypeError("synthetic stream loss")); }
      }), { headers: { "content-type": "text/event-stream" } })]);
      const stream = await brokenStream.client.streamInteraction(body);
      await expect(stream.text()).rejects.toThrow("synthetic stream loss");
      expect(brokenStream.fetchFn).toHaveBeenCalledOnce();
    });

    it("keeps caller cancellation during a fetch distinct from an unknown outcome", async () => {
      for (const send of sends) {
        const controller = new AbortController();
        const cancellation = new Error("caller_cancelled");
        const { client, fetchFn } = replayClient([() => {
          controller.abort(cancellation);
          return Promise.reject(new TypeError("socket closed by abort"));
        }]);
        await expect(client[send](body, { signal: controller.signal })).rejects.toBe(cancellation);
        expect(fetchFn).toHaveBeenCalledOnce();
      }
    });

    it("rejects with the caller's reason when cancelled during backoff, without another POST", async () => {
      for (const send of sends) {
        const controller = new AbortController();
        const cancellation = new Error("caller_cancelled_during_backoff");
        const { client, fetchFn } = replayClient([refusal(503)], async (_delayMs, signal) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort(cancellation);
        }));
        await expect(client[send](body, { signal: controller.signal })).rejects.toBe(cancellation);
        expect(fetchFn).toHaveBeenCalledOnce();
      }
    });

    it("records content-free retry and stop decisions inside an observation scope", async () => {
      const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const responses = [refusal(503)(), refusal(429, "1")(), refusal(503)()];
        const fetchFn = observeProviderFetch(vi.fn<typeof fetch>(async () => responses.shift() ?? success()));
        const client = createFetchGeminiInteractionsClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn,
          initialRequestRetry: { maxAttempts: 3, random: () => 0, sleep: async () => undefined } });
        const identity = { adapterKind: "gemini_interactions_native", providerFamily: "gemini",
          connectionId: "connection-safe", providerModelId: "model-safe" };
        await expect(observeProviderOperation(identity, "answer", () => client.createInteraction(body), { timeoutMs: 5_000 }))
          .rejects.toMatchObject({ httpStatus: 503 });
        const records = writer.mock.calls.flatMap(([chunk]) => {
          try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
        });
        expect(records.filter((entry) => entry.event === "provider_retry")).toMatchObject([
          { attempt: 1, action: "retry", httpStatus: 503, delay_ms: 125 },
          { attempt: 2, action: "retry", httpStatus: 429, delay_ms: 1_000 },
          { attempt: 3, action: "stop", httpStatus: 503 }
        ]);
        expect(records.filter((entry) => entry.event === "provider_request").map((entry) => entry.attempt)).toEqual([1, 2, 3]);
        expect(JSON.stringify(records)).not.toMatch(/PRIVATE_/u);
      } finally {
        writer.mockRestore();
      }
    });
  });
});
