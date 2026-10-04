/**
 * Versioned chat export documents. They leave the installation and are held
 * by users, so a published version never changes: a new shape bumps
 * `version`, and the decoders keep accepting every published version.
 *
 * `aiqsa.chat` carries one chat with its whole message tree; message ids are
 * export-local and never database identifiers. `aiqsa.chat-archive` is the
 * root manifest of the bulk archive and lists its per-chat documents.
 */
export const CHAT_EXPORT_FORMAT = "aiqsa.chat";
export const CHAT_EXPORT_VERSION = 1;
export const CHAT_ARCHIVE_FORMAT = "aiqsa.chat-archive";
export const CHAT_ARCHIVE_VERSION = 1;
export const CHAT_ARCHIVE_MANIFEST_PATH = "manifest.json";

export const CHAT_EXPORT_MESSAGE_STATUSES = ["cancelled", "complete", "error", "queued", "streaming"] as const;
/** Structural bounds of the decoder; product limits of an importer are separate. */
export const CHAT_EXPORT_MAX_MESSAGES = 50_000;
export const CHAT_EXPORT_MAX_TITLE_LENGTH = 1_024;
export const CHAT_EXPORT_MAX_ATTACHMENTS_PER_MESSAGE = 256;
export const CHAT_ARCHIVE_MAX_CHATS = 100_000;

export type ChatExportMessageStatus = (typeof CHAT_EXPORT_MESSAGE_STATUSES)[number];

export type ChatExportDocumentAttachment = Readonly<{
  name: string;
  mimeType?: string;
  byteSize?: number;
}>;

export type ChatExportDocumentMessage = Readonly<{
  id: string;
  parentId: string | null;
  role: "assistant" | "user";
  createdAt: string;
  status: ChatExportMessageStatus;
  text: string;
  model?: Readonly<{ provider: string; modelId: string }>;
  attachments?: readonly ChatExportDocumentAttachment[];
}>;

export type ChatExportDocumentChat = Readonly<{
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  activeLeafId: string | null;
  /** Parent before child; several null-parent roots are valid. */
  messages: readonly ChatExportDocumentMessage[];
}>;

export type ChatExportDocument = Readonly<{
  format: typeof CHAT_EXPORT_FORMAT;
  version: typeof CHAT_EXPORT_VERSION;
  exportedAt: string;
  chat: ChatExportDocumentChat;
}>;

export type ChatArchiveManifestEntry = Readonly<{
  /** Archive-relative path of the chat's `aiqsa.chat` JSON document. */
  path: string;
  /** Archive-relative path of the readable active-branch Markdown. */
  markdownPath: string;
  title: string;
  archived: boolean;
  updatedAt: string;
}>;

export type ChatArchiveManifest = Readonly<{
  format: typeof CHAT_ARCHIVE_FORMAT;
  version: typeof CHAT_ARCHIVE_VERSION;
  exportedAt: string;
  chats: readonly ChatArchiveManifestEntry[];
}>;

export type ChatExportDecodeErrorCode =
  | "chat_export_format_unsupported"
  | "chat_export_version_unsupported"
  | "chat_export_shape_invalid"
  | "chat_export_date_invalid"
  | "chat_export_too_large"
  | "chat_export_message_id_duplicate"
  | "chat_export_parent_missing"
  | "chat_export_parent_order_invalid"
  | "chat_export_tree_cycle"
  | "chat_export_active_leaf_missing";

export type ChatArchiveDecodeErrorCode =
  | "chat_archive_format_unsupported"
  | "chat_archive_version_unsupported"
  | "chat_archive_shape_invalid"
  | "chat_archive_date_invalid"
  | "chat_archive_too_large"
  | "chat_archive_path_invalid"
  | "chat_archive_path_duplicate";

export type ChatExportDecodeResult<T, TCode extends string> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: TCode }>;

type DecodeFailure<TCode extends string> = Readonly<{ ok: false; code: TCode }>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  return required.every((key) => key in record) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0) && !value.includes("\0");
}

function fail<TCode extends string>(code: TCode): DecodeFailure<TCode> {
  return { ok: false, code };
}

function decodeAttachment(value: unknown): ChatExportDocumentAttachment | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name"], ["mimeType", "byteSize"]) ||
    !boundedString(value.name, 1_024) ||
    (value.mimeType !== undefined && !boundedString(value.mimeType, 255)) ||
    (value.byteSize !== undefined && (!Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0))) return null;
  return {
    name: value.name,
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.byteSize === "number" ? { byteSize: value.byteSize } : {})
  };
}

type MessageDecode = ChatExportDocumentMessage | DecodeFailure<ChatExportDecodeErrorCode>;

function decodeMessage(value: unknown): MessageDecode {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ["id", "parentId", "role", "createdAt", "status", "text"], ["model", "attachments"]) ||
    typeof value.id !== "string" || !LOCAL_ID.test(value.id) ||
    !(value.parentId === null || typeof value.parentId === "string" && LOCAL_ID.test(value.parentId)) ||
    (value.role !== "user" && value.role !== "assistant") ||
    !CHAT_EXPORT_MESSAGE_STATUSES.includes(value.status as ChatExportMessageStatus) ||
    typeof value.text !== "string" || value.text.includes("\0")) return fail("chat_export_shape_invalid");
  if (!isInstant(value.createdAt)) return fail("chat_export_date_invalid");
  let model: ChatExportDocumentMessage["model"];
  if (value.model !== undefined) {
    const candidate = value.model;
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["provider", "modelId"]) ||
      !boundedString(candidate.provider, 256) || !boundedString(candidate.modelId, 256)) return fail("chat_export_shape_invalid");
    model = { provider: candidate.provider, modelId: candidate.modelId };
  }
  let attachments: ChatExportDocumentAttachment[] | undefined;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length === 0 ||
      value.attachments.length > CHAT_EXPORT_MAX_ATTACHMENTS_PER_MESSAGE) return fail("chat_export_shape_invalid");
    attachments = [];
    for (const item of value.attachments) {
      const attachment = decodeAttachment(item);
      if (!attachment) return fail("chat_export_shape_invalid");
      attachments.push(attachment);
    }
  }
  return {
    id: value.id,
    parentId: value.parentId,
    role: value.role,
    createdAt: value.createdAt,
    status: value.status as ChatExportMessageStatus,
    text: value.text,
    ...(model ? { model } : {}),
    ...(attachments ? { attachments } : {})
  };
}

/** The first structural failure of a forest given in document order, if any. */
function treeFailure(messages: readonly ChatExportDocumentMessage[]): ChatExportDecodeErrorCode | null {
  const positions = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (positions.has(message.id)) return "chat_export_message_id_duplicate";
    positions.set(message.id, index);
  }
  const parents = new Map(messages.map((message) => [message.id, message.parentId]));
  for (const [index, message] of messages.entries()) {
    if (message.parentId === null) continue;
    const parentIndex = positions.get(message.parentId);
    if (parentIndex === undefined) return "chat_export_parent_missing";
    if (parentIndex < index) continue;
    // A later parent is either a cycle through this message or an order error.
    const seen = new Set<string>([message.id]);
    let cursor: string | null = message.parentId;
    while (cursor !== null) {
      if (seen.has(cursor)) return "chat_export_tree_cycle";
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    return "chat_export_parent_order_invalid";
  }
  return null;
}

function decodeChatV1(value: unknown): ChatExportDocumentChat | DecodeFailure<ChatExportDecodeErrorCode> {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, ["title", "createdAt", "updatedAt", "archived", "pinned", "activeLeafId", "messages"]) ||
    !boundedString(value.title, CHAT_EXPORT_MAX_TITLE_LENGTH, true) ||
    typeof value.archived !== "boolean" || typeof value.pinned !== "boolean" ||
    !(value.activeLeafId === null || typeof value.activeLeafId === "string" && LOCAL_ID.test(value.activeLeafId)) ||
    !Array.isArray(value.messages)) return fail("chat_export_shape_invalid");
  if (!isInstant(value.createdAt) || !isInstant(value.updatedAt)) return fail("chat_export_date_invalid");
  if (value.messages.length > CHAT_EXPORT_MAX_MESSAGES) return fail("chat_export_too_large");
  const messages: ChatExportDocumentMessage[] = [];
  for (const item of value.messages) {
    const message = decodeMessage(item);
    if ("ok" in message) return message;
    messages.push(message);
  }
  const failure = treeFailure(messages);
  if (failure) return fail(failure);
  if (value.activeLeafId !== null && !messages.some((message) => message.id === value.activeLeafId)) {
    return fail("chat_export_active_leaf_missing");
  }
  return {
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived: value.archived,
    pinned: value.pinned,
    activeLeafId: value.activeLeafId,
    messages
  };
}

/**
 * Validates an untrusted chat export document of any published version and
 * returns it in the current shape. Only version 1 is published.
 */
export function decodeChatExportDocument(
  value: unknown
): ChatExportDecodeResult<ChatExportDocument, ChatExportDecodeErrorCode> {
  if (!isRecord(value)) return fail("chat_export_shape_invalid");
  if (value.format !== CHAT_EXPORT_FORMAT) return fail("chat_export_format_unsupported");
  if (value.version !== CHAT_EXPORT_VERSION) return fail("chat_export_version_unsupported");
  if (!hasOnlyKeys(value, ["format", "version", "exportedAt", "chat"])) return fail("chat_export_shape_invalid");
  if (!isInstant(value.exportedAt)) return fail("chat_export_date_invalid");
  const chat = decodeChatV1(value.chat);
  if ("ok" in chat) return chat;
  return { ok: true, value: { format: CHAT_EXPORT_FORMAT, version: CHAT_EXPORT_VERSION, exportedAt: value.exportedAt, chat } };
}

/** A relative POSIX path inside the archive, without traversal or control characters. */
export function isSafeChatArchivePath(value: unknown, extension: ".json" | ".md"): value is string {
  return typeof value === "string" && value.length <= 512 && value.endsWith(extension) &&
    !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Validates an untrusted bulk archive manifest of any published version. */
export function decodeChatArchiveManifest(
  value: unknown
): ChatExportDecodeResult<ChatArchiveManifest, ChatArchiveDecodeErrorCode> {
  if (!isRecord(value)) return fail("chat_archive_shape_invalid");
  if (value.format !== CHAT_ARCHIVE_FORMAT) return fail("chat_archive_format_unsupported");
  if (value.version !== CHAT_ARCHIVE_VERSION) return fail("chat_archive_version_unsupported");
  if (!hasOnlyKeys(value, ["format", "version", "exportedAt", "chats"]) || !Array.isArray(value.chats)) {
    return fail("chat_archive_shape_invalid");
  }
  if (!isInstant(value.exportedAt)) return fail("chat_archive_date_invalid");
  if (value.chats.length > CHAT_ARCHIVE_MAX_CHATS) return fail("chat_archive_too_large");
  const chats: ChatArchiveManifestEntry[] = [];
  const paths = new Set<string>();
  for (const item of value.chats) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["path", "markdownPath", "title", "archived", "updatedAt"]) ||
      !boundedString(item.title, CHAT_EXPORT_MAX_TITLE_LENGTH, true) || typeof item.archived !== "boolean") {
      return fail("chat_archive_shape_invalid");
    }
    if (!isInstant(item.updatedAt)) return fail("chat_archive_date_invalid");
    if (!isSafeChatArchivePath(item.path, ".json") || !isSafeChatArchivePath(item.markdownPath, ".md") ||
      item.path === CHAT_ARCHIVE_MANIFEST_PATH) return fail("chat_archive_path_invalid");
    if (paths.has(item.path) || paths.has(item.markdownPath)) return fail("chat_archive_path_duplicate");
    paths.add(item.path);
    paths.add(item.markdownPath);
    chats.push({ path: item.path, markdownPath: item.markdownPath, title: item.title, archived: item.archived, updatedAt: item.updatedAt });
  }
  return { ok: true, value: { format: CHAT_ARCHIVE_FORMAT, version: CHAT_ARCHIVE_VERSION, exportedAt: value.exportedAt, chats } };
}
