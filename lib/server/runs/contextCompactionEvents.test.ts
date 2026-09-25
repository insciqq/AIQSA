import { describe, expect, it, vi } from "vitest";
import { makeContextCompactionStatus, mergeContextCompactionStatus, type ContextCompactionStatus, type ContextPlanMeasurement, type ContextSummary } from "../../contracts/contextCompaction";
import type { ProviderAdapter, ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import { openAIResponsesToolBridge } from "../tools/bridges";
import { readToolResultTool } from "../tools/readToolResult";
import { projectObservationForProvider } from "../toolObservations/projection";
import { conversationContextPolicy } from "./contextCompactionContract";
import { applyKnowledgeAnswerContextBudget, createContextCompactionPublisher, prepareCompactedProviderRequest } from "./contextCompactionEvents";
import { contextSummarySourceRevision } from "./contextCompactionSummarizer";

const measured = (beforeTokens: number, afterTokens: number): ContextPlanMeasurement => ({
  afterTokens, beforeTokens, budgetTokens: 1_000, legacyFallback: false,
  maskedBatches: 0, maskedObservations: 0, outcome: "needs_summary", version: 1
});

describe("durable compaction status", () => {
  it("uses the actual post-compaction estimate and permits another server cycle", async () => {
    const events: ContextCompactionStatus[] = [];
    const publisher = createContextCompactionPublisher(async status => { events.push(status); });
    await publisher.begin(measured(1_500, 1_500));
    await publisher.settle("summary_applied", measured(600, 600));
    await publisher.begin(measured(1_200, 1_100));
    await publisher.settle("provider_failed");
    expect(events.map(({ cycle, state }) => [cycle, state])).toEqual([
      [1, "running"], [1, "complete"], [2, "running"], [2, "failed"]
    ]);
    expect(events[1]).toMatchObject({ beforeTokens: 1_500, afterTokens: 600, reducedTokens: 900 });
    expect(events[3]).toMatchObject({ afterTokens: null, reducedTokens: null });
    let projected: ContextCompactionStatus | null = null;
    for (const status of [...events, events[0]!, events[2]!]) projected = mergeContextCompactionStatus(projected, status);
    expect(projected).toEqual(events[3]);
  });

  it("resumes an interrupted cycle and advances after a persisted completed one", async () => {
    const events: ContextCompactionStatus[] = [];
    const pending = makeContextCompactionStatus({ beforeTokens: 1_500, cycle: 3, outcome: "pending", state: "running" });
    const publisher = createContextCompactionPublisher(async status => { events.push(status); }, pending);
    await publisher.begin(measured(1_500, 1_500));
    await publisher.settle("summary_applied", measured(600, 600));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cycle: 3, reducedTokens: 900, state: "complete" });
    const recovered = createContextCompactionPublisher(async status => { events.push(status); }, events[0]);
    await recovered.begin(measured(1_300, 1_300));
    expect(events[1]).toMatchObject({ cycle: 4, state: "running" });
  });

  it("fails an unfinished cycle once at Stop or terminal settlement and never starts another", async () => {
    const events: ContextCompactionStatus[] = [];
    const publisher = createContextCompactionPublisher(async status => { events.push(status); });
    await publisher.begin(measured(1_500, 1_500));
    await publisher.terminate("summary_applied");
    await publisher.begin(measured(1_500, 1_500));
    await publisher.settle("masking_applied", measured(900, 700));
    await publisher.terminate("provider_failed");
    expect(events.map(({ cycle, outcome, state }) => [cycle, state, outcome])).toEqual([
      [1, "running", "pending"], [1, "failed", "unknown"]
    ]);
    expect(publisher.running).toBe(false);
  });
});

const bridge = openAIResponsesToolBridge;

function text(value: string, id: string, role: "assistant" | "user" = "user"): ProviderConversationMessage {
  return { content: { blocks: [{ text: value, type: "text" }] }, id, role };
}

/** Budget: 4,000 window - 400 output - 400 margin = 3,200 estimated tokens. */
function hybridRequest(input: Readonly<{
  history?: number;
  current?: number;
  providerToolMessages?: unknown[];
  summary?: ContextSummary;
  stale?: ContextPlanMeasurement["outcome"];
}> = {}): ProviderRunRequest {
  const messages = [
    text(`Old synthetic fact. ${"o".repeat((input.history ?? 0) * 4)}`, "old"),
    ...(input.summary ? [text(`Model-derived context notes:\n${input.summary.notes}`, `__context-summary-${input.summary.id}`, "assistant")] : []),
    ...Array.from({ length: 4 }, (_, index) => text("Acknowledged.", `recent-${index}`, index % 2 ? "user" : "assistant")),
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

function observationBatch(callId: string, seed: string, chars: number): unknown[] {
  return [
    { arguments: "{}", call_id: callId, name: "read_record", type: "function_call" },
    bridge.appendToolResult(undefined, projectObservationForProvider({
      callId,
      content: [{ text: `${callId}-${"x".repeat(chars)}`, type: "text" }],
      name: "read_record",
      observation: { byteSize: chars, checksum: seed.repeat(64), encoding: "json-utf8-v1", handle: `tor1_${seed.repeat(32)}`,
        maskable: true, source: "mcp", sourceTruncated: false, version: 1 },
      status: "complete"
    }))
  ];
}

function consumer(request: ProviderRunRequest, initial?: ContextCompactionStatus) {
  const events: ContextCompactionStatus[] = [];
  const summaryRequests: ProviderRunRequest[] = [];
  const adapter: Pick<ProviderAdapter, "stream"> = { async *stream(next) {
    summaryRequests.push(next);
    const output = JSON.stringify({ notes: "The old fact remains binding.", sourceRefs: ["old"] });
    yield { type: "token", data: { delta: output } };
    return { finalProviderResponsePreview: {}, finalText: output, usage: { inputTokens: 5, outputTokens: 2 } };
  } };
  const onSummaryUsage = vi.fn();
  const run = () => prepareCompactedProviderRequest({
    bridge,
    failure: (code, message) => Object.assign(new Error(message), { code }),
    onSummaryUsage,
    publisher: createContextCompactionPublisher(async status => { events.push(status); }, initial),
    request,
    signal: new AbortController().signal,
    summaryAdapter: adapter
  });
  return { events, onSummaryUsage, run, summaryRequests };
}

describe("single compaction consumer", () => {
  it("buys a summary from the request's own measurement despite a carried already_fits", async () => {
    const compaction = consumer(hybridRequest({ history: 3_400, stale: "already_fits" }));
    const prepared = await compaction.run();
    expect(compaction.summaryRequests).toHaveLength(1);
    expect(compaction.onSummaryUsage).toHaveBeenCalledOnce();
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
    expect(compaction.events).toEqual([]);
    expect(prepared.contextCompaction?.outcome).toBe("already_fits");
  });

  it("reports masking in its own round with its numbers even when a summary is carried", async () => {
    const summary: ContextSummary = { formatVersion: 1, id: "cs1_carried", notes: "Carried notes.",
      sourceDigest: "d".repeat(64), sourceRefs: ["old"] };
    const compaction = consumer(hybridRequest({ summary, stale: "needs_summary", providerToolMessages: [
      ...observationBatch("older", "a", 8_000), ...observationBatch("newest", "b", 1_200)
    ] }));
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
    const compaction = consumer(hybridRequest(withSummary ? { summary } : {}), running);
    await compaction.run();
    expect(compaction.summaryRequests).toHaveLength(0);
    expect(compaction.events).toEqual([expect.objectContaining(withSummary
      ? { cycle: 2, outcome: "summary_applied", state: "complete", beforeTokens: 3_500 }
      : { cycle: 2, outcome: "unknown", state: "failed" })]);
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
