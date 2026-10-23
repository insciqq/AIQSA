import { randomUUID } from "node:crypto";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { logEvent } from "../observability";
import { isRetryableProviderHttpStatus, isRetryableProviderNetworkError, sleepWithSignal } from "../providers/providerRetry";
import { observedFailure } from "../providers/providerObservability";
import { liveRunPhaseStatus, liveToolCallStatus } from "../runs/liveToolStatus";
import {
  repeatBlockedNote,
  repeatBlockedToolCallResult,
  repeatIdenticalNote,
  type ToolCallRepeatHistory
} from "../runs/toolCallRepeatGuard";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits, type ToolLoopJsonValue } from "../runs/toolLoopPersistence";
import {
  requestedToolNameExcerpt,
  UNKNOWN_TOOL_CALL_MESSAGE,
  unknownToolCallName,
  unknownToolCallResult
} from "../runs/unknownToolCall";
import type { ToolObservationSource } from "../toolObservations/contract";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionResult } from "../tools/types";
import type { ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { EngineTool, EngineToolExecution, ToolRegistry } from "./toolRegistry";
import { toolOutputExcerpt, toolResultOutputText } from "./toolResults";
import type { TranscriptToolResultItem } from "./transcript";

/**
 * One tool batch of a native run: every call of a model response goes
 * through `beforeToolCall` (unknown tool, arguments, call budget, repeat
 * guard, links, the initiator's approval), is recorded, runs, and goes
 * through `afterToolCall` (size bound with a saved whole result, settled
 * record, output events), in the response's order. A batch never re-sends a
 * call: only a call of a read-only tool that failed in transport is tried
 * again, and a call whose run stopped meanwhile keeps an unknown outcome.
 */
export const TOOL_BATCH_LIMITS = Object.freeze({
  /** Calls of one batch that run at once. */
  concurrency: 4,
  /** Retries of a read-only call that failed in transport. */
  readOnlyRetries: 2,
  retryBaseDelayMs: 1_000
});

/** The placeholder result of a call waiting for the user's approval. */
export const APPROVAL_PENDING_OUTPUT =
  "Not sent: this call can change data, so it waits for the user's approval in the chat. If the user approves, " +
  "it runs and you continue from its result; do not call it again meanwhile.";

export const TOOL_CALL_LIMIT_OUTPUT = (limit: number) =>
  `Not run: this answer's tool call limit (${limit}) is reached. Answer with what you have and say what you could not check.`;

export type ToolBatchDeps = Readonly<{
  chatId: string;
  history: ToolCallRepeatHistory;
  maxToolCalls: number;
  /** Persisted output events (artifacts, cards); also sent live. */
  onEvent(event: ModelRunSseEvent): Promise<void>;
  /** Live-only events (a running step). */
  onLiveEvent(event: ModelRunSseEvent): void;
  registry: ToolRegistry;
  runId: string;
  saveResult(input: Readonly<{ outcome: "complete" | "error"; signal: AbortSignal; source: ToolObservationSource; text: string;
    toolCallId: string }>): Promise<Readonly<{ handle: string } | { unsavedReason: string }>>;
  signal: AbortSignal;
  sleep?(delayMs: number, signal: AbortSignal): Promise<void>;
  store: ToolCallStore;
  userId: string;
}>;

/** What the run has spent on tools so far. */
export type ToolBatchState = { calls: number };

export type ToolBatchOutcome = Readonly<{
  /** Approval card ids of calls that wait for the initiator. */
  approvals: readonly string[];
  /** A call was refused for the call budget: the next round may use no tools. */
  budgetExhausted: boolean;
  results: readonly TranscriptToolResultItem[];
}>;

/** The run stopped (Stop or its deadline) while the batch was being recorded. */
export class ToolBatchInactiveError extends Error {
  constructor() {
    super("tool_batch_inactive");
    this.name = "ToolBatchInactiveError";
  }
}

type BeforeToolCall =
  | Readonly<{ budget?: true; kind: "refuse"; output: string; result: ToolLoopJsonValue; toolName: string }>
  | Readonly<{ kind: "run"; tool: EngineTool }>;

function jsonError(call: Pick<ModelToolCall, "id" | "name">, value: Record<string, unknown>): ToolLoopJsonValue {
  return { callId: call.id, content: [{ type: "json", value: value as { [key: string]: ToolLoopJsonValue } }], name: call.name,
    status: "error" };
}

function transientToolFailure(error: unknown): boolean {
  const failure = observedFailure(error);
  return isRetryableProviderNetworkError(error) || failure.reason === "network" || failure.stream_drop !== undefined ||
    failure.httpStatus !== undefined && isRetryableProviderHttpStatus(failure.httpStatus);
}

function safeCode(error: unknown): string {
  const code = observedFailure(error).code;
  return code !== "unknown" ? code : "tool_execution_failed";
}

export function createToolHooks(deps: ToolBatchDeps, state: ToolBatchState) {
  /**
   * The checks before a call is recorded and sent. Only what can be decided
   * without sending anything refuses here; the approval itself is consumed
   * or requested in the call's recording transaction.
   */
  function beforeToolCall(call: ModelToolCall, round: number, batch: readonly ModelToolCall[]): BeforeToolCall {
    const tool = deps.registry.resolve(call.name);
    if (!tool) {
      const toolName = unknownToolCallName(call.name);
      return { kind: "refuse", output: UNKNOWN_TOOL_CALL_MESSAGE, toolName,
        result: unknownToolCallResult({ providerCallId: call.id, requested: requestedToolNameExcerpt(call.name), toolName }) };
    }
    if (hasInvalidProviderToolArguments(call.arguments)) {
      const message = "The arguments were not one JSON object, so nothing was run. Call the tool again with valid arguments.";
      return { kind: "refuse", output: message, result: jsonError(call, { error: "tool_arguments_invalid", message }), toolName: call.name };
    }
    if (state.calls >= deps.maxToolCalls) {
      const message = TOOL_CALL_LIMIT_OUTPUT(deps.maxToolCalls);
      return { budget: true, kind: "refuse", output: message, result: jsonError(call, { error: "tool_call_limit_reached", message }),
        toolName: call.name };
    }
    const repeatOf = deps.history.blockFor({ arguments: call.arguments, toolName: call.name }, round, {
      batch: batch.filter((other) => other !== call).map((other) => ({ arguments: other.arguments, toolName: other.name })),
      readOnly: (name) => deps.registry.resolve(name)?.effects === "none"
    });
    if (repeatOf) {
      return { kind: "refuse", output: repeatBlockedNote(repeatOf), toolName: call.name,
        result: repeatBlockedToolCallResult({ providerCallId: call.id, repeatOf, toolName: call.name }) };
    }
    return { kind: "run", tool };
  }

  /**
   * The checks after a call ran: a long result is saved whole and the model
   * gets its head and tail with the handle, the call's record settles with
   * the result, and its output events (images, cards) are published. Its own
   * records (Search sources, usage) never fail the batch.
   */
  async function afterToolCall(execution: EngineToolExecution, tool: EngineTool, row: ToolCallRow,
    result: ToolExecutionResult): Promise<TranscriptToolResultItem> {
    const text = toolResultOutputText(result);
    const saved = text.length > 0 && toolOutputExcerpt(text, null).truncated
      ? await deps.saveResult({ outcome: result.status, signal: execution.signal, source: tool.observationSource, text,
        toolCallId: row.id })
      : null;
    const excerpt = toolOutputExcerpt(text, saved);
    const rowResult = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes) ??
      snapshotToolExecutionResult({ callId: result.callId, content: [{ text: excerpt.output, type: "text" }], name: result.name,
        status: result.status }, toolLoopPersistenceLimits.resultBytes)!;
    await deps.store.settle({ callId: row.id, result: rowResult, runId: deps.runId, state: result.status });
    deps.history.record({ ...row, result: rowResult, state: result.status });
    const identical = deps.history.identicalRound({ ...row, result: rowResult, state: result.status });
    try {
      await tool.settled?.(execution, result);
    } catch (error) {
      logEvent("tool_execution", { error, stage: "result", outcome: "degraded", action: "degrade", code: "tool_records_unsaved",
        reason: "unknown" });
    }
    for (const event of result.artifacts ?? []) await deps.onEvent(event);
    return {
      callId: execution.call.id,
      ...(excerpt.handle ? { handle: excerpt.handle } : {}),
      id: randomUUID(),
      kind: "tool_result",
      name: execution.call.name,
      outcome: result.status,
      output: identical === null ? excerpt.output : `${excerpt.output}\n\n${repeatIdenticalNote(identical)}`
    };
  }

  return { afterToolCall, beforeToolCall };
}

async function executeWithRetries(deps: ToolBatchDeps, tool: EngineTool, execution: EngineToolExecution): Promise<ToolExecutionResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tool.execute(execution);
    } catch (error) {
      if (execution.signal.aborted || tool.effects !== "none" || attempt >= TOOL_BATCH_LIMITS.readOnlyRetries ||
        !transientToolFailure(error)) throw error;
      await (deps.sleep ?? sleepWithSignal)(TOOL_BATCH_LIMITS.retryBaseDelayMs * 2 ** attempt, execution.signal);
    }
  }
}

/** Runs one batch; results follow the calls' order. */
export async function runToolBatch(deps: ToolBatchDeps, state: ToolBatchState,
  input: Readonly<{ calls: readonly ModelToolCall[]; round: number }>): Promise<ToolBatchOutcome> {
  const hooks = createToolHooks(deps, state);
  const approvals: string[] = [];
  let budgetExhausted = false;
  const declared = input.calls.filter((call) => deps.registry.resolve(call.name));
  if (declared.length > 0) deps.onLiveEvent(liveRunPhaseStatus({ count: declared.length, phase: "tools" }));

  const runCall = async (call: ModelToolCall, ordinal: number): Promise<TranscriptToolResultItem> => {
    const before = hooks.beforeToolCall(call, input.round, input.calls);
    const record = { arguments: call.arguments, chatId: deps.chatId, ordinal, providerCallId: call.id, roundIndex: input.round,
      runId: deps.runId, userId: deps.userId };
    if (before.kind === "refuse") {
      if (before.budget) budgetExhausted = true;
      const row = await deps.store.refuse({ ...record, result: before.result, toolName: before.toolName });
      if (!row) throw new ToolBatchInactiveError();
      deps.history.record(row);
      return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error", output: before.output };
    }
    const tool = before.tool;
    state.calls += 1;
    const links = tool.links ? tool.links(call) : {};
    if (links === null) {
      const message = "This tool's connection is no longer available to this answer, so nothing was sent.";
      const row = await deps.store.refuse({ ...record, result: jsonError(call, { error: "tool_binding_unavailable", message }),
        toolName: call.name });
      if (!row) throw new ToolBatchInactiveError();
      deps.history.record(row);
      return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error", output: message };
    }
    const approval = tool.approval?.(call);
    const begun = await deps.store.begin({ ...record, ...links, ...(approval ? { approval } : {}), toolName: call.name });
    if (begun.kind === "inactive") throw new ToolBatchInactiveError();
    deps.history.record(begun.row);
    if (begun.kind === "gated") {
      approvals.push(begun.approvalId);
      return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error", output: APPROVAL_PENDING_OUTPUT };
    }
    deps.onLiveEvent(liveToolCallStatus(call, { ...tool.activity(call), round: input.round }));
    const execution: EngineToolExecution = { call, ordinal, persistedToolCallId: begun.row.id, round: input.round, signal: deps.signal };
    let result: ToolExecutionResult;
    try {
      result = await executeWithRetries(deps, tool, execution);
    } catch (error) {
      // Stop or the deadline: the run's ending closes the record with an unknown outcome.
      if (deps.signal.aborted) throw error;
      const code = safeCode(error);
      if (tool.effects === "external") {
        // It may have taken effect: never sent again, and the model is told so.
        const message = "The call failed after it may have been sent; its effect is unknown and it was not repeated. " +
          "Check its effect before trying again.";
        result = { callId: call.id, content: [{ type: "json", value: { error: code, message, outcome: "unknown" } }], name: call.name,
          status: "error" };
        const item = await hooks.afterToolCall(execution, tool, begun.row, result);
        return { ...item, outcome: "unknown" };
      }
      result = { callId: call.id, content: [{ type: "json", value: { error: code, message: "The tool failed; nothing changed." } }],
        name: call.name, status: "error" };
    }
    return hooks.afterToolCall(execution, tool, begun.row, result);
  };

  const results: TranscriptToolResultItem[] = new Array(input.calls.length);
  let next = 0;
  const worker = async () => {
    while (next < input.calls.length) {
      const index = next;
      next += 1;
      results[index] = await runCall(input.calls[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TOOL_BATCH_LIMITS.concurrency, input.calls.length) }, worker));
  return { approvals, budgetExhausted, results };
}
