// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  memoryNativeEngine, NATIVE_MCP_SNAPSHOT, NATIVE_RUN_ORIGIN, nativePrepared, nativeRunRepository, nativeSay, nativeSseEvents,
  scriptedNativeAdapter
} from "@/tests/support/nativeRunExecution";
import { resolveAssistantChatBaseline } from "../../domain/promptTemplates";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { mergeMcpRunPlanSnapshots } from "../mcp/discovery";
import type { McpCapabilityCatalog, McpDiscoveryState, McpRunPlanSnapshot } from "../mcp/runPlan";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import { textMessageContent } from "../../domain/content";
import type { ProviderRunRequest } from "../providers/types";
import { conversationMessagesFromPathRows } from "../runs/prismaRepository";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { activeRunControllers } from "../runs/activeRunControllerRegistry";
import type { RunRepository } from "../runs/runRepositoryContract";
import { monitoringCheckInstruction, monitoringVerdictReservedInstruction } from "../tools/monitoringVerdict";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { createNativeRunExecutionResponse } from "./execution";
import { nativeRunResponse, type NativeEngineHandlerDeps } from "./handlerSupport";
import { NEUTRAL_FAMILY_PROMPT } from "./prompts/neutral";
import {
  APPROVED_CALL_IN_FLIGHT_OUTPUT, APPROVED_TOOL_UNAVAILABLE, APPROVED_TOOL_UNAVAILABLE_OUTPUT, UNKNOWN_OUTCOME_REPEAT_OUTPUT
} from "./toolBatch";
import type { TranscriptItem } from "./transcript";
import { unknownEffectsOf } from "./unknownEffects";

/**
 * The native engine on the runs the rollout moves to it: a scheduled
 * monitoring check reporting its verdict (through the reserved round when its
 * budget ran out), a scheduled run's flat context, a rotation's carried
 * Workspace, an answer review step's card, an Assistant's instructions, and
 * the tools each kind of run is offered.
 */
const VERDICT = "report_monitoring_result";
const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };
const toolNames = (request: ProviderRunRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name);
const asRepository = (repo: ReturnType<typeof nativeRunRepository>) => repo as unknown as RunRepository;

describe("a scheduled monitoring check on the native engine", () => {
  it("reports its verdict through the reserved tool, which only its own run records", async () => {
    const instruction = monitoringCheckInstruction({ previousResult: false });
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { status: "update" }, id: "v1", name: VERDICT }] },
      { text: "Version 2.0 is out." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    const result = await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ monitoringVerdictTool: true, prompt: { developer: null, system: instruction } }),
      repository: asRepository(repo), scheduled: true, services: {}, userId: "owner" }));
    expect(result.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    expect(toolNames(requests[0])).toContain(VERDICT);
    // The check's own instruction follows the family prompt.
    expect(requests[0]!.prompt.system!.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    expect(requests[0]!.prompt.system).toContain(instruction);
    expect(repo.recordMonitoringVerdict).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", userId: "owner", verdict: "update" });
    expect(memory.published()).toBe("Version 2.0 is out.");
    expect(memory.transcriptRows.find((item) => item.kind === "tool_result")).toMatchObject({ callId: "v1", outcome: "complete" });
  });

  it("is asked for its verdict alone once its call budget ran out, and the instruction never enters the transcript", async () => {
    const reserved = monitoringVerdictReservedInstruction();
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] },
      { calls: [{ arguments: { key: "A-2" }, id: "c2", name: "mcp_jira_get_issue" }] },
      { calls: [{ arguments: { status: "no_update" }, id: "v1", name: VERDICT }, { arguments: { key: "A-3" }, id: "c3",
        name: "mcp_jira_get_issue" }] },
      { text: "Nothing new." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    const callTool = vi.fn(async () => ({ isError: false, text: ["open"], unsupportedContentTypes: [] }));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: nativePrepared({ mcp: NATIVE_MCP_SNAPSHOT, monitoringVerdictTool: true,
        toolBudgets: { maxMcpToolsPerDiscovery: 5, maxToolCalls: 1, maxToolRounds: 8 } }),
      repository: asRepository(repo), scheduled: true, services: {}, userId: "owner" }));
    expect(requests).toHaveLength(4);
    expect(callTool).toHaveBeenCalledTimes(1);
    // Round 3 is the reserved one: tools stay declared, its last input asks for the verdict only.
    expect(requests[2]!.toolChoice).toBe("auto");
    expect(requests[2]!.history!.at(-1)).toEqual({ text: reserved, type: "user" });
    expect(requests[1]!.history!.some((item) => item.type === "user" && item.text === reserved)).toBe(false);
    expect(requests[3]!.toolChoice).toBe("none");
    expect(requests[3]!.history!.some((item) => item.type === "user" && item.text === reserved)).toBe(false);
    expect(repo.recordMonitoringVerdict).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", userId: "owner", verdict: "no_update" });
    expect(memory.transcriptRows.some((item) => item.kind === "user" && item.text === reserved)).toBe(false);
    expect(memory.published()).toBe("Nothing new.");
  });

  it("tells the model when its occurrence can no longer take a verdict", async () => {
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { status: "goal_reached" }, id: "v1", name: VERDICT }] }, { text: "Done." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    repo.recordMonitoringVerdict.mockResolvedValue(false);
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ monitoringVerdictTool: true }), repository: asRepository(repo), scheduled: true, services: {},
      userId: "owner" }));
    expect(requests[1]!.history!.find((item) => item.type === "tool_result")).toMatchObject({ isError: true,
      output: expect.stringContaining("can no longer record") });
  });
});

describe("a scheduled run's flat context on the native engine", () => {
  const previous: TranscriptItem[] = [
    { id: "p0", kind: "compaction", origin: NATIVE_RUN_ORIGIN, summary: "SYNTHETIC OLDER RESULTS" },
    // The owner wrote into the earlier occurrence's running answer: not part of its result.
    { followup: true, id: "followup", kind: "user", text: "SYNTHETIC OLDER RESULTS" },
    { arguments: "{\"key\":\"A-1\"}", callId: "pc1", id: "p1", kind: "tool_call", name: "mcp_jira_get_issue", origin: NATIVE_RUN_ORIGIN },
    { callId: "pc1", id: "p2", kind: "tool_result", name: "mcp_jira_get_issue", outcome: "complete", output: "A-1: open" },
    { id: "p3", kind: "assistant_text", origin: NATIVE_RUN_ORIGIN, text: "A-1 is open." }
  ];
  const context = { messages: [nativeSay("previous-user", "user", "Check A-1"), nativeSay("previous-answer", "assistant", "A-1 is open."),
    nativeSay("current-user-message", "user", "Check A-1")], mode: "branch_path" as const };

  async function firstHistory(scheduled: boolean) {
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Still open." }]);
    const memory = memoryNativeEngine();
    memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["previous-answer", "run-0"]]));
    memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", previous]]));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: nativePrepared({ context }),
      repository: asRepository(nativeRunRepository()), ...(scheduled ? { scheduled: true as const } : {}), services: {}, userId: "owner" }));
    return requests[0]!.history!;
  }

  it("carries the previous result's own items, never a compaction of what came before it nor a follow-up", async () => {
    const flat = await firstHistory(true);
    expect(flat.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "assistant_text", "user", "user"]);
    expect(JSON.stringify(flat)).not.toContain("SYNTHETIC OLDER RESULTS");
    // An ordinary chat continues from the compaction.
    expect(JSON.stringify(await firstHistory(false))).toContain("SYNTHETIC OLDER RESULTS");
  });
});

describe("an unknown effect on the native engine", () => {
  const SHELL = namespacedWorkspaceToolName("sandbox_shell");
  const unknownShell: TranscriptItem[] = [
    { arguments: "{\"command\":\"post-report\"}", callId: "pc1", id: "u1", kind: "tool_call", name: SHELL, origin: NATIVE_RUN_ORIGIN },
    { callId: "pc1", id: "u2", kind: "tool_result", name: SHELL, outcome: "unknown", output: "The command may have run; its exit is unknown." },
    { id: "u3", kind: "assistant_text", origin: NATIVE_RUN_ORIGIN, text: "The report may have been posted." }
  ];
  const step = { kind: "review" as const, modelName: "Fake reviewer", reviewer: 1, round: 1, sessionId: "session-1", step: 1, version: 1 as const };

  /** One run whose model sends the same command again; `messages` is its frozen branch, the answer `answer-0` a native run's. */
  async function retry(messages: readonly ReturnType<typeof nativeSay>[], options: Readonly<{
    extra?: Partial<ProviderRunRequest>; repo?: ReturnType<typeof nativeRunRepository>; scheduled?: boolean;
  }> = {}) {
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { command: "post-report" }, id: "again", name: SHELL }] }, { text: "Done." }
    ]);
    const memory = memoryNativeEngine();
    memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-0", "run-0"]]));
    memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", unknownShell]]));
    const workspace = {
      accepts: () => true,
      execute: vi.fn(async ({ call }: { call: { id: string; name: string } }) => ({ callId: call.id,
        content: [{ text: "posted", type: "text" as const }], name: call.name, status: "complete" as const })),
      handoff: vi.fn(async () => ({ status: "ready" })),
      prepareCarryover: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      tools: vi.fn(async () => [{ capability: "workspace" as const, description: "Run a command", inputSchema: { type: "object" }, name: SHELL }])
    };
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ context: { messages: [...messages], mode: "branch_path" },
        workspace: { enabled: true, syncToolTimeoutSeconds: 30, turnTimeoutSeconds: 600 } as ProviderRunRequest["workspace"], ...options.extra }),
      repository: asRepository(options.repo ?? nativeRunRepository()), ...(options.scheduled ? { scheduled: true as const } : {}),
      services: {}, userId: "owner", workspace: workspace as unknown as WorkspaceCoordinator }));
    const result = requests[1]?.history?.find((item) => item.type === "tool_result" && item.callId === "again");
    return { execute: workspace.execute, output: result?.type === "tool_result" ? result.output : null };
  }

  const occurrence = [nativeSay("previous-user", "user", "Post the daily report"), nativeSay("answer-0", "assistant", "Maybe posted."),
    nativeSay("current-user-message", "user", "Post the daily report")];

  it("stays blocked through a scheduled occurrence's prompt, which the server wrote", async () => {
    const scheduled = await retry(occurrence, { scheduled: true });
    expect(scheduled.execute).not.toHaveBeenCalled();
    expect(scheduled.output).toBe(UNKNOWN_OUTCOME_REPEAT_OUTPUT);
    // The user's own message is what releases it.
    const asked = await retry(occurrence);
    expect(asked.execute).toHaveBeenCalledTimes(1);
  });

  it("stays blocked through an answer review step and the review turns the server wrote before it", async () => {
    const review = [nativeSay("question", "user", "Post the daily report"), nativeSay("answer-0", "assistant", "Maybe posted."),
      nativeSay("review-turn", "user", "Review the previous answer."), nativeSay("review-answer", "assistant", "It may be posted."),
      nativeSay("current-user-message", "user", "Review the previous answer.")];
    const marked = nativeRunRepository();
    marked.loadSystemTurnMessageIds.mockResolvedValue(new Set(["review-turn"]));
    const blocked = await retry(review, { extra: { answerReviewStep: step }, repo: marked });
    expect(blocked.execute).not.toHaveBeenCalled();
    expect(blocked.output).toBe(UNKNOWN_OUTCOME_REPEAT_OUTPUT);
    // Only the turns after the branch's first call are looked up.
    expect(marked.loadSystemTurnMessageIds).toHaveBeenCalledWith({ chatId: "chat", messageIds: ["review-turn"], userId: "owner" });
    // Turns that cannot be told apart count as the server's.
    const unread = nativeRunRepository();
    unread.loadSystemTurnMessageIds.mockRejectedValue(new Error("database restarted"));
    expect((await retry(review, { extra: { answerReviewStep: step }, repo: unread })).execute).not.toHaveBeenCalled();
    // An unmarked turn after the effect would count as the user writing.
    expect((await retry(review, { extra: { answerReviewStep: step } })).execute).toHaveBeenCalledTimes(1);
  });
});

describe("an Auto MCP run on the native engine", () => {
  const catalogOf = (...tools: ReadonlyArray<"create_issue" | "get_issue">): McpCapabilityCatalog => ({
    servers: [{ description: "Synthetic tracker", namespace: "jira", revisionId: "rev-1", serverId: "jira", serverName: "Jira",
      tools: tools.map((tool) => ({ arguments: [], description: tool === "get_issue" ? "Read" : "Create",
        namespacedName: `mcp_jira_${tool}`, originalName: tool })) }],
    version: 1
  });
  const loadedOf = (tool: "create_issue" | "get_issue"): McpRunPlanSnapshot => ({ servers: [...NATIVE_MCP_SNAPSHOT.servers],
    tools: NATIVE_MCP_SNAPSHOT.tools.filter((candidate) => candidate.originalName === tool), version: 1 });
  const autoBudgets = { maxMcpToolsPerDiscovery: 5, maxToolCalls: 8, maxToolRounds: 8 };
  const bound = { fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" };

  /**
   * A run's discovery as the repository keeps it: every epoch merges its servers into the run's snapshot and writes the
   * binding rows of the servers it loaded, which the engine reads back (`mcpBindingRows`). `admitted`: the run admitted
   * the server's binding (Load all). `allowed`: a call that needs the user's approval has it.
   */
  function autoDiscovery(catalog: McpCapabilityCatalog, options: Readonly<{ admitted?: boolean; allowed?: boolean }> = {}) {
    let snapshot: McpRunPlanSnapshot = { servers: [], tools: [], version: 1 };
    let discovery: McpDiscoveryState = { catalog, epochs: [], version: 2 };
    const rows: Array<Readonly<{ id: string; runtimeGenerationFingerprint: string; runtimeGenerationId: string | null }>> =
      options.admitted ? [{ id: "binding-jira", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" }] : [];
    const repo = { ...nativeRunRepository(), appendMcpDiscoveryEpoch: vi.fn(async (input: Readonly<{
      bindings: readonly Readonly<{ fingerprint: string; runtimeGenerationId: string; serverId: string }>[]; goal: string;
      modelRunToolCallId: string; roundIndex: number; snapshot: McpRunPlanSnapshot; toolIds: readonly string[];
    }>) => {
      snapshot = mergeMcpRunPlanSnapshots(snapshot, input.snapshot);
      discovery = { ...discovery, epochs: [...discovery.epochs, { epoch: discovery.epochs.length + 1, goal: input.goal,
        modelRunToolCallId: input.modelRunToolCallId, roundIndex: input.roundIndex, toolIds: [...input.toolIds] }] };
      for (const binding of input.bindings) {
        rows.push({ id: `binding-${binding.serverId}`, runtimeGenerationFingerprint: binding.fingerprint,
          runtimeGenerationId: binding.runtimeGenerationId });
      }
      return { discovery, snapshot };
    }) };
    const memory = memoryNativeEngine({ allowed: options.allowed ?? true });
    vi.mocked(memory.engine.mcpBindingRows).mockImplementation(async () => [...rows]);
    const callTool = vi.fn(async () => ({ isError: false, text: ["Done: A-2"], unsupportedContentTypes: [] }));
    return { callTool, discovery: () => discovery, memory, repo };
  }

  it("binds a server find_tools loaded mid-run and sends its tool", async () => {
    const auto = autoDiscovery(catalogOf("get_issue"));
    const { adapter } = scriptedNativeAdapter([
      { calls: [{ arguments: { query: "select:get_issue" }, id: "f1", name: "find_tools" }] },
      { calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] },
      { text: "A-1 is open." }
    ]);
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: auto.memory.engine,
      mcpRuntime: () => ({ callTool: auto.callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: nativePrepared({ mcpDiscovery: auto.discovery(), toolBudgets: autoBudgets }, { mcpBindings: [] }),
      repository: asRepository(auto.repo as unknown as ReturnType<typeof nativeRunRepository>),
      services: { mcp: { filterTools: async (_userId, tools) => [...tools], materialize: vi.fn(async () => ({
        bindings: [bound], ok: true as const, snapshot: loadedOf("get_issue") })) } },
      userId: "owner" }));
    expect(auto.repo.appendMcpDiscoveryEpoch).toHaveBeenCalledTimes(1);
    expect(auto.callTool).toHaveBeenCalledTimes(1);
    expect(auto.callTool).toHaveBeenCalledWith(expect.objectContaining({ generationId: "gen-1", name: "get_issue" }));
    expect(auto.memory.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ mcpRunBindingId: "binding-jira",
      toolName: "mcp_jira_get_issue" }));
    expect(auto.memory.published()).toBe("A-1 is open.");
  });

  describe("after the user's Allow", () => {
    const stopped: TranscriptItem[] = [
      { arguments: "{\"summary\":\"x\"}", callId: "call-1", id: "n1", kind: "tool_call", name: "mcp_jira_create_issue",
        origin: NATIVE_RUN_ORIGIN },
      { callId: "call-1", id: "n2", kind: "tool_result", name: "mcp_jira_create_issue", outcome: "error", output: "Waiting for approval." }
    ];

    /** The continuation of the turn the approval stopped, in a run that admitted the catalog and no MCP tool. */
    async function continueAllowed(catalog: McpCapabilityCatalog, materialize: () => Promise<unknown>) {
      const auto = autoDiscovery(catalog);
      const { adapter, requests } = scriptedNativeAdapter([{ text: "Created A-2." }]);
      vi.mocked(auto.memory.engine.approvedCall).mockResolvedValue({ providerCallId: "call-1", toolName: "mcp_jira_create_issue" });
      auto.memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-0", "run-0"]]));
      auto.memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", stopped]]));
      await nativeSseEvents(createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" }, created,
        engine: auto.memory.engine, mcpRuntime: () => ({ callTool: auto.callTool, ensureAcceptedGeneration: async () => true }) as never,
        prepared: nativePrepared({ context: { messages: [nativeSay("user-1", "user", "Create the issue"),
          nativeSay("answer-0", "assistant", ""), nativeSay("current-user-message", "user",
            "The user approved `Create` on `Jira`. Continue the task.")], mode: "branch_path" },
        mcpApproval: mcpApprovalAdmission([]), mcpDiscovery: auto.discovery(), toolBudgets: autoBudgets }, { mcpBindings: [] }),
        repository: asRepository(auto.repo as unknown as ReturnType<typeof nativeRunRepository>),
        services: { mcp: { filterTools: async (_userId, tools) => [...tools], materialize: vi.fn(materialize) as never } },
        userId: "owner" }));
      const history = requests[0]!.history!;
      // The run's turn context follows the approved call's result.
      const last = history.at(-2);
      return { ...auto, history, output: last?.type === "tool_result" ? last.output : null, request: requests[0]! };
    }

    it("loads the approved tool from the run's catalog through a discovery epoch and sends exactly the approved call", async () => {
      const run = await continueAllowed(catalogOf("get_issue", "create_issue"),
        async () => ({ bindings: [bound], ok: true, snapshot: loadedOf("create_issue") }));
      // The server's own find_tools, for exactly that tool, takes the epoch path a model's call takes.
      expect(run.repo.appendMcpDiscoveryEpoch).toHaveBeenCalledTimes(1);
      expect(run.repo.appendMcpDiscoveryEpoch).toHaveBeenCalledWith(expect.objectContaining({ goal: "select:mcp_jira_create_issue",
        modelRunToolCallId: "row-0", roundIndex: 0, toolIds: ["mcp_jira_create_issue"] }));
      expect(vi.mocked(run.memory.toolCalls.begin).mock.calls.map(([call]) => [call.toolName, call.roundIndex, call.ordinal,
        call.providerCallId])).toEqual([["find_tools", 0, 0, "aiqsa_approved_load_approval-1"],
        ["mcp_jira_create_issue", 0, 1, "call-1"]]);
      expect(run.memory.toolCalls.begin).toHaveBeenLastCalledWith(expect.objectContaining({ approval: expect.anything(),
        arguments: { summary: "x" }, mcpRunBindingId: "binding-jira" }));
      expect(run.callTool).toHaveBeenCalledTimes(1);
      expect(run.callTool).toHaveBeenCalledWith(expect.objectContaining({ arguments: { summary: "x" }, generationId: "gen-1",
        name: "create_issue" }));
      // The turn continues from the call's result, as with Load all; the server's load is no part of the conversation.
      expect(run.history.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "user"]);
      expect(run.output).toContain("Done: A-2");
      expect(toolNames(run.request)).toContain("mcp_jira_create_issue");
      expect(run.memory.published()).toBe("Created A-2.");
    });

    it("refuses an approved call whose tool left the run's catalog, visibly and without sending anything", async () => {
      const run = await continueAllowed(catalogOf("get_issue"), async () => { throw new Error("not expected"); });
      expect(run.repo.appendMcpDiscoveryEpoch).not.toHaveBeenCalled();
      expect(run.memory.toolCalls.begin).not.toHaveBeenCalled();
      expect(run.memory.toolCalls.refuse).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 0, providerCallId: "call-1",
        result: expect.objectContaining({ content: [{ type: "json", value: expect.objectContaining({ error: APPROVED_TOOL_UNAVAILABLE }) }] }),
        roundIndex: 0 }));
      expect(run.callTool).not.toHaveBeenCalled();
      expect(run.output).toBe(APPROVED_TOOL_UNAVAILABLE_OUTPUT);
      expect(run.memory.published()).toBe("Created A-2.");
    });

    it("refuses it when the approved tool's server cannot load, after the server's own find_tools", async () => {
      const run = await continueAllowed(catalogOf("create_issue"), async () => ({ code: "mcp_not_ready",
        issues: [{ errorCode: "mcp_runtime_unavailable", name: "Jira", readiness: "unavailable" }], ok: false }));
      expect(vi.mocked(run.memory.toolCalls.begin).mock.calls.map(([call]) => call.toolName)).toEqual(["find_tools"]);
      expect(run.memory.toolCalls.refuse).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 1, providerCallId: "call-1",
        roundIndex: 0 }));
      expect(run.callTool).not.toHaveBeenCalled();
      expect(run.output).toBe(APPROVED_TOOL_UNAVAILABLE_OUTPUT);
    });

    // Regression (codex review): a definite "not sent" settles the in-flight record, so standing consent keeps working.
    it("lets the approved call's own definite result settle its in-flight record", async () => {
      const run = autoDiscovery(catalogOf("create_issue"), { admitted: true });
      const { adapter, requests } = scriptedNativeAdapter([{ text: "It was not sent." }]);
      vi.mocked(run.memory.engine.approvedCall).mockResolvedValue({ providerCallId: "call-1", toolName: "mcp_jira_create_issue" });
      run.memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-0", "run-0"]]));
      run.memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", stopped]]));
      // Always allow; the server's runtime refuses before anything is sent.
      await nativeSseEvents(createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" }, created,
        engine: run.memory.engine, mcpRuntime: () => ({ callTool: run.callTool, ensureAcceptedGeneration: async () => false }) as never,
        prepared: nativePrepared({ context: { messages: [nativeSay("user-1", "user", "Create the issue"), nativeSay("answer-0", "assistant", ""),
          nativeSay("current-user-message", "user", "The user approved `Create` on `Jira`. Continue the task.")], mode: "branch_path" },
        mcp: NATIVE_MCP_SNAPSHOT, mcpApproval: mcpApprovalAdmission(["jira"]) }),
        repository: asRepository(run.repo as unknown as ReturnType<typeof nativeRunRepository>), services: {}, userId: "owner" }));
      expect(run.callTool).not.toHaveBeenCalled();
      expect(run.memory.transcriptRows.at(-2)).toMatchObject({ callId: "call-1", kind: "tool_result", outcome: "error" });
      expect(JSON.stringify(requests[0]!.history)).not.toContain(APPROVED_CALL_IN_FLIGHT_OUTPUT);
      expect(unknownEffectsOf([...stopped, ...run.memory.transcriptRows], () => false)
        .find({ arguments: { summary: "x" }, name: "mcp_jira_create_issue" })).toBeNull();
    });

    // Regression (codex review): the continuation's write went out, then Stop, a deadline or a restart ended the answer
    // before its result was recorded; under the server's standing consent (Always allow) a later turn sent it again.
    it.each(["auto", "load_all"] as const)("never sends an approved write twice after its continuation was interrupted (%s)",
      async (mode) => {
        let writes = 0;
        const auto = mode === "auto";
        const catalog = catalogOf("create_issue");
        // Both phases: the model asks for the same write, in Auto after loading its tool.
        const script = [
          ...(auto ? [{ calls: [{ arguments: { query: "select:mcp_jira_create_issue" }, id: "f1", name: "find_tools" }] }] : []),
          { calls: [{ arguments: { summary: "x" }, id: "again", name: "mcp_jira_create_issue" }] },
          { text: "Done" }
        ];
        const run = (phase: ReturnType<typeof autoDiscovery>) => ({
          ...(auto ? { mcpDiscovery: phase.discovery() } : { mcp: NATIVE_MCP_SNAPSHOT }),
          // Always allow: the server's writes need no approval.
          mcpApproval: mcpApprovalAdmission(["jira"]), toolBudgets: autoBudgets
        });
        const services = { mcp: { filterTools: async (_userId: string, tools: readonly unknown[]) => [...tools],
          materialize: vi.fn(async () => ({ bindings: [bound], ok: true, snapshot: loadedOf("create_issue") })) } } as never;
        const say = {
          answer0: nativeSay("answer-0", "assistant", ""), approved: nativeSay("continuation-turn", "user",
            "The user approved `Create` on `Jira`. Continue the task."), user: nativeSay("user-1", "user", "Create the issue")
        };

        // Phase 0: the approval continuation; the write reaches the server, then the answer is stopped.
        const sent = autoDiscovery(catalog, { admitted: !auto });
        vi.mocked(sent.memory.engine.approvedCall).mockResolvedValue({ providerCallId: "call-1", toolName: "mcp_jira_create_issue" });
        sent.memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-0", "run-0"]]));
        sent.memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", stopped]]));
        const interrupted = vi.fn(async () => {
          writes += 1;
          activeRunControllers.get(created.runId)?.abort();
          throw new Error("interrupted after remote write");
        });
        await nativeSseEvents(createNativeRunExecutionResponse({ adapter: scriptedNativeAdapter(script).adapter,
          approvalContinuation: { approvalId: "approval-1" }, created, engine: sent.memory.engine,
          mcpRuntime: () => ({ callTool: interrupted, ensureAcceptedGeneration: async () => true }) as never,
          prepared: nativePrepared({ context: { messages: [say.user, say.answer0, { ...say.approved, id: "current-user-message" }],
            mode: "branch_path" }, ...run(sent) }, auto ? { mcpBindings: [] } : {}),
          repository: asRepository(sent.repo as unknown as ReturnType<typeof nativeRunRepository>), services, userId: "owner" }));
        expect(writes).toBe(1);
        // The attempt is on record with an unknown outcome, superseding the earlier "not sent".
        expect(sent.memory.transcriptRows).toContainEqual(expect.objectContaining({ callId: "call-1", kind: "tool_result",
          outcome: "unknown", output: APPROVED_CALL_IN_FLIGHT_OUTPUT }));

        // Phase 1: the user's Continue over the interrupted answer's record; the model asks for the same write again. The
        // interrupted answer has no text, so the context leaves it out and its run is found as the parent of the Continue.
        const later = autoDiscovery(catalog, { admitted: !auto, allowed: false });
        later.memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-0", "run-0"]]));
        later.memory.transcripts.nativeRunsBeforeTurns.mockResolvedValue([{ assistantMessageId: "answer-1",
          nextUserMessageId: "continue-1", runId: "run-1" }]);
        later.memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", stopped], ["run-1", [...sent.memory.transcriptRows]]]));
        later.memory.transcripts.approvalContinuationTurns.mockResolvedValue(new Set(["continuation-turn"]));
        const succeeded = vi.fn(async () => {
          writes += 1;
          return { isError: false, text: ["Created A-3"], unsupportedContentTypes: [] };
        });
        await nativeSseEvents(createNativeRunExecutionResponse({ adapter: scriptedNativeAdapter(script).adapter,
          created: { assistantMessageId: "answer-2", runId: "run-2", userMessageId: "continue-1" }, engine: later.memory.engine,
          mcpRuntime: () => ({ callTool: succeeded, ensureAcceptedGeneration: async () => true }) as never,
          prepared: nativePrepared({ context: { messages: [say.user, say.answer0, say.approved,
            nativeSay("current-user-message", "user", "Continue")], mode: "branch_path" }, ...run(later) }, auto ? { mcpBindings: [] } : {}),
          repository: asRepository(later.repo as unknown as ReturnType<typeof nativeRunRepository>), services, userId: "owner" }));
        expect(writes).toBe(1);
        // The equivalent call waits for the user's decision on exactly it, whatever the server's consent.
        expect(later.memory.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ approval: expect.anything(),
          toolName: "mcp_jira_create_issue" }));
      });
  });
});

describe("a monthly rotation's carried Workspace on the native engine", () => {
  it("is restored before the first request", async () => {
    const order: string[] = [];
    const { adapter } = scriptedNativeAdapter([{ text: "Report ready." }], order);
    const memory = memoryNativeEngine();
    const workspace = {
      accepts: () => false,
      handoff: vi.fn(async () => ({ status: "ready" })),
      prepareCarryover: vi.fn(async () => { order.push("carryover"); }),
      settle: vi.fn(async () => undefined),
      tools: vi.fn(async () => [])
    };
    const result = await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ workspace: { enabled: true, syncToolTimeoutSeconds: 30, turnTimeoutSeconds: 600 } as ProviderRunRequest["workspace"] }),
      repository: asRepository(nativeRunRepository()), scheduled: true, services: {}, userId: "owner",
      workspace: workspace as unknown as WorkspaceCoordinator }));
    expect(result.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
    expect(workspace.prepareCarryover).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", userId: "owner" }));
    expect(order).toEqual(["carryover", "request"]);
  });
});

describe("an answer review step on the native engine", () => {
  const step = { kind: "review" as const, modelName: "Fake reviewer", reviewer: 0, round: 1, sessionId: "session-1", step: 0, version: 1 as const };

  it("publishes the step's card from its first report and refuses a second one", async () => {
    const review = { findings: [], verdict: "clean" };
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: review, id: "r1", name: "submit_answer_review" }, { arguments: review, id: "r2", name: "submit_answer_review" }] },
      { text: "The answer holds." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ answerReviewStep: step }), repository: asRepository(repo), services: {}, userId: "user" }));
    expect(toolNames(requests[0])).toContain("submit_answer_review");
    const cards = repo.appendRunOutputEvent.mock.calls.map(([, event]) => event as ModelRunSseEvent)
      .filter((event) => event.type === "artifact" && event.data.artifactType === "answer_review");
    expect(cards).toEqual([{ data: { artifactType: "answer_review", payload: { findings: [], reviewer: 0, reviewerName: "Fake reviewer",
      round: 1, verdict: "clean", version: 1 } }, type: "artifact" }]);
    const results = memory.transcriptRows.filter((item) => item.kind === "tool_result");
    expect(results.map((item) => item.kind === "tool_result" && [item.callId, item.outcome])).toEqual([["r1", "complete"], ["r2", "error"]]);
    expect(memory.published()).toBe("The answer holds.");
  });
});

describe("the tools a native run is offered by kind", () => {
  const secrets: RunSecretSource = { list: vi.fn(async () => []), read: vi.fn() };
  const native = (memory: ReturnType<typeof memoryNativeEngine>): NativeEngineHandlerDeps => ({
    engine: memory.engine,
    findOrphans: async () => [],
    findRetiredRuns: async () => [],
    tools: { secrets, selfService: { assistants: {} as never, db: {} as never, storage: {} as never } }
  });

  async function offered(data: Partial<MaterializedPreparedRunData>, extra: Partial<ProviderRunRequest> = {},
    entry: Readonly<{ scheduled?: boolean; telegram?: boolean }> = {}) {
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Hi." }]);
    const memory = memoryNativeEngine();
    await nativeSseEvents(nativeRunResponse(native(memory), { adapter, created, prepared: nativePrepared(extra, data),
      repository: asRepository(nativeRunRepository()), ...entry, services: {}, userId: "user" }));
    return { request: requests[0]!, tools: toolNames(requests[0]) };
  }

  it("gives a web personal chat the self-service tools, and an Assistant chat, a scheduled run or a Telegram turn none", async () => {
    expect((await offered({})).tools).toEqual(expect.arrayContaining(["read_secret", "manage_secret", "manage_skill", "manage_assistant"]));
    for (const run of [await offered({ assistant: {} as never }), await offered({ chatAssistant: {} as never }),
      await offered({}, {}, { scheduled: true }), await offered({}, {}, { telegram: true })]) {
      expect(run.tools).toContain("read_secret");
      expect(run.tools).not.toContain("manage_secret");
      expect(run.tools).not.toContain("manage_assistant");
    }
    // A scheduled monitoring check takes its verdict tool, never a self-service one.
    const check = await offered({}, { monitoringVerdictTool: true }, { scheduled: true });
    expect(check.tools).toContain(VERDICT);
    expect(check.tools).not.toContain("manage_skill");
  });

  it("puts an Assistant's own instructions after the family prompt and keeps its answer rules", async () => {
    const baseline = resolveAssistantChatBaseline({ now: new Date("2026-10-23T06:00:00Z"), timeZone: "Europe/Moscow" });
    const { request } = await offered({ assistant: {} as never }, { prompt: {
      baseline: { source: "assistant_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" }, developer: "Answer in haiku.",
      responseReminder: "Remember: haiku.", system: `${baseline.renderedSystemPrompt}\n\nYou are Ada, a synthetic travel planner.`
    } });
    const system = request.prompt.system!;
    expect(system.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    expect(system.indexOf("You are Ada, a synthetic travel planner.")).toBeGreaterThan(NEUTRAL_FAMILY_PROMPT.length);
    expect(system).not.toContain(baseline.renderedSystemPrompt);
    expect(request.prompt).toMatchObject({ developer: "Answer in haiku.", responseReminder: "Remember: haiku." });
  });
});

// Regression (codex review): an old-core write reached its server and the upgrade retired its run with the outcome
// unknown. After Continue, the model asks for the same write on a server with Always allow.
describe("an unknown write the old core left on the branch", () => {
  const write = { arguments: { summary: "x" }, id: "again", name: "mcp_jira_create_issue" };
  const retired = [{ assistantMessageId: "old-answer", userMessageId: "old-question", items: [
    { arguments: "{\"summary\":\"x\"}", callId: "retired-row-1", id: "retired-row-1-call", kind: "tool_call", name: write.name },
    { callId: "retired-row-1", id: "retired-row-1-result", kind: "tool_result", name: write.name, outcome: "unknown", output: "" }
  ] satisfies TranscriptItem[] }];

  async function continueOverRetired(effects: typeof retired) {
    const { adapter } = scriptedNativeAdapter([{ calls: [write] }, { text: "Done." }]);
    const memory = memoryNativeEngine();
    memory.transcripts.retiredRunEffects.mockResolvedValue(effects);
    const callTool = vi.fn(async () => ({ isError: false, text: ["Created A-2"], unsupportedContentTypes: [] }));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created: { ...created, userMessageId: "current-user-message" },
      engine: memory.engine, mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: nativePrepared({ context: { messages: [nativeSay("old-question", "user", "Create the issue"),
        nativeSay("old-answer", "assistant", "Creating it now."), nativeSay("current-user-message", "user", "Continue")],
      mode: "branch_path" }, mcp: NATIVE_MCP_SNAPSHOT, mcpApproval: mcpApprovalAdmission(["jira"]) }),
      repository: asRepository(nativeRunRepository()), services: {}, userId: "owner" }));
    return { callTool, memory };
  }

  it("waits for the user's approval of exactly that call, whatever the server's consent", async () => {
    const run = await continueOverRetired(retired);
    expect(run.memory.transcripts.retiredRunEffects).toHaveBeenCalledWith({ assistantMessageIds: ["old-answer"], chatId: "chat",
      userId: "owner", userMessageIds: ["current-user-message", "old-question"] });
    expect(run.callTool).not.toHaveBeenCalled();
    expect(run.memory.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ approval: expect.anything(),
      toolName: write.name }));
    // The old answer stays text: its records never reach the model's history or the transcript.
    expect(run.memory.transcriptRows.some((item) => item.id.startsWith("retired-"))).toBe(false);
  });

  it("sends it under Always allow when the old core left nothing unknown", async () => {
    const run = await continueOverRetired([]);
    expect(run.callTool).toHaveBeenCalledTimes(1);
    expect(run.memory.toolCalls.begin).toHaveBeenCalledWith(expect.not.objectContaining({ approval: expect.anything() }));
  });
});

// Regression: a native run sent a write, then a restart interrupted it before any answer text. The context leaves an answer
// without text out, so after Continue the model lost its own steps and the guard lost the unknown effect, and under Always
// allow the same write went out twice.
describe("a native run interrupted before any answer text", () => {
  const write = { arguments: { summary: "x" }, id: "again", name: "mcp_jira_create_issue" };
  const interrupted: TranscriptItem[] = [
    { arguments: "{\"summary\":\"x\"}", callId: "call-1", id: "n1", kind: "tool_call", name: write.name, origin: NATIVE_RUN_ORIGIN }
  ];
  type Row = Readonly<{ id: string; parent?: string; role: "assistant" | "user"; status: string; text: string }>;
  const row = (id: string, role: Row["role"], text: string, parent?: string, status = "complete"): Row =>
    ({ id, role, status, text, ...(parent ? { parent } : {}) });

  /** Continue (`continue-1`) after `leaf`, with the chat's messages and its native runs as the database holds them. */
  async function continueAfter(rows: readonly Row[], leaf: string) {
    const byId = new Map(rows.map((entry) => [entry.id, entry]));
    const path: Row[] = [];
    for (let at = byId.get(leaf); at; at = at.parent ? byId.get(at.parent) : undefined) path.unshift(at);
    const all = [...rows, row("continue-1", "user", "Continue", leaf)];
    const runs = new Map([["answer-1", "run-1"]]);
    // The real context path, then the run's own message as a send adds it.
    const messages = [...conversationMessagesFromPathRows(path.map((entry) => ({ chatId: "chat",
      messageContent: textMessageContent(entry.text), messageId: entry.id, messageRole: entry.role, messageStatus: entry.status }))),
    nativeSay("current-user-message", "user", "Continue")];
    const { adapter, requests } = scriptedNativeAdapter([{ calls: [write] }, { text: "Done." }]);
    const memory = memoryNativeEngine();
    memory.transcripts.loadRuns.mockImplementation(async ({ runIds }) =>
      new Map(runIds.map((runId): [string, TranscriptItem[]] => [runId, runId === "run-1" ? interrupted : []])));
    // As the database answers it: a stopped native answer whose child is one of these turns.
    memory.transcripts.nativeRunsBeforeTurns.mockImplementation(async ({ userMessageIds }) => all.flatMap((answer) => {
      const next = all.find((entry) => entry.parent === answer.id && userMessageIds.includes(entry.id));
      const runId = runs.get(answer.id);
      return answer.role === "assistant" && ["cancelled", "error"].includes(answer.status) && next && runId
        ? [{ assistantMessageId: answer.id, nextUserMessageId: next.id, runId }] : [];
    }));
    const callTool = vi.fn(async () => ({ isError: false, text: ["Created A-2"], unsupportedContentTypes: [] }));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created: { assistantMessageId: "answer-2", runId: "run-2",
      userMessageId: "continue-1" }, engine: memory.engine,
    mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
    prepared: nativePrepared({ context: { messages, mode: "branch_path" }, mcp: NATIVE_MCP_SNAPSHOT,
      // Always allow: the server's writes need no approval.
      mcpApproval: mcpApprovalAdmission(["jira"]) }),
    repository: asRepository(nativeRunRepository()), services: {}, userId: "owner" }));
    return { callTool, history: requests[0]!.history!, memory, messages };
  }

  it("keeps the run's tool steps after Continue and gates an equivalent write with an approval", async () => {
    const run = await continueAfter([row("user-1", "user", "Create the issue"),
      row("answer-1", "assistant", "", "user-1", "error")], "answer-1");
    // The real context path has no trace of the stopped answer.
    expect(run.messages.map((message) => message.id)).toEqual(["user-1", "current-user-message"]);
    expect(run.history.slice(0, 3)).toEqual([
      expect.objectContaining({ text: "Create the issue", type: "user" }),
      expect.objectContaining({ callId: "call-1", name: write.name, type: "tool_call" }),
      expect.objectContaining({ callId: "call-1", type: "tool_result" })
    ]);
    expect(run.callTool).not.toHaveBeenCalled();
    expect(run.memory.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ approval: expect.anything(),
      toolName: write.name }));
  });

  it("takes nothing from an interrupted run on a sibling branch", async () => {
    const run = await continueAfter([row("user-1", "user", "Create the issue"),
      row("answer-1", "assistant", "", "user-1", "error"),
      row("answer-b", "assistant", "Which project?", "user-1")], "answer-b");
    expect(run.messages.map((message) => message.id)).toEqual(["user-1", "answer-b", "current-user-message"]);
    expect(run.history.some((item) => item.type === "tool_call" && item.callId === "call-1")).toBe(false);
    expect(run.callTool).toHaveBeenCalledTimes(1);
    expect(run.memory.toolCalls.begin).toHaveBeenCalledWith(expect.not.objectContaining({ approval: expect.anything() }));
  });
});

// Regression: a native answer's delivered follow-up and the text before it reached later turns twice, as the context's
// follow-up messages and in the answer's own items.
describe("a native answer that took follow-ups", () => {
  it("reaches the next turn's model with each delivered follow-up once and the undelivered one kept", async () => {
    const messages = [...conversationMessagesFromPathRows([
      { chatId: "chat", messageContent: textMessageContent("Write a poem"), messageId: "user-1", messageRole: "user",
        messageStatus: "complete" },
      { chatId: "chat", messageContent: textMessageContent("Roses are red, violets are blue."), messageId: "answer-1",
        messageParentId: "user-1", messageRole: "assistant", messageStatus: "complete", followups: [
          { delivered: true, id: "f1", ordinal: 1, precedingText: "Roses are red", text: "Make it rhyme" },
          { delivered: false, id: "f2", ordinal: 2, precedingText: null, text: "Add a title" }
        ] }
    ]), nativeSay("current-user-message", "user", "Shorter")];
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Done." }]);
    const memory = memoryNativeEngine();
    memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-1", "run-0"]]));
    memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", [
      { id: "a1", kind: "assistant_text", origin: NATIVE_RUN_ORIGIN, text: "Roses are red" },
      { followup: true, id: "u1", kind: "user", text: "Make it rhyme" },
      { id: "a2", kind: "assistant_text", origin: NATIVE_RUN_ORIGIN, text: "Roses are red, violets are blue." }
    ] satisfies TranscriptItem[]]]));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created: { assistantMessageId: "answer-2", runId: "run-2",
      userMessageId: "user-2" }, engine: memory.engine, prepared: nativePrepared({ context: { messages, mode: "branch_path" } }),
    repository: asRepository(nativeRunRepository()), services: {}, userId: "owner" }));
    const sent = JSON.stringify(requests[0]!.history);
    expect(sent.split("Make it rhyme")).toHaveLength(2);
    expect(sent).not.toContain("Partial answer before follow-up");
    expect(sent).toContain("Follow-up not delivered to the previous answer:\\nAdd a title");
  });
});
