import { describe, expect, it, vi } from "vitest";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository, RunUsageAttribution } from "../runs/runRepositoryContract";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
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

function engine() {
  const appended: Array<{ items: readonly TranscriptItem[]; scope: TranscriptRunScope }> = [];
  const rows = new Map<string, ToolCallRow>();
  const usage: RunUsageAttribution[] = [];
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
    nativeRunsForAnswers: vi.fn(async () => new Map()),
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
    writeUsageRows: vi.fn(async (_scope, written: readonly { attribution: RunUsageAttribution }[]) => {
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
    ensureThread: vi.fn(),
    find: vi.fn(async () => null),
    result: vi.fn(async () => null),
    setActiveState: vi.fn(async () => true),
    settle: vi.fn(async (input) => { settled.push(input); return true; })
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never), runs, savedResults: { read: vi.fn(async () => null) },
    subagentThreads: threads, toolCalls, transcripts
  };
  return { appended, deps, published: () => published, settled, threads, usage };
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

function prepared(): MaterializedPreparedRunData {
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "Find the cheapest laptop.", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "Find the cheapest laptop.", type: "text" }] }, id: "current-user-message",
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
});
