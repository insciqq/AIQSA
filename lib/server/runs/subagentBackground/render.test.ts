import { describe, expect, it } from "vitest";
import { decodeSubagentCallResult } from "@/lib/contracts/subagents";
import { endedSubagentResult } from "@/tests/support/subagentPorts";
import {
  SUBAGENT_CALLBACK_INLINE_CHARACTERS,
  SUBAGENT_WAKE_UP_TEXT_CHARACTERS,
  renderCallbackFollowup,
  renderCallbackResult,
  renderWakeUp
} from "./render";

const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf("{"))) as unknown;

describe("sub-agent callback rendering", () => {
  it("frames a callback as the server's, with the result as untrusted JSON and no internal identifier", () => {
    const text = renderCallbackFollowup({ name: "researcher", result: endedSubagentResult("researcher", { report: "Found 3" }),
      turnId: "turn-secret-id" });
    expect(text).toMatch(/^\[Sub-agent callback, written by the server, not by the user\] Your background sub-agent "researcher" ended \(done\)/u);
    expect(text).toContain("untrusted data");
    expect(text).not.toContain("turn-secret-id");
    expect(decodeSubagentCallResult(jsonOf(text))).toMatchObject({ kind: "ended", report: "Found 3", state: "done" });
  });

  it("names a failure's reason and keeps a large result decodable in its compact form", () => {
    const steps = Array.from({ length: 100 }, () => ({ outcome: "complete" as const, summary: "x".repeat(240), tool: "browser" }));
    const result = endedSubagentResult("shop", { outcome: undefined, reason: "bot_wall", report: "r".repeat(12_000), state: "failed", steps });
    const rendered = renderCallbackResult(result);
    expect(rendered.length).toBeLessThanOrEqual(SUBAGENT_CALLBACK_INLINE_CHARACTERS);
    const decoded = decodeSubagentCallResult(JSON.parse(rendered));
    expect(decoded).toMatchObject({ reason: "bot_wall", reportTruncated: true, state: "failed", steps: [], stepsTruncated: true });
    expect(renderCallbackFollowup({ name: "shop", result, turnId: "t" })).toContain("(failed, bot_wall)");
  });

  it("puts callbacks close together into one wake-up text, oldest first, and leaves what does not fit owed", () => {
    const big = (name: string) => ({ name, result: endedSubagentResult(name, { report: "q".repeat(11_000) }), turnId: `turn-${name}` });
    const callbacks = Array.from({ length: 12 }, (_, index) => big(`agent-${index}`));
    const wakeUp = renderWakeUp(callbacks);
    expect(wakeUp.text.length).toBeLessThanOrEqual(SUBAGENT_WAKE_UP_TEXT_CHARACTERS);
    expect(wakeUp.turnIds[0]).toBe("turn-agent-0");
    expect(wakeUp.turnIds.length).toBeGreaterThan(1);
    expect(wakeUp.turnIds.length).toBeLessThan(callbacks.length);
    expect(wakeUp.text).toMatch(/^\[Sub-agent callbacks, written by the server, not by the user\]/u);
    expect(renderWakeUp([big("solo")]).turnIds).toEqual(["turn-solo"]);
  });
});
