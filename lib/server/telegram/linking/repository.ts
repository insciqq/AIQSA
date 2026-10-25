import { Prisma, type PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { eligibleForTelegram } from "../control/access";
import type { TelegramEffectiveControl } from "../control/state";
import { telegramLinkRecord, type TelegramLinkRecord } from "../store/links";

/**
 * Link codes and the links they create. A `/start` locks the code's account,
 * reads the creating session `FOR SHARE`, then consumes the code with a
 * conditional update that only one transaction wins: the account-security
 * writers' lock order, so a concurrent revocation either commits first (the
 * session is revoked and the link refused) or waits for the link and then
 * deletes it with the session. A consumed code stays consumed whatever the
 * outcome.
 */

export type TelegramLinkTarget = Readonly<{
  botId: number;
  telegramUserId: number;
  telegramChatId: number;
  telegramUsername: string | null;
  displayName: string | null;
}>;

export type TelegramLinkOutcome =
  | Readonly<{
    kind: "linked";
    link: TelegramLinkRecord;
    /** The AIQSA account's display name, for the confirmation. */
    accountName: string;
    /** The user's previous link to another Telegram account, removed by this one. */
    replaced: Readonly<{ botId: number; telegramChatId: number }> | null;
  }>
  | Readonly<{ kind: "refused"; code: "telegram_link_code_invalid" | "telegram_access_off" | "telegram_account_in_use" }>;

export type TelegramRemovedLink = Readonly<{ botId: number; telegramChatId: number }>;

export type TelegramLinkingRepository = Readonly<{
  /** Stores a new code for a live session, replacing the user's unused ones. */
  createCode(input: Readonly<{
    authSessionId: string; botId: number; codeHash: string; expiresAt: Date; now: Date; userId: string;
  }>): Promise<void>;
  consumeCodeAndLink(input: Readonly<{
    codeHash: string; control: TelegramEffectiveControl; now: Date; target: TelegramLinkTarget;
  }>): Promise<TelegramLinkOutcome>;
  /** Removes the user's link (its buttons, message references and run links go with it) and voids their unused codes. */
  unlink(userId: string): Promise<TelegramRemovedLink | null>;
  /** Removes a link only while it is still the one the caller saw, voiding the user's unused codes with it. */
  unlinkLink(input: Readonly<{ linkId: string; userId: string }>): Promise<TelegramRemovedLink | null>;
}>;

type LinkingClient = Pick<PrismaClient, "$transaction" | "telegramLink" | "telegramLinkCode">;

type SessionRow = { expiresAt: Date; revokedAt: Date | null };

/**
 * Serializes with every writer of the account row (status, role, deletion and `lockAuthUser`)
 * without blocking foreign-key checks that only need the row to exist.
 */
async function lockAccount(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`).catch(retainDatabaseFailure);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createPrismaTelegramLinkingRepository(prisma: LinkingClient): TelegramLinkingRepository {
  /**
   * Disconnecting also voids the user's unused link codes, so a code minted before it cannot link
   * another Telegram account afterwards. `always` voids them even when there was no link (the
   * user's own or an administrator's disconnect); `with_link` only when the named link went (a
   * stale `/unlink` button leaves the user's codes alone).
   */
  async function removeLink(
    userId: string, where: Prisma.TelegramLinkWhereInput, voidCodes: "always" | "with_link"
  ): Promise<TelegramRemovedLink | null> {
    return prisma.$transaction(async (tx) => {
      // Same lock order as createCode and a /start: the account first, so a code made or redeemed
      // concurrently either commits before this and is voided here, or waits and finds it gone.
      await lockAccount(tx, userId);
      const link = await tx.telegramLink.findFirst({ select: { botId: true, id: true, telegramChatId: true }, where })
        .catch(retainDatabaseFailure);
      const removed = link ? await tx.telegramLink.deleteMany({ where: { id: link.id } }).catch(retainDatabaseFailure) : null;
      if (voidCodes === "always" || removed?.count === 1) {
        await tx.telegramLinkCode.deleteMany({ where: { consumedAt: null, userId } }).catch(retainDatabaseFailure);
      }
      return link && removed?.count === 1 ? { botId: Number(link.botId), telegramChatId: Number(link.telegramChatId) } : null;
    }).catch(retainDatabaseFailure);
  }

  return Object.freeze({
    async createCode(input) {
      await prisma.$transaction(async (tx) => {
        // Same lock order as a /start consuming one of these codes: the account first.
        await lockAccount(tx, input.userId);
        await tx.telegramLinkCode.deleteMany({ where: { consumedAt: null, userId: input.userId } }).catch(retainDatabaseFailure);
        await tx.telegramLinkCode.create({
          data: {
            authSessionId: input.authSessionId,
            botId: BigInt(input.botId),
            codeHash: input.codeHash,
            createdAt: input.now,
            expiresAt: input.expiresAt,
            userId: input.userId
          }
        }).catch(retainDatabaseFailure);
      }).catch(retainDatabaseFailure);
    },

    async consumeCodeAndLink(input) {
      const { target } = input;
      try {
        return await prisma.$transaction(async (tx): Promise<TelegramLinkOutcome> => {
          const invalid = { code: "telegram_link_code_invalid", kind: "refused" } as const;
          const code = await tx.telegramLinkCode.findUnique({
            select: { authSessionId: true, botId: true, userId: true }, where: { codeHash: input.codeHash }
          }).catch(retainDatabaseFailure);
          if (!code) return invalid;
          // The lock order of the account-security writers: the account, then its session, then
          // its codes and link. Taking the code's row first would deadlock with a revocation that
          // holds the session and waits to delete the code.
          await lockAccount(tx, code.userId);
          const [session] = await tx.$queryRaw<SessionRow[]>(Prisma.sql`
            SELECT "expiresAt", "revokedAt" FROM "AuthSession"
            WHERE "id" = ${code.authSessionId} AND "userId" = ${code.userId}
            FOR SHARE`).catch(retainDatabaseFailure);
          const consumed = await tx.telegramLinkCode.updateMany({
            data: { consumedAt: input.now },
            where: { codeHash: input.codeHash, consumedAt: null, expiresAt: { gt: input.now } }
          }).catch(retainDatabaseFailure);
          if (consumed.count !== 1 || Number(code.botId) !== target.botId) return invalid;
          if (!session || session.revokedAt !== null || session.expiresAt <= input.now) return invalid;

          const user = await tx.user.findUnique({
            select: {
              displayName: true,
              groups: { select: { groupId: true }, where: { group: { archivedAt: null } } },
              scimDeactivatedAt: true,
              status: true
            },
            where: { id: code.userId }
          }).catch(retainDatabaseFailure);
          const eligible = user !== null && input.control.enabled && input.control.bot?.id === target.botId && eligibleForTelegram(input.control, {
            activeGroupIds: user.groups.map((group) => group.groupId), scimDeactivatedAt: user.scimDeactivatedAt, status: user.status
          });
          if (!user || !eligible) return { code: "telegram_access_off", kind: "refused" };

          const holder = await tx.telegramLink.findUnique({
            where: { botId_telegramUserId: { botId: BigInt(target.botId), telegramUserId: BigInt(target.telegramUserId) } }
          }).catch(retainDatabaseFailure);
          if (holder && holder.userId !== code.userId) return { code: "telegram_account_in_use", kind: "refused" };

          const identity = {
            displayName: target.displayName,
            lastSeenAt: input.now,
            telegramChatId: BigInt(target.telegramChatId),
            telegramUsername: target.telegramUsername
          };
          if (holder) {
            // The same Telegram account again: the link, its chat and settings stay.
            const refreshed = await tx.telegramLink.update({ data: identity, where: { id: holder.id } }).catch(retainDatabaseFailure);
            return { accountName: user.displayName, kind: "linked", link: telegramLinkRecord(refreshed), replaced: null };
          }
          const previous = await tx.telegramLink.findUnique({
            select: { botId: true, id: true, telegramChatId: true }, where: { userId: code.userId }
          }).catch(retainDatabaseFailure);
          if (previous) await tx.telegramLink.delete({ where: { id: previous.id } }).catch(retainDatabaseFailure);
          const created = await tx.telegramLink.create({
            data: {
              ...identity,
              botId: BigInt(target.botId),
              linkedAt: input.now,
              telegramUserId: BigInt(target.telegramUserId),
              userId: code.userId
            }
          }).catch(retainDatabaseFailure);
          return {
            accountName: user.displayName,
            kind: "linked",
            link: telegramLinkRecord(created),
            replaced: previous ? { botId: Number(previous.botId), telegramChatId: Number(previous.telegramChatId) } : null
          };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Another transaction linked this Telegram account first and this attempt rolled back,
        // its consumption included: consume the code again so it stays spent like any other refusal.
        await prisma.telegramLinkCode.updateMany({
          data: { consumedAt: input.now }, where: { codeHash: input.codeHash, consumedAt: null }
        }).catch(retainDatabaseFailure);
        return { code: "telegram_account_in_use", kind: "refused" };
      }
    },

    unlink(userId) {
      return removeLink(userId, { userId }, "always");
    },

    unlinkLink(input) {
      return removeLink(input.userId, { id: input.linkId, userId: input.userId }, "with_link");
    }
  });
}
