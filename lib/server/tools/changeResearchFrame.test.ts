import { describe, expect, it, vi } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, decodeResearchFrameChange, RESEARCH_FRAME_CHANGES, type ResearchFrame } from "../../contracts/research";
import { SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import { subagentOffersTool } from "../engine/subagents/registry";
import type { EngineToolExecution } from "../engine/toolRegistry";
import { changedResearchFrame } from "../research/matrix";
import { changeResearchFrameEngineTool, changeResearchFrameTool, type ChangeResearchFrameTarget } from "./changeResearchFrame";
import type { ToolExecutionResult } from "./types";

const ROW = { cases: null, change: "add_row", key: "x1", label: "Lonax X1", reason: "A shop sells it.", url: null, why: null };
const CRITERION = { cases: null, change: "add_criterion", key: "price", label: "Price", reason: "Prices differ by half.", url: null, why: "It decides the budget." };
const BRANCH = { cases: [{ key: "light", label: "Up to 70 kg" }, { key: "heavy", label: "Heavier" }], change: "add_branch", key: "weight", label: "The sleeper's weight", reason: "Firmness depends on it.", url: null, why: null };

const properties = changeResearchFrameTool.inputSchema.properties as Record<string, Record<string, unknown>>;
const signal = new AbortController().signal;

describe("what the tool asks of its words", () => {
  it("says a row is an option the user could choose, never a test, a source or a method", () => {
    expect(changeResearchFrameTool.description).toContain("an option the user could choose");
    expect(changeResearchFrameTool.description).toContain("a test, a source or a method is evidence");
    expect(changeResearchFrameTool.description).not.toContain("study");
  });

  it("adds a row by the research's rule, not by what a search showed first", () => {
    expect(changeResearchFrameTool.description).toContain("by the rule the research states, never by what a search showed first");
  });

  it("asks labels and reasons in the goal's language, since they reach the report as written", () => {
    for (const field of ["label", "reason", "why"]) expect(properties[field]!.description).toContain("in the language of the research goal");
    expect(properties.reason!.description).toContain("name no tool");
  });
});

const call = (args: Record<string, unknown>): EngineToolExecution =>
  ({ call: { arguments: args, id: "call-1", name: CHANGE_RESEARCH_FRAME_TOOL_NAME }, ordinal: 0, persistedToolCallId: "row-1", round: 1, signal });

const value = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;

function targetOf(open = true, changed: Awaited<ReturnType<ChangeResearchFrameTarget["coverage"]["change"]>> = { ok: true, value: {} as ResearchFrame }) {
  const change = vi.fn(async () => changed);
  return { change, target: { coverage: { change }, open: () => open } satisfies ChangeResearchFrameTarget };
}

describe("the change_research_frame schema", () => {
  it("lists every field as required, stays out of strict mode, and the decoder takes what it describes for each change", () => {
    expect([...changeResearchFrameTool.inputSchema.required as string[]].sort()).toEqual(Object.keys(properties).sort());
    expect(changeResearchFrameTool.strict).toBe(false);
    expect(decodeResearchFrameChange(ROW)).toMatchObject({ ok: true, value: { change: "add_row", row: { key: "x1", label: "Lonax X1" } } });
    expect(decodeResearchFrameChange(CRITERION)).toMatchObject({ ok: true, value: { change: "add_criterion", criterion: { criterion: "Price", key: "price", why: "It decides the budget." } } });
    expect(decodeResearchFrameChange(BRANCH)).toMatchObject({ ok: true, value: { branch: { key: "weight", unknown: "The sleeper's weight" }, change: "add_branch" } });
    for (const field of Object.keys(properties)) {
      const rest = Object.fromEntries(Object.entries(ROW).filter(([key]) => key !== field));
      expect(decodeResearchFrameChange(rest)).toMatchObject({ message: expect.stringContaining(field), ok: false });
    }
  });

  it("offers exactly the contract's changes, and writes the nullable list as anyOf", () => {
    expect(properties.change!.enum).toEqual([...RESEARCH_FRAME_CHANGES]);
    expect(properties.cases!.anyOf).toEqual([expect.objectContaining({ type: "array" }), { type: "null" }]);
    expect(properties.why!.type).toEqual(["string", "null"]);
    expect(JSON.stringify(changeResearchFrameTool.inputSchema)).not.toMatch(/"type":\[[^\]]*"(?:array|object)"/u);
  });

  it("reaches every researcher whatever its tool groups, as record_evidence does", () => {
    expect(subagentOffersTool(changeResearchFrameTool, null)).toBe(true);
    expect(subagentOffersTool(changeResearchFrameTool, [])).toBe(true);
    expect(subagentOffersTool(changeResearchFrameTool, [SUBAGENT_TOOL_GROUPS.web_fetch])).toBe(true);
  });
});

describe("a change_research_frame call", () => {
  it("writes under the agent its registry names, whatever the model says", async () => {
    const { change, target } = targetOf();
    const sub = changeResearchFrameEngineTool(target, { kind: "subagent", name: "lab", threadId: "thread-1" } as never);
    await sub.execute(call({ ...ROW, by: "someone else" }));
    expect(change).toHaveBeenCalledExactlyOnceWith({ change: "add_row", reason: "A shop sells it.", row: { key: "x1", label: "Lonax X1" } }, { name: "lab", threadId: "thread-1" }, signal);
    await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call(CRITERION));
    expect(change.mock.calls.at(-1)!.at(1)).toEqual({ name: null, threadId: null });
  });

  it("is refused until the matrix is open, with nothing written", async () => {
    const { change, target } = targetOf(false);
    const result = await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call(ROW));
    expect(result.status).toBe("error");
    expect(value(result)).toMatchObject({ code: "research_frame_closed", message: expect.stringContaining("propose_research_plan") });
    expect(change).not.toHaveBeenCalled();
  });

  it("names the field to correct, with nothing written", async () => {
    const { change, target } = targetOf();
    const result = await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call({ ...CRITERION, why: null }));
    expect(value(result)).toMatchObject({ code: "research_frame_change_invalid", message: expect.stringContaining("why") });
    expect(change).not.toHaveBeenCalled();
  });

  it("hands the port's refusal to the agent, and a failure to the batch", async () => {
    const { target } = targetOf(true, { message: "Nothing was changed: x1 is already a row of the matrix, so use that key.", ok: false });
    const result = await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call(ROW));
    expect(result.status).toBe("error");
    expect(value(result)).toMatchObject({ code: "research_frame_change_refused", message: expect.stringContaining("x1") });
    const broken = { coverage: { change: async () => { throw new Error("down"); } }, open: () => true };
    await expect(changeResearchFrameEngineTool(broken, { kind: "main" }).execute(call(ROW))).rejects.toThrow("down");
  });

  it("answers short, with the key to use and what a criterion will show", async () => {
    const tool = changeResearchFrameEngineTool(targetOf().target, { kind: "main" });
    expect(value(await tool.execute(call(ROW)))).toEqual({ message: "Row added: use row_key x1.", status: "changed" });
    expect((value(await tool.execute(call(CRITERION))) as { message: string }).message).toContain("name it with your reason");
    expect(value(await tool.execute(call(BRANCH)))).toMatchObject({ status: "changed" });
  });

  it("is never tried again by itself, and is the agent's own step", () => {
    const tool = changeResearchFrameEngineTool(targetOf().target, { kind: "main" });
    expect(tool.effects).toBe("local");
    expect(tool.activity({ arguments: {}, id: "c", name: CHANGE_RESEARCH_FRAME_TOOL_NAME })).toEqual({ origin: "tool", serverName: "Research", toolName: "Extending the matrix" });
  });
});

const NOTE = { cases: null, change: "note_candidate", key: null, label: "Dreamline SleepDream Medium S1000", reason: "An Ozon listing shows it.",
  url: "https://www.ozon.ru/category/matrasy/?sorting=rating", why: null };
const ASIDE = { cases: null, change: "set_aside", key: "dreamline-sleep-dream-medium-s1000", label: null, reason: "Sold out in every shop.", url: null, why: null };

describe("candidates through change_research_frame", () => {
  /** The real change on one frame held in memory, as the coverage port makes it. */
  function held() {
    const state = { frame: { branches: [], changes: [], criteria: [{ criterion: "Firmness", key: "firmness", why: "It decides comfort." }],
      rows: [{ key: "kombi-3", label: "Dreamline Kombi-3 S1000" }] } as ResearchFrame };
    const target: ChangeResearchFrameTarget = { coverage: { change: async (request, by) => {
      const changed = changedResearchFrame(state.frame, request, { at: "2026-11-03T10:00:00.000Z", by });
      if (changed.ok) state.frame = changed.value;
      return changed;
    } }, open: () => true };
    return { state, target };
  }
  const researcher = (name: string) => ({ kind: "subagent", name, threadId: `thread-${name}` }) as never;

  it("asks for the name, the page's link and a nullable key and label, and the decoder reads both kinds", () => {
    expect(properties.key!.type).toEqual(["string", "null"]);
    expect(properties.label!.type).toEqual(["string", "null"]);
    expect(properties.url!.type).toEqual(["string", "null"]);
    expect(properties.url!.description).toContain("note_candidate only: the http or https link of the page you opened that names the option.");
    expect(changeResearchFrameTool.description).toContain("note_candidate: an option you saw that the matrix lacks");
    expect(changeResearchFrameTool.description).toContain("the model and not only its brand or line");
    expect(changeResearchFrameTool.description).toContain("with url the link of the page that names it");
    expect(changeResearchFrameTool.description).toContain("Note an option once per site that names it: the server counts the sites and agents that named each, a note with no url counts no site");
    expect(changeResearchFrameTool.description).toContain("set_aside: the main agent only");
    expect(decodeResearchFrameChange(NOTE)).toMatchObject({ ok: true, value: { change: "note_candidate", label: NOTE.label, url: NOTE.url } });
    expect(decodeResearchFrameChange(ASIDE)).toMatchObject({ ok: true, value: { change: "set_aside", key: ASIDE.key } });
  });

  it("stores a researcher's note with its page, counts a second agent and a further site, refuses a repeat from a site it noted, and tells the researcher to go on", async () => {
    const { state, target } = held();
    const first = value(await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call(NOTE)));
    expect(first).toEqual({ message: "Candidate noted under key dreamline-sleep-dream-medium-s1000. The main agent decides whether it becomes a row; go on with your question.",
      status: "changed" });
    const second = value(await changeResearchFrameEngineTool(target, researcher("brands")).execute(call({ ...NOTE, label: "Dreamline Sleep Dream Medium S1000" })));
    expect(second.message).toContain("dreamline-sleep-dream-medium-s1000, named on 1 site by 2 agents now.");
    expect(state.frame.candidates![0]!.notes.map(({ by }) => by)).toEqual([{ name: "marketplaces", threadId: "thread-marketplaces" }, { name: "brands", threadId: "thread-brands" }]);
    expect(state.frame.candidates![0]!.notes[0]!.url).toBe(NOTE.url);
    const elsewhere = value(await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call({ ...NOTE, url: "https://market.yandex.ru/catalog--matrasy/1" })));
    expect(elsewhere.message).toContain("named on 2 sites by 2 agents now.");
    const again = await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call({ ...NOTE, url: "https://ozon.ru/product/sleepdream-123/" }));
    expect(value(again)).toMatchObject({ code: "research_frame_change_refused", message: "Nothing was noted: you noted dreamline-sleep-dream-medium-s1000 from ozon.ru already." });
    expect(state.frame.candidates![0]!.notes).toHaveLength(3);
    const covered = await changeResearchFrameEngineTool(target, researcher("brands")).execute(call({ ...NOTE, label: "Dreamline Kombi-3 S1000 180×200" }));
    expect(value(covered)).toMatchObject({ code: "research_frame_change_refused", message: expect.stringContaining("already row kombi-3") });
  });

  it("names the field to correct for a link no page has, with nothing written", async () => {
    const { state, target } = held();
    for (const url of ["ozon.ru/product/1", "ftp://example.test/list", 42]) {
      const refused = await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call({ ...NOTE, url }));
      expect(value(refused)).toMatchObject({ code: "research_frame_change_invalid", message: expect.stringContaining("url must be the http or https link") });
    }
    const { url: _url, ...omitted } = NOTE;
    void _url;
    expect(value(await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call(omitted))))
      .toMatchObject({ code: "research_frame_change_invalid", message: "url must be given: pass null when it does not apply." });
    expect(state.frame.candidates).toBeUndefined();
  });

  it("refuses a researcher's set_aside with nothing written, and lets the main agent set one aside with its reason", async () => {
    const { state, target } = held();
    await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call(NOTE));
    const refused = await changeResearchFrameEngineTool(target, researcher("marketplaces")).execute(call(ASIDE));
    expect(refused.status).toBe("error");
    expect(value(refused)).toMatchObject({ code: "research_frame_change_refused", message: expect.stringContaining("only the main agent sets a noted candidate aside") });
    expect(state.frame.setAside).toBeUndefined();
    const aside = value(await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call(ASIDE)));
    expect(aside).toEqual({ message: "Set aside: dreamline-sleep-dream-medium-s1000. Name it in the report among the options you do not recommend, with your reason.", status: "changed" });
    expect(state.frame.setAside).toEqual([{ at: "2026-11-03T10:00:00.000Z", key: "dreamline-sleep-dream-medium-s1000", reason: "Sold out in every shop." }]);
  });

  it("tells the main agent what to do with a candidate it noted itself", async () => {
    const { target } = held();
    expect(value(await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call(NOTE))).message)
      .toBe("Candidate noted under key dreamline-sleep-dream-medium-s1000. Make it a row with add_row, or set it aside with set_aside and your reason.");
    // A note with no page counts its agent, never a site, and the agent is told so.
    expect(value(await changeResearchFrameEngineTool(target, { kind: "main" }).execute(call({ ...NOTE, label: "Lonax X1", url: null }))).message)
      .toBe("Candidate noted under key lonax-x1. With no url it counts for no site. Make it a row with add_row, or set it aside with set_aside and your reason.");
  });
});
