import type { TelegramBotApi } from "../botApi";
import type { TelegramBotSession } from "../dispatcher";
import type { TelegramOutbound } from "../outbound";
import { isTelegramBotActive, type TelegramEffectiveControl } from "./state";

/**
 * The bot as the application talks to it: one Bot API client (and so one
 * pacer) and one outbound per token generation, so per-chat and per-bot
 * pacing hold across the poller, replies and deliveries. Null while the bot
 * is off or its token unreadable.
 */

export type TelegramSessionProvider = Readonly<{ current(): Promise<TelegramBotSession | null> }>;

export function createTelegramSessionProvider(deps: Readonly<{
  control(): Promise<TelegramEffectiveControl>;
  createApi(token: string): TelegramBotApi;
  createOutbound(input: Readonly<{ api: TelegramBotApi; botId: number }>): TelegramOutbound;
}>): TelegramSessionProvider {
  let cached: Readonly<{ key: string; session: TelegramBotSession }> | null = null;
  return Object.freeze({
    async current() {
      const control = await deps.control();
      if (!isTelegramBotActive(control)) return null;
      const { bot } = control;
      const key = `${bot.id}:${bot.generation}`;
      if (cached?.key !== key) {
        const api = deps.createApi(bot.token);
        cached = {
          key,
          session: Object.freeze({
            api, botId: bot.id, botUsername: bot.username, generation: bot.generation, outbound: deps.createOutbound({ api, botId: bot.id })
          })
        };
      }
      return cached.session;
    }
  });
}
