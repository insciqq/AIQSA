import { CHAT_IMPORT_REQUEST_MAX_BYTES } from "@/lib/contracts/chatImport";
import { IMPORT_SKIP_KINDS, type ImportLocalFailureReason, type ImportSkipKind } from "./converters/converterTypes";

/** A reason of the report: local ones, server codes, or the server not confirming a chat. */
export type ImportFailureReason = ImportLocalFailureReason | "server_unconfirmed";

const LIMIT_MB = Math.round(CHAT_IMPORT_REQUEST_MAX_BYTES / (1_024 * 1_024));
const MALFORMED = "The export file is malformed";

const FAILURE_MESSAGES: Readonly<Record<ImportFailureReason, string>> = Object.freeze({
  archive_browser_unsupported: "This browser cannot unpack this archive; use a current browser",
  archive_entry_damaged: "The archive is damaged",
  archive_invalid: "Not a readable archive",
  archive_ratio_exceeded: "The archive expands far beyond its size and was not read",
  archive_too_large: "The archive expands beyond the import limit",
  archive_too_many_entries: "The archive holds too many files",
  archive_unsupported: "The archive is encrypted or uses unsupported compression",
  chat_export_active_leaf_missing: MALFORMED,
  chat_export_date_invalid: MALFORMED,
  chat_export_format_unsupported: "Not an AIQSA chat export",
  chat_export_message_id_duplicate: MALFORMED,
  chat_export_parent_missing: MALFORMED,
  chat_export_parent_order_invalid: MALFORMED,
  chat_export_shape_invalid: MALFORMED,
  chat_export_too_large: "Too many messages to import",
  chat_export_tree_cycle: MALFORMED,
  chat_export_version_unsupported: "Exported by a newer AIQSA version",
  chat_import_date_out_of_range: "Its dates are out of range",
  chat_import_empty: "The chat has no messages",
  chat_import_failed: "The server could not save it; run the import again",
  chat_import_item_invalid: "The converted chat is malformed",
  chat_import_text_too_long: "A message is too long to import",
  chat_import_too_many_messages: "Too many messages to import",
  file_unreadable: "Not a readable export file",
  missing_from_archive: "Listed in the archive index but missing from the archive",
  server_unconfirmed: "The server did not confirm it; run the import again to check",
  too_large: `Too large to import (over ${LIMIT_MB} MB)`,
  unsupported_file: "Not a supported export file"
});

export function importFailureMessage(reason: ImportFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

const SKIP_LABELS: Readonly<Record<ImportSkipKind, readonly [string, string]>> = Object.freeze({
  artifact: ["artifact", "artifacts"],
  attachment: ["attachment", "attachments"],
  audio: ["audio recording", "audio recordings"],
  empty_chat: ["empty chat", "empty chats"],
  image: ["image", "images"],
  tool: ["tool activity", "tool activities"]
});

function counted(count: number, [one, many]: readonly [string, string]): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 attachments, 1 empty chat" in a stable order; empty when nothing was skipped. */
export function skippedSummary(skipped: Readonly<Partial<Record<ImportSkipKind, number>>>): string {
  return IMPORT_SKIP_KINDS
    .filter((kind) => (skipped[kind] ?? 0) > 0)
    .map((kind) => counted(skipped[kind]!, SKIP_LABELS[kind]))
    .join(", ");
}

export function chatsCount(count: number): string {
  return counted(count, ["chat", "chats"]);
}

export function messagesCount(count: number): string {
  return counted(count, ["message", "messages"]);
}

/** "1 chat and 2 files" for the failures heading; files that could not be read are no chats. */
export function failuresCount(chats: number, files: number): string {
  return [chats ? chatsCount(chats) : "", files ? counted(files, ["file", "files"]) : ""].filter(Boolean).join(" and ");
}
