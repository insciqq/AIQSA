import type { ChatExportDocument, ChatExportDocumentMessage } from "@/lib/contracts/chatExport";
import { ImportArchiveError, type ImportArchiveEntryInfo } from "../archive/archiveTypes";
import type { ImportFile } from "../importFile";
import {
  appendNotes,
  markdownLiteral,
  notImportedNote,
  type ChatImportConverter,
  type ConverterDetection,
  type ImportConverterEvent,
  type ImportSkipKind
} from "./converterTypes";

/**
 * `conversations.json` is read whole and parsed at once; a larger file would
 * not fit a browser worker's string and heap limits.
 */
export const CLAUDE_CONVERSATIONS_MAX_BYTES = 256 * 1_024 * 1_024;
/** Enough of `conversations.json` to reach the first conversation's message list. */
const DETECTION_PREFIX_BYTES = 1_024 * 1_024;
/** The multi-part export's `claude.json` index is a few kilobytes. */
const EXPORT_INDEX_MAX_BYTES = 1_024 * 1_024;
const CONVERSATIONS_FILE = "conversations.json";
/** Claude's parent of a first message. */
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";
const SOURCE_KEY_MAX_LENGTH = 256;
const CITATION_URL_MAX_LENGTH = 4_096;

export const CLAUDE_EXPORT_INDEX_MESSAGE =
  "This is the export index; download the conversations part from the links in the export email (they expire after 24 hours)";
export const CLAUDE_OTHER_PART_MESSAGE =
  "This part of the Claude export holds no chats; they are in the conversations part";
const TOO_LARGE_MESSAGE = `The conversations file is larger than the ${CLAUDE_CONVERSATIONS_MAX_BYTES / (1_024 * 1_024)} MB import limit`;

const ARRAY_HEAD = /^﻿?\s*\[/u;
const EMPTY_ARRAY = /^﻿?\s*\[\s*\]\s*$/u;
const OBJECT_HEAD = /^﻿?\s*\{/u;
/** The conversation key as a JSON key, not inside an escaped string. */
const CONVERSATION_KEY = /(?<!\\)"chat_messages"\s*:/u;
/** The other parts of a Claude export: account data, projects and artifact versions. */
const OTHER_PART_PATH = /(?:^|\/)(?:users\.json|login_history\.json|projects\.json|projects\/[^/]+\.json|artifacts\/.+)$/u;
/** Their sources reach the answer as citations, so these tool calls add nothing. */
const CITED_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);
const ARTIFACT_TOOL = "Artifact";
const IMAGE_NAME = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/iu;
const MISSING_PARENT_NOTE = "_[Earlier message not included in the Claude export]_";
const EMPTY_MESSAGE_NOTE = "_[Empty message]_";
const utf8 = new TextDecoder("utf-8");

type JsonRecord = Record<string, unknown>;
type SkipCounts = Partial<Record<ImportSkipKind, number>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isConversationsHead(head: string): boolean {
  return ARRAY_HEAD.test(head) && CONVERSATION_KEY.test(head);
}

/** The multi-part export's `claude.json`: download links of the parts, no chats. */
function isExportIndex(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.data_files) || !value.data_files.every(isRecord)) return false;
  return typeof value.total_files === "number" ||
    value.data_files.some((item) => isRecord(item) && ("export_url" in item || "category" in item));
}

type ZipLayout = Readonly<{ conversations: ReadonlySet<string>; otherPart: boolean }>;

/**
 * What a zip holds, from its directory and the first megabyte of each
 * `conversations.json`: the Claude conversation files, or another part of
 * a Claude export. Nothing else is read.
 */
async function zipLayout(file: ImportFile): Promise<ZipLayout> {
  const archive = await file.archive();
  const paths: string[] = [];
  // Selecting nothing lists every entry without reading one.
  await archive.entries((info) => {
    paths.push(info.path);
    return null;
  })[Symbol.asyncIterator]().next();
  const candidates = new Set(paths.filter((path) => basename(path) === CONVERSATIONS_FILE));
  const conversations = new Set<string>();
  const empty = new Set<string>();
  if (candidates.size) {
    const select = (info: ImportArchiveEntryInfo) =>
      candidates.has(info.path) ? { maxBytes: DETECTION_PREFIX_BYTES, prefix: true } : null;
    for await (const entry of archive.entries(select)) {
      if (entry.kind !== "data") continue;
      const head = utf8.decode(entry.bytes);
      if (isConversationsHead(head)) conversations.add(entry.path);
      else if (EMPTY_ARRAY.test(head)) empty.add(entry.path);
    }
  }
  const others = paths.filter((path) => !conversations.has(path) && !empty.has(path));
  const claudeOthers = others.every((path) => OTHER_PART_PATH.test(path));
  // An account without chats exports `[]`; its other files still tell a Claude export.
  if (conversations.size === 0 && empty.size > 0 && claudeOthers && others.length > 0) {
    return { conversations: empty, otherPart: false };
  }
  return { conversations, otherPart: conversations.size === 0 && paths.length > 0 && claudeOthers };
}

/** An `http(s)` link destination that cannot end a Markdown link early. */
function citationLink(value: unknown): Readonly<{ href: string; label: string }> | null {
  if (typeof value !== "string" || value.length > CITATION_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const href = url.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
  return { href, label: markdownLiteral(url.hostname.replace(/^www\./u, "")) || href };
}

/**
 * The block's text with each new source linked after the span that cites
 * it. Indices count code points; links go in from the end so earlier
 * indices stay valid. A source already linked in this message is not
 * repeated.
 */
function citedText(block: JsonRecord, seen: Set<string>): string {
  const text = typeof block.text === "string" ? block.text : "";
  if (!Array.isArray(block.citations) || block.citations.length === 0) return text;
  const characters = Array.from(text);
  const cited = block.citations.flatMap((citation, order) => {
    if (!isRecord(citation)) return [];
    const link = citationLink(isRecord(citation.details) ? citation.details.url : undefined);
    if (!link) return [];
    const end = Number.isSafeInteger(citation.end_index) && Number(citation.end_index) >= 0
      ? Math.min(Number(citation.end_index), characters.length)
      : characters.length;
    return [{ end, link, order }];
  }).sort((left, right) => left.end - right.end || left.order - right.order);
  const inserts = new Map<number, string>();
  for (const { end, link } of cited) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    inserts.set(end, `${inserts.get(end) ?? ""} [${link.label}](${link.href})`);
  }
  for (const end of [...inserts.keys()].sort((left, right) => right - left)) {
    characters.splice(end, 0, inserts.get(end)!);
  }
  return characters.join("");
}

function nameOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Artifact titles by artifact id across the conversation: updates often omit the title. */
function artifactTitles(messages: readonly JsonRecord[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use" || block.name !== ARTIFACT_TOOL || !isRecord(block.input)) continue;
      const { id, title } = block.input;
      if (typeof id === "string" && typeof title === "string" && title.trim() && !titles.has(id)) titles.set(id, title.trim());
    }
  }
  return titles;
}

function add(counts: SkipCounts, kind: ImportSkipKind, count = 1): void {
  if (count > 0) counts[kind] = (counts[kind] ?? 0) + count;
}

/**
 * A message's readable text: its text blocks (the legacy `text` only when
 * there are none), source links, and a note for each kind of content the
 * Claude export does not carry or AIQSA does not import.
 */
function messageText(message: JsonRecord, titles: ReadonlyMap<string, string>, counts: SkipCounts): string {
  const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const seen = new Set<string>();
  const tools = new Map<string, number>();
  const artifacts = new Map<string, string>();
  let text = "";
  let hasTextBlock = false;
  let separated = false;
  for (const block of blocks) {
    if (block.type === "text") {
      hasTextBlock = true;
      const part = citedText(block, seen);
      if (part) {
        // Text split by tool calls or thinking reads as separate paragraphs.
        text += text && separated ? `\n\n${part}` : part;
        separated = false;
      }
      continue;
    }
    separated = true;
    if (block.type !== "tool_use") continue;
    const name = nameOf(block.name, "unknown tool");
    if (CITED_TOOLS.has(name)) continue;
    if (name === ARTIFACT_TOOL) {
      const input = isRecord(block.input) ? block.input : {};
      const id = typeof input.id === "string" ? input.id : "";
      const title = nameOf(input.title, (id && titles.get(id)) || "Untitled");
      artifacts.set(id || `title:${title}`, title);
      continue;
    }
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  if (!hasTextBlock && typeof message.text === "string") text = message.text;

  const files = new Map<string, boolean>();
  for (const list of [message.files, message.attachments]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const name = nameOf(item.file_name, "unnamed file");
      const type = typeof item.file_type === "string" ? item.file_type : "";
      if (!files.has(name)) files.set(name, IMAGE_NAME.test(name) || type.startsWith("image/"));
    }
  }

  const notes: string[] = [];
  if (files.size) {
    const names = [...files.keys()];
    notes.push(`_[${names.length === 1 ? "File" : "Files"} not included in the Claude export: ${names.map(markdownLiteral).join(", ")}]_`);
    const images = [...files.values()].filter(Boolean).length;
    add(counts, "image", images);
    add(counts, "attachment", files.size - images);
  }
  if (tools.size) {
    notes.push(notImportedNote("Tool activity", [...tools].map(([name, count]) => count > 1 ? `${name} ×${count}` : name)));
    add(counts, "tool", [...tools.values()].reduce((total, count) => total + count, 0));
  }
  if (artifacts.size) {
    notes.push(notImportedNote(artifacts.size === 1 ? "Artifact" : "Artifacts", [...new Set(artifacts.values())]));
    add(counts, "artifact", artifacts.size);
  }
  return appendNotes(text, notes);
}

type SourceMessage = Readonly<{
  index: number;
  uuid: string;
  /** null for a root: the sentinel parent, or none. */
  parentUuid: string | null;
  hasParentField: boolean;
  role: "assistant" | "user";
  time: number | null;
  record: JsonRecord;
}>;

type ConversationOutcome =
  | Readonly<{ ok: true; document: ChatExportDocument; counts: SkipCounts; sourceKey: string }>
  | Readonly<{ ok: false; reason: "chat_export_shape_invalid" | "chat_export_message_id_duplicate" | "chat_export_tree_cycle" | "chat_export_date_invalid" }>
  | Readonly<{ ok: false; empty: true }>;

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function sourceMessage(value: unknown, index: number): SourceMessage | null {
  if (!isRecord(value) || typeof value.uuid !== "string" || !value.uuid) return null;
  const role = value.sender === "human" ? "user" : value.sender === "assistant" ? "assistant" : null;
  if (!role) return null;
  const parent = value.parent_message_uuid;
  if (parent !== undefined && parent !== null && typeof parent !== "string") return null;
  return {
    hasParentField: parent !== undefined,
    index,
    parentUuid: typeof parent === "string" && parent && parent !== ROOT_PARENT ? parent : null,
    record: value,
    role,
    time: instant(value.created_at),
    uuid: value.uuid
  };
}

/** Whether `candidate` is an ancestor of `of`; a chain longer than the conversation is a cycle and counts as one. */
function isAncestor(candidate: number, of: number, parents: readonly (number | null)[]): boolean {
  let cursor: number | null = parents[of] ?? null;
  for (let steps = 0; cursor !== null; steps += 1) {
    if (cursor === candidate || steps >= parents.length) return true;
    cursor = parents[cursor] ?? null;
  }
  return false;
}

/**
 * One Claude conversation as an `aiqsa.chat` document: the message forest
 * from `parent_message_uuid` with every branch, the newest leaf active, and
 * dates that never put a child before its parent.
 */
function convertConversation(value: unknown): ConversationOutcome {
  if (!isRecord(value) || typeof value.uuid !== "string" || !value.uuid.trim() ||
    value.uuid.length > SOURCE_KEY_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value.uuid) ||
    !Array.isArray(value.chat_messages)) {
    return { ok: false, reason: "chat_export_shape_invalid" };
  }
  if (value.chat_messages.length === 0) return { empty: true, ok: false };
  const sources: SourceMessage[] = [];
  const byUuid = new Map<string, number>();
  for (const [index, item] of value.chat_messages.entries()) {
    const message = sourceMessage(item, index);
    if (!message) return { ok: false, reason: "chat_export_shape_invalid" };
    if (byUuid.has(message.uuid)) return { ok: false, reason: "chat_export_message_id_duplicate" };
    byUuid.set(message.uuid, index);
    sources.push(message);
  }

  // Reduced rather than spread: a long conversation exceeds the argument limit.
  const earliest = sources.reduce<number | null>((min, message) =>
    message.time === null || min !== null && min <= message.time ? min : message.time, null);
  const chatCreated = instant(value.created_at) ?? earliest;
  if (chatCreated === null) return { ok: false, reason: "chat_export_date_invalid" };
  // A message without a date sorts after the last dated one before it.
  let lastTime = chatCreated;
  const sortTimes = sources.map((message) => (lastTime = message.time ?? lastTime));
  const byTime = sources.map((message) => message.index)
    .sort((left, right) => sortTimes[left]! - sortTimes[right]! || left - right);

  const parents: Array<number | null> = sources.map(() => null);
  const repaired = new Set<number>();
  if (!sources.some((message) => message.hasParentField)) {
    // Exports from before branching carry no parents: one dialogue in time order.
    for (let position = 1; position < byTime.length; position += 1) parents[byTime[position]!] = byTime[position - 1]!;
  } else {
    for (const message of sources) {
      if (message.parentUuid === null) continue;
      const parent = byUuid.get(message.parentUuid);
      if (parent === message.index) return { ok: false, reason: "chat_export_tree_cycle" };
      if (parent !== undefined) parents[message.index] = parent;
      else repaired.add(message.index);
    }
    // A parent missing from the export: the previous message in time takes its place.
    for (const [position, index] of byTime.entries()) {
      if (!repaired.has(index)) continue;
      for (let back = position - 1; back >= 0; back -= 1) {
        const candidate = byTime[back]!;
        if (!isAncestor(index, candidate, parents)) {
          parents[index] = candidate;
          break;
        }
      }
    }
  }

  const children = sources.map((): number[] => []);
  const roots: number[] = [];
  for (const index of byTime) {
    const parent = parents[index];
    if (parent === null || parent === undefined) roots.push(index);
    else children[parent]!.push(index);
  }
  const order: number[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const index = stack.pop()!;
    order.push(index);
    for (let child = children[index]!.length - 1; child >= 0; child -= 1) stack.push(children[index]![child]!);
  }
  // Messages unreachable from any root form a parent cycle.
  if (order.length !== sources.length) return { ok: false, reason: "chat_export_tree_cycle" };

  const titles = artifactTitles(sources.map((message) => message.record));
  const counts: SkipCounts = {};
  const ids = new Map<number, string>();
  const times = new Map<number, number>();
  const messages: ChatExportDocumentMessage[] = [];
  for (const index of order) {
    const source = sources[index]!;
    const parent = parents[index] ?? null;
    const parentTime = parent === null ? null : times.get(parent)!;
    const time = Math.max(source.time ?? parentTime ?? chatCreated, parentTime ?? Number.NEGATIVE_INFINITY);
    const id = `m${messages.length + 1}`;
    ids.set(index, id);
    times.set(index, time);
    let text = messageText(source.record, titles, counts);
    if (repaired.has(index)) {
      text = appendNotes(text, [MISSING_PARENT_NOTE]);
      add(counts, "missing_message");
    }
    messages.push({
      createdAt: new Date(time).toISOString(),
      id,
      parentId: parent === null ? null : ids.get(parent)!,
      role: source.role,
      status: "complete",
      text: text.trim() ? text : EMPTY_MESSAGE_NOTE
    });
  }

  // Claude records no active branch: the newest leaf is the one shown, the later one on a tie.
  let activeLeaf = order[0]!;
  for (const index of byTime) {
    if (children[index]!.length === 0 && (children[activeLeaf]!.length > 0 || times.get(index)! >= times.get(activeLeaf)!)) {
      activeLeaf = index;
    }
  }

  const latest = [...times.values()].reduce((max, time) => Math.max(max, time), chatCreated);
  const updated = Math.max(instant(value.updated_at) ?? latest, latest, chatCreated);
  const createdAt = new Date(chatCreated).toISOString();
  const updatedAt = new Date(updated).toISOString();
  return {
    counts,
    document: {
      chat: {
        activeLeafId: ids.get(activeLeaf)!,
        archived: false,
        createdAt,
        messages,
        pinned: false,
        title: typeof value.name === "string" && value.name.trim() ? value.name : "Untitled",
        updatedAt
      },
      // Claude's conversations file records no export time.
      exportedAt: updatedAt,
      format: "aiqsa.chat",
      version: 1
    },
    ok: true,
    sourceKey: value.uuid
  };
}

function conversationTitle(value: unknown): string {
  const name = isRecord(value) ? value.name : undefined;
  return typeof name === "string" && name.trim() ? name : "Untitled";
}

function* conversationsEvents(text: string, fileName: string): Generator<ImportConverterEvent> {
  const value = parseJson(text);
  if (!Array.isArray(value)) {
    yield { file: true, reason: "file_unreadable", title: fileName, type: "failed" };
    return;
  }
  yield { chats: value.length, type: "total" };
  for (const conversation of value) {
    const outcome = convertConversation(conversation);
    if (!outcome.ok) {
      if ("empty" in outcome) yield { count: 1, kind: "empty_chat", type: "skipped" };
      else yield { reason: outcome.reason, title: conversationTitle(conversation), type: "failed" };
      continue;
    }
    for (const [kind, count] of Object.entries(outcome.counts) as Array<[ImportSkipKind, number]>) {
      yield { count, kind, type: "skipped" };
    }
    yield {
      chat: { document: outcome.document, source: "CLAUDE", sourceKey: outcome.sourceKey, sourceModel: "Claude" },
      type: "chat"
    };
  }
}

async function* zipEvents(file: ImportFile, paths: ReadonlySet<string>): AsyncGenerator<ImportConverterEvent> {
  const archive = await file.archive();
  const select = (info: ImportArchiveEntryInfo) => paths.has(info.path) ? { maxBytes: CLAUDE_CONVERSATIONS_MAX_BYTES } : null;
  for await (const entry of archive.entries(select)) {
    if (entry.kind === "too_large") {
      yield { file: true, message: TOO_LARGE_MESSAGE, reason: "too_large", title: file.name, type: "failed" };
      continue;
    }
    yield* conversationsEvents(utf8.decode(entry.bytes), file.name);
  }
}

/**
 * Claude data exports: the conversations part of the multi-part export, the
 * older single zip, or a bare `conversations.json`. Only `conversations.json`
 * is read; account data, projects and artifact versions never are. The
 * multi-part export's `claude.json` index is refused with what to pick
 * instead, unless the conversations part is picked with it.
 */
export function createClaudeConverter(): ChatImportConverter {
  const conversationEntries = new WeakMap<ImportFile, ReadonlySet<string>>();
  const indexes = new WeakSet<ImportFile>();
  return {
    async detect(files): Promise<ConverterDetection> {
      const claimed: ImportFile[] = [];
      const refused: Array<NonNullable<ConverterDetection["refused"]>[number]> = [];
      const exportIndexes: ImportFile[] = [];
      for (const file of files) {
        if (file.kind === "json") {
          const head = await file.head(DETECTION_PREFIX_BYTES);
          if (isConversationsHead(head)) claimed.push(file);
          else if (OBJECT_HEAD.test(head) && file.size <= EXPORT_INDEX_MAX_BYTES &&
            isExportIndex(parseJson(await file.text(EXPORT_INDEX_MAX_BYTES).catch(() => "")))) {
            exportIndexes.push(file);
          }
          continue;
        }
        if (file.kind !== "zip") continue;
        try {
          const layout = await zipLayout(file);
          if (layout.conversations.size) {
            conversationEntries.set(file, layout.conversations);
            claimed.push(file);
          } else if (layout.otherPart) {
            refused.push({ file, message: CLAUDE_OTHER_PART_MESSAGE, reason: "unsupported_file" });
          }
        } catch (error) {
          // A damaged or hostile archive is unreadable for every converter.
          if (!(error instanceof ImportArchiveError)) throw error;
          refused.push({ file, reason: error.code });
        }
      }
      // The index holds only download links; with the conversations part beside it there is nothing to say.
      const withConversations = claimed.length > 0;
      for (const file of exportIndexes) {
        if (withConversations) {
          indexes.add(file);
          claimed.push(file);
        } else {
          refused.push({ file, message: CLAUDE_EXPORT_INDEX_MESSAGE, reason: "unsupported_file" });
        }
      }
      return { claimed, refused };
    },
    async *convert(files) {
      for (const file of files) {
        if (indexes.has(file)) continue;
        const entries = conversationEntries.get(file);
        if (entries) {
          try {
            yield* zipEvents(file, entries);
          } catch (error) {
            if (!(error instanceof ImportArchiveError)) throw error;
            yield { file: true, reason: error.code, title: file.name, type: "failed" };
          }
          continue;
        }
        if (file.size > CLAUDE_CONVERSATIONS_MAX_BYTES) {
          yield { file: true, message: TOO_LARGE_MESSAGE, reason: "too_large", title: file.name, type: "failed" };
          continue;
        }
        let text: string;
        try {
          text = await file.text(CLAUDE_CONVERSATIONS_MAX_BYTES);
        } catch {
          yield { file: true, reason: "file_unreadable", title: file.name, type: "failed" };
          continue;
        }
        yield* conversationsEvents(text, file.name);
      }
    },
    source: "CLAUDE"
  };
}
