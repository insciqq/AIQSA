import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { gatewayRoutingLane } from "../providers/gatewayRouting";
import { ProviderRequestTimeoutError } from "../providers/network";
import { providerFailureMessage } from "../providers/providerFailureMessage";
import { providerResponseFailure } from "../providers/responseFailure";
import { createProviderRuntimeBinding } from "../providers/runtimeFactory";
import { markProviderStreamDrop } from "../providers/streamDrop";
import { markProviderStreamProgress, providerStreamProgressFacts } from "../providers/streamProgress";
import { ProviderStreamIdleTimeoutError } from "../providers/streamSafety";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { engineTestFaults } from "./faults";
import { callModel, MODEL_CALL_RESEARCH_RETRY, MODEL_CALL_RETRY, MODEL_CALL_UNATTENDED_RETRY, modelCallRetryDecision, type ModelCallPorts } from "./modelCall";

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
    expect(providerFailureMessage(rejected)).toContain("sending it again will not help");
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
      await callModel(ports(heads(["head"]), { onEvent: vi.fn(async () => { seen.push("event"); }),
        onProviderWait: (wait) => seen.push(wait), slowAfterMs: 1_000 }), request);
      expect(seen).toEqual(["event"]);
    });

    it("says retrying after the discard, and again after each later failure", async () => {
      const seen: unknown[] = [];
      const call = ports(heads(["drop", "answer", "drop", "answer"]), { onDiscard: vi.fn(async () => { seen.push("discard"); }),
        onProviderWait: (wait) => seen.push(wait), slowAfterMs: 1_000 });
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

  describe("a research run's retry window", () => {
    // A fake clock: each attempt runs `attemptMs` before it fails, and each wait moves the clock by its delay.
    const clocked = (script: Script, attemptMs = 5_000) => {
      let clock = 1_000_000;
      const starts: number[] = [];
      const provider = adapter(script);
      const stream = provider.stream.bind(provider);
      provider.stream = (value, options) => {
        starts.push(clock);
        clock += attemptMs;
        return stream(value, options);
      };
      const now = () => clock;
      const sleep = vi.fn(async (delayMs: number) => { clock += delayMs; });
      return { now, provider, sleep, starts, start: clock };
    };
    const drop = () => markProviderStreamDrop(new Error("stream_incomplete"), "reset");

    it("keeps sending a dropped stream again past a chat's attempts and returns the answer", async () => {
      const failures = Array.from({ length: 9 }, () => ({ fail: drop() }));
      const clock = clocked([...failures, { events: [token("Report")], text: "Report" }]);
      const waits: unknown[] = [];
      const result = await callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now,
        onProviderWait: (wait) => waits.push(wait), retry: MODEL_CALL_RESEARCH_RETRY, slowAfterMs: 1_000, sleep: clock.sleep }), request);
      expect(result.finalText).toBe("Report");
      expect(clock.provider.calls).toBe(10);
      expect(waits).toEqual(["retrying", null]);
    });

    it("starts no attempt once ten minutes passed since the first one started", async () => {
      const clock = clocked([{ fail: drop() }]);
      const waits: unknown[] = [];
      await expect(callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now,
        onProviderWait: (wait) => waits.push(wait), retry: MODEL_CALL_RESEARCH_RETRY, slowAfterMs: 1_000, sleep: clock.sleep }), request))
        .rejects.toThrow("stream_incomplete");
      expect(clock.provider.calls).toBeGreaterThan(MODEL_CALL_RETRY.maxAttempts);
      // The window decided, not the safety bound on attempts.
      expect(clock.provider.calls).toBeLessThan(MODEL_CALL_RESEARCH_RETRY.maxAttempts);
      expect(clock.starts.at(-1)! - clock.starts[0]!).toBeLessThanOrEqual(600_000);
      // The next wait would have started an attempt past the window: at most one capped backoff remained.
      expect(clock.starts.at(-1)! - clock.starts[0]!).toBeGreaterThan(600_000 - 5_000 - MODEL_CALL_RETRY.backoff.maxBackoffMs);
      expect(waits).toEqual(["retrying"]);
    });

    it("still waits past no turn's deadline, sends no deterministic rejection again and stops at Stop", async () => {
      const late = clocked([{ fail: drop() }]);
      await expect(callModel(ports(late.provider, { deadlineAt: late.start + 60_000, now: late.now, retry: MODEL_CALL_RESEARCH_RETRY,
        sleep: late.sleep }), request)).rejects.toThrow("stream_incomplete");
      expect(late.provider.calls).toBeLessThan(MODEL_CALL_RETRY.maxAttempts);
      expect(late.now()).toBeLessThan(late.start + 60_000);
      const rejected = clocked([{ fail: http(400) }]);
      await expect(callModel(ports(rejected.provider, { now: rejected.now, retry: MODEL_CALL_RESEARCH_RETRY, sleep: rejected.sleep }), request))
        .rejects.toThrow("HTTP 400");
      expect(rejected.provider.calls).toBe(1);
      const stop = new AbortController();
      stop.abort();
      const stopped = clocked([{ fail: http(502) }]);
      await expect(callModel(ports(stopped.provider, { now: stopped.now, retry: MODEL_CALL_RESEARCH_RETRY, signal: stop.signal,
        sleep: stopped.sleep }), request)).rejects.toThrow();
      expect(stopped.provider.calls).toBe(1);
    });

    it("leaves a chat's request at its six attempts with time to spare", async () => {
      const clock = clocked([{ fail: drop() }]);
      await expect(callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now, sleep: clock.sleep }), request))
        .rejects.toThrow("stream_incomplete");
      expect(clock.provider.calls).toBe(6);
    });

    // An upstream that fails each attempt after about two minutes (codex-lb's `missing_response_created_timeout`).
    const slowFailure = () => markProviderStreamDrop(new Error("server_error"), "response_failed");

    it("starts no chat attempt three minutes after the request first failed", async () => {
      const clock = clocked([{ fail: slowFailure() }], 121_000);
      const waits: unknown[] = [];
      await expect(callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now,
        onProviderWait: (wait) => waits.push(wait), slowAfterMs: 1_000, sleep: clock.sleep }), request)).rejects.toThrow("server_error");
      // The first failure at 121 s; the second and third attempts start within three minutes of it, a fourth would not:
      // about six minutes of waiting instead of the six attempts' twelve.
      expect(clock.provider.calls).toBe(3);
      const firstFailedAt = clock.starts[0]! + 121_000;
      expect(clock.starts.at(-1)! - firstFailedAt).toBeLessThanOrEqual(MODEL_CALL_RETRY.failureWindowMs!);
      expect(clock.now() - firstFailedAt).toBeGreaterThan(MODEL_CALL_RETRY.failureWindowMs!);
      expect(waits).toEqual(["retrying"]);
    });

    it("counts the window from the first failure, so a long answer that drops at its end is still retried", async () => {
      const clock = clocked([{ fail: slowFailure() }, { events: [token("Done")], text: "Done" }], 600_000);
      const result = await callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now, sleep: clock.sleep }), request);
      expect(result.finalText).toBe("Done");
      expect(clock.provider.calls).toBe(2);
    });

    it("still recovers a chat's request from a burst of short drops", async () => {
      const failures = Array.from({ length: 5 }, () => ({ fail: drop() }));
      const clock = clocked([...failures, { events: [token("Hello")], text: "Hello" }], 2_000);
      const result = await callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now, sleep: clock.sleep }), request);
      expect(result.finalText).toBe("Hello");
      expect(clock.provider.calls).toBe(6);
    });

    it("keeps a scheduled or webhook occurrence's six attempts without the window", async () => {
      const clock = clocked([{ fail: slowFailure() }], 121_000);
      await expect(callModel(ports(clock.provider, { deadlineAt: clock.start + 3_600_000, now: clock.now, retry: MODEL_CALL_UNATTENDED_RETRY,
        sleep: clock.sleep }), request)).rejects.toThrow("server_error");
      expect(clock.provider.calls).toBe(6);
      expect(MODEL_CALL_UNATTENDED_RETRY.failureWindowMs).toBeUndefined();
    });

    it("leaves Deep research's ten minutes from the first attempt as they were", () => {
      expect(MODEL_CALL_RESEARCH_RETRY).toEqual({ backoff: MODEL_CALL_RETRY.backoff, maxAttempts: 50, windowMs: 600_000 });
    });

    // A Codex LB stream that went silent (found a minute after its last byte) and a response that never started within
    // the 300 s response timeout (decision 2026-11-11): each run keeps its own policy for them.
    const stalled = () => new ProviderStreamIdleTimeoutError({ idleTimeoutMs: 60_000, observedIdleMs: 60_000 });
    const neverStarted = () => markProviderStreamProgress(new ProviderRequestTimeoutError(300_000), providerStreamProgressFacts({ responseStarted: false }));
    it.each([
      ["a silent stream", stalled, 90_000],
      ["a response that never started", neverStarted, 300_000]
    ] as const)("sends %s again under each run's own policy", async (_label, failure, attemptMs) => {
      const chat = clocked([{ fail: failure() }], attemptMs);
      await expect(callModel(ports(chat.provider, { deadlineAt: chat.start + 3_600_000, now: chat.now, sleep: chat.sleep }), request))
        .rejects.toMatchObject({ code: failure().code });
      const firstFailedAt = chat.starts[0]! + attemptMs;
      expect(chat.provider.calls).toBeGreaterThan(1);
      expect(chat.starts.at(-1)! - firstFailedAt).toBeLessThanOrEqual(MODEL_CALL_RETRY.failureWindowMs!);
      expect(chat.now() - firstFailedAt).toBeGreaterThan(MODEL_CALL_RETRY.failureWindowMs!);

      const scheduled = clocked([{ fail: failure() }], attemptMs);
      await expect(callModel(ports(scheduled.provider, { deadlineAt: scheduled.start + 3_600_000, now: scheduled.now,
        retry: MODEL_CALL_UNATTENDED_RETRY, sleep: scheduled.sleep }), request)).rejects.toMatchObject({ code: failure().code });
      expect(scheduled.provider.calls).toBe(6);

      const research = clocked([{ fail: failure() }], attemptMs);
      await expect(callModel(ports(research.provider, { deadlineAt: research.start + 3_600_000, now: research.now,
        retry: MODEL_CALL_RESEARCH_RETRY, sleep: research.sleep }), request)).rejects.toMatchObject({ code: failure().code });
      expect(research.provider.calls).toBeGreaterThan(1);
      expect(research.starts.at(-1)! - research.starts[0]!).toBeLessThanOrEqual(MODEL_CALL_RESEARCH_RETRY.windowMs!);
      expect(research.now() - research.starts[0]!).toBeGreaterThan(MODEL_CALL_RESEARCH_RETRY.windowMs! - MODEL_CALL_RETRY.backoff.maxBackoffMs);

      const recovered = clocked([{ fail: failure() }, { events: [token("Hello")], text: "Hello" }], attemptMs);
      await expect(callModel(ports(recovered.provider, { deadlineAt: recovered.start + 3_600_000, now: recovered.now, sleep: recovered.sleep }),
        request)).resolves.toMatchObject({ finalText: "Hello" });
    });
  });

  it("sends a request deadline again only when its response had not started", () => {
    const live = new AbortController().signal;
    expect(modelCallRetryDecision(new ProviderRequestTimeoutError(300_000), live)).toBeNull();
    expect(modelCallRetryDecision(markProviderStreamProgress(new ProviderRequestTimeoutError(1_800_000),
      providerStreamProgressFacts({ lastByteMs: 4_000, lastEventMs: 4_000, responseStarted: true })), live)).toBeNull();
    expect(modelCallRetryDecision(markProviderStreamProgress(new ProviderRequestTimeoutError(300_000),
      providerStreamProgressFacts({ lastByteMs: 6_000, responseStarted: false })), live)).toEqual({ retryAfterMs: null });
    expect(modelCallRetryDecision(new ProviderStreamIdleTimeoutError({ idleTimeoutMs: 60_000, observedIdleMs: 60_000 }), live))
      .toEqual({ retryAfterMs: null });
    expect(modelCallRetryDecision(markProviderStreamProgress(new ProviderRequestTimeoutError(300_000),
      providerStreamProgressFacts({ responseStarted: false })), AbortSignal.abort())).toBeNull();
  });

  describe("through a Codex LB binding's transport", () => {
    const encoder = new TextEncoder();
    const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n';
    const delta = (text: string) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", response_id: "r1", delta: text })}\n\n`;
    const completed = (text: string) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
      id: "r1", model: "upstream/model", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`;
    // The text "close" ends the body.
    type Step = readonly (readonly [atMs: number, text: string])[];
    // Each request's headers arrive after `headersAfterMs` and its body writes its steps at their times after them; a
    // cancelled body takes nothing more.
    const upstream = (bodies: readonly Step[], headersAfterMs = 0) => {
      let calls = 0;
      const cancelled: number[] = [];
      const fetchFn = vi.fn<typeof fetch>(async () => {
        const call = calls;
        const steps = bodies[Math.min(call, bodies.length - 1)]!;
        calls += 1;
        if (headersAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, headersAfterMs));
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const [atMs, text] of steps) setTimeout(() => {
              try { if (text === "close") controller.close(); else controller.enqueue(encoder.encode(text)); } catch { /* cancelled */ }
            }, atMs);
          },
          cancel() { cancelled.push(call); }
        }), { headers: { "content-type": "text/event-stream" } });
      });
      return { cancelled, fetchFn };
    };
    const codexLb = (fetchFn: typeof fetch) => {
      const runtime = createProviderRuntimeBinding({ options: { allowFake: false, fetchFn }, secret: "secret", snapshot: {
        connection: { allowPrivateNetwork: false, apiRoot: "https://lb.example.test/v1", authenticationMode: "bearer",
          responseTimeoutMs: 300_000, responsesRequestIsolationDetected: true },
        connectionDisplayName: "Codex LB", connectionId: "connection-1", credentialId: "credential-1", credentialVersionId: "credential-version-1",
        model: { adapterKind: "openai_responses_compatible", answerSelectable: true, capabilities: { nativePdfInput: false, nativeSearch: false,
          pdf: false, reasoning: false, streaming: true, vision: false }, defaultParams: {}, modelClass: "answer", upstreamModelId: "upstream/model" },
        modelDisplayName: "Model", providerFamily: "openai_compatible", providerModelId: "deployment-1", version: 1 } });
      return runtime.adapter;
    };
    const streamed = { ...request, attachmentIds: [], attachments: [], chatId: "chat-1", content: { blocks: [{ text: "hello", type: "text" }] },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: false },
      modelId: "upstream/model", params: { stream: true }, prompt: { developer: null, system: null }, provider: "openai_compatible",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto" } as ProviderRunRequest;
    const answer: Step = [[0, created], [1_000, delta("Hello")], [2_000, completed("Hello")], [2_000, "close"]];

    it.each([
      // Every byte stopped a minute after the stream's last one, keepalive included: found at 80 s.
      ["a stream that went silent", [[0, created], [10_000, ": keepalive\n\n"], [20_000, delta("Hel")]] as Step, 80_000],
      // Keepalive comments every 10 s and no event: the response did not start within its 300 s.
      ["a response that never started", Array.from({ length: 29 }, (_, index) => [(index + 1) * 10_000, ": keepalive\n\n"] as const), 300_000]
    ] as const)("sends %s again and answers without user action", async (_label, hang, failsAtMs) => {
      vi.useFakeTimers();
      try {
        const provider = upstream([hang, answer]);
        const call = ports(codexLb(provider.fetchFn), { deadlineAt: Date.now() + 3_600_000 });
        let outcome: unknown = "pending";
        const settled = callModel(call, streamed).then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
        await vi.advanceTimersByTimeAsync(failsAtMs - 1);
        expect(provider.fetchFn).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await settled;
        expect(outcome).toMatchObject({ finalText: "Hello" });
        expect(provider.fetchFn).toHaveBeenCalledTimes(2);
        // The failed attempt's body is released (the answer's too, once its terminal event arrived).
        expect(provider.cancelled[0]).toBe(0);
        expect(call.discarded).toEqual([1]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never sends again a live stream that reached its ceiling", async () => {
      vi.useFakeTimers();
      try {
        // Headers after 1 s, then a delta every 50 s: the ceiling counts from the request, so it ends the stream first.
        const live: Step = [[0, created], ...Array.from({ length: 36 }, (_, index) => [(index + 1) * 50_000, delta("x")] as const)];
        const provider = upstream([live, answer], 1_000);
        let outcome: unknown = "pending";
        const settled = callModel(ports(codexLb(provider.fetchFn), { deadlineAt: Date.now() + 3_600_000 }), streamed)
          .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
        await vi.advanceTimersByTimeAsync(1_800_000);
        await settled;
        expect(outcome).toMatchObject({ code: "provider_request_timed_out", timeoutMs: 1_800_000 });
        expect(provider.fetchFn).toHaveBeenCalledOnce();
        await vi.runAllTimersAsync();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
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
