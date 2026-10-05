import {
  decodeChatExportDocument,
  type ChatExportDecodeErrorCode,
  type ChatExportDocument
} from "./chatExport";

/**
 * Chat import: the browser unpacks an export and converts each conversation
 * to an `aiqsa.chat` document, then sends batches of them to
 * `POST /api/me/chats/import`. The server has this one validated input
 * format; archives and source-specific shapes never reach it.
 */
export const CHAT_IMPORT_SOURCES = ["AIQSA", "CHATGPT", "CLAUDE"] as const;
export type ChatImportSource = (typeof CHAT_IMPORT_SOURCES)[number];

/** Route-specific JSON body limit, inside the configurable 16 MiB JSON ceiling. */
export const CHAT_IMPORT_REQUEST_MAX_BYTES = 8 * 1_024 * 1_024;
export const CHAT_IMPORT_MAX_CHATS_PER_REQUEST = 100;
/** Product bounds of one imported chat; the document decoder's structural bounds are wider. */
export const CHAT_IMPORT_MAX_MESSAGES = 20_000;
export const CHAT_IMPORT_MAX_MESSAGE_TEXT_LENGTH = 1_000_000;
export const CHAT_IMPORT_SOURCE_KEY_MAX_LENGTH = 256;
export const CHAT_IMPORT_SOURCE_MODEL_MAX_LENGTH = 128;
/** Imported dates must fall between this instant and one day after the import. */
export const CHAT_IMPORT_EARLIEST_DATE = "2000-01-01T00:00:00.000Z";
const CHAT_IMPORT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1_000;

export type ChatImportItem = Readonly<{
  source: ChatImportSource;
  /**
   * The source's conversation id (ChatGPT, Claude). AIQSA documents carry no
   * stable chat id and send none: the server keys them by their content.
   */
  sourceKey?: string;
  /** The source's chat-level model label, kept for display only. */
  sourceModel?: string;
  document: ChatExportDocument;
}>;

/**
 * One import batch. `accountId` is the account the import was started for
 * (the signed-in user's id when it began): a batch whose session now belongs
 * to another account is refused with `CHAT_IMPORT_ACCOUNT_CHANGED` before
 * anything is decoded or stored.
 */
export type ChatImportRequest = Readonly<{ accountId: string; chats: readonly ChatImportItem[] }>;

export const CHAT_IMPORT_ACCOUNT_CHANGED = "chat_import_account_changed";
const CHAT_IMPORT_ACCOUNT_ID_MAX_LENGTH = 256;

export type ChatImportFailureCode =
  | ChatExportDecodeErrorCode
  | "chat_import_item_invalid"
  | "chat_import_empty"
  | "chat_import_too_many_messages"
  | "chat_import_text_too_long"
  | "chat_import_date_out_of_range"
  | "chat_import_failed";

export const CHAT_IMPORT_FAILURE_CODES: readonly ChatImportFailureCode[] = [
  "chat_export_format_unsupported",
  "chat_export_version_unsupported",
  "chat_export_shape_invalid",
  "chat_export_date_invalid",
  "chat_export_too_large",
  "chat_export_message_id_duplicate",
  "chat_export_parent_missing",
  "chat_export_parent_order_invalid",
  "chat_export_tree_cycle",
  "chat_export_active_leaf_missing",
  "chat_import_item_invalid",
  "chat_import_empty",
  "chat_import_too_many_messages",
  "chat_import_text_too_long",
  "chat_import_date_out_of_range",
  "chat_import_failed"
];

export type ChatImportResult =
  | Readonly<{ status: "imported"; messages: number }>
  | Readonly<{ status: "already_imported" }>
  | Readonly<{ status: "failed"; code: ChatImportFailureCode }>;

export type ChatImportResponse = Readonly<{ results: readonly ChatImportResult[] }>;

type Decoded<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: ChatImportFailureCode }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => key in record) &&
    Object.keys(record).every((key) => required.includes(key) || optional.includes(key));
}

/** Printable single-line text: no control characters, not blank. */
function boundedLabel(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * A source model label as the import accepts it: one trimmed line within the
 * length bound, cut on a code-point boundary; nothing when it is empty. A
 * label is display data and never fails a chat.
 */
export function normalizeChatImportSourceModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let label = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (label.length > CHAT_IMPORT_SOURCE_MODEL_MAX_LENGTH) {
    const end = /[\ud800-\udbff]/u.test(label.charAt(CHAT_IMPORT_SOURCE_MODEL_MAX_LENGTH - 1))
      ? CHAT_IMPORT_SOURCE_MODEL_MAX_LENGTH - 1
      : CHAT_IMPORT_SOURCE_MODEL_MAX_LENGTH;
    label = label.slice(0, end).trimEnd();
  }
  return label || undefined;
}

function withinImportRange(value: string, earliest: number, latest: number): boolean {
  const time = Date.parse(value);
  return time >= earliest && time <= latest;
}

/**
 * The product bounds an imported chat must meet beyond the structural
 * document decoder: at least one message, bounded size and plausible dates.
 * The browser checks them before sending; the server enforces them again.
 */
export function chatImportDocumentFailure(
  document: ChatExportDocument,
  now: Date
): ChatImportFailureCode | null {
  const { chat } = document;
  if (chat.messages.length === 0) return "chat_import_empty";
  if (chat.messages.length > CHAT_IMPORT_MAX_MESSAGES) return "chat_import_too_many_messages";
  if (chat.messages.some((message) => message.text.length > CHAT_IMPORT_MAX_MESSAGE_TEXT_LENGTH)) {
    return "chat_import_text_too_long";
  }
  const earliest = Date.parse(CHAT_IMPORT_EARLIEST_DATE);
  const latest = now.getTime() + CHAT_IMPORT_FUTURE_TOLERANCE_MS;
  if (![chat.createdAt, chat.updatedAt, ...chat.messages.map((message) => message.createdAt)]
    .every((value) => withinImportRange(value, earliest, latest))) {
    return "chat_import_date_out_of_range";
  }
  return null;
}

/**
 * Validates one untrusted import item: its envelope, the `aiqsa.chat`
 * document of any published version, then the import bounds. A failure
 * names the first problem by a stable code.
 */
export function decodeChatImportItem(value: unknown, now: Date): Decoded<ChatImportItem> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["source", "document"], ["sourceKey", "sourceModel"]) ||
    !CHAT_IMPORT_SOURCES.includes(value.source as ChatImportSource)) {
    return { ok: false, code: "chat_import_item_invalid" };
  }
  const source = value.source as ChatImportSource;
  // AIQSA documents are keyed by content; every other source names its conversation.
  if (source === "AIQSA" ? value.sourceKey !== undefined
    : !boundedLabel(value.sourceKey, CHAT_IMPORT_SOURCE_KEY_MAX_LENGTH)) {
    return { ok: false, code: "chat_import_item_invalid" };
  }
  if (value.sourceModel !== undefined && !boundedLabel(value.sourceModel, CHAT_IMPORT_SOURCE_MODEL_MAX_LENGTH)) {
    return { ok: false, code: "chat_import_item_invalid" };
  }
  const decoded = decodeChatExportDocument(value.document);
  if (!decoded.ok) return decoded;
  const failure = chatImportDocumentFailure(decoded.value, now);
  if (failure) return { ok: false, code: failure };
  return {
    ok: true,
    value: {
      document: decoded.value,
      source,
      ...(typeof value.sourceKey === "string" ? { sourceKey: value.sourceKey } : {}),
      ...(typeof value.sourceModel === "string" ? { sourceModel: value.sourceModel } : {})
    }
  };
}

/** The request envelope: one to `CHAT_IMPORT_MAX_CHATS_PER_REQUEST` items, each decoded on its own. */
export function decodeChatImportRequestItems(value: unknown): readonly unknown[] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["accountId", "chats"], []) || !Array.isArray(value.chats) ||
    value.chats.length === 0 || value.chats.length > CHAT_IMPORT_MAX_CHATS_PER_REQUEST) return null;
  return value.chats;
}

/** The account a batch was started for, read before anything else in the request. */
export function chatImportRequestAccountId(value: unknown): string | null {
  return isRecord(value) && boundedLabel(value.accountId, CHAT_IMPORT_ACCOUNT_ID_MAX_LENGTH) ? value.accountId : null;
}

function decodeResult(value: unknown): ChatImportResult | null {
  if (!isRecord(value)) return null;
  if (value.status === "imported" && hasOnlyKeys(value, ["status", "messages"], []) &&
    Number.isSafeInteger(value.messages) && Number(value.messages) > 0) {
    return { messages: Number(value.messages), status: "imported" };
  }
  if (value.status === "already_imported" && hasOnlyKeys(value, ["status"], [])) {
    return { status: "already_imported" };
  }
  if (value.status === "failed" && hasOnlyKeys(value, ["status", "code"], []) &&
    CHAT_IMPORT_FAILURE_CODES.includes(value.code as ChatImportFailureCode)) {
    return { code: value.code as ChatImportFailureCode, status: "failed" };
  }
  return null;
}

/** One result per sent chat, in request order; anything else is malformed. */
export function decodeChatImportResponse(value: unknown, expectedCount: number): ChatImportResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["results"], []) || !Array.isArray(value.results) ||
    value.results.length !== expectedCount) return null;
  const results: ChatImportResult[] = [];
  for (const item of value.results) {
    const result = decodeResult(item);
    if (!result) return null;
    results.push(result);
  }
  return { results };
}
