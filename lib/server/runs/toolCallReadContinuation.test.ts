import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { readToolCallError } from "../tools/readToolCall";
import type { ToolExecutionResult } from "../tools/types";
import { callReadReplayBudgets } from "./toolCallReadContinuation";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

const read = (chars: number): ToolExecutionResult => ({ callId: "read", name: "read_tool_call", status: "complete",
  content: [{ type: "json", value: { arguments: { fragment: "x".repeat(chars) } } }] });

function persisted(input: Pick<PersistedToolLoopCall, "providerCallId" | "result" | "roundIndex" | "toolName">): PersistedToolLoopCall {
  return { ...input, arguments: {}, completedAt: null, id: `row-${input.providerCallId}`, mcpBinding: null, ordinal: 0,
    startedAt: null, state: "complete" };
}

describe("call reads read again on recovery", () => {
  const share = (tokens: number) => ({ estimateTokens: estimateApproxTokens, tokens });

  it("share their round's delivery allowance, as live reads did, and each round starts afresh", () => {
    const small = read(400);
    // What a delivered read draws: its tokens beyond its deferral, which the batch's floor holds.
    const drawn = estimateApproxTokens(small.content) -
      estimateApproxTokens(readToolCallError({ id: "read", name: "read_tool_call" }, "tool_call_read_deferred").content);
    const budgets = callReadReplayBudgets([], share(Math.floor(drawn * 1.5)));
    expect(budgets(1).fits(read(4_000))).toBe(false);
    const first = budgets(1);
    expect(first.fits(small)).toBe(true);
    first.spend(small);
    // The round's next read draws on what the first one left.
    expect(budgets(1).fits(small)).toBe(false);
    expect(budgets(2).fits(small)).toBe(true);
  });

  it("draw only on what the round's settled results left of it", () => {
    const seed = "settled";
    const settled = { callId: "mcp-1", name: "read_record", status: "complete", content: [{ type: "text", text: "y".repeat(2_000) }],
      observation: { byteSize: 2_000, checksum: createHash("sha256").update(seed).digest("hex"), encoding: "json-utf8-v1", maskable: true,
        handle: `tor1_${createHash("sha256").update(`handle:${seed}`).digest("hex").slice(0, 32)}`, source: "mcp", sourceTruncated: false,
        version: 1 } };
    const small = read(400);
    const allowance = share(estimateApproxTokens(small.content) * 3);
    const calls = [persisted({ providerCallId: "mcp-1", result: settled, roundIndex: 1, toolName: "read_record" }),
      persisted({ providerCallId: "read-1", result: null, roundIndex: 1, toolName: "read_tool_call" })];
    expect(callReadReplayBudgets(calls, allowance)(1).fits(small)).toBe(false);
    // Another round's results draw nothing from it.
    expect(callReadReplayBudgets(calls, allowance)(2).fits(small)).toBe(true);
  });
});
