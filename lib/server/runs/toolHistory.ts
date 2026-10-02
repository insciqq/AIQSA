import type { ToolHistoryBlock, ToolHistoryProjection } from "../../contracts/toolHistory";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  isCurrentTurnToolHistory,
  isToolHistoryMessage,
  TOOL_HISTORY_CLASS,
  TOOL_HISTORY_LIMITS,
  toolHistoryMessageId
} from "./toolHistoryContract";

export type { ToolHistoryBlock, ToolHistoryEntry, ToolHistoryMessageData, ToolHistoryProjection } from "../../contracts/toolHistory";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export function omittedEntriesLine(count: number, notExecuted = false): string {
  if (notExecuted) {
    return `- ${count} call${count === 1 ? "" : "s"} of this turn that ${count === 1 ? "was" : "were"} not executed ${count === 1 ? "is" : "are"} not listed here (record size limit).`;
  }
  return `- ${count} earlier call${count === 1 ? "" : "s"} of this turn ${count === 1 ? "is" : "are"} not listed here (record size limit); this does not mean ${count === 1 ? "it" : "they"} did not happen.`;
}

const NAMED_PREFIX = " read_tool_call reads them by call_ref:";
const NAMED_PREFIX_BYTES = bytes(NAMED_PREFIX);

/** The UTF-8 sizes of one record's parts, measured once per record: a
 * record is rendered at several budgets while one prompt is fitted. */
type RecordSizes = Readonly<{
  of: Pick<ToolHistoryBlock, "entries" | "footer" | "header">;
  header: number;
  footer: number;
  compact: readonly number[];
  full: readonly number[];
  ref: readonly number[];
}>;
const recordSizes = new WeakMap<ToolHistoryBlock, RecordSizes>();

function sizesOf(block: ToolHistoryBlock): RecordSizes {
  const cached = recordSizes.get(block);
  if (cached && cached.of.entries === block.entries && cached.of.header === block.header && cached.of.footer === block.footer) {
    return cached;
  }
  const sizes: RecordSizes = { of: { entries: block.entries, footer: block.footer, header: block.header },
    header: bytes(block.header), footer: block.footer ? bytes(block.footer) : 0,
    compact: block.entries.map(entry => bytes(entry.compact)), full: block.entries.map(entry => bytes(entry.full)),
    ref: block.entries.map(entry => bytes(entry.ref)) };
  recordSizes.set(block, sizes);
  return sizes;
}

/**
 * The lines of one record within `budgetBytes`, chronological. As many of
 * the newest entries as fit stay listed by their compact line, the newest of
 * them upgraded to their full line while room remains; older entries are
 * counted on one omission line that (with `nameOmittedRefs`) names as many of
 * their call_refs, newest first, as still fit. The header and the footer are
 * always kept. With `keepEssential` only calls that were not executed may
 * leave the listing: every executed call, and every call of unknown outcome,
 * keeps at least its compact line (call_ref and outcome), whatever the room.
 */
export function renderToolHistoryBlock(block: ToolHistoryBlock, budgetBytes: number = TOOL_HISTORY_LIMITS.blockBytes,
  options: Readonly<{ keepEssential?: boolean; nameOmittedRefs?: boolean }> = {}): Readonly<{
  lines: readonly string[];
  detailRefs: readonly string[];
}> {
  const { entries } = block;
  const size = sizesOf(block);
  const fixed = size.header + 1 + (block.footer ? size.footer + 1 : 0);
  // Naming omitted calls for the reader may take up to a quarter of the room.
  const namingReserve = options.nameOmittedRefs ? Math.floor(Math.max(0, budgetBytes) / 4) : 0;
  // The entries that may leave the listing, oldest first.
  const omittable: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (!options.keepEssential || entries[index]!.essential === false) omittable.push(index);
  }
  const refBytes: number[] = [0];
  for (const index of omittable) refBytes.push(refBytes.at(-1)! + size.ref[index]! + 2);
  const lineOf = (count: number) => omittedEntriesLine(count, options.keepEssential === true);
  const omissionBytes = (count: number) => count > 0
    ? bytes(lineOf(count)) + 1 + Math.min(namingReserve, namingReserve ? NAMED_PREFIX_BYTES + refBytes[count]! : 0) : 0;
  // Compact bytes of the listed entries; the oldest omittable ones leave first.
  let listedBytes = 0;
  for (const compact of size.compact) listedBytes += compact + 1;
  let omitted = 0;
  while (omitted < omittable.length && fixed + listedBytes + omissionBytes(omitted) > budgetBytes) {
    listedBytes -= size.compact[omittable[omitted]!]! + 1;
    omitted += 1;
  }
  const left = new Set(omittable.slice(0, omitted));
  let remaining = budgetBytes - fixed - listedBytes - (omitted > 0 ? bytes(lineOf(omitted)) + 1 : 0);
  let omission = omitted > 0 ? lineOf(omitted) : null;
  if (omission && options.nameOmittedRefs) {
    const base = bytes(omission);
    const named = withRefs(omission, base, omittable.slice(0, omitted).reverse(), entries, size,
      base + Math.min(Math.max(0, remaining), namingReserve));
    omission = named.text;
    remaining -= named.bytes - base;
  }
  const full = new Set<number>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (left.has(index)) continue;
    const extra = size.full[index]! - size.compact[index]!;
    if (extra <= remaining) {
      full.add(index);
      remaining -= extra;
    }
  }
  const lines = [block.header, ...(omission ? [omission] : []),
    ...entries.flatMap((entry, index) => left.has(index) ? [] : [full.has(index) ? entry.full : entry.compact]),
    ...(block.footer ? [block.footer] : [])];
  return { lines, detailRefs: entries.flatMap((entry, index) => full.has(index) && entry.details ? [entry.ref] : []) };
}

/** `line` naming as many of the entries at `indexes` by call_ref as fit
 * within `budgetBytes`, its size counted as it grows. */
function withRefs(line: string, lineBytes: number, indexes: readonly number[], entries: ToolHistoryBlock["entries"],
  size: RecordSizes, budgetBytes: number): Readonly<{ text: string; bytes: number }> {
  const parts = [line];
  let total = lineBytes;
  for (const index of indexes) {
    const first = parts.length === 1;
    const added = (first ? NAMED_PREFIX_BYTES : 1) + 1 + size.ref[index]!;
    if (total + added > budgetBytes) break;
    parts.push(`${first ? NAMED_PREFIX : ","} ${entries[index]!.ref}`);
    total += added;
  }
  return { text: parts.join(""), bytes: total };
}

/** One prompt's renders of its records, each record at each budget once. */
export type ToolHistoryRenders = WeakMap<ToolHistoryBlock, Map<number, Readonly<{ text: string; bytes: number }>>>;

/**
 * Records rendered within `budgetBytes` in total (an Agent prompt's room),
 * never below their floor: the header, the footer and the compact line
 * (call_ref and outcome) of every executed call and every call of unknown
 * outcome, the calls that were not executed counted. The room beyond the
 * floors goes to the newest records first, each up to its normal bound
 * (details, then the counted calls named for the reader). Floors beyond the
 * room are still returned whole: the caller refuses such a prompt rather
 * than hide a call that may have changed something. Texts in record order;
 * `renders` keeps each record's renders for the next fit of the same prompt.
 */
export function boundedToolHistoryTexts(blocks: readonly ToolHistoryBlock[], budgetBytes: number,
  renders: ToolHistoryRenders = new WeakMap()): string[] {
  const render = (block: ToolHistoryBlock, room: number) => {
    let byRoom = renders.get(block);
    if (!byRoom) renders.set(block, byRoom = new Map());
    let rendered = byRoom.get(room);
    if (!rendered) {
      const text = renderToolHistoryBlock(block, room, { keepEssential: true, nameOmittedRefs: true }).lines.join("\n");
      byRoom.set(room, rendered = { text, bytes: bytes(text) });
    }
    return rendered;
  };
  const rendered = blocks.map(block => render(block, 0));
  let room = budgetBytes - rendered.reduce((total, value) => total + value.bytes + 1, 0);
  for (let index = blocks.length - 1; index >= 0 && room > 0; index -= 1) {
    const floor = rendered[index]!.bytes;
    const next = render(blocks[index]!, Math.min(TOOL_HISTORY_LIMITS.blockBytes, floor + room));
    room -= next.bytes - floor;
    rendered[index] = next;
  }
  return rendered.map(value => value.text);
}

/** The provider-only message of one record: role assistant, without `purpose`. */
export function toolHistoryMessage(block: ToolHistoryBlock, budgetBytes?: number,
  options: Readonly<{ keepEssential?: boolean; nameOmittedRefs?: boolean }> = {}): ProviderConversationMessage {
  const id = toolHistoryMessageId(block.turnMessageId);
  const rendered = renderToolHistoryBlock(block, budgetBytes, options);
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
 * its answer; for the current message, before that message and the pins
 * that directly precede it (where the budget keeps pins), whatever was
 * pinned first; for an answer that is not in the context, after the last
 * message of its user turn. */
function anchorIndex(messages: readonly ProviderConversationMessage[], block: ToolHistoryBlock): number | null {
  const current = messages.at(-1);
  if (current && block.turnMessageId === current.id) {
    let index = messages.length - 1;
    while (index > 0 && messages[index - 1]!.purpose !== undefined) index -= 1;
    return index;
  }
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
    before.set(index, [...(before.get(index) ?? []), recordMessage(block, messages.at(-1))]);
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
    return block ? [recordMessage(block, messages.at(-1))] : [];
  }) } };
}

/** A record at its normal bound. The record of earlier attempts of the
 * current message keeps every executed call and every call of unknown
 * outcome listed even beyond that bound (the planner fits or refuses it). */
function recordMessage(block: ToolHistoryBlock, current: ProviderConversationMessage | undefined): ProviderConversationMessage {
  return toolHistoryMessage(block, undefined, { keepEssential: block.turnMessageId === current?.id });
}

export function requestHasToolHistory(request: Pick<ProviderRunRequest, "context">): boolean {
  return request.context?.messages.some(isToolHistoryMessage) === true;
}

/**
 * The request with the record of earlier attempts of its current message
 * rendered smaller, so that `excessTokens` leave the irreducible part of the
 * request: details go first (compact lines), then calls that were not
 * executed (counted, their call_refs named while room remains). Every executed
 * call, and every call of unknown outcome, keeps its compact line with its
 * call_ref and outcome. Null when there is no such record, it cannot shrink,
 * or even that floor does not release `excessTokens` (the request is refused
 * rather than hide an action that may have happened).
 */
export function fitCurrentTurnToolHistory(request: ProviderRunRequest, excessTokens: number,
  estimate: (value: unknown) => number): Readonly<{ request: ProviderRunRequest; releasedTokens: number }> | null {
  const messages = request.context?.messages ?? [];
  const current = messages.at(-1);
  const index = messages.findIndex(message => isCurrentTurnToolHistory(message, current));
  const record = index >= 0 ? messages[index]! : null;
  const block = record?.toolHistory?.block;
  if (!record || !block || excessTokens <= 0) return null;
  const tokens = estimate(record.content);
  const target = tokens - excessTokens;
  const render = (bytes: number) => toolHistoryMessage(block, bytes, { keepEssential: true, nameOmittedRefs: true });
  const floor = render(0);
  if (estimate(floor.content) > target) return null;
  // The largest rendering within the target, by bytes.
  let low = 0;
  let high: number = TOOL_HISTORY_LIMITS.blockBytes;
  let best = floor;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const candidate = render(middle);
    if (estimate(candidate.content) <= target) {
      best = candidate;
      low = middle;
    } else high = middle - 1;
  }
  const released = tokens - estimate(best.content);
  if (released <= 0) return null;
  return { releasedTokens: released, request: { ...request, context: { ...request.context!,
    messages: messages.map((message, position) => position === index ? best : message) } } };
}
