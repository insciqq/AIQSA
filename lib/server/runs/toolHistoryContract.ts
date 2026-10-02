import { createHash } from "node:crypto";
import type { ToolCallRefEntry, ToolHistorySnapshot } from "../../contracts/toolHistory";

export type { ToolCallRefEntry, ToolHistorySnapshot, ToolHistoryTurn } from "../../contracts/toolHistory";

/**
 * Cross-turn tool history: the server-owned contract a run freezes at
 * admission. A run accepted with `toolHistory.version === 1` makes its own
 * calls eligible for later turns; runs without it are never backfilled. Only
 * call references and digests are frozen: arguments and results stay in their
 * owners (`ModelRunToolCall`, `ToolObservation`) and every projection of them
 * is built again, with current authority, for each provider request.
 */
export const TOOL_HISTORY_VERSION = 1;

export const TOOL_HISTORY_LIMITS = Object.freeze({
  /** Listed calls one frozen history may name across its turns. Older calls
   * beyond it are counted (`omittedCalls`) and named as omitted, never silently
   * dropped. */
  calls: 2048,
  turns: 1024,
  /** Reader and status calls one turn may count. */
  readerCalls: 1_000_000,
  /** UTF-8 bytes of one rendered turn record: older entries degrade to their
   * compact form, then to an explicit omission line. */
  blockBytes: 32 * 1024,
  /** Bounded excerpts of one entry; the reader pages through the rest. */
  argumentsBytes: 640,
  resultBytes: 480,
  /** The largest saved arguments or result (JSON text) a projection loads
   * for an excerpt: a larger value is only named as large, its result
   * envelope still giving the outcome, and `read_tool_call` pages it. Keeps
   * the per-request projection of many large calls bounded. */
  projectionValueBytes: 16 * 1024,
  /** Calls whose saved values one projection query loads at once. */
  projectionBatchCalls: 256,
  /** The admission read of a branch's history inside one database
   * transaction (a long chat stays far below it; the stateful timing check
   * measures it). A slower read freezes "could not be loaded", never refusing
   * the message. */
  transactionMs: 15_000,
  transactionWaitMs: 5_000,
  /** Every per-request read (projection, call read, availability check)
   * holds a pooled connection only this long; a slower one degrades. */
  requestTransactionMs: 5_000,
  requestTransactionWaitMs: 2_000,
  /** Runs with calls one admission reads, newest first, before the rest of
   * the branch's calls are counted as omitted without being read. */
  scannedRuns: 1024,
  scanBatchRuns: 64
});

/** A per-run memo the history reader keeps between one run's requests: only
 * what never changes for an accepted run. Authority is rechecked every time. */
export type ToolHistoryCache = Map<string, unknown>;

const CALL_REF_PREFIX = "tcr1_";
const MESSAGE_PREFIX = "tch1_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CALL_REF = /^tcr1_[0-9a-f]{32}$/u;

/** The stable, opaque reference of one persisted tool call. It names the call,
 * never its position in a rendered record, and grants no authority. */
export function toolCallRef(callId: string): string | null {
  const id = callId.toLowerCase();
  return UUID.test(id) ? `${CALL_REF_PREFIX}${id.replaceAll("-", "")}` : null;
}

export function isToolCallRef(value: unknown): value is string {
  return typeof value === "string" && CALL_REF.test(value);
}

/** The `ModelRunToolCall.id` a reference names, or null for any other text. */
export function toolCallIdFromRef(ref: unknown): string | null {
  if (!isToolCallRef(ref)) return null;
  const hex = ref.slice(CALL_REF_PREFIX.length);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The stable provider-only message id of one turn's record. */
export function toolHistoryMessageId(turnMessageId: string): string {
  return `${MESSAGE_PREFIX}${turnMessageId}`;
}

export function isToolHistoryMessageId(id: string): boolean {
  return id.startsWith(MESSAGE_PREFIX) && id.length > MESSAGE_PREFIX.length;
}

/** The turn message a record id names, or null. */
export function toolHistoryTurnMessageId(id: string): string | null {
  return isToolHistoryMessageId(id) ? id.slice(MESSAGE_PREFIX.length) : null;
}

export type ToolHistoryDigestCall = Readonly<{ id: string; ordinal: number; roundIndex: number; toolName: string }>;

/** Canonical (sorted keys, fixed order) and therefore stable across a jsonb
 * round trip of the rows it describes. */
export function toolHistoryDigest(calls: readonly ToolHistoryDigestCall[]): string {
  const canonical = JSON.stringify(calls.map(call => ({
    id: call.id.toLowerCase(), ordinal: call.ordinal, roundIndex: call.roundIndex, toolName: call.toolName
  })));
  return createHash("sha256").update(canonical).digest("hex");
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const count = (value: unknown, maximum: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const messageId = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

/** Strict decoder for the frozen field; any other shape refuses the request. */
export function decodeToolHistorySnapshot(value: unknown): ToolHistorySnapshot | null {
  if (!record(value) || !exactKeys(value, ["turns", "version"], ["omittedCalls", "unavailable"]) || value.version !== TOOL_HISTORY_VERSION ||
    !Array.isArray(value.turns) || value.turns.length > TOOL_HISTORY_LIMITS.turns ||
    value.omittedCalls !== undefined && (!count(value.omittedCalls, Number.MAX_SAFE_INTEGER) || value.omittedCalls === 0) ||
    // A history that could not be read lists and counts nothing.
    value.unavailable !== undefined && (value.unavailable !== true || value.turns.length > 0 || value.omittedCalls !== undefined)) return null;
  const seenTurns = new Set<string>();
  const seenRefs = new Set<string>();
  for (const turn of value.turns) {
    if (!record(turn) || !exactKeys(turn, ["callRefs", "digest", "turnMessageId"], ["readerCalls", "userMessageId"]) ||
      !messageId(turn.turnMessageId) || seenTurns.has(turn.turnMessageId) ||
      turn.userMessageId !== undefined && !messageId(turn.userMessageId) ||
      typeof turn.digest !== "string" || !/^[a-f0-9]{64}$/u.test(turn.digest) ||
      !Array.isArray(turn.callRefs) ||
      turn.readerCalls !== undefined && (!count(turn.readerCalls, TOOL_HISTORY_LIMITS.readerCalls) || turn.readerCalls === 0) ||
      turn.callRefs.length === 0 && turn.readerCalls === undefined) return null;
    seenTurns.add(turn.turnMessageId);
    for (const ref of turn.callRefs) {
      if (!isToolCallRef(ref) || seenRefs.has(ref)) return null;
      seenRefs.add(ref);
    }
  }
  if (seenRefs.size > TOOL_HISTORY_LIMITS.calls) return null;
  return value as ToolHistorySnapshot;
}

/** Whether a run was accepted under the cross-turn history contract: only its
 * calls appear in later records or answer the call reader. */
export function toolHistoryEligible(normalizedRequest: unknown): boolean {
  return record(normalizedRequest) && record(normalizedRequest.toolHistory) &&
    normalizedRequest.toolHistory.version === TOOL_HISTORY_VERSION;
}

/** The call reader's tool name; one leaf owner for every classifier. */
export const READ_TOOL_CALL_NAME = "read_tool_call";

/** The index entry of one persisted call of the current run. */
export function toolCallRefEntry(call: Readonly<{ arguments: unknown; id: string; providerCallId: string; toolName: string }>): ToolCallRefEntry | null {
  const ref = toolCallRef(call.id);
  if (!ref) return null;
  const read = call.toolName === READ_TOOL_CALL_NAME && record(call.arguments) && isToolCallRef(call.arguments.call_ref)
    ? call.arguments.call_ref : undefined;
  return { callId: call.providerCallId, name: call.toolName, ref, ...(read ? { readRef: read } : {}) };
}

/** The index of a run's persisted calls. A provider call id that names two
 * persisted calls (another round reused it) identifies neither. */
export function toolCallRefIndex(entries: readonly ToolCallRefEntry[] | undefined): ReadonlyMap<string, ToolCallRefEntry> {
  const index = new Map<string, ToolCallRefEntry>();
  const ambiguous = new Set<string>();
  for (const entry of entries ?? []) {
    if (!isToolCallRef(entry.ref)) continue;
    const existing = index.get(entry.callId);
    if (existing && existing.ref !== entry.ref) ambiguous.add(entry.callId);
    if (!existing) index.set(entry.callId, entry);
  }
  for (const callId of ambiguous) index.delete(callId);
  return index;
}

/** The provider-only class of a tool-history record. It is neither a pin
 * (`purpose`) nor a real chat message: reducible history of its own turn. */
export const TOOL_HISTORY_CLASS = "tool_history";

export function isToolHistoryMessage(message: Readonly<{ historyClass?: unknown }>): boolean {
  return message.historyClass === TOOL_HISTORY_CLASS;
}

/** The record of earlier attempts of the current message, placed just before
 * it. It belongs to the current turn, which never leaves a request. */
export function isCurrentTurnToolHistory(
  message: Readonly<{ historyClass?: unknown; id: string }>,
  current: Readonly<{ id: string }> | undefined
): boolean {
  return current !== undefined && isToolHistoryMessage(message) && message.id === toolHistoryMessageId(current.id);
}
