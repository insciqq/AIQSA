// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import {
  observedFailure,
  observeProviderFetch,
  observeProviderOperation,
  observeProviderStream,
  providerContextRejection,
  providerHttpFailureMessage
} from "./providerObservability";
import { createFetchGeminiInteractionsClient, GeminiHttpError } from "./geminiInteractionsTransport";
import { createFetchOpenAIResponsesClient } from "./openaiResponsesTransport";
import { executeWithProviderRetry } from "./providerRetry";
import { ProviderRequestTimeoutError, withTimeoutSignal } from "./network";
import { ProviderSearchExecutionError } from "./types";

const identity = { adapterKind: "openai_responses_compatible", providerFamily: "openai_compatible", connectionId: "connection-safe", providerModelId: "model-safe" };

function capture() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => writer.mock.calls.flatMap(([chunk]) => {
    try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
  });
}

describe("provider diagnostics", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it("does not invoke untrusted error getters or infer codes from exception text", () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER_CANARY"); });
    const error = Object.defineProperties(new Error("provider_request_timed_out PRIVATE_MESSAGE_CANARY"), {
      code: { get: getter }, status: { get: getter }, httpStatus: { get: getter }, statusCode: { get: getter }
    });
    expect(observedFailure(error)).toEqual({ code: "unknown", reason: "unknown" });
    expect(getter).not.toHaveBeenCalled();
    expect(observedFailure(new TypeError("PRIVATE_TYPE_ERROR_CANARY"))).toEqual({ code: "unknown", reason: "unknown" });
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
