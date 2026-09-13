// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContext, runWithContext } from "../observability";
import { withKnowledgeToolDeadline } from "./knowledgeToolDeadline";

afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
  return () => lines.map(line => JSON.parse(line));
}

describe("accepted Knowledge deadline", () => {
  it("preserves the first cause and original contexts when Stop arrives under another trace", async () => {
    const records = capture();
    const deadlines = [new AbortController(), new AbortController()];
    const timeout = vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(deadlines[0].signal).mockReturnValueOnce(deadlines[1].signal);
    const parents = [new AbortController(), new AbortController()];
    const operations = parents.map((parent, index) => runWithContext({ run_id: "run-1", tool_call_id: `saved-${index}`, execution_index: index }, () =>
      withKnowledgeToolDeadline([parent.signal], signal => new Promise<unknown>((_, reject) => {
        expect(getContext()?.tool_call_id).toBe(`saved-${index}`);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })).catch(error => error)));
    const deadlineReason = new DOMException("PRIVATE_TIMEOUT", "TimeoutError");
    const stopReason = new Error("PRIVATE_STOP");
    runWithContext({ run_id: "stop-http-run" }, () => {
      deadlines[0].abort(deadlineReason);
      parents[0].abort(stopReason);
      parents[1].abort(stopReason);
      deadlines[1].abort(deadlineReason);
    });
    expect(await Promise.all(operations)).toEqual([deadlineReason, stopReason]);
    expect(timeout.mock.calls).toEqual([[90_000], [90_000]]);
    const aborts = records().filter(record => record.event === "nested_abort");
    expect(aborts).toHaveLength(2);
    expect(aborts).toMatchObject([
      { run_id: "run-1", tool_call_id: "saved-0", execution_index: 0, abort_source: "knowledge_deadline", timeout_ms: 90_000 },
      { run_id: "run-1", tool_call_id: "saved-1", execution_index: 1, abort_source: "parent_signal" }
    ]);
    expect(aborts[1]).not.toHaveProperty("timeout_ms");
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("passes through pre-aborted signals without inventing elapsed time or a cause", async () => {
    const records = capture();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const parent = new AbortController();
    const reason = new Error("PRIVATE_CAUSE");
    parent.abort(reason);
    await expect(withKnowledgeToolDeadline([parent.signal], async signal => {
      expect(signal.reason).toBe(reason);
      signal.throwIfAborted();
    })).rejects.toBe(reason);
    const abort = records().find(record => record.event === "nested_abort");
    expect(abort).toMatchObject({ stage: "before_start", abort_source: "unknown" });
    expect(abort).not.toHaveProperty("duration_ms");
    expect(abort).not.toHaveProperty("timeout_ms");
  });

  it("removes observation listeners after successful or failed execution", async () => {
    const records = capture();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const parent = new AbortController();
    const value = { untouched: true };
    expect(await withKnowledgeToolDeadline([parent.signal], async () => value)).toBe(value);
    const error = new Error("PRIVATE_FAILURE");
    await expect(withKnowledgeToolDeadline([parent.signal], async () => { throw error; })).rejects.toBe(error);
    parent.abort();
    deadline.abort();
    expect(records().filter(record => record.event === "nested_abort")).toHaveLength(0);
  });
});
