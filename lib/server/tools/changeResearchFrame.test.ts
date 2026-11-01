import { describe, expect, it, vi } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, decodeResearchFrameChange, RESEARCH_FRAME_CHANGES, type ResearchFrame } from "../../contracts/research";
import { SUBAGENT_TOOL_GROUPS } from "../../contracts/subagents";
import { subagentOffersTool } from "../engine/subagents/registry";
import type { EngineToolExecution } from "../engine/toolRegistry";
import { changeResearchFrameEngineTool, changeResearchFrameTool, type ChangeResearchFrameTarget } from "./changeResearchFrame";
import type { ToolExecutionResult } from "./types";

const ROW = { cases: null, change: "add_row", key: "x1", label: "Lonax X1", reason: "A shop sells it.", why: null };
const CRITERION = { cases: null, change: "add_criterion", key: "price", label: "Price", reason: "Prices differ by half.", why: "It decides the budget." };
const BRANCH = { cases: [{ key: "light", label: "Up to 70 kg" }, { key: "heavy", label: "Heavier" }], change: "add_branch", key: "weight", label: "The sleeper's weight", reason: "Firmness depends on it.", why: null };

const properties = changeResearchFrameTool.inputSchema.properties as Record<string, Record<string, unknown>>;
const signal = new AbortController().signal;

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

  it("is a researcher's tool and never a gate's: a list of tool groups never reaches it", () => {
    expect(subagentOffersTool(changeResearchFrameTool, null)).toBe(true);
    expect(subagentOffersTool(changeResearchFrameTool, [])).toBe(false);
    expect(subagentOffersTool(changeResearchFrameTool, [SUBAGENT_TOOL_GROUPS.web_fetch])).toBe(false);
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
