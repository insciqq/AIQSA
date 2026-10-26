import { randomUUID } from "node:crypto";
import { workspaceOperationFailureMessage } from "../../contracts/workspaceFailure";
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
import type { McpApprovalRequest } from "../mcp/writeApproval";
import { SearchToolCancelledError } from "../search/toolExecutor";
import type { ToolObservationSource, ToolObservationSourceBinding } from "../toolObservations/contract";
import { hasInvalidProviderToolArguments, type ModelToolCall, type RunTool, type ToolExecutionResult } from "../tools/types";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { engineToolCallKind } from "./toolCallKind";
import type { ToolCallRow, ToolCallStore } from "./toolCallStore";
import { recordToolCall, type SettledToolCall } from "./toolCallTelemetry";
import type { EngineTool, EngineToolExecution, ToolRegistry } from "./toolRegistry";
import { READ_TOOL_RESULT_NAME, TOOL_RESULT_LIMITS, toolOutputExcerpt, toolResultOutputText } from "./toolResults";
import type { TranscriptItem, TranscriptToolResultItem } from "./transcript";
import type { UnknownEffects } from "./unknownEffects";

/**
 * One tool batch of a native run: every call of a model response goes
 * through `beforeToolCall` as it starts (unknown tool, arguments, tool time,
 * call budget, repeat guard, links, the initiator's approval), is recorded,
 * runs, and goes through `afterToolCall` (size bound with a saved whole
 * result, settled record, output events), in the response's order. A batch never re-sends a
 * call: only a call of a read-only tool that failed in transport is tried
 * again, and a call whose run stopped meanwhile keeps an unknown outcome.
 * Neither does the model: a call equivalent to an earlier one whose effect
 * is unknown (`unknownEffects.ts`) is sent only when the user decides, in the
 * approval card for an MCP tool, otherwise by writing to the chat after the
 * model checked and asked.
 */
export const TOOL_BATCH_LIMITS = Object.freeze({
  /** Calls of one batch that run at once. */
  concurrency: 4,
  /** Retries of a read-only call that failed in transport. */
  readOnlyRetries: 2,
  /** Attempts to settle a call's record after it ran; a record that stays unsettled only logs. */
  recordAttempts: 3,
  recordRetryDelayMs: 250,
  retryBaseDelayMs: 1_000
});

/** The placeholder result of a call waiting for the user's approval. */
export const APPROVAL_PENDING_OUTPUT =
  "Not sent: this call can change data, so it waits for the user's approval in the chat. If the user approves, " +
  "it runs and you continue from its result; do not call it again meanwhile.";

/** What the transcript keeps of a run-scoped result (`EngineTool.runScopedResult`) for later turns. */
export const RUN_SCOPED_RESULT_NOTE =
  "This result was used only in the answer that produced it and is not kept. Call the tool again if it is still needed.";

/** The transcript record of an item: later turns read a note in place of a run-scoped result. */
export function transcriptRecord(registry: ToolRegistry, item: TranscriptItem): TranscriptItem {
  return item.kind === "tool_result" && registry.resolve(item.name)?.runScopedResult
    ? { ...item, output: RUN_SCOPED_RESULT_NOTE } : item;
}

/** A call refused because an equivalent earlier call's effect is unknown and the user has not spoken since. */
export const UNKNOWN_OUTCOME_REPEAT_OUTPUT =
  "Not sent: an identical earlier call failed after it may have been sent, so its effect is unknown, and it is never sent " +
  "again automatically. Check the current state first (a read-only step), tell the user what you found, and send it again " +
  "only if the user asks you to.";

/** The same refusal where the user decides in the approval card. */
export const UNKNOWN_OUTCOME_APPROVAL_OUTPUT =
  "Not sent: an identical earlier call failed after it may have been sent, so its effect is unknown. Check the current state " +
  "if you can and tell the user what you found; the user decides in the approval card whether to send it again. Do not call it " +
  "again meanwhile.";

/**
 * What an approved call's record says while it may be on its way: its earlier result said it was not sent, so until its
 * own result is recorded its effect is unknown, and an interruption leaves it so (`unknownEffects.ts`).
 */
export const APPROVED_CALL_IN_FLIGHT_OUTPUT =
  "Sent after the user's approval, but its result was never recorded, so its effect is unknown and it is not sent again " +
  "on its own. Check the current state first, tell the user what you found, and send it again only if the user approves.";

/** The stable reason of an approved call the continuing run could not load (`ApprovedToolCall.unavailable`). */
export const APPROVED_TOOL_UNAVAILABLE = "mcp_approved_tool_unavailable";

export const APPROVED_TOOL_UNAVAILABLE_OUTPUT =
  "Not sent: the user approved this call, but its tool is no longer available in this chat (its server was removed, turned " +
  "off or could not start). Tell the user that it did not run.";

/** A call of an MCP tool that is in the chat's Auto index but not loaded in this turn (an earlier turn loaded it). */
export const AUTO_TOOL_NOT_LOADED_OUTPUT = (name: string, query: string) =>
  `Not run: ${name} is in this chat's tool index but is not loaded in this answer. Call find_tools with query "${query}", ` +
  "then call the tool again.";

export const TOOL_CALL_LIMIT_OUTPUT = (limit: number) =>
  `Not run: this answer's tool call limit (${limit}) is reached. Answer with what you have and say what you could not check.`;

/** A call that would have started after the turn's time for tools ran out. */
export const TOOL_TIME_EXHAUSTED_OUTPUT =
  "Not run: this answer's time for tools has run out. Answer with what you have and say what you could not check.";

export type ToolBatchDeps = Readonly<{
  chatId: string;
  history: ToolCallRepeatHistory;
  /** The run's call budget; null: no call count refuses a call (the repeat guard still does). */
  maxToolCalls: number | null;
  /** Persisted output events (artifacts, cards); also sent live. */
  onEvent(event: ModelRunSseEvent): Promise<void>;
  /** Live-only events (a running step). */
  onLiveEvent(event: ModelRunSseEvent): void;
  registry: ToolRegistry;
  /**
   * The tool of the run's one report reserved outside the budgets
   * (`reservedToolCallForRequest`): its first call never counts against the
   * call budget; a later one counts like any other.
   */
  reservedToolName?: string;
  runId: string;
  saveResult(input: Readonly<{ outcome: "complete" | "error"; signal: AbortSignal; source: ToolObservationSource;
    sourceBinding?: ToolObservationSourceBinding; text: string; toolCallId: string }>): Promise<Readonly<{ handle: string } | { unsavedReason: string }>>;
  signal: AbortSignal;
  sleep?(delayMs: number, signal: AbortSignal): Promise<void>;
  store: ToolCallStore;
  /**
   * Whether the turn may still start this tool's call: the loop's tool time, and whether the call's own longest
   * duration still fits before the deadline (`toolCallBounds`). Asked as each call is about to start and before a
   * read-only call is tried again. A call that waited behind slower ones past it, or would outlast the answer's
   * reserve, is refused like one past the call budget; calls already running settle. Absent: no time check here.
   */
  toolTimeLeft?(tool: RunTool): boolean;
  /** Effects of the chat's earlier calls that are still unknown; the batch adds its own. */
  unknownEffects: UnknownEffects;
  userId: string;
}>;

/**
 * The call an approval continuation sends, with the user's Allow that names it. `unavailable`: the continuing run
 * could not load its tool, so it is refused with `APPROVED_TOOL_UNAVAILABLE` and never sent.
 */
export type ApprovedToolCall = Readonly<{ approvalId: string; callId: string; unavailable?: true }>;

/** What the run has spent on tools so far; `reservedCalled`: the reserved report's first call ran. */
export type ToolBatchState = { calls: number; reservedCalled?: boolean };

export type ToolBatchOutcome = Readonly<{
  /** Approval card ids of calls that wait for the initiator. */
  approvals: readonly string[];
  /** A call was refused for the call budget or the tool time: the next round may use no tools. */
  budgetExhausted: boolean;
  /** Calls that were sent; a batch that sent none made no progress. */
  executed: number;
  /**
   * Calls refused before sending for a mistake the model can correct with its next call: a tool not declared
   * in this round (an older name, a tool `find_tools` has not loaded yet) or arguments that were not one object.
   */
  correctable: number;
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
  | Readonly<{ budget?: true; correctable?: true; kind: "refuse"; output: string; result: ToolLoopJsonValue; toolName: string }>
  | Readonly<{
    /** The run's reserved report, asked for the first time: it does not count against the call budget. */
    exempt?: true;
    /** An equivalent earlier call's effect is unknown: this call needs the user's approval of exactly it. */
    retry?: Readonly<{ approval: McpApprovalRequest; approvedBy?: string }>;
    kind: "run";
    tool: EngineTool;
  }>;

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
  function beforeToolCall(call: ModelToolCall, round: number, batch: readonly ModelToolCall[],
    approved?: ApprovedToolCall): BeforeToolCall {
    // An approved call whose tool the run could not load is refused visibly, never dropped or left to the model.
    if (approved?.unavailable && approved.callId === call.id) {
      return { kind: "refuse", output: APPROVED_TOOL_UNAVAILABLE_OUTPUT, toolName: call.name,
        result: jsonError(call, { error: APPROVED_TOOL_UNAVAILABLE, message: APPROVED_TOOL_UNAVAILABLE_OUTPUT }) };
    }
    const tool = deps.registry.resolve(call.name);
    if (!tool) {
      const toolName = unknownToolCallName(call.name);
      // An older tool the run replaced names its replacement, and an MCP tool of the chat's Auto index (one an earlier
      // turn used) how to load it; the record keeps the plain unknown form.
      const load = deps.registry.mcpLoadCall?.(call.name, call.id);
      const output = deps.registry.replacement?.(call.name) ??
        (load ? AUTO_TOOL_NOT_LOADED_OUTPUT(call.name, String(load.arguments.query)) : UNKNOWN_TOOL_CALL_MESSAGE);
      return { correctable: true, kind: "refuse", output, toolName,
        result: unknownToolCallResult({ providerCallId: call.id, requested: requestedToolNameExcerpt(call.name), toolName }) };
    }
    if (hasInvalidProviderToolArguments(call.arguments)) {
      const message = "The arguments were not one JSON object, so nothing was run. Call the tool again with valid arguments.";
      return { correctable: true, kind: "refuse", output: message, result: jsonError(call, { error: "tool_arguments_invalid", message }),
        toolName: call.name };
    }
    const exempt = deps.reservedToolName !== undefined && call.name === deps.reservedToolName && state.reservedCalled !== true;
    if (!exempt && deps.toolTimeLeft?.(tool.definition) === false) {
      return { budget: true, kind: "refuse", output: TOOL_TIME_EXHAUSTED_OUTPUT, toolName: call.name,
        result: jsonError(call, { error: "tool_time_exhausted", message: TOOL_TIME_EXHAUSTED_OUTPUT }) };
    }
    if (!exempt && deps.maxToolCalls !== null && state.calls >= deps.maxToolCalls) {
      const message = TOOL_CALL_LIMIT_OUTPUT(deps.maxToolCalls);
      return { budget: true, kind: "refuse", output: message, result: jsonError(call, { error: "tool_call_limit_reached", message }),
        toolName: call.name };
    }
    // A read of a saved result is never a loop to stop: after a compaction it is the only way back to that text.
    const repeatOf = call.name === READ_TOOL_RESULT_NAME ? null : deps.history.blockFor({ arguments: call.arguments, toolName: call.name }, round, {
      batch: batch.filter((other) => other !== call).map((other) => ({ arguments: other.arguments, toolName: other.name })),
      readOnly: (name) => deps.registry.resolve(name)?.effects === "none"
    });
    if (repeatOf) {
      return { kind: "refuse", output: repeatBlockedNote(repeatOf), toolName: call.name,
        result: repeatBlockedToolCallResult({ providerCallId: call.id, repeatOf, toolName: call.name }) };
    }
    const unknown = tool.effects === "external" ? deps.unknownEffects.find(call) : null;
    if (unknown) {
      // It may have happened already: the user decides, in the card where the tool has one.
      const approval = tool.retryApproval?.(call);
      if (approval) {
        const approvedBy = approved && approved.callId === call.id ? approved.approvalId : undefined;
        return { kind: "run", retry: { approval, ...(approvedBy ? { approvedBy } : {}) }, tool };
      }
      if (!unknown.userSpokeSince) {
        // The model can do what this asks (check the state with a read-only call), so tools stay open for it.
        return { correctable: true, kind: "refuse", output: UNKNOWN_OUTCOME_REPEAT_OUTPUT, toolName: call.name,
          result: jsonError(call, { error: "tool_outcome_unknown_repeat", message: UNKNOWN_OUTCOME_REPEAT_OUTPUT }) };
      }
    }
    return { kind: "run", tool, ...(exempt ? { exempt: true as const } : {}) };
  }

  /**
   * The checks after a call ran: a result longer than a short excerpt is
   * saved whole with a handle (the model gets a long one as its head and tail
   * with the handle), the call's record settles with the result, and its
   * output events (images, cards) are published. A read of a saved result is
   * already readable by its own handle and is saved again only when it does
   * not fit whole. Its own records (Search sources, usage) never fail the
   * batch.
   */
  async function afterToolCall(execution: EngineToolExecution, tool: EngineTool, row: ToolCallRow,
    result: ToolExecutionResult): Promise<TranscriptToolResultItem> {
    const text = toolResultOutputText(result);
    const saveAbove = tool.definition.name === READ_TOOL_RESULT_NAME ? TOOL_RESULT_LIMITS.inlineChars : TOOL_RESULT_LIMITS.saveChars;
    const sourceBinding = tool.observationBinding?.(execution.call, result);
    const saved = !tool.runScopedResult && text.length > saveAbove
      ? await deps.saveResult({ outcome: result.status, signal: execution.signal, source: tool.observationSource,
        ...(sourceBinding ? { sourceBinding } : {}), text, toolCallId: row.id })
      : null;
    const excerpt = tool.runScopedResult ? { handle: null, output: text } : toolOutputExcerpt(text, saved);
    const rowResult = snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes) ??
      snapshotToolExecutionResult({ callId: result.callId, content: [{ text: excerpt.output, type: "text" }], name: result.name,
        status: result.status }, toolLoopPersistenceLimits.resultBytes)!;
    await settleRecord(deps, { callId: row.id, result: rowResult, runId: deps.runId, state: result.status });
    deps.history.record({ ...row, result: rowResult, state: result.status });
    const identical = deps.history.identicalRound({ ...row, result: rowResult, state: result.status });
    try {
      await tool.settled?.(execution, result);
    } catch (error) {
      logEvent("service_operation", { action: "degrade", code: "tool_records_unsaved", error, outcome: "degraded",
        run_id: deps.runId, stage: "write", subsystem: "database" });
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

/**
 * Settles a call's record after it ran: bookkeeping behind the answer (the
 * model has the result either way). A record that stays unsettled is closed
 * with an unknown outcome when the run ends.
 */
async function settleRecord(deps: ToolBatchDeps, input: Parameters<ToolCallStore["settle"]>[0]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.store.settle(input);
      return;
    } catch (error) {
      if (deps.signal.aborted) throw error;
      if (attempt >= TOOL_BATCH_LIMITS.recordAttempts) {
        logEvent("service_operation", { action: "degrade", attempt, code: "tool_record_unsettled", error, outcome: "degraded",
          run_id: deps.runId, stage: "write", subsystem: "database" });
        return;
      }
      await (deps.sleep ?? sleepWithSignal)(TOOL_BATCH_LIMITS.recordRetryDelayMs * 2 ** (attempt - 1), deps.signal);
    }
  }
}

/** The records of a result its tool returned only with its cancellation; they never fail or delay the stop further. */
async function settleCancelledResult(deps: ToolBatchDeps, tool: EngineTool, execution: EngineToolExecution,
  result: ToolExecutionResult): Promise<void> {
  try {
    await tool.settled?.(execution, result);
  } catch (error) {
    logEvent("service_operation", { action: "degrade", code: "tool_records_unsaved", error, outcome: "degraded",
      run_id: deps.runId, stage: "write", subsystem: "database" });
  }
}

async function executeWithRetries(deps: ToolBatchDeps, tool: EngineTool, execution: EngineToolExecution): Promise<ToolExecutionResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tool.execute(execution);
    } catch (error) {
      // A retry starts the call again, so past the tool time it fails as it is: the answer's reserve covers one attempt.
      if (execution.signal.aborted || tool.effects !== "none" || attempt >= TOOL_BATCH_LIMITS.readOnlyRetries ||
        !transientToolFailure(error) || deps.toolTimeLeft?.(tool.definition) === false) throw error;
      await (deps.sleep ?? sleepWithSignal)(TOOL_BATCH_LIMITS.retryBaseDelayMs * 2 ** attempt, execution.signal);
      // The backoff may have crossed the tool time: asked again right before the call starts anew.
      if (deps.toolTimeLeft?.(tool.definition) === false) throw error;
    }
  }
}

/**
 * Runs one batch; results follow the calls' order. `firstOrdinal`: the first call's ordinal in its round, after calls
 * the server already recorded there (the approved tool's load).
 */
export async function runToolBatch(deps: ToolBatchDeps, state: ToolBatchState, input: Readonly<{
  approved?: ApprovedToolCall; calls: readonly ModelToolCall[]; firstOrdinal?: number; round: number;
}>): Promise<ToolBatchOutcome> {
  const hooks = createToolHooks(deps, state);
  const approvals: string[] = [];
  let budgetExhausted = false;
  let correctable = 0;
  let executed = 0;
  const declared = input.calls.filter((call) => deps.registry.resolve(call.name));
  if (declared.length > 0) deps.onLiveEvent(liveRunPhaseStatus({ count: declared.length, phase: "tools" }));

  // Each call that settles here (refused, held for approval, or run) logs one `tool_call` record once its outcome is
  // known and before its bookkeeping; a call whose run stopped before it was recorded logs none.
  const runCall = async (call: ModelToolCall, ordinal: number): Promise<TranscriptToolResultItem> => {
    const kind = engineToolCallKind(deps.registry.resolve(call.name)?.definition);
    const before = hooks.beforeToolCall(call, input.round, input.calls, input.approved);
    // The reserved report's first call that runs uses the reservation; one refused before running (malformed
    // arguments, a blocked repeat) keeps it, so a corrected call still gets its reserved round.
    if (before.kind === "run" && before.exempt) state.reservedCalled = true;
    const record = { arguments: call.arguments, chatId: deps.chatId, ordinal, providerCallId: call.id, roundIndex: input.round,
      runId: deps.runId, userId: deps.userId };
    if (before.kind === "refuse") {
      if (before.budget) budgetExhausted = true;
      if (before.correctable) correctable += 1;
      const row = await deps.store.refuse({ ...record, result: before.result, toolName: before.toolName });
      if (!row) throw new ToolBatchInactiveError();
      recordToolCall({ kind, settled: { kind: "result", result: before.result } });
      deps.history.record(row);
      return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error", output: before.output };
    }
    const tool = before.tool;
    if (!before.exempt) state.calls += 1;
    const links = tool.links ? tool.links(call) : {};
    if (links === null) {
      const message = "This tool's connection is no longer available to this answer, so nothing was sent.";
      const result = jsonError(call, { error: "tool_binding_unavailable", message });
      const row = await deps.store.refuse({ ...record, result, toolName: call.name });
      if (!row) throw new ToolBatchInactiveError();
      recordToolCall({ kind, settled: { kind: "result", result } });
      deps.history.record(row);
      return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error", output: message };
    }
    const approval = before.retry?.approval ?? tool.approval?.(call);
    const begun = await deps.store.begin({ ...record, ...links, ...(approval ? { approval } : {}),
      ...(before.retry?.approvedBy ? { approvedBy: before.retry.approvedBy } : {}), toolName: call.name });
    if (begun.kind === "inactive") throw new ToolBatchInactiveError();
    deps.history.record(begun.row);
    if (begun.kind === "gated") {
      recordToolCall({ kind, settled: { kind: "awaiting_approval" } });
      approvals.push(begun.approvalId);
      return { callId: call.id, id: randomUUID(), kind: "tool_result", name: call.name, outcome: "error",
        output: before.retry ? UNKNOWN_OUTCOME_APPROVAL_OUTPUT : APPROVAL_PENDING_OUTPUT };
    }
    executed += 1;
    const activity = { ...tool.activity(call), round: input.round };
    deps.onLiveEvent(liveToolCallStatus(call, activity, { ordinal }));
    const execution: EngineToolExecution = { call, ordinal, persistedToolCallId: begun.row.id, round: input.round, signal: deps.signal };
    const startedAt = performance.now();
    let durationMs = 0;
    const settled = (outcome: SettledToolCall) => {
      durationMs = performance.now() - startedAt;
      recordToolCall({ durationMs, kind, settled: outcome });
    };
    // The live step settles once the call's record and outputs have; an unknown effect never reads as success, and a
    // stopped call gets nothing here, since the run's end settles it.
    const finished = (item: TranscriptToolResultItem, status: "complete" | "error"): TranscriptToolResultItem => {
      deps.onLiveEvent(liveToolCallStatus(call, activity, { ordinal, settled: { durationMs, status } }));
      return item;
    };
    let result: ToolExecutionResult;
    try {
      result = await executeWithRetries(deps, tool, execution);
    } catch (error) {
      // Stop or the deadline: the run's ending closes the record with an unknown outcome.
      if (deps.signal.aborted) {
        settled({ kind: "aborted", reason: deps.signal.reason });
        // A stopped Search keeps what its settled engines reported (usage, sources) before the stop goes on;
        // nothing else runs meanwhile.
        if (error instanceof SearchToolCancelledError) await settleCancelledResult(deps, tool, execution, error.result);
        throw error;
      }
      const code = safeCode(error);
      if (tool.effects === "external") {
        // It may have taken effect: never sent again, and the model is told so. A Workspace operation that reached its
        // time limit is an expected outcome of the command the model chose, not a failure of AIQSA, but the command may
        // still have changed files, so its effect stays unknown too.
        const timedOut = error instanceof WorkspaceRuntimeError && error.code === "workspace_tool_timeout";
        const message = timedOut ? workspaceOperationFailureMessage("workspace_tool_timeout")
          : "The call failed after it may have been sent; its effect is unknown and it was not repeated. " +
            "Check its effect before trying again.";
        result = { callId: call.id, content: [{ type: "json", value: { error: code, message, outcome: "unknown" } }], name: call.name,
          status: "error" };
        deps.unknownEffects.record(call, "unknown");
        settled(timedOut ? { code, kind: "timed_out" } : { effectUnknown: true, error, kind: "thrown", result });
        const item = await hooks.afterToolCall(execution, tool, begun.row, result);
        return finished({ ...item, outcome: "unknown" }, "error");
      }
      result = { callId: call.id, content: [{ type: "json", value: { error: code, message: "The tool failed; nothing changed." } }],
        name: call.name, status: "error" };
      settled({ effectUnknown: false, error, kind: "thrown", result });
      deps.unknownEffects.record(call, result.status);
      return finished(await hooks.afterToolCall(execution, tool, begun.row, result), "error");
    }
    settled({ kind: "result", result });
    deps.unknownEffects.record(call, result.status);
    return finished(await hooks.afterToolCall(execution, tool, begun.row, result), result.status);
  };

  const results: TranscriptToolResultItem[] = new Array(input.calls.length);
  let next = 0;
  const worker = async () => {
    while (next < input.calls.length) {
      const index = next;
      next += 1;
      results[index] = await runCall(input.calls[index]!, (input.firstOrdinal ?? 0) + index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TOOL_BATCH_LIMITS.concurrency, input.calls.length) }, worker));
  return { approvals, budgetExhausted, correctable, executed, results };
}
