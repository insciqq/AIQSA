import { describe, expect, it, vi } from "vitest";
import type { McpApprovalRequest } from "../mcp/writeApproval";
import { ToolCallRepeatHistory, TOOL_CALL_REPEAT_BLOCKED } from "../runs/toolCallRepeatGuard";
import { TOOL_CALL_UNKNOWN, UNKNOWN_TOOL_CALL_MESSAGE, unknownToolCall } from "../runs/unknownToolCall";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import { invalidProviderToolArguments } from "../tools/types";
import {
  APPROVAL_PENDING_OUTPUT,
  RUN_SCOPED_RESULT_NOTE,
  runToolBatch,
  ToolBatchInactiveError,
  transcriptRecord,
  UNKNOWN_OUTCOME_APPROVAL_OUTPUT,
  UNKNOWN_OUTCOME_REPEAT_OUTPUT,
  type ToolBatchDeps
} from "./toolBatch";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { EngineTool, EngineToolEffects, ToolRegistry } from "./toolRegistry";
import { TOOL_RESULT_LIMITS } from "./toolResults";
import { createUnknownEffects } from "./unknownEffects";

function definition(name: string): RunTool {
  return { capability: "mcp", description: name, inputSchema: { type: "object" }, name };
}

function tool(name: string, effects: EngineToolEffects, execute: EngineTool["execute"], extra: Partial<EngineTool> = {}): EngineTool {
  return { activity: () => ({ origin: "mcp" }), definition: definition(name), effects, execute, observationSource: "mcp", ...extra };
}

function ok(call: ModelToolCall, text = "done"): ToolExecutionResult {
  return { callId: call.id, content: [{ text, type: "text" }], name: call.name, status: "complete" };
}

function fakeStore(options: Readonly<{ gated?: boolean; inactive?: boolean }> = {}) {
  const rows = new Map<string, ToolCallRow>();
  const make = (input: Readonly<{ arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number;
    toolName: string }>, state: ToolCallRow["state"], result: ToolCallRow["result"], started: boolean): ToolCallRow => {
    const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${input.roundIndex}-${input.ordinal}`,
      ordinal: input.ordinal, providerCallId: input.providerCallId, result, roundIndex: input.roundIndex,
      startedAt: started ? new Date().toISOString() : null, state, toolName: input.toolName };
    rows.set(row.id, row);
    return row;
  };
  const store = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      if (options.inactive) return { kind: "inactive" };
      if (input.approval && options.gated) return { approvalId: "approval-1", kind: "gated", row: make(input, "error", null, false) };
      return { kind: "running", row: make(input, "running", null, true) };
    }),
    refuse: vi.fn(async (input) => options.inactive ? null : make(input, "error", input.result, false)),
    settle: vi.fn(async (input) => {
      const row = rows.get(input.callId)!;
      rows.set(row.id, { ...row, result: input.result, state: input.state });
      return true;
    })
  } satisfies ToolCallStore;
  return { rows, store };
}

function deps(registry: Record<string, EngineTool>, store: ToolCallStore, overrides: Partial<ToolBatchDeps> = {}): ToolBatchDeps {
  const registryValue: ToolRegistry = { definitions: () => Object.values(registry).map((entry) => entry.definition),
    resolve: (name) => registry[name] };
  return {
    chatId: "chat", history: new ToolCallRepeatHistory(), maxToolCalls: 10, onEvent: vi.fn(async () => undefined),
    onLiveEvent: vi.fn(), registry: registryValue, runId: "run",
    saveResult: vi.fn(async () => ({ handle: `tor1_${"b".repeat(32)}` })),
    signal: new AbortController().signal, sleep: vi.fn(async () => undefined), store, unknownEffects: createUnknownEffects(), userId: "user",
    ...overrides
  };
}

const approval: McpApprovalRequest = { argumentsDigest: "a".repeat(64), definitionHash: "b".repeat(64), serverId: "jira",
  serverName: "Jira", toolName: "mcp_jira_create", toolTitle: "Create" };

describe("native tool batch", () => {
  it("runs calls in order and refuses unknown tools and invalid arguments without running them", async () => {
    const lookup = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call, `found ${String(call.arguments.id)}`));
    const { rows, store } = fakeStore();
    const outcome = await runToolBatch(deps({ lookup: tool("lookup", "none", lookup) }, store), { calls: 0 }, { round: 1, calls: [
      { arguments: { id: 1 }, id: "c1", name: "lookup" },
      { arguments: {}, id: "c2", name: "made_up" },
      { arguments: invalidProviderToolArguments(), id: "c3", name: "lookup" },
      { arguments: { id: 2 }, id: "c4", name: "lookup" }
    ] });
    expect(outcome.results.map((item) => [item.callId, item.outcome])).toEqual([
      ["c1", "complete"], ["c2", "error"], ["c3", "error"], ["c4", "complete"]
    ]);
    expect(outcome.results[0]!.output).toBe("found 1");
    expect(lookup).toHaveBeenCalledTimes(2);
    const unknown = [...rows.values()].find((row) => row.providerCallId === "c2")!;
    expect(JSON.stringify(unknown.result)).toContain(TOOL_CALL_UNKNOWN);
    expect(outcome.results[1]!.output).toBe(UNKNOWN_TOOL_CALL_MESSAGE);
  });

  it("tells a call of a replaced tool what to use instead, and records it as an unknown call", async () => {
    const { rows, store } = fakeStore();
    const batch = deps({ lookup: tool("lookup", "none", vi.fn()) }, store);
    const registry: ToolRegistry = { ...batch.registry,
      replacement: (name) => name === "save_skill" ? "save_skill is not available in this chat. Use manage_skill instead." : undefined };
    const outcome = await runToolBatch({ ...batch, registry }, { calls: 0 }, { round: 1, calls: [
      { arguments: { directory: "/workspace/project/x" }, id: "c1", name: "save_skill" },
      { arguments: {}, id: "c2", name: "made_up" }
    ] });
    expect(outcome.results.map((item) => [item.outcome, item.output])).toEqual([
      ["error", "save_skill is not available in this chat. Use manage_skill instead."], ["error", UNKNOWN_TOOL_CALL_MESSAGE]
    ]);
    // The step list reads both as the plain unknown calls they are.
    for (const row of rows.values()) expect(unknownToolCall({ ...row, result: row.result as never })).not.toBeNull();
    expect(outcome.executed).toBe(0);
  });

  it("ends at the approval point: a gated call is not sent and gets a waiting result", async () => {
    const create = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call));
    const { store } = fakeStore({ gated: true });
    const outcome = await runToolBatch(deps({ create: tool("create", "external", create, { approval: () => approval }) }, store),
      { calls: 0 }, { calls: [{ arguments: { title: "x" }, id: "c1", name: "create" }], round: 1 });
    expect(create).not.toHaveBeenCalled();
    expect(outcome.approvals).toEqual(["approval-1"]);
    expect(outcome.results[0]).toMatchObject({ outcome: "error", output: APPROVAL_PENDING_OUTPUT });
  });

  it("retries a read-only call that failed in transport but never re-sends an external one", async () => {
    const network = () => Object.assign(new TypeError("fetch failed"), {});
    let reads = 0;
    const read = vi.fn(async ({ call }: { call: ModelToolCall }) => {
      reads += 1;
      if (reads < 3) throw network();
      return ok(call);
    });
    const write = vi.fn(async () => { throw network(); });
    const { store } = fakeStore();
    const outcome = await runToolBatch(deps({ read: tool("read", "none", read), write: tool("write", "external", write) }, store),
      { calls: 0 }, { calls: [{ arguments: {}, id: "c1", name: "read" }, { arguments: {}, id: "c2", name: "write" }], round: 1 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]!.outcome).toBe("complete");
    expect(outcome.results[1]!.outcome).toBe("unknown");
    expect(outcome.results[1]!.output).toContain("effect is unknown");
  });

  it("never sends an external call again after an identical one's outcome became unknown", async () => {
    // Regression: a write whose transport failed was sent a second time when the model asked again.
    const write = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const { store } = fakeStore();
    const batch = deps({ write: tool("write", "external", write) }, store);
    const state = { calls: 0 };
    const first = await runToolBatch(batch, state, { calls: [{ arguments: { title: "one issue" }, id: "c1", name: "write" }], round: 1 });
    expect(first.results[0]!.outcome).toBe("unknown");
    const again = await runToolBatch(batch, state, { calls: [{ arguments: { title: "one issue" }, id: "c2", name: "write" }], round: 2 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(again.results[0]).toMatchObject({ outcome: "error", output: UNKNOWN_OUTCOME_REPEAT_OUTPUT });
    expect(JSON.stringify((store.refuse.mock.calls.at(-1)![0] as { result: unknown }).result)).toContain("tool_outcome_unknown_repeat");
    // Other arguments are another effect; after the user wrote, the model may send it again.
    await runToolBatch(batch, state, { calls: [{ arguments: { title: "another issue" }, id: "c3", name: "write" }], round: 3 });
    expect(write).toHaveBeenCalledTimes(2);
    batch.unknownEffects.userSpoke();
    await runToolBatch(batch, state, { calls: [{ arguments: { title: "one issue" }, id: "c4", name: "write" }], round: 4 });
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("asks the user in the approval card before an MCP call equivalent to one with an unknown outcome, whatever the consent", async () => {
    const create = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call));
    const { store } = fakeStore({ gated: true });
    // Always allowed: the tool asks for no approval of its own.
    const batch = deps({ create: tool("create", "external", create, { retryApproval: () => approval }) }, store);
    batch.unknownEffects.record({ arguments: { title: "x" }, name: "create" }, "unknown");
    batch.unknownEffects.userSpoke();
    const outcome = await runToolBatch(batch, { calls: 0 }, { calls: [{ arguments: { title: "x" }, id: "c1", name: "create" }], round: 1 });
    expect(create).not.toHaveBeenCalled();
    expect(store.begin).toHaveBeenCalledWith(expect.objectContaining({ approval }));
    expect(outcome.approvals).toEqual(["approval-1"]);
    expect(outcome.results[0]).toMatchObject({ outcome: "error", output: UNKNOWN_OUTCOME_APPROVAL_OUTPUT });
    // The answer places the approval card; the model is never told where it is.
    expect(UNKNOWN_OUTCOME_APPROVAL_OUTPUT).not.toMatch(/above|below/u);
  });

  it("sends the continuation's approved call with the Allow that names it, and a completed call settles the effect", async () => {
    const create = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call));
    const { store } = fakeStore();
    const batch = deps({ create: tool("create", "external", create, { retryApproval: () => approval }) }, store);
    batch.unknownEffects.record({ arguments: { title: "x" }, name: "create" }, "unknown");
    await runToolBatch(batch, { calls: 0 }, { approved: { approvalId: "approval-9", callId: "c1" },
      calls: [{ arguments: { title: "x" }, id: "c1", name: "create" }], round: 0 });
    expect(store.begin).toHaveBeenCalledWith(expect.objectContaining({ approval, approvedBy: "approval-9", providerCallId: "c1" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(batch.unknownEffects.find({ arguments: { title: "x" }, name: "create" })).toBeNull();
  });

  it("hands the model the result even when the call's record cannot be settled", async () => {
    const write = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call, "created"));
    const { store } = fakeStore();
    store.settle.mockRejectedValueOnce(new Error("database restarted"));
    const retried = await runToolBatch(deps({ write: tool("write", "external", write) }, store), { calls: 0 },
      { calls: [{ arguments: { title: "a" }, id: "c1", name: "write" }], round: 1 });
    expect(retried.results[0]).toMatchObject({ outcome: "complete", output: "created" });
    expect(store.settle).toHaveBeenCalledTimes(2);
    store.settle.mockRejectedValue(new Error("database down"));
    const unsettled = await runToolBatch(deps({ write: tool("write", "external", write) }, store), { calls: 0 },
      { calls: [{ arguments: { title: "b" }, id: "c2", name: "write" }], round: 2 });
    expect(unsettled.results[0]).toMatchObject({ outcome: "complete", output: "created" });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("refuses calls beyond the run's call budget", async () => {
    const { store } = fakeStore();
    const outcome = await runToolBatch(deps({ lookup: tool("lookup", "none", async ({ call }) => ok(call)) }, store,
      { maxToolCalls: 1 }), { calls: 0 }, { calls: [{ arguments: { id: 1 }, id: "c1", name: "lookup" },
      { arguments: { id: 2 }, id: "c2", name: "lookup" }], round: 1 });
    expect(outcome.budgetExhausted).toBe(true);
    expect(outcome.results.map((item) => item.outcome)).toEqual(["complete", "error"]);
  });

  it("saves a long result once and hands the model its head, tail and handle", async () => {
    const long = "x".repeat(TOOL_RESULT_LIMITS.inlineChars + 10_000);
    const { rows, store } = fakeStore();
    const batch = deps({ shell: tool("shell", "external", async ({ call }) => ok(call, long)) }, store);
    const outcome = await runToolBatch(batch, { calls: 0 }, { calls: [{ arguments: {}, id: "c1", name: "shell" }], round: 1 });
    expect(batch.saveResult).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]!.handle).toBe(`tor1_${"b".repeat(32)}`);
    expect(outcome.results[0]!.output.length).toBeLessThan(TOOL_RESULT_LIMITS.inlineChars);
    expect([...rows.values()][0]!.state).toBe("complete");
  });

  it("saves every result over the save bound with a handle and shows it whole; a short one and a read of a saved one stay unsaved", async () => {
    const medium = "r".repeat(TOOL_RESULT_LIMITS.saveChars + 1);
    const { store } = fakeStore();
    const batch = deps({
      lookup: tool("lookup", "none", async ({ call }) => ok(call, call.arguments.size === "short" ? "x".repeat(TOOL_RESULT_LIMITS.saveChars) : medium)),
      read_tool_result: tool("read_tool_result", "none", async ({ call }) => ok(call, medium))
    }, store);
    const outcome = await runToolBatch(batch, { calls: 0 }, { round: 1, calls: [
      { arguments: { size: "medium" }, id: "c1", name: "lookup" },
      { arguments: { size: "short" }, id: "c2", name: "lookup" },
      { arguments: { handle: `tor1_${"c".repeat(32)}` }, id: "c3", name: "read_tool_result" }
    ] });
    expect(batch.saveResult).toHaveBeenCalledTimes(1);
    expect(batch.saveResult).toHaveBeenCalledWith(expect.objectContaining({ text: medium, toolCallId: "row-1-0" }));
    expect(outcome.results.map((item) => item.handle)).toEqual([`tor1_${"b".repeat(32)}`, undefined, undefined]);
    expect(outcome.results[0]!.output).toBe(medium);
  });

  it("keeps a run-scoped result whole and unsaved for its run, and only a note for later turns", async () => {
    const long = "m".repeat(TOOL_RESULT_LIMITS.inlineChars + 10_000);
    const { store } = fakeStore();
    const batch = deps({ memory_search: tool("memory_search", "none", async ({ call }) => ok(call, long), { runScopedResult: true }),
      lookup: tool("lookup", "none", async ({ call }) => ok(call, "found")) }, store);
    const outcome = await runToolBatch(batch, { calls: 0 }, { round: 1, calls: [
      { arguments: { query: "q" }, id: "c1", name: "memory_search" }, { arguments: {}, id: "c2", name: "lookup" }
    ] });
    expect(batch.saveResult).not.toHaveBeenCalled();
    expect(outcome.results[0]!.output).toBe(long);
    expect(outcome.results[0]!.handle).toBeUndefined();
    const records = outcome.results.map((item) => transcriptRecord(batch.registry, item));
    expect(records.map((item) => item.kind === "tool_result" ? item.output : null)).toEqual([RUN_SCOPED_RESULT_NOTE, "found"]);
  });

  it("blocks a third identical read after two identical successes", async () => {
    const { store } = fakeStore();
    const batch = deps({ lookup: tool("lookup", "none", async ({ call }) => ok(call, "same")) }, store);
    const state = { calls: 0 };
    for (const round of [1, 2]) {
      await runToolBatch(batch, state, { calls: [{ arguments: { id: 1 }, id: `c${round}`, name: "lookup" }], round });
    }
    const third = await runToolBatch(batch, state, { calls: [{ arguments: { id: 1 }, id: "c3", name: "lookup" }], round: 3 });
    expect(third.results[0]!.outcome).toBe("error");
    expect(third.results[0]!.output).toContain("already returned the same data twice");
    expect(JSON.stringify((store.refuse.mock.calls.at(-1)![0] as { result: unknown }).result)).toContain(TOOL_CALL_REPEAT_BLOCKED);
  });

  it("stops recording once the run is no longer active", async () => {
    const { store } = fakeStore({ inactive: true });
    await expect(runToolBatch(deps({ lookup: tool("lookup", "none", async ({ call }) => ok(call)) }, store), { calls: 0 },
      { calls: [{ arguments: {}, id: "c1", name: "lookup" }], round: 1 })).rejects.toBeInstanceOf(ToolBatchInactiveError);
  });
});
