import { afterEach, describe, expect, it, vi } from "vitest";
import { START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME, type ResearchDraft } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME, SUBAGENT_ERROR_CODES } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { FakeSubagentBackgroundControl } from "../../../tests/support/subagentPorts";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { SubagentModelRoute } from "../engine/subagents/modelRoutes";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { NativeRunStore } from "../engine/runStore";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { runResearchGates, type ResearchGate, type ResearchGateContext } from "./gates";
import { researchNote } from "./notes";
import { researchOfTurn, type ResearchEngineDeps } from "./run";
import { researchModelIdentity } from "./turns";
import type { ResearchVerifierRole } from "./verifierRole";

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
const start = (id = "call-start") => ({ arguments: PLAN, id, name: START_RESEARCH_TOOL_NAME });
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

function prepared(options: Readonly<{ noSearch?: boolean }> = {}): MaterializedPreparedRunData {
  const text = "Проведи исследование матрасов.";
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    // A hosted source: Search is available and no client route is built.
    searchPlan: { mode: "all_selected" as const, options: options.noSearch ? [] : [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
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
    const { adapter, requests } = scripted([{ calls: [start()] }, { text: "Answered directly." }]);
    const memory = engineOf({});
    await run(adapter, memory, { telegram: true }).text();
    expect(memory.published()).toBe("Answered directly.");
    expect(memory.toolCalls.begin).not.toHaveBeenCalled();
    expect(resultsOf(requests[1], START_RESEARCH_TOOL_NAME).join()).toContain("does not exist");
  });

  it("names the plan as the answer's progress, and refuses a plan that drops a source class without a reason", async () => {
    const { adapter, requests } = scripted([
      { calls: [{ arguments: { ...PLAN, questions: [PLAN.questions[0]] }, id: "call-bad", name: START_RESEARCH_TOOL_NAME }] },
      { calls: [start()] },
      { calls: [submit()] }
    ]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(adapter, memory));
    expect(resultsOf(requests[1], START_RESEARCH_TOOL_NAME)[0]).toContain("owner_reviews");
    const plans = seen.flatMap((event) => event.type === "artifact" && event.data.artifactType === "workspace_activity" ? [event.data.payload] : []) as unknown as { items?: { text: string }[]; kind: string }[];
    expect(plans.find((entry) => entry.kind === "plan")?.items?.map((item) => item.text)).toEqual(["Which mattress holds up?", "What do owners and shops say?"]);
    expect(memory.published()).toBe(REPORT);
  });

  it("gives every researcher the method and its source classes, whatever the main agent's brief says", async () => {
    const { adapter, requests } = scripted([
      { calls: [start()] },
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
    expect(brief).toContain("browser_handoff");
    expect(memory.published()).toBe(REPORT);
  });
});

describe("Stop ends all research", () => {
  it("runs a researcher in the foreground even when the model asks for the background, since Stop spares background sub-agents", async () => {
    const { adapter } = scripted([
      { calls: [start()] },
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
      { calls: [start()], text: "Starting the research." },
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

  it("refuses a draft before research started, and an ordinary answer goes on as one", async () => {
    const { adapter, requests } = scripted([{ calls: [submit()] }, { text: "Plain answer." }]);
    const memory = engineOf({});
    const seen = await events(run(adapter, memory));
    expect(resultsOf(requests[1], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("research_not_started");
    expect(memory.published()).toBe("Plain answer.");
    expect(tokens(seen)).toEqual(["Plain answer."]);
  });

  it("asks once for the call when the model writes its report as a message, and never shows that text meanwhile", async () => {
    const { adapter, requests } = scripted([{ calls: [start()] }, { text: "SECRET REPORT AS TEXT" }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [] });
    const seen = await events(run(adapter, memory));
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.history)).toContain(`Call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME}`);
    expect(tokens(seen).join("")).not.toContain("SECRET REPORT");
    expect(memory.published()).toBe(REPORT);
  });

  it("takes the text itself through the gates when the model writes a message again, and the answer says it has no findings", async () => {
    const drafts: ResearchDraft[] = [];
    const { adapter, requests } = scripted([{ calls: [start()] }, { text: "Отчёт текстом." }, { text: "Отчёт текстом, ещё раз." }]);
    const memory = engineOf({ gates: [gate("spy", async (draft) => { drafts.push(draft); return { kind: "pass" }; })] });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(3);
    expect(drafts).toEqual([expect.objectContaining({ findings: [], origin: "plain_text", report: "Отчёт текстом, ещё раз." })]);
    expect(memory.published()).toContain("Отчёт текстом, ещё раз.");
    expect(memory.published()).toContain(researchNote("no_findings", "Отчёт"));
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
      { calls: [start()] },
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
      { calls: [start()] },
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
      { calls: [start()] },
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
      { calls: [start()] },
      { calls: [submit()] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { text: "I would still like to look further." }
    ]);
    const memory = engineOf({ gates: [passes] }, { now: () => clock });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(4);
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("time_out", REPORT)}*`);
  });

  it("past the tool time with no draft at all, the reserved round's message is the draft, and a round that is not asked for is not paid", async () => {
    let clock = 0;
    const { adapter, requests } = scripted([
      { calls: [start()] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-late", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { text: "Whatever I have." }
    ]);
    const memory = engineOf({}, { now: () => clock });
    await run(adapter, memory).text();
    expect(requests).toHaveLength(3);
    expect(requests[2]!.history?.at(-1)).toMatchObject({ text: expect.stringContaining(SUBMIT_RESEARCH_DRAFT_TOOL_NAME), type: "user" });
    expect(memory.published()).toContain("Whatever I have.");
    expect(memory.published()).toContain(researchNote("no_findings", "Whatever I have."));
  });

  it("does not spend a round on a draft that the repeat guard blocks: the standing draft goes out with a note", async () => {
    const stubborn = gate("gap", async () => ({ kind: "send_back", message: "Still open." }));
    const { adapter, requests } = scripted([{ calls: [start()] }, { calls: [submit("call-1")] }, { calls: [submit("call-2")] }, { calls: [submit("call-3")] }, { calls: [submit("call-4")] }]);
    const memory = engineOf({ gates: [stubborn] });
    await run(adapter, memory).text();
    expect(requests.length).toBeLessThanOrEqual(5);
    expect(memory.published()).toContain(REPORT);
    expect(memory.published()).toContain(researchNote("unresolved", REPORT));
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
      { calls: [start()], text: "MAIN AGENT REASONING" },
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { text: "Outcome: done\nchecked" }]);
    await run(main.adapter, engineOf({ gates: [reader] })).text();
    expect(seen[0]).toEqual({ kind: "main_model", label: "fake-qsa" });
    expect(seen[1]).toMatchObject({ kind: "ended", result: { model: { id: "fake-qsa" } } });

    seen.length = 0;
    const second = scripted([{ calls: [start()] }, { calls: [submit()] }]);
    const gone: ResearchVerifierRole = { frozenChoice: async () => ({ effort: null, kind: "set", providerModelId: "gone" }), route: async () => null };
    await run(second.adapter, engineOf({ gates: [reader], verifier: gone })).text();
    expect(seen).toEqual([{ kind: "unavailable" }, { code: "research_verifier_unavailable", kind: "refused" }]);
  });

  it("gives each gate's turn on one draft a call of its own, since a call has one turn in the database", async () => {
    const turnOf = (name: string) => gate(name, async (_draft, context) => {
      await context.subagents.run({ brief: `brief ${name}`, instructions: "i", model: "main", name, tools: [] }, context.signal);
      return { kind: "pass" };
    });
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { text: "Outcome: done\nfirst" }, { text: "Outcome: done\nsecond" }]);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [quoteCheck] }, { threadEffects: [{ items: threadItems, threadId: "thread-1" }] })).text();
    expect(opened).toEqual([{ partial: false, text: "whole page: held up after 10 years", toolName: "fetch_url", url: "https://lab.example/x1" }]);
  });

  it("sends the main agent back to correct once, and its corrected report is what the user reads", async () => {
    const correctOnce = gate("verifier", async (draft, context) => context.attempt === 1
      ? { kind: "send_back", message: "Claim 1 is unsupported: remove or mark it." } : { kind: "pass", notes: [`Checked ${draft.findings.length} claim.`] });
    const main = scripted([
      { calls: [start()] },
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
    const memory = engineOf({ gates: [gate("broken", async () => { throw new Error("verifier down"); }), gate("after", after)] });
    await run(main.adapter, memory).text();
    expect(after).toHaveBeenCalledTimes(1);
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("gate_failed", REPORT)}*`);
  });

  it("delivers the answer with a visible note when a gate outlasts its time, ignoring its signal or not", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      let aborted = false;
      const hung = gate("hung", (_draft, context) => new Promise(() => {
        context.signal.addEventListener("abort", () => { aborted = true; });
      }));
      const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
      const memory = engineOf({ gates: [hung] });
      const finished = run(main.adapter, memory).text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 60_000 + 1_000);
      await finished;
      expect(aborted).toBe(true);
      expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("time_out", REPORT)}*`);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
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
      const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
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
      const shown = `${REPORT}\n\n---\n\n*${researchNote("run_failed", REPORT)}*`;
      expect(tokens(seen).at(-1)).toBe(shown);
      expect(repo.failRun).toHaveBeenCalledTimes(1);
      expect(lastSaved(repo)).toBe(shown);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a researcher beside a slow start_research in the method: foreground, with the brief, whatever order they record in", async () => {
    const background = new FakeSubagentBackgroundControl();
    const main = scripted([
      { calls: [start(), { arguments: { background: true, message: "Cover it.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nreport" },
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
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "lab" }));
    expect(JSON.stringify(main.requests[1]!.history)).toContain("# Research method (from the server)");
    expect(memory.published()).toBe(REPORT);
  });

  it("does not start research for a start the batch refused, and what follows is an ordinary answer", async () => {
    let clock = 0;
    const main = scripted([{ calls: [start()], onCall: () => { clock = 55 * 60_000; } }, { text: "Answered without research." }]);
    const memory = engineOf({}, { now: () => clock });
    const seen = await events(run(main.adapter, memory));
    expect(tokens(seen)).toEqual(["Answered without research."]);
    expect(memory.published()).toBe("Answered without research.");
  });

  it("keeps the last attempt's withheld text with a note when the provider fails for good", async () => {
    const main = scripted([{ calls: [start()] }, { fail: true, text: "# Partial report" }]);
    const memory = engineOf({});
    const repo = repository();
    const seen = await events(run(main.adapter, memory, {}, repo));
    const shown = `# Partial report\n\n---\n\n*${researchNote("incomplete", "report")}*`;
    expect(tokens(seen).at(-1)).toBe(shown);
    expect(lastSaved(repo)).toBe(shown);
    expect(repo.failRun).toHaveBeenCalledTimes(1);
    expect(memory.published()).toBeNull();
  });

  it("keeps the last attempt's withheld text with a note at the turn's deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: [start()] }, { hang: true, text: "# Hanging report" }]);
      const repo = repository();
      const finished = run(main.adapter, engineOf({}), {}, repo).text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      await finished;
      expect(lastSaved(repo)).toBe(`# Hanging report\n\n---\n\n*${researchNote("incomplete", "report")}*`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops what a retried attempt streamed, so only the last attempt's text is kept", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: [start()] }, { text: "DROPPED ATTEMPT" }, { fail: true, text: "Kept attempt" }]);
      const memory = engineOf({});
      let opened = 0;
      memory.deps = { ...memory.deps, faults: () => ({ take: (fault) => fault === "stream_drop_once" && ++opened === 2 }) };
      const repo = repository();
      const finished = run(main.adapter, memory, {}, repo).text();
      await vi.advanceTimersByTimeAsync(60_000);
      await finished;
      expect(main.requests).toHaveLength(3);
      expect(lastSaved(repo)).toBe(`Kept attempt\n\n---\n\n*${researchNote("incomplete", "report")}*`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a submitted report over later narration when the provider fails", async () => {
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { fail: true, text: "Let me look at one more thing and also go on writing for a good long while." }]);
    const memory = engineOf({ gates: [gate("gap", async () => ({ kind: "send_back", message: "Again." }))] });
    const repo = repository();
    await run(main.adapter, memory, {}, repo).text();
    expect(lastSaved(repo)).toBe(`${REPORT}\n\n---\n\n*${researchNote("run_failed", REPORT)}*`);
  });

  /** A report in the reserved round past the tool time, then a user correction delivered at its end. */
  function lateFollowup(after: readonly Step[]) {
    let clock = 0;
    const main = scripted([
      { calls: [start()] },
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
    expect(late.memory.published()).toBe(`${REPORT}\n\n---\n\n*${researchNote("followup_not_applied", REPORT)}*`);
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
      expect(lastSaved(late.repo)).toBe(`${REPORT}\n\n---\n\n*${researchNote("time_out", REPORT)}*\n\n*${researchNote("followup_not_applied", REPORT)}*`);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit("call-1")] }, { calls: [submit("call-2", { ...DRAFT, report: "second" })] }]);
    let attempts = 0;
    const memory = engineOf({ gates: [gate("either", async (draft, context) => {
      attempts += 1;
      return attempts === 1 ? firstDraft.run(draft, context) : hangs.run(draft, context);
    })] });
    await run(main.adapter, memory, { runId }, repository()).text();
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), `second\n\n---\n\n*${researchNote("stopped", "second")}*`);
  });

  it("a recording failure on the next draft shows it with the generic note, never the last draft's counts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: [start()] }, { calls: [submit("call-1")] }, { calls: [submit("call-2", { ...DRAFT, report: "second" })] }]);
      const memory = engineOf({ gates: [firstDraft] });
      vi.mocked(memory.deps.transcripts.append).mockImplementation(async (_scope, _from, items) => {
        if (items.some((item) => item.kind === "tool_call" && item.callId === "call-2")) throw new Error("database down");
        memory.appended.push(...items);
      });
      const repo = repository();
      const finished = run(main.adapter, memory, {}, repo).text();
      await vi.advanceTimersByTimeAsync(5_000);
      await finished;
      expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", `second\n\n---\n\n*${researchNote("run_failed", "second")}*`, { runId: "run-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the deadline past a replacement draft in the reserved round keeps that draft, without the last draft's counts", async () => {
    let clock = 0;
    const main = scripted([
      { calls: [start()] },
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
      { calls: [start()] },
      { calls: [submit("call-1")] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "x" }] }, id: "call-slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
      { text: "I would still like to look further." }
    ]);
    const memory = engineOf({ gates: [firstDraft] }, { now: () => clock });
    await run(main.adapter, memory).text();
    expect(memory.published()).toBe(`${REPORT}\n\n---\n\n*${counts(REPORT)}*\n\n*${researchNote("time_out", REPORT)}*`);
  });

  it("a gate that did not finish on a draft adds what it carries, and one that did adds only what it said", async () => {
    const carrying: ResearchGate = { carriedNotes: () => ["Carried."], name: "carrying", run: async () => ({ kind: "pass", notes: ["Its own."] }) };
    const sendsBack = gate("first", async () => ({ kind: "send_back", message: "Again." }));
    const context = { attempt: 1, earlier: [], plan: { goal: "g", questions: [], skipped: [] }, signal: new AbortController().signal,
      sources: { opened: async () => [] }, subagents: { run: async () => ({ code: "x", kind: "refused" as const }) },
      time: { remainingMs: () => 60_000, sendBackAllowed: () => true }, verifierModel: async () => ({ kind: "unavailable" as const }) };
    const draft = { findings: [], origin: "reserved_call" as const, report: "r", unreachable: [] };
    expect(await runResearchGates({ context, draft, gates: [sendsBack, carrying], runId: "r" })).toEqual({ kind: "sent_back", message: "Again.", notes: ["Carried."] });
    expect(await runResearchGates({ context, draft, gates: [carrying], runId: "r" })).toEqual({ kind: "accepted", notes: ["Its own."] });
    const broken: ResearchGate = { ...carrying, run: async () => { throw new Error("down"); } };
    expect(await runResearchGates({ context, draft, gates: [broken], runId: "r" })).toEqual({ kind: "accepted", notes: [researchNote("gate_failed", "r"), "Carried."] });
    const late = { ...context, time: { remainingMs: () => 0, sendBackAllowed: () => false } };
    expect(await runResearchGates({ context: late, draft, gates: [carrying], runId: "r" })).toEqual({ kind: "accepted", notes: [researchNote("time_out", "r"), "Carried."] });
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
      for (const [model, name] of [["main", "judge"], ["verifier", "verifier"]] as const) {
        seen.push(model);
        await context.subagents.run({ brief: `brief of ${name}`, instructions: "i", model, name, tools: [] }, context.signal);
      }
      return { kind: "pass" };
    });
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { text: "Outcome: done\njudge" }, { text: "Outcome: done\nverifier" }]);
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
      await context.subagents.run({ brief: "b", instructions: "i", model: "main", name: "judge", tools: [] }, context.signal);
      await context.subagents.run({ brief: "b", instructions: "i", model: "verifier", name: "verifier", tools: [] }, context.signal);
      waiting = false;
      return { kind: "pass" };
    });
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { text: "Outcome: done\njudge" }, { text: "Outcome: done\nverifier" }]);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { text: "Outcome: done\nok" }]);
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
      const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }]);
    await run(main.adapter, engineOf({ gates: [reader], verifier: roleOf(main.adapter, "other-1", "model-2") })).text();
    expect(model).toEqual({ kind: "role", label: "Same One · Same" });
  });

  it("does not hold a failure to resolve the role for the run: the next attempt asks again, and a refusal does hold", async () => {
    const outcomes: unknown[] = [];
    const reader = gate("verifier", async (_draft, context) => {
      await context.verifierModel(context.signal).then((value) => outcomes.push(value), () => outcomes.push("threw"));
      return context.attempt === 1 ? { kind: "send_back", message: "Again." } : { kind: "pass" };
    });
    const main = scripted([{ calls: [start()] }, { calls: [submit("call-1")] }, { calls: [submit("call-2")] }, { calls: [submit("call-3")] }]);
    const good = roleOf(main.adapter, "other-1", "model-2");
    const route = vi.mocked(good.route);
    const answer = await route.getMockImplementation()!({ effort: null, providerModelId: "model-2", runId: "r", userId: "u" });
    route.mockReset();
    route.mockRejectedValueOnce(new Error("database down")).mockResolvedValue(answer);
    await run(main.adapter, engineOf({ gates: [reader], verifier: good })).text();
    expect(outcomes).toEqual(["threw", { kind: "role", label: "Same One · Same" }]);

    const refusing = vi.fn(async () => null);
    const main2 = scripted([{ calls: [start()] }, { calls: [submit("call-1")] }, { calls: [submit("call-2")] }]);
    outcomes.length = 0;
    await run(main2.adapter, engineOf({ gates: [reader], verifier: { frozenChoice: good.frozenChoice, route: refusing } })).text();
    expect(outcomes).toEqual([{ kind: "unavailable" }, { kind: "unavailable" }]);
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
    const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { onCall: () => activeRunControllerRegistry.abort(runId) }]);
    const memory = engineOf({ gates: [reader] });
    const repo = repository();
    const seen = await events(run(main.adapter, memory, { runId }, repo));
    // The gate's turn made one request, which Stop ended; nothing came after it.
    expect(main.requests).toHaveLength(3);
    expect(seen.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(memory.published()).toBeNull();
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), `${REPORT}\n\n---\n\n*${researchNote("stopped", REPORT)}*`);
    expect(memory.threads.settle).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ state: "stopped" }) }));
    expect(activeRunControllerRegistry.executing()).not.toContain(runId);
  });

  it("Stop before any draft shows nothing it held", async () => {
    const runId = "run-stop-early";
    const main = scripted([{ calls: [start()], text: "Starting." }, { onCall: () => activeRunControllerRegistry.abort(runId), text: "HELD NARRATION" }]);
    const memory = engineOf({});
    const seen = await events(run(main.adapter, memory, { runId }));
    expect(seen.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(memory.runs.saveStoppedText).toHaveBeenCalledWith(expect.anything(), "Starting.");
  });

  it("a run that fails with a report in hand keeps it with a note", async () => {
    const main = scripted([
      { calls: [start()] },
      { calls: [submit()] },
      { fail: true }
    ]);
    const memory = engineOf({ gates: [gate("gap", async (_draft, context) => context.attempt === 1 ? { kind: "send_back", message: "Again." } : { kind: "pass" })] });
    const repo = repository();
    await run(main.adapter, memory, {}, repo).text();
    expect(memory.published()).toBeNull();
    expect(repo.failRun).toHaveBeenCalledTimes(1);
    expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", `${REPORT}\n\n---\n\n*${researchNote("run_failed", REPORT)}*`, { runId: "run-1" });
  });

  it("the turn's hard deadline with a report in hand keeps it with a note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      const main = scripted([{ calls: [start()] }, { calls: [submit()] }, { hang: true }]);
      const memory = engineOf({ gates: [gate("gap", async (_draft, context) => context.attempt === 1 ? { kind: "send_back", message: "Again." } : { kind: "pass" })] });
      const repo = repository();
      const finished = run(main.adapter, memory, {}, repo).text();
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      await finished;
      expect(repo.failRun).toHaveBeenCalledWith("run-1", "answer-1", expect.objectContaining({ code: "run_time_limit" }), expect.anything());
      expect(repo.appendAssistantText).toHaveBeenLastCalledWith("answer-1", `${REPORT}\n\n---\n\n*${researchNote("time_out", REPORT)}*`, { runId: "run-1" });
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
      { calls: [start()] },
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
