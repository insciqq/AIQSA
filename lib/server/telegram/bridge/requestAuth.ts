import type { RequestAuthResolver } from "../../auth/requestAuth";
import { prisma } from "../../prisma";
import type { TelegramAccessResolver } from "../control/access";

/**
 * The resolver the bot's in-process requests present to the product's own
 * handlers (send, follow-up, uploads, …): the linked user while the account
 * is active and Telegram access holds, re-read on every call. The session it
 * names is `telegram`, never a browser session.
 */
export function telegramRequestAuth(access: Pick<TelegramAccessResolver, "resolveTelegramAccess">, userId: string): RequestAuthResolver {
  return async () => {
    const [user, resolved] = await Promise.all([
      prisma.user.findUnique({ select: { displayName: true, email: true, id: true, role: true, status: true }, where: { id: userId } }),
      access.resolveTelegramAccess(userId)
    ]);
    return user && user.status === "active" && resolved.allowed
      ? { expiresAt: new Date(Date.now() + 60_000), id: "telegram", user, userId: user.id }
      : null;
  };
}
