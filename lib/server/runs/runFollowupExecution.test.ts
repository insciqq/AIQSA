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
import { conversationContextPolicy } from "./contextCompactionContract";
import { runProviderToolLoop } from "./providerToolLoop";
import { createRunFollowupExecution, requestWithRunFollowups, RunFollowupChanged } from "./runFollowupExecution";
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

function fixture() {
  const rows: RunFollowup[] = [];
  let text = "", closed = false;
  const beforeDelivery = vi.fn(async () => text);
  const onDelivery = vi.fn(async () => { text = ""; });
  const onInterruptedUsage = vi.fn<Parameters<typeof createRunFollowupExecution>[0]["onInterruptedUsage"]>(async () => undefined);
  const onCompactionStatus = vi.fn<NonNullable<Parameters<typeof createRunFollowupExecution>[0]["onCompactionStatus"]>>(async () => undefined);
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
    onInterruptedUsage, onCompactionStatus, bridge: openAIResponsesToolBridge });
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
  return { accept, consume, execution, operations, rows, onDelivery, onInterruptedUsage, onCompactionStatus };
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
    const answer = await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true }));
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
    const completed = f.consume(f.execution.stream(original, { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true }));
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
    const answer = await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true }));
    expect(answer.result.finalText).toBe("2"); expect(calls).toBe(2);
    expect(f.rows[0]?.delivery).toBe("delivered");
  });

  it("delivers PREPARING receipts before the first provider request", async () => {
    const f = fixture(); f.accept("Answer in two sentences");
    const requests: ProviderRunRequest[] = [];
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(value) { requests.push(value); yield { type: "token", data: { delta: "ready" } }; return result("ready"); } };
    await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.providerToolMessages).toEqual([{ role: "user", content: "Answer in two sentences" }]);
  });

  it("summarizes a hybrid context after delivering a clarification", async () => {
    const f = fixture(); f.accept("Keep the exact correction");
    const messages = [
      { content: { blocks: [{ text: "old source", type: "text" }] }, id: "message-old", role: "user" as const },
      { content: { blocks: [{ text: "current request", type: "text" }] }, id: "message-current", role: "user" as const }
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
    const hybrid = {
      ...request(),
      context: { messages, mode: "branch_path" as const },
      contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "message-current", messages, mode: "hybrid" }),
      modelCapabilities: { ...request().modelCapabilities, contextWindow: 2_000, toolCalling: true },
      providerToolMessages: [
        openAIResponsesToolBridge.appendToolResult(undefined, observed("old", "a")),
        { call_id: "new", name: "read_record", type: "function_call" },
        openAIResponsesToolBridge.appendToolResult(undefined, observed("new", "b"))
      ],
      toolObservationVersion: 1 as const,
      tools: [readToolResultTool]
    };
    const calls: ProviderRunRequest[] = [];
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
      calls.push(next);
      if (calls.length === 1) {
        const output = JSON.stringify({ notes: "The correction remains binding.", sourceRefs: ["message-old"] });
        yield { type: "token", data: { delta: output } };
        return result(output);
      }
      yield { type: "token", data: { delta: "final" } };
      return result("final");
    } };
    const answer = await f.consume(f.execution.stream(hybrid, {
      adapter, signal: new AbortController().signal, timeoutMs: 10_000, closeOnFinal: true
    }));
    expect(answer.result.finalText).toBe("final");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.contextCompactionSummary?.notes).toContain("correction");
    expect(calls[1]?.providerToolMessages?.some(value => JSON.stringify(value).includes("Keep the exact correction"))).toBe(true);
    expect(f.onCompactionStatus.mock.calls.map(([status]) => status.state)).toEqual(["running", "complete"]);
    expect(f.onCompactionStatus.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: "summary_applied" });
  });

  it("keeps Stop terminal and never dispatches a pending replacement", async () => {
    const f = fixture(), started = deferred(), stopped = deferred(), controller = new AbortController();
    let calls = 0;
    const adapter: Pick<ProviderAdapter, "stream"> = { async *stream() {
      calls++; started.resolve(); await stopped.promise;
      yield { type: "token", data: { delta: "late" } }; return result("late");
    } };
    const completed = f.consume(f.execution.stream(request(), { adapter, signal: controller.signal, timeoutMs: 10_000, closeOnFinal: true }));
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
    await f.consume(f.execution.stream(request(), { adapter, signal: new AbortController().signal, timeoutMs: 1_000, closeOnFinal: true }));
    expect(timeouts).toEqual([1_000, 600]);
    expect(f.onInterruptedUsage.mock.calls[0]?.[0]).toMatchObject({ inputTokens: null, outputTokens: null, completeness: "unavailable" });
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
      adapter, signal: new AbortController().signal, timeoutMs: 45_000, closeOnFinal: true
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
      adapter: raw, signal: options!.signal!, timeoutMs: 10_000, closeOnFinal: true }) },
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
