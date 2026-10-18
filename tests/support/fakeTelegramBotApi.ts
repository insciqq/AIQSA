import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  TELEGRAM_DOWNLOAD_MAX_BYTES, TELEGRAM_FILE_TIMEOUT_MS, TELEGRAM_JSON_RESPONSE_MAX_BYTES, TELEGRAM_JSON_TIMEOUT_MS,
  TELEGRAM_LONG_POLL_GRACE_MS, TELEGRAM_UPLOAD_MAX_BYTES, telegramOutcomeFromResponse,
  type TelegramOutcome, type TelegramTransport
} from "@/lib/server/telegram/transport";

/**
 * An in-memory Telegram bot for tests: users and their private chats, groups,
 * messages with per-chat ids, drafts, files and an update queue with long
 * polling. One model is served two ways: `fetch` (and the matching
 * `transport`) for vitest, and `start()`, a loopback `node:http` server for
 * Playwright and disposable stands (`AIQSA_TELEGRAM_API_ORIGIN`). It refuses
 * what Telegram refuses and, stricter than Telegram, what AIQSA must never
 * send: rich `markdown`/`html`, formatting modes and unknown block or text types.
 */

export const FAKE_TELEGRAM_TOKEN = "100000001:AAFakeTelegramBotTokenForTests_0000000";
export const FAKE_TELEGRAM_ORIGIN = "https://api.telegram.org";
export const FAKE_TELEGRAM_BOT = Object.freeze({ id: 100000001, first_name: "AIQSA Test", username: "aiqsa_test_bot" });

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "telegram");
/** One second of synthetic Opus silence in an Ogg container. */
export function telegramVoiceFixture(): Buffer {
  return readFileSync(path.join(FIXTURES, "voice.ogg"));
}
/** A synthetic 16×16 JPEG gradient. */
export function telegramPhotoFixture(): Buffer {
  return readFileSync(path.join(FIXTURES, "photo.jpg"));
}

// ---------------------------------------------------------------------------
// Rich message validation

export const TELEGRAM_RICH_LIMITS = Object.freeze({ characters: 32_768, blocks: 500, depth: 16, columns: 20 });
export const TELEGRAM_TEXT_MAX_LENGTH = 4_096;
export const TELEGRAM_CAPTION_MAX_LENGTH = 1_024;
const PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export type TelegramRichValidation =
  | Readonly<{ ok: true; characters: number; blocks: number; depth: number }>
  | Readonly<{ ok: false; reason: string }>;

class RichRefusal extends Error {}

const FORMATTING_TYPES = new Set(["bold", "italic", "underline", "strikethrough", "spoiler", "subscript", "superscript", "marked", "code"]);
const ALIGN = new Set(["left", "center", "right"]);
const VALIGN = new Set(["top", "middle", "bottom"]);
const LIST_LABELS = new Set(["a", "A", "i", "I", "1"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], reason: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new RichRefusal(`${reason}:${key}`);
}

function optionalTrue(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && value[key] !== true) throw new RichRefusal(`invalid_${key}`);
}

/**
 * Validates an `InputRichMessage` against Telegram's limits (32 768
 * characters, 500 blocks counting nested blocks, list items and table rows,
 * 16 nesting levels, 20 table columns) and AIQSA's policy: explicit `blocks`
 * of the rendered subset only, and plain, formatted, code, math or http(s)
 * link text. Character counts use UTF-16 units, which never undercounts.
 */
export function validateTelegramRichMessage(value: unknown): TelegramRichValidation {
  let characters = 0;
  let blocks = 0;
  let maxDepth = 0;
  const level = (depth: number) => {
    if (depth > TELEGRAM_RICH_LIMITS.depth) throw new RichRefusal("too_deep");
    maxDepth = Math.max(maxDepth, depth);
  };
  const plain = (text: unknown, reason: string) => {
    if (typeof text !== "string") throw new RichRefusal(reason);
    characters += text.length;
  };
  const richText = (text: unknown, depth: number): void => {
    if (typeof text === "string") { characters += text.length; return; }
    if (Array.isArray(text)) { for (const part of text) richText(part, depth); return; }
    if (!isRecord(text) || typeof text.type !== "string") throw new RichRefusal("invalid_text");
    level(depth + 1);
    if (FORMATTING_TYPES.has(text.type)) {
      onlyKeys(text, ["type", "text"], "unknown_text_field");
      richText(text.text, depth + 1);
    } else if (text.type === "url") {
      onlyKeys(text, ["type", "text", "url"], "unknown_text_field");
      let url: URL;
      try { url = new URL(String(text.url)); } catch { throw new RichRefusal("invalid_url"); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new RichRefusal("unsafe_url");
      richText(text.text, depth + 1);
    } else if (text.type === "mathematical_expression") {
      onlyKeys(text, ["type", "expression"], "unknown_text_field");
      plain(text.expression, "invalid_expression");
    } else {
      throw new RichRefusal(`unsupported_text:${text.type}`);
    }
  };
  const blockList = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || list.length === 0) throw new RichRefusal("invalid_blocks");
    for (const entry of list) block(entry, depth);
  };
  const block = (entry: unknown, depth: number): void => {
    if (!isRecord(entry) || typeof entry.type !== "string") throw new RichRefusal("invalid_block");
    level(depth + 1);
    blocks += 1;
    switch (entry.type) {
      case "paragraph":
      case "footer":
        onlyKeys(entry, ["type", "text"], "unknown_block_field");
        return richText(entry.text, depth + 1);
      case "heading":
        onlyKeys(entry, ["type", "text", "size"], "unknown_block_field");
        if (!Number.isInteger(entry.size) || (entry.size as number) < 1 || (entry.size as number) > 6) throw new RichRefusal("invalid_size");
        return richText(entry.text, depth + 1);
      case "pre":
        onlyKeys(entry, ["type", "text", "language"], "unknown_block_field");
        if (entry.language !== undefined && (typeof entry.language !== "string" || entry.language.length > 64)) {
          throw new RichRefusal("invalid_language");
        }
        return richText(entry.text, depth + 1);
      case "divider":
        return onlyKeys(entry, ["type"], "unknown_block_field");
      case "mathematical_expression":
        onlyKeys(entry, ["type", "expression"], "unknown_block_field");
        return plain(entry.expression, "invalid_expression");
      case "blockquote":
        onlyKeys(entry, ["type", "blocks", "credit"], "unknown_block_field");
        if (entry.credit !== undefined) richText(entry.credit, depth + 1);
        return blockList(entry.blocks, depth + 1);
      case "list": {
        onlyKeys(entry, ["type", "items"], "unknown_block_field");
        if (!Array.isArray(entry.items) || entry.items.length === 0) throw new RichRefusal("invalid_items");
        for (const item of entry.items) {
          if (!isRecord(item)) throw new RichRefusal("invalid_item");
          onlyKeys(item, ["blocks", "has_checkbox", "is_checked", "value", "type"], "unknown_item_field");
          optionalTrue(item, "has_checkbox");
          optionalTrue(item, "is_checked");
          if (item.value !== undefined && !Number.isSafeInteger(item.value)) throw new RichRefusal("invalid_value");
          if (item.type !== undefined && !LIST_LABELS.has(String(item.type))) throw new RichRefusal("invalid_label");
          level(depth + 2);
          blocks += 1;
          blockList(item.blocks, depth + 2);
        }
        return;
      }
      case "table": {
        onlyKeys(entry, ["type", "cells", "is_bordered", "is_striped", "is_compact", "caption"], "unknown_block_field");
        for (const key of ["is_bordered", "is_striped", "is_compact"]) optionalTrue(entry, key);
        if (entry.caption !== undefined) richText(entry.caption, depth + 1);
        if (!Array.isArray(entry.cells) || entry.cells.length === 0) throw new RichRefusal("invalid_cells");
        for (const row of entry.cells) {
          if (!Array.isArray(row) || row.length === 0) throw new RichRefusal("invalid_row");
          blocks += 1;
          let columns = 0;
          for (const cell of row) {
            if (!isRecord(cell)) throw new RichRefusal("invalid_cell");
            onlyKeys(cell, ["text", "is_header", "colspan", "rowspan", "align", "valign"], "unknown_cell_field");
            optionalTrue(cell, "is_header");
            for (const span of ["colspan", "rowspan"]) {
              if (cell[span] !== undefined && (!Number.isInteger(cell[span]) || (cell[span] as number) < 1)) throw new RichRefusal(`invalid_${span}`);
            }
            if (!ALIGN.has(String(cell.align)) || !VALIGN.has(String(cell.valign))) throw new RichRefusal("invalid_alignment");
            columns += (cell.colspan as number | undefined) ?? 1;
            if (cell.text !== undefined) richText(cell.text, depth + 1);
          }
          if (columns > TELEGRAM_RICH_LIMITS.columns) throw new RichRefusal("too_many_columns");
        }
        return;
      }
      default:
        throw new RichRefusal(`unsupported_block:${entry.type}`);
    }
  };
  try {
    if (!isRecord(value)) throw new RichRefusal("invalid_message");
    for (const forbidden of ["markdown", "html", "media"]) {
      if (Object.hasOwn(value, forbidden)) throw new RichRefusal(`${forbidden}_not_allowed`);
    }
    onlyKeys(value, ["blocks", "skip_entity_detection", "is_rtl"], "unknown_message_field");
    for (const key of ["skip_entity_detection", "is_rtl"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") throw new RichRefusal(`invalid_${key}`);
    }
    blockList(value.blocks, 0);
    if (characters > TELEGRAM_RICH_LIMITS.characters) throw new RichRefusal("too_long");
    if (blocks > TELEGRAM_RICH_LIMITS.blocks) throw new RichRefusal("too_many_blocks");
    return { ok: true, characters, blocks, depth: maxDepth };
  } catch (error) {
    if (error instanceof RichRefusal) return { ok: false, reason: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Model

export type FakeTelegramUser = Readonly<{ id: number; is_bot: false; first_name: string; username?: string }>;
export type FakeTelegramChat = Readonly<{ id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; first_name?: string; username?: string }>;
export type FakeTelegramMessage = {
  message_id: number;
  chat_id: number;
  from: "bot" | "user";
  date: number;
  text?: string;
  caption?: string;
  rich_message?: unknown;
  reply_markup?: unknown;
  reply_to_message_id?: number;
  file_id?: string;
  kind: "text" | "rich" | "document" | "photo" | "voice" | "other";
  edits: number;
};
export type FakeTelegramDraft = {
  chat_id: number; draft_id: number; text?: string; rich_message?: unknown; can_stop?: boolean; keep_on_stop?: boolean; updates: number;
};
export type FakeTelegramFile = Readonly<{ file_id: string; file_unique_id: string; file_path: string; bytes: Buffer; mime_type?: string; file_name?: string }>;
export type FakeTelegramCall = Readonly<{
  method: string;
  params: Readonly<Record<string, unknown>>;
  file?: Readonly<{ field: string; filename: string; contentType: string; size: number }>;
  status: number;
}>;
/** One injected failure: Telegram's own refusal, a dropped connection, or a delay before the normal answer. */
export type FakeTelegramFailure =
  | Readonly<{ status: 429; retryAfter: number }>
  | Readonly<{ status: 400 | 401 | 403 | 404 | 409 | 500 | 502; description?: string }>
  | Readonly<{ drop: true }>
  | Readonly<{ delayMs: number }>;

type Reply = Readonly<{ status: number; body: Buffer; contentType: string }> | "drop";
type UploadedFile = Readonly<{ field: string; bytes: Buffer; filename: string; contentType: string }>;
type RawUpdate = Record<string, unknown> & { update_id: number };
type UserRef = FakeTelegramUser | number;

const DEFAULT_DESCRIPTIONS: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden: bot was blocked by the user", 404: "Not Found",
  409: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
  500: "Internal Server Error", 502: "Bad Gateway"
};

function json(status: number, body: unknown): Reply {
  return { status, body: Buffer.from(JSON.stringify(body)), contentType: "application/json" };
}
function ok(result: unknown): Reply {
  return json(200, { ok: true, result });
}
function refuse(status: number, description = DEFAULT_DESCRIPTIONS[status] ?? "Error", retryAfter?: number): Reply {
  return json(status, {
    ok: false, error_code: status, description, ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } })
  });
}
class BadRequest extends Error {}
const bad = (description: string): never => { throw new BadRequest(`Bad Request: ${description}`); };

const METHOD_KEYS: Record<string, readonly string[]> = {
  getMe: [],
  deleteWebhook: ["drop_pending_updates"],
  getWebhookInfo: [],
  setMyCommands: ["commands", "scope", "language_code"],
  getUpdates: ["offset", "limit", "timeout", "allowed_updates"],
  sendMessage: ["chat_id", "text", "reply_markup", "reply_parameters", "link_preview_options"],
  sendRichMessage: ["chat_id", "rich_message", "reply_markup", "reply_parameters"],
  sendMessageDraft: ["chat_id", "draft_id", "text", "can_stop", "keep_on_stop"],
  sendRichMessageDraft: ["chat_id", "draft_id", "rich_message", "can_stop", "keep_on_stop"],
  editMessageText: ["chat_id", "message_id", "text", "rich_message", "reply_markup", "link_preview_options"],
  editMessageReplyMarkup: ["chat_id", "message_id", "reply_markup"],
  answerCallbackQuery: ["callback_query_id", "text", "show_alert"],
  sendChatAction: ["chat_id", "action"],
  sendDocument: ["chat_id", "document", "caption", "reply_markup", "reply_parameters"],
  sendPhoto: ["chat_id", "photo", "caption", "reply_markup", "reply_parameters"],
  getFile: ["file_id"],
  leaveChat: ["chat_id"]
};

export function createFakeTelegramBotApi(options: Readonly<{ token?: string; now?: () => number }> = {}) {
  const token = options.token ?? FAKE_TELEGRAM_TOKEN;
  const clock = options.now ?? Date.now;
  const seconds = () => Math.floor(clock() / 1_000);
  const bot = Object.freeze({ ...FAKE_TELEGRAM_BOT, id: Number(token.split(":")[0]), is_bot: true as const });
  const botUser = { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username };

  const users = new Map<number, FakeTelegramUser>();
  const chats = new Map<number, FakeTelegramChat>();
  const messages = new Map<number, Map<number, FakeTelegramMessage>>();
  const nextMessageId = new Map<number, number>();
  const drafts = new Map<string, FakeTelegramDraft>();
  const files = new Map<string, FakeTelegramFile>();
  const filesByPath = new Map<string, FakeTelegramFile>();
  const callbackQueries = new Map<string, { answered: boolean; text?: string; show_alert?: boolean }>();
  const leftChats = new Set<number>();
  const recorded: FakeTelegramCall[] = [];
  const failures = new Map<string, FakeTelegramFailure[]>();
  let commands: unknown[] = [];
  let webhookUrl = "";
  let queue: RawUpdate[] = [];
  let nextUpdateId = 1_000;
  let nextUserId = 200_000_001;
  let nextGroupId = -1_000_000_000_001;
  let nextFile = 1;
  let nextCallback = 1;
  let poll: { settle: (reply: Reply) => void; wake: () => void } | undefined;
  let allowedUpdates: readonly string[] | undefined;
  const servers = new Set<{ close: () => Promise<void> }>();

  function messageStore(chatId: number) {
    let store = messages.get(chatId);
    if (!store) { store = new Map(); messages.set(chatId, store); }
    return store;
  }
  function addMessage(chatId: number, message: Omit<FakeTelegramMessage, "message_id" | "chat_id" | "date" | "edits">): FakeTelegramMessage {
    const id = nextMessageId.get(chatId) ?? 1;
    nextMessageId.set(chatId, id + 1);
    const stored: FakeTelegramMessage = { ...message, message_id: id, chat_id: chatId, date: seconds(), edits: 0 };
    messageStore(chatId).set(id, stored);
    return stored;
  }
  function chatWire(chatId: number): FakeTelegramChat {
    return chats.get(chatId) ?? { id: chatId, type: chatId > 0 ? "private" : "group" };
  }
  function userOf(ref: UserRef): FakeTelegramUser {
    const user = users.get(typeof ref === "number" ? ref : ref.id);
    if (!user) throw new Error("fake Telegram user not added");
    return user;
  }
  function userWire(user: FakeTelegramUser) {
    return { id: user.id, is_bot: false, first_name: user.first_name, ...(user.username ? { username: user.username } : {}) };
  }
  function registerFile(bytes: Buffer, folder: string, extension: string, extra: { mime_type?: string; file_name?: string } = {}): FakeTelegramFile {
    const index = nextFile++;
    const file: FakeTelegramFile = {
      file_id: `FAKEFILE${String(index).padStart(6, "0")}`, file_unique_id: `U${index}`, file_path: `${folder}/file_${index}.${extension}`,
      bytes, ...extra
    };
    files.set(file.file_id, file);
    filesByPath.set(file.file_path, file);
    return file;
  }

  // -- updates --------------------------------------------------------------

  function enqueue(body: Record<string, unknown>): RawUpdate {
    const update = { update_id: nextUpdateId++, ...body };
    queue.push(update);
    poll?.wake();
    return update;
  }
  function inboundMessage(user: FakeTelegramUser, fields: Record<string, unknown>, kind: FakeTelegramMessage["kind"]) {
    const stored = addMessage(user.id, {
      from: "user", kind,
      ...(typeof fields.text === "string" ? { text: fields.text } : {}),
      ...(typeof fields.caption === "string" ? { caption: fields.caption } : {})
    });
    const reply = typeof fields.reply_to_message_id === "number" ? messageStore(user.id).get(fields.reply_to_message_id) : undefined;
    const { reply_to_message_id: _reply, ...rest } = fields;
    return {
      message_id: stored.message_id, from: userWire(user), chat: chatWire(user.id), date: stored.date, ...rest,
      ...(reply ? { reply_to_message: messageWire(reply) } : {})
    };
  }
  function messageWire(message: FakeTelegramMessage): Record<string, unknown> {
    const user = users.get(message.chat_id);
    return {
      message_id: message.message_id, date: message.date, chat: chatWire(message.chat_id),
      from: message.from === "bot" ? botUser : user ? userWire(user) : botUser,
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.caption !== undefined ? { caption: message.caption } : {}),
      ...(message.reply_markup !== undefined ? { reply_markup: message.reply_markup } : {})
    };
  }
  function photoSizes(bytes: Buffer) {
    const small = registerFile(bytes, "photos", "jpg", { mime_type: "image/jpeg" });
    const large = registerFile(bytes, "photos", "jpg", { mime_type: "image/jpeg" });
    return [
      { file_id: small.file_id, file_unique_id: small.file_unique_id, width: 90, height: 90, file_size: bytes.length },
      { file_id: large.file_id, file_unique_id: large.file_unique_id, width: 16, height: 16, file_size: bytes.length }
    ];
  }

  const inject = {
    /** Adds a Telegram user with a private chat to the bot. */
    addUser(input: Readonly<{ id?: number; firstName?: string; username?: string }> = {}): FakeTelegramUser {
      const user: FakeTelegramUser = {
        id: input.id ?? nextUserId++, is_bot: false, first_name: input.firstName ?? "Test",
        ...(input.username ? { username: input.username } : {})
      };
      users.set(user.id, user);
      chats.set(user.id, { id: user.id, type: "private", first_name: user.first_name, ...(user.username ? { username: user.username } : {}) });
      return user;
    },
    text(user: UserRef, text: string, opts: Readonly<{ replyTo?: number }> = {}) {
      const owner = userOf(user);
      return enqueue({ message: inboundMessage(owner, { text, ...(opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}) }, "text") });
    },
    command(user: UserRef, command: string, args?: string) {
      const owner = userOf(user);
      const text = args ? `/${command} ${args}` : `/${command}`;
      return enqueue({ message: inboundMessage(owner, { text, entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }] }, "text") });
    },
    voice(user: UserRef, opts: Readonly<{ duration?: number; bytes?: Buffer; declaredSize?: number; caption?: string }> = {}) {
      const owner = userOf(user);
      const bytes = opts.bytes ?? telegramVoiceFixture();
      const file = registerFile(bytes, "voice", "oga", { mime_type: "audio/ogg" });
      return enqueue({ message: inboundMessage(owner, {
        voice: { file_id: file.file_id, file_unique_id: file.file_unique_id, duration: opts.duration ?? 1, mime_type: "audio/ogg",
          file_size: opts.declaredSize ?? bytes.length },
        ...(opts.caption ? { caption: opts.caption } : {})
      }, "voice") });
    },
    photo(user: UserRef, opts: Readonly<{ caption?: string; mediaGroupId?: string; bytes?: Buffer }> = {}) {
      const owner = userOf(user);
      return enqueue({ message: inboundMessage(owner, {
        photo: photoSizes(opts.bytes ?? telegramPhotoFixture()),
        ...(opts.caption ? { caption: opts.caption } : {}), ...(opts.mediaGroupId ? { media_group_id: opts.mediaGroupId } : {})
      }, "photo") });
    },
    document(user: UserRef, input: Readonly<{ fileName: string; mimeType: string; bytes: Buffer; caption?: string; mediaGroupId?: string }>) {
      const owner = userOf(user);
      const extension = path.extname(input.fileName).slice(1).replace(/[^A-Za-z0-9]/gu, "") || "bin";
      const file = registerFile(input.bytes, "documents", extension, { mime_type: input.mimeType, file_name: input.fileName });
      return enqueue({ message: inboundMessage(owner, {
        document: { file_id: file.file_id, file_unique_id: file.file_unique_id, file_name: input.fileName, mime_type: input.mimeType,
          file_size: input.bytes.length },
        ...(input.caption ? { caption: input.caption } : {}), ...(input.mediaGroupId ? { media_group_id: input.mediaGroupId } : {})
      }, "document") });
    },
    /** Photos sharing one `media_group_id`, the caption on the first, as Telegram delivers an album. */
    album(user: UserRef, count: number, opts: Readonly<{ caption?: string }> = {}) {
      const group = `album${nextUpdateId}`;
      return Array.from({ length: count }, (_, index) => inject.photo(user, { mediaGroupId: group, ...(index === 0 && opts.caption ? { caption: opts.caption } : {}) }));
    },
    sticker(user: UserRef) {
      const owner = userOf(user);
      return enqueue({ message: inboundMessage(owner, { sticker: { file_id: "STICKER", file_unique_id: "S", type: "regular", width: 1, height: 1, is_animated: false, is_video: false } }, "other") });
    },
    /** A press on an inline button of a bot message. */
    callback(user: UserRef, messageId: number, data: string) {
      const owner = userOf(user);
      const message = messageStore(owner.id).get(messageId);
      const id = `CBQ${nextCallback++}`;
      callbackQueries.set(id, { answered: false });
      return enqueue({ callback_query: {
        id, from: userWire(owner), chat_instance: `CI${owner.id}`, data,
        message: message ? messageWire(message) : { message_id: messageId, chat: chatWire(owner.id), date: 0 }
      } });
    },
    stopGeneration(user: UserRef, draftId: number) {
      const owner = userOf(user);
      return enqueue({ stopped_message_generation: { chat: chatWire(owner.id), draft_id: draftId } });
    },
    /** The bot added to a group by `user`. */
    addedToGroup(user: UserRef, opts: Readonly<{ title?: string; type?: "group" | "supergroup" | "channel" }> = {}) {
      const owner = userOf(user);
      const chat: FakeTelegramChat = { id: nextGroupId--, type: opts.type ?? "group", title: opts.title ?? "Test group" };
      chats.set(chat.id, chat);
      return enqueue({ my_chat_member: {
        chat, from: userWire(owner), date: seconds(),
        old_chat_member: { status: "left", user: botUser }, new_chat_member: { status: "member", user: botUser }
      } });
    },
    editedMessage(user: UserRef, messageId: number, text: string) {
      const owner = userOf(user);
      const message = messageStore(owner.id).get(messageId);
      if (message) { message.text = text; message.edits += 1; }
      return enqueue({ edited_message: {
        message_id: messageId, from: userWire(owner), chat: chatWire(owner.id), date: message?.date ?? seconds(), edit_date: seconds(), text
      } });
    },
    /** Any raw update body; the fake assigns `update_id`. */
    raw(body: Record<string, unknown>) {
      return enqueue(body);
    }
  };

  // -- methods --------------------------------------------------------------

  function chatId(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return bad("chat_id is invalid");
    if (!chats.has(value) || leftChats.has(value)) return bad("chat not found");
    return value as number;
  }
  function plainText(value: unknown, min: number): string {
    if (typeof value !== "string") return bad("message text is empty");
    if (value.length > TELEGRAM_TEXT_MAX_LENGTH) return bad("message is too long");
    if (value.trim().length < min) return bad("message text is empty");
    return value;
  }
  function richMessage(value: unknown): unknown {
    const result = validateTelegramRichMessage(value);
    if (!result.ok) bad(`RICH_MESSAGE_INVALID ${result.reason}`);
    return value;
  }
  function draftId(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) return bad("draft_id is invalid");
    return value as number;
  }
  function privateChat(id: number): void {
    if (chatWire(id).type !== "private") bad("drafts can be sent only to private chats");
  }
  function replyMarkup(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (!isRecord(value) || !Array.isArray(value.inline_keyboard)) return bad("reply markup is invalid");
    for (const key of Object.keys(value)) if (key !== "inline_keyboard") bad("reply markup is invalid");
    for (const row of value.inline_keyboard as unknown[]) {
      if (!Array.isArray(row)) bad("reply markup is invalid");
      for (const button of row as unknown[]) {
        if (!isRecord(button) || typeof button.text !== "string" || !button.text.trim()) bad("BUTTON_TEXT_INVALID");
        const entry = button as Record<string, unknown>;
        for (const key of Object.keys(entry)) if (!["text", "callback_data", "url"].includes(key)) bad("BUTTON_TYPE_INVALID");
        if ((entry.callback_data === undefined) === (entry.url === undefined)) bad("BUTTON_TYPE_INVALID");
        if (entry.callback_data !== undefined) {
          const bytes = typeof entry.callback_data === "string" ? Buffer.byteLength(entry.callback_data, "utf8") : 0;
          if (bytes < 1 || bytes > 64) bad("BUTTON_DATA_INVALID");
        }
        if (entry.url !== undefined) {
          try { if (!["http:", "https:"].includes(new URL(String(entry.url)).protocol)) bad("BUTTON_URL_INVALID"); }
          catch (error) { if (error instanceof BadRequest) throw error; bad("BUTTON_URL_INVALID"); }
        }
      }
    }
    return value;
  }
  function replyTarget(chat: number, value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || typeof value.message_id !== "number") return bad("reply parameters are invalid");
    if (!messageStore(chat).has(value.message_id) && value.allow_sending_without_reply !== true) bad("message to be replied not found");
    return value.message_id as number;
  }
  function botMessage(chat: number, id: unknown): FakeTelegramMessage {
    const message = typeof id === "number" ? messageStore(chat).get(id) : undefined;
    if (!message || message.from !== "bot") return bad("message to edit not found");
    return message as FakeTelegramMessage;
  }
  async function sendFile(method: "sendDocument" | "sendPhoto", params: Record<string, unknown>, upload?: UploadedFile): Promise<Reply> {
    const chat = chatId(params.chat_id);
    if (!upload) return bad("there is no file in the request");
    const limit = method === "sendPhoto" ? PHOTO_UPLOAD_MAX_BYTES : TELEGRAM_UPLOAD_MAX_BYTES;
    if (upload.bytes.length > limit) return refuse(413, "Request Entity Too Large");
    if (params.caption !== undefined && (typeof params.caption !== "string" || params.caption.length > TELEGRAM_CAPTION_MAX_LENGTH)) {
      bad("message caption is too long");
    }
    const markup = replyMarkup(params.reply_markup);
    const replyTo = replyTarget(chat, params.reply_parameters);
    const file = method === "sendPhoto"
      ? registerFile(upload.bytes, "photos", "jpg", { mime_type: upload.contentType })
      : registerFile(upload.bytes, "documents", path.extname(upload.filename).slice(1).replace(/[^A-Za-z0-9]/gu, "") || "bin",
        { mime_type: upload.contentType, file_name: upload.filename });
    const message = addMessage(chat, {
      from: "bot", kind: method === "sendPhoto" ? "photo" : "document", file_id: file.file_id,
      ...(typeof params.caption === "string" ? { caption: params.caption } : {}),
      ...(markup ? { reply_markup: markup } : {}), ...(replyTo ? { reply_to_message_id: replyTo } : {})
    });
    return ok({
      ...messageWire(message),
      ...(method === "sendPhoto"
        ? { photo: [{ file_id: file.file_id, file_unique_id: file.file_unique_id, width: 16, height: 16, file_size: upload.bytes.length }] }
        : { document: { file_id: file.file_id, file_unique_id: file.file_unique_id, file_name: upload.filename, mime_type: upload.contentType, file_size: upload.bytes.length } })
    });
  }

  function getUpdates(params: Record<string, unknown>): Promise<Reply> | Reply {
    if (webhookUrl) return refuse(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
    poll?.settle(refuse(409));
    poll = undefined;
    const offset = typeof params.offset === "number" ? params.offset : undefined;
    const limit = typeof params.limit === "number" ? Math.min(Math.max(params.limit, 1), 100) : 100;
    const timeoutSeconds = typeof params.timeout === "number" ? Math.max(0, params.timeout) : 0;
    if (Array.isArray(params.allowed_updates)) allowedUpdates = params.allowed_updates.filter((entry): entry is string => typeof entry === "string");
    if (offset !== undefined) queue = queue.filter((update) => update.update_id >= offset);
    const available = () => {
      const allowed = allowedUpdates;
      if (allowed && allowed.length > 0) {
        queue = queue.filter((update) => allowed.includes(Object.keys(update).find((key) => key !== "update_id") ?? ""));
      }
      return queue.slice(0, limit);
    };
    const ready = available();
    if (ready.length > 0 || timeoutSeconds === 0) return ok(ready);
    return new Promise<Reply>((settle) => {
      const timer = setTimeout(() => finish(ok([])), timeoutSeconds * 1_000);
      const entry = {
        settle: (reply: Reply) => finish(reply),
        wake: () => { const next = available(); if (next.length > 0) finish(ok(next)); }
      };
      function finish(reply: Reply): void {
        clearTimeout(timer);
        if (poll === entry) poll = undefined;
        settle(reply);
      }
      poll = entry;
    });
  }

  async function dispatch(method: string, params: Record<string, unknown>, upload?: UploadedFile): Promise<Reply> {
    switch (method) {
      case "getMe":
        return ok({ ...botUser, can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false });
      case "deleteWebhook":
        webhookUrl = "";
        if (params.drop_pending_updates === true) queue = [];
        return ok(true);
      case "getWebhookInfo":
        return ok({ url: webhookUrl, has_custom_certificate: false, pending_update_count: queue.length });
      case "setMyCommands": {
        const list = params.commands;
        if (!Array.isArray(list) || list.length > 100) return bad("commands are invalid");
        for (const entry of list) {
          if (!isRecord(entry) || typeof entry.command !== "string" || !/^[a-z0-9_]{1,32}$/u.test(entry.command)
            || typeof entry.description !== "string" || entry.description.length < 1 || entry.description.length > 256) {
            bad("BOT_COMMAND_INVALID");
          }
        }
        commands = list;
        return ok(true);
      }
      case "getUpdates":
        return getUpdates(params);
      case "sendMessage": {
        const chat = chatId(params.chat_id);
        const text = plainText(params.text, 1);
        const markup = replyMarkup(params.reply_markup);
        const replyTo = replyTarget(chat, params.reply_parameters);
        const message = addMessage(chat, { from: "bot", kind: "text", text, ...(markup ? { reply_markup: markup } : {}), ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
        return ok(messageWire(message));
      }
      case "sendRichMessage": {
        const chat = chatId(params.chat_id);
        const rich = richMessage(params.rich_message);
        const markup = replyMarkup(params.reply_markup);
        const replyTo = replyTarget(chat, params.reply_parameters);
        const message = addMessage(chat, { from: "bot", kind: "rich", rich_message: rich, ...(markup ? { reply_markup: markup } : {}), ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
        return ok(messageWire(message));
      }
      case "sendMessageDraft":
      case "sendRichMessageDraft": {
        const chat = chatId(params.chat_id);
        privateChat(chat);
        const id = draftId(params.draft_id);
        for (const flag of ["can_stop", "keep_on_stop"]) if (params[flag] !== undefined && typeof params[flag] !== "boolean") bad(`${flag} is invalid`);
        const content = method === "sendMessageDraft"
          ? { text: params.text === undefined ? "" : plainText(params.text, 0) }
          : { rich_message: richMessage(params.rich_message) };
        const key = `${chat}:${id}`;
        const previous = drafts.get(key);
        drafts.set(key, {
          chat_id: chat, draft_id: id, ...content, updates: (previous?.updates ?? 0) + 1,
          ...(params.can_stop !== undefined ? { can_stop: params.can_stop as boolean } : {}),
          ...(params.keep_on_stop !== undefined ? { keep_on_stop: params.keep_on_stop as boolean } : {})
        });
        return ok(true);
      }
      case "editMessageText": {
        const chat = chatId(params.chat_id);
        const message = botMessage(chat, params.message_id);
        if ((params.text === undefined) === (params.rich_message === undefined)) bad("exactly one of text and rich_message is required");
        const markup = replyMarkup(params.reply_markup);
        const next = params.text !== undefined ? { text: plainText(params.text, 1) } : { rich_message: richMessage(params.rich_message) };
        const same = JSON.stringify(next.text ?? next.rich_message) === JSON.stringify(message.text ?? message.rich_message)
          && JSON.stringify(markup) === JSON.stringify(message.reply_markup);
        if (same) bad("message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
        message.text = next.text;
        message.rich_message = next.rich_message;
        message.kind = next.text !== undefined ? "text" : "rich";
        message.reply_markup = markup;
        message.edits += 1;
        return ok(messageWire(message));
      }
      case "editMessageReplyMarkup": {
        const chat = chatId(params.chat_id);
        const message = botMessage(chat, params.message_id);
        const markup = replyMarkup(params.reply_markup);
        if (JSON.stringify(markup) === JSON.stringify(message.reply_markup)) bad("message is not modified");
        message.reply_markup = markup;
        message.edits += 1;
        return ok(messageWire(message));
      }
      case "answerCallbackQuery": {
        const query = typeof params.callback_query_id === "string" ? callbackQueries.get(params.callback_query_id) : undefined;
        if (!query || query.answered) return bad("query is too old and response timeout expired or query ID is invalid");
        if (params.text !== undefined && (typeof params.text !== "string" || params.text.length > 200)) bad("text is too long");
        query.answered = true;
        query.text = params.text as string | undefined;
        query.show_alert = params.show_alert as boolean | undefined;
        return ok(true);
      }
      case "sendChatAction":
        chatId(params.chat_id);
        if (!["typing", "upload_photo", "upload_document", "record_voice", "upload_voice"].includes(String(params.action))) bad("wrong parameter action in request");
        return ok(true);
      case "sendDocument":
      case "sendPhoto":
        return sendFile(method, params, upload);
      case "getFile": {
        const file = typeof params.file_id === "string" ? files.get(params.file_id) : undefined;
        if (!file) return bad("invalid file_id");
        const found = file as FakeTelegramFile;
        if (found.bytes.length > TELEGRAM_DOWNLOAD_MAX_BYTES) return bad("file is too big");
        return ok({ file_id: found.file_id, file_unique_id: found.file_unique_id, file_size: found.bytes.length, file_path: found.file_path });
      }
      case "leaveChat": {
        const chat = chatId(params.chat_id);
        leftChats.add(chat);
        return ok(true);
      }
      default:
        return refuse(404, "Not Found");
    }
  }

  // -- HTTP surface ---------------------------------------------------------

  async function readParams(request: Request): Promise<{ params: Record<string, unknown>; upload?: UploadedFile } | undefined> {
    const type = request.headers.get("content-type") ?? "";
    if (request.method !== "POST") return { params: Object.fromEntries(new URL(request.url).searchParams) };
    if (type.startsWith("application/json")) {
      const body: unknown = await request.json().catch(() => undefined);
      return isRecord(body) ? { params: body } : undefined;
    }
    if (type.startsWith("multipart/form-data")) {
      const form = await request.formData().catch(() => undefined);
      if (!form) return undefined;
      const params: Record<string, unknown> = {};
      let upload: UploadedFile | undefined;
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          if (["reply_markup", "reply_parameters"].includes(key)) {
            try { params[key] = JSON.parse(value) as unknown; } catch { return undefined; }
          } else {
            params[key] = key === "chat_id" && /^-?\d+$/u.test(value) ? Number(value) : value;
          }
        } else {
          upload = { field: key, bytes: Buffer.from(await value.arrayBuffer()), filename: value.name, contentType: value.type };
          params[key] = "<file>";
        }
      }
      return { params, upload };
    }
    const text = await request.text();
    return text ? undefined : { params: {} };
  }

  async function handle(request: Request): Promise<Reply> {
    const url = new URL(request.url);
    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/u.exec(url.pathname);
    if (fileMatch) {
      if (fileMatch[1] !== token) return refuse(401);
      const filePath = decodeURIComponent(fileMatch[2]!);
      const failure = takeFailure("file");
      const early = failure ? await applyFailure(failure) : undefined;
      const file = filesByPath.get(filePath);
      const reply: Reply = early ?? (file
        ? { status: 200, body: file.bytes, contentType: file.mime_type ?? "application/octet-stream" } : refuse(404, "Not Found"));
      recorded.push({ method: "file", params: { file_path: filePath }, status: reply === "drop" ? 0 : reply.status });
      return reply;
    }
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(url.pathname);
    if (!match) return refuse(404, "Not Found");
    if (match[1] !== token) return refuse(401);
    const method = match[2]!;
    const parsed = await readParams(request);
    if (!parsed) return refuse(400, "Bad Request: invalid request body");
    const record = (status: number) => recorded.push({
      method, params: parsed.params, status,
      ...(parsed.upload ? { file: { field: parsed.upload.field, filename: parsed.upload.filename, contentType: parsed.upload.contentType, size: parsed.upload.bytes.length } } : {})
    });
    const failure = takeFailure(method);
    if (failure) {
      const early = await applyFailure(failure);
      if (early) { record(early === "drop" ? 0 : early.status); return early; }
    }
    const allowed = METHOD_KEYS[method];
    let reply: Reply;
    try {
      if (allowed) for (const key of Object.keys(parsed.params)) if (!allowed.includes(key)) bad(`unexpected parameter ${key}`);
      reply = await dispatch(method, parsed.params, parsed.upload);
    } catch (error) {
      if (!(error instanceof BadRequest)) throw error;
      reply = refuse(400, error.message);
    }
    record(reply === "drop" ? 0 : reply.status);
    return reply;
  }

  function takeFailure(method: string): FakeTelegramFailure | undefined {
    const list = failures.get(method);
    const next = list?.shift();
    if (list && list.length === 0) failures.delete(method);
    return next;
  }
  async function applyFailure(failure: FakeTelegramFailure): Promise<Reply | undefined> {
    if ("drop" in failure) return "drop";
    if ("delayMs" in failure) { await new Promise((resolve) => setTimeout(resolve, failure.delayMs)); return undefined; }
    return failure.status === 429
      ? refuse(429, `Too Many Requests: retry after ${failure.retryAfter}`, failure.retryAfter)
      : refuse(failure.status, failure.description);
  }

  /** Fetch handler for vitest; a dropped connection rejects like undici. */
  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const reply = await handle(new Request(input, init));
    if (reply === "drop") throw new TypeError("fetch failed");
    return new Response(new Uint8Array(reply.body), { status: reply.status, headers: { "content-type": reply.contentType } });
  }

  /** The production transport contract over `fetch`, with the same deadlines and bounds. */
  const transport: TelegramTransport = Object.freeze({
    call: ({ token: callToken, method, params }) => postJson(callToken, method, params, TELEGRAM_JSON_TIMEOUT_MS),
    longPoll: ({ token: callToken, method, params, pollTimeoutSeconds }) =>
      postJson(callToken, method, params, pollTimeoutSeconds * 1_000 + TELEGRAM_LONG_POLL_GRACE_MS),
    upload: async ({ token: callToken, method, fields, file }) => {
      const bytes = "data" in file ? file.data : await readStream(file.stream);
      if (bytes.length > TELEGRAM_UPLOAD_MAX_BYTES) return { ok: false, kind: "too_large" } as const;
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      form.set(file.field, new Blob([new Uint8Array(bytes)], { type: file.contentType }), file.filename);
      return exchange(`${FAKE_TELEGRAM_ORIGIN}/bot${callToken}/${method}`, { method: "POST", body: form }, TELEGRAM_FILE_TIMEOUT_MS,
        TELEGRAM_JSON_RESPONSE_MAX_BYTES).then((result) => result.ok ? telegramOutcomeFromResponse(result.status, result.body) : result);
    },
    download: async ({ token: callToken, filePath, maxBytes }) => {
      const result = await exchange(`${FAKE_TELEGRAM_ORIGIN}/file/bot${callToken}/${filePath}`, { method: "GET" }, TELEGRAM_FILE_TIMEOUT_MS,
        Math.min(maxBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES, TELEGRAM_DOWNLOAD_MAX_BYTES));
      if (!result.ok) return result;
      if (result.status === 200) return { ok: true, result: result.body };
      const failure = telegramOutcomeFromResponse(result.status, result.body);
      return failure.ok ? { ok: false, kind: "http", status: result.status } : failure;
    }
  });

  function postJson(callToken: string, method: string, params: Readonly<Record<string, unknown>> | undefined, timeoutMs: number) {
    return exchange(`${FAKE_TELEGRAM_ORIGIN}/bot${callToken}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params ?? {})
    }, timeoutMs, TELEGRAM_JSON_RESPONSE_MAX_BYTES).then((result) => result.ok ? telegramOutcomeFromResponse(result.status, result.body) : result);
  }

  async function exchange(
    url: string, init: RequestInit, timeoutMs: number, maxBytes: number
  ): Promise<Readonly<{ ok: true; status: number; body: Buffer }> | Exclude<TelegramOutcome<never>, { ok: true }>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const response = await Promise.race([fakeFetch(url, init), deadline]);
      if (response === "timeout") return { ok: false, kind: "timeout" };
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > maxBytes) return { ok: false, kind: "too_large", status: response.status };
      return { ok: true, status: response.status, body };
    } catch {
      return { ok: false, kind: "network_after_send", category: "reset" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A loopback HTTP server over the same model, for Playwright and stands. */
  async function start(): Promise<Readonly<{ origin: string; close: () => Promise<void> }>> {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += (chunk as Buffer).length;
          if (size > TELEGRAM_UPLOAD_MAX_BYTES + 1024 * 1024) { request.socket.destroy(); return; }
          chunks.push(chunk as Buffer);
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
        const reply = await handle(new Request(`${FAKE_TELEGRAM_ORIGIN}${request.url ?? "/"}`, {
          method: request.method, headers, ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {})
        }));
        if (reply === "drop") { request.socket.destroy(); return; }
        response.writeHead(reply.status, { "content-type": reply.contentType, "content-length": String(reply.body.length) });
        response.end(reply.body);
      })().catch(() => { response.statusCode = 500; response.end(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const handleEntry = {
      close: () => new Promise<void>((resolve) => {
        servers.delete(handleEntry);
        poll?.settle(ok([]));
        server.closeAllConnections();
        server.close(() => resolve());
      })
    };
    servers.add(handleEntry);
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: handleEntry.close };
  }

  return {
    token,
    bot,
    fetch: fakeFetch,
    transport,
    start,
    inject,
    /** Fails the next `times` calls of `method` (`"file"` for downloads). */
    failNext(method: string, failure: FakeTelegramFailure, times = 1): void {
      const list = failures.get(method) ?? [];
      for (let index = 0; index < times; index += 1) list.push(failure);
      failures.set(method, list);
    },
    setWebhook(url: string): void { webhookUrl = url; },
    calls(method?: string): readonly FakeTelegramCall[] {
      return method ? recorded.filter((call) => call.method === method) : [...recorded];
    },
    lastCall(method: string): FakeTelegramCall | undefined {
      return recorded.filter((call) => call.method === method).at(-1);
    },
    clearCalls(): void { recorded.length = 0; },
    messages(chat: number): readonly FakeTelegramMessage[] { return [...messageStore(chat).values()]; },
    botMessages(chat: number): readonly FakeTelegramMessage[] { return [...messageStore(chat).values()].filter((message) => message.from === "bot"); },
    drafts(chat: number): readonly FakeTelegramDraft[] { return [...drafts.values()].filter((draft) => draft.chat_id === chat); },
    file(fileId: string): FakeTelegramFile | undefined { return files.get(fileId); },
    callbackAnswer(id: string) { return callbackQueries.get(id); },
    commands: () => commands,
    leftChats: () => [...leftChats],
    pendingUpdates: () => queue.length,
    async close(): Promise<void> { for (const entry of [...servers]) await entry.close(); poll?.settle(ok([])); }
  };
}

export type FakeTelegramBotApi = ReturnType<typeof createFakeTelegramBotApi>;

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
