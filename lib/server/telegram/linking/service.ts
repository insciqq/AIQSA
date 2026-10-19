import { randomBytes } from "node:crypto";
import {
  telegramLinkCodeResponseSchema, type TelegramAdminUserLink, type TelegramLinkCodeResponse, type TelegramUserStatus
} from "../../../contracts/telegram";
import type { LoginRateLimiter } from "../../auth/rateLimit";
import { hashToken } from "../../auth/token";
import { logEvent } from "../../observability";
import type { TelegramAccessResolver } from "../control/access";
import { isTelegramBotActive, type TelegramEffectiveControl } from "../control/state";
import type { TelegramLinkingRepository, TelegramLinkOutcome, TelegramLinkTarget, TelegramRemovedLink } from "./repository";

/**
 * Linking from AIQSA's side: a user with Telegram access asks for a one-time
 * code (5 per 10 minutes), opens the bot's deep link, and the bot's `/start`
 * consumes it. Unlinking, by the user or an administrator, tells the
 * disconnected Telegram chat when the bot can still reach it.
 */

export const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60_000;
export const TELEGRAM_LINK_CODE_RATE_LIMIT = 5;
export const TELEGRAM_LINK_CODE_RATE_WINDOW_MS = 10 * 60_000;
/** 32 random bytes in base64url: 43 characters, inside Telegram's 64-character `start` limit. */
const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function telegramLinkCodeRateLimitKey(userId: string): string {
  return `telegram:link-code:user:${userId}`;
}

export function isTelegramLinkCode(value: string): boolean {
  return LINK_CODE_PATTERN.test(value);
}

export type TelegramLinkCodeResult =
  | Readonly<{ ok: true; value: TelegramLinkCodeResponse }>
  | Readonly<{ ok: false; code: "telegram_access_off" }>
  | Readonly<{ ok: false; code: "telegram_link_code_rate_limited"; retryAfterSeconds: number }>;

/** Best-effort notice to a disconnected Telegram chat; never throws. */
export type TelegramDisconnectNotifier = (removed: TelegramRemovedLink) => Promise<void>;

export type TelegramLinkingService = Readonly<{
  createLinkCode(input: Readonly<{ sessionId: string; userId: string }>): Promise<TelegramLinkCodeResult>;
  status(userId: string): Promise<TelegramUserStatus>;
  unlink(userId: string): Promise<TelegramUserStatus>;
  adminView(userId: string): Promise<TelegramAdminUserLink | null>;
  adminUnlink(userId: string): Promise<TelegramAdminUserLink | null>;
  /** `/start <code>` from a private chat: consumes the code and links its Telegram account. */
  linkFromStart(input: Readonly<{ code: string; target: TelegramLinkTarget }>): Promise<TelegramLinkOutcome>;
  /** `/unlink` confirmed in the bot: removes the link the button was made for. */
  unlinkFromBot(input: Readonly<{ linkId: string; userId: string }>): Promise<boolean>;
}>;

/** Content-free: stages, outcomes and stable codes only. */
function log(fields: Readonly<{ code?: string; outcome: "completed" | "failed" | "skipped"; stage: "write" | "delete" | "claim" }>): void {
  logEvent("service_operation", { subsystem: "telegram", ...fields });
}

export function createTelegramLinkingService(deps: Readonly<{
  access: TelegramAccessResolver;
  control(): Promise<TelegramEffectiveControl>;
  notifyDisconnected: TelegramDisconnectNotifier;
  rateLimiter: Pick<LoginRateLimiter, "check">;
  repository: TelegramLinkingRepository;
  newCode?: () => string;
  now?: () => Date;
}>): TelegramLinkingService {
  const now = deps.now ?? (() => new Date());
  const newCode = deps.newCode ?? (() => randomBytes(32).toString("base64url"));

  async function unlinkAndNotify(userId: string): Promise<void> {
    const removed = await deps.repository.unlink(userId);
    if (!removed) return;
    log({ outcome: "completed", stage: "delete" });
    await deps.notifyDisconnected(removed);
  }

  return Object.freeze({
    async createLinkCode(input) {
      const control = await deps.control();
      if (!isTelegramBotActive(control) || !(await deps.access.isUserAllowed(input.userId))) {
        return { code: "telegram_access_off", ok: false } as const;
      }
      const limited = await deps.rateLimiter.check(telegramLinkCodeRateLimitKey(input.userId), { maxAttempts: TELEGRAM_LINK_CODE_RATE_LIMIT });
      if (!limited.allowed) {
        log({ code: "telegram_link_code_rate_limited", outcome: "skipped", stage: "write" });
        return { code: "telegram_link_code_rate_limited", ok: false, retryAfterSeconds: Math.max(1, Math.ceil(limited.retryAfterSeconds)) } as const;
      }
      const code = newCode();
      if (!isTelegramLinkCode(code)) throw new Error("telegram_link_code_invalid");
      const at = now();
      const expiresAt = new Date(at.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
      await deps.repository.createCode({
        authSessionId: input.sessionId, botId: control.bot.id, codeHash: hashToken(code), expiresAt, now: at, userId: input.userId
      });
      log({ outcome: "completed", stage: "write" });
      return {
        ok: true,
        value: telegramLinkCodeResponseSchema.parse({
          deepLink: `https://t.me/${control.bot.username}?start=${code}`, expiresAt: expiresAt.toISOString()
        })
      } as const;
    },

    status(userId) {
      return deps.access.userStatus(userId);
    },

    async unlink(userId) {
      await unlinkAndNotify(userId);
      return deps.access.userStatus(userId);
    },

    adminView(userId) {
      return deps.access.adminUserLink(userId);
    },

    async adminUnlink(userId) {
      const view = await deps.access.adminUserLink(userId);
      if (!view) return null;
      await unlinkAndNotify(userId);
      return deps.access.adminUserLink(userId);
    },

    async linkFromStart(input) {
      if (!isTelegramLinkCode(input.code)) return { code: "telegram_link_code_invalid", kind: "refused" } as const;
      const outcome = await deps.repository.consumeCodeAndLink({
        codeHash: hashToken(input.code), control: await deps.control(), now: now(), target: input.target
      });
      log(outcome.kind === "linked" ? { outcome: "completed", stage: "claim" } : { code: outcome.code, outcome: "skipped", stage: "claim" });
      if (outcome.kind === "linked" && outcome.replaced && outcome.replaced.telegramChatId !== input.target.telegramChatId) {
        await deps.notifyDisconnected(outcome.replaced);
      }
      return outcome;
    },

    async unlinkFromBot(input) {
      const removed = await deps.repository.unlinkLink(input);
      if (removed) log({ outcome: "completed", stage: "delete" });
      return removed !== null;
    }
  });
}
