import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_EVIDENCE_TOOL_NAME,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchEvidenceRecord
} from "../../contracts/research";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { defaultNativeEngineHandlerDeps } from "../engine/defaultEngine";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { NativeRunStore } from "../engine/runStore";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { StorageAdapter } from "../uploads/storage";
import { WebFetchError } from "../webFetch/transport";
import { fetchUrlDigest } from "../webFetch/urls";
import type { ResearchGate, ResearchSubagentRequest } from "./gates";
import { NOOP_RESEARCH_PORTS, researchPorts, type ResearchEvidencePort, type ResearchEvidenceWrite, type ResearchPortFactories, type ResearchRunScope } from "./ports";
import { proposeCall } from "./planWindow.testFixtures";
import { checkQuotes, type QuoteCheck } from "./quoteCheck";
import type { ResearchEngineDeps } from "./run";

/**
 * `record_evidence` reaching production: a tool only unit tests see is how `runProxies` was lost in `handlerSupport.ts`. Through the real
 * engine, with scripted models, each agent's call lands in the run's one port under that agent's name, and `defaultNativeEngineDeps`
 * hands the real store to a run, never the no-op.
 */
type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>;

const RECORD_ID = "0b6f4a2e-7d1c-4c3b-9a55-1f2e3d4c5b6a";

// Every database port here is a fake, including defaults the production factories import.
vi.mock("../prisma", () => ({ prisma: {} }));

function scripted(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      options.signal?.throwIfAborted();
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])], usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

const PLAN = { goal: "Choose a mattress.", questions: [
  { question: "Which mattress holds up?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }
], skipped_source_classes: [] };
const start = { arguments: { goal: PLAN.goal }, id: "call-start", name: START_RESEARCH_TOOL_NAME };
/** Research under a plan that stands: the plan window port is a no-op here, so it closes at once. */
const begin = [start, proposeCall({ questions: PLAN.questions })];
const submit = { arguments: { findings: [], report: "# Report\n\nIt holds up.", unreachable: [] }, id: "call-draft", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME };
const researcher = { arguments: { message: "Cover the question.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME };
const RECORD = { claim: null, criterion_key: "firmness", dataset: null, kind: "not_found", quote: null, reason: "Nowhere.", row_key: "x1", source_class: null, standing: null, supersedes: null, target: null, url: null };
const record = (id: string) => ({ arguments: RECORD, id, name: RECORD_EVIDENCE_TOOL_NAME });

function engineOf(research: ResearchEngineDeps) {
  const rows = new Map<string, ToolCallRow>();
  const row = (input: { arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number; toolName: string }, state: ToolCallRow["state"]): ToolCallRow => {
    const made: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal, providerCallId: input.providerCallId,
      result: null, roundIndex: input.roundIndex, startedAt: "now", state, toolName: input.toolName };
    rows.set(made.id, made);
    return made;
  };
  const transcripts = {
    append: vi.fn(async () => undefined),
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
    applyUsageTotals: vi.fn(async () => undefined), complete: vi.fn(async () => true), publishAnswer: vi.fn(async () => true), recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true), workDurationMs: vi.fn(async () => null as number | null), writeUsageRows: vi.fn(async () => undefined)
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
    ensureThread: vi.fn(), find: vi.fn(async () => null), result: vi.fn(async () => null), activeChildren: vi.fn(async () => 0), childResults: vi.fn(async () => []),
    endOrphanedTurns: vi.fn(async () => 0), setActiveState: vi.fn(async () => true), threadEffectItems: vi.fn(async () => []), backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]), settle: vi.fn(async () => true)
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []), now: () => 1_000_000,
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    research, runs, savedResults: { read: vi.fn(async () => null) }, subagentThreads: threads, toolCalls, transcripts
  };
  return deps;
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

/** The user's Continue right after a turn that started research, which the store says was interrupted: the run offers research before any start. */
function continueOf(deps: NativeEngineDeps): MaterializedPreparedRunData {
  vi.mocked(deps.transcripts.nativeRunsForAnswers).mockResolvedValue(new Map([["answer-0", "run-0"]]));
  vi.mocked(deps.transcripts.loadRuns).mockResolvedValue(new Map([["run-0", [{ arguments: JSON.stringify({ goal: "Choose a mattress." }), callId: "old-start",
    id: "old-call", kind: "tool_call", name: START_RESEARCH_TOOL_NAME }] as TranscriptItem[]]]));
  const content = (text: string) => ({ blocks: [{ text, type: "text" as const }] });
  const { deepResearch: _chosen, ...base } = prepared().normalizedRequest;
  void _chosen;
  const request = { ...base, context: { messages: [{ content: content("Mattresses."), id: "question", role: "user" as const },
    { content: content(""), id: "answer-0", role: "assistant" as const }, { content: content(CONTINUE_TURN_TEXT), id: "current-user-message", role: "user" as const }],
  mode: "branch_path" as const } } as ProviderRunRequest;
  return { ...prepared(), normalizedRequest: request, providerRequest: request };
}

/** The store's word on run-0: interrupted, and sent with Deep research. */
const interrupted: ResearchPortFactories["resume"] = () => ({ ...NOOP_RESEARCH_PORTS.resume, interrupted: async () => true,
  sentWithDeepResearch: async (runIds) => runIds.includes("run-0") });

function run(adapter: ProviderAdapter, deps: NativeEngineDeps, extra: Partial<NativeRunExecutionInput> = {}) {
  return createNativeRunExecutionResponse({ adapter, created: { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" }, engine: deps, prepared: prepared(),
    repository: repository() as unknown as RunRepository, services: {}, userId: "user", ...extra });
}

/** The evidence port of a run, with how many a run made of it. */
function evidencePort() {
  const record = vi.fn(async (_write: ResearchEvidenceWrite) => ({ kind: "recorded" as const,
    record: { id: RECORD_ID, quoteCheck: { reason: null, status: "found" as const } } as ResearchEvidenceRecord }));
  const port: ResearchEvidencePort = { page: async () => null, record, records: async () => [] };
  const factory = vi.fn(() => port);
  return { factory, port, record };
}

const toolsOf = (request: ProviderRunRequest | undefined) => request?.tools?.map((tool) => tool.name) ?? [];

function resultsOf(request: ProviderRunRequest | undefined, name: string): string[] {
  return (request?.history ?? []).flatMap((item) => item.type === "tool_result" && item.name === name ? [item.output] : []);
}

afterEach(() => vi.restoreAllMocks());

describe("record_evidence through the real engine", () => {
  // One host, www. or not: a site closes by its host (operator decision 2026-11-05).
  const siteUrls = ["https://www.shop.example/one", "https://shop.example/two", "https://shop.example/three"];
  const fetch = (index: number) => ({ arguments: { url: siteUrls[index] }, id: `fetch-${index}`, name: "fetch_url" });
  const withFetch = () => {
    const base = prepared();
    const fetchUrl = { userUrlDigests: siteUrls.map(fetchUrlDigest), version: 1 as const };
    return { ...base, normalizedRequest: { ...base.normalizedRequest, fetchUrl }, providerRequest: { ...base.providerRequest, fetchUrl } };
  };

  it.each(["lab", "second"])("passes newly unreachable sites to the next brief (%s) and refuses their fetches", async (name) => {
    const records: ResearchEvidenceRecord[] = [];
    const evidence: ResearchEvidencePort = { page: async () => null, records: async () => [...records], record: async (write) => {
      const saved: ResearchEvidenceRecord = { ...write.record, author: write.author, createdAt: "2026-11-02T00:00:00.000Z", id: RECORD_ID,
        pageId: null, publishedOn: null, quoteCheck: null, registrableDomain: null, runId: "run-1", sequence: 1, textGroupKey: null };
      records.push(saved);
      return { kind: "recorded", record: saved };
    } };
    const blocked = { arguments: { ...RECORD, kind: "unreachable", reason: "The shop requires sign-in.", target: siteUrls[0] }, id: "blocked", name: RECORD_EVIDENCE_TOOL_NAME };
    const next = { ...researcher, arguments: { message: "Check more sources.", name }, id: "next" };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher] }, { calls: [blocked] }, { text: "Outcome: done\n\nRecorded." },
      { calls: [next] }, { calls: [fetch(1)] }, { text: "Outcome: done\n\nFinished." }, { calls: [submit] }]);
    const fetchPage = vi.fn();
    await run(adapter, engineOf({ gates: [], ports: { evidence: () => evidence } }), { prepared: withFetch(), services: { fetchPage } }).text();
    expect(JSON.stringify(requests[2]!.history)).not.toContain("# Unreachable sites");
    expect(JSON.stringify(requests[5]!.history)).toContain("# Unreachable sites");
    expect(JSON.stringify(requests[5]!.history)).toContain("shop.example");
    expect(JSON.stringify(requests[5]!.history)).toContain("The shop requires sign-in.");
    expect(resultsOf(requests[6], "fetch_url")[0]).toContain("already recorded as unreachable");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reads a page when the records cannot be read for it: a store's hiccup fails no fetch", async () => {
    let reads = 0;
    const evidence: ResearchEvidencePort = { page: async () => null, record: async () => { throw new Error("Not written here."); }, records: async () => {
      reads += 1;
      // The brief reads first; the page read's own read fails.
      if (reads === 2) throw new Error("Store unavailable.");
      return [];
    } };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher] }, { calls: [fetch(0)] }, { text: "Outcome: done\n\nRead." }, { calls: [submit] }]);
    const fetchPage = vi.fn(async () => { throw new WebFetchError("fetch_timeout", { dispatched: true }); });
    await run(adapter, engineOf({ gates: [], ports: { evidence: () => evidence } }), { prepared: withFetch(), services: { fetchPage } }).text();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(resultsOf(requests[3], "fetch_url")[0]).not.toContain("already recorded as unreachable");
  });

  it("shares the run's two connection timeouts with later researchers", async () => {
    const next = { ...researcher, arguments: { message: "Check more sources.", name: "second" }, id: "next" };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher] }, { calls: [fetch(0)] }, { calls: [fetch(1)] },
      { text: "Outcome: done\n\nTimed out." }, { calls: [next] }, { calls: [fetch(2)] }, { text: "Outcome: done\n\nFinished." }, { calls: [submit] }]);
    const fetchPage = vi.fn(async () => { throw new WebFetchError("fetch_timeout", { dispatched: true }); });
    await run(adapter, engineOf({ gates: [] }), { prepared: withFetch(), services: { fetchPage } }).text();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(resultsOf(requests[7], "fetch_url")[0]).toContain("timed out twice");
  });

  it("lands a researcher's call in the run's port, with that researcher as its author", async () => {
    const evidence = evidencePort();
    const { adapter, requests } = scripted([
      { calls: begin }, { calls: [researcher] },
      { calls: [record("call-record")] }, { text: "Outcome: done\n\nNothing found." },
      { calls: [submit] }
    ]);
    await run(adapter, engineOf({ gates: [], ports: { evidence: evidence.factory } })).text();
    expect(toolsOf(requests[2])).toContain(RECORD_EVIDENCE_TOOL_NAME);
    expect(JSON.stringify(requests[2]!.history)).toContain("Record each finding with record_evidence");
    expect(evidence.record).toHaveBeenCalledTimes(1);
    expect(evidence.record.mock.calls[0]![0]).toEqual({ author: { name: "lab", threadId: "thread-1" }, record: { criterionKey: "firmness", kind: "not_found", reason: "Nowhere.", rowKey: "x1",
      sourceClass: null, supersedes: null } });
    expect(evidence.factory).toHaveBeenCalledTimes(1);
    expect(JSON.parse(resultsOf(requests[3], RECORD_EVIDENCE_TOOL_NAME)[0]!)).toMatchObject({ record_id: RECORD_ID });
  });

  it("lands the main agent's call in the same port, as the main agent's", async () => {
    const evidence = evidencePort();
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [record("call-main"), researcher] }, { calls: [record("call-lab-record")] }, { text: "Outcome: done\n\nDone." }, { calls: [submit] }]);
    await run(adapter, engineOf({ gates: [], ports: { evidence: evidence.factory } })).text();
    expect(toolsOf(requests[0])).toContain(RECORD_EVIDENCE_TOOL_NAME);
    expect(evidence.record.mock.calls.map(([write]) => write.author).sort((one, other) => String(one.name).localeCompare(String(other.name))))
      .toEqual([{ name: "lab", threadId: "thread-1" }, { name: null, threadId: null }]);
    expect(evidence.factory).toHaveBeenCalledTimes(1);
  });

  it("refuses a call before research started, for every agent, with nothing written", async () => {
    const evidence = evidencePort();
    const { adapter, requests } = scripted([{ calls: [record("call-early")] }, { text: "A direct answer." }]);
    await run(adapter, engineOf({ gates: [], ports: { evidence: evidence.factory } })).text();
    // The user chose Deep research: nothing but the start runs before it.
    expect(resultsOf(requests[1], RECORD_EVIDENCE_TOOL_NAME)[0]).toContain(`${START_RESEARCH_TOOL_NAME} comes first`);
    expect(evidence.record).not.toHaveBeenCalled();
    const early = evidencePort();
    const sub = scripted([{ calls: [researcher] }, { calls: [record("call-early")] }, { text: "Outcome: done\n\nDone." }, { text: "A direct answer." }]);
    const deps = engineOf({ gates: [], ports: { evidence: early.factory, resume: interrupted } });
    await run(sub.adapter, deps, { prepared: continueOf(deps) }).text();
    expect(resultsOf(sub.requests[2], RECORD_EVIDENCE_TOOL_NAME)[0]).toContain("research_not_started");
    expect(early.record).not.toHaveBeenCalled();
  });

  it("never reaches a gate's turn, the verifier's tools or the gap judge's", async () => {
    const evidence = evidencePort();
    const turn = (name: string, tools: ResearchSubagentRequest["tools"]): ResearchSubagentRequest => ({ brief: "Check it.", instructions: "Check.", model: "main", name, tools });
    const gate = { name: "turns", run: async (_draft: unknown, context: { signal: AbortSignal; subagents: { run(request: ResearchSubagentRequest, signal: AbortSignal): Promise<unknown> } }) => {
      await context.subagents.run(turn("gap-judge", []), context.signal);
      await context.subagents.run(turn("verifier", [SUBAGENT_TOOL_GROUPS.web_fetch]), context.signal);
      return { kind: "pass" as const };
    } };
    const { adapter, requests } = scripted([{ calls: begin }, { calls: [submit] }, { text: "Outcome: done\n\nNo gaps." }, { text: "Outcome: done\n\nHolds." }]);
    await run(adapter, engineOf({ gates: [gate as never], ports: { evidence: evidence.factory } })).text();
    expect(requests).toHaveLength(4);
    expect(toolsOf(requests[1])).toContain(RECORD_EVIDENCE_TOOL_NAME);
    expect(toolsOf(requests[2])).not.toContain(RECORD_EVIDENCE_TOOL_NAME);
    expect(toolsOf(requests[3])).not.toContain(RECORD_EVIDENCE_TOOL_NAME);
  });

  it("is offered only where research runs, to no agent elsewhere", async () => {
    const offered = async (extra: Partial<NativeRunExecutionInput>, research: ResearchEngineDeps = { gates: [] }) => {
      const { adapter, requests } = scripted([{ calls: begin }, { calls: [researcher] }, { text: "Outcome: done\n\nDone." }, { calls: [submit] }]);
      await run(adapter, engineOf(research), extra).text();
      return [toolsOf(requests[0]).includes(RECORD_EVIDENCE_TOOL_NAME), toolsOf(requests[2]).includes(RECORD_EVIDENCE_TOOL_NAME)];
    };
    await expect(offered({})).resolves.toEqual([true, true]);
    // Telegram and a scheduled occurrence never research: the message is refused before any request.
    await expect(offered({ telegram: true })).resolves.toEqual([false, false]);
    await expect(offered({ scheduled: true })).resolves.toEqual([false, false]);
    // A message sent without Deep research is an ordinary turn, and its sub-agent records nothing.
    const { deepResearch: _chosen, ...ordinary } = prepared().normalizedRequest;
    void _chosen;
    const plain = scripted([{ calls: [researcher] }, { text: "Outcome: done\n\nDone." }, { text: "Answer." }]);
    await run(plain.adapter, engineOf({ gates: [] }), { prepared: { ...prepared(), normalizedRequest: ordinary as ProviderRunRequest, providerRequest: ordinary as ProviderRunRequest } }).text();
    expect([toolsOf(plain.requests[0]), toolsOf(plain.requests[1])].map((tools) => tools.includes(RECORD_EVIDENCE_TOOL_NAME))).toEqual([false, false]);
    const none = scripted([{ calls: [researcher] }, { text: "Outcome: done\n\nDone." }, { text: "Answer." }]);
    const { research: _research, ...deps } = engineOf({});
    void _research;
    await run(none.adapter, deps, { prepared: { ...prepared(), normalizedRequest: ordinary as ProviderRunRequest, providerRequest: ordinary as ProviderRunRequest } }).text();
    expect(toolsOf(none.requests[1])).not.toContain(RECORD_EVIDENCE_TOOL_NAME);
  });
});

describe("what the final checks read", () => {
  const LINK = "https://lab.example/x1";
  const EARLIER_LINK = "https://shop.example/x1";
  const QUOTE = "held up after 10 years";
  const EARLIER_QUOTE = "an earlier answer's words";

  const fetchedItems = (id: string, url: string, text: string): TranscriptItem[] => [
    { arguments: JSON.stringify({ url }), callId: id, id: `${id}-call`, kind: "tool_call", name: "fetch_url" },
    { callId: id, id: `${id}-result`, kind: "tool_result", name: "fetch_url", outcome: "complete", output: JSON.stringify({ text, url }) }
  ];
  /** The stopped turn as its run left it: research started, and a call waiting for the user. */
  const stoppedTurn = (researchRun: string): TranscriptItem[] => [
    { arguments: JSON.stringify(PLAN), callId: "call-start", id: "stored-call", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
    { callId: "call-start", id: "stored-result", kind: "tool_result", name: START_RESEARCH_TOOL_NAME, outcome: "complete",
      output: JSON.stringify({ research_run: researchRun, method: "How to run it.", status: "started" }) },
    { arguments: "{}", callId: "call-held", id: "held-call", kind: "tool_call", name: "mcp_shop_buy" },
    { callId: "call-held", id: "held-result", kind: "tool_result", name: "mcp_shop_buy", outcome: "error", output: "Waiting for approval." }
  ];
  const finding = (quote: string, url: string) => ({ claim: "The X1 holds up.", quote, source_class: "independent_tests", standing: "confirmed", url });
  const draft = { arguments: { findings: [finding(QUOTE, LINK), finding(EARLIER_QUOTE, EARLIER_LINK)], report: "# Report\n\nIt holds up.", unreachable: [] }, id: "call-draft",
    name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME };

  /** A gate reading the sources as the verifier's quote check and the gap check do. */
  function quoteGate() {
    const seen: (readonly QuoteCheck[])[] = [];
    const gate: ResearchGate = { name: "quotes", run: async (submitted, context) => {
      seen.push(checkQuotes(submitted.findings, await context.sources.opened(context.signal)));
      return { kind: "pass" };
    } };
    return { gate, seen };
  }

  /** The branch's stored runs: an earlier answer's `run-0`, whose thread read its own page, and what `threads` holds of `run-1`. */
  function branchOf(deps: NativeEngineDeps, stored: readonly (readonly TranscriptItem[])[], threads: Readonly<Record<string, readonly TranscriptItem[]>>) {
    vi.mocked(deps.transcripts.nativeRunsForAnswers).mockResolvedValue(new Map(stored.map((_items, index) => [`answer-${index}`, `run-${index}`])));
    vi.mocked(deps.transcripts.loadRuns).mockResolvedValue(new Map(stored.map((items, index) => [`run-${index}`, [...items]])));
    vi.mocked(deps.subagentThreads!.threadEffectItems).mockImplementation(async ({ runIds }) =>
      runIds.flatMap((id) => threads[id] ? [{ items: [...threads[id]], threadId: `thread-of-${id}` }] : []));
    const content = (text: string) => ({ blocks: [{ text, type: "text" as const }] });
    const messages = [...stored.flatMap((_items, index) => [{ content: content("Проведи исследование."), id: `question-${index}`, role: "user" as const },
      { content: content(""), id: `answer-${index}`, role: "assistant" as const }]), { content: content("Go on."), id: "current-user-message", role: "user" as const }];
    const base = prepared();
    const request = { ...base.normalizedRequest, context: { messages, mode: "branch_path" as const } } as ProviderRunRequest;
    return { prepared: { ...base, normalizedRequest: request, providerRequest: request } };
  }

  it("reaches what a researcher read in the run before the approval, and no earlier answer's page", async () => {
    const { gate, seen } = quoteGate();
    // Run-1 was sent with Deep research, which is what lets its approval go on with the research.
    const deps = engineOf({ gates: [gate], ports: { resume: () => ({ ...NOOP_RESEARCH_PORTS.resume, sentWithDeepResearch: async (runIds) => runIds.includes("run-1") }) } });
    const threads = { "run-0": fetchedItems("call-earlier", EARLIER_LINK, `Shop: ${EARLIER_QUOTE}.`), "run-1": fetchedItems("call-page", LINK, `The X1 ${QUOTE} of use.`) };
    const branch = branchOf(deps, [[], stoppedTurn("run-1")], threads);
    vi.mocked(deps.approvedCall).mockResolvedValue({ providerCallId: "call-held", toolName: "mcp_shop_buy" });
    vi.mocked(deps.subagentThreads!.backgroundRunIds).mockImplementation(async ({ parentRunIds }) => parentRunIds.includes("run-1") ? ["background-1"] : []);
    await run(scripted([{ calls: [draft] }]).adapter, deps, { ...branch, approvalContinuation: { approvalId: "approval-1" },
      created: { assistantMessageId: "answer-c", runId: "run-c", userMessageId: "current-user-message" } }).text();
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toMatchObject({ excerpt: { source: { kind: "cited" } }, status: "found" });
    expect(seen[0]![1]).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(vi.mocked(deps.subagentThreads!.backgroundRunIds).mock.calls.at(-1)![0]).toMatchObject({ parentRunIds: ["run-1", "run-c"] });
    expect(vi.mocked(deps.subagentThreads!.threadEffectItems).mock.calls.at(-1)![0]).toEqual({ chatId: "chat", runIds: ["run-1", "run-c", "background-1"], userId: "user" });
  });

  it("reads an ordinary research run's own pages alone, as it always did", async () => {
    const { gate, seen } = quoteGate();
    const deps = engineOf({ gates: [gate] });
    const branch = branchOf(deps, [[]], { "run-0": fetchedItems("call-earlier", EARLIER_LINK, `Shop: ${EARLIER_QUOTE}.`), "run-1": fetchedItems("call-page", LINK, `The X1 ${QUOTE} of use.`) });
    await run(scripted([{ calls: begin }, { calls: [draft] }]).adapter, deps, { ...branch, created: { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "current-user-message" } }).text();
    expect(seen[0]![0]).toMatchObject({ status: "found" });
    expect(seen[0]![1]).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(vi.mocked(deps.subagentThreads!.backgroundRunIds).mock.calls.at(-1)![0]).toMatchObject({ parentRunIds: ["run-1"] });
    expect(vi.mocked(deps.subagentThreads!.threadEffectItems).mock.calls.at(-1)![0]).toEqual({ chatId: "chat", runIds: ["run-1"], userId: "user" });
  });
});

describe("the default engine", () => {
  const scope = (extra: Partial<ResearchRunScope> = {}) => ({ branchRunIds: [], chatId: "chat", researchRunId: "run-1", runId: "run-1", userId: "user", ...extra }) as unknown as ResearchRunScope;
  const row = { authorName: "lab", authorThreadId: "thread-1", chatId: "chat", claim: null, createdAt: new Date(0), criterionKey: "firmness", dataset: null, id: RECORD_ID, kind: "not_found", modelRunId: "run-1",
    pageId: null, publishedOn: null, quote: null, quoteCheck: null, quoteCheckReason: null, reason: "Nowhere.", registrableDomain: null, rowKey: "x1", sequence: 0, sourceClass: null, standing: null,
    supersedesId: null, target: null, textGroupKey: null, url: null, userId: "user" };

  function client() {
    const tx = { $queryRaw: vi.fn(async () => [{ lock: "" }]), researchEvidence: { aggregate: vi.fn(async () => ({ _count: { _all: 0 }, _max: { sequence: null } })), create: vi.fn(async () => row) } };
    return { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)), researchEvidence: { findMany: vi.fn(async () => [row]) },
      researchFrame: { findFirst: vi.fn(async () => null) }, tx };
  }

  /** As every send entry point gets them, so nothing between the default engine and a run can lose the port. */
  const factories = (database: ReturnType<typeof client>): ResearchPortFactories =>
    defaultNativeEngineHandlerDeps({} as StorageAdapter, database as unknown as PrismaClient).engine.research!.ports!;

  it("gives a run the real store, not the no-op", async () => {
    const database = client();
    const { evidence } = researchPorts(factories(database), scope());
    expect(evidence).not.toBe(NOOP_RESEARCH_PORTS.evidence);
    await expect(evidence.records(new AbortController().signal)).resolves.toEqual([expect.objectContaining({ id: RECORD_ID, kind: "not_found", runId: "run-1" })]);
    expect(database.researchEvidence.findMany).toHaveBeenCalledWith({ where: { chatId: "chat", modelRunId: { in: ["run-1"] }, userId: "user" } });
  });

  it("carries a sub-agent's call through a run to the database, under the research run", async () => {
    const database = client();
    const { adapter } = scripted([{ calls: begin }, { calls: [researcher] }, { calls: [record("call-record")] }, { text: "Outcome: done\n\nDone." }, { calls: [submit] }]);
    // The real store alone: the real plan window would wait out its minute here, and this test is about the store's way to the database.
    await run(adapter, engineOf({ gates: [], ports: { evidence: factories(database).evidence! } })).text();
    expect(database.tx.researchEvidence.create).toHaveBeenCalledWith({ data: expect.objectContaining({ authorName: "lab", authorThreadId: "thread-1", chatId: "chat", kind: "not_found", modelRunId: "run-1",
      sequence: 0, userId: "user" }) });
  });
});
