import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_RESEARCH_FRAME_TOOL_NAME,
  RECORD_EVIDENCE_TOOL_NAME,
  RESEARCH_ROUND_LIMITS,
  researchFrameFromPlan,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchEvidenceRecord,
  type ResearchFrame
} from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_ERROR_CODES, SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { defaultNativeEngineDeps } from "../engine/defaultEngine";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { NativeRunStore } from "../engine/runStore";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import { toolOutputExcerpt } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { SubagentTypeResolver } from "../subagents/ports";
import type { StorageAdapter } from "../uploads/storage";
import { gapCheckGate } from "./gapCheck";
import type { ResearchGate, ResearchSubagentRequest } from "./gates";
import { createResearchCoverage, type ResearchFrameStore } from "./matrix";
import { NOOP_RESEARCH_PORTS, researchPorts, type ResearchPortFactories, type ResearchRunScope } from "./ports";
import { proposeCall } from "./planWindow.testFixtures";
import { researchOfTurn, type ResearchEngineDeps } from "./run";

/**
 * The matrix and the stops through the real engine with scripted models: what the real run lacked, which went round for 70 minutes on one
 * more detail each time. Only the stores are fake: the coverage port, the gates' seam and the tools are the ones a run gets.
 */
vi.mock("../prisma", () => ({ prisma: {} }));

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; onCall?: () => void; text?: string }>;

function scripted(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      step.onCall?.();
      options.signal?.throwIfAborted();
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])], usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

const PLAN = { questions: [{ question: "Which mattress holds up?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }], skipped_source_classes: [] };
const start = { arguments: { goal: "Choose a mattress." }, id: "call-start", name: START_RESEARCH_TOOL_NAME };
const begin = [start, proposeCall(PLAN)];
const submit = (id: string) => ({ arguments: { findings: [], report: `# Report ${id}\n\nIt holds up.`, unreachable: [] }, id, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });
const researcher = (name: string) => ({ arguments: { message: "Cover the cells.", name }, id: `call-${name}`, name: CALL_SUBAGENT_TOOL_NAME });
const DONE: Step = { text: "Outcome: done\n\nNothing more." };
/** A researcher's turn that answers nothing: it ran, and ends failed with `model_answer_empty`. */
const EMPTY: Step = { text: "" };

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
  const admitForeground = vi.fn(async (input: Parameters<SubagentThreadStore["admitForeground"]>[0]) => {
    turns += 1;
    return { continued: false, kind: "admitted" as const,
      thread: { anchorRunId: input.parentRunId, definitionId: null, id: `thread-${turns}`, name: input.name, parentThreadId: null, typeName: null },
      turn: { branchRunId: input.parentRunId, definitionRevisionId: null, effortSource: input.binding.effortSource, id: `turn-${turns}`, mode: "foreground" as const,
        modelId: input.binding.modelId, modelSource: input.binding.modelSource, parentRunId: input.parentRunId, provider: input.binding.provider,
        providerModelId: input.binding.providerModelId, reasoningEffort: input.binding.reasoningEffort, startedAt: new Date(), state: "running" as const, threadId: `thread-${turns}` } };
  });
  const threads = { admitForeground, ensureThread: vi.fn(), find: vi.fn(async () => null), result: vi.fn(async () => null), activeChildren: vi.fn(async () => 0), childResults: vi.fn(async () => []),
    endOrphanedTurns: vi.fn(async () => 0), setActiveState: vi.fn(async () => true), threadEffectItems: vi.fn(async () => []), backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]), settle: vi.fn(async () => true) } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []), now: () => 1_000_000,
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    research, runs, savedResults: { read: vi.fn(async () => ({ arguments: {}, text: "whole page", toolName: "fetch_url" })) }, subagentThreads: threads, toolCalls, transcripts
  };
  return { admitForeground, appended, deps, published: () => published };
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
    // The user chose Deep research for the message (operator decision 2026-11-05).
    deepResearch: true,
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    searchPlan: { mode: "all_selected" as const, options: [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
      modelId: "fake-qsa", optionId: "hosted", protocol: "hosted", provider: "fake", providerModelId: "model-1", revisionId: "rev", searchStrategyRowId: "strategy" }] },
    toolBudgets: { maxMcpToolsPerDiscovery: 10, maxToolCalls: null, maxToolRounds: null }, toolMode: "auto" as const
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
        providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

const run = (adapter: ProviderAdapter, memory: ReturnType<typeof engineOf>, extra: Partial<NativeRunExecutionInput> = {}) => createNativeRunExecutionResponse({ adapter,
  created: { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" }, engine: memory.deps, prepared: prepared(), repository: repository() as unknown as RunRepository,
  services: {}, subagents: { background: new FakeSubagentBackgroundControl() }, userId: "user", ...extra }).text();

const resultsOf = (request: ProviderRunRequest | undefined, name: string) =>
  (request?.history ?? []).flatMap((item) => item.type === "tool_result" && item.name === name ? [item.output] : []);

const sendingBack = (name: string, seen: string[] = []): ResearchGate => ({ name, run: async (draft) => {
  seen.push(draft.report);
  return { kind: "send_back", message: `${name} wants one more detail.`, unresolvedNote: `${name} left this open.` };
} });

const FRAME: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "Durability", key: "durability", why: "It is bought for years." }, { criterion: "Firmness", key: "firmness", why: "It decides comfort." }],
  rows: [{ key: "x1", label: "Lonax X1" }] };

const finding = (rowKey: string, criterionKey: string): Extract<ResearchEvidenceRecord, { kind: "finding" }> => ({ author: { name: null, threadId: null }, claim: "It holds.", createdAt: "", criterionKey, id: `${rowKey}-${criterionKey}`, kind: "finding",
  pageId: null, publishedOn: null, quote: "It holds.", quoteCheck: { reason: null, status: "found" }, registrableDomain: null, rowKey, runId: "run-1", sequence: 0, sourceClass: "independent_tests",
  standing: "confirmed", supersedes: null, textGroupKey: null, url: "https://lab.example/x1" });

const nothingFound = (rowKey: string, criterionKey: string): ResearchEvidenceRecord => ({ author: { name: null, threadId: null }, createdAt: "", criterionKey, id: `${rowKey}-${criterionKey}`, kind: "not_found", pageId: null,
  publishedOn: null, quoteCheck: null, reason: "Nowhere.", registrableDomain: null, rowKey, runId: "run-1", sequence: 0, sourceClass: null, supersedes: null, textGroupKey: null });

const WEB_RESEARCHER_GROUPS = [SUBAGENT_TOOL_GROUPS.web_search, SUBAGENT_TOOL_GROUPS.web_fetch, SUBAGENT_TOOL_GROUPS.workspace];

/** The user's custom researcher, the kind a research keeps, which narrows its tools to what a researcher reads with. */
const webResearcherTypes: SubagentTypeResolver = { catalog: async () => [], resolve: async () => ({ kind: "found", type: { definitionId: "type", description: "", instructions: "Read the web.",
  name: "web-researcher", providerModelId: null, reasoningEffort: null, revisionId: "rev", toolGroups: WEB_RESEARCHER_GROUPS } }) };

/** The real coverage port on a frame and records held in memory. */
function matrixPorts(initial: ResearchFrame = FRAME, records: ResearchEvidenceRecord[] = []) {
  const held = { frame: initial as unknown, version: 1 };
  const store: ResearchFrameStore = {
    read: async () => ({ ...held }),
    swap: async (_key, version, frame) => {
      if (version !== held.version) return false;
      held.frame = frame;
      held.version += 1;
      return true;
    }
  };
  const ports: ResearchPortFactories = { coverage: createResearchCoverage({ store }), evidence: () => ({ ...NOOP_RESEARCH_PORTS.evidence, records: async () => records }) };
  return { held, ports, records };
}

afterEach(() => vi.restoreAllMocks());

describe("no gate passes its send backs, whatever a model does", () => {
  it("holds one gate to its cap: its next send back goes into the answer, and no paid round follows", async () => {
    const seen: string[] = [];
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [submit("one")] }, { calls: [submit("two")] }, { calls: [submit("three")] }, { calls: [submit("four")] }]);
    const memory = engineOf({ gates: [sendingBack("loop", seen)] });
    await run(adapter, memory);
    expect(seen).toHaveLength(RESEARCH_ROUND_LIMITS.sendBacksPerCheck + 1);
    expect(requests).toHaveLength(4);
    expect(memory.published()).toContain("# Report three");
    expect(memory.published()).toContain("loop left this open.");
    expect(resultsOf(requests[3], SUBMIT_RESEARCH_DRAFT_TOOL_NAME).map((output) => (JSON.parse(output) as { gate: string }).gate)).toEqual(["loop", "loop"]);
  });

  it("counts each gate on its own: the second gets its turns once the first is done, and nothing passes four send backs in all", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const reports = ["one", "two", "three", "four", "five", "six", "seven"];
    const { adapter, requests } = scripted([{ calls: begin }, ...reports.map((id) => ({ calls: [submit(id)] }))]);
    const memory = engineOf({ gates: [sendingBack("first", first), sendingBack("second", second)] });
    await run(adapter, memory);
    expect(requests).toHaveLength(6);
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(3);
    expect(memory.published()).toContain("# Report five");
    expect(memory.published()).toContain("first left this open.");
    expect(memory.published()).toContain("second left this open.");
  });

  it("carries the count across an approval, from the results the first run really stored", async () => {
    const before = engineOf({ gates: [sendingBack("loop")] });
    await run(scripted([{ calls: begin }, { calls: [submit("one")] }, { calls: [submit("two")] }, { text: "Out of ideas." }]).adapter, before);
    const stored: TranscriptItem[] = [...before.appended.filter((item) => item.kind === "tool_call" || item.kind === "tool_result"),
      { arguments: "{}", callId: "call-held", id: "held-call", kind: "tool_call", name: "mcp_shop_buy" },
      { callId: "call-held", id: "held-result", kind: "tool_result", name: "mcp_shop_buy", outcome: "error", output: "Waiting for approval." }];

    const seen: string[] = [];
    const { adapter, requests } = scripted([{ calls: [submit("three")] }, { calls: [submit("four")] }]);
    // Run-0 was sent with Deep research, which is what lets its approval go on with the research.
    const after = engineOf({ gates: [sendingBack("loop", seen)], ports: { resume: () => ({ ...NOOP_RESEARCH_PORTS.resume,
      sentWithDeepResearch: async (runIds) => runIds.includes("run-0") }) } });
    vi.mocked(after.deps.approvedCall).mockResolvedValue({ providerCallId: "call-held", toolName: "mcp_shop_buy" });
    vi.mocked(after.deps.transcripts.nativeRunsForAnswers).mockResolvedValue(new Map([["answer-0", "run-0"]]));
    vi.mocked(after.deps.transcripts.loadRuns).mockResolvedValue(new Map([["run-0", stored]]));
    const content = (text: string) => ({ blocks: [{ text, type: "text" as const }] });
    const messages = [{ content: content("Проведи исследование."), id: "question", role: "user" as const }, { content: content(""), id: "answer-0", role: "assistant" as const },
      { content: content("The user approved it."), id: "current-user-message", role: "user" as const }];
    const base = prepared();
    // A server's turn never carries the choice of its own.
    const { deepResearch: _chosen, ...continued } = base.normalizedRequest;
    void _chosen;
    const request = { ...continued, context: { messages, mode: "branch_path" as const } } as ProviderRunRequest;
    await run(adapter, after, { approvalContinuation: { approvalId: "approval-1" }, created: { assistantMessageId: "answer-c", runId: "run-c", userMessageId: "current-user-message" },
      prepared: { ...base, normalizedRequest: request, providerRequest: request } });
    expect(seen).toEqual(["# Report three\n\nIt holds up."]);
    expect(requests).toHaveLength(1);
    expect(after.published()).toContain("loop left this open.");
  });

  it("keeps a gate's count from a result too long to be stored whole, and reads an older result as naming no gate", () => {
    const stored = (output: string): TranscriptItem[] => [
      { arguments: JSON.stringify({ goal: "Choose a mattress." }), callId: "s", id: "s1", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
      { arguments: JSON.stringify(submit("one").arguments), callId: "d", id: "d1", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
      { callId: "d", id: "d2", kind: "tool_result", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME, outcome: "complete", output }
    ];
    const long = JSON.stringify({ status: "sent_back", gate: "verifier", message: "x".repeat(40_000) });
    const excerpt = toolOutputExcerpt(long, { handle: "tor1_saved" });
    expect(excerpt.truncated).toBe(true);
    expect(researchOfTurn(stored(excerpt.output)).attempts).toEqual([{ draft: expect.anything(), gate: "verifier", message: "" }]);
    expect(researchOfTurn(stored(JSON.stringify({ message: "Again.", status: "sent_back" }))).attempts).toEqual([{ draft: expect.anything(), message: "Again." }]);
  });
});

describe("rounds that fill no new cell end research", () => {
  it("stops after two rounds: the third call starts nothing and says why, and the report goes out with nothing of the empty cells after it", async () => {
    const matrix = matrixPorts();
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [researcher("b")] }, DONE, { calls: [researcher("c")] }, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [gapCheckGate], ports: matrix.ports });
    await run(adapter, memory);
    expect(memory.admitForeground).toHaveBeenCalledTimes(RESEARCH_ROUND_LIMITS.noNewCellRounds);
    expect(resultsOf(requests[6], CALL_SUBAGENT_TOOL_NAME).at(-1)).toContain("research_no_new_cell");
    expect(requests).toHaveLength(7);
    // What stayed empty is the report's to say: no list of cells, and no word of rounds.
    expect(memory.published()).toMatch(/^# Report one/u);
    expect(memory.published()).not.toContain("several rounds in a row found nothing new");
    expect(memory.published()).not.toContain("Lonax X1: Durability, Firmness");
  });

  it("counts a batch of one response as one round, whoever else ran in it", async () => {
    const matrix = matrixPorts();
    const { adapter } = scripted([{ calls: begin }, { calls: [researcher("a"), researcher("b")] }, DONE, DONE, { calls: [researcher("c"), researcher("d")] }, DONE, DONE,
      { calls: [researcher("e")] }, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    await run(adapter, memory);
    expect(memory.admitForeground).toHaveBeenCalledTimes(4);
  });

  it("starts the count again at a round that fills a cell, and a cell recorded as not found fills one", async () => {
    const matrix = matrixPorts({ ...FRAME, rows: [{ key: "x1", label: "Lonax X1" }, { key: "y2", label: "Dreamline Y2" }] });
    const fills = (record: ResearchEvidenceRecord) => () => { matrix.records.push(record); };
    const { adapter } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [researcher("b")] }, { ...DONE, onCall: fills(finding("x1", "durability")) },
      { calls: [researcher("c")] }, DONE, { calls: [researcher("d")] }, { ...DONE, onCall: fills(nothingFound("y2", "firmness")) }, { calls: [researcher("e")] }, DONE, { calls: [researcher("f")] }, DONE,
      { calls: [researcher("g")] }, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    await run(adapter, memory);
    expect(memory.admitForeground.mock.calls.map(([input]) => input.name)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("stops researchers that keep ending empty by the same rule, rather than letting them run on until time ends", async () => {
    const matrix = matrixPorts();
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, EMPTY, { calls: [researcher("b")] }, EMPTY, { calls: [researcher("c")] }, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    await run(adapter, memory);
    expect(resultsOf(requests[3], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("model_answer_empty");
    expect(memory.admitForeground.mock.calls.map(([input]) => input.name)).toEqual(["a", "b"]);
    expect(resultsOf(requests[6], CALL_SUBAGENT_TOOL_NAME).at(-1)).toContain("research_no_new_cell");
  });

  it("counts what a failed turn saved: a productive failure between two empty rounds starts the count again", async () => {
    const matrix = matrixPorts();
    const saves = () => { matrix.records.push(finding("x1", "durability")); };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [researcher("b")] }, { ...EMPTY, onCall: saves }, { calls: [researcher("c")] }, DONE,
      { calls: [researcher("d")] }, DONE, { calls: [researcher("e")] }, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    await run(adapter, memory);
    expect(memory.admitForeground.mock.calls.map(([input]) => input.name)).toEqual(["a", "b", "c", "d"]);
    expect(resultsOf(requests[5], CALL_SUBAGENT_TOOL_NAME).at(-1)).toContain("1 newly filled in this round so far");
  });

  it("counts nothing for an admission's refusal", async () => {
    const matrix = matrixPorts();
    const { adapter } = scripted([{ calls: begin }, { calls: [researcher("a")] }, { calls: [researcher("b")] }, { calls: [researcher("c")] }, { calls: [researcher("d")] }, DONE, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    const refused = { code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" as const };
    memory.admitForeground.mockResolvedValueOnce(refused as never).mockResolvedValueOnce(refused as never).mockResolvedValueOnce(refused as never);
    await run(adapter, memory);
    expect(memory.admitForeground.mock.calls.map(([input]) => input.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("starts no background turn when the mailbox's turn ends between the reads of a message to it", async () => {
    const matrix = matrixPorts();
    const message = { arguments: { background: true, message: "Also this.", name: "mail" }, id: "late", name: CALL_SUBAGENT_TOOL_NAME };
    const { adapter } = scripted([{ calls: begin }, { calls: [message] }, { text: "Outcome: done\nDone." }, { calls: [researcher("a")] }, DONE, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    const background = new FakeSubagentBackgroundControl();
    const thread = { anchorRunId: "run-1", definitionId: null, id: "thread-mail", name: "mail", parentThreadId: null, typeName: null };
    const running = { branchRunId: "run-1", id: "turn-mail", mode: "background", parentRunId: "run-1", state: "running" };
    const ended = { ...running, state: "done" };
    let reads = 0;
    vi.mocked(memory.deps.subagentThreads!.find).mockImplementation(async ({ name }) => {
      if (name !== "mail") return null;
      reads += 1;
      return (reads === 1 ? { active: running, latest: running, thread } : { active: null, latest: ended, thread }) as never;
    });
    await run(adapter, memory, { subagents: { background } });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(background.turns).toHaveLength(0);
  });

  it("counts nothing for a message left in a running turn's mailbox", async () => {
    const matrix = matrixPorts();
    const message = (id: string) => ({ arguments: { message: `Also ${id}.`, name: "mail" }, id, name: CALL_SUBAGENT_TOOL_NAME });
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [message("first")] }, { calls: [message("second")] }, { calls: [message("third")] }, { calls: [researcher("a")] }, DONE, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    const background = new FakeSubagentBackgroundControl();
    const deliver = vi.spyOn(background, "deliver").mockResolvedValue({ kind: "delivered", state: "running" });
    const thread = { anchorRunId: "run-1", definitionId: null, id: "thread-mail", name: "mail", parentThreadId: null, typeName: null };
    const active = { branchRunId: "run-1", id: "turn-mail", mode: "background", parentRunId: "run-1", state: "running" };
    vi.mocked(memory.deps.subagentThreads!.find).mockImplementation(async ({ name }) => (name === "mail" ? { active, latest: active, thread } : null) as never);
    await run(adapter, memory, { subagents: { background } });
    expect(deliver).toHaveBeenCalledTimes(3);
    // The mailbox gets the model's words as written: no research brief, matrix or unreachable list rides on a message.
    expect(deliver.mock.calls.map(([input]) => input.message.text)).toEqual(["Also first.", "Also second.", "Also third."]);
    expect(resultsOf(requests[2], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("delivered");
    expect(memory.admitForeground.mock.calls.map(([input]) => input.name)).toEqual(["a"]);
  });

  it("does not count a round in which nothing ran", async () => {
    const matrix = matrixPorts();
    const invalid = { arguments: { message: "", name: "bad name!" }, id: "call-invalid", name: CALL_SUBAGENT_TOOL_NAME };
    const { adapter } = scripted([{ calls: begin }, { calls: [invalid] }, { calls: [{ ...invalid, arguments: { message: "", name: "worse name!" }, id: "call-worse" }] },
      { calls: [researcher("a")] }, DONE, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [], ports: matrix.ports });
    await run(adapter, memory);
    expect(memory.admitForeground).toHaveBeenCalledOnce();
  });

  it("keeps a run with no frame as it always was: rounds go on, and no brief or result carries a matrix", async () => {
    const steps = ["a", "b", "c", "d"].flatMap((name): Step[] => [{ calls: [researcher(name)] }, DONE]);
    const { adapter, requests } = scripted([{ calls: begin }, ...steps, { calls: [submit("one")] }]);
    const memory = engineOf({ gates: [] });
    await run(adapter, memory);
    expect(memory.admitForeground).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(requests.at(-1)!.history)).not.toContain("The matrix (from the server)");
    expect(JSON.stringify(requests[2]!.history)).not.toContain("# The matrix (from the server)");
  });

  it("goes on when the matrix cannot be read: a read that fails never stops research or costs the answer", async () => {
    const steps = ["a", "b", "c"].flatMap((name): Step[] => [{ calls: [researcher(name)] }, DONE]);
    const { adapter } = scripted([{ calls: begin }, ...steps, { calls: [submit("one")] }]);
    const broken = { ...NOOP_RESEARCH_PORTS.coverage, coverage: async () => { throw new Error("down"); }, frame: async () => { throw new Error("down"); } };
    const memory = engineOf({ gates: [gapCheckGate], ports: { coverage: () => broken } });
    await run(adapter, memory);
    expect(memory.admitForeground).toHaveBeenCalledTimes(3);
    expect(memory.published()).toContain("# Report one");
  });
});

describe("the key specifications of the options a draft recommends, through the real engine", () => {
  const KEYED: ResearchFrame = { ...FRAME, criteria: [{ ...FRAME.criteria[0]!, decisive: true }, FRAME.criteria[1]!] };
  const leading = (id: string) => ({ arguments: { branch_picks: [], does_not_separate: null, pick_row_key: "x1", record_ids: ["x1-durability", "x1-firmness"], report: `# Report ${id}\n\nTake Lonax X1.`,
    summary: { row_keys: ["x1"], text: "Take Lonax X1." }, unreachable: [] }, id, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });
  const secondSite: ResearchEvidenceRecord = { ...finding("x1", "durability"), id: "x1-durability-shop", url: "https://shop.example/x1" };

  it("asks a second site in the line after each researcher once a draft names its options, and never before", async () => {
    const matrix = matrixPorts(KEYED, [finding("x1", "durability"), finding("x1", "firmness")]);
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [leading("one")] }, { calls: [researcher("b")] }, DONE, { calls: [leading("two")] }]);
    await run(adapter, engineOf({ gates: [sendingBack("judge")], ports: matrix.ports }));
    const [before, after] = resultsOf(requests[6], CALL_SUBAGENT_TOOL_NAME);
    expect(before).toContain("Nothing is left for researchers to fill.");
    expect(after).toContain("To confirm from a second site, the maker's or a seller's, for the options the last draft recommends: x1: durability. Send researchers for these confirmations only.");
    expect(after).not.toContain("firmness");
  });

  it("counts a round that confirmed what the last draft's options needed as one that found something, so research goes on", async () => {
    const matrix = matrixPorts(KEYED, [finding("x1", "durability"), finding("x1", "firmness")]);
    const confirms = () => { matrix.records.push(secondSite); };
    const { adapter } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [leading("one")] }, { calls: [researcher("b")] }, { ...DONE, onCall: confirms },
      { calls: [researcher("c")] }, DONE, { calls: [leading("two")] }]);
    const memory = engineOf({ gates: [sendingBack("judge")], ports: matrix.ports });
    await run(adapter, memory);
    // Round a filled nothing new, so without the confirmation of round b, round c would be the third in a row and refused.
    expect(memory.admitForeground.mock.calls.map(([input]) => input.name)).toEqual(["a", "b", "c"]);
  });
});

describe("each round is planned from the empty cells", () => {
  it("ends a researcher's brief with the matrix, and tells the main agent what stayed empty", async () => {
    const matrix = matrixPorts(FRAME, [finding("x1", "firmness")]);
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: matrix.ports }));
    const brief = JSON.stringify(requests[2]!.history);
    expect(brief).toContain("# The matrix (from the server)");
    expect(brief).toContain("Rows: x1 (Lonax X1).");
    expect(brief).toContain("1 of 2 cells are still empty. x1: durability");
    const line = resultsOf(requests[3], CALL_SUBAGENT_TOOL_NAME)[0]!;
    expect(line).toContain("The matrix (from the server): 1 of 2 cells empty, 0 newly filled in this round so far.");
    expect(line).toContain("x1: durability. Send researchers for empty cells only.");
  });

  it("gives a researcher continued by name the matrix as it stands, without the method again", async () => {
    const matrix = matrixPorts();
    const fills = () => { matrix.records.push(finding("x1", "durability")); };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, { ...DONE, onCall: fills }, { calls: [{ ...researcher("a"), id: "call-again" }] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: matrix.ports }));
    const brief = JSON.stringify(requests[4]!.history);
    expect(brief).toContain("1 of 2 cells are still empty. x1: firmness");
    expect(brief).not.toContain("# Research method");
  });

  it("tells the model the matrix is covered once it is", async () => {
    const matrix = matrixPorts(FRAME, [finding("x1", "firmness"), finding("x1", "durability")]);
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("a")] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: matrix.ports }));
    expect(resultsOf(requests[3], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("0 of 2 cells empty, 0 newly filled in this round so far. Nothing is left for researchers to fill.");
  });
});

describe("change_research_frame through the real engine", () => {
  const change = (id: string, key: string) => ({ arguments: { cases: null, change: "add_row", key, label: `Row ${key}`, reason: "Found along the way.", url: null, why: null }, id, name: CHANGE_RESEARCH_FRAME_TOOL_NAME });
  const toolsOf = (request: ProviderRunRequest | undefined) => request?.tools?.map((tool) => tool.name) ?? [];

  it("reaches the main agent and every researcher, and each change lands under whoever made it", async () => {
    const matrix = matrixPorts();
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [change("call-main", "main-row"), researcher("a")] }, { calls: [change("call-a", "a-row")] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: matrix.ports }));
    expect(toolsOf(requests[0])).toContain(CHANGE_RESEARCH_FRAME_TOOL_NAME);
    expect(toolsOf(requests[2])).toContain(CHANGE_RESEARCH_FRAME_TOOL_NAME);
    const frame = matrix.held.frame as ResearchFrame;
    expect(frame.rows.map(({ key }) => key)).toEqual(expect.arrayContaining(["a-row", "main-row", "x1"]));
    expect(frame.changes.map(({ by, key }) => [key, by.name]).sort()).toEqual([["a-row", "a"], ["main-row", null]]);
    expect(frame.changes[0]).toMatchObject({ change: "add_row", reason: "Found along the way." });
  });

  it("is refused before the plan stands, and while the user's edit owes a rebuilt plan, with nothing written", async () => {
    const matrix = matrixPorts();
    const { adapter, requests } = scripted([{ calls: [start] }, { calls: [change("call-early", "early")] }, { calls: [proposeCall(PLAN)] }, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: matrix.ports }));
    expect(resultsOf(requests[2], CHANGE_RESEARCH_FRAME_TOOL_NAME)[0]).toContain("research_frame_closed");
    expect(matrix.held.version).toBe(1);

    const edited = matrixPorts();
    const planWindow: ResearchPortFactories["planWindow"] = () => ({ open: async ({ proposal }) => ({ changed: true, plan: proposal, releasedBy: "saved_edit" }) });
    const rebuild = scripted([{ calls: begin }, { calls: [change("call-owed", "owed")] }, { calls: [proposeCall(PLAN, "call-rebuilt")] }, { calls: [submit("one")] }]);
    await run(rebuild.adapter, engineOf({ gates: [], ports: { ...edited.ports, planWindow } }));
    expect(resultsOf(rebuild.requests[2], CHANGE_RESEARCH_FRAME_TOOL_NAME)[0]).toContain("research_frame_closed");
    expect(edited.held.version).toBe(1);
  });

  it("never reaches a gate's turn, whatever groups it runs with, nor does record_evidence", async () => {
    const turn = (name: string, tools: ResearchSubagentRequest["tools"]): ResearchSubagentRequest => ({ brief: "Check it.", instructions: "Check.", model: "main", name, tools });
    const gate: ResearchGate = { name: "turns", run: async (_draft, context) => {
      await context.subagents.run(turn("gap-judge", []), context.signal);
      await context.subagents.run(turn("verifier", [SUBAGENT_TOOL_GROUPS.web_fetch]), context.signal);
      await context.subagents.run(turn("skeptic", WEB_RESEARCHER_GROUPS), context.signal);
      return { kind: "pass" };
    } };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [submit("one")] }, { text: "Outcome: done\n\nNo gaps." }, { text: "Outcome: done\n\nHolds." }, { text: "Outcome: done\n\nStands." }]);
    await run(adapter, engineOf({ gates: [gate], ports: matrixPorts().ports }));
    expect(requests).toHaveLength(5);
    for (const request of requests.slice(2)) {
      expect(toolsOf(request)).not.toContain(CHANGE_RESEARCH_FRAME_TOOL_NAME);
      expect(toolsOf(request)).not.toContain(RECORD_EVIDENCE_TOOL_NAME);
    }
  });

  it("reaches a custom researcher whatever its groups: it is offered both tools, and what it records fills a cell", async () => {
    const records: ResearchEvidenceRecord[] = [];
    const matrix = matrixPorts(FRAME, records);
    const record = { claim: null, criterion_key: "firmness", dataset: null, kind: "not_found", quote: null, reason: "Nowhere.", row_key: "x1", source_class: null, standing: null, supersedes: null, target: null, url: null };
    const written = nothingFound("x1", "firmness");
    const evidence = { ...NOOP_RESEARCH_PORTS.evidence, record: async () => {
      records.push(written);
      return { kind: "recorded" as const, record: written };
    }, records: async () => records };
    const web = { arguments: { message: "Read the shops.", name: "lab", type: "web-researcher" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [web] }, { calls: [{ arguments: record, id: "call-record", name: RECORD_EVIDENCE_TOOL_NAME }] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: { ...matrix.ports, evidence: () => evidence } }), { subagents: { background: new FakeSubagentBackgroundControl(), types: webResearcherTypes } });
    expect(toolsOf(requests[2])).toEqual(expect.arrayContaining([CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME]));
    expect(toolsOf(requests[2])).not.toContain("read_secret");
    expect(resultsOf(requests[3], RECORD_EVIDENCE_TOOL_NAME)[0]).toContain("record_id");
    expect(resultsOf(requests[4], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("1 of 2 cells empty, 1 newly filled in this round so far");
  });

  it("is offered only where research can run, to no agent elsewhere", async () => {
    const offered = async (extra: Partial<NativeRunExecutionInput>) => {
      const { adapter, requests } = scripted([{ calls: [researcher("a")] }, DONE, { text: "Answer." }]);
      await run(adapter, engineOf({ gates: [] }), extra);
      return [toolsOf(requests[0]).includes(CHANGE_RESEARCH_FRAME_TOOL_NAME), toolsOf(requests[1]).includes(CHANGE_RESEARCH_FRAME_TOOL_NAME)];
    };
    await expect(offered({})).resolves.toEqual([true, true]);
    await expect(offered({ telegram: true })).resolves.toEqual([false, false]);
    await expect(offered({ scheduled: true })).resolves.toEqual([false, false]);
  });

  it("answers a record under a key the matrix lacks with its keys, and adding the key fills the cell as the record stands", async () => {
    const records: ResearchEvidenceRecord[] = [];
    const matrix = matrixPorts(FRAME, records);
    const RECORD = { claim: null, criterion_key: "firmness", dataset: null, kind: "not_found", quote: null, reason: "Nowhere.", row_key: "new-row", source_class: null, standing: null, supersedes: null, target: null, url: null };
    const notFound = nothingFound("new-row", "firmness");
    const evidence = { ...NOOP_RESEARCH_PORTS.evidence, record: async () => {
      records.push(notFound);
      return { kind: "recorded" as const, record: notFound };
    }, records: async () => records };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [{ arguments: RECORD, id: "call-record", name: RECORD_EVIDENCE_TOOL_NAME }] },
      { calls: [change("call-add", "new-row")] }, { calls: [researcher("a")] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: { ...matrix.ports, evidence: () => evidence } }));
    const hint = JSON.parse(resultsOf(requests[2], RECORD_EVIDENCE_TOOL_NAME)[0]!) as { matrix: string };
    expect(hint.matrix).toContain("row_key new-row");
    expect(hint.matrix).toContain("Rows: x1.");
    expect(hint.matrix).toContain("Criteria: durability, firmness.");
    expect(hint.matrix).toContain(CHANGE_RESEARCH_FRAME_TOOL_NAME);
    expect(resultsOf(requests[5], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("3 of 4 cells empty");
  });
});

describe("candidates noted through the real engine", () => {
  const frameCall = (id: string, change: Record<string, unknown>) => ({ arguments: { cases: null, key: null, label: null, url: null, why: null, ...change }, id, name: CHANGE_RESEARCH_FRAME_TOOL_NAME });
  const LISTING = "https://www.ozon.ru/category/matrasy-15018/?sorting=rating";
  const note = (id: string, url: string = LISTING) =>
    frameCall(id, { change: "note_candidate", label: "Dreamline SleepDream Medium S1000", reason: "An Ozon listing of 180x200 shows it.", url });
  const aside = (id: string) => frameCall(id, { change: "set_aside", key: "dreamline-sleep-dream-medium-s1000", reason: "Sold out in every shop." });

  it("stores a researcher's note with its page, which the main agent reads after that report, refuses the researcher's set_aside, and the main agent's closes it", async () => {
    const matrix = matrixPorts(FRAME, [finding("x1", "durability"), finding("x1", "firmness")]);
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("marketplaces")] }, { calls: [note("call-note")] }, { calls: [aside("call-early-aside")] }, DONE,
      { calls: [aside("call-aside")] }, { calls: [researcher("brands")] }, DONE, { calls: [submit("one")] }]);
    await run(adapter, engineOf({ gates: [], ports: matrix.ports }));
    expect(resultsOf(requests[3], CHANGE_RESEARCH_FRAME_TOOL_NAME)[0]).toContain("Candidate noted under key dreamline-sleep-dream-medium-s1000");
    expect(resultsOf(requests[4], CHANGE_RESEARCH_FRAME_TOOL_NAME)[1]).toContain("only the main agent sets a noted candidate aside");
    const [first, second] = resultsOf(requests[8], CALL_SUBAGENT_TOOL_NAME);
    expect(first).toContain("Candidates noted (from the server), neither a row nor set aside: 1. Those named on the most sites come first;");
    expect(first).toContain('named on 1 site by 1 agent: {"key":"dreamline-sleep-dream-medium-s1000","name":"Dreamline SleepDream Medium S1000",' +
      '"reason":"An Ozon listing of 180x200 shows it."}');
    expect(resultsOf(requests[6], CHANGE_RESEARCH_FRAME_TOOL_NAME).at(-1)).toContain("Set aside: dreamline-sleep-dream-medium-s1000.");
    expect(second).not.toContain("Candidates noted");
    const frame = matrix.held.frame as ResearchFrame;
    expect(frame.candidates).toEqual([{ key: "dreamline-sleep-dream-medium-s1000", label: "Dreamline SleepDream Medium S1000",
      notes: [{ at: expect.any(String), by: { name: "marketplaces", threadId: "thread-1" }, reason: "An Ozon listing of 180x200 shows it.", url: LISTING }] }]);
    expect(frame.setAside).toEqual([{ at: expect.any(String), key: "dreamline-sleep-dream-medium-s1000", reason: "Sold out in every shop." }]);
    expect(frame.rows).toEqual(FRAME.rows);
  });

  it("raises a frequent candidate still open at draft time through the real gap check, and a row covering it closes it", async () => {
    const matrix = matrixPorts(FRAME, [finding("x1", "durability"), finding("x1", "firmness")]);
    const addRow = frameCall("call-row", { change: "add_row", key: "sleepdream", label: "Dreamline SleepDream Medium S1000", reason: "Ranked among the most sold." });
    // One researcher saw it on two sites; a repeat from a site it noted is refused and adds nothing.
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("marketplaces")] }, { calls: [note("call-note")] },
      { calls: [note("call-note-2", "https://market.yandex.ru/catalog--matrasy/1")] }, { calls: [note("call-note-3", "https://ozon.ru/product/sleepdream-1/")] }, DONE,
      { calls: [submit("one")] }, { calls: [addRow] }, { calls: [submit("two")] }, { text: JSON.stringify({ gaps: [], limits: [] }) }]);
    const memory = engineOf({ gates: [gapCheckGate], ports: matrix.ports });
    await run(adapter, memory);
    expect(resultsOf(requests[4], CHANGE_RESEARCH_FRAME_TOOL_NAME).at(-1)).toContain("named on 2 sites by 1 agent now.");
    expect(resultsOf(requests[5], CHANGE_RESEARCH_FRAME_TOOL_NAME).at(-1)).toContain("you noted dreamline-sleep-dream-medium-s1000 from ozon.ru already.");
    expect(resultsOf(requests[7], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("Candidate dreamline-sleep-dream-medium-s1000: add it as a row");
    expect((matrix.held.frame as ResearchFrame).rows.map(({ key }) => key)).toEqual(["x1", "sleepdream"]);
    // Once a row covers it nothing is asked of it again, and the report goes out.
    expect(requests.slice(9).flatMap((request) => resultsOf(request, SUBMIT_RESEARCH_DRAFT_TOOL_NAME)).join("\n")).not.toContain("Candidate dreamline");
    expect(memory.published()).toContain("Report two");
  });

  it("leaves a candidate one researcher saw on one site in the pool, with no send back", async () => {
    const matrix = matrixPorts(FRAME, [finding("x1", "durability"), finding("x1", "firmness")]);
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher("marketplaces")] }, { calls: [note("call-note")] }, DONE, { calls: [submit("one")] },
      { text: JSON.stringify({ gaps: [], limits: [] }) }]);
    const memory = engineOf({ gates: [gapCheckGate], ports: matrix.ports });
    await run(adapter, memory);
    expect(resultsOf(requests[4], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("named on 1 site by 1 agent");
    expect(requests.flatMap((request) => resultsOf(request, SUBMIT_RESEARCH_DRAFT_TOOL_NAME)).join("\n")).not.toContain("Candidate dreamline");
    expect(memory.published()).toContain("Report one");
  });
});

describe("the default engine", () => {
  const scope = { branchRunIds: [], chatId: "chat", researchRunId: "run-1", runId: "run-c", userId: "user", now: () => 0 } as unknown as ResearchRunScope;
  const where = { chatId: "chat", modelRunId: "run-1", userId: "user" };

  function client(frame: unknown = FRAME) {
    return {
      researchEvidence: { findMany: vi.fn(async () => []) },
      researchFrame: { findFirst: vi.fn(async () => ({ continuedFromRunId: null, frame, version: 3 })), updateMany: vi.fn(async () => ({ count: 1 })) }
    };
  }

  const factories = (database: ReturnType<typeof client>) => defaultNativeEngineDeps({} as StorageAdapter, database as never).research!.ports!;

  it("gives a run the real matrix, on the frame of its research run under its owner and chat, never the no-op", async () => {
    const database = client();
    const { coverage } = researchPorts(factories(database), scope);
    expect(coverage).not.toBe(NOOP_RESEARCH_PORTS.coverage);
    const signal = new AbortController().signal;
    await expect(coverage.frame(signal)).resolves.toEqual(FRAME);
    expect(database.researchFrame.findFirst).toHaveBeenLastCalledWith({ select: { frame: true, version: true }, where });
    await expect(coverage.coverage(signal)).resolves.toMatchObject({ empty: 2, filled: 0 });
  });

  it("writes a change over the version it read, to the same row", async () => {
    const database = client();
    const { coverage } = researchPorts(factories(database), scope);
    const row = { key: "y2", label: "Dreamline Y2" };
    await expect(coverage.change({ change: "add_row", reason: "A shop sells it.", row }, { name: "a", threadId: "thread-1" }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { rows: [FRAME.rows[0], row] } });
    expect(database.researchFrame.updateMany).toHaveBeenCalledExactlyOnceWith({ data: { frame: expect.objectContaining({ rows: [FRAME.rows[0], row] }), version: { increment: 1 } }, where: { ...where, version: 3 } });
  });

  it("carries a researcher's change through a run to the database, under the research run and that researcher", async () => {
    const database = client();
    const add = { arguments: { cases: null, change: "add_row", key: "y2", label: "Dreamline Y2", reason: "A shop sells it.", url: null, why: null }, id: "call-add", name: CHANGE_RESEARCH_FRAME_TOOL_NAME };
    const { adapter } = scripted([{ calls: begin }, { calls: [researcher("a")] }, { calls: [add] }, DONE, { calls: [submit("one")] }]);
    // The real port alone: the real plan window would wait out its minute here, and this test is about the port's way to the database.
    await run(adapter, engineOf({ gates: [], ports: { coverage: factories(database).coverage! } }));
    expect(database.researchFrame.updateMany).toHaveBeenCalledExactlyOnceWith({ data: { frame: expect.objectContaining({ changes: [expect.objectContaining({ by: { name: "a", threadId: "thread-1" }, key: "y2" })] }),
      version: { increment: 1 } }, where: { ...where, version: 3 } });
  });

  it("reads a plan's frame as the window wrote it", async () => {
    const proposal = { assumptions: [], branches: [], criteria: FRAME.criteria, questions: [], rows: FRAME.rows, skipped: [], steps: [], understood: "A mattress." };
    const { coverage } = researchPorts(factories(client(researchFrameFromPlan(proposal))), scope);
    await expect(coverage.frame(new AbortController().signal)).resolves.toEqual({ branches: [], changes: [], criteria: FRAME.criteria, rows: FRAME.rows });
  });
});
