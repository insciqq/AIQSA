import type { PrismaClient } from "@prisma/client";
import type { AccountProfileRepository, PasswordChangeRepository } from "./accountHandlers";
import { lockAuthIdentity } from "./transactionLocks";

type AccountPrismaClient = Pick<PrismaClient, "$transaction" | "authIdentity" | "authSession" | "user">;

const profileSelect = {
  authIdentities: {
    select: { id: true },
    where: { provider: "password" as const }
  },
  displayName: true,
  email: true,
  role: true,
  status: true
};

type ProfileRow = {
  authIdentities: { id: string }[];
  displayName: string;
  email: string | null;
  role: string;
  status: string;
};

function serializeProfile(user: ProfileRow | null) {
  if (!user || user.status !== "active") return null;
  return {
    displayName: user.displayName,
    email: user.email,
    hasPassword: user.authIdentities.length > 0,
    role: user.role
  };
}

export function createPrismaAccountProfileRepository(
  prisma: AccountPrismaClient
): AccountProfileRepository {
  return {
    async updateDisplayName(userId, displayName) {
      const updated = await prisma.user.updateMany({
        data: { displayName },
        where: { id: userId, status: "active" }
      });
      if (updated.count !== 1) return null;
      return serializeProfile(await prisma.user.findUnique({
        select: profileSelect,
        where: { id: userId }
      }));
    }
  };
}

export function createPrismaPasswordChangeRepository(
  prisma: AccountPrismaClient
): PasswordChangeRepository {
  return {
    async findPasswordIdentityByUserId(userId) {
      const identity = await prisma.authIdentity.findFirst({
        select: { id: true, passwordHash: true },
        where: { provider: "password", userId }
      });
      return identity ? { id: identity.id, passwordHash: identity.passwordHash } : null;
    },
    async changePassword(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthIdentity(tx, input.identityId);
        const identity = await tx.authIdentity.findUnique({
          select: { passwordHash: true, provider: true, userId: true },
          where: { id: input.identityId }
        });
        if (
          !identity ||
          identity.provider !== "password" ||
          identity.passwordHash !== input.expectedPasswordHash
        ) {
          return false;
        }
        await tx.authIdentity.update({
          data: { passwordHash: input.passwordHash },
          where: { id: input.identityId }
        });
        await tx.authSession.updateMany({
          data: {
            revokedAt: input.now,
            revokedReason: "password_change"
          },
          where: {
            id: { not: input.keepSessionId },
            revokedAt: null,
            userId: identity.userId
          }
        });
        return true;
      });
    }
  };
}
