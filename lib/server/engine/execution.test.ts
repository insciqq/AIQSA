import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { engineTestFaults } from "./faults";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { NativeRunStore } from "./runStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { TranscriptItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: unknown; heading?: string; text?: string }>;

const snapshot: McpRunPlanSnapshot = {
  servers: [{ fingerprint: "fp-1", revisionId: "rev-1", serverId: "jira", serverName: "Jira" }],
  tools: [
    { annotations: { readOnlyHint: true }, definitionHash: "a".repeat(64), description: "Read", inputSchema: { type: "object" },
      name: "get_issue", namespacedName: "mcp_jira_get_issue", originalName: "get_issue", serverId: "jira", serverName: "Jira" },
    { definitionHash: "b".repeat(64), description: "Create", inputSchema: { type: "object" },
      name: "create_issue", namespacedName: "mcp_jira_create_issue", originalName: "create_issue", serverId: "jira", serverName: "Jira" }
  ],
  version: 1
};

function scriptedAdapter(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      if (step.heading) yield { data: { artifactType: "summary", payload: { reasoningHeading: step.heading } }, type: "artifact" };
      for (const word of (step.text ?? "").split(/(?<= )/u)) if (word) yield { data: { delta: word }, type: "token" };
      if (step.fail) throw step.fail;
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

function memoryEngine(overrides: Partial<NativeEngineDeps> = {}) {
  const order: string[] = [];
  const transcriptRows: TranscriptItem[] = [];
  const rows = new Map<string, ToolCallRow>();
  let published: string | null = null;
  const transcripts = {
    append: vi.fn(async (_scope, _from, items: readonly TranscriptItem[]) => { transcriptRows.push(...items); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async () => new Map()),
    nativeRunsForAnswers: vi.fn(async () => new Map()),
    nextSequence: vi.fn(async () => transcriptRows.length)
  } satisfies TranscriptRepository;
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
        providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: input.approval ? null : "now",
        state: input.approval ? "error" : "running", toolName: input.toolName };
      rows.set(row.id, row);
      return input.approval ? { approvalId: "approval-1", kind: "gated", row } : { kind: "running", row };
    }),
    refuse: vi.fn(async () => null),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const runs = {
    applyUsageTotals: vi.fn(async () => { order.push("usage-totals"); }),
    complete: vi.fn(async () => { order.push("complete"); return true; }),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { order.push("publish"); published = input.text; return true; }),
    writeUsageRows: vi.fn(async () => { order.push("usage-rows"); })
  } satisfies NativeRunStore;
  const engine: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => [
      { id: "binding-1", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" }]),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never), runs, savedResults: { read: vi.fn(async () => null) },
    toolCalls, transcripts, ...overrides
  };
  return { engine, order, published: () => published, rows, transcriptRows };
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
    loadRunMcpApprovalCards: vi.fn(async () => [{ approvalId: "approval-1", serverName: "Jira", source: "model", state: "pending",
      toolName: "Create" }]),
    markRunAnswerStarted: vi.fn(async () => undefined)
  };
}

function prepared(extra: Partial<ProviderRunRequest> = {}): MaterializedPreparedRunData {
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "Hello", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "Hello", type: "text" }] }, id: "current-user-message", role: "user" as const }],
      mode: "branch_path" as const },
    knowledgePlan: { baseIds: [], mode: "none" as const, sourceIds: [], version: 1 as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: "Be brief." }, provider: "fake",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const, ...extra
  } as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null,
    mcpBindings: [{ fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" }],
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

describe("native run execution", () => {
  it("streams reasoning headings and text, publishes the answer before completion and usage", async () => {
    const { adapter } = scriptedAdapter([{ heading: "Thinking it through", text: "Hello there." }]);
    const memory = memoryEngine();
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(result.map((event) => event.type)).toEqual(["run_start", "message_start", "artifact", "token", "token", "answer_complete", "done"]);
    expect(memory.published()).toBe("Hello there.");
    expect(memory.order).toEqual(["publish", "complete", "usage-rows", "usage-totals"]);
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(["assistant_text"]);
  });

  it("shows the whole answer when every usage write fails", async () => {
    const { adapter } = scriptedAdapter([{ text: "Full answer." }]);
    const memory = memoryEngine({ faults: () => engineTestFaults({ AIQSA_NATIVE_ENGINE_TEST_FAULTS: "usage_write_fail",
      AIQSA_TEST_MODE: "1", NODE_ENV: "test" }) });
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(result.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    expect(memory.published()).toBe("Full answer.");
    expect(memory.order).toEqual(["publish", "complete"]);
  });

  it("recovers a 502 on the first request without user action", async () => {
    const { adapter, requests } = scriptedAdapter([{ text: "After retry." }]);
    const memory = memoryEngine({ faults: () => engineTestFaults({ AIQSA_NATIVE_ENGINE_TEST_FAULTS: "model_502_once",
      AIQSA_TEST_MODE: "1", NODE_ENV: "test" }) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const response = createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
        repository: repository() as unknown as RunRepository, services: {}, userId: "user" });
      const reading = events(response);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await reading;
      expect(result.at(-1)).toMatchObject({ type: "done" });
    } finally {
      vi.useRealTimers();
    }
    expect(requests).toHaveLength(1);
    expect(memory.published()).toBe("After retry.");
  });

  it("runs a tool round through the registry and answers from its result", async () => {
    const { adapter, requests } = scriptedAdapter([
      { calls: [{ arguments: { key: "A-1" }, id: "call-1", name: "mcp_jira_get_issue" }], text: "" },
      { text: "A-1 is open." }
    ]);
    const memory = memoryEngine();
    const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: prepared({ mcp: snapshot }), repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(requests[1]!.history?.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result"]);
    expect(memory.published()).toBe("A-1 is open.");
    expect(result.some((event) => event.type === "artifact" && event.data.artifactType === "tool_call")).toBe(true);
  });

  it("ends the turn at the approval point with the card, without sending the call", async () => {
    const { adapter, requests } = scriptedAdapter([
      { calls: [{ arguments: { summary: "x" }, id: "call-1", name: "mcp_jira_create_issue" }], text: "I'll create it." }
    ]);
    const memory = memoryEngine();
    const callTool = vi.fn();
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: prepared({ mcp: snapshot, mcpApproval: mcpApprovalAdmission([]) }), repository: repository() as unknown as RunRepository,
      services: {}, userId: "user" }));
    expect(callTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(result.some((event) => event.type === "artifact" && event.data.artifactType === "mcp_approval")).toBe(true);
    expect(memory.published()).toBe("I'll create it.");
    expect(memory.transcriptRows.at(-1)).toMatchObject({ callId: "call-1", kind: "tool_result", outcome: "error" });
  });

  it("fails visibly with a stable code when the request cannot fit", async () => {
    const { adapter, requests } = scriptedAdapter([{ text: "never" }]);
    const memory = memoryEngine();
    const repo = repository();
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: prepared({ content: { blocks: [] }, context: { messages: [{ content: { blocks: [{ text: "x".repeat(10_000), type: "text" }] },
        id: "current-user-message", role: "user" }], mode: "branch_path" },
        modelCapabilities: { contextWindow: 100, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true,
          vision: false } }), repository: repo as unknown as RunRepository, services: {}, userId: "user" }));
    expect(requests).toHaveLength(0);
    expect(result.at(-1)).toMatchObject({ data: { code: "context_too_large" }, type: "error" });
    expect(repo.failRun).toHaveBeenCalledWith("run-1", "answer-1", expect.objectContaining({ code: "context_too_large" }),
      { recoveryTerminal: true });
  });
});
