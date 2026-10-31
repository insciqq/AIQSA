import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { gatewayRoutingLane } from "../providers/gatewayRouting";
import { providerHttpFailureMessage } from "../providers/providerObservability";
import { providerResponseFailure } from "../providers/responseFailure";
import { markProviderStreamDrop } from "../providers/streamDrop";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { engineTestFaults } from "./faults";
import { callModel, modelCallRetryDecision, type ModelCallPorts } from "./modelCall";

type Script = readonly (Readonly<{ events?: readonly ModelRunSseEvent[]; fail?: unknown; text?: string }>)[];

function adapter(script: Script): ProviderAdapter & { calls: number } {
  const value = {
    buildRequestPreview: () => ({}),
    calls: 0,
    async *stream(): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const step = script[Math.min(value.calls, script.length - 1)]!;
      value.calls += 1;
      for (const event of step.events ?? []) yield event;
      if (step.fail) throw step.fail;
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", usage: { inputTokens: 10, outputTokens: 2 } };
    }
  };
  return value;
}

const request = { modelId: "m" } as ProviderRunRequest;
const token = (delta: string): ModelRunSseEvent => ({ data: { delta }, type: "token" });
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function ports(provider: ProviderAdapter, overrides: Partial<ModelCallPorts> = {}): ModelCallPorts & {
  discarded: number[]; events: ModelRunSseEvent[]; usages: unknown[];
} {
  const record = { discarded: [] as number[], events: [] as ModelRunSseEvent[], usages: [] as unknown[] };
  return {
    adapter: provider, deadlineAt: Date.now() + 600_000,
    onDiscard: vi.fn(async (attempt: number) => { record.discarded.push(attempt); }),
    onEvent: vi.fn(async (event: ModelRunSseEvent) => { record.events.push(event); }),
    onUsage: vi.fn((usage: unknown) => { record.usages.push(usage); }),
    random: () => 0.5, signal: new AbortController().signal, sleep: vi.fn(async () => undefined), ...record, ...overrides
  };
}

describe("native model call", () => {
  it("does not send a request again that the provider rejected for a value in it", async () => {
    const rejected = markProviderStreamDrop(providerResponseFailure("provider_response_failed",
      { error: { code: "invalid_value", message: "too many patches", param: "input" }, status: "failed" }), "response_failed");
    const provider = adapter([{ fail: rejected }]);
    const call = ports(provider);
    await expect(callModel(call, request)).rejects.toMatchObject({ code: "provider_request_rejected" });
    expect(provider.calls).toBe(1);
    expect(call.discarded).toEqual([]);
    expect(providerHttpFailureMessage(rejected)).toContain("was not sent again");
  });

  describe("what the request waits on its provider for", () => {
    const heads = (script: readonly ("head" | "drop" | "answer" | "never")[]): ProviderAdapter => {
      let call = 0;
      return { buildRequestPreview: () => ({}),
        async *stream(_request, options): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
          const step = script[call]!;
          call += 1;
          if (step === "never") await new Promise((resolve) => setTimeout(resolve, 40));
          if (step !== "drop") options?.onResponseHead?.();
          if (step === "drop") throw markProviderStreamDrop(new Error("socket"), "reset");
          if (step === "head") await new Promise((resolve) => setTimeout(resolve, 40));
          yield token("Hi");
          return { finalProviderResponsePreview: {}, finalText: "Hi", usage: {} };
        } } as ProviderAdapter;
    };

    it("says nothing about a provider that answers in time", async () => {
      const waits: unknown[] = [];
      await callModel(ports(heads(["answer"]), { onProviderWait: (wait) => waits.push(wait), slowAfterMs: 1_000 }), request);
      expect(waits).toEqual([]);
    });

    it("calls a silent first attempt slow until its response starts", async () => {
      const waits: unknown[] = [];
      await callModel(ports(heads(["never"]), { onProviderWait: (wait) => waits.push(wait), slowAfterMs: 5 }), request);
      expect(waits).toEqual(["slow", null]);
    });

    it("ends the wait at the response head, before any event", async () => {
      const seen: unknown[] = [];
      const call = ports(heads(["head"]), { onProviderWait: (wait) => seen.push(wait), slowAfterMs: 1_000 });
      call.onEvent = vi.fn(async () => { seen.push("event"); });
      await callModel(call, request);
      expect(seen).toEqual(["event"]);
    });

    it("says retrying after the discard, and again after each later failure", async () => {
      const seen: unknown[] = [];
      const call = ports(heads(["drop", "answer", "drop", "answer"]), { onProviderWait: (wait) => seen.push(wait), slowAfterMs: 1_000 });
      call.onDiscard = vi.fn(async () => { seen.push("discard"); });
      await callModel(call, request);
      expect(seen).toEqual(["discard", "retrying", null]);
      await callModel(call, request);
      expect(seen).toEqual(["discard", "retrying", null, "discard", "retrying", null]);
    });

    it("leaves a run that ran out of attempts to its failure", async () => {
      const waits: unknown[] = [];
      const provider = adapter([{ fail: markProviderStreamDrop(new Error("socket"), "reset") }]);
      await expect(callModel(ports(provider, { onProviderWait: (wait) => waits.push(wait), slowAfterMs: 1_000 }), request))
        .rejects.toThrow("socket");
      expect(provider.calls).toBe(6);
      expect(waits).toEqual(["retrying"]);
    });

    it("never calls a slow attempt slow after the run gave up on it", async () => {
      const waits: unknown[] = [];
      const provider = adapter([{ fail: http(400) }]);
      await expect(callModel(ports(provider, { onProviderWait: (wait) => waits.push(wait), slowAfterMs: 5 }), request)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(waits).toEqual([]);
    });
  });

  it("sends a request that met a 502 again and returns the answer without user action", async () => {
    const provider = adapter([{ fail: http(502) }, { events: [token("Hello")], text: "Hello" }]);
    const call = ports(provider);
    const result = await callModel(call, request);
    expect(result.finalText).toBe("Hello");
    expect(provider.calls).toBe(2);
    expect(call.discarded).toEqual([1]);
  });

  it("discards the partial output of a stream that dropped and accounts both requests' usage", async () => {
    const drop = markProviderStreamDrop(new Error("socket"), "reset");
    const provider = adapter([
      { events: [token("Hel"), { data: { inputTokens: 10, outputTokens: 1 }, type: "usage" }], fail: drop },
      { events: [token("Hello")], text: "Hello" }
    ]);
    const call = ports(provider);
    await callModel(call, request);
    expect(call.events.filter((event) => event.type === "token").map((event) => event.type === "token" && event.data.delta))
      .toEqual(["Hel", "Hello"]);
    expect(call.discarded).toEqual([1]);
    expect(call.usages).toHaveLength(2);
    expect(call.usages[0]).toMatchObject({ completeness: "partial" });
  });

  it("never sends a deterministic rejection again", async () => {
    const provider = adapter([{ fail: http(400) }]);
    await expect(callModel(ports(provider), request)).rejects.toThrow("HTTP 400");
    expect(provider.calls).toBe(1);
    expect(modelCallRetryDecision(Object.assign(new Error("long"), { code: "provider_context_length_exceeded" }),
      new AbortController().signal)).toBeNull();
    expect(modelCallRetryDecision(http(429), new AbortController().signal)).toEqual({ retryAfterMs: null });
    // Anthropic answers an overload with 529.
    expect(modelCallRetryDecision(http(529), new AbortController().signal)).toEqual({ retryAfterMs: null });
    expect(modelCallRetryDecision(Object.assign(http(503), { retryAfterMs: 7_000 }), new AbortController().signal))
      .toEqual({ retryAfterMs: 7_000 });
  });

  it("stops retrying at the attempt bound and before the turn's deadline", async () => {
    const bounded = adapter([{ fail: http(503) }]);
    await expect(callModel(ports(bounded), request)).rejects.toThrow("HTTP 503");
    expect(bounded.calls).toBe(6);
    const late = adapter([{ fail: http(503) }]);
    await expect(callModel(ports(late, { deadlineAt: Date.now() + 1_000 }), request)).rejects.toThrow("HTTP 503");
    expect(late.calls).toBe(1);
  });

  it("stops at Stop", async () => {
    const stop = new AbortController();
    stop.abort();
    const provider = adapter([{ fail: http(502) }]);
    await expect(callModel(ports(provider, { signal: stop.signal }), request)).rejects.toThrow();
    expect(provider.calls).toBe(1);
  });

  it("injects a stand's faults once per run, only in test mode", async () => {
    const faults = engineTestFaults({ AIQSA_NATIVE_ENGINE_TEST_FAULTS: "model_502_once,stream_drop_once", AIQSA_TEST_MODE: "1",
      NODE_ENV: "test" });
    const provider = adapter([{ events: [token("Hi")], text: "Hi" }]);
    const call = ports(provider, { faults });
    await expect(callModel(call, request)).resolves.toMatchObject({ finalText: "Hi" });
    // The 502 never reached the provider; the drop broke its first real stream.
    expect(provider.calls).toBe(2);
    expect(call.discarded).toEqual([1, 2]);
    expect(engineTestFaults({ AIQSA_NATIVE_ENGINE_TEST_FAULTS: "model_502_once", AIQSA_TEST_MODE: "1", NODE_ENV: "production" })
      .take("model_502_once")).toBe(false);
  });

  it("sends each attempt with its lane's routing key, and never the one a failed attempt may still hold", async () => {
    const keys: (string | undefined)[] = [];
    const provider = adapter([{ fail: markProviderStreamDrop(new Error("socket"), "reset") }, { text: "Hello" }]);
    const stream = provider.stream.bind(provider);
    provider.stream = (value, options) => {
      keys.push(options?.routingKey);
      return stream(value, options);
    };
    const routing = gatewayRoutingLane({ chatId: "chat-model-call", name: "loop" },
      { env: { AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: Buffer.alloc(32, 9).toString("base64") } });
    const first = routing.key();
    await callModel(ports(provider, { routing }), request);
    // The chat's next round goes on with the key its retry took.
    await callModel(ports(provider, { routing }), request);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(first);
    expect(keys[1]).toEqual(expect.any(String));
    expect(keys[1]).not.toBe(first);
    expect(keys[2]).toBe(keys[1]);
    // Without a lane the adapter gets no key, and an isolated transport gives every POST a fresh one.
    keys.length = 0;
    await callModel(ports(provider), request);
    expect(keys).toEqual([undefined]);
  });
});
