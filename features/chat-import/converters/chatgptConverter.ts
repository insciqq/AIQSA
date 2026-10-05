import { ImportArchiveError, type ImportArchive } from "../archive/archiveTypes";
import type { ImportFile } from "../importFile";
import { chatGptTitle, convertChatGptConversation } from "./chatgptConversation";
import type {
  ChatImportConverter,
  ConverterDetection,
  ImportConverterEvent,
  ImportSkipKind
} from "./converterTypes";

/**
 * ChatGPT data exports: the `.zip` (conversations sharded into
 * `conversations-NNN.json` listed by `export_manifest.json`, or one legacy
 * `conversations.json`), or those conversation JSON files picked directly.
 * Only the manifest and the conversation files are ever read; `chat.html`,
 * account files and `.dat` attachments stay compressed. Each file is held as
 * bytes and parsed one conversation at a time.
 */
const MANIFEST_NAME = "export_manifest.json";
const CONVERSATIONS_FILE = /^conversations(?:-\d{1,6})?\.json$/u;
const MANIFEST_MAX_BYTES = 4 * 1_024 * 1_024;
/** Enough of a conversations file to see its first conversation's keys. */
const DETECT_PREFIX_BYTES = 256 * 1_024;
/** A conversations file inside the zip, held as bytes and split without parsing it whole. */
export const CHATGPT_ARCHIVE_FILE_MAX_BYTES = 512 * 1_024 * 1_024;
/** A conversations file picked directly is read as text first, so its bound is lower. */
export const CHATGPT_JSON_FILE_MAX_BYTES = 256 * 1_024 * 1_024;
/** One conversation parsed at a time; the largest seen in real exports is about 1 MB. */
export const CHATGPT_CONVERSATION_MAX_BYTES = 64 * 1_024 * 1_024;
const TITLE_SNIFF_BYTES = 4_096;

const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1_024 * 1_024));
}

/** End index of the JSON string starting at `start`, or -1 when it is not closed. */
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 0x5c) index += 1;
    else if (character === 0x22) return index;
  }
  return -1;
}

/**
 * Whether a file prefix is a JSON array whose first item has a `mapping`
 * key: ChatGPT's conversation shape (Claude's export, also an array in a
 * `conversations.json`, has none). Only the first item's own keys count.
 */
export function startsWithChatGptConversation(prefix: string): boolean {
  let index = prefix.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => {
    while (index < prefix.length && /\s/u.test(prefix.charAt(index))) index += 1;
  };
  skipSpace();
  if (prefix.charAt(index) !== "[") return false;
  index += 1;
  skipSpace();
  if (prefix.charAt(index) !== "{") return false;
  let depth = 0;
  let expectKey = false;
  for (; index < prefix.length; index += 1) {
    const character = prefix.charAt(index);
    if (character === "\"") {
      const end = stringEnd(prefix, index);
      if (end < 0) return false;
      if (depth === 1 && expectKey) {
        if (parseJson(prefix.slice(index, end + 1)) === "mapping") return true;
        expectKey = false;
      }
      index = end;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth === 1) expectKey = true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return false;
    } else if (character === "," && depth === 1) {
      expectKey = true;
    }
  }
  return false;
}

/**
 * The byte ranges of a top-level JSON array's items, found by tracking
 * strings and nesting without parsing: each item is parsed on its own, so a
 * large file never becomes one object graph. Null when the bytes are not an
 * array. An unterminated array yields its incomplete last item, which then
 * fails to parse on its own.
 */
export function jsonArrayItems(bytes: Uint8Array): Array<readonly [number, number]> | null {
  const isSpace = (byte: number | undefined) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (isSpace(bytes[index])) index += 1;
  if (bytes[index] !== 0x5b) return null;
  const items: Array<readonly [number, number]> = [];
  const push = (start: number, end: number) => {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (!isSpace(bytes[cursor])) {
        items.push([start, end]);
        return;
      }
    }
  };
  let start = index + 1;
  let depth = 0;
  let inString = false;
  let closed = false;
  for (index += 1; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (inString) {
      if (byte === 0x5c) index += 1;
      else if (byte === 0x22) inString = false;
    } else if (byte === 0x22) {
      inString = true;
    } else if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
    } else if (byte === 0x7d || byte === 0x5d) {
      if (depth === 0) {
        push(start, index);
        closed = true;
        break;
      }
      depth -= 1;
    } else if (byte === 0x2c && depth === 0) {
      push(start, index);
      start = index + 1;
    }
  }
  if (!closed) push(start, bytes.length);
  return items;
}

/** The title of a conversation that cannot be parsed, read from its first bytes. */
function sniffTitle(bytes: Uint8Array, start: number, end: number): string | undefined {
  const head = utf8.decode(bytes.subarray(start, Math.min(end, start + TITLE_SNIFF_BYTES)));
  const literal = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(head)?.[1];
  const title = literal === undefined ? undefined : parseJson(literal);
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

type ConvertContext = Readonly<{ now: Date; conversationMaxBytes: number }>;

function* conversationEvents(
  bytes: Uint8Array,
  fileName: string,
  context: ConvertContext
): Generator<ImportConverterEvent> {
  const items = jsonArrayItems(bytes);
  if (!items) {
    yield { file: true, reason: "file_unreadable", title: fileName, type: "failed" };
    return;
  }
  if (items.length) yield { chats: items.length, type: "total" };
  for (const [position, [start, end]] of items.entries()) {
    const fallbackTitle = () => sniffTitle(bytes, start, end) ?? `${fileName} #${position + 1}`;
    if (end - start > context.conversationMaxBytes) {
      yield {
        message: `The conversation is larger than ${megabytes(context.conversationMaxBytes)} MB`,
        reason: "too_large",
        title: fallbackTitle(),
        type: "failed"
      };
      continue;
    }
    const value = parseJson(utf8.decode(bytes.subarray(start, end)));
    if (value === undefined) {
      yield { reason: "chat_export_shape_invalid", title: fallbackTitle(), type: "failed" };
      continue;
    }
    const converted = convertChatGptConversation(value, context.now);
    if (converted.kind === "failed") {
      yield { reason: converted.reason, title: converted.title === chatGptTitle(undefined) ? fallbackTitle() : converted.title, type: "failed" };
      continue;
    }
    for (const [kind, count] of Object.entries(converted.skipped) as Array<[ImportSkipKind, number]>) {
      if (count > 0) yield { count, kind, type: "skipped" };
    }
    if (converted.kind === "empty") yield { count: 1, kind: "empty_chat", type: "skipped" };
    else yield { chat: converted.chat, type: "chat" };
  }
}

/** What detection learned about a ChatGPT zip. */
type ZipPlan = Readonly<{
  /** Folder of the manifest or of the conversations file. */
  base: string;
  /** Conversation files the manifest lists (archive paths); null reads every conversations file in `base`. */
  listed: readonly string[] | null;
}>;

function manifestFiles(value: unknown): readonly string[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const files = (value as { export_files?: unknown }).export_files;
  if (!Array.isArray(files)) return null;
  return files.flatMap((entry) => {
    const path = typeof entry === "object" && entry !== null ? (entry as { path?: unknown }).path : undefined;
    return typeof path === "string" && CONVERSATIONS_FILE.test(baseName(path)) &&
      !path.startsWith("/") && !path.split("/").includes("..") ? [path.replace(/^\.\//u, "")] : [];
  });
}

async function inspectZip(archive: ImportArchive): Promise<ZipPlan | null> {
  for await (const entry of archive.entries((info) =>
    baseName(info.path) === MANIFEST_NAME ? { maxBytes: MANIFEST_MAX_BYTES } : null)) {
    if (entry.kind !== "data") continue;
    const files = manifestFiles(parseJson(utf8.decode(entry.bytes)));
    if (files) {
      const base = folderOf(entry.path);
      return { base, listed: files.length ? files.map((path) => `${base}${path}`) : null };
    }
  }
  let found: string | null = null;
  for await (const entry of archive.entries((info) =>
    found === null && CONVERSATIONS_FILE.test(baseName(info.path)) ? { maxBytes: DETECT_PREFIX_BYTES, prefix: true } : null)) {
    found = entry.path;
    if (entry.kind === "data" && startsWithChatGptConversation(utf8.decode(entry.bytes))) {
      return { base: folderOf(entry.path), listed: null };
    }
  }
  return null;
}

async function* zipEvents(file: ImportFile, plan: ZipPlan, context: ConvertContext): AsyncGenerator<ImportConverterEvent> {
  const archive = await file.archive();
  const listed = plan.listed ? new Set(plan.listed) : null;
  const wanted = (path: string) => listed
    ? listed.has(path)
    : folderOf(path) === plan.base && CONVERSATIONS_FILE.test(baseName(path));
  const seen = new Set<string>();
  for await (const entry of archive.entries((info) =>
    wanted(info.path) && !seen.has(info.path) ? { maxBytes: CHATGPT_ARCHIVE_FILE_MAX_BYTES } : null)) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    if (entry.kind === "too_large") {
      yield {
        file: true,
        message: `The conversations file is larger than ${megabytes(CHATGPT_ARCHIVE_FILE_MAX_BYTES)} MB`,
        reason: "too_large",
        title: entry.path,
        type: "failed"
      };
      continue;
    }
    yield* conversationEvents(entry.bytes, entry.path, context);
  }
  for (const path of listed ?? []) {
    if (!seen.has(path)) yield { file: true, reason: "missing_from_archive", title: path, type: "failed" };
  }
  if (!listed && seen.size === 0) {
    yield { file: true, message: "The export holds no conversations file", reason: "unsupported_file", title: file.name, type: "failed" };
  }
}

async function* jsonFileEvents(file: ImportFile, context: ConvertContext): AsyncGenerator<ImportConverterEvent> {
  if (file.size > CHATGPT_JSON_FILE_MAX_BYTES) {
    yield {
      file: true,
      message: `The file is larger than ${megabytes(CHATGPT_JSON_FILE_MAX_BYTES)} MB; import the export's .zip instead`,
      reason: "too_large",
      title: file.name,
      type: "failed"
    };
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = encoder.encode(await file.text(CHATGPT_JSON_FILE_MAX_BYTES));
  } catch {
    yield { file: true, reason: "file_unreadable", title: file.name, type: "failed" };
    return;
  }
  yield* conversationEvents(bytes, file.name, context);
}

async function isManifestFile(file: ImportFile): Promise<boolean> {
  if (file.size > MANIFEST_MAX_BYTES || !/^\ufeff?\s*\{/u.test(await file.head(64))) return false;
  return manifestFiles(parseJson(await file.text(MANIFEST_MAX_BYTES).catch(() => ""))) !== null;
}

export type ChatGptConverterOptions = Readonly<{
  now?: () => Date;
  /** Tests lower the per-conversation bound. */
  conversationMaxBytes?: number;
}>;

export function createChatGptConverter(options: ChatGptConverterOptions = {}): ChatImportConverter {
  const plans = new WeakMap<ImportFile, ZipPlan>();
  const manifests = new WeakSet<ImportFile>();
  return {
    async detect(files): Promise<ConverterDetection> {
      const claimed: ImportFile[] = [];
      const refused: Array<NonNullable<ConverterDetection["refused"]>[number]> = [];
      const indexes: ImportFile[] = [];
      for (const file of files) {
        if (file.kind === "json") {
          if (startsWithChatGptConversation(await file.head(DETECT_PREFIX_BYTES))) claimed.push(file);
          else if (await isManifestFile(file)) indexes.push(file);
          continue;
        }
        if (file.kind !== "zip") continue;
        try {
          const plan = await inspectZip(await file.archive());
          if (plan) {
            plans.set(file, plan);
            claimed.push(file);
          }
        } catch (error) {
          if (!(error instanceof ImportArchiveError)) throw error;
          refused.push({ file, reason: error.code });
        }
      }
      // The export index picked with its conversation files is read along with them; alone it imports nothing.
      const withConversations = claimed.some((file) => file.kind === "json");
      for (const file of indexes) {
        manifests.add(file);
        if (withConversations) claimed.push(file);
        else {
          refused.push({
            file,
            message: "This is the index of a ChatGPT export. Pick the .zip itself or its conversations JSON files.",
            reason: "unsupported_file"
          });
        }
      }
      return { claimed, refused };
    },
    async *convert(files) {
      const context: ConvertContext = {
        conversationMaxBytes: options.conversationMaxBytes ?? CHATGPT_CONVERSATION_MAX_BYTES,
        now: options.now?.() ?? new Date()
      };
      for (const file of files) {
        if (manifests.has(file)) continue;
        const plan = plans.get(file);
        try {
          if (plan) yield* zipEvents(file, plan, context);
          else if (file.kind === "json") yield* jsonFileEvents(file, context);
        } catch (error) {
          if (!(error instanceof ImportArchiveError)) throw error;
          yield { file: true, reason: error.code, title: file.name, type: "failed" };
        }
      }
    },
    source: "CHATGPT"
  };
}
