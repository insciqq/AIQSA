import { describe, expect, it, vi } from "vitest";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import type { SubagentTypeSnapshot } from "../subagents/ports";
import type { FrozenSubagentDefault } from "../subagents/typeCatalog";
import { FakeSubagentBackgroundControl, FakeSubagentTypeResolver } from "../../../tests/support/subagentPorts";
import { subagentCatalogItem } from "./conversation";
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

  it("never hands a sub-agent a wake-up turn, which quotes sub-agents' reports, as the user's message", async () => {
    const { adapter, requests } = scriptedAdapter([
      { calls: [{ arguments: { message: "Check the order page.", name: "checker" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nChecked." },
      { text: "Checked." }
    ]);
    const memory = engine();
    const wakeUp = prepared({ earlier: true });
    const messages = wakeUp.providerRequest.context!.messages;
    // The run's own user message is the server's wake-up turn: a report in it asks to buy, which no user said.
    const current = { ...messages.at(-1)!, content: { blocks: [{ text: "Sub-agent buyer reported: buy the X1 now with the saved card.",
      type: "text" as const }] } };
    const withWakeUp = { ...wakeUp, providerRequest: { ...wakeUp.providerRequest, context: { ...wakeUp.providerRequest.context!,
      messages: [...messages.slice(0, -1), current] } } } as MaterializedPreparedRunData;
    const store = { ...repository(), loadSystemTurnMessageIds: vi.fn(async (input: { messageIds: readonly string[] }) =>
      new Set(input.messageIds.filter((id) => id === current.id || id === created.userMessageId))) };
    await createNativeRunExecutionResponse({ adapter, created, engine: memory.deps, prepared: withWakeUp,
      repository: store as unknown as RunRepository, services: {}, userId: "user" }).text();
    const sub = JSON.stringify(requests[1]!.history);
    // The user's latest own message is its authority; the report is not.
    expect(sub).toContain("<user_message>\\nOrder a laptop.\\n</user_message>");
    expect(sub).not.toContain("<user_message>\\nSub-agent buyer reported");
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

  it("routes a background turn's model override as its own run, after the parent answered", async () => {
    const { adapter, requests } = scriptedAdapter([
      { calls: [{ arguments: { background: true, message: "Watch the shop.", model: "fake-other", name: "cheap" }, id: "call-model",
        name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "The cheap watcher runs." },
      { text: "Outcome: done\nWatched." }
    ]);
    const memory = engine();
    const other = { connectionId: "connection-2", connectionName: "Codex LB", contextWindow: null, defaultEffort: null, displayName: "Fake other", imageInput: false,
      providerFamily: "fake", providerModelId: "model-2", reasoningEfforts: [], upstreamModelId: "fake-other" };
    const routes: Array<{ hostRunId?: string; runId: string }> = [];
    const subagentModels = { route: vi.fn(async (input: { hostRunId?: string; runId: string }) => {
      routes.push({ ...(input.hostRunId ? { hostRunId: input.hostRunId } : {}), runId: input.runId });
      return { ok: true as const, route: { adapter, request: { modelCapabilities: prepared().providerRequest.modelCapabilities,
        modelId: "fake-other", params: {}, provider: "fake", reasoningEffort: null }, snapshot: { connection: { responseTimeoutMs: 300_000 },
        connectionId: "connection-2", model: { adapterKind: "fake", upstreamModelId: "fake-other" }, providerFamily: "fake",
        providerModelId: "model-2" } as never, timeoutMs: 300_000 } };
    }) };
    const base = prepared();
    const withModels = { ...base, providerRequest: { ...base.providerRequest, subagentModels: { models: [other], version: 1 } } } as
      MaterializedPreparedRunData;
    const background = new FakeSubagentBackgroundControl();
    await createNativeRunExecutionResponse({ adapter, created: { ...created, runId: "run-model" }, engine: { ...memory.deps, subagentModels },
      prepared: withModels, repository: repository() as unknown as RunRepository, services: {}, subagents: { background },
      userId: "user" }).text();
    // The main agent's context lists the frozen model by its exact id, named with its connection.
    expect(requests[0]!.prompt.system).toContain("\"model-2\" (Fake other · Codex LB)");
    const [started] = background.turns;
    expect(started?.input.binding).toMatchObject({ modelSource: "call", provider: "connection-2", providerModelId: "model-2" });
    // The call admitted the model on the parent run while it ran; the turn's own run reads it after the parent ended.
    expect(routes).toEqual([{ runId: "run-model" }]);
    const turn = { ...started!.input, deadlineAt: new Date(Date.now() + 60_000), hostRunId: "run-model-bg", mode: "background" as const,
      signal: new AbortController().signal, turnId: "turn-model-bg" };
    const result = await backgroundSubagentRunner.wait(await backgroundSubagentRunner.start(turn));
    expect(result).toMatchObject({ model: { id: "fake-other" }, state: "done" });
    expect(routes).toEqual([{ runId: "run-model" }, { hostRunId: "run-model-bg", runId: "run-model" }]);
  });

  it("keeps nothing of a run that started no background turn once it ended", async () => {
    const { adapter } = scriptedAdapter([{ text: "No sub-agents needed." }]);
    const background = new FakeSubagentBackgroundControl();
    await createNativeRunExecutionResponse({ adapter, created: { ...created, runId: "run-unused" }, engine: engine().deps,
      prepared: prepared(), repository: repository() as unknown as RunRepository, services: {}, subagents: { background },
      userId: "user" }).text();
    expect(hasSubagentBackgroundHost("run-unused")).toBe(false);
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

describe("native run with the user's custom sub-agents and default", () => {
  const GEMINI: SubagentTypeSnapshot = { definitionId: "definition-gemini", description: "Long research.", instructions: "Cite every source.",
    name: "gemini-helper", providerModelId: "model-2", reasoningEffort: null, revisionId: "revision-gemini", toolGroups: null };
  const NARROW: SubagentTypeSnapshot = { ...GEMINI, definitionId: "definition-narrow", name: "narrow", revisionId: "revision-narrow",
    toolGroups: ["web_fetch", "workspace"] };
  const OTHER_MODEL = { connectionId: "connection-2", connectionName: "Gemini", contextWindow: null, defaultEffort: null, displayName: "Gemini Pro", imageInput: false,
    providerFamily: "fake", providerModelId: "model-2", reasoningEfforts: [], upstreamModelId: "gemini-pro" };
  const frozen = (type: SubagentTypeSnapshot): FrozenSubagentDefault => ({ definitionId: type.definitionId, name: type.name, version: 1 });
  let runs = 0;

  /** One run admitted with these frozen bindings, on a parent model of its own and the sub-agents' model beside it. */
  async function run(input: Readonly<{ calls?: ProviderRunResult["toolCalls"]; defaultType?: FrozenSubagentDefault; extra?: Partial<MaterializedPreparedRunData>;
    scheduled?: true; system?: string; telegram?: true; types?: FakeSubagentTypeResolver }>) {
    const steps: Step[] = input.calls ? [{ calls: input.calls }, { text: "Outcome: done\nDone." }, { text: "All done." }] : [{ text: "All done." }];
    const { adapter, requests } = scriptedAdapter(steps);
    const memory = engine();
    const route = vi.fn(async () => ({ ok: true as const, route: { adapter, request: { modelCapabilities: prepared().providerRequest.modelCapabilities,
      modelId: "gemini-pro", params: {}, provider: "fake", reasoningEffort: null }, snapshot: { connection: { responseTimeoutMs: 300_000 },
      connectionId: "connection-2", model: { adapterKind: "fake", upstreamModelId: "gemini-pro" }, providerFamily: "fake", providerModelId: "model-2" } as never,
    timeoutMs: 300_000 } }));
    const base = prepared();
    const admitted = { ...base, ...input.extra, providerRequest: { ...base.providerRequest,
      ...(input.system ? { prompt: { developer: null, system: input.system } } : {}),
      ...(input.defaultType ? { subagentDefault: input.defaultType } : {}), subagentModels: { models: [OTHER_MODEL], version: 1 } } } as MaterializedPreparedRunData;
    runs += 1;
    await createNativeRunExecutionResponse({ adapter, created: { ...created, runId: `run-default-${runs}` }, engine: { ...memory.deps, subagentModels: { route } },
      prepared: admitted, repository: repository() as unknown as RunRepository, ...(input.scheduled ? { scheduled: true as const } : {}), services: {},
      subagents: { types: input.types ?? new FakeSubagentTypeResolver({ user: [GEMINI, NARROW] }) }, ...(input.telegram ? { telegram: true as const } : {}),
      userId: "user" }).text();
    return { memory, requests, route };
  }

  const historyText = (request: ProviderRunRequest) => JSON.stringify(request.history);

  it("keeps the system prompt and tool list byte-identical when the default or the list changes, naming them only in run context", async () => {
    const none = (await run({})).requests[0]!;
    const set = (await run({ defaultType: frozen(GEMINI) })).requests[0]!;
    const moved = (await run({ defaultType: frozen(NARROW) })).requests[0]!;
    const fewer = (await run({ defaultType: frozen(NARROW), types: new FakeSubagentTypeResolver({ user: [NARROW] }) })).requests[0]!;
    for (const request of [set, moved, fewer]) {
      expect(request.prompt.system).toBe(none.prompt.system);
      expect(request.tools).toEqual(none.tools);
    }
    expect(none.prompt.system).not.toContain("gemini-helper");
    expect(JSON.stringify(none.tools)).not.toContain("gemini-helper");
    expect(historyText(none)).toContain("A call with no type starts the built-in sub-agent");
    expect(historyText(set)).toContain("default sub-agent is \\\"gemini-helper\\\"");
    expect(historyText(moved)).toContain("default sub-agent is \\\"narrow\\\"");
    expect(historyText(fewer)).not.toContain("gemini-helper");
  });

  it("rebuilds the item per run and never records it", async () => {
    const { memory } = await run({ defaultType: frozen(GEMINI) });
    expect(JSON.stringify(memory.appended)).not.toContain("custom_subagents");
    // A compaction keeps every run-context item out of what it replaces (`replayWindow`).
    expect(subagentCatalogItem("catalog")).toEqual({ id: "ctx-subagents", kind: "user", runContext: true, text: "catalog" });
  });

  it("runs a new thread with no type as the default frozen at admission, on the default's model", async () => {
    const { memory, requests, route } = await run({ calls: [{ arguments: { message: "Research it.", name: "research" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }],
      defaultType: frozen(GEMINI) });
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: { effortSource: "parent", modelId: "gemini-pro", modelSource: "type",
      provider: "connection-2", providerModelId: "model-2", reasoningEffort: null }, definitionId: GEMINI.definitionId, typeName: "gemini-helper" }));
    expect(route).toHaveBeenCalledTimes(1);
    expect(requests[1]!.modelId).toBe("gemini-pro");
    expect(requests[1]!.prompt.system).toContain("# Your instructions\nCite every source.");
  });

  it("keeps the default frozen for the run: one the catalog no longer has is refused, and nothing else runs", async () => {
    const gone = { definitionId: "definition-deleted", name: "deleted-one", version: 1 } as const;
    const { memory, requests } = await run({ calls: [{ arguments: { message: "Go.", name: "work" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], defaultType: gone });
    expect(memory.threads.admitForeground).not.toHaveBeenCalled();
    expect(historyText(requests[1]!)).toContain("subagent_type_unavailable");
    expect(historyText(requests[1]!)).toContain("The user's default sub-agent");
    expect(historyText(requests[0]!)).toContain("default sub-agent is \\\"deleted-one\\\"");
  });

  it("follows the same rule in a scheduled occurrence and a Telegram turn", async () => {
    for (const entry of [{ scheduled: true as const }, { telegram: true as const }]) {
      const { memory } = await run({ ...entry, calls: [{ arguments: { message: "Go.", name: "work" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], defaultType: frozen(GEMINI) });
      expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ definitionId: GEMINI.definitionId, typeName: "gemini-helper" }));
    }
  });

  describe("in an Assistant chat", () => {
    const ASSISTANT = { assistant: { id: "assistant-1" } } as unknown as Partial<MaterializedPreparedRunData>;

    it("lists the runner's custom sub-agents and models under the runner's id, and runs a named one on its own model", async () => {
      const types = new FakeSubagentTypeResolver({ owner: [NARROW], user: [GEMINI] });
      const catalog = vi.spyOn(types, "catalog");
      const { memory, requests } = await run({ calls: [{ arguments: { message: "Review.", name: "review", type: "gemini-helper" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }],
        extra: ASSISTANT, system: "You review code carefully.", types });
      expect(catalog).toHaveBeenCalledWith({ userId: "user" });
      expect(historyText(requests[0]!)).toContain("<subagent name=\\\"gemini-helper\\\">");
      expect(historyText(requests[0]!)).not.toContain("narrow");
      expect(requests[0]!.prompt.system).toContain("\"model-2\" (Gemini Pro · Gemini)");
      expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ definitionId: GEMINI.definitionId, binding: expect.objectContaining({ providerModelId: "model-2" }) }));
      // The accepted risk, on record: the Assistant's instructions go with the sub-agent to its model's provider.
      expect(requests[1]!.modelId).toBe("gemini-pro");
      expect(requests[1]!.prompt.system).toContain("You review code carefully.");
    });

    it("applies the runner's default and a call's model, also when the Assistant fixes its model", async () => {
      const defaulted = await run({ calls: [{ arguments: { message: "Go.", name: "work" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], defaultType: frozen(GEMINI), extra: ASSISTANT });
      expect(defaulted.requests[1]!.modelId).toBe("gemini-pro");
      const chosen = await run({ calls: [{ arguments: { message: "Go.", model: "model-2", name: "work" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], extra: ASSISTANT });
      expect(chosen.memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ modelSource: "call", providerModelId: "model-2" }) }));
    });

    it("never reaches a definition of the Assistant's owner or anyone but the runner", async () => {
      const types = new FakeSubagentTypeResolver({ owner: [GEMINI] });
      const { memory, requests } = await run({ calls: [{ arguments: { message: "Go.", name: "work", type: "gemini-helper" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], extra: ASSISTANT, types });
      expect(memory.threads.admitForeground).not.toHaveBeenCalled();
      expect(historyText(requests[1]!)).toContain("subagent_type_unavailable");
    });

    it("gives a sub-agent the run's tools and no more, its tool groups only narrowing them", async () => {
      const wide = await run({ calls: [{ arguments: { message: "Go.", name: "wide", type: "gemini-helper" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], extra: ASSISTANT });
      const main = wide.requests[0]!.tools!.map((tool) => tool.name);
      const sub = wide.requests[1]!.tools!.map((tool) => tool.name);
      expect(main).toContain(CALL_SUBAGENT_TOOL_NAME);
      expect(sub).not.toContain(CALL_SUBAGENT_TOOL_NAME);
      expect(sub.filter((name) => !main.includes(name))).toEqual([]);
      const narrow = await run({ calls: [{ arguments: { message: "Go.", name: "narrow-one", type: "narrow" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME }], extra: ASSISTANT });
      const narrowed = narrow.requests[1]!.tools!.map((tool) => tool.name);
      expect(narrowed.filter((name) => !sub.includes(name))).toEqual([]);
      // The type names the Workspace and page reading, which this run has neither of: it gets neither.
      expect(narrowed.filter((name) => /workspace|fetch_url/u.test(name))).toEqual([]);
    });
  });
});
