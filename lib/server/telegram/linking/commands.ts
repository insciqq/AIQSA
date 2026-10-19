import type { TelegramUser } from "../botApi";
import { TELEGRAM_CORE_COPY, TELEGRAM_COPY, telegramConnectedText, telegramReasonText } from "../copy";
import type { TelegramCallbackContext, TelegramCallbackReply, TelegramLinkCommands } from "../dispatcher";
import type { TelegramLinkingService } from "./service";

/**
 * The bot's own account commands: `/start <code>` links the private chat's
 * Telegram account, `/unlink` asks before disconnecting it (a single-use
 * button that works even while access is off: it only removes authority), and
 * `/help` lists the commands.
 */

export const TELEGRAM_UNLINK_CONFIRM_TTL_MS = 10 * 60_000;
const DISPLAY_NAME_MAX_LENGTH = 128;

/** The Telegram account's own display name for the link; never logged. */
export function telegramDisplayName(user: TelegramUser): string | null {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  if (!name) return null;
  return name.length <= DISPLAY_NAME_MAX_LENGTH ? name : name.slice(0, DISPLAY_NAME_MAX_LENGTH);
}

export function createTelegramLinkCommands(deps: Readonly<{ linking: TelegramLinkingService }>): TelegramLinkCommands {
  return Object.freeze({
    async start(context) {
      const { bot, message } = context;
      const sender = message.from!;
      const outcome = await deps.linking.linkFromStart({
        code: context.code,
        target: {
          botId: bot.botId,
          displayName: telegramDisplayName(sender),
          telegramChatId: message.chat.id,
          telegramUserId: sender.id,
          telegramUsername: sender.username ?? null
        }
      });
      const text = outcome.kind === "linked"
        ? telegramConnectedText(outcome.accountName)
        : telegramReasonText(outcome.code) ?? TELEGRAM_COPY.notLinked;
      await bot.outbound.sendText({ chatId: message.chat.id, text });
    },

    async unlink(context) {
      await context.bot.outbound.sendText({
        chatId: context.message.chat.id,
        keyboard: [[{ callback: { kind: "unlink_confirm", ttlMs: TELEGRAM_UNLINK_CONFIRM_TTL_MS }, text: TELEGRAM_COPY.unlinkConfirm }]],
        linkId: context.link.id,
        text: TELEGRAM_COPY.unlinkQuestion
      });
    },

    async help(context) {
      await context.bot.outbound.sendText({ chatId: context.message.chat.id, text: TELEGRAM_COPY.help });
    },

    async confirmUnlink(context: TelegramCallbackContext): Promise<TelegramCallbackReply> {
      const removed = await deps.linking.unlinkFromBot({ linkId: context.link.id, userId: context.link.userId });
      const text = removed ? TELEGRAM_COPY.disconnected : TELEGRAM_CORE_COPY.notConnected;
      const edited = context.messageId === null ? null : await context.bot.api.editMessageText({
        chat_id: context.chatId, message_id: context.messageId, text
      });
      if (!edited?.ok) await context.bot.outbound.sendText({ chatId: context.chatId, text });
      return {};
    }
  });
}
