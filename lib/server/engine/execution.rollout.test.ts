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
import type { ProviderRunRequest } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { monitoringCheckInstruction, monitoringVerdictReservedInstruction } from "../tools/monitoringVerdict";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { createNativeRunExecutionResponse } from "./execution";
import { nativeRunResponse, type NativeEngineHandlerDeps } from "./handlerSupport";
import { NEUTRAL_FAMILY_PROMPT } from "./prompts/neutral";
import { parseNativeEngineUsers } from "./routing";
import type { TranscriptItem } from "./transcript";

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

  it("carries the previous result's own items, never a compaction of what came before it", async () => {
    const flat = await firstHistory(true);
    expect(flat.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "assistant_text", "user"]);
    expect(JSON.stringify(flat)).not.toContain("SYNTHETIC OLDER RESULTS");
    // An ordinary chat continues from the compaction.
    expect(JSON.stringify(await firstHistory(false))).toContain("SYNTHETIC OLDER RESULTS");
  });
});

describe("an Auto MCP run on the native engine", () => {
  const catalog: McpCapabilityCatalog = {
    servers: [{ description: "Synthetic tracker", namespace: "jira", revisionId: "rev-1", serverId: "jira", serverName: "Jira",
      tools: [{ arguments: [], description: "Read", namespacedName: "mcp_jira_get_issue", originalName: "get_issue" }] }],
    version: 1
  };
  const loaded: McpRunPlanSnapshot = { servers: [...NATIVE_MCP_SNAPSHOT.servers], tools: [NATIVE_MCP_SNAPSHOT.tools[0]!], version: 1 };
  const autoBudgets = { maxMcpToolsPerDiscovery: 5, maxToolCalls: 8, maxToolRounds: 8 };

  it("binds a server find_tools loaded mid-run and sends its tool", async () => {
    let snapshot: McpRunPlanSnapshot = { servers: [], tools: [], version: 1 };
    let discovery: McpDiscoveryState = { catalog, epochs: [], version: 2 };
    const rows: Array<Readonly<{ id: string; runtimeGenerationFingerprint: string; runtimeGenerationId: string | null }>> = [];
    const repo = { ...nativeRunRepository(), appendMcpDiscoveryEpoch: vi.fn(async (input: Readonly<{ goal: string; modelRunToolCallId: string;
      roundIndex: number; snapshot: McpRunPlanSnapshot; toolIds: readonly string[] }>) => {
      snapshot = mergeMcpRunPlanSnapshots(snapshot, input.snapshot);
      discovery = { ...discovery, epochs: [...discovery.epochs, { epoch: discovery.epochs.length + 1, goal: input.goal,
        modelRunToolCallId: input.modelRunToolCallId, roundIndex: input.roundIndex, toolIds: [...input.toolIds] }] };
      // The epoch writes the loaded server's binding row with the run.
      rows.push({ id: "binding-jira", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" });
      return { discovery, snapshot };
    }) };
    const memory = memoryNativeEngine();
    vi.mocked(memory.engine.mcpBindingRows).mockImplementation(async () => [...rows]);
    const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
    const { adapter } = scriptedNativeAdapter([
      { calls: [{ arguments: { query: "select:get_issue" }, id: "f1", name: "find_tools" }] },
      { calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] },
      { text: "A-1 is open." }
    ]);
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: nativePrepared({ mcpDiscovery: discovery, toolBudgets: autoBudgets }, { mcpBindings: [] }),
      repository: asRepository(repo as unknown as ReturnType<typeof nativeRunRepository>),
      services: { mcp: { filterTools: async (_userId, tools) => [...tools], materialize: vi.fn(async () => ({
        bindings: [{ fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" }], ok: true as const, snapshot: loaded })) } },
      userId: "owner" }));
    expect(repo.appendMcpDiscoveryEpoch).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ generationId: "gen-1", name: "get_issue" }));
    expect(memory.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ mcpRunBindingId: "binding-jira",
      toolName: "mcp_jira_get_issue" }));
    expect(memory.published()).toBe("A-1 is open.");
  });

  it("continues an approval from the server's turn when its tool is not loaded yet, so the model loads and calls it again", async () => {
    const stopped: TranscriptItem[] = [
      { arguments: "{\"summary\":\"x\"}", callId: "call-1", id: "n1", kind: "tool_call", name: "mcp_jira_create_issue",
        origin: NATIVE_RUN_ORIGIN },
      { callId: "call-1", id: "n2", kind: "tool_result", name: "mcp_jira_create_issue", outcome: "error", output: "Waiting for approval." }
    ];
    const { adapter, requests } = scriptedNativeAdapter([{ text: "I will load the tool and create it." }]);
    const memory = memoryNativeEngine({ allowed: true });
    vi.mocked(memory.engine.approvedCall).mockResolvedValue({ providerCallId: "call-1", toolName: "mcp_jira_create_issue" });
    memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["answer-0", "run-0"]]));
    memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", stopped]]));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" }, created,
      engine: memory.engine, prepared: nativePrepared({ context: { messages: [nativeSay("user-1", "user", "Create the issue"),
        nativeSay("answer-0", "assistant", ""), nativeSay("current-user-message", "user",
          "The user approved `Create` on `Jira`. Continue the task.")], mode: "branch_path" }, mcpDiscovery: { catalog, epochs: [],
        version: 2 }, toolBudgets: autoBudgets }, { mcpBindings: [] }), repository: asRepository(nativeRunRepository()), services: {},
      userId: "owner" }));
    // Nothing was sent before the model asked: the approved call waits for its tool to load, and the Allow covers it then.
    expect(memory.toolCalls.begin).not.toHaveBeenCalled();
    expect(requests[0]!.history!.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "user"]);
    expect(requests[0]!.history!.at(-1)).toMatchObject({ currentInput: true, type: "user" });
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
    allowlist: () => parseNativeEngineUsers("*"),
    engine: memory.engine,
    findOrphans: async () => [],
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
