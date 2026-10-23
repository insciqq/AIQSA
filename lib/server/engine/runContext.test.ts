import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextCompactionStatus } from "../../contracts/contextCompaction";
import { contextTokenEstimator } from "../../domain/tokenEstimate";
import { responsesHistoryFromOutput } from "../providers/history";
import { PROVIDER_CONTEXT_LENGTH_EXCEEDED } from "../providers/responseFailure";
import type { ProviderRunRequest } from "../providers/types";
import {
  engineItemRules,
  type CompactionModelCall,
  type CompactionModelRequest,
  type CompactionModelResult
} from "./compaction";
import { handleFor, transcriptBuilder } from "./compaction/compaction.testFixtures";
import { SUMMARY_SECTIONS } from "./compaction/summaryPrompt";
import { contextMeasureCalibration, measureContext } from "./contextMeasure";
import { COMPACTION_LIFECYCLE, createRunContext } from "./runContext";
import { COMPACTION_SUMMARY_HEADING, projectTranscript, type TranscriptItem, type TranscriptTarget } from "./transcript";

/** The route and model `transcriptBuilder` attributes its items to. */
const TARGET: TranscriptTarget = { model: "gpt-6.1-sol", provider: "codex-lb" };
const NATIVE: TranscriptTarget = { ...TARGET, nativeCompaction: true };
const SUMMARY = SUMMARY_SECTIONS.map((section) => `## ${section}\n- ${section} facts`).join("\n\n");
const PROMPT = { developer: null, system: "Be brief." };
/** The estimate the run measures with for the request's provider (`fake`: character weights). */
const estimate = contextTokenEstimator({ modelId: "fake-qsa", provider: "fake" });

const summaryReply = (): CompactionModelResult => ({ text: SUMMARY, usage: { inputTokens: 5_000, outputTokens: 300 } });
const nativeReply = (): CompactionModelResult => ({
  history: responsesHistoryFromOutput([{ encrypted_content: "ENC", id: "cmp_1", type: "compaction" }]), text: "",
  usage: { inputTokens: 5_000, outputTokens: 900 }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Lets a finished compaction's promise chain settle. */
const ticks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `turns` worked turns: a question, a lookup with a `size`-character result and an answer. */
function workChat(turns: number, size: number) {
  const chat = transcriptBuilder();
  for (let turn = 1; turn <= turns; turn += 1) {
    chat.user(`question ${turn}: ${"q".repeat(200)}`);
    chat.tool("lookup", { turn }, `result ${turn} ${"r".repeat(size)}`);
    chat.answer(`answer ${turn} ${"a".repeat(300)}`);
  }
  return chat;
}

function request(items: readonly TranscriptItem[], target: TranscriptTarget = TARGET): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] }, history: projectTranscript(items, target),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: PROMPT, provider: "fake", searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "auto", toolMode: "auto", tools: []
  };
}

/** What the run measures for `items` before any provider figure. */
function measured(items: readonly TranscriptItem[], target: TranscriptTarget = TARGET): number {
  return measureContext({ calibration: contextMeasureCalibration(null), estimate, fixedTokens: estimate([PROMPT, null, []]), items, target })
    .tokens;
}

/** A window whose usable part puts `items` at `share` of it. */
function windowAt(items: readonly TranscriptItem[], share: number, target: TranscriptTarget = TARGET) {
  return { contextWindow: Math.ceil(measured(items, target) / share) + 1_000, maxOutputTokens: 1_000 };
}

function harness(items: TranscriptItem[], options: Readonly<{
  call: CompactionModelCall;
  record?: (item: TranscriptItem) => TranscriptItem;
  target?: TranscriptTarget;
  window: Readonly<{ contextWindow: number; maxOutputTokens: number }> | null;
}>) {
  const appended: TranscriptItem[] = [];
  const statuses: ContextCompactionStatus[] = [];
  const calls: CompactionModelRequest[] = [];
  const context = createRunContext({
    append: async (added) => {
      items.push(...added);
      appended.push(...added);
    },
    compactionCall: () => async (call) => {
      calls.push(call);
      return options.call(call);
    },
    items,
    onStatus: async (status) => { statuses.push(status); },
    projection: {},
    record: options.record ?? ((item) => item),
    rules: engineItemRules(),
    runId: "run-1",
    signal: new AbortController().signal,
    target: options.target ?? TARGET,
    tooLarge: () => new Error("context_too_large"),
    window: options.window
  });
  return { appended, calls, context, statuses };
}

const firstText = (sent: ProviderRunRequest) => {
  const first = sent.history?.[0];
  return first?.type === "user" ? first.text : "";
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a native run's context", () => {
  it("starts a background compaction at the threshold without waiting and swaps its item in at the next request boundary", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const run = harness(chat.items, { call: () => reply.promise, window: windowAt(chat.items, 0.78) });
    const first = await run.context.prepare(request(chat.items));
    // The request goes as it is: nobody waits for the compaction.
    expect(first.history).toEqual(projectTranscript(chat.items, TARGET));
    expect(run.calls.map((call) => call.kind)).toEqual(["summary"]);
    expect(run.appended).toEqual([]);
    expect(run.statuses).toEqual([]);

    // The turn goes on while it runs; what it adds stays in the kept tail.
    chat.answer("worked on while compacting");
    reply.resolve(summaryReply());
    await ticks();
    const second = await run.context.prepare(request(chat.items));
    expect(run.appended).toEqual([expect.objectContaining({ kind: "compaction", summary: SUMMARY })]);
    expect(firstText(second).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    expect(second.history?.at(-1)).toEqual({ text: "worked on while compacting", type: "assistant_text" });
    // Only a settled status: no running one, which would say the answer waits.
    expect(run.statuses).toEqual([expect.objectContaining({ cycle: 1, outcome: "summary_applied", state: "complete" })]);
    expect(run.statuses[0]!.reducedTokens).toBeGreaterThan(0);
    expect(run.calls.every((call) => call.kind === "summary")).toBe(true);
  });

  it("drops a finished background compaction whose cut no longer applies", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const run = harness(chat.items, { call: () => reply.promise, window: windowAt(chat.items, 0.78) });
    await run.context.prepare(request(chat.items));
    // Replay now starts at another compaction: the prepared one covers a span that no longer replays.
    chat.compaction({ summary: "An earlier summary." });
    reply.resolve(summaryReply());
    await ticks();
    await run.context.prepare(request(chat.items));
    expect(run.appended).toEqual([]);
    expect(run.statuses).toEqual([]);
  });

  it("waits for the running compaction once the context passes the swap threshold", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const window = windowAt(chat.items, 0.78);
    const run = harness(chat.items, { call: () => reply.promise, window });
    await run.context.prepare(request(chat.items));
    // A large result pushes the next request past the swap threshold.
    const usable = window.contextWindow - window.maxOutputTokens;
    const perChar = estimate("x".repeat(10_000)) / 10_000;
    chat.tool("lookup", { turn: 9 }, "x".repeat(Math.ceil(usable * 0.12 / perChar)));
    expect(measured(chat.items) / usable).toBeGreaterThan(0.85);
    const waiting = run.context.prepare(request(chat.items));
    setTimeout(() => reply.resolve(summaryReply()), 20);
    const sent = await waiting;
    // It waited for the running one instead of compacting again in the foreground.
    expect(run.statuses.map((status) => status.state)).toEqual(["complete"]);
    expect(run.appended).toEqual([expect.objectContaining({ kind: "compaction" })]);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    // The large result came after the cut and is replayed whole.
    expect(sent.history?.some((item) => item.type === "tool_result" && item.output.startsWith("xxx"))).toBe(true);
  });

  it("compacts in the foreground past the swap threshold when none runs, shown while the request waits", async () => {
    const chat = workChat(8, 2_000);
    const run = harness(chat.items, { call: async () => summaryReply(), window: windowAt(chat.items, 0.9) });
    const sent = await run.context.prepare(request(chat.items));
    expect(run.calls.length).toBeGreaterThanOrEqual(1);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    expect(run.statuses).toEqual([
      expect.objectContaining({ cycle: 1, outcome: "pending", state: "running" }),
      expect.objectContaining({ cycle: 1, outcome: "summary_applied", state: "complete" })
    ]);
  });

  it("compacts natively on a route that takes its own compaction items back", async () => {
    const chat = workChat(8, 2_000);
    const run = harness(chat.items, { call: async (call) => call.kind === "native" ? nativeReply() : summaryReply(), target: NATIVE,
      window: windowAt(chat.items, 0.9, NATIVE) });
    const sent = await run.context.prepare(request(chat.items, NATIVE));
    expect(run.calls.map((call) => call.kind)).toEqual(["native"]);
    expect(run.appended).toEqual([expect.objectContaining({ kind: "compaction", native: expect.objectContaining({ format: "openai_responses" }) })]);
    expect(sent.history?.[0]).toMatchObject({ type: "compaction" });
    // The record and the earlier user messages follow the opaque item.
    expect(sent.history?.[1]).toMatchObject({ type: "user" });
  });

  it("on a size rejection compacts in the foreground and returns the request to send once more, only once", async () => {
    const chat = workChat(8, 2_000);
    const run = harness(chat.items, { call: async () => summaryReply(), window: windowAt(chat.items, 0.5) });
    const sent = await run.context.prepare(request(chat.items));
    expect(run.calls).toHaveLength(0);
    expect(await run.context.overflow(sent, Object.assign(new Error("bad gateway"), { status: 502 }))).toBeNull();
    // The provider counted the request 30 % above the measure.
    const rejection = Object.assign(new Error("too long"), { code: PROVIDER_CONTEXT_LENGTH_EXCEEDED,
      reportedPromptTokens: Math.ceil(measured(chat.items) * 1.3) });
    const retry = await run.context.overflow(sent, rejection);
    expect(retry).not.toBeNull();
    expect(firstText(retry!).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    const calls = run.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(run.statuses.map((status) => status.state)).toEqual(["running", "complete"]);
    // The retried request is well below what was rejected.
    expect(measured(chat.items)).toBeLessThan(measured(chat.items.slice(0, -1)) * 0.8);
    expect(await run.context.overflow(retry!, rejection)).toBeNull();
    expect(run.calls).toHaveLength(calls);
  });

  it("after the answer waits for a running compaction and keeps its item, so the next turn starts compacted", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const run = harness(chat.items, { call: () => reply.promise, window: windowAt(chat.items, 0.78) });
    await run.context.prepare(request(chat.items));
    chat.answer("The final answer.");
    const after = run.context.afterAnswer();
    setTimeout(() => reply.resolve(summaryReply()), 20);
    await after;
    expect(run.appended).toEqual([expect.objectContaining({ kind: "compaction" })]);
    expect(chat.items.at(-1)).toMatchObject({ kind: "compaction" });
    expect(run.statuses).toEqual([expect.objectContaining({ outcome: "summary_applied", state: "complete" })]);
  });

  it("stops a compaction still running after the answer's bound, or at once after an approval stop", async () => {
    vi.useFakeTimers();
    const hanging: CompactionModelCall = (call) => new Promise((_, reject) => {
      call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    for (const wait of [true, false]) {
      const chat = workChat(8, 2_000);
      const run = harness(chat.items, { call: hanging, window: windowAt(chat.items, 0.78) });
      await run.context.prepare(request(chat.items));
      expect(run.calls).toHaveLength(1);
      const after = run.context.afterAnswer({ wait });
      if (wait) await vi.advanceTimersByTimeAsync(COMPACTION_LIFECYCLE.afterAnswerWaitMs + 1);
      await after;
      expect(run.appended).toEqual([]);
      expect(run.statuses).toEqual([]);
    }
  });

  it("leaves results a handle reads out of the one request when compaction cannot help, and fails visibly when nothing fits", async () => {
    const handled = transcriptBuilder();
    handled.user("Read the export.");
    const callId = handled.call("lookup", { file: "export.csv" });
    handled.items.push({ callId, handle: handleFor("export"), id: handled.nextId(), kind: "tool_result", name: "lookup", outcome: "complete",
      output: `row ${"e".repeat(12_000)}` });
    handled.answer("The export has 40 rows.");
    const run = harness(handled.items, { call: async () => ({ text: "not a summary" }), window: windowAt(handled.items, 1.3) });
    const sent = await run.context.prepare(request(handled.items));
    const result = sent.history?.find((item) => item.type === "tool_result");
    expect(result?.type === "tool_result" ? result.output : "").toContain(`read_tool_result {"handle":"${handleFor("export")}"}`);
    // The compaction it tried in the foreground failed visibly; the transcript keeps the result unchanged.
    expect(run.statuses.map((status) => [status.state, status.outcome])).toEqual([["running", "pending"], ["failed", "summary_failed"]]);
    expect(handled.items.find((item) => item.kind === "tool_result")).toMatchObject({ output: expect.stringContaining("eeee") });

    const unhandled = transcriptBuilder();
    unhandled.user("Read the export.");
    unhandled.tool("lookup", { file: "export.csv" }, `row ${"e".repeat(12_000)}`);
    unhandled.answer("The export has 40 rows.");
    const stuck = harness(unhandled.items, { call: async () => ({ text: "not a summary" }), window: windowAt(unhandled.items, 1.3) });
    await expect(stuck.context.prepare(request(unhandled.items))).rejects.toThrow("context_too_large");
  });

  it("summarizes a run-scoped result only as the note later turns read", async () => {
    const chat = transcriptBuilder();
    chat.user("What do you remember about my trip?");
    chat.tool("memory_search", { query: "trip" }, "PRIVATE-MEMORY-FACT: flight on the 12th");
    chat.answer("You fly on the 12th.");
    for (let turn = 1; turn <= 7; turn += 1) {
      chat.user(`question ${turn}: ${"q".repeat(200)}`);
      chat.tool("lookup", { turn }, `result ${turn} ${"r".repeat(2_000)}`);
      chat.answer(`answer ${turn} ${"a".repeat(300)}`);
    }
    const note = "This result was used only in the answer that produced it and is not kept.";
    const run = harness(chat.items, { call: async () => summaryReply(), window: windowAt(chat.items, 0.9),
      record: (item) => item.kind === "tool_result" && item.name === "memory_search" ? { ...item, output: note } : item });
    await run.context.prepare(request(chat.items));
    const sentText = JSON.stringify(run.calls.map((call) => call.history));
    expect(sentText).not.toContain("PRIVATE-MEMORY-FACT");
    expect(sentText).toContain(note);
    expect(JSON.stringify(run.appended)).not.toContain("PRIVATE-MEMORY-FACT");
  });

  it("measures nothing without a window", async () => {
    const chat = workChat(8, 2_000);
    const run = harness(chat.items, { call: async () => summaryReply(), window: null });
    const sent = request(chat.items);
    expect(await run.context.prepare(sent)).toBe(sent);
    expect(run.calls).toHaveLength(0);
  });
});
