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

/**
 * The lines of one record within `budgetBytes`, chronological: the newest
 * entries keep their full line while it fits, older ones their compact line,
 * and entries older than that are named by one omission line. The header and
 * the footer are always kept.
 */
export function renderToolHistoryBlock(block: ToolHistoryBlock, budgetBytes: number = TOOL_HISTORY_LIMITS.blockBytes,
  options: Readonly<{ nameOmittedRefs?: boolean }> = {}): Readonly<{
  lines: readonly string[];
  detailRefs: readonly string[];
}> {
  const fixed = [block.header, ...(block.footer ? [block.footer] : [])];
  let remaining = Math.max(0, budgetBytes) - fixed.reduce((total, line) => total + bytes(line) + 1, 0);
  const forms = new Array<"full" | "compact" | "omitted">(block.entries.length).fill("omitted");
  let mode: "full" | "compact" | "omitted" = "full";
  for (let index = block.entries.length - 1; index >= 0; index -= 1) {
    const entry = block.entries[index]!;
    const omissionReserve = index > 0 ? bytes(omittedEntriesLine(index)) + 1 : 0;
    if (mode === "full" && bytes(entry.full) + 1 + omissionReserve <= remaining) {
      forms[index] = "full";
      remaining -= bytes(entry.full) + 1;
      continue;
    }
    if (mode !== "omitted" && bytes(entry.compact) + 1 + omissionReserve <= remaining) {
      mode = "compact";
      forms[index] = "compact";
      remaining -= bytes(entry.compact) + 1;
      continue;
    }
    mode = "omitted";
  }
  const omitted = forms.filter(form => form === "omitted").length;
  let omission = omitted > 0 ? omittedEntriesLine(omitted) : null;
  if (omission && options.nameOmittedRefs) {
    // What still fits names the omitted calls, newest first, for the reader.
    const refs = block.entries.flatMap((entry, index) => forms[index] === "omitted" ? [entry.ref] : []).reverse();
    omission = withRefs(omission, refs, Math.max(bytes(omission), remaining - 1));
  }
  const lines = [block.header, ...(omission ? [omission] : []),
    ...block.entries.flatMap((entry, index) => forms[index] === "full" ? [entry.full]
      : forms[index] === "compact" ? [entry.compact] : []),
    ...(block.footer ? [block.footer] : [])];
  return { lines, detailRefs: block.entries.flatMap((entry, index) => forms[index] === "full" && entry.details ? [entry.ref] : []) };
}

/** `line` naming as many of `refs` as fit within `budgetBytes`. */
function withRefs(line: string, refs: readonly string[], budgetBytes: number): string {
  const prefix = " read_tool_call reads them by call_ref:";
  let text = line;
  let named = 0;
  for (const ref of refs) {
    const next = `${named === 0 ? text + prefix : text + ","} ${ref}`;
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
