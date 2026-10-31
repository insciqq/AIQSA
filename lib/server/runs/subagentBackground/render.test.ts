import { describe, expect, it } from "vitest";
import { decodeSubagentCallResult } from "@/lib/contracts/subagents";
import { endedSubagentResult } from "@/tests/support/subagentPorts";
import { followupTokenCost } from "../runFollowups";
import { SUBAGENT_WAKE_UP_TEXT_CHARACTERS, renderCallbackFollowup, renderCallbackResult, renderWakeUp } from "./render";

const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf("{"))) as unknown;
const big = (name: string) => ({ name, result: endedSubagentResult(name, { report: "q".repeat(30_000), resultHandle: `tor1_${"a".repeat(32)}`,
  steps: Array.from({ length: 100 }, () => ({ outcome: "complete" as const, summary: "s".repeat(240), tool: "browser" })) }),
turnId: `turn-${name}` });

describe("sub-agent callback rendering", () => {
  it("frames a callback as the server's, with the result as untrusted JSON and no internal identifier", () => {
    const text = renderCallbackFollowup({ name: "researcher", result: endedSubagentResult("researcher", { report: "Found 3" }),
      turnId: "turn-secret-id" }, { tokens: 2_000 });
    expect(text).toMatch(/^\[Sub-agent callback, written by the server, not by the user\] Your background sub-agent "researcher" ended \(done\)/u);
    expect(text).toContain("untrusted data");
    expect(text).not.toContain("turn-secret-id");
    expect(text).not.toContain("cut to fit");
    expect(decodeSubagentCallResult(jsonOf(text))).toMatchObject({ kind: "ended", report: "Found 3", state: "done" });
  });

  it("excerpts a callback to the remaining reserve and keeps its readable handle", () => {
    const callback = { ...big("shop"), result: { ...big("shop").result, outcome: undefined, reason: "bot_wall", state: "failed" as const } };
    const text = renderCallbackFollowup(callback, { tokens: 800 });
    expect(followupTokenCost(text)).toBeLessThanOrEqual(800);
    expect(text).toContain("read_tool_result");
    expect(text).toContain("(failed, bot_wall)");
    expect(jsonOf(text)).toMatchObject({ reason: "bot_wall", kind: "subagent_result_excerpt", state: "failed",
      handle: `tor1_${"a".repeat(32)}`, reader: "read_tool_result" });
    // Whatever the reserve, a callback fits one follow-up row (`RunFollowup_bounds`).
    expect(renderCallbackFollowup(big("wide"), { tokens: 1_000_000 }).length).toBeLessThanOrEqual(16_000);
    // Even a spent reserve takes the callback, at its least.
    expect(jsonOf(renderCallbackFollowup(callback, { tokens: 1 }))).toMatchObject({ state: "failed", handle: `tor1_${"a".repeat(32)}` });
  });

  it("references full approval arguments instead of substituting empty arguments", () => {
    const result = endedSubagentResult("a", { approvals: [{ arguments: { body: "x".repeat(30_000) }, reason: "approval_required",
      serverName: "Jira", toolName: "create" }], outcome: "blocked", reason: "needs_approval", resultHandle: `tor1_${"a".repeat(32)}` });
    const rendered = renderCallbackResult(result, 2_000);
    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(JSON.parse(rendered)).toMatchObject({ kind: "subagent_result_excerpt", handle: result.resultHandle, reader: "read_tool_result" });
    expect(rendered).not.toContain('"arguments":{}');
  });

  it("names a storage failure without claiming that the main agent can read the omitted text", () => {
    const result = endedSubagentResult("a", { report: "x".repeat(30_000), resultUnavailableReason: "saved_results_budget_reached" });
    expect(renderCallbackResult(result, 2_000)).toContain("could not be saved (saved_results_budget_reached)");
    expect(renderCallbackResult(result, 32_000)).toContain("omitted part cannot be read later");
  });

  it("gives a five-agent fan-out one bounded wake-up text, oldest first, every result marked where it was cut", () => {
    const callbacks = ["a", "b", "c", "d", "e"].map(big);
    const wakeUp = renderWakeUp(callbacks);
    expect(wakeUp.text.length).toBeLessThanOrEqual(SUBAGENT_WAKE_UP_TEXT_CHARACTERS);
    expect(wakeUp.turnIds).toEqual(callbacks.map((callback) => callback.turnId));
    expect(wakeUp.text).toMatch(/^\[Sub-agent callbacks, written by the server, not by the user\]/u);
    expect(wakeUp.text.match(/"reader":"read_tool_result"/gu)).toHaveLength(5);
    // Far more than fit: the oldest go now, the rest stay owed.
    const many = renderWakeUp(Array.from({ length: 60 }, (_, index) => big(`agent-${index}`)));
    expect(many.turnIds[0]).toBe("turn-agent-0");
    expect(many.turnIds.length).toBeLessThan(60);
    expect(many.text.length).toBeLessThanOrEqual(SUBAGENT_WAKE_UP_TEXT_CHARACTERS);
  });
});
