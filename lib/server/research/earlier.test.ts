import { describe, expect, it, vi } from "vitest";
import {
  decodeResearchPlanProposal,
  PROPOSE_RESEARCH_PLAN_TOOL_NAME,
  researchFrameFromPlan,
  START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchDraft,
  type ResearchFrame
} from "../../contracts/research";
import type { EngineTool } from "../engine/toolRegistry";
import { toolResultOutputText } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import type { ModelToolCall } from "../tools/types";
import { researchCandidatesLine } from "./candidates";
import { createResearchEarlier, researchEarlierOptions, type ResearchEarlierStore } from "./earlier";
import { proposalArguments } from "./planWindow.testFixtures";
import { NOOP_RESEARCH_PORTS, type ResearchEarlierRead, type ResearchEarlierRecord, type ResearchPortFactories, type ResearchRunScope } from "./ports";
import { id } from "./report.testFixtures";
import { createRunResearch, researchEarlierDrafts } from "./run";

/**
 * A second research on a branch starts with the options the first recommended (task research-carries-earlier-options). `earlier.prisma.test.ts` proves
 * the owner and chat scope on PostgreSQL; the branch scope is the items' own and is proven here.
 */
const running = new AbortController().signal;
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const FRAME: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "Price", key: "price", why: "The budget decides." }],
  rows: [{ key: "forma", label: "Askona Balance Forma 160x200" }, { key: "lonax", label: "Lonax Memory" }, { key: "optima", label: "Optima Classic" }] };

const record = (number: number, rowKey: string | null, createdAt: string, extra: Partial<ResearchEarlierRecord> = {}): ResearchEarlierRecord =>
  ({ createdAt, id: id(number), kind: "finding", rowKey, runId: "run-a", url: `https://shop.example/${number}`, ...extra });

const draftOf = (pick: string | null, rows: readonly string[], recordIds: readonly string[]): ResearchDraft => ({ branchPicks: [], doesNotSeparate: null, findings: [],
  origin: "reserved_call", pickRowKey: pick, recordIds, report: "Report.", summary: { rowKeys: rows, text: "Summary." }, unreachable: [] });

describe("which options earlier research recommended", () => {
  const read: ResearchEarlierRead = { frames: new Map([["run-a", FRAME]]), records: [
    record(1, "forma", "2026-11-03T09:00:00.000Z"), record(2, "forma", "2026-11-04T09:00:00.000Z", { url: "https://shop.example/forma" }),
    record(3, "lonax", "2026-11-04T08:00:00.000Z", { kind: "not_found", url: null }), record(4, "optima", "2026-11-02T08:00:00.000Z")] };

  it("takes the pick first, then the summary's rows, each with the newest page cited for it and that page's date", () => {
    const options = researchEarlierOptions([{ draft: draftOf("forma", ["forma", "lonax", "optima"], [id(1), id(2), id(3), id(4)]), researchRunId: "run-a" }], read);
    expect(options).toEqual([
      { label: "Askona Balance Forma 160x200", on: "2026-11-04", pick: true, url: "https://shop.example/forma" },
      // Nothing found is no page: the draft's newest record gives the date.
      { label: "Lonax Memory", on: "2026-11-04", pick: false, url: null },
      { label: "Optima Classic", on: "2026-11-02", pick: false, url: "https://shop.example/4" }
    ]);
  });

  it("gives nothing for a research whose frame the store did not give, a row outside its frame, or a draft that cited nothing", () => {
    expect(researchEarlierOptions([{ draft: draftOf("forma", ["forma"], [id(2)]), researchRunId: "run-of-another-branch" }], read)).toEqual([]);
    expect(researchEarlierOptions([{ draft: draftOf("gone", ["gone"], [id(2)]), researchRunId: "run-a" }], read)).toEqual([]);
    expect(researchEarlierOptions([{ draft: draftOf("forma", ["forma"], []), researchRunId: "run-a" }], read)).toEqual([]);
  });
});

describe("what the port reads", () => {
  const storeOf = () => ({
    frames: vi.fn<ResearchEarlierStore["frames"]>(async (_key, runIds) => runIds.map((runId) => ({ frame: FRAME, runId }))),
    records: vi.fn<ResearchEarlierStore["records"]>(async () => [record(2, "forma", "2026-11-04T09:00:00.000Z")])
  }) satisfies ResearchEarlierStore;
  const scopeOf = (branchRunIds: readonly string[]) => ({ branchRunIds, chatId: "chat", runId: "run-c", userId: "user" }) as unknown as ResearchRunScope;

  it("reads only the branch's earlier runs, never this run's own, as this user's in this chat", async () => {
    const store = storeOf();
    const read = await createResearchEarlier({ store })(scopeOf(["run-a", "run-b"])).read({ recordIds: [id(2), id(2)],
      researchRunIds: ["run-a", "run-of-a-sibling-branch", "run-c"] }, running);
    expect(store.frames).toHaveBeenCalledExactlyOnceWith({ chatId: "chat", userId: "user" }, ["run-a"]);
    expect(store.records).toHaveBeenCalledExactlyOnceWith({ chatId: "chat", userId: "user" }, { ids: [id(2)], runIds: ["run-a", "run-b"] });
    expect([...read.frames.keys()]).toEqual(["run-a"]);
  });

  it("asks the store nothing for runs off the branch, and leaves out a frame no writer made", async () => {
    const store = storeOf();
    await expect(createResearchEarlier({ store })(scopeOf(["run-a"])).read({ recordIds: [id(2)], researchRunIds: ["run-of-another-chat"] }, running))
      .resolves.toEqual({ frames: new Map(), records: [] });
    expect(store.frames).not.toHaveBeenCalled();
    store.frames.mockResolvedValueOnce([{ frame: { rows: "many" }, runId: "run-a" }]);
    await expect(createResearchEarlier({ store })(scopeOf(["run-a"])).read({ recordIds: [id(2)], researchRunIds: ["run-a"] }, running))
      .resolves.toEqual({ frames: new Map(), records: [] });
    expect(store.records).not.toHaveBeenCalled();
  });
});

const PLAN = { questions: [{ question: "Which mattress?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }], skipped_source_classes: [] };
const decoded = decodeResearchPlanProposal(proposalArguments(PLAN));
if (!decoded.ok) throw new Error(decoded.message);
const PROPOSAL = decoded.value;

function called(name: string, callId: string, args: unknown, output?: string): TranscriptItem[] {
  return [{ arguments: JSON.stringify(args), callId, id: `${callId}-call`, kind: "tool_call", name },
    ...output === undefined ? [] : [{ callId, id: `${callId}-result`, kind: "tool_result" as const, name, outcome: "complete" as const, output }]];
}

const submitArgs = (pick: string, rows: readonly string[], ids: readonly string[]) => ({ branch_picks: [], does_not_separate: null, pick_row_key: pick, record_ids: ids,
  report: "Report.", summary: { row_keys: rows, text: "Summary." }, unreachable: [] });

/** One finished research turn: its question, its start naming its run, its plan, and a draft with the gates' word. */
function researchTurn(turn: string, run: string, pick: string, rows: readonly string[], ids: readonly string[], status: "accepted" | "sent_back" = "accepted"): TranscriptItem[] {
  return [{ id: `msg-${turn}`, kind: "user", text: `Research ${turn}.` },
    ...called(START_RESEARCH_TOOL_NAME, `start-${turn}`, { goal: "Choose a mattress." }, JSON.stringify({ research_run: run, status: "scoping", instructions: "Scope." })),
    ...called(PROPOSE_RESEARCH_PLAN_TOOL_NAME, `plan-${turn}`, proposalArguments(PLAN), JSON.stringify({ status: "released", changed: false, released_by: "timer",
      user_plan: { assumptions: [], steps: ["One."], understood: "A mattress." }, instructions: "Stands." })),
    ...called(SUBMIT_RESEARCH_DRAFT_TOOL_NAME, `draft-${turn}`, submitArgs(pick, rows, ids), JSON.stringify({ status, message: status === "accepted" ? "Shown." : "Fix it." })),
    { id: `answer-${turn}`, kind: "assistant_text", text: "Report." }];
}

describe("the researches the branch finished", () => {
  it("takes each turn's accepted draft, newest first, and only researches of the branch's own runs", () => {
    const items = [...researchTurn("1", "run-a", "forma", ["forma", "lonax"], [id(1)]), ...researchTurn("2", "run-b", "optima", ["optima"], [id(2)]),
      // A start's stored result that names a run off the branch counts for nothing, and a draft the gates never accepted is no report.
      ...researchTurn("3", "run-elsewhere", "forma", ["forma"], [id(3)]), ...researchTurn("4", "run-d", "lonax", ["lonax"], [id(4)], "sent_back"),
      { id: "msg-now", kind: "user", text: "Research again with a new budget." } as TranscriptItem];
    const found = researchEarlierDrafts(items, ["run-a", "run-b", "run-d"]);
    expect(found.map(({ draft, researchRunId }) => [researchRunId, draft.pickRowKey, draft.summary?.rowKeys])).toEqual([["run-b", "optima", ["optima"]],
      ["run-a", "forma", ["forma", "lonax"]]]);
  });

  it("finds nothing in a first research's items", () => {
    expect(researchEarlierDrafts([{ id: "msg-now", kind: "user", text: "Research." }], [])).toEqual([]);
  });
});

describe("a second research on a branch", () => {
  const items: TranscriptItem[] = [...researchTurn("1", "run-a", "forma", ["forma", "lonax"], [id(1), id(2)]), { id: "msg-now", kind: "user", text: "Research again, under 25 000 ₽." }];
  const records = [record(1, "forma", "2026-11-04T09:00:00.000Z", { url: "https://shop.example/forma" }), record(2, "lonax", "2026-11-04T10:00:00.000Z", { url: "https://shop.example/lonax" })];

  function runOf(read: () => Promise<ResearchEarlierRead>, branchRunIds: readonly string[] = ["run-a"]) {
    const open = vi.fn(NOOP_RESEARCH_PORTS.planWindow.open);
    const earlier = vi.fn(read);
    const ports: ResearchPortFactories = { earlier: () => ({ read: earlier }), planWindow: () => ({ open }) };
    const threads = { backgroundRunIds: vi.fn(async () => []), threadEffectItems: vi.fn(async () => []) };
    const research = createRunResearch({ chatId: "chat", deps: { gates: [], ports }, gatesEndAt: NOW + 3_600_000, items: () => items, now: () => NOW,
      onPlan: async () => undefined, rearmReservedCall: () => undefined, runId: "run-c", savedResults: { read: async () => null },
      subagentInput: { admittedRequest: { modelId: "main-model" }, branchRunIds, engine: {}, signal: running, snapshot: {}, userFollowups: async () => [] } as never,
      threads: threads as never, toolTimeLeft: () => true, userId: "user", userMessage: "Research again, under 25 000 ₽." });
    return { earlier, open, research };
  }
  const execute = (tool: EngineTool, call: ModelToolCall) => tool.execute({ call, persistedToolCallId: `row-${call.id}`, round: 1, signal: running } as never);
  const toolOf = (research: ReturnType<typeof createRunResearch>, name: string) => research.tools.find((tool) => tool.definition.name === name)!;
  const start: ModelToolCall = { arguments: { goal: "Choose a mattress under 25 000 ₽." }, id: "start-now", name: START_RESEARCH_TOOL_NAME };
  const propose: ModelToolCall = { arguments: proposalArguments(PLAN), id: "plan-now", name: PROPOSE_RESEARCH_PLAN_TOOL_NAME };

  it("starts with the first one's recommended options as candidates, told at the start and with the method, and in the frame the plan writes", async () => {
    const { earlier, open, research } = runOf(async () => ({ frames: new Map([["run-a", FRAME]]), records }));
    research.responseCompleted({ calls: [start], runnable: [start] });
    const started = toolResultOutputText(await execute(toolOf(research, START_RESEARCH_TOOL_NAME), start));
    expect(earlier).toHaveBeenCalledExactlyOnceWith({ recordIds: [id(1), id(2)], researchRunIds: ["run-a"] }, running);
    expect(started).toContain("Earlier research in this chat recommended these options");
    expect(started).toContain('recommended by earlier research in this chat on 2026-11-04 as its pick: {\\"key\\":\\"askona-balance-forma-160x200\\"');
    expect(started).toContain("put each such one in the plan's rows");
    const planned = toolResultOutputText(await execute(toolOf(research, PROPOSE_RESEARCH_PLAN_TOOL_NAME), propose));
    expect(planned).toContain("Check first those that fit this question's limits");
    expect(planned).toContain("one that could not be reached again stays in the reserve");
    const seeds = open.mock.calls[0]![0].earlier!;
    expect(seeds).toEqual([
      { earlier: { on: "2026-11-04", pick: true }, key: "askona-balance-forma-160x200", label: "Askona Balance Forma 160x200", notes: [{ at: new Date(NOW).toISOString(),
        by: { name: null, threadId: null }, reason: "Earlier research in this chat recommended it on 2026-11-04 as its pick.", url: "https://shop.example/forma" }] },
      { earlier: { on: "2026-11-04" }, key: "lonax-memory", label: "Lonax Memory", notes: [{ at: new Date(NOW).toISOString(), by: { name: null, threadId: null },
        reason: "Earlier research in this chat recommended it on 2026-11-04.", url: "https://shop.example/lonax" }] }]);
    // The frame the plan opens with leads its candidates with them.
    const frame = { ...researchFrameFromPlan(PROPOSAL), candidates: seeds };
    expect(researchCandidatesLine(frame)).toContain("Those earlier research recommended come first");
  });

  it("reads nothing when the branch has no earlier research of its own, as on a sibling branch, and a store that fails costs only the seeds", async () => {
    // The same items on a branch whose runs do not include the one the start names: a stored value counts for nothing.
    const sibling = runOf(async () => ({ frames: new Map([["run-a", FRAME]]), records }), ["run-x"]);
    sibling.research.responseCompleted({ calls: [start], runnable: [start] });
    expect(toolResultOutputText(await execute(toolOf(sibling.research, START_RESEARCH_TOOL_NAME), start))).not.toContain("Earlier research");
    expect(sibling.earlier).not.toHaveBeenCalled();
    const failing = runOf(async () => { throw new Error("down"); });
    failing.research.responseCompleted({ calls: [start], runnable: [start] });
    expect(toolResultOutputText(await execute(toolOf(failing.research, START_RESEARCH_TOOL_NAME), start))).toContain('"status":"scoping"');
    await execute(toolOf(failing.research, PROPOSE_RESEARCH_PLAN_TOOL_NAME), propose);
    expect(failing.open.mock.calls[0]![0].earlier).toEqual([]);
    expect(failing.earlier).toHaveBeenCalledOnce();
  });
});
