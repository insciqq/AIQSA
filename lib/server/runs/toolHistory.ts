import type { ToolHistoryBlock, ToolHistoryProjection } from "../../contracts/toolHistory";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  isToolHistoryMessage,
  TOOL_HISTORY_CLASS,
  TOOL_HISTORY_LIMITS,
  toolHistoryMessageId
} from "./toolHistoryContract";

export type { ToolHistoryBlock, ToolHistoryEntry, ToolHistoryMessageData, ToolHistoryProjection } from "../../contracts/toolHistory";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export function omittedEntriesLine(count: number): string {
  return `- ${count} earlier call${count === 1 ? "" : "s"} of this turn ${count === 1 ? "is" : "are"} not listed here (record size limit); this does not mean ${count === 1 ? "it" : "they"} did not happen.`;
}

const NAMED_PREFIX = " read_tool_call reads them by call_ref:";

/** The omission line, naming `refs` (newest first) when given. */
function omissionLine(count: number, refs: readonly string[]): string {
  return omittedEntriesLine(count) + (refs.length ? `${NAMED_PREFIX} ${refs.join(", ")}` : "");
}

/**
 * The lines of one record within `budgetBytes`, chronological. As many of
 * the newest entries as fit stay listed by their compact line, the newest of
 * them upgraded to their full line while room remains; older entries are
 * counted on one omission line that (with `nameOmittedRefs`) names as many of
 * their call_refs, newest first, as still fit. The header and the footer are
 * always kept.
 */
export function renderToolHistoryBlock(block: ToolHistoryBlock, budgetBytes: number = TOOL_HISTORY_LIMITS.blockBytes,
  options: Readonly<{ nameOmittedRefs?: boolean }> = {}): Readonly<{
  lines: readonly string[];
  detailRefs: readonly string[];
}> {
  const { entries } = block;
  const fixed = bytes(block.header) + 1 + (block.footer ? bytes(block.footer) + 1 : 0);
  // Naming omitted calls for the reader may take up to a quarter of the room.
  const namingReserve = options.nameOmittedRefs ? Math.floor(Math.max(0, budgetBytes) / 4) : 0;
  const refBytes: number[] = [0];
  for (const entry of entries) refBytes.push(refBytes.at(-1)! + bytes(entry.ref) + 2);
  const omissionBytes = (count: number) => count > 0
    ? bytes(omittedEntriesLine(count)) + 1 + Math.min(namingReserve, namingReserve ? bytes(NAMED_PREFIX) + refBytes[count]! : 0) : 0;
  // Compact bytes of the listed suffix, from the oldest listed entry on.
  let listedBytes = entries.reduce((total, entry) => total + bytes(entry.compact) + 1, 0);
  let first = 0;
  while (first < entries.length && fixed + listedBytes + omissionBytes(first) > budgetBytes) {
    listedBytes -= bytes(entries[first]!.compact) + 1;
    first += 1;
  }
  let remaining = budgetBytes - fixed - listedBytes - (first > 0 ? bytes(omittedEntriesLine(first)) + 1 : 0);
  let omission = first > 0 ? omittedEntriesLine(first) : null;
  if (omission && options.nameOmittedRefs) {
    const base = bytes(omission);
    omission = withRefs(omission, entries.slice(0, first).map(entry => entry.ref).reverse(),
      base + Math.min(Math.max(0, remaining), namingReserve));
    remaining -= bytes(omission) - base;
  }
  const full = new Set<number>();
  for (let index = entries.length - 1; index >= first; index -= 1) {
    const extra = bytes(entries[index]!.full) - bytes(entries[index]!.compact);
    if (extra <= remaining) {
      full.add(index);
      remaining -= extra;
    }
  }
  const lines = [block.header, ...(omission ? [omission] : []),
    ...entries.slice(first).map((entry, offset) => full.has(first + offset) ? entry.full : entry.compact),
    ...(block.footer ? [block.footer] : [])];
  return { lines, detailRefs: entries.flatMap((entry, index) => full.has(index) && entry.details ? [entry.ref] : []) };
}

/** `line` naming as many of `refs` as fit within `budgetBytes`. */
function withRefs(line: string, refs: readonly string[], budgetBytes: number): string {
  let text = line;
  let named = 0;
  for (const ref of refs) {
    const next = `${named === 0 ? text + NAMED_PREFIX : text + ","} ${ref}`;
    if (bytes(next) > budgetBytes) break;
    text = next;
    named += 1;
  }
  return text;
}

/**
 * Records rendered newest first within `budgetBytes` in total (an Agent
 * prompt's room): each takes at most its normal bound, its omitted entries
 * named for the reader as space allows; records older than the room for a
 * header leave one line counting their calls. Texts in record order; an
 * empty text is a record left out entirely.
 */
export function boundedToolHistoryTexts(blocks: readonly ToolHistoryBlock[], budgetBytes: number): string[] {
  const texts = blocks.map(() => "");
  const markerReserve = 1024;
  let remaining = budgetBytes - markerReserve;
  let cut = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const minimum = bytes(block.header) + (block.footer ? bytes(block.footer) + 1 : 0) +
      (block.entries.length ? bytes(omittedEntriesLine(block.entries.length)) + 1 : 0);
    if (remaining < minimum) {
      cut = index;
      break;
    }
    const text = renderToolHistoryBlock(block, Math.min(TOOL_HISTORY_LIMITS.blockBytes, remaining), { nameOmittedRefs: true })
      .lines.join("\n");
    texts[index] = text;
    remaining -= bytes(text) + 1;
  }
  if (cut >= 0) {
    const calls = blocks.slice(0, cut + 1).flatMap(block => block.entries.map(entry => entry.ref)).reverse();
    const line = `[AIQSA: ${calls.length} older tool call${calls.length === 1 ? "" : "s"} of this chat ${calls.length === 1 ? "is" : "are"} omitted from this prompt for size; this does not mean ${calls.length === 1 ? "it" : "they"} did not happen.`;
    texts[cut] = `${calls.length ? withRefs(line, calls, Math.max(bytes(line), markerReserve + Math.max(0, remaining) - 1)) : line}]`;
  }
  return texts;
}

/** The provider-only message of one record: role assistant, without `purpose`. */
export function toolHistoryMessage(block: ToolHistoryBlock, budgetBytes?: number): ProviderConversationMessage {
  const id = toolHistoryMessageId(block.turnMessageId);
  const rendered = renderToolHistoryBlock(block, budgetBytes);
  return {
    content: { blocks: rendered.lines.map(text => ({ text, type: "text" })) },
    contextTurnId: id,
    historyClass: TOOL_HISTORY_CLASS,
    id,
    role: "assistant",
    toolHistory: { block, detailRefs: rendered.detailRefs }
  };
}

export function withoutToolHistory(messages: readonly ProviderConversationMessage[]): ProviderConversationMessage[] {
  return messages.filter(message => !isToolHistoryMessage(message));
}

/** Where a record belongs in `messages` (records already removed): before
 * its answer; for the current message, before that message; for an answer
 * that is not in the context, after the last message of its user turn. */
function anchorIndex(messages: readonly ProviderConversationMessage[], block: ToolHistoryBlock): number | null {
  const current = messages.at(-1);
  if (current && block.turnMessageId === current.id) return messages.length - 1;
  const answer = messages.findIndex(message => message.id === block.turnMessageId && message.role === "assistant" &&
    message.purpose === undefined);
  if (answer >= 0) return answer;
  if (!block.userMessageId) return null;
  const user = messages.findIndex(message => message.id === block.userMessageId && message.role === "user");
  if (user < 0 || messages[user] === current) return null;
  let end = user + 1;
  while (end < messages.length - 1 && !(messages[end]!.role === "user" && messages[end]!.contextTurnId !== block.userMessageId)) {
    end += 1;
  }
  return end;
}

/**
 * The one projector of third-class history messages: the request's context
 * with every record of `projection` placed by its turn (records already
 * present are replaced). Budget and compaction apply afterwards.
 */
export function insertToolHistory(request: ProviderRunRequest, projection: ToolHistoryProjection): ProviderRunRequest {
  if (!request.context) return request;
  const messages = withoutToolHistory(request.context.messages);
  const before = new Map<number, ProviderConversationMessage[]>();
  for (const block of projection.blocks) {
    const index = anchorIndex(messages, block);
    if (index === null) continue;
    before.set(index, [...(before.get(index) ?? []), toolHistoryMessage(block)]);
  }
  if (before.size === 0 && messages.length === request.context.messages.length) return request;
  return { ...request, context: { ...request.context,
    messages: messages.flatMap((message, index) => [...(before.get(index) ?? []), message]) } };
}

/**
 * Re-renders the records a request still carries from a fresh projection,
 * in place: a record that left the request (covered and released) is never
 * added back, and one whose turn the projection no longer has leaves.
 */
export function refreshToolHistory(request: ProviderRunRequest, projection: ToolHistoryProjection): ProviderRunRequest {
  const messages = request.context?.messages;
  if (!messages?.some(isToolHistoryMessage)) return request;
  const blocks = new Map(projection.blocks.map(block => [toolHistoryMessageId(block.turnMessageId), block]));
  return { ...request, context: { ...request.context!, messages: messages.flatMap(message => {
    if (!isToolHistoryMessage(message)) return [message];
    const block = blocks.get(message.id);
    return block ? [toolHistoryMessage(block)] : [];
  }) } };
}

export function requestHasToolHistory(request: Pick<ProviderRunRequest, "context">): boolean {
  return request.context?.messages.some(isToolHistoryMessage) === true;
}
