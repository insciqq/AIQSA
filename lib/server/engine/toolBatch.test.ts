import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import type { McpApprovalRequest } from "../mcp/writeApproval";
import { ToolCallRepeatHistory, TOOL_CALL_REPEAT_BLOCKED } from "../runs/toolCallRepeatGuard";
import { TOOL_CALL_UNKNOWN, UNKNOWN_TOOL_CALL_MESSAGE, unknownToolCall } from "../runs/unknownToolCall";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import { invalidProviderToolArguments } from "../tools/types";
import {
  APPROVAL_PENDING_OUTPUT,
  AUTO_TOOL_NOT_LOADED_OUTPUT,
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
import { SearchToolCancelledError } from "../search/toolExecutor";
import { mixedToolsImagePlan } from "@/tests/support/openRouterTools";
import { workspaceOperationFailureMessage } from "../../contracts/workspaceFailure";
import { ImageInputError, ImageToolError, markImageFailureNotSent } from "../images/inputError";
import { IMAGE_GENERATION_CALLS_PER_ANSWER, IMAGE_GENERATION_TOOL_NAME } from "../tools/imageGeneration";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { buildToolRegistry } from "./toolRegistry";

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
    // An unknown name and malformed arguments are mistakes the model can correct in its next call.
    expect(outcome).toMatchObject({ correctable: 2, executed: 2 });
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
    expect(outcome).toMatchObject({ correctable: 2, executed: 0 });
  });

  it("tells a call of an Auto tool an earlier turn loaded how to load it in this answer", async () => {
    const { store } = fakeStore();
    const batch = deps({ find_tools: tool("find_tools", "none", vi.fn()) }, store);
    const registry: ToolRegistry = { ...batch.registry, mcpLoadCall: (name, id) => name === "mcp_jira_get_issue"
      ? { arguments: { query: `select:${name}` }, id, name: "find_tools" } : undefined };
    const outcome = await runToolBatch({ ...batch, registry }, { calls: 0 }, { round: 1, calls: [
      { arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }, { arguments: {}, id: "c2", name: "made_up" }
    ] });
    expect(outcome.results.map((item) => item.output)).toEqual([AUTO_TOOL_NOT_LOADED_OUTPUT("mcp_jira_get_issue", "select:mcp_jira_get_issue"),
      UNKNOWN_TOOL_CALL_MESSAGE]);
    expect(outcome).toMatchObject({ correctable: 2, executed: 0 });
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
    // The refusal asks for a read-only check, so tools stay open for it (review finding).
    expect(again).toMatchObject({ correctable: 1, executed: 0 });
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

  it("runs the reserved report's first call outside the call budget, and counts a repeated one", async () => {
    const report = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call, "recorded"));
    const lookup = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call));
    const { store } = fakeStore();
    const batch = deps({ lookup: tool("lookup", "none", lookup), report_monitoring_result: tool("report_monitoring_result", "local", report) },
      store, { maxToolCalls: 1, reservedToolName: "report_monitoring_result" });
    const state = { calls: 1 };
    // The budget is spent: only the report's first call still runs, and it costs nothing.
    const first = await runToolBatch(batch, state, { calls: [
      { arguments: { status: "update" }, id: "v1", name: "report_monitoring_result" },
      { arguments: { id: 1 }, id: "c1", name: "lookup" },
      { arguments: { status: "no_update" }, id: "v2", name: "report_monitoring_result" }
    ], round: 2 });
    expect(first.results.map((item) => [item.callId, item.outcome])).toEqual([["v1", "complete"], ["c1", "error"], ["v2", "error"]]);
    expect(first.budgetExhausted).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(state).toEqual({ calls: 1, reservedCalled: true });
    // A first report refused before running (malformed arguments) keeps the reservation for the corrected one.
    const spent = deps({ report_monitoring_result: tool("report_monitoring_result", "local", report) }, fakeStore().store,
      { maxToolCalls: 1, reservedToolName: "report_monitoring_result" });
    const malformed = { calls: 1 };
    const refused = await runToolBatch(spent, malformed, { calls: [
      { arguments: invalidProviderToolArguments(), id: "v4", name: "report_monitoring_result" }
    ], round: 2 });
    expect(refused.results[0]).toMatchObject({ callId: "v4", outcome: "error" });
    expect(malformed).toEqual({ calls: 1 });
    const corrected = await runToolBatch(spent, malformed, { calls: [
      { arguments: { status: "update" }, id: "v5", name: "report_monitoring_result" }
    ], round: 3 });
    expect(corrected.results[0]).toMatchObject({ callId: "v5", outcome: "complete" });
    expect(report).toHaveBeenCalledTimes(2);
    expect(malformed).toEqual({ calls: 1, reservedCalled: true });
    // Within budget, a repeated report counts like any other call.
    const later = { calls: 0, reservedCalled: true };
    await runToolBatch(deps({ report_monitoring_result: tool("report_monitoring_result", "local", report) }, fakeStore().store,
      { maxToolCalls: 5, reservedToolName: "report_monitoring_result" }), later,
      { calls: [{ arguments: { status: "update" }, id: "v3", name: "report_monitoring_result" }], round: 3 });
    expect(later.calls).toBe(1);
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
    const binding = { fingerprint: "f".repeat(64), originalName: "lookup", revisionId: "rev-1", serverId: "jira", source: "mcp", version: 1 } as const;
    const batch = deps({
      lookup: tool("lookup", "none", async ({ call }) => ok(call, call.arguments.size === "short" ? "x".repeat(TOOL_RESULT_LIMITS.saveChars) : medium),
        { observationBinding: () => binding }),
      read_tool_result: tool("read_tool_result", "none", async ({ call }) => ok(call, medium))
    }, store);
    const outcome = await runToolBatch(batch, { calls: 0 }, { round: 1, calls: [
      { arguments: { size: "medium" }, id: "c1", name: "lookup" },
      { arguments: { size: "short" }, id: "c2", name: "lookup" },
      { arguments: { handle: `tor1_${"c".repeat(32)}` }, id: "c3", name: "read_tool_result" }
    ] });
    expect(batch.saveResult).toHaveBeenCalledTimes(1);
    expect(batch.saveResult).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp", sourceBinding: binding, text: medium,
      toolCallId: "row-1-0" }));
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

  it("never blocks reading a saved result again, which a compaction may have dropped from the context", async () => {
    const read = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call, "same part"));
    const { store } = fakeStore();
    const batch = deps({ read_tool_result: tool("read_tool_result", "none", read) }, store);
    const state = { calls: 0 };
    for (const round of [1, 2, 3]) {
      const outcome = await runToolBatch(batch, state, { round,
        calls: [{ arguments: { handle: `tor1_${"c".repeat(32)}`, offset: 0 }, id: `c${round}`, name: "read_tool_result" }] });
      expect(outcome).toMatchObject({ executed: 1 });
    }
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("stops recording once the run is no longer active", async () => {
    const { store } = fakeStore({ inactive: true });
    await expect(runToolBatch(deps({ lookup: tool("lookup", "none", async ({ call }) => ok(call)) }, store), { calls: 0 },
      { calls: [{ arguments: {}, id: "c1", name: "lookup" }], round: 1 })).rejects.toBeInstanceOf(ToolBatchInactiveError);
  });

  it("logs one content-free tool_call record per settled call, whatever settled it", async () => {
    const observation = await captureRunObservation();
    const { store } = fakeStore({ gated: true });
    const registry = {
      lookup: tool("lookup", "none", async ({ call }) => ok(call, "PRIVATE_RESULT")),
      broken: tool("broken", "none", async () => { throw new Error("PRIVATE_FAILURE"); }),
      write: tool("write", "external", async () => { throw new Error("PRIVATE_FAILURE"); }),
      create: tool("create", "external", vi.fn(), { approval: () => approval })
    };
    await runToolBatch(deps(registry, store, { maxToolCalls: 4 }), { calls: 0 }, { round: 1, calls: [
      { arguments: { q: "PRIVATE_ARG" }, id: "c1", name: "lookup" },
      { arguments: {}, id: "c2", name: "PRIVATE_MADE_UP" },
      { arguments: invalidProviderToolArguments(), id: "c3", name: "lookup" },
      { arguments: {}, id: "c4", name: "broken" },
      { arguments: {}, id: "c5", name: "write" },
      { arguments: {}, id: "c6", name: "create" },
      { arguments: { q: "other" }, id: "c7", name: "lookup" }
    ] });
    const records = observation.records().filter((record) => record.event === "tool_call");
    expect(records.map((record) => [record.tool_kind, record.outcome, record.code ?? null, record.error_category ?? null].join(" ")).sort())
      .toEqual([
        "mcp awaiting_approval mcp_approval_required ",
        "mcp completed  ",
        "mcp failed tool_arguments_invalid ",
        "mcp failed tool_call_limit_reached ",
        "mcp failed tool_call_outcome_unknown unexpected",
        "mcp failed tool_execution_failed unexpected",
        "other failed tool_call_unknown "
      ]);
    expect(records.filter((record) => record.outcome === "completed")[0]).toHaveProperty("duration_ms");
    expect(JSON.stringify(observation.records())).not.toMatch(/PRIVATE_|lookup|"write"|"c[1-7]"/u);
  });

  it("settles each sent call's live step under its own identity, and none for a call that was never sent", async () => {
    // Regression (#61): a step kept spinning until the whole run ended because only `requested` was ever sent.
    const { store } = fakeStore({ gated: true });
    const registry = {
      lookup: tool("lookup", "none", async ({ call }) => ok(call, "PRIVATE_RESULT"), {
        activity: () => ({ origin: "mcp", serverName: "Repository Tools" }) }),
      failing: tool("failing", "none", async ({ call }) => ({ ...ok(call, "PRIVATE_RESULT"), status: "error" })),
      broken: tool("broken", "none", async () => { throw new Error("PRIVATE_FAILURE"); }),
      write: tool("write", "external", async () => { throw new Error("PRIVATE_FAILURE"); }),
      shell: tool("shell", "external", async () => { throw new WorkspaceRuntimeError("workspace_tool_timeout"); }),
      create: tool("create", "external", vi.fn(), { approval: () => approval }),
      unbound: tool("unbound", "none", vi.fn(), { links: () => null })
    };
    const batch = deps(registry, store);
    await runToolBatch(batch, { calls: 0 }, { firstOrdinal: 1, round: 2, calls: [
      { arguments: { q: "PRIVATE_ARG" }, id: "c1", name: "lookup" },
      { arguments: {}, id: "c2", name: "failing" },
      { arguments: {}, id: "c3", name: "broken" },
      { arguments: {}, id: "c4", name: "write" },
      { arguments: {}, id: "c5", name: "shell" },
      { arguments: {}, id: "c6", name: "create" },
      { arguments: {}, id: "c7", name: "made_up" },
      { arguments: invalidProviderToolArguments(), id: "c8", name: "lookup" },
      { arguments: {}, id: "c9", name: "unbound" },
      { arguments: { q: "other" }, id: "c10", name: "lookup" }
    ] });
    const live = vi.mocked(batch.onLiveEvent).mock.calls.map(([event]) => event)
      .flatMap((event) => event.type === "artifact" && event.data.artifactType === "tool_call"
        ? [event.data.payload as Record<string, unknown>] : []);
    const byOrdinal = new Map<unknown, Record<string, unknown>[]>();
    for (const payload of live) byOrdinal.set(payload.ordinal, [...byOrdinal.get(payload.ordinal) ?? [], payload]);
    // Ordinals follow the round's order after `firstOrdinal`; refused, gated and unbound calls are never announced.
    expect([...byOrdinal.keys()].map(Number).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 10]);
    expect(Object.fromEntries([...byOrdinal].map(([ordinal, events]) => [ordinal, events.map((event) => event.status)]))).toEqual({
      1: ["requested", "complete"], 2: ["requested", "error"], 3: ["requested", "error"],
      // An unknown effect and a time limit never read as success.
      4: ["requested", "error"], 5: ["requested", "error"], 10: ["requested", "complete"]
    });
    for (const [requested, settled] of byOrdinal.values()) {
      const { durationMs, status: _settledStatus, ...settledIdentity } = settled!;
      const { status: _requestedStatus, ...requestedIdentity } = requested!;
      expect(settledIdentity).toEqual(requestedIdentity);
      expect(requested).not.toHaveProperty("durationMs");
      expect(Number.isSafeInteger(durationMs) && Number(durationMs) >= 0).toBe(true);
    }
    // Two calls of the same tool on the same server in one round differ only by their ordinal.
    expect(byOrdinal.get(1)![0]).toEqual({ name: "lookup", ordinal: 1, origin: "mcp", round: 2, serverName: "Repository Tools",
      status: "requested" });
    expect(JSON.stringify(live)).not.toMatch(/PRIVATE_|"c\d+"/u);
  });

  it("sends no settled step for a call its run stopped", async () => {
    const controller = new AbortController();
    const { store } = fakeStore();
    const batch = deps({ slow: tool("slow", "none", async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) }, store, { signal: controller.signal });
    await expect(runToolBatch(batch, { calls: 0 }, { calls: [{ arguments: {}, id: "c1", name: "slow" }], round: 1 })).rejects.toBeDefined();
    const statuses = vi.mocked(batch.onLiveEvent).mock.calls.flatMap(([event]) =>
      event.type === "artifact" && event.data.artifactType === "tool_call" ? [(event.data.payload as { status: string }).status] : []);
    expect(statuses).toEqual(["requested"]);
  });

  it("tells the model a Workspace time limit, keeps its effect unknown and logs a timeout, not an unexpected failure", async () => {
    const observation = await captureRunObservation();
    const workspaceTool = (name: string, execute: EngineTool["execute"]) =>
      tool(name, "external", execute, { definition: { ...definition(name), capability: "workspace" } });
    const registry = {
      shell: workspaceTool("shell", async () => { throw new WorkspaceRuntimeError("workspace_tool_timeout"); }),
      lost: workspaceTool("lost", async () => { throw new WorkspaceRuntimeError("workspace_tool_outcome_unknown"); })
    };
    const { store } = fakeStore();
    const batch = deps(registry, store);
    const outcome = await runToolBatch(batch, { calls: 0 }, { round: 1, calls: [
      { arguments: { command: "PRIVATE_COMMAND" }, id: "c1", name: "shell" }, { arguments: {}, id: "c2", name: "lost" }
    ] });
    expect(outcome.results[0]).toMatchObject({ outcome: "unknown",
      output: expect.stringContaining(workspaceOperationFailureMessage("workspace_tool_timeout")) });
    expect(outcome.results[0]!.output).not.toContain("may have been sent");
    expect(outcome.results[1]).toMatchObject({ outcome: "unknown", output: expect.stringContaining("may have been sent") });
    // The command may have changed files: an identical one is not sent again on its own.
    expect(batch.unknownEffects.find({ arguments: { command: "PRIVATE_COMMAND" }, name: "shell" })).not.toBeNull();
    const records = observation.records().filter((record) => record.event === "tool_call");
    expect(records.map((record) => [record.level, record.outcome, record.code, record.error_category ?? null])).toEqual([
      ["warn", "timeout", "workspace_tool_timeout", null],
      ["error", "failed", "tool_call_outcome_unknown", "unexpected"]
    ]);
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE_");
  });

  describe("image calls", () => {
    const imageCall = (id: string, imageIds: string[] = []) =>
      ({ arguments: { image_ids: imageIds, prompt: "PRIVATE_PROMPT" }, id, name: IMAGE_GENERATION_TOOL_NAME });

    async function imageBatch(execute: (call: ModelToolCall) => Promise<ToolExecutionResult>) {
      const registry = await buildToolRegistry({
        chatId: "chat", followupTexts: () => [], mcpBindings: new Map(), onEvent: vi.fn(async () => undefined), onUsage: vi.fn(),
        onWorkspaceActivity: vi.fn(async () => undefined), runId: "run", userId: "user",
        request: { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] }, imagePlan: mixedToolsImagePlan,
          modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
          modelId: "model", params: {}, prompt: { developer: null, system: null }, provider: "codex",
          searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto" },
        services: { images: { execute: vi.fn(execute), withConversationPixels: vi.fn() }, repository: { createSearchRun: vi.fn() } as never,
          savedResults: { read: vi.fn(async () => null) } }
      });
      const { store } = fakeStore();
      return deps({ [IMAGE_GENERATION_TOOL_NAME]: registry.resolve(IMAGE_GENERATION_TOOL_NAME)! }, store);
    }

    it("settles refusals before the dispatch claim as error results the model can act on, never unknown effects", async () => {
      const observation = await captureRunObservation();
      const failures: Record<string, unknown> = {
        reference: markImageFailureNotSent(new ImageInputError("image_reference_not_found", "PRIVATE_ID")),
        budget: markImageFailureNotSent(new ImageInputError("image_tool_budget_exhausted")),
        binding: markImageFailureNotSent(new ImageToolError("image_binding_unavailable")),
        database: markImageFailureNotSent(new Error("PRIVATE_DATABASE_FAILURE"))
      };
      const batch = await imageBatch(async (call) => { throw failures[call.id]; });
      // The model knows the limit before it reaches it.
      expect(batch.registry.resolve(IMAGE_GENERATION_TOOL_NAME)!.definition.description)
        .toContain(`At most ${IMAGE_GENERATION_CALLS_PER_ANSWER} images per answer.`);
      const outcome = await runToolBatch(batch, { calls: 0 }, { round: 1, calls: Object.keys(failures).map((id) => imageCall(id, [id])) });
      const values = outcome.results.map((item) => JSON.parse(item.output) as { error: string; message: string; outcome?: string });
      expect(outcome.results.map((item) => item.outcome)).toEqual(["error", "error", "error", "error"]);
      expect(values.map((value) => value.error)).toEqual(["image_reference_not_found", "image_tool_budget_exhausted",
        "image_binding_unavailable", "image_tool_unavailable"]);
      for (const value of values) {
        expect(value).not.toHaveProperty("outcome");
        expect(value.message).toContain("Nothing was sent to the image provider.");
        expect(value.message).not.toMatch(/may have been sent|effect is unknown/u);
      }
      expect(values[0]!.message).toContain("PRIVATE_ID");
      expect(values[1]!.message).toContain(`maximum of ${IMAGE_GENERATION_CALLS_PER_ANSWER} image generations`);
      expect(values[3]!.message).not.toContain("PRIVATE_DATABASE_FAILURE");
      for (const id of Object.keys(failures)) expect(batch.unknownEffects.find(imageCall(id, [id]))).toBeNull();
      const records = observation.records().filter((record) => record.event === "tool_call");
      expect(records.map((record) => [record.tool_kind, record.level, record.outcome, record.code, record.error_category ?? null]))
        .toEqual([
          ["image_generation", "warn", "failed", "image_reference_not_found", null],
          ["image_generation", "warn", "failed", "image_tool_budget_exhausted", null],
          ["image_generation", "warn", "failed", "image_binding_unavailable", null],
          ["image_generation", "warn", "failed", "image_tool_unavailable", null]
        ]);
      expect(JSON.stringify(observation.records())).not.toContain("PRIVATE_");
    });

    it("keeps a failure at or after the dispatch claim, and an unmarked one, unknown and never sent again", async () => {
      const claimed = new ImageToolError("image_dispatch_claimed");
      const batch = await imageBatch(async () => { throw claimed; });
      const state = { calls: 0 };
      const first = await runToolBatch(batch, state, { round: 1, calls: [imageCall("c1")] });
      expect(first.results[0]).toMatchObject({ outcome: "unknown", output: expect.stringContaining("may have been sent") });
      expect(batch.unknownEffects.find(imageCall("c1"))).not.toBeNull();
      const again = await runToolBatch(batch, state, { round: 2, calls: [imageCall("c2")] });
      expect(again.results[0]).toMatchObject({ outcome: "error", output: UNKNOWN_OUTCOME_REPEAT_OUTPUT });
      // A stop is the run's, whatever the failure: it is never turned into an ordinary result.
      const controller = new AbortController();
      const stopped = await imageBatch(async () => {
        controller.abort();
        throw markImageFailureNotSent(new DOMException("aborted", "AbortError"));
      });
      await expect(runToolBatch({ ...stopped, signal: controller.signal }, { calls: 0 }, { round: 1, calls: [imageCall("c3")] }))
        .rejects.toBeDefined();
    });
  });

  it("logs a call its run stopped as cancelled, once, and none for a call never recorded", async () => {
    const observation = await captureRunObservation();
    const controller = new AbortController();
    const { store } = fakeStore();
    await expect(runToolBatch(deps({ slow: tool("slow", "none", async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) }, store, { signal: controller.signal }), { calls: 0 }, { calls: [{ arguments: {}, id: "c1", name: "slow" }], round: 1 }))
      .rejects.toBeDefined();
    const inactive = fakeStore({ inactive: true });
    await expect(runToolBatch(deps({ lookup: tool("lookup", "none", async ({ call }) => ok(call)) }, inactive.store), { calls: 0 },
      { calls: [{ arguments: {}, id: "c1", name: "lookup" }], round: 1 })).rejects.toBeInstanceOf(ToolBatchInactiveError);
    expect(observation.records().filter((record) => record.event === "tool_call").map((record) => [record.outcome, record.code]))
      .toEqual([["cancelled", "tool_call_cancelled"]]);
  });

  it("settles a stopped Search's carried result (engine usage, sources) once, then stops without running more", async () => {
    const controller = new AbortController();
    const { store } = fakeStore();
    const carried: ToolExecutionResult = { callId: "c1", content: [{ text: "Search failed: search_cancelled", type: "text" }],
      name: "search", status: "complete", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
    const settled = vi.fn<NonNullable<EngineTool["settled"]>>(async () => undefined);
    const later = vi.fn(async ({ call }: { call: ModelToolCall }) => ok(call));
    const search = tool("search", "none", async () => {
      controller.abort();
      throw new SearchToolCancelledError(carried, new Error("stopped"));
    }, { observationSource: "search", settled });
    const batch = deps({ later: tool("later", "none", later), search }, store, { signal: controller.signal });
    await expect(runToolBatch({ ...batch, sleep: vi.fn(async () => undefined) }, { calls: 0 }, { calls: [
      { arguments: { query: "q" }, id: "c1", name: "search" }
    ], round: 1 })).rejects.toBeInstanceOf(SearchToolCancelledError);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ id: "c1" }) }), carried);
    expect(later).not.toHaveBeenCalled();
    // The run's ending closes the record; the batch never settles a stopped call itself.
    expect(store.settle).not.toHaveBeenCalled();
  });

  it("keeps the stop when a stopped Search's records cannot be written", async () => {
    const controller = new AbortController();
    const { store } = fakeStore();
    const carried: ToolExecutionResult = { callId: "c1", content: [], name: "search", status: "error" };
    const search = tool("search", "none", async () => {
      controller.abort();
      throw new SearchToolCancelledError(carried, new Error("stopped"));
    }, { settled: vi.fn(async () => { throw new Error("database_unavailable"); }) });
    await expect(runToolBatch(deps({ search }, store, { signal: controller.signal }), { calls: 0 },
      { calls: [{ arguments: {}, id: "c1", name: "search" }], round: 1 })).rejects.toBeInstanceOf(SearchToolCancelledError);
  });
});
