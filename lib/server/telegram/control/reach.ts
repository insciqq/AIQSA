import type { TelegramBotSession } from "../dispatcher";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramAccessRefusal, TelegramAccessResolver } from "./access";
import type { TelegramSessionProvider } from "./session";

/**
 * Whether content bound to one Telegram chat may still go there now (D-04),
 * asked again right before every send that follows a wait (a draft's pacing,
 * a status edit, a retry, a file read): the bot is on as the bot the content
 * is bound to, Telegram access allows the user, and the user's link is still
 * exactly the one it is bound to — the same link, bot and chat. An unlink, a
 * new link, revoked sessions, a group the user left or a bot switched off or
 * changed end it; the content stays in AIQSA.
 */

export type TelegramChatBinding = Readonly<{ userId: string; linkId: string; botId: number; telegramChatId: number }>;

export type TelegramChatReach =
  /** The current bot session (its token generation may be newer) and the user's link. */
  | Readonly<{ ok: true; bot: TelegramBotSession; link: TelegramLinkRecord }>
  | Readonly<{ ok: false; reasonCode: TelegramAccessRefusal }>;

export type TelegramChatReachDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  sessions: TelegramSessionProvider;
}>;

export async function reachTelegramChat(deps: TelegramChatReachDeps, binding: TelegramChatBinding): Promise<TelegramChatReach> {
  const [bot, access] = await Promise.all([deps.sessions.current(), deps.access.resolveTelegramAccess(binding.userId)]);
  if (!access.allowed) return { ok: false, reasonCode: access.reasonCode };
  if (!bot) return { ok: false, reasonCode: "telegram_access_off" };
  const { link } = access;
  if (bot.botId !== binding.botId || link.botId !== binding.botId) return { ok: false, reasonCode: "telegram_bot_changed" };
  // Linked anew meanwhile (another link, or the same one now in another chat): nothing goes there.
  if (link.id !== binding.linkId || link.telegramChatId !== binding.telegramChatId) return { ok: false, reasonCode: "telegram_not_linked" };
  return { bot, link, ok: true };
}
