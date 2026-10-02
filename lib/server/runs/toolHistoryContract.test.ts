import { describe, expect, it } from "vitest";
import {
  decodeToolHistorySnapshot,
  isCurrentTurnToolHistory,
  isToolCallRef,
  TOOL_HISTORY_LIMITS,
  toolCallIdFromRef,
  toolCallRef,
  toolCallRefEntry,
  toolCallRefIndex,
  toolHistoryDigest,
  toolHistoryEligible,
  toolHistoryMessageId
} from "./toolHistoryContract";

const callId = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("cross-turn tool history contract", () => {
  it("names a call by an opaque, reversible reference", () => {
    const ref = toolCallRef(callId)!;
    expect(ref).toBe("tcr1_0f8fad5bd9cb469fa16570867728950e");
    expect(isToolCallRef(ref)).toBe(true);
    expect(toolCallIdFromRef(ref)).toBe(callId);
    expect(toolCallRef(callId.toUpperCase())).toBe(ref);
    for (const value of ["tor1_0f8fad5bd9cb469fa16570867728950e", "tcr1_0F8FAD5BD9CB469FA16570867728950E", "tcr1_abc", 7, null]) {
      expect(isToolCallRef(value)).toBe(false);
      expect(toolCallIdFromRef(value)).toBeNull();
    }
    expect(toolCallRef("call-1")).toBeNull();
  });

  it("digests only the immutable identity of calls, in order", () => {
    const calls = [{ id: callId, ordinal: 0, roundIndex: 1, toolName: "mcp_a" }, { id: "1".repeat(8) + "-1111-4111-8111-" + "1".repeat(12),
      ordinal: 1, roundIndex: 1, toolName: "mcp_b" }];
    const digest = toolHistoryDigest(calls);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(toolHistoryDigest(calls.map(call => ({ ...call, extra: "ignored" })))).toBe(digest);
    expect(toolHistoryDigest([...calls].reverse())).not.toBe(digest);
    expect(toolHistoryDigest([{ ...calls[0]!, ordinal: 2 }, calls[1]!])).not.toBe(digest);
  });

  it("decodes exact frozen histories and refuses any other shape", () => {
    const valid = { version: 1, turns: [{ turnMessageId: "answer-1", callRefs: [toolCallRef(callId)!], digest: "a".repeat(64) },
      { turnMessageId: "answer-2", callRefs: [], digest: "b".repeat(64), readerCalls: 3 }], omittedCalls: 4 };
    expect(decodeToolHistorySnapshot(valid)).toEqual(valid);
    expect(decodeToolHistorySnapshot({ version: 1, turns: [] })).toEqual({ version: 1, turns: [] });
    for (const invalid of [
      { version: 2, turns: [] },
      { version: 1, turns: [], extra: true },
      { version: 1, turns: [], omittedCalls: 0 },
      { version: 1, turns: [{ ...valid.turns[0], arguments: {} }] },
      { version: 1, turns: [{ ...valid.turns[0], callRefs: ["tor1_" + "a".repeat(32)] }] },
      { version: 1, turns: [valid.turns[0], valid.turns[0]] },
      { version: 1, turns: [valid.turns[0], { ...valid.turns[0], turnMessageId: "answer-3" }] },
      { version: 1, turns: [{ turnMessageId: "answer-1", callRefs: [], digest: "a".repeat(64) }] },
      { version: 1, turns: [{ ...valid.turns[0], digest: "A".repeat(64) }] }
    ]) expect(decodeToolHistorySnapshot(invalid)).toBeNull();
    const tooMany = { version: 1, turns: [{ turnMessageId: "answer-1", digest: "a".repeat(64),
      callRefs: Array.from({ length: TOOL_HISTORY_LIMITS.calls + 1 }, (_, index) => `tcr1_${index.toString(16).padStart(32, "0")}`) }] };
    expect(decodeToolHistorySnapshot(tooMany)).toBeNull();
  });

  it("makes only runs accepted under the version eligible", () => {
    expect(toolHistoryEligible({ toolHistory: { version: 1, turns: [] } })).toBe(true);
    expect(toolHistoryEligible({})).toBe(false);
    expect(toolHistoryEligible({ toolHistory: { version: 2, turns: [] } })).toBe(false);
  });

  it("recognizes the current turn's record only before its own message", () => {
    const current = { id: "question-2" };
    expect(isCurrentTurnToolHistory({ historyClass: "tool_history", id: toolHistoryMessageId("question-2") }, current)).toBe(true);
    expect(isCurrentTurnToolHistory({ historyClass: "tool_history", id: toolHistoryMessageId("answer-1") }, current)).toBe(false);
    expect(isCurrentTurnToolHistory({ id: toolHistoryMessageId("question-2") }, current)).toBe(false);
  });

  it("indexes this run's persisted calls and refuses an ambiguous provider call id", () => {
    const read = toolCallRef("2".repeat(8) + "-2222-4222-8222-" + "2".repeat(12))!;
    const first = toolCallRefEntry({ id: callId, providerCallId: "call_1", toolName: "read_tool_call", arguments: { call_ref: read } })!;
    expect(first.readRef).toBe(read);
    expect(toolCallRefEntry({ id: callId, providerCallId: "call_1", toolName: "read_tool_call", arguments: { call_ref: "x" } })?.readRef)
      .toBeUndefined();
    const reused = { ...first, ref: toolCallRef("3".repeat(8) + "-3333-4333-8333-" + "3".repeat(12))! };
    const index = toolCallRefIndex([first, reused, { callId: "call_2", name: "mcp", ref: first.ref }]);
    expect(index.has("call_1")).toBe(false);
    expect(index.get("call_2")?.ref).toBe(first.ref);
  });
});
