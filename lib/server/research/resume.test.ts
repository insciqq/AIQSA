import { describe, expect, it, vi } from "vitest";
import {
  decodeResearchPlanProposal,
  PROPOSE_RESEARCH_PLAN_TOOL_NAME,
  RESEARCH_EVIDENCE_LIMITS,
  researchFrameFromPlan,
  researchPlanAnswerDocument,
  researchPlanProposalDocument,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchEvidenceRecord,
  type ResearchMatrixCoverage
} from "../../contracts/research";
import { CONTINUE_TURN_TEXT, RUN_INTERRUPTED_FAILURE, RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import { harnessPromptSection } from "../engine/prompts/harness";
import type { EngineTool } from "../engine/toolRegistry";
import { toolOutputExcerpt, toolResultOutputText } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import * as observability from "../observability";
import type { ModelToolCall } from "../tools/types";
import { proposalArguments } from "./planWindow.testFixtures";
import { NOOP_RESEARCH_PORTS, type ResearchPortFactories, type ResearchResumeState, type ResearchRunScope } from "./ports";
import { createResearchResume, createResearchResumeStore, type ResearchResumeSource, type ResearchResumeStore } from "./resume";
import { createRunResearch, researchOfTurn, researchRunOf, type RunResearchInput } from "./run";

/**
 * A Continue on an interrupted research: what the store gives it (`resume.ts`), and what a run does with that (`run.ts`). `resume.prisma.test.ts`
 * proves the same on PostgreSQL, with the records and the matrix real.
 */
const GOAL = "Выбрать матрас на много лет.";
const PLAN = { questions: [{ question: "Какой матрас выдерживает годы?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }],
  skipped_source_classes: [] };
const decoded = decodeResearchPlanProposal(proposalArguments(PLAN));
if (!decoded.ok) throw new Error(decoded.message);
const PROPOSAL = decoded.value;
const ANSWER = { changed: false, plan: PROPOSAL, releasedBy: "timer" as const };
const FRAME = researchFrameFromPlan(PROPOSAL);
const NOW = 1_000_000;
const REPORT = "# Отчёт\n\nПодтверждено: X1 держит форму.";
const DRAFT = { findings: [], report: REPORT, unreachable: [] };

const scopeOf = (overrides: Partial<ResearchRunScope> = {}) => ({ branchRunIds: ["run-a"], chatId: "chat", now: () => NOW, researchRunId: "run-b", runId: "run-b", userId: "user",
  ...overrides }) as unknown as ResearchRunScope;

const SOURCE: ResearchResumeSource = { answer: researchPlanAnswerDocument(ANSWER), frame: FRAME, goal: GOAL, proposal: researchPlanProposalDocument(PROPOSAL), releasedAt: new Date(NOW - 5_000),
  version: 3, windowEndsAt: new Date(NOW - 6_000) };

function storeOf(overrides: Partial<ResearchResumeStore> = {}) {
  return {
    chain: vi.fn(async ({ runId }: { runId: string }) => [runId] as readonly string[]),
    interrupted: vi.fn(async () => true),
    link: vi.fn(async () => undefined),
    recorded: vi.fn(async () => true),
    source: vi.fn(async () => SOURCE as ResearchResumeSource | null),
    ...overrides
  } satisfies ResearchResumeStore;
}

const running = new AbortController().signal;
const keyOf = (runId: string) => ({ chatId: "chat", runId, userId: "user" });

describe("what the store gives a Continue", () => {
  it("copies the row beside the link, with the phases counting from now, and says what it picked up", async () => {
    const store = storeOf();
    await expect(createResearchResume({ store })(scopeOf()).load("run-a", running)).resolves.toEqual({ answer: ANSWER, frame: FRAME, fromRunId: "run-a", goal: GOAL });
    expect(store.link).toHaveBeenCalledExactlyOnceWith(keyOf("run-b"), { answer: SOURCE.answer, frame: SOURCE.frame, fromRunId: "run-a", goal: GOAL, proposal: SOURCE.proposal,
      releasedAt: new Date(NOW), version: 3, windowEndsAt: SOURCE.windowEndsAt });
  });

  it("asks whether the branch's last run was interrupted, which on an approval is not the run that started the research", async () => {
    const store = storeOf();
    await createResearchResume({ store })(scopeOf({ branchRunIds: ["run-a", "run-a2"] })).load("run-a", running);
    expect(store.interrupted).toHaveBeenCalledExactlyOnceWith(keyOf("run-a2"));
    expect(store.source).toHaveBeenCalledExactlyOnceWith(keyOf("run-a"));
  });

  it.each<[string, Partial<ResearchResumeStore>]>([
    ["a run that was not interrupted", { interrupted: async () => false }],
    ["a run that does not exist or kept no frame", { source: async () => null }],
    ["a plan still in its window", { source: async () => ({ ...SOURCE, answer: null, frame: null, releasedAt: null }) }],
    ["scoping, with no proposal", { source: async () => ({ ...SOURCE, answer: null, frame: null, proposal: null, releasedAt: null, windowEndsAt: null }) }],
    ["a plan released with nothing recorded", { recorded: async () => false }],
    ["a row no writer could have made", { source: async () => ({ ...SOURCE, frame: { rows: "many" } }) }]
  ])("gives %s nothing, and writes nothing", async (_name, overrides) => {
    const store = storeOf(overrides);
    await expect(createResearchResume({ store })(scopeOf()).load("run-a", running)).resolves.toBeNull();
    expect(store.link).not.toHaveBeenCalled();
  });

  it("answers another branch's or another user's run as one that does not exist, without reading it", async () => {
    const store = storeOf();
    await expect(createResearchResume({ store })(scopeOf()).load("run-of-another-branch", running)).resolves.toBeNull();
    await expect(createResearchResume({ store })(scopeOf({ branchRunIds: [] })).load("run-a", running)).resolves.toBeNull();
    expect(store.interrupted).not.toHaveBeenCalled();
    expect(store.source).not.toHaveBeenCalled();
    expect(store.link).not.toHaveBeenCalled();
  });

  it("links up to the bound and no further, since one more link would put the oldest records out of a reader's reach", async () => {
    const log = vi.spyOn(observability, "logEvent").mockImplementation(() => undefined);
    const chainOf = (length: number) => async () => Array.from({ length }, (_item, index) => `run-${index}`);
    const atBound = storeOf({ chain: chainOf(RESEARCH_EVIDENCE_LIMITS.continuationChain) });
    await expect(createResearchResume({ store: atBound })(scopeOf()).load("run-a", running)).resolves.toMatchObject({ fromRunId: "run-a" });
    const past = storeOf({ chain: chainOf(RESEARCH_EVIDENCE_LIMITS.continuationChain + 1) });
    await expect(createResearchResume({ store: past })(scopeOf()).load("run-a", running)).resolves.toBeNull();
    expect(past.link).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "research_continuations_spent" }));
    log.mockRestore();
  });

  it("counts a record of an earlier run of the chain", async () => {
    const store = storeOf({ chain: async () => ["run-0", "run-a"] });
    await createResearchResume({ store })(scopeOf()).load("run-a", running);
    expect(store.recorded).toHaveBeenCalledExactlyOnceWith(keyOf("run-a"), ["run-0", "run-a"]);
  });

  it("stops at Stop, before the link", async () => {
    const stop = new AbortController();
    const store = storeOf({ recorded: async () => { stop.abort(new Error("stopped")); return true; } });
    await expect(createResearchResume({ store })(scopeOf()).load("run-a", stop.signal)).rejects.toThrow("stopped");
    expect(store.link).not.toHaveBeenCalled();
  });
});

describe("which runs count as interrupted", () => {
  const storeWith = (errorPayload: unknown) => {
    const findFirst = vi.fn(async () => errorPayload === undefined ? null : { errorPayload });
    return { findFirst, store: createResearchResumeStore({ modelRun: { findFirst } } as never, { chain: async () => [] }) };
  };

  it.each([
    ["a restart", RUN_INTERRUPTED_FAILURE, true],
    ["the turn's time limit", RUN_TIME_LIMIT_FAILURE, true],
    ["a saved answer's message alone", { message: RUN_INTERRUPTED_FAILURE.message }, true],
    ["a provider's failure", { code: "provider_response_not_retryable", message: "No." }, false],
    ["a run with no failure", undefined, false],
    ["a payload that is no object", "run_interrupted", false]
  ])("%s", async (_name, payload, expected) => {
    await expect(storeWith(payload).store.interrupted(keyOf("run-a"))).resolves.toBe(expected);
  });

  it("asks only of the user's own failed native run in this chat whose answer was never published", async () => {
    const { findFirst, store } = storeWith(RUN_INTERRUPTED_FAILURE);
    await store.interrupted(keyOf("run-a"));
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({ select: { errorPayload: true }, where: { answerCompletedAt: null, chatId: "chat", engine: "native", id: "run-a", status: "error", userId: "user" } });
  });
});

const QUESTION: TranscriptItem = { id: "msg-question", kind: "user", text: "Проведи исследование матрасов." };
const CONTINUE: TranscriptItem = { id: "msg-continue", kind: "user", text: CONTINUE_TURN_TEXT };

function called(name: string, callId: string, args: unknown, output?: string): TranscriptItem[] {
  return [{ arguments: JSON.stringify(args), callId, id: `${callId}-call`, kind: "tool_call", name },
    ...output === undefined ? [] : [{ callId, id: `${callId}-result`, kind: "tool_result" as const, name, outcome: "complete" as const, output }]];
}

const started = (run = "run-a") => called(START_RESEARCH_TOOL_NAME, "call-start", { goal: GOAL }, JSON.stringify({ research_run: run, status: "scoping", instructions: "Scope." }));
const planned = () => called(PROPOSE_RESEARCH_PLAN_TOOL_NAME, "call-plan", proposalArguments(PLAN), JSON.stringify({ status: "released", changed: false, released_by: "timer",
  user_plan: { assumptions: [], steps: ["One."], understood: "A mattress." }, instructions: "Stands." }));

/** An interrupted turn with its plan standing, and the user's Continue after it. */
const turn = (...more: readonly TranscriptItem[][]): TranscriptItem[] => [QUESTION, ...started(), ...planned(), ...more.flat(), CONTINUE];

const COVERAGE: ResearchMatrixCoverage = { cells: [
  { criterionKey: "durability", recordIds: ["record-1"], rowKey: "", state: "filled" },
  { criterionKey: "price", recordIds: [], rowKey: "", state: "empty" }
], empty: 1, filled: 1 };

const STATE: ResearchResumeState = { answer: ANSWER, frame: FRAME, fromRunId: "run-a", goal: GOAL };
const RECORD = { id: "record-1", runId: "run-a" } as unknown as ResearchEvidenceRecord;

function portsOf(load: () => Promise<ResearchResumeState | null> = async () => STATE) {
  const resume = vi.fn(load);
  const planReleased = vi.fn();
  const open = vi.fn(NOOP_RESEARCH_PORTS.planWindow.open);
  let scope: ResearchRunScope | null = null;
  const ports: ResearchPortFactories = {
    coverage: () => ({ ...NOOP_RESEARCH_PORTS.coverage, coverage: async () => COVERAGE, frame: async () => FRAME }),
    evidence: (run) => {
      scope = run;
      return { ...NOOP_RESEARCH_PORTS.evidence, records: async () => [RECORD] };
    },
    planWindow: () => ({ open }),
    resume: () => ({ load: resume }),
    time: () => ({ ...NOOP_RESEARCH_PORTS.time, planReleased })
  };
  return { open, planReleased, ports, resume, scope: () => scope! };
}

function runOn(items: readonly TranscriptItem[], ports: ResearchPortFactories, extra: Partial<RunResearchInput> = {}) {
  const shown: unknown[] = [];
  const threads = { backgroundRunIds: vi.fn(async () => []), threadEffectItems: vi.fn(async (_input: { runIds: readonly string[] }) => []) };
  const research = createRunResearch({ chatId: "chat", deps: { gates: [], ports }, gatesEndAt: 2_000_000, items: () => items, now: () => NOW,
    onPlan: async (entry) => { shown.push(entry); }, rearmReservedCall: () => undefined, runId: "run-b", savedResults: { read: async () => null },
    subagentInput: { admittedRequest: { modelId: "main-model" }, branchRunIds: ["run-a"], engine: {}, signal: running, snapshot: {}, userFollowups: async () => [] } as never,
    threads: threads as never, toolTimeLeft: () => true, userId: "user", userMessage: CONTINUE_TURN_TEXT, ...extra });
  return { research, shown, threads };
}

const execute = (tool: EngineTool, call: ModelToolCall) => tool.execute({ call, persistedToolCallId: `row-${call.id}`, round: 1, signal: running } as running);
const toolOf = ({ research }: ReturnType<typeof runOn>, name: string) => research.tools.find((tool) => tool.definition.name === name)!;
const start = { arguments: { goal: "Подобрать матрас." }, id: "call-new-start", name: START_RESEARCH_TOOL_NAME };

/** A start as the batch sends it: its response came first. */
async function startOn(run: ReturnType<typeof runOn>) {
  run.research.responseCompleted({ calls: [start], runnable: [start] });
  const result = await execute(toolOf(run, START_RESEARCH_TOOL_NAME), start);
  return { result, text: toolResultOutputText(result) };
}

describe("a Continue's start", () => {
  it("skips scoping and the window: the plan stands, the clock starts afresh and the result says what is filled", async () => {
    const parts = portsOf();
    const run = runOn(turn(), parts.ports);
    const { text } = await startOn(run);
    expect(parts.resume).toHaveBeenCalledExactlyOnceWith("run-a", running);
    expect(text).toMatch(/^\{"research_run":"run-b","status":"resumed"/u);
    expect(text).toContain("1 of 2 cells empty");
    expect(text).toContain("1 records stand");
    expect(text).toContain("Start the researchers now");
    expect(parts.planReleased).toHaveBeenCalledOnce();
    expect(parts.open).not.toHaveBeenCalled();
    expect(run.research.outstanding()).toBe(true);
    expect(run.research.frameOpen()).toBe(true);
  });

  it("goes by the stored goal, whatever the model passed, and tells the user in its language what was picked up", async () => {
    const run = runOn(turn(), portsOf().ports);
    const { result } = await startOn(run);
    expect(result.status).toBe("complete");
    expect(run.shown).toHaveLength(1);
    expect(run.shown[0]).toMatchObject({ items: [{ completed: true, text: "Продолжаю с записанного: ячеек заполнено: 1 из 2" }, { active: true, text: PLAN.questions[0]!.question }] });
    expect(run.shown[0]).not.toHaveProperty("researchPlan");
  });

  it("refuses a second start and a plan call: the plan stands, and no window opens", async () => {
    const parts = portsOf();
    const run = runOn(turn(), parts.ports);
    await startOn(run);
    expect(toolResultOutputText(await execute(toolOf(run, START_RESEARCH_TOOL_NAME), start))).toContain("research_plan_stands");
    const plan = { arguments: proposalArguments(PLAN) as Record<string, unknown>, id: "call-again", name: PROPOSE_RESEARCH_PLAN_TOOL_NAME };
    expect(toolResultOutputText(await execute(toolOf(run, PROPOSE_RESEARCH_PLAN_TOOL_NAME), plan))).toContain("research_plan_stands");
    expect(parts.open).not.toHaveBeenCalled();
    expect(parts.planReleased).toHaveBeenCalledOnce();
  });

  it("reads from the first run with records, so what agents opened there still counts for a check", async () => {
    const parts = portsOf();
    const run = runOn(turn(), parts.ports);
    await parts.scope().sources.opened(running);
    expect(run.threads.threadEffectItems.mock.lastCall?.[0].runIds).toEqual(["run-b"]);
    await startOn(run);
    await parts.scope().sources.opened(running);
    expect(run.threads.threadEffectItems.mock.lastCall?.[0].runIds).toEqual(["run-a", "run-b"]);
  });

  it("goes by the turn's own run when a compaction took the start call away", async () => {
    const parts = portsOf();
    await startOn(runOn([QUESTION, CONTINUE], parts.ports));
    expect(parts.resume).toHaveBeenCalledExactlyOnceWith("run-a", running);
  });

  it("names a stored run as stored: the store decides what it counts for", async () => {
    const parts = portsOf(async () => null);
    await startOn(runOn([QUESTION, ...started("run-of-another-branch"), ...planned(), CONTINUE], parts.ports));
    expect(parts.resume).toHaveBeenCalledExactlyOnceWith("run-of-another-branch", running);
  });
});

describe("a report the interruption caught", () => {
  const submitted = (output?: string) => called(SUBMIT_RESEARCH_DRAFT_TOOL_NAME, "call-draft", DRAFT, output);

  it("still reaches the answer when its checks never finished, marked so, and the model is told to hand it in again", async () => {
    const run = runOn(turn(submitted()), portsOf().ports);
    const { text } = await startOn(run);
    expect(text).toContain("The checks never finished");
    expect(run.research.outstanding()).toBe(true);
    const shown = run.research.finish(false);
    expect(shown).toContain(REPORT);
    expect(shown).not.toBe(REPORT);
  });

  it("carries what the gates said, as across an approval", async () => {
    const sent = JSON.stringify({ status: "sent_back", gate: "verifier", message: "Not shown to the user yet. Fix the price. Then call submit_research_draft again with the whole report." });
    const seen: unknown[] = [];
    const run = runOn(turn(submitted(sent)), portsOf().ports, { deps: { gates: [{ name: "spy", run: async (_draft, context) => { seen.push(context.earlier); return { kind: "pass" }; } }], ports: portsOf().ports } });
    await startOn(run);
    await execute(toolOf(run, SUBMIT_RESEARCH_DRAFT_TOOL_NAME), { arguments: DRAFT as never, id: "call-again", name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME });
    expect(seen).toEqual([[expect.objectContaining({ gate: "verifier", message: "Fix the price." })]]);
  });
});

describe("a plan the user changed", () => {
  it("still owes its rebuilt questions: researchers wait and no window opens", async () => {
    const changed = called(PROPOSE_RESEARCH_PLAN_TOOL_NAME, "call-plan", proposalArguments(PLAN), JSON.stringify({ status: "released", changed: true, released_by: "saved_edit",
      user_plan: { assumptions: [], steps: ["My step."], understood: "My words." }, instructions: "Rebuild." }));
    const parts = portsOf();
    const run = runOn([QUESTION, ...started(), ...changed, CONTINUE], parts.ports);
    const { text } = await startOn(run);
    expect(text).toContain("rebuilt from the user's words");
    expect(text).not.toContain("Start the researchers now");
    expect(run.research.frameOpen()).toBe(false);
    const researcher = { definition: { name: CALL_SUBAGENT_TOOL_NAME } } as unknown as EngineTool;
    const call = { arguments: { message: "Go.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME };
    const [briefed] = run.research.withResearcherBriefs([researcher]);
    expect(toolResultOutputText(await execute(briefed!, call))).toContain("research_plan_rebuild_first");
  });
});

describe("what is no Continue, or has nothing to pick up", () => {
  it("leaves any other message an ordinary start, and asks no store", async () => {
    const parts = portsOf();
    const items = [...turn().slice(0, -1), { id: "msg-other", kind: "user" as const, text: "Продолжай, но про подушки." }];
    const { text } = await startOn(runOn(items, parts.ports, { userMessage: "Продолжай, но про подушки." }));
    expect(parts.resume).not.toHaveBeenCalled();
    expect(text).toMatch(/"status":"scoping"/u);
    expect(text).not.toContain("could be picked up");
  });

  it("leaves a turn the server wrote and an approval continuation alone, whatever the user's last words were", async () => {
    const parts = portsOf();
    await startOn(runOn([...turn().slice(0, -1), { id: "msg-server", kind: "user", text: "A sub-agent reported." }], parts.ports));
    await startOn(runOn([...turn(), ...called("mcp_shop_buy", "call-held", {}, "Waiting.")], parts.ports));
    expect(parts.resume).not.toHaveBeenCalled();
  });

  it("starts over with the plan step when nothing was recorded, in the goal's language, however the user's word reads", async () => {
    const parts = portsOf(async () => null);
    const run = runOn(turn(), parts.ports);
    const { text } = await startOn(run);
    expect(text).toMatch(/"status":"scoping"/u);
    expect(text).toContain("research starts over with the plan");
    expect(parts.planReleased).not.toHaveBeenCalled();
    expect(run.research.outstanding()).toBe(false);
    expect(run.shown[0]).toMatchObject({ items: [{ text: "Составляю план перед началом исследования" }], researchPlan: { runId: "run-b", state: "scoping" } });
  });

  it("starts over the same way when the store fails, and says so in the log", async () => {
    const log = vi.spyOn(observability, "logEvent").mockImplementation(() => undefined);
    const { text } = await startOn(runOn(turn(), portsOf(async () => { throw new Error("store down"); }).ports));
    expect(text).toMatch(/"status":"scoping"/u);
    expect(log).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "research_resume_failed" }));
    log.mockRestore();
  });

  it("asks the store once, however many ask", async () => {
    const parts = portsOf();
    const run = runOn(turn(), parts.ports);
    await Promise.all([startOn(run), startOn(run)]);
    expect(parts.resume).toHaveBeenCalledOnce();
    expect(parts.planReleased).toHaveBeenCalledOnce();
  });
});

describe("a model that goes round the start", () => {
  const researcherTool = (execute_: EngineTool["execute"]) => ({ definition: { name: CALL_SUBAGENT_TOOL_NAME }, execute: execute_ }) as unknown as EngineTool;
  const call = { arguments: { message: "Go.", name: "lab" }, id: "call-lab", name: CALL_SUBAGENT_TOOL_NAME };

  it("has a researcher sent back to it, and an ordinary sub-agent runs where nothing can be picked up", async () => {
    const ran = vi.fn(async () => ({ callId: "call-lab", content: [], name: CALL_SUBAGENT_TOOL_NAME, status: "complete" as const }));
    const [refused] = runOn(turn(), portsOf().ports).research.withResearcherBriefs([researcherTool(ran)]);
    expect(toolResultOutputText(await execute(refused!, call))).toContain("research_pick_up_first");
    expect(ran).not.toHaveBeenCalled();
    const [ordinary] = runOn(turn(), portsOf(async () => null).ports).research.withResearcherBriefs([researcherTool(ran)]);
    await execute(ordinary!, call);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("is asked once when it answers in text, and after that its text is the ordinary answer", async () => {
    const { research } = runOn(turn(), portsOf().ports);
    const ended = { round: 1, runDraftCall: vi.fn(), text: "Продолжаю.", toolsClosed: false };
    await expect(research.responseEnded(ended)).resolves.toMatchObject({ kind: "user", text: expect.stringContaining(START_RESEARCH_TOOL_NAME) });
    await expect(research.responseEnded(ended)).resolves.toBeNull();
    expect(research.finish(false)).toBeNull();
  });

  it("is asked nothing where nothing can be picked up", async () => {
    const { research } = runOn(turn(), portsOf(async () => null).ports);
    await expect(research.responseEnded({ round: 1, runDraftCall: vi.fn(), text: "Готово.", toolsClosed: false })).resolves.toBeNull();
  });

  it("learns the door from the system prompt, where research is offered", () => {
    expect(harnessPromptSection({ tools: [START_RESEARCH_TOOL_NAME], workspace: false })).toContain(`exactly "${CONTINUE_TURN_TEXT}"`);
  });
});

describe("what a picked-up start leaves for later turns", () => {
  async function stored(output: (text: string) => string = (text) => text) {
    const { text } = await startOn(runOn(turn(), portsOf().ports));
    return [{ id: "msg-continue-2", kind: "user" as const, text: CONTINUE_TURN_TEXT }, ...called(START_RESEARCH_TOOL_NAME, "call-new-start", { goal: GOAL }, output(text))];
  }

  it("names the continuing run, with the plan and where its text starts, for an approval of that run", async () => {
    const items = await stored();
    expect(researchOfTurn(items)).toMatchObject({ goal: GOAL, openedFrom: "run-a", plan: { goal: GOAL, questions: [{ question: PLAN.questions[0]!.question }] }, researchRun: "run-b" });
    expect(researchRunOf(items, { branchRunIds: ["run-a", "run-b"], runId: "run-c" })).toBe("run-b");
  });

  it("gives an approval of that run the plan that stands, on the rows it wrote, reading back to the first run", async () => {
    const items = await stored();
    const parts = portsOf();
    const run = runOn(items, parts.ports, { researchRunId: "run-b", runId: "run-c", subagentInput: { admittedRequest: { modelId: "main-model" }, branchRunIds: ["run-a", "run-b"], engine: {}, signal: running, snapshot: {} } as never });
    run.research.resume(items);
    expect(run.research.outstanding()).toBe(true);
    expect(parts.planReleased).toHaveBeenCalledOnce();
    await parts.scope().sources.opened(running);
    expect(run.threads.threadEffectItems.mock.lastCall?.[0].runIds).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("counts a stored first run only on this branch", async () => {
    const items = await stored();
    const parts = portsOf();
    const run = runOn(items, parts.ports, { researchRunId: "run-b", runId: "run-c", subagentInput: { admittedRequest: { modelId: "main-model" }, branchRunIds: ["run-b"], engine: {}, signal: running, snapshot: {} } as never });
    run.research.resume(items);
    await parts.scope().sources.opened(running);
    expect(run.threads.threadEffectItems.mock.lastCall?.[0].runIds).toEqual(["run-b", "run-c"]);
  });

  it("keeps the plan through an excerpt of a long result, and names the run even when one cut it", async () => {
    const excerpted = await stored((text) => toolOutputExcerpt(`${text}${" ".repeat(30_000)}`, { handle: "tor1_x" }).output);
    expect(researchOfTurn(excerpted).plan).toMatchObject({ goal: GOAL });
    const cut = await stored((text) => text.slice(0, 80));
    expect(researchOfTurn(cut)).toMatchObject({ plan: null, researchRun: "run-b" });
  });
});
