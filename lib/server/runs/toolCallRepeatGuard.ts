import { decodeToolObservationDescriptor } from "../toolObservations/contract";
import type { ToolExecutionResult } from "../tools/types";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { contextDigest } from "./contextCompactionContract";
import { snapshotToolExecutionResult } from "./toolExecutionPersistence";
import {
  toolLoopPersistenceLimits,
  type PersistedToolLoopCall,
  type PersistedToolLoopCallState,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import type { ToolLoopSettledCall } from "./toolLoop";

/**
 * Repeated identical calls without progress. Every decision derives from
 * persisted call rows of the run (live keeps the same rows it persisted and
 * settled), so recovery reaches the same decisions without process memory.
 *
 * - Hint: an executed success equal to the newest earlier success of the same
 *   call is marked as such in the provider projection only.
 * - Block: when the two newest earlier rounds' successes of the same call are
 *   equal and no call that may change state ran since the older one (nor
 *   runs beside it in its batch), a further call is persisted already settled
 *   as an undispatched `tool_call_repeat_blocked` error.
 * - No progress: a round of only blocked calls ends in tool-free synthesis.
 */
export const TOOL_CALL_REPEAT_BLOCKED = "tool_call_repeat_blocked";
const WORKSPACE_EXEC_POLL = namespacedWorkspaceToolName("sandbox_exec_poll");

export type ToolCallRepeatRow = Pick<PersistedToolLoopCall,
  "arguments" | "id" | "ordinal" | "providerCallId" | "result" | "roundIndex" | "startedAt" | "state" | "toolName">;

/** Earlier and later round of the two equal successes a block refers to. */
export type ToolCallRepeatRounds = readonly [number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The call's identity: its tool name and canonical arguments. */
export function toolCallRepeatKey(call: Readonly<{ arguments: unknown; toolName: string }>): string {
  return contextDigest({ name: call.toolName, arguments: call.arguments });
}

/** The persisted result of a blocked call: no dispatch, no receipt, no observation. */
export function repeatBlockedToolCallResult(input: Readonly<{
  providerCallId: string;
  repeatOf: ToolCallRepeatRounds;
  toolName: string;
}>): ToolLoopJsonValue {
  return {
    callId: input.providerCallId,
    name: input.toolName,
    status: "error",
    content: [{ type: "json", value: { error: TOOL_CALL_REPEAT_BLOCKED, repeatOf: [input.repeatOf[0], input.repeatOf[1]] } }]
  };
}

export function validRepeatRounds(value: unknown, roundIndex: number): value is ToolCallRepeatRounds {
  return Array.isArray(value) && value.length === 2 &&
    value.every(round => Number.isSafeInteger(round) && round >= 1) &&
    value[0] < value[1] && value[1] < roundIndex;
}

/**
 * A block is recognized only by its whole server-owned combination: an error
 * row that never started whose result is exactly the blocked form (no
 * observation). Tool content mentioning the code is never a block. Egress
 * receipts live outside the row; a blocked call never has one.
 */
export function repeatBlockedRounds(row: Pick<ToolCallRepeatRow,
  "providerCallId" | "result" | "roundIndex" | "startedAt" | "state" | "toolName">): ToolCallRepeatRounds | null {
  const result = row.result;
  if (row.state !== "error" || row.startedAt !== null || !isRecord(result) ||
    Object.keys(result).sort().join(",") !== "callId,content,name,status" ||
    result.callId !== row.providerCallId || result.name !== row.toolName || result.status !== "error" ||
    !Array.isArray(result.content) || result.content.length !== 1) return null;
  const part = result.content[0];
  if (!isRecord(part) || Object.keys(part).sort().join(",") !== "type,value" || part.type !== "json" ||
    !isRecord(part.value) || Object.keys(part.value).sort().join(",") !== "error,repeatOf" ||
    part.value.error !== TOOL_CALL_REPEAT_BLOCKED || !validRepeatRounds(part.value.repeatOf, row.roundIndex)) return null;
  return [part.value.repeatOf[0], part.value.repeatOf[1]];
}

/**
 * The fingerprint of a successful outcome, or null for anything else
 * (errors, including an inner error under a completed call, busy, timeout,
 * authority refusals, cancelled or unknown outcomes, and blocks). A retained
 * result is identified by its original's checksum, which excludes the
 * per-execution handle; any other result by its stored status and content.
 * The whole row is the input so a reader whose row keeps only a receipt can
 * fingerprint the output that receipt names.
 */
export function toolCallOutcomeFingerprint(row: ToolCallRepeatRow): string | null {
  // A process progresses independently of tool calls. Repeated polls do not
  // prove it stalled; a stored observation may contain only a reference, so
  // exclude this polling tool regardless of its result representation.
  if (row.toolName === WORKSPACE_EXEC_POLL) return null;
  const result = row.result;
  if (row.state !== "complete" || !isRecord(result) || result.status !== "complete") return null;
  if (result.observation !== undefined) {
    const observation = decodeToolObservationDescriptor(result.observation);
    return observation ? `observation:${observation.checksum}` : null;
  }
  return `result:${contextDigest({ status: result.status, content: result.content })}`;
}

type IndexedRow = ToolCallRepeatRow & Readonly<{ key: string }>;

function settledState(state: PersistedToolLoopCallState): boolean {
  return state === "complete" || state === "error";
}

/** The rows of one run, in provider order, with their keys. */
export class ToolCallRepeatHistory {
  private readonly rows = new Map<string, IndexedRow>();

  constructor(rows: Iterable<ToolCallRepeatRow> = []) {
    for (const row of rows) this.record(row);
  }

  /** A persisted row. A settled view is never replaced by an older unsettled one. */
  record(row: ToolCallRepeatRow): void {
    const current = this.rows.get(row.id);
    if (current && settledState(current.state) && !settledState(row.state)) return;
    this.rows.set(row.id, { ...row, key: toolCallRepeatKey(row) });
  }

  /** The outcome this process settled for a row it persisted. A row already
   * settled keeps its persisted result. */
  settle(id: string, outcome: Readonly<{ result: ToolLoopJsonValue | null; state: "complete" | "error" }>): void {
    const current = this.rows.get(id);
    if (!current || settledState(current.state)) return;
    this.rows.set(id, { ...current, result: outcome.result, state: outcome.state });
  }

  /** Earlier rounds' rows of the same call, oldest first, without blocks. */
  private earlier(key: string, roundIndex: number): IndexedRow[] {
    return [...this.rows.values()]
      .filter(row => row.key === key && row.roundIndex > 0 && row.roundIndex < roundIndex && !repeatBlockedRounds(row))
      .sort((left, right) => left.roundIndex - right.roundIndex || left.ordinal - right.ordinal);
  }

  /**
   * Rounds whose equal successes block a new call in `roundIndex`: the
   * newest earlier outcome of the call is a success, the newest successes of
   * the two newest rounds with one are equal, and no other call that is not
   * proven read-only ran from the older round on or is in this batch (a
   * command, write or MCP tool without `readOnlyHint` may have changed what
   * the call returns). A retry after any failure stays allowed; duplicates
   * inside one batch count only from earlier rounds.
   */
  blockFor(call: Readonly<{ arguments: unknown; toolName: string }>, roundIndex: number, context: Readonly<{
    batch: readonly Readonly<{ arguments: unknown; toolName: string }>[];
    readOnly(toolName: string): boolean;
  }>): ToolCallRepeatRounds | null {
    const key = toolCallRepeatKey(call);
    const earlier = this.earlier(key, roundIndex);
    const newest = earlier.at(-1);
    if (!newest || toolCallOutcomeFingerprint(newest) === null) return null;
    const successes = new Map<number, string>();
    for (const row of earlier) {
      const fingerprint = toolCallOutcomeFingerprint(row);
      if (fingerprint) successes.set(row.roundIndex, fingerprint);
    }
    const rounds = [...successes.keys()].sort((left, right) => left - right).slice(-2);
    if (rounds.length < 2) return null;
    const [older, newer] = rounds as [number, number];
    if (successes.get(older) !== successes.get(newer)) return null;
    const mayChangeState = (entry: Readonly<{ arguments: unknown; toolName: string }>) =>
      !context.readOnly(entry.toolName) && toolCallRepeatKey(entry) !== key;
    const changedSince = [...this.rows.values()].some(row => row.roundIndex >= older && row.roundIndex < roundIndex &&
      row.state !== "pending" && !repeatBlockedRounds(row) && row.key !== key && !context.readOnly(row.toolName));
    return changedSince || context.batch.some(mayChangeState) ? null : [older, newer];
  }

  /** The earlier round whose newest success of the same call equals this
   * executed success. The projection note never changes this basis. */
  identicalRound(row: ToolCallRepeatRow): number | null {
    const fingerprint = toolCallOutcomeFingerprint(row);
    if (!fingerprint) return null;
    const latest = this.earlier(toolCallRepeatKey(row), row.roundIndex)
      .filter(candidate => toolCallOutcomeFingerprint(candidate) !== null).at(-1);
    return latest && toolCallOutcomeFingerprint(latest) === fingerprint ? latest.roundIndex : null;
  }

  /** The model-facing note of a settled row, or undefined. */
  noteFor(id: string): string | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const blocked = repeatBlockedRounds(row);
    if (blocked) return repeatBlockedNote(blocked);
    const identical = this.identicalRound(row);
    return identical === null ? undefined : repeatIdenticalNote(identical);
  }
}

export function repeatIdenticalNote(round: number): string {
  return `Identical to the result of the same call in round ${round}; no new data.`;
}

export function repeatBlockedNote(rounds: ToolCallRepeatRounds): string {
  return `Not executed: this call already returned the same data twice (rounds ${rounds[0]}, ${rounds[1]}). Use those results.`;
}

/** A round whose every persisted call is a block made no progress. */
export function roundMadeNoProgress(rows: readonly Pick<ToolCallRepeatRow,
  "providerCallId" | "result" | "roundIndex" | "startedAt" | "state" | "toolName">[]): boolean {
  return rows.length > 0 && rows.every(row => repeatBlockedRounds(row) !== null);
}

/** The persisted form of an outcome this process settled: what its row now holds. */
export function settledRepeatOutcome(entry: ToolLoopSettledCall<ToolExecutionResult>): Readonly<{
  result: ToolLoopJsonValue | null;
  state: "complete" | "error";
}> {
  if (entry.result.status !== "complete") return { result: null, state: "error" };
  const snapshot = snapshotToolExecutionResult(entry.result.value, toolLoopPersistenceLimits.resultBytes);
  return snapshot ? { result: snapshot, state: entry.result.value.status } : { result: null, state: "error" };
}
