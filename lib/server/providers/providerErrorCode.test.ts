// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeEvent } from "../observability/runtime.cjs";
import { createFetchAnthropicMessagesClient } from "./anthropicMessages";
import { createFetchDeepSeekResponsesClient } from "./deepSeekResponsesTransport";
import { createFetchGeminiInteractionsClient } from "./geminiInteractionsTransport";
import { createFetchOpenAIChatCompletionClient } from "./openaiCompatibleChatTransport";
import { parseOpenAIResponsesSse } from "./openaiResponsesResponse";
import { createFetchOpenAIResponsesClient } from "./openaiResponsesTransport";
import {
  inheritProviderErrorCode, markProviderErrorCode, providerErrorCode, providerErrorCodeOf, providerErrorCodeOfBody
} from "./providerErrorCode";
import { observedFailure, observeProviderOperation, observeProviderRoundRetry } from "./providerObservability";
import { providerResponseFailure } from "./responseFailure";

const identity = { adapterKind: "openai_responses_compatible", providerFamily: "openai_compatible", connectionId: "connection-safe",
  providerModelId: "model-safe" };
const CANARY = "PRIVATE_PROVIDER_MESSAGE_CANARY";

function capture() {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => writer.mock.calls.flatMap(([chunk]) => {
    try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
  });
}

function sseBody(events: readonly Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

describe("provider error identity", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps a reviewed code, else type or Google status, and names any other identity `other`", () => {
    expect(providerErrorCodeOf({ code: "server_is_overloaded", type: "server_error", message: CANARY })).toBe("server_is_overloaded");
    expect(providerErrorCodeOf({ code: "brand_new_code", type: "server_error" })).toBe("server_error");
    expect(providerErrorCodeOf({ code: 429, status: "RESOURCE_EXHAUSTED", message: CANARY })).toBe("resource_exhausted");
    expect(providerErrorCodeOf({ type: "overloaded_error", message: CANARY })).toBe("overloaded_error");
    expect(providerErrorCodeOf({ code: "brand_new_code", message: CANARY })).toBe("other");
    expect(providerErrorCodeOf({ code: `${CANARY} with spaces` })).toBe("other");
    expect(providerErrorCodeOf({ code: "x".repeat(100) })).toBe("other");
    // A numeric status and a streamed event's own type name no failure.
    expect(providerErrorCodeOf({ code: "502", type: "error", message: CANARY })).toBeNull();
    expect(providerErrorCodeOf({ message: CANARY })).toBeNull();
    expect(providerErrorCodeOf(null)).toBeNull();
    expect(providerErrorCodeOfBody(JSON.stringify({ error: { code: "rate_limit_exceeded", message: CANARY } }))).toBe("rate_limit_exceeded");
    expect(providerErrorCodeOfBody(JSON.stringify({ type: "error", code: "stream_incomplete" }))).toBe("stream_incomplete");
    expect(providerErrorCodeOfBody(JSON.stringify([{ error: { code: 503, status: "UNAVAILABLE" } }]))).toBe("unavailable");
    expect(providerErrorCodeOfBody(`<html>${CANARY}</html>`)).toBeNull();
  });

  it("marks a failure without exposing the identity to spreads, JSON or Object.assign", () => {
    const error = markProviderErrorCode(new Error("provider_response_failed"), "server_error");
    expect(providerErrorCode(error)).toBe("server_error");
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify({ ...error })).toBe("{}");
    expect(providerErrorCode(Object.assign(new Error("copy"), error))).toBeNull();
    // The first identity wins; an unreviewed value never becomes one.
    expect(providerErrorCode(markProviderErrorCode(error, "rate_limit_exceeded"))).toBe("server_error");
    expect(providerErrorCode(markProviderErrorCode(new Error("x"), CANARY))).toBeNull();
    expect(providerErrorCode(inheritProviderErrorCode(new Error("wrapper"), error))).toBe("server_error");
    expect(markProviderErrorCode(Object.freeze(new Error("frozen")), "server_error")).toBeInstanceOf(Error);
    expect(observedFailure(error).provider_error_code).toBe("server_error");
    expect(providerErrorCode(providerResponseFailure("provider_response_failed", {
      error: { code: "context_length_exceeded", message: CANARY } }))).toBe("context_length_exceeded");
  });

  it("names the identity of an HTTP failure in every native transport's operation record, never the message", async () => {
    const body = (detail: Record<string, unknown>) => async () => Response.json({ error: { ...detail, message: CANARY } }, { status: 502 });
    const sends = [
      ["server_is_overloaded", () => createFetchOpenAIResponsesClient({ apiKey: "synthetic",
        fetchFn: body({ type: "server_error", code: "server_is_overloaded" }) }).create({})],
      ["rate_limit_exceeded", () => createFetchOpenAIChatCompletionClient({ bodyMissingError: "missing",
        endpoint: "https://compatible.test/v1/chat/completions", fetchFn: body({ code: "rate_limit_exceeded" }),
        headers: { authorization: "Bearer synthetic" }, invalidJsonError: "invalid", notObjectError: "not_object",
        providerName: "Compatible" }).createChatCompletion({})],
      ["overloaded_error", () => createFetchAnthropicMessagesClient({ apiKey: "synthetic",
        fetchFn: body({ type: "overloaded_error" }) }).createMessage({})],
      ["other", () => createFetchDeepSeekResponsesClient({ apiKey: "synthetic", fetchFn: body({ type: "brand_new_type" }) }).create({})],
      ["unavailable", () => createFetchGeminiInteractionsClient({ apiKey: "synthetic",
        fetchFn: body({ code: 502, status: "UNAVAILABLE" }) }).createInteraction({})]
    ] as const;
    for (const [code, send] of sends) {
      const records = capture();
      await observeProviderOperation(identity, "answer", send).catch(() => undefined);
      expect(records()).toContainEqual(expect.objectContaining({ event: "provider_operation", outcome: "failed", httpStatus: 502,
        provider_error_code: code }));
      expect(JSON.stringify(records())).not.toContain(CANARY);
      vi.restoreAllMocks();
    }
  });

  it("carries a streamed failure's identity through the dropped-round decision and its record", async () => {
    const error = await (async () => {
      for await (const event of parseOpenAIResponsesSse({ background: false, stream: true, responseBody: sseBody([
        { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code: "server_error", message: CANARY } } }
      ]) })) void event;
    })().catch((failure: unknown) => failure);
    expect(providerErrorCode(error)).toBe("server_error");
    const records = capture();
    observeProviderRoundRetry(identity, { action: "retry", attempt: 1, delayMs: 2_000, error });
    expect(records()).toEqual([expect.objectContaining({ event: "provider_retry", action: "retry", provider_error_code: "server_error" })]);
    expect(JSON.stringify(records())).not.toContain(CANARY);
  });

  it("validates the field at the logging leaf: an unreviewed value is `other`", () => {
    const line = (value: string) => JSON.parse(serializeEvent("run_execution", {
      run_id: "run-1", stage: "execution", outcome: "failed", code: "provider_server_error", provider_error_code: value
    })!) as Record<string, unknown>;
    expect(line("server_is_overloaded").provider_error_code).toBe("server_is_overloaded");
    expect(line(CANARY).provider_error_code).toBe("other");
  });
});
