import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TIME_MS, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME } from "../../contracts/research";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import { interruptNativeRun } from "../engine/runInterruption";
import type { NativeRunStore } from "../engine/runStore";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { TURN_HANDOFF_RESERVE_MS } from "../runs/turnDeadline";
import { ARTIFACT_TOOL_NAME } from "../tools/artifact";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { UPDATE_PLAN_TOOL_NAME } from "../tools/updatePlan";
import { createResearchClock } from "./clock";
import type { ResearchGate } from "./gates";
import { researchAnswerText, researchNote } from "./notes";
import { RESEARCH_PAGE_GUIDE } from "./pageGuide";
import { proposeCall } from "./planWindow.testFixtures";
import type { ResearchPagePort, ResearchPortFactories, ResearchRunScope } from "./ports";
import type { ResearchEngineDeps } from "./run";

// The step's bound, short enough for a test to reach it on real timers; every other number stays the product's.
vi.mock("../../contracts/research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contracts/research")>();
  return { ...actual, RESEARCH_TIME_MS: Object.freeze({ ...actual.RESEARCH_TIME_MS, page: 2_000 }) };
});

/**
 * A finished research's page over the real engine, with a scripted model, a fake artifact service and the page's check as a port: the page goes
 * through `create_artifact` and joins the answer as its card, and every way the step fails leaves the answer as it would have gone out.
 */
type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; hang?: boolean; onCall?: () => void; text?: string }>;

/** The main agent's rounds and the page step's, told apart by the step offering `create_artifact` alone. */
function scripted(main: readonly Step[], page: readonly Step[] = [{ calls: [pageCall()] }]) {
  const requests = { main: [] as ProviderRunRequest[], page: [] as ProviderRunRequest[] };
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const isPage = request.tools?.length === 1 && request.tools[0]!.name === ARTIFACT_TOOL_NAME;
      const lane = isPage ? requests.page : requests.main;
      const script = isPage ? page : main;
      lane.push(request);
      const step = script[Math.min(lane.length - 1, script.length - 1)]!;
      step.onCall?.();
      options.signal?.throwIfAborted();
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      if (step.hang) {
        await new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason as Error), { once: true }));
      }
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])], usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

const PLAN = { goal: "Choose a mattress.", questions: [
  { question: "Which mattress holds up?", sites: [], source_classes: ["primary_official", "independent_tests"] },
  { question: "What do owners and shops say?", sites: ["shop.example"], source_classes: ["owner_reviews", "action_channel"] }
], skipped_source_classes: [] };
const PURCHASE = { report: "# Отчёт\n\n| Модель | Цена | Магазин |\n| X1 | 300 ₽ | https://shop.example/x1 |\n| X2 | 250 ₽ | https://shop.example/x2 |",
  summary: "Возьмите X1 за 300 ₽; дешевле — X2 за 250 ₽." };
const KNOWLEDGE = { report: "# How the rule changed\n\n- 2024: the first rule (https://gov.example/2024).\n- 2026: the rule now in force (https://gov.example/2026).",
  summary: "The rule in force since 2026 replaced the 2024 one." };
const draftOf = (report: typeof PURCHASE) => ({ record_ids: [], report: report.report, summary: { row_keys: [], text: report.summary }, unreachable: [] });
const begin = () => [{ arguments: { goal: PLAN.goal }, id: "call-start", name: START_RESEARCH_TOOL_NAME }, proposeCall(PLAN)];
const submit = (draft = draftOf(PURCHASE), id = "call-draft") => ({ arguments: draft as unknown as Record<string, unknown>, id, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });
/** What the user reads of a draft with no records: its summary, its report, and the plain word that nothing was checked against a source. */
const answerOf = (report: typeof PURCHASE) => researchAnswerText(`${report.summary}\n\n${report.report}`, [researchNote("no_findings")]);

function pageCall(id = "call-page", intent = "create"): ModelToolCall {
  return { arguments: { entrypoint: "index.html", files: [{ mimeType: "text/html", path: "index.html", text: "<!doctype html><title>X1</title>" }], intent, kind: "html",
    title: "Матрасы" }, id, name: ARTIFACT_TOOL_NAME };
}

/** The artifact service's receipt, card included, as `artifactToolResult` makes it; `fail` gives the error a refused bundle gets. */
function artifacts(options: Readonly<{ fail?: boolean }> = {}) {
  let versions = 0;
  const execute = vi.fn(async (call: ModelToolCall): Promise<ToolExecutionResult> => {
    if (options.fail) return { callId: call.id, content: [{ type: "json", value: { error: "artifact_markup_invalid", hint: "Fix the markup." } }], name: call.name, status: "error" };
    versions += 1;
    const payload = { artifact_id: "artifact-1", byte_size: 32, entrypoint: "index.html", kind: "html", title: "Матрасы", version_id: `version-${versions}`, version_number: versions };
    return { artifacts: [{ data: { artifactType: "generated_artifact", payload }, type: "artifact" }], callId: call.id, content: [{ type: "json", value: payload }],
      name: call.name, status: "complete" };
  });
  return { execute };
}

function engineOf(research: ResearchEngineDeps, options: Readonly<{ gated?: string; now?: () => number }> = {}) {
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
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => input.toolName === options.gated
      ? { approvalId: "approval-1", kind: "gated", row: row(input, "error") } : { kind: "running", row: row(input, "running") }),
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
  // No researcher runs here: the store only has to answer what a run reads of its branch.
  const threads = {
    admitForeground: vi.fn(), ensureThread: vi.fn(), find: vi.fn(async () => null), result: vi.fn(async () => null), activeChildren: vi.fn(async () => 0),
    childResults: vi.fn(async () => []), endOrphanedTurns: vi.fn(async () => 0), setActiveState: vi.fn(async () => true), threadEffectItems: vi.fn(async () => []),
    backgroundRunIds: vi.fn(async () => []), threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]), settle: vi.fn(async () => true)
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    ...(options.now ? { now: options.now } : {}),
    research: { gates: [], ...research }, runs, savedResults: { read: vi.fn(async () => null) }, subagentThreads: threads, toolCalls, transcripts
  };
  return { appended, deps, published: () => published, runs, toolCalls };
}

function repository() {
  return {
    appendAssistantText: vi.fn(async (_id: string, _text: string) => undefined), appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async (_runId: string, _message: string, _payload: unknown) => true), getChatUpdateForRun: vi.fn(async () => null),
    getRunControlForUser: vi.fn(async () => ({ status: "streaming" })), loadModelPricing: vi.fn(async () => null),
    loadProviderModelCostBasis: vi.fn(async () => null), loadRunMcpApprovalCards: vi.fn(async () => []),
    markRunAnswerStarted: vi.fn(async () => undefined)
  };
}

function prepared(options: Readonly<{ artifactTool?: boolean }> = {}): MaterializedPreparedRunData {
  const text = "Проведи исследование матрасов.";
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    searchPlan: { mode: "all_selected" as const, options: [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
      modelId: "fake-qsa", optionId: "hosted", protocol: "hosted", provider: "fake", providerModelId: "model-1", revisionId: "rev", searchStrategyRowId: "strategy" }] },
    toolBudgets: { maxMcpToolsPerDiscovery: 10, maxToolCalls: null, maxToolRounds: null },
    toolMode: "auto" as const,
    ...options.artifactTool === false ? {} : { artifactTool: true as const }
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
        providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

let runs = 0;

async function go(adapter: ProviderAdapter, memory: ReturnType<typeof engineOf>, extra: Partial<NativeRunExecutionInput> & Readonly<{ artifactTool?: boolean;
  service?: ReturnType<typeof artifacts> }> = {}) {
  runs += 1;
  const runId = `run-page-${runs}`;
  const repo = repository();
  const { artifactTool, service = artifacts(), ...rest } = extra;
  const response = createNativeRunExecutionResponse({ adapter, created: { assistantMessageId: `answer-${runs}`, runId, userMessageId: `question-${runs}` }, engine: memory.deps,
    prepared: prepared({ ...artifactTool === undefined ? {} : { artifactTool } }), repository: repo as unknown as RunRepository, services: { artifacts: service }, userId: "user",
    ...rest });
  const text = await response.text();
  const seen = text.split("\n\n").flatMap((block): ModelRunSseEvent[] => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
  const cards = repo.appendRunOutputEvent.mock.calls.flatMap(([, event]) => {
    const kept = event as { data?: { artifactType?: string; payload?: unknown } };
    return kept.data?.artifactType === "generated_artifact" ? [kept.data.payload as { versionId: string }] : [];
  });
  return { cards, repo, runId, seen, service };
}

/** Offsets the engine's clock, so a gate can end research late in its time. */
function clock() {
  let offset = 0;
  return { now: () => Date.now() + offset, set: (ms: number) => { offset = ms; } };
}

const lateGate = (move: () => void): ResearchGate => ({ name: "late", run: async () => { move(); return { kind: "pass" }; } });

afterEach(() => vi.restoreAllMocks());

describe("a finished research writes its page", () => {
  it.each([["a purchase", PURCHASE], ["a knowledge question", KNOWLEDGE]])("from %s's final report, and the answer keeps its full text with the page's card", async (_kind, report) => {
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit(draftOf(report))] }], [{ calls: [pageCall()], text: "PAGE NARRATION beside the call." }]);
    const memory = engineOf({});
    const { cards, seen, service } = await go(adapter, memory);
    expect(memory.published()).toBe(answerOf(report));
    // One step offering create_artifact alone, whose conversation is the guide and the report without the notes, and nothing of the research.
    expect(requests.page).toHaveLength(1);
    const [step] = requests.page;
    expect(step!.tools?.map((tool) => tool.name)).toEqual([ARTIFACT_TOOL_NAME]);
    expect(step!.history).toHaveLength(1);
    const asked = JSON.stringify(step!.history);
    expect(asked).toContain(JSON.stringify(RESEARCH_PAGE_GUIDE.slice(0, 200)).slice(1, -1));
    expect(asked).toContain(JSON.stringify(`${report.summary}\n\n${report.report}`).slice(1, -1));
    expect(asked).not.toContain(JSON.stringify(researchNote("no_findings")).slice(1, -1));
    expect(asked).not.toContain(START_RESEARCH_TOOL_NAME);
    expect(service.execute).toHaveBeenCalledOnce();
    expect(cards.map((card) => card.versionId)).toEqual(["version-1"]);
    // The card joins the answer before it is complete, and nothing of the step streams into it.
    const cardAt = seen.findIndex((event) => event.type === "artifact" && event.data.artifactType === "generated_artifact");
    expect(cardAt).toBeGreaterThan(-1);
    expect(cardAt).toBeLessThan(seen.findIndex((event) => event.type === "answer_complete"));
    expect(seen.some((event) => event.type === "token" && event.data.delta.includes("PAGE NARRATION"))).toBe(false);
    expect(memory.published()).not.toContain("PAGE NARRATION");
    // Later turns reach the page as one of the chat's artifacts: the step's own conversation stays out of the run's transcript.
    expect(memory.appended.some((item) => item.kind === "tool_call" && item.name === ARTIFACT_TOOL_NAME)).toBe(false);
    expect(memory.appended.at(-1)).toMatchObject({ kind: "assistant_text", text: answerOf(report) });
    expect(memory.runs.complete).toHaveBeenCalledOnce();
  });

  it("checks the page against the report through the seam, sends a mismatch back once, and shows the corrected page", async () => {
    const reports: string[] = [];
    let checks = 0;
    const page: ResearchPortFactories["page"] = () => ({ check: async ({ page: made, report }) => {
      reports.push(`${made.versionId}:${report}`);
      checks += 1;
      return checks === 1 ? { kind: "mismatch", message: "The X1 costs 300 ₽ in the report." } : { kind: "pass" };
    } });
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }], [{ calls: [pageCall()] }, { calls: [pageCall("call-fix", "update")] }]);
    const memory = engineOf({ ports: { page } });
    const { cards } = await go(adapter, memory);
    expect(reports).toEqual([`version-1:${PURCHASE.summary}\n\n${PURCHASE.report}`, `version-2:${PURCHASE.summary}\n\n${PURCHASE.report}`]);
    expect(JSON.stringify(requests.page[1]!.history)).toContain("The X1 costs 300 ₽ in the report.");
    expect(JSON.stringify(requests.page[1]!.history)).toContain("base_version_id \\\"version-1\\\"");
    expect(cards.map((card) => card.versionId)).toEqual(["version-2"]);
    expect(memory.published()).toBe(answerOf(PURCHASE));
  });

  it("keeps a page that fails its check twice out of the answer, which keeps its full text", async () => {
    const mismatch: ResearchPagePort = { check: async () => ({ kind: "mismatch", message: "Wrong price." }) };
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }], [{ calls: [pageCall()] }, { calls: [pageCall("call-fix", "update")] }]);
    const memory = engineOf({ ports: { page: () => mismatch } });
    const { cards } = await go(adapter, memory);
    expect(requests.page).toHaveLength(2);
    expect(cards).toEqual([]);
    expect(memory.published()).toBe(answerOf(PURCHASE));
  });
});

describe("a page that cannot be written leaves the answer as it would have gone out", () => {
  it("in a run with no artifact tool", async () => {
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }]);
    const memory = engineOf({});
    const { cards } = await go(adapter, memory, { artifactTool: false });
    expect(requests.page).toEqual([]);
    expect(cards).toEqual([]);
    expect(memory.published()).toBe(answerOf(PURCHASE));
  });

  it("when its call fails, or its model makes none", async () => {
    for (const [service, page] of [[artifacts({ fail: true }), [{ calls: [pageCall()] }]], [artifacts(), [{ text: "Here is the page." }]]] as const) {
      const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }], page);
      const memory = engineOf({});
      const { cards } = await go(adapter, memory, { service });
      expect(requests.page).toHaveLength(1);
      expect(cards).toEqual([]);
      expect(memory.published()).toBe(answerOf(PURCHASE));
      expect(memory.runs.complete).toHaveBeenCalledOnce();
    }
  });

  it("when its bound is reached, and the run completes", async () => {
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }], [{ hang: true }]);
    const memory = engineOf({});
    const startedAt = Date.now();
    const { cards, repo } = await go(adapter, memory);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(RESEARCH_TIME_MS.page - 50);
    expect(requests.page).toHaveLength(1);
    expect(cards).toEqual([]);
    expect(memory.published()).toBe(answerOf(PURCHASE));
    expect(memory.runs.complete).toHaveBeenCalledOnce();
    expect(repo.failRun).not.toHaveBeenCalled();
  });

  it("when the hard end leaves no room for it, which the step never moves", async () => {
    const time = clock();
    const ends: number[] = [];
    let scope: ResearchRunScope | null = null;
    const ports: ResearchPortFactories = { page: (run) => { scope = run; return { check: async () => { ends.push(run.turnEndsAt()); return { kind: "pass" }; } }; },
      time: createResearchClock };
    const room = RESEARCH_TIME_MS.hardEnd - TURN_HANDOFF_RESERVE_MS - RESEARCH_TIME_MS.page;
    for (const [late, written] of [[room + 1_000, false], [room - 1_000, true]] as const) {
      ends.length = 0;
      time.set(0);
      const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }]);
      const memory = engineOf({ gates: [lateGate(() => {
        ends.push(scope!.turnEndsAt());
        // From the plan's release, which `begin` made at the start.
        time.set(late);
      })], ports }, { now: time.now });
      const { cards } = await go(adapter, memory);
      expect(requests.page).toHaveLength(written ? 1 : 0);
      expect(cards).toHaveLength(written ? 1 : 0);
      expect(memory.published()).toBe(answerOf(PURCHASE));
      // The hard end the plan's release set holds through the step.
      expect(new Set(ends).size).toBe(1);
      expect(ends).toHaveLength(written ? 2 : 1);
    }
  });

  it("on Stop during the step, which keeps the full answer and no card", async () => {
    let runId = "";
    const { adapter } = scripted([{ calls: begin() }, { calls: [submit()] }], [{ hang: true, onCall: () => activeRunControllerRegistry.abort(runId) }]);
    const memory = engineOf({});
    runId = `run-page-${runs + 1}`;
    const { cards, seen } = await go(adapter, memory);
    expect(seen.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(cards).toEqual([]);
    expect(memory.published()).toBeNull();
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), answerOf(PURCHASE));
  });

  it("on Stop during the step after the checks sent the draft back, with no note that the checks did not finish", async () => {
    let runId = "";
    const sendBack: ResearchGate = { name: "picky", run: async () => ({ kind: "send_back", message: "Name the seller." }) };
    // The model goes quiet after the send back, so the draft the checks ended on is the answer.
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit()] }, { text: "" }], [{ hang: true, onCall: () => activeRunControllerRegistry.abort(runId) }]);
    const memory = engineOf({ gates: [sendBack] });
    runId = `run-page-${runs + 1}`;
    await go(adapter, memory);
    expect(requests.page).toHaveLength(1);
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), `${PURCHASE.summary}\n\n${PURCHASE.report}`);
  });
});

describe("a page only at research's real end", () => {
  it("is not written at an approval's pause, whose answer goes out as it did", async () => {
    const plan = { arguments: { plan: [{ status: "in_progress", step: "Buy it" }] }, id: "call-plan-step", name: UPDATE_PLAN_TOOL_NAME };
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit(), plan] }]);
    const memory = engineOf({}, { gated: UPDATE_PLAN_TOOL_NAME });
    const { cards, service } = await go(adapter, memory);
    expect(requests.page).toEqual([]);
    expect(service.execute).not.toHaveBeenCalled();
    expect(cards).toEqual([]);
    expect(memory.published()).toBe(answerOf(PURCHASE));
  });

  it("is not written by a run interrupted during the step, which keeps its answer for Continue", async () => {
    let runId = "";
    const { adapter } = scripted([{ calls: begin() }, { calls: [submit()] }], [{ hang: true, onCall: () => { interruptNativeRun(runId); } }]);
    const memory = engineOf({});
    runId = `run-page-${runs + 1}`;
    const { cards, repo } = await go(adapter, memory);
    expect(cards).toEqual([]);
    expect(memory.published()).toBeNull();
    expect(repo.failRun).toHaveBeenCalledWith(runId, expect.anything(), expect.objectContaining({ code: RUN_INTERRUPTED_FAILURE.code }), expect.anything());
    expect(repo.appendAssistantText.mock.calls.map(([, text]) => text).join("")).toContain(answerOf(PURCHASE));
  });

  it("is not written for an answer the server built from the records", async () => {
    const built = scripted([{ calls: begin() }, { text: "" }]);
    const composed: ResearchPortFactories = { report: () => ({ compose: async () => "Built from the records.", gates: [] }) };
    const memory = engineOf({ ports: composed });
    await go(built.adapter, memory);
    expect(memory.published()).toBe("Built from the records.");
    expect(built.requests.page).toEqual([]);
  });
});
