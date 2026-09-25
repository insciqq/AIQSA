import { describe, expect, it, vi } from "vitest";
import { makeContextCompactionStatus, type ContextCompactionStatus, type ContextPlanMeasurement, type ContextSummary } from "../../contracts/contextCompaction";
import type { ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import { ObservationStoreError } from "../toolObservations/contract";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import { conversationContextPolicy, type ContextObservation } from "./contextCompactionContract";
import { contextObservationsFromResults } from "./contextCompactionPlanner";
import { applyKnowledgeAnswerContextBudget, observationSourceAvailability, prepareCompactedProviderRequest } from "./contextCompactionConsumer";
import { contextCompactionFailureOutcome, createContextCompactionPublisher } from "./contextCompactionEvents";
import { contextSummarySourceRevision, type ContextSummaryReceipts } from "./contextCompactionSummarizer";

const measured = (beforeTokens: number, afterTokens: number): ContextPlanMeasurement => ({
  afterTokens, beforeTokens, budgetTokens: 1_000, legacyFallback: false,
  maskedBatches: 0, maskedObservations: 0, outcome: "needs_summary", version: 1
});

const bridge = openAIResponsesToolBridge;

function text(value: string, id: string, role: "assistant" | "user" = "user"): ProviderConversationMessage {
  return { content: { blocks: [{ text: value, type: "text" }] }, id, role };
}

/** Budget: 4,000 window - 400 output - 400 margin = 3,200 estimated tokens. */
function hybridRequest(input: Readonly<{
  history?: number;
  current?: number;
  recent?: readonly ProviderConversationMessage[];
  providerToolMessages?: unknown[];
  summary?: ContextSummary;
  stale?: ContextPlanMeasurement["outcome"];
}> = {}): ProviderRunRequest {
  const messages = [
    text(`Old synthetic fact. ${"o".repeat((input.history ?? 0) * 4)}`, "old"),
    ...(input.summary ? [text(`Model-derived context notes:\n${input.summary.notes}`, `__context-summary-${input.summary.id}`, "assistant")] : []),
    ...(input.recent ?? Array.from({ length: 4 }, (_, index) => text("Acknowledged.", `recent-${index}`, index % 2 ? "user" : "assistant"))),
    text(`Current question. ${"c".repeat((input.current ?? 0) * 4)}`, "current")
  ];
  return {
    attachmentIds: [], attachments: [], chatId: "chat-1",
    content: messages.at(-1)!.content,
    context: { messages, mode: "branch_path" },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "current", messages, mode: "hybrid" }),
    ...(input.stale ? { contextCompaction: { ...measured(10, 10), outcome: input.stale } } : {}),
    ...(input.summary ? { contextCompactionSummary: input.summary } : {}),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 4_000, defaultMaxOutputTokens: 400, nativePdfInput: false,
      nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
    modelId: "synthetic", params: {}, prompt: { developer: null, system: "Accepted system" }, provider: "openai",
    providerToolMessages: input.providerToolMessages ?? [],
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto", toolObservationVersion: 1, tools: [readToolResultTool]
  };
}

function observedResult(callId: string, seed: string, chars: number) {
  return projectObservationForProvider({
    callId,
    content: [{ text: `${callId}-${"x".repeat(chars)}`, type: "text" }],
    name: "read_record",
    observation: { byteSize: chars, checksum: seed.repeat(64), encoding: "json-utf8-v1", handle: `tor1_${seed.repeat(32)}`,
      maskable: true, source: "mcp", sourceTruncated: false, version: 1 },
    status: "complete"
  });
}

function observationBatch(callId: string, seed: string, chars: number): unknown[] {
  return [
    { arguments: "{}", call_id: callId, name: "read_record", type: "function_call" },
    bridge.appendToolResult(undefined, observedResult(callId, seed, chars))
  ];
}

type Summarize = (request: ProviderRunRequest) => AsyncGenerator<{ type: "token"; data: { delta: string } }, string>;

function consumer(request: ProviderRunRequest, options: Readonly<{
  initial?: ContextCompactionStatus;
  observations?: readonly ContextObservation[];
  output?: string | ((request: ProviderRunRequest) => string);
  summarize?: Summarize;
  signal?: AbortSignal;
  sourceAvailable?: (handles: readonly string[]) => Promise<boolean>;
}> = {}) {
  const events: ContextCompactionStatus[] = [];
  const summaryRequests: ProviderRunRequest[] = [];
  const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
    summaryRequests.push(next);
    // Cites "old" only where the envelope carries it, as the contract requires.
    const cited = JSON.stringify(next.content).includes('id=\\"old\\"') ? ["old"] : [];
    const configured = typeof options.output === "function" ? options.output(next) : options.output;
    const output = options.summarize ? yield* options.summarize(next)
      : configured ?? JSON.stringify({ notes: "The old fact remains binding.", sourceRefs: cited });
    if (!options.summarize) yield { type: "token", data: { delta: output } };
    return { finalProviderResponsePreview: {}, finalText: output, usage: { inputTokens: 5, outputTokens: 2 } };
  } };
  const settle = vi.fn<ContextSummaryReceipts["settle"]>(async () => undefined);
  const claim = vi.fn<ContextSummaryReceipts["claim"]>(async () => undefined);
  const onTruncation = vi.fn();
  const run = () => prepareCompactedProviderRequest({
    bridge,
    failure: (code, message) => Object.assign(new Error(message), { code }),
    ...(options.observations ? { observations: options.observations } : {}),
    onTruncation,
    publisher: createContextCompactionPublisher(async status => { events.push(status); }, options.initial),
    receipts: { claim, settle },
    request,
    signal: options.signal ?? new AbortController().signal,
    ...(options.sourceAvailable ? { sourceAvailable: options.sourceAvailable } : {}),
    summaryAdapter: adapter
  });
  return { claim, events, onTruncation, run, settle, summaryRequests };
}

async function failureOf(promise: Promise<unknown>): Promise<{ code?: string }> {
  return promise.then(() => { throw new Error("expected a failure"); }, (error: { code?: string }) => error);
}

describe("single compaction consumer", () => {
  it("buys a summary from the request's own measurement despite a carried already_fits", async () => {
    const compaction = consumer(hybridRequest({ history: 3_400, stale: "already_fits" }));
    const prepared = await compaction.run();
    // The history exceeds one summary call on this window: bounded parts and a reduction.
    expect(compaction.summaryRequests.length).toBeGreaterThan(1);
    expect(compaction.claim).toHaveBeenCalledTimes(compaction.summaryRequests.length);
    expect(compaction.settle).toHaveBeenCalledTimes(compaction.summaryRequests.length);
    expect(compaction.settle).toHaveBeenLastCalledWith(expect.objectContaining({ state: "committed" }),
      expect.objectContaining({ inputTokens: 5, outputTokens: 2 }), prepared.contextCompactionSummary);
    expect(prepared.contextCompactionSummary?.notes).toContain("old fact");
    expect(JSON.stringify(prepared.context)).not.toContain("o".repeat(64));
    expect(prepared.contextCompaction?.outcome).not.toBe("needs_summary");
    expect(prepared.contextCompaction!.afterTokens).toBeLessThanOrEqual(prepared.contextCompaction!.budgetTokens!);
    expect(compaction.events.map(({ cycle, outcome, state }) => [cycle, state, outcome])).toEqual([
      [1, "running", "pending"], [1, "complete", "summary_applied"]
    ]);
    expect(compaction.events[0]!.beforeTokens).toBeGreaterThan(3_200);
    expect(compaction.events[1]).toMatchObject({ afterTokens: prepared.contextCompaction!.afterTokens });
  });

  it("does not buy for a carried needs_summary when this request fits", async () => {
    const compaction = consumer(hybridRequest({ history: 100, stale: "needs_summary" }));
    const prepared = await compaction.run();
    expect(compaction.summaryRequests).toHaveLength(0);
    expect(compaction.claim).not.toHaveBeenCalled();
    expect(compaction.events).toEqual([]);
    expect(prepared.contextCompaction?.outcome).toBe("already_fits");
  });

  it("reports masking in its own round with its numbers even when a summary is carried", async () => {
    const summary: ContextSummary = { formatVersion: 1, id: "cs1_carried", notes: "Carried notes.",
      sourceDigest: "d".repeat(64), sourceRefs: ["old"] };
    const compaction = consumer(hybridRequest({ summary, stale: "needs_summary", providerToolMessages: [
      ...observationBatch("older", "a", 8_000), ...observationBatch("newest", "b", 1_200)
    ] }), { observations: contextObservationsFromResults([observedResult("older", "a", 8_000), observedResult("newest", "b", 1_200)]) });
    const prepared = await compaction.run();
    expect(compaction.summaryRequests).toHaveLength(0);
    expect(prepared.contextCompaction).toMatchObject({ outcome: "masking_applied", maskedObservations: 1 });
    expect(JSON.stringify(prepared.providerToolMessages)).not.toContain("x".repeat(2_000));
    expect(compaction.events).toEqual([expect.objectContaining({
      afterTokens: prepared.contextCompaction!.afterTokens,
      beforeTokens: prepared.contextCompaction!.beforeTokens,
      cycle: 1, outcome: "masking_applied", state: "complete"
    })]);
  });

  it("fails a committed summary that cannot fit without buying again or trimming", async () => {
    const summary: ContextSummary = { formatVersion: 1, id: "cs1_committed", notes: "Committed notes.",
      sourceDigest: "d".repeat(64), sourceRefs: [] };
    const request = hybridRequest({ summary, current: 3_600 });
    const current = { ...summary, sourceRefs: [contextSummarySourceRevision(request)] };
    const compaction = consumer({ ...request, contextCompactionSummary: current });
    await expect(compaction.run()).rejects.toMatchObject({ code: "context_too_large" });
    expect(compaction.summaryRequests).toHaveLength(0);
    expect(compaction.events).toEqual([]);
  });

  it.each([true, false])("settles a cycle a lost executor left running (checkpoint summary %s)", async withSummary => {
    const summary: ContextSummary = { formatVersion: 1, id: "cs1_checkpoint", notes: "Checkpoint notes.",
      sourceDigest: "d".repeat(64), sourceRefs: ["old"] };
    const running = makeContextCompactionStatus({ beforeTokens: 3_500, cycle: 2, outcome: "pending", state: "running" });
    const compaction = consumer(hybridRequest(withSummary ? { summary } : {}), { initial: running });
    await compaction.run();
    expect(compaction.summaryRequests).toHaveLength(0);
    expect(compaction.events).toEqual([expect.objectContaining(withSummary
      ? { cycle: 2, outcome: "summary_applied", state: "complete", beforeTokens: 3_500 }
      : { cycle: 2, outcome: "unknown", state: "failed" })]);
  });

  it("summarizes a large recent turn instead of keeping it verbatim in the tail", async () => {
    // Four recent messages, one of them 1,500 tokens: a fixed four-message
    // tail would keep it; the token-bounded tail summarizes it instead.
    const recent = [text("Acknowledged.", "recent-0", "assistant"), text(`LARGE_RECENT ${"r".repeat(6_000)}`, "recent-1"),
      text("Acknowledged.", "recent-2", "assistant"), text("Fine.", "recent-3")];
    const compaction = consumer(hybridRequest({ history: 1_600, recent }));
    const prepared = await compaction.run();
    expect(JSON.stringify(compaction.summaryRequests.map(request => request.content))).toContain("LARGE_RECENT");
    expect(JSON.stringify(prepared.context)).not.toContain("LARGE_RECENT");
    expect(prepared.context?.messages.map(message => message.id).slice(1)).toEqual(["recent-2", "recent-3", "current"]);
    expect(prepared.contextCompaction).toMatchObject({ legacyFallback: false });
    expect(prepared.contextCompaction!.afterTokens).toBeLessThanOrEqual(3_200);
  });

  it("keeps the newest span of an over-long history and reports the older turns as truncation", async () => {
    const recent = Array.from({ length: 60 }, (_, index) =>
      text(`TURN_${index} ${"t".repeat(2_000)}`, `turn-${index}`, index % 2 ? "assistant" : "user"));
    const compaction = consumer(hybridRequest({ recent }));
    const prepared = await compaction.run();
    expect(compaction.summaryRequests.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(compaction.summaryRequests.map(request => request.content))).not.toContain('id=\\"old\\"');
    const truncation = prepared.context?.summary?.truncation;
    expect(truncation?.droppedMessages).toBeGreaterThan(0);
    expect(compaction.onTruncation).toHaveBeenCalledWith(truncation);
    expect(prepared.contextCompaction).toMatchObject({ legacyFallback: true });
    expect(prepared.contextCompaction!.afterTokens).toBeLessThanOrEqual(3_200);
    expect(prepared.contextCompactionSummary?.sourceRefs).not.toContain("old");
    expect(compaction.events.map(({ outcome, state }) => [state, outcome])).toEqual([
      ["running", "pending"], ["complete", "summary_applied"]
    ]);
  });

  it("refuses an uncoverable newest span as irreducible overflow without a paid call", async () => {
    // A summary window much smaller than the answer window: the current input
    // alone needs more calls than a plan may use.
    const request = { ...hybridRequest({ history: 3_000, current: 2_500 }),
      generationBudget: { version: 1 as const, contextWindow: 1_000, maxOutputTokens: 256, timeoutMs: 30_000 } };
    const compaction = consumer(request);
    const failure = await failureOf(compaction.run());
    expect(failure.code).toBe("context_too_large");
    expect(compaction.events.at(-1)?.outcome).toBe("irreducible_overflow");
    expect(compaction.summaryRequests).toHaveLength(0);
    expect(compaction.claim).not.toHaveBeenCalled();
  });

  describe("failure classes publish the run's own code", () => {
    const published = (events: readonly ContextCompactionStatus[]) => events.at(-1)?.outcome;

    it("provider 5xx during the summary is provider_failed", async () => {
      const compaction = consumer(hybridRequest({ history: 3_400 }), {
        summarize: async function* () { throw Object.assign(new Error("upstream"), { status: 503 }); }
      });
      const failure = await failureOf(compaction.run());
      expect(failure.code).toBe("context_compaction_provider_failed");
      expect(published(compaction.events)).toBe("provider_failed");
      expect(contextCompactionFailureOutcome(failure.code!)).toBe(published(compaction.events));
      // Nothing was reported before the failure: its usage stays unknown.
      expect(compaction.settle).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }),
        expect.objectContaining({ completeness: "unavailable", inputTokens: null }), undefined);
    });

    it("a removed original is source_unavailable without a paid call", async () => {
      const settled = [observedResult("older", "a", 8_000), observedResult("newest", "b", 1_200)];
      const compaction = consumer(hybridRequest({ history: 3_400, providerToolMessages: [
        ...observationBatch("older", "a", 8_000), ...observationBatch("newest", "b", 1_200)
      ] }), { observations: contextObservationsFromResults(settled), sourceAvailable: async () => false });
      const failure = await failureOf(compaction.run());
      expect(failure.code).toBe("context_compaction_source_unavailable");
      expect(published(compaction.events)).toBe("source_unavailable");
      expect(compaction.summaryRequests).toHaveLength(0);
    });

    it("notes that do not lower the estimate are no_progress", async () => {
      // A request that fits above the trigger, whose older history is barely
      // above the release floor; non-ASCII notes within their byte bound cost
      // more estimated tokens than the history they replace.
      const compaction = consumer(hybridRequest({ history: 340, current: 2_300 }), {
        output: JSON.stringify({ notes: "ж".repeat(500), sourceRefs: [] })
      });
      const failure = await failureOf(compaction.run());
      expect(compaction.summaryRequests).toHaveLength(1);
      expect(failure.code).toBe("context_compaction_summary_no_progress");
      expect(published(compaction.events)).toBe("summary_failed");
      expect(contextCompactionFailureOutcome(failure.code!)).toBe(published(compaction.events));
    });

    it("overflow after the summary is irreducible_overflow with context_too_large", async () => {
      const compaction = consumer(hybridRequest({ history: 3_000, current: 2_900 }), {
        // Short part notes; a final note that no longer fits beside the minimum.
        output: next => JSON.stringify({ notes: next.prompt.system!.includes("notes of consecutive parts") ? "n".repeat(1_000) : "part",
          sourceRefs: [] })
      });
      const failure = await failureOf(compaction.run());
      expect(compaction.summaryRequests.length).toBeGreaterThan(0);
      expect(failure.code).toBe("context_too_large");
      expect(published(compaction.events)).toBe("irreducible_overflow");
      expect(contextCompactionFailureOutcome(failure.code!)).toBe(published(compaction.events));
    });

    it("Stop during the summary leaves the cycle for the run's cancellation", async () => {
      const controller = new AbortController();
      const compaction = consumer(hybridRequest({ history: 3_400 }), {
        signal: controller.signal,
        summarize: async function* () { controller.abort(); throw new DOMException("aborted", "AbortError"); }
      });
      await expect(compaction.run()).rejects.toMatchObject({ name: "AbortError" });
      expect(compaction.events.map(({ state }) => state)).toEqual(["running"]);
      expect(compaction.settle).toHaveBeenCalledWith(expect.objectContaining({ state: "unknown" }), expect.anything(), undefined);
    });
  });

  it("keeps Knowledge answers on the legacy guard: trims prior turns and never needs a summary", () => {
    const request = hybridRequest({ history: 3_400 });
    const legacy = applyKnowledgeAnswerContextBudget({ bridge, request });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.request.contextCompactionPolicy).toBeUndefined();
    expect(legacy.request.context?.messages.some(message => message.id === "old")).toBe(false);
    expect(legacy.request.context?.messages.at(-1)?.id).toBe("current");
    expect(legacy.contextTruncation).not.toBeNull();
  });
});

describe("observation source availability", () => {
  it("reads each handle with a bounded authorized read; busy stays available, other refusals are unavailable", async () => {
    const read = vi.fn(async (_actor: unknown, value: { handle: string }) => {
      if (value.handle.endsWith("b")) throw new ObservationStoreError("tool_observation_busy");
      if (value.handle.endsWith("c")) throw new ObservationStoreError("tool_observation_unavailable");
      return {};
    });
    const available = observationSourceAvailability(async () => ({ read } as never), { runId: "run-1", userId: "user-1" });
    await expect(available([`tor1_${"a".repeat(32)}`, `tor1_${"b".repeat(32)}`])).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith({ runId: "run-1", userId: "user-1" }, { handle: `tor1_${"a".repeat(32)}`, maxBytes: 4 }, undefined);
    await expect(available([`tor1_${"c".repeat(32)}`])).resolves.toBe(false);
  });
});
