import { describe, expect, it } from "vitest";
import { decodeSubagentCallResult } from "@/lib/contracts/subagents";
import { endedSubagentResult } from "@/tests/support/subagentPorts";
import { followupTokenCost } from "../runFollowups";
import { SUBAGENT_WAKE_UP_TEXT_CHARACTERS, renderCallbackFollowup, renderCallbackResult, renderWakeUp } from "./render";

const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf("{"))) as unknown;
const big = (name: string) => ({ name, result: endedSubagentResult(name, { report: "q".repeat(12_000),
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

  it("cuts a callback to the room left in its run's follow-up reserve, marked, and keeps it decodable", () => {
    const callback = { ...big("shop"), result: { ...big("shop").result, outcome: undefined, reason: "bot_wall", state: "failed" as const } };
    const text = renderCallbackFollowup(callback, { tokens: 800 });
    expect(followupTokenCost(text)).toBeLessThanOrEqual(800);
    expect(text).toContain("cut to fit; the whole result is kept in the sub-agent's thread");
    expect(text).toContain("(failed, bot_wall)");
    expect(decodeSubagentCallResult(jsonOf(text))).toMatchObject({ reason: "bot_wall", reportTruncated: true, state: "failed", steps: [],
      stepsTruncated: true });
    // Whatever the reserve, a callback fits one follow-up row (`RunFollowup_bounds`).
    expect(renderCallbackFollowup(big("wide"), { tokens: 1_000_000 }).length).toBeLessThanOrEqual(16_000);
    // Even a spent reserve takes the callback, at its least.
    expect(decodeSubagentCallResult(jsonOf(renderCallbackFollowup(callback, { tokens: 1 })))).toMatchObject({ state: "failed" });
  });

  it("keeps the calls a callback hands back for approval named when nothing else fits", () => {
    const approvals = Array.from({ length: 10 }, (_, index) => ({ arguments: { body: "x".repeat(16_000) }, reason: "approval_required" as const,
      serverName: "Jira", toolName: `create_${index}` }));
    const rendered = renderCallbackResult(endedSubagentResult("a", { approvals, outcome: "blocked", reason: "needs_approval" }), 2_000);
    expect(rendered.length).toBeLessThanOrEqual(2_000);
    const decoded = decodeSubagentCallResult(JSON.parse(rendered));
    expect(decoded?.kind === "ended" ? decoded.approvals.map((approval) => [approval.toolName, approval.arguments]) : null)
      .toEqual(Array.from({ length: 10 }, (_, index) => [`create_${index}`, {}]));
  });

  it("gives a five-agent fan-out one bounded wake-up text, oldest first, every result marked where it was cut", () => {
    const callbacks = ["a", "b", "c", "d", "e"].map(big);
    const wakeUp = renderWakeUp(callbacks);
    expect(wakeUp.text.length).toBeLessThanOrEqual(SUBAGENT_WAKE_UP_TEXT_CHARACTERS);
    expect(wakeUp.turnIds).toEqual(callbacks.map((callback) => callback.turnId));
    expect(wakeUp.text).toMatch(/^\[Sub-agent callbacks, written by the server, not by the user\]/u);
    expect(wakeUp.text.match(/"reportTruncated":true/gu)).toHaveLength(5);
    // Far more than fit: the oldest go now, the rest stay owed.
    const many = renderWakeUp(Array.from({ length: 60 }, (_, index) => big(`agent-${index}`)));
    expect(many.turnIds[0]).toBe("turn-agent-0");
    expect(many.turnIds.length).toBeLessThan(60);
    expect(many.text.length).toBeLessThanOrEqual(SUBAGENT_WAKE_UP_TEXT_CHARACTERS);
  });
});
