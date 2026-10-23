import type { TokenUsage } from "../../domain/usage";
import type { ProviderHistoryItem, ProviderNativeData } from "../providers/history";

/**
 * The native agent engine's provider-neutral transcript: every turn of a chat
 * as items, the only state a request is built from. A request replays it to
 * one provider route and model (`projectTranscript`); the adapter renders the
 * resulting `ProviderRunRequest.history` in its own wire format.
 *
 * Replay rules:
 * - reasoning blobs go back only to the provider route and model that
 *   produced them and are dropped on a model switch; the same holds for the
 *   provider-native fields of text and tool calls (Gemini signatures,
 *   Responses item ids), while their text and arguments are neutral;
 * - every tool call is followed by exactly one result before anything else:
 *   results are pulled up to their call's response, a call without a recorded
 *   result gets an explicit unknown outcome, a result without its call stays
 *   out; of several results of one call the latest recorded wins (a call that
 *   waited for the user's approval and then ran);
 * - replay starts at the latest compaction the target can use: its own native
 *   compaction item, or a summary text any target can read; a compaction
 *   that keeps a recent tail verbatim (`keepFromId`) replays that tail right
 *   after itself, then everything appended since, and one whose tail is no
 *   longer found before it is not used;
 * - reasoning with no text or call after it in its response stays out.
 */

/** The provider route and model an item came from. `provider` names the route
 * exactly (the admitted connection), so a blob never crosses a credential. */
export type TranscriptOrigin = Readonly<{ model: string; provider: string }>;

/** A request's destination and how the transcript replays there. */
export type TranscriptTarget = TranscriptOrigin & Readonly<{
  /** The route takes back its own native compaction items (Responses). */
  nativeCompaction?: boolean;
  /** `current_turn`: reasoning before the current turn's user item stays out. */
  reasoningScope?: "all" | "current_turn";
}>;

export type TranscriptUserItem = Readonly<{
  /** A follow-up delivered into a running turn; it does not start a turn. */
  followup?: true;
  id: string;
  kind: "user";
  text: string;
}>;

export type TranscriptAssistantTextItem = Readonly<{
  id: string;
  kind: "assistant_text";
  native?: ProviderNativeData;
  /** Absent for text the engine did not receive from a model (imported history). */
  origin?: TranscriptOrigin;
  /** The provider-reported output tokens attributed to this item. */
  outputTokens?: number;
  text: string;
}>;

export type TranscriptReasoningItem = Readonly<{
  id: string;
  kind: "reasoning";
  native: ProviderNativeData;
  origin: TranscriptOrigin;
  outputTokens?: number;
}>;

export type TranscriptToolCallItem = Readonly<{
  arguments: string;
  callId: string;
  id: string;
  kind: "tool_call";
  name: string;
  native?: ProviderNativeData;
  origin?: TranscriptOrigin;
  outputTokens?: number;
}>;

export type TranscriptToolResultItem = Readonly<{
  callId: string;
  /** The saved whole result (`read_tool_result`) when `output` is an excerpt of it. */
  handle?: string;
  id: string;
  kind: "tool_result";
  name: string;
  /** `unknown`: the call may or may not have taken effect (never re-sent). */
  outcome: "complete" | "error" | "unknown";
  output: string;
}>;

export type TranscriptCompactionItem = Readonly<{
  id: string;
  /** The first item replay keeps verbatim after this compaction (its recent
   * tail). Replay continues there and skips this item where it stands, so a
   * compaction appended at a turn boundary covers only what precedes the
   * tail. Absent: replay continues with the items after this one. */
  keepFromId?: string;
  kind: "compaction";
  native?: ProviderNativeData;
  origin: TranscriptOrigin;
  /** Provider-reported output tokens of the call that produced `native`. */
  outputTokens?: number;
  /** Text replayed with the compaction to every target that uses it: the
   * code-generated record of the work and the earlier user messages verbatim. */
  retained?: string;
  /** Readable summary of everything before the kept tail, for any target. */
  summary?: string;
}>;

export type TranscriptItem =
  | TranscriptAssistantTextItem
  | TranscriptCompactionItem
  | TranscriptReasoningItem
  | TranscriptToolCallItem
  | TranscriptToolResultItem
  | TranscriptUserItem;

export const UNRECORDED_TOOL_RESULT =
  "No result was recorded for this tool call; treat its outcome as unknown.";
export const COMPACTION_SUMMARY_HEADING = "Summary of the earlier conversation:";

export function sameTranscriptOrigin(origin: TranscriptOrigin | undefined, target: TranscriptOrigin): boolean {
  return origin !== undefined && origin.provider === target.provider && origin.model === target.model;
}

/** Integer shares of `total` in proportion to `weights`; the last takes the rounding. */
function shares(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((left, right) => left + right, 0);
  const parts = weights.map((weight) =>
    Math.floor(sum > 0 ? total * weight / sum : total / weights.length));
  const last = parts.length - 1;
  parts[last] = (parts[last] ?? 0) + total - parts.reduce((left, right) => left + right, 0);
  return parts;
}

function reportedCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The items of one model response (`ProviderRunResult.history`), tagged with
 * the route and model that produced them. The call's reported output tokens
 * are shared out for the context measure: reasoning tokens over its
 * reasoning items, the rest over its text and calls by local estimate. A
 * response without a usable report attributes nothing.
 */
export function modelResponseItems(input: Readonly<{
  estimate: (value: unknown) => number;
  history: readonly ProviderHistoryItem[];
  nextId: () => string;
  origin: TranscriptOrigin;
  usage?: Pick<TokenUsage, "outputTokens" | "reasoningTokens"> | null;
}>): TranscriptItem[] {
  const origin = { model: input.origin.model, provider: input.origin.provider };
  const items = input.history.map((entry): TranscriptItem => {
    const id = input.nextId();
    switch (entry.type) {
      case "assistant_text":
        return { id, kind: "assistant_text", ...(entry.native ? { native: entry.native } : {}), origin, text: entry.text };
      case "reasoning":
        return { id, kind: "reasoning", native: entry.native, origin };
      case "tool_call":
        return {
          arguments: entry.arguments, callId: entry.callId, id, kind: "tool_call", name: entry.name,
          ...(entry.native ? { native: entry.native } : {}), origin
        };
      case "compaction":
        return { id, kind: "compaction", native: entry.native, origin };
      case "tool_result":
      case "user":
        throw new Error("transcript_response_item_invalid");
    }
  });

  const output = reportedCount(input.usage?.outputTokens);
  const reasoning = reportedCount(input.usage?.reasoningTokens);
  const reasoningItems = items.filter((item) => item.kind === "reasoning");
  const visibleItems = items.filter((item) => item.kind === "assistant_text" || item.kind === "tool_call");
  if (output === null || items.some((item) => item.kind === "compaction") ||
    (reasoningItems.length > 0 && reasoning === null)) return items;
  const visible = output - (reasoning ?? 0);
  if (visible < 0) return items;
  const attributed = new Map<string, number>();
  shares(visible, visibleItems.map((item) => Math.max(1, item.kind === "assistant_text"
    ? input.estimate(item.text) : item.kind === "tool_call" ? input.estimate(item.name) + input.estimate(item.arguments) : 1)))
    .forEach((tokens, index) => attributed.set(visibleItems[index]!.id, tokens));
  shares(reasoning ?? 0, reasoningItems.map(() => 1))
    .forEach((tokens, index) => attributed.set(reasoningItems[index]!.id, tokens));
  return items.map((item) => {
    const tokens = attributed.get(item.id);
    return tokens === undefined || item.kind === "compaction" || item.kind === "tool_result" || item.kind === "user"
      ? item : { ...item, outputTokens: tokens };
  });
}

/** One item a request carries; `key` identifies what was sent for the measure. */
export type SelectedTranscriptItem = Readonly<{ item: TranscriptItem; key: string }>;

export type TranscriptSelection = Readonly<{
  /** The compaction replay starts at, or null when it starts at the beginning. */
  base: TranscriptCompactionItem | null;
  entries: readonly SelectedTranscriptItem[];
  /** Index of the first transcript item replay may use (its compaction). */
  start: number;
  /** The items replay draws from, in transcript order: the base compaction,
   * the tail it keeps verbatim, then every item after it. */
  window: readonly TranscriptItem[];
}>;

/** The target replays the compaction's own native item (same route and model). */
export function replaysNativeCompaction(item: TranscriptCompactionItem, target: TranscriptTarget): boolean {
  return item.native !== undefined && target.nativeCompaction === true && sameTranscriptOrigin(item.origin, target);
}

function usableCompaction(item: TranscriptCompactionItem, target: TranscriptTarget): boolean {
  return replaysNativeCompaction(item, target) || (typeof item.summary === "string" && item.summary.length > 0);
}

/** The text a compaction replays as to a target that does not take its native item. */
export function compactionSummaryText(item: TranscriptCompactionItem): string {
  return [`${COMPACTION_SUMMARY_HEADING}\n\n${item.summary ?? ""}`, ...(item.retained ? [item.retained] : [])].join("\n\n");
}

/** Where a compaction's kept tail starts: 0 without one, -1 when the tail
 * is not found before the compaction (an id that did not survive a rebuilt
 * conversation). Such a compaction is not used: replay never silently drops
 * the tail it promised to keep. */
function keptTailIndex(items: readonly TranscriptItem[], index: number, item: TranscriptCompactionItem): number {
  if (!item.keepFromId) return 0;
  const keepFrom = items.findIndex((candidate) => candidate.id === item.keepFromId);
  return keepFrom >= 0 && keepFrom < index ? keepFrom : -1;
}

/** Replay's items from the base compaction at `start`: the base, the tail it
 * keeps verbatim, then the items after it. */
function replayWindow(items: readonly TranscriptItem[], start: number, base: TranscriptCompactionItem | null): TranscriptItem[] {
  if (!base?.keepFromId) return items.slice(start);
  const keepFrom = keptTailIndex(items, start, base);
  return [base, ...items.slice(keepFrom, start), ...items.slice(start + 1)];
}

/** The transcript items a request to `target` carries, in replay order. */
export function selectTranscript(items: readonly TranscriptItem[], target: TranscriptTarget): TranscriptSelection {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error("transcript_item_id_duplicate");
    ids.add(item.id);
  }
  let start = 0;
  let base: TranscriptCompactionItem | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "compaction" && usableCompaction(item, target) && keptTailIndex(items, index, item) >= 0) {
      start = index;
      base = item;
      break;
    }
  }
  const window = replayWindow(items, start, base);
  const leadingCompaction = base !== null;

  let turnStart = -1;
  if (target.reasoningScope === "current_turn") {
    for (let index = window.length - 1; index >= 0; index -= 1) {
      const item = window[index]!;
      if (item.kind === "user" && !item.followup) {
        turnStart = index;
        break;
      }
    }
  }

  const results = new Map<string, TranscriptToolResultItem>();
  for (const item of window) {
    if (item.kind === "tool_result") results.set(item.callId, item);
  }
  const entries: SelectedTranscriptItem[] = [];
  const calls = new Set<string>();
  let block: SelectedTranscriptItem[] = [];
  // A response's items, then the results of its calls in call order.
  const closeBlock = () => {
    let last = block.length - 1;
    while (last >= 0 && block[last]!.item.kind === "reasoning") last -= 1;
    const kept = block.slice(0, last + 1);
    entries.push(...kept);
    for (const entry of kept) {
      if (entry.item.kind !== "tool_call") continue;
      const result = results.get(entry.item.callId);
      entries.push(result
        ? { item: result, key: result.id }
        : {
            item: {
              callId: entry.item.callId, id: `${entry.item.id}#result`, kind: "tool_result",
              name: entry.item.name, outcome: "unknown", output: UNRECORDED_TOOL_RESULT
            },
            key: `${entry.item.id}#result`
          });
    }
    block = [];
  };

  window.forEach((item, index) => {
    const entry = { item, key: item.id };
    if (index === 0 && leadingCompaction) {
      entries.push(entry);
      return;
    }
    switch (item.kind) {
      case "reasoning":
        if (sameTranscriptOrigin(item.origin, target) && index >= turnStart) block.push(entry);
        return;
      case "assistant_text":
        block.push(entry);
        return;
      case "tool_call":
        if (calls.has(item.callId)) return;
        calls.add(item.callId);
        block.push(entry);
        return;
      case "user":
        closeBlock();
        entries.push(entry);
        return;
      case "tool_result":
      case "compaction":
        // Results go out with their calls; an unusable compaction is skipped.
        closeBlock();
        return;
    }
  });
  closeBlock();
  return { base, entries, start, window };
}

export type TranscriptProjectionOptions = Readonly<{
  /** The run's own user item: the adapter renders it with the run's attachments. */
  currentInputId?: string;
}>;

function historyItems(
  item: TranscriptItem,
  target: TranscriptTarget,
  options: TranscriptProjectionOptions
): ProviderHistoryItem[] {
  switch (item.kind) {
    case "user":
      return [{ ...(item.id === options.currentInputId ? { currentInput: true as const } : {}), text: item.text, type: "user" }];
    case "assistant_text":
      return [{
        ...(item.native && sameTranscriptOrigin(item.origin, target) ? { native: item.native } : {}),
        text: item.text,
        type: "assistant_text"
      }];
    case "reasoning":
      return [{ native: item.native, type: "reasoning" }];
    case "tool_call":
      return [{
        arguments: item.arguments,
        callId: item.callId,
        name: item.name,
        ...(item.native && sameTranscriptOrigin(item.origin, target) ? { native: item.native } : {}),
        type: "tool_call"
      }];
    case "tool_result":
      return [{
        callId: item.callId,
        ...(item.outcome === "error" ? { isError: true as const } : {}),
        name: item.name,
        output: item.output,
        type: "tool_result"
      }];
    case "compaction": {
      const native = replaysNativeCompaction(item, target) ? item.native : undefined;
      return native
        ? [{ native, type: "compaction" }, ...(item.retained ? [{ text: item.retained, type: "user" as const }] : [])]
        : [{ text: compactionSummaryText(item), type: "user" }];
    }
  }
}

/** `ProviderRunRequest.history` for selected items, in their order. */
export function projectSelection(
  entries: readonly SelectedTranscriptItem[],
  target: TranscriptTarget,
  options: TranscriptProjectionOptions = {}
): ProviderHistoryItem[] {
  return entries.flatMap(({ item }) => historyItems(item, target, options));
}

/** `ProviderRunRequest.history` for a request to `target`. */
export function projectTranscript(
  items: readonly TranscriptItem[],
  target: TranscriptTarget,
  options: TranscriptProjectionOptions = {}
): ProviderHistoryItem[] {
  return projectSelection(selectTranscript(items, target).entries, target, options);
}
