// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NATIVE_MCP_SNAPSHOT } from "@/tests/support/nativeRunExecution";
import { FakeSubagentBackgroundControl } from "@/tests/support/subagentPorts";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { mergeMcpRunPlanSnapshots } from "../mcp/discovery";
import type { McpDiscoveryState, McpRunPlanBinding, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { NativeRunStore } from "./runStore";
import { backgroundSubagentRunner } from "./subagents/backgroundRunner";
import type { SubagentThreadStore } from "./subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { ToolRegistryInput } from "./toolRegistry";
import type { TranscriptItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";

/**
 * A background sub-agent's own `find_tools` under Auto (production 2026-11-20: 65 calls of such tools refused as
 * `tool_binding_unavailable`): its epoch binds on its own run, the only run it locks (`prismaRepositoryMcpDiscovery.ts`),
 * and its registry reads that run's rows beside the main-agent run's, into a map no other agent's calls read.
 */

const registries = vi.hoisted(() => [] as ToolRegistryInput[]);
vi.mock("./toolRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toolRegistry")>();
  return { ...actual, buildToolRegistry: vi.fn(async (input: ToolRegistryInput) => {
    registries.push(input);
    return actual.buildToolRegistry(input);
  }) };
});

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>;
type BindingRow = Readonly<{ id: string; runId: string; runtimeGenerationFingerprint: string; runtimeGenerationId: string }>;

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };
const catalog = { servers: [{ description: "Synthetic tracker", namespace: "jira", revisionId: "rev-1", serverId: "jira", serverName: "Jira",
  tools: [{ arguments: [], description: "Read", namespacedName: "mcp_jira_get_issue", originalName: "get_issue" }] }], version: 1 as const };
const getIssue: McpRunPlanSnapshot = { servers: [...NATIVE_MCP_SNAPSHOT.servers],
  tools: NATIVE_MCP_SNAPSHOT.tools.filter((tool) => tool.originalName === "get_issue"), version: 1 };
const bound: McpRunPlanBinding = { fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" };

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

/**
 * The engine's stores in memory, with each run's `McpRunBinding` rows (`rows`): an epoch writes the rows of the servers it
 * loaded on the run it names, as `appendMcpDiscoveryEpoch` does, and `mcpBindingRows` reads one run's.
 */
function engine(rows: BindingRow[]) {
  const toolRows = new Map<string, ToolCallRow>();
  const runs = new Map<string, { discovery: McpDiscoveryState; snapshot: McpRunPlanSnapshot | undefined }>();
  const begin = vi.fn(async (input: Parameters<ToolCallStore["begin"]>[0]): Promise<ToolCallBeginResult> => {
    const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${toolRows.size}`, ordinal: input.ordinal,
      providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: "now", state: "running", toolName: input.toolName };
    toolRows.set(row.id, row);
    return { kind: "running", row };
  });
  const transcripts = {
    append: vi.fn(async () => undefined),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async (input: { runIds: readonly string[] }) => new Map(input.runIds.map((id) => [id, [] as TranscriptItem[]]))),
    nativeRunsForAnswers: vi.fn(async () => new Map<string, string>()),
    nativeRunsBeforeTurns: vi.fn(async () => []),
    retiredRunEffects: vi.fn(async () => []),
    nextSequence: vi.fn(async () => 0),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const store = {
    applyUsageTotals: vi.fn(async () => undefined), complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async () => true), recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true), workDurationMs: vi.fn(async () => null as number | null),
    writeUsageRows: vi.fn(async () => undefined)
  } satisfies NativeRunStore;
  const threads = {
    ensureThread: vi.fn(async (input: { name: string; parentRunId: string }) => ({ anchorRunId: input.parentRunId, definitionId: null,
      id: "thread-bg", name: input.name, parentThreadId: null, typeName: null })),
    find: vi.fn(async () => null), result: vi.fn(async () => null), activeChildren: vi.fn(async () => 0), childResults: vi.fn(async () => []),
    endOrphanedTurns: vi.fn(async () => 0), setActiveState: vi.fn(async () => true), threadEffectItems: vi.fn(async () => []),
    backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]),
    settle: vi.fn(async () => true)
  } as unknown as SubagentThreadStore;
  const mcpBindingRows = vi.fn(async (runId: string) => rows.filter((row) => row.runId === runId)
    .map(({ runId: _run, ...row }) => row));
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows,
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    runs: store, savedResults: { read: vi.fn(async () => null) }, subagentThreads: threads,
    toolCalls: { begin, refuse: vi.fn(async () => null), settle: vi.fn(async () => true) }, transcripts
  };
  const appendMcpDiscoveryEpoch = vi.fn(async (input: Readonly<{ bindings: readonly McpRunPlanBinding[]; goal: string;
    modelRunToolCallId: string; roundIndex: number; runId: string; snapshot: McpRunPlanSnapshot; toolIds: readonly string[] }>) => {
    const run = runs.get(input.runId) ?? { discovery: { catalog, epochs: [], version: 2 as const }, snapshot: undefined };
    const snapshot = mergeMcpRunPlanSnapshots(run.snapshot, input.snapshot);
    const discovery: McpDiscoveryState = { ...run.discovery, epochs: [...run.discovery.epochs, { epoch: run.discovery.epochs.length + 1,
      goal: input.goal, modelRunToolCallId: input.modelRunToolCallId, roundIndex: input.roundIndex, toolIds: [...input.toolIds] }] };
    runs.set(input.runId, { discovery, snapshot });
    for (const binding of input.bindings) {
      if (rows.some((row) => row.runId === input.runId && row.runtimeGenerationFingerprint === binding.fingerprint)) continue;
      rows.push({ id: `binding-${input.runId}-${binding.serverId}`, runId: input.runId, runtimeGenerationFingerprint: binding.fingerprint,
        runtimeGenerationId: binding.runtimeGenerationId });
    }
    return { discovery, snapshot };
  });
  const repository = {
    appendAssistantText: vi.fn(async () => undefined), appendMcpDiscoveryEpoch,
    appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event), failRun: vi.fn(async () => true),
    getChatUpdateForRun: vi.fn(async () => null), getRunControlForUser: vi.fn(async () => ({ status: "streaming" })),
    loadModelPricing: vi.fn(async () => null), loadProviderModelCostBasis: vi.fn(async () => null),
    loadRunMcpApprovalCards: vi.fn(async () => []), markRunAnswerStarted: vi.fn(async () => undefined)
  };
  return { appendMcpDiscoveryEpoch, begin, deps, repository: repository as unknown as RunRepository };
}

function prepared(): MaterializedPreparedRunData {
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "Watch issue A-1.", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "Watch issue A-1.", type: "text" }] }, id: "current-user-message",
      role: "user" as const }], mode: "branch_path" as const },
    mcpDiscovery: { catalog, epochs: [], version: 2 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: "Be brief." }, provider: "fake",
    reasoningEffort: null, searchPlan: { mode: "all_selected" as const, options: [] }, toolBudgets: { maxMcpToolsPerDiscovery: 5,
      maxToolCalls: 8, maxToolRounds: 8 }, toolMode: "auto" as const
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake",
        upstreamModelId: "fake-qsa" }, providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

/**
 * The main agent starts a background sub-agent and answers; then the sub-agent's turn runs in its own run (`run-bg`): it
 * loads the tracker's `get_issue` with `find_tools` and calls it.
 */
async function backgroundLoadsAndCalls(rows: BindingRow[]) {
  registries.length = 0;
  const { adapter } = scriptedAdapter([
    { calls: [{ arguments: { background: true, message: "Watch issue A-1.", name: "watcher" }, id: "call-bg", name: CALL_SUBAGENT_TOOL_NAME }] },
    { text: "The watcher runs in the background." },
    { calls: [{ arguments: { query: "select:mcp_jira_get_issue" }, id: "f1", name: "find_tools" }] },
    { calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] },
    { text: "Outcome: done\nA-1 is open." }
  ]);
  const memory = engine(rows);
  const background = new FakeSubagentBackgroundControl();
  const callTool = vi.fn(async () => ({ isError: false, text: ["A-1 is open"], unsupportedContentTypes: [] }));
  await createNativeRunExecutionResponse({ adapter, created, engine: memory.deps,
    mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never, prepared: prepared(),
    repository: memory.repository, services: { mcp: { filterTools: async (_userId, tools) => [...tools],
      materialize: vi.fn(async () => ({ bindings: [bound], ok: true as const, snapshot: getIssue })) } },
    subagents: { background }, userId: "user" }).text();
  const [started] = background.turns;
  const turn = { ...started!.input, deadlineAt: new Date(Date.now() + 60_000), hostRunId: "run-bg", mode: "background" as const,
    parentToolCallId: started!.input.parentToolCallId, signal: new AbortController().signal, turnId: "turn-bg" };
  const result = await backgroundSubagentRunner.wait(await backgroundSubagentRunner.start(turn));
  return { ...memory, callTool, result };
}

describe("a background sub-agent's own find_tools under Auto", () => {
  it("binds what it loads on its own run and calls the tool under that binding", async () => {
    const run = await backgroundLoadsAndCalls([]);
    expect(run.result).toMatchObject({ kind: "ended", outcome: "done", state: "done" });
    expect(run.appendMcpDiscoveryEpoch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: "run-bg" }));
    expect(run.begin).toHaveBeenCalledWith(expect.objectContaining({ mcpRunBindingId: "binding-run-bg-jira", runId: "run-bg",
      toolName: "mcp_jira_get_issue" }));
    expect(run.callTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ generationId: "gen-1", name: "get_issue" }));
  });

  it("takes its own row over the main-agent run's for a server both bound", async () => {
    const run = await backgroundLoadsAndCalls([{ id: "binding-run-1-jira", runId: "run-1", runtimeGenerationFingerprint: "fp-1",
      runtimeGenerationId: "gen-1" }]);
    expect(run.begin).toHaveBeenCalledWith(expect.objectContaining({ mcpRunBindingId: "binding-run-bg-jira", toolName: "mcp_jira_get_issue" }));
    expect(run.callTool).toHaveBeenCalledOnce();
  });

  it("reads its own rows, then the main-agent run's for every server it bound none of, and no other run's", async () => {
    const row = (runId: string, server: string, fingerprint: string): BindingRow => ({ id: `binding-${runId}-${server}`, runId,
      runtimeGenerationFingerprint: fingerprint, runtimeGenerationId: `gen-${server}` });
    await backgroundLoadsAndCalls([row("run-1", "jira", "fp-1"), row("run-1", "wiki", "fp-2"), row("run-other", "files", "fp-3")]);
    const backgroundRegistry = registries.find((input) => input.runId === "run-bg");
    expect((await backgroundRegistry!.loadMcpBindingRows!()).map((loaded) => loaded.id))
      .toEqual(["binding-run-bg-jira", "binding-run-1-wiki"]);
  });

  it("keeps its run's rows out of every other agent's map", async () => {
    await backgroundLoadsAndCalls([]);
    const main = registries.find((input) => input.runId === "run-1" && input.agent?.kind === "main");
    const backgroundRegistry = registries.find((input) => input.runId === "run-bg");
    expect(main && backgroundRegistry).toBeTruthy();
    expect(backgroundRegistry!.mcpBindings).not.toBe(main!.mcpBindings);
    expect(backgroundRegistry!.mcpBindings.get("jira")).toMatchObject({ mcpRunBindingId: "binding-run-bg-jira" });
    expect([...main!.mcpBindings.values()]).toEqual([]);
  });
});
