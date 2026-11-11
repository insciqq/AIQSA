import type { RequestAuthResolver } from "../../auth/requestAuth";
import { connectorRequestAuth } from "../../connectors/requestAuth";
import type { TelegramAccessResolver } from "../control/access";

/**
 * The resolver the bot's in-process requests present to the product's own
 * handlers (send, follow-up, uploads, …): the linked user while the account
 * is active and Telegram access holds, re-read on every call. The session it
 * names is `telegram`, never a browser session.
 */
export function telegramRequestAuth(access: Pick<TelegramAccessResolver, "resolveTelegramAccess">, userId: string): RequestAuthResolver {
  return connectorRequestAuth({
    allowed: async () => (await access.resolveTelegramAccess(userId)).allowed, sessionId: "telegram", userId
  });
}
