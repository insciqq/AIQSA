import type { Prisma } from "@prisma/client";

/**
 * Account-security events end Telegram links inside the caller's transaction,
 * next to the inbound MCP revocation: revoking one user's or every session,
 * revoking account access (disable, reject, two-factor reset, SCIM
 * deactivation), a password change and a password reset. A link could have
 * been made from a stolen session; the user links again from a live one. The
 * link's buttons, message references and run links go with it (cascade);
 * runs and chats stay. Unused link codes end too.
 */

export type TelegramLinkRevocationReason =
  | "admin_revoke_all"
  | "admin_revoke_user"
  | "password_change"
  | "password_reset"
  | "scim_deactivated";

type RevocationInput = Readonly<{ now: Date; reason: TelegramLinkRevocationReason }>;

/** Ends one account's Telegram link and link codes; returns how many links ended. */
export async function revokeTelegramLinksForUser(
  tx: Pick<Prisma.TransactionClient, "telegramLink" | "telegramLinkCode">,
  input: RevocationInput & Readonly<{ userId: string }>
): Promise<number> {
  await tx.telegramLinkCode.deleteMany({ where: { userId: input.userId } });
  const removed = await tx.telegramLink.deleteMany({ where: { userId: input.userId } });
  return removed.count;
}

/** Installation-wide variant for the administrator's revoke-all-sessions action. */
export async function revokeAllTelegramLinks(
  tx: Pick<Prisma.TransactionClient, "telegramLink" | "telegramLinkCode">,
  _input: RevocationInput
): Promise<number> {
  await tx.telegramLinkCode.deleteMany({});
  const removed = await tx.telegramLink.deleteMany({});
  return removed.count;
}
