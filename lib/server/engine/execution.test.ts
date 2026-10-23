import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { RunRepository } from "../runs/runRepositoryContract";
import { engineTestFaults } from "./faults";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { NativeRunStore } from "./runStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { TranscriptItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";

/** `silent`: the text arrives only with the completed response, never as deltas. */
type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: unknown; heading?: string; silent?: boolean; text?: string }>;

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
      if (!step.silent) for (const word of (step.text ?? "").split(/(?<= )/u)) if (word) yield { data: { delta: word }, type: "token" };
      if (step.fail) throw step.fail;
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

function memoryEngine(overrides: Partial<NativeEngineDeps> = {}, options: Readonly<{ allowed?: boolean }> = {}) {
  const order: string[] = [];
  const transcriptRows: TranscriptItem[] = [];
  const rows = new Map<string, ToolCallRow>();
  let published: string | null = null;
  const transcripts = {
    append: vi.fn(async (_scope, _from, items: readonly TranscriptItem[]) => { transcriptRows.push(...items); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async () => new Map()),
    nativeRunsForAnswers: vi.fn(async () => new Map()),
    nativeRunsBeforeTurns: vi.fn(async () => []),
    retiredRunEffects: vi.fn(async () => []),
    nextSequence: vi.fn(async () => transcriptRows.length),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      // `allowed`: the recording transaction consumes the user's Allow once.
      const gated = Boolean(input.approval) && !options.allowed;
      const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
        providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: gated ? null : "now",
        state: gated ? "error" : "running", toolName: input.toolName };
      rows.set(row.id, row);
      return gated ? { approvalId: "approval-1", kind: "gated", row } : { kind: "running", row };
    }),
    refuse: vi.fn(async () => null),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const runs = {
    workDurationMs: vi.fn(async () => null as number | null),
    applyUsageTotals: vi.fn(async () => { order.push("usage-totals"); }),
    complete: vi.fn(async () => { order.push("complete"); return true; }),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { order.push("publish"); published = input.text; return true; }),
    recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true),
    writeUsageRows: vi.fn(async () => { order.push("usage-rows"); })
  } satisfies NativeRunStore;
  const engine: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => [
      { id: "binding-1", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" }]),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never), runs, savedResults: { read: vi.fn(async () => null) },
    toolCalls, transcripts, ...overrides
  };
  return { engine, order, published: () => published, rows, runs, transcriptRows, transcripts };
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
    expect(result.map((event) => event.type))
      .toEqual(["run_start", "artifact", "message_start", "artifact", "token", "token", "answer_complete", "done"]);
    expect(memory.published()).toBe("Hello there.");
    expect(memory.order).toEqual(["publish", "complete", "usage-rows", "usage-totals"]);
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(["assistant_text"]);
  });

  it("reports the whole run as its work duration once the answer is published, however early it talked", async () => {
    // A preamble, a tool round, then the rest of the answer.
    const { adapter } = scriptedAdapter([
      { calls: [{ arguments: { key: "A-1" }, id: "call-1", name: "mcp_jira_get_issue" }], text: "Let me check. " },
      { text: "A-1 is open." }
    ]);
    const memory = memoryEngine();
    memory.runs.workDurationMs.mockImplementation(async () => {
      memory.order.push("duration");
      return 127_000;
    });
    const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: prepared({ mcp: snapshot }), repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    const durations = result.flatMap((event) => event.type === "artifact" && event.data.artifactType === "work_duration"
      ? [event.data.payload] : []);
    // Announced without a value at the start, so the live answer never shows a client guess; the figure after publication.
    expect(durations).toEqual([{ workDurationMs: null }, { workDurationMs: 127_000 }]);
    expect(memory.runs.workDurationMs).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(memory.order.slice(0, 3)).toEqual(["publish", "duration", "complete"]);
    const types = result.map((event) => event.type === "artifact" ? `${event.type}:${event.data.artifactType}` : event.type);
    expect(types.lastIndexOf("artifact:work_duration")).toBeGreaterThan(types.indexOf("answer_complete"));
  });

  it("keeps the answer when the duration cannot be read", async () => {
    const { adapter } = scriptedAdapter([{ text: "Done." }]);
    const memory = memoryEngine();
    memory.runs.workDurationMs.mockRejectedValue(new Error("database_unavailable"));
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(result.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    expect(memory.published()).toBe("Done.");
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
    // The turn context, then the input, then the round.
    expect(requests[1]!.history?.map((item) => item.type)).toEqual(["user", "user", "tool_call", "tool_result"]);
    expect(requests[1]!.history![0]).toEqual(requests[0]!.history![0]);
    expect(requests[1]!.history![0]).toMatchObject({ text: expect.stringMatching(/^<turn_context>\nCurrent local time: /u), type: "user" });
    expect(memory.transcriptRows.some((item) => item.kind === "user" && item.text.startsWith("<turn_context>"))).toBe(false);
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

  it("continues the stopped turn after an Allow: the approved call runs first and its result answers it, with no user turn", async () => {
    const stopped: TranscriptItem[] = [
      { arguments: "{\"summary\":\"x\"}", callId: "call-1", id: "n1", kind: "tool_call", name: "mcp_jira_create_issue",
        origin: { model: "fake-qsa", provider: "connection-1" } },
      { callId: "call-1", id: "n2", kind: "tool_result", name: "mcp_jira_create_issue", outcome: "error", output: "Waiting for approval." }
    ];
    const { adapter, requests } = scriptedAdapter([{ text: "Created A-2." }]);
    const memory = memoryEngine({ approvedCall: vi.fn(async () => ({ providerCallId: "call-1", toolName: "mcp_jira_create_issue" })) },
      { allowed: true });
    memory.engine.transcripts.nativeRunsForAnswers = vi.fn(async () => new Map([["answer-0", "run-0"]]));
    memory.engine.transcripts.loadRuns = vi.fn(async () => new Map([["run-0", stopped]]));
    const callTool = vi.fn(async () => ({ isError: false, text: ["Created A-2"], unsupportedContentTypes: [] }));
    const continuation = prepared({
      context: { messages: [
        { content: { blocks: [{ text: "Create the issue", type: "text" }] }, id: "user-1", role: "user" },
        { content: { blocks: [] }, id: "answer-0", role: "assistant" },
        { content: { blocks: [{ text: "The user approved `Create` on `Jira`. Continue the task.", type: "text" }] },
          id: "current-user-message", role: "user" }
      ], mode: "branch_path" },
      mcp: snapshot, mcpApproval: mcpApprovalAdmission([])
    });
    await events(createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" }, created,
      engine: memory.engine, mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: continuation, repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ arguments: { summary: "x" }, name: "create_issue" }));
    expect(memory.engine.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ providerCallId: "call-1", roundIndex: 0 }));
    const history = requests[0]!.history!;
    // The call's result answers the stopped turn; the run's turn context follows it, as its other run context does.
    expect(history.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "user"]);
    expect(history.at(-2)).toMatchObject({ callId: "call-1", output: "Created A-2" });
    expect(history.at(-1)).toMatchObject({ text: expect.stringMatching(/^<turn_context>/u), type: "user" });
    expect(history.some((item) => item.type === "user" && item.text.includes("approved"))).toBe(false);
    expect(memory.published()).toBe("Created A-2.");
  });

  it("continues from the server's turn text once the user wrote after the stopped turn, so a compaction never orphans the result", async () => {
    const stopped: TranscriptItem[] = [
      { arguments: "{\"summary\":\"x\"}", callId: "call-1", id: "n1", kind: "tool_call", name: "mcp_jira_create_issue",
        origin: { model: "fake-qsa", provider: "connection-1" } },
      { callId: "call-1", id: "n2", kind: "tool_result", name: "mcp_jira_create_issue", outcome: "error", output: "Waiting for approval." }
    ];
    const { adapter, requests } = scriptedAdapter([{ text: "Creating it now." }]);
    const memory = memoryEngine({ approvedCall: vi.fn(async () => ({ providerCallId: "call-1", toolName: "mcp_jira_create_issue" })) },
      { allowed: true });
    memory.engine.transcripts.nativeRunsForAnswers = vi.fn(async () => new Map([["answer-0", "run-0"]]));
    memory.engine.transcripts.loadRuns = vi.fn(async () => new Map([["run-0", stopped]]));
    const continuation = prepared({ context: { messages: [
      { content: { blocks: [{ text: "Create the issue", type: "text" }] }, id: "user-1", role: "user" },
      { content: { blocks: [] }, id: "answer-0", role: "assistant" },
      { content: { blocks: [{ text: "Meanwhile, what is due today?", type: "text" }] }, id: "user-2", role: "user" },
      { content: { blocks: [{ text: "Two reviews.", type: "text" }] }, id: "answer-2", role: "assistant" },
      { content: { blocks: [{ text: "The user approved `Create` on `Jira`. Continue the task.", type: "text" }] },
        id: "current-user-message", role: "user" }
    ], mode: "branch_path" }, mcp: snapshot });
    await events(createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" }, created,
      engine: memory.engine, prepared: continuation, repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    // The old call is not sent into a turn that has ended: the model makes the allowed call again, matched by the Allow.
    expect(memory.engine.toolCalls.begin).not.toHaveBeenCalled();
    const history = requests[0]!.history!;
    expect(history.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "user", "assistant_text", "user", "user"]);
    expect(history.at(-1)).toMatchObject({ currentInput: true, type: "user" });
  });

  it("continues a turn the old core stopped from the server's turn text, so the model makes the allowed call again", async () => {
    const { adapter, requests } = scriptedAdapter([{ text: "Calling it again." }]);
    const memory = memoryEngine({ approvedCall: vi.fn(async () => ({ providerCallId: "v1-call", toolName: "mcp_jira_create_issue" })) });
    const continuation = prepared({ context: { messages: [
      { content: { blocks: [{ text: "Create the issue", type: "text" }] }, id: "user-1", role: "user" },
      { content: { blocks: [{ text: "I need your approval.", type: "text" }] }, id: "answer-0", role: "assistant" },
      { content: { blocks: [{ text: "The user approved `Create` on `Jira`. Continue the task.", type: "text" }] },
        id: "current-user-message", role: "user" }
    ], mode: "branch_path" }, mcp: snapshot });
    await events(createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" }, created,
      engine: memory.engine, prepared: continuation, repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    const history = requests[0]!.history!;
    expect(history.map((item) => item.type)).toEqual(["user", "assistant_text", "user", "user"]);
    expect(history.at(-1)).toMatchObject({ currentInput: true, type: "user" });
    expect(memory.engine.toolCalls.begin).not.toHaveBeenCalled();
  });

  it("publishes text that came only with the completed response although its transcript write failed", async () => {
    // Regression: the round's text was taken only after its transcript row, so a failed insert lost the answer.
    const { adapter } = scriptedAdapter([{ silent: true, text: "Full answer." }]);
    const memory = memoryEngine();
    memory.transcripts.append.mockRejectedValueOnce(new Error("database restarted"));
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(memory.published()).toBe("Full answer.");
    expect(result.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    // The record was written on its next attempt, once.
    expect(memory.transcriptRows.map((item) => item.kind)).toEqual(["assistant_text"]);
    expect(memory.transcripts.append).toHaveBeenCalledTimes(2);
  });

  it("still answers when the transcript cannot be written at all", async () => {
    const { adapter } = scriptedAdapter([{ silent: true, text: "Full answer." }]);
    const memory = memoryEngine();
    memory.transcripts.append.mockRejectedValue(new Error("database down"));
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(memory.published()).toBe("Full answer.");
    expect(result.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
  });

  it("never sends a tool call whose record could not be written, and keeps the round's text", async () => {
    const { adapter } = scriptedAdapter([{ calls: [{ arguments: { key: "A-1" }, id: "call-1", name: "mcp_jira_get_issue" }],
      silent: true, text: "Let me look." }]);
    const memory = memoryEngine();
    memory.transcripts.append.mockRejectedValue(new Error("database down"));
    const callTool = vi.fn();
    const repo = repository();
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: prepared({ mcp: snapshot }), repository: repo as unknown as RunRepository, services: {}, userId: "user" }));
    expect(callTool).not.toHaveBeenCalled();
    expect(memory.engine.toolCalls.begin).not.toHaveBeenCalled();
    expect(result.at(-1)).toMatchObject({ type: "error" });
    expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", "Let me look.", { runId: "run-1" });
  });

  it("asks the user again before repeating a write whose earlier outcome is unknown, even under Always allow", async () => {
    const origin = { model: "fake-qsa", provider: "connection-1" };
    const earlier: TranscriptItem[] = [
      { arguments: "{\"summary\":\"x\"}", callId: "call-0", id: "n1", kind: "tool_call", name: "mcp_jira_create_issue", origin },
      { callId: "call-0", id: "n2", kind: "tool_result", name: "mcp_jira_create_issue", outcome: "unknown", output: "Effect unknown." }
    ];
    const { adapter } = scriptedAdapter([
      { calls: [{ arguments: { summary: "x" }, id: "call-1", name: "mcp_jira_create_issue" }], text: "" }
    ]);
    const memory = memoryEngine();
    memory.engine.transcripts.nativeRunsForAnswers = vi.fn(async () => new Map([["answer-0", "run-0"]]));
    memory.engine.transcripts.loadRuns = vi.fn(async () => new Map([["run-0", earlier]]));
    const callTool = vi.fn();
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: prepared({ context: { messages: [
        { content: { blocks: [{ text: "Create the issue", type: "text" }] }, id: "user-0", role: "user" },
        { content: { blocks: [] }, id: "answer-0", role: "assistant" },
        { content: { blocks: [{ text: "Did it work? Try again", type: "text" }] }, id: "current-user-message", role: "user" }
      ], mode: "branch_path" }, mcp: snapshot, mcpApproval: mcpApprovalAdmission(["jira"]) }),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(callTool).not.toHaveBeenCalled();
    expect(memory.engine.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({
      approval: expect.objectContaining({ serverId: "jira", toolName: "mcp_jira_create_issue" }) }));
    expect(result.some((event) => event.type === "artifact" && event.data.artifactType === "mcp_approval")).toBe(true);
  });

  it("keeps the text streamed before Stop with the stopped answer", async () => {
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(_request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
        yield { data: { delta: "Partial " }, type: "token" };
        // Stop: the durable cancellation won, then the run's controller is aborted.
        activeRunControllerRegistry.abort("run-1");
        options.signal?.throwIfAborted();
        return { finalProviderResponsePreview: {}, finalText: "Partial never", toolCalls: [], usage: {} };
      }
    };
    const memory = memoryEngine();
    const result = await events(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: prepared(),
      repository: repository() as unknown as RunRepository, services: {}, userId: "user" }));
    expect(result.at(-1)).toEqual({ data: { runId: "run-1", status: "cancelled" }, type: "done" });
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), "Partial ");
    expect(memory.published()).toBeNull();
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
