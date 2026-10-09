import { contextFailureMessage } from "./contextCompactionEvents";
import { executionFailure } from "./executionFailure";
import type { ImageFailureEvidence } from "../images/errors";
import {
  providerStreamSafetyReport,
  type ProviderStreamSafetyReport
} from "../providers/streamSafety";
import { bindContext, logEvent, runWithContext, type ToolCallKind, type ToolKind } from "../observability";
import { recordToolCall } from "./toolCallTelemetry";
import { isProviderHttpFailureClass, observedFailure, providerHttpFailureMessage } from "../providers/providerObservability";
import { isRunPersistenceFailureCode, runSettlementFailure } from "./settlementFailure";

export type ToolLoopObservation = Readonly<{
  /** Only persisted server-owned identities, never the provider's call ID. */
  tool_call_id: string;
  execution_index: number;
  tool_kind?: ToolKind;
}>;

export type ToolLoopCall = Readonly<{
  arguments: unknown;
  id: string;
  name: string;
}>;

export type ToolLoopIssue = Readonly<{
  code: string;
  fatal?: boolean;
  /** Content-free cause of a run-ending image failure. */
  imageFailure?: ImageFailureEvidence;
  message: string;
  retryable?: boolean;
  streamSafetyReport?: ProviderStreamSafetyReport;
  toolName?: string;
  /** The status of a provider HTTP failure class, for content-free run logs. */
  httpStatus?: number;
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
      /** A known successful round that needs a bounded provider correction,
       * without dispatching any tools or consuming a tool round. */
      continuation: Continuation;
      status: "continue";
    }>
  | Readonly<{
      final: FinalValue;
      status: "complete";
    }>
  | Readonly<{
      calls: readonly ToolLoopCall[];
      continuation: Continuation;
      parallelToolCalls?: boolean;
      status: "tool_calls";
      /** The continuation of one tool-free synthesis round that drops this
       * round's calls, used when the batch exceeds the remaining call budget.
       * Without it such a batch fails the loop. */
      synthesisContinuation?: Continuation;
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
    /** The original exception of a local persistence failure, kept only for
     * its content-free database diagnostics; never serialized or shown. */
    cause?: unknown;
    round?: number;
    stage: "budget" | "configuration" | "persistence" | "provider" | "protocol" | "signal" | "tool";
    toolName?: string;
  }>;

export type ToolLoopProgress = Readonly<{
  providerRounds: number;
  toolCalls: number;
  toolRounds: number;
}>;

export function reachedToolLoopBudget(
  progress: Pick<ToolLoopProgress, "toolCalls" | "toolRounds">,
  budgets: Pick<ToolLoopBudgets, "maxToolCalls" | "maxToolRounds">
): Readonly<{ kind: "calls" | "rounds"; limit: number }> | null {
  if (progress.toolCalls >= budgets.maxToolCalls) return { kind: "calls", limit: budgets.maxToolCalls };
  if (progress.toolRounds >= budgets.maxToolRounds) return { kind: "rounds", limit: budgets.maxToolRounds };
  return null;
}

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
  /** Read-only context expansion waits for other results, then settles serially. */
  deferToolUntilBatchEnd?(call: ToolLoopCall): boolean;
  toolObservation?(call: ToolLoopCall): ToolLoopObservation | undefined;
  /** The call's content-free family for its terminal `tool_call` record; `other` without it. */
  toolCallKind?(call: ToolLoopCall): ToolCallKind;
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
  /**
   * A call reserved outside the budgets (a monitoring check's verdict). Only
   * the run's first matching call is exempt: it never counts as a call or
   * makes its batch a tool round, and it never makes a batch exceed them.
   * Every later match counts as an ordinary call, so repeating it cannot keep
   * the loop going. Resumed progress must count the same way.
   */
  isBudgetExempt?(call: ToolLoopCall): boolean;
  /** The run already made its exempt call (recovery derives it from its calls). */
  budgetExemptCallMade?: boolean;
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
  /** Durably records that a batch over the remaining call budget was refused
   * (neither persisted nor dispatched) and that its synthesis round follows. */
  refuseToolBatch?(input: Readonly<{
    calls: readonly ToolLoopCall[];
    continuation: Continuation;
    progress: ToolLoopProgress;
    round: number;
  }>): Promise<void> | void;
  resume?: Readonly<{
    continuation: Continuation;
    previousToolResults?: readonly ToolLoopSettledCall<ToolValue>[];
    progress?: ToolLoopProgress;
    seenCallIds?: readonly string[];
  }>;
  /** The run's time budget is used up: a batch returned from now on is
   * refused into its synthesis round, exactly like a batch over the call
   * budget. A batch already dispatched is never interrupted. */
  timeBudgetExhausted?(): boolean;
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
  return runSettlementFailure(error)?.message ?? fallback;
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
  observeTool?: boolean;
  toolKind?: ToolKind;
}>): Promise<BoundedOperationResult<Value>> {
  if (input.parentSignal?.aborted) {
    if (input.observeTool) logEvent("nested_abort", { layer: "tool", stage: "before_start", abort_source: "unknown" });
    return { kind: "cancelled" };
  }

  const controller = new AbortController();
  const startedAt = performance.now();
  const observeAbort = (source: "parent_signal" | "tool_deadline") => {
    if (!input.observeTool || controller.signal.aborted) return;
    logEvent("nested_abort", {
      layer: "tool", stage: "delivery", abort_source: source,
      duration_ms: performance.now() - startedAt,
      ...(source === "tool_deadline" ? { timeout_ms: input.timeoutMs, deadline_kind: "operation" } : {})
    });
  };
  if (input.observeTool && input.toolKind && input.timeoutMs !== undefined) logEvent("tool_deadline", {
    tool_kind: input.toolKind, outer_timeout_ms: input.timeoutMs, effective_timeout_ms: input.timeoutMs
  });
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
        const abort = bindContext(() => {
          resolve({ kind: "cancelled" });
          observeAbort("parent_signal");
          controller.abort(input.parentSignal?.reason);
        });
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
        timeout = setTimeout(bindContext(() => {
          resolve({ kind: "timeout" });
          observeAbort("tool_deadline");
          controller.abort(new Error("operation_timeout"));
        }), input.timeoutMs);
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
  toolCallKind: ToolCallKind;
  toolKind?: ToolKind;
}>): Promise<ToolLoopSettledCall<ToolValue>> {
  const startedAt = performance.now();
  const execution = await runBoundedOperation({
    operation: (signal) =>
      input.executeTool(input.call, {
        ordinal: input.ordinal,
        round: input.round,
        signal
      }),
    parentSignal: input.parentSignal,
    timeoutMs: input.timeoutMs,
    observeTool: true,
    toolKind: input.toolKind
  });

  let result: ToolLoopToolResult<ToolValue>;
  if (execution.kind === "success") {
    result = execution.value;
  } else if (execution.kind === "timeout") {
    result = {
      error: {
        code: "tool_call_timeout",
        message: "The tool call timed out. Its outcome may be unknown; do not repeat an uncertain action."
      },
      status: "error"
    };
  } else if (execution.kind === "cancelled") {
    result = {
      error: {
        code: "tool_call_cancelled",
        message: "The tool call was cancelled. Cancellation does not confirm that its effects were undone."
      },
      status: "error"
    };
  } else {
    result = {
      error: executionFailure(execution.error),
      status: "error"
    };
  }
  recordToolCall({
    durationMs: performance.now() - startedAt,
    kind: input.toolCallKind,
    result,
    ...(execution.kind === "error" ? { thrown: { error: execution.error } } : {})
  });

  return {
    call: input.call,
    ordinal: input.ordinal,
    result,
    round: input.round
  };
}

async function settleToolBatch<ToolValue>(input: Readonly<{
  calls: readonly ToolLoopCall[];
  deferToolUntilBatchEnd?: ContinueToolLoopInput<unknown, ToolValue, unknown>["deferToolUntilBatchEnd"];
  executeTool: ContinueToolLoopInput<unknown, ToolValue, unknown>["executeTool"];
  maxConcurrency: number;
  parentSignal?: AbortSignal;
  round: number;
  timeoutMs?: number;
  toolObservation?: ContinueToolLoopInput<unknown, ToolValue, unknown>["toolObservation"];
  toolCallKind?: ContinueToolLoopInput<unknown, ToolValue, unknown>["toolCallKind"];
}>): Promise<Array<ToolLoopSettledCall<ToolValue> | undefined>> {
  const results = new Array<ToolLoopSettledCall<ToolValue> | undefined>(input.calls.length);
  const immediate = input.calls.map((call, ordinal) => ({ call, ordinal })).filter(({ call }) => !input.deferToolUntilBatchEnd?.(call));
  const deferred = input.calls.map((call, ordinal) => ({ call, ordinal })).filter(({ call }) => input.deferToolUntilBatchEnd?.(call));
  let cursor = 0;

  async function worker(entries: typeof immediate): Promise<void> {
    while (!input.parentSignal?.aborted) {
      const entry = entries[cursor];
      cursor += 1;
      if (!entry) {
        return;
      }
      const { call, ordinal } = entry;

      let observation: ToolLoopObservation | undefined;
      try { observation = input.toolObservation?.(call); } catch { /* Diagnostics cannot prevent dispatch. */ }
      let toolCallKind: ToolCallKind = "other";
      try { toolCallKind = input.toolCallKind?.(call) ?? "other"; } catch { /* Diagnostics cannot prevent dispatch. */ }
      const execute = () => settleToolCall({
        call,
        executeTool: input.executeTool,
        ordinal,
        parentSignal: input.parentSignal,
        round: input.round,
        timeoutMs: input.timeoutMs,
        toolCallKind,
        toolKind: observation?.tool_kind
      });
      results[ordinal] = await (observation ? runWithContext(observation, execute) : execute());
    }
  }

  const workers = Array.from(
    { length: Math.min(input.maxConcurrency, immediate.length) },
    () => worker(immediate)
  );
  await Promise.all(workers);
  cursor = 0;
  await worker(deferred);
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
  let budgetExemptCallMade = input.budgetExemptCallMade === true;

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
      const streamSafetyReport = signalFailure
        ? null
        : providerStreamSafetyReport(providerRound.error);
      const settlement = runSettlementFailure(providerRound.error);
      const observed = observedFailure(providerRound.error);
      const observedCode = observed.code;
      const providerErrorCode = observedCode === "unknown" ? null : observedCode;
      const httpClassStatus = !signalFailure && !settlement && providerErrorCode && isProviderHttpFailureClass(providerErrorCode)
        ? observed.httpStatus : undefined;
      return failed(progress, {
        code: signalFailure
          ? "tool_loop_signal_failed"
          : settlement?.code ?? providerErrorCode ?? "provider_round_failed",
        message: streamSafetyReport?.message ??
          providerHttpFailureMessage(providerRound.error) ??
          (providerErrorCode ? contextFailureMessage(providerErrorCode) : null) ??
          errorMessage(providerRound.error, `Provider round ${round} failed.`),
        round,
        stage: signalFailure ? "signal" : settlement || providerErrorCode && isRunPersistenceFailureCode(providerErrorCode) ? "persistence" : "provider",
        ...(settlement ? { cause: providerRound.error } : {}),
        ...(streamSafetyReport ? { streamSafetyReport } : {}),
        ...(httpClassStatus !== undefined ? { httpStatus: httpClassStatus } : {})
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

    if (providerResult.status === "continue") {
      continuation = providerResult.continuation;
      previousToolResults = [];
      continue;
    }

    const calls = providerResult.calls;
    const callError = validateCalls(calls, seenCallIds, round);
    if (callError) {
      return failed(progress, callError);
    }

    const exemptCall = budgetExemptCallMade ? undefined : calls.find((call) => input.isBudgetExempt?.(call));
    const budgetedCalls = calls.length - (exemptCall ? 1 : 0);
    const roundsExceeded = budgetedCalls > 0 && progress.toolRounds >= input.budgets.maxToolRounds;
    const callsExceeded = progress.toolCalls + budgetedCalls > input.budgets.maxToolCalls;
    // Without a synthesis round a used-up time budget leaves the batch alone.
    const timeExhausted = providerResult.synthesisContinuation !== undefined && input.timeBudgetExhausted?.() === true;
    if (roundsExceeded || callsExceeded || timeExhausted) {
      const synthesis = providerResult.synthesisContinuation;
      if (synthesis === undefined) {
        return failed(progress, roundsExceeded ? {
          code: "tool_round_limit_exceeded",
          message: `Tool round limit of ${input.budgets.maxToolRounds} was exceeded.`,
          round,
          stage: "budget"
        } : {
          code: "tool_call_limit_exceeded",
          message: `Tool call limit of ${input.budgets.maxToolCalls} was exceeded.`,
          round,
          stage: "budget"
        });
      }
      // No call of the batch runs, partly or wholly: the next round answers
      // from the results already obtained.
      try {
        await input.refuseToolBatch?.({ calls, continuation: synthesis, progress, round });
      } catch (error) {
        return failed(progress, {
          code: "tool_loop_checkpoint_failed",
          message: errorMessage(error, "Tool-loop synthesis checkpoint failed."),
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
      continuation = synthesis;
      previousToolResults = [];
      continue;
    }

    calls.forEach((call) => seenCallIds.add(call.id));
    if (exemptCall) budgetExemptCallMade = true;
    const toolRound = progress.toolRounds + (budgetedCalls > 0 ? 1 : 0);
    progress = {
      ...progress,
      toolCalls: progress.toolCalls + budgetedCalls,
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
      deferToolUntilBatchEnd: input.deferToolUntilBatchEnd,
      maxConcurrency: providerResult.parallelToolCalls === false ? 1 : input.budgets.maxConcurrency,
      parentSignal: input.signal,
      round,
      timeoutMs: input.budgets.toolCallTimeoutMs,
      toolObservation: input.toolObservation,
      toolCallKind: input.toolCallKind
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
      // A local settlement failure (the batch's accounting) keeps its own
      // code, exactly as when a provider round reports it, so its terminal
      // and recovery handling cannot depend on where it was raised.
      return failed(progress, {
        cause: error,
        code: runSettlementFailure(error)?.code ?? "tool_loop_evidence_failed",
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
