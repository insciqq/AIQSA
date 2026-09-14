import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import { createFetchDeepSeekResponsesClient } from "./deepSeekResponsesTransport";
import { ProviderRequestTimeoutError, readBoundedResponseText, withTimeoutSignal } from "./network";
import { observeProviderFetch, observeProviderOperation, transportFailureFacts } from "./providerObservability";
import { createProviderSafeFetch } from "./providerSafeFetch";
import { parseSseStream } from "./sse";
import { parseOpenAIResponsesSse } from "./openaiResponsesResponse";

const { httpsRequest } = vi.hoisted(() => ({ httpsRequest: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: httpsRequest }, request: httpsRequest }));

const identity = { adapterKind: "deepseek_responses_native", providerFamily: "deepseek", connectionId: "connection-transport", providerModelId: "model-transport" };
const encoder = new TextEncoder();
function capture() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => writer.mock.calls.flatMap(([chunk]) => {
    try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
  });
}

describe("provider transport observations", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); httpsRequest.mockReset(); });

  it.each([false, true])("distinguishes a timeout before headers from a timeout reading the body: headers=%s", async (headersReceived) => {
    vi.useFakeTimers();
    const records = capture();
    const bytes = encoder.encode('{"PRIVATE_BODY_CANARY":');
    const fetchFn = vi.fn<typeof fetch>((_input, init) => headersReceived
      ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); } })))
      : new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })));
    const client = createFetchDeepSeekResponsesClient({ apiKey: "PRIVATE_KEY_CANARY", defaultTimeoutMs: 30, fetchFn: observeProviderFetch(fetchFn) });
    const result = runWithContext({ trace_id: "1".repeat(32), run_id: "run-transport", tool_call_id: "tool-transport", execution_index: 2 }, () =>
      observeProviderOperation(identity, "answer", () => client.create({ input: "PRIVATE_PROMPT_CANARY" }), { timeoutMs: 100, requestTimeoutMs: 50 }))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toBeInstanceOf(ProviderRequestTimeoutError);
    const transport = records().filter((entry) => entry.event === "transport_stage");
    expect(transport.filter((entry) => entry.stage === "headers")).toHaveLength(headersReceived ? 1 : 0);
    const failure = transport.find((entry) => entry.outcome === "failed");
    expect(failure).toMatchObject({ stage: headersReceived ? "body" : "fetch", category: "timeout", timeout_ms: 30,
      code: "provider_request_timed_out", adapterKind: identity.adapterKind, providerFamily: identity.providerFamily,
      connectionId: identity.connectionId, providerModelId: identity.providerModelId,
      trace_id: "1".repeat(32), tool_call_id: "tool-transport", execution_index: 2 });
    if (headersReceived) {
      expect(failure).toMatchObject({ httpStatus: 200, bytes: bytes.byteLength, chunks: 1, last_progress_ms: 30 });
    } else {
      expect(failure).not.toHaveProperty("httpStatus");
      expect(failure).not.toHaveProperty("bytes");
      expect(failure).not.toHaveProperty("chunks");
    }
    expect(records().filter((entry) => entry.event === "nested_abort")).toMatchObject([
      { layer: "provider", abort_source: "provider_deadline", deadline_kind: "request", timeout_ms: 30 }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("keeps a completed body and HTTP status when the real finite JSON parser fails", async () => {
    const records = capture();
    const text = "PRIVATE_MALFORMED_JSON_CANARY{";
    const client = createFetchDeepSeekResponsesClient({ apiKey: "PRIVATE_KEY_CANARY", fetchFn: observeProviderFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response(text))) });
    await expect(observeProviderOperation(identity, "answer", () => client.create({ input: "PRIVATE_PROMPT_CANARY" })))
      .rejects.toThrow("deepseek_response_invalid_json");
    expect(records()).toContainEqual(expect.objectContaining({ event: "transport_stage", stage: "body", outcome: "completed", bytes: encoder.encode(text).byteLength, chunks: 1, httpStatus: 200 }));
    expect(records()).toContainEqual(expect.objectContaining({ event: "transport_stage", stage: "parse", outcome: "failed", category: "parse", code: "provider_response_invalid_json", httpStatus: 200 }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("records TLS before the existing safe-fetch mapping and records each physical attempt", async () => {
    const records = capture();
    const failure = Object.assign(new Error("PRIVATE_CERT_PATH_CANARY"), { code: "CERT_HAS_EXPIRED", hostname: "PRIVATE_HOST_CANARY" });
    httpsRequest.mockImplementation(() => {
      const outgoing = new EventEmitter();
      return Object.assign(outgoing, { end: () => queueMicrotask(() => outgoing.emit("error", failure)) });
    });
    const fetchFn = observeProviderFetch(createProviderSafeFetch({
      configuration: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test", authenticationMode: "bearer", responseTimeoutMs: 300_000 },
      lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }]
    }));
    for (let index = 0; index < 2; index += 1) {
      await expect(observeProviderOperation(identity, "answer", () => fetchFn("https://provider.example.test/responses", { headers: { authorization: "Bearer PRIVATE_KEY_CANARY" } })))
        .rejects.toMatchObject({ code: "provider_http_invalid_request" });
    }
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    const transport = records().filter((entry) => entry.event === "transport_stage" && entry.outcome === "failed");
    expect(transport).toHaveLength(2);
    expect(transport).toEqual([expect.objectContaining({ category: "tls", code: "CERT_HAS_EXPIRED", stage: "fetch" }), expect.objectContaining({ category: "tls", code: "CERT_HAS_EXPIRED", stage: "fetch" })]);
    expect(transport.every((entry) => entry.httpStatus === undefined && entry.bytes === undefined)).toBe(true);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_request", code: "provider_http_invalid_request" }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("preserves an observed DNS error before mapping without exposing a hostname", async () => {
    const records = capture();
    const fetchFn = observeProviderFetch(createProviderSafeFetch({
      configuration: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test", authenticationMode: "bearer", responseTimeoutMs: 300_000 },
      lookupHostname: async () => { throw Object.assign(new Error("PRIVATE_DNS_CANARY"), { code: "ENOTFOUND" }); }
    }));
    await expect(observeProviderOperation(identity, "answer", () => fetchFn("https://provider.example.test/responses")))
      .rejects.toMatchObject({ code: "provider_http_dns_failed" });
    expect(records().filter((entry) => entry.event === "transport_stage" && entry.outcome === "failed"))
      .toMatchObject([{ category: "dns", code: "ENOTFOUND", stage: "fetch" }]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("retains the interrupted call's context and first parent abort when Stop runs in another context", async () => {
    vi.useFakeTimers();
    const records = capture();
    const parent = new AbortController();
    const reason = new Error("PRIVATE_STOP_CANARY");
    const result = runWithContext({ trace_id: "a".repeat(32), run_id: "run-interrupted", tool_call_id: "tool-interrupted", execution_index: 3 }, () =>
      observeProviderOperation(identity, "answer", async () => {
        const timeout = withTimeoutSignal(parent.signal, 20);
        try { return await readBoundedResponseText(new Response(new ReadableStream<Uint8Array>()), { signal: timeout.signal }); }
        finally { timeout.clear(); }
      }, { signal: parent.signal })).catch((error: unknown) => error);
    runWithContext({ trace_id: "b".repeat(32), run_id: "run-stop" }, () => parent.abort(reason));
    await vi.advanceTimersByTimeAsync(40);
    expect(await result).toBe(reason);
    expect(records().filter((entry) => entry.event === "nested_abort")).toMatchObject([
      { stage: "delivery", abort_source: "parent_signal", trace_id: "a".repeat(32), run_id: "run-interrupted", tool_call_id: "tool-interrupted", execution_index: 3 }
    ]);
    expect(records().filter((entry) => entry.event === "nested_abort")).toHaveLength(1);
    expect(JSON.stringify(records())).not.toMatch(/PRIVATE_|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  });

  it("keeps pre-aborted source and unread progress unknown", async () => {
    const records = capture();
    const parent = AbortSignal.abort(new Error("PRIVATE_PRE_ABORT_CANARY"));
    await expect(observeProviderOperation(identity, "answer", async () => {
      const timeout = withTimeoutSignal(parent, 20);
      try { for await (const event of parseSseStream(new ReadableStream<Uint8Array>(), { signal: timeout.signal })) void event; }
      finally { timeout.clear(); }
    }, { signal: parent })).rejects.toBe(parent.reason);
    expect(records().filter((entry) => entry.event === "nested_abort").every((entry) => entry.stage === "before_start" && entry.abort_source === "unknown" && entry.duration_ms === undefined)).toBe(true);
    const stream = records().find((entry) => entry.event === "transport_stage" && entry.stage === "stream" && entry.outcome === "cancelled");
    expect(stream).toBeDefined();
    expect(stream).not.toHaveProperty("bytes");
    expect(stream).not.toHaveProperty("chunks");
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it.each(["idle", "absolute"] as const)("records the actual SSE %s deadline with reader aggregates", async (deadline) => {
    vi.useFakeTimers();
    const records = capture();
    const bytes = encoder.encode(": PRIVATE_HEARTBEAT_CANARY\n\n");
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); } });
    const result = observeProviderOperation(identity, "answer", async () => {
      for await (const event of parseSseStream(stream, { idleTimeoutMs: deadline === "idle" ? 20 : 50, maxDurationMs: deadline === "absolute" ? 20 : 50 })) void event;
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: deadline === "idle" ? "provider_stream_timeout" : "provider_stream_deadline_exceeded" });
    expect(records().filter((entry) => entry.event === "nested_abort")).toMatchObject([
      { abort_source: "provider_deadline", deadline_kind: deadline === "idle" ? "stream_idle" : "stream_absolute", timeout_ms: 20 }
    ]);
    expect(records().filter((entry) => entry.event === "transport_stage" && entry.stage === "stream")).toMatchObject([
      { outcome: "started" }, { outcome: "failed", category: "timeout", timeout_ms: 20, bytes: bytes.byteLength, chunks: 1, last_progress_ms: 20 }
    ]);
    expect(records()).toContainEqual(expect.objectContaining({ event: "provider_deadline", stage: "answer",
      stream_idle_timeout_ms: deadline === "idle" ? 20 : 50, stream_absolute_timeout_ms: deadline === "absolute" ? 20 : 50,
      connectionId: identity.connectionId }));
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("records a real malformed SSE JSON frame once without logging successful frames", async () => {
    const records = capture();
    const response = new Response('data: {"type":"response.created"}\n\ndata: PRIVATE_INVALID_FRAME_CANARY\n\n');
    await expect(observeProviderOperation(identity, "answer", async () => {
      const fetched = await observeProviderFetch(vi.fn<typeof fetch>().mockResolvedValue(response))("https://provider.example.test/responses");
      for await (const event of parseOpenAIResponsesSse({ background: false, responseBody: fetched.body!, stream: true })) void event;
    })).rejects.toThrow("openai_stream_truncated");
    expect(records().filter((entry) => entry.event === "transport_stage" && entry.stage === "parse"))
      .toMatchObject([{ outcome: "failed", httpStatus: 200, category: "parse", code: "provider_response_invalid_json" }]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("keeps arbitrary transport errors unknown and never evaluates error getters", () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER_CANARY"); });
    const error = Object.defineProperties(new Error("ENOTFOUND PRIVATE_MESSAGE_CANARY"), {
      code: { get: getter }, cause: { get: getter }, report: { get: getter }
    });
    expect(transportFailureFacts(error)).toEqual({ category: "unknown", code: "unknown" });
    expect(transportFailureFacts(new TypeError("PRIVATE_UNKNOWN_CANARY"))).toEqual({ category: "unknown", code: "unknown" });
    const deadline = AbortSignal.abort(new ProviderRequestTimeoutError(20));
    expect(transportFailureFacts(Object.assign(new Error("PRIVATE_SOCKET_CANARY"), { code: "ECONNRESET" }), deadline))
      .toEqual({ category: "connect", code: "ECONNRESET" });
    expect(transportFailureFacts(new Error("PRIVATE_UNKNOWN_CANARY"), deadline)).toEqual({ category: "unknown", code: "unknown" });
    expect(getter).not.toHaveBeenCalled();
  });
});
