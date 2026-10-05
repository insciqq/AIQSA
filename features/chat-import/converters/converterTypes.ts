import type { ChatExportDocument } from "@/lib/contracts/chatExport";
import type { ChatImportFailureCode, ChatImportSource } from "@/lib/contracts/chatImport";
import type { ImportArchiveErrorCode } from "../archive/archiveTypes";
import type { ImportFile } from "../importFile";

/**
 * The converter contract of chat import. A converter recognizes the files it
 * understands (`detect`), then turns them into `aiqsa.chat` v1 documents
 * (`convert`), reading only the files and archive entries it needs. Content
 * that cannot be imported becomes a short Markdown note inside the message
 * text (see `notImportedNote`) and is counted with a `skipped` event.
 */
export interface ChatImportConverter {
  readonly source: ChatImportSource;
  /** Claims the files of this converter's format among those still unclaimed. */
  detect(files: readonly ImportFile[]): Promise<ConverterDetection>;
  /** Streams the claimed files' chats and what could not be imported. */
  convert(files: readonly ImportFile[]): AsyncIterable<ImportConverterEvent>;
}

export type ConverterDetection = Readonly<{
  /** Files this converter will convert; no other converter sees them. */
  claimed: readonly ImportFile[];
  /**
   * Files this converter recognizes but cannot import (an export index, a
   * damaged archive). They are reported with the reason, or the message
   * telling the user what to pick instead.
   */
  refused?: readonly Readonly<{ file: ImportFile; reason: ImportLocalFailureReason; message?: string }>[];
}>;

/** Content kinds a converter left out, and whole chats it skipped; the report counts each. */
export const IMPORT_SKIP_KINDS = ["attachment", "image", "audio", "tool", "artifact", "missing_message", "empty_chat"] as const;
export type ImportSkipKind = (typeof IMPORT_SKIP_KINDS)[number];
/** Skip kinds that stand for whole chats: they advance the import progress. */
export const IMPORT_SKIPPED_CHAT_KINDS: ReadonlySet<ImportSkipKind> = new Set(["empty_chat"]);

/** Why a source chat or file never reached the server. */
export type ImportLocalFailureReason =
  | ChatImportFailureCode
  | ImportArchiveErrorCode
  /** No converter recognizes the file. */
  | "unsupported_file"
  /** Not valid UTF-8 JSON of the expected shape. */
  | "file_unreadable"
  /** The chat's request item would exceed the import request limit. */
  | "too_large"
  /** Listed in an archive's index but not present in the archive. */
  | "missing_from_archive";

export type ConvertedChat = Readonly<{
  source: ChatImportSource;
  /** The source conversation id; required for every source except AIQSA. */
  sourceKey?: string;
  /** The source's chat-level model label. */
  sourceModel?: string;
  document: ChatExportDocument;
}>;

export type ImportConverterEvent =
  /** This many more chats are expected; events add up across converters. */
  | Readonly<{ type: "total"; chats: number }>
  | Readonly<{ type: "chat"; chat: ConvertedChat }>
  | Readonly<{ type: "skipped"; kind: ImportSkipKind; count: number }>
  /**
   * A source chat that cannot be imported, named for the report; with `file`,
   * a whole file that could not be read, which counts as no chat.
   */
  | Readonly<{ type: "failed"; title: string; reason: ImportLocalFailureReason; message?: string; file?: true }>;

const NOTE_NAME_MAX_LENGTH = 200;

/** A name as an escaped Markdown literal on one bounded line, for notes. */
export function markdownLiteral(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  const bounded = Array.from(oneLine).length > NOTE_NAME_MAX_LENGTH
    ? `${Array.from(oneLine).slice(0, NOTE_NAME_MAX_LENGTH - 1).join("")}…`
    : oneLine;
  return bounded.replace(/[\\`*_[\]<>#|~]/gu, (character) => `\\${character}`);
}

/**
 * The note left in a message for content that was not imported, e.g.
 * `_[Attachment not imported: photo.png]_`. Names are escaped Markdown
 * literals on one bounded line.
 */
export function notImportedNote(what: string, names: readonly string[] = []): string {
  const listed = names.map(markdownLiteral).filter(Boolean);
  return listed.length ? `_[${what} not imported: ${listed.join(", ")}]_` : `_[${what} not imported]_`;
}

/** The message text with notes appended as their own paragraphs. */
export function appendNotes(text: string, notes: readonly string[]): string {
  if (notes.length === 0) return text;
  const body = text.trimEnd();
  return body ? `${body}\n\n${notes.join("\n\n")}` : notes.join("\n\n");
}
