import { formatChatRoutePath } from "../../domain/chatRoute";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type {
  TelegramBotApi, TelegramFileInput, TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup, TelegramInputRichMessage,
  TelegramReplyParameters, TelegramSendAuthority, TelegramSentMessage
} from "./botApi";
import { telegramFailureCode } from "./codes";
import { TELEGRAM_COPY } from "./copy";
import { plainTelegramMessage } from "./render";
import type { TelegramCallbackInput, TelegramCallbackStore } from "./store/callbacks";
import type { TelegramMessageRefOwner, TelegramMessageRefStore } from "./store/messageRefs";
import type { TelegramFailure, TelegramOutcome } from "./transport";

/**
 * Sends what other modules already rendered: rich answer messages (explicit
 * blocks only, entity detection off), each falling back alone to its plain
 * text when Telegram refuses its rich form, bot copy, files from buffers and
 * inline keyboards whose buttons are server rows or http(s) links. Every
 * message carrying chat content records a message reference so a reply
 * continues that chat. Only a send that provably never reached Telegram is
 * repeated; an ambiguous one is reported, never resent. With `authorize`,
 * every message, fallback and retry asks it right before it leaves, and the
 * first refusal ends the call `unreachable`.
 */

export const TELEGRAM_MESSAGE_MAX_LENGTH = 4_096;
export const TELEGRAM_CAPTION_MAX_LENGTH = 1_024;
const BUTTON_TEXT_MAX_LENGTH = 128;

export type TelegramKeyboardButton =
  | Readonly<{ text: string; callback: TelegramCallbackInput }>
  | Readonly<{ text: string; url: string }>;
export type TelegramKeyboard = readonly (readonly TelegramKeyboardButton[])[];

export type TelegramDelivery =
  | Readonly<{ ok: true; messageIds: readonly number[]; fallback: boolean }>
  | Readonly<{ ok: false; failure: TelegramFailure; messageIds: readonly number[] }>;

type Placement = Readonly<{
  chatId: number;
  keyboard?: TelegramKeyboard;
  /** Adds an Open in AIQSA button for the owner's chat when the installation is served over https. */
  openInAiqsa?: boolean;
  /** The user's message this answers; sent even if that message is gone. */
  replyTo?: number;
  /** Whether the chat may still receive it, asked before every dispatch (see `TelegramSendAuthority`). */
  authorize?: TelegramSendAuthority;
}>;

export type TelegramOutbound = Readonly<{
  /**
   * An answer's rich messages in order. A part Telegram refuses (400) goes as
   * that part's plain text instead; parts already delivered are never sent again.
   */
  sendContent(input: Placement & Readonly<{
    owner: TelegramMessageRefOwner; messages: readonly TelegramInputRichMessage[];
  }>): Promise<TelegramDelivery>;
  /** One plain text message (bot copy, or chat content when an owner is named), split at 4096 characters. */
  sendText(input: Placement & Readonly<{ text: string; linkId?: string; owner?: TelegramMessageRefOwner }>): Promise<TelegramDelivery>;
  sendFile(input: Placement & Readonly<{
    kind: "document" | "photo"; file: Extract<TelegramFileInput, { data: Buffer }>; caption?: string; owner: TelegramMessageRefOwner;
  }>): Promise<TelegramDelivery>;
  /** Builds an inline keyboard, storing its callback rows for `linkId`. */
  replyMarkup(input: Readonly<{ keyboard?: TelegramKeyboard; linkId?: string; openChatId?: string }>): Promise<TelegramInlineKeyboardMarkup | undefined>;
  /** `<appBaseUrl>/c/<chatId>`, only for an https installation. */
  openInAiqsaUrl(chatId: string): string | null;
}>;

/** Content-free: codes and HTTP status only. */
function log(fields: Readonly<{ code: string; httpStatus?: number; outcome: "failed" | "degraded" }>): void {
  logEvent("service_operation", { stage: "dispatch", subsystem: "telegram", ...fields });
}

function logFailure(failure: TelegramFailure): void {
  log({ code: telegramFailureCode(failure.kind, failure.errorCode), httpStatus: failure.status, outcome: "failed" });
}

/** Splits text at 4096 UTF-16 units, preferring line and word ends, never inside a surrogate pair. */
export function splitTelegramText(text: string, max = TELEGRAM_MESSAGE_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/u, "");
  }
  chunks.push(rest);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function truncated(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.charCodeAt(max - 2) >= 0xd800 && text.charCodeAt(max - 2) <= 0xdbff ? max - 2 : max - 1;
  return `${text.slice(0, cut)}…`;
}

function boundedText(value: string, max: number): string {
  return truncated(value.replace(/\s+/gu, " ").trim(), max);
}

function httpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("telegram_button_url_invalid");
  return url.toString();
}

async function once<T>(send: () => Promise<TelegramOutcome<T>>): Promise<TelegramOutcome<T>> {
  const first = await send();
  // Only a send whose bytes never reached Telegram is safe to repeat.
  return first.ok || first.kind !== "network_before_send" ? first : send();
}

function isRichRefusal(failure: TelegramFailure): boolean {
  return failure.kind === "telegram" && failure.errorCode === 400;
}

export function createTelegramOutbound(deps: Readonly<{
  api: TelegramBotApi;
  appBaseUrl: string;
  botId: number;
  callbacks: Pick<TelegramCallbackStore, "create">;
  messageRefs: Pick<TelegramMessageRefStore, "record">;
  now?: () => Date;
}>): TelegramOutbound {
  const now = deps.now ?? (() => new Date());

  function openInAiqsaUrl(chatId: string): string | null {
    try {
      const base = new URL(deps.appBaseUrl);
      return base.protocol === "https:" ? new URL(formatChatRoutePath({ chatId }), base).toString() : null;
    } catch {
      return null;
    }
  }

  async function replyMarkup(input: Readonly<{ keyboard?: TelegramKeyboard; linkId?: string; openChatId?: string }>) {
    const rows = (input.keyboard ?? []).filter((row) => row.length > 0);
    const callbacks = rows.flat().flatMap((button) => "callback" in button ? [button.callback] : []);
    if (callbacks.length > 0 && !input.linkId) throw new Error("telegram_keyboard_link_missing");
    const data = callbacks.length > 0 ? [...await deps.callbacks.create({ buttons: callbacks, linkId: input.linkId!, now: now() })] : [];
    const inline: TelegramInlineKeyboardButton[][] = rows.map((row) => row.map((button) => {
      const text = boundedText(button.text, BUTTON_TEXT_MAX_LENGTH);
      return "callback" in button ? { callback_data: data.shift()!, text } : { text, url: httpUrl(button.url) };
    }));
    const open = input.openChatId ? openInAiqsaUrl(input.openChatId) : null;
    if (open) inline.push([{ text: TELEGRAM_COPY.openInAiqsa, url: open }]);
    return inline.length > 0 ? { inline_keyboard: inline } : undefined;
  }

  /** A reference only routes later replies: losing one never turns a delivered message into a failure. */
  async function recordRef(owner: TelegramMessageRefOwner | undefined, chatId: number, sent: TelegramSentMessage): Promise<void> {
    if (!owner) return;
    try {
      await deps.messageRefs.record([{ ...owner, botId: deps.botId, telegramChatId: chatId, telegramMessageId: sent.message_id }], now());
    } catch (error) {
      logEvent("service_operation", {
        code: "telegram_message_ref_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "dispatch", subsystem: "telegram"
      });
    }
  }

  function reply(replyTo: number | undefined): Readonly<{ reply_parameters?: TelegramReplyParameters }> {
    return replyTo ? { reply_parameters: { allow_sending_without_reply: true, message_id: replyTo } } : {};
  }

  /** Plain messages in order; the keyboard goes on the last one. */
  async function sendPlain(input: Readonly<{
    chatId: number; chunks: readonly string[]; markup?: TelegramInlineKeyboardMarkup; owner?: TelegramMessageRefOwner; replyTo?: number;
    authorize?: TelegramSendAuthority;
  }>, sent: number[]): Promise<TelegramFailure | null> {
    const options = { authorize: input.authorize };
    const chunks = input.chunks.flatMap((chunk) => splitTelegramText(chunk));
    for (const [index, text] of chunks.entries()) {
      const outcome = await once(() => deps.api.sendMessage({
        chat_id: input.chatId,
        link_preview_options: { is_disabled: true },
        text,
        ...(index === 0 ? reply(input.replyTo) : {}),
        ...(index === chunks.length - 1 && input.markup ? { reply_markup: input.markup } : {})
      }, options));
      if (!outcome.ok) {
        logFailure(outcome);
        return outcome;
      }
      sent.push(outcome.result.message_id);
      await recordRef(input.owner, input.chatId, outcome.result);
    }
    return null;
  }

  return Object.freeze({
    openInAiqsaUrl,
    replyMarkup,

    async sendContent(input) {
      const markup = await replyMarkup({
        keyboard: input.keyboard, linkId: input.owner.linkId, openChatId: input.openInAiqsa ? input.owner.chatId : undefined
      });
      const sent: number[] = [];
      const options = { authorize: input.authorize };
      let fallback = false;
      for (const [index, message] of input.messages.entries()) {
        const last = index === input.messages.length - 1;
        const outcome = await once(() => deps.api.sendRichMessage({
          chat_id: input.chatId,
          rich_message: { ...message, skip_entity_detection: true },
          ...(index === 0 ? reply(input.replyTo) : {}),
          ...(last && markup ? { reply_markup: markup } : {})
        }, options));
        if (outcome.ok) {
          sent.push(outcome.result.message_id);
          await recordRef(input.owner, input.chatId, outcome.result);
          continue;
        }
        const chunks = isRichRefusal(outcome) ? plainTelegramMessage(message) : [];
        if (chunks.length === 0) {
          logFailure(outcome);
          return { failure: outcome, messageIds: sent, ok: false };
        }
        // Telegram refused this part's rich form: this part alone as plain text. The parts
        // already delivered stay as they are and later parts still try their rich form.
        log({ code: "telegram_render_fallback", httpStatus: outcome.status, outcome: "degraded" });
        fallback = true;
        const failure = await sendPlain({
          authorize: input.authorize, chatId: input.chatId, chunks, markup: last ? markup : undefined, owner: input.owner,
          replyTo: index === 0 ? input.replyTo : undefined
        }, sent);
        if (failure) return { failure, messageIds: sent, ok: false };
      }
      return { fallback, messageIds: sent, ok: true };
    },

    async sendText(input) {
      const markup = await replyMarkup({
        keyboard: input.keyboard, linkId: input.linkId ?? input.owner?.linkId,
        openChatId: input.openInAiqsa ? input.owner?.chatId : undefined
      });
      const sent: number[] = [];
      const failure = await sendPlain({
        authorize: input.authorize, chatId: input.chatId, chunks: [input.text], markup, owner: input.owner, replyTo: input.replyTo
      }, sent);
      return failure ? { failure, messageIds: sent, ok: false } : { fallback: false, messageIds: sent, ok: true };
    },

    async sendFile(input) {
      const markup = await replyMarkup({
        keyboard: input.keyboard, linkId: input.owner.linkId, openChatId: input.openInAiqsa ? input.owner.chatId : undefined
      });
      const params = {
        chat_id: input.chatId,
        ...(input.caption?.trim() ? { caption: truncated(input.caption.trim(), TELEGRAM_CAPTION_MAX_LENGTH) } : {}),
        ...reply(input.replyTo),
        ...(markup ? { reply_markup: markup } : {})
      };
      const options = { authorize: input.authorize };
      const outcome = await once(() => input.kind === "photo" ? deps.api.sendPhoto(params, input.file, options)
        : deps.api.sendDocument(params, input.file, options));
      if (!outcome.ok) {
        logFailure(outcome);
        return { failure: outcome, messageIds: [], ok: false };
      }
      await recordRef(input.owner, input.chatId, outcome.result);
      return { fallback: false, messageIds: [outcome.result.message_id], ok: true };
    }
  });
}
