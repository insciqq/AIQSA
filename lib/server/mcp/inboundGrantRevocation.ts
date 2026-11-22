import type { Prisma } from "@prisma/client";

/** Account-security event that ended inbound grants; stored on the revoked token families. */
export type InboundMcpAccountRevocationReason =
  | "admin_revoke_all"
  | "admin_revoke_user"
  | "password_change"
  | "password_reset"
  | "scim_deactivated";

/**
 * Locks families and codes before grants, the order refresh, code exchange and reconsent use, so
 * they wait for this transaction instead of deadlocking with it. The revision bump is the fence: a
 * family or code minted from a pre-revocation snapshot keeps the old revision and never authorizes.
 */
async function revokeInboundMcpGrants(
  tx: Prisma.TransactionClient,
  userId: string | undefined,
  input: Readonly<{ now: Date; reason: InboundMcpAccountRevocationReason }>
): Promise<number> {
  const grant = userId === undefined ? undefined : { userId };
  await tx.inboundMcpOAuthTokenFamily.updateMany({
    data: { revokedAt: input.now, revocationReason: input.reason },
    where: { grant, revokedAt: null }
  });
  await tx.inboundMcpOAuthAuthorizationCode.deleteMany({
    where: { consumedAt: null, grant }
  });
  const revoked = await tx.inboundMcpOAuthGrant.updateMany({
    data: {
      revision: { increment: 1 },
      revokedAt: input.now,
      state: "REVOKED"
    },
    where: { state: "ACTIVE", userId }
  });
  return revoked.count;
}

/**
 * Ends every ACTIVE inbound grant of one account (Hub, Skills and any inert grant of the retired Memory resource)
 * inside the caller's account-security transaction. A later consent reactivates a grant under a new revision.
 * Returns the number of grants revoked.
 */
export function revokeInboundMcpGrantsForUser(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; reason: InboundMcpAccountRevocationReason; userId: string }>
): Promise<number> {
  return revokeInboundMcpGrants(tx, input.userId, input);
}

/** Installation-wide variant for the administrator's revoke-all-sessions action. */
export function revokeAllInboundMcpGrants(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; reason: InboundMcpAccountRevocationReason }>
): Promise<number> {
  return revokeInboundMcpGrants(tx, undefined, input);
}
