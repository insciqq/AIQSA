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
import { createDetachedCompactions, DETACHED_COMPACTION, transcriptTargetKey, type DetachedCompactions } from "./detachedCompactions";
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
  /** The chat's registry of detached compactions, shared by its runs; absent, nothing goes on after a run. */
  registry?: DetachedCompactions;
  live?: () => Promise<boolean>;
  native?: boolean;
  record?: (item: TranscriptItem) => TranscriptItem;
  runId?: string;
  settleUsage?: () => Promise<void>;
  target?: TranscriptTarget;
  window: Readonly<{ contextWindow: number; maxOutputTokens: number }> | null;
  /** The write of a compaction recorded after the run: whether the chat still took it (default yes). */
  write?: (item: TranscriptItem, status: ContextCompactionStatus | null) => Promise<boolean>;
}>) {
  const appended: TranscriptItem[] = [];
  const inserted: TranscriptItem[] = [];
  const statuses: ContextCompactionStatus[] = [];
  /** Markers recorded after the run, when its stream is closed. */
  const recorded: ContextCompactionStatus[] = [];
  const calls: CompactionModelRequest[] = [];
  const settleUsage = vi.fn(options.settleUsage ?? (async () => undefined));
  const write = vi.fn(async (item: TranscriptItem, status: ContextCompactionStatus | null) => {
    const written = await (options.write ?? (async () => true))(item, status);
    if (written) {
      appended.push(item);
      if (status) recorded.push(status);
    }
    return written;
  });
  const context = createRunContext({
    append: async (added) => {
      items.push(...added);
      appended.push(...added);
    },
    compactionCall: () => async (call) => {
      calls.push(call);
      return options.call(call);
    },
    ...(options.registry ? { detached: { chatId: "chat", live: options.live ?? (async () => true), record: write,
      registry: options.registry, settleUsage, userId: "user" } } : {}),
    insert: (added) => {
      items.push(...added);
      inserted.push(...added);
    },
    items,
    ...(options.native !== undefined ? { native: options.native } : {}),
    onStatus: async (status) => { statuses.push(status); },
    projection: {},
    record: options.record ?? ((item) => item),
    rules: engineItemRules(),
    runId: options.runId ?? "run-1",
    signal: new AbortController().signal,
    target: options.target ?? TARGET,
    tooLarge: () => new Error("context_too_large"),
    window: options.window
  });
  return { appended, calls, context, inserted, recorded, settleUsage, statuses, write };
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

  it("compacts with a summary on every route, also one that compacts natively, unless the native path is switched on", async () => {
    const reply: CompactionModelCall = async (call) => call.kind === "native" ? nativeReply() : summaryReply();
    expect(COMPACTION_LIFECYCLE.native).toBe(false);
    const summarized = workChat(8, 2_000);
    const byDefault = harness(summarized.items, { call: reply, target: NATIVE, window: windowAt(summarized.items, 0.9, NATIVE) });
    const sent = await byDefault.context.prepare(request(summarized.items, NATIVE));
    expect(byDefault.calls.every((call) => call.kind === "summary")).toBe(true);
    expect(byDefault.appended).toEqual([expect.objectContaining({ kind: "compaction", summary: SUMMARY })]);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);

    const compacted = workChat(8, 2_000);
    const native = harness(compacted.items, { call: reply, native: true, target: NATIVE, window: windowAt(compacted.items, 0.9, NATIVE) });
    const nativeSent = await native.context.prepare(request(compacted.items, NATIVE));
    expect(native.calls.map((call) => call.kind)).toEqual(["native"]);
    expect(native.appended).toEqual([expect.objectContaining({ kind: "compaction",
      native: expect.objectContaining({ format: "openai_responses" }) })]);
    expect(nativeSent.history?.[0]).toMatchObject({ type: "compaction" });
    // The record and the earlier user messages follow the opaque item.
    expect(nativeSent.history?.[1]).toMatchObject({ type: "user" });
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

  it("keeps a smaller window a rejection states for the rest of the run, and sends each rejected request once more at most", async () => {
    const chat = transcriptBuilder();
    chat.user("Read the export.");
    const callId = chat.call("lookup", { file: "export.csv" });
    chat.items.push({ callId, handle: handleFor("export"), id: chat.nextId(), kind: "tool_result", name: "lookup", outcome: "complete",
      output: `row ${"e".repeat(12_000)}` });
    chat.answer("The export has 40 rows.");
    const tokens = measured(chat.items);
    // Compaction fails here, so only the lossless fallback can make room.
    const run = harness(chat.items, { call: async () => ({ text: "not a summary" }), window: windowAt(chat.items, 0.5) });
    const elided = (sent: ProviderRunRequest) => sent.history?.some((item) => item.type === "tool_result" &&
      item.output.includes(`read_tool_result {"handle":"${handleFor("export")}"}`)) ?? false;
    const first = await run.context.prepare(request(chat.items));
    expect(elided(first)).toBe(false);
    const rejection = Object.assign(new Error("too long"), { code: PROVIDER_CONTEXT_LENGTH_EXCEEDED,
      reportedMaximumTokens: Math.floor(tokens * 0.9) + 1_000 });
    const retry = await run.context.overflow(first, rejection);
    expect(retry && elided(retry)).toBe(true);
    expect(await run.context.overflow(retry!, rejection)).toBeNull();
    // The next request fits the stated window by handle, without another rejection.
    const next = await run.context.prepare(request(chat.items));
    expect(elided(next)).toBe(true);
    // A later request the provider rejects again is handled once in its own right.
    expect(await run.context.overflow(next, rejection)).not.toBeNull();
  });

  it("never waits after the answer: a running compaction goes on detached and its run records the item, marker and usage", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const registry = createDetachedCompactions();
    const run = harness(chat.items, { call: () => reply.promise, registry, window: windowAt(chat.items, 0.78) });
    await run.context.prepare(request(chat.items));
    chat.answer("The final answer.");
    // Resolves although the compaction is still running.
    await run.context.afterAnswer();
    expect(run.appended).toEqual([]);
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(TARGET), userId: "user" })).not.toBeNull();
    reply.resolve(summaryReply());
    await vi.waitFor(() => expect(run.appended).toEqual([expect.objectContaining({ kind: "compaction" })]));
    expect(chat.items.at(-1)).toMatchObject({ kind: "compaction" });
    // The stream is closed by then: the marker is recorded with the answer, the late usage written.
    expect(run.statuses).toEqual([]);
    expect(run.recorded).toEqual([expect.objectContaining({ outcome: "summary_applied", state: "complete" })]);
    await vi.waitFor(() => expect(run.settleUsage).toHaveBeenCalledTimes(1));
  });

  it("lets the chat's next run join a compaction still running and swap its item in, without compacting the span again", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const registry = createDetachedCompactions();
    const window = windowAt(chat.items, 0.78);
    const first = harness(chat.items, { call: () => reply.promise, registry, window });
    await first.context.prepare(request(chat.items));
    chat.answer("The first run's answer.");
    await first.context.afterAnswer();
    // The next run reads the same transcript plus its own question, still past the background threshold.
    const items: TranscriptItem[] = [...chat.items, { id: "msg-next", kind: "user", text: "And now?" }];
    const next = harness(items, { call: async () => summaryReply(), registry, runId: "run-2", window });
    const unchanged = await next.context.prepare(request(items));
    expect(firstText(unchanged)).not.toContain(COMPACTION_SUMMARY_HEADING);
    expect(next.calls).toHaveLength(0);
    reply.resolve(summaryReply());
    await vi.waitFor(() => expect(first.appended).toHaveLength(1));
    const swapped = await next.context.prepare(request(items));
    expect(next.calls).toHaveLength(0);
    // The run that started it records it; the next run takes it in memory only, with the same id.
    expect(next.inserted).toEqual(first.appended);
    expect(next.appended).toEqual([]);
    expect(firstText(swapped).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    expect(swapped.history?.at(-1)).toEqual({ text: "And now?", type: "user" });
  });

  it("waits for the joined compaction past the swap threshold instead of starting another", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const registry = createDetachedCompactions();
    const window = windowAt(chat.items, 0.78);
    const first = harness(chat.items, { call: () => reply.promise, registry, window });
    await first.context.prepare(request(chat.items));
    await first.context.afterAnswer();
    const usable = window.contextWindow - window.maxOutputTokens;
    const perChar = estimate("x".repeat(10_000)) / 10_000;
    const items: TranscriptItem[] = [...chat.items, { id: "msg-next", kind: "user", text: `Paste: ${"x".repeat(Math.ceil(usable * 0.12 / perChar))}` }];
    expect(measured(items) / usable).toBeGreaterThan(0.85);
    const next = harness(items, { call: async () => summaryReply(), registry, runId: "run-2", window });
    const waiting = next.context.prepare(request(items));
    setTimeout(() => reply.resolve(summaryReply()), 20);
    const sent = await waiting;
    expect(next.calls).toHaveLength(0);
    expect(next.statuses).toEqual([]);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
  });

  it("drops a detached compaction whose span the next run does not hold (another branch); its own run still records it", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const registry = createDetachedCompactions();
    const window = windowAt(chat.items, 0.78);
    const first = harness(chat.items, { call: () => reply.promise, registry, window });
    await first.context.prepare(request(chat.items));
    await first.context.afterAnswer();
    // Another branch: the earlier answers are not on it, so the cut is not current there.
    const branch = workChat(8, 2_000).items.map((item) => ({ ...item, id: `b-${item.id}` }) as TranscriptItem);
    const other = harness(branch, { call: async () => summaryReply(), registry, runId: "run-2", window });
    await other.context.prepare(request(branch));
    expect(other.calls.length).toBeGreaterThanOrEqual(1);
    reply.resolve(summaryReply());
    await vi.waitFor(() => expect(first.appended).toHaveLength(1));
    await other.context.prepare(request(branch));
    expect(other.inserted).toEqual([]);
  });

  it("swaps in a finished compaction for a run that read the transcript before its item was recorded, and only for that run", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const registry = createDetachedCompactions();
    const window = windowAt(chat.items, 0.78);
    const first = harness(chat.items, { call: () => reply.promise, registry, window });
    await first.context.prepare(request(chat.items));
    await first.context.afterAnswer();
    // This run read the transcript before the item was recorded.
    const early: TranscriptItem[] = [...chat.items, { id: "msg-next", kind: "user", text: "And now?" }];
    reply.resolve(summaryReply());
    await vi.waitFor(() => expect(first.appended).toHaveLength(1));
    await vi.waitFor(() => expect(first.settleUsage).toHaveBeenCalledTimes(1));
    const next = harness(early, { call: async () => summaryReply(), registry, runId: "run-2", window });
    const swapped = await next.context.prepare(request(early));
    expect(next.calls).toHaveLength(0);
    expect(next.inserted).toEqual(first.appended);
    expect(firstText(swapped).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    // A run that read it with the transcript has it already: nothing to swap in, nothing to compact.
    const later: TranscriptItem[] = [...chat.items, { id: "msg-later", kind: "user", text: "And later?" }];
    const loaded = harness(later, { call: async () => summaryReply(), registry, runId: "run-3", window });
    const sent = await loaded.context.prepare(request(later));
    expect(loaded.inserted).toEqual([]);
    expect(loaded.calls).toHaveLength(0);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
  });

  it("does not join a compaction that failed: the next run compacts the span itself", async () => {
    const chat = workChat(8, 2_000);
    const registry = createDetachedCompactions();
    const window = windowAt(chat.items, 0.78);
    const reply = deferred<CompactionModelResult>();
    // The failed compaction's run is still writing its usage, so the registry still lists it.
    const usageWritten = deferred<void>();
    const first = harness(chat.items, { call: () => reply.promise, registry, settleUsage: () => usageWritten.promise, window });
    await first.context.prepare(request(chat.items));
    await first.context.afterAnswer();
    reply.resolve({ text: "not a summary" });
    await vi.waitFor(() => expect(first.settleUsage).toHaveBeenCalledTimes(1));
    expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(TARGET), userId: "user" })).not.toBeNull();
    const items: TranscriptItem[] = [...chat.items, { id: "msg-next", kind: "user", text: "And now?" }];
    const next = harness(items, { call: async () => summaryReply(), registry, runId: "run-2", window });
    await next.context.prepare(request(items));
    expect(next.calls.length).toBeGreaterThanOrEqual(1);
    usageWritten.resolve();
    await vi.waitFor(() => expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(TARGET), userId: "user" })).toBeNull());
    expect(first.appended).toEqual([]);
  });

  it("stops a detached compaction when its chat is deleted or its deadline passes, and records nothing", async () => {
    vi.useFakeTimers();
    const hanging: CompactionModelCall = (call) => new Promise((_, reject) => {
      call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    for (const deleted of [true, false]) {
      const chat = workChat(8, 2_000);
      const registry = createDetachedCompactions();
      let live = true;
      const run = harness(chat.items, { call: hanging, live: async () => live, registry, window: windowAt(chat.items, 0.78) });
      await run.context.prepare(request(chat.items));
      await run.context.afterAnswer();
      if (deleted) {
        live = false;
        await vi.advanceTimersByTimeAsync(DETACHED_COMPACTION.liveCheckMs + 1);
      } else {
        await vi.advanceTimersByTimeAsync(DETACHED_COMPACTION.deadlineMs + 1);
      }
      await vi.waitFor(() => expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(TARGET), userId: "user" })).toBeNull());
      expect(run.appended).toEqual([]);
      expect(run.recorded).toEqual([]);
    }
  });

  it("records nothing when the chat is deleted after the compaction finished, though it looked alive just before", async () => {
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    const registry = createDetachedCompactions();
    // The liveness check still passes; the deletion fence lands before the write, which refuses under the chat lock.
    const run = harness(chat.items, { call: () => reply.promise, live: async () => true, registry, window: windowAt(chat.items, 0.78),
      write: async () => false });
    await run.context.prepare(request(chat.items));
    await run.context.afterAnswer();
    reply.resolve(summaryReply());
    await vi.waitFor(() => expect(run.write).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(TARGET), userId: "user" })).toBeNull());
    expect(run.appended).toEqual([]);
    expect(run.inserted).toEqual([]);
    expect(run.recorded).toEqual([]);
    // The calls it made are paid: their usage is still written.
    expect(run.settleUsage).toHaveBeenCalledTimes(1);
  });

  it("writes a finished compaction once more after a failed write, and gives it up after a second failure", async () => {
    for (const failures of [1, 2]) {
      const chat = workChat(8, 2_000);
      const reply = deferred<CompactionModelResult>();
      const registry = createDetachedCompactions();
      let attempts = 0;
      const run = harness(chat.items, { call: () => reply.promise, registry, window: windowAt(chat.items, 0.78),
        write: async () => {
          attempts += 1;
          if (attempts <= failures) throw new Error("connection reset");
          return true;
        } });
      await run.context.prepare(request(chat.items));
      await run.context.afterAnswer();
      reply.resolve(summaryReply());
      await vi.waitFor(() => expect(run.settleUsage).toHaveBeenCalledTimes(1));
      expect(run.write).toHaveBeenCalledTimes(2);
      expect(run.appended).toHaveLength(failures === 1 ? 1 : 0);
      // Only a recorded compaction stays listed for the chat's next run.
      expect(registry.find({ chatId: "chat", targetKey: transcriptTargetKey(TARGET), userId: "user" }) !== null).toBe(failures === 1);
    }
  });

  it("stops waiting for a joined compaction past the bound and compacts on its own, leaving the other run's compaction running", async () => {
    vi.useFakeTimers();
    const chat = workChat(8, 2_000);
    const reply = deferred<CompactionModelResult>();
    let ownerStopped = false;
    const registry = createDetachedCompactions();
    const window = windowAt(chat.items, 0.78);
    const first = harness(chat.items, { call: (call) => {
      call.signal.addEventListener("abort", () => { ownerStopped = true; }, { once: true });
      return reply.promise;
    }, registry, window });
    await first.context.prepare(request(chat.items));
    await first.context.afterAnswer();
    const usable = window.contextWindow - window.maxOutputTokens;
    const perChar = estimate("x".repeat(10_000)) / 10_000;
    const items: TranscriptItem[] = [...chat.items, { id: "msg-next", kind: "user", text: `Paste: ${"x".repeat(Math.ceil(usable * 0.12 / perChar))}` }];
    const next = harness(items, { call: async () => summaryReply(), registry, runId: "run-2", window });
    const waiting = next.context.prepare(request(items));
    await vi.advanceTimersByTimeAsync(COMPACTION_LIFECYCLE.urgentWaitMs + 1);
    const sent = await waiting;
    expect(next.calls.length).toBeGreaterThanOrEqual(1);
    expect(next.statuses.map((status) => status.state)).toEqual(["running", "complete"]);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    expect(ownerStopped).toBe(false);
    // The run that started it still records it when it finishes.
    reply.resolve(summaryReply());
    await vi.waitFor(() => expect(first.appended).toHaveLength(1));
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

  it("reserves only a share of a small window for the output: a fresh chat runs, a long one compacts", async () => {
    // A 40k window with a 65,536-token maximum output left no room for any request.
    const small = { contextWindow: 40_000, maxOutputTokens: 65_536 };
    const fresh = transcriptBuilder();
    fresh.user("What is the capital of France?");
    const first = harness(fresh.items, { call: async () => summaryReply(), window: small });
    await expect(first.context.prepare(request(fresh.items))).resolves.toBeDefined();
    expect(first.calls).toHaveLength(0);

    // A quarter of the window stays reserved: 30,000 tokens are usable.
    const chat = transcriptBuilder();
    for (let turn = 1; measured(chat.items) < 28_000; turn += 1) {
      chat.user(`question ${turn}: ${"q".repeat(200)}`);
      chat.tool("lookup", { turn }, `result ${turn} ${"r".repeat(2_000)}`);
      chat.answer(`answer ${turn} ${"a".repeat(300)}`);
    }
    expect(measured(chat.items)).toBeLessThan(30_000);
    const long = harness(chat.items, { call: async () => summaryReply(), window: small });
    const sent = await long.context.prepare(request(chat.items));
    expect(long.calls.length).toBeGreaterThanOrEqual(1);
    expect(firstText(sent).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
  });

  it("measures nothing without a window", async () => {
    const chat = workChat(8, 2_000);
    const run = harness(chat.items, { call: async () => summaryReply(), window: null });
    const sent = request(chat.items);
    expect(await run.context.prepare(sent)).toBe(sent);
    expect(run.calls).toHaveLength(0);
  });
});
