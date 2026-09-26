import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunFollowup } from "../../contracts/runFollowups";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { buildDeepSeekResponsesRequest } from "../providers/deepSeekResponsesRequest";
import { buildOpenRouterChatRequest } from "../providers/openRouterChatRequest";
import { buildOpenAICompatibleChatRequest } from "../providers/openaiCompatibleChatRequest";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { buildGeminiInteractionsRequest } from "../providers/geminiInteractionsRequest";
import { ProviderRequestTimeoutError } from "../providers/network";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import type { ContextCompactionStatus } from "../../contracts/contextCompaction";
import { conversationContextPolicy, type ContextObservation } from "./contextCompactionContract";
import { contextObservationsFromResults } from "./contextCompactionPlanner";
import { prepareCompactedProviderRequest } from "./contextCompactionConsumer";
import { createContextCompactionPublisher } from "./contextCompactionEvents";
import { beforeAnswerDispatch, runProviderToolLoop } from "./providerToolLoop";
import { createRunFollowupExecution, requestWithoutRunFollowups, requestWithRunFollowups, RunFollowupChanged, unsettledInterruptedUsage } from "./runFollowupExecution";
import { notifyRunFollowup } from "./runFollowupRegistry";
import type { RunFollowupOperations } from "./runFollowups";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function request(provider = "openai"): ProviderRunRequest {
  return { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ type: "text", text: "Original request" }] },
    context: { messages: [], mode: "branch_path" }, knowledgePlan: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
    toolMode: "auto", modelCapabilities: { contextWindow: 32_768, defaultMaxOutputTokens: 256, nativePdfInput: false,
      nativeSearch: false, pdf: false, reasoning: false, vision: false }, modelId: "synthetic", params: { max_output_tokens: 256 },
    prompt: { system: "Accepted system", developer: null }, provider, searchPlan: { mode: "all_selected", options: [] } };
}
const result = (text: string): ProviderRunResult => ({ finalText: text, finalProviderResponsePreview: {},
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, completeness: "complete" } });

const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });

function fixture(observations?: () => readonly ContextObservation[]) {
  const rows: RunFollowup[] = [];
  let text = "", closed = false;
  const beforeDelivery = vi.fn(async () => text);
  const onDelivery = vi.fn(async () => { text = ""; });
  const onInterruptedUsage = vi.fn<Parameters<typeof createRunFollowupExecution>[0]["onInterruptedUsage"]>(async () => undefined);
  // The owner's consumer; these tests only need its identity semantics.
  const compact = vi.fn(async (value: ProviderRunRequest, _signal: AbortSignal) => value);
  const operations: RunFollowupOperations = {
    accept: vi.fn(), beginKnowledge: vi.fn(async () => 0),
    load: vi.fn(async () => ({ revision: rows.length, entries: rows.map(entry => ({ ...entry })) })),
    deliver: vi.fn(async input => {
      if (closed || input.revision !== rows.length) return false;
      let first = true;
      rows.forEach((entry, index) => {
        if (entry.delivery !== "accepted") return;
        rows[index] = { ...entry, delivery: "delivered", ...(first && input.precedingText ? { precedingText: input.precedingText } : {}) };
        first = false;
      });
      return true;
    }),
    close: vi.fn(async input => {
      if (input.revision !== rows.length || rows.some(entry => entry.delivery === "accepted")) return false;
      closed = true;
      return true;
    })
  };
  const execution = createRunFollowupExecution({ operations, runId: "run", userId: "user", beforeDelivery, onDelivery,
    onInterruptedUsage, bridge: openAIResponsesToolBridge, ...(observations ? { observations } : {}) });
  disposals.push(execution.release);
  function accept(value: string, notify = true) {
    rows.push({ id: `f-${rows.length + 1}`, ordinal: rows.length + 1, text: value,
      author: "Author", createdAt: new Date().toISOString(), delivery: "accepted" });
    if (notify) notifyRunFollowup("run", rows.length);
  }
  async function consume(iterator: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>) {
    let next = await iterator.next();
    const events: ModelRunSseEvent[] = [];
    while (!next.done) {
      events.push(next.value);
      if (next.value.type === "token") text += next.value.data.delta;
      next = await iterator.next();
    }
    return { events, result: next.value, text };
  }
  return { accept, compact, consume, execution, operations, rows, onDelivery, onInterruptedUsage };
}

describe("in-run clarification execution", () => {
  it("does not restart a generation for an acknowledged duplicate submission", async () => {
    const f = fixture(); f.accept("Use a table");
    let calls = 0;
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(_request, options) {
      calls++;
      yield { type: "token", data: { delta: "First part. " } };
      notifyRunFollowup("run", 1);
      expect(options?.signal?.aborted).toBe(false);
      yield { type: "token", data: { delta: "Second part." } };
      return result("First part. Second part.");
    } };
    const answer = await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }));
    expect(calls).toBe(1);
    expect(answer.text).toBe("First part. Second part.");
    expect(f.onInterruptedUsage).not.toHaveBeenCalled();
  });

  it("awaits the old call, fences late output, batches updates and keeps the partial answer", async () => {
    const f = fixture(), emitted = deferred(), stopped = deferred();
    const requests: ProviderRunRequest[] = [];
    let active = 0, maxActive = 0;
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
      requests.push(next); active++; maxActive = Math.max(maxActive, active);
      try {
        if (requests.length === 1) {
          yield { type: "token", data: { delta: "Earlier draft" } };
          emitted.resolve(); await stopped.promise;
          yield { type: "token", data: { delta: " stale text" } };
          return result("stale final");
        }
        yield { type: "token", data: { delta: "Updated answer" } };
        return result("Updated answer");
      } finally { active--; }
    } };
    const original = request(), snapshot = structuredClone(original);
    const completed = f.consume(f.execution.stream(original, { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }));
    await emitted.promise;
    f.accept("Use Russian"); f.accept("Make it concise");
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    stopped.resolve();
    const answer = await completed;
    expect(answer.text).toBe("Updated answer");
    expect(answer.events.some(event => event.type === "token" && event.data.delta.includes("stale"))).toBe(false);
    expect(requests[1]?.providerToolMessages).toEqual([{ role: "user", content: "Use Russian" }, { role: "user", content: "Make it concise" }]);
    expect(f.rows[0]).toMatchObject({ precedingText: "Earlier draft", delivery: "delivered" });
    expect(f.rows[1]).not.toHaveProperty("precedingText");
    expect(f.onInterruptedUsage).toHaveBeenCalledTimes(1);
    expect(f.onInterruptedUsage.mock.calls[0]?.[0]).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(maxActive).toBe(1);
    expect(original).toEqual(snapshot);
  });

  it("reads the receipt at completion even when its wake-up hint is lost", async () => {
    const f = fixture(); let calls = 0;
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream() {
      if (++calls === 1) f.accept("Use a table", false);
      yield { type: "token", data: { delta: String(calls) } };
      return result(String(calls));
    } };
    const answer = await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }));
    expect(answer.result.finalText).toBe("2"); expect(calls).toBe(2);
    expect(f.rows[0]?.delivery).toBe("delivered");
  });

  it("delivers PREPARING receipts before the first provider request", async () => {
    const f = fixture(); f.accept("Answer in two sentences");
    const requests: ProviderRunRequest[] = [];
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(value) { requests.push(value); yield { type: "token", data: { delta: "ready" } }; return result("ready"); } };
    await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.providerToolMessages).toEqual([{ role: "user", content: "Answer in two sentences" }]);
  });

  it("dispatches the owner's prepared round unchanged when no clarification was delivered", async () => {
    const f = fixture();
    const requests: ProviderRunRequest[] = [];
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(value) { requests.push(value); return result("done"); } };
    const prepared = request();
    await f.consume(f.execution.stream(prepared, { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }));
    expect(f.compact).not.toHaveBeenCalled();
    expect(requests).toEqual([prepared]);
    expect(requests[0]).toBe(prepared);
  });

  it("routes clarifications through the owner's consumer and carries its summary into a steering replacement", async () => {
    // History older than the exact tail a summary keeps, so a summary can
    // create headroom once the older observation has been masked.
    const turn = (id: string, role: "assistant" | "user", text: string) => ({ content: { blocks: [{ text, type: "text" }] }, id, role });
    const messages = [
      turn("message-old", "user", `old source ${"o".repeat(1_200)}`), turn("reply-old", "assistant", "Noted."),
      turn("message-2", "user", "Second question."), turn("reply-2", "assistant", "Answered."),
      turn("message-3", "user", "Third question."), turn("reply-3", "assistant", "Answered."),
      turn("message-current", "user", "current request")
    ];
    const descriptor = {
      byteSize: 20_000, checksum: "a".repeat(64), encoding: "json-utf8-v1" as const,
      handle: `tor1_${"a".repeat(32)}`, maskable: true, source: "mcp" as const,
      sourceTruncated: false, version: 1 as const
    };
    const observed = (id: string, seed: string) => projectObservationForProvider({
      callId: id,
      content: [{ text: `${id}-${"x".repeat(id === "old" ? 6_000 : 1_800)}`, type: "text" as const }],
      name: "read_record",
      observation: { ...descriptor, checksum: seed.repeat(64), handle: `tor1_${seed.repeat(32)}` },
      status: "complete" as const
    });
    const settled = [observed("old", "a"), observed("new", "b")];
    const observations = contextObservationsFromResults(settled);
    const f = fixture(() => observations); f.accept("Keep the exact correction");
    const hybrid = {
      ...request(),
      context: { messages, mode: "branch_path" as const },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "message-current", messages, mode: "hybrid" }),
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 2_000, toolCalling: true },
      providerToolMessages: [
        openAIResponsesToolBridge.appendToolResult(undefined, settled[0]!),
        { call_id: "new", name: "read_record", type: "function_call" },
        openAIResponsesToolBridge.appendToolResult(undefined, settled[1]!)
      ],
      toolObservationVersion: 1 as const,
      tools: [readToolResultTool]
    };
    const summaries: ProviderRunRequest[] = [];
    const answers: ProviderRunRequest[] = [];
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
      if (next.forceNonStreaming) {
        summaries.push(next);
        const output = JSON.stringify({ notes: "The correction remains binding.", sourceRefs: ["message-old"] });
        yield { type: "token", data: { delta: output } };
        return result(output);
      }
      answers.push(next);
      if (answers.length === 1) {
        yield { type: "token", data: { delta: "Earlier draft" } };
        f.accept("Also keep the second correction");
        return result("stale");
      }
      yield { type: "token", data: { delta: "final" } };
      return result("final");
    } };
    const statuses: ContextCompactionStatus[] = [];
    const publisher = createContextCompactionPublisher(async status => { statuses.push(status); });
    const consumer = vi.fn((merged: ProviderRunRequest, signal: AbortSignal) => prepareCompactedProviderRequest({
      bridge: openAIResponsesToolBridge,
      failure: (code, message) => Object.assign(new Error(message), { code }),
      observations,
      receipts: { claim: async () => undefined, dispatch: async () => undefined, settle: async () => undefined },
      publisher,
      request: merged,
      signal,
      summaryAdapter: adapter
    }));
    const answer = await f.consume(f.execution.stream(hybrid, {
      adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true, compact: consumer
    }));
    expect(answer.result.finalText).toBe("final");
    // One purchase: the replacement re-enters the same consumer with the
    // committed summary already carried, so it is not bought again.
    expect(summaries).toHaveLength(1);
    expect(consumer).toHaveBeenCalledTimes(2);
    expect(consumer.mock.calls[1]?.[0].contextCompactionSummary?.notes).toContain("correction");
    expect(JSON.stringify(consumer.mock.calls[1]?.[0].providerToolMessages?.slice(-2))).toContain("second correction");
    expect(answers).toHaveLength(2);
    for (const dispatched of answers) {
      expect(dispatched.contextCompactionSummary?.notes).toContain("correction");
      expect(dispatched.contextCompaction?.outcome).not.toBe("needs_summary");
    }
    expect(JSON.stringify(answers[1]?.providerToolMessages)).toContain("Keep the exact correction");
    // The older observation reached the model only as its server-owned reference.
    for (const dispatched of answers) expect(JSON.stringify(dispatched.providerToolMessages)).not.toContain("x".repeat(2_000));
    expect(statuses.map(({ cycle, outcome, state }) => [cycle, state, outcome])).toEqual([
      [1, "running", "pending"], [1, "complete", "summary_applied"]
    ]);
  });

  it("strips exactly the clarification tail it appended and rejects any other tail", () => {
    const entries: RunFollowup[] = [{ id: "f-1", ordinal: 1, text: "Clarified", author: "Author",
      createdAt: new Date().toISOString(), delivery: "delivered" }];
    const base = { ...request(), providerToolMessages: [{ type: "function_call_output", call_id: "c", output: "masked" }] };
    const merged = requestWithRunFollowups(base, entries);
    expect(requestWithoutRunFollowups(merged, entries)?.providerToolMessages).toEqual(base.providerToolMessages);
    expect(requestWithoutRunFollowups(base, entries)).toBeNull();
    expect(requestWithoutRunFollowups(base, [])).toBe(base);
  });

  it("keeps Stop terminal and never dispatches a pending replacement", async () => {
    const f = fixture(), started = deferred(), stopped = deferred(), controller = new AbortController();
    let calls = 0;
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream() {
      calls++; started.resolve(); await stopped.promise;
      yield { type: "token", data: { delta: "late" } }; return result("late");
    } };
    const completed = f.consume(f.execution.stream(request(), { adapter, signal: controller.signal, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }));
    await started.promise; f.accept("Pending update"); controller.abort(); stopped.resolve();
    await expect(completed).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1); expect(f.rows[0]?.delivery).toBe("accepted");
    expect(f.onInterruptedUsage).not.toHaveBeenCalled();
  });

  it("preserves the original call deadline across replacements", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000);
    const f = fixture(), timeouts: number[] = [];
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(_request, options) {
      timeouts.push(options!.timeoutMs!);
      if (timeouts.length === 1) { vi.setSystemTime(1_400); f.accept("Shorter"); throw new DOMException("Interrupted", "AbortError"); }
      yield { type: "token", data: { delta: "done" } }; return result("done");
    } };
    await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 1_000, closeOnFinal: true, compact: f.compact }));
    expect(timeouts).toEqual([1_000, 600]);
    expect(f.onInterruptedUsage.mock.calls[0]?.[0]).toMatchObject({ inputTokens: null, outputTokens: null, completeness: "unavailable" });
  });

  it("runs a clarification's summary chain outside the per-request deadline and then grants the full deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(), timeouts: number[] = [];
    f.accept("Clarified before the dispatch", false);
    // A paid summary chain longer than the whole per-request deadline.
    const compact = vi.fn(async (value: ProviderRunRequest, signal: AbortSignal) => {
      await vi.advanceTimersByTimeAsync(5_000);
      signal.throwIfAborted();
      return value;
    });
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(_request, options) {
      timeouts.push(options!.timeoutMs!);
      expect(options!.signal!.aborted).toBe(false);
      yield { type: "token", data: { delta: "answer" } };
      return result("answer");
    } };
    const answer = await f.consume(f.execution.stream(request(), {
      adapter, signal: new AbortController().signal, timeoutMs: 1_000, closeOnFinal: true, compact
    }));
    expect(compact).toHaveBeenCalledOnce();
    expect(answer.result.finalText).toBe("answer");
    expect(timeouts).toEqual([1_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps Stop terminal for a clarification's summary chain before any dispatch", async () => {
    const f = fixture(), started = deferred(), controller = new AbortController();
    f.accept("Clarified before the dispatch", false);
    const stream = vi.fn();
    const compact = vi.fn((_value: ProviderRunRequest, signal: AbortSignal) => new Promise<ProviderRunRequest>((_resolve, reject) => {
      started.resolve();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const completed = f.consume(f.execution.stream(request(), {
      adapter: { stream }, signal: controller.signal, timeoutMs: 1_000, closeOnFinal: true, compact
    }));
    await started.promise;
    controller.abort();
    await expect(completed).rejects.toMatchObject({ name: "AbortError" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("records no answer-round usage when compaction fails before a clarified dispatch", async () => {
    const f = fixture();
    const raw: ProviderAdapter = { buildRequestPreview: () => ({}), stream: vi.fn() };
    const failure = Object.assign(new Error("summary failed"), { code: "context_compaction_summary_failed" });
    const onUsage = vi.fn();
    f.accept("Clarified before the dispatch", false);
    const outcome = await runProviderToolLoop({
      adapter: { ...raw, stream: (next, options) => f.execution.stream(next, {
        adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true,
        compact: async () => { throw failure; } }) },
      bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(), initialRequest: request(), onUsage, parallelToolCalls: false, tools: []
    });
    expect(outcome).toMatchObject({ status: "failed" });
    expect(raw.stream).not.toHaveBeenCalled();
    // No phantom partial round: the paid summary calls own their usage.
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("still reports a dispatched answer's partial usage when it fails after a clarification", async () => {
    const f = fixture();
    const raw: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream() {
      yield { type: "usage", data: { inputTokens: 9, outputTokens: 1 } };
      throw Object.assign(new Error("upstream"), { status: 503 });
    } };
    const onUsage = vi.fn();
    f.accept("Clarified before the dispatch", false);
    const outcome = await runProviderToolLoop({
      adapter: { ...raw, stream: (next, options) => f.execution.stream(next, {
        adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }) },
      bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(), initialRequest: request(), onUsage, parallelToolCalls: false, tools: []
    });
    expect(outcome).toMatchObject({ status: "failed" });
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ inputTokens: 9, completeness: "partial" });
    expect(onUsage.mock.calls[0]?.[2]).toEqual({ completeness: "partial", round: 1 });
  });

  it("records no answer-round usage when the owner refuses a steering replacement before dispatch", async () => {
    const f = fixture(), emitted = deferred();
    let calls = 0;
    const raw: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(_next, options) {
      calls++;
      if (calls === 1) {
        yield { type: "usage", data: { inputTokens: 9, outputTokens: 1 } };
        emitted.resolve();
        await new Promise<never>((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        });
      }
      // The owner's authority recheck refuses the replacement before any provider I/O.
      throw beforeAnswerDispatch(Object.assign(new Error("The selected model is no longer available"), { code: "model_not_available" }));
    } };
    const onUsage = vi.fn();
    const outcome = runProviderToolLoop({
      adapter: { ...raw, stream: (next, options) => f.execution.stream(next, {
        adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }) },
      bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(), initialRequest: request(), onUsage, parallelToolCalls: false, tools: []
    });
    await emitted.promise;
    f.accept("Clarified during the generation");
    await expect(outcome).resolves.toMatchObject({ status: "failed" });
    expect(calls).toBe(2);
    // The interrupted generation is accounted once by the owner; the refused replacement is no round.
    expect(f.onInterruptedUsage).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("still counts an unmarked failure before any provider event as a dispatched round", async () => {
    const f = fixture();
    const raw: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream() {
      throw Object.assign(new Error("upstream"), { status: 503 });
    } };
    const onUsage = vi.fn();
    const outcome = await runProviderToolLoop({
      adapter: { ...raw, stream: (next, options) => f.execution.stream(next, {
        adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }) },
      bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(), initialRequest: request(), onUsage, parallelToolCalls: false, tools: []
    });
    expect(outcome).toMatchObject({ status: "failed" });
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ completeness: "unavailable" });
    expect(onUsage.mock.calls[0]?.[2]).toEqual({ completeness: "partial", round: 1 });
  });

  it("forwards the owner's reported interrupted usage once when its persistence fails", async () => {
    const f = fixture(), emitted = deferred();
    const cancelled = { inputTokens: 11, outputTokens: 2, totalTokens: 13 };
    f.onInterruptedUsage.mockImplementationOnce(async () => {
      throw unsettledInterruptedUsage(new Error("accounting_write_failed"), { ...cancelled, completeness: "partial" });
    });
    const raw: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(_next, options) {
      yield { type: "usage", data: { inputTokens: 9 } };
      emitted.resolve();
      await new Promise<never>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      });
      return result("unreachable");
    } };
    const onUsage = vi.fn();
    const outcome = runProviderToolLoop({
      adapter: { ...raw, stream: (next, options) => f.execution.stream(next, {
        adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }) },
      bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 1, maxToolRounds: 1 },
      executeTool: vi.fn(), initialRequest: request(), onUsage, parallelToolCalls: false, tools: []
    });
    await emitted.promise;
    f.accept("Clarified during the generation");
    await expect(outcome).resolves.toMatchObject({ status: "failed" });
    expect(f.onInterruptedUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ ...cancelled, completeness: "partial" });
  });

  it("retains a typed provider deadline before headers without retrying the request", async () => {
    vi.useFakeTimers();
    const f = fixture(), started = deferred();
    let calls = 0;
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(_request, options) {
      calls++;
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      });
      return result("unreachable");
    } };
    const completed = f.consume(f.execution.stream(request(), {
      adapter, signal: new AbortController().signal, timeoutMs: 45_000, closeOnFinal: true, compact: f.compact
    }));
    const rejected = expect(completed).rejects.toBeInstanceOf(ProviderRequestTimeoutError);
    await started.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(calls).toBe(1);
    expect(f.onInterruptedUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an in-flight tool and carries its settled result into the clarified request", async () => {
    const f = fixture(), toolStarted = deferred(), toolDone = deferred(); let calls = 0;
    const requests: ProviderRunRequest[] = [];
    const raw: ProviderAdapter = { buildRequestPreview: () => ({}), async *stream(next) {
      requests.push(next); calls++;
      if (calls === 1) return { ...result(""), toolCalls: [{ id: "effect", name: "update_record", arguments: {} }] };
      yield { type: "token", data: { delta: "done" } }; return result("done");
    } };
    const executeTool = vi.fn(async () => {
      toolStarted.resolve(); await toolDone.promise;
      return { status: "complete" as const, value: { callId: "effect", name: "update_record", status: "complete" as const, content: [{ type: "text" as const, text: "Saved once" }] } };
    });
    const completion = runProviderToolLoop({ adapter: { ...raw, stream: (next, options) => f.execution.stream(next, {
      adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true, compact: f.compact }) },
      bridge: openAIResponsesToolBridge, budgets: { maxConcurrency: 1, maxToolCalls: 2, maxToolRounds: 2 }, executeTool,
      initialRequest: request(), parallelToolCalls: false,
      tools: [{ capability: "mcp", name: "update_record", description: "Update synthetic record", inputSchema: { type: "object" } }] });
    await toolStarted.promise; f.accept("Explain the saved change");
    expect(calls).toBe(1); toolDone.resolve();
    expect(await completion).toMatchObject({ status: "complete", toolCalls: 1, toolRounds: 1 });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(requests[1]?.providerToolMessages).toMatchObject([
      { type: "function_call", call_id: "effect" }, { type: "function_call_output", call_id: "effect", output: "Saved once" },
      { role: "user", content: "Explain the saved change" }
    ]);
  });

  it("does not accept a late structured result as the clarified question's review", async () => {
    const f = fixture(), finish = deferred(); await f.execution.prepare(request());
    const pending = f.execution.operation(new AbortController().signal, async () => { await finish.promise; return "old review"; });
    f.accept("A different requirement"); finish.resolve();
    await expect(pending).rejects.toBeInstanceOf(RunFollowupChanged);
    expect(f.rows[0]?.delivery).toBe("accepted");
  });
});

describe("provider-family clarification requests", () => {
  it.each([
    ["openai", buildOpenAIResponsesRequest], ["deepseek", buildDeepSeekResponsesRequest],
    ["openrouter", buildOpenRouterChatRequest], ["openai_compatible", buildOpenAICompatibleChatRequest],
    ["anthropic", buildAnthropicMessagesRequest], ["gemini", buildGeminiInteractionsRequest]
  ] as const)("serializes ordered user input for %s without changing instructions", (provider, build) => {
    const entries: RunFollowup[] = ["First clarification", "Second clarification"].map((text, index) => ({
      id: `f-${index}`, ordinal: index + 1, text, author: "Author", createdAt: new Date().toISOString(), delivery: "delivered"
    }));
    const original = request(provider), revised = requestWithRunFollowups(original, entries);
    const body = JSON.stringify(build(revised));
    expect(body.indexOf("First clarification")).toBeLessThan(body.indexOf("Second clarification"));
    expect(body.match(/First clarification/gu)).toHaveLength(1);
    expect(revised.prompt).toBe(original.prompt);
    expect(revised.content).toBe(original.content);
  });
});
