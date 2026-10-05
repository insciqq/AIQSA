import {
  CHAT_IMPORT_EARLIEST_DATE,
  CHAT_IMPORT_SOURCE_KEY_MAX_LENGTH
} from "@/lib/contracts/chatImport";
import type { ChatExportDocumentMessage } from "@/lib/contracts/chatExport";
import type { ConvertedChat, ImportLocalFailureReason } from "./converterTypes";
import { chatGptMessageText, type SkipCounts } from "./chatgptText";

/**
 * One ChatGPT conversation (`mapping` tree of `{id, message, parent}` nodes,
 * legacy exports also listing `children`) as an `aiqsa.chat` v1 document:
 * skipped nodes are bridged to their nearest kept ancestor, an answer split
 * across nodes becomes one message, branches stay and the active leaf is the
 * nearest kept ancestor of `current_node`.
 */
export type ChatGptConversion =
  | Readonly<{ kind: "chat"; chat: ConvertedChat; skipped: SkipCounts }>
  | Readonly<{ kind: "empty"; skipped: SkipCounts }>
  | Readonly<{ kind: "failed"; title: string; reason: ImportLocalFailureReason }>;

export const CHATGPT_UNTITLED = "Untitled";
const DAY_MS = 24 * 60 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The conversation's title as the report and the chat show it. */
export function chatGptTitle(value: unknown): string {
  const title = isRecord(value) && typeof value.title === "string" ? value.title.trim() : "";
  return title || CHATGPT_UNTITLED;
}

function sourceKey(value: JsonRecord): string | null {
  for (const candidate of [value.conversation_id, value.id]) {
    if (typeof candidate !== "string") continue;
    const key = candidate.trim();
    if (key && key.length <= CHAT_IMPORT_SOURCE_KEY_MAX_LENGTH && !/[\u0000-\u001f\u007f]/u.test(key)) return key;
  }
  return null;
}

type TimeRange = Readonly<{ earliest: number; latest: number }>;

/** Epoch seconds as milliseconds, or null when absent or outside the importable range. */
function epochMs(value: unknown, range: TimeRange): number | null {
  const seconds = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(seconds)) return null;
  const ms = Math.round(seconds * 1_000);
  return ms >= range.earliest && ms <= range.latest ? ms : null;
}

type SourceNode = Readonly<{ id: string; record: JsonRecord }>;

type KeptMessage = {
  role: "assistant" | "user";
  text: string;
  createdMs: number;
  children: number[];
  root: boolean;
  /** The kept message this one was merged into. */
  mergedInto?: number;
};

/** Each node's parent: `parent` when it names another node, else the legacy `children` listing. */
function parentsOf(nodes: ReadonlyMap<string, JsonRecord>): Map<string, string | null> {
  const listed = new Map<string, string>();
  for (const [id, node] of nodes) {
    if (!Array.isArray(node.children)) continue;
    for (const child of node.children) {
      if (typeof child === "string" && child !== id && nodes.has(child) && !listed.has(child)) listed.set(child, id);
    }
  }
  const parents = new Map<string, string | null>();
  for (const [id, node] of nodes) {
    const parent = typeof node.parent === "string" && node.parent !== id && nodes.has(node.parent) ? node.parent : null;
    parents.set(id, parent ?? listed.get(id) ?? null);
  }
  return parents;
}

function messageTime(node: JsonRecord, range: TimeRange): number | null {
  return isRecord(node.message) ? epochMs(node.message.create_time, range) : null;
}

/** Children in the legacy `children` order when listed, else by creation time, else as the mapping lists them. */
function childrenOf(
  nodes: ReadonlyMap<string, JsonRecord>,
  parents: ReadonlyMap<string, string | null>,
  range: TimeRange
): Map<string | null, SourceNode[]> {
  const children = new Map<string | null, SourceNode[]>();
  for (const [id, record] of nodes) {
    const parent = parents.get(id) ?? null;
    const siblings = children.get(parent) ?? [];
    siblings.push({ id, record });
    children.set(parent, siblings);
  }
  for (const [parent, siblings] of children) {
    const order = parent === null ? undefined : nodes.get(parent)?.children;
    if (Array.isArray(order)) {
      const position = new Map(order.map((child, index) => [child, index] as const));
      siblings.sort((left, right) => (position.get(left.id) ?? order.length) - (position.get(right.id) ?? order.length));
    } else {
      siblings.sort((left, right) =>
        (messageTime(left.record, range) ?? Number.POSITIVE_INFINITY) - (messageTime(right.record, range) ?? Number.POSITIVE_INFINITY));
    }
  }
  return children;
}

function addCounts(target: SkipCounts, source: SkipCounts): void {
  for (const [kind, amount] of Object.entries(source) as Array<[keyof SkipCounts, number]>) {
    target[kind] = (target[kind] ?? 0) + amount;
  }
}

/** Converts one parsed conversation of a ChatGPT export. */
export function convertChatGptConversation(value: unknown, now: Date): ChatGptConversion {
  const title = chatGptTitle(value);
  if (!isRecord(value) || !isRecord(value.mapping)) return { kind: "failed", reason: "chat_export_shape_invalid", title };
  const key = sourceKey(value);
  if (!key) return { kind: "failed", reason: "chat_export_shape_invalid", title };
  const range: TimeRange = { earliest: Date.parse(CHAT_IMPORT_EARLIEST_DATE), latest: now.getTime() + DAY_MS };

  const nodes = new Map<string, JsonRecord>();
  for (const [id, node] of Object.entries(value.mapping)) {
    if (isRecord(node)) nodes.set(id, node);
  }
  const parents = parentsOf(nodes);
  const children = childrenOf(nodes, parents, range);
  const conversationCreated = epochMs(value.create_time, range);
  const conversationUpdated = epochMs(value.update_time, range);
  const conversationDate = conversationCreated ?? conversationUpdated ?? now.getTime();

  // Depth-first from the roots, bridging skipped nodes to their nearest kept ancestor.
  const skipped: SkipCounts = {};
  const kept: KeptMessage[] = [];
  const nearestKept = new Map<string, number | null>();
  const visited = new Set<string>();
  const stack: Array<Readonly<{ node: SourceNode; ancestor: number | null }>> = (children.get(null) ?? [])
    .map((node) => ({ ancestor: null, node }))
    .reverse();
  while (stack.length) {
    const { node, ancestor } = stack.pop()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    const counts: SkipCounts = {};
    const converted = chatGptMessageText(node.record.message, counts);
    addCounts(skipped, counts);
    let nearest = ancestor;
    if (converted) {
      const parentMs = ancestor === null ? Number.NEGATIVE_INFINITY : kept[ancestor]!.createdMs;
      const createdMs = Math.max(messageTime(node.record, range) ?? conversationDate, parentMs);
      nearest = kept.length;
      kept.push({ children: [], createdMs, role: converted.role, root: ancestor === null, text: converted.text });
      if (ancestor !== null) kept[ancestor]!.children.push(nearest);
    }
    nearestKept.set(node.id, nearest);
    const next = children.get(node.id) ?? [];
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push({ ancestor: nearest, node: next[index]! });
  }
  if (kept.length === 0) return { kind: "empty", skipped };

  // An answer (or prompt) split across a single-child chain becomes one message.
  for (const [self, message] of kept.entries()) {
    if (message.mergedInto !== undefined) continue;
    while (message.children.length === 1 && kept[message.children[0]!]!.role === message.role) {
      const child = kept[message.children[0]!]!;
      message.text = `${message.text.trimEnd()}\n\n${child.text}`;
      message.children = child.children;
      child.mergedInto = self;
    }
  }
  const resolve = (index: number): number => {
    let cursor = index;
    while (kept[cursor]!.mergedInto !== undefined) cursor = kept[cursor]!.mergedInto!;
    return cursor;
  };

  // Parent-before-child order with local ids.
  const ids = new Map<number, string>();
  const messages: ChatExportDocumentMessage[] = [];
  const order: Array<Readonly<{ index: number; parentId: string | null }>> = kept
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => message.root)
    .map(({ index }) => ({ index, parentId: null }))
    .reverse();
  while (order.length) {
    const { index, parentId } = order.pop()!;
    const message = kept[index]!;
    const id = `m${messages.length + 1}`;
    ids.set(index, id);
    messages.push({
      createdAt: new Date(message.createdMs).toISOString(),
      id,
      parentId,
      role: message.role,
      status: "complete",
      text: message.text
    });
    for (let child = message.children.length - 1; child >= 0; child -= 1) {
      order.push({ index: message.children[child]!, parentId: id });
    }
  }

  const current = typeof value.current_node === "string" ? nearestKept.get(value.current_node) : undefined;
  let activeLeafId = current === undefined || current === null ? undefined : ids.get(resolve(current));
  if (!activeLeafId) {
    // No usable current node: the latest message without children.
    let latest: ChatExportDocumentMessage | undefined;
    const parentsWithChildren = new Set(messages.map((message) => message.parentId));
    for (const message of messages) {
      if (!parentsWithChildren.has(message.id) && (!latest || message.createdAt >= latest.createdAt)) latest = message;
    }
    activeLeafId = latest!.id;
  }

  const latestMessageMs = Math.max(...kept.map((message) => message.createdMs));
  const createdMs = conversationCreated ?? Math.min(...kept.map((message) => message.createdMs));
  const updatedMs = Math.max(conversationUpdated ?? Number.NEGATIVE_INFINITY, latestMessageMs, createdMs);
  const model = typeof value.default_model_slug === "string" && value.default_model_slug.trim()
    ? value.default_model_slug
    : undefined;
  return {
    chat: {
      document: {
        chat: {
          activeLeafId,
          archived: value.is_archived === true,
          createdAt: new Date(createdMs).toISOString(),
          messages,
          pinned: value.is_starred === true || (value.pinned_time !== null && value.pinned_time !== undefined && value.pinned_time !== false),
          title,
          updatedAt: new Date(updatedMs).toISOString()
        },
        exportedAt: now.toISOString(),
        format: "aiqsa.chat",
        version: 1
      },
      source: "CHATGPT",
      sourceKey: key,
      ...(model ? { sourceModel: model } : {})
    },
    kind: "chat",
    skipped
  };
}
