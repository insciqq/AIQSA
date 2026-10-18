import { z } from "zod";
import { logEvent } from "../observability";
import { TELEGRAM_RATE_LIMITED_CODE } from "./codes";
import type { TelegramFailure, TelegramOutcome, TelegramTransport, TelegramUploadFile } from "./transport";

/**
 * A typed minimal Bot API client over the pinned transport. It knows only the
 * methods and fields AIQSA uses; every inbound field the server relies on is
 * validated and bounded here. Sends are paced per chat and per bot, and one
 * 429 per call is waited out once. The token stays inside this closure.
 */

// ---------------------------------------------------------------------------
// Inbound types (validated)

const MAX_ID = Number.MAX_SAFE_INTEGER;
/** Telegram user and chat ids have at most 52 significant bits; anything else is refused. */
const telegramId = z.number().int().min(-MAX_ID).max(MAX_ID);
const positiveId = z.number().int().min(1).max(MAX_ID);
const count = z.number().int().min(0).max(MAX_ID);
const bounded = (max: number) => z.string().max(max);

export const TELEGRAM_INBOUND_TEXT_MAX_LENGTH = 8_192;
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const userSchema = z.object({
  id: positiveId,
  is_bot: z.boolean(),
  first_name: bounded(256),
  last_name: bounded(256).optional(),
  username: bounded(64).optional(),
  language_code: bounded(35).optional()
});
export type TelegramUser = z.infer<typeof userSchema>;

const botUserSchema = userSchema.extend({
  username: z.string().min(1).max(64),
  can_join_groups: z.boolean().optional()
});
export type TelegramBotUser = z.infer<typeof botUserSchema>;

const chatSchema = z.object({
  id: telegramId,
  /** `private`, `group`, `supergroup` or `channel`. */
  type: bounded(32),
  title: bounded(256).optional(),
  username: bounded(64).optional(),
  first_name: bounded(256).optional()
});
export type TelegramChat = z.infer<typeof chatSchema>;

const fileFields = {
  file_id: z.string().min(1).max(512),
  file_unique_id: z.string().min(1).max(128),
  file_size: count.optional()
};
const voiceSchema = z.object({ ...fileFields, duration: count, mime_type: bounded(255).optional() });
const audioSchema = z.object({
  ...fileFields, duration: count, mime_type: bounded(255).optional(), file_name: bounded(1_024).optional()
});
const documentSchema = z.object({ ...fileFields, file_name: bounded(1_024).optional(), mime_type: bounded(255).optional() });
const photoSizeSchema = z.object({ ...fileFields, width: count, height: count });
export type TelegramVoice = z.infer<typeof voiceSchema>;
export type TelegramAudio = z.infer<typeof audioSchema>;
export type TelegramDocument = z.infer<typeof documentSchema>;
export type TelegramPhotoSize = z.infer<typeof photoSizeSchema>;

/** Message content AIQSA does not accept (answered with `telegram_unsupported_message`). */
const OTHER_CONTENT_KEYS = [
  "animation", "sticker", "video", "video_note", "contact", "location", "venue", "poll", "dice", "game", "story",
  "paid_media", "checklist", "invoice", "live_photo"
] as const;

const messageFields = {
  message_id: positiveId,
  message_thread_id: telegramId.optional(),
  from: userSchema.optional(),
  chat: chatSchema,
  date: count,
  edit_date: count.optional(),
  media_group_id: bounded(128).optional(),
  text: bounded(TELEGRAM_INBOUND_TEXT_MAX_LENGTH).optional(),
  caption: bounded(TELEGRAM_INBOUND_TEXT_MAX_LENGTH).optional(),
  voice: voiceSchema.optional(),
  audio: audioSchema.optional(),
  document: documentSchema.optional(),
  photo: z.array(photoSizeSchema).max(20).optional(),
  /** True when the message carries content AIQSA does not accept (sticker, video, …). */
  has_other_content: z.boolean()
};
function withOtherContent(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { ...raw, has_other_content: OTHER_CONTENT_KEYS.some((key) => Object.hasOwn(raw, key)) };
}
const repliedMessageSchema = z.preprocess(withOtherContent, z.object(messageFields));
const messageSchema = z.preprocess(withOtherContent, z.object({ ...messageFields, reply_to_message: repliedMessageSchema.optional() }));
export type TelegramRepliedMessage = z.infer<typeof repliedMessageSchema>;
export type TelegramMessage = z.infer<typeof messageSchema>;

const callbackData = z.string().min(1).max(TELEGRAM_CALLBACK_DATA_MAX_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES);
const callbackQuerySchema = z.object({
  id: z.string().min(1).max(128),
  from: userSchema,
  /** Only the identity of the message carrying the button (it may be inaccessible). */
  message: z.object({ message_id: positiveId, chat: chatSchema }).optional(),
  chat_instance: bounded(128),
  data: callbackData.optional()
});
export type TelegramCallbackQuery = z.infer<typeof callbackQuerySchema>;

const chatMemberSchema = z.object({ status: bounded(32), user: userSchema });
const chatMemberUpdatedSchema = z.object({
  chat: chatSchema, from: userSchema, date: count, old_chat_member: chatMemberSchema, new_chat_member: chatMemberSchema
});
export type TelegramChatMemberUpdated = z.infer<typeof chatMemberUpdatedSchema>;

const messageGenerationStoppedSchema = z.object({
  chat: chatSchema, message_thread_id: telegramId.optional(), draft_id: telegramId.refine((value) => value !== 0)
});
export type TelegramMessageGenerationStopped = z.infer<typeof messageGenerationStoppedSchema>;

/**
 * One update. `other` is an update type AIQSA does not handle; `invalid` is a
 * handled type whose fields failed validation. Both still carry `update_id`
 * so the poller confirms them instead of losing its offset.
 */
export type TelegramUpdate = Readonly<{ update_id: number }> & (
  | Readonly<{ kind: "message" | "edited_message"; message: TelegramMessage }>
  | Readonly<{ kind: "callback_query"; callback_query: TelegramCallbackQuery }>
  | Readonly<{ kind: "my_chat_member"; my_chat_member: TelegramChatMemberUpdated }>
  | Readonly<{ kind: "stopped_message_generation"; stopped_message_generation: TelegramMessageGenerationStopped }>
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "invalid" }>
);

export const TELEGRAM_ALLOWED_UPDATES = [
  "message", "edited_message", "callback_query", "my_chat_member", "stopped_message_generation"
] as const;

const updateSchemas = {
  message: messageSchema,
  edited_message: messageSchema,
  callback_query: callbackQuerySchema,
  my_chat_member: chatMemberUpdatedSchema,
  stopped_message_generation: messageGenerationStoppedSchema
} as const;

/** Decodes one raw update; `undefined` when it has no usable `update_id`. */
export function decodeTelegramUpdate(raw: unknown): TelegramUpdate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const updateId = count.safeParse(value.update_id);
  if (!updateId.success) return undefined;
  const update_id = updateId.data;
  for (const kind of TELEGRAM_ALLOWED_UPDATES) {
    if (!Object.hasOwn(value, kind)) continue;
    const parsed = updateSchemas[kind].safeParse(value[kind]);
    if (!parsed.success) return { update_id, kind: "invalid" };
    if (kind === "message" || kind === "edited_message") return { update_id, kind, message: parsed.data as TelegramMessage };
    if (kind === "callback_query") return { update_id, kind, callback_query: parsed.data as TelegramCallbackQuery };
    if (kind === "my_chat_member") return { update_id, kind, my_chat_member: parsed.data as TelegramChatMemberUpdated };
    return { update_id, kind, stopped_message_generation: parsed.data as TelegramMessageGenerationStopped };
  }
  return { update_id, kind: "other" };
}

const sentMessageSchema = z.object({ message_id: positiveId, chat: chatSchema, date: count });
export type TelegramSentMessage = z.infer<typeof sentMessageSchema>;

const fileSchema = z.object({ ...fileFields, file_path: z.string().min(1).max(512).optional() });
export type TelegramFile = z.infer<typeof fileSchema>;

const webhookInfoSchema = z.object({ url: z.string().max(4_096), pending_update_count: count });
/** Whether a webhook is set; the webhook URL itself is never passed on. */
export type TelegramWebhookState = Readonly<{ webhookSet: boolean; pendingUpdateCount: number }>;

// ---------------------------------------------------------------------------
// Outbound types (what AIQSA sends)

export type TelegramInlineKeyboardButton = Readonly<{ text: string }> & (Readonly<{ callback_data: string }> | Readonly<{ url: string }>);
export type TelegramInlineKeyboardMarkup = Readonly<{ inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[] }>;
export type TelegramReplyParameters = Readonly<{ message_id: number; allow_sending_without_reply?: boolean }>;
export type TelegramLinkPreviewOptions = Readonly<{ is_disabled?: boolean }>;
export type TelegramBotCommand = Readonly<{ command: string; description: string }>;

/** The rich text forms AIQSA sends; never buttons, mentions, commands or custom emoji. */
export type TelegramRichText =
  | string
  | readonly TelegramRichText[]
  | Readonly<{ type: "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "subscript" | "superscript" | "marked" | "code"; text: TelegramRichText }>
  | Readonly<{ type: "url"; text: TelegramRichText; url: string }>
  | Readonly<{ type: "mathematical_expression"; expression: string }>;

export type TelegramRichTableCell = Readonly<{
  text?: TelegramRichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
}>;

export type TelegramRichListItem = Readonly<{
  blocks: readonly TelegramInputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  value?: number;
  type?: "a" | "A" | "i" | "I" | "1";
}>;

/** The block subset AIQSA renders answers into. */
export type TelegramInputRichBlock =
  | Readonly<{ type: "paragraph"; text: TelegramRichText }>
  | Readonly<{ type: "heading"; text: TelegramRichText; size: 1 | 2 | 3 | 4 | 5 | 6 }>
  | Readonly<{ type: "pre"; text: TelegramRichText; language?: string }>
  | Readonly<{ type: "footer"; text: TelegramRichText }>
  | Readonly<{ type: "divider" }>
  | Readonly<{ type: "mathematical_expression"; expression: string }>
  | Readonly<{ type: "list"; items: readonly TelegramRichListItem[] }>
  | Readonly<{ type: "blockquote"; blocks: readonly TelegramInputRichBlock[]; credit?: TelegramRichText }>
  | Readonly<{
    type: "table"; cells: readonly (readonly TelegramRichTableCell[])[];
    is_bordered?: true; is_striped?: true; is_compact?: true; caption?: TelegramRichText;
  }>;

/** Always explicit blocks: AIQSA never sends the `markdown` or `html` forms. */
export type TelegramInputRichMessage = Readonly<{
  blocks: readonly TelegramInputRichBlock[];
  skip_entity_detection?: boolean;
  is_rtl?: boolean;
}>;

type MessageTarget = Readonly<{ chat_id: number }>;
type Markup = Readonly<{ reply_markup?: TelegramInlineKeyboardMarkup }>;
export type TelegramSendMessageParams = MessageTarget & Markup & Readonly<{
  text: string; reply_parameters?: TelegramReplyParameters; link_preview_options?: TelegramLinkPreviewOptions;
}>;
export type TelegramSendRichMessageParams = MessageTarget & Markup & Readonly<{
  rich_message: TelegramInputRichMessage; reply_parameters?: TelegramReplyParameters;
}>;
type DraftOptions = Readonly<{ draft_id: number; can_stop?: boolean; keep_on_stop?: boolean }>;
export type TelegramSendMessageDraftParams = MessageTarget & DraftOptions & Readonly<{ text?: string }>;
export type TelegramSendRichMessageDraftParams = MessageTarget & DraftOptions & Readonly<{ rich_message: TelegramInputRichMessage }>;
export type TelegramEditMessageTextParams = MessageTarget & Markup & Readonly<{ message_id: number }> & (
  | Readonly<{ text: string; link_preview_options?: TelegramLinkPreviewOptions }>
  | Readonly<{ rich_message: TelegramInputRichMessage }>
);
export type TelegramEditMessageReplyMarkupParams = MessageTarget & Markup & Readonly<{ message_id: number }>;
export type TelegramAnswerCallbackQueryParams = Readonly<{ callback_query_id: string; text?: string; show_alert?: boolean }>;
export type TelegramChatAction = "typing" | "upload_photo" | "upload_document";
export type TelegramSendFileParams = MessageTarget & Markup & Readonly<{ caption?: string; reply_parameters?: TelegramReplyParameters }>;
/** An upload without its multipart field (the method picks it); keeps the buffer-or-stream union. */
export type TelegramFileInput = TelegramUploadFile extends infer File ? File extends unknown ? Omit<File, "field"> : never : never;
export type TelegramGetUpdatesParams = Readonly<{
  offset?: number; limit?: number; timeoutSeconds: number; allowedUpdates?: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Pacing

export const TELEGRAM_CHAT_SEND_INTERVAL_MS = 1_100;
export const TELEGRAM_BOT_SENDS_PER_SECOND = 25;
export const TELEGRAM_RETRY_AFTER_MAX_SECONDS = 60;
const GLOBAL_SPACING_MS = Math.ceil(1_000 / TELEGRAM_BOT_SENDS_PER_SECOND);
const CHAT_ENTRY_LIMIT = 1_024;

/**
 * Reserves send slots: one message, edit or draft per chat every 1.1 s, and
 * bot-wide sends spaced 40 ms apart (at most 25 in any second). A slot is
 * reserved synchronously, so concurrent callers never take the same one.
 */
export type TelegramPacer = Readonly<{
  /** Reserves the next slot and returns how many milliseconds to wait for it. */
  reserve(chatId?: number): number;
}>;

export function createTelegramPacer(options: Readonly<{ now?: () => number }> = {}): TelegramPacer {
  const now = options.now ?? Date.now;
  const chatNext = new Map<number, number>();
  /** Reserved bot-wide slot times, ascending. */
  let slots: number[] = [];
  return Object.freeze({
    reserve(chatId?: number): number {
      const current = now();
      slots = slots.filter((slot) => slot > current - 1_000);
      if (chatNext.size > CHAT_ENTRY_LIMIT) {
        for (const [chat, next] of chatNext) if (next <= current) chatNext.delete(chat);
      }
      let at = Math.max(current, chatId === undefined ? current : chatNext.get(chatId) ?? current);
      for (const slot of slots) {
        if (slot <= at - GLOBAL_SPACING_MS) continue;
        if (slot >= at + GLOBAL_SPACING_MS) break;
        at = slot + GLOBAL_SPACING_MS;
      }
      const position = slots.findIndex((slot) => slot > at);
      if (position === -1) slots.push(at);
      else slots.splice(position, 0, at);
      if (chatId !== undefined) chatNext.set(chatId, at + TELEGRAM_CHAT_SEND_INTERVAL_MS);
      return at - current;
    }
  });
}

// ---------------------------------------------------------------------------
// Client

export type TelegramBotApi = Readonly<{
  getMe(): Promise<TelegramOutcome<TelegramBotUser>>;
  deleteWebhook(params?: Readonly<{ drop_pending_updates?: boolean }>): Promise<TelegramOutcome<true>>;
  getWebhookInfo(): Promise<TelegramOutcome<TelegramWebhookState>>;
  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<TelegramOutcome<true>>;
  getUpdates(params: TelegramGetUpdatesParams): Promise<TelegramOutcome<readonly TelegramUpdate[]>>;
  sendMessage(params: TelegramSendMessageParams): Promise<TelegramOutcome<TelegramSentMessage>>;
  sendRichMessage(params: TelegramSendRichMessageParams): Promise<TelegramOutcome<TelegramSentMessage>>;
  sendMessageDraft(params: TelegramSendMessageDraftParams): Promise<TelegramOutcome<true>>;
  sendRichMessageDraft(params: TelegramSendRichMessageDraftParams): Promise<TelegramOutcome<true>>;
  editMessageText(params: TelegramEditMessageTextParams): Promise<TelegramOutcome<TelegramSentMessage | true>>;
  editMessageReplyMarkup(params: TelegramEditMessageReplyMarkupParams): Promise<TelegramOutcome<TelegramSentMessage | true>>;
  answerCallbackQuery(params: TelegramAnswerCallbackQueryParams): Promise<TelegramOutcome<true>>;
  sendChatAction(params: MessageTarget & Readonly<{ action: TelegramChatAction }>): Promise<TelegramOutcome<true>>;
  sendDocument(params: TelegramSendFileParams, file: TelegramFileInput): Promise<TelegramOutcome<TelegramSentMessage>>;
  sendPhoto(params: TelegramSendFileParams, file: TelegramFileInput): Promise<TelegramOutcome<TelegramSentMessage>>;
  getFile(fileId: string): Promise<TelegramOutcome<TelegramFile>>;
  downloadFile(filePath: string, options?: Readonly<{ maxBytes?: number }>): Promise<TelegramOutcome<Buffer>>;
  leaveChat(chatId: number): Promise<TelegramOutcome<true>>;
}>;

type Pace = "chat" | "bot" | "none";

const INVALID_RESPONSE: TelegramFailure = { ok: false, kind: "http", status: 200, category: "invalid_response" };
const trueSchema = z.literal(true);
const editedSchema = z.union([trueSchema, sentMessageSchema]);

/** Content-free: stable codes, delays and HTTP status only. */
function log(fields: Readonly<{ code: string; delay_ms: number; httpStatus?: number }>): void {
  logEvent("service_operation", { subsystem: "telegram", stage: "dispatch", outcome: "waiting", action: "wait", ...fields });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTelegramBotApi(options: Readonly<{
  token: string;
  transport: TelegramTransport;
  pacer?: TelegramPacer;
  sleep?: (ms: number) => Promise<void>;
}>): TelegramBotApi {
  const { token, transport } = options;
  const pacer = options.pacer ?? createTelegramPacer();
  const sleep = options.sleep ?? defaultSleep;

  async function run<T>(
    pace: Pace, chatId: number | undefined, send: () => Promise<TelegramOutcome<unknown>>, decode: (value: unknown) => T | undefined,
    repeatable = true
  ): Promise<TelegramOutcome<T>> {
    for (let attempt = 0; ; attempt += 1) {
      if (pace !== "none") {
        const delay = pacer.reserve(pace === "chat" ? chatId : undefined);
        if (delay > 0) await sleep(delay);
      }
      const outcome = await send();
      if (!outcome.ok) {
        if (attempt === 0 && repeatable && outcome.kind === "telegram" && outcome.errorCode === 429) {
          const delay = Math.min(Math.max(outcome.retryAfter ?? 1, 0), TELEGRAM_RETRY_AFTER_MAX_SECONDS) * 1_000;
          log({ code: TELEGRAM_RATE_LIMITED_CODE, delay_ms: delay, httpStatus: outcome.status });
          await sleep(delay);
          continue;
        }
        return outcome;
      }
      const result = decode(outcome.result);
      return result === undefined ? INVALID_RESPONSE : { ok: true, result };
    }
  }

  const parse = <T>(schema: z.ZodType<T>) => (value: unknown): T | undefined => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  const call = (method: string, params?: Readonly<Record<string, unknown>>) => () => transport.call({ token, method, params });
  /** A streamed file is consumed by its first attempt, so only a buffer is sent again after a 429. */
  const upload = (method: string, field: "document" | "photo", params: TelegramSendFileParams, file: TelegramFileInput) => {
    const fields: Record<string, string> = { chat_id: String(params.chat_id) };
    if (params.caption !== undefined) fields.caption = params.caption;
    if (params.reply_markup) fields.reply_markup = JSON.stringify(params.reply_markup);
    if (params.reply_parameters) fields.reply_parameters = JSON.stringify(params.reply_parameters);
    const send = () => transport.upload({ token, method, fields, file: { ...file, field } as TelegramUploadFile });
    return run("chat", params.chat_id, send, parse(sentMessageSchema), "data" in file);
  };

  return Object.freeze({
    getMe: () => run("none", undefined, call("getMe"), parse(botUserSchema)),
    deleteWebhook: (params) => run("none", undefined, call("deleteWebhook", params ?? {}), parse(trueSchema)),
    getWebhookInfo: () => run("none", undefined, call("getWebhookInfo"), (value) => {
      const parsed = webhookInfoSchema.safeParse(value);
      return parsed.success ? { webhookSet: parsed.data.url.length > 0, pendingUpdateCount: parsed.data.pending_update_count } : undefined;
    }),
    setMyCommands: (commands) => run("none", undefined, call("setMyCommands", { commands }), parse(trueSchema)),
    getUpdates: ({ offset, limit, timeoutSeconds, allowedUpdates }) => run("none", undefined, () => transport.longPoll({
      token, method: "getUpdates", pollTimeoutSeconds: timeoutSeconds,
      params: {
        ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }),
        timeout: timeoutSeconds, allowed_updates: allowedUpdates ?? TELEGRAM_ALLOWED_UPDATES
      }
    }), (value) => {
      if (!Array.isArray(value) || value.length > 100) return undefined;
      const updates = value.map(decodeTelegramUpdate);
      return updates.every((update) => update !== undefined) ? updates as TelegramUpdate[] : undefined;
    }),
    sendMessage: (params) => run("chat", params.chat_id, call("sendMessage", params), parse(sentMessageSchema)),
    sendRichMessage: (params) => run("chat", params.chat_id, call("sendRichMessage", params), parse(sentMessageSchema)),
    sendMessageDraft: (params) => run("chat", params.chat_id, call("sendMessageDraft", params), parse(trueSchema)),
    sendRichMessageDraft: (params) => run("chat", params.chat_id, call("sendRichMessageDraft", params), parse(trueSchema)),
    editMessageText: (params) => run("chat", params.chat_id, call("editMessageText", params), parse(editedSchema)),
    editMessageReplyMarkup: (params) => run("chat", params.chat_id, call("editMessageReplyMarkup", params), parse(editedSchema)),
    answerCallbackQuery: (params) => run("none", undefined, call("answerCallbackQuery", params), parse(trueSchema)),
    sendChatAction: (params) => run("bot", undefined, call("sendChatAction", params), parse(trueSchema)),
    sendDocument: (params, file) => upload("sendDocument", "document", params, file),
    sendPhoto: (params, file) => upload("sendPhoto", "photo", params, file),
    getFile: (fileId) => run("none", undefined, call("getFile", { file_id: fileId }), parse(fileSchema)),
    downloadFile: (filePath, downloadOptions) => transport.download({ token, filePath, maxBytes: downloadOptions?.maxBytes }),
    leaveChat: (chatId) => run("none", undefined, call("leaveChat", { chat_id: chatId }), parse(trueSchema))
  });
}
