import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeSessionContextStatus, type SessionContextStatus } from "../../contracts/sessionStatus";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { PROVIDER_CONTEXT_LENGTH_EXCEEDED } from "../providers/responseFailure";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { SUMMARIZER_INSTRUCTIONS, SUMMARY_SECTIONS } from "./compaction/summaryPrompt";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { NativeRunStore } from "./runStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import { COMPACTION_SUMMARY_HEADING, type TranscriptItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";

/**
 * The native run with compaction in its loop: background compaction while
 * the turn works, its item swapped in at the next request boundary or kept
 * after the answer, the quiet marker, and the size rejection compacted and
 * sent once more.
 */
const SUMMARY = SUMMARY_SECTIONS.map((section) => `## ${section}\n- ${section} facts`).join("\n\n");
const ORIGIN = { model: "fake-qsa", provider: "connection-1" };

type AnswerStep = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: unknown; text?: string }>;

const isSummary = (request: ProviderRunRequest) => request.prompt.system === SUMMARIZER_INSTRUCTIONS;

/** Answers from `steps` in order; summary requests get the summary after `summaryDelayMs`. */
function scriptedAdapter(steps: readonly AnswerStep[], summaryDelayMs = 0) {
  const answers: ProviderRunRequest[] = [];
  const summaries: ProviderRunRequest[] = [];
  const order: string[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      if (isSummary(request)) {
        summaries.push(request);
        order.push("summary");
        if (summaryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, summaryDelayMs));
        return { finalProviderResponsePreview: {}, finalText: SUMMARY, history: [{ text: SUMMARY, type: "assistant_text" }],
          usage: { inputTokens: 2_000, outputTokens: 200 } };
      }
      answers.push(request);
      order.push("answer");
      const step = steps[Math.min(answers.length - 1, steps.length - 1)]!;
      if (step.fail) throw step.fail;
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, answers, order, summaries };
}

/** An earlier native answer of many tool rounds, about `tokens` of context. */
function earlierWork(tokens: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let total = 0;
  for (let round = 1; total < tokens; round += 1) {
    const callId = `call-${round}`;
    const output = `result ${round}: ${"r".repeat(4_000)}`;
    items.push({ arguments: JSON.stringify({ round }), callId, id: `n-call-${round}`, kind: "tool_call", name: "lookup", origin: ORIGIN },
      { callId, id: `n-result-${round}`, kind: "tool_result", name: "lookup", outcome: "complete", output },
      { id: `n-text-${round}`, kind: "assistant_text", origin: ORIGIN, text: `Round ${round} done. ${"a".repeat(200)}` });
    total += estimateApproxTokens(output) + estimateApproxTokens("a".repeat(220)) + 30;
  }
  return items;
}

function memoryEngine(earlier: readonly TranscriptItem[]) {
  const transcriptRows: TranscriptItem[] = [];
  const rows = new Map<string, ToolCallRow>();
  const transcripts = {
    append: vi.fn(async (_scope, _from, items: readonly TranscriptItem[]) => { transcriptRows.push(...items); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async () => new Map([["run-0", [...earlier]]])),
    nativeRunsForAnswers: vi.fn(async () => new Map([["answer-0", "run-0"]])),
    nextSequence: vi.fn(async () => transcriptRows.length),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
        providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: "now", state: "running",
        toolName: input.toolName };
      rows.set(row.id, row);
      return { kind: "running", row };
    }),
    refuse: vi.fn(async () => null),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  let published: string | null = null;
  const runs = {
    workDurationMs: vi.fn(async () => null as number | null),
    applyUsageTotals: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { published = input.text; return true; }),
    // The item and its marker in one write, at the sequence the run's writer reserved.
    recordDetachedCompaction: vi.fn(async (_scope, input: { item: TranscriptItem; sequence: number }) => {
      transcriptRows.push(input.item);
      return true;
    }),
    saveStoppedText: vi.fn(async () => true),
    writeUsageRows: vi.fn(async () => undefined)
  } satisfies NativeRunStore;
  const engine: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never), runs,
    // A slow reader: the tool round takes a moment, as real tools do.
    savedResults: { read: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return null; }) },
    toolCalls, transcripts
  };
  return { engine, published: () => published, runs, transcriptRows };
}

function repository() {
  return {
    appendAssistantText: vi.fn(async () => undefined),
    appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async () => true),
    getChatUpdateForRun: vi.fn(async () => null),
    getRunControlForUser: vi.fn(async () => ({ status: "streaming" })),
    loadModelPricing: vi.fn(async () => null),
    loadProviderModelCostBasis: vi.fn(async () => null),
    loadRunMcpApprovalCards: vi.fn(async () => []),
    markRunAnswerStarted: vi.fn(async () => undefined)
  };
}

/** Each test its own chat: compactions that outlive their run are listed per chat, process-wide. */
function prepared(contextWindow: number, chatId = `chat-${randomUUID()}`, defaultMaxOutputTokens = 1_000): MaterializedPreparedRunData {
  const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });
  const request = {
    attachmentIds: [], attachments: [], chatId, content: text("Next step, please."),
    context: { messages: [
      { content: text("Run the reconciliation round by round."), id: "user-0", role: "user" as const },
      { content: { blocks: [] }, id: "answer-0", role: "assistant" as const },
      { content: text("Next step, please."), id: "current-user-message", role: "user" as const }
    ], mode: "branch_path" as const },
    knowledgePlan: { baseIds: [], mode: "none" as const, sourceIds: [], version: 1 as const },
    modelCapabilities: { contextWindow, defaultMaxOutputTokens, nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: "Be brief." }, provider: "fake",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const
  } as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [],
    normalizedRequest: request, providerAdmissionPlan: { answer: { snapshot: { connection: { responseTimeoutMs: 60_000 },
      connectionId: "connection-1", model: { adapterKind: "fake" }, providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

async function events(response: Response): Promise<ModelRunSseEvent[]> {
  const text = await response.text();
  return text.split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };
const CONTEXT_TOKENS = 30_000;
/** A window whose usable part puts the conversation at about `share` of it (the instructions and tools add a little). */
const windowFor = (share: number) => Math.ceil((CONTEXT_TOKENS + 600) / share) + 1_000;

function compactionStatuses(result: readonly ModelRunSseEvent[]) {
  return result.flatMap((event) => event.type === "artifact" && event.data.artifactType === "context_compaction"
    ? [event.data.payload as { outcome: string; state: string }] : []);
}

const firstText = (request: ProviderRunRequest) => {
  const first = request.history?.[0];
  return first?.type === "user" ? first.text : "";
};

describe("native run compaction", () => {
  it("asks a small window for no more output than its reserve, so input and output together fit it", async () => {
    for (const [window, expected] of [[40_000, 10_000], [200_000, undefined]] as const) {
      const scripted = scriptedAdapter([{ text: "Paris." }]);
      const memory = memoryEngine([]);
      await events(createNativeRunExecutionResponse({ adapter: scripted.adapter, created, engine: memory.engine,
        prepared: prepared(window, undefined, 65_536), repository: repository() as unknown as RunRepository, services: {},
        userId: "user" }));
      expect(memory.published()).toBe("Paris.");
      // A large window keeps the configured output: nothing is added to the request.
      expect(scripted.answers[0]!.params.maxOutputTokens).toBe(expected);
    }
  });

  it("completes the turn that crosses the background threshold without waiting; its run records the compaction when it finishes", async () => {
    const scripted = scriptedAdapter([{ text: "Done with the next step." }], 300);
    const memory = memoryEngine(earlierWork(CONTEXT_TOKENS));
    const runRepository = repository();
    const result = await events(createNativeRunExecutionResponse({ adapter: scripted.adapter, created, engine: memory.engine,
      prepared: prepared(windowFor(0.78)), repository: runRepository as unknown as RunRepository, services: {}, userId: "user" }));
    expect(memory.published()).toBe("Done with the next step.");
    // The answer request went out as it was, without a summary in it.
    expect(scripted.answers).toHaveLength(1);
    expect(firstText(scripted.answers[0]!)).not.toContain(COMPACTION_SUMMARY_HEADING);
    expect(scripted.summaries.length).toBeGreaterThanOrEqual(1);
    // The run completed while the compaction was still running: nothing of it in the stream or the transcript yet.
    expect(result.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
    expect(memory.runs.complete).toHaveBeenCalledTimes(1);
    expect(compactionStatuses(result)).toEqual([]);
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(["assistant_text"]);
    const usageWrites = memory.runs.writeUsageRows.mock.calls.length;
    // Detached, it finishes later: its run records the item after the answer's, the marker and the late usage.
    await vi.waitFor(() => expect(memory.transcriptRows.map((item) => item.kind)).toEqual(["assistant_text", "compaction"]),
      { timeout: 5_000 });
    expect(memory.transcriptRows[1]).toMatchObject({ summary: SUMMARY });
    // Together with its marker, at a sequence after every record of the run, in one write that checks the chat.
    expect(memory.runs.recordDetachedCompaction).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }),
      expect.objectContaining({ item: expect.objectContaining({ kind: "compaction" }), sequence: 1,
        status: expect.objectContaining({ outcome: "summary_applied", state: "complete" }) }));
    expect(memory.engine.transcripts.append).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(memory.runs.writeUsageRows.mock.calls.length).toBeGreaterThan(usageWrites));
  });

  it("swaps a background compaction in at the next request boundary of the same turn", async () => {
    const scripted = scriptedAdapter([
      { calls: [{ arguments: { handle: `tor1_${"a".repeat(32)}` }, id: "call-read", name: "read_tool_result" }] },
      { text: "Read it; continuing." }
    ]);
    const memory = memoryEngine(earlierWork(CONTEXT_TOKENS));
    const result = await events(createNativeRunExecutionResponse({ adapter: scripted.adapter, created, engine: memory.engine,
      prepared: prepared(windowFor(0.78)), repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(memory.published()).toBe("Read it; continuing.");
    expect(scripted.answers).toHaveLength(2);
    expect(firstText(scripted.answers[0]!)).not.toContain(COMPACTION_SUMMARY_HEADING);
    expect(firstText(scripted.answers[1]!).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    // The kept tail carries the round that ran meanwhile.
    expect(scripted.answers[1]!.history?.some((item) => item.type === "tool_call" && item.callId === "call-read")).toBe(true);
    expect(compactionStatuses(result)).toEqual([expect.objectContaining({ state: "complete" })]);
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(["tool_call", "tool_result", "compaction", "assistant_text"]);
  });

  it("records the context the chat header shows from the engine's own measure, which drops once a compaction is in", async () => {
    const scripted = scriptedAdapter([
      { calls: [{ arguments: { handle: `tor1_${"a".repeat(32)}` }, id: "call-read", name: "read_tool_result" }] },
      { text: "Read it; continuing." }
    ]);
    const memory = memoryEngine(earlierWork(CONTEXT_TOKENS));
    const runRepository = repository();
    const contextWindow = windowFor(0.78);
    const result = await events(createNativeRunExecutionResponse({ adapter: scripted.adapter, created, engine: memory.engine,
      prepared: prepared(contextWindow), repository: runRepository as unknown as RunRepository, services: {}, userId: "user" }));
    // On record (the chat detail reads the latest run's latest one) and live, each as the header decodes it.
    const recorded = runRepository.appendRunOutputEvent.mock.calls.flatMap(([, event]) => {
      const artifact = event as { data?: { artifactType?: string; payload?: unknown }; type?: string };
      return artifact.type === "artifact" && artifact.data?.artifactType === "context_status"
        ? [decodeSessionContextStatus(artifact.data.payload)] : [];
    });
    const live = result.filter((event) => event.type === "artifact" && event.data.artifactType === "context_status");
    expect(recorded.map((status) => status?.phase)).toEqual(["request", "request", "after_answer"]);
    expect(live).toHaveLength(3);
    const [first, second, settled] = recorded as SessionContextStatus[];
    // The first request carries the whole earlier work; the second its summary and kept tail, after the swap.
    expect(first!.approximateInputTokens).toBeGreaterThan(CONTEXT_TOKENS);
    expect(second!.approximateInputTokens).toBeLessThan(first!.approximateInputTokens);
    // After the answer: the provider's input report of the last request (100) plus the answer added after it.
    expect(settled!.approximateInputTokens).toBeGreaterThan(100);
    expect(settled!.approximateInputTokens).toBeLessThan(second!.approximateInputTokens);
    expect(settled).toMatchObject({ contextWindow, droppedMessages: 0, loadedTools: expect.any(Number), modelId: "fake-qsa",
      provider: "fake", version: 1 });
  });

  it("compacts in the foreground on a size rejection and sends the request once more", async () => {
    const rejection = Object.assign(new Error("prompt is too long"), { code: PROVIDER_CONTEXT_LENGTH_EXCEEDED });
    const scripted = scriptedAdapter([{ fail: rejection }, { text: "Answered after compaction." }]);
    const memory = memoryEngine(earlierWork(CONTEXT_TOKENS));
    const runRepository = repository();
    const result = await events(createNativeRunExecutionResponse({ adapter: scripted.adapter, created, engine: memory.engine,
      prepared: prepared(windowFor(0.6)), repository: runRepository as unknown as RunRepository, services: {}, userId: "user" }));
    expect(memory.published()).toBe("Answered after compaction.");
    // A compaction inside the run is on record too, so a reload shows the Context section the live answer showed.
    expect(runRepository.appendRunOutputEvent).toHaveBeenCalledWith("run-1", { data: { artifactType: "context_compaction",
      payload: expect.objectContaining({ state: "complete" }) }, type: "artifact" });
    expect(scripted.answers).toHaveLength(2);
    expect(firstText(scripted.answers[1]!).startsWith(COMPACTION_SUMMARY_HEADING)).toBe(true);
    expect(scripted.order.indexOf("summary")).toBeGreaterThan(0);
    expect(compactionStatuses(result).map((status) => status.state)).toEqual(["running", "complete"]);
    expect(result.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
  });

  it("fails visibly when the request is rejected for its size again after compacting", async () => {
    const rejection = Object.assign(new Error("prompt is too long"), { code: PROVIDER_CONTEXT_LENGTH_EXCEEDED });
    const scripted = scriptedAdapter([{ fail: rejection }]);
    const memory = memoryEngine(earlierWork(CONTEXT_TOKENS));
    const repo = repository();
    const result = await events(createNativeRunExecutionResponse({ adapter: scripted.adapter, created, engine: memory.engine,
      prepared: prepared(windowFor(0.6)), repository: repo as unknown as RunRepository, services: {}, userId: "user" }));
    expect(scripted.answers).toHaveLength(2);
    expect(result.at(-1)).toMatchObject({ data: { code: "context_too_large" }, type: "error" });
    expect(repo.failRun).toHaveBeenCalledWith("run-1", "answer-1", expect.objectContaining({ code: "context_too_large" }),
      { recoveryTerminal: true });
  });

  it("sends a chat's loop rounds one gateway routing key across its runs, and its compactions their own", async () => {
    vi.stubEnv("AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY", Buffer.alloc(32, 5).toString("base64"));
    try {
      const keyed = (adapter: ProviderAdapter) => {
        const keys: { key: string | undefined; summary: boolean }[] = [];
        const wrapped: ProviderAdapter = { ...adapter, stream: (request, options) => {
          keys.push({ key: options?.routingKey, summary: isSummary(request) });
          return adapter.stream(request, options);
        } };
        return { adapter: wrapped, keys };
      };
      const chatId = `chat-${randomUUID()}`;
      const first = keyed(scriptedAdapter([
        { calls: [{ arguments: { handle: `tor1_${"a".repeat(32)}` }, id: "call-read", name: "read_tool_result" }] },
        { text: "Read it; continuing." }
      ]).adapter);
      const memory = memoryEngine(earlierWork(CONTEXT_TOKENS));
      await events(createNativeRunExecutionResponse({ adapter: first.adapter, created, engine: memory.engine,
        prepared: prepared(windowFor(0.78), chatId), repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
      const rounds = first.keys.filter((entry) => !entry.summary).map((entry) => entry.key);
      const compactions = first.keys.filter((entry) => entry.summary).map((entry) => entry.key);
      expect(rounds).toHaveLength(2);
      expect(rounds[0]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(rounds[1]).toBe(rounds[0]);
      expect(compactions.length).toBeGreaterThanOrEqual(1);
      expect(compactions[0]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(new Set(compactions).size).toBe(1);
      expect(compactions[0]).not.toBe(rounds[0]);
      expect(JSON.stringify(first.keys)).not.toContain(chatId);
      // The chat's next run goes on with the same key; another chat has its own.
      for (const [chat, same] of [[chatId, true], [`chat-${randomUUID()}`, false]] as const) {
        const next = keyed(scriptedAdapter([{ text: "Next." }]).adapter);
        await events(createNativeRunExecutionResponse({ adapter: next.adapter,
          created: { assistantMessageId: "answer-2", runId: "run-2", userMessageId: "question-2" }, engine: memoryEngine([]).engine,
          prepared: prepared(200_000, chat), repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
        expect(next.keys).toHaveLength(1);
        expect(next.keys[0]!.key === rounds[0]).toBe(same);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
