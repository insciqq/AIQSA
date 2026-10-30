import { describe, expect, it, vi } from "vitest";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import { interruptNativeRun } from "./runInterruption";
import { backgroundSubagentRunner, hasSubagentBackgroundHost } from "./subagents/backgroundRunner";
import { SUBAGENT_ROLE_SECTION } from "./prompts";
import type { NativeRunStore } from "./runStore";
import type { SubagentThreadStore } from "./subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { TranscriptItem } from "./transcript";
import type { TranscriptRepository, TranscriptRunScope } from "./transcriptRepository";

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>;

function scriptedAdapter(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

function engine(options: Readonly<{ earlierRun?: boolean; threadEffects?: Readonly<{ items: TranscriptItem[]; threadId: string }>[] }> = {}) {
  const appended: Array<{ items: readonly TranscriptItem[]; scope: TranscriptRunScope }> = [];
  const rows = new Map<string, ToolCallRow>();
  const usage: RunUsageAttribution[] = [];
  const usageByRun = new Map<string, readonly RunUsageAttribution[]>();
  let published: string | null = null;
  const row = (input: { arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number; toolName: string },
    state: ToolCallRow["state"]): ToolCallRow => {
    const made: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
      providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: "now", state, toolName: input.toolName };
    rows.set(made.id, made);
    return made;
  };
  const transcripts = {
    append: vi.fn(async (scope: TranscriptRunScope, _from: number, items: readonly TranscriptItem[]) => { appended.push({ items, scope }); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async (input: { runIds: readonly string[] }) => new Map(input.runIds.map((id) => [id, [] as TranscriptItem[]]))),
    nativeRunsForAnswers: vi.fn(async () => new Map(options.earlierRun ? [["answer-0", "run-0"]] : [])),
    nativeRunsBeforeTurns: vi.fn(async () => []),
    retiredRunEffects: vi.fn(async () => []),
    nextSequence: vi.fn(async () => 0),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => ({ kind: "running", row: row(input, "running") })),
    refuse: vi.fn(async (input) => row(input, "error")),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const runs = {
    applyUsageTotals: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { published = input.text; return true; }),
    recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true),
    workDurationMs: vi.fn(async () => null as number | null),
    writeUsageRows: vi.fn(async (scope: { runId: string }, written: readonly { attribution: RunUsageAttribution }[]) => {
      if (scope.runId !== created.runId) {
        usageByRun.set(scope.runId, written.map((entry) => entry.attribution));
        return;
      }
      usage.splice(0, usage.length, ...written.map((entry) => entry.attribution));
    })
  } satisfies NativeRunStore;
  const settled: unknown[] = [];
  const threads = {
    admitForeground: vi.fn(async (input: Parameters<SubagentThreadStore["admitForeground"]>[0]) => ({ continued: false, kind: "admitted" as const,
      thread: { anchorRunId: input.parentRunId, definitionId: null, id: "thread-1", name: input.name, typeName: null },
      turn: { definitionRevisionId: null, effortSource: input.binding.effortSource, id: "turn-1", mode: "foreground" as const,
        modelId: input.binding.modelId, modelSource: input.binding.modelSource, parentRunId: input.parentRunId,
        provider: input.binding.provider, providerModelId: input.binding.providerModelId, reasoningEffort: input.binding.reasoningEffort,
        startedAt: new Date(), state: "running" as const, threadId: "thread-1" } })),
    ensureThread: vi.fn(async (input: { name: string; parentRunId: string }) => ({ anchorRunId: input.parentRunId, definitionId: null,
      id: "thread-bg", name: input.name, typeName: null })),
    find: vi.fn(async () => null),
    result: vi.fn(async () => null),
    endOrphanedTurns: vi.fn(async () => 0),
    setActiveState: vi.fn(async () => true),
    threadEffectItems: vi.fn(async () => options.threadEffects ?? []),
    backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]),
    settle: vi.fn(async (input) => { settled.push(input); return true; })
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never), runs, savedResults: { read: vi.fn(async () => null) },
    subagentThreads: threads, toolCalls, transcripts
  };
  return { appended, deps, published: () => published, settled, threads, usage, usageByRun };
}

function repository() {
  return {
    appendAssistantText: vi.fn(async () => undefined), appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async () => true), getChatUpdateForRun: vi.fn(async () => null),
    getRunControlForUser: vi.fn(async () => ({ status: "streaming" })), loadModelPricing: vi.fn(async () => null),
    loadProviderModelCostBasis: vi.fn(async () => null), loadRunMcpApprovalCards: vi.fn(async () => []),
    markRunAnswerStarted: vi.fn(async () => undefined)
  };
}

function prepared(extra: Readonly<{ earlier?: boolean }> = {}): MaterializedPreparedRunData {
  const earlier = extra.earlier ? [
    { content: { blocks: [{ text: "Order a laptop.", type: "text" }] }, id: "question-0", role: "user" as const },
    { content: { blocks: [{ text: "Done.", type: "text" }] }, id: "answer-0", role: "assistant" as const }
  ] : [];
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "Find the cheapest laptop.", type: "text" }] },
    context: { messages: [...earlier, { content: { blocks: [{ text: "Find the cheapest laptop.", type: "text" }] }, id: "current-user-message",
      role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake",
    reasoningEffort: null, searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const
  } as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake",
        upstreamModelId: "fake-qsa" }, providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };

describe("native run with sub-agents", () => {
  it("runs a default sub-agent on the parent's admitted binding and hands its report back as the call's result", async () => {
    const { adapter, requests } = scriptedAdapter([
      { calls: [{ arguments: { message: "Compare laptop prices on shop.example.", name: "shop" }, id: "call-1",
        name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nThe cheapest is the X1 at 899 EUR." },
      { text: "The cheapest is the X1 at 899 EUR." }
    ]);
    const memory = engine();
    const response = createNativeRunExecutionResponse({ adapter, created, engine: memory.deps, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" });
    await response.text();
    expect(memory.published()).toBe("The cheapest is the X1 at 899 EUR.");
    const [main, sub, after] = requests;
    expect(main!.tools?.map((tool) => tool.name)).toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(main!.prompt.system).toContain("# Sub-agents");
    // The default sub-agent: the parent's exact model and params, no nesting, its own role.
    expect(sub!.modelId).toBe("fake-qsa");
    expect(sub!.params).toEqual(main!.params);
    expect(sub!.tools?.map((tool) => tool.name)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(sub!.prompt.system).toContain(SUBAGENT_ROLE_SECTION);
    expect(JSON.stringify(sub!.history)).toContain("<user_message>\\nFind the cheapest laptop.\\n</user_message>");
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: { effortSource: "parent",
      modelId: "fake-qsa", modelSource: "parent", provider: "connection-1", providerModelId: "model-1", reasoningEffort: null },
    parentRunId: "run-1", parentToolCallId: "row-0" }));
    // The main agent reads only its call's result; the sub-agent's items are its thread's.
    const result = after!.history?.find((item) => item.type === "tool_result");
    expect(result).toMatchObject({ name: CALL_SUBAGENT_TOOL_NAME });
    expect(JSON.parse((result as { output: string }).output)).toMatchObject({ kind: "ended", name: "shop", outcome: "done", state: "done" });
    expect(JSON.stringify(after!.history)).not.toContain("main_agent_brief");
    const threadWrites = memory.appended.filter((write) => write.scope.thread);
    expect(threadWrites.every((write) => write.scope.thread?.threadId === "thread-1")).toBe(true);
    expect(memory.appended.filter((write) => !write.scope.thread).flatMap((write) => write.items)
      .some((item) => item.kind === "user" && item.text.includes("main_agent_brief"))).toBe(false);
    // Usage of both, recorded after the answer: the sub-agent's under its own purpose.
    expect(memory.usage.map((entry) => entry.purpose)).toEqual(["chat_answer", "subagent", "chat_answer"]);
    expect(memory.settled).toEqual([expect.objectContaining({ turnId: "turn-1" })]);
  });

  it("fences the main agent with the effects its branch's sub-agents left unknown, until the user speaks", async () => {
    const order = { message: "Order the X1.", name: "buyer" };
    // An earlier turn's sub-agent call whose outcome stayed unknown: a call with no result in its thread's records.
    const threadEffects = [{ items: [{ arguments: JSON.stringify(order), callId: "t1", id: "i1", kind: "tool_call" as const,
      name: CALL_SUBAGENT_TOOL_NAME, recordedAt: new Date("2026-10-29T10:00:00Z") }], threadId: "thread-earlier" }];
    const steps = [{ calls: [{ arguments: order, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }] }, { text: "Outcome: done\nOk." },
      { text: "Done." }];
    // A scheduled occurrence's prompt is no user speech: the equivalent call is not sent again.
    const scheduled = engine({ earlierRun: true, threadEffects });
    const first = scriptedAdapter(steps);
    await createNativeRunExecutionResponse({ adapter: first.adapter, created, engine: scheduled.deps, prepared: prepared({ earlier: true }),
      repository: repository() as unknown as RunRepository, scheduled: true, services: {}, userId: "user" }).text();
    expect(scheduled.deps.subagentThreads?.threadEffectItems).toHaveBeenCalledWith({ chatId: "chat", runIds: ["run-0"], userId: "user" });
    expect(scheduled.threads.admitForeground).not.toHaveBeenCalled();
    expect(JSON.stringify(first.requests[1]!.history)).toContain("its effect is unknown");
    // The user's own new message is them speaking since: the sub-agent may run again.
    const spoken = engine({ earlierRun: true, threadEffects });
    const second = scriptedAdapter(steps);
    await createNativeRunExecutionResponse({ adapter: second.adapter, created, engine: spoken.deps, prepared: prepared({ earlier: true }),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }).text();
    expect(spoken.threads.admitForeground).toHaveBeenCalledTimes(1);
  });

  it("admits a background call through the port and runs its turn as its own run on the parent's host", async () => {
    const { adapter, requests } = scriptedAdapter([
      { calls: [{ arguments: { background: true, message: "Watch shop.example for a price drop.", name: "watcher" }, id: "call-bg",
        name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "The watcher runs in the background." },
      { text: "Outcome: done\nNo price drop yet." }
    ]);
    const memory = engine();
    const background = new FakeSubagentBackgroundControl();
    await createNativeRunExecutionResponse({ adapter, created, engine: memory.deps, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, subagents: { background }, userId: "user" }).text();
    expect(memory.published()).toBe("The watcher runs in the background.");
    const [started] = background.turns;
    expect(started?.input).toMatchObject({ kind: "start", name: "watcher", parentRunId: "run-1", threadId: "thread-bg",
      userMessage: "Find the cheapest laptop." });
    // The host outlives its parent run: the control starts the turn in the background run it admitted.
    expect(hasSubagentBackgroundHost("run-1")).toBe(true);
    const turn = { ...started!.input, deadlineAt: new Date(Date.now() + 60_000), hostRunId: "run-bg", mode: "background" as const,
      parentToolCallId: started!.input.parentToolCallId, signal: new AbortController().signal, turnId: "turn-bg" };
    const handle = await backgroundSubagentRunner.start(turn);
    const result = await backgroundSubagentRunner.wait(handle);
    expect(result).toMatchObject({ kind: "ended", name: "watcher", outcome: "done", state: "done" });
    expect(requests[2]!.tools?.map((tool) => tool.name)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    // Its records are its own run's, under its thread; its usage is its own run's; the control settles the turn.
    const writes = memory.appended.filter((write) => write.scope.runId === "run-bg");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.scope.thread?.threadId === "thread-bg" && write.scope.thread.turnId === "turn-bg")).toBe(true);
    await vi.waitFor(() => expect(memory.usageByRun.get("run-bg")?.map((entry) => entry.purpose)).toEqual(["subagent"]));
    expect(memory.settled).toEqual([]);
  });

  it("offers no background port to a Telegram turn", async () => {
    const { adapter } = scriptedAdapter([
      { calls: [{ arguments: { background: true, message: "Watch it.", name: "watcher" }, id: "call-bg", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Background is not available here." }
    ]);
    const memory = engine();
    const background = new FakeSubagentBackgroundControl();
    await createNativeRunExecutionResponse({ adapter, created: { ...created, runId: "run-telegram" }, engine: memory.deps,
      prepared: prepared(), repository: repository() as unknown as RunRepository, services: {}, subagents: { background },
      telegram: true, userId: "user" }).text();
    expect(background.turns).toEqual([]);
    expect(hasSubagentBackgroundHost("run-telegram")).toBe(false);
  });

  it("ends a run its shared Workspace stopped under as interrupted, with Continue, never cancelled", async () => {
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
        interruptNativeRun("run-interrupted");
        throw new DOMException("Aborted", "AbortError");
      }
    };
    const memory = engine();
    const runs = repository();
    await createNativeRunExecutionResponse({ adapter, created: { ...created, runId: "run-interrupted" }, engine: memory.deps,
      prepared: prepared(), repository: runs as unknown as RunRepository, services: {}, userId: "user" }).text();
    expect(runs.failRun).toHaveBeenCalledWith("run-interrupted", "answer-1", expect.objectContaining({ code: "run_interrupted" }),
      { recoveryTerminal: true });
    expect(memory.deps.runs.saveStoppedText).not.toHaveBeenCalled();
  });
});
