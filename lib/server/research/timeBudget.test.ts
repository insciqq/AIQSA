import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TIME_MS, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME } from "../../contracts/research";
import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_END_REASONS } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { createNativeRunExecutionResponse, NATIVE_TURN_LIMITS, type NativeEngineDeps } from "../engine/execution";
import { createNativeOrphanFinder, reconcileNativeRuns } from "../engine/recovery";
import type { NativeRunStore } from "../engine/runStore";
import { backgroundSubagentRunner } from "../engine/subagents/backgroundRunner";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { DEFAULT_TOOL_RUN_BUDGETS } from "../runs/toolBudgets";
import type { SubagentCallerScope, SubagentMessaging, SubagentSendInput } from "../subagents/ports";
import { researchDraftReservedInstruction } from "../tools/research";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { createResearchClock, RESEARCHERS_CLOSED, RESEARCHERS_FINISH } from "./clock";
import type { ResearchGate, ResearchSubagentOutcome } from "./gates";
import { researchNote } from "./notes";
import { proposeCall } from "./planWindow.testFixtures";
import type { ResearchPlanWindowPort } from "./ports";
import { RESEARCHER_TIME_ENDED, type ResearchEngineDeps } from "./run";
import type { ResearchVerifierRole } from "./verifierRole";

/**
 * The time budget end to end: the real engine, runner and clock on a fake clock and a scripted model. Everything here is what a
 * partial extension breaks, so it runs with and without a Workspace, whose turn comes from another setting.
 */
const time = RESEARCH_TIME_MS;
const minutes = (count: number) => count * 60_000;

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: boolean; hang?: boolean; sleepMs?: number; text?: string }>;
type Seen = Readonly<{ at: number; request: ProviderRunRequest }>;

const aborted = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) =>
  signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true }));

const sleep = (ms: number, signal: AbortSignal | undefined) => Promise.race([new Promise<void>((resolve) => { setTimeout(resolve, ms); }), aborted(signal)]);

/** The model of the main agent and of every sub-agent, told apart by the research tools only the main agent has. */
function scripted(main: readonly Step[], agents: readonly Step[] = []) {
  const seen = { agents: [] as Seen[], main: [] as Seen[] };
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const own = request.tools?.some((tool) => tool.name === START_RESEARCH_TOOL_NAME) ? { lane: seen.main, script: main } : { lane: seen.agents, script: agents };
      own.lane.push({ at: Date.now(), request });
      const step = own.script[Math.min(own.lane.length - 1, own.script.length - 1)]!;
      if (step.sleepMs) await sleep(step.sleepMs, options.signal);
      if (step.hang) await aborted(options.signal);
      options.signal?.throwIfAborted();
      if (step.fail) throw Object.assign(new Error("HTTP 503"), { status: 503 });
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])], usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, seen };
}

const PLAN = { goal: "Choose a mattress.", questions: [
  { question: "Which mattress holds up?", sites: [], source_classes: ["primary_official", "independent_tests"] },
  { question: "What do owners and shops say?", sites: ["shop.example"], source_classes: ["owner_reviews", "action_channel"] }
], skipped_source_classes: [] };
const REPORT = "# Report\n\nConfirmed: the X1 holds up.";
const DRAFT = { findings: [{ claim: "The X1 holds up.", quote: "held up after 10 years", source_class: "independent_tests", standing: "confirmed", url: "https://lab.example/x1" }],
  report: REPORT, unreachable: [] };
const start = () => ({ arguments: { goal: PLAN.goal }, id: "call-start", name: START_RESEARCH_TOOL_NAME });
/** A start and its plan in one response: scoping has no floor, and with no window port the plan stands at once. */
const begin = () => [start(), proposeCall(PLAN)];
const submit = (id = "call-draft") => ({ arguments: DRAFT, id, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });
const researcher = (name: string, message = "Cover it.") => ({ arguments: { message, name }, id: `call-${name}-${message.length}`, name: CALL_SUBAGENT_TOOL_NAME });

/** A hanging gate: it holds the draft until its time ends, as a slow check does. */
const slowGate = (ended: { at?: number }): ResearchGate => ({ name: "slow", run: (_draft, context) => new Promise((_resolve, reject) => {
  context.signal.addEventListener("abort", () => { ended.at = Date.now(); reject(context.signal.reason as Error); }, { once: true });
}) });

/** The administrator's model for researchers: its turns run on the host `turns.ts` builds from a copy of the run's input, not on the run's own. */
function researcherRole(adapter: ProviderAdapter): ResearchVerifierRole {
  const capabilities = { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false };
  return {
    frozenChoice: async () => ({ effort: null, kind: "set", providerModelId: "research-model" }),
    route: async () => ({ connectionName: null, displayName: "Research model", route: { adapter, request: { modelCapabilities: capabilities, modelId: "research", params: {}, provider: "fake",
      reasoningEffort: null }, snapshot: { connection: { responseTimeoutMs: 120_000 }, connectionId: "research-connection", model: { adapterKind: "fake", capabilities, defaultParams: {},
      upstreamModelId: "research" }, providerFamily: "fake", providerModelId: "research-model" } as never, timeoutMs: 120_000 } })
  };
}

let runs = 0;

function harness(research: Omit<ResearchEngineDeps, "ports">, options: Readonly<{ turnTimeoutSeconds?: number; window?: ResearchPlanWindowPort; workspace: boolean }>) {
  runs += 1;
  const runId = `run-time-${runs}`;
  const rows = new Map<string, ToolCallRow>();
  const appended: TranscriptItem[] = [];
  const row = (input: { arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number; toolName: string }, state: ToolCallRow["state"]): ToolCallRow => {
    const made: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal, providerCallId: input.providerCallId,
      result: null, roundIndex: input.roundIndex, startedAt: "now", state, toolName: input.toolName };
    rows.set(made.id, made);
    return made;
  };
  const transcripts = {
    append: vi.fn(async (_scope, _from: number, items: readonly TranscriptItem[]) => { appended.push(...items); }),
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
  let published: Readonly<{ at: number; text: string }> | null = null;
  const repository = {
    appendAssistantText: vi.fn(async () => undefined), appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async (_runId: string, _message: string, _payload: unknown) => true), getChatUpdateForRun: vi.fn(async () => null),
    getRunControlForUser: vi.fn(async () => ({ status: "streaming" })), loadModelPricing: vi.fn(async () => null),
    loadProviderModelCostBasis: vi.fn(async () => null), loadRunMcpApprovalCards: vi.fn(async () => []),
    markRunAnswerStarted: vi.fn(async () => undefined)
  };
  const runStore = {
    applyUsageTotals: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { published = { at: Date.now(), text: input.text }; return true; }),
    recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true),
    workDurationMs: vi.fn(async () => null as number | null),
    writeUsageRows: vi.fn(async () => undefined)
  } satisfies NativeRunStore;
  /** The turn of each name, latest last, and how each ended: a name is one thread, and a researcher may be continued. */
  const turns = new Map<string, string>();
  const settled: Array<Readonly<{ reason?: string; state: string; turnId: string }>> = [];
  let turnCount = 0;
  const threads = {
    admitForeground: vi.fn(async (input: Parameters<SubagentThreadStore["admitForeground"]>[0]) => {
      turnCount += 1;
      const id = `${runId}-turn-${turnCount}`;
      turns.set(input.name, id);
      return { continued: false, kind: "admitted" as const,
        thread: { anchorRunId: input.parentRunId, definitionId: null, id: `thread-${input.name}`, name: input.name, parentThreadId: null, typeName: null },
        turn: { branchRunId: input.parentRunId, definitionRevisionId: null, effortSource: input.binding.effortSource, id, mode: "foreground" as const,
          modelId: input.binding.modelId, modelSource: input.binding.modelSource, parentRunId: input.parentRunId, provider: input.binding.provider,
          providerModelId: input.binding.providerModelId, reasoningEffort: input.binding.reasoningEffort, startedAt: new Date(), state: "running" as const, threadId: `thread-${input.name}` } };
    }),
    ensureThread: vi.fn(async (input: { name: string; parentRunId: string }) => ({ anchorRunId: input.parentRunId, definitionId: null, id: `thread-${input.name}`, name: input.name,
      parentThreadId: null, typeName: null })),
    find: vi.fn(async () => null),
    result: vi.fn(async () => null),
    activeChildren: vi.fn(async () => 0),
    childResults: vi.fn(async () => []),
    endOrphanedTurns: vi.fn(async () => 0),
    setActiveState: vi.fn(async () => true),
    threadEffectItems: vi.fn(async () => []),
    backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]),
    unreadMessages: vi.fn(async () => []),
    settle: vi.fn(async (input: { result: { reason?: string; state: string }; turnId: string }) => {
      settled.push({ ...input.result.reason ? { reason: input.result.reason } : {}, state: input.result.state, turnId: input.turnId });
      return true;
    })
  } as unknown as SubagentThreadStore;
  // Production's control stops a foreground turn through this runner (`stopTurn`, `control.ts`).
  class Control extends FakeSubagentBackgroundControl {
    override async stop(input: SubagentCallerScope & Readonly<{ name: string }>) {
      const turnId = turns.get(input.name);
      const result = turnId ? await backgroundSubagentRunner.stop({ turnId }, SUBAGENT_END_REASONS.stoppedByAgent) : null;
      return result ? { kind: "stopped" as const, result } : { kind: "not_found" as const };
    }
  }
  const background = new Control();
  const sent: Array<Readonly<{ at: number; message: SubagentSendInput }>> = [];
  const messaging: SubagentMessaging = {
    // The branch's agents as the store lists them: every thread name it knows, a gate's and another run's included.
    agents: vi.fn(async () => ({ agents: [...turns.keys(), "elsewhere"].map((name) => ({ mode: "foreground" as const, name, parent: "main", state: "running" as const, steps: [] })) })),
    questionAsked: vi.fn(),
    send: vi.fn(async (message: SubagentSendInput) => {
      sent.push({ at: Date.now(), message });
      await backgroundSubagentRunner.deliver({ turnId: turns.get(message.to)! }, { from: message.from, nonce: message.nonce, origin: "subagent_message", text: message.text });
      return { kind: "delivered" as const };
    })
  };
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    research: { ...research, ports: { ...options.window ? { planWindow: () => options.window! } : {}, time: createResearchClock } },
    runs: runStore, savedResults: { read: vi.fn(async () => null) }, subagentThreads: threads, toolCalls, transcripts
  };
  const text = "Choose a mattress.";
  const request = {
    attachmentIds: [], attachments: [], chatId: `chat-${runs}`, content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    searchPlan: { mode: "all_selected" as const, options: [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
      modelId: "fake-qsa", optionId: "hosted", protocol: "hosted", provider: "fake", providerModelId: "model-1", revisionId: "rev", searchStrategyRowId: "strategy" }] },
    // What admission freezes on an installation with no tool limits; a request without it gets the old three rounds.
    toolBudgets: DEFAULT_TOOL_RUN_BUDGETS,
    toolMode: "auto" as const,
    ...options.workspace ? { workspace: { enabled: true, syncToolTimeoutSeconds: 120, turnTimeoutSeconds: options.turnTimeoutSeconds ?? NATIVE_TURN_LIMITS.turnMs / 1_000 } } : {}
  } as unknown as ProviderRunRequest;
  const prepared: MaterializedPreparedRunData = {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
        providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
  const coordinator = {
    accepts: () => true,
    execute: vi.fn(),
    handoff: vi.fn(async () => ({ status: "ready" as const })),
    settle: vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: false })),
    tools: vi.fn(async () => [])
  };
  const go = (adapter: ProviderAdapter) => createNativeRunExecutionResponse({ adapter, created: { assistantMessageId: `answer-${runs}`, runId, userMessageId: `question-${runs}` },
    engine: deps, prepared, repository: repository as unknown as RunRepository, services: {}, subagents: { background, messaging }, userId: "user",
    ...options.workspace ? { workspace: coordinator as unknown as WorkspaceCoordinator } : {} }).text();
  return { appended, background, coordinator, go, published: () => published, repository, runId, runStore, sent, settled, threads };
}

const resultsOf = (seen: Seen | undefined, name: string) => (seen?.request.history ?? []).flatMap((item) => item.type === "tool_result" && item.name === name ? [item.output] : []);

const sinceStart = (seen: readonly Seen[], startedAt: number) => seen.map((entry) => entry.at - startedAt);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 1)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each([{ label: "without a Workspace", workspace: false }, { label: "with a Workspace", workspace: true }])("a research run $label", ({ workspace }) => {
  it("fires each phase at its minute from the plan's release, far past the turn it started in", async () => {
    const released = minutes(10);
    const { adapter, seen } = scripted([
      { calls: begin(), sleepMs: released },
      { calls: [researcher("alpha")] },
      { calls: [researcher("beta")] },
      { calls: [researcher("gamma")] },
      { calls: [submit()] }
    ], [{ hang: true }]);
    const gate: { at?: number } = {};
    const run = harness({ gates: [slowGate(gate)] }, { workspace });
    const startedAt = Date.now();
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(released + time.hardEnd);
    await answer;
    // Each researcher gets its own limit, and the third is ended by the research's end, not its own.
    expect(sinceStart(seen.main, startedAt)).toEqual([0, released, released + time.researcherTurn, released + 2 * time.researcherTurn, released + time.stopRunningResearchers]);
    expect(run.sent.map(({ at, message }) => [at - startedAt, message.to, message.text])).toEqual([[released + time.stopStartingResearchers, "gamma", RESEARCHERS_FINISH]]);
    // Past tool time the round offers the reserved draft alone, on its request and never in the transcript.
    expect(seen.main.at(-1)?.request.history?.at(-1)).toEqual({ text: researchDraftReservedInstruction(), type: "user" });
    expect(gate.at! - startedAt).toBe(released + time.notes);
    expect(run.published()?.at).toBe(startedAt + released + time.notes);
    expect(run.published()?.text).toContain(researchNote("time_out", REPORT));
    expect(run.repository.failRun).not.toHaveBeenCalled();
    expect(run.runStore.complete).toHaveBeenCalledOnce();
    if (workspace) expect(run.coordinator.handoff).toHaveBeenCalledOnce();
  });

  it("refuses a new researcher from minute 60, with a reason, and the running one's report still arrives", async () => {
    const { adapter, seen } = scripted([
      { calls: begin() },
      { calls: [researcher("alpha")], sleepMs: minutes(40) },
      { calls: [researcher("beta")] },
      { calls: [submit()] }
      // The finish message arrives during its last round, so it takes one more step to read it.
    ], [{ sleepMs: time.stopStartingResearchers - minutes(40) + 60_000, text: "Outcome: done\nWorking." }, { text: "Outcome: done\nFound it." }]);
    const run = harness({ gates: [] }, { workspace });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    const results = resultsOf(seen.main.at(-1), CALL_SUBAGENT_TOOL_NAME);
    expect(results[0]).toContain("Found it.");
    expect(results[1]).toContain(RESEARCHERS_CLOSED);
    expect(run.threads.admitForeground).toHaveBeenCalledOnce();
    expect(run.published()?.text).toContain(REPORT);
  });

  it("tells only a researcher of this run to finish, and it reads the message at its next step", async () => {
    const { adapter, seen } = scripted([
      { calls: begin() },
      { calls: [researcher("alpha")], sleepMs: minutes(50) },
      { calls: [submit()] }
    ], [{ calls: [{ arguments: {}, id: "call-nope", name: "no_such_tool" }], sleepMs: minutes(11) }, { text: "Outcome: done\nFinished." }]);
    const run = harness({ gates: [] }, { workspace });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    expect(run.sent.map(({ message }) => message.to)).toEqual(["alpha"]);
    expect(JSON.stringify(seen.agents.at(-1)?.request.history)).toContain(RESEARCHERS_FINISH);
  });

  it("gets a usable result from a researcher its time ended, with its steps, and can continue it by name", async () => {
    const { adapter, seen } = scripted([
      { calls: begin() },
      { calls: [researcher("alpha")] },
      { calls: [researcher("alpha", "Cover the rest of it.")] },
      { calls: [submit()] }
    ], [{ calls: [{ arguments: {}, id: "call-nope", name: "no_such_tool" }] }, { hang: true }, { text: "Outcome: done\nThe rest." }]);
    const run = harness({ gates: [] }, { workspace });
    const startedAt = Date.now();
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    expect(seen.main[2]!.at - startedAt).toBe(time.researcherTurn);
    const [ended, continued] = resultsOf(seen.main.at(-1), CALL_SUBAGENT_TOOL_NAME);
    expect(ended).toContain(RESEARCHER_TIME_ENDED);
    expect(JSON.parse(ended!.split("\n\n")[0]!)).toMatchObject({ kind: "ended", name: "alpha", reason: SUBAGENT_END_REASONS.deadline, state: "stopped", steps: [expect.anything()] });
    expect(continued).toContain("The rest.");
    expect(run.threads.admitForeground).toHaveBeenCalledTimes(2);
    expect(run.appended.filter((item) => item.kind === "tool_result" && item.name === CALL_SUBAGENT_TOOL_NAME).map((item) => item.kind === "tool_result" && item.outcome))
      .toEqual(["complete", "complete"]);
  });

  it("gives what a stopped researcher left as the main agent's result at minute 70, and the report it hands in then is published", async () => {
    const { adapter, seen } = scripted([
      { calls: begin() },
      { calls: [researcher("alpha")], sleepMs: minutes(50) },
      { calls: [submit()] }
    ], [{ hang: true }]);
    const run = harness({ gates: [] }, { workspace });
    const startedAt = Date.now();
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    expect(seen.main.at(-1)!.at - startedAt).toBe(time.stopRunningResearchers);
    expect(resultsOf(seen.main.at(-1), CALL_SUBAGENT_TOOL_NAME)[0]).toContain(RESEARCHER_TIME_ENDED);
    expect(run.settled).toEqual([expect.objectContaining({ state: "stopped" })]);
    expect(run.published()?.text).toContain(REPORT);
    expect(run.repository.failRun).not.toHaveBeenCalled();
  });

  it("ends at the hard end, counted from the release, even for a plan released late in the turn", async () => {
    const released = minutes(45);
    const { adapter, seen } = scripted([{ calls: begin(), sleepMs: released }, { hang: true }]);
    const run = harness({ gates: [] }, { workspace });
    const startedAt = Date.now();
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(released + time.hardEnd - 1);
    expect(run.repository.failRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(seen.main[1]!.at - startedAt).toBe(released);
    expect(run.repository.failRun).toHaveBeenCalledWith(run.runId, expect.any(String), expect.objectContaining({ code: RUN_TIME_LIMIT_FAILURE.code }), expect.anything());
  });

  it("keeps the report in hand with a note at the hard end, when nothing answered it", async () => {
    const { adapter } = scripted([{ calls: begin() }, { calls: [submit()] }, { hang: true }], []);
    const refusing: ResearchGate = { name: "refusing", run: async () => ({ kind: "send_back", message: "Add the sources." }) };
    const run = harness({ gates: [refusing] }, { workspace });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    expect(run.repository.failRun).toHaveBeenCalledOnce();
    expect(run.repository.appendAssistantText.mock.calls.flat().join("")).toContain(REPORT);
  });

  it("counts its phases from the window's close, however long the plan stayed on the screen", async () => {
    const scoped = minutes(2);
    const open = time.planWindow + minutes(4);
    const window: ResearchPlanWindowPort = { open: async ({ proposal, signal }) => {
      await sleep(open, signal);
      return { changed: false, plan: proposal, releasedBy: "timer" };
    } };
    const { adapter } = scripted([{ calls: [start()] }, { calls: [proposeCall(PLAN)], sleepMs: scoped }, { hang: true }]);
    const run = harness({ gates: [] }, { window, workspace });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(scoped + open + time.hardEnd - 1);
    expect(run.repository.failRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(run.repository.failRun).toHaveBeenCalledOnce();
  });

  it("keeps an ordinary run to its turn exactly, with research on offer", async () => {
    const { adapter } = scripted([{ hang: true }]);
    const run = harness({ gates: [] }, { workspace });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(NATIVE_TURN_LIMITS.turnMs - 1);
    expect(run.repository.failRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(run.repository.failRun).toHaveBeenCalledWith(run.runId, expect.any(String), expect.objectContaining({ code: RUN_TIME_LIMIT_FAILURE.code }), expect.anything());
  });

  it("is never taken for an orphan however long it stays silent: recovery asks what runs here", async () => {
    const { adapter } = scripted([{ calls: begin() }, { hang: true }]);
    const run = harness({ gates: [] }, { workspace });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd - 60_000);
    // The row of a run silent since its first minute, as `createNativeOrphanFinder` would select it; only `liveRunIds` keeps it out.
    const silent = { answerCompletedAt: null, assistantMessageId: "answer", chatId: "chat", id: run.runId, normalizedRequest: {}, userId: "user" };
    const findMany = vi.fn(async ({ where }: { where: { id?: { notIn: readonly string[] } } }) => where.id?.notIn.includes(silent.id) ? [] : [silent]);
    const failRun = vi.fn(async () => true);
    await expect(reconcileNativeRuns({ bootedAt: new Date(0), findOrphans: createNativeOrphanFinder({ modelRun: { findMany } } as never), liveRunIds: () => activeRunControllerRegistry.ids(),
      repository: { failRun }, runs: { complete: vi.fn(async () => true) } })).resolves.toBe(0);
    expect(findMany).toHaveBeenCalledOnce();
    expect(failRun).not.toHaveBeenCalled();
    activeRunControllerRegistry.abort(run.runId);
    await vi.advanceTimersByTimeAsync(0);
    await answer;
  });

  describe("Stop", () => {
    const stopped = async (run: ReturnType<typeof harness>, answer: Promise<string>, at: number, startedAt: number) => {
      await vi.advanceTimersByTimeAsync(at);
      expect(activeRunControllerRegistry.abort(run.runId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      const text = await answer;
      expect(text).toContain("\"status\":\"cancelled\"");
      expect(Date.now() - startedAt).toBeLessThanOrEqual(at + 1_000);
      expect(run.repository.failRun).not.toHaveBeenCalled();
      expect(activeRunControllerRegistry.executing()).not.toContain(run.runId);
    };

    it("ends the run while it scopes, before any plan", async () => {
      const { adapter } = scripted([{ calls: [start()] }, { hang: true }]);
      const run = harness({ gates: [] }, { workspace });
      const startedAt = Date.now();
      await stopped(run, run.go(adapter), time.scoping - 1, startedAt);
    });

    it("ends the run while its plan waits in the window", async () => {
      const window: ResearchPlanWindowPort = { open: ({ signal }) => aborted(signal) };
      const { adapter } = scripted([{ calls: begin() }]);
      const run = harness({ gates: [] }, { window, workspace });
      const startedAt = Date.now();
      await stopped(run, run.go(adapter), time.planWindow - 1, startedAt);
    });

    it.each([
      { at: minutes(20), phase: "researching", startsAt: 0 },
      { at: time.stopStartingResearchers + minutes(5), phase: "winding down", startsAt: minutes(50) }
    ])("ends the run and its researcher while $phase", async ({ at, startsAt }) => {
      const { adapter } = scripted([{ calls: begin() }, { calls: [researcher("alpha")], sleepMs: startsAt }], [{ hang: true }]);
      const run = harness({ gates: [] }, { workspace });
      const startedAt = Date.now();
      await stopped(run, run.go(adapter), at, startedAt);
      expect(run.settled).toEqual([expect.objectContaining({ reason: SUBAGENT_END_REASONS.parentStopped, state: "stopped" })]);
    });

    it("ends a check and its turn while the report is checked", async () => {
      const checking: ResearchGate = { name: "checking", run: async (_draft, context) => {
        await context.subagents.run({ brief: "b", instructions: "i", model: "main", name: "check", tools: ["web_fetch"] }, context.signal);
        return { kind: "pass" };
      } };
      const { adapter } = scripted([{ calls: begin() }, { calls: [submit()], sleepMs: time.stopRunningResearchers + 60_000 }], [{ hang: true }]);
      const run = harness({ gates: [checking] }, { workspace });
      const startedAt = Date.now();
      await stopped(run, run.go(adapter), time.stopRunningResearchers + minutes(5), startedAt);
      expect(run.settled).toEqual([expect.objectContaining({ state: "stopped" })]);
    });

    it("ends the run after the notes, before the hard end", async () => {
      const { adapter } = scripted([{ calls: begin() }, { hang: true }]);
      const run = harness({ gates: [] }, { workspace });
      const startedAt = Date.now();
      await stopped(run, run.go(adapter), time.notes + 60_000, startedAt);
    });
  });
});

describe("everything derived from the turn sees its new end", () => {
  /** Released at minute 20, so past the old end at 60 a research run is still in its first phase, and a stale end shows. */
  const released = minutes(20);
  const pastTheOldEnd = NATIVE_TURN_LIMITS.turnMs + minutes(1);

  it("lets a researcher started after the release retry its model past the turn's old end", async () => {
    const { adapter, seen } = scripted([
      { calls: begin(), sleepMs: released },
      { calls: [researcher("alpha")], sleepMs: minutes(35) },
      { calls: [submit()] }
    ], [{ fail: true, sleepMs: pastTheOldEnd - released - minutes(35) }, { text: "Outcome: done\nFound it." }]);
    const run = harness({ gates: [] }, { workspace: false });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(released + time.hardEnd);
    await answer;
    expect(seen.agents).toHaveLength(2);
    expect(resultsOf(seen.main.at(-1), CALL_SUBAGENT_TOOL_NAME)[0]).toContain("Found it.");
  });

  it("gives a researcher on the administrator's model the same end, on the host `turns.ts` builds from a copy of the run's input", async () => {
    const { adapter, seen } = scripted([
      { calls: begin(), sleepMs: released },
      { calls: [researcher("alpha")], sleepMs: minutes(35) },
      { calls: [submit()] }
    ], [{ fail: true, sleepMs: pastTheOldEnd - released - minutes(35) }, { text: "Outcome: done\nFound it." }]);
    const run = harness({ gates: [], researcher: researcherRole(adapter) }, { workspace: false });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(released + time.hardEnd);
    await answer;
    expect(seen.agents).toHaveLength(2);
    expect(seen.agents[0]?.request.modelId).toBe("research");
    expect(resultsOf(seen.main.at(-1), CALL_SUBAGENT_TOOL_NAME)[0]).toContain("Found it.");
  });

  it("stops a researcher on the administrator's model at its limit with the same usable result", async () => {
    const { adapter, seen } = scripted([
      { calls: begin() },
      { calls: [researcher("alpha")] },
      { calls: [submit()] }
    ], [{ hang: true }]);
    const run = harness({ gates: [], researcher: researcherRole(adapter) }, { workspace: false });
    const startedAt = Date.now();
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    expect(seen.main.at(-1)!.at - startedAt).toBe(time.researcherTurn);
    expect(resultsOf(seen.main.at(-1), CALL_SUBAGENT_TOOL_NAME)[0]).toContain(RESEARCHER_TIME_ENDED);
    expect(run.published()?.text).toContain(REPORT);
  });

  it("lets a gate's turn started after the release retry its model past the turn's old end", async () => {
    let outcome: ResearchSubagentOutcome | null = null;
    const checking: ResearchGate = { name: "checking", run: async (_draft, context) => {
      outcome = await context.subagents.run({ brief: "b", instructions: "i", model: "main", name: "check", tools: ["web_fetch"] }, context.signal);
      return { kind: "pass" };
    } };
    const { adapter, seen } = scripted([
      { calls: begin(), sleepMs: released },
      { calls: [submit()], sleepMs: pastTheOldEnd - released }
    ], [{ fail: true }, { text: "Outcome: done\nChecked." }]);
    const run = harness({ gates: [checking] }, { workspace: false });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(released + time.hardEnd);
    await answer;
    expect(seen.agents).toHaveLength(2);
    expect(outcome).toMatchObject({ kind: "ended", result: { state: "done" } });
  });

  it("gives a researcher's child the new end, so it is not stopped on arrival past the old one", async () => {
    const child = { arguments: { background: true, message: "Help.", name: "helper" }, id: "call-helper", name: CALL_SUBAGENT_TOOL_NAME };
    const { adapter } = scripted([
      { calls: begin(), sleepMs: released },
      { calls: [researcher("alpha")], sleepMs: minutes(35) },
      { calls: [submit()] }
    ], [{ calls: [child], sleepMs: pastTheOldEnd - released - minutes(35) }, { text: "Outcome: done\nFound it." }]);
    const run = harness({ gates: [] }, { workspace: false });
    const startedAt = Date.now();
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(released + time.hardEnd);
    await answer;
    expect(run.background.turns[0]?.input.deadlineAt?.getTime()).toBe(startedAt + released + time.hardEnd);
  });

  it("leaves a check its tools past the main agent's, which close when the researchers stop", async () => {
    const page = { arguments: {}, id: "call-nope", name: "no_such_tool" };
    let outcome: ResearchSubagentOutcome | null = null;
    const checking: ResearchGate = { name: "checking", run: async (_draft, context) => {
      outcome = await context.subagents.run({ brief: "b", instructions: "i", model: "main", name: "check", tools: ["web_fetch"] }, context.signal);
      return { kind: "pass" };
    } };
    const { adapter, seen } = scripted([{ calls: begin() }, { calls: [submit()], sleepMs: time.stopRunningResearchers + 60_000 }],
      [{ calls: [page] }, { text: "Outcome: done\nChecked." }]);
    const run = harness({ gates: [checking] }, { workspace: false });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    await answer;
    // A round with its tools closed is tool-free: the check's second round was still offered them.
    expect(seen.agents[1]?.request.toolChoice).toBe("auto");
    expect(outcome).toMatchObject({ kind: "ended", result: { state: "done" } });
  });

  it("moves the end to the hard end of a turn configured longer than the research", async () => {
    const { adapter } = scripted([{ calls: begin() }, { hang: true }]);
    const run = harness({ gates: [] }, { turnTimeoutSeconds: (time.hardEnd + minutes(30)) / 1_000, workspace: true });
    const answer = run.go(adapter);
    await vi.advanceTimersByTimeAsync(time.hardEnd - 1);
    expect(run.repository.failRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(run.repository.failRun).toHaveBeenCalledOnce();
  });
});
