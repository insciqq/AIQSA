import type { PrismaClient } from "@prisma/client";
import {
  telegramAdminUserLinkSchema, telegramUserStatusSchema, type TelegramAdminUserLink, type TelegramUserStatus
} from "../../../contracts/telegram";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import type { TelegramLinkRecord, TelegramLinkStore } from "../store/links";
import { isTelegramBotActive, type TelegramActiveControl, type TelegramEffectiveControl } from "./state";

/**
 * Telegram access (D-04), decided on every update and before every delivery:
 * the bot is on with a readable token, the link names the current bot, the
 * user is active and not deactivated by SCIM, and the bot is open to everyone
 * or to an active member of a non-archived allowed group. A refusal changes
 * nothing: the link stays, and access returns with the condition.
 */

export type TelegramAccessRefusal = "telegram_not_linked" | "telegram_access_off" | "telegram_bot_changed";

export type TelegramAccessDecision =
  | Readonly<{ allowed: true; control: TelegramActiveControl; link: TelegramLinkRecord }>
  | Readonly<{ allowed: false; reasonCode: TelegramAccessRefusal; link: TelegramLinkRecord | null }>;

/** The account facts access needs: status, SCIM deactivation and memberships of non-archived groups. */
export type TelegramAccessUser = Readonly<{
  status: string;
  scimDeactivatedAt: Date | null;
  activeGroupIds: readonly string[];
}>;

export type TelegramAccessUserSource = (userId: string) => Promise<TelegramAccessUser | null>;

export type TelegramAccessResolver = Readonly<{
  /** The decision for a user's own link (read when not passed). */
  resolveTelegramAccess(userId: string, options?: Readonly<{ link?: TelegramLinkRecord | null }>): Promise<TelegramAccessDecision>;
  /** Whether the bot is on and open to this user, with or without a link (who may create a link code). */
  isUserAllowed(userId: string): Promise<boolean>;
  /** The settings status: hidden unless the user may link or already has a link whose state it shows. */
  userStatus(userId: string): Promise<TelegramUserStatus>;
  /** The administrator's view of one user's link; null when the user does not exist. */
  adminUserLink(userId: string): Promise<TelegramAdminUserLink | null>;
}>;

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;

export function eligibleForTelegram(control: TelegramEffectiveControl, user: TelegramAccessUser | null): boolean {
  if (!user || user.status !== "active" || user.scimDeactivatedAt !== null) return false;
  return !control.restricted || user.activeGroupIds.some((groupId) => control.groupIds.has(groupId));
}

/** Reads the account facts in one query; memberships count only for groups that are not archived. */
export function createPrismaTelegramAccessUserSource(prisma: Pick<PrismaClient, "user">): TelegramAccessUserSource {
  return async (userId) => {
    const user = await prisma.user.findUnique({
      select: {
        groups: { select: { groupId: true }, where: { group: { archivedAt: null } } },
        scimDeactivatedAt: true,
        status: true
      },
      where: { id: userId }
    }).catch(retainDatabaseFailure);
    return user
      ? { activeGroupIds: user.groups.map((group) => group.groupId), scimDeactivatedAt: user.scimDeactivatedAt, status: user.status }
      : null;
  };
}

type LinkState = Readonly<{ state: "linked" | "access_off" | "bot_changed"; reasonCode?: "telegram_access_off" | "telegram_bot_changed" }>;

function linkState(control: TelegramEffectiveControl, link: TelegramLinkRecord, eligible: boolean): LinkState {
  if (!isTelegramBotActive(control)) return { reasonCode: "telegram_access_off", state: "access_off" };
  if (link.botId !== control.bot.id) return { reasonCode: "telegram_bot_changed", state: "bot_changed" };
  return eligible ? { state: "linked" } : { reasonCode: "telegram_access_off", state: "access_off" };
}

function username(value: string | null): string | undefined {
  return value && USERNAME_PATTERN.test(value) ? value : undefined;
}

export function createTelegramAccessResolver(deps: Readonly<{
  control(): Promise<TelegramEffectiveControl>;
  links: Pick<TelegramLinkStore, "findByUserId">;
  users: TelegramAccessUserSource;
}>): TelegramAccessResolver {
  return Object.freeze({
    async resolveTelegramAccess(userId: string, options: Readonly<{ link?: TelegramLinkRecord | null }> = {}) {
      const [control, link] = await Promise.all([
        deps.control(),
        options.link === undefined ? deps.links.findByUserId(userId) : Promise.resolve(options.link)
      ]);
      if (!link || link.userId !== userId) return { allowed: false, link: null, reasonCode: "telegram_not_linked" } as const;
      if (!isTelegramBotActive(control)) return { allowed: false, link, reasonCode: "telegram_access_off" } as const;
      if (link.botId !== control.bot.id) return { allowed: false, link, reasonCode: "telegram_bot_changed" } as const;
      if (!eligibleForTelegram(control, await deps.users(userId))) {
        return { allowed: false, link, reasonCode: "telegram_access_off" } as const;
      }
      return { allowed: true, control, link } as const;
    },

    async isUserAllowed(userId: string) {
      const control = await deps.control();
      return isTelegramBotActive(control) && eligibleForTelegram(control, await deps.users(userId));
    },

    async userStatus(userId: string) {
      const [control, link, user] = await Promise.all([deps.control(), deps.links.findByUserId(userId), deps.users(userId)]);
      const eligible = eligibleForTelegram(control, user);
      if (!link) return telegramUserStatusSchema.parse({ available: isTelegramBotActive(control) && eligible, state: "not_linked" });
      const state = linkState(control, link, eligible);
      return telegramUserStatusSchema.parse({
        available: true,
        linkedAt: link.linkedAt.toISOString(),
        ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
        state: state.state,
        ...(username(link.telegramUsername) ? { telegramUsername: username(link.telegramUsername) } : {})
      });
    },

    async adminUserLink(userId: string) {
      const [control, user] = await Promise.all([deps.control(), deps.users(userId)]);
      if (!user) return null;
      const link = await deps.links.findByUserId(userId);
      if (!link) return telegramAdminUserLinkSchema.parse({ state: "not_linked" });
      const state = linkState(control, link, eligibleForTelegram(control, user));
      const displayName = link.displayName?.trim().slice(0, 128);
      return telegramAdminUserLinkSchema.parse({
        ...(displayName ? { displayName } : {}),
        lastSeenAt: link.lastSeenAt.toISOString(),
        linkedAt: link.linkedAt.toISOString(),
        ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
        state: state.state,
        ...(username(link.telegramUsername) ? { telegramUsername: username(link.telegramUsername) } : {})
      });
    }
  });
}
