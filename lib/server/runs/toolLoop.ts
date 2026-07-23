export type ToolLoopCall = Readonly<{
  arguments: unknown;
  id: string;
  name: string;
}>;

export type ToolLoopIssue = Readonly<{
  code: string;
  fatal?: boolean;
  message: string;
  retryable?: boolean;
}>;

export type ToolLoopToolResult<Value> =
  | Readonly<{
      status: "complete";
      value: Value;
    }>
  | Readonly<{
      error: ToolLoopIssue;
      status: "error";
    }>;

export type ToolLoopSettledCall<Value> = Readonly<{
  call: ToolLoopCall;
  ordinal: number;
  result: ToolLoopToolResult<Value>;
  round: number;
}>;

export type ToolLoopProviderRoundResult<Continuation, FinalValue> =
  | Readonly<{
      final: FinalValue;
      status: "complete";
    }>
  | Readonly<{
      calls: readonly ToolLoopCall[];
      continuation: Continuation;
      status: "tool_calls";
    }>
  | Readonly<{
      error: ToolLoopIssue;
      status: "error";
    }>;

export type ToolLoopSignal =
  | Readonly<{
      delta: string;
      round: number;
      type: "text_delta";
    }>
  | Readonly<{
      round: number;
      type: "message_reset";
    }>;

export type ToolLoopBudgets = Readonly<{
  maxConcurrency: number;
  maxToolCalls: number;
  maxToolRounds: number;
  providerRoundTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}>;

export type ToolLoopFailure = ToolLoopIssue &
  Readonly<{
    callId?: string;
    round?: number;
    stage: "budget" | "configuration" | "persistence" | "provider" | "protocol" | "signal" | "tool";
    toolName?: string;
  }>;

export type ToolLoopProgress = Readonly<{
  providerRounds: number;
  toolCalls: number;
  toolRounds: number;
}>;

export type ToolLoopOutcome<FinalValue> =
  | (ToolLoopProgress &
      Readonly<{
        final: FinalValue;
        status: "complete";
      }>)
  | (ToolLoopProgress &
      Readonly<{
        failure: ToolLoopFailure;
        status: "failed";
      }>)
  | (ToolLoopProgress &
      Readonly<{
        status: "cancelled";
      }>);

export type ContinueToolLoopInput<Continuation, ToolValue, FinalValue> = Readonly<{
  afterToolBatch?(input: Readonly<{
    continuation: Continuation;
    progress: ToolLoopProgress;
    results: readonly ToolLoopSettledCall<ToolValue>[];
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  beforeProviderRound?(input: Readonly<{
    continuation: Continuation;
    previousToolResults: readonly ToolLoopSettledCall<ToolValue>[];
    progress: ToolLoopProgress;
    round: number;
  }>): Promise<void> | void;
  budgets: ToolLoopBudgets;
  executeTool(
    call: ToolLoopCall,
    context: Readonly<{
      ordinal: number;
      round: number;
      signal: AbortSignal;
    }>
  ): Promise<ToolLoopToolResult<ToolValue>>;
  initialContinuation: Continuation;
  onToolBatchSettled?(input: Readonly<{
    continuation: Continuation;
    progress: ToolLoopProgress;
    results: readonly ToolLoopSettledCall<ToolValue>[];
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  persistToolBatch?(input: Readonly<{
    calls: readonly ToolLoopCall[];
    continuation: Continuation;
    progress: ToolLoopProgress;
    round: number;
    toolRound: number;
  }>): Promise<void> | void;
  resume?: Readonly<{
    continuation: Continuation;
    previousToolResults?: readonly ToolLoopSettledCall<ToolValue>[];
    progress?: ToolLoopProgress;
    seenCallIds?: readonly string[];
  }>;
  onSignal?(signal: ToolLoopSignal): Promise<void> | void;
  runProviderRound(input: Readonly<{
    continuation: Continuation;
    emitText(delta: string): Promise<void>;
    previousToolResults: readonly ToolLoopSettledCall<ToolValue>[];
    progress: ToolLoopProgress;
    round: number;
    signal: AbortSignal;
  }>): Promise<ToolLoopProviderRoundResult<Continuation, FinalValue>>;
  signal?: AbortSignal;
}>;

type BoundedOperationResult<Value> =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ error: unknown; kind: "error" }>
  | Readonly<{ kind: "success"; value: Value }>
  | Readonly<{ kind: "timeout" }>;

class SignalDeliveryError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Tool-loop signal delivery failed");
    this.name = "SignalDeliveryError";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function invalidBudget(budgets: ToolLoopBudgets): string | null {
  if (!isPositiveInteger(budgets.maxConcurrency)) {
    return "maxConcurrency must be a positive integer";
  }

  if (!isNonNegativeInteger(budgets.maxToolCalls)) {
    return "maxToolCalls must be a non-negative integer";
  }

  if (!isNonNegativeInteger(budgets.maxToolRounds)) {
    return "maxToolRounds must be a non-negative integer";
  }

  if (
    budgets.providerRoundTimeoutMs !== undefined &&
    !isPositiveInteger(budgets.providerRoundTimeoutMs)
  ) {
    return "providerRoundTimeoutMs must be a positive integer when provided";
  }

  if (
    budgets.toolCallTimeoutMs !== undefined &&
    !isPositiveInteger(budgets.toolCallTimeoutMs)
  ) {
    return "toolCallTimeoutMs must be a positive integer when provided";
  }

  return null;
}

async function runBoundedOperation<Value>(input: Readonly<{
  operation(signal: AbortSignal): Promise<Value>;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<BoundedOperationResult<Value>> {
  if (input.parentSignal?.aborted) {
    return { kind: "cancelled" };
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: () => void = () => undefined;
  const races: Array<Promise<BoundedOperationResult<Value>>> = [
    Promise.resolve()
      .then(() => input.operation(controller.signal))
      .then(
        (value): BoundedOperationResult<Value> => ({ kind: "success", value }),
        (error: unknown): BoundedOperationResult<Value> => ({ error, kind: "error" })
      )
  ];

  if (input.parentSignal) {
    races.push(
      new Promise<BoundedOperationResult<Value>>((resolve) => {
        const abort = () => {
          resolve({ kind: "cancelled" });
          controller.abort(input.parentSignal?.reason);
        };
        input.parentSignal?.addEventListener("abort", abort, { once: true });
        removeParentListener = () => {
          input.parentSignal?.removeEventListener("abort", abort);
        };
      })
    );
  }

  if (input.timeoutMs !== undefined) {
    races.push(
      new Promise<BoundedOperationResult<Value>>((resolve) => {
        timeout = setTimeout(() => {
          resolve({ kind: "timeout" });
          controller.abort(new Error("operation_timeout"));
        }, input.timeoutMs);
      })
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    removeParentListener();
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function failed<FinalValue>(
  progress: ToolLoopProgress,
  failure: ToolLoopFailure
): ToolLoopOutcome<FinalValue> {
  return {
    ...progress,
    failure,
    status: "failed"
  };
}

function cancelled<FinalValue>(progress: ToolLoopProgress): ToolLoopOutcome<FinalValue> {
  return {
    ...progress,
    status: "cancelled"
  };
}

function validateCalls(
  calls: readonly ToolLoopCall[],
  seenCallIds: ReadonlySet<string>,
  round: number
): ToolLoopFailure | null {
  if (calls.length === 0) {
    return {
      code: "provider_tool_calls_empty",
      message: "Provider returned a tool-call round without any calls.",
      round,
      stage: "protocol"
    };
  }

  const batchIds = new Set<string>();
  for (const call of calls) {
    if (!call.id.trim() || !call.name.trim()) {
      return {
        code: "provider_tool_call_invalid",
        message: "Provider returned a tool call without a stable id or name.",
        round,
        stage: "protocol"
      };
    }

    if (seenCallIds.has(call.id) || batchIds.has(call.id)) {
      return {
        callId: call.id,
        code: "provider_tool_call_id_duplicate",
        message: `Provider reused tool call id ${call.id}.`,
        round,
        stage: "protocol",
        toolName: call.name
      };
    }

    batchIds.add(call.id);
  }

  return null;
}

async function settleToolCall<ToolValue>(input: Readonly<{
  call: ToolLoopCall;
  executeTool: ContinueToolLoopInput<unknown, ToolValue, unknown>["executeTool"];
  ordinal: number;
  parentSignal?: AbortSignal;
  round: number;
  timeoutMs?: number;
}>): Promise<ToolLoopSettledCall<ToolValue>> {
  const execution = await runBoundedOperation({
    operation: (signal) =>
      input.executeTool(input.call, {
        ordinal: input.ordinal,
        round: input.round,
        signal
      }),
    parentSignal: input.parentSignal,
    timeoutMs: input.timeoutMs
  });

  let result: ToolLoopToolResult<ToolValue>;
  if (execution.kind === "success") {
    result = execution.value;
  } else if (execution.kind === "timeout") {
    result = {
      error: {
        code: "tool_call_timeout",
        message: `Tool call ${input.call.id} timed out.`
      },
      status: "error"
    };
  } else if (execution.kind === "cancelled") {
    result = {
      error: {
        code: "tool_call_cancelled",
        message: `Tool call ${input.call.id} was cancelled.`
      },
      status: "error"
    };
  } else {
    result = {
      error: {
        code: "tool_call_failed",
        message: errorMessage(execution.error, `Tool call ${input.call.id} failed.`)
      },
      status: "error"
    };
  }

  return {
    call: input.call,
    ordinal: input.ordinal,
    result,
    round: input.round
  };
}

async function settleToolBatch<ToolValue>(input: Readonly<{
  calls: readonly ToolLoopCall[];
  executeTool: ContinueToolLoopInput<unknown, ToolValue, unknown>["executeTool"];
  maxConcurrency: number;
  parentSignal?: AbortSignal;
  round: number;
  timeoutMs?: number;
}>): Promise<Array<ToolLoopSettledCall<ToolValue> | undefined>> {
  const results = new Array<ToolLoopSettledCall<ToolValue> | undefined>(input.calls.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (!input.parentSignal?.aborted) {
      const ordinal = cursor;
      cursor += 1;
      const call = input.calls[ordinal];
      if (!call) {
        return;
      }

      results[ordinal] = await settleToolCall({
        call,
        executeTool: input.executeTool,
        ordinal,
        parentSignal: input.parentSignal,
        round: input.round,
        timeoutMs: input.timeoutMs
      });
    }
  }

  const workers = Array.from(
    { length: Math.min(input.maxConcurrency, input.calls.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export async function continueToolLoop<Continuation, ToolValue, FinalValue>(
  input: ContinueToolLoopInput<Continuation, ToolValue, FinalValue>
): Promise<ToolLoopOutcome<FinalValue>> {
  let progress: ToolLoopProgress = {
    providerRounds: 0,
    toolCalls: 0,
    toolRounds: 0
  };
  const budgetError = invalidBudget(input.budgets);
  if (budgetError) {
    return failed(progress, {
      code: "tool_loop_budget_invalid",
      message: budgetError,
      stage: "configuration"
    });
  }

  let continuation = input.resume?.continuation ?? input.initialContinuation;
  let previousToolResults: readonly ToolLoopSettledCall<ToolValue>[] =
    input.resume?.previousToolResults ?? [];
  if (input.resume?.progress) {
    progress = input.resume.progress;
  }
  const seenCallIds = new Set<string>(input.resume?.seenCallIds ?? []);

  while (true) {
    if (input.signal?.aborted) {
      return cancelled(progress);
    }

    const round = progress.providerRounds + 1;
    progress = {
      ...progress,
      providerRounds: round
    };
    try {
      await input.beforeProviderRound?.({
        continuation,
        previousToolResults,
        progress,
        round
      });
    } catch (error) {
      return failed(progress, {
        code: "tool_loop_checkpoint_failed",
        message: errorMessage(error, "Tool-loop provider checkpoint failed."),
        round,
        stage: "persistence"
      });
    }
    let emittedText = false;
    let roundOpen = true;
    const providerRound = await runBoundedOperation({
      operation: (signal) =>
        input.runProviderRound({
          continuation,
          emitText: async (delta) => {
            if (!delta) {
              return;
            }
            if (!roundOpen || signal.aborted) {
              const error = new Error("provider_round_no_longer_active");
              error.name = "AbortError";
              throw error;
            }

            try {
              await input.onSignal?.({ delta, round, type: "text_delta" });
            } catch (error) {
              throw new SignalDeliveryError(error);
            }
            emittedText = true;
          },
          previousToolResults,
          progress,
          round,
          signal
        }),
      parentSignal: input.signal,
      timeoutMs: input.budgets.providerRoundTimeoutMs
    });
    roundOpen = false;

    if (providerRound.kind === "cancelled") {
      return cancelled(progress);
    }

    if (providerRound.kind === "timeout") {
      return failed(progress, {
        code: "provider_round_timeout",
        message: `Provider round ${round} timed out.`,
        round,
        stage: "provider"
      });
    }

    if (providerRound.kind === "error") {
      const signalFailure = providerRound.error instanceof SignalDeliveryError;
      const providerErrorCode = typeof providerRound.error === "object" &&
        providerRound.error !== null &&
        "code" in providerRound.error &&
        typeof providerRound.error.code === "string"
        ? providerRound.error.code
        : null;
      return failed(progress, {
        code: signalFailure
          ? "tool_loop_signal_failed"
          : providerErrorCode ?? "provider_round_failed",
        message: errorMessage(providerRound.error, `Provider round ${round} failed.`),
        round,
        stage: signalFailure ? "signal" : "provider"
      });
    }

    const providerResult = providerRound.value;
    if (providerResult.status === "error") {
      return failed(progress, {
        ...providerResult.error,
        round,
        stage: "provider"
      });
    }

    if (providerResult.status === "complete") {
      return {
        ...progress,
        final: providerResult.final,
        status: "complete"
      };
    }

    const calls = providerResult.calls;
    const callError = validateCalls(calls, seenCallIds, round);
    if (callError) {
      return failed(progress, callError);
    }

    if (progress.toolRounds >= input.budgets.maxToolRounds) {
      return failed(progress, {
        code: "tool_round_limit_exceeded",
        message: `Tool round limit of ${input.budgets.maxToolRounds} was exceeded.`,
        round,
        stage: "budget"
      });
    }

    if (progress.toolCalls + calls.length > input.budgets.maxToolCalls) {
      return failed(progress, {
        code: "tool_call_limit_exceeded",
        message: `Tool call limit of ${input.budgets.maxToolCalls} was exceeded.`,
        round,
        stage: "budget"
      });
    }

    calls.forEach((call) => seenCallIds.add(call.id));
    const toolRound = progress.toolRounds + 1;
    progress = {
      ...progress,
      toolCalls: progress.toolCalls + calls.length,
      toolRounds: toolRound
    };
    try {
      await input.persistToolBatch?.({
        calls,
        continuation: providerResult.continuation,
        progress,
        round,
        toolRound
      });
    } catch (error) {
      return failed(progress, {
        code: "tool_loop_checkpoint_failed",
        message: errorMessage(error, "Tool-loop batch checkpoint failed."),
        round,
        stage: "persistence"
      });
    }
    if (emittedText) {
      try {
        await input.onSignal?.({ round, type: "message_reset" });
      } catch (error) {
        return failed(progress, {
          code: "tool_loop_signal_failed",
          message: errorMessage(error, "Tool-loop signal delivery failed."),
          round,
          stage: "signal"
        });
      }
    }
    const results = await settleToolBatch({
      calls,
      executeTool: input.executeTool,
      maxConcurrency: input.budgets.maxConcurrency,
      parentSignal: input.signal,
      round: toolRound,
      timeoutMs: input.budgets.toolCallTimeoutMs
    });

    const settledResults = results.filter(
      (result): result is ToolLoopSettledCall<ToolValue> => result !== undefined
    );
    try {
      await input.onToolBatchSettled?.({
        continuation,
        progress,
        results: settledResults,
        round,
        toolRound
      });
    } catch (error) {
      if (input.signal?.aborted) return cancelled(progress);
      return failed(progress, {
        code: "tool_loop_evidence_failed",
        message: errorMessage(error, "Settled tool-call evidence could not be persisted."),
        round,
        stage: "persistence"
      });
    }

    if (input.signal?.aborted) {
      return cancelled(progress);
    }

    if (results.some((result) => result === undefined)) {
      return failed(progress, {
        code: "tool_batch_incomplete",
        message: `Tool round ${toolRound} did not settle every call.`,
        round,
        stage: "protocol"
      });
    }

    continuation = providerResult.continuation;
    previousToolResults = settledResults;
    const fatalResult = previousToolResults.find((result) =>
      result.result.status === "error" && result.result.error.fatal === true
    );
    if (fatalResult?.result.status === "error") {
      return failed(progress, {
        ...fatalResult.result.error,
        callId: fatalResult.call.id,
        round,
        stage: "tool",
        toolName: fatalResult.call.name
      });
    }
    try {
      await input.afterToolBatch?.({
        continuation,
        progress,
        results: previousToolResults,
        round,
        toolRound
      });
    } catch (error) {
      return failed(progress, {
        code: "tool_loop_checkpoint_failed",
        message: errorMessage(error, "Tool-loop result checkpoint failed."),
        round,
        stage: "persistence"
      });
    }
  }
}
