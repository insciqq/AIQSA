import type { Prisma } from "@prisma/client";

/**
 * Locks every active administrator row in id order. Writers that may change who is an active
 * admin take it before any user row they change, so the last-active-admin guards stay exact
 * and two such writers never wait on each other's user rows.
 */
export async function lockActiveAdmins(tx: Prisma.TransactionClient): Promise<{ id: string }[]> {
  return tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "User"
    WHERE "role" = 'admin' AND "status" = 'active'
    ORDER BY "id"
    FOR UPDATE
  `;
}

export async function lockAuthIdentity(tx: Prisma.TransactionClient, identityId: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "AuthIdentity"
    WHERE "id" = ${identityId}
    FOR UPDATE
  `;
}

export async function lockAuthFlowToken(tx: Prisma.TransactionClient, tokenId: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "AuthFlowToken"
    WHERE "id" = ${tokenId}
    FOR UPDATE
  `;
}

export async function lockAuthInvite(tx: Prisma.TransactionClient, inviteId: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "AuthInvite"
    WHERE "id" = ${inviteId}
    FOR UPDATE
  `;
}

export async function lockAuthRegistrationEmail(
  tx: Prisma.TransactionClient,
  normalizedEmail: string
): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${normalizedEmail}, 0))::text AS "lock"
  `;
}

export async function lockAuthUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE
  `;
}
