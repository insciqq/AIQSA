import { describe, expect, it, vi } from "vitest";
import {
  continueToolLoop,
  type ToolLoopBudgets,
  type ToolLoopCall,
  type ToolLoopSettledCall,
  type ToolLoopSignal
} from "./toolLoop";

const defaultBudgets: ToolLoopBudgets = {
  maxConcurrency: 4,
  maxToolCalls: 8,
  maxToolRounds: 3
};

function call(id: string): ToolLoopCall {
  return {
    arguments: { id },
    id,
    name: `tool_${id}`
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe("provider-neutral tool loop", () => {
  it("checkpoints a complete batch before dispatch and resumes accumulated progress", async () => {
    const order: string[] = [];
    const outcome = await continueToolLoop({
      afterToolBatch: ({ results }) => {
        order.push(`after:${results.map((result) => result.call.id).join(",")}`);
      },
      beforeProviderRound: ({ round }) => {
        order.push(`provider:${round}`);
      },
      budgets: {
        maxConcurrency: 2,
        maxToolCalls: 4,
        maxToolRounds: 2
      },
      executeTool: async (toolCall) => {
        order.push(`execute:${toolCall.id}`);
        return { status: "complete" as const, value: toolCall.id };
      },
      initialContinuation: "unused",
      persistToolBatch: ({ calls }) => {
        order.push(`persist:${calls.map((entry) => entry.id).join(",")}`);
      },
      resume: {
        continuation: "resume",
        progress: { providerRounds: 1, toolCalls: 1, toolRounds: 1 },
        seenCallIds: ["old-call"]
      },
      runProviderRound: async ({ round }) => round === 2
        ? {
            calls: [
              { arguments: {}, id: "call-a", name: "alpha" },
              { arguments: {}, id: "call-b", name: "beta" }
            ],
            continuation: "next",
            status: "tool_calls" as const
          }
        : { final: "done", status: "complete" as const }
    });

    expect(outcome).toEqual({
      final: "done",
      providerRounds: 3,
      status: "complete",
      toolCalls: 3,
      toolRounds: 2
    });
    expect(order.slice(0, 2)).toEqual(["provider:2", "persist:call-a,call-b"]);
    expect(order.indexOf("persist:call-a,call-b")).toBeLessThan(order.indexOf("execute:call-a"));
    expect(order.at(-2)).toBe("after:call-a,call-b");
    expect(order.at(-1)).toBe("provider:3");
  });

  it("returns a provider final without dispatching tools", async () => {
    const executeTool = vi.fn();
    const runProviderRound = vi.fn(async (input: { previousToolResults: readonly unknown[] }) => {
      expect(input.previousToolResults).toEqual([]);
      return {
        final: { text: "Direct answer" },
        status: "complete" as const
      };
    });

    const outcome = await continueToolLoop({
      budgets: defaultBudgets,
      executeTool,
      initialContinuation: { step: 0 },
      runProviderRound
    });

    expect(outcome).toEqual({
      final: { text: "Direct answer" },
      providerRounds: 1,
      status: "complete",
      toolCalls: 0,
      toolRounds: 0
    });
    expect(runProviderRound).toHaveBeenCalledOnce();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("stops before another provider round for a crash-ambiguous tool outcome", async () => {
    const runProviderRound = vi.fn(async ({ round }: { round: number }) => round === 1
      ? { calls: [call("ambiguous")], continuation: {}, status: "tool_calls" as const }
      : { final: "must not run", status: "complete" as const });
    const settledBatches: Array<readonly ToolLoopSettledCall<unknown>[]> = [];
    const outcome = await continueToolLoop({
      budgets: defaultBudgets,
      executeTool: async () => ({
        error: {
          code: "tool_call_outcome_unknown",
          fatal: true,
          message: "The external side effect may already have happened."
        },
        status: "error" as const
      }),
      initialContinuation: {},
      onToolBatchSettled({ results }) {
        settledBatches.push(results);
      },
      runProviderRound
    });

    expect(outcome).toMatchObject({
      failure: {
        callId: "ambiguous",
        code: "tool_call_outcome_unknown",
        stage: "tool"
      },
      status: "failed"
    });
    expect(runProviderRound).toHaveBeenCalledOnce();
    expect(settledBatches[0]?.map((entry) => entry.call.id)).toEqual(["ambiguous"]);
  });

  it("continues across several tool rounds and resets only provisional pre-tool text", async () => {
    const signals: ToolLoopSignal[] = [];
    const priorBatches: Array<readonly ToolLoopSettledCall<string>[]> = [];
    const lifecycle: string[] = [];

    const outcome = await continueToolLoop({
      budgets: defaultBudgets,
      async executeTool(toolCall) {
        lifecycle.push(`execute:${toolCall.id}`);
        return {
          status: "complete" as const,
          value: `result:${toolCall.id}`
        };
      },
      initialContinuation: { step: 0 },
      onSignal(signal) {
        signals.push(signal);
        lifecycle.push(signal.type);
      },
      persistToolBatch({ calls }) {
        lifecycle.push(`persist:${calls.map((entry) => entry.id).join(",")}`);
      },
      async runProviderRound(input) {
        priorBatches.push(input.previousToolResults);
        if (input.round === 1) {
          await input.emitText("provisional");
          return {
            calls: [call("a"), call("b")],
            continuation: { step: 1 },
            status: "tool_calls" as const
          };
        }

        if (input.round === 2) {
          expect(input.continuation).toEqual({ step: 1 });
          return {
            calls: [call("c")],
            continuation: { step: 2 },
            status: "tool_calls" as const
          };
        }

        expect(input.continuation).toEqual({ step: 2 });
        await input.emitText("final");
        return {
          final: { text: "Final answer" },
          status: "complete" as const
        };
      }
    });

    expect(outcome).toEqual({
      final: { text: "Final answer" },
      providerRounds: 3,
      status: "complete",
      toolCalls: 3,
      toolRounds: 2
    });
    expect(signals).toEqual([
      { delta: "provisional", round: 1, type: "text_delta" },
      { round: 1, type: "message_reset" },
      { delta: "final", round: 3, type: "text_delta" }
    ]);
    expect(lifecycle.indexOf("persist:a,b")).toBeLessThan(lifecycle.indexOf("message_reset"));
    expect(lifecycle.indexOf("message_reset")).toBeLessThan(lifecycle.indexOf("execute:a"));
    expect(priorBatches.map((batch) => batch.map((entry) => entry.call.id))).toEqual([
      [],
      ["a", "b"],
      ["c"]
    ]);
    expect(priorBatches[1]?.map((entry) => entry.result)).toEqual([
      { status: "complete", value: "result:a" },
      { status: "complete", value: "result:b" }
    ]);
  });

  it("bounds concurrency while restoring results to provider call order", async () => {
    const releases = new Map([
      ["a", deferred()],
      ["b", deferred()],
      ["c", deferred()]
    ]);
    const starts = new Map([
      ["a", deferred()],
      ["b", deferred()],
      ["c", deferred()]
    ]);
    const started: string[] = [];
    const completed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let orderedResults: readonly ToolLoopSettledCall<string>[] = [];

    const loop = continueToolLoop({
      budgets: {
        ...defaultBudgets,
        maxConcurrency: 2
      },
      async executeTool(toolCall) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(toolCall.id);
        starts.get(toolCall.id)?.resolve();
        await releases.get(toolCall.id)?.promise;
        completed.push(toolCall.id);
        active -= 1;
        return {
          status: "complete" as const,
          value: `value:${toolCall.id}`
        };
      },
      initialContinuation: "initial",
      async runProviderRound(input) {
        if (input.round === 1) {
          return {
            calls: [call("a"), call("b"), call("c")],
            continuation: "after-calls",
            status: "tool_calls" as const
          };
        }

        orderedResults = input.previousToolResults;
        return {
          final: "done",
          status: "complete" as const
        };
      }
    });

    await Promise.all([starts.get("a")?.promise, starts.get("b")?.promise]);
    expect(started).toEqual(["a", "b"]);
    expect(maximumActive).toBe(2);

    releases.get("b")?.resolve();
    await starts.get("c")?.promise;
    releases.get("c")?.resolve();
    releases.get("a")?.resolve();

    await expect(loop).resolves.toMatchObject({ status: "complete" });
    expect(completed).toEqual(["b", "c", "a"]);
    expect(orderedResults.map((entry) => entry.call.id)).toEqual(["a", "b", "c"]);
    expect(orderedResults.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
  });

  it("turns thrown and timed-out tool calls into ordered structured results for synthesis", async () => {
    let synthesizedFrom: readonly ToolLoopSettledCall<string>[] = [];

    const outcome = await continueToolLoop<number, string, string>({
      budgets: {
        ...defaultBudgets,
        toolCallTimeoutMs: 10
      },
      async executeTool(toolCall, context) {
        if (toolCall.id === "throws") {
          throw new Error("fixture failure");
        }

        if (toolCall.id === "times-out") {
          return new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("fixture aborted")),
              { once: true }
            );
          });
        }

        return {
          status: "complete" as const,
          value: "usable result"
        };
      },
      initialContinuation: 0,
      async runProviderRound(input) {
        if (input.round === 1) {
          return {
            calls: [call("throws"), call("times-out"), call("works")],
            continuation: 1,
            status: "tool_calls" as const
          };
        }

        synthesizedFrom = input.previousToolResults;
        return {
          final: "answer from partial results",
          status: "complete" as const
        };
      }
    });

    expect(outcome).toMatchObject({
      final: "answer from partial results",
      status: "complete"
    });
    expect(
      synthesizedFrom.map((entry) =>
        entry.result.status === "complete" ? entry.result.value : entry.result.error.code
      )
    ).toEqual(["tool_call_failed", "tool_call_timeout", "usable result"]);
    expect(synthesizedFrom[0]?.result).toEqual({
      error: {
        code: "tool_call_failed",
        message: "fixture failure"
      },
      status: "error"
    });
  });

  it("aborts an active call and leaves undispatched calls untouched on cancellation", async () => {
    const controller = new AbortController();
    const started = deferred();
    const dispatched: string[] = [];
    const settled: string[] = [];
    const loop = continueToolLoop({
      budgets: { ...defaultBudgets, maxConcurrency: 1 },
      async executeTool(toolCall, context) {
        dispatched.push(toolCall.id);
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
        return { status: "complete" as const, value: "unreachable" };
      },
      initialContinuation: null,
      onToolBatchSettled({ results }) {
        settled.push(...results.map((entry) => entry.call.id));
      },
      async runProviderRound() {
        return {
          calls: [call("active"), call("undispatched")],
          continuation: null,
          status: "tool_calls" as const
        };
      },
      signal: controller.signal
    });

    await started.promise;
    controller.abort(new Error("cancelled by user"));

    await expect(loop).resolves.toMatchObject({ status: "cancelled" });
    expect(dispatched).toEqual(["active"]);
    expect(settled).toEqual(["active"]);
  });

  it("fails before dispatch when call or round budgets are exceeded", async () => {
    const executeTool = vi.fn(async () => ({ status: "complete" as const, value: "unused" }));
    const callLimited = await continueToolLoop({
      budgets: {
        ...defaultBudgets,
        maxToolCalls: 1
      },
      executeTool,
      initialContinuation: 0,
      async runProviderRound() {
        return {
          calls: [call("a"), call("b")],
          continuation: 1,
          status: "tool_calls" as const
        };
      }
    });

    expect(callLimited).toMatchObject({
      failure: {
        code: "tool_call_limit_exceeded",
        round: 1,
        stage: "budget"
      },
      providerRounds: 1,
      status: "failed",
      toolCalls: 0,
      toolRounds: 0
    });
    expect(executeTool).not.toHaveBeenCalled();

    const roundLimited = await continueToolLoop({
      budgets: {
        ...defaultBudgets,
        maxToolRounds: 1
      },
      executeTool,
      initialContinuation: 0,
      async runProviderRound(input) {
        return {
          calls: [call(input.round === 1 ? "first" : "second")],
          continuation: input.round,
          status: "tool_calls" as const
        };
      }
    });

    expect(roundLimited).toMatchObject({
      failure: {
        code: "tool_round_limit_exceeded",
        round: 2,
        stage: "budget"
      },
      providerRounds: 2,
      status: "failed",
      toolCalls: 1,
      toolRounds: 1
    });
  });

  it("rejects provider call-id reuse across rounds", async () => {
    const dispatched: ToolLoopCall[] = [];
    const executeTool = vi.fn(async (toolCall: ToolLoopCall) => {
      dispatched.push(toolCall);
      return { status: "complete" as const, value: "result" };
    });

    const outcome = await continueToolLoop({
      budgets: defaultBudgets,
      executeTool,
      initialContinuation: 0,
      async runProviderRound(input) {
        return {
          calls: [call("same-id")],
          continuation: input.round,
          status: "tool_calls" as const
        };
      }
    });

    expect(outcome).toMatchObject({
      failure: {
        callId: "same-id",
        code: "provider_tool_call_id_duplicate",
        round: 2,
        stage: "protocol"
      },
      providerRounds: 2,
      status: "failed",
      toolCalls: 1,
      toolRounds: 1
    });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(dispatched).toEqual([call("same-id")]);
  });

  it("returns a structured provider timeout and validates budgets before starting", async () => {
    const timedOut = await continueToolLoop({
      budgets: {
        ...defaultBudgets,
        providerRoundTimeoutMs: 10
      },
      async executeTool() {
        return { status: "complete" as const, value: "unused" };
      },
      initialContinuation: null,
      runProviderRound: async () => new Promise(() => undefined)
    });

    expect(timedOut).toMatchObject({
      failure: {
        code: "provider_round_timeout",
        round: 1,
        stage: "provider"
      },
      providerRounds: 1,
      status: "failed"
    });

    const runProviderRound = vi.fn();
    const invalid = await continueToolLoop({
      budgets: {
        ...defaultBudgets,
        maxConcurrency: 0
      },
      executeTool: vi.fn(),
      initialContinuation: null,
      runProviderRound
    });

    expect(invalid).toMatchObject({
      failure: {
        code: "tool_loop_budget_invalid",
        stage: "configuration"
      },
      providerRounds: 0,
      status: "failed"
    });
    expect(runProviderRound).not.toHaveBeenCalled();
  });
});
