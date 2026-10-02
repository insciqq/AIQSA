import { describe, expect, it } from "vitest";
import {
  repeatBlockedRounds,
  repeatBlockedToolCallResult,
  roundMadeNoProgress,
  settledRepeatOutcome,
  toolCallOutcomeFingerprint,
  ToolCallRepeatHistory,
  type ToolCallRepeatRow
} from "./toolCallRepeatGuard";
import type { ToolLoopJsonValue } from "./toolLoopPersistence";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";

let sequence = 0;

function row(input: Readonly<{
  arguments?: Record<string, ToolLoopJsonValue>;
  content?: ToolLoopJsonValue;
  name?: string;
  observation?: ToolLoopJsonValue;
  ordinal?: number;
  result?: ToolLoopJsonValue | null;
  round: number;
  startedAt?: string | null;
  state?: ToolCallRepeatRow["state"];
  status?: "complete" | "error";
}>): ToolCallRepeatRow {
  sequence += 1;
  const providerCallId = `provider-${sequence}`;
  const name = input.name ?? "get_record";
  const status = input.status ?? (input.state === "error" ? "error" : "complete");
  return {
    arguments: input.arguments ?? { id: "rec-1" },
    id: `row-${sequence}`,
    ordinal: input.ordinal ?? 0,
    providerCallId,
    result: input.result !== undefined ? input.result : {
      callId: providerCallId, name, status,
      content: input.content ?? [{ type: "text", text: "record rec-1: open" }],
      ...(input.observation ? { observation: input.observation } : {})
    },
    roundIndex: input.round,
    startedAt: input.startedAt === undefined ? "2026-10-02T10:00:00.000Z" : input.startedAt,
    state: input.state ?? "complete",
    toolName: name
  };
}

function descriptor(handle: string, checksum: string): ToolLoopJsonValue {
  return { version: 1, source: "mcp", handle, encoding: "json-utf8-v1", byteSize: 120, checksum,
    maskable: true, sourceTruncated: false };
}

function blockedRow(round: number, repeatOf: readonly [number, number], name = "get_record"): ToolCallRepeatRow {
  const base = row({ round, name });
  return { ...base, startedAt: null, state: "error",
    result: repeatBlockedToolCallResult({ providerCallId: base.providerCallId, repeatOf, toolName: name }) };
}

const call = { arguments: { id: "rec-1" }, toolName: "get_record" };
// Every tool in these fixtures is proven read-only unless a test says otherwise.
const onlyReads = { batch: [], readOnly: () => true };

describe("repeated identical calls without progress", () => {
  it.each(["full", "reference"] as const)("keeps polling a running Workspace process with %s persisted results", (representation) => {
    const name = namespacedWorkspaceToolName("sandbox_exec_poll");
    const poll = { arguments: { execSessionId: "exec-1", cursor: 0 }, toolName: name };
    const rows = [1, 2, 3].map(round => {
      const observation = { ...descriptor(`tor1_${String(round).repeat(32)}`, "a".repeat(64)) as object, source: "workspace" };
      return row({ round, name, arguments: poll.arguments,
        content: representation === "full"
          ? [{ type: "text", text: JSON.stringify({ data: { done: false, events: [], exitStatus: null, nextCursor: 0 } }) }]
          : [{ type: "json", value: { observation, reader: "read_tool_result" } }],
        ...(representation === "reference" ? { observation } : {}) });
    });
    const live = new ToolCallRepeatHistory();
    for (const current of rows) {
      live.record(current);
      expect(live.noteFor(current.id)).toBeUndefined();
      expect(live.blockFor(poll, current.roundIndex + 1, { batch: [poll], readOnly: () => false })).toBeNull();
    }
    // Recovery makes the same decision from the JSON-persisted rows alone.
    const recovered = new ToolCallRepeatHistory(JSON.parse(JSON.stringify(rows)));
    expect(recovered.blockFor(poll, 4, { batch: [poll], readOnly: () => false })).toBeNull();
    expect(recovered.noteFor(rows[2]!.id)).toBeUndefined();
  });

  it("lets the second identical call run and marks it, then blocks the third", () => {
    const first = row({ round: 1 });
    const history = new ToolCallRepeatHistory([first]);
    expect(history.blockFor(call, 2, onlyReads)).toBeNull();
    const second = row({ round: 2 });
    history.record(second);
    expect(history.noteFor(first.id)).toBeUndefined();
    expect(history.noteFor(second.id)).toBe("Identical to the result of the same call in round 1; no new data.");
    expect(history.blockFor(call, 3, onlyReads)).toEqual([1, 2]);
    // Arguments are compared canonically.
    expect(history.blockFor({ arguments: { id: "rec-1" }, toolName: "get_record" }, 3, onlyReads)).toEqual([1, 2]);
  });

  it("stops the incident's reread of one handle and range at the third read, not the fifteenth", () => {
    const read = { arguments: { handle: "tor1_" + "a".repeat(32), offset: 0, length: 4096 }, toolName: "read_tool_result" };
    const history = new ToolCallRepeatHistory();
    const decisions: Array<readonly [number, number] | null> = [];
    for (let round = 1; round <= 15; round += 1) {
      const blocked = history.blockFor(read, round, onlyReads);
      decisions.push(blocked);
      history.record(blocked ? blockedRow(round, blocked, read.toolName) : row({ round, name: read.toolName,
        arguments: read.arguments, content: [{ type: "json", value: { text: "same bytes", nextOffset: null } }] }));
    }
    expect(decisions.slice(0, 2)).toEqual([null, null]);
    expect(decisions.slice(2).every(decision => decision !== null && decision[0] === 1 && decision[1] === 2)).toBe(true);
  });

  it("never blocks other arguments, another tool or a changed result", () => {
    const history = new ToolCallRepeatHistory([row({ round: 1 }), row({ round: 2 })]);
    expect(history.blockFor({ arguments: { id: "rec-2" }, toolName: "get_record" }, 3, onlyReads)).toBeNull();
    expect(history.blockFor({ arguments: { id: "rec-1" }, toolName: "get_status" }, 3, onlyReads)).toBeNull();
    const changed = new ToolCallRepeatHistory([row({ round: 1 }),
      row({ round: 2, content: [{ type: "text", text: "record rec-1: closed" }] })]);
    expect(changed.blockFor(call, 3, onlyReads)).toBeNull();
  });

  it("never blocks a find_tools search with another query, only the same query", () => {
    const search = (query: string) => ({ arguments: { query }, toolName: MCP_FIND_TOOLS_NAME });
    const noMatch = [{ type: "json", value: { loaded: [], message: "No matching tools." } }];
    const history = new ToolCallRepeatHistory([1, 2].map(round =>
      row({ round, name: MCP_FIND_TOOLS_NAME, arguments: search("weather").arguments, content: noMatch })));
    expect(history.blockFor(search("forecast"), 3, { batch: [search("forecast")], readOnly: () => true })).toBeNull();
    expect(history.blockFor(search("weather"), 3, { batch: [search("weather")], readOnly: () => true })).toEqual([1, 2]);
  });

  it("allows a retry after an error, busy, cancelled or unknown outcome", () => {
    for (const failed of [
      row({ round: 3, state: "error", status: "error", content: [{ type: "text", text: "tool_observation_busy: busy" }] }),
      // An inner error under a completed call is not a success either.
      row({ round: 3, state: "complete", status: "error" }),
      row({ round: 3, state: "cancelled", result: null }),
      row({ round: 3, state: "running", result: null })
    ]) {
      const history = new ToolCallRepeatHistory([row({ round: 1 }), row({ round: 2 }), failed]);
      expect(history.blockFor(call, 4, onlyReads)).toBeNull();
    }
    expect(toolCallOutcomeFingerprint(row({ round: 1, state: "complete", status: "error" }))).toBeNull();
  });

  it("keeps blocking after a block: a blocked row is never the latest outcome", () => {
    const history = new ToolCallRepeatHistory([row({ round: 1 }), row({ round: 2 }), blockedRow(3, [1, 2])]);
    expect(history.blockFor(call, 4, onlyReads)).toEqual([1, 2]);
  });

  it("decides duplicates inside one batch only from earlier rounds", () => {
    const history = new ToolCallRepeatHistory([row({ round: 1, ordinal: 0 }), row({ round: 1, ordinal: 1 })]);
    expect(history.blockFor(call, 2, onlyReads)).toBeNull();
    history.record(row({ round: 2 }));
    expect(history.blockFor(call, 3, onlyReads)).toEqual([1, 2]);
  });

  it("recognizes two retained MCP executions with equal data and different handles as identical", () => {
    const checksum = "c".repeat(64);
    const first = row({ round: 1, name: "list_records", observation: descriptor("tor1_" + "1".repeat(32), checksum),
      content: [{ type: "json", value: { observation: descriptor("tor1_" + "1".repeat(32), checksum), preview: "a" } }] });
    const second = row({ round: 2, name: "list_records", observation: descriptor("tor1_" + "2".repeat(32), checksum),
      content: [{ type: "json", value: { observation: descriptor("tor1_" + "2".repeat(32), checksum), preview: "a" } }] });
    const history = new ToolCallRepeatHistory([first, second]);
    expect(history.noteFor(second.id)).toBe("Identical to the result of the same call in round 1; no new data.");
    expect(history.blockFor({ arguments: { id: "rec-1" }, toolName: "list_records" }, 3, onlyReads)).toEqual([1, 2]);
    const differs = new ToolCallRepeatHistory([first, { ...second, result: { ...(second.result as Record<string, ToolLoopJsonValue>),
      observation: descriptor("tor1_" + "2".repeat(32), "d".repeat(64)) } }]);
    expect(differs.blockFor({ arguments: { id: "rec-1" }, toolName: "list_records" }, 3, onlyReads)).toBeNull();
  });

  it("recognizes a block only by its whole server-owned form", () => {
    const blocked = blockedRow(3, [1, 2]);
    expect(repeatBlockedRounds(blocked)).toEqual([1, 2]);
    expect(roundMadeNoProgress([blocked])).toBe(true);
    // An MCP result that merely mentions the code was dispatched.
    const mentioned = { ...blocked, startedAt: "2026-10-02T10:00:00.000Z" };
    expect(repeatBlockedRounds(mentioned)).toBeNull();
    expect(roundMadeNoProgress([mentioned])).toBe(false);
    const withObservation = { ...blocked, result: { ...(blocked.result as Record<string, ToolLoopJsonValue>),
      observation: descriptor("tor1_" + "3".repeat(32), "e".repeat(64)) } };
    expect(repeatBlockedRounds(withObservation)).toBeNull();
    expect(repeatBlockedRounds({ ...blocked, roundIndex: 2 })).toBeNull();
    expect(roundMadeNoProgress([blocked, row({ round: 3 })])).toBe(false);
    expect(roundMadeNoProgress([])).toBe(false);
  });

  it("explains a block in the projection without changing the comparison basis", () => {
    const first = row({ round: 1 });
    const second = row({ round: 2 });
    const blocked = blockedRow(3, [1, 2]);
    const history = new ToolCallRepeatHistory([first, second, blocked]);
    expect(history.noteFor(blocked.id)).toBe(
      "Not executed: this call already returned the same data twice (rounds 1, 2). Use those results.");
    // The stored second result has no note; only the provider projection does.
    expect(JSON.stringify(second.result)).not.toContain("Identical to the result");
  });

  it("fills a persisted row with the outcome this process settled, never an unknown one", () => {
    const pending = { ...row({ round: 1 }), result: null, startedAt: null, state: "pending" as const };
    const history = new ToolCallRepeatHistory([pending]);
    const value = { callId: pending.providerCallId, name: pending.toolName, status: "complete" as const,
      content: [{ type: "text" as const, text: "record rec-1: open" }] };
    history.settle(pending.id, settledRepeatOutcome({ call: { arguments: {}, id: pending.providerCallId, name: pending.toolName },
      ordinal: 0, round: 1, result: { status: "complete", value } }));
    history.record(row({ round: 2 }));
    expect(history.blockFor(call, 3, onlyReads)).toEqual([1, 2]);
    expect(settledRepeatOutcome({ call: { arguments: {}, id: "x", name: "get_record" }, ordinal: 0, round: 1,
      result: { status: "error", error: { code: "tool_call_timeout", message: "timed out" } } })).toEqual({ result: null, state: "error" });
    // A settled persisted row keeps its stored result.
    history.settle(pending.id, { result: null, state: "error" });
    expect(history.blockFor(call, 3, onlyReads)).toEqual([1, 2]);
  });

  describe("after a call that may change state", () => {
    const shell = (command: string) => ({ arguments: { command }, toolName: "workspace_sandbox_shell" });
    const writes = { batch: [], readOnly: (name: string) => name !== "workspace_sandbox_shell" && name !== "update_record" };
    const run = (round: number, entry: Readonly<{ arguments: Record<string, ToolLoopJsonValue>; toolName: string }>, text: string) =>
      row({ round, name: entry.toolName, arguments: entry.arguments, content: [{ type: "text", text }] });

    it("never blocks a rerun of the same command after an edit, even with unchanged output", () => {
      const history = new ToolCallRepeatHistory([run(1, shell("npm test"), "1 failing"), run(2, shell("apply edit"), "ok"),
        run(3, shell("npm test"), "1 failing"), run(4, shell("apply edit 2"), "ok")]);
      expect(history.blockFor(shell("npm test"), 5, writes)).toBeNull();
      // An edit in the same batch also keeps the call open.
      const quiet = new ToolCallRepeatHistory([run(1, shell("npm test"), "1 failing"), run(2, shell("npm test"), "1 failing")]);
      expect(quiet.blockFor(shell("npm test"), 3, { ...writes, batch: [shell("apply edit 3"), shell("npm test")] })).toBeNull();
      // Without any other command since, the unchanged repeat is still blocked.
      expect(quiet.blockFor(shell("npm test"), 3, { ...writes, batch: [shell("npm test")] })).toEqual([1, 2]);
    });

    it("never blocks an MCP read after a write without readOnlyHint, but blocks unchanged reads after it", () => {
      const get = { arguments: { id: "rec-1" }, toolName: "get_record" };
      const update = { arguments: { id: "rec-1", status: "done" }, toolName: "update_record" };
      const history = new ToolCallRepeatHistory([run(1, get, "open"), run(2, update, "ok"), run(3, get, "open")]);
      expect(history.blockFor(get, 4, writes)).toBeNull();
      history.record(run(4, get, "open"));
      expect(history.blockFor(get, 5, writes)).toEqual([3, 4]);
    });

    it("keeps blocking repeated reads interleaved only with read-only calls", () => {
      const read = { arguments: { handle: "tor1_" + "b".repeat(32) }, toolName: "read_tool_result" };
      const history = new ToolCallRepeatHistory([run(1, read, "same"), run(2, { arguments: {}, toolName: "get_session_status" }, "idle"),
        run(3, read, "same")]);
      expect(history.blockFor(read, 4, writes)).toEqual([1, 3]);
    });
  });
});

describe("call reads fingerprint the hash of their output", () => {
  const ref = "tcr1_" + "a".repeat(32);
  const readRow = (round: number, output: string) => {
    const base = row({ round, name: "read_tool_call", arguments: { call_ref: ref } });
    const settled = settledRepeatOutcome({ call: { arguments: { call_ref: ref }, id: base.providerCallId, name: "read_tool_call" },
      ordinal: 0, round, result: { status: "complete", value: { callId: base.providerCallId, name: "read_tool_call", status: "complete",
        content: [{ type: "json", value: { call_ref: ref, result: { fragment: output } } }] } } });
    return { ...base, result: settled.result, state: settled.state };
  };

  it("keeps only a receipt and compares outputs by its hash", () => {
    const first = readRow(1, "created #5");
    expect(JSON.stringify(first.result)).not.toContain("created #5");
    expect(toolCallOutcomeFingerprint(first)).toMatch(/^read:[a-f0-9]{64}$/u);
    expect(toolCallOutcomeFingerprint(readRow(2, "created #5"))).toBe(toolCallOutcomeFingerprint(first));
    expect(toolCallOutcomeFingerprint(readRow(2, "created #6"))).not.toBe(toolCallOutcomeFingerprint(first));
  });

  it("blocks a third identical read, never one whose output changed", () => {
    const readOnly = () => true;
    const same = new ToolCallRepeatHistory([readRow(1, "x"), readRow(2, "x")]);
    expect(same.blockFor({ arguments: { call_ref: ref }, toolName: "read_tool_call" }, 3, { batch: [], readOnly })).toEqual([1, 2]);
    const changed = new ToolCallRepeatHistory([readRow(1, "x"), readRow(2, "y")]);
    expect(changed.blockFor({ arguments: { call_ref: ref }, toolName: "read_tool_call" }, 3, { batch: [], readOnly })).toBeNull();
  });
});
