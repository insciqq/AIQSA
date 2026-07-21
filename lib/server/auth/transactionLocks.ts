import type { Prisma } from "@prisma/client";

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
