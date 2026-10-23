import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { ModelToolCall } from "../tools/types";
import { NO_MORE_TOOLS_OUTPUT, runAgentLoop, type AgentLoopPorts } from "./loop";
import type { ToolBatchOutcome } from "./toolBatch";
import type { TranscriptItem, TranscriptUserItem } from "./transcript";

function response(text: string, calls: readonly ModelToolCall[] = []): ProviderRunResult {
  return { finalProviderResponsePreview: {}, finalText: text, toolCalls: [...calls], usage: {} };
}

function call(id: string, name = "lookup"): ModelToolCall {
  return { arguments: {}, id, name };
}

function harness(responses: readonly ProviderRunResult[], options: Partial<{
  batch: (calls: readonly ModelToolCall[]) => Partial<ToolBatchOutcome>;
  closes: boolean[];
  followups: TranscriptUserItem[][];
  maxToolRounds: number;
}> = {}) {
  const items: TranscriptItem[] = [];
  const choices: string[] = [];
  const order: string[] = [];
  let index = 0;
  const closes = [...(options.closes ?? [])];
  const followups = [...(options.followups ?? [])];
  const ports: AgentLoopPorts = {
    append: vi.fn(async (added: readonly TranscriptItem[]) => { order.push("append"); items.push(...added); }),
    appendCalls: vi.fn(async (added: readonly TranscriptItem[]) => { order.push("appendCalls"); items.push(...added); }),
    callModel: vi.fn(async () => responses[Math.min(index++, responses.length - 1)]!),
    closeFollowups: vi.fn(async () => closes.shift() ?? true),
    deliverFollowups: vi.fn(async () => followups.shift() ?? []),
    maxToolRounds: options.maxToolRounds ?? 8,
    prepareRequest: vi.fn(async ({ toolChoice }) => {
      choices.push(toolChoice);
      return { toolChoice } as ProviderRunRequest;
    }),
    responseItems: (result) => [{ id: `a${index}`, kind: "assistant_text", text: result.finalText }],
    roundEnd: vi.fn(async () => { order.push("roundEnd"); }),
    roundStart: vi.fn(async () => undefined),
    runTools: vi.fn(async (calls: readonly ModelToolCall[]): Promise<ToolBatchOutcome> => ({
      approvals: [], budgetExhausted: false, executed: calls.length,
      results: calls.map((entry: ModelToolCall) => ({ callId: entry.id, id: `r-${entry.id}`, kind: "tool_result" as const, name: entry.name,
        outcome: "complete" as const, output: "ok" })),
      ...options.batch?.(calls)
    })),
    signal: new AbortController().signal,
    toolTimeLeft: () => true
  };
  return { choices, items, order, ports };
}

describe("native agent loop", () => {
  it("answers directly in one round", async () => {
    const { items, ports } = harness([response("Hi")]);
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 1 });
    expect(items).toHaveLength(1);
  });

  it("runs tool rounds until a response calls no tool", async () => {
    const { items, ports } = harness([response("", [call("c1")]), response("", [call("c2")]), response("Done")]);
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(items.filter((item) => item.kind === "tool_result").map((item) => item.kind === "tool_result" && item.callId))
      .toEqual(["c1", "c2"]);
  });

  it("ends the turn at an approval point with its follow-ups closed", async () => {
    const { ports } = harness([response("", [call("c1", "create")])], { batch: () => ({ approvals: ["approval-1"], executed: 0 }) });
    await expect(runAgentLoop(ports)).resolves.toEqual({ approvals: ["approval-1"], kind: "approval", rounds: 1 });
    expect(ports.callModel).toHaveBeenCalledTimes(1);
    // The answer is published only with its follow-ups closed at the revision it read.
    expect(ports.closeFollowups).toHaveBeenCalledTimes(1);
  });

  it("goes on past an approval point with a follow-up that arrived, and still reports the approval", async () => {
    const followup: TranscriptUserItem = { followup: true, id: "f1", kind: "user", text: "Also tell me the ETA" };
    const { items, ports } = harness([response("", [call("c1", "create")]), response("Waiting for your approval; ETA is Friday.")], {
      batch: () => ({ approvals: ["approval-1"], executed: 0 }), closes: [false, true], followups: [[followup]]
    });
    await expect(runAgentLoop(ports)).resolves.toEqual({ approvals: ["approval-1"], kind: "approval", rounds: 2 });
    expect(items.map((item) => item.id)).toContain("f1");
  });

  it("takes the response's text before any record of it, and records tool calls before running them", async () => {
    const { order, ports } = harness([response("Checking", [call("c1")]), response("Done")]);
    await runAgentLoop(ports);
    expect(order).toEqual(["roundEnd", "appendCalls", "append", "roundEnd", "append"]);
  });

  it("answers without tools once the call budget is spent, and refuses calls made anyway", async () => {
    const { choices, items, ports } = harness([response("", [call("c1")]), response("Stuck", [call("c2")])],
      { batch: () => ({ budgetExhausted: true }) });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    expect(choices).toEqual(["auto", "none"]);
    expect(items.find((item) => item.kind === "tool_result" && item.callId === "c2")).toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });
  });

  it("answers without tools after the last tool round or a batch of which nothing ran", async () => {
    const rounds = harness([response("", [call("c1")]), response("", [call("c2")]), response("Done")], { maxToolRounds: 1 });
    await runAgentLoop(rounds.ports);
    expect(rounds.choices).toEqual(["auto", "none"]);
    const stalled = harness([response("", [call("c1")]), response("Done")], { batch: () => ({ executed: 0 }) });
    await runAgentLoop(stalled.ports);
    expect(stalled.choices).toEqual(["auto", "none"]);
  });

  it("takes a follow-up delivered between rounds or before the answer closes", async () => {
    const followup: TranscriptUserItem = { followup: true, id: "f1", kind: "user", text: "Also B" };
    const { items, ports } = harness([response("A"), response("A and B")], { closes: [false, true], followups: [[followup]] });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    expect(items.map((item) => item.id)).toContain("f1");
  });

  it("keeps closing or delivering until the follow-ups settle, so publication never finds one open", async () => {
    const { ports } = harness([response("A")], { closes: [false, false, false, true] });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 1 });
    expect(ports.closeFollowups).toHaveBeenCalledTimes(4);
    expect(ports.callModel).toHaveBeenCalledTimes(1);
  });

  it("never buys another paid round for a follow-up it could not deliver", async () => {
    const { ports } = harness([response("A")], { closes: [false, false] });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 1 });
    expect(ports.callModel).toHaveBeenCalledTimes(1);
  });
});
