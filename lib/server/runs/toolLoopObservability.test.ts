// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContext, logEvent, runWithContext } from "../observability";
import { continueToolLoop, type ToolLoopObservation, type ToolLoopToolResult } from "./toolLoop";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const calls = [0, 1].map(index => ({ id: `PRIVATE_PROVIDER_CALL_${index}`, name: "PRIVATE_TOOL_NAME", arguments: {} }));
const budgets = { maxConcurrency: 2, maxToolCalls: 4, maxToolRounds: 2 };
function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(line => { lines.push(String(line)); return true; });
  return () => lines.map(line => JSON.parse(line));
}

describe("tool-loop correlation", () => {
  it("uses persisted identities for concurrent tools and retains them during Stop delivery", async () => {
    const records = capture();
    const identities = new Map<string, ToolLoopObservation>();
    const parent = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let count = 0;
    const loop = runWithContext({ run_id: "run-tools" }, () => continueToolLoop({
      budgets, initialContinuation: {}, signal: parent.signal,
      toolObservation: call => identities.get(call.id),
      persistToolBatch: ({ calls }) => {
        calls.forEach((call, index) => identities.set(call.id, { tool_call_id: `saved-${index}`, execution_index: index, tool_kind: "search" }));
      },
      runProviderRound: async () => ({ status: "tool_calls", calls, continuation: {} }),
      executeTool: async (call, { signal }) => {
        const identity = identities.get(call.id)!;
        expect(getContext()).toMatchObject({ tool_call_id: identity.tool_call_id, execution_index: identity.execution_index });
        if (++count === 2) ready();
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
    }));
    await started;
    runWithContext({ run_id: "stop-http" }, () => parent.abort(new Error("PRIVATE_STOP")));
    expect(await loop).toMatchObject({ status: "cancelled" });
    const aborts = records().filter(record => record.event === "nested_abort");
    expect(aborts).toHaveLength(2);
    expect(aborts).toMatchObject([
      { run_id: "run-tools", tool_call_id: "saved-0", execution_index: 0, abort_source: "parent_signal" },
      { run_id: "run-tools", tool_call_id: "saved-1", execution_index: 1, abort_source: "parent_signal" }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("reports an actual outer deadline once and preserves tool timeout settlement", async () => {
    vi.useFakeTimers();
    const records = capture();
    const parent = new AbortController();
    const resultCodes: string[] = [];
    const loop = continueToolLoop({
      budgets: { ...budgets, toolCallTimeoutMs: 10 }, initialContinuation: {}, signal: parent.signal,
      toolObservation: () => ({ tool_call_id: "saved-timeout", execution_index: 0, tool_kind: "mcp" }),
      runProviderRound: async ({ round }) => round === 1
        ? { status: "tool_calls" as const, calls: calls.slice(0, 1), continuation: {} }
        : { status: "complete" as const, final: "done" },
      executeTool: async () => new Promise<never>(() => undefined),
      onToolBatchSettled: ({ results }) => {
        for (const { result } of results) if (result.status === "error") resultCodes.push(result.error.code);
      }
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(await loop).toMatchObject({ status: "complete" });
    parent.abort();
    expect(resultCodes).toEqual(["tool_call_timeout"]);
    expect(records().filter(record => record.event === "tool_deadline")).toMatchObject([
      { tool_kind: "mcp", outer_timeout_ms: 10, effective_timeout_ms: 10 }
    ]);
    expect(records().filter(record => record.event === "nested_abort")).toMatchObject([
      { tool_call_id: "saved-timeout", abort_source: "tool_deadline", timeout_ms: 10 }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("does not turn a failed diagnostic lookup into a dispatch failure", async () => {
    capture();
    const executeTool = vi.fn(async () => ({ status: "complete" as const, value: "ok" }));
    const result = await continueToolLoop({
      budgets, initialContinuation: {}, toolObservation() { throw Error("unavailable"); }, executeTool,
      runProviderRound: async ({ round }) => round === 1
        ? { status: "tool_calls" as const, calls: calls.slice(0, 1), continuation: {} }
        : { status: "complete" as const, final: "done" }
    });
    expect(result).toMatchObject({ status: "complete" });
    expect(executeTool).toHaveBeenCalledOnce();
  });
});

describe("terminal tool-call records", () => {
  const json = (value: unknown) => ({ status: "complete" as const, value: { status: "error", content: [{ type: "json", value }] } });
  const text = (value: string, rawPreview?: unknown) => ({ status: "complete" as const,
    value: { status: "error", content: [{ type: "text", text: value }], ...(rawPreview ? { rawPreview } : {}) } });
  const families = [
    ["search", text("Search failed: search_invocation_limit_reached"), "search_invocation_limit_reached"],
    ["knowledge", text("PRIVATE_KNOWLEDGE_TEXT", { knowledgeFailure: { code: "knowledge_retrieval_failed", version: 1 } }), "knowledge_retrieval_failed"],
    // An MCP server's own error text is never read for a code.
    ["mcp", text('{"error":{"code":"workspace_tool_timeout"},"PRIVATE_UPSTREAM":1}', { isError: true }), "mcp_tool_reported_error"],
    ["workspace", text(JSON.stringify({ ok: false, error: { code: "workspace_tool_timeout", message: "PRIVATE_MESSAGE" } })), "workspace_tool_timeout"],
    ["vision", json({ error: "vision_model_unavailable", hint: "PRIVATE_HINT" }), "vision_model_unavailable"],
    ["fetch_url", json({ error: "fetch_url_not_in_conversation", url: "https://PRIVATE.example/" }), "fetch_url_not_in_conversation"],
    ["artifact", json({ error: "artifact_tool_unavailable", path: "PRIVATE_FILE.txt" }), "artifact_tool_unavailable"],
    ["image_generation", { status: "error" as const, error: { code: "image_generation_failed", fatal: true, message: "PRIVATE_MESSAGE" } }, "image_generation_failed"],
    ["skill", json({ error: "skill_not_available", skill: "PRIVATE_SKILL" }), "skill_not_available"],
    ["scheduled_task", json({ created: false, error: "scheduled_task_limit", message: "PRIVATE_MESSAGE" }), "scheduled_task_limit"],
    ["session_status", text("PRIVATE_PLAIN_FAILURE"), "tool_call_failed"],
    ["workspace_image", json({ error: "workspace_image_unavailable" }), "workspace_image_unavailable"],
    ["answer_review", json({ error: "PRIVATE_UNREGISTERED_CODE" }), "tool_call_failed"],
    ["other", json({ code: "tool_observation_busy", message: "PRIVATE_MESSAGE" }), "tool_observation_busy"]
  ] as const;

  it.each(families)("settles %s success, failure and timeout with exactly one record each", async (kind, failure, code) => {
    vi.useFakeTimers();
    const records = capture();
    const batch = ["ok", "failed", "slow"].map(id => ({ id: `PRIVATE_${id}`, name: "PRIVATE_TOOL_NAME", arguments: { url: "https://PRIVATE.example/" } }));
    const loop = continueToolLoop({
      budgets: { maxConcurrency: 3, maxToolCalls: 4, maxToolRounds: 2, toolCallTimeoutMs: 10 }, initialContinuation: {},
      toolCallKind: () => kind,
      toolObservation: call => ({ tool_call_id: call.id.replace("PRIVATE_", "saved-"), execution_index: 0, tool_kind: "search" }),
      runProviderRound: async ({ round }) => round === 1
        ? { status: "tool_calls" as const, calls: batch, continuation: {} }
        : { status: "complete" as const, final: "done" },
      executeTool: async (call): Promise<ToolLoopToolResult<unknown>> => {
        // A family executor's own stage records never add a terminal record.
        logEvent("tool_execution", { tool_kind: "search", stage: "result", outcome: "completed" });
        if (call.id === "PRIVATE_ok") return { status: "complete", value: { status: "complete", content: [{ type: "text", text: "PRIVATE_RESULT" }] } };
        if (call.id === "PRIVATE_failed") return failure;
        return new Promise<never>(() => undefined);
      }
    });
    await vi.advanceTimersByTimeAsync(20);
    // A fatal loop-level tool error ends the loop after its batch settled.
    expect(await loop).toMatchObject({ status: kind === "image_generation" ? "failed" : "complete" });
    expect(records().filter(record => record.event === "tool_execution")).toHaveLength(3);
    const terminal = records().filter(record => record.event === "tool_call");
    expect(terminal).toHaveLength(3);
    const byCall = Object.fromEntries(terminal.map(record => [record.tool_call_id, record]));
    expect(byCall["saved-ok"]).toMatchObject({ level: "info", tool_kind: kind, outcome: "completed" });
    expect(byCall["saved-ok"]).not.toHaveProperty("code");
    expect(byCall["saved-failed"]).toMatchObject({ level: "warn", tool_kind: kind, outcome: "failed", code });
    expect(byCall["saved-slow"]).toMatchObject({ level: "warn", tool_kind: kind, outcome: "timeout", code: "tool_call_timeout" });
    for (const record of terminal) expect(record.duration_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(records())).not.toContain("PRIVATE");
  });

  it("makes a thrown exception an error with its content-free site and records cancellation as info", async () => {
    const records = capture();
    const parent = new AbortController();
    const [thrown, stopped] = calls;
    const loop = continueToolLoop({
      budgets, initialContinuation: {}, signal: parent.signal, toolCallKind: () => "artifact",
      runProviderRound: async () => ({ status: "tool_calls" as const, calls: [thrown!, stopped!], continuation: {} }),
      executeTool: async (call, { signal }) => {
        if (call.id === thrown!.id) throw new TypeError("PRIVATE_EXCEPTION_TEXT");
        return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
    });
    await vi.waitFor(() => expect(records().some(record => record.event === "tool_call")).toBe(true));
    parent.abort(new Error("PRIVATE_STOP"));
    expect(await loop).toMatchObject({ status: "cancelled" });
    expect(records().filter(record => record.event === "tool_call")).toMatchObject([
      { level: "error", tool_kind: "artifact", outcome: "failed", code: "tool_call_failed", error_category: "unexpected", error_class: "TypeError" },
      { level: "info", tool_kind: "artifact", outcome: "cancelled", code: "tool_call_cancelled" }
    ]);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("records an unclassified call as other and never lets its lookup fail dispatch", async () => {
    const records = capture();
    for (const toolCallKind of [undefined, () => { throw Error("unavailable"); }]) {
      const result = await continueToolLoop({
        budgets, initialContinuation: {}, ...(toolCallKind ? { toolCallKind } : {}),
        runProviderRound: async ({ round }) => round === 1
          ? { status: "tool_calls" as const, calls: calls.slice(0, 1), continuation: {} }
          : { status: "complete" as const, final: "done" },
        executeTool: async () => ({ status: "complete" as const, value: "ok" })
      });
      expect(result).toMatchObject({ status: "complete" });
    }
    expect(records().filter(record => record.event === "tool_call")).toMatchObject([
      { tool_kind: "other", outcome: "completed" }, { tool_kind: "other", outcome: "completed" }
    ]);
  });
});
