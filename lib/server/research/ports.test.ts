import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_LIMITS, RESEARCH_PAGE_LIMITS, RESEARCH_QUOTE_CHECKS, RESEARCH_RECORD_KINDS, RESEARCH_SOURCE_CLASSES, RESEARCH_STANDINGS, START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME, type ResearchPlanProposal } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { NativeRunStore } from "../engine/runStore";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { ResearchGate } from "./gates";
import { NOOP_RESEARCH_PORTS, researchGatePorts, researchPorts, type ResearchPortFactories, type ResearchPorts, type ResearchRunScope } from "./ports";
import type { ResearchEngineDeps } from "./run";

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
const start = { arguments: PLAN, id: "call-start", name: START_RESEARCH_TOOL_NAME };
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

async function runOf(steps: readonly Step[], research: ResearchEngineDeps) {
  const { adapter, requests } = scripted(steps);
  const memory = engineOf(research);
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
  "a report accepted after a researcher": [{ calls: [start] }, { calls: [researcher] }, { text: "Outcome: done\nreport" }, { calls: [submit] }],
  "a provider that fails with a report in hand": [{ calls: [start] }, { calls: [submit] }, { fail: true }],
  "a provider that fails with nothing in hand": [{ calls: [start] }, { fail: true }],
  "a run that never researches": [{ text: "Answered directly." }],
  "text instead of a report": [{ calls: [start] }, { text: "Report as text." }, { text: "Report as text, again." }]
};

afterEach(() => vi.restoreAllMocks());

describe("no-op ports", () => {
  it.each(Object.keys(RUNS))("leave %s as it was", async (name) => {
    const steps = RUNS[name]!;
    const gates: readonly ResearchGate[] = [];
    const today = await runOf(steps, { gates });
    expect(await runOf(steps, { gates, ports: named })).toEqual(today);
    expect(await runOf(steps, { gates, ports: spied().ports })).toEqual(today);
  });

  it("are called only where the run hands over: nothing reads or writes a store, opens a window or composes while a report stands", async () => {
    const { calls, ports } = spied();
    await runOf(RUNS["a report accepted after a researcher"]!, { gates: [], ports });
    expect([...new Set(calls)].sort()).toEqual(["time.planReleased", "time.researcherRefusal", "time.researcherSignal"]);
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
    await expect(noop.report.compose({ ended: "failed" })).resolves.toBeNull();
    expect(noop.report.gates).toEqual([]);
    await expect(noop.resume.load(signal)).resolves.toBeNull();
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
    const steps: readonly Step[] = [{ calls: [start] }, { calls: [researcher] }, { calls: [submit] }];
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
    expect(compose).toHaveBeenCalledExactlyOnceWith({ ended: "failed" });
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
