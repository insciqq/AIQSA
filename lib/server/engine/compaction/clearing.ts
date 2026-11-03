import { contextItemTokens, type ContextMeasureCalibration } from "../contextMeasure";
import { selectTranscript, type TranscriptItem, type TranscriptTarget, type TranscriptToolCallItem, type TranscriptToolResultItem } from "../transcript";
import {
  COMPACTION_PRODUCT_TOOLS,
  defaultCompactionToolKind,
  describeArguments,
  resultLength,
  workspaceOperation,
  type CompactionToolCall
} from "./retained";

/**
 * Clearing old page results: provider context editing's "clear old tool results", done by the engine with no model call
 * and no summary. Once the measured context passes `clearAboveTokens`, the oldest page results (pages, Search results,
 * Workspace and browser output, saved results read again) each become a short stub that names the tool, its target, the
 * result's size and the `read_tool_result` call that brings it back, oldest first, until the context is down to
 * `clearToTokens`. It happens in one step, so a provider's prompt cache misses once per clearing rather than at every
 * step: the newest `keepRecentResults` page results stay whole, and a clearing that would free less than
 * `clearAtLeastTokens` waits until it can. Everything else stays as it was: the user's and the model's words, the brief
 * and what the server added to it, every call with its arguments, reasoning, and the results of every other tool (a
 * researcher's records and frame changes, a report, a Skill's instructions).
 *
 * A stub is a later result of the same call (`TranscriptToolResultItem.cleared`). Replay already takes a call's latest
 * result in its place (`selectTranscript`), so only that result's output text changes, never a call, its pairing or a
 * reasoning item, on every adapter; and the transcript records it like any result, so a resumed or replayed thread renders
 * the same context, as reliably as any item is recorded: a stub whose write failed leaves the next turn the whole pages, and
 * that turn clears them again. What to clear is decided from the transcript and the measured size alone, never from the time. A
 * result nothing reads back (one too short to be saved, or not saved) is never cleared.
 */

export type ToolResultClearingPolicy = Readonly<{
  /** Clears once the measured context passes this many tokens. */
  clearAboveTokens: number;
  /** A clearing that would free fewer tokens than this waits: a cache miss is worth no less. */
  clearAtLeastTokens: number;
  /** Clears down to this many tokens, as far as the results it may clear allow. */
  clearToTokens: number;
  /** The newest page results, which always stay whole. */
  keepRecentResults: number;
}>;

/** Product tool names the clearing reads, kept here so the module stays a light leaf (its test pins them to their owners). */
export const CLEARING_PRODUCT_TOOLS = Object.freeze({
  fetchUrl: "fetch_url",
  /** The Search tools (`HARNESS_SEARCH_TOOL`): one for every selected source, or one per source. */
  search: /^(?:search_selected_engines|search_engine_[1-3])$/u
});

/** A call whose result is text from outside that an agent read: a page, Search results, a command's or the browser's output, a file, a saved result read again. */
export function pageBearingCall(call: CompactionToolCall): boolean {
  if (call.name === CLEARING_PRODUCT_TOOLS.fetchUrl || call.name === COMPACTION_PRODUCT_TOOLS.readToolResult ||
    CLEARING_PRODUCT_TOOLS.search.test(call.name)) return true;
  // A running command's later output, which the record's kinds leave out.
  if (workspaceOperation(call.name) === "sandbox_exec_poll") return true;
  const kind = defaultCompactionToolKind(call);
  return kind === "workspace_command" || kind === "workspace_read";
}

/** How a stub begins, whatever it stands for. */
export const CLEARED_RESULT_HEADING = "[Cleared to keep this context small: ";

/** What a stub says in place of a result: the tool and its target, the size the result had, and the read that brings it back. */
export function clearedResultText(input: Readonly<{ characters: number; name: string; restore: Readonly<Record<string, unknown>>; target: string }>): string {
  return `${CLEARED_RESULT_HEADING}${input.characters.toLocaleString("en-US")} characters of ${input.name}${input.target ? ` ${input.target}` : ""}. ` +
    `Nothing is lost: call ${COMPACTION_PRODUCT_TOOLS.readToolResult} with ${JSON.stringify(input.restore)} to read it again.]`;
}

const HANDLE = /^tor1_[a-f0-9]{32}$/u;

function argumentsOf(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** The `read_tool_result` arguments that bring a result back: its saved whole by handle, or a read the same read again. */
function restoreArguments(call: TranscriptToolCallItem, result: TranscriptToolResultItem): Readonly<Record<string, unknown>> | null {
  if (result.handle) return HANDLE.test(result.handle) ? { handle: result.handle } : null;
  if (call.name !== COMPACTION_PRODUCT_TOOLS.readToolResult) return null;
  const read = argumentsOf(call.arguments);
  if (typeof read.handle !== "string" || !HANDLE.test(read.handle)) return null;
  return { handle: read.handle, ...(count(read.offset) ? { offset: read.offset } : {}), ...(count(read.limit) ? { limit: read.limit } : {}) };
}

export type ToolResultClearingInput = Readonly<{
  /** Item weights of the target's provider family (`contextMeasureCalibration`). */
  calibration?: ContextMeasureCalibration;
  /** Local token estimate for the target's tokenizer family. */
  estimate: (value: unknown) => number;
  items: readonly TranscriptItem[];
  /** The id of each stub (the loop's `randomUUID`). */
  nextId: () => string;
  /** Which calls return pages; `pageBearingCall` when absent. */
  pageBearing?: (call: CompactionToolCall) => boolean;
  policy: ToolResultClearingPolicy;
  target: TranscriptTarget;
  /** The measured size of the next request (`measureContext(...).tokens`). */
  tokens: number;
}>;

export type ToolResultClearing = Readonly<{
  /** Estimated tokens the stubs free. */
  freedTokens: number;
  /** The stubs to append, oldest result first. */
  items: readonly TranscriptToolResultItem[];
}>;

/**
 * The stubs that take the context from `tokens` down to the policy's low mark, or null when it is not past the high mark,
 * or when what may be cleared frees less than a clearing is worth. A single result larger than the low mark is cleared
 * like any other once it is old, and while it is among the newest it stays whole: the context then stays above the low
 * mark until it ages, and nothing is cleared at each step meanwhile.
 */
export function planToolResultClearing(input: ToolResultClearingInput): ToolResultClearing | null {
  const policy = input.policy;
  if (!(input.tokens > policy.clearAboveTokens)) return null;
  const pageBearing = input.pageBearing ?? pageBearingCall;
  const calls = new Map<string, TranscriptToolCallItem>();
  const pages: Array<Readonly<{ call: TranscriptToolCallItem; result: TranscriptToolResultItem }>> = [];
  for (const { item } of selectTranscript(input.items, input.target).entries) {
    if (item.kind === "tool_call") calls.set(item.callId, item);
    if (item.kind !== "tool_result" || item.outcome !== "complete" || item.cleared === true || item.image || item.inFlight) continue;
    const call = calls.get(item.callId);
    if (call && pageBearing({ arguments: call.arguments, name: call.name })) pages.push({ call, result: item });
  }
  const weigh = (item: TranscriptItem) => contextItemTokens(item, input.target, input.estimate, "opaque", input.calibration);
  const stubs: TranscriptToolResultItem[] = [];
  let tokens = input.tokens;
  for (const { call, result } of pages.slice(0, Math.max(0, pages.length - Math.max(0, policy.keepRecentResults)))) {
    if (tokens <= policy.clearToTokens) break;
    const restore = restoreArguments(call, result);
    if (!restore) continue;
    const output = clearedResultText({ characters: resultLength(result.output), name: result.name, restore, target: describeArguments(call.arguments) });
    const freed = weigh(result) - weigh({ ...result, output });
    if (freed <= 0) continue;
    stubs.push({ callId: result.callId, cleared: true, ...(result.handle ? { handle: result.handle } : {}), id: input.nextId(), kind: "tool_result",
      name: result.name, outcome: "complete", output });
    tokens -= freed;
  }
  const freedTokens = input.tokens - tokens;
  return stubs.length > 0 && freedTokens >= policy.clearAtLeastTokens ? { freedTokens, items: stubs } : null;
}
