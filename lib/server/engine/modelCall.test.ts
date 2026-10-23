import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
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
});
