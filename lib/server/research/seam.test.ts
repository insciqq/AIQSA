import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, PROPOSE_RESEARCH_PLAN_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME, RESEARCH_TIME_MS, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchDraft } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_ERROR_CODES, SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import type { ThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { mergeWorkspaceActivity } from "../../domain/workspaceActivity";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { SubagentModelRoute } from "../engine/subagents/modelRoutes";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import { toolOutputExcerpt } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { NativeRunStore } from "../engine/runStore";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { workspaceActivityFingerprint } from "../runs/workspaceActivityPersistence";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { runResearchGates, type ResearchGate, type ResearchGateContext } from "./gates";
import { researchAnswerText, researchNote } from "./notes";
import { createResearchClock } from "./clock";
import { createResearchPlanHandlers } from "./planHandlers";
import { createResearchPlanWindow, RESEARCH_PLAN_WINDOW_LIMITS, ResearchPlanWindows, type ResearchPlanStore } from "./planWindow";
import { proposeCall, proposalArguments } from "./planWindow.testFixtures";
import { researchOfTurn, type ResearchEngineDeps } from "./run";
import { researchModelIdentity } from "./turns";
import { createResearchVerifierRole, RESEARCH_RESEARCHER_BINDING_KEY, type ResearchVerifierRole } from "./verifierRole";
import { ProviderAdmissionError } from "../providerRuntime/admission";

/**
 * The gate seam, end to end over the real engine with scripted models and test gates: what `research-gap-rounds` and
 * `research-independent-verifier` need, proven without touching the engine.
 */
type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: boolean; hang?: boolean; onCall?: () => void; text?: string }>;

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
      if (step.hang) {
        await new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason as Error), { once: true }));
      }
      if (step.fail) throw Object.assign(new Error("rejected"), { code: "provider_response_not_retryable" });
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

const PLAN = { goal: "Choose a mattress.", questions: [
  { question: "Which mattress holds up?", sites: [], source_classes: ["primary_official", "independent_tests"] },
  { question: "What do owners and shops say?", sites: ["shop.example"], source_classes: ["owner_reviews", "action_channel"] }
], skipped_source_classes: [] };
const REPORT = "# Report\n\nConfirmed: the X1 holds up.";
const DRAFT = { findings: [{ claim: "The X1 holds up.", quote: "held up after 10 years", source_class: "independent_tests", standing: "confirmed",
  url: "https://lab.example/x1" }], report: REPORT, unreachable: [] };
const start = (id = "call-start") => ({ arguments: { goal: PLAN.goal }, id, name: START_RESEARCH_TOOL_NAME });
const propose = (id = "call-plan") => proposeCall(PLAN, id);
/** A start and its plan in one response: scoping has no floor, and with no window port the plan stands at once. */
const begin = () => [start(), propose()];
const submit = (id = "call-draft", draft: unknown = DRAFT) => ({ arguments: draft as Record<string, unknown>, id, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });

function engineOf(research: ResearchEngineDeps | undefined, options: Readonly<{ now?: () => number; threadEffects?: Readonly<{ items: TranscriptItem[]; threadId: string }>[] }> = {}) {
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
        turn: { branchRunId: input.parentRunId, definitionRevisionId: input.definitionRevisionId, effortSource: input.binding.effortSource, id: `turn-${turns}`, mode: "foreground" as const,
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
    threadEffectItems: vi.fn(async () => options.threadEffects ?? []),
    backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]),
    settle: vi.fn(async () => true)
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    ...(options.now ? { now: options.now } : {}),
    ...(research ? { research } : {}),
    runs, savedResults: { read: vi.fn(async () => ({ arguments: {}, text: "whole page: held up after 10 years", toolName: "fetch_url" })) },
    subagentThreads: threads, toolCalls, transcripts
  };
  return { appended, deps, published: () => published, runs, threads, toolCalls };
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

function prepared(options: Readonly<{ noLimits?: boolean; noSearch?: boolean }> = {}): MaterializedPreparedRunData {
  const text = "Проведи исследование матрасов.";
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    // A hosted source: Search is available and no client route is built.
    searchPlan: { mode: "all_selected" as const, options: options.noSearch ? [] : [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
      modelId: "fake-qsa", optionId: "hosted", protocol: "hosted", provider: "fake", providerModelId: "model-1", revisionId: "rev", searchStrategyRowId: "strategy" }] },
    toolMode: "auto" as const,
    // What a new installation has; left out, a request reads as an old one, whose tool rounds run out at 3.
    ...options.noLimits ? { toolBudgets: { maxMcpToolsPerDiscovery: 10, maxToolCalls: null, maxToolRounds: null } } : {}
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
        providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };

function run(adapter: ProviderAdapter, memory: ReturnType<typeof engineOf>, extra: Partial<NativeRunExecutionInput> & { runId?: string } = {},
  repo = repository()) {
  const { runId, ...rest } = extra;
  return createNativeRunExecutionResponse({ adapter, created: { ...created, ...(runId ? { runId } : {}) }, engine: memory.deps, prepared: prepared(),
    repository: repo as unknown as RunRepository, services: {}, userId: "user", ...rest });
}

async function events(response: Response): Promise<ModelRunSseEvent[]> {
  const text = await response.text();
  return text.split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}

const tokens = (seen: readonly ModelRunSseEvent[]) => seen.flatMap((event) => event.type === "token" ? [event.data.delta] : []);

function resultsOf(request: ProviderRunRequest | undefined, name: string): string[] {
  return (request?.history ?? []).flatMap((item) => item.type === "tool_result" && item.name === name ? [item.output] : []);
}

const gate = (name: string, body: ResearchGate["run"]): ResearchGate => ({ name, run: body });

afterEach(() => vi.restoreAllMocks());

describe("starting research", () => {
  it("offers its tools only where research can run: Search on, a web chat, and never a scheduled or Telegram turn", async () => {
    const offered = async (extra: Partial<NativeRunExecutionInput>, research: ResearchEngineDeps | undefined = {}) => {
      const { adapter, requests } = scripted([{ text: "Answer." }]);
      await run(adapter, engineOf(research), extra).text();
      return requests[0]!.tools?.map((tool) => tool.name).includes(START_RESEARCH_TOOL_NAME);
    };
    expect(await offered({})).toBe(true);
    expect(await offered({ prepared: prepared({ noSearch: true }) })).toBe(false);
    expect(await offered({ telegram: true })).toBe(false);
    expect(await offered({ scheduled: true })).toBe(false);
    expect(await offered({}, undefined as never)).toBe(true);
  });

  it("refuses a call of the tool where it is not offered, as any unknown tool, and the answer still arrives", async () => {
    const { adapter, requests } = scripted([{ calls: begin() }, { text: "Answered directly." }]);
    const memory = engineOf({});
    await run(adapter, memory, { telegram: true }).text();
    expect(memory.published()).toBe("Answered directly.");
    expect(memory.toolCalls.begin).not.toHaveBeenCalled();
    expect(resultsOf(requests[1], START_RESEARCH_TOOL_NAME).join()).toContain("does not exist");
  });

  it("names the plan as the answer's progress, and refuses a plan that drops a source class without a reason", async () => {
    const { adapter, requests } = scripted([
      { calls: [start(), proposeCall({ questions: [PLAN.questions[0]] }, "call-bad")] },
      { calls: [propose()] },
      { calls: [submit()] }
    ]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(adapter, memory));
    expect(resultsOf(requests[1], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]).toContain("owner_reviews");
    const plans = seen.flatMap((event) => event.type === "artifact" && event.data.artifactType === "workspace_activity" ? [event.data.payload] : []) as unknown as { items?: { text: string }[]; kind: string }[];
    expect(plans.filter((entry) => entry.kind === "plan").at(-1)?.items?.map((item) => item.text)).toEqual(["Which mattress holds up?", "What do owners and shops say?"]);
    expect(memory.published()).toBe(REPORT);
  });

  it("gives every researcher the method and its source classes, whatever the main agent's brief says", async () => {
    const { adapter, requests } = scripted([
      { calls: begin() },
      { calls: [{ arguments: { message: "Cover the first question.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nclaim; link; quote; independent_tests; confirmed" },
      { calls: [submit()] }
    ]);
    const memory = engineOf({ gates: [] });
    await run(adapter, memory).text();
    const brief = JSON.stringify(requests[2]!.history);
    expect(brief).toContain("Cover the first question.");
    expect(brief).toContain("# Research method (from the server)");
    expect(brief).toContain("Which mattress holds up? [primary_official, independent_tests]");
    expect(brief).toContain("verbatim quote");
    expect(brief).toContain("never wait for a person");
    expect(memory.published()).toBe(REPORT);
  });
});

describe("Stop ends all research", () => {
  it("runs a researcher in the foreground even when the model asks for the background, since Stop spares background sub-agents", async () => {
    const { adapter } = scripted([
      { calls: begin() },
      { calls: [{ arguments: { background: true, message: "Cover it.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nreport" },
      { calls: [submit()] }
    ]);
    const memory = engineOf({});
    await run(adapter, memory).text();
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "lab" }));
    expect(memory.threads.ensureThread).not.toHaveBeenCalled();
  });
});

describe("a draft reaches the user", () => {
  it("publishes an accepted report verbatim with no further model call, and holds back all text until then", async () => {
    const { adapter, requests } = scripted([
      { calls: begin(), text: "Starting the research." },
      { calls: [submit()], text: "DRAFT NARRATION beside the call." }
    ]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(adapter, memory));
    expect(requests).toHaveLength(2);
    expect(memory.published()).toBe(REPORT);
    // What streamed before research started is replaced; narration while it ran never streams.
    expect(tokens(seen).join("")).not.toContain("DRAFT NARRATION");
    expect(tokens(seen).at(-1)).toBe(REPORT);
    const resetAt = seen.map((event) => event.type).lastIndexOf("message_reset");
    const reportAt = seen.findIndex((event) => event.type === "token" && event.data.delta === REPORT);
    expect(resetAt).toBeLessThan(reportAt);
    // The next turn reads what was said as the answer's text, not only as a call's arguments.
    expect(memory.appended.at(-1)).toMatchObject({ kind: "assistant_text", text: REPORT });
    expect(memory.runs.complete).toHaveBeenCalledTimes(1);
  });

  it("opens the answer with the draft's summary, then the report, as the server places them, and the gates read both", async () => {
    const summary = "For your needs take the X1, at 300 in the shop; cheaper, the X2.\n\nBoth were in stock on the day.";
    const answer = `${summary}\n\n${REPORT}`;
    const drafts: ResearchDraft[] = [];
    const { adapter } = scripted([{ calls: begin() },
      { calls: [submit("call-draft", { record_ids: [], report: REPORT, summary: { row_keys: [], text: summary }, unreachable: [] })] }]);
    const memory = engineOf({ gates: [gate("spy", async (draft) => { drafts.push(draft); return { kind: "pass" }; })] });
    const seen = await events(run(adapter, memory));
    expect(drafts).toEqual([expect.objectContaining({ report: REPORT, summary: { rowKeys: [], text: summary } })]);
    // It cites no record, so its plain word that nothing was checked against a source follows the report.
    expect(memory.published()).toBe(researchAnswerText(answer, [researchNote("no_findings")]));
    expect(tokens(seen).at(-1)).toBe(memory.published());
    expect(memory.appended.at(-1)).toMatchObject({ kind: "assistant_text", text: memory.published() });
  });

  it("refuses a draft before research started, and an ordinary answer goes on as one", async () => {
    const { adapter, requests } = scripted([{ calls: [submit()] }, { text: "Plain answer." }]);
    const memory = engineOf({});
    const seen = await events(run(adapter, memory));
    expect(resultsOf(requests[1], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("research_not_started");
    expect(memory.published()).toBe("Plain answer.");
    expect(tokens(seen)).toEqual(["Plain answer."]);
  });

  it("asks once for the call when the model writes its report as a message, and never shows that text meanwhile", async () => {
    const { adapter, requests } = scripted([{ calls: begin() }, { text: "SECRET REPORT AS TEXT" }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(adapter, memory));
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.history)).toContain(`Call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME}`);
    expect(tokens(seen).join("")).not.toContain("SECRET REPORT");
    expect(memory.published()).toBe(REPORT);
  });

  it("takes the text itself through the gates when the model writes a message again, and the answer says it has no findings", async () => {
    const drafts: ResearchDraft[] = [];
    const { adapter, requests } = scripted([{ calls: begin() }, { text: "Отчёт текстом." }, { text: "Отчёт текстом, ещё раз." }]);
    const memory = engineOf({ gates: [gate("spy", async (draft) => { drafts.push(draft); return { kind: "pass" }; })] });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(3);
    expect(drafts).toEqual([expect.objectContaining({ findings: [], origin: "plain_text", report: "Отчёт текстом, ещё раз." })]);
    expect(memory.published()).toContain("Отчёт текстом, ещё раз.");
    expect(memory.published()).toContain(researchNote("no_findings"));
    // The call the server made for it is on record, and in no conversation.
    expect(memory.toolCalls.begin).toHaveBeenCalledWith(expect.objectContaining({ toolName: SUBMIT_RESEARCH_DRAFT_TOOL_NAME }));
    expect(memory.appended.filter((item) => item.kind === "tool_call" && item.name === SUBMIT_RESEARCH_DRAFT_TOOL_NAME)).toEqual([]);
  });

});

describe("the gap check's needs", () => {
  it("sees the draft and the plan, sends the model back for another round of sub-agents, and passes the next draft", async () => {
    const seen: Array<Pick<ResearchGateContext, "attempt"> & { earlier: number; goal: string; report: string }> = [];
    const gapCheck = gate("gap", async (draft, context) => {
      seen.push({ attempt: context.attempt, earlier: context.earlier.length, goal: context.plan.goal, report: draft.report });
      return context.attempt === 1 ? { kind: "send_back", message: "No owner reviews were opened: send a researcher to them." } : { kind: "pass" };
    });
    const { adapter, requests } = scripted([
      { calls: begin() },
      { calls: [submit("call-1")] },
      { calls: [{ arguments: { message: "Owner reviews.", name: "owners" }, id: "call-owners", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nowners say" },
      { calls: [submit("call-2", { ...DRAFT, report: "second" })] }
    ]);
    const memory = engineOf({ gates: [gapCheck] });
    const stream = await events(run(adapter, memory));
    expect(seen).toEqual([{ attempt: 1, earlier: 0, goal: "Choose a mattress.", report: REPORT }, { attempt: 2, earlier: 1, goal: "Choose a mattress.", report: "second" }]);
    expect(resultsOf(requests[2], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("No owner reviews were opened");
    expect(tokens(stream).join("")).not.toContain(REPORT);
    expect(memory.published()).toBe("second");
  });

  it("never loops past the deadline: past the tool time a send back becomes a note and no paid round follows", async () => {
    let clock = 0;
    const sentBack = gate("gap", async () => ({ kind: "send_back", message: "Keep looking.", unresolvedNote: "Owner reviews stayed open." }));
    const { adapter, requests } = scripted([
      { calls: begin() },
      { calls: [submit()], onCall: () => { clock = 55 * 60_000; } }
    ]);
    const memory = engineOf({ gates: [sentBack] }, { now: () => clock });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(2);
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*Owner reviews stayed open.*`);
  });

  it("past the tool time offers the draft alone once, and the corrected report goes through the gates inside the reserve", async () => {
    let clock = 0;
    const passes = gate("gap", async (_draft, context) => context.attempt === 1 ? { kind: "send_back", message: "One more round." } : { kind: "pass" });
    const { adapter, requests } = scripted([
      { calls: begin() },
      { calls: [submit()] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { calls: [submit("call-2", { ...DRAFT, report: "Final." })] }
    ]);
    const memory = engineOf({ gates: [passes] }, { now: () => clock });
    await run(adapter, memory).text();
    expect(requests.at(-1)!.history?.at(-1)).toMatchObject({ text: expect.stringContaining(SUBMIT_RESEARCH_DRAFT_TOOL_NAME), type: "user" });
    expect(requests).toHaveLength(4);
    expect(memory.published()).toBe("Final.");
  });

  it("past the tool time a message never replaces the report in hand", async () => {
    let clock = 0;
    const passes = gate("gap", async (_draft, context) => context.attempt === 1 ? { kind: "send_back", message: "One more round." } : { kind: "pass" });
    const { adapter, requests } = scripted([
      { calls: begin() },
      { calls: [submit()] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { text: "I would still like to look further." }
    ]);
    const memory = engineOf({ gates: [passes] }, { now: () => clock });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(4);
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("time_out")}*`);
  });

  it("past the tool time with no draft at all, the reserved round's message is the draft, and a round that is not asked for is not paid", async () => {
    let clock = 0;
    const { adapter, requests } = scripted([
      { calls: begin() },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-late", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { text: "Whatever I have." }
    ]);
    const memory = engineOf({}, { now: () => clock });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(3);
    expect(requests[2]!.history?.at(-1)).toMatchObject({ text: expect.stringContaining(SUBMIT_RESEARCH_DRAFT_TOOL_NAME), type: "user" });
    expect(memory.published()).toContain("Whatever I have.");
    expect(memory.published()).toContain(researchNote("no_findings"));
  });

  it("does not spend a round on a draft that the repeat guard blocks: the standing draft goes out, marked not fully checked", async () => {
    const stubborn = gate("gap", async () => ({ kind: "send_back", message: "Still open." }));
    const { adapter, requests } = scripted([{ calls: begin() }, { calls: [submit("call-1")] }, { calls: [submit("call-2")] }, { calls: [submit("call-3")] }, { calls: [submit("call-4")] }]);
    const memory = engineOf({ gates: [stubborn] });
    await run(adapter, memory).text();
    expect(requests.length).toBeLessThanOrEqual(5);
    // The draft the guard held back is one no gate finished on; that the send back went unanswered is no news to the reader.
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("gate_failed")}*`);
  });
});

describe("the verifier's needs", () => {
  function verifierRole(adapter: ProviderAdapter): ResearchVerifierRole {
    const route: SubagentModelRoute = { adapter, request: { modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
      modelId: "other-family-1", params: {}, provider: "other", reasoningEffort: null },
    snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-2", model: { adapterKind: "fake", upstreamModelId: "other-family-1" }, providerFamily: "other",
      providerModelId: "model-2" } as never, timeoutMs: 300_000 };
    return { frozenChoice: vi.fn(async () => ({ effort: null, kind: "set" as const, providerModelId: "model-2" })),
      route: vi.fn(async () => ({ connectionName: "Other", displayName: "Other One", route })) };
  }

  it("runs a server-started turn on the administrator's model of another family, without the reasoning, and it may open sources", async () => {
    const other = scripted([{ text: "Outcome: done\nsupported" }]);
    const reports: unknown[] = [];
    const verifier = gate("verifier", async (draft, context) => {
      expect(await context.verifierModel(context.signal)).toEqual({ kind: "role", label: "Other One · Other" });
      const outcome = await context.subagents.run({ brief: `Check: ${draft.findings[0]!.claim} ${draft.findings[0]!.url}`, instructions: "Check claims against their sources.",
        model: "verifier", name: "verifier", tools: ["web_fetch"] }, context.signal);
      reports.push(outcome);
      return { kind: "pass", notes: ["Checked by Other One."] };
    });
    const main = scripted([
      { calls: begin(), text: "MAIN AGENT REASONING" },
      { calls: [submit()] }
    ]);
    const memory = engineOf({ gates: [verifier], verifier: verifierRole(other.adapter) });
    await run(main.adapter, memory).text();
    // It ran on the other route, with the claims and no reasoning of the main agent.
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]!.modelId).toBe("other-family-1");
    expect(JSON.stringify(other.requests[0]!.history)).toContain("Check: The X1 holds up.");
    expect(JSON.stringify(other.requests[0]!.history)).not.toContain("MAIN AGENT REASONING");
    expect(JSON.stringify(other.requests[0]!.prompt)).toContain("Check claims against their sources.");
    // Its tools are the narrow list: the server's list, never every tool, and it starts no children.
    expect(other.requests[0]!.tools?.map((tool) => tool.name)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(other.requests[0]!.tools?.map((tool) => tool.name)).not.toContain(SUBMIT_RESEARCH_DRAFT_TOOL_NAME);
    expect(reports[0]).toMatchObject({ kind: "ended", result: { model: { id: "other-family-1" }, state: "done" } });
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ provider: "connection-2", providerModelId: "model-2" }),
      name: "verifier-1", parentRunId: "run-1", parentToolCallId: expect.stringMatching(/^row-/u) }));
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*Checked by Other One.*`);
  });

  it("falls back to the main model when the role is not set, and says so through what the gate reads; an unusable role runs nothing", async () => {
    const seen: unknown[] = [];
    const reader = gate("verifier", async (_draft, context) => {
      seen.push(await context.verifierModel(context.signal));
      seen.push(await context.subagents.run({ brief: "b", instructions: "i", model: "verifier", name: "v", tools: ["web_fetch"] }, context.signal));
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { text: "Outcome: done\nchecked" }]);
    await run(main.adapter, engineOf({ gates: [reader] })).text();
    expect(seen[0]).toEqual({ kind: "main_model", label: "fake-qsa" });
    expect(seen[1]).toMatchObject({ kind: "ended", result: { model: { id: "fake-qsa" } } });

    seen.length = 0;
    const second = scripted([{ calls: [start()] }, { text: "Research is unavailable." }]);
    const gone: ResearchVerifierRole = { frozenChoice: async () => ({ effort: null, kind: "set", providerModelId: "gone" }), route: async () => null };
    await run(second.adapter, engineOf({ gates: [reader], verifier: gone })).text();
    expect(seen).toEqual([]);
    expect(resultsOf(second.requests[1], START_RESEARCH_TOOL_NAME).join()).toContain("research_verifier_unavailable");
  });

  it("gives each gate's turn on one draft a call of its own, since a call has one turn in the database", async () => {
    const turnOf = (name: string) => gate(name, async (_draft, context) => {
      await context.subagents.run({ brief: `brief ${name}`, instructions: "i", model: "main", name, tools: [] }, context.signal);
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { text: "Outcome: done\nfirst" }, { text: "Outcome: done\nsecond" }]);
    const memory = engineOf({ gates: [turnOf("judge"), turnOf("verifier")] });
    await run(main.adapter, memory).text();
    const parents = vi.mocked(memory.threads.admitForeground).mock.calls.map(([input]) => input.parentToolCallId);
    expect(parents).toHaveLength(2);
    expect(new Set(parents).size).toBe(2);
    const gateCalls = memory.toolCalls.begin.mock.calls.map(([input]) => input).filter((input) => input.providerCallId.startsWith("research_gate_"));
    expect(gateCalls.map((input) => input.arguments.message)).toEqual(["brief judge", "brief verifier"]);
    expect(new Set(gateCalls.map((input) => input.ordinal)).size).toBe(2);
    expect(memory.toolCalls.settle).toHaveBeenCalledTimes(memory.toolCalls.begin.mock.calls.length);
  });

  it("keeps what the run froze: a role cleared after the run started does not change it", async () => {
    let policy = "model-2";
    const other = scripted([{ text: "Outcome: done\nok" }]);
    const role = verifierRole(other.adapter);
    const frozen = vi.fn(async () => ({ effort: null, kind: "set" as const, providerModelId: policy }));
    const reader = gate("verifier", async (_draft, context) => {
      policy = "cleared";
      await context.subagents.run({ brief: "b", instructions: "i", model: "verifier", name: "v", tools: ["web_fetch"] }, context.signal);
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [reader], verifier: { frozenChoice: frozen, route: role.route } })).text();
    expect(frozen).toHaveBeenCalledTimes(1);
    expect(role.route).toHaveBeenCalledWith(expect.objectContaining({ providerModelId: "model-2" }));
    expect(other.requests).toHaveLength(1);
  });

  it("reads the text agents really opened, whole from the saved result, and never what an agent wrote", async () => {
    const threadItems: TranscriptItem[] = [
      { arguments: JSON.stringify({ url: "https://lab.example/x1" }), callId: "t1", id: "i1", kind: "tool_call", name: "fetch_url" },
      { callId: "t1", handle: `tor1_${"1".repeat(32)}`, id: "i2", kind: "tool_result", name: "fetch_url", outcome: "complete", output: "excerpt" },
      { arguments: "{}", callId: "t2", id: "i3", kind: "tool_call", name: CALL_SUBAGENT_TOOL_NAME },
      { callId: "t2", id: "i4", kind: "tool_result", name: CALL_SUBAGENT_TOOL_NAME, outcome: "complete", output: "a report quoting: invented quote" },
      { arguments: "{}", callId: "t3", id: "i5", kind: "tool_call", name: "fetch_url" },
      { callId: "t3", id: "i6", kind: "tool_result", name: "fetch_url", outcome: "error", output: "refused" }
    ];
    const opened: unknown[] = [];
    const quoteCheck = gate("verifier", async (_draft, context) => {
      opened.push(...await context.sources.opened(context.signal));
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [quoteCheck] }, { threadEffects: [{ items: threadItems, threadId: "thread-1" }] })).text();
    expect(opened).toEqual([{ partial: false, text: "whole page: held up after 10 years", toolName: "fetch_url", url: "https://lab.example/x1" }]);
  });

  it("sends the main agent back to correct once, and its corrected report is what the user reads", async () => {
    const correctOnce = gate("verifier", async (draft, context) => context.attempt === 1
      ? { kind: "send_back", message: "Claim 1 is unsupported: remove or mark it." } : { kind: "pass", notes: [`Checked ${draft.findings.length} claim.`] });
    const main = scripted([
      { calls: begin() },
      { calls: [submit("call-1")] },
      { calls: [submit("call-2", { ...DRAFT, report: "Corrected." })] }
    ]);
    const memory = engineOf({ gates: [correctOnce] });
    await run(main.adapter, memory).text();
    expect(main.requests).toHaveLength(3);
    expect(memory.published()).toBe("Corrected.\n\n---\n\n*Checked 1 claim.*");
  });

  it("delivers the answer with a visible note when a gate fails, and the next gate still runs", async () => {
    const after = vi.fn(async () => ({ kind: "pass" as const }));
    const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [gate("broken", async () => { throw new Error("verifier down"); }), gate("after", after)] });
    await run(main.adapter, memory).text();
    expect(after).toHaveBeenCalledTimes(1);
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("gate_failed")}*`);
  });

  it("delivers the answer with a visible note when a gate outlasts its time, ignoring its signal or not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      let aborted = false;
      const hung = gate("hung", (_draft, context) => new Promise(() => {
        context.signal.addEventListener("abort", () => { aborted = true; });
      }));
      const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
      const memory = engineOf({ gates: [hung] });
      const finished = run(main.adapter, memory).text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 60_000 + 1_000);
      await finished;
      expect(aborted).toBe(true);
      expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("time_out")}*`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused visibly when the chat already runs its 20 sub-agents, and the answer still arrives", async () => {
    let outcome: unknown;
    const reader = gate("verifier", async (_draft, context) => {
      outcome = await context.subagents.run({ brief: "b", instructions: "i", model: "main", name: "v", tools: ["web_fetch"] }, context.signal);
      return { kind: "pass", notes: ["Not checked: the chat is busy."] };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [reader] });
    vi.mocked(memory.threads.admitForeground).mockResolvedValue({ code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" });
    await run(main.adapter, memory).text();
    expect(outcome).toEqual({ code: SUBAGENT_ERROR_CODES.limitReached, kind: "refused" });
    expect(memory.published()).toContain("Not checked: the chat is busy.");
  });
});

describe("review findings", () => {
  const lastSaved = (repo: ReturnType<typeof repository>) => (repo.appendAssistantText.mock.calls.at(-1) as unknown[] | undefined)?.[1];

  it("publishes a report the provider returned whole when recording its call fails, and checks nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const spy = vi.fn(async () => ({ kind: "pass" as const }));
      const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
      const memory = engineOf({ gates: [gate("spy", spy)] });
      vi.mocked(memory.deps.transcripts.append).mockImplementation(async (_scope, _from, items) => {
        if (items.some((item) => item.kind === "tool_call" && item.name === SUBMIT_RESEARCH_DRAFT_TOOL_NAME)) throw new Error("database down");
        memory.appended.push(...items);
      });
      const repo = repository();
      const finished = events(run(main.adapter, memory, {}, repo));
      await vi.advanceTimersByTimeAsync(5_000);
      const seen = await finished;
      expect(spy).not.toHaveBeenCalled();
      expect(memory.toolCalls.begin).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: SUBMIT_RESEARCH_DRAFT_TOOL_NAME }));
      const shown = `${REPORT}\n\n---\n\n*${researchNote("run_failed")}*`;
      expect(tokens(seen).at(-1)).toBe(shown);
      expect(repo.failRun).toHaveBeenCalledTimes(1);
      expect(lastSaved(repo)).toBe(shown);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a researcher beside a slow start_research, whatever order they record in: researchers start after the plan", async () => {
    const background = new FakeSubagentBackgroundControl();
    const main = scripted([
      { calls: [start(), { arguments: { background: true, message: "Cover it.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME }] },
      { calls: [propose()] },
      { calls: [submit()] }
    ]);
    const memory = engineOf({ gates: [] });
    const begin = vi.mocked(memory.toolCalls.begin);
    const original = begin.getMockImplementation()! as (input: Parameters<typeof memory.toolCalls.begin>[0]) => ReturnType<typeof memory.toolCalls.begin>;
    begin.mockImplementation(async (input) => {
      if (input.toolName === START_RESEARCH_TOOL_NAME) await new Promise((resolve) => setTimeout(resolve, 20));
      return original(input);
    });
    await run(main.adapter, memory, { subagents: { background } }).text();
    expect(background.turns).toEqual([]);
    expect(memory.threads.admitForeground).not.toHaveBeenCalled();
    expect(resultsOf(main.requests[1], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("researchers start after the plan");
    expect(memory.published()).toBe(REPORT);
  });

  it("does not start research for a start the batch refused, and what follows is an ordinary answer", async () => {
    let clock = 0;
    const main = scripted([{ calls: begin(), onCall: () => { clock = 55 * 60_000; } }, { text: "Answered without research." }]);
    const memory = engineOf({}, { now: () => clock });
    const seen = await events(run(main.adapter, memory));
    expect(tokens(seen)).toEqual(["Answered without research."]);
    expect(memory.published()).toBe("Answered without research.");
  });

  it("keeps the last attempt's withheld text with a note when the provider fails for good", async () => {
    const main = scripted([{ calls: begin() }, { fail: true, text: "# Partial report" }]);
    const memory = engineOf({});
    const repo = repository();
    const seen = await events(run(main.adapter, memory, {}, repo));
    const shown = `# Partial report\n\n---\n\n*${researchNote("incomplete")}*`;
    expect(tokens(seen).at(-1)).toBe(shown);
    expect(lastSaved(repo)).toBe(shown);
    expect(repo.failRun).toHaveBeenCalledTimes(1);
    expect(memory.published()).toBeNull();
  });

  it("keeps the last attempt's withheld text with a note at the turn's deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: begin() }, { hang: true, text: "# Hanging report" }]);
      const repo = repository();
      const finished = run(main.adapter, engineOf({}), {}, repo).text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      await finished;
      expect(lastSaved(repo)).toBe(`# Hanging report\n\n---\n\n*${researchNote("incomplete")}*`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops what a retried attempt streamed, so only the last attempt's text is kept", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: begin() }, { text: "DROPPED ATTEMPT" }, { fail: true, text: "Kept attempt" }]);
      const memory = engineOf({});
      let opened = 0;
      memory.deps = { ...memory.deps, faults: () => ({ take: (fault) => fault === "stream_drop_once" && ++opened === 2 }) };
      const repo = repository();
      const finished = run(main.adapter, memory, {}, repo).text();
      await vi.advanceTimersByTimeAsync(60_000);
      await finished;
      expect(main.requests).toHaveLength(3);
      expect(lastSaved(repo)).toBe(`Kept attempt\n\n---\n\n*${researchNote("incomplete")}*`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a submitted report over later narration when the provider fails", async () => {
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { fail: true, text: "Let me look at one more thing and also go on writing for a good long while." }]);
    const memory = engineOf({ gates: [gate("gap", async () => ({ kind: "send_back", message: "Again." }))] });
    const repo = repository();
    await run(main.adapter, memory, {}, repo).text();
    expect(lastSaved(repo)).toBe(`${REPORT}\n\n---\n\n*${researchNote("run_failed")}*`);
  });

  /** A report in the reserved round past the tool time, then a user correction delivered at its end. */
  function lateFollowup(after: readonly Step[]) {
    let clock = 0;
    const main = scripted([
      { calls: begin() },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-late", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { calls: [submit("call-1")] },
      ...after
    ]);
    let attempts = 0;
    let handed = false;
    const followups = {
      close: vi.fn(async () => true),
      deliver: vi.fn(async () => true),
      load: vi.fn(async () => {
        const due = !handed && attempts === 1;
        if (due) handed = true;
        return { entries: due ? [{ delivery: "accepted" as const, id: "f1", origin: "user" as const, text: "Correction: the budget is 500." }] : [], revision: 1 };
      })
    };
    const memory = engineOf({ gates: [gate("count", async () => { attempts += 1; return { kind: "pass" }; })] }, { now: () => clock });
    const repo = repository();
    return { main, memory, response: () => run(main.adapter, memory, { prepared: { ...prepared(), followupAdmission: {} as never } }, { ...repo, followups } as never), repo };
  }

  it("lets the model read a follow-up delivered after the tool time, and publishes what it hands in then", async () => {
    const late = lateFollowup([{ calls: [submit("call-2", { ...DRAFT, report: "Within 500." })] }]);
    await late.response().text();
    expect(late.main.requests).toHaveLength(4);
    expect(JSON.stringify(late.main.requests[3]!.history)).toContain("Correction: the budget is 500.");
    expect(late.main.requests[3]!.history?.at(-1)).toMatchObject({ text: expect.stringContaining(SUBMIT_RESEARCH_DRAFT_TOOL_NAME), type: "user" });
    expect(late.memory.published()).toBe("Within 500.");
  });

  it("takes the model's message as the answer once it has read the follow-up", async () => {
    const late = lateFollowup([{ text: "Within 500, as a message." }]);
    await late.response().text();
    expect(late.main.requests).toHaveLength(4);
    expect(late.memory.published()).toContain("Within 500, as a message.");
    expect(late.memory.published()).not.toContain(REPORT);
  });

  it("shows the earlier report with a note when the model says nothing more after a follow-up, without looping", async () => {
    const late = lateFollowup([{ calls: [{ arguments: { plan: [{ status: "pending", step: "y" }] }, id: "call-other", name: "update_plan" }] }]);
    await late.response().text();
    // The reserved round, a tool-free one, and the one that asks for the answer: then it ends.
    expect(late.main.requests.length).toBeLessThanOrEqual(6);
    expect(late.memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("followup_not_applied")}*`);
  });

  it("recovers the earlier report at the hard deadline when the model never answers the follow-up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const late = lateFollowup([{ hang: true }]);
      const finished = late.response().text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      await finished;
      expect(late.main.requests).toHaveLength(4);
      expect(late.repo.failRun).toHaveBeenCalledTimes(1);
      expect(lastSaved(late.repo)).toBe(`${REPORT}\n\n---\n\n*${researchNote("time_out")}*\n\n*${researchNote("followup_not_applied")}*`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a draft and its notes stay together", () => {
  const firstDraft = gate("counts", async (draft) => ({ kind: "send_back", message: "Correct it.", notes: [`Counts of ${draft.report}.`] }));
  const counts = (report: string) => `Counts of ${report}.`;

  it("Stop during the next draft's check shows that draft with the generic note, never the last draft's counts", async () => {
    const runId = "run-stop-second";
    const hangs = gate("hangs", (_draft, context) => new Promise((_resolve, reject) => {
      activeRunControllerRegistry.abort(runId);
      context.signal.addEventListener("abort", () => reject(context.signal.reason as Error));
    }));
    const main = scripted([{ calls: begin() }, { calls: [submit("call-1")] }, { calls: [submit("call-2", { ...DRAFT, report: "second" })] }]);
    let attempts = 0;
    const memory = engineOf({ gates: [gate("either", async (draft, context) => {
      attempts += 1;
      return attempts === 1 ? firstDraft.run(draft, context) : hangs.run(draft, context);
    })] });
    await run(main.adapter, memory, { runId }, repository()).text();
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), `second\n\n---\n\n*${researchNote("stopped")}*`);
  });

  it("a recording failure on the next draft shows it with the generic note, never the last draft's counts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: begin() }, { calls: [submit("call-1")] }, { calls: [submit("call-2", { ...DRAFT, report: "second" })] }]);
      const memory = engineOf({ gates: [firstDraft] });
      vi.mocked(memory.deps.transcripts.append).mockImplementation(async (_scope, _from, items) => {
        if (items.some((item) => item.kind === "tool_call" && item.callId === "call-2")) throw new Error("database down");
        memory.appended.push(...items);
      });
      const repo = repository();
      const finished = run(main.adapter, memory, {}, repo).text();
      await vi.advanceTimersByTimeAsync(5_000);
      await finished;
      expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", `second\n\n---\n\n*${researchNote("run_failed")}*`, { runId: "run-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the deadline past a replacement draft in the reserved round keeps that draft, without the last draft's counts", async () => {
    let clock = 0;
    const main = scripted([
      { calls: begin() },
      { calls: [submit("call-1")] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { calls: [submit("call-2", { ...DRAFT, report: "second" })] }
    ]);
    const memory = engineOf({ gates: [gate("counts", async (draft, context) => context.attempt === 1 ? firstDraft.run(draft, context)
      : { kind: "pass", notes: [counts(draft.report)] })] }, { now: () => clock });
    await run(main.adapter, memory).text();
    expect(memory.published()).toBe(`second\n\n---\n\n*${counts("second")}*`);
  });

  it("a draft that stands when tools close keeps its own notes", async () => {
    let clock = 0;
    const main = scripted([
      { calls: begin() },
      { calls: [submit("call-1")] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { text: "I would still like to look further." }
    ]);
    const memory = engineOf({ gates: [firstDraft] }, { now: () => clock });
    await run(main.adapter, memory).text();
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${counts(REPORT)}*\n\n*${researchNote("time_out")}*`);
  });

  it("a gate that did not finish on a draft adds what it carries, and one that did adds only what it said", async () => {
    const carrying: ResearchGate = { carriedNotes: () => ["Carried."], name: "carrying", run: async () => ({ kind: "pass", notes: ["Its own."] }) };
    const sendsBack = gate("first", async () => ({ kind: "send_back", message: "Again." }));
    const context = { attempt: 1, earlier: [], plan: { goal: "g", questions: [], skipped: [] }, signal: new AbortController().signal,
      sources: { opened: async () => [] }, subagents: { run: async () => ({ code: "x", kind: "refused" as const }) },
      time: { remainingMs: () => 60_000, sendBackAllowed: () => true }, verifierModel: async () => ({ kind: "unavailable" as const }) };
    const draft = { findings: [], origin: "reserved_call" as const, report: "r", unreachable: [] };
    expect(await runResearchGates({ context, draft, gates: [sendsBack, carrying], runId: "r" })).toEqual({ gate: "first", kind: "sent_back", message: "Again.", notes: [researchNote("gate_failed"), "Carried."] });
    expect(await runResearchGates({ context, draft, gates: [carrying], runId: "r" })).toEqual({ kind: "accepted", notes: ["Its own."] });
    const broken: ResearchGate = { ...carrying, run: async () => { throw new Error("down"); } };
    expect(await runResearchGates({ context, draft, gates: [broken], runId: "r" })).toEqual({ kind: "accepted", notes: [researchNote("gate_failed"), "Carried."] });
    const late = { ...context, time: { remainingMs: () => 0, sendBackAllowed: () => false } };
    expect(await runResearchGates({ context: late, draft, gates: [carrying], runId: "r" })).toEqual({ kind: "accepted", notes: [researchNote("time_out"), "Carried."] });
  });
});

describe("an approval continuation goes on with what the gates said", () => {
  const items = (draft: unknown, output: string): TranscriptItem[] => [
    { id: "msg-q", kind: "user", text: "Проведи исследование." },
    { arguments: JSON.stringify(PLAN), callId: "s", id: "s1", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
    { arguments: JSON.stringify(draft), callId: "d", id: "d1", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
    { callId: "d", id: "d2", kind: "tool_result", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME, outcome: "complete", output }
  ];

  it("rebuilds each attempt with the gates' own words, whatever wrapped them", () => {
    const sent = JSON.stringify({ message: `Not shown to the user yet. [Independent check] Line one.\nLine two. Then call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} again with the whole report.`, status: "sent_back" });
    expect(researchOfTurn(items(DRAFT, sent)).attempts).toEqual([{ draft: expect.objectContaining({ report: REPORT }), message: "[Independent check] Line one.\nLine two." }]);
    expect(researchOfTurn(items(DRAFT, `${sent}\n\nYou made this same call before.`)).attempts[0]!.message).toBe("[Independent check] Line one.\nLine two.");
    expect(researchOfTurn(items(DRAFT, JSON.stringify({ message: "Shown.", status: "accepted" }))).attempts).toEqual([{ draft: expect.anything(), message: null }]);
  });

  it("takes no attempt from a draft the gates never ended on: refused, or with no result", () => {
    const refused = items(DRAFT, JSON.stringify({ error: "research_check_running" }));
    expect(researchOfTurn(refused).attempts).toEqual([]);
    expect(researchOfTurn(refused).draft).toMatchObject({ report: REPORT });
    expect(researchOfTurn(refused.slice(0, 3)).attempts).toEqual([]);
  });
});

describe("the verifier's own turn is independent", () => {
  it("gets none of the user's words or the chat's instructions, and the gap judge keeps them", async () => {
    const seen: string[] = [];
    const both = gate("both", async (_draft, context) => {
      for (const [model, name] of [["verifier", "gap-judge"], ["verifier", "verifier"]] as const) {
        seen.push(model);
        await context.subagents.run({ brief: `brief of ${name}`, instructions: "i", model, name, tools: [] }, context.signal);
      }
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { text: "Outcome: done\njudge" }, { text: "Outcome: done\nverifier" }]);
    await run(main.adapter, engineOf({ gates: [both] })).text();
    const [judge, verifier] = [main.requests[2]!, main.requests[3]!];
    expect(JSON.stringify(judge.history)).toContain("Проведи исследование матрасов.");
    expect(judge.prompt.system).toContain("Be brief.");
    expect(JSON.stringify(verifier.history)).toContain("brief of verifier");
    expect(JSON.stringify(verifier.history)).not.toContain("Проведи исследование матрасов.");
    expect(verifier.prompt.system).not.toContain("Be brief.");
  });

  it("does not read what the user writes into the answer meanwhile", async () => {
    // Waiting only while the gate runs, so the main agent's own rounds never read it and never reopen the answer.
    let waiting = false;
    const check = gate("verifier", async (_draft, context) => {
      waiting = true;
      await context.subagents.run({ brief: "b", instructions: "i", model: "verifier", name: "gap-judge", tools: [] }, context.signal);
      await context.subagents.run({ brief: "b", instructions: "i", model: "verifier", name: "verifier", tools: [] }, context.signal);
      waiting = false;
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { text: "Outcome: done\njudge" }, { text: "Outcome: done\nverifier" }]);
    const repo = repository();
    const followups = { close: vi.fn(async () => true), deliver: vi.fn(async () => true),
      load: vi.fn(async () => ({ entries: waiting ? [{ delivery: "accepted" as const, id: "f1", origin: "user" as const, text: "USER FOLLOW-UP" }] : [], revision: 1 })) };
    await run(main.adapter, engineOf({ gates: [check] }), { prepared: { ...prepared(), followupAdmission: {} as never } }, { ...repo, followups } as never).text();
    expect(main.requests).toHaveLength(4);
    expect(JSON.stringify(main.requests[2]!.history)).toContain("USER FOLLOW-UP");
    expect(JSON.stringify(main.requests[3]!.history)).not.toContain("USER FOLLOW-UP");
  });

  it("starts a new thread under this run's name alone, never continuing an earlier answer's research", async () => {
    const check = gate("verifier", async (_draft, context) => {
      await context.subagents.run({ brief: "b", instructions: "i", model: "verifier", name: "verifier", tools: [] }, context.signal);
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { text: "Outcome: done\nok" }]);
    const memory = engineOf({ gates: [check] });
    await run(main.adapter, memory).text();
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ branchRunIds: ["run-1"], name: "verifier-1" }));
  });

  function roleOf(adapter: ProviderAdapter, upstream: string, providerModelId: string, connectionId = "connection-2"): ResearchVerifierRole {
    const route: SubagentModelRoute = { adapter, request: { modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
      modelId: upstream, params: {}, provider: "other", reasoningEffort: null },
    snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId, model: { adapterKind: "fake", upstreamModelId: upstream }, providerFamily: "other", providerModelId } as never, timeoutMs: 300_000 };
    return { frozenChoice: vi.fn(async () => ({ effort: null, kind: "set" as const, providerModelId })),
      route: vi.fn(async () => ({ connectionName: "Same", displayName: "Same One", route })) };
  }

  it.each([["the same model row", "fake-qsa", "model-1", "connection-1"], ["the same model over another connection", "fake-qsa", "model-9", "connection-2"],
    ["the same model under a provider's namespace", "vendor/FAKE.qsa", "model-9", "connection-2"]])(
    "does not call %s independent", async (_name, upstream, providerModelId, connectionId) => {
      let model: unknown;
      const reader = gate("verifier", async (_draft, context) => {
        model = await context.verifierModel(context.signal);
        return { kind: "pass" };
      });
      const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
      await run(main.adapter, engineOf({ gates: [reader], verifier: roleOf(main.adapter, upstream, providerModelId, connectionId) })).text();
      expect(model).toEqual({ kind: "main_model", label: "Same One · Same" });
    });

  it("knows one model under its several names, and no two models as one", () => {
    const native = researchModelIdentity("gpt-6.1-sol");
    for (const alias of ["openai/gpt-6.1-sol", "OpenAI/GPT-6.1-Sol", "codex-lb:gpt-6.1-sol", "gpt-6-1-sol", "openai/gpt-6.1-sol:free", "a/b/gpt-6.1-sol"]) expect(researchModelIdentity(alias), alias).toBe(native);
    for (const other of ["gpt-6.1", "gpt-6.2-sol", "gpt-6.1-sol-mini", "anthropic/claude-opus-5.5"]) expect(researchModelIdentity(other), other).not.toBe(native);
  });

  it("keeps a different model as the role", async () => {
    let model: unknown;
    const reader = gate("verifier", async (_draft, context) => {
      model = await context.verifierModel(context.signal);
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [reader], verifier: roleOf(main.adapter, "other-1", "model-2") })).text();
    expect(model).toEqual({ kind: "role", label: "Same One · Same" });
  });

  it("does not hold a failure to resolve the role for the run: the next attempt asks again, and a refusal does hold", async () => {
    const outcomes: unknown[] = [];
    const reader = gate("verifier", async (_draft, context) => {
      await context.verifierModel(context.signal).then((value) => outcomes.push(value), () => outcomes.push("threw"));
      return context.attempt === 1 ? { kind: "send_back", message: "Again." } : { kind: "pass" };
    });
    const main = scripted([{ calls: [start()] }, { calls: [start("retry-start"), propose()] }, { calls: [submit("call-1")] }, { calls: [submit("call-2")] }]);
    const good = roleOf(main.adapter, "other-1", "model-2");
    const route = vi.mocked(good.route);
    const answer = await route.getMockImplementation()!({ effort: null, providerModelId: "model-2", runId: "r", userId: "u" });
    route.mockReset();
    route.mockRejectedValueOnce(new Error("database down")).mockResolvedValue(answer);
    await run(main.adapter, engineOf({ gates: [reader], verifier: good })).text();
    expect(resultsOf(main.requests[1], START_RESEARCH_TOOL_NAME).join()).toContain("research_verifier_unavailable");
    expect(outcomes).toEqual([{ kind: "role", label: "Same One · Same" }, { kind: "role", label: "Same One · Same" }]);

    const refusing = vi.fn(async () => null);
    const main2 = scripted([{ calls: [start()] }, { calls: [start("retry-start")] }, { text: "Research is unavailable." }]);
    outcomes.length = 0;
    await run(main2.adapter, engineOf({ gates: [reader], verifier: { frozenChoice: good.frozenChoice, route: refusing } })).text();
    expect(outcomes).toEqual([]);
    expect(resultsOf(main2.requests[2], START_RESEARCH_TOOL_NAME).join()).toContain("research_verifier_unavailable");
    expect(refusing).toHaveBeenCalledTimes(1);
  });
});

describe("what ends research", () => {
  it("Stop during a gate ends it and its sub-agent turn, starts nothing more, and keeps the report with a note", async () => {
    const runId = "run-stop";
    const reader = gate("verifier", async (_draft, context) => {
      await context.subagents.run({ brief: "b", instructions: "i", model: "main", name: "v", tools: ["web_fetch"] }, context.signal);
      return { kind: "pass" };
    });
    const main = scripted([{ calls: begin() }, { calls: [submit()] }, { onCall: () => activeRunControllerRegistry.abort(runId) }]);
    const memory = engineOf({ gates: [reader] });
    const repo = repository();
    const seen = await events(run(main.adapter, memory, { runId }, repo));
    // The gate's turn made one request, which Stop ended; nothing came after it.
    expect(main.requests).toHaveLength(3);
    expect(seen.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(memory.published()).toBeNull();
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), `${REPORT}\n\n---\n\n*${researchNote("stopped")}*`);
    expect(memory.threads.settle).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ state: "stopped" }) }));
    expect(activeRunControllerRegistry.executing()).not.toContain(runId);
  });

  it("Stop before any draft shows nothing it held", async () => {
    const runId = "run-stop-early";
    const main = scripted([{ calls: begin(), text: "Starting." }, { onCall: () => activeRunControllerRegistry.abort(runId), text: "HELD NARRATION" }]);
    const memory = engineOf({});
    const seen = await events(run(main.adapter, memory, { runId }));
    expect(seen.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), "Starting.");
  });

  it("a run that fails with a report in hand keeps it with a note", async () => {
    const main = scripted([
      { calls: begin() },
      { calls: [submit()] },
      { fail: true }
    ]);
    const memory = engineOf({ gates: [gate("gap", async (_draft, context) => context.attempt === 1 ? { kind: "send_back", message: "Again." } : { kind: "pass" })] });
    const repo = repository();
    await run(main.adapter, memory, {}, repo).text();
    expect(memory.published()).toBeNull();
    expect(repo.failRun).toHaveBeenCalledTimes(1);
    expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", `${REPORT}\n\n---\n\n*${researchNote("run_failed")}*`, { runId: "run-1" });
  });

  it("the turn's hard deadline with a report in hand keeps it with a note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: begin() }, { calls: [submit()] }, { hang: true }]);
      const memory = engineOf({ gates: [gate("gap", async (_draft, context) => context.attempt === 1 ? { kind: "send_back", message: "Again." } : { kind: "pass" })] });
      const repo = repository();
      const finished = run(main.adapter, memory, {}, repo).text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      await finished;
      expect(repo.failRun).toHaveBeenCalledWith("run-1", "answer-1", expect.objectContaining({ code: "run_time_limit" }), expect.anything());
      expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", `${REPORT}\n\n---\n\n*${researchNote("time_out")}*`, { runId: "run-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a restart replays nothing: the next turn is an ordinary one, whose text streams, with the old call only in its context", async () => {
    // The turn after an interrupted run: what the interrupted run recorded is in its context, and research is not active.
    const interrupted: TranscriptItem[] = [
      { arguments: JSON.stringify(PLAN), callId: "call-start", id: "i1", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
      { callId: "call-start", id: "i2", kind: "tool_result", name: START_RESEARCH_TOOL_NAME, outcome: "complete", output: "started" }
    ];
    const main = scripted([{ text: "Continuing as an ordinary answer." }]);
    const memory = engineOf({});
    vi.mocked(memory.deps.transcripts.nativeRunsForAnswers).mockResolvedValue(new Map([["answer-0", "run-0"]]));
    vi.mocked(memory.deps.transcripts.loadRuns).mockResolvedValue(new Map([["run-0", interrupted]]));
    const base = prepared();
    const messages = [{ content: { blocks: [{ text: "Проведи исследование.", type: "text" }] }, id: "q0", role: "user" as const },
      { content: { blocks: [{ text: "", type: "text" }] }, id: "answer-0", role: "assistant" as const },
      { content: { blocks: [{ text: "Continue", type: "text" }] }, id: "current-user-message", role: "user" as const }];
    const request = { ...base.normalizedRequest, context: { messages, mode: "branch_path" as const } } as ProviderRunRequest;
    const seen = await events(run(main.adapter, memory, { prepared: { ...base, normalizedRequest: request, providerRequest: request } }));
    expect(main.requests).toHaveLength(1);
    expect(JSON.stringify(main.requests[0]!.history)).toContain(START_RESEARCH_TOOL_NAME);
    expect(tokens(seen)).toEqual(["Continuing as an ordinary answer."]);
    expect(memory.published()).toBe("Continuing as an ordinary answer.");
  });

  it("an approval continuation goes on with the research of its turn", () => {
    const items: TranscriptItem[] = [
      { id: "msg-q", kind: "user", text: "Earlier." },
      { arguments: JSON.stringify(PLAN), callId: "old", id: "o", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
      { id: "msg-q2", kind: "user", text: "Проведи исследование." },
      { arguments: JSON.stringify({ ...PLAN, goal: "This turn." }), callId: "new", id: "n", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
      { arguments: JSON.stringify(DRAFT), callId: "d1", id: "d1", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME },
      { arguments: JSON.stringify({ ...DRAFT, report: "Later draft." }), callId: "d2", id: "d2", kind: "tool_call", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME }
    ];
    expect(researchOfTurn(items)).toMatchObject({ draft: { report: "Later draft." }, plan: { goal: "This turn." } });
    expect(researchOfTurn(items.slice(0, 3))).toEqual({ attempts: [], draft: null, plan: null });
  });

  it("a follow-up that arrives during a check reopens the answer: the model reads it and hands in again", async () => {
    const seenAttempts: number[] = [];
    const passes = gate("gap", async (_draft, context) => { seenAttempts.push(context.attempt); return { kind: "pass" }; });
    const main = scripted([
      { calls: begin() },
      { calls: [submit("call-1")] },
      { calls: [submit("call-2", { ...DRAFT, report: "With the follow-up." })] }
    ]);
    const memory = engineOf({ gates: [passes] });
    const repo = repository();
    let handed = false;
    const followups = {
      close: vi.fn(async () => true),
      deliver: vi.fn(async () => true),
      load: vi.fn(async () => {
        const due = !handed && seenAttempts.length === 1;
        if (due) handed = true;
        return { entries: due ? [{ delivery: "accepted" as const, id: "f1", origin: "user" as const, text: "Also check prices." }] : [], revision: 1 };
      })
    };
    const withFollowups = { ...repo, followups };
    await run(main.adapter, memory, { prepared: { ...prepared(), followupAdmission: {} as never } }, withFollowups as never).text();
    expect(seenAttempts).toEqual([1, 2]);
    expect(JSON.stringify(main.requests[2]!.history)).toContain("Also check prices.");
    expect(memory.published()).toBe("With the follow-up.");
  });
});

/** The real role over fake database and provider ports; its request still passes the stored-snapshot decoder. */
function installedResearchRole(adapter: ProviderAdapter, options: { effort?: string | null; missing?: boolean; sameModel?: boolean; role?: "checks" | "researcher" } = {}) {
  const snapshot = { connection: { allowPrivateNetwork: false, apiRoot: "https://research.example/v1", authenticationMode: "bearer", responseTimeoutMs: 120_000 }, connectionDisplayName: "Research provider",
    connectionId: options.sameModel ? "connection-1" : "research-connection", credentialId: "installation-key", credentialVersionId: "installation-key-version",
    model: { adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer", defaultParams: {}, upstreamModelId: "research-upstream",
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low", toolCalling: true, vision: false } },
    modelDisplayName: "Research model", providerFamily: "openai_compatible", providerModelId: options.sameModel ? "model-1" : "research-model", version: 1 };
  const policy = { researchResearcherProviderModelId: snapshot.providerModelId, researchResearcherReasoningEffort: options.effort === undefined ? "high" : options.effort,
    researchVerifierProviderModelId: snapshot.providerModelId, researchVerifierReasoningEffort: options.effort === undefined ? "high" : options.effort };
  const bindings = new Map<string, { executionSnapshot: unknown }>();
  const tx = { modelRun: { findFirst: vi.fn(async () => ({ id: "run-1" })) }, providerRunBinding: {
    createMany: vi.fn(async ({ data }: { data: { bindingKey: string; executionSnapshot: unknown }[] }) => {
      for (const row of data) if (!bindings.has(row.bindingKey)) bindings.set(row.bindingKey, { executionSnapshot: row.executionSnapshot });
    }) } };
  const db = { $transaction: async (body: (client: typeof tx) => Promise<unknown>) => body(tx),
    systemModelPolicy: { findUnique: vi.fn(async () => ({ ...policy })) },
    providerModel: { findUnique: vi.fn(async () => ({ connection: { displayName: "Research provider" }, displayName: "Research model" })) },
    providerRunBinding: { findUnique: vi.fn(async ({ where }: { where: { modelRunId_bindingKey: { bindingKey: string } } }) =>
      bindings.get(where.modelRunId_bindingKey.bindingKey) ?? null) } };
  const loadRole = vi.fn(async () => {
    if (options.missing) throw new ProviderAdmissionError("model_not_available");
    return { credentialSource: "default", modelConfiguration: snapshot.model, snapshot };
  });
  const runtime = { resolve: vi.fn(async () => ({ adapter, responseTimeoutMs: 120_000 })) };
  return { bindings, loadRole, policy, runtime, role: createResearchVerifierRole({ loadRole: loadRole as never, prisma: db as never,
    role: options.role ?? "researcher", runtime: runtime as never }) };
}

describe("researchers on the installation role", () => {
  it.each([false, true])("records the selected model and effort on the actual sub-agent turn (same catalog row: %s)", async (sameModel) => {
    const child = scripted([{ text: "Outcome: done\nFindings." }]);
    const installed = installedResearchRole(child.adapter, { sameModel });
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME,
      arguments: { name: "researcher", message: "Read the sources.", model: "agent-choice", effort: "low", background: true } }],
      onCall: () => { installed.policy.researchResearcherProviderModelId = "replacement"; installed.policy.researchResearcherReasoningEffort = "low"; } },
    { calls: [submit()] }]);
    const memory = engineOf({ gates: [], researcher: installed.role });
    await run(main.adapter, memory).text();
    const recorded = await vi.mocked(memory.threads.admitForeground).mock.results[0]!.value;
    expect(recorded).toMatchObject({ kind: "admitted", turn: { modelId: "research-upstream", provider: sameModel ? "connection-1" : "research-connection",
      providerModelId: sameModel ? "model-1" : "research-model", reasoningEffort: "high", mode: "foreground" } });
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]).toMatchObject({ modelId: "research-upstream", reasoningEffort: "high", params: { reasoning: { effort: "high" } } });
    expect(JSON.stringify(child.requests[0]!.history)).toContain("# Research method (from the server)");
    expect(JSON.stringify(child.requests[0]!.history)).toContain("Проведи исследование матрасов.");
    expect(child.requests[0]!.prompt.system).toContain("Be brief.");
    // A researcher on the role starts no children either, with every tool.
    expect(child.requests[0]!.tools?.map((tool) => tool.name)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(installed.bindings.get(RESEARCH_RESEARCHER_BINDING_KEY)).toMatchObject({ executionSnapshot: { credentialId: "installation-key" } });
    expect(installed.loadRole).toHaveBeenCalledTimes(1);
    expect(installed.runtime.resolve).toHaveBeenCalledExactlyOnceWith("run-1", "answer", RESEARCH_RESEARCHER_BINDING_KEY);
    expect(main.requests).toHaveLength(3);
    expect(main.requests.every((request) => request.modelId === "fake-qsa")).toBe(true);
    expect(memory.published()).toBe(REPORT);
  });

  it("keeps the role's model default when a call or custom type supplies an effort", async () => {
    const child = scripted([{ text: "Outcome: done\nFindings." }]);
    const installed = installedResearchRole(child.adapter, { effort: null });
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME,
      arguments: { name: "researcher", type: "specialist", message: "Read the sources.", model: "agent-choice", effort: "high" } }] }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [], researcher: installed.role });
    await run(main.adapter, memory, { subagents: { types: {
      catalog: async () => [], resolve: async () => ({ kind: "found", type: { definitionId: "type", revisionId: "rev", name: "specialist",
        description: "", instructions: "Specialist instructions.", providerModelId: "type-model", reasoningEffort: "high", toolGroups: [] } })
    } } }).text();
    const recorded = await vi.mocked(memory.threads.admitForeground).mock.results[0]!.value;
    expect(recorded).toMatchObject({ turn: { providerModelId: "research-model", reasoningEffort: null, definitionRevisionId: "rev" } });
    expect(child.requests[0]).toMatchObject({ modelId: "research-upstream", reasoningEffort: null });
    expect(child.requests[0]!.prompt.system).toContain("Specialist instructions.");
  });

  it("keeps a researcher's bookkeeping on the role's host, for a custom type that narrows its tools, while a gate on that model has none", async () => {
    const child = scripted([{ text: "Outcome: done\nFindings." }, { text: "Outcome: done\nHolds." }]);
    const installed = installedResearchRole(child.adapter);
    const checks = installedResearchRole(child.adapter, { role: "checks" });
    const gated: ResearchGate = { name: "turns", run: async (_draft, context) => {
      await context.subagents.run({ brief: "Check it.", instructions: "Check.", model: "verifier", name: "verifier", tools: [SUBAGENT_TOOL_GROUPS.web_search, SUBAGENT_TOOL_GROUPS.web_fetch] }, context.signal);
      return { kind: "pass" };
    } };
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME,
      arguments: { name: "researcher", type: "web-researcher", message: "Read the sources." } }] }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [gated], researcher: installed.role, verifier: checks.role }), { subagents: { types: {
      catalog: async () => [], resolve: async () => ({ kind: "found", type: { definitionId: "type", revisionId: "rev", name: "web-researcher",
        description: "", instructions: "Read the web.", providerModelId: null, reasoningEffort: null, toolGroups: [SUBAGENT_TOOL_GROUPS.web_search, SUBAGENT_TOOL_GROUPS.web_fetch, SUBAGENT_TOOL_GROUPS.workspace] } })
    } } }).text();
    const offered = (request: ProviderRunRequest | undefined) => request?.tools?.map((tool) => tool.name) ?? [];
    expect(child.requests).toHaveLength(2);
    expect(offered(child.requests[0])).toEqual(expect.arrayContaining([CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME]));
    expect(offered(child.requests[1])).not.toContain(CHANGE_RESEARCH_FRAME_TOOL_NAME);
    expect(offered(child.requests[1])).not.toContain(RECORD_EVIDENCE_TOOL_NAME);
  });

  it("refuses a disappeared researcher at start and in a sibling call of the same response", async () => {
    const child = scripted([{ text: "Must not run." }]);
    const installed = installedResearchRole(child.adapter, { missing: true });
    const main = scripted([{ calls: [start(), { id: "research-call", name: CALL_SUBAGENT_TOOL_NAME,
      arguments: { name: "researcher", message: "Read the sources." } }] }, { text: "Research could not start." }]);
    const memory = engineOf({ gates: [], researcher: installed.role });
    await run(main.adapter, memory).text();
    expect(resultsOf(main.requests[1], START_RESEARCH_TOOL_NAME).join()).toContain("research_researcher_unavailable");
    expect(resultsOf(main.requests[1], CALL_SUBAGENT_TOOL_NAME).join()).toContain("research_plan_first");
    expect(memory.threads.admitForeground).not.toHaveBeenCalled();
    expect(child.requests).toHaveLength(0);
    expect(memory.published()).toBe("Research could not start.");
  });
});

it("runs the gap judge on the checks binding with the user's request and its requested tools", async () => {
  const child = scripted([{ text: "Outcome: done\nNo gaps." }]);
  const installed = installedResearchRole(child.adapter, { role: "checks" });
  const judge = gate("gap_check", async (_draft, context) => {
    const outcome = await context.subagents.run({ brief: "Plan and findings.", instructions: "Check the plan.", model: "verifier", name: "gap-judge", tools: ["web_fetch"] }, context.signal);
    expect(outcome.kind).toBe("ended");
    return { kind: "pass" };
  });
  const main = scripted([{ calls: begin() }, { calls: [submit()] }]);
  const memory = engineOf({ gates: [judge], verifier: installed.role });
  const base = prepared();
  const request = { ...base.providerRequest, fetchUrl: { version: 1 as const, userUrlDigests: [] } };
  await run(main.adapter, memory, { prepared: { ...base, normalizedRequest: request, providerRequest: request } }).text();
  const recorded = await vi.mocked(memory.threads.admitForeground).mock.results[0]!.value;
  expect(recorded).toMatchObject({ turn: { providerModelId: "research-model", reasoningEffort: "high" } });
  expect(child.requests).toHaveLength(1);
  expect(JSON.stringify(child.requests[0]!.history)).toContain("Проведи исследование матрасов.");
  expect(child.requests[0]!.prompt.system).toContain("Be brief.");
  expect(child.requests[0]!.tools?.map((tool) => tool.name)).toContain("fetch_url");
  expect(memory.published()).toBe(REPORT);
});

describe("researchers with no role", () => {
  const personal = { connectionId: "personal-provider", contextWindow: null, defaultEffort: "high", displayName: "Personal model", imageInput: false,
    providerFamily: "fake", providerModelId: "personal-model", reasoningEfforts: ["low", "high"], upstreamModelId: "personal-upstream" };
  /** A custom sub-agent on another model of the user's at its own effort, as the user's default was in the psaux trace. */
  const custom = (name: string) => ({ definitionId: `type-${name}`, revisionId: `rev-${name}`, name, description: "", instructions: `Custom ${name} instructions.`,
    providerModelId: "personal-model", reasoningEffort: "high", toolGroups: null });
  const offered = (request: ProviderRunRequest | undefined) => request?.tools?.map((tool) => tool.name) ?? [];

  it.each([
    ["the user's default", { name: "researcher", message: "Read the sources." }],
    ["the call's type, model and effort", { name: "researcher", type: "specialist", message: "Read the sources.", model: "personal-model", effort: "low" }],
    ["a custom sub-agent of its name", { name: "specialist", message: "Read the sources." }]
  ])("runs as the built-in sub-agent on the chat's model and effort, whatever %s names", async (_case, args) => {
    const child = scripted([{ text: "Must not run." }]);
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME, arguments: args }] },
      { text: "Outcome: done\nFindings." }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [], researcher: { frozenChoice: async () => ({ kind: "not_set" }), route: vi.fn() } });
    const base = prepared();
    const request = { ...base.providerRequest, reasoningEffort: "medium", subagentDefault: { definitionId: "type-deep", name: "deep", version: 1 as const },
      subagentModels: { version: 1 as const, models: [personal] } };
    const subagentModels: NonNullable<NativeEngineDeps["subagentModels"]> = { route: vi.fn(async () => ({ ok: true as const, route: { adapter: child.adapter,
      request: { modelCapabilities: request.modelCapabilities, modelId: "personal-upstream", params: {}, provider: "fake", reasoningEffort: "high" },
      snapshot: { connectionId: "personal-provider", providerFamily: "fake", providerModelId: "personal-model",
        model: { adapterKind: "fake", upstreamModelId: "personal-upstream" } } as never, timeoutMs: 120_000 } })) };
    const resolve = vi.fn(async (scope: { definitionId?: string; name?: string }) =>
      ({ kind: "found" as const, type: custom(scope.name ?? scope.definitionId?.replace(/^type-/u, "") ?? "deep") }));
    await run(main.adapter, { ...memory, deps: { ...memory.deps, subagentModels } }, { prepared: { ...base, normalizedRequest: request, providerRequest: request },
      subagents: { types: { catalog: async () => [], resolve } } }).text();
    expect(memory.threads.admitForeground).toHaveBeenCalledOnce();
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ definitionId: null, definitionRevisionId: null, typeName: null,
      binding: { effortSource: "parent", modelId: "fake-qsa", modelSource: "parent", provider: "connection-1", providerModelId: "model-1", reasoningEffort: "medium" } }));
    expect(subagentModels.route).not.toHaveBeenCalled();
    expect(memory.deps.research?.researcher?.route).not.toHaveBeenCalled();
    expect(child.requests).toHaveLength(0);
    // The researcher's turn ran on the chat's adapter, with the method's brief and none of a custom type's instructions.
    const researcher = main.requests[2]!;
    expect(researcher).toMatchObject({ modelId: "fake-qsa", reasoningEffort: "medium" });
    expect(JSON.stringify(researcher.history)).toContain("# Research method (from the server)");
    expect(researcher.prompt.system).not.toContain("Custom ");
    expect(offered(researcher)).toEqual(expect.arrayContaining([CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME]));
    expect(offered(researcher)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(memory.published()).toBe(REPORT);
  });

  it("starts no children: call_subagent is not among a researcher's tools, and a call of it anyway starts nothing", async () => {
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME, arguments: { name: "lab", message: "Read the sources." } }] },
      { calls: [{ id: "child-call", name: CALL_SUBAGENT_TOOL_NAME, arguments: { name: "helper", message: "Read the shop.", background: true } }] },
      { text: "Outcome: done\nFindings." }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [] });
    await run(main.adapter, memory).text();
    expect(offered(main.requests[2])).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(offered(main.requests[2])).not.toContain("stop_subagent");
    expect(resultsOf(main.requests[3], CALL_SUBAGENT_TOOL_NAME)).toHaveLength(1);
    expect(memory.threads.admitForeground).toHaveBeenCalledOnce();
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "lab" }));
    expect(memory.threads.ensureThread).not.toHaveBeenCalled();
    expect(memory.published()).toBe(REPORT);
  });

  it("leaves the main agent's tool list the same across its turns", async () => {
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME, arguments: { name: "lab", message: "Read the sources." } }] },
      { text: "Outcome: done\nFindings." }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [] })).text();
    const ofMain = [main.requests[0], main.requests[1], main.requests[3]].map((request) => JSON.stringify(request?.tools));
    expect(new Set(ofMain).size).toBe(1);
    expect(offered(main.requests[0])).toContain(CALL_SUBAGENT_TOOL_NAME);
  });
});

describe("a researcher's context sheds its old pages", () => {
  const SAVED = `tor1_${"a".repeat(32)}`;
  const READS = 16;
  const READ_CHARACTERS = 20_000;
  const book = "Owners report the latex layer holds its shape after years; the seller lists 3 cm latex over coir. ".repeat(4_000);
  const reads = Array.from({ length: READS }, (_, index) => ({ calls: [{ arguments: { handle: SAVED, limit: READ_CHARACTERS, offset: index * READ_CHARACTERS },
    id: `read-${index}`, name: "read_tool_result" }] }));
  const reading = (memory: ReturnType<typeof engineOf>) => ({ ...memory, deps: { ...memory.deps,
    savedResults: { read: vi.fn(async () => ({ arguments: { url: "https://shop.example/x1" }, text: book, toolName: "fetch_url" })) } } });
  const resultsOfRead = (request: ProviderRunRequest | undefined) => resultsOf(request, "read_tool_result");
  const cleared = (output: string) => output.startsWith("[Cleared to keep this context small: ");

  /** The newest reads stay whole, and each older one is a stub naming the read that brings it back. */
  function expectShed(researcher: readonly ProviderRunRequest[]) {
    const last = resultsOfRead(researcher.at(-1));
    expect(last).toHaveLength(READS);
    expect(last.slice(-3).map((output) => (JSON.parse(output) as { offset: number; text: string }))).toEqual([13, 14, 15].map((index) =>
      expect.objectContaining({ offset: index * READ_CHARACTERS, text: book.slice(index * READ_CHARACTERS, (index + 1) * READ_CHARACTERS) })));
    expect(cleared(last[0]!)).toBe(true);
    expect(last[0]).toContain(`call read_tool_result with {"handle":"${SAVED}","offset":0,"limit":${READ_CHARACTERS}} to read it again.]`);
    // The first request after the first clearing is a fraction of the one before it.
    const sizes = researcher.map((request) => JSON.stringify(request.history).length);
    expect(Math.min(...sizes.slice(sizes.findIndex((_, index) => resultsOfRead(researcher[index]).some(cleared))))).toBeLessThan(Math.max(...sizes) / 2);
  }

  it("for a researcher with no role, on the chat's model", async () => {
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME, arguments: { name: "lab", message: "Read the sources." } }] },
      ...reads, { text: "Outcome: done\nFindings." }, { calls: [submit()] }]);
    const memory = reading(engineOf({ gates: [] }));
    await run(main.adapter, memory, { prepared: prepared({ noLimits: true }) }).text();
    expectShed(main.requests.slice(2, 3 + READS));
    expect(memory.published()).toBe(REPORT);
  });

  it("for a researcher on the installation role", async () => {
    const child = scripted([...reads, { text: "Outcome: done\nFindings." }]);
    const installed = installedResearchRole(child.adapter);
    const main = scripted([{ calls: begin() }, { calls: [{ id: "research-call", name: CALL_SUBAGENT_TOOL_NAME, arguments: { name: "lab", message: "Read the sources." } }] },
      { calls: [submit()] }]);
    const memory = reading(engineOf({ gates: [], researcher: installed.role }));
    await run(main.adapter, memory, { prepared: prepared({ noLimits: true }) }).text();
    expect(child.requests).toHaveLength(READS + 1);
    expectShed(child.requests);
    // The main agent's own context is no researcher's: nothing of it is cleared.
    expect(main.requests.flatMap((request) => request.history ?? []).some((item) => item.type === "tool_result" && cleared(item.output))).toBe(false);
    expect(memory.published()).toBe(REPORT);
  });
});

/** A turn of a new installation: scoping and the plan take rounds of their own. */
const FREE: Partial<NativeRunExecutionInput> = { prepared: prepared({ noLimits: true }) };

describe("the plan window through the real engine", () => {
  const research = { arguments: { message: "Cover the first question.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME };
  const researcherDone = { text: "Outcome: done\nclaim; link; quote; independent_tests; confirmed" };
  const planActivity = (seen: readonly ModelRunSseEvent[]) => seen.flatMap((event) => event.type === "artifact" && event.data.artifactType === "workspace_activity" ?
    [event.data.payload as ThreadWorkspaceActivityEntry] : []).filter((entry) => entry.kind === "plan");
  const store = (): ResearchPlanStore => ({ chatOpen: vi.fn(async () => true), closed: vi.fn(async () => undefined), held: vi.fn(async () => undefined), opened: vi.fn(async () => null),
    read: vi.fn(async () => null), rebuilt: vi.fn(async () => undefined) });

  /** The real window, with a store that keeps nothing, and the route over the same windows. */
  function windowed(ports: ResearchEngineDeps["ports"] = {}) {
    const windows = new ResearchPlanWindows();
    const rows = store();
    const deps: ResearchEngineDeps = { gates: [], ports: { ...ports, planWindow: (run) => createResearchPlanWindow(run, { store: rows, windows }) } };
    const handlers = createResearchPlanHandlers({ resolveAuth: (async () => ({ id: "s", user: { status: "active" }, userId: "user" })) as never, store: rows, windows });
    const post = (body: unknown) => handlers.act(new Request("http://app/api/chats/chat/research/plan", { body: JSON.stringify({ runId: "run-1", ...body as object }), method: "POST" }), { params: { chatId: "chat" } });
    return { deps, handlers, post, rows, windows };
  }

  /** Runs under a fake clock until the window is open, and hands the test the turn to finish. */
  async function inWindow(steps: readonly Step[], extra: Partial<NativeRunExecutionInput> = FREE, repo = repository(), ports: ResearchEngineDeps["ports"] = {}) {
    const main = scripted(steps);
    const real = windowed(ports);
    const memory = engineOf(real.deps);
    const finished = events(run(main.adapter, memory, extra, repo));
    await vi.waitFor(() => expect(real.windows.find({ chatId: "chat", runId: "run-1", userId: "user" })).not.toBeNull());
    return { ...real, finished, main, memory, repo };
  }

  const standing = [{ calls: [start()] }, { calls: [propose()] }, { calls: [research] }, researcherDone, { calls: [submit()] }] satisfies readonly Step[];

  it("with nobody present research starts at 60 seconds: start, propose, the window, then researchers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const open = await inWindow(standing);
      expect(open.main.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow - 1_000);
      expect(open.main.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_500);
      const seen = await open.finished;
      expect(open.memory.published()).toBe(REPORT);
      expect(open.main.requests).toHaveLength(5);
      const result = JSON.parse(resultsOf(open.main.requests[2], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]!) as Record<string, unknown>;
      expect(result).toMatchObject({ changed: false, released_by: "timer", status: "released" });
      expect(result.method).toContain("call_subagent");
      expect(open.rows.closed).toHaveBeenCalledOnce();
      // The line at once, the card as the window opens, and the ordinary plan after it.
      const plans = planActivity(seen);
      expect(plans[0]).toMatchObject({ items: [{ text: "Making a plan before research starts" }], researchPlan: { runId: "run-1", state: "scoping" } });
      expect(plans[1]).toMatchObject({ researchPlan: { runId: "run-1", state: "window" } });
      expect(plans[1]!.items?.map((item) => item.text)).toEqual(proposalArguments(PLAN).steps);
      expect(plans.at(-1)!.researchPlan).toBeUndefined();
      expect(plans.at(-1)!.items?.[0]?.text).toBe("Which mattress holds up?");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing the model writes while it scopes, refuses researchers before the plan, and owes no draft", async () => {
    const main = scripted([{ calls: [start()], text: "Starting." }, { calls: [research], text: "SCOPING NARRATION" }, { calls: [submit()] }, { calls: [propose()] }, { calls: [submit("call-2", { ...DRAFT, report: "Second." })] }]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(main.adapter, memory, FREE));
    expect(tokens(seen).join("")).not.toContain("SCOPING NARRATION");
    expect(resultsOf(main.requests[2], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("researchers start after the plan");
    expect(resultsOf(main.requests[3], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("the plan comes first");
    expect(memory.threads.admitForeground).not.toHaveBeenCalled();
    expect(memory.published()).toBe("Second.");
  });

  it("starts at once on the button", async () => {
    const open = await inWindow(standing);
    const response = await open.post({ action: "start" });
    expect(await response.json()).toMatchObject({ outcome: "applied", view: { answer: { changed: false, releasedBy: "start_button" } } });
    await open.finished;
    expect(open.memory.published()).toBe(REPORT);
    expect(open.main.requests).toHaveLength(5);
  });

  it("makes researchers wait for questions rebuilt from a saved edit, with the user's words kept whatever the model sends", async () => {
    const saved = { assumptions: [], steps: ["Только тесты"], understood: "Матрас на дачу." };
    const rebuilt = proposeCall({ questions: [{ question: "Что говорят тесты?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }] }, "call-rebuilt");
    const open = await inWindow([{ calls: [start()] }, { calls: [propose()] }, { calls: [{ ...research, id: "call-early" }] },
      { calls: [{ ...rebuilt, arguments: { ...rebuilt.arguments, steps: ["The model's own steps"], understood: "The model's own words." } }] },
      { calls: [research] }, researcherDone, { calls: [submit()] }]);
    const response = await open.post({ action: "save", plan: saved });
    expect(await response.json()).toMatchObject({ outcome: "applied", view: { answer: { changed: true, releasedBy: "saved_edit" } } });
    const seen = await open.finished;
    const result = JSON.parse(resultsOf(open.main.requests[2], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]!) as Record<string, unknown>;
    expect(result).toMatchObject({ changed: true, released_by: "saved_edit", status: "released", user_plan: saved });
    expect(result.instructions).toContain("user's own words");
    expect(result).not.toHaveProperty("method");
    expect(resultsOf(open.main.requests[3], CALL_SUBAGENT_TOOL_NAME)[0]).toContain("your questions must follow");
    expect(JSON.parse(resultsOf(open.main.requests[4], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[1]!)).toMatchObject({ status: "rebuilt", user_plan: saved });
    // The brief the researcher got names the rebuilt question, and the row keeps the user's words with it.
    const brief = JSON.stringify(open.main.requests[5]!.history?.at(-1));
    expect(brief).toContain("Что говорят тесты?");
    expect(brief).not.toContain("Which mattress holds up?");
    expect(open.rows.rebuilt).toHaveBeenCalledOnce();
    expect(vi.mocked(open.rows.rebuilt).mock.calls[0]![1].answer.plan).toMatchObject({ steps: saved.steps, understood: saved.understood });
    expect(planActivity(seen).at(-1)!.items?.[0]?.text).toBe("Что говорят тесты?");
    expect(open.memory.published()).toBe(REPORT);
  });

  /**
   * The run's event store as `appendRunOutputEvents` keeps activity: an update id is one update, so the same id with other facts is
   * refused. The engine then logs it and sends the unsaved row with no sequence, which the merge reads as older.
   */
  function activityStore() {
    const saved: ThreadWorkspaceActivityEntry[] = [];
    const prints = new Map<string, string>();
    const appendRunOutputEvent = vi.fn(async (_runId: string, event: { data: { artifactType: string; payload: ThreadWorkspaceActivityEntry } }) => {
      if (event.data.artifactType !== "workspace_activity") return event;
      const entry = event.data.payload;
      const print = workspaceActivityFingerprint(entry);
      if (prints.has(entry.updateId!) && prints.get(entry.updateId!) !== print) throw new Error("workspace_activity_replay_invalid");
      prints.set(entry.updateId!, print);
      const kept = { ...entry, sequence: saved.length };
      saved.push(kept);
      return { ...event, data: { ...event.data, payload: kept } };
    });
    return { appendRunOutputEvent, saved };
  }

  const shownPlan = (entries: readonly ThreadWorkspaceActivityEntry[]) => mergeWorkspaceActivity(null, { entries })?.entries.find((entry) => entry.kind === "plan");

  /** The plan rows on both ways a person reads them: live, and from what a reload folds. */
  function expectPlanRows(seen: readonly ModelRunSseEvent[], store: ReturnType<typeof activityStore>) {
    const live = planActivity(seen);
    expect(new Set(live.map((entry) => entry.updateId)).size).toBe(live.length);
    expect(live.every((entry) => entry.sequence !== undefined)).toBe(true);
    expect(store.saved.filter((entry) => entry.kind === "plan")).toHaveLength(live.length);
    for (const entries of [live, store.saved]) expect(shownPlan(entries)).not.toHaveProperty("researchPlan");
    return live;
  }

  it.each([
    ["the timer", "timer"],
    ["the button", "start_button"],
    ["a chat message", "chat_message"]
  ] as const)("replaces the card with the plan that stands when %s closes the window, as an update of its own", async (_name, releasedBy) => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const store = activityStore();
      let written: "accepted" | "delivered" | null = null;
      const followups = { close: vi.fn(async () => true), deliver: vi.fn(async () => { written = "delivered"; return true; }),
        load: vi.fn(async () => ({ entries: written ? [{ delivery: written, id: "f1", origin: "user" as const, text: "Бюджет до 40 тысяч." }] : [], revision: 1 })) };
      const open = await inWindow(standing, { prepared: { ...prepared({ noLimits: true }), followupAdmission: {} as never } },
        { ...repository(), appendRunOutputEvent: store.appendRunOutputEvent, followups } as never);
      if (releasedBy === "start_button") await open.post({ action: "start" });
      if (releasedBy === "chat_message") {
        await vi.advanceTimersByTimeAsync(2_500);
        written = "accepted";
        await vi.advanceTimersByTimeAsync(2_500);
      }
      if (releasedBy === "timer") await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow + 500);
      const seen = await open.finished;
      expect(JSON.parse(resultsOf(open.main.requests[2], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]!)).toMatchObject({ released_by: releasedBy });
      const [scoping, window, stands, ...rest] = expectPlanRows(seen, store);
      expect(rest).toEqual([]);
      expect(scoping).toMatchObject({ researchPlan: { state: "scoping" } });
      expect(window).toMatchObject({ researchPlan: { state: "window" } });
      expect(stands).not.toHaveProperty("researchPlan");
      expect(stands!.items?.[0]?.text).toBe("Which mattress holds up?");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the user's words and the rebuilt plan an update each after a saved edit", async () => {
    const store = activityStore();
    const rebuilt = proposeCall({ questions: [{ question: "Что говорят тесты?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }] }, "call-rebuilt");
    const open = await inWindow([{ calls: [start()] }, { calls: [propose()] }, { calls: [rebuilt] }, { calls: [research] }, researcherDone, { calls: [submit()] }], FREE,
      { ...repository(), appendRunOutputEvent: store.appendRunOutputEvent } as never);
    await open.post({ action: "save", plan: { assumptions: [], steps: ["Только тесты"], understood: "Матрас на дачу." } });
    const rows = expectPlanRows(await open.finished, store);
    expect(rows.map((entry) => entry.items?.[0]?.text)).toEqual(["Making a plan before research starts", proposalArguments(PLAN).steps[0], "Только тесты", "Что говорят тесты?"]);
    expect(rows.map((entry) => entry.researchPlan?.state)).toEqual(["scoping", "window", undefined, undefined]);
  });

  it("takes a chat message as an edit: the window closes and the words still reach the model as a follow-up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      let written: "accepted" | "delivered" | null = null;
      const followups = { close: vi.fn(async () => true), deliver: vi.fn(async () => { written = "delivered"; return true; }),
        load: vi.fn(async () => ({ entries: written ? [{ delivery: written, id: "f1", origin: "user" as const, text: "Бюджет до 40 тысяч." }] : [], revision: 1 })) };
      const open = await inWindow(standing, { prepared: { ...prepared({ noLimits: true }), followupAdmission: {} as never } }, { ...repository(), followups } as never);
      await vi.advanceTimersByTimeAsync(2_500);
      written = "accepted";
      await vi.advanceTimersByTimeAsync(2_500);
      await open.finished;
      const result = JSON.parse(resultsOf(open.main.requests[2], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]!) as Record<string, unknown>;
      expect(result).toMatchObject({ changed: false, released_by: "chat_message", status: "released" });
      expect(result.instructions).toContain("counts as their edit");
      expect(JSON.stringify(open.main.requests[2]!.history)).toContain("Бюджет до 40 тысяч.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Stop in the window ends the run with nothing released: the row keeps no answer", async () => {
    const runId = "run-1";
    const open = await inWindow(standing);
    activeRunControllerRegistry.abort(runId);
    const seen = await open.finished;
    expect(seen.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(open.rows.closed).not.toHaveBeenCalled();
    expect(open.windows.find({ chatId: "chat", runId, userId: "user" })).toBeNull();
    expect(open.main.requests).toHaveLength(2);
  });

  it("releases an edit before the turn's deadline, so research starts on the extended turn and the answer arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const startedAt = Date.now();
      const repo = repository();
      const open = await inWindow(standing, FREE, repo, { time: createResearchClock });
      // Research came late in a long turn: a minute and a half before it ends.
      vi.setSystemTime(startedAt + 60 * 60_000 - 90_000);
      await open.post({ action: "hold" });
      const view = await (await open.handlers.read(new Request("http://app/x?runId=run-1"), { params: { chatId: "chat" } })).json() as { heldUntil: string };
      expect(Date.parse(view.heldUntil)).toBe(startedAt + 60 * 60_000 - RESEARCH_PLAN_WINDOW_LIMITS.releaseReserveMs);
      await vi.advanceTimersByTimeAsync(31_000);
      await open.finished;
      expect(open.rows.closed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ answer: expect.objectContaining({ releasedBy: "abandoned_edit" }) }));
      expect(open.memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "lab" }));
      expect(open.memory.published()).toBe(REPORT);
      expect(repo.failRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a proposal naming the field, and the model's corrected one opens the window", async () => {
    const { steps: _steps, ...bad } = proposalArguments(PLAN);
    void _steps;
    const main = scripted([{ calls: [start()] }, { calls: [{ arguments: bad, id: "call-bad", name: PROPOSE_RESEARCH_PLAN_TOOL_NAME }] }, { calls: [propose()] }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [] });
    await run(main.adapter, memory, FREE).text();
    expect(resultsOf(main.requests[2], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]).toContain("steps must list");
    expect(memory.published()).toBe(REPORT);
  });

  it("refuses a plan before research started, and an ordinary answer goes on", async () => {
    const main = scripted([{ calls: [propose()] }, { text: "Plain answer." }]);
    const memory = engineOf({});
    await run(main.adapter, memory, FREE).text();
    expect(resultsOf(main.requests[1], PROPOSE_RESEARCH_PLAN_TOOL_NAME)[0]).toContain("research_not_started");
    expect(memory.published()).toBe("Plain answer.");
  });

  it("rides on every request of a run that offers research, and not where research is off", async () => {
    const offered = async (extra: Partial<NativeRunExecutionInput>) => {
      const { adapter, requests } = scripted([{ text: "Answer." }]);
      await run(adapter, engineOf({}), extra).text();
      return requests[0]!.tools?.map((tool) => tool.name).includes(PROPOSE_RESEARCH_PLAN_TOOL_NAME);
    };
    expect(await offered({})).toBe(true);
    expect(await offered({ telegram: true })).toBe(false);
    expect(await offered({ scheduled: true })).toBe(false);
  });
});

describe("a model that never proposes", () => {
  const fetchCall = (id: string) => ({ arguments: { plan: [{ status: "pending", step: id }] }, id, name: "update_plan" });
  const unknownNote = (text: string) => researchNote("not_submitted");

  it("is sent back once for a final message, and its plan then goes on as usual", async () => {
    const main = scripted([{ calls: [start()] }, { text: "A question for you?" }, { calls: [propose()] }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(main.adapter, memory, FREE));
    expect(JSON.stringify(main.requests[2]!.history)).toContain(`Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME}`);
    expect(tokens(seen).join("")).not.toContain("A question for you?");
    expect(memory.published()).toBe(REPORT);
  });

  it("ends with its text and a note on a second final message, so the answer is not lost and nothing hangs", async () => {
    const main = scripted([{ calls: [start()] }, { text: "Первый ответ." }, { text: "Ответ без плана." }]);
    const memory = engineOf({ gates: [] });
    await run(main.adapter, memory, FREE).text();
    expect(main.requests).toHaveLength(3);
    expect(memory.published()).toBe(`Ответ без плана.\n\n---\n\n*${unknownNote("Ответ")}*`);
    expect(memory.runs.complete).toHaveBeenCalledOnce();
  });

  it("past scoping's limit gets only the plan's call: every other new call is refused with what to do, and the plan still works", async () => {
    let clock = 1_000_000;
    const main = scripted([
      { calls: [start()] },
      { calls: [fetchCall("call-in-time")], onCall: () => { clock += RESEARCH_TIME_MS.scoping + 1; } },
      { calls: [fetchCall("call-late")] },
      { calls: [propose()] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "after" }] }, id: "call-after", name: "update_plan" }] },
      { calls: [submit()] }
    ]);
    const memory = engineOf({ gates: [] }, { now: () => clock });
    await run(main.adapter, memory, FREE).text();
    const updates = resultsOf(main.requests[3], "update_plan");
    expect(updates[0]).toContain("time for scoping is up");
    expect(updates[0]).toContain(`Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} now with what you have`);
    // The tool list stays what it was: nothing is taken off the request.
    expect(main.requests[3]!.tools?.map((tool) => tool.name)).toEqual(main.requests[0]!.tools?.map((tool) => tool.name));
    expect(resultsOf(main.requests[5], "update_plan").at(-1)).not.toContain("time for scoping is up");
    expect(memory.published()).toBe(REPORT);
  });

  it("past scoping's limit lets a call already running finish", async () => {
    let clock = 1_000_000;
    const main = scripted([{ calls: [start()] }, { calls: [fetchCall("call-running")] }, { calls: [propose()] }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [] }, { now: () => clock });
    const recording = vi.mocked(memory.toolCalls.begin);
    const original = recording.getMockImplementation()! as (input: Parameters<typeof memory.toolCalls.begin>[0]) => ReturnType<typeof memory.toolCalls.begin>;
    // The limit passes after the call was let through, while it is being sent.
    recording.mockImplementation(async (input) => {
      if (input.toolName === "update_plan") clock += RESEARCH_TIME_MS.scoping + 1;
      return original(input);
    });
    await run(main.adapter, memory, FREE).text();
    expect(resultsOf(main.requests[2], "update_plan")[0]).not.toContain("time for scoping is up");
    expect(memory.published()).toBe(REPORT);
  });

  it("past scoping's limit ends in its text with the note when it keeps ignoring the refusal: no hang, the answer is not lost", async () => {
    let clock = 1_000_000;
    const ignores = (id: string): Step => ({ calls: [fetchCall(id)], onCall: () => { clock += RESEARCH_TIME_MS.scoping + 1; } });
    const main = scripted([{ calls: [start()] }, ignores("call-0"), ignores("call-1"), ignores("call-2"), { text: "Что удалось найти." }]);
    const memory = engineOf({ gates: [] }, { now: () => clock });
    await run(main.adapter, memory, FREE).text();
    expect(main.requests.length).toBeLessThanOrEqual(6);
    expect(memory.published()).toBe(`Что удалось найти.\n\n---\n\n*${unknownNote("Что")}*`);
    expect(memory.runs.complete).toHaveBeenCalledOnce();
  });

  it("past scoping's limit fails visibly, never hanging, when it wrote nothing at all", async () => {
    let clock = 1_000_000;
    const main = scripted([{ calls: [start()] }, { calls: [fetchCall("call-0")], onCall: () => { clock += RESEARCH_TIME_MS.scoping + 1; } }, { calls: [fetchCall("call-1")] },
      { calls: [fetchCall("call-2")] }, { calls: [fetchCall("call-3")] }, { calls: [fetchCall("call-4")] }, { calls: [fetchCall("call-5")] }]);
    const memory = engineOf({ gates: [] }, { now: () => clock });
    const repo = repository();
    await run(main.adapter, memory, FREE, repo).text();
    expect(main.requests.length).toBeLessThanOrEqual(8);
    expect(repo.failRun).toHaveBeenCalledWith("run-1", "answer-1", expect.objectContaining({ code: "model_answer_empty" }), expect.anything());
  });

  it("keeps a run with no research, and a run past its plan, on the registry's own answers", async () => {
    let clock = 1_000_000;
    const plain = scripted([{ calls: [fetchCall("call-a")], onCall: () => { clock += RESEARCH_TIME_MS.scoping + 1; } }, { calls: [fetchCall("call-b")] }, { text: "Plain answer." }]);
    const memory = engineOf({}, { now: () => clock });
    await run(plain.adapter, memory, FREE).text();
    expect(resultsOf(plain.requests[2], "update_plan").join()).not.toContain("scoping");
    expect(memory.published()).toBe("Plain answer.");

    clock = 1_000_000;
    const past = scripted([{ calls: begin() }, { calls: [fetchCall("call-a")], onCall: () => { clock += RESEARCH_TIME_MS.scoping + 1; } }, { calls: [submit()] }]);
    const after = engineOf({ gates: [] }, { now: () => clock });
    await run(past.adapter, after, FREE).text();
    expect(resultsOf(past.requests[2], "update_plan").join()).not.toContain("scoping");
    expect(after.published()).toBe(REPORT);
  });
});

describe("an approval continuation finds its plan", () => {
  const started = (runId: string, callId = "s"): TranscriptItem[] => [
    { arguments: JSON.stringify({ goal: PLAN.goal }), callId, id: `${callId}-call`, kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
    { callId, id: `${callId}-result`, kind: "tool_result", name: START_RESEARCH_TOOL_NAME, outcome: "complete", output: JSON.stringify({ research_run: runId, status: "scoping", instructions: "Scope." }) }
  ];
  const planned = (output: string, callId = "p", args: unknown = proposalArguments(PLAN)): TranscriptItem[] => [
    { arguments: JSON.stringify(args), callId, id: `${callId}-call`, kind: "tool_call", name: PROPOSE_RESEARCH_PLAN_TOOL_NAME },
    { callId, id: `${callId}-result`, kind: "tool_result", name: PROPOSE_RESEARCH_PLAN_TOOL_NAME, outcome: "complete", output }
  ];
  const answerOf = (fields: Readonly<Record<string, unknown>>) => JSON.stringify({ status: "released", changed: false, released_by: "timer",
    user_plan: { assumptions: [], steps: ["One step"], understood: "Understood." }, instructions: "Go on.", method: "How.", ...fields });

  it("reads the final plan from the plan call its window answered", () => {
    expect(researchOfTurn([...started("run-0"), ...planned(answerOf({}))])).toMatchObject({ goal: PLAN.goal, plan: { goal: PLAN.goal, questions: [{ question: "Which mattress holds up?" }, expect.anything()] }, researchRun: "run-0" });
  });

  it("recovers it from a stored excerpt: the result of a long plan is cut in its middle", () => {
    const output = answerOf({ method: "x".repeat(60_000) });
    const excerpt = toolOutputExcerpt(output, { handle: "tor1_saved" });
    expect(excerpt.truncated).toBe(true);
    const found = researchOfTurn([...started("run-0"), ...planned(excerpt.output)]);
    expect(found.plan?.questions).toHaveLength(2);
    expect(found.owedRebuild).toBeUndefined();
    const changed = researchOfTurn([...started("run-0"), ...planned(toolOutputExcerpt(answerOf({ changed: true, method: "x".repeat(60_000), released_by: "saved_edit" }), { handle: "tor1_saved" }).output)]);
    expect(changed.owedRebuild).toEqual({ changed: true, releasedBy: "saved_edit", words: { assumptions: [], steps: ["One step"], understood: "Understood." } });
  });

  it("keeps the questions even when the excerpt cut the user's words themselves", () => {
    const cut = answerOf({ changed: true, user_plan: { assumptions: [], steps: ["One step"], understood: "\\".repeat(30_000) } });
    const found = researchOfTurn([...started("run-0"), ...planned(toolOutputExcerpt(cut, { handle: "tor1_saved" }).output)]);
    expect(found.plan?.questions).toHaveLength(2);
    expect(found.owedRebuild).toMatchObject({ changed: true, words: null });
  });

  it("takes the rebuilt questions over the first ones, and owes nothing then", () => {
    const rebuiltArgs = proposalArguments({ questions: [{ question: "Rebuilt?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }] });
    const found = researchOfTurn([...started("run-0"), ...planned(answerOf({ changed: true })), ...planned(answerOf({ changed: true, status: "rebuilt" }), "p2", rebuiltArgs)]);
    expect(found.plan?.questions.map((entry) => entry.question)).toEqual(["Rebuilt?"]);
    expect(found.owedRebuild).toBeUndefined();
  });

  it("takes no plan from a call the window never answered, and a run still scoping keeps its goal", () => {
    const refused: TranscriptItem[] = [...planned("{}")];
    expect(researchOfTurn([...started("run-0"), ...refused])).toMatchObject({ goal: PLAN.goal, plan: null, researchRun: "run-0" });
    expect(researchOfTurn(started("run-0"))).toMatchObject({ goal: PLAN.goal, plan: null });
  });

  it("does not read a plan out of a start that scoped, whatever arguments the model sent it", () => {
    const whole: TranscriptItem[] = [{ arguments: JSON.stringify(PLAN), callId: "s", id: "c", kind: "tool_call", name: START_RESEARCH_TOOL_NAME }, started("run-0")[1]!];
    expect(researchOfTurn(whole)).toMatchObject({ goal: PLAN.goal, plan: null });
  });

  it("keeps reading an older stored start that holds the whole plan", () => {
    const older: TranscriptItem[] = [{ arguments: JSON.stringify(PLAN), callId: "s", id: "c", kind: "tool_call", name: START_RESEARCH_TOOL_NAME },
      { callId: "s", id: "r", kind: "tool_result", name: START_RESEARCH_TOOL_NAME, outcome: "complete", output: JSON.stringify({ research_run: "run-0", method: "How.", status: "started" }) }];
    expect(researchOfTurn(older)).toMatchObject({ goal: PLAN.goal, plan: { questions: [expect.anything(), expect.anything()] }, researchRun: "run-0" });
  });
});
