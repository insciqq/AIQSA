import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeResearchPlanProposal, RESEARCH_LIMITS, RESEARCH_PAGE_LIMITS, RESEARCH_QUOTE_CHECKS, RESEARCH_RECORD_KINDS, RESEARCH_SOURCE_CLASSES, RESEARCH_STANDINGS, RESEARCH_TIME_MS,
  START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME, type ResearchDraft, type ResearchEvidenceRecord, type ResearchPlanProposal } from "../../contracts/research";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { NativeRunStore } from "../engine/runStore";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { EngineTool } from "../engine/toolRegistry";
import { toolOutputExcerpt, toolResultOutputText } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { ResearchGate } from "./gates";
import { researchMatrixCoverage } from "./matrix";
import { NOOP_RESEARCH_PORTS, researchGatePorts, researchPorts, type ResearchPortFactories, type ResearchPorts, type ResearchRunScope } from "./ports";
import { proposalArguments, proposeCall } from "./planWindow.testFixtures";
import { DRAFT as RECORD_DRAFT, FRAME, id, RECORDS } from "./report.testFixtures";
import { createResearchReport } from "./reportAssembly";
import { createRunResearch, researchOfTurn, researchRunOf, type ResearchEngineDeps, type RunResearchInput } from "./run";
import { VERIFIER_MARKER, verifierGate } from "./verifier";

/**
 * Every no-op port leaves a run as it was: the same scripted runs through the real engine with no ports, with every no-op named,
 * and with spies around them read the same, and only the hooks a port owns are called. `seam.test.ts` proves what a run does.
 */
type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: boolean; text?: string }>;

function scripted(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      options.signal?.throwIfAborted();
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      if (step.fail) throw Object.assign(new Error("rejected"), { code: "provider_response_not_retryable" });
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])], usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

const PLAN = { goal: "Choose a mattress.", questions: [
  { question: "Which mattress holds up?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }
], skipped_source_classes: [] };
const REPORT = "# Report\n\nConfirmed: the X1 holds up.";
const DRAFT = { findings: [{ claim: "The X1 holds up.", quote: "held up after 10 years", source_class: "independent_tests", standing: "confirmed",
  url: "https://lab.example/x1" }], report: REPORT, unreachable: [] };
const start = { arguments: { goal: PLAN.goal }, id: "call-start", name: START_RESEARCH_TOOL_NAME };
/** A start and its plan in one response: with no window port the plan stands at once. */
const begin = [start, proposeCall(PLAN)];
const submit = { arguments: DRAFT as Record<string, unknown>, id: "call-draft", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME };
const researcher = { arguments: { message: "Cover the question.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME };

function engineOf(research: ResearchEngineDeps) {
  const rows = new Map<string, ToolCallRow>();
  const appended: TranscriptItem[] = [];
  let published: string | null = null;
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
  const runs = {
    applyUsageTotals: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { published = input.text; return true; }),
    recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true),
    workDurationMs: vi.fn(async () => null as number | null),
    writeUsageRows: vi.fn(async () => undefined)
  } satisfies NativeRunStore;
  let turns = 0;
  const threads = {
    admitForeground: vi.fn(async (input: Parameters<SubagentThreadStore["admitForeground"]>[0]) => {
      turns += 1;
      return { continued: false, kind: "admitted" as const,
        thread: { anchorRunId: input.parentRunId, definitionId: null, id: `thread-${turns}`, name: input.name, parentThreadId: null, typeName: null },
        turn: { branchRunId: input.parentRunId, definitionRevisionId: null, effortSource: input.binding.effortSource, id: `turn-${turns}`, mode: "foreground" as const,
          modelId: input.binding.modelId, modelSource: input.binding.modelSource, parentRunId: input.parentRunId, provider: input.binding.provider,
          providerModelId: input.binding.providerModelId, reasoningEffort: input.binding.reasoningEffort, startedAt: new Date(), state: "running" as const, threadId: `thread-${turns}` } };
    }),
    ensureThread: vi.fn(),
    find: vi.fn(async () => null),
    result: vi.fn(async () => null),
    activeChildren: vi.fn(async () => 0),
    childResults: vi.fn(async () => []),
    endOrphanedTurns: vi.fn(async () => 0),
    setActiveState: vi.fn(async () => true),
    threadEffectItems: vi.fn(async () => []),
    backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]),
    settle: vi.fn(async () => true)
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    now: () => 1_000_000,
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    research,
    runs, savedResults: { read: vi.fn(async () => ({ arguments: {}, text: "whole page", toolName: "fetch_url" })) },
    subagentThreads: threads, toolCalls, transcripts
  };
  return { appended, deps, published: () => published, runs, toolCalls };
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
  const text = "Проведи исследование матрасов.";
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    searchPlan: { mode: "all_selected" as const, options: [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
      modelId: "fake-qsa", optionId: "hosted", protocol: "hosted", provider: "fake", providerModelId: "model-1", revisionId: "rev", searchStrategyRowId: "strategy" }] },
    toolMode: "auto" as const
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
        providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

async function runOf(steps: readonly Step[], research: ResearchEngineDeps, prepare: (memory: ReturnType<typeof engineOf>) => void = () => undefined) {
  const { adapter, requests } = scripted(steps);
  const memory = engineOf(research);
  prepare(memory);
  const input: NativeRunExecutionInput = { adapter, created: { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" }, engine: memory.deps,
    prepared: prepared(), repository: repository() as unknown as RunRepository, services: {}, subagents: { background: new FakeSubagentBackgroundControl() }, userId: "user" };
  const text = await createNativeRunExecutionResponse(input).text();
  const fresh = (value: string) => value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu, "<time>");
  const blocks = text.split("\n\n");
  return { calls: memory.toolCalls.begin.mock.calls.map(([call]) => call.toolName), events: blocks.flatMap((block) => /^event: (.+)$/mu.exec(block)?.[1] ?? []),
    published: memory.published(), requests: fresh(JSON.stringify(requests.map((request) => [request.history, request.tools?.map((tool) => tool.name), request.toolChoice]))),
    shown: blocks.flatMap((block) => /^event: token$/mu.test(block) ? (JSON.parse(/^data: (.+)$/mu.exec(block)?.[1] ?? "{}") as { delta: string }).delta : []).join("") };
}

/** Every port as a factory of its no-op, wrapped in spies, and the calls they saw. */
function spied() {
  const calls: string[] = [];
  const spy = <Port extends object>(port: Port, name: string): Port => new Proxy(port, { get(target, key, receiver) {
    const member = Reflect.get(target, key, receiver) as unknown;
    return typeof member !== "function" ? member : (...args: unknown[]) => {
      calls.push(`${name}.${String(key)}`);
      return (member as (...parameters: unknown[]) => unknown).apply(target, args);
    };
  } });
  const ports: ResearchPortFactories = { coverage: () => spy(NOOP_RESEARCH_PORTS.coverage, "coverage"), evidence: () => spy(NOOP_RESEARCH_PORTS.evidence, "evidence"),
    planWindow: () => spy(NOOP_RESEARCH_PORTS.planWindow, "planWindow"), report: () => spy(NOOP_RESEARCH_PORTS.report, "report"),
    resume: () => spy(NOOP_RESEARCH_PORTS.resume, "resume"), time: () => spy(NOOP_RESEARCH_PORTS.time, "time") };
  return { calls, ports };
}

const named: ResearchPortFactories = { coverage: () => NOOP_RESEARCH_PORTS.coverage, evidence: () => NOOP_RESEARCH_PORTS.evidence, planWindow: () => NOOP_RESEARCH_PORTS.planWindow,
  report: () => NOOP_RESEARCH_PORTS.report, resume: () => NOOP_RESEARCH_PORTS.resume, time: () => NOOP_RESEARCH_PORTS.time };

const RUNS: Readonly<Record<string, readonly Step[]>> = {
  "a report accepted after a researcher": [{ calls: begin }, { calls: [researcher] }, { text: "Outcome: done\nreport" }, { calls: [submit] }],
  "a provider that fails with a report in hand": [{ calls: begin }, { calls: [submit] }, { fail: true }],
  "a provider that fails with nothing in hand": [{ calls: begin }, { fail: true }],
  "a run that never researches": [{ text: "Answered directly." }],
  "text instead of a report": [{ calls: begin }, { text: "Report as text." }, { text: "Report as text, again." }]
};

/** A turn's stored start call, with what its result held. */
const started = (output: string): TranscriptItem[] => [
  { arguments: JSON.stringify(PLAN), callId: "call-start", id: "stored-call", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
  { callId: "call-start", id: "stored-result", kind: "tool_result", name: START_RESEARCH_TOOL_NAME, outcome: "complete", output }
];
const startResult = (run: string) => JSON.stringify({ research_run: run, method: "How to run it.", status: "started" });

/** A call waiting for the user's approval, as the run that stopped for it left it. */
const held = (callId: string): TranscriptItem[] => [
  { arguments: "{}", callId, id: `${callId}-call`, kind: "tool_call", name: "mcp_shop_buy" },
  { callId, id: `${callId}-result`, kind: "tool_result", name: "mcp_shop_buy", outcome: "error", output: "Waiting for approval." }
];

/** A run made by hand, for what a scripted engine run does not reach. */
const direct = (deps: ResearchEngineDeps, extra: Partial<RunResearchInput> = {}) => createRunResearch({ chatId: "chat", deps, gatesEndAt: 2_000_000, items: () => [], now: () => 1_000_000,
  onPlan: async () => undefined, rearmReservedCall: () => undefined, runId: "run-1", savedResults: { read: async () => null },
  subagentInput: { admittedRequest: { modelId: "main-model" }, engine: {}, snapshot: {} } as never,
  threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [] } as never, toolTimeLeft: () => true, userId: "user", userMessage: "q", ...extra });

/**
 * The run after run-0's interrupted turn, through the real engine: the user's `text`, or with `approved` the approval of `call-held` in a turn that `runId` left after the user's
 * Continue, whose items are `later`.
 */
async function afterInterruption(input: Readonly<{ approved?: Readonly<{ later: readonly TranscriptItem[]; runId: string }>; ports: ResearchPortFactories; steps: readonly Step[]; text?: string }>) {
  const { approved, text = CONTINUE_TURN_TEXT } = input;
  const stored = [...started(startResult("run-0")), ...held("call-first")];
  const { adapter, requests } = scripted(input.steps);
  const memory = engineOf({ gates: [], ports: input.ports });
  vi.mocked(memory.deps.approvedCall).mockResolvedValue(approved ? { providerCallId: "call-held", toolName: "mcp_shop_buy" } : null);
  const answers = new Map([["answer-0", "run-0"]]);
  const runItems = new Map<string, TranscriptItem[]>([["run-0", stored]]);
  if (approved) {
    answers.set("answer-1", approved.runId);
    runItems.set(approved.runId, [...approved.later]);
  }
  vi.mocked(memory.deps.transcripts.nativeRunsForAnswers).mockResolvedValue(answers);
  vi.mocked(memory.deps.transcripts.loadRuns).mockResolvedValue(runItems);
  const content = (words: string) => ({ blocks: [{ text: words, type: "text" as const }] });
  const messages = [{ content: content("Проведи исследование."), id: "question", role: "user" as const }, { content: content(""), id: "answer-0", role: "assistant" as const },
    ...approved ? [{ content: content(text), id: "continue", role: "user" as const }, { content: content(""), id: "answer-1", role: "assistant" as const }] : [],
    { content: content(approved ? "The user approved it." : text), id: "current-user-message", role: "user" as const }];
  const base = prepared();
  const request = { ...base.normalizedRequest, context: { messages, mode: "branch_path" as const } } as ProviderRunRequest;
  await createNativeRunExecutionResponse({ adapter, ...approved ? { approvalContinuation: { approvalId: "approval-1" } } : {},
    created: { assistantMessageId: "answer-c", runId: approved ? "run-d" : "run-c", userMessageId: "current-user-message" }, engine: memory.deps,
    prepared: { ...base, normalizedRequest: request, providerRequest: request }, repository: repository() as unknown as RunRepository, services: {},
    subagents: { background: new FakeSubagentBackgroundControl() }, userId: "user" }).text();
  return { appended: memory.appended, calls: memory.toolCalls.begin.mock.calls.map(([call]) => call.toolName), published: memory.published(),
    requests: JSON.stringify(requests.map((sent) => sent.history)) };
}

const execute = (tool: EngineTool, call: typeof start) => tool.execute({ call, persistedToolCallId: `row-${call.id}`, round: 1, signal: new AbortController().signal } as never);

/** The scope a run's ports get as the approval continuation of these stored runs, oldest first, named `run-0` on: the last holds the approved call. */
async function continuationScope(stored: readonly (readonly TranscriptItem[])[], ports: ResearchPortFactories = {}): Promise<ResearchRunScope> {
  const scopes: ResearchRunScope[] = [];
  const { adapter } = scripted([{ calls: [submit] }]);
  const memory = engineOf({ gates: [], ports: { ...ports, evidence: (run) => { scopes.push(run); return NOOP_RESEARCH_PORTS.evidence; } } });
  vi.mocked(memory.deps.approvedCall).mockResolvedValue({ providerCallId: "call-held", toolName: "mcp_shop_buy" });
  vi.mocked(memory.deps.transcripts.nativeRunsForAnswers).mockResolvedValue(new Map(stored.map((_items, index) => [`answer-${index}`, `run-${index}`])));
  vi.mocked(memory.deps.transcripts.loadRuns).mockResolvedValue(new Map(stored.map((items, index) => [`run-${index}`, [...items]])));
  vi.mocked(memory.deps.transcripts.approvalContinuationTurns).mockResolvedValue(new Set(stored.slice(1).map((_items, index) => `approved-${index + 1}`)));
  const content = (text: string) => ({ blocks: [{ text, type: "text" as const }] });
  const messages = [{ content: content("Проведи исследование."), id: "question", role: "user" as const },
    ...stored.flatMap((_items, index) => [...index === 0 ? [] : [{ content: content("The user approved it."), id: `approved-${index}`, role: "user" as const }],
      { content: content(""), id: `answer-${index}`, role: "assistant" as const }]),
    { content: content("The user approved it."), id: "current-user-message", role: "user" as const }];
  const base = prepared();
  const request = { ...base.normalizedRequest, context: { messages, mode: "branch_path" as const } } as ProviderRunRequest;
  await createNativeRunExecutionResponse({ adapter, approvalContinuation: { approvalId: "approval-1" },
    created: { assistantMessageId: "answer-c", runId: "run-c", userMessageId: "current-user-message" }, engine: memory.deps,
    prepared: { ...base, normalizedRequest: request, providerRequest: request }, repository: repository() as unknown as RunRepository, services: {},
    subagents: { background: new FakeSubagentBackgroundControl() }, userId: "user" }).text();
  expect(scopes).toHaveLength(1);
  return scopes[0]!;
}

afterEach(() => vi.restoreAllMocks());

describe("no-op ports", () => {
  it.each(Object.keys(RUNS))("leave %s as it was", async (name) => {
    const steps = RUNS[name]!;
    const gates: readonly ResearchGate[] = [];
    const today = await runOf(steps, { gates });
    expect(await runOf(steps, { gates, ports: named })).toEqual(today);
    expect(await runOf(steps, { gates, ports: spied().ports })).toEqual(today);
  });

  it("are called only where the run hands over: nothing reads or writes a store or composes while a report stands, and the plan goes through its window", async () => {
    const { calls, ports } = spied();
    await runOf(RUNS["a report accepted after a researcher"]!, { gates: [], ports });
    expect([...new Set(calls)].sort()).toEqual(["coverage.coverage", "coverage.frame", "planWindow.open", "time.planReleased", "time.researcherRefusal", "time.researcherSignal"]);
  });

  it("each answer as a true identity", async () => {
    const signal = new AbortController().signal;
    const noop = NOOP_RESEARCH_PORTS;
    const proposal = { steps: ["Step."] } as unknown as ResearchPlanProposal;
    await expect(noop.planWindow.open({ goal: "Goal.", proposal, signal })).resolves.toEqual({ changed: false, plan: proposal, releasedBy: "timer" });
    expect(noop.time.gatesEndAt(123)).toBe(123);
    expect(noop.time.researcherRefusal()).toBeNull();
    expect(noop.time.researcherSignal(signal)).toBe(signal);
    expect(noop.time.planReleased()).toBeUndefined();
    await expect(noop.evidence.records(signal)).resolves.toEqual([]);
    await expect(noop.evidence.page("page", signal)).resolves.toBeNull();
    await expect(noop.evidence.record({ author: { name: null, threadId: null }, record: {} as never }, signal)).resolves.toMatchObject({ kind: "refused" });
    await expect(noop.coverage.coverage(signal)).resolves.toBeNull();
    await expect(noop.coverage.frame(signal)).resolves.toBeNull();
    await expect(noop.coverage.change({} as never, { name: null, threadId: null }, signal)).resolves.toMatchObject({ ok: false });
    await expect(noop.report.compose({ ended: "failed", signal })).resolves.toBeNull();
    expect(noop.report.gates).toEqual([]);
    await expect(noop.resume.load("run", signal)).resolves.toBeNull();
  });
});

describe("the ports a run holds", () => {
  const scope = { chatId: "chat", runId: "run" } as unknown as ResearchRunScope;

  it("makes each from its factory, once per run, and a port left out is its no-op", () => {
    const evidence: ResearchPorts["evidence"] = { ...NOOP_RESEARCH_PORTS.evidence };
    const factory = vi.fn(() => evidence);
    const ports = researchPorts({ evidence: factory }, scope);
    expect(factory).toHaveBeenCalledExactlyOnceWith(scope);
    expect(ports.evidence).toBe(evidence);
    expect(ports.time).toBe(NOOP_RESEARCH_PORTS.time);
    expect(researchPorts(undefined, scope)).toEqual(NOOP_RESEARCH_PORTS);
  });

  it("hands a port the ports it reads, so coverage and the report read the run's own records", () => {
    const evidence: ResearchPorts["evidence"] = { ...NOOP_RESEARCH_PORTS.evidence };
    const coverage: ResearchPorts["coverage"] = { ...NOOP_RESEARCH_PORTS.coverage };
    const coverageFactory = vi.fn(() => coverage);
    const reportFactory = vi.fn(() => NOOP_RESEARCH_PORTS.report);
    const resumeFactory = vi.fn(() => NOOP_RESEARCH_PORTS.resume);
    researchPorts({ coverage: coverageFactory, evidence: () => evidence, report: reportFactory, resume: resumeFactory }, scope);
    expect(coverageFactory).toHaveBeenCalledExactlyOnceWith(scope, { evidence });
    expect(reportFactory).toHaveBeenCalledExactlyOnceWith(scope, { coverage, evidence });
    expect(resumeFactory).toHaveBeenCalledExactlyOnceWith(scope, { coverage, evidence });
  });

  it("hands a gate the run's coverage and evidence beside its context, and the time port its end", async () => {
    const seen: unknown[] = [];
    const evidence: ResearchPorts["evidence"] = { ...NOOP_RESEARCH_PORTS.evidence };
    const coverage: ResearchPorts["coverage"] = { ...NOOP_RESEARCH_PORTS.coverage };
    const time = { ...NOOP_RESEARCH_PORTS.time, gatesEndAt: () => 1_000_000 + 5_000 };
    const gate: ResearchGate = { name: "spy", run: async (_draft, context) => {
      seen.push(researchGatePorts(context).evidence, researchGatePorts(context).coverage, context.time.remainingMs());
      return { kind: "pass" };
    } };
    const { published } = await runOf(RUNS["a report accepted after a researcher"]!, { gates: [gate], ports: { coverage: () => coverage, evidence: () => evidence, time: () => time } });
    expect(seen).toEqual([evidence, coverage, 5_000]);
    expect(published).toBe(REPORT);
  });

  it("reads the no-ops from a context built without them", () => {
    expect(researchGatePorts({})).toEqual({ coverage: NOOP_RESEARCH_PORTS.coverage, evidence: NOOP_RESEARCH_PORTS.evidence });
  });

  it("runs the report's gates before the others, under the same send-back path", async () => {
    const order: string[] = [];
    const passing = (name: string): ResearchGate => ({ name, run: async () => { order.push(name); return { kind: "pass" }; } });
    await runOf(RUNS["a report accepted after a researcher"]!, { gates: [passing("gap")], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, gates: [passing("records")] }) } });
    expect(order).toEqual(["records", "gap"]);
  });

  it("refuses a researcher the clock closed, visibly, and runs an open one under the clock's signal", async () => {
    const steps: readonly Step[] = [{ calls: begin }, { calls: [researcher] }, { calls: [submit] }];
    const closed = await runOf(steps, { gates: [], ports: { time: () => ({ ...NOOP_RESEARCH_PORTS.time, researcherRefusal: () => "Time for new researchers is over." }) } });
    expect(closed.requests).toContain("research_researchers_closed");
    expect(closed.requests).toContain("Time for new researchers is over.");
    expect(closed.published).toBe(REPORT);
    const researcherSignal = vi.fn((signal: AbortSignal) => signal);
    await runOf(RUNS["a report accepted after a researcher"]!, { gates: [], ports: { time: () => ({ ...NOOP_RESEARCH_PORTS.time, researcherSignal }) } });
    expect(researcherSignal).toHaveBeenCalledOnce();
  });

  it("tells the clock when the plan stands, once", async () => {
    const planReleased = vi.fn();
    await runOf(RUNS["a report accepted after a researcher"]!, { gates: [], ports: { time: () => ({ ...NOOP_RESEARCH_PORTS.time, planReleased }) } });
    expect(planReleased).toHaveBeenCalledOnce();
  });

  it("publishes what the report port builds when no report stands, and only then", async () => {
    const compose = vi.fn(async () => "Built from the records.");
    const ports = { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) };
    expect((await runOf(RUNS["a provider that fails with nothing in hand"]!, { gates: [], ports })).shown).toContain("Built from the records.");
    expect(compose).toHaveBeenCalledExactlyOnceWith({ ended: "failed", signal: expect.any(AbortSignal) });
    compose.mockClear();
    expect((await runOf(RUNS["a provider that fails with a report in hand"]!, { gates: [], ports })).shown).toContain(REPORT);
    expect(compose).not.toHaveBeenCalled();
    expect((await runOf(RUNS["a run that never researches"]!, { gates: [], ports })).published).toBe("Answered directly.");
    expect(compose).not.toHaveBeenCalled();
  });

  it("keeps the run's own end when the report port fails: its failure costs only what it would have built", async () => {
    const compose = vi.fn(async () => { throw new Error("store down"); });
    const failed = await runOf(RUNS["a provider that fails with nothing in hand"]!, { gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } });
    expect(compose).toHaveBeenCalledOnce();
    expect(failed.published).toBeNull();
    expect(failed).toEqual(await runOf(RUNS["a provider that fails with nothing in hand"]!, { gates: [] }));
  });

  it("composes once: a publish that fails sends the run to its second end, which gets the first result", async () => {
    const compose = vi.fn(async () => "Built from the records.");
    const silent: readonly Step[] = [{ calls: begin }, {}];
    const run = await runOf(silent, { gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } }, (memory) => memory.runs.publishAnswer.mockResolvedValue(false));
    expect(compose).toHaveBeenCalledExactlyOnceWith({ ended: "no_report", signal: expect.any(AbortSignal) });
    expect(run.published).toBeNull();
    expect(run.shown).toContain("Built from the records.");
  });

  it("stops waiting at its own bound for a port that ignores the signal, which the port saw end", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const signals: AbortSignal[] = [];
      const compose = vi.fn(({ signal }: Readonly<{ signal: AbortSignal }>) => {
        signals.push(signal);
        return new Promise<string | null>(() => undefined);
      });
      const finished = runOf(RUNS["a provider that fails with nothing in hand"]!, { gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } });
      await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.composeReport + 1_000);
      expect((await finished).published).toBeNull();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting at Stop, and never asks a port once Stop came", async () => {
    const stop = new AbortController();
    const signals: AbortSignal[] = [];
    const compose = vi.fn(({ signal }: Readonly<{ signal: AbortSignal }>) => {
      signals.push(signal);
      return new Promise<string | null>(() => undefined);
    });
    const research = direct({ gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } });
    research.resume(started(startResult("run-1")));
    const composing = research.composed("failed", stop.signal);
    await vi.waitFor(() => expect(compose).toHaveBeenCalledOnce());
    stop.abort(new Error("stopped"));
    await expect(composing).resolves.toBeNull();
    expect(signals[0]!.aborted).toBe(true);
    const late = direct({ gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } });
    late.resume(started(startResult("run-1")));
    compose.mockClear();
    await expect(late.composed("failed", stop.signal)).resolves.toBeNull();
    expect(compose).not.toHaveBeenCalled();
  });

  describe("over what the model last wrote", () => {
    const BUILT = "# Built from the records\n\n*Note.*";
    const report = (compose: ResearchPorts["report"]["compose"]): ResearchEngineDeps => ({ gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } });
    const narrated = { calls: [researcher], text: "Sending the researchers now." };

    it("wins over a line of narration when the provider fails, which nearly every run has by then", async () => {
      const run = await runOf([{ calls: begin }, narrated, { text: "Outcome: done\nreport" }, { fail: true }], report(async () => BUILT));
      expect(run.shown).toContain(BUILT);
      expect(run.shown).not.toContain("Sending the researchers now.");
    });

    it("wins over a line of narration when the model stops with nothing to say", async () => {
      const run = await runOf([{ calls: begin }, narrated, { text: "Outcome: done\nreport" }, {}], report(async () => BUILT));
      expect(run.published).toBe(BUILT);
    });

    it("leaves that text as the answer when there is nothing to build from", async () => {
      const run = await runOf([{ calls: begin }, narrated, { text: "Outcome: done\nreport" }, { fail: true }], report(async () => null));
      expect(run.shown).toContain("Sending the researchers now.");
    });

    it("never replaces a report the model handed in", async () => {
      const compose = vi.fn(async () => BUILT);
      const run = await runOf([{ calls: begin }, { calls: [submit] }, { fail: true }], report(compose));
      expect(run.published).toContain(REPORT);
      expect(compose).not.toHaveBeenCalled();
    });
  });

  describe("on the real port, over a real run's records", () => {
    /** The fakes of the two stores a report reads: the matrix and the records. */
    const stores = (records: () => readonly ResearchEvidenceRecord[] = () => RECORDS, frame = FRAME): ResearchPortFactories => ({
      coverage: () => ({ ...NOOP_RESEARCH_PORTS.coverage, coverage: async () => researchMatrixCoverage(frame, records()), frame: async () => frame }),
      evidence: () => ({ ...NOOP_RESEARCH_PORTS.evidence, records: async () => records() }), report: createResearchReport });
    const seen: ResearchDraft[] = [];
    const reading: ResearchGate = { name: "reading", run: async (draft) => { seen.push(draft); return { kind: "pass" }; } };
    const onIds = (callId: string, fields: Readonly<Record<string, unknown>>) => ({ arguments: { branch_picks: [], does_not_separate: null, pick_row_key: "x1", record_ids: [id(1), id(2), id(3)], report: RECORD_DRAFT.report, unreachable: [], ...fields },
      id: callId, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });
    const resultsOf = (requests: string, part: string) => requests.includes(part);

    afterEach(() => { seen.length = 0; });

    it("gives the user the table and a note when the model never submits, never an empty answer", async () => {
      const run = await runOf([{ calls: begin }, {}], { gates: [], ports: stores() });
      expect(run.published).toContain("| Вариант | Цена за 160×200 | Отзывы владельцев | Жёсткость |");
      expect(run.published).toContain("(https://shop.example/x1)");
      expect(run.published).toContain("Отчёт не был передан");
    });

    it("gives it when the provider fails with a line of narration behind it", async () => {
      const run = await runOf([{ calls: begin }, { calls: [researcher], text: "Запускаю исследователей." }, { text: "Outcome: done\nreport" }, { fail: true }], { gates: [], ports: stores() });
      expect(run.shown).toContain("| Вариант |");
      expect(run.shown).toContain("Ответ прервался сбоем раньше, чем был написан отчёт");
      expect(run.shown).not.toContain("Запускаю исследователей.");
    });

    it("lets every later gate read the prices and reviews the pick rests on, as findings with their records", async () => {
      const run = await runOf([{ calls: begin }, { calls: [onIds("call-draft", {})] }], { gates: [reading], ports: stores() });
      expect(run.published).toBe(RECORD_DRAFT.report);
      expect(seen[0]!.findings.map(({ recordId }) => recordId)).toEqual([id(1), id(2), id(3)]);
      expect(seen[0]!.findings[2]).toMatchObject({ quote: "Просел за год.", sourceClass: "owner_reviews" });
      expect(seen[0]!.findings[2]!.claim).toContain("Small sample of 11. sagging: 3 of 11.");
      expect(seen[0]!.pickRowKey).toBe("x1");
    });

    it("sends back a draft that cites only the specifications, names what to add, and accepts it once it does", async () => {
      const run = await runOf([{ calls: begin }, { calls: [onIds("call-one", { record_ids: [id(1)] })] }, { calls: [onIds("call-two", {})] }], { gates: [reading], ports: stores() });
      // `run.requests` holds every id as <id>: which one each is, the check's own tests prove.
      expect(resultsOf(run.requests, "x1 / price: <id>")).toBe(true);
      expect(resultsOf(run.requests, "\\\"gate\\\":\\\"report_check\\\"")).toBe(true);
      expect(seen).toHaveLength(1);
      expect(run.published).toBe(RECORD_DRAFT.report);
    });

    it("sends back a pick outside the matrix, and at the cap the answer says so rather than going round", async () => {
      const wrong = (attempt: number) => onIds(`call-${attempt}`, { pick_row_key: "x9", report: `${RECORD_DRAFT.report}\nВерсия ${attempt}.` });
      const run = await runOf([{ calls: begin }, { calls: [wrong(1)] }, { calls: [wrong(2)] }, { calls: [wrong(3)] }], { gates: [reading], ports: stores() });
      expect(resultsOf(run.requests, "Outside the matrix: row x9")).toBe(true);
      expect(run.published).toContain("Версия 3.");
      expect(run.published).toContain("Выбор в этом отчёте не входит в варианты");
      expect(seen).toHaveLength(1);
    });

    it("ends a draft repeated word for word with the report and a note: the engine's repeat guard stops the call before any gate", async () => {
      const same = (attempt: number) => onIds(`call-${attempt}`, { pick_row_key: "x9" });
      const run = await runOf([{ calls: begin }, { calls: [same(1)] }, { calls: [same(2)] }, { calls: [same(3)] }], { gates: [reading], ports: stores() });
      expect(run.published).toContain("Берите Lonax Memory.");
      expect(run.published).toContain("с неразобранными замечаниями");
    });

    it("sends back an id of no record, saying which", async () => {
      const run = await runOf([{ calls: begin }, { calls: [onIds("call-one", { record_ids: [id(1), id(2), id(3), id(99)] })] }, { calls: [onIds("call-two", {})] }], { gates: [], ports: stores() });
      expect(resultsOf(run.requests, "These record_ids name no live record of this research: <id>")).toBe(true);
      expect(run.published).toBe(RECORD_DRAFT.report);
    });

    it("sends back a mistyped key under the cap, and a run that ends there keeps the report", async () => {
      const mistyped = onIds("call-one", { pick_row_key: "Лонакс" });
      const fixed = await runOf([{ calls: begin }, { calls: [mistyped] }, { calls: [onIds("call-two", {})] }], { gates: [reading], ports: stores() });
      expect(resultsOf(fixed.requests, "pick_row_key must be null or the key of the row picked.")).toBe(true);
      expect(fixed.published).toBe(RECORD_DRAFT.report);
      const ended = await runOf([{ calls: begin }, { calls: [mistyped] }, { fail: true }], { gates: [], ports: stores() });
      expect(ended.shown).toContain("Берите Lonax Memory.");
    });

    it("passes advice that states no fact, and says it came with nothing to check", async () => {
      const advice = "Сначала измерьте кровать, потом выберите жёсткость.";
      const run = await runOf([{ calls: begin }, { calls: [onIds("call-draft", { pick_row_key: null, record_ids: [], report: advice })] }], { gates: [], ports: stores() });
      expect(run.published).toContain(advice);
      expect(run.published).toContain("Отчёт пришёл без списка находок");
    });

    it("keeps a text draft as it stands: it has no ids to check", async () => {
      const run = await runOf([{ calls: begin }, { text: "Report as text." }, { text: "Report as text, again." }], { gates: [], ports: stores() });
      expect(run.published).toContain("Report as text, again.");
      expect(run.published).not.toContain("| Вариант |");
    });

    it("tells the main agent the ids of what its researchers recorded, each once", async () => {
      const second = { ...researcher, arguments: { message: "And this.", name: "shop" }, id: "call-shop" };
      const run = await runOf([{ calls: begin }, { calls: [researcher] }, { text: "Outcome: done\nreport" }, { calls: [second] }, { text: "Outcome: done\nreport" }, { calls: [onIds("call-draft", {})] }],
        { gates: [], ports: stores() });
      const listing = /Records to cite by id in record_ids/gu;
      expect(run.requests.match(listing)?.length).toBeGreaterThan(0);
      expect(run.requests).toContain("| x1 / price | Claim 2.");
    });

    it("gives a store that cannot be read a note, and the report still goes out", async () => {
      const broken: ResearchPortFactories = { ...stores(), evidence: () => ({ ...NOOP_RESEARCH_PORTS.evidence, records: async () => { throw new Error("database down"); } }) };
      const run = await runOf([{ calls: begin }, { calls: [onIds("call-draft", {})] }], { gates: [], ports: broken });
      expect(run.published).toContain(RECORD_DRAFT.report.trimEnd());
      expect(run.published).toContain("Одну из проверок этого отчёта не удалось завершить");
    });

    describe("after a Continue that starts no researcher", () => {
      const decoded = decodeResearchPlanProposal(proposalArguments(PLAN));
      if (!decoded.ok) throw new Error(decoded.message);
      const answer = { changed: false, plan: decoded.value, releasedBy: "timer" as const };
      const pickedUp = (goal = "Выбрать матрас на много лет."): ResearchPortFactories =>
        ({ ...stores(), resume: () => ({ ...NOOP_RESEARCH_PORTS.resume, load: async () => ({ answer, frame: FRAME, fromRunId: "run-0", goal, row: { answer: {}, frame: {}, proposal: {}, version: 1, windowEndsAt: new Date(0) } }) }) });
      const startAgain = { ...start, arguments: { goal: "Выбрать матрас." } };

      it("gives the model the ids in the start's result, and a draft on them passes the report check", async () => {
        const run = await afterInterruption({ ports: pickedUp(), steps: [{ calls: [startAgain] }, { calls: [onIds("call-draft", {})] }] });
        expect(run.requests).toContain(`${id(2)} | x1 / price | Claim 2.`);
        expect(run.calls).toEqual([START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME]);
        expect(run.published).toBe(RECORD_DRAFT.report);
      });

      it("keeps them through an approval of that run, whose plan and rows are the start's", async () => {
        const first = await afterInterruption({ ports: pickedUp(), steps: [{ calls: [startAgain] }, { calls: [onIds("call-draft", {})] }] });
        const later = [...first.appended.filter((item) => (item.kind === "tool_call" || item.kind === "tool_result") && item.name === START_RESEARCH_TOOL_NAME), ...held("call-held")];
        const run = await afterInterruption({ approved: { later, runId: "run-c" }, ports: stores(), steps: [{ calls: [onIds("call-after", {})] }] });
        expect(run.requests).toContain(`${id(2)} | x1 / price | Claim 2.`);
        expect(run.published).toBe(RECORD_DRAFT.report);
      });

      it("builds the answer in the goal's language, whatever the button's word is", async () => {
        const silent = [{ calls: [startAgain] }, {}];
        const russian = await afterInterruption({ ports: pickedUp(), steps: silent });
        expect(russian.published).toContain("| Вариант |");
        expect(russian.published).toContain("Отчёт не был передан");
        const english = await afterInterruption({ ports: pickedUp("Choose a mattress for years."), steps: silent });
        expect(english.published).toContain("| Option |");
        expect(english.published).toContain("No report was handed in");
      });
    });

    it("reads a transcript stored before drafts referred to records, typed findings and all", () => {
      const stored = { findings: [{ claim: "It holds.", quote: "held up", source_class: "independent_tests", standing: "confirmed", url: "https://lab.example/x1" }], report: "# Older report", unreachable: [] };
      const found = researchOfTurn([...started(startResult("run-1")),
        { arguments: JSON.stringify(stored), callId: "d", id: "d1", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
        { callId: "d", id: "d2", kind: "tool_result", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME, outcome: "complete", output: JSON.stringify({ message: "Not shown to the user yet. Again.", status: "sent_back" }) }]);
      expect(found.draft).toMatchObject({ findings: [{ claim: "It holds.", sourceClass: "independent_tests" }], report: "# Older report" });
      expect(found.attempts).toHaveLength(1);
      expect(found.draft?.recordIds).toBeUndefined();
    });

    it("keeps a rejected claim named across an approval, from the record the stored ids name", async () => {
      const arguments_ = onIds("d", { pick_row_key: null, record_ids: [id(1), id(4)] }).arguments;
      const message = `Not shown to the user yet. ${VERIFIER_MARKER} Not supported.\nFindings the check did not support: 2. Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with the whole report.`;
      const research = direct({ gates: [verifierGate], ports: stores() });
      research.resume([...started(startResult("run-1")),
        { arguments: JSON.stringify(arguments_), callId: "d", id: "d1", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
        { callId: "d", id: "d2", kind: "tool_result", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME, outcome: "complete", output: JSON.stringify({ status: "sent_back", gate: "verifier", message: message.replace(`. Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with the whole report.`, ".") }) }]);
      await vi.waitFor(() => expect(research.finish(false)).toContain("Claim 4."));
    });

    it("stops no run on a failed read when an approval rebuilds its drafts", async () => {
      const arguments_ = onIds("d", { pick_row_key: null, record_ids: [id(1)] }).arguments;
      const records = vi.fn(async () => { throw new Error("database down"); });
      const research = direct({ gates: [], ports: { ...stores(), evidence: () => ({ ...NOOP_RESEARCH_PORTS.evidence, records }) } });
      research.resume([...started(startResult("run-1")), { arguments: JSON.stringify(arguments_), callId: "d", id: "d1", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME }]);
      await vi.waitFor(() => expect(records).toHaveBeenCalled());
      expect(research.finish(false)).toContain(RECORD_DRAFT.report.trimEnd());
    });
  });

  it("composes nothing for a run that never researched", async () => {
    const compose = vi.fn(async () => "Built from the records.");
    await expect(direct({ gates: [], ports: { report: () => ({ ...NOOP_RESEARCH_PORTS.report, compose }) } }).composed("failed", new AbortController().signal)).resolves.toBeNull();
    expect(compose).not.toHaveBeenCalled();
  });
});

describe("the run research belongs to", () => {
  it("is named first in the start result, with no ports at all: the one change a model sees", async () => {
    const result = await execute(direct({ gates: [] }).tools[0]!, start);
    expect(Object.keys(JSON.parse(toolResultOutputText(result)) as object)).toEqual(["research_run", "status", "instructions"]);
    expect(toolResultOutputText(result)).toMatch(/^\{"research_run":"run-1",/u);
    expect((await runOf(RUNS["a report accepted after a researcher"]!, { gates: [] })).requests).toContain(String.raw`{\"research_run\":\"run-1\",\"status\":\"scoping\"`);
  });

  it("is the run's own on a turn of its own, for the ports and the start result", async () => {
    const scopes: ResearchRunScope[] = [];
    const ports: ResearchPortFactories = { evidence: (run) => { scopes.push(run); return NOOP_RESEARCH_PORTS.evidence; } };
    await runOf(RUNS["a report accepted after a researcher"]!, { gates: [], ports });
    expect(scopes).toEqual([expect.objectContaining({ branchRunIds: [], researchRunId: "run-1", runId: "run-1", userMessage: "Проведи исследование матрасов." })]);
  });

  it("is what the engine hands the ports of an approval continuation, a new run that works on the rows of the run that started", async () => {
    const scope = await continuationScope([[...started(startResult("run-0")), ...held("call-held")]]);
    expect(scope).toMatchObject({ branchRunIds: ["run-0"], researchRunId: "run-0", runId: "run-c" });
  });

  it("reaches the same run through a chain of approvals, each finding the same start call", async () => {
    const scope = await continuationScope([[...started(startResult("run-0")), ...held("call-first")], held("call-held")]);
    expect(scope).toMatchObject({ branchRunIds: ["run-0", "run-1"], researchRunId: "run-0", runId: "run-c" });
    const first = direct({ gates: [] }, { runId: "run-a" });
    const stored = [...started(toolResultOutputText(await execute(first.tools[0]!, start))), ...held("call-first")];
    expect(researchRunOf(stored, { branchRunIds: ["run-a"], runId: "run-b" })).toBe("run-a");
    expect(researchRunOf([...stored, ...held("call-second")], { branchRunIds: ["run-a", "run-b"], runId: "run-c" })).toBe("run-a");
    // A start made again in a continuation keeps naming the research, not the run that made the call.
    const second = direct({ gates: [] }, { researchRunId: "run-a", runId: "run-b" });
    const again = [...stored, ...started(toolResultOutputText(await execute(second.tools[0]!, start)))];
    expect(researchRunOf(again, { branchRunIds: ["run-a", "run-b"], runId: "run-c" })).toBe("run-a");
  });

  it("ignores a stored value that names no run of this branch: a stored value grants nothing", async () => {
    const foreign = started(startResult("run-of-another-branch"));
    expect(researchOfTurn(foreign).researchRun).toBe("run-of-another-branch");
    expect(researchRunOf(foreign, { branchRunIds: ["run-0"], runId: "run-c" })).toBe("run-c");
    await expect(continuationScope([[...foreign, ...held("call-held")]])).resolves.toMatchObject({ researchRunId: "run-c", runId: "run-c" });
  });

  it("hands a Continue's run its own rows and the turn's research run to pick up, through the engine; any other message asks nothing", async () => {
    const after = async (text: string) => {
      const scopes: ResearchRunScope[] = [];
      const load = vi.fn(NOOP_RESEARCH_PORTS.resume.load);
      await afterInterruption({ ports: { resume: (run) => { scopes.push(run); return { ...NOOP_RESEARCH_PORTS.resume, load }; } }, steps: [{ calls: [start] }, { calls: [submit] }], text });
      return { load, scope: scopes[0]! };
    };
    const continued = await after(CONTINUE_TURN_TEXT);
    expect(continued.scope).toMatchObject({ branchRunIds: ["run-0"], researchRunId: "run-c", runId: "run-c" });
    expect(continued.load).toHaveBeenCalledExactlyOnceWith("run-0", expect.any(AbortSignal));
    expect((await after("Продолжай исследование.")).load).not.toHaveBeenCalled();
  });

  it("keeps the run's own id for an older stored start, one that was refused, and one of an earlier turn", () => {
    const branch = { branchRunIds: ["run-0"], runId: "run-c" };
    expect(researchRunOf(started("started"), branch)).toBe("run-c");
    expect(researchOfTurn(started("started"))).not.toHaveProperty("researchRun");
    const refused: TranscriptItem = { callId: "call-start", id: "stored-result", kind: "tool_result", name: START_RESEARCH_TOOL_NAME, outcome: "error", output: startResult("run-0") };
    expect(researchRunOf([started("started")[0]!, refused], branch)).toBe("run-c");
    expect(researchRunOf([...started(startResult("run-0")), { id: "msg-later", kind: "user", text: "Something else." }], branch)).toBe("run-c");
  });

  it("is read from a stored result whatever follows it: an excerpt of a long method, or a repeat note", () => {
    const branch = { branchRunIds: ["run-0"], runId: "run-c" };
    const long = JSON.stringify({ research_run: "run-0", method: "x".repeat(40_000), status: "started" });
    const excerpt = toolOutputExcerpt(long, { handle: "tor1_saved" });
    expect(excerpt.truncated).toBe(true);
    expect(researchRunOf(started(excerpt.output), branch)).toBe("run-0");
    expect(researchRunOf(started(`${startResult("run-0")}\n\nYou made this same call before.`), branch)).toBe("run-0");
  });

  it("gives an approval continuation a fresh clock: the port is the run's own, and its plan is released again", async () => {
    const planReleased = vi.fn();
    await continuationScope([[...started(startResult("run-0")), ...held("call-held")]], { time: () => ({ ...NOOP_RESEARCH_PORTS.time, planReleased }) });
    expect(planReleased).toHaveBeenCalledOnce();
  });
});

describe("the migration", () => {
  const sql = readFileSync("prisma/migrations/20261101140000_research_system_contract/migration.sql", "utf8");

  it("holds the contract's bounds and closed lists", () => {
    expect(sql).toContain(`"sizeBytes" BETWEEN 1 AND ${RESEARCH_PAGE_LIMITS.bytesPerPage}`);
    expect(sql).toContain(`length("goal") <= ${RESEARCH_LIMITS.goalCharacters}`);
    expect(sql).toContain(`length("claim") BETWEEN 1 AND ${RESEARCH_LIMITS.claimCharacters}`);
    expect(sql).toContain(`length("quote") BETWEEN 1 AND ${RESEARCH_LIMITS.quoteCharacters}`);
    expect(sql).toContain(`length("reason") BETWEEN 1 AND ${RESEARCH_LIMITS.reasonCharacters}`);
    expect(sql).toContain(`length("target") BETWEEN 1 AND ${RESEARCH_LIMITS.targetCharacters}`);
    expect(sql.match(/length\("url"\) BETWEEN 1 AND \d+/gu)).toEqual([`length("url") BETWEEN 1 AND ${RESEARCH_LIMITS.urlCharacters}`, `length("url") BETWEEN 1 AND ${RESEARCH_LIMITS.urlCharacters}`]);
    const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
    expect(sql).toContain(`"kind" IN (${list(RESEARCH_RECORD_KINDS)})`);
    expect(sql).toContain(`"sourceClass" IN (${list(RESEARCH_SOURCE_CLASSES)})`);
    expect(sql).toContain(`"standing" IN (${list(RESEARCH_STANDINGS)})`);
    expect(sql).toContain(`"quoteCheck" IN (${list(RESEARCH_QUOTE_CHECKS)})`);
  });
});
