import {
  CHAT_IMPORT_REQUEST_MAX_BYTES,
  normalizeChatImportSourceModel
} from "@/lib/contracts/chatImport";
import {
  CHAT_ARCHIVE_MANIFEST_PATH,
  decodeChatArchiveManifest,
  decodeChatExportDocument,
  type ChatArchiveManifest,
  type ChatExportDocument,
  type ChatExportDocumentMessage
} from "@/lib/contracts/chatExport";
import { ImportArchiveError } from "../archive/archiveTypes";
import type { ImportFile } from "../importFile";
import {
  appendNotes,
  notImportedNote,
  type ChatImportConverter,
  type ConverterDetection,
  type ImportConverterEvent
} from "./converterTypes";

/**
 * Exported documents are pretty-printed; a document this large cannot fit
 * one import request even compacted, so it is reported as too large unread.
 */
export const AIQSA_DOCUMENT_MAX_BYTES = 4 * CHAT_IMPORT_REQUEST_MAX_BYTES;
/** The bulk manifest lists at most 100,000 chats. */
const MANIFEST_MAX_BYTES = 64 * 1_024 * 1_024;
const HEAD_BYTES = 256;
/** AIQSA writes both documents with their format first. */
const FORMAT_HEAD = /^﻿?\s*\{\s*"format"\s*:\s*"(aiqsa\.chat(?:-archive)?)"\s*,/u;
const OBJECT_HEAD = /^﻿?\s*\{/u;
const utf8 = new TextDecoder("utf-8");

type FoundManifest = Readonly<{ base: string; manifest: ChatArchiveManifest }>;

function isManifestPath(path: string): boolean {
  return path === CHAT_ARCHIVE_MANIFEST_PATH || path.endsWith(`/${CHAT_ARCHIVE_MANIFEST_PATH}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The AIQSA format of a JSON file: from its first key as AIQSA writes it,
 * else, for an object small enough to be a chat (another tool may have
 * reordered the keys), from the parsed `format` field.
 */
async function jsonFormat(file: ImportFile): Promise<string | null> {
  const head = await file.head(HEAD_BYTES);
  const written = FORMAT_HEAD.exec(head);
  if (written) return written[1]!;
  if (!OBJECT_HEAD.test(head) || file.size > AIQSA_DOCUMENT_MAX_BYTES) return null;
  const value = parseJson(await file.text(AIQSA_DOCUMENT_MAX_BYTES).catch(() => ""));
  const format = typeof value === "object" && value !== null ? (value as { format?: unknown }).format : undefined;
  return format === "aiqsa.chat" || format === "aiqsa.chat-archive" ? format : null;
}

/** The first `manifest.json` that decodes as an AIQSA archive index; chat paths are relative to its folder. */
async function findManifest(file: ImportFile): Promise<FoundManifest | null> {
  const archive = await file.archive();
  for await (const entry of archive.entries((info) => isManifestPath(info.path) ? { maxBytes: MANIFEST_MAX_BYTES } : null)) {
    if (entry.kind !== "data") continue;
    const decoded = decodeChatArchiveManifest(parseJson(utf8.decode(entry.bytes)));
    if (decoded.ok) {
      return { base: entry.path.slice(0, entry.path.length - CHAT_ARCHIVE_MANIFEST_PATH.length), manifest: decoded.value };
    }
  }
  return null;
}

/** The model of the latest answer on the active branch, else of the latest answer anywhere. */
function sourceModel(document: ChatExportDocument): string | undefined {
  const answered = (message: ChatExportDocumentMessage | undefined) => message?.role === "assistant" && message.model;
  const byId = new Map(document.chat.messages.map((message) => [message.id, message]));
  let cursor = document.chat.activeLeafId ? byId.get(document.chat.activeLeafId) : undefined;
  while (cursor && !answered(cursor)) cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  for (let index = document.chat.messages.length - 1; !cursor && index >= 0; index -= 1) {
    if (answered(document.chat.messages[index])) cursor = document.chat.messages[index];
  }
  return normalizeChatImportSourceModel(cursor?.model?.modelId);
}

/** Attachments are not imported: each becomes a note in its message; model labels stay out. */
function importableMessage(message: ChatExportDocumentMessage): ChatExportDocumentMessage {
  const names = message.attachments?.map((attachment) => attachment.name) ?? [];
  return {
    createdAt: message.createdAt,
    id: message.id,
    parentId: message.parentId,
    role: message.role,
    status: message.status,
    text: names.length
      ? appendNotes(message.text, [notImportedNote(names.length === 1 ? "Attachment" : "Attachments", names)])
      : message.text
  };
}

function titleOf(value: unknown, fallback: string): string {
  const chat = typeof value === "object" && value !== null ? (value as { chat?: unknown }).chat : undefined;
  const title = typeof chat === "object" && chat !== null ? (chat as { title?: unknown }).title : undefined;
  return typeof title === "string" && title.trim() ? title : fallback;
}

function* documentEvents(text: string, fallbackTitle: string): Generator<ImportConverterEvent> {
  const value = parseJson(text);
  if (value === undefined) {
    yield { reason: "file_unreadable", title: fallbackTitle, type: "failed" };
    return;
  }
  const decoded = decodeChatExportDocument(value);
  if (!decoded.ok) {
    yield { reason: decoded.code, title: titleOf(value, fallbackTitle), type: "failed" };
    return;
  }
  const { chat } = decoded.value;
  if (chat.messages.length === 0) {
    yield { count: 1, kind: "empty_chat", type: "skipped" };
    return;
  }
  const attachments = chat.messages.reduce((total, message) => total + (message.attachments?.length ?? 0), 0);
  if (attachments > 0) yield { count: attachments, kind: "attachment", type: "skipped" };
  const model = sourceModel(decoded.value);
  yield {
    chat: {
      document: { ...decoded.value, chat: { ...chat, messages: chat.messages.map(importableMessage) } },
      source: "AIQSA",
      ...(model ? { sourceModel: model } : {})
    },
    type: "chat"
  };
}

async function* archiveEvents(file: ImportFile, found: FoundManifest): AsyncGenerator<ImportConverterEvent> {
  const listed = new Map(found.manifest.chats.map((entry) => [`${found.base}${entry.path}`, entry]));
  yield { chats: listed.size, type: "total" };
  const seen = new Set<string>();
  const archive = await file.archive();
  const select = (info: Readonly<{ path: string }>) =>
    listed.has(info.path) && !seen.has(info.path) ? { maxBytes: AIQSA_DOCUMENT_MAX_BYTES } : null;
  for await (const entry of archive.entries(select)) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const title = listed.get(entry.path)?.title || entry.path;
    if (entry.kind === "too_large") {
      yield { reason: "too_large", title, type: "failed" };
      continue;
    }
    yield* documentEvents(utf8.decode(entry.bytes), title);
  }
  for (const [path, entry] of listed) {
    if (!seen.has(path)) yield { reason: "missing_from_archive", title: entry.title || path, type: "failed" };
  }
}

/**
 * AIQSA's own exports: single-chat `aiqsa.chat` JSON files, and the bulk
 * archive (`.tar.gz`, or the same files zipped) with its `manifest.json`.
 * Only the manifest and the documents it lists are read.
 */
export function createAiqsaConverter(): ChatImportConverter {
  const manifests = new WeakMap<ImportFile, FoundManifest>();
  return {
    async detect(files): Promise<ConverterDetection> {
      const claimed: ImportFile[] = [];
      const refused: Array<NonNullable<ConverterDetection["refused"]>[number]> = [];
      for (const file of files) {
        if (file.kind === "json") {
          const format = await jsonFormat(file);
          if (format === "aiqsa.chat") claimed.push(file);
          else if (format === "aiqsa.chat-archive") {
            refused.push({
              file,
              message: "This is the index of a bulk export. Pick the .tar.gz archive itself.",
              reason: "unsupported_file"
            });
          }
          continue;
        }
        if (file.kind !== "zip" && file.kind !== "tar.gz") continue;
        try {
          const found = await findManifest(file);
          if (found) {
            manifests.set(file, found);
            claimed.push(file);
          } else if (file.kind === "tar.gz") {
            // Only AIQSA exports come as tar.gz; another converter cannot read it either.
            refused.push({ file, reason: "unsupported_file" });
          }
        } catch (error) {
          // A damaged or hostile archive is unreadable for every converter.
          if (!(error instanceof ImportArchiveError)) throw error;
          refused.push({ file, reason: error.code });
        }
      }
      return { claimed, refused };
    },
    async *convert(files) {
      const documents = files.filter((file) => file.kind === "json");
      if (documents.length) yield { chats: documents.length, type: "total" };
      for (const file of documents) {
        if (file.size > AIQSA_DOCUMENT_MAX_BYTES) {
          yield { reason: "too_large", title: file.name, type: "failed" };
          continue;
        }
        let text: string;
        try {
          text = await file.text(AIQSA_DOCUMENT_MAX_BYTES);
        } catch {
          yield { reason: "file_unreadable", title: file.name, type: "failed" };
          continue;
        }
        yield* documentEvents(text, file.name);
      }
      for (const file of files) {
        const found = manifests.get(file);
        if (!found) continue;
        try {
          yield* archiveEvents(file, found);
        } catch (error) {
          if (!(error instanceof ImportArchiveError)) throw error;
          yield { reason: error.code, title: file.name, type: "failed" };
        }
      }
    },
    source: "AIQSA"
  };
}
