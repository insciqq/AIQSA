import { describe, expect, it } from "vitest";
import { decodeThreadToolActivity } from "../../contracts/chats";
import { summarizeMessageRunToolActivity } from "./prismaRepository";

const at = new Date("2026-10-30T10:00:00.000Z");
const call = (toolName: string, extra: Record<string, unknown> = {}) => ({ completedAt: at, ordinal: 0, providerCallId: `p-${toolName}`,
  roundIndex: 1, startedAt: at, state: "complete", toolName, ...extra });

describe("an answer's steps with a foreground sub-agent", () => {
  it("names the sub-agent on its call_subagent step and marks the calls it made with its thread and turn", () => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, normalizedRequest: {}, status: "complete", userId: "user",
      toolCalls: [
        call("call_subagent", { subagentTurns: [{ id: "turn-1", mode: "foreground", thread: { id: "thread-1", name: "shop" } }] }),
        call("fetch_url", { roundIndex: 1, subagentThreadId: "thread-1", subagentTurnId: "turn-1" }),
        call("stop_subagent")
      ] }, "user");
    expect(activity?.calls).toEqual([
      expect.objectContaining({ subagent: { mode: "foreground", name: "shop", threadId: "thread-1", turnId: "turn-1" },
        toolName: "call_subagent" }),
      expect.objectContaining({ subagentThreadId: "thread-1", subagentTurnId: "turn-1", toolName: "fetch_url" }),
      expect.not.objectContaining({ subagent: expect.anything() })
    ]);
    // Identifiers only: never a brief, a report or an argument.
    expect(JSON.stringify(activity)).not.toMatch(/brief|report|arguments/u);
  });

  it("counts only the main agent's rounds toward the answer's round limit", () => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, status: "complete", userId: "user",
      normalizedRequest: { toolBudgets: { maxToolCalls: 10, maxToolRounds: 2 } },
      toolCalls: [call("call_subagent"), call("fetch_url", { roundIndex: 2, subagentThreadId: "thread-1", subagentTurnId: "turn-1" }),
        call("fetch_url", { roundIndex: 3, subagentThreadId: "thread-1", subagentTurnId: "turn-1" })] });
    expect(activity?.warning).toBeUndefined();
  });

  it("is a shape the chat wire decodes", () => {
    const activity = summarizeMessageRunToolActivity({ errorPayload: null, normalizedRequest: {}, status: "complete", userId: "user",
      toolCalls: [call("call_subagent", { subagentTurns: [{ id: "turn-1", mode: "foreground", thread: { id: "thread-1", name: "shop" } }] }),
        call("fetch_url", { subagentThreadId: "thread-1", subagentTurnId: "turn-1" })] });
    expect(decodeThreadToolActivity(JSON.parse(JSON.stringify(activity)))).toEqual(activity);
  });
});
