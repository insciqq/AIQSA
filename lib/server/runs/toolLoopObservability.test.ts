// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContext, runWithContext } from "../observability";
import { continueToolLoop, type ToolLoopObservation } from "./toolLoop";

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
