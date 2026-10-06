// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import {
  observedFailure,
  observedFailureWithoutHttpClass,
  observeProviderFetch,
  observeProviderOperation,
  observeProviderStream,
  providerContextRejection,
  providerHttpFailureMessage
} from "./providerObservability";
import { createFetchGeminiInteractionsClient, GeminiHttpError } from "./geminiInteractionsTransport";
import { createFetchOpenAIResponsesClient } from "./openaiResponsesTransport";
import { createFetchOpenAIChatCompletionClient } from "./openaiCompatibleChatTransport";
import { createFetchDeepSeekResponsesClient } from "./deepSeekResponsesTransport";
import { createFetchAnthropicMessagesClient } from "./anthropicMessages";
import { executeWithProviderRetry } from "./providerRetry";
import { ProviderRequestTimeoutError, withTimeoutSignal } from "./network";
import { ProviderSearchExecutionError } from "./types";
import { GeminiInteractionsStreamError } from "./geminiInteractionsStreamError";
import { parseGeminiInteractionsSse } from "./geminiInteractionsResponse";

const identity = { adapterKind: "openai_responses_compatible", providerFamily: "openai_compatible", connectionId: "connection-safe", providerModelId: "model-safe" };

function capture() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => writer.mock.calls.flatMap(([chunk]) => {
    try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
  });
}

describe("provider diagnostics", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["deepseek", "anthropic"])("retains the safe %s invalid-request code in operation evidence", async (provider) => {
    const records = capture();
    const fetchFn = observeProviderFetch(async () => Response.json({ error: {
      type: "invalid_request_error", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } }, { status: 400 }));
    const send = provider === "deepseek"
      ? () => createFetchDeepSeekResponsesClient({ apiKey: "synthetic", fetchFn }).create({})
      : () => createFetchAnthropicMessagesClient({ apiKey: "synthetic", fetchFn }).createMessage({});
    await observeProviderOperation(identity, "answer", send).catch(() => undefined);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed",
      code: "provider_http_invalid_request", httpStatus: 400, reason: "http" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_PROVIDER_MESSAGE_CANARY");
  });

  it("keeps physical attempts and retry decisions under the accepted identity without reading bodies", async () => {
    const records = capture();
    const first = new Response("PRIVATE_UPSTREAM_BODY_CANARY", { status: 503 });
    const final = new Response("PRIVATE_ANSWER_CANARY", { status: 200 });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(final);
    const request = observeProviderFetch(fetchFn);
    await runWithContext({ trace_id: "1".repeat(32), run_id: "run-safe" }, () => observeProviderOperation(identity, "answer", () => executeWithProviderRetry({
      signal: new AbortController().signal,
      options: { maxAttempts: 2, sleep: async () => undefined },
      shouldRetry: () => ({ retryAfterMs: null }),
      operation: async () => {
        const response = await request("https://PRIVATE_ENDPOINT_CANARY.test/private", {
          method: "POST", headers: { authorization: "Bearer PRIVATE_CREDENTIAL_CANARY" }, body: "PRIVATE_PROMPT_CANARY"
        });
        if (!response.ok) throw Object.assign(new Error("PRIVATE_EXCEPTION_CANARY"), { status: response.status });
        return response;
      }
    }), { timeoutMs: 5000 }));
    expect(first.bodyUsed).toBe(false);
    expect(final.bodyUsed).toBe(false);
    expect(records().filter((entry) => entry.event === "provider_request")).toMatchObject([
      { attempt: 1, httpStatus: 503, outcome: "failed" }, { attempt: 2, httpStatus: 200, outcome: "completed" }
    ]);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_retry", attempt: 1, action: "retry", httpStatus: 503 }));
    expect(records().every((entry) => entry.trace_id === "1".repeat(32) && entry.run_id === "run-safe" && entry.connectionId === identity.connectionId)).toBe(true);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
    expect(records().filter((entry) => entry.event !== "transport_stage")).toHaveLength(5);
  });

  it("isolates concurrent provider identities and preserves an existing timeout reason", async () => {
    const records = capture();
    vi.useFakeTimers();
    const run = (connectionId: string, traceId: string) => runWithContext({ trace_id: traceId }, () => {
      const timeout = withTimeoutSignal(undefined, 25);
      return observeProviderOperation({ ...identity, connectionId }, "answer", () =>
        new Promise<never>((_resolve, reject) => timeout.signal.addEventListener("abort", () => reject(timeout.signal.reason), { once: true })),
      { signal: timeout.signal, timeoutMs: 25 }).catch((error: unknown) => error).finally(() => timeout.clear());
    });
    const first = run("connection-a", "a".repeat(32));
    const second = run("connection-b", "b".repeat(32));
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({ code: "provider_request_timed_out", timeoutMs: 25 });
    await expect(second).resolves.toMatchObject({ code: "provider_request_timed_out", timeoutMs: 25 });
    expect(records().filter((entry) => entry.outcome === "failed")).toMatchObject([
      { connectionId: "connection-a", trace_id: "a".repeat(32), reason: "deadline", abort_source: "provider_deadline" },
      { connectionId: "connection-b", trace_id: "b".repeat(32), reason: "deadline", abort_source: "provider_deadline" }
    ]);
  });

  it("logs the reviewed Gemini HTTP identity without the provider envelope", async () => {
    const records = capture();
    const client = createFetchGeminiInteractionsClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn: observeProviderFetch(async () =>
      Response.json({ error: { code: "invalid_request", message: "PRIVATE_PROVIDER_MESSAGE_CANARY",
        details: [{ fieldViolations: [{ field: "PRIVATE_FIELD_CANARY" }] }] } }, { status: 400 })) });
    const error = await observeProviderOperation({ ...identity, adapterKind: "gemini_interactions_native", providerFamily: "gemini" },
      "answer", () => client.createInteraction({ input: "PRIVATE_PROMPT_CANARY" })).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed",
      code: "provider_http_invalid_request", httpStatus: 400, reason: "http" }));
    expect(providerHttpFailureMessage(error)).toBe("The model provider rejected the request (Gemini HTTP 400: invalid_request).");
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|fieldViolations/u);
  });

  it.each([
    ["parameter_unknown", "provider_http_parameter_unknown"],
    ["malformed_tool_call", "provider_http_malformed_tool_call"],
    ["malformed_function_call", "provider_http_malformed_function_call"]
  ] as const)("maps the Gemini transport identity %s to a bounded code", (identityCode, code) => {
    expect(observedFailure(new GeminiHttpError(400, identityCode))).toEqual({ code, httpStatus: 400, reason: "http" });
  });

  it("logs a classified context-length rejection with its status only, never the provider message", async () => {
    const records = capture();
    const client = createFetchOpenAIResponsesClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn: observeProviderFetch(async () =>
      Response.json({ error: { code: "context_length_exceeded", param: "input", type: "invalid_request_error",
        message: "Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in 300000 tokens. PRIVATE_PROVIDER_MESSAGE_CANARY" } },
      { status: 400 })) });
    const error = await observeProviderOperation(identity, "answer", () => client.create({ input: "PRIVATE_PROMPT_CANARY" }))
      .catch((failure: unknown) => failure);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed",
      code: "provider_context_length_exceeded", httpStatus: 400, reason: "http" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
    expect(providerContextRejection(error)).toEqual({ httpStatus: 400, maximumTokens: 272_000, promptTokens: 300_000 });
    expect(providerHttpFailureMessage(error)).toBe("The model provider rejected the request as too long for the model's context window (HTTP 400). Reduce the context or choose a model with a larger context window.");
  });

  it("maps the Gemini context-length identity and a generation-time window without a status", () => {
    const gemini = new GeminiHttpError(400, "context_length_exceeded", { reportedMaximumTokens: 1_048_576, reportedPromptTokens: 1_200_000 });
    expect(observedFailure(gemini)).toEqual({ code: "provider_context_length_exceeded", httpStatus: 400, reason: "http" });
    expect(providerContextRejection(gemini)).toEqual({ httpStatus: 400, maximumTokens: 1_048_576, promptTokens: 1_200_000 });
    const stopReason = Object.assign(new Error("anthropic_message_model_context_window_exceeded"), { code: "provider_context_length_exceeded" });
    expect(observedFailure(stopReason)).toEqual({ code: "provider_context_length_exceeded", reason: "safety_limit" });
    expect(providerContextRejection(stopReason)).toEqual({});
    expect(providerHttpFailureMessage(stopReason)).toBe("The request exceeded the model's context window. Reduce the context or choose a model with a larger context window.");
    // Counts outside the reviewed bound never cross; other codes are no rejection.
    expect(providerContextRejection(Object.assign(new Error("x"), { code: "provider_context_length_exceeded", status: 400,
      reportedPromptTokens: 1e12, reportedMaximumTokens: -1 }))).toEqual({ httpStatus: 400 });
    expect(providerContextRejection(new GeminiHttpError(400, "invalid_request"))).toBeNull();
  });

  it("keeps unreviewed or look-alike HTTP failures without a transport identity", () => {
    expect(observedFailure(new GeminiHttpError(400))).toEqual({ code: "unknown", httpStatus: 400, reason: "http" });
    expect(providerHttpFailureMessage(new GeminiHttpError(400))).toBeNull();
    const lookalike = Object.assign(new Error("PRIVATE_MESSAGE_CANARY"), { code: "invalid_request", httpStatus: 400 });
    expect(observedFailure(lookalike)).toEqual({ code: "unknown", httpStatus: 400, reason: "http" });
    expect(providerHttpFailureMessage(lookalike)).toBeNull();
  });

  const authMessage = (status: number) => `The model provider rejected the configured credentials (HTTP ${status}). Ask an administrator to check the provider key.`;
  const quotaMessage = (status: number) => `The model provider reports that the account has no remaining quota or balance (HTTP ${status}). Ask an administrator to check the provider account.`;
  const rateMessage = "The model provider is limiting requests (HTTP 429) and the retries did not succeed. Wait a minute before trying again.";
  const unavailableMessage = (status: number) => `The model provider returned a server error (HTTP ${status}) and the retries did not succeed. Try again later.`;
  const openai = (fetchFn: typeof fetch) => () => createFetchOpenAIResponsesClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn }).create({});
  const openrouter = (fetchFn: typeof fetch) => () => createFetchOpenAIChatCompletionClient({ bodyMissingError: "missing",
    endpoint: "https://openrouter.test/api/v1/chat/completions", fetchFn, headers: { authorization: "Bearer PRIVATE_KEY_CANARY" },
    invalidJsonError: "invalid", notObjectError: "not_object", providerName: "OpenRouter" }).createChatCompletion({});
  const anthropic = (fetchFn: typeof fetch) => () => createFetchAnthropicMessagesClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn }).createMessage({});
  const deepseek = (fetchFn: typeof fetch) => () => createFetchDeepSeekResponsesClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn }).create({});
  const gemini = (fetchFn: typeof fetch) => () => createFetchGeminiInteractionsClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn }).createInteraction({});

  it.each([
    { name: "OpenAI rejected key", send: openai, status: 401, code: "provider_auth_rejected", message: authMessage(401),
      body: { error: { code: "invalid_api_key", type: "invalid_request_error", message: "Incorrect API key provided: PRIVATE_KEY_CANARY" } } },
    { name: "OpenAI forbidden project", send: openai, status: 403, code: "provider_auth_rejected", message: authMessage(403),
      body: { error: { code: "unsupported_country_region_territory", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "OpenAI exhausted quota", send: openai, status: 429, code: "provider_quota_exhausted", message: quotaMessage(429),
      body: { error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "OpenAI rate limit", send: openai, status: 429, code: "provider_rate_limited", message: rateMessage,
      body: { error: { code: "rate_limit_exceeded", type: "requests", message: "Rate limit reached PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "OpenAI outage", send: openai, status: 503, code: "provider_unavailable", message: unavailableMessage(503),
      body: { error: { message: "The server is overloaded PRIVATE_PROVIDER_MESSAGE_CANARY", type: "server_error" } } },
    { name: "OpenRouter credits", send: openrouter, status: 402, code: "provider_quota_exhausted", message: quotaMessage(402),
      body: { error: { code: 402, message: "Insufficient credits PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "OpenRouter rejected key", send: openrouter, status: 401, code: "provider_auth_rejected", message: authMessage(401),
      body: { error: { code: 401, message: "User not found. PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "Anthropic rejected key", send: anthropic, status: 401, code: "provider_auth_rejected", message: authMessage(401),
      body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "Anthropic overload", send: anthropic, status: 529, code: "provider_unavailable", message: unavailableMessage(529),
      body: { type: "error", error: { type: "overloaded_error", message: "Overloaded PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "DeepSeek balance", send: deepseek, status: 402, code: "provider_quota_exhausted", message: quotaMessage(402),
      body: { error: { message: "Insufficient Balance PRIVATE_PROVIDER_MESSAGE_CANARY", type: "unknown_error" } } },
    { name: "Gemini permission", send: gemini, status: 403, code: "provider_auth_rejected", message: authMessage(403),
      body: { error: { code: 403, status: "PERMISSION_DENIED", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } } },
    { name: "Gemini outage", send: gemini, status: 500, code: "provider_unavailable", message: unavailableMessage(500),
      body: { error: { code: 500, status: "INTERNAL", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } } }
  ])("classifies a real-shaped $name response by its status, never its body text", async ({ send, status, code, message, body }) => {
    const records = capture();
    const fetchFn = observeProviderFetch(async () => Response.json(body, { status }));
    const error = await observeProviderOperation(identity, "answer", send(fetchFn)).catch((failure: unknown) => failure);
    expect(observedFailure(error)).toMatchObject({ code, httpStatus: status, reason: "http" });
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed",
      code, httpStatus: status, reason: "http", connectionId: identity.connectionId, providerModelId: identity.providerModelId }));
    expect(providerHttpFailureMessage(error)).toBe(message);
    expect(JSON.stringify([records(), providerHttpFailureMessage(error)])).not.toContain("PRIVATE_");
  });

  it("names an exhausted rate limit only after the unchanged retry policy gave up", async () => {
    const records = capture();
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "rate_limit_exceeded", message: "PRIVATE_PROVIDER_MESSAGE_CANARY" } },
      { status: 429, headers: { "retry-after": "0" } }));
    const client = createFetchOpenAIResponsesClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn: observeProviderFetch(fetchFn),
      initialRequestRetry: { maxAttempts: 3, sleep: async () => undefined } });
    const error = await observeProviderOperation(identity, "answer", () => client.create({})).catch((failure: unknown) => failure);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(records().filter((entry) => entry.event === "provider_retry")).toMatchObject([
      { attempt: 1, action: "retry", code: "provider_rate_limited", httpStatus: 429 },
      { attempt: 2, action: "retry", code: "provider_rate_limited", httpStatus: 429 },
      { attempt: 3, action: "stop", code: "provider_rate_limited", httpStatus: 429 }
    ]);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed", code: "provider_rate_limited", httpStatus: 429 }));
    expect(providerHttpFailureMessage(error)).toBe(rateMessage);
  });

  it("keeps more specific codes ahead of the HTTP status class", () => {
    const withStatus = (status: number, fields: Record<string, unknown> = {}) => Object.assign(new Error("PRIVATE_MESSAGE_CANARY"), { status, ...fields });
    // Context length, refusal, reviewed Gemini identities, unknown outcome and deadlines keep their codes.
    expect(observedFailure(withStatus(429, { code: "provider_context_length_exceeded" })).code).toBe("provider_context_length_exceeded");
    expect(observedFailure(withStatus(403, { code: "provider_response_not_retryable", capabilityFailureReason: "refusal" })).code).toBe("provider_refused");
    expect(observedFailure(new GeminiHttpError(429, "invalid_request")).code).toBe("provider_http_invalid_request");
    expect(observedFailure(withStatus(503, { code: "provider_request_outcome_unknown" })).code).toBe("provider_request_outcome_unknown");
    expect(observedFailure(new ProviderRequestTimeoutError(25)).code).toBe("provider_request_timed_out");
    expect(observedFailure(withStatus(503), AbortSignal.abort()).code).toBe("model_run_cancelled");
    // A generic body rejection keeps its code unless it is a reviewed quota identity or HTTP 402.
    expect(observedFailure(withStatus(500, { code: "provider_response_not_retryable" }))).toEqual({
      code: "provider_response_not_retryable", httpStatus: 500, reason: "http" });
    expect(observedFailure(withStatus(400, { code: "provider_response_not_retryable", quotaExhausted: true })).code).toBe("provider_quota_exhausted");
    expect(observedFailure(withStatus(402, { code: "provider_response_not_retryable" })).code).toBe("provider_quota_exhausted");
    // Without a status there is no class; other statuses stay unclassified.
    expect(observedFailure({ code: "provider_response_not_retryable", quotaExhausted: true })).toEqual({
      code: "provider_response_not_retryable", reason: "policy" });
    expect(observedFailure(withStatus(404)).code).toBe("unknown");
    expect(observedFailure(withStatus(408)).code).toBe("unknown");
    // The pre-class identity stays available for consumers whose decisions branch on it.
    expect(observedFailureWithoutHttpClass(withStatus(401))).toEqual({ code: "unknown", httpStatus: 401, reason: "http" });
    expect(observedFailureWithoutHttpClass(withStatus(429, { code: "provider_response_not_retryable", quotaExhausted: true })).code)
      .toBe("provider_response_not_retryable");
    expect(providerHttpFailureMessage(withStatus(404))).toBeNull();
  });

  it("explains a typed invalid request across native transports without provider prose", () => {
    const error = Object.assign(new Error("PRIVATE_PROVIDER_CANARY"), { code: "provider_http_invalid_request", status: 400 });
    expect(providerHttpFailureMessage(error)).toBe("The model provider rejected the request (HTTP 400: invalid_request).");
    expect(providerHttpFailureMessage({ code: "provider_http_invalid_request", status: 503 })).toBeNull();
  });

  it("does not invoke untrusted error getters or infer codes from exception text", () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER_CANARY"); });
    const error = Object.defineProperties(new Error("provider_request_timed_out PRIVATE_MESSAGE_CANARY"), {
      code: { get: getter }, status: { get: getter }, httpStatus: { get: getter }, statusCode: { get: getter }
    });
    expect(observedFailure(error)).toEqual({ code: "unknown", reason: "unknown" });
    expect(getter).not.toHaveBeenCalled();
    expect(observedFailure(new TypeError("PRIVATE_TYPE_ERROR_CANARY"))).toEqual({ code: "unknown", reason: "unknown" });
  });

  it("retains the parser's Gemini failure identity through a streamed operation", async () => {
    const records = capture();
    const responseBody = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("event: interaction.created\ndata: PRIVATE_INVALID_JSON_CANARY\n\n"));
      controller.close();
    } });
    const iterator = observeProviderStream({ ...identity, adapterKind: "gemini_interactions_native", providerFamily: "gemini" },
      parseGeminiInteractionsSse({ responseBody, modelId: "gemini-test", groundingExpected: false }),
      { timeoutMs: 1000, signal: new AbortController().signal });

    await expect(iterator.next()).rejects.toMatchObject({ code: "gemini_interactions_stream_invalid_json" });
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed",
      code: "gemini_interactions_stream_invalid_json", reason: "invalid_response" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("does not treat the Gemini diagnostic prefix or exception text as an allowlist", () => {
    expect(observedFailure(new Error("gemini_interactions_stream_truncated")))
      .toEqual({ code: "unknown", reason: "unknown" });
    const error = new GeminiInteractionsStreamError("gemini_interactions_stream_truncated");
    error.message = "PRIVATE_PROVIDER_CANARY";
    expect(observedFailure(error)).toEqual({ code: "gemini_interactions_stream_truncated", reason: "invalid_response" });
    Object.defineProperty(error, "code", { value: "gemini_interactions_stream_PRIVATE_CANARY" });
    expect(observedFailure(error)).toEqual({ code: "unknown", reason: "unknown" });
    const getter = vi.fn(() => "gemini_interactions_stream_truncated");
    Object.defineProperty(error, "code", { get: getter });
    expect(observedFailure(error)).toEqual({ code: "unknown", reason: "unknown" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("recognizes native local deadlines without reading arbitrary name getters", async () => {
    const records = capture();
    const signal = AbortSignal.timeout(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(signal.aborted).toBe(true);
    await expect(observeProviderOperation(identity, "embedding", async () => { throw signal.reason; }, { signal }))
      .rejects.toBe(signal.reason);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed",
      reason: "deadline", code: "operation_timed_out", abort_source: "parent_signal" }));
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER"); });
    const forged = Object.defineProperty(new Error("TimeoutError"), "name", { get: getter });
    expect(observedFailure(forged)).toEqual({ code: "unknown", reason: "unknown" });
    expect(getter).not.toHaveBeenCalled();
    const stop = new AbortController();
    stop.abort(new Error("search_timeout"));
    expect(observedFailure(stop.signal.reason, stop.signal)).toMatchObject({ reason: "cancelled" });
  });

  it.each(["embedding_request_timed_out", "rerank_request_timed_out"])("preserves the adapter deadline code %s", async code => {
    const records = capture();
    const error = Object.assign(new Error("PRIVATE_ERROR"), { code });
    await expect(observeProviderOperation(identity, "embedding", async () => { throw error; })).rejects.toBe(error);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed", reason: "deadline", code }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_ERROR");
  });

  it("uses the actual failed deadline before configured operation or request timeouts", async () => {
    const records = capture();
    const error = new ProviderRequestTimeoutError(37);
    const request = observeProviderFetch(vi.fn<typeof fetch>().mockRejectedValue(error));
    await expect(observeProviderOperation(identity, "answer", () => request("https://provider.example.test"), {
      timeoutMs: 12_000, requestTimeoutMs: 5_000
    })).rejects.toBe(error);
    expect(records().filter((entry) => entry.outcome === "failed" && entry.event !== "transport_stage")).toMatchObject([
      { event: "provider_request", timeout_ms: 37, reason: "deadline", abort_source: "provider_deadline" },
      { event: "provider_operation", timeout_ms: 37, reason: "deadline", abort_source: "provider_deadline" }
    ]);
  });

  it.each([
    { status: "incomplete", reason: "max_output_tokens", cause: "max_output_tokens", category: "safety_limit" },
    { status: "incomplete", reason: "content_filter", cause: "content_filter", category: "policy" },
    { status: "incomplete", reason: "PRIVATE_REASON_CANARY", cause: undefined, category: "invalid_response" },
    { status: "failed", reason: undefined, cause: undefined, category: "invalid_response" },
    { status: "cancelled", reason: undefined, cause: undefined, category: "cancelled" },
    { status: "queued", reason: undefined, cause: undefined, category: "invalid_response" }
  ])("projects typed Search status $status and cause $category without changing the failure", async ({ status, reason, cause, category }) => {
    const records = capture();
    const code = status === "queued" ? "openai_response_not_completed" : `openai_response_${status}`;
    const error = new ProviderSearchExecutionError({
      artifacts: [{ type: "artifact", data: { artifactType: "search", payload: { query: "PRIVATE_QUERY_CANARY" } } }],
      code, providerStatus: status, reason,
      usage: { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 3, outputTokens: 2, reasoningTokens: 0 }
    });
    error.message = "PRIVATE_ERROR_CANARY";
    Object.freeze(error);
    await expect(observeProviderOperation(identity, "search", async () => { throw error; })).rejects.toBe(error);
    const terminal = records().filter((entry) => entry.outcome !== "started");
    expect(terminal).toMatchObject([{
      event: "provider_operation", stage: "search", code, provider_status: status,
      reason: category, outcome: status === "cancelled" ? "cancelled" : "failed"
    }]);
    expect(terminal[0]?.cause).toBe(cause);
    expect(error.usage.inputTokens).toBe(3);
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|artifacts|inputTokens|outputTokens/);
  });

  it("accepts Search causes and statuses only from typed failures and bounded values", () => {
    expect(observedFailure({ code: "openai_response_incomplete", reason: "max_output_tokens", providerStatus: "incomplete" }))
      .toEqual({ code: "openai_response_incomplete", reason: "invalid_response" });
    const error = new ProviderSearchExecutionError({ artifacts: [], code: "PRIVATE_CODE_CANARY",
      providerStatus: "PRIVATE_STATUS_CANARY", reason: "PRIVATE_REASON_CANARY",
      usage: { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } });
    expect(observedFailure(error)).toEqual({ code: "unknown", reason: "unknown" });
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER_CANARY"); });
    Object.defineProperties(error, { providerStatus: { get: getter }, reason: { get: getter } });
    expect(observedFailure(error)).toEqual({ code: "unknown", reason: "unknown" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("reports resolved refresh failures and yielded error frames without a false provider success", async () => {
    const records = capture();
    const refreshResult = { error: { code: "unrecognized_private_code", message: "PRIVATE_PROVIDER_ERROR_CANARY" },
      status: "failed", terminal: true, providerResponseId: "PRIVATE_PROVIDER_ID_CANARY" };
    await expect(observeProviderOperation(identity, "refresh", async () => refreshResult)).resolves.toBe(refreshResult);
    const iterator = observeProviderStream(identity, (async function* () {
      yield { type: "error", data: { code: "provider_response_failed", message: "PRIVATE_ERROR_FRAME_CANARY" } };
      return { finalText: "PRIVATE_FINAL_TEXT_CANARY" };
    })(), { timeoutMs: 1000, signal: new AbortController().signal });
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    const terminal = records().filter((entry) => entry.outcome !== "started");
    expect(terminal).toMatchObject([
      { stage: "refresh", outcome: "failed", provider_status: "failed", code: "provider_response_failed" },
      { stage: "answer", outcome: "failed", code: "provider_response_failed" }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });
});
